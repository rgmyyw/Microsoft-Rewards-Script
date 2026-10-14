// Regression test for targeted-run selection: Load.loadAccounts() must honor
// ACCOUNTS_DYNAMIC_DISABLED=1 and skip the config/accounts.json merge, otherwise
// the control API's selection env is defeated and a targeted run becomes a
// full run (2026-10-14).
//
// Run: node -r ts-node/register/transpile-only --test scripts/tests/loadAccountsSelection.test.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const repoRoot = path.resolve(__dirname, '../..')

function withTempProject(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-load-'))
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'msr-test' }))
    fs.mkdirSync(path.join(tmp, 'config'))
    fs.writeFileSync(
        path.join(tmp, 'config', 'accounts.json'),
        JSON.stringify([{ email: 'extra@example.com', password: 'extra-pass', geoLocale: 'cn' }])
    )
    const prevCwd = process.cwd()
    const savedEnv = { ...process.env }
    process.chdir(tmp)
    // Load.ts caches nothing across calls for env loading beyond `envLoaded`
    // (a no-op when no .env exists), so a fresh require per scenario is enough.
    try {
        fn(tmp, () => require(path.join(repoRoot, 'src', 'util', 'Load.ts')))
    } finally {
        process.chdir(prevCwd)
        for (const key of Object.keys(process.env)) {
            if (!(key in savedEnv)) delete process.env[key]
            else process.env[key] = savedEnv[key]
        }
        fs.rmSync(tmp, { recursive: true, force: true })
    }
}

function setEnvAccount() {
    process.env.ACCOUNT_1_EMAIL = 'envuser@example.com'
    process.env.ACCOUNT_1_PASSWORD = 'env-pass'
    process.env.ACCOUNT_1_GEO_LOCALE = 'CN'
}

test('without the flag, extras merge on top of env accounts (documents the old full-run behavior)', () => {
    withTempProject((_tmp, load) => {
        setEnvAccount()
        const accounts = load().loadAccounts()
        assert.deepEqual(
            accounts.map(a => a.email),
            ['envuser@example.com', 'extra@example.com']
        )
    })
})

test('with ACCOUNTS_DYNAMIC_DISABLED=1, only env accounts are used', () => {
    withTempProject((_tmp, load) => {
        setEnvAccount()
        process.env.ACCOUNTS_DYNAMIC_DISABLED = '1'
        const accounts = load().loadAccounts()
        assert.deepEqual(
            accounts.map(a => a.email),
            ['envuser@example.com']
        )
        assert.equal(accounts[0].geoLocale, 'CN')
    })
})

test('without env accounts and without the flag, extras alone still load (plain full run)', () => {
    withTempProject((_tmp, load) => {
        const accounts = load().loadAccounts()
        assert.deepEqual(
            accounts.map(a => a.email),
            ['extra@example.com']
        )
    })
})
