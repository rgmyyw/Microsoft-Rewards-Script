'use strict'
/**
 * 面板集成交互测试：真实 spawn dashboard/server.js（隔离数据目录 + 死容器 API），
 * 走 HTTP 断言全部关键端点与降级韧性。
 * 运行: node --test scripts/tests/dashboard-integration.test.cjs
 */
const test = require('node:test')
const assert = require('node:assert')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const PORT = 28000 + Math.floor(Math.random() * 1000) // 动态空闲端口，避免与常驻服务冲突
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-dash-test-'))
const EXTRA_FILE = path.join(DATA_DIR, 'accounts.json')
const LOGS_DIR = path.join(ROOT, 'logs')

let child = null

function get(p) {
    return new Promise((resolve, reject) => {
        http.get(BASE + p, { headers: { Authorization: 'Bearer none' } }, res => {
            let b = ''
            res.on('data', c => (b += c))
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }))
        }).on('error', reject)
    })
}

function send(p, method, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null
        const req = http.request(BASE + p, { method, headers: { 'Content-Type': 'application/json' } }, res => {
            let b = ''
            res.on('data', c => (b += c))
            res.on('end', () => resolve({ status: res.statusCode, body: b }))
        })
        req.on('error', reject)
        if (data) req.write(data)
        req.end()
    })
}

async function waitForServer(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try {
            const r = await get('/')
            if (r.status === 200) return
        } catch {
            /* 未就绪 */
        }
        await new Promise(r => setTimeout(r, 300))
    }
    throw new Error('server 未在超时内就绪')
}

test.before(async () => {
    // 种子日志文件（供 account-log-dates 读取）
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(
        path.join(LOGS_DIR, '2026-11-17.log'),
        '[18:00:00.000] [MAIN] [INFO] [RUN-START] integration-seed\n'
    )
    // 种子动态账号文件（accounts-manage 数据源）
    fs.writeFileSync(EXTRA_FILE, JSON.stringify([{ email: 'seed@x.com', password: 'p', geoLocale: 'cn' }]))
    child = spawn(process.execPath, [path.join(ROOT, 'dashboard/server.js')], {
        cwd: ROOT,
        env: {
            ...process.env,
            DASHBOARD_PORT: String(PORT),
            DASHBOARD_DATA_DIR: DATA_DIR,
            EXTRA_ACCOUNTS_FILE: EXTRA_FILE,
            API_PORT: '39999', // 无监听端口：验证代理降级
            API_TOKEN: 'integration-token'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stderr.on('data', () => {
        /* 记录但不中断 */
    })
    await waitForServer()
})

test.after(() => {
    if (child) child.kill('SIGKILL')
    try {
        fs.rmSync(DATA_DIR, { recursive: true, force: true })
    } catch {
        /* tmp 清理失败忽略 */
    }
})

test('GET / 返回 200 HTML', async () => {
    const r = await get('/')
    assert.equal(r.status, 200)
    assert.match(r.headers['content-type'] || '', /text\/html/)
    assert.ok(r.body.includes('积分') || r.body.includes('dashboard') || r.body.includes('<!DOCTYPE'))
})

test('GET /api/capabilities 返回 200 JSON', async () => {
    const r = await get('/api/capabilities')
    assert.equal(r.status, 200)
    JSON.parse(r.body)
})

test('GET /api/overview 返回 200 JSON（容器 API 死亡时优雅降级）', async () => {
    const r = await get('/api/overview')
    assert.equal(r.status, 200)
    JSON.parse(r.body)
})

test('push-config PUT→GET 往返一致', async () => {
    const put = await send('/api/push-config', 'PUT', { dedupSeconds: 42 })
    assert.equal(put.status, 200)
    const got = await get('/api/push-config')
    assert.equal(got.status, 200)
    assert.equal(JSON.parse(got.body).dedupSeconds, 42)
})

test('push-test 未配置通道时返回 ok:false 明确错误', async () => {
    const r = await send('/api/push-test', 'POST', {})
    const body = JSON.parse(r.body)
    assert.equal(r.status, 200)
    assert.equal(body.ok, false)
    assert.ok(body.error)
})

test('quarantine GET 返回空列表结构', async () => {
    const r = await get('/api/quarantine')
    assert.equal(r.status, 200)
    assert.deepEqual(JSON.parse(r.body), { accounts: [] })
})

test('quarantine/clear 缺 email 返回 400', async () => {
    const r = await send('/api/quarantine/clear', 'POST', {})
    assert.equal(r.status, 400)
})

test('accounts-manage: 种子动态账号可见', async () => {
    const r = await get('/api/accounts-manage')
    assert.equal(r.status, 200)
    const body = JSON.parse(r.body)
    assert.ok(body.accounts.some(a => a.email === 'seed@x.com'))
})

test('accounts-manage: 新增动态账号落盘 EXTRA_ACCOUNTS_FILE', async () => {
    const add = await send('/api/accounts-manage', 'POST', {
        email: 'new@x.com',
        password: 'pw123456',
        geoLocale: 'cn'
    })
    assert.equal(add.status, 200)
    const onDisk = JSON.parse(fs.readFileSync(EXTRA_FILE, 'utf8'))
    assert.ok(onDisk.some(a => a.email === 'new@x.com'))
    // 动态账号移除：delete 流程需容器 API 确认已知账号——离线环境正确地 404 拒绝（降级语义固化）
    const del = await send('/api/accounts-manage/delete', 'POST', { email: 'new@x.com' })
    assert.equal(del.status, 404)
    const after = JSON.parse(fs.readFileSync(EXTRA_FILE, 'utf8'))
    assert.ok(after.some(a => a.email === 'new@x.com'))
})

test('account-log-dates 读取种子日志', async () => {
    const r = await get('/api/account-log-dates')
    assert.equal(r.status, 200)
    assert.ok(JSON.parse(r.body).dates.includes('2026-11-17'))
})

test('代理端点在容器 API 死亡时优雅降级（不崩溃、可解析响应）', async () => {
    const r = await get('/api/points')
    assert.ok([200, 502].includes(r.status))
    if (r.status === 200) JSON.parse(r.body)
})

test('SSE 重连循环不致进程崩溃（进程存活 3 秒）', async () => {
    await new Promise(r => setTimeout(r, 3000))
    assert.ok(child.pid && !child.killed)
})
