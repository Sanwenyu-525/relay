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

**已实现约定（2026-10-02 F24 复验补记）：回执查询必须覆盖「取得候选行锁之后」这个位置。** 只在加锁前查一次是不够的：两个同 ID、同内容的并发请求都会通过那一次查询，然后一起等 `select ... for update`；胜出者连同业务效果和回执提交后，输的一方若不再查一次，就会把同一次操作的第二个视角误判成一次新决定。受影响的两个命令都改为在候选行锁到手后立即重查同 scope/command 的回执，存在则沿 `resolveExistingReceipt` 返回原结果（`command-replayed: true`）：

- `POST /assist-proposals/{id}/accept` 的 Task Skill 路径：此前输的一方读到已 `ACCEPTED` 的提案，返回 409 `INVALID_TRANSITION`；
- `POST /projects/{project_id}/blueprint-proposals/{id}/apply`：此前输的一方走 `ACCEPTED` 分支再插一条同 `command_id` 回执，撞唯一约束，返回 500 `INTERNAL_ERROR`。

摘要不同仍由同一入口抛 `COMMAND_ID_REUSED`，幂等重放不放宽异内容；维护准入、来源、执行权、版本与摘要校验都在该位置之前完成，不因重查而跳过。反例见 `f24-proposal-idempotency.integration.test.ts`（真实 PG + HTTP，用受控行锁确认两个请求都已进入等待后再放行）。

**同 scope 下不同候选的命令冲突（2026-10-03 补记）。** 候选行锁只能串行**同一候选**；同一工作空间里用同一个 `command_id` 去接受两个**不同**候选时，两个请求各自锁各自的行、各自越过上面那次回执重查，直到写同一条命令回执时才相遇。谁先插入谁提交，后到者拿到唯一约束冲突。这不是业务失败，必须翻译成与通用幂等路径一致的结果，而不是 500：

- 自定义事务入口（含 `POST /assist-proposals/{id}/accept` 与 `POST /projects/{project_id}/blueprint-proposals/{id}/apply`）捕获唯一约束冲突后，用 `resolveReceiptAfterUniqueViolation` 在**新的正常事务上下文**读一次胜出回执：摘要相同返回原成功回执，摘要不同抛 `COMMAND_ID_REUSED`（409），读不到可核对回执则原样抛出原错误。
- 冲突事务已经完整回滚，所以失败候选仍为 `PENDING`，其 Task/项目验收、State、View 与任务数量都不变，也没有额外审计；胜出方只有一条回执与一次业务效果。
- 该处理只在唯一约束冲突时生效，不捕获其他异常，也不放宽首次执行的维护准入、作用域、来源、执行权、版本、摘要与单事务约束。

反例同样在 `f24-proposal-idempotency.integration.test.ts`：用 `lock table command_receipts in exclusive mode` 把两个请求精确停在插入回执处（该锁与回执查询所需的 ACCESS SHARE 兼容，所以两个请求会先跑完所有读取），确认两个会话都已排队后再放行；断言与到达顺序无关，一律以胜出回执和数据库里的终态判断谁赢。

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
| GET /goals?status=… | — | 200 | Workspace 级列表，不按 Project 收敛；status=active（默认）/archived/all；limit 默认 50、最大 100；排序键 (created_at, id) 倒序，游标绑定过滤条件与 Workspace |
| GET /goals/{id}/projects | — | 200 | 该 Goal 当前关联的 Project（含已归档，由 archive_status 表达）；只返回既有 Project 事实（`project_revision` 是 Project 自身修订），不派生状态、不写入 |
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
  - 2026-10-16 只读导航增量：两处均支持可选 `include_context=true|false`（查询字符串；省略或 `false` 不新增返回字段）。`true` 时附 `context: {project_goals: [{goal_id,title}], working_directory: {resource_id,canonical_root}|null}`。`project_goals` 只投影该会话所属 Project 的已保存 Goal 关联，不代表会话直接绑定 Goal，也不代表 Task 的显式 Goal 对齐；同一 Goal 可跨项目与本地目录，但不跨数据库 Workspace。`working_directory=null` 表示未绑定，已绑定而规范路径不可读时对象保留资源身份且 `canonical_root=null`。投影按 Workspace 过滤；若两次只读间会话 revision 变化，省略 `context`，客户端显示待核对，不混用新旧归属。不新增命令、表、迁移或权限；**Breaking Change: No**，旧调用方和旧客户端不受影响。
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

2026-09-30 工具输出拒绝的证据保全修复（**Breaking Change: No**）：模型返回原生工具参数或非文本内容时仍由 Adapter 拒绝，不执行工具；已有 `provider_request_id` 与 `usage` 字段保留拒绝前实际观察到的请求 ID 和合法规范化用量，缺失 ID、未观察用量保持 null，不复制工具参数、原始响应或异常正文。`ModelToolOutputError` 属于能力边界，消息的 `provider_error_kind` 仍为 null。先收到正文再拒绝时，失败结算删除临时预览，原调用已记录的首文本/首预览时间保留。当前 SDK 的 SSE 用量在流结束时才形成规范化 chunk，提前拒绝不推算未消费的 wire 用量。字段、状态码、取消/重试/完成权限不变；实际范围见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。该拒绝语义适用于**不声明工具的入口**（Assist、Skill、语义检查）。2026-10-04 起，已声明工具的 DRAFT 入口对「正文与工具并存」不再拒绝，改为返回 `TOOL_CALLS` 并把该正文作为 `preamble` 交给结算方，理由与未持久化的边界见[运行架构 §2.3](../architecture/runtime-context.md#23-内部工具循环的对象身份与恢复2026-10-03-实施设计)。HTTP 契约、字段与状态码均不变。

`0019_m04_draft_read_input` 为新 DRAFT 调用增加结构化输入 SHA-256 与原 `read_operation_id`/`read_invocation_id`（旧行保持 NULL）；操作历史的原正文不复制到计量表。FILE_READ/WEB_FETCH 成功证据按最多 16 KiB UTF-8 完整字符截取，并在 DRAFT 前按原 Manifest 估算口径计入预算；原正文 SHA-256、提取文本 SHA-256、实际片段 SHA-256 和 `UNTRUSTED_DATA` 标记随模型输入建立。额外元数据仍超预算则 DRAFT 以 `CONTEXT_REQUIRED_OVER_BUDGET` 失败且零模型调用。已结算类型化读取 `FAILED` 保留原操作和调用证据，Run 进入 FAILED、Task 释放回 READY；待处理控制意图仍先按安全点处理，`UNKNOWN` 仍需核对。**Breaking Change: No**：Delegate 参数、Run/Gateway HTTP DTO 与既有错误结构不变；本次改变的是新 Run 的内部动作顺序与模型输入。旧 DRAFT 已成功的 Run 保留旧顺序及原批准/操作身份。

### 10.30 缓存用量与上下文占用分母（2026-10-02，开发自检）

**Breaking Change: Yes（Assist 消息 `usage` 与 `/model-port` 响应新增字段）。** `GET /assist-sessions/{id}/messages?limit` 的 `usage` 从 `{input_tokens,output_tokens}` 扩为 `{input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens}`，新增两项各为非负整数或 `null`。`null` 表示 Provider 未上报该字段，**不表示精确 0**——「没有缓存命中」与「Provider 没报」在协议上不可区分，UI 不得把 `null` 画成 `0%`（当前实现：没有读数时命中率那一格整体不渲染，规则见[工作台 §17.6](../frontend/workbench-design.md)）。按原两字段 schema 严格解析的客户端会因未知字段报错；本仓客户端已把这两项按可选字段处理（缺失等同 `null`），旧服务端无需升级。

数据来源：`openai-compatible` 端口读取 Provider 的 `usage.prompt_tokens_details.cached_tokens` / `cache_write_tokens`（SDK 归一化为 `usage_metadata.input_token_details.cache_read` / `.cache_creation`），经既有 `validUsage()` 校验后原样落库。数据库关联 `0049_m04_model_call_cache_usage`：`model_calls` 与 `assist_messages` 各加两个可空列，历史行保持 `null`（迁移不回填，因为无法区分真实零与未知）；`USER` 消息由 CHECK 约束强制恒为 `null`——它从不是一次模型调用。检查约束保证 `cache_read + cache_creation ≤ input_tokens`，避免 Provider 口径不一致时落库自相矛盾。Fake 端口显式给 `null`：离线确定性模式不伪造计费事实。

一处已知边界：LangChain SDK 的 `_streamResponseChunks` 用单个变量累积 usage，并在流结束时**只 yield 一次** usage chunk。若 Provider 把 `prompt_tokens_details` 与 token 数分开发送，SDK 层会用后到的裸 usage 覆盖，缓存读数丢失为 `null`。这是 SDK 行为，端口层无法补救；表现是「少报」而非「虚报」。

`GET /model-port` 响应新增可空 `max_call_tokens`（整数或 `null`），即 `RELAY_MODEL_MAX_CALL_TOKENS`，供 UI 作为上下文占用的分母。`provider='fake'` 或配置残缺时为 `null`，客户端须据此显示「占用不可算」而不是回退到某个默认上限。这是**当前配置值**而非历史快照：配置变更后用它解释旧调用会失真，因此 UI 只把它用于「最近一次调用」的即时读数并旁标绝对 token 数，不作为可追溯的历史事实存储。

此 DTO 仍不提供计费总额、金额或成本单价。上下文预算的既有 `ESTIMATED_UTF8_BYTES_DIV_3` 口径不变；圆环显示的是 Provider 报告的**输入 token** 与单次上限之比，不是模型上下文窗口占用率。

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

消息来源的历史投影会重新核对当前可见性：已失权的普通 `DISCUSS` 正文返回 null，来源 ID/正文不出响应；仍可见来源保留既有记录字段。结构化提案、Skill、语义检查和 Run DRAFT 不在此端点公开原始生成片段；Run 的独立端点见 §10.39。临时草稿的容量/速率、删除和跨进程读取由 [物理设计 §41](../database/physical-design-postgresql.md)说明；真实 Provider 与前端首字延迟仍需单独验证。2026-10-18 起新增可选的 SSE 加速通道（§10.59，帧体即本 DTO）；本端点保留为权威快照与降级路径。

### 10.39 M04 Run DRAFT 生成中临时草稿（2026-09-26）

**Breaking Change: No（新增只读端点）。** `GET /api/v1/workspaces/{workspace_id}/runs/{run_id}/draft-preview` 使用现有 Bearer 与 Workspace 鉴权，返回 200、`Cache-Control: no-store`，严格对象 `{run_id,run_status,step_attempt_id,attempt_claim_epoch,model_call_id,preview_revision,preview_text,preview_truncated,preview_available}`。ID 为 UUID 或 null，epoch/revision 为十进制字符串或约定的 null；`preview_text` 为最多 16 KiB UTF-8 的累计 Markdown 前缀或 null，`preview_truncated` 表示前缀已达上限。生成中的当前 DRAFT Attempt 尚无首片段时可返回当前 `step_attempt_id` 与 `attempt_claim_epoch`、`preview_available=true`，而 `model_call_id/preview_text=null,preview_revision='0'`。同一 Attempt 的实际片段绑定原 `model_call_id`，递增 `preview_revision` 供重读去重。

只有 Run 当前为 RUNNING、Task 仍由该 Run 占有、DRAFT Step/Attempt 为当前领取、Worker 与 dispatch invocation/租约有效、无 PENDING 控制请求，且当前 Manifest 及冻结 FILE_READ/WEB_FETCH 读证据的来源仍可见时草稿可用。重试的新 Attempt 或 Worker 领取使旧前缀不可见，旧回调不能覆盖；来源撤销、连接/策略/资源停用、租约失效、取消、失败或步骤终结返回 `preview_available=false,preview_text=null,preview_revision='0'`，不回显来源引用。不存在或跨 Workspace Run 返回 404 `RESOURCE_NOT_FOUND`，缺失/错误 Bearer 返回 401。客户端断线后重读并按 Attempt、claim epoch、模型调用与 revision 识别累计文本；终态必须查询原 Run/Artifact，临时草稿不创建 Artifact、不证明验证 PASS 或 Task DONE。现有 Run SSE 仍传事实刷新提示，此端点以短轮询读取片段；真实 Provider、前端首字延迟与桌面体验尚待测。2026-10-18 起新增可选的 SSE 加速通道（§10.59，帧体即本 DTO）；本端点保留为权威快照与降级路径。

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

2026-10-02 增量（**Breaking Change: Yes，响应新增 `max_call_tokens`**）：同一响应增加可空 `max_call_tokens`，即 `RELAY_MODEL_MAX_CALL_TOKENS`，作为 UI 上下文占用圆环的分母；`fake` 与 `invalid` 为 `null`。其余字段、状态码与脱敏边界不变，详见 §10.30。

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

### 10.52 N02 跨成果候选组与组合检查单（2026-10-02，开发自检）

**Breaking Change: No。** 迁移 `0050_n02_impact_candidate_groups` 只新增 `artifact_impact_candidate_groups`、`artifact_impact_candidate_group_items`、`artifact_combination_checks` 与 `artifact_combination_check_items` 四张表，不改动既有表、列、索引或约束。以下四个端点均为新增路径，沿用 `/api/v1/workspaces/{workspace_id}` 前缀与 Bearer/Workspace 边界。Artifact、Task、Verification 与 Assist 的形状和状态机均未改变。

候选组只回答「哪几个确切目标被放在一起看」：Application 协调，Artifact 仍是版本与锁的唯一 Owner。组**不保存成果正文、不调用模型、不产生候选、不推进任何 revision、不授予执行权**，也不承诺跨多个成果的全有或全无。逐项应用继续走既有 `POST /impact-candidates/{candidate_id}/apply`，组只旁读该命令的回执。组合检查单是覆盖快照，不是 Verification 会话：它没有整体结论列，也不新增 `verification_sessions` 行。

| 端点 | 行为 |
|---|---|
| POST /api/v1/workspaces/{workspace_id}/impact-checks/{impact_check_id}/candidate-groups | 201；接收 `command_id` 与 `target_version_ids`（1–10 项、不重复）。每项必须逐项来自该检查已登记的直接引用，否则 409 `INVALID_TRANSITION`；空数组、重复项或超限在 schema 层 422。来源成果修订已变化或变化后版本不再最新时 409。相同 `command_id` 同内容返回原回执（`Command-Replayed: true`） |
| GET /api/v1/workspaces/{workspace_id}/impact-candidate-groups/{group_id} | 组与逐项当前状态：`relation`、`speculative`、`availability`、`analysed`、`target_artifact_revision`、`target_is_current_version`、`candidate_id`/`candidate_status`/`candidate_error_code`/`candidate_stale`、`applied_version_id`，以及 `summary`（`total`/`applied`/`with_candidate`/`without_candidate`/`stale_candidates`/`unavailable`）、沿用检查本身的 `unanalysed_scope` 与 `combination_check_ids`。跨 Workspace 一律 404 |
| POST /api/v1/workspaces/{workspace_id}/impact-candidate-groups/{group_id}/combination-checks | 201；接收 `command_id` 与 `artifact_version_ids`（1–20 项、不重复）。每项必须落在该组的来源 after 版本或目标版本范围内，否则 409；所选版本跨 Task 时 409——跨 Task 的整体判断仍归原验收流程。返回 `combination_check_id`、`item_count`、`gap_count` |
| GET /api/v1/workspaces/{workspace_id}/combination-checks/{combination_check_id} | 覆盖快照：`overall_result` 恒为 `NONE`，`overall_note` 固定说明这不是整体验收结论；逐项给出 `is_current_version`、`readable`、`verification_session_id`、`verification_status`，外加 `gaps[]` 与 `stale`（验收修订或任一版本身份已变化）。跨 Workspace 一律 404 |

`gap` 只记录**当时可计算**的缺口，不用推断补齐：正文不可读、已不是当前版本、在该 Task 当前验收修订下没有单项验证会话、单项验证状态不是 `PASS`、验证适用性已被撤销、组内某条登记引用在当前事实中不存在，以及检查本身范围被截断或超上限。「登记引用不存在」按检查实际登记的父版本（**变化前版本**）复核 `artifact_lineage_edges`，与 `startArtifactImpactCheck` 取边口径一致；核变化后版本会把每条正常登记的引用误报为不存在。单项验证会话按 `task_id + acceptance_revision` 过滤并另行核对适用性撤销，因此多个单项 `PASS` 也不能被折算成组合通过。

**客户端约定**：`overall_result` 不是 `NONE` 的响应必须被前端拒绝，不渲染为整体结论；`gaps` 为空只表示本单未发现缺口，不表示组合已通过。候选组可以收下 AI 推测项并标 `speculative`，但推测项的确认门槛在候选生成命令上强制，进组不构成确认。首片不含候选间依赖联动、不完整选择的拒绝、组级回滚与外部格式来源。

验证：真实 PG/HTTP 集成 3 项（建组→重放不产生第二个组→逐项应用后部分成功如实呈现且 Task 修订只推进一次；未登记目标/重复目标/来源变化后再建组/跨作用域读取被拒；组合检查绑定确切版本集合、正常路径不产生「登记引用不存在」缺口、该边确实消失时缺口出现、并逐项列出无验证会话的缺口）。迁移与 CLI 台账基线随目录当前 51 行（`cli.integration.test.ts` 的迁移清单此前停在 0047/47 行、已落后于实际库，本轮更正；该显式清单是「CLI 不重复应用已落地迁移」的回归断言本身，每新增一个迁移都需同步）。真实 Windows 差异审阅与 PV08 体验记录未做。首轮独立验收结论为 CHANGES_REQUESTED，唯一阻塞项（登记引用缺口核错父版本造成每项假缺口）与两项 P3 已修复并复跑，独立复验结论见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

### 10.53 N03 项目知识导读编排与整理候选（2026-10-02，开发自检）

**Breaking Change: No。** 迁移 `0052_n03_project_knowledge_guide` 新增 `project_knowledge_guides` 与 `project_knowledge_guide_entries` 两张表；`0053_n03_knowledge_curation_candidates` 新增 `knowledge_curation_candidates` 一张表。均不改写既有表、列、索引或约束。以下七个端点均为新增路径，沿用 `/api/v1/workspaces/{workspace_id}` 前缀与 Bearer/Workspace 边界。Knowledge、Decision、Rule、Artifact 的形状与状态机均未改变。

导读由 Project 拥有；条目只保存确切引用与人工标签，**不复制正文，也不维护第二份当前状态或 revision**。知识、决定、规则、成果版本四类目标各用一个可空外键列，`ref_kind` 与「恰好一个目标列非空」由 CHECK 强制——用 `IS NOT NULL` 判定而非等值比较，正是为了避免 `0044` 曾出现的「NULL 求值为 NULL 而非 FALSE，脏行可落库」陷阱。`PINNED` 钉住确切知识版本，`CURRENT` 只作导航、读取时解析到当前版本；两者必须能分辨，因此只有 `KNOWLEDGE` 允许 `PINNED` 且必须给出 `pinned_version_id`。

整理候选只由**用户主动请求**产生，是「可能重复」的人工提示与建议归类，不是模型判断：它不自动合并、不自动删除、不改写任何 Rule / Decision，也不因相似度自行产生知识版本。相似提示只按标题字面（完全相同或去空白后公共前缀 ≥4 字）给出并附理由，**前缀阈值只是启发式，不是相似度结论**。接受复用既有 `AddKnowledgeVersion` / `CreateKnowledge`，因此新版本照样不可变、照样要人工验收。

| 端点 | 行为 |
|---|---|
| GET /api/v1/workspaces/{workspace_id}/projects/{project_id}/knowledge-guide | `{ project_id, exists, revision, entry_count, entries, gaps }`。逐条给出 `ref_kind`、`reference_mode`、`target_id`、`label`、`title`、`resolved_version_id`、`resolved_version_number`、`target_status`、`is_current`、`resolution`（`AVAILABLE`/`ARCHIVED`/`SUPERSEDED`/`STALE`/`CROSS_SCOPE`/`MISSING`）与中文 `note`。固定引用解析不到时为 `MISSING`，**不静默换成当前版本**；项目不存在或跨 Workspace 一律 404 |
| PUT .../projects/{project_id}/knowledge-guide | 200；接收 `command_id`、`expected_revision` 与 `entries`（0–200 项）。整份替换式保存（编辑导读就是替换清单），故条目可 DELETE，但它们指向的知识版本/决定/规则/成果版本仍不可变。每项必须且只能提供与 `ref_kind` 对应的一个 ID；同一对象不得重复；`label` 1–200 字。跨项目引用、`PINNED` 缺版本或版本不属于该知识、`CURRENT` 却带版本、非知识类型 `PINNED` 一律 409 `INVALID_TRANSITION`；schema 层错 422。**取得 Project 行锁后会再查一次原回执**，因此同 `command_id` 的顺序重放与并发都返回原回执（`Command-Replayed: true`）且只推进一次修订；仅在修订确实被**别的**命令改动时才 409 `REVISION_CONFLICT`。返回 `revision` 与 `entry_count` |
| POST .../projects/{project_id}/knowledge-curation-candidates | 201；接收 `command_id` 与 `sources`（1–10 项，各含 `artifact_version_id` 与可选 `suggested_title`）。只接受本项目成果版本，否则 409。返回 `candidate_ids`；此刻**不产生任何知识版本** |
| GET .../projects/{project_id}/knowledge-curation-candidates | `{ items }`，按创建时间倒序、最多 20 条。每项含来源成果版本号、`suggested_title`、`suggested_knowledge_id`（**仅本项目**知识中字面完全相同者；工作空间级知识不会被建议为收录目标）、`similar[]`（含 `reason`）、`status`（`PROPOSED`/`ACCEPTED`/`REJECTED`/`STALE`）、接受结果、`rejected_at` 与 `stale_reason`。**终态优先于缺口**：已接受或已拒绝的候选 `stale_reason` 恒为 `null`。先复核 Project 作用域，跨 Workspace 404 |
| POST .../projects/{project_id}/knowledge-curation-candidates/{candidate_id}/accept | 200；接收 `command_id`。**不是独立命令，但满足契约第 2 节的幂等语义**：「锁候选 → 复核 → 写知识版本 → 绑定候选 → 写回执」全部在**同一个事务**内完成。命令不可嵌套，因此复用既有 `CreateKnowledge` / `AddKnowledgeVersion` 的 execute 主体（新增 `*InTransaction` 变体，不再自开事务、不再自写回执），由本端点写自己那一条回执。返回 `candidate_id`、`knowledge_id`、`knowledge_version_id`、`knowledge_revision` 与 `mode`（`CREATED`/`NEW_VERSION`）。同 `command_id` 同内容重放或并发都返回原回执并带 `Command-Replayed: true`，不会产生第二个知识版本；来源成果已变化、已接受或已拒绝均 409；跨 Workspace 404 |
| POST .../projects/{project_id}/knowledge-curation-candidates/{candidate_id}/reject | 200；返回 `{ candidate_id, status: 'REJECTED' }`。已接受的候选 409；拒绝后不能再接受 |

`POST .../accept` 不套 `createCommandHandler`，因为命令不可嵌套；它自己写一条 `command_type` 为 `AcceptKnowledgeCurationCandidate` 的回执，因此查询回执请用该 `command_id` 查这一类型，而不是内层知识命令的类型。**这是与其它命令不同的实现方式，不是幂等语义上的例外。**

**已知限制**：`resolution: MISSING` 在当前 API 下**实际不可达**——`AddKnowledgeVersion` 拒绝已归档知识，且 `knowledge_versions` 有外键保护无法删除，因此钉住的确切版本不会消失。该分支为纵深防御，不是常规业务路径，不得据此宣称已具备「来源消失后的恢复」。

验证：真实 PG/HTTP 集成 5 项（导读 `PINNED` 与 `CURRENT` 可分辨、知识新增版本后 `PINNED` 仍解析到钉住版本并标 `STALE`、`CURRENT` 跟随当前、保存不改写被引用对象也不新增知识版本、旧修订 409 与同命令重放；错配目标/重复条目/跨 `PINNED` 组合/跨项目引用 409 与五种脏行被 CHECK 拒绝；跨 Workspace 读写 404、被替代的决定标 `SUPERSEDED` 且不静默换成新决定；候选只提示不合并且提示后既有知识版本数不变、接受后版本 +1 且旧版本不被覆盖、已接受/已拒绝/来源变化后均不能再接受、跨项目成果不能提候选、**拒绝后读取报 `REJECTED` 且 `stale_reason` 为空**、**工作空间级同名知识不作为建议归入目标**；**接受与拒绝并发 3 轮只能得到一个结论，被拒候选不留孤立知识版本；同 `command_id` 顺序重放与并发接受都返回原回执且只产生一个知识版本；同 `command_id` 并发保存导读只推进一次修订**）。迁移与 CLI 台账基线补至 53 行。前端已接入：知识页「项目知识导读」开关内为编排视图，成果版本谱系页底部为整理候选面板，交互见[工作台交互第 12.4 节](../frontend/workbench-design.md#124-项目知识导读n03-形态2026-10-02规划已确认前后端均已接入)。真实 Windows 阅读与 PV03/PV08 体验记录仍未做，**没有使用收益结论**。

首轮独立验收结论为 CHANGES_REQUESTED，发现 1 个 P1（接受不锁候选行，与拒绝并发时被拒候选仍产生知识版本且该版本在候选审计链上无归属）与 4 个 P2（拒绝态在读取模型中丢失、接受与保存的同 `command_id` 并发/重放不返回原回执、工作空间级同名知识造成永久死路），均已修复并由上述并发与终态用例覆盖。独立复验结论见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

### 10.53 文件夹入口与对话执行请求（2026-10-02，源码实现）

**Breaking Change: No**（新增端点与一个可选的委托字段）。迁移 `0051_conversation_execution_requests` 只追加 `conversation_execution_requests` 一张表；Task、Run、Review、Assist、Gateway 的既有状态与路由不变。`POST /tasks/{task_id}/delegations` 新增**可选** `cli_run_action`，不传时行为与迁移前完全一致。

`POST /working-directories/open` 是写命令（可能建立最小 Project 与受管资源），因此**页面读取不得调用它**；`command_id` 回执在目录此后被移动或删除时仍按原结果重放。

`InterpretConversationMessage` 与 `ApplyConversationExecution` 是两个命令：模型调用发生在事务外，候选先落库；第二步按请求行上固定的三个阶段命令身份调用既有 `CreateTask` / `MarkTaskReady` / `DelegateTask`，重放只重放原回执，不会产生第二个 Task 或 Run。**模型只解释，授权来源永远是请求里的 `source_message_id` 指向的那条原用户消息。**

**2026-10-13 基础接续修正，Breaking Change: No。** Task 已建立但缺连接等准备失败时，保留 `TASK_PREPARED` 和原阶段命令身份；补齐配置后再次调用同一请求的 `applications`。若原 `DelegateTask` 已提交而最后的请求阶段保存失败，先按同 Workspace 的原 `delegate_command_id` 读取持久回执，核对命令类型、Task 及 Run 归属，仅关联原 Run 并推进 `DELEGATED`，不重新计划或调用模型。阶段提交仍受 NORMAL 维护准入门保护；缺失原阶段命令身份时返回 409 要求核对，不生成新身份。请求/响应结构与数据库结构均不变，无新 migration。

**2026-10-14 基础客户端接线修正，Breaking Change: No。** `applications` 成功响应沿用 `{ command_id, committed_at, result, links }`，`command_id` 为原 `request_id`；`request_id/status/task_id/run_id/revision` 在 `result` 内。前端 `applyConversationExecution` 统一解析命令回执后读取 `result`，避免后端已成功建立 Task/Run 而客户端报阶段字段缺失。后端契约和数据库结构不变。

| 端点 | 行为 |
|---|---|
| POST /api/v1/workspaces/{workspace_id}/working-directories/open | 200。需要 `command_id`、`root_path`（1–1024），可选 `project_id`。`status` 为 `READY` / `AMBIGUOUS` / `NOT_READY`；`AMBIGUOUS` 表示同一实际目录关联了多个项目，需再带 `project_id` 选一次；`NOT_READY` 带稳定 `reason`（`MULTIPLE_PROJECTS` / `PROJECT_ARCHIVED` / `RESOURCE_DISABLED` / `OVERLAPPING_OTHER_PROJECT`）。成功处理用户主动选择的目录时，Application 建立/复用本地只读基础读取配置；若工作区**尚无**默认工作目录且本次 `READY`，同一事务内顺手把它登记为默认目录（已有默认不覆盖，2026-10-19）；`write_readiness` 是原 Gateway 投影，不代表批准。回执含策略字段 `policy_decision` / `policy_id` / `policy_revision` / `policy_target_prefix`，并新增可选 `write_tier` / `access_revision`；旧命令回执重放可能缺后两字段，客户端按未核对处理。已有重叠受管根时不会新开项目造出第二个写 Owner。不存在或不是目录 422。 |
| POST /api/v1/workspaces/{workspace_id}/assist-sessions/{session_id}/execution-requests | 202。需要 `command_id`、`source_message_id`（该会话内一条已完成的 USER 消息）、`resource_id`（同项目 ACTIVE 受管资源）。返回 `decision`、`status`、`candidate_status`、`questions` 与候选摘要。原消息不属于该会话、非 USER 消息、未完成、会话未绑定 Project 或资源不可用时 409。同一原消息或同一 `command_id` 重放返回同一条请求，不重付模型整理成本。 |
| POST /api/v1/workspaces/{workspace_id}/conversation-execution-requests/{request_id}/applications | 200。按固定的阶段命令身份建立真实 Task → READY → Delegate。候选不是 `READY`、受管资源不可用、或项目缺少绑定该目录的 `FILE_QUERY` / `FILE_READ` / `FILE_WRITE` / `CLI_RUN` 连接时 409 并给出**第一项缺失能力**的具体原因；本端点**不创建连接、不放宽权限**。重复调用返回同一个 `task_id` 与 `run_id`。 |
| GET /api/v1/workspaces/{workspace_id}/conversation-execution-requests?session_id= | `{ items: 会话内最近的执行请求摘要[] }`，只读，不创建对象、不外呼。2026-10-16 增加持久化 `resource_id` 与 `candidate`（对象或 null），用于主流程后恢复原候选的标题、目标与检查；单条 GET 同步。Breaking Change: No，旧客户端忽略增量字段，新客户端兼容旧响应缺少字段。 |
| GET /api/v1/workspaces/{workspace_id}/conversation-execution-requests/{request_id} | 单条执行请求投影；不属于该 Workspace 时 404。 |

**2026-10-04 改为冻结工具循环信封（用户选定方案 B）。** 解释阶段只产出**目标与范围**，`file_changes` 的每一项只有 `path` 与 `action`；带 `content` 会被确定性拒绝（`候选 INVALID`），因为解释模型没有任何目录访问，正文只能是编造。Delegate 时冻结 `tool_loop_action` 与 `scope_grant`，不再冻结 `file_write_action` / `cli_run_action`：

- 工具词表按「本次真正要用、且本项目确实配了连接」生成：读集 `list_directory` / `find_paths` / `search_text` / `read_file` 必备；本次要写文件才加 `apply_changeset` + `read_change_set`；声明了检查才加 `run_check`；本项目配了 `GIT_READ` 连接才加 `git_status` / `git_diff` / `git_log`。少给一个工具就是少一条能力边界，因此不预先塞满词表。
- **2026-10-04 补齐写能力开关**：候选 `task` 新增可选布尔 `writes_files`（用户是否明确要求改动这个目录里的文件）。写能力按 `writes_files === true || file_changes.length > 0` 判定，不再要求解释模型先猜出文件名——它没有任何目录访问，拿不准路径是常态。字段缺省按「列出了文件变更」推导，旧请求体继续得到同一判定，因此**请求与响应结构、字段语义均为 No Breaking Change**；只读盘点声明 `writes_files: false` 时不会获得写能力。
- `scope_grant` 放行 `APPLY_CHANGESET`（本次要写文件时）与 `CLI_RUN`（声明了检查时）。**删除永远不在授权动作里**；扩大范围同样要再确认。**纯只读任务不产生 `scope_grant`**（`run_scope_grants.allowed_actions` 有 `cardinality >= 1` 的有意非空约束，空授权改为不落这条事实），对应的 `allowed_tools` 只有读集、`connections` 不含 `FILE_WRITE`。
- 缺连接时报出**第一项缺失能力**：`FILE_QUERY` → `FILE_READ` → `FILE_WRITE` → `CLI_RUN` 按实际需要解析。只读准备此前无条件要求 `FILE_WRITE`（恒真判断），已移除；只读请求不再被一条用不上的写能力挡住。
- 检查按候选给的 `executable` / `args` 冻结成清单项 `check-1`，并**实测**该程序的内容摘要。相对路径按受管根解析；解析不到真实文件就 409，不给一个没有摘要的授权。模型只能按 `check_id` 点名这份清单。
- 循环预算固定 `max_rounds: 6` / `max_tool_calls: 12`。
- 其余语义不变：模型只解释，授权来源永远是 `source_message_id` 指向的那条原用户消息；`FILE_WRITE` 与 `CLI_RUN` 都不是 `approvalPassthrough` 能力，每一次真实动作仍单独产生绑定确切目标与参数的 `ACTION_APPROVAL` Review。

`cli_run_action` 的端点契约本身不变（仍接受一个 `executable` 与 1–32 个字符串 `args`，可选 `max_output_bytes` ≤ 1 MiB，永远经 `shell: false` 的 CLI adapter 执行）；只是文件夹入口不再走这条链。与 `mock_gateway_action`、`file_read_action`、`web_fetch_action` 混用一律 409 的规则也不变。

验证覆盖见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。本节不含本轮运行结果。

### 10.56 Run 工具调用只读投影（2026-10-04 设计，2026-10-05 源码实现）

**Breaking Change: No**。新增一个只读 GET 端点，不改任何已有路由、请求体、响应体或状态语义。配套迁移 `0057` 只增加 Run 刷新事件的来源，不改 `run_tool_calls` 表结构（物理设计归[第 60 节](../database/physical-design-postgresql.md)）。

`ReviewSchema` 同期新增一个可空字段 `operation_id`（`ACTION_APPROVAL` 绑定的确切动作身份，其它 kind 为 `null`）。这是**只增不改**：既有响应多一个可能为 `null` 的字段，消费者按缺失即 `null` 处理。工具轨迹按它把审批挂到对应那次工具调用上，而不是靠时间或文案猜测。

`GET /runs/{run_id}/tool-calls`

协作页用它呈现「模型这一轮实际做了什么」，交互规则归[工作台 §18.8](../frontend/workbench-design.md#188-工具轨迹的呈现2026-10-04c-片设计)。它是纯只读投影：不创建、不修改任何状态，不新增权限、审批或控制意图。

| 字段 | 约束 |
|---|---|
| `run_id` / `run_status` / `wait_reason` | Run 事实投影；`wait_reason` 缺省为 `null`，预算耗尽等终止类原因在此显示 |
| `rounds[].round` / `model_call_id` | 0 起轮次，产生该轮请求的那次真实模型调用 |
| `calls[].id` | 工具调用行身份，同时也是该行的 `logical_operations.id`（未派发行除外）。前端以它作 React key 与折叠态身份，不用数组下标 |
| `calls[].tool_name` | 封闭词表内的工具名，取自 `tool-catalog.ts`；未登记的名字不会出现在响应里（落库前即被拒） |
| `calls[].provider_tool_call_id` | Provider 的轮内关联标签。它**不是**唯一性来源（跨 Run/轮次可能重名），前端不得用它作 key |
| `calls[].created_at` / `updated_at` | 行写入与最后推进时间，ISO 8601。用于「这次调用花了多久」的诚实呈现：缺 `updated_at` 时不显示耗时 |
| `calls[].ordinal` | 轮内 0 起序号。响应一律按 `(round, ordinal)` 升序，前端不需再排序 |
| `calls[].status` | 封闭词表，与迁移 `0054` 的 CHECK 一致：`REQUESTED` / `PREPARED` / `WAITING_APPROVAL` / `SETTLED` / `REJECTED` / `ABANDONED` |
| `calls[].arguments` / `arguments_sha256` | **原样返回**已落库并通过 schema 校验的参数与其摘要，不做二次规范化或脱敏 |
| `calls[].result_ref` | **原样返回**该行持久化的结果投影。这与模型当时实际消费的是同一份内容（`run-tool-call-repository.ts:123-137` 写明结果投影由调用方从 Operation 的 `result_ref` 截取后写入），因此界面与模型可逐字节对账。`null` 与 `{}` 不可混淆 |
| `calls[].operation_id` | 已派发行指向真实 Operation，未派发行保持 `null`。审批与差异按此身份挂接，不另造引用 |
| `calls[].adaptation_of` / `adapted_path` | 一次自动适配的来源；非适配行为保持 `null` |

边界与不变量：

- **不分页**。单 Run 的工具请求行数受冻结信封约束（`tool_loop_action.max_tool_calls` 上限 48，见 `domain-schemas.ts`），不存在需要翻页的规模。
- **空 `rounds` 是事实而非失败**：该 Run 没有工具请求，200 返回空数组，不返回 404。
- Run 不存在或跨作用域与其他不可见 ID 一律 404，与既有只读端点一致。
- 响应只含受管根内相对路径，不含宿主绝对路径、密钥或可写实体。**但工具结果正文原样透传**：命令自身打印的 stdout/stderr 可能含宿主绝对路径，这与既有 `GET /runs/{run_id}/operations` 的执行输出口径一致（受管根本来就在 `GET /projects/{project_id}/managed-resources` 里以 `canonicalRoot` 明示）。
- `REJECTED` 行必有 `result_ref.reason` 与 `.detail`（迁移 `0054` 的 CHECK 已强制），前端据此显示类型化原因而不是猜测。
- **不新增任何审批**：处于 `WAITING_APPROVAL` 的行只提供指向既有 `ACTION_APPROVAL` Review 的 `operation_id`。批准、暂停、取消仍走既有 Run 控制端点。

刷新：本端点是幂等读取，配合新增的 `run_tool_calls` Run 刷新事件使用——事件只做提示，客户端按提示重读本投影；断线重连按 `GET /runs/{run_id}/events` 的既有游标补读。**不需要轮询**。

本节不含本轮运行结果；验收规格归[测试计划 §20.4](../testing/verification-plan.md)。

### 10.54 模型工具循环信封与只读文件查询（2026-10-03，源码实现）

**Breaking Change: No**（一个可选的委托字段、一个新只读能力、一张新表）。迁移 `0054_m04_agent_tool_loop` 追加 `FILE_QUERY` 能力行、放宽 `ck_logical_operation_resource` 以容纳它（逐条保留 `0030` 的既有分支），并新建 `run_tool_calls`。既有端点、路由与状态不变。

`POST /tasks/{task_id}/delegations` 新增**可选** `tool_loop_action`：

| 字段 | 约束 |
|---|---|
| `resource_id` | 必须是本 Task 所属 Project 下的 ACTIVE 受管资源，否则 409 |
| `connections` | `FILE_QUERY` / `FILE_READ` / `GIT_READ` 各自可选一个连接；每个必须是本 Project 的 ACTIVE 连接且已具备对应能力，否则 409 |
| `allowed_tools` | 1–32 个首批工具名；未知工具名、或某工具缺少对应连接时 409 |
| `max_rounds` | 1–12，默认由服务端按 6 使用；`max_tool_calls` 1–48 |

与 `file_read_action` / `web_fetch_action` 互斥（409）：固定读取与自主循环都会在同一 Run 内读取，两者并存会让「这次读取证据是谁」不确定。信封是**上界不是授权**：每次动作仍按当前 Permission 判定，`ASK` 仍产生绑定确切目录与参数的 `ACTION_APPROVAL`。

`FILE_QUERY` 是第三个 `REAL` 只读能力（`REAL`/`READ`，`approvalPassthrough: true`），逻辑动作 `LIST_DIRECTORY` / `FIND_PATHS` / `SEARCH_TEXT` 共用它。连接配置页因此按同一 `rootBoundCaps` 词表多出这一项。

工具调用的可追溯身份不在 HTTP 契约里，而在 `run_tool_calls`：该行 id 直接作为 `logical_operations.id`，因此同一请求重放永远回到同一个 Operation。行的 `status` 为 `REQUESTED` / `PREPARED` / `WAITING_APPROVAL` / `SETTLED` / `REJECTED` / `ABANDONED`；`REJECTED` 与 `ABANDONED` 行不连 Operation。本轮没有新增工具执行 HTTP 路由——工具由 Run 内部驱动，不接受外部直接派发。

`POST /projects/{project_id}/connections` 的 `capabilities` 现在接受 `FILE_QUERY`，行为与其它 root-bound 能力一致（必填 `root_path`、一条连接只绑一个边界）。

### 10.57 人工触发的受管 Git 只读（2026-10-05 源码实现）

**Breaking Change: No**。新增一个只读投影端点与第三种 Gateway origin，不改任何已有路由、请求体、响应体或状态语义。配套迁移 `0058_m06_user_action_origin.sql` 只放宽三条 CHECK（物理设计归[第 61 节](../database/physical-design-postgresql.md)）。

`POST /api/v1/workspaces/{workspace_id}/projects/{project_id}/managed-resources/{resource_id}/git-read`

请求：`{ command_id, connection_id, action_type: 'GIT_STATUS' | 'GIT_DIFF', path?, cached?, limit? }`。`path` 是**受管根内相对路径**，不接受绝对路径或 `..`；反斜杠穿越与绝对路径按 `GATEWAY_TARGET_DENIED` 拒绝，未知 `resource_id` 按 `RESOURCE_NOT_FOUND`。解析不到按 409/422 拒绝，不猜。`GIT_STATUS` 不接受 `path`/`cached`（422）。`limit` 是展示上限（`GIT_STATUS` 条目数 / `GIT_DIFF` 字节数），**不进冻结参数**——它是展示上限，进 params 会改动 `params_hash` 并虚增 `max_payload_bytes`。

回执 `result` 两形态：

- **settled**：`{ state: 'SUCCEEDED' | 'FAILED', action_type, operation_id, invocation_id, result }`。`result` 为状态投影（`branch`/`head_commit`/`staged`/`unstaged`/`untracked`/`limit`/`truncated`/`totals`）、差异投影（`diff`/`limit_bytes`/`truncated`/`returned_bytes`/`omitted_bytes`），或**失败投影** `{ reason, detail? }`——失败绝不返回空列表，非 Git 目录结算为 `FAILED` 且响应不含 `staged`/`unstaged`/`untracked` 任何一项。
- **pending**：`{ state: 'WAITING_APPROVAL' | 'UNRESOLVED', action_type, operation_id, review_id, reason }`，**不带任何结果字段**。确认前 `Invocation` 数为 0。

策略 AUTO 直通；ASK 返回 `WAITING_APPROVAL` 与 `review_id`，经既有 `ResolveReview` 确认后**用同一 `command_id` 再次投递**才读取、且只读一次；DENY 409 `GATEWAY_PERMISSION_DENIED`。**客户端必须保留并复用原 `command_id`**，否则会产生第二次读取（新 Operation）。

同一 `command_id` 同内容重放返回原回执并附 `Command-Replayed: true`（同一 `operation_id`，`invocation_attempts` 恰好 1 行）；换内容重放 409 `COMMAND_ID_REUSED`。**未结算时不写回执**，因此确认后同一 `command_id` 仍可推进。回执是两段短事务（真实 `git` 子进程按契约不进事务），「补写回执前崩溃」的窗口由确定性 Operation ID 兜底：该窗口内 `command_id` 层面的同内容重放不成立，下次投递返回同一次落库结果。

未结算状态的恢复：`USER_ACTION` 的 `DISPATCHING`/`UNKNOWN` 调用**没有自动恢复驱动**，须先人工核对，不盲重试（契约：租约过期不代表旧进程已停止）。

### 10.58 创建后人工补验收条件（2026-10-05 源码实现）

**Breaking Change: No**。新增路由与命令，既有命令语义不变。轻量起步建的 Task 是零 criterion、停在 `INBOX`，此前补验收条件只能靠 AI 提案接受或 Skill 提案；本节闭合服务端出口，**前端入口仍未接入**。

`POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/acceptance`，`command_type = ReviseTaskAcceptance`，成功码 200，资源链接 `tasks/{task_id}`。

请求含 `command_id`、`expected_revision`（Task revision CAS）、`expected_acceptance_revision`（当前验收版本 CAS）、可选 `objective`（省略即沿用当前版本）、`criteria`（1–30 条，新版本的完整集合，每条含 `criterion_id?`、`statement`、`required?`、`method?`、`target_spec?`），`additionalProperties: false`。结果返回 `previous_acceptance_revision`、`acceptance_revision`、`objective`、`required_output_spec`、`criteria`、`added_criterion_ids`。

| 情形 | 结果 |
|---|---|
| 同 `command_id` 同载荷重放 | 原回执 + `Command-Replayed: true` |
| 同 `command_id` 异载荷 | 409 `COMMAND_ID_REUSED` |
| 旧 Task revision | `REVISION_CONFLICT`，`conflict.entity_type = TASK` |
| 旧验收版本 | `REVISION_CONFLICT`，`conflict.entity_type = TASK_ACCEPTANCE` |
| AI 占有执行权、有活动 Run、有未结算或 UNKNOWN 动作、或状态已是终态 | `EXECUTOR_CONFLICT`（终态须先 `ReopenTask`） |
| 删除/改写/降级既有 **required** criterion | 409 `INVALID_TRANSITION`，`conflict.criterion_ids` 指出是哪几条 |
| 新版本无任何 required criterion | 422 `VALIDATION_FAILED`，`field = criteria` |

写入新不可变验收版本（`source = CONTRACT_CHANGE`，来源差异由 `fact_refs.change_source = HUMAN_COMMAND` 区分，故不需要新迁移）与 criteria，历史版本不原地改写；同一短事务内撤销当前验收周期上的验证适用性（`reason = ACCEPTANCE_CONTRACT_CHANGED`，`source_ref = task_acceptance_revision:<新版本>`）、把该 Task 的 `OPEN` Review 置 `EXPIRED`、写 `TASK_ACCEPTANCE_CHANGED` 审计与命令回执。旧 session 行与旧验收版本**保留不改写**。无模型/网络/CLI/人工等待进入事务。

**只允许收紧或持平**：既有 required criterion 必须逐字节保留（ID/statement/required/method/target_spec），可选 criterion 可改写、加严或丢弃。`required_output_spec` 逐字节沿用，不在本入口改写。全仓**没有**能放宽已确认必需条件的公开入口——需要放宽时的正确出口是 `ReopenTask` 进新周期后在无必需条件的新版本上重建，而这与 `MarkTaskReady` 的前置条件冲突，规则待定；本入口按 `task-lightweight-fence` 的「不得靠放宽验收完成依据来省步骤」实现，与既有 Task Skill 路径方向一致。

本入口与 Task Skill 路径的**有意差别**（已写进代码注释，两条路径规则不同只在各自注释说明，不合并）：①不调用 `loadRulePlanBasis`（Rule 准入在 Delegate 冻结时判定）；②可选 criterion 允许改写/丢弃。

复用说明：本命令的两个 wire schema 暂放在 `apps/api/src/api/task-api.ts`（该文件开工前 40 分钟被并行 Agent 改动且未提交，按共享工作区纪律暂缓并入 `domain-schemas.ts`）。这是技术债，不是设计归属——`domain-schemas.ts` 空闲后应迁回。

### 10.55 工具循环信封扩展写入能力与本次任务范围授权（2026-10-04，源已实施）

**Breaking Change: No**。`tool_loop_action` 新增两个可选能力键，`connections` 现在还接受 `FILE_WRITE` / `CLI_RUN`；新增可选字段 `scope_grant`。新增迁移 `0056_m04_run_scope_grants`。不改已有字段语义，旧请求体继续按原样工作。

`connections` 里的 `FILE_WRITE` / `CLI_RUN` 只是**上界**：信封说明「模型可以请求这类动作」，不代表放行。没有对应范围授权时，这些动作仍然退回落单动作 `ACTION_APPROVAL`，与本节之前的行为完全一致。信封中未列出对应连接的写工具或检查工具，在 Delegate 时按未知工具 409。

`POST /tasks/{task_id}/delegations` 新增**可选** `scope_grant`：

| 字段 | 约束 |
|---|---|
| `resource_id` | 必须与同一请求 `tool_loop_action.resource_id` 相同，否则 409；授权只能收窄信封，不能扩大 |
| `allowed_actions` | 1–4 项，只接受 `WRITE_FILE` / `APPLY_CHANGESET` / `CLI_RUN`。`DELETE` 与 Git 写入不在词表内，传了按 400 |
| `checks` | 已配置检查的冻结清单，每项含 `id` / `executable` / `args` / `executable_sha256`（64 位小写十六进制）/ 可选 `max_output_bytes`。`id` 不得重复或为空 |
| `expires_at` | 可选到期时间；过期后即使 Run 仍在执行也不再放行自动动作 |
| `survives_run_terminal` | 可选，默认 false：授权属于「本次任务」，不跨 Run 继承 |

缺失 `tool_loop_action` 而单独传 `scope_grant` 按 409：`allowed_actions` 含 `WRITE_FILE`/`APPLY_CHANGESET` 但信封没有 `FILE_WRITE` 连接按 409；含 `CLI_RUN` 但没有 `CLI_RUN` 连接或 `checks` 为空按 409。

授权随 Run 在同一事务提交，边界写入后不可改写，只有撤销可推进；应用角色只被授予撤销列的 UPDATE。授权进入命令摘要，因此同一个 `commandId` 不能换一个更宽的授权重放。

`allowed_actions` 里的动作名是**授权口径**，`CLI_RUN` 统一代表「本次任务范围内已配置的检查」：模型只能按 `check_id` 点名，`executable` 与 `args` 来自冻结清单，工具正文里不出现任何可执行内容。

**2026-10-07 补充（检查入口信任摘要）：Breaking Change: No。** 请求体形状不变：客户端仍只提交 `id`/`executable`/`args`/`executable_sha256`/`max_output_bytes`，**不需要**提供信任依据。服务端在 Delegate 冻结期实测 `check-trust-v1` 依据（入口程序 + 第一个位置脚本参数 + 受管根顶层构建/测试配置）并写入持久化的 `checks`；材料读不到或参数属于解释器内联求值 / shell 组合 / 通配符时按 409 拒绝整次 Delegate（详情含 `CHECK_TRUST_MATERIAL_UNREADABLE` 或 `CHECK_TRUST_DYNAMIC_EXECUTION_UNSUPPORTED`）。该依据不出现在任何 HTTP 响应投影中。

**可观察的失效原因**：当范围授权本可 AUTO、却因授权失效或检查材料变化而退回人工时，产生的 `ACTION_APPROVAL` Review 会把类型化原因写进既有开放对象 `evidence.scope_decision_reason`（例如 `SCOPE_GRANT_CHECK_CHANGED`），`reason` 文本也改为说明该原因。`evidence` 本来就是开放对象，旧客户端不认识该键时按原样忽略即可；未发生该情形时该键不出现，既有行为与文案不变。

验证覆盖见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。本节不含本轮运行结果。

### 10.60 会话模式与人设助手（2026-10-05 源码实现）

Breaking Change：Yes（语义）。取舍见 [ADR-018](../decisions/ADR-018-assistant-conversations.md)，工程责任见[运行架构 §2.6](../architecture/runtime-context.md#26-会话级只读工具轮次)。

#### 10.60.1 兼容策略

| 变化 | 影响 | 兼容 |
|---|---|---|
| `POST /assist-sessions` 请求体新增可选 `conversation_mode` 与 `assistant_profile_id` | 既有客户端不传即普通模式 | 既有字段与路由语义不变，无需改客户端 |
| `assist_sessions` 增五列（迁移 0059） | 既有行按普通模式读出 | 列带默认值，既有数据不需回填 |
| 新增四个助手配置端点 | 不改任何既有端点 | 纯新增 |
| 会话 DTO 新增 `conversation_mode` / `assistant_profile_id` / `assistant_profile_revision` / `bot_role` 之外的 `assistant_role` / `remember` | 读取响应多字段 | 严格 schema 校验下，旧客户端若拒绝未知字段需同步；不接受字段缺失当默认值 |
| 同一 `command_id` 换模式重放 | 按异载荷拒绝 | 这是有意的：同一条命令不能既建普通会话又建助手会话 |

旧 URL 无模式参数一律按普通模式解析；不存在「缺参数就猜测助手」的路径。

#### 10.60.2 助手配置端点

| 端点 | 命令类型 | 说明 |
|---|---|---|
| `POST /workspaces/{workspace_id}/assistant-profiles` | `CreateAssistantProfile` | 名字在 workspace 内活跃唯一，重名按字段错误明确拒绝且不改已有助手；`read_scope` 只接受缺省或受管根内相对路径数组 |
| `POST /assistant-profiles/{id}/revision` | `ReviseAssistantProfile` | 带 `expected_revision` 的 CAS；落后按 `REVISION_CONFLICT` 409，不 last-write-wins |
| `POST /assistant-profiles/{id}/archive` | `ArchiveAssistantProfile` | 只推进「是否仍适用」，不改写配置文本；归档后既有会话冻结发消息但历史可读，名字释放给新助手复用 |
| `GET /workspaces/{workspace_id}/assistant-profiles` | — | 默认只列活跃；`status=ARCHIVED` 列归档项，供界面显示「已归档」 |

这些端点的 schema 里**没有** capability、connection 或 permission 字段——助手配置是文本，能力来自连接与 Gateway 准入。

#### 10.60.3 建会话时的身份冻结

`conversation_mode` 与 `assistant_profile_id` 进命令体，因此同一 `command_id` 换模式重放按异载荷拒绝。助手模式必须带 `assistant_profile_id`；跨 workspace 的助手与已归档的助手都建不出会话，错误带上助手名与下一步指引。

会话建立时把助手的名字、角色、口吻、只读范围与当时的修订**冻结**进会话。改写助手不改变既有会话的显示人设；归档助手则让既有会话冻结发消息——快照冻结的是文本，冻结不了「这条依据是否仍有效」。

#### 10.60.4 助手会话的消息准入

| 情况 | 结果 | 理由 |
|---|---|---|
| 带 `skill_ref` | `INVALID_TRANSITION` 409 | 助手只做只读回答，Skill 在这条会话没有意义 |
| `intent` 非 `DISCUSS` | `INVALID_TRANSITION` 409 | 同上；提案会带出写入路径 |
| 助手已归档或跨 workspace | `INVALID_TRANSITION` 409，文案带助手名与「换一个助手」 | 撤销依据不能靠快照续命 |
| 上一条仍在途 | `INVALID_TRANSITION` 409，文案**不得**出现「排队」 | 助手会话不排队；这条会话没有队列 |
| 同 `command_id` 同载荷重放 | 返回原消息回执，附重放头 | 回执判定排在在途判定之前，否则连按两次发送会看到「请等它结束」 |
| 同 `command_id` 异载荷 | `COMMAND_ID_REUSED` 409 | 那是一次新的用户决定 |

普通会话的消息准入逐字未变。

验证覆盖见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)；未运行规格见[测试计划 §23](../testing/verification-plan.md)。本节不含本轮运行结果。

### 10.61 自然语言状态维护：解释、应用与整组撤回（2026-10-09 源码实现，2026-10-10 整改）

总纲 §0.8.1 / 工作台 §18.9 / 领域模型 §12.5 的对话状态维护入口。迁移 `0062` 两张表只保存「原消息 → 确认内容 → 领域命令 → 回执」关系与撤回补偿轨迹，不复制业务事实；每条变更经**原 Owner**（`SetProjectState` / `CreateTask` / `AddTaskDependency` / `CreateGoal` / `LinkProjectGoal` / `CreateDecision` / `CreateKnowledge` / `AddKnowledgeVersion` 等）在独立短事务生效。授权来源永远是 `source_message_id` 指向的原用户消息；模型在事务外只解释候选，服务端按当前事实解析标题引用并重查准入。

| 端点 | 命令类型 | 说明 |
|---|---|---|
| `POST /assist-sessions/{session_id}/state-maintenance-requests` | `InterpretStateMaintenance`（body `command_id`，可选 `timezone`） | 202；`unique(source_message_id)` 去重，同 `command_id` 按原载荷摘要核对（改 `source_message_id` → 409 `COMMAND_ID_REUSED`）；助手档会话与未绑定项目的会话 409 |
| `POST /conversation-state-requests/{request_id}/applications` | —（按请求行 `apply_command_id` 幂等） | 200；逐条变更按固定 `command_id` 调原 Owner，逐条回执 `before_ref`/`after_ref`；终态 `APPLIED`/`PARTIAL`/`FAILED`/`DECISION_REQUIRED` |
| `POST /conversation-state-requests/{request_id}/decision-replies` | `AnswerStateDecision`（body `command_id`、`resolution`=`ACCEPT`\|`DECLINE`、`answer`、`expected_revision`） | 200；一句话续答绑定原请求与**用户看到答案时的版本**，`expected_revision` 不符 → 409 `DECISION_STALE`；决定本身不写业务事实，清掉 `decision_required` 后由 applications 继续 |
| `GET /conversation-state-requests/{request_id}/undo-plan` | — | 撤回事前预检（只读）：逐条 `withdrawable`、`reason_code`、`reason`、`impact` 与 `plan_digest`；不写任何业务事实 |
| `POST /conversation-state-requests/{request_id}/withdrawals` | `WithdrawStateMaintenance`（body `command_id` 必须**等于**请求行 `undo_command_id`，可选 `plan_digest` + `confirmed_change_ids`） | 200；整组全部可撤回时可省略方案直接执行；有不可撤回项且未附方案 → 409 `UNDO_SCOPE_REQUIRED`（**一项都不补偿**）；附方案但事实已变 → 409 `UNDO_PLAN_STALE`；`UNDOING` 重入按持久 `undo_scope` 继续剩余补偿 |
| `GET /conversation-state-requests?session_id=`、`GET /conversation-state-requests/{request_id}` | — | 读投影，含逐条变更与 `undo_command_id`；`decision_required` 携带 `blocked_changes`（null = 整组等待） |

**确认时点的适用基线（迁移 `0064`）。** 解释结算时把每条变更的适用版本与实际目标身份冻结进 `conversation_state_changes.baseline_ref`：状态类变更记 `state_revision`，按标题可解析的对象记 `target_task_id`/`target_goal_id`/`blocker_id`/`knowledge_id`（含知识版本），确认时点解析不到的记 `resolved:false`。应用与补偿分别重查适用性：版本或身份对不上就保留当前事实并报类型化冲突（`STATE_VERSION_CONFLICT` / `TARGET_IDENTITY_CONFLICT` / `TARGET_VERSION_CONFLICT`），不用「读最新 revision」消除冲突，也不只比较字段值——同值的后续修订同样按版本识别。

**整组撤回事前核对。** 撤回先只读预检（`undo-plan`）：`UNDO_ENTRY_MISSING`、任务离开 `INBOX`、本组生效后的后续修改等逐条判定并给出影响；有任一不可撤回项时不执行任何补偿，交回用户决定具体范围，确认时回传 `plan_digest` 与 `confirmed_change_ids`（范围只能是预检通过的条目），服务端在同一次 CAS 抢占里持久 `undo_scope`（迁移 `0064`），输方不执行计划。

**待决定门。** `decision_required.blocked_changes` 为序号数组时只有这些变更等待决定，独立且明确的修改照常生效；缺省（null）整组等待，applications 409。`MAINTAIN` 是唯一会写业务的 decision；`DISCUSS`/`CLARIFY` 不产生任何业务事实。撤回不回滚快照、不恢复旧批准或验证语义；补偿失败逐条带原类型化错误。

**既有对象调整。** `SET_TASK_PLANNING` 沿原 Owner `SetTaskPlanningMetadata` 调整已有任务的优先级/截止日期（迁移 `0066` 放宽 `change_kind` 白名单），只改模型真正给出的字段；截止日期必须带时区，时区由客户端随解释请求提交并冻结进载荷。模型明确失败时请求结算为 `candidate_status=INVALID`、`status=FAILED`（可读、不永久 `INTERPRETING`），同一 `command_id` 只回读，新 `command_id` 沿原请求行恢复。

**解释上下文。** 解释输入可包含同一会话中当前指令之前的消息与既有维护回执（`【会话上下文】…【当前指令】`），用于纠正与续答对上原对象；上下文只供理解，授权仍只来自当前指令，系统提示词已明确两者边界。没有上下文时不加任何前后缀。

Breaking Change：**Yes（限 `daily-view-confirmations`，见 §10.62）；本节为新增端点与新增可选字段**，迁移 `0062`＋追加迁移 `0064`/`0066`（新增列与放宽 `change_kind` CHECK），既有 State 命令的可用动作集合新增 `ADD_BLOCKER`，原合法请求保持兼容；客户端与契约测试的动作枚举须同步。`relay_app` 对两张新表只有 SELECT/INSERT/UPDATE。真实 PG 集成覆盖见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)；规格见[测试计划 §24](../testing/verification-plan.md#24-自然语言状态维护与自动接续验收规格)。

### 10.62 返回项目的日常查看基线与接续卡（2026-10-09 源码实现，2026-10-10 整改）

迁移 `0063` 单表 `project_daily_view_baselines`：每项目一行「上次实际查看确认」，保存展示时的 `viewed_state_revision`、必要版本引用（`viewed_fact_refs`）与该次展示的服务端序号 `viewed_presentation_seq`（追加迁移 `0065`），`unique(workspace_id, project_id)` + `unique(workspace_id, presentation_id)`。确认针对**这份已展示结果**；确认载荷的 `viewed_fact_refs` 由客户端回显本次展示的 current，服务端不与当前库状态核对（它是「看到了什么」的事实）。

**可信读取顺序（迁移 `0065`）。** `GET /daily-continuation` 每次读取签发一个按项目递增的展示序号 `presentation.presentation_seq`（新表 `project_daily_view_presentation_counters`，同表记录已签发上限），投影新增 `presentation`。推进条件是**两个维度同时成立**：展示序号严格大于基线，且 `viewed_state_revision` 不倒退——所以 State 不变而任务集合变化时也能推进基线（已查看的变化不再反复报新增），同 State revision 的迟到旧确认（序号更小）不会覆盖新查看结果；顺序由服务端签发，不用客户端时钟，超出已签发上限的序号 422。同一 `presentation_id` 重复确认仍由唯一约束回放。

| 端点 | 命令类型 | 说明 |
|---|---|---|
| `POST /projects/{project_id}/daily-view-confirmations` | `ConfirmProjectDailyView` | body 必须带 `presentation_seq`；幂等：同 `presentation_id` 回放；`viewed_fact_refs` 形状非法（缺 phase_key / open_task_ids 超 200 / 负计数）422；未签发的序号 422 |
| `GET /projects/{project_id}/daily-continuation` | — | 当前事实（State/未终结任务/未决 blocker 计数）+ 本次展示身份 `presentation` + 基线 + `delta`；无基线 `baseline`/`delta` 为 null，不凭时间猜测变化 |

**任务集合的捕获上限。** `current.open_task_ids` 超过 200 条时截断并置 `current.open_task_ids_truncated=true`；delta 侧只要当前或基线任一侧不完整，就置 `delta.open_tasks_unknown=true` 并把新增/关闭留空——不把「没比出来」显示成「没有变化」，`viewed_fact_refs` 也接受并回显该截断标记。

命名接续点（N01）行为不变：日常查看不重设、不消费命名点。Breaking Change：**Yes**——确认端点新增必填 `presentation_seq`，投影新增 `presentation`、`current.open_task_ids_truncated`、`delta.open_tasks_unknown`、`baseline.viewed_presentation_seq`；仅使用本项目客户端的调用方需同步，其余为新增字段。追加迁移 `0065`（新表 + 基线加列）。真实 PG 集成与组件覆盖见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

### 10.63 独立复验整改：拒绝终态、解释基线前置、撤回链与展示签发绑定（2026-10-10 源码实现）

依据整改任务书 `prompts/remediation/natural-language-state-maintenance-acceptance-20261010.md` R1–R6（追加迁移 `0067`，见[物理设计 §68](../database/physical-design-postgresql.md#68-0067-复验整改declined-终态解释基线前置与展示签发记录2026-10-10-源码实现)）：

- **R1 拒绝语义**：`decision-replies` 的 `DECLINE` 把受该决定约束的变更结算为新终态 `DECLINED`（请求级同名），只在写事务 CAS 内核对 `expected_revision`（事务前读取比较不足时 409 `DECISION_STALE`）；独立且已生效的修改保留，自动应用/重复 applications/刷新/重启都不再执行被拒变更。请求与变更状态白名单各新增 `DECLINED`。
- **R5 回执先行**：`decision-replies` 在任何可变状态前置之前先核对原命令回执——同命令同载荷重放 200（响应丢失恢复），换 `answer`/`resolution` → 409 `COMMAND_ID_REUSED`；并发同命令由「CAS 输方回读胜者回执」收敛，决定与审计恰一次。
- **R2/R4 版本链**：`SET_TASK_PLANNING` 的 `baseline_ref` 冻结确认时点任务版本，应用按「本组链 > 冻结版本」CAS，`after_ref.task_revision` 记 Owner 提交返回的新版本；补偿同样沿链 CAS（预检到提交之间的人工修改被挡住），同任务多条变更按逆序链撤回，确认范围必须包含同任务更晚的已生效条目。
- **R3 解释基线前置**：claim 事务内、调用模型之前把 Project State 版本冻结进 `conversation_state_requests.interpretation_baseline`，结算与恢复沿同一基准；缺可信基线 → `STATE_BASELINE_MISSING` 保守冲突。
- **R6 展示签发绑定**：`daily-view-confirmations` 改为逐项核对 `project_daily_view_presentations` 签发记录（身份、序号、当次 State 版本、已展示事实），未签发身份/序号嫁接/伪造版本/事实篡改/跨项目复用一律 422 且不写基线；污染旧基线由 `PROJECT_DAILY_VIEW_BASELINE_REPAIRED` 审计恢复。

### 10.64 外部成果核对、完成指令、自然语言撤回与返回轻量核对（2026-10-10 源码实现）

任务书第五节（Slice B/C 与纠正撤回续答）落地，追加迁移 `0068`/`0069`/`0070`：

| 端点 / 变更 | 命令类型 | 说明 |
|---|---|---|
| 解释候选 `SYNC_EXTERNAL_RESULT {task_title}` | 随 `InterpretStateMaintenance` | 202/200 语义不变；应用时只读核对（验收版本、标准、Artifact 版本、验证会话适用性），结果分类写 `after_ref.check_result` 与 `CONVERSATION_EXTERNAL_CHECKED` 审计，不完成、不接受、不改业务状态；同命令重放按原核对结果回读 |
| 解释候选 `COMPLETE_TASK {task_title}` | 随 `InterpretStateMaintenance` | 应用沿原完成 Owner `CompleteHumanTask` 提交：`baseline_ref` 冻结任务版本与验收版本（漂移 → `TARGET_VERSION_CONFLICT`/`ACCEPTANCE_STALE`），接受声明绑定原用户消息原文，产物绑定确切版本写入不可变完成凭据；规则不满足即类型化失败，已满足 → `SKIPPED/ALREADY_COMPLETED` |
| 解释候选 `UNDO_STATE_CHANGE` | 随 `InterpretStateMaintenance` | 不携带 ID；结算冻结同会话唯一已生效调整，应用复用 `withdrawals` 同一用例（含 `UNDO_SCOPE_REQUIRED` 范围决定）；0 条/多条 → `UNDO_TARGET_NOT_FOUND`/`UNDO_TARGET_AMBIGUOUS` |
| `POST /projects/{project_id}/return-reviews` | `ReviewProjectReturn`（body `command_id`） | 200；返回轻量核对：权限先行（失权 404 零写入）→ 差异与完成证据适用性 → 按事实指纹复用 `project_return_reviews` 行（`reused=true`），事实变化得新指纹重核；同步只读，不伪造 Run、不启动进程、不自动修复 |

`daily-view-confirmations`/读投影字段不变；三个新 `change_kind` 与 `return-reviews` 为**新增**（Breaking Change：**No**——既有调用方不受影响，`change_kind` 词表开放扩展的解析端需同步）。真实 PG 与组件覆盖见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)；规格见[测试计划 §24](../testing/verification-plan.md#24-自然语言状态维护与自动接续验收规格)。

### 10.65 内置工作方法与聊天命令解析（2026-10-11 源码实现）

Skill 专题 §9 与 ADR-019 的首批后端切片，追加迁移 `0071`：

| 端点 / 变更 | 命令类型 | 说明 |
|---|---|---|
| `GET /chat-commands` | 只读查询（无 `command_id`、无回执） | 200；返回菜单登记项：三条内置方法（`review`/`diagnose`/`docs`）在前，五条系统命令（`clear`/`new`/`model`/`undo`/`compact`）在后；英文固定名与中文别名共用同一条目 |
| `POST /chat-commands/resolve`（body `{text}`） | 只读查询（无 `command_id`、无回执） | 200；返回 `kind` ∈ `NOT_COMMAND`/`MENU`/`METHOD`/`SYSTEM`/`UNKNOWN_COMMAND`/`INVALID_ARGUMENT`。方法返回冻结身份与本次 `action`/`scope`；普通文本附 `detected_method`（含 `discussion`）；未知命令与非法参数只给类型化说明。**不写存储、不调模型、不执行动作**——因此「菜单选中未发送」零副作用 |
| `POST /assist-sessions/{session_id}/chat-commands`（body `{command_id,text}`，2026-10-13） | `/clear`、`/new`：`ExecuteChatCommand`；`/undo`：`WithdrawStateMaintenance` | 200 命令信封。新会话结果 `kind=NEW_SESSION`，含原/新会话、项目/任务、冻结身份/人设版本；原会话与历史保留，不复制消息、不改变原执行权。撤回结果 `kind=STATE_WITHDRAWAL`，含会话、原请求、状态、revision、原 `undo_command_id`。菜单/方法命令不在此入口执行，`/model`/`/compact` 409 `CHAT_COMMAND_UNAVAILABLE` |
| `POST /assist-sessions/{id}/messages` 新增可选 `method_ref {id, version, action?}` | `RequestAssistMessage` | 显式选择内置方法；不传时由正文的 `/命令` 或自然语言识别决定。消息正文为系统命令、未知命令或非法参数时按 400 `VALIDATION_FAILED` 拒绝且不落库；只读 `ASSISTANT` 会话请求 `MODIFY` 方法按 409 `INVALID_TRANSITION` 拒绝 |
| `assist_messages` 新增 `method_snapshot`/`method_action`/`method_argument` | — | 方法身份在**发起那一刻**冻结（定义 + `sha256`）；消息读投影新增 `method`（含 `definition_availability`）与 `method_argument`。方法定义被替换后只显示 `HISTORICAL_ONLY`，不按当前注册表补造 |
| 方法命令行动与普通执行接续（2026-10-13） | `RequestAssistMessage` / 原执行解释与 Delegate | `/diagnose 修好…`、`/docs 更新文档…` 的参数可得到 `MODIFY`；谈方法仍为 `INSPECT`。执行候选由应用绑定 `execution_method`，随 Run 冻结，含原方法快照/行动/参数/会话及用户消息身份，不接受模型自造方法身份；只读方法的写候选退回澄清。只有 `AGENT` 会话能创建执行请求，`ASSISTANT`/`LEARNING` 返回 409 `INVALID_TRANSITION`，须沿既有转执行入口 |
| **身份优先级（2026-10-12 整改 R1）**：显式 `skill_ref` 决定这条消息的处理入口 | `RequestAssistMessage` | 正文整体是 Skill 输入，**不再**进入自然语言方法识别，也不接受正文里的 `/方法` 命令；因此同一条消息不会同时写出 `skill_snapshot` 与 `method_snapshot`（那会撞 `0071` 的 `ck_assist_message_method_exclusive` 并整单 500 回滚）。同时传 `skill_ref` 与 `method_ref` 的 422 拒绝、未知命令/非法参数/菜单前缀/系统命令的 422 拒绝都保留；**没有**显式 Skill 时自然语言方法与 `/命令` 解析逐字不变。身份进入原命令幂等摘要与冻结快照：同命令重放返回原结果，异载荷 409 `COMMAND_ID_REUSED` |

Breaking Change：**No**——追加基础入口与可选元数据；原普通 Agent 的请求体及既有合法调用保持兼容，没有方法的旧 Run 契约不新增字段。方法的 Assist 回答仍不是修改结果，实际修改沿原执行链。`SKILL.md` 个人/项目定制、会话级模型选择、压缩、消息文件恢复及前端命令菜单仍未实现；未运行出口见[测试计划 §26](../testing/verification-plan.md#26-内置-skill命令压缩与消息文件恢复验收规格)。

基础控制范围：`/clear` 与 `/new` 在原会话有在途消息时拒绝，需先沿既有停止入口安全结束；保留同项目/任务及 AGENT/ASSISTANT/LEARNING 身份，人设助手继续使用原冻结配置，不因新会话升权。`/undo` 的 `command_id` 必须来自该会话具体状态调整投影的 `undo_command_id`，按原身份精确定位并复用整组补偿用例；未选目标返回 409 `UNDO_TARGET_NOT_FOUND`，不猜最新一条，不做文件恢复。其原成功回执持久化，可从 `GET /commands/{command_id}` 重读；撤回与回执间中断按相同原目标重入，不重新选择目标。两类回执资源链接分别指向新会话/原调整请求。这里只实现后端端点，前端输入命令接线仍后置。

### 10.66 学习模式的会话身份与个人学习记录（2026-10-11 源码实现）

依据 ADR-020、领域模型 §13.4、工作台 §26 与提示词工作包 A。学习身份是**建会话时冻结的第三种受限身份**：对项目只读，只多一项经专门入口写个人学习记录的能力。

| 端点 | 命令/语义 | 结果与错误 |
|---|---|---|
| `POST /assist-sessions` 的 `conversation_mode` 增加 `LEARNING` | `CreateAssistSession` | 与人设四列必须同时缺席（`LEARNING` 不由配置文本获得能力）；不传仍为 `AGENT`。同一 `command_id` 换模式重放按异载荷拒绝 |
| `POST /assist-sessions/{id}/messages` 新增可选 `record_learning`（默认 `true`） | `RequestAssistMessage` | 只在学习会话上有意义；随命令体持久到 `assist_messages.learning_record_disabled`，因而进入幂等摘要。学习会话请求 Skill、`MODIFY` 方法或提案意图按 409 `INVALID_TRANSITION` 拒绝 |
| `GET /learning-records` | 只读查询（无 `command_id`、无回执） | 200；返回 `epoch`、`cleared_at` 与按主题归组的知识点/证据投影（含 `kind`/`scenario`/`detail`/`disposition`/`source_kind`/`observed_at`）。**读状态不调用模型** |
| `GET /learning-sessions/{id}/state` | 只读查询（2026-10-13 基础入口） | 200；返回 `session_id`、会话级 `records_enabled`、`revision` 和最近 200 个轮次（`message_id/status/rejection_reason/record_enabled`）。缺控制行等价开启、revision 0；不返回模型候选、冻结基线或已删评估正文。非学习身份 409，跨 Workspace 404 |
| `GET /learning-sessions/{id}/continuation` | 只读查询 | 200；返回上次目标（会话标题）、最后依据时间、主题归组与待处理项（`PENDING_REVIEW` 或 `GAP`）。仅因时间过去**不**降级，不启动后台复习。非学习会话 409 `LEARNING_SESSION_REQUIRED` |
| `POST /learning-records/corrections` | `CorrectLearningRecord` | 200；明确 UI 纠正可省略 `source_message_id`；给出时必须是该学习会话中一条**已完成的用户消息**。必填 `session_id/concept_id/scenario/detail` 与命令身份。写入 `USER_CONTROL` 自述证据（不伪造聊天引用），递增概念代次；旧轮次不得覆盖新纠正。模型增量不走本命令 |
| `POST /learning-records/deletions` | `DeleteLearningEvidence` | 200；单项删除并递增概念代次；`expected_generation` 落后按 409 `REVISION_CONFLICT` |
| `POST /learning-records/clearances` | `ClearLearningRecords` | 200；清掉本 workspace 的评估内容、失活在途轮次并递增 `epoch`。清除范围是**学习记录**，不声称删除原聊天、Provider 历史或项目事实 |
| `POST /learning-sessions/{id}/record-control` | `SetLearningRecordControl` | 200；会话级「后续不记录」，`records_enabled` + 可选 `expected_revision`（CAS，落后 409）。首次操作以缺行版本 0 原子插入为 revision 1；已有版本不被旧 0 覆盖。非学习会话 409 `LEARNING_SESSION_REQUIRED`；跨 Workspace 404 零写入 |

类型化错误：`LEARNING_SESSION_REQUIRED`（非学习身份）、`LEARNING_RECORD_DISABLED`（本轮或会话已关闭记录）、`LEARNING_ROUND_UNAVAILABLE`（轮次不存在、已结算，或领取身份已失效/取消先提交）、`LEARNING_ROUND_STALE`（冻结代次已变化，含明确哪些增量未应用）、`LEARNING_INCREMENT_REJECTED`（候选形状/字段不合法）、`LEARNING_EVIDENCE_REF_INVALID`（依据缺失/不存在/不属于本轮/性质不符）、`LEARNING_CONCEPT_AMBIGUOUS`（无法可靠确定同一概念）。既有 `COMMAND_ID_REUSED`、`REVISION_CONFLICT` 与维护门语义不变。

**结算不在这里**：教学轮次的有限增量由应用在模型返回后经 `SettleLearningRound` 结算（工作包 B），它不是 HTTP 命令——客户端不能直接提交学习增量，这保证「模型不能伪造用户答题、自述或确认」。

**依据绑定（2026-10-12 整改 R8）**：模型不挑选依据，只提出候选；`source_message_id` 由**应用**按候选性质绑定（`EXPOSE` → 本轮助手消息；`SELF_REPORT`/`OBSERVE`/`GAP`/`CORRECT`/`RESOLVE_REVIEW` → 本轮用户消息），再在结算的同一短事务里逐条校验：引用存在、属于本轮、性质匹配，且本轮确实有可依据的真实用户输入。缺引用、引用不存在的消息、跨轮/跨会话、用助手消息冒充用户发言一律 422 `LEARNING_EVIDENCE_REF_INVALID` 且零新增；用户输入只有「跳过」或仅为自述理解（固定短语表，规范化后精确匹配）时不产生 `OBSERVED`/`GAP`，也不升级或降级，但合法的 `SELF_REPORT` 照常保存。这是**应用侧**校验，不靠提示词里的一句「不要编造」，也不新增常规评估调用。

**领取身份与取消（2026-10-12 整改 R2/R3）**：`SettleLearningRound` 在**同一事务**内核对轮次对应的消息仍归本 Worker（`RUNNING` + `worker_id` 匹配）且 `cancel_requested` 未持久化；失权（租约过期）或取消先提交时零新增，轮次分别收敛为 `REJECTED/LEASE_LOST` 与 `CANCELLED/LEARNING_ROUND_CANCELLED`，不长期留 `PENDING`。增量先合法提交、取消后到：先前提交的证据保持不倒删，消息按 `CANCELLED` 收口。

**基线冻结范围（2026-10-12 整改 R4）**：轮次依据在调用模型前冻结该 workspace **全部**既有知识点（`concept_id → generation` 加保留键 `$identities` 的 `slug → generation`），不是「证据最近 20 条涉及的知识点」。结算对不在基线内、但身份在轮次开始时已存在的知识点保守拒绝（`LEARNING_ROUND_STALE`），挡住「删除后以同名重建再复活」；本轮合法新建的知识点照常写入。

**清除边界（2026-10-12 整改 R6）**：全清与结算取同一把 workspace 级 epoch 事务锁（`pg_advisory_xact_lock`），保证只有「全清先提交 → 旧轮次 `LEARNING_ROUND_STALE`」或「结算先提交 → 全清随后清掉新证据」两种结果；清除回执重放不重复推进 `epoch`，新 `epoch` 下用户重新开始的合法教学照常保存。

**纠正/删除与写入的临界区（2026-10-12 整改 R7）**：证据写入在 `learning_concepts` 行 `for update` 锁内重新读取代次并与冻结值比对；校验通过之后发生的人工纠正/删除提交会让旧轮次类型化失败（`LEARNING_ROUND_STALE`），不产生部分写入。

**已解除缺口（2026-10-12 整改 R5）**：`GET /learning-sessions/{id}/continuation` 与教学 Context 的 `open_items` 一律以**当前处置状态**为准——只有 `PENDING_REVIEW` 才算未决，`SUPERSEDED`/`WITHDRAWN` 保留为可追溯历史但不进入未决项。

Breaking Change：**No**——新增枚举取值、可选请求字段与追加端点；2026-10-13 增加只读状态投影，UI 纠正允许省略原消息引用，既有带引用请求保持校验；没有新 migration。学习入口、记录控制及明确转执行的基础 UI 已接入，当前转执行使用按钮新建普通会话，不自动转发学习对话中的执行语句。教学轮次（工作包 B）走 `runLearningRounds`（结构化信封 + 逐次 `recordModelInvocation`）。真实 Provider/Windows/成本与学习效果出口未验；实际结果见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

### 10.67 Task 验收材料参考关系（2026-10-14，基础协议）

Breaking Change：**No**。追加 migration `0074_task_acceptance_materials.sql` 与三个端点。材料正文仍由 Knowledge Owner 保存，参考关系由 `application/task-acceptance-materials.ts` 唯一写入；导入/关联不创建 CheckResult、PASS、Review 或 CompletionRecord，不改变 Task/Run 状态。

| 端点 | 基础行为 |
|---|---|
| POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/acceptance-materials | 200 命令回执。传 `command_id`、`expected_acceptance_revision`、`knowledge_id`、`knowledge_version`；可选 `criterion_id`、`tested_artifact_version_id`、`source_label`、`note`。沿既有 Knowledge 导入文本后引用确切版本；同项目、当前验收修订、条件存在、被测产物属于该 Task 才允许关联。不完整关联可保存，查询标明缺项。 |
| GET /api/v1/workspaces/{workspace_id}/tasks/{task_id}/acceptance-materials | 同一 Task 的材料投影：原验收修订、条件、确切资料版本/SHA、被测版本、参考关系状态、材料可读性、当前验收/产物是否匹配与缺项。证据性质恒为 UNVERIFIED_REFERENCE；读取不调用模型。 |
| POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/acceptance-materials/{material_id}/withdrawals | 200。传 `command_id`、`expected_revision`；只撤销参考关系，保留历史和材料正文，不撤回正式验证或业务完成。 |

正文导入复用 `POST /knowledge`，纯文本/Markdown 按原 256 KiB 与正文读取协议；导入与关联为两个独立命令，关联失败不删除已收录正文，按原命令回执核对后可继续关联，不声称两步原子。来源标签是用户声明，不证明日志由 Relay 执行。Knowledge 新版不替换旧引用，验收新版或被测产物更新后旧关系保留并显示不匹配。所有写入沿 NORMAL 维护准入、命令幂等与 Workspace/Project 守卫；跨作用域 404、版本冲突 409、无效条件或格式 422。基础功能不包含 UI 重构、计时/收益评价或自动正式验收。

### 10.68 Task 验收试用计时与人工补录（2026-10-14 基础协议）

Breaking Change：No。Workspace 下新增 `POST/GET /tasks/{task_id}/acceptance-trials`、`POST /tasks/{task_id}/acceptance-trials/{trial_id}/transitions` 与 `/observations`。所有写入复用 NORMAL 维护准入、命令回执和 revision；不改变 Task/Run/权限或正式验收结果。Task 验收试用应用入口独占计时及补录，使用数据库时间，短事务保存记录与审计。

开始请求：`command_id`、`expected_acceptance_revision`、`mode: ORIGINAL|EVIDENCE_VIEW`、`sample_label`，可选 `material_ids`（最多 64 个确切关联 ID，同 Task、ACTIVE、当前验收修订）。ORIGINAL 无需导入材料且不带材料 ID；EVIDENCE_VIEW 可先空选，保存用户选定范围而不自动补选。开始冻结验收修订和材料 ID，状态 RUNNING、revision 1。

转换请求：`command_id`、`expected_revision`、`action: PAUSE|RESUME|FINISH`。RUNNING 可暂停或结束，PAUSED 可继续或结束，FINISHED 不再转换。暂停/结束累积找证据有效毫秒，暂停不计有效时间；继续重新开始有效段。读回返回有效、暂停及总经过毫秒，运行中的数值按服务器时间计算，结束后固定；页面关闭不自动暂停，重启读取持久状态。旧 revision 返回 409，原命令重放返回原结果。

补录请求：`command_id`、`expected_revision`、`preparation_ms: 整数|null`、`total_acceptance_ms: 整数|null`、`source_note`（用户说明，1–4000 字）。这两项都由人工明确声明；总验收耗时口径已经包括准备成本，响应 `total_includes_preparation: true`，不再相加。未填项保持 null，不用找证据计时推算总验收；已知总耗时不得小于已知准备耗时。每次补录追加观察并递增试用 revision，纠正通过新观察保留旧值和来源，读回全部历史及最新观察。暂不接自然语言意图、UI、对比阈值冻结或收益结论。

### 10.69 验收试用冻结基线与基础对比（2026-10-14 协议）

Breaking Change：No。新增 Workspace 下 `POST/GET /projects/{project_id}/acceptance-comparisons`。写入复用 NORMAL、命令回执和审计，比较应用入口独占不可变基线；不调用模型或改变 Task/Run/Verification。

冻结请求：`command_id`、`baseline_trial_id`、`expected_baseline_revision`、`target_reduction_percent`（用户明确选择 1–100 整数百分比）、`sample_scope`（1–4000 字，样本可比范围、规模及熟悉效应等说明）。基线须是本项目已结束的 ORIGINAL 试用，验收修订仍当前；冻结该试用 revision、当时最新人工观察 ID 和声明口径。200 返回 `comparison_id/project_id`，同命令重放复用；基线 revision 冲突 409，跨作用域 404，未结束或模式错误 409。记录不可改写，要改口径创建新基线。

原 `POST /tasks/{task_id}/acceptance-trials` 可选追加 `comparison_id`，只允许 EVIDENCE_VIEW 且同项目、冻结基线仍当前；绑定由开始命令持久，无既有试用事后补挂。允许一个基线下多次试用，读回全部试用（包括未完成、失败及未知），不挑有利样本。已有不带字段的计时命令体与回执身份保持兼容。

原人工补录可选追加 `correctness_outcome: UNKNOWN|NO_ISSUE_REPORTED|ISSUE_REPORTED`，默认 UNKNOWN。它是用户自述正确性，来源仍 USER_REPORTED，不是正式 PASS；来源说明随观察保留。基线人工记录更新后，旧基线不自动取新版，历史值仍读回并标 STALE。

查询返回冻结基线时长/观察/目标/说明、关联试用及原始指标：`finding_reduction_percent`、`total_reduction_percent`、`preparation_difference_ms`、`finding_target_met`、`overall_time_saved`。百分比仅在已结束且基线大于零时计算，显示两位小数；未知和零基线返回 null。人工总耗时已含准备，不重复加；准备差值可为负。`assessment` 是单样本数据状态：IN_PROGRESS、INSUFFICIENT_DATA、STALE、CORRECTNESS_ISSUE、TARGET_MET、TARGET_NOT_MET。只有完整人工口径、双方无问题自述、当前基线/验收/材料适用、找证据达到冻结目标且总耗时下降才为 TARGET_MET；不证明普遍收益或替用户作投入决定。材料/验收变化保留原数值并标 STALE，缺材料条件/被测版本为数据不足。
### 10.70 会话一句话补录验收耗时（2026-10-14 协议）

Breaking Change：No。复用既有 `assist-sessions/{id}/state-maintenance-requests`、`conversation-state-requests/{id}/applications` 及回执/澄清/决定入口，不新增 HTTP 端点。增加候选 `REPORT_ACCEPTANCE_TIME`：可空 `task_title/sample_label`，可选非负整数 `preparation_ms/total_acceptance_ms`，至少一项；模型不携带 ID。只接受明确登记指令，讨论仍 DISCUSS，数字、单位或总耗时口径不明先 CLARIFY。

解释前在原请求 JSON 基线冻结本项目试用的身份、revision、任务标题和样本标签；模型上下文只带标题/标签/状态，不赋予授权。候选按冻结列表精确匹配，未指定时仅允许唯一试用，0 条或多条均返回聚焦澄清，不按最近位置猜。用户原文的阿拉伯数字与毫秒/秒/分钟/小时按确定性换算核对，缺单位、重复口径或模型数字不一致不落补录；其他数字表达先询问明确数字与单位。当前基础语句支持“准备用了 3 分钟，整体验收用了 12 分钟”等形式。

应用使用冻结 Task/试用 revision，沿原 RecordTaskAcceptanceObservation Owner 写入，原命令重放不重复记录；未提到的耗时保持该试用原观察值，首次缺项仍 null。原消息为同项目 AGENT 的 USER 消息，来源消息 ID 保存在观察中并读回；只读 ASSISTANT/LEARNING 身份不获得写入权。不自动暂停计时、创建 Run、完成 Task 或自述正确性为通过。纠正走新明确补录，保留全部观察；没有删除/撤销观察入口，整组撤回如实返回不可撤回，不伪造删除。
### 10.71 项目基础假设记录与用户结论（2026-10-14 协议）

Breaking Change：No。新增 Workspace 下 `POST/GET /projects/{project_id}/hypotheses`、`GET /hypotheses/{id}`、`POST /hypotheses/{id}/versions`、`/observations`、`/suggestions`、`/confirmations`。假设应用入口独占假设定义、观察和结论，不写 Task/Run/CheckResult/Review/Decision。写入沿 NORMAL、项目归档守卫、revision、原命令回执及同事务审计。

创建请求须 `command_id`、`confirmed:true`、`title`（1–200 字）、`claim/method/criterion`（各 1–4000 字），可选 `source_knowledge_version_id`（本项目可读确切 KnowledgeVersion）。创建 revision/version 1；修改定义带 `expected_revision` 和三项定义，新建不可变版本、不覆盖历史。资料正文沿 Knowledge Owner，引用只保存 ID，不复制正文。

观察请求带 `command_id/expected_revision/summary`（1–4000 字），可选 `knowledge_version_id`。追加到当前定义版本，来源性质为用户自述或外部参考，材料不形成正式 PASS；观察和所有后续写入递增假设 revision。读回全部定义、观察与结论，缺来源不补造；新观察、定义变化或资料版本/可用性变化让旧结论不再适用于当前基准。

建议请求带 `command_id/expected_revision/outcome: SUPPORTED|NOT_SUPPORTED|INCONCLUSIVE/rationale/evidence_sufficient/method_reliable`。这是调用方提供的候选判断，不声明发生过模型调用；冻结当前定义版本及观察 ID 集合。无观察、证据不足、方法不可靠或资料不再适用时强制 INCONCLUSIVE、建议补充证据；可靠充分但 NOT_SUPPORTED 时建议 STOP_NEXT_STAGE，不自动停止任何任务/投入。建议保存不会设置当前用户结论。

确认请求带 `command_id/expected_revision/suggestion_id/confirmed:true`，只能确认仍适用的建议。保存独立 USER_CONFIRMED 结论和原建议引用，更新当前用户结论指针，旧判断保留。当前结论是用户确认的假设判断，不是功能 PASS、需求接受或 Task 完成。版本冲突/过期建议 409，跨作用域 404，不完整参数 422。

原会话状态维护追加 CREATE_HYPOTHESIS（title/claim/method/criterion），用户明确“把这个想法记成假设”才进入 MAINTAIN；建议/讨论不自动建档，缺主张、方法或标准先澄清。原应用入口调用创建 Owner，来源原用户消息保存在定义版本；ASSISTANT/LEARNING 仍只读。客户端提供查询、写入和会话建档方法，本片不做 UI 或自动模型分析；没有假设撤销 Owner 时如实报告不可撤回。
### 10.72 决定前提与基础复审候选（2026-10-14 协议）

Breaking Change：No。新增 Workspace 下 `POST/GET /decisions/{id}/premises`、`GET /projects/{project_id}/decision-reviews`、`POST /decision-reviews/{id}/resolutions`。前提/候选由 Decision Review 应用入口独占写入，Decision 正文、状态与替代关系仍归原 Information/Decision Owner。

登记请求：`command_id/expected_decision_revision/confirmed:true/statement`（1–4000 字），二选一 `knowledge_version_id` 或 `hypothesis_id+expected_hypothesis_revision`。首片仅本项目 ACTIVE Decision 与同项目资料/假设；Knowledge 需确切当前可读版本，Hypothesis 需匹配 revision。冻结决定 revision、前提说明和来源基线，200 返回 premise_id/decision_id/project_id/revision；不推测旧决定理由。

Relay 记录 Knowledge 新版本（含事务内组合入口）/归档，以及 Hypothesis 新定义/观察/用户确认时，在原短事务内对已登记相关前提准备候选。Knowledge 更新也核对通过该资料关联的 Hypothesis 前提；假设仅保存未确认建议不触发复审。候选冻结原决定 revision、前提 revision、before_ref/after_ref、来源命令与变化指纹，唯一键防重复。实际新增候选时，资料/假设相关回执追加字符串 `decision_review_count`，项目内另提供 `decision_review_candidates_ref`；原字段不变，重放回读原数量，不重新准备候选。

项目查询保留全部候选和处理历史，返回当前可行动 pending_count、来源变化、原前提说明/决定标题及需用户重新判断的问题。再次变化时旧候选 applicable=false，原值不替换。读取不写事实、不调用模型；未登记前提的决定不生成候选。

处理请求：`command_id/expected_revision/action: KEEP_DECISION|DISMISS/reason`（1–4000 字）。只处理仍适用的 PENDING 候选；KEEP_DECISION 保存用户理由并把该前提的来源基线更新到已核对 after_ref，DISMISS 只登记本次不处理。两者不更改 Decision 状态/正文或 Task/Run。候选或决定/来源/前提基线变化返回 409，跨作用域 404。需要替代决定仍调用原创建/替代 Decision 入口；替代后的旧候选不可行动。本片为前后端数据功能，无 UI、后台监控或自动模型分析。
### 10.74 基础下一段工作计划（2026-10-14 协议）

Breaking Change：No。Workspace 下新增 `POST/GET /tasks/{id}/time-estimates`、`POST/GET /projects/{project_id}/period-plans`、`GET /period-plans/{id}`、`POST /period-plans/{id}/items/{item_id}/resolutions`；写入沿原 command_id/事务回执，均返回 200，跨作用域不可见。PersonalPlanning 拥有估时历史、固定容量窗口、候选与逐项选择；Task 创建仍归原 Owner。

估时请求为 `command_id/confirmed:true/expected_task_revision/expected_estimate_revision/source_note` 与 `elapsed_ms/execution_ms/waiting_ms/review_ms/human_ms`，时长均为非负安全整数或 null，五个字段明确传入；初次估时 expected_estimate_revision 为 `0`。同项目 Task 当前验收修订被绑定，不改 Task revision、状态或验收；更新追加不可变估时版本。GET 返回 current（含 applicable）及全部历史；验收变化后原估时不再用于容量。elapsed 是用户声明的执行、等待与审阅整段时间，允许分项重叠，不能把分项或人工投入重复相加；分项已知也不能推算未知 elapsed。

计划请求为 `command_id/title/available_ms/diagnostic_ms/task_ids/mainline_task_ids/goal_ids`。标题 1–200 字，容量 1–604800000 毫秒，诊断预算为正且不超过容量；task_ids 为 1–64 项不同的当前项目任务，主线 ID 是所选任务子集，目标需是项目已关联活动 Goal。自动读取同项目未完成 BLOCKS 必要前置，总范围不超过 64 项；跨项目前置返回 409，需人工另行安排；INFORMS 不占硬前置。DONE 不排新工作，非 INBOX/READY 项保留 TASK_NOT_IDLE 延后原因，不改在途契约。

数据库时间在生成时固定 started_at/ends_at，GET 只递减 remaining_ms，不重置窗口。冻结 Task/验收/估时修订、Goal 引用、优先级、截止日期、依赖与已登记阻塞；按所选目标/明确主线及必要前置优先，再按原优先级、截止日期安排独立项。缺优先级/截止日期保持 null。本片用保守串行 elapsed 容量，不推测跨任务并行收益。TASK 候选保存预算与单列人工估时；未知关键估时只生成有预算/阶段输出的 DIAGNOSTIC，下游不承诺完成；无估时独立项、容量不足、阻塞或未安排前置逐项 DEFERRED。资料与权限是否满足未由本片核验，返回 `permission_gaps:CHECK_AT_EXECUTION/execution_admission:NOT_GRANTED`，人工事项沿已登记 blockers 和原 Task 验收读取，不能冒充准入通过。

处理请求为 `command_id/expected_revision/action:ACCEPT|REJECT/reason`。每次仅一项，读回该项状态/理由/created_task_id，其他候选保留；必要前置先接受。接受既有 TASK 只保存计划选择；接受 DIAGNOSTIC 在同一短事务复用原 Task 创建入口，创建 ME/HUMAN/INBOX、独立诊断输出与验收，记录原任务引用和预算；原命令重放不重复创建。诊断预算用完仍交证据、排除项、未知与下一步候选，不宣布原修复完成或自动延长。DEFERRED 不可直接接受；依据变化、修订冲突或窗口结束返回 409，旧候选仍可读/拒绝，更新输入后重新发起。估时是建议：候选恰好排满固定容量时仍可在窗口内接受，读取 `time_warning:ESTIMATED_WORK_EXCEEDS_REMAINING_WINDOW|null` 提示审阅后剩余时间与尚未拒绝候选预算的缺口，不据此承诺完成时刻。读取 expired 不暂停 Run，接受不 Delegate 或批准工具动作。本片不新增 UI、日历、会话解释候选或自动重排后台。

### 10.73 基础工作段预期与产出复盘（2026-10-14 协议）

Breaking Change：No。新增 Workspace 下 `POST/GET /projects/{project_id}/work-segments`、`GET /work-segments/{id}`、`POST /work-segments/{id}/finishes`、`POST /work-segments/{id}/events`、`POST /work-segment-events/{id}/resolutions`，以及只读 `POST /projects/{project_id}/retrospectives`（无历史工作段时的临时回顾）。工作段入口拥有预期/时间/结束快照和用户事件记录，不创建 Task/Run、不应用计划或宣布完成。

开始带 `command_id/confirmed:true/title/expectation`（标题 1–200 字、确认预期 1–4000 字）及 `tasks`（1–64 项，task_id/expected_revision/expected_acceptance_revision）。仅同项目既有 Task，开始冻结任务身份/标题/状态、验收 objective/criteria/expected_outputs 和已有完成引用。原用户消息可以作为来源；会话 START_WORK_SEGMENT 沿原状态维护确认链，缺范围/预期先澄清，不按实际结果倒造预期。

结束带 `command_id/expected_revision`。数据库时间记录开始/结束与经过毫秒，结束保存不可变实际快照：只有本段中新提交、当前 DONE 且匹配冻结验收修订的 CompletionRecord 计入本段已验收产出；记录确切 completion_id/artifact_version_ids，其他情况保留未完成、基线变化、已有完成或缺依据标记，原因沿真实状态/阻塞/执行权，不推断原因。读回历史快照与后续事件纠正分别呈现，不把后续完成算成本段产出。需要核对文件正文可沿原完成证据入口。

模型用量只选已登记 Task 的 Run 步骤或明确 Task 绑定会话、调用开始时间在本段区间的既有 model_calls。返回原调用 ID/状态/用量及覆盖范围；缺项保持 null，已知用量与完整用量分开，无记录不宣称实际零用量。现有账本没有金额字段，monetary_cost 恒 null，不按当前价格补历史金额，不加入额外模型分析。

事件候选带 `command_id/expected_revision/kind: REWORK|HUMAN_INTERVENTION/description`，可选 task_id/source_run_id/duration_ms。记录为 CANDIDATE，不纳入确认统计；任务/Run 必须属于已选范围。用户处理带 `command_id/expected_revision/action: CONFIRM|WITHDRAW/reason`；原命令去重，状态/理由留历史，确认后计入，撤回后排除。多次 Run 不自动生成返工；耗时缺失未知，统计覆盖范围仅确认记录。结束后可补事件确认/撤回，结束事实快照保持不变。

临时回顾只读请求 task_ids（1–64 个既有同项目 Task），按任务当前验收周期读取最近登记的工作段基线并返回段身份/原预期；没有匹配的项为 UNKNOWN，混合为 PARTIAL，全部有记录为 RECORDED。各任务预期不合成过去总预期或时间，顶层 expectation/model_usage/work_time 保持 null，不创建或伪造历史工作段。客户端支持全部基础入口，本片不做 UI、固定周期报表、自动疑似事件提取或收益结论。

### 10.79 任务链受控修改与检查（2026-10-14 协议）

Breaking Change：No。沿 §10.77–10.78 原创建/查询/授权/控制端点扩展每项 execution，无新端点或 migration。工具循环可选原注册词表中的目录/文件读取、git_status/git_diff/git_log、apply_changeset/read_change_set/run_check；连接可选 FILE_QUERY/FILE_READ/GIT_READ/FILE_WRITE/CLI_RUN，须同项目 ACTIVE 且具备对应能力。工具名与能力仍由原词表核对，预算沿原 12 轮/48 次工具上限，资源配置/身份与资料基线不变。

可选 scope_grant 为 `{resource_id,allowed_actions,checks,expires_at?}`，资源须与循环一致，allowed_actions 是 APPLY_CHANGESET/CLI_RUN 的非空不同子集，每个动作必须对应本项允许工具。checks 复用原 Delegate 的最多 32 项 `{id,executable,args,executable_sha256,max_output_bytes?}`：id 唯一非空，入口摘要为实际程序 SHA-256，参数最多 64 个、输出上限最多 1 MiB。服务端沿原信任材料入口冻结程序、执行脚本与直接配置；创建仅保存规格，不创建 Run 或签发有效授权。run_check 必须有明确 CLI_RUN 范围和至少一项配置，只能用 check_id 点名，模型不能提交新程序或命令字符串。

明确授权后，原 Delegate 在创建本项 Run 的事务中沿原 RunScopeGrant Owner 签发本 Run 的范围授权。有效期取本项可选期限与本链授权期限的较早者，不跨 Run 终态；下一项仍独立创建自己的授权，链续期不延长既有 Run 授权。原 Gateway 取权限与授权交集，DENY 不被覆盖；没有范围授权的修改仍走原 ACTION_APPROVAL，等待期间不落盘。删除、撤销、检查材料变化及未决结果沿原控制/审批/恢复协议，不由链自动批准。

原方法来源允许 INSPECT 或明确 MODIFY。INSPECT 不能与 apply_changeset 并存，MODIFY 必须有本项修改工具；仍冻结原会话定义、行动、参数和用户消息，不由链改写方法意图。范围内普通修改必须携带实际读取基线；第一次检查正常失败可沿原工具循环读取、修正、再检查，失败不等于通过，检查结果仍来自实际子进程。下一项继续要求原人工验收与确切完成凭据。

原 ready/Delegate 准入再次核对已冻结检查材料；变化保留旧规格并阻止新准入，原 Delegate 与任务链共用检查冻结函数，有原 trust_basis 时只核对、不重新绑定新脚本。读取 execution_spec 增加 scope_grant 与服务端冻结 trust_basis；前端原客户端增加对应输入映射，不增加 UI。空规格及旧只读调用保持原行为。真实 Provider/Windows 使用、自定义方法、活动无缝续期、并发故障全矩阵与完整 N06 按后续范围接续。

### 10.78 任务链只读执行规格与来源（2026-10-14 协议）

本节记录先前只读切片；当前可选修改/检查范围见 §10.79，以下只读输入与来源协议继续有效。

Breaking Change：No。复用 §10.77 创建/读取/授权/控制端点，创建 tasks 每项可选 `execution`，未提供保持原 Markdown 空规格与旧命令摘要。`execution` 支持可选 context_sources、file_read_action、tool_loop_action、method_message_id；固定读取与循环互斥，不支持 write/CLI/scope_grant 或任意执行代码。

context_sources 为最多 10 个 `{kind:KNOWLEDGE|MEMORY|DECISION,root_id,version}`；确切版本须存在，资料根 ACTIVE 且属于当前 Workspace/Project 或同 Workspace 共享范围。保存原引用与根 revision/current_version 基线，不复制正文、不自动切到新版本；正文/产物来源可用性仍沿原 Context Builder/成果入口，不因引用存在宣称内容已核实。

file_read_action 复用 `{connection_id,resource_id,relative_target}`（1–1024 字受管根内路径），tool_loop_action 复用 `{resource_id,connections,allowed_tools,max_rounds,max_tool_calls}`。连接仅 FILE_QUERY/FILE_READ，工具仅 list_directory/find_paths/search_text/read_file 非空不同子集，循环 1–12 轮/1–48 次工具调用，沿原共享上限。受管资源/连接需同项目 ACTIVE、能力对应；冻结资源 identity_key/配置 revision/canonical_root 与连接 version/capability。resource_epoch 属于实际资源领取/隔离出口，不作为配置基线；正常原读取推进 epoch 不误使后项失效，原 Gateway 仍负责每次实际准入/占有。

method_message_id 指向同项目普通 AGENT 会话的已完成原 USER 消息，若会话绑定 Task 则须匹配本项；下一条已完成 ASSISTANT 必须已有可核对的冻结方法定义与 INSPECT 行动。保存原 RunMethodBinding 的定义/摘要、消息/会话和参数，不由方法名新建修改权限；MODIFY、助手/学习身份、缺定义或未完成消息拒绝，不编造消息来源。

创建只保存执行规格。原 ready/Delegate 准入时再次核对资料头版本/可用状态、资源配置/身份、连接版本/能力和原方法；变化保留旧规格并阻止新准入，需重新圈定。非空规格的规范 JSON 摘要随专用链绑定进入原 ready/Delegate 命令，原空规格无新增摘要。原 Delegate 冻结同一输入到 Run；实际工具、资料读取、缓存/来源、拒绝、等待批准、UNKNOWN 与恢复仍归原 Owner，链不跳过权限、不复制动作或自动批准。DENY 在准备前返回原 REJECTED 工具回执，没有已派 Operation/Invocation；此结果不能当成功读取或自动启动下一项。

GET 每项增加 execution_spec，显示确切来源、连接/资源和原方法定义/出处；前端原 createTaskChain 输入与读取客户端接续，不新增 UI。累计任务/调用预算、有效期、停止/重开和人工完成保持 §10.77。本只读切片不包含写入；后续 §10.79 已接受控修改/检查，自定义方法/来源编辑器、真实 Provider/Windows 或并发/故障全出口仍后置。

### 10.77 基础有限 Markdown 任务链（2026-10-14 协议）

Breaking Change：No。Workspace 下新增 `POST/GET /projects/{project_id}/task-chains`、`GET /task-chains/{id}`、`POST /task-chains/{id}/authorizations`、`POST /task-chains/{id}/controls`。创建 201，授权/控制 200 原命令信封；旧 ready/Delegate/resume 的公开请求不新增链参数，专用绑定仅由可信应用协调器提供，旧命令摘要无条件字段不变。

创建为 `command_id/title/confirmed:true/tasks`（1–16 项不同 task_id/expected_revision/expected_acceptance_revision）。仅同项目 INBOX/READY、HUMAN 所属既有 Markdown Task；未完成 BLOCKS 前置必须在队列更早项，已完成前置可在外部。冻结 Task/验收/依赖/目标/规则依据及顺序，创建 DRAFT 不 Delegate。空规格 tool_scope 为 INTERNAL_MARKDOWN_ARTIFACTS_ONLY；可选只读执行规格及 BOUNDED_READ_ONLY_FILES 见 §10.78，不接写入或任意 Shell。

授权为 `command_id/expected_revision/confirmed:true/max_tasks/max_model_calls/expires_at`，任务上限 1–16、调用上限 1–100，有效期为带明确时区的未来实际时刻、至多 24 小时。确认是本链的执行请求，计划接受不替代授权；每次上限按本链累计总额核验，重新确认不重置 task_reservations/calls_started。只有非 ACTIVE/PAUSING/REVOKED/COMPLETED 状态可确认，原执行失败/取消或用量未知不能自动换 Run 重试；任务/目标/规则基线变化需重新圈定，不静默更新原授权范围。

API 存活期间仅做短接续协调。原 ready/Delegate 逐项再查 Task、条件/规则、依赖、执行权和权限，原 Delegate 事务同时绑定原 Run/START 回执和任务预留；剩余项不创建 Run。下一项只在上一项原 Run COMPLETED、Task DONE 且当前 CompletionRecord.run_id/acceptance_revision 确切匹配后准入，模型回复、候选或仅 Run 结果不能完成链。人工验收/Review 保持原入口。item 的 RUNNING 只代表已绑定 Run，实际 CREATED/运行/待审/暂停/完成由 current_run_status/current_task_status 读回。

调用数在原 model_calls STARTED 事务内预留，本链所有已绑定 Run 的步骤调用累计；单 Run 原调用/token 预算仍成立。未发调用的事务失败回滚，已开始调用永不因重开或新授权扣回；STARTED、缺输入/输出用量均保留占用并禁止后续调用/Task 准入。实例 VERIFY 探针及用户独立会话不计为本链调用。model_usage 返回已登记数量、未知数量、已知 token 与完整总量（缺失 null），monetary_cost 恒 null；不把受控 Fake 用量或空账本当真实成本。

控制为 `command_id/expected_revision/action:PAUSE|REVOKE/reason`。关闭新准入后沿原持久控制请求当前 Run 安全暂停，PAUSING 与实际 PAUSED 分开；终态/已经暂停且已核对的原执行不重发控制，不作用于后来独立 Run。到期同样阻止准入并请求原 Run 暂停，未应用前不显示已停，完成事实保持；停止命令可走原维护排空控制白名单。原 API 重开把旧活动链转 WAITING_RESUME，用户明确确认后才接续；必要时沿原 resume 恢复同一 Run，保留原委托/调用/产物身份，未决结果与原执行槽仍由原 Owner 核验。

状态 DRAFT/ACTIVE/WAITING_RESUME/PAUSING/PAUSED/REVOKED/EXPIRED/BLOCKED/COMPLETED，GET 保存授权历史、原因、原控制 ID、当前每项/Run/完成引用与累计用量。ACTIVE 仅表示授权有效，完整执行仍可能等待人工；BLOCKED 不自动宣称所有业务任务失败。原命令重放返回原效果，控制请求或新授权不复活 REVOKED。前端只接五个方法及 §10.78 可选只读规格，无新 UI、会话任务链解释、文件写入/CLI 或实际收益验证；完整 N06/PV06/PV08 按剩余出口接续。

### 10.76 基础一次性继续项目提醒（2026-10-14 协议）

Breaking Change：No。Workspace 下新增 `POST/GET /projects/{project_id}/reminders`、`GET /project-reminders/{id}`、`POST /project-reminders/{id}/edits`、`POST /project-reminders/{id}/status-changes`、`GET /reminder-occurrences`（可选 project_id）、`GET /reminder-occurrences/{id}`、`POST /reminder-occurrences/{id}/resolutions` 与 `POST /project-reminders/notifications/claim`。创建返回 201，其余命令 200 原信封；通知领取为普通 200 投递数据，不是业务命令回执。

创建请求 `command_id/confirmed:true/title/due_at/timezone`，标题 1–200 字，due_at 为有 Z 或明确偏移量的 ISO 实际时刻（秒必填、毫秒最多三位），timezone 为有效时区名称。拒绝无时区钟点和不存在的日期；DST 重复钟点由显式偏移量区分，不猜。保存 UTC 实际时刻与原设置时区，GET/设备显示时区变化不写配置。可明确登记已过时刻，运行扫描将形成同一待处理，不自动补跑计划。

编辑请求 `command_id/expected_revision/confirmed:true/title/due_at/timezone/reason`；状态请求 `command_id/expected_revision/status:ENABLED|PAUSED|DISABLED/reason`。配置 revision 每次命令更新，history 追加完整设置、原命令和理由；schedule_generation 只在实际时刻变更时推进。暂停/禁用/继续、同一实际时刻的标题/时区编辑不重置已发生身份，编辑不自动启用被禁用配置。已形成事项保存原标题/实际时刻/设置时区/config_revision/generation，不因后续配置或通知设置消失。跨作用域不可见，旧 revision 返回 409。

API 生命周期扫描默认每秒一次，Schema 可用且原维护准入为 NORMAL 才写；停机停止计时并等待在途短扫描，不运行独立常驻服务。数据库时钟比较当前 ENABLED 配置，归档项目不产生新事项；UNIQUE(reminder_id,schedule_generation) 保证本次发生最多一次，扫描/重开不重新生成已发生代次。启动基准由数据库取得，启动前到期的有效提醒标 missed；到时只在同一短事务写事项和 SYSTEM 审计，无模型/Task/Run/计划创建。

事项为 PENDING/HANDLED/DISMISSED、独立 revision；处理请求 `command_id/expected_revision/action:HANDLE|DISMISS/reason`。处理只标该事项及来源理由/时间，原命令重放不重复，不改变配置或已创建计划。GET 读回当前项目归档/revision、can_plan、原 N04 plan_entry 和 execution_admission:NOT_GRANTED；读/通知点击不处理事项、创建计划或批准执行，用户需另行输入容量并主动发起原计划命令。

通知领取只取未处理且项目未归档事项，复用 attention_notification_receipts 的稳定 `project-reminder:{occurrence_id}`/change_key:`1`，DISPATCHED/DENIED/FAILED 结算继续调用原 `POST /attention/notifications/settle`，只传 item_key/change_key/status。通知失败/拒绝不撤销 PENDING；聚合投递时身份仍独立。前端只补原轮询的功能：必须介入事项优先，项目提醒领取/投递另走原宿主权限；旧通知点击先读取当前事项/项目再导航，不凭旧载荷做业务写入。没有新增设置/待处理页面、样式或布局；Windows 原生投递和完整 PV05/PV08 仍按各自出口验证，不用受控通知对象冒充实际窗口证据。

### 10.75 基础固定容量范围推演（2026-10-14 协议）

Breaking Change：No。Workspace 下新增 `POST/GET /period-plans/{id}/scope-simulations`、`GET /scope-simulations/{id}`、`POST /scope-simulations/{id}/selections`；写入均返回 200 原命令信封。PersonalPlanning 拥有推演记录；计划和诊断创建继续复用 §10.74 原 Owner/逐项应用。前端只接四个功能客户端，不做 UI。

用户主动创建：`command_id/expected_revision/keep_task_ids/defer_task_ids/unreliable_task_ids`。来源为未应用、未过期且依据有效的既有本段计划。保留项/推迟项各 1–64 个不同 Task ID，不可靠项可空；均须来自原计划范围（含必要前置）。创建冻结同一原计划/Task/验收/估时/Goal 基线、可用容量、开始/结束时刻和具体估时来源；不提供增加时间或资源参数。原命令重放返回原推演。

三种 options 为 ALL/SHRINK/DEFER。ALL 保留完整范围，即使超容量也展示总估时和容量缺口；SHRINK 仅保留用户选定任务并补足已登记 BLOCKS 前置，报告 retained_prerequisite_ids 与 SCOPE_EXCLUDED；DEFER 移出指定任务及受影响下游，报告 DEFERRED_BY_USER/DEFERRED_WITH_DEPENDENT。每项展示原任务/依赖、候选或延后原因、预算、未知和人工估时；consequences 保留主线是否被移出、直接受影响下游与 OUT_OF_THIS_SCOPE/NEXT_WINDOW_UNSCHEDULED，不为推迟项编造下一段日期。本片缩小的是任务集，不改任务内验收范围。

源估时是 USER_DECLARED_UNVERIFIED；用户显式标不可靠时保存 USER_MARKED_UNRELIABLE，并在该推演中按未知处理，原估时历史不被改写。requested_elapsed_ms/requested_human_ms 任一分项缺失则为 null，容量缺口无法计算则 null；planned_ms 仅计当前可排 TASK/DIAGNOSTIC 预算，不能当原范围全部完成时间。feasibility 为 NO_WORK_SELECTED/UNKNOWN/EXCEEDS_CAPACITY/HAS_BLOCKERS/FITS_ESTIMATE，FITS_ESTIMATE 仅按已登记用户估时比较，不证明实际完成。completion_date 恒 null；material_gaps/permission_gaps 为 CHECK_AT_EXECUTION，已登记阻塞沿冻结基线读取，不冒充资料/权限已满足。序列预算仍为保守串行，不推断跨任务并行收益。

选择请求 `command_id/expected_revision/option:ALL|SHRINK|DEFER/confirmed:true/reason`（1–4000 字）。原计划、估时、任务/目标依据或窗口变化返回 409；原比较保留，GET 提供 stale_reasons。选择在同一短事务经原计划 Owner 创建新候选，保存原窗口/容量/选项来源和每项身份，再提交选择、审计及回执；不应用任何 Task/Run，不更新原计划。原选择重放返回同一 selected_plan_id，已选推演不可另选。用户随后调用原计划逐项接受/拒绝，GET 推演 selected_plan 读回当前 revision/items/实际诊断 Task ID，部分应用不被整体“选择成功”掩盖。旧候选与原任务保留，不以计划选择改变活动执行或验收条件。本片无会话解释、模型自动建议或收益验证。

### 10.80 普通 Agent 会话工作目录绑定（2026-10-15 源码实现）

总纲 §0.5.1 / ADR-022 / [运行架构 §2.7.1](../architecture/runtime-context.md#271-主流程的最小持久协议2026-10-15-实施前核对结果) 的持久协议落点。此前「这条会话绑定哪个工作目录」只存在于浏览器组件状态，服务端因此没有任何可信来源可读（只能按项目取第一个受管资源）；迁移 `0087` 给 `assist_sessions` **只增一列** `working_resource_id`（可空、外键 `managed_resources`），不回填历史行——升级前建的会话为 `NULL`，按「未绑定目录」处理，不会因为升级就获得新的读取能力。

| 端点 | 命令类型 | 说明 |
|---|---|---|
| `POST /assist-sessions/{session_id}/working-directory` | `BindAssistSessionDirectory`（body `command_id`、`resource_id`） | 200；回执 `{session_id, working_resource_id, revision}`，同 `command_id` 重放返回原回执。`resource_id` 必须是 uuid |
| `GET /assist-sessions/{session_id}` | — | 投影新增只读字段 `working_resource_id`（null = 未绑定） |

**绑定是作用域，不是准入。** 这条命令只确定「这次读哪个目录」，不授予任何能力：能不能读、能不能写仍由每次动作经 Gateway 按连接与权限判定（§10.6 助手只读来源同一边界）。因此客户端**不得**据此显示「已获读取/写入权限」。

拒绝条件（`INVALID_TRANSITION` 409 / `NOT_FOUND` 404）：

| 情况 | 结果 | 理由 |
|---|---|---|
| 会话已归档 | 409 | 归档会话不接受新的作用域 |
| 会话尚未归入项目 | 409 | 没有 `project_id` 就无法核对目录归属，不允许「先绑再说」 |
| 受管资源不属于该会话的 Project | 409 | 跨项目借用目录等于让一段会话读到别的项目的文件；按**会话行上的** `project_id` 核对，不采信客户端值 |
| 受管资源已停用（`status ≠ ACTIVE`） | 409 | 停用过的目录不靠重新绑定获得准入，也不换资源 ID 绕过停用 |
| 所属项目已归档 | 409 | 归档项目不作为工作目录 |
| 该会话还有在途消息（`PENDING`/`RUNNING`） | 409 | 在途消息已按发送时的作用域开始生成，中途换目录会让这一次读取落到与用户所见不同的目录 |

换绑是允许的：用户换目录就是换作用域，下一轮立即按新目录解析，不保留旧目录的缓存。目录与连接状态**每次工具请求前重查**，因此停用、撤权与换绑在下一次读取就生效。

**来源身份。** 迁移 `0087` 同时给 `logical_operations` / `invocation_attempts` 的三条 CHECK 各追加一支 `AGENT_SESSION_READ`，与 `ASSISTANT_READ`（§10.60）同形：自带 project 与受管资源、会话/消息身份用于核对归属、`task_id`/`run_id`/`step_id`/`import_job_id` 四列全 `NULL`，capability 词表同样只放行 `FILE_READ`/`FILE_QUERY`/`GIT_READ`。**不复用人设助手的来源名**：`SessionToolCallRepository.attachOperation()` 按来源核对，两种会话读取身份在库层面必须可分辨（运行架构 §2.6.3）。写入口继续只有 `RUN`。

Breaking Change：**No**——本节为**新增端点**与会话投影的**新增只读字段**；既有端点、表、CHECK 的既有分支与 `conversation_execution_requests` 原样保留。迁移 `0087` 只增一列与三条 CHECK 的追加分支，`relay_app` 新增该列的 UPDATE 授权。真实 PG 集成覆盖见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)；未运行规格见[测试计划 §17.2](../testing/verification-plan.md#172-普通-agent-连续工具主流程)。

### 10.81 免费模型目录只读与手动同步（2026-10-15 源码实现，阶段 B）

[roadmap §9.1](../requirements/post-v1-roadmap.md) / [运行架构 §8.6](../architecture/runtime-context.md) 的目录面落点，实现 `prompts/free-model-catalog.md` **阶段 B**：OpenRouter 免费目录同步与严格免费判定。目录是**进程级全局事实**，不隶属某个 Workspace——与 `/model-port` 同一先例：为复用实例 Bearer 守卫，端点仍挂在 `API_PREFIX` 的 `…/workspaces/:workspace_id/` 之下，但 `workspace_id` **不作为作用域键**（处理器不据它过滤，正如 `GET /model-port` 忽略该值）。任何持本实例 Bearer 的客户端可见/可触发。**响应永不含密钥。**

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

[roadmap §9.1](../requirements/post-v1-roadmap.md) / [运行架构 §8.6](../architecture/runtime-context.md) 的选择与准入面，实现 `prompts/free-model-catalog.md` **阶段 C**。本节把「已实现且已接线」的会话选择持久化、「已实现并在外呼边界取证」的免费硬限制，与「尚未接线的 Run 冻结/实际外呼」明确分开，不把目标协议当现状。

**冻结约束是随调用携带的非密钥快照。** `workflow/frozen-model-constraint.ts` 定义 `FrozenModelConstraint`：连接引用（`provider` + **确切** `model` + 64-hex `configFingerprint`）、`freeOnly` 布尔、`catalogBasis`（`source=openrouter` + `snapshotSeq` + `sourceModelId`，原默认连接为 `null`）与可选 `budget`。解析对**缺省/空**返回 `undefined`（旧会话无覆盖、旧 Run 无快照时调用方保留原默认，**不伪造**模型身份或免费约束），对半截/畸形对象抛 `FrozenModelConstraintError`——不可信的快照绝不能升级为「免费」或「确切模型」判定。「未知」用 `undefined` 表达，`freeOnly` 缺省视为无免费约束而非「已知非免费」。

**免费调用硬限制已实现并在最终 HTTP 体外呼边界取证。** 携带 `freeOnly` 的约束经 `workflow/free-call-guard.ts` 生成服务商路由硬限制：`provider.max_price` 把 `prompt/completion/request/image` 全部钉为绝对 `0`（USD / 百万 token、每请求、每张），`allow_fallbacks:false` 关闭「免费端不可用落付费端」，`require_parameters:true` 拒绝能力被静默顶替。`OpenAiCompatibleModelPort` 以可选第三参数接受该硬限制，把注入包在 `guardedModelFetch` 之外、SDK 之内（`wireFetch`），因此**普通外呼与 reasoning 续轮重建的客户端都携带**；不带免费约束时端口请求体逐字不变（**原默认不受免费目录故障影响**，FM-07）。具体免费型号请求保持冻结的确切 `model`，**绝不调用 `openrouter/free`**（随机选型违反 Run 模型稳定语义）。受控 HTTP 用例经真实 ChatOpenAI SDK + 注入 fetch 捕获**最终发出体**证明之（`openai-compatible-free-guard`）。

**本批已接线（migration `0089`）：会话模型选择的持久化与写读入口。** 唯一 Owner `application/select-session-model.ts`（`command_type='SelectSessionModel'`，复用既有命令回执/幂等/维护准入基础）在短事务内：校验会话属于本 Workspace 且 `ACTIVE` → 纯解析器 `model-selection-resolve.ts` 把请求的模型确定地判为「默认连接 / 目录免费 OpenRouter 项 / 类型化拒绝」→ 解析所选连接的非密钥配置指纹 → 以 `revision` CAS 写 `session_model_selection`（表见[物理设计 §88](../database/physical-design-postgresql.md)）。`/model <模型名>` 经既有 `POST /assist-sessions/:session_id/chat-commands` 落到该 Owner（命令只落选择与回执，浏览菜单/选中未发送天然零效果，绝不因此发一次模型调用），选择器与本命令共用同一 Owner，只影响该会话后续新请求、**从不改进程默认、从不写 `model_calls`/`runs`**。`GET /assist-sessions/:session_id/model-selection` 只读回显当前选择（无覆盖返回 `selection: null`，前端据此显示「沿用应用默认」）。作用域/鉴权：`httpCommandScopeKey(workspace)`，凭 `workspace_id + session_id` 定位；跨 Workspace 的 session 按不可见处理（`RESOURCE_NOT_FOUND`）。错误：`MODEL_NOT_REGISTERED`(400)、`MODEL_PAID_NOT_AVAILABLE`(409)、`OPENROUTER_CHAT_NOT_WIRED`(409)、`INVALID_TRANSITION`(409，归档会话或 CAS 冲突)、`RESOURCE_NOT_FOUND`(404)、`COMMAND_ID_REUSED`(409)；重放附 `command-replayed` 头并返回原结果（`revision` 不推进），同一 `command_id` 修正内容必须换新 ID。

**旧会话与兼容语义。** 无选择行的旧会话 `readSessionModel` 返回 `undefined`，调用方保留应用默认、不倒造历史选择；归档会话不删选择行（`session_model_selection` 无 `DELETE` 权限），重开可读到原选择并按连接指纹核对是否失效。「仅免费」判定必带完整目录依据（`0089` 依据三列同现同缺 + coupling CHECK）。

**目标协议（本批未接线，下一批以 `0090+` 追加）。** ① OpenRouter 聊天连接的配置解析与实际外呼：本批对命中目录免费项的选择如实拒绝 `OPENROUTER_CHAT_NOT_WIRED`，绝不落一条尚不可兑现的选择，也不预建无当前执行方的连接读取；② Run 创建时写入非密钥模型快照（`runs` 追加 JSONB 快照列），续轮/重试/重启按快照恢复、**不临时读当前会话选择**；③ **所有生成与连接验证入口读取各自冻结约束**（`run-steps`/`delegate-task`/`conversation-execution`/`conversation-state`/`checkers` 五处端口构造点传入对应 `freeGuard`），使「仅免费」选择强制免费准入、过期先刷新、无法核实/下架/所需工具能力未知或不足即拒绝新调用。目录转收费不改原 Run 身份、只在下次调用被原免费限制拒绝；已在途按原 ID 结算，`UNKNOWN` 沿原身份核对不盲重发；401/429/超时/无免费端点/能力不足明确反馈，不自动换付费或其他免费型号、不记免费成功、不把未回传成本补零。这些是下一批的验收落点。

Breaking Change：**No**——`0089` 纯追加一张会话作用域表，既有端点/表/CHECK 不变；`POST /chat-commands` 的 `result` 增加 `MODEL_SELECTION` 判别式（新增 kind、不改既有 `NEW_SESSION`/`STATE_WITHDRAWAL` 结构，客户端按 `kind` 分支）、新增 `GET …/model-selection` 只读端点。`frozen-model-constraint`/`free-call-guard` 与端口第三参数缺省时行为与迁移前逐字一致；选择持久化的当前调用方是 `/model` 与 `GET`，把免费约束接到实际外呼属下一批。

**证据（如实，分层）。** ① 纯解析器（默认命中 / 目录免费 / 收费拒绝 / 目录外拒绝 / 默认优先）与冻结约束/硬限制字段/端口最终体注入由定向单测通过：`model-selection-resolve` **7/7**，C-1 组（`frozen-model-constraint`/`free-call-guard`/`openai-compatible-free-guard` 连既有 `openai-compatible-model-port` 回归）**51/51**，`apps/api` 全量 `tsc --noEmit`（含本批新代码与集成用例）**全绿**。② **已写未跑**：`session-model-selection.integration.test.ts`（默认选择落库与只读回显、同 `command_id` 重放不推进 `revision`、新 `command_id` CAS 递增、仓库层陈旧基线返回 null、跨会话隔离、`OPENROUTER_CHAT_NOT_WIRED`/收费/目录外三类拒绝、归档回滚不留回执、`0089` CHECK 拦截半截写入）。**本轮共享工作树有并行实例、机器非空载，按项目规则未在真实 PG 运行，不计入通过**。③ **未验**：真实 OpenRouter 接受零价硬限制并据此零结算、跨续轮/重启读取持久化 Run 快照、各入口读冻结约束端到端拦截，属需真实凭据与真实 PG 的 FM-06/FM-07 出口；本批无授权凭据、相关端口读接线未实施，**按 §8 不宣称「零收费保证」或「免费分组端到端可用」成立**。


#### 消息模型运行态只读投影（2026-10-17）

`GET /assist-messages/:message_id/model-runtime`：200；**Breaking Change: No**，新增只读端点，既有消息载荷与命令回执不变。同实例 Bearer 与 Workspace 作用域检查仍成立，不存在或其他 Workspace 的消息返回 404。应用查询在一个短只读快照事务中读取原 Assist 消息、冻结策略、候选游标与 `model_calls`，不触发目录同步、生成、切换、结算或业务写入，不维护第二份执行状态。

响应含 `message_id/session_id/message_status`、`snapshot_available`、`preferred_model`、`candidate_models`、`current_candidate_model`、`actual_model`、`max_candidates`、`routing_status/revision`，以及原 `calls`（确切 id/provider/model/status、错误类别、Provider request id、输入输出用量与时间）和 `switches`（原/新型号、原因、作用域与时间）。`actual_model` 取最近调用记录，不能把候选已推进当作 Provider 已成功返回；遗留 STARTED 保持未决。旧消息无快照时 `snapshot_available=false`，不按当前环境倒造首选与候选。

`failure_scope/failure_reason/retry_after_at/free_daily_remaining` 来自持久 `last_failure`：额度为**限流核对时的账户共享日余额**，不是每模型专属余量或实时额度；未知均为 null。用量缺失同样为 null，不因目录免费而补零费用。响应不包含密钥、提示词、工具正文或连接 endpoint。界面只呈现这些事实，相关完成/验收权仍归原 Owner；实际验收成绩只见统一功能验收表。

### 10.84 输入框草稿辅助：自动分点与手动润色（2026-10-16 源码实现）

[工作台 §30](../frontend/workbench-design.md#30-输入框自动分点与手动润色) / [后续路线 §11](../requirements/post-v1-roadmap.md#11-输入框自动分点与手动润色) 的服务面。草稿辅助是**发送前**的文本整理，不是业务命令：它不建消息、Task、Run、提案或批准，因此**没有** `command_id`、**没有**幂等回执、不写任何业务事实——与 `/model-port/verify` 同一形态，是一次有界、有闸门、可能计费的真实模型调用。

| 端点 | 命令？ | 说明 |
|---|---|---|
| `POST /composer/draft-assist` | 否（非幂等、无回执） | 200，请求体 `{operation: 'OUTLINE' \| 'POLISH', text}`（`text` 1–8192 UTF-16 单元），响应 `{operation, status, item_count, text}`。`status='OUTLINE'` 时 `item_count` 为条目数、`text` 为**程序按原文切片**并加编号换行的建议；`status='POLISH'` 时 `text` 为润色文本、`item_count=null`；`status='NO_SUGGESTION'`（分点边界为空，或草稿不适用自动分点）时两者皆 `null`。 |

**请求只含当前草稿。** 端点不接收也不读取会话历史、项目资料、目录文件或工具声明；`workspace_id` 只作为实例 Bearer 边界与调用证据的 Workspace 归属，不作为业务作用域过滤（与 `GET /model-port` 一致）。草稿整段只作为 `UNTRUSTED_DATA` 放进 user 消息，其中的「执行命令」等内容仍只是待处理文本，不获得任何工具或写权限。

**分点只回位置，不回文本。** `OUTLINE` 的模型输出被限定为 `{"breaks":[整数,...]}`：按 Unicode **码点**计数、0 起、左闭右开。`workflow/composer-draft.ts` 校验 JSON 形状、整数性、范围 `(0, 码点总数)`、严格递增、条目上限与「每段至少含一个非空白字符」，然后按原文切片并只加 `N. ` 前缀与段间换行。因此「去掉程序新增格式后逐字重建原文」是**构造保证**，不是比对结果；畸形边界整条拒绝（502 `COMPOSER_RESPONSE_INVALID`），不显示部分分点，也不用标点正则硬拆。已含换行、行首斜杠命令、短于 8 码点的草稿一律 `NO_SUGGESTION` 且不发起调用。

**润色只回 `{"text": ...}`。** 非 JSON、多余字段、空串或超长一律拒绝（同样 502），**绝不用空结果清空草稿**；调用方保留原文并允许再次点击。

**记账与预算。** 每次真实调用在既有 `model_calls` 账本写一行 `kind='COMPOSER'`（无 Run/会话作用域，不占 Run 或会话预算，见[物理设计 §89](../database/physical-design-postgresql.md)），准入与 `STARTED` 行同一短事务提交后才外呼；Provider 返回后按 `COMPLETED` 结算并记录真实 `usage`——**协议畸形也记 `COMPLETED`**（那是产品结论，不是 Provider 失败）。传输失败记 `FAILED` 与统一错误分类；取消记 `CANCELLED`。不新建第二套账本、不建占位 Run/Task。

**边界与闸门。** 草稿码点 2–4000（超出 → 400 `COMPOSER_DRAFT_TOO_LONG`）；实例内最小调用间隔 400ms、并发上限 4（超出 → 429 `COMPOSER_RATE_LIMITED`，且**不写账本、不外呼**）。未配置真实 Provider（`RELAY_MODEL_PROVIDER` 缺省/`fake`）→ 409 `MODEL_PORT_NOT_CONFIGURED`；配置残缺 → 409 `MODEL_CONFIG_INVALID`。两者都在开事务之前判定，不留「已开始」的调用证据。辅助失败**不丢草稿、不阻止原发送**：草稿与发送仍沿原输入器与发送 Owner。

Breaking Change：**No**——纯新增一个端点与一个 `model_calls.kind` 取值；旧读取方按 `kind` 过滤时看不到 `COMPOSER` 行，既有端点、表与 CHECK 分支原样保留。

**证据（如实）。** ① 定向单测通过：`composer-draft.test.ts`（文档示例逐字重建、重复句/标点/空白/路径/URL/emoji 保真、畸形边界 9 类拒绝、润色协议与适用性）**10/10**；`composer-draft-port.test.ts`（两条路由登记与模板一致、受控 HTTP 捕获最终发出体证明请求只含草稿且 `response_format=json_object`、无工具声明）**3/3**；`apps/api` 全量 `tsc --noEmit` 通过。② **已写未跑**：`composer-draft-assist.integration.test.ts`（真实 PG：`COMPOSER` 行无作用域且 `COMPLETED`+usage、业务计数前后不变、不适用时不写行、畸形协议仍记 `COMPLETED`、Provider 失败记 `FAILED`、闸门限流不写行、未配置/超长在开事务前拒绝、HTTP 401/409/422）——共享工作树有并行实例、机器非空载，按项目规则未并发运行 `run-integration.ps1`，**不计入通过**。③ 前端：`tests/composerDraftAssist.spec.tsx` **12/12**（停笔才请求、组词零请求、忽略不重复请求、查看/采用/撤销、Esc 与焦点、润色中态与快照撤销、失败保留、迟到隔离与「改回相同文本不复用旧结果」、发送清空、来源变化清空）与 `tests/browser/composerDraftAssist.spec.ts`（真实 Chromium 主路径与在途编辑覆盖）已运行。④ **未验**：真实 Provider 的语义质量样本、真实 Windows 窗口的 IME/DPI 与安装态。

### 10.85 Assist 消息图片附件（2026-10-18 前后端接线）

[工作台 §33](../frontend/workbench-design.md#33-输入框粘贴图片与消息附件) 的服务面。粘贴/拖拽进输入框的图片是**会话输入快照**：不是资料（不进 knowledge/memory/decision 版本体系，不占用显式选源 10 条上限），不是 artifact（不受管存储版本目录与防篡改核对语义），也不是幂等业务命令。链路分两阶段：**先传后引**——上传端点落一行不可变暂存，消息命令在同一事务内把附件绑定到新用户消息。

| 端点 | 命令？ | 说明 |
|---|---|---|
| `POST /assist-sessions/{id}/message-attachments` | 否（暂存，无 `command_id`、无回执） | 201，请求体 `{name, media_type, data_base64}`（路由级 `bodyLimit` 4 MiB；`name` 1–200 字符），响应 `{attachment_id, byte_length, content_hash}`。媒体类型白名单 `image/png\|image/jpeg\|image/gif\|image/webp`；原始字节 >0 且 ≤2 MiB。会话必须存在、归属本 Workspace 且 ACTIVE（归档 → 409 `INVALID_TRANSITION`）。不改变任何业务状态，因此不走命令幂等 |
| `GET /assist-sessions/{id}/message-attachments/{attachment_id}` | 否（只读） | 200，`{attachment_id, name, media_type, byte_length, data_base64}`。**2026-10-18 新增**：工作台 §33.3 的历史消息缩略图需要读回内容。归属同时核对 Workspace 与 Session，跨会话/跨 Workspace 一律 404 `RESOURCE_NOT_FOUND`；只读，不改任何业务状态。以 base64 返回而不是二进制：客户端只有一个 JSON 传输形状，不为这条只读路径引入第二套读法 |
| `POST /assist-sessions/{id}/messages` 新增可选 `attachment_ids: [uuid]`（≤4） | `RequestAssistMessage` | 202；`attachment_ids` 进命令载荷幂等摘要，重放按原 ids 核对。用例在同一事务内核对归属（同 Workspace+会话、未被他消息绑定）、去重、每消息 ≤4 张与总量 ≤6 MiB，然后绑定到新用户消息；任何核对失败整体回滚（404 `RESOURCE_NOT_FOUND` / 422 `VALIDATION_FAILED`），绝不部分绑定。**不传该字段时载荷逐字不变**，既有调用与重放零影响 |

**正文可以为空，但只限带图片的讨论轮（2026-10-18）。** `content` 的 schema 由 1–32768 字符放宽为 0–32768，是否真的允许空正文由用例裁决：`attachment_ids` 非空、没有 `skill_ref`、`intent` 为 `DISCUSS`（或缺省）时允许空串（落库 `''`，不是 `NULL`，既有 `content IS NOT NULL` 约束不变）；其余情况仍是 `must not be empty`。理由是「只有图片、没有一句话」本身是正常的输入形态，而 Skill 与提案意图以正文为输入，空正文会产生没有意义载荷。**Breaking Change: No**——只是放宽，旧客户端行为逐字不变。

**消息投影新增 `attachments`。** `GET /assist-sessions/{id}/messages` 每条消息多一个 `attachments: [{id, name, media_type, byte_length}]`（**只有元数据**，不读 `bytea`）。列表是每轮都读的投影，把内容混进去会让一次列表读取变成几 MB；内容按单张经上面的 GET 端点读取。缺字段按「没有附件」读，因此旧服务端的响应仍可解析。

**物理**：迁移 `0093` 建表 `assist_message_attachments`（`bytea` 内容 + `content_hash` + `byte_length=octet_length(content)` CHECK + 类型白名单 CHECK；只授 `SELECT/INSERT/UPDATE`）。选 `bytea` 而非受管存储文件：附件必须与消息同短事务提交，`bytea` 没有「写了文件没写库」的中间态，也无孤儿文件；单用户本机体量由上限约束。详见[数据库设计 §91](../database/physical-design-postgresql.md#91-0093-assist-消息图片附件2026-10-16-源码实现)。空正文与读端点都不需要新迁移（`content text` 本就可空、`''` 满足非空约束；读端点只查既有行）。

**模型能力闸门（fail-closed，2026-10-18 补一处空白）。** 当前聊天恒由进程默认连接服务（会话选择→端口接线属阶段 C-2b，落地后应改为读取冻结快照），因此带附件的发送按 `RELAY_MODEL_NAME` 在模型目录里查条目并读 `capabilities.image_input`（10.82 目录同步的三态：true/false/null）。**目录里有条目时目录是唯一准绳**：非 `true` 一律 422 拒绝。**目录里没有条目时**（自建 Provider 不会出现在 OpenRouter 目录里，例如本机 `agnes-3.0-flash`），只有运维显式声明 `RELAY_MODEL_IMAGE_INPUT=true` 才放行；未声明仍按未知拒绝，错误里直接写明这个变量名。声明是运维事实而不是猜测，也不因带图换模型、换连接或悄悄降级为纯文本。

**多模态组装。** 仅**当前消息**的附件以多模态 content parts 交给模型（LangChain 1.x 标准块 `{type:'image', source_type:'base64', data, mimeType}`，图片在前、正文文本收尾）；正文为空时不再追加空的 text 块。历史消息的附件降级为一行文本占位（`（该轮随附图片：…；图片内容不在本轮回放。）`），不冒充模型看得见，也不逐条回放历史图片占上下文。纯文本轮次的请求形状逐字不变。

**边界。** 附件不授予任何读取/执行权限；上传、绑定与读回都在会话作用域内核对，跨会话/跨 Workspace 引用按 404 拒绝。V1 仅支持图片；文本/PDF 等文件类型在上传端点明确拒绝并说明（模型目录的 image 输入是常见能力，文档输入极少支持），后续按需扩展。

Breaking Change：**No**——全新端点与表 + 消息命令新增可选字段；无附件路径的载荷、hash、重放与请求形状逐字不变。

**证据（如实分层）。** 2026-10-16（后端首版）：`apps/api` 全量 `tsc --noEmit` 通过；受影响单测 `model-catalog-pricing` / `openai-compatible-model-port` / `model-catalog-config` / `openai-compatible-free-guard` 合计 **58/58**。当时**未运行/未编写**真实 PG 集成测试与前端规格（前端未接线）。

2026-10-18（本轮回合）：真实 PostgreSQL `assist-message-attachments.integration.test.ts` **5/5**（`run-integration.ps1 -TestFile assist-message-attachments -UseCLocale` 整体 PASSED，临时集群已清理）——覆盖绑定与投影元数据、单张内容读回、跨会话/跨 Workspace 404、空正文例外（无附件/Skill/提案三种拒绝）、能力声明（未声明拒绝且错误里点名 `RELAY_MODEL_IMAGE_INPUT`，声明后通过）、类型/单张/数量/重复引用四类上限、被拒绝的命令不绑定任何行；另有一条 HTTP 面用例核对三个端点的响应形状（上传 201、能力未声明时 422 且错误点名变量、消息列表的 `attachments` 元数据、内容端点的字段名与字节）——它当场抓到了「用例层 camelCase 与响应 schema 的 snake_case 对不上、序列化后字段被丢掉」的投影遗漏。工作台 `tests/composerImageAttachments.spec.tsx` **6/6**（2026-10-19 增补「上传成功但命令被拒时图片留在输入框」用例，现 7/7）。**该轮真实 PG 用例暴露并修掉一个后端缺陷**：`bindAttachments` 的 `UPDATE` 缺 `RETURNING`，驱动只回「命令完成」、`rows` 恒为空，绑定数被读成 0，任何带图消息都会以「附件在作用域内不可见」被拒——这是 0093 落地时没有集成测试的直接后果。**未验**：真实 Provider 的多模态语义质量、真实 Windows 窗口的粘贴/拖拽与 DPI。

### 10.86 目录写入档位投影与只读查询（2026-10-17 源码实现）

本节记录本地目录免手工配置的服务面；产品行为归[工作台 §18.1.4](../frontend/workbench-design.md#1814-本地目录权限设置2026-10-18已确认已实施)。用户主动打开并成功关联目录时，应用按原 Owner 建立或复用该根默认只读的基础读取配置；只读 GET、恢复旧会话与模型输出不写权限。改档使用下述命令入口，所有就绪状态仍由原 Gateway 准入事实投影。配置的管理元数据见[数据库 §98](../database/physical-design-postgresql.md#98-0109-本地目录访问档位元数据2026-10-18-源码实现)。

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

`FULL` 不新增第四种 Gateway 判定：网关词表仍是 `AUTO` / `ASK` / `DENY`，排序仍是 `DENY` > `ASK` > `AUTO`（同档按更长前缀、再按 ID）。豁免只在准入处把「本目录档位为 `FULL`」并入「范围已覆盖」这一个条件，因此显式 `DENY`、上层受管根的更严格条目、目录根外目标与没有 FILE_WRITE 连接的目录都不被放宽；该档位必须由准入按 `resource_id` 回读 `local_directory_access`，prepare 与 dispatch 各读一次同一函数，客户端不得在动作请求里传档位。Run 范围授权继续永远不含删除——那是范围授权的边界，与目录档位无关。物理边界与回滚见[数据库 §101](../database/physical-design-postgresql.md#101-0112-本地目录完全访问档位2026-10-18-源码实现)。

改档端点：`POST /api/v1/workspaces/{workspace_id}/projects/{project_id}/managed-resources/{resource_id}/local-access`，请求为 `{command_id, expected_revision, write_tier}`，其中 `write_tier` 接受 `READ_ONLY`、`ASK`、`AUTO`、`FULL`。Application 命令 `SetLocalDirectoryWriteTier` 在同一命令事务中按资源根、Project/Workspace 归属和 `expected_revision` 核验后更新档位，返回 `project_id`、`resource_id`、`write_tier` 与新 `revision`。首次执行前核对物理根；已存在回执时仍由命令执行器核对原作用域、命令类型与完整载荷，但精确重放不依赖当前磁盘根。相同 `command_id` 的载荷变化仍按 `COMMAND_ID_REUSED` 拒绝，重放不推进配置 revision。冲突不覆盖更新值。该命令只管理本入口登记的条目；显式 `DENY`、连接停用、上层受管根限制和已有 Gateway 准入规则不能被改档绕过。**Breaking Change: No**（`write_tier` 加值 `FULL` 是兼容新增：既有取值不变、旧行不受影响，旧客户端把未知取值读成「待核对」而不是猜一档；未知取值仍按 422 拒绝）。

`POST /api/v1/workspaces/{workspace_id}/working-directories/open` 的 `write_readiness` 可附带 `write_tier` 与 `access_revision`；这是兼容性新增字段。首次成功的显式目录打开会准备基础读取配置，读取 `GET .../write-readiness`、重开旧会话和恢复请求不写配置。具体结果与未验边界见[统一功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

新增默认读取配置前会查阅既有 Gateway 策略版本中的历史目标；若匹配当前根的范围曾明确配置/撤销且没有当前活动授权，首次目录打开不会另建 AUTO。该查询复用既有策略表和版本，不增加 API 字段或数据库结构；后续明确活动策略仍可按既有 Owner 复用。

2026-10-18 的真实 PG/HTTP 与目录 CRUD 结果、桌面产物及未验证范围只记在[统一功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)；本节定义 API 合同，不把合同本身当作运行证据。

### 10.87 会话未读标记（2026-10-17 源码实现，迁移 0104）

[工作台 §28.1](../frontend/workbench-design.md#281-左栏recentworkrail) 左栏会话行菜单「标记为未读／取消未读」的服务面。迁移 `0104_assist_session_unread.sql` 给 `assist_sessions` 只增一列可空 `unread_at`（物理边界见[数据库 §94](../database/physical-design-postgresql.md#94-0104-会话未读标记2026-10-17-源码实现)）。它与 0090 的置顶（`pinned_at`）**同一条命令形状**：一条命令两个方向，靠布尔载荷区分，不做两个端点。0090 的改名／置顶／归档／重开从未单独登记为 §10.83，本节只登记 0104，不回溯改写那批端点的语义。

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

F26 浏览器自动化（[浏览器自动化 V1](../architecture/browser-automation-v1.md)）M2 的唯一只读端点。物理边界归[数据库 §95](../database/physical-design-postgresql.md#95-0106-浏览器后端健康投影2026-10-17-源码实现)，规格归[测试计划 §36](../testing/verification-plan.md#36-内置浏览器自动化验收规格2026-10-17)。

**Breaking Change：No** —— 全新端点，不改动任何既有响应。

| 端点 | 说明 |
|---|---|
| `GET /workspaces/{workspace_id}/browser/status` | 200，返回浏览器后端（Relay 自有 Chrome 实例 + chrome-devtools-mcp）最近一次被 Worker 实测的健康结论 |

响应形状：`{ status, backend_version, chrome_version, detail, remediation, tool_count, updated_at }`。`status ∈ NOT_STARTED \| READY \| CHROME_MISSING \| BACKEND_MISSING \| INCOMPATIBLE \| DISCONNECTED`。

**语义边界。** 这是**安装级的运行时诊断，不是工作区业务数据**：URL 保留 `workspaces/{workspace_id}` 段只是沿用全站路由前缀，处理器**不读它、不校验工作区存在、不做跨工作区可见性裁剪**——换一个 workspace_id 得到的是同一份结论。它不参与任何准入。`NOT_STARTED` 表示本机从未使用过浏览器能力（表里没有行）；`updated_at` 是「这个结论是什么时候测出来的」，桌面壳据此显示「上次检查于…」。

**事实来源与写方。** 唯一写入方是 Worker 派发路径的 `browserExecute`：每次动作前先 `ensureStarted` 并把结论 upsert 进 `browser_backend_state`（单行 `id=1`）。**上报失败不阻断真实动作**——投影写不进去时动作照常执行，UI 少一次状态刷新属于可感知降级。API 进程只读：它**不会**为了回答这个端点去启动自己的浏览器实例（那会变成两个 Chrome）。不做惰性过期：READY 的后端在 Worker 存活期间一直活着，猜测过期只会制造假阴性；进程真的退出时 Worker 写 `DISCONNECTED`。

**remediation 是可操作建议**：`CHROME_MISSING` → 安装 Chrome 或设置 `RELAY_BROWSER_CHROME_PATH`；`BACKEND_MISSING` → 重装 Relay 或先跑 `fetch-browser-mcp.mjs`；`INCOMPATIBLE` → 更新 Relay；`DISCONNECTED` → 重新执行一次浏览器操作会自动重建。客户端直接展示这句，不自己拼提示。

**证据（如实分层）。** 真实 PostgreSQL：`browser-read.integration.test.ts` **6/6**（`run-integration.ps1 -TestFile browser-read` 整体 PASSED，临时集群已删除）——「BROWSER_READ 全链路成功 + 投影 READY」「按站点收窄（前缀内 PREPARED、前缀外被拒）」「非法目标形状 GATEWAY_TARGET_DENIED」「后端不可用派发失败 + 投影 CHROME_MISSING」「BROWSER_ACTION 无范围授权时 AUTO 降级 WAITING_APPROVAL」「跨进程经 HTTP 读到同一行」。真实 Chrome 链路归 [browser-automation-v1 §12](../architecture/browser-automation-v1.md)；安装态未验。

### 10.89 浏览器任务列表与停止（2026-10-17 源码实现，迁移 0107）

F26 浏览器自动化 M3 的任务状态面。物理边界归[数据库 §96](../database/physical-design-postgresql.md#96-0107-浏览器任务状态2026-10-17-源码实现)，设计归[浏览器自动化 V1](../architecture/browser-automation-v1.md)。

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

退出等待复用 Run 的控制安全点：在途 Worker/Invocation 或未知效果未处理前不宣称停止；安全点应用控制后，状态投影才写 STOPPED。此投影不替代执行权、审批或外部动作账本。权限迁移与兼容边界见[数据库 §99](../database/physical-design-postgresql.md#99-0110-电脑控制状态的应用角色权限2026-10-18)，回归入口为 `computer-control.integration.test.ts`，实际成绩归统一验收表。

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

**证据（如实分层）。** 回归入口：后端单元 `preview-events-api.test.ts`（probe key 的身份/重置语义、帧格式与终态判定）、真实 PG/HTTP 集成 `preview-events.integration.test.ts`（首帧等于 GET DTO、多帧 revision 递增、终态帧后关流、跨 Workspace 404、断线重连）；前端工作台定向用例覆盖 SSE 帧消费与 GET 降级。真实 Provider 首字延迟与桌面体验仍需单独测量；实际成绩归[统一验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

### 10.91 会话列表的活动排序键（2026-10-18 源码实现，迁移 0111）

工作区前缀为 `/api/v1/workspaces/{workspace_id}`。**Breaking Change：No**——没有新命令、没有新端点，只给既有会话投影加一个可空只读字段，并改掉 `GET /assist-sessions` 那一列的默认顺序。迁移与写入 Owner 见[数据库 §100](../database/physical-design-postgresql.md#100-0111-会话活动排序键2026-10-18-源码实现)，界面读法见[工作台 §28.1](../frontend/workbench-design.md#281-左栏recentworkrail)。

| 端点 | 变化 | 说明 |
|---|---|---|
| `GET /assist-sessions`、`GET /assist-sessions/{session_id}` | 投影新增只读字段 `last_message_at` | 逐字回显活动时刻（ISO 8601）或 `null`；`null` 只表示这段会话还没有消息。缺字段只来自 0111 之前的响应，客户端同样回落 `created_at` |
| `GET /assist-sessions` | 列表顺序 | `order by pinned_at desc nulls last, coalesce(last_message_at, created_at) desc, id desc` |
| `POST .../title`、`/pin`、`/archive`、`/reopen`、`/unread` | 无 | 命令体与回执字段都不变，回执里**不**带 `last_message_at` |

**排序口径。** 活动序＝这段讨论最近一次真正说过话是什么时候，不分发送方：用户消息落库与 AI 生成结算都算一次活动，所以失败或取消的那一轮同样上浮。置顶仍是第一排序键，活动序只在未置顶的组内生效；`coalesce` 让还没开口的会话按创建时间留在原位，不会因为新列为空而沉底。这是**导航排序键，不是业务事实**，与 0090 的 `pinned_at`、0104 的 `unread_at` 同性质，不参与任何准入判定。

**不推进 `revision` 与 `updated_at`——这是本节的硬约束。** 会话行的修订号是上面那组人工控制命令的 CAS 基线。若消息写入也推进修订，在途生成期间发出的改名／置顶会稳定吃到 `REVISION_CONFLICT`（409），界面只能反复重读；若推进 `updated_at`，「只是重命名过一次」与「刚说过话」在响应里就分不开。因此发送消息与生成 Worker 的结算都不改这两列，集成测试把它们逐字锁住。同理，`assist_message_previews` 的流式增量帧不推进本字段：临时前缀每帧都动会让左栏在生成期间持续跳位。

**迟到写入不推进。** 生成结算按 `(message_id, worker_id, status='RUNNING')` CAS；迟到的旧 Worker 结算既不收敛消息状态，也不 touch 会话排序键。排序键取单调最大值，时钟或提交顺序倒挂都不会把它拉回。

**已知缺口（如实）。** 本字段只在列表与单会话读取时返回；左栏当前没有轮询或事件订阅，AI 说完那一刻不会自己跳位，要等下一次整列重读或该行发起命令后的定向重读才收敛。§10.17 的 `run_hint` 类提示没有为本字段扩展，见工作台 §28.1 与统一验收表的剩余限制列。

### 10.93 会话分叉（2026-10-18 源码实现，迁移 0113）

工作区前缀为 `/api/v1/workspaces/{workspace_id}`，沿用本机 API 鉴权。**Breaking Change: No**——新增一个命令与端点，既有会话投影只多一个可空只读字段。迁移与写入 Owner 见[数据库 §102](../database/physical-design-postgresql.md#102-0113-会话分叉血缘2026-10-18-源码实现)，界面读法见[工作台 §28.1](../frontend/workbench-design.md#281-左栏recentworkrail)。

| 端点 | 命令 | 状态码 | 请求体 | 回执结果 |
|---|---|---|---|---|
| `POST /assist-sessions/{session_id}/fork` | `ForkAssistSession` | `201` | `{command_id, expected_revision}` | `{session_id, title, revision, updated_at, copied_messages}` |

`session_id` 是**新建的子会话**，不是被分叉的那一条；`links.resource` 指向它。`revision` 恒为 `"0"`（新资源），`copied_messages` 是搬进历史的已完成轮数（可以为 `0`，不是失败）。分叉是唯一新建会话行的行内命令，因此与 `Create*` 同为 `201`，不是对源会话的改写。

**源会话一行都不改。** `expected_revision` 仍然核对（陈旧基线返回 `409 REVISION_CONFLICT` 并带出 `actual_revision`，界面只重读、不自动重发），但它只用于挡住「界面看的是旧事实就按下分叉」；成功分叉**不推进**源会话的 `revision` 与 `updated_at`。源会话必须对当前 Workspace 可见（跨 Workspace 按 `404 RESOURCE_NOT_FOUND`）、状态为 `ACTIVE`（归档态 `409 INVALID_TRANSITION`，先重开），且没有 `PENDING`/`RUNNING` 消息（在途 `409 INVALID_TRANSITION`；正在生成的那一轮既不该进历史，也不该让子会话从半截开始）。

**子会话的行形状。** 会话身份整行搬运：`workspace_id`、`project_id`、`task_id`、`conversation_mode`、`assistant_profile_id/revision/role_snapshot`、`remember`、`working_resource_id` 与源行一致；`status='ACTIVE'`、`revision=0`、`pinned_at`/`unread_at`/`last_message_at` 一律 `NULL`（导航偏好不继承，新讨论按活动序落在顶部），`forked_from_session_id` 写入源会话 ID。来源是**一次性写入的历史元数据**：改名、置顶、未读、归档、重开都不会改写它，它也不参与任何准入判定。

**复制的是历史输入。** 只搬 `status='COMPLETED' AND content IS NOT NULL` 的消息，按子会话从 `seq=1` 重新编号（`UNIQUE (session_id, seq)`）；正文、`sources`、`skill_snapshot/skill_input/skill_output`、`method_*`、`learning_record_disabled` 与 `created_at` 原样保留，行 ID 全部新生成。图片附件逐张复制成新行（同一 `message_id` 绑定、内容与哈希字节不变，`bytea` 在库内搬运）。以下**不搬**：`assist_proposals`（接受一次会写业务事实，同一条提案不能在两条会话里各接受一次）；`provider_request_id`、usage 四列、`worker_id`、`cancel_requested`、`error_code`、`provider_error_kind`、`model_attempt_state`（子会话没有发生过那次外呼，留着就是伪造）；`model_selection_snapshot` 随尝试状态一起去掉——0098 要求两列成对非空，而复制后的历史一律 `COMPLETED`、不会再进生成路径，排队期的模型身份对子会话没有读方。

**标题由服务端排号。** 末位是 `（n）` 或半角 `(n)` 时加一，否则追加 `（1）`；编号跟着**被分叉那一条自己的标题**走，所以同一源会话分两次都得到 `（1）`（标题不是唯一键），分叉一条 `（1）` 得到的是 `（2）`。总长仍守 `TEXT_LIMITS.title=200`：超长时截正文前缀、保留完整编号，并按完整码点退让（不切坏 emoji）。

**幂等。** 同一 `command_id` + 同载荷重放返回原结果并附 `command-replayed: true`，不新建第二条子会话、不新增回执；同一 ID 换 `expected_revision` 返回 `409 COMMAND_ID_REUSED`。幂等作用域是 Workspace，与其它会话行内命令一致。

**投影。** `GET /assist-sessions`（含默认列表、`status=ARCHIVED|ALL`）与 `GET /assist-sessions/{session_id}` 新增只读字段 `forked_from_session_id`（`uuid | null`），只解释标题里的编号从哪来，不改变列表顺序或任何判定。

**证据（如实分层）。** 真实 PostgreSQL：`assist-session-controls.integration.test.ts` **22/22**（分叉 5 条：201 落库与源行零改动、历史/附件复制与提案不复制、同命令重放不产生第二条、在途/归档/陈旧修订/跨 Workspace 四道栅栏、标题排号与 200 上限、0113 列形状与列表投影）；入口栅栏单测 **6/6**；工作台 `sessionRowMenu.spec.ts` **19/19**。真实 Windows 窗口未点验。

### 10.94 会话物理删除（2026-10-18 源码实现，迁移 0116）

工作区前缀与鉴权沿用既有约定。**Breaking Change: No**——新增一个命令与端点，不改既有命令、投影或失败码；删除后的读入口按「不存在」处理。删除边界与取舍归 [ADR-027](../decisions/ADR-027-session-physical-delete.md)，授权形状见[数据库 §103](../database/physical-design-postgresql.md#103-0116-会话物理删除授权2026-10-18-源码实现)。

| 端点 | 命令 | 状态码 | 请求体 | 回执结果 |
|---|---|---|---|---|
| `POST /assist-sessions/{session_id}/delete` | `DeleteAssistSession` | `200` | `{command_id, expected_revision}` | `{session_id, revision, deleted_messages, deleted_attachments, deleted_at}` |

**不可撤销。** 这是全项目唯一删除会话的命令：没有回收站，没有「取消删除」反向命令，误删与重启都无法找回。界面必须先弹确认框、逐字写明不可恢复，**不给撤销条**；归档仍是可撤销通道，两者不合并成一个「移除」动作。

**删什么。** 只删会话自有账本，按子 → 父顺序在同一短事务内显式执行（不依赖 `ON DELETE CASCADE`）：消息、提案、附件（`bytea` 内容随行消失）、生成中预览、会话工具调用、模型选择、自然语言状态维护请求与其变更、未进入组合检查的影响检查与候选分组、辅助模型调用计量与已到期供应商冷却、会话 diff 基线，最后是会话行本身。`conversation_diff_baselines.session_id` 是普通列（0097 无外键），必须显式删，否则留下悬空账本。

**不删什么（阻断）。** 命令先查阻断项，命中任意一项即整条拒绝、零删除，返回 `409 SESSION_DELETE_BLOCKED`，`conflict.blocking_reasons` 逐项列出：

| 代码 | 含义 |
|---|---|
| `FORK_CHILDREN` | 存在以本会话为来源的分叉会话 |
| `TASK_ACCEPTANCE_CITED` | Task 验收观察把本会话的消息作为来源 |
| `HYPOTHESIS_CITED` | 项目假设版本把本会话的消息作为来源 |
| `WORK_SEGMENT_CITED` | 工作片段把本会话的消息作为来源 |
| `BLUEPRINT_CITED` | 项目蓝图提案把本会话的消息作为来源 |
| `EXECUTION_REQUESTS` | 本会话发起过执行请求 |
| `LEARNING_RECORDS` | 本会话有学习记录 |
| `ARTIFACT_IMPACT_COMMITTED` | 本会话的影响检查已进入组合检查 |
| `PROVIDER_COOLDOWN_ACTIVE` | 本会话的模型调用仍在未到期的供应商冷却里 |

另有与归档共用的在途栅栏：存在 `PENDING`/`RUNNING` 消息时返回 `409 INVALID_TRANSITION`。跨 Workspace 的会话按 `404 RESOURCE_NOT_FOUND`。

**并发与幂等。** 行锁 + `expected_revision` CAS 先于判定：陈旧基线返回 `409 REVISION_CONFLICT` 并带出 `actual_revision`，一行不动。删除成功后会话行已不存在，重放**不能**靠再读会话判定，而是读 `command_receipts`：同 `command_id` 同载荷返回原结果并附 `command-replayed: true`，换载荷返回 `409 COMMAND_ID_REUSED`。

**审计。** 命令回执之外，在同一事务写一条 append-only 的 `activity_records`（`event_type='ASSIST_SESSION_DELETED'`）。`fact_refs` 只记会话 ID、删除前修订与删除行数，不复制标题或正文——用户要求删除之后，审计不成为第二份保存。

**证据（如实分层）。** 真实 PostgreSQL：`assist-session-delete.integration.test.ts` **9/9**（账本删净且无悬空基线、行消失后回执重放、换载荷复用 ID 被拒、陈旧基线零删除、在途消息栅栏、分叉与学习记录两类阻断、跨 Workspace 不可见、0116 授权不外溢、删除后无只读恢复入口）；工作台 `sessionRowMenu.spec.ts` **19/19**（新增四条：确认与取消、确认后行从活跃区消失且无撤销条、阻断项留在确认框、回执不明锁死确认键）；`tsc --noEmit` 两侧对本片文件干净。真实 WebView2 窗口与多 DPI 下确认框的焦点与观感未复核。

### 10.94 周期定时启动任务（2026-10-18 源码实现，迁移 0115）

| 方法 | 路径（前缀 `/api/v1/workspaces/{workspace_id}`） | 命令 | 成功 | 请求体 | 回执 `result` |
|---|---|---|---|---|---|
| POST | `/projects/{project_id}/scheduled-tasks` | `CreateScheduledTask` | `201` | `{command_id, confirmed:true, title, template, repeat_rule, timezone, local_time, first_local_date, max_runs, authorization_expires_at, execution?}` | `{scheduled_task_id, project_id, status, revision, schedule_generation, next_due_at}` |
| POST | `/scheduled-tasks/{id}/edits` | `EditScheduledTask` | `200` | 同上 + `expected_revision, reason` | 同上 |
| POST | `/scheduled-tasks/{id}/status-changes` | `SetScheduledTaskStatus` | `200` | `{command_id, expected_revision, status, reason}` | 同上 |
| POST | `/scheduled-task-occurrences/{id}/resolutions` | `ResolveScheduledTaskOccurrence` | `200` | `{command_id, expected_revision, action:'RETRY'\|'DISMISS', reason}` | `{occurrence_id, scheduled_task_id, status, revision}` |

只读：`GET /scheduled-tasks?project_id=`、`GET /scheduled-tasks/{id}`（含最近 20 次触发与项目投影）。

**「定时任务」是模板 + 重复规则 + 提前授权，不是对某个 Task 的重复执行。** 每次触发新建一个 Task，再走原 `CreateTask → MarkTaskReady → DelegateTask`。Task 跑完即 `DONE`，终态不可复活，所以「周期」只能表现为「每次新建」；这也意味着重复执行的是**这套设定**，不是同一个任务。取舍与代价见 [ADR-026](../decisions/ADR-026-scheduled-task-autostart.md)。

**模板在创建时就按 `CreateTask` 的口径校验。** `template` 的形状与创建任务一致（`task_title`、`objective`、`mode`、`expected_outputs`、`criteria[]`），创建命令内部调用 `prepareTaskCreation` 与 `checkDeclaredOutputs`，非法模板当场 `422`，不会等到首次触发才失败。`mode` 缺省 `ME`，`expected_outputs` 缺省 `{}`；`DELEGATE_AI` 仍按原口径 `CAPABILITY_DISABLED`。

**重复规则只有两种。** `{kind:'DAILY', interval_days:1..30}` 与 `{kind:'WEEKLY', weekdays:[1..7]}`（1=周一，去重后升序）。不做 cron 表达式、月/年规则、多时区混排。

**时刻是墙钟，不是固定偏移。** 请求传 `local_time`（`HH:MM`）+ `first_local_date`（`YYYY-MM-DD`）+ `timezone`，服务端算出绝对时刻并落 `first_run_at`/`next_due_at`。跨夏令时的「每天 09:00」仍是 09:00：春跳不存在的时刻顺延 +1 小时，秋回重复的时刻取较早一次。`first_local_date` 必须解析出严格晚于当前时刻的首次触发，否则 `422`。

**授权一次性确认，到点只做准入。** `confirmed` 必须为 `true`；`max_runs` 取 1–100；`authorization_expires_at` 必须是带 `Z` 或偏移量的实际时刻，且在未来 90 天内（**这是对 N06 24 小时上限的有意偏离**，理由见 ADR-026）。触发不授予新权限：`delegateTask` 在**原命令事务内**核对触发发生身份、计划状态、代次、有效期与预算，未通过即拒绝且效果不落库。

**准入以 Task 终态为准，不是 Run 是否活跃。** Run 完成后 Task 停在 `WAITING` 等人工验收；此时本轮记 `SKIPPED`（`reason='PREVIOUS_TASK_NOT_ACCEPTED'`），不自动代答验收，也不堆出第二个待验收任务。跳过的时段不消耗 `max_runs`——预算是「最多真正启动多少次」，不是「过了多少个时段」。

**错过不自动执行。** 应用关闭期间错过的时段记 `BLOCKED`（`reason='MISSED'`，`missed=true`），**不建 Task**；用户在详情页选择「补跑一次」才把这条改回 `DISPATCHING` 重新准入。与 N05「最多形成一次待处理」同口径，区别是 N05 只形成待处理，本能力补跑后会真的启动。

**到期与预算耗尽不是静默停止。** 两者都把计划置 `EXPIRED` 并留一条 `BLOCKED` 触发说明原因；`EXPIRED` 的计划不能直接改回 `ENABLED`，须先通过编辑延长授权。

**执行范围在触发时冻结。** `execution`（资料引用 / 固定读取 / 工具循环 / 范围授权 / 原会话方法）与任务链共用同一份词表；用户选的只是意图，真正冻结发生在触发时、绑定到当次新建的 Task 上，并写入 occurrence 的 `frozen_execution`。依据漂移（连接停用、资料版本变化、范围授权到期）则这一次 `BLOCKED`，**不静默降级为无工具执行**。`scope_grant.expires_at` 被夹到计划授权到期时刻。

**幂等。** 四个命令都是 `command_id` 幂等，作用域为 Workspace；同一 ID 换载荷返回 `409 COMMAND_ID_REUSED`。触发链路的三步命令身份在 occurrence 落库时预生成，崩溃后重跑靠回执重放，不会重复建 Task；`expected_task_revision` 只取自前一步回执，读库重算会改变 `payload_hash` 并被判成 ID 复用。

**并发。** `DISPATCHING` 是租约：调度器用 `FOR UPDATE SKIP LOCKED` 取到期行、插入 occurrence 后，再按「待分发」逐个抢租约执行。同一时段有 `UNIQUE (scheduled_task_id, schedule_generation, sequence)` 与三个命令列的唯一约束兜底。与 N06 一致，本片假设单 API 进程运行调度器；多实例不在承诺范围。

**待处理投影。** `GET /attention/interventions` 与 `POST /attention/notifications/claim` 新增 `kind='SCHEDULED_TASK_BLOCKED'`，`item_key` 前缀 `scheduled-task:`，`target_url` 为 `/scheduled-tasks/{id}`，`change_key` 取 occurrence 的 `revision`。不新开第二条轮询通道，也不与 N05 提醒的去重键混用。

**一个已知的中间态。** 触发是「先建 Task、再准入 Delegate」两步。如果计划在两步之间被暂停、或 Delegate 的准入不通过，会留下一个已经 `READY` 但从未启动的 Task，同时该次触发记 `BLOCKED` 并带原因。这是刻意的：不删除已落库的任务，也不假装它没发生——用户可以在任务列表里直接处理或取消它。

**证据（如实分层）。** 见[测试计划 §37](../testing/verification-plan.md#37-周期定时启动任务验收规格2026-10-18)与统一功能验收表。真实 Windows 窗口、安装态与多实例并发未验。

### 10.95 撤销项目归档（2026-10-18 源码实现，迁移无）

| 端点 | 命令 | 状态码 | 请求体 | 回执结果 |
|---|---|---|---|---|
| `POST /projects/{project_id}/unarchive` | `UnarchiveProject` | `200` | `{command_id, expected_revision}` | `{project_id, revision, archived_at: null, archive_status: "ACTIVE"}` |

**只写一列。** 撤销把 `projects.archived_at` 写回 `NULL`，不恢复任何下游事实：归档成立的前提本来就没有活动 Task/Run/租约与未结算外部效果，所以撤销只是让既有读侧栅栏重新放行，不补写 Project State、不重开 Task，也不假装归档期间发生过事情。与归档共用 Project 排他锁与 `expected_revision` CAS；陈旧基线 `409 REVISION_CONFLICT` 带出 `actual_revision`。

**已是 ACTIVE 不造修订。** 若读到的 `archived_at` 已是 `NULL`，如实返回当前事实且**不推进** `revision`（与 `reopenAssistSession` 同一口径）；同 `command_id` + 同载荷重放返回原回执并附 `command-replayed: true`，换载荷 `409 COMMAND_ID_REUSED`。跨 Workspace `404 RESOURCE_NOT_FOUND`。

**审计。** 同一事务写 `activity_records`（`event_type='PROJECT_UNARCHIVED'`，`fact_refs` 记原归档时刻与前后修订），`PROJECT_ARCHIVED` 行不改不删。

**界面。** 项目详情的归档按钮单击即发（撤销条替代确认框，工作台 §13.2）：成功后浮层给「已归档这个项目 · 撤销」；撤销用**新的** `command_id` 与归档回执推进后的修订，成功后把项目读回进行中范围并撤掉就地回执。撤销失败升级为停留到关闭的 Notice，并指向「已归档」范围。**Breaking Change: No**。

**证据（如实分层）。** 真实临时 PostgreSQL：`project-archive.integration.test.ts` **14/14**（新增两条：撤销写回 NULL、推进修订、同命令重放、已 ACTIVE 不推进、陈旧基线零写入、活动范围重新放行、两条审计并存；跨 Workspace 404 且仍保持归档）；工作台 `projectArchiveLive.spec.ts` **4/4**（归档单击即发＋撤销发出第二发且修订取回执）与 `listViewCopy.spec.ts` 归档回执用例。真实 Windows 窗口未验。

### 10.96 Workspace 默认工作目录（2026-10-19 后端实现）

下列路径均位于 `/workspaces/{workspace_id}` 下，**Breaking Change: No**。

| 端点 | 命令 / 结果 |
|---|---|
| `GET /default-working-directory` | 只读 `{resource_id, canonical_root, display_name, write_tier, default_write_tier, status, reason, revision}`；`status` 为 `UNSET / READY / UNAVAILABLE` |
| `POST /default-working-directory` | `SetWorkspaceDefaultDirectory`，请求 `{command_id, expected_revision, resource_id}`，200 回执 `{workspace_id, resource_id, revision}` |
| `POST /default-working-directory/clear` | `ClearWorkspaceDefaultDirectory`，请求 `{command_id, expected_revision}`，200 回执同上，`resource_id=null` |
| `POST /default-write-tier` | `SetWorkspaceDefaultWriteTier`，请求 `{command_id, expected_revision, default_write_tier}`，200 回执 `{workspace_id, default_write_tier, revision}`；档位语义见 §10.110 |

未设置时修订为 `0`，其余投影字段为 null；首次设置或清除后修订递增，清除不删除配置行、不重置修订。设置只引用已经登记的受管资源，不调用 Open、不建立项目/连接/策略、不扩大权限。资源跨 Workspace 返回 404；停用、项目归档、活动重叠根、真实目录不可访问或路径身份变化返回 409，保留旧设置。陈旧修订返回 `409 REVISION_CONFLICT`；**例外**：请求值已等于当前值（同一 `resource_id`，或两者都为 `null`）时按已达成处理，返回当前事实且不改修订——打开目录可能已顺手登记同一个值，重复声明同一件事不算冲突（2026-10-19）。同命令同载荷返回原回执，即使后来已清除或目录已失效；同命令异载荷返回 `409 COMMAND_ID_REUSED`。并发首次请求复用原回执，并发不同命令以配置修订收敛。丢响应时按原 command_id 核对，不换 ID 重发。

`GET` 不修复配置；失效时返回 `UNAVAILABLE` 与原因 `RESOURCE_UNAVAILABLE / RESOURCE_DISABLED / PROJECT_ARCHIVED / RESOURCE_OVERLAP / DIRECTORY_UNAVAILABLE / DIRECTORY_IDENTITY_CHANGED`。可见资源仍返回原目录与档位；缺本目录档位记录时投影为 `READ_ONLY`，不因此创建任何权限事实，实际动作仍经原 Gateway 准入。

`POST /working-directories/open` 在 `READY` 且工作区**尚无**默认目录时，于同一事务内把该资源登记为默认（修订从 `0` 起递增），因此「打开过一次目录」即完成配置，不必再去设置页操作；已有默认目录时打开别的目录不覆盖它，`AMBIGUOUS` / `NOT_READY` 一律不登记（2026-10-19 用户要求「基础能力不该让开发者自己配置」）。

`CreateAssistSession` 仅对无 Project/Task 的普通 AGENT 在同一创建事务内继承有效默认目录，并保存资源所属 Project 与来源；显式 Project/Task、ASSISTANT、LEARNING 不继承。失效默认不阻断普通会话创建，也不猜其他根。创建命令回执保持既有形状；`GET /assist-sessions/{id}?include_context=true` 的 `context.working_directory` 增加可空 `source`：`USER_PICKED / WORKSPACE_DEFAULT / null`（历史未知）。显式绑定改为 USER_PICKED，分叉保留原来源，重设或清除默认不改历史会话。

前端设置入口（设置 › 基本设置）、建会话后的上下文读回与来源标签已接入；该增量不代表日常桌面配置流程整体交付，安装态、真实 Windows/WebView2 与真实 Provider 仍未验。相关运行结果只归统一功能验收表。

### 10.97 资料归档与记忆规则停用的反向命令（2026-10-19 后端实现）

均在 `/workspaces/{workspace_id}` 下，请求 `{command_id, expected_revision}`，返回 200 命令信封。**Breaking Change: No**；无数据库迁移。

| 端点 | 命令 | result |
|---|---|---|
| `POST /knowledge/{id}/unarchive` | `UnarchiveKnowledge` | `{knowledge_id, revision, status: "ACTIVE"}` |
| `POST /memories/{id}/reactivate` | `ReactivateMemory` | `{memory_id, revision, status: "ACTIVE"}` |
| `POST /rules/{id}/reactivate` | `ReactivateRule` | `{rule_id, revision, status: "ACTIVE"}` |

这些是[工作台 §13.2](../frontend/workbench-design.md#132-危险操作的两条通道2026-10-18)的前向补偿命令：调用者使用新 command_id 与正向回执的 revision，不能重用归档/停用命令 ID。命令只将 ARCHIVED/RETIRED 恢复为 ACTIVE，递增根 revision 与 updated_at，不改正文、当前版本指针、确认主体或记忆有效期；不删除原命令回执和已有待核对候选，也不修改 Decision 或恢复任何外部权限。Memory 即使恢复 ACTIVE，已过期版本仍按原过滤规则排除；不可用来源也不会因恢复状态变得可读。

共用 Information 写入口，先取 Workspace authority UPDATE、按原根与 Project 归档栅栏核对。跨 Workspace 404，Project 已归档 409，陈旧 expected_revision 为 `409 REVISION_CONFLICT`。同命令同载荷及并发首次请求返回原回执，即使随后又被停用；同命令异载荷返回 `409 COMMAND_ID_REUSED`。已 ACTIVE 且修订匹配则返回当前事实，不递增任何修订、不重复审计。

成功变更与命令回执、审计同一事务提交。Knowledge/Memory 恢复递增 context_revision；Rule 恢复同时递增 rule_revision/context_revision，既有 Run 下一动作仍按原栅栏核对，不回退已发生效果。审计事件为 `KNOWLEDGE_UNARCHIVED / MEMORY_REACTIVATED / RULE_REACTIVATED`，只记录身份、版本、状态和前后修订。

本节最初仅交付后端，撤销条与永久恢复入口随后于同日接续（见下）；连接/资源停用的反向命令、权限撤销及 Decision 替代不在本片范围。运行成绩归统一功能验收表。

**2026-10-19 前端接续**：`KnowledgeView` 已接三条命令——正向归档/停用成功且回执核对通过后给「已归档资料 / 已停用记忆 / 已停用规则 · 撤销」，撤销用新 `command_id` 与正向回执的 `revision`；同一批反向命令也作为永久恢复入口，在对象详情里用**当次读回**的 `revision` 提交。客户端对回执核对 `command_id`、目标 ID、`status:"ACTIVE"` 与 `revision ≥ expected_revision` 四项，任一项不成立按「结果不明」处理，不承诺成功。

### 10.98 长期记忆有效状态与筛选（2026-10-19 后端接续）

`GET /workspaces/{workspace_id}/memories` 新增可选查询参数 `effective_status=ALL|ACTIVE|EXPIRED|RETIRED`，缺省 ALL。可与既有 `project_id` 组合：项目范围仍包含 Workspace 全局记忆与指定 Project，不含同 Workspace 的其他 Project；跨 Workspace 的 Project 参数返回 404。非法枚举值返回 422，其余信息类型不接该参数。响应继续为原数组，不引入新分页/信封形状。

列表和 `GET /memories/{id}` 的对象增加只读 `effective_status`，原持久 `status` 仍为 ACTIVE/RETIRED：

| effective_status | 数据库读取时的判定 |
|---|---|
| RETIRED | 根状态 RETIRED，优先于有效期 |
| EXPIRED | 根未停用，当前版本 expires_at 非空且小于或等于数据库 now() |
| ACTIVE | 根未停用，当前版本无到期时间或 expires_at 大于数据库 now() |

根状态、当前版本正文/确认/到期字段、有效状态与筛选在同一 SQL 快照读取，时间口径与既有搜索和 Context 的过期排除一致。时间流逝只影响投影，不写根状态、不递增任何 revision、不产生版本或审计；默认全部列表仍可用于管理和永久恢复。历史 revisions 不增加动态状态，保留不可变内容。

恢复过期 Memory 只恢复持久状态，effective_status 仍为 EXPIRED；续期或取消到期必须通过既有 AddMemoryRevision，明确确认并产生新版本。ACTIVE 只表示当前生命周期与有效期符合，不保证项目/权限可用或必定进入模型 Context；读取与选取仍按原作用域和权限核对。

**Breaking Change: No**。新增可选参数和响应字段，旧列表默认行为与原字段保持；无 migration。前端状态呈现与筛选已接线（[工作台 §13.3](../frontend/workbench-design.md#133-长期记忆状态与筛选2026-10-19已确认前端已接)），真实浏览器与 Windows 未验，运行结果只归统一验收表。

### 10.99 长短期记忆接口（2026-10-19）
均位于 `/workspaces/{workspace_id}`，**Breaking Change: No**。新增端点；原消息、Memory CRUD 与历史接口保留。命令遵循原 command_id 回执与同 ID 异载荷 409 协议。

| 端点 | 请求与结果 |
|---|---|
| `GET /memory-settings` | `{workspace_id, revision, recall_enabled, automatic_compaction}`；缺配置为修订0、两个开关 true，GET 零写入 |
| `POST /memory-settings` | `{command_id, expected_revision, recall_enabled, automatic_compaction}` → 200 同形结果；修订 CAS |
| `POST /assist-sessions/{session_id}/messages/{message_id}/memories` | `{command_id, expected_session_revision, content_sha256, project_id, title, text, confirmed:true, expires_at?}` → 201 原 CreateMemory 结果；原消息须 completed、正文 hash 匹配；范围为全局 null 或原会话 Project，跨范围404 |
| `GET /memories/{id}/provenance` | `{memory_id,sources:[{memory_version,session_id,message_id,content_sha256}]}`；明确保存的不可变来源，手工创建可为空 |
| `GET /assist-sessions/{id}/memory` | `{session_id,session_revision,revision,remember,cleared_through_seq,checkpoint,requests}`，no-store；checkpoint 含 id/available/through_seq/summary/model_call_id/created_at/source_message_ids/sources，失效时 summary=null、足迹为空；requests 最近20条，仅公开状态/错误/控制/覆盖边界/调用身份/时刻 |
| `POST /assist-sessions/{id}/memory/compact` | `{command_id,expected_revision}`（会话修订）→ 202 `{session_id,request_id,status:"PENDING"}`；回执只表示受理，完成看 GET；有活动整理时复用请求，不产生平行调用 |
| `POST /assist-sessions/{id}/memory/requests/{request_id}/cancel` | `{command_id}` → 200 `{session_id,request_id,status,cancel_requested}`；PENDING 直接 CANCELLED，RUNNING 仅持久取消意图，安全结算前仍在运行 |
| `POST /assist-sessions/{id}/memory/clear` | `{command_id,expected_revision,expected_session_revision}` → 200 `{session_id,revision,session_revision,remember,cleared_through_seq}`；expected_revision 是工作窗口修订 |
| `POST /assist-sessions/{id}/memory/remember` | 同 clear 加 `remember:boolean`；每次控制都建立新窗口边界，实际切换时会话修订也递增；false 只发送当轮用户消息，不召回长期记忆；重新开启不吸收关闭期间轮次 |
| `GET /assist-sessions/{id}/messages/{message_id}/memory` | `{session_id,message_id,recorded,available,checkpoint_id,sources}`；读取本轮直接与传递使用足迹，重检后只返回安全来源身份，失效内容不回显 |

原 `POST /assist-sessions/{session_id}/chat-commands` 现接 `/compact` 与 `/压缩`，202 信封 result 为 `{kind:"MEMORY_COMPACTION",system:"compact",session_id,request_id,status:"PENDING"}`，沿同一 RequestMemoryCompaction Owner 与回执；无 expected_revision 的文本命令在会话锁内决定当前基线，重放不重新猜基线。原 /clear 与 /new 继续表示新建会话，不改成清除工作窗口。菜单选择/解析本身仍不执行动作，前端需接线后发送才生效。

短期写控制只支持有效 AGENT 会话，归档 Project/会话、跨 Workspace、旧修订或在途消息/整理分别按原404/409栅栏处理；手动整理需先等待或停止在途消息，过短历史409。清除只改变模型后续工作窗口，不删聊天/工具历史，不删除长期事实。长期来源引用阻止物理删除源会话；活动整理同样阻止删除，完成后的短期子记录可随会话清理。

已受理但尚未领取的整理，如果会话/Project 随后归档，Worker 以 `FAILED/MEMORY_SCOPE_CHANGED` 收敛且不调用模型，不让无效范围的 PENDING 请求永久挡住管理；该整理仍可通过取消命令提前收敛。

普通聊天自动召回最多3条、合计8000字符，与手工资料合计最多20来源；仅同 Workspace 全局与当前 Project、当前有效已确认版本。按有界字面匹配排序，零匹配时近期回退，消息 sources 附 `selection=AUTO_MEMORY`、`selection_basis=LITERAL_MATCH|RECENT_CONFIRMED`，不是语义向量召回。关闭或来源失效时，历史自动来源与依赖该来源的旧摘要/答复不能匿名回流。

普通聊天自动整理在已结算增量达到32条消息或48000 UTF-8字节时申请，保留最近8条原文；此为应用工程阈值，不是模型物理窗口。整理和普通生成均有128000字节工作输入上限，实际端口另查 token/预算。失败保留旧检查点和原文，同一覆盖边界自动失败不立即反复重试，可显式重新整理。typed errors 包括 `MEMORY_CONTEXT_TOO_LARGE / MEMORY_HISTORY_LIMIT / MEMORY_SUMMARY_INVALID / MEMORY_PUBLICATION_REJECTED / MEMORY_SOURCE_CHANGED / MEMORY_UNRESOLVED_TOOL_STATE / MEMORY_WORKER_LOST`，不可作为成功或自动换模型依据。

整理请求冻结工作模型身份，使用既有 model_calls 与会话预算；call 以最后一条被覆盖的真实 assistant 消息作 ASSIST 计量锚点，整理请求的 model_call_id 区分用途，不修改原消息 usage。摘要严格 JSON `{summary}`，成功提交后才更换窗口；租约、取消、来源、权限/上下文/配置及窗口修订变化拒收迟到结果。未结算工具链不整理、不重放工具。真实 Provider 摘要质量、模型窗口与缓存效果须单独验证。

### 10.100 模型端口的图片输入能力投影（2026-10-19）

**Breaking Change: No（`GET /model-port` 响应新增字段）。** 响应新增 `image_input`，取值 `SUPPORTED | DECLARED | MODEL_LACKS_IMAGE_INPUT | MODEL_NOT_IN_CATALOG | NOT_CONFIGURED | UNKNOWN`，以及 `image_input_source`（`CATALOG | DECLARED | ENV | NONE`）说明这次结论来自哪一层：

| `image_input` | 含义 | 发送图片命令的结果 |
|---|---|---|
| `SUPPORTED` | 模型目录条目明确 `image_input=true`（source `CATALOG`） | 放行 |
| `DECLARED` | 目录无条目，声明表（source `DECLARED`）或 `RELAY_MODEL_IMAGE_INPUT=true`（source `ENV`）声明支持 | 放行 |
| `MODEL_LACKS_IMAGE_INPUT` | 目录条目存在但 `image_input` 非 true（source `CATALOG`），或声明表明确声明不支持（source `DECLARED`） | 422 `VALIDATION_FAILED`，`field=attachment_ids` |
| `MODEL_NOT_IN_CATALOG` | 目录无条目且无任何声明（source `NONE`） | 同上 |
| `NOT_CONFIGURED` | 实例未配置真实模型端口（`provider=fake`） | 同上 |
| `UNKNOWN` | 本次读不到模型目录（数据库不可用） | 未知；闸门届时仍按实际目录裁决 |

**判定四层，顺序不可换**：目录条目 → 声明表 → `RELAY_MODEL_IMAGE_INPUT`（兼容期）→ 拒绝。目录是唯一准绳，人的声明不能把目录判定为不支持的模型改成支持；声明只补「目录里没有这个自建模型」这一处空白。判定实现在 `apps/api/src/application/chat-image-input.ts`，闸门与投影共用同一函数。

**声明端点**（实例级配置，不是业务命令）：

| 端点 | 语义 |
|---|---|
| `GET …/model-capabilities` | `{items:[{provider, source_model_id, image_input, note, declared_at, updated_at}]}` |
| `PUT …/model-capabilities/{provider}/{source_model_id}` | `{image_input, note?}` → 200 同形行。`provider` 仅接受 `openai-compatible`；`note ≤ 500` 字符，超长 422 不截断。同键再写是覆盖（last-writer-wins） |
| `DELETE …/model-capabilities/{provider}/{source_model_id}` | → `{removed: boolean}`。撤销声明回到「未声明」，不是记成「不支持」 |

**为什么没有命令回执**：一次声明没有状态机、没有修订，重发同体必然得到同一状态；回执要保护的是「同一命令是否已生效」的歧义，这里由 GET 直接回答。沿用 `/model-catalog/refresh` 的实例级先例。声明写入后**下一次读取立即生效**，不需要重启进程——这是它相对环境变量的全部价值。

旧服务端不返回 `image_input`/`image_input_source` 时，本仓客户端按 `UNKNOWN`/`NONE` 处理（不提前提示，也不冒充可用）。

验证：纯判定单测 `chat-image-input.test.ts` 5/5（四层优先级、声明压过环境变量、目录压过声明）；真实 PG/HTTP 集成 `model-capabilities.integration.test.ts`（声明前拒绝 → 声明后 `DECLARED` → 撤销回拒绝；声明为不支持压过环境变量；`fake` 与超长 note 422）；`model-port.integration.test.ts` 已同步新字段断言；工作台侧见[工作台 §33.2](../frontend/workbench-design.md)与 `tests/composerImageAttachments.spec.tsx`、`tests/browser/attachmentHoverPreview.spec.ts`。

### 10.101 连接与权限沿用复制（2026-10-19 后端实现）

**Breaking Change: No（新增端点）。** `POST /projects/:project_id/gateway-settings/copy`，命令 `CopyGatewaySettings`，HTTP 201。

- **Body**：`{ command_id, source_project_id }`（均为 UUID，`additionalProperties: false`）；路径参数 `project_id` 是**目标**项目。
- **行为**：把来源项目登记的受管资源（ACTIVE）、连接（ACTIVE，含 `config` 边界与能力集合）与 ACTIVE 权限策略（**当前生效版本**的 capability/action_type/target_prefix/decision/max_payload_bytes）复制进目标项目，一个命令事务内完成，回执与业务事实同事务提交。文件族策略的 `target_prefix`（canonical_root）依赖同事务里先复制的资源行。
- **判重（跳过并计入 `skipped`）**：资源按 `identity_key`；策略按 capability+action_type+target_prefix；连接按「ACTIVE 且 config 与能力集合都相同」。判重只防用户连点类重复，语义幂等仍由 command_id 回执承担。
- **不复制**：DISABLED/REVOKED 行、策略历史版本；来源项目只读，目标项目已有其它配置不动。
- **Result**（全字符串）：`project_id` / `source_project_id` / `resources_created` / `connections_copied` / `policies_copied` / `skipped`。
- **错误**：`source_project_id === project_id` → 422 `VALIDATION_FAILED`（field=`source_project_id`）；来源项目不存在或不属于同一 Workspace → 404 `RESOURCE_NOT_FOUND`；任一项目已归档 → 既有归档守卫拒绝。资源登记走与 `CreateManagedResource` 同一把 advisory 事务锁（7162,9）串行。
- **动机与边界**：连接/策略按项目登记（`project_id NOT NULL`）是 authority 链与审计的基础，本命令只消掉「每项目重配一遍」的重复劳动，**不**把 `project_id` 改为可空。前端入口归[工作台 §32.10](../frontend/workbench-design.md)。

验证：真实临时 PG 集成 `test/integration/gateway-settings-copy.integration.test.ts`（复制落库、判重、同 command_id 重放、只复制 ACTIVE、来源=目标与跨 Workspace 拒绝）。前端入口与验证要求见专用提示词（交付时给出）。

### 10.102 排队消息的插话（2026-10-19 源码实现）

2026-10-20 接续，**Breaking Change: No**，路径、请求、回执与 DTO 不变。生成方增加工具派发边界检查：新插话可阻止旧批次尚未执行的工具，模型收到明确的未执行结果后重新判断方向；已执行结果保留。连续插话的时序和理解规则归[运行架构 §2.9](../architecture/runtime-context.md#29-排队消息的插话进入上下文的方式2026-10-19已实施)，当前验证成绩归统一验收表，下文验证段保留初版范围。

**Breaking Change: No（新增命令与只读字段）。** `POST /assist-messages/:message_id/steer`，命令 `SteerAssistMessage`，HTTP 200，与 `/cancel` 同形（`{ command_id }` → `{ command_id, committed_at, result: { message_id, status } }`，`status = "STEER_REQUESTED"`）。

- **语义**：把一条**排队中**（`PENDING`）的回复并入当前正在生成的那一轮，而不是等这一轮结束后另起一轮。命令只持久化意图（`assist_messages.steer_requested = true`）；真正消费由生成方在下一次模型请求前完成（`drainSteerRequests`），并把该行收口为 `CANCELLED` + `error_code = 'STEERED'`。上下文位置与上游对照见[运行时上下文 §2.9](../architecture/runtime-context.md#29-排队消息的插话进入上下文的方式2026-10-19已实施)。
- **受理条件**（任一不满足即拒绝，且**不改**任何状态）：消息存在且属于本 Workspace（否则 404 `RESOURCE_NOT_FOUND`）；会话是普通 `AGENT`（助手档/学习档不排队）；消息 `role=ASSISTANT` 且 `status=PENDING`（`RUNNING` 与终态都拒绝）；会话里确实存在 `RUNNING` 的回复（否则「插话」等于把一条还没开始的消息取消掉）；这条排队消息对应的用户原文没有图片附件（插话通道只送原文）。
- **幂等**：同一 `command_id` 重放拿回原回执；不同 `command_id` 对同一条已置位的行再请求仍返回 `STEER_REQUESTED`（置位本身是幂等的）。
- **迟到窗口**：意图已落库、那一轮恰好结算 → 意图留在行上，这一行随后按普通排队被领取（`claimNextPendingMessage` 在同一句里清零该列），消息照常得到自己的回复，不丢不重复。
- **只读投影**：消息 DTO 新增 `steer_requested: boolean`（`AssistMessageDto`，`strict`）。被消费的 `CANCELLED/STEERED` 行**不出现**在 `GET /assist-sessions/:id/messages` 的结果里，也不进入 `history()`：它不是一轮回复，只是一条没有答案的占位行；用户原文仍作为真实 USER 消息返回。
- **取消仍优先**：`cancel_requested = true` 的行不会被插话消费。
- **与「排队」的关系**：不插话时行为逐字不变——发送仍返回 202，回复按提交顺序逐条生成。

验证：真实临时 PG 集成 `agent-conversation-main-loop.integration.test.ts`（插话在下一轮模型请求前进入上下文、工具结果保留、只多跑一步不另起一轮、排队行收口为 `CANCELLED/STEERED` 且不出现在消息列表、没有在途回复时明确拒绝）；模型消息顺序单测 `assist-steer-context.test.ts` 3/3；工作台侧 `tests/assistQueueSteer.spec.ts` 3/3，交互规则见[工作台 §39](../frontend/workbench-design.md#39-排队消息的插话手势2026-10-19-已实施)。

### 10.103 目录打开结果中的 Git 只读投影（2026-10-20 源码实现，迁移 0124）

**Breaking Change: No（结果新增可选字段）。** `POST /working-directories/open` 的 `result` 增加 `git_read: { state, repo_root, detail }`。

- **为什么放在打开目录这一步**：显式选择目录已经表达了对「这个目录」的读取授权（§10.86 的本地读取配置），Git 的 status/diff/log 读的是同一份工作区事实。此前 `planToolLoop` 只在项目里已存在 `GIT_READ` 连接时才给出 Git 工具，等于要求用户为同一个目录再手工登记一次连接与三条策略。
- **自动配置的范围**：只有被打开的目录**就是 Git 仓库根**时，才建立一条 `GIT_READ` 连接（`root_path` = 该根）与 `GIT_STATUS` / `GIT_DIFF` / `GIT_LOG` 三条 `AUTO` 策略，并把这些指针记进 `local_directory_access`（`git_connection_id` 与 `policy_ids` 的 `GIT_*` 键）。stage/commit/push 属于 `GIT_WRITE`，**不**随目录选择开放。
- **子目录不授权**：被打开的目录若是仓库子目录，`state = REPO_ROOT_REQUIRED`，`repo_root` 给出仓库根，**不**建连接也不建策略。理由是可证明的越界：`git log` 在子目录里仍返回整个仓库的历史与分支，按子目录授权等于把父目录的信息一并放出去。界面在原地提供「在仓库根打开」，由用户自己决定是否扩大作用域。
- **不自动恢复**：连接被停用 → `DISABLED`；策略被撤销或改成 `DENY`、或历史上明确设置/撤销过同一根 → `REVIEW_REQUIRED`。这两种都只报告，不新建一条连接绕过。
- **其他状态**：不是仓库（或本机没有可用 git）→ `NOT_A_REPOSITORY`；目录未就绪（归档、停用、歧义）→ `NOT_CHECKED`（「还没看」不能写成「不是仓库」）。
- **工具侧的双根隔离**：`GIT_READ` 的连接匹配改为**精确根**（`connectionRootCovers(..., exactRoot=true)`），文件能力仍按前缀。否则仓库根的连接会覆盖同项目下的子目录资源，而 Git 的输出并不受该子目录限制。
- **回放兼容**：字段为可选，0124 之前写入的 `OpenWorkingDirectory` 回执重放时照样合法；旧服务端不返回该字段时前端落为 `null`（未核对）。
- **数据**：`local_directory_access.git_connection_id` 只是应用的管理指针，不构成授权；准入事实仍是 `gateway_connections` 与 `gateway_permission_policies`。

验证：真实临时 PG 集成 `test/integration/local-directory-access.integration.test.ts` **8/8**：LA-11–LA-15（仓库根自动配置并复用同一条连接、不开放 `GIT_WRITE`、子目录只报仓库根、普通目录如实报告、撤销/停用后不自动恢复），**LA-16 端到端**——真实 `git init` 仓库 + 真实准入链：打开目录后 `GIT_STATUS` 读到真实分支 `main` 与未跟踪 `note.txt`、`GIT_DIFF` 读到真实改动、`gitGetLog` 读到真实提交，撤销 `GIT_DIFF` 策略后换一个 path 再读被权限类错误拒绝（同一 path 再读命中确定性动作身份，属于已结算结果的重放，不作为授权证据）；`tool-loop` 集成 **45/45** 未因「精确根」改动回归（其夹具的连接根与受管根相同）；根匹配单测 `test/unit/conversation-execution.test.ts`。产品行为归[工作台 §41](../frontend/workbench-design.md#41-日常操作减负工具状态与高级配置分层2026-10-20-已实施实机未验)。

### 10.104 插件运行时状态（2026-10-20 源码实现）

**Breaking Change: No（新增只读端点）。** `GET /plugins/status`（Workspace 作用域，`Cache-Control: no-store`）。

- **回答什么**：三个内置插件（`computer` / `browser` / `github`）在这台机器上**能不能跑**：`state ∈ READY | NOT_INSTALLED | NOT_PAIRED | NOT_AUTHENTICATED | UNAVAILABLE`，附 `detail` 与可行动的 `remediation`。
- **不回答什么**：项目级授权。那仍由 `GET /projects/:id/connections`（连接登记）与策略版本回答。两者分开，界面才能只说缺的那一步——把「未登录」写成「未授权」会让用户去错地方补配置。
- **来源**：`computer` 读运行时模式与随包可执行文件（`RELAY_COMPUTER_RUNTIME`）；`browser` 复用 Worker 写下的后端投影（`readBrowserBackendState`，六态映射成同一套词表）；`github` 依次执行 `gh --version` 与 `gh auth status`（8 秒超时，显式环境白名单，不转发任何 Relay 进程里的凭据）。
- **2026-10-21 补**：探测用的子进程环境与实际 GitHub 适配器**共用同一份白名单**（`github/gh-env.ts`），含 `APPDATA`/`LOCALAPPDATA`——Windows 上 `gh` 的登录凭据在 `%APPDATA%\GitHub CLI\hosts.yml`，少这两个键时 `gh` 连自己的凭据文件都看不到，会把已 `gh auth login` 的用户报成「未登录」（实测：带 `APPDATA` 时 gh 读出凭据文件里的账号，去掉后它说「没有登录到任何 GitHub 主机」）。`NOT_AUTHENTICATED` 的 `detail` 也随之分两档：「当前没有登录」（没找到凭据）与「已找到登录凭据，但当前这份凭据不可用」（找到但失效/权限不足），两者的 `remediation` 不同。
- **边界**：只读探测，不启动浏览器、不触发电脑动作、不改任何配置、不返回凭据。探测失败一律折成可说明的状态，不抛 500。

验证：工作台 `tests/composerAttachMenu.spec.tsx` 的插件详情用例（运行时与授权分开呈现、无项目归属时只说「需要项目归属」、重新检测只重读状态）。真实 `gh` 登录态、真实浏览器后端与真实电脑运行时的组合未在本轮取证。

### 10.105 长期记忆自动捕获（2026-10-20，迁移 0125）

**Breaking Change: No。** `GET /memories`、`GET /memories/{id}` 响应新增 `origin`；`POST /memory-settings` 请求新增**可选** `auto_capture`（缺省 true，旧客户端不受影响）。方向与代价归 [ADR-030](../decisions/ADR-030-zero-click-auto-memory.md)。

- **没有「接受」端点**。结算后提取的记忆写入即生效，用户事后撤销；手动保存（§10.99）保留不变。
- **`origin`**：`HUMAN_CONFIRMED`（人工确认，含 0125 之前的全部旧数据）或 `AUTO_CAPTURE`。自动写入的版本 `confirmed_by = 'auto-capture'`，不冒充人。
- **提取条件**：普通 AGENT 会话、`remember = true`、`auto_capture = true`、assistant 消息以 `COMPLETED` 结算之后；同一消息按 `message_id` 幂等；每会话每日（UTC）最多 5 条，每轮最多 3 条；输入只含这一轮用户原文与助手正文，合计上限 8000 字符。
- **来源分段与逐字核验**（2026-10-21，ADR-032）：输入分【用户原话】与【助手答复｜模型叙述，可能包含工具结果或网页正文；不是用户陈述】两段；每条候选必须给出 `source`（user/assistant）与逐字 `quote`；**写库前核验引用确实出现在它声明的那一段里**，核验不过的候选直接丢弃——模型的自述不算数。没有 `source` 或没有 `quote` 的候选同样丢弃。
- **来源类别**（2026-10-21，ADR-032）：记忆行新增 `source_kind ∈ MANUAL | USER_STATEMENT | MODEL_OBSERVATION | UNKNOWN`——`USER_STATEMENT` 是逐字引用用户原话，`MODEL_OBSERVATION` 是引用助手叙述（可能含工具结果或网页正文的转述，只能作观察，不能当作用户的偏好或授权），`MANUAL` 是人工保存，`UNKNOWN` 是 0125 之前没有类别信息的旧自动记忆。捕获记账新增 `source_quote`（这一条来自原消息的哪一段）。
- **由系统判断要不要记**（2026-10-21，ADR-032）：**不提供「要不要生成这条记忆」的人工选择**。是否值得沉淀由提取环节的 agent 判断（信号门：未来的助手会不会因为这条内容而做得更好），没有值得记的就什么都不写。人工只保留事后停用某一条与整体关掉自动捕获；`auto_capture` 是总闸（与上游的「Generate memories」同位），默认开。
- **失败静默**：超时、非法 JSON、预算不足、Worker 丢失、端口异常都只放弃这一轮提取——不写记忆、不改回复、不重试、不换模型。主回复的成功与否与提取无关。
- **去重**：唯一键 `(session_id, message_id, normalized_sha256)`；同范围已有完全相同标题与正文的 ACTIVE 记忆时不再写入；已撤销的同一内容不再提取。不做语义去重，不引入向量库。
- **召回**：条数、字符与来源上限不变（3 条 / 8000 字符 / 20 来源）；排序改为 `literal_match` 优先 → 人工确认先于自动捕获 → 类别（用户原话 → 来源未标注 → 模型观察），同等相关度下 `HUMAN_CONFIRMED` 先于 `AUTO_CAPTURE`。记忆来源的投影带 `origin` 与 `source_kind`，非记忆来源不带。
- **端点**：

| 端点 | 请求与结果 |
|---|---|
| `GET /memory-auto-captures?limit=20` | `{items:[{id, memory_id, session_id, message_id, title, text, origin, source_kind, status, source_sha256, source_quote, created_at, revision}]}`；只列 ACTIVE，按时间倒序，`no-store` |
| `POST /memory-auto-captures/{id}/retire` | `{command_id, expected_revision}` → 200 `{capture_id, memory_id, status:"RETIRED", memory_status:"RETIRED"}`；同一事务内停用 Memory 根、记 `decided_at`/`decided_by`、保留版本与来源 |

- **撤销语义**：停用而非删除，保留审计；已撤销的自动记忆不再参与召回；再次撤销按 409 拒绝；`expected_revision` 落后 409 并回执两个修订。
- **与短期窗口的关系**：提取在结算之后、独立模型调用；不改变 checkpoint、不进入工作窗口、不计入消息 usage。

### 10.106 规则键可由服务端生成（2026-10-20 源码实现）

**Breaking Change: No。** `POST /rules` 请求体的 `rule_key` 由必填改为**可选**；不传时服务端生成稳定唯一键。`POST /rules/{id}/versions` 的 `rule_key` 仍是必填（版本沿同一条规则的身份）。响应形状不变（`{rule_id, revision, version, status}`），回执与幂等语义不变。

- **生成规则**：缺省（或传空串）时取 `rule-<command_id>`。**按 command_id 派生，不用随机值**——同一 command_id 的重放必须算出同一份请求体，否则载荷哈希不一致，幂等重放会被判成 `COMMAND_ID_REUSED`；command_id 全局唯一，因此键也稳定唯一，创建后不再改变。
- **显式给出仍然生效**：值原样落库，不得裁剪或改写。跨范围同键的 HARD 覆盖与冲突判定（`resolveApplicableRules`）只按键比较，与键从哪来无关。
- **前端行为**：工作台在「范围与执行检查（高级）」里留一个可选输入（占位「留空由服务端生成」），普通入口只提交 `statement` 与 `strength`；见[工作台 §42](../frontend/workbench-design.md#42-日常减负第二轮资料规则任务起步与记忆呈现2026-10-20-已实施实机未验)。
- **验证**：工作台 `knowledgeSimplify.spec.ts` 4/4（省略时不发 `rule_key`、显式时原样发）；API 侧 `information.integration.test.ts` 末条覆盖「键 = `rule-<command_id>`、同 command_id 重放不新增规则、显式键保留」，**本机无 PG，未运行**。

### 10.107 会话剩余执行与操作工具族（2026-10-20 源码实现）

Breaking Change: **No**。既有会话执行请求及 applications 入口不变；候选 JSON 增加可选 `interaction: BROWSER | COMPUTER`（省略/null 沿原文件与检查路径）。未知值校验失败，不静默丢弃。读取投影保留该字段；现有前端按标题、目标及 `auto_start` 消费，不新增手工建任务步骤。

- interaction 仅表达工具需求，按当前项目 ACTIVE 连接冻结对应 Run 工具；浏览器/电脑连接不要求 root_path。文件、Git、CLI 的根匹配与允许清单不变。
- 不产生隐式 COMPUTER_INPUT / BROWSER_ACTION / BROWSER_COMMIT 范围授权；提交/上传仍经原单动作审批。项目或目录缺失的会话仍不能进入该入口。
- 会话已成功直写后，如仍需检查，候选使用 writes_files=false、file_changes=[] 与原结构化 check；不重复声明已完成修改。ASK 写与 AUTO 删除由原 Run 审批接续。
- 所需能力在登记 Task 前校验。缺连接返回既有 INVALID_TRANSITION 与具体能力原因，不留下无法委托的新 Task；无新增 migration。
- 会话删除预检返回 SESSION_WRITE_REQUIRES_RUN 时尚未创建 Operation，可提交剩余候选。已有 WAITING_APPROVAL / UNKNOWN 必须核对原 Operation，不能换候选绕过。

#### 10.107.1 服务端自动推进与失败原因投影（2026-10-20 第二轮，源码实现）

Breaking Change: **No**。端点、请求体与 `applications` 语义都不变；变化只有两处投影语义。

- **`auto_start` 改为阶段感知**：`decision=PREPARE` 且 `candidate_status=READY` 之外，还要求
  `status ∈ {READY, TASK_PREPARED}`。`FAILED`（推进失败）与 `DELEGATED`（已有 Run）不再为真。
  旧客户端把该字段当「可进入原应用入口」读，语义更严格但方向不变——不会因此多推进一次。
- **推进 Owner 由服务端持有**：`applications` 由 Worker 的
  `conversation-execution-autostart` tick 调用，复用请求行上固定的
  `task_command_id`/`ready_command_id`/`delegate_command_id`。人工再提交同一个
  `request_id` 仍只重放原回执；重复与迟到扫描不产生第二个 Task/Run。
- **失败原因写入原请求**：推进失败时 `status=FAILED`，`clarification.questions[0]` 承载具体原因
  （缺哪个能力/目录，或会话已有在途 Run），`candidate_status` 与 `candidate` 一律保留。
  因此读取投影的 `questions` 在 `PREPARE` + `FAILED` 时也**有内容**，客户端应把它当失败说明
  显示，而不是当成新的澄清问题。补齐前置条件后可用同一 `request_id` 继续（建 Task 阶段的
  状态 CAS 接受从 `FAILED` 前进）。
- 无新增端点、无新增 migration。前端不再需要任何自动推进逻辑；撤除的本设备偏好
  `relay.workbench.planExecution` 是浏览器本地键，不属于 HTTP 契约。

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
  但命令与词表照旧接受它，服务端返回该档时芯片仍读「只读」；菜单呈现口径归[工作台 §18.1.3](../frontend/workbench-design.md#1813-输入器的本目录写入档位2026-10-17)。
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

用户消息「回退文件」的后端入口。语义、交互与预算边界归[工作台 §27.3](../frontend/workbench-design.md#273-用户消息下的文件撤回按钮)，恢复 Owner 归[运行架构 §8.5](../architecture/runtime-context.md#85-消息发送前文件基线与恢复-owner)。**Breaking Change: No**：新增四个端点、消息投影两个字段与迁移 0132；既有端点不改变形状，旧消息没有撤回记录时 `withdrawn_at=null`、`recall=null`。

| 端点 | 请求 / 响应 |
|---|---|
| `POST /assist-messages/{message_id}/recall` | `{command_id}`；200 命令信封，`result` 为撤回回执；`outcome.replayed` 表示同一命令或同一消息的既有回执 |
| `GET /assist-messages/{message_id}/recall` | 200 撤回回执；不存在 404 `RESOURCE_NOT_FOUND`；只读，不重试也不推进状态 |
| `POST /assist-message-recalls/{recall_id}/undo` | `{command_id}`；200 命令信封，`result` 为撤销回执；单层，同一撤回至多一次 |
| `GET /assist-message-recalls/{recall_id}/undo` | 200 撤销回执；不存在 404；只读 |
| `GET /message-recall/settings` | 200 `{retention_days, capacity_bytes, per_file_cap_bytes, usage_bytes, snapshot_count, oldest_snapshot_at}`；只读 |

- **撤回范围**：目标用户消息及其后本会话关联、已确认 APPLIED 的文件效果，按路径归并到各自**最早写入前像**；直接会话写（`session_tool_calls` → `logical_operations`）与委派执行（`conversation_execution_requests` → Run → `change_set_files`）都计入。目标消息与其直接助手回复在终态同时写 `withdrawn_at`；原文、工具记录与原回复仍可读取。
- **只允许完成态**：消息须为 USER、`COMPLETED`、未撤回，会话 `ACTIVE`，存在直接助手回复，目标 seq 之后没有非终态消息/未结算工具调用/在途 Run。否则 409 `INVALID_TRANSITION`。首版方向为**沿对话向后**：目标 seq 必须大于所有已撤回用户消息的 seq，否则拒绝。
- **前像与预检**：前像在每次写入真正落盘前按消息采集、首写优先；`CREATE` 且此前不存在时可用「不存在」事实作基线。预检对每个路径比较当前态、最近一次已确认写入的期望态与基线态；任一 `CONFLICT`/`UNAVAILABLE`/`UNCERTAIN` 时整组不写，返回 409 `RECALL_PREFLIGHT_BLOCKED`，`conflict.recallPaths` 逐路径给出 `path｜status｜reason`。单文件前像上限 8 MiB（`MAX_MESSAGE_PREIMAGE_BYTES`），超限/读取失败/非普通文件只把该路径标为不可恢复，不改变原写入准入。
- **执行与终态**：首个恢复写入前按路径保存当前字节作为保护副本；保护副本不可用（含工作区快照预算占满）则整次撤回不执行并逐文件标 `SKIPPED`，不写半个回退。恢复经既有 `executeFileChangeset`（`contentBytes` 支持二进制），逐文件状态为 `RESTORED / ALREADY_RESTORED / CONFLICT / UNAVAILABLE / FAILED / SKIPPED`；回执状态为 `RUNNING / COMPLETED / PARTIAL / FAILED`。执行中首个失败后剩余路径标 `SKIPPED`，不继续写。
- **幂等与接续**：同一 `workspace_id + command_id` 重放原回执（`replayed=true`）；同一消息已有撤回时返回该回执；并发 RUNNING 返回 409 `RECALL_IN_PROGRESS`；RUNNING 心跳超过 60 秒（`RECALL_STALE_RUNNING_MS`）可按同一回执认领接续，不新建第二次撤回。过期 RUNNING 也挡新消息，按原回执重发即可续接。
- **单层撤销**：只接受 `COMPLETED` 且仍有保护副本的最近一次成功撤回；范围仅限该次实际 `RESTORED` 的文件。预检按「目标态＝保护副本态 / 期望态＝撤回结果态 / 其余＝冲突」三分，任一冲突或副本缺失即 409 `RECALL_UNDO_PREFLIGHT_BLOCKED` 且不写文件；并发 409 `RECALL_UNDO_IN_PROGRESS`；同一命令/同一撤回重放原回执。撤销是新的受控动作，不复活旧 Run、DONE、批准或 PASS，也不提供对撤销的再撤销。
- **快照设置**：`retention_days` 与 `capacity_bytes` 读取进程环境 `RELAY_MESSAGE_SNAPSHOT_RETENTION_DAYS` / `RELAY_MESSAGE_SNAPSHOT_BUDGET_BYTES`（默认 30 天 / 5 GiB）；`per_file_cap_bytes` 为 8 MiB；`usage_bytes` 统计该工作区前像＋保护副本的实际字节，`oldest_snapshot_at` 是可恢复时段的当前最旧快照。撤回/撤销入口会先触发**全局**过期清理（超过保留期且不被在途撤回/撤销引用）；容量占满时停止新增快照并如实降级，不删既有快照腾空间。数值仍是推荐默认，未经真实 Windows 项目测量校准。
- **已知语义偏差**：前像取「消息发送后该路径首次写入前」，不是「消息发送前」。发送后、首写前的外部修改会被当作基线恢复；这与工作台 §27.3.4 与运行架构 §8.5 的发送前基线规则冲突，口径待产品拍板。另：一次撤回只接受单一受管根（跨根 409 `RECALL_MULTIPLE_ROOTS`，会话根不可用/变化分别为 `RECALL_ROOT_UNAVAILABLE` / `RECALL_ROOT_CHANGED`）；目标 seq 之前已写入、之后未再次写入的路径不在本次范围；受影响 DONE 任务重开（BC-16）服务侧已接线（撤回结算后按「实际恢复路径 ∩ 委派写入」判定、仅 DONE 沿既有 `reopenTask` 入口进新验收周期、失败逐项写 `detail.task_reopens`），e2e 因委派执行链的存量回归（#140 计量包裹，`conversation-diff-attribution` 同红）暂以带因 skip 跟踪；工作台撤销按钮尚未接线。
- **消息投影**：会话消息 DTO 增加 `withdrawn_at`（ISO 或 null）与 `recall` 摘要（`id/message_id/assistant_message_id/status/planned_files/restored_files/skipped_files/completed_at`，无撤回为 null）。原文和附件仍返回，客户端按 `withdrawn_at` 显示撤回占位。
- **模型上下文**：撤回终态后，下一轮输入把被撤回的用户/助手消息替换为成对占位，并追加撤回回执事实行（实际恢复结果、未决项）；旧回复与旧摘要只作为历史来源，不再作为当前文件事实。恢复期间新消息被原命令入口的同一道闸拒绝（返回 409 `RECALL_IN_PROGRESS`）。

**错误码汇总**：`RECALL_PREFLIGHT_BLOCKED`、`RECALL_EFFECT_UNCERTAIN`（存在 UNKNOWN 工具调用/变更集）、`RECALL_IN_PROGRESS`、`RECALL_MULTIPLE_ROOTS`、`RECALL_ROOT_UNAVAILABLE`、`RECALL_ROOT_CHANGED`、`RECALL_UNDO_PREFLIGHT_BLOCKED`、`RECALL_UNDO_IN_PROGRESS`、`COMMAND_ID_REUSED`、`INVALID_TRANSITION`。除重放外均不改变文件；响应沿用统一 problem 形状。

