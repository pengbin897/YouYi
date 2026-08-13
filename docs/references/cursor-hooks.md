---
title: Cursor Hooks 接入说明
agent: Cursor
source: https://cursor.com/docs/hooks
fetched_at: 2026-08-12
notes: Cursor 1.7+ 引入的生命周期钩子；配置结构是扁平数组，与 Claude Code 的两层嵌套结构不同构。
---

> 官方文档镜像，供哨兵 Hook 接入参考。原文可能更新，以官方链接为准：https://cursor.com/docs/hooks

# Hooks

Hooks let you observe, control, and extend the agent loop using custom scripts. Define hooks in `hooks.json` files at the project or user level, or install them through plugins from **Customize**. Hooks are spawned processes that communicate over stdio using JSON in both directions. They run before or after defined stages of the agent loop and can observe, block, or modify behavior.

With hooks, you can:

- Run formatters after edits
- Add analytics for events
- Scan for PII or secrets
- Gate risky operations (e.g., SQL writes)
- Control subagent (Task tool) execution
- Inject context at session start

Cursor supports loading hooks from third-party tools like Claude Code. See Third Party Hooks for details on compatibility and configuration.

## Hook categories

Hooks fall into three categories based on what triggers them:

**Agent hooks (Cmd+K/Agent Chat)** fire during an agent session:

- `sessionStart` / `sessionEnd` - Session lifecycle management
- `preToolUse` / `postToolUse` / `postToolUseFailure` - Generic tool use hooks (fires for all tools)
- `subagentStart` / `subagentStop` - Subagent (Task tool) lifecycle
- `beforeShellExecution` / `afterShellExecution` - Control shell commands
- `beforeMCPExecution` / `afterMCPExecution` - Control MCP tool usage
- `beforeReadFile` / `afterFileEdit` - Control file access and edits
- `beforeSubmitPrompt` - Validate prompts before submission
- `preCompact` - Observe context window compaction
- `stop` - Handle agent completion
- `afterAgentResponse` / `afterAgentThought` - Track agent responses

**Tab hooks (inline completions)** fire for autonomous Tab operations:

- `beforeTabFileRead` - Control file access for Tab completions
- `afterTabFileEdit` - Post-process Tab edits

**App lifecycle hooks** fire outside any agent session:

- `workspaceOpen` - Fires when Cursor opens a workspace and on every workspace folder change. Can return additional plugin paths to load for the current workspace.

## Configuration

Define hooks in a `hooks.json` file. Configuration can exist at multiple levels; all matching hooks from every source run:

```sh
~/.cursor/
├── hooks.json
└── hooks/
    ├── audit.sh
    └── block-git.sh
```

- **Enterprise** (MDM-managed, system-wide)
- **Team** (Cloud-distributed, enterprise only)
- **Project** (`.cursor/hooks.json`，随仓库签入版本控制)
- **User** (`~/.cursor/hooks.json`)

Priority order (highest to lowest): Enterprise → Team → Project → User

**关键结构差异（相对 Claude Code）**：`hooks` 对象把事件名直接映射到一个**扁平**的钩子定义数组，每个定义就是 `{ command, timeout?, matcher?, loop_limit?, failClosed? }`，不像 Claude Code 那样在事件名与钩子之间还插一层 `{ matcher, hooks: [...] }`。哨兵接入时如果照抄 Claude 系的两层嵌套结构会写错配置。

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "./hooks/session-init.sh" }],
    "sessionEnd": [{ "command": "./hooks/audit.sh" }],
    "preToolUse": [{ "command": "./hooks/validate-tool.sh", "matcher": "Shell|Read|Write" }],
    "postToolUse": [{ "command": "./hooks/audit-tool.sh" }],
    "beforeShellExecution": [{ "command": "./script.sh" }],
    "afterFileEdit": [{ "command": "./format.sh" }],
    "beforeSubmitPrompt": [{ "command": "./hooks/audit.sh" }],
    "stop": [{ "command": "./audit.sh", "loop_limit": 10 }],
    "workspaceOpen": [{ "command": "./register-workspace-plugins.sh" }]
  }
}
```

### Per-Script Configuration Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `command` | string | required | Script path or command |
| `type` | `"command"` \| `"prompt"` | `"command"` | Hook execution type |
| `timeout` | number | platform default | Execution timeout in seconds |
| `loop_limit` | number \| null | `5` | Per-script loop limit for stop/subagentStop hooks. `null` means no limit. Default is `5` for Cursor hooks, `null` for Claude Code hooks. |
| `failClosed` | boolean | `false` | When `true`, hook failures (crash, timeout, invalid JSON) block the action instead of allowing it through. |
| `matcher` | object | - | Filter criteria for when hook runs |

### Command-Based Hooks 的退出码约定

- Exit code `0` - Hook succeeded, use the JSON output
- Exit code `2` - Block the action（等价于返回 `permission: "deny"`，与 Claude Code 行为一致，便于兼容）
- Other exit codes - Hook failed, action proceeds (fail-open by default)

## Reference

### Common schema（所有钩子都带）

```json
{
  "conversation_id": "string",
  "generation_id": "string",
  "model": "string",
  "model_id": "string",
  "model_params": [{ "id": "string", "value": "string" }],
  "hook_event_name": "string",
  "cursor_version": "string",
  "workspace_roots": ["<path>"],
  "user_email": "string | null",
  "transcript_path": "string | null"
}
```

注意：通用字段里**没有** `session_id` 与 `cwd`。`session_id` 只出现在 `sessionStart`/`sessionEnd` 自己的字段里（值等同于 `conversation_id`），因此哨兵统一用 `conversation_id` 当会话标识；`cwd` 只在部分工具类事件（如 `preToolUse`）里单独给出，其余场景要退化到 `workspace_roots[0]`。

### beforeSubmitPrompt

用户按下发送、请求打到后端之前触发，可用来拦截提交。

```json
// Input
{ "prompt": "<user prompt text>", "attachments": [{ "type": "file" | "rule", "file_path": "<absolute path>" }] }
// Output
{ "continue": true | false, "user_message": "<message shown to user when blocked>" }
```

### preToolUse

对所有工具类型通用（Shell、Read、Write、MCP、Task 等），**没有单独的授权事件**——这是唯一能拦截工具调用的位置，因此哨兵的远程放行闸门只能挂在这里（对齐 Workbuddy/Trae 的做法：默认关闭，用户在设置里显式开启）。

```json
// Input
{
  "tool_name": "Shell",
  "tool_input": { "command": "npm install", "working_directory": "/project" },
  "tool_use_id": "abc123",
  "cwd": "/project"
}
// Output
{
  "permission": "allow" | "deny",
  "user_message": "<message shown in client when denied>",
  "agent_message": "<message sent to agent when denied>",
  "updated_input": { "command": "npm ci" }
}
```

不返回 `permission` 字段等同于放行——**没有**「交回 Agent 自己的确认框」这种中间态，这点与 Claude Code 的 `PermissionRequest` 不同，接入时不能假设「不接管就还有本机确认兜底」。

### postToolUseFailure

工具失败、超时或被拒绝时触发。

```json
{
  "tool_name": "Shell",
  "tool_input": { "command": "npm test" },
  "error_message": "Command timed out after 30s",
  "failure_type": "timeout" | "error" | "permission_denied",
  "duration": 5000,
  "is_interrupt": false
}
```

### stop

agent loop 结束时触发，可选返回 `followup_message` 自动提交为下一条用户消息（循环续跑）。

```json
// Input
{ "status": "completed" | "aborted" | "error", "loop_count": 0 }
// Output
{ "followup_message": "<message text>" }
```

`loop_count` 记录该 stop 钩子已经自动续跑过多少次（从 0 开始），默认上限 5 次（`loop_limit` 可配置，设为 `null` 取消上限）。**没有** `stop_hook_active` / `last_assistant_message` 字段。

### afterAgentResponse

agent 完成一条最终回复后触发，是拿到回复原文的唯一位置（`stop` 拿不到）。

```json
{ "text": "<assistant final text>" }
```

### sessionStart / sessionEnd

`sessionStart` 是 fire-and-forget（不阻塞、不接受同步决策）：

```json
{ "session_id": "<unique session identifier>", "is_background_agent": true | false, "composer_mode": "agent" | "ask" | "edit" }
```

`sessionEnd`：

```json
{
  "session_id": "<unique session identifier>",
  "reason": "completed" | "aborted" | "error" | "window_close" | "user_close",
  "duration_ms": 45000,
  "final_status": "<status string>",
  "error_message": "<error details if reason is 'error'>"
}
```

## Troubleshooting

- Exit code `2` 阻断的行为与 Claude Code 一致，便于生态兼容。
- Cursor 会自动监听 `hooks.json` 变化并重新加载；如果没生效，重启 Cursor。
- `~/.cursor/hooks.json`（用户级）的钩子脚本相对路径是相对 `~/.cursor/` 解析的；项目级 `.cursor/hooks.json` 是相对项目根目录解析的。
