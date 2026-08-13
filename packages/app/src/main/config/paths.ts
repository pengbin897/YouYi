/**
 * 所有本地数据都集中在 ~/.youyi 下，理由有二：
 * 1. 桥接程序被各家 Agent 以独立进程拉起，必须能在不依赖 Electron API 的情况下
 *    找到连接文件，所以路径必须是固定可预测的；
 * 2. 「一键清除全部数据」只需删这一个目录，符合隐私底线（PRD H）。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * 允许用 YOUYI_HOME 改数据目录：集成测试要把数据写到临时目录，
 * 不能污染用户真实的 ~/.youyi。桥接程序也读同一个环境变量。
 */
export const YOUYI_DIR = process.env.YOUYI_HOME || join(homedir(), '.youyi')

export const PATHS = {
  root: YOUYI_DIR,
  /** 桥接程序与其平台包装脚本 */
  bin: join(YOUYI_DIR, 'bin'),
  /** 修改第三方配置前的备份 */
  backups: join(YOUYI_DIR, 'backups'),
  logs: join(YOUYI_DIR, 'logs'),
  /** 事件与任务数据库 */
  db: join(YOUYI_DIR, 'youyi.db'),
  /** 应用设置 */
  settings: join(YOUYI_DIR, 'settings.json'),
  /** HookServer 端口与 token，跨重启复用以减少对第三方配置文件的改写 */
  server: join(YOUYI_DIR, 'server.json'),
  /** 桥接程序读取的连接文件，含存活 PID */
  bridge: join(YOUYI_DIR, 'bridge.json'),
  /** 微信 SDK 的凭据目录 */
  wechat: join(homedir(), '.wechatbot')
} as const

export function ensureDirs(): void {
  for (const dir of [PATHS.root, PATHS.bin, PATHS.backups, PATHS.logs]) {
    mkdirSync(dir, { recursive: true })
  }
}
