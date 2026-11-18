'use strict'
// 汉化字典完整性测试 + dry-run 输出格式断言
// 运行: node --test scripts/tests/zh-dict.test.cjs
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../..')
const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/dev/zh-log-dictionary.json'), 'utf8'))

test('字典三种引号类型存在且为对象', () => {
    for (const kind of ['bt', 'sq', 'dq']) {
        assert.equal(typeof dict[kind], 'object')
        assert.ok(!Array.isArray(dict[kind]))
    }
})

test('键值均非空，值含中文，键不含中文', () => {
    let count = 0
    for (const m of Object.values(dict)) {
        for (const [en, zh] of Object.entries(m)) {
            count++
            assert.ok(en.trim().length > 0)
            assert.ok(zh.trim().length > 0)
            assert.match(zh, /[\u4e00-\u9fff]/)
            assert.doesNotMatch(en, /[\u4e00-\u9fff]/)
        }
    }
    assert.ok(count > 400, `字典键数应 >400，实际 ${count}`)
})

test('键不含代码特征（函数体/声明形态）', () => {
    for (const m of Object.values(dict)) {
        for (const en of Object.keys(m)) {
            // 日志文本可合法包含 "=>"（如 map 回调片段截断）；只拦真正的代码声明形态
            assert.doesNotMatch(en, /^function |^\s*const |=>\s*\{\s*$/)
        }
    }
})

test('--dry 模式运行成功并输出统计', () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/dev/applyZhLogDict.mjs'), '--dry'], {
        cwd: ROOT,
        encoding: 'utf8'
    })
    assert.match(out, /mode=DRY/)
    assert.match(out, /filesChanged=\d+/)
    assert.match(out, /exact=\d+/)
})
