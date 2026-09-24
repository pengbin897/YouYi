# 新增前端会话续聊能力（Workbuddy / CodeBuddy 先行）

日期：2026-09-02
关联文档：`docs/design/哨兵-会话续聊-Workbuddy-功能设计.md`（v1.1，评审通过）、PRD 模块 G2（v1.1 增补）、产品设计方案 §6.4（v1.1 增补）

## 背景与方案

Dashboard 任务面板此前是只读的。本次让用户在任务详情抽屉里**直接选中一个已有会话继续对话**：
输入的消息送进该会话对应的 Agent 任务，任务继续进行。范围按需求裁剪：仅支持 Workbuddy
（CodeBuddy），仅支持已有会话，不支持新建。

核心设计决策（详见设计文档 §6）：

1. **双路径投递**——会话进行中（最新轮 RUNNING/PENDING/NEEDS_AUTH）时，消息进透传队列
   且**带 taskId 定向**，等该会话本轮的 Stop 钩子注入（`continue:false + reason`），
   不会被同 Agent 其他会话抢走；会话已终态时，经 `@tencent-ai/agent-sdk`
   （V1 稳定 API `query()` + `Options.resume`，**评审确认引入的新依赖**，锁定 0.3.250）
   无头续跑，钩子照常触发、自动产生新一轮任务；
2. **SDK 关键约定**——`settingSources: ['user']` 必须显式设置（SDK 默认不加载任何
   文件系统配置，漏了哨兵钩子不会触发）；回复从结构化消息流（`ResultMessage.result`）
   取值，不做 stdout 解析；超时/退出经 `AbortController` 中断；
3. **回复落库**——无头续跑结束后，回复以内部事件（`transport: 'internal'`）写入当前轮
   任务的 `last_assistant_message` → `task.summary`，经既有 `pushEvent` 推送驱动前端刷新；
   进行中会话的注入回复拿不到原文（Workbuddy L2 限制），对话流如实显示占位说明；
4. **会话维度对话流**——「任务=一轮对话」建模不变，前端对话流按 session 聚合所有轮次
   （用户消息取 `task_started.detail`，Agent 回复取 `task.summary`，状态行内标注），
   状态机零改动（回复补录走 `from===to` 同状态迁移）；
5. **微信链路完全不动**——`canHeadless` 保持 false（它只门控微信透传超时兜底），
   消息路由器、默认目标判定、无头拉起兜底行为均无变化。

## 变更明细

- `docs/design/哨兵-会话续聊-Workbuddy-功能设计.md`：新增（v1.1，含 Spike 结论）；
- `docs/specs/哨兵-MVP-PRD.md`：模块 G2 增补会话续聊验收项；
- `docs/design/哨兵-多Agent值守中控-产品设计方案.md`：新增 §6.4 面板会话续聊，§7.1 UI 行更新；
- `packages/app/package.json`：新增依赖 `@tencent-ai/agent-sdk@0.3.250`；
- `packages/shared/src/ipc.ts`：新增 IPC 通道 `tasks:send-message` / `tasks:conversation`，
  类型 `ChatEntry` / `SendTaskMessageResult`，`YouyiBridgeApi` 增加两个方法；
- `packages/shared/src/agents.ts`：workbuddy `canHeadless` 注释澄清（false 只约束微信兜底，
  不代表不能 SDK 无头续跑）；
- `packages/app/src/preload/index.ts`：暴露 `sendTaskMessage` / `getConversation`；
- `packages/app/src/main/adapters/types.ts`：`AgentAdapter` 新增可选方法 `resumeSession`
  （区别于 `sendHeadless`：必须 resume 指定会话、收集回复、可被调用方中断）；
- `packages/app/src/main/adapters/workbuddy.ts`（新建）：`WorkbuddyAdapter extends
  JsonHooksAdapter`，SDK `query()` 无头续跑 + 超时中断 + 错误翻译；方言表本身零改动；
- `packages/app/src/main/adapters/index.ts`：Workbuddy 换用子类；
- `packages/app/src/main/store/`（types/sqlite/memory）：`TaskRepo` 新增
  `listBySession`（对话流数据源，`started_at` 升序取全部轮次）；
- `packages/app/src/main/router/session-chat.ts`（新建）：编排层——校验 / 并发锁
  （session 级，同一会话同时仅一个续跑）/ 路径判定（按会话最新轮状态，而非选中轮）/
  审计（action=relay、channel=dashboard）/ 回复与失败事件落库 / `conversation()` 组装 /
  `dispose()` 退出清理；
- `packages/app/src/main/sentinel.ts`：装配 `SessionChat`，`stop()` 时先叫停续跑；
- `packages/app/src/main/ipc.ts`：注册两个 handler；
- `packages/app/src/main/adapters/base/json-hooks-adapter.ts`：`onPrompt` 的 prompt 截断
  200→500 字（对话流用户气泡直接取该字段）；
- `packages/app/src/renderer/`：`Dashboard.tsx` 任务详情抽屉新增对话流 + 输入区
  （仅 Workbuddy 有 session 时开放，Enter 发送、输入法组词保护、10000 字上限、
  busy/错误反馈、`pushEvent` 驱动刷新）；`dashboard.css` 新增 chat 系列样式。

## 影响评估

- **安全面**：未新增绕过护栏的路径。无头续跑不自动放行任何权限（`permissionMode` 用
  SDK 默认，需确认的操作走既有 auth_required 流程，可在面板/微信闭环）；每条消息写入
  审计日志并如实标注渠道 `dashboard`；
- **兼容性**：`AgentAdapter.resumeSession` 为可选方法，既有适配器零改动；微信透传链路
  （路由器 / 透传队列 / tryHeadless 兜底）行为不变；`listBySession` 为新增查询，既有
  调用方不受影响；SDK 为新增依赖且仅主进程使用，渲染进程无感知；
- **测试**：新增 `packages/app/test/session-chat.test.ts`（路径判定 / 定向不串台 /
  并发锁 / 失败上报 / 审计 / dispose 中断 / 对话流组装，11 例），全量 118 个用例通过，
  构建（含类型检查）通过；
- **遗留与运行时验证**（设计文档 §8，需真实环境联调）：V2 `settingSources:['user']` 下
  钩子是否触发；V3 与交互式终端双开同一会话的并发安全；V4 SDK 单轮模式权限行为；
  V5 SDK Preview 升级与 Electron 打包后的子进程/CLI 定位（必要时用
  `CODEBUDDY_CODE_PATH` 显式指向，打包配置需纳入依赖白名单验证）。
