/** 八家适配器的装配入口 */

import type { AgentAdapter } from './types.js'
import { JsonHooksAdapter } from './base/json-hooks-adapter.js'
import {
  CODEX_DIALECT,
  QODER_DIALECT,
  TRAE_DIALECT,
  WORKBUDDY_DIALECT
} from './base/dialect.js'
import { ClaudeCodeAdapter } from './claude-code.js'
import { CursorAdapter } from './cursor.js'
import { HermesAdapter } from './hermes.js'
import { OpenClawAdapter } from './openclaw.js'

export function createAdapters(): AgentAdapter[] {
  return [
    // 前五家钩子机制同构，差异全在方言表里
    new ClaudeCodeAdapter(),
    new JsonHooksAdapter(CODEX_DIALECT),
    new JsonHooksAdapter(WORKBUDDY_DIALECT),
    new JsonHooksAdapter(QODER_DIALECT),
    new JsonHooksAdapter(TRAE_DIALECT),
    // 这三家机制特殊：Cursor 的配置是扁平结构且字段名不同构，
    // Hermes 是 YAML + 出站 webhook，OpenClaw 要生成 TS handler
    new CursorAdapter(),
    new HermesAdapter(),
    new OpenClawAdapter()
  ]
}
