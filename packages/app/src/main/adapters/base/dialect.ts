/**
 * 「Claude 系」方言表。
 *
 * Claude Code / Codex / Workbuddy / Qoder / Trae 这五家的钩子机制高度同构：
 * 配置都是 JSON、都按 `hooks: { 事件名: [{ matcher, hooks: [...] }] }` 组织、
 * stdin 都收同一批字段（session_id / cwd / tool_name / tool_input / prompt）。
 * 差异只集中在四处：配置文件位置、事件名、决策 JSON 的形状、以及授权闸门装在哪。
 *
 * 所以这里只描述差异，归一化与决策流程由 JsonHooksAdapter 统一实现，
 * 避免把同一套逻辑抄五遍——抄五遍意味着以后修 bug 要修五处。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentId } from '@youyi/shared'
import type { HookOutcome } from '../../hook-server/server.js'

/** 事件的语义角色。厂商事件名各不相同，但角色是共通的 */
export type HookRole =
  | 'session-start'
  | 'prompt'
  | 'tool-pre'
  | 'permission'
  | 'notification'
  | 'turn-end'
  | 'failure'
  | 'session-end'

export interface DialectEvent {
  /** 厂商自己的事件名，原样写进配置文件 */
  name: string
  role: HookRole
  /** 钩子超时（秒），照各家文档的默认值与上限设置 */
  timeoutSec: number
  matcher?: string
}

/**
 * 远程放行支持程度。UI 必须如实标注，不能把「只能远程拒绝」说成「可远程放行」。
 * - full：能返回 allow，微信回复「继续」可直接放行
 * - deny-only：只能返回阻断，放行必须回到电脑上操作（Qoder / Hermes）
 * - none：拿不到同步决策窗口，只能通知（OpenClaw）
 */
export type AuthMode = 'full' | 'deny-only' | 'none'

export interface HookDialect {
  agentId: AgentId
  /** 通知文案里对这个 Agent 的称呼 */
  label: string
  configFile: string
  /** 新建配置文件时的骨架，例如 Trae 要求 version: 1 */
  fileTemplate?: Record<string, unknown>
  /** 钩子条目形态：原生 HTTP 直连，或走桥接命令 */
  entry: 'http' | 'command'
  events: DialectEvent[]
  authMode: AuthMode
  /**
   * 授权闸门位置：
   * - dedicated：有专用授权事件，只在真正需要确认时才挂起，代价最低
   * - pre-tool：没有专用事件，只能在 PreToolUse 上按「是否改动环境」挑着挂起，
   *   默认关闭（见 remoteAuth.gateToolUseAgents），否则每次写文件都要等微信
   */
  gateAt: 'dedicated' | 'pre-tool'
  /** Stop 组的循环上限字段，仅 Trae 支持，防止注入后无限续跑 */
  loopLimit?: number
  build: {
    /** 远程放行 */
    allow(eventName: string): HookOutcome
    /** 远程拒绝 */
    deny(eventName: string, message: string): HookOutcome
    /** 不接管决策，交回 Agent 自己的确认流程 */
    passthrough(eventName: string): HookOutcome
    /** 把新指令注入回对话；不支持透传的家不提供 */
    inject?(text: string): HookOutcome
  }
  detect: {
    bins: string[]
    dirs: string[]
    /** 图形应用的显示名，按各平台安装惯例去找应用本体 */
    apps?: string[]
    /** 进程命令行关键词 */
    processes: string[]
  }
  /** 支持无头续会话的可执行文件名 */
  headlessBin?: string
}

const home = homedir()

/** Claude / Codex / Workbuddy 共用的授权决策形状：hookSpecificOutput.decision.behavior */
function behaviorDecision(eventName: string, behavior: 'allow' | 'deny', message?: string) {
  return {
    json: {
      hookSpecificOutput: {
        hookEventName: eventName,
        // 只放行这一次：不返回 updatedPermissions / updatedInput，就不会写入永久规则
        decision: message ? { behavior, message } : { behavior }
      }
    }
  }
}

/** Trae 的授权决策形状（PreToolUse 闸门）：hookSpecificOutput.permissionDecision */
function permissionDecision(
  eventName: string,
  decision: 'allow' | 'deny' | 'ask',
  reason: string
): HookOutcome {
  return {
    json: {
      hookSpecificOutput: {
        hookEventName: eventName,
        permissionDecision: decision,
        permissionDecisionReason: reason
      }
    }
  }
}

const ASK_LOCALLY = '游奕未接管这次决策，请在电脑上确认。'
const DENIED_REMOTELY = '你在微信里拒绝了这个操作。'

export const CLAUDE_CODE_DIALECT: HookDialect = {
  agentId: 'claude-code',
  label: 'Claude Code',
  configFile: join(home, '.claude', 'settings.json'),
  // 唯一原生支持 type: "http" 的一家，省掉一次子进程启动
  entry: 'http',
  events: [
    { name: 'SessionStart', role: 'session-start', timeoutSec: 10 },
    { name: 'UserPromptSubmit', role: 'prompt', timeoutSec: 10 },
    { name: 'PreToolUse', role: 'tool-pre', timeoutSec: 10 },
    { name: 'PermissionRequest', role: 'permission', timeoutSec: 320 },
    { name: 'Notification', role: 'notification', timeoutSec: 10 },
    { name: 'Stop', role: 'turn-end', timeoutSec: 20 },
    { name: 'StopFailure', role: 'failure', timeoutSec: 10 },
    { name: 'PostToolUseFailure', role: 'failure', timeoutSec: 10 },
    { name: 'SessionEnd', role: 'session-end', timeoutSec: 10 }
  ],
  authMode: 'full',
  gateAt: 'dedicated',
  build: {
    allow: (e) => behaviorDecision(e, 'allow'),
    deny: (e, m) => behaviorDecision(e, 'deny', m),
    passthrough: () => ({}),
    inject: (text) => ({ json: { decision: 'block', reason: text } })
  },
  detect: {
    bins: ['claude'],
    dirs: [join(home, '.claude')],
    processes: ['claude ']
  },
  headlessBin: 'claude'
}

export const CODEX_DIALECT: HookDialect = {
  agentId: 'chatgpt-codex',
  label: 'Codex',
  configFile: join(home, '.codex', 'hooks.json'),
  // 文档明确：只有 type: "command" 会执行，prompt / agent 会被跳过
  entry: 'command',
  events: [
    { name: 'SessionStart', role: 'session-start', timeoutSec: 10 },
    { name: 'UserPromptSubmit', role: 'prompt', timeoutSec: 10 },
    { name: 'PreToolUse', role: 'tool-pre', timeoutSec: 10 },
    { name: 'PermissionRequest', role: 'permission', timeoutSec: 320 },
    { name: 'Stop', role: 'turn-end', timeoutSec: 20 },
    // SessionEnd 默认 1 秒、最大只允许 3 秒，给多了会被拒
    { name: 'SessionEnd', role: 'session-end', timeoutSec: 3 }
  ],
  authMode: 'full',
  gateAt: 'dedicated',
  build: {
    allow: (e) => behaviorDecision(e, 'allow'),
    deny: (e, m) => behaviorDecision(e, 'deny', m),
    passthrough: () => ({}),
    // Stop 返回 block 时，reason 会被当成一条新的用户 prompt 送进去
    inject: (text) => ({ json: { decision: 'block', reason: text } })
  },
  detect: {
    bins: ['codex'],
    dirs: [join(home, '.codex')],
    apps: ['ChatGPT'],
    processes: ['codex ', 'ChatGPT.app']
  }
}

export const WORKBUDDY_DIALECT: HookDialect = {
  agentId: 'workbuddy',
  label: 'Workbuddy',
  configFile: join(home, '.codebuddy', 'settings.json'),
  entry: 'command',
  events: [
    { name: 'SessionStart', role: 'session-start', timeoutSec: 10 },
    { name: 'UserPromptSubmit', role: 'prompt', timeoutSec: 10 },
    // 没有专用授权事件，闸门只能装在这里
    { name: 'PreToolUse', role: 'tool-pre', timeoutSec: 320 },
    { name: 'Notification', role: 'notification', timeoutSec: 10 },
    { name: 'Stop', role: 'turn-end', timeoutSec: 20 },
    { name: 'PostToolUseFailure', role: 'failure', timeoutSec: 10 },
    { name: 'StopFailure', role: 'failure', timeoutSec: 10 },
    { name: 'SessionEnd', role: 'session-end', timeoutSec: 10 }
  ],
  authMode: 'full',
  gateAt: 'pre-tool',
  build: {
    allow: (e) => permissionDecision(e, 'allow', '你在微信里放行了这次操作。'),
    deny: (e, m) => permissionDecision(e, 'deny', m),
    // ask 会强制弹出本机确认框，比默默放过安全
    passthrough: (e) => permissionDecision(e, 'ask', ASK_LOCALLY),
    // decision: "block" 已废弃，改用 continue: false + reason
    inject: (text) => ({ json: { continue: false, reason: text } })
  },
  detect: {
    bins: ['codebuddy'],
    dirs: [join(home, '.codebuddy')],
    apps: ['CodeBuddy'],
    processes: ['codebuddy']
  }
}

export const QODER_DIALECT: HookDialect = {
  agentId: 'qoder-work',
  label: 'Qoder Work',
  configFile: join(home, '.qoderwork', 'settings.json'),
  entry: 'command',
  events: [
    { name: 'SessionStart', role: 'session-start', timeoutSec: 10 },
    { name: 'UserPromptSubmit', role: 'prompt', timeoutSec: 10 },
    { name: 'PreToolUse', role: 'tool-pre', timeoutSec: 10 },
    { name: 'PermissionRequest', role: 'permission', timeoutSec: 320 },
    { name: 'Notification', role: 'notification', timeoutSec: 10 },
    { name: 'Stop', role: 'turn-end', timeoutSec: 20 },
    { name: 'PostToolUseFailure', role: 'failure', timeoutSec: 10 },
    { name: 'SessionEnd', role: 'session-end', timeoutSec: 10 }
  ],
  // 文档只给了「exit 2 阻断」，没有放行用的 stdout JSON，所以放行做不到
  authMode: 'deny-only',
  gateAt: 'dedicated',
  build: {
    // 退出 0 即不阻断，但 Qoder 仍会按自己的流程要求本机确认
    allow: () => ({ exit: 0 }),
    deny: (_e, m) => ({ exit: 2, stderr: m }),
    passthrough: () => ({ exit: 0 }),
    // Stop 用 exit 2，stderr 会作为消息注入对话并让 Agent 继续
    inject: (text) => ({ exit: 2, stderr: text })
  },
  detect: {
    bins: ['qoder'],
    dirs: [join(home, '.qoderwork'), join(home, '.qoder')],
    apps: ['Qoder'],
    processes: ['qoderwork', 'qoder']
  }
}

export const TRAE_DIALECT: HookDialect = {
  agentId: 'trae-work',
  label: 'Trae Work',
  configFile: join(home, '.trae-cn', 'hooks.json'),
  // 整个文件就是钩子配置，且必须带 version
  fileTemplate: { version: 1 },
  entry: 'command',
  events: [
    { name: 'SessionStart', role: 'session-start', timeoutSec: 10 },
    { name: 'UserPromptSubmit', role: 'prompt', timeoutSec: 10 },
    { name: 'PreToolUse', role: 'tool-pre', timeoutSec: 300 },
    { name: 'Notification', role: 'notification', timeoutSec: 10 },
    { name: 'Stop', role: 'turn-end', timeoutSec: 20 }
  ],
  authMode: 'full',
  gateAt: 'pre-tool',
  // 注入后 Trae 会再触发 Stop，靠 loop_limit 兜住，免得来回续跑
  loopLimit: 3,
  build: {
    allow: (e) => permissionDecision(e, 'allow', '你在微信里放行了这次操作。'),
    deny: (e, m) => permissionDecision(e, 'deny', m),
    passthrough: (e) => permissionDecision(e, 'ask', ASK_LOCALLY),
    // reason 会被当作一条新的 Query 交给智能体
    inject: (text) => ({ json: { decision: 'block', reason: text } })
  },
  detect: {
    bins: ['trae'],
    dirs: [join(home, '.trae-cn'), join(home, '.trae')],
    // 国内版叫 Trae CN，国际版叫 Trae，两个都找
    apps: ['Trae CN', 'Trae'],
    processes: ['trae']
  }
}

export const DENIED_MESSAGE = DENIED_REMOTELY

export const JSON_DIALECTS: HookDialect[] = [
  CLAUDE_CODE_DIALECT,
  CODEX_DIALECT,
  WORKBUDDY_DIALECT,
  QODER_DIALECT,
  TRAE_DIALECT
]
