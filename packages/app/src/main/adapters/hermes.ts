/**
 * Hermes 适配器（能力 L2：可通知 + 可透传 + 只能远程拒绝）。
 *
 * Hermes 有四套钩子机制，这里按各自所长分工使用两套：
 * - 观察类事件走 **outbound webhook**：直接 POST 到本地 HookServer，不用起子进程，
 *   也绕开了 shell hook 的授信流程，通知链路最稳。
 * - 需要决策的事件走 **shell hook**：只有它能阻断工具调用，也只有 pre_verify
 *   能在一轮收尾前把新指令塞回去。
 *
 * 三个必须处理的坑：
 * - 命令是 `shlex.split` + `shell=False` 执行的：`~` 和 `$VAR` 都不会展开，
 *   所以必须写绝对路径（桥接程序本来就是绝对路径，这里额外加引号防目录带空格）。
 * - 新增 shell hook 需要用户授信，非交互环境下不授信就静默不注册。我们不去动
 *   `hooks_auto_accept` 这个全局开关（那会连带信任以后任何第三方钩子），
 *   而是把本次安装的条目精确写进 allowlist 文件，作为「用户在引导里点了安装」的凭据。
 * - `approve` 的语义是「升级为人工确认」而不是「批准」，所以 Hermes 只能远程拒绝。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AUTO_EVENT, type AgentId } from '@youyi/shared'
import { parseDocument, type Document } from 'yaml'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { buildEvent } from '../engine/event-factory.js'
import type { HookOutcome, HookRequest } from '../hook-server/server.js'
import { assessRisk } from '../security/risk.js'
import { anyPathExists, findBinary, isProcessRunning } from '../util/process-scan.js'
import { createLogger } from '../util/logger.js'
import { describeTool, isConsequentialTool, summarize } from './base/describe.js'
import { backupFile, readJsonFile, writeJsonFile } from './base/json-config.js'
import type { AdapterContext, AgentAdapter, DetectResult, InstallResult } from './types.js'

const log = createLogger('hermes')

const HERMES_DIR = join(homedir(), '.hermes')
const CONFIG_FILE = join(HERMES_DIR, 'config.yaml')
const ALLOWLIST_FILE = join(HERMES_DIR, 'shell-hooks-allowlist.json')

/** 需要同步决策窗口的事件，只能走 shell hook */
const SHELL_EVENTS = ['pre_tool_call', 'pre_verify'] as const
/** 纯观察事件，走 outbound webhook 更稳 */
const WEBHOOK_EVENTS = [
  'on_session_start',
  'pre_llm_call',
  'post_llm_call',
  'api_request_error',
  'on_session_end'
] as const

/** shell hook 超时上限是 300 秒，超过会被 clamp */
const MAX_SHELL_TIMEOUT_SEC = 300

/** Hermes 的统一 wire format（shell hook 与 outbound webhook 完全一致） */
interface HermesPayload {
  hook_event_name?: string
  tool_name?: string | null
  tool_input?: Record<string, unknown> | null
  session_id?: string
  cwd?: string
  /** 各事件特有的 kwargs 全在这里 */
  extra?: Record<string, unknown>
}

interface AllowlistFile {
  approvals?: { event: string; command: string }[]
}

export class HermesAdapter implements AgentAdapter {
  readonly id: AgentId = 'hermes'

  async install(ctx: AdapterContext): Promise<InstallResult> {
    const touched: string[] = []
    const bridge = ctx.bridgeCommand()
    const gateSec = Math.min(
      Math.ceil(ctx.settings.get().remoteAuth.timeoutMs / 1000) + 20,
      MAX_SHELL_TIMEOUT_SEC
    )

    const doc = this.loadConfig()
    backupFile(CONFIG_FILE, 'hermes-config-install')

    const approvals: { event: string; command: string }[] = []
    for (const event of SHELL_EVENTS) {
      const command = `"${bridge}" --agent ${this.id} --event ${event}`
      const kept = this.existingEntries(doc, event).filter(
        (e) => !String(e.command ?? '').includes('youyi-hook')
      )
      doc.setIn(['hooks', event], [
        ...kept,
        {
          command,
          timeout: event === 'pre_tool_call' ? gateSec : 60,
          // 绝不因为哨兵不可用就阻断用户的 Agent
          fail_closed: false
        }
      ])
      approvals.push({ event, command })
    }

    // outbound webhook 只需要一条：事件名在 body 里，路径上用 _auto 占位
    const outbound = this.existingOutbound(doc).filter((e) => e.name !== 'youyi')
    doc.setIn(['hooks', 'outbound'], [
      ...outbound,
      {
        name: 'youyi',
        url: ctx.hookUrl(this.id, AUTO_EVENT),
        events: [...WEBHOOK_EVENTS],
        timeout: 10
      }
    ])

    this.saveConfig(doc)
    touched.push(CONFIG_FILE)

    // 把授信凭据写进 allowlist：不写的话新 shell hook 在非交互环境下会被静默跳过
    this.mergeAllowlist(approvals)
    touched.push(ALLOWLIST_FILE)

    log.info('Hermes 钩子已写入', { shell: SHELL_EVENTS.length, webhook: WEBHOOK_EVENTS.length })
    return {
      ok: true,
      touchedFiles: touched,
      degradedReason:
        'Hermes 的放行语义是「升级为人工确认」，因此只能在微信里拒绝，放行需回到电脑操作。'
    }
  }

  async uninstall(): Promise<void> {
    if (existsSync(CONFIG_FILE)) {
      const doc = this.loadConfig()
      backupFile(CONFIG_FILE, 'hermes-config-uninstall')

      for (const event of SHELL_EVENTS) {
        const kept = this.existingEntries(doc, event).filter(
          (e) => !String(e.command ?? '').includes('youyi-hook')
        )
        if (kept.length > 0) doc.setIn(['hooks', event], kept)
        else doc.deleteIn(['hooks', event])
      }

      const outbound = this.existingOutbound(doc).filter((e) => e.name !== 'youyi')
      if (outbound.length > 0) doc.setIn(['hooks', 'outbound'], outbound)
      else doc.deleteIn(['hooks', 'outbound'])

      this.saveConfig(doc)
    }

    // allowlist 里只摘自己的条目，用户给别的钩子的授信必须保留
    const allowlist = readJsonFile<AllowlistFile>(ALLOWLIST_FILE)
    if (allowlist?.approvals) {
      writeJsonFile(ALLOWLIST_FILE, {
        ...allowlist,
        approvals: allowlist.approvals.filter((a) => !a.command.includes('youyi-hook'))
      })
    }
    log.info('Hermes 钩子已移除')
  }

  private loadConfig(): Document {
    try {
      if (existsSync(CONFIG_FILE)) {
        // 用 Document API 而不是 parse/stringify：用户配置里的注释必须原样保留
        return parseDocument(readFileSync(CONFIG_FILE, 'utf8'))
      }
    } catch (err) {
      log.warn('config.yaml 解析失败，将新建配置', String(err))
    }
    return parseDocument('')
  }

  private saveConfig(doc: Document): void {
    mkdirSync(HERMES_DIR, { recursive: true })
    const tmp = `${CONFIG_FILE}.youyi-tmp`
    writeFileSync(tmp, String(doc), 'utf8')
    renameSync(tmp, CONFIG_FILE)
  }

  private existingEntries(doc: Document, event: string): Record<string, unknown>[] {
    const value = doc.getIn(['hooks', event], true)
    const plain = value && typeof value === 'object' ? (value as { toJSON?: () => unknown }) : null
    const json = plain?.toJSON ? plain.toJSON() : value
    return Array.isArray(json) ? (json as Record<string, unknown>[]) : []
  }

  private existingOutbound(doc: Document): { name?: string }[] {
    return this.existingEntries(doc, 'outbound') as { name?: string }[]
  }

  private mergeAllowlist(approvals: { event: string; command: string }[]): void {
    const current = readJsonFile<AllowlistFile>(ALLOWLIST_FILE) ?? {}
    const others = (current.approvals ?? []).filter((a) => !a.command.includes('youyi-hook'))
    writeJsonFile(ALLOWLIST_FILE, { ...current, approvals: [...others, ...approvals] })
  }

  async handle(req: HookRequest, ctx: AdapterContext): Promise<HookOutcome> {
    const payload = req.payload as HermesPayload
    // outbound webhook 走同一个地址，真实事件名只在 body 里
    const event = req.event === AUTO_EVENT ? (payload.hook_event_name ?? '') : req.event
    const sessionId = payload.session_id ?? 'unknown'
    const cwd = payload.cwd ?? req.cwd
    const extra = payload.extra ?? {}

    switch (event) {
      case 'on_session_start':
        ctx.sessions.currentOrNext(this.id, sessionId)
        return { exit: 0 }

      case 'pre_llm_call':
        return this.onPrompt(payload, extra, sessionId, cwd, ctx, req)

      case 'pre_tool_call':
        return this.onToolCall(payload, sessionId, cwd, ctx, req)

      case 'post_llm_call':
        return this.onModelReply(extra, sessionId, cwd, ctx, req)

      case 'pre_verify':
        return this.onVerify(extra, sessionId, cwd, ctx, req)

      case 'api_request_error':
        return this.onFailure(extra, sessionId, cwd, ctx, req)

      case 'on_session_end':
        return this.onSessionEnd(extra, sessionId, cwd, ctx, req)

      default:
        return { exit: 0 }
    }
  }

  private onPrompt(
    payload: HermesPayload,
    extra: Record<string, unknown>,
    sessionId: string,
    cwd: string | undefined,
    ctx: AdapterContext,
    req: HookRequest
  ): HookOutcome {
    const taskId = ctx.sessions.startTurn(this.id, sessionId)
    const prompt = typeof extra.user_message === 'string' ? extra.user_message.trim() : ''

    ctx.engine.ingest(
      buildEvent({
        agentId: this.id,
        taskId,
        type: 'task_started',
        title: '开始新任务',
        detail: prompt.slice(0, 200),
        taskMeta: {
          task_title: summarize(prompt),
          session_id: sessionId,
          cwd,
          started_at: new Date().toISOString()
        },
        source: { hook: 'pre_llm_call', transport: req.transport, raw: payload }
      })
    )
    return { exit: 0 }
  }

  /** 唯一能阻断的位置。Hermes 无法远程放行，只能远程拒绝 */
  private async onToolCall(
    payload: HermesPayload,
    sessionId: string,
    cwd: string | undefined,
    ctx: AdapterContext,
    req: HookRequest
  ): Promise<HookOutcome> {
    const taskId = ctx.sessions.current(this.id, sessionId)
    const toolName = payload.tool_name ?? '未知工具'
    const requestText = describeTool(toolName, payload.tool_input)

    ctx.engine.ingest(
      buildEvent({
        agentId: this.id,
        taskId,
        type: 'task_progress',
        title: `正在使用 ${toolName}`,
        detail: requestText,
        taskMeta: { session_id: sessionId, cwd },
        source: { hook: 'pre_tool_call', transport: req.transport, raw: payload }
      })
    )

    const { remoteAuth } = ctx.settings.get()
    // Hermes 没有专用授权事件，与 Trae 同理：默认不拦，开启后只拦会改动环境的调用
    if (!remoteAuth.enabled || !remoteAuth.gateToolUseAgents.includes(this.id)) return { exit: 0 }
    if (!isConsequentialTool(toolName, payload.tool_input)) return { exit: 0 }

    const risk = assessRisk(toolName, requestText)
    ctx.engine.ingest(
      buildEvent({
        agentId: this.id,
        taskId,
        type: 'auth_required',
        title: 'Hermes 需要你确认',
        detail: risk.highRisk
          ? `${requestText}\n（这是高危操作，只能在电脑上确认）`
          : `${requestText}\n（Hermes 只支持远程拒绝，放行要回到电脑上操作）`,
        authOptions: risk.highRisk ? 'local-only' : 'deny-only',
        taskMeta: { session_id: sessionId, cwd },
        source: { hook: 'pre_tool_call', transport: req.transport, raw: payload }
      })
    )

    const { wait } = ctx.pending.create({
      agentId: this.id,
      taskId,
      toolName,
      requestText,
      highRisk: risk.highRisk,
      highRiskReason: risk.reason,
      denyOnly: true,
      timeoutMs: Math.min(remoteAuth.timeoutMs, (MAX_SHELL_TIMEOUT_SEC - 20) * 1000)
    })

    const result = await wait
    if (result.decision === 'deny') {
      // exit 2 是 Claude Code / Cursor 兼容的阻断约定，stderr 作为原因回给模型
      return { exit: 2, stderr: '用户在微信里拒绝了这个操作。' }
    }
    return { exit: 0 }
  }

  private onModelReply(
    extra: Record<string, unknown>,
    sessionId: string,
    cwd: string | undefined,
    ctx: AdapterContext,
    req: HookRequest
  ): HookOutcome {
    const taskId = ctx.sessions.current(this.id, sessionId)
    const reply = typeof extra.assistant_response === 'string' ? extra.assistant_response.trim() : ''

    ctx.engine.ingest(
      buildEvent({
        agentId: this.id,
        taskId,
        type: 'task_progress',
        title: 'Hermes 已给出回答',
        detail: reply.slice(0, 200),
        taskMeta: { session_id: sessionId, cwd },
        source: { hook: 'post_llm_call', transport: req.transport, raw: extra }
      })
    )
    return { exit: 0 }
  }

  /**
   * 一轮收尾前的最后一道闸门，也是 Hermes 的透传注入点：
   * 返回 continue 就把 message 当成一条新的用户发言接上去。
   */
  private onVerify(
    extra: Record<string, unknown>,
    sessionId: string,
    cwd: string | undefined,
    ctx: AdapterContext,
    req: HookRequest
  ): HookOutcome {
    const taskId = ctx.sessions.current(this.id, sessionId)
    const reply =
      typeof extra.final_response === 'string' ? extra.final_response.trim() : undefined
    // attempt 是已经续跑的次数，Hermes 侧上限由 agent.max_verify_nudges 控制（默认 3）
    const attempt = typeof extra.attempt === 'number' ? extra.attempt : 0

    if (attempt === 0) {
      const queued = ctx.relay.take(this.id, taskId)
      if (queued) {
        ctx.relay.markAwaitingReply(taskId)
        ctx.engine.ingest(
          buildEvent({
            agentId: this.id,
            taskId,
            type: 'task_progress',
            title: '已把你的消息转达给 Hermes',
            detail: queued.text,
            taskMeta: { session_id: sessionId, cwd },
            source: { hook: 'pre_verify', transport: req.transport, raw: extra }
          })
        )
        return { json: { action: 'continue', message: queued.text } }
      }
    }

    if (reply && ctx.relay.consumeAwaitingReply(taskId)) {
      ctx.notifyAgentReply(this.id, reply)
    }

    ctx.engine.ingest(
      buildEvent({
        agentId: this.id,
        taskId,
        type: 'task_completed',
        title: '任务完成',
        detail: reply ?? '这一轮已经结束。',
        taskMeta: { session_id: sessionId, cwd, last_assistant_message: reply },
        source: { hook: 'pre_verify', transport: req.transport, raw: extra }
      })
    )
    return { exit: 0 }
  }

  private onFailure(
    extra: Record<string, unknown>,
    sessionId: string,
    cwd: string | undefined,
    ctx: AdapterContext,
    req: HookRequest
  ): HookOutcome {
    const taskId = ctx.sessions.current(this.id, sessionId)
    ctx.engine.ingest(
      buildEvent({
        agentId: this.id,
        taskId,
        type: 'task_failed',
        title: '任务失败',
        detail: String(extra.error_message ?? extra.error ?? '模型请求出错了。'),
        taskMeta: { session_id: sessionId, cwd },
        source: { hook: 'api_request_error', transport: req.transport, raw: extra }
      })
    )
    return { exit: 0 }
  }

  private onSessionEnd(
    extra: Record<string, unknown>,
    sessionId: string,
    cwd: string | undefined,
    ctx: AdapterContext,
    req: HookRequest
  ): HookOutcome {
    const taskId = ctx.sessions.current(this.id, sessionId)
    const task = ctx.store.tasks.get(taskId)
    if (!task || task.status === 'COMPLETED' || task.status === 'FAILED') return { exit: 0 }

    const failed = extra.completed === false || extra.failed === true
    ctx.engine.ingest(
      buildEvent({
        agentId: this.id,
        taskId,
        type: failed ? 'task_failed' : 'task_completed',
        title: failed ? '会话异常结束' : '会话结束',
        detail: String(extra.turn_exit_reason ?? '会话已结束。'),
        taskMeta: { session_id: sessionId, cwd },
        source: { hook: 'on_session_end', transport: req.transport, raw: extra }
      })
    )
    return { exit: 0 }
  }

  async detect(): Promise<DetectResult> {
    const evidence: string[] = []
    const binary = await findBinary('hermes')
    if (binary) evidence.push(`找到可执行文件 ${binary}`)

    const configDir = anyPathExists([HERMES_DIR])
    if (configDir) evidence.push(`找到配置目录 ${configDir}`)

    const running = await isProcessRunning(['hermes gateway', 'hermes '])
    if (running) evidence.push('检测到正在运行的进程')

    return {
      installed: Boolean(binary) || Boolean(configDir),
      running,
      configOnly: !binary && Boolean(configDir),
      evidence
    }
  }
}

