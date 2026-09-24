/**
 * 事件引擎（PRD C1/C2/C3/C5）。
 *
 * 职责链：归一化事件进来 → 状态机校验 → 更新任务 → 落库 → 决定要不要通知。
 * 通知的「要不要发」在这里判定（去重/聚合），「发给谁、什么时候发」由通知管家负责。
 */

import { EventEmitter } from 'node:events'
import { AGENT_REGISTRY, type AgentId, type Task, type UnifiedEvent } from '@youyi/shared'
import type { Store } from '../store/types.js'
import { createLogger } from '../util/logger.js'
import { isTerminal, transition } from './state-machine.js'

const log = createLogger('engine')

export interface NotifyRequest {
  /** single：单条事件；merged：同一 Agent 短时间内多个完成事件的汇总 */
  kind: 'single' | 'merged'
  event: UnifiedEvent
  /** kind 为 merged 时的全部事件 */
  events: UnifiedEvent[]
  task: Task
}

export interface EngineOptions {
  /**
   * 完成类通知的合并窗口。
   *
   * PRD C3 写的是 10 分钟，但若照字面实现，第一条「任务完成」通知也要压 10 分钟
   * 才发得出去，这与「睡前派活、完成即知」的核心体验冲突。因此默认取 90 秒：
   * 批量完成时仍然只收到一条汇总，单个任务完成则几乎即时。
   * 需要 PRD 的字面行为时把这个值调成 600000 即可。
   */
  completionMergeWindowMs?: number
}

const DEFAULT_MERGE_WINDOW_MS = 90 * 1000

/**
 * 每多少个工具调用算一个「关键进度节点」。
 * 各家 Agent 都不提供真实的任务进度，只能用工具调用次数近似，
 * 步长取得比较大，避免全量档变成刷屏。
 */
const PROGRESS_MILESTONE_STEPS = 20

interface MergeBucket {
  events: UnifiedEvent[]
  timer: NodeJS.Timeout
}

export declare interface EventEngine {
  on(event: 'event', listener: (e: UnifiedEvent, task: Task) => void): this
  on(event: 'task-updated', listener: (task: Task) => void): this
  on(event: 'notify', listener: (request: NotifyRequest) => void): this
}

export class EventEngine extends EventEmitter {
  private readonly mergeWindowMs: number
  private readonly buckets = new Map<AgentId, MergeBucket>()

  constructor(
    private readonly store: Store,
    options: EngineOptions = {}
  ) {
    super()
    this.mergeWindowMs = options.completionMergeWindowMs ?? DEFAULT_MERGE_WINDOW_MS
  }

  /** 归一化事件的唯一入口 */
  ingest(event: UnifiedEvent): { task: Task; notified: boolean } {
    const existing = this.store.tasks.get(event.task_id)
    const task = existing ?? this.createTask(event)

    // 状态机校验。乱序到达的事件不能把终态任务拉回运行中。
    const result = transition(task.status, event.status)
    if (!result.ok) {
      log.warn(result.reason ?? '非法状态迁移', {
        task: task.task_id,
        event: event.type,
        hook: event.source.hook
      })
      // 事件本身仍然落库，便于事后追溯，但不改状态、不通知
      this.store.events.insert({ ...event, status: task.status })
      return { task, notified: false }
    }

    const updated = this.applyEvent(task, event, result.next)
    this.store.tasks.upsert(updated)
    this.store.events.insert(event)

    this.emit('event', event, updated)
    this.emit('task-updated', updated)

    const notified = this.considerNotify(event, updated, existing?.status ?? null)
    return { task: updated, notified }
  }

  private createTask(event: UnifiedEvent): Task {
    const now = event.occurred_at
    return {
      task_id: event.task_id,
      agent_id: event.agent_id,
      title: event.task_meta.task_title?.trim() || '未命名任务',
      status: 'PENDING',
      started_at: event.task_meta.started_at ?? now,
      updated_at: now,
      progress: 0,
      session_id: event.task_meta.session_id,
      cwd: event.task_meta.cwd,
      muted: false,
      step_count: 0
    }
  }

  private applyEvent(task: Task, event: UnifiedEvent, nextStatus: Task['status']): Task {
    const next: Task = { ...task, status: nextStatus, updated_at: event.occurred_at }

    // 任务名一旦从用户 prompt 拿到就固定下来，后续事件不再覆盖
    const incomingTitle = event.task_meta.task_title?.trim()
    if (incomingTitle && (next.title === '未命名任务' || !next.title)) {
      next.title = incomingTitle
    }
    if (event.task_meta.session_id) next.session_id = event.task_meta.session_id
    if (event.task_meta.cwd) next.cwd = event.task_meta.cwd

    if (event.type === 'task_progress') {
      next.step_count = task.step_count + 1
    }

    // Agent 给了真实进度就用真实值，否则按工具调用次数做一条收敛到 95% 的估算曲线，
    // 保证进度只增不减、且永远不会在未完成时显示 100%
    next.progress =
      typeof event.task_meta.progress === 'number'
        ? clamp(event.task_meta.progress, 0, 1)
        : estimateProgress(next.step_count)

    if (event.task_meta.last_assistant_message) {
      next.summary = truncate(event.task_meta.last_assistant_message, 500)
    }

    if (isTerminal(nextStatus)) {
      next.finished_at = event.occurred_at
      next.progress = nextStatus === 'COMPLETED' ? 1 : next.progress
    }

    return next
  }

  /** 去重与聚合规则（PRD C3） */
  private considerNotify(
    event: UnifiedEvent,
    task: Task,
    previousStatus: Task['status'] | null
  ): boolean {
    if (task.muted) return false

    switch (event.type) {
      // 任务启动只更新状态，不通知
      case 'task_started':
        return false

      // 进度默认不通知（PRD C3）。只有每隔若干步的「里程碑」才向上抛，
      // 由通知管家决定是否发出——目前只有全量档会放行（PRD F1）。
      case 'task_progress':
        if (task.step_count > 0 && task.step_count % PROGRESS_MILESTONE_STEPS === 0) {
          this.emitNotify({ kind: 'single', event, events: [event], task })
          return true
        }
        return false

      case 'auth_required':
        // 同一任务在等待确认期间重复上报，不重复打扰（PRD C2 验收）
        if (previousStatus === 'NEEDS_AUTH') {
          log.debug('该任务已在等待确认，跳过重复通知', { task: task.task_id })
          return false
        }
        this.emitNotify({ kind: 'single', event, events: [event], task })
        return true

      case 'task_completed':
        this.pushToMergeBucket(event)
        return true

      case 'task_failed':
      case 'task_stalled':
        this.emitNotify({ kind: 'single', event, events: [event], task })
        return true

      default:
        return false
    }
  }

  /**
   * 完成事件先进合并桶。窗口从第一条完成事件开始计时，窗口内的后续完成事件
   * 一并汇总，到点只发一条。
   */
  private pushToMergeBucket(event: UnifiedEvent): void {
    const bucket = this.buckets.get(event.agent_id)
    if (bucket) {
      bucket.events.push(event)
      return
    }

    const timer = setTimeout(() => this.flushBucket(event.agent_id), this.mergeWindowMs)
    timer.unref?.()
    this.buckets.set(event.agent_id, { events: [event], timer })
  }

  private flushBucket(agentId: AgentId): void {
    const bucket = this.buckets.get(agentId)
    if (!bucket) return
    this.buckets.delete(agentId)
    clearTimeout(bucket.timer)

    const last = bucket.events[bucket.events.length - 1]
    const task = this.store.tasks.get(last.task_id)
    if (!task) return

    this.emitNotify({
      kind: bucket.events.length > 1 ? 'merged' : 'single',
      event: last,
      events: bucket.events,
      task
    })
  }

  /** 立刻冲刷所有等待中的合并桶，应用退出前调用 */
  flushAll(): void {
    for (const agentId of [...this.buckets.keys()]) this.flushBucket(agentId)
  }

  private emitNotify(request: NotifyRequest): void {
    this.emit('notify', request)
  }
}

function estimateProgress(steps: number): number {
  if (steps <= 0) return 0
  return Math.min(0.95, 1 - Math.exp(-steps / 12))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 各 Agent 的默认卡死阈值 */
export function stallTimeoutFor(agentId: AgentId, fallback: number): number {
  return AGENT_REGISTRY[agentId]?.stallTimeoutMs ?? fallback
}
