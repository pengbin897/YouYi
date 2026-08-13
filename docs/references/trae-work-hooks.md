---
title: Trae Work (TraeCode) Hooks 接入说明
agent: Trae Work
source: https://docs.trae.cn/ide_hook-configuration-reference
fetched_at: 2026-08-12
notes: 配套指南: https://docs.trae.cn/ide_automate-actions-with-hooks
---


> 官方文档镜像，供哨兵 Hook 接入参考。原文可能更新，以官方链接为准。
>
> - 入门指南：https://docs.trae.cn/ide_automate-actions-with-hooks
> - 配置详解：https://docs.trae.cn/ide_hook-configuration-reference

## 支持的 Hook 事件（总览）

| 事件名 | 触发时机 | 主要用途 |
| --- | --- | --- |
| `SessionStart` | 创建 Session 后、发起第一个对话前 | 初始化环境、注入环境变量或补充上下文 |
| `UserPromptSubmit` | 用户发送 Query 后、智能体开始处理前 | 拦截不允许的请求，或向模型附加上下文 |
| `PreToolUse` | 智能体发起工具调用后、实际执行前 | 校验、拦截、修改工具参数，或要求用户确认 |
| `PostToolUse` | 工具调用实际执行完成后 | 检查工具执行结果，并向模型附加上下文 |
| `Stop` | 智能体完成输出、准备结束当前 Query 时 | 检查产出是否达标；必要时阻断停止并继续执行 |
| `Notification` | 等待用户确认或任务完成时（异步，不阻塞） | 向用户发送通知 |

Hook 类型：

| Hook 类型 | 生效范围 |
| --- | --- |
| 全局 Hook | 对本机当前用户下的所有工作区生效 |
| 项目 Hook | 仅对当前项目或工作区生效 |

---

# Hook 配置详解

本文档介绍 TraeCode 中 Hook 的配置方式、执行环境、输入输出规范，以及各类事件的触发与处理机制。

## Hook 配置

### Hook 配置文件位置

TraeCode 支持全局 Hook 和项目 Hook。两类配置文件在不同操作系统中的存储位置如下：

| Hook 类型 | 操作系统 | Hook 配置文件位置 | 作用范围 |
| --- | --- | --- | --- |
| 全局 Hook | macOS & Linux | `~/.trae-cn/hooks.json` | 对本机当前用户下的所有工作区生效。 |
| | Windows | `%userprofile%/.trae-cn/hooks.json` | |
| 项目 Hook | macOS & Linux | `$PROJECT_FOLDER/.trae/hooks.json` 若当前工作区包含多个项目，默认会在第一个项目中创建配置文件。 | 仅对当前项目或工作区生效。 |
| | Windows | | |

同时，TraeCode 支持读取 Claude Code 中的 Hook 配置，配置流程参考导入 Claude Code 中的 Hook。Claude Code 同样支持全局与项目 Hook：

| Hook 类型 | 操作系统 | Hook 配置文件位置 | 作用范围 |
| --- | --- | --- | --- |
| 全局 Hook | macOS & Linux | `~/.claude/settings.json` | 对本机当前用户下的所有工作区生效。 |
| | Windows | `%userprofile%/.claude/settings.json` | |
| 项目 Hook | macOS & Linux | `$PROJECT_FOLDER/.claude/settings.json` `$PROJECT_FOLDER/.claude/settings.local.json` | 仅对当前项目或工作区生效。 |
| | Windows | | |

提示

多个 Hook 配置文件共存时，TraeCode 的行为如下：

- 若一个工作区内包含多个项目根目录，且多个项目中都存在已启用的项目级 Hook 配置，TraeCode 会读取这些配置并合并执行。
- 若同时启用 Claude Code Hook 和 TraeCode Hook，TraeCode 会读取所有已启用的 Hook 配置并合并执行。

### Hook 配置格式

`hooks.json`文件的配置格式如下：

```
{
  "version": 1,
  "hooks": {
    "<EventName>": [
      {
        "matcher": "<ToolPattern>",
        "loop_limit": 5,
        "hooks": [
          {
            "type": "command",
            "command": "<shell command>",
            "timeout": 30
          }
        ]
      }
    ]
  }
}

```

### 字段说明

Hook 相关字段的说明如下：

顶层结构

| 字段 | 类型 | 是否必填 | 描述 |
| --- | --- | --- | --- |
| `version` | `number` | 否 | 配置文件的 schema 版本，默认为`1`，且当前仅支持`1`。 |
| `hooks` | `object` | 是 | Hook 事件名到 Hook 组的映射。 |

事件层（`hooks. `）

| 字段 | 类型 | 是否必填 | 描述 |
| --- | --- | --- | --- |
| ` ` | `array` | 是 | 某个 Hook 事件下的 Hook 组列表。 |

Hook 组层

| 字段 | 类型 | 是否必填 | 描述 |
| --- | --- | --- | --- |
| `matcher` | `string` | 否 | 匹配规则，支持正则表达式（如`Edit|Write`、`mcp.*`）。配置为`*`、空字符串或省略时，表示匹配所有工具或通知类型。 提示：`matcher`字段仅对`PreToolUse`、`PostToolUse`和`Notification`事件有效。 |
| `loop_limit` | `number` | 否 | 循环次数限制。 当`loop_count`≥`loop_limit`时，该 Hook 组将被跳过。 该字段仅支持正整数；未配置或配置的值小于等于`0`时，使用默认值`5`。 提示：`loop_limit`字段仅对`Stop`事件有效。 |
| `hooks` | `array` | 是 | 该 Hook 组下要执行的 Hook 列表。 |

Hook 定义层

| 字段 | 类型 | 是否必填 | 描述 |
| --- | --- | --- | --- |
| `type` | `string` | 否 | Hook 类型，默认为 “命令” 类型（`command`），且当前仅支持`command`。 |
| `command` | `string` | 是 | 要执行的 Shell 命令。 |
| `timeout` | `number` | 否 | 超时时间（秒），默认`30`。 |

## Hook 输入和输出

所有 Hook 命令都遵循标准的输入/输出（I/O）机制：通过`stdin`接收 JSON 格式的输入，并通过`stdout`输出和退出码来控制智能体的行为。

### stdin 通用字段

每个 Hook 事件的`stdin` JSON 都包含以下通用字段：

```
{
  "session_id": "string",
  "cwd": "/path/to/workspace",
  "hook_event_name": "PreToolUse",
  "workspace_roots": ["/path/to/workspace"]
}

```

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `session_id` | `string` | 当前会话 ID。 |
| `cwd` | `string` | 当前 Hook 命令的实际工作目录。详情参考工作目录。 |
| `hook_event_name` | `string` | 当前 Hook 事件的名称。 |
| `workspace_roots` | `string[]` | 如果存在多个工作区，此字段将包含所有工作区的根目录。 |

### stdout 通用字段

Hook 命令可以通过`stdout`输出两种格式的数据：

- JSON ：用于结构化地控制智能体的执行流程。
- 纯文本：输出内容将作为附加上下文提供给模型。此格式仅适用于`SessionStart`和`UserPromptSubmit`事件。

对于 JSON 格式的输出，所有事件均支持以下通用流程控制字段：

```
{
  "continue": true,
  "stopReason": "string"
}

```

| 字段 | 类型 | 默认值 | 描述 |
| --- | --- | --- | --- |
| `continue` | `boolean` | `true` | 智能体是否在 Hook 执行完毕后继续执行。若设置为`false`，智能体将停止执行。该字段优先于任何事件特定的`decision`字段。 |
| `stopReason` | `string` | — | 当`continue`为`false`时，展示给用户的智能体停止执行的原因。 |

### 退出码行为

| 退出码 | 行为 |
| --- | --- |
| `0` | 正常退出。`stdout`的内容将根据 Hook 事件类型被解析为 JSON 或纯文本。 |
| `2` | 阻断性错误。`stderr`的内容将作为错误信息传递给模型的上下文。此错误在不同 Hook 事件中的具体行为有所不同，详见 Hook 事件。 |
| 其他 | 非阻断性错误。这类错误不会影响智能体的执行流程，其`stderr`和`stdout`输出会被忽略。 |

## Hook 执行环境

### Shell

Hook 命令会在系统默认 Shell 中执行：

- macOS/Linux：默认使用 Bash。
- Windows：默认使用 PowerShell。

### 环境变量

Hook 命令执行时，可通过以下环境变量获取上下文：

| 环境变量 | 描述 |
| --- | --- |
| `TRAE_PROJECT_DIR` | 当前 Hook 命令的工作区目录，与`stdin.cwd`一致。 |
| `CLAUDE_PROJECT_DIR` | 兼容 Claude Code Hook 的工作区目录变量，与`stdin.cwd`一致。 |

`SessionStart`事件会额外注入以下环境变量，用于向当前会话的后续执行环境写入变量：

| 环境变量 | 描述 |
| --- | --- |
| `TRAE_ENV_FILE` | TraeCode 环境变量文件路径，仅在`SessionStart`事件中注入。 |
| `CLAUDE_ENV_FILE` | 兼容 Claude Code Hook 的环境变量文件路径，仅在`SessionStart`事件中注入。 |

### 环境变量文件

`SessionStart`事件的 Hook 可以向`TRAE_ENV_FILE`指向的文件写入环境变量。写入的变量会在当前会话后续的 Hook 执行以及`RunCommand`工具调用中生效，但不会影响当前正在执行的`SessionStart` Hook 进程。

支持以下三种格式：

Bash 格式：

```
export NODE_ENV=production
export PATH="/usr/local/bin"

```

PowerShell 格式：

```
$env:NODE_ENV=production

```

Dotenv 格式：

```
NODE_ENV=production
MY_VAR="hello world"

```

### 工作目录

Hook 命令执行时的工作目录如下：

| Hook 命令类型 | 工作目录 |
| --- | --- |
| 全局 Hook 命令 | 单工作区：该工作区的根目录。 多工作区：第一个工作区的根目录。 |
| 项目 Hook 命令 | 该 Hook 配置文件所在项目的根目录。 |

### 运行方式

Hook 命令的实际权限和可访问范围取决于你所设置的运行方式：

- 沙箱运行：Hook 命令在沙箱中自动执行，文件访问和系统权限会受到沙箱限制。
- 本地自动运行：Hook 命令在沙箱外自动执行，可访问本地环境，存在更高安全风险，请谨慎选择。

关于如何设置 Hook 命令的运行方式，参考设置 Hook 命令的运行方式。

## Hook 事件

### SessionStart

`stdin`：

```
{
  "session_id": "...",
  "hook_event_name": "SessionStart",
  "source": "startup"
}

```

该事件的专有字段如下：

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `source` | `string` | 会话的来源。目前仅支持`startup`（新建会话）。 |

格式二：JSON

```
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "文本内容"
  }
}

```

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `additionalContext` | `string` | 附加给模型的上下文。 |

- 触发时机：创建 Session 后、发起第一个对话之前触发。
- Hook 的作用：初始化环境、注入上下文信息或设置环境变量。
- `stdout`：
- - 格式一：纯文本 直接输出纯文本内容，将其作为附加上下文提供给模型。
- 环境变量注入：通过向`$TRAE_ENV_FILE`文件写入键值对，可以为 Hook 后续的执行环境注入环境变量。
- 退出码`2`的行为：不影响会话流程。

### UserPromptSubmit

`stdin`：

```
{
  "session_id": "...",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "用户输入的 Prompt"
}

```

该事件的专有字段如下：

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `prompt` | `string` | 用户提交的 Prompt 文本。 |

格式二：JSON

```
{
  "decision": "block",
  "reason": "该请求不被允许的原因",
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "附加给模型的上下文"
  }
}

```

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `decision` | `string` | 该字段仅支持设为`block`。设置后，将禁止智能体执行该 Prompt。如需允许智能体执行该 Prompt，请将该字段留空。 |
| `reason` | `string` | 当`decision`字段的值为`block`时，此字段的内容将作为错误信息展示给用户。否则，该字段将被忽略。 |
| `additionalContext` | `string` | 附加给模型的上下文文本。 |

- 触发时机：用户发送消息后、智能体开始处理前。
- Hook 的作用：拦截不允许的请求，或向模型附加上下文。
- `stdout`：
- - 格式一：纯文本 直接输出非 JSON 格式的纯文本内容，将其作为附加上下文提供给模型。
- 退出码`2`的行为：等价于`"decision": "block"`，直接禁止智能体执行该 Prompt，并将`stderr`内容展示给用户。

### PreToolUse

`stdin`：

```
{
  "session_id": "...",
  "hook_event_name": "PreToolUse",
  "tool_use_id": "toolcall-id-string",
  "tool_name": "RunCommand",
  "llm_tool_name": "RunCommand",
  "tool_input": { ... }
}

```

该事件的专有字段如下：

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `tool_use_id` | `string` | 工具调用的唯一 ID。 |
| `tool_name` | `string` | 标准化的工具名称。详见 PreToolUse 和 PostToolUse 事件支持的工具。 |
| `llm_tool_name` | `string` | 传递给大语言模型的原始工具名称。 |
| `tool_input` | `object` | 工具输入参数。 |

`stdout`：

```
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow", 
    "permissionDecisionReason": "决策原因说明",
    "updatedInput": { ... },
    "additionalContext": "附加给模型的上下文"
  }
}

```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `permissionDecision` | `string` | 权限决策，用于决定是否执行本次工具调用。可选值包括： `allow`：允许执行。 `deny`：拒绝执行。 `ask`：弹出确认框，由用户决定是否执行。 特殊情况说明： 如果多个`PreToolUse`事件的 Hook 正并行执行，`permissionDecision`只会返回一个最终值。取值优先级为：`deny`->`ask`->`allow`。 如果返回值为`allow`，但是该工具的运行模式为手动确认，则仍以工具运行模式为准，需要用户确认。 |
| `permissionDecisionReason` | `string` | 权限决策的原因。 |
| `updatedInput` | `object` | 修改后的工具输入参数，将整体覆盖替换原始参数（非合并更新）。 |
| `additionalContext` | `string` | 附加给模型的上下文文本。 |

- 触发时机：智能体发起工具调用后、实际执行前。
- Hook 的作用：校验或拦截工具调用、修改工具参数，或要求用户确认后再执行。
- `matcher`字段配置：可通过`matcher`字段配置正则表达式，从而匹配特定的工具名。
- 退出码`2`的行为：等价于`"permissionDecision": "deny"`，拒绝让智能体执行本次工具调用，并将`stderr`内容作为原因附加给模型的上下文。

### PostToolUse

`stdin`：

```
{
  "session_id": "...",
  "hook_event_name": "PostToolUse",
  "tool_use_id": "toolcall-id-string",
  "tool_name": "RunCommand",
  "llm_tool_name": "RunCommand",
  "tool_input": { ... },
  "tool_response": { ... }
}

```

该事件的专有字段如下：

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `tool_use_id` | `string` | 工具调用的唯一 ID。 |
| `tool_name` | `string` | 标准化的工具名称。详见 PreToolUse 和 PostToolUse 事件支持的工具。 |
| `llm_tool_name` | `string` | 传递给大语言模型的原始工具名称。 |
| `tool_input` | `object` | 工具输入参数。 |
| `tool_response` | `object` | 工具调用的结果。 |

`stdout`：

```
{
  "decision": "block",
  "reason": "阻断原因",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "附加给模型的上下文"
  }
}

```

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `decision` | `string` | 该字段仅支持设为`block`。设置后，会向模型传递一条阻断信息，表示工具已执行且无法撤销。如需允许智能体继续处理工具调用的结果，将该字段留空。 |
| `reason` | `string` | 当`decision`字段的值为`block`时，此字段的内容将作为阻断原因展示给用户。否则，该字段将被忽略。 |
| `additionalContext` | `string` | 附加给模型的上下文文本。 |

- 触发时机：工具调用实际执行完成后。
- Hook 的作用：校验执行结果或附加上下文。
- `matcher`字段配置：可通过`matcher`字段配置正则表达式，从而匹配特定的工具名。
- 退出码`2`的行为：将`stderr`传递给模型的上下文。

### Stop

`stdin`：

```
{
  "session_id": "...",
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "loop_count": 0, 
  "last_assistant_message": "大语言模型最终输出的文本内容"
}

```

该事件的专有字段如下：

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `stop_hook_active` | `boolean` | 当前查询是否已经被`Stop`事件的 Hook 至少阻断过一次。 |
| `loop_count` | `number` | 当前查询的`Stop`事件被 Hook 阻断的次数计数。从`0`开始累加。 循环限制：你可以通过`loop_limit`字段配置该 Hook 组允许阻断`Stop`事件的最大次数。当`loop_count`≥`loop_limit`时，该 Hook 组将被跳过，使智能体不再执行，以避免无限循环。`loop_limit`的默认值为`5`。 |
| `last_assistant_message` | `string` | 大语言模型最终输出的文本内容。 |

`stdout`：

```
{
  "decision": "block",
  "reason": "请继续检查测试是否通过"
}

```

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `decision` | `string` | 该字段仅支持设为`block`。设置后，将阻断智能体停止执行。如需让智能体停止执行，将该字段留空。 |
| `reason` | `string` | 当`decision`字段的值为`block`时，此字段的内容将作为新的用户请求让智能体继续执行。否则，该字段将被忽略。 |

决策控制流程：`Stop`事件的决策控制逻辑如下：

```
智能体准备停止
    │
    ▼
检查 loop_count 是否大于等于 loop_limit？──── 是 ──► 跳过 Hook，允许智能体停止
    │
   否
    │
    ▼
执行 Stop 事件的 Hook 脚本
    │
    ├── 退出码为 0，且 decision 字段为空 ───────► 允许停止
    │
    ├── 退出码为 0，且 decision 字段的值为 block ──► 阻断停止，将 reason 字段作为新 Query
    │
    ├── 退出码为 2 ───────────────────► 阻断停止，将 stderr 作为新 Query
    │
    └── 其他退出码 ───────────────────► 忽略错误，允许停止

```

- 触发时机：智能体完成输出、准备结束当前查询时。此时，你可以检查智能体的输出是否达标；若不达标，可以阻止智能体结束任务并要求其继续处理。
- Hook 的作用：阻止智能体结束当前任务，并要求其继续执行。
- 退出码`2`的行为：等价于`"decision": "block"`，阻断智能体停止执行，并将`stderr`作为新的用户请求让智能体继续执行。

### Notification

stdin：

```
{
  "session_id": "...",
  "hook_event_name": "Notification",
  "notification_type": "idle_prompt",
  "message": "智能体已完成任务",
  "tool_use_id": "toolu_xxx"
}

```

该事件的专有字段如下：

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `notification_type` | `string` | 通知类别，用于标识通知场景，也用于匹配`matcher`字段的配置。可选值见下表。 |
| `message` | `string` | 通知的正文。 |
| `tool_use_id` | `string?` | 关联的工具调用 ID。 仅工具调用相关的通知类型携带该 ID，例如`permission_prompt`、`document_review`等。任务完成时发送的`idle_prompt`类通知不携带该 ID。 |

`notification_type`字段的值和相应触发时机如下：

| 值 | 触发时机 |
| --- | --- |
| `idle_prompt` | 智能体完成当前任务。 |
| `permission_prompt` | 工具调用需要用户确认后才能继续执行，例如当`PreToolUse`事件的 Hook 返回`ask`决策，或工具本身需要手动确认时。 |
| `document_review` | Plan 或 Spec 工作流中的文档审阅流程。 |
| `ask_user_question` | 智能体需要用户补充信息时，进行提问的通知。 |
| `browser_interaction` | 浏览器交互等待通知。 |

- 触发时机：智能体的工具调用等待用户确认时，或智能体完成任务时。该事件异步执行，不会阻塞智能体的主流程。
- Hook 的作用：发送通知，不改变智能体的执行流程。
- `matcher`字段配置：基于通知类型（`notification_type`）匹配，而不是基于工具名匹配。未配置`matcher`，或将其配置为空字符串或`*`时，表示匹配所有通知类型。
- `stdout`：该事件会忽略 Hook 进程的`stdout`输出。即使输出 JSON，也不会影响智能体的行为。
- 退出码的行为：任意退出码均视为非阻断性结果。Hook 进程的`stdout`、`stderr`和退出码不会改变智能体的执行流程。

## PreToolUse 和 PostToolUse 事件支持的工具

在`PreToolUse`和`PostToolUse`事件中，你可以通过`matcher`字段匹配`tool_name`。

`tool_name`为标准化工具名称，取值如下：

| 分类 | 工具名称 | 描述 |
| --- | --- | --- |
| 文件读取 | `Read` | 读取文件内容。 |
| 文件写入 | `Write` | 写入文件。 |
| 文件编辑 | `Edit` | 单次查找并替换文件内容。 |
| 搜索 | `Glob` | 基于文件路径模式进行匹配搜索。 |
| | `Grep` | 基于正则表达式进行内容搜索。 |
| | `LS` | 列出目录下的文件与子目录。 |
| 终端 | `RunCommand` | 执行终端命令。 |
| 网络 | `WebSearch` | 网络搜索。 |
| | `WebFetch` | 获取网页内容。 |
| 交互 | `AskUserQuestion` | 向用户提问。 |
| Skill | `Skill` | 加载 Skill。 |
| MCP | `mcp__ __ ` | MCP 工具。 MCP 工具匹配说明：在 Hook 中，MCP 工具的标准化名称格式为`mcp__ __ `（例如`mcp__Git__iCube__git_status`）。你可以在`matcher`字段中使用`mcp__.*`来匹配所有 MCP 工具，或使用具体工具的名称进行精确匹配。 |

## 示例

### 会话开始时，注入项目上下文

本示例用于在会话启动时自动注入项目级上下文和环境变量，使智能体在开始处理任务前即可获取项目名称、运行环境、技术栈和代码规范等信息。

Hook 配置：监听`SessionStart`事件，并在事件触发时执行`setup_env.sh`脚本。

macOS / Linux Windows

```
{
  "version": 1,
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "command": "bash ./scripts/setup_env.sh"
          }
        ]
      }
    ]
  }
}

```

```
{
  "version": 1,
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "command": "powershell -ExecutionPolicy Bypass -File ./scripts/setup_env.ps1"
          }
        ]
      }
    ]
  }
}

```

`setup_env.sh`脚本示例：该脚本会向`$TRAE_ENV_FILE`写入环境变量，使其在后续 Hook 和`RunCommand`工具调用中生效；同时通过标准输出向模型补充项目背景信息。

macOS / Linux Windows

```
#!/bin/bash
# 向环境变量文件写入项目配置
echo "export PROJECT_NAME=my-app" >> "$TRAE_ENV_FILE"
echo "export NODE_ENV=development" >> "$TRAE_ENV_FILE"

# 输出上下文信息给模型
echo "当前项目：my-app，技术栈：React + TypeScript，请遵循 ESLint 规范。"

```

```
# 向环境变量文件写入项目配置
Add-Content -Path $env:TRAE_ENV_FILE -Value "`$env:PROJECT_NAME='my-app'"
Add-Content -Path $env:TRAE_ENV_FILE -Value "`$env:NODE_ENV='development'"

# 输出上下文信息给模型
Write-Output "当前项目：my-app，技术栈：React + TypeScript，请遵循 ESLint 规范。"

```

### 终端命令执行前，拦截高风险操作

本示例用于在终端命令真正执行前识别并拦截高风险操作，降低误删文件、执行破坏性命令或提交危险数据库操作的风险。

Hook 配置：监听`PreToolUse`事件，并通过`matcher`仅匹配`RunCommand`工具。只有当智能体准备执行终端命令时，才会触发该 Hook。

```
{
  "version": 1,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "RunCommand",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ./validate_command.py",
            "timeout": 10
          }
        ]
      }
    ]
  }
}

```

`validate_command.py`脚本示例：该脚本从`stdin`读取工具输入，提取待执行命令，并检查命令内容是否包含预设的危险模式。若命中危险模式，脚本返回`"permissionDecision": "deny"`和拒绝原因，从而阻止该命令执行；若未命中，则正常退出并允许继续执行。

```
#!/usr/bin/env python3
import sys, json

input_data = json.load(sys.stdin)
command = input_data.get("tool_input", {}).get("command", "")

dangerous_patterns = ["rm -rf /", "DROP TABLE", "format C:"]
for pattern in dangerous_patterns:
    if pattern in command:
        result = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": f"high risk command detected: {pattern}"
            }
        }
        json.dump(result, sys.stdout)
        sys.exit(0)

# 允许执行
sys.exit(0)

```

### 任务结束前，自动运行验收测试

本示例用于在智能体准备结束当前任务前自动执行验收测试，并根据测试结果决定是否允许停止。如果测试未通过，Hook 会要求智能体继续修复问题，而不是直接结束任务。

提示

如需测试本示例，配置完成后，可向智能体发送消息 “测试 stop hook” 来验证效果。

Hook 配置：监听`Stop`事件，并设置`loop_limit`限制最多阻断次数，避免测试持续失败时造成无限循环。

macOS / Linux Windows

```
{
  "version": 1,
  "hooks": {
    "Stop": [
      {
        "loop_limit": 3,
        "hooks": [
          {
            "command": "python3 ./check_tests.py",
            "timeout": 60
          }
        ]
      }
    ]
  }
}

```

```
{
  "version": 1,
  "hooks": {
    "Stop": [
      {
        "loop_limit": 3,
        "hooks": [
          {
            "command": "python ./check_tests.py", // 或使用 py ./check_tests.py 命令
            "timeout": 60
          }
        ]
      }
    ]
  }
}

```

`check_tests.py`脚本示例：该脚本会运行`npm test`并读取测试结果。若测试失败，该脚本返回`"decision": "block"`和失败原因，并带上当前阻断次数，要求智能体继续修复；若测试通过，则正常退出并允许智能体停止。

```
#!/usr/bin/env python3
import sys, json, subprocess

input_data = json.load(sys.stdin)
loop_count = input_data.get("loop_count", 0)

# 运行测试
result = subprocess.run(["npm", "test"], capture_output=True, text=True)

if result.returncode != 0:
    output = {
        "decision": "block",
        "reason": f"测试未通过（第 {loop_count + 1} 次检查），请修复以下失败:\n{result.stdout[-500:]}"
    }
    json.dump(output, sys.stdout)
else:
    # 测试通过，允许停止
    sys.exit(0)

```

Was this document helpful?

HelpfulNot helpful

Previous通过 Hook 实现自动化

Next超级代码补全：CUE

Hook 配置

Hook 配置文件位置

Hook 配置格式

字段说明

Hook 输入和输出

stdin 通用字段

stdout 通用字段

退出码行为

Hook 执行环境

Shell

环境变量

环境变量文件

工作目录

运行方式

Hook 事件

SessionStart

UserPromptSubmit

PreToolUse

PostToolUse

Stop

Notification

PreToolUse 和 PostToolUse 事件支持的工具

示例

会话开始时，注入项目上下文

终端命令执行前，拦截高风险操作

任务结束前，自动运行验收测试