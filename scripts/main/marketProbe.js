/**
 * 兑换市场 / 账号区域探测器:
 *   1) HTTP 直连(taskProbe 同款): getuserinfo → 档案国家; flyout → 当前服务区域
 *   2) 浏览器恢复会话: rewards.bing.com/redeem → 兑换市场(归属市场)
 *
 * 归属市场判定(2026-09-30 实测):
 *   - /redeem 302 落地市场按当前出口 IP(无 Cookie 也 302 → /redeem/cn), 不能直接当归属;
 *   - 归属 ≠ 落地时页面会出现横幅 + 「Switch back to my country」链接指向归属市场目录;
 *   - 无该链接且无横幅 → 归属与落地一致。
 *
 * 结果写入 config/dashboard/market.json(与看板 state.json 同目录, 原子写)。
 *
 * Usage:
 *   node scripts/main/marketProbe.js --email user@example.com
 *   node scripts/main/marketProbe.js --all
 * 最后一行输出机器可读汇总:
 *   MARKETPROBE_RESULT {"ok":true,"results":[{...}]}
 */

import fs from 'node:fs'
import path from 'node:path'

import { FingerprintGenerator } from 'fingerprint-generator'
import { newInjectedContext } from 'fingerprint-injector'
import { chromium } from 'patchright'

import {
    buildProxyConfig,
    closeSessionDb,
    findAccountByEmail,
    getDirname,
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

const USER_INFO_URL = 'https://rewards.bing.com/api/getuserinfo'
const FLYOUT_URL = 'https://www.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards'
const REDEEM_URL = 'https://rewards.bing.com/redeem'

const BROWSER_ARGS = [
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
]

const MARKET_RE = /^\/redeem\/([a-z]{2}(?:-[a-z]{2})?)(?:\/|$)/i
// 横幅旁证: 归属与当前环境不一致时页面的外出/换区提示
const BANNER_HINTS = ['outside', 'different country', '外出', '旅行', '切换回']
// 归属市场链接: 「Switch back to my country」(英文界面实测, 保守兼容中文)
const SWITCH_BACK_TEXT = /switch\s*back|切换回|返回我/i

const __dirname = getDirname(import.meta.url)
const projectRoot = getProjectRoot(__dirname)

function marketFilePath() {
    return process.env.DASHBOARD_DATA_DIR
        ? path.join(process.env.DASHBOARD_DATA_DIR, 'market.json')
        : path.join(projectRoot, 'config', 'dashboard', 'market.json')
}

function loadMarketFile() {
    try {
        return JSON.parse(fs.readFileSync(marketFilePath(), 'utf8'))
    } catch {
        return { accounts: {} }
    }
}

function saveMarketFile(data) {
    const file = marketFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
}

function loadStoredSession(dbPath, email) {
    if (!fs.existsSync(dbPath)) return null
    const db = openSessionDb(dbPath, { readonly: true })
    try {
        // desktop 优先(实测兑换页 desktop 会话可用), 无则 mobile
        for (const platform of ['desktop', 'mobile']) {
            let session = null
            try {
                session = loadSessionRow(db, email, platform)
            } catch (error) {
                if (!String(error?.message ?? error).includes('no such table: sessions')) throw error
            }
            if (session?.storageState?.cookies?.length) {
                return {
                    platform,
                    storageState: session.storageState,
                    fingerprint: session.fingerprint,
                    resolvedCountry: loadResolvedRegionRow(db, email)
                }
            }
        }
        return null
    } finally {
        closeSessionDb(db)
    }
}

// 与 taskProbe 同款: 不合并重名 cookie, 按路径长度降序拼接
function buildCookieHeader(storageState) {
    const cookies = Array.isArray(storageState?.cookies) ? storageState.cookies : []
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

async function fetchWithCookie(url, cookieHeader, headers, referer, { manualRedirect = true } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    try {
        const res = await fetch(url, {
            headers: {
                ...headers,
                Cookie: cookieHeader,
                Accept: 'application/json, text/plain, */*',
                Referer: referer
            },
            redirect: manualRedirect ? 'manual' : 'follow',
            signal: controller.signal
        })
        clearTimeout(timer)
        if (res.status !== 200) return null
        try {
            return JSON.parse(await res.text())
        } catch {
            return null
        }
    } catch {
        clearTimeout(timer)
        return null
    }
}

// HTTP 直连部分: 档案国家(getuserinfo, 多数账号被拒)+ 当前服务区域(flyout, 全账号可得)
async function probeHttp(cookieHeader, fpHeaders) {
    const out = { profile: null, service: null }
    const userInfo = await fetchWithCookie(USER_INFO_URL, cookieHeader, {
        ...fpHeaders,
        Origin: 'https://rewards.bing.com'
    }, 'https://rewards.bing.com/')
    const pc = userInfo?.dashboard?.userProfile?.attributes?.country ?? userInfo?.userProfile?.attributes?.country
    if (typeof pc === 'string' && /^[a-z]{2}$/i.test(pc)) out.profile = pc.toLowerCase()
    const flyout = await fetchWithCookie(FLYOUT_URL, cookieHeader, fpHeaders, 'https://www.bing.com/', { manualRedirect: false })
    const sc = flyout?.userInfo?.rewardsCountry ?? flyout?.userInfo?.autoRedeemProfile?.country
    if (typeof sc === 'string' && /^[a-z]{2}$/i.test(sc)) out.service = sc.toLowerCase()
    return out
}

// 浏览器部分: /redeem 渲染后读归属市场
async function probeRedeemBrowser(stored, account) {
    const languageTag = new Intl.Locale(account.langCode || 'en').toString()
    const language = new Intl.Locale(languageTag).language.toLowerCase()
    const acceptedLocales = [languageTag, language]
    const fingerprint = (stored.fingerprint?.fingerprint)
        ? stored.fingerprint
        : new FingerprintGenerator().getFingerprint({ devices: ['desktop'], browsers: [{ name: 'edge' }], operatingSystems: ['windows'], locales: acceptedLocales })
    const proxy = buildProxyConfig(account)
    const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0
    const sandboxArgs = process.platform === 'linux' && runningAsRoot ? ['--no-sandbox', '--disable-setuid-sandbox'] : []

    const browser = await chromium.launch({ headless: true, ...(proxy ? { proxy } : {}), args: [...BROWSER_ARGS, ...sandboxArgs] })
    try {
        const context = await newInjectedContext(browser, {
            fingerprint,
            newContextOptions: {
                ignoreHTTPSErrors: Boolean(proxy && proxy.ignoreCertificateErrors),
                storageState: stored.storageState
            }
        })
        context.setDefaultTimeout(60000)
        const page = await context.newPage()
        await page.goto(REDEEM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(error => {
            log('WARN', `redeem 导航未干净完成: ${error.message}`)
        })
        await page.waitForTimeout(9000) // SPA 渲染目录与横幅
        return await page.evaluate(markers => {
            const out = { landing: null, switchBack: null, banner: false }
            const marketRe = new RegExp(markers.marketRe, 'i')
            const switchBackText = new RegExp(markers.switchBackText, 'i')
            const lm = location.pathname.match(marketRe)
            if (lm) out.landing = lm[1].toLowerCase()
            for (const a of document.querySelectorAll('a[href]')) {
                const href = String(a.getAttribute('href') || '')
                const m = href.match(marketRe)
                if (!m) continue
                const market = m[1].toLowerCase()
                const text = (a.textContent || '').trim()
                if (switchBackText.test(text)) out.switchBack = market
            }
            const body = (document.body.innerText || '').toLowerCase()
            out.banner = markers.bannerHints.some(h => body.includes(h))
            return out
        }, { marketRe: MARKET_RE.source, switchBackText: SWITCH_BACK_TEXT.source, bannerHints: BANNER_HINTS.map(s => s.toLowerCase()) })
    } finally {
        await browser.close().catch(() => {})
    }
}

async function probeAccount(account, dbPath) {
    const result = {
        email: account.email,
        market: null,
        landing: null,
        service: null,
        profile: null,
        banner: null,
        ok: false,
        error: null,
        checkedAt: Date.now()
    }
    const stored = loadStoredSession(dbPath, account.email)
    if (!stored) {
        result.error = 'no-saved-session'
        return result
    }
    result.platform = stored.platform

    const cookieHeader = buildCookieHeader(stored.storageState)
    if (cookieHeader) {
        const fpHeaders = { ...(stored.fingerprint?.headers ?? {}) }
        delete fpHeaders['Cookie']
        delete fpHeaders['cookie']
        try {
            const http = await probeHttp(cookieHeader, fpHeaders)
            result.profile = http.profile
            result.service = http.service
        } catch (error) {
            log('WARN', `${account.email}: HTTP 探测异常 ${error.message}`)
        }
    }

    try {
        const redeem = await probeRedeemBrowser(stored, account)
        result.landing = redeem.landing
        result.banner = redeem.banner
        // 归属市场: 「切换回我的国家」链接优先; 无该链接且无横幅 → 归属与落地一致
        result.market = redeem.switchBack || ((redeem.banner && !redeem.switchBack) ? null : redeem.landing)
        if (!redeem.landing) {
            result.error = 'redeem-not-reached(会话可能失效)'
        } else {
            result.ok = true
        }
    } catch (error) {
        result.error = 'redeem 探测异常: ' + String(error?.message ?? error)
    }
    return result
}

async function main() {
    const args = parseArgs(process.argv.slice(2), { boolean: ['help', 'h', 'all'] })
    if (args.help || args.h) {
        console.log('Usage: node scripts/main/marketProbe.js --email user@example.com | --all')
        return
    }
    const accounts = loadAccountsFromEnv(projectRoot)
    let targets
    if (args.all) {
        targets = accounts
    } else {
        const email = resolveEmailArgument(args)
        const account = findAccountByEmail(accounts, email)
        if (!account) throw new Error(`No ACCOUNT block found for ${email}`)
        targets = [account]
    }

    const { data: fileConfig } = loadConfig(projectRoot)
    const { dbPath } = getSessionDbPath(projectRoot, fileConfig.sessionPath)

    const market = loadMarketFile()
    market.accounts = market.accounts || {}
    const results = []
    for (const account of targets) {
        log('INFO', `探测区域: ${account.email}`)
        const r = await probeAccount(account, dbPath)
        results.push(r)
        market.accounts[account.email] = r
        market.updatedAt = Date.now()
        saveMarketFile(market) // 每号即存, 中断不丢已完成部分
        log('INFO', `${account.email}: 市场=${r.market ?? '?'} 落地=${r.landing ?? '?'} 服务=${r.service ?? '?'} 档案=${r.profile ?? '?'} 横幅=${r.banner}${r.error ? ' | ' + r.error : ''}`)
        if (account !== targets[targets.length - 1]) await new Promise(res => setTimeout(res, 2000))
    }
    console.log('MARKETPROBE_RESULT ' + JSON.stringify({ ok: results.some(r => r.ok), results }))
}

main().catch(error => {
    log('ERROR', error.message)
    process.exit(1)
})
