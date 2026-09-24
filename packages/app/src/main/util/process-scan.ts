/** 进程扫描，用于自动发现「已安装且正在运行」的 Agent（PRD B2） */

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from './logger.js'

const log = createLogger('process-scan')
const run = promisify(execFile)

let cache: { at: number; lines: string[] } | null = null
/** 引导流程里会连续探测多个 Agent，缓存一次进程快照避免反复 fork */
const CACHE_TTL_MS = 3000

async function snapshot(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.lines

  try {
    const { stdout } =
      process.platform === 'win32'
        ? await run('tasklist', ['/FO', 'CSV', '/NH'], { maxBuffer: 8 * 1024 * 1024 })
        : await run('ps', ['-A', '-o', 'args='], { maxBuffer: 8 * 1024 * 1024 })

    const lines = stdout.split('\n').filter(Boolean)
    cache = { at: Date.now(), lines }
    return lines
  } catch (err) {
    log.warn('进程扫描失败', String(err))
    return []
  }
}

/** 命令行中包含任一关键词即视为运行中 */
export async function isProcessRunning(keywords: string[]): Promise<boolean> {
  const lines = await snapshot()
  const needles = keywords.map((k) => k.toLowerCase())
  return lines.some((line) => {
    const lower = line.toLowerCase()
    return needles.some((needle) => lower.includes(needle))
  })
}

/** 在 PATH 里查找可执行文件 */
export async function which(command: string): Promise<string | null> {
  try {
    const { stdout } =
      process.platform === 'win32'
        ? await run('where', [command])
        : await run('which', [command])
    const path = stdout.split('\n')[0]?.trim()
    return path || null
  } catch {
    return null
  }
}

/**
 * 各类包管理器惯用的 bin 目录。
 *
 * PATH 不可靠：从 Finder 拉起时环境残缺，补齐逻辑（user-path.ts）也未必覆盖用户
 * 自定义的目录。命令行类的 Agent 一律再按这些惯例位置找一遍，否则会出现
 * 「配置目录明明在、却报只找到配置」这种误判。
 */
const COMMON_BIN_DIRS = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
  join(homedir(), '.local', 'bin'),
  join(homedir(), 'bin'),
  join(homedir(), '.bun', 'bin'),
  join(homedir(), '.volta', 'bin'),
  join(homedir(), '.nvm', 'versions'),
  join(homedir(), '.npm-global', 'bin')
]

/**
 * 配置目录最近是否有活动。
 *
 * 找不到可执行文件不代表没装：命令行 Agent 可能装在版本管理器里、
 * 也可能只通过 IDE 插件使用。但配置目录里有近期读写（新会话、新历史）
 * 就说明它确实在用，这比 PATH 上有没有那个文件靠得住。
 */
export function lastActivity(dir: string): Date | null {
  try {
    return statSync(dir).mtime
  } catch {
    return null
  }
}

const ACTIVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

export function isRecentlyActive(dir: string): boolean {
  const at = lastActivity(dir)
  return at !== null && Date.now() - at.getTime() < ACTIVE_WINDOW_MS
}

/** 先查 PATH，再查惯例目录 */
export async function findBinary(command: string): Promise<string | null> {
  const fromPath = await which(command)
  if (fromPath) return fromPath
  if (process.platform === 'win32') return null
  return anyPathExists(COMMON_BIN_DIRS.map((dir) => join(dir, command)))
}

export function anyPathExists(paths: string[]): string | null {
  return paths.find((p) => existsSync(p)) ?? null
}

/**
 * 图形界面应用的常规安装位置。
 *
 * Qoder / Trae / CodeBuddy / ChatGPT 这几家是桌面应用而不是命令行工具，
 * PATH 里查不到，只能按各平台的安装惯例找应用本体。
 */
export function appInstallPaths(name: string): string[] {
  if (process.platform === 'darwin') {
    return [`/Applications/${name}.app`, join(homedir(), 'Applications', `${name}.app`)]
  }
  if (process.platform === 'win32') {
    const candidates = [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', name),
      process.env.ProgramFiles && join(process.env.ProgramFiles, name),
      process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], name)
    ]
    return candidates.filter((p): p is string => Boolean(p))
  }
  return []
}
