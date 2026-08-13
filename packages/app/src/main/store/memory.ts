/** 内存存储实现，仅用于单元测试（避免测试环境加载为 Electron ABI 编译的原生模块） */

import type { AgentId, AuditLog, Task, UnifiedEvent } from '@youyi/shared'
import type { AuditRepo, DigestRepo, EventRepo, KvRepo, Store, TaskRepo } from './types.js'

export class MemoryStore implements Store {
  private taskMap = new Map<string, Task>()
  private eventList: UnifiedEvent[] = []
  private auditList: AuditLog[] = []
  private kvMap = new Map<string, unknown>()
  private digestList: { eventId: string; agentId: AgentId }[] = []
  private auditSeq = 1

  readonly tasks: TaskRepo = {
    upsert: (task) => {
      this.taskMap.set(task.task_id, { ...task })
    },
    get: (taskId) => this.taskMap.get(taskId) ?? null,
    findBySession: (agentId, sessionId) => {
      const found = [...this.taskMap.values()]
        .filter((t) => t.agent_id === agentId && t.session_id === sessionId)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      return found[0] ?? null
    },
    list: (options) => {
      let list = [...this.taskMap.values()]
      if (options?.status?.length) list = list.filter((t) => options.status!.includes(t.status))
      list.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      return list.slice(0, options?.limit ?? 200)
    },
    listActive: () =>
      [...this.taskMap.values()]
        .filter((t) => ['PENDING', 'RUNNING', 'NEEDS_AUTH'].includes(t.status))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    setMuted: (taskId, muted) => {
      const task = this.taskMap.get(taskId)
      if (task) task.muted = muted
    },
    mostRecentlyActiveAgent: () => {
      const list = [...this.taskMap.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      return list[0]?.agent_id ?? null
    }
  }

  readonly events: EventRepo = {
    insert: (event) => {
      this.eventList.push(event)
    },
    listByTask: (taskId) =>
      this.eventList
        .filter((e) => e.task_id === taskId)
        .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)),
    listSince: (since) => this.eventList.filter((e) => e.occurred_at >= since),
    countByType: (taskId, type) =>
      this.eventList.filter((e) => e.task_id === taskId && e.type === type).length
  }

  readonly audit: AuditRepo = {
    append: (entry) => {
      this.auditList.unshift({
        ...entry,
        id: this.auditSeq++,
        created_at: new Date().toISOString()
      })
    },
    list: (limit = 500) => this.auditList.slice(0, limit)
  }

  readonly kv: KvRepo = {
    get: <T>(key: string) => (this.kvMap.get(key) as T) ?? null,
    set: <T>(key: string, value: T) => {
      this.kvMap.set(key, value)
    }
  }

  readonly digest: DigestRepo = {
    enqueue: (eventId, agentId) => {
      if (!this.digestList.some((d) => d.eventId === eventId)) {
        this.digestList.push({ eventId, agentId })
      }
    },
    drain: () => {
      const out = [...this.digestList]
      this.digestList = []
      return out
    },
    size: () => this.digestList.length
  }

  clearAll(): void {
    this.taskMap.clear()
    this.eventList = []
    this.auditList = []
    this.kvMap.clear()
    this.digestList = []
  }

  close(): void {
    // 无需释放资源
  }
}
