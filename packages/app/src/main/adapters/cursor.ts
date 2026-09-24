/**
 * Cursor 适配器（能力 L3：完整生命周期 + 可远程放行/拒绝 + 可透传）。
 *
 * Cursor 的钩子机制（1.7+）虽然事件语义与「Claude 系」高度相似，但配置文件结构
 * 不同构，所以没有塞进 JsonHooksAdapter/dialect 那一套，单独写：
 * - `~/.cursor/hooks.json` 里 `hooks[事件名]` 直接是一个**扁平**的钩子对象数组
 *   （`[{ command, timeout }]`），不是 Claude 那种 `[{ matcher, hooks: [...] }]`
 *   两层嵌套结构，硬套 dialect 表反而会把配置写错。
 * - 字段名也对不上：没有 `session_id`（要用所有事件都带的 `conversation_id`），
 *   没有专用授权事件（只有对每次工具调用都触发的 `preToolUse`），
 *   `stop` 钩子拿不到 `last_assistant_message`，回复原文要靠单独的
 *   `afterAgentResponse` 钩子才能拿到，得自己在两个钩子之间倒一次手。
 *
 * 两个必须处理的坑：
 * - `preToolUse` 没有「不接管，交给 Agent 自己确认」的语义——不返回 `permission`
 *   字段就相当于放行，不会弹出本机确认框。所以高危操作和用户没开闸门时
 *   一律不装决策逻辑，只观察不拦截，绝不能悄悄放过后又误以为「本机会兜底」。
 * - `stop` 的 `followup_message` 会被记进 Cursor 自己的 loop_count/loop_limit
 *   （默认 5），我们不显式设置 loop_limit，让 Cursor 用默认上限兜底，
 *   避免连续透传把会话拖进死循环。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentId } from '@youyi/shared'
import { buildEvent } from '../engine/event-factory.js'
import type { HookOutcome, HookRequest } from '../hook-server/server.js'
import { assessRisk } from '../security/risk.js'
import {
  anyPathExists,
  appInstallPaths,
  findBinary,
  isProcessRunning,
  isRecentlyActive
} from '../util/process-scan.js'
import { createLogger } from '../util/logger.js'
import { describeTool, isConsequentialTool, summarize } from './base/describe.js'
import { backupFile, isYouyiHookEntry, readJsonFile, writeJsonFile } from './base/json-config.js'
import type { AdapterContext, AgentAdapter, DetectResult, InstallResult } from './types.js'

const log = createLogger('cursor')

const CURSOR_DIR = join(homedir(), '.cursor')
const CONFIG_FILE = join(CURSOR_DIR, 'hooks.json')

/** 钩子超时（秒）。除了 preToolUse（可能被闸门放宽），都照文档给的默认量级 */
const EVENT_TIMEOUTS: Record<string, number> = {
  sessionStart: 10,
  beforeSubmitPrompt: 10,
  preToolUse: 10,
  postToolUseFailure: 10,
  stop: 20,
  sessionEnd: 10,
  afterAgentResponse: 10
}
const EVENT_NAMES = Object.keys(EVENT_TIMEOUTS)

interface CursorHookEntry {
  command: string
  timeout?: number
  matcher?: string
  loop_limit?: number | null
  failClosed?: boolean
  [key: string]: unknown
}

interface CursorHooksFile {
  version?: number
  hooks?: Record<string, CursorHookEntry[]>
  [key: string]: unknown
}

/**
 * Cursor 各钩子的字段是「通用字段 + 各事件专属字段」拼起来的，这里按需声明用到的那些。
 * 通用字段里没有 session_id/cwd，取而代之的是 conversation_id 和 workspace_roots。
 */
interface CursorPayload {
  conversation_id?: string
  workspace_roots?: string[]
  /** 只有 sessionStart / sessionEnd 才有，值等于 conversation_id */
  session_id?: string
  cwd?: string
  prompt?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  error_message?: string
  status?: 'completed' | 'aborted' | 'error'
  loop_count?: number
  reason?: string
  text?: string
}

interface EventMeta {
  sessionId: string
  cwd: string | undefined
  transport: 'http' | 'bridge'
  eventName: string
}

export class CursorAdapter implements AgentAdapter {
  readonly id: AgentId = 'cursor'
  /**
   * afterAgentResponse 先到、stop 后到，中间要把回复原文暂存一下，
   * 等 stop 判断这一轮是不是在回答用户从微信发来的话，再决定要不要回传。
   * 任务收尾（stop / sessionEnd）时无论用没用上都会清掉，不会无限堆积。
   */
  private readonly pendingReplies = new Map<string, string>()

  async install(ctx: AdapterContext): Promise<InstallResult> {
    const existing = readJsonFile<CursorHooksFile>(CONFIG_FILE) ?? {}
    backupFile(CONFIG_FILE, 'cursor-install')

    const hooks = { ...(existing.hooks ?? {}) }
    const bridge = ctx.bridgeCommand()
    const gateTimeout = Math.ceil(ctx.settings.get().remoteAuth.timeoutMs / 1000) + 20

    for (const name of EVENT_NAMES) {
      // 先摘掉上一轮写进去的条目（端口/token 每次启动都可能变），再追加当前的
      const kept = (hooks[name] ?? []).filter((entry) => !isYouyiHookEntry(entry))
      const isGate = name === 'preToolUse' && this.gatesOnToolUse(ctx)
      const timeout = isGate ? Math.max(EVENT_TIMEOUTS[name], gateTimeout) : EVENT_TIMEOUTS[name]

      const entry: CursorHookEntry = {
        command: `"${bridge}" --agent ${this.id} --event ${name}`,
        timeout
      }
      hooks[name] = [...kept, entry]
    }

    // 没有 version 字段 Cursor 也能读，但文档统一带 1，跟其他家的约定保持一致
    writeJsonFile(CONFIG_FILE, { version: 1, ...existing, hooks })
    log.info('钩子配置已写入', { file: CONFIG_FILE, events: EVENT_NAMES.length })
    return { ok: true, touchedFiles: [CONFIG_FILE] }
  }

  async uninstall(): Promise<void> {
    const existing = readJsonFile<CursorHooksFile>(CONFIG_FILE)
    if (!existing?.hooks) return
    backupFile(CONFIG_FILE, 'cursor-uninstall')

    const hooks: Record<string, CursorHookEntry[]> = {}
    for (const [event, entries] of Object.entries(existing.hooks)) {
      const kept = entries.filter((entry) => !isYouyiHookEntry(entry))
      if (kept.length > 0) hooks[event] = kept
    }

    writeJsonFile(CONFIG_FILE, { ...existing, hooks })
    log.info('钩子配置已移除', { file: CONFIG_FILE })
  }

  /** 没有专用授权事件的家，是否允许在 preToolUse 上挂起等微信（默认关闭） */
  private gatesOnToolUse(ctx: AdapterContext): boolean {
    const { remoteAuth } = ctx.settings.get()
    return remoteAuth.enabled && remoteAuth.gateToolUseAgents.includes(this.id)
  }

  private sessionIdOf(payload: CursorPayload): string {
    return payload.session_id ?? payload.conversation_id ?? 'unknown'
  }

  private cwdOf(payload: CursorPayload, reqCwd: string | undefined): string | undefined {
    return payload.cwd ?? payload.workspace_roots?.[0] ?? reqCwd
  }

  async handle(req: HookRequest, ctx: AdapterContext): Promise<HookOutcome> {
    const payload = req.payload as CursorPayload
    const meta: EventMeta = {
      sessionId: this.sessionIdOf(payload),
      cwd: this.cwdOf(payload, req.cwd),
      transport: req.transport,
      eventName: req.event
    }

    switch (req.event) {
      case 'sessionStart':
        // 只建立会话映射，不算任务开始——用户还没派活
        ctx.sessions.currentOrNext(this.id, meta.sessionId)
        return {}
      case 'beforeSubmitPrompt':
        return this.onPrompt(payload, meta, ctx)
      case 'preToolUse':
        return this.onToolUse(payload, meta, ctx)
      case 'postToolUseFailure':
        return this.onFailure(payload, meta, ctx)
      case 'stop':
        return this.onTurnEnd(payload, meta, ctx)
      case 'afterAgentResponse':
        return this.onAgentResponse(payload, meta, ctx)
      case 'sessionEnd':
        return this.onSessionEnd(payload, meta, ctx)
      default:
        return {}
    }
  }

  private onPrompt(payload: CursorPayload, meta: EventMeta, ctx: AdapterContext): HookOutcome {
    const taskId = ctx.sessions.startTurn(this.id, meta.sessionId)
    const prompt = payload.prompt?.trim() ?? ''

    ctx.engine.ingest(
      buildEvent({
        agentId: this.id,
        taskId,
        type: 'task_started',
        title: '开始新任务',
        detail: prompt.slice(0, 200),
        taskMeta: {
          task_title: summarize(prompt),
          session_id: meta.sessionId,
          cwd: meta.cwd,
          started_at: new Date().toISOString()
        },
        source: { hook: meta.eventName, transport: meta.transport, raw: payload }
      })
    )
    // 不返回 continue:false，从不拦用户自己提交的话
    return {}
  }

  private async onToolUse(
    payload: CursorPayload,
    meta: EventMeta,
    ctx: AdapterContext
  ): Promise<HookOutcome> {
    const taskId = ctx.sessions.current(this.id, meta.sessionId)
    const toolName = payload.tool_name

    ctx.engine.ingest(
      buildEvent({
        agentId: this.id,
        taskId,
        type: 'task_progress',
        title: `正在使用 ${toolName ?? '工具'}`,
        detail: describeTool(toolName, payload.tool_input),
        taskMeta: { session_id: meta.sessionId, cwd: meta.cwd },
        source: { hook: meta.eventName, transport: meta.transport, raw: payload }
      })
    )

    // 只有开启了工具级闸门、且这次调用会改动环境时才挂起等确认；
    // preToolUse 对每次工具调用都触发，无脑挂起会把读文件、搜代码全部拖慢
    if (!this.gatesOnToolUse(ctx)) return {}
    if (!isConsequentialTool(toolName, payload.tool_input)) return {}

    return this.arbitrate(payload, meta, ctx, taskId, toolName)
  }

  /** 远程放行的核心路径：上报 → 挂起等决策 → 按 Cursor 的 permission 字段回写 */
  private async arbitrate(
    payload: CursorPayload,
    meta: EventMeta,
    ctx: AdapterContext,
    taskId: string,
    toolNameRaw: string | undefined
  ): Promise<HookOutcome> {
    const toolName = toolNameRaw ?? '未知工具'
    const requestText = describeTool(toolName, payload.tool_input)
    const risk = assessRisk(toolName, requestText)

    ctx.engine.ingest(
      buildEvent({
        agentId: this.id,
        taskId,
        type: 'auth_required',
        title: 'Cursor 需要你确认',
        detail: risk.highRisk ? `${requestText}\n（这是高危操作，只能在电脑上确认）` : requestText,
        authOptions: risk.highRisk ? 'local-only' : 'remote',
        taskMeta: { session_id: meta.sessionId, cwd: meta.cwd },
        source: { hook: meta.eventName, transport: meta.transport, raw: payload }
      })
    )

    const { remoteAuth } = ctx.settings.get()
    if (!remoteAuth.enabled || risk.highRisk) {
      // preToolUse 不返回 permission 字段就等同于放行，这里没有「交回本机确认」的退路，
      // 所以不接管时干脆什么都不返回，让调用照常进行，只是没有远程决策这一步
      return {}
    }

    const { request, wait } = ctx.pending.create({
      agentId: this.id,
      taskId,
      toolName,
      requestText,
      highRisk: risk.highRisk,
      highRiskReason: risk.reason,
      denyOnly: false,
      timeoutMs: remoteAuth.timeoutMs
    })

    const result = await wait
    log.info('授权请求决策完成', { id: request.id, decision: result.decision })

    if (result.decision === 'timeout') {
      // 超时不做决策：不返回 permission 字段，调用会照常放行——
      // 这是 Cursor 这条通道能给到的唯一「不代替用户点同意」的选择
      return {}
    }

    if (result.decision === 'allow') {
      ctx.engine.ingest(
        buildEvent({
          agentId: this.id,
          taskId,
          type: 'task_progress',
          title: '已远程放行',
          detail: `你在微信里放行了：${requestText}`,
          taskMeta: { session_id: meta.sessionId, cwd: meta.cwd },
          source: { hook: meta.eventName, transport: 'internal', raw: null }
        })
      )
      return { json: { permission: 'allow' } }
    }

    const message = '你在微信里拒绝了这个操作。'
    return { json: { permission: 'deny', user_message: message, agent_message: message } }
  }

  private onFailure(payload: CursorPayload, meta: EventMeta, ctx: AdapterContext): HookOutcome {
    const taskId = ctx.sessions.current(this.id, meta.sessionId)
    ctx.engine.ingest(
      buildEvent({
        agentId: this.id,
        taskId,
        type: 'task_failed',
        title: '任务失败',
        detail: payload.error_message ?? '执行过程中出错了。',
        taskMeta: { session_id: meta.sessionId, cwd: meta.cwd },
        source: { hook: meta.eventName, transport: meta.transport, raw: payload }
      })
    )
    return {}
  }

  /** afterAgentResponse 只用来暂存回复原文，stop 到来时再决定要不要回传给用户 */
  private onAgentResponse(
    payload: CursorPayload,
    meta: EventMeta,
    ctx: AdapterContext
  ): HookOutcome {
    const taskId = ctx.sessions.current(this.id, meta.sessionId)
    const text = payload.text?.trim()
    if (text) this.pendingReplies.set(taskId, text)
    return {}
  }

  /** 透传注入点：一轮结束时把排队的用户消息用 followup_message 塞回对话 */
  private onTurnEnd(payload: CursorPayload, meta: EventMeta, ctx: AdapterContext): HookOutcome {
    const taskId = ctx.sessions.current(this.id, meta.sessionId)

    const queued = ctx.relay.take(this.id, taskId)
    if (queued) {
      ctx.relay.markAwaitingReply(taskId)
      ctx.engine.ingest(
        buildEvent({
          agentId: this.id,
          taskId,
          type: 'task_progress',
          title: '已把你的消息转达给 Cursor',
          detail: queued.text,
          taskMeta: { session_id: meta.sessionId, cwd: meta.cwd },
          source: { hook: meta.eventName, transport: meta.transport, raw: payload }
        })
      )
      return { json: { followup_message: queued.text } }
    }

    const reply = this.pendingReplies.get(taskId)
    this.pendingReplies.delete(taskId)
    // 如果这一轮是在回答用户从微信发来的话，就把 afterAgentResponse 存的原文回传
    if (reply && ctx.relay.consumeAwaitingReply(taskId)) {
      ctx.notifyAgentReply(this.id, reply)
    }

    const failed = payload.status === 'error'
    ctx.engine.ingest(
      buildEvent({
        agentId: this.id,
        taskId,
        type: failed ? 'task_failed' : 'task_completed',
        title: failed ? '任务失败' : '任务完成',
        detail: reply ?? (failed ? '执行过程中出错了。' : '这一轮已经结束。'),
        taskMeta: { session_id: meta.sessionId, cwd: meta.cwd, last_assistant_message: reply },
        source: { hook: meta.eventName, transport: meta.transport, raw: payload }
      })
    )
    return {}
  }

  private onSessionEnd(payload: CursorPayload, meta: EventMeta, ctx: AdapterContext): HookOutcome {
    const taskId = ctx.sessions.current(this.id, meta.sessionId)
    this.pendingReplies.delete(taskId)

    const task = ctx.store.tasks.get(taskId)
    // 一轮结束时已经收尾过就不重复上报，避免状态机拒绝迁移
    if (!task || task.status === 'COMPLETED' || task.status === 'FAILED') return {}

    const failed = payload.reason === 'error'
    ctx.engine.ingest(
      buildEvent({
        agentId: this.id,
        taskId,
        type: failed ? 'task_failed' : 'task_completed',
        title: failed ? '会话异常结束' : '会话结束',
        detail: `会话已结束（${payload.reason ?? '未知原因'}）。`,
        taskMeta: { session_id: meta.sessionId, cwd: meta.cwd },
        source: { hook: meta.eventName, transport: meta.transport, raw: payload }
      })
    )
    return {}
  }

  async detect(): Promise<DetectResult> {
    const evidence: string[] = []

    // Cursor 的 Agent CLI 叫 cursor-agent，桌面应用另外还装了个打开工程用的 cursor 命令
    let binary = await findBinary('cursor-agent')
    if (!binary) binary = await findBinary('cursor')
    if (binary) evidence.push(`找到可执行文件 ${binary}`)

    const appPath = anyPathExists(appInstallPaths('Cursor'))
    if (appPath) evidence.push(`找到应用 ${appPath}`)

    const configDir = anyPathExists([CURSOR_DIR])
    if (configDir) evidence.push(`找到配置目录 ${configDir}`)

    const active = Boolean(configDir) && isRecentlyActive(configDir!)
    if (active) evidence.push('配置目录最近有使用记录')

    const running = await isProcessRunning(['Cursor.app', 'Cursor Helper', 'cursor-agent'])
    if (running) evidence.push('检测到正在运行的进程')

    const found = Boolean(binary) || Boolean(appPath)
    return {
      installed: found || Boolean(configDir) || existsSync(CONFIG_FILE),
      running,
      configOnly: !found && Boolean(configDir) && !active,
      evidence
    }
  }
}
