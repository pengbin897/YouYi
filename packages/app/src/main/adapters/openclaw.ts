/**
 * OpenClaw 适配器（能力 L1：只能通知，不能远程放行，也不能透传）。
 *
 * OpenClaw 的内部钩子既不是 shell 命令也不是 webhook，而是 in-process 的 TypeScript
 * handler。所以这里的安装方式和其余六家都不同：我们**生成一份 handler.ts**，让它在
 * OpenClaw 进程里把事件 POST 回本地 HookServer。
 *
 * 由此带来的能力天花板要如实告知用户：
 * - internal hook 的返回值不参与决策，拿不到同步窗口，因此无法远程放行；
 * - 也没有「一轮结束前注入新指令」的位置（能改决策的是 typed plugin hook，
 *   那要求我们以插件形式注册进 OpenClaw，属于侵入式安装，不在值守工具的边界内）。
 * - 但 `message:sent` 带着 Agent 的回复原文，所以「Agent 说了什么」能推给微信，
 *   只是单向的。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AUTO_EVENT, type AgentId } from '@youyi/shared'
import { buildEvent } from '../engine/event-factory.js'
import type { HookOutcome, HookRequest } from '../hook-server/server.js'
import { anyPathExists, findBinary, isProcessRunning } from '../util/process-scan.js'
import { createLogger } from '../util/logger.js'
import { summarize } from './base/describe.js'
import { backupFile, readJsonFile, writeJsonFile } from './base/json-config.js'
import type { AdapterContext, AgentAdapter, DetectResult, InstallResult } from './types.js'

const log = createLogger('openclaw')

const OPENCLAW_DIR = join(homedir(), '.openclaw')
const HOOK_NAME = 'youyi-sentinel'
const HOOK_DIR = join(OPENCLAW_DIR, 'hooks', HOOK_NAME)

/** 文档没写主配置文件叫什么，按常见命名依次探测 */
const CONFIG_CANDIDATES = [
  join(OPENCLAW_DIR, 'config.json'),
  join(OPENCLAW_DIR, 'config.jsonc'),
  join(OPENCLAW_DIR, 'openclaw.json')
]

const SUBSCRIBED_EVENTS = [
  'message:received',
  'message:sent',
  'session:auto-reset',
  'command:new',
  'command:reset'
]

interface OpenClawConfig {
  hooks?: {
    internal?: {
      enabled?: boolean
      entries?: Record<string, { enabled?: boolean; env?: Record<string, string> }>
    }
  }
  [key: string]: unknown
}

interface OpenClawEvent {
  type?: string
  action?: string
  sessionKey?: string
  timestamp?: string
  context?: Record<string, unknown>
}

export class OpenClawAdapter implements AgentAdapter {
  readonly id: AgentId = 'openclaw'

  async install(ctx: AdapterContext): Promise<InstallResult> {
    const url = ctx.hookUrl(this.id, AUTO_EVENT)
    mkdirSync(HOOK_DIR, { recursive: true })

    writeFileSync(join(HOOK_DIR, 'HOOK.md'), buildHookManifest(), 'utf8')
    writeFileSync(join(HOOK_DIR, 'handler.ts'), buildHandlerSource(url), 'utf8')

    const configFile = CONFIG_CANDIDATES.find((f) => existsSync(f))
    const touched = [join(HOOK_DIR, 'HOOK.md'), join(HOOK_DIR, 'handler.ts')]
    let degradedReason =
      'OpenClaw 的内部钩子拿不到同步决策窗口，只能收通知，无法在微信里放行或对话。'

    if (configFile) {
      const config = readJsonFile<OpenClawConfig>(configFile) ?? {}
      backupFile(configFile, 'openclaw-config-install')
      writeJsonFile(configFile, {
        ...config,
        hooks: {
          ...(config.hooks ?? {}),
          internal: {
            ...(config.hooks?.internal ?? {}),
            // 不显式打开这个开关，OpenClaw 会整体跳过内部钩子的发现流程
            enabled: true,
            entries: {
              ...(config.hooks?.internal?.entries ?? {}),
              [HOOK_NAME]: { enabled: true }
            }
          }
        }
      })
      touched.push(configFile)
    } else {
      degradedReason += ' 另外没找到 OpenClaw 的配置文件，需要你手动把这个钩子启用起来。'
    }

    log.info('OpenClaw 钩子已写入', { dir: HOOK_DIR, config: configFile ?? '未找到' })
    return { ok: true, touchedFiles: touched, degradedReason }
  }

  async uninstall(): Promise<void> {
    rmSync(HOOK_DIR, { recursive: true, force: true })

    const configFile = CONFIG_CANDIDATES.find((f) => existsSync(f))
    if (!configFile) return

    const config = readJsonFile<OpenClawConfig>(configFile)
    const entries = config?.hooks?.internal?.entries
    if (!entries?.[HOOK_NAME]) return

    backupFile(configFile, 'openclaw-config-uninstall')
    const rest = { ...entries }
    delete rest[HOOK_NAME]
    writeJsonFile(configFile, {
      ...config,
      hooks: {
        ...config?.hooks,
        internal: { ...config?.hooks?.internal, entries: rest }
      }
    })
    log.info('OpenClaw 钩子已移除')
  }

  async handle(req: HookRequest, ctx: AdapterContext): Promise<HookOutcome> {
    const payload = req.payload as OpenClawEvent
    const event = payload.type ?? ''
    const context = payload.context ?? {}
    // OpenClaw 用 sessionKey 标识会话，没有 session_id
    const sessionId = payload.sessionKey ?? 'unknown'
    const cwd = typeof context.workspaceDir === 'string' ? context.workspaceDir : req.cwd

    switch (event) {
      case 'message:received': {
        const taskId = ctx.sessions.startTurn(this.id, sessionId)
        const text = typeof context.content === 'string' ? context.content.trim() : ''
        ctx.engine.ingest(
          buildEvent({
            agentId: this.id,
            taskId,
            type: 'task_started',
            title: '开始新任务',
            detail: text.slice(0, 200),
            taskMeta: {
              task_title: summarize(text),
              session_id: sessionId,
              cwd,
              started_at: new Date().toISOString()
            },
            source: { hook: event, transport: req.transport, raw: payload }
          })
        )
        return { exit: 0 }
      }

      case 'message:sent': {
        const taskId = ctx.sessions.current(this.id, sessionId)
        const reply = typeof context.content === 'string' ? context.content.trim() : ''
        // success 为 false 说明这条回复根本没送出去，算失败而不是完成
        const failed = context.success === false

        if (reply && ctx.relay.consumeAwaitingReply(taskId)) {
          ctx.notifyAgentReply(this.id, reply)
        }

        ctx.engine.ingest(
          buildEvent({
            agentId: this.id,
            taskId,
            type: failed ? 'task_failed' : 'task_completed',
            title: failed ? '回复发送失败' : '任务完成',
            detail: failed ? String(context.error ?? '回复没能送出去。') : reply || '这一轮已经结束。',
            taskMeta: { session_id: sessionId, cwd, last_assistant_message: reply || undefined },
            source: { hook: event, transport: req.transport, raw: payload }
          })
        )
        return { exit: 0 }
      }

      case 'session:auto-reset':
      case 'command:new':
      case 'command:reset': {
        const taskId = ctx.sessions.current(this.id, sessionId)
        const task = ctx.store.tasks.get(taskId)
        if (!task || task.status === 'COMPLETED' || task.status === 'FAILED') return { exit: 0 }
        ctx.engine.ingest(
          buildEvent({
            agentId: this.id,
            taskId,
            type: 'task_completed',
            title: '会话已重置',
            detail: `会话被重置（${String(context.reason ?? payload.action ?? event)}）。`,
            taskMeta: { session_id: sessionId, cwd },
            source: { hook: event, transport: req.transport, raw: payload }
          })
        )
        return { exit: 0 }
      }

      default:
        return { exit: 0 }
    }
  }

  async detect(): Promise<DetectResult> {
    const evidence: string[] = []
    const binary = await findBinary('openclaw')
    if (binary) evidence.push(`找到可执行文件 ${binary}`)

    const configDir = anyPathExists([OPENCLAW_DIR])
    if (configDir) evidence.push(`找到配置目录 ${configDir}`)

    const running = await isProcessRunning(['openclaw'])
    if (running) evidence.push('检测到正在运行的进程')

    return {
      installed: Boolean(binary) || Boolean(configDir),
      running,
      configOnly: !binary && Boolean(configDir),
      evidence
    }
  }
}

function buildHookManifest(): string {
  const metadata = {
    openclaw: {
      emoji: '📡',
      events: SUBSCRIBED_EVENTS,
      requires: {}
    }
  }
  return `name: ${HOOK_NAME}
description: "游奕值守：把会话事件转发到本机的游奕客户端"
metadata: ${JSON.stringify(metadata)}

# 游奕值守钩子

由游奕（多 Agent 值守中控）自动生成，请不要手工修改。

它只做一件事：把 OpenClaw 的会话事件 POST 到本机回环地址上的游奕端点，
用于在微信上收任务通知。不读取也不改写任何会话内容。

要停用请在游奕的设置里取消勾选 OpenClaw，或直接删掉这个目录。
`
}

/**
 * 生成注入进 OpenClaw 进程的 handler。
 *
 * 三条硬约束：
 * - 零依赖：只能用运行时自带的 fetch，不能 import 任何东西；
 * - 绝不抛异常：这段代码跑在用户的 Agent 进程里，我们的问题不能变成他的故障；
 * - 绝不阻塞：不 await 网络请求的结果，钩子必须立刻返回。
 */
function buildHandlerSource(url: string): string {
  return `// 由游奕自动生成，请不要手工修改。重新安装钩子时会被覆盖。
const YOUYI_ENDPOINT = ${JSON.stringify(url)}

export default async function handle(event: unknown): Promise<void> {
  try {
    // 不 await：值守应用不该拖慢用户的 Agent，送不到就算了
    void fetch(YOUYI_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event)
    }).catch(() => undefined)
  } catch {
    // 任何异常都咽掉：宁可丢一条通知，也不能影响 OpenClaw 本身
  }
}
`
}
