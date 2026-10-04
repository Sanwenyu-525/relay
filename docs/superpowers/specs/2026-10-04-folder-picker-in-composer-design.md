# 先聊天、按需选目录：工作空间级会话与文件夹作用域行

日期：2026-10-04。状态：设计已批准，待实施。

## 1. 问题

用户反馈：「新建对话应该直接在聊天框那里就可以选择文件夹」。

核对源码确认这不是偏好问题，而是当前实现有一条结构性断路。`CollaborationView.tsx:456` 的分支是：

```
task === null
  ├─ folder === null → PageHeader + FolderScope 两按钮 + TargetPicker，无聊天框
  └─ folder !== null → folder-scope-bar + AssistView
```

聊天输入区**只在目录已打开后才存在**。用户必须先点「打开文件夹」→ 走原生选择器 → 服务端 `openWorkingDirectory` 返回 → 才渲染出聊天框。

目录不就绪时会进一步退化。`CollaborationView.tsx:310` 只在 `status === "READY"` 时取 `folderProjectId`，而 `:507` 以 `folderProjectId !== null` 为条件渲染 `AssistView`。因此 `status === "NOT_READY"`（含截图中的 `OVERLAPPING_OTHER_PROJECT`）会进入「已打开目录」分支却不渲染聊天框 —— 页面只剩两个按钮和一段灰字。

该状态的后端成因在 `open-working-directory.ts:238-246`：目标目录落在另一个已受管根之内或包含它时，返回 `NOT_READY` + `OVERLAPPING_OTHER_PROJECT` 并列出候选，不新开项目。

## 2. 已核对的现有能力

以下均经源码核对，不是推测。

**无需改数据库、无需改既有端点即可支持「工作空间级会话」：**

- `0015_m04_assist.sql:8` 的 `project_id uuid REFERENCES projects(id)` 可空。
- `assist-commands.ts:57` 的 `projectId?: string | null` 可缺省；`:87` 仅在非空时锁项目。
- `requestAssistMessage` 同理（`:168`）。
- `assist-api.ts:200`：`GET /assist-sessions` 的 `project_id` / `task_id` 均缺省时不下过滤条件，即列出工作空间全部会话。

**必须新增的部分：**

- 没有任何接口能修改已有会话的 `project_id`。`assist-repository.ts:38` 的 `archiveSession` 是唯一改 `assist_sessions` 的地方，只改 `status`。
- `0051_conversation_execution_requests.sql:7` 的 `project_id` 与 `:10` 的 `resource_id` 均为 `NOT NULL`。因此 `project_id IS NULL` 的会话在**结构上无法发起执行请求**。绑定不是可选优化，是该路径能走通的必要条件。
- `AssistView.tsx:150`、`:406` 强制要求 `targetKind` + `targetId`，否则渲染「正在核对对话目标与会话」后 `return`。无 target-less 模式。
- `RecentWorkRail.tsx:38-42` 只取 `getWorkspaceTasksPage` 与 `getProjectsPage`，按 `projectId` 分组。会话不在侧栏，未归属会话会成为看不见的孤儿。
- `AssistView.tsx:285` 的会话标题为 `关于${target.title}`；target-less 模式无 target，需另定标题来源。

## 3. 已确认决策

用户逐项确认：

| 编号 | 决策 |
|---|---|
| A | 工作空间级会话（`project_id = NULL`）。纯讨论不碰项目。 |
| A1 | 新增「绑定会话到项目」命令，改已有会话的归属。 |
| B1 | 绑定命令**只**改 `project_id`，不带 `resource_id`。 |
| 布局 | 方案 1：作用域行，输入框上方独立一行。 |
| C1 | 侧栏新增「未归属的讨论」分组。 |

**约束：不要把项目特色改没了。** 工作空间级会话是**过渡态**，不是平级工作模式。项目仍是唯一工作单元；未归属会话的状态是「这段讨论还没落到项目里」。绑定动作必须是这条路径的自然下一步，而非边角选项。

依据：若未归属会话不可见（无 C1），用户会经历「聊了 8 轮 → 选目录 → 侧栏出现项目 › 任务，但那 8 轮不在侧栏；若全程未建 Task 则连入口都没有」。产品退化为聊天记录，丢掉围绕项目推进、目录作用域与产物版本追溯这些实质差异。

## 4. 方案

### 4.1 会话归属模型

会话有两种归属，界面上必须能区分：

| 归属 | `project_id` | 可讨论 | 可执行 |
|---|---|---|---|
| 工作空间级 | `NULL` | 是 | 否（结构上不可，`0051` NOT NULL） |
| 项目级 | 某项目 | 是 | 需另有就绪目录 |

作用域行同时显示两个正交事实：**这段讨论属于哪个项目**（归属）与**当前目录能不能写**（执行准入）。二者不可互相推导 —— 有项目未必有目录，有目录必有项目。

### 4.2 新增绑定命令

```
POST /api/v1/workspaces/{workspace_id}/assist-sessions/{session_id}/binding
body: { command_id, project_id }
```

- 命令类型 `BindAssistSessionProject`，走既有 `runIdempotentCommand`，`command_id` 幂等。
- 语义：把工作空间级会话（`project_id IS NULL`）归入指定项目。
- 前置校验（同一短事务内）：
  - 会话存在且属于该 workspace；
  - 会话 `project_id IS NULL` —— 已归属的会话拒绝重绑，避免静默改写历史归属；
  - 会话 `status === 'ACTIVE'`；
  - 项目存在、未归档、属于同一 workspace，并 `lockWritableProjectInWorkspace`；
  - 该会话当前没有在途消息（`assist_messages` 存在 `PENDING`/`RUNNING` 行则拒绝）。在途时改归属会让消息回复落到与发送时不同的作用域。
- 成功：`project_id` 落库、`revision + 1`，返回该会话。
- **不改 `task_id`**：绑定到项目而非某个任务，保持 §18.2「纯讨论可以先不绑定 Task」。

不绑定 `resource_id`：目录就绪判定（`OVERLAPPING_OTHER_PROJECT` 等）属于执行准入，必须在执行准备时单独判定。B1 若一并接收 `resource_id`，绑定命令会变成「什么都能改」的口子，且未就绪原因会被吞掉、无法如实显示。

### 4.3 作用域行（协作页输入区上方）

```
┌────────────────────────────────────┐
│ 📁 D:\Develop\Relay-Agent    [换目录]│  ← 未选目录时：[📁 选择文件夹]
├────────────────────────────────────┤
│ 消息流…                             │
├────────────────────────────────────┤
│ [输入框                      ] [ ● ] │
│ 资料 │ 普通讨论              32px   │
└────────────────────────────────────┘
```

- 结构沿用现有 `folder-scope-bar`（`CollaborationView.tsx:495`），**从页面顶部移到输入区上方**，不重排区域。
- 目录是执行准入前提，不是发送选项，必须在输入区上方固定可见。否则用户会在不就绪状态下发出「帮我改这个」才发现不能写。
- 未选目录时该行显示 `[选择文件夹]`。
- 归属标识与绑定控件的显示规则（消除歧义）：
  - 会话未归属 → 显示「未归属的讨论」+ `[选择文件夹]` + `[归入已有项目]`。
  - 会话已归属且目录 READY → 显示项目名 + 目录路径 + `[换目录]`。
  - 会话已归属但无目录或目录未就绪 → 显示项目名 + 目录状态 + `[选择文件夹]`。**此时聊天框照常可用**，执行入口按目录状态关闭。
- 绑定控件**只在未归属时出现**。已归属会话不提供重绑入口（服务端也会拒绝），避免界面上出现一个必然失败的操作。
- `NOT_READY` 时就地显示 `FolderScope.tsx` 现有的 `notReadyReason` 文案，**补 `OVERLAPPING_OTHER_PROJECT` 的具体说明**（现落在 `:85` 的 default 分支，只说「目录尚未就绪」，未解释「这个目录落在另一个已受管根之内」）。同时显示候选项目按钮（复用 `folder-ambiguous` 的 `collab-folder-candidate-{id}`）。
- 目录未就绪时**聊天框正常可用**，只是执行入口按 `executionScope` 判定关闭。
- 底栏「资料 │ 普通讨论」保持不变，不并入目录控件 —— 准入事实与意图选项语义不同层级。

### 4.4 `AssistView` 的 target-less 模式

新增「未归属会话」目标形态，不再强制 `targetKind`/`targetId`：

- `target` 为 `null` 时不渲染「正在核对对话目标与会话」，直接渲染消息流与输入区。
- `projectWriteBlockedReason`：无项目时不因归档或项目事实失败而阻断 —— 用户还没有项目，只有目录执行准入一条限制。
- `firstComposer` 条件（`:415`）在 target-less 下同样成立：`deferSessionCreation && session === null`。
- 会话标题（`:285`）：target 存在时保持 `关于${target.title}`；target-less 时取首条消息前 30 字并去掉换行。**首条为空时用固定标题 `新讨论`** —— `assist-new-session`（`:450`）直连 `createSession()`，绕过 `sendFirst` 的空内容早退，这条路径上 `content` 确实可能为空；空标题会被 `0015_m04_assist.sql:11` 的 `CHECK (title <> '')` 拒绝。
- `onSessionCreated` 后协作页切到该会话，`folder` 状态不受影响。

### 4.5 侧栏「未归属的讨论」分组

`RecentWorkRail.tsx` 增加一次 `client.getAssistSessions()`（不传参数），筛出 `projectId === null && status === "ACTIVE"`：

- 独立分组，标题「未归属的讨论」，**视觉上与项目组明显不同**（项目组用 `<details>` + 项目名分组，未归属组不套在项目语义下）。
- 沿用 `getAssistSessions()` 的返回顺序（`assist-repository.ts:35` 的 `created_at desc, id desc`），不额外排序。活跃度排序需要改服务端查询契约，本轮不做。
- 点击 → 跳 `/collab?session={session_id}`。协作页新增 `session` 查询参数：与既有 `work`（taskId）并存，`session` 优先。它只读，用于恢复一个已存在的会话，不改变 `work` 语义与既有深链。
- 绑定成功后从该分组消失（`project_id` 已非 null）。
- 该分组是「绑定」动作价值感的来源，也是「这段讨论还没成为项目工作」的持续提示。

### 4.6 不做的事

- 不改数据库结构。
- 不改 `openWorkingDirectory` 的 `OVERLAPPING_OTHER_PROJECT` 判定 —— 该规则防止同一物理目录出现第二个写 Owner，是对的。
- 不让绑定命令自动发生，不静默改归属。
- 不为简化选择而删除 `TargetPicker`（进入已有任务讨论的入口保留）。
- 不开放执行路径：绑定后仍需目录就绪才可执行。

## 5. 边界与错误处理

| 情况 | 行为 |
|---|---|
| 未选目录就发送 | 正常建会话并讨论。首条不触发执行准备。 |
| 未归属会话请求执行 | 客户端会尝试发请求，服务端因 `0051` 的 `project_id NOT NULL` 拒绝。界面**必须先于请求**说明「先选目录并把讨论归入项目」，不让用户拿到一条数据库约束错误。 |
| `NOT_READY` 时发送 | 消息正常进入会话；执行入口关闭并显示具体原因。 |
| 绑定时项目已归档 | 409「项目已归档，不能归入」；不建第二个项目绕过。 |
| 绑定时会话已有归属 | 409「这段讨论已经归属于某项目」，不静默改写。 |
| 绑定时有在途消息 | 409 并说明原因。 |
| 绑定请求结果未明 | 按原 `command_id` 核对回执，不换 ID 重试（沿用 §18.5 首条未决命令的既有机制）。 |
| 绑定后重开页面 | 会话出现在项目组下；`resource_id` 仍需重新由目录确定。 |
| 绑定到当前已绑定的同一项目 | 幂等命中同 `command_id` 时返回同一结果；换新 `command_id` 且项目相同按「已归属」409，不静默成功。 |

## 6. 契约变更

**Breaking Change：Yes（新增为主，含一处语义收紧）**

- 新增：`POST .../assist-sessions/{id}/binding`、`BindAssistSessionProject` 命令类型、`GET /assist-sessions` 无参数用法（前端新采用，服务端本就支持）。
- 数据库：**无迁移**。
- 语义收紧：已归属会话不可重绑。这是新增约束，不是破坏既有客户端可达行为（该端点本来不存在）。
- 路由、既有命令 Owner、权限栅栏、工具适配器、`prepareGatewayAction` 词表均不变。

## 7. 文档同步

| 文档 | 改动 |
|---|---|
| `docs/frontend/workbench-design.md` §18.1 | 补「未选目录先讨论」与绑定规则；更新目录入口表格 |
| 同上 §18.4 | 补作用域行位置与 target-less 模式；更新元素清单 |
| 同上 §18.5 | 补绑定命令的未决回执沿用规则 |
| `docs/api/http-command-contract.md` | 新增绑定端点，标注 Breaking Change |
| `docs/architecture/domain-model.md` §12 | 补会话归属的应用责任 |
| `docs/frontend/design-system.md` | 作用域行与「未归属的讨论」分组的视觉规则 |
| `CODEX_NEXT_STEP.md` | 实施完成后更新 |

`OVERLAPPING_OTHER_PROJECT` 在 `FolderScope.tsx:85` 补具体文案。

## 8. 测试规格

**领域规则（单元）**：标题推导（有/无 target、有/无首条）；作用域行的状态组合矩阵（未选目录 / AMBIGUOUS / NOT_READY 各 reason / READY × 未归属 / 已归属）。

**真实 PG 集成**（`run-integration.ps1`）：

- 建 `project_id = NULL` 会话 → 发消息 → 成功，读回 `project_id` 仍为 null。
- 绑定到活跃项目 → `project_id` 落库、`revision + 1`；同 `command_id` 重放命中同一结果、不重复改。
- 绑定到归档项目 → 拒绝，`project_id` 不变。
- 绑定已归属会话 → 拒绝。
- 有在途消息时绑定 → 拒绝。
- 未归属会话发起执行请求 → 明确拒绝（不是 500）。
- 绑定后 `GET /assist-sessions?project_id=` 能查到该会话。

**前端组件**：target-less 会话渲染消息流与输入区；作用域行在六种目录状态下的文案与控件；`NOT_READY` 时输入区仍可用且执行入口关闭；侧栏未归属分组渲染与绑定后消失；`/collab?session=` 恢复未归属会话并与 `work` 共存。

**跨模块时序**：绑定命令与在途消息的竞争（并发真实 PG）；绑定后立刻重开页面恢复会话。

**反向验证**：每条回归先落测试、确认修复前失败，再改实现。

## 9. 未覆盖与限制

- 真实 Windows 原生选择器、取消、重启、中文 IME、DPI 未取证。
- 未归属会话不跨 workspace 迁移，不提供跨会话搜索。
- 绑定是单向的（不提供「移出项目」），避免把历史讨论重新洗成无归属。
- 侧栏未归属分组按创建序而非活跃度序，需要改服务端查询契约才能更准，本轮不做。
- 不改变 `OVERLAPPING_OTHER_PROJECT` 的服务端判定，因此截图那个具体状态**仍需用户显式选定候选项目**，本设计只保证此时仍可正常讨论、且候选按钮就在作用域行上。
- 本设计未经真实模型验证，不改变执行链的授权栅栏。