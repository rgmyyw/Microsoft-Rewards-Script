#!/usr/bin/env node
/**
 * MS-Rewards 积分仪表盘(容器内嵌版) + 钉钉推送
 *
 * 与脚本同容器运行(entrypoint 在 API_MODE 下拉起本进程, 崩溃自动重启):
 *   - 消费本容器 control API (127.0.0.1:$API_PORT, Bearer token 由环境注入)
 *   - 订阅其 /events SSE, 按在线可配的事件开关推送钉钉
 *   - 自身提供 Web UI (:8300, 内网无鉴权): 账号积分总览 / 批量运行 / 推送配置弹窗 / 运行历史
 *   - 数据(push-config/state)落在 $DASHBOARD_DATA_DIR(默认 config/dashboard/), 随宿主卷持久化
 *
 * 零第三方依赖, 仅用 Node 内置模块。
 */
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const tls = require('tls');

// ============ 常量 ============
const BASE_DIR = __dirname;
// 数据目录: 容器内指向脚本 config/ 同卷子目录(持久化); 本地开发默认 dashboard/config
const CONFIG_DIR = process.env.DASHBOARD_DATA_DIR || path.join(BASE_DIR, '..', 'config', 'dashboard');
const PUSH_CONFIG_FILE = path.join(CONFIG_DIR, 'push-config.json');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');
// 兑换市场/账号区域探测结果(scripts/main/marketProbe.js 写入)
const MARKET_FILE = path.join(CONFIG_DIR, 'market.json');

const PORT = Number(process.env.DASHBOARD_PORT || 8300);
const API_PORT = Number(process.env.API_PORT || 3010);
const API_BASE = 'http://127.0.0.1:' + API_PORT;
const SSE_RECONNECT_MS = 5000;
const HISTORY_KEEP = 30; // dashboard 侧持久化的运行历史条数

// ============ 容器 API token(由容器环境注入) ============
let API_TOKEN = process.env.API_TOKEN || null;

// ============ 推送配置(在线可改) ============
function defaultPushConfig() {
  return {
    dingtalk: {
      enabled: true,
      accessToken: '',
      secret: '',
      keyword: 'MS-Rewards',
    },
    events: {
      runStart:     { enabled: true,  label: '🚀 开始运行' },
      runEnd:       { enabled: true,  label: '✅ 全部完成' },
      accountEnd:   { enabled: true,  label: '👤 账号完成' },
      error:        { enabled: true,  label: '❌ 错误' },
      loginFail:    { enabled: true,  label: '⚠️ 登录/风控异常' },
      dailySummary: { enabled: false, label: '📊 运行摘要' },
    },
    email: {
      enabled: false,
      smtpHost: 'smtp.qq.com',
      smtpPort: 465,
      user: '',
      pass: '',
      to: '',
    },
    dedupSeconds: 10,
    updatedAt: null,
  };
}

let pushConfig = null;
function loadPushConfig() {
  try {
    pushConfig = JSON.parse(fs.readFileSync(PUSH_CONFIG_FILE, 'utf8'));
  } catch (e) {
    pushConfig = defaultPushConfig();
    savePushConfig();
  }
}
function savePushConfig() {
  pushConfig.updatedAt = new Date().toISOString();
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(PUSH_CONFIG_FILE, JSON.stringify(pushConfig, null, 2));
    return true;
  } catch (e) {
    log('ERROR', '保存推送配置失败: ' + e.message);
    return false;
  }
}

// ============ 运行状态缓存(state.json 持久化) ============
let state = { accounts: {}, runs: [] };
function loadState() {
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {
    state = { accounts: {}, runs: [] };
  }
  if (!state.accounts) state.accounts = {};
  if (!state.runs) state.runs = [];
  // v2 一次性迁移: 旧格式 { collected, lastUpdateTs, success } → 新字段
  // (旧记录发生在今天才把 collected 计入今日获得; 迁移后删除旧字段, 保证只应用一次)
  if (state.v !== 2) {
    const t = todayStr();
    for (const em of Object.keys(state.accounts)) {
      const a = state.accounts[em];
      if (!a || typeof a !== 'object') continue;
      if (a.collected != null && a.lastUpdateTs) {
        const sameDay = new Date(a.lastUpdateTs + 8 * 3600e3).toISOString().slice(0, 10) === t;
        if (sameDay && !a.todayCollected) a.todayCollected = a.collected;
      }
      if (a.lastStatus == null && a.success != null) a.lastStatus = a.success ? 'success' : 'failed';
      delete a.collected;
      delete a.lastUpdateTs;
      delete a.success;
    }
    state.v = 2;
    saveState();
  }
  // v3 一次性迁移: 引入"当日余额锚点"(余额接口口径的今日获得), 用最近一次今天结束的运行
  // 反推各账号当日初始余额(初始 = 现余额 - 获得积分), 保证升级当天显示连续
  if (state.v === 2) {
    const t = todayStr();
    const lastRun = (state.runs || []).find(r => {
      const d = r && (r.endedAt || r.startedAt);
      return d && new Date(d + 8 * 3600e3).toISOString().slice(0, 10) === t;
    });
    for (const em of Object.keys(state.accounts)) {
      const a = state.accounts[em];
      if (!a || typeof a !== 'object' || a.dayStartDate != null) continue;
      a.dayStartDate = t;
      const ra = lastRun && (lastRun.accounts || []).find(x => x && x.email === em);
      if (ra && ra.balance != null && ra.gained != null) a.dayStartBalance = ra.balance - ra.gained;
      else if (a.balance != null) a.dayStartBalance = a.balance;
    }
    state.v = 3;
    saveState();
  }
}
function saveState() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { /* ignore */ }
}

// 今日(以 Asia/Shanghai 日期为准)获得的积分按账号持久化, 打开页面即见, 无需等运行
function todayStr() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}
function ensureAccount(email) {
  let a = state.accounts[email];
  if (!a || typeof a !== 'object') a = state.accounts[email] = { email };
  if (a.todayDate !== todayStr()) { a.todayDate = todayStr(); a.todayCollected = 0; }
  return a;
}
// ============ 兑换市场/账号区域探测结果(market.json) ============
// 市场字段含义: market=归属市场(兑换目录, "/redeem 切换回我的国家"链接优先);
// landing=本次 /redeem 落地市场(按出口 IP); service=flyout 当前服务区域;
// profile=getuserinfo 档案国家(多数账号被主接口拒, 可能为 null)
function loadMarketData() {
  try { return JSON.parse(fs.readFileSync(MARKET_FILE, 'utf8')); } catch (e) { return { accounts: {} }; }
}
// 余额观测统一入口(ACCOUNT-END / 体检 / overview 实时同步都走这里):
// 维护"当日余额锚点"(dayStartDate/dayStartBalance), "今日获得"优先按微软余额接口口径
// = 当前余额 - 当日锚点, 微软侧的一次性奖励/回收/调整都会如实反映, 不再依赖日志逐笔累计
function recordBalance(a, balance) {
  // 非正余额一律拒收: flyout 兜底接口对未登录视角会返回 200+0 分(2026-09-19 实测),
  // 一旦落库会把次日"当日起点余额"毒化为 0, "今日获得"变成全部余额
  if (balance == null || typeof balance !== 'number' || !(balance > 0)) return;
  const t = todayStr();
  if (a.dayStartDate !== t) {
    // 跨天(或首次观测): 用今天之前最后一次已知余额作当日锚点; 没有历史则用本次观测值
    a.dayStartDate = t;
    a.dayStartBalance = (a.balance != null && a.balanceTs != null) ? a.balance : balance;
  }
  a.balance = balance;
  a.balanceTs = Date.now();
}
// 日志事件 user 字段是邮箱本地部分(如 "37719093"), 无 @; 维护 本地部分 -> 完整邮箱 映射,
// 供消息体内不含邮箱的事件(CLAIM-BONUS-POINTS 等)归属账号
const tagEmail = new Map();
function registerTagEmail(email) {
  const em = String(email || '').trim();
  if (em && em.indexOf('@') > 0) tagEmail.set(em.split('@')[0].toLowerCase(), em);
}
function resolveEventEmail(message, entry) {
  const direct = extractEmail(message, entry && entry.user);
  if (direct && direct.indexOf('@') > 0) return direct;
  const tag = String((entry && entry.user) || '').toLowerCase();
  return tagEmail.get(tag) || null;
}
// 日志消息中提取邮箱(去掉尾部标点, 如 "xxx@qq.com:")
function extractEmail(message, fallback) {
  const m = String(message || '').match(/(\S+@\S+)/);
  const em = String(m ? m[1] : (fallback || '')).replace(/[.:,;，。；]+$/, '');
  return em || null;
}

// ============ 日志 ============
function log(level, msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] [${level}] ${msg}`;
  console.log(line);
}

// ============ 钉钉发送 ============
function buildDingUrl(cfg) {
  let u = `https://oapi.dingtalk.com/robot/send?access_token=${cfg.accessToken}`;
  if (cfg.secret) {
    const ts = Date.now();
    const sign = crypto.createHmac('sha256', cfg.secret)
      .update(`${ts}\n${cfg.secret}`).digest('base64');
    u += `&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
  }
  return u;
}

function sendDingTalk(content) {
  if (!pushConfig.dingtalk.enabled || !pushConfig.dingtalk.accessToken) {
    return Promise.resolve({ ok: false, error: '钉钉未启用或缺少 accessToken' });
  }
  const data = JSON.stringify({
    msgtype: 'text',
    text: { content: content.slice(0, 1800) }, // 钉钉 text 上限 2000
  });
  const url = new URL(buildDingUrl(pushConfig.dingtalk));
  const opts = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    timeout: 10000,
  };
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        const ok = /"errcode":\s*0/.test(b);
        resolve({ ok, resp: b });
      });
    });
    req.on('error', (e) => resolve({ ok: false, resp: 'NETWORK_ERR: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, resp: 'TIMEOUT' }); });
    req.write(data);
    req.end();
  });
}

// ============ 推送去重 ============
const lastSentAt = {};
function shouldSend(key) {
  const now = Date.now();
  const dedup = (pushConfig.dedupSeconds || 10) * 1000;
  if (lastSentAt[key] && now - lastSentAt[key] < dedup) return false;
  lastSentAt[key] = now;
  return true;
}

// ============ 日志事件 → 推送 ============
// SSE log 事件: { id, ts, user, level, platform, title, message, ... } (title/message 按 logParser 结构)
function extractField(msg, re) {
  const m = String(msg || '').match(re);
  return m ? m[1] : null;
}

function pushForEntry(entry) {
  const ev = pushConfig.events || {};
  const title = (entry.title || '').toUpperCase();
  const level = (entry.level || '').toLowerCase();
  const message = String(entry.message || '');
  // 优先从消息中提取邮箱(日志里邮箱形如 xxx@yyy.com), 兜底用日志 user 字段
  const email = (message.match(/(\S+@\S+)/) || [])[1] || entry.user || '';

  let key = null;
  let lines = null;

  if (title === 'RUN-START' && ev.runStart.enabled) {
    key = 'runStart';
    lines = [`🚀 开始运行`, `微软积分脚本开始执行（账号数见日志）`];
  } else if (title === 'RUN-END' && ev.runEnd.enabled) {
    key = 'runEnd';
    const accounts = extractField(message, /(?:accountsProcessed|处理账户数)=(\d+)/);
    const gained = extractField(message, /(?:pointsGained|获得积分)=(-?\d+)/);
    const balance = extractField(message, /(?:currentBalance|现余额)=(\d+)/);
    const runtime = extractField(message, /(?:runtimeMinutes|运行分钟数)=([\d.]+)/);
    lines = [
      `✅ 全部完成`,
      `账号: ${accounts ?? '-'} | 本次获得: ${gained ?? '-'} 分`,
      `当前总余额: ${balance ?? '-'} | 耗时: ${runtime ?? '-'} 分钟`,
    ];
  } else if (title === 'ACCOUNT-END' && ev.accountEnd.enabled) {
    key = 'accountEnd';
    const gained = extractField(message, /(?:pointsGained|获得积分)=(-?\d+)/);
    const balance = extractField(message, /(?:currentBalance|现余额)=(\d+)/);
    lines = [`👤 账号完成`, `${email || '账号'}: 本次 +${gained ?? '-'} 分 | 余额 ${balance ?? '-'}`];
  } else if ((/ERROR/.test(title) || level === 'error') && ev.error.enabled) {
    key = 'error';
    lines = [`❌ 错误`, (email ? `账号 ${email}\n` : '') + message.slice(0, 300) || message.slice(0, 300)];
  } else if ((/LOGIN/.test(title) && /fail|失败|denied|error/i.test(message)) || /BOT-WARNING/.test(title)) {
    if (ev.loginFail.enabled) {
      key = 'loginFail';
      lines = [`⚠️ 登录/风控异常`, (email ? `账号 ${email}\n` : '') + message.slice(0, 300) || message.slice(0, 300)];
    }
  }

  if (key && lines && shouldSend(key)) {
    const text = lines.join('\n');
    if (pushConfig.dingtalk.enabled && pushConfig.dingtalk.accessToken) {
      const kw = pushConfig.dingtalk.keyword || 'MS-Rewards';
      sendDingTalk(`[${kw}] ${text}`).then((r) => {
        log('INFO', `${r.ok ? '✓' : '✗'} 钉钉推送 ${key} -> ${r.resp ? r.resp.slice(0, 100) : 'ok'}`);
      });
    }
    if (emailReady()) {
      sendEventEmail(lines).then((r) => {
        log('INFO', `${r.ok ? '✓' : '✗'} 邮件推送 ${key} -> ${r.ok ? pushConfig.email.to : (r.error || '失败')}`);
      });
    }
  }
}

// ============ 运行状态收集(从日志事件) ============
function recordEntry(entry) {
  const title = (entry.title || '').toUpperCase();
  const level = (entry.level || '').toLowerCase();
  const message = String(entry.message || '');

  if (title === 'ACCOUNT-END') {
    // 中英双语兼容: 上游英文版 "Completed account: x | pointsGained=.." / 中文化分支 "账户完成: x | 获得积分=.."
    const email = extractField(message, /(?:Completed account|账户完成)[:：]\s*(\S+)/) || extractEmail(message, entry.user) || '未知';
    const gained = parseInt(extractField(message, /(?:pointsGained|获得积分)=(-?\d+)/) || '0', 10);
    const balance = parseInt(extractField(message, /(?:currentBalance|现余额)=(\d+)/) || '0', 10);
    const a = ensureAccount(email);
    registerTagEmail(email);
    if (state.currentRun && state.currentRun.cur && state.currentRun.cur.email === email) {
      const durMin = Math.max(1, Math.round((Date.now() - state.currentRun.cur.startedAt) / 60000));
      state.durations = state.durations || [];
      state.durations.push(durMin);
      if (state.durations.length > 5) state.durations.shift();
      state.currentRun.cur = null;
    }
    // 失败过的账号也保留上次已知余额, 仅在成功完成时刷新
    recordBalance(a, balance);
    a.todayCollected = (a.todayCollected || 0) + gained;
    a.lastEndTs = Date.now();
    a.partialCollected = 0;
    a.partialDate = null;
    a.lastStatus = 'success';
    a.lastError = null;
    a.validity = 'valid';
    a.lastRunTs = Date.now();
    if (state.currentRun) {
      state.currentRun.accounts.push({ email, gained, balance });
      state.currentRun.collected += gained;
    }
    saveState();
    // 该账号跑完后 90s 用轻量探针实测任务/余额(不开浏览器, 运行中安全)
    scheduleAccountTaskSync(email, 90000);
  } else if (title === 'ACCOUNT-START') {
    const email = extractField(message, /(?:Starting account|开始处理账户)[:：]\s*(\S+)/) || extractEmail(message, entry.user);
    if (email) {
      const a = ensureAccount(email);
      registerTagEmail(email);
      a.lastStatus = 'running';
      a.lastRunTs = Date.now();
      a.lastError = null;
      if (state.currentRun) state.currentRun.cur = { email, startedAt: Date.now() };
      saveState();
    }
  } else if (title === 'RUN-START') {
    // 收编上一轮遗留的"已得未入账"部分(账号中途失败时, partial 里还留着本次已得积分)
    for (const em of Object.keys(state.accounts)) {
      const a = ensureAccount(em);
      if (a.partialDate === todayStr() && a.partialCollected) {
        a.todayCollected = (a.todayCollected || 0) + a.partialCollected;
      }
      a.partialCollected = 0;
      a.partialDate = null;
      a.lastStatus = 'pending';
      a.lastError = null;
    }
    state.currentRun = { startedAt: Date.now(), accounts: [], collected: 0, finished: false, cur: null };
    saveState();
  } else if (title === 'RUN-END') {
    // 收尾: 仍处于 running 的账号视为未完成(登录失败被跳过等), 保留其余额仅标记状态
    for (const em of Object.keys(state.accounts)) {
      const a = state.accounts[em];
      if (a && a.lastStatus === 'running') {
        a.lastStatus = 'failed';
        a.lastError = a.lastError || '运行结束但未收到该账号完成事件';
      }
    }
    if (state.currentRun) {
      state.currentRun.finished = true;
      state.currentRun.endedAt = Date.now();
      state.currentRun.totalCollected = parseInt(extractField(message, /(?:pointsGained|获得积分)=(-?\d+)/) || '0', 10);
      state.currentRun.totalBalance = parseInt(extractField(message, /(?:currentBalance|现余额)=(\d+)/) || '0', 10);
      state.runs.unshift({
        startedAt: state.currentRun.startedAt,
        endedAt: state.currentRun.endedAt,
        accounts: state.currentRun.accounts,
        collected: state.currentRun.collected,
        totalCollected: state.currentRun.totalCollected,
        totalBalance: state.currentRun.totalBalance,
      });
      if (state.runs.length > HISTORY_KEEP) state.runs.length = HISTORY_KEEP;
      state.currentRun = null;
    }
    autoRetry.active = false; // 运行结束, 释放补跑标记
    // 运行结束后自动同步各账号实时余额(接口口径; 延迟 90s 等微软侧积分落定)
    scheduleAutoSync(90000);
    saveState();
  } else if (title === 'CLAIM-BONUS-POINTS') {
    // "领取全部待领奖励"完成事件: 按账号累计当日一次性奖励(仅 INFO 完成行, 0 分跳过),
    // 前端在"今日获得"下标注"含一次性奖励 X"
    const gained = parseInt(extractField(message, /pointsGained=(\d+)/) || '0', 10);
    if (level === 'info' && /领取奖励积分完成/.test(message) && gained > 0) {
      const email = resolveEventEmail(message, entry);
      if (email && email.indexOf('@') > 0) {
        const a = ensureAccount(email);
        if (a.bonusDate !== todayStr()) { a.bonusDate = todayStr(); a.bonusCollected = 0; }
        a.bonusCollected = (a.bonusCollected || 0) + gained;
        saveState();
      }
    }
  } else if (level === 'error' || title.indexOf('ERROR') >= 0) {
    // 错误事件: 关联到具体账号则标记失败并记录原因(不动余额)
    if (title.indexOf('RUN') < 0) {
      const email = extractEmail(message, entry.user);
      if (email && email.indexOf('@') > 0) {
        const a = ensureAccount(email);
        a.lastStatus = 'failed';
        a.lastError = message.slice(0, 200);
        if (/登录失败|登录超时|身份验证|验证身份|需要验证|账户不存在|couldn't find|登录页|sign-in|login failed/i.test(message)) {
          a.validity = 'need-reauth';
          a.validityTs = Date.now();
        }
        saveState();
      }
    }
  }
}

// ============ SSE 客户端(订阅容器 API /events) ============
function handleFrame(frame) {
  const lines = frame.split('\n');
  let event = null;
  const datas = [];
  for (const l of lines) {
    if (l.startsWith('event:')) event = l.slice(6).trim();
    else if (l.startsWith('data:')) datas.push(l.slice(5).trim());
    else if (l.startsWith('id:')) { /* ignore */ }
  }
  if (!datas.length) return;
  let data;
  try { data = JSON.parse(datas.join('\n')); } catch (e) { return; }

  if (event === 'log') {
    // SSE 每次重连都会按 replay 参数整段重放最近事件(容器 API 行为): 按 id 跳过已消费的,
    // 否则 ACCOUNT-END 等被重复处理, 产生幻影运行记录/今日获得翻倍(2026-09-20 修复)。
    // logSeq 与容器同生命周期从 0 递增, 看板随容器启停, 内存水位即够, 无需持久化
    if (data.id != null) {
      if (lastLogId != null && data.id <= lastLogId) return;
      lastLogId = data.id;
    }
    pushForEntry(data);
    recordEntry(data);
    pushAccountLog(data);
  } else if (event === 'hello') {
    log('INFO', 'SSE 连接成功(hello 快照收到)');
  } else if (event === 'status') {
    // 状态变化, 页面通过轮询 /points 反映, 此处无需处理
  }
}

let lastLogId = null;

function connectSSE() {
  if (!API_TOKEN) {
    log('WARN', '未读取到 API_TOKEN, 无法订阅容器事件, 10s 后重试');
    setTimeout(connectSSE, 10000);
    return;
  }
  const url = `${API_BASE}/events?token=${encodeURIComponent(API_TOKEN)}&replay=200`;
  const req = http.get(url, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      log('WARN', `SSE 连接返回 ${res.statusCode}, ${SSE_RECONNECT_MS}ms 后重连`);
      setTimeout(connectSSE, SSE_RECONNECT_MS);
      return;
    }
    log('INFO', 'SSE 已连接: ' + url.replace(/token=.*$/, 'token=***'));
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleFrame(frame);
      }
    });
    res.on('end', () => { log('WARN', 'SSE 连接断开, 重连中'); setTimeout(connectSSE, SSE_RECONNECT_MS); });
    res.on('error', () => { setTimeout(connectSSE, SSE_RECONNECT_MS); });
  });
  req.on('error', () => { setTimeout(connectSSE, SSE_RECONNECT_MS); });
  req.setTimeout(60000, () => { req.destroy(); });
}

// ============ 容器 API 代理 ============
function proxyContainerApi(reqPath, method, body, res) {
  if (!API_TOKEN) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未配置 API_TOKEN' }));
    return;
  }
  const data = body ? JSON.stringify(body) : null;
  const options = {
    hostname: '127.0.0.1',
    port: API_PORT,
    path: reqPath,
    method: method || 'GET',
    headers: {
      Authorization: 'Bearer ' + API_TOKEN,
      Accept: 'application/json',
    },
    timeout: 60000, // start 可能长
  };
  if (data) {
    options.headers['Content-Type'] = 'application/json';
    options.headers['Content-Length'] = Buffer.byteLength(data);
  }
  const req = http.request(options, (r) => {
    let b = '';
    r.on('data', (c) => (b += c));
    r.on('end', () => {
      try {
        res.writeHead(r.statusCode, { 'Content-Type': 'application/json' });
        res.end(b || '{}');
      } catch (e) { /* ignore */ }
    });
  });
  req.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '容器 API 不可达: ' + e.message }));
  });
  if (data) req.write(data);
  req.end();
}

// ============ 登录体检(无头会话检查 + 实时余额) ============
// 复用 scripts/main/loginCheck.js(与主脚本同一会话存取逻辑), 后台任务化并轮询结果
const PROJECT_ROOT = path.join(BASE_DIR, '..');
const LOGIN_CHECK_TIMEOUT_MS = 300000;
const loginCheckJobs = new Map(); // id -> job

function startLoginCheck(accountIndex, email) {
  for (const job of loginCheckJobs.values()) {
    if (job.status === 'running') return { error: '已有登录体检在进行中,请稍候', code: 'BUSY' };
  }
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, accountIndex, email, status: 'running', startedAt: Date.now(), result: null, logs: [] };
  loginCheckJobs.set(id, job);
  for (const key of loginCheckJobs.keys()) {
    if (loginCheckJobs.size > 6) loginCheckJobs.delete(key);
  }
  let buf = '';
  const onLine = (line) => {
    const t = line.trim();
    if (!t) return;
    job.logs.push(t);
    if (job.logs.length > 60) job.logs.shift();
    const m = t.match(/LOGINCHECK_RESULT (\{.*\})/);
    if (m) {
      try { job.result = JSON.parse(m[1]); } catch (e) { /* 忽略解析失败 */ }
    }
  };
  const child = spawn('node',
    [path.join(PROJECT_ROOT, 'scripts/main/loginCheck.js'), '--email', email, '--platform', 'both'],
    { cwd: PROJECT_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const feed = (c) => {
    buf += c.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  const timer = setTimeout(() => {
    // 整进程组击杀(负 PID), 连同浏览器子进程一起终止, 防止孤儿进程变僵尸占满 pids 上限
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) { /* ignore */ } }
    job.status = job.result ? 'done' : 'error';
    job.error = job.error || '体检超时';
  }, LOGIN_CHECK_TIMEOUT_MS);
  child.on('exit', (code) => {
    clearTimeout(timer);
    job.exitCode = code;
    job.finishedAt = Date.now();
    job.status = job.result ? 'done' : 'error';
    if (!job.result) job.error = job.error || ('进程退出 code=' + code);
    if (job.result) {
      // 体检结果直接落到账号状态(余额/体检时间), 前端刷新即可见
      try {
        const a = ensureAccount(job.result.email);
        if (job.result.balance != null) recordBalance(a, job.result.balance);
        const first = Object.values(job.result.platforms || {})[0] || {};
        a.lastStatus = job.result.loggedIn ? 'success' : 'failed';
        a.lastError = job.result.loggedIn ? null : (first.reason === 'no-saved-session'
          ? '新账号还没有已保存的登录会话, 体检无法代替登录: 请点 🔑 人工登录完成一次微软登录, 或勾选该账号点 ▶ 运行(脚本会用保存的密码自动登录)'
          : ('登录体检未通过: ' + (first.reason || 'unknown')));
        a.lastCheckTs = Date.now();
        a.validity = job.result.loggedIn ? 'valid' : (first.reason === 'no-saved-session' ? 'no-session' : 'need-reauth');
        a.validityTs = Date.now();
        // 任务完成度(微软接口逐项实测: 当日每日任务集+搜索计数器+打卡子任务)
        if (job.result.tasks) {
          a.tasks = Object.assign({ date: todayStr(), ts: Date.now() }, job.result.tasks);
        }
        saveState();
      } catch (e) { /* ignore */ }
    }
  });
  return { ok: true, id, email };
}

function loginCheckStatus() {
  const jobs = [...loginCheckJobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 6);
  return {
    jobs: jobs.map(j => ({
      id: j.id, accountIndex: j.accountIndex, email: j.email, status: j.status,
      startedAt: j.startedAt, finishedAt: j.finishedAt || null,
      error: j.error || null, result: j.result || null,
      lastLog: j.logs.length ? j.logs[j.logs.length - 1] : null,
    })),
    running: jobs.some(j => j.status === 'running'),
  };
}

// ============ 兑换市场/账号区域探测(浏览器级, 全账号串行) ============
// 复用 scripts/main/marketProbe.js: 每号恢复会话开 /redeem 读归属市场 +
// flyout/getuserinfo 读当前服务区域与档案国家; 结果写 market.json, 前端刷新即见。
// 与 run/体检/人工登录同属浏览器任务, 触发前互斥检查, 空闲才跑。
const MARKET_PROBE_TIMEOUT_MS = 15 * 60 * 1000;
let marketProbeJob = null; // 单例: { id, status, trigger, startedAt, finishedAt, error, result, logs }

function startMarketProbe(trigger) {
  if (marketProbeJob && marketProbeJob.status === 'running') return { error: '区域检测已在进行中', code: 'BUSY' };
  for (const job of loginCheckJobs.values()) {
    if (job.status === 'running') return { error: '登录体检在进行中, 请稍后再试', code: 'BUSY' };
  }
  if (manualLoginSession && !manualLoginSession.stopped) return { error: '人工登录会话进行中, 请稍后再试', code: 'BUSY' };
  if (syncAll && syncAll.status === 'running') return { error: '余额同步在进行中, 请稍后再试', code: 'BUSY' };
  const id = crypto.randomBytes(8).toString('hex');
  marketProbeJob = { id, status: 'running', trigger: trigger || 'manual', startedAt: Date.now(), finishedAt: null, error: null, result: null, logs: [] };
  log('INFO', '区域检测开始 (' + marketProbeJob.trigger + '): ' + path.join(PROJECT_ROOT, 'scripts/main/marketProbe.js'));
  const child = spawn('node',
    [path.join(PROJECT_ROOT, 'scripts/main/marketProbe.js'), '--all'],
    { cwd: PROJECT_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let buf = '';
  const feed = (c) => {
    buf += c.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      marketProbeJob.logs.push(line);
      if (marketProbeJob.logs.length > 80) marketProbeJob.logs.shift();
      const m = line.match(/MARKETPROBE_RESULT (\{.*\})/);
      if (m) { try { marketProbeJob.result = JSON.parse(m[1]); } catch (e) { /* ignore */ } }
    }
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) { /* ignore */ } }
    marketProbeJob.status = 'error';
    marketProbeJob.error = '区域检测超时';
    marketProbeJob.finishedAt = Date.now();
  }, MARKET_PROBE_TIMEOUT_MS);
  child.on('exit', (code) => {
    clearTimeout(timer);
    marketProbeJob.finishedAt = Date.now();
    marketProbeJob.exitCode = code;
    if (marketProbeJob.status === 'running') {
      marketProbeJob.status = marketProbeJob.result ? 'done' : 'error';
      if (!marketProbeJob.result) marketProbeJob.error = marketProbeJob.error || ('进程退出 code=' + code);
    }
    log('INFO', '区域检测结束: status=' + marketProbeJob.status + (marketProbeJob.error ? ' | ' + marketProbeJob.error : ''));
  });
  return { ok: true, id };
}

function marketProbeStatus() {
  if (!marketProbeJob) return { job: null, running: false };
  return {
    job: {
      id: marketProbeJob.id, status: marketProbeJob.status, trigger: marketProbeJob.trigger,
      startedAt: marketProbeJob.startedAt, finishedAt: marketProbeJob.finishedAt || null,
      error: marketProbeJob.error || null, result: marketProbeJob.result || null,
      lastLog: marketProbeJob.logs.length ? marketProbeJob.logs[marketProbeJob.logs.length - 1] : null,
    },
    running: marketProbeJob.status === 'running',
  };
}

// 每日自动: 北京时间 15~20 点之间、当天还没测过、容器空闲时补一次(手动按钮不受限)
const marketAutoState = { lastDate: '' };
async function marketCatchup(trigger) {
  try {
    if (marketProbeJob && marketProbeJob.status === 'running') return;
    const t = todayStr();
    if (marketAutoState.lastDate === t) return;
    const hour = beijingHour();
    if (hour < 15 || hour >= 20) return;
    const md = loadMarketData();
    const measuredToday = md.updatedAt && new Date(md.updatedAt + 8 * 3600e3).toISOString().slice(0, 10) === t;
    if (measuredToday) { marketAutoState.lastDate = t; return; }
    const pts = await fetchJson('/points');
    if (!pts || pts.running || pts.state === 'running') return;
    marketAutoState.lastDate = t;
    startMarketProbe(trigger || 'daily');
  } catch (e) { /* ignore */ }
}

// ============ 全账号余额同步(接口口径) ============
// 逐个账号串行跑 loginCheck(无头恢复会话 → rewards getuserinfo 接口读实时余额),
// 结果经 recordBalance 落到当日锚点。RUN-END 后自动触发一次, 也可手动点按钮。
let syncAll = null; // { status, trigger, startedAt, finishedAt, queue, current, results }
let syncAllTimer = null;

// ==== 任务数据自动补齐: 存在"今日无实测数据"的有效账号且容器空闲时, 自动发起同步 ====
function needsTaskSync() {
  const t = todayStr();
  for (const em of Object.keys(state.accounts)) {
    if (em.indexOf('@') < 0) continue;
    const a = state.accounts[em];
    if (!a) continue;
    if (a.validity === 'need-reauth' || a.validity === 'no-session') continue;
    // 2 小时内已尝试过则不重复(避免个别接口不返回的账号被无限刷); 超过 2 小时允许重试
    const recentAttempt = a.lastCheckTs && (Date.now() - a.lastCheckTs) < 2 * 3600e3;
    if (recentAttempt) continue;
    if (!a.tasks || a.tasks.date !== t) return true;
  }
  return false;
}
function taskSyncCatchup(trigger) {
  if (syncAll && syncAll.status === 'running') return;
  if (!needsTaskSync()) return;
  log('INFO', '检测到有账号缺少今日任务实测数据, 自动发起同步 (' + trigger + ')');
  syncAllStart('task-catchup');
}
setInterval(() => { try { taskSyncCatchup('periodic-30min'); } catch (e) { /* ignore */ } }, 30 * 60 * 1000);
setInterval(() => { void marketCatchup('periodic-30min'); }, 30 * 60 * 1000);

// ==== 任务未完成自动补跑(每日最多一次) ====
// 数据同步完成后检测: 有实测数据的账号未全部通过, 或无明细账号当日积分低于阈值
// → 只对未完成的账号自动发起一次补跑(其余账号加入排除列表)。仅北京时间 7~21 点之间发起(凌晨静默, AUTO_RETRY_FIRST_HOUR 可覆盖)。
const AUTO_RETRY_MIN_POINTS = Number(process.env.AUTO_RETRY_MIN_POINTS || 50);
const AUTO_RETRY_FIRST_HOUR = Number(process.env.AUTO_RETRY_FIRST_HOUR || 7);
const AUTO_RETRY_LAST_HOUR = 21;
const autoRetry = { lastDate: '', active: false };

function beijingHour() {
  return new Date(Date.now() + 8 * 3600e3).getUTCHours();
}

function accountNeedsRetry(a, t) {
  if (!a || typeof a !== 'object' || !a.email || a.email.indexOf('@') < 0) return false;
  if (a.validity === 'need-reauth' || a.validity === 'no-session') return false;
  if (a.tasks && a.tasks.date === t) return a.tasks.allDone !== true;
  if (a.tasksNA === t) return (a.todayCollected || 0) < AUTO_RETRY_MIN_POINTS;
  return true; // 无任何实测数据: 视为未跑
}

async function maybeAutoRetryRun(trigger) {
  const t = todayStr();
  if (autoRetry.lastDate === t || autoRetry.active) return;
  if (beijingHour() < AUTO_RETRY_FIRST_HOUR) return; // 凌晨静默: 当天首跑由 6:00-6:30 定时轮负责, 补跑 7 点后才兜底
  if (beijingHour() >= AUTO_RETRY_LAST_HOUR) return;
  const pts = await fetchJson('/points');
  if (pts && pts.running) return; // 有运行在进行, 不发起
  const retryEmails = [];
  for (const em of Object.keys(state.accounts)) {
    if (accountNeedsRetry(state.accounts[em], t)) retryEmails.push(em);
  }
  if (!retryEmails.length) return;
  const accs = await fetchJson('/accounts');
  const list = (((accs || {}).accounts) || []);
  const retryIndexes = list.filter(x => retryEmails.indexOf(x.email) >= 0).map(x => x.index);
  if (!retryIndexes.length) return;
  autoRetry.lastDate = t;
  autoRetry.active = true;
  const excluded = list.filter(x => retryEmails.indexOf(x.email) < 0).map(x => x.index);
  const payload = excluded.length ? { excludedAccountIndexes: excluded } : {};
  log('INFO', '任务未完成自动补跑 (' + trigger + '): ' + retryEmails.join(', '));
  await postJson('/start', payload);
}

// 轻量任务/余额探针: 读会话库 cookies 直接调 rewards getuserinfo(不开浏览器),
// 与运行并行安全, 单号约 1-2 秒; 结果落到当日锚点与任务完成度
const taskProbeJobs = new Map(); // email -> 上次探测时间戳(30s 防抖)
function runTaskProbe(email) {
  return new Promise((resolve) => {
    const last = taskProbeJobs.get(email) || 0;
    if (Date.now() - last < 30000) return resolve({ email, ok: false, reason: '30s 内已探测过' });
    taskProbeJobs.set(email, Date.now());
    let buf = '';
    let result = null;
    const child = spawn('node',
      [path.join(PROJECT_ROOT, 'scripts/main/taskProbe.js'), '--email', email],
      { cwd: PROJECT_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }, 45000);
    const feed = (c) => {
      buf += c.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        const m = line.match(/TASKPROBE_RESULT (\{.*\})/);
        if (m) { try { result = JSON.parse(m[1]); } catch (e) { /* ignore */ } }
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('exit', () => {
      clearTimeout(timer);
      if (result && (result.balance != null || result.tasks)) {
        try {
          const em = result.email || email;
          const a = ensureAccount(em);
          registerTagEmail(em);
          if (result.balance != null) recordBalance(a, result.balance);
          if (result.tasks) a.tasks = Object.assign({ date: todayStr(), ts: Date.now() }, result.tasks);
          else a.tasksNA = todayStr(); // 接口不返回任务明细(仅余额可得)
          a.lastCheckTs = Date.now();
          a.validity = 'valid';
          saveState();
        } catch (e) { /* ignore */ }
      }
      resolve(result || { email, ok: false, reason: 'no-result' });
    });
  });
}

// 单账号任务实测调度(ACCOUNT-END 后触发): 轻量探针, 运行中也可安全执行
const pendingAccountSync = new Set();
function scheduleAccountTaskSync(email, delayMs) {
  if (!email || pendingAccountSync.has(email)) return;
  pendingAccountSync.add(email);
  setTimeout(() => {
    pendingAccountSync.delete(email);
    runTaskProbe(email).then(r => {
      log('INFO', '账号 ' + email + ' 任务实测: ' + JSON.stringify({ balance: r.balance, tasks: r.tasks }));
    }).catch(() => { /* ignore */ });
  }, delayMs);
}

function syncAllSummary() {
  if (!syncAll) return null;
  return {
    status: syncAll.status,
    trigger: syncAll.trigger,
    startedAt: syncAll.startedAt,
    finishedAt: syncAll.finishedAt,
    current: syncAll.current,
    done: syncAll.results.length,
    total: syncAll.results.length + syncAll.queue.length + (syncAll.current ? 1 : 0),
    failed: syncAll.results.filter(r => !r.ok).length,
  };
}

function scheduleAutoSync(delayMs = 90000) {
  if (syncAllTimer) clearTimeout(syncAllTimer);
  syncAllTimer = setTimeout(() => {
    syncAllTimer = null;
    try { syncAllStart('run-end'); } catch (e) { /* ignore */ }
  }, delayMs);
}

function syncAllStart(trigger) {
  if (syncAll && syncAll.status === 'running') return { error: '余额同步已在进行中', code: 'BUSY' };
  syncAll = { status: 'running', trigger, startedAt: Date.now(), finishedAt: null, queue: [], current: null, results: [] };
  const candidates = (list) => list.filter(acc => {
    const st = state.accounts[acc.email];
    return !st || (st.validity !== 'need-reauth' && st.validity !== 'no-session');
  });
  fetchJson('/accounts').then(accs => {
    if (!syncAll || syncAll.status !== 'running') return;
    syncAll.queue = candidates((((accs || {}).accounts) || [])).map(a => ({ index: a.index, email: a.email }));
    runNextSync();
  }).catch(() => {
    if (!syncAll || syncAll.status !== 'running') return;
    syncAll.queue = candidates(
      Object.keys(state.accounts)
        .filter(em => em && em.indexOf('@') > 0)
        .map((em, i) => ({ index: i + 1, email: em }))
    );
    runNextSync();
  });
  return { ok: true };
}

async function runNextSync() {
  if (!syncAll || syncAll.status !== 'running') return;
  const next = syncAll.queue.shift();
  if (!next) {
    syncAll.status = 'done';
    syncAll.finishedAt = Date.now();
    const trig = syncAll.trigger || 'sync';
    setTimeout(() => { try { maybeAutoRetryRun(trig); } catch (e) { /* ignore */ } }, 5000);
    return;
  }
  syncAll.current = next.email;
  let r = await runTaskProbe(next.email);
  let ok = !!(r && r.ok !== false && r.balance != null);
  if (!ok) {
    // 探针失败(个别账号接口不配合): 空闲时回退浏览器体检(会话核验+刷新 cookie)
    try {
      const pNow = await fetchJson('/points');
      if (!pNow || !pNow.running) {
        const lr = await runLoginCheckFallback(next.email);
        if (lr && lr.loggedIn) { ok = true; r = lr; }
      }
    } catch (e) { /* ignore */ }
  }
  if (!syncAll || syncAll.status !== 'running') return;
  syncAll.results.push({
    email: next.email,
    ok,
    balance: r ? r.balance : null,
  });
  saveState();
  syncAll.current = null;
  setTimeout(runNextSync, 1000);
}

// 浏览器体检回退(loginCheck): 结果已由其退出处理器写入账号状态
function runLoginCheckFallback(email) {
  return new Promise((resolve) => {
    fetchJson('/accounts').then(accs => {
      const acc = (((accs || {}).accounts) || []).find(x => x.email === email);
      if (!acc) return resolve(null);
      const r = startLoginCheck(acc.index, email);
      if (r.error) return resolve(null);
      const wait = () => {
        const job = [...loginCheckJobs.values()].find(j => j.id === r.id);
        if (!job || job.status !== 'running') { resolve(job ? job.result : null); return; }
        setTimeout(wait, 3000);
      };
      setTimeout(wait, 3000);
    }).catch(() => resolve(null));
  });
}

// ============ 人工登录(Xvfb + x11vnc + websockify + 上游 manualLogin) ============
// 无头容器里拉起有头浏览器, 经 noVNC(带一次性 token 代理)让用户在内网页面里完成微软验证
const ML_DISPLAY = ':99';
const ML_VNC_PORT = 5999;
const ML_WS_PORT = 6080;
const ML_NOVNC_WEB = '/usr/share/novnc';
const ML_WATCHDOG_MS = 20 * 60 * 1000;
let manualLoginSession = null;

function mlPushLog(session, text) {
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    session.logs.push(t);
  }
  if (session.logs.length > 60) session.logs.splice(0, session.logs.length - 60);
}

function mlCleanupProcs(session) {
  for (const key of ['runner', 'websockify', 'x11vnc', 'xvfb']) {
    const p = session.procs[key];
    if (!p) continue;
    // 整进程组击杀(负 PID), 连同浏览器子进程一起终止
    try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { try { p.kill('SIGKILL'); } catch (e2) { /* ignore */ } }
    session.procs[key] = null;
  }
}

function mlStop(session, reason) {
  if (!session || session.stopped) return;
  session.stopped = true;
  session.stopReason = reason || null;
  clearTimeout(session.watchdog);
  try { session.procs.runner && session.procs.runner.kill('SIGTERM'); } catch (e) { /* ignore */ }
  setTimeout(() => mlCleanupProcs(session), 2500);
}

async function startManualLogin(accountIndex) {
  if (manualLoginSession && !manualLoginSession.done && !manualLoginSession.stopped) {
    return { error: '已有人工登录会话进行中(同一时间仅支持一个)', code: 'BUSY' };
  }
  const accs = await fetchJson('/accounts');
  const acc = (((accs || {}).accounts) || []).find(a => a.index === accountIndex);
  if (!acc) return { error: '未知账号序号: ' + accountIndex, code: 'BAD_REQUEST' };
  const email = acc.email;

  const procs = {};
  const session = manualLoginSession = {
    token: crypto.randomBytes(16).toString('hex'),
    accountIndex, email, startedAt: Date.now(),
    logs: [], procs, stopped: false, done: false,
  };
  // 上次会话若被强杀会残留 X 锁文件, 导致 Xvfb 起不来("Server is already active")
  for (const stale of ['/tmp/.X99-lock', '/tmp/.X11-unix/X99']) {
    try { fs.rmSync(stale, { force: true }); } catch (e) { /* ignore */ }
  }
  procs.xvfb = spawn('Xvfb', [ML_DISPLAY, '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], { env: process.env });
  await new Promise(r => setTimeout(r, 1200));
  procs.x11vnc = spawn('x11vnc',
    ['-display', ML_DISPLAY, '-rfbport', String(ML_VNC_PORT), '-listen', '127.0.0.1', '-nopw', '-forever', '-shared', '-quiet'],
    { env: process.env });
  procs.websockify = spawn('websockify',
    ['--web', ML_NOVNC_WEB, '127.0.0.1:' + ML_WS_PORT, '127.0.0.1:' + ML_VNC_PORT],
    { env: process.env });
  // 等 websockify 真正开始监听再返回 token: python 冷启动可能要数秒, 若前端 iframe
  // 首次加载 vnc.html 撞上未监听会得到 502"noVNC 未就绪"且 iframe 不会重试(2026-09-05 修复)
  for (let i = 0; i < 60; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(ML_WS_PORT, '127.0.0.1', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      s.setTimeout(250, () => { try { s.destroy(); } catch (e) { /* ignore */ } resolve(false); });
    });
    if (up) break;
    await new Promise(r => setTimeout(r, 250));
  }
  procs.runner = spawn('node',
    [path.join(PROJECT_ROOT, 'scripts/main/manualLogin.js'), '--email', email, '--platform', 'both'],
    { cwd: PROJECT_ROOT, env: Object.assign({}, process.env, { DISPLAY: ML_DISPLAY }), detached: true });

  session.watchdog = setTimeout(() => {
    mlPushLog(session, '[dashboard] 会话超时(20 分钟), 自动结束');
    mlStop(session, 'timeout');
  }, ML_WATCHDOG_MS);
  for (const name of ['xvfb', 'x11vnc', 'websockify']) {
    procs[name].on('exit', (code) => mlPushLog(session, '[dashboard] ' + name + ' 退出 code=' + code));
  }
  const feed = (c) => mlPushLog(session, c.toString());
  procs.runner.stdout.on('data', feed);
  procs.runner.stderr.on('data', feed);
  procs.runner.on('exit', (code) => {
    session.done = true;
    session.runnerExit = code;
    mlPushLog(session, '[dashboard] manualLogin 退出 code=' + code + (code === 0 ? '(会话已保存)' : '(未保存完整登录)'));
    if (code !== 0) {
      // 找出 runner 的报错行, 透出到状态接口方便定位
      const errLine = [...session.logs].reverse().find(l => /ERROR|error|Failed|failed|doesn't exist|not found/i.test(l));
      session.failLog = errLine || session.logs[session.logs.length - 2] || null;
    } else {
      // 人工登录成功(会话已保存): 立即翻转授权状态, 去掉 🔐 重新授权 标记(2026-09-05 修复)
      try {
        const a = ensureAccount(email);
        registerTagEmail(email);
        a.validity = 'valid';
        a.validityTs = Date.now();
        a.lastStatus = 'success';
        a.lastError = null;
        a.lastCheckTs = Date.now();
        saveState();
      } catch (e) { /* ignore */ }
      // 顺带做一次体检: 经接口读实时余额并复核刚保存的会话(若实际未通过会如实改回)
      setTimeout(() => { try { startLoginCheck(session.accountIndex, email); } catch (e) { /* ignore */ } }, 5000);
    }
    setTimeout(() => { mlCleanupProcs(session); }, 2000);
  });
  log('INFO', '人工登录会话启动: ' + email + ' (token=' + session.token.slice(0, 8) + '...)');
  return { ok: true, token: session.token, email };
}

function manualLoginStatus() {
  const s = manualLoginSession;
  if (!s) return { active: false };
  const active = !s.done && !s.stopped;
  return {
    active,
    done: s.done,
    stopped: s.stopped,
    email: s.email,
    startedAt: s.startedAt,
    token: active ? s.token : null,
    runnerExit: s.runnerExit != null ? s.runnerExit : null,
    failLog: s.failLog || null,
    lastLog: s.logs.length ? s.logs[s.logs.length - 1] : null,
  };
}

function handleNovncHttp(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/manual-vnc\/([0-9a-f]{32})(\/.*)?$/);
  if (!m || !manualLoginSession || manualLoginSession.token !== m[1] || manualLoginSession.stopped || manualLoginSession.done) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('无有效人工登录会话');
  }
  const suffix = (m[2] || '/vnc.html') + (url.search || '');
  const up = http.request(
    { hostname: '127.0.0.1', port: ML_WS_PORT, path: suffix, method: req.method, headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + ML_WS_PORT }) },
    (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => {
    try { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('noVNC 未就绪'); } catch (e) { /* ignore */ }
  });
  req.pipe(up);
}

function handleUpgrade(req, socket, head) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const m = url.pathname.match(/^\/manual-vnc\/([0-9a-f]{32})\/websockify$/);
    if (!m || !manualLoginSession || manualLoginSession.token !== m[1] || manualLoginSession.stopped || manualLoginSession.done) {
      socket.destroy();
      return;
    }
    const upstream = net.connect(ML_WS_PORT, '127.0.0.1', () => {
      const prefix = '/manual-vnc/' + m[1];
      const lines = [req.method + ' ' + url.pathname.slice(prefix.length) + ' HTTP/1.1'];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1]);
      socket.setTimeout(0);
      socket.setNoDelay(true);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  } catch (e) {
    try { socket.destroy(); } catch (e2) { /* ignore */ }
  }
}

// ============ 账号管理(动态账号, config/accounts.json) ============
// 与 fork 的动态账号源同文件: 添加/删除后, 下一次运行(cron 或手动)自动生效, 无需重建容器
const EXTRA_ACCOUNTS_FILE = process.env.EXTRA_ACCOUNTS_FILE || path.join(CONFIG_DIR, '..', 'accounts.json');

function readExtraFile() {
  try {
    if (!fs.existsSync(EXTRA_ACCOUNTS_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(EXTRA_ACCOUNTS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    log('ERROR', '读取动态账号文件失败: ' + e.message);
    return [];
  }
}

function writeExtraFile(list) {
  try {
    fs.writeFileSync(EXTRA_ACCOUNTS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
    try { fs.chmodSync(EXTRA_ACCOUNTS_FILE, 0o600); } catch (e) { /* ignore */ }
    return true;
  } catch (e) {
    log('ERROR', '写入动态账号文件失败: ' + e.message);
    return false;
  }
}

// ============ 邮件通知(零依赖 SMTP 客户端, SSL 465 / STARTTLS 587) ============
function sendEmail(cfg, subject, body) {
  return new Promise((resolve) => {
    const port = Number(cfg.smtpPort) || 465
    const implicitTls = cfg.secure !== false && port === 465
    const auth = Buffer.from('\u0000' + cfg.user + '\u0000' + cfg.pass).toString('base64')
    const toList = String(cfg.to || '').split(/[,;，；]/).map(a => a.trim()).filter(a => a.includes('@'))
    if (!toList.length) return resolve({ ok: false, error: '收件邮箱未配置' })

    let settled = false
    let socket = null
    let buffer = ''
    let step = 0 // 0=等问候 1=EHLO后 2=AUTH 3=MAIL 4=RCPT 5=DATA 6=已发送正文 10=STARTTLS协商中
    let tlsDone = implicitTls
    let rcptIdx = 0
    const done = (r) => { if (!settled) { settled = true; resolve(r) } }
    const fail = (msg) => { try { if (socket) socket.destroy() } catch (e) { /* ignore */ } done({ ok: false, error: msg }) }
    const sendCmd = (line) => socket.write(line + '\r\n')

    const handleReply = (line) => {
      const code = parseInt(line, 10)
      if (Number.isNaN(code) || code >= 400) return fail('SMTP ' + line.slice(0, 140))
      switch (step) {
        case 0: step = 1; sendCmd('EHLO dashboard'); break
        case 1:
          if (!tlsDone) { step = 10; sendCmd('STARTTLS'); break }
          step = 2; sendCmd('AUTH PLAIN ' + auth); break
        case 2: step = 3; sendCmd('MAIL FROM:<' + cfg.user + '>'); break
        case 3: step = 4; sendCmd('RCPT TO:<' + toList[0] + '>'); rcptIdx = 1; break
        case 4:
          if (rcptIdx < toList.length) { sendCmd('RCPT TO:<' + toList[rcptIdx] + '>'); rcptIdx += 1; break }
          step = 5; sendCmd('DATA'); break
        case 5: {
          step = 6
          const b64 = Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
          sendCmd([
            'From: MS-Rewards <' + cfg.user + '>',
            'To: ' + toList.join(', '),
            'Subject: =?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?=',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: base64',
            '',
            b64,
            '.',
          ].join('\r\n'))
          break
        }
        case 6:
          sendCmd('QUIT')
          done({ ok: true })
          try { socket.end() } catch (e) { /* ignore */ }
          break
      }
    }
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      let idx
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        if (/^\d{3}-/.test(line)) continue // 多行响应的中间行
        if (step === 10) {
          if (parseInt(line, 10) !== 220) return fail('STARTTLS 失败: ' + line.slice(0, 140))
          const tlsSocket = tls.connect({ socket, servername: cfg.smtpHost, rejectUnauthorized: false }, () => {
            tlsDone = true
            step = 1
            buffer = ''
            sendCmd('EHLO dashboard')
          })
          socket = tlsSocket
          attach(tlsSocket)
          return
        }
        handleReply(line)
        return
      }
    }
    const attach = (s2) => {
      s2.setTimeout(15000, () => fail('SMTP 超时'))
      s2.on('data', onData)
      s2.on('error', (e) => fail('SMTP 连接失败: ' + e.message))
    }

    if (implicitTls) {
      socket = tls.connect({ host: cfg.smtpHost, port, servername: cfg.smtpHost, rejectUnauthorized: false }, () => {
        // TLS 就绪, 等服务器 220 问候后由状态机发 EHLO
      })
      attach(socket)
    } else {
      socket = net.connect({ host: cfg.smtpHost, port }, () => {})
      attach(socket)
    }
  })
}

function emailReady() {
  const em = pushConfig.email || {}
  return Boolean(em.enabled && em.smtpHost && em.user && em.pass && em.to)
}

function sendEventEmail(lines) {
  const em = pushConfig.email || {}
  return sendEmail(em, '[MS-Rewards] ' + String(lines[0] || '通知'), lines.join('\n'))
}

// ============ 每账号运行日志缓存(SSE 流按账号标签环形缓存) ============
const ACCOUNT_LOG_KEEP = 300
const accountLogs = new Map() // user 标签 -> [{ts, level, platform, title, message}]
// ============ 账号历史日志(按天读脚本日志文件 logs/YYYY-MM-DD.log, 保留 7 天) ============
const SCRIPT_LOGS_DIR = path.join(PROJECT_ROOT, 'logs')
const HISTORY_KEEP_DAYS = 7
function pruneOldLogFiles() {
  const cutoff = Date.now() - HISTORY_KEEP_DAYS * 24 * 60 * 60 * 1000
  try {
    for (const f of fs.readdirSync(SCRIPT_LOGS_DIR)) {
      const m = /^(\d{4})-(\d{2})-(\d{2})\.log$/.exec(f)
      if (!m) continue
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59).getTime()
      if (t < cutoff) { try { fs.unlinkSync(path.join(SCRIPT_LOGS_DIR, f)); log('INFO', '已清理超期日志文件: ' + f); } catch (e) { /* ignore */ } }
    }
  } catch (e) { /* ignore */ }
}
function accountLogDates() {
  try {
    return fs.readdirSync(SCRIPT_LOGS_DIR)
      .map(f => { const m = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(f); return m ? m[1] : null })
      .filter(Boolean).sort().reverse()
  } catch (e) { return [] }
}
function pushAccountLog(entry) {
  const tag = String(entry.user || '').trim()
  if (!tag) return
  let arr = accountLogs.get(tag)
  if (!arr) { arr = []; accountLogs.set(tag, arr) }
  arr.push({
    ts: entry.ts || entry.receivedAt || Date.now(),
    level: (entry.level || 'info').toUpperCase(),
    platform: entry.platform || 'MAIN',
    title: entry.title || '',
    message: String(entry.message || '').slice(0, 400),
  })
  if (arr.length > ACCOUNT_LOG_KEEP) arr.splice(0, arr.length - ACCOUNT_LOG_KEEP)
}

// ============ 能力控制(经容器 API PATCH /config 与 PUT /schedule) ============
const WORKER_KEYS = ['doDailySet', 'doSpecialPromotions', 'doMorePromotions', 'doPunchCards', 'doAppPromotions', 'doDesktopSearch', 'doMobileSearch', 'doDailyCheckIn', 'doReadToEarn', 'doClaimBonusPoints', 'doActivateSearchPerk', 'doBonusSearches', 'doVisualSearch']

// ============ HTTP 服务(8300) ============
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 1024 * 1024) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';

  try {
    // ---- API ----
    if (p === '/api/points') return proxyContainerApi('/points', 'GET', null, res);
    if (p === '/api/accounts') return proxyContainerApi('/accounts', 'GET', null, res);
    if (p === '/api/schedule') return proxyContainerApi('/schedule', 'GET', null, res);
    if (p === '/api/status') return proxyContainerApi('/status', 'GET', null, res);
    if (p === '/api/history') {
      // 合并容器 history 与 dashboard 自身持久化 runs
      const container = await new Promise((resolve) => {
        if (!API_TOKEN) return resolve(null);
        const req2 = http.get({ hostname: '127.0.0.1', port: API_PORT, path: '/history', headers: { Authorization: 'Bearer ' + API_TOKEN } }, (r) => {
          let b = '';
          r.on('data', (c) => (b += c));
          r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
        });
        req2.on('error', () => resolve(null));
      });
      return json(res, 200, {
        dashboard: state.runs,
        container: container,
        containerInMemory: container ? container.inMemoryOnly : true,
      });
    }

    if (p === '/api/push-config' && req.method === 'GET') {
      return json(res, 200, pushConfig);
    }
    if (p === '/api/push-config' && req.method === 'PUT') {
      const body = await readBody(req);
      const merged = Object.assign(defaultPushConfig(), pushConfig, {
        dingtalk: Object.assign({}, pushConfig.dingtalk, body.dingtalk),
        events: Object.assign({}, pushConfig.events, body.events),
        email: Object.assign({}, pushConfig.email, body.email),
        dedupSeconds: body.dedupSeconds != null ? body.dedupSeconds : pushConfig.dedupSeconds,
      });
      pushConfig = merged;
      savePushConfig();
      return json(res, 200, { ok: true, config: pushConfig });
    }
    if (p === '/api/push-test' && req.method === 'POST') {
      const stamp = new Date().toLocaleString('zh-CN')
      const tasks = []
      if (pushConfig.dingtalk.enabled && pushConfig.dingtalk.accessToken) {
        tasks.push(
          sendDingTalk(`[${pushConfig.dingtalk.keyword || 'MS-Rewards'}] 🧪 测试推送\n仪表盘推送配置测试成功 ✅\n(${stamp})`)
            .then((r) => ({ channel: '钉钉', ok: r.ok, error: r.error || (r.resp ? r.resp.slice(0, 120) : '') }))
        )
      }
      if (emailReady()) {
        tasks.push(
          sendEmail(pushConfig.email, '[MS-Rewards] 🧪 测试推送', '仪表盘推送配置测试成功 ✅\n(' + stamp + ')')
            .then((r) => ({ channel: '邮件', ok: r.ok, error: r.error || '' }))
        )
      }
      if (!tasks.length) return json(res, 200, { ok: false, error: '钉钉与邮件均未启用/未配置' })
      const results = await Promise.all(tasks)
      return json(res, 200, { ok: results.some((r) => r.ok), results })
    }
    if (p === '/api/start' && req.method === 'POST') {
      // body: {} = 全部账号 | { accountIndex: N } = 单账号 | { indexes: [..] } = 选中账号(转换为排除未选)
      let body = {};
      try { body = await readBody(req); } catch (e) { body = {}; }
      let payload = {};
      if (Array.isArray(body.indexes) && body.indexes.length) {
        const sel = [...new Set(body.indexes.map(Number))].filter(i => Number.isSafeInteger(i) && i >= 1);
        if (!sel.length) return json(res, 400, { error: 'indexes 无效' });
        const accs = await fetchJson('/accounts');
        const all = (((accs || {}).accounts) || []).map(a => a.index).sort((a, b) => a - b);
        if (!all.length) return json(res, 502, { error: '无法读取账号列表' });
        const unknown = sel.filter(i => !all.includes(i));
        if (unknown.length) return json(res, 400, { error: '未知账号序号: ' + unknown.join(',') });
        if (sel.length >= all.length) payload = {}; // 全选 = 全量
        else payload = { excludedAccountIndexes: all.filter(i => !sel.includes(i)) };
      } else {
        const idx = Number(body.accountIndex);
        if (Number.isSafeInteger(idx) && idx >= 1) payload = { accountIndex: idx };
      }
      return proxyContainerApi('/start', 'POST', payload, res);
    }
    if (p === '/api/stop' && req.method === 'POST') {
      return proxyContainerApi('/stop', 'POST', {}, res);
    }
    if (p === '/api/overview') {
      // 聚合概览: 一次返回前端所需的全部数据(账号/余额/今日获得/运行状态/调度/历史)
      // 容器 API 不可达时仍回退 state.json, 保证打开页面即可见上次已知数据
      const [points, accounts, schedule] = await Promise.all([
        fetchJson('/points'),
        fetchJson('/accounts'),
        fetchJson('/schedule'),
      ]);
      const marketByEmail = (loadMarketData().accounts) || {};
      // 实时余额同步进 state(仅变化时写盘)
      let dirty = false;
      const liveAccounts = (points && points.accounts) || [];
      // partial 仅在运行进行中(points.running 且 startedAt 非空)同步:
      // 空闲时 /points 返回的是上一轮结果(startedAt=null, accounts[].collected 保留),
      // 若照常同步会把已完成账号的整轮积分重新写进 partial, 与 ACCOUNT-END
      // 已入账的 todayCollected 叠加导致"今日获得"翻倍(2026-09-05 修复)
      const runStartTs = points && points.running && points.startedAt ? Date.parse(points.startedAt) : null;
      const runActive = runStartTs != null && !Number.isNaN(runStartTs);
      for (const la of liveAccounts) {
        if (!la.email) continue;
        const a = ensureAccount(la.email);
        if (la.balance != null && (a.balance !== la.balance || a.dayStartDate !== todayStr())) { recordBalance(a, la.balance); dirty = true; }
        if (!runActive) continue;
        // 本轮未收到完成事件的账号: 其已得积分记入 partial(完成后由 ACCOUNT-END 正式入账并清零)
        const endedThisRun = a.lastEndTs != null && a.lastEndTs >= runStartTs;
        const partial = (!endedThisRun && la.collected != null && la.collected > 0) ? la.collected : 0;
        if ((a.partialCollected || 0) !== partial || a.partialDate !== todayStr()) {
          a.partialCollected = partial;
          a.partialDate = todayStr();
          dirty = true;
        }
      }
      if (dirty) saveState();
      const mapStatus = (st, live, runningNow) => {
        if (runningNow) return 'running';
        // 状态列 = 任务视角(待开始/进行中/已完成): 已完成必须经微软接口逐项实测全部通过;
        // 无实测数据(今日未体检/同步)时一律待开始, 不虚标
        const tk = (st && st.tasks && st.tasks.date === todayStr()) ? st.tasks : null;
        if (tk) {
          // 数据早于该账号最近一次运行完成时刻 → 已过期, 不按旧数据定状态
          const stale = tk.ts < (st.lastEndTs || st.lastRunTs || 0);
          if (!stale) {
            if (tk.allDone) return 'done';
            const dn = (tk.dailysetDone || 0) + (tk.searchDone || 0) + (tk.punchDone || 0);
            const tt = (tk.dailysetTotal || 0) + (tk.searchTotal || 0) + (tk.punchTotal || 0);
            if (tt > 0 && dn > 0) return 'progress';
          }
        }
        // 该账号的任务明细微软接口不返回(仅余额可得)且运行已成功完成 → 已完成
        if (st.tasksNA === todayStr() && st.lastStatus === 'success') return 'done';
        // 已成功运行但任务数据缺失/过期 → 已运行·待同步(运行结束的自动同步会补上)
        if (st.lastStatus === 'success') return 'sync-pending';
        return 'notstarted';
      };
      const build = (index, email, st, live) => {
        st = st || {};
        live = live || {};
        const runningNow = !!(points && points.running && points.currentAccount === email);
        // "今日获得"优先按微软余额接口口径: 当前余额 - 当日锚点(含一次性奖励/微软侧调整, 自校准);
        // 无锚点数据时回退日志累计
        const t = todayStr();
        const byBalance = (st.dayStartDate === t && st.dayStartBalance != null && st.balance != null)
          ? st.balance - st.dayStartBalance
          : null;
        return {
          index: index,
          email: email,
          balance: st.balance != null ? st.balance : (live.balance != null ? live.balance : null),
          balanceTs: st.balanceTs || null,
          todayCollected: byBalance != null ? byBalance : (st.todayCollected || 0) + (st.partialCollected || 0),
          todaySource: byBalance != null ? 'balance' : 'log',
          bonusCollected: st.bonusDate === t ? (st.bonusCollected || 0) : 0,
          tasksNA: st.tasksNA === t,
          tasksNA: st.tasksNA === t,
          todayTasks: (st.tasks && st.tasks.date === t) ? st.tasks : null,
          validity: st.validity || null,
          liveCollected: (points && points.running && live.collected != null) ? live.collected : null,
          status: mapStatus(st, live, runningNow),
          lastError: st.lastError || live.error || null,
          lastRunTs: st.lastRunTs || null,
          market: marketByEmail[email] || null,
        };
      };
      let all;
      if (accounts && accounts.accounts && accounts.accounts.length) {
        all = accounts.accounts.map(acc => Object.assign(
          build(acc.index, acc.email, state.accounts[acc.email], liveAccounts.find(x => x.email === acc.email)),
          { extra: Boolean(acc.extra) }
        ));
      } else {
        // 容器 API 不可达: 用持久化 state 兜底
        all = Object.keys(state.accounts)
          .filter(em => em && em.indexOf('@') > 0)
          .map((em, i) => build(i + 1, em, state.accounts[em], null));
      }
      const summary = {
        count: all.length,
        totalBalance: all.reduce((s, a) => s + (a.balance || 0), 0),
        totalToday: all.reduce((s, a) => s + (a.todayCollected || 0), 0),
      };
      // 预计完成时间: 最近完成账号的平均耗时 x 剩余账号 + 当前账号剩余
      let eta = null;
      if (points && points.live && state.currentRun && state.currentRun.cur) {
        const durations = state.durations || [];
        if (durations.length) {
          const meanMin = durations.reduce((x, y) => x + y, 0) / durations.length;
          const doneCount = liveAccounts.filter((x) => x.done).length;
          const curLive = liveAccounts.find((x) => x.email === state.currentRun.cur.email);
          const pending = Math.max(0, liveAccounts.length - doneCount - (curLive && !curLive.done ? 1 : 0));
          const elapsedMin = Math.max(0, (Date.now() - state.currentRun.cur.startedAt) / 60000);
          const remainMin = Math.max(1, Math.round(pending * meanMin + Math.max(meanMin - elapsedMin, 0)));
          eta = {
            etaTs: Date.now() + remainMin * 60000,
            remainMin,
            meanMin: Math.round(meanMin),
            pending,
            sample: durations.length,
          };
        }
      }
      return json(res, 200, {
        today: todayStr(),
        serverTime: Date.now(),
        run: points ? {
          state: points.state, running: points.running,
          currentAccount: points.currentAccount, startedAt: points.startedAt,
          collected: points.collected, finished: points.finished,
          accountsTotal: points.accountsTotal,
        } : null,
        accounts: all,
        summary: summary,
        eta: eta,
        schedule: schedule,
        sync: syncAllSummary(),
        history: state.runs.slice(0, 10),
      });
    }

    if (p === '/api/login-check' && req.method === 'POST') {
      let body = {};
      try { body = await readBody(req); } catch (e) { body = {}; }
      const index = Number(body.accountIndex);
      if (!Number.isSafeInteger(index) || index < 1) return json(res, 400, { error: 'accountIndex 无效' });
      const accs = await fetchJson('/accounts');
      const acc = (((accs || {}).accounts) || []).find(a => a.index === index);
      if (!acc) return json(res, 400, { error: '未知账号序号: ' + index });
      const r = startLoginCheck(index, acc.email);
      if (r.error) return json(res, r.code === 'BUSY' ? 409 : 400, r);
      return json(res, 202, r);
    }
    if (p === '/api/login-check/status' && req.method === 'GET') {
      return json(res, 200, loginCheckStatus());
    }
    if (p === '/api/market-probe' && req.method === 'POST') {
      // 空闲检查放行后才 spawn: 浏览器任务与 run 并发会挤兑容器内存
      const pts = await fetchJson('/points');
      if (pts && (pts.running || pts.state === 'running')) return json(res, 409, { error: '脚本运行中, 请等运行结束后再检测区域', code: 'BUSY' });
      const r = startMarketProbe('manual');
      if (r.error) return json(res, r.code === 'BUSY' ? 409 : 400, r);
      return json(res, 202, r);
    }
    if (p === '/api/market-probe/status' && req.method === 'GET') {
      return json(res, 200, marketProbeStatus());
    }
    if (p === '/api/market' && req.method === 'GET') {
      const md = loadMarketData();
      return json(res, 200, { accounts: md.accounts || {}, updatedAt: md.updatedAt || null });
    }
    if (p === '/api/sync-all' && req.method === 'POST') {
      const r = syncAllStart('manual');
      if (r.error) return json(res, r.code === 'BUSY' ? 409 : 400, r);
      return json(res, 202, r);
    }
    if (p === '/api/manual-login' && req.method === 'POST') {
      let body = {};
      try { body = await readBody(req); } catch (e) { body = {}; }
      const index = Number(body.accountIndex);
      if (!Number.isSafeInteger(index) || index < 1) return json(res, 400, { error: 'accountIndex 无效' });
      const r = await startManualLogin(index);
      if (r.error) return json(res, r.code === 'BUSY' ? 409 : 400, r);
      return json(res, 202, r);
    }
    if (p === '/api/manual-login/status' && req.method === 'GET') {
      return json(res, 200, manualLoginStatus());
    }
    if (p === '/api/manual-login/stop' && req.method === 'POST') {
      if (!manualLoginSession) return json(res, 409, { error: '无进行中的人工登录会话' });
      mlStop(manualLoginSession, 'user-stopped');
      return json(res, 202, { stopping: true });
    }
    if (p.startsWith('/manual-vnc/')) {
      return handleNovncHttp(req, res);
    }

    if (p === '/api/accounts-manage' && req.method === 'GET') {
      const list = readExtraFile();
      return json(res, 200, {
        accounts: list.filter(e => e.removed !== true).map(e => ({
          email: e.email,
          geoLocale: e.geoLocale || 'auto',
          hasPassword: Boolean(e.password),
          hasTotp: Boolean(e.totpSecret),
        })),
        removed: list.filter(e => e.removed === true).map(e => e.email),
      });
    }
    if (p === '/api/accounts-manage' && req.method === 'POST') {
      let body = {};
      try { body = await readBody(req); } catch (e) { body = {}; }
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const geoLocale = String(body.geoLocale || 'cn').trim() || 'cn';
      const totpSecret = String(body.totpSecret || '').trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { error: '邮箱格式不正确' });
      if (!password) return json(res, 400, { error: '密码不能为空' });
      const accs = await fetchJson('/accounts');
      const knownEmails = (((accs || {}).accounts) || []).map(a => String(a.email || '').toLowerCase());
      const list = readExtraFile().filter(e => !(e.removed === true && String(e.email || '').toLowerCase() === email));
      if (list.some(e => String(e.email || '').toLowerCase() === email)) {
        return json(res, 409, { error: '该账号已存在' });
      }
      list.push({ email, password, geoLocale, langCode: 'en', totpSecret });
      if (!writeExtraFile(list)) return json(res, 500, { error: '写入失败' });
      return json(res, 200, { ok: true, count: list.length });
    }
    if (p === '/api/accounts-manage/delete' && req.method === 'POST') {
      let body = {};
      try { body = await readBody(req); } catch (e) { body = {}; }
      const email = String(body.email || '').trim().toLowerCase();
      const accs = await fetchJson('/accounts');
      const known = (((accs || {}).accounts) || []).map(a => String(a.email || '').toLowerCase());
      if (!known.includes(email)) return json(res, 404, { error: '未知账号' });
      if (known.length <= 1) return json(res, 400, { error: '至少需要保留一个账号' });
      const list = readExtraFile();
      const isDynamic = list.some(e => String(e.email || '').toLowerCase() === email);
      let next;
      if (isDynamic) {
        next = list.filter(e => String(e.email || '').toLowerCase() !== email);
      } else {
        next = list.filter(e => String(e.email || '').toLowerCase() !== email);
        next.push({ email, removed: true });
      }
      const removedAfter = new Set(next.filter(e => e.removed === true).map(e => String(e.email).toLowerCase()));
      if (!known.some(a => !removedAfter.has(String(a.email || '').toLowerCase()))) {
        return json(res, 400, { error: '至少需要保留一个账号' });
      }
      if (!writeExtraFile(next)) return json(res, 500, { error: '写入失败' });
      return json(res, 200, { ok: true, count: next.length });
    }

    if (p === '/api/account-logs' && req.method === 'GET') {
      const user = url.searchParams.get('user') || '';
      const arr = accountLogs.get(user) || [];
      const lines = arr.slice(-200).map((e) => '[' + new Date(e.ts).toLocaleString('zh-CN') + '] [' + e.level + '] ' + e.platform + ' [' + e.title + '] ' + e.message);
      return json(res, 200, { user, lines, count: lines.length });
    }
    if (p === '/api/account-log-dates' && req.method === 'GET') {
      return json(res, 200, { dates: accountLogDates() });
    }
    if (p === '/api/account-history' && req.method === 'GET') {
      const user = (url.searchParams.get('user') || '').trim();
      const date = url.searchParams.get('date') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: 'date 无效' });
      const tag = user.split('@')[0].replace(/[^\w.-]/g, '');
      if (!tag) return json(res, 400, { error: 'user 无效' });
      let lines = [];
      try {
        const file = path.join(SCRIPT_LOGS_DIR, date + '.log');
        if (fs.existsSync(file)) {
          lines = fs.readFileSync(file, 'utf8').split('\n')
            .filter(l => l.indexOf('[' + tag + ']') >= 0)
            .map(l => l.length > 600 ? l.slice(0, 600) + '…' : l);
          if (lines.length > 1000) lines = lines.slice(-1000);
        }
      } catch (e) { /* 读失败返回空 */ }
      return json(res, 200, { user, date, lines, count: lines.length });
    }
    if (p === '/api/capabilities' && req.method === 'GET') {
      const cfg = await fetchJson('/config');
      const sch = await fetchJson('/schedule');
      const c = (cfg && cfg.config) || {};
      const ss = c.searchSettings || {};
      return json(res, 200, {
        capabilities: {
          clusters: c.clusters ?? 1,
          queryEngines: ss.queryEngines || ['china', 'local'],
          appkeyConfigured: Boolean(ss.chinaApi && ss.chinaApi.appkey),
          searchDelay: { min: (ss.searchDelay || {}).min || '5min', max: (ss.searchDelay || {}).max || '9min' },
          workers: c.workers || {},
        },
        schedule: sch ? { enabled: Boolean(sch.enabled), cron: sch.cron || '' } : null,
      });
    }
    if (p === '/api/capabilities' && req.method === 'PUT') {
      let body = {};
      try { body = await readBody(req); } catch (e) { body = {}; }
      const patch = {};
      if (body.clusters != null) {
        const n = Number(body.clusters);
        if (!Number.isSafeInteger(n) || n < 1 || n > 3) return json(res, 400, { error: 'clusters 仅支持 1-3' });
        patch.clusters = n;
      }
      const ss = {};
      if (Array.isArray(body.queryEngines) && body.queryEngines.length) ss.queryEngines = body.queryEngines;
      if (body.appkey != null && String(body.appkey).trim() !== '') {
        ss.chinaApi = { appkey: String(body.appkey).trim() };
      }
      if (body.delayMin || body.delayMax) {
        ss.searchDelay = { min: String(body.delayMin), max: String(body.delayMax) };
      }
      if (Object.keys(ss).length) patch.searchSettings = ss;
      if (body.workers && typeof body.workers === 'object') patch.workers = body.workers;
      if (!Object.keys(patch).length) return json(res, 400, { error: '没有需要保存的变更' });
      return proxyContainerApi('/config', 'PATCH', patch, res);
    }
    if (p === '/api/capabilities/schedule' && req.method === 'PUT') {
      let body = {};
      try { body = await readBody(req); } catch (e) { body = {}; }
      return proxyContainerApi('/schedule', 'PUT', { enabled: Boolean(body.enabled), cron: String(body.cron || '') }, res);
    }
    if (p === '/api/accounts-manage/password' && req.method === 'POST') {
      let body = {};
      try { body = await readBody(req); } catch (e) { body = {}; }
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: '邮箱格式不正确' });
      if (!password) return json(res, 400, { error: '新密码不能为空' });
      const list = readExtraFile();
      const entry = list.find((e) => String(e.email || '').toLowerCase() === email);
      if (entry) entry.password = password;
      else list.push({ email, password });
      if (!writeExtraFile(list)) return json(res, 500, { error: '写入失败' });
      return json(res, 200, { ok: true, note: '密码已更新，下一次运行自动生效（覆盖层机制，固定账号亦适用）' });
    }

    if (p === '/api/accounts-manage/geo' && req.method === 'POST') {
      let body = {};
      try { body = await readBody(req); } catch (e) { body = {}; }
      const email = String(body.email || '').trim().toLowerCase();
      const geoLocale = String(body.geoLocale || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: '邮箱格式不正确' });
      if (geoLocale !== 'auto' && !/^[a-z]{2}(-[a-z]{2})?$/.test(geoLocale)) return json(res, 400, { error: '地区格式不正确，示例: cn / gb / us / auto' });
      const list = readExtraFile();
      const entry = list.find((e) => String(e.email || '').toLowerCase() === email);
      if (entry) entry.geoLocale = geoLocale;
      else list.push({ email, geoLocale, langCode: 'en' });
      if (!writeExtraFile(list)) return json(res, 500, { error: '写入失败' });
      return json(res, 200, { ok: true, geoLocale, note: '地区已更新，下一次运行自动生效' });
    }

    // ---- 前端页面 ----
    if (p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }
    if (p === '/favicon.ico') {
      res.writeHead(204); return res.end();
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

function fetchJson(apiPath) {
  return new Promise((resolve) => {
    if (!API_TOKEN) return resolve(null);
    const req = http.get(
      { hostname: '127.0.0.1', port: API_PORT, path: apiPath, headers: { Authorization: 'Bearer ' + API_TOKEN } },
      (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); }); // 防容器 API 挂起导致页面永久"连接中"
  });
}

function postJson(apiPath, body) {
  return new Promise((resolve) => {
    if (!API_TOKEN) return resolve(null);
    const data = JSON.stringify(body || {});
    const req = http.request(
      {
        hostname: '127.0.0.1', port: API_PORT, path: apiPath, method: 'POST',
        headers: {
          Authorization: 'Bearer ' + API_TOKEN,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      },
      (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ raw: b }); } });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}

// ============ 前端页面 ============
// 注意: 本 HTML 位于反引号模板字符串内 —— 内联 JS 禁用反引号/模板插值/${ 与反斜杠转义(含正则与 \n),
// 否则会被模板字面量二次解释导致下发页面语法错误(曾因此整页 JS 失效)。
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MS-Rewards 积分看板</title>
<style>
  :root { --ms-blue:#0078d4; --bg:#f3f5f7; --card:#ffffff; --text:#242424; --muted:#8a8f98; --ok:#107c10; --err:#d13438; --warn:#d28b00; --border:#e3e6ea; --radius:12px; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--text); }
  .wrap { max-width:1180px; margin:0 auto; padding:18px 16px 50px; }
  header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:14px; }
  header h1 { font-size:20px; margin:0; display:flex; align-items:center; gap:8px; }
  .logo { color:var(--ms-blue); }
  .status-pill { font-size:12px; padding:4px 10px; border-radius:20px; background:#e5f1fb; color:var(--ms-blue); white-space:nowrap; }
  .status-pill.running { background:#e6f4ea; color:var(--ok); }
  .status-pill.error { background:#fdecea; color:var(--err); }
  .toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .btn { border:0; border-radius:8px; padding:8px 16px; font-size:13px; cursor:pointer; background:var(--ms-blue); color:#fff; }
  .btn.secondary { background:#eef1f4; color:var(--text); }
  .btn.small { padding:5px 10px; font-size:12px; }
  .btn:disabled { opacity:.5; cursor:not-allowed; }
  .menu { position:relative; }
  .menu-drop { position:absolute; right:0; top:calc(100% + 6px); background:var(--card); border:1px solid var(--border); border-radius:10px; box-shadow:0 6px 24px rgba(0,0,0,.12); padding:8px; min-width:240px; z-index:50; display:none; }
  .menu-drop.show { display:block; }
  .menu-item { display:flex; width:100%; text-align:left; padding:8px 10px; border:0; background:none; border-radius:8px; font-size:13px; cursor:pointer; align-items:center; gap:8px; color:var(--text); }
  .menu-item:hover { background:#f0f4f8; }
  .menu-sep { border-top:1px solid var(--border); margin:6px 4px; }
  .menu-label { font-size:11px; color:var(--muted); padding:4px 10px 2px; }
  .iv-row { display:flex; gap:6px; padding:4px 8px 8px; flex-wrap:wrap; }
  .iv-btn { border:1px solid var(--border); background:#fff; border-radius:8px; padding:4px 10px; font-size:12px; cursor:pointer; color:var(--text); }
  .iv-btn.active { background:var(--ms-blue); color:#fff; border-color:var(--ms-blue); }
  .summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:12px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:var(--radius); padding:12px 16px; }
  .sub { font-size:12px; color:var(--muted); }
  .card .num { font-size:22px; font-weight:700; margin-top:2px; font-variant-numeric:tabular-nums; }
  .selbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; background:var(--card); border:1px solid var(--border); border-radius:var(--radius); padding:8px 14px; margin-bottom:10px; font-size:13px; }
  .selbar .grow { flex:1; }
  .tblwrap { background:var(--card); border:1px solid var(--border); border-radius:var(--radius); overflow:auto; max-height:58vh; }
  table.acc { width:100%; min-width:780px; border-collapse:collapse; font-size:13px; }
  table.acc th { position:sticky; top:0; background:#f8fafb; z-index:1; text-align:left; padding:9px 10px; border-bottom:1px solid var(--border); color:var(--muted); font-weight:500; white-space:nowrap; }
  table.acc td { padding:8px 10px; border-bottom:1px solid #eef1f3; vertical-align:middle; }
  table.acc tr:hover td { background:#f6f9fc; }
  table.acc td.num, table.acc th.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  td.em { font-weight:600; word-break:break-all; min-width:180px; }
  .ts { font-size:11px; color:var(--muted); font-weight:400; margin-top:1px; }
  .badge { display:inline-block; font-size:11px; padding:2px 8px; border-radius:10px; background:#f0f2f4; color:var(--muted); white-space:nowrap; }
  .badge.ok { background:#e6f4ea; color:var(--ok); }
  .badge.err { background:#fdecea; color:var(--err); }
  .badge.run { background:#fff4e0; color:var(--warn); }
  .badge.progress { background:#e5f1fb; color:var(--ms-blue); }
  .errbadge { display:inline-block; color:var(--err); border:1px solid var(--err); border-radius:999px; font-size:12px; line-height:1.6; padding:0 9px; cursor:pointer; white-space:nowrap; user-select:none; }
  .errbadge:hover { background:rgba(220,80,80,.12); }
  .hint { font-size:12px; color:var(--muted); margin-top:8px; line-height:1.6; }
  .msg { padding:10px 14px; border-radius:8px; margin:10px 0; font-size:13px; display:none; }
  .msg.show { display:block; }
  .msg.err { background:#fdecea; color:var(--err); }
  input[type=checkbox] { width:16px; height:16px; cursor:pointer; }
  input[type=text], input[type=password] { width:100%; padding:8px 10px; border:1px solid var(--border); border-radius:8px; font-size:14px; margin-top:4px; }
  .field { margin-bottom:12px; }
  .field label { font-size:13px; color:var(--muted); }
  .switch-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 0; border-bottom:1px solid var(--border); }
  .switch-row:last-child { border-bottom:0; }
  .switch { position:relative; width:42px; height:24px; flex-shrink:0; }
  .switch input { opacity:0; width:0; height:0; }
  .slider { position:absolute; inset:0; background:#ccc; border-radius:24px; transition:.2s; cursor:pointer; }
  .slider:before { content:""; position:absolute; width:18px; height:18px; left:3px; top:3px; background:#fff; border-radius:50%; transition:.2s; }
  .switch input:checked + .slider { background:var(--ok); }
  .switch input:checked + .slider:before { transform:translateX(18px); }
  .grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:10px 18px; }
  @media (max-width:640px) { .grid-2 { grid-template-columns:1fr; } }
  dialog { border:1px solid var(--border); border-radius:var(--radius); padding:20px; width:min(680px, 94vw); max-height:88vh; overflow:auto; }
  dialog::backdrop { background:rgba(0,0,0,.35); }
  dialog h2 { margin:0 0 14px; font-size:16px; }
  dialog#mlModal { width:min(980px, 97vw); }
  .rowact { white-space:nowrap; }
  .rowact .btn { padding:3px 8px; font-size:12px; }
  .btn.danger { background:var(--err); color:#fff; }
  .pw-row { display:flex; align-items:center; gap:8px; }
  .eye { border:0; background:#eef1f4; border-radius:8px; cursor:pointer; padding:8px 10px; font-size:14px; margin-top:4px; }
  details.history { background:var(--card); border:1px solid var(--border); border-radius:var(--radius); padding:12px 16px; margin-top:14px; }
  details.history summary { cursor:pointer; font-size:14px; font-weight:600; }
  table.hist { width:100%; border-collapse:collapse; font-size:12.5px; margin-top:10px; }
  table.hist th, table.hist td { text-align:left; padding:6px 8px; border-bottom:1px solid #eef1f3; white-space:nowrap; }
  table.hist th { color:var(--muted); font-weight:500; }
  .foot { color:var(--muted); font-size:12px; text-align:center; margin-top:26px; }
  .empty { color:var(--muted); padding:18px; text-align:center; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1><span class="logo">🅱️</span> MS-Rewards 积分看板</h1>
    <div class="toolbar">
      <span id="conn" class="status-pill">连接中…</span>
      <span id="runState" class="status-pill">空闲</span>
      <button class="btn secondary" id="btnStop" onclick="doStop()">⏹ 停止</button>
      <div class="menu">
        <button class="btn secondary" onclick="toggleMenu(event)">⚙ 菜单</button>
        <div class="menu-drop" id="menuDrop">
          <button class="menu-item" onclick="openCap(); closeMenu()">🎛 能力控制（并行/词源/调度）</button>
          <button class="menu-item" onclick="openAccounts(); closeMenu()">👥 账号管理（动态添加）</button>
          <button class="menu-item" onclick="openPush(); closeMenu()">🔔 通知设置（钉钉推送）</button>
          <button class="menu-item" onclick="manualRefresh(); closeMenu()">⟳ 立即刷新</button>
          <div class="menu-sep"></div>
          <div class="menu-label">自动刷新间隔（当前 <span id="ivCur">15 秒</span>）</div>
          <div class="iv-row">
            <button class="iv-btn" data-ms="0" onclick="setRefresh(0)">关闭</button>
            <button class="iv-btn" data-ms="5000" onclick="setRefresh(5000)">5 秒</button>
            <button class="iv-btn" data-ms="15000" onclick="setRefresh(15000)">15 秒</button>
            <button class="iv-btn" data-ms="30000" onclick="setRefresh(30000)">30 秒</button>
            <button class="iv-btn" data-ms="60000" onclick="setRefresh(60000)">60 秒</button>
          </div>
        </div>
      </div>
    </div>
  </header>

  <div id="diag" class="msg err"></div>

  <div class="summary">
    <div class="card"><div class="sub">账号总数</div><div class="num" id="sumAccounts">-</div></div>
    <div class="card"><div class="sub">总余额（上次已知）</div><div class="num" id="sumBalance">-</div></div>
    <div class="card"><div class="sub">今日获得（<span id="todayLabel">-</span>）</div><div class="num" style="color:var(--ok)" id="sumToday">-</div></div>
    <div class="card"><div class="sub">当前运行</div><div class="num" id="runInfo" style="font-size:14px;line-height:1.55;font-weight:600">-</div></div>
  </div>

  <div class="selbar">
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="selAll" onchange="toggleAll(this.checked)"> 全选</label>
    <span id="selInfo" class="sub">未选择账号时默认运行全部</span>
    <div class="grow"></div>
    <button class="btn small secondary" onclick="selectVisible(false)">清空选择</button>
    <button class="btn" id="btnRun" onclick="doRun()">▶ 运行</button>
    <button class="btn small secondary" id="btnSync" onclick="doSyncAll()" title="逐个账号经微软接口实测余额与任务完成度(轻量, 不开浏览器, 每号约 2 秒)">🔄 同步余额</button>
    <button class="btn small secondary" id="btnMarket" onclick="doMarketProbe()" title="恢复每号会话打开一次兑换页: 检测兑换市场(归属目录)与当前服务区域, 约 40-60 秒/号, 共约 5 分钟; 仅脚本空闲时可跑">🌏 检测区域</button>
  </div>

  <div class="tblwrap">
    <table class="acc">
      <thead><tr>
        <th style="width:34px"></th>
        <th style="width:36px">#</th>
        <th>账号</th>
        <th class="num">余额</th>
        <th class="num" title="微软余额接口口径: 当前余额 - 当日锚点余额。一次性奖励、微软侧积分调整都会如实计入">今日获得</th>
        <th title="微软接口逐项实测(当日每日任务集 + 搜索计数器 + 打卡子任务); 点 🩺 体检或 🔄 同步余额 时更新。已完成 = 全部逐项通过">任务</th>
        <th style="width:76px">状态</th>
        <th style="width:112px">最近活动</th>
        <th>备注 / 错误</th>
        <th style="width:84px">操作</th>
      </tr></thead>
      <tbody id="accRows"><tr><td colspan="10" class="empty">加载中…</td></tr></tbody>
    </table>
  </div>
  <div class="hint">余额为脚本最近一次成功运行时的已知值，打开页面即可见、无需等待运行；「今日获得」按微软余额接口口径计算（当日余额 − 当日起点余额），一次性奖励与微软侧调整会如实计入，跨天自动归零。勾选账号后点「运行」只跑选中的账号；不勾选则跑全部。</div>

  <details class="history">
    <summary>📜 运行历史（最近 10 次）与调度</summary>
    <div id="scheduleBox" class="hint" style="margin:8px 0"></div>
    <table class="hist">
      <thead><tr><th>开始</th><th>结束</th><th>账号明细</th><th class="num">本次获得</th><th class="num">总余额</th></tr></thead>
      <tbody id="histRows"><tr><td colspan="5" class="empty">暂无运行记录</td></tr></tbody>
    </table>
  </details>

  <dialog id="pushModal">
    <h2>🔔 推送设置（钉钉）</h2>
    <div class="grid-2">
      <div>
        <div class="field"><label>钉钉 access_token</label><div class="pw-row"><input type="password" id="ddToken" placeholder="钉钉机器人 token"><button type="button" class="eye" onclick="togglePass('ddToken',this)">👁</button></div></div>
        <div class="field"><label>加签 SECRET（无则留空）</label><div class="pw-row"><input type="password" id="ddSecret" placeholder="SEC…"><button type="button" class="eye" onclick="togglePass('ddSecret',this)">👁</button></div></div>
        <div class="field"><label>自定义关键词（消息前缀）</label><input type="text" id="ddKeyword" placeholder="MS-Rewards"></div>
        <div class="field"><label>同类事件去重（秒）</label><input type="text" id="ddDedup" placeholder="10"></div>
        <div class="switch-row"><span>钉钉推送总开关</span><label class="switch"><input type="checkbox" id="ddEnabled"><span class="slider"></span></label></div>
      </div>
      <div>
        <div class="switch-row"><span>🚀 开始运行</span><label class="switch"><input type="checkbox" id="ev-runStart"><span class="slider"></span></label></div>
        <div class="switch-row"><span>✅ 全部完成</span><label class="switch"><input type="checkbox" id="ev-runEnd"><span class="slider"></span></label></div>
        <div class="switch-row"><span>👤 账号完成</span><label class="switch"><input type="checkbox" id="ev-accountEnd"><span class="slider"></span></label></div>
        <div class="switch-row"><span>❌ 错误</span><label class="switch"><input type="checkbox" id="ev-error"><span class="slider"></span></label></div>
        <div class="switch-row"><span>⚠️ 登录/风控异常</span><label class="switch"><input type="checkbox" id="ev-loginFail"><span class="slider"></span></label></div>
        <div class="switch-row"><span>📊 运行摘要（每日）</span><label class="switch"><input type="checkbox" id="ev-dailySummary"><span class="slider"></span></label></div>
      </div>
    </div>
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
      <div class="field"><label>📧 邮件通知（与钉钉并存，事件同时发邮件）</label>
        <div class="switch-row" style="border:0;padding:4px 0"><span>启用邮件通知</span><label class="switch"><input type="checkbox" id="emEnabled"><span class="slider"></span></label></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>SMTP 服务器（如 smtp.qq.com）</label><input type="text" id="emHost" placeholder="smtp.qq.com"></div>
        <div class="field"><label>端口（465=SSL，587=STARTTLS）</label><input type="text" id="emPort" placeholder="465"></div>
        <div class="field"><label>发件邮箱（登录账号）</label><input type="text" id="emUser" placeholder="you@qq.com"></div>
        <div class="field"><label>SMTP 授权码（不是登录密码）</label><div class="pw-row"><input type="password" id="emPass" placeholder="授权码"><button type="button" class="eye" onclick="togglePass('emPass',this)">👁</button></div></div>
        <div class="field"><label>收件邮箱（多个用逗号分隔）</label><input type="text" id="emTo" placeholder="target@example.com"></div>
      </div>
    </div>
    <div class="hint">钉钉安全设置：自定义关键词需与机器人配置一致，或使用加签模式（填 SECRET）。修改后点「保存」即时生效，无需重启服务。</div>
    <div class="toolbar" style="margin-top:14px">
      <button class="btn" onclick="savePush()">💾 保存</button>
      <button class="btn secondary" onclick="testPush()">🧪 测试推送</button>
      <button class="btn secondary" onclick="closePush()">关闭</button>
      <span id="pushMsg" class="sub"></span>
    </div>
  </dialog>

  <dialog id="mlModal">
    <h2>🔑 人工登录 <span id="mlEmail" style="color:var(--ms-blue)"></span></h2>
    <div class="hint">容器内浏览器已打开(先移动端、后桌面端, 依次完成)。在下方窗口完成微软登录;停留在 Rewards 页面 5 秒会自动保存会话并进入下一平台, 两个平台都完成后自动结束。关闭本弹窗会中止会话(已保存的平台不受影响)。</div>
    <iframe id="mlFrame" style="width:100%;height:540px;border:1px solid var(--border);border-radius:8px;background:#111"></iframe>
    <div class="sub" id="mlStatus" style="margin-top:8px"></div>
    <div class="toolbar" style="margin-top:10px">
      <button class="btn" onclick="mlClose()">关闭并中止</button>
    </div>
  </dialog>

  <dialog id="acctModal">
    <h2>👥 账号管理</h2>
    <div class="hint">全部账号均可 🌏 改地区、🔑 改密与 🗑 删除，<b>下一次运行自动生效</b>（每日定时或手动触发均可），无需重启容器；删除的账号重新添加即可恢复。账号数据保存在 config 卷的 accounts.json。新增账号首次运行需要自动登录，若遇微软身份验证卡点，用主表格对应行的 🔑 人工登录完成。</div>
    <table class="hist" style="margin-bottom:14px">
      <thead><tr><th>账号</th><th>地区</th><th>2FA</th><th style="width:150px">操作</th></tr></thead>
      <tbody id="acctRows"><tr><td colspan="4" class="empty">加载中…</td></tr></tbody>
    </table>
    <div class="grid-2">
      <div>
        <div class="field"><label>邮箱</label><input type="text" id="naEmail" placeholder="user@example.com"></div>
        <div class="field"><label>密码</label><div class="pw-row"><input type="password" id="naPass" placeholder="微软账号密码"><button type="button" class="eye" onclick="togglePass('naPass',this)">👁</button></div></div>
        <div class="field"><label>地区（搜索环境语言/市场，默认国区 cn）</label>
          <select id="naGeo" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;margin-top:4px">
            <option value="cn" selected>cn（国区）</option><option value="gb">gb（英国）</option><option value="us">us（美国）</option><option value="auto">auto（自动）</option><option value="de">de</option><option value="fr">fr</option><option value="jp">jp</option><option value="ca">ca</option><option value="au">au</option>
          </select>
        </div>
        <div class="field"><label>2FA 密钥（无则留空）</label><input type="text" id="naTotp" placeholder="可选"></div>
      </div>
      <div class="hint" style="padding-top:6px">
        说明：<br>· 动态账号与 .env 固定账号在运行、体检、人工登录中完全等价；<br>· 序号从 901 起编（批量勾选运行时可见）；<br>· 凭据明文存放于 config 卷（600 权限），请勿暴露该目录；<br>· 删除动态账号不会清除其已保存的登录会话，如需彻底清理请用容器 API 的 DELETE /sessions/:邮箱。
      </div>
    </div>
    <div class="toolbar" style="margin-top:14px">
      <button class="btn" onclick="addAccount()">➕ 添加账号</button>
      <button class="btn secondary" onclick="closeAccounts()">关闭</button>
      <span id="acctMsg" class="sub"></span>
    </div>
  </dialog>

  <dialog id="capModal">
    <h2>🎛 能力控制</h2>
    <div class="hint">设置写入容器 config.json，<b>下一次运行自动生效</b>，无需重启容器。</div>
    <div class="grid-2">
      <div>
        <div class="field"><label>并行集群数（一次运行同时处理的账号数，内存随集群数增加）</label>
          <select id="capClusters" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;margin-top:4px">
            <option value="1">1（串行，最省内存）</option><option value="2">2（推荐）</option><option value="3">3（内存紧张）</option>
          </select>
        </div>
        <div class="field"><label>搜索词源</label>
          <select id="capEngines" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;margin-top:4px">
            <option value="china,local">中国热搜 + 本地兜底（推荐）</option>
            <option value="china">仅中国热搜</option>
            <option value="google,local">Google Trends + 本地</option>
            <option value="local">仅本地词库</option>
          </select>
        </div>
        <div class="field"><label>gmya appkey（解除免费档限流；留空=不修改）</label><input type="text" id="capAppkey" placeholder="已配置则显示占位符"></div>
        <div class="field"><label>搜索间隔（反风控核心参数，越快风险越高）</label>
          <select id="capDelay" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;margin-top:4px">
            <option value="6,12">稳妥 6-12 分钟</option>
            <option value="5,9">标准 5-9 分钟（当前）</option>
            <option value="4,8">较快 4-8 分钟</option>
            <option value="3,6">激进 3-6 分钟（风险自担）</option>
          </select>
        </div>
      </div>
      <div>
        <div class="field"><label>每日调度时间</label>
          <div class="pw-row">
            每天 <select id="capCronHour" style="padding:6px 8px;border:1px solid var(--border);border-radius:8px;font-size:13px"></select> 点
            <select id="capCronMin" style="padding:6px 8px;border:1px solid var(--border);border-radius:8px;font-size:13px"><option value="0">00</option><option value="15">15</option><option value="30" selected>30</option><option value="45">45</option></select> 分
          </div>
        </div>
        <div class="switch-row"><span>启用每日定时</span><label class="switch"><input type="checkbox" id="capCronOn" checked><span class="slider"></span></label></div>
        <div class="hint">调度写入 config/schedule.json 并即时重装容器内 crontab（优先于 CRON_SCHEDULE 环境变量）。</div>
      </div>
    </div>
    <div class="field"><label>任务开关（关闭的板块在后续运行中跳过）</label>
      <div class="grid-2" style="font-size:13px">
        <div class="switch-row"><span>每日任务集</span><label class="switch"><input type="checkbox" id="w-doDailySet" checked><span class="slider"></span></label></div>
        <div class="switch-row"><span>桌面搜索</span><label class="switch"><input type="checkbox" id="w-doDesktopSearch" checked><span class="slider"></span></label></div>
        <div class="switch-row"><span>移动搜索</span><label class="switch"><input type="checkbox" id="w-doMobileSearch" checked><span class="slider"></span></label></div>
        <div class="switch-row"><span>每日签到</span><label class="switch"><input type="checkbox" id="w-doDailyCheckIn" checked><span class="slider"></span></label></div>
        <div class="switch-row"><span>读赚</span><label class="switch"><input type="checkbox" id="w-doReadToEarn" checked><span class="slider"></span></label></div>
        <div class="switch-row"><span>特殊活动</span><label class="switch"><input type="checkbox" id="w-doSpecialPromotions" checked><span class="slider"></span></label></div>
        <div class="switch-row"><span>更多活动</span><label class="switch"><input type="checkbox" id="w-doMorePromotions" checked><span class="slider"></span></label></div>
        <div class="switch-row"><span>打卡任务</span><label class="switch"><input type="checkbox" id="w-doPunchCards" checked><span class="slider"></span></label></div>
        <div class="switch-row"><span>App 任务</span><label class="switch"><input type="checkbox" id="w-doAppPromotions" checked><span class="slider"></span></label></div>
        <div class="switch-row"><span>领取奖励积分</span><label class="switch"><input type="checkbox" id="w-doClaimBonusPoints" checked><span class="slider"></span></label></div>
        <div class="switch-row"><span>搜索加成激活</span><label class="switch"><input type="checkbox" id="w-doActivateSearchPerk" checked><span class="slider"></span></label></div>
        <div class="switch-row"><span>额外搜索</span><label class="switch"><input type="checkbox" id="w-doBonusSearches"><span class="slider"></span></label></div>
        <div class="switch-row"><span>视觉搜索</span><label class="switch"><input type="checkbox" id="w-doVisualSearch"><span class="slider"></span></label></div>
      </div>
    </div>
    <div class="toolbar" style="margin-top:14px">
      <button class="btn" onclick="saveCap()">💾 保存</button>
      <button class="btn secondary" onclick="closeCap()">关闭</button>
      <span id="capMsg" class="sub"></span>
    </div>
  </dialog>

  <dialog id="logsModal">
    <h2>📜 运行日志 <span id="logsEmail" style="color:var(--ms-blue)"></span></h2>
    <div class="toolbar" style="margin-bottom:8px">
      <label class="sub">日期:</label>
      <select id="logsDate" onchange="onLogsDateChange()" style="padding:6px 8px;border:1px solid var(--border);border-radius:8px;font-size:13px"><option value="">加载中…</option></select>
      <span class="sub">历史按天读取脚本日志文件, 保留 7 天</span>
    </div>
    <pre id="logsBox" style="background:#101418;color:#cde3d8;font-size:12px;line-height:1.5;padding:12px;border-radius:8px;max-height:60vh;overflow:auto;white-space:pre-wrap;word-break:break-all">加载中…</pre>
    <div class="toolbar" style="margin-top:10px">
      <button class="btn secondary" onclick="closeLogs()">关闭</button>
      <span class="sub" id="logsHint">实时模式: 每 3 秒自动刷新(内存缓存最近 300 条)</span>
    </div>
  </dialog>

  <dialog id="errModal">
    <h2>⚠ 错误详情 <span id="errEmail" style="color:var(--ms-blue)"></span></h2>
    <div class="sub" id="errTime" style="margin-bottom:8px"></div>
    <pre id="errBox" style="background:#101418;color:#ffb4b4;font-size:12px;line-height:1.5;padding:12px;border-radius:8px;max-height:55vh;overflow:auto;white-space:pre-wrap;word-break:break-all"></pre>
    <div class="toolbar" style="margin-top:10px">
      <button class="btn secondary" onclick="closeErrModal()">关闭</button>
      <span class="sub">来自最近一次运行/体检的失败信息, 重跑成功后自动清除</span>
    </div>
  </dialog>

  <div class="foot">数据来源: microsoft-rewards-script 容器 API · <span id="footRefresh">每 15 秒自动刷新</span> · ms-rewards-dashboard</div>
</div>
<script>
'use strict';
var API = { overview:'/api/overview', pushConfig:'/api/push-config', pushTest:'/api/push-test', start:'/api/start', stop:'/api/stop', loginCheck:'/api/login-check', loginCheckStatus:'/api/login-check/status', syncAll:'/api/sync-all', marketProbe:'/api/market-probe', marketProbeStatus:'/api/market-probe/status', manualLogin:'/api/manual-login', manualLoginStatus:'/api/manual-login/status', manualLoginStop:'/api/manual-login/stop', accountsManage:'/api/accounts-manage', accountsPass:'/api/accounts-manage/password', accountsGeo:'/api/accounts-manage/geo', capabilities:'/api/capabilities', schedule:'/api/capabilities/schedule', accountLogs:'/api/account-logs', accountLogDates:'/api/account-log-dates', accountHistory:'/api/account-history' };
var selected = {};
var selectionReady = false; // 首次拿到账号列表时默认全选, 之后尊重用户的选择
var accountsCache = [];
var runCache = null;

// ---- 自动刷新间隔(可调, 存 localStorage) ----
var refreshMs = 15000;
var refreshTimer = null;
try {
  var savedMs = parseInt(localStorage.getItem('msrRefreshMs'), 10);
  if (savedMs === 0 || savedMs >= 5000) refreshMs = savedMs;
} catch (e) { /* localStorage 不可用时用默认值 */ }
function scheduleNext() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  if (refreshMs > 0) refreshTimer = setTimeout(scheduleRefresh, refreshMs);
}
function setRefresh(ms) {
  refreshMs = ms;
  try { localStorage.setItem('msrRefreshMs', String(ms)); } catch (e) { /* ignore */ }
  updateIvUi();
  scheduleNext();
}
function updateIvUi() {
  var btns = document.querySelectorAll('.iv-btn');
  for (var i = 0; i < btns.length; i++) {
    var v = parseInt(btns[i].getAttribute('data-ms'), 10);
    btns[i].className = 'iv-btn' + (v === refreshMs ? ' active' : '');
  }
  $('ivCur').textContent = refreshMs > 0 ? ((refreshMs / 1000) + ' 秒') : '已关闭';
  $('footRefresh').textContent = refreshMs > 0 ? ('每 ' + (refreshMs / 1000) + ' 秒自动刷新') : '自动刷新已关闭';
}
function manualRefresh() { scheduleRefresh(); }
function toggleMenu(ev) { ev.stopPropagation(); $('menuDrop').classList.toggle('show'); updateIvUi(); }
function closeMenu() { $('menuDrop').classList.remove('show'); }

function $(id) { return document.getElementById(id); }

function apiFetch(url, opts, timeoutMs) {
  opts = opts || {};
  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 6000);
  if (ctrl) opts.signal = ctrl.signal;
  return fetch(url, opts).then(function (r) {
    clearTimeout(timer);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }, function (e) { clearTimeout(timer); throw e; });
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function fmtTs(ts) {
  if (!ts) return '-';
  var d = new Date(ts);
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function fmtAgo(ts, now) {
  if (!ts) return '';
  var d = (now || Date.now()) - ts;
  if (d < 0) d = 0;
  if (d < 60000) return Math.max(1, Math.floor(d / 1000)) + ' 秒前';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  return Math.floor(d / 86400000) + ' 天前';
}
function fmtDur(min) {
  var h = Math.floor(min / 60), m = min % 60;
  return h > 0 ? (h + ' 小时 ' + m + ' 分钟') : (m + ' 分钟');
}
function fmtNum(n) {
  if (n == null || isNaN(n)) return '-';
  return Number(n).toLocaleString('zh-CN');
}

function badge(status, liveRunning) {
  if (liveRunning) return '<span class="badge run">运行中</span>';
  if (status === 'running') return '<span class="badge run">运行中</span>';
  if (status === 'done') return '<span class="badge ok">已完成</span>';
  if (status === 'progress') return '<span class="badge progress" title="脚本并未在跑该账号: 任务体检显示部分完成(未全部通过), 点 🩺 可复查">部分完成</span>';
  if (status === 'sync-pending') return '<span class="badge" title="该账号已运行完成, 任务完成度将在自动同步后显示(也可点 🩺 立即刷新)">已运行·待同步</span>';
  return '<span class="badge">待开始</span>';
}

function renderOverview(d) {
  var now = d.serverTime || Date.now();
  var run = d.run || {};
  var sum = d.summary || {};
  accountsCache = d.accounts || [];
  runCache = run;
  if (!selectionReady && accountsCache.length) {
    for (var si = 0; si < accountsCache.length; si++) selected[accountsCache[si].index] = true;
    selectionReady = true;
  }

  var running = run.running === true;
  var conn = $('conn');
  conn.textContent = '已连接';
  conn.className = 'status-pill';
  var rs = $('runState');
  rs.textContent = running ? '运行中' : '空闲';
  rs.className = 'status-pill ' + (running ? 'running' : '');

  $('sumAccounts').textContent = (sum.count != null ? sum.count : accountsCache.length) + ' 个';
  $('sumBalance').textContent = fmtNum(sum.totalBalance);
  $('sumToday').textContent = '+' + fmtNum(sum.totalToday);
  $('todayLabel').textContent = d.today || '';

  var sb = $('btnSync');
  if (sb) {
    var sy = d.sync;
    if (sy && sy.status === 'running') {
      sb.disabled = true;
      sb.textContent = '🔄 同步中(' + sy.done + '/' + sy.total + ')';
      sb.title = '正在同步: ' + (sy.current || '-') + '(自动触发于' + (sy.trigger === 'run-end' ? '运行结束后' : '手动') + ')';
    } else {
      sb.disabled = false;
      sb.textContent = '🔄 同步余额';
      sb.title = '逐个账号经微软接口实测余额与任务完成度(每号约 2 秒)' + (sy && sy.finishedAt ? ';上次' + (sy.status === 'aborted' ? '被运行中断' : '完成于') + ': ' + new Date(sy.finishedAt).toLocaleTimeString() : '');
    }
  }

  var ri = $('runInfo');
  if (running) {
    // 当前账号实时得分与整轮累计分开显示, 避免把整轮合计误读成正在跑的账号的得分
    var curAcc = null;
    for (var ci = 0; ci < accountsCache.length; ci++) if (accountsCache[ci].email === run.currentAccount) { curAcc = accountsCache[ci]; break; }
    var curGain = (curAcc && curAcc.liveCollected != null) ? curAcc.liveCollected : null;
    ri.innerHTML = '正在跑: ' + esc(run.currentAccount || '-') +
      (curGain != null ? '（本号 +' + fmtNum(curGain) + '）' : '') +
      '<br>本轮合计 +' + fmtNum(run.collected);
    var bits = [];
    // 容器 API 的 startedAt 是 ISO 字符串, 必须经 Date.parse, 直接数字相减会得 NaN
    var runStartTs = Date.parse(run.startedAt);
    if (!isNaN(runStartTs)) {
      var elMin = Math.max(0, Math.round((now - runStartTs) / 60000));
      bits.push('已运行 ' + fmtDur(elMin));
    }
    var eta = d.eta;
    if (eta && eta.etaTs) {
      var d2 = new Date(eta.etaTs);
      var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
      bits.push('预计 ' + p2(d2.getHours()) + ':' + p2(d2.getMinutes()) + ' 完成（剩 ' + fmtDur(eta.remainMin) + '，均值 ' + eta.meanMin + ' 分/账号）');
    }
    if (bits.length) ri.innerHTML += '<br><span class="sub">' + bits.join(' · ') + '</span>';
  } else if (run.collected != null) {
    ri.innerHTML = '上次运行 +' + fmtNum(run.collected) + '<br><span class="sub">' + (run.startedAt ? fmtTs(run.startedAt) : '') + '</span>';
  } else {
    ri.textContent = '空闲';
  }

  renderAccounts(now);
  renderSchedule(d.schedule);
  renderHistory(d.history || []);
  updateSelUi();
}

function renderAccounts(now) {
  var box = $('accRows');
  if (!accountsCache.length) { box.innerHTML = '<tr><td colspan="10" class="empty">暂无账号数据</td></tr>'; return; }
  var html = '';
  for (var i = 0; i < accountsCache.length; i++) {
    var a = accountsCache[i];
    var rowNo = i + 1;
    var liveRunning = !!(runCache && runCache.running && runCache.currentAccount === a.email);
    var isRunning = liveRunning || a.status === 'running';
    var checked = selected[a.index] ? ' checked' : '';
    var bal = (a.balance != null) ? fmtNum(a.balance) : '—';
    var balTs = a.balanceTs ? '<div class="ts">' + fmtAgo(a.balanceTs, now) + '更新</div>' : '';
    var today = '+' + fmtNum(a.todayCollected || 0);
    if (a.bonusCollected > 0) {
      today += '<div class="ts" title="脚本今日经「领取全部待领奖励」领取的一次性积分(已含在上方总数内)">含一次性奖励 ' + fmtNum(a.bonusCollected) + '</div>';
    }
    var live = (a.liveCollected != null && isRunning) ? '<div class="ts">本次 +' + fmtNum(a.liveCollected) + '</div>' : '';
    var tk = a.todayTasks;
    var taskCell = '<span class="ts" title="今日还没有微软接口实测数据: 点 🩺 体检或 🔄 同步余额 获取">—</span>';
    if (a.validity === 'no-session') taskCell = '<span class="ts" title="该账号尚未登录过, 没有可查询的会话">未登录</span>';
    else if (a.tasksNA) taskCell = '<span class="ts" title="微软接口不返回该账号的任务明细(余额已实测同步), 状态按运行结果显示">余额已同步</span>';
    if (tk) {
      var dn = (tk.dailysetDone || 0) + (tk.searchDone || 0) + (tk.punchDone || 0);
      var tt = (tk.dailysetTotal || 0) + (tk.searchTotal || 0) + (tk.punchTotal || 0);
      var detail = '每日任务 ' + (tk.dailysetDone || 0) + '/' + (tk.dailysetTotal || 0)
        + ' · 搜索 ' + (tk.searchDone || 0) + '/' + (tk.searchTotal || 0)
        + ' · 打卡 ' + (tk.punchDone || 0) + '/' + (tk.punchTotal || 0);
      taskCell = (tk.allDone ? '<span style="color:var(--ok)"' : '<span') + ' title="' + detail + '(微软接口逐项实测)">' + dn + '/' + tt + '</span>';
    }
    var act = a.lastRunTs ? fmtTs(a.lastRunTs) + '<div class="ts">' + fmtAgo(a.lastRunTs, now) + '</div>' : '-';
    var err = a.lastError ? '<span class="errbadge" title="' + esc(a.lastError) + '" onclick="showErrorModal(' + a.index + ')">⚠ 错误</span>' : '<span class="ts" title="最近一次运行无错误">—</span>';
    // 区域徽章: 市场=兑换目录归属(Switch back 链接判定, 橙=与当前服务区域不一致即迁移未生效);
    // 服务=flyout 当前服务区域(随出口 IP); 档案=getuserinfo 账号资料国家(多数账号接口被拒则无)
    var regionHtml = '';
    if (a.market) {
      var mk = a.market;
      var mMismatch = mk.market && mk.service && mk.market !== mk.service;
      var mkTitle = '兑换市场(归属目录): ' + (mk.market || '未知') + (mk.banner ? '(兑换页有外出提示)' : '')
        + ' | 当前服务区域: ' + (mk.service || '未知')
        + (mk.profile ? ' | 账号档案国家: ' + mk.profile : '')
        + (mk.checkedAt ? ' | 检测于 ' + fmtTs(mk.checkedAt) : '')
        + (mk.error ? ' | ' + mk.error : '');
      regionHtml = '<div class="ts" title="' + esc(mkTitle) + '">🌏 市场 <b style="color:' + (mMismatch ? 'var(--warn)' : 'var(--ok)') + '">' + esc(mk.market || '?') + '</b>'
        + ' · 服务 ' + esc(mk.service || '?')
        + (mk.profile ? ' · 档案 ' + esc(mk.profile) : '')
        + '</div>';
    }
    html += '<tr>'
      + '<td><input type="checkbox"' + checked + ' onchange="toggleSel(' + a.index + ', this.checked)"></td>'
      + '<td>' + rowNo + '</td>'
      + '<td class="em">' + esc(a.email) + regionHtml + '</td>'
      + '<td class="num">' + bal + balTs + '</td>'
      + '<td class="num" style="color:var(--ok)">' + today + live + '</td>'
      + '<td style="font-size:12px">' + taskCell + '</td>'
      + '<td>' + badge(a.status, liveRunning) + '</td>'
      + '<td style="font-size:12px">' + act + '</td>'
      + '<td>' + err + '</td>'
      + '<td class="rowact">'
      + '<button class="btn small secondary" title="查看该账号实时运行日志" onclick="openLogs(' + a.index + ')">📜</button> '
      + '<button class="btn small secondary" title="登录体检: 无头检查会话并刷新实时余额(约 30-60 秒)" onclick="doCheck(' + a.index + ')">🩺</button> '
      + '<button class="btn small secondary" title="人工登录: 在容器内浏览器完成微软验证, 自动保存会话" onclick="doManualLogin(' + a.index + ')">🔑</button>'
      + (a.validity === 'need-reauth' ? ' <button class="btn small danger" title="该账号需要重新授权: 点击在容器内浏览器完成微软验证" onclick="doManualLogin(' + a.index + ')">🔐 重新授权</button>' : '')
      + checkNote(a)
      + '</td>'
      + '</tr>';
  }
  box.innerHTML = html;
}

function renderSchedule(sch) {
  if (!sch) { $('scheduleBox').textContent = '调度: 无法读取'; return; }
  $('scheduleBox').innerHTML = '调度: cron <b>' + esc(sch.cron || '-') + '</b> · 启用: ' + (sch.enabled ? '是' : '否')
    + ' · 时区: ' + esc(sch.timezone || '-')
    + (sch.skipIfRunning ? ' · 运行中跳过' : '');
}

function renderHistory(runs) {
  var box = $('histRows');
  if (!runs.length) { box.innerHTML = '<tr><td colspan="5" class="empty">暂无运行记录</td></tr>'; return; }
  var html = '';
  for (var i = 0; i < runs.length; i++) {
    var r = runs[i];
    var detail = '-';
    if (r.accounts && r.accounts.length) {
      var parts = [];
      for (var j = 0; j < r.accounts.length; j++) parts.push(esc(r.accounts[j].email) + ' +' + fmtNum(r.accounts[j].gained));
      detail = parts.join('；');
    }
    html += '<tr><td>' + fmtTs(r.startedAt) + '</td><td>' + (r.endedAt ? fmtTs(r.endedAt) : '-') + '</td>'
      + '<td style="white-space:normal;min-width:220px">' + detail + '</td>'
      + '<td class="num">+' + fmtNum(r.collected) + '</td><td class="num">' + fmtNum(r.totalBalance) + '</td></tr>';
  }
  box.innerHTML = html;
}

function toggleSel(idx, on) { if (on) selected[idx] = true; else delete selected[idx]; updateSelUi(); }
function toggleAll(on) { selectVisible(on); }
function selectVisible(on) {
  selected = {};
  if (on) { for (var i = 0; i < accountsCache.length; i++) selected[accountsCache[i].index] = true; }
  renderAccounts(Date.now());
  updateSelUi();
}
function selCount() { var n = 0; for (var k in selected) if (selected[k]) n++; return n; }
function updateSelUi() {
  var n = selCount();
  var total = accountsCache.length;
  var btn = $('btnRun');
  if (total === 0) { btn.disabled = true; btn.textContent = '▶ 运行'; }
  else {
    btn.disabled = false;
    btn.textContent = n > 0 ? ('▶ 运行选中(' + n + ')') : ('▶ 运行全部(' + total + ')');
  }
  $('selInfo').textContent = n > 0 ? ('已选 ' + n + ' / ' + total + ' 个账号') : '未选择账号时默认运行全部';
  var sa = $('selAll');
  sa.checked = total > 0 && n === total;
  sa.indeterminate = n > 0 && n < total;
}

function doRun() {
  var n = selCount();
  var idxs = [];
  for (var k in selected) if (selected[k]) idxs.push(Number(k));
  idxs.sort(function (a, b) { return a - b; });
  var names = [];
  for (var i2 = 0; i2 < accountsCache.length; i2++) {
    if (n === 0 || selected[accountsCache[i2].index]) {
      if (names.length < 4) names.push(accountsCache[i2].email);
    }
  }
  var label = n > 0 ? ('选中的 ' + n + ' 个账号：' + names.join('、') + (n > 4 ? ' 等' : '')) : ('全部 ' + accountsCache.length + ' 个账号');
  if (!confirm('确认立即运行积分任务？将运行：' + label + '。约 30-60 分钟，可能触发风控，请谨慎。')) return;
  var body = n > 0 ? JSON.stringify({ indexes: idxs }) : '{}';
  fetch(API.start, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.error) { alert('触发失败: ' + d.error); return; }
      var what = '全部账号';
      if (d && d.selectedAccount && d.selectedAccount.email) what = '单账号: ' + d.selectedAccount.email;
      else if (d && d.excludedAccounts && d.excludedAccounts.length) what = '已选 ' + (accountsCache.length - d.excludedAccounts.length) + ' 个账号';
      alert('已触发运行: ' + what);
      scheduleRefresh();
    })
    .catch(function (e) { alert('触发失败: ' + e.message); });
}

function doStop() {
  if (!confirm('确认停止当前运行？')) return;
  fetch(API.stop, { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (d) { alert('已发送停止'); scheduleRefresh(); })
    .catch(function (e) { alert('停止失败: ' + e.message); });
}

// ---- 推送设置(弹窗) ----
function openPush() {
  apiFetch(API.pushConfig, null, 8000).then(loadPushForm).catch(function () { loadPushForm(null); });
  var dlg = $('pushModal');
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
}
function closePush() {
  var dlg = $('pushModal');
  if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
}
function loadPushForm(c) {
  c = c || {};
  var dd = c.dingtalk || {};
  var ev = c.events || {};
  $('ddToken').value = dd.accessToken || '';
  $('ddSecret').value = dd.secret || '';
  $('ddKeyword').value = dd.keyword || 'MS-Rewards';
  $('ddDedup').value = c.dedupSeconds != null ? c.dedupSeconds : 10;
  $('ddEnabled').checked = dd.enabled !== false;
  $('ev-runStart').checked = !(ev.runStart && ev.runStart.enabled === false);
  $('ev-runEnd').checked = !(ev.runEnd && ev.runEnd.enabled === false);
  $('ev-accountEnd').checked = !(ev.accountEnd && ev.accountEnd.enabled === false);
  $('ev-error').checked = !(ev.error && ev.error.enabled === false);
  $('ev-loginFail').checked = !(ev.loginFail && ev.loginFail.enabled === false);
  $('ev-dailySummary').checked = !!(ev.dailySummary && ev.dailySummary.enabled === true);
  var em = c.email || {};
  $('emEnabled').checked = !!em.enabled;
  $('emHost').value = em.smtpHost || 'smtp.qq.com';
  $('emPort').value = em.smtpPort || 465;
  $('emUser').value = em.user || '';
  $('emPass').value = em.pass || '';
  $('emTo').value = em.to || '';
  showPushMsg('', true);
}
function showPushMsg(txt, ok) { var el = $('pushMsg'); el.textContent = txt; el.style.color = ok ? 'var(--ok)' : 'var(--err)'; }
function collectPush() {
  return {
    dingtalk: {
      enabled: $('ddEnabled').checked,
      accessToken: $('ddToken').value.trim(),
      secret: $('ddSecret').value.trim(),
      keyword: $('ddKeyword').value.trim() || 'MS-Rewards',
    },
    events: {
      runStart: { enabled: $('ev-runStart').checked },
      runEnd: { enabled: $('ev-runEnd').checked },
      accountEnd: { enabled: $('ev-accountEnd').checked },
      error: { enabled: $('ev-error').checked },
      loginFail: { enabled: $('ev-loginFail').checked },
      dailySummary: { enabled: $('ev-dailySummary').checked },
    },
    email: {
      enabled: $('emEnabled').checked,
      smtpHost: $('emHost').value.trim() || 'smtp.qq.com',
      smtpPort: parseInt($('emPort').value, 10) || 465,
      user: $('emUser').value.trim(),
      pass: $('emPass').value,
      to: $('emTo').value.trim(),
    },
    dedupSeconds: parseInt($('ddDedup').value, 10) || 10,
  };
}
function savePush() {
  fetch(API.pushConfig, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectPush()) })
    .then(function (r) { return r.json(); })
    .then(function (d) { showPushMsg(d.ok ? '✅ 已保存，即时生效' : '保存失败', !!d.ok); })
    .catch(function (e) { showPushMsg('保存失败: ' + e.message, false); });
}
function testPush() {
  showPushMsg('发送中…', true);
  fetch(API.pushTest, { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (d) { showPushMsg(d.ok ? '✅ 测试推送已发送，请查收钉钉' : ('测试失败: ' + String(d.error || d.resp || '').slice(0, 120)), !!d.ok); })
    .catch(function (e) { showPushMsg('测试失败: ' + e.message, false); });
}
function togglePass(id, btn) {
  var el = $(id);
  if (el.type === 'password') { el.type = 'text'; btn.textContent = '🙈'; }
  else { el.type = 'password'; btn.textContent = '👁'; }
}

// ---- 登录体检 / 人工登录 ----
var checkJobs = {};
var checkPollTimer = null;
function checkNote(a) {
  var j = checkJobs[a.index];
  if (!j) return '';
  if (j.status === 'running') return '<div class="ts" style="color:var(--warn)">🩺 体检中…</div>';
  if (j.status === 'error') return '<div class="ts" style="color:var(--err)">🩺 ' + esc(j.error || '失败') + '</div>';
  var r = j.result;
  if (r && r.loggedIn) return '<div class="ts" style="color:var(--ok)">🩺 正常' + (r.balance != null ? ' · ' + fmtNum(r.balance) + ' 分' : '') + '</div>';
  return '<div class="ts" style="color:var(--err)">🩺 未登录</div>';
}
function doSyncAll() {
  if (!confirm('同步全部账号的余额与任务完成度?轻量接口实测, 每号约 2 秒。')) return;
  fetch(API.syncAll, { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.error) { alert(d.error); return; }
      scheduleRefresh();
    })
    .catch(function (e) { alert('触发失败: ' + e.message); });
}

function doCheck(index) {
  var email = '#' + index;
  for (var i = 0; i < accountsCache.length; i++) if (accountsCache[i].index === index) email = accountsCache[i].email;
  if (!confirm('对 ' + email + ' 做登录体检?将无头访问一次 Rewards 刷新实时余额, 约 30-60 秒。')) return;
  fetch(API.loginCheck, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountIndex: index }) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.error) { alert(d.error); return; }
      ensureCheckPoll();
      scheduleRefresh();
    })
    .catch(function (e) { alert('触发失败: ' + e.message); });
}

// ==== 兑换市场/账号区域检测 ====
var marketPollTimer = null;
function doMarketProbe() {
  if (!confirm('检测全部账号的兑换市场与所在区域?每号恢复会话打开一次兑换页, 约 40-60 秒/号, 共约 5 分钟; 仅脚本空闲时可跑。')) return;
  fetch(API.marketProbe, { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.error) { alert(d.error); return; }
      ensureMarketPoll();
    })
    .catch(function (e) { alert('触发失败: ' + e.message); });
}
function ensureMarketPoll() {
  if (marketPollTimer) return;
  var mb = $('btnMarket');
  if (mb) { mb.disabled = true; mb.textContent = '🌏 检测中…'; }
  marketPollTimer = setInterval(function () {
    fetch(API.marketProbeStatus).then(function (r) { return r.json(); }).then(function (d) {
      var running = !!(d && d.running);
      if (mb) {
        if (running) {
          mb.disabled = true;
          mb.textContent = '🌏 检测中…';
          if (d.job && d.job.lastLog) mb.title = d.job.lastLog;
        } else {
          mb.disabled = false;
          mb.textContent = '🌏 检测区域';
          mb.title = '恢复每号会话打开一次兑换页: 检测兑换市场(归属目录)与当前服务区域, 约 40-60 秒/号; 仅脚本空闲时可跑';
        }
      }
      if (!running && marketPollTimer) {
        clearInterval(marketPollTimer);
        marketPollTimer = null;
        if (d && d.job && d.job.status === 'error') alert('区域检测失败: ' + (d.job.error || '未知原因'));
        scheduleRefresh();
      }
    }).catch(function () {});
  }, 4000);
}
function ensureCheckPoll() {
  if (checkPollTimer) return;
  checkPollTimer = setInterval(function () {
    fetch(API.loginCheckStatus).then(function (r) { return r.json(); }).then(function (d) {
      checkJobs = {};
      (d.jobs || []).forEach(function (j) {
        if (!checkJobs[j.accountIndex] || checkJobs[j.accountIndex].startedAt < j.startedAt) checkJobs[j.accountIndex] = j;
      });
      renderAccounts(Date.now());
      if (!d.running && checkPollTimer) {
        clearInterval(checkPollTimer);
        checkPollTimer = null;
        scheduleRefresh();
      }
    }).catch(function () {});
  }, 3000);
}

var mlPollTimer = null;
function doManualLogin(index) {
  var email = '#' + index;
  for (var i = 0; i < accountsCache.length; i++) if (accountsCache[i].index === index) email = accountsCache[i].email;
  if (!confirm('为 ' + email + ' 打开人工登录窗口?将在容器内依次打开移动端/桌面端浏览器, 完成微软登录并停留在 Rewards 页面 5 秒后自动保存。')) return;
  fetch(API.manualLogin, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountIndex: index }) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.error) { alert(d.error); return; }
      $('mlEmail').textContent = d.email;
      $('mlFrame').src = '/manual-vnc/' + d.token + '/vnc.html?path=' + encodeURIComponent('manual-vnc/' + d.token + '/websockify') + '&autoconnect=true&resize=scale';
      var dlg = $('mlModal');
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
      ensureMlPoll();
    })
    .catch(function (e) { alert('触发失败: ' + e.message); });
}
function ensureMlPoll() {
  if (mlPollTimer) return;
  mlPollTimer = setInterval(function () {
    fetch(API.manualLoginStatus).then(function (r) { return r.json(); }).then(function (d) {
      $('mlStatus').textContent = d.active ? (d.lastLog || '容器内浏览器启动中…') : '';
      if (!d.active) {
        clearInterval(mlPollTimer);
        mlPollTimer = null;
        if (d.done && d.runnerExit === 0) $('mlStatus').textContent = '✅ 人工登录完成, 会话已保存';
        else if (d.stopped) $('mlStatus').textContent = '会话已中止(未保存完整登录)';
        else if (d.failLog) $('mlStatus').textContent = '❌ ' + d.failLog;
        $('mlFrame').src = 'about:blank';
        scheduleRefresh();
      }
    }).catch(function () {});
  }, 2500);
}
function mlClose() {
  var dlg = $('mlModal');
  if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
}

// ---- 账号管理(动态添加) ----
function openAccounts() {
  apiFetch(API.accountsManage, null, 8000).then(function (d) { renderAcctManage(d || {}); }).catch(function () { renderAcctManage({}); });
  apiFetch(API.overview).then(function (d) { renderOverview(d); }).catch(function () {});
  var dlg = $('acctModal');
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
}
function closeAccounts() {
  var dlg = $('acctModal');
  if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
  scheduleRefresh();
}
function showAcctMsg(txt, ok) { var el = $('acctMsg'); el.textContent = txt; el.style.color = ok ? 'var(--ok)' : 'var(--err)'; }
var acctManageRows = [];
function renderAcctManage(d) {
  d = d || {};
  var box = $('acctRows');
  var fileAccounts = d.accounts || [];
  var all = accountsCache.slice();
  acctManageRows = all;
  var fileByEmail = {};
  for (var i = 0; i < fileAccounts.length; i++) fileByEmail[String(fileAccounts[i].email || '').toLowerCase()] = fileAccounts[i];
  for (var i = 0; i < all.length; i++) {
    var fe = fileByEmail[String(all[i].email || '').toLowerCase()];
    if (fe) {
      if (!all[i].geoLocale) all[i].geoLocale = fe.geoLocale;
      if (fe.hasTotp) all[i].hasTotp = true;
    }
  }
  for (var i = 0; i < fileAccounts.length; i++) {
    var fa = fileAccounts[i];
    var exists = false;
    for (var j = 0; j < all.length; j++) if (all[j].email && all[j].email.toLowerCase() === fa.email.toLowerCase()) exists = true;
    if (!exists) all.push({ email: fa.email, geoLocale: fa.geoLocale, hasTotp: fa.hasTotp, fresh: true });
  }
  if (!all.length) { box.innerHTML = '<tr><td colspan="4" class="empty">暂无账号</td></tr>'; return; }
  var html = '';
  for (var k = 0; k < all.length; k++) {
    var a = all[k];
    var del = '<button class="btn small secondary" title="修改微软账号密码，下一次运行生效" onclick="changePass(' + k + ')">🔑 改密</button> '
      + '<button class="btn small secondary" title="修改地区(搜索市场/语言)，下一次运行生效" onclick="changeGeo(' + k + ')">🌍 地区</button> '
      + '<button class="btn small danger" title="删除账号，下一次运行生效" onclick="delAccount(' + k + ')">🗑 删除</button>';
    var totp = a.hasTotp ? '是' : '-';
    var geo = a.geoLocale || '-';
    html += '<tr><td>' + esc(a.email) + (a.fresh ? ' <span class="badge err">未运行过</span>' : '') + '</td><td>' + esc(geo) + '</td><td>' + totp + '</td><td style="white-space:nowrap">' + del + '</td></tr>';
  }
  box.innerHTML = html;
}
function addAccount() {
  var email = $('naEmail').value.trim();
  var password = $('naPass').value;
  if (!email || !password) { showAcctMsg('请填写邮箱和密码', false); return; }
  fetch(API.accountsManage, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, password: password, geoLocale: $('naGeo').value, totpSecret: $('naTotp').value.trim() }) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.error) { showAcctMsg(d.error, false); return; }
      showAcctMsg('✅ 已添加，下一次运行自动生效', true);
      $('naEmail').value = ''; $('naPass').value = ''; $('naTotp').value = '';
      openAccounts();
    })
    .catch(function (e) { showAcctMsg('添加失败: ' + e.message, false); });
}
function delAccount(k) {
  var a = acctManageRows[k];
  if (!a) return;
  var email = a.email;
  if (!confirm('删除账号 ' + email + '？下一次运行起不再执行该账号；重新添加即可恢复。')) return;
  fetch(API.accountsManage + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email }) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.error) { showAcctMsg(d.error, false); return; }
      showAcctMsg('✅ 已删除', true);
      openAccounts();
    })
    .catch(function (e) { showAcctMsg('删除失败: ' + e.message, false); });
}

// ---- 能力控制 ----
var WORKER_KEYS = ['doDailySet','doDesktopSearch','doMobileSearch','doDailyCheckIn','doReadToEarn','doSpecialPromotions','doMorePromotions','doPunchCards','doAppPromotions','doClaimBonusPoints','doActivateSearchPerk','doBonusSearches','doVisualSearch'];
function openCap() {
  apiFetch(API.capabilities, null, 8000).then(renderCap).catch(function (e) { showCapMsg('读取失败: ' + e.message, false); });
  var dlg = $('capModal');
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
}
function closeCap() {
  var dlg = $('capModal');
  if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
}
function showCapMsg(txt, ok) { var el = $('capMsg'); el.textContent = txt; el.style.color = ok ? 'var(--ok)' : 'var(--err)'; }
function renderCap(d) {
  var c = (d && d.capabilities) || {};
  var w = c.workers || {};
  $('capClusters').value = String(c.clusters || 1);
  $('capEngines').value = (c.queryEngines || []).join(',');
  $('capAppkey').placeholder = c.appkeyConfigured ? '已配置(隐藏)' : '未配置，免费档限流';
  var dl = c.searchDelay || {};
  var cur = (dl.min || '') + ',' + (dl.max || '');
  var sel = $('capDelay');
  var found = false;
  for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === cur) { found = true; sel.selectedIndex = i; break; }
  if (!found && cur !== ',') {
    var o = document.createElement('option');
    o.value = cur; o.textContent = '自定义 ' + cur;
    sel.appendChild(o); sel.value = cur;
  }
  WORKER_KEYS.forEach(function (key) { var el = $('w-' + key); if (el) el.checked = w[key] !== false; });
  var sch = d.schedule || {};
  $('capCronOn').checked = sch.enabled !== false;
  var parts = String(sch.cron || '30 8 * * *').split(' ');
  $('capCronMin').value = parts[0] || '30';
  $('capCronHour').value = parts[1] || '8';
  showCapMsg('', true);
}
function saveCap() {
  var workers = {};
  WORKER_KEYS.forEach(function (key) { workers[key] = $('w-' + key).checked; });
  var delay = $('capDelay').value.split(',');
  var patch = {
    clusters: parseInt($('capClusters').value, 10) || 1,
    queryEngines: $('capEngines').value.split(',').map(function (x) { return x.trim(); }).filter(Boolean),
    delayMin: delay[0], delayMax: delay[1],
    workers: workers,
  };
  var appkey = $('capAppkey').value.trim();
  if (appkey) patch.appkey = appkey;
  fetch(API.capabilities, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.error) { showCapMsg('保存失败: ' + d.error, false); return; }
      var cron = $('capCronMin').value + ' ' + $('capCronHour').value + ' * * *';
      return fetch(API.schedule, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: $('capCronOn').checked, cron: cron }) })
        .then(function (r) { return r.json(); })
        .then(function (d2) {
          if (d2 && d2.error) showCapMsg('能力已保存，调度失败: ' + d2.error, false);
          else showCapMsg('✅ 已保存，下一次运行生效', true);
        });
    })
    .catch(function (e) { showCapMsg('保存失败: ' + e.message, false); });
}

// ---- 每账号运行日志(统一按天读文件; 今天=最新一天, 每 5 秒自动重读, 含正在运行的内容) ----
var logsTimer = null;
var logsTag = '';
var logsViewDate = '';
var logsNewestDate = '';
function openLogs(index) {
  var a = null;
  for (var i = 0; i < accountsCache.length; i++) if (accountsCache[i].index === index) a = accountsCache[i];
  if (!a) return;
  logsTag = String(a.email).split('@')[0];
  $('logsEmail').textContent = a.email;
  var dlg = $('logsModal');
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  fillLogDates(function () {
    var sel = $('logsDate');
    sel.value = logsNewestDate || (sel.options[0] ? sel.options[0].value : '');
    onLogsDateChange();
  });
  if (!logsTimer) logsTimer = setInterval(function () {
    if (logsViewDate && logsViewDate === logsNewestDate) loadAccountLog();
  }, 5000);
}
function showErrorModal(index) {
  var a = null;
  for (var i = 0; i < accountsCache.length; i++) if (accountsCache[i].index === index) a = accountsCache[i];
  if (!a || !a.lastError) return;
  $('errEmail').textContent = a.email;
  $('errTime').textContent = a.lastRunTs ? '最近运行: ' + fmtTs(a.lastRunTs) + '(' + fmtAgo(a.lastRunTs, Date.now()) + ')' : '';
  $('errBox').textContent = a.lastError;
  var dlg = $('errModal');
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
}
function closeErrModal() { $('errModal').close(); }

function fillLogDates(cb) {
  fetch(API.accountLogDates)
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var sel = $('logsDate');
      var opts = '';
      var dates = d.dates || [];
      for (var i = 0; i < dates.length; i++) {
        opts += '<option value="' + dates[i] + '">' + dates[i] + (i === 0 ? '(今天)' : '') + '</option>';
      }
      sel.innerHTML = opts;
      logsNewestDate = dates[0] || '';
      cb();
    })
    .catch(function () { cb(); });
}
function onLogsDateChange() {
  var sel = $('logsDate');
  logsViewDate = sel.value || (sel.options[0] ? sel.options[0].value : '');
  loadAccountLog();
}
function loadAccountLog() {
  if (!logsViewDate) {
    $('logsBox').textContent = '暂无可用日志文件';
    return;
  }
  if (logsViewDate === logsNewestDate) $('logsHint').textContent = '今天: 每 5 秒自动重新读取(包含正在运行的内容)';
  else $('logsHint').textContent = '历史快照: ' + logsViewDate + '(不自动刷新)';
  fetch(API.accountHistory + '?user=' + encodeURIComponent(logsTag) + '&date=' + logsViewDate)
    .then(function (r) { return r.json(); })
    .then(function (d) {
      $('logsBox').textContent = (d.lines && d.lines.length) ? d.lines.join('\\n') : '该日期没有此账号的日志(或当天未运行)';
    })
    .catch(function (e) { $('logsBox').textContent = '加载失败: ' + e.message; });
}
function closeLogs() {
  var dlg = $('logsModal');
  if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
}

// ---- 账号改密(覆盖层) ----
function changePass(k) {
  var a = acctManageRows[k];
  if (!a) return;
  var np = prompt('为 ' + a.email + ' 设置新的微软账号密码：');
  if (np == null) return;
  if (!np) { alert('密码不能为空'); return; }
  fetch(API.accountsPass, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: a.email, password: np }) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.ok) alert('✅ 密码已更新，下一次运行自动生效');
      else alert((d && d.error) || '失败');
    })
    .catch(function (e) { alert('失败: ' + e.message); });
}

// ---- 账号改地区(覆盖层) ----
function changeGeo(k) {
  var a = acctManageRows[k];
  if (!a) return;
  var cur = a.geoLocale || 'cn';
  var v = prompt('为 ' + a.email + ' 设置新的地区代码（如 cn / gb / us / jp / auto）：', cur);
  if (v == null) return;
  v = String(v).trim().toLowerCase();
  if (!v) { alert('地区不能为空'); return; }
  if (v !== 'auto' && !/^[a-z]{2}(-[a-z]{2})?$/.test(v)) { alert('地区格式不正确，示例: cn / gb / us / auto'); return; }
  fetch(API.accountsGeo, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: a.email, geoLocale: v }) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.ok) alert('✅ 地区已更新为 ' + v + '，下一次运行自动生效');
      else alert((d && d.error) || '失败');
    })
    .catch(function (e) { alert('失败: ' + e.message); });
}

function showDiag() {
  var b = $('diag');
  b.className = 'msg show err';
  b.textContent = '无法连接仪表盘 API。常见原因: 浏览器开了代理/Clash 且未放行内网 192.168.100.10；异地(ZeroTier)访问请用 http://192.168.192.10:8300。可用右上角「⚙ 菜单 → 立即刷新」重试。';
}
function hideDiag() { $('diag').className = 'msg'; }

function scheduleRefresh() {
  apiFetch(API.overview).then(function (d) {
    renderOverview(d);
    hideDiag();
    scheduleNext();
  }).catch(function () {
    $('conn').textContent = refreshMs > 0 ? '连接失败，5 秒后重试' : '连接失败';
    $('conn').className = 'status-pill error';
    showDiag();
    if (refreshMs > 0) refreshTimer = setTimeout(scheduleRefresh, 5000);
  });
}
document.addEventListener('click', function (e) {
  var drop = $('menuDrop');
  if (!drop || !drop.classList.contains('show')) return;
  var m = document.querySelector('.menu');
  if (m && !m.contains(e.target)) closeMenu();
});
(function () {
  var dlg = $('mlModal');
  if (!dlg) return;
  dlg.addEventListener('close', function () {
    if (mlPollTimer) { clearInterval(mlPollTimer); mlPollTimer = null; }
    $('mlFrame').src = 'about:blank';
    fetch(API.manualLoginStop, { method: 'POST' }).catch(function () {});
    scheduleRefresh();
  });
})();
(function () {
  var h = $('capCronHour');
  if (h) for (var i = 0; i < 24; i++) {
    var o = document.createElement('option');
    o.value = String(i);
    o.textContent = (i < 10 ? '0' : '') + i;
    h.appendChild(o);
  }
  var lg = $('logsModal');
  if (lg) lg.addEventListener('close', function () { if (logsTimer) { clearInterval(logsTimer); logsTimer = null; } });
})();
updateIvUi();
scheduleRefresh();
// 页面加载即检查一次区域检测状态: 后台正在跑(如每日自动)时恢复按钮为"检测中"
fetch(API.marketProbeStatus).then(function (r) { return r.json(); }).then(function (d) { if (d && d.running) ensureMarketPoll(); }).catch(function () {});
</script>
</body>
</html>`;

// ============ 启动 ============
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
loadPushConfig();
loadState();
// 日志 user 标签(邮箱本地部分) -> 完整邮箱 映射: CLAIM 等消息体内不含邮箱的事件靠它归属账号
for (const em of Object.keys(state.accounts)) registerTagEmail(em);
// 启动清扫: 容器重启会杀死进行中的运行(RUN-END 事件丢失), 账号状态会卡在"运行中"。
// 延迟 20s 并先确认没有真正在跑的运行(看板单独崩溃重启、运行仍在继续的场景), 再标记中断
setTimeout(async () => {
  try {
    const p = await fetchJson('/points');
    if (p && p.running) return;
  } catch (e) { /* API 不可达时运行大概率也已死, 继续清扫 */ }
  let n = 0;
  for (const em of Object.keys(state.accounts)) {
    const a = state.accounts[em];
    if (a && a.lastStatus === 'running') {
      a.lastStatus = 'failed';
      a.lastError = '容器重启导致运行中断, 已得积分已入账, 可重新运行续做剩余任务';
      n++;
    }
  }
  if (n) {
    log('INFO', `启动清扫: ${n} 个账号卡在"运行中", 已标记为运行中断`);
    saveState();
  }
}, 20000);
// 启动 60s 后补齐缺失的今日任务实测数据(运行中会自动跳过, 30 分钟周期重试)
setTimeout(() => { try { taskSyncCatchup('startup'); } catch (e) { /* ignore */ } }, 60000);
// 启动即测一次市场数据新鲜度(容器重启后 market.json 仍在, 但当天没测过且空闲则补测)
setTimeout(() => { void marketCatchup('startup'); }, 120000);
log('INFO', 'MS-Rewards dashboard 启动, 端口 ' + PORT + ' (内网无鉴权)');
log('INFO', '容器 API: ' + API_BASE + (API_TOKEN ? ' (token 已加载)' : ' (⚠ 未读取到 token)'));

server.on('upgrade', handleUpgrade);

server.listen(PORT, '0.0.0.0', () => {
  log('INFO', 'HTTP 监听 0.0.0.0:' + PORT);
  connectSSE();
});
