/**
 * 统一事件模型 —— 设计文档 §5.2 / PRD C1。
 *
 * 所有 Agent 的原生 Hook 事件都必须由适配器归一化成 UnifiedEvent 之后才能进入系统，
 * UI 与通知层只依赖本模型，不得直接读取厂商原始字段（原始 payload 保留在 source.raw 里备查）。
 */

import type { AgentId } from './agents.js'

/** 6 种统一事件（设计文档 §5.2） */
export const EVENT_TYPES = [
  'task_started',
  'task_progress',
  'task_completed',
  'task_failed',
  'auth_required',
  'task_stalled'
] as const

export type EventType = (typeof EVENT_TYPES)[number]

/**
 * 严重级别。决定通知管家的处理方式：
 * - critical：最高优先级，免打扰时段内也要即时推送（仅 auth_required）
 * - high：高优先级即时推送（failed / stalled）
 * - low：低优先级，免打扰时段内攒进早报（completed）
 * - info：不推送，只更新状态（progress / started）
 */
export type Severity = 'info' | 'low' | 'high' | 'critical'

/** 任务状态机状态（PRD C2） */
export const TASK_STATUSES = [
  'PENDING',
  'RUNNING',
  'NEEDS_AUTH',
  'COMPLETED',
  'FAILED',
  'STALLED'
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

/** 事件到达哨兵的传输方式，用于诊断与 UI 上的能力标注 */
export type EventTransport =
  | 'http' // Agent 原生 HTTP hook 直连（Claude Code）
  | 'bridge' // 经 youyi-hook 桥接程序转发（多数 Agent）
  | 'webhook' // Agent 原生 outbound webhook（Hermes）
  | 'log' // 日志兜底监控（L1 降级）
  | 'internal' // 哨兵自身产生（如卡死检测）

export interface TaskMeta {
  /** 任务名。通常取自用户的首条 prompt，用于面板与通知里指代这个任务 */
  task_title?: string
  /** 任务首次进入 RUNNING 的时间 */
  started_at?: string
  /** 0~1；多数 Agent 不提供真实进度，用工具调用次数估算 */
  progress?: number
  /** Agent 侧的会话 ID，透传/回传时用于定位目标会话 */
  session_id?: string
  /** 会话工作目录，UI 上用于区分同一 Agent 的多个任务 */
  cwd?: string
  /** 最近一次工具调用名，用于生成人性化描述 */
  tool_name?: string
  /** 单次操作耗时 */
  duration_ms?: number
  /** Agent 的最后一条回复，回传微信的数据源 */
  last_assistant_message?: string
}

export interface EventSource {
  /** 厂商原始 hook 事件名，如 PermissionRequest / pre_approval_request */
  hook: string
  transport: EventTransport
  /** 厂商原始 payload，原样保留，便于适配器演进与问题排查 */
  raw: unknown
}

export interface UnifiedEvent {
  event_id: string
  agent_id: AgentId
  task_id: string
  type: EventType
  severity: Severity
  /** 人性化标题，直接用于通知首行 */
  title: string
  /** 人性化详情，通知正文 */
  detail: string
  /** 该事件发生后任务应处于的状态 */
  status: TaskStatus
  /** ISO8601 带时区 */
  occurred_at: string
  task_meta: TaskMeta
  source: EventSource
  /**
   * 仅 auth_required 有值：这次确认在微信上能做到什么。
   * 通知末尾的引导语据此变化——不能对着一个只能远程拒绝的请求
   * 让用户「回复继续放行」。
   */
  auth_options?: AuthOptions
}

export type AuthOptions =
  /** 可以在微信里放行或拒绝 */
  | 'remote'
  /** 只能在微信里拒绝，放行要回电脑 */
  | 'deny-only'
  /** 高危操作，只能回电脑确认 */
  | 'local-only'

/** 事件类型 → 默认严重级别（PRD 5.3 通知行为表） */
export const SEVERITY_BY_EVENT: Record<EventType, Severity> = {
  task_started: 'info',
  task_progress: 'info',
  task_completed: 'low',
  task_failed: 'high',
  auth_required: 'critical',
  task_stalled: 'high'
}

/** 事件类型 → 该事件发生后的目标状态 */
export const STATUS_BY_EVENT: Record<EventType, TaskStatus> = {
  task_started: 'RUNNING',
  task_progress: 'RUNNING',
  task_completed: 'COMPLETED',
  task_failed: 'FAILED',
  auth_required: 'NEEDS_AUTH',
  task_stalled: 'STALLED'
}

/** 终态：不再接受任何后续状态迁移 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['COMPLETED', 'FAILED']

/** UI 状态色（交互原型 G2：进行中蓝 / 完成绿 / 失败红 / 待确认橙 / 卡住红） */
export const STATUS_COLOR: Record<TaskStatus, string> = {
  PENDING: 'var(--ink3)',
  RUNNING: 'var(--blue)',
  NEEDS_AUTH: 'var(--orange)',
  COMPLETED: 'var(--green)',
  FAILED: 'var(--red)',
  STALLED: 'var(--red)'
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  PENDING: '待开始',
  RUNNING: '进行中',
  NEEDS_AUTH: '待确认',
  COMPLETED: '已完成',
  FAILED: '失败',
  STALLED: '可能卡住'
}
