/** 主窗口管理：关窗即隐藏（close-to-tray），真正退出只能从托盘菜单发起（PRD A1） */

import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'

export class WindowManager {
  private window: BrowserWindow | null = null
  /** 用户是否点了「退出哨兵」。只有这时关闭窗口才真的销毁。 */
  private quitting = false

  create(): BrowserWindow | null {
    if (this.window && !this.window.isDestroyed()) {
      return this.window
    }
    if (!app.isReady()) return null

    const window = new BrowserWindow({
      width: 1120,
      height: 760,
      minWidth: 900,
      minHeight: 620,
      show: false,
      title: '游奕 · 哨兵',
      backgroundColor: '#F5F6F8',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        // 渲染进程不直接碰 Node，一切经 preload 白名单化的 IPC
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    window.on('ready-to-show', () => window.show())

    window.on('close', (event) => {
      if (!this.quitting) {
        event.preventDefault()
        window.hide()
        // macOS 上同时把 Dock 图标隐掉，更像一个后台常驻工具
        if (process.platform === 'darwin') {
          const { app } = require('electron') as typeof import('electron')
          app.dock?.hide()
        }
      }
    })

    window.on('closed', () => {
      this.window = null
    })

    // 外链一律走系统浏览器，不在应用内开新窗口
    window.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })

    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl) {
      void window.loadURL(devUrl)
    } else {
      void window.loadFile(join(__dirname, '../renderer/index.html'))
    }

    this.window = window
    return window
  }

  show(): void {
    const window = this.create()
    if (!window) return
    if (process.platform === 'darwin') {
      const { app } = require('electron') as typeof import('electron')
      void app.dock?.show()
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  get current(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null
  }

  /** 向渲染进程推送数据；窗口没开时静默丢弃 */
  send(channel: string, payload: unknown): void {
    this.current?.webContents.send(channel, payload)
  }

  prepareQuit(): void {
    this.quitting = true
  }
}
