import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { PATHS } from '../config/paths.js'

type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const minLevel: Level = process.env.YOUYI_LOG_LEVEL === 'debug' ? 'debug' : 'info'

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
  const ts = new Date().toISOString()
  const line = `[${ts}] ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`
  const suffix = extra === undefined ? '' : ` ${safeStringify(extra)}`

  if (level === 'error') console.error(line + suffix)
  else if (level === 'warn') console.warn(line + suffix)
  else console.log(line + suffix)

  try {
    const file = join(PATHS.logs, `${new Date().toISOString().slice(0, 10)}.log`)
    appendFileSync(file, line + suffix + '\n')
  } catch {
    // 日志写盘失败不能影响主流程
  }
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export interface Logger {
  debug(message: string, extra?: unknown): void
  info(message: string, extra?: unknown): void
  warn(message: string, extra?: unknown): void
  error(message: string, extra?: unknown): void
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e)
  }
}
