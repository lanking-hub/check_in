#!/usr/bin/env bash
# 签到墙云服务器一键部署脚本
# 支持：Ubuntu / Debian（apt）、Alibaba Cloud Linux / CentOS / Anolis / Rocky（dnf/yum）
#
# 用法：项目传到服务器后，在仓库根目录执行
#   sudo bash deploy/setup-server.sh
# 可选 PUBLIC_URL=http://IP:8000 显式写死对外地址；默认不写死，二维码自动跟随
# 访问地址，换服务器/换 IP 零配置（镜像化部署推荐保持默认）。
# 需 root 运行。幂等：重复执行会更新服务并重启。

set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行（sudo bash deploy/setup-server.sh）"; exit 1; }

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVC=checkin
RUN_USER=checkin
PYPI_MIRROR="https://mirrors.aliyun.com/pypi/simple/"

echo "==> 项目目录: $APP_DIR"

# ---- 0. 包管理器与基础工具 ---------------------------------------------------
if   command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v dnf     >/dev/null 2>&1; then PKG=dnf
elif command -v yum     >/dev/null 2>&1; then PKG=yum
else echo "!! 未识别的包管理器（需要 apt-get / dnf / yum）"; exit 1
fi
echo "==> 包管理器: $PKG"

pkg_install() {
  case "$PKG" in
    apt) apt-get update -qq && apt-get install -y -qq "$@" >/dev/null ;;
    dnf) dnf install -y -q "$@" >/dev/null ;;
    yum) yum install -y -q "$@" >/dev/null ;;
  esac
}

pkg_install curl ca-certificates git

# ---- 1. 确保 Python ≥ 3.11 ---------------------------------------------------
find_py() {
  local c v
  for c in python3.13 python3.12 python3.11; do
    command -v "$c" >/dev/null 2>&1 && { echo "$c"; return 0; }
  done
  if command -v python3 >/dev/null 2>&1; then
    v="$(python3 -c 'import sys; print("%d.%d" % (sys.version_info.major, sys.version_info.minor))')"
    case "$v" in 3.11|3.12|3.13) echo python3; return 0 ;; esac
  fi
  return 1
}

install_miniforge() {
  echo "==> 系统源没有 Python 3.11+，用 Miniforge 兜底（清华镜像，国内快）"
  curl -fsSL -o /tmp/miniforge3.sh \
    "https://mirrors.tuna.tsinghua.edu.cn/github-release/conda-forge/miniforge/LatestRelease/Miniforge3-Linux-x86_64.sh"
  bash /tmp/miniforge3.sh -b -p /opt/miniforge3 >/dev/null
}

PY="$(find_py || true)"
if [ -z "$PY" ]; then
  echo "==> 未找到 Python ≥ 3.11，尝试从系统源安装"
  case "$PKG" in
    apt)
      pkg_install software-properties-common
      add-apt-repository -y ppa:deadsnakes/ppa >/dev/null
      pkg_install python3.12 python3.12-venv || pkg_install python3.11 python3.11-venv || true
      ;;
    *)
      pkg_install python3.12 || pkg_install python3.11 || true
      ;;
  esac
  PY="$(find_py || true)"
fi
if [ -z "$PY" ]; then
  install_miniforge
  PY=/opt/miniforge3/bin/python
fi
echo "==> Python: $PY ($($PY --version 2>&1))"

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

# ---- 3. 虚拟环境与依赖 --------------------------------------------------------
cd "$APP_DIR"
if ! "$PY" -m venv .venv 2>/dev/null || [ ! -x .venv/bin/python ]; then
  echo "==> 系统 Python 建不了 venv（缺 ensurepip），改用 Miniforge"
  install_miniforge
  PY=/opt/miniforge3/bin/python
  rm -rf .venv
  "$PY" -m venv .venv
fi
echo "==> 安装依赖（阿里云 PyPI 镜像）"
./.venv/bin/pip install -q --upgrade pip -i "$PYPI_MIRROR"
./.venv/bin/pip install -q -r server/requirements.txt -i "$PYPI_MIRROR"

# ---- 4. 运行用户与权限 --------------------------------------------------------
id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"

# ---- 5. 系统防火墙（firewalld 在跑的话顺手放行；阿里云控制台安全组仍需人工）----
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=8000/tcp >/dev/null
  firewall-cmd --reload >/dev/null
  echo "==> 系统防火墙(firewalld)已放行 TCP 8000"
fi

# ---- 6. systemd 服务 ----------------------------------------------------------
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

# ---- 7. 健康检查 ---------------------------------------------------------------
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
