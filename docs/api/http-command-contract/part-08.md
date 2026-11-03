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

### 10.115 一键启用内置插件（2026-10-25 源码实现）

**Breaking Change: No。** 新增一个命令端点；两处既有校验放宽（见下），不改变任何既有端点的请求/响应形状。

背景是两处事实缺口：`POST /projects/{id}/connections` 的能力白名单不含 `COMPUTER_*`/`BROWSER_*`/`GITHUB_READ`，高级表单选了插件能力提交即 422——插件连接此前**没有任何可用登记入口**；浏览器策略经 `policyScope` 落成目录前缀，与准入端 `browser://<origin>` 目标永远匹配不上（死策略）。本节同时补上入口与缺口。

| 方法 | 路径（前缀 `/api/v1/workspaces/{workspace_id}`） | 命令 | 成功 | 请求体 | 回执 `result` |
|---|---|---|---|---|---|
| POST | `/projects/{project_id}/plugins/{plugin_key}/enable` | `EnableProjectPlugin` | `201` | `{command_id}` | `{project_id, plugin, created_connections, created_policies, blocked_disabled_connections, blocked_revoked_policies, skipped_no_resource}`（计数全为字符串） |

- **`plugin_key ∈ {computer, browser, github}`**，未知值 422。`command_id` 幂等（作用域 Workspace）；重复执行（新 command_id）只补缺口，不产生第二套事实。
- **一次命令一个短事务**：连接（缺的能力挂到一条新连接，插件能力不绑定目录/主机）＋每个 `(能力, 动作, 目标)` 一条策略。目标与准入同一语义：电脑 `computer://desktop`，浏览器 `browser://`（全部站点），GitHub 只读按项目内每个 `ACTIVE` 受管根逐目录授权（没有时 `skipped_no_resource` 计数、连接仍登记）。
- **决定分族**：只读族（`COMPUTER_READ`/`BROWSER_READ`/`GITHUB_READ` 全部动作）直接 `AUTO`，与「打开目录即得 Git 只读」同一原则；操作族（`COMPUTER_INPUT`、`BROWSER_ACTION`、`BROWSER_COMMIT`）一律 `ASK`——即便用户事后改成 `AUTO`，非穿透适配器也在准入时降级 `ASK`（无「始终允许」）。`max_payload_bytes` 取契约上限 262144。
- **不绕过既有撤销**：能力只有 `DISABLED` 连接时只计数 `blocked_disabled_connections`，不新建第二条；策略目标此前在历史版本出现过的动作只计数 `blocked_revoked_policies`，不自动恢复。显式 `DENY` 的 ACTIVE 策略视作已存在，不覆盖。
- **既有端点放宽（同日）**：`POST /connections` 与 permission-policies 端点的 `capability` 联合补入 `COMPUTER_READ`/`COMPUTER_INPUT`/`GITHUB_READ`/`BROWSER_READ`/`BROWSER_ACTION`/`BROWSER_COMMIT`；permission-policies 对浏览器能力新增可选 `host`（`host[:port]`，缺省 `browser://` 即全部站点）并**拒绝** `resource_id`（浏览器策略没有受管根）。
- 无新增 migration；审计走既有 authority 版本（写事实时 bump）。验证：`enable-project-plugin.integration.test.ts`（真实 PG + 真实 HTTP）覆盖计数、幂等重放、停用/撤销阻断、无资源跳过、能力白名单与 422。

### 10.116 模型连接登记（2026-10-27 源码实现，P2 阶段一）

**Breaking Change: No。** 新增迁移 `0143_model_connections`（一张工作区作用域表）与五个端点，均沿用 `/api/v1/workspaces/{workspace_id}` 前缀与 Bearer/Workspace 边界；既有端点、表与状态机未改变。

| 端点 | 语义 |
|---|---|
| `GET /model-connections` | 列出本工作区已登记连接（按创建时间） |
| `GET /model-connections/{connection_id}` | 读取单条；跨工作区 404 |
| `GET /model-connections/{connection_id}/credential` | 凭据是否还在系统凭据库里，**只回布尔** |
| `POST /model-connections` | `CreateModelConnection`，201 |
| `PATCH /model-connections/{connection_id}` | `UpdateModelConnection`，revision CAS |
| `POST /model-connections/{connection_id}/credential` | `RotateModelConnectionCredential` |
| `POST /model-connections/{connection_id}/status` | `SetModelConnectionStatus`（`ACTIVE`/`DISABLED`） |

- **凭据永不入库**：请求体的 `api_key` 只出现一次，服务端落进操作系统凭据库（Windows DPAPI，当前用户作用域），业务表只保留不透明引用 `credential_ref`。响应、列表、错误详情、命令回执都**不含**密钥、密文、摘要或引用；`command_id` 的载荷摘要也不含 `api_key`。
- **轮换覆盖同一引用**：`credential_version + 1`、`revision + 1` 与秘密覆盖在同一次调用完成。代数变化是「凭据已换」的权威信号（冻结在旧代上的调用据此停止），而不是靠「文件不存在」这种含糊信号；不换引用就没有孤儿 blob 要清理。
- **CAS 不用最后写入覆盖**：所有更新带 `expected_revision`，不符即 409 `REVISION_CONFLICT`（`retry_action=REFRESH_AND_REDECIDE`）。`revision` 以字符串传输（bigint 不走 JSON number）。
- **停用是状态不是删除**：没有 DELETE 端点、也没有 DELETE 权限。已冻结在旧连接上的历史需要原身份继续可读、可诊断。
- **预算与进程配置同名同义**：`timeout_ms` / `max_output_tokens` / `max_call_tokens` / `max_scope_calls` / `max_scope_tokens`，上下界与 `ModelPortConfig` 一致，且要求「单次上限 ≥ 单次输出上限」「作用域上限 ≥ 单次上限」——能在 API 通过的值不会被执行端以「配置非法」拒绝。跨列约束按**合并后的整行**判断（只改一档也要与另两档自洽）。
- **错误码**：422 `MODEL_CONNECTION_INVALID`（逐字段 `errors`）、409 `MODEL_CONNECTION_NAME_TAKEN`、409 `REVISION_CONFLICT`、404 `RESOURCE_NOT_FOUND`、503 `MODEL_CREDENTIAL_STORE_UNAVAILABLE`（凭据库读写失败；连接未创建、未修改，`retry_action=CHECK_RECEIPT_THEN_RETRY`）。
- **阶段边界（必须如实理解）**：这些连接**尚不能用于执行**。执行端仍只按 Run 冻结计划或进程默认解析模型；「连接 → 会话选择 / Run 冻结」的接线是下一阶段，需要新的冻结列而不是改本表。本端点集合不声称任何连接「已验证」或「可执行」。
- 验证：`model-connections.integration.test.ts`（真实 PG + 真实 HTTP + 真实 DPAPI）7 项——创建后响应/列表不含密钥与引用、重复名称 409 且不留孤儿凭据、CAS 冲突与生效、轮换后库里秘密确实被替换且无孤儿 blob、停用/启用、`command_id` 重放返回原结果、跨工作区 404。

### 10.117 工作区默认模型连接与 Run 的连接身份（2026-10-27 源码实现，P2 阶段三）

**Breaking Change: No。** 迁移 `0144_workspace_default_model_connection` 新增一张表与两个可空契约列；新增两个端点。旧契约两列为 NULL，走既有兼容路径。

| 端点 | 语义 |
|---|---|
| `GET /model-connections/default` | 当前默认连接；未设置时 `connection_id=null`、`revision=null` |
| `PUT /model-connections/default` | `SetDefaultModelConnection`，幂等（指向同一条时不推进 revision） |

- **作用域**：默认连接只决定**新的 Run** 从哪条连接冻结模型身份。会话聊天仍按会话选择或进程默认——两者作用域不同，互不改写。不设默认时新 Run 走进程默认，并显式标注 `basis=LEGACY_ENV`。
- **冻结即锁定**：`execution_contracts.connection_id` + `connection_credential_version` 与快照同事务写入。执行端只按这两列解析，**不重新读「当前默认连接」**——否则改默认会让在途 Run 换 Provider。
- **执行端四道闸门**（任一不符即停，零外呼、零账本）：连接在本工作区可见 → 仍为 `ACTIVE` → 凭据代数等于冻结值 → 由连接行重算的配置指纹等于冻结值。随后才解析秘密。停止原因是类型化的：`MODEL_CONNECTION_UNAVAILABLE`、`MODEL_CONNECTION_DISABLED`、`MODEL_CREDENTIAL_CHANGED`（代数不符）、`MODEL_CONFIG_CHANGED`（端点/预算被改）、`MODEL_CONNECTION_CREDENTIAL_MISSING`（库里没有秘密）。
- **委派期同样不回落**：默认连接被停用或凭据缺失时，`DelegateTask` 直接失败（409 `MODEL_CONNECTION_DISABLED` / `MODEL_CONNECTION_CREDENTIAL_MISSING` / `MODEL_CONNECTION_UNAVAILABLE`），**不**退回进程默认——默认连接是用户的显式选择，退回等于偷偷换模型。
- 验证：`run-model-connection.integration.test.ts`（真实 PG + 受控 Provider 接缝）4 项——默认连接决定冻结与外呼身份（进程默认是另一个模型也不影响，账本 model 一致）、停用后委派失败、轮换后在途 Run 停止且零外呼、改设另一条为默认后已创建 Run 仍用原连接。

### 10.118 会话运行态只读投影（2026-10-28 源码实现）

**Breaking Change: No。** 没有新命令、没有新端点、没有迁移：只给既有会话投影加一个只读字段 `run_state`。

| 端点 | 变化 | 说明 |
|---|---|---|
| `GET /assist-sessions` | 投影新增只读字段 `run_state` | 一次列表读取里逐行派生，取值为 `'RUNNING'`／`'PENDING'`／`null` |
| `GET /assist-sessions/{session_id}` | 同上，**同一口径** | 左栏切会话后按身份重读那一行，两处不一致就会出现「切走亮、切回灭」 |
| `POST .../title`、`/pin`、`/unread`、`/archive`、`/reopen`、`/fork`、`DELETE` | 无 | 回执字段一律不变，不带 `run_state` |

**语义与派生 SQL。** `run_state` 是**读时派生**事实，不是 `assist_sessions` 的列，与 `has_messages`（§10.91）同一读法：直接看 `assist_messages` 里这条会话有没有在途行，`RUNNING` 压过 `PENDING`。

```sql
case
  when exists (select 1 from assist_messages m
    where m.session_id = s.id and m.status = 'RUNNING') then 'RUNNING'
  when exists (select 1 from assist_messages m
    where m.session_id = s.id and m.status = 'PENDING') then 'PENDING'
  else null
end as run_state
```

- `RUNNING` = 已有 Worker 认领（`worker_id`／租约已写）正在生成；`PENDING` = 回复行已随发送命令同事务落库、还没被认领（排队）。两者都由发送命令预插的 ASSISTANT 行推进，不经过任何界面本地状态。
- **没有在途行就是 `null`**，不另立 `'IDLE'`：终态（`COMPLETED`／`FAILED`／`CANCELLED`）与「一条消息都没有」在这一点上是同一件事——「此刻没有在途的一轮」。造一个 `IDLE` 词会让客户端以为服务端在陈述一种需要跟进的业务状态。
- **不比 `created_at`／`updated_at`、不看 `worker_id`、不看租约与心跳时刻**：那些是执行侧恢复判据（见[数据库 §100](../../database/physical-design-postgresql/part-05.md#100-0111-会话活动排序键2026-10-18-源码实现)的兄弟口径），界面不需要据此猜「大概还在跑」。消息行还在 `PENDING` 而 Worker 已崩溃时，投影如实说 `PENDING`——那是库里的事实，不是界面的推测。
- 成本：列表是一句 SQL 里的两个相关子查询（`assist_messages(session_id)` 上有索引），行数多少都只有这一条语句；单条读取单独派生一次。**不改变排序键、`revision` 与 `updated_at`**，只读投影不写任何东西。

**客户端读法（工作台 §28.1）。** 左栏只在**有任何一条会话处于运行态**期间按 3s 重读一次本列表（同一请求覆盖整列，不对每个条目单独发请求），连续 40 拍后降到 10s，读失败 3→6→12→24→30s 退避；没有在跑时零请求，页面不可见时不发请求。轮询读失败**保留**上一次读到的运行态：既不清成静止（那等于伪造完成），也不假装在跑。

**兼容。** 旧客户端读不到新字段不受影响；新客户端读旧服务端时字段缺失按 `null`（不猜），读到词表之外的值则整条解析失败——猜一个运行态会让界面画出不存在的生成过程。

**验证。** 真实 PG/HTTP：`test/integration/assist-run-state.integration.test.ts` 6/6（无消息与只有终态读成 `null`、`PENDING`→`RUNNING`→结算回 `null`、`FAILED`/`CANCELLED` 不留在 `RUNNING`、`RUNNING` 压过 `PENDING`、同一列表内逐行不串、只读不推进修订与活动键）。

### 10.119 项目必读文件体积审计（2026-10-30 源码实现，只读投影）

输入器「必读文件预警」的后端读数（交互归[工作台 §54](../../frontend/workbench-design/part-15.md#54-必读文件体积预警发送前的上下文风险2026-10-30已实施实机未验)）。**Breaking Change: No**：只新增一个 GET，不改任何既有端点、表结构或命令回执。

| 方法 | 路径（前缀 `/api/v1/workspaces/{workspace_id}`） | 查询 | 成功 |
|---|---|---|---|
| `GET` | `/working-directories/{resource_id}/required-context-audit` | `agent?`（`relay`\|`codex`\|`claude`\|`codebuddy`\|`gemini`\|`cursor`\|`copilot`\|`windsurf`，缺省 `relay`）、`model?`（目录模型 id）、`session_id?`（会话档位来源）、`refresh?`（`1` = 跳过目录遍历缓存） | 200 审计投影 |

- **只读、无回执**：不写业务事实、不产生 `command_id`、重放无副作用（与 §10.96 工作区默认目录、`/runs/{id}/context-manifests` 同一类读路径）。
- **必读范围靠枚举，不靠猜测**：只认各 Agent 的官方规则入口（`AGENTS.md`／`CLAUDE.md`／`CODEBUDDY.md`／`GEMINI.md`／`.cursorrules` + `.cursor/rules/*.mdc`／`.github/copilot-instructions.md`／`.windsurfrules`，同名文件在子目录继续生效）与项目显式声明 `.relay/context-required.json`（`required_documents[{path, category: AUTO_INJECTED|TASK_REQUIRED, reason?}]`，≤64 KiB）。项目里其余 Markdown **一律不**计入，也不报成「自动加载」。
- **扫描口径**：只 `stat` 不读正文，因此不调模型、不把文件放进上下文；符号链接/Junction 先解析真实路径再判是否仍在受管根内，越界、无权限、回路、非普通文件一律记进 `skipped` 并给原因（安全失败，不抛错）。
- **权限**：调用前要求存在覆盖该 `canonical_root` 的 ACTIVE `FILE_READ` 连接（与 `resolveSessionReadTools()` 同一判据）。不满足时 `state="NO_FILE_ACCESS"`、`files=[]`，不扫也不读。跨工作区的 `resource_id` 按不可见处理（`SCAN_UNAVAILABLE`）。
- **预算口径**：`effective_input_tokens = min(provider_window_tokens, call_budget_tokens) − reserves`，其中 `call_budget_tokens` 按**执行链同一优先级**取：0145 会话档位 → 工作区默认档位 → 应用配置的 `RELAY_MODEL_MAX_CALL_TOKENS`（有会话却不传 `session_id` 会按工作区默认报偏，因此聊天入口必须传）；`reserves = output_tokens + system_prompt_tokens + tool_definition_tokens + history_tokens`（输出取 `RELAY_MODEL_MAX_OUTPUT_TOKENS`，系统提示按 `RELAY_AGENT_CORE_PROMPT` 字节数 ÷ 3 实算，工具定义取集中阈值中的保守常数，历史按 0——首次发送前历史尚未进入本次调用，实测占用只由界面圆环表达）。`provider_window_tokens` 只来自模型目录的 `context_window`，**未知必须是 `null`**，不假定 256K／512K／无限。
- **档位**：单个文件占比 ≥15% / ≥30% / ≥50% 分别为 `NOTICE` / `HIGH` / `SEVERE`；累计占比 ≥30% / ≥50% / ≥75% 同理；预计总输入超过 `min(窗口, 档位)` 一律 `SEVERE`。阈值随响应下发（`thresholds`），客户端不复制一份判定。分母不可算时 `share`/`required_total_share` 为 `null` 且档位回到 `NONE`，并给出 `BUDGET_UNAVAILABLE` 原因，不给假百分比。
- **响应字段**：`state`（`OK`/`NO_FILE_ACCESS`/`SCAN_UNAVAILABLE`）、`detail`、`agent{id,label}`、`root`、`scanned_at`、`fingerprint`（目录 + Agent + 逐文件 `path:bytes:modified_at` 的摘要，客户端用它判定「本次忽略」是否过期）、`severity`、`files[{path,category,scope,reason,bytes,estimated_tokens,modified_at,share,severity}]`（按体积降序）、`budget{...}`、`reasons[{code,text,ratio,path}]`、`suggestions[{code,text}]`、`skipped[{path,reason}]`、`access{project_id,connection_id}|null`（「查看文件」复用同一读取入口）、`thresholds`。
- **缓存与失效**：只缓存「目录遍历 + 声明解析」（30 秒 TTL，键含根与 Agent）；每个候选文件的体积与修改时间**每次都重新 `stat`**，所以文件被改、被删或被替换后下一次审计立刻是新读数；`refresh=1` 跳过遍历缓存。
- **与 §10.112 的关系**：「查看文件」不新增读取通道，直接用审计返回的 `access.connection_id` 调 `/projects/{project_id}/managed-resources/{resource_id}/file-read`（`READ_FILE`），因此仍走同一套 Gateway 准入、审批与回执语义。

**验证。** 单测 `test/unit/required-context-files.test.ts` 14/14（阈值、`min(窗口, 档位)`、窗口未知、预留占满、累计口径、非必读不误报、换 Agent 换清单、声明文件、改/删后读数更新、越界与链接逃逸）；真实 PG/HTTP：`test/integration/required-context-audit.integration.test.ts` 7/7（DTO 投影完整、窗口未知、无连接不扫不读、跨工作区不可见、改/删后更新、声明与越界、换 Agent）。

### 10.121 会话内临时 Agent 协作（2026-10-30）

专用子任务补充接口见本分册 §10.127；普通 `RequestAssistMessage` 的子会话生成限制保持，不再要求所有补充都回主会话输入。

- `GET /workspaces/{workspace_id}/assist-sessions/{id}/delegations`：返回 `{items:[...]}`，最多最近 50 条。每项为 `delegation_id`、可空 `child_session_id`、`role`（INVESTIGATE / REVIEW）、`objective`、`scope:string[]`、可空 `baseline`、`required`、`status`（QUEUED / RUNNING / SUCCEEDED / FAILED / CANCELLED）、`attempt_count`、`max_attempts`、可空 `result_summary`、`created_at` 和可空 `closed_at`。只读，不生成任务或模型调用；跨工作区或会话不存在返回 404，不暴露正文。
- 会话列表和详情新增可空 `parent_session_id`，只表达临时委派来源，区别于分叉的 `forked_from_session_id`。
- 子会话是冻结委派记录，普通 `RequestAssistMessage` 返回 409 / INVALID_TRANSITION，提示回主会话补充，不得将子历史当作可写主会话。
- Breaking Change：普通根会话 No（新增只读接口及响应字段）；对子会话普通发送 Yes（此前未约束的路径被拒绝）。旧客户端读取新字段可忽略，更新客户端缺字段按 null 兼容；旧子会话仍可读取历史。无新增 migration，复用 0128。
- 委派子调用与主调用共用根会话模型账本；子调用在同一原子预算准入内为主汇总预留一次调用及一次调用 token 预留。角色不授予权限，子结果不构成正式完成或验收。

### 10.127 子任务补充与主会话来源同步（2026-10-30，迁移 0148）

- `POST /workspaces/{workspace_id}/assist-sessions/{id}/supplements`，严格请求体 `{command_id, content}`，content 1–32768 字符且不能只含空白；只接受临时委派的子会话。返回 200 命令回执，result 包含 `supplement_id`、`source_message_id`、`child_session_id`、`parent_session_id`、`delegation_id`。原身份同载荷重放返回原回执；异载荷 409 / COMMAND_ID_REUSED。创建来源与回执在同一短事务内完成，响应丢失先查原回执，不换 command_id。
- `GET /workspaces/{workspace_id}/assist-sessions/{id}/supplements`，主、子会话均可查询，返回最近最多 50 条 `{items:[...]}`；项包含 `id`、`delegation_id`、`source_message_id`、`source_session_id`、`parent_session_id`、`content`、`delegation_status`、可空 `parent_seen_at` / `child_seen_at`、`created_at`。这些是持久来源和分别读取的事实，不是验收结果。
- 不存在或跨 Workspace 为 404；向根会话发送补充、归档会话或归档项目拒绝为 409；非法字段/正文 422。已结束的委派可保存补充，但不增加尝试、不创建新的 ASSISTANT、Task/Run 或模型调用。运行中仅在原轮次的下一模型请求安全点读取，仍受原只读能力和预算约束。
- Breaking Change：No。新增专用端点与附加表，旧客户端可继续回主会话补充；普通子会话生成仍拒绝。存储和受控回滚风险见[物理设计 0148](../../database/physical-design-postgresql/part-05.md#0148-子任务补充来源与读取确认2026-10-30)。

### 10.120 会话级上下文档位与上下文用量投影（2026-10-30 源码实现，迁移 0145）

Breaking Change: **Yes（语义）**——上下文档位从「工作区默认」改为**会话自己的一行事实**。
`/context-budget`（§10.99 沿用的工作区写入口）仍然存在且仍被设置页与 Run/委派等无会话消费者使用，
但输入器圆环的浮层不再写它：同一条命令 `SetSessionContextBudget` 只改那一条会话。

**档位（`POST /assist-sessions/{id}/context-budget`）**

- 请求 `{command_id, expected_revision, context_budget_tokens}`，`context_budget_tokens` 只能是
  `262144` / `524288` / `1048576`（路由 schema 与用例层各判一次）；未列出的值 422，不静默取整。
- 200 回执 `{session_id, context_budget_tokens, revision}`；`revision` 是**该会话的档位修订**
  （`assist_sessions.context_budget_revision`），与 `assist_sessions.revision` 分开：后者被改名、
  置顶、归档、切模式共用，拿它做档位 CAS 会让一次无关的重命名把保存打成 409。
- 幂等：同一 `command_id` 重放返回同一份回执；换档位按异载荷拒绝。陈旧 `expected_revision` → 409
  `REVISION_CONFLICT`（`entityType=ASSIST_SESSION_CONTEXT_BUDGET`），不覆盖并发写入的一方。
- 不推进会话 `revision`、不改状态、不授予任何权限；**不追改在途调用**——那次调用用它启动时
  冻结的预算（既有冻结语义）。
- 回执资源路径 `assist-sessions/{id}/context-budget`，GET 回执与首次响应一致。

**继承（`POST /assist-sessions` 新增可选 `source_session_id` 与 `context_budget_tokens`）**

- 新会话的档位在建会话事务里写一次，优先级从高到低：
  1. `context_budget_tokens`——调用方显式指定的档位（同样只接受三个合法值，非法值 422）。
     它进命令体参与载荷 hash，因此「创建响应丢失后按原命令重试」写进去的仍是同一档，
     第一个模型调用就按它冻结预算。2026-11-01 起主界面首条输入器不再提供该选择，
     字段保留给其他调用方；
  2. `source_session_id` 指向的**来源会话**的 `context_budget_tokens`（来源同工作区且存在时）；
  3. 缺省 `262144`。
  任何一级都不读工作区默认（那会让「会话独立」又变回全局配置）。
- `source_session_id` 与 `context_budget_tokens` 都进命令体参与载荷 hash：同一 `command_id`
  换来源或换档位重放按异载荷拒绝。
- 继承只发生一次。此后改子不改父、改父不改子；重新打开既有会话读它自己的持久值。
- `/new` 聊天命令建出的续篇沿用来源会话的 `context_budget_tokens`（服务端直接取，不经前端）。
- 迁移 0145 对既有会话回填：工作区设过档位就按那个值，否则 262144，列不可空。

**用量投影（`GET /assist-sessions/{id}/context-usage`，只读、无回执）**

- `budget{tokens, revision}`：会话**当前**档位。
- `next_call{reservation_tokens, context_budget_tokens, provider_window_tokens, window_source}`：
  **下一次调用会申请的预算**（2026-10-31 新增）。它由服务端用与冻结完全相同的
  `planAssistModelBudget` 计算，前端不自己取 min、也不拿历史值冒充。
  `reservation_tokens` = 按当前档位、且按已知 Provider 窗口截断后的申请值；
  `provider_window_tokens` 为 `null` 时 `window_source='UNKNOWN'`——默认连接没有模型窗口事实，
  此时 `reservation_tokens` 只表示「会按档位申请」，**不表示 Provider 一定装得下**。
  免费模型按 Provider 目录里声明的 `context_window` 截断（`window_source='MODEL_CATALOG'`）。
  模型选择不可用（配置读不到、目录里没有该模型）时整段为 `null`。
- `last_call`：最近一次**已结算且带用量**的 `kind='ASSIST'` 且 `purpose='PRIMARY'` 的模型调用
  （`status <> 'STARTED'` 且 `usage_input_tokens`／`usage_output_tokens` 至少一个非空；
  按 `settled_at` → `started_at` → `id` 倒序取一行）。在途（STARTED）行没有用量、失败行可能只有
  半截读数，用它们覆盖「最近一次有效统计」会让圆环在生成进行中突然变成未知或半截数字。
  **`purpose` 过滤（迁移 0153）是必需的**：记忆提取与记忆压缩这两类辅助外呼复用主对话的
  冻结预算、挂在同一条助手消息上，不排除它们会让「最近一次调用」变成一次 512 tokens 的后台
  提取调用。字段
  `source`（`MODEL_CALL`／`MESSAGE`）、`call_id`、`message_id`、`provider`、`model`、`status`、
  `input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_creation_tokens`、
  `reserved_tokens`（那次调用冻结的单次预算）、`settled_at`、`breakdown`。
  没有任何调用行时退回最近一条带用量的助手消息（`source=MESSAGE`），此时 `reserved_tokens`
  与 `breakdown` 均为 `null`——旧数据不编造分项。
- `breakdown{version, method, precision, categories[{key,bytes,tokens}], estimated_total_tokens,
  covered_bytes, image_parts}`：分类键 `HISTORY`／`SYSTEM`／`TOOLS`／`FILE_READS`／`MEMORY`／
  `OTHER`，只出现非零项。`precision` 恒为 `ESTIMATED`（UTF-8 字节 ÷ 3，与端口容量检查同一换算），
  `image_parts` 记录未被估算覆盖的图片段数。
- 口径：**只统计真的进了这次请求的文本**。文件类只读工具（`FILE_QUERY`/`FILE_READ`/`GIT_READ`
  能力）的结果记 `FILE_READS`，其余工具结果、工具声明与调用参数记 `TOOLS`，两者互斥；
  压缩摘要、资料/Skill 注入段由装配方登记为 `MEMORY`（不按正文前缀猜）；缓存读取不是额外加数。
  **Skill 的输入与依据只按 `turns` 里的那一段落账**：端口只发送 system + turns + toolTurns +
  steers，Skill 的 facts/input 已被应用层渲染进 turns（且 facts 本身不发给 Provider），
  再单独加一遍就是同一段内容累计两次。
  分项之和与 Provider 总量**不强行相等**：总量是 Provider 的分词结果，分项是本地估算。
- 存储：`model_calls.context_usage`（JSONB，随 STARTED 行一起提交），只存分类与数值，
  不存提示词、文件正文、工具输出、路径或凭据。迁移前的行为 `NULL`。

**运行时的预算来源**

- 有会话的调用（请求消息冻结、自动压缩、目标轮次）读会话档位；无会话的消费者（Run 准入、
  委派、连接验证）仍读工作区默认。冻结快照的字段由 `workspace_context_budget_tokens` 改名为
  `context_budget_tokens`，解析侧兼容旧键（读成同一个数）。
- Provider 窗口仍是硬上限：`call_reservation_tokens = min(档位, 目录 context_window)`；
  作用域上限至少两倍预留。档位不改变候选资格门槛，也不冒充物理窗口。
- 短期记忆的输入上限、自动压缩阈值与压缩输入容量全部按会话档位计算（无快照时同样如此）。

**验证。** 真实 PG/HTTP：`test/integration/session-context-budget.integration.test.ts` 5/5
（A/B 独立保存与 CAS/幂等、继承与跨工作区回落、0145 回填、用量投影与旧数据、HTTP 回执与严格请求体）；
`test/integration/context-budget-runtime.integration.test.ts` 5/5（压缩阈值、真实外呼预留、
Run 准入重算）。界面：jsdom `tests/contextUsagePanel.spec.tsx` 9/9；真实 Chromium
`tests/browser/contextUsagePanel.spec.ts` 5/5。

### 10.126 会话待办清单 `todo_write`（2026-10-30 源码实现）

Breaking Change: **No**。新增一个只读端点，旧客户端不调用它就不受影响。

- **读端点**：`GET /assist-sessions/:id/todos`。先按 `readAssistSession()` 判可见性，跨
  Workspace 或不存在的会话返回 404，与其它 Assist 读取同一口径，不因为它是独立投影就绕开
  会话可见性。
- **响应**：`{ snapshot: null }` 是明确事实——当前工作轮次还没有写过清单；有清单时
  `snapshot` 包含 `sessionId`、`scopeKey`、`version`、`items[{ id, content, status }]`、
  `inProgressLimit`、`updatedAt`。`status` 只取 `pending` / `in_progress` / `completed` /
  `cancelled`。`scopeKey` 为工作轮次键：`turn:<开启这一轮的用户消息 id>`，无用户消息时
  为 `session`。旧服务端没有这个字段时客户端按空串处理，退化为按版本比较。
- **没有写端点**：唯一写入口是模型侧的 `todo_write` 工具，界面只读。因此不存在“用户本地改
  进度”与“服务端快照版本”打架的情况。
- **写入语义**：首次写入的基线是 `expected_version: 0`（可省略）；已有快照时必须带当前
  版本，缺失返 `TODO_VERSION_REQUIRED`，不一致返 `TODO_VERSION_CONFLICT` 并在说明里给出
  当前版本号。同一个 `tool_call_id` 重放返回它当初写下的那一版（不递增、不新写事件），
  换个载荷就是身份伪造，返 `TODO_TOOL_CALL_CONFLICT`。
- **版本与轮次**：轮次切换后 `version` 从 1 重新开始，这不是回退；同一轮次内版本单调递增，
  客户端只接受同轮次不降版本、换轮次接受重计版本。

**第三轮补充（2026-10-30）**：

- **轮次顺序**：快照带 `scopeSeq`（开启该轮次的用户消息序号语义）。旧轮次的写入返
  `TODO_SCOPE_STALE`，不会改写当前投影；历史调用原身份重放仍返 `IDEMPOTENT` 与它当初那一版。
- **工作连续性**：最新一条用户消息在上一轮清单仍有未完成项时延续同一作用域（版本继续递增）；
  清单全部收尾后才是新作用域（版本从 1 重计）；`新任务：` / `/newtask` 前缀强制开新作用域。
- **重放比对**：同身份重放按规范化请求摘要（基线版本 + 条目 id + 内容 + 状态）核对，
  任一项不同即 `TODO_TOOL_CALL_CONFLICT`。
- **结算事实**：清单已保存但工具账本未结算时不会被当成完成，接口层面仍返回本次快照，
  账本行保留 `REQUESTED` 由恢复路径重结算。
### 10.128 会话列表状态只读投影 `list_state`（2026-10-30 源码实现）

**Breaking Change: No。** 没有新命令、没有新端点、没有迁移：给既有会话投影再加一个只读字段 `list_state`，`run_state` 原样保留。

| 端点 | 变化 | 说明 |
|---|---|---|
| `GET /assist-sessions` | 投影新增只读字段 `list_state` | 一次列表读取里逐行派生，八态或 `null` |
| `GET /assist-sessions/{session_id}` | 同上，**同一口径** | 左栏切会话后按身份重读那一行，两处不一致就会出现「切走变、切回变」 |
| 其余会话命令回执 | 无 | 不带 `list_state`，与 `run_state` 同一条边界 |

**取值与依据。** `list_state` 是**读时派生**的展示事实，不是 `assist_sessions` 的列，也没有新增写入 Owner。八个值各自对应一条既有事实：

| 值 | 依据 |
|---|---|
| `RUNNING` / `PENDING` | `assist_messages` 里有 `RUNNING` / `PENDING` 行（与 `run_state` 同一子查询） |
| `WAITING_APPROVAL` | `assist_proposals` 里有 `status='PENDING'` 的提案——这是仓库里唯一会话级的「等人决定」事实 |
| `COMPLETED` / `FAILED` / `CANCELLED` | 该会话**最后一轮** `role='ASSISTANT'` 行的 `status`（按 `seq desc limit 1`） |
| `NOT_STARTED` | 会话里一条 `assist_messages` 都没有 |
| `ARCHIVED` | `assist_sessions.status='ARCHIVED'` |
| `null` | 有消息但读不出最后一轮助手行，或该行状态落在在途档却与 `run_state` 不一致——**不知道就说不知道** |

**优先级只有一条链**（`deriveListState`，列表与单条读取共用）：在途 → `WAITING_APPROVAL` → `ARCHIVED` → `NOT_STARTED` → 最后一轮终态 → `null`。

- **`run_state` 与它的关系**：`run_state` 是 `list_state` 的在途子集，继续保留——轮询与「此刻有没有在跑」需要窄口径。两者不是两套判定，`list_state` 是唯一派生结果。
- **`null` 不是完成**：`run_state` 的 `null` 只说明「没有在途的一轮」，空会话与结算会话在它眼里一样；正是这一点让旧投影不能直接当展示态用。
- **不看消息正文、不看时间、不看工具调用**：审批态只认提案行，不从内容或时间推断「大概在等人」。
- 成本：列表仍是一句 SQL——`has_messages`、在途、最后一轮助手行、待确认提案共四个相关子查询（`assist_messages(session_id, seq)` 与 `assist_proposals(session_id)` 均有索引）；单条读取合并成一次往返。**不改变排序键、`revision` 与 `updated_at`**。

**兼容。** 旧客户端忽略新字段不受影响；新客户端读旧服务端时 `list_state` 缺失，按 `run_state` 兜底一次（在途仍画对），其余回退类型图标；读到词表之外的值**不**整条失败，而是读成 `null`——这一枚是导航列的展示图标，任何一个新词都不该让整列列表读失败。

**验证。** 派生链单元测试 `test/unit/session-list-state.test.ts` 5/5（逐档钉优先级与 `null`）；真实 PG/HTTP `test/integration/assist-run-state.integration.test.ts` 扩到 8 项（空会话 `NOT_STARTED`、结算后 `COMPLETED`、失败/取消各自成态、归档 `ARCHIVED`、待确认提案 `WAITING_APPROVAL` 且撤销后回落到 `COMPLETED`）。**本轮本机无 PostgreSQL，集成套件未运行**，见验收表对应行的未验边界。

### 10.129 会话诊断导出 `GET /assist-sessions/{id}/export`（2026-11-01 源码实现，只读端点）

**Breaking Change: No。** 新增一条只读端点：没有命令、没有 `command_id`、没有迁移、不写任何账本。

| 端点 | 说明 |
|---|---|
| `GET /assist-sessions/{id}/export` | 返回一份 `relay-session-export` 文档，`Cache-Control: no-store`，`format='relay-session-export'`、`schema_version='1.0'` |

- **归属与 404**：跨 Workspace、不存在的会话与无凭据按既有会话读取的同一口径拒绝（404），不返回部分可信内容。
- **一致性**：事务外先确认会话可见，整份读取放进 `READ ONLY` + `REPEATABLE READ` 事务——消息、工具账本、清单快照与执行请求描述的是同一时刻，而不是各自读一次再拼。只读事务不加行锁，不挡正在生成的那一轮。
- **不声明 response schema**（有意）：字段随各投影走；这里声明 TypeBox 会把没列出的列静默裁掉，正与「不静默残缺」冲突。
- **顶层键固定**（EX-10 逐字核对）：`format`／`schema_version`／`exported_at`／`relay`／`snapshot`／`workspace`／`session`／`scope`／`model`／`context_usage`／`messages`／`tool_calls`／`model_calls`／`todos`／`executions`／`operations`／`file_changes`／`completeness`／`privacy`。bigint 一律转十进制字符串（`revision`、`seq` 等整型列都按这个收口走），JSON 里出现 number 就意味着精度可能已丢。
- **上限与部分导出**：消息上限 2000 条（沿用读消息的 200 条分页口径会丢历史，导出不沿用）；工具调用、模型调用、执行请求、动作各上限 500 条。超过即部分导出，`completeness.<集合>.{total,exported,limit,truncated,reason}` 自述；账本里挂着但本文件未导出消息的轮次以 `completeness.tool_calls_without_message` 点出。
- **没有的事实不补**：工具结果正文（`session_tool_calls` 只存 `result_digest`）、Todo 变更历史（`assist_session_todo_events` 无面向界面的合法读口）、模型私有推理与应用版本分别写 `null` 或 `completeness.missing_evidence`；`relay.version_source='NOT_EXPOSED_BY_API'`，不从别处猜一个版本号。
- **脱敏口径**：结构化字段按凭据键名与凭据值形态替换为 `[REDACTED:*]`，单字符串上限 32,768 字符（先脱敏再截断）；用户与 AI 的消息正文逐字保留，`privacy.message_content` 当面声明文件里可能含用户自己的资料；附件只导元数据，不内嵌二进制；接入配置与动作参数不进文件，动作只交 `params_sha256`。
- **不推进任何事实**：不写回执、不结算、不推进 `revision`；`snapshot` 说明导出时刻会话是否在生成中，在途回复只带已落盘的即时草稿（`messages[].live_preview`），不把 PG 里不存在的「完整中间稿」补出来。

**验证。** 真实 PG/HTTP `test/integration/session-export.integration.test.ts` **12/12**（EX-01–EX-12：正常会话证据齐全、归档可导、空会话不造占位、四态与拒绝原文、260 条长会话不被分页上限截断、520 条工具调用部分导出自述、生成中快照、跨 Workspace 404、凭据脱敏、顶层结构与十进制字符串、只读前后一致、代表性会话的动作身份与清单快照）。浏览器落盘与界面口径归[工作台 §28.1](../../frontend/workbench-design/part-09.md#281-左栏recentworkrail)。

### 10.130 会话回复的实时 Token 读数（2026-11-01 源码实现，迁移 0155）

**Breaking Change: No。** 没有新命令、没有新端点、没有新账本；只给三个既有读投影增加可选字段，旧客户端忽略即行为不变。

| 端点 | 新增只读字段 |
|---|---|
| `GET /assist-sessions/{id}/messages` | 每条消息 `usage_summary`：本轮 `PRIMARY` 模型调用（含工具续轮）的账本汇总 |
| `GET /assist-sessions/{id}/messages/{message_id}/live-preview` | `usage`：已结算调用 + 当前在途调用的可丢弃估算；终态或不可见时为 `null` |
| `GET /assist-sessions/{id}/messages/{message_id}/live-preview/events` | 帧体与上面的 GET 同形，`usage` 随帧更新（仅用量变化也会推进 `preview_revision`） |

**读数形状。** `{ state, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, settled_calls, pending_calls, missing_usage_calls }`。`state ∈ ESTIMATED | PARTIAL | CONFIRMED | UNKNOWN`；所有 token 字段是原始整数或 `null`，`null` 表示 Provider 未上报，**不是 0**。

**事实来源（唯一账本 + 可丢弃估算）。**
- 真实用量只来自 `model_calls`：按 `assist_message_id`、`kind='ASSIST'`、`purpose='PRIMARY'` 汇总已结算行。记忆提取/压缩等辅助外呼虽然挂同一条消息，但不是用户这一轮的消耗，按 `purpose` 排除。
- 在途调用的估算只写在 `assist_message_previews.usage`（迁移 0155，随预览行一起删除）：`call_id` + `input/output_tokens_estimate` + Provider 已上报字段。估算用 UTF-8 字节 / 3，与端口外呼前的预算检查、上下文构成快照同一换算。
- **按 `call_id` 去重**：估算只在对应调用仍为 `STARTED` 时参与；该行结算后账本优先，估算被忽略，不重复累计。写入与文本预览共用同一所有者 CAS，结算/取消/换 Worker 后迟到帧写不进去。
- 不建立第二套计量账本，不为每个 Token 写 PostgreSQL：估算约 500ms 一档节流写入，界面按 SSE 帧更新。

**状态口径。**

| 状态 | 依据 | 界面 |
|---|---|---|
| `ESTIMATED` | 只有当前在途调用的估算，尚无结算读数 | `本轮 ≈ N tokens` |
| `PARTIAL` | 有已确认调用，但仍有在途调用或已结算调用缺用量 | `本轮 ≥ N tokens · 部分用量未知` |
| `CONFIRMED` | 全部调用已结算且都有输入与输出 | `本轮 N tokens` |
| `UNKNOWN` | 没有足够数据 | 生成中「Token 统计中」；完成态「本轮 Token 未上报」 |

**完成态校准。** 消息结算的同一事务删除预览行，随后 `GET messages` 的 `usage_summary` 成为唯一读数来源；失败与取消保留已结算部分的真实用量，界面不归零、不回跳。上下文圆环仍读 `GET /assist-sessions/{id}/context-usage` 的单次调用口径，两者不共用分母。

**验证。** 单元 `assist-usage-projection`（多轮累计、估算与账本去重、缺字段不补零、状态推导）与 `assist-live-preview`（发布器节流与失权）、`openai-compatible-model-port`（进度帧携带估算与 Provider 已上报值）；真实 PG/HTTP `assist-live-preview.integration.test.ts` 覆盖生成中估算可见、结算校准、Provider 不上报、辅助外呼排除、多轮累计与迟到帧拒写、首帧只带用量。前端口径归[工作台 §28.10](../../frontend/workbench-design/part-10.md#2810-agent-回复的实时-token-读数2026-11-01)。

### 10.131 会话消息的在途执行阶段投影（2026-11-01 源码实现，AGENT_STREAM_VISIBILITY）

**端点不变，消息 DTO 追加只读字段。** `GET /assist-sessions/{id}/messages` 的每条 `ASSISTANT` 消息在 `status='RUNNING'` 时多一个 `generation_progress`；`PENDING`、终态与非助手消息为 `null`。这是一个**读时派生投影**，不新建表、不新增迁移、不写任何业务状态。

**形状。**
```json
{
  "phase": "PREPARING_CONTEXT | WAITING_MODEL | MODEL_STREAMING | MODEL_OUTPUT | PROCESSING",
  "call_count": 1,
  "latest_call": {
    "status": "STARTED | COMPLETED | FAILED | CANCELLED",
    "started_at": "…",
    "first_stream_event_at": "… | null",
    "first_text_delta_at": "… | null",
    "first_preview_persisted_at": "… | null",
    "settled_at": "… | null"
  }
}
```
`latest_call` 在没有 PRIMARY 调用行时为 `null`；`call_count` 是该消息已登记的 PRIMARY 调用次数（工具续轮各算一次）。辅助外呼（`purpose='MEMORY_CAPTURE'|'MEMORY_COMPACT'`）按既有记账口径排除，不冒充本轮回复。

**阶段规则（全部由既有事实派生）。**
- 消息已 `RUNNING`、还没有 PRIMARY 调用行 → `PREPARING_CONTEXT`：Worker 已领取，上下文/记忆准备尚未登记模型请求。`PENDING` 不属于这个阶段——它由消息状态表达「等待处理」。
- 最新调用 `STARTED`，`first_stream_event_at` 为 null → `WAITING_MODEL`：请求行在调用前提交，**不代表 Provider 已接收**。
- 最新调用 `STARTED`，有首流事件、无首文字增量 → `MODEL_STREAMING`：可能只是 reasoning 或工具参数，因此界面只能说「模型已响应，等待正文」，不得展示推理正文或声称正在写正文。
- 最新调用 `STARTED`，有首文字增量 → `MODEL_OUTPUT`：结构化信封可能仍在等待安全投影，界面只说「已收到模型输出」，不提前形成业务结论。
- 最新调用已结算而消息仍 `RUNNING` → `PROCESSING`：正在派发工具或准备续轮；工具成败仍只由 `session_tool_calls`/Gateway 账本说话。

**首流事件接线。** 默认兼容端口的 A 档、普通主循环、工具续轮、人设助手只读轮次（B 档）、子 Agent 与学习轮次现在每次真实调用都传 `onStreamEvent`，写 `first_stream_event_at`；B 档同时补 `model_calls` 行（此前默认端口直接调用 `modelPort.assist`，没有调用计量）。免费路由已有自己的包装，重复观测因 `first_stream_event_at is null` 的条件 UPDATE 成为空操作。证据写入失败只丢这一枚时间，不把成功调用改判为失败，也不吞掉业务异常。

**诊断口径。** 客户端在阶段行下就地展开只读读数：提交→模型请求登记（含排队与上下文准备）、请求→首流、首流→首正文、首正文→预览可见、请求→调用结算；Worker 领取时刻为「未记录（排队与上下文准备合并计算）」，前端首次绘制为「本机未观测」。**不得把消息总耗时当作模型推理耗时**，也不混算服务端与本机时钟。

**不泄露。** 响应不含提示词、上下文正文、reasoning、工具参数或凭据；`call_count` 与时间戳只用于诊断。

Breaking Change: **No**——纯追加可选只读字段；旧客户端忽略即可，命令、表、权限、结算与恢复语义均不变。

**证据。** 单元 `assist-generation-progress` **7/7**（阶段派生、工具续轮取最新、DTO 时间）与 `openai-compatible-model-port` 的 reasoning-only 观测（首流触发、正文增量保持为空）；真实 PG/HTTP `assist.integration.test.ts` 追加的流式观测用例 **1/1**（`run-integration.ps1 -TestFile assist -TestNamePattern "stream observation times"`，临时集群 PASSED 并清理）核对首流、首文本、首预览、结算四枚时间落库且辅助外呼不混入；组件 `generationStage` **8/8**、`assistStage` **3/3**（阶段文案、诊断、PENDING、草稿接管、取消）；真实 Chromium `assistStageVisibility` **2/2**（阶段推进与截图、诊断展开、窄窗无溢出、减少动效三点静止）。规则归[生成生命周期](../../development/agent-generation-lifecycle.md#等待阶段的流式观测2026-11-01-agent_stream_visibility)与[工作台 §18.6.4](../../frontend/workbench-design/part-06.md#1864-等待阶段行三点旁的一句真实进度2026-11-01)。

### 10.132 会话标题的来源与系统命名（2026-11-01 源码实现，迁移 0157）

会话标题在既有契约里只有一个字符串；本批补上**它从哪来**、**谁有权改**与**一次自动命名请求的持久身份**。标题仍是 Assist 模块的事实：模型只给出 `{category, subject}`，由服务端校验、拼接 `分类-任务名` 并 CAS 落库，客户端不拼标题、也不决定能否覆盖。

**建会话命令追加可选字段。**
```json
{
  "command_id": "…", "project_id": "… | null", "task_id": "… | null",
  "title": "首条消息截断或显式标题",
  "title_source": "PROVISIONAL | USER_DEFINED"
}
```
- 不传 `title_source` 按 `USER_DEFINED`：既有客户端/测试显式给的名字默认受保护，这不是行为破坏。
- 传 `PROVISIONAL` 表示「这是系统占位」：未关联项目/任务的讨论由服务端把提交文本规范化为 `分类-任务名`（分类枚举固定为 UI／功能／修复／架构／测试／调研／文档／其他）；关联了项目/任务的讨论保留既有 `关于<目标>`，等首次语义生成换成正式结构化标题。
- `title_source` 进命令体参与载荷摘要：同一 `command_id` 换来源重放按异载荷拒绝。

**会话 DTO 追加只读字段。**
```json
{
  "title_source": "LEGACY | PROVISIONAL | AI_GENERATED | USER_DEFINED",
  "title_generated_at": "… | null",
  "title_generation": {
    "status": "PENDING | CLAIMED | COMPLETED | FAILED | SKIPPED",
    "request_kind": "AUTO | REGENERATE",
    "generator": "MODEL | RULES | null",
    "error_code": "… | null",
    "requested_at": "…", "settled_at": "… | null"
  } | null
}
```
`title_source` 是会话行自身的事实：`LEGACY` 旧行（迁移只打标不改名）、`PROVISIONAL` 系统临时、`AI_GENERATED` 语义生成成功、`USER_DEFINED` 用户手动。`title_generation` 是读时派生投影，只用于显示「正在生成」与失败原因，不作为标题可信度依据。

**显式重新生成的命令端点。**
```http
POST /api/v1/workspaces/{workspace_id}/assist-sessions/{id}/title/generate
{ "command_id": "…", "expected_revision": "…" }
→ 200 { "session_id": "…", "request_id": "…", "status": "PENDING",
        "revision": "…", "requested_at": "…" }
```
- 命令只**受理**：写一条 `assist_title_generations` 请求并返回其身份，不调用模型；`status='PENDING'` 不代表标题已变化。
- 唯一允许替换 `USER_DEFINED` / `LEGACY` 标题的入口，因为它表达用户本人当前的选择；自动请求永远不越过这个边界。
- 仍走既有 `command_id` 幂等与 `expected_revision` CAS：同命令重放返回同一条请求；修订落后 409。
- 归档会话按「先重开」拒绝（`INVALID_TRANSITION`），与改名同一条边界；没有可用消息内容时同样拒绝。

**自动生成生命周期。**
1. 助手回复以 `COMPLETED` 结算后，生成循环**只入队**一条 AUTO 请求（`request_kind='AUTO'`），不调用模型、不改变消息或回复。
2. 常驻后台 tick（`background-work-scheduler.ts` 的 `SESSION_TITLE` 阶段）领取请求，装配受限输入（首条有效用户消息、最近用户消息、关联任务/项目标题、刚结算的回复摘要；不读工具日志、文件正文、附件与凭据），调用一次辅助模型，输出必须是严格 JSON 信封。
3. 服务端校验分类与任务名（长度、中文、无 Markdown/Emoji/执行状态/模糊话术），再凭请求时冻结的 `base_title`/`base_title_source` 在事务内 CAS 落标题；标题或来源已被用户改动时请求停在 `SKIPPED`。
4. 模型未配置、超时、返回非法 JSON 或非法分类时，AUTO 用规则引擎给出确定性结构化临时标题（`generator='RULES'`，来源仍 `PROVISIONAL`）；显式重新生成如实 `FAILED` 并保留原标题。
5. 同一会话 10 分钟内最多一次 AUTO 请求；已有正式标题后，只有用户消息出现明确换任务标记才再次入队。无法可靠判断目标变化时保持原标题。
6. 辅助外呼按 `purpose='TITLE'` 进 `model_calls` 与预算闸门，但不抢「最近一次调用」读数，也不计入本轮 PRIMARY 用量。

Breaking Change: **No**（形状为追加；不传 `title_source` 的既有调用方保留原行为）。语义变化：工作台提交占位标题时传入 `title_source='PROVISIONAL'`，其未关联目标的临时标题由服务端结构化；旧会话一律 `LEGACY`，迁移不批量改名。

**证据。** 单元 `session-title` **9/9**（分类、临时标题、任务名检查、长输入收口、模型信封、恶意结构拒绝）；真实 PG/HTTP `assist-session-title.integration.test` **8/8**（结构化临时标题、模型落库与 TITLE 不抢 PRIMARY 读数、手动改名后迟到结果 SKIPPED、显式重新生成的幂等与 CAS、无模型/非法输出降级、LEGACY 保护与归档拒绝、无模型重生成失败保留原标题、删除级联）；组件 `sessionRowMenu` **39/39**；真实 Chromium `sessionTitleRegeneration` **3/3**。规则归[ADR-040](../../decisions/ADR-040-session-title-ownership.md)、[工作台 §28.3](../../frontend/workbench-design/part-09.md#283-会话标题的系统命名与重新生成2026-11-01)、[生成生命周期](../../development/agent-generation-lifecycle.md#会话标题的后台生成接缝2026-11-01)。

### 10.133 项目工具有效性只读投影（2026-11-01 源码实现，PLUGIN-P0-01）

**Breaking Change: No（新增只读端点）。** `GET /projects/{project_id}/tool-availability`（Workspace 作用域，`Cache-Control: no-store`）。

- **回答什么**：工作台「可以用的工具」那七行（`files` / `git` / `web` / `cli` / `computer` / `browser` / `github`）各自的**合成状态**：`READY`（可自动准入）、`NEEDS_APPROVAL`（需逐次批准）、`SITE_SCOPED`（仅部分站点）、`READ_ONLY`（只有读取类动作）、`PARTIAL`（部分动作）、`NOT_AUTHORIZED`（有连接无策略）、`DENIED`（命中拒绝）、`NOT_CONFIGURED`（无连接）、`DISABLED` / `REVOKED`（连接停用/撤销）、`RUNTIME_UNAVAILABLE`（本机运行时不可用）、`UNKNOWN`（事实读不全）。附 `detail` 与逐动作分布 `counts`。
- **为什么搬回服务端**：此前工作台在浏览器里用「存在任意一条非拒绝策略」拼「可用」，于是只授权了 `read_file` 的文件行也显示整行可用、`gh` 没装也显示可用、策略 `target_prefix` 不覆盖本项目目录也显示可用——那是第二套权限引擎，而且比 Gateway 宽松。现在判定复用 Gateway 自己的原语（`capabilityFor` / `targetMatches` / `rankActivePolicies` / `ADAPTER_DESCRIPTORS`），界面只做映射。
- **判定口径**（逐动作）：连接必须 `ACTIVE` 且具备该能力，目录类能力还要求连接的 `root_path` 覆盖某个 ACTIVE 受管根；目标按能力族取（文件/Git/CLI/GitHub 取受管根，电脑取 `computer://desktop`，浏览器取 `browser://`，网页抓取取连接的 `allowed_host`）；策略按 `能力 × 动作 × 目标前缀` 命中后取最严格者。命中 `AUTO` 但适配器 `approvalPassthrough=false`（FILE_WRITE / GIT_WRITE / CLI_RUN / COMPUTER_INPUT / BROWSER_ACTION / BROWSER_COMMIT）时降级为 `NEEDS_APPROVAL`——授权不等于自动可执行。
- **不回答什么**：不做准入。本查询不创建连接、不写策略、不放宽任何权限，也不代替 Gateway 的派发前判定；界面显示可用不会让任何动作跳过 Gateway。
- **运行时**：`computer` / `browser` / `github` 三行结合 `/plugins/status` 同一份安装级探测；运行时明确不可用时整行是 `RUNTIME_UNAVAILABLE`，即使连接与策略齐备。
- **无法确认不推断**：`ACTIVE` 策略却读不到生效版本、或某行缺少服务端结论时，状态是 `UNKNOWN`，界面不回落到可用。

**证据。** 单元 `tool-availability` **14/14**（只授权 read_file 时只读可用、只授权截图时电脑行只读、授权齐全但写入仍需审批、停用/撤销、DENY 不被其它策略掩盖、目标前缀不匹配、连接目录边界不覆盖、运行时不可用、策略版本缺失、未配置、仅站点授权、网页主机不一致、载荷上限过小）；真实 PG/HTTP `tool-availability.integration.test`（空项目全部未配置、只有连接时未授权、只授权 read_file 时只读可用、停用连接后立即变已停用、撤销策略后仍按连接状态、不存在项目 404）；组件 `connectionsSettings` **37/37**。

### 10.134 会话与消息的模型连接身份：会话选择、聊天默认与按连接验证（2026-11-02 源码实现，迁移 0158，ADR-036 阶段四）

**Breaking Change: No（纯新增列、新增可选响应字段与新增可选验证目标；既有端点响应只增不减）。** 本段把设置页登记的模型连接接进聊天与验证：会话可以选一条已登记连接，消息受理时冻结连接身份，执行端按冻结身份解析，验证按连接独立归属。

**迁移 0158 四处追加。**

1. `session_model_selection.connection_id uuid → model_connections`，并把 `connection` 取值 CHECK 从 `default|openrouter` 放宽到 `default|openrouter|registered`（先按 `pg_get_constraintdef` 文本定位 0089 的真实约束名，找不到即抛 `P0004`，不半应用）。新 CHECK 两分支写全：`registered` 必须有 `connection_id` 且目录依据全空、`free_only=false`；另两枚必须 `connection_id IS NULL`。
2. `workspace_default_model_connection.chat_connection_id`：工作区**聊天**默认。0144 的 `connection_id` 只决定新 Run 从哪条连接冻结，不能直接当聊天默认（那会让所有既有会话在无人操作时换 Provider）。两枚默认分列、互不写回；`connection_id` 同时放开 NOT NULL，两列都为 NULL 是合法状态——聊天与 Run 各自可单独设置或取消，都回到进程默认。
3. `GRANT DELETE ON session_model_selection`：只服务于用户显式「清除本会话选择、恢复跟随默认」；消息行仍带受理时冻结的快照与连接身份，历史归因不受影响。
4. `assist_messages.model_connection_id`（非空必带冻结快照，CHECK 约束）与 `model_calls.connection_id`（仅 `kind='VERIFY'` 的已登记连接目标填写，附部分索引 `(connection_id, started_at DESC) WHERE kind='VERIFY' AND connection_id IS NOT NULL`）。凭据代数不重复冻结：消息行沿用 0142 的 `model_credential_fingerprint`。

**会话模型选择。** `GET /assist-sessions/{session_id}/model-selection` 返回 `{selection}`（无覆盖为 `null`，前端据此显示「跟随默认」）。`POST /assist-sessions/{session_id}/model-selection` 体 `{command_id, connection_id: uuid|null}`：非空走 `SelectSessionConnection`，核对连接属于本工作区、`ACTIVE`、系统凭据库有可用凭据，分别以 409 `MODEL_CONNECTION_UNAVAILABLE` / `MODEL_CONNECTION_DISABLED` / `MODEL_CONNECTION_CREDENTIAL_MISSING` 拒绝；绑定稳定连接 ID 与 `connectionConfigFingerprint`，结果 `kind='MODEL_SELECTION'`。`null` 走 `ClearSessionModelSelection`，结果 `kind='MODEL_SELECTION_CLEARED'`。两条命令都沿用 `command_id` 幂等与 `expectedRevision` CAS，重放置 `command-replayed: true`。归档会话按「先重开」拒绝；**消息已经排队或正在生成时拒绝切换**（`INVALID_TRANSITION`），切换只作用于后续新消息——在途消息的快照在受理时已冻结。

**工作区聊天默认。** `GET /model-connections/chat-default` 返回 `{connection_id, revision}`；`PUT /model-connections/chat-default` 体 `{command_id, connection_id: uuid|null}`，命令 `SetChatDefaultModelConnection`，`null` 是显式取消而不是恢复某条连接。它与 `GET/PUT /model-connections/default`（0144，Run 默认）互不影响：改聊天默认不动已冻结与新建的 Run，改 Run 默认不动聊天。

**冻结优先级与执行端闸门。** 消息受理时按「**显式会话选择 → 工作区聊天默认 → 进程默认**」冻结；Run 仍按 0144 的 Run 默认冻结，两者不共享写回。冻结写入消息行 `model_connection_id`、`model_selection_snapshot` 与 `model_credential_fingerprint`。执行端只读冻结身份，**不重新读取当前默认连接**；六道闸门按序停：连接行不存在 → `ASSIST_MODEL_CONNECTION_UNAVAILABLE`；非 `ACTIVE` → `ASSIST_MODEL_CONNECTION_DISABLED`；型号或配置指纹不符 → `ASSIST_MODEL_CONFIG_CHANGED`；凭据库不可用 → `ASSIST_MODEL_CREDENTIAL_STORE_UNAVAILABLE`；凭据缺失 → `ASSIST_MODEL_CONNECTION_CREDENTIAL_MISSING`；凭据身份已换 → `ASSIST_MODEL_CREDENTIAL_CHANGED`。任何一道都**零外呼**，不静默回退其他连接或 Mock。

**按连接验证。** `POST /model-port/verify` 与 `GET /model-port/verification` 新增可选目标 `{connection:'registered', connection_id}`（格式非法 400 `MODEL_VERIFY_TARGET_INVALID`，连接不存在 404 `MODEL_VERIFY_CONNECTION_UNAVAILABLE`）。验证仍只发送固定 `VERIFY_PROMPT`、非流式、带超时，不携带聊天、项目资料或工具上下文；外呼仍走 `guardedModelFetch`（HTTPS、DNS 与重定向防护），HTTP 可达不等于模型可调用。判定按连接归属：同 provider 同型号的两条连接各自有 `target_last` 与 `state`，成功互相不冒充；轮换 Key 后旧结论变 `CREDENTIAL_CHANGED` / `UNVERIFIED`，必须重新验证；缺凭据或凭据存储不可用时在**外呼前**显式拒绝且不写 VERIFY 账本。

**证据。** 迁移 `migration` **14/14**；真实 PG18.6 + HTTP `chat-model-connection.integration.test` **8/8**（会话选择冻结连接身份并按连接外呼、改默认不影响在途；轮换 / 停用 / 改型号三种排队消息类型化停止且零外呼；同型号同 Provider 的两条连接验证互不冒充、轮换后失效、重验恢复；缺凭据与存储不可用不外呼不落账；聊天默认可写可读、命令重放不推进 revision、可取消且跨工作区不可见；聊天默认决定新会话冻结、显式选择优先、Run 默认独立、取消回进程默认）；`session-model-selection` **11/11**、`model-connections` **7/7**、`model-verify` **8/8**、`run-model-connection` **4/4**、`assist-model-runtime` **2/2**。规则归 [ADR-036](../../decisions/ADR-036-multi-provider-model-connections.md)、[工作台 §27.5](../../frontend/workbench-design/part-09.md#275-免费模型分组与模型选择)、[设置中心](../../frontend/workbench-design/part-02.md#7-视觉与可访问性基线)。
