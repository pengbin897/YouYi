/**
 * 前端会话续聊（v1.1）：Dashboard 任务详情里把用户消息送进选中的 Workbuddy 会话。
 *
 * 与 MessageRouter 的关系：这里不做意图解析与默认目标判定（用户已显式选中会话），
 * 但投递与审计语义与 router 对齐：
 * - 会话还在跑 → 消息进透传队列（带 taskId 定向），等该会话本轮的 Stop 钩子注入；
 * - 会话已结束 → 适配器 resumeSession 无头续跑（CodeBuddy Agent SDK），
 *   自动产生新一轮任务，回复原文以内部事件落库并推回前端。
 */

import type { SendTaskMessageResult, Task, ChatEntry, AgentId } from '@youyi/shared'
import type { SettingsStore } from '../config/settings-store.js'
import type { Store } from '../store/types.js'
import type { EventEngine } from '../engine/event-engine.js'
import type { SessionTracker } from '../engine/session-tracker.js'
import type { AdapterRegistry } from '../adapters/registry.js'
import type { RelayQueue } from './relay-queue.js'
import { buildEvent } from '../engine/event-factory.js'
import { createLogger } from '../util/logger.js'

const log = createLogger('session-chat')

/** v1.1 范围：续聊仅支持 Workbuddy（CodeBuddy），其余 Agent 不开放入口 */
const CHAT_AGENTS: readonly AgentId[] = ['workbuddy']

const ACTIVE_STATUSES: readonly Task['status'][] = ['PENDING', 'RUNNING', 'NEEDS_AUTH']

export interface SessionChatDeps {
  settings: SettingsStore
  store: Store
  relay: RelayQueue
  adapters: AdapterRegistry
  engine: EventEngine
  sessions: SessionTracker
}

export class SessionChat {
  /** session_id → 进行中无头续跑的中断控制器。同一会话同时只允许一个续跑 */
  private readonly active = new Map<string, AbortController>()

  constructor(private readonly deps: SessionChatDeps) {}

  async send(taskId: string, text: string): Promise<SendTaskMessageResult> {
    const task = this.deps.store.tasks.get(taskId)
    if (!task) return { ok: false, error: '任务不存在或已被清除。' }
    if (!text.trim()) return { ok: false, error: '消息不能为空。' }
    if (!CHAT_AGENTS.includes(task.agent_id)) {
      return { ok: false, error: '续聊目前仅支持 Workbuddy。' }
    }
    if (!task.session_id) return { ok: false, error: '这个任务没有会话信息，无法继续对话。' }

    // 路径判定看「会话当前那一轮」：用户选中的可能是旧轮次，最新轮还在跑
    const latest =
      this.deps.store.tasks.findBySession(task.agent_id, task.session_id) ?? task

    if (ACTIVE_STATUSES.includes(latest.status)) {
      // 会话进行中：排队等 Stop 钩子注入。带 taskId 定向，不会被同 Agent 其他会话抢走
      this.audit(task, text)
      this.deps.relay.enqueue({
        agentId: task.agent_id,
        taskId: latest.task_id,
        text,
        timeoutMs: this.deps.settings.get().relayQueueTimeoutMs
      })
      return { ok: true, via: 'stop-hook' }
    }

    if (this.active.has(task.session_id)) {
      return { ok: false, error: '这个会话正在处理你上一条消息，稍后再发。' }
    }

    const adapter = this.deps.adapters.get(task.agent_id)
    if (!adapter?.resumeSession) {
      return { ok: false, error: '当前版本不支持这个 Agent 的续聊。' }
    }

    this.audit(task, text)

    // 无头续跑：异步执行、立即返回。回复经事件管线（pushEvent）推回前端
    const controller = new AbortController()
    this.active.set(task.session_id, controller)
    void this.runResume(task, text, controller).finally(() =>
      this.active.delete(task.session_id)
    )
    return { ok: true, via: 'headless' }
  }

  /** 该任务所属会话的对话流（所有轮次的用户消息 / Agent 回复 / 状态） */
  conversation(taskId: string): ChatEntry[] | null {
    const task = this.deps.store.tasks.get(taskId)
    if (!task?.session_id) return null

    const turns = this.deps.store.tasks.listBySession(task.agent_id, task.session_id)
    const entries: ChatEntry[] = []

    for (const turn of turns) {
      const started = this.deps.store.events
        .listByTask(turn.task_id)
        .find((e) => e.type === 'task_started')
      // 用户气泡取 task_started 事件的 detail（即当初提交的 prompt）
      if (started) {
        entries.push({ id: started.event_id, role: 'user', text: started.detail, at: started.occurred_at })
      }

      for (const entry of describeTurn(turn)) {
        entries.push({ ...entry, id: `${turn.task_id}:${entry.id}` })
      }
    }
    return entries
  }

  /** 应用退出时叫停所有仍在跑的无头续跑，避免留下孤儿子进程 */
  dispose(): void {
    for (const controller of this.active.values()) controller.abort()
    this.active.clear()
  }

  private async runResume(
    task: Task,
    text: string,
    controller: AbortController
  ): Promise<void> {
    const adapter = this.deps.adapters.get(task.agent_id)
    if (!adapter?.resumeSession) return

    let result: { ok: boolean; reply?: string; error?: string }
    try {
      result = await adapter.resumeSession(text, {
        sessionId: task.session_id!,
        cwd: task.cwd,
        abortController: controller
      })
    } catch (err) {
      log.warn('无头续跑异常', { session: task.session_id, error: String(err) })
      result = { ok: false, error: String(err) }
    }

    // 回复挂到「会话当前那一轮」上：钩子若已触发，UserPromptSubmit 已把映射指向新一轮；
    // 若钩子没触发（设计文档 §8 V2 风险），映射仍指旧任务，同状态迁移仍能补上 summary
    const taskId = this.deps.sessions.current(task.agent_id, task.session_id!)
    const meta = { session_id: task.session_id, cwd: task.cwd }

    if (result.ok && result.reply) {
      this.deps.engine.ingest(
        buildEvent({
          agentId: task.agent_id,
          taskId,
          type: 'task_completed',
          title: '任务完成',
          detail: result.reply,
          taskMeta: { ...meta, last_assistant_message: result.reply },
          source: { hook: 'sdk-resume', transport: 'internal', raw: null }
        })
      )
      return
    }

    if (!result.ok) {
      this.deps.engine.ingest(
        buildEvent({
          agentId: task.agent_id,
          taskId,
          type: 'task_failed',
          title: '无头续跑失败',
          detail: result.error ?? '这一轮没能完成。',
          taskMeta: meta,
          source: { hook: 'sdk-resume', transport: 'internal', raw: null }
        })
      )
    }
    // ok 但没有回复原文：钩子已经讲完这一轮的故事，不再补事件
  }

  /** 与 router 的透传审计同构（PRD D5），渠道如实标注入口 */
  private audit(task: Task, text: string): void {
    this.deps.store.audit.append({
      action: 'relay',
      agent_id: task.agent_id,
      task_id: task.task_id,
      channel: 'dashboard',
      summary: text.slice(0, 100),
      result: 'success'
    })
  }
}

/** 一轮任务的收尾气泡。拿不到回复原文时如实说明，不编造 */
function describeTurn(turn: Task): { id: string; role: ChatEntry['role']; text: string; at: string }[] {
  switch (turn.status) {
    case 'PENDING':
    case 'RUNNING':
      return [{ id: 'running', role: 'status', text: 'Workbuddy 正在处理…', at: turn.updated_at }]
    case 'NEEDS_AUTH':
      return [{ id: 'auth', role: 'status', text: '这一轮在等你确认', at: turn.updated_at }]
    case 'FAILED':
      return [{ id: 'failed', role: 'status', text: '这一轮失败了', at: turn.updated_at }]
    case 'STALLED':
      return [{ id: 'stalled', role: 'status', text: '这一轮疑似卡住了', at: turn.updated_at }]
    case 'COMPLETED':
      return turn.summary
        ? [{ id: 'reply', role: 'agent', text: turn.summary, at: turn.updated_at }]
        : [
            {
              id: 'noreply',
              role: 'agent',
              text: '（这一轮的回复原文 Workbuddy 不提供，完整内容见终端）',
              at: turn.updated_at
            }
          ]
  }
}
