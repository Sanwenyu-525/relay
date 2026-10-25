# HTTP 与应用命令契约：分册 04

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../http-command-contract.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

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

验证：真实 PG/HTTP 集成 3 项（建组→重放不产生第二个组→逐项应用后部分成功如实呈现且 Task 修订只推进一次；未登记目标/重复目标/来源变化后再建组/跨作用域读取被拒；组合检查绑定确切版本集合、正常路径不产生「登记引用不存在」缺口、该边确实消失时缺口出现、并逐项列出无验证会话的缺口）。迁移与 CLI 台账基线随目录当前 51 行（`cli.integration.test.ts` 的迁移清单此前停在 0047/47 行、已落后于实际库，本轮更正；该显式清单是「CLI 不重复应用已落地迁移」的回归断言本身，每新增一个迁移都需同步）。真实 Windows 差异审阅与 PV08 体验记录未做。首轮独立验收结论为 CHANGES_REQUESTED，唯一阻塞项（登记引用缺口核错父版本造成每项假缺口）与两项 P3 已修复并复跑，独立复验结论见[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

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

验证：真实 PG/HTTP 集成 5 项（导读 `PINNED` 与 `CURRENT` 可分辨、知识新增版本后 `PINNED` 仍解析到钉住版本并标 `STALE`、`CURRENT` 跟随当前、保存不改写被引用对象也不新增知识版本、旧修订 409 与同命令重放；错配目标/重复条目/跨 `PINNED` 组合/跨项目引用 409 与五种脏行被 CHECK 拒绝；跨 Workspace 读写 404、被替代的决定标 `SUPERSEDED` 且不静默换成新决定；候选只提示不合并且提示后既有知识版本数不变、接受后版本 +1 且旧版本不被覆盖、已接受/已拒绝/来源变化后均不能再接受、跨项目成果不能提候选、**拒绝后读取报 `REJECTED` 且 `stale_reason` 为空**、**工作空间级同名知识不作为建议归入目标**；**接受与拒绝并发 3 轮只能得到一个结论，被拒候选不留孤立知识版本；同 `command_id` 顺序重放与并发接受都返回原回执且只产生一个知识版本；同 `command_id` 并发保存导读只推进一次修订**）。迁移与 CLI 台账基线补至 53 行。前端已接入：知识页「项目知识导读」开关内为编排视图，成果版本谱系页底部为整理候选面板，交互见[工作台交互第 12.4 节](../../frontend/workbench-design/part-03.md#124-项目知识导读n03-形态2026-10-02规划已确认前后端均已接入)。真实 Windows 阅读与 PV03/PV08 体验记录仍未做，**没有使用收益结论**。

首轮独立验收结论为 CHANGES_REQUESTED，发现 1 个 P1（接受不锁候选行，与拒绝并发时被拒候选仍产生知识版本且该版本在候选审计链上无归属）与 4 个 P2（拒绝态在读取模型中丢失、接受与保存的同 `command_id` 并发/重放不返回原回执、工作空间级同名知识造成永久死路），均已修复并由上述并发与终态用例覆盖。独立复验结论见[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

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

验证覆盖见[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。本节不含本轮运行结果。

### 10.56 Run 工具调用只读投影（2026-10-04 设计，2026-10-05 源码实现）

**Breaking Change: No**。新增一个只读 GET 端点，不改任何已有路由、请求体、响应体或状态语义。配套迁移 `0057` 只增加 Run 刷新事件的来源，不改 `run_tool_calls` 表结构（物理设计归[第 60 节](../../database/physical-design-postgresql.md)）。

`ReviewSchema` 同期新增一个可空字段 `operation_id`（`ACTION_APPROVAL` 绑定的确切动作身份，其它 kind 为 `null`）。这是**只增不改**：既有响应多一个可能为 `null` 的字段，消费者按缺失即 `null` 处理。工具轨迹按它把审批挂到对应那次工具调用上，而不是靠时间或文案猜测。

`GET /runs/{run_id}/tool-calls`

协作页用它呈现「模型这一轮实际做了什么」，交互规则归[工作台 §18.8](../../frontend/workbench-design/part-07.md#188-工具轨迹的呈现2026-10-04c-片设计)。它是纯只读投影：不创建、不修改任何状态，不新增权限、审批或控制意图。

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

本节不含本轮运行结果；验收规格归[测试计划 §20.4](../../testing/verification-plan.md)。

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

**Breaking Change: No**。新增一个只读投影端点与第三种 Gateway origin，不改任何已有路由、请求体、响应体或状态语义。配套迁移 `0058_m06_user_action_origin.sql` 只放宽三条 CHECK（物理设计归[第 61 节](../../database/physical-design-postgresql.md)）。

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

验证覆盖见[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。本节不含本轮运行结果。

### 10.60 会话模式与人设助手（2026-10-05 源码实现）

Breaking Change：Yes（语义）。取舍见 [ADR-018](../../decisions/ADR-018-assistant-conversations.md)，工程责任见[运行架构 §2.6](../../architecture/runtime-context/part-01.md#26-会话级只读工具轮次)。

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

验证覆盖见[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)；未运行规格见[测试计划 §23](../../testing/verification-plan.md)。本节不含本轮运行结果。

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

Breaking Change：**Yes（限 `daily-view-confirmations`，见 §10.62）；本节为新增端点与新增可选字段**，迁移 `0062`＋追加迁移 `0064`/`0066`（新增列与放宽 `change_kind` CHECK），既有 State 命令的可用动作集合新增 `ADD_BLOCKER`，原合法请求保持兼容；客户端与契约测试的动作枚举须同步。`relay_app` 对两张新表只有 SELECT/INSERT/UPDATE。真实 PG 集成覆盖见[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)；规格见[测试计划 §24](../../testing/verification-plan/part-05.md#24-自然语言状态维护与自动接续验收规格)。

### 10.62 返回项目的日常查看基线与接续卡（2026-10-09 源码实现，2026-10-10 整改）

迁移 `0063` 单表 `project_daily_view_baselines`：每项目一行「上次实际查看确认」，保存展示时的 `viewed_state_revision`、必要版本引用（`viewed_fact_refs`）与该次展示的服务端序号 `viewed_presentation_seq`（追加迁移 `0065`），`unique(workspace_id, project_id)` + `unique(workspace_id, presentation_id)`。确认针对**这份已展示结果**；确认载荷的 `viewed_fact_refs` 由客户端回显本次展示的 current，服务端不与当前库状态核对（它是「看到了什么」的事实）。

**可信读取顺序（迁移 `0065`）。** `GET /daily-continuation` 每次读取签发一个按项目递增的展示序号 `presentation.presentation_seq`（新表 `project_daily_view_presentation_counters`，同表记录已签发上限），投影新增 `presentation`。推进条件是**两个维度同时成立**：展示序号严格大于基线，且 `viewed_state_revision` 不倒退——所以 State 不变而任务集合变化时也能推进基线（已查看的变化不再反复报新增），同 State revision 的迟到旧确认（序号更小）不会覆盖新查看结果；顺序由服务端签发，不用客户端时钟，超出已签发上限的序号 422。同一 `presentation_id` 重复确认仍由唯一约束回放。

| 端点 | 命令类型 | 说明 |
|---|---|---|
| `POST /projects/{project_id}/daily-view-confirmations` | `ConfirmProjectDailyView` | body 必须带 `presentation_seq`；幂等：同 `presentation_id` 回放；`viewed_fact_refs` 形状非法（缺 phase_key / open_task_ids 超 200 / 负计数）422；未签发的序号 422 |
| `GET /projects/{project_id}/daily-continuation` | — | 当前事实（State/未终结任务/未决 blocker 计数）+ 本次展示身份 `presentation` + 基线 + `delta`；无基线 `baseline`/`delta` 为 null，不凭时间猜测变化 |

**任务集合的捕获上限。** `current.open_task_ids` 超过 200 条时截断并置 `current.open_task_ids_truncated=true`；delta 侧只要当前或基线任一侧不完整，就置 `delta.open_tasks_unknown=true` 并把新增/关闭留空——不把「没比出来」显示成「没有变化」，`viewed_fact_refs` 也接受并回显该截断标记。

命名接续点（N01）行为不变：日常查看不重设、不消费命名点。Breaking Change：**Yes**——确认端点新增必填 `presentation_seq`，投影新增 `presentation`、`current.open_task_ids_truncated`、`delta.open_tasks_unknown`、`baseline.viewed_presentation_seq`；仅使用本项目客户端的调用方需同步，其余为新增字段。追加迁移 `0065`（新表 + 基线加列）。真实 PG 集成与组件覆盖见[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

### 10.63 独立复验整改：拒绝终态、解释基线前置、撤回链与展示签发绑定（2026-10-10 源码实现）

依据整改任务书 `prompts/remediation/natural-language-state-maintenance-acceptance-20261010.md` R1–R6（追加迁移 `0067`，见[物理设计 §68](../../database/physical-design-postgresql/part-03.md#68-0067-复验整改declined-终态解释基线前置与展示签发记录2026-10-10-源码实现)）：

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

`daily-view-confirmations`/读投影字段不变；三个新 `change_kind` 与 `return-reviews` 为**新增**（Breaking Change：**No**——既有调用方不受影响，`change_kind` 词表开放扩展的解析端需同步）。真实 PG 与组件覆盖见[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)；规格见[测试计划 §24](../../testing/verification-plan/part-05.md#24-自然语言状态维护与自动接续验收规格)。

