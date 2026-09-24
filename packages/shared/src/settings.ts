/** 应用设置（PRD F1/F2/F3 + G4） */

import type { AgentId } from './agents.js'

/** 三档打扰（PRD F1） */
export type NotifyTier = 'quiet' | 'standard' | 'full'

export const NOTIFY_TIER_LABEL: Record<NotifyTier, string> = {
  quiet: '安静',
  standard: '标准',
  full: '全量'
}

export const NOTIFY_TIER_DESC: Record<NotifyTier, string> = {
  quiet: '只在失败、需要确认、可能卡住时通知',
  standard: '安静 + 任务完成时通知',
  full: '标准 + 关键进度节点'
}

export type ChannelId = 'wechat' | 'feishu' | 'dingtalk' | 'wecom' | 'email'

export const CHANNEL_LABEL: Record<ChannelId, string> = {
  wechat: '微信',
  feishu: '飞书',
  dingtalk: '钉钉',
  wecom: '企业微信',
  email: '邮件'
}

export interface DndConfig {
  enabled: boolean
  /** "22:00" */
  start: string
  /** "08:00" */
  end: string
}

export interface RemoteAuthConfig {
  /** 微信远程放行总开关 */
  enabled: boolean
  /** 是否允许「永久放行」（写入 Agent 的永久规则）。默认关闭，只允许单次放行 */
  allowPermanentRules: boolean
  /** 挂起等待用户决策的最长时间，超时后交还 Agent 默认流程 */
  timeoutMs: number
  /**
   * 允许在「工具调用前」挂起等确认的 Agent 名单。
   *
   * Trae / Workbuddy / Qoder 没有专用的授权钩子，只能拦在 PreToolUse 上，
   * 而它每次工具调用都会触发。开启后每次写文件或执行命令都会先等你回微信
   * （超时自动转为本机确认），所以默认为空，由用户按需勾选。
   */
  gateToolUseAgents: AgentId[]
}

export interface WebhookChannelConfig {
  enabled: boolean
  url: string
}

export interface EmailChannelConfig {
  enabled: boolean
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  to: string
}

export interface ChannelSettings {
  wechat: { enabled: boolean; boundUserId?: string }
  feishu: WebhookChannelConfig
  dingtalk: WebhookChannelConfig
  wecom: WebhookChannelConfig
  email: EmailChannelConfig
}

export interface AppSettings {
  onboarded: boolean
  notifyTier: NotifyTier
  dnd: DndConfig
  /** 早报推送时间 */
  digestTime: string
  autoLaunch: boolean
  primaryChannel: ChannelId
  /** 主渠道失败后按顺序降级 */
  fallbackChannels: ChannelId[]
  channels: ChannelSettings
  remoteAuth: RemoteAuthConfig
  /** 被用户勾选接入的 Agent */
  enabledAgents: AgentId[]
  /**
   * 自动发现没找到、但用户确认装了的 Agent。
   * 装在非常规位置（自编译、便携版、改过安装路径）时靠这个兜底，
   * 不然用户只能干看着一个灰掉的开关。
   */
  manualAgents: AgentId[]
  /** 卡死判定的全局默认值，单个 Agent 可覆盖 */
  stallTimeoutMs: number
  /** 透传消息在出站队列中的最长等待时间，超时则尝试无头拉起或如实告知用户 */
  relayQueueTimeoutMs: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  onboarded: false,
  notifyTier: 'standard',
  dnd: { enabled: true, start: '22:00', end: '08:00' },
  digestTime: '08:00',
  autoLaunch: false,
  primaryChannel: 'wechat',
  fallbackChannels: ['email'],
  channels: {
    wechat: { enabled: false },
    feishu: { enabled: false, url: '' },
    dingtalk: { enabled: false, url: '' },
    wecom: { enabled: false, url: '' },
    email: {
      enabled: false,
      host: '',
      port: 465,
      secure: true,
      user: '',
      pass: '',
      to: ''
    }
  },
  remoteAuth: {
    enabled: true,
    allowPermanentRules: false,
    timeoutMs: 10 * 60 * 1000,
    gateToolUseAgents: []
  },
  enabledAgents: [],
  manualAgents: [],
  stallTimeoutMs: 30 * 60 * 1000,
  relayQueueTimeoutMs: 90 * 1000
}
