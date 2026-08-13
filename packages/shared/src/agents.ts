/**
 * 8 个目标 Agent 的静态元数据与能力分级（PRD B3）。
 *
 * 能力分级来自各家 Hook 文档的实际能力，UI 必须如实标注，不得夸大：
 * - L3：完整生命周期 + 需确认识别 + 双向透传/回传
 * - L2：完整生命周期 + 需确认识别，透传能力受限（仅任务间隙注入）
 * - L1：仅能识别开始/完成/失败，不支持透传
 */

export const AGENT_IDS = [
  'claude-code',
  'chatgpt-codex',
  'workbuddy',
  'qoder-work',
  'trae-work',
  'cursor',
  'openclaw',
  'hermes'
] as const

export type AgentId = (typeof AGENT_IDS)[number]

export type CapabilityLevel = 'L1' | 'L2' | 'L3'

/**
 * 远程放行的支持程度。这里必须区分三档而不是一个布尔值：
 * Qoder 和 Hermes 的钩子只给了「阻断」的口子，没给「批准」的口子
 * （Hermes 的 approve 语义是*要求*人工确认，不是批准），
 * 把它们标成「可远程放行」就是骗用户。
 */
export type AuthMode = 'full' | 'deny-only' | 'none'

export interface AgentDescriptor {
  id: AgentId
  /** UI 显示名 */
  name: string
  /** UI 副标题 */
  subtitle: string
  level: CapabilityLevel
  /**
   * 是否支持把用户消息送进 Agent。
   * 所有 Agent 都没有「向运行中的交互式会话注入消息」的官方 API，
   * 这里为 true 表示可以用 Stop 钩子的同步响应窗口注入新指令。
   */
  canRelay: boolean
  /** 远程放行支持程度 */
  authMode: AuthMode
  /**
   * 授权闸门只能装在「工具调用前」，没有专用的授权事件。
   * 这类 Agent 每次工具调用都会触发钩子，挂起等确认会拖慢一切，
   * 所以要用户在设置里显式开启（remoteAuth.gateToolUseAgents）。
   */
  needsToolGate: boolean
  /** 是否支持无头拉起新会话（透传的兜底路径） */
  canHeadless: boolean
  /** 主配置文件路径（~ 开头，仅用于 UI 展示与用户排查） */
  configPath: string
  /** 该 Agent 的默认预期时长（毫秒），超时无进度判定为卡住 */
  stallTimeoutMs: number
}

const THIRTY_MIN = 30 * 60 * 1000

export const AGENT_REGISTRY: Record<AgentId, AgentDescriptor> = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    subtitle: 'AI 编程助手',
    level: 'L3',
    canRelay: true,
    authMode: 'full',
    needsToolGate: false,
    canHeadless: true,
    configPath: '~/.claude/settings.json',
    stallTimeoutMs: THIRTY_MIN
  },
  'chatgpt-codex': {
    id: 'chatgpt-codex',
    name: 'ChatGPT',
    subtitle: 'Codex 桌面应用',
    // 有专用的 PermissionRequest 事件，Stop 能注入新 prompt，还回传 last_assistant_message，
    // schema 与 Claude Code 高度同构，是完整体
    level: 'L3',
    canRelay: true,
    authMode: 'full',
    needsToolGate: false,
    canHeadless: false,
    configPath: '~/.codex/hooks.json',
    stallTimeoutMs: THIRTY_MIN
  },
  workbuddy: {
    id: 'workbuddy',
    name: 'Workbuddy',
    subtitle: 'CodeBuddy Code',
    // Stop 只能用 continue:false 续跑，拿不到 last_assistant_message，回传不了原文
    level: 'L2',
    canRelay: true,
    authMode: 'full',
    // 没有专用授权事件，只能拦在 PreToolUse 上
    needsToolGate: true,
    canHeadless: false,
    configPath: '~/.codebuddy/settings.json',
    stallTimeoutMs: THIRTY_MIN
  },
  'qoder-work': {
    id: 'qoder-work',
    name: 'Qoder Work',
    subtitle: 'AI 集成开发环境',
    level: 'L2',
    canRelay: true,
    // 文档只给了 exit 2 阻断，没给放行用的 stdout JSON
    authMode: 'deny-only',
    needsToolGate: false,
    canHeadless: false,
    configPath: '~/.qoderwork/settings.json',
    stallTimeoutMs: THIRTY_MIN
  },
  'trae-work': {
    id: 'trae-work',
    name: 'Trae Work',
    subtitle: 'AI 集成开发环境',
    // Stop 的 decision:block 会把 reason 当成新 Query，且带 last_assistant_message，能双向
    level: 'L3',
    canRelay: true,
    authMode: 'full',
    needsToolGate: true,
    canHeadless: false,
    configPath: '~/.trae-cn/hooks.json',
    stallTimeoutMs: THIRTY_MIN
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    subtitle: 'AI 编程 IDE',
    // preToolUse 原生给了 permission: allow/deny 两个方向，Stop 能用 followup_message 续跑，
    // 且有专门的 afterAgentResponse 能拿到回复原文，能力对齐 Claude/Codex 这一档
    level: 'L3',
    canRelay: true,
    authMode: 'full',
    // 没有专用授权事件，只有对所有工具调用都会触发的 preToolUse，默认关闭
    needsToolGate: true,
    canHeadless: false,
    configPath: '~/.cursor/hooks.json',
    stallTimeoutMs: THIRTY_MIN
  },
  openclaw: {
    id: 'openclaw',
    name: 'OpenClaw',
    subtitle: 'AI 助手',
    // 内部 hook 是 in-process TS handler，返回值不参与决策，只能观察
    level: 'L1',
    canRelay: false,
    authMode: 'none',
    needsToolGate: false,
    canHeadless: false,
    configPath: '~/.openclaw/hooks/',
    stallTimeoutMs: THIRTY_MIN
  },
  hermes: {
    id: 'hermes',
    name: 'Hermes',
    subtitle: 'AI 助手',
    // pre_verify 返回 action:continue 就能带着新指令续跑，所以透传是可行的
    level: 'L2',
    canRelay: true,
    // pre_tool_call 能阻断，但 approve 的语义是「升级为人工确认」而非批准
    authMode: 'deny-only',
    needsToolGate: true,
    canHeadless: false,
    configPath: '~/.hermes/config.yaml',
    stallTimeoutMs: THIRTY_MIN
  }
}

export const ALL_AGENTS: AgentDescriptor[] = AGENT_IDS.map((id) => AGENT_REGISTRY[id])

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value)
}

export function agentName(id: AgentId): string {
  return AGENT_REGISTRY[id]?.name ?? id
}

export const CAPABILITY_LABEL: Record<CapabilityLevel, string> = {
  L3: '完整接入 · 可远程确认与对话',
  L2: '标准接入 · 可远程确认',
  L1: '基础接入 · 仅通知'
}

export const AUTH_MODE_LABEL: Record<AuthMode, string> = {
  full: '可在微信里放行或拒绝',
  'deny-only': '只能在微信里拒绝，放行需回到电脑',
  none: '无法远程确认，只能收通知'
}
