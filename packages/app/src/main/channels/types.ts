/** 渠道抽象层（PRD 模块 E） */

import type { ChannelId } from '@youyi/shared'

export type OutboundKind =
  /** 事件通知，哨兵自己发出的 */
  | 'notification'
  /** Agent 的回复原样回传 */
  | 'agent-reply'
  /** 哨兵的系统回执，如透传确认、状态自答 */
  | 'system'

export interface OutboundMessage {
  kind: OutboundKind
  text: string
  image?: Buffer
}

export interface InboundMessage {
  /** 消息来源。'cli' 不是通知渠道，是本地命令行入口（设计方案 v0.7 §5.4） */
  channelId: ChannelId | 'cli'
  /** 渠道内的发送者标识，微信下即 userId */
  userId: string
  text: string
  type: 'text' | 'image' | 'voice' | 'file' | 'video'
  receivedAt: string
  raw?: unknown
}

export interface Channel {
  readonly id: ChannelId
  /** 是否支持上行（收消息）。邮件与企微只能下行。 */
  readonly supportsInbound: boolean
  isReady(): boolean
  start(): Promise<void>
  stop(): Promise<void>
  send(message: OutboundMessage): Promise<void>
}

/**
 * 微信没有卡片按钮，通知和 Agent 回复混在同一个对话流里很容易分不清谁在说话，
 * 因此用固定前缀区分（PRD E1 验收）。
 */
export const MESSAGE_PREFIX: Record<OutboundKind, string> = {
  notification: '【哨兵通知】',
  'agent-reply': '【Agent 回复】',
  system: '【哨兵】'
}

export function decorate(message: OutboundMessage): string {
  return `${MESSAGE_PREFIX[message.kind]}\n${message.text}`
}
