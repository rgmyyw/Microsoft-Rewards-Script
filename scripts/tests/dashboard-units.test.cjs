'use strict'
// dashboard/lib/core.js 单元测试（node --test）
// 运行: node --test scripts/tests/dashboard-units.test.cjs

const test = require('node:test')
const assert = require('node:assert')
const { esc, isValidEmail } = require('../../dashboard/lib/core.js')

test('esc: 转义 HTML 特殊字符', () => {
    assert.strictEqual(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;')
})

test('esc: 转义引号与 &', () => {
    assert.strictEqual(esc('a & "b" < c'), 'a &amp; &quot;b&quot; &lt; c')
})

test('esc: 中文与普通文本原样保留', () => {
    assert.strictEqual(esc('账户完成: a@b.com'), '账户完成: a@b.com')
})

test('esc: null/undefined → 空串', () => {
    assert.strictEqual(esc(null), '')
    assert.strictEqual(esc(undefined), '')
})

test('esc: 数字转字符串', () => {
    assert.strictEqual(esc(12345), '12345')
})

test('isValidEmail: 合法邮箱通过', () => {
    assert.strictEqual(isValidEmail('user@example.com'), true)
    assert.strictEqual(isValidEmail('first.last+tag@sub.domain.io'), true)
})

test('isValidEmail: -- 开头的参数注入被拒绝', () => {
    assert.strictEqual(isValidEmail('--help'), false)
    assert.strictEqual(isValidEmail('--version'), false)
})

test('isValidEmail: 非法形态被拒绝', () => {
    assert.strictEqual(isValidEmail(''), false)
    assert.strictEqual(isValidEmail('no-at-sign'), false)
    assert.strictEqual(isValidEmail('a b@c.com'), false) // 含空白
    assert.strictEqual(isValidEmail('a@b'), false) // 缺 TLD
    assert.strictEqual(isValidEmail(null), false)
    assert.strictEqual(isValidEmail(123), false)
})
