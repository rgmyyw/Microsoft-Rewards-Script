# Microsoft Rewards Script

[![Validate](https://github.com/TheNetsky/Microsoft-Rewards-Script/actions/workflows/validate.yml/badge.svg?branch=v5)](https://github.com/TheNetsky/Microsoft-Rewards-Script/actions/workflows/validate.yml)
![Version](https://img.shields.io/github/package-json/v/TheNetsky/Microsoft-Rewards-Script/v5)
[![Docker image (GHCR)](https://img.shields.io/badge/Docker-GHCR%20v5-2496ED?logo=docker&logoColor=white)](https://github.com/TheNetsky/Microsoft-Rewards-Script/pkgs/container/microsoft-rewards-script)
![Node.js](https://img.shields.io/badge/node-%3E%3D24-green)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)
[![Donate](https://img.shields.io/badge/Donate-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/thenetsky)

Microsoft Rewards automation with API and browser modes, saved sessions,
multiple accounts, localised searches and an optional Control API.

## Features

- Daily Set, promotions, punchcards and bonus-point claims.
- Desktop/mobile searches, Explore on Bing, Daily Check-In and Read to Earn.
- Optional Visual Search and background Edge browsing.
- Streak progress, API-based streak protection and verified point reporting.
- Scheduled runs, account selection, saved sessions and Discord/Telegram/ntfy notifications.
- Control API with live events, persistent history, punchcard progress and activity balance observations.

Activities depend on the account and region. This branch contains v5; earlier
versions remain available on [v3](https://github.com/TheNetsky/Microsoft-Rewards-Script/tree/v3)
and [v4](https://github.com/TheNetsky/Microsoft-Rewards-Script/tree/v4).

## 国内适配版说明（V4-china）

本仓库 fork 自 [TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script)（v5 基线），在上游之上追加以下能力：

- **内嵌看板**（`dashboard/`，零依赖 Node，`DASHBOARD_ENABLED=true` 时由 entrypoint 拉起，:8300）：运行控制、账号管理（动态增删/凭据熔断 stash）、风控隔离告警、登录体检/全量体检/市场探测/网络诊断、钉钉+邮件推送。
- **中国热搜查询源**：`queryEngines` 支持 `"china"`（gmya.net 热搜 + 限流退避），配合 `searchSettings.chinaApi.appkey`；国内推荐 `["china", "local"]`，无需代理。
- **脚本侧通知**：PushPlus / ClawBot（微信），配置在 `webhook.pushplus` / `webhook.clawbot`。
- **失败补跑**：`failedAccountRetry`（可配次数与冷却）。
- **诊断工具**：`scripts/main/{loginCheck,taskProbe,marketProbe,netDiag}.js`（面板一键调用）。
- **部署适配**：Dockerfile 国内镜像源 + noVNC 手动登录可视化；compose 时区 `Asia/Shanghai`；日志卷挂载（日志文件 90 天保留）。
- **mac 本地运行**：`scripts/mac/`（launchd plist）。

上游文档见下方 [Documentation](#documentation)。

## Documentation

- [Setup and usage](docs/usage.md) — local, Nix and Docker installation, accounts, settings, commands and troubleshooting.
- [Control API](docs/control-api.md) — authentication, endpoints, run control, scheduling and dashboard data.

## Setup

Requires Node.js 24 or newer.

```sh
npm ci
npm run install:browser
npm run build
cp env.example .env
cp config.example.json config.json
```

On Linux, install Chromium's system libraries with
`npx patchright install --with-deps chromium`.
On Windows, copy the example files with File Explorer or PowerShell's `Copy-Item`.

Set `ACCOUNT_1_EMAIL` and the relevant sign-in settings in `.env`, then run:

```sh
npm start
```

Add another numbered account block for each account. Passwords are optional for
passwordless accounts. See [env.example](env.example) for account variables and
[Setup and usage](docs/usage.md#accounts-and-sessions) for login options.

## Modes and settings

Edit [config.json](config.example.json) before starting a run.

| Setting                            | Purpose                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `rewardsMode: "browser"`           | Complete web activities through rendered cards and GhostCursor |
| `rewardsMode: "api"`               | Save the sign-in session, close its browser and use HTTP       |
| `searchSettings.parallelSearching` | Overlap desktop and mobile work when enabled                   |
| `workers`                          | Enable or disable individual tasks                             |
| `taskDelay`                        | Delay between activities                                       |
| `searchSettings.searchDelay`       | Delay between searches                                         |
| `searchSettings.useAccountLocale`  | Select queries using the account country                       |
| `ensureStreakProtection`           | Enable and verify protection over HTTP in both modes           |
| `experimental`                     | Optional features; disabled by default                         |

See the full [settings reference](docs/usage.md#settings-reference) for all options.

## Sessions

To sign in manually on a desktop with a visible browser:

```sh
npm run manual-login -- user@example.com --platform both
npm run open-session -- --help
```

Sessions are saved under `sessionPath`. Keep `.env`, local configuration,
session databases and diagnostics private.

## Docker

Create `.env` from `env.example`, then review the timezone and schedule in
[compose.yaml](compose.yaml).

```sh
docker compose up -d --build
docker compose logs -f
```

The published v5 image is `ghcr.io/thenetsky/microsoft-rewards-script:5`.
To use it instead of building locally, follow the [Docker image instructions](docs/usage.md#docker).

Docker persists configuration in `./config`, sessions in `./sessions` and optional
error captures in `./diagnostics`. It creates `config/config.json` from defaults
when needed. `RUN_ON_START` controls the first run; `CRON_SCHEDULE` sets the initial
schedule. Control API schedule changes persist in `config/schedule.json`.
See [Control API Docker setup](docs/control-api.md#docker) to enable the server.

## License

[GPL-3.0-or-later](LICENSE).
