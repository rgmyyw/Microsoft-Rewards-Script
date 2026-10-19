'use strict'
/**
 * 桌面端服务编排核心（纯 Node，不依赖 electron，可独立冒烟测试）
 *
 * 职责：
 *  - Node/npm 运行时解析与版本检查（Node >= 24）
 *  - 环境安装步骤（npm install / 构建 / Chromium / 生成 .env 与 config.json）
 *  - 三个本地服务的拉起与守护：control API + dashboard 看板 + trigger 调度器
 *  - 就绪探测、崩溃自动重启、优雅停机（POST /shutdown -> 进程树强杀兜底）
 */

const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')

const IS_WIN = process.platform === 'win32'
const NODE_MAJOR_REQUIRED = 24

// ---------------------------------------------------------------------------
// 端口与 HTTP 工具
// ---------------------------------------------------------------------------

function findFreePort(startPort) {
    return new Promise((resolve, reject) => {
        let port = startPort
        const tryBind = () => {
            if (port > 65535) {
                reject(new Error(`No free port found from ${startPort}.`))
                return
            }
            const server = net.createServer()
            server.once('error', () => {
                port += 1
                tryBind()
            })
            server.once('listening', () => server.close(() => resolve(port)))
            server.listen(port, '127.0.0.1')
        }
        tryBind()
    })
}

function httpRequest({ port, method = 'GET', requestPath = '/', token, body, timeoutMs = 1500 }) {
    return new Promise((resolve, reject) => {
        const headers = {}
        if (token) headers.Authorization = `Bearer ${token}`
        let payload = null
        if (body !== undefined) {
            payload = JSON.stringify(body)
            headers['Content-Type'] = 'application/json'
            headers['Content-Length'] = Buffer.byteLength(payload)
        }
        const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers, timeout: timeoutMs }, res => {
            res.resume()
            res.on('end', () => resolve({ status: res.statusCode }))
        })
        req.on('timeout', () => {
            req.destroy(new Error('timeout'))
        })
        req.on('error', reject)
        if (payload) req.write(payload)
        req.end()
    })
}

// 服务是否已监听：任何 HTTP 状态码（含 401/404）都算“起来了”
async function waitUntilUp(port, { timeoutMs = 20000, intervalMs = 400, token, requestPath = '/' } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        try {
            await httpRequest({ port, token, requestPath })
            return true
        } catch {
            if (Date.now() > deadline) return false
            await new Promise(r => setTimeout(r, intervalMs))
        }
    }
}

// ---------------------------------------------------------------------------
// 运行时解析：Node / npm
// ---------------------------------------------------------------------------

function sidecarNodeCandidates(resourcesPath) {
    if (!resourcesPath) return []
    // 发行包可把官方 Node 24 二进制放到 resources/runtime/{bin/}node[.exe] 作为内置运行时
    const exe = IS_WIN ? 'node.exe' : 'node'
    const dir = IS_WIN ? 'runtime' : path.join('runtime', 'bin')
    const candidate = path.join(resourcesPath, dir, exe)
    return fs.existsSync(candidate) ? [candidate] : []
}

// nvm 已装版本中发现 >= 24 的最高版（不改默认别名，仅用于给服务挑运行时）
function nvmNodeCandidates() {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const roots = []
    if (IS_WIN) {
        if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'nvm')) // nvm-windows
    } else {
        roots.push(path.join(home, '.nvm', 'versions', 'node'))
    }
    const found = []
    for (const root of roots) {
        let entries = []
        try {
            entries = fs.readdirSync(root)
        } catch {
            continue
        }
        for (const name of entries) {
            const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(name)
            if (!m) continue
            const exe = IS_WIN ? path.join(root, name, 'node.exe') : path.join(root, name, 'bin', 'node')
            if (fs.existsSync(exe)) found.push({ exe, major: +m[1], minor: +m[2], patch: +m[3] })
        }
    }
    found.sort((a, b) => b.major - a.major || b.minor - a.minor || b.patch - a.patch)
    return found.filter(c => c.major >= NODE_MAJOR_REQUIRED).map(c => c.exe)
}

/**
 * Node 可执行文件解析顺序：
 *  1. MRS_DESKTOP_NODE 环境变量
 *  2. 打包资源里的 sidecar（resources/runtime/node）——发行包可内置 Node 24
 *  3. nvm 已装的 >= 24 最高版本
 *  4. 系统 PATH 上的 node（向导的版本检查兜底把关）
 */
function resolveNodePath({ resourcesPath } = {}) {
    const explicit = process.env.MRS_DESKTOP_NODE
    if (explicit && fs.existsSync(explicit)) return explicit
    const sidecar = sidecarNodeCandidates(resourcesPath).find(p => {
        try {
            fs.accessSync(p, fs.constants.X_OK)
            return true
        } catch {
            return false
        }
    })
    if (sidecar) return sidecar
    const nvm = nvmNodeCandidates()[0]
    if (nvm) return nvm
    return IS_WIN ? 'node.exe' : 'node'
}

function checkNodeVersion(nodePath) {
    return new Promise(resolve => {
        const child = spawn(nodePath, ['-v'], { windowsHide: true })
        let out = ''
        child.stdout.on('data', c => (out += c))
        child.stderr.on('data', c => (out += c))
        child.on('error', err => resolve({ ok: false, version: null, nodePath, error: err.message }))
        child.on('close', () => {
            const m = /v(\d+)\.(\d+)\.(\d+)/.exec(out)
            if (!m) {
                resolve({ ok: false, version: null, nodePath, error: `无法解析 node -v 输出: ${out.trim() || '(空)'}` })
                return
            }
            const major = Number(m[1])
            resolve({
                ok: major >= NODE_MAJOR_REQUIRED,
                version: `${m[1]}.${m[2]}.${m[3]}`,
                nodePath,
                error:
                    major >= NODE_MAJOR_REQUIRED
                        ? null
                        : `需要 Node.js >= ${NODE_MAJOR_REQUIRED}，当前 v${m[1]}.${m[2]}.${m[3]}`
            })
        })
    })
}

/**
 * 定位 npm-cli.js（官方 Node 发行包均自带），找不到时回退 PATH 上的 npm。
 * 统一用 `node npm-cli.js` 方式调用，规避 Windows npm.cmd 的 shell/shell quoting 问题。
 */
function resolveNpm(nodePath) {
    const real = (() => {
        try {
            return fs.realpathSync(nodePath)
        } catch {
            return nodePath
        }
    })()
    const dir = path.dirname(real)
    const candidates = [
        path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // 官方 zip / Windows 安装器布局
        path.join(path.dirname(dir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js') // unix .pkg / nvm 布局
    ]
    const cli = candidates.find(p => fs.existsSync(p))
    if (cli) return { command: nodePath, argsPrefix: [cli] }
    return { command: IS_WIN ? 'npm.cmd' : 'npm', argsPrefix: [] }
}

// ---------------------------------------------------------------------------
// 通用子进程步骤执行（向导安装步骤用）
// ---------------------------------------------------------------------------

function runStep({ command, args = [], cwd, env, onOutput, timeoutMs = 0 }) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, windowsHide: true })
        let killedByTimeout = false
        let timer = null
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                killedByTimeout = true
                treeKill(child.pid)
            }, timeoutMs)
            if (typeof timer.unref === 'function') timer.unref()
        }
        const feed = data => onOutput && onOutput(data.toString())
        child.stdout.on('data', feed)
        child.stderr.on('data', feed)
        child.on('error', err => {
            if (timer) clearTimeout(timer)
            reject(err)
        })
        child.on('close', (code, signal) => {
            if (timer) clearTimeout(timer)
            if (killedByTimeout) reject(new Error(`步骤超时（${Math.round(timeoutMs / 1000)}s）已终止`))
            else if (code === 0) resolve({ code })
            else reject(new Error(`退出码 ${code ?? signal}`))
        })
    })
}

// ---------------------------------------------------------------------------
// 进程树终止（与 scripts/api/processManager.js 同一套策略）
// ---------------------------------------------------------------------------

function treeKill(pid, { force = true } = {}) {
    if (!pid) return
    if (IS_WIN) {
        spawn('taskkill', ['/pid', String(pid), '/T', force ? '/F' : ''], { windowsHide: true })
        return
    }
    try {
        process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
    } catch {
        try {
            process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
        } catch {
            /* 进程已退出 */
        }
    }
}

// ---------------------------------------------------------------------------
// 安装状态检测与安装步骤
// ---------------------------------------------------------------------------

function playwrightBrowsersDirs() {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const dirs = []
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) dirs.push(process.env.PLAYWRIGHT_BROWSERS_PATH)
    if (IS_WIN) dirs.push(path.join(process.env.LOCALAPPDATA || home, 'ms-playwright'))
    else if (process.platform === 'darwin') dirs.push(path.join(home, 'Library', 'Caches', 'ms-playwright'))
    else dirs.push(path.join(home, '.cache', 'ms-playwright'))
    return dirs.filter(Boolean)
}

function chromiumInstalled() {
    for (const dir of playwrightBrowsersDirs()) {
        let entries = []
        try {
            entries = fs.readdirSync(dir)
        } catch {
            continue
        }
        if (entries.some(name => /^chromium(-headless)?-/.test(name))) {
            const sub = path.join(dir, entries.find(name => /^chromium(-headless)?-/.test(name)))
            try {
                return fs.readdirSync(sub).length > 0
            } catch {
                return false
            }
        }
    }
    return false
}

function detectSetupState(appRoot) {
    return {
        appRoot,
        nodeModules: fs.existsSync(path.join(appRoot, 'node_modules', 'typescript')),
        distEntry: fs.existsSync(path.join(appRoot, 'dist', 'index.js')),
        chromium: chromiumInstalled(),
        envFile: fs.existsSync(path.join(appRoot, '.env')),
        configFile: fs.existsSync(path.join(appRoot, 'config.json'))
    }
}

function needsSetup(state) {
    return !state.nodeModules || !state.distEntry || !state.chromium
}

function createDefaultFiles(appRoot) {
    const created = []
    const pairs = [
        ['env.example', '.env'],
        ['config.example.json', 'config.json']
    ]
    for (const [srcName, destName] of pairs) {
        const dest = path.join(appRoot, destName)
        if (fs.existsSync(dest)) continue
        const src = path.join(appRoot, srcName)
        if (!fs.existsSync(src)) continue
        fs.copyFileSync(src, dest)
        created.push(destName)
    }
    return created
}

function patchrightCli(appRoot) {
    // patchright 包 bin 为包根 cli.js（package.json bin: { patchright: 'cli.js' }）
    const cli = path.join(appRoot, 'node_modules', 'patchright', 'cli.js')
    return fs.existsSync(cli) ? cli : null
}

/**
 * 执行完整安装流程。onEvent 收到:
 *   {type:'step-start'|'step-skip'|'step-done'|'step-error', id, label, error?}
 *   {type:'step-output', id, text}
 *   {type:'done', ok, error?}
 */
async function performSetup({ nodePath, appRoot, force = false, onEvent = () => {} }) {
    const state = detectSetupState(appRoot)
    const npm = resolveNpm(nodePath)
    const steps = [
        {
            id: 'node',
            label: '检查 Node.js 运行时（需 ≥ 24）',
            run: async () => {
                const res = await checkNodeVersion(nodePath)
                if (!res.ok) throw new Error(res.error || 'Node.js 版本不满足要求')
                return `v${res.version}`
            },
            always: true
        },
        {
            id: 'deps',
            label: '安装项目依赖（npm install）',
            run: async () => {
                await runStep({
                    command: npm.command,
                    args: [...npm.argsPrefix, 'install', '--no-audit', '--no-fund'],
                    cwd: appRoot,
                    onOutput: t => onEvent({ type: 'step-output', id: 'deps', text: t })
                })
            },
            skip: !force && state.nodeModules
        },
        {
            id: 'build',
            label: '构建项目（TypeScript → dist）',
            run: async () => {
                await runStep({
                    command: npm.command,
                    args: [...npm.argsPrefix, 'run', 'build'],
                    cwd: appRoot,
                    onOutput: t => onEvent({ type: 'step-output', id: 'build', text: t })
                })
            },
            skip: !force && state.distEntry
        },
        {
            id: 'chromium',
            label: '下载 Chromium 内核（patchright，约 150MB）',
            run: async () => {
                const cli = patchrightCli(appRoot)
                if (!cli) throw new Error('未找到 node_modules/patchright/cli.js，请先完成依赖安装')
                await runStep({
                    command: nodePath,
                    args: [cli, 'install', 'chromium'],
                    cwd: appRoot,
                    onOutput: t => onEvent({ type: 'step-output', id: 'chromium', text: t })
                })
            },
            skip: !force && state.chromium
        },
        {
            id: 'env',
            label: '生成默认配置（.env / config.json）',
            run: async () => {
                const created = createDefaultFiles(appRoot)
                return created.length ? created.join('、') : '已存在，跳过创建'
            },
            always: true
        }
    ]

    for (const step of steps) {
        if (step.skip && !step.always) {
            onEvent({ type: 'step-skip', id: step.id, label: step.label })
            continue
        }
        onEvent({ type: 'step-start', id: step.id, label: step.label })
        try {
            const detail = await step.run()
            onEvent({ type: 'step-done', id: step.id, label: step.label, detail })
        } catch (err) {
            onEvent({ type: 'step-error', id: step.id, label: step.label, error: err.message })
            onEvent({ type: 'done', ok: false, error: `${step.label} 失败: ${err.message}` })
            return { ok: false, failedStep: step.id }
        }
    }
    onEvent({ type: 'done', ok: true })
    return { ok: true }
}

// ---------------------------------------------------------------------------
// 打包负载同步（payload -> userData/app，保留用户数据）
// ---------------------------------------------------------------------------

const USER_DATA_PRESERVE = new Set([
    '.env',
    'config.json',
    'clawbot-auth.json',
    'node_modules',
    'sessions',
    'logs',
    'config',
    'diagnostics',
    'search-queries.user.json'
])

/**
 * 版本一致时跳过；版本变化或首次时把 payload 合并进 appRoot（不覆盖用户数据）。
 */
function syncWorkspace({ payloadDir, appRoot, onOutput = () => {} }) {
    const readV = p => {
        try {
            return JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')).version || '0'
        } catch {
            return null
        }
    }
    const payloadV = readV(payloadDir)
    const appV = readV(appRoot)
    if (payloadV && appV && payloadV === appV) {
        onOutput(`工作区已是 v${appV}，跳过同步\n`)
        return { changed: false, version: appV }
    }
    fs.mkdirSync(appRoot, { recursive: true })
    const entries = fs.readdirSync(payloadDir, { withFileTypes: true })
    for (const entry of entries) {
        if (USER_DATA_PRESERVE.has(entry.name)) continue
        const src = path.join(payloadDir, entry.name)
        const dest = path.join(appRoot, entry.name)
        onOutput(`同步 ${entry.name}\n`)
        if (entry.isDirectory()) fs.cpSync(src, dest, { recursive: true, force: true })
        else fs.copyFileSync(src, dest)
    }
    onOutput(`工作区同步完成 v${appV || '?'} -> v${payloadV || '?'}\n`)
    return { changed: true, version: payloadV }
}

// ---------------------------------------------------------------------------
// 服务守护
// ---------------------------------------------------------------------------

const SERVICE_DEFS = {
    api: { script: 'scripts/api/server.js', label: '控制 API' },
    dashboard: { script: 'dashboard/server.js', label: '积分看板' },
    // 调度器脚本在壳工程内（不在工作区），由构造参数 schedulerScript 提供
    scheduler: { label: '调度器' }
}

function newToken() {
    return crypto.randomBytes(24).toString('hex')
}

class ServiceSupervisor {
    /**
     * @param {object} opts
     * @param {string} opts.nodePath    Node >= 24 可执行文件
     * @param {string} opts.appRoot     项目工作区（含 scripts/ dist/ dashboard/ .env）
     * @param {number} opts.apiPort
     * @param {number} opts.dashPort
     * @param {string} opts.token       control API Bearer token
     * @param {string} opts.dataDir     看板数据目录（DASHBOARD_DATA_DIR）
     * @param {string} opts.schedulerScript  桌面调度器脚本绝对路径（desktop/src/scheduler.js）
     * @param {(line: string) => void} [opts.onLog]  服务输出（同时由调用方落盘）
     * @param {(name: string, info: {exitCode: number|null, gaveUp: boolean}) => void} [opts.onServiceDown]
     */
    constructor({ nodePath, appRoot, apiPort, dashPort, token, dataDir, schedulerScript, onLog = () => {}, onServiceDown = () => {} }) {
        this.nodePath = nodePath
        this.appRoot = appRoot
        this.apiPort = apiPort
        this.dashPort = dashPort
        this.token = token
        this.dataDir = dataDir
        this.schedulerScript = schedulerScript
        this.onLog = onLog
        this.onServiceDown = onServiceDown
        this.children = new Map() // name -> child
        this.intents = new Map() // name -> 'stop' | 'start'
        this.restartCounts = new Map()
        this.stopping = false
    }

    _serviceEnv(name) {
        const base = {
            ...process.env,
            API_HOST: '127.0.0.1',
            API_PORT: String(this.apiPort),
            API_TOKEN: this.token
        }
        // 桌面版本机 + token 鉴权，放开看板所需的写能力（调度/配置在页面上可保存）
        base.API_ALLOW_SCHEDULE_WRITE = 'true'
        base.API_ALLOW_CONFIG_WRITE = 'true'
        // 调度由桌面壳的 scheduler.js 常驻循环执行，API 侧跳过 crontab 写入
        base.MRS_CRONTAB_DISABLE = 'true'
        if (name === 'dashboard') {
            base.DASHBOARD_PORT = String(this.dashPort)
            base.DASHBOARD_DATA_DIR = this.dataDir
        }
        return base
    }

    _startService(name) {
        const def = SERVICE_DEFS[name]
        const script = def.script ? path.join(this.appRoot, def.script) : this.schedulerScript
        if (!script || !fs.existsSync(script)) {
            this.onLog(`[${def.label}] 缺少脚本 ${script || '(未提供)'}\n`)
            this.onServiceDown(name, { exitCode: null, gaveUp: true })
            return
        }
        this.intents.set(name, 'start')
        const child = spawn(this.nodePath, [script], {
            cwd: this.appRoot,
            env: this._serviceEnv(name),
            // POSIX 下独立进程组，便于整树终止；Windows 用 taskkill /T
            detached: !IS_WIN,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        })
        this.children.set(name, child)
        const feed = data => this.onLog(`[${def.label}] ${data.toString()}`)
        child.stdout.on('data', feed)
        child.stderr.on('data', feed)
        child.on('error', err => {
            this.onLog(`[${def.label}] 启动失败: ${err.message}\n`)
        })
        child.on('close', (code, signal) => {
            if (this.children.get(name) !== child) return
            this.children.delete(name)
            if (this.stopping || this.intents.get(name) === 'stop') return
            const count = (this.restartCounts.get(name) || 0) + 1
            this.restartCounts.set(name, count)
            this.onLog(`[${def.label}] 异常退出 code=${code} signal=${signal}（第 ${count} 次）\n`)
            if (count > 5) {
                this.onLog(`[${def.label}] 连续失败，放弃自动重启\n`)
                this.onServiceDown(name, { exitCode: code, gaveUp: true })
                return
            }
            setTimeout(() => {
                if (!this.stopping && this.intents.get(name) === 'start') {
                    this.onLog(`[${def.label}] 5s 后自动重启\n`)
                    this._startService(name)
                }
            }, 5000)
        })
        this.onLog(`[${def.label}] 已启动 pid=${child.pid}\n`)
    }

    async start({ services = ['api', 'dashboard', 'scheduler'] } = {}) {
        this.stopping = false
        this._startService('api')
        const apiUp = await waitUntilUp(this.apiPort, { timeoutMs: 20000, requestPath: '/health', token: this.token })
        if (!apiUp) {
            this.onLog('[控制 API] 20s 内未就绪\n')
            return { ok: false, stage: 'api' }
        }
        this.onLog('[控制 API] 就绪\n')
        if (services.includes('dashboard')) {
            this._startService('dashboard')
            const dashUp = await waitUntilUp(this.dashPort, { timeoutMs: 20000 })
            if (!dashUp) {
                this.onLog('[积分看板] 20s 内未就绪\n')
                return { ok: false, stage: 'dashboard' }
            }
            this.onLog('[积分看板] 就绪\n')
        }
        if (services.includes('trigger')) this._startService('trigger')
        return { ok: true }
    }

    async stopAll({ shutdownTimeoutMs = 12000 } = {}) {
        this.stopping = true
        for (const name of this.children.keys()) this.intents.set(name, 'stop')
        // 1) 优雅停机：让 API 先优雅结束运行中的账号任务
        try {
            await httpRequest({
                port: this.apiPort,
                method: 'POST',
                requestPath: '/shutdown',
                token: this.token,
                body: {},
                timeoutMs: 3000
            })
        } catch {
            /* API 已死或未监听 */
        }
        // 2) 等待 API 自行退出（shutdown 会先停运行再关服务）
        const apiChild = this.children.get('api')
        if (apiChild) {
            await Promise.race([
                new Promise(resolve => apiChild.once('close', resolve)),
                new Promise(resolve => setTimeout(resolve, shutdownTimeoutMs))
            ])
        }
        // 3) 兜底：全部进程树强杀
        for (const [name, child] of [...this.children]) {
            this.intents.set(name, 'stop')
            if (child.pid && child.exitCode === null) treeKill(child.pid)
        }
        // 4) 等收尾（最多 3s）
        if (this.children.size > 0) {
            await Promise.race([
                new Promise(r => setTimeout(r, 3000)),
                ...[...this.children.values()].map(c => new Promise(r => c.once('close', r)))
            ])
        }
        this.children.clear()
    }
}

module.exports = {
    IS_WIN,
    NODE_MAJOR_REQUIRED,
    findFreePort,
    resolveNodePath,
    resolveNpm,
    checkNodeVersion,
    detectSetupState,
    needsSetup,
    chromiumInstalled,
    createDefaultFiles,
    performSetup,
    syncWorkspace,
    newToken,
    ServiceSupervisor,
    treeKill,
    httpRequest,
    waitUntilUp
}
