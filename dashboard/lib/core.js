'use strict'
// 面板共享纯函数（供 dashboard/server.js 与单元测试使用）

/** HTML 转义（innerHTML 渲染外部数据前必须经过） */
function esc(s) {
    return String(s == null ? '' : s).replace(
        /[&<>"]/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
    )
}

/**
 * 邮箱格式校验：拒绝空值、无 @、双跳、空白、以 -- 开头的参数注入形态。
 * 用于 spawn 子进程参数与面板 API 入口（防参数注入）。
 */
function isValidEmail(v) {
    if (typeof v !== 'string') return false
    const s = v.trim()
    if (!s || s.startsWith('--')) return false
    if (/\s/.test(s)) return false
    return /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(s)
}

module.exports = { esc, isValidEmail }
