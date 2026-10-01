# Personal Workflow OS：HTTP、应用命令与错误契约

> 2026-09-28 协作控制增量：新增 Artifact 原文锁定、手动影响检查/逐目标候选，以及人工介入提醒投影与投递回执；具体路径、状态与已验边界见[开发记录](../development/collaboration-controls-2026-09-28.md)。Breaking Change：**否**（仅新增端点，既有请求/响应未删改）。通知 claim/settle 是可去重的投递回执，不改变 Task/Run/Review 业务状态；同一事项/变化由数据库唯一键保证不重复认领。

> 2026-09-24 技术改造状态：当前已实现接口仍以下文第 10 节与代码为准。M03 SSE、Review/RESUME 顺序、固定图及 Mock Gateway 工具动作已分别通过列明范围的独立分片验收；完整 G01–G08 待验。Idempotency-Key 若引入，需明确与 command_id 的唯一身份、载荷冲突和旧客户端兼容；不得开无鉴权别名。真实 Provider 仍关闭。

日期：2026-09-19。设计正文状态：Proposed；实际已实现范围与阶段边界见第 10 节。依据：[四份业务契约](../../contracts/README.md)、[领域模型](../architecture/domain-model.md)、[物理设计](../database/physical-design-postgresql.md)。

Breaking Change：设计正文仍待与实际 API 实现对照。当前三份原件没有已发布接口契约；已实现的 `SET_PHASE` 行为收紧见第 10.3 节（Breaking Change：是，但工程尚未发布）。本文的 /api/v1 是建议命名，不表示已发布版本。

## 1. 协议边界

公开 HTTP API 面向用户工作台；Agent、Worker、Verifier 通过所在进程中的应用端口调用。API/Worker 分进程时共享应用代码与数据库协议，不共享进程内事务对象。不得为了接口“统一”公开可任意写入 check_result、epoch、Run 状态或工具调用结果的 HTTP 入口。

统一前缀：`/api/v1/workspaces/{workspace_id}`，下表简写为 W。所有对象必须属于该 Workspace；跨作用域 ID 按不可见对象处理。V1 不引入多租户成员系统。

- JSON 字段 snake_case；ID 是 UUID 字符串；revision、epoch、acceptance_revision 在 JSON 中使用十进制字符串，避免客户端整数精度差异。
- 时间点采用带 Z 的 ISO 8601 UTC 字符串；Later 日期另带用户时区。
- 命令请求拒绝未知字段，不接受客户端声明的 actor、权限结果、完成状态、服务器文件路径或数据库实体。
- 普通 GET 不改变事实。获取产物内容使用受授权下载接口，不暴露宿主绝对路径。
- 列表默认 limit=50、最大 100，返回 items / next_cursor；游标绑定过滤条件与稳定排序键，非法游标返回 400。排序列表不承诺跨请求快照；需要精确执行依据时使用版本绑定。

HTTP 状态的使用依据 [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html)：201 表示创建资源，200 表示已完成当前命令，202 表示已接受但工作尚未完成。下面的领域错误、回执与 revision 规则是本项目约定。

## 2. 命令身份、并发与回执

所有改变事实的请求必须带 command_id。服务端以（Workspace、当前用户）作为 scope，以 command_id 唯一；动作类型、路径目标、规范化 body 均进入 payload_hash。command_id 本身、请求追踪 ID 不进入摘要。

处理顺序：鉴权/作用域 → 请求结构解析 → 查同 ID 回执并核对摘要 → 首次请求才检查 expected_revision → 业务校验/短事务 → 回执与事实同事务提交 → 响应。

相同 ID、相同内容返回原成功回执和原 HTTP 成功码，即使当前 revision 已变化；不会重复执行。相同 ID、不同内容返回 409 COMMAND_ID_REUSED。并发首次请求由唯一约束与业务锁裁决，失败事务回滚后读取胜出回执。

此设计使用 body 中的 expected_revision / expected_task_revision / expected_run_revision，不混用 If-Match。缺失必需版本返回 422，版本不匹配返回 409 REVISION_CONFLICT。首次失败而没有业务提交的请求不写成功回执；修正内容必须换 command_id。提交结果不确定时先查询回执或原样重试，不能自动换 ID。

成功响应统一为：

```json
{
  "command_id": "d6d3bf2e-445e-4d22-85d6-1c1a5a38e101",
  "committed_at": "2026-09-19T02:00:00Z",
  "result": {
    "task_id": "d6d3bf2e-445e-4d22-85d6-1c1a5a38e102",
    "revision": "1"
  },
  "links": {
    "resource": "/api/v1/workspaces/{workspace_id}/tasks/{task_id}"
  }
}
```

示例 links 中的花括号仅为文档缩写，实际响应必须是可请求的具体路径。GET W/commands/{command_id} 返回同一回执，不新增一个通用后台 Operation 状态机。回执不存在返回 404 COMMAND_NOT_FOUND，但不能据此判断一个仍在事务中的请求永远未提交；原样重试仍是安全路径。

重放可附本项目自定义响应头 `Command-Replayed: true`，当前请求追踪 ID 通过 `X-Request-Id` 返回。回执保存当时结果，不伪装成当前资源快照；当前状态总是 GET resource。回执默认保留，未来清理须定义重放窗口，不能静默删除后让同 ID 再执行。

## 3. 第一条人工闭环 API

所有 POST/PATCH 都含 command_id；下表只列额外输入。更新型命令只能更改列出的字段。

| HTTP（前缀 W） | 应用命令 / 主要输入 | 成功结果 |
|---|---|---|
| POST /projects | CreateProject：title、project_type | 201，project_id、revision；同时建立 State |
| GET /projects/{id} | ReadProject | 200，项目属性及 revision |
| POST /tasks | CreateTask：project_id?、title、objective、criteria、expected_outputs | 201，Task ID、revision、acceptance_revision；初始 INBOX、HUMAN |
| GET /tasks/{id} | ReadTask | 200，Task 事实投影，见 §6 |
| GET /tasks?project_id=… | ListTasks | 200，items / next_cursor；无 Project 使用 inbox=true，禁止含糊的空字符串 |
| PATCH /tasks/{id} | EditTaskPresentation：expected_revision、title | 200，新 revision；不能改 status、owner、验收 |
| POST /tasks/{id}/ready | MarkTaskReady：expected_revision | 200，READY；校验任务目标和前置依赖，不自动启动 |
| POST /tasks/{id}/start | StartHumanTask：expected_revision | 200，IN_PROGRESS、HUMAN；仅 READY 且无 AI 占有者 |
| POST /tasks/{id}/artifacts | CreateArtifactWithVersion：expected_task_revision、title、content、media_type | 201，artifact_id、artifact_revision、version_id、sha256 |
| GET /tasks/{id}/artifacts | ListTaskArtifacts | 200，所属 Task 的不可变版本清单与当前完成凭据接受的版本 ID；不含正文 |
| POST /artifacts/{id}/versions | SubmitHumanArtifactVersion：expected_artifact_revision、expected_task_revision、content、media_type | 201，新版本，旧版本不覆盖 |
| GET /artifacts/{id} | ReadArtifact | 200，逻辑信息、revision、最新版本摘要；不隐含选为验收对象 |
| GET /artifact-versions/{id}/content | ReadArtifactContent | 200，确切版本内容；缺失返回证据不可用 |
| POST /tasks/{id}/complete | CompleteHumanTask：expected_revision、acceptance_revision、artifact_version_ids、acceptance | 200，CompletionRecord ID、Task revision/status |
| POST /tasks/{id}/reopen | ReopenTask：expected_revision、reason | 200，READY、新验收版本；历史凭据保留，并使所属 Project State revision 失效 |
| POST /tasks/{id}/cancel | CancelTask：expected_task_revision、expected_run_revision? | HUMAN 且非终态时 200/CANCELLED；AI 占有时 202，创建 CANCEL_TASK 控制请求 |

初始切片只允许 text/markdown，content 是 UTF-8 文本，正文最多 256 KiB；超限 413。大小是本版产品限制，不是 HTTP 标准。服务端生成路径和 hash，内容保存后才登记元数据；人工上传也需当前 HUMAN 执行权，无权限时不能靠换 Artifact 绕过。两个保存入口只允许 IN_PROGRESS 的人工任务。取消已完成 Task 必须先重开，取消命令不能抹去完成凭据；对已 CANCELLED 的新命令返回 INVALID_TRANSITION，原命令仍可重放。

CreateTask 在未绑定 Project 时只允许人工事项；未具备必要条件仍可作为 INBOX 保存，但 ready 命令不得通过。required criterion 至少含稳定 criterion_id、statement、required、method、target；初始人工切片的 method 只开放 HUMAN。具备目标的 Task 不自动从 INBOX 跳到执行。

人工接受示例：

```json
{
  "command_id": "d6d3bf2e-445e-4d22-85d6-1c1a5a38e103",
  "expected_revision": "3",
  "acceptance_revision": "1",
  "artifact_version_ids": ["d6d3bf2e-445e-4d22-85d6-1c1a5a38e104"],
  "acceptance": {
    "statement": "已核对摘要与引用，同意完成本轮任务",
    "accepted_criterion_ids": ["summary-reviewed"]
  }
}
```

服务端生成 human_acceptances，不能由前端直接传任意 acceptance_record_id 当成证明。仅允许 HUMAN 且 IN_PROGRESS、匹配当前验收版本、所有 required HUMAN 项获确认；已有 HARD 约束仍须满足，不能用人工声明覆盖。无产物要求的事项允许空 artifact_version_ids；有产物要求则核对种类与完整集合。

完成所接受的是明确版本，不因出现更新版本就暗中替换。若任务要求“当前选用版本”，完成时必须核对选择绑定。人工完成也通过统一完成事务，不伪造 Run 或 Verification PASS。

## 4. Delegate、Review、控制与恢复

下表包含已实现与后续接口，实际开放状态见本节末尾的分期实现记录。用户入口不能提交 worker claim 或手动设置 Run 状态。

| HTTP（前缀 W） | 输入 / 用例 | 成功及边界 |
|---|---|---|
| POST /tasks/{id}/delegations | expected_task_revision、workflow_version_id、execution_config_version_id、retry_of_run_id? | 202，run_id、task_revision、run_revision、status=CREATED；已原子获得执行权，不代表工作已完成 |
| GET /runs/{id} | ReadRun | 200，状态、等待原因、控制请求、结果引用 |
| POST /runs/{id}/control-requests | expected_task_revision、expected_run_revision、type、supersedes_request_id? | 202，control_request_id、status=PENDING；type 为 PAUSE/CANCEL/HANDOFF/CANCEL_TASK |
| GET /runs/{id}/control-requests/{request_id} | ReadControlRequest | 200，PENDING/APPLIED/REJECTED/SUPERSEDED 及依据 |
| POST /runs/{id}/resume | expected_task_revision、expected_run_revision | 202，恢复到暂停前保存的 CONTEXT_BUILDING/PLANNING/RUNNING/VERIFYING/RETRYING/WAITING_APPROVAL 阶段；不跳过未知动作或未决控制 |
| GET /runs/{id}/reviews | ListReviews | 200，绑定对象、允许决定和阻塞信息 |
| GET /reviews?status=OPEN | ListInboxReviews | 200，当前待判断请求；`DECIDED`/`EXPIRED` 可单独查询历史 |
| GET /reviews/{id} | ReadReview | 200，revision、类型化目标、可检查的影响/差异、有效性 |
| POST /reviews/{id}/decisions | expected_revision、decision、feedback?、target_hash、明确的新预算（适用时） | 200，decision_id、effect、资源链接；外部执行仍可未发生 |
| POST /tasks/{id}/acceptance-revisions | expected_task_revision、expected_run_revision?、objective、criteria、expected_outputs | 无活动 Run 时 201；有活动 Run 时 202，返回新验收版本与持久控制请求；不转交执行权 |
| GET /runs/{id}/operations | ReadOperations | 200，动作、调用、UNKNOWN 与核对依据；不允许前端把状态改成功 |
| GET /verifications/{id} | ReadVerification | 200，绑定集合、检查状态、总决策和适用性；未决总决策可为 null |

Delegate 限 READY 且 HUMAN、有唯一 Project、有效依赖及明确执行作用域。AI 失败或停止后可重新 Delegate；手动重试提供原终态 retry_of_run_id，并创建新 Run。PAUSED/WAITING_APPROVAL 的旧 Run 仍占有执行权，不能新建并发 Delegate。

Stop AI 对应 CANCEL；取消整个 Task 对应 CANCEL_TASK；接手编辑对应 HANDOFF。用户主动控制先返回 202/PENDING，哪怕后台很快处理，也只通过查询显示实际结果。终态 Run 收到新控制意图返回 409 RUN_TERMINAL 并附当前状态；已存在的同 ID 请求仍按回执重放。

实质验收变化对活动 Run 创建 CANCEL 控制意图（应用事务内），按旧 Run 安全停止后才可重新 Delegate；这明确选择契约允许的保守停止路径。存在冲突控制意图则整笔命令 409，不出现验收已改、控制未登记的半完成状态。

Review decision 按 kind 限制：动作授权只接受 APPROVE/DENY；产物/人工项接受 ACCEPT/REQUEST_CHANGES；预算选择使用明确的 SET_RETRY_BUDGET 数值；检查器耗尽后只允许显式 RETRY_CHECKS。不得用任意字符串或自然语言驱动回调。具体 reason 决定 allowed_decisions，服务端重新校验；UI 只用于提示。REQUEST_CHANGES 仅在原验收契约下修正，改变目标需创建新验收版本。

UNKNOWN 的核对由适配器/受限恢复用例产生证据；V1 没有“忽略未知并继续”“强制完成”端点。用户需要接手时请求 HANDOFF，若无法证明安全则持续展示阻塞原因。Review 接受不等于 Handoff。

## 5. Project State 与内部应用端口

GET W/projects/{id}/state 返回 State 自身 revision 及 dependency_versions，包含被投影 Task/Decision/Artifact 的版本依据。State revision 相同不意味着聚合页面所有内容未变化。

POST W/projects/{id}/state-commands 输入 command_id、expected_revision 和一个类型化 action：SET_PHASE、SET_NEXT_ACTION、SELECT_ARTIFACT_VERSION、ADD_CONFIRMED_RISK、RESOLVE_BLOCKER。各 action 有固定参数结构和来源绑定；客户端不能任意替换 ProjectState JSON。AI 提案另经用户明确接受及当前版本复核，不能将模型输出直接转发到此入口当作人工确认。

内部端口仍是应用用例，不是公开 HTTP：

| 端口 | 必需可信输入 | 不能越权执行 |
|---|---|---|
| AdvanceStep / SubmitArtifact | run_id、Task ownership_epoch、worker claim_epoch、确切尝试/产物来源 | 迟到结果不能推进 Run；不能直接写 Task DONE |
| PrepareInvocation / AdmitInvocation | 动作身份、当前权限/批准/资源绑定 | 不信任前端提供 ALLOW；网络调用在事务外 |
| RecordInvocationOutcome | invocation_id、适配器来源、证据 | 过期结果仅用于核对，不授予新执行权 |
| RecordCheckResult | session/criterion/attempt、版本绑定、可信 Checker 身份、证据 | Worker 不可改基准或自己宣布 PASS |
| RequestCompletion | 当前 Run/epoch、验证依据、幂等命令身份 | 重核全部前提；不能用已有 PASS 跳过控制/UNKNOWN |
| ApplySafeControl | 持久请求、无在途写入的证据 | 请求接受不等于安全点已到达 |

这些身份从服务端调度/适配器上下文提供，用户 JSON 不允许冒充内部调用。

## 6. 查询投影与异步 UI

Task 查询至少返回 id、project_id?、status、mode、revision、acceptance_revision、executor（kind、run_id?、ownership_epoch）、current_completion_id?、waiting_reason?、allowed_actions。mode 及显式切换见[运行设计](../architecture/runtime-context.md)。Run 查询返回 id、status、revision、current_step、wait_reason、pending_control_request、blocking_review_ids、unresolved_operation_ids、result_refs。

allowed_actions 是当前事实下的 UI 提示，不是授权凭证；点击后仍需完整校验。所有查询均以安全的只读模型输出，不暴露 Connection/SDK 私有消息或可写 ORM 对象。

第一版使用轮询：执行中默认约 2 秒一次，空闲逐步退避，终态停止；用户重新聚焦页面时刷新。轮询频率是客户端建议，不是正确性前提。响应携带 revision/依赖版本，客户端不得让较旧响应覆盖新状态。

阶段 A 保留轮询；M03 的已实现 SSE 后端片见第 10.17 节，不引入 WebSocket 或另一套可靠业务消息。模型 token 流是临时展示，业务通知只能在提交后发送，断流后通过 GET 重建持久状态，不能从 token 判断 Task 完成。SSE 沿用 Bearer/作用域校验，不将令牌放 URL。

本段桌面交付形态调整的 Breaking Change：No，未修改既有端点、请求/响应字段和权限；不包括第 10.3 节已记录的 `SET_PHASE` 行为收紧。SSE 仍为后续设计项，不是已发布接口。

UI 必须区分“暂停请求已提交”与“已暂停”、“批准已保存”与“动作已执行”、“验证通过”与“任务已完成”。202 回执一直代表接受时刻，最新状态从返回的资源链接获取。

## 7. 错误结构与重试语义

2026-10-01 Windows 内容发布安全点：API请求/响应字段不变，Breaking Change: No。受管内容排他维护、缺失/旧原生助手或物理发布失败沿既有503 `STORAGE_UNAVAILABLE`；原回执重放不再写文件。没有公开内容冻结 HTTP 开关或导入 OS 证明的接口；CLI边界见[部署说明](../deployment/本机部署.md#windows-受管内容发布安全点)。失败不能换 command/operation ID绕过核对。

采用 [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457.html) 的 application/problem+json，并增加 code、request_id、command_id?、field_errors?、conflict?、retryable、retry_action。type 使用稳定 URI 引用，例如 `/problems/revision-conflict`；这些 URI 的说明纳入后续 OpenAPI。

```json
{
  "type": "/problems/revision-conflict",
  "title": "资源版本已变化",
  "status": 409,
  "detail": "任务已被其他操作更新，请刷新后重新决定。",
  "instance": "/requests/req-8af2",
  "code": "REVISION_CONFLICT",
  "request_id": "req-8af2",
  "command_id": "d6d3bf2e-445e-4d22-85d6-1c1a5a38e103",
  "conflict": {"entity_type": "TASK", "expected_revision": "3", "actual_revision": "4"},
  "retryable": false,
  "retry_action": "REFRESH_AND_REDECIDE"
}
```

| HTTP | code | 客户端处理 |
|---|---|---|
| 400 | MALFORMED_REQUEST / INVALID_CURSOR | 修正解析错误 |
| 401 / 403 | AUTH_REQUIRED / PERMISSION_DENIED | 建立有效身份或停止操作；不得重试绕过 |
| 404 | RESOURCE_NOT_FOUND / COMMAND_NOT_FOUND | 资源不可见或回执未找到；后者不证明无在途请求 |
| 409 | REVISION_CONFLICT / COMMAND_ID_REUSED | 刷新并重新决定，或纠正命令 ID 使用错误 |
| 409 | EXECUTOR_CONFLICT / RUN_TERMINAL / CONTROL_PENDING / CONTROL_CONFLICT / UNKNOWN_ACTION_BLOCKED | 读取当前执行者、控制请求与动作核对状态，不并行启动 |
| 409 | ACCEPTANCE_STALE / REVIEW_TARGET_CHANGED / REVIEW_EXPIRED | 重新取得有效契约或审批，不沿用旧批准 |
| 409 | RESOURCE_BUSY / RECONCILIATION_REQUIRED | 等待或查看核对信息，不把它作为任意自动重试 |
| 409 | INVALID_TRANSITION / REQUIRED_REVIEW_PENDING / VERIFICATION_NOT_VALID | 当前事实不满足操作，展示明确原因 |
| 413 / 415 | CONTENT_TOO_LARGE / UNSUPPORTED_MEDIA_TYPE | 调整受支持内容 |
| 422 | VALIDATION_FAILED / REQUIRED_INPUT_MISSING | 合法 JSON 但字段/条件缺失；field_errors 指向字段 |
| 503 | STORAGE_UNAVAILABLE / DATABASE_UNAVAILABLE / SCHEMA_UNAVAILABLE / EVIDENCE_UNAVAILABLE | 检查 command receipt；安全的原样重试，不生成新命令 |
| 503 | MAINTENANCE_DRAINING / MAINTENANCE_UNAVAILABLE | 暂停新操作；保持输入和原命令，核对回执，待恢复准入或状态可确认后原样重试；不推断在途工作已停止 |
| 500 | INTERNAL_ERROR | 不泄漏堆栈/SQL/凭据；提交结果不明时先查询回执 |

retryable 仅表示是否允许原样重试当前命令，不是承诺会成功，也不授权重新执行外部动作。retry_action 取 NONE、REFRESH_AND_REDECIDE、POLL_RESOURCE、CHECK_RECEIPT_THEN_RETRY。依赖数据库不可用时回执查询也可能失败，客户端保留原 command_id 等待恢复。

错误不包含隐私正文、宿主绝对路径、SQL、密钥或完整模型上下文。日志用 request_id/command_id/领域 ID 关联必要证据。

2026-09-30 M07 新工作准入门：**Breaking Change: No。** 原请求、回执及读接口形状不变；新增上述两类 typed 503，`retry_action=CHECK_RECEIPT_THEN_RETRY`。数据库 DRAINING 拒绝首次业务命令（包括自定义 Assist/Blueprint 接受），旧同内容回执仍可读/重放、异内容仍为 `COMMAND_ID_REUSED`；固定停止/取消和有原停机证明的部分文件写入安全终结保留既有准入规则。`POST /model-port/verify` 的新探针预约同样受准入门约束，被拒时不写调用记录或外呼；已经预约的原探针可结算，查询验证状态不受挡。不是全部写入冻结，不新增 HTTP 维护开关，不改变 readiness 的 schema 含义。受信 CLI、锁序和未实现出口见[部署说明](../deployment/本机部署.md#draining-新工作准入门)。

## 8. 本机 API 的最低边界

开发 API 绑定 loopback，使用外部注入的随机 Bearer 凭据；不硬编码或写进示例配置。所有读写与下载校验凭据和作用域。前端来源采用明确允许列表，不能因“本机”就允许任意网页调用；禁止在 URL query 中传令牌。

完整 V1 为 Windows 可安装应用。桌面壳经受控启动握手向受信窗口交付当前 loopback 端点与短期 Bearer，前端仅保存在内存；重载后通过窄 IPC 重新获取当前实例信息，服务重启轮换凭据。DB/Provider 密钥不交前端，领域命令不另走 IPC。实际生产 WebView Origin、CORS/CSP、实例验证和停机边界见[部署设计](../deployment/本机部署.md)及 [ADR-007](../decisions/ADR-007-windows-desktop.md)。不开放 Cookie 会话、匿名业务 API 或远程访问。

此次交付形态调整的业务 API Breaking Change：No；路径、DTO、command_id、回执和权限语义不变。变化的是尚未发布的启动与凭据交付方案；不能沿用“用户手填 token、刷新重连”的旧部署说明。

## 9. 验收及下一步

协议测试覆盖：同命令重放、改 body 复用 ID、两个不同命令并发完成、版本冲突、202 后刷新、旧回执不覆盖新事实、审批过期、停止与完成两个提交次序、未知动作不可跳过、人工空产物条件、越权路径与输入字段拒绝。业务结果仍映射 A01–D11。

第 1–8 节保留目标协议；当前已开放的 API、开发自检与尚未实现项以第 10 节分期记录为准。OpenAPI 仍待 P21，不能把设计表中列出的全部端点当作已开放接口。

## 10. 分期实现状态（2026-09-20 至 2026-09-23）

本节只记录实际实现与上文设计的差距，不修改设计正文。实现位于 [apps/api](../../apps/api/package.json)，真实 PostgreSQL + 真实监听端口的用例见 `apps/api/test/integration/api-tasks.integration.test.ts`、`api-state.integration.test.ts` 与 `api-artifacts.integration.test.ts`；未列出的端点仍是设计，不是已交付能力。

### 10.1 已实现（前缀 `/api/v1/workspaces/{workspace_id}`）

| 端点 | 命令 | 成功码 | 备注 |
|---|---|---|---|
| POST /projects | CreateProject | 201 | 同一事务建立 Project 与 ProjectState；初始阶段按 Project Type（GENERAL→PLANNING、THESIS→TOPIC、DEVELOPMENT→DISCOVERY） |
| GET /projects/{id} | ReadProject | 200 | 项目属性 + `revision` + `state_revision` |
| GET /projects/{id}/goals | — | 200 | 关联 Goal 列表，附 `explicit_task_ids`（解除关联前的影响清单来源） |
| POST /projects/{id}/goal-links | LinkProjectGoal | 200 | `expected_revision` 是 Project revision |
| POST /projects/{id}/goal-unlinks | UnlinkProjectGoal | 200 | 需提交 `expected_impacted_task_ids`；锁下重核，不一致返回 409 GOAL_LINK_IN_USE 并附当前清单 |
| POST /goals、GET /goals/{id} | CreateGoal / ReadGoal | 201 / 200 | Goal 是 Workspace 级事实，创建不隐式关联 Project |
| POST /tasks | CreateTask | 201 | 初始 INBOX + HUMAN + 验收 v1；`project_id` 可空（Me Inbox） |
| GET /tasks/{id} | ReadTask | 200 | 见 10.2 |
| GET /tasks?project_id=…｜inbox=true | ListTasks | 200 | 必须显式给出其一；`limit` 默认 50、最大 100 |
| PATCH /tasks/{id} | EditTaskPresentation | 200 | 只能改 `title` |
| POST /tasks/{id}/ready | MarkTaskReady | 200 | INBOX→READY；校验必需 criterion、BLOCKS 前置与未解除 blocker |
| POST /tasks/{id}/start | StartHumanTask | 200 | READY→IN_PROGRESS；仅 HUMAN 执行权，并重核前置 |
| POST /tasks/{id}/cancel | CancelTask | 200（P02/P03） | 当时仅人工路径：非终态→CANCELLED；P08 的 AI 路径见 10.10 |
| POST /tasks/{id}/goal-alignment | SetTaskGoalAlignment | 200 | `mode=INHERIT/EXPLICIT`；INHERIT 不接受 `goal_ids`，EXPLICIT 必须有 `goal_ids`（可为空集合） |
| POST /tasks/{id}/dependency-links｜dependency-unlinks | AddTaskDependency / RemoveTaskDependency | 200 | `dependency_kind=BLOCKS/INFORMS` |
| POST /tasks/{id}/artifacts | CreateArtifactWithVersion | 201 | 只允许 IN_PROGRESS 的人工 Task；内容先完整发布到受管存储再登记 v1 |
| GET /tasks/{id}/artifacts | ListTaskArtifacts | 200 | Task 范围的版本清单与本轮接受指针；M03 后增量见 10.19 |
| POST /artifacts/{id}/versions | SubmitHumanArtifactVersion | 201 | 需要 `expected_artifact_revision` 与 `expected_task_revision`；旧版本不覆盖 |
| GET /artifacts/{id} | ReadArtifact | 200 | 逻辑信息 + `revision` + 各版本摘要；不含宿主路径，也不表示已被选为验收对象 |
| GET /artifact-versions/{id}/content | ReadArtifactContent | 200 | `text/markdown; charset=utf-8` 的正文本身（不是 JSON）；证据不可用返回 503 |
| POST /tasks/{id}/complete | CompleteHumanTask | 200 | 一次短事务写 Task 指针、State delta、人工接受、完成凭据、回执与审计 |
| POST /tasks/{id}/reopen | ReopenTask | 200 | 新 `acceptance_revision`、回到 READY、清空当前完成指针；历史凭据保留 |
| GET /projects/{id}/state | ReadProjectState | 200 | 见 10.3 |
| POST /projects/{id}/state-commands | SetProjectState | 200 | 见 10.3 |
| GET /commands/{command_id} | ReadCommandReceipt | 200 | 第 2 节定义的同一回执；不存在返回 404 COMMAND_NOT_FOUND |

所有写命令都带 `command_id`；同 ID 同内容返回原回执与原成功码（响应头 `Command-Replayed: true`），同 ID 异内容返回 409 `COMMAND_ID_REUSED`。P02/P03 当时成功码由 `command_type` 推导（`Create*` 与 `SubmitHumanArtifactVersion` 为 201，其余 200）；P05 Delegate 与 P08 控制、Resume 及 AI CancelTask 的 202 分支见后续记录，重放仍保持原语义。

### 10.2 P02 与设计的差异与细化（保留当时阶段边界）

- **新增 Goal 与依赖端点**：第 3 节只列了 Project/Task，Goal 对齐与依赖的实际入口来自 [模块 API](module-api.md) 第 1 节（`/goals`、`/projects/{id}/goals`、`/goal-links`、`/goal-unlinks`、`/tasks/{id}/goal-alignment`、`/tasks/{id}/dependency-links`、`/dependency-unlinks`）。没有这些入口就无法验收 A09 与“依赖环/跨项目引用被拒绝”。
- **`CreateTask` 增加可选 `mode`**：设计表只列 `project_id?、title、objective、criteria、expected_outputs`。V001 已支持 `ME/AI_ASSIST`，而切换 mode 的 `/tasks/{id}/interaction-mode` 尚未实现（不建占位端点），因此创建时允许显式给出 `mode`（默认 `ME`）；`DELEGATE_AI` 返回 409 `CAPABILITY_DISABLED`，Delegate 不在本阶段开放。
- **`GetTask`/`GetTask list` 的补充字段**：除第 6 节要求的字段外，返回 `acceptance`（objective/expected_outputs/source/criteria）、`goal_alignment`（mode/goal_ids/effective_goal_ids）、`dependencies`、`blocking_task_ids`、`unresolved_blocker_ids`。`waiting_reason` 在 P02 恒为 `null`：WAITING/BLOCKED 状态与 Run 尚未落地，未满足的前置通过 `blocking_task_ids`/`unresolved_blocker_ids` 与收缩后的 `allowed_actions` 暴露。`allowed_actions` 仅包含真实存在的人工命令；P02 当时不外露完成/重开/产物动作，P03 已补入，见 10.5。
- **列表排序与游标**：按稳定排序键 `(created_at DESC, id DESC)` 做键集分页（0002 增加对应索引，见[物理设计](../database/physical-design-postgresql.md)第 12 节）。游标是 base64url 编码的 `{v, filter, created_at, id}`，绑定过滤条件；换过滤条件复用或格式非法返回 400 `INVALID_CURSOR`。过滤条件中的 Project 也必须在本作用域可见，否则 404（与其他跨作用域 ID 一致）。
- **新增错误码**：`GOAL_ALIGNMENT_INVALID`（409，显式集合不是所属 Project 当前 Goal 的子集，或 Task 无 Project 时要求 EXPLICIT）。其余沿用第 7 节与模块 API 第 4 节：`INVALID_TRANSITION`、`GOAL_LINK_IN_USE`、`DEPENDENCY_CYCLE`、`CAPABILITY_DISABLED`、`REQUIRED_INPUT_MISSING`、`INVALID_CURSOR`。Problem Details 增加了 `command_id` 与 `conflict`（`entity_type`/`expected_revision`/`actual_revision`/`goal_id`/`goal_ids`/`task_id`/`depends_on_task_id`/`impacted_task_ids`/`blocking_task_ids`/`blocker_ids`/`cycle_task_ids`）。
- **字段错误定位**：AJV 的 `additionalProperties`/`required` 失败会把字段名放在 `params` 中，实现从 `params.additionalProperty`/`missingProperty` 补齐 `field_errors[].field`，否则无法指向具体字段。
- **作用域与身份**：命令 scope 为 `workspace:{workspace_id}:user:local`（V1 单用户，服务端固定主体，不接受客户端声明的 actor），与 CLI 初始化 Workspace 使用的 `workspace:{workspace_id}` 是不同作用域。读取端点也要求 Workspace 可见（不存在即 404），不使用空结果掩盖作用域错误。
- **`CancelTask` 不接受 `expected_run_revision`**：V001 没有 Run，字段被严格 schema 拒绝（422），而不是接受后忽略。
- **入口文本上限**（未写入 CHECK，由用例验证）：title 200、objective 2000、criterion statement 500、criterion_id 64、goal title 200、goal description 2000、risk statement 500、source_ref 200、confirmation_ref 200、phase_key 64；`expected_outputs`/`target_spec` 序列化后 ≤ 4096 字符。

### 10.3 Project State 的实现取舍

- `GET /projects/{id}/state` 返回 State 自身 `revision` 与 `dependency_versions`（`project`、`state`、`workspace_authority` 三个标量，以及被投影对象的清单：`project_goals`、本次视图实际包含的 `tasks`（in_progress 与 next_action）、`completion_refs`、`artifact_version_refs`）。`completed_highlight_refs`/`completion_refs` 只包含仍为 `DONE`、当前 `acceptance_revision` 与 `current_completion_id` 都匹配该 `CompletionRecord` 的 Task；历史 `state_completion_refs` 不会删除。`key_decision_refs` 恒为空数组：`decisions` 表尚未建立（不伪装成“没有关键决定”）。
- `POST /projects/{id}/state-commands` 的 `expected_revision` 是 `project_states.revision`。每次成功提交把 State revision 精确递增一次；被拒绝的命令不写任何事实。
- 5 个 action 都已实现：`SET_PHASE`、`SET_NEXT_ACTION`（`null` 表示清除方向）、`SELECT_ARTIFACT_VERSION`、`ADD_CONFIRMED_RISK`、`RESOLVE_BLOCKER`。每个 action 有固定参数集合，出现其他 action 的字段返回 422（不允许整对象覆盖或任意字段路径赋值）。
- 非空 `SET_NEXT_ACTION` 在取得 State 行之前先锁目标 Task，并在锁下确认该 Task 属于路径中的 Project；随后才锁 `project_states`、核对 `expected_revision` 并写入。该 Task → ProjectState 顺序与完成/重开一致，避免与 Reopen 形成 State → Task 的反向等待；`next_action_task_id = null` 不取 Task 锁。DTO、成功码和冲突语义未改变：并发竞争仍按提交次序返回 200 或 `REVISION_CONFLICT` 409，而不是暴露 PostgreSQL 死锁为 500。
- 集合类事实重复写入返回 409 `INVALID_TRANSITION`（同一 Goal 关联、同一条依赖、同一产物版本选择、已解除 blocker 再次解除），不做静默 no-op。
- `RESOLVE_BLOCKER` 依赖的 blocker 目前没有 HTTP 生产者：由后续确定性规则/协调器产生，本阶段可用应用中真实的 Repository 播种事实后经 HTTP 验收，没有为此新建占位端点。`SELECT_ARTIFACT_VERSION` 所需的产物版本自 P03 起由 `POST /tasks/{id}/artifacts` 与 `POST /artifacts/{id}/versions` 真实产生。
- 阶段词汇：`SET_PHASE` 使用内置 Project Type 词汇表硬校验：GENERAL 为 `PLANNING/EXECUTING/REVIEW`，THESIS 为 `TOPIC/LITERATURE/METHOD/EXPERIMENT/WRITING/REVIEW`，DEVELOPMENT 为 `DISCOVERY/DESIGN/IMPLEMENTATION/VALIDATION/RELEASE`。未知、跨类型或空白值返回 422 `VALIDATION_FAILED`，字段为 `phase_key`，且不写 State、回执或审计。**Breaking Change：是。** 先前版本接受任意非空字符串；当前尚未发布的工程不迁移旧异常数据。若发现旧值，先通过 State 查询读取当前 revision，再用正常的 `SET_PHASE` 命令写入同类型合法值，保留该人工纠正的回执和审计。

### 10.4 尚未实现

第 4 节的 Delegate 与 `ReadRun` 已由 P05 实现（见 10.7），Review 查询与决定已由 P07 实现（见 10.9），控制请求与 Resume 已由 P08 实现（见 10.10）；验收版本命令仍未实现。第 5 节的内部应用端口仍只是应用用例，不开放为公开 HTTP（`advanceRunStep` 与恢复扫描是内部端口）。模块 API 中的 Task planning metadata 与 Today 已实现（见 10.29），内置 ViewConfiguration 与 Project 归档分别见 10.33、10.37；Task 移动、Task 交互模式切换和第 5 节完整的 WorkbenchDTO 仍未实现。P10 已提供四类长期信息与有界搜索（见 10.12）。P03 当时未提供 Artifact 列表端点，M03 的 Task 范围读取增量见 10.19；孤儿内容的核对报告与自动清理、启动时的内容抽检仍未实现（访问路径的 hash 校验已实现）。目前没有生成 OpenAPI（P21）；M03 SSE 后端片已独立验收（见 10.17），Review/RESUME 顺序片见 10.18。

### 10.5 P03：Artifact、人工完成与重开（2026-09-20）

已实现第 3 节的四个 Artifact 端点与 complete/reopen，真实用例见 `apps/api/test/integration/api-artifacts.integration.test.ts`（真实 PostgreSQL + 真实临时 data_root，14 个用例）与 `apps/api/test/unit/managed-content-store.test.ts`（6 个用例）。与设计正文的差异与细化：

- **内容下载的响应体**：`GET /artifact-versions/{id}/content` 直接返回 `text/markdown; charset=utf-8` 的正文，不用 JSON 包装（正文即资源，避免二次编码）；因此该端点没有声明 response schema。读取时重新核对 SHA-256 与大小，不一致或文件缺失返回 503 `EVIDENCE_UNAVAILABLE`。
- **`ReadArtifact` 返回版本清单**：第 3 节只要求“逻辑信息、revision、最新版本摘要”。前端需要列出可接受的确切版本，因此响应额外包含 `versions[]`（仅元数据与摘要，不含正文）与 `latest_version_id`/`version_count`；正文仍只能经受授权下载接口获取。该清单当前不分页，属于 V1 规模假设。
- **产物要求的判定形态**：`required_output_spec.artifacts`（受支持种类清单，例如 `["MARKDOWN_DOCUMENT"]`）是 P03 起可判定的产物要求；未声明该键即视为无产物要求，允许空 `artifact_version_ids`。声明了未知种类或非数组形态时返回 409 `INVALID_TRANSITION`（不静默忽略）。
- **新增错误码**：`ACCEPTANCE_STALE`（409，提交的 `acceptance_revision` 不是当前周期）、`CONTENT_TOO_LARGE`（413，按 UTF-8 字节数判定 256 KiB）、`UNSUPPORTED_MEDIA_TYPE`（415，只接受 `text/markdown`）、`STORAGE_UNAVAILABLE`（503，内容未能完整发布）、`EVIDENCE_UNAVAILABLE`（503，受管内容缺失或被篡改）。`media_type` 不在 schema 里收窄成字面量，否则类型不受支持会变成 422 而不是契约要求的 415；`content` 也不设 `maxLength`（JSON 字符数与 UTF-8 字节数不等价），超限由用例返回 413。
- **完成结果的额外字段**：除第 3 节要求的 CompletionRecord ID 与 Task revision/status 外，返回 `human_acceptance_id`、规范化的 `artifact_version_ids` 与 `state_revision`（无 Project 时为 `null`）。`reopen` 返回 `previous_acceptance_revision` 与 `previous_completion_id`，便于确认历史凭据未被改写。
- **`allowed_actions` 已扩展**：`IN_PROGRESS` 增加 `SAVE_ARTIFACT_VERSION`/`COMPLETE`，`DONE` 为 `REOPEN`。它仍是当前事实下的 UI 提示，不是授权凭证。
- **完成的 State delta**：有 Project 时在同一事务写入 `state_completion_refs`（`source_ref = task:<task_id>/acceptance:<n>`），并在 `project_states.next_action_task_id` 正好指向该 Task 时清空它；两种情况都让 State revision 精确递增一次，实际写入的 delta 保存在 `completion_records.state_delta`。
- **重开回到 READY 与当前 State 失效**：按第 3 节实现，重开后必须先 `start` 才能继续保存版本；“完成后必须先重开才能继续上传”因此表现为 DONE 与 READY 两种状态都被拒绝，只有 IN_PROGRESS 可写。有所属 Project 时，重开按 Task → ProjectState 锁序在同一事务递增 State revision；查询仅投影仍由 Task 当前指针指向的同周期完成凭据。因此旧历史可追溯但不能继续作为当前完成高亮，旧完成命令重放也只返回历史回执。
- **故障注入与孤儿**：内容发布成功但数据库提交失败会留下未引用内容，V1 保留不清理；完成事务在 Task/State 更新之间失败会整笔回滚，原样重试同一 `command_id` 得到一致终态。重开事务也在 `project_states` revision 更新处注入失败：Task、复制出的新验收版本和 criteria、State、回执、审计必须一起回滚；移除故障后的同 ID 重试成功，后续重放不重复写入。真实用例通过迁移角色建立的行级触发器注入这些故障点，触发器只对本次用例创建的对象生效。

### 10.6 Schema readiness 兼容门（2026-09-21）

`GET /health/live` 始终不鉴权且只返回 `{"status":"alive"}`。`GET /health/ready` 保持 Bearer、Host 与 Origin 边界：当前发布物的迁移名称和 SHA-256 清单与数据库经受限视图提供的已应用清单完全一致时，返回 200：

```json
{"status":"ready","components":{"database":{"status":"up"},"schema":{"status":"up"}}}
```

数据库不能连接时返回 503 `DATABASE_UNAVAILABLE`，组件为 `database=down`、`schema=unknown`；数据库可连接但空库、缺迁移、出现未知未来迁移、摘要不匹配、兼容视图不可读/缺失时返回 503 `SCHEMA_UNAVAILABLE`，组件为 `database=up`、`schema=down`。检查只读，不自动运行 migration，应用角色仍无权读取 `relay_schema_migrations`。**Breaking Change：是（未发布工程）**，此前 readiness 成功响应没有 `schema` 组件，且数据库可连接即返回 200。

### 10.7 P05：Delegate 与 Run 查询（2026-09-21）

已实现第 4 节的 Delegate 与 `ReadRun`，真实用例见 `apps/api/test/integration/api-delegations.integration.test.ts` 与 `run-steps.integration.test.ts`（真实 PostgreSQL），单测见 `apps/api/test/unit/markdown-deliverable.test.ts`、`fake-model-port.test.ts`。本阶段只有 Fake Runtime，没有外部副作用、没有真实模型、没有控制请求。

| 端点 | 命令 | 成功码 | 备注 |
|---|---|---|---|
| POST /tasks/{id}/delegations | DelegateTask | 202 | 原子授予执行权并创建 `CREATED` Run；`result` 为 `run_id`、`task_id`、`task_revision`、`run_revision`、`status`、`retry_of_run_id` |
| GET /runs/{id} | ReadRun | 200 | Run 事实 + 冻结契约摘要 + 步骤与最近尝试；不含宿主路径、密钥或模型私有内容 |

与设计正文的差异与细化：

- **`workflow_version_id` / `execution_config_version_id` 只接受内置值**：P05 没有 ExecutionConfiguration 表，两个选择器缺省为 `markdown-deliverable-v1` 与 `default-execution-config-v1`；给出其他值时返回 409 `CAPABILITY_DISABLED`，而不是接受一个无法验证的版本声明。正式版本化配置随其实体一起实现。
- **无 Project 的 Delegate 返回 409**：A08 的 Me Inbox 事项只允许人工处理；缺少执行作用域时按 `INVALID_TRANSITION` 拒绝并说明原因，不静默创建无作用域的 Run。
- **`retry_of_run_id` 指向必须可见且为终态**：不存在或属于其他 Task 按不可见处理（404），非终态返回 409 `INVALID_TRANSITION`；B06 的手动再试因此只引用已结束的历史 Run，旧 Run 状态不变。
- **`EXECUTOR_CONFLICT`（409）**：该 Task 已被其他执行者占有、或已存在未释放的 Run 时拒绝并发 Delegate；`uq_run_live_task` 部分唯一索引与 Task 行的条件更新共同保证最多一个 live Run（B01）。
- **`ownership_epoch` 的取值口径**：Run 记录的是**授予后**的 epoch（`Delegate` 使 Task epoch 恰好 +1），因此“Run 的写提交匹配 Task 当前 epoch 与 `executor_run_id`”是一条可直接比较的等式；该值同时写入 `activity_records` 的 `TASK_DELEGATED` 事实。
- **Run 迁移只实现到 `VERIFYING`**：固定步骤序列在 Delegate 时整份持久化（`BUILD_CONTEXT`/`DRAFT`/`PERSIST_CANDIDATE`/`VERIFY`/`COMPLETE`），P05 只执行前三步；最终候选写入不可变 ArtifactVersion（`source_kind='AI'`）后 Run 停在 `VERIFYING`，`VERIFY`/`COMPLETE` 保持 `PENDING`，等 P06 的 Verification 与完成 Gate 接续。**本阶段不写 Task `DONE`、不伪造 PASS。**
- **DRAFT 的纯生成重试**：结构不合法时最多 2 次尝试（`runtime-context.md` 第 2 节的推荐预算，本阶段为常量）；第 2 次仍失败或缺少必需资料时步骤 `FAILED`、Run `FAILED`、Task 释放回 `READY` 且 epoch 再 +1。
- **`advanceRunStep` 不是 HTTP 端点**：它是内部应用端口，输入包含 `workerId`、可选 `attemptKey` 与租约时长；稳定来源尝试 ID 由 `step_attempts(step_id, attempt_key)` 唯一约束去重。迟到 `claim_epoch` 的结果写入 `STEP_ATTEMPT_RESULT_REJECTED_STALE` 审计，保留提交/观测 epoch 与核对证据，不能改写当前 Attempt 的 `status`、worker、lease 或结果；当前 epoch 仍须通过条件更新提交（B08）。
- **Task 投影的 `executor.run_id`**：自 P05 起返回真实 `tasks.executor_run_id`（此前恒为 `null`），`ownership_epoch` 同样来自 Task 行，便于前端显示当前执行者而不自行推断。

### 10.8 P06：Verification 与完成 Gate（2026-09-22）

P06 实现固定 Workflow 的后两步，真实用例见 `apps/api/test/integration/verification.integration.test.ts`（真实 PostgreSQL + 受管内容存储），单测见 `apps/api/test/unit/verdict.test.ts`、`check-plan.test.ts`、`checkers.test.ts`。**P06 交付时不新增 HTTP 端点**：Verification 与完成 Gate 只通过内部应用端口 `advanceRunStep` 执行；Review 的请求、决定与人工判断由随后 P07 接续，当前实现见 10.9。

| 步骤 | 输入 | 结果 |
|---|---|---|
| VERIFY | 冻结执行契约 + `PERSIST_CANDIDATE` 登记的确切版本 | `verification_sessions`（`OPEN`→`PASS`/`RETRY`/`HUMAN`）、`verification_targets`、不可变 `check_results` |
| COMPLETE | 该 Run 最新 session 为 `PASS`、适用性未被撤销，且冻结 `expected_outputs` 被该 session 的确切 `verification_targets` 覆盖 | 自动完成短事务（`completion_records` basis `AUTO`）；不满足则 `COMPLETION_BLOCKED` |

`advanceRunStep` 的新增结果：`CORRECTION_SCHEDULED`（修正回路已排期）与 `COMPLETION_BLOCKED`（完成前置不满足）。Run 迁移为：`VERIFYING →(PASS/检查器重试)→ VERIFYING`、`VERIFYING →(RETRY)→ RETRYING`、`VERIFYING →(HUMAN)→ WAITING_APPROVAL`、`WAITING_APPROVAL/VERIFYING →(COMPLETE)→ COMPLETED`（终态）。

与设计正文的差异与细化：

- **CheckPlan 由冻结契约派生，Worker 无写权**：`buildCheckPlan` 读 `execution_contracts.frozen_snapshot` 的 criteria，按 method 映射内置 registry（`HUMAN→human-evidence-v1`、`MARKDOWN_STRUCTURE→markdown-structure-v1`、`CITATION_EXISTS→citation-exists-v1`、`SEMANTIC→fake-semantic-v1`）；severity 取 `target_spec.severity`，缺省 required→`HARD`、否则 `PREFERENCE`。计划与 SHA-256 摘要在 session 创建时冻结，Delegate 之后删除或改写 `acceptance_criteria` 不改变本轮检查集合（已由集成用例断言）。
- **registry 与故障替换分开**：`ERROR` 检查器只由 `resolveCheckerForScenario('CHECKER_ERROR')` 替换出来，**不注册进 registry**；若注册会覆盖同 id/version 的真实检查器，把确定性检查永久变成 ERROR。缺注册 checker 时 VERIFY 直接判为不可执行失败（`CHECKER_NOT_REGISTERED`），不静默降级为建议。
- **总判定顺序刻意“先修可修的”**（`src/workflow/verdict.ts` 纯函数）：① 必需项检查器 `ERROR`：该 criterion 最新 `check_attempt < 2` → 重试检查本身，否则 `HUMAN`（`CHECKER_UNAVAILABLE`）；② 必需项非 `PREFERENCE` 的 `FAIL`：预算未耗尽 → `RETRY`，否则 `HUMAN`（`CORRECTION_BUDGET_EXHAUSTED`）；③ 必需项 `NOT_RUN` → `HUMAN`（`AWAITING_HUMAN_EVIDENCE`）；④ 必需项 `UNCERTAIN` → `HUMAN`（`UNCERTAIN_REQUIRES_HUMAN`）；⑤ 其余 → `PASS`。这样“必需人工项未完成”不会把本可修正的失败永久锁死，`ERROR`/`NOT_RUN` 也不会被算成 `PASS`；`NOT_APPLICABLE` 与非必需项不影响总决策，`PREFERENCE` 失败只作为建议记录。
- **检查器重试不产生新证据**：`RETRY_CHECKER` 不 finalize session、不新建产物版本；下一次推进只对同一 session 追加更大的 `check_attempt`。第 2 次仍不可用才转 `HUMAN` 并保留未决（C06）。
- **修正回路不新建步骤行**：总决策 `RETRY` 时 session 先 finalize 为 `RETRY`（`correction_budget_used +1`），随后把 `BUILD_CONTEXT`/`DRAFT`/`PERSIST_CANDIDATE`/`VERIFY` 重置为 `PENDING`、Run 回到 `RETRYING`，按固定顺序重跑这一段；修正轮次与已用预算都由「该 Run 已 finalize 为 `RETRY` 的 session 数」推导，没有额外计数列。默认修正预算 2 次（`DEFAULT_CORRECTION_BUDGET`）。
- **修正创建新产物与新 Session**：`BUILD_CONTEXT` 在 round ≥ 1 时把上一轮失败项作为 `correction` 输入装进 Manifest payload（摘要变化，形成新的不可变 Manifest）；`PERSIST_CANDIDATE` 的 round ≥ 1 用 `run:<runId>/step:PERSIST_CANDIDATE/round:<n>` 作为来源尝试 ID，在**同一 Artifact 上追加新版本**（不是新建第二个 Artifact），旧版本与旧 session 的历史结论保留。新版本必须由新 session 重新验证，不继承旧 PASS（C01/C02 的产物侧）。
- **`EVIDENCE_UNAVAILABLE` 优先于任何检查结果**：VERIFY 与 COMPLETE 都先读受管内容并核对 hash/size；文件缺失、被替换或摘要不一致时返回 503，不写检查结果、不返回部分内容、不把缺失当成 `FAIL`（C08 的证据侧）。
- **冻结产物要求同时由两道门核对**：Delegate 先拒绝 `required_output_spec.artifacts` 的非数组形态或当前固定 Workflow 不支持的种类；COMPLETE 仍读取 Run 的冻结 `expected_outputs`，用最新 PASS session 的精确 `verification_targets` 种类集合重新核对。这样旧版本遗留或其他入口留下的冻结 Run 也不能绕开 Gate。未知或畸形要求、声明必需产物却目标为空或缺少必需种类时返回 `COMPLETION_BLOCKED / DECLARED_OUTPUTS_UNSATISFIED`，不写步骤 Attempt、完成凭据、State delta 或成功审计。**Breaking Change：是（尚未发布）**；先前可创建但不可判定的要求现在在 Delegate 返回 409 `INVALID_TRANSITION`，已有 Run 保持原冻结事实并在完成时安全阻塞，不迁移或改写历史。
- **`COMPLETION_BLOCKED` 不是执行失败**：完成 Gate 在**建立步骤尝试之前**核对，因此等待人工既不产生 `FAILED` 尝试，反复轮询也不会留下失败尝试；步骤保持 `PENDING`、Run 与 Task 不变。原因取 `ACCEPTANCE_REVISION_CHANGED`（C01：验收契约已变化，旧 PASS 不能完成新周期）、`VERIFICATION_NOT_PASSED`（含 C04 必需人工项未决）、`VERIFICATION_REVOKED`（显式撤销适用性）或 `DECLARED_OUTPUTS_UNSATISFIED`（冻结产物要求不可判定或未被 PASS target 覆盖）。
- **自动完成短事务**（contracts/04 第 7 节）：写 `completion_records`（basis `AUTO`，绑定 `verification_session_id` 与 `run_id`）→ CAS Task 至 `DONE` 并写当前完成指针 → **释放 AI 执行权**（`executor_kind='HUMAN'`、`executor_run_id=NULL`、`ownership_epoch+1`）但**保留 `mode='DELEGATE_AI'`** 供展示 → Run `COMPLETED`（写 `terminal_at`）→ 有 Project 时写 `state_completion_refs` 并清空/递增 `project_states` → 写 `TASK_COMPLETED` 审计。任一步失败整笔回滚（D05 用真实失败触发器验证）。`ReopenTask` 现在把 `mode` 复位为 `ME`。
- **PASS 之后只重试提交**：`D04` 由集成用例断言——VERIFY `PASS` 之后不跑 COMPLETE，只推进 COMPLETE 即完成，且不新增产物版本、session 或 DRAFT 尝试。
- **P06 交付时的边界**：人工补验入口（`verification_sessions` 允许 `run_id` 为空但当前没有写入口）、`RecordCheckResult` 的 HTTP 形态、Review 类型化请求与决定（C02/C03/C09）、控制请求与资源 claim 当时均未实现。P07 已接续 Review 查询与决定，并向 `GET /runs/{id}` 增加 `blocking_review_ids`；P08 又加入控制请求与受控 Fake 动作身份（见 10.10）。该投影仍不含完整 verification 摘要，人工补验入口与通用资源 claim 仍未实现。**Fake 边界**：`FakeSemanticChecker` 是确定性替身，真实语义判断属 P12；本阶段不声称验证器能保证事实绝对正确。

### 10.9 P07：Review 与人工判断（2026-09-23）

P06 的 `HUMAN` 结果现在同事务建立阻塞 Review。HTTP 开放 `GET /reviews?status=OPEN|DECIDED|EXPIRED`（缺省 OPEN）、`GET /runs/{id}/reviews`、`GET /reviews/{id}`、`POST /reviews/{id}/decisions`。读取 DTO 包含 `id/kind/status/revision`、Project/Task/Run 绑定、`target_hash`、`target/evidence/effect`、`allowed_decisions`、时间；已过期目标展示 `EXPIRED` 且没有可用按钮。决定命令携带 `command_id/expected_revision/target_hash/decision`，可选 `feedback`，仅 `SET_RETRY_BUDGET` 携带整数 `retry_budget`（1–6），返回既有命令回执及 `review_id/decision_id/effect/revision`。**Breaking Change：否**；均为新增路由/投影字段，既有命令语义未改变。

- **确切绑定与原子性**：请求摘要覆盖冻结验收版本、Run、原验证会话、候选 ArtifactVersion ID 与 hash、criterion 或操作身份；State 提案覆盖 Project、`base_revision` 与类型化命令。决定前在事务里复核 revision、摘要、执行权、当前候选与验收版本；过期或目标变化返回 409。决定事实、验证后续会话/预算或 State 更新、审计与命令回执在同一事务提交。相同命令原样重放返回原结果，不重复应用。
- **不改写 P06 历史会话**：`HUMAN` session 已 finalize，不再追加 CheckResult。针对单个 `NOT_RUN`/`UNCERTAIN` criterion 的 `ACCEPT` 创建有 `parent_session_id` 的新 session，复制同一目标与既有检查证据，仅该 criterion 写带不可变 `review_decision_id` 的人工 PASS 证据；所有必需条件满足才产生新 PASS，完成 Gate 只接受最新 PASS。`REQUEST_CHANGES` 生成后继 RETRY session 和新修正轮，保留旧会话与旧版本。必需 HARD `FAIL`、检查器 `ERROR` 不能被笼统 ACCEPT 覆盖。
- **预算与检查器**：默认修正上限 2；`SET_RETRY_BUDGET` 仅能上调到最多 6，持久写入 `run_correction_budgets`，下一次 VERIFY 读取当前上限。预算耗尽的 HARD 失败只开放加预算，追加 RETRY 证据后再修正。`CHECKER_RETRY` 的 `RETRY_CHECKS` 只重置 VERIFY 对同一候选重新运行检查器，不产生新产物。Run 在等待非 COMPLETE 步骤的 Review 时返回内部 `WAITING_REVIEW`，不会因轮询越过操作拒绝。
- **State 与操作请求**：内部 `requestStateProposal` 冻结 `base_revision` 与 `normalizeStateAction` 的类型化参数；`ACCEPT` 由既有 Project State Owner 写入口按当前 revision 应用，`DENY` 只记录判断。内部 `requestActionApproval` 预分配唯一 `operation_id`，绑定 step、规范目标、参数/内容摘要与有效期；`APPROVE/DENY` 仅存授权判断，不执行外部操作，不转移 Task owner。P09 才负责 Gateway 准入、权限再校验、批准消费和 Invocation 关联。
- **P07 交付时的开发自检边界**：真实 PG 用例覆盖 C02/C04/C09、A02 的当前实现部分、预算与修正衔接；HTTP 路由、命令回执和隔离另有测试。此处是开发自检，不是 Windows 桌面或完整产品验收。`RecordCheckResult` HTTP、P08 控制/恢复与 P09 批准消费当时均未实现；P08 当前实现见 10.10，`FakeSemanticChecker` 仍是确定性替身。

### 10.10 P08：持久控制与受控 Fake 恢复（2026-09-23）

- **控制与读取**：`POST /runs/{id}/control-requests` 接受 `command_id`、两个 expected revision、`type=PAUSE|CANCEL|HANDOFF|CANCEL_TASK` 与可选 `supersedes_request_id`，返回 202 命令回执，其 `result` 为 `{control_request_id,run_id,task_id,type,status:"PENDING",run_revision}`。回执固定表示意图已持久提交，即使独立安全点事务随后立即应用；实际结果由 `GET /runs/{id}/control-requests/{request_id}` 的直接对象读取：`id,run_id,task_id,type,status,revision,requested_at,decided_at,result_ref`。同一 Run 仅容一个 PENDING；冲突返回 409 `CONTROL_CONFLICT`，明确指定原请求 ID 才可 supersede。终态 Run 返回 409 `RUN_TERMINAL`。
- **Resume 与投影**：`POST /runs/{id}/resume` 接受命令 ID 和两个 expected revision，返回 202 回执，`result={run_id,status,run_revision}`。仅原 Run 仍持有 Task、Run 为 PAUSED、无 PENDING 控制、无未决动作且无 Worker claim 时恢复；原阶段为 WAITING_APPROVAL 时 Task 仍为 WAITING。`GET /runs/{id}` 保留 P05/P07 的 `task_id,revision,contract,current_step,steps,recent_attempts,result_refs,blocking_review_ids` 等字段，增加 `pending_control_request:{id,type,status:"PENDING",requested_at}|null` 与 `unresolved_operation_ids:string[]`。Task 为 WAITING 时 `GET /tasks` 的 `waiting_reason` 从当前 Run 投影。
- **Task cancel 兼容性**：人工持有的非终态 Task 仍以 200 直接返回 CANCELLED。AI 持有时 `POST /tasks/{id}/cancel` 可带 `expected_run_revision`，以 202 回执返回 `status:"PENDING",control_request_id,run_id,type:"CANCEL_TASK",run_revision`；安全点后才能把 Task 设为 CANCELLED。此处 **Breaking Change: Yes**，针对旧客户端把 AI 占有 Task 的 cancel 当作同步 200 的假设；兼容做法是按 202 回执读取控制请求与 Task 当前投影，人工路径保持 200。
- **安全边界**：Worker 领取与提交各用短事务，Fake 生成及受管内容读写在事务外；PERSIST 候选用固定 `operation_id=attempt_id`、目标路径和参数摘要保存效果。内部 `scanRecoveryCandidates` 仅列租约到期或已 fence 的未决候选，不自动运行，也不凭租约宣称旧进程已停止；内部 `recoverStoppedWorker` 要求调用方提供停机依据后提升 worker epoch 并核对同一动作，生产进程管理器的自动停机确认尚未实现。目标确实缺失才按同一 operation ID 重新准备；内容损坏或成功日志与内容不符保持 UNKNOWN，控制/交接不越过。HANDOFF 的 `result_ref.handoff` 保存 Run/Task/epoch、步骤位置、可用候选版本与验证会话的 ID；无候选时字段为 null，模型说明失败不阻塞确定性事实包。
- **P08 当时未开放**：恢复扫描与 Worker fence 是内部应用端口；当时尚无公开 `GET /runs/{id}/operations`、通用跨 Task 资源 claim 和 Gateway 批准消费。P09 当前增量见 10.11 节。P08 开发自检的确切范围见[测试计划](../testing/verification-plan.md)，不等于正式验收。

### 10.11 P09：Fake Gateway 配置与动作历史（2026-09-23）

**Breaking Change: No。** 本节在未发布的 `/api/v1` 上新增路由，不改现有命令的成功码或字段。路径均位于 `/api/v1/workspaces/{workspace_id}` 下；配置资源嵌套在 `/projects/{project_id}` 下，Workspace/Project 不匹配返回 404，不能通过跨作用域 ID 读取配置。写命令沿用 `command_id`、同请求回执重放头 `Command-Replayed: true`、不同内容复用 ID 的 409 `COMMAND_ID_REUSED`；版本冲突为 409 `REVISION_CONFLICT`。回执的 `links.resource` 指向具体配置资源。

| 资源 | 当前写入口 | 当前读取 |
|---|---|---|
| Fake Connection | `POST /projects/{project_id}/connections`：`command_id,capabilities`（非空、唯一，限 `FAKE_WRITE`/`FAKE_PUBLIC_READ`）；`POST /projects/{project_id}/connections/{id}/disable`：`command_id,expected_version` | `GET /projects/{project_id}/connections`、`GET /.../{id}`；`POST /.../{id}/test` 只返回 `AVAILABLE`/`DISABLED`、`checked_at`、`external_effect_executed:false` |
| Permission | `POST /projects/{project_id}/permission-policies`：`command_id,capability,resource_id,decision,max_payload_bytes`；`POST /.../{id}/versions` 另带 `expected_revision`；`POST /.../{id}/revoke` 带 `expected_revision` | `GET /projects/{project_id}/permission-policies`、`GET /.../{id}/versions`，版本不可变；当前版本由 policy `active_version` 指向，撤销后为 null |
| Managed Resource | `POST /projects/{project_id}/managed-resources`：`command_id,root_path`（已有本地目录）；`POST /.../{id}/disable`：`command_id,expected_revision` | `GET /projects/{project_id}/managed-resources`、`GET /.../{id}`；返回规范根、状态、revision 和 resource_epoch |

Connection 回执为 `connection_id,project_id,version,status`，Permission 为 `policy_id,project_id,version?,revision,status`，Resource 为 `resource_id,project_id,revision,status,canonical_root`。创建返回 201，版本追加、撤销及停用返回 200。Fake Connection 当前配置固定为 `{}`，请求和查询均不接收或返回密钥、config 原文、claim token。Permission 默认无规则即 DENY；`FAKE_PUBLIC_READ` 的 `resource_id=null` 且只匹配 `https://public.example/` 路径段，`FAKE_WRITE` 绑定本 Project 已登记资源。策略版本、Connection version、最终规范目标和参数摘要都在内部 Admit 重读；APPROVE 不能覆盖撤销或新版本。

`GET /runs/{run_id}/operations`、`GET /import-jobs/{import_job_id}/operations` 与 `GET /operations/{operation_id}` 返回 Operation 历史；单项包含 `id,origin,project_id,run_id,step_id,import_job_id,status,action_type,normalized_target,params_hash,connection_id,connection_version,policy_id,policy_version,created_at,result_ref,invocations[]`，每个 Invocation 含 `id,attempt_number,status,authority_revision,connection_version,worker_epoch,created_at,dispatched_at,resolved_at,result_ref`。列表目前最多 100 条，无分页游标。`GET /import-jobs/{id}` 只读返回类型化 USER_IMPORT 来源与 QUEUED/RUNNING/SUCCEEDED/FAILED 状态；P17 的当前 URL 导入行为见第 10.27 节。Operation/Invocation 查询不返回参数原文、Connection config、claim token 或 Worker ID。

2026-09-27 M06 内部回执增量：`FILE_WRITE` 的 Invocation 在 `DISPATCHING` 且适配器已返回、最终结算尚未提交时，既有 `result_ref` 可包含 `file_write_receipt`（原 operation/invocation ID、适配器结果及逐文件状态/摘要）；最终结算和恢复证据也可保留该字段。它只表示适配器报告已绑定原调用，客户端必须以 Invocation/Operation 的 `status` 判断是否结算，不能将回执本身当作成功。字段不含写入内容或凭据。**Breaking Change: No**：原端点、字段和状态码不变，开放对象 `result_ref` 内增加可选证据；旧客户端忽略即可。

Prepare、Worker claim、Admit、Fake 执行、outcome、reconcile 目前只开放内部应用端口，HTTP 无“设置 SUCCEEDED”入口。RUN 仅允许受控 Fake marker 写，USER_IMPORT 仅允许固定公共 Fake 读；P08 受管 Markdown 发布保持专用入口。两个 Project 可以登记重叠根，但同一时刻重叠根只能有一个 HELD/QUARANTINED 占用；UNKNOWN 阻止换意图或目标绕行。DISPATCHING 后仅凭目标缺失不能证明未执行，继续 UNKNOWN；只有 PREPARED 且调用方证明旧 Worker 已停，才允许原 operation_id 的新 Invocation。生产进程管理器、真实 Web/Git/CLI、任意文件写与公开恢复调度尚未实现。

### 10.12 P10：长期信息、Rule 冻结与有界搜索（2026-09-23）

**Breaking Change: Yes（未发布工程的 Delegate 行为）。** HTTP 旧字段与成功码不变；Delegate 现在读取适用 Rule，HARD 冲突或无真实检查路径会返回 409，Rule 更新后旧 Run 的后续步骤/Gateway 准入返回 409 `RULE_SNAPSHOT_STALE`。客户端需显示旧 Run 已失效，并经安全控制结束后按新规则重新 Delegate。新增信息路由本身为兼容增量，均在 `/api/v1/workspaces/{workspace_id}` 下；跨 Workspace/Project 的 ID 按 404 隐藏。写命令使用原有回执、`command_id` 幂等和 revision 字符串。

| 资源 | 读取 | 写命令与回执 `result` |
|---|---|---|
| Knowledge | `GET /knowledge?project_id=...`、`GET /knowledge/{id}`、`GET /knowledge/{id}/versions` | `POST /knowledge`：`command_id,project_id,title,source_kind,text?,media_type?,artifact_version_id?` → 201；`POST /knowledge/{id}/versions` 另带 `expected_revision` → 200；`POST /knowledge/{id}/archive` 带 `command_id,expected_revision` → 200。结果为 `knowledge_id,revision,version?,status` |
| Memory | `GET /memories?project_id=...`、`GET /memories/{id}`、`GET /memories/{id}/revisions` | 创建和追加分别 `POST /memories`、`POST /memories/{id}/revisions`，必需 `title,text,confirmed:true`，可选 `expires_at`，追加带 `expected_revision`；`POST /memories/{id}/retire`。创建 201，其余 200；结果为 `memory_id,revision,version?,status` |
| Decision | `GET /decisions?project_id=...`、`GET /decisions/{id}`、`GET /decisions/{id}/versions` | `POST /decisions`：`title,choice,rationale,alternatives[],costs[],project_id` → 201；`POST /decisions/{id}/supersessions`：`command_id,expected_revision,replacement_decision_id` → 200；结果含 `decision_id,replacement_decision_id?,revision,status` |
| Rule | `GET /rules?project_id=...`、`GET /rules/{id}`、`GET /rules/{id}/versions` | `POST /rules`：`scope,scope_id,rule_key,statement,strength,applicability:AI_RUN,enforcement,method?,target_spec?` → 201；`POST /rules/{id}/versions` 另带 `expected_revision` → 200；`POST /rules/{id}/retire` → 200。结果为 `rule_id,revision,version?,status` |

列表直接返回对象数组，详情直接返回对象；根 DTO 包含 `id,project_id,status,revision,current_version,created_at,updated_at` 和各类型当前字段。KnowledgeVersion 包含 `id,knowledge_id,version,source_kind,media_type,content_sha256,availability,excerpt,source_refs,created_at`；`source_refs` 为 JSON 对象，Note/受管文本为 `{}`，ArtifactVersion 为 `{artifact_version_id}`，后者 `excerpt=null`。MemoryRevision 保存不可变 `title,text,confirmed_by,confirmed_at,expires_at`；RuleVersion 独立返回 `rule_id,version,rule_key,statement,strength,applicability,enforcement,method,target_spec,created_at`，当前指针只在根上。版本列表按 version 降序；`confirmed` 只能由当前本机用户显式提交，客户端不可指定确认主体。

`source_kind=NOTE` 只接受 `text/plain`，`MANAGED_TEXT` 接受 `text/plain`/`text/markdown`，正文 UTF-8 不超过 256 KiB，保存在不可变 PostgreSQL 版本行。`ARTIFACT_VERSION` 只引用同 Project 的 Markdown ArtifactVersion，不复制其正文；相同来源在同一 Workspace 的并发提升返回同一 Knowledge 身份。该引用的元数据不代替 Artifact 内容读取时的 hash/size 核对。P17 的 `WEB_PAGE` URL 导入见第 10.27 节；PDF/Office 提取和任意文件导入尚未实现。

`GET /search?q=...&project_id=...&types=KNOWLEDGE,MEMORY,DECISION,RULE&limit=1..50&cursor=...` 返回 `{items,next_cursor}`；每项为 `type,id,version,title,snippet,matched_fields,source_ref,status,project_id`。`q` 为 1–200 字，按字面内容匹配并转义 `%`/`_`；Project 过滤只含 Workspace 全局与该 Project，可用当前版本，Memory 过期和已退役/归档项不进入结果。排序为标题完整匹配→标题包含→正文包含→更新时间降序→ID 降序→类型；游标绑定查询/作用域/类型及完整排序键，换过滤条件返回 400 `INVALID_CURSOR`。当前没有标签字段、Artifact 引用正文全文索引或中文语义/向量检索。

Rule mutation 先取 Workspace authority UPDATE，Delegate、步骤领取/提交和 Gateway Prepare/Admit 先取 SHARE；Delegate 把 Rule 来源版本、`rule_revision` 与对应固定 CheckPlan criterion 一起冻结，VERIFY/Review 使用同一契约。相同 key 的不同 HARD 含义、上层 HARD 与下层弱化、同层不同 PREFERENCE 返回 409 `RULE_CONFLICT`；未知/缺少确定性 POST_CHECK、HARD PRE_ACTION、HARD SEMANTIC（目前只有 Fake checker）返回 409 `RULE_ENFORCEMENT_UNAVAILABLE`。PREFERENCE PRE_ACTION 仅作为来源保留，不成为可执行检查。规则版本栅栏目前按整个 Workspace 递增；更新无关 Project 的 Rule 也会保守地使既有 Run stale。已经 Admit 或发布的效果仍按原 operation/Invocation/Attempt 登记与核对，Rule 变化只阻止下一动作，不能抹掉已发生副作用。

### 10.13 P11：Run Context Manifest 只读证据（2026-09-23）

**Breaking Change: Yes（未发布工程的内部 BUILD_CONTEXT 行为）；HTTP 新增只读端点本身为 No。** P05 的占位 Manifest 已被真实装配替换；必需内容超预算时该步骤以 `CONTEXT_REQUIRED_OVER_BUDGET` 失败，不生成虚假的成功快照。原 FakeModelPort 仍使用 `task.title`、`contract.objective`、`fake_scenario` 和修正轮证据。无 Project Assist 尚无 P12 请求端口，不提供伪造的 Manifest。

- `GET /api/v1/workspaces/{workspace_id}/runs/{run_id}/context-manifests` → 200 `{items,build}`。`items` 按 `created_at DESC,id DESC`，单项为 `id,run_id,step_id,created_at,builder_version,template_version,manifest_hash`；`build` 为 `{status,reason_code,message}`，状态 `NOT_STARTED|RUNNING|SUCCEEDED|FAILED`。未装配为 `items=[]`、`NOT_STARTED`；必需来源不可用或超预算时为空列表且 `FAILED`，原因分别为 `CONTEXT_REQUIRED_SOURCE_UNAVAILABLE`、`CONTEXT_REQUIRED_OVER_BUDGET`。构建期间来源更新可留下 `RUNNING/CONTEXT_SOURCE_CHANGED` 并重新尝试。安全文案不含来源 ID/数量。
- `GET /api/v1/workspaces/{workspace_id}/runs/{run_id}/context-manifests/{manifest_id}` → 200 同一摘要字段加 `budget,dependencies,sources[],exclusions[]`。P11 `budget` 为 `limit_tokens,reserved_tokens,required_tokens,selected_tokens,estimation=ESTIMATED_UTF8_BYTES_DIV_3`；`dependencies` 含冻结 contract/workflow/config/Rule revision，装配时 authority/context 与 Project/Task revision，固定 Profile 的 ID/version/digest，`skill:null`。旧 P05 快照可返回 `budget:null,dependencies:{},sources:[]`。每个 `source` 含 `kind,source_ref,version,sha256,source_sha256,range:{start,end,unit:UTF8_BYTE},content,role,trust`；Relevant 另含 `selection_reason=TITLE_MATCH|RECENT_SCOPE_FALLBACK`。`sha256` 是送入模型的实际片段 hash，`source_sha256` 是完整来源 hash；`exclusion` 为已授权来源的 `source_ref,reason=BUDGET_TRIMMED|SOURCE_UNAVAILABLE`。

两个读取端点在每次访问时重新核对 Run Workspace/Project；跨范围 Run/Manifest 按 404 隐藏。详情对归档 Knowledge、退役/过期 Memory、已替代 Decision、不可用 ArtifactVersion 或已不适用 Rule 的正文再次过滤；受限来源整条从 `sources/exclusions` 移除，不暴露其 ID、名称、正文或数量，`budget.required_tokens/selected_tokens` 改为 null。Manifest 快照不能充当当前资料读取权或未来 Gateway 授权。当前只有固定 Fake Worker 使用此 Context；检索先按标题字面命中，再补最近同范围最多 3 条（总 Relevant 最多 10），不声称语义相关性或真实模型安全输入已验证。

### 10.14 M03 首片：Delegate 的持久运输（2026-09-24）

**Breaking Change: No。** 旧客户端仍向 `POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/delegations` 提交 `command_id` 与十进制字符串 `expected_task_revision`，可选 `retry_of_run_id`、`workflow_version_id`、`execution_config_version_id`；Bearer、Host/Origin 与 Workspace 作用域规则不变。202 envelope 的 `result` 仍为 `run_id,task_id,task_revision,run_revision,status=CREATED,retry_of_run_id`。同 Workspace 的同 `command_id`/同载荷返回原回执；异载荷 409 `COMMAND_ID_REUSED`。202 现在同时保证 Run、START 命令、outbox 和回执已在同一业务事务提交，独立 Worker 可从 PostgreSQL 扫描领取。回执不表示已执行或完成。

首片未增加公开的 Worker、outbox 或 SSE HTTP 路由。已有 `GET /runs/{run_id}` 仍是状态查询入口；页面关闭/API 退出不取消 Run。SSE、审批后 RESUME、取消与恢复的新增传输契约在 M03 后续切片冻结，不能从本节推断它们已可用。

### 10.15 M03 第二片：桌面私有 supervisor IPC（2026-09-24）

**Breaking Change: No（公开 HTTP）。** 本片不改变 Delegate/Run/Review 的 URL、Bearer/Workspace 权限、`command_id` 幂等或 202 回执，也不增加公开恢复路由。桌面宿主启动随包 `supervisor-main.js` 前须核对精确静态标记 `relay-desktop-supervisor-v1`，并设置 `RELAY_SUPERVISOR_DESKTOP_MODE=true`。私有 stdin 首行是严格 JSON：`{nonce:<UUID v4>,launchId:<UUID v4>,stoppedLaunches:[{launchId:<UUID v4>,stopEvidence:"armed_job_terminated_and_active_count_zero"|"armed_job_absent_after_last_handle_closed"}]}`；最多 1 MiB/4096 个旧 launch。校验前不连接 PostgreSQL 或启动 Worker。第二片 stdout 顺序是 `supervisor_ready {nonce,launchId,nodeVersion}`、旧 launch 恢复完成后的 `dispatch_ready {nonce,launchId,requeuedRunIds,blockedRunIds}`，随后只有 `worker_started`、`worker_exit`、`worker_recovery_required` 运行事件；第三片的逐 launch 扩展见 10.16。宿主只有在 OS 已确认旧 Job 整组停机后才能提供 `stoppedLaunches`；Node 不能把租约过期或重启当作证明。stdin EOF 停新领取并等待已启动 Worker `close`。这只是私有宿主协议，细节与故障边界见 [M03 开发记录](../development/m03-run-dispatch-slice.md#桌面私有监督与旧-launch-恢复第二片)。

`dispatch_ready` 另外携带 `requeuedRunCount:number`、`blockedRunCount:number`、`runIdsTruncated:boolean`。原 `requeuedRunIds:string[]`、`blockedRunIds:string[]` 保留供现有宿主反序列化，但只是按 stdout `<64 KiB` 实际 UTF-8 行长截取的前缀样本，不能作为完整 Run 集合、按 launch 的确认或 ARMED 删除依据；两个 Count 才是本次处理结果总数。BLOCKED/UNKNOWN 的旧 launch 停机证明不一定持久入库，宿主须保留其 ARMED 记录供后续核对。第二片时宿主第二阶段等待固定 30 秒，大量旧记录可能超时并拒绝就绪；按 launch 的确认由 10.16 增加，超时策略仍待宿主片处理。本变更只扩充私有输出帧，**Breaking Change: No（公开 HTTP）**。

### 10.16 M03 第三片：旧 launch 恢复确认（2026-09-24）

**Breaking Change: No（公开 HTTP）；私有宿主协议新增必需事件。** 每个 `stoppedLaunches` 条目完成该 launch 的所有旧 claim 核对/事务提交后，监督器重新从 PG 读取同一 launch 的 ACTIVE/STOP_REQUIRED invocation 数，发 `launch_recovery_ack {type:"launch_recovery_ack",nonce,launchId,retainedClaims:number}`。`retainedClaims` 是非负安全整数，不由 `dispatch_ready` 的有界 Run ID 样本或首次扫描推导。按输入 launch 顺序逐项发 ack；所有条目成功发 ack 后才发最终 `dispatch_ready`，随后才允许新领取。无旧 claim 的 launch 发 0；可安全重排后发 0；UNKNOWN、受损目标或其他残留占有发大于 0。任一核对/计数异常或停止/EOF 不发该 launch 的 ack、最终 ready，也不开始新 Worker。

`retainedClaims=0` 表示宿主已证明旧 Job 停止且该 launch 目前无持久活跃 claim；宿主只能在最终 `dispatch_ready` 后删除对应旧 ARMED。`retainedClaims>0` 必须保留旧 ARMED；先收到的部分 ack 仅是进度，最终 ready 未到不能清理。后端 ack 与 Windows 宿主组合片已由协调 Agent 独立验收：Rust 按序验证每项 ack 与最终 ready，Clean 删除零残留旧 ARMED，UNKNOWN 保留；第二阶段为 120 秒空闲和 20 分钟总时限。单个 launch 的核对期间仍无额外心跳，若实际核对超过空闲时限，宿主会安全失败。本结论只覆盖该组合片，M03 整体未验。实现与反例见 [M03 第三片开发记录](../development/m03-run-dispatch-slice.md#逐旧-launch-恢复确认第三片)。

### 10.17 M03 Run SSE 后端片（2026-09-24，已独立验收）

**Breaking Change: No。** 新增 `GET /api/v1/workspaces/{workspace_id}/runs/{run_id}/events?after=<seq>`，返回 `text/event-stream; charset=utf-8`。请求使用原 Bearer 头、回环 Host/端口与允许的 Origin；Run 不属于该 Workspace 时按 404 隐藏。令牌不在 URL、事件或日志中。允许的 CORS preflight 头新增 `Last-Event-ID`，错误 Origin 与无 Bearer 不得到事件流。

每个已提交的 Run 事件从 `1` 连续递增；初次连接可用 `after=0`。`after` 查询参数优先于 `Last-Event-ID` 请求头，二者都没有时取 `0`；即使头值非法，显式合法 `after` 仍生效。被选中的游标必须是无前导零的非负十进制、至多 PostgreSQL signed bigint 最大值 `9223372036854775807`；非法、重复参数或大于该 Run 当前已提交最大序号返回 422 `VALIDATION_FAILED`，连接不升级为 SSE。历史 Run 在 0012 前没有合成事件，其最大序号为 0；客户端在流打开时仍应 GET 权威 Run 快照，不能把无历史帧解释为资源不存在。

持久事件仅是刷新提示，标准帧形如 `id: 1`、`event: run_hint`、`data: {"kind":"RUN_CHANGED"}`，以空行结束。`kind` 为 `RUN_CHANGED|STEP_CHANGED|ATTEMPT_CHANGED|REVIEW_CHANGED|CONTROL_CHANGED|EFFECT_CHANGED`；不含产物正文、模型 token、密钥或受限来源 ID。客户端只将完整帧的 `id` 作为最后消费游标，重复 ID 去重，缺号从旧游标重连，再 GET Run/Review/控制/产物权威快照。心跳是无 `id` 的 SSE 注释，不能充当可靠事件。关闭页面或断订阅只关闭连接，不请求取消或改变 Run。

服务端从 PG 顺序分批（每批最多 100）读取已提交事件；空批约每秒重新补查，因此无需把通知当唯一历史，历史与实时交界没有单次订阅切换窗口。写入返回背压时暂停读 PG，等待 drain；5 秒仍不能 drain 则关闭慢连接，由客户端凭最后完整 `id` 补读。每约 15 秒空闲发送无 ID 心跳。服务端不缓存无界输出，且当前 `run_events` 不裁剪；保留规模、磁盘与长期性能需 M03 压测/M07 运维方案测量，不能静默删除会使游标缺号的行。本片的真实 PG/HTTP 自检不代替 G01/G07/G08 与 M03 独立完整验收。

### 10.18 M03 Review/Resume 持久顺序片（2026-09-24，已分片独立验收）

**Breaking Change: No（公开 HTTP）。** `POST /api/v1/workspaces/{workspace_id}/reviews/{review_id}/decisions` 保留原 `command_id/expected_revision/target_hash/decision`、原 200 回执与 `effect.external_effect_executed=false` 的真实语义；同 `command_id` 同载荷重放原决定与回执，不新增 RESUME，不同命令不能再次决定已关闭 Review。原 Bearer、Host/Origin 与 Workspace 隔离保持不变；跨 Workspace Review 仍按 404 隐藏。Review 与目标/内容 hash/策略版本不匹配、过期或拒绝不会派发外部效果。

有效的 Run `CRITERION`/`RETRY_BUDGET`/`CHECKER_RETRY` 决定若把等待中的 Run 变为可运行，在**同一短事务**持久化唯一的 Review 绑定 RESUME、outbox 与命令回执；前驱 START 必须 DONE、旧 invocation 必须 IDLE 才可领取。审批可能快于旧 START 结清，旧投递不能借此执行 COMPLETE。`ACTION_APPROVAL` 的有效批准也保存一个绑定原 Review 决定的 RESUME 意图；本顺序片当时的固定 Worker 尚不领取，随后固定 Mock Gateway 图节点的当前行为见 10.20。此类 200 回执始终只表示“决定已记录，效果待执行”，不表示工具动作成功。拒绝或过期的 ACTION_APPROVAL 不生成 RESUME。`USER_IMPORT` 的 ACTION_APPROVAL 不绑定 Run，仍由原 Gateway 路径处理。

`POST /api/v1/workspaces/{workspace_id}/runs/{run_id}/resume` 的请求、202 回执与权限不变。手工 PAUSED→可运行状态现在在同一事务持久化 RESUME/outbox/回执；PAUSED→WAITING_APPROVAL 仅恢复人工等待，不生成 Worker 命令。旧 invocation 尚未释放时返回 409 `INVALID_TRANSITION`，客户端读取当前 Run/控制投影后再决定；这避免暂停后立刻恢复与旧 Worker 重叠。新增顺序只作用于内部 PostgreSQL 命令运输，不向客户端暴露 ordinal 或内部 command UUID。本片未接 LangGraph/PostgresSaver，固定 Mock 路径和真实 Provider 的边界不变。

若 ACTION_APPROVAL 已 APPROVE、效果尚未准入，随后 PAUSE/CANCEL/HANDOFF 在安全点应用，原 operation 转为 DENIED，并在同一 Task→Run 事务把该批准绑定的 deferred RESUME 投递结清；Review 决定、原 operation_id 与命令历史保留。此处 outbox `DONE` 仅表示失效投递已撤回，**不表示外部效果成功**。后续手工 RESUME 的更高 ordinal 因而不会被旧批准永久阻塞。旧 START 遇到已提交的新批准和待处理控制时，先处理控制，再结清自身投递。Gateway 领取批准动作时与 Admit 均核对有效期、Connection 和 Permission 当前版本；领取后至 Admit 前若撤权，在无 Invocation/外部效果且 worker epoch 仍匹配时释放 Worker claim，供控制安全点撤回旧批准。领取前发现批准失效也不产生 Worker 占用；Run 仍显示原等待事实，用户可通过现有 PAUSE/CANCEL/HANDOFF 控制收敛，当前不自动生成新 Review。已 DISPATCHING/UNKNOWN 的动作不走这条释放路径，仍按原 operation_id 核对。本片独立验收范围见 [M03 记录](../testing/m03-independent-acceptance.md)。

### 10.19 M03 Task 产物历史读取（2026-09-24，已分片独立验收）

**Breaking Change: No。** 新增 `GET /api/v1/workspaces/{workspace_id}/tasks/{task_id}/artifacts`，不改变原保存、单件读取、内容下载或完成命令。沿用本机 Bearer、Host/Origin 与 Workspace 作用域；不存在或跨 Workspace 的 Task 返回 404，同 Workspace 的空 Task 返回 `200 {"items":[],"current_accepted_version_ids":[]}`。每个 `items[]` 使用现有 `GET /artifacts/{id}` 的安全 DTO，按 `(created_at,id)` 升序列出全部 Artifact；各 Artifact 内按版本号列出不可变版本摘要，不返回受管路径或正文。

`current_accepted_version_ids` 仅从 Task 当前 `current_completion_id` 指向的 CompletionRecord `state_delta.artifact_version_ids` 读取；重开后当前指针清空，返回空集合但保留 `items` 历史。`latest_version_id` 是 Artifact 的最新版本，Project State 的 `selected_artifact_version_refs` 是项目“当前选用”，两者均不能推断为本轮接受。读取使用同一数据库快照，避免并发完成/重开期间混合指针与列表。React 仅在此查询成功后决定 create 或按确切 Artifact revision append；查询失败保留草稿并禁用保存/完成。定向真实 PG、浏览器刷新和当前输入摘要见 [任务产物自检](../../apps/workbench/results/m03-task-artifacts-evidence.txt)，该开发结果不等于 M03 总验收。

### 10.20 M03 固定 Mock Gateway 图动作（2026-09-24，已分片独立验收）

**Breaking Change: No。** `POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/delegations` 可选增加 `mock_gateway_action: {connection_id, resource_id, target, content}`（两个 ID 为 UUID，目标字符串最多 4096 字符，内容最多 1024 字符）；不传字段的旧客户端仍走原固定 Markdown 流程，202 回执与 `command_id` 幂等语义不变。字段随 Run 契约冻结并分配唯一内部 `operation_id`；Delegate 202 仅表示意图持久化，不授予该连接/资源的动作权限。Gateway 在 Prepare/Admit 时核对规范目标、参数/hash、Connection、Permission、策略和批准有效期；跨 Workspace 或无权访问不会因持有 ID 而准入。

带此意图的固定图在 DRAFT 后、候选 PERSIST/VERIFY/COMPLETE 前进入正式 Gateway。ASK 会持久化原 `operation_id` 和 ACTION_APPROVAL Review，旧 START 结清且释放 invocation；APPROVE 的 200 回执仍为 `external_effect_executed=false`，只有绑定该确切 Review/决定/operation 的 RESUME 且前驱 DONE、执行槽 IDLE 时才可领取。没有同 operation_id 冻结 Mock 意图的旧 P07 预留审批和 P09 直接 Gateway 路径保留原决定/直接动作语义，不生成无法由固定图消费的自动 RESUME。DENY 保留 Review/operation 历史，并把必需的冻结 Mock 动作 Run 置 FAILED、Task 返 READY，不生成工具效果或悬挂等待。准入前撤权/到期若可证明没有 Invocation/外部效果，同一业务安全点拒绝原 operation 并使 Run 失败；已 DISPATCHING/UNKNOWN 的原动作仍按原身份核对，不能以新 ID 重发。已成功的原效果即使随后批准到期，也只作同身份只读恢复与后继步骤推进，不借过期批准派新效果。旧 ACTION RESUME 遇到后继验证 Review 只能结清自身，不能唤醒后者。

PAUSE/CANCEL/HANDOFF 的持久控制在旧 START/RESUME 安全点优先；外层 invocation 未释放时仍为 PENDING，不提前显示 APPLIED。结清释放后立即尝试应用，supervisor 还从 PG 扫描已空闲的 PENDING 控制，以覆盖结清与应用之间进程退出。PAUSE 已撤销必需工具批准后，手工 `/runs/{run_id}/resume` 返回 409 `INVALID_TRANSITION`，保留 PAUSED 和旧 operation 历史，不复活批准或产生悬挂 RUNNING。该片交付时 Run 查询尚未投影 Gateway UNKNOWN；后续 G03 查询与 UI 的当前行为见 10.21。

冻结 Mock 图动作在 Gateway Admit 的同一 authority→Task→Run 短事务内复核 DRAFT 使用的 Context Manifest。审批等待期间 Task 标题、验收版本、Project 或 Workspace Context 来源变化时，准入返回内部 `GATEWAY_CONTEXT_STALE`，未调用 Fake 适配器；原 operation 保留为 DENIED，Run/Task 按既有拒绝路径收敛。此检查只作用于冻结契约中相同 `operation_id` 的 Mock 图动作，不改变 P09 直接 Gateway 的准入前提。效果已成功后发生的来源变化不重做原 BUILD_CONTEXT/DRAFT，也不借新身份重发。

### 10.21 M03 Run 未决动作查询（2026-09-24）

**Breaking Change: No。** `GET /api/v1/workspaces/{workspace_id}/runs/{run_id}` 沿用原路由、鉴权和响应字段；`unresolved_operation_ids` 现在合并 P08 未结清效果与本 Run 的 Gateway `UNKNOWN` 原 `operation_id`，去重后返回。只读取当前 Workspace 的 Run，不返回另一 Run、另一 Workspace 或 `USER_IMPORT` 动作，也不返回受管路径与效果正文。该字段是“待核对动作 ID”集合，不把每个条目都断言为已发生的外部效果；查询不会自动重发、改变隔离状态或代替恢复核对。React Run 页显示原 ID 和禁止盲重试的提示，仍需读取权威动作证据后才可判断结果。

### 10.22 M03 在途 Mock 取消（2026-09-24）

**Breaking Change: No。** 原 Run 控制请求及 AI Task 取消路由、请求版本、`command_id` 和 202/PENDING 回执保持不变。独立 Worker 在长时间 DRAFT 期间观察已提交的控制请求，取消当前 Mock 模型等待并停止后续图步骤；这不把 202 直接解释为 APPLIED。监督器观察旧子进程退出并核对原 Attempt/效果后，安全点才把控制转为 APPLIED，并由现有 Run/Task 查询返回最终状态。没有外部效果的中止不会产生候选或完成记录；已派发效果仍用原 `operation_id` 核对，UNKNOWN 不因取消而被改写成成功或用新身份重试。Windows 进程强制终止按停机恢复处理，不伪造用户取消。

### 10.23 M04 显式 Context 来源选择（2026-09-25，开发自检）

**Breaking Change: No。** `POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/delegations` 可选增加 `context_sources: [{kind, root_id, version}]`（`kind` 限 `KNOWLEDGE`/`MEMORY`/`DECISION`，`root_id` 为 UUID，`version` 为正整数十进制字符串，数组最多 10 条）；不传字段的旧客户端行为不变，202 回执与 `command_id` 幂等语义不变。字段随 Run 契约冻结为 `context_sources`，引用的是具体不可变版本而非根的当前版本。

Delegate 在同一事务内校验每条选择：根必须存在于同一 Workspace、状态为 `ACTIVE`、Project 作用域匹配（无 Project 根可配任意同 Workspace Project 的 Task），且引用版本确实存在；重复条目去重。未知根/版本或跨 Workspace 返回 404 `RESOURCE_NOT_FOUND`，已停用根返回 409 `INVALID_TRANSITION`；校验失败不创建 Run，Task 保持 READY。超过 10 条返回 409。

BUILD_CONTEXT 装配时显式选中资料以 `EXPLICIT_SELECTION` 原因优先装配，读取的正是冻结引用的不可变版本（即使根已有更新版本）；存在显式选择时不再做 `RECENT_SCOPE_FALLBACK` 最近资料补位（最小必要输入），同作用域 `TITLE_MATCH` 检索按设计保留，同一根不重复装配。构建期根已停用、版本缺失或内容不可核对时，按 Relevant 既有语义记 `SOURCE_UNAVAILABLE` 排除，不阻断 BUILD_CONTEXT，也不把冻结引用改写为其他版本。预算内显式来源与其他 Relevant 一致可被 `BUDGET_TRIMMED` 裁剪并记录。该入口尚无前端管理页，真实 Provider 外发仍保持关闭；本节为开发自检结论，不是 M04 验收结论。

### 10.24 M04 FILE_READ 真实文件只读适配器（2026-09-25，开发自检）

**Breaking Change: No（`POST /projects/{project_id}/connections` 可选新增 `root_path`）。** Gateway 新增首个真实适配器能力 `FILE_READ`（动作类型 `READ_FILE`，RUN 来源，`adapter_kind='REAL'`）。创建连接时若包含 `FILE_READ` 必须提供 `root_path`（绝对路径、现存目录），连接配置只保存其 realpath 规范根；其他能力仍要求空配置，不存凭据。非 FILE_READ 连接携带 `root_path` 返回 400。Permission 沿用既有分表机制：策略按 `READ_FILE` + 资源规范根前缀判定 AUTO/ASK/DENY，默认 DENY。

Prepare 规范化目标：目标必须绝对路径、位于登记资源根内，realpath 解析后仍须在根内（拒绝路径穿越、符号链接/junction 逃逸与重定向），且必须是现存普通文件；不存在或不可规范化按 `GATEWAY_TARGET_DENIED` 拒绝，动作类型只接受空参数。Execute 在读取前重新 realpath 比对冻结路径（防准入后链接替换），并受调用方 deadline 与 AbortSignal 约束：超过 128 KiB 返回 `FILE_TOO_LARGE`，含 NUL 字节返回 `FILE_BINARY_UNSUPPORTED`，目标被替换返回 `GATEWAY_TARGET_CHANGED`，deadline 已过返回 `GATEWAY_DEADLINE_EXCEEDED`；结果记录目标、字节大小、全文 SHA-256 与正文。读取是幂等无副作用动作：类型化失败按 `FAILED` 结算并释放资源 claim（不隔离），仅崩溃等不确定情形保持 DISPATCHING 由恢复核对。

恢复核对（reconcile）对 FILE_READ 采用安全重读：`PREPARED` 未开始调用保持 `NOT_EXECUTED`（操作回 PREPARED，由同一原身份继续派发）；在途/未知调用重新读取，成功以新读取结果（含新 hash）结算 `SUCCEEDED`，目标缺失或不可读结算 `FAILED`——两者都释放 claim，文件读不产生 UNKNOWN 隔离状态。准备另一动作时若本 Run 仍有未决动作，沿用 `GATEWAY_OPERATION_UNRESOLVED` 拒绝。0014 migration 只放宽上述受守卫形态，未改写历史 migration。本节为开发自检结论；真实 Windows 会话验证未执行。

固定图已接入文件读意图：`POST /tasks/{task_id}/delegations` 可选增加 `file_read_action: {connection_id, resource_id, relative_target}`（与 `mock_gateway_action`、`web_fetch_action` 互斥，任两个同给则 409）；冻结为契约内 `file_read_action` 并分配唯一内部 `operation_id`。新 Run 在 BUILD_CONTEXT 成功后、DRAFT 模型调用前经同一 Gateway 准入派发读取：AUTO 直接执行，ASK 等待原 ACTION_APPROVAL，只有绑定原 Review/operation 的 RESUME 才读取；DRAFT 在成功读取前不建立模型调用。升级前已经成功的 DRAFT 仍按原 DRAFT 后读顺序完成，不重跑草稿或换动作身份。读取结果（正文、字节大小、全文 SHA-256）持久化在 Invocation `result_ref`，DRAFT 只消费有界、标记 `UNTRUSTED_DATA` 的文本与来源身份；读取不改写目标文件。ASK 等待期间 Context 来源变化时 Admit 前拒绝（`GATEWAY_CONTEXT_STALE`）。目标在冻结后缺失属于确定性拒绝：prepare 阶段抛 `GATEWAY_TARGET_DENIED`，不创建 operation/invocation，投递失败由监督器重排，文件就绪后同一命令继续成功；永久缺失的重排上限属后续工作。审批/控制/恢复路径的冻结意图识别统一为 `readMockActionOperationId`。

### 10.25 M04 Assist 会话与类型化提案（2026-09-25，开发自检）

**Breaking Change: No（新增 Assist 资源族；后续用量字段变化见 §10.28）。** Assist 只服务对话与提案：不创建 Run、不持有 Task 执行权、不直接写业务事实（runtime-context.md 第 5 节）；`0015_m04_assist` 新增 `assist_sessions`/`assist_messages`/`assist_proposals` 三表并授予 `relay_app` 最小写权限。

2026-09-30 M04 失败诊断增量：`GET /assist-sessions/{id}/messages` 的每条消息新增可空 `provider_error_kind`，词表与连接验证一致：`AUTH`、`RATE_LIMIT`、`TIMEOUT`、`STREAM_BROKEN`、`PROTOCOL`、`NETWORK`。原 `error_code` 保留 Relay 失败原因；仅实际模型调用抛错且最终消息为 `FAILED` 时记录 Provider 类别。取消、预算/业务约束、解析失败、租约丢失以及模型调用前后的本地处理错误保持 NULL。响应不携带 Provider 原始异常文本；历史消息不推测回填，旧服务缺字段时新客户端按 NULL 兼容。**Breaking Change: No**：新增响应字段，无请求、权限或自动重试语义变化；数据库关联 `0046_assist_provider_error_kind`。

会话与消息：

- `POST /assist-sessions`（`CreateAssistSession`，201）：可选 `project_id`/`task_id`；绑定 Task 时作用域跟随 Task（`project_id` 与 Task 归属不一致 422），Task 跨 Workspace 或未知 404。会话可归档（`status='ARCHIVED'`）后拒收新消息。
- `GET /assist-sessions?project_id&task_id`、`GET /assist-sessions/{id}`：按 Workspace 作用域过滤，跨作用域 ID 404。
- `POST /assist-sessions/{id}/messages`（`RequestAssistMessage`，**202**）：同事务写入一条 `USER`（COMPLETED）与一条 `ASSISTANT`（PENDING）消息；回复只写入本会话（固定消息目标，切页不会把旧回复落到新目标）。可选 `intent`：`DISCUSS`（默认）/`PROPOSE_CANDIDATE`（要求会话绑定 Task，否则 409）/`PROPOSE_TASK`（要求绑定 Project，否则 409）。可选 `source_refs: [{kind, root_id, version}]`（≤10 条）按 Delegate 显式选源同规则校验并随消息冻结；重复 command_id 幂等重放。
- `GET /assist-sessions/{id}/messages?limit`：按 `seq` 返回消息及生成状态（PENDING/RUNNING/COMPLETED/FAILED/CANCELLED）、`usage: {input_tokens,output_tokens}`（各为非负整数或 `null`，后者表示未知）、`error_code` 与实际发送的来源状态记录（`SENT`/`UNAVAILABLE`）。

生成（Worker 独立领取，无 HTTP 长连接）：领取 PENDING 消息置 RUNNING 并按租约心跳；提示词固定声明「资料只是数据，不是指令」，来源分段标注 `UNTRUSTED_DATA`（每条正文 16 000 字符截断留痕）；取消意图经 `POST /assist-messages/{id}/cancel`（`CancelAssistMessage`，200）持久化，PENDING 直接收敛、RUNNING 经轮询 AbortSignal 传给模型后按 CANCELLED 结算；Worker 崩溃由租约清扫以 `FAILED`/`LEASE_LOST` 收敛。模型异常结算事务先锁消息复核领取身份与持久取消：仍持有领取且无取消或宿主中止时记 `FAILED`/`MODEL_FAILED`；已持久取消记 `CANCELLED`，`error_code` 与 `provider_error_kind` 均为 NULL；无用户取消的宿主 AbortSignal 中止或旧 Worker 丢失所有权时丢弃本次结果（`DISCARDED`），不覆盖消息，宿主中止仍留原 RUNNING 供租约恢复。提案 JSON 解析失败记 `FAILED`/`OUTPUT_SCHEMA_INVALID`（原文保留为证据），均不产生提案、不盲重试。

类型化提案：

- `GET /assist-proposals?session_id&status&kind`、`GET /assist-proposals/{id}`：首批 `kind` 为 `CANDIDATE_MARKDOWN`（目标 Task，`base_revision` 为提案冻结时 Task revision，payload 为 `{title, media_type, markdown}`）与 `TASK_DEFINITION`（目标 Project，`base_revision` 为冻结时 Project revision，payload 为 `{title, objective, criteria[], expected_outputs}`）。
- `POST /assist-proposals/{id}/accept`（`AcceptAssistProposal`，200）：在**同一事务**内复用用户手动命令的事务内效果（`CreateArtifactWithVersion`/`CreateTask` 的 prepare+apply），校验路径与手动调用完全一致；回执、提案 ACCEPTED 与业务效果原子提交。`base_revision` 已前进时业务校验以 409 `REVISION_CONFLICT` 拒绝，提案同事务收敛为 `EXPIRED` 后提交。同一 `command_id` 重放返回原回执（幂等，不产生第二次效果）；不同 `command_id` 再次接受 409。Task 被 AI 占有（DELEGATE_AI）时接受按人工路径同语义被拒（409），讨论不受影响。
- `POST /assist-proposals/{id}/reject`（`RejectAssistProposal`，200）：PENDING→REJECTED，重复拒绝幂等。

Assist 消息行保留最近一次生成可得的用量，未知为 `null`；每次模型调用的独立事实及兼容性见 §10.28。真实模型 opt-in 端到端见 real-model 集成测试；本节为开发自检结论，不是 M04 验收结论。

### 10.26 M04 WEB_FETCH 公共网页只读适配器（2026-09-25，开发自检）

**Breaking Change: No（`POST /projects/{project_id}/connections` 可选新增 `allowed_host`/`allow_private`；Permission 命令可选新增 `host`）。** Gateway 新增第二个真实适配器能力 `WEB_FETCH`（动作类型 `WEB_FETCH`，RUN 来源，只读）。创建连接时若包含 `WEB_FETCH` 必须提供 `allowed_host`（无 scheme/路径/端口的 DNS 主机名，存库统一小写），可选 `allow_private: true` 显式登记允许解析到保留地址（用于受控环境）；`allow_private: false` 不落库（缺省即拒绝）。FILE_READ 与 WEB_FETCH 互斥于同一连接（一个 REAL 连接只绑一个边界）；`host` 与 `root_path` 同给 400。Permission 命令对 WEB_FETCH 要求 `host`（`resource_id` 必须为空），策略目标前缀即主机名——主机是路径前缀在 Web 上的对应物；默认 DENY。

同 Project 已授权的 `GET /projects/{project_id}/connections` 与 `GET /projects/{project_id}/connections/{id}` 只读 DTO 增加 `allowed_host: string | null`（**Breaking Change: No，新增可选消费字段**）。WEB_FETCH 返回连接创建时规范化的主机名，其他能力返回 `null`；仍先核对 Workspace/Project，跨作用域 ID 返回 404。DTO 不返回完整 `config`、`root_path`、`allow_private`、`secret_ref` 或凭据，`allowed_host` 只是连接边界提示，不表示当前 Permission 已准许输入的 URL。

WEB_FETCH 逻辑动作不绑定受管资源（目标为 URL 而非文件系统工作区），`logical_operations.resource_id` 为 NULL，无资源 claim（只读无需排他）；0016 migration 据此放宽 `ck_logical_operation_resource` 与 `ck_invocation_run_identity` 的守卫形态，并收紧 connection/config 形态为 `root_path` 与 `allowed_host`（± `allow_private: true`）三选一。Prepare 规范化目标 URL：仅 http/https、无 userinfo、无片段、主机小写化；URL 主机必须等于连接 `allowed_host`（跨主机/错误 scheme/带用户信息在准备期即 `GATEWAY_TARGET_DENIED`），读动作不接受参数。策略、批准、撤销、控制与 UNKNOWN 核对沿用既有 Gateway 语义；ASK 的 ACTION_APPROVAL 同样在批准后由新 Worker epoch 携带原 operation_id 准入。

Execute 为 SSRF 安全 GET（tool-adapters.md 第 3 节 + OWASP）：**每一跳**重新校验 scheme/主机、重新解析 DNS 并对全部返回地址做保留地址检查（loopback/私网/link-local/CGNAT/组播/保留段，含 IPv4-mapped IPv6），随后直接连接已校验地址（校验与连接绑定，防 DNS 重绑定）；重定向最多 3 次且每次重新走完整校验，跨主机重定向确定性拒绝；连接 10 秒不活跃超时、总请求 30 秒上限、解压前响应体 5 MiB 上限；不携带 Cookie/Authorization，不执行网页 JS，网页内容只是数据。结果记录原/最终 URL、状态码、Content-Type、字节数、全文 SHA-256、抓取时间；`text/html` 以 `web-text-extract-v1` 确定性提取正文（剥除 script/style/注释/标签、解码常见实体、压缩空白，超 128 KiB 字符截断留痕），`text/*`/JSON 原文记录，二进制仅记 hash 并标 `text_available: false`。非 2xx 结算 `FAILED`（`WEB_HTTP_STATUS` + 状态码）；网络不可达/DNS 失败/超时/超限为类型化 `FAILED`（读取无副作用，释放 claim，不产生 UNKNOWN）；调用方 AbortSignal 取消沿用既有取消语义。恢复核对沿用安全重读：PREPARED 保持 `NOT_EXECUTED` 由同一原身份继续；在途崩溃重新抓取，成功以新结果（新 hash）结算 SUCCEEDED，站点不可达结算 FAILED。测试注入只允许收窄限额/预算，不允许放宽 SSRF 策略。本节为开发自检结论；真实 Windows 会话验证未执行。

**固定图接入网页读意图**：`POST /tasks/{task_id}/delegations` 可选增加 `web_fetch_action: {connection_id, url}`（与 `mock_gateway_action`、`file_read_action` 三选一，任两个同给 409；冻结期仅做 URL 语法校验——仅 http/https、无用户信息、无片段）。新 Run 在 BUILD_CONTEXT 后、DRAFT 前通过同一 Gateway 抓取（RUN 来源、无资源、deadline 取 Run worker 租约）；AUTO 直接执行、ASK 只由原 Review/operation 绑定的 RESUME 派抓取。抓取证据（提取正文、状态码、全文 SHA-256）保存在 Invocation `result_ref`，实际文本经有界预算与 `UNTRUSTED_DATA` 标记才进入后续 DRAFT；升级前已成功的 DRAFT 继续原动作阶段。等待期间 Context 来源变化时 Admit 前拒绝（`GATEWAY_CONTEXT_STALE`→operation DENIED→Run FAILED/Task READY，无 Invocation）。冻结 URL 主机不在连接 `allowed_host` 内为确定性拒绝：prepare 抛 `GATEWAY_TARGET_DENIED` 且不创建 operation/invocation，投递失败由监督器重排；主机失配需取消旧 Run 后重新委派，冻结期主机预校验仍属后续工作。

### 10.27 M04/P17 URL 导入 Job 到 Knowledge（2026-09-26，开发自检）

**Breaking Change: No。** `POST /api/v1/workspaces/{workspace_id}/projects/{project_id}/import-jobs` 接受 `{command_id,url,connection_id}`，创建返回 201 命令回执，`result={import_job_id,project_id,connection_id,status:"QUEUED"}`；同一 `command_id` 和规范化请求重放原回执，异载荷沿原命令冲突语义拒绝。URL 仅支持 http(s)、无 userinfo/片段，连接必须属于同一 Workspace/Project、处于 ACTIVE 且具备 WEB_FETCH 能力。创建只冻结来源和连接，不表示已抓取或已取得权限。

后台 Worker 扫描受连接约束的 QUEUED Job，经同一 Gateway 以 `USER_IMPORT` 来源准备 WEB_FETCH；AUTO 派发，ASK 创建绑定原 `operation_id`、URL、连接与策略版本的 ACTION_APPROVAL，批准的 200 回执仍不表示已抓取。Gateway Admit 再校验活动 Connection/Permission，执行逐跳 SSRF 检查和有界只读 GET。网页无可提取文本时 Job 为 FAILED（`WEB_TEXT_UNAVAILABLE`）；成功时同一短事务创建不可变 `WEB_PAGE` KnowledgeVersion、递增 Context revision，并把 Job 结算为 SUCCEEDED 且写入 `knowledge_version_id`。来源记录原/最终 URL、抓取状态、字节数、原响应 SHA-256、时间、提取器、截断标记和原 `operation_id`。提取正文 UTF-8 最多 256 KiB；不运行网页脚本，也不把网页内容当指令。

`GET /api/v1/workspaces/{workspace_id}/import-jobs/{import_job_id}` 返回 `id,project_id,actor_ref,config_version,source_uri,status,revision,error,knowledge_version_id,request_command_id,created_at`；跨 Workspace 的 ID 返回 404。既有 `/import-jobs/{id}/operations` 可查询动作与 Invocation 证据。Worker 重扫 `RUNNING` 且尚未准备动作的 Job，使用同一 Job/intent 推导的稳定 `operation_id`；Gateway 已结算 SUCCEEDED/FAILED 而 Job 未结算时，下一 tick 沿原 operation 证据补提交 Knowledge/失败状态，不再次派发抓取。上述窗口已用真实 PostgreSQL 定向回归；已进入 DISPATCHING 而未写结果的导入仍需受信停机证据后走 Gateway 安全重读核对，当前后台 tick 不自动作此证明。本节不构成 M04 独立验收或 Windows 桌面验收。

### 10.28 M04 模型调用计量与 Assist 用量兼容性（2026-09-26，开发自检）

**Breaking Change: Yes（现有 Assist 消息 DTO 的用量子字段从 `number` 扩为 `number | null`）。** `GET /assist-sessions/{id}/messages?limit` 的消息仍返回 `usage: {input_tokens,output_tokens}` 与 `provider_request_id`，字段名、层级及其他状态码不变；两个 token 值分别是非负整数或 `null`。`null` 表示 Provider 未报告、调用尚无结局或该消息没有模型调用，不表示精确 0。客户端须容忍 `null` 并展示“未知”；若按原非空数字 schema 解析，需要同步升级。历史双 0 因无法区分真实零和未知，迁移保守置为 `null`，正数保留。此 DTO 没有向客户端新增计费总额或调用 ID。

`0018_m04_model_calls` 将每次 DRAFT、SemanticChecker、Assist 的实际 Fake/真实模型调用独立登记：`call_id`、原 StepAttempt 或 AssistMessage、非敏感 Provider/模型标识、可得的 request id、状态与已知或未知 token 数。重入产生新行；进程失去结果时留下 STARTED，不当作成功或零费用。语义检查结果证据可带 `model_call_id`；该事实表目前只有内部数据库查询，没有新增公开 HTTP 端点，不改变 Run/Assist 业务状态机。真实 Provider 外呼未在本轮执行，本节仍属开发自检。

2026-09-30 工具输出拒绝的证据保全修复（**Breaking Change: No**）：模型返回原生工具参数或非文本内容时仍由 Adapter 拒绝，不执行工具；已有 `provider_request_id` 与 `usage` 字段保留拒绝前实际观察到的请求 ID 和合法规范化用量，缺失 ID、未观察用量保持 null，不复制工具参数、原始响应或异常正文。`ModelToolOutputError` 属于能力边界，消息的 `provider_error_kind` 仍为 null。先收到正文再拒绝时，失败结算删除临时预览，原调用已记录的首文本/首预览时间保留。当前 SDK 的 SSE 用量在流结束时才形成规范化 chunk，提前拒绝不推算未消费的 wire 用量。字段、状态码、取消/重试/完成权限不变；实际范围见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

`0019_m04_draft_read_input` 为新 DRAFT 调用增加结构化输入 SHA-256 与原 `read_operation_id`/`read_invocation_id`（旧行保持 NULL）；操作历史的原正文不复制到计量表。FILE_READ/WEB_FETCH 成功证据按最多 16 KiB UTF-8 完整字符截取，并在 DRAFT 前按原 Manifest 估算口径计入预算；原正文 SHA-256、提取文本 SHA-256、实际片段 SHA-256 和 `UNTRUSTED_DATA` 标记随模型输入建立。额外元数据仍超预算则 DRAFT 以 `CONTEXT_REQUIRED_OVER_BUDGET` 失败且零模型调用。已结算类型化读取 `FAILED` 保留原操作和调用证据，Run 进入 FAILED、Task 释放回 READY；待处理控制意图仍先按安全点处理，`UNKNOWN` 仍需核对。**Breaking Change: No**：Delegate 参数、Run/Gateway HTTP DTO 与既有错误结构不变；本次改变的是新 Run 的内部动作顺序与模型输入。旧 DRAFT 已成功的 Run 保留旧顺序及原批准/操作身份。

### 10.29 M05/P13 Today 与个人选择（2026-09-26，后端开发自检）

**Breaking Change: No。** `POST /tasks/{task_id}/planning-metadata` 接受 `{command_id,expected_revision,priority,due_local_date,timezone}`；三个元数据字段必给，可分别用 `null` 清空，但日期/时区必须同空或同有。priority 为 `LOW/NORMAL/HIGH/null`，日期为真实 `YYYY-MM-DD`，时区为有效 IANA 名称。返回 200 原命令回执 `result={task_id,status,revision}`；Task 单读/列表增加 `priority,due_local_date,timezone`，元数据更新只推进 Task revision，不改变 acceptance_revision。历史 Task 的新字段为 NULL。

`GET /today?date=YYYY-MM-DD&timezone=IANA` 返回 `date,timezone,selection_revision,focus,focus_has_eligible_candidate,eligible_items,waiting_items,blocked_pinned_items`。`focus` 可为 null，否则含原保存的 `date,timezone,target_kind,target_id,selection_revision,active_in_query`；同日期换查询时区仍返回原 Focus，只在时区完全匹配时用于排序。每条 Task 项返回 `task_id,task_revision,project_id,title,status,priority,due_local_date,timezone,pin,later_local_date,later_timezone,reason_codes,evidence_refs,allowed_actions`。`blocked_pinned_items` 是 `waiting_items` 中已 Pin 但不合资格的子集。查询只读；先按 HUMAN 且 READY/IN_PROGRESS、验收条件、BLOCKS 依赖、未解除 blocker、Later 截止过滤，再将合格项按 Focus→Pin→到期→priority→Project Next Action→人工进行中→created_at（早者先）→id（升序）排序。AI 占有和其他不合资格 Task 只在 waiting 区；无 Project 人工 Task 合法参与。Goal Focus 按 Task 的 INHERIT 当前 ProjectGoal 或 EXPLICIT 显式集合判定，显式空集不继承。

`POST /task-selections/{task_id}` 接受 `{command_id,expected_revision,pin,later_local_date,timezone}`，Pin 与 Later 一次提交，`pin=false` 且 Later 双 NULL 即清除该选择；`POST /focus-selections` 接受 `{command_id,expected_revision,date,timezone,target_kind,target_id}`，目标为 `GOAL/PROJECT/TASK` 与同 Workspace UUID，目标种类和 ID 同为 NULL 清除该日 Focus。两个命令的 expected_revision 都指向 Workspace 级 `selection_revision`，成功 200 回执 `result={selection_revision}`，与 Task revision/acceptance_revision 独立；同 command_id 同载荷重放原回执，过期版本 409 `REVISION_CONFLICT`，跨 Workspace 目标 404 `RESOURCE_NOT_FOUND`，无效日期/时区或成对字段 422 `VALIDATION_FAILED`。Focus 按 Workspace + 日期最多一项，修改其他时区保存的当日 Focus 必须显式提交并通过 revision 栅栏。Later 在保存时区当地 00:00 对应的绝对时刻到期；查询日期按请求时区当地 00:00 观察，跨午夜无需后台任务。此切片未做 M05 独立或 Windows 桌面验收。

### 10.30 M05/P15 Activity、Run Trace 与 Artifact Lineage（2026-09-26，后端开发自检）

**Breaking Change: No。** 以下均为新增只读端点，位于 `/api/v1/workspaces/{workspace_id}` 下，沿用本机 Bearer、Host/Origin 与 Workspace 隔离；不存在或跨 Workspace 的 Project、Task、Run、ArtifactVersion 筛选目标返回 404 `RESOURCE_NOT_FOUND`，不通过计数或游标透露另一 Workspace。无公开 Lineage 写入端点。

`GET /activities?project_id=&task_id=&run_id=&from=&to=&cursor=&limit=` 按 `(created_at,id)` 倒序返回 `{items,next_cursor}`，`limit` 缺省 30、上限 100；`from` 含、`to` 不含，均要求 UTC RFC3339 时间，且 `from < to`。游标绑定 Workspace 与全部筛选条件；换筛选条件、畸形游标返回 400 `INVALID_CURSOR`，无效时间或超范围 limit 返回 422 `VALIDATION_FAILED`（不符请求 schema 的格式由统一 400 校验处理）。条目仅含 `id,created_at,actor_kind,actor_ref,command_id,event_type,summary,project_id,task_id,run_id,entity_refs[{kind,id}]`；`entity_refs.kind` 限 `PROJECT/TASK/RUN/GOAL/ARTIFACT_VERSION/REVIEW/COMPLETION/VERIFICATION_SESSION`，引用先核对当前 Workspace。摘要使用事件类型白名单，未知类型为通用文字；不返回原 `fact_refs`、自由正文或未识别 actor_ref。

`GET /runs/{run_id}/trace` 返回 `run_id,task_id,project_id,status,steps,attempts,model_calls,manifests,verifications,reviews,operations,effects`。Step/Attempt、模型调用、验证目标与 Check、Review 决定、Gateway Operation/Invocation、受管效果均来自原事实；`result_available` 仅表示有结果引用，不能当作成功。`reviews[].decision` 与 `operations[].status`/`effects[].status` 分开，批准本身不表示动作执行。Manifest Sources 只给 `kind,source_ref,version,sha256,source_sha256,role,trust,availability`；按当前可读作用域和确切历史版本核验，失效或越权时 `availability=UNAVAILABLE` 且引用/hash 为 null。模型提示词/响应、隐藏思考、Gateway 参数/结果正文、受管路径和凭据不出 DTO。

2026-09-30 M04 调用诊断增量（**Breaking Change: No**）：`model_calls[]` 补充原账本的 `kind,criterion_id,check_attempt,provider_request_id` 和封闭词表 `provider_error_kind`。仅原调用 `status=FAILED` 且原 `error_kind` 属于 `AUTH/RATE_LIMIT/TIMEOUT/STREAM_BROKEN/PROTOCOL/NETWORK` 时返回类别，其余为 null；不返回任意错误名或原异常正文，不按异常文案猜测旧记录。每行仍绑定原 `id,step_attempt_id,manifest_id`，语义检查保留确切条件和检查尝试，不合并不同调用。缺失的请求身份、条件、用量保持 null。旧客户端可忽略新增字段，新客户端对旧服务缺字段按未知处理；这只是历史调用证据，不改变 Run、Attempt、检查器重试、Review 或完成语义。实际运行结果见[接续记录](../development/ui-live-integration-2026-09-28.md)。

`GET /artifact-versions/{artifact_version_id}/lineage` 返回 `artifact_version_id,artifact_id,version_number,sha256,source_kind,content_availability,direct_parents[]`；直接父边含 `id,relation,parent_kind,parent_id,availability,created_at`。关系仅 `DERIVED_FROM/REVISED_FROM/GENERATED_BY/VERIFIED_BY/ACCEPTED_BY`，父种类依关系限 `ARTIFACT_VERSION/KNOWLEDGE_VERSION/RUN_STEP/VERIFICATION_SESSION/COMPLETION_RECORD`。源不可读、正文丢失或 hash 不符时保留边但 `availability=UNAVAILABLE,parent_id=null`，不拿当前版本代替历史来源。上述新接口已做真实 PostgreSQL 定向开发回归，尚未做 M05 独立或 Windows 桌面验收。

2026-09-30 M04 首输出追溯增量（**Breaking Change: No**）：Run Trace 的 `model_calls[]` 追加可空 ISO 时间 `first_text_delta_at`、`first_preview_persisted_at`。前者是当前合法 DRAFT/普通无 Skill 的 Assist DISCUSS 首次非空文本回调的观察时间，后者是首个预览成功事务内的写入时间；同调用后续更新不覆盖，结算或清理预览也不清除。旧行、首文本前取消/失败和不提供文本预览的调用保持 null，不从旧正文或结束时间回填。`started_at` 仍表示账本受理，以上都不是实际 HTTP 发出、Provider 收包或窗口显示时间。旧客户端可忽略字段，新客户端对旧服务缺字段显示“未记录”；仅原 Owner 写入，不增加业务完成权限。实际通过范围见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

### 10.31 M04/P12 第一方 Skill 与最小 Pack 第一段（2026-09-26，后端开发自检）

**Breaking Change: No。** 在 `/api/v1/workspaces/{workspace_id}` 下新增只读 `GET /skill-definitions`、`GET /skill-definitions/{id}/versions/{version}`、`GET /packs`、`GET /packs/{id}/versions/{version}`。不存在的 Workspace 或未知版本返回 404 `RESOURCE_NOT_FOUND`。Skill 清单项含 `id,version,sha256,title,target,output_kind,availability,required_capabilities,missing_capabilities,dependencies,accept_supported`；详情另含冻结 `definition`。0022 当时首批三项均为 `1.0.0`：`task-to-execution-contract`/`TASK_DEFINITION_SUGGESTION`、`project-resume`/`PROJECT_RESUME`、`verification-plan`/`VERIFICATION_PLAN_SUGGESTION`。0023 新版本与可接受状态见 §10.32；首批无额外 Connector 能力要求，两项 capability 数组为空，不能据此断言当前模型 Provider 已配置。

0022 当时两份只读 Pack `thesis-minimal@1.0.0` 与 `development-minimal@1.0.0` 返回 `id,version,sha256,title,host_contract:'relay-v1',availability,members[]`，成员固定引用当时三项 Skill，含 `kind:'SKILL',id,version,sha256,target,availability,required_capabilities:[],missing_capabilities:[],accept_supported`。Pack 可解析只说明定义一致；选择/读取 Pack 不建立项目配置、Permission、Run 或业务效果。版本升级见 §10.32。

原 `POST /assist-sessions/{id}/messages` 可选 `skill_ref:{id,version}` 与 `skill_input`；使用 Skill 时须省略 `intent`，且输入严格限定：任务定义 `{desired_result?:string}`、项目恢复 `{focus?:string}`、验收方案 `{risk_focus?:string}`，可选文本各最多 2000 字符、不得含其他字段。旧请求不传两个字段时行为及 202 回执 `{session_id,user_message_id,assistant_message_id}` 不变。未知 Skill/非法输入为 422 `VALIDATION_FAILED`，Skill 与会话目标不匹配为 409 `INVALID_TRANSITION`，跨 Workspace 会话为 404 `RESOURCE_NOT_FOUND`；同 `command_id` 同内容重放原消息身份，异内容沿原命令冲突语义。Skill 引用在 Assist 消息中冻结定义、依赖版本/摘要和输入；输出只按原 RUNNING 消息首次 CAS 结算。

`GET /assist-sessions/{id}/messages` 各行新增 `skill|null,skill_input|null,skill_output|null`；旧/普通 Assist 行均为 null。Skill 的 `skill` 含冻结身份、`definition_availability`（`AVAILABLE`/`HISTORICAL_ONLY`/`UNAVAILABLE`）与 `output_availability`（`PENDING`/`HISTORICAL_SNAPSHOT`/`NO_OUTPUT`/`UNAVAILABLE`）。旧定义退出当前注册表后，冻结定义及每个依赖正文/摘要自洽且当前目标/来源可读时，历史输出仍可读并标 `HISTORICAL_ONLY`；这不允许新调用旧版本或用新版重放。仅 `HISTORICAL_SNAPSHOT` 返回已结算 `skill_output` 与摘要正文；来源/目标在读时不可用时输出与正文为 null，来源条目仅给 `{kind,status:'UNAVAILABLE'}`，不泄露原 root_id/source_ref。可用来源给当前核验后的 `kind,root_id,version,source_ref,status:'AVAILABLE'`。完成的 `skill_output` 含 `kind,status,target_kind,target_id,as_of,baseline,basis_sha256,payload_sha256,payload`；任务定义的 payload 为 `summary,objective,expected_outputs,criteria,suggested_mode`，验收建议 1.0.0 为 `summary,checks,effective_check_plan:false`，项目恢复为 `summary,highlights,next_steps,comparison_baseline:null,read_only:true`。两类建议 status 为 `SUGGESTED`，项目恢复为 `READ_ONLY`；0022 当时输出没有自动业务写权，0023 增加显式人工接受入口。

生成时重新读取当前 Task/验收、Project State/Task/有效 Decision/Verification/OPEN Review 等 Owner 事实和版本引用，输入标记 `UNTRUSTED_DATA`，事实正文超过 24 KiB 或 Skill system/全部输入文本合计超过 64 KiB 均明确失败，不绕过预算。Project Resume 只陈述当前状态，不在缺少比较基线时编造变化；State 完成高亮只含当前 DONE 与当前 Completion/验收版本，Verification 只含当前验收周期未撤销适用性的最近 session。Skill 结构化模型输出超过 16 KiB、字段/引用/检查器不匹配时消息 `FAILED/OUTPUT_SCHEMA_INVALID`，无业务效果。定义/显式来源/目标缺失或事实超预算分别为 `SKILL_DEFINITION_UNAVAILABLE`、`SKILL_SOURCE_UNAVAILABLE`、`SKILL_SCOPE_UNAVAILABLE`、`SKILL_INPUT_OVER_BUDGET`；这些生成前失败不启动模型调用。原普通 Assist 仍按 §10.25。0022 第一段当时仅完成开发自检；0023 的 Task 接受与准入预览见下一节，Blueprint/Pack 应用仍待后续切片，独立或 Windows 桌面验收未做。

### 10.32 M04/P12 当前 Task Skill 建议接受与 CheckPlan 准入预览（2026-09-26，后端开发自检）

**Breaking Change: No。** 原普通 Assist、`PROPOSE_TASK → TASK_DEFINITION` 创建新 Task、旧消息与旧提案请求/回执仍可读可用；本节新增两种 proposal kind 和只读查询字段。`task-to-execution-contract@1.1.0` 的 `expected_outputs` 严格含 `kind:'MARKDOWN_DOCUMENT',description`（描述最多 2000 字符），由服务端把描述合入现有 `required_output_spec`，保留已确认产物种类及其他约束；旧 `1.0.0` 定义/摘要不改。`verification-plan@1.1.0` 仅建议 1–10 条 `additional_checks[{statement,required,method}]`，原 `1.0.0` 冻结历史可读但不能新调用/接受。Thesis/Development Pack `1.2.0` 固定引用 Task Skill 1.1.0、Project Resume 1.0.0 和 Verification Plan 1.1.0；旧 Pack 1.0/1.1 为 `HISTORICAL_ONLY`，不自动应用配置。

当前 Task 的建议生成后分别产生 `TASK_CONTRACT_CHANGE` 或 `VERIFICATION_PLAN_CHANGE` AssistProposal。`GET /assist-proposals[/{id}]` 沿用原字段，增加 `base_acceptance_revision,skill_sha256,skill_output_sha256,payload_available`；旧提案新增列为 null。目标/显式来源在读时不可用时 `payload_available=false,payload={}`，不泄露历史建议正文。Task proposal 的服务端最终 `payload` 含 `objective,required_output_spec,criteria[{criterion_id,statement,required,method,target_spec,source:'PRESERVED'|'SUGGESTED'}],added_criterion_ids,preserved_criterion_ids,suggested_mode`，`payload_hash` 绑定完整效果。原已确认 criteria 全部保留；新增条件 ID 由服务端固定，模型不能删除或降级已确认 required/HARD，不能直接改执行模式。Task Definition 可只有 objective 或 Expected Result 描述变化而不新增 criterion；Verification Plan 必有实际新增条件。

`POST /assist-proposals/{id}/accept` 对上述两种 kind 要求 `{command_id,expected_task_revision,expected_acceptance_revision,payload_hash}`，两版本为十进制字符串，摘要为 64 位小写 hex；缺失/形态错误为 422 `VALIDATION_FAILED`。同 `command_id` 同内容重放原回执，异内容沿原 `COMMAND_ID_REUSED`；另一 `command_id` 对已接受提案返回 409 `INVALID_TRANSITION`，不重复写验收。过期 Task/acceptance 基线为 409 `REVISION_CONFLICT` 并把提案置 `EXPIRED`；跨 Workspace 目标为 404 `RESOURCE_NOT_FOUND`；提案摘要/Skill 来源不一致或来源撤销为 409 `INVALID_TRANSITION`。只允许 HUMAN 拥有、非终态且无活动 Run/未结算或 UNKNOWN 动作的 Task 接受；否则 409 `EXECUTOR_CONFLICT`。接受在 Workspace authority SHARE → 来源复核 → Task 锁序下，经 Task Owner 新建 acceptance 版本、复制全部旧 criteria 加新增条件、撤销旧周期 Verification 适用性并过期该 Task 的 OPEN Review，与提案决策、审计及命令回执同事务。旧 ExecutionContract/Run/Review 仍保留历史身份，不被新版本改写。成功 `result` 含 `task_id,status,revision,previous_acceptance_revision,acceptance_revision,objective,required_output_spec,criteria,added_criterion_ids,proposal_id`，返回服务端实际合并版本；建议模式不会改 Task mode/执行权。

`GET /tasks/{task_id}/check-plan-preview` 只读返回 `task_id,status:'AVAILABLE'|'UNAVAILABLE',admission_available,reason_codes,sources:{task_revision,acceptance_revision,rule_revision,workflow_key,workflow_version,rule_refs},check_plan,check_plan_sha256,frozen_run_plan:false,executed:false`。可重复读快照用当前验收、适用 Rule 与注册检查器生成准入预览；缺能力/规则冲突或当前 Task 不可 Delegate 显式给原因。`status=AVAILABLE` 仅表示计划可构造，须另看 `admission_available`；它不是活动 Run 已冻结或已执行的 CheckPlan，不是 PASS。Delegate 仍重新核对 Rule、权限与当前 revision 后冻结自己的 ExecutionContract。Blueprint、Pack 选择/应用、真实模型质量、独立与 Windows 桌面验收均不属于本节开发自检。

2026-09-30 补齐 Skill 模型请求的 JSON mode：内部仍以 `DISCUSS` 表示 Skill 消息，模型适配器按冻结 Skill 身份启用 `response_format:{type:'json_object'}`，不再只按普通提案 intent 判断。**Breaking Change: No。** HTTP 输入/回执、Skill 版本、严格输出 schema 与原接受 Owner 不变；普通无 Skill 的 `DISCUSS` 继续流式首预览，Skill 不输出部分预览。JSON mode 不能代替 schema 校验，不合法输出仍以 `OUTPUT_SCHEMA_INVALID` 失败且不生成提案。验证结果只在[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)维护。

### 10.33 M05/P14 内置 ViewConfiguration Owner（2026-09-26，后端开发自检）

**Breaking Change: No。** `GET /api/v1/workspaces/{workspace_id}/projects/{project_id}/view-configuration` 返回 `{project_id,revision,kind,template_version,template_sha256,pages:[{page_id,visible,position}],updated_at}`。kind 仅 `general/thesis/development`；template_version 固定 `1`，固定 pages 顺序分别为 General `state/tasks/artifacts/reviews`、Thesis `state/knowledge/tasks/artifacts/reviews`、Development `state/tasks/runs/connections/reviews`。这些是服务端注册的展示组合，基础导航和 Review 入口不受隐藏；不提供任意逐页编辑或客户端自报页面字段。`POST` 同路径接受 `{command_id,expected_revision,kind}`，返回 200 原命令回执，result 同 GET。未知 kind/字段 422 `VALIDATION_FAILED`，过期 revision 409 `REVISION_CONFLICT`，跨 Workspace Project 404 `RESOURCE_NOT_FOUND`；同命令同内容重放原回执，异内容沿 `COMMAND_ID_REUSED`。修改只递增 View revision，不改 Project Type/State、Task/Run contract 或 Permission。

### 10.34 M04/P12 + M05/P14 Project Blueprint 候选与原子应用（2026-09-26，后端开发自检）

**Breaking Change: No。** 新增独立的 `ProjectBlueprintProposal` 资源与随应用发布的 `goal-to-project-blueprint@1.0.0`；旧 `assist_proposals` 中的 `TASK_DEFINITION` 仍只负责创建新 Task，普通 Assist 不变。`thesis-minimal`/`development-minimal@1.3.0` 固定引用此 Skill、Task Definition 1.1.0、Project Resume 1.0.0、Verification Plan 1.1.0；旧版本及摘要不改，Pack 选择仅冻结提案来源，不安装配置或授权。

- `POST /projects/{project_id}/blueprint-proposals`（201，`CreateProjectBlueprintProposal`）：`{command_id,expected_project_revision,expected_state_revision,expected_view_revision,draft,supersedes_proposal_id?}`。`draft` 严格为 `{intent,goal_id:null|uuid,phase_key:null|内置阶段,tasks:[{local_key,title,objective}],next_action:null|{kind:'NEW_TASK',local_key}|{kind:'EXISTING_TASK',task_id}|{kind:'CLEAR'},view_kind:'general'|'thesis'|'development',pack_ref:null|{id,version}}`；最多五个新 Task，未知页面/筛选/草稿字段 422，零实际效果候选 409。自然语言 intent 只属候选来源，不会创建已确认 Goal。
- `GET /projects/{project_id}/blueprint-proposals` 与 `GET /projects/{project_id}/blueprint-proposals/{proposal_id}`：分别返回 `{items:[proposal]}` 与单个 proposal。proposal 包含 `id,workspace_id,project_id,status,origin,skill_message_id,supersedes_proposal_id,candidate_sha256,candidate,baseline,source,stale,content_availability,diff,follow_up_suggestions,decision,created_at,decided_at,updated_at`。`candidate` 固定本次可应用的 Goal 关联、State 阶段/Next Action、新 HUMAN/ME/INBOX Task 与解析后的真实内置 View pages；`diff` 以当前冻结基线展示 Goal/State/Task/View 前后，Rule/Workflow/Permission 只在后续建议中。`content_availability='SOURCE_UNAVAILABLE'` 时，`stale=true` 且 `candidate/baseline/diff=null`、`follow_up_suggestions=[]`；保留不含来源正文/根 ID 的 Skill/Pack 摘要身份。列表和详情在 WorkspaceAuthority SHARE 保护的短一致快照中重查当前来源；跨 Workspace Project/Proposal 均 404。
- `POST /projects/{project_id}/blueprint-proposals/{proposal_id}/apply`（200，`ApplyProjectBlueprint`）：只接受 `{command_id,candidate_sha256,expected_project_revision,expected_state_revision,expected_view_revision}`，不夹带新补丁。摘要/基线/Goal/Task/Skill 来源/Pack 或当前显式资料失效时拒绝（409）；来源重新按当前权限读取并核对冻结 SHA。成功回执 `result` 含 `proposal_id,candidate_sha256,project_id,project_revision,state_revision,view_revision,goal_ids,task_id_map:[{local_key,task_id,status,revision}],next_action_task_id,view_configuration,applied_effects`。Goal 只关联同 Workspace 已存在的 ACTIVE Goal；Task Owner 创建 HUMAN/ME/INBOX；State Owner 写阶段/Next Action；View Owner 切内置 kind；提案 ACCEPTED、审计和回执在同一短事务。失败回滚全部对象效果。相同 command_id/内容重放原回执；另一个 command_id 再应用已接受候选也只返回原结果，不新建 Task。
- `POST /projects/{project_id}/blueprint-proposals/{proposal_id}/reject`（200，`RejectProjectBlueprint`）：`{command_id,candidate_sha256}`，PENDING→REJECTED；同命令重放原回执。新候选可显式给 `supersedes_proposal_id`，仅替代同 Project 待确认候选。

Project Assist 会话可用原 `POST /assist-sessions/{id}/messages` 发送 `{command_id,content,skill_ref:{id:'goal-to-project-blueprint',version:'1.0.0'},skill_input:{desired_outcome?,goal_id?,pack_ref?}}`（不用同时传 intent）。`goal_id` 必须为当前同 Workspace ACTIVE Goal；输出 `skill_output.kind='PROJECT_BLUEPRINT_SUGGESTION'`、`payload:{summary,draft,effective_blueprint:false}`，不是已应用结果。生成时重读 Project/State/Task/选中 Goal/View 事实及版本、严格限制 JSON/集合/输入预算；首次消息结算和 `origin='SKILL'` 蓝图候选插入同事务。生成基线变化为 `FAILED/SKILL_BASELINE_STALE`，无候选；输出或来源不可用为相应 typed FAILED，取消不生成候选。AI 候选和人工草稿使用同一 Preview/Diff/Apply 契约。本节仅开发自检，未做独立或 Windows 桌面验收。

### 10.35 M05/P14 Workspace Project 与 Task 列表（2026-09-26，后端开发自检）

**Breaking Change: No。** 新增 `GET /api/v1/workspaces/{workspace_id}/projects?status=active|archived|all&limit=1..100&cursor=…`。`status` 默认 `active`，`limit` 默认 50，返回 `{items,next_cursor}`；每项为 `{id,title,project_type,archived_at,archive_status:'ACTIVE'|'ARCHIVED',revision,state_revision,phase_key,next_action_task_id,created_at,updated_at}`。`phase_key` 与 `next_action_task_id` 来自当前 ProjectState，`archive_status` 只由 `archived_at` 派生；实际归档命令见 10.37。排序为 `(created_at DESC,id DESC)`，下一页游标使用数据库微秒时间键并绑定 Workspace 与 `status`；格式/版本/过滤不匹配返回 400 `INVALID_CURSOR`，不存在的 Workspace 返回 404 `RESOURCE_NOT_FOUND`。游标是键集续页，不提供跨并发增删/归档的快照保证。

原 `GET /tasks?project_id=…` 与 `GET /tasks?inbox=true` 请求、返回及 v1 游标保持兼容；新增显式 `GET /tasks?scope=all` 返回相同 `{items:TaskSummary[],next_cursor}`，列出当前 Workspace 全部 Task（含 Projectless、归档 Project 下和终态），不套 Today 资格过滤。`scope=all` 与 `project_id`/`inbox` 互斥；没有任一过滤条件仍为 422 `REQUIRED_INPUT_MISSING`。全域分页使用独立 v2 游标，绑定 Workspace 与 scope，保留微秒时间键；`limit` 默认 50、最大 100。列表摘要中 blocker 与 `allowed_actions` 按每条 Task 所属 Project 计算，不把别的 Project blocker 串入；后续归档栅栏 A 段将归档 Project 的 Task `allowed_actions` 收敛为空。此片仅只读查询与 0027 索引，真实 PostgreSQL/HTTP 为开发自检，独立及 Windows 桌面验收后置。

### 10.36 M05/P14 归档写保护 A 段（2026-09-26）

**Breaking Change: Yes（仅已归档 Project 的旧写入）。** 关联 Project 的普通业务写命令在原命令作用域、幂等回执和版本检查下新增 409 `PROJECT_ARCHIVED`；跨 Workspace ID 仍为 404 `RESOURCE_NOT_FOUND`，相同 `command_id`/相同 payload 的已提交回执仍按既有规则重放。包括 Task/Artifact/完成、State/Goal 关联、Information/Rule、Assist/Skill/Blueprint、View、Gateway/Import、Today 目标选择及 Run/Review。已有 Project/Task/Assist 历史 GET 保持可见；归档 Project 的 Task 摘要 `allowed_actions=[]`，Today 不推荐这些 Task。Workspace 级 Goal、Rule、无 Project Task 不受某一个 Project 的栅栏影响。A 段先建立 Project 行 `FOR KEY SHARE` 栅栏；B 段归档写入口见 10.37。

### 10.37 M05/P14 ArchiveProject 负面准入与原子归档（2026-09-26）

**Breaking Change: No（新增端点；10.36 对旧写入的变更仍适用）。** `POST /api/v1/workspaces/{workspace_id}/projects/{project_id}/archive` 严格接受 `{command_id,expected_revision}`（UUID、十进制字符串），返回 200 统一命令回执，`result={project_id,revision,archived_at,archive_status:'ARCHIVED'}`，`links.resource` 为原 Project。相同命令 ID/内容重放原回执并带 `Command-Replayed: true`；异内容 409 `COMMAND_ID_REUSED`。跨 Workspace/不存在 Project 404 `RESOURCE_NOT_FOUND`，过期 Project revision 409 `REVISION_CONFLICT`；已归档的不同命令 409 `PROJECT_ARCHIVED`。

归档在 Project `FOR UPDATE` 行锁下检查持久在途事实，不能因租约到期或未见当前 Worker 就认定效果已安全结束。阻断返回 409 `PROJECT_ARCHIVE_BLOCKED`、`retry_action=REFRESH_AND_REDECIDE`，`conflict.blocking_reasons` 按固定顺序返回下列一项或多项，不含来源正文、数量或跨范围实体 ID：`TASK_ACTIVE`（HUMAN 活动或 AI 占有）、`RUN_UNSETTLED`（非终态 Run、投递/Invocation/控制/运行中的 Step/Attempt/Verification 未收敛）、`GATEWAY_UNSETTLED`（准备、待批准或派发中的 Operation/Invocation/旧效果）、`UNKNOWN_EFFECT`、`RESOURCE_CLAIM_UNSETTLED`（HELD/QUARANTINED）、`IMPORT_IN_FLIGHT`、`ASSIST_IN_FLIGHT`、`MODEL_CALL_STARTED`、`REVIEW_OPEN`。模型调用的 STARTED 预约先在短事务内取同一 Project 可写栅栏，故归档成功后的旧 Run/Assist 执行流不能再发起 Provider 调用。用户须沿原 Run/Operation/Review/Import/Assist 身份处理后重新读取 Project revision 决定是否归档；归档命令本身不调用模型或工具、不自动取消/核对未知效果。成功只修改 Project 归档字段与 revision，同事务提交关键 Activity 和回执；历史读保持当前权限下可见，后续关联业务写入按 10.36 返回 409。

### 10.38 M04 Assist DISCUSS 生成中临时草稿（2026-09-26）

**Breaking Change: No（新增只读端点）。** `GET /api/v1/workspaces/{workspace_id}/assist-sessions/{session_id}/messages/{message_id}/live-preview` 使用现有 Bearer 鉴权，返回 200、`Cache-Control: no-store` 和严格对象 `{session_id,message_id,status,preview_revision,preview_text,preview_truncated,preview_available}`。`status` 为原消息的 `PENDING|RUNNING|COMPLETED|FAILED|CANCELLED`；`preview_revision` 为十进制字符串，`preview_text` 可为 null，`preview_truncated` 表示 16 KiB UTF-8 前缀已截取。仅普通、无 Skill 的 `DISCUSS` 在 PENDING/RUNNING 且未请求取消、当前目标及本轮/有界历史来源仍可读时 `preview_available=true`；来源重查最多覆盖最近 20 条已完成消息、总计最多 20 个来源引用，超过界限保守隐藏草稿。PENDING 或首片段前仍可返回 `preview_text=null,preview_revision='0'`。完成、失败、取消、租约失效、非 DISCUSS、Skill 或来源失权均返回 `preview_available=false,preview_text=null,preview_revision='0'`。不同 Workspace、Session、Message 组合或不存在的 ID 返回 404 `RESOURCE_NOT_FOUND`，缺失/错误 Bearer 返回 401。调用方重连后重读累计文本并按 revision 去重；终态读取原 `GET /assist-sessions/{id}/messages` 的完整结算行，不把草稿当 Proposal、已接受结果或成功响应。

消息来源的历史投影会重新核对当前可见性：已失权的普通 `DISCUSS` 正文返回 null，来源 ID/正文不出响应；仍可见来源保留既有记录字段。结构化提案、Skill、语义检查和 Run DRAFT 不在此端点公开原始生成片段；Run 的独立端点见 §10.39。临时草稿的容量/速率、删除和跨进程读取由 [物理设计 §41](../database/physical-design-postgresql.md)说明；真实 Provider 与前端首字延迟仍需单独验证。

### 10.39 M04 Run DRAFT 生成中临时草稿（2026-09-26）

**Breaking Change: No（新增只读端点）。** `GET /api/v1/workspaces/{workspace_id}/runs/{run_id}/draft-preview` 使用现有 Bearer 与 Workspace 鉴权，返回 200、`Cache-Control: no-store`，严格对象 `{run_id,run_status,step_attempt_id,attempt_claim_epoch,model_call_id,preview_revision,preview_text,preview_truncated,preview_available}`。ID 为 UUID 或 null，epoch/revision 为十进制字符串或约定的 null；`preview_text` 为最多 16 KiB UTF-8 的累计 Markdown 前缀或 null，`preview_truncated` 表示前缀已达上限。生成中的当前 DRAFT Attempt 尚无首片段时可返回当前 `step_attempt_id` 与 `attempt_claim_epoch`、`preview_available=true`，而 `model_call_id/preview_text=null,preview_revision='0'`。同一 Attempt 的实际片段绑定原 `model_call_id`，递增 `preview_revision` 供重读去重。

只有 Run 当前为 RUNNING、Task 仍由该 Run 占有、DRAFT Step/Attempt 为当前领取、Worker 与 dispatch invocation/租约有效、无 PENDING 控制请求，且当前 Manifest 及冻结 FILE_READ/WEB_FETCH 读证据的来源仍可见时草稿可用。重试的新 Attempt 或 Worker 领取使旧前缀不可见，旧回调不能覆盖；来源撤销、连接/策略/资源停用、租约失效、取消、失败或步骤终结返回 `preview_available=false,preview_text=null,preview_revision='0'`，不回显来源引用。不存在或跨 Workspace Run 返回 404 `RESOURCE_NOT_FOUND`，缺失/错误 Bearer 返回 401。客户端断线后重读并按 Attempt、claim epoch、模型调用与 revision 识别累计文本；终态必须查询原 Run/Artifact，临时草稿不创建 Artifact、不证明验证 PASS 或 Task DONE。现有 Run SSE 仍传事实刷新提示，此端点以短轮询读取片段；真实 Provider、前端首字延迟与桌面体验尚待测。

### 10.40 M05/P15 完成凭据详情（2026-09-26，后端开发自检）

**Breaking Change: No（新增只读端点）。** `GET /api/v1/workspaces/{workspace_id}/completion-records/{completion_id}` 使用现有 Bearer 与 Workspace 作用域，返回 200、`Cache-Control: no-store`。不存在或跨 Workspace 的完成凭据返回 404 `RESOURCE_NOT_FOUND`，缺失/错误 Bearer 返回 401。归档或重开不删历史；`is_current` 只说明 Task 的当前完成指针是否仍指向该 ID，不把旧 PASS 或旧人工接受说成当前验收。

响应为 `{completion_id,task_id,basis_kind,acceptance_revision,is_current,committed_at,acceptance,human_acceptance,verification_session,artifact_versions}`。`acceptance` 从完成时的确切 Task 验收修订读取，含 `availability,objective,expected_outputs,source,created_at,criteria[{criterion_id,statement,required,method,target_spec}]`。HUMAN 凭据的 `human_acceptance` 含 `availability,id,actor_kind,statement,accepted_criterion_ids,reason,created_at`，AUTO 为 null；AUTO 凭据的 `verification_session` 含 `availability,id,run_id,status,verdict,check_plan_hash,applicable`，HUMAN 为 null。`applicable=false` 显示原会话适用性已撤销，仍保留历史 verdict。`artifact_versions[]` 按原完成 `state_delta.artifact_version_ids` 顺序给出 `availability,artifact_version_id,artifact_id,version_number,sha256`，只在原 Artifact 仍属于当前可见 Workspace/Task 且受管内容 hash/大小吻合时返回可导航 ID；内容缺失、损坏或引用失权返回 `UNAVAILABLE` 且该项 ID/hash 为 null，不以最新 ArtifactVersion 代替。异常超出 100 个引用时仅展示前 100 项并追加一项 `UNAVAILABLE` 标记，不声称证据完整。

验收、人工接受或验证会话历史行缺失/身份不一致时仅对应分支返回 `UNAVAILABLE` 和 null/空字段，不取当前版本补位；人工接受的 actor_ref、完整 `state_delta`、Run CheckPlan/模型正文及宿主路径不出 DTO。读取采用一致的数据库快照，并逐项核对引用；这是对已持久事实的投影，不新增完成 Owner、写命令、迁移或验收效力。真实 PostgreSQL/HTTP 定向测试覆盖历史重开、跨作用域、错误 Bearer、受管内容缺失和 AUTO PASS 来源；M05 独立与 Windows 桌面验收后置。

### 10.41 M06 固定图文件写意图（2026-09-27）

**Breaking Change: No。** `POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/delegations` 可选增加 `file_write_action: {connection_id,resource_id,changes}`，与 `mock_gateway_action`、`file_read_action`、`web_fetch_action` 四选一；不传的新旧客户端仍按原流程运行，202 回执与 `command_id` 幂等语义不变。`changes` 为 1–16 项，每项 `{path,action,content?,baselineSha256?,targetSha256?}`；`action` 仅为 `CREATE|MODIFY|DELETE`，HTTP 字符串长度限制为路径最多 1024、写入内容最多 8192，规范化后的路径另受 1024 UTF-8 字节的账本限制。Windows 相对路径段不接受备用数据流冒号、保留设备名（含扩展名及 COM/LPT 上标数字形式）、禁用字符与控制字符、尾随点或空格；`WRITE_FILE` 与变化集 Prepare 同样拒绝这些不安全别名。`CREATE` 不接受基线；`MODIFY`/`DELETE` 必须携带有效的 64 位十六进制基线 SHA-256；`DELETE` 不接受内容或目标摘要，其他动作必须有字符串内容，若给出目标摘要则须与内容相符。整个 Gateway 参数仍受 Permission 的 `max_payload_bytes` 限制。

Delegate 校验资源属于当前 Workspace/Task Project，并在创建 Run 前拒绝不安全、等价重复路径或无效冻结摘要；实际目录、Connection、Permission、基线冲突与批准在 Gateway Prepare/Admit/执行时核对。合法意图随 Run 契约冻结为 `file-write-v1` 与唯一 `operation_id`，变化项参与命令摘要。固定图在 DRAFT 成功后以该原身份准备 `FILE_WRITE/APPLY_CHANGESET`，需批准时等待绑定原 Operation 的 `ACTION_APPROVAL` 和 RESUME；批准前不写文件，批准后通过原 Invocation 记录效果及逐文件账本。已部分应用的变化集保留原 Operation/Invocation 为 `UNKNOWN`、资源隔离、逐文件账本 `PARTIAL` 并在 Run 未决 ID 中可见；全部文件确定无写入的冲突或冻结根拒绝可记 `FAILED`，释放资源并使 Run 失败。两者均不推进候选发布、Task 完成或换 ID 自动重试。部分写入的显式人工处置见 10.43；冻结计划文本差异见 10.44，真实 WebView2 自动化点击已通过，人工交互与 M06 整体出口仍待完成。

### 10.42 M06 文件写入逐文件账本只读查询（2026-09-27）

**Breaking Change: No（新增只读端点）。** `GET /api/v1/workspaces/{workspace_id}/operations/{operation_id}/change-sets` 使用现有 Bearer 鉴权与 Workspace 作用域；不存在、跨 Workspace 或非 Run `FILE_WRITE` Operation 返回 404 `RESOURCE_NOT_FOUND`。存在的 FILE_WRITE Operation 在执行前返回 `200 {operation_id,change_sets:[]}`，不伪造成功或效果证据；响应带 `Cache-Control: no-store`。

已有账本按创建时间和 ID 排序，响应为 `{operation_id,change_sets:[{id,invocation_id,run_id,resource_id,action_type,canonical_root,status,evidence_source,file_count,created_at,updated_at,files:[{relative_path,action,baseline_sha256,observed_baseline_sha256,target_sha256,actual_sha256,status,error,created_at}]}]}`；逐文件行按规范相对路径排序。该端点只投影持久账本，不读取当前磁盘、不输出冻结内容或 diff 正文；`canonical_root` 是当次执行根的历史记录，`actual_sha256` 是当次观测，不证明读取时文件仍相同。`PARTIAL` 仍需按原 Operation 核对和人工处置，查询本身不释放资源、不改变 Run/Task 或验收结论。真实隔离 PostgreSQL/HTTP 定向反例覆盖执行前空账本、混合 `APPLIED/CONFLICT` 与跨 Workspace 404；处置另见 10.43，冻结计划文本差异另见 10.44；此账本端点本身不提供 diff 正文。

**Breaking Change: Yes（仅新 Windows `WRITE_FILE` 的路径语义）。** 0036 之后创建且有物理身份行的单文件写动作，其 `canonical_root` 为受管资源根，`relative_path` 可含子目录；此前动作仍保留目标父目录与文件名。响应形状、状态码与历史行不变；客户端应将每条文件路径与该账本自身的 `canonical_root` 配对，不能假定 `WRITE_FILE` 总是 basename。

### 10.43 M06 部分文件写入的人工处置（2026-09-27）

**Breaking Change: No（新增端点与终态枚举）。** `GET /api/v1/workspaces/{workspace_id}/operations/{operation_id}/file-write-disposition` 返回原 Operation/Invocation/变化集 ID、Run/Task 当前 revision、是否已有可信桌面停机证明、可处置标志与阻断原因、逐文件账本状态/当次实际摘要/当前回读摘要以及 `observation_sha256`。它读取磁盘但不写入；返回 `Cache-Control: no-store`，不输出文件正文。已经处置时返回持久 `disposition` 摘要，不再生成可提交的新快照。跨 Workspace、非 RUN `FILE_WRITE` 或不存在的 Operation 为 404。

**Breaking Change: No（追加无回执观察字段和原 UNKNOWN 账本处置条件）。** 新 Windows 动作若原 Invocation 没有 `file_write_receipt` 且变化集仍为 `UNKNOWN`，GET 在冻结根/File ID 下只读观察各目标和同目录 `.__relay-file-io-` 前缀候选，返回 `observation_mode:"NO_RECEIPT"`、`files[].current_target_id`、`files[].parent_chain` 与 `files[].residual_candidates[]`（路径、File ID、sha256、状态）。`complete` 有界观察才生成可提交的 `observation_sha256`；候选只是当前目录条目，不能归因于原调用。目标缺失可作为明确的当前事实；根/冻结父链身份不符、候选或目标不安全/不可读、目录观察中变化、超限或助手失败则阻断处置。最多观察 16 个目标、全请求 32 个候选、每目录枚举 4096 项、单对象读取 1 MiB、总读取 4 MiB。旧动作缺物理身份不补造此出口。原有 `PARTIAL` 回执路径仍返回 `observation_mode:"PARTIAL_LEDGER"`，历史已处置记录可无此字段。

`POST` 同一路径要求 `{command_id,invocation_id,decision:"KEEP_CURRENT_AND_FAIL_RUN",expected_run_revision,expected_task_revision,expected_observation_sha256}`。只接受原 Operation/Invocation `UNKNOWN`、原账本为有回执 `PARTIAL` 或上述缺回执 `UNKNOWN`、原资源 `QUARANTINED`，且桌面 Job 停机证明与原 Worker/epoch/投递命令一致、Run 已 fence、没有其他未决动作或运行中的步骤。服务端提交前在业务事务外再次只读核对每个目标及无回执路径的候选；观察有 10 秒超时。短事务中再核对原账本、claim、停机证明与 revision；快照摘要或 revision 改变也返回 409，用户须刷新后重新决定。客户端不能自报旧进程已停。决定的语义是**保留观察时的目标和候选，结束旧 Run**，不推断原写入整体成功，也不回滚、补写、移动或删除候选。

成功与命令回执同事务插入不可改写处置事实、将原 Operation 置 `MANUALLY_CLOSED`（原 Invocation 仍为历史 `UNKNOWN`，变化集保留原 `PARTIAL` 或 `UNKNOWN`）、释放隔离 claim、把原投递及该 Run 其他未领取投递结为 `DONE`、拒绝尚待处理的控制意图、将 Run 置 `FAILED` 并把 Task 返 `READY`；不产生 CompletionRecord 或 Project State 提交。`DONE` 只表示投递已结清。响应 result 含原 operation/invocation、disposition、Run/Task ID 与终态、观察摘要；GET 在关闭后继续投影当时持久的逐文件观察值。相同 command_id/内容重放同一回执，另一命令不能重复处置。项目归档只把这条已持久处置的 Invocation `UNKNOWN` 视为历史，不绕过任何其他未决动作。文件回读与数据库提交之间仍存在外部编辑竞争窗口，不能声称 OS 级隔离或真实 Windows 桌面验收通过。

### 10.44 M06 文件写入冻结计划文本差异（2026-09-27，开发自检）

**Breaking Change: Yes（仅新 Windows `WRITE_FILE` 的路径语义）。** `GET /api/v1/workspaces/{workspace_id}/operations/{operation_id}/file-write-diff` 沿用 Bearer 与 Workspace 隔离；不存在、跨 Workspace 或非 Run `FILE_WRITE` Operation 返回 404 `RESOURCE_NOT_FOUND`。响应形状仍为 `200 {operation_id,basis:"FROZEN_INTENT",files:[{relative_path,action,baseline_sha256,target_sha256,availability,unavailable_reason,before_text,after_text}]}`，按原冻结变化项顺序返回，并带 `Cache-Control: no-store`。`CREATE` 的基线为空文本，`DELETE` 的目标为空文本；新 Windows `WRITE_FILE` 的 `relative_path` 与新账本一致，为受管根相对路径，可含子目录；历史动作仍为目标文件名。客户端应按返回的路径显示，不自行取 basename。

新动作准备前以短事务核对原 Run/Worker、Project/Resource、Connection 与 Permission，在事务外限量读取 `MODIFY/DELETE` 基线，再以短事务重新核对授权并与 Operation 同步写入证据；仅当安全读取的 UTF-8 文本不超过单文件 64 KiB 且摘要等于冻结 `baseline_sha256`，才写入不可改写的基线正文证据。目标正文沿用冻结 Operation 参数，查询时不重读磁盘。历史动作不回填；基线缺失、摘要不符、二进制、超限或路径不可安全读取时，`availability=UNAVAILABLE`、两个文本为 null，并给出原因，仍保留已有摘要。该响应只展示**计划**，不证明文件已写入；当次执行状态见 §10.42 的账本，当前文件状态见 §10.43 的处置预览。查询不改变 Operation、Run、Task 或资源状态。真实 PostgreSQL/HTTP 与 React 组件已有定向开发自检；新 release 的真实 WebView2 自动化点击与截图检查已通过。人工交互及安装包体验尚未验证。

### 10.45 产品补充：产物版本的已登记直接引用（2026-09-27）

**Breaking Change: No。** 新增 `GET /api/v1/workspaces/{workspace_id}/artifact-versions/{artifact_version_id}/direct-uses`，仅读已登记且父类型为 `ARTIFACT_VERSION` 的 `DERIVED_FROM/REVISED_FROM` 反向边。返回 `source_artifact_version_id,source_content_availability,scope:"RECORDED_DIRECT_ONLY",complete:false,has_more,direct_uses[]`。每项包括 `relation,child_artifact_version_id,child_artifact_id,child_version_number,availability,created_at`；这是确切版本的关系证据，不是传播执行结果或完整影响分析。

先核对源版本 Workspace 和受管正文摘要；源正文不可读时返回 `UNAVAILABLE`、空列表及 `has_more:false`，不能解读为无引用。查询最多取 101 条已登记边，展示前 100 条，额外条目由 `has_more` 表示；子版本再次核对作用域及受管正文，同作用域正文不可读时三个子身份/版本字段为 null。未知或跨 Workspace 源版本为 404。空列表只表示本次未展示到已登记直接引用，`complete` 始终为 false；不包含未登记、间接或模型推测的影响。接口没有写副作用，不触发模型或修改任何 PASS/批准。实际实现和验证范围见 25 日产品补充开发记录，尚不构成 M05/M06 整体验收。

### 10.46 产品补充：按确切知识版本读取正文（2026-09-27）

**Breaking Change: No。** 新增 `GET /api/v1/workspaces/{workspace_id}/knowledge/{id}/versions/{version}/content`，现有版本列表继续只返回摘录。版本为正十进制整数，不能超过 PostgreSQL bigint 上限。响应带 `Cache-Control: no-store`，返回知识身份/标题/作用域、当前版本指针及本次所选版本的身份、来源类型、媒体类型、内容摘要、可用性、来源引用、原件 URI 和保存时间，以及 `content_status`、`content`。`content_status` 为 `FULL/PARTIAL/UNAVAILABLE/UNSUPPORTED/READ_FAILED`；FULL/PARTIAL 才能带正文，其他情况正文为 null。

查询必须核对 Workspace、项目/产物来源归属和确切版本摘要，不以当前版本填充旧引用；内联受管文本来自原 KnowledgeVersion，Artifact 引用读取并校验原受管产物。非法版本返回 422，缺失或跨 Workspace 对象为 404；来源标记不可用即不返回正文，摘要失配为 READ_FAILED。FULL 指本机已保存快照的完整内容，不承诺当前网页原件相同或完整。PARTIAL 供表达真实的部分内容，当前完整快照读取实现不会把损坏或列表摘录转为 PARTIAL。

读取不调用 Provider、不访问原网页、不改变知识/Task/Run 状态。客户端核对返回的 knowledge_id 与 version，状态与正文或来源可用性矛盾时拒绝显示。真实隔离 PG/HTTP 定向 4/4 通过，包含完整历史正文、跨 Workspace、非法版本、不可用/损坏、离线网页快照、产物内容缺失/篡改和跨项目提升拒绝；这些工程反例不替代阅读与桌面验收。实际范围见 27 日产品补充开发记录。

### 10.47 M06 Windows 受管根登记身份（2026-09-28，开发自检）

**Breaking Change: Yes（旧 Windows 受管资源的新 `FILE_WRITE` 准备）。** 0038 前登记的资源没有可证明的登记时 File ID，不能从当前磁盘补造；新 Windows `WRITE_FILE`/`APPLY_CHANGESET` 在创建 Operation/Review 前返回 409 `GATEWAY_RESOURCE_IDENTITY_REQUIRED`。在 Windows 停用无未决占用的旧资源后，以相同路径重新登记为**新资源 ID**（0039 只对活动资源保持同项目路径唯一），核对新的资源 ID、连接、策略和委托引用后才能准备新动作；已停用的旧资源及其历史不迁移或删除。已有 Operation 仍使用自己冻结的 0036 物理身份，不回填或换 ID。

**Breaking Change: No（新增只读字段）。** `GET /projects/{project_id}/managed-resources` 和 `GET /.../{resource_id}` 每项新增 `file_write_identity_bound:boolean`。Windows 新登记时，原生助手只读捕获当前目录卷号/File ID；无法安全捕获的目录仍可登记供其他能力使用，但该字段为 false，不能准备新的 Windows 文件写入。创建命令的请求与回执形状不变，重放即使目录后来移动仍返回原回执。新写动作准备时比较当前原生助手根身份与登记身份，不同则返回 409 `GATEWAY_RESOURCE_ROOT_CHANGED`，不生成新 Operation/Review，也不写盘。登记与准备之间目录变化不会被现有路径字符串或当前摘要当作同一资源。

### 10.48 协作控制增量（2026-09-28，开发自检）

**Breaking Change: No。** 以下均是新增路径，沿用 `/api/v1/workspaces/{workspace_id}` 前缀与 Bearer/Workspace 边界。Artifact 锁定命令沿用原 `command_id`、`expected_artifact_revision` 的回执与 CAS：`GET /artifacts/{artifact_id}/text-locks` 返回当前锁定原文及绑定版本；`POST` 同路径额外接收 `expected_version_id`、`block_kind:PARAGRAPH|SECTION`、零基 `block_index`；`POST /artifacts/{artifact_id}/text-locks/{lock_id}/unlock` 只解除该处锁定。AI 修正轮与影响候选应用在实际写版本前核对，冲突保留旧版本并返回原目标/原因。人工新版本会保守继承锁定，不能映射时保留锁事实并阻断 AI 写入。

手动分析：`POST /artifact-versions/{before_version_id}/impact-checks` 接收 `command_id`、`source_after_version_id`、`expected_artifact_revision`、`analysis_target_version_ids`（最多 10 个、须为登记直接引用），返回 202 的检查/Assist 消息 ID。只把用户逐项选入的目标摘录送入模型；`GET /impact-checks/{id}` 分别返回登记直接引用、模型推测、未分析范围、截断/过期事实与真实状态。`POST /impact-checks/{id}/candidates` 再接收目标确切版本、目标 revision、推测确认标志和 `command_id`；`GET /impact-candidates/{id}` 返回候选或失败状态；`POST /impact-candidates/{id}/apply` 要求目标 revision，只有用户显式应用才保存 AI 来源的新不可变版本。读取与应用共用候选 Markdown 校验：空白、格式错误或超过 256 KiB 均显示 `FAILED/OUTPUT_SCHEMA_INVALID`，应用返回 409 `INVALID_TRANSITION`，不生成版本或成功提交事实。来源/目标/锁定变化拒绝旧候选，不继承旧验证。此处修复未发布接口的服务端拒绝行为，**Breaking Change: No**。真实 Provider 的准入未改变。

`GET /attention/interventions` 从当前业务事实读取必须介入事项及原入口，普通 HUMAN INBOX/READY 不包含在主动提醒投影。桌面失焦 3 秒后调用 `POST /attention/notifications/claim`，数据库按事项身份与变化原子去重；`POST /attention/notifications/settle` 记 `DISPATCHED/DENIED/FAILED` 投递尝试状态。后两者是通知传输回执，不决定 Review/Run/Task，也不以投递成功表示用户已处理。隔离 Windows 宿主已实测投递和点击；安装包与协调侧验收未完成，见[专项开发记录](../development/collaboration-controls-2026-09-28.md)。

### 10.49 模型端口只读状态（2026-09-28，开发自检）

**Breaking Change: No。** 新增 `GET /api/v1/workspaces/{workspace_id}/model-port`：返回当前服务实例的模型端口状态 `{ provider: fake|openai-compatible|invalid, configured, model, base_url }`。配置来自进程环境变量（`RELAY_MODEL_PROVIDER` 等），`RELAY_MODEL_API_KEY` 永不返回、不出现在任何响应字段；`base_url` 已由端点策略保证为含公开 https 主机、无凭据/query/fragment 的完整地址。`provider=fake` 表示实例未配置真实模型（委托与 Assist 使用 Mock 模型端口，当前阶段既定门槛）；`invalid` 表示真实 Provider 配置残缺（生产进程本会拒绝启动，此状态供显式读取场景）。状态是实例级只读事实，不依赖 Workspace 数据；沿用 Bearer 边界，未授权 401，`workspace_id` 非 UUID 422。无写命令。验证：真实 PG/HTTP 集成 2 项（真实配置脱敏可见、未配置报 Mock）与单测 4 项。

### 10.50 模型连接验证与最近验证状态（2026-09-29，整改实现）

**Breaking Change: No。** 新增两个实例级端点，响应永不包含密钥或原始响应头。

| 端点 | 行为 |
|---|---|
| POST /api/v1/workspaces/{workspace_id}/model-port/verify | 以固定短文本 
elay-verify-1、非流式、15s 超时发起一次连接验证；结果写入 model_calls（kind='VERIFY'）。响应 { ok, latency_ms, provider, model, config_fingerprint, error_category, verified_at }。并发验证返回 409 MODEL_VERIFY_IN_PROGRESS |
| GET /api/v1/workspaces/{workspace_id}/model-port/verification | 读取最近一次验证结果 + 当前配置指纹是否匹配 + Worker 启动校验诊断 |

配置态拒绝（不外呼、不落账本）：ake/未配置 → 409 MODEL_PORT_NOT_CONFIGURED；残缺 → 409 MODEL_CONFIG_INVALID。

error_category 枚举与设置页指引一一对应：AUTH(401/403)、RATE_LIMIT(429)、TIMEOUT、STREAM_BROKEN、PROTOCOL、NETWORK。

配置指纹与 ModelIdentity.configFingerprint 同算法（不含 API Key）；配置变更后旧验证不自动继承为当前已验证。**连接验证通过不等于真实任务执行成功**，两者在 UI 与本契约中分开表述。验证调用不携带 ContextManifest、不读项目资料。

验证：Fake 注入五分支（SUCCESS/AUTH/TIMEOUT/INVALID_MODEL/NETWORK）真实 PG 落账本可回读；API 单测 5 项；设置页组件 10 项。真实 Provider 外呼待放行，未执行。

### 10.51 N01 项目接续点（2026-09-29，开发自检）

**Breaking Change: No。** 迁移 `0044_project_continuation_points` 只新增 `project_continuation_points` 与 `project_continuation_point_refs` 两张表，不改动既有表、列或索引；`0045_continuation_point_ref_target_guard` 进一步把引用目标 CHECK 改为 NULL 安全并统一两类目标外键为即时检查。0044 的 CHECK 原写作 `task_id = ref_id`，在 `task_id` 为 NULL 时求值为 NULL 而非 FALSE，PostgreSQL 只在 FALSE 时拒绝，脏行因此可落库；已应用迁移不得改写，故由 0045 追加修正。以下四个端点均为新增路径，沿用 `/api/v1/workspaces/{workspace_id}` 前缀与 Bearer/Workspace 边界。Project State、Task、Artifact、Run 与 Review 的形状和状态机均未改变。

Project 拥有接续点身份与说明；其他对象只保存捕获时的确切版本引用（未终结 Task 的 id+revision、Project State 当前选用成果版本），不复制正文，也不维护第二套业务状态。捕获在同一事务内先对本 Project 取 `FOR UPDATE`，因此排除并发 Task 插入，并在进行中的归档期间被拒绝；捕获不停止任何活动 Run，打开项目也不会重设基线。比较只输出事实差异，`interpretation` 恒为 `null`，不由摘要顶替事实。

| 端点 | 行为 |
|---|---|
| POST /api/v1/workspaces/{workspace_id}/projects/{project_id}/continuation-points | 201；接收 `command_id`、`name`（1–120）、`note`（可选，1–2000）。捕获范围超过 200 项返回 422；空名称/纯空白说明 422；Project 已归档 409 `PROJECT_ARCHIVED`；相同 `command_id` 同内容返回原回执（`Command-Replayed: true`） |
| GET /api/v1/workspaces/{workspace_id}/projects/{project_id}/continuation-points | `{ items: 接续点摘要[] }`，按捕获时间倒序，最多 50 条 |
| GET .../continuation-points/{continuation_point_id} | 接续点与其捕获的引用；跨 Workspace 或跨 Project 一律 404 |
| GET .../continuation-points/{continuation_point_id}/comparison | 当前事实与捕获点的差异：State 版本/阶段/下一步是否变化、捕获后新增的未决任务与选用成果版本，以及每条引用的 `change`（`UNCHANGED`/`REVISED`/`CLOSED`/`MISSING`/`CURRENT`/`SUPERSEDED`） |

读取始终复核当前作用域；比较时逐条复核引用是否仍属本项目。`MISSING` 表示该引用在当前作用域下不可用——由于 V1 尚无 Task/Artifact 版本删除入口，且本表外键会阻止删除，该状态目前主要覆盖跨项目或脏引用，**不是常规业务路径**；不得据此声称已具备“来源删除后的恢复”。不以来源最新版替代。`state_artifact_refs` 只插不删：重新选用新版本后接续点会同时捕获新旧两个版本，比较按引用逐条给出 `SUPERSEDED` 与 `CURRENT`，不合并。首片不提供删除、按名称重设基线、后台自动快照与恢复配置建议。

**升级风险（0045）**：若某库在 0044 期间已被写入不满足 `IS NOT NULL` 的引用行（当时应用角色自己就能写脏行），应用 0045 会因新增约束校验失败而**显式失败**，不会静默删行。该库需人工核对 `project_continuation_point_refs` 后再升级；V1 尚未在任何发布包中应用 0044，实际受影响库应为空。0044 本身已应用，内容摘要不得再改——包括注释。

验证：真实 PG/HTTP 集成 4 项（捕获→重放→变化比较不产生第二套状态；跨作用域/非法输入/归档拒绝；成果版本引用的 `CURRENT`/`SUPERSEDED` 与新旧并存；应用角色插入 NULL 脏引用被 CHECK 拒绝）、迁移 8 项与 CLI 迁移台账 45 行、API 单测 136 项。接续点集成连续 3 次运行全绿。独立验收过程与两轮结论见 [N01 验收记录](../testing/n01-independent-acceptance.md)。真实 Windows 人工路径未做。
