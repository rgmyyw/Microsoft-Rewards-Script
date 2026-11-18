import projectFiles from './projectFiles.cjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sessionDatabase from './sessionDatabase.cjs'
import logging from './logging.cjs'
import { loadAccountSettings } from './env.js'

export const { getProjectRoot, loadEnvFile } = projectFiles
export { parseArgs, findUnknownOptions } from './args.js'
export const { getSessionDbPath, openSessionDb, ensureSessionSchema, closeSessionDb, clearSessionRows } =
    sessionDatabase
export const { exitWithUsage } = logging

export function getDirname(importMetaUrl) {
    const __filename = fileURLToPath(importMetaUrl)
    return path.dirname(__filename)
}

export function log(level, ...args) {
    logging.logMessage('', level, ...args)
}

export function resolveEmailArgument(args) {
    const positionals = Array.isArray(args?._) ? args._ : []
    const optionValue = args?.email

    if (optionValue === true || optionValue === '') {
        throw new Error('--email requires an email address after it.')
    }
    if (optionValue !== undefined && typeof optionValue !== 'string') {
        throw new Error('--email must be followed by a valid email address.')
    }
    if (positionals.length > 1) {
        throw new Error(`Unexpected extra arguments: ${positionals.slice(1).join(' ')}`)
    }
    if (optionValue !== undefined && positionals.length > 0) {
        throw new Error('Provide the account email once, either positionally or with --email.')
    }

    const email = String(optionValue ?? positionals[0] ?? '').trim()
    if (!email) {
        throw new Error('Missing account email address.')
    }
    if (!email.includes('@') || email.startsWith('@') || email.endsWith('@')) {
        throw new Error(`Invalid account email address: ${email}`)
    }

    return email
}

export function loadConfig(projectRoot) {
    const configPath = projectFiles.resolveProjectFile('config.json', projectRoot)
    if (!configPath) {
        log('ERROR', 'config.json not found. Place it in the project root before running this command.')
        process.exit(1)
    }

    let data
    try {
        data = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch (error) {
        log('ERROR', `Failed to read config.json at ${configPath}: ${error.message}`)
        process.exit(1)
    }

    if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        typeof data.sessionPath !== 'string' ||
        !data.sessionPath.trim()
    ) {
        log('ERROR', 'Invalid config.json: sessionPath must be a non-empty directory path.')
        log('ERROR', `Config file: ${configPath}`)
        process.exit(1)
    }

    return { data, path: configPath }
}

export function loadAccountsFromEnv(projectRoot) {
    loadEnvFile(projectRoot)
    return loadAccountSettings(process.env, message => log('WARN', message))
}

export function findAccountByEmail(accounts, email) {
    if (!email || typeof email !== 'string') return null
    return (
        accounts.find(a => a?.email && typeof a.email === 'string' && a.email.toLowerCase() === email.toLowerCase()) ||
        null
    )
}

// 工具脚本账号查找: env 账号优先, 面板管理的动态账号(config/accounts.json)兜底。
// manualLogin(VNC)/体检/市场探测等工具在容器内运行时, 动态账号不在 env 中, 必须读文件。
export function findToolAccount(projectRoot, email) {
    if (!email || typeof email !== 'string') return null
    const envAccounts = loadAccountsFromEnv(projectRoot)
    const envHit = findAccountByEmail(envAccounts, email)
    if (envHit) return envHit
    try {
        const list = JSON.parse(fs.readFileSync(path.join(getProjectRoot(), 'config', 'accounts.json'), 'utf8'))
        if (!Array.isArray(list)) return null
        const raw = list.find(
            x => x && String(x.email || '').toLowerCase() === String(email).toLowerCase() && x.removed !== true
        )
        if (!raw) return null
        return {
            email: String(raw.email).trim(),
            password: typeof raw.password === 'string' ? raw.password : '',
            totpSecret: typeof raw.totpSecret === 'string' ? raw.totpSecret : undefined,
            recoveryEmail: typeof raw.recoveryEmail === 'string' ? raw.recoveryEmail : '',
            geoLocale: typeof raw.geoLocale === 'string' ? raw.geoLocale : 'CN',
            langCode: typeof raw.langCode === 'string' ? raw.langCode : 'zh-CN',
            proxy: null,
            saveFingerprint: { mobile: false, desktop: false }
        }
    } catch {
        return null
    }
}

export function setupCleanupHandlers(cleanupFn) {
    const cleanup = async () => {
        try {
            await cleanupFn()
        } catch (error) {
            log('ERROR', 'Cleanup failed:', error.message)
        }
        process.exit(0)
    }

    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)
}

export function loadSessionRow(db, email, platform) {
    const row = db
        .prepare(
            'SELECT storage_state, fingerprint, updated_at FROM sessions WHERE email = ? COLLATE NOCASE AND platform = ? ORDER BY updated_at DESC LIMIT 1'
        )
        .get(email, platform)

    if (!row) return null

    return {
        storageState: row.storage_state ? JSON.parse(row.storage_state) : null,
        fingerprint: row.fingerprint ? JSON.parse(row.fingerprint) : null,
        updatedAt: row.updated_at
    }
}

export function loadResolvedRegionRow(db, email) {
    try {
        const row = db.prepare('SELECT resolved_region FROM account_metadata WHERE email = ?').get(email)
        return row?.resolved_region ?? undefined
    } catch {
        return undefined
    }
}

export function saveSessionRow(db, email, platform, storageState, fingerprint, persistFingerprint = true) {
    if (platform !== 'mobile' && platform !== 'desktop') {
        throw new Error(`Unsupported session platform: ${platform}`)
    }
    if (!storageState || !Array.isArray(storageState.cookies) || !Array.isArray(storageState.origins)) {
        throw new Error('Cannot save an invalid browser storage state')
    }

    const nowSeconds = Date.now() / 1000
    const sanitizedState = {
        ...storageState,
        cookies: storageState.cookies.filter(
            cookie => cookie.expires === -1 || !Number.isFinite(cookie.expires) || cookie.expires > nowSeconds
        )
    }

    if (persistFingerprint) {
        db.prepare(
            `INSERT INTO sessions (email, platform, storage_state, fingerprint, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(email, platform)
             DO UPDATE SET
                 storage_state = excluded.storage_state,
                 fingerprint = excluded.fingerprint,
                 updated_at = excluded.updated_at`
        ).run(
            email,
            platform,
            JSON.stringify(sanitizedState),
            fingerprint ? JSON.stringify(fingerprint) : null,
            Date.now()
        )
        return
    }

    db.prepare(
        `INSERT INTO sessions (email, platform, storage_state, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(email, platform)
         DO UPDATE SET
             storage_state = excluded.storage_state,
             updated_at = excluded.updated_at`
    ).run(email, platform, JSON.stringify(sanitizedState), Date.now())
}

export function listSessionRows(db) {
    return db.prepare('SELECT email, platform, updated_at FROM sessions ORDER BY email, platform').all()
}
