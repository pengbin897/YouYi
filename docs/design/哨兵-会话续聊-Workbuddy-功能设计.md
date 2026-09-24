# 「哨兵」前端会话续聊（Workbuddy）功能设计

> 版本：v1.1（待评审）｜ v1.1 变更：经评审确认，无头续跑改用 `@tencent-ai/agent-sdk` 实现（原 CLI 直调方案作废）
> 需求来源：功能优化 —— 在前端页面选择一个已有会话任务继续对话
> 参考：`docs/references/codebuddy-sdk.md`（CodeBuddy Agent SDK 官方文档）
> 文档状态：待评审 ｜ 评审通过后先同步 PRD / 产品设计方案，再进入编码

---

## 1. 背景与目标

当前哨兵的 Dashboard（任务面板）是**只读**的：用户能看到任务状态、事件时间线、最后一次回复，但想对某个会话说一句话（追问、改需求、让任务继续），只能去微信发消息走全局路由，或者回到电脑前在 Agent 终端里操作。

本次目标：**在 Dashboard 的任务详情里，直接选中一个已有会话，输入消息，把消息送进该会话对应的 Agent 任务，让对话继续进行下去。**

| # | 目标 | 说明 |
|---|------|------|
| G1 | 已有会话可续聊 | 从任意一个 Workbuddy 任务卡片进入，都能给它的会话发消息 |
| G2 | 消息定向送达 | 消息只进**选中的那个会话**，不会被同 Agent 的其他会话抢走 |
| G3 | 回复可见 | Agent 的回复（能拿到原文时）出现在对话流里；拿不到时如实说明 |
| G4 | 全链路可审计 | 前端发起的每条消息写入审计日志，渠道标注 `dashboard` |

## 2. 范围（Non-Goals）

| 不做 | 原因 |
|------|------|
| 只支持 codebuddy（workbuddy），其他 7 家不开放入口 | 按需求裁剪；机制留在适配器层，后续可逐家放开 |
| 不支持新建会话任务 | 按需求裁剪；只能从已有会话继续 |
| 不改微信透传链路 | 微信侧的默认目标判定、超时兜底行为保持不变（见 §7-D5） |
| 不做流式输出（打字机效果） | SDK 消息流按轮消费，回复在本轮结束后一次性呈现；流式属于后续增强 |
| 不做富文本 / 图片 / 语音 | 文本消息即可 |
| 不替用户放行权限 | 无头运行中遇到需确认的操作，沿用现有 auth_required 流程，不自动批准 |

---

## 3. 名词对齐：会话 vs 任务

现有模型（`session-tracker.ts` 的建模决定）：**任务 = 一轮对话，会话 = 对话本体**。用户在同一个 Workbuddy 会话里每提交一次 prompt，就开一个新任务（新一轮），中间的事件都归到当前任务上。

因此「选择一个已有会话继续对话」在数据上意味着：**消息送进该会话（session_id），随后产生新一轮任务**。前端按「会话」组织对话流，而不是让旧任务卡片"复活"。这是本次交互与数据展示的基准，详见 §5.1。

---

## 4. 用户交互设计（前端）

### 4.1 入口与形态

在 Dashboard 任务卡片的详情抽屉（`TaskDetail`）中新增**对话区**：

```
┌─ 任务详情抽屉 ────────────────────────────────┐
│ 会话标题 / Agent / 状态 / 耗时                  │
│ cwd                                            │
├─ 对话流（按会话聚合，见 §5.1）─────────────────┤
│  [用户] 帮我重构登录模块                        │
│  [Workbuddy] 已完成，共改动 3 个文件…（回复原文） │
│  [用户] 再补一个单测                            │ ← 本次新增能力
│  [Workbuddy] （正在处理…）                      │
├─ 输入区 ──────────────────────────────────────┤
│ [输入框………………………………] [发送]                  │
└────────────────────────────────────────────────┘
```

- 现有「事件时间线」保留，作为对话流的折叠/并列区块（对话流是抽取后的视图，时间线是全量事实）。
- 输入区**仅当** `task.agent_id === 'workbuddy'` 且 `task.session_id` 存在时渲染；否则显示灰字说明：「续聊目前仅支持 Workbuddy 的会话」。
- 发送后输入区进入 busy 态，按返回结果给出即时反馈（见 §4.2）。

### 4.2 发送反馈

| 场景 | 即时反馈 | 后续更新 |
|------|---------|---------|
| 任务进行中（RUNNING / PENDING / NEEDS_AUTH） | 「已排队，Workbuddy 这一轮结束后就会收到」 | Stop 注入后事件时间线出现「已把你的消息转达给 Workbuddy」，新一轮开始后对话流出现新的用户气泡 |
| 任务已结束（COMPLETED / FAILED / STALLED） | 「已发送，Workbuddy 开始处理这一轮」 | 新一轮任务出现在「进行中」，完成后对话流出现 Agent 回复气泡 |
| 该会话已有一条在处理（无头运行中） | 报错：「这个会话正在处理你上一条消息，稍后再发」（输入框保持内容不丢） | — |
| 会话已不存在（CLI resume 失败） | 报错：「会话可能已被清理，无法继续」 | — |
| 发送内容为空 | 不允许发送 | — |

对话流与任务状态通过既有的 `pushEvent` / `pushTasks` 推送驱动刷新，前端不做业务判断。

---

## 5. 技术方案

### 5.1 数据流总览

```
渲染进程                    主进程                                本机
────────                   ────────                              ────
TaskDetail 抽屉
  │ sendTaskMessage(taskId, text)
  ▼
                     ┌─ ipc.ts: tasks:send-message ─┐
                     │  SessionChat.send()          │
                     │  1. 校验（agent=session=文本） │
                     │  2. 并发锁检查（§7-D4）        │
                     │  3. 路径判定：                 │
                     │     任务活跃 → RelayQueue      │──┐
                     │     任务终态 → resumeSession   │──┼──► @tencent-ai/agent-sdk query()
                     │  4. 审计（channel=dashboard）  │  │   （resume=<sid>，SDK 子进程续跑）
                     └──────────────────────────────┘   │
                                                        ▼
                     ┌─ 既有 Hook 管线（自动工作）────────┐
                     │ 无头进程触发 UserPromptSubmit 钩子  │
                     │  → startTurn 新一轮任务            │
                     │ Stop / PreToolUse / … 钩子照常     │
                     └───────────────────────────────────┘
                                                        │
渲染进程 ◄── pushEvent / pushTasks ─── engine.ingest ◄──┤
  抽屉重拉对话流                                        │
                     ┌─ 消息流结束/中断后 ────────────────┐
                     │ 回复文本 → 内部事件挂 summary      │
                     │ → pushEvent 驱动前端刷新           │
                     └───────────────────────────────────┘
```

### 5.2 两条投递路径

主进程新增 `SessionChat` 模块（`packages/app/src/main/router/session-chat.ts`），`send(taskId, text)` 的路径判定：

**路径 A：任务进行中 → 透传队列定向注入（复用现有机制）**

- 条件：`task.status ∈ { RUNNING, PENDING, NEEDS_AUTH }`（该会话的交互式进程还活着、本轮还没结束）。
- 动作：`relay.enqueue({ agentId: 'workbuddy', taskId, text })`——**带 taskId 定向**。`RelayQueue.take()` 现有过滤逻辑（`e.taskId === taskId`）保证消息只被该会话的 Stop 钩子取走，不会被同 Agent 其他会话抢走。
- 注入方式：Workbuddy 方言表已有的 `inject: { continue: false, reason: text }`。
- 回复限制：Workbuddy 的 Stop 钩子拿不到 `last_assistant_message`（L2 能力限制，`agents.ts` 注释），所以这一路径**没有回复原文**，对话流里该轮 Agent 气泡显示占位说明「这一轮的回复原文 Workbuddy 不提供，完整内容见终端」。

**路径 B：任务已终态 → 无头续跑（本次新增的核心能力）**

- 条件：`task.status ∈ { COMPLETED, FAILED, STALLED }`，且 `task.session_id` 存在。
- 动作：适配器新增 `resumeSession()` 方法（见 §5.4），内部调用 **SDK 稳定版 V1 API**：
  ```ts
  import { query } from '@tencent-ai/agent-sdk'

  const q = query({
    prompt: text,
    options: {
      resume: task.session_id,     // 恢复指定会话（SDK Options.resume，官方文档明确支持）
      cwd: task.cwd,               // 在原工作目录续跑（字段存在性见 §8 V1 验证）
      settingSources: ['user']     // 关键：SDK 默认不加载任何文件系统配置，必须显式加载
    }                              // 用户级 ~/.workbuddy/settings.json，否则哨兵钩子不会触发
  })
  for await (const message of q) { /* 收集 AssistantMessage 文本 */ }
  ```
  超时 10 分钟（与现有 `sendHeadless` 一致）：到点调用 `q.interrupt()` 中断并上报失败。
  不使用 `unstable_v2_resumeSession`——V2 处于实验阶段（API 可能变化），单轮续跑用 V1 `query()` 已足够。
- 任务追踪：SDK 默认**不加载任何文件系统配置**（官方文档明确），必须显式 `settingSources: ['user']` 加载 `~/.workbuddy/settings.json`，哨兵装的钩子才会照常触发——`UserPromptSubmit` → `startTurn` 开新一轮任务，`Stop` 收尾。即任务生命周期完全复用现有 Hook 管线，`SessionChat` 不需要自己造任务。
- 回复获取：消费 `query()` 的消息流，收集 `AssistantMessage` 的文本块（或末条 `ResultMessage.result`）作为本轮回复——结构化取值，不依赖 stdout 文本解析。拿到后以**内部事件**（`transport: 'internal'`）经 `engine.ingest` 写入当前轮任务的 `task_meta.last_assistant_message` → `applyEvent` 更新 `task.summary`（现有逻辑，500 字截断）。同状态迁移（`COMPLETED → COMPLETED`，`from === to`）被状态机允许，只补 summary 不改状态。
- 若钩子在 SDK 续跑中不触发（风险 V2，见 §8）：兜底方案为 `SessionChat` 自行上报——调用 SDK 前后自行调用 `sessions.startTurn()` + `engine.ingest`（internal 的 task_started / task_completed with 回复）。**先做验证实验再决定是否需要**，避免双上报。

### 5.3 回复与前端刷新链路

- 无头轮回复：内部事件 → `engine.emit('event')` → `pushEvent` → 抽屉监听到该 session 的事件后重拉对话流（`getConversation`）→ Agent 气泡出现。
- 进行中状态：新一轮任务经 pushTasks 出现在「进行中」区；对话流末尾显示「正在处理…」状态气泡。
- 无头运行中遇到需确认的操作：`PreToolUse` 闸门（若用户开启了 `gateToolUseAgents`）照常挂起，面板出现待确认卡片，用户可放行/拒绝——**这正好是本功能的加分项**：续聊产生的授权请求可以在前端闭环处理。

### 5.4 模块改动清单

| # | 文件 | 改动 |
|---|------|------|
| 1 | `packages/shared/src/ipc.ts` | 新增 IPC 通道 `tasks:send-message`、`tasks:conversation`；新增 `ChatEntry`、`SendTaskMessageResult` 类型；`YouyiBridgeApi` 增加两个方法 |
| 2 | `packages/shared/src/task.ts` | `AuditAction` 无需新增（复用 `relay`），`AuditLog.channel` 取值文档补充 `dashboard` |
| 3 | `packages/app/src/preload/index.ts` | 暴露 `sendTaskMessage` / `getConversation` |
| 4 | `packages/app/src/main/adapters/types.ts` | `AgentAdapter` 新增**可选**方法 `resumeSession?(text, { sessionId, cwd }): Promise<{ ok: boolean; reply?: string; error?: string }>` |
| 5 | `packages/app/src/main/adapters/workbuddy.ts`（新建） | `WorkbuddyAdapter extends JsonHooksAdapter`，覆写 `resumeSession`：调用 `@tencent-ai/agent-sdk` 的 `query()`（`resume` + `settingSources: ['user']`），消费消息流收集回复，超时 `interrupt()` |
| 6 | `packages/app/src/main/adapters/index.ts` + `packages/app/package.json` | 注册表中 Workbuddy 从 `new JsonHooksAdapter(WORKBUDDY_DIALECT)` 换为 `new WorkbuddyAdapter()`；新增依赖 `@tencent-ai/agent-sdk`（**已评审确认**，锁定版本） |
| 7 | `packages/app/src/main/router/session-chat.ts`（新建） | 编排：校验 → 并发锁 → 路径判定（A/B）→ 审计 → 无头轮回复落库。依赖注入与 `MessageRouter` 同构（store / relay / adapters / engine / sessions） |
| 8 | `packages/app/src/main/store/`（tasks 查询） | 新增 `listBySession(agentId, sessionId)`：按 `agent_id + session_id` 查全部轮次任务（`started_at` 升序）。现有 `list({limit:100})` 会漏掉旧轮次，不能复用 |
| 9 | `packages/app/src/main/ipc.ts` | 注册两个 handler；`getConversation` 在主进程组装 `ChatEntry[]`（见 §5.5） |
| 10 | `packages/app/src/main/sentinel.ts` | 装配 `SessionChat`，传入 ipc |
| 11 | `packages/app/src/renderer/src/pages/Dashboard.tsx` | `TaskDetail` 抽屉：对话流区块 + 输入区 + busy/错误态；订阅 `pushEvent` 按 session 刷新 |
| 12 | `packages/app/src/renderer/src/styles/` | 对话气泡、输入区样式 |
| 13 | `packages/app/src/main/adapters/base/json-hooks-adapter.ts`（`onPrompt`） | `prompt.slice(0, 200)` 放宽到 500——对话流的用户气泡依赖 `task_started.detail`，200 字太短 |
| 14 | `packages/shared/src/agents.ts` | `workbuddy.canHeadless` **保持 false**（它只门控微信透传超时的无头兜底，本次不动微信链路，见 §7-D5）；注释说明与前端续聊能力（`resumeSession`）的区别 |

### 5.5 对话流组装（主进程，`getConversation(taskId)`）

```
task = tasks.get(taskId)；无 session_id → null
turns = tasks.listBySession(task.agent_id, task.session_id)
entries: ChatEntry[] = []
for turn of turns（started_at 升序）:
  events = events.listByTask(turn.task_id)
  用户气泡  = turns 的 task_started 事件（detail 即 prompt）
  Agent 气泡 = turn.summary（有值时）
              └ 无值且终态 → 占位文案（L2 限制如实说明）
  状态气泡  = RUNNING →「正在处理…」；NEEDS_AUTH →「等你确认」；FAILED →「这一轮失败了」
```

`ChatEntry`：

```ts
export interface ChatEntry {
  id: string                 // 取 event_id 或 task_id 合成，作 React key
  role: 'user' | 'agent' | 'status'
  text: string
  at: string                 // ISO 时间
}
```

透传注入轮天然衔接：Stop 注入的 `reason` 会被 Workbuddy 当作新 prompt，触发 `UserPromptSubmit` → 出现新一轮的 task_started → 对话流里自然多一组用户/Agent 气泡，无需特殊处理。

---

## 6. 关键设计决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | **无头续跑使用 `@tencent-ai/agent-sdk`（评审已确认引入），只用 V1 稳定 API `query()` + `Options.resume`** | ① resume 继续指定会话是 SDK 官方文档明确支持的能力，比 CLI 参数组合更稳；② 回复从结构化消息流（`AssistantMessage` / `ResultMessage`）取值，不做 stdout 文本解析；③ 避开 `unstable_v2_*` 实验 API；④ 认证复用 CLI 登录凭据，无额外登录环节。两个代价：SDK 处于 Preview（锁定版本、升级走变更评审）；SDK 默认不加载任何配置文件，必须显式 `settingSources: ['user']` 钩子才会触发 |
| D2 | **会话续聊产生新一轮任务，不复用旧任务** | 遵循现有「任务=一轮对话」建模；强行让终态任务复活需要破坏状态机的终态保护（其存在意义是防钩子乱序事件拉回已完成任务），代价远大于收益。前端按会话聚合，用户感知仍是「同一个对话」 |
| D3 | **状态机零改动** | 续聊全部事件走现有合法迁移（新一轮从 PENDING 开始）；无头回复补 summary 走 `from === to` 的同状态迁移，状态机已放行 |
| D4 | **并发锁按 session_id，同一会话同时只允许一个无头续跑** | 两个进程并发 resume 同一会话有会话文件写冲突风险；运行中的输入直接拒绝并提示（不排队），简单诚实。任务活跃时本就走 Stop 注入路径，无此问题 |
| D5 | **微信链路不动，`canHeadless` 保持 false** | `router.tryHeadless` 是微信透传**超时后**的兜底，本次不改变微信侧行为（避免超范围影响）；后续「微信透传也切无头续跑」另立变更评估 |
| D6 | **回复原文取自 SDK 消息流，而非钩子回传** | Workbuddy 钩子拿不到 `last_assistant_message`（L2），但无头续跑由我们自己发起并消费整个消息流——这是本功能能拿到回复原文的唯一途径，也顺带把 summary 补全了 |
| D7 | **前端发送走专用 IPC，不经 `MessageRouter.handleInbound`** | 用户已在界面上**显式选中了目标会话**，不需要（也不应该）走意图解析与默认目标判定；`handleInbound` 的 reply 出口是微信渠道，也不适配。但**审计与安全护栏对齐 router 的语义**（action=relay、高危不自动放行） |

---

## 7. 边界与异常

| 场景 | 行为 |
|------|------|
| 消息发送时任务刚好从终态变活跃（竞态） | 判定以发送瞬间快照为准；若走了无头路径而会话实际在跑，钩子事件仍按 session 归位，最坏情况是对话多了一轮无头执行，如实展示 |
| 续跑超时（10 分钟） | 对活跃 Query 调用 `q.interrupt()`，内部事件上报 task_failed（「这一轮超时被终止」），对话流可见 |
| SDK 调用失败 / resume 报错（会话被清理、CLI 未登录） | `resumeSession` 返回 `{ ok: false, error }`，前端内联报错；无钩子事件产生，不污染任务数据 |
| 用户在无头运行中又发一条 | 并发锁拒绝，提示「正在处理上一条」 |
| 该 Workbuddy 会话的交互式终端仍开着 + 任务已终态 | 允许无头续跑（resume 追加到同一会话）；同一会话双进程风险见 V3 |
| 空消息 / 超长消息 | 空消息前端拦截；超长（>10000 字符）前端提示截断或拒绝 |
| 应用退出时续跑仍在进行 | SDK 子进程随主进程退出可能成为孤儿——在 `app.beforeQuit` 里对记录中的活跃 Query 调用 `interrupt()`（复用现有退出清理模式） |
| 非 workbuddy 任务 / 无 session_id | 输入区不渲染，显示能力说明（如实标注，不夸大） |

---

## 8. 风险与待验证项（实现前 Spike）

| # | 风险 | 验证方式 | 兜底 |
|---|------|---------|------|
| V1 | SDK 能否在 Electron 主进程中正常工作（`query()` 拉起子进程、复用 CLI 登录凭据）；`Options` 是否有 `cwd` 字段 | 最小 demo：主进程里 resume 一个真实会话跑通 | 无 `cwd` 字段则接受 SDK 默认目录，事件里的 cwd 以钩子上报为准 |
| V2 | `settingSources: ['user']` 下钩子是否照常触发（SDK 默认不加载配置，漏配则哨兵感知不到续跑） | SDK 续跑一轮，观察哨兵事件 | `SessionChat` 自行上报 internal 事件（§5.2 路径 B 兜底） |
| V3 | resume 一个仍被交互式终端打开的会话是否安全 | 双开实验（终端开着 + SDK resume） | MVP 已通过「任务活跃时禁走无头路径」降低概率；文档标注建议 |
| V4 | SDK 单轮模式的权限确认行为（可能自动拒绝需确认的操作） | 构造需确认的操作实验 | 如实展示结果（错误/跳过），不自动放行——安全红线 |
| V5 | SDK Preview 阶段 API 变动；Electron 打包后子进程/CLI 定位失败 | 锁定版本；打包后冒烟验证；必要时用 `CODEBUDDY_CODE_PATH` 显式指向用户 CLI | 升级走变更评审；打包配置把 SDK 加入依赖白名单（asarUnpack 等） |

---

## 9. 测试与验收

### 单元测试（沿用 `packages/app/test/` 现有模式）

- `SessionChat`：路径判定（活跃→relay 带 taskId / 终态→resumeSession）、并发锁拒绝、无 session 报错、审计写入（channel=dashboard）。
- `resumeSession`（mock SDK `query()`）：成功收集 reply、流中错误返回 error、超时触发 `interrupt()`。
- 对话流组装：多轮任务 → 气泡顺序与内容、无 summary 的占位、状态气泡。
- 状态机回归：无头回复补 summary 的同状态迁移不破坏现有用例。

### 验收标准

- [ ] Workbuddy **已结束**任务：发送消息 → 无头进程拉起 → 新任务出现在「进行中」→ 完成后对话流出现 Agent 回复原文
- [ ] Workbuddy **进行中**任务：发送消息 → 提示已排队 → 本轮 Stop 后注入（时间线可见「已把你的消息转达给 Workbuddy」）→ 对话继续
- [ ] 消息定向：同 Agent 多个会话并行时，消息只进选中的会话
- [ ] 非 Workbuddy 任务不出现输入区，且有明确能力说明
- [ ] 会话不存在 / 二进制缺失 / 并发发送：错误信息明确，输入内容不丢失
- [ ] 每条消息有审计记录（action=relay, channel=dashboard）
- [ ] 不影响微信透传既有行为（回归 `notify-router.test.ts`）

---

## 10. 实现拆解（评审通过后）

1. **Spike**（半天）：验证 V1–V5（在 Electron 主进程用 SDK resume 真实会话跑通全链路），结论回填本节
   - ✅ V1（API 形状，SDK 0.3.250 类型定义核实）：`Options.resume` / `Options.cwd` / `Options.settingSources` 均存在；`ResultMessage`（subtype `success`）携带 `result` 文本；错误类型 `CLIStartupError` / `ExecutionError` / `AbortError`；`Query.interrupt()` 可中断；`query()` 在首个 ResultMessage 后自动关闭子进程。剩余待运行时验证：Electron 打包后的子进程/CLI 定位、登录态复用
   - ⏳ V2（`settingSources: ['user']` 下钩子是否触发）、V3（双开安全）、V4（权限行为）：需真实环境运行验证，留给联调阶段
2. shared 类型 + IPC 契约（#1–#3）
3. 引入 `@tencent-ai/agent-sdk` 依赖（锁定版本）+ `WorkbuddyAdapter.resumeSession`（#4–#6）+ 单测
4. `SessionChat` + store 查询 + ipc handler（#7–#10）+ 单测
5. 前端抽屉改造（#11–#12）
6. 回归全量测试 → 更新 PRD / 产品设计方案 → 写 changelog

## 11. 文档同步点（代码完成后）

- `docs/specs/哨兵-MVP-PRD.md`：模块 G2 任务卡片详情增加「会话续聊」验收项；模块 D 补充 dashboard 入口说明
- `docs/design/哨兵-多Agent值守中控-产品设计方案.md`：前端交互章节补对话区设计
- `changelogs/2026-XX-XX-前端会话续聊支持Workbuddy.md`
