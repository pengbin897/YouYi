/**
 * 运行时生成托盘图标，避免在仓库里塞二进制资源。
 *
 * macOS 用 template image（纯黑 + alpha），系统会自动适配深浅色菜单栏；
 * 其他平台用品牌蓝实心圆点。
 */

import { nativeImage, type NativeImage } from 'electron'

const SIZE = 22

/** 生成一张 BGRA 位图：外圈实心圆，值守中时中心留一个空心，用于区分状态 */
function drawDot(color: [number, number, number], hollow: boolean): NativeImage {
  const buffer = Buffer.alloc(SIZE * SIZE * 4)
  const center = (SIZE - 1) / 2
  const outer = SIZE * 0.38
  const inner = SIZE * 0.16
  const [r, g, b] = color

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const dist = Math.hypot(x - center, y - center)
      // 用到边缘的一像素过渡做抗锯齿，否则小尺寸圆点会有明显锯齿
      let alpha = clamp01(outer - dist)
      if (hollow) alpha *= clamp01(dist - inner)

      const offset = (y * SIZE + x) * 4
      buffer[offset] = b
      buffer[offset + 1] = g
      buffer[offset + 2] = r
      buffer[offset + 3] = Math.round(alpha * 255)
    }
  }

  return nativeImage.createFromBitmap(buffer, { width: SIZE, height: SIZE })
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function trayIcon(state: 'watching' | 'idle'): NativeImage {
  const isMac = process.platform === 'darwin'
  // 品牌蓝取自交互原型的 --blue
  const color: [number, number, number] = isMac ? [0, 0, 0] : [24, 95, 165]
  const image = drawDot(color, state === 'idle')
  if (isMac) image.setTemplateImage(true)
  return image
}
