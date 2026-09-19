/**
 * Lightweight task/balance probe: reads the saved session cookies from the
 * session DB and calls the rewards user-info API directly (NO browser).
 * Safe to run concurrently with an active run (negligible CPU/memory).
 *
 * Usage: node scripts/main/taskProbe.js --email user@example.com
 * Output: last stdout line is machine-readable:
 *   TASKPROBE_RESULT {"email":"...","balance":1234,"tasks":{...},"ok":true}
 */

import fs from 'node:fs'

import {
    closeSessionDb,
    findAccountByEmail,
    getProjectRoot,
    getSessionDbPath,
    loadAccountsFromEnv,
    loadConfig,
    loadResolvedRegionRow,
    loadSessionRow,
    log,
    openSessionDb,
    parseArgs,
    resolveEmailArgument
} from '../utils.js'
import { getDirname } from '../utils.js'

const USER_INFO_URL = 'https://rewards.bing.com/api/getuserinfo'
const REWARDS_ORIGIN = 'https://rewards.bing.com'

const __dirname = getDirname(import.meta.url)
const projectRoot = getProjectRoot(__dirname)

function loadStoredSession(dbPath, email, platform) {
    if (!fs.existsSync(dbPath)) return null
    const db = openSessionDb(dbPath, { readonly: true })
    try {
        let session = null
        try {
            session = loadSessionRow(db, email, platform)
        } catch (error) {
            if (!String(error?.message ?? error).includes('no such table: sessions')) throw error
        }
        return {
            storageState: session?.storageState ?? null,
            fingerprint: session?.fingerprint ?? null,
            resolvedCountry: loadResolvedRegionRow(db, email)
        }
    } finally {
        closeSessionDb(db)
    }
}

function buildCookieHeader(storageState) {
    // 与脚本 BrowserFunc.buildCookieHeader 语义一致: 不合并重名, 全部拼接;
    // 发送顺序按路径长度降序(更具体的路径在前), 同路径时精确域优先
    const cookies = (storageState && Array.isArray(storageState.cookies)) ? storageState.cookies : []
    const matched = cookies.filter(c => String(c.domain || '').toLowerCase().endsWith('bing.com'))
    matched.sort((a, b) => {
        const pl = (b.path || '/').length - (a.path || '/').length
        if (pl !== 0) return pl
        const ad = String(a.domain || '').toLowerCase()
        const bd = String(b.domain || '').toLowerCase()
        if (ad === bd) return 0
        return ad === 'rewards.bing.com' ? -1 : (bd === 'rewards.bing.com' ? 1 : 0)
    })
    if (!matched.length) return ''
    return matched.map(c => `${c.name}=${c.value}`).join('; ')
}

async function fetchUserInfo(cookieHeader, headers) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    try {
        const res = await fetch(USER_INFO_URL, {
            headers: {
                ...headers,
                Cookie: cookieHeader,
                Accept: 'application/json, text/plain, */*',
                Referer: REWARDS_ORIGIN + '/',
                Origin: REWARDS_ORIGIN
            },
            redirect: 'manual',
            signal: controller.signal
        })
        clearTimeout(timer)
        const text = await res.text()
        if (res.status !== 200) return { ok: false, status: res.status, location: res.headers.get('location') || '', body: text.slice(0, 120) }
        try {
            return { ok: true, json: JSON.parse(text) }
        } catch (e) {
            return { ok: false, status: res.status, body: 'non-json: ' + text.slice(0, 120) }
        }
    } catch (error) {
        clearTimeout(timer)
        return { ok: false, error: String(error?.message ?? error) }
    }
}

const FLYOUT_URL = 'https://www.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards'

async function fetchFlyout(cookieHeader, headers) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    try {
        const res = await fetch(FLYOUT_URL, {
            headers: {
                ...headers,
                Cookie: cookieHeader,
                Accept: 'application/json, text/plain, */*',
                Referer: 'https://www.bing.com/'
            },
            signal: controller.signal
        })
        clearTimeout(timer)
        const text = await res.text()
        if (res.status !== 200) {
            log('WARN', `flyout 状态 ${res.status} | ${text.slice(0, 80)}`)
            return null
        }
        let json
        try { json = JSON.parse(text) } catch (e) { log('WARN', 'flyout 非 JSON'); return null }
        const ui = json?.userInfo ?? null
        let balance = ui?.balance ?? json?.userStatus?.availablePoints ?? null
        // 实测(2026-09-19): 会话不被 rewards 主接口接受时, flyout 会以未登录视角
        // 返回 200 且余额为 0 —— 非正余额一律视为"未取到", 让上层走浏览器体检兜底,
        // 否则 0 落库会把看板次日"当日起点余额"毒化, "今日获得"变成全部余额
        if (balance !== null && !(Number(balance) > 0)) balance = null
        // 实测(2026-09-06): 部分账号 getuserinfo 302 → /Signin, flyout 仅有余额(userInfo.balance),
        // 无任务明细/计数器 —— 此类账号任务数量微软侧不可得, 仅同步余额
        return { balance: balance === null ? null : Number(balance), tasks: null }
    } catch (error) {
        clearTimeout(timer)
        log('WARN', 'flyout 异常: ' + String(error?.message ?? error))
        return null
    }
}

function extractTasks(json) {
    const d = json?.dashboard ?? {}
    const pad2 = n => String(n).padStart(2, '0')
    // 浏览器外无时区伪造问题, 但仍用 UTC 系 getter 保持口径一致: 北京/UTC/UTC+1 三个候选键
    const keyFor = offsetH => {
        const dt = new Date(Date.now() + offsetH * 3600e3)
        return `${pad2(dt.getUTCMonth() + 1)}/${pad2(dt.getUTCDate())}/${dt.getUTCFullYear()}`
    }
    const todayKeys = [...new Set([keyFor(8), keyFor(0), keyFor(1)])]
    let ds = null
    const dsObj = d.dailySetPromotions
    if (dsObj && typeof dsObj === 'object' && !Array.isArray(dsObj)) {
        for (const k of todayKeys) {
            if (Array.isArray(dsObj[k]) && dsObj[k].length) { ds = dsObj[k]; break }
        }
    }
    const dsItems = Array.isArray(ds) ? ds : []
    const counters = d.userStatus?.counters ?? {}
    const searchItems = ['pcSearch', 'mobileSearch']
        .flatMap(k => (Array.isArray(counters?.[k]) ? counters[k] : []))
        .filter(x => x && (x.pointProgressMax ?? 0) > 0)
    const cards = (Array.isArray(d.punchCards) ? d.punchCards : [])
        .flatMap(p => (Array.isArray(p?.childTasks) ? p.childTasks : []))
    const countDone = items => {
        const total = items.length
        const done = items.filter(x => x.complete === true).length
        return { done, total }
    }
    const dailyset = countDone(dsItems)
    const search = countDone(searchItems)
    const punch = countDone(cards)
    const hasAny = dailyset.total + search.total + punch.total > 0
    const allDone = hasAny &&
        (dailyset.total === 0 || dailyset.done === dailyset.total) &&
        (search.total === 0 || search.done === search.total) &&
        (punch.total === 0 || punch.done === punch.total)
    return {
        dailysetDone: dailyset.done, dailysetTotal: dailyset.total,
        searchDone: search.done, searchTotal: search.total,
        punchDone: punch.done, punchTotal: punch.total,
        allDone
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2), { boolean: ['help', 'h'] })
    const email = resolveEmailArgument(args)

    const accounts = loadAccountsFromEnv(projectRoot)
    const account = findAccountByEmail(accounts, email)
    if (!account) throw new Error(`No ACCOUNT block found for ${email}`)

    const { data: fileConfig } = loadConfig(projectRoot)
    const { dbPath } = getSessionDbPath(projectRoot, fileConfig.sessionPath)

    // 依次尝试 mobile/desktop 会话, 取到第一个能成功调 API 的为止
    for (const platform of ['mobile', 'desktop']) {
        const stored = loadStoredSession(dbPath, account.email, platform)
        if (!stored || !stored.storageState || !stored.storageState.cookies?.length) continue
        const cookieHeader = buildCookieHeader(stored.storageState)
        if (!cookieHeader) continue
        // 与脚本 getDashboardData 相同: 发送存储指纹的完整请求头(去掉 Cookie 键)
        const fpHeaders = { ...(stored.fingerprint?.headers ?? {}) }
        delete fpHeaders['Cookie']
        delete fpHeaders['cookie']
        const r = await fetchUserInfo(cookieHeader, fpHeaders)
        if (!r.ok) {
            log('WARN', `${platform}: getuserinfo 失败(尝试 flyout 备用接口) | ${JSON.stringify({ status: r.status, location: r.location || '', error: r.error, body: r.body })}`)
            const fb = await fetchFlyout(cookieHeader, fpHeaders)
            if (fb) {
                const payload = { email: account.email, balance: fb.balance, tasks: fb.tasks, loggedIn: true, platform, via: 'flyout', checkedAt: new Date().toISOString() }
                console.log('TASKPROBE_RESULT ' + JSON.stringify(payload))
                return
            }
            continue
        }
        const dashboard = r.json?.dashboard ?? {}
        const balance = dashboard?.userStatus?.availablePoints ?? null
        const tasks = extractTasks(r.json)
        const payload = {
            email: account.email,
            balance: balance === null ? null : Number(balance),
            tasks,
            loggedIn: true,
            platform,
            checkedAt: new Date().toISOString()
        }
        console.log('TASKPROBE_RESULT ' + JSON.stringify(payload))
        return
    }
    console.log('TASKPROBE_RESULT ' + JSON.stringify({ email: account.email, ok: false, reason: 'no-usable-session' }))
}

main().catch(error => {
    log('ERROR', error.message)
    process.exit(1)
})
