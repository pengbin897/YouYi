/**
 * Claude 系五家共用的适配器实现，行为由方言表（dialect.ts）驱动。
 *
 * 这一层负责三件事，厂商差异一律查方言表：
 * 1. 把钩子写进/摘出该 Agent 的 JSON 配置（备份 + 键级合并 + 精确回滚）
 * 2. 把原始 payload 归一化成 UnifiedEvent
 * 3. 在同步响应窗口里完成远程放行与消息注入
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { AgentId } from '@youyi/shared'
import { buildEvent } from '../../engine/event-factory.js'
import type { HookOutcome, HookRequest } from '../../hook-server/server.js'
import { assessRisk } from '../../security/risk.js'
import {
  anyPathExists,
  appInstallPaths,
  findBinary,
  isProcessRunning,
  isRecentlyActive,
  which
} from '../../util/process-scan.js'
import { createLogger } from '../../util/logger.js'
import type { AdapterContext, AgentAdapter, DetectResult, InstallResult } from '../types.js'
import { describeTool, isConsequentialTool, summarize } from './describe.js'
import { DENIED_MESSAGE, type HookDialect, type HookRole } from './dialect.js'
import { backupFile, isYouyiHookEntry, readJsonFile, writeJsonFile } from './json-config.js'

interface HooksFile {
  hooks?: Record<string, MatcherEntry[]>
  [key: string]: unknown
}

interface MatcherEntry {
  matcher?: string
  loop_limit?: number
  hooks?: unknown[]
}

/** 五家共用的 stdin 字段。名字一致是这层抽象成立的前提 */
interface HookPayload {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  permission_mode?: string
  prompt?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  message?: string
  notification_type?: string
  reason?: string
  source?: string
  stop_hook_active?: boolean
  loop_count?: number
  last_assistant_message?: string
  error?: string
  /** Trae 独有，用于识别串台事件 */
  workspace_roots?: string[]
  llm_tool_name?: string
}

interface EventMeta {
  sessionId: string
  cwd: string | undefined
  transport: 'http' | 'bridge'
  /** 厂商原始事件名，回写决策时要原样带上 */
  eventName: string
}

export class JsonHooksAdapter implements AgentAdapter {
  readonly id: AgentId
  private readonly log

  constructor(private readonly dialect: HookDialect) {
    this.id = dialect.agentId
    this.log = createLogger(dialect.agentId)
  }

  /** 供注册表识别串台事件用 */
  get spec(): HookDialect {
    return this.dialect
  }

  async install(ctx: AdapterContext): Promise<InstallResult> {
    const file = this.dialect.configFile
    const existing = readJsonFile<HooksFile>(file) ?? {}
    backupFile(file, `${this.id}-install`)

    const hooks = { ...(existing.hooks ?? {}) }
    // 远程放行要等用户回微信，闸门事件的超时按用户设置的等待窗口放宽
    const gateTimeout = Math.ceil(ctx.settings.get().remoteAuth.timeoutMs / 1000) + 20

    for (const spec of this.dialect.events) {
      // 先剔除上一轮写进去的条目（端口和 token 每次启动都可能变），再追加当前的
      const kept = (hooks[spec.name] ?? []).filter((entry) => !isYouyiHookEntry(entry))
      const isGate = spec.role === 'permission' || (spec.role === 'tool-pre' && this.gatesOnToolUse(ctx))
      const timeout = isGate ? Math.max(spec.timeoutSec, gateTimeout) : spec.timeoutSec

      const entry: MatcherEntry = {
        ...(spec.matcher ? { matcher: spec.matcher } : {}),
        ...(spec.role === 'turn-end' && this.dialect.loopLimit
          ? { loop_limit: this.dialect.loopLimit }
          : {}),
        hooks: [this.buildHookEntry(ctx, spec.name, timeout)]
      }
      hooks[spec.name] = [...kept, entry]
    }

    writeJsonFile(file, { ...(this.dialect.fileTemplate ?? {}), ...existing, hooks })
    this.log.info('钩子配置已写入', { file, events: this.dialect.events.length })
    return { ok: true, touchedFiles: [file] }
  }

  private buildHookEntry(ctx: AdapterContext, eventName: string, timeout: number): unknown {
    if (this.dialect.entry === 'http') {
      return { type: 'http', url: ctx.hookUrl(this.id, eventName), timeout }
    }
    // 桥接命令一律写绝对路径：IDE 内嵌的 Agent 环境变量和用户 shell 不一致，
    // 部分家还不做 ~ 展开
    return {
      type: 'command',
      command: `"${ctx.bridgeCommand()}" --agent ${this.id} --event ${eventName}`,
      timeout
    }
  }

  async uninstall(): Promise<void> {
    const file = this.dialect.configFile
    const existing = readJsonFile<HooksFile>(file)
    if (!existing?.hooks) return
    backupFile(file, `${this.id}-uninstall`)

    const hooks: Record<string, MatcherEntry[]> = {}
    for (const [event, entries] of Object.entries(existing.hooks)) {
      // 只摘自己写的条目，用户原有的钩子必须原样保留
      const kept = entries.filter((entry) => !isYouyiHookEntry(entry))
      if (kept.length > 0) hooks[event] = kept
    }

    writeJsonFile(file, { ...existing, hooks })
    this.log.info('钩子配置已移除', { file })
  }

  async handle(req: HookRequest, ctx: AdapterContext): Promise<HookOutcome> {
    const payload = req.payload as HookPayload
    const role = this.roleOf(req.event)
    const meta: EventMeta = {
      sessionId: payload.session_id ?? 'unknown',
      cwd: payload.cwd ?? req.cwd,
      transport: req.transport,
      eventName: req.event
    }

    switch (role) {
      case 'session-start':
        // 只建立会话映射，不算任务开始——用户还没派活
        ctx.sessions.currentOrNext(this.id, meta.sessionId)
        return {}
      case 'prompt':
        return this.onPrompt(payload, meta, ctx)
      case 'tool-pre':
        return this.onToolUse(payload, meta, ctx)
      case 'permission':
        return this.onPermission(payload, meta, ctx)
      case 'notification':
        return this.onNotification(payload, meta, ctx)
      case 'turn-end':
        return this.onTurnEnd(payload, meta, ctx)
      case 'failure':
        return this.onFailure(payload, meta, ctx)
      case 'session-end':
        return this.onSessionEnd(payload, meta, ctx)
      default:
        return {}
    }
  }

  private roleOf(eventName: string): HookRole | undefined {
    return this.dialect.events.find((e) => e.name === eventName)?.role
  }

  /** 没有专用授权事件的家，是否允许在 PreToolUse 上挂起等微信（默认关闭） */
  private gatesOnToolUse(ctx: AdapterContext): boolean {
    if (this.dialect.gateAt !== 'pre-tool') return false
    const { remoteAuth } = ctx.settings.get()
    return remoteAuth.enabled && remoteAuth.gateToolUseAgents.includes(this.id)
  }

  private onPrompt(payload: HookPayload, meta: EventMeta, ctx: AdapterContext): HookOutcome {
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
    return {}
  }

  private async onToolUse(
    payload: HookPayload,
    meta: EventMeta,
    ctx: AdapterContext
  ): Promise<HookOutcome> {
    const taskId = ctx.sessions.current(this.id, meta.sessionId)
    const toolName = payload.tool_name ?? payload.llm_tool_name

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

    // 只有开启了工具级闸门、且这次调用会改动环境时才挂起等确认
    if (!this.gatesOnToolUse(ctx)) return {}
    if (!isConsequentialTool(toolName, payload.tool_input)) return {}
    // 用户已经把确认关掉了（自动接受/绕过），就别再替他拦一道
    if (payload.permission_mode && payload.permission_mode !== 'default') return {}

    return this.arbitrate(payload, meta, ctx, taskId)
  }

  private async onPermission(
    payload: HookPayload,
    meta: EventMeta,
    ctx: AdapterContext
  ): Promise<HookOutcome> {
    const taskId = ctx.sessions.current(this.id, meta.sessionId)
    return this.arbitrate(payload, meta, ctx, taskId)
  }

  /** 远程放行的核心路径：上报 → 挂起等决策 → 按方言组装决策回写 */
  private async arbitrate(
    payload: HookPayload,
    meta: EventMeta,
    ctx: AdapterContext,
    taskId: string
  ): Promise<HookOutcome> {
    const { build, label, authMode } = this.dialect
    const toolName = payload.tool_name ?? payload.llm_tool_name ?? '未知工具'
    const requestText = describeTool(toolName, payload.tool_input)
    const risk = assessRisk(toolName, requestText)
    const denyOnly = authMode === 'deny-only'

    const notes: string[] = []
    if (risk.highRisk) notes.push('这是高危操作，只能在电脑上确认')
    else if (denyOnly) notes.push(`${label} 只支持远程拒绝，放行要回到电脑上操作`)

    ctx.engine.ingest(
      buildEvent({
        agentId: this.id,
        taskId,
        type: 'auth_required',
        title: `${label} 需要你确认`,
        detail: notes.length > 0 ? `${requestText}\n（${notes.join('；')}）` : requestText,
        // 微信上究竟能做什么，决定通知末尾给什么引导语
        authOptions: risk.highRisk ? 'local-only' : denyOnly ? 'deny-only' : 'remote',
        taskMeta: { session_id: meta.sessionId, cwd: meta.cwd },
        source: { hook: meta.eventName, transport: meta.transport, raw: payload }
      })
    )

    const { remoteAuth } = ctx.settings.get()
    if (!remoteAuth.enabled || risk.highRisk) {
      // 不接管决策，交回 Agent 自己的权限流程，用户在电脑上确认
      return build.passthrough(meta.eventName)
    }

    const { request, wait } = ctx.pending.create({
      agentId: this.id,
      taskId,
      toolName,
      requestText,
      highRisk: risk.highRisk,
      highRiskReason: risk.reason,
      // 只能拒绝的家不提供放行按钮，UI 与微信文案据此调整
      denyOnly,
      timeoutMs: remoteAuth.timeoutMs
    })

    const result = await wait
    this.log.info('授权请求决策完成', { id: request.id, decision: result.decision })

    if (result.decision === 'timeout') {
      // 超时不做决策，交回本机确认，绝不代替用户点同意
      return build.passthrough(meta.eventName)
    }

    if (result.decision === 'allow') {
      ctx.engine.ingest(
        buildEvent({
          agentId: this.id,
          taskId,
          type: 'task_progress',
          title: denyOnly ? '已放开阻断' : '已远程放行',
          detail: denyOnly
            ? `你在微信里同意了，但 ${label} 仍需你在电脑上点确认：${requestText}`
            : `你在微信里放行了：${requestText}`,
          taskMeta: { session_id: meta.sessionId, cwd: meta.cwd },
          source: { hook: meta.eventName, transport: 'internal', raw: null }
        })
      )
      return build.allow(meta.eventName)
    }

    return build.deny(meta.eventName, DENIED_MESSAGE)
  }

  private onNotification(
    payload: HookPayload,
    meta: EventMeta,
    ctx: AdapterContext
  ): HookOutcome {
    const taskId = ctx.sessions.current(this.id, meta.sessionId)
    const message = payload.message ?? ''
    // 通知里既有「需要确认」也有「闲置提醒」，按类型字段优先、文案兜底
    const type = payload.notification_type ?? ''
    const needsUser =
      /permission/i.test(type) || /permission|approve|confirm|waiting|需要|确认/i.test(message)

    ctx.engine.ingest(
      buildEvent({
        agentId: this.id,
        taskId,
        type: needsUser ? 'auth_required' : 'task_progress',
        title: needsUser ? `${this.dialect.label} 在等你` : `${this.dialect.label} 有新提示`,
        detail: message,
        taskMeta: { session_id: meta.sessionId, cwd: meta.cwd },
        source: { hook: meta.eventName, transport: meta.transport, raw: payload }
      })
    )
    return {}
  }

  /** 透传注入点：一轮结束时把排队的用户消息塞回对话 */
  private onTurnEnd(payload: HookPayload, meta: EventMeta, ctx: AdapterContext): HookOutcome {
    const taskId = ctx.sessions.current(this.id, meta.sessionId)
    const inject = this.dialect.build.inject

    // stop_hook_active 为真说明这一轮本身就是被钩子续上的，
    // 再阻断会撞上各家的连续阻断上限（Trae 还有 loop_limit），直接放行
    if (inject && !payload.stop_hook_active) {
      const queued = ctx.relay.take(this.id, taskId)
      if (queued) {
        ctx.relay.markAwaitingReply(taskId)
        ctx.engine.ingest(
          buildEvent({
            agentId: this.id,
            taskId,
            type: 'task_progress',
            title: `已把你的消息转达给 ${this.dialect.label}`,
            detail: queued.text,
            taskMeta: { session_id: meta.sessionId, cwd: meta.cwd },
            source: { hook: meta.eventName, transport: meta.transport, raw: payload }
          })
        )
        return inject(queued.text)
      }
    }

    const reply = payload.last_assistant_message?.trim()
    // 如果这一轮是在回答用户从微信发来的话，就把原文回传，而不是当成任务摘要
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
        taskMeta: { session_id: meta.sessionId, cwd: meta.cwd, last_assistant_message: reply },
        source: { hook: meta.eventName, transport: meta.transport, raw: payload }
      })
    )
    return {}
  }

  private onFailure(payload: HookPayload, meta: EventMeta, ctx: AdapterContext): HookOutcome {
    const taskId = ctx.sessions.current(this.id, meta.sessionId)
    ctx.engine.ingest(
      buildEvent({
        agentId: this.id,
        taskId,
        type: 'task_failed',
        title: '任务失败',
        detail: payload.error ?? payload.reason ?? payload.message ?? '执行过程中出错了。',
        taskMeta: { session_id: meta.sessionId, cwd: meta.cwd },
        source: { hook: meta.eventName, transport: meta.transport, raw: payload }
      })
    )
    return {}
  }

  private onSessionEnd(payload: HookPayload, meta: EventMeta, ctx: AdapterContext): HookOutcome {
    const taskId = ctx.sessions.current(this.id, meta.sessionId)
    const task = ctx.store.tasks.get(taskId)
    // 一轮结束时已经收尾过就不重复上报，避免状态机拒绝迁移
    if (!task || task.status === 'COMPLETED' || task.status === 'FAILED') return {}

    ctx.engine.ingest(
      buildEvent({
        agentId: this.id,
        taskId,
        type: 'task_completed',
        title: '会话结束',
        detail: `会话已结束（${payload.reason ?? '未知原因'}）。`,
        taskMeta: { session_id: meta.sessionId, cwd: meta.cwd },
        source: { hook: meta.eventName, transport: meta.transport, raw: payload }
      })
    )
    return {}
  }

  /** 透传兜底：少数家支持无头续会话 */
  async sendHeadless(
    text: string,
    options: { sessionId?: string; cwd?: string }
  ): Promise<boolean> {
    if (!this.dialect.headlessBin) return false
    const binary = await which(this.dialect.headlessBin)
    if (!binary) return false

    const args = options.sessionId ? ['-p', text, '--resume', options.sessionId] : ['-p', text]
    try {
      await promisify(execFile)(binary, args, { cwd: options.cwd, timeout: 10 * 60 * 1000 })
      return true
    } catch (err) {
      this.log.warn('无头执行失败', String(err))
      return false
    }
  }

  async detect(): Promise<DetectResult> {
    const { bins, dirs, apps, processes } = this.dialect.detect
    const evidence: string[] = []

    let binary: string | null = null
    for (const bin of bins) {
      binary = await findBinary(bin)
      if (binary) {
        evidence.push(`找到可执行文件 ${binary}`)
        break
      }
    }

    // IDE 类的几家不在 PATH 上，得按安装惯例找应用本体
    const appPath = anyPathExists((apps ?? []).flatMap(appInstallPaths))
    if (appPath) evidence.push(`找到应用 ${appPath}`)

    const configDir = anyPathExists(dirs)
    if (configDir) evidence.push(`找到配置目录 ${configDir}`)

    // 目录里有近期读写，说明它确实在用——比 PATH 上有没有可执行文件更可信
    const active = Boolean(configDir) && isRecentlyActive(configDir!)
    if (active) evidence.push('配置目录最近有使用记录')

    const running = processes.length > 0 ? await isProcessRunning(processes) : false
    if (running) evidence.push('检测到正在运行的进程')

    const found = Boolean(binary) || Boolean(appPath)
    return {
      installed: found || Boolean(configDir) || existsSync(this.dialect.configFile),
      running,
      // 只剩一个没动静的配置目录，才算卸载残留
      configOnly: !found && Boolean(configDir) && !active,
      evidence
    }
  }
}
