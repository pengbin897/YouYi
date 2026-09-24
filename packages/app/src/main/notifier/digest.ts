/**
 * 早报汇总（PRD F3）：把免打扰期间攒下的完成/失败任务，在早上统一发一条。
 *
 * 「无任务时不发空早报」是明确验收项——用户最反感的就是每天准点收到一条
 * 「今天没有任何事」的废话。
 */

import { agentName, type AgentId, type Task } from '@youyi/shared'
import type { SettingsStore } from '../config/settings-store.js'
import type { Store } from '../store/types.js'
import type { ChannelManager } from '../channels/manager.js'
import { createLogger } from '../util/logger.js'
import { renderDigest } from './templates.js'
import { parseTime } from './notifier.js'

const log = createLogger('digest')

/** 每分钟检查一次是否到了早报时间 */
const TICK_MS = 60 * 1000

export class DigestScheduler {
  private timer: NodeJS.Timeout | null = null
  private lastSentDate = ''

  constructor(
    private readonly settings: SettingsStore,
    private readonly store: Store,
    private readonly channels: ChannelManager
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(now: Date = new Date()): Promise<boolean> {
    const target = parseTime(this.settings.get().digestTime)
    const current = now.getHours() * 60 + now.getMinutes()
    const today = now.toISOString().slice(0, 10)

    // 只在到点后的一分钟窗口内触发，且每天最多一次（电脑休眠错过时间点也不会漏）
    if (current < target || this.lastSentDate === today) return false

    this.lastSentDate = today
    return this.flush()
  }

  /** 立即发出早报。返回是否真的发了。 */
  async flush(): Promise<boolean> {
    const queued = this.store.digest.drain()
    if (queued.length === 0) {
      log.debug('早报队列为空，不发空早报')
      return false
    }

    const byAgent = new Map<AgentId, { completed: Task[]; failed: Task[] }>()
    const seenTasks = new Set<string>()

    for (const item of queued) {
      const event = this.findEvent(item.eventId)
      if (!event) continue

      const task = this.store.tasks.get(event.task_id)
      // 同一任务在队列里可能有多条事件，只按最终状态计一次
      if (!task || seenTasks.has(task.task_id)) continue
      seenTasks.add(task.task_id)

      const group = byAgent.get(item.agentId) ?? { completed: [], failed: [] }
      if (task.status === 'FAILED' || task.status === 'STALLED') group.failed.push(task)
      else group.completed.push(task)
      byAgent.set(item.agentId, group)
    }

    if (byAgent.size === 0) return false

    const groups = [...byAgent.entries()].map(([agentId, group]) => ({
      agent: agentName(agentId),
      completed: group.completed,
      failed: group.failed
    }))

    const text = renderDigest(groups)
    const report = await this.channels.send({ kind: 'notification', text })
    log.info('早报已发出', { agents: groups.length, ok: report.ok })
    return report.ok
  }

  private findEvent(eventId: string): { task_id: string } | null {
    // 早报量很小，直接在最近 7 天的事件里查
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    return this.store.events.listSince(since).find((e) => e.event_id === eventId) ?? null
  }
}
