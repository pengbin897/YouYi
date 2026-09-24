/** 八家适配器的装配入口 */

import type { AgentAdapter } from './types.js'
import { JsonHooksAdapter } from './base/json-hooks-adapter.js'
import { CODEX_DIALECT, QODER_DIALECT, TRAE_DIALECT } from './base/dialect.js'
import { ClaudeCodeAdapter } from './claude-code.js'
import { CursorAdapter } from './cursor.js'
import { HermesAdapter } from './hermes.js'
import { OpenClawAdapter } from './openclaw.js'
import { WorkbuddyAdapter } from './workbuddy.js'

export function createAdapters(): AgentAdapter[] {
  return [
    // 前五家钩子机制同构，差异全在方言表里
    new ClaudeCodeAdapter(),
    new JsonHooksAdapter(CODEX_DIALECT),
    // Workbuddy 额外支持 SDK 无头续跑（前端会话续聊），走子类覆写
    new WorkbuddyAdapter(),
    new JsonHooksAdapter(QODER_DIALECT),
    new JsonHooksAdapter(TRAE_DIALECT),
    // 这三家机制特殊：Cursor 的配置是扁平结构且字段名不同构，
    // Hermes 是 YAML + 出站 webhook，OpenClaw 要生成 TS handler
    new CursorAdapter(),
    new HermesAdapter(),
    new OpenClawAdapter()
  ]
}
