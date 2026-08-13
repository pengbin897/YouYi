#!/usr/bin/env node
/**
 * youyi-hook —— 通用 Hook 桥接程序。
 *
 * 8 个 Agent 里只有 Claude Code（type:"http"）和 Hermes（outbound webhook）
 * 支持原生 HTTP 推送，其余 6 家只有 shell command 钩子。本程序把 stdin 上的
 * 原始 JSON 转成本地 HTTP 请求发给哨兵，再把哨兵返回的决策写回 stdout/stderr
 * 并以对应 exit code 退出。
 *
 * 三条铁律：
 * 1. 零依赖 —— 只用 node 内置模块，避免钩子执行时的模块解析开销与失败风险；
 * 2. fail-open —— 哨兵没运行、端口变了、请求超时，一律静默 exit 0 放行。
 *    绝不能因为值守程序自身的问题去阻断用户的 Agent；
 * 3. 不含厂商逻辑 —— 各家决策 schema 的差异全部由服务端适配器组装，
 *    这样厂商升级时只需改哨兵，不必重装钩子。
 *
 * 用法：youyi-hook --agent <agentId> --event <hookEventName> [--timeout <seconds>]
 */

import * as http from 'node:http'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface BridgeConnectionFile {
  version: number
  port: number
  token: string
  pid: number
  startedAt: string
}

interface HookDecisionResponse {
  exit?: number
  stdout?: string
  stderr?: string
}

/** 默认等待哨兵响应的上限。远程放行需要挂起等用户回复，所以给得很宽松。 */
const DEFAULT_TIMEOUT_SEC = 600
/** stdin 迟迟没有数据时的等待上限，超过后按空 payload 处理 */
const STDIN_IDLE_MS = 2000

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg?.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[key] = next
        i += 1
      } else {
        out[key] = 'true'
      }
    }
  }
  return out
}

/** 静默放行退出。任何异常路径都收敛到这里。 */
function failOpen(): never {
  process.exit(0)
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    // 钩子没有输入时 stdin 可能是 TTY 且永远不 end，必须有兜底计时器
    if (process.stdin.isTTY) {
      resolve('')
      return
    }
    let data = ''
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve(data)
    }
    const idleTimer = setTimeout(finish, STDIN_IDLE_MS)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      data += chunk
      // 收到数据后把空闲计时器推迟，等待 end 事件
      idleTimer.refresh()
    })
    process.stdin.on('end', () => {
      clearTimeout(idleTimer)
      finish()
    })
    process.stdin.on('error', () => {
      clearTimeout(idleTimer)
      finish()
    })
  })
}

function loadConnection(): BridgeConnectionFile | null {
  try {
    // 与主应用保持一致：YOUYI_HOME 可改数据目录（集成测试用）
    const root = process.env.YOUYI_HOME || join(homedir(), '.youyi')
    const file = join(root, 'bridge.json')
    const conn = JSON.parse(readFileSync(file, 'utf8')) as BridgeConnectionFile
    if (!conn.port || !conn.token) return null
    // 哨兵异常退出可能残留连接文件，用信号 0 探测进程是否还活着
    if (conn.pid) {
      try {
        process.kill(conn.pid, 0)
      } catch {
        return null
      }
    }
    return conn
  } catch {
    return null
  }
}

function postToSentinel(
  conn: BridgeConnectionFile,
  body: string,
  timeoutMs: number
): Promise<HookDecisionResponse | null> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: conn.port,
        path: '/hook',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-youyi-token': conn.token
        },
        timeout: timeoutMs
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          raw += chunk
        })
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(null)
            return
          }
          try {
            resolve(JSON.parse(raw) as HookDecisionResponse)
          } catch {
            resolve(null)
          }
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
    req.write(body)
    req.end()
  })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const agentId = args.agent
  const event = args.event
  if (!agentId || !event) failOpen()

  const conn = loadConnection()
  if (!conn) failOpen()

  const stdinRaw = await readStdin()
  let payload: unknown = {}
  if (stdinRaw.trim()) {
    try {
      payload = JSON.parse(stdinRaw)
    } catch {
      // 非 JSON 输入（个别 Agent 可能传纯文本）原样带上，由适配器决定怎么解析
      payload = { _raw_text: stdinRaw }
    }
  }

  const timeoutMs = Number(args.timeout ?? DEFAULT_TIMEOUT_SEC) * 1000
  const body = JSON.stringify({ agentId, event, payload, cwd: process.cwd() })

  const decision = await postToSentinel(conn, body, timeoutMs)
  if (!decision) failOpen()

  if (decision.stdout) process.stdout.write(decision.stdout)
  if (decision.stderr) process.stderr.write(decision.stderr)
  process.exit(typeof decision.exit === 'number' ? decision.exit : 0)
}

main().catch(failOpen)
