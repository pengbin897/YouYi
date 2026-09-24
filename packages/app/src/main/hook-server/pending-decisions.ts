/**
 * 挂起决策仲裁器 —— 远程放行的核心机制。
 *
 * 关键洞察：所有 Agent 的钩子都是同步的「请求-响应」，钩子进程会一直等待哨兵回话。
 * 我们利用这个等待窗口：收到权限请求类事件时先不回复，把它挂起并推送到微信，
 * 等用户回复「继续」或「停止」后再把决策写回，从而实现真正的远程放行。
 *
 * 超时处理很重要：钩子超时后 Agent 会按自己的默认流程走（多数是弹窗等本地确认），
 * 所以我们的挂起时限必须比钩子超时略短，避免出现「哨兵还在等、Agent 已经放弃」
 * 的错位状态。
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { AgentId, PendingAuth } from '@youyi/shared'
import { createLogger } from '../util/logger.js'

const log = createLogger('pending')

export type AuthDecision = 'allow' | 'deny' | 'timeout'

/** 用户主动做出决策的入口：微信上行 / 桌面面板 / 本地 CLI */
export type DecisionSource = 'wechat' | 'dashboard' | 'cli'

export interface AuthResolutionResult {
  decision: AuthDecision
  /** 是否写入永久规则（受设置约束，默认只允许单次放行） */
  permanent: boolean
  source: DecisionSource | 'timeout'
}

export interface CreatePendingInput {
  agentId: AgentId
  taskId: string
  toolName: string
  requestText: string
  highRisk: boolean
  highRiskReason?: string
  /**
   * 该 Agent 只能远程拒绝、不能远程放行（Qoder / Hermes）。
   * 此时「同意」只是不主动阻断，用户仍要在电脑上点确认，文案必须说清楚。
   */
  denyOnly?: boolean
  /** 挂起时限，调用方需保证小于该钩子的超时时间 */
  timeoutMs: number
}

interface PendingEntry {
  request: PendingAuth
  resolve: (result: AuthResolutionResult) => void
  timer: NodeJS.Timeout
}

export declare interface PendingDecisionArbiter {
  on(event: 'created', listener: (request: PendingAuth) => void): this
  on(event: 'resolved', listener: (request: PendingAuth, result: AuthResolutionResult) => void): this
}

export class PendingDecisionArbiter extends EventEmitter {
  private readonly entries = new Map<string, PendingEntry>()

  /**
   * 挂起一个权限请求。返回的 promise 在用户决策或超时后 resolve，
   * 调用方（适配器）据此组装厂商特定的响应体。
   */
  create(input: CreatePendingInput): { request: PendingAuth; wait: Promise<AuthResolutionResult> } {
    const id = randomUUID()
    const now = new Date()
    const request: PendingAuth = {
      id,
      agent_id: input.agentId,
      task_id: input.taskId,
      tool_name: input.toolName,
      request_text: input.requestText,
      high_risk: input.highRisk,
      high_risk_reason: input.highRiskReason,
      deny_only: input.denyOnly === true,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + input.timeoutMs).toISOString()
    }

    const wait = new Promise<AuthResolutionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.entries.delete(id)
        const result: AuthResolutionResult = {
          decision: 'timeout',
          permanent: false,
          source: 'timeout'
        }
        log.info('授权请求超时，交还 Agent 默认流程', { id, agent: input.agentId })
        this.emit('resolved', request, result)
        resolve(result)
      }, input.timeoutMs)
      // 挂起期间不应让 Node 的事件循环因为这个计时器而无法退出
      timer.unref?.()

      this.entries.set(id, { request, resolve, timer })
    })

    log.info('新的授权请求挂起中', {
      id,
      agent: input.agentId,
      tool: input.toolName,
      highRisk: input.highRisk
    })
    this.emit('created', request)
    return { request, wait }
  }

  /** 用户做出决策。返回 false 表示该请求已超时或已被处理。 */
  resolve(
    id: string,
    decision: Exclude<AuthDecision, 'timeout'>,
    options: { permanent?: boolean; source: DecisionSource }
  ): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false

    clearTimeout(entry.timer)
    this.entries.delete(id)

    // 高危请求禁止远程放行，即使指令是 allow 也强制降级为拒绝（护栏见 security/risk.ts）
    const effective: AuthDecision =
      entry.request.high_risk && decision === 'allow' ? 'deny' : decision

    const result: AuthResolutionResult = {
      decision: effective,
      permanent: options.permanent === true,
      source: options.source
    }
    log.info('授权请求已决策', { id, decision: effective, source: options.source })
    entry.resolve(result)
    this.emit('resolved', entry.request, result)
    return true
  }

  /** 对某个 Agent 的所有挂起请求统一决策，用于「全部停止」广播 */
  resolveAllForAgent(
    agentId: AgentId,
    decision: Exclude<AuthDecision, 'timeout'>,
    source: DecisionSource
  ): number {
    let count = 0
    for (const [id, entry] of this.entries) {
      if (entry.request.agent_id === agentId) {
        if (this.resolve(id, decision, { source })) count += 1
      }
    }
    return count
  }

  /** 最近一个挂起中的请求，用于微信里「继续/停止」这种不带 ID 的自然回复 */
  latest(agentId?: AgentId): PendingAuth | undefined {
    const list = this.list().filter((r) => !agentId || r.agent_id === agentId)
    return list[list.length - 1]
  }

  list(): PendingAuth[] {
    return [...this.entries.values()]
      .map((e) => e.request)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
  }

  get size(): number {
    return this.entries.size
  }

  /** 应用退出时把所有挂起请求交还 Agent，避免钩子一直卡着 */
  drain(): void {
    for (const id of [...this.entries.keys()]) {
      const entry = this.entries.get(id)
      if (!entry) continue
      clearTimeout(entry.timer)
      this.entries.delete(id)
      entry.resolve({ decision: 'timeout', permanent: false, source: 'timeout' })
    }
  }
}
