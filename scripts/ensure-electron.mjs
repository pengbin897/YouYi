/**
 * 启动前检查 electron 可执行文件是否已下载。
 *
 * 为什么需要它：`npm install` 时 electron 的 postinstall 会去 GitHub Releases 拉取
 * 平台二进制，国内网络经常超时；install 本身仍显示成功，但 dist/ 与 path.txt 缺失，
 * electron-vite dev 会抛 `Error: Electron uninstall`。这里在启动前做一次兜底：
 * 缺失时用镜像补下，已就绪则直接跳过，避免每次都要手动重跑安装脚本。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 未显式配置镜像时的默认值（国内直连 GitHub 基本不可用） */
const DEFAULT_MIRROR = 'https://npmmirror.com/mirrors/electron/'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
// 从 @youyi/app 的位置解析，保证 electron 被提升或就近安装都能找到
const require = createRequire(join(repoRoot, 'packages', 'app', 'package.json'))

/** 返回可执行文件路径；path.txt 或对应文件缺失都视为未下载 */
function binaryPath(dir) {
  const pathTxt = join(dir, 'path.txt')
  if (!existsSync(pathTxt)) return null
  const relative = readFileSync(pathTxt, 'utf8').trim()
  if (!relative) return null
  const binary = join(dir, 'dist', relative)
  return existsSync(binary) ? binary : null
}

let electronDir = null
try {
  electronDir = dirname(require.resolve('electron/package.json'))
} catch {
  electronDir = null
}

if (!electronDir) {
  console.error('[ensure-electron] 未找到 electron 包，请先执行 npm install')
  process.exit(1)
}

if (binaryPath(electronDir)) {
  process.exit(0)
}

console.log('[ensure-electron] 未检测到 Electron 可执行文件，正在下载……')
const mirror = process.env.ELECTRON_MIRROR || DEFAULT_MIRROR
const result = spawnSync(process.execPath, ['install.js'], {
  cwd: electronDir,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_MIRROR: mirror }
})

if (result.status !== 0 || !binaryPath(electronDir)) {
  console.error('[ensure-electron] Electron 下载失败，请检查网络后手动重试：')
  console.error(`  cd ${electronDir} && ELECTRON_MIRROR=${mirror} node install.js`)
  process.exit(1)
}

console.log('[ensure-electron] Electron 就绪。')
