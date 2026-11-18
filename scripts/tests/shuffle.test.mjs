/**
 * v5 utils.shuffleArray 单元测试（元素集不变断言）。
 * 运行: node --test scripts/tests/shuffle.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import UtilsModule from '../../dist/util/Utils.js'

// dist 为 CJS 输出时 default 挂在模块对象上；ESM 时即类本身
const Utils = UtilsModule.default ?? UtilsModule
const utils = new Utils()

test('shuffleArray: 元素集不变（100 次迭代）', () => {
    const original = Array.from({ length: 50 }, (_, i) => i + 1)
    const expectedSet = [...original].sort((a, b) => a - b).join(',')
    for (let i = 0; i < 100; i++) {
        const copy = [...original]
        utils.shuffleArray(copy)
        assert.equal(copy.length, original.length)
        assert.equal([...copy].sort((a, b) => a - b).join(','), expectedSet)
    }
})

test('shuffleArray: 空数组与单元素安全', () => {
    assert.deepEqual(utils.shuffleArray([]), [])
    assert.deepEqual(utils.shuffleArray([42]), [42])
})
