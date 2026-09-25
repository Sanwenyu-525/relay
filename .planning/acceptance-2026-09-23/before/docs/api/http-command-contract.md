# Personal Workflow OS：HTTP、应用命令与错误契约

日期：2026-09-19。状态：Proposed，尚未实现。依据：[四份业务契约](../../contracts/README.md)、[领域模型](../architecture/domain-model.md)、[物理设计](../database/physical-design-postgresql.md)。

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

这些接口属于后续切片，不在第一条人工闭环中开放。用户入口不能提交 worker claim 或手动设置 Run 状态。

| HTTP（前缀 W） | 输入 / 用例 | 成功及边界 |
|---|---|---|
| POST /tasks/{id}/delegations | expected_task_revision、workflow_version_id、execution_config_version_id、retry_of_run_id? | 202，run_id、task_revision、run_revision、status=CREATED；已原子获得执行权，不代表工作已完成 |
| GET /runs/{id} | ReadRun | 200，状态、等待原因、控制请求、结果引用 |
| POST /runs/{id}/control-requests | expected_task_revision、expected_run_revision、type、supersedes_request_id? | 202，control_request_id、status=PENDING；type 为 PAUSE/CANCEL/HANDOFF/CANCEL_TASK |
| GET /runs/{id}/control-requests/{request_id} | ReadControlRequest | 200，PENDING/APPLIED/REJECTED/SUPERSEDED 及依据 |
| POST /runs/{id}/resume | expected_task_revision、expected_run_revision | 202，恢复到 CONTEXT_BUILDING 或 WAITING_APPROVAL；不跳过未知动作或未决控制 |
| GET /runs/{id}/reviews | ListReviews | 200，绑定对象、允许决定和阻塞信息 |
| GET /reviews/{id} | ReadReview | 200，revision、类型化目标、可检查的影响/差异、有效性 |
| POST /reviews/{id}/decisions | expected_revision、decision、feedback?、target_hash、明确的新预算（适用时） | 200，decision_id、effect、资源链接；外部执行仍可未发生 |
| POST /tasks/{id}/acceptance-revisions | expected_task_revision、expected_run_revision?、objective、criteria、expected_outputs | 无活动 Run 时 201；有活动 Run 时 202，返回新验收版本与持久控制请求；不转交执行权 |
| GET /runs/{id}/operations | ReadOperations | 200，动作、调用、UNKNOWN 与核对依据；不允许前端把状态改成功 |
| GET /verifications/{id} | ReadVerification | 200，绑定集合、检查状态、总决策和适用性；未决总决策可为 null |

Delegate 限 READY 且 HUMAN、有唯一 Project、有效依赖及明确执行作用域。AI 失败或停止后可重新 Delegate；手动重试提供原终态 retry_of_run_id，并创建新 Run。PAUSED/WAITING_APPROVAL 的旧 Run 仍占有执行权，不能新建并发 Delegate。

Stop AI 对应 CANCEL；取消整个 Task 对应 CANCEL_TASK；接手编辑对应 HANDOFF。用户主动控制先返回 202/PENDING，哪怕后台很快处理，也只通过查询显示实际结果。终态 Run 收到新控制意图返回 409 RUN_TERMINAL 并附当前状态；已存在的同 ID 请求仍按回执重放。

实质验收变化对活动 Run 创建 CANCEL 控制意图（应用事务内），按旧 Run 安全停止后才可重新 Delegate；这明确选择契约允许的保守停止路径。存在冲突控制意图则整笔命令 409，不出现验收已改、控制未登记的半完成状态。

Review decision 按 kind 限制：动作授权只接受 APPROVE/DENY；产物/人工项接受 ACCEPT/REQUEST_CHANGES；预算选择使用明确的 SET_RETRY_BUDGET 数值。不得用任意字符串或自然语言驱动回调。具体 reason 决定 allowed_decisions，服务端重新校验；UI 只用于提示。REQUEST_CHANGES 仅在原验收契约下修正，改变目标需创建新验收版本。

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

阶段 A 保留轮询；TypeScript-first 推荐在 P12/真实模型阶段按需增加 SSE，不引入 WebSocket 或另一套可靠业务消息。模型 token 流是临时展示，业务通知只能在提交后发送，断流后通过 GET 重建持久状态，不能从 token 判断 Task 完成。SSE 需沿用 Bearer/作用域校验，不能将令牌放 URL；具体鉴权传输、端点/schema、游标、重连及背压在实现前定义并测试。

本段桌面交付形态调整的 Breaking Change：No，未修改既有端点、请求/响应字段和权限；不包括第 10.3 节已记录的 `SET_PHASE` 行为收紧。SSE 仍为后续设计项，不是已发布接口。

UI 必须区分“暂停请求已提交”与“已暂停”、“批准已保存”与“动作已执行”、“验证通过”与“任务已完成”。202 回执一直代表接受时刻，最新状态从返回的资源链接获取。

## 7. 错误结构与重试语义

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
| 409 | EXECUTOR_CONFLICT / RUN_TERMINAL / CONTROL_PENDING | 读取当前执行者/控制状态，不并行启动 |
| 409 | ACCEPTANCE_STALE / REVIEW_TARGET_CHANGED / REVIEW_EXPIRED | 重新取得有效契约或审批，不沿用旧批准 |
| 409 | RESOURCE_BUSY / RECONCILIATION_REQUIRED | 等待或查看核对信息，不把它作为任意自动重试 |
| 409 | INVALID_TRANSITION / REQUIRED_REVIEW_PENDING / VERIFICATION_NOT_VALID | 当前事实不满足操作，展示明确原因 |
| 413 / 415 | CONTENT_TOO_LARGE / UNSUPPORTED_MEDIA_TYPE | 调整受支持内容 |
| 422 | VALIDATION_FAILED / REQUIRED_INPUT_MISSING | 合法 JSON 但字段/条件缺失；field_errors 指向字段 |
| 503 | STORAGE_UNAVAILABLE / DATABASE_UNAVAILABLE / SCHEMA_UNAVAILABLE / EVIDENCE_UNAVAILABLE | 检查 command receipt；安全的原样重试，不生成新命令 |
| 500 | INTERNAL_ERROR | 不泄漏堆栈/SQL/凭据；提交结果不明时先查询回执 |

retryable 仅表示是否允许原样重试当前命令，不是承诺会成功，也不授权重新执行外部动作。retry_action 取 NONE、REFRESH_AND_REDECIDE、POLL_RESOURCE、CHECK_RECEIPT_THEN_RETRY。依赖数据库不可用时回执查询也可能失败，客户端保留原 command_id 等待恢复。

错误不包含隐私正文、宿主绝对路径、SQL、密钥或完整模型上下文。日志用 request_id/command_id/领域 ID 关联必要证据。

## 8. 本机 API 的最低边界

开发 API 绑定 loopback，使用外部注入的随机 Bearer 凭据；不硬编码或写进示例配置。所有读写与下载校验凭据和作用域。前端来源采用明确允许列表，不能因“本机”就允许任意网页调用；禁止在 URL query 中传令牌。

完整 V1 为 Windows 可安装应用。桌面壳经受控启动握手向受信窗口交付当前 loopback 端点与短期 Bearer，前端仅保存在内存；重载后通过窄 IPC 重新获取当前实例信息，服务重启轮换凭据。DB/Provider 密钥不交前端，领域命令不另走 IPC。实际生产 WebView Origin、CORS/CSP、实例验证和停机边界见[部署设计](../deployment/local-deployment.md)及 [ADR-007](../decisions/ADR-007-windows-desktop.md)。不开放 Cookie 会话、匿名业务 API 或远程访问。

此次交付形态调整的业务 API Breaking Change：No；路径、DTO、command_id、回执和权限语义不变。变化的是尚未发布的启动与凭据交付方案；不能沿用“用户手填 token、刷新重连”的旧部署说明。

## 9. 验收及下一步

协议测试覆盖：同命令重放、改 body 复用 ID、两个不同命令并发完成、版本冲突、202 后刷新、旧回执不覆盖新事实、审批过期、停止与完成两个提交次序、未知动作不可跳过、人工空产物条件、越权路径与输入字段拒绝。业务结果仍映射 A01–D11。

下一步以[首条工程切片](../development/first-human-slice.md)建立独立工程，再生成该切片的 OpenAPI、完整 V001 migration 和真实 PostgreSQL 测试。本文只定义草案；没有 API 服务、OpenAPI 校验或端到端测试已通过的声明。

## 10. 实现状态（2026-09-20，P02/P03）

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
| POST /tasks/{id}/cancel | CancelTask | 200 | 非终态→CANCELLED；DONE 必须先重开（重开见 10.5） |
| POST /tasks/{id}/goal-alignment | SetTaskGoalAlignment | 200 | `mode=INHERIT/EXPLICIT`；INHERIT 不接受 `goal_ids`，EXPLICIT 必须有 `goal_ids`（可为空集合） |
| POST /tasks/{id}/dependency-links｜dependency-unlinks | AddTaskDependency / RemoveTaskDependency | 200 | `dependency_kind=BLOCKS/INFORMS` |
| POST /tasks/{id}/artifacts | CreateArtifactWithVersion | 201 | 只允许 IN_PROGRESS 的人工 Task；内容先完整发布到受管存储再登记 v1 |
| POST /artifacts/{id}/versions | SubmitHumanArtifactVersion | 201 | 需要 `expected_artifact_revision` 与 `expected_task_revision`；旧版本不覆盖 |
| GET /artifacts/{id} | ReadArtifact | 200 | 逻辑信息 + `revision` + 各版本摘要；不含宿主路径，也不表示已被选为验收对象 |
| GET /artifact-versions/{id}/content | ReadArtifactContent | 200 | `text/markdown; charset=utf-8` 的正文本身（不是 JSON）；证据不可用返回 503 |
| POST /tasks/{id}/complete | CompleteHumanTask | 200 | 一次短事务写 Task 指针、State delta、人工接受、完成凭据、回执与审计 |
| POST /tasks/{id}/reopen | ReopenTask | 200 | 新 `acceptance_revision`、回到 READY、清空当前完成指针；历史凭据保留 |
| GET /projects/{id}/state | ReadProjectState | 200 | 见 10.3 |
| POST /projects/{id}/state-commands | SetProjectState | 200 | 见 10.3 |
| GET /commands/{command_id} | ReadCommandReceipt | 200 | 第 2 节定义的同一回执；不存在返回 404 COMMAND_NOT_FOUND |

所有写命令都带 `command_id`；同 ID 同内容返回原回执与原成功码（响应头 `Command-Replayed: true`），同 ID 异内容返回 409 `COMMAND_ID_REUSED`。成功码由 `command_type` 推导（`Create*` 与 `SubmitHumanArtifactVersion` 为 201，其余 200），因此重放不需要额外保存 HTTP 状态。

### 10.2 与设计的差异与细化

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

第 4 节的 Delegate 与 `ReadRun` 已由 P05 实现（见 10.7）；同一节的控制请求 / Resume / Review / 验收版本命令仍属 P06–P08。第 5 节的内部应用端口仍只是应用用例，不开放为公开 HTTP（`advanceRunStep` 是内部端口，Worker 与测试直接调用）。模块 API 中的 Project 归档、Task 移动、交互模式切换、planning metadata、Today/Workbench/搜索等同样未实现。P03 范围内尚未提供的还有：Artifact 列表端点（前端只能按已知 artifact_id 读取）、孤儿内容的核对报告与自动清理、启动时的内容抽检（访问路径的 hash 校验已实现）。本轮没有生成 OpenAPI（P21），也没有 SSE（P12 按需）。

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
- **`advanceRunStep` 不是 HTTP 端点**：它是内部应用端口，输入包含 `workerId`、可选 `attemptKey` 与租约时长；稳定来源尝试 ID 由 `step_attempts(step_id, attempt_key)` 唯一约束去重，迟到 `claim_epoch` 的结果只写核对证据（`REJECTED_STALE`），不推进步骤位置（B08）。
- **Task 投影的 `executor.run_id`**：自 P05 起返回真实 `tasks.executor_run_id`（此前恒为 `null`），`ownership_epoch` 同样来自 Task 行，便于前端显示当前执行者而不自行推断。

### 10.8 P06：Verification 与完成 Gate（2026-09-22）

已实现固定 Workflow 的后两步，真实用例见 `apps/api/test/integration/verification.integration.test.ts`（真实 PostgreSQL + 受管内容存储），单测见 `apps/api/test/unit/verdict.test.ts`、`check-plan.test.ts`、`checkers.test.ts`。**本阶段不新增 HTTP 端点**：Verification 与完成 Gate 只通过内部应用端口 `advanceRunStep` 执行，Review 的请求、决定与人工判断仍属 P07。

| 步骤 | 输入 | 结果 |
|---|---|---|
| VERIFY | 冻结执行契约 + `PERSIST_CANDIDATE` 登记的确切版本 | `verification_sessions`（`OPEN`→`PASS`/`RETRY`/`HUMAN`）、`verification_targets`、不可变 `check_results` |
| COMPLETE | 该 Run 最新 session 为 `PASS` 且适用性未被撤销 | 自动完成短事务（`completion_records` basis `AUTO`）；不满足则 `COMPLETION_BLOCKED` |

`advanceRunStep` 的新增结果：`CORRECTION_SCHEDULED`（修正回路已排期）与 `COMPLETION_BLOCKED`（完成前置不满足）。Run 迁移为：`VERIFYING →(PASS/检查器重试)→ VERIFYING`、`VERIFYING →(RETRY)→ RETRYING`、`VERIFYING →(HUMAN)→ WAITING_APPROVAL`、`WAITING_APPROVAL/VERIFYING →(COMPLETE)→ COMPLETED`（终态）。

与设计正文的差异与细化：

- **CheckPlan 由冻结契约派生，Worker 无写权**：`buildCheckPlan` 读 `execution_contracts.frozen_snapshot` 的 criteria，按 method 映射内置 registry（`HUMAN→human-evidence-v1`、`MARKDOWN_STRUCTURE→markdown-structure-v1`、`CITATION_EXISTS→citation-exists-v1`、`SEMANTIC→fake-semantic-v1`）；severity 取 `target_spec.severity`，缺省 required→`HARD`、否则 `PREFERENCE`。计划与 SHA-256 摘要在 session 创建时冻结，Delegate 之后删除或改写 `acceptance_criteria` 不改变本轮检查集合（已由集成用例断言）。
- **registry 与故障替换分开**：`ERROR` 检查器只由 `resolveCheckerForScenario('CHECKER_ERROR')` 替换出来，**不注册进 registry**；若注册会覆盖同 id/version 的真实检查器，把确定性检查永久变成 ERROR。缺注册 checker 时 VERIFY 直接判为不可执行失败（`CHECKER_NOT_REGISTERED`），不静默降级为建议。
- **总判定顺序刻意“先修可修的”**（`src/workflow/verdict.ts` 纯函数）：① 必需项检查器 `ERROR`：该 criterion 最新 `check_attempt < 2` → 重试检查本身，否则 `HUMAN`（`CHECKER_UNAVAILABLE`）；② 必需项非 `PREFERENCE` 的 `FAIL`：预算未耗尽 → `RETRY`，否则 `HUMAN`（`CORRECTION_BUDGET_EXHAUSTED`）；③ 必需项 `NOT_RUN` → `HUMAN`（`AWAITING_HUMAN_EVIDENCE`）；④ 必需项 `UNCERTAIN` → `HUMAN`（`UNCERTAIN_REQUIRES_HUMAN`）；⑤ 其余 → `PASS`。这样“必需人工项未完成”不会把本可修正的失败永久锁死，`ERROR`/`NOT_RUN` 也不会被算成 `PASS`；`NOT_APPLICABLE` 与非必需项不影响总决策，`PREFERENCE` 失败只作为建议记录。
- **检查器重试不产生新证据**：`RETRY_CHECKER` 不 finalize session、不新建产物版本；下一次推进只对同一 session 追加更大的 `check_attempt`。第 2 次仍不可用才转 `HUMAN` 并保留未决（C06）。
- **修正回路不新建步骤行**：总决策 `RETRY` 时 session 先 finalize 为 `RETRY`（`correction_budget_used +1`），随后把 `BUILD_CONTEXT`/`DRAFT`/`PERSIST_CANDIDATE`/`VERIFY` 重置为 `PENDING`、Run 回到 `RETRYING`，按固定顺序重跑这一段；修正轮次与已用预算都由「该 Run 已 finalize 为 `RETRY` 的 session 数」推导，没有额外计数列。默认修正预算 2 次（`DEFAULT_CORRECTION_BUDGET`）。
- **修正创建新产物与新 Session**：`BUILD_CONTEXT` 在 round ≥ 1 时把上一轮失败项作为 `correction` 输入装进 Manifest payload（摘要变化，形成新的不可变 Manifest）；`PERSIST_CANDIDATE` 的 round ≥ 1 用 `run:<runId>/step:PERSIST_CANDIDATE/round:<n>` 作为来源尝试 ID，在**同一 Artifact 上追加新版本**（不是新建第二个 Artifact），旧版本与旧 session 的历史结论保留。新版本必须由新 session 重新验证，不继承旧 PASS（C01/C02 的产物侧）。
- **`EVIDENCE_UNAVAILABLE` 优先于任何检查结果**：VERIFY 与 COMPLETE 都先读受管内容并核对 hash/size；文件缺失、被替换或摘要不一致时返回 503，不写检查结果、不返回部分内容、不把缺失当成 `FAIL`（C08 的证据侧）。
- **`COMPLETION_BLOCKED` 不是执行失败**：完成 Gate 在**建立步骤尝试之前**核对，因此等待人工既不产生 `FAILED` 尝试，反复轮询也不会留下失败尝试；步骤保持 `PENDING`、Run 与 Task 不变。原因取 `ACCEPTANCE_REVISION_CHANGED`（C01：验收契约已变化，旧 PASS 不能完成新周期）、`VERIFICATION_NOT_PASSED`（含 C04 必需人工项未决）、`VERIFICATION_REVOKED`（显式撤销适用性）。
- **自动完成短事务**（contracts/04 第 7 节）：写 `completion_records`（basis `AUTO`，绑定 `verification_session_id` 与 `run_id`）→ CAS Task 至 `DONE` 并写当前完成指针 → **释放 AI 执行权**（`executor_kind='HUMAN'`、`executor_run_id=NULL`、`ownership_epoch+1`）但**保留 `mode='DELEGATE_AI'`** 供展示 → Run `COMPLETED`（写 `terminal_at`）→ 有 Project 时写 `state_completion_refs` 并清空/递增 `project_states` → 写 `TASK_COMPLETED` 审计。任一步失败整笔回滚（D05 用真实失败触发器验证）。`ReopenTask` 现在把 `mode` 复位为 `ME`。
- **PASS 之后只重试提交**：`D04` 由集成用例断言——VERIFY `PASS` 之后不跑 COMPLETE，只推进 COMPLETE 即完成，且不新增产物版本、session 或 DRAFT 尝试。
- **尚未实现（明确边界）**：人工补验入口（`verification_sessions` 允许 `run_id` 为空但当前没有写入口）、`RecordCheckResult` 的 HTTP 形态、Review 类型化请求与决定（C02/C03/C09）、控制请求与资源 claim；`GET /runs/{id}` 的投影仍不含 verification 摘要，随 P07 的 Review UI 一并确定。**Fake 边界**：`FakeSemanticChecker` 是确定性替身，真实语义判断属 P12；本阶段不声称验证器能保证事实绝对正确。

