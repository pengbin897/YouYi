/**
 * 透传出站队列 —— 把用户消息送进 Agent 的核心数据结构。
 *
 * 背景：8 个 Agent 都没有「向运行中的交互式会话注入一条用户消息」的官方 API。
 * 唯一可用的通道是 Stop 类钩子的同步响应窗口：Agent 结束一轮回答时会来问哨兵
 * 「我可以停了吗」，此时返回 block + reason，reason 就会被当作新的用户指令继续执行。
 *
 * 所以用户在微信里发的消息不能立即送达，要先在这里排队，等目标 Agent 的下一个
 * Stop 钩子到来时取走。排队超时后由路由器决定兜底（无头拉起新会话，或如实告知用户）。
 */

import { randomUUID } from 'node:crypto'
import type { AgentId } from '@youyi/shared'
import { createLogger } from '../util/logger.js'

const log = createLogger('relay-queue')

export type RelayDeliveryVia = 'stop-hook' | 'headless' | 'timeout' | 'dropped'

export interface RelayResult {
  delivered: boolean
  via: RelayDeliveryVia
}

export interface RelayMessage {
  id: string
  agentId: AgentId
  /** 指定会话时只投递给该任务，未指定则投给该 Agent 的任意一个 Stop 钩子 */
  taskId?: string
  text: string
  enqueuedAt: string
}

interface QueueEntry extends RelayMessage {
  settle: (result: RelayResult) => void
  timer: NodeJS.Timeout
}

export class RelayQueue {
  private readonly entries: QueueEntry[] = []
  /**
   * 已经注入了用户消息、正在等 Agent 回话的任务。
   * 下一次该任务的 Stop 钩子带回的 last_assistant_message 就是给用户的答复，
   * 需要原样回传而不是当成普通的任务完成摘要（PRD D3）。
   */
  private readonly awaitingReply = new Set<string>()

  /**
   * 入队一条待透传消息。返回的 promise 在消息被 Stop 钩子取走时 resolve，
   * 或在超时后以 timeout 结束，让调用方走兜底路径。
   */
  enqueue(input: {
    agentId: AgentId
    text: string
    taskId?: string
    timeoutMs: number
  }): { message: RelayMessage; wait: Promise<RelayResult> } {
    const message: RelayMessage = {
      id: randomUUID(),
      agentId: input.agentId,
      taskId: input.taskId,
      text: input.text,
      enqueuedAt: new Date().toISOString()
    }

    let settle!: (result: RelayResult) => void
    const wait = new Promise<RelayResult>((resolve) => {
      settle = (result) => {
        const index = this.entries.findIndex((e) => e.id === message.id)
        if (index >= 0) {
          clearTimeout(this.entries[index].timer)
          this.entries.splice(index, 1)
        }
        resolve(result)
      }
    })

    const timer = setTimeout(() => {
      log.info('透传消息等待超时，交还路由器兜底', { agent: input.agentId, id: message.id })
      settle({ delivered: false, via: 'timeout' })
    }, input.timeoutMs)
    timer.unref?.()

    this.entries.push({ ...message, settle, timer })
    log.info('消息已入透传队列', { agent: input.agentId, queued: this.pendingFor(input.agentId) })
    return { message, wait }
  }

  /**
   * 取走某个 Agent 待送达的消息。适配器在 Stop 钩子里调用。
   * 同一 Agent 排了多条时合并成一条送出，避免连续多轮 block 把 Agent 拖进死循环
   * （多数 Agent 对连续 block 有次数上限）。
   */
  take(agentId: AgentId, taskId?: string): { text: string; ids: string[] } | null {
    const matched = this.entries.filter(
      (e) => e.agentId === agentId && (!e.taskId || !taskId || e.taskId === taskId)
    )
    if (matched.length === 0) return null

    const text = matched.map((e) => e.text).join('\n')
    const ids = matched.map((e) => e.id)
    for (const entry of matched) entry.settle({ delivered: true, via: 'stop-hook' })

    log.info('Stop 钩子取走待透传消息', { agent: agentId, count: matched.length })
    return { text, ids }
  }

  /** 无头拉起等其他路径送达后，手动标记完成 */
  markDelivered(id: string, via: RelayDeliveryVia): void {
    this.entries.find((e) => e.id === id)?.settle({ delivered: true, via })
  }

  markAwaitingReply(taskId: string): void {
    this.awaitingReply.add(taskId)
  }

  /** 取走并清除标记；返回 true 表示这一轮的回复应该原样回传给用户 */
  consumeAwaitingReply(taskId: string): boolean {
    return this.awaitingReply.delete(taskId)
  }

  pendingFor(agentId: AgentId): number {
    return this.entries.filter((e) => e.agentId === agentId).length
  }

  list(): RelayMessage[] {
    return this.entries.map(({ id, agentId, taskId, text, enqueuedAt }) => ({
      id,
      agentId,
      taskId,
      text,
      enqueuedAt
    }))
  }

  drain(): void {
    for (const entry of [...this.entries]) entry.settle({ delivered: false, via: 'dropped' })
  }
}
