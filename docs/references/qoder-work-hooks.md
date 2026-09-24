---
title: Qoder Work Hooks 接入说明
agent: Qoder Work
source: https://docs.qoder.com/qoderwork/hooks
related:
  - https://docs.qoder.com/cli/hooks
  - https://docs.qoder.com/extensions/hooks
fetched_at: 2026-08-12
notes: 以 QoderWork 专用 Hooks 文档为主；CLI / IDE 扩展事件能力可能不同，配置文件路径亦不同
---

# Hooks - QoderWork

> 官方文档镜像，供哨兵 Hook 接入参考。原文可能更新，以官方链接为准。

Hooks let you run custom logic at key points during Agent execution in QoderWork — no source code changes required. Edit a JSON config file to:

- Block dangerous operations before a tool runs
- Auto-lint after every file write to enforce code style
- Send a desktop notification when the Agent finishes, so you don't have to watch the screen

Unlike prompt instructions, hooks are deterministic — when the event fires, your script runs. No model interpretation, no drift.

## Quick Start

Here is an example that blocks `rm -rf` commands:

### 1. Create the script

```bash
mkdir -p ~/.qoderwork/hooks
cat > ~/.qoderwork/hooks/block-rm.sh << 'EOF'
#!/bin/bash
input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command')

if echo "$command" | grep -q 'rm -rf'; then
  echo "Dangerous command blocked: $command" >&2
  exit 2
fi

exit 0
EOF
chmod +x ~/.qoderwork/hooks/block-rm.sh
```

### 2. Add the config

Add the following to `~/.qoderwork/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "~/.qoderwork/hooks/block-rm.sh"
          }
        ]
      }
    ]
  }
}
```

### 3. Verify it works

Open QoderWork and ask the Agent to run a command containing `rm -rf`. The hook blocks execution and feeds the error message back to the Agent.

## Configuring Hooks

### Config File Location

QoderWork loads hook configurations from the user-level settings file:

| Location | Scope | Description |
| --- | --- | --- |
| `~/.qoderwork/settings.json` | User (global) | Personal config, applies to all QoderWork sessions |

Hot reload is not yet supported — restart QoderWork after editing hook configurations for changes to take effect.

### Config Format

```json
{
  "hooks": {
    "EventName": [
      {
        "matcher": "match condition",
        "hooks": [
          {
            "type": "command",
            "command": "command to execute",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

| Field | Required | Description |
| --- | --- | --- |
| `type` | Yes | Must be `"command"` |
| `command` | Yes | Shell command to execute |
| `timeout` | No | Timeout in seconds, defaults to 60 |
| `matcher` | No | Match condition. If omitted, matches all |

You can define multiple matcher groups under a single event, and each group can contain multiple hook commands.

### Matcher Rules

`matcher` determines when a hook fires. What it matches against depends on the event (see each event's description).

| Pattern | Meaning | Example |
| --- | --- | --- |
| Omit or `"*"` | Match everything | All tools trigger the hook |
| Exact value | Exact match | `"Bash"` fires only for the Bash tool |
| `\|`-separated | Match multiple values | `"Write\|Edit"` fires for Write or Edit |
| Regex | Regex match | `"mcp__.*"` matches all MCP tools |

## Writing Hook Scripts

Hook scripts receive JSON input via stdin and communicate results through their exit code and stdout. This section covers the input/output format common to all events. For event-specific fields, see Hook Events.

QoderWork currently does not inject environment variables into hook scripts. All data is passed via stdin JSON. If you need session ID, working directory, or tool information, parse them from the stdin JSON input.

### Input

Your hook script receives JSON data via stdin. Every event includes these common fields:

| Field | Description |
| --- | --- |
| `session_id` | Current session ID |
| `cwd` | Current working directory |
| `hook_event_name` | Name of the event that triggered this hook |

Each event adds its own fields on top of these (see the individual event descriptions). Parse the input with `jq`:

```bash
#!/bin/bash
input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name')
```

### Output

Hooks communicate results through exit code and stdout. The exit code determines the basic behavior:

- `0` for success
- `2` for blocking (stderr content is injected into the conversation, only effective for blockable events)
- other values are non-blocking errors

stdout JSON (only parsed on exit 0) provides fine-grained control for some events — see each event's description for supported fields. stdout is ignored when exit code is non-zero.

## Hook Events

### SessionStart

Fires when a session starts. Matcher: Session source

| Matcher value | Trigger scenario |
| --- | --- |
| `startup` | New session starts |
| `resume` | Resuming an existing session |
| `compact` | After context compaction completes |

Extra input fields:

```json
{
  "source": "startup",
  "model": "Auto"
}
```

### SessionEnd

Fires when a session ends. Matcher: End reason

| Matcher value | Trigger scenario |
| --- | --- |
| `prompt_input_exit` | User exits input (Ctrl+D, etc.) |
| `other` | Other reasons |

Extra input fields:

```json
{
  "reason": "prompt_input_exit"
}
```

### UserPromptSubmit

Fires after the user submits a prompt, before the Agent processes it. Extra input fields:

```json
{
  "prompt": "Write a sorting function for me"
}
```

### PreToolUse

Fires before a tool executes. Can block tool execution. Matcher: Tool name (e.g. `Bash`, `Write`, `Edit`, `Read`, `Glob`, `Grep`, MCP tool names like `mcp__server__tool`) Extra input fields:

```json
{
  "tool_name": "Bash",
  "tool_input": {"command": "rm -rf /tmp/build"},
  "tool_use_id": "toolu_01ABC123"
}
```

Blocking tool execution: exit code 2, stderr content is returned to the Agent as an error. See Quick Start for a complete example.

### PostToolUse

Fires after a tool executes successfully. Matcher: Tool name Extra input fields:

```json
{
  "tool_name": "Write",
  "tool_input": {"file_path": "/path/to/file.ts", "content": "..."},
  "tool_response": "File written successfully",
  "tool_use_id": "toolu_01ABC123"
}
```

### PostToolUseFailure

Fires after a tool execution fails. Matcher: Tool name Extra input fields:

```json
{
  "tool_name": "Bash",
  "tool_input": {"command": "npm test"},
  "tool_use_id": "toolu_01ABC123",
  "error": "Command exited with non-zero status code 1",
  "is_interrupt": false
}
```

### Stop

Fires after the Agent completes its response (main Agent, no pending tool calls). Can block the Agent from stopping to keep it working.

Blocking the Agent from stopping: exit code 2, stderr content is injected into the conversation as a message, and the Agent continues working.

### SubagentStart / SubagentStop

Fires when a subagent starts or completes. SubagentStop, like Stop, can block the subagent from stopping. Matcher: Agent type name Extra input fields:

```json
{
  "agent_id": "a1b2c3d4",
  "agent_type": "task"
}
```

### PreCompact

Fires before context compaction. Matcher: Trigger method

| Matcher value | Trigger scenario |
| --- | --- |
| `manual` | User manually runs /compact |
| `auto` | Auto-triggered when context window is full |

Extra input fields:

```json
{
  "trigger": "manual",
  "custom_instructions": "Preserve all tool call results"
}
```

### Notification

Fires on notification events (permission requests, task completion, etc.). Matcher: Notification type

| Matcher value | Trigger scenario |
| --- | --- |
| `permission` | Permission request notification |
| `result` | Agent result notification |

Extra input fields:

```json
{
  "message": "Agent is requesting permission to run: rm -rf node_modules",
  "title": "Permission Required",
  "notification_type": "permission"
}
```

### PermissionRequest

Fires when a tool execution requires user authorization. Matcher: Tool name Extra input fields:

```json
{
  "tool_name": "Bash",
  "tool_input": {"command": "rm -rf node_modules"}
}
```

## Scenario Examples

### Desktop Notification

Show a desktop notification when the Agent finishes a task or needs authorization. Script `~/.qoderwork/hooks/notify.sh` (macOS):

```bash
#!/bin/bash
input=$(cat)
message=$(echo "$input" | jq -r '.message')

if echo "$message" | grep -q "^Agent"; then
  osascript -e 'display notification "Task completed" with title "QoderWork"'
else
  osascript -e 'display notification "Authorization needed" with title "QoderWork"'
fi

exit 0
```

Config:

```json
{
  "hooks": {
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.qoderwork/hooks/notify.sh"
          }
        ]
      }
    ]
  }
}
```

### Auto Lint After File Write

Automatically run lint after every file write or edit by the Agent. Script `${project}/.qoderwork/hooks/auto-lint.sh`:

```bash
#!/bin/bash
input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path')

case "$file_path" in
  *.js|*.ts|*.jsx|*.tsx)
    npx eslint "$file_path" --fix 2>/dev/null
    ;;
esac

exit 0
```

Config: event `PostToolUse`, matcher `Write|Edit`, command `.qoderwork/hooks/auto-lint.sh`.

### Keep Agent Working

Check for unfinished tasks when the Agent stops. If there are uncommitted git changes, inject a message to keep the Agent going. Script `~/.qoderwork/hooks/check-continue.sh`:

```bash
#!/bin/bash
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "Uncommitted changes detected, please complete git commit" >&2
  exit 2
fi

exit 0
```

Config: event `Stop`, command `~/.qoderwork/hooks/check-continue.sh`.

## Related Docs

- [Qoder CLI Hooks](https://docs.qoder.com/cli/hooks)
- [Qoder IDE / JetBrains Extensions Hooks](https://docs.qoder.com/extensions/hooks)
