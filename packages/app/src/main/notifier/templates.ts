/**
 * 通知文案模板（PRD 设计文档 §6.1）。
 *
 * 微信没有卡片按钮，所有可执行的操作只能靠「引导语」用文字承载，
 * 因此每条需要用户动作的通知都必须带上可回复的关键词。
 */

import { agentName, type Task, type UnifiedEvent } from '@youyi/shared'

/** 通用引导语。放在通知末尾，告诉用户此刻可以回复什么。 */
export const GUIDE_DEFAULT = '回复：继续 / 停止 / 状态 / 新任务：xxx'
export const GUIDE_AUTH = '回复：继续（放行） / 停止（拒绝） / 状态'
export const GUIDE_DENY_ONLY = '这家只支持远程拒绝。回复：停止（拒绝） / 状态；放行请回电脑操作'
export const GUIDE_HIGH_RISK = '这个操作需要你回电脑确认。回复：状态 / 停止'

/** 按这次确认在微信上究竟能做什么来选引导语，不能对着做不到的事发指令 */
function authGuide(event: UnifiedEvent): string {
  switch (event.auth_options) {
    case 'local-only':
      return GUIDE_HIGH_RISK
    case 'deny-only':
      return GUIDE_DENY_ONLY
    default:
      return GUIDE_AUTH
  }
}

export function renderEvent(event: UnifiedEvent, task: Task): string {
  const name = agentName(event.agent_id)

  switch (event.type) {
    case 'auth_required':
      return [`[${name}] ${event.title}`, event.detail, '', authGuide(event)].join('\n')

    case 'task_failed':
      return [
        `[${name}] 任务失败`,
        `「${task.title}」${event.detail}`,
        '',
        GUIDE_DEFAULT
      ].join('\n')

    case 'task_stalled':
      return [`[${name}] ${event.title}`, event.detail, '', GUIDE_DEFAULT].join('\n')

    case 'task_completed':
      return [
        `[${name}] 任务完成`,
        `「${task.title}」耗时 ${formatDuration(task)}。`,
        task.summary ? `\n${truncate(task.summary, 200)}` : '',
        '',
        GUIDE_DEFAULT
      ]
        .filter(Boolean)
        .join('\n')

    case 'task_progress':
      return [
        `[${name}] 进度更新`,
        `「${task.title}」已完成约 ${Math.round(task.progress * 100)}%。`,
        '',
        GUIDE_DEFAULT
      ].join('\n')

    default:
      return [`[${name}] ${event.title}`, event.detail].join('\n')
  }
}

/** 同一 Agent 短时间内多个任务完成时的汇总文案 */
export function renderMerged(events: UnifiedEvent[], tasks: Task[]): string {
  const name = agentName(events[0].agent_id)
  const lines = tasks.map((task) => `· ${task.title}（耗时 ${formatDuration(task)}）`)
  return [`[${name}] ${tasks.length} 个任务完成了`, ...lines, '', GUIDE_DEFAULT].join('\n')
}

/** 早报（PRD F3）：按 Agent 分组列出免打扰期间的完成与失败 */
export function renderDigest(groups: { agent: string; completed: Task[]; failed: Task[] }[]): string {
  const sections = groups.map((group) => {
    const lines = [`【${group.agent}】`]
    for (const task of group.completed) lines.push(`· 完成：${task.title}`)
    for (const task of group.failed) lines.push(`· 失败：${task.title}`)
    return lines.join('\n')
  })

  const total = groups.reduce((sum, g) => sum + g.completed.length + g.failed.length, 0)
  return [
    `早上好。免打扰期间有 ${total} 个任务有了结果：`,
    '',
    ...sections,
    '',
    GUIDE_DEFAULT
  ].join('\n')
}

export function formatDuration(task: Task): string {
  const end = task.finished_at ? new Date(task.finished_at) : new Date()
  const ms = end.getTime() - new Date(task.started_at).getTime()
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分钟`
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
