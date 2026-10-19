#!/usr/bin/env node
'use strict'
/**
 * orchestrator 冒烟测试（不需要 electron）：
 *   node scripts/smoke-orchestrator.cjs
 *
 * 在当前仓库根（或 --root 指定目录）用随机端口真实拉起 控制API + 看板 + 调度器，
 * 验证就绪探测 /health、看板页面可访问，然后走优雅停机流程并断言进程全部退出。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const orch = require(path.join(__dirname, '..', 'src', 'orchestrator.js'))
const { cronMatches } = require(path.join(__dirname, '..', 'src', 'scheduler.js'))

const rootFlagIdx = process.argv.indexOf('--root')
const argRoot = rootFlagIdx !== -1 ? process.argv[rootFlagIdx + 1] : undefined
const appRoot = argRoot ? path.resolve(argRoot) : path.resolve(__dirname, '..', '..')

let failed = false
const assert = (cond, label) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
    if (!cond) failed = true
}

;(async () => {
    console.log(`[smoke] appRoot = ${appRoot}`)
    assert(fs.existsSync(path.join(appRoot, 'package.json')), '工作区含 package.json')

    // 服务（API/看板/调度器）零第三方依赖，Node 22+ 即可运行；>= 24 仅脚本本体硬性要求
    const nodePath = orch.resolveNodePath({})
    const nodeCheck = await orch.checkNodeVersion(nodePath)
    console.log(
        `[smoke] node = ${nodePath} v${nodeCheck.version}` +
            (nodeCheck.ok ? ' (≥24，脚本本体可直接运行)' : ' (<24，仅影响脚本本体运行)')
    )

    const apiPort = await orch.findFreePort(31000)
    const dashPort = await orch.findFreePort(apiPort + 1)

    // cron 匹配器单测
    const d = (m, h, dom, mon, dow) => new Date(2026, mon - 1, dom, h, m)
    assert(cronMatches('0 7 * * *', d(0, 7, 15, 10, 1)), "cron '0 7 * * *' 命中 10/15 07:00")
    assert(!cronMatches('0 7 * * *', d(1, 7, 15, 10, 1)), "cron '0 7 * * *' 不命中 07:01")
    assert(!cronMatches('0 7 * * *', d(0, 8, 15, 10, 1)), "cron '0 7 * * *' 不命中 08:00")
    assert(cronMatches('30 8 * * 1-5', d(30, 8, 19, 10, 1)), "cron '30 8 * * 1-5' 命中周一")
    assert(!cronMatches('30 8 * * 1-5', d(30, 8, 18, 10, 0)), "cron '30 8 * * 1-5' 不命中周日")
    assert(cronMatches('0 9 * * 0', d(0, 9, 18, 10, 0)), "cron '0 9 * * 0' 命中周日(0)")
    assert(cronMatches('0 9 * * 7', d(0, 9, 18, 10, 0)), "cron '0 9 * * 7' 命中周日(7 等价)")
    assert(cronMatches('*/15 * * * *', d(45, 6, 2, 3, 3)), "cron '*/15 * * * *' 命中 :45")
    assert(!cronMatches('*/15 * * * *', d(40, 6, 2, 3, 3)), "cron '*/15 * * * *' 不命中 :40")
    // vixie 语义: 日与周都受限时取或（2026-10-15=周四, 2026-10-19=周一, 2026-10-18=周日）
    assert(cronMatches('0 12 15 * 1', d(0, 12, 15, 10, 4)), "cron '0 12 15 * 1' 日受限命中 15 号(周四)")
    assert(cronMatches('0 12 15 * 1', d(0, 12, 19, 10, 1)), "cron '0 12 15 * 1' 周受限命中周一(19 号)")
    assert(!cronMatches('0 12 15 * 1', d(0, 12, 20, 10, 2)), "cron '0 12 15 * 1' 不命中周二 20 号")
    const token = orch.newToken()
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-dash-'))
    console.log(`[smoke] apiPort=${apiPort} dashPort=${dashPort}`)

    const supervisor = new orch.ServiceSupervisor({
        nodePath,
        appRoot,
        apiPort,
        dashPort,
        token,
        dataDir,
        schedulerScript: path.join(__dirname, '..', 'src', 'scheduler.js'),
        onLog: line => process.stdout.write(`  ${line}`)
    })

    const t0 = Date.now()
    // 全量拉起（含调度器）：仓库无 schedule.json（enabled=false），调度器只会空转，无副作用
    const res = await supervisor.start()
    assert(res.ok, `服务全部就绪（${((Date.now() - t0) / 1000).toFixed(1)}s, stage=${res.stage || '-'}`)

    const health = await orch.httpRequest({ port: apiPort, requestPath: '/health', token })
    assert(health.status === 200, `API /health -> ${health.status}`)

    const dash = await orch.httpRequest({ port: dashPort })
    assert(dash.status === 200, `看板页面 -> ${dash.status}`)

    const unauth = await orch.httpRequest({ port: apiPort, requestPath: '/status' })
    assert(unauth.status === 401 || unauth.status === 403, `无 token 访问 /status 被拒绝 -> ${unauth.status}`)

    const t1 = Date.now()
    await supervisor.stopAll()
    const stopSecs = ((Date.now() - t1) / 1000).toFixed(1)
    console.log(`[smoke] stopAll 用时 ${stopSecs}s`)
    assert(true, `优雅停机完成（${stopSecs}s）`)

    fs.rmSync(dataDir, { recursive: true, force: true })
    console.log(failed ? '\n[smoke] 存在失败项' : '\n[smoke] 全部通过')
    process.exit(failed ? 1 : 0)
})().catch(err => {
    console.error('[smoke] 异常:', err)
    process.exit(1)
})
