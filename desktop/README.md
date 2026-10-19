# 桌面客户端（Electron 壳）

把本仓库包成一个 macOS / Windows 桌面应用：**环境安装向导 + 服务守护 + 托盘常驻 + 内嵌看板窗口**。
主工程业务代码零改动（仅 `scripts/api/scheduleStore.js` 加了一个桌面守卫），壳工程完全独立于 `desktop/`。

## 架构

```
Electron 主进程 (desktop/src/main.js)
 ├─ 安装向导窗口 (desktop/wizard/)     首启: 同步文件→npm install→构建→下载 Chromium→生成 .env/config.json
 ├─ 服务守护 (desktop/src/orchestrator.js, 纯 Node 可独立测试)
 │    ├─ 控制 API     scripts/api/server.js      :3010(自动避让)
 │    ├─ 积分看板     dashboard/server.js        :8300(自动避让)
 │    └─ 桌面调度器   desktop/src/scheduler.js   轮询 /schedule, 命中 cron 自动 POST /start
 ├─ 看板窗口                            加载 http://127.0.0.1:<dashPort>/
 └─ 托盘            显示面板 / 打开数据目录 / 开机自启 / 环境修复 / 退出
```

- 服务崩溃自动重启（5s 退避，最多 5 次），日志落盘 `userData/logs/desktop-*.log`（保留 7 天）
- 退出时先 `POST /shutdown` 优雅结束运行中的账号任务，再进程树兜底强杀
- API token 每次启动随机生成，仅注入本机子进程；API/看板只绑 `127.0.0.1`

## 开发模式（直接用仓库当工作区）

```bash
cd desktop
npm install
npm start
```

- 工作区 = 仓库根目录，复用仓库的 `node_modules` / `dist` / `.env` / `sessions/`
- 缺什么向导会自动补（右键「开始安装」= 强制重装）
- 需要 Node ≥ 24：优先自动发现 nvm 已装版本；或用环境变量指定
  `MRS_DESKTOP_NODE=~/.nvm/versions/node/v24.22.0/bin/node npm start`
- 无头冒烟（CI/自检，不弹窗）：`MRS_DESKTOP_SMOKE=1 npx electron .`（exit 0 = 全流程通过）
- 纯 Node 层单测（不需要 electron）：`node scripts/smoke-orchestrator.cjs`

## 打包发行（.exe / .dmg）

```bash
cd desktop
npm run dist        # 当前平台
npm run dist:win    # NSIS 安装包
npm run dist:mac    # dmg (arm64 + x64)
```

产物在 `desktop/release/`。工作方式：

1. `scripts/prepare-payload.cjs` 把主工程（`src/ scripts/ dashboard/ dist/ …`，不含 node_modules）
   组装到 `desktop/payload/`
2. electron-builder 把壳 + payload 打进安装包
3. 用户首启时，向导把 payload 同步到 **userData/app**（版本变化时增量同步，保留 `.env`、
   `sessions/`、`config/`、`logs/` 等用户数据），再自动完成依赖安装/构建/Chromium 下载

### 内置 Node 24（可选，推荐）

安装版首启需要 Node ≥ 24，默认用系统 PATH / nvm 里的。要完全离线免安装 Node，把官方 Node 24
二进制放进壳的 sidecar 槽位后再打包：

- Windows: `desktop/runtime/node.exe`
- macOS/Linux: `desktop/runtime/bin/node`

`prepare-payload` 会自动带上（payload-runtime），运行时优先使用。

### 注意

- `node_modules` 平台相关（impit 等含原生绑定），**win/mac 需各自机器上打包**，装包后的首启
  `npm install` 需要网络；国内建议先配好 npm 镜像
- macOS 未签名包首次打开需右键 → 打开绕过 Gatekeeper；对外分发配置 `CSC_LINK` 签名
- 看板的「🔑 人工登录」按钮依赖 Xvfb/noVNC（容器专用），桌面版不可用；桌面版做人工登录直接在
  数据目录 `config.json` 临时设 `headless: false` 后运行，或 `npm run manual-login`
- 看板的调度编辑会写 `config/schedule.json`，由桌面调度器执行（已设 `MRS_CRONTAB_DISABLE=true`，
  不会像容器那样写系统 crontab）
