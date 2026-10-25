# HTTP 与应用命令契约：分册 02

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../http-command-contract.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

### 10.10 P08：持久控制与受控 Fake 恢复（2026-09-23）

- **控制与读取**：`POST /runs/{id}/control-requests` 接受 `command_id`、两个 expected revision、`type=PAUSE|CANCEL|HANDOFF|CANCEL_TASK` 与可选 `supersedes_request_id`，返回 202 命令回执，其 `result` 为 `{control_request_id,run_id,task_id,type,status:"PENDING",run_revision}`。回执固定表示意图已持久提交，即使独立安全点事务随后立即应用；实际结果由 `GET /runs/{id}/control-requests/{request_id}` 的直接对象读取：`id,run_id,task_id,type,status,revision,requested_at,decided_at,result_ref`。同一 Run 仅容一个 PENDING；冲突返回 409 `CONTROL_CONFLICT`，明确指定原请求 ID 才可 supersede。终态 Run 返回 409 `RUN_TERMINAL`。
- **Resume 与投影**：`POST /runs/{id}/resume` 接受命令 ID 和两个 expected revision，返回 202 回执，`result={run_id,status,run_revision}`。仅原 Run 仍持有 Task、Run 为 PAUSED、无 PENDING 控制、无未决动作且无 Worker claim 时恢复；原阶段为 WAITING_APPROVAL 时 Task 仍为 WAITING。`GET /runs/{id}` 保留 P05/P07 的 `task_id,revision,contract,current_step,steps,recent_attempts,result_refs,blocking_review_ids` 等字段，增加 `pending_control_request:{id,type,status:"PENDING",requested_at}|null` 与 `unresolved_operation_ids:string[]`。Task 为 WAITING 时 `GET /tasks` 的 `waiting_reason` 从当前 Run 投影。
- **Task cancel 兼容性**：人工持有的非终态 Task 仍以 200 直接返回 CANCELLED。AI 持有时 `POST /tasks/{id}/cancel` 可带 `expected_run_revision`，以 202 回执返回 `status:"PENDING",control_request_id,run_id,type:"CANCEL_TASK",run_revision`；安全点后才能把 Task 设为 CANCELLED。此处 **Breaking Change: Yes**，针对旧客户端把 AI 占有 Task 的 cancel 当作同步 200 的假设；兼容做法是按 202 回执读取控制请求与 Task 当前投影，人工路径保持 200。
- **安全边界**：Worker 领取与提交各用短事务，Fake 生成及受管内容读写在事务外；PERSIST 候选用固定 `operation_id=attempt_id`、目标路径和参数摘要保存效果。内部 `scanRecoveryCandidates` 仅列租约到期或已 fence 的未决候选，不自动运行，也不凭租约宣称旧进程已停止；内部 `recoverStoppedWorker` 要求调用方提供停机依据后提升 worker epoch 并核对同一动作，生产进程管理器的自动停机确认尚未实现。目标确实缺失才按同一 operation ID 重新准备；内容损坏或成功日志与内容不符保持 UNKNOWN，控制/交接不越过。HANDOFF 的 `result_ref.handoff` 保存 Run/Task/epoch、步骤位置、可用候选版本与验证会话的 ID；无候选时字段为 null，模型说明失败不阻塞确定性事实包。
- **P08 当时未开放**：恢复扫描与 Worker fence 是内部应用端口；当时尚无公开 `GET /runs/{id}/operations`、通用跨 Task 资源 claim 和 Gateway 批准消费。P09 当前增量见 10.11 节。P08 开发自检的确切范围见[测试计划](../../testing/verification-plan.md)，不等于正式验收。

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

**Breaking Change: No（公开 HTTP）。** 本片不改变 Delegate/Run/Review 的 URL、Bearer/Workspace 权限、`command_id` 幂等或 202 回执，也不增加公开恢复路由。桌面宿主启动随包 `supervisor-main.js` 前须核对精确静态标记 `relay-desktop-supervisor-v1`，并设置 `RELAY_SUPERVISOR_DESKTOP_MODE=true`。私有 stdin 首行是严格 JSON：`{nonce:<UUID v4>,launchId:<UUID v4>,stoppedLaunches:[{launchId:<UUID v4>,stopEvidence:"armed_job_terminated_and_active_count_zero"|"armed_job_absent_after_last_handle_closed"}]}`；最多 1 MiB/4096 个旧 launch。校验前不连接 PostgreSQL 或启动 Worker。第二片 stdout 顺序是 `supervisor_ready {nonce,launchId,nodeVersion}`、旧 launch 恢复完成后的 `dispatch_ready {nonce,launchId,requeuedRunIds,blockedRunIds}`，随后只有 `worker_started`、`worker_exit`、`worker_recovery_required` 运行事件；第三片的逐 launch 扩展见 10.16。宿主只有在 OS 已确认旧 Job 整组停机后才能提供 `stoppedLaunches`；Node 不能把租约过期或重启当作证明。stdin EOF 停新领取并等待已启动 Worker `close`。这只是私有宿主协议，细节与故障边界见 [M03 开发记录](../../development/m03-run-dispatch-slice.md#桌面私有监督与旧-launch-恢复第二片)。

`dispatch_ready` 另外携带 `requeuedRunCount:number`、`blockedRunCount:number`、`runIdsTruncated:boolean`。原 `requeuedRunIds:string[]`、`blockedRunIds:string[]` 保留供现有宿主反序列化，但只是按 stdout `<64 KiB` 实际 UTF-8 行长截取的前缀样本，不能作为完整 Run 集合、按 launch 的确认或 ARMED 删除依据；两个 Count 才是本次处理结果总数。BLOCKED/UNKNOWN 的旧 launch 停机证明不一定持久入库，宿主须保留其 ARMED 记录供后续核对。第二片时宿主第二阶段等待固定 30 秒，大量旧记录可能超时并拒绝就绪；按 launch 的确认由 10.16 增加，超时策略仍待宿主片处理。本变更只扩充私有输出帧，**Breaking Change: No（公开 HTTP）**。

### 10.16 M03 第三片：旧 launch 恢复确认（2026-09-24）

**Breaking Change: No（公开 HTTP）；私有宿主协议新增必需事件。** 每个 `stoppedLaunches` 条目完成该 launch 的所有旧 claim 核对/事务提交后，监督器重新从 PG 读取同一 launch 的 ACTIVE/STOP_REQUIRED invocation 数，发 `launch_recovery_ack {type:"launch_recovery_ack",nonce,launchId,retainedClaims:number}`。`retainedClaims` 是非负安全整数，不由 `dispatch_ready` 的有界 Run ID 样本或首次扫描推导。按输入 launch 顺序逐项发 ack；所有条目成功发 ack 后才发最终 `dispatch_ready`，随后才允许新领取。无旧 claim 的 launch 发 0；可安全重排后发 0；UNKNOWN、受损目标或其他残留占有发大于 0。任一核对/计数异常或停止/EOF 不发该 launch 的 ack、最终 ready，也不开始新 Worker。

`retainedClaims=0` 表示宿主已证明旧 Job 停止且该 launch 目前无持久活跃 claim；宿主只能在最终 `dispatch_ready` 后删除对应旧 ARMED。`retainedClaims>0` 必须保留旧 ARMED；先收到的部分 ack 仅是进度，最终 ready 未到不能清理。后端 ack 与 Windows 宿主组合片已由协调 Agent 独立验收：Rust 按序验证每项 ack 与最终 ready，Clean 删除零残留旧 ARMED，UNKNOWN 保留；第二阶段为 120 秒空闲和 20 分钟总时限。单个 launch 的核对期间仍无额外心跳，若实际核对超过空闲时限，宿主会安全失败。本结论只覆盖该组合片，M03 整体未验。实现与反例见 [M03 第三片开发记录](../../development/m03-run-dispatch-slice.md#逐旧-launch-恢复确认第三片)。

### 10.17 M03 Run SSE 后端片（2026-09-24，已独立验收）

**Breaking Change: No。** 新增 `GET /api/v1/workspaces/{workspace_id}/runs/{run_id}/events?after=<seq>`，返回 `text/event-stream; charset=utf-8`。请求使用原 Bearer 头、回环 Host/端口与允许的 Origin；Run 不属于该 Workspace 时按 404 隐藏。令牌不在 URL、事件或日志中。允许的 CORS preflight 头新增 `Last-Event-ID`，错误 Origin 与无 Bearer 不得到事件流。

每个已提交的 Run 事件从 `1` 连续递增；初次连接可用 `after=0`。`after` 查询参数优先于 `Last-Event-ID` 请求头，二者都没有时取 `0`；即使头值非法，显式合法 `after` 仍生效。被选中的游标必须是无前导零的非负十进制、至多 PostgreSQL signed bigint 最大值 `9223372036854775807`；非法、重复参数或大于该 Run 当前已提交最大序号返回 422 `VALIDATION_FAILED`，连接不升级为 SSE。历史 Run 在 0012 前没有合成事件，其最大序号为 0；客户端在流打开时仍应 GET 权威 Run 快照，不能把无历史帧解释为资源不存在。

持久事件仅是刷新提示，标准帧形如 `id: 1`、`event: run_hint`、`data: {"kind":"RUN_CHANGED"}`，以空行结束。`kind` 为 `RUN_CHANGED|STEP_CHANGED|ATTEMPT_CHANGED|REVIEW_CHANGED|CONTROL_CHANGED|EFFECT_CHANGED`；不含产物正文、模型 token、密钥或受限来源 ID。客户端只将完整帧的 `id` 作为最后消费游标，重复 ID 去重，缺号从旧游标重连，再 GET Run/Review/控制/产物权威快照。心跳是无 `id` 的 SSE 注释，不能充当可靠事件。关闭页面或断订阅只关闭连接，不请求取消或改变 Run。

服务端从 PG 顺序分批（每批最多 100）读取已提交事件；空批约每秒重新补查，因此无需把通知当唯一历史，历史与实时交界没有单次订阅切换窗口。写入返回背压时暂停读 PG，等待 drain；5 秒仍不能 drain 则关闭慢连接，由客户端凭最后完整 `id` 补读。每约 15 秒空闲发送无 ID 心跳。服务端不缓存无界输出，且当前 `run_events` 不裁剪；保留规模、磁盘与长期性能需 M03 压测/M07 运维方案测量，不能静默删除会使游标缺号的行。本片的真实 PG/HTTP 自检不代替 G01/G07/G08 与 M03 独立完整验收。

### 10.18 M03 Review/Resume 持久顺序片（2026-09-24，已分片独立验收）

**Breaking Change: No（公开 HTTP）。** `POST /api/v1/workspaces/{workspace_id}/reviews/{review_id}/decisions` 保留原 `command_id/expected_revision/target_hash/decision`、原 200 回执与 `effect.external_effect_executed=false` 的真实语义；同 `command_id` 同载荷重放原决定与回执，不新增 RESUME，不同命令不能再次决定已关闭 Review。原 Bearer、Host/Origin 与 Workspace 隔离保持不变；跨 Workspace Review 仍按 404 隐藏。Review 与目标/内容 hash/策略版本不匹配、过期或拒绝不会派发外部效果。

有效的 Run `CRITERION`/`RETRY_BUDGET`/`CHECKER_RETRY` 决定若把等待中的 Run 变为可运行，在**同一短事务**持久化唯一的 Review 绑定 RESUME、outbox 与命令回执；前驱 START 必须 DONE、旧 invocation 必须 IDLE 才可领取。审批可能快于旧 START 结清，旧投递不能借此执行 COMPLETE。`ACTION_APPROVAL` 的有效批准也保存一个绑定原 Review 决定的 RESUME 意图；本顺序片当时的固定 Worker 尚不领取，随后固定 Mock Gateway 图节点的当前行为见 10.20。此类 200 回执始终只表示“决定已记录，效果待执行”，不表示工具动作成功。拒绝或过期的 ACTION_APPROVAL 不生成 RESUME。`USER_IMPORT` 的 ACTION_APPROVAL 不绑定 Run，仍由原 Gateway 路径处理。

`POST /api/v1/workspaces/{workspace_id}/runs/{run_id}/resume` 的请求、202 回执与权限不变。手工 PAUSED→可运行状态现在在同一事务持久化 RESUME/outbox/回执；PAUSED→WAITING_APPROVAL 仅恢复人工等待，不生成 Worker 命令。旧 invocation 尚未释放时返回 409 `INVALID_TRANSITION`，客户端读取当前 Run/控制投影后再决定；这避免暂停后立刻恢复与旧 Worker 重叠。新增顺序只作用于内部 PostgreSQL 命令运输，不向客户端暴露 ordinal 或内部 command UUID。本片未接 LangGraph/PostgresSaver，固定 Mock 路径和真实 Provider 的边界不变。

若 ACTION_APPROVAL 已 APPROVE、效果尚未准入，随后 PAUSE/CANCEL/HANDOFF 在安全点应用，原 operation 转为 DENIED，并在同一 Task→Run 事务把该批准绑定的 deferred RESUME 投递结清；Review 决定、原 operation_id 与命令历史保留。此处 outbox `DONE` 仅表示失效投递已撤回，**不表示外部效果成功**。后续手工 RESUME 的更高 ordinal 因而不会被旧批准永久阻塞。旧 START 遇到已提交的新批准和待处理控制时，先处理控制，再结清自身投递。Gateway 领取批准动作时与 Admit 均核对有效期、Connection 和 Permission 当前版本；领取后至 Admit 前若撤权，在无 Invocation/外部效果且 worker epoch 仍匹配时释放 Worker claim，供控制安全点撤回旧批准。领取前发现批准失效也不产生 Worker 占用；Run 仍显示原等待事实，用户可通过现有 PAUSE/CANCEL/HANDOFF 控制收敛，当前不自动生成新 Review。已 DISPATCHING/UNKNOWN 的动作不走这条释放路径，仍按原 operation_id 核对。本片独立验收范围见 [M03 记录](../../testing/m03-independent-acceptance.md)。

### 10.19 M03 Task 产物历史读取（2026-09-24，已分片独立验收）

**Breaking Change: No。** 新增 `GET /api/v1/workspaces/{workspace_id}/tasks/{task_id}/artifacts`，不改变原保存、单件读取、内容下载或完成命令。沿用本机 Bearer、Host/Origin 与 Workspace 作用域；不存在或跨 Workspace 的 Task 返回 404，同 Workspace 的空 Task 返回 `200 {"items":[],"current_accepted_version_ids":[]}`。每个 `items[]` 使用现有 `GET /artifacts/{id}` 的安全 DTO，按 `(created_at,id)` 升序列出全部 Artifact；各 Artifact 内按版本号列出不可变版本摘要，不返回受管路径或正文。

`current_accepted_version_ids` 仅从 Task 当前 `current_completion_id` 指向的 CompletionRecord `state_delta.artifact_version_ids` 读取；重开后当前指针清空，返回空集合但保留 `items` 历史。`latest_version_id` 是 Artifact 的最新版本，Project State 的 `selected_artifact_version_refs` 是项目“当前选用”，两者均不能推断为本轮接受。读取使用同一数据库快照，避免并发完成/重开期间混合指针与列表。React 仅在此查询成功后决定 create 或按确切 Artifact revision append；查询失败保留草稿并禁用保存/完成。定向真实 PG、浏览器刷新和当前输入摘要见 [任务产物自检](../../../apps/workbench/results/m03-task-artifacts-evidence.txt)，该开发结果不等于 M03 总验收。

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

2026-09-30 工具输出拒绝的证据保全修复（**Breaking Change: No**）：模型返回原生工具参数或非文本内容时仍由 Adapter 拒绝，不执行工具；已有 `provider_request_id` 与 `usage` 字段保留拒绝前实际观察到的请求 ID 和合法规范化用量，缺失 ID、未观察用量保持 null，不复制工具参数、原始响应或异常正文。`ModelToolOutputError` 属于能力边界，消息的 `provider_error_kind` 仍为 null。先收到正文再拒绝时，失败结算删除临时预览，原调用已记录的首文本/首预览时间保留。当前 SDK 的 SSE 用量在流结束时才形成规范化 chunk，提前拒绝不推算未消费的 wire 用量。字段、状态码、取消/重试/完成权限不变；实际范围见[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。该拒绝语义适用于**不声明工具的入口**（Assist、Skill、语义检查）。2026-10-04 起，已声明工具的 DRAFT 入口对「正文与工具并存」不再拒绝，改为返回 `TOOL_CALLS` 并把该正文作为 `preamble` 交给结算方，理由与未持久化的边界见[运行架构 §2.3](../../architecture/runtime-context/part-01.md#23-内部工具循环的对象身份与恢复2026-10-03-实施设计)。HTTP 契约、字段与状态码均不变。

`0019_m04_draft_read_input` 为新 DRAFT 调用增加结构化输入 SHA-256 与原 `read_operation_id`/`read_invocation_id`（旧行保持 NULL）；操作历史的原正文不复制到计量表。FILE_READ/WEB_FETCH 成功证据按最多 16 KiB UTF-8 完整字符截取，并在 DRAFT 前按原 Manifest 估算口径计入预算；原正文 SHA-256、提取文本 SHA-256、实际片段 SHA-256 和 `UNTRUSTED_DATA` 标记随模型输入建立。额外元数据仍超预算则 DRAFT 以 `CONTEXT_REQUIRED_OVER_BUDGET` 失败且零模型调用。已结算类型化读取 `FAILED` 保留原操作和调用证据，Run 进入 FAILED、Task 释放回 READY；待处理控制意图仍先按安全点处理，`UNKNOWN` 仍需核对。**Breaking Change: No**：Delegate 参数、Run/Gateway HTTP DTO 与既有错误结构不变；本次改变的是新 Run 的内部动作顺序与模型输入。旧 DRAFT 已成功的 Run 保留旧顺序及原批准/操作身份。

### 10.30 缓存用量与上下文占用分母（2026-10-02，开发自检）

**Breaking Change: Yes（Assist 消息 `usage` 与 `/model-port` 响应新增字段）。** `GET /assist-sessions/{id}/messages?limit` 的 `usage` 从 `{input_tokens,output_tokens}` 扩为 `{input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens}`，新增两项各为非负整数或 `null`。`null` 表示 Provider 未上报该字段，**不表示精确 0**——「没有缓存命中」与「Provider 没报」在协议上不可区分，UI 不得把 `null` 画成 `0%`（当前实现：没有读数时命中率那一格整体不渲染，规则见[工作台 §17.6](../../frontend/workbench-design.md)）。按原两字段 schema 严格解析的客户端会因未知字段报错；本仓客户端已把这两项按可选字段处理（缺失等同 `null`），旧服务端无需升级。

数据来源：`openai-compatible` 端口读取 Provider 的 `usage.prompt_tokens_details.cached_tokens` / `cache_write_tokens`（SDK 归一化为 `usage_metadata.input_token_details.cache_read` / `.cache_creation`），经既有 `validUsage()` 校验后原样落库。数据库关联 `0049_m04_model_call_cache_usage`：`model_calls` 与 `assist_messages` 各加两个可空列，历史行保持 `null`（迁移不回填，因为无法区分真实零与未知）；`USER` 消息由 CHECK 约束强制恒为 `null`——它从不是一次模型调用。检查约束保证 `cache_read + cache_creation ≤ input_tokens`，避免 Provider 口径不一致时落库自相矛盾。Fake 端口显式给 `null`：离线确定性模式不伪造计费事实。

一处已知边界：LangChain SDK 的 `_streamResponseChunks` 用单个变量累积 usage，并在流结束时**只 yield 一次** usage chunk。若 Provider 把 `prompt_tokens_details` 与 token 数分开发送，SDK 层会用后到的裸 usage 覆盖，缓存读数丢失为 `null`。这是 SDK 行为，端口层无法补救；表现是「少报」而非「虚报」。

`GET /model-port` 响应新增可空 `max_call_tokens`（整数或 `null`），即 `RELAY_MODEL_MAX_CALL_TOKENS`，供 UI 作为上下文占用的分母。`provider='fake'` 或配置残缺时为 `null`，客户端须据此显示「占用不可算」而不是回退到某个默认上限。这是**当前配置值**而非历史快照：配置变更后用它解释旧调用会失真，因此 UI 只把它用于「最近一次调用」的即时读数并旁标绝对 token 数，不作为可追溯的历史事实存储。

此 DTO 仍不提供计费总额、金额或成本单价。上下文预算的既有 `ESTIMATED_UTF8_BYTES_DIV_3` 口径不变；圆环显示的是 Provider 报告的**输入 token** 与单次上限之比，不是模型上下文窗口占用率。

