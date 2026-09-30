/**
 * 一键网络诊断: 确认 MSR 微软域流量全部直连(未走代理节点)。
 *
 * 原理(2026-09-30 实测):
 *   - OpenClash fake-ip 模式下微软域解析返回 198.18.x.x(流量进 Clash),
 *     由 overwrite.sh 基础直连段判 DIRECT;仅 cn.bing.com 等个别域在
 *     dnsmasq/nft 层绕过 Clash 返回真实国内 IP;
 *   - 因此"是否直连"的唯一权威判据 = Clash 连接表里微软域连接的 chain:
 *     [DIRECT] = 直连; 含代理节点 = 翻墙; 连接不进表 = nft 绕过(也是直连)。
 *
 * 流程: 逐个微软域发 HEAD/GET 制造真实流量, 期间多次拉 Clash /connections,
 * 汇总微软域连接的 chains + DNS 特征 + www.bing.com 落地旁证, 输出结论。
 *
 * Usage: node scripts/main/netDiag.js
 * 环境变量: CLASH_API_URL(默认 http://192.168.100.1:9090)、CLASH_API_SECRET
 * 最后一行: NETDIAG_RESULT {verdict,...}
 */

import dns from 'node:dns/promises'

import { getDirname, getProjectRoot, log } from '../utils.js'

const __dirname = getDirname(import.meta.url)
const projectRoot = getProjectRoot(__dirname)

const CLASH_API_URL = process.env.CLASH_API_URL || 'http://192.168.100.1:9090'
const CLASH_API_SECRET = process.env.CLASH_API_SECRET || ''

// MSR 全链路会访问的微软域(src/constants/urls.ts 实际域 + 登录链路伴生域)。
// client.msftauth.net 已删除: 该域 2026-09-30 实测 NXDOMAIN(微软弃用, 公共 DoH
// 与 Clash 上游一致), 脚本也不直接访问, 保留只会造成"不可达"误报。
const MS_DOMAINS = [
    'rewards.bing.com',
    'www.bing.com',
    'cn.bing.com',
    'api.bing.com',
    'login.live.com',
    'login.microsoftonline.com',
    'account.microsoft.com',
    'prod.rewardsplatform.microsoft.com',
    'www.msn.com',
    'www.bingapis.com',
    'login.windows.net'
]

// 已知例外(特意走代理、不算"意外翻墙"的域)——2026-09-30 起为空:
// account.microsoft.com 曾因直连被 Akamai 拒(TLS 后无响应)而单列业务专用组,
// 用户明示"微软所有域一律直连"后已在 overwrite.sh 删除该单列规则, 归并入
// DOMAIN-SUFFIX,microsoft.com(常态 DIRECT, redeem-mode 时随微软全域切香港)。
const KNOWN_PROXIED_DOMAINS = []

// 连接表里微软域的匹配词(覆盖目标 host 与 sniffHost)
const MS_MATCHERS = ['bing.com', 'bingapis.com', 'microsoft', 'msn.com', 'msftauth.net', 'live.com', 'windows.net', 'live.net']

const FAKE_IP_RE = /^198\.1[89]\./

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'

async function fetchClashConnections() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
        const res = await fetch(CLASH_API_URL + '/connections', {
            headers: CLASH_API_SECRET ? { Authorization: 'Bearer ' + CLASH_API_SECRET } : {},
            signal: controller.signal
        })
        clearTimeout(timer)
        if (!res.ok) return { error: 'Clash API HTTP ' + res.status }
        return { data: await res.json() }
    } catch (error) {
        clearTimeout(timer)
        return { error: String(error?.message ?? error) }
    }
}

function pickMsConnections(conns) {
    const out = []
    for (const c of conns || []) {
        const md = c.metadata || {}
        const host = String(md.host || md.sniffHost || '').toLowerCase()
        const dst = String(md.destinationIP || '')
        const target = host || dst
        if (!target) continue
        if (!MS_MATCHERS.some(m => target.includes(m))) continue
        // 按域聚合: 同域同链只记一次, 计数
        const chains = c.chains || []
        out.push({ host: host || dst, chains, direct: chains.length === 1 && chains[0] === 'DIRECT' })
    }
    return out
}

async function probeDomain(domain) {
    const result = { host: domain, reachable: null, finalHost: null, dns: null, dnsKind: null }
    try {
        const answers = await dns.resolve4(domain)
        result.dns = answers[0] || null
        result.dnsKind = answers[0] ? (FAKE_IP_RE.test(answers[0]) ? 'fake-ip' : 'real') : null
    } catch {
        result.dnsKind = 'resolve-failed'
    }
    try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 8000)
        const res = await fetch('https://' + domain + '/', {
            method: 'GET',
            redirect: 'follow',
            headers: { 'User-Agent': UA, Accept: 'text/html' },
            signal: controller.signal
        })
        clearTimeout(timer)
        // 读一小段就断开, 避免拉全页
        try { await res.body?.cancel() } catch { /* ignore */ }
        result.reachable = true
        result.status = res.status
        try { result.finalHost = new URL(res.url).hostname } catch { /* ignore */ }
    } catch (error) {
        // 4xx/5xx 不算不可达(fetch 不会因状态码抛错), 这里只有网络层错误
        result.reachable = false
        result.error = String(error?.message ?? error).slice(0, 80)
    }
    return result
}

async function main() {
    log('INFO', `网络诊断开始: ${MS_DOMAINS.length} 个微软域, Clash API ${CLASH_API_URL}`)

    const clashSeen = new Map() // host -> {chains, count, direct}
    let clashError = null
    let clashSamples = 0

    const sampleClash = async () => {
        const r = await fetchClashConnections()
        if (r.error) { clashError = r.error; return }
        clashSamples++
        for (const c of pickMsConnections(r.data?.connections)) {
            const key = c.host
            const prev = clashSeen.get(key)
            if (prev) prev.count++
            else clashSeen.set(key, { host: c.host, chains: c.chains, direct: c.direct, count: 1 })
        }
    }

    await sampleClash() // 基线(诊断前已存在的微软连接)

    const domains = []
    for (const d of MS_DOMAINS) {
        // 请求期间并发采样连接表: 流量发生时链路一定在表里(fake-ip 长连接 keep-alive 数秒)
        const sampling = Promise.all([sampleClash(), new Promise(r => setTimeout(r, 400)).then(sampleClash)])
        const r = await probeDomain(d)
        await sampling
        domains.push(r)
        log('INFO', `${d}: reachable=${r.reachable} dns=${r.dns ?? '?'}(${r.dnsKind})${r.finalHost && r.finalHost !== d ? ' → ' + r.finalHost : ''}`)
    }

    await new Promise(r => setTimeout(r, 1200))
    await sampleClash()

    const msConnections = [...clashSeen.values()]
    const proxied = msConnections.filter(c => !c.direct && !KNOWN_PROXIED_DOMAINS.includes(c.host))
    const knownExceptions = msConnections.filter(c => !c.direct && KNOWN_PROXIED_DOMAINS.includes(c.host))
    const directOnes = msConnections.filter(c => c.direct)

    // 结论:
    //   proxied  = 有微软域连接走代理节点(翻墙实锤)
    //   direct   = 微软连接全部 DIRECT(经 Clash 但直连)
    //   bypass   = Clash 表无微软连接(流量未经过 Clash, nft/dnsmasq 层直连)
    //   unknown  = Clash API 不可用, 仅有 DNS/可达性参考
    let verdict = 'unknown'
    if (clashError && !msConnections.length) {
        verdict = 'unknown'
    } else if (proxied.length) {
        verdict = 'proxied'
    } else if (directOnes.length) {
        verdict = 'direct'
    } else {
        verdict = 'bypass'
    }

    const payload = {
        verdict,
        clashApi: { url: CLASH_API_URL, ok: !clashError, error: clashError, samples: clashSamples },
        domains,
        msConnections: msConnections.map(c => ({ host: c.host, chains: c.chains, count: c.count })),
        proxied: proxied.map(c => ({ host: c.host, chains: c.chains })),
        knownExceptions: knownExceptions.map(c => ({ host: c.host, chains: c.chains })),
        checkedAt: Date.now()
    }
    const verdictText = { proxied: '发现意外代理流量', direct: '全部直连(经 Clash DIRECT 出站)', bypass: '全部直连(未经过 Clash, 绕过规则直连)', unknown: '无法判定(Clash API 不可用)' }
    log('INFO', `网络诊断结论: ${verdict} = ${verdictText[verdict] || verdict}`
        + (proxied.length ? ' | 翻墙连接: ' + proxied.map(c => c.host + '@' + c.chains.join('/')).join(', ') : '')
        + (knownExceptions.length ? ' | 已知例外(节点): ' + knownExceptions.map(c => c.host).join(', ') : ''))
    console.log('NETDIAG_RESULT ' + JSON.stringify(payload))
}

main().catch(error => {
    log('ERROR', error.message)
    process.exit(1)
})
