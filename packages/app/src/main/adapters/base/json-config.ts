/**
 * 第三方配置文件的安全读写。
 *
 * 这些文件是用户自己的资产（尤其 ~/.claude/settings.json 里往往有大量个人配置），
 * 修改前必须备份，修改时只能做键级合并，卸载时只能精确移除自己写进去的条目。
 * 这是 PRD B1「非破坏性写入 + 可完整回滚」的实现基础。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PATHS, ensureDirs } from '../../config/paths.js'
import { createLogger } from '../../util/logger.js'

const log = createLogger('json-config')

export function readJsonFile<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8')
    if (!raw.trim()) return null
    return JSON.parse(raw) as T
  } catch (err) {
    log.warn('配置文件解析失败，将不做修改', { file, error: String(err) })
    return null
  }
}

/** 备份到 ~/.youyi/backups，文件名带时间戳，便于用户自己回滚 */
export function backupFile(file: string, label: string): string | null {
  if (!existsSync(file)) return null
  ensureDirs()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(PATHS.backups, `${label}-${stamp}.bak`)
  copyFileSync(file, target)
  log.info('已备份配置文件', { file, backup: target })
  return target
}

/** 原子写入：先写临时文件再改名，避免写一半崩溃毁掉用户配置 */
export function writeJsonFile(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.youyi-tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** 判断某个钩子条目是不是哨兵写进去的 */
export function isYouyiHookEntry(entry: unknown): boolean {
  const json = JSON.stringify(entry ?? '')
  return json.includes('youyi-hook') || (json.includes('127.0.0.1') && json.includes('/h/'))
}
