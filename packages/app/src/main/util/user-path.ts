/**
 * 补齐 PATH。
 *
 * macOS 从 Finder / 登录项拉起的 GUI 程序只继承一个极简 PATH
 * （/usr/bin:/bin:/usr/sbin:/sbin），不会加载 ~/.zshrc，因此 nvm、homebrew、
 * npm -g 装的 claude / codex 全都 which 不到——自动发现会全军覆没。
 *
 * 做法：启动时用登录 shell 跑一次 `echo $PATH` 取回用户真实 PATH，合并进
 * process.env.PATH。只跑一次，失败就退回到内置的常见安装目录列表。
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from './logger.js'

const log = createLogger('user-path')
const run = promisify(execFile)

/** 登录 shell 取不到时的兜底目录，覆盖 homebrew（双架构）、npm 全局、pipx、cargo */
function fallbackDirs(): string[] {
  const home = homedir()
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.volta', 'bin')
  ]
}

let done = false

export async function augmentUserPath(): Promise<void> {
  if (done) return
  done = true

  const before = process.env.PATH ?? ''
  const merged = new Set(before.split(':').filter(Boolean))

  if (process.platform !== 'win32') {
    try {
      const shell = process.env.SHELL || '/bin/zsh'
      // -i 让 shell 读交互式配置（nvm 通常只在 .zshrc 里初始化），
      // 用 sentinel 包裹是因为交互式 shell 可能顺带打印 banner
      const { stdout } = await run(shell, ['-ilc', 'echo "__YOUYI_PATH__$PATH"'], {
        timeout: 5000,
        maxBuffer: 1024 * 1024
      })
      const line = stdout.split('\n').find((l) => l.includes('__YOUYI_PATH__'))
      const userPath = line?.split('__YOUYI_PATH__')[1]?.trim()
      if (userPath) {
        for (const dir of userPath.split(':')) if (dir) merged.add(dir)
      }
    } catch (err) {
      log.warn('读取登录 shell PATH 失败，改用内置目录列表', String(err))
    }

    for (const dir of fallbackDirs()) merged.add(dir)
  }

  process.env.PATH = [...merged].join(':')
  if (process.env.PATH !== before) {
    log.info('PATH 已补齐', { count: merged.size })
  }
}
