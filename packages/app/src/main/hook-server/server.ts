/**
 * 本地 Hook 接收端点（PRD B1）+ CLI 网关（PRD I1，设计方案 v0.7 §5.4）。
 *
 * 四条入口：
 * - POST /hook            桥接程序转发，token 放在请求头
 * - POST /h/:token/:agent/:event   Agent 原生 HTTP 钩子直连（Claude Code）
 * - GET  /cli/:token/state         youyi CLI 的结构化状态快照
 * - POST /cli/:token/message       youyi CLI 的文本消息（与微信上行同一路由器）
 *
 * 为什么原生 HTTP 钩子把 token 放路径里：Claude Code 的自定义请求头只支持
 * `$VAR` 形式的环境变量插值，而该变量必须存在于用户启动 Claude 的 shell 环境中，
 * 我们无法可靠地注入。端点只监听回环地址，路径 token 的安全性足够。
 * CLI 端点沿用同一套 token 机制。
 *
 * 端口与 token 跨重启复用（存在 server.json），这样不必每次启动都去改写
 * 用户的第三方配置文件。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { HEALTH_ENDPOINT, HOOK_ENDPOINT, TOKEN_HEADER, isAgentId } from '@youyi/shared'
import type {
  AgentId,
  BridgeConnectionFile,
  CliMessageRequest,
  CliMessageResponse,
  CliStateSnapshot
} from '@youyi/shared'
import { PATHS, ensureDirs } from '../config/paths.js'
import { createLogger } from '../util/logger.js'

const log = createLogger('hook-server')

/** 单个钩子请求体上限，防止异常输入把内存吃满 */
const MAX_BODY_BYTES = 4 * 1024 * 1024

export interface HookRequest {
  agentId: AgentId
  event: string
  payload: Record<string, unknown>
  cwd?: string
  transport: 'http' | 'bridge'
}

/**
 * 适配器返回的处理结果。
 * bridge 传输用 exit/stdout/stderr；原生 HTTP 钩子用 json 直接作为响应体
 * （HTTP 钩子无法靠状态码阻断，只能靠 2xx + 决策 JSON）。
 */
export interface HookOutcome {
  exit?: number
  stdout?: string
  stderr?: string
  json?: unknown
}

export type HookDispatcher = (req: HookRequest) => Promise<HookOutcome>

/**
 * CLI 网关的服务端实现，由 Sentinel 装配注入。
 * HookServer 只负责鉴权与 HTTP 编解码，状态与路由逻辑都在 Sentinel 侧。
 */
export interface CliGateway {
  state(): CliStateSnapshot
  message(req: CliMessageRequest): Promise<CliMessageResponse>
}

interface ServerIdentity {
  port: number
  token: string
}

export class HookServer {
  private server: Server | null = null
  private identity: ServerIdentity | null = null

  constructor(
    private readonly dispatch: HookDispatcher,
    /** 来源校验：只有被用户勾选接入的 Agent 才允许上报（PRD B1 验收） */
    private readonly isAgentEnabled: (id: AgentId) => boolean,
    /** 不注入时 CLI 端点一律 404（部分测试台不需要 CLI） */
    private readonly cli?: CliGateway
  ) {}

  async start(): Promise<ServerIdentity> {
    ensureDirs()
    const saved = this.loadIdentity()
    const token = saved?.token ?? randomBytes(24).toString('hex')

    const port = await this.listen(saved?.port ?? 0)
    this.identity = { port, token }
    this.saveIdentity(this.identity)
    this.writeBridgeFile(this.identity)

    log.info('Hook 端点已启动', { url: `http://127.0.0.1:${port}` })
    return this.identity
  }

  private listen(preferredPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          log.error('处理钩子请求时异常', String(err))
          this.send(res, 500, { error: 'internal' })
        })
      })

      server.once('error', (err: NodeJS.ErrnoException) => {
        // 上次使用的端口被别的程序占了，退回随机端口
        if (err.code === 'EADDRINUSE' && preferredPort !== 0) {
          log.warn('端口被占用，改用随机端口', { port: preferredPort })
          server.close()
          this.listen(0).then(resolve, reject)
          return
        }
        reject(err)
      })

      // 只绑定回环地址，外部网络不可达（PRD B1 / H）
      server.listen(preferredPort, '127.0.0.1', () => {
        const address = server.address()
        if (address && typeof address === 'object') {
          this.server = server
          resolve(address.port)
        } else {
          reject(new Error('无法确定监听端口'))
        }
      })
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (req.method === 'GET' && url.pathname === HEALTH_ENDPOINT) {
      this.send(res, 200, { ok: true, pid: process.pid })
      return
    }

    // CLI 网关：/cli/:token/state（GET）与 /cli/:token/message（POST）
    const cliParts = url.pathname.split('/').filter(Boolean)
    if (cliParts[0] === 'cli') {
      await this.handleCli(req, res, cliParts)
      return
    }

    if (req.method !== 'POST') {
      this.send(res, 405, { error: 'method_not_allowed' })
      return
    }

    // 路由一：桥接程序（token 在请求头，agent/event 在 body）
    if (url.pathname === HOOK_ENDPOINT) {
      if (!this.checkToken(req.headers[TOKEN_HEADER])) {
        log.warn('桥接请求 token 校验失败，已拒绝')
        this.send(res, 403, { error: 'forbidden' })
        return
      }
      const body = await this.readBody(req)
      if (!body) {
        this.send(res, 400, { error: 'bad_request' })
        return
      }
      const envelope = body as {
        agentId?: string
        event?: string
        payload?: unknown
        cwd?: string
      }
      const outcome = await this.route({
        agentIdRaw: envelope.agentId,
        event: envelope.event,
        payload: envelope.payload,
        cwd: envelope.cwd,
        transport: 'bridge',
        res
      })
      if (!outcome) return
      // 走桥接的 Agent 靠 stdout JSON 表达决策，所以适配器给的 json 必须序列化下去，
      // 否则 Codex / Workbuddy / Trae 的放行决策会被悄悄丢掉
      const stdout =
        outcome.stdout ?? (outcome.json === undefined ? undefined : JSON.stringify(outcome.json))
      this.send(res, 200, {
        exit: outcome.exit ?? 0,
        stdout,
        stderr: outcome.stderr
      })
      return
    }

    // 路由二：原生 HTTP 钩子 /h/:token/:agentId/:event
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] === 'h' && parts.length >= 4) {
      const [, token, agentIdRaw, ...eventParts] = parts
      if (!this.checkToken(token)) {
        log.warn('原生 HTTP 钩子 token 校验失败，已拒绝', { agent: agentIdRaw })
        this.send(res, 403, { error: 'forbidden' })
        return
      }
      const body = await this.readBody(req)
      const payload = (body ?? {}) as Record<string, unknown>
      const outcome = await this.route({
        agentIdRaw,
        event: eventParts.join('/'),
        payload,
        cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
        transport: 'http',
        res
      })
      if (!outcome) return
      // HTTP 钩子只认 2xx + JSON 决策体，状态码无法表达阻断
      this.send(res, 200, outcome.json ?? this.parseStdout(outcome.stdout))
      return
    }

    this.send(res, 404, { error: 'not_found' })
  }

  /**
   * CLI 端点处理（PRD I1）。
   * 鉴权失败一律 403 且不带任何状态信息；消息文本进入与微信上行同一个路由器。
   */
  private async handleCli(
    req: IncomingMessage,
    res: ServerResponse,
    parts: string[]
  ): Promise<void> {
    const [, token, action] = parts
    if (!this.cli || parts.length !== 3) {
      this.send(res, 404, { error: 'not_found' })
      return
    }
    if (!this.checkToken(token)) {
      log.warn('CLI 请求 token 校验失败，已拒绝')
      this.send(res, 403, { error: 'forbidden' })
      return
    }

    if (req.method === 'GET' && action === 'state') {
      this.send(res, 200, this.cli.state())
      return
    }

    if (req.method === 'POST' && action === 'message') {
      const body = await this.readBody(req)
      const envelope = body as { text?: unknown; agentId?: unknown } | null
      if (!envelope || typeof envelope.text !== 'string' || !envelope.text.trim()) {
        this.send(res, 400, { error: 'bad_request' })
        return
      }
      if (envelope.agentId !== undefined && typeof envelope.agentId !== 'string') {
        this.send(res, 400, { error: 'bad_request' })
        return
      }
      const outcome = await this.cli.message({
        text: envelope.text,
        agentId: envelope.agentId
      })
      this.send(res, 200, outcome)
      return
    }

    this.send(res, 404, { error: 'not_found' })
  }

  /** 校验来源并派发。返回 null 表示已经写过响应（如来源非法）。 */
  private async route(input: {
    agentIdRaw: string | undefined
    event: string | undefined
    payload: unknown
    cwd: string | undefined
    transport: 'http' | 'bridge'
    res: ServerResponse
  }): Promise<HookOutcome | null> {
    const { agentIdRaw, event, res } = input
    if (!agentIdRaw || !event || !isAgentId(agentIdRaw)) {
      log.warn('未知来源的钩子请求，已拒绝', { agent: agentIdRaw, event })
      this.send(res, 403, { error: 'unknown_agent' })
      return null
    }
    if (!this.isAgentEnabled(agentIdRaw)) {
      // 用户取消勾选后钩子可能还残留在第三方配置里，静默放行即可
      log.debug('该 Agent 未被勾选接入，忽略事件', { agent: agentIdRaw, event })
      return { exit: 0 }
    }

    return this.dispatch({
      agentId: agentIdRaw,
      event,
      payload: (input.payload ?? {}) as Record<string, unknown>,
      cwd: input.cwd,
      transport: input.transport
    })
  }

  private parseStdout(stdout?: string): unknown {
    if (!stdout) return {}
    try {
      return JSON.parse(stdout)
    } catch {
      return {}
    }
  }

  private checkToken(provided: string | string[] | undefined): boolean {
    const expected = this.identity?.token
    if (!expected) return false
    const value = Array.isArray(provided) ? provided[0] : provided
    if (!value || value.length !== expected.length) return false
    return timingSafeEqual(Buffer.from(value), Buffer.from(expected))
  }

  private readBody(req: IncomingMessage): Promise<unknown | null> {
    return new Promise((resolve) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          req.destroy()
          resolve(null)
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (!raw.trim()) {
          resolve({})
          return
        }
        try {
          resolve(JSON.parse(raw))
        } catch {
          resolve(null)
        }
      })
      req.on('error', () => resolve(null))
    })
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body ?? {})
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload)
    })
    res.end(payload)
  }

  private loadIdentity(): ServerIdentity | null {
    try {
      const saved = JSON.parse(readFileSync(PATHS.server, 'utf8')) as ServerIdentity
      if (typeof saved.port === 'number' && typeof saved.token === 'string') return saved
    } catch {
      // 首次启动没有该文件
    }
    return null
  }

  private saveIdentity(identity: ServerIdentity): void {
    writeFileSync(PATHS.server, JSON.stringify(identity, null, 2), { mode: 0o600 })
  }

  private writeBridgeFile(identity: ServerIdentity): void {
    const file: BridgeConnectionFile = {
      version: 1,
      port: identity.port,
      token: identity.token,
      pid: process.pid,
      startedAt: new Date().toISOString()
    }
    writeFileSync(PATHS.bridge, JSON.stringify(file, null, 2), { mode: 0o600 })
  }

  /** 原生 HTTP 钩子使用的完整 URL */
  httpHookUrl(agentId: AgentId, event: string): string {
    if (!this.identity) throw new Error('HookServer 尚未启动')
    return `http://127.0.0.1:${this.identity.port}/h/${this.identity.token}/${agentId}/${event}`
  }

  get baseUrl(): string {
    if (!this.identity) throw new Error('HookServer 尚未启动')
    return `http://127.0.0.1:${this.identity.port}`
  }

  get port(): number {
    return this.identity?.port ?? 0
  }

  async stop(): Promise<void> {
    // 先删连接文件，让还没发出请求的桥接进程直接走 fail-open，不必等超时
    try {
      rmSync(PATHS.bridge, { force: true })
    } catch {
      // 忽略
    }
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      // server.close() 的回调要等所有已建立的连接（包括桥接程序常开的 keep-alive
      // 连接）都断开才会触发；退出流程等不起这个，主动把连接全部踢掉，
      // 不然点「退出哨兵」可能悄无声息地卡死在这一步，控制台什么都不会打印
      this.server.closeAllConnections()
      this.server.close(() => resolve())
      this.server = null
    })
  }
}
