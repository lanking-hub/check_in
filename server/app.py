"""
校园智慧参观与互动签到墙 · 后端服务

单进程同时提供四件事：
  1. 静态托管：大屏页 /screen/、手机页 /phone/、公共资源 /shared/
  2. 签到接口：POST /api/signin、GET /api/state
  3. 实时广播：WebSocket /ws（新签到 1 秒内推到大屏）
  4. 数据存储：SQLite（签到记录）+ 本地目录（签名图片）

启动（务必单 worker，广播连接表在进程内存里）：
    ./.venv/bin/python server/app.py
    # 或
    ./.venv/bin/uvicorn server.app:app --host 0.0.0.0 --port 8000 --workers 1

环境变量：
    CHECKIN_PORT        监听端口，默认 8000
    CHECKIN_DATA        数据目录，默认 server/data
    CHECKIN_ADMIN       管理口令；不设则首次启动自动生成并写入 <数据目录>/admin_token.txt
    CHECKIN_PUBLIC_URL  对外访问地址（写进二维码），默认用请求的 Host 推断
"""

from __future__ import annotations

import asyncio
import base64
import csv
import io
import os
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Dict, List, Optional
from urllib.parse import quote

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image

# ---------------------------------------------------------------- 路径与配置

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DATA = Path(os.environ.get("CHECKIN_DATA") or (ROOT / "server" / "data"))
MEDIA = DATA / "sig"
DB_PATH = DATA / "checkin.db"
PORT = int(os.environ.get("CHECKIN_PORT") or 8000)

MAX_NAME = 12          # 昵称最长字符数
MAX_SIG_BYTES = 1_200_000   # 单张签名图解码后上限，约 1.2MB
RATE_LIMIT = 12        # 同一 IP 每 60 秒最多提交次数
HEARTBEAT_S = 20       # 服务端心跳间隔，客户端超时用它判断断线

for p in (DATA, MEDIA):
    p.mkdir(parents=True, exist_ok=True)


def _load_admin_token() -> str:
    """管理口令：优先环境变量，否则读文件，没有就生成一个并落盘。"""
    env = (os.environ.get("CHECKIN_ADMIN") or "").strip()
    if env:
        return env
    f = DATA / "admin_token.txt"
    if f.exists():
        return f.read_text(encoding="utf-8").strip()
    token = secrets.token_urlsafe(9)
    f.write_text(token, encoding="utf-8")
    return token


ADMIN_TOKEN = _load_admin_token()

# ---------------------------------------------------------------- 数据存储


class Store:
    """SQLite 存储。写入量极小（一天几百条），用一把锁保证并发安全。"""

    def __init__(self, path: Path):
        self.lock = threading.Lock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        with self.lock:
            self.conn.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS signins (
                  id     TEXT PRIMARY KEY,
                  name   TEXT NOT NULL,
                  unit   TEXT NOT NULL DEFAULT '',
                  kind   TEXT NOT NULL DEFAULT '',
                  grp    TEXT NOT NULL DEFAULT '',
                  route  TEXT NOT NULL DEFAULT '',
                  sig    TEXT NOT NULL DEFAULT '',
                  client TEXT NOT NULL DEFAULT '',
                  ip     TEXT NOT NULL DEFAULT '',
                  ts     INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_ts ON signins(ts);
                CREATE INDEX IF NOT EXISTS idx_client ON signins(client);
                """
            )
            self.conn.commit()

    @staticmethod
    def _row(r: sqlite3.Row) -> Dict:
        return {
            "id": r["id"],
            "name": r["name"],
            "unit": r["unit"],
            "type": r["kind"],
            "group": r["grp"],
            "route": r["route"],
            "sig": f"/media/sig/{r['sig']}" if r["sig"] else "",
            "sigFile": r["sig"],
            "ts": r["ts"],
        }

    def add(self, **kw) -> Dict:
        rec = {
            "id": secrets.token_hex(8),
            "name": kw["name"],
            "unit": kw.get("unit", ""),
            "kind": kw.get("type", ""),
            "grp": kw.get("group", ""),
            "route": kw.get("route", ""),
            "sig": kw.get("sig", ""),
            "client": kw.get("client", ""),
            "ip": kw.get("ip", ""),
            "ts": int(time.time() * 1000),
        }
        with self.lock:
            self.conn.execute(
                "INSERT INTO signins (id,name,unit,kind,grp,route,sig,client,ip,ts)"
                " VALUES (:id,:name,:unit,:kind,:grp,:route,:sig,:client,:ip,:ts)",
                rec,
            )
            self.conn.commit()
        return self._row(self.conn.execute("SELECT * FROM signins WHERE id=?", (rec["id"],)).fetchone())

    def update(self, sid: str, **kw) -> Optional[Dict]:
        with self.lock:
            self.conn.execute(
                "UPDATE signins SET name=:name, unit=:unit, kind=:kind, grp=:grp,"
                " route=:route, sig=:sig WHERE id=:id",
                {
                    "id": sid,
                    "name": kw["name"],
                    "unit": kw.get("unit", ""),
                    "kind": kw.get("type", ""),
                    "grp": kw.get("group", ""),
                    "route": kw.get("route", ""),
                    "sig": kw.get("sig", ""),
                },
            )
            self.conn.commit()
            r = self.conn.execute("SELECT * FROM signins WHERE id=?", (sid,)).fetchone()
        return self._row(r) if r else None

    def by_client(self, client: str) -> Optional[Dict]:
        if not client:
            return None
        with self.lock:
            r = self.conn.execute(
                "SELECT * FROM signins WHERE client=? ORDER BY ts DESC LIMIT 1", (client,)
            ).fetchone()
        return self._row(r) if r else None

    def by_id(self, sid: str) -> Optional[Dict]:
        with self.lock:
            r = self.conn.execute("SELECT * FROM signins WHERE id=?", (sid,)).fetchone()
        return self._row(r) if r else None

    def list(self, since: int = 0, limit: int = 500) -> List[Dict]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT * FROM signins WHERE ts>? ORDER BY ts ASC LIMIT ?", (since, limit)
            ).fetchall()
        return [self._row(r) for r in rows]

    def count(self) -> int:
        with self.lock:
            return self.conn.execute("SELECT COUNT(*) FROM signins").fetchone()[0]

    def delete(self, sid: str) -> bool:
        with self.lock:
            cur = self.conn.execute("DELETE FROM signins WHERE id=?", (sid,))
            self.conn.commit()
        return cur.rowcount > 0

    def clear(self) -> int:
        with self.lock:
            n = self.conn.execute("SELECT COUNT(*) FROM signins").fetchone()[0]
            self.conn.execute("DELETE FROM signins")
            self.conn.commit()
        return n


store = Store(DB_PATH)

# ---------------------------------------------------------------- 实时广播


class Hub:
    """WebSocket 连接表。所有连接在同一个事件循环里，广播就是遍历它们。"""

    def __init__(self) -> None:
        self.clients: Dict[WebSocket, str] = {}
        self.lock = asyncio.Lock()

    async def add(self, ws: WebSocket, role: str) -> None:
        async with self.lock:
            self.clients[ws] = role

    async def remove(self, ws: WebSocket) -> None:
        async with self.lock:
            self.clients.pop(ws, None)

    def counts(self) -> Dict[str, int]:
        screen = sum(1 for r in self.clients.values() if r == "screen")
        phone = sum(1 for r in self.clients.values() if r == "phone")
        return {"screen": screen, "phone": phone, "total": len(self.clients)}

    async def send(self, ws: WebSocket, msg: dict) -> bool:
        try:
            await ws.send_json(msg)
            return True
        except Exception:
            await self.remove(ws)
            return False

    async def broadcast(self, msg: dict) -> int:
        sent = 0
        for ws in list(self.clients.keys()):
            if await self.send(ws, msg):
                sent += 1
        return sent

    async def presence(self) -> None:
        await self.broadcast({"type": "presence", "conns": self.counts(), "count": store.count()})


hub = Hub()

# ---------------------------------------------------------------- 工具函数

_rate: Dict[str, List[float]] = {}
_rate_lock = threading.Lock()


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""


def check_rate(ip: str) -> None:
    """同一 IP 每分钟最多 RATE_LIMIT 次提交，防连点与扫库。"""
    now = time.time()
    with _rate_lock:
        hits = [t for t in _rate.get(ip, []) if now - t < 60]
        if len(hits) >= RATE_LIMIT:
            raise HTTPException(status_code=429, detail="提交过于频繁，请稍后再试")
        hits.append(now)
        _rate[ip] = hits


def clean(s, limit: int = 40) -> str:
    """去掉控制字符、首尾空白，并按长度截断。"""
    if s is None:
        return ""
    t = re.sub(r"[\x00-\x1f\x7f]", "", str(s)).strip()
    return t[:limit]


def save_signature(data_url: str) -> str:
    """把签名 dataURL 存成 PNG：裁掉空白、缩到合适宽度。返回文件名。"""
    m = re.match(r"^data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$", data_url or "")
    if not m:
        return ""
    try:
        raw = base64.b64decode(m.group(2))
    except Exception:
        return ""
    if len(raw) > MAX_SIG_BYTES:
        raise HTTPException(status_code=413, detail="签名图片过大")
    try:
        im = Image.open(io.BytesIO(raw)).convert("RGBA")
    except Exception:
        return ""

    # 透明底：按 alpha 裁边；白底图片：按非白色裁边
    alpha = im.getchannel("A")
    box = alpha.getbbox() if alpha.getextrema()[0] < 250 else None
    if not box:
        gray = im.convert("L")
        box = gray.point(lambda v: 255 if v < 240 else 0).getbbox()
    if box:
        pad = 6
        box = (
            max(0, box[0] - pad),
            max(0, box[1] - pad),
            min(im.width, box[2] + pad),
            min(im.height, box[3] + pad),
        )
        im = im.crop(box)

    if im.width > 560:
        im = im.resize((560, max(1, round(im.height * 560 / im.width))), Image.LANCZOS)

    name = f"{int(time.time() * 1000)}-{secrets.token_hex(4)}.png"
    im.save(MEDIA / name, "PNG", optimize=True)
    return name


def need_admin(token: Optional[str], q: Optional[str] = None) -> None:
    got = token or q or ""
    if not secrets.compare_digest(got, ADMIN_TOKEN):
        raise HTTPException(status_code=401, detail="口令错误")


# ---------------------------------------------------------------- 应用

async def _heartbeat() -> None:
    """定期广播心跳：既保活链路，也让大屏知道当前人数与连接数。"""
    while True:
        await asyncio.sleep(HEARTBEAT_S)
        await hub.broadcast({"type": "tick", "count": store.count(), "conns": hub.counts()})


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(_heartbeat())
    print("=" * 62)
    print("  签到墙服务已启动")
    print(f"  大屏页  http://<服务器IP>:{PORT}/screen/")
    print(f"  手机页  http://<服务器IP>:{PORT}/phone/")
    print(f"  管理口令 {ADMIN_TOKEN}   （清空/导出时需要）")
    print(f"  数据目录 {DATA}")
    print("=" * 62)
    yield
    task.cancel()


app = FastAPI(title="签到墙服务", docs_url=None, redoc_url=None, lifespan=lifespan)


@app.get("/")
async def index():
    return RedirectResponse("/screen/")


@app.get("/api/health")
async def health():
    return {"ok": True, "count": store.count(), "conns": hub.counts(), "ts": int(time.time() * 1000)}


@app.get("/api/state")
async def state(since: int = 0, limit: int = 500):
    """大屏刷新或断线重连后拉全量；带 since 则只取增量。"""
    return {
        "count": store.count(),
        "items": store.list(since=since, limit=limit),
        "serverTime": int(time.time() * 1000),
    }


@app.post("/api/signin")
async def signin(payload: dict, request: Request):
    """
    提交签到。body:
      { name, unit?, type?, group?, route?, sig?, client? }
    client 是手机本地生成的随机串，用来识别“同一个人再改一次”，避免重复计数。
    """
    ip = client_ip(request)
    check_rate(ip)

    name = clean(payload.get("name"), MAX_NAME)
    if not name:
        raise HTTPException(status_code=400, detail="请填写昵称")

    sig_file = save_signature(payload.get("sig") or "")
    data = {
        "name": name,
        "unit": clean(payload.get("unit"), 30),
        "type": clean(payload.get("type"), 20),
        "group": clean(payload.get("group"), 20),
        "route": clean(payload.get("route"), 30),
        "sig": sig_file,
    }
    client = clean(payload.get("client"), 64)

    exist = store.by_client(client) if client else None
    if exist:
        # 同一设备重复提交 = 修改自己的记录：保留原 id 与时间，不重复上墙
        rec = store.update(exist["id"], **data) or exist
        await hub.broadcast({"type": "update", "data": rec})
        return {"ok": True, "updated": True, "item": rec}

    rec = store.add(client=client, ip=ip, **data)
    await hub.broadcast({"type": "signin", "data": rec, "count": store.count()})
    return {"ok": True, "updated": False, "item": rec}


@app.delete("/api/signin/{sid}")
async def delete_one(sid: str, x_admin_token: Optional[str] = Header(default=None)):
    """删除单条（隐私“随时删除”要求）。"""
    need_admin(x_admin_token)
    rec = store.by_id(sid)
    if not rec:
        raise HTTPException(status_code=404, detail="记录不存在")
    store.delete(sid)
    if rec["sigFile"]:
        (MEDIA / rec["sigFile"]).unlink(missing_ok=True)
    await hub.broadcast({"type": "remove", "id": sid, "count": store.count()})
    return {"ok": True}


@app.post("/api/admin/clear")
async def clear_all(x_admin_token: Optional[str] = Header(default=None)):
    """一键清空（演示前重置）。"""
    need_admin(x_admin_token)
    n = store.clear()
    for f in MEDIA.glob("*.png"):
        f.unlink(missing_ok=True)
    await hub.broadcast({"type": "clear", "count": 0})
    return {"ok": True, "removed": n}


@app.get("/api/admin/export")
async def export_csv(x_admin_token: Optional[str] = Header(default=None), token: Optional[str] = None):
    """导出 CSV，带 BOM 以便 Excel 直接打开中文。"""
    need_admin(x_admin_token, token)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["签到时间", "昵称", "单位", "访客类型", "分组", "参观路线", "签名图"])
    for r in store.list(limit=100000):
        ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r["ts"] / 1000))
        w.writerow([ts, r["name"], r["unit"], r["type"], r["group"], r["route"], r["sig"]])
    body = ("\ufeff" + buf.getvalue()).encode("utf-8")
    # 响应头只能是 latin-1，中文文件名要按 RFC 5987 用 filename* 传
    fname = "签到记录-" + time.strftime("%Y%m%d-%H%M") + ".csv"
    disp = "attachment; filename=\"signins.csv\"; filename*=UTF-8''" + quote(fname)
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": disp},
    )


@app.get("/api/config")
async def public_config(request: Request):
    """给大屏页用的公开配置：二维码该指向哪里。"""
    base = (os.environ.get("CHECKIN_PUBLIC_URL") or "").strip()
    if not base:
        base = str(request.base_url).rstrip("/")
    return {"phoneUrl": base + "/phone/", "serverTime": int(time.time() * 1000)}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, role: str = Query(default="screen")):
    role = "phone" if role == "phone" else "screen"
    await ws.accept()
    await hub.add(ws, role)
    await hub.send(
        ws, {"type": "hello", "role": role, "count": store.count(), "conns": hub.counts()}
    )
    await hub.presence()
    try:
        while True:
            msg = await ws.receive_text()
            # 客户端每 20 秒发一次 ping，服务端回 pong；不回就说明链路死了
            if msg == "ping":
                await hub.send(ws, {"type": "pong", "ts": int(time.time() * 1000)})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await hub.remove(ws)
        await hub.presence()


# ---------------------------------------------------------------- 静态托管

app.mount("/media/sig", StaticFiles(directory=MEDIA), name="media-sig")
for _path, _dir in (
    ("/screen", WEB / "screen"),
    ("/phone", WEB / "phone"),
    ("/shared", WEB / "shared"),
    ("/design", ROOT / "design"),  # 仅供调试叠图使用
):
    if _dir.exists():
        app.mount(_path, StaticFiles(directory=_dir, html=True), name=_path.strip("/"))


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
