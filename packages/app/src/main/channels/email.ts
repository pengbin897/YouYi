/** 邮件兜底渠道（PRD E4）：只下行，主渠道不可用时使用 */

import nodemailer, { type Transporter } from 'nodemailer'
import type { ChannelId, EmailChannelConfig } from '@youyi/shared'
import { createLogger } from '../util/logger.js'
import { MESSAGE_PREFIX, type Channel, type OutboundMessage } from './types.js'

const log = createLogger('email')

export class EmailChannel implements Channel {
  readonly id: ChannelId = 'email'
  readonly supportsInbound = false

  private transporter: Transporter | null = null

  constructor(private config: EmailChannelConfig) {}

  isReady(): boolean {
    return Boolean(this.config.host && this.config.user && this.config.to)
  }

  async start(): Promise<void> {
    if (!this.isReady()) return
    this.transporter = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.pass }
    })
    log.info('邮件兜底渠道已配置', { host: this.config.host })
  }

  async stop(): Promise<void> {
    this.transporter?.close()
    this.transporter = null
  }

  setConfig(config: EmailChannelConfig): void {
    this.config = config
    this.transporter = null
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.isReady()) throw new Error('邮件渠道尚未配置')
    if (!this.transporter) await this.start()

    // 邮件标题取正文首行，方便在收件箱里一眼看出是哪个 Agent 出了什么事
    const firstLine = message.text.split('\n')[0]?.slice(0, 60) ?? '哨兵通知'
    await this.transporter!.sendMail({
      from: this.config.user,
      to: this.config.to,
      subject: `${MESSAGE_PREFIX[message.kind]} ${firstLine}`,
      text: message.text
    })
  }
}
