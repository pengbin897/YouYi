/**
 * 哨兵编排层：把各个子系统装配起来并管理生命周期。
 *
 * 数据流向是单向的：
 *   Agent 钩子 → HookServer → 适配器归一化 → 事件引擎 → 通知管家 → 渠道
 *   渠道上行 → 消息路由器 → 透传队列 / 挂起决策 → 回到 Agent
 */

import { EventEmitter } from 'node:events'
import {
  agentName,
  isAgentId,
  type AgentId,
  type CliMessageRequest,
  type CliMessageResponse,
  type CliStateSnapshot,
  type Task,
  type UnifiedEvent
} from '@youyi/shared'
import { SettingsStore } from './config/settings-store.js'
import { SqliteStore } from './store/sqlite.js'
import type { Store } from './store/types.js'
import { EventEngine } from './engine/event-engine.js'
import { SessionTracker } from './engine/session-tracker.js'
import { StallDetector } from './engine/stall-detector.js'
import { HookServer } from './hook-server/server.js'
import { PendingDecisionArbiter } from './hook-server/pending-decisions.js'
import { installBridge, installCli } from './hook-server/bridge-installer.js'
import { RelayQueue } from './router/relay-queue.js'
import { AdapterRegistry } from './adapters/registry.js'
import { createAdapters } from './adapters/index.js'
import type { AdapterContext } from './adapters/types.js'
import { ChannelManager } from './channels/manager.js'
import { Notifier } from './notifier/notifier.js'
import { DigestScheduler } from './notifier/digest.js'
import { MessageRouter } from './router/router.js'
import { createLogger } from './util/logger.js'

const log = createLogger('sentinel')

/** 托盘与面板要用的最近事件缓存长度 */
const RECENT_EVENTS_LIMIT = 20

export declare interface Sentinel {
  on(event: 'task-updated', listener: (task: Task) => void): this
  on(event: 'event', listener: (e: UnifiedEvent) => void): this
  on(event: 'state-changed', listener: () => void): this
}

export class Sentinel extends EventEmitter {
  readonly settings: SettingsStore
  readonly store: Store
  readonly engine: EventEngine
  readonly pending: PendingDecisionArbiter
  readonly relay: RelayQueue
  readonly hookServer: HookServer
  readonly adapters: AdapterRegistry
  readonly channels: ChannelManager
  readonly notifier: Notifier
  readonly router: MessageRouter
  readonly sessions: SessionTracker
  private readonly stallDetector: StallDetector
  private readonly digest: DigestScheduler

  private bridgeCommandPath = ''
  private recentEvents: UnifiedEvent[] = []
  private watching = true

  constructor() {
    super()
    this.settings = new SettingsStore()
    this.store = new SqliteStore()
    this.engine = new EventEngine(this.store)
    this.pending = new PendingDecisionArbiter()
    this.relay = new RelayQueue()

    this.hookServer = new HookServer(
      (req) => this.adapters.dispatch(req),
      (id) => this.isAgentEnabled(id),
      // CLI 网关（PRD I1）。箭头函数延迟取值，router 在下方才创建也没关系
      {
        state: () => this.buildCliSnapshot(),
        message: (req) => this.handleCliMessage(req)
      }
    )

    this.sessions = new SessionTracker(this.store)

    const ctx: AdapterContext = {
      engine: this.engine,
      store: this.store,
      settings: this.settings,
      pending: this.pending,
      relay: this.relay,
      sessions: this.sessions,
      hookUrl: (agentId, event) => this.hookServer.httpHookUrl(agentId, event),
      bridgeCommand: () => this.bridgeCommandPath,
      notifyAgentReply: (agentId, text) => {
        // Agent 的回答原样回传，只加一个来源前缀，不做任何改写（PRD D3）
        void this.channels.send({ kind: 'agent-reply', text: `[${agentName(agentId)}]\n${text}` })
      }
    }

    this.adapters = new AdapterRegistry(ctx)
    for (const adapter of createAdapters()) this.adapters.register(adapter)

    this.channels = new ChannelManager(this.settings, this.store)
    this.notifier = new Notifier(this.settings, this.store, this.channels)
    this.digest = new DigestScheduler(this.settings, this.store, this.channels)
    this.router = new MessageRouter({
      settings: this.settings,
      store: this.store,
      pending: this.pending,
      relay: this.relay,
      adapters: this.adapters,
      channels: this.channels
    })

    this.stallDetector = new StallDetector(
      this.store,
      this.engine,
      () => this.settings.get().stallTimeoutMs
    )

    this.wire()
  }

  private wire(): void {
    this.engine.on('event', (event) => {
      this.recentEvents = [...this.recentEvents, event].slice(-RECENT_EVENTS_LIMIT)
      this.stallDetector.noteActivity(event.task_id)
      this.emit('event', event)
    })

    this.engine.on('task-updated', (task) => {
      this.emit('task-updated', task)
      this.emit('state-changed')
    })

    // 通知管家决定是否/何时推送
    this.engine.on('notify', (request) => {
      if (!this.watching) return
      void this.notifier.handle(request)
    })

    // 挂起中的授权请求变化要立刻反映到面板与托盘
    this.pending.on('created', () => this.emit('state-changed'))
    this.pending.on('resolved', () => this.emit('state-changed'))

    // 渠道上行消息交给路由器
    this.channels.on('inbound', (message) => {
      void this.router.handleInbound(message)
    })

    // 渠道的绑定/降级/恢复都要立刻同步给面板和托盘，否则微信明明连上了，
    // 设置页也会因为一直没收到推送而卡在「未连接」，只能等下次别的事件顺带刷一下
    this.channels.on('state-changed', () => this.emit('state-changed'))
  }

  async start(): Promise<void> {
    const bridge = installBridge()
    this.bridgeCommandPath = bridge.command
    // CLI 部署失败不阻塞值守，只是命令行入口不可用（日志里已有原因）
    const cli = installCli()

    await this.hookServer.start()

    const enabled = this.settings.get().enabledAgents
    if (enabled.length > 0) {
      await this.adapters.install(enabled)
    }

    await this.channels.start()
    this.stallDetector.start()
    this.digest.start()

    log.info('哨兵已开始值守', {
      agents: enabled,
      port: this.hookServer.port,
      bridge: bridge.ok,
      cli: cli.ok
    })
  }

  async stop(): Promise<void> {
    this.stallDetector.stop()
    this.digest.stop()
    this.engine.flushAll()
    // 把还挂着的钩子请求交还各自的 Agent，避免它们一直卡在等待里
    this.pending.drain()
    this.relay.drain()
    await this.channels.stop()
    await this.hookServer.stop()
    this.store.close()
    log.info('哨兵已停止值守')
  }

  /** 重新安装钩子，用户在设置里改变勾选后调用 */
  async applyAgentSelection(ids: AgentId[]): Promise<void> {
    const previous = this.settings.get().enabledAgents
    const removed = previous.filter((id) => !ids.includes(id))
    if (removed.length > 0) await this.adapters.uninstall(removed)

    this.settings.patch({ enabledAgents: ids })
    await this.adapters.install(ids)
    this.emit('state-changed')
  }

  isAgentEnabled(id: AgentId): boolean {
    return this.settings.get().enabledAgents.includes(id)
  }

  setWatching(watching: boolean): void {
    this.watching = watching
    this.emit('state-changed')
  }

  get isWatching(): boolean {
    return this.watching
  }

  getRecentEvents(): UnifiedEvent[] {
    return this.recentEvents
  }

  /** CLI 状态快照（PRD I1）：给 youyi status --json 之类的脚本消费 */
  private buildCliSnapshot(): CliStateSnapshot {
    const enabled = this.settings.get().enabledAgents
    const tasks = this.store.tasks.listActive()

    return {
      watching: this.watching,
      tasks,
      pending: this.pending.list(),
      agents: this.adapters.all().map((adapter) => ({
        id: adapter.id,
        name: agentName(adapter.id),
        enabled: enabled.includes(adapter.id),
        runningTasks: tasks.filter((t) => t.agent_id === adapter.id && t.status === 'RUNNING')
          .length
      })),
      recentEvents: this.recentEvents.slice(-10)
    }
  }

  /**
   * CLI 文本消息（PRD I1）：走与微信上行完全相同的路由器与安全护栏，
   * 唯一差别是回复被收集起来同步返回给命令行，而不是发回通知渠道。
   */
  private async handleCliMessage(req: CliMessageRequest): Promise<CliMessageResponse> {
    // --agent 显式指定目标时先校验，不认识的 ID 直接报错，不能让它悄悄落到默认路由上
    if (req.agentId !== undefined && !isAgentId(req.agentId)) {
      return { replies: [`不认识的 Agent：${req.agentId}。可以用 youyi agents 查看可用列表。`] }
    }

    const replies: string[] = []
    await this.router.handleInbound(
      {
        channelId: 'cli',
        userId: 'cli',
        text: req.text,
        type: 'text',
        receivedAt: new Date().toISOString()
      },
      {
        reply: async (text) => {
          replies.push(text)
        },
        forceAgent: req.agentId as AgentId | undefined
      }
    )
    return { replies }
  }

  /** 一键清除全部本地数据（PRD G4/H） */
  clearAllData(): void {
    this.store.clearAll()
    this.recentEvents = []
    this.settings.reset()
    this.emit('state-changed')
  }
}
