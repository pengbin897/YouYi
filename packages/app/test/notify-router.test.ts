/**
 * 通知管家与消息路由的验收测试（PRD 模块 D / F）。
 *
 * 覆盖的是「不用真机也能验」的那部分：档位过滤、免打扰穿透、早报归集、
 * 状态自答、目标判定、全部停止的二次确认、以及各家能力差异下的透传取舍。
 * 真机扫码登录微信只能人工验。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const DATA = mkdtempSync(join(tmpdir(), 'youyi-notify-'))
process.env.YOUYI_HOME = DATA

const { Notifier } = await import('../src/main/notifier/notifier.js')
const { MessageRouter } = await import('../src/main/router/router.js')
const { EventEngine } = await import('../src/main/engine/event-engine.js')
const { SessionTracker } = await import('../src/main/engine/session-tracker.js')
const { PendingDecisionArbiter } = await import('../src/main/hook-server/pending-decisions.js')
const { RelayQueue } = await import('../src/main/router/relay-queue.js')
const { MemoryStore } = await import('../src/main/store/memory.js')
const { SettingsStore } = await import('../src/main/config/settings-store.js')
const { AdapterRegistry } = await import('../src/main/adapters/registry.js')
const { buildEvent } = await import('../src/main/engine/event-factory.js')
import type { EventType } from '@youyi/shared'
import type { ChannelManager } from '../src/main/channels/manager.js'
import type { InboundMessage } from '../src/main/channels/types.js'

let store: InstanceType<typeof MemoryStore>
let settings: InstanceType<typeof SettingsStore>
let sent: string[]
let channels: ChannelManager

/** 只记录文本的假渠道，省掉真实网络 */
function fakeChannels(): ChannelManager {
  return {
    send: async (message: { text: string }) => {
      sent.push(message.text)
      return { ok: true, degraded: false }
    }
  } as unknown as ChannelManager
}

beforeEach(() => {
  store = new MemoryStore()
  settings = new SettingsStore(join(DATA, `settings-${Math.random()}.json`))
  sent = []
  channels = fakeChannels()
})

afterEach(() => {
  rmSync(join(DATA, 'backups'), { recursive: true, force: true })
})

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function seedTask(agentId: 'claude-code' | 'qoder-work' = 'claude-code'): string {
  const engine = new EventEngine(store)
  const sessions = new SessionTracker(store)
  const taskId = sessions.startTurn(agentId, 'sess-1')
  engine.ingest(
    buildEvent({
      agentId,
      taskId,
      type: 'task_started',
      title: '开始新任务',
      detail: '清洗历史数据',
      taskMeta: { task_title: '清洗历史数据', started_at: new Date().toISOString() },
      source: { hook: 'UserPromptSubmit', transport: 'http', raw: null }
    })
  )
  return taskId
}

describe('通知档位（PRD F1）', () => {
  const cases = [
    { tier: 'quiet' as const, allowed: ['auth_required', 'task_failed'], blocked: ['task_completed', 'task_progress'] },
    { tier: 'standard' as const, allowed: ['auth_required', 'task_failed', 'task_completed'], blocked: ['task_progress'] },
    { tier: 'full' as const, allowed: ['auth_required', 'task_failed', 'task_completed', 'task_progress'], blocked: [] }
  ]

  for (const { tier, allowed, blocked } of cases) {
    it(`${tier} 档只放行该放行的`, async () => {
      const taskId = seedTask()
      settings.patch({ notifyTier: tier, dnd: { enabled: false, start: '22:00', end: '08:00' } })
      const notifier = new Notifier(settings, store, channels)

      for (const type of [...allowed, ...blocked] as EventType[]) {
        const event = buildEvent({
          agentId: 'claude-code',
          taskId,
          type,
          title: type,
          detail: 'x',
          source: { hook: 'h', transport: 'http', raw: null }
        })
        await notifier.handle({
          kind: 'single',
          event,
          task: store.tasks.get(taskId)!,
          events: [event]
        })
      }

      expect(sent).toHaveLength(allowed.length)
    })
  }
})

describe('免打扰与早报（PRD F2）', () => {
  it('跨零点时段判定正确', () => {
    const notifier = new Notifier(settings, store, channels)
    const dnd = { enabled: true, start: '22:00', end: '08:00' }
    const at = (h: number, m = 0): Date => new Date(2026, 0, 1, h, m)

    expect(notifier.inQuietHours(dnd, at(23))).toBe(true)
    expect(notifier.inQuietHours(dnd, at(3))).toBe(true)
    expect(notifier.inQuietHours(dnd, at(7, 59))).toBe(true)
    expect(notifier.inQuietHours(dnd, at(8))).toBe(false)
    expect(notifier.inQuietHours(dnd, at(21, 59))).toBe(false)
    expect(notifier.inQuietHours({ ...dnd, enabled: false }, at(23))).toBe(false)
  })

  it('免打扰时段内「需要确认」照样穿透，其余进早报', async () => {
    const taskId = seedTask()
    // 把免打扰设成全天，保证判定命中，不依赖跑测试的时刻
    settings.patch({ notifyTier: 'standard', dnd: { enabled: true, start: '00:00', end: '23:59' } })
    const notifier = new Notifier(settings, store, channels)
    const task = store.tasks.get(taskId)!

    const auth = buildEvent({
      agentId: 'claude-code',
      taskId,
      type: 'auth_required',
      title: '需要你确认',
      detail: '执行命令：npm run deploy',
      authOptions: 'remote',
      source: { hook: 'PermissionRequest', transport: 'http', raw: null }
    })
    await notifier.handle({ kind: 'single', event: auth, task, events: [auth] })
    expect(sent).toHaveLength(1)

    const done = buildEvent({
      agentId: 'claude-code',
      taskId,
      type: 'task_completed',
      title: '任务完成',
      detail: '搞定了',
      source: { hook: 'Stop', transport: 'http', raw: null }
    })
    await notifier.handle({ kind: 'single', event: done, task, events: [done] })

    // 完成通知没有立刻发出去，而是攒进早报
    expect(sent).toHaveLength(1)
    expect(store.digest.size()).toBe(1)
  })
})

describe('通知文案随能力变化', () => {
  it('只能远程拒绝时不引导用户「回复继续放行」', async () => {
    const taskId = seedTask('qoder-work')
    settings.patch({ notifyTier: 'quiet', dnd: { enabled: false, start: '22:00', end: '08:00' } })
    const notifier = new Notifier(settings, store, channels)

    const event = buildEvent({
      agentId: 'qoder-work',
      taskId,
      type: 'auth_required',
      title: 'Qoder Work 需要你确认',
      detail: '执行命令：kubectl apply -f .',
      authOptions: 'deny-only',
      source: { hook: 'PermissionRequest', transport: 'bridge', raw: null }
    })
    await notifier.handle({
      kind: 'single',
      event,
      task: store.tasks.get(taskId)!,
      events: [event]
    })

    expect(sent[0]).toContain('只支持远程拒绝')
    expect(sent[0]).not.toContain('继续（放行）')
  })

  it('高危操作只让回电脑确认', async () => {
    const taskId = seedTask()
    settings.patch({ notifyTier: 'quiet', dnd: { enabled: false, start: '22:00', end: '08:00' } })
    const notifier = new Notifier(settings, store, channels)

    const event = buildEvent({
      agentId: 'claude-code',
      taskId,
      type: 'auth_required',
      title: '需要你确认',
      detail: '执行命令：git push --force',
      authOptions: 'local-only',
      source: { hook: 'PermissionRequest', transport: 'http', raw: null }
    })
    await notifier.handle({
      kind: 'single',
      event,
      task: store.tasks.get(taskId)!,
      events: [event]
    })

    expect(sent[0]).toContain('回电脑确认')
  })
})

describe('消息路由（PRD 模块 D）', () => {
  let router: InstanceType<typeof MessageRouter>
  let pending: InstanceType<typeof PendingDecisionArbiter>
  let relay: InstanceType<typeof RelayQueue>

  const inbound = (text: string): InboundMessage => ({
    channelId: 'wechat',
    type: 'text',
    text,
    userId: 'me',
    receivedAt: new Date().toISOString()
  })

  beforeEach(() => {
    pending = new PendingDecisionArbiter()
    relay = new RelayQueue()
    settings.patch({
      enabledAgents: ['claude-code', 'qoder-work'],
      remoteAuth: {
        enabled: true,
        allowPermanentRules: false,
        timeoutMs: 5000,
        gateToolUseAgents: []
      }
    })
    router = new MessageRouter({
      settings,
      store,
      pending,
      relay,
      adapters: new AdapterRegistry({ settings, store } as never),
      channels
    })
  })

  it('状态查询本地自答，不打扰任何 Agent', async () => {
    seedTask()
    await router.handleInbound(inbound('状态'))
    expect(sent[0]).toContain('当前有 1 个任务')
    expect(sent[0]).toContain('清洗历史数据')
    // 没有往透传队列里塞东西 = 没去打扰 Agent
    expect(relay.pendingFor('claude-code')).toBe(0)
  })

  it('没有任务时如实说没有', async () => {
    await router.handleInbound(inbound('状态'))
    expect(sent[0]).toBe('当前没有正在跑的任务。')
  })

  it('回复「继续」放行正在等确认的那个请求', async () => {
    const taskId = seedTask()
    const { request } = pending.create({
      agentId: 'claude-code',
      taskId,
      toolName: 'Bash',
      requestText: '执行命令：npm test',
      highRisk: false,
      timeoutMs: 5000
    })

    await router.handleInbound(inbound('继续'))
    expect(pending.size).toBe(0)
    expect(sent[0]).toContain('已放行')
    expect(sent[0]).toContain('只对这一次操作生效')
    expect(request.deny_only).toBe(false)
  })

  it('只能远程拒绝的家，不谎报「已放行」', async () => {
    const taskId = seedTask('qoder-work')
    pending.create({
      agentId: 'qoder-work',
      taskId,
      toolName: 'Bash',
      requestText: '执行命令：kubectl apply -f .',
      highRisk: false,
      denyOnly: true,
      timeoutMs: 5000
    })

    await router.handleInbound(inbound('继续'))
    expect(sent[0]).toContain('不支持远程批准')
    expect(sent[0]).not.toContain('已放行')
  })

  it('高危请求即使回复「继续」也拦下来（安全红线）', async () => {
    const taskId = seedTask()
    pending.create({
      agentId: 'claude-code',
      taskId,
      toolName: 'Bash',
      requestText: '执行命令：git push --force origin main',
      highRisk: true,
      highRiskReason: '强制推送',
      timeoutMs: 5000
    })

    await router.handleInbound(inbound('继续'))
    // 请求仍然挂着，交回本机确认
    expect(pending.size).toBe(1)
    expect(sent[0]).toContain('电脑')
    const audit = store.audit.list().at(0)
    expect(audit?.result).toBe('denied')
  })

  it('没有挂起请求时「继续」当普通对话透传', async () => {
    seedTask()
    // 透传是要等目标 Agent 的 Stop 钩子来取的，所以这里不能直接 await，
    // 得先看到入队、再模拟钩子取走，才算走完一个来回
    const inflight = router.handleInbound(inbound('继续'))
    await waitFor(() => relay.pendingFor('claude-code') === 1)

    const taken = relay.take('claude-code')
    expect(taken?.text).toBe('继续')

    await inflight
    expect(sent.at(-1)).toContain('Claude Code')
  })

  it('全部停止要二次确认，确认后拒掉所有挂起请求', async () => {
    const taskId = seedTask()
    pending.create({
      agentId: 'claude-code',
      taskId,
      toolName: 'Bash',
      requestText: '执行命令：rm -rf node_modules',
      highRisk: false,
      timeoutMs: 5000
    })

    await router.handleInbound(inbound('全部停止'))
    // 只是问一句，不能立刻动手
    expect(pending.size).toBe(1)
    expect(sent[0]).toContain('确认')

    await router.handleInbound(inbound('确认停止'))
    expect(pending.size).toBe(0)
    expect(store.audit.list().some((a) => a.action === 'broadcast_stop')).toBe(true)
  })

  it('多个任务在跑且都没在等确认时，不猜目标而是回问', async () => {
    seedTask('claude-code')
    seedTask('qoder-work')
    await router.handleInbound(inbound('把日志发我看看'))
    expect(sent[0]).toContain('不确定该转给谁')
    expect(relay.pendingFor('claude-code')).toBe(0)
    expect(relay.pendingFor('qoder-work')).toBe(0)
  })

  it('显式指名时直接投给那一家', async () => {
    seedTask('claude-code')
    seedTask('qoder-work')
    const inflight = router.handleInbound(inbound('交给 Qoder：把日志发我看看'))

    await waitFor(() => relay.pendingFor('qoder-work') === 1)
    expect(relay.pendingFor('claude-code')).toBe(0)

    relay.take('qoder-work')
    await inflight
  })

  it('图片语音如实告知处理不了，不静默丢弃', async () => {
    await router.handleInbound({ ...inbound(''), type: 'image' })
    expect(sent[0]).toContain('只支持文字')
  })
})
