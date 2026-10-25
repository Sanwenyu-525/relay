# HTTP 与应用命令契约：分册 06

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../http-command-contract.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

### 10.81 免费模型目录只读与手动同步（2026-10-15 源码实现，阶段 B）

[roadmap §9.1](../../requirements/post-v1-roadmap.md) / [运行架构 §8.6](../../architecture/runtime-context.md) 的目录面落点，实现 `prompts/free-model-catalog.md` **阶段 B**：OpenRouter 免费目录同步与严格免费判定。目录是**进程级全局事实**，不隶属某个 Workspace——与 `/model-port` 同一先例：为复用实例 Bearer 守卫，端点仍挂在 `API_PREFIX` 的 `…/workspaces/:workspace_id/` 之下，但 `workspace_id` **不作为作用域键**（处理器不据它过滤，正如 `GET /model-port` 忽略该值）。任何持本实例 Bearer 的客户端可见/可触发。**响应永不含密钥。**

| 端点 | 命令？ | 说明 |
|---|---|---|
| `GET /model-catalog` | 否（只读） | 200，返回当前已发布快照的发布头（`source`、`directory_digest`、`snapshot_seq`、`last_success_at`/`last_attempt_at`/`last_failure_at`、`last_failure_reason`、`consecutive_failures`、`configured`、`cache_stale`）与条目列表。默认只回**严格免费**条目；`?free_only=false` 或 `?all=true` 连非免费一起回，供「目录收录≠免费」核对。无成功快照时各时间为 `null`、`directory_digest` 为 `null`，不伪造。 |
| `POST /model-catalog/refresh` | 否（非幂等命令） | 200，触发一次 `manual` 同步，返回结构化 `{status, reason, snapshot_seq, total_count, free_count, fetched_at}`。`status ∈ NOT_CONFIGURED / SKIPPED / REJECTED / PUBLISHED / FAILED`；`SKIPPED.reason ∈ CACHE_FRESH / BACKOFF / RATE_LIMITED / IN_FLIGHT / SUPERSEDED`，`FAILED.reason` 为来源失败分类（`NETWORK/TIMEOUT/AUTH/RATE_LIMIT/PROTOCOL/INCOMPLETE/ENDPOINT_NOT_ALLOWED/NOT_CONFIGURED`），`REJECTED.reason = MAINTENANCE`。 |

**同步不是带回执的幂等命令。** 与 `/model-port/verify` 同类，目录刷新不建 `command_receipt`，改用**数据库租约 + 快照序号 CAS** 收敛重复外呼：领取租约与快照发布各是独立短事务，网络拉取在事务外（模型/网络不进长事务，契约 §4）。跨进程/多客户端同一时刻只有一个执行体拿到未过期租约并外呼（`IN_FLIGHT`）；发布以 `snapshot_seq` 基线做 CAS，**迟到或较旧的响应基线不匹配即整体丢弃，绝不覆盖更新快照**（`SUPERSEDED`）。来源失败**保留旧快照与上次成功时间**，仅记失败原因并推进指数退避；合法但为空的目录**如实清空**可选免费集合。手动刷新受最小间隔限速（`RATE_LIMITED`），退避优先于 TTL 与限速判定。

**错误映射。** 目录配置残缺（非法/越界的 `RELAY_MODEL_CATALOG_*`）→ `MODEL_CATALOG_CONFIG_INVALID` 409；其余读取异常按 `sendReadError` 走 ProblemDetails。`REJECTED`（维护/排空态）作为结构化 200 结果返回而非 503——目录刷新非关键路径，被拒不改写任何事实。

**凭据与端点隔离。** 目录凭据 `RELAY_MODEL_CATALOG_API_KEY` **独立于**聊天 `RELAY_MODEL_API_KEY`，绝不串用；OpenRouter `/models` 列表公开可读，缺目录凭据仍可同步可核实目录，但「目录收录」不等于认证、实际工具能力或额度可用（额度真实性由阶段 C 的真实外呼另行证明）。来源、分页、响应字节数与条目数全部有界；端点复用 `parseModelBaseUrl`/`guardedModelFetch`（公开 https、拒凭据/query/fragment、锁同源与 API 路径前缀、拒重定向、发前复查 DNS），目录内容一律当**外部数据**、不得引入新的请求主机或升级为指令。是否免费按「本次支持的文本调用计价项」`prompt/completion/request` **字符串精确判零**（极小非零不误判为零），缺失/非法/负数/来源新增且非零的未知收费项一律保守拒绝并给类型化原因。

**尚未实现（阶段 C，本批不建无当前调用方的表）。** 会话模型选择（带 revision/幂等的选择命令）、Run 模型冻结、以及**免费调用硬保护**（HTTP 体内零价格强制上限）留待下一批以 `0089+` 追加；`0088` 只建 `model_catalog_sync_state` 与 `model_catalog_entries` 两张全局表，不触碰 `assist_sessions`/`runs`/`model_calls` 契约。

Breaking Change：**No**——纯新增两张全局表与两个新端点，既有端点、表、CHECK 分支原样保留；`relay_app` 对 `model_catalog_sync_state` 授 `SELECT` + 定向列 `UPDATE`（无 INSERT/DELETE，单例行由迁移预置），对 `model_catalog_entries` 授 `SELECT/INSERT/DELETE`（整体替换、不给单点 UPDATE）。回退可直接保留两表（旧代码不读）。

**证据（如实）。** 严格免费判定、配置/生命周期决策、来源传输与凭据/端点隔离由定向单测覆盖并通过（`model-catalog-pricing`/`model-catalog-config`/`openrouter-catalog-source`，`apps/api` 全量 `tsc --noEmit` 通过）。同步用例的租约去重、CAS 不倒退、失败保留、空目录清空、以及「同步绝不写 `model_calls`」写为真实 PG 集成测试 `model-catalog-sync.integration.test.ts`，**本轮已通过类型检查但尚未执行**（共享工作树内另有并行执行实例，并发跑 `run-integration.ps1` 会挂死/偶发假失败，故留待空载单跑）。真实 OpenRouter 外呼、浏览器与 Windows 安装态**未验证**（无授权凭据）。

### 10.82 会话模型选择、Run 模型冻结与免费调用硬限制（2026-10-15，免费模型专项阶段 C）

[roadmap §9.1](../../requirements/post-v1-roadmap.md) / [运行架构 §8.6](../../architecture/runtime-context.md) 的选择与准入面，实现 `prompts/free-model-catalog.md` **阶段 C**。本节把「已实现且已接线」的会话选择持久化、「已实现并在外呼边界取证」的免费硬限制，与「尚未接线的 Run 冻结/实际外呼」明确分开，不把目标协议当现状。

**冻结约束是随调用携带的非密钥快照。** `workflow/frozen-model-constraint.ts` 定义 `FrozenModelConstraint`：连接引用（`provider` + **确切** `model` + 64-hex `configFingerprint`）、`freeOnly` 布尔、`catalogBasis`（`source=openrouter` + `snapshotSeq` + `sourceModelId`，原默认连接为 `null`）与可选 `budget`。解析对**缺省/空**返回 `undefined`（旧会话无覆盖、旧 Run 无快照时调用方保留原默认，**不伪造**模型身份或免费约束），对半截/畸形对象抛 `FrozenModelConstraintError`——不可信的快照绝不能升级为「免费」或「确切模型」判定。「未知」用 `undefined` 表达，`freeOnly` 缺省视为无免费约束而非「已知非免费」。

**免费调用硬限制已实现并在最终 HTTP 体外呼边界取证。** 携带 `freeOnly` 的约束经 `workflow/free-call-guard.ts` 生成服务商路由硬限制：`provider.max_price` 把 `prompt/completion/request/image` 全部钉为绝对 `0`（USD / 百万 token、每请求、每张），`allow_fallbacks:false` 关闭「免费端不可用落付费端」，`require_parameters:true` 拒绝能力被静默顶替。`OpenAiCompatibleModelPort` 以可选第三参数接受该硬限制，把注入包在 `guardedModelFetch` 之外、SDK 之内（`wireFetch`），因此**普通外呼与 reasoning 续轮重建的客户端都携带**；不带免费约束时端口请求体逐字不变（**原默认不受免费目录故障影响**，FM-07）。具体免费型号请求保持冻结的确切 `model`，**绝不调用 `openrouter/free`**（随机选型违反 Run 模型稳定语义）。受控 HTTP 用例经真实 ChatOpenAI SDK + 注入 fetch 捕获**最终发出体**证明之（`openai-compatible-free-guard`）。

**本批已接线（migration `0089`）：会话模型选择的持久化与写读入口。** 唯一 Owner `application/select-session-model.ts`（`command_type='SelectSessionModel'`，复用既有命令回执/幂等/维护准入基础）在短事务内：校验会话属于本 Workspace 且 `ACTIVE` → 纯解析器 `model-selection-resolve.ts` 把请求的模型确定地判为「默认连接 / 目录免费 OpenRouter 项 / 类型化拒绝」→ 解析所选连接的非密钥配置指纹 → 以 `revision` CAS 写 `session_model_selection`（表见[物理设计 §88](../../database/physical-design-postgresql.md)）。`/model <模型名>` 经既有 `POST /assist-sessions/:session_id/chat-commands` 落到该 Owner（命令只落选择与回执，浏览菜单/选中未发送天然零效果，绝不因此发一次模型调用），选择器与本命令共用同一 Owner，只影响该会话后续新请求、**从不改进程默认、从不写 `model_calls`/`runs`**。`GET /assist-sessions/:session_id/model-selection` 只读回显当前选择（无覆盖返回 `selection: null`，前端据此显示「沿用应用默认」）。作用域/鉴权：`httpCommandScopeKey(workspace)`，凭 `workspace_id + session_id` 定位；跨 Workspace 的 session 按不可见处理（`RESOURCE_NOT_FOUND`）。错误：`MODEL_NOT_REGISTERED`(400)、`MODEL_PAID_NOT_AVAILABLE`(409)、`OPENROUTER_CHAT_NOT_WIRED`(409)、`INVALID_TRANSITION`(409，归档会话或 CAS 冲突)、`RESOURCE_NOT_FOUND`(404)、`COMMAND_ID_REUSED`(409)；重放附 `command-replayed` 头并返回原结果（`revision` 不推进），同一 `command_id` 修正内容必须换新 ID。

**旧会话与兼容语义。** 无选择行的旧会话 `readSessionModel` 返回 `undefined`，调用方保留应用默认、不倒造历史选择；归档会话不删选择行（`session_model_selection` 无 `DELETE` 权限），重开可读到原选择并按连接指纹核对是否失效。「仅免费」判定必带完整目录依据（`0089` 依据三列同现同缺 + coupling CHECK）。

**目标协议（本批未接线，下一批以 `0090+` 追加）。** ① OpenRouter 聊天连接的配置解析与实际外呼：本批对命中目录免费项的选择如实拒绝 `OPENROUTER_CHAT_NOT_WIRED`，绝不落一条尚不可兑现的选择，也不预建无当前执行方的连接读取；② Run 创建时写入非密钥模型快照（`runs` 追加 JSONB 快照列），续轮/重试/重启按快照恢复、**不临时读当前会话选择**；③ **所有生成与连接验证入口读取各自冻结约束**（`run-steps`/`delegate-task`/`conversation-execution`/`conversation-state`/`checkers` 五处端口构造点传入对应 `freeGuard`），使「仅免费」选择强制免费准入、过期先刷新、无法核实/下架/所需工具能力未知或不足即拒绝新调用。目录转收费不改原 Run 身份、只在下次调用被原免费限制拒绝；已在途按原 ID 结算，`UNKNOWN` 沿原身份核对不盲重发；401/429/超时/无免费端点/能力不足明确反馈，不自动换付费或其他免费型号、不记免费成功、不把未回传成本补零。这些是下一批的验收落点。

Breaking Change：**No**——`0089` 纯追加一张会话作用域表，既有端点/表/CHECK 不变；`POST /chat-commands` 的 `result` 增加 `MODEL_SELECTION` 判别式（新增 kind、不改既有 `NEW_SESSION`/`STATE_WITHDRAWAL` 结构，客户端按 `kind` 分支）、新增 `GET …/model-selection` 只读端点。`frozen-model-constraint`/`free-call-guard` 与端口第三参数缺省时行为与迁移前逐字一致；选择持久化的当前调用方是 `/model` 与 `GET`，把免费约束接到实际外呼属下一批。

**证据（如实，分层）。** ① 纯解析器（默认命中 / 目录免费 / 收费拒绝 / 目录外拒绝 / 默认优先）与冻结约束/硬限制字段/端口最终体注入由定向单测通过：`model-selection-resolve` **7/7**，C-1 组（`frozen-model-constraint`/`free-call-guard`/`openai-compatible-free-guard` 连既有 `openai-compatible-model-port` 回归）**51/51**，`apps/api` 全量 `tsc --noEmit`（含本批新代码与集成用例）**全绿**。② **已写未跑**：`session-model-selection.integration.test.ts`（默认选择落库与只读回显、同 `command_id` 重放不推进 `revision`、新 `command_id` CAS 递增、仓库层陈旧基线返回 null、跨会话隔离、`OPENROUTER_CHAT_NOT_WIRED`/收费/目录外三类拒绝、归档回滚不留回执、`0089` CHECK 拦截半截写入）。**本轮共享工作树有并行实例、机器非空载，按项目规则未在真实 PG 运行，不计入通过**。③ **未验**：真实 OpenRouter 接受零价硬限制并据此零结算、跨续轮/重启读取持久化 Run 快照、各入口读冻结约束端到端拦截，属需真实凭据与真实 PG 的 FM-06/FM-07 出口；本批无授权凭据、相关端口读接线未实施，**按 §8 不宣称「零收费保证」或「免费分组端到端可用」成立**。


#### 消息模型运行态只读投影（2026-10-17）

`GET /assist-messages/:message_id/model-runtime`：200；**Breaking Change: No**，新增只读端点，既有消息载荷与命令回执不变。同实例 Bearer 与 Workspace 作用域检查仍成立，不存在或其他 Workspace 的消息返回 404。应用查询在一个短只读快照事务中读取原 Assist 消息、冻结策略、候选游标与 `model_calls`，不触发目录同步、生成、切换、结算或业务写入，不维护第二份执行状态。

响应含 `message_id/session_id/message_status`、`snapshot_available`、`preferred_model`、`candidate_models`、`current_candidate_model`、`actual_model`、`max_candidates`、`routing_status/revision`，以及原 `calls`（确切 id/provider/model/status、错误类别、Provider request id、输入输出用量与时间）和 `switches`（原/新型号、原因、作用域与时间）。`actual_model` 取最近调用记录，不能把候选已推进当作 Provider 已成功返回；遗留 STARTED 保持未决。旧消息无快照时 `snapshot_available=false`，不按当前环境倒造首选与候选。

`failure_scope/failure_reason/retry_after_at/free_daily_remaining` 来自持久 `last_failure`：额度为**限流核对时的账户共享日余额**，不是每模型专属余量或实时额度；未知均为 null。用量缺失同样为 null，不因目录免费而补零费用。响应不包含密钥、提示词、工具正文或连接 endpoint。界面只呈现这些事实，相关完成/验收权仍归原 Owner；实际验收成绩只见统一功能验收表。

### 10.84 输入框草稿辅助：自动分点与手动润色（2026-10-16 源码实现）

[工作台 §30](../../frontend/workbench-design/part-10.md#30-输入框自动分点与手动润色) / [后续路线 §11](../../requirements/post-v1-roadmap/part-02.md#11-输入框自动分点与手动润色) 的服务面。草稿辅助是**发送前**的文本整理，不是业务命令：它不建消息、Task、Run、提案或批准，因此**没有** `command_id`、**没有**幂等回执、不写任何业务事实——与 `/model-port/verify` 同一形态，是一次有界、有闸门、可能计费的真实模型调用。

| 端点 | 命令？ | 说明 |
|---|---|---|
| `POST /composer/draft-assist` | 否（非幂等、无回执） | 200，请求体 `{operation: 'OUTLINE' \| 'POLISH', text}`（`text` 1–8192 UTF-16 单元），响应 `{operation, status, item_count, text}`。`status='OUTLINE'` 时 `item_count` 为条目数、`text` 为**程序按原文切片**并加编号换行的建议；`status='POLISH'` 时 `text` 为润色文本、`item_count=null`；`status='NO_SUGGESTION'`（分点边界为空，或草稿不适用自动分点）时两者皆 `null`。 |

**请求只含当前草稿。** 端点不接收也不读取会话历史、项目资料、目录文件或工具声明；`workspace_id` 只作为实例 Bearer 边界与调用证据的 Workspace 归属，不作为业务作用域过滤（与 `GET /model-port` 一致）。草稿整段只作为 `UNTRUSTED_DATA` 放进 user 消息，其中的「执行命令」等内容仍只是待处理文本，不获得任何工具或写权限。

**分点只回位置，不回文本。** `OUTLINE` 的模型输出被限定为 `{"breaks":[整数,...]}`：按 Unicode **码点**计数、0 起、左闭右开。`workflow/composer-draft.ts` 校验 JSON 形状、整数性、范围 `(0, 码点总数)`、严格递增、条目上限与「每段至少含一个非空白字符」，然后按原文切片并只加 `N. ` 前缀与段间换行。因此「去掉程序新增格式后逐字重建原文」是**构造保证**，不是比对结果；畸形边界整条拒绝（502 `COMPOSER_RESPONSE_INVALID`），不显示部分分点，也不用标点正则硬拆。已含换行、行首斜杠命令、短于 8 码点的草稿一律 `NO_SUGGESTION` 且不发起调用。

**润色只回 `{"text": ...}`。** 非 JSON、多余字段、空串或超长一律拒绝（同样 502），**绝不用空结果清空草稿**；调用方保留原文并允许再次点击。

**记账与预算。** 每次真实调用在既有 `model_calls` 账本写一行 `kind='COMPOSER'`（无 Run/会话作用域，不占 Run 或会话预算，见[物理设计 §89](../../database/physical-design-postgresql.md)），准入与 `STARTED` 行同一短事务提交后才外呼；Provider 返回后按 `COMPLETED` 结算并记录真实 `usage`——**协议畸形也记 `COMPLETED`**（那是产品结论，不是 Provider 失败）。传输失败记 `FAILED` 与统一错误分类；取消记 `CANCELLED`。不新建第二套账本、不建占位 Run/Task。

**边界与闸门。** 草稿码点 2–4000（超出 → 400 `COMPOSER_DRAFT_TOO_LONG`）；实例内最小调用间隔 400ms、并发上限 4（超出 → 429 `COMPOSER_RATE_LIMITED`，且**不写账本、不外呼**）。未配置真实 Provider（`RELAY_MODEL_PROVIDER` 缺省/`fake`）→ 409 `MODEL_PORT_NOT_CONFIGURED`；配置残缺 → 409 `MODEL_CONFIG_INVALID`。两者都在开事务之前判定，不留「已开始」的调用证据。辅助失败**不丢草稿、不阻止原发送**：草稿与发送仍沿原输入器与发送 Owner。

Breaking Change：**No**——纯新增一个端点与一个 `model_calls.kind` 取值；旧读取方按 `kind` 过滤时看不到 `COMPOSER` 行，既有端点、表与 CHECK 分支原样保留。

**证据（如实）。** ① 定向单测通过：`composer-draft.test.ts`（文档示例逐字重建、重复句/标点/空白/路径/URL/emoji 保真、畸形边界 9 类拒绝、润色协议与适用性）**10/10**；`composer-draft-port.test.ts`（两条路由登记与模板一致、受控 HTTP 捕获最终发出体证明请求只含草稿且 `response_format=json_object`、无工具声明）**3/3**；`apps/api` 全量 `tsc --noEmit` 通过。② **已写未跑**：`composer-draft-assist.integration.test.ts`（真实 PG：`COMPOSER` 行无作用域且 `COMPLETED`+usage、业务计数前后不变、不适用时不写行、畸形协议仍记 `COMPLETED`、Provider 失败记 `FAILED`、闸门限流不写行、未配置/超长在开事务前拒绝、HTTP 401/409/422）——共享工作树有并行实例、机器非空载，按项目规则未并发运行 `run-integration.ps1`，**不计入通过**。③ 前端：`tests/composerDraftAssist.spec.tsx` **12/12**（停笔才请求、组词零请求、忽略不重复请求、查看/采用/撤销、Esc 与焦点、润色中态与快照撤销、失败保留、迟到隔离与「改回相同文本不复用旧结果」、发送清空、来源变化清空）与 `tests/browser/composerDraftAssist.spec.ts`（真实 Chromium 主路径与在途编辑覆盖）已运行。④ **未验**：真实 Provider 的语义质量样本、真实 Windows 窗口的 IME/DPI 与安装态。

### 10.85 Assist 消息图片附件（2026-10-18 前后端接线）

[工作台 §33](../../frontend/workbench-design/part-12.md#33-输入框粘贴图片与消息附件) 的服务面。粘贴/拖拽进输入框的图片是**会话输入快照**：不是资料（不进 knowledge/memory/decision 版本体系，不占用显式选源 10 条上限），不是 artifact（不受管存储版本目录与防篡改核对语义），也不是幂等业务命令。链路分两阶段：**先传后引**——上传端点落一行不可变暂存，消息命令在同一事务内把附件绑定到新用户消息。

| 端点 | 命令？ | 说明 |
|---|---|---|
| `POST /assist-sessions/{id}/message-attachments` | 否（暂存，无 `command_id`、无回执） | 201，请求体 `{name, media_type, data_base64}`（路由级 `bodyLimit` 4 MiB；`name` 1–200 字符），响应 `{attachment_id, byte_length, content_hash}`。媒体类型白名单 `image/png\|image/jpeg\|image/gif\|image/webp`；原始字节 >0 且 ≤2 MiB。会话必须存在、归属本 Workspace 且 ACTIVE（归档 → 409 `INVALID_TRANSITION`）。不改变任何业务状态，因此不走命令幂等 |
| `GET /assist-sessions/{id}/message-attachments/{attachment_id}` | 否（只读） | 200，`{attachment_id, name, media_type, byte_length, data_base64}`。**2026-10-18 新增**：工作台 §33.3 的历史消息缩略图需要读回内容。归属同时核对 Workspace 与 Session，跨会话/跨 Workspace 一律 404 `RESOURCE_NOT_FOUND`；只读，不改任何业务状态。以 base64 返回而不是二进制：客户端只有一个 JSON 传输形状，不为这条只读路径引入第二套读法 |
| `POST /assist-sessions/{id}/messages` 新增可选 `attachment_ids: [uuid]`（≤4） | `RequestAssistMessage` | 202；`attachment_ids` 进命令载荷幂等摘要，重放按原 ids 核对。用例在同一事务内核对归属（同 Workspace+会话、未被他消息绑定）、去重、每消息 ≤4 张与总量 ≤6 MiB，然后绑定到新用户消息；任何核对失败整体回滚（404 `RESOURCE_NOT_FOUND` / 422 `VALIDATION_FAILED`），绝不部分绑定。**不传该字段时载荷逐字不变**，既有调用与重放零影响 |

**正文可以为空，但只限带图片的讨论轮（2026-10-18）。** `content` 的 schema 由 1–32768 字符放宽为 0–32768，是否真的允许空正文由用例裁决：`attachment_ids` 非空、没有 `skill_ref`、`intent` 为 `DISCUSS`（或缺省）时允许空串（落库 `''`，不是 `NULL`，既有 `content IS NOT NULL` 约束不变）；其余情况仍是 `must not be empty`。理由是「只有图片、没有一句话」本身是正常的输入形态，而 Skill 与提案意图以正文为输入，空正文会产生没有意义载荷。**Breaking Change: No**——只是放宽，旧客户端行为逐字不变。

**消息投影新增 `attachments`。** `GET /assist-sessions/{id}/messages` 每条消息多一个 `attachments: [{id, name, media_type, byte_length}]`（**只有元数据**，不读 `bytea`）。列表是每轮都读的投影，把内容混进去会让一次列表读取变成几 MB；内容按单张经上面的 GET 端点读取。缺字段按「没有附件」读，因此旧服务端的响应仍可解析。

**物理**：迁移 `0093` 建表 `assist_message_attachments`（`bytea` 内容 + `content_hash` + `byte_length=octet_length(content)` CHECK + 类型白名单 CHECK；只授 `SELECT/INSERT/UPDATE`）。选 `bytea` 而非受管存储文件：附件必须与消息同短事务提交，`bytea` 没有「写了文件没写库」的中间态，也无孤儿文件；单用户本机体量由上限约束。详见[数据库设计 §91](../../database/physical-design-postgresql/part-04.md#91-0093-assist-消息图片附件2026-10-16-源码实现)。空正文与读端点都不需要新迁移（`content text` 本就可空、`''` 满足非空约束；读端点只查既有行）。

**模型能力闸门（fail-closed，2026-10-18 补一处空白）。** 当前聊天恒由进程默认连接服务（会话选择→端口接线属阶段 C-2b，落地后应改为读取冻结快照），因此带附件的发送按 `RELAY_MODEL_NAME` 在模型目录里查条目并读 `capabilities.image_input`（10.82 目录同步的三态：true/false/null）。**目录里有条目时目录是唯一准绳**：非 `true` 一律 422 拒绝。**目录里没有条目时**（自建 Provider 不会出现在 OpenRouter 目录里，例如本机 `agnes-3.0-flash`），只有运维显式声明 `RELAY_MODEL_IMAGE_INPUT=true` 才放行；未声明仍按未知拒绝，错误里直接写明这个变量名。声明是运维事实而不是猜测，也不因带图换模型、换连接或悄悄降级为纯文本。

**多模态组装。** 仅**当前消息**的附件以多模态 content parts 交给模型（LangChain 1.x 标准块 `{type:'image', source_type:'base64', data, mimeType}`，图片在前、正文文本收尾）；正文为空时不再追加空的 text 块。历史消息的附件降级为一行文本占位（`（该轮随附图片：…；图片内容不在本轮回放。）`），不冒充模型看得见，也不逐条回放历史图片占上下文。纯文本轮次的请求形状逐字不变。

**边界。** 附件不授予任何读取/执行权限；上传、绑定与读回都在会话作用域内核对，跨会话/跨 Workspace 引用按 404 拒绝。V1 仅支持图片；文本/PDF 等文件类型在上传端点明确拒绝并说明（模型目录的 image 输入是常见能力，文档输入极少支持），后续按需扩展。

Breaking Change：**No**——全新端点与表 + 消息命令新增可选字段；无附件路径的载荷、hash、重放与请求形状逐字不变。

**证据（如实分层）。** 2026-10-16（后端首版）：`apps/api` 全量 `tsc --noEmit` 通过；受影响单测 `model-catalog-pricing` / `openai-compatible-model-port` / `model-catalog-config` / `openai-compatible-free-guard` 合计 **58/58**。当时**未运行/未编写**真实 PG 集成测试与前端规格（前端未接线）。

2026-10-18（本轮回合）：真实 PostgreSQL `assist-message-attachments.integration.test.ts` **5/5**（`run-integration.ps1 -TestFile assist-message-attachments -UseCLocale` 整体 PASSED，临时集群已清理）——覆盖绑定与投影元数据、单张内容读回、跨会话/跨 Workspace 404、空正文例外（无附件/Skill/提案三种拒绝）、能力声明（未声明拒绝且错误里点名 `RELAY_MODEL_IMAGE_INPUT`，声明后通过）、类型/单张/数量/重复引用四类上限、被拒绝的命令不绑定任何行；另有一条 HTTP 面用例核对三个端点的响应形状（上传 201、能力未声明时 422 且错误点名变量、消息列表的 `attachments` 元数据、内容端点的字段名与字节）——它当场抓到了「用例层 camelCase 与响应 schema 的 snake_case 对不上、序列化后字段被丢掉」的投影遗漏。工作台 `tests/composerImageAttachments.spec.tsx` **6/6**（2026-10-19 增补「上传成功但命令被拒时图片留在输入框」用例，现 7/7）。**该轮真实 PG 用例暴露并修掉一个后端缺陷**：`bindAttachments` 的 `UPDATE` 缺 `RETURNING`，驱动只回「命令完成」、`rows` 恒为空，绑定数被读成 0，任何带图消息都会以「附件在作用域内不可见」被拒——这是 0093 落地时没有集成测试的直接后果。**未验**：真实 Provider 的多模态语义质量、真实 Windows 窗口的粘贴/拖拽与 DPI。

### 10.86 目录写入档位投影与只读查询（2026-10-17 源码实现）

本节记录本地目录免手工配置的服务面；产品行为归[工作台 §18.1.4](../../frontend/workbench-design/part-05.md#1814-本地目录权限设置2026-10-18已确认已实施)。用户主动打开并成功关联目录时，应用按原 Owner 建立或复用该根默认只读的基础读取配置；只读 GET、恢复旧会话与模型输出不写权限。改档使用下述命令入口，所有就绪状态仍由原 Gateway 准入事实投影。配置的管理元数据见[数据库 §98](../../database/physical-design-postgresql/part-04.md#98-0109-本地目录访问档位元数据2026-10-18-源码实现)。

**Breaking Change: No**。新增写档位命令端点和迁移 `0109`，并给目录打开/就绪回执增加可选档位字段；旧客户端可忽略新增字段，旧配置与在途命令不重绑。

`GET /api/v1/workspaces/{workspace_id}/projects/{project_id}/managed-resources/{resource_id}/write-readiness`

与打开目录共用同一个投影函数，只读、不建立关联、不创建连接、不放宽任何权限。受管资源不属于该 Workspace/Project 或项目不可见时 404，与既有只读端点一致。

| 字段 | 约束 |
|---|---|
| `status` | 封闭词表：`READY` / `READ_ONLY` / `NEEDS_CONNECTION` / `NEEDS_PERMISSION` / `PERMISSION_DENIED` / `RESOURCE_IDENTITY_UNBOUND` / `RESOURCE_BUSY` / `RESOURCE_DISABLED` |
| `detail` | 中文只读说明，对应上述状态；不是授权凭据 |
| `policy_decision` | 当前命中的 `APPLY_CHANGESET` 条目决策 `AUTO` / `ASK` / `DENY`；没有命中条目时为 `null` |
| `policy_id` / `policy_revision` | 该条目的身份与修订，调整档位时的乐观锁坐标；无条目时为 `null` |
| `policy_target_prefix` | 该条目覆盖的目标前缀。只有它等于当前目录时，客户端才允许在这个目录入口改档；它不等于当前目录说明命中的是上层受管根条目 |
| `write_tier` | `READ_ONLY` / `ASK` / `AUTO` / `FULL`，本目录保存的用户档位；未建立本地档位记录时为 `null`。`AUTO` 与 `FULL` 的 `policy_decision` 相同，界面必须读这一列才能区分两档（2026-10-18 加值） |
| `access_revision` | 本地档位记录的 revision 十进制字符串；无记录时为 `0` |

选择规则与准入**同源**：先按 `FILE_WRITE` × `APPLY_CHANGESET` 列出本项目生效条目，过滤出目标前缀覆盖本目录的条目，再用与动作准入相同的 `rankActivePolicies` 取最严格者（`DENY` > `ASK` > `AUTO`，同档按更长前缀、再按 ID）。界面不自行排序，也不把 `READY` 当作批准。

档位语义为四档（2026-10-18 由三档接续为四档，新增 `FULL`；此前本节记录的「没有完全访问」已被该接续替代）：

| 档位 | 对应事实 | 边界 |
|---|---|---|
| 只读 | 本入口登记的 `READ_ONLY` 档位，生效条目为 `DENY` | 目录只读；不是 `PERMISSION_DENIED`，本入口可再改档 |
| 请求批准 | 生效条目为 `ASK` | 每次应用改动仍单独产生动作审批 |
| 自动批准 | 生效条目为 `AUTO`，`write_tier` 为 `AUTO` | 只覆盖既有范围授权动作；删除、Git 提交/推送与超出本目录仍逐次确认 |
| 完全访问 | 生效条目同为 `AUTO`，`write_tier` 为 `FULL` | 本目录内的新建、修改与删除不再逐次确认；Git、CLI、浏览器、电脑与目录外动作仍按原准入逐次确认 |

`FULL` 不新增第四种 Gateway 判定：网关词表仍是 `AUTO` / `ASK` / `DENY`，排序仍是 `DENY` > `ASK` > `AUTO`（同档按更长前缀、再按 ID）。豁免只在准入处把「本目录档位为 `FULL`」并入「范围已覆盖」这一个条件，因此显式 `DENY`、上层受管根的更严格条目、目录根外目标与没有 FILE_WRITE 连接的目录都不被放宽；该档位必须由准入按 `resource_id` 回读 `local_directory_access`，prepare 与 dispatch 各读一次同一函数，客户端不得在动作请求里传档位。Run 范围授权继续永远不含删除——那是范围授权的边界，与目录档位无关。物理边界与回滚见[数据库 §101](../../database/physical-design-postgresql/part-05.md#101-0112-本地目录完全访问档位2026-10-18-源码实现)。

改档端点：`POST /api/v1/workspaces/{workspace_id}/projects/{project_id}/managed-resources/{resource_id}/local-access`，请求为 `{command_id, expected_revision, write_tier}`，其中 `write_tier` 接受 `READ_ONLY`、`ASK`、`AUTO`、`FULL`。Application 命令 `SetLocalDirectoryWriteTier` 在同一命令事务中按资源根、Project/Workspace 归属和 `expected_revision` 核验后更新档位，返回 `project_id`、`resource_id`、`write_tier` 与新 `revision`。首次执行前核对物理根；已存在回执时仍由命令执行器核对原作用域、命令类型与完整载荷，但精确重放不依赖当前磁盘根。相同 `command_id` 的载荷变化仍按 `COMMAND_ID_REUSED` 拒绝，重放不推进配置 revision。冲突不覆盖更新值。该命令只管理本入口登记的条目；显式 `DENY`、连接停用、上层受管根限制和已有 Gateway 准入规则不能被改档绕过。**Breaking Change: No**（`write_tier` 加值 `FULL` 是兼容新增：既有取值不变、旧行不受影响，旧客户端把未知取值读成「待核对」而不是猜一档；未知取值仍按 422 拒绝）。

`POST /api/v1/workspaces/{workspace_id}/working-directories/open` 的 `write_readiness` 可附带 `write_tier` 与 `access_revision`；这是兼容性新增字段。首次成功的显式目录打开会准备基础读取配置，读取 `GET .../write-readiness`、重开旧会话和恢复请求不写配置。具体结果与未验边界见[统一功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

新增默认读取配置前会查阅既有 Gateway 策略版本中的历史目标；若匹配当前根的范围曾明确配置/撤销且没有当前活动授权，首次目录打开不会另建 AUTO。该查询复用既有策略表和版本，不增加 API 字段或数据库结构；后续明确活动策略仍可按既有 Owner 复用。

2026-10-18 的真实 PG/HTTP 与目录 CRUD 结果、桌面产物及未验证范围只记在[统一功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)；本节定义 API 合同，不把合同本身当作运行证据。

### 10.87 会话未读标记（2026-10-17 源码实现，迁移 0104）

[工作台 §28.1](../../frontend/workbench-design/part-09.md#281-左栏recentworkrail) 左栏会话行菜单「标记为未读／取消未读」的服务面。迁移 `0104_assist_session_unread.sql` 给 `assist_sessions` 只增一列可空 `unread_at`（物理边界见[数据库 §94](../../database/physical-design-postgresql/part-04.md#94-0104-会话未读标记2026-10-17-源码实现)）。它与 0090 的置顶（`pinned_at`）**同一条命令形状**：一条命令两个方向，靠布尔载荷区分，不做两个端点。0090 的改名／置顶／归档／重开从未单独登记为 §10.83，本节只登记 0104，不回溯改写那批端点的语义。

**Breaking Change：No**——新增端点与会话投影的新增只读字段；不读 `unread_at` 的旧客户端行为逐字不变。

| 端点 | 命令类型 | 说明 |
|---|---|---|
| `POST /assist-sessions/{session_id}/unread` | `SetAssistSessionUnread`（body `command_id`、`expected_revision`、`unread`） | 200；回执 `{session_id, unread, unread_at, revision, updated_at}`。同一 `command_id` 重放返回原回执（附 `command-replayed` 头），修订不推进 |
| `GET /assist-sessions/{session_id}`、`GET /assist-sessions` | — | 投影新增只读字段 `unread_at`：`null` = 已读，非空 = 标记未读的时刻；缺字段只来自 0104 之前的响应，客户端同样读成已读 |

**语义边界。** `unread_at` 是**导航标记，不是业务事实**：它不改变标题、状态、项目／任务／目录绑定，不影响能否发消息，也**不参与列表排序**（排序键仍只有置顶与活动序两档，见 §10.91）。标记未读写服务端当前时刻；取消未读写回 `NULL`，表里不留「曾经未读」的第三态——那一次改动留在命令回执里。

**准入与冲突。** 命令走 `runIdempotentCommand`：行锁 + `where revision = expected_revision` CAS + 命令回执。归档会话一律 `INVALID_TRANSITION`（409，`requireEditableSession`）；跨 Workspace 的会话按不可见处理（`RESOURCE_NOT_FOUND`，404）；陈旧基线返回 `REVISION_CONFLICT`（409，带 `conflict.actual_revision`）；同一 `command_id` 换载荷返回 `COMMAND_ID_REUSED`（409）。客户端在 409 时只重读、不换 ID 自动重发（与置顶相同，见工作台 §28.1）。

**本轮不做「点开自动清除」。** 当前只有人工 toggle 一个写入方，同一行的并发由 `revision` 这一道 CAS 裁决；上游 ZCode 的 `unread_at` + `last_unread_at` 双列是为后台自动清除与人工标记的并发准备的，本项目没有那个写入方，复制该机制属提前建设。会话「未读」与消息级「未读资料」不是一回事：后者在本项目仍没有领域状态与写路径。

**证据（如实分层）。** 真实 PostgreSQL：`assist-session-controls.integration.test.ts` **14/14**——覆盖标记写入时刻、取消写回 `NULL`、修订推进且其它事实不变、重放不推进、换载荷 `COMMAND_ID_REUSED`、陈旧基线 409、归档拒绝且不留回执、跨 Workspace 不可见、`0104` 列形状与列表逐字回显、未读不参与排序；`run-integration.ps1 -TestFile assist-session-controls` 整体 PASSED（套件编译、迁移应用与清理 exit0）。工作台：`sessionRowMenu.spec.ts` **10/10**、真实 Chromium 伪造 API 的 `recentWorkRailDensity.spec.ts` **7/7**、`tsc --noEmit` 通过。真实 Windows 窗口与多 DPI 未复验；桌面窗口运行的是暂存 API，实机点到这条命令前需 `-RefreshApi` 重新暂存。

### 10.88 浏览器后端状态（2026-10-17 源码实现，迁移 0106）

F26 浏览器自动化（[浏览器自动化 V1](../../architecture/browser-automation-v1.md)）M2 的唯一只读端点。物理边界归[数据库 §95](../../database/physical-design-postgresql/part-04.md#95-0106-浏览器后端健康投影2026-10-17-源码实现)，规格归[测试计划 §36](../../testing/verification-plan/part-06.md#36-内置浏览器自动化验收规格2026-10-17)。

**Breaking Change：No** —— 全新端点，不改动任何既有响应。

| 端点 | 说明 |
|---|---|
| `GET /workspaces/{workspace_id}/browser/status` | 200，返回浏览器后端（Relay 自有 Chrome 实例 + chrome-devtools-mcp）最近一次被 Worker 实测的健康结论 |

响应形状：`{ status, backend_version, chrome_version, detail, remediation, tool_count, updated_at }`。`status ∈ NOT_STARTED \| READY \| CHROME_MISSING \| BACKEND_MISSING \| INCOMPATIBLE \| DISCONNECTED`。

**语义边界。** 这是**安装级的运行时诊断，不是工作区业务数据**：URL 保留 `workspaces/{workspace_id}` 段只是沿用全站路由前缀，处理器**不读它、不校验工作区存在、不做跨工作区可见性裁剪**——换一个 workspace_id 得到的是同一份结论。它不参与任何准入。`NOT_STARTED` 表示本机从未使用过浏览器能力（表里没有行）；`updated_at` 是「这个结论是什么时候测出来的」，桌面壳据此显示「上次检查于…」。

**事实来源与写方。** 唯一写入方是 Worker 派发路径的 `browserExecute`：每次动作前先 `ensureStarted` 并把结论 upsert 进 `browser_backend_state`（单行 `id=1`）。**上报失败不阻断真实动作**——投影写不进去时动作照常执行，UI 少一次状态刷新属于可感知降级。API 进程只读：它**不会**为了回答这个端点去启动自己的浏览器实例（那会变成两个 Chrome）。不做惰性过期：READY 的后端在 Worker 存活期间一直活着，猜测过期只会制造假阴性；进程真的退出时 Worker 写 `DISCONNECTED`。

**remediation 是可操作建议**：`CHROME_MISSING` → 安装 Chrome 或设置 `RELAY_BROWSER_CHROME_PATH`；`BACKEND_MISSING` → 重装 Relay 或先跑 `fetch-browser-mcp.mjs`；`INCOMPATIBLE` → 更新 Relay；`DISCONNECTED` → 重新执行一次浏览器操作会自动重建。客户端直接展示这句，不自己拼提示。

**证据（如实分层）。** 真实 PostgreSQL：`browser-read.integration.test.ts` **6/6**（`run-integration.ps1 -TestFile browser-read` 整体 PASSED，临时集群已删除）——「BROWSER_READ 全链路成功 + 投影 READY」「按站点收窄（前缀内 PREPARED、前缀外被拒）」「非法目标形状 GATEWAY_TARGET_DENIED」「后端不可用派发失败 + 投影 CHROME_MISSING」「BROWSER_ACTION 无范围授权时 AUTO 降级 WAITING_APPROVAL」「跨进程经 HTTP 读到同一行」。真实 Chrome 链路归 [browser-automation-v1 §12](../../architecture/browser-automation-v1.md)；安装态未验。

### 10.89 浏览器任务列表与停止（2026-10-17 源码实现，迁移 0107）

F26 浏览器自动化 M3 的任务状态面。物理边界归[数据库 §96](../../database/physical-design-postgresql/part-04.md#96-0107-浏览器任务状态2026-10-17-源码实现)，设计归[浏览器自动化 V1](../../architecture/browser-automation-v1.md)。

**Breaking Change：No** —— 两个新端点，不改动任何既有响应。

| 端点 | 说明 |
|---|---|
| `GET /workspaces/{workspace_id}/browser/sessions` | 200：当前工作区内的浏览器任务，按 `updated_at desc`；附带 `idle_ms`（空闲阈值） |
| `POST /workspaces/{workspace_id}/browser/sessions/{owner_kind}/{owner_id}/stop` | 200：`{state, control_request_id}`；`owner_kind ∈ RUN \| SESSION`，`owner_id` 为 uuid |

`GET` 的每行形状：`{owner_kind, owner_id, page_id, url, title, action_type, action_label, state, started_at, updated_at}`。`state ∈ RUNNING | STOP_REQUESTED | STOPPED | 空列表`；`action_label` 是中文动作说明（"导航到新地址"、"点击页面元素"）。

**事实来源与写方。** 唯一写方是 Worker 派发路径：`browserExecute` 之后按**结算结果**里的 `page_id/url/title` upsert 一行（`page_id` 是 `BROWSER_NEW_PAGE` 返回的新页，只有结果里有）。写失败不阻断真实执行。读取方按 `idle_ms` 惰性把长期未刷新的 `RUNNING` 落成 `STOPPED`——Worker 不留后台定时器。**没有 page 的动作**（`browser_list_pages`）不写行：那一步没有"正在操作的页面"。

**停止语义。** 只支持 `RUN` 归属：写入 `STOP_REQUESTED` 并经既有 `run_control_requests` 通道入队一个 `CANCEL`（与 0096 的 Esc 退出同一条路）。幂等：重复停止返回同一结论，并发下别人先停也按已停处理。`SESSION` 归属返回 409 `BROWSER_SESSION_NOT_STOPPABLE`——会话只读轮次没有可取消的 Run，应改用"停止本次回答"，**不静默成功**。未知 owner 或跨工作区按"无可停任务"返回 `STOPPED`，不泄露其它工作区是否存在。

**证据（如实分层）。** 真实 PostgreSQL：`browser-actions.integration.test.ts` **6/6**（与 `browser-read` 合计 12/12，整体 PASSED）——授权覆盖后 AUTO 派发并写入状态行（owner/page/action_label 逐字段核对）、`BROWSER_COMMIT` 不被范围授权覆盖、提交类点击升级为 `WAITING_APPROVAL` 且审批文案说明"这是提交类动作"、普通链接点击不升级、跨进程经 HTTP 读到同一行并成功 stop（`STOP_REQUESTED` + 控制请求 id）、停止未知任务是幂等空操作。真实 Windows 窗口与安装态未验。

### 10.90 电脑控制状态与退出（2026-10-18 修复）

工作区前缀为 `/api/v1/workspaces/{workspace_id}`，沿用本机 API 鉴权。**Breaking Change: No**，不改变响应字段；修正重复退出误报 STOPPED、投影与取消入队非原子，以及领域错误误报 500 的缺陷。

- `GET /computer/control-session`：`Cache-Control: no-store`，返回 `{state, action_type, action_label, run_id, started_at, updated_at}`。状态为 RUNNING/STOP_REQUESTED/STOPPED；行缺失、已停止或属于其他工作区时返回 STOPPED，附属字段为 null。
- `POST /computer/control-session/cancel`：返回 `{state, control_request_id}`。活动 Run 的 CANCEL 意图与 STOP_REQUESTED 投影在应用用例同一事务提交。重复请求在确认前仍返回 STOP_REQUESTED，不能提前显示已停止；已停止或跨工作区为幂等 STOPPED。已有同类 CANCEL 复用原请求，冲突的其它控制与无效 Run 返回既有领域错误，不把所有 409 当作取消成功。入队失败时不保留虚假的 STOP_REQUESTED。

取消事务还须以 `id=1`、相同 `run_id`、状态为 RUNNING/STOP_REQUESTED 做 CAS；旧快照已被另一 Run 替换时返回 `409 INVALID_TRANSITION`，新入队的 CANCEL 随事务回滚。调用方应重读，不自动把原请求改投新 Run。

退出等待复用 Run 的控制安全点：在途 Worker/Invocation 或未知效果未处理前不宣称停止；安全点应用控制后，状态投影才写 STOPPED。此投影不替代执行权、审批或外部动作账本。权限迁移与兼容边界见[数据库 §99](../../database/physical-design-postgresql/part-04.md#99-0110-电脑控制状态的应用角色权限2026-10-18)，回归入口为 `computer-control.integration.test.ts`，实际成绩归统一验收表。

### 10.59 生成中预览的 SSE 推送（2026-10-18 源码实现）

**Breaking Change: No（新增只读端点；§10.38/§10.39 的 GET 保留为权威快照与降级路径）。** 为把「生成中草稿」的逐段到达从客户端轮询改为服务端推送，新增两个只读 SSE 端点：

| 端点 | 事件名 | 帧体 |
|---|---|---|
| `GET /api/v1/workspaces/{workspace_id}/runs/{run_id}/draft-preview/events` | `draft_preview` | 与 §10.39 GET 完全相同的 DTO |
| `GET /api/v1/workspaces/{workspace_id}/assist-sessions/{session_id}/messages/{message_id}/live-preview/events` | `assist_preview` | 与 §10.38 GET 完全相同的 DTO |

两个端点沿用现有 Bearer 与 Workspace 鉴权，返回 `200`、`content-type: text/event-stream; charset=utf-8`、`cache-control: no-cache, no-transform`、`x-content-type-options: nosniff`、`x-accel-buffering: no`。不存在、跨 Workspace 或不可见资源在流升级前按 404 `RESOURCE_NOT_FOUND` 返回；缺失/错误 Bearer 返回 401；这两类失败不会打开 SSE。

**帧体是本端点与 run_events 的关键差异。** §10.17 的 `run_hint` 只携带「该刷新了」的提示；本端点专用于预览，`data:` 就是与 GET 同形的完整对象（含 `preview_text`），`id:` 是该帧的 `preview_revision`。它不新增授权口径：**每一帧的文本都来自一次完整的重新授权读取**（与 §10.38/§10.39 GET 同一函数、同一次来源可见性/manifest/租约核对），连接建立或 `id` 都不携带权限。主键快查只作为「是否有变化」的节流信号，不承载正文、不授权。

**游标与去重。** 本端点不声明 `after`、不读取 `Last-Event-ID`，也不对 `id` 做连续性断言：Run DRAFT 的 `preview_revision` 只在同一 `(run, model_call)` 世代内单调，换 Attempt/模型调用时重置为 `1` 且旧行被删；Assist 侧 `message_id` 即身份。连接建立即推送当前完整快照，断线重连天然得到当前状态。客户端必须按身份 + `preview_revision` 去重：Run 的身份为 `(step_attempt_id, attempt_claim_epoch, model_call_id)`，Assist 的身份为 `message_id`。

**终态与关闭。** Run 侧在 `run_status` 为 `COMPLETED`/`FAILED`/`CANCELLED` 的帧后由服务端 `end()`；`PAUSED`、换 Attempt 的间隙、首片段前的 `preview_available=true, preview_text=null` 都保持连接，只推新身份帧。Assist 侧在消息状态非 `PENDING`/`RUNNING` 的帧后关闭。流打开后资源变为不可见（租约失效、来源撤销、连接/策略/资源停用）是正常的「不再可见」，服务端结束连接而不发正文；客户端重连时由流升级前的路径拿到 404 再停。空闲每约 15 秒发无 `id` 的注释心跳；背压沿用 §10.17 的 drain 超时与慢连接关闭语义。

**与轮询的关系。** §10.38/§10.39 的 GET 端点保留：它们是权威快照读取，也是本端点不可用（反代缓冲、连接失败、旧客户端）时的降级路径。服务端约有 200ms 的变化检测轮询（低于客户端原 400ms 轮询）；最坏端到端延迟约为 100ms 生成侧 flush + 200ms 检测 + 一次重新授权读取。两条链路都只证明「正在生成的临时前缀」，都不是 Artifact、验证 PASS 或任务完成。

**证据（如实分层）。** 回归入口：后端单元 `preview-events-api.test.ts`（probe key 的身份/重置语义、帧格式与终态判定）、真实 PG/HTTP 集成 `preview-events.integration.test.ts`（首帧等于 GET DTO、多帧 revision 递增、终态帧后关流、跨 Workspace 404、断线重连）；前端工作台定向用例覆盖 SSE 帧消费与 GET 降级。真实 Provider 首字延迟与桌面体验仍需单独测量；实际成绩归[统一验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

### 10.91 会话列表的活动排序键（2026-10-18 源码实现，迁移 0111）

工作区前缀为 `/api/v1/workspaces/{workspace_id}`。**Breaking Change：No**——没有新命令、没有新端点，只给既有会话投影加只读字段（`last_message_at` 可空、`has_messages` 为读时派生布尔），并改掉 `GET /assist-sessions` 那一列的默认顺序。迁移与写入 Owner 见[数据库 §100](../../database/physical-design-postgresql/part-05.md#100-0111-会话活动排序键2026-10-18-源码实现)，界面读法见[工作台 §28.1](../../frontend/workbench-design/part-09.md#281-左栏recentworkrail)。

| 端点 | 变化 | 说明 |
|---|---|---|
| `GET /assist-sessions`、`GET /assist-sessions/{session_id}` | 投影新增只读字段 `last_message_at` | 逐字回显活动时刻（ISO 8601）或 `null`。**`null ⇔ 没有消息` 这个语义 2026-10-24 才真正成立**：0111 不回填，0111 之前就已有消息的旧行原本也是 `null`，由迁移 0135 按消息真实时刻补齐（见[数据库 §112](../../database/physical-design-postgresql/part-05.md#112-0135-会话活动键回填2026-10-24缺陷修复)）。活动键自 2026-10-24 起**只用于排序**；界面的「有没有消息」改读下面的 `has_messages` |
| `GET /assist-sessions`、`GET /assist-sessions/{session_id}` | 投影新增只读字段 `has_messages`（2026-10-24） | **读时派生**，不是表列：`exists(select 1 from assist_messages m where m.session_id = s.id)`。列表在查询中逐行附带，单条读取单独派生一次。界面「未开始」标记与分叉入口只读这一枚事实，不从 `last_message_at` 的可空性推断——活动键漏推进时最坏只影响排序，不会再把有正文的会话说成空会话。缺字段只来自尚未提供该字段的旧服务端，客户端按活动键回落一次 |
| `GET /assist-sessions` | 列表顺序 | `order by pinned_at desc nulls last, coalesce(last_message_at, created_at) desc, id desc` |
| `POST .../title`、`/pin`、`/archive`、`/reopen`、`/unread` | 无 | 命令体与回执字段都不变，回执里**不**带 `last_message_at`／`has_messages` |

**排序口径。** 活动序＝这段讨论最近一次真正说过话是什么时候，不分发送方：用户消息落库与 AI 生成结算都算一次活动，所以失败或取消的那一轮同样上浮。置顶仍是第一排序键，活动序只在未置顶的组内生效；`coalesce` 让还没开口的会话按创建时间留在原位，不会因为新列为空而沉底。这是**导航排序键，不是业务事实**，与 0090 的 `pinned_at`、0104 的 `unread_at` 同性质，不参与任何准入判定。

**不推进 `revision` 与 `updated_at`——这是本节的硬约束。** 会话行的修订号是上面那组人工控制命令的 CAS 基线。若消息写入也推进修订，在途生成期间发出的改名／置顶会稳定吃到 `REVISION_CONFLICT`（409），界面只能反复重读；若推进 `updated_at`，「只是重命名过一次」与「刚说过话」在响应里就分不开。因此发送消息与生成 Worker 的结算都不改这两列，集成测试把它们逐字锁住。同理，`assist_message_previews` 的流式增量帧不推进本字段：临时前缀每帧都动会让左栏在生成期间持续跳位。

**迟到写入不推进。** 生成结算按 `(message_id, worker_id, status='RUNNING')` CAS；迟到的旧 Worker 结算既不收敛消息状态，也不 touch 会话排序键。排序键取单调最大值，时钟或提交顺序倒挂都不会把它拉回。

**已知缺口（如实）。** 本字段只在列表与单会话读取时返回；左栏当前没有轮询或事件订阅，AI 说完那一刻不会自己跳位，要等下一次整列重读或该行发起命令后的定向重读才收敛。§10.17 的 `run_hint` 类提示没有为本字段扩展，见工作台 §28.1 与统一验收表的剩余限制列。

