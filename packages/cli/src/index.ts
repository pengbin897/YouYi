#!/usr/bin/env node
/**
 * youyi —— 游奕本地命令行客户端（PRD 模块 I / 设计方案 v0.7 §5.4）。
 *
 * 让用户与本机其他程序能以纯命令行方式调用哨兵的既有操作：
 * 状态查询 / 透传 / 放行确认 / 全部停止。能力集合与微信上行完全一致——
 * 服务端走同一个消息路由器，高危拦截、远程放行开关、二次确认全部生效。
 *
 * 与桥接程序（youyi-hook）共用同一份连接文件与同一个回环 HTTP 服务，
 * 也共守同一条铁律：零依赖，只用 node 内置模块。
 *
 * 与桥接程序的关键差别：桥接必须 fail-open（不能阻断用户的 Agent），
 * 而 CLI 的调用者需要知道失败——主进程不在时明确报错并以非 0 退出。
 *
 * 用法：
 *   youyi status [--json]              查看任务与待确认请求
 *   youyi agents [--json]              查看各 Agent 接入状态
 *   youyi send [--agent <id>] <text>   把话透传给 Agent
 *   youyi approve | deny               放行 / 拒绝待确认的操作
 *   youyi stop-all [--confirm]         停止全部任务（两步强确认）
 */

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

interface CliTask {
  agent_id: string
  title: string
  status: string
  progress: number
  started_at: string
}

interface CliStateSnapshot {
  watching: boolean
  tasks: CliTask[]
  pending: Array<{ agent_id: string; request_text: string }>
  agents: Array<{ id: string; name: string; enabled: boolean; runningTasks: number }>
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: '待开始',
  RUNNING: '进行中',
  NEEDS_AUTH: '待确认',
  COMPLETED: '已完成',
  FAILED: '失败',
  STALLED: '可能卡住'
}

/**
 * 默认等待上限：透传会挂到路由器整条流程走完（透传队列默认 90 秒超时 +
 * 可能的无头拉起），给到 120 秒；超时不代表失败，服务端会继续处理。
 */
const DEFAULT_TIMEOUT_SEC = 120

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function loadConnection(): BridgeConnectionFile {
  const root = process.env.YOUYI_HOME || join(homedir(), '.youyi')
  const file = join(root, 'bridge.json')

  let conn: BridgeConnectionFile
  try {
    conn = JSON.parse(readFileSync(file, 'utf8')) as BridgeConnectionFile
  } catch {
    fail('游奕没有在运行（找不到连接文件）。请先启动游奕应用。')
  }
  if (!conn.port || !conn.token) {
    fail('连接文件不完整，可能游奕正在启动中，稍后再试。')
  }
  // 主进程异常退出可能残留连接文件，用信号 0 探测存活
  if (conn.pid) {
    try {
      process.kill(conn.pid, 0)
    } catch {
      fail('游奕没有在运行（进程已退出）。请先启动游奕应用。')
    }
  }
  return conn
}

async function request(
  conn: BridgeConnectionFile,
  method: 'GET' | 'POST',
  action: 'state' | 'message',
  body?: unknown,
  timeoutSec = DEFAULT_TIMEOUT_SEC
): Promise<unknown> {
  const url = `http://127.0.0.1:${conn.port}/cli/${conn.token}/${action}`
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutSec * 1000)
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      fail('等待超时。指令已提交给游奕，后续回执会通过通知渠道（微信等）送达。')
    }
    fail(`连不上游奕（${String(err)}）。请确认应用正在运行。`)
  }
  if (!res.ok) {
    fail(`游奕拒绝了这次请求（HTTP ${res.status}）。可以查看 ~/.youyi/logs 下的日志。`)
  }
  return res.json()
}

/** 解析形如 [--agent x] [--json] [--timeout 30] 的旗标，其余作为位置参数返回 */
function parseFlags(argv: string[]): { flags: Record<string, string | boolean>; rest: string[] } {
  const flags: Record<string, string | boolean> = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json' || arg === '--confirm') {
      flags[arg.slice(2)] = true
    } else if (arg === '--agent' || arg === '--timeout') {
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) fail(`${arg} 需要一个值`, 2)
      flags[arg.slice(2)] = next
      i += 1
    } else if (arg.startsWith('--')) {
      fail(`不认识的选项：${arg}`, 2)
    } else {
      rest.push(arg)
    }
  }
  return { flags, rest }
}

function printHelp(): void {
  process.stdout.write(
    [
      'youyi —— 游奕本地命令行入口',
      '',
      '用法：',
      '  youyi status [--json]              查看任务与待确认请求',
      '  youyi agents [--json]              查看各 Agent 接入状态',
      '  youyi send [--agent <id>] <text>   把话透传给 Agent',
      '  youyi approve                      放行正在等确认的操作',
      '  youyi deny                         拒绝正在等确认的操作',
      '  youyi stop-all [--confirm]         停止全部任务（两步强确认）',
      '',
      '选项：',
      '  --json             输出机器可读 JSON（status / agents）',
      '  --agent <id>       指定透传目标，如 claude-code',
      `  --timeout <sec>    等待回复的上限，默认 ${DEFAULT_TIMEOUT_SEC} 秒`,
      ''
    ].join('\n')
  )
}

async function fetchState(conn: BridgeConnectionFile): Promise<CliStateSnapshot> {
  return (await request(conn, 'GET', 'state')) as CliStateSnapshot
}

function printStatus(state: CliStateSnapshot): void {
  const lines: string[] = []
  lines.push(state.watching ? '值守中' : '值守已暂停')

  if (state.tasks.length === 0) {
    lines.push('当前没有正在跑的任务。')
  } else {
    lines.push(`${state.tasks.length} 个活跃任务：`)
    for (const task of state.tasks) {
      const percent = Math.round(task.progress * 100)
      const label = STATUS_LABEL[task.status] ?? task.status
      lines.push(
        `· [${task.agent_id}] ${task.title} — ${label}${task.status === 'RUNNING' ? ` ${percent}%` : ''}`
      )
    }
  }

  if (state.pending.length > 0) {
    lines.push(`${state.pending.length} 个请求在等你确认：`)
    for (const item of state.pending) {
      lines.push(`· [${item.agent_id}] ${item.request_text}`)
    }
    lines.push('回复：youyi approve 放行 / youyi deny 拒绝')
  }

  process.stdout.write(`${lines.join('\n')}\n`)
}

function printAgents(state: CliStateSnapshot): void {
  const lines = state.agents.map((agent) => {
    const status = agent.enabled
      ? agent.runningTasks > 0
        ? `已接入 · ${agent.runningTasks} 个任务进行中`
        : '已接入'
      : '未接入'
    return `· ${agent.name}（${agent.id}）— ${status}`
  })
  process.stdout.write(`${lines.join('\n')}\n`)
}

/** 发一条文本给路由器并把全部回复打到 stdout */
async function sendMessage(
  conn: BridgeConnectionFile,
  text: string,
  agentId?: string,
  timeoutSec = DEFAULT_TIMEOUT_SEC
): Promise<void> {
  const result = (await request(conn, 'POST', 'message', { text, agentId }, timeoutSec)) as {
    replies?: string[]
  }
  const replies = result.replies ?? []
  process.stdout.write(replies.length > 0 ? `${replies.join('\n')}\n` : '（游奕没有返回内容）\n')
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return
  }

  const { flags, rest } = parseFlags(args)
  const conn = loadConnection()
  const timeoutSec = flags.timeout ? Number(flags.timeout) : DEFAULT_TIMEOUT_SEC
  if (Number.isNaN(timeoutSec) || timeoutSec <= 0) fail('--timeout 必须是正数', 2)

  switch (command) {
    case 'status': {
      const state = await fetchState(conn)
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
      } else {
        printStatus(state)
      }
      return
    }
    case 'agents': {
      const state = await fetchState(conn)
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(state.agents, null, 2)}\n`)
      } else {
        printAgents(state)
      }
      return
    }
    case 'send': {
      const text = rest.join(' ').trim()
      if (!text) fail('用法：youyi send [--agent <id>] <要说的话>', 2)
      await sendMessage(conn, text, typeof flags.agent === 'string' ? flags.agent : undefined, timeoutSec)
      return
    }
    case 'approve':
      await sendMessage(conn, '继续', undefined, timeoutSec)
      return
    case 'deny':
      await sendMessage(conn, '停止', undefined, timeoutSec)
      return
    case 'stop-all':
      // 强确认保留两步（PRD D4/I2）：--confirm 对应微信里的「确认停止」
      await sendMessage(conn, flags.confirm ? '确认停止' : '全部停止', undefined, timeoutSec)
      return
    default:
      fail(`不认识的命令：${command}。执行 youyi help 查看用法。`, 2)
  }
}

main().catch((err) => fail(String(err)))
