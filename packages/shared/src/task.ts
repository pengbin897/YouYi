/** 任务与审计记录的持久化模型（PRD C5 / D5） */

import type { AgentId } from './agents.js'
import type { TaskStatus, UnifiedEvent } from './events.js'

export interface Task {
  task_id: string
  agent_id: AgentId
  /** 任务标题，取自首个用户 prompt 或会话摘要 */
  title: string
  status: TaskStatus
  started_at: string
  updated_at: string
  finished_at?: string
  progress: number
  session_id?: string
  cwd?: string
  /** 结果摘要，来自 Agent 的最后一条回复 */
  summary?: string
  /** 单任务静音（PRD F4） */
  muted: boolean
  /** 工具调用次数，用于估算进度 */
  step_count: number
}

export interface TaskWithEvents extends Task {
  events: UnifiedEvent[]
}

/** 审计日志动作类型（PRD D5） */
export type AuditAction =
  | 'relay' // 用户消息透传给 Agent
  | 'reply_back' // Agent 回复回传渠道
  | 'broadcast_stop' // 全部停止广播
  | 'remote_auth' // 远程放行/拒绝
  | 'notify' // 通知发送
  | 'hook_install' // Hook 安装/卸载
  | 'data_clear' // 一键清除数据

export interface AuditLog {
  id: number
  action: AuditAction
  agent_id?: AgentId
  task_id?: string
  channel?: string
  /** 内容摘要（不落全文，隐私底线） */
  summary: string
  result: 'success' | 'failed' | 'pending' | 'denied'
  detail?: string
  created_at: string
}

/** 待处理的远程授权请求（PRD D1 / 远程放行护栏） */
export interface PendingAuth {
  id: string
  agent_id: AgentId
  task_id: string
  /** 请求放行的工具名，如 Bash / Write */
  tool_name: string
  /** 人类可读的请求内容，如具体命令或文件路径 */
  request_text: string
  /** 命中高危规则时为 true，此时禁止远程放行 */
  high_risk: boolean
  high_risk_reason?: string
  /** 该 Agent 只能远程拒绝，「同意」不等于放行，UI 与微信文案需据此调整 */
  deny_only: boolean
  created_at: string
  /** 挂起响应的截止时间，超过后按 Agent 默认流程走 */
  expires_at: string
}
