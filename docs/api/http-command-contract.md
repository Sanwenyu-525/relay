# Personal Workflow OS：HTTP、应用命令与错误契约

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
| 500 | INTERNAL_ERROR | 不泄漏堆栈/SQL/凭据；提交结果不明时先查询回执 |

retryable 仅表示是否允许原样重试当前命令，不是承诺会成功，也不授权重新执行外部动作。retry_action 取 NONE、REFRESH_AND_REDECIDE、POLL_RESOURCE、CHECK_RECEIPT_THEN_RETRY。依赖数据库不可用时回执查询也可能失败，客户端保留原 command_id 等待恢复。

错误不包含隐私正文、宿主绝对路径、SQL、密钥或完整模型上下文。日志用 request_id/command_id/领域 ID 关联必要证据。

## 8. 本机 API 的最低边界

开发 API 绑定 loopback，使用外部注入的随机 Bearer 凭据；不硬编码或写进示例配置。所有读写与下载校验凭据和作用域。前端来源采用明确允许列表，不能因“本机”就允许任意网页调用；禁止在 URL query 中传令牌。

完整 V1 为 Windows 可安装应用。桌面壳经受控启动握手向受信窗口交付当前 loopback 端点与短期 Bearer，前端仅保存在内存；重载后通过窄 IPC 重新获取当前实例信息，服务重启轮换凭据。DB/Provider 密钥不交前端，领域命令不另走 IPC。实际生产 WebView Origin、CORS/CSP、实例验证和停机边界见[部署设计](../deployment/local-deployment.md)及 [ADR-007](../decisions/ADR-007-windows-desktop.md)。不开放 Cookie 会话、匿名业务 API 或远程访问。

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

第 4 节的 Delegate 与 `ReadRun` 已由 P05 实现（见 10.7），Review 查询与决定已由 P07 实现（见 10.9），控制请求与 Resume 已由 P08 实现（见 10.10）；验收版本命令仍未实现。第 5 节的内部应用端口仍只是应用用例，不开放为公开 HTTP（`advanceRunStep` 与恢复扫描是内部端口）。模块 API 中的 Project 归档、Task 移动、交互模式切换、planning metadata、Today/Workbench 等仍未实现；P10 已提供四类长期信息与有界搜索（见 10.12）。P03 当时未提供 Artifact 列表端点，M03 的 Task 范围读取增量见 10.19；孤儿内容的核对报告与自动清理、启动时的内容抽检仍未实现（访问路径的 hash 校验已实现）。目前没有生成 OpenAPI（P21）；M03 SSE 后端片已独立验收（见 10.17），Review/RESUME 顺序片见 10.18。

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

`GET /runs/{run_id}/operations`、`GET /import-jobs/{import_job_id}/operations` 与 `GET /operations/{operation_id}` 返回 Operation 历史；单项包含 `id,origin,project_id,run_id,step_id,import_job_id,status,action_type,normalized_target,params_hash,connection_id,connection_version,policy_id,policy_version,created_at,result_ref,invocations[]`，每个 Invocation 含 `id,attempt_number,status,authority_revision,connection_version,worker_epoch,created_at,dispatched_at,resolved_at,result_ref`。列表目前最多 100 条，无分页游标。`GET /import-jobs/{id}` 只读返回类型化 USER_IMPORT 来源与 QUEUED/RUNNING/SUCCEEDED/FAILED 状态；实际知识版本创建与异步 URL 导入命令留 P17。Operation/Invocation 查询不返回参数原文、Connection config、claim token 或 Worker ID。

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

`source_kind=NOTE` 只接受 `text/plain`，`MANAGED_TEXT` 接受 `text/plain`/`text/markdown`，正文 UTF-8 不超过 256 KiB，保存在不可变 PostgreSQL 版本行。`ARTIFACT_VERSION` 只引用同 Project 的 Markdown ArtifactVersion，不复制其正文；相同来源在同一 Workspace 的并发提升返回同一 Knowledge 身份。该引用的元数据不代替 Artifact 内容读取时的 hash/size 核对。URL 抓取、PDF/Office 提取、异步 import job→KnowledgeVersion、任意文件导入仍留 P17。

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
