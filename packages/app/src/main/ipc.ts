/** 主进程 IPC 处理器。渲染进程的所有能力都必须经过这里，不给它任何直接的系统访问。 */

import { writeFileSync } from 'node:fs'
import { app, dialog, ipcMain, shell } from 'electron'
import { toDataURL } from 'qrcode'
import {
  AGENT_REGISTRY,
  IPC,
  type AgentId,
  type AgentRuntimeState,
  type AppSettings,
  type AuthResolution
} from '@youyi/shared'
import type { Sentinel } from './sentinel.js'
import type { WindowManager } from './shell/window.js'
import { setAutoLaunch } from './shell/auto-launch.js'
import { createLogger } from './util/logger.js'

const log = createLogger('ipc')

export function registerIpc(sentinel: Sentinel, windows: WindowManager): void {
  const handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>): void => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...(args as never[]))
      } catch (err) {
        log.error('IPC 处理失败', { channel, error: String(err) })
        throw err
      }
    })
  }

  handle(IPC.getSettings, () => sentinel.settings.get())

  handle(IPC.setSettings, async (patch: Partial<AppSettings>) => {
    const next = sentinel.settings.patch(patch)
    if (patch.autoLaunch !== undefined) setAutoLaunch(patch.autoLaunch)
    // 渠道相关的改动需要重建连接
    if (patch.channels || patch.primaryChannel || patch.fallbackChannels) {
      await sentinel.channels.reload()
    }
    return next
  })

  handle(IPC.getTasks, () => sentinel.store.tasks.list({ limit: 100 }))

  handle(IPC.getTaskDetail, (taskId: string) => {
    const task = sentinel.store.tasks.get(taskId)
    if (!task) return null
    return { task, events: sentinel.store.events.listByTask(taskId) }
  })

  handle(IPC.getAuditLogs, (limit?: number) => sentinel.store.audit.list(limit ?? 200))

  handle(IPC.getDiscovery, () => sentinel.adapters.detectAll())

  handle(IPC.getAgentStates, () => buildAgentStates(sentinel))

  handle(IPC.getPendingAuths, () => sentinel.pending.list())

  handle(IPC.getChannelStates, () => sentinel.channels.getStates())

  handle(IPC.enableAgents, async (ids: AgentId[]) => {
    await sentinel.applyAgentSelection(ids)
    return buildAgentStates(sentinel)
  })

  handle(IPC.resolveAuth, (resolution: AuthResolution) => {
    const allowPermanent = sentinel.settings.get().remoteAuth.allowPermanentRules
    sentinel.pending.resolve(resolution.id, resolution.decision, {
      permanent: allowPermanent && resolution.permanent === true,
      source: resolution.source
    })
  })

  handle(IPC.muteTask, (taskId: string, muted: boolean) => {
    sentinel.store.tasks.setMuted(taskId, muted)
  })

  handle(IPC.bindWechat, async () => {
    await sentinel.channels.startWechat(sentinel.settings.get().channels.wechat.boundUserId)
  })

  handle(IPC.submitVerifyCode, (code: string) => sentinel.channels.submitVerifyCode(code))

  handle(IPC.testChannel, (id: string) => sentinel.channels.test(id as never))

  handle(IPC.exportAudit, async () => {
    const result = await dialog.showSaveDialog({
      title: '导出审计日志',
      defaultPath: `youyi-audit-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, JSON.stringify(sentinel.store.audit.list(5000), null, 2), 'utf8')
    return result.filePath
  })

  handle(IPC.clearAllData, async () => {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['取消', '确认清除'],
      defaultId: 0,
      cancelId: 0,
      title: '清除全部数据',
      message: '这会删除本地所有任务、事件、审计日志与设置，且无法恢复。',
      detail: '各个 Agent 里的钩子配置需要在设置里单独取消勾选才会移除。'
    })
    if (response !== 1) return
    sentinel.clearAllData()
  })

  handle(IPC.finishOnboarding, () => {
    sentinel.settings.patch({ onboarded: true })
  })

  handle(IPC.openExternal, async (url: string) => {
    await shell.openExternal(url)
  })

  handle(IPC.quitApp, () => {
    app.quit()
  })

  // 主进程 → 渲染进程的状态推送
  const pushState = (): void => {
    windows.send(IPC.pushTasks, sentinel.store.tasks.list({ limit: 100 }))
    windows.send(IPC.pushPendingAuths, sentinel.pending.list())
    windows.send(IPC.pushAgentStates, buildAgentStates(sentinel))
    windows.send(IPC.pushChannelStates, sentinel.channels.getStates())
  }

  sentinel.on('state-changed', pushState)
  sentinel.on('task-updated', pushState)
  sentinel.on('event', (event) => windows.send(IPC.pushEvent, event))
  sentinel.channels.on('wechat-qr', (url) => {
    // SDK 只给登录 URL，二维码图像在主进程生成，渲染进程不必引入编码库
    toDataURL(url, { width: 380, margin: 1 })
      .then((dataUrl) => windows.send(IPC.pushWechatQr, dataUrl))
      .catch((err) => {
        log.error('二维码生成失败', String(err))
        windows.send(IPC.pushToast, { kind: 'error', message: '二维码生成失败，请重试绑定' })
      })
  })
  sentinel.channels.on('verify-code-required', (isRetry) =>
    windows.send(IPC.pushVerifyCodeRequired, isRetry)
  )
  sentinel.channels.on('wechat-status', (status) => {
    // session-expired 单独给一条更明确的提示：渠道内部已经在自愈了，
    // 用户只需要等新二维码推过来重新扫码，不用自己再点一次「重新绑定」
    const message =
      status === 'session-expired'
        ? '微信登录已过期，正在自动重新拉取二维码，请稍候重新扫码'
        : `微信状态：${status}`
    windows.send(IPC.pushToast, { kind: status === 'session-expired' ? 'error' : 'info', message })
  })
}

function buildAgentStates(sentinel: Sentinel): AgentRuntimeState[] {
  const enabled = sentinel.settings.get().enabledAgents
  const tasks = sentinel.store.tasks.listActive()

  return sentinel.adapters.all().map((adapter) => {
    const meta = AGENT_REGISTRY[adapter.id]
    const agentTasks = tasks.filter((t) => t.agent_id === adapter.id)
    const lastEvent = sentinel
      .getRecentEvents()
      .filter((e) => e.agent_id === adapter.id)
      .at(-1)

    return {
      id: adapter.id,
      enabled: enabled.includes(adapter.id),
      hookInstalled: enabled.includes(adapter.id),
      running: agentTasks.length > 0,
      level: meta.level,
      lastEventAt: lastEvent?.occurred_at,
      runningTasks: agentTasks.filter((t) => t.status === 'RUNNING').length
    }
  })
}
