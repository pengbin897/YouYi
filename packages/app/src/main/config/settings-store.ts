/**
 * 应用设置持久化。
 *
 * 刻意不放进 SQLite：设置在数据库打开之前就要用到（例如决定是否自启、
 * 哪些 Agent 需要装钩子），而且用户「一键清除数据」后设置也该能独立保留或重置。
 */

import { EventEmitter } from 'node:events'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { DEFAULT_SETTINGS, type AppSettings } from '@youyi/shared'
import { PATHS, ensureDirs } from './paths.js'
import { createLogger } from '../util/logger.js'

const log = createLogger('settings')

export class SettingsStore extends EventEmitter {
  private data: AppSettings

  constructor(private readonly file: string = PATHS.settings) {
    super()
    ensureDirs()
    this.data = this.load()
  }

  private load(): AppSettings {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AppSettings>
      // 与默认值做深合并，保证老版本配置文件在新增字段后依然可用
      return mergeSettings(DEFAULT_SETTINGS, raw)
    } catch {
      return structuredClone(DEFAULT_SETTINGS)
    }
  }

  get(): AppSettings {
    return this.data
  }

  patch(partial: Partial<AppSettings>): AppSettings {
    this.data = mergeSettings(this.data, partial)
    this.persist()
    this.emit('change', this.data)
    return this.data
  }

  reset(): AppSettings {
    this.data = structuredClone(DEFAULT_SETTINGS)
    this.persist()
    this.emit('change', this.data)
    return this.data
  }

  private persist(): void {
    try {
      // 先写临时文件再改名，避免写到一半崩溃留下半个损坏的配置
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (err) {
      log.error('设置保存失败', String(err))
    }
  }
}

function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  const out = structuredClone(base)
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const typed = key as keyof AppSettings
    const current = out[typed]
    if (isPlainObject(current) && isPlainObject(value)) {
      Object.assign(current as object, deepMerge(current as object, value))
    } else {
      // @ts-expect-error 按 key 动态赋值，类型在调用侧已约束
      out[typed] = value
    }
  }
  return out
}

function deepMerge(base: object, patch: object): object {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key]
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
