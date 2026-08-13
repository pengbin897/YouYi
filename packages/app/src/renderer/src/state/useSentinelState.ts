/**
 * 渲染进程的全局状态。
 *
 * 主进程是唯一数据源：首次挂载时拉一次全量，之后靠推送增量更新。
 * 不在渲染进程做任何业务判断，避免两边状态机不一致。
 */

import { useCallback, useEffect, useState } from 'react'
import {
  IPC,
  type AgentRuntimeState,
  type AppSettings,
  type ChannelState,
  type PendingAuth,
  type Task,
  type ToastPayload,
  type UnifiedEvent
} from '@youyi/shared'

export interface SentinelState {
  settings: AppSettings | null
  tasks: Task[]
  pendingAuths: PendingAuth[]
  agents: AgentRuntimeState[]
  channels: ChannelState[]
  events: UnifiedEvent[]
  toast: ToastPayload | null
  loading: boolean
}

const EVENT_BUFFER = 50

export function useSentinelState(): SentinelState & {
  refresh: () => Promise<void>
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>
  dismissToast: () => void
  showToast: (toast: ToastPayload) => void
} {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [pendingAuths, setPendingAuths] = useState<PendingAuth[]>([])
  const [agents, setAgents] = useState<AgentRuntimeState[]>([])
  const [channels, setChannels] = useState<ChannelState[]>([])
  const [events, setEvents] = useState<UnifiedEvent[]>([])
  const [toast, setToast] = useState<ToastPayload | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const [nextSettings, nextTasks, nextPending, nextAgents, nextChannels] = await Promise.all([
      window.youyi.getSettings(),
      window.youyi.getTasks(),
      window.youyi.getPendingAuths(),
      window.youyi.getAgentStates(),
      window.youyi.getChannelStates()
    ])
    setSettings(nextSettings)
    setTasks(nextTasks)
    setPendingAuths(nextPending)
    setAgents(nextAgents)
    setChannels(nextChannels)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()

    const offs = [
      window.youyi.on<Task[]>(IPC.pushTasks, setTasks),
      window.youyi.on<PendingAuth[]>(IPC.pushPendingAuths, setPendingAuths),
      window.youyi.on<AgentRuntimeState[]>(IPC.pushAgentStates, setAgents),
      window.youyi.on<ChannelState[]>(IPC.pushChannelStates, setChannels),
      window.youyi.on<ToastPayload>(IPC.pushToast, setToast),
      window.youyi.on<UnifiedEvent>(IPC.pushEvent, (event) =>
        setEvents((prev) => [...prev, event].slice(-EVENT_BUFFER))
      )
    ]
    return () => offs.forEach((off) => off())
  }, [refresh])

  const patchSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await window.youyi.setSettings(patch)
    setSettings(next)
  }, [])

  return {
    settings,
    tasks,
    pendingAuths,
    agents,
    channels,
    events,
    toast,
    loading,
    refresh,
    patchSettings,
    dismissToast: () => setToast(null),
    showToast: setToast
  }
}
