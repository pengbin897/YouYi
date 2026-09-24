/**
 * Claude Code 适配器。
 *
 * 八家里能力最完整的一家，也是其余几家的参照系：原生支持 `type: "http"` 钩子，
 * PermissionRequest 能返回 allow/deny 决策，Stop 能用 `decision: "block"` 把新指令
 * 送回对话。归一化与决策流程都在 JsonHooksAdapter 里，这里只提供方言。
 *
 * 两个必须处理的坑（已在基类实现）：
 * - Stop 注入必须检查 `stop_hook_active`，否则会和 Claude 自己的续跑逻辑打架，
 *   连续 block 到上限后会被强制中断。
 * - HTTP 钩子的自定义请求头依赖用户 shell 里的环境变量，我们注入不了，
 *   所以 token 放在 URL 路径里（端点只监听回环地址）。
 */

import { JsonHooksAdapter } from './base/json-hooks-adapter.js'
import { CLAUDE_CODE_DIALECT } from './base/dialect.js'

export class ClaudeCodeAdapter extends JsonHooksAdapter {
  constructor() {
    super(CLAUDE_CODE_DIALECT)
  }
}

export { describeTool, summarize } from './base/describe.js'
