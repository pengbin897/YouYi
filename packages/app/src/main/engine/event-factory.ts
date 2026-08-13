/** 统一事件的构造入口，保证 severity/status 与事件类型的映射处处一致 */

import { randomUUID } from 'node:crypto'
import {
  SEVERITY_BY_EVENT,
  STATUS_BY_EVENT,
  type AgentId,
  type AuthOptions,
  type EventSource,
  type EventType,
  type TaskMeta,
  type UnifiedEvent
} from '@youyi/shared'

export interface BuildEventInput {
  agentId: AgentId
  taskId: string
  type: EventType
  title: string
  detail: string
  taskMeta?: TaskMeta
  source: EventSource
  occurredAt?: string
  /** 仅 auth_required 需要：决定通知末尾的引导语 */
  authOptions?: AuthOptions
}

export function buildEvent(input: BuildEventInput): UnifiedEvent {
  return {
    event_id: `evt_${randomUUID().slice(0, 12)}`,
    agent_id: input.agentId,
    task_id: input.taskId,
    type: input.type,
    severity: SEVERITY_BY_EVENT[input.type],
    title: input.title,
    detail: input.detail,
    status: STATUS_BY_EVENT[input.type],
    occurred_at: input.occurredAt ?? new Date().toISOString(),
    task_meta: input.taskMeta ?? {},
    source: input.source,
    ...(input.authOptions ? { auth_options: input.authOptions } : {})
  }
}

/**
 * 任务 ID 的生成规则：同一个 Agent 会话内的所有事件必须落到同一个 task_id，
 * 否则聚合、透传定位、状态自答都会散架。绝大多数 Agent 都提供 session_id，
 * 拿不到时退化为按 Agent + 工作目录归并。
 */
export function deriveTaskId(agentId: AgentId, sessionId?: string, cwd?: string): string {
  const key = sessionId?.trim() || cwd?.trim() || 'default'
  return `task_${agentId}_${hash(key)}`
}

function hash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i += 1) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}
