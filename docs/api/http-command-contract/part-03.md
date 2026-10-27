# HTTP 与应用命令契约：分册 03

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../http-command-contract.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

### 10.29 M05/P13 Today 与个人选择（2026-09-26，后端开发自检）

**Breaking Change: No。** `POST /tasks/{task_id}/planning-metadata` 接受 `{command_id,expected_revision,priority,due_local_date,timezone}`；三个元数据字段必给，可分别用 `null` 清空，但日期/时区必须同空或同有。priority 为 `LOW/NORMAL/HIGH/null`，日期为真实 `YYYY-MM-DD`，时区为有效 IANA 名称。返回 200 原命令回执 `result={task_id,status,revision}`；Task 单读/列表增加 `priority,due_local_date,timezone`，元数据更新只推进 Task revision，不改变 acceptance_revision。历史 Task 的新字段为 NULL。

`GET /today?date=YYYY-MM-DD&timezone=IANA` 返回 `date,timezone,selection_revision,focus,focus_has_eligible_candidate,eligible_items,waiting_items,blocked_pinned_items`。`focus` 可为 null，否则含原保存的 `date,timezone,target_kind,target_id,selection_revision,active_in_query`；同日期换查询时区仍返回原 Focus，只在时区完全匹配时用于排序。每条 Task 项返回 `task_id,task_revision,project_id,title,status,priority,due_local_date,timezone,pin,later_local_date,later_timezone,reason_codes,evidence_refs,allowed_actions`。`blocked_pinned_items` 是 `waiting_items` 中已 Pin 但不合资格的子集。查询只读；先按 HUMAN 且 READY/IN_PROGRESS、验收条件、BLOCKS 依赖、未解除 blocker、Later 截止过滤，再将合格项按 Focus→Pin→到期→priority→Project Next Action→人工进行中→created_at（早者先）→id（升序）排序。AI 占有和其他不合资格 Task 只在 waiting 区；无 Project 人工 Task 合法参与。Goal Focus 按 Task 的 INHERIT 当前 ProjectGoal 或 EXPLICIT 显式集合判定，显式空集不继承。

`POST /task-selections/{task_id}` 接受 `{command_id,expected_revision,pin,later_local_date,timezone}`，Pin 与 Later 一次提交，`pin=false` 且 Later 双 NULL 即清除该选择；`POST /focus-selections` 接受 `{command_id,expected_revision,date,timezone,target_kind,target_id}`，目标为 `GOAL/PROJECT/TASK` 与同 Workspace UUID，目标种类和 ID 同为 NULL 清除该日 Focus。两个命令的 expected_revision 都指向 Workspace 级 `selection_revision`，成功 200 回执 `result={selection_revision}`，与 Task revision/acceptance_revision 独立；同 command_id 同载荷重放原回执，过期版本 409 `REVISION_CONFLICT`，跨 Workspace 目标 404 `RESOURCE_NOT_FOUND`，无效日期/时区或成对字段 422 `VALIDATION_FAILED`。Focus 按 Workspace + 日期最多一项，修改其他时区保存的当日 Focus 必须显式提交并通过 revision 栅栏。Later 在保存时区当地 00:00 对应的绝对时刻到期；查询日期按请求时区当地 00:00 观察，跨午夜无需后台任务。此切片未做 M05 独立或 Windows 桌面验收。

### 10.30 M05/P15 Activity、Run Trace 与 Artifact Lineage（2026-09-26，后端开发自检）

**Breaking Change: No。** 以下均为新增只读端点，位于 `/api/v1/workspaces/{workspace_id}` 下，沿用本机 Bearer、Host/Origin 与 Workspace 隔离；不存在或跨 Workspace 的 Project、Task、Run、ArtifactVersion 筛选目标返回 404 `RESOURCE_NOT_FOUND`，不通过计数或游标透露另一 Workspace。无公开 Lineage 写入端点。

`GET /activities?project_id=&task_id=&run_id=&from=&to=&cursor=&limit=` 按 `(created_at,id)` 倒序返回 `{items,next_cursor}`，`limit` 缺省 30、上限 100；`from` 含、`to` 不含，均要求 UTC RFC3339 时间，且 `from < to`。游标绑定 Workspace 与全部筛选条件；换筛选条件、畸形游标返回 400 `INVALID_CURSOR`，无效时间或超范围 limit 返回 422 `VALIDATION_FAILED`（不符请求 schema 的格式由统一 400 校验处理）。条目仅含 `id,created_at,actor_kind,actor_ref,command_id,event_type,summary,project_id,task_id,run_id,entity_refs[{kind,id}]`；`entity_refs.kind` 限 `PROJECT/TASK/RUN/GOAL/ARTIFACT_VERSION/REVIEW/COMPLETION/VERIFICATION_SESSION`，引用先核对当前 Workspace。摘要使用事件类型白名单，未知类型为通用文字；不返回原 `fact_refs`、自由正文或未识别 actor_ref。

`GET /runs/{run_id}/trace` 返回 `run_id,task_id,project_id,status,steps,attempts,model_calls,manifests,verifications,reviews,operations,effects`。Step/Attempt、模型调用、验证目标与 Check、Review 决定、Gateway Operation/Invocation、受管效果均来自原事实；`result_available` 仅表示有结果引用，不能当作成功。`reviews[].decision` 与 `operations[].status`/`effects[].status` 分开，批准本身不表示动作执行。Manifest Sources 只给 `kind,source_ref,version,sha256,source_sha256,role,trust,availability`；按当前可读作用域和确切历史版本核验，失效或越权时 `availability=UNAVAILABLE` 且引用/hash 为 null。模型提示词/响应、隐藏思考、Gateway 参数/结果正文、受管路径和凭据不出 DTO。

2026-09-30 M04 调用诊断增量（**Breaking Change: No**）：`model_calls[]` 补充原账本的 `kind,criterion_id,check_attempt,provider_request_id` 和封闭词表 `provider_error_kind`。仅原调用 `status=FAILED` 且原 `error_kind` 属于 `AUTH/RATE_LIMIT/TIMEOUT/STREAM_BROKEN/PROTOCOL/NETWORK` 时返回类别，其余为 null；不返回任意错误名或原异常正文，不按异常文案猜测旧记录。每行仍绑定原 `id,step_attempt_id,manifest_id`，语义检查保留确切条件和检查尝试，不合并不同调用。缺失的请求身份、条件、用量保持 null。旧客户端可忽略新增字段，新客户端对旧服务缺字段按未知处理；这只是历史调用证据，不改变 Run、Attempt、检查器重试、Review 或完成语义。实际运行结果见[接续记录](../../development/ui-live-integration-2026-09-28.md)。

`GET /artifact-versions/{artifact_version_id}/lineage` 返回 `artifact_version_id,artifact_id,version_number,sha256,source_kind,content_availability,direct_parents[]`；直接父边含 `id,relation,parent_kind,parent_id,availability,created_at`。关系仅 `DERIVED_FROM/REVISED_FROM/GENERATED_BY/VERIFIED_BY/ACCEPTED_BY`，父种类依关系限 `ARTIFACT_VERSION/KNOWLEDGE_VERSION/RUN_STEP/VERIFICATION_SESSION/COMPLETION_RECORD`。源不可读、正文丢失或 hash 不符时保留边但 `availability=UNAVAILABLE,parent_id=null`，不拿当前版本代替历史来源。上述新接口已做真实 PostgreSQL 定向开发回归，尚未做 M05 独立或 Windows 桌面验收。

2026-09-30 M04 首输出追溯增量（**Breaking Change: No**）：Run Trace 的 `model_calls[]` 追加可空 ISO 时间 `first_text_delta_at`、`first_preview_persisted_at`。前者是当前合法 DRAFT/普通无 Skill 的 Assist DISCUSS 首次非空文本回调的观察时间，后者是首个预览成功事务内的写入时间；同调用后续更新不覆盖，结算或清理预览也不清除。旧行、首文本前取消/失败和不提供文本预览的调用保持 null，不从旧正文或结束时间回填。`started_at` 仍表示账本受理，以上都不是实际 HTTP 发出、Provider 收包或窗口显示时间。旧客户端可忽略字段，新客户端对旧服务缺字段显示“未记录”；仅原 Owner 写入，不增加业务完成权限。实际通过范围见[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

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

2026-09-30 补齐 Skill 模型请求的 JSON mode：内部仍以 `DISCUSS` 表示 Skill 消息，模型适配器按冻结 Skill 身份启用 `response_format:{type:'json_object'}`，不再只按普通提案 intent 判断。**Breaking Change: No。** HTTP 输入/回执、Skill 版本、严格输出 schema 与原接受 Owner 不变；普通无 Skill 的 `DISCUSS` 继续流式首预览，Skill 不输出部分预览。JSON mode 不能代替 schema 校验，不合法输出仍以 `OUTPUT_SCHEMA_INVALID` 失败且不生成提案。验证结果只在[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)维护。

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

消息来源的历史投影会重新核对当前可见性：已失权的普通 `DISCUSS` 正文返回 null，来源 ID/正文不出响应；仍可见来源保留既有记录字段。结构化提案、Skill、语义检查和 Run DRAFT 不在此端点公开原始生成片段；Run 的独立端点见 §10.39。临时草稿的容量/速率、删除和跨进程读取由 [物理设计 §41](../../database/physical-design-postgresql.md)说明；真实 Provider 与前端首字延迟仍需单独验证。2026-10-18 起新增可选的 SSE 加速通道（§10.59，帧体即本 DTO）；本端点保留为权威快照与降级路径。

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

`GET /attention/interventions` 从当前业务事实读取必须介入事项及原入口，普通 HUMAN INBOX/READY 不包含在主动提醒投影。桌面失焦 3 秒后调用 `POST /attention/notifications/claim`，数据库按事项身份与变化原子去重；`POST /attention/notifications/settle` 记 `DISPATCHED/DENIED/FAILED` 投递尝试状态。后两者是通知传输回执，不决定 Review/Run/Task，也不以投递成功表示用户已处理。隔离 Windows 宿主已实测投递和点击；安装包与协调侧验收未完成，见[专项开发记录](../../development/collaboration-controls-2026-09-28.md)。

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

2026-10-26 增量（**Breaking Change: No，响应新增 `credential_identity`**）：`GET /model-port/verification` 增加 `credential_identity`，取值 `MATCH` / `CHANGED` / `UNKNOWN`，表示**最近一次验证所用凭据**与当前凭据的关系。`CHANGED` 时 `matches_current_config` 一并变为 `false`——换 API Key 之后旧验证结论不再代表当前连接可执行，必须重新验证；`UNKNOWN` 表示该验证行产生于 0142 之前、没有凭据身份可比，不冒充匹配。凭据身份是 `sha256(域 ‖ provider ‖ key)` 的单向摘要，只做服务端比较，**不出现在任何响应、日志或上下文清单里**（响应只给关系枚举，不给摘要）。`config_fingerprint` 的语义与算法不变（仍不含密钥），因此换 Key 不改配置指纹、只改凭据身份——两个维度分开表达，前端不需要也不应该推断 Key。

2026-10-27 增量（**Breaking Change: No，新增可选目标与 `state`**）：验证不再只能针对进程默认模型。
`POST /model-port/verify` 接受可选体 `{ "connection": "openrouter", "model": "<确切型号>" }`（缺省仍是默认连接，旧调用方无需改动）；`GET /model-port/verification` 接受同名查询参数。响应新增 `target`（`default` 或 `openrouter:<型号>`）、`connection`、`model`、`target_last`、`state`。

`last` 保持既有语义不变（本实例最近一次验证，不按目标过滤）；`target_last` 是**本目标**（provider + 确切型号）最近一次验证，`state` 只由它推导。两者分开是刻意的：设置页的「最近一次验证」与「这个型号能不能用」是两个问题，另一个型号的成功不能冒充这个型号可执行。

`state` 是**互斥**的 13 态：`NOT_CONFIGURED`（没凭据/没型号）、`CONFIG_INCOMPLETE`（有 Provider 但字段残缺）、`UNVERIFIED`（该目标没有可继承的验证行，含配置指纹已变）、`VERIFIED`（**这个确切目标**刚探测通过）、`CREDENTIAL_CHANGED`（换过 Key）、`AUTH_FAILED`、`MODEL_NOT_FOUND`（HTTP 404，账本 `error_kind=MODEL_NOT_FOUND`，对外 `error_category` 仍是 `PROTOCOL`）、`CATALOG_STALE`、`CAPABILITY_INSUFFICIENT`、`FREE_INELIGIBLE`、`ACCOUNT_COOLDOWN`、`BUDGET_EXHAUSTED`、`UNKNOWN`。优先级是「能不能验证」先于「上次验证结果」：目录过期、资格失效、账户冷却期间即使上一行是 ok 也不显示 `VERIFIED`——这正是「目录存在 / Key 已填 / 默认模型验证过」被误读成「所选模型可执行」的根源。

OpenRouter 目录型号的探针：使用**独立**聊天凭据（`RELAY_OPENROUTER_API_KEY`，缺省回退 `OPENROUTER_API_KEY`）与**确切**型号，并在最终 HTTP 体附带 `provider.max_price` 全零与关闭 fallback 的硬限制（与真实免费外呼同一条防线）。探测前先确认该型号在当前目录快照里仍是免费文本型号：不是 → 409 `MODEL_VERIFY_TARGET_NOT_ELIGIBLE`；目录过期 → 409 `MODEL_VERIFY_CATALOG_STALE`（`retry_action=REFRESH_AND_REDECIDE`）。两种拒绝都**不发起外呼、不写 `model_calls`**。目标格式非法 → 400 `MODEL_VERIFY_TARGET_INVALID`。

验证仍不等于执行：`VERIFIED` 只证明一次短探针通过，不代表真实任务可完成，也不代表其他型号可执行。

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

验证：真实 PG/HTTP 集成 4 项（捕获→重放→变化比较不产生第二套状态；跨作用域/非法输入/归档拒绝；成果版本引用的 `CURRENT`/`SUPERSEDED` 与新旧并存；应用角色插入 NULL 脏引用被 CHECK 拒绝）、迁移 8 项与 CLI 迁移台账 45 行、API 单测 136 项。接续点集成连续 3 次运行全绿。独立验收过程与两轮结论见 [N01 验收记录](../../testing/n01-independent-acceptance.md)。真实 Windows 人工路径未做。

