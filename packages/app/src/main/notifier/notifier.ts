/**
 * 通知管家（PRD F1/F2）：决定一条通知「发不发、现在发还是攒到早报」。
 *
 * 两道闸门：
 * 1. 打扰档位 —— 安静档只放行失败/需确认/卡住；标准档加上完成；全量档再加进度节点。
 * 2. 免打扰时段 —— 时段内只有最高优先级（需要你确认）能穿透，其余进早报队列。
 */

import type { Severity } from '@youyi/shared'
import type { NotifyRequest } from '../engine/event-engine.js'
import type { SettingsStore } from '../config/settings-store.js'
import type { Store } from '../store/types.js'
import type { ChannelManager } from '../channels/manager.js'
import { createLogger } from '../util/logger.js'
import { renderEvent, renderMerged } from './templates.js'

const log = createLogger('notifier')

/** 各档位放行的严重级别（PRD F1） */
const TIER_ALLOWED: Record<string, Severity[]> = {
  quiet: ['critical', 'high'],
  standard: ['critical', 'high', 'low'],
  full: ['critical', 'high', 'low', 'info']
}

export class Notifier {
  constructor(
    private readonly settings: SettingsStore,
    private readonly store: Store,
    private readonly channels: ChannelManager
  ) {}

  async handle(request: NotifyRequest): Promise<void> {
    const settings = this.settings.get()
    const severity = request.event.severity

    if (!TIER_ALLOWED[settings.notifyTier].includes(severity)) {
      log.debug('当前打扰档位不放行该通知', { tier: settings.notifyTier, severity })
      return
    }

    // 免打扰时段内只有「需要你确认」能穿透，其余攒到早报
    if (severity !== 'critical' && this.inQuietHours(settings.dnd, new Date())) {
      for (const event of request.events) {
        this.store.digest.enqueue(event.event_id, event.agent_id)
      }
      log.info('免打扰时段，通知转入早报', { count: request.events.length })
      return
    }

    const text =
      request.kind === 'merged'
        ? renderMerged(request.events, this.resolveTasks(request))
        : renderEvent(request.event, request.task)

    const report = await this.channels.send({ kind: 'notification', text })
    if (!report.ok) {
      log.error('通知发送失败', { error: report.error })
    }
  }

  private resolveTasks(request: NotifyRequest): typeof request.task[] {
    const seen = new Set<string>()
    const tasks: typeof request.task[] = []
    for (const event of request.events) {
      if (seen.has(event.task_id)) continue
      seen.add(event.task_id)
      const task = this.store.tasks.get(event.task_id)
      if (task) tasks.push(task)
    }
    return tasks
  }

  /** 支持跨零点的时段，如 22:00-08:00 */
  inQuietHours(dnd: { enabled: boolean; start: string; end: string }, now: Date): boolean {
    if (!dnd.enabled) return false
    const current = now.getHours() * 60 + now.getMinutes()
    const start = parseTime(dnd.start)
    const end = parseTime(dnd.end)
    if (start === end) return false
    return start < end ? current >= start && current < end : current >= start || current < end
  }
}

export function parseTime(value: string): number {
  const [h, m] = value.split(':').map((part) => Number.parseInt(part, 10))
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
}
