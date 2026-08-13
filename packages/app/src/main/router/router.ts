/**
 * 消息路由器（PRD 模块 D）：上行消息的总调度。
 *
 * 上行入口有两个：微信（渠道推送）与本地 CLI（HTTP 同步调用，v0.7）。
 * 两者走完全相同的意图解析与安全护栏，唯一差别是回复的去向——
 * 微信的回复发回渠道，CLI 的回复通过 reply 覆写同步返回给调用方。
 *
 * 目标判定的优先级，从强到弱：
 * 1. 用户显式指定（「交给 Claude：…」或 CLI 的 --agent）
 * 2. 正在等你确认的那个 Agent —— 这是最常见的场景，用户回「继续」显然是回它
 * 3. 最近活跃的 Agent
 * 多个 Agent 同时在跑且都没有挂起请求时，不猜，回问用户（PRD D1 验收）。
 */

import {
  AGENT_REGISTRY,
  STATUS_LABEL,
  agentName,
  type AgentId,
  type AuditAction,
  type AuditLog,
  type PendingAuth
} from '@youyi/shared'
import type { SettingsStore } from '../config/settings-store.js'
import type { Store } from '../store/types.js'
import type { DecisionSource, PendingDecisionArbiter } from '../hook-server/pending-decisions.js'
import type { AdapterRegistry } from '../adapters/registry.js'
import type { ChannelManager } from '../channels/manager.js'
import type { InboundMessage } from '../channels/types.js'
import { highRiskNotice } from '../security/risk.js'
import { createLogger } from '../util/logger.js'
import { formatDuration, GUIDE_DEFAULT } from '../notifier/templates.js'
import { parseIntent, type Intent } from './intent.js'
import type { RelayQueue } from './relay-queue.js'

const log = createLogger('router')

/** 「全部停止」的二次确认有效期 */
const STOP_ALL_CONFIRM_TTL_MS = 2 * 60 * 1000

export interface RouterDeps {
  settings: SettingsStore
  store: Store
  pending: PendingDecisionArbiter
  relay: RelayQueue
  adapters: AdapterRegistry
  channels: ChannelManager
}

/** 单条上行消息的回复出口。默认发回通知渠道，CLI 场景下覆写为同步收集器。 */
export type ReplyFn = (text: string) => Promise<void>

export interface HandleInboundOptions {
  /** 覆写回复去向。不给时回复走通知渠道（微信等） */
  reply?: ReplyFn
  /** 显式指定透传目标（CLI 的 --agent），给出时跳过意图解析直接透传 */
  forceAgent?: AgentId
}

export class MessageRouter {
  private stopAllRequestedAt: number | null = null

  constructor(private readonly deps: RouterDeps) {}

  async handleInbound(message: InboundMessage, options?: HandleInboundOptions): Promise<void> {
    const reply: ReplyFn =
      options?.reply ??
      (async (text) => {
        await this.deps.channels.send({ kind: 'system', text })
      })

    if (message.type !== 'text') {
      await reply('目前只支持文字消息，图片和语音还处理不了。')
      return
    }

    const intent: Intent = options?.forceAgent
      ? { kind: 'relay', agentId: options.forceAgent, text: message.text }
      : parseIntent(message.text)
    log.info('收到上行消息', { intent: intent.kind, channel: message.channelId })

    try {
      await this.route(intent, message, reply)
    } catch (err) {
      log.error('处理上行消息失败', String(err))
      await reply('处理这条消息时出错了，可以到电脑上看看哨兵的日志。')
    }
  }

  private async route(intent: Intent, message: InboundMessage, reply: ReplyFn): Promise<void> {
    switch (intent.kind) {
      case 'status':
        await this.answerStatus(reply)
        return
      case 'help':
        await this.answerHelp(reply)
        return
      case 'approve':
        await this.decide('allow', message, reply)
        return
      case 'deny':
        await this.decide('deny', message, reply)
        return
      case 'stop-all':
        await this.requestStopAll(reply)
        return
      case 'stop-all-confirm':
        await this.confirmStopAll(message, reply)
        return
      case 'relay':
        await this.relay(intent.agentId, intent.text, message, reply)
        return
    }
  }

  /** PRD D4：状态查询由哨兵本地自答，不去打扰任何 Agent */
  private async answerStatus(reply: ReplyFn): Promise<void> {
    const tasks = this.deps.store.tasks.listActive()
    const pending = this.deps.pending.list()

    if (tasks.length === 0 && pending.length === 0) {
      await reply('当前没有正在跑的任务。')
      return
    }

    const lines = tasks.map((task) => {
      const percent = Math.round(task.progress * 100)
      return `· [${agentName(task.agent_id)}] ${task.title} — ${STATUS_LABEL[task.status]}${
        task.status === 'RUNNING' ? ` ${percent}%` : ''
      }，已运行 ${formatDuration(task)}`
    })

    if (pending.length > 0) {
      lines.push('', `有 ${pending.length} 个请求在等你确认：`)
      for (const request of pending) {
        lines.push(`· [${agentName(request.agent_id)}] ${request.request_text}`)
      }
    }

    await reply([`当前有 ${tasks.length} 个任务：`, ...lines, '', GUIDE_DEFAULT].join('\n'))
  }

  private async answerHelp(reply: ReplyFn): Promise<void> {
    await reply(
      [
        '可以这样跟我说话：',
        '· 继续 / 停止 —— 放行或拒绝正在等你确认的操作',
        '· 状态 —— 看所有 Agent 在干什么（我本地回答，不打扰它们）',
        '· 交给 Claude：帮我看下日志 —— 把话转给指定的 Agent',
        '· 其他任何话 —— 原样转给当前 Agent',
        '· 全部停止 —— 停下所有任务（会再问你一次）'
      ].join('\n')
    )
  }

  /** PRD D 远程放行：把决策写回还在等待的钩子 */
  private async decide(
    decision: 'allow' | 'deny',
    message: InboundMessage,
    reply: ReplyFn
  ): Promise<void> {
    const request = this.deps.pending.latest()

    if (!request) {
      // 没有挂起请求时，「继续/停止」就是普通对话，原样透传
      await this.relay(undefined, decision === 'allow' ? '继续' : '请停止当前任务', message, reply)
      return
    }

    if (decision === 'allow' && request.high_risk) {
      this.audit(
        'remote_auth',
        request.agent_id,
        'denied',
        `高危请求被拦截：${request.request_text}`,
        message
      )
      await reply(highRiskNotice(request.high_risk_reason ?? '风险较高'))
      return
    }

    if (decision === 'allow' && !this.deps.settings.get().remoteAuth.enabled) {
      await reply('远程放行当前是关闭状态，需要在电脑上的设置里先打开。')
      return
    }

    const resolved = this.deps.pending.resolve(request.id, decision, {
      source: this.decisionSource(message),
      // 默认只放行这一次。永久规则风险太高，必须用户在电脑上显式开启（PRD 安全红线）
      permanent: false
    })

    if (!resolved) {
      await reply('这个请求已经超时或已经处理过了。')
      return
    }

    this.audit(
      'remote_auth',
      request.agent_id,
      decision === 'allow' ? 'success' : 'denied',
      `${decision === 'allow' ? '放行' : '拒绝'}：${request.request_text}`,
      message
    )
    await reply(this.decisionNotice(request, decision))
  }

  /**
   * 决策结果的回话。
   *
   * Qoder 和 Hermes 的钩子只给了「阻断」的口子，没给「批准」的口子，
   * 所以对这两家说「已放行」是骗人——只能说清楚「我不拦了，但还得你去点确认」。
   */
  private decisionNotice(request: PendingAuth, decision: 'allow' | 'deny'): string {
    const name = agentName(request.agent_id)
    if (decision === 'deny') return `已拒绝，${name} 不会执行这个操作。`
    if (request.deny_only) {
      return `我不拦了，但 ${name} 的钩子不支持远程批准，还需要你在电脑上点一下确认。`
    }
    return `已放行，${name} 继续干活了。这次放行只对这一次操作生效。`
  }

  /** PRD D2：把用户的话排进透传队列，等目标 Agent 的下一个 Stop 钩子取走 */
  private async relay(
    explicitAgent: AgentId | undefined,
    text: string,
    message: InboundMessage,
    reply: ReplyFn
  ): Promise<void> {
    if (!text.trim()) return

    const target = explicitAgent ?? this.resolveDefaultTarget()
    if (!target) {
      await reply('现在没有在跑的 Agent，我不知道该把这句话转给谁。')
      return
    }
    if (target === 'ambiguous') {
      const running = this.runningAgents()
      await reply(
        [
          '现在有多个 Agent 在跑，我不确定该转给谁：',
          ...running.map((id) => `· ${agentName(id)}`),
          '',
          '可以这样说：交给 Claude：你的话'
        ].join('\n')
      )
      return
    }

    const meta = AGENT_REGISTRY[target]
    if (!meta.canRelay) {
      await reply(`${meta.name} 没有提供可用于透传的钩子，暂时没法把话送进去，只能通知你它的状态。`)
      return
    }

    const { wait } = this.deps.relay.enqueue({
      agentId: target,
      text,
      timeoutMs: this.deps.settings.get().relayQueueTimeoutMs
    })

    this.audit('relay', target, 'success', text.slice(0, 100), message)
    await reply(`已记下，${meta.name} 这一轮结束时就会收到。它回话后我原样转给你。`)

    // 超时说明这一轮迟迟没结束，如实告诉用户，不要让消息悄无声息地丢掉
    const result = await wait
    if (!result.delivered) {
      const headless = await this.tryHeadless(target, text, reply)
      if (!headless) {
        await reply(`${meta.name} 这一轮还没结束，你的话还没送进去。它一结束我就会转达。`)
      }
    }
  }

  /** 透传超时的兜底：能无头拉起就无头拉起（目前只有 Claude Code 支持） */
  private async tryHeadless(agentId: AgentId, text: string, reply: ReplyFn): Promise<boolean> {
    const adapter = this.deps.adapters.get(agentId)
    if (!adapter?.sendHeadless || !AGENT_REGISTRY[agentId].canHeadless) return false

    const task = this.deps.store.tasks
      .list({ limit: 20 })
      .find((t) => t.agent_id === agentId && t.session_id)

    try {
      const ok = await adapter.sendHeadless(text, {
        sessionId: task?.session_id,
        cwd: task?.cwd
      })
      if (ok) {
        await reply(`${agentName(agentId)} 那一轮没结束，我另起了一次执行，结果稍后告诉你。`)
      }
      return ok
    } catch (err) {
      log.warn('无头拉起失败', { agent: agentId, error: String(err) })
      return false
    }
  }

  /**
   * 默认目标：优先给正在等确认的那个，其次最近活跃的。
   * 多个在跑又都没在等确认时返回 ambiguous，让用户自己指定。
   */
  private resolveDefaultTarget(): AgentId | 'ambiguous' | null {
    const pending = this.deps.pending.latest()
    if (pending) return pending.agent_id

    const running = this.runningAgents()
    if (running.length === 1) return running[0]
    if (running.length > 1) return 'ambiguous'

    return this.deps.store.tasks.mostRecentlyActiveAgent()
  }

  private runningAgents(): AgentId[] {
    const ids = new Set<AgentId>()
    for (const task of this.deps.store.tasks.listActive()) ids.add(task.agent_id)
    return [...ids]
  }

  /** PRD D5：全部停止必须二次确认 */
  private async requestStopAll(reply: ReplyFn): Promise<void> {
    const tasks = this.deps.store.tasks.listActive()
    if (tasks.length === 0) {
      await reply('现在没有在跑的任务。')
      return
    }

    this.stopAllRequestedAt = Date.now()
    await reply(
      [
        `确认要停止全部 ${tasks.length} 个任务吗？`,
        ...tasks.map((t) => `· [${agentName(t.agent_id)}] ${t.title}`),
        '',
        '确定的话回复「确认停止」，2 分钟内有效。'
      ].join('\n')
    )
  }

  private async confirmStopAll(message: InboundMessage, reply: ReplyFn): Promise<void> {
    if (
      this.stopAllRequestedAt === null ||
      Date.now() - this.stopAllRequestedAt > STOP_ALL_CONFIRM_TTL_MS
    ) {
      await reply('没有待确认的停止请求，或者已经超过 2 分钟了。可以重新说「全部停止」。')
      return
    }
    this.stopAllRequestedAt = null

    const agents = this.runningAgents()
    let denied = 0
    for (const agentId of agents) {
      // 先拒掉所有挂起的授权请求，这是唯一能立刻生效的「刹车」
      denied += this.deps.pending.resolveAllForAgent(agentId, 'deny', this.decisionSource(message))
      // 再往透传队列塞一条停止指令，等各自的 Stop 钩子取走
      if (AGENT_REGISTRY[agentId].canRelay) {
        this.deps.relay.enqueue({
          agentId,
          text: '请立刻停止当前任务，不要继续执行后续步骤。',
          timeoutMs: this.deps.settings.get().relayQueueTimeoutMs
        })
      }
    }

    this.audit('broadcast_stop', undefined, 'success', `涉及 ${agents.length} 个 Agent`, message)
    await reply(
      [
        `已向 ${agents.length} 个 Agent 发出停止指令${denied > 0 ? `，并拒绝了 ${denied} 个待确认请求` : ''}。`,
        '需要说明的是：Agent 要在当前这一步结束后才会收到停止指令，正在执行的这一步不会被强行打断。'
      ].join('\n')
    )
  }

  /** 决策来源：CLI 之外的上行入口目前只有微信 */
  private decisionSource(message: InboundMessage): DecisionSource {
    return message.channelId === 'cli' ? 'cli' : 'wechat'
  }

  private audit(
    action: AuditAction,
    agentId: AgentId | undefined,
    result: AuditLog['result'],
    summary: string,
    message: InboundMessage
  ): void {
    this.deps.store.audit.append({
      action,
      agent_id: agentId,
      // 审计要如实记录操作入口（PRD I1 验收：CLI 通道标注为 cli）
      channel: message.channelId,
      summary,
      result
    })
  }
}
