# Workbuddy 配置目录改为 ~/.workbuddy

日期：2026-09-24
关联文档：`docs/references/workbuddy-hooks.md`、`docs/design/哨兵-会话续聊-Workbuddy-功能设计.md`

## 问题与根因

游奕把 Workbuddy 的用户配置当成 CodeBuddy 的 `~/.codebuddy` 来跟踪：
钩子写入 `~/.codebuddy/settings.json`，发现逻辑也扫这个目录。

WorkBuddy 桌面应用内置 CodeBuddy 引擎（CLI 仍叫 `codebuddy`），
但用户配置目录是 `~/.workbuddy`，和 CodeBuddy 分开。
钩子写进 `~/.codebuddy` 时 WorkBuddy 读不到；本机只有 WorkBuddy 时，
发现还可能把 CodeBuddy 的配置目录当成 WorkBuddy。

这次是把 2026-09-12 被仓库重置盖掉的同一处修正重新做上。授权闸门仍停在 `PreToolUse`，本次不动。

## 方案

方言表与 Agent 元数据统一改到 WorkBuddy 自己的目录：

- `configFile` / `configPath`：`~/.workbuddy/settings.json`
- `detect.dirs`：`~/.workbuddy`；桌面应用名改为 `WorkBuddy`
- CLI 探测仍用 `codebuddy`，进程关键词同时认 `codebuddy` 与 `WorkBuddy`

## 影响评估

- 新安装会把 hooks 写进 `~/.workbuddy/settings.json`。
- 若此前已经误写入 `~/.codebuddy/settings.json`，本次不会自动清理旧条目。
- 续聊仍用 SDK 的 `settingSources: ['user']`。SDK 类型注释里写的仍是 `~/.codebuddy`；
  若无头续跑实际不读 `~/.workbuddy`，钩子在续聊路径上不会触发，需要另查 SDK 的配置目录。
