/** 自动更新（PRD A2）：静默下载，下载完成后提示用户重启安装 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import { createLogger } from '../util/logger.js'

const log = createLogger('updater')
const { autoUpdater } = electronUpdater

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface UpdaterCallbacks {
  onUpdateReady: (version: string) => void
}

export function setupAutoUpdate(callbacks: UpdaterCallbacks): () => void {
  if (!app.isPackaged) {
    log.info('开发模式下跳过自动更新')
    return () => undefined
  }

  // app-update.yml 由 electron-builder 在正式打包时生成；--dir 构建或用户手工
  // 拷贝出来的目录版没有这个文件，此时检查更新只会反复报 ENOENT
  if (!existsSync(join(process.resourcesPath, 'app-update.yml'))) {
    log.info('缺少更新配置，跳过自动更新')
    return () => undefined
  }

  autoUpdater.autoDownload = true
  // 让用户自己决定什么时候重启，避免打断正在值守的任务
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', (info) => {
    log.info('新版本已下载完成', { version: info.version })
    callbacks.onUpdateReady(info.version)
  })
  // 更新失败只影响升级，不影响值守，记一条就够，不重复上报
  autoUpdater.on('error', (err) => log.warn('检查更新失败', String(err)))

  const check = (): void => {
    autoUpdater.checkForUpdates().catch(() => undefined)
  }

  check()
  const timer = setInterval(check, CHECK_INTERVAL_MS)
  timer.unref?.()

  return () => clearInterval(timer)
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall()
}
