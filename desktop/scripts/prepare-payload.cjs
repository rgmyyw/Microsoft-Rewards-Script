#!/usr/bin/env node
'use strict'
/**
 * 组装 electron-builder 的 extraResources/payload（desktop/payload/）：
 * 把主工程的代码与构建产物复制为只读负载，首启时由向导同步到 userData/app。
 *
 * 注意：payload 不含 node_modules（平台相关且体积大），安装版首启会自动 npm install。
 * 如需离线安装版：先在主工程 npm install && npm run build，再可选把 Node 24 二进制
 * 放到 desktop/runtime/<win: node.exe | unix: runtime/bin/node>，重跑本脚本 + npm run dist。
 */

const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')
const payloadDir = path.join(__dirname, '..', 'payload')

const FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'env.example', 'config.example.json', 'README.md']
const DIRS = ['src', 'scripts', 'dashboard', 'dist']
const SCRIPT_EXCLUDE = /\.(test|spec)\.js$/

function copyDir(src, dest, filter) {
    fs.cpSync(src, dest, {
        recursive: true,
        force: true,
        filter: filter
            ? entry => {
                  const rel = path.relative(src, entry)
                  if (/^(node_modules|\.git)(\/|$)/.test(rel)) return false
                  if (SCRIPT_EXCLUDE.test(path.basename(entry))) return false
                  return true
              }
            : undefined
    })
}

fs.rmSync(payloadDir, { recursive: true, force: true })
fs.mkdirSync(payloadDir, { recursive: true })

for (const name of FILES) {
    const src = path.join(repoRoot, name)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(payloadDir, name))
}

for (const name of DIRS) {
    const src = path.join(repoRoot, name)
    if (!fs.existsSync(src)) {
        if (name === 'dist') continue // 未构建时由向导负责构建
        console.error(`[prepare-payload] 缺少目录: ${name}`)
        process.exit(1)
    }
    copyDir(src, path.join(payloadDir, name), name === 'scripts')
}

// 打包内置 Node 24 sidecar（可选）：desktop/runtime/{node.exe 或 bin/node} -> payload-runtime/
// electron-builder 的 extraResources 源目录必须存在，这里固定生成（无 sidecar 时为空目录）
const runtimeSrc = path.join(__dirname, '..', 'runtime')
const runtimeDest = path.join(__dirname, '..', 'payload-runtime')
fs.rmSync(runtimeDest, { recursive: true, force: true })
if (fs.existsSync(runtimeSrc)) fs.cpSync(runtimeSrc, runtimeDest, { recursive: true, force: true })
else fs.mkdirSync(runtimeDest, { recursive: true })

console.log(`[prepare-payload] payload 组装完成: ${payloadDir}`)
for (const name of fs.readdirSync(payloadDir)) console.log('  -', name)
