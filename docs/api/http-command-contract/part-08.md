# HTTP 与应用命令契约：分册 08

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../http-command-contract.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

### 10.108 聊天目标与计划模式（2026-10-20 源码实现）

Breaking Change: **No**。会话与消息既有端点全部向后兼容：`chat_mode` 在两处响应上是新增
可选字段（0127 之前的响应读成 `CHAT`），消息请求体的 `chat_mode` 可省略（缺省沿用会话
持久模式）。

- **行为模式与会话身份分开**：`conversation_mode`（AGENT/ASSISTANT/LEARNING）建会话时
  冻结；`chat_mode`（CHAT/PLAN/GOAL）随命令切换，不改变身份、权限或工具准入来源。
- **`POST /assist-sessions/:id/messages`** 请求体新增可选 `chat_mode`。`/plan 内容`、
  `/goal 内容` 由客户端解析成「模式 + 正文」一次提交；服务端对以 `/plan `/`/goal `
  （含中文别名）开头的正文做同一剥离并与 `chat_mode` 核对一致性，因此原始 API 调用者
  发同一段文本得到同一事实。202 回执新增 `chat_mode`（受理档位）与 `goal_id`
  （本条消息归属的目标，非目标轮次为 null）。
- **计划模式边界**：PLAN 下拒绝非 DISCUSS 意图与 MODIFY 方法（INVALID_TRANSITION）；
  真正的只读闸门在工具准入——PLAN 轮次不声明写工具，写请求按既有
  `SESSION_WRITE_DISABLED` 路径拒绝。计划信封 `{reply, plan}` 结算时正文只落 `reply`，
  计划按「会话 × 版本号」与「会话 × 源消息」两个唯一键落 `assist_plans`，不产生执行候选。
- **读端点**：`GET /assist-sessions/:id/plans`（最新版 + 全部版本，新在前）、
  `GET /assist-sessions/:id/plans/:plan_id`、`GET /assist-sessions/:id/goal`
  （会话当前占用槽位的目标 + 最近轮次）。
- **模式切换**：`POST /assist-sessions/:id/chat-mode`，body `command_id` + `mode` +
  可选 `expected_revision`；回执 `session_id`/`chat_mode`/`revision`/`goal_stopping`
  （有活动目标切走时为 true，控制意图已保存）。同 command_id 重放返回原回执。
- **目标生命周期**：`POST /assist-sessions/:id/goals`（body `plan_id`，按确切一版计划
  启动；`allow_superseded: true` 才接受已被更新版取代的版本）；四条控制
  `POST /assist-goals/:goal_id/{pause,cancel,resume,complete}` 只提交意图，回执里的
  `goal.status` 是服务端当前事实（`PAUSING`/`CANCELLING` 不等于已停）。`resume` 在
  `BUDGET_EXHAUSTED` 时必须携带可授予额度；授权量按可核对事实计算（失败轮次冻结的模型
  快照 → 进程模型配置 → 最小窗口），写入 `assist_goal_budget_grants`（`command_id`
  唯一），共享预算闸门把它加在既有会话级上限上。
- **推进 Owner**：目标轮次由 Worker tick（`worker_goal_tick`）接续，页面请求不参与推进；
  一条会话最多一个未终结目标（部分唯一索引），轮次结算按消息唯一键幂等，重启重扫不产生
  第二条链。COMPLETE 只表示模型自检完成，`AWAITING_ACCEPTANCE` → `COMPLETED` 只能由
  `complete` 命令人工确认。

### 10.109 会话工具轮次的只读投影（2026-10-21 源码实现）

Breaking Change: **No（新增只读端点）**。`session_tool_calls` 自迁移 `0060` 起只有写入口与
恢复入口（`listPending()`），没有任何 HTTP 读法；Agent 主流程每轮调了什么工具因此只能落库，
协作页上只剩一个「正在生成」。本节补那一只读口子，不改任何写路径、状态机或准入判定。

- **`GET /api/v1/workspaces/{workspace_id}/assist-sessions/{session_id}/messages/{message_id}/tool-calls`**：
  200、`Cache-Control: no-store`，响应
  `{session_id,message_id,message_status,rounds:[{round,calls:[…]}]}`。`rounds` 按 `round` 升序，
  每轮 `calls` 按 `ordinal` 升序；一行一次调用，`arguments` 是模型当时提交的那一份**逐字节透传**，
  投影不新增「摘要」「人类可读结论」字段——界面要能与账本对账。
- **单行字段**：`id`、`round`、`ordinal`、`tool_name`、`status`、`arguments`、`arguments_sha256`、
  `provider_tool_call_id`、`operation_id`、`rejection_reason`、`rejection_detail`、`result_digest`、
  `requested_at`、`settled_at`。`status` 词表为 `REQUESTED|SETTLED|REJECTED|ABANDONED|UNKNOWN`，
  与 §10.56 的 Run 轨迹**刻意不同**：会话轮次没有 Task/Run，也就没有 `PREPARED` 与
  `WAITING_APPROVAL`；`UNKNOWN`（结果未知、等人工核对）只在会话侧出现。
- **作用域与缺失**：会话不属于该 Workspace、消息不属于该会话、或两者任一不存在，一律 404
  `RESOURCE_NOT_FOUND`；一条没有发起过工具调用的消息返回 200 且 `rounds: []`——那是事实，
  不是读取失败。`message_status` 是原消息的当前状态，供调用方判断这份账本是否还会推进。
- **不含模型私有推理**：本表没有那一列，`reasoning_content` 的现行可见性禁令不变（§10.56、
  物理设计对 `run_tool_calls.assistant_message` 的同一条限定）。
- **只读**：调用不触发派发、不重放、不把 `REQUESTED` 推进成任何状态，也不改变恢复入口。
  未结算的行不能读成已执行；`UNKNOWN` 行按原 `operation_id` 单独核对，不因这次读取而被消解。
- 响应形状由 `RunToolCallsSchema` 同一套 `Type.Union([Type.Literal(…)])` 封闭词表表达，
  集成用例逐字段核对 HTTP 体与投影函数返回值（应用层返回 camelCase、schema 只认 snake_case
  时序列化会静默丢字段，只有这种核对能抓到）。

### 10.110 工作区默认写入档位（2026-10-22 实现，迁移 0131）

DEV-0115（2026-10-21 用户指认「未选择目录时这个权限选择不了，我需要什么时候都能选择」）。
**Breaking Change: No**：`workspace_default_directories` 加一列可空 `default_write_tier`
（词表 `READ_ONLY / ASK / AUTO / FULL`，与目录档位同一套，不新造第五种判定），`GET /default-working-directory`
的响应多一个字段，其余端点与判定不变；回滚只需忽略该列，旧行为是「没有默认档位」。

- **`POST /default-write-tier`**：`SetWorkspaceDefaultWriteTier`，请求 `{command_id, expected_revision,
  default_write_tier}`（`null` 表示取消默认档位），200 回执 `{workspace_id, default_write_tier, revision}`。
  与 §10.96 同一条幂等与 CAS 规则：锁 authority、同命令同载荷重放原回执、同命令异载荷 `COMMAND_ID_REUSED`、
  陈旧修订 `409 REVISION_CONFLICT`，**例外**同样是请求值已等于当前值时返回当前事实且不改修订。
  它只写这一列，不建项目、不建连接、不写策略。
- **唯一作用点是新建那一行 `local_directory_access`**：`POST /working-directories/open` 首次为一个资源
  登记管理指针时，若默认档位不是 `READ_ONLY`，就按它写 `write_tier`，并像用户当时显式改档一样建立本目录的
  `FILE_WRITE` 连接与 `WRITE_FILE / APPLY_CHANGESET / READ_CHANGE_SET` 三条策略——只加一列而不落地，
  投影会读成「不可写入」，等于把设置变成假象。已有目录的行**一律不因改默认而重写**。
- **三道跳过闸门，任一命中即按 `READ_ONLY` 起步，但打开目录本身仍然成功**：该根没有可核对的 Windows
  写身份（`file_write_root_id` 为空）、本目录 `FILE_WRITE` 连接已停用、或该根的写策略曾被明确撤销过
  （策略目标历史里有记录）。默认档位不能绕过任何一道既有闸门，也不能把被撤销的规则悄悄补回来。
- **`FULL` 与 `AUTO` 仍只差在目录档位那一列**：两者都落 `AUTO` 策略行，`FULL` 的差别是删除等免确认由
  `local_directory_access.write_tier` 决定（沿用 §10.95 的既有口径）。因此「默认＝完全访问」这句在设置里
  是真的：以后新开的目录确实免删除确认，不是只改显示。
- **界面**：没有目录时权限行仍可选，写的是这条默认档位；芯片只显示档位名（2026-10-22 同日第二轮用户指令去掉「默认 · 」前缀，「说的是以后新开的目录」由悬停说明与行内说明主语承担）并保留
  `data-tier="unbound"`，所以上方状态行同刻仍如实读「未就绪（未绑定目录）」。绑定目录后菜单回到本目录档位，不再读默认投影。
  菜单里给的是三行（请求批准／自动批准／完全访问）——同日第三轮用户指令「删除只读权限」，`READ_ONLY` 这一档不再由本入口提供，
  但命令与词表照旧接受它，服务端返回该档时芯片仍读「只读」；菜单呈现口径归[工作台 §18.1.3](../../frontend/workbench-design/part-05.md#1813-输入器的本目录写入档位2026-10-17)。
- **客户端按现行契约严格解析**：`default_write_tier` 缺键或落在四档之外都显式失败，不补成「没有默认」——
  那会把一次已经做过的设置显示成从未做过。代价是只跑旧服务端（有这条 GET、没有这一列）时整条默认目录
  投影读失败，权限档位回到禁用并给出可行动说明；升级顺序必须是先迁移再换前端。
- **上线动作**：在目标库上跑 `apps/api` 的 `npm run migrate`（迁移 `0131`，只加一列可空＋一个 CHECK）。
  本轮只在一次性临时 PostgreSQL 集群上应用过，未改动任何既有库。

**证据（如实分层）。** 真实临时 PostgreSQL：`workspace-default-write-tier.integration.test.ts` **5/5**
（HTTP CAS/重放/冲突/词表 422/`null` 取消，默认档位与目录未设置可并存；`ASK` 默认→新目录得到 `ASK` 档位＋
`FILE_WRITE` 连接＋三条 `ASK` 策略；`FULL` 默认→档位 `FULL` 而策略行仍 `AUTO`；无默认时与改动前逐字一致且
改默认不重写已有目录；撤销过策略或停用过连接的根重新打开仍不继承，另一个根照旧继承），
连同既有 `workspace-default-directory` 5 例与 `local-directory-access` 8 例共 **18/18**，
日志 `output/dev-0115-api-integration-2.log`。工作台 jsdom：`writePermissionTier.spec.tsx` **26/26** 与
`assistantClient.spec.ts` 默认档位客户端用例。真实 Chromium（API 由 `page.route` 伪造，不落库）：
`tests/browser/defaultWriteTier.spec.ts` **2/2**（含「在途不弹块」时序断言；同日第三轮一度加上的菜单居中几何断言按用户指令回滚后已撤），截图 `output/dev-0115-screenshots/`。
Windows 安装应用与真实 Provider 未验。

### 10.111 消息文件撤回、单层撤销与快照设置（2026-10-24 源码实现，迁移 0132）

用户消息「回退文件」的后端入口。语义、交互与预算边界归[工作台 §27.3](../../frontend/workbench-design/part-08.md#273-用户消息下的文件撤回按钮)，恢复 Owner 归[运行架构 §8.5](../../architecture/runtime-context/part-03.md#85-消息发送前文件基线与恢复-owner)。**Breaking Change: No**：新增四个端点、消息投影两个字段与迁移 0132；既有端点不改变形状，旧消息没有撤回记录时 `withdrawn_at=null`、`recall=null`。

| 端点 | 请求 / 响应 |
|---|---|
| `POST /assist-messages/{message_id}/recall` | `{command_id}`；200 命令信封，`result` 为撤回回执；`outcome.replayed` 表示同一命令或同一消息的既有回执 |
| `GET /assist-messages/{message_id}/recall` | 200 撤回回执；不存在 404 `RESOURCE_NOT_FOUND`；只读，不重试也不推进状态 |
| `POST /assist-message-recalls/{recall_id}/undo` | `{command_id}`；200 命令信封，`result` 为撤销回执；单层，同一撤回至多一次 |
| `GET /assist-message-recalls/{recall_id}/undo` | 200 撤销回执；不存在 404；只读 |
| `GET /message-recall/settings` | 200 `{retention_days, capacity_bytes, per_file_cap_bytes, usage_bytes, snapshot_count, oldest_snapshot_at}`；只读 |

- **撤回范围**：目标用户消息及其后本会话关联、已确认 APPLIED 的文件效果，按路径归并到各自**最早写入前像**；直接会话写（`session_tool_calls` → `logical_operations`）与委派执行（`conversation_execution_requests` → Run → `change_set_files`）都计入。目标消息与其直接助手回复在终态同时写 `withdrawn_at`；原文、工具记录与原回复仍可读取。
- **只允许完成态**：消息须为 USER、`COMPLETED`、未撤回，会话 `ACTIVE`，存在直接助手回复，目标 seq 之后没有非终态消息/未结算工具调用/在途 Run。否则 409 `INVALID_TRANSITION`。方向规则已按 2026-10-24 用户拍板**放开**（§27.3.5）：完成一次撤回后可再撤更早消息，预检把已结算撤回的恢复效果按结算时序折入「当前仍生效状态」重算（`conflict.recallPaths` 仍逐路径给出冲突原因）。
- **前像与预检**：前像在每次写入真正落盘前按消息采集、首写优先；`CREATE` 且此前不存在时可用「不存在」事实作基线。预检对每个路径比较当前态、最近一次已确认写入的期望态与基线态；任一 `CONFLICT`/`UNAVAILABLE`/`UNCERTAIN` 时整组不写，返回 409 `RECALL_PREFLIGHT_BLOCKED`，`conflict.recallPaths` 逐路径给出 `path｜status｜reason`。单文件前像上限 8 MiB（`MAX_MESSAGE_PREIMAGE_BYTES`），超限/读取失败/非普通文件只把该路径标为不可恢复，不改变原写入准入。
- **执行与终态**：首个恢复写入前按路径保存当前字节作为保护副本；保护副本不可用（含工作区快照预算占满）则整次撤回不执行并逐文件标 `SKIPPED`，不写半个回退。恢复经既有 `executeFileChangeset`（`contentBytes` 支持二进制），逐文件状态为 `RESTORED / ALREADY_RESTORED / CONFLICT / UNAVAILABLE / FAILED / SKIPPED`；回执状态为 `RUNNING / COMPLETED / PARTIAL / FAILED`。执行中首个失败后剩余路径标 `SKIPPED`，不继续写。
- **幂等与接续**：同一 `workspace_id + command_id` 重放原回执（`replayed=true`）；同一消息已有撤回时返回该回执；并发 RUNNING 返回 409 `RECALL_IN_PROGRESS`；RUNNING 心跳超过 60 秒（`RECALL_STALE_RUNNING_MS`）可按同一回执认领接续，不新建第二次撤回。过期 RUNNING 也挡新消息，按原回执重发即可续接。
- **单层撤销**：只接受 `COMPLETED` 且仍有保护副本的最近一次成功撤回；范围仅限该次实际 `RESTORED` 的文件。预检按「目标态＝保护副本态 / 期望态＝撤回结果态 / 其余＝冲突」三分，任一冲突或副本缺失即 409 `RECALL_UNDO_PREFLIGHT_BLOCKED` 且不写文件；并发 409 `RECALL_UNDO_IN_PROGRESS`；同一命令/同一撤回重放原回执。撤销是新的受控动作，不复活旧 Run、DONE、批准或 PASS，也不提供对撤销的再撤销。
- **快照设置**：`retention_days` 与 `capacity_bytes` 读取进程环境 `RELAY_MESSAGE_SNAPSHOT_RETENTION_DAYS` / `RELAY_MESSAGE_SNAPSHOT_BUDGET_BYTES`（默认 30 天 / 5 GiB）；`per_file_cap_bytes` 为 8 MiB；`usage_bytes` 统计该工作区前像＋保护副本的实际字节，`oldest_snapshot_at` 是可恢复时段的当前最旧快照。撤回/撤销入口会先触发**全局**过期清理（超过保留期且不被在途撤回/撤销引用）；容量占满时停止新增快照并如实降级，不删既有快照腾空间。数值仍是推荐默认，未经真实 Windows 项目测量校准。
- **基线语义（2026-10-24 用户拍板后已返工）**：恢复目标读**发送前基线**——目标用户消息在准入事务内对受管根建立的字节基线（`assist_message_baselines`，条目在 `assist_message_baseline_files`，字节在内容寻址库 `assist_message_snapshot_blobs`，同内容跨消息去重）；COMPLETE 基线下无条目＝发送前不存在，INCOMPLETE（采集超限/预算占满/存储失败）下缺条目按 `BASELINE_UNKNOWN`/不可恢复如实处理。发送后、首写前的外部修改不再被当作发送前状态（RA-10 判定性场景通过）。前像表已移除。另：一次撤回只接受单一受管根（跨根 409 `RECALL_MULTIPLE_ROOTS`，会话根不可用/变化分别为 `RECALL_ROOT_UNAVAILABLE` / `RECALL_ROOT_CHANGED`）；目标 seq 之前已写入、之后未再次写入的路径不在本次范围；受影响 DONE 任务重开（BC-16）服务侧已接线（撤回结算后按「实际恢复路径 ∩ 委派写入」判定、仅 DONE 沿既有 `reopenTask` 入口进新验收周期、失败逐项写 `detail.task_reopens`），e2e 因委派执行链的存量回归（#140 计量包裹，`conversation-diff-attribution` 同红）暂以带因 skip 跟踪；工作台撤销按钮尚未接线。
- **消息投影**：会话消息 DTO 增加 `withdrawn_at`（ISO 或 null）与 `recall` 摘要（`id/message_id/assistant_message_id/status/planned_files/restored_files/skipped_files/completed_at`，无撤回为 null）。原文和附件仍返回，客户端按 `withdrawn_at` 显示撤回占位。
- **模型上下文**：撤回终态后，下一轮输入把被撤回的用户/助手消息替换为成对占位，并追加撤回回执事实行（实际恢复结果、未决项）；旧回复与旧摘要只作为历史来源，不再作为当前文件事实。恢复期间新消息被原命令入口的同一道闸拒绝（返回 409 `RECALL_IN_PROGRESS`）。

**错误码汇总**：`RECALL_PREFLIGHT_BLOCKED`、`RECALL_EFFECT_UNCERTAIN`（存在 UNKNOWN 工具调用/变更集）、`RECALL_IN_PROGRESS`、`RECALL_MULTIPLE_ROOTS`、`RECALL_ROOT_UNAVAILABLE`、`RECALL_ROOT_CHANGED`、`RECALL_UNDO_PREFLIGHT_BLOCKED`、`RECALL_UNDO_IN_PROGRESS`、`COMMAND_ID_REUSED`、`INVALID_TRANSITION`。除重放外均不改变文件；响应沿用统一 problem 形状。


### 10.112 人工受管目录浏览与文件读取（2026-10-24 源码实现，迁移 0134）

右侧工具面板「文件」页签的后端入口。机制与边界归[工具适配器 2026-10-24 段](../../architecture/tool-adapters.md)，物理设计归[数据库 §112](../../database/physical-design-postgresql/part-05.md#113-0134-人工受管目录浏览与文件读取2026-10-24)。**Breaking Change: No**：新增一个端点与迁移 0134（只放宽一条 CHECK），既有端点与表结构不变。

| 端点 | 请求 / 响应 |
|---|---|
| `POST /projects/{project_id}/managed-resources/{resource_id}/file-read` | `{command_id, connection_id, action_type: LIST_DIRECTORY \| READ_FILE, path?, limit?}`；200 命令信封，`result` 为读取结果；同命令重放附 `Command-Replayed: true` |

- **动作词表**：`LIST_DIRECTORY`（`FILE_QUERY` 能力，浏览查询目录一层条目，受保护路径与构建产物目录跳过并计入 `skipped`）与 `READ_FILE`（`FILE_READ` 能力，读取一个既有普通文件全文，≤128 KiB，二进制/超大返回类型化失败）。`FIND_PATHS`/`SEARCH_TEXT`/写动作不接受（409 `GATEWAY_ORIGIN_DENIED`）。
- **路径语义**：`path` 是受管根内相对路径，不接受绝对路径与 `..`（422 `VALIDATION_FAILED`）；`LIST_DIRECTORY` 缺省＝受管根本身；`READ_FILE` 必填且不接受 `limit`。根内存在性、真实目录/普通文件、链接逃逸与受保护路径由 prepare 归一裁决（409 `GATEWAY_TARGET_DENIED`）。
- **权限**：复用 Gateway 准入——连接须具备对应能力且 `root_path` 匹配受管根（否则 409 `GATEWAY_CONNECTION_DENIED`）；策略 AUTO 直通、ASK 创建绑定确切参数的 `ACTION_APPROVAL`（等待形态不携带任何结果字段）、DENY/缺策略 409 `GATEWAY_PERMISSION_DENIED`；在途写入占用目录时 409 `RESOURCE_OCCUPIED`（可重试）。
- **幂等与刷新语义（与 §10.103 Git 人工读取的分界）**：同一 `command_id` 重放原回执；确定性 Operation ID 纳入 `command_id`——同命令崩溃重投收敛到同一次读取（适配器不二次执行），**新命令产生新的读取事实**，目录列表因此可刷新。`LIST_DIRECTORY` 的 `limit`（1..200，默认 200）在适配器内生效并进冻结参数；`truncated` 显式透出，截断列表不冒充完整证据。
- **结果三形态**：目录投影 `{directory, entries[{path,kind,size}], count, limit, truncated, skipped, target, action_type, invocation_id, operation_id}`；文件投影 `{target, size, sha256, truncated, content, invocation_id, operation_id}`；失败投影 `{reason, detail?}`（`FILE_BINARY_UNSUPPORTED`/`FILE_TOO_LARGE`/`FILE_QUERY_RESULT_MISSING` 等类型化，空条目列表绝不冒充失败）。人工审计事件 `MANAGED_FILE_READ_REQUESTED` 与动作同事务落账。

前端接线未做（入口与交互以[开发提示词](../../../prompts/devtools-file-browse-frontend.md)交付）；错误码沿用统一 problem 形状，响应不泄漏 SQL 或堆栈。

### 10.113 项目级长期 Agent 成员（2026-10-25 源码实现，迁移 0139）

ADR-034 包 A。成员是项目内跨会话的稳定身份与配置，不拥有 Task/Run/验收，也不给只读助手加写权限；执行权、私聊/群聊与事件唤醒由后续包接续。

| 方法 | 路径（前缀 `/api/v1/workspaces/{workspace_id}`） | 命令 | 成功 | 请求体 | 回执 `result` |
|---|---|---|---|---|---|
| POST | `/projects/{project_id}/agent-members` | `CreateAgentMember` | `201` | `{command_id, name, role_key, duties?, run_mode, model_selection?, external_binding?}` | `{agent_member_id, project_id, name, role_key, duties, status, run_mode, model_selection, external_binding, is_coordinator, revision}` |
| POST | `/agent-members/{id}/edits` | `EditAgentMember` | `200` | 同上（`duties` 必填）＋`{expected_revision, reason}`，`model_selection?` 缺省＝保持不变 | 同上 |
| POST | `/agent-members/{id}/status-changes` | `SetAgentMemberStatus` | `200` | `{command_id, expected_revision, status, reason}` | 同上 |
| POST | `/projects/{project_id}/coordinator-assignments` | `AssignProjectCoordinator` | `200` | `{command_id, member_id, reason, expected_coordinator_revision?}` | `{project_id, agent_member_id, member_revision, revision}` |

只读：`GET /projects/{project_id}/agent-members`（含 `coordinator_member_id` / `coordinator_revision`）、`GET /agent-members/{id}`（含项目投影与 `is_coordinator`）、`GET /agent-role-templates`（五个角色模板目录）。

**按需创建，模板不是成员。** `role_key ∈ {COORDINATION, PRODUCT, DESIGN, DEVELOPMENT, TEST_REVIEW}`；不传 `duties` 时把模板默认职责拷贝进成员（之后模板演进不改写既有成员）。同一项目允许多个相同职责成员；`UNIQUE (project_id, name)` 撞名返回 `422`。不自动建齐团队，也没有任何自动创建入口。

**生命周期。** `ACTIVE → INACTIVE ⇄ ACTIVE`、`ACTIVE/INACTIVE → ARCHIVED`；`ARCHIVED` 是留档终态：拒绝编辑与复活，但记录与读取保留。编辑走 `expected_revision` CAS；停用不删除任何事实——后续包（消息、执行权）一律以「成员必须 ACTIVE」为闸门，迟到回执不能复活失效身份。

**协调者是项目级单行事实。** `project_agent_coordinators` 一项目一行（PK），指派/更换都写这一行：首次指派不带 `expected_coordinator_revision`，更换必须带当前修订（防并发互换覆盖）；重复指派同一成员 `409`；只有 `ACTIVE` 成员可担任；停用协调者不自动转移，指派行保留、读方如实呈现「协调者已停用」。

**模型选择与会话同口径。** `model_selection` 为 `{mode:'INHERIT'}`（默认，执行时按当时默认解析，配置时不校验）或 `{mode:'EXPLICIT', model}`——EXPLICIT 在配置时按会话模型选择同一解析：目录外/收费型号类型化拒绝（`400 MODEL_NOT_REGISTERED` / `409 MODEL_PAID_NOT_AVAILABLE`），绝不静默换型号；解析成功保存 `{model, connection, free_only, config_fingerprint}`。换模型不换身份、不加权限。

**运行方式与外部绑定。** `run_mode ∈ {BUILTIN, EXTERNAL}`。`external_binding.principal_label` 目前只是展示性标签，**不构成授权**：外部身份的可信绑定随 ADR-033 领取协议落地（包 C），届时再扩列。

**幂等与隔离。** 四个命令都是 `command_id` 幂等（作用域 Workspace）；跨 Workspace/跨项目读写一律 `404`；归档项目拒绝成员写命令。审计事件 `AGENT_MEMBER_CREATED / EDITED / STATUS_CHANGED / PROJECT_COORDINATOR_ASSIGNED`。

### 10.114 成员私聊、群聊与消息（2026-10-25 源码实现，迁移 0140）

ADR-034 包 B 的服务端记录面：消息只是协作记录，投递不等于任务领取，群聊文字不能写 DONE/PASS 或绕过权限。成员回信与互相唤醒（模型调用、消费结算）随包 C 接入，本节不宣称协作闭环。

| 方法 | 路径（前缀 `/api/v1/workspaces/{workspace_id}`） | 命令 | 成功 | 请求体 | 回执 `result` |
|---|---|---|---|---|---|
| POST | `/projects/{project_id}/member-conversations` | `OpenProjectMemberConversation` | `200` | `{command_id, kind:'DIRECT'\|'GROUP', member_id?}` | `{conversation_id, project_id, kind, member_id, title, status, close_reason, revision}` |
| POST | `/member-conversations/{id}/messages` | `SendProjectMemberMessage` | `200` | `{command_id, content, intent, recipient_member_ids?, handoff?, linked_task_id?, linked_run_id?}` | `{message_id, conversation_id, seq, sender_kind, sender_member_id, recipient_member_ids, intent, content, handoff_payload, linked_task_id, linked_run_id, processing_status}` |
| POST | `/member-conversations/{id}/status-changes` | `SetProjectMemberConversationStatus` | `200` | `{command_id, expected_revision, status:'OPEN'\|'CLOSED', close_reason?, note}` | 同开启会话 |

只读：`GET /projects/{project_id}/member-conversations`（含成员投影）、`GET /member-conversations/{id}`、`GET /member-conversations/{id}/messages?after_seq=&limit=`（按 seq 游标）。

**私聊一线程、群聊一线程。** 部分唯一索引裁决：`(project_id, member_id) WHERE kind='DIRECT'` 与 `(project_id) WHERE kind='GROUP'`。「开启或继续」语义：已存在时返回既有会话，不新建（同一命令重放也返回同一会话）。

**定向接收者是持久事实。** 私聊接收者恒为对方成员；群聊消息带 `recipient_member_ids` 时只记录这些成员（须为本项目 `ACTIVE` 成员，否则 404/409），**空集＝未定向**——按产品规则由协调者接住、按需邀请，唤醒侧（包 C）据此只唤醒谁，绝不默认广播全员。

**意图与交接。** `intent ∈ {DISCUSS, QUESTION, SUGGESTION, STATUS_REPORT, CHECK_REQUEST, HANDOFF}`。`HANDOFF` 必带受控载荷 `{baseline_note?, open_questions[], next_actions[], artifact_version_id?}`（键词表封闭、至少一项）且只引用原事实（`linked_task_id` / `linked_run_id` 是外键引用，不复制业务状态）；其他意图不得携带交接载荷。交接摘要不能代替原始业务事实。

**幂等与去重靠回执。** 三个命令都是 `command_id` 幂等（作用域 Workspace）；同一消息命令重复投递重放原回执、不落新行——不依赖前端本地状态去重。seq 按会话递增且 `UNIQUE (conversation_id, seq)`。

**讨论终止是会话级状态。** `CLOSED` 需要原因码（`RESOLVED / INSUFFICIENT_INFO / NO_NEW_EVIDENCE / NEEDS_USER_DECISION / TECHNICAL_BOUNDARY / NO_PROGRESS`）；关闭后拒发消息；`OPEN` 可重开（清原因、revision CAS）。关闭不是删除：记录与消息全部保留。多个 Agent 仅凭互相回复不能无限唤醒——无新证据的讨论由协调者或用户按原因码收口（执行侧边界归包 C）。

**闸门与隔离。** 开私聊要求成员 `ACTIVE`；发送时再次核对（停用后拒发、拒开新私聊，历史仍可读）；项目归档拒绝开会话与发消息；跨 Workspace 读写一律 `404`。消息不给成员任何额外权限：不产生执行权、不代答验收、不自动改写确认事实。审计事件 `MEMBER_MESSAGE_SENT` / `MEMBER_CONVERSATION_STATUS_CHANGED`。
