/** Electron 主进程入口：生命周期、单实例、托盘常驻、崩溃自愈 */

import { app, dialog } from 'electron'
import { Sentinel } from './sentinel.js'
import { WindowManager } from './shell/window.js'
import { TrayManager } from './shell/tray.js'
import { Watchdog, installCrashGuards } from './shell/watchdog.js'
import { setupAutoUpdate, quitAndInstall } from './shell/updater.js'
import { setAutoLaunch, shouldStartHidden } from './shell/auto-launch.js'
import { registerIpc } from './ipc.js'
import { createLogger } from './util/logger.js'
import { augmentUserPath } from './util/user-path.js'

const log = createLogger('main')

// 值守类应用绝不能出现两个实例：两个 HookServer 会抢同一个端口和连接文件
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {

const windows = new WindowManager()
const watchdog = new Watchdog()
let sentinel: Sentinel | null = null
let tray: TrayManager | null = null
let stopUpdateCheck: (() => void) | null = null
let quitting = false
let startupComplete = false
let pendingShow = false

async function quit(): Promise<void> {
  if (quitting) return
  quitting = true

  watchdog.markCleanExit()
  stopUpdateCheck?.()
  windows.prepareQuit()
  tray?.destroy()

  // 清理步骤（停哨兵、关 HookServer 等）理论上都很快，但任何一环意外卡住
  // （比如某个没断干净的长连接）都会让「退出哨兵」看起来毫无反应——比多等几秒更糟。
  // 兜底超时到点后不管清理有没有做完，都继续往下走强制退出。
  const cleanup = sentinel?.stop().catch((err) => log.error('停止哨兵时出错', String(err)))
  await Promise.race([cleanup, delay(5000)])

  app.quit()
  // 万一 app.quit() 本身也被某个未闭合的资源拖住，2 秒后直接硬退，不留一个卡死的进程
  setTimeout(() => app.exit(0), 2000).unref()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function showMainWindow(): void {
  if (!app.isReady() || !startupComplete) {
    pendingShow = true
    return
  }
  windows.show()
}

app.on('second-instance', () => showMainWindow())

app.on('window-all-closed', () => {
  // 关掉窗口只是收进托盘，不退出应用（PRD A1）
})

app.on('activate', () => showMainWindow())

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && shouldStartHidden()) {
    app.dock?.hide()
  }

  installCrashGuards(() => {
    // 未捕获异常后自己重启一次，比留一个半死不活的进程要好
    app.relaunch()
    app.exit(1)
  })
  watchdog.start()

  // 必须在自动发现之前：从 Finder 拉起时 PATH 是残缺的，不补齐会漏掉大部分 Agent
  await augmentUserPath()

  sentinel = new Sentinel()

  try {
    await sentinel.start()
  } catch (err) {
    log.error('哨兵启动失败', String(err))
    dialog.showErrorBox('游奕启动失败', `${String(err)}\n\n可以查看 ~/.youyi/logs 下的日志。`)
  }

  tray = new TrayManager({
    onOpen: () => showMainWindow(),
    onQuit: () => void quit(),
    onToggleWatch: (watching) => {
      sentinel?.setWatching(watching)
      tray?.setWatching(watching)
    }
  })
  tray.create()

  const refreshTray = (): void => {
    if (!sentinel) return
    tray?.update(sentinel.store.tasks.listActive(), sentinel.getRecentEvents())
  }
  sentinel.on('state-changed', refreshTray)
  sentinel.on('task-updated', refreshTray)
  refreshTray()

  registerIpc(sentinel, windows)

  const settings = sentinel.settings.get()
  setAutoLaunch(settings.autoLaunch)

  stopUpdateCheck = setupAutoUpdate({
    onUpdateReady: async (version) => {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['稍后', '立即重启'],
        defaultId: 0,
        title: '新版本已就绪',
        message: `游奕 ${version} 已经下载完成。`,
        detail: '重启后生效。正在跑的任务不会丢，状态都存在本地。'
      })
      if (response === 1) {
        watchdog.markCleanExit()
        quitAndInstall()
      }
    }
  })

  // 首次启动或还没走完引导时，直接把窗口打开
  startupComplete = true
  const shouldShow = pendingShow || !settings.onboarded || !shouldStartHidden()
  pendingShow = false
  if (shouldShow) {
    showMainWindow()
  } else {
    windows.create()
  }

  log.info('游奕已启动')
})

app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  void quit()
})
}
