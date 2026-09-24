/** 把厂商原始 payload 翻译成人话，通知与授权请求都用这里的文案 */

/** 把工具调用描述成一句人话 */
export function describeTool(toolName: string | undefined, input: unknown): string {
  const name = toolName ?? '未知工具'
  if (!input || typeof input !== 'object') return `${name}`

  const data = input as Record<string, unknown>
  if (typeof data.command === 'string') return `执行命令：${data.command}`
  if (typeof data.file_path === 'string') return `${name} 操作文件：${data.file_path}`
  if (typeof data.path === 'string') return `${name} 操作路径：${data.path}`
  if (typeof data.url === 'string') return `${name} 访问：${data.url}`
  if (typeof data.pattern === 'string') return `${name} 搜索：${data.pattern}`

  const json = JSON.stringify(data)
  return `${name}：${json.length > 200 ? `${json.slice(0, 200)}…` : json}`
}

/** 用用户 prompt 的首句当任务名 */
export function summarize(prompt: string): string {
  const firstLine = prompt.split('\n').find((line) => line.trim()) ?? prompt
  const clean = firstLine.trim().replace(/^\/\S+\s*/, '')
  return clean.length > 30 ? `${clean.slice(0, 30)}…` : clean || '未命名任务'
}

/**
 * 只读工具白名单。
 *
 * 没有专用授权钩子的 Agent（Trae / Workbuddy / Qoder）只能在 PreToolUse 上拦，
 * 而 PreToolUse 每次工具调用都会触发。若无脑挂起，读文件、搜代码都会卡住等微信回复。
 * 所以只对「会改东西」的调用挂起，读类调用一律直接放过。
 *
 * 名单按各家文档里的工具名收集：Claude/Codex/Workbuddy/Qoder 用 Read/Glob/Grep 系，
 * Trae 另有 LS，Hermes 用小写下划线风格。
 */
const READ_ONLY_TOOLS = new Set(
  [
    'read',
    'readfile',
    'ls',
    'glob',
    'grep',
    'search',
    'searchcodebase',
    'websearch',
    'webfetch',
    'todowrite',
    'todoread',
    'askuserquestion',
    'listdirectory',
    'view',
    'viewfile',
    'read_file',
    'list_files'
  ].map((n) => n.toLowerCase())
)

/**
 * 这次调用是否会改动环境（写文件 / 执行命令 / 联网提交）。
 * 判不准时一律按「会改动」处理——宁可多问一次，也不能悄悄放过破坏性操作。
 */
export function isConsequentialTool(toolName: string | undefined, input: unknown): boolean {
  const name = (toolName ?? '').toLowerCase()
  if (!name) return true
  if (READ_ONLY_TOOLS.has(name)) return false

  // MCP 工具的行为完全取决于第三方服务端，无法判断，按会改动处理
  if (name.startsWith('mcp__')) return true

  // 有 command 字段就是要执行东西
  if (input && typeof input === 'object') {
    const data = input as Record<string, unknown>
    if (typeof data.command === 'string') return true
  }

  return true
}
