#!/usr/bin/env bash
# 签到墙云服务器一键部署脚本（阿里云轻量 · Ubuntu）
#
# 用法：把项目传到服务器后，在仓库根目录执行
#   PUBLIC_URL=http://<公网IP>:8000 bash deploy/setup-server.sh
# PUBLIC_URL 不传则自动探测公网 IP，拼成 http://IP:8000
# 需 root 运行。幂等：重复执行会更新服务并重启。

set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行（sudo bash deploy/setup-server.sh）"; exit 1; }

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVC=checkin
RUN_USER=checkin
PYPI_MIRROR="https://mirrors.aliyun.com/pypi/simple/"

echo "==> 项目目录: $APP_DIR"

# ---- 0. 基础工具 -----------------------------------------------------------
apt-get update -qq
apt-get install -y -qq curl ca-certificates git >/dev/null

# ---- 1. 确保 Python ≥ 3.11（Ubuntu 24.04 自带 3.12；22.04 走 deadsnakes）---
PY=python3
ver="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
need_install=0
case "$ver" in
  3.11|3.12|3.13) ;;
  *) need_install=1 ;;
esac
if [ "$need_install" = 1 ]; then
  echo "==> 系统 Python($ver) 过旧，安装 Python 3.12（deadsnakes）"
  apt-get install -y -qq software-properties-common >/dev/null
  add-apt-repository -y ppa:deadsnakes/ppa >/dev/null
  apt-get update -qq
  apt-get install -y -qq python3.12 python3.12-venv >/dev/null
  PY=python3.12
else
  apt-get install -y -qq "python${ver}-venv" >/dev/null 2>&1 || apt-get install -y -qq python3-venv >/dev/null
fi
echo "==> 使用 $PY $($PY --version)"

# ---- 2. 对外地址 -------------------------------------------------------------
# 显式传 PUBLIC_URL 时写进 systemd；不传则不写，二维码地址由应用按访问 Host
# 自动推断 —— 镜像复制到任何服务器/任何 IP 都零配置（推荐镜像化部署时不传）。
ENV_LINE=""
DISPLAY_URL="${PUBLIC_URL:-}"
if [ -n "${PUBLIC_URL:-}" ]; then
  ENV_LINE="Environment=CHECKIN_PUBLIC_URL=${PUBLIC_URL}"
else
  IP="$(curl -s --max-time 3 http://100.100.100.200/latest/meta-data/eipv4 || true)"
  [ -n "$IP" ] || IP="$(curl -s --max-time 3 ifconfig.me || true)"
  DISPLAY_URL="http://${IP:-<公网IP>}:8000（未写死，二维码自动跟随访问地址）"
fi
echo "==> 对外地址: $DISPLAY_URL"

# ---- 3. 虚拟环境与依赖 ------------------------------------------------------
cd "$APP_DIR"
[ -d .venv ] || "$PY" -m venv .venv
./.venv/bin/pip install -q --upgrade pip -i "$PYPI_MIRROR"
echo "==> 安装依赖（阿里云 PyPI 镜像）"
./.venv/bin/pip install -q -r server/requirements.txt -i "$PYPI_MIRROR"

# ---- 4. 运行用户与权限 ------------------------------------------------------
id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"

# ---- 5. systemd 服务 --------------------------------------------------------
cat > "/etc/systemd/system/${SVC}.service" <<EOF
[Unit]
Description=签到墙服务 (check_in)
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
${ENV_LINE}
ExecStart=${APP_DIR}/.venv/bin/python ${APP_DIR}/server/app.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SVC"

# ---- 6. 健康检查 -------------------------------------------------------------
sleep 2
if curl -fsS http://127.0.0.1:8000/api/health >/dev/null; then
  echo "==> 服务已启动，本机健康检查通过"
else
  echo "!! 本机健康检查失败，看日志：journalctl -u ${SVC} -n 50"
  exit 1
fi

cat <<'NOTES'

==============================================================
 部署完成
  大屏页   /screen/    手机页   /phone/（均挂在对外地址下）
  服务日志 journalctl -u checkin -f
  管理口令 cat /srv/check_in/server/data/admin_token.txt

 换服务器/换 IP 无需改任何配置：二维码地址自动跟随访问地址。
 （仅当显式传 PUBLIC_URL 时才写死。）

 还差一步（人工）：阿里云控制台 → 防火墙/安全组放行 TCP 8000，
 然后用手机流量（不连校园网）打开 http://<公网IP>:8000/api/health
 验证外网可达。
==============================================================
NOTES
