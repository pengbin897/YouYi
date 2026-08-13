/**
 * Agent 适配层接口。
 *
 * 每个适配器负责三件事，且只负责这三件事：
 * 1. install/uninstall —— 把钩子写进该 Agent 的配置文件（非破坏性合并 + 可精确回滚）
 * 2. handle —— 把厂商原始事件归一化成 UnifiedEvent，并按厂商 schema 组装决策响应
 * 3. detect —— 判断本机是否安装/运行该 Agent
 *
 * 厂商差异全部收敛在这一层，上层（引擎、路由器、通知管家）只看统一模型。
 */

import type { AgentId } from '@youyi/shared'
import type { HookOutcome, HookRequest } from '../hook-server/server.js'
import type { EventEngine } from '../engine/event-engine.js'
import type { SessionTracker } from '../engine/session-tracker.js'
import type { PendingDecisionArbiter } from '../hook-server/pending-decisions.js'
import type { RelayQueue } from '../router/relay-queue.js'
import type { SettingsStore } from '../config/settings-store.js'
import type { Store } from '../store/types.js'

export interface AdapterContext {
  engine: EventEngine
  store: Store
  settings: SettingsStore
  pending: PendingDecisionArbiter
  relay: RelayQueue
  sessions: SessionTracker
  /** 生成原生 HTTP 钩子要用的回调地址 */
  hookUrl(agentId: AgentId, event: string): string
  /** 桥接程序的可执行路径（绝对路径；部分 Agent 不做 ~ 展开） */
  bridgeCommand(): string
  /** 把 Agent 对用户上一条透传消息的回复原样送回渠道（PRD D3） */
  notifyAgentReply(agentId: AgentId, text: string): void
}

export interface InstallResult {
  ok: boolean
  /** 安装过程中的降级说明，如「未找到配置目录，已回退日志监控」 */
  degradedReason?: string
  /** 被修改的文件，UI 上对用户透明 */
  touchedFiles: string[]
}

export interface DetectResult {
  installed: boolean
  running: boolean
  /** 只找到配置目录、没找到可执行文件 */
  configOnly: boolean
  /** 判定依据，展示给用户避免黑盒感 */
  evidence: string[]
}

export interface AgentAdapter {
  readonly id: AgentId
  install(ctx: AdapterContext): Promise<InstallResult>
  uninstall(ctx: AdapterContext): Promise<void>
  handle(req: HookRequest, ctx: AdapterContext): Promise<HookOutcome>
  detect(): Promise<DetectResult>
  /**
   * 无头拉起一轮新会话，透传的兜底路径。
   * 只有少数 Agent 支持（如 Claude Code 的 -p --resume）。
   */
  sendHeadless?(text: string, options: { sessionId?: string; cwd?: string }): Promise<boolean>
}
