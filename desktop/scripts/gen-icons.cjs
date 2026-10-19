#!/usr/bin/env node
'use strict'
// 生成桌面端图标: assets/icon.png (512x512, 应用/打包用) + trayTemplate.png/tray@2x.png (macOS 菜单栏模板图标)
// 运行: node scripts/gen-icons.cjs

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const CRC_TABLE = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        t[n] = c
    }
    return t
})()

function crc32(buf) {
    let c = -1
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
}

function chunk(type, data) {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 6 // RGBA
    const raw = Buffer.alloc((width * 4 + 1) * height)
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0 // filter: none
        rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
    }
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// 有向距离: 圆角矩形
function sdRoundRect(px, py, cx, cy, half, radius) {
    const qx = Math.abs(px - cx) - (half - radius)
    const qy = Math.abs(py - cy) - (half - radius)
    const ox = Math.max(qx, 0)
    const oy = Math.max(qy, 0)
    return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius
}

// 有向距离: 圆环 (rMid=中径, halfWidth=线宽一半)
function sdRing(px, py, cx, cy, rMid, halfWidth) {
    return Math.abs(Math.hypot(px - cx, py - cy) - rMid) - halfWidth
}

const clamp01 = v => Math.max(0, Math.min(1, v))
const smooth = d => clamp01(0.5 - d) // d<-.5 全覆盖, d>.5 全空 (以像素为单位, 2x 超采样下近似)

function renderAppIcon(size) {
    const rgba = Buffer.alloc(size * size * 4)
    const S = size / 256 // 设计稿 256 坐标系
    const margin = 16 * S
    const half = (256 / 2 - 16) * S
    const cx = size / 2
    const sub = 3 // NxN 超采样
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let boxCov = 0
            let ringCov = 0
            let dotCov = 0
            for (let sy = 0; sy < sub; sy++) {
                for (let sx = 0; sx < sub; sx++) {
                    const px = x + (sx + 0.5) / sub
                    const py = y + (sy + 0.5) / sub
                    boxCov += smooth(sdRoundRect(px, py, cx, cx, half, 56 * S)) / (sub * sub)
                    ringCov += smooth(sdRing(px, py, cx, cx, 76 * S, 24 * S)) / (sub * sub)
                    dotCov += smooth(Math.hypot(px - cx, py - cx) - 15 * S) / (sub * sub)
                }
            }
            const boxA = clamp01(boxCov)
            // 渐变 #3B82F6 -> #1E40AF
            const t = clamp01((y - margin) / (size - 2 * margin))
            const br = Math.round(0x3b + (0x1e - 0x3b) * t)
            const bg = Math.round(0x82 + (0x40 - 0x82) * t)
            const bb = Math.round(0xf6 + (0xaf - 0xf6) * t)
            // 白色圆环 + 中心点 叠在渐变上
            const fgA = clamp01(Math.max(ringCov, dotCov)) * boxA
            const a = boxA * 255
            const r = Math.round(br * (1 - fgA) + 255 * fgA)
            const g = Math.round(bg * (1 - fgA) + 255 * fgA)
            const b = Math.round(bb * (1 - fgA) + 255 * fgA)
            const i = (y * size + x) * 4
            rgba[i] = r
            rgba[i + 1] = g
            rgba[i + 2] = b
            rgba[i + 3] = a
        }
    }
    return encodePng(size, size, rgba)
}

// 菜单栏模板图标: 黑色圆环, 透明底, macOS 按 Template 自动适配深浅色
function renderTrayIcon(size) {
    const rgba = Buffer.alloc(size * size * 4)
    const cx = size / 2
    const rMid = size * 0.36
    const halfW = size * 0.11
    const sub = 4
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let cov = 0
            for (let sy = 0; sy < sub; sy++)
                for (let sx = 0; sx < sub; sx++)
                    cov += smooth(sdRing(x + (sx + 0.5) / sub, y + (sy + 0.5) / sub, cx, cx, rMid, halfW)) / (sub * sub)
            const i = (y * size + x) * 4
            rgba[i] = 0
            rgba[i + 1] = 0
            rgba[i + 2] = 0
            rgba[i + 3] = Math.round(clamp01(cov) * 255)
        }
    }
    return encodePng(size, size, rgba)
}

const outDir = path.join(__dirname, '..', 'assets')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'icon.png'), renderAppIcon(512))
fs.writeFileSync(path.join(outDir, 'trayTemplate.png'), renderTrayIcon(16))
fs.writeFileSync(path.join(outDir, 'trayTemplate@2x.png'), renderTrayIcon(32))
console.log('icons written to', outDir)
