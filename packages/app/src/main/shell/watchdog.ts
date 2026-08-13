/**
 * 崩溃自愈（PRD A2：主进程异常退出后 10s 内自动重启）。
 *
 * 主进程自己没法在被 kill -9 之后复活，所以派一个独立的守护子进程：它只做一件事，
 * 轮询父进程是否还活着；发现父进程消失且没有留下「正常退出」标记，就把应用重新拉起来。
 *
 * 守护脚本在运行时生成到 ~/.youyi/bin，和桥接程序放在一起，避免额外的打包入口。
 * 任务状态本身存在 SQLite 里，重启后自然恢复，所以自愈不需要额外的状态传递。
 */

import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { PATHS, ensureDirs } from '../config/paths.js'
import { createLogger } from '../util/logger.js'

const log = createLogger('watchdog')

const CLEAN_EXIT_MARKER = join(PATHS.root, 'clean-exit')
const WATCHDOG_SCRIPT = join(PATHS.bin, 'watchdog.mjs')

/** 发现父进程消失后先等这么久再拉起，避开系统重启/更新安装等正常场景 */
const RELAUNCH_DELAY_MS = 5000
const POLL_INTERVAL_MS = 2000

const SCRIPT = `// 游奕哨兵守护进程：父进程异常消失时把应用重新拉起
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const [, , parentPidRaw, markerFile, execPath] = process.argv
const parentPid = Number(parentPidRaw)
const POLL_MS = ${POLL_INTERVAL_MS}
const DELAY_MS = ${RELAUNCH_DELAY_MS}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const timer = setInterval(() => {
  if (alive(parentPid)) return
  clearInterval(timer)

  setTimeout(() => {
    // 用户主动退出会留下标记文件，这种情况不复活
    if (existsSync(markerFile)) process.exit(0)
    spawn(execPath, [], { detached: true, stdio: 'ignore' }).unref()
    process.exit(0)
  }, DELAY_MS)
}, POLL_MS)
`

export class Watchdog {
  private child: ReturnType<typeof spawn> | null = null

  start(): void {
    // 开发模式下热重载会频繁重启主进程，守护进程只会添乱
    if (!app.isPackaged) {
      log.info('开发模式下跳过崩溃自愈守护')
      return
    }

    ensureDirs()
    // 本次启动先清掉上次的正常退出标记
    rmSync(CLEAN_EXIT_MARKER, { force: true })
    writeFileSync(WATCHDOG_SCRIPT, SCRIPT, 'utf8')

    try {
      this.child = spawn(
        process.execPath,
        [WATCHDOG_SCRIPT, String(process.pid), CLEAN_EXIT_MARKER, process.execPath],
        {
          detached: true,
          stdio: 'ignore',
          // 让 Electron 二进制以纯 Node 模式运行脚本，用户机器上不必装 node
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        }
      )
      this.child.unref()
      log.info('崩溃自愈守护已启动', { pid: this.child.pid })
    } catch (err) {
      log.error('守护进程启动失败，本次运行不具备自愈能力', String(err))
    }
  }

  /** 用户主动退出时调用，留下标记让守护进程安静退场 */
  markCleanExit(): void {
    try {
      writeFileSync(CLEAN_EXIT_MARKER, new Date().toISOString(), 'utf8')
    } catch {
      // 标记写失败最坏结果是应用被多拉起一次，可以接受
    }
  }

  static hadUncleanExit(): boolean {
    return !existsSync(CLEAN_EXIT_MARKER)
  }
}

/**
 * 进程级异常兜底。未捕获异常不直接让进程裸退，先记日志再自行重启，
 * 这样即使守护进程没起来也有一层保护。
 */
export function installCrashGuards(onFatal: () => void): void {
  process.on('uncaughtException', (err) => {
    log.error('未捕获异常，准备重启', err?.stack ?? String(err))
    onFatal()
  })
  process.on('unhandledRejection', (reason) => {
    // Promise 拒绝多数是可恢复的（例如某个渠道发送失败），记录即可
    log.error('未处理的 Promise 拒绝', String(reason))
  })
}
