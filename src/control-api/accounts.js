import fs from 'node:fs'
import path from 'node:path'
import { requestError } from './http.js'
import { accountIndexesFromEnv, envStrFrom, normalizeGeoLocale, normalizeLanguageCode } from '../../scripts/lib/env.js'
import { getProjectRoot } from '../../scripts/lib/projectFiles.cjs'
import { normalizeAccountLevel } from '../rewards/shared/parsers/NormalizeRewards.js'

function sanitizeProxyUrl(value) {
    try {
        const url = new URL(value)
        url.username = ''
        url.password = ''
        return url.toString().replace(/\/$/, '')
    } catch {
        return value.replace(/^(?:[^/@\s]+@|([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@)/i, '$1')
    }
}

// 看板"账号管理"维护的动态账号（config/accounts.json），免重启生效。
// 看到它就跳过动态账号合并, 否则被排除的动态账号会在运行进程里被重新追加,
// 定向跑退化为全量跑(2026-10-14 修复)。
export const ACCOUNTS_DYNAMIC_DISABLED_FLAG = { ACCOUNTS_DYNAMIC_DISABLED: '1' }

const EXTRA_BASE_INDEX = 901
const extraCache = new Map()

function readRawExtraAccounts() {
    const filePath = path.join(getProjectRoot(), 'config', 'accounts.json')
    try {
        if (!fs.existsSync(filePath)) return []
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        if (!Array.isArray(parsed)) return []
        return parsed
            .filter(entry => entry && typeof entry.email === 'string' && entry.email.trim())
            .map(entry => ({ ...entry, email: entry.email.trim() }))
    } catch {
        return []
    }
}

function extraAccountEnvVars(entry, index) {
    const prefix = `ACCOUNT_${index}_`
    const env = { [`${prefix}EMAIL`]: entry.email }
    if (entry.password) env[`${prefix}PASSWORD`] = entry.password
    if (entry.geoLocale) env[`${prefix}GEO_LOCALE`] = entry.geoLocale
    if (entry.langCode) env[`${prefix}LANG_CODE`] = entry.langCode
    if (entry.totpSecret) env[`${prefix}TOTP_SECRET`] = entry.totpSecret
    if (entry.recoveryEmail) env[`${prefix}RECOVERY_EMAIL`] = entry.recoveryEmail
    return env
}

export function loadAccounts(sourceEnv = process.env) {
    const envAccounts = []

    for (const i of accountIndexesFromEnv(sourceEnv)) {
        const email = envStrFrom(sourceEnv, `ACCOUNT_${i}_EMAIL`)
        if (!email) continue

        const proxyUrl = envStrFrom(sourceEnv, `ACCOUNT_${i}_PROXY_URL`)
        envAccounts.push({
            index: i,
            email,
            emailKey: email, // internal history join key; removed before returning the response
            geoLocale: normalizeGeoLocale(envStrFrom(sourceEnv, `ACCOUNT_${i}_GEO_LOCALE`) ?? 'auto'),
            langCode: normalizeLanguageCode(envStrFrom(sourceEnv, `ACCOUNT_${i}_LANG_CODE`) ?? 'en'),
            hasRecoveryEmail: Boolean(envStrFrom(sourceEnv, `ACCOUNT_${i}_RECOVERY_EMAIL`)),
            hasTotp: Boolean(envStrFrom(sourceEnv, `ACCOUNT_${i}_TOTP_SECRET`)),
            proxy: proxyUrl
                ? {
                      url: sanitizeProxyUrl(proxyUrl),
                      port: envStrFrom(sourceEnv, `ACCOUNT_${i}_PROXY_PORT`) ?? null,
                      hasCredentials: Boolean(
                          envStrFrom(sourceEnv, `ACCOUNT_${i}_PROXY_USERNAME`) &&
                          envStrFrom(sourceEnv, `ACCOUNT_${i}_PROXY_PASSWORD`)
                      )
                  }
                : null
        })
    }

    return applyAccountExtras(envAccounts, readRawExtraAccounts())
}

// 动态账号覆盖层（纯函数，供单测）：
//   removed 条目把同邮箱的 env 账号移出运行名单；
//   同邮箱动态条目覆盖 env 账号属性（如改密/换区域）；
//   其余动态条目以 EXTRA_BASE_INDEX 起始的虚拟槽位追加。
export function applyAccountExtras(accounts, extras) {
    const matched = new Set()
    const removed = new Set(extras.filter(e => e.removed === true).map(e => e.email.toLowerCase()))
    const kept = []

    for (const account of accounts) {
        if (removed.has(account.email.toLowerCase())) continue
        const override = extras.find(e => e.email.toLowerCase() === account.email.toLowerCase())
        if (override) {
            matched.add(override.email.toLowerCase())
            if (override.geoLocale) account.geoLocale = normalizeGeoLocale(override.geoLocale)
            if (override.langCode) account.langCode = normalizeLanguageCode(override.langCode)
            if (override.totpSecret) account.hasTotp = true
        }
        kept.push(account)
    }

    extraCache.clear()
    let seq = 0
    for (const entry of extras) {
        if (entry.removed === true) continue
        if (matched.has(entry.email.toLowerCase())) continue
        const index = EXTRA_BASE_INDEX + seq
        seq += 1
        extraCache.set(index, entry)
        kept.push({
            index,
            email: entry.email,
            emailKey: entry.email,
            geoLocale: normalizeGeoLocale(entry.geoLocale ?? 'auto'),
            langCode: normalizeLanguageCode(entry.langCode ?? 'en'),
            hasRecoveryEmail: Boolean(entry.recoveryEmail),
            hasTotp: Boolean(entry.totpSecret),
            proxy: null,
            extra: true
        })
    }
    return kept
}

function buildSingleAccountEnv(accountIndex, sourceEnv = process.env) {
    const index = accountIndex
    if (!Number.isSafeInteger(index) || index < 1) {
        throw requestError('`accountIndex` must be a positive integer.')
    }

    // 动态账号(index >= 901): 从 config/accounts.json 生成单账号运行 env
    if (index >= EXTRA_BASE_INDEX) {
        const entry = readRawExtraAccounts().filter(e => e.removed !== true)[index - EXTRA_BASE_INDEX]
        if (!entry) {
            throw requestError(`ACCOUNT_${index} is not configured.`)
        }
        const env = {}
        for (const key of Object.keys(sourceEnv)) {
            if (/^ACCOUNT_\d+_/.test(key)) env[key] = ''
        }
        Object.assign(env, extraAccountEnvVars(entry, 1), ACCOUNTS_DYNAMIC_DISABLED_FLAG)
        return { env, account: { index, email: entry.email } }
    }

    const selectedPrefix = `ACCOUNT_${index}_`
    const selected = Object.entries(sourceEnv).filter(([key]) => key.startsWith(selectedPrefix))
    const email = envStrFrom(sourceEnv, `${selectedPrefix}EMAIL`)
    if (!email) {
        throw requestError(`ACCOUNT_${index} is not configured.`)
    }

    const env = {}

    for (const key of Object.keys(sourceEnv)) {
        if (/^ACCOUNT_\d+_/.test(key)) env[key] = ''
    }

    for (const [key, value] of selected) {
        const suffix = key.slice(selectedPrefix.length)
        env[`ACCOUNT_1_${suffix}`] = value
    }

    Object.assign(env, ACCOUNTS_DYNAMIC_DISABLED_FLAG)

    return {
        env,
        account: { index, email }
    }
}

export function buildExcludedAccountsEnv(excludedAccountIndexes, sourceEnv = process.env) {
    if (!Array.isArray(excludedAccountIndexes)) {
        throw requestError('`excludedAccountIndexes` must be an array of positive integers.')
    }

    const excluded = [...new Set(excludedAccountIndexes)]
    if (excluded.some(index => !Number.isSafeInteger(index) || index < 1)) {
        throw requestError('`excludedAccountIndexes` must contain only positive integers.')
    }

    const accounts = loadAccounts(sourceEnv)
    const knownIndexes = new Set(accounts.map(account => account.index))
    const unknown = excluded.filter(index => !knownIndexes.has(index))
    if (unknown.length) {
        throw requestError(
            `Unknown account slot${unknown.length === 1 ? '' : 's'}: ${unknown.map(index => `ACCOUNT_${index}`).join(', ')}.`
        )
    }

    const excludedSet = new Set(excluded)
    const included = accounts.filter(account => !excludedSet.has(account.index))
    if (!included.length) {
        throw requestError('A scheduled run cannot exclude every configured account.')
    }

    const env = {}
    for (const key of Object.keys(sourceEnv)) {
        if (/^ACCOUNT_\d+_/.test(key)) env[key] = ''
    }

    included.forEach((account, position) => {
        const sourcePrefix = `ACCOUNT_${account.index}_`
        const targetPrefix = `ACCOUNT_${position + 1}_`
        if (account.extra) {
            // 动态账号: 从 config/accounts.json 生成对应槽位的 env
            const generated = extraAccountEnvVars(extraCache.get(account.index) || {}, account.index)
            for (const [key, value] of Object.entries(generated)) {
                env[`${targetPrefix}${key.slice(sourcePrefix.length)}`] = value
            }
            return
        }
        for (const [key, value] of Object.entries(sourceEnv)) {
            if (!key.startsWith(sourcePrefix)) continue
            env[`${targetPrefix}${key.slice(sourcePrefix.length)}`] = value
        }
    })

    Object.assign(env, ACCOUNTS_DYNAMIC_DISABLED_FLAG)

    return {
        env,
        excludedAccounts: accounts
            .filter(account => excludedSet.has(account.index))
            .map(({ index, email }) => ({ index, email })),
        includedAccounts: included.map(({ index, email }) => ({ index, email }))
    }
}

export function resolveAccountSelection(body, sourceEnv = process.env) {
    if (body.accountIndex != null && body.excludedAccountIndexes != null) {
        throw requestError('`accountIndex` and `excludedAccountIndexes` cannot be used together.')
    }
    if (body.accountIndex != null) {
        const selection = buildSingleAccountEnv(body.accountIndex, sourceEnv)
        return {
            env: selection.env,
            selectedAccount: selection.account,
            excludedAccounts: [],
            accounts: [selection.account]
        }
    }
    if (body.excludedAccountIndexes != null) {
        const selection = buildExcludedAccountsEnv(body.excludedAccountIndexes, sourceEnv)
        return {
            env: selection.env,
            selectedAccount: null,
            excludedAccounts: selection.excludedAccounts,
            accounts: selection.includedAccounts
        }
    }
    return {
        env: {},
        selectedAccount: null,
        excludedAccounts: [],
        accounts: loadAccounts(sourceEnv).map(({ index, email }) => ({ index, email }))
    }
}

export function mergeAccountStats(accounts, runs, liveAccounts = []) {
    // Index history results by email.
    const byEmail = new Map()
    for (const run of runs) {
        if (run.operation === 'session-regeneration') continue
        const when = run.endedAt || run.startedAt || null
        for (const acc of run.accounts || []) {
            if (!byEmail.has(acc.email.toLowerCase())) byEmail.set(acc.email.toLowerCase(), [])
            byEmail.get(acc.email.toLowerCase()).push({ ...acc, when })
        }
    }

    return accounts.map(a => {
        const results = byEmail.get(a.emailKey.toLowerCase()) || [] // already most-recent-first
        const last = results[0] || null
        const observations = [
            ...liveAccounts.filter(account => account.email.toLowerCase() === a.emailKey.toLowerCase()),
            ...results
        ]
        const level =
            observations.map(account => normalizeAccountLevel(account.level)).find(value => value !== null) ?? null
        const latestPoints = key =>
            observations.find(
                account => typeof account[key] === 'number' && Number.isFinite(account[key]) && account[key] >= 0
            )?.[key] ?? null
        const streakProtection = observations.find(result => result.streakProtection != null)?.streakProtection ?? null
        const edgeBrowsing = observations.find(result => result.edgeBrowsing != null)?.edgeBrowsing ?? null

        const pointsKnown = results.every(result => result.pointsKnown !== false && Number.isFinite(result.collected))
        const verifiedCollected = results.reduce(
            (total, result) =>
                total + (result.pointsKnown !== false && Number.isFinite(result.collected) ? result.collected : 0),
            0
        )

        let successStreak = 0
        for (const r of results) {
            if (r.success === true) successStreak++
            else break
        }

        const { emailKey, ...safe } = a
        void emailKey
        return {
            ...safe,
            level,
            pointsProgress: latestPoints('pointsProgress'),
            pointsRemaining: latestPoints('pointsRemaining'),
            lifetimeEarn: latestPoints('lifetimeEarn'),
            accountUpdatedAt: observations.find(account => account.accountUpdatedAt != null)?.accountUpdatedAt ?? null,
            resetAt: observations.find(account => account.resetAt != null)?.resetAt ?? null,
            resetAtSource: observations.find(account => account.resetAt != null)?.resetAtSource ?? null,
            runs: results.length,
            totalCollected: pointsKnown ? verifiedCollected : null,
            pointsKnown,
            verifiedCollected,
            successStreak,
            lastRunAt: last?.when ?? null,
            lastCollected: last?.pointsKnown === false ? null : (last?.collected ?? null),
            lastSuccess: last ? last.success : null,
            lastError: last?.error ?? null,
            lastCompletion: last?.completion ?? null,
            lastPointsBySource: last?.bySource ?? null,
            streaks: observations.find(account => account.streaks?.length)?.streaks ?? [],
            punchCards: observations.find(account => account.punchCards?.length)?.punchCards ?? [],
            streakProtection,
            edgeBrowsing
        }
    })
}
