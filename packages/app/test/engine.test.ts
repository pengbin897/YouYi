import { describe, expect, it, vi } from 'vitest'
import type { UnifiedEvent } from '@youyi/shared'
import { MemoryStore } from '../src/main/store/memory.js'
import { EventEngine, type NotifyRequest } from '../src/main/engine/event-engine.js'
import { buildEvent, deriveTaskId } from '../src/main/engine/event-factory.js'
import { StallDetector } from '../src/main/engine/stall-detector.js'
import { canTransition } from '../src/main/engine/state-machine.js'

function setup(mergeWindowMs = 50): {
  store: MemoryStore
  engine: EventEngine
  notifications: NotifyRequest[]
} {
  const store = new MemoryStore()
  const engine = new EventEngine(store, { completionMergeWindowMs: mergeWindowMs })
  const notifications: NotifyRequest[] = []
  engine.on('notify', (n) => notifications.push(n))
  return { store, engine, notifications }
}

const TASK = deriveTaskId('claude-code', 'sess_1')

function ev(
  type: UnifiedEvent['type'],
  overrides: Partial<Parameters<typeof buildEvent>[0]> = {}
): UnifiedEvent {
  return buildEvent({
    agentId: 'claude-code',
    taskId: TASK,
    type,
    title: 't',
    detail: 'd',
    taskMeta: { session_id: 'sess_1' },
    source: { hook: 'test', transport: 'bridge', raw: {} },
    ...overrides
  })
}

describe('状态机', () => {
  it('允许 RUNNING 与 NEEDS_AUTH 双向迁移', () => {
    expect(canTransition('RUNNING', 'NEEDS_AUTH')).toBe(true)
    expect(canTransition('NEEDS_AUTH', 'RUNNING')).toBe(true)
  })

  it('拒绝从终态迁出（PRD C2 验收）', () => {
    expect(canTransition('COMPLETED', 'RUNNING')).toBe(false)
    expect(canTransition('FAILED', 'RUNNING')).toBe(false)
  })

  it('允许卡住的任务恢复运行', () => {
    expect(canTransition('STALLED', 'RUNNING')).toBe(true)
  })
})

describe('事件引擎 · 聚合去重（PRD C3）', () => {
  it('连续 10 条 progress 只产生 1 次状态更新、0 次通知', () => {
    const { engine, store, notifications } = setup()
    engine.ingest(ev('task_started', { taskMeta: { session_id: 'sess_1', task_title: '数据清洗' } }))
    for (let i = 0; i < 10; i += 1) engine.ingest(ev('task_progress'))

    const task = store.tasks.get(TASK)
    expect(task?.status).toBe('RUNNING')
    expect(task?.step_count).toBe(10)
    expect(notifications).toHaveLength(0)
  })

  it('同一 Agent 窗口内的多个完成事件合并为 1 条通知', async () => {
    const { engine, notifications } = setup(40)
    engine.ingest(ev('task_started'))
    engine.ingest(ev('task_completed'))

    const second = deriveTaskId('claude-code', 'sess_2')
    engine.ingest(ev('task_started', { taskId: second, taskMeta: { session_id: 'sess_2' } }))
    engine.ingest(ev('task_completed', { taskId: second, taskMeta: { session_id: 'sess_2' } }))

    expect(notifications).toHaveLength(0) // 合并窗口内先不发
    await new Promise((r) => setTimeout(r, 80))

    expect(notifications).toHaveLength(1)
    expect(notifications[0].kind).toBe('merged')
    expect(notifications[0].events).toHaveLength(2)
  })

  it('等待确认期间重复上报不重复通知（PRD C2 验收）', () => {
    const { engine, notifications } = setup()
    engine.ingest(ev('task_started'))
    engine.ingest(ev('auth_required'))
    engine.ingest(ev('auth_required'))
    engine.ingest(ev('auth_required'))
    expect(notifications).toHaveLength(1)
  })

  it('失败事件立即通知', () => {
    const { engine, notifications } = setup()
    engine.ingest(ev('task_started'))
    engine.ingest(ev('task_failed'))
    expect(notifications).toHaveLength(1)
    expect(notifications[0].event.severity).toBe('high')
  })

  it('乱序到达的事件不会把已完成的任务拉回运行中', () => {
    const { engine, store } = setup()
    engine.ingest(ev('task_started'))
    engine.ingest(ev('task_completed'))
    engine.ingest(ev('task_progress')) // SessionEnd 之后迟到的工具事件

    expect(store.tasks.get(TASK)?.status).toBe('COMPLETED')
  })

  it('静音的任务不产生通知（PRD F4）', () => {
    const { engine, store, notifications } = setup()
    engine.ingest(ev('task_started'))
    store.tasks.setMuted(TASK, true)
    engine.ingest(ev('task_failed'))
    expect(notifications).toHaveLength(0)
  })
})

describe('卡死检测（PRD C4）', () => {
  it('超时无进度标记为 STALLED 并触发高优先级通知', () => {
    const { engine, store, notifications } = setup()
    engine.ingest(ev('task_started'))

    const detector = new StallDetector(store, engine, () => 30 * 60 * 1000)
    // 把时钟推到 31 分钟之后
    const stalled = detector.scan(Date.now() + 31 * 60 * 1000)

    expect(stalled).toHaveLength(1)
    expect(store.tasks.get(TASK)?.status).toBe('STALLED')
    expect(notifications.at(-1)?.event.type).toBe('task_stalled')
  })

  it('中途有进度则重置计时，不误报', () => {
    const { engine, store } = setup()
    engine.ingest(ev('task_started'))
    const detector = new StallDetector(store, engine, () => 30 * 60 * 1000)

    // 29 分钟时有新进度
    const t29 = Date.now() + 29 * 60 * 1000
    vi.setSystemTime(new Date(t29))
    engine.ingest(ev('task_progress', { occurredAt: new Date(t29).toISOString() }))

    // 再过 20 分钟仍在阈值内
    expect(detector.scan(t29 + 20 * 60 * 1000)).toHaveLength(0)
    expect(store.tasks.get(TASK)?.status).toBe('RUNNING')
    vi.useRealTimers()
  })

  it('等待用户确认的任务不算卡住', () => {
    const { engine, store } = setup()
    engine.ingest(ev('task_started'))
    engine.ingest(ev('auth_required'))

    const detector = new StallDetector(store, engine, () => 30 * 60 * 1000)
    expect(detector.scan(Date.now() + 60 * 60 * 1000)).toHaveLength(0)
  })
})
