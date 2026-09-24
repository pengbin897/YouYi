/**
 * 上行消息意图解析（PRD D1）。
 *
 * 设计原则：识别不出来的一律当作「要透传给 Agent 的话」，而不是回一句「听不懂」。
 * 微信这个渠道的价值就在于原样透传，指令词只是少数几个高频快捷方式。
 */

import { AGENT_IDS, AGENT_REGISTRY, type AgentId } from '@youyi/shared'

export type Intent =
  /** 放行挂起中的授权请求 */
  | { kind: 'approve' }
  /** 拒绝挂起中的授权请求 */
  | { kind: 'deny' }
  /** 查询状态，哨兵自答，不打扰任何 Agent */
  | { kind: 'status' }
  /** 停止全部任务，需要二次确认 */
  | { kind: 'stop-all' }
  /** 对二次确认的确认 */
  | { kind: 'stop-all-confirm' }
  | { kind: 'help' }
  /** 透传给某个 Agent；agentId 为空表示由路由器判定默认目标 */
  | { kind: 'relay'; agentId?: AgentId; text: string }

const APPROVE_WORDS = ['继续', '确认', '允许', '同意', '可以', '放行', '好的', 'y', 'yes', 'ok']
const DENY_WORDS = ['停止', '拒绝', '不行', '不要', '取消', 'n', 'no', 'stop']
const STATUS_WORDS = ['状态', '进度', '怎么样了', '什么情况', 'status']
const HELP_WORDS = ['帮助', '怎么用', 'help', '?', '？']
const STOP_ALL_WORDS = ['全部停止', '停止全部', '停止所有', '全部暂停', 'stop all']
const STOP_ALL_CONFIRM = ['确认停止', '确认全部停止', '是的停止']

/** 「交给 Claude：帮我看下日志」「@codex 继续跑」 */
const HANDOFF_PATTERN = /^(?:交给|转给|让|@)\s*([^\s：:，,]+)\s*[：:，,]?\s*([\s\S]*)$/
const NEW_TASK_PATTERN = /^(?:新任务|新建任务|开始任务)\s*[：:]\s*([\s\S]+)$/

export function parseIntent(raw: string): Intent {
  const text = raw.trim()
  if (!text) return { kind: 'relay', text: '' }

  const normalized = text.toLowerCase().replace(/[。！!.\s]+$/g, '')

  // 「全部停止」必须比「停止」先判定，否则会被当成拒绝单个请求
  if (STOP_ALL_CONFIRM.some((w) => normalized === w)) return { kind: 'stop-all-confirm' }
  if (STOP_ALL_WORDS.some((w) => normalized === w)) return { kind: 'stop-all' }

  // 指令词只在「整条消息就是这个词」时生效。用户说「继续跑测试」显然是要透传，
  // 不能因为开头有「继续」两个字就当成放行。
  if (APPROVE_WORDS.includes(normalized)) return { kind: 'approve' }
  if (DENY_WORDS.includes(normalized)) return { kind: 'deny' }
  if (STATUS_WORDS.includes(normalized)) return { kind: 'status' }
  if (HELP_WORDS.includes(normalized)) return { kind: 'help' }

  const newTask = NEW_TASK_PATTERN.exec(text)
  if (newTask) return { kind: 'relay', text: newTask[1].trim() }

  const handoff = HANDOFF_PATTERN.exec(text)
  if (handoff) {
    const agentId = matchAgent(handoff[1])
    if (agentId && handoff[2].trim()) {
      return { kind: 'relay', agentId, text: handoff[2].trim() }
    }
  }

  return { kind: 'relay', text }
}

/** 按 Agent 名称做模糊匹配，允许用户只说「claude」「codex」这类简称 */
export function matchAgent(input: string): AgentId | null {
  const needle = input.trim().toLowerCase()
  if (!needle) return null

  for (const id of AGENT_IDS) {
    if (id.toLowerCase() === needle) return id
  }
  for (const id of AGENT_IDS) {
    const meta = AGENT_REGISTRY[id]
    const candidates = [id, meta.name, meta.name.replace(/\s+/g, '')].map((c) => c.toLowerCase())
    if (candidates.some((c) => c.includes(needle) || needle.includes(c))) return id
  }
  return null
}
