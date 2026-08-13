/**
 * 桥接协议 —— youyi-hook 与 HookServer 之间的约定。
 *
 * 设计原则：桥接程序保持「哑」的，不含任何厂商逻辑。
 * 它只负责把 stdin 上的原始 JSON 原样转发给哨兵，再把哨兵返回的
 * exit/stdout/stderr 原样落地。各家 Agent 的决策 schema 差异全部由
 * 服务端的适配器组装，这样厂商升级时只需改哨兵、无需重装钩子。
 */

import type { AgentId } from './agents.js'
import type { UnifiedEvent } from './events.js'
import type { PendingAuth, Task } from './task.js'

/** 连接文件路径：~/.youyi/bridge.json，由哨兵启动时写入、退出时删除 */
export const BRIDGE_FILE_NAME = 'bridge.json'
export const BRIDGE_PROTOCOL_VERSION = 1

export interface BridgeConnectionFile {
  version: number
  /** HookServer 监听端口，随机分配 */
  port: number
  /** 请求鉴权 token，每次启动重新生成 */
  token: string
  /** 哨兵主进程 PID，供桥接程序判断进程是否存活 */
  pid: number
  startedAt: string
}

export const HOOK_ENDPOINT = '/hook'
export const HEALTH_ENDPOINT = '/health'
export const TOKEN_HEADER = 'x-youyi-token'

/**
 * 钩子地址里事件名的占位符。
 *
 * Hermes 的出站 webhook 和 OpenClaw 生成的 handler 都是「一个地址收所有事件」，
 * 真实事件名只在请求体里（hook_event_name / type），路径上就用这个占位。
 */
export const AUTO_EVENT = '_auto'

export interface HookRequestEnvelope {
  /** 预注册的 Agent ID，服务端据此校验来源（PRD B1） */
  agentId: string
  /** 厂商原始 hook 事件名 */
  event: string
  /** 厂商原始 payload，原样透传 */
  payload: unknown
  /** 钩子进程的工作目录，部分 Agent 不在 payload 里给 cwd */
  cwd?: string
}

/**
 * 服务端返回给桥接程序的执行指令。
 * exit=0 表示放行，exit=2 表示按该 Agent 的语义阻断/注入，
 * stdout 里通常是厂商特定的决策 JSON（由适配器组装）。
 */
export interface HookDecisionResponse {
  exit: number
  stdout?: string
  stderr?: string
}

/** 哨兵不可达时桥接程序的兜底行为：静默放行，绝不阻断用户的 Agent */
export const FAIL_OPEN_RESPONSE: HookDecisionResponse = { exit: 0 }

// ---------------------------------------------------------------------------
// 本地 CLI 调用协议（设计方案 v0.7 §5.4 / PRD 模块 I）
//
// CLI 与钩子桥接共用同一个回环 HTTP 服务和同一份连接文件（bridge.json），
// 端点路径带 token 鉴权：/cli/:token/state 与 /cli/:token/message。
// 注意 youyi CLI 与桥接程序一样保持零依赖，不 import 本包，
// 这里的类型是给服务端（HookServer / Sentinel）用的契约描述。
// ---------------------------------------------------------------------------

/** CLI 端点的路径前缀，完整路径为 /cli/:token/state 或 /cli/:token/message */
export const CLI_ENDPOINT_PREFIX = 'cli'

/** POST /cli/:token/message 请求体 */
export interface CliMessageRequest {
  /** 用户输入的原文，与微信上行同构（支持「状态」「继续」「交给 X：…」等） */
  text: string
  /** 显式指定透传目标；给出时跳过意图解析，直接走透传 */
  agentId?: string
}

/** POST /cli/:token/message 响应体：路由器对这条消息产生的全部回复 */
export interface CliMessageResponse {
  replies: string[]
}

export interface CliAgentState {
  id: AgentId
  name: string
  enabled: boolean
  runningTasks: number
}

/** GET /cli/:token/state 响应体：给脚本消费的结构化状态快照 */
export interface CliStateSnapshot {
  /** 是否处于值守中（托盘可暂停） */
  watching: boolean
  /** 活跃任务（RUNNING / NEEDS_AUTH / PENDING） */
  tasks: Task[]
  /** 等待用户确认的授权请求 */
  pending: PendingAuth[]
  agents: CliAgentState[]
  recentEvents: UnifiedEvent[]
}
