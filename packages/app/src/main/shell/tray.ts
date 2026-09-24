/** 托盘菜单（PRD G3）：实时显示运行中任务数与最近事件，点击可恢复主窗口 */

import { Menu, Tray, app } from 'electron'
import { STATUS_LABEL, agentName, type Task, type UnifiedEvent } from '@youyi/shared'
import { trayIcon } from './icon.js'

export interface TrayCallbacks {
  onOpen: () => void
  onQuit: () => void
  onToggleWatch: (watching: boolean) => void
}

export class TrayManager {
  private tray: Tray | null = null
  private tasks: Task[] = []
  private recentEvents: UnifiedEvent[] = []
  private watching = true

  constructor(private readonly callbacks: TrayCallbacks) {}

  create(): void {
    if (this.tray) return
    this.tray = new Tray(trayIcon('watching'))
    this.tray.setToolTip('游奕 · 哨兵')
    // Windows/Linux 上左键点击习惯是直接打开主界面
    this.tray.on('click', () => this.callbacks.onOpen())
    this.render()
  }

  update(tasks: Task[], recentEvents: UnifiedEvent[]): void {
    this.tasks = tasks
    this.recentEvents = recentEvents.slice(-5)
    this.render()
  }

  setWatching(watching: boolean): void {
    this.watching = watching
    this.tray?.setImage(trayIcon(watching ? 'watching' : 'idle'))
    this.render()
  }

  private render(): void {
    if (!this.tray) return

    const running = this.tasks.filter((t) => t.status === 'RUNNING').length
    const needsAuth = this.tasks.filter((t) => t.status === 'NEEDS_AUTH').length

    const summary = needsAuth > 0 ? `${running} 个进行中 · ${needsAuth} 个待确认` : `${running} 个任务进行中`

    const taskItems =
      this.tasks.length === 0
        ? [{ label: '暂无任务', enabled: false }]
        : this.tasks.slice(0, 6).map((task) => ({
            label: `${STATUS_LABEL[task.status]} · ${truncate(task.title, 24)}`,
            click: () => this.callbacks.onOpen()
          }))

    const eventItems =
      this.recentEvents.length === 0
        ? [{ label: '暂无事件', enabled: false }]
        : this.recentEvents
            .slice()
            .reverse()
            .map((event) => ({
              label: `${agentName(event.agent_id)} · ${truncate(event.title, 28)}`,
              click: () => this.callbacks.onOpen()
            }))

    const menu = Menu.buildFromTemplate([
      { label: summary, enabled: false },
      { type: 'separator' },
      { label: '任务', submenu: taskItems },
      { label: '最近事件', submenu: eventItems },
      { type: 'separator' },
      { label: '打开面板', click: () => this.callbacks.onOpen() },
      {
        label: this.watching ? '暂停值守' : '继续值守',
        click: () => this.callbacks.onToggleWatch(!this.watching)
      },
      { type: 'separator' },
      { label: '退出哨兵', click: () => this.callbacks.onQuit() }
    ])

    this.tray.setContextMenu(menu)
    // macOS 菜单栏上直接显示待确认数量，让「需要你」这件事一眼可见
    if (process.platform === 'darwin') {
      this.tray.setTitle(needsAuth > 0 ? ` ${needsAuth}` : '')
    }
    app.setBadgeCount?.(needsAuth)
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
