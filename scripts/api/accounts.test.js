import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { buildExcludedAccountsEnv, buildSingleAccountEnv } from './accounts.js'

function envAccountsEnv(count) {
    const env = {}
    for (let i = 1; i <= count; i++) {
        env[`ACCOUNT_${i}_EMAIL`] = `user${i}@example.com`
        env[`ACCOUNT_${i}_PASSWORD`] = `pass${i}`
        env[`ACCOUNT_${i}_GEO_LOCALE`] = 'CN'
    }
    return env
}

test('single env-account selection blanks other slots and sets the dynamic-disabled flag', () => {
    const { env, account } = buildSingleAccountEnv(2, envAccountsEnv(3))

    assert.deepEqual(account, { index: 2, email: 'user2@example.com' })
    assert.equal(env.ACCOUNT_1_EMAIL, 'user2@example.com')
    assert.equal(env.ACCOUNT_1_PASSWORD, 'pass2')
    assert.equal(env.ACCOUNT_1_GEO_LOCALE, 'CN')
    assert.equal(env.ACCOUNT_2_EMAIL, '')
    assert.equal(env.ACCOUNT_3_EMAIL, '')
    assert.equal(env.ACCOUNTS_DYNAMIC_DISABLED, '1')
})

test('single extra-account selection remaps to slot 1 and sets the flag', () => {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
    const configDir = path.join(repoRoot, 'config')
    const configFile = path.join(configDir, 'accounts.json')
    const prevFile = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
        configFile,
        JSON.stringify([{ email: 'extra@example.com', password: 'extra-pass', geoLocale: 'cn' }])
    )
    try {
        const { env, account } = buildSingleAccountEnv(901, {})

        assert.deepEqual(account, { index: 901, email: 'extra@example.com' })
        assert.equal(env.ACCOUNT_1_EMAIL, 'extra@example.com')
        assert.equal(env.ACCOUNT_1_PASSWORD, 'extra-pass')
        assert.equal(env.ACCOUNT_1_GEO_LOCALE, 'cn')
        assert.equal(env.ACCOUNTS_DYNAMIC_DISABLED, '1')
    } finally {
        if (prevFile === null) fs.rmSync(configFile)
        else fs.writeFileSync(configFile, prevFile)
    }
})

test('excluded-list selection keeps only included accounts and sets the flag', () => {
    const { env, excludedAccounts, includedAccounts } = buildExcludedAccountsEnv([2], envAccountsEnv(3))

    assert.deepEqual(includedAccounts.map(a => a.email), ['user1@example.com', 'user3@example.com'])
    assert.deepEqual(excludedAccounts.map(a => a.email), ['user2@example.com'])
    assert.equal(env.ACCOUNT_1_EMAIL, 'user1@example.com')
    assert.equal(env.ACCOUNT_2_EMAIL, 'user3@example.com')
    assert.equal(env.ACCOUNT_3_EMAIL, '') // surplus slot blanked
    assert.equal(env.ACCOUNTS_DYNAMIC_DISABLED, '1')
})

test('excluded-list selection rejects unknown indexes', () => {
    assert.throws(() => buildExcludedAccountsEnv([99], envAccountsEnv(2)), /Unknown account slot/)
})
