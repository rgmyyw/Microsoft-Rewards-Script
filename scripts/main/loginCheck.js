/* global window */

/**
 * Headless login health-check + live balance probe for one account.
 *
 * Restores the saved mobile/desktop session, opens rewards.bing.com and
 * verifies the session still lands on the Rewards page (not a login redirect),
 * then reads the live balance from the Rewards user-info API. Refreshed cookies
 * are saved back to the session store so a passing check also extends the
 * session's life.
 *
 * Usage:
 *   node scripts/main/loginCheck.js --email user@example.com [--platform mobile|desktop|both]
 *
 * Output: the last stdout line is machine-readable:
 *   LOGINCHECK_RESULT {"email":"...","balance":1234,"platforms":{...}}
 * Everything before it is human-readable progress logging.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FingerprintGenerator } from 'fingerprint-generator'
import { newInjectedContext } from 'fingerprint-injector'
import ms from 'ms'
import { chromium } from 'patchright'

import {
    buildProxyConfig,
    closeSessionDb,
    ensureSessionSchema,
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
    resolveEmailArgument,
    saveSessionRow
} from '../utils.js'
import { isRewardsPage, parsePlatforms, resolveGlobalTimeoutMs } from './manualLogin.js'

const REWARDS_URL = 'https://rewards.bing.com/'
const USER_INFO_PATH = '/api/getuserinfo'
const OVERALL_TIMEOUT_MS = 240000

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

const __dirname = getDirname(import.meta.url)
const projectRoot = getProjectRoot(__dirname)

function normalizeCountry(value) {
    if (!value) return undefined
    const country = String(value).trim().toUpperCase()
    return /^[A-Z]{2}$/.test(country) ? country : undefined
}

function resolveLocale(account, resolvedCountry) {
    const languageTag = new Intl.Locale(account.langCode || 'en').toString()
    const language = new Intl.Locale(languageTag).language.toLowerCase()
    const configuredCountry = account.geoLocale.toLowerCase() === 'auto' ? undefined : normalizeCountry(account.geoLocale)
    const country = configuredCountry ?? normalizeCountry(resolvedCountry) ?? normalizeCountry(new Intl.Locale(languageTag).region)
    const locale = country ? new Intl.Locale(languageTag, { region: country }).toString() : languageTag
    return { locale, acceptedLocales: [locale] }
}

function createFingerprint(isMobile, locale) {
    const hostOs = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : 'windows'
    return new FingerprintGenerator().getFingerprint({
        devices: isMobile ? ['mobile'] : ['desktop'],
        operatingSystems: isMobile ? ['android'] : [hostOs],
        browsers: [{ name: 'edge' }],
        locales: locale.acceptedLocales
    })
}

function loadStoredSession(dbPath, email, platform) {
    if (!fs.existsSync(dbPath)) return { storageState: null, fingerprint: null, resolvedCountry: undefined }
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

function saveCheckedSession(dbPath, email, platform, storageState, fingerprint, persistFingerprint) {
    const sessionDir = path.dirname(dbPath)
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
    const db = openSessionDb(dbPath)
    try {
        ensureSessionSchema(db)
        saveSessionRow(db, email, platform, storageState, fingerprint, persistFingerprint)
    } finally {
        closeSessionDb(db)
    }
}

async function readBalance(page) {
    // 与主脚本 BrowserFunc.getDashboardData 同源:rewards.bing.com 的 user-info API,
    // 结构上兼容 {dashboard:{userStatus:{availablePoints}}} 与 {userInfo:{balance}}
    // 同时实测"今日任务完成度"(微软侧逐项 complete 标志, 口径: 当日每日任务集 + 搜索计数器 + 打卡子任务;
    // morePromotions 为长期推广不算在内)
    return await page.evaluate(async userInfoPath => {
        try {
            let res = null
            // getuserinfo 偶发首次请求失败(会话 cookie 尚未就绪等), 重试 3 次
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    res = await fetch(userInfoPath, { credentials: 'include' })
                    if (res.ok) break
                } catch (e) {
                    if (attempt === 2) return { ok: false, error: String(e?.message ?? e) }
                }
                await new Promise(r => setTimeout(r, 2000))
            }
            if (!res || !res.ok) return { ok: false, status: res ? res.status : 0 }
            const json = await res.json()
            const dashboard = json?.dashboard ?? {}
            const points =
                dashboard?.userStatus?.availablePoints ??
                json?.userInfo?.balance ??
                json?.userStatus?.availablePoints ??
                null
            // ---- 今日任务完成度 ----
            const d = dashboard ?? {}
            const pad2 = n => String(n).padStart(2, '0')
            // 浏览器本地时区可能被指纹注入伪造, 必须用 UTC 系 getter: 北京/UTC/UTC+1 三个候选键
            const keyFor = (offsetH) => {
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
                if (!ds) {
                    const cand = Object.keys(dsObj).map(k => ({ k, arr: dsObj[k] })).filter(x => Array.isArray(x.arr) && x.arr.length)
                    cand.sort((a, b) => new Date(a.k).getTime() - new Date(b.k).getTime())
                    const match = cand.find(x => x.k === todayKeys[0]) || cand.find(x => x.k === todayKeys[1]) || cand[0]
                    ds = match ? match.arr : null
                }
            }
            const dsItems = Array.isArray(ds) ? ds : []
            const counters = d.userStatus?.counters ?? {}
            const searchItems = ['pcSearch', 'mobileSearch']
                .flatMap(k => (Array.isArray(counters?.[k]) ? counters[k] : []))
                .filter(x => x && (x.pointProgressMax ?? 0) > 0)
            const cards = (Array.isArray(d.punchCards) ? d.punchCards : [])
                .flatMap(p => (Array.isArray(p?.childTasks) ? p.childTasks : []))
            const countDone = (items, byProgress) => {
                const total = items.length
                const done = items.filter(x => byProgress
                    ? ((x.pointProgress ?? 0) >= (x.pointProgressMax ?? 0) && (x.pointProgressMax ?? 0) > 0)
                    : x.complete === true).length
                return { done, total }
            }
            const dailyset = countDone(dsItems, false)
            const search = countDone(searchItems, true)
            const punch = countDone(cards, false)
            const hasAny = dailyset.total + search.total + punch.total > 0
            const allDone = hasAny &&
                (dailyset.total === 0 || dailyset.done === dailyset.total) &&
                (search.total === 0 || search.done === search.total) &&
                (punch.total === 0 || punch.done === punch.total)
            const tasks = {
                dailysetDone: dailyset.done, dailysetTotal: dailyset.total,
                searchDone: search.done, searchTotal: search.total,
                punchDone: punch.done, punchTotal: punch.total,
                allDone
            }
            return { ok: true, points: points === null ? null : Number(points), tasks }
        } catch (error) {
            return { ok: false, error: String(error?.message ?? error) }
        }
    }, USER_INFO_PATH)
}

async function checkPlatform({ account, config, dbPath, platform }) {
    const result = { platform, loggedIn: false, balance: null, cookies: 0, reason: '' }
    const stored = loadStoredSession(dbPath, account.email, platform)
    if (!stored.storageState || !stored.storageState.cookies?.length) {
        result.reason = 'no-saved-session'
        return result
    }

    const isMobile = platform === 'mobile'
    const locale = resolveLocale(account, stored.resolvedCountry)
    const savesFingerprint = isMobile ? account.saveFingerprint.mobile : account.saveFingerprint.desktop
    const fingerprint =
        savesFingerprint && stored.fingerprint ? stored.fingerprint : createFingerprint(isMobile, locale)
    const screen = fingerprint.fingerprint.screen
    const proxy = buildProxyConfig(account)
    const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0
    const sandboxArgs = process.platform === 'linux' && runningAsRoot ? ['--no-sandbox', '--disable-setuid-sandbox'] : []
    const globalTimeout = resolveGlobalTimeoutMs(config.globalTimeout)

    const browser = await chromium.launch({
        headless: true,
        ...(proxy ? { proxy } : {}),
        args: [...BROWSER_ARGS, ...sandboxArgs]
    })

    try {
        const context = await newInjectedContext(browser, {
            fingerprint,
            newContextOptions: {
                ignoreHTTPSErrors: Boolean(proxy && config.proxy?.ignoreCertificateErrors),
                storageState: stored.storageState,
                ...(isMobile
                    ? {
                          isMobile: true,
                          hasTouch: true,
                          deviceScaleFactor: screen.devicePixelRatio,
                          viewport: { width: screen.width, height: screen.height },
                          screen: { width: screen.width, height: screen.height }
                      }
                    : {})
            }
        })
        context.setDefaultTimeout(globalTimeout)

        const page = await context.newPage()
        await page.goto(REWARDS_URL, { waitUntil: 'domcontentloaded', timeout: globalTimeout }).catch(error => {
            log('WARN', `Navigation to ${REWARDS_URL} did not finish cleanly: ${error.message}`)
        })

        await page.waitForLoadState('domcontentloaded', { timeout: globalTimeout }).catch(() => {})
        const finalUrl = page.url()
        if (!isRewardsPage(finalUrl)) {
            result.reason = 'redirected-to-login'
            result.cookies = stored.storageState.cookies?.length ?? 0
            log('WARN', `${platform} session is NOT logged in (landed on ${finalUrl})`)
            return result
        }

        result.loggedIn = true
        result.cookies = stored.storageState.cookies?.length ?? 0

        const balance = await readBalance(page)
        if (balance.ok && balance.points != null) result.balance = balance.points
        if (balance.ok && balance.tasks) result.tasks = balance.tasks

        // 回写刷新后的 cookie, 顺带续期会话
        try {
            const storageState = await context.storageState()
            if (storageState.cookies?.length) {
                saveCheckedSession(dbPath, account.email, platform, storageState, fingerprint, savesFingerprint)
                result.sessionRefreshed = true
            }
        } catch (error) {
            log('WARN', `Failed to persist refreshed session: ${error.message}`)
        }
        return result
    } finally {
        await browser.close().catch(() => {})
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2), { boolean: ['help', 'h'] })
    if (args.help || args.h) {
        console.log('Usage: node scripts/main/loginCheck.js --email <account-email> [--platform mobile|desktop|both]')
        return
    }
    const email = resolveEmailArgument(args)
    const platforms = parsePlatforms(args.platform)

    const accounts = loadAccountsFromEnv(projectRoot)
    const account = findAccountByEmail(accounts, email)
    if (!account) throw new Error(`No ACCOUNT_N_* block found in .env for ${email}`)

    const { data: fileConfig } = loadConfig(projectRoot)
    const { dbPath } = getSessionDbPath(projectRoot, fileConfig.sessionPath)

    const overallTimer = setTimeout(() => {
        log('ERROR', `loginCheck timed out after ${OVERALL_TIMEOUT_MS / 1000}s`)
        process.exit(3)
    }, OVERALL_TIMEOUT_MS)
    overallTimer.unref?.()

    const platformsResult = {}
    for (const platform of platforms) {
        log('INFO', `Checking ${platform} session for ${account.email}...`)
        try {
            platformsResult[platform] = await checkPlatform({ account, config: fileConfig, dbPath, platform })
        } catch (error) {
            log('ERROR', `${platform} check failed: ${error.message}`)
            platformsResult[platform] = { platform, loggedIn: false, balance: null, reason: 'error', error: error.message }
        }
    }

    const values = Object.values(platformsResult)
    const balance = values.map(r => r.balance).find(v => v != null) ?? null
    const tasks = values.map(r => r.tasks).find(t => t != null) ?? null
    const loggedIn = values.some(r => r.loggedIn)
    const payload = {
        email: account.email,
        balance,
        tasks,
        loggedIn,
        platforms: platformsResult,
        checkedAt: new Date().toISOString()
    }
    console.log('LOGINCHECK_RESULT ' + JSON.stringify(payload))
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
    main().catch(error => {
        log('ERROR', `loginCheck failed: ${error?.message ?? error}`)
        process.exitCode = 1
    })
}
