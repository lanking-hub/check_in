# check_in

校园智慧参观与互动签到墙 · 汇聚星光 · 点亮乐学。

访客扫码填写称呼并手写签名，大屏实时把名字化作金沙落进「乐学」二字并泛起金光，手机端同时生成一张可保存的入校通行证。

## 功能

- **大屏**：按 1280×722 原型复刻，二维码、实时签到人数、Canvas 金沙特效（多人错峰、金光脉冲）、断线重连与补齐、屏幕常亮
- **手机**：昵称必填，单位 / 类型 / 分组 / 路线选填；Canvas 手写签名可清空、可跳过；提交后生成 750×1180 通行证 PNG，支持微信内长按保存
- **服务端**：FastAPI 单进程同时托管静态页、HTTP API、WebSocket 广播与 SQLite 存储；签名图落盘；口令保护的删除 / 清空 / CSV 导出
- **核验页**：身份牌二维码指向 `/card/{id}`，只展示基本信息与签到时间，不含签名原图

## 技术栈

原生 HTML / CSS / JavaScript，无构建、无 npm 依赖 · Python 3.11+ / FastAPI / Uvicorn / Pillow · SQLite · WebSocket

## 快速开始

```bash
python3 -m venv .venv
./.venv/bin/pip install -r server/requirements.txt
./.venv/bin/python server/app.py
```

| 页面 | 地址 |
|---|---|
| 大屏 | <http://127.0.0.1:8000/screen/> |
| 手机 | <http://127.0.0.1:8000/phone/> |
| 健康检查 | <http://127.0.0.1:8000/api/health> |

管理口令首次启动自动生成在 `server/data/admin_token.txt`。

**只看大屏**：双击 `web/screen/index.html` 进入离线演示模式，按 `S` 模拟 1 人、`M` 模拟 3 人，或加 `?demo=1` 自动循环。此模式不连后端。手机页 `?demo=1` 可快速预览通行证，但必须走服务地址。

**必须单 worker 运行**：WebSocket 连接表在进程内存里，多进程会各收一份。

## 目录

```
web/screen/     大屏端：页面、样式、实时逻辑、金沙特效、图片与字体
web/phone/      手机端：表单、手写签名、身份牌生成
web/shared/     二维码库 qrcode-generator 1.4.4
server/app.py   后端：静态托管 + API + WebSocket + SQLite
server/requirements.txt
docs/           需求范围 v1、部署手册
deploy/         setup-server.sh 一键部署
design/         大屏原型图
```

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `CHECKIN_PORT` | `8000` | 监听端口 |
| `CHECKIN_DATA` | `server/data` | 数据库、签名图、管理口令 |
| `CHECKIN_ADMIN` | 自动生成 | 管理口令 |
| `CHECKIN_PUBLIC_URL` | 按访问 Host 自动推断 | 二维码地址；默认无需设置，仅在反向代理改写 Host 时指定 |

其他限制：昵称最长 12 字、签名图上限约 1.2 MB、同一 IP 每 60 秒最多 12 次提交、同一设备 5 秒内重复提交按手滑处理。同名再提交视为改签名，人数不变；换称呼视为新人。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state?since=&limit=` | 全量 / 增量签到记录 |
| POST | `/api/signin` | 提交 `{name, unit?, type?, group?, route?, sig?, client?}` |
| GET | `/api/config` | 返回二维码地址 `phoneUrl` |
| DELETE | `/api/signin/{id}` | 删除单条，需 `X-Admin-Token` |
| POST | `/api/admin/clear` | 清空，需口令 |
| GET | `/api/admin/export` | 导出 CSV，需口令 |
| GET | `/card/{id}` | 身份牌核验页 |
| WS | `/ws?role=screen` | 推送 `hello / presence / signin / update / remove / clear / tick` |

调试参数：`?live=0` 离线、`?count=` 初始人数、`?qr=` 覆盖二维码、`?demo=1` 自动演示、`?debug=1` 叠原型对比、`?fxsim=&n=` 推演关键帧。

## 部署

正式部署见 `docs/部署手册.md`，一键脚本：

```bash
sudo bash deploy/setup-server.sh
```

要点：IP + 端口直连 `http://<公网IP>:8000`、不加 nginx、单 worker、控制台放行 TCP 8000、二维码地址自动跟随访问地址。大屏用 Edge `--kiosk` 全屏，电源设置「从不」休眠；浏览器屏幕常亮仅在 HTTPS / localhost 生效。

## 开发状态

老师通知项目开发暂时停止，代码维持现状，等待甲方最终原型。

已完成：大屏视觉与特效、手机表单 / 签名 / 通行证、后端与实时联调、一键部署脚本与部署手册。本机验证：100 条连续提交平均约 3 ms，106 人落沙 + 5 人同时动画约 60 fps。

待确认：甲方最终原型与身份牌模板、正式校徽与场景照片、服务器与演示机条件、隐私话术与访客删除入口、三项实时统计的口径。

已知限制：签到人数为累计值，不会每日清零；未适配 9:16 竖屏；身份牌视觉为占位版本；部署脚本尚未在真实服务器验证。

## 费用

开发费用：无。

## 致谢

MaShanZheng / Noto Serif SC / LongCang 字体（SIL OFL 1.1）、qrcode-generator（MIT）、甲方提供的大屏原型图。
