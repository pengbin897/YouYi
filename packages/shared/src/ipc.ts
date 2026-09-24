/** 主进程 ↔ 渲染进程 IPC 契约 */

import type { AgentId, CapabilityLevel } from './agents.js'
import type { UnifiedEvent } from './events.js'
import type { AppSettings } from './settings.js'
import type { AuditLog, PendingAuth, Task } from './task.js'

export const IPC = {
  // 查询
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  getTasks: 'tasks:list',
  getTaskDetail: 'tasks:detail',
  getAuditLogs: 'audit:list',
  getDiscovery: 'discovery:scan',
  getAgentStates: 'agents:states',
  getPendingAuths: 'auth:pending',
  getChannelStates: 'channels:states',

  // 动作
  enableAgents: 'agents:enable',
  addManualAgent: 'agents:add-manual',
  resolveAuth: 'auth:resolve',
  muteTask: 'tasks:mute',
  /** 会话续聊（v1.1）：把用户消息送进选中任务的会话 */
  sendTaskMessage: 'tasks:send-message',
  getConversation: 'tasks:conversation',
  bindWechat: 'channels:bind-wechat',
  /** 微信登录时服务端要求的配对码，由界面输入后回填给 SDK */
  submitVerifyCode: 'channels:verify-code',
  testChannel: 'channels:test',
  exportAudit: 'audit:export',
  clearAllData: 'data:clear',
  openExternal: 'shell:open-external',
  finishOnboarding: 'onboarding:finish',
  quitApp: 'app:quit',

  // 主进程 → 渲染进程推送
  pushTasks: 'push:tasks',
  pushEvent: 'push:event',
  pushAgentStates: 'push:agent-states',
  pushPendingAuths: 'push:pending-auths',
  pushChannelStates: 'push:channel-states',
  pushWechatQr: 'push:wechat-qr',
  pushVerifyCodeRequired: 'push:wechat-verify-code',
  pushToast: 'push:toast'
} as const

/** 自动发现的结果条目（PRD B2） */
export interface DiscoveredAgent {
  id: AgentId
  name: string
  subtitle: string
  level: CapabilityLevel
  /** 已安装（找到 CLI 或应用） */
  installed: boolean
  /** 正在运行（进程存活） */
  running: boolean
  /** 找到配置目录但没找到可执行文件，属于「疑似装过」 */
  configOnly: boolean
  /** 发现依据，UI 上给用户看，避免黑盒感 */
  evidence: string[]
}

/** Agent 的接入运行态 */
export interface AgentRuntimeState {
  id: AgentId
  enabled: boolean
  hookInstalled: boolean
  running: boolean
  level: CapabilityLevel
  lastEventAt?: string
  runningTasks: number
  /** Hook 安装失败或降级的原因 */
  degradedReason?: string
}

export interface ChannelState {
  id: string
  label: string
  enabled: boolean
  /**
   * 已完成登录/接入（微信=扫码登录成功）。
   * 注意与 bound 的区别：微信扫码成功后 loggedIn 即为 true，
   * 但要等用户先发来第一条消息拿到会话上下文后 bound 才为 true。
   * 引导页「连接成功」看 loggedIn，能否主动发通知看 bound。
   */
  loggedIn: boolean
  bound: boolean
  isPrimary: boolean
  /** 连续失败次数，达到 2 次触发降级（PRD E5） */
  consecutiveFailures: number
  lastError?: string
}

export interface ToastPayload {
  kind: 'info' | 'success' | 'warn' | 'error'
  message: string
}

export interface AuthResolution {
  id: string
  decision: 'allow' | 'deny'
  /** 是否写入永久规则，受 remoteAuth.allowPermanentRules 约束 */
  permanent?: boolean
  source: 'wechat' | 'dashboard'
}

/** 会话对话流的一条消息（v1.1 会话续聊）。按会话聚合所有轮次的用户消息与 Agent 回复 */
export interface ChatEntry {
  id: string
  role: 'user' | 'agent' | 'status'
  text: string
  /** ISO 时间 */
  at: string
}

/** sendTaskMessage 的返回：ok 时 via 说明走了哪条投递路径 */
export interface SendTaskMessageResult {
  ok: boolean
  /** stop-hook=会话进行中，消息排队等本轮结束注入；headless=会话已结束，SDK 无头续跑 */
  via?: 'stop-hook' | 'headless'
  error?: string
}

/** preload 暴露给渲染进程的 API 形状 */
export interface YouyiBridgeApi {
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getTasks(): Promise<Task[]>
  getTaskDetail(taskId: string): Promise<{ task: Task; events: UnifiedEvent[] } | null>
  getAuditLogs(limit?: number): Promise<AuditLog[]>
  getDiscovery(): Promise<DiscoveredAgent[]>
  getAgentStates(): Promise<AgentRuntimeState[]>
  getPendingAuths(): Promise<PendingAuth[]>
  getChannelStates(): Promise<ChannelState[]>
  enableAgents(ids: AgentId[]): Promise<AgentRuntimeState[]>
  resolveAuth(resolution: AuthResolution): Promise<void>
  muteTask(taskId: string, muted: boolean): Promise<void>
  sendTaskMessage(taskId: string, text: string): Promise<SendTaskMessageResult>
  /** 该任务所属会话的对话流；任务不存在或没有会话信息时返回 null */
  getConversation(taskId: string): Promise<ChatEntry[] | null>
  bindWechat(): Promise<void>
  submitVerifyCode(code: string): Promise<boolean>
  testChannel(id: string): Promise<{ ok: boolean; error?: string }>
  exportAudit(): Promise<string | null>
  clearAllData(): Promise<void>
  finishOnboarding(): Promise<void>
  openExternal(url: string): Promise<void>
  quitApp(): Promise<void>
  on<T>(channel: string, handler: (payload: T) => void): () => void
}
