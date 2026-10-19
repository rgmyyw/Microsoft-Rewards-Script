#!/usr/bin/env node
'use strict'
/**
 * 桌面端常驻调度器：轮询 control API 的 /schedule，命中 5 段 cron 表达式的分钟时
 * 自动 POST /start（对应容器内的 cron + run_daily.sh 方案）。
 *
 * 由桌面壳以子进程方式拉起（env 注入 API_PORT / API_TOKEN），崩溃由壳自动重启。
 * 不读本地文件，一律走 API，保持与看板同一数据源。
 */

const http = require('node:http')

const API_PORT = Number(process.env.API_PORT === undefined ? 3010 : process.env.API_PORT)
const TOKEN = process.env.API_TOKEN || ''
const POLL_MS = 15_000
const REQUEST_TIMEOUT_MS = 10_000

if (!Number.isSafeInteger(API_PORT) || API_PORT < 1 || API_PORT > 65535) {
    console.error('[scheduler] API_PORT must be an integer between 1 and 65535.')
    process.exit(1)
}

function request(method, requestPath, body) {
    return new Promise((resolve, reject) => {
        const headers = {}
        if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`
        let payload = null
        if (body !== undefined) {
            payload = JSON.stringify(body)
            headers['Content-Type'] = 'application/json'
            headers['Content-Length'] = Buffer.byteLength(payload)
        }
        const req = http.request(
            { host: '127.0.0.1', port: API_PORT, path: requestPath, method, headers, timeout: REQUEST_TIMEOUT_MS },
            res => {
                let raw = ''
                res.on('data', c => (raw += c))
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, body: JSON.parse(raw) })
                    } catch {
                        resolve({ status: res.statusCode, body: raw })
                    }
                })
            }
        )
        req.on('timeout', () => req.destroy(new Error('timeout')))
        req.on('error', reject)
        if (payload) req.write(payload)
        req.end()
    })
}

// ---------------------------------------------------------------------------
// 5 段 cron 匹配（分 时 日 月 周），语义与 scripts/api/scheduleStore.js 校验一致
// ---------------------------------------------------------------------------

function matchField(expr, value, { min, max }) {
    return expr.split(',').some(part => {
        if (part === '*') return true
        const [range, stepRaw] = part.split('/')
        const step = stepRaw === undefined ? 1 : Number(stepRaw)
        if (!Number.isInteger(step) || step < 1) return false
        let lo
        let hi
        if (range === '*') {
            lo = min
            hi = max
        } else if (range.includes('-')) {
            const [a, b] = range.split('-').map(Number)
            lo = a
            hi = b
        } else {
            lo = hi = Number(range)
        }
        if (![lo, hi, value].every(Number.isFinite)) return false
        if (value < lo || value > hi) return false
        return (value - lo) % step === 0
    })
}

function cronMatches(cron, date) {
    const fields = cron.trim().split(/\s+/)
    if (fields.length !== 5) return false
    const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = fields
    const minute = date.getMinutes()
    const hour = date.getHours()
    const dom = date.getDate()
    const month = date.getMonth() + 1
    const dow = date.getDay() // 0 = Sunday，与 7 等价

    const minuteOk = matchField(minExpr, minute, { min: 0, max: 59 })
    const hourOk = matchField(hourExpr, hour, { min: 0, max: 23 })
    const monthOk = matchField(monExpr, month, { min: 1, max: 12 })
    // vixie-cron 语义：日 与 周 都受限时，二者命中其一即触发
    const domRestricted = domExpr !== '*'
    const dowRestricted = dowExpr !== '*'
    const domOk = matchField(domExpr, dom, { min: 1, max: 31 })
    const dowOk = matchField(dowExpr, dow, { min: 0, max: 7 }) || (dow === 0 && matchField(dowExpr, 7, { min: 0, max: 7 }))
    const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk

    return minuteOk && hourOk && monthOk && dayOk
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

let lastFiredKey = ''

async function tick() {
    let schedule
    try {
        const res = await request('GET', '/schedule')
        if (res.status !== 200 || typeof res.body !== 'object') return
        schedule = res.body
    } catch {
        return // API 未就绪，下个周期再试
    }
    if (!schedule.enabled || !schedule.cron) return

    const now = new Date()
    const key = `${schedule.cron}|${now.toLocaleString('sv')}` // 精确到分钟的去重键
    if (key === lastFiredKey) return
    if (!cronMatches(schedule.cron, now)) return
    lastFiredKey = key

    if (schedule.skipIfRunning) {
        try {
            const { body } = await request('GET', '/status')
            if (body && body.running) {
                console.log(`调度命中 ${schedule.cron}，但有任务正在运行（skipIfRunning），跳过`)
                return
            }
        } catch {
            console.log('调度命中但查询运行状态失败，本分钟跳过')
            return
        }
    }

    const body = schedule.excludedAccountIndexes?.length
        ? { excludedAccountIndexes: schedule.excludedAccountIndexes }
        : {}
    try {
        const { status } = await request('POST', '/start', body)
        if (status === 202) console.log(`调度命中 ${schedule.cron}，已触发运行`)
        else if (status === 409) console.log('调度命中，但已有任务在运行（409），跳过')
        else console.log(`调度触发失败: HTTP ${status}`)
    } catch (err) {
        console.log(`调度触发异常: ${err.message}`)
    }
}

console.log(`桌面调度器已启动: API 127.0.0.1:${API_PORT}, 每 ${POLL_MS / 1000}s 轮询 /schedule`)
if (require.main === module) {
    setInterval(() => tick().catch(() => {}), POLL_MS)
}

module.exports = { matchField, cronMatches, tick }
