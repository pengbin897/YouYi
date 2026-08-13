/** 本地 SQLite 存储（PRD C5 / H：事件数据只落本地，无任何上云路径） */

import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import type { AgentId, AuditLog, Task, UnifiedEvent } from '@youyi/shared'
import { PATHS, ensureDirs } from '../config/paths.js'
import { createLogger } from '../util/logger.js'
import type { AuditRepo, DigestRepo, EventRepo, KvRepo, Store, TaskRepo } from './types.js'

const log = createLogger('store')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id     TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  finished_at TEXT,
  progress    REAL NOT NULL DEFAULT 0,
  session_id  TEXT,
  cwd         TEXT,
  summary     TEXT,
  muted       INTEGER NOT NULL DEFAULT 0,
  step_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(agent_id, session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);

CREATE TABLE IF NOT EXISTS events (
  event_id    TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  type        TEXT NOT NULL,
  severity    TEXT NOT NULL,
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL,
  status      TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  task_meta   TEXT NOT NULL,
  source      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_task     ON events(task_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  agent_id   TEXT,
  task_id    TEXT,
  channel    TEXT,
  summary    TEXT NOT NULL,
  result     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS digest_queue (
  event_id   TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

interface TaskRow {
  task_id: string
  agent_id: string
  title: string
  status: string
  started_at: string
  updated_at: string
  finished_at: string | null
  progress: number
  session_id: string | null
  cwd: string | null
  summary: string | null
  muted: number
  step_count: number
}

function rowToTask(row: TaskRow): Task {
  return {
    task_id: row.task_id,
    agent_id: row.agent_id as AgentId,
    title: row.title,
    status: row.status as Task['status'],
    started_at: row.started_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at ?? undefined,
    progress: row.progress,
    session_id: row.session_id ?? undefined,
    cwd: row.cwd ?? undefined,
    summary: row.summary ?? undefined,
    muted: row.muted === 1,
    step_count: row.step_count
  }
}

export class SqliteStore implements Store {
  private readonly db: DatabaseType

  constructor(file: string = PATHS.db) {
    ensureDirs()
    this.db = new Database(file)
    // WAL 让读写并发更顺畅；钩子事件是高频小写入
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA)
    log.info('本地数据库已就绪', { file })
  }

  readonly tasks: TaskRepo = {
    upsert: (task: Task): void => {
      this.db
        .prepare(
          `INSERT INTO tasks (task_id, agent_id, title, status, started_at, updated_at,
                              finished_at, progress, session_id, cwd, summary, muted, step_count)
           VALUES (@task_id, @agent_id, @title, @status, @started_at, @updated_at,
                   @finished_at, @progress, @session_id, @cwd, @summary, @muted, @step_count)
           ON CONFLICT(task_id) DO UPDATE SET
             title=excluded.title, status=excluded.status, updated_at=excluded.updated_at,
             finished_at=excluded.finished_at, progress=excluded.progress,
             session_id=excluded.session_id, cwd=excluded.cwd, summary=excluded.summary,
             muted=excluded.muted, step_count=excluded.step_count`
        )
        .run({
          ...task,
          finished_at: task.finished_at ?? null,
          session_id: task.session_id ?? null,
          cwd: task.cwd ?? null,
          summary: task.summary ?? null,
          muted: task.muted ? 1 : 0
        })
    },

    get: (taskId: string): Task | null => {
      const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as
        | TaskRow
        | undefined
      return row ? rowToTask(row) : null
    },

    findBySession: (agentId: AgentId, sessionId: string): Task | null => {
      const row = this.db
        .prepare(
          `SELECT * FROM tasks WHERE agent_id = ? AND session_id = ?
           ORDER BY updated_at DESC LIMIT 1`
        )
        .get(agentId, sessionId) as TaskRow | undefined
      return row ? rowToTask(row) : null
    },

    list: (options): Task[] => {
      const limit = options?.limit ?? 200
      if (options?.status?.length) {
        const marks = options.status.map(() => '?').join(',')
        const rows = this.db
          .prepare(
            `SELECT * FROM tasks WHERE status IN (${marks}) ORDER BY updated_at DESC LIMIT ?`
          )
          .all(...options.status, limit) as TaskRow[]
        return rows.map(rowToTask)
      }
      const rows = this.db
        .prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?')
        .all(limit) as TaskRow[]
      return rows.map(rowToTask)
    },

    listActive: (): Task[] => {
      const rows = this.db
        .prepare(
          `SELECT * FROM tasks WHERE status IN ('PENDING','RUNNING','NEEDS_AUTH')
           ORDER BY updated_at DESC`
        )
        .all() as TaskRow[]
      return rows.map(rowToTask)
    },

    setMuted: (taskId: string, muted: boolean): void => {
      this.db.prepare('UPDATE tasks SET muted = ? WHERE task_id = ?').run(muted ? 1 : 0, taskId)
    },

    mostRecentlyActiveAgent: (): AgentId | null => {
      const row = this.db
        .prepare('SELECT agent_id FROM tasks ORDER BY updated_at DESC LIMIT 1')
        .get() as { agent_id: string } | undefined
      return (row?.agent_id as AgentId) ?? null
    }
  }

  readonly events: EventRepo = {
    insert: (event: UnifiedEvent): void => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO events
             (event_id, agent_id, task_id, type, severity, title, detail, status,
              occurred_at, task_meta, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.event_id,
          event.agent_id,
          event.task_id,
          event.type,
          event.severity,
          event.title,
          event.detail,
          event.status,
          event.occurred_at,
          JSON.stringify(event.task_meta),
          JSON.stringify(event.source)
        )
    },

    listByTask: (taskId: string): UnifiedEvent[] => {
      const rows = this.db
        .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY occurred_at ASC')
        .all(taskId) as Record<string, string>[]
      return rows.map(hydrateEvent)
    },

    listSince: (since: string): UnifiedEvent[] => {
      const rows = this.db
        .prepare('SELECT * FROM events WHERE occurred_at >= ? ORDER BY occurred_at ASC')
        .all(since) as Record<string, string>[]
      return rows.map(hydrateEvent)
    },

    countByType: (taskId: string, type: UnifiedEvent['type']): number => {
      const row = this.db
        .prepare('SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = ?')
        .get(taskId, type) as { n: number }
      return row.n
    }
  }

  readonly audit: AuditRepo = {
    append: (entry): void => {
      this.db
        .prepare(
          `INSERT INTO audit_logs (action, agent_id, task_id, channel, summary, result, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          entry.action,
          entry.agent_id ?? null,
          entry.task_id ?? null,
          entry.channel ?? null,
          entry.summary,
          entry.result,
          entry.detail ?? null,
          new Date().toISOString()
        )
    },

    list: (limit = 500): AuditLog[] => {
      return this.db
        .prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?')
        .all(limit) as AuditLog[]
    }
  }

  readonly kv: KvRepo = {
    get: <T>(key: string): T | null => {
      const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
        | { value: string }
        | undefined
      if (!row) return null
      try {
        return JSON.parse(row.value) as T
      } catch {
        return null
      }
    },
    set: <T>(key: string, value: T): void => {
      this.db
        .prepare(
          'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
        )
        .run(key, JSON.stringify(value))
    }
  }

  readonly digest: DigestRepo = {
    enqueue: (eventId: string, agentId: AgentId): void => {
      this.db
        .prepare(
          'INSERT OR IGNORE INTO digest_queue (event_id, agent_id, created_at) VALUES (?, ?, ?)'
        )
        .run(eventId, agentId, new Date().toISOString())
    },
    drain: (): { eventId: string; agentId: AgentId }[] => {
      const rows = this.db
        .prepare('SELECT event_id, agent_id FROM digest_queue ORDER BY created_at ASC')
        .all() as { event_id: string; agent_id: string }[]
      this.db.prepare('DELETE FROM digest_queue').run()
      return rows.map((r) => ({ eventId: r.event_id, agentId: r.agent_id as AgentId }))
    },
    size: (): number => {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM digest_queue').get() as { n: number }
      return row.n
    }
  }

  /** 一键清除全部数据（PRD C5 / G4 / H） */
  clearAll(): void {
    this.db.exec(
      'DELETE FROM events; DELETE FROM tasks; DELETE FROM audit_logs; DELETE FROM digest_queue; DELETE FROM kv;'
    )
    this.db.exec('VACUUM')
    log.warn('已清除全部本地数据')
  }

  close(): void {
    this.db.close()
  }
}

function hydrateEvent(row: Record<string, string>): UnifiedEvent {
  return {
    event_id: row.event_id,
    agent_id: row.agent_id as AgentId,
    task_id: row.task_id,
    type: row.type as UnifiedEvent['type'],
    severity: row.severity as UnifiedEvent['severity'],
    title: row.title,
    detail: row.detail,
    status: row.status as UnifiedEvent['status'],
    occurred_at: row.occurred_at,
    task_meta: safeParse(row.task_meta, {}),
    source: safeParse(row.source, { hook: 'unknown', transport: 'internal', raw: null })
  }
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
