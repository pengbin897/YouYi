/**
 * preload：渲染进程唯一的对外通道。
 * 只暴露白名单方法，不暴露 ipcRenderer 本体，也不开 nodeIntegration。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type YouyiBridgeApi } from '@youyi/shared'

const api: YouyiBridgeApi = {
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),
  getTasks: () => ipcRenderer.invoke(IPC.getTasks),
  getTaskDetail: (taskId) => ipcRenderer.invoke(IPC.getTaskDetail, taskId),
  getAuditLogs: (limit) => ipcRenderer.invoke(IPC.getAuditLogs, limit),
  getDiscovery: () => ipcRenderer.invoke(IPC.getDiscovery),
  getAgentStates: () => ipcRenderer.invoke(IPC.getAgentStates),
  getPendingAuths: () => ipcRenderer.invoke(IPC.getPendingAuths),
  getChannelStates: () => ipcRenderer.invoke(IPC.getChannelStates),
  enableAgents: (ids) => ipcRenderer.invoke(IPC.enableAgents, ids),
  resolveAuth: (resolution) => ipcRenderer.invoke(IPC.resolveAuth, resolution),
  muteTask: (taskId, muted) => ipcRenderer.invoke(IPC.muteTask, taskId, muted),
  bindWechat: () => ipcRenderer.invoke(IPC.bindWechat),
  submitVerifyCode: (code) => ipcRenderer.invoke(IPC.submitVerifyCode, code),
  testChannel: (id) => ipcRenderer.invoke(IPC.testChannel, id),
  exportAudit: () => ipcRenderer.invoke(IPC.exportAudit),
  clearAllData: () => ipcRenderer.invoke(IPC.clearAllData),
  finishOnboarding: () => ipcRenderer.invoke(IPC.finishOnboarding),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  quitApp: () => ipcRenderer.invoke(IPC.quitApp),

  on: <T>(channel: string, handler: (payload: T) => void) => {
    const listener = (_event: unknown, payload: T): void => handler(payload)
    ipcRenderer.on(channel, listener as never)
    return () => ipcRenderer.off(channel, listener as never)
  }
}

contextBridge.exposeInMainWorld('youyi', api)
