/**
 * 渠道管理器：统一发送入口 + 主备降级（PRD E5）。
 *
 * 降级策略：主渠道连续 2 次发送失败即切到备选，并明确告知用户「微信不可用，已邮件通知」。
 * 切走之后不是永久放弃——每隔一段冷却时间会再试一次主渠道，成功即自动切回，
 * 避免用户在主渠道恢复后还要手动去设置里点一下。
 */

import { EventEmitter } from 'node:events'
import { CHANNEL_LABEL, type ChannelId, type ChannelState } from '@youyi/shared'
import type { SettingsStore } from '../config/settings-store.js'
import type { Store } from '../store/types.js'
import { createLogger } from '../util/logger.js'
import { EmailChannel } from './email.js'
import { WechatChannel } from './wechat.js'
import { createWebhookChannel, type WebhookChannel } from './webhook.js'
import type { Channel, InboundMessage, OutboundMessage } from './types.js'

const log = createLogger('channels')

/** 主渠道连续失败到这个次数就降级 */
const FAILURE_THRESHOLD = 2
/** 降级后每隔多久回头试一次主渠道 */
const RECOVERY_COOLDOWN_MS = 5 * 60 * 1000

export interface SendReport {
  ok: boolean
  channel?: ChannelId
  degraded: boolean
  error?: string
}

export declare interface ChannelManager {
  on(event: 'inbound', listener: (message: InboundMessage) => void): this
  on(event: 'wechat-qr', listener: (url: string) => void): this
  on(event: 'wechat-status', listener: (status: string) => void): this
  on(event: 'verify-code-required', listener: (isRetry: boolean) => void): this
  on(event: 'state-changed', listener: () => void): this
}

export class ChannelManager extends EventEmitter {
  private readonly channels = new Map<ChannelId, Channel>()
  private readonly failures = new Map<ChannelId, number>()
  private readonly lastError = new Map<ChannelId, string>()
  private degradedSince: number | null = null
  private verifyCodeResolver: ((code: string) => void) | null = null

  constructor(
    private readonly settings: SettingsStore,
    private readonly store: Store
  ) {
    super()
  }

  async start(): Promise<void> {
    const config = this.settings.get().channels

    if (config.wechat.enabled) {
      await this.startWechat(config.wechat.boundUserId).catch((err) =>
        log.warn('微信渠道启动失败，稍后可在设置里重新绑定', String(err))
      )
    }

    for (const id of ['feishu', 'dingtalk', 'wecom'] as const) {
      const entry = config[id]
      if (entry.enabled && entry.url) {
        this.channels.set(id, createWebhookChannel(id, entry.url))
      }
    }

    if (config.email.enabled) {
      const email = new EmailChannel(config.email)
      await email.start()
      this.channels.set('email', email)
    }

    log.info('渠道层已启动', { channels: [...this.channels.keys()] })
  }

  /**
   * 启动微信渠道并驱动扫码登录流程。
   *
   * 已存在同一个渠道实例时直接复用、重新调用 start()，而不是丢掉重建——
   * 否则会话过期后旧实例里挂的 session:expired/自愈逻辑就跟丢了一样，
   * "重新绑定"按钮点了也没用。这里统一传 force=true 强制重新走扫码，
   * 避免复用到本地那份已经失效的旧凭据，原地空转报错。
   */
  async startWechat(boundUserId?: string): Promise<void> {
    const existing = this.channels.get('wechat')
    if (existing instanceof WechatChannel) {
      if (existing.isRunning) return
      await existing.start(true)
      this.emit('wechat-status', 'ready')
      this.emit('state-changed')
      return
    }

    const channel = new WechatChannel(
      {
        onQrUrl: (url) => this.emit('wechat-qr', url),
        onScanned: () => this.emit('wechat-status', 'scanned'),
        onExpired: () => this.emit('wechat-status', 'expired'),
        onVerifyCode: (isRetry) => this.requestVerifyCode(isRetry),
        onInbound: (message) => this.emit('inbound', message),
        onBound: (userId) => {
          const channels = this.settings.get().channels
          this.settings.patch({
            channels: { ...channels, wechat: { enabled: true, boundUserId: userId } }
          })
          this.emit('state-changed')
        }
      },
      boundUserId
    )
    // 会话过期后渠道内部会自愈（丢弃旧连接、强制重新扫码），这里只负责把状态透传给界面
    channel.on('session-expired', () => this.emit('wechat-status', 'session-expired'))

    this.channels.set('wechat', channel)
    await channel.start()
    this.emit('wechat-status', 'ready')
    this.emit('state-changed')
  }

  private requestVerifyCode(isRetry: boolean): Promise<string> {
    // SDK 默认从 stdin 读配对码，Electron 主进程没有可交互的 stdin，改由界面输入
    this.emit('verify-code-required', isRetry)
    return new Promise<string>((resolve) => {
      this.verifyCodeResolver = resolve
    })
  }

  submitVerifyCode(code: string): boolean {
    if (!this.verifyCodeResolver) return false
    this.verifyCodeResolver(code)
    this.verifyCodeResolver = null
    return true
  }

  /**
   * 统一发送。返回哪个渠道发成功了，以及是否处于降级状态。
   */
  async send(message: OutboundMessage): Promise<SendReport> {
    const order = this.resolveSendOrder()
    if (order.length === 0) {
      return { ok: false, degraded: false, error: '没有任何可用渠道' }
    }

    const primary = this.settings.get().primaryChannel
    for (const id of order) {
      const channel = this.channels.get(id)
      if (!channel?.isReady()) continue

      // 主渠道给两次机会，符合「重试 2 次失败转降级」的验收
      const attempts = id === primary ? FAILURE_THRESHOLD : 1
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const payload =
            id !== primary && this.degradedSince !== null
              ? {
                  ...message,
                  text: `${CHANNEL_LABEL[primary]}不可用，已改用${CHANNEL_LABEL[id]}通知你。\n\n${message.text}`
                }
              : message

          await channel.send(payload)

          this.failures.set(id, 0)
          this.lastError.delete(id)
          if (id === primary && this.degradedSince !== null) {
            this.degradedSince = null
            log.info('主渠道已恢复')
            this.emit('state-changed')
          }
          this.audit(message, id, true)
          return { ok: true, channel: id, degraded: this.degradedSince !== null }
        } catch (err) {
          const reason = String(err instanceof Error ? err.message : err)
          this.failures.set(id, (this.failures.get(id) ?? 0) + 1)
          this.lastError.set(id, reason)
          log.warn('渠道发送失败', { channel: id, attempt, reason })
          if (attempt < attempts) await delay(1000 * attempt)
        }
      }

      if (id === primary && (this.failures.get(id) ?? 0) >= FAILURE_THRESHOLD) {
        if (this.degradedSince === null) {
          this.degradedSince = Date.now()
          log.warn('主渠道连续失败，已切换到备选渠道')
          this.emit('state-changed')
        }
      }
    }

    this.audit(message, order[0], false)
    return {
      ok: false,
      degraded: this.degradedSince !== null,
      error: this.lastError.get(order[0]) ?? '所有渠道均发送失败'
    }
  }

  /** 决定尝试顺序：正常时主渠道优先；降级期内先走备选，冷却到点再回头试主渠道 */
  private resolveSendOrder(): ChannelId[] {
    const settings = this.settings.get()
    const primary = settings.primaryChannel
    const fallbacks = settings.fallbackChannels.filter((id) => id !== primary)

    const inCooldown =
      this.degradedSince !== null && Date.now() - this.degradedSince < RECOVERY_COOLDOWN_MS

    const order = inCooldown ? [...fallbacks, primary] : [primary, ...fallbacks]
    return order.filter((id) => this.channels.has(id))
  }

  private audit(message: OutboundMessage, channel: ChannelId | undefined, ok: boolean): void {
    this.store.audit.append({
      action: 'notify',
      channel,
      summary: message.text.split('\n')[0]?.slice(0, 80) ?? '',
      result: ok ? 'success' : 'failed'
    })
  }

  async test(id: ChannelId): Promise<{ ok: boolean; error?: string }> {
    const channel = this.channels.get(id)
    if (!channel) return { ok: false, error: '该渠道尚未配置' }
    try {
      await channel.send({
        kind: 'system',
        text: '这是一条来自游奕哨兵的测试消息，收到说明渠道已经通了。'
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) }
    }
  }

  getStates(): ChannelState[] {
    const settings = this.settings.get()
    const ids: ChannelId[] = ['wechat', 'feishu', 'dingtalk', 'wecom', 'email']
    return ids.map((id) => {
      const channel = this.channels.get(id)
      return {
        id,
        label: CHANNEL_LABEL[id],
        enabled: Boolean(channel),
        bound: channel?.isReady() ?? false,
        isPrimary: settings.primaryChannel === id,
        consecutiveFailures: this.failures.get(id) ?? 0,
        lastError: this.lastError.get(id)
      }
    })
  }

  /** 设置变更后重建渠道实例 */
  async reload(): Promise<void> {
    await this.stop()
    this.channels.clear()
    await this.start()
  }

  get isDegraded(): boolean {
    return this.degradedSince !== null
  }

  async stop(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.stop().catch(() => undefined)
    }
  }

  getWebhook(id: ChannelId): WebhookChannel | undefined {
    const channel = this.channels.get(id)
    return channel && 'setUrl' in channel ? (channel as WebhookChannel) : undefined
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
