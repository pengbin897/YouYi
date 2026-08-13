/**
 * 生成应用图标 build/icon.png（1024×1024），electron-builder 会自动转成 icns / ico。
 *
 * 为什么用代码画而不是塞一个二进制文件进仓库：图标要跟 tokens.css 的品牌蓝
 * (#185fa5) 保持一致，改配色时重新跑一遍就行，也不会在 diff 里出现一大坨二进制。
 *
 * 图形：圆角方形蓝底 + 中央白色同心圆环（"值守之眼"），与托盘的实心/空心点呼应。
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 1024
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'app', 'build')

const BLUE = [0x18, 0x5f, 0xa5]
const BLUE_DEEP = [0x0c, 0x44, 0x7c]
const WHITE = [0xff, 0xff, 0xff]

/** macOS 大图标的圆角比例约为边长的 22.5% */
const CORNER = SIZE * 0.225

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** 圆角矩形的覆盖率，带 2×2 超采样做抗锯齿 */
function roundedCoverage(x, y) {
  let hits = 0
  for (const dx of [0.25, 0.75]) {
    for (const dy of [0.25, 0.75]) {
      const px = x + dx
      const py = y + dy
      // 折到左上角象限判断，四角逻辑一致
      const cx = Math.min(px, SIZE - px)
      const cy = Math.min(py, SIZE - py)
      if (cx >= CORNER || cy >= CORNER) {
        hits += 1
      } else {
        const dxr = CORNER - cx
        const dyr = CORNER - cy
        if (dxr * dxr + dyr * dyr <= CORNER * CORNER) hits += 1
      }
    }
  }
  return hits / 4
}

/** 环形覆盖率：inner..outer 之间为 1 */
function ringCoverage(px, py, outer, inner) {
  const cx = SIZE / 2
  const cy = SIZE / 2
  let hits = 0
  for (const dx of [0.25, 0.75]) {
    for (const dy of [0.25, 0.75]) {
      const d = Math.hypot(px + dx - cx, py + dy - cy)
      if (d <= outer && d >= inner) hits += 1
    }
  }
  return hits / 4
}

function blend(base, top, alpha) {
  return base.map((c, i) => Math.round(c * (1 - alpha) + top[i] * alpha))
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
let offset = 0

for (let y = 0; y < SIZE; y += 1) {
  raw[offset] = 0 // 每行的滤波器类型：None
  offset += 1
  for (let x = 0; x < SIZE; x += 1) {
    // 自上而下的线性渐变，深色在下，视觉上更沉稳
    const t = y / SIZE
    let color = BLUE.map((c, i) => Math.round(c * (1 - t) + BLUE_DEEP[i] * t))

    // 外环（粗）
    const outerRing = ringCoverage(x, y, SIZE * 0.3, SIZE * 0.235)
    if (outerRing > 0) color = blend(color, WHITE, outerRing)

    // 内实心点
    const dot = ringCoverage(x, y, SIZE * 0.115, 0)
    if (dot > 0) color = blend(color, WHITE, dot)

    const alpha = Math.round(roundedCoverage(x, y) * 255)
    raw[offset] = color[0]
    raw[offset + 1] = color[1]
    raw[offset + 2] = color[2]
    raw[offset + 3] = alpha
    offset += 4
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // 位深
ihdr[9] = 6 // 颜色类型：RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'icon.png'), png)
console.log(`图标已生成：${join(OUT, 'icon.png')} (${(png.length / 1024).toFixed(1)} KB)`)
