import fs from 'node:fs'
import path from 'node:path'
import { getProjectRoot, resolveProjectFile, loadEnvFile } from '../../scripts/lib/projectFiles.cjs'
import { loadAccountSettings, envBool } from '../../scripts/lib/env.js'

import type { Account } from '../core/Account'
import type { Config } from './Config'
import { validateAccounts } from './Validator'
import { resolveConfigOverrides } from './ConfigEnvOverrides'
import { logSystemMessage } from '../logging/LogEvent'

let configCache: Config
let envLoaded = false

function ensureEnvLoaded(): void {
    if (envLoaded) return
    envLoaded = true
    loadEnvFile(getProjectRoot(__dirname))
}

// Dashboard-managed extras act as an override layer: same email patches
// the env account (e.g. password rotation), otherwise it is appended.
// Selection runs (single-account / excluded-list) bake the exact roster
// into env and set ACCOUNTS_DYNAMIC_DISABLED=1; merging here would
// re-append the excluded dynamic accounts and turn the targeted run
// into a full run.
function loadExtraRemovedEmails(): string[] {
    const filePath = path.join(getProjectRoot(), 'config', 'accounts.json')
    try {
        if (!fs.existsSync(filePath)) return []
        const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        if (!Array.isArray(parsed)) return []
        return parsed
            .filter(
                (entry): entry is Record<string, unknown> =>
                    Boolean(entry) &&
                    (entry as { removed?: unknown }).removed === true &&
                    typeof (entry as { email?: unknown }).email === 'string'
            )
            .map(entry => String(entry.email).trim().toLowerCase())
    } catch {
        return []
    }
}

// Dashboard-managed dynamic accounts (config/accounts.json), picked up by
// every new run process without a container restart. Env accounts keep priority.
function loadExtraAccounts(): Account[] {
    const filePath = path.join(getProjectRoot(), 'config', 'accounts.json')
    try {
        if (!fs.existsSync(filePath)) return []
        const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        if (!Array.isArray(parsed)) return []
        return parsed
            .filter(
                (entry): entry is Record<string, unknown> =>
                    Boolean(entry) &&
                    typeof (entry as { email?: unknown }).email === 'string' &&
                    (entry as { removed?: unknown }).removed !== true
            )
            .map(entry => ({
                email: String(entry.email).trim(),
                password: typeof entry.password === 'string' ? entry.password : '',
                totpSecret: typeof entry.totpSecret === 'string' ? entry.totpSecret : undefined,
                recoveryEmail: typeof entry.recoveryEmail === 'string' ? entry.recoveryEmail : '',
                geoLocale: typeof entry.geoLocale === 'string' ? entry.geoLocale : 'auto',
                langCode: typeof entry.langCode === 'string' ? entry.langCode : 'en',
                proxy: { proxyHttp: false, url: '', port: 0, username: '', password: '' },
                saveFingerprint: { mobile: false, desktop: false }
            }))
    } catch {
        return []
    }
}

export function loadAccounts(): Account[] {
    ensureEnvLoaded()
    const accounts = loadAccountSettings(process.env, message => logSystemMessage('warn', 'ACCOUNTS', message))

    // Dashboard-managed dynamic accounts (config/accounts.json), 免重启生效
    if (!envBool('ACCOUNTS_DYNAMIC_DISABLED', false)) {
        const extras = loadExtraAccounts()
        const removed = new Set(loadExtraRemovedEmails())
        const kept: Account[] = []
        for (const account of accounts) {
            if (removed.has(account.email.toLowerCase())) continue
            const override = extras.find(e => e.email.toLowerCase() === account.email.toLowerCase())
            if (override) {
                if (override.password) account.password = override.password
                if (override.geoLocale !== 'auto') account.geoLocale = override.geoLocale
                if (override.langCode !== 'en') account.langCode = override.langCode
                if (override.totpSecret) account.totpSecret = override.totpSecret
                if (override.recoveryEmail) account.recoveryEmail = override.recoveryEmail
            }
            kept.push(account)
        }
        accounts.length = 0
        accounts.push(...kept)
        for (const extra of extras) {
            if (!accounts.some(a => a.email.toLowerCase() === extra.email.toLowerCase())) {
                accounts.push(extra)
            }
        }
    }

    if (!accounts.length)
        throw new Error('No accounts found in environment. Set at least one ACCOUNT_N_EMAIL (see env.example).')
    return validateAccounts(accounts)
}

export function loadConfig(): Config {
    try {
        if (configCache) {
            return configCache
        }

        // Check root -> dist -> src (not in dist, but root)
        const configPath = resolveProjectFile('config.json', getProjectRoot(__dirname))
        if (!configPath) {
            throw new Error(
                'config.json not found - place it in the project root (dist/ and src/ are also searched as fallbacks)'
            )
        }
        const config = fs.readFileSync(configPath, 'utf-8')

        const unverifiedConfig = JSON.parse(config)
        ensureEnvLoaded()
        const configData = resolveConfigOverrides(unverifiedConfig)

        configCache = configData

        return configData
    } catch (error) {
        if (error instanceof Error) throw error
        throw new Error(String(error))
    }
}
