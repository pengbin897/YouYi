/**
 * 本地 CLI 网关的验收测试（PRD 模块 I1）。
 *
 * 覆盖：token 鉴权、状态快照、文本消息与微信同语义（状态自答 / 透传）、
 * 显式指定 Agent、审计日志的渠道标注。youyi CLI 客户端本身是零依赖的
 * 薄封装（读连接文件 + HTTP），端到端行为由这里的服务端测试兜底。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const DATA = mkdtempSync(join(tmpdir(), 'youyi-cli-'))
// paths.ts 在导入时就读 YOUYI_HOME，所以必须在任何被测模块导入之前设置
process.env.YOUYI_HOME = DATA

const { HookServer } = await import('../src/main/hook-server/server.js')
const { MessageRouter } = await import('../src/main/router/router.js')
const { EventEngine } = await import('../src/main/engine/event-engine.js')
const { SessionTracker } = await import('../src/main/engine/session-tracker.js')
const { PendingDecisionArbiter } = await import('../src/main/hook-server/pending-decisions.js')
const { RelayQueue } = await import('../src/main/router/relay-queue.js')
const { MemoryStore } = await import('../src/main/store/memory.js')
const { SettingsStore } = await import('../src/main/config/settings-store.js')
const { AdapterRegistry } = await import('../src/main/adapters/registry.js')
const { buildEvent } = await import('../src/main/engine/event-factory.js')
import { agentName, isAgentId, type AgentId, type CliStateSnapshot } from '@youyi/shared'
import type { ChannelManager } from '../src/main/channels/manager.js'

let store: InstanceType<typeof MemoryStore>
let settings: InstanceType<typeof SettingsStore>
let pending: InstanceType<typeof PendingDecisionArbiter>
let relay: InstanceType<typeof RelayQueue>
let router: InstanceType<typeof MessageRouter>
let server: InstanceType<typeof HookServer>
/** 发往通知渠道（微信等）的消息，用来验证 CLI 的回复没有跑错地方 */
let channelSent: string[]

let baseUrl = ''
let token = ''

/** 与 Sentinel.handleCliMessage 相同的装配方式：收集回复同步返回 */
async function cliMessage(text: string, agentId?: string): Promise<string[]> {
  if (agentId !== undefined && !isAgentId(agentId)) {
    return [`不认识的 Agent：${agentId}`]
  }
  const replies: string[] = []
  await router.handleInbound(
    {
      channelId: 'cli',
      userId: 'cli',
      text,
      type: 'text',
      receivedAt: new Date().toISOString()
    },
    {
      reply: async (t) => {
        replies.push(t)
      },
      forceAgent: agentId as AgentId | undefined
    }
  )
  return replies
}

function cliState(): CliStateSnapshot {
  const tasks = store.tasks.listActive()
  const enabled = settings.get().enabledAgents
  return {
    watching: true,
    tasks,
    pending: pending.list(),
    agents: enabled.map((id) => ({
      id,
      name: agentName(id),
      enabled: true,
      runningTasks: tasks.filter((t) => t.agent_id === id && t.status === 'RUNNING').length
    })),
    recentEvents: []
  }
}

beforeAll(async () => {
  store = new MemoryStore()
  settings = new SettingsStore(join(DATA, 'settings.json'))
  pending = new PendingDecisionArbiter()
  relay = new RelayQueue()
  channelSent = []

  settings.patch({
    enabledAgents: ['claude-code'],
    // 透传等待要在测试里快速超时，不然用例会挂 90 秒
    relayQueueTimeoutMs: 50
  })

  router = new MessageRouter({
    settings,
    store,
    pending,
    relay,
    adapters: new AdapterRegistry({ settings, store } as never),
    channels: {
      send: async (message: { text: string }) => {
        channelSent.push(message.text)
        return { ok: true, degraded: false }
      }
    } as unknown as ChannelManager
  })

  server = new HookServer(
    async () => ({ exit: 0 }),
    (id) => settings.get().enabledAgents.includes(id),
    {
      state: () => cliState(),
      message: async (req) => ({ replies: await cliMessage(req.text, req.agentId) })
    }
  )
  const identity = await server.start()
  baseUrl = `http://127.0.0.1:${identity.port}`
  token = identity.token
})

afterAll(async () => {
  await server.stop()
  rmSync(DATA, { recursive: true, force: true })
})

beforeEach(() => {
  channelSent = []
})

function seedRunningTask(): string {
  const engine = new EventEngine(store)
  const sessions = new SessionTracker(store)
  const taskId = sessions.startTurn('claude-code', `sess-${Math.random()}`)
  engine.ingest(
    buildEvent({
      agentId: 'claude-code',
      taskId,
      type: 'task_started',
      title: '开始新任务',
      detail: '整理季度报表',
      taskMeta: { task_title: '整理季度报表', started_at: new Date().toISOString() },
      source: { hook: 'UserPromptSubmit', transport: 'http', raw: null }
    })
  )
  return taskId
}

describe('CLI 网关鉴权（PRD I1）', () => {
  it('token 错误一律 403，state 与 message 都不放行', async () => {
    const state = await fetch(`${baseUrl}/cli/wrong-token/state`)
    expect(state.status).toBe(403)

    const message = await fetch(`${baseUrl}/cli/wrong-token/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '状态' })
    })
    expect(message.status).toBe(403)
  })

  it('缺 text 或空 text 返回 400', async () => {
    const res = await fetch(`${baseUrl}/cli/${token}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' })
    })
    expect(res.status).toBe(400)
  })
})

describe('状态快照（youyi status --json）', () => {
  it('返回活跃任务、待确认与 Agent 状态', async () => {
    seedRunningTask()
    const res = await fetch(`${baseUrl}/cli/${token}/state`)
    expect(res.status).toBe(200)

    const snapshot = (await res.json()) as CliStateSnapshot
    expect(snapshot.tasks.length).toBeGreaterThan(0)
    expect(snapshot.tasks[0].title).toBe('整理季度报表')
    const claude = snapshot.agents.find((a) => a.id === 'claude-code')
    expect(claude?.enabled).toBe(true)
    expect(claude?.runningTasks).toBeGreaterThan(0)
  })
})

describe('CLI 消息与微信同语义（PRD I1）', () => {
  it('「状态」由哨兵自答，回复同步返回给 CLI 而不是发去渠道', async () => {
    const res = await fetch(`${baseUrl}/cli/${token}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '状态' })
    })
    const { replies } = (await res.json()) as { replies: string[] }

    expect(replies.join('\n')).toContain('整理季度报表')
    // CLI 的回复不应该跑到通知渠道去
    expect(channelSent).toHaveLength(0)
  })

  it('透传经确认回执返回，审计渠道标注为 cli', async () => {
    const res = await fetch(`${baseUrl}/cli/${token}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '帮我把报表导出成 PDF', agentId: 'claude-code' })
    })
    const { replies } = (await res.json()) as { replies: string[] }

    expect(replies[0]).toContain('已记下')
    const audits = store.audit.list(10)
    const relayAudit = audits.find((a) => a.action === 'relay')
    expect(relayAudit?.channel).toBe('cli')
  })

  it('不认识的 agentId 明确报错，不落到默认路由', async () => {
    const res = await fetch(`${baseUrl}/cli/${token}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '随便说点什么', agentId: 'not-an-agent' })
    })
    const { replies } = (await res.json()) as { replies: string[] }
    expect(replies[0]).toContain('不认识的 Agent')
  })
})
