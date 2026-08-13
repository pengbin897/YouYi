/**
 * 存储层接口。
 *
 * 事件引擎只依赖这些接口而不直接依赖 better-sqlite3，一是便于单元测试用内存实现，
 * 二是原生模块需要针对 Electron ABI 编译，把它隔离在一层之后可以避免测试环境
 * 被迫加载原生模块。
 */

import type { AgentId, AuditLog, Task, UnifiedEvent } from '@youyi/shared'

export interface TaskRepo {
  upsert(task: Task): void
  get(taskId: string): Task | null
  findBySession(agentId: AgentId, sessionId: string): Task | null
  list(options?: { status?: Task['status'][]; limit?: number }): Task[]
  listActive(): Task[]
  setMuted(taskId: string, muted: boolean): void
  /** 最近有事件的 Agent，用于消息路由的默认目标判定（PRD D1） */
  mostRecentlyActiveAgent(): AgentId | null
}

export interface EventRepo {
  insert(event: UnifiedEvent): void
  listByTask(taskId: string): UnifiedEvent[]
  /** 指定时间之后的事件，早报汇总用 */
  listSince(since: string): UnifiedEvent[]
  countByType(taskId: string, type: UnifiedEvent['type']): number
}

export interface AuditRepo {
  append(entry: Omit<AuditLog, 'id' | 'created_at'>): void
  list(limit?: number): AuditLog[]
}

export interface KvRepo {
  get<T>(key: string): T | null
  set<T>(key: string, value: T): void
}

/** 免打扰时段内被拦下的通知，等早报时统一发出（PRD F3） */
export interface DigestRepo {
  enqueue(eventId: string, agentId: AgentId): void
  drain(): { eventId: string; agentId: AgentId }[]
  size(): number
}

export interface Store {
  tasks: TaskRepo
  events: EventRepo
  audit: AuditRepo
  kv: KvRepo
  digest: DigestRepo
  clearAll(): void
  close(): void
}
