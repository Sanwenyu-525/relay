# 会话模式单选框与人设 bot（可读不可写）

日期：2026-10-05。状态：设计已批准（用户逐节确认），待实施。产品选择来源：2026-10-05 讨论。

本文只维护本专项的设计与验收边界，不复制第二套需求或成绩。实施进度只归 `CODEX_NEXT_STEP.md`，实际成绩只归[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)，未运行规格只归[测试计划](../../testing/verification-plan.md)。相关既有决策：[ADR-017](../../decisions/ADR-017-bounded-multi-agent-conversations.md)（有界多 Agent，本片**不**实施也不推翻）、[ADR-016](../../decisions/ADR-016-folder-first-conversation.md)（文件夹首条对话）、[ADR-005](../../decisions/ADR-005-reuse-first.md)。

## 1. 问题与范围

用户要求在聊天框里加一个切换模式的单选框，两档：

- **A 普通 Agent**：可自动建 Task/Delegate Run、改文件、跑检查；后续可派发子 Agent。
- **B 人设 Bot**：像 grok 自定义 bot 那样有固定人设，**可读不可写**。

范围决定（用户逐项确认）：

1. **本片只做 A/B 两档**。第三种「一次性轻量问答」并入 B 作为「不记住」开关，不单独占一档。
2. **B 的人设由用户自建具名 bot**（名字 / 角色描述 / 口吻 / 可选只读目录范围），服务端持久化、可复用可编辑。
3. **B 可读不可写**：能用只读工具读真实文件与已选资料版本；绝不建 Task、绝不委派、绝不写入、绝不申请动作审批。
4. **bot × 目录 = 一条独立会话**。
5. **切模式 = 换会话**；会话建立后其模式与人设快照冻结，同一会话内不可切换。
6. **控件层级**：模式单选框在上，原「发送选项」（讨论 / 提案 / Skill）归 A 档，B 档隐藏。
7. **多 bot 群聊不在本片**。它与 ADR-017 已否决的候选三（长期具名 bot + 多写入 Agent + 自主路由）实质重叠，需另开 ADR 单独决策，不得顺手塞进本片。

### 1.1 明确不在本片

- ADR-017 的有界多 Agent 与自动主子会话（A/B/C 三片，零代码）。
- 多 bot 群聊、长期角色记忆、跨项目 bot 路由。
- 关闭应用后的后台执行、远程配对、任意 Shell。
- B 档的写能力、Task 提案、Skill 调用。

## 2. 已核对的源码事实

实施时重新核对，不当作冻结保证。

| 事实 | 位置 | 结论 |
|---|---|---|
| `AssistSessionRow` 只有 `project_id` / `task_id` 关联，无父会话、角色、委派或 Run 关系 | `infrastructure/database-schema.ts:960` | B 档身份与会话冻结需新增列 |
| `declaredToolSpecs` 只被工具循环调用 | `workflow/tool-catalog.ts:114`、`application/tool-loop.ts:73` | 讨论轮次今天拿不到任何工具；B 档的只读能力必须新增一条声明路径 |
| 内部工具词表已含只读集 | `workflow/tool-catalog.ts:16` | `list_directory`/`find_paths`/`search_text`/`read_file`（`FILE_QUERY`/`FILE_READ`）、`git_status`/`git_diff`/`git_log`（`GIT_READ`）；写集为 `apply_changeset`/`read_change_set`/`run_check` |
| `run_tool_calls` 绑定 Run，Run 属于 Task | `migrations/0001_v001_human_core.sql`、`0008_v003_gateway.sql` | B 档不建 Task/Run，因此不能复用 Run 工具账本 |
| 现有输入区已有 intent 与 Skill 下拉 | `views/AssistView.tsx:1231`（`sendOptions`）、`:1368`（composer） | 模式控件与发送选项的层级按 §6 处理 |
| 解释层已有 `DISCUSS`/`CLARIFY`/`PREPARE` | `application/conversation-execution.ts:115` | A 档语义**不变**，B 档不进这条链路 |

## 3. 关键取舍：B 档的只读能力挂在谁身上

B 档要读真实文件，但现有工具账本绑定 Run，Run 属于 Task，而 B 档明确不建 Task。三条路：

| 方案 | 做法 | 结论 |
|---|---|---|
| 1. B 档也建 Task + Run | 只读对话走完整执行链 | **否决**。状态面板出现大量假 Task；把聊天塞进业务 Task 语义，验收与 Review Owner 被污染 |
| 2. 会话级只读工具轮次 | 新增会话级工具账本，请求挂 session；准入复用 Gateway 只读与连接权限；不产生 `scope_grant` / `ACTION_APPROVAL` | **采纳** |
| 3. B 档不给文件工具 | 只读已选资料版本 | **否决**。放弃用户明确要的 `find_paths`/`read_file`，退回纯聊天 |

**方案 2 的硬约束**：B 档工具轮次与 Run 是**两种不同的执行身份**。任何一边都不得填对方的 id 冒充，也不得沿用「不得填假 Operation 或直接塞 `result_ref`」之外的任何捷径（`AGENTS.md` §3.5、契约 01–04）。B 档不得产生 `tasks`、`runs`、`run_scope_grants`、`gateway_operations` 任何一行，由集成测试用 SQL 计数断言。

## 4. 对象、Owner 与持久化形状

### 4.1 新增实体

**`bot_profiles`**（迁移新增；编号实施时按当时链末取，不预占）

| 列 | 说明 |
|---|---|
| `id` / `workspace_id` | 作用域为 workspace |
| `name` | 用户可见名，workspace 内唯一（部分唯一索引，忽略已归档） |
| `role_description` / `tone` | 角色与口吻，冻结进会话快照 |
| `read_scope` | `jsonb`，**只能缩小**受管目录范围，缺省为该目录全读 |
| `revision` | CAS 用 |
| `status` | `ACTIVE` / `ARCHIVED` |
| `created_at` / `updated_at` | |

**bot 不自带任何权限。** 能力来自连接与 Gateway 准入；`read_scope` 只能缩小，不能扩大。

**`session_tool_calls`**（迁移新增）

| 列 | 说明 |
|---|---|
| `session_id` / `message_id` / `round` | 唯一约束 `(session_id, message_id, round)`，即幂等键 |
| `tool_name` / `arguments` | 逐字节透传 |
| `status` | `REQUESTED` / `SETTLED` / `REJECTED` / `ABANDONED` / `UNKNOWN` |
| `result_ref` / `result_digest` | 结果引用与摘要 |
| `stop_requested_at` | 持久化停止意图 |
| 时间戳 | 请求、结算 |

### 4.2 扩展 `assist_sessions`（迁移新增列，不改已应用迁移）

| 列 | 说明 |
|---|---|
| `conversation_mode` | `AGENT` / `BOT`，默认 `AGENT`，兼容既有会话 |
| `bot_profile_id` | 外键 `bot_profiles(id)` |
| `bot_profile_revision` | 建会话时的 bot 修订 |
| `bot_role_snapshot` | `jsonb`，冻结 `name`/`role_description`/`tone`/`read_scope` |
| `remember` | 布尔，默认 `true`；`false` 即「一次性问答」 |

约束：CHECK `(conversation_mode = 'BOT') = (bot_profile_id IS NOT NULL)`。**应用层与数据库同时保证**：`conversation_mode`、`bot_profile_id`、`bot_profile_revision`、`bot_role_snapshot` 在会话建立后不可改写。换 bot 必须换会话。

### 4.3 Owner

| 职责 | Owner |
|---|---|
| 建 / 改 / 归档 bot 配置 | `application` 新用例，`revision` CAS，归档走状态推进 |
| 建会话时的身份冻结 | 现有会话创建用例扩展，模式与人设快照在**同一短事务**内落库 |
| A 档发消息 | **现有** `conversation-execution.ts` 链路，语义不变 |
| B 档发消息 | **新**会话级只读轮次用例 |
| 工具请求准入与执行 | 现有 Gateway 只读准入与 Adapter；B 档只走只读动作 |
| 完成、验收、Review、批准 | **不归 B 档**。B 档永不产生这些事实 |

依赖方向不变：`UI / API → Application → Domain / Workflow → Repository / Integration Ports → Infrastructure`。

## 5. B 档轮次协议

1. **词表**：只读子集，按**当前**连接与权限裁剪（与 A 档同一套裁剪判定），再按 `read_scope` 缩小路径范围；配了 `GIT_READ` 连接才加 `git_status`/`git_diff`/`git_log`。快照**不**放行能力。
2. **禁写**：B 档词表不含 `apply_changeset`/`read_change_set`/`run_check`。模型若请求写工具，返回类型化拒绝并回传给模型，且在消息行**留痕可见**，不静默。
3. **不建 Task、不委派**：B 档不进入 `conversation-execution` 的 Apply/Delegate，不建 `scope_grant`，不产生 `ACTION_APPROVAL`。
4. **一轮一定义**：一条 USER 消息对应一个 `message_id`，其下 `round` 从 0 递增；同 `(session, message, round)` 重放返回原对象，异载荷拒绝。
5. **并发**：一个会话同时只允许一条在途轮次，第二条立即 409 明确返回，**不排队**（沿用「Worker 还没领取 ≠ 队列」的诚实原则；B 档没有 Worker，也没有队列）。
6. **不排队也不假装排队**：UI 不显示任何队列序；提示写成「本会话正在回答上一条」。
7. **`remember = false`**：轮次结算后不写入可续读历史；UI 标注该轮为「一次性」。历史清理的具体口径实施时核定，默认保留服务端运行账本（`model_calls`、`session_tool_calls`）不动，只是不作为会话消息续读。
8. **预算**：B 档调用进现有 `model_calls` 账本，按 **Session** 聚合（与现有 Assist 一致），共享同一会话限额；无 Run 因此不涉及主 Run 预算预留。耗尽走现有终止类拒绝，会话进入需人工处理状态，**不自动加预算**。

## 6. UI 与交互

**控件位置**：底部工具行最左侧（`agent-chat-composer-tools` 内，与「资料 N」「发送选项」同一行），不新增一行。理由：该输入框的阅读宽度与底栏对齐刚完成三轮返工校准，多插一行会再动它；控件集中一行与现状一致。使用真 `<input type="radio">`，两个 label：`普通 Agent` / `人设 Bot`，沿用现有控件 token，不造第二套。

**两档工具行**
- A 档：照旧——`资料 N` + `发送选项`（讨论 / 提案 / Skill）+ ContextMeter
- B 档：`bot 选择` + `不记住` 勾选 + 一句固定边界说明「只读：不改文件、不建任务、不派子 Agent」；**隐藏** `发送选项`
- 发送键、圆形键几何、底栏对齐不动

**切换语义**
- 切 radio = 导航到另一条会话：A → 该目录的 `AGENT` 会话（无则建空会话，**不自动建 Task**）；B → 所选 bot × 该目录的会话（无则建）
- 有未发草稿走现有 `requestTransition` 离页守卫，草稿留在原会话
- **在途时禁用切换**并说明「正在生成，停止后才能切换」；不允许用切 radio 隐式取消

**最小 bot 配置入口**：bot 下拉带「+ 新建 bot」，就地小表单（名字 / 角色描述 / 口吻 / 可选只读目录范围）直接存服务端。不做独立管理页、删除（只归档）、复制、头像上传。workspace 内重名明确报错且不改已有 bot。

**导航与深链**：会话面板按 mode 分「普通」/「Bot」两组，Bot 组显示 `bot 名 · 目录`；URL 带 `mode` + `bot` + 目录；**旧 URL 无 mode 一律按 `AGENT`**。跨项目或失权时 bot 与会话一起清投影，沿用现有规则。

**两处必须显式处理**
1. B 档消息行的角色标签显示 `bot 名 · 人设 v{revision}`，不用「AI」
2. B 档**不渲染 `ExecutionSummary`**（那里是「按这个执行」，B 档没有 Task），换成固定只读说明；工具调用沿用现有折叠卡片但标注「只读」，**不出现审批四态**

## 7. 控制、停止与恢复

B 档没有 Run，因此没有 Worker claim、没有 `ownership_epoch`、没有 Task 排队。控制语义必须与 A 档不同且不假装一样。

| 能力 | B 档 | 说明 |
|---|---|---|
| 停止 | **有** | 持久化 stop intent 到会话级轮次行；立即阻止新的模型与工具调用；在途按原身份处理到安全点；如实呈现「停止中 → 已停止」；晚到结果**不得复活**已停止轮次 |
| 暂停 / 继续 | **无，且不渲染** | 没有可移交的执行权 |
| Handoff / 人工接管 | **无，且不渲染** | 同上；渲染成禁用加解释等于虚构能力 |
| UNKNOWN 核对 | **有** | 按原身份核对，不盲重试、不换 Adapter、不换 ID；给「重新核对」入口 |

**幂等与恢复**：同 `command_id` + 同载荷重放返回原对象，异载荷拒绝。重启/重开后 bot 人设快照、bot 修订、`session_tool_calls` 状态与未决轮次都在；**读取不自动 Resume**，沿用现有规则。

**权限撤销（最易写错处）**
1. 人设快照冻结的是**文本，不是能力**。每轮按当前连接与权限裁剪词表；连接被删则 B 档立刻失去对应只读工具，不靠旧快照续命。
2. bot 被归档后，既有会话**冻结**：不再发新消息，给「重新选择 bot / 打开 bot」入口。依据是「批准不能覆盖已撤销权限」。

**验收诚实性**：B 档的模型回复**永远不是 PASS**，不进 Verification / Review / CompletionRecord，也不能被 A 档的完成提交当作依据或独立审查成绩。

## 8. 文案诚实性

A 档标签**不得**写「可派发子 Agent」——ADR-017 的子 Agent 至今零代码。单选框上 A 档只承诺现在真实存在的能力。B 档固定说明必须写明「不建任务、不改文件」，不得暗示可以代办。

## 9. 验收规格

### 9.1 领域单元
- B 档词表按当前连接裁剪，`read_scope` 只缩小
- B 档禁写工具的类型化拒绝码
- 会话身份三字段建立后不可改写
- B 档不进入执行链的判定

### 9.2 真实 PG / HTTP 核心反例
- B 档一轮真实只读调用走通 `find_paths → read_file`，**磁盘逐字节未变**
- B 档请求 `apply_changeset` → 拒绝、不写盘、**不连任何 Gateway Operation**
- 一轮结束后 SQL 断言 `tasks` / `runs` / `run_scope_grants` / `gateway_operations` 计数**全为 0**
- 同 `command_id` 同载荷重放返回原对象；异载荷拒绝
- `(session_id, message_id, round)` 并发唯一；第二条在途 409
- 建 bot：revision CAS、重名拒绝、归档后既有会话发消息被拒
- 连接删除后 B 档词表即时收窄
- 崩溃点：调用前、结果已存未回执、回执丢失，重开后按原身份续一次
- 兼容：既有会话（无 `mode`）读为 `AGENT`，旧 URL 仍解析

### 9.3 前端组件 + 真实 Chromium
- 两档渲染；A 档保留发送选项；B 档隐藏并显示只读说明
- 切 radio 导航到另一条会话且不重复建会话
- 在途时切换被禁并有说明；草稿守卫沿用
- B 档消息行显示 bot 名与人设修订
- B 档不渲染 `ExecutionSummary` 与审批四态
- radio 组键盘可达；中文 IME 合成中回车不发送；窄窗不溢出

### 9.4 明确未运行、不声称
真实 Windows 窗口、原生 IME、DPI、安装升级卸载；真实 Provider 的 B 档会话质量；ADR-017 子 Agent。规格不等于已运行结果。

## 10. 文档影响

| 文档 | 动作 |
|---|---|
| `Personal_Workflow_OS_Master_Spec.md` | 新增一节（**不能塞进 §0.9**：§0.9 是有界多 Agent，B 档是另一种会话身份，交叉引用不混写） |
| `docs/requirements/v1-scope.md` | 新增同名补充 |
| `docs/decisions/ADR-018-persona-bot-conversations.md` | **新增**。说明与 ADR-017 的关系：新增一种会话身份，不推翻也不前移多 Agent |
| `docs/architecture/runtime-context.md` | 新增「会话级只读工具轮次的对象身份与恢复」 |
| `docs/database/physical-design-postgresql.md` | 两张新表 + `assist_sessions` 增列 |
| `docs/api/http-command-contract.md` | 新端点与请求体扩展，标注 Breaking Change |
| `docs/frontend/workbench-design.md` | 新增一节（控件层级、切换语义、两档呈现） |
| `docs/frontend/design-system.md` / `design-tokens.json` | 只在复用现有控件时补链接；**不新增第二套 token**，数值不复制 |
| `docs/testing/verification-plan.md` | 新增**未运行**验收规格 |
| `CODEX_NEXT_STEP.md` | 阶段、下一步与授权 |
| `docs/testing/overall-acceptance-2026-09-28.md` | 只更新实际跑过的行 |

文档改动运行 `node scripts/check-docs.mjs`；文档检查不算运行验收。

## 11. Breaking Change 与兼容

**Breaking Change：Yes（语义）**

- 建会话请求体新增**可选** `conversation_mode` / `bot_profile_id`；既有字段与路由语义不变，不传即 `AGENT`
- `assist_sessions` 新增列（迁移），既有会话默认 `AGENT`，**不虚构 bot 关系**
- 新增端点不改既有端点；旧 URL 无 `mode` 按 `AGENT` 解析
- 迁移新增而非改写已应用迁移；回滚风险为新增列与新表可独立丢弃，`assist_sessions` 增列带默认值故旧代码仍可读

## 12. 待核定的工程协议

实施时按对象 → 用例与短事务 → 锁序 → 身份/版本/幂等 → 持久化与恢复 → API/UI 的顺序核定，不预占编号、不把推荐值写成既有事实：

- B 档只读轮次与应用用例的锁序位置（不进入 Task/Run 锁序，需说明为何不与 Run 竞争）
- `session_tool_calls` 与 `assist_messages` 的提交边界：消息行与工具行是否同事务
- `remember = false` 的历史清理口径
- 停止意图落在轮次行还是会话行
- 具体端点路径与 DTO 字段名
- 预算 Session 聚合上限的具体数值