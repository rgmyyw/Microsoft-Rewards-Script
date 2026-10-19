'use strict'
const $ = id => document.getElementById(id)
const logBox = $('log')
const statusEl = $('status')
const startBtn = $('startBtn')
const STEP_ICONS = { pending: '○', running: '◌', done: '✓', error: '✗', skipped: '–' }

const STEP_DEFS = [
    { id: 'workspace', label: '同步程序文件（打包版）' },
    { id: 'node', label: '检查 Node.js 运行时（需 ≥ 24）' },
    { id: 'deps', label: '安装项目依赖（npm install）' },
    { id: 'build', label: '构建项目（TypeScript → dist）' },
    { id: 'chromium', label: '下载 Chromium 内核（约 150MB）' },
    { id: 'env', label: '生成默认配置（.env / config.json）' },
    { id: 'services', label: '启动本地服务（API / 看板 / 调度）' }
]

let state = null
const stepEls = new Map()

function renderSteps() {
    const wrap = $('steps')
    wrap.innerHTML = ''
    stepEls.clear()
    for (const def of STEP_DEFS) {
        if (def.id === 'workspace' && state && state.mode !== 'packaged') continue
        const el = document.createElement('div')
        el.className = 'step'
        el.innerHTML = `<span class="icon">○</span><span class="label">${def.label}</span><span class="detail"></span>`
        wrap.appendChild(el)
        stepEls.set(def.id, el)
    }
}

function setStep(id, kind, detail) {
    const el = stepEls.get(id)
    if (!el) return
    el.className = 'step ' + kind
    el.querySelector('.icon').textContent = (STEP_ICONS[kind] || '○').trim()
    if (kind === 'running') el.querySelector('.icon').innerHTML = '<span class="spin">◌</span>'
    el.querySelector('.detail').textContent = detail || ''
}

function appendLog(text) {
    logBox.textContent += text
    while (logBox.textContent.length > 40000) logBox.textContent = logBox.textContent.slice(-30000)
    logBox.scrollTop = logBox.scrollHeight
}

function setStatus(text, cls) {
    statusEl.textContent = text || ''
    statusEl.className = 'status' + (cls ? ' ' + cls : '')
}

function lockButtons(locked) {
    startBtn.disabled = locked
}

async function boot() {
    state = await window.desktopAPI.getState()
    $('envLine').textContent =
        `模式: ${state.mode === 'packaged' ? '安装版' : '开发版'} · 工作区: ${state.appRoot}` +
        ` · Node: ${state.nodePath}`
    renderSteps()
    // 展示当前状态
    if (state.setup.chromium) setStep('chromium', 'done', '已安装')
    if (state.setup.distEntry) setStep('build', 'done', '已构建')
    if (state.setup.nodeModules) setStep('deps', 'done', '已安装')
    if (state.servicesReady) setStep('services', 'done')
    appendLog('环境检测完成，点击「开始安装 / 检测」继续。\n')
}

async function runAll(force) {
    lockButtons(true)
    try {
        if (state.mode === 'packaged') {
            setStep('workspace', 'running')
            const r = await window.desktopAPI.syncWorkspace()
            setStep('workspace', 'done', r.changed ? '已更新' : '无变化')
        } else {
            setStep('workspace', 'done', '开发版直用仓库')
        }
        const ok = await window.desktopAPI.runSetup(force)
        if (!ok.ok) {
            setStatus('安装失败，详见日志', 'err')
            return false
        }
        return true
    } catch (err) {
        setStatus('安装异常: ' + err.message, 'err')
        return false
    } finally {
        lockButtons(false)
    }
}

window.desktopAPI.onEvent(e => {
    if (e.type === 'step-start') setStep(e.id, 'running')
    else if (e.type === 'step-skip') setStep(e.id, 'skipped', '跳过（已完成）')
    else if (e.type === 'step-done') setStep(e.id, 'done', e.detail || '')
    else if (e.type === 'step-error') setStep(e.id, 'error', e.error || '')
    else if (e.type === 'step-output') appendLog(e.text)
})

startBtn.addEventListener('click', async () => {
    startBtn.textContent = '安装中…'
    const ok = await runAll(false)
    startBtn.textContent = '开始安装 / 检测'
    if (!ok) return
    await launchServices()
})

startBtn.addEventListener('contextmenu', async () => {
    // 右键 = 强制重装（重新 npm install / build / chromium）
    startBtn.textContent = '强制重装中…'
    const ok = await runAll(true)
    startBtn.textContent = '开始安装 / 检测'
    if (!ok) return
    await launchServices()
})

async function launchServices() {
    setStatus('正在启动本地服务…')
    setStep('services', 'running')
    const res = await window.desktopAPI.complete()
    if (res.ok) {
        setStep('services', 'done')
        setStatus('完成', 'ok')
    } else {
        setStep('services', 'error', res.stage === 'api' ? '控制 API 未就绪' : '看板未就绪')
        setStatus('服务启动失败，请查看日志目录', 'err')
    }
}

$('openDirBtn').addEventListener('click', () => window.desktopAPI.openPath(state.appRoot))
$('helpBtn').addEventListener('click', () =>
    window.desktopAPI.openExternal('https://nodejs.org/zh-cn/download/')
)

boot()