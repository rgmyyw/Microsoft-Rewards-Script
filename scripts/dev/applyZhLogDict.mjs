#!/usr/bin/env node
/**
 * 汉化重套工具（V4-china → v5 架构）。
 *
 * 用法：
 *   node scripts/dev/applyZhLogDict.mjs --dry     # 只统计，不改文件
 *   node scripts/dev/applyZhLogDict.mjs           # 应用替换
 *
 * 规则：
 *   1. 完整字面量精确匹配（zh-log-dictionary.json，键=旧英文串全文）
 *   2. F2 前缀映射（面板解析依赖的前导短语；字段名保持英文以兼容面板正则）
 * 只替换引号/模板字符串内部的文本，永不触碰标识符、路径与代码结构。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dry = process.argv.includes('--dry')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dict = JSON.parse(fs.readFileSync(path.join(root, 'scripts/dev/zh-log-dictionary.json'), 'utf8'))

// F2 契约前缀映射：面板 extractField 依赖的前导短语（字段名保持英文）
const PREFIX_MAP = [
    ['Starting account: ', '开始处理账户: '],
    ['Finished account: ', '账户完成: '],
    ['Completed all accounts', '全部账户已完成'],
    ['Run interrupted', '运行被中断']
]

function* walkTs(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            if (['node_modules', 'dist', 'diagnostics', 'sessions'].includes(entry.name)) continue
            yield* walkTs(full)
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
            yield full
        }
    }
}

// 提取一段文本中的字符串字面量 token（返回 [{quote, start, end, content}]）
function findLiterals(text) {
    const out = []
    const re = /`((?:[^`\\]|\\.)*)`|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g
    let m
    while ((m = re.exec(text))) {
        const quote = m[0][0]
        out.push({ quote, start: m.index, end: m.index + m[0].length, content: m[1] ?? m[2] ?? m[3] })
    }
    return out
}

let filesChanged = 0
let exactHits = 0
let prefixHits = 0
const prefixUsed = new Map()

for (const file of walkTs(path.join(root, 'src'))) {
    const original = fs.readFileSync(file, 'utf8')
    let text = original

    // 逐字面量处理（从后往前替换，保持索引稳定）
    const literals = findLiterals(text)
    for (let i = literals.length - 1; i >= 0; i--) {
        const { quote, start, end, content } = literals[i]
        const key = quote === '`' ? 'bt' : quote === "'" ? 'sq' : 'dq'
        let next = null

        if (dict[key]?.[content] !== undefined) {
            next = dict[key][content]
            exactHits++
        } else if (quote === '`') {
            for (const [prefix, zh] of PREFIX_MAP) {
                if (content.startsWith(prefix)) {
                    next = zh + content.slice(prefix.length)
                    prefixHits++
                    prefixUsed.set(prefix, (prefixUsed.get(prefix) ?? 0) + 1)
                    break
                }
            }
        }

        if (next !== null && next !== content) {
            text = text.slice(0, start + 1) + next + text.slice(end - 1)
        }
    }

    if (text !== original && !dry) {
        fs.writeFileSync(file, text, 'utf8')
    }
    if (text !== original) filesChanged++
}

console.log(`mode=${dry ? 'DRY' : 'APPLY'} | filesChanged=${filesChanged} | exact=${exactHits} | prefix=${prefixHits}`)
for (const [p, n] of prefixUsed) console.log(`  prefix "${p}" x${n}`)
if (!dry) {
    const covered = exactHits
    const total = Object.values(dict).reduce((s, m) => s + Object.keys(m).length, 0)
    console.log(`覆盖率（本次命中/字典总键数）: ${covered}/${total}（同键多处命中会重复计数）`)
}
