# check_in

校园智慧参观与互动签到墙。

访客扫码在手机上写名字与签名 → 大屏实时把名字化作金沙落进「乐学」两个字里。

## 技术栈

- 前端：原生 HTML / CSS / JavaScript，无构建步骤，直接静态托管
- 后端：Python 3.11+ / FastAPI + Uvicorn，单进程同时负责静态托管、签到接口、WebSocket 广播
- 存储：SQLite（一个文件）+ 本地目录存签名图片，无需额外安装数据库

## 目录

```
web/screen/     大屏端：1280×722 设计稿等比缩放，Canvas 金沙特效
web/phone/      手机端：填昵称 + 手写签名
web/shared/     两端公用资源（二维码库）
server/app.py   后端服务（接口 + 实时通道 + 存储 + 静态托管）
docs/           需求范围与方案
design/         原型图
```

## 本地运行

```bash
python3 -m venv .venv
./.venv/bin/pip install -r server/requirements.txt
./.venv/bin/python server/app.py     # 默认 http://127.0.0.1:8000
```

打开 <http://127.0.0.1:8000/screen/> 是大屏页，<http://127.0.0.1:8000/phone/> 是手机页。
启动日志里会打印管理口令，清空与导出需要它。

> 必须单 worker 运行（`--workers 1`）：WebSocket 连接表保存在进程内存里，多进程会各收一份。

## 大屏调试参数

| 参数 | 作用 |
|---|---|
| `?live=0` | 不连后端，纯本地演示（双击打开 html 文件时自动如此） |
| `?count=128` | 指定初始人数（仅 `live=0` 时生效） |
| `?qr=链接` | 覆盖二维码指向的地址 |
| `?demo=1` | 自动循环模拟签到 |
| `?debug=1` | 按 O 把原型半透明叠在页面上，按 D 高亮差异 |

页面打开后：按 `S` 或空格模拟 1 人签到，按 `M` 模拟 3 人同时签到。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/signin` | 提交签到：`{name, unit?, type?, group?, route?, sig?, client?}` |
| GET | `/api/state` | 拉全量或增量：`?since=毫秒时间戳` |
| DELETE | `/api/signin/{id}` | 删除单条（需管理口令） |
| POST | `/api/admin/clear` | 一键清空（需管理口令） |
| GET | `/api/admin/export` | 导出 CSV（需管理口令） |
| GET | `/api/health` | 健康检查 |
| WS | `/ws?role=screen` | 实时订阅，推送 `signin` / `update` / `remove` / `clear` / `tick` |

`client` 是手机本地生成的随机串。同一设备再次提交会更新自己那条记录，不会重复上墙。

## 部署要点

- 大陆服务器未备案时只能用非标端口（如 8000）直接用 IP 访问；页面不调用摄像头，HTTP 即可
- 进程守护：Linux 用 systemd，Windows 用 pm2 或 nssm，并设置开机自启
- 反向代理放在同机时，要允许 WebSocket 升级并放宽读超时，否则长连接会被切断

## 协作

- 仓库为公开仓库，欢迎通过 Issue 讨论需求与缺陷、通过 Pull Request 提交改动。
- 分支约定：`main` 为稳定分支，开发请从 `main` 拉新分支，命名如 `feat/xxx`、`fix/xxx`。
- 提交前请确认本地可运行，并在 PR 描述中说明改动范围与测试方式。
