/**
 * 群机器人 webhook 渠道：飞书 / 钉钉 / 企业微信（PRD E2、E3）。
 *
 * 说明一个能力边界：这三家的「群内消息上行」需要一个公网可达的回调地址，
 * 而哨兵是纯本地应用，没有公网入口。因此这里只实现下行通知，
 * supportsInbound 如实标为 false，UI 上也照此标注，不做能力夸大。
 */

import type { ChannelId } from '@youyi/shared'
import { createLogger } from '../util/logger.js'
import { decorate, type Channel, type OutboundMessage } from './types.js'

const log = createLogger('webhook')

const SEND_TIMEOUT_MS = 10_000

type WebhookFlavor = 'feishu' | 'dingtalk' | 'wecom'

function buildBody(flavor: WebhookFlavor, text: string): unknown {
  switch (flavor) {
    case 'feishu':
      return { msg_type: 'text', content: { text } }
    case 'dingtalk':
      return { msgtype: 'text', text: { content: text } }
    case 'wecom':
      return { msgtype: 'text', text: { content: text } }
  }
}

/** 三家都用 HTTP 200 + 业务错误码的形式返回失败，必须解析响应体才能判断真实结果 */
function extractError(flavor: WebhookFlavor, body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const data = body as Record<string, unknown>
  switch (flavor) {
    case 'feishu': {
      const code = data.code ?? data.StatusCode
      if (typeof code === 'number' && code !== 0) return String(data.msg ?? data.StatusMessage ?? code)
      return null
    }
    case 'dingtalk':
    case 'wecom': {
      const code = data.errcode
      if (typeof code === 'number' && code !== 0) return String(data.errmsg ?? code)
      return null
    }
  }
}

export class WebhookChannel implements Channel {
  readonly supportsInbound = false

  constructor(
    readonly id: ChannelId,
    private readonly flavor: WebhookFlavor,
    private url: string
  ) {}

  isReady(): boolean {
    return this.url.startsWith('https://')
  }

  async start(): Promise<void> {
    // webhook 无需保持连接
  }

  async stop(): Promise<void> {
    // 无资源需要释放
  }

  setUrl(url: string): void {
    this.url = url
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.isReady()) throw new Error(`${this.id} 的 webhook 地址无效`)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildBody(this.flavor, decorate(message))),
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const body = await response.json().catch(() => null)
      const error = extractError(this.flavor, body)
      if (error) throw new Error(error)
    } finally {
      clearTimeout(timer)
    }
  }
}

export function createWebhookChannel(id: ChannelId, url: string): WebhookChannel {
  const flavor: WebhookFlavor =
    id === 'feishu' ? 'feishu' : id === 'dingtalk' ? 'dingtalk' : 'wecom'
  log.debug('创建 webhook 渠道', { id, flavor })
  return new WebhookChannel(id, flavor, url)
}
