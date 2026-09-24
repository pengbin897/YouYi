/**
 * 会话 → 任务的映射。
 *
 * 一个关键的建模决定：**任务 = 一轮对话，而不是一个会话**。
 * 用户心里的「任务」是「我派的这件活」，一个 Claude 会话里可能连续派十件活。
 * 如果把整个会话当成一个任务，那么第一轮 Stop 之后任务就进了终态，
 * 后面所有事件都会被状态机判为非法迁移。
 *
 * 所以：用户每提交一次 prompt 就开一个新任务，中间所有事件都归到当前任务上。
 * 映射存在 kv 表里，应用重启后仍能把事件接回正确的任务。
 */

import { randomUUID } from 'node:crypto'
import type { AgentId } from '@youyi/shared'
import type { Store } from '../store/types.js'

export class SessionTracker {
  constructor(private readonly store: Store) {}

  private key(agentId: AgentId, sessionId: string): string {
    return `session:${agentId}:${sessionId}`
  }

  /** 用户提交了新指令，开一轮新任务 */
  startTurn(agentId: AgentId, sessionId: string): string {
    const taskId = `task_${agentId}_${randomUUID().slice(0, 12)}`
    this.store.kv.set(this.key(agentId, sessionId), taskId)
    return taskId
  }

  /** 取当前任务；没有则隐式开一轮（例如钩子先于 UserPromptSubmit 到达） */
  current(agentId: AgentId, sessionId: string): string {
    const existing = this.store.kv.get<string>(this.key(agentId, sessionId))
    if (existing) return existing
    return this.startTurn(agentId, sessionId)
  }

  /**
   * 当前任务已进终态时开新一轮，否则复用。
   * 用于那些没有明确「用户提交指令」钩子的 Agent。
   */
  currentOrNext(agentId: AgentId, sessionId: string): string {
    const taskId = this.current(agentId, sessionId)
    const task = this.store.tasks.get(taskId)
    if (task && (task.status === 'COMPLETED' || task.status === 'FAILED')) {
      return this.startTurn(agentId, sessionId)
    }
    return taskId
  }
}
