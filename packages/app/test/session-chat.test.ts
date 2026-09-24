/**
 * 前端会话续聊（v1.1）的验收测试。
 *
 * 覆盖「不用真 CodeBuddy 也能验」的部分：路径判定（进行中→透传队列定向注入 /
 * 已结束→SDK 无头续跑）、并发锁、回复落库、对话流组装、审计与退出清理。
 * SDK 与真实 CLI 的联调（钩子触发、登录态、打包定位）只能人工验，
 * 对应设计文档 §8 的 V2–V5。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const DATA = mkdtempSync(join(tmpdir(), 'youyi-chat-'))
process.env.YOUYI_HOME = DATA

const { SessionChat } = await import('../src/main/router/session-chat.js')
const { EventEngine } = await import('../src/main/engine/event-engine.js')
const { SessionTracker } = await import('../src/main/engine/session-tracker.js')
const { RelayQueue } = await import('../src/main/router/relay-queue.js')
const { MemoryStore } = await import('../src/main/store/memory.js')
const { SettingsStore } = await import('../src/main/config/settings-store.js')
const { buildEvent } = await import('../src/main/engine/event-factory.js')
import type { AgentId, Task, UnifiedEvent } from '@youyi/shared'
import type { AdapterRegistry } from '../src/main/adapters/registry.js'

let store: InstanceType<typeof MemoryStore>
let settings: InstanceType<typeof SettingsStore>
let engine: InstanceType<typeof EventEngine>
let sessions: InstanceType<typeof SessionTracker>
let relay: InstanceType<typeof RelayQueue>

/** resumeSession 的可编排假实现，验证调用参数与返回路径 */
let resumeCalls: { text: string; sessionId: string; cwd?: string }[]
let resumeResult: { ok: boolean; reply?: string; error?: string }
let resumeDelayMs: number

function fakeAdapters(): AdapterRegistry {
  const workbuddy = {
    id: 'workbuddy',
    resumeSession: async (
      text: string,
      options: { sessionId: string; cwd?: string }
    ): Promise<{ ok: boolean; reply?: string; error?: string }> => {
      resumeCalls.push({ text, sessionId: options.sessionId, cwd: options.cwd })
      if (resumeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, resumeDelayMs))
      return resumeResult
    }
  }
  return {
    get: (id: AgentId) => (id === 'workbuddy' ? workbuddy : undefined),
    all: () => []
  } as unknown as AdapterRegistry
}

function chat(): InstanceType<typeof SessionChat> {
  return new SessionChat({ settings, store, relay, adapters: fakeAdapters(), engine, sessions })
}

/** 造一个 Workbuddy 任务：PENDING →（可选 RUNNING）→（可选 COMPLETED）。
 * 事件时间戳逐条递增，避免 updated_at 同毫秒平局让 findBySession 分不清哪轮最新 */
let clock = 0

function seedWorkbuddyTask(
  status: Task['status'],
  sessionId = 'wb-sess-1',
  cwd = '/tmp/proj'
): string {
  const taskId = sessions.startTurn('workbuddy', sessionId)
  const ingest = (type: UnifiedEvent['type'], detail: string): void => {
    const at = new Date(Date.now() + ++clock * 1000).toISOString()
    engine.ingest(
      buildEvent({
        agentId: 'workbuddy',
        taskId,
        type,
        title: detail,
        detail,
        occurredAt: at,
        taskMeta: {
          task_title: '重构登录模块',
          session_id: sessionId,
          cwd,
          started_at: at
        },
        source: { hook: 'UserPromptSubmit', transport: 'bridge', raw: null }
      })
    )
  }
  ingest('task_started', '帮我重构登录模块')
  if (status === 'RUNNING') ingest('task_progress', '正在使用 Edit')
  if (status === 'COMPLETED') ingest('task_completed', '这一轮已经结束。')
  return taskId
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeEach(() => {
  store = new MemoryStore()
  settings = new SettingsStore(join(DATA, `settings-${Math.random()}.json`))
  engine = new EventEngine(store)
  sessions = new SessionTracker(store)
  relay = new RelayQueue()
  resumeCalls = []
  resumeResult = { ok: true, reply: '已重构完成，共改动 3 个文件。' }
  resumeDelayMs = 0
})

afterEach(() => {
  rmSync(join(DATA, 'backups'), { recursive: true, force: true })
})

describe('路径判定', () => {
  it('会话进行中 → 消息带 taskId 定向进透传队列', async () => {
    const taskId = seedWorkbuddyTask('RUNNING')

    const result = await chat().send(taskId, '顺便补个单测')

    expect(result).toEqual({ ok: true, via: 'stop-hook' })
    // 定向：该任务的 Stop 钩子能取走
    expect(relay.take('workbuddy', taskId)?.text).toBe('顺便补个单测')
    // 不串台：同 Agent 另一个会话的 Stop 钩子取不走
    expect(relay.take('workbuddy', 'task_workbuddy_other')).toBeNull()
  })

  it('选中的是旧轮次、会话最新轮还在跑 → 仍走注入路径，目标指向最新轮', async () => {
    const first = seedWorkbuddyTask('COMPLETED')
    seedWorkbuddyTask('RUNNING') // 同一会话的第二轮（最新的那轮在跑）

    const result = await chat().send(first, '继续')

    expect(result.via).toBe('stop-hook')
    const latest = store.tasks.findBySession('workbuddy', 'wb-sess-1')
    expect(relay.take('workbuddy', latest!.task_id)?.text).toBe('继续')
  })

  it('会话已结束 → SDK 无头续跑，回复以内部事件挂到当前轮任务', async () => {
    const taskId = seedWorkbuddyTask('COMPLETED')

    const result = await chat().send(taskId, '再补一个单测')

    expect(result).toEqual({ ok: true, via: 'headless' })
    await waitFor(() => store.tasks.get(taskId)?.summary !== undefined)

    expect(resumeCalls).toEqual([
      { text: '再补一个单测', sessionId: 'wb-sess-1', cwd: '/tmp/proj' }
    ])
    // 钩子没触发时映射仍指旧任务，同状态迁移（COMPLETED→COMPLETED）补上 summary
    expect(store.tasks.get(taskId)?.summary).toBe('已重构完成，共改动 3 个文件。')
  })

  it('无头续跑失败 → 上报 task_failed 事件', async () => {
    const taskId = seedWorkbuddyTask('COMPLETED')
    resumeResult = { ok: false, error: 'CodeBuddy CLI 没能启动，请确认它已安装并登录。' }

    await chat().send(taskId, '再试一次')
    await waitFor(() =>
      store.events.listByTask(taskId).some((e) => e.type === 'task_failed')
    )

    const failed = store.events.listByTask(taskId).find((e) => e.type === 'task_failed')
    expect(failed?.detail).toContain('CodeBuddy CLI 没能启动')
  })
})

describe('护栏', () => {
  it('同一会话的无头续跑进行中 → 拒绝第二条', async () => {
    const taskId = seedWorkbuddyTask('COMPLETED')
    resumeDelayMs = 200
    const session = chat()

    const first = await session.send(taskId, '第一条')
    expect(first.via).toBe('headless')

    const second = await session.send(taskId, '第二条')
    expect(second.ok).toBe(false)
    expect(second.error).toContain('正在处理你上一条消息')

    await waitFor(() => resumeCalls.length === 1)
  })

  it('非 Workbuddy 任务与无会话任务 → 明确报错', async () => {
    const claudeTaskId = sessions.startTurn('claude-code', 'c-sess')
    engine.ingest(
      buildEvent({
        agentId: 'claude-code',
        taskId: claudeTaskId,
        type: 'task_started',
        title: 'x',
        detail: 'x',
        taskMeta: { session_id: 'c-sess' },
        source: { hook: 'UserPromptSubmit', transport: 'http', raw: null }
      })
    )

    const notWorkbuddy = await chat().send(claudeTaskId, 'hi')
    expect(notWorkbuddy.ok).toBe(false)
    expect(notWorkbuddy.error).toContain('仅支持 Workbuddy')

    // workbuddy 但没有 session_id
    const orphanId = sessions.startTurn('workbuddy', 'unknown')
    engine.ingest(
      buildEvent({
        agentId: 'workbuddy',
        taskId: orphanId,
        type: 'task_started',
        title: 'x',
        detail: 'x',
        source: { hook: 'UserPromptSubmit', transport: 'bridge', raw: null }
      })
    )
    const noSession = await chat().send(orphanId, 'hi')
    expect(noSession.ok).toBe(false)
    expect(noSession.error).toContain('没有会话信息')
  })

  it('每条消息写入审计日志，渠道标注 dashboard', async () => {
    const taskId = seedWorkbuddyTask('RUNNING')
    await chat().send(taskId, '审计这条')

    const entry = store.audit.list().find((e) => e.summary === '审计这条')
    expect(entry).toMatchObject({
      action: 'relay',
      agent_id: 'workbuddy',
      channel: 'dashboard',
      result: 'success'
    })
  })

  it('dispose 中断进行中的续跑', async () => {
    const taskId = seedWorkbuddyTask('COMPLETED')
    resumeDelayMs = 5000
    const session = chat()

    await session.send(taskId, '慢消息')
    session.dispose()
    // 被中断后应立即释放会话锁
    const again = await session.send(taskId, '再发一条')
    expect(again).not.toMatchObject({ ok: false, error: expect.stringContaining('上一条消息') })
  })
})

describe('对话流组装', () => {
  it('按会话聚合所有轮次：用户消息、Agent 回复、状态与占位说明', async () => {
    const first = seedWorkbuddyTask('COMPLETED') // 无 summary → 占位说明
    const second = seedWorkbuddyTask('RUNNING', 'wb-sess-1') // 新一轮进行中

    const entries = chat().conversation(first)

    expect(entries).not.toBeNull()
    const roles = entries!.map((e) => e.role)
    expect(roles).toEqual(['user', 'agent', 'user', 'status'])

    expect(entries![0]).toMatchObject({ role: 'user', text: '帮我重构登录模块' })
    expect(entries![1]).toMatchObject({ role: 'agent', text: expect.stringContaining('不提供') })
    expect(entries![3]).toMatchObject({ role: 'status', text: expect.stringContaining('正在处理') })

    // 会话维度：选第二轮的 taskId 拿到的是同一份对话流
    expect(chat().conversation(second)).toHaveLength(4)
  })

  it('无头续跑回复后，对话流出现该轮的 Agent 回复', async () => {
    const taskId = seedWorkbuddyTask('COMPLETED')
    await chat().send(taskId, '再补一个单测')
    await waitFor(() => chat().conversation(taskId)!.some((e) => e.role === 'agent' && e.text.includes('已重构完成')))

    const entries = chat().conversation(taskId)!
    expect(entries.at(-1)).toMatchObject({ role: 'agent', text: '已重构完成，共改动 3 个文件。' })
  })

  it('任务不存在或没有会话信息时返回 null', () => {
    expect(chat().conversation('task_nowhere')).toBeNull()
  })
})
