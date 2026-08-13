/**
 * 卡死检测（PRD C4）。
 *
 * 判定条件刻意收紧，因为误报比漏报更伤信任（验收要求误报率 <5%）：
 * - 只看 RUNNING 状态。NEEDS_AUTH 是在等用户，不是卡住；STALLED 已经报过不重复报。
 * - 任何事件都会刷新 updated_at，所以只要 Agent 还在调工具就不会误判。
 * - 每个任务只报一次，恢复后（收到新事件回到 RUNNING）才会重新计时。
 */

import { AGENT_REGISTRY, agentName, type Task } from '@youyi/shared'
import type { Store } from '../store/types.js'
import { createLogger } from '../util/logger.js'
import type { EventEngine } from './event-engine.js'
import { buildEvent } from './event-factory.js'

const log = createLogger('stall')

const SCAN_INTERVAL_MS = 30 * 1000

export class StallDetector {
  private timer: NodeJS.Timeout | null = null
  /** 已经报过卡住的任务，避免反复推送 */
  private reported = new Set<string>()

  constructor(
    private readonly store: Store,
    private readonly engine: EventEngine,
    private readonly getDefaultTimeoutMs: () => number
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.scan(), SCAN_INTERVAL_MS)
    this.timer.unref?.()
    log.info('卡死检测已启动', { intervalMs: SCAN_INTERVAL_MS })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 收到任务的新事件时调用，解除「已报卡住」标记，使其可以再次被检测 */
  noteActivity(taskId: string): void {
    this.reported.delete(taskId)
  }

  scan(now: number = Date.now()): Task[] {
    const stalled: Task[] = []
    for (const task of this.store.tasks.listActive()) {
      if (task.status !== 'RUNNING') continue
      if (this.reported.has(task.task_id)) continue

      const threshold =
        AGENT_REGISTRY[task.agent_id]?.stallTimeoutMs ?? this.getDefaultTimeoutMs()
      const idleMs = now - new Date(task.updated_at).getTime()
      if (idleMs < threshold) continue

      this.reported.add(task.task_id)
      stalled.push(task)

      const minutes = Math.round(idleMs / 60000)
      this.engine.ingest(
        buildEvent({
          agentId: task.agent_id,
          taskId: task.task_id,
          type: 'task_stalled',
          title: `${agentName(task.agent_id)} 的任务可能卡住了`,
          detail: `「${task.title}」已经 ${minutes} 分钟没有新进展，你可能需要去看一眼。`,
          taskMeta: { started_at: task.started_at, progress: task.progress },
          source: { hook: 'stall-detector', transport: 'internal', raw: { idleMs, threshold } }
        })
      )
      log.warn('任务被标记为卡住', { task: task.task_id, idleMs })
    }
    return stalled
  }
}
