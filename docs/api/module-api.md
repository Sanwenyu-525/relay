# 信息、计划、工作台与配置 API 补充

日期：2026-09-19。状态：Proposed。沿用[核心 API](http-command-contract.md)的 W 前缀、command_id、revision 字符串、回执和 Problem Details；不重复定义通用语义。Breaking Change：待与原件/实际实现核验。

## 1. 端点与约束

| 资源 | 读取 | 写命令（均 POST，含 command_id） | 特殊校验 |
|---|---|---|---|
| Goal | /goals、/goals/{id} | /goals；/goals/{id}/revisions、/archive | revision；被引用归档保留历史 |
| Project Goal | /projects/{id}/goals；/goals/{id}/projects（反向读该目标涉及哪些项目） | /projects/{id}/goal-links、/goal-unlinks | 解除带影响清单和处理方式，锁下重新核对 |
| Task 对齐 | Task 查询携带 alignment | /tasks/{id}/goal-alignment | mode=INHERIT/EXPLICIT、goal_ids；校验子集 |
| Task 元数据 | Task 查询 | /tasks/{id}/planning-metadata | priority、due_local_date、timezone；不改验收 |
| Task 交互模式 | Task 查询携带 mode | /tasks/{id}/interaction-mode | HUMAN 可选 ME/AI_ASSIST；DELEGATE_AI 只能由 Delegate 用例设置 |
| Task 依赖 | /tasks/{id}/dependencies | /tasks/{id}/dependency-links、/dependency-unlinks | expected_revision；禁止环；影响活动 Run 时重查执行合法性 |
| 项目/任务范围 | 原资源查询 | /projects/{id}/archive；/tasks/{id}/move | 活动执行/未知动作拒绝，清理受影响引用 |
| Knowledge | /knowledge、/knowledge/{id}/versions | /knowledge；/knowledge/{id}/versions、/archive | source_kind 与来源范围；内容导入异步可返回 202/job_id |
| Memory | /memories、/memories/{id} | /memories；/memories/{id}/revisions、/retire | 明确用户确认；禁止模型自动写入 |
| Decision | /decisions、/decisions/{id} | /decisions；/decisions/{id}/supersessions | rationale、replacement；同事务替代，禁止环 |
| Rule | /rules、/rules/{id}/versions | /rules；/rules/{id}/versions、/retire | scope/strength/enforcement/applicability；authority 锁 |
| 搜索 | /search?q=…&project_id=…&types=… | 无 | 作用域过滤、版本化命中、游标 |
| Today | /today?date=…&timezone=… | /task-selections/{task_id}；/focus-selections | Pin/Later/clear 和日期焦点，独立 selection revision |
| Workbench | /projects/{id}/workbench?kind=… | /view-configurations | 只改显示；执行配置单独 API |
| 执行配置 | /execution-configurations、/{id}/versions | /execution-configurations；/{id}/versions | 冻结版本，活动 Run 不隐式改绑 |
| Assist | /assist-sessions/{id}/messages | /assist-sessions；/{id}/messages | 请求异步 202，返回 message_id；GET 消息查生成状态 |
| 提案 | /proposals/{id} | /proposals/{id}/accept、/reject | base_revision/target_hash；接受复用业务命令 |
| 人工 Inbox | /review-inbox | 无独立写入口；分发至对应 Review/Proposal 命令 | 返回 item_kind、源 ID、目标/版本、阻塞性及 allowed_actions，不复制决定状态 |
| Activity | /activities?project_id=…&task_id=… | 无 | 有界分页、脱敏 |
| Trace / Lineage | /runs/{id}/trace；/artifact-versions/{id}/lineage | 无 | 只读引用，不暴露隐藏思考或密钥 |
| 完成凭据 | /completion-records/{id} | 无 | 读取确切历史验收、人工判断或验证会话和产物版本；来源缺失显式不可用 |
| Connection | /connections、/{id} | /connections；/{id}/test、/disable | test 只做指定健康检查，不测试写副作用；secret_ref 不返回密钥 |
| Permission | /permission-policies、/{id}/versions | /permission-policies；/{id}/versions | 不由批准动作修改，遵守 authority 锁 |
| 资源 | /managed-resources | /managed-resources；/{id}/disable | 规范路径/重叠核验；存在 claim 不可直接停用并丢记录 |

短表中的 /{id} 和追加路径相对同一资源集合，不是字面路由。OpenAPI 生成时必须展开完整路径，每个 operationId 唯一。创建 201、同步更新 200、长导入/生成 202；真实 schema 与示例按本表和主设计生成，不能把整个表用一个无类型 command endpoint 实现。

P09 当前 Fake Gateway 已把上述 Connection/Permission/资源集合落为 Project 内路径 `/api/v1/workspaces/{workspace_id}/projects/{project_id}/...`；请求和 DTO 见 [HTTP 契约](http-command-contract.md) 10.11 节。`GET /import-jobs/{id}` 当前只读内部创建的类型化 Fake 来源，完整 URL 导入命令、知识版本与异步完成仍属 P17。该分期差异不改变本节对真实导入的目标契约。

P10 已把 Knowledge/Memory/Decision/Rule 的本地写入、根/版本读取及 `/search` 落地；精确请求、回执和错误见 [HTTP 契约](http-command-contract.md) 10.12 节。当前 KnowledgeVersion 不提供 `retrieved_at`、提取器版本或 URL 来源，`source_uri` 也没有公开读写值；NOTE/MANAGED_TEXT 返回媒体类型与正文摘录，ArtifactVersion 引用返回 `excerpt=null` 和对象形 `source_refs`。这属于 P10 本地来源的明确分期，不能把 P09 Fake USER_IMPORT 结果当作知识版本。**Breaking Change: No**（本节新增实现说明，不改变已有 P09 端点）。

## 2. 新增长任务，不混入 Run

Knowledge URL 导入使用 import_jobs：id、workspace_id、project_id、用户主体、配置版本、source、status（QUEUED/RUNNING/SUCCEEDED/FAILED）、error、knowledge_version_id?、request command_id。URL 导入必须选择唯一 Project；note/受管文本保存仍可在 Workspace。公开 GET /import-jobs/{id}；相同导入命令返回同 job。获取公共资料经 Gateway 的相应受控读取路径；没有 Task Run 时使用显式用户导入的主体与作用域，不能伪造 Run 或绕过 Permission。

用户导入的 Web 读取不是自主 Task 执行，Gateway 应使用 InvocationOrigin（RUN 或 USER_IMPORT）类型化来源；RUN 校验 epoch，USER_IMPORT 校验用户/配置/取消及同作用域权限。数据库引用对应 job，不能用空 run_id 表示“免检查”。此为 Gateway 入口细化，内部动作/核对协议不变。

Assist 消息生成状态保存于消息/请求记录，不改 Task 生命周期；只读模型调用可能失败，查询返回错误原因。用户关闭 Panel 不等于撤销已完成提案；取消生成是请求级行为，不产生 Handoff。

## 3. 最小 DTO

KnowledgeVersionDTO：id、knowledge_id、version、source_kind、source_uri?、content_sha256、retrieved_at?、availability、excerpt、source_refs。Memory/Decision/Rule 返回具体类型字段，不用一个无类型 content_json。

TodayDTO：date、timezone、selection_revision、eligible_items、waiting_items、blocked_pinned_items；每项 task_id、task_revision、reason_codes、evidence_refs、allowed_actions。查询不写入“推荐状态”。

WorkbenchDTO：kind、view_revision、project_state、dependency_versions、registered_panels、capability_availability。执行配置 ref 单独展示，不由 kind 派生覆盖。

ProposalDTO：id、kind、target_ref、base_revision、payload、target_hash、evidence_refs、status、allowed_actions。它聚合不同 Owner 的类型化提案，State 仍由 state_proposals 管理。接受按当前作用域重新鉴权；提案生成者不等于执行批准者。Review Inbox 合并需人工 Review 与非阻塞提案；展示阻塞性差异，不能把非阻塞阶段建议误当完成条件。

## 4. 跨接口一致性

附加错误：RULE_CONFLICT、RULE_ENFORCEMENT_UNAVAILABLE、CONTEXT_REQUIRED_OVER_BUDGET、GOAL_LINK_IN_USE、DEPENDENCY_CYCLE、PROJECT_ACTIVE_EXECUTION、SOURCE_UNAVAILABLE、CAPABILITY_DISABLED。仍使用核心 Problem Details，不为模块返回不同 envelope。

长导入/Assist 是任务本身的资源，不统一塞入 Gateway logical_operation 状态；Gateway Operation 表达一次外部动作，两层有关联但生命周期分开。完成异步资源后回执仍是原 202，最新结果通过资源 GET 读取。

## 5. Skill 与蓝图提案

2026-09-20 提出设计；2026-09-26 已有只读 Skill/Pack 注册与 Assist 调用、当前 Task Skill 建议接受/CheckPlan 准入预览、内置 View Owner 及 Project Blueprint 候选/Preview/Diff/原子 Apply 的后端开发自检。实际 HTTP 字段见[核心 API §10.31–10.34](http-command-contract.md)。Breaking Change：No（新增端点与可选 Skill 输入；普通 Assist 请求/回执不变）。下列旧 `/proposals/{id}/accept` 方案未成为蓝图生产路由，以实际独立蓝图资源为准。

- 已实现的 Assist 消息请求可选 `skill_ref`（id、version）和 `skill_input`。服务端解析随包注册的受信定义/摘要与依赖，不接受客户端授予的权限或任意路径；生成仍返回原 202/message_id，GET 原消息读取状态和类型化只读/建议输出，不新增 `/skill-runs`。当前 Task Skill 可产生待人工确认的 `TASK_CONTRACT_CHANGE`/`VERIFICATION_PLAN_CHANGE`，普通 Assist 与 Project Resume 不因生成而写业务事实。
- 当前蓝图使用独立 `POST/GET /projects/{project_id}/blueprint-proposals` 与详情 GET。Proposal 固定 candidate/baseline/source/hash，服务端 Diff 显示 Goal、State、局部新 Task、解析后的 View pages；历史初稿提出的通用 `PROJECT_BLUEPRINT` AssistProposal 分支并未实施。生成修改需新建候选，可显式替代仍待确认的前一候选。
- 实际应用路由是 `POST /projects/{project_id}/blueprint-proposals/{proposal_id}/apply`，携带 command_id、candidate_sha256 与 Project/State/View 三个 expected revision，不夹带未预览补丁。成功回执返回三者新 revision、新 Task 局部键到真实 ID 映射与应用来源；不返回“Rules 已启用”或“Run 已启动”。
- 实际拒绝路由是同资源的 `POST .../{proposal_id}/reject`。首次接受重核当前来源、冻结定义/Pack 与各对象基线；冲突 409，未知注册引用/结构非法 422，跨 Workspace 不可见 404。错误回滚所有本地效果，不自动删掉非法字段重试。

同 command_id 同内容按既有回执重放；另一个 command_id 再接受已 ACCEPTED 提案返回其既有应用引用，不再次创建任务，且请求目标 hash 必须匹配。同 ID 不同内容仍为 COMMAND_ID_REUSED；拒绝/过期提案不能被新 command_id 复活。应用协议以 [Skill 专题](../architecture/relay-skills.md)为准。

首批 Skill 沿用同一 Assist `skill_ref` 入口：Task Definition 与 Verification Plan 返回严格类型化的建议消息，Project Resume 返回生成时重新读取当前 State/Task/有效 Decision/Verification 等事实与版本引用的只读消息；没有比较基线时不生成“自上次以来”的变化。当前 Task 建议由 `POST /assist-proposals/{id}/accept` 携带 Task 与 acceptance 双版本及 payload_hash，交 Task Owner 增加新验收版本；原 `PROPOSE_TASK` 的 `TASK_DEFINITION` 仍只创建新 Task。`goal-to-project-blueprint@1.0.0` 绑定 Project Assist，会生成原消息类型化输出并在同一结算事务建立独立 Blueprint 候选，仍须另行人工确认摘要与基线后 Apply。`verification-plan@1.0.0` 是只读历史，新建议使用 1.1.0；`task-to-execution-contract@1.1.0` 可建议 Expected Result 描述，服务端保留旧产物种类和其他约束。Skill 输出不是有效 ExecutionContract/CheckPlan，Delegate 仍独立核对并冻结。Decision 候选后续分发 Information 入口，State 推断复用 state_proposals。修复复用原 Run 步骤，Handoff 复用控制命令，不新增可直接写有效检查计划、执行者或确定性 delta 的端点。本段 Breaking Change：No。

扩展模型补充：Pack 选择与 Profile 引用只能使用服务端注册身份；蓝图候选 `source.pack` 保存解析版本、摘要和成员清单，不能由客户端声称已授权或兼容。提案预览绑定目标与依赖版本，应用时重核；规则/执行配置不随蓝图静默生效，视图变更由 View Owner 同事务处理。V1 不新增 SKILL_INSTALL/PACK_UPDATE 通用写端点或任意 payload 分发器。轻量来源查询复用 Manifest/Trace 读取能力，须对历史内容和排除信息重新鉴权。通用 Pack 配置应用仍为后续设计；本次 Breaking Change：No，不代表已做客户端兼容实测。

P11 已新增 Run 下 `GET /context-manifests` 与 `GET /context-manifests/{manifest_id}` 的只读来源投影，当前字段和权限语义以[HTTP 契约 §10.13](http-command-contract.md)为准。Profile 仅有服务端固定 `run-default@1`；Assist、显式资料选择、首批 Skill/Pack 只读入口、当前 Task Skill 建议接受及 Blueprint 原子 Apply 已分别落地，不能从历史 Manifest 中的 `skill:null` 推断当前注册能力。通用 Pack 配置应用仍待做。Breaking Change: No。

P15 的完成凭据详情已有独立只读 `GET /completion-records/{id}`；Task 的 `current_completion_id` 和 Lineage 的 `ACCEPTED_BY` 可指向此确切历史 ID。读取时重核当前 Workspace/Task 与受管内容，重开不删旧凭据，来源不可用不拿新版本代替。实际字段与错误见[HTTP 契约 §10.40](http-command-contract.md)。Breaking Change: No。
