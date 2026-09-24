/**
 * 任务状态机（PRD C2）：PENDING → RUNNING ⇄ NEEDS_AUTH → COMPLETED / FAILED / STALLED
 *
 * COMPLETED / FAILED 是终态。之所以要严格拒绝终态之后的迁移，是因为多个钩子事件
 * 可能乱序到达（例如 SessionEnd 比 Stop 先到），如果不拦住，已完成的任务会被
 * 重新拉回 RUNNING，导致面板状态跳变、卡死检测误报。
 */

import { TERMINAL_STATUSES, type TaskStatus } from '@youyi/shared'

const ALLOWED: Record<TaskStatus, readonly TaskStatus[]> = {
  PENDING: ['PENDING', 'RUNNING', 'NEEDS_AUTH', 'COMPLETED', 'FAILED', 'STALLED'],
  RUNNING: ['RUNNING', 'NEEDS_AUTH', 'COMPLETED', 'FAILED', 'STALLED'],
  // 用户在别处点了确认，任务会自己回到 RUNNING
  NEEDS_AUTH: ['NEEDS_AUTH', 'RUNNING', 'COMPLETED', 'FAILED', 'STALLED'],
  // 卡住只是「疑似」，收到新进度就应该恢复
  STALLED: ['STALLED', 'RUNNING', 'NEEDS_AUTH', 'COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: []
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED[from].includes(to)
}

export interface TransitionResult {
  ok: boolean
  next: TaskStatus
  reason?: string
}

export function transition(from: TaskStatus, to: TaskStatus): TransitionResult {
  if (from === to) return { ok: true, next: to }
  if (canTransition(from, to)) return { ok: true, next: to }
  return {
    ok: false,
    next: from,
    reason: `非法状态迁移：${from} → ${to}${isTerminal(from) ? '（任务已处于终态）' : ''}`
  }
}
