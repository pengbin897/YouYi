/** 开机自启（PRD A1：默认关闭，引导时提示开启） */

import { app } from 'electron'
import { createLogger } from '../util/logger.js'

const log = createLogger('auto-launch')

export function setAutoLaunch(enabled: boolean): void {
  if (!app.isPackaged) {
    log.info('开发模式下不修改登录项', { enabled })
    return
  }

  try {
    // 状态一致时不去写：从非 /Applications 位置运行时系统会拒绝写登录项，
    // 每次启动都白报一次错没有意义（默认关闭，绝大多数启动都走这条分支）
    if (app.getLoginItemSettings().openAtLogin === enabled) return

    app.setLoginItemSettings({
      openAtLogin: enabled,
      // 自启时不弹主窗口，直接进托盘值守
      openAsHidden: true,
      args: ['--hidden']
    })
    log.info('登录项已更新', { enabled })
  } catch (err) {
    log.warn('登录项写入失败，请确认应用已放入应用程序目录', String(err))
  }
}

export function isAutoLaunchEnabled(): boolean {
  if (!app.isPackaged) return false
  return app.getLoginItemSettings().openAtLogin
}

/** 是否以「随系统启动」或 --hidden 方式拉起，用于决定要不要显示主窗口 */
export function shouldStartHidden(): boolean {
  if (process.argv.includes('--hidden')) return true
  if (!app.isPackaged) return false
  return app.getLoginItemSettings().wasOpenedAtLogin === true
}
