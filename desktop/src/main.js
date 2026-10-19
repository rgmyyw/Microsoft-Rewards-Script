'use strict'
/**
 * 桌面客户端主进程：环境安装向导 + 服务守护 + 看板窗口 + 托盘
 *
 * 两种运行模式：
 *  - 开发模式（npm start / dev）：工作区 = 仓库根目录，直接复用仓库的 node_modules/dist
 *  - 打包模式（electron-builder 产物）：工作区 = userData/app，首启从 resources/payload 同步
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog, Notification } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const orch = require('./orchestrator')

const IS_MAC = process.platform === 'darwin'
const PREFERRED_API_PORT = 3010
const PREFERRED_DASH_PORT = 8300

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

/** @type {BrowserWindow} */
let wizardWindow = null
/** @type {BrowserWindow} */
let panelWindow = null
/** @type {Tray} */
let tray = null
/** @type {import('./orchestrator').ServiceSupervisor} */
let supervisor = null

let quitting = false
let servicesReady = false

const runtime = {
    mode: app.isPackaged ? 'packaged' : 'dev',
    appRoot: null, // 项目工作区（脚本/会话/配置所在）
    payloadDir: null, // 打包模式下的只读负载目录
    resourcesPath: null,
    apiPort: PREFERRED_API_PORT,
    dashPort: PREFERRED_DASH_PORT,
    token: orch.newToken(),
    nodePath: null,
    userDataDir: null,
    logsDir: null,
    settings: { autoLaunch: false }
}

// ---------------------------------------------------------------------------
// 路径与设置
// ---------------------------------------------------------------------------

function loadSettings() {
    const file = path.join(runtime.userDataDir, 'settings.json')
    try {
        Object.assign(runtime.settings, JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch {
        /* 首次无设置 */
    }
}

function saveSettings() {
    const file = path.join(runtime.userDataDir, 'settings.json')
    try {
        fs.writeFileSync(file, JSON.stringify(runtime.settings, null, 2))
    } catch {}
}

function applyAutoLaunch() {
    if (app.isPackaged) {
        app.setLoginItemSettings({ openAtLogin: !!runtime.settings.autoLaunch })
    }
}

// ---------------------------------------------------------------------------
// 日志落盘（按天分文件，保留 7 天）
// ---------------------------------------------------------------------------

let logStream = null
let logStreamDate = ''

function serviceLogFile() {
    const d = new Date()
    const name = `desktop-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`
    return path.join(runtime.logsDir, name)
}

function writeServiceLog(line) {
    try {
        const today = new Date().toDateString()
        if (today !== logStreamDate || !logStream) {
            if (logStream) logStream.end()
            logStreamDate = today
            logStream = fs.createWriteStream(serviceLogFile(), { flags: 'a' })
        }
        logStream.write(`${new Date().toLocaleTimeString()} ${line}`)
    } catch {
        /* 日志失败不影响主流程 */
    }
}

function pruneOldLogs() {
    try {
        const cutoff = Date.now() - 7 * 24 * 3600 * 1000
        for (const name of fs.readdirSync(runtime.logsDir)) {
            if (!/^desktop-.*\.log$/.test(name)) continue
            const full = path.join(runtime.logsDir, name)
            if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full)
        }
    } catch {}
}

// ---------------------------------------------------------------------------
// 工作区解析
// ---------------------------------------------------------------------------

function resolveWorkspace() {
    runtime.userDataDir = app.getPath('userData')
    runtime.logsDir = path.join(runtime.userDataDir, 'logs')
    fs.mkdirSync(runtime.logsDir, { recursive: true })
    loadSettings()

    if (app.isPackaged) {
        runtime.resourcesPath = process.resourcesPath
        runtime.payloadDir = path.join(process.resourcesPath, 'payload')
        runtime.appRoot = path.join(runtime.userDataDir, 'app')
    } else {
        // desktop/src/main.js -> 仓库根
        runtime.appRoot = path.resolve(__dirname, '..', '..')
    }
    runtime.nodePath = orch.resolveNodePath({ resourcesPath: runtime.resourcesPath })
    // 调度器脚本放 extraResources（asar 内的脚本无法被 node 子进程直接执行）
    runtime.schedulerScript =
        runtime.mode === 'packaged'
            ? path.join(process.resourcesPath, 'scheduler.js')
            : path.join(__dirname, 'scheduler.js')
}

async function ensurePorts() {
    runtime.apiPort = await orch.findFreePort(PREFERRED_API_PORT)
    runtime.dashPort = await orch.findFreePort(PREFERRED_DASH_PORT)
}

function setupState() {
    const state = orch.detectSetupState(runtime.appRoot)
    return { ...state, mode: runtime.mode, nodePath: runtime.nodePath }
}

// ---------------------------------------------------------------------------
// 服务启停
// ---------------------------------------------------------------------------

async function startServices() {
    await ensurePorts()
    supervisor = new orch.ServiceSupervisor({
        nodePath: runtime.nodePath,
        appRoot: runtime.appRoot,
        apiPort: runtime.apiPort,
        dashPort: runtime.dashPort,
        token: runtime.token,
        dataDir: path.join(runtime.userDataDir, 'dashboard-data'),
        schedulerScript: runtime.schedulerScript,
        onLog: writeServiceLog,
        onServiceDown: (name, info) => {
            servicesReady = false
            if (info.gaveUp && !quitting) {
                const label = name === 'api' ? '控制 API' : name === 'dashboard' ? '积分看板' : '调度器'
                new Notification({
                    title: 'MS Rewards 桌面端',
                    body: `${label}连续启动失败，请从托盘菜单打开“环境修复”。`
                }).show()
            }
        }
    })
    writeServiceLog(`===== 启动服务 (mode=${runtime.mode}, node=${runtime.nodePath}) =====\n`)
    const res = await supervisor.start()
    servicesReady = res.ok
    return res
}

async function stopServices() {
    if (supervisor) {
        await supervisor.stopAll()
        supervisor = null
    }
    servicesReady = false
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function boundsFile() {
    return path.join(runtime.userDataDir, 'window-bounds.json')
}

function createPanelWindow() {
    if (panelWindow && !panelWindow.isDestroyed()) {
        panelWindow.show()
        panelWindow.focus()
        return
    }
    let bounds = null
    try {
        bounds = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'))
    } catch {}

    panelWindow = new BrowserWindow({
        width: bounds?.width ?? 1200,
        height: bounds?.height ?? 800,
        x: bounds?.x,
        y: bounds?.y,
        minWidth: 900,
        minHeight: 600,
        title: 'MS Rewards 看板',
        autoHideMenuBar: true,
        icon: path.join(__dirname, '..', 'assets', 'icon.png'),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false
        }
    })
    panelWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url) && !url.startsWith(`http://127.0.0.1:${runtime.dashPort}`)) {
            shell.openExternal(url)
        }
        return { action: 'deny' }
    })
    const dashOrigin = `http://127.0.0.1:${runtime.dashPort}`
    panelWindow.webContents.on('will-navigate', event => {
        if (!panelWindow.webContents.getURL().startsWith(dashOrigin) && !event.url.startsWith(dashOrigin)) {
            event.preventDefault()
        }
    })
    panelWindow.on('close', event => {
        if (!quitting) {
            // 关窗 = 缩到托盘，服务继续跑
            event.preventDefault()
            panelWindow.hide()
            return
        }
        try {
            const b = panelWindow.getBounds()
            fs.writeFileSync(boundsFile(), JSON.stringify(b))
        } catch {}
    })
    panelWindow.loadURL(dashOrigin)
}

function createWizardWindow() {
    if (wizardWindow && !wizardWindow.isDestroyed()) {
        wizardWindow.show()
        wizardWindow.focus()
        return
    }
    wizardWindow = new BrowserWindow({
        width: 760,
        height: 640,
        resizable: true,
        title: 'MS Rewards 桌面端 · 环境向导',
        autoHideMenuBar: true,
        icon: path.join(__dirname, '..', 'assets', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    })
    wizardWindow.on('closed', () => (wizardWindow = null))
    wizardWindow.loadFile(path.join(__dirname, '..', 'wizard', 'index.html'))
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------

function createTray() {
    const iconPath = IS_MAC
        ? path.join(__dirname, '..', 'assets', 'trayTemplate.png')
        : path.join(__dirname, '..', 'assets', 'icon.png')
    const icon = nativeImage.createFromPath(iconPath)
    if (IS_MAC) icon.setTemplateImage(true)
    tray = new Tray(icon)
    tray.setToolTip('MS Rewards 桌面端')
    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: '显示面板', click: () => (servicesReady ? createPanelWindow() : createWizardWindow()) },
            { type: 'separator' },
            { label: '打开数据目录', click: () => shell.openPath(runtime.appRoot) },
            { label: '打开日志目录', click: () => shell.openPath(runtime.logsDir) },
            { type: 'separator' },
            {
                label: '开机自启',
                type: 'checkbox',
                checked: !!runtime.settings.autoLaunch,
                click: item => {
                    runtime.settings.autoLaunch = item.checked
                    saveSettings()
                    applyAutoLaunch()
                }
            },
            { label: '环境修复（重新运行向导）', click: () => reopenWizard() },
            { type: 'separator' },
            { label: '退出', click: () => app.quit() }
        ])
    )
    if (IS_MAC && app.dock) {
        try {
            app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')))
        } catch {}
    }
}

function reopenWizard() {
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.hide()
    createWizardWindow()
}

// ---------------------------------------------------------------------------
// IPC（向导页 ↔ 主进程）
// ---------------------------------------------------------------------------

function registerIpc() {
    ipcMain.handle('desktop:getState', () => ({
        mode: runtime.mode,
        appRoot: runtime.appRoot,
        nodePath: runtime.nodePath,
        servicesReady,
        setup: setupState()
    }))

    ipcMain.handle('desktop:syncWorkspace', async () => {
        if (runtime.mode !== 'packaged' || !runtime.payloadDir) return { changed: false }
        return orch.syncWorkspace({
            payloadDir: runtime.payloadDir,
            appRoot: runtime.appRoot,
            onOutput: line => wizardWindow && !wizardWindow.isDestroyed() && wizardWindow.webContents.send('desktop:event', { type: 'step-output', id: 'workspace', text: line })
        })
    })

    ipcMain.handle('desktop:runSetup', async (_event, force) => {
        return orch.performSetup({
            nodePath: runtime.nodePath,
            appRoot: runtime.appRoot,
            force: !!force,
            onEvent: e => {
                if (wizardWindow && !wizardWindow.isDestroyed()) wizardWindow.webContents.send('desktop:event', e)
            }
        })
    })

    ipcMain.handle('desktop:complete', async () => {
        const res = await startServices()
        if (res.ok) {
            if (wizardWindow && !wizardWindow.isDestroyed()) wizardWindow.close()
            createPanelWindow()
        }
        return res
    })

    ipcMain.handle('desktop:openPath', (_e, p) => shell.openPath(String(p)))
    ipcMain.handle('desktop:openExternal', (_e, url) => {
        if (/^https?:\/\//.test(url)) shell.openExternal(url)
    })
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
    app.quit()
} else {
    app.on('second-instance', () => (servicesReady ? createPanelWindow() : createWizardWindow()))

    // 无头冒烟模式: MRS_DESKTOP_SMOKE=1 electron .
    // 自动执行 工作区同步 -> 环境安装 -> 服务启停 全流程后退出，不创建窗口/托盘
    const smoke = process.env.MRS_DESKTOP_SMOKE === '1'
    const smokeExit = code => {
        console.log(`[smoke-desktop] exit ${code}`)
        app.exit(code)
    }

    app.whenReady().then(async () => {
        resolveWorkspace()
        pruneOldLogs()
        applyAutoLaunch()
        registerIpc()

        const state = setupState()

        if (smoke) {
            console.log(`[smoke-desktop] mode=${runtime.mode} appRoot=${runtime.appRoot} node=${runtime.nodePath}`)
            if (runtime.mode === 'packaged') {
                const r = orch.syncWorkspace({ payloadDir: runtime.payloadDir, appRoot: runtime.appRoot, onOutput: line => process.stdout.write(`  ${line}`) })
                console.log(`[smoke-desktop] workspace changed=${r.changed}`)
            }
            const setup = await orch.performSetup({
                nodePath: runtime.nodePath,
                appRoot: runtime.appRoot,
                onEvent: e => {
                    if (e.type !== 'step-output') console.log(`[smoke-desktop] ${e.type}: ${e.id || ''} ${e.label || ''} ${e.detail || e.error || ''}`)
                }
            })
            if (!setup.ok) smokeExit(2)
            const res = await startServices()
            console.log(`[smoke-desktop] services ok=${res.ok} stage=${res.stage || '-'}`)
            if (!res.ok) smokeExit(3)
            await stopServices()
            smokeExit(0)
            return
        }

        createTray()

        if (orch.needsSetup(state)) {
            createWizardWindow()
        } else {
            const res = await startServices()
            if (res.ok) {
                createPanelWindow()
            } else {
                const { response } = await dialog.showMessageBox({
                    type: 'error',
                    title: '服务启动失败',
                    message: '本地服务未能启动',
                    detail: `日志: ${runtime.logsDir}\n点击“环境修复”重新运行安装向导。`,
                    buttons: ['环境修复', '退出'],
                    defaultId: 0
                })
                if (response === 0) createWizardWindow()
                else app.quit()
            }
        }
    })

    app.on('before-quit', event => {
        if (quitting) return
        quitting = true
        event.preventDefault()
        stopServices()
            .catch(() => {})
            .finally(() => app.exit(0))
    })

    app.on('window-all-closed', () => {
        // 有托盘常驻：不退出（macOS 惯例；win/linux 关窗已隐藏到托盘）
    })
}
