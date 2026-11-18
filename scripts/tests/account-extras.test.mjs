/**
 * 动态账号覆盖层 applyAccountExtras 单元测试（ESM）。
 * 运行: node --test scripts/tests/account-extras.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyAccountExtras } from '../../dist/control-api/accounts.js'

const envAccount = (email, slot = 1) => ({
    index: slot,
    email,
    emailKey: email,
    geoLocale: 'US',
    langCode: 'en',
    hasRecoveryEmail: false,
    hasTotp: false,
    proxy: null
})

test('removed 条目把同邮箱 env 账号移出运行名单', () => {
    const accounts = [envAccount('a@x.com'), envAccount('b@x.com', 2)]
    const extras = [{ email: 'a@x.com', removed: true }]
    const result = applyAccountExtras(accounts, extras)
    assert.deepEqual(
        result.map(a => a.email),
        ['b@x.com']
    )
})

test('同邮箱动态条目覆盖 env 账号属性（不重复追加）', () => {
    const accounts = [envAccount('a@x.com')]
    const extras = [{ email: 'a@x.com', geoLocale: 'CN', totpSecret: 'SECRET' }]
    const result = applyAccountExtras(accounts, extras)
    assert.equal(result.length, 1)
    assert.equal(result[0].geoLocale, 'CN')
    assert.equal(result[0].hasTotp, true)
    assert.equal(result[0].extra, undefined)
})

test('独立动态条目以 901 起始槽位追加并标记 extra', () => {
    const accounts = [envAccount('a@x.com')]
    const extras = [{ email: 'dyn@x.com', password: 'p' }]
    const result = applyAccountExtras(accounts, extras)
    assert.equal(result.length, 2)
    const extra = result[1]
    assert.equal(extra.index, 901)
    assert.equal(extra.extra, true)
    assert.equal(extra.email, 'dyn@x.com')
})

test('removed 的动态条目自身也不追加', () => {
    const accounts = [envAccount('a@x.com')]
    const extras = [{ email: 'gone@x.com', removed: true }]
    const result = applyAccountExtras(accounts, extras)
    assert.equal(result.length, 1)
})

test('空 extras 原样返回全部账号', () => {
    const accounts = [envAccount('a@x.com'), envAccount('b@x.com', 2)]
    const result = applyAccountExtras(accounts, [])
    assert.equal(result.length, 2)
})
