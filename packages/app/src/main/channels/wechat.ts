/**
 * 微信双向主渠道（PRD E1），基于 @wechatbot/wechatbot 的 iLink SDK。
 *
 * 两个必须处理好的 SDK 约束：
 * 1. `send(userId, ...)` 需要该用户先给机器人发过消息（依赖 context_token），
 *    所以绑定完成后要引导用户先发一句话，否则通知发不出去；
 * 2. 登录时服务端可能要求输入配对码，SDK 默认从 stdin 读，而 Electron 主进程没有
 *    可交互的 stdin，必须改由界面输入。
 */

import { EventEmitter } from 'node:events'
import { WeChatBot, type IncomingMessage, type QrLoginCallbacks } from '@wechatbot/wechatbot'
import type { ChannelId } from '@youyi/shared'
import { PATHS } from '../config/paths.js'
import { createLogger } from '../util/logger.js'
import { decorate, type Channel, type InboundMessage, type OutboundMessage } from './types.js'

const log = createLogger('wechat')

export interface WechatCallbacks {
  /** 二维码地址，交给界面渲染 */
  onQrUrl: (url: string) => void
  onScanned: () => void
  onExpired: () => void
  /** 需要用户在界面上输入配对码 */
  onVerifyCode: (isRetry: boolean) => Promise<string>
  onInbound: (message: InboundMessage) => void
  /** 首次收到用户消息后回填绑定的 userId */
  onBound: (userId: string) => void
}

export class WechatChannel extends EventEmitter implements Channel {
  readonly id: ChannelId = 'wechat'
  readonly supportsInbound = true

  private bot: WeChatBot | null = null
  private running = false
  private targetUserId: string | undefined
  /** 防止 session:expired 在短时间内被多次触发时并发跑出多条重登流程 */
  private recovering = false
  /** start() 尚未落地时的进行中 Promise，防止并发调用（连点按钮/自愈撞车）起出第二个 WeChatBot 实例 */
  private startPromise: Promise<void> | null = null

  constructor(
    private readonly callbacks: WechatCallbacks,
    boundUserId?: string
  ) {
    super()
    this.targetUserId = boundUserId
  }

  isReady(): boolean {
    // 没有对话上下文就发不出主动消息，此时不能算就绪
    return this.running && Boolean(this.targetUserId)
  }

  get isRunning(): boolean {
    return this.running
  }

  /**
   * 启动微信渠道。
   *
   * 注意：`@wechatbot/wechatbot@2.2.0` 里构造函数的 `loginCallbacks` 选项其实是个哑选项——
   * 翻遍它的编译产物，这个字段只出现在类型声明里，登录流程从头到尾都没有读取过它，
   * 必须每次显式调用 `bot.login({ callbacks })` 才能真的收到 onQrUrl 等回调。
   * 首次绑定时能看到二维码，纯粹是因为本地还没有凭据；一旦会话过期需要重新走扫码流程，
   * 这个哑选项的坑就会暴露出来（界面拿不到新二维码，SDK 内部还会用旧 token 无限重试刷屏）。
   *
   * @param forceRelogin 会话过期后重连时传 true，跳过"复用本地已存凭据"，强制重新扫码
   */
  async start(forceRelogin = false): Promise<void> {
    if (this.running) return
    // 已经有一次 start() 在路上（比如按钮连点两下、自愈流程和手动重绑撞在一起），
    // 直接跟它排队而不是另起一个 WeChatBot 实例——两份凭据/游标写同一个存储目录会互相打架
    if (this.startPromise) return this.startPromise

    this.startPromise = this.doStart(forceRelogin)
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async doStart(forceRelogin: boolean): Promise<void> {
    const loginCallbacks: QrLoginCallbacks = {
      onQrUrl: (url) => {
        log.info('等待扫码登录')
        this.callbacks.onQrUrl(url)
      },
      onScanned: () => this.callbacks.onScanned(),
      onExpired: () => this.callbacks.onExpired(),
      onVerifyCode: (isRetry) => this.callbacks.onVerifyCode(isRetry)
    }

    const bot = new WeChatBot({
      storage: 'file',
      storageDir: PATHS.wechat,
      logLevel: 'warn',
      botAgent: 'YouYi-Sentinel/0.1'
    })

    bot.onMessage((msg) => this.handleInbound(msg))
    bot.on('session:expired', () => {
      log.warn('微信会话已过期，需要重新扫码')
      // 先同步掐断长轮询：SDK 自身的过期重连逻辑既不会真正拿到新二维码回调，
      // 也不会让长轮询换上新 token，只会原地每隔几秒重试报错，刷屏且没有任何进展
      bot.stop()
      this.running = false
      this.bot = null
      this.emit('session-expired')
      void this.recoverFromExpiry()
    })
    bot.on('error', (err) => log.warn('微信 SDK 报错', String(err)))

    await bot.login({ force: forceRelogin, callbacks: loginCallbacks })

    // 扫码/凭据校验一结束就能算渠道就绪：发消息只依赖 bot 实例和 targetUserId，
    // 不需要等长轮询循环。
    this.bot = bot
    this.running = true
    log.info('微信渠道已就绪', { bound: Boolean(this.targetUserId) })

    // 关键坑：bot.start() 是常驻长轮询循环，设计上要等 stop() 被调用才会 resolve
    // （SDK 自己的用法示例也是把它当成脚本最后一行来"跑到底"）。之前这里写的是
    // `await bot.start()`，导致这个函数永远卡在这一行返回不了——"重新绑定"点了
    // 没反应、扫码成功了应用却没反应，都是因为调用方一直在等一个不会 resolve 的
    // Promise。这里改成不等它跑完，只在意外退出时把状态改回未就绪。
    bot.start().catch((err) => {
      log.error('微信长轮询异常退出', String(err))
      if (this.bot === bot) {
        this.running = false
        this.bot = null
      }
    })
  }

  /** 会话过期后自愈：丢弃旧连接，强制重新走一遍扫码登录，把新二维码推给界面 */
  private async recoverFromExpiry(): Promise<void> {
    if (this.recovering) return
    this.recovering = true
    try {
      this.bot = null
      await this.start(true)
      log.info('微信重新扫码登录成功，已恢复轮询')
    } catch (err) {
      // 自动恢复失败（多半是网络问题），保持 running=false，
      // 这样设置里的「重新绑定」按钮才能再次触发 start()，而不是被旧状态挡住
      log.error('微信自动重新登录失败，可在设置里点击「重新绑定」重试', String(err))
      this.running = false
    } finally {
      this.recovering = false
    }
  }

  private handleInbound(msg: IncomingMessage): void {
    // 第一个跟机器人说话的人视为主人，之后只认这个 userId
    if (!this.targetUserId) {
      this.targetUserId = msg.userId
      this.callbacks.onBound(msg.userId)
      log.info('微信已绑定用户', { userId: msg.userId })
    } else if (msg.userId !== this.targetUserId) {
      log.warn('收到非绑定用户的消息，已忽略', { userId: msg.userId })
      return
    }

    this.callbacks.onInbound({
      channelId: 'wechat',
      userId: msg.userId,
      text: msg.text ?? '',
      type: msg.type,
      receivedAt: new Date().toISOString(),
      raw: msg
    })
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.bot) throw new Error('微信渠道尚未启动')
    if (!this.targetUserId) {
      throw new Error('微信尚未收到你的消息，请先在微信里给哨兵发一句话以建立会话')
    }

    const text = decorate(message)
    if (message.image) {
      await this.bot.send(this.targetUserId, { image: message.image, caption: text })
    } else {
      await this.bot.send(this.targetUserId, { text })
    }
  }

  setBoundUser(userId: string): void {
    this.targetUserId = userId
  }

  get boundUserId(): string | undefined {
    return this.targetUserId
  }

  async stop(): Promise<void> {
    if (!this.bot) return
    try {
      await this.bot.stop()
    } catch (err) {
      log.warn('微信渠道停止时报错', String(err))
    }
    this.bot = null
    this.running = false
  }
}
