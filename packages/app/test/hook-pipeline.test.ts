/**
 * 端到端集成测试：模拟 Agent 测试台。
 *
 * 回放的是各家官方文档里的真实 payload（字段名与嵌套结构照抄文档示例），
 * 走完整链路：HTTP/桥接 → HookServer → 适配器归一化 → 事件引擎 → 决策写回。
 * 这样厂商改 schema 时这里会第一时间红，而不是等用户在微信上收不到通知才发现。
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const TEST_HOME = mkdtempSync(join(process.cwd(), '.tmp-test-'))
// paths.ts 在导入时就读 YOUYI_HOME，所以必须在任何被测模块导入之前设置
process.env.YOUYI_HOME = TEST_HOME

const { HookServer } = await import('../src/main/hook-server/server.js')
const { PendingDecisionArbiter } = await import('../src/main/hook-server/pending-decisions.js')
const { EventEngine } = await import('../src/main/engine/event-engine.js')
const { SessionTracker } = await import('../src/main/engine/session-tracker.js')
const { MemoryStore } = await import('../src/main/store/memory.js')
const { SettingsStore } = await import('../src/main/config/settings-store.js')
const { AdapterRegistry } = await import('../src/main/adapters/registry.js')
const { ClaudeCodeAdapter } = await import('../src/main/adapters/claude-code.js')
const { RelayQueue } = await import('../src/main/router/relay-queue.js')

type Harness = {
  store: InstanceType<typeof MemoryStore>
  engine: InstanceType<typeof EventEngine>
  pending: InstanceType<typeof PendingDecisionArbiter>
  relay: InstanceType<typeof RelayQueue>
  server: InstanceType<typeof HookServer>
  agentReplies: string[]
  post: (event: string, payload: unknown) => Promise<{ status: number; body: unknown }>
}

let harness: Harness

const SESSION = 'abc123'
const CWD = '/Users/demo/project'

async function createHarness(): Promise<Harness> {
  const store = new MemoryStore()
  const engine = new EventEngine(store, { completionMergeWindowMs: 20 })
  const pending = new PendingDecisionArbiter()
  const relay = new RelayQueue()
  const settings = new SettingsStore(join(TEST_HOME, 'settings.json'))
  settings.patch({
    enabledAgents: ['claude-code'],
    remoteAuth: {
      enabled: true,
      allowPermanentRules: false,
      timeoutMs: 3000,
      // Trae / Workbuddy / Qoder 的工具级闸门要显式开启才生效
      gateToolUseAgents: ['trae-work', 'workbuddy']
    }
  })

  const agentReplies: string[] = []
  // 适配器要用 server 生成回调地址，server 又要用适配器派发，这里靠先声明打破循环
  let server: InstanceType<typeof HookServer>

  const registry = new AdapterRegistry({
    engine,
    store,
    settings,
    pending,
    relay,
    sessions: new SessionTracker(store),
    hookUrl: (agentId, event): string => server.httpHookUrl(agentId, event),
    bridgeCommand: () => 'unused',
    notifyAgentReply: (_agentId, text) => agentReplies.push(text)
  })
  registry.register(new ClaudeCodeAdapter())

  server = new HookServer(
    (req) => registry.dispatch(req),
    (id) => settings.get().enabledAgents.includes(id)
  )
  await server.start()

  const post = async (
    event: string,
    payload: unknown
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(server.httpHookUrl('claude-code', event), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return { status: response.status, body: await response.json() }
  }

  return { store, engine, pending, relay, server, agentReplies, post }
}

beforeAll(async () => {
  harness = await createHarness()
})

afterAll(async () => {
  await harness.server.stop()
  rmSync(TEST_HOME, { recursive: true, force: true })
})

/** 文档 §Common input fields 的公共字段 */
function common(event: string): Record<string, unknown> {
  return {
    session_id: SESSION,
    transcript_path: `/Users/demo/.claude/projects/x/${SESSION}.jsonl`,
    cwd: CWD,
    permission_mode: 'default',
    hook_event_name: event
  }
}

describe('Claude Code 钩子链路', () => {
  it('UserPromptSubmit 建立任务并用 prompt 首句命名', async () => {
    const result = await harness.post('UserPromptSubmit', {
      ...common('UserPromptSubmit'),
      prompt: '帮我把 users 表的历史数据清洗一遍\n注意保留原始备份'
    })

    expect(result.status).toBe(200)
    const task = harness.store.tasks.list()[0]
    expect(task.title).toBe('帮我把 users 表的历史数据清洗一遍')
    expect(task.status).toBe('RUNNING')
    expect(task.cwd).toBe(CWD)
    expect(task.session_id).toBe(SESSION)
  })

  it('PreToolUse 累积进度但不改变任务归属', async () => {
    for (let i = 0; i < 3; i += 1) {
      await harness.post('PreToolUse', {
        ...common('PreToolUse'),
        tool_name: 'Bash',
        tool_input: { command: `echo step-${i}`, timeout: 120000 },
        tool_use_id: `toolu_0${i}`
      })
    }

    const tasks = harness.store.tasks.list()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].step_count).toBe(3)
    expect(tasks[0].progress).toBeGreaterThan(0)
  })

  it('PermissionRequest 挂起等待决策，回复放行后返回 allow 决策体', async () => {
    const inflight = harness.post('PermissionRequest', {
      ...common('PermissionRequest'),
      tool_name: 'Bash',
      tool_input: { command: 'npm run lint' },
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }] }]
    })

    // 等适配器把请求挂起
    await waitFor(() => harness.pending.size === 1)
    const request = harness.pending.latest()!
    expect(request.tool_name).toBe('Bash')
    expect(request.request_text).toContain('npm run lint')
    expect(request.high_risk).toBe(false)
    expect(harness.store.tasks.list()[0].status).toBe('NEEDS_AUTH')

    harness.pending.resolve(request.id, 'allow', { source: 'wechat' })

    const result = await inflight
    expect(result.body).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' }
      }
    })
    // 只放行一次：不能出现写入永久规则的 updatedPermissions
    expect(JSON.stringify(result.body)).not.toContain('updatedPermissions')
  })

  it('高危命令不挂起、不接管决策，交回本地确认', async () => {
    const result = await harness.post('PermissionRequest', {
      ...common('PermissionRequest'),
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf ./build && git push origin main --force' }
    })

    expect(harness.pending.size).toBe(0)
    // 空响应体 = 不做决策，走 Claude 自己的权限流程
    expect(result.body).toEqual({})

    const events = harness.store.events.listByTask(harness.store.tasks.list()[0].task_id)
    const authEvent = events.filter((e) => e.type === 'auth_required').at(-1)
    expect(authEvent?.detail).toContain('高危操作')
  })

  it('拒绝时返回 deny 决策体', async () => {
    const inflight = harness.post('PermissionRequest', {
      ...common('PermissionRequest'),
      tool_name: 'Write',
      tool_input: { file_path: '/Users/demo/project/src/app.ts' }
    })

    await waitFor(() => harness.pending.size === 1)
    harness.pending.resolve(harness.pending.latest()!.id, 'deny', { source: 'wechat' })

    const result = await inflight
    const body = result.body as { hookSpecificOutput: { decision: { behavior: string } } }
    expect(body.hookSpecificOutput.decision.behavior).toBe('deny')
  })

  it('超时不做决策，交还 Agent 默认流程', async () => {
    const result = await harness.post('PermissionRequest', {
      ...common('PermissionRequest'),
      tool_name: 'Edit',
      tool_input: { file_path: '/Users/demo/project/README.md' }
    })
    expect(result.body).toEqual({})
    expect(harness.pending.size).toBe(0)
  }, 10_000)

  it('Stop 钩子把排队的用户消息注入回对话（透传核心机制）', async () => {
    const taskId = harness.store.tasks.list()[0].task_id
    harness.relay.enqueue({ agentId: 'claude-code', text: '顺便把测试也跑一遍', timeoutMs: 5000 })

    const result = await harness.post('Stop', {
      ...common('Stop'),
      stop_hook_active: false,
      last_assistant_message: '清洗完成了。',
      background_tasks: [],
      session_crons: []
    })

    expect(result.body).toEqual({ decision: 'block', reason: '顺便把测试也跑一遍' })
    // 注入了消息就不算任务结束
    expect(harness.store.tasks.get(taskId)?.status).not.toBe('COMPLETED')
  })

  it('下一轮 Stop 把 Agent 的回答原样回传，并标记任务完成', async () => {
    const taskId = harness.store.tasks.list()[0].task_id

    const result = await harness.post('Stop', {
      ...common('Stop'),
      stop_hook_active: false,
      last_assistant_message: '测试全部通过，12 个用例。'
    })

    expect(result.body).toEqual({})
    expect(harness.agentReplies).toContain('测试全部通过，12 个用例。')
    expect(harness.store.tasks.get(taskId)?.status).toBe('COMPLETED')
    expect(harness.store.tasks.get(taskId)?.summary).toBe('测试全部通过，12 个用例。')
  })

  it('stop_hook_active 为真时不再注入，避免与 Agent 的续跑逻辑打架', async () => {
    await harness.post('UserPromptSubmit', { ...common('UserPromptSubmit'), prompt: '第二个任务' })
    harness.relay.enqueue({ agentId: 'claude-code', text: '不该被注入', timeoutMs: 5000 })

    const result = await harness.post('Stop', {
      ...common('Stop'),
      stop_hook_active: true,
      last_assistant_message: '好了。'
    })

    expect(result.body).toEqual({})
    expect(harness.relay.pendingFor('claude-code')).toBe(1)
  })

  it('SessionEnd 不会把已完成的任务重复收尾', async () => {
    const before = harness.store.tasks.list().map((t) => `${t.task_id}:${t.status}`)
    await harness.post('SessionEnd', { ...common('SessionEnd'), reason: 'clear' })
    const after = harness.store.tasks.list().map((t) => `${t.task_id}:${t.status}`)
    expect(after).toEqual(before)
  })
})

describe('HookServer 安全校验', () => {
  it('token 不对直接 403', async () => {
    const url = harness.server.httpHookUrl('claude-code', 'Stop').replace(/\/h\/[^/]+\//, '/h/bad/')
    const response = await fetch(url, { method: 'POST', body: '{}' })
    expect(response.status).toBe(403)
  })

  it('未知 agent_id 直接 403', async () => {
    const url = harness.server
      .httpHookUrl('claude-code', 'Stop')
      .replace('/claude-code/', '/not-an-agent/')
    const response = await fetch(url, { method: 'POST', body: '{}' })
    expect(response.status).toBe(403)
  })

  it('健康检查可用', async () => {
    const response = await fetch(`${harness.server.baseUrl}/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })
  })
})

describe('桥接程序（其余 6 家 Agent 的通道）', () => {
  const bridge = join(process.cwd(), '..', 'hook-bridge', 'dist', 'index.js')

  const runBridge = (
    args: string[],
    stdin: string,
    env: Record<string, string> = {}
  ): Promise<{ code: number; stdout: string }> =>
    new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [bridge, ...args],
        { env: { ...process.env, YOUYI_HOME: TEST_HOME, ...env } },
        (error, stdout) => {
          resolve({ code: error && 'code' in error ? Number(error.code) : 0, stdout })
        }
      )
      child.stdin?.end(stdin)
    })

  it('把 stdin JSON 转成本地 HTTP 请求并归一化成事件', async () => {
    const before = harness.store.events.listSince('1970-01-01').length

    const result = await runBridge(
      ['--agent', 'claude-code', '--event', 'PreToolUse'],
      JSON.stringify({
        ...common('PreToolUse'),
        session_id: 'bridge-session',
        tool_name: 'Bash',
        tool_input: { command: 'pytest -q' }
      })
    )

    expect(result.code).toBe(0)
    const after = harness.store.events.listSince('1970-01-01')
    expect(after.length).toBe(before + 1)
    expect(after.at(-1)?.source.transport).toBe('bridge')
    expect(after.at(-1)?.detail).toContain('pytest -q')
  })

  it('哨兵不可达时 fail-open，绝不阻断用户的 Agent', async () => {
    const result = await runBridge(
      ['--agent', 'claude-code', '--event', 'Stop'],
      JSON.stringify({ hook_event_name: 'Stop' }),
      { YOUYI_HOME: join(TEST_HOME, 'nonexistent') }
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
  })
})

afterEach(() => {
  // 每个用例之间不清库：这些用例刻意按真实会话顺序串起来，验证状态机的连续性
})

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
