/**
 * 其余 6 家 Agent 的归一化与决策回写测试。
 *
 * 回放的 payload 字段名与嵌套结构照抄各家官方文档的示例，走的也是真实通道：
 * 除 Hermes 的观察事件（出站 webhook，HTTP 直连）外，全部经桥接路由，
 * 因此顺带验证了「适配器给的 json 会被序列化成 stdout」这条约定——
 * 走桥接的家全靠 stdout 表达决策，这里断不住的话，远程放行在真机上就是静默失效。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const TEST_HOME = mkdtempSync(join(process.cwd(), '.tmp-adapters-'))
process.env.YOUYI_HOME = TEST_HOME

const { HookServer } = await import('../src/main/hook-server/server.js')
const { PendingDecisionArbiter } = await import('../src/main/hook-server/pending-decisions.js')
const { EventEngine } = await import('../src/main/engine/event-engine.js')
const { SessionTracker } = await import('../src/main/engine/session-tracker.js')
const { MemoryStore } = await import('../src/main/store/memory.js')
const { SettingsStore } = await import('../src/main/config/settings-store.js')
const { AdapterRegistry } = await import('../src/main/adapters/registry.js')
const { JsonHooksAdapter } = await import('../src/main/adapters/base/json-hooks-adapter.js')
const dialects = await import('../src/main/adapters/base/dialect.js')
const { CursorAdapter } = await import('../src/main/adapters/cursor.js')
const { HermesAdapter } = await import('../src/main/adapters/hermes.js')
const { OpenClawAdapter } = await import('../src/main/adapters/openclaw.js')
const { RelayQueue } = await import('../src/main/router/relay-queue.js')

type BridgeResult = { exit: number; stdout?: string; stderr?: string }

let store: InstanceType<typeof MemoryStore>
let pending: InstanceType<typeof PendingDecisionArbiter>
let relay: InstanceType<typeof RelayQueue>
let server: InstanceType<typeof HookServer>
let token: string
let agentReplies: { agentId: string; text: string }[]

/** 模拟桥接程序：POST /hook，token 在请求头 */
async function bridge(
  agentId: string,
  event: string,
  payload: unknown
): Promise<BridgeResult> {
  const response = await fetch(`${server.baseUrl}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-youyi-token': token },
    body: JSON.stringify({ agentId, event, payload })
  })
  return (await response.json()) as BridgeResult
}

/** 桥接决策体：走 stdout 的 JSON */
function decisionOf(result: BridgeResult): unknown {
  return result.stdout ? JSON.parse(result.stdout) : undefined
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeAll(async () => {
  store = new MemoryStore()
  const engine = new EventEngine(store, { completionMergeWindowMs: 20 })
  pending = new PendingDecisionArbiter()
  relay = new RelayQueue()
  agentReplies = []

  const settings = new SettingsStore(join(TEST_HOME, 'settings.json'))
  settings.patch({
    enabledAgents: [
      'chatgpt-codex',
      'workbuddy',
      'qoder-work',
      'trae-work',
      'cursor',
      'hermes',
      'openclaw'
    ],
    remoteAuth: {
      enabled: true,
      allowPermanentRules: false,
      timeoutMs: 2000,
      // 没有专用授权事件的几家要显式开启工具级闸门
      gateToolUseAgents: ['workbuddy', 'trae-work', 'cursor', 'hermes']
    }
  })

  let hookServer: InstanceType<typeof HookServer>
  const registry = new AdapterRegistry({
    engine,
    store,
    settings,
    pending,
    relay,
    sessions: new SessionTracker(store),
    hookUrl: (agentId, event) => hookServer.httpHookUrl(agentId, event),
    bridgeCommand: () => '/tmp/youyi-hook',
    notifyAgentReply: (agentId, text) => agentReplies.push({ agentId, text })
  })
  registry.register(new JsonHooksAdapter(dialects.CODEX_DIALECT))
  registry.register(new JsonHooksAdapter(dialects.WORKBUDDY_DIALECT))
  registry.register(new JsonHooksAdapter(dialects.QODER_DIALECT))
  registry.register(new JsonHooksAdapter(dialects.TRAE_DIALECT))
  registry.register(new CursorAdapter())
  registry.register(new HermesAdapter())
  registry.register(new OpenClawAdapter())

  hookServer = new HookServer(
    (req) => registry.dispatch(req),
    (id) => settings.get().enabledAgents.includes(id)
  )
  server = hookServer
  await server.start()
  token = server.httpHookUrl('workbuddy', 'x').split('/')[4]
})

afterAll(async () => {
  await server.stop()
  rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('Codex（~/.codex/hooks.json）', () => {
  const SESSION = 'codex-sess-1'
  const base = { session_id: SESSION, cwd: '/Users/demo/repo', permission_mode: 'default' }

  it('UserPromptSubmit 建立任务', async () => {
    await bridge('chatgpt-codex', 'UserPromptSubmit', {
      ...base,
      hook_event_name: 'UserPromptSubmit',
      prompt: '把构建脚本迁移到 esbuild'
    })
    const task = store.tasks.list().find((t) => t.agent_id === 'chatgpt-codex')!
    expect(task.title).toBe('把构建脚本迁移到 esbuild')
    expect(task.status).toBe('RUNNING')
  })

  it('PermissionRequest 放行后走 stdout 回写 allow 决策', async () => {
    const inflight = bridge('chatgpt-codex', 'PermissionRequest', {
      ...base,
      hook_event_name: 'PermissionRequest',
      tool_name: 'shell',
      tool_input: { command: 'npm run build' }
    })

    await waitFor(() => pending.size === 1)
    const request = pending.latest('chatgpt-codex')!
    expect(request.deny_only).toBe(false)
    pending.resolve(request.id, 'allow', { source: 'wechat' })

    const result = await inflight
    expect(decisionOf(result)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' }
      }
    })
    // 只放行一次，不写永久规则
    expect(result.stdout).not.toContain('updatedPermissions')
  })

  it('Stop 把排队消息当成新 prompt 注入', async () => {
    relay.enqueue({ agentId: 'chatgpt-codex', text: '顺手把 lint 也修一下', timeoutMs: 5000 })
    const result = await bridge('chatgpt-codex', 'Stop', {
      ...base,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: '迁移完成。'
    })
    expect(decisionOf(result)).toEqual({ decision: 'block', reason: '顺手把 lint 也修一下' })
  })

  it('下一轮 Stop 回传原文并收尾', async () => {
    const result = await bridge('chatgpt-codex', 'Stop', {
      ...base,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'lint 已修，全部通过。'
    })
    expect(result.exit).toBe(0)
    expect(agentReplies).toContainEqual({ agentId: 'chatgpt-codex', text: 'lint 已修，全部通过。' })
    const task = store.tasks.list().find((t) => t.agent_id === 'chatgpt-codex')!
    expect(task.status).toBe('COMPLETED')
  })
})

describe('Workbuddy（~/.codebuddy/settings.json）', () => {
  const SESSION = 'wb-sess-1'
  const base = { session_id: SESSION, cwd: '/Users/demo/app', permission_mode: 'default' }

  beforeAll(async () => {
    await bridge('workbuddy', 'UserPromptSubmit', {
      ...base,
      hook_event_name: 'UserPromptSubmit',
      prompt: '给登录页加上验证码'
    })
  })

  it('只读工具不挂起，不打断节奏', async () => {
    const result = await bridge('workbuddy', 'PreToolUse', {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/Users/demo/app/src/login.tsx' }
    })
    expect(pending.size).toBe(0)
    expect(result.stdout).toBeUndefined()
  })

  it('会改动环境的调用挂起，放行后回写 permissionDecision', async () => {
    const inflight = bridge('workbuddy', 'PreToolUse', {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm i svg-captcha' }
    })

    await waitFor(() => pending.size === 1)
    pending.resolve(pending.latest('workbuddy')!.id, 'allow', { source: 'wechat' })

    const decision = decisionOf(await inflight) as {
      hookSpecificOutput: { permissionDecision: string; hookEventName: string }
    }
    expect(decision.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(decision.hookSpecificOutput.permissionDecision).toBe('allow')
  })

  it('超时交回本机确认，用 ask 强制弹窗而不是默默放过', async () => {
    const result = await bridge('workbuddy', 'PreToolUse', {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/Users/demo/app/src/captcha.ts' }
    })
    const decision = decisionOf(result) as {
      hookSpecificOutput: { permissionDecision: string }
    }
    expect(decision.hookSpecificOutput.permissionDecision).toBe('ask')
  }, 10_000)

  it('Stop 用 continue:false 续跑（decision:block 已废弃）', async () => {
    relay.enqueue({ agentId: 'workbuddy', text: '再加个刷新按钮', timeoutMs: 5000 })
    const result = await bridge('workbuddy', 'Stop', {
      ...base,
      hook_event_name: 'Stop',
      stop_hook_active: false
    })
    expect(decisionOf(result)).toEqual({ continue: false, reason: '再加个刷新按钮' })
  })
})

describe('Qoder Work（~/.qoderwork/settings.json）', () => {
  const SESSION = 'qoder-sess-1'
  const base = { session_id: SESSION, cwd: '/Users/demo/svc' }

  beforeAll(async () => {
    await bridge('qoder-work', 'UserPromptSubmit', {
      ...base,
      hook_event_name: 'UserPromptSubmit',
      prompt: '排查订单超时问题'
    })
  })

  it('如实标注只能远程拒绝', async () => {
    const inflight = bridge('qoder-work', 'PermissionRequest', {
      ...base,
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'kubectl logs -f order-svc' }
    })

    await waitFor(() => pending.size === 1)
    const request = pending.latest('qoder-work')!
    expect(request.deny_only).toBe(true)

    pending.resolve(request.id, 'deny', { source: 'wechat' })
    const result = await inflight
    // 阻断靠 exit 2，原因走 stderr
    expect(result.exit).toBe(2)
    expect(result.stderr).toContain('拒绝')
  })

  it('同意只是不阻断，仍要用户在电脑上确认', async () => {
    const inflight = bridge('qoder-work', 'PermissionRequest', {
      ...base,
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: '/Users/demo/svc/fix.md' }
    })

    await waitFor(() => pending.size === 1)
    const request = pending.latest('qoder-work')!
    pending.resolve(request.id, 'allow', { source: 'wechat' })

    const result = await inflight
    expect(result.exit).toBe(0)
    expect(result.stdout).toBeUndefined()

    const events = store.events.listByTask(request.task_id)
    expect(events.some((e) => e.detail.includes('仍需你在电脑上点确认'))).toBe(true)
  })

  it('Stop 用 exit 2 + stderr 注入消息', async () => {
    relay.enqueue({ agentId: 'qoder-work', text: '把结论写进 issue', timeoutMs: 5000 })
    const result = await bridge('qoder-work', 'Stop', {
      ...base,
      hook_event_name: 'Stop',
      stop_hook_active: false
    })
    expect(result.exit).toBe(2)
    expect(result.stderr).toBe('把结论写进 issue')
  })
})

describe('Trae Work（~/.trae-cn/hooks.json）', () => {
  const SESSION = 'trae-sess-1'
  // Trae 的特有字段：workspace_roots 与 llm_tool_name，终端工具叫 RunCommand
  const base = {
    session_id: SESSION,
    cwd: '/Users/demo/web',
    workspace_roots: ['/Users/demo/web'],
    permission_mode: 'default'
  }

  beforeAll(async () => {
    await bridge('trae-work', 'UserPromptSubmit', {
      ...base,
      hook_event_name: 'UserPromptSubmit',
      prompt: '升级 Vite 到 7'
    })
  })

  it('用 llm_tool_name 兜住工具名', async () => {
    const inflight = bridge('trae-work', 'PreToolUse', {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'RunCommand',
      llm_tool_name: 'run_command',
      tool_input: { command: 'pnpm up vite@7' }
    })

    await waitFor(() => pending.size === 1)
    const request = pending.latest('trae-work')!
    expect(request.tool_name).toBe('RunCommand')
    expect(request.request_text).toContain('pnpm up vite@7')
    pending.resolve(request.id, 'deny', { source: 'wechat' })

    const decision = decisionOf(await inflight) as {
      hookSpecificOutput: { permissionDecision: string }
    }
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('Stop 的 reason 会被当成新的 Query', async () => {
    relay.enqueue({ agentId: 'trae-work', text: '顺便跑一遍 e2e', timeoutMs: 5000 })
    const result = await bridge('trae-work', 'Stop', {
      ...base,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      loop_count: 0,
      last_assistant_message: '升级完成。'
    })
    expect(decisionOf(result)).toEqual({ decision: 'block', reason: '顺便跑一遍 e2e' })
  })

  it('已经被钩子续过一轮就不再注入，避免撞上 loop_limit', async () => {
    relay.enqueue({ agentId: 'trae-work', text: '不该被注入', timeoutMs: 5000 })
    const result = await bridge('trae-work', 'Stop', {
      ...base,
      hook_event_name: 'Stop',
      stop_hook_active: true,
      loop_count: 1,
      last_assistant_message: 'e2e 通过。'
    })
    expect(result.stdout).toBeUndefined()
    expect(relay.pendingFor('trae-work')).toBe(1)
  })
})

describe('Cursor（~/.cursor/hooks.json）', () => {
  const SESSION = 'cursor-conv-1'
  const base = { conversation_id: SESSION, workspace_roots: ['/Users/demo/site'] }

  it('beforeSubmitPrompt 建立任务', async () => {
    await bridge('cursor', 'beforeSubmitPrompt', {
      ...base,
      hook_event_name: 'beforeSubmitPrompt',
      prompt: '给首页加个深色模式'
    })
    const task = store.tasks.list().find((t) => t.agent_id === 'cursor')!
    expect(task.title).toBe('给首页加个深色模式')
    expect(task.status).toBe('RUNNING')
  })

  it('只读工具不挂起，不返回 permission 字段', async () => {
    const result = await bridge('cursor', 'preToolUse', {
      ...base,
      hook_event_name: 'preToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/Users/demo/site/src/App.tsx' },
      cwd: '/Users/demo/site'
    })
    expect(pending.size).toBe(0)
    expect(result.stdout).toBeUndefined()
  })

  it('会改动环境的调用挂起，放行后回写 permission:allow', async () => {
    const inflight = bridge('cursor', 'preToolUse', {
      ...base,
      hook_event_name: 'preToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'npm run build' },
      cwd: '/Users/demo/site'
    })

    await waitFor(() => pending.size === 1)
    const request = pending.latest('cursor')!
    expect(request.deny_only).toBe(false)
    pending.resolve(request.id, 'allow', { source: 'wechat' })

    const decision = decisionOf(await inflight) as { permission: string }
    expect(decision.permission).toBe('allow')
  })

  it('拒绝后回写 permission:deny，正反两个方向都支持', async () => {
    const inflight = bridge('cursor', 'preToolUse', {
      ...base,
      hook_event_name: 'preToolUse',
      tool_name: 'Delete',
      tool_input: { file_path: '/Users/demo/site/legacy.ts' },
      cwd: '/Users/demo/site'
    })

    await waitFor(() => pending.size === 1)
    pending.resolve(pending.latest('cursor')!.id, 'deny', { source: 'wechat' })

    const decision = decisionOf(await inflight) as { permission: string; user_message: string }
    expect(decision.permission).toBe('deny')
    expect(decision.user_message).toContain('拒绝')
  })

  it('afterAgentResponse 暂存回复原文，stop 时用 followup_message 注入排队消息', async () => {
    await bridge('cursor', 'afterAgentResponse', { ...base, text: '深色模式已加上。' })

    relay.enqueue({ agentId: 'cursor', text: '顺手把配色也调一下', timeoutMs: 5000 })
    const result = await bridge('cursor', 'stop', { ...base, status: 'completed', loop_count: 0 })
    expect(decisionOf(result)).toEqual({ followup_message: '顺手把配色也调一下' })
  })

  it('下一轮 stop 没有排队消息时，回传暂存的回复原文并收尾', async () => {
    await bridge('cursor', 'afterAgentResponse', { ...base, text: '配色也调好了。' })
    const result = await bridge('cursor', 'stop', { ...base, status: 'completed', loop_count: 1 })

    expect(result.exit).toBe(0)
    expect(agentReplies).toContainEqual({ agentId: 'cursor', text: '配色也调好了。' })
    const task = store.tasks.list().find((t) => t.agent_id === 'cursor')!
    expect(task.status).toBe('COMPLETED')
  })
})

describe('Hermes（~/.hermes/config.yaml）', () => {
  const SESSION = 'sess_abc123'
  const CWD = '/home/user/project'

  /** 出站 webhook：事件名在 body 的 hook_event_name 里，路径上是 _auto */
  async function webhook(event: string, extra: Record<string, unknown>): Promise<void> {
    await fetch(server.httpHookUrl('hermes', '_auto'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: event,
        tool_name: null,
        tool_input: null,
        session_id: SESSION,
        cwd: CWD,
        extra,
        delivery_id: '3f2c9a',
        timestamp: new Date().toISOString()
      })
    })
  }

  it('pre_llm_call 从 extra.user_message 建立任务', async () => {
    await webhook('pre_llm_call', {
      user_message: '帮我盘一下这周的告警',
      is_first_turn: true,
      model: 'hermes-3',
      platform: 'cli'
    })
    const task = store.tasks.list().find((t) => t.agent_id === 'hermes')!
    expect(task.title).toBe('帮我盘一下这周的告警')
    expect(task.status).toBe('RUNNING')
  })

  it('pre_tool_call 只能远程拒绝，阻断走 exit 2', async () => {
    const inflight = bridge('hermes', 'pre_tool_call', {
      hook_event_name: 'pre_tool_call',
      tool_name: 'terminal',
      tool_input: { command: 'systemctl restart api' },
      session_id: SESSION,
      cwd: CWD,
      extra: { tool_call_id: 'tc_1' }
    })

    await waitFor(() => pending.size === 1)
    const request = pending.latest('hermes')!
    expect(request.deny_only).toBe(true)
    pending.resolve(request.id, 'deny', { source: 'wechat' })

    const result = await inflight
    expect(result.exit).toBe(2)
    expect(result.stderr).toContain('拒绝')
  })

  it('pre_verify 用 action:continue 把新指令续上去', async () => {
    relay.enqueue({ agentId: 'hermes', text: '把告警按服务分组', timeoutMs: 5000 })
    const result = await bridge('hermes', 'pre_verify', {
      hook_event_name: 'pre_verify',
      session_id: SESSION,
      cwd: CWD,
      extra: { attempt: 0, final_response: '盘完了。', coding: false }
    })
    expect(decisionOf(result)).toEqual({ action: 'continue', message: '把告警按服务分组' })
  })

  it('attempt 大于 0 时不再续跑，让位给 max_verify_nudges', async () => {
    relay.enqueue({ agentId: 'hermes', text: '不该被注入', timeoutMs: 5000 })
    const result = await bridge('hermes', 'pre_verify', {
      hook_event_name: 'pre_verify',
      session_id: SESSION,
      cwd: CWD,
      extra: { attempt: 1, final_response: '按服务分组完成。' }
    })
    expect(result.stdout).toBeUndefined()
    expect(agentReplies.some((r) => r.agentId === 'hermes')).toBe(true)
    expect(relay.pendingFor('hermes')).toBe(1)
  })

  it('api_request_error 归一成失败', async () => {
    await bridge('hermes', 'pre_llm_call', {
      hook_event_name: 'pre_llm_call',
      session_id: 'sess_fail',
      cwd: CWD,
      extra: { user_message: '再试一次' }
    })
    await bridge('hermes', 'api_request_error', {
      hook_event_name: 'api_request_error',
      session_id: 'sess_fail',
      cwd: CWD,
      extra: { error_message: '上游 502', attempt: 2 }
    })
    const task = store.tasks.findBySession('hermes', 'sess_fail')!
    expect(task.status).toBe('FAILED')
    expect(store.events.listByTask(task.task_id).at(-1)?.detail).toContain('上游 502')
  })
})

describe('OpenClaw（生成的 handler.ts 回传）', () => {
  const SESSION_KEY = 'whatsapp:123'

  /** 生成的 handler 把整个事件对象原样 POST 过来 */
  async function internal(type: string, context: Record<string, unknown>): Promise<void> {
    await fetch(server.httpHookUrl('openclaw', '_auto'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type,
        action: type.split(':')[1],
        sessionKey: SESSION_KEY,
        timestamp: new Date().toISOString(),
        context
      })
    })
  }

  it('message:received 建立任务（用 sessionKey 而不是 session_id）', async () => {
    await internal('message:received', {
      from: '+8613800000000',
      content: '帮我查下昨天的对账结果',
      channelId: 'whatsapp'
    })
    const task = store.tasks.list().find((t) => t.agent_id === 'openclaw')!
    expect(task.session_id).toBe(SESSION_KEY)
    expect(task.title).toBe('帮我查下昨天的对账结果')
  })

  it('message:sent 带回复原文，任务收尾', async () => {
    await internal('message:sent', {
      to: '+8613800000000',
      content: '对账已完成，差异 0 笔。',
      success: true,
      channelId: 'whatsapp'
    })
    const task = store.tasks.list().find((t) => t.agent_id === 'openclaw')!
    expect(task.status).toBe('COMPLETED')
    expect(task.summary).toBe('对账已完成，差异 0 笔。')
  })

  it('success 为 false 记成失败而不是完成', async () => {
    await internal('message:received', { content: '再查一次', channelId: 'whatsapp' })
    await internal('message:sent', {
      content: '结果如下',
      success: false,
      error: '渠道连接断开',
      channelId: 'whatsapp'
    })
    const task = store.tasks.findBySession('openclaw', SESSION_KEY)!
    expect(task.status).toBe('FAILED')
  })

  it('内部钩子拿不到决策窗口，一律不回写任何东西', async () => {
    const response = await fetch(server.httpHookUrl('openclaw', '_auto'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'gateway:startup', context: {} })
    })
    expect(await response.json()).toEqual({})
  })
})
