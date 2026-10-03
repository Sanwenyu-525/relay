# 功能验收汇总与历史记录

更新：2026-10-03。角色：唯一功能验收结果汇总。阶段与模块进度归 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)，验收规格归[测试计划](verification-plan.md)。各行通过结论仅覆盖注明的运行时点、环境和版本；本轮工作主线 UI、此前重点整改与旧目录包证据分别绑定，其他历史成绩没有因此重新验收。

## 当前功能验收表

状态：**已通过**表示所列范围有实际通过记录；**部分通过**表示分片通过但完整出口未闭合；**未通过**表示受验基准仍有失败；**未验收**表示缺相应环境或完整验证；**未接入**表示所需入口/协议尚未实现。历史失败修复后保留历史，不把旧红灯当作当前已复现缺陷。

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 产品 Agent 公共提示词运行接入（2026-10-03） | 已通过（源码/工程接线）；真实模型质量未验收 | 用户明确授权后新增 [公共核心 1.0.0](../../apps/api/src/workflow/agent-system-prompt.ts)，Assist 对话/提案、第一方 Skill、DRAFT、原请求解释实际引用；原 Markdown/JSON schema、Gateway/Run/完成 Owner 保留，语义检查独立。DRAFT 的 CANONICAL＋五类事实/约束白名单与外部数据标签已区分；解释明确缺现有文件内容时澄清。固定 Node 24.21.0：`tsc -p apps/api/tsconfig.json` exit0；定向四文件 **31/31**，包含受控 SDK transport 的真实消息/JSON/预算拒绝断言；设置原 `RELAY_FILE_IO_HELPER` 后 `node --test apps/api/dist/test/unit/**/*.test.js` 全 API **325/325**、exit0。`run-integration.ps1 -SkipBuild -TestFile assist -UseCLocale` **45/45**、文件夹对话同入口 `-TestFile folder-first-conversation` **5/5**，均 exit0，53 migration/Graph/PG 启停与临时根清理通过；对话/Skill/解释实际请求、来源隔离、无业务写入与原身份重放有新增断言。指定 gpt-6.1-sol 只读独立代码复核无阻塞；完整单元输出留本机忽略目录 `output/acceptance-raw/agent-prompts-20261003/api-unit.log` | 工程测试使用受控 transport/Fake，不证明真实模型意图判断、提问节奏或质量；文件夹 Fake 强制 PREPARE 不证明新缺内容规则能正确 CLARIFY。未外呼真实 Provider、未重启当前桌面/服务、未重建冻结包；已有窗口不会自动加载新编译代码。公共核心版本在源码，调用账本完整提示词摘要/动态读取准备/工具循环/连续授权仍待接入与验收。设计文档只链接源码正文，**Breaking Change：No**，M04–M07 总出口不变 |
| F24 第一方 Skill / Blueprint / Pack 接续复验（2026-10-02 修复轮） | 部分通过（两处幂等缺陷已修并复验；蓝图真实模型已定向通过；真实 Windows 未跑，稳定性未闭合） | **修复与复验**：两处缺陷的根因都是「同 `command_id` 的并发请求都在**加候选锁之前**查过回执，输的一方拿到锁后不再重查」。修法统一为取得候选行锁后立即重查同 scope/command 回执、存在则沿 `resolveExistingReceipt` 返回原结果；未用捕获异常伪造成功，也未放宽异内容的 `COMMAND_ID_REUSED`，维护准入/来源/执行权/版本/摘要校验都在该位置之前完成。**新增正式回归** [f24-proposal-idempotency](../../apps/api/test/integration/f24-proposal-idempotency.integration.test.ts)（真实 PG + HTTP）：测试自己 `for update` 占住候选行，用 `pg_stat_activity` 沿阻塞链（后到者排在先到者之后，不能只数直接被本连接挡住的会话）确认两个 API 会话都已排队后才 `commit` 放行，轮询上限压在 4 秒——产品的维护准入会把事务内 `lock_timeout` 设成 5s，等锁更久会变成 lock_timeout 错误而不是等待。**先跑红**：修复前 Assist Task Skill 返回 200＋**409 INVALID_TRANSITION**、蓝图 Apply 返回 200＋**500 INTERNAL_ERROR**，与独立验收报告逐字一致；**修后 5/5 PASSED**、exit0：同命令同内容两个 200、业务效果与回执各一次（验收只前进一版 / Task 只两条 / 蓝图审计 1 条 / 回执 1 条）、同命令异内容 200＋409 `COMMAND_ID_REUSED` 且只留胜出那一次效果、不同命令竞争保持既有协议（各自回执、后到者按已接受候选重放、效果只一次）。**第四项蓝图的真实模型定向测试**（本轮新增，不继承旧包前三项成绩）：[real-model-skills](../../apps/api/test/integration/real-model-skills.integration.test.ts) 用已有授权配置与合成项目跑 `goal-to-project-blueprint@1.0.0`，**4/4 PASSED**、唯一 Provider 尝试 `COMPLETED`、非零用量与 request ID 齐全。断言生成只写候选（业务快照逐字节不变、零 Run/产物/完成/检查）、候选 `origin=SKILL` 且冻结 Skill 与 `development-minimal@1.3.0` 的 id/version/sha256、只建议 1–5 个 HUMAN/ME/INBOX Task 与内置 view kind、只读预览与 Diff 不写事实、**基线不符的确认 409 且不留部分效果**、显式 Apply 后 Goal 只关联已存在目标、Task 全为 INBOX/ME/HUMAN 且无一被委托、重放同命令只读回执而审计仍各 1 条、**选择 Pack 后策略/连接/能力仍为 0**、取消持久化后不产生候选且业务事实不变。为让蓝图可测，测试用生产建项目命令另建项目——内置 View 行只有该命令会种下，共享 fixture 上补写视图行会绕过真实前置。受影响回归：`project-blueprint` **5/5**、`assist` **45/45**、API 单元（固定 Node 24.21.0 + `RELAY_FILE_IO_HELPER`）**325/325**、全前端 **79 文件 607/607**、两端 `tsc --noEmit` 与 `check-docs.mjs` exit0 | **真实 Windows 未跑**：本轮未重建发布包（`lib.rs`/`Cargo.toml` 正被并行修改，重建会产生与现有安装不一致的身份），本会话也没有原生窗口控制手段，因此「当前确切包」的生成/预览/差异/显式接受/取消与恢复，以及真人质量判断**均未验**。**稳定性未闭合**：同一固定配置下 `task-to-execution-contract@1.1.0` 真实调用 **10 次中 7 次通过、3 次 `OUTPUT_SCHEMA_INVALID`**（Provider 侧 `COMPLETED`、用量与 request ID 齐全，失败在本地严格解析、不留业务效果），被拒字段仍未定位，不称已修复；蓝图候选生成 **7 次真实调用 7 次满足严格契约**。四项 Skill 的重复次数与质量评分标准本轮**未冻结**，故只有契约合规性有证据，语义质量与可读性无评分。`assist-proposals` 的非 Task Skill 旧接受路径未新增并发反例（本轮只覆盖被报告的两条路径）。独立验收仍待指定 `gpt-6.1-sol`（当前账号不支持，未静默降级）。本行不推进 M04–M07 总出口，也不前移通用 Pack 配置应用、Page Schema、Importer、自动 Trigger 或第三方插件 |
| root-bound 能力配置入口（2026-10-02） | 已通过（配置入口范围）；Git/CLI 动作仍未接入 | **发现的缺陷**：连接与权限页的 capability 列表只有 `WEB_FETCH`/`FILE_READ`/`FAKE_WRITE`/`FAKE_PUBLIC_READ`，用户无法为本项目创建 `FILE_WRITE`/`GIT_READ`/`GIT_WRITE`/`CLI_RUN` 连接——而 2026-10-01 的文件夹入口对话执行在缺 `FILE_WRITE`/`CLI_RUN` 连接时按服务端 409 拒绝该目录，等于该能力无法从产品内配置。服务端 `resolveConnectionConfig` 早已把这 5 项认作 `rootBoundCaps`，HTTP schema 也早已接受，是前端词表落后。改 `relayClient.ts` 的 `RelayGatewayCapability` 为 8 项，`ConnectionsView` 按同一 `rootBoundCaps` 展示：root-bound 必填目录且只提交 `root_path`，`WEB_FETCH` 只提交 `allowed_host`，Fake 不提交边界；策略侧除 `WEB_FETCH`/`FAKE_PUBLIC_READ` 外必须选 ACTIVE 受管资源（顺带把原来只判断 `FILE_READ` 的 `isFileCapability` 改成与 `policyScope` 一致的「除公共读取外都要资源」）。**新增真实 PG 集成反例**（`gateway.integration.test.ts`）：`GIT_READ`/`CLI_RUN` 连接经 HTTP 建连接、查询与详情都不回显目录、混入 `allowed_host`／混入 `WEB_FETCH`／缺目录／目录不存在四种 422、`FAKE_WRITE` 带目录 422、`GIT_READ` 策略按受管资源落 `GIT_STATUS` 前缀且 `resource_id: null` 422。`run-integration.ps1 -TestFile gateway -UseCLocale` **29/29 PASSED**、exit0（build/迁移/Graph/PG 启停均 0、临时集群删除 True）；前端 `connectionsSettings` **13/13**、全前端 **78 文件 597/597**、两端 `tsc --noEmit` exit0；`check-docs.mjs` exit0 | **本行只闭合配置入口，不闭合 M06**：Git/CLI 动作触发协议仍无公开入口——`prepareGatewayAction` 只接受 `RUN`/`USER_IMPORT` 两种 origin，非 RUN 只放行 `FAKE_PUBLIC_READ`/`WEB_FETCH`，因此协作页工具面板「Git 变更」「交互终端」继续只声明限制、不提供可点按钮（Git 补齐需新增 origin 词表 migration 与准入/派发/核对分支；交互终端的受管 cwd、人工执行身份、进程生命周期、审计与断连恢复协议**仍为 Proposed，不在本次范围**）。未做真实 Windows、真实仓库动作与 M06 独立验收；本次单元/集成基线使用 `.research/runtime-cache` 里固定的 Node **v24.21.0**，而 PATH 上的默认 `node` 是 v22.22.3——用默认 node 跑 `npm test` 会因 `verifyBackupPackage` 的 `/^v24\./` 断言产生 12 例假失败，加上缺 `RELAY_FILE_IO_HELPER` 时另有 10 例；固定 Node 24 + 该 helper 变量下 API 单元 **320/320、0 失败、exit0**。这是复跑口径问题，未改 `package.json` 的 `test` 脚本 |

| N03 项目知识整理后端首片（2026-10-02） | 部分通过（工程自检；独立验收 P1/P2 已修复复跑） | 新增迁移 `0052_n03_project_knowledge_guide`（`project_knowledge_guides`、`project_knowledge_guide_entries`）与 `0053_n03_knowledge_curation_candidates`（`knowledge_curation_candidates`），`apps/api/src/application/project-knowledge-guide.ts`、`knowledge-curation.ts`、`apps/api/src/project/knowledge-guide-repository.ts`、`apps/api/src/api/project-knowledge-guide-api.ts`（7 个端点）、`information-repository.ts` 新增 5 个方法、`unit-of-work.ts` 新增 `knowledgeGuides`、`api-harness.ts` 新增 `put`。导读只存确切引用与人工标签，**不复制正文、不维护第二份 revision**；四类目标各一可空外键，`ref_kind` 与「恰好一个目标列非空」由 CHECK 用 `IS NOT NULL` 强制（刻意避开 `0044` 的 NULL 求值陷阱），去重靠 STORED 生成列 `target_id`（唯一约束里 NULL 互不相等，直接建 UNIQUE 会漏重复）。整理候选只由用户主动请求产生，只提示不合并，接受复用既有 `CreateKnowledge`/`AddKnowledgeVersion`。真实 PG/HTTP 集成 **5/5 PASSED**（首轮 + 连续 2 次复跑共 3 轮全绿），API `tsc --noEmit` exit0，`check-docs.mjs` exit0（117 Markdown、2500 链接、1557 锚点、137 token、31 对比度） | **首轮独立验收结论 CHANGES_REQUESTED**：1 个 P1（接受不锁候选行，与拒绝并发时被拒候选仍产生知识版本且该版本在候选审计链上无归属，真实 PG 3/3 复现）与 4 个 P2（拒绝态在读取模型中丢失导致工作台已确认规则无法实现；接受与保存的同 `command_id` 并发/重放不返回原回执，违反契约第 2 节；同标题的工作空间级知识使候选永久卡在「可建议、不可接受」）。**全部已修复**：接受改为「锁候选 → 复核 → 写知识版本 → 绑定候选 → 写回执」单事务（为此在 `information-commands.ts` 增加 `*InTransaction` 变体，不自开事务也不自写回执）；`status` 增加 `REJECTED` 与 `rejected_at`，终态优先于缺口；两处在取得 Project 行锁后重查回执；`buildSimilar` 排除工作空间级知识。修复后新增并发用例：接受/拒绝竞态 3 轮只能得到一个结论且被拒候选不留孤立版本、同 `command_id` 顺序重放与并发接受都返回原回执且只产生一个知识版本、同 `command_id` 并发保存导读只推进一次修订。**2026-10-02 前端已接入**：知识页「项目知识导读」开关内为服务端编排视图（`ProjectKnowledgeGuide.tsx` 重写），成果版本谱系页底部为整理候选面板（新增 `KnowledgeCurationPanel.tsx`），`relayClient.ts` 新增 6 个方法与 DTO，新增 `tests/projectKnowledgeGuide.spec.ts` 10 项全通过；workbench 全量 607 项中 606 通过。旧版客户端聚合导读按确认结论整体替换，因此**项目目标与流程说明占位文案不再出现在导读内**（N03 四类引用目标无 GOAL），并清掉随之失效的 `knowledge-guide__steps` 样式。**未在真实 Windows 应用内阅读，无 PV03/PV08 体验记录，没有使用收益结论。**`MISSING` 分支在当前 API 下不可达（`AddKnowledgeVersion` 拒绝归档知识、外键阻止删版本），已作为纵深防御登记。另有未修的 P3：条目不暴露被引用对象的适用范围（TASK 级规则读出 `title: null` 但不标明属哪个任务）、接受信封 `committed_at` 取响应时刻而非回执时刻、重复拒绝静默返回 200、`CROSS_SCOPE` 条目仍回传他项目标题 |
| Trace 500：桌面库停在 0048 而代码需要 0049+（2026-10-02） | 已修复并复验（工程范围） | 准备 N00 基线时发现 `GET /api/v1/workspaces/{ws}/runs/{run_id}/trace` 对**所有** run 返回 500。根因：桌面 dev 使用的 `relay_trial` 库只迁移到 **0048**（台账 48 行，末条 `0048_m07_admission_gate`），而 `a4409b1` 已让 trace 响应 schema 要求 `usage_cache_read_tokens`（0049 新增的可空列，迁移明确不回填）。`trace-queries.ts` 用 `selectAll()`，列不存在时该字段为 `undefined` 而非 `null`，`fast-json-stringify` 抛 `"usage_cache_read_tokens" is required!`，Fastify 记 `unhandled_request_error` 并返回 500。schema 本身写的是 `Type.Union([Type.Integer(), Type.Null()])`，**不是** schema 声明问题，而是库落后于代码。`information_schema` 核对：迁移前 `model_calls` 上 `usage_cache_*` 列数为 0，`first_text_delta_at`/`first_preview_persisted_at`(0047) 与 `runtime_admission_gate`(0048) 均在 | 经用户确认后显式执行迁移：先 `pg_dump -Fc` 取 `.relay-test/before-n00-trace-fix-20261002-151146.dump`（403,383 字节），再用 `RELAY_MIGRATION_DB_URL=postgresql://relay_migrator@127.0.0.1:6189/relay_trial` 跑 `node apps/api/dist/src/cli/migrate.js`，`applied` 恰为 `0049_m04_model_call_cache_usage`、`0050_n02_impact_candidate_groups`、`0051_conversation_execution_requests`；台账 48→**51**，立即复跑 `applied: []`（幂等，未重复应用），`usage_cache_*` 列数 0→**2**。三条均为只追加迁移，无 down migration，未改写任何已应用迁移、列或索引 | 属 **M04 范围**的库/代码不一致，不是 N00/N02 缺陷，本轮只是为取基线而修。**该 500 同时影响用户桌面窗口的 Run 轨迹面板**（同一库、同一代码路径）；因桌面 dev 的 bearer token 只在宿主内存生成、无法从外部调用，**未能直接复验桌面实例**，请自行打开一个 Run 的轨迹面板确认。修复只保证 Trace 可读，不代表 M04 总出口闭合，也不解除任何 M 阶段验收。为取基线另起了一个只读 API 实例（端口 3613，指向同一 `relay_trial`，token 随机生成、仅存于本机 temp 目录、不入库），用完应关闭；它不跑迁移（`main.ts` 只做 `SchemaReadinessChecker`），已在验证后保留待基线使用。N00 基线本身仍未测——`n00-task-set.json` 三条路径的 `runs`/`observations` 仍为空 |
| N00–N02 后续长期协作首轮（2026-10-02） | 部分通过（N01/N02 工程自检通过；N02 独立验收 CHANGES_REQUESTED 的唯一阻塞项已修复复跑；N00 基线未测） | **N00**：`apps/api/scripts/n00-baseline.mjs` 此前把「首字时间」列为不可持久化，与事实不符——Trace 自 0047 起已暴露 `first_text_delta_at`/`first_preview_persisted_at`。已按各自定义分别接入报告（领取→首文本、领取→首预览写入、无首文本调用计数），不再合并成「首内容」；仍不可得的受理反馈、实际 HTTP 发出、Provider 收包与屏幕可见时刻照旧标为未知。`node --check` 通过。**N01**：[独立验收记录](n01-independent-acceptance.md) 的 P1（`project-continuation.integration.test.ts:190-199` 成果版本断言按 `ref_kind` 取首条、随 UUID 排序在 v1/v2 间摇摆）已改为按 `ref_id` 断言；当前源码 `run-integration.ps1 -TestFile project-continuation` **连续 3 次 4/4 全绿**（build/迁移/graph 安装/PG 启停/临时集群清理均 exit0）。P3-1「提交结果恒待核对时本会话无退出路径」已作为已知规格缺口登记在[工作台 §15](../frontend/workbench-design.md#15-项目接续点n012026-09-29-开发自检)。**N02**：新增迁移 `0050_n02_impact_candidate_groups`（四张新表，只给应用角色 SELECT/INSERT）、`apps/api/src/application/artifact-impact-groups.ts`、四个新端点与 `ArtifactImpactCheckPanel` 的组/组合检查单视图。**首轮独立验收结论 CHANGES_REQUESTED**（验收者未参与实现，真实 PG/HTTP 共 4 次全绿）：唯一阻塞项为 P2「组合检查单的『登记引用在当前事实中不存在』缺口核错 lineage 父版本——用了变化后版本，而登记的直接引用是变化前版本的下游，导致正常路径每项都产生假缺口」。已改为按 `source_before_version_id` 复核，并新增两条断言：正常路径 `gaps` 不含该条、该边确实消失时缺口出现（后者用迁移连接删除登记边；**应用角色对 `artifact_lineage_edges` 只有 INSERT/SELECT，实测 DELETE 返回 42501**，这正是应有的栅栏）。同时补 P3：建组时先取来源成果行锁再复核基线（与 `startArtifactImpactCheck` 同序）；[工作台 §10.2](../frontend/workbench-design.md#102-跨成果候选组与组合检查单n02-首片2026-10-02-开发自检)与[契约 §10.52](../api/http-command-contract.md#1052-n02-跨成果候选组与组合检查单2026-10-02开发自检)按实际语义收紧推测项与缺口措辞。修复后 `run-integration.ps1 -TestFile artifact-impact-groups` **3/3 PASSED**（build/迁移/graph 安装/PG 启停/临时集群清理均 exit0）。既有反例覆盖：未登记目标 409、重复/空目标 422、来源变化后再建组 409、跨作用域读取 404、跨 Task 与组外版本 409、`overall_result` 在类型/API/客户端三层都无法变成整体 PASS、同一 Task 但验收修订不同的 PASS 会话不被采用（改为「在验收修订 N 下没有单项验证会话」）、撤销适用性产生失效缺口、来源变化后旧组不能再生成或应用候选。workbench `tsc --noEmit` exit0，`tests/impactCandidateGroup.spec.ts` **3/3**（部分成功显示、组合检查单显示整体无结论与缺口、拒绝服务端给出整体结论的响应）。API `tsc --noEmit` exit0。文档检查 exit0（115 Markdown、2356 链接、1528 锚点、136 token、31 对比度） | **N00 基线本身未测**：`n00-task-set.json` 三条路径的 `runs` 与 `observations` 仍为空，必须由用户按真实使用填写后才能产出基线；未测前不得声称省时或体验改善。**N01/N02 均未做真实 Windows 人工路径**，PV01/PV02/PV08 未运行；组合检查单与候选组视图的原生观感、缺口文案在真实窗口中的可读性未验证。N02 未覆盖候选间依赖联动、不完整选择的拒绝、组级回滚、外部格式来源；组视图内没有逐项生成/应用入口（按钮在同面板既有区块，一次处理一项），PV02 正向路径功能可达但不成组。**删除/失权反例不可达**：全仓 `apps/api/src/api/*.ts` 无成果删除入口，权限只有 Bearer + `workspace_id` 一层，无逐成果授权，故组读不存在「失权后仍读到受限内容」的可达路径。已知未修的 P3（不阻塞）：组合检查为算一个布尔量在事务内整份读入最多 20 份正文；上限常量 10/20 在 TypeBox schema 与应用层各写一份。工程自检不解除 M01–M07 出口，也不改变真实 Provider 与安装交付状态。**同批全仓红项归属**（数字随工作区移动，以复跑时为准）：`apps/api` 单测的失败全部是 `StorageUnavailableError: could not publish managed content` 与 native helper／维护准入门相关——本机 `RELAY_FILE_IO_HELPER` 未设置且 `apps/file-io-helper/target/.../file-io-helper.exe` 不存在，**设置该变量后 API 单测 320/320 全绿**，属环境缺件而非代码。前端全量失败集中在 `collaborationWorkspace.spec.ts`，该文件及其 `FolderScope.tsx`／`recentWorkingDirectories.ts`／`desktopHost.ts`／`ExecutionSummary.tsx` 属并行 Agent 的文件夹入口切片，隔离复跑仍红，不属本轮；`tasks.spec.ts`、`run-events.spec.ts` 隔离复跑通过，属共享负载下的时序波动。`cli.integration.test.ts` 的显式迁移清单此前停在 0047/47 行、**在本轮之前就已落后于实际库**，本轮补齐；并行 Agent 随后新增 `0051_conversation_execution_requests`，该清单再次需要同步（目录现为 51 行），这是共享清单的固有维护点，不是 N02 逻辑缺陷 |
---|
| Goal 工作空间级列表与跨项目反向读（2026-10-01） | 已通过（仅两个只读 HTTP 端点） | 新增 `GET /goals`（status=active 默认/archived/all，limit 1–100，排序键 (created_at,id) 倒序，游标绑定过滤条件与 Workspace）与 `GET /goals/{id}/projects`（返回该 Goal 当前关联的 Project，含已归档并以 `archive_status` 表达，字段取自既有 Project 事实）。`apps/api` `tsc --noEmit` exit0；`api-lists` 真实 PostgreSQL 集成 **4/4 PASSED**（含临时集群 build、业务 migration、graph 安装、启停与目录清理全部 exit0），覆盖分页与游标越界/换 Workspace 拒绝、limit 与 status 校验、未知 Workspace 与跨 Workspace Goal 404、未关联 Goal 返回空列表。测试中发现归档 Project 不能被 `goal-links` 写入（409 PROJECT_ARCHIVED，ADR-011 栅栏生效），用例改为先关联后归档 | 未涉及任何工作台 UI、Assist 会话、委托与产物路径；未做 Windows/安装验收。`apps/api` 单测当前 21 项失败来自并行进行的 `cacheCreationTokens` 改动（新增 `usage_cache_*` 列尚无 migration），不属本范围。文档检查当前因并行中的 `prompts/folder-first-conversation.md` 等引用未落地而失败，与本行无关 |
| 远程仓库凭据与隐私审计（2026-10-01） | 已通过（无真实凭据；两项历史隐私项已知并保留） | 推送 `619e7c7` 前对 `origin`（仅 `refs/heads/main`、无 tag、16 个提交）做全历史只读审计：扫描全部曾入库路径与全部提交的 `postgresql://user:pass@`、`RELAY_API_BEARER_TOKEN=<32+>`、`RELAY_MODEL_API_KEY=<16+>`、`sk-*`、`ghp_*`、`github_pat_*` 与私钥块。命中 11 个文件逐条核对**全为测试合成值**（`explicit-password`、`synthetic:synthetic-secret`、`diagnostic:do-not-print` 等），且只指向 `127.0.0.1`／`remote.invalid`／端口1；`.env.example` 仅有占位符；`docs/testing/evidence/m02/credential-rotation-*` 只有 SHA-256、PID、回环地址与 `tokens_differ=true`，无 token 值。推送范围 551 文件零真实凭据命中。本机编译产物已由 `.gitignore` 新增 `/apps/api/output/acceptance-raw/` 排除（1213 个独立 dist JS 未入库），用户 PG 与 DesktopDev 未受影响 | 两项**非凭据**隐私项只存在于远程历史、当前 HEAD 与工作区均已干净且被忽略：`output/playwright/agent-audit/desktop-setup.out`（`7949de4` 加／`2bc5023` 删，initdb 日志含本机 Windows 用户名 `ASUS` 与本地临时/盘符路径）与 `.tmp-desktopfix/desktop.env.cleaned`（`52e31f7` 加／`2bc5023` 删，含 `postgresql://relay_app@127.0.0.1:6189/relay_trial` **无密码** DSN 与 workspace UUID）。经用户决定保持现状、不改写历史：清除需改写全部 16 个提交并 force-push 已推送的 `main`，`git-filter-repo` 亦未安装，代价大于收益。另 `docs/testing/evidence/m02/desktop-build-manifest*.json` 4 个文件被跟踪但命中 `.gitignore`，属历史遗留本机构建清单。本行只是凭据与隐私审计，不是功能验收，也不覆盖 GitHub 侧账号安全、协作者权限、分支保护或既往提交（`52e31f7` 之前）的独立复核 |
| 连续工作区真实 Windows 页面独立复核（2026-10-01） | 部分通过（代表页面与基础交互通过） | 按用户指定聊天的连续工作区范围，由 computer-use 操作已运行的真实 DesktopDev 窗口：debug `relay-desktop.exe`、PID67772、窗口2163816、Vite5173与本机API；不是目录测试包或浏览器fixture。本聊天原生截图与可访问性观察覆盖项目列表/总览、General/Thesis/Development三工作台、Task/Artifact、Run/待处理、资料、设置/连接。最大化截图1536×816与还原截图1162×782的所检页面未发现明显横向裁切，这些尺寸不作为CSS/DPI测量。已有会话的中文未发送草稿在双栏→对话→成果→双栏后保持，Shift+Enter换行，离开时保留草稿提示及返回继续编辑通过；仅清空本次从空输入建立的验收草稿。分隔条拖动52→58、Tab可达及可见焦点、Left变56、双击复位52通过。T2已保存v3→v1标题/正文同步、Escape收起历史面板；Ctrl+K中文资料搜索在异步结果返回后呈现4条匹配资料，Esc返回；新建任务读取两个项目后仍可滚达验收/保存区，未保存。既有Run的PAUSE显示PENDING、仍由AI执行及等待安全点，未误显示已暂停/接手完成。只读源码复核由指定gpt-6.1-sol完成；零消息发送、任务创建、审批、委托或Provider调用，桌面与原服务保留运行 | 两处阅读体验待改：普通AI最终回复字面显示 `**CANCELLED**` 与列表符号（[正文入口](../../apps/workbench/src/views/AssistView.tsx)，尚无明确最终消息必须Markdown渲染的契约，记体验问题）；资料“保存于”和Run步骤时间原样显示UTC ISO串（[资料入口](../../apps/workbench/src/components/KnowledgeReader.tsx)、[运行入口](../../apps/workbench/src/views/RunView.tsx)），待统一人类可读展示，不推断存储时间错误。本次未修产品代码。Unicode打字不证明真实中文IME组合；125%–150%DPI、准确960×640窄窗、完整33页面/特殊状态、长审批/UNKNOWN、业务写入/故障恢复与正式包/安装仍待验。待处理为0，未把缺样本状态记通过；未测分栏32/68边界。该结果不推进M04–M07总验收。**修复接续（2026-10-01 晚，仅前端源码与组件范围）**：普通AI已完成正文改用既有 [SafeMarkdown](../../apps/workbench/src/components/SafeMarkdown.tsx)（用户消息与生成中草稿仍为纯文本，Skill 输出仍走 `AssistSkillOutput`，无重复渲染）；资料保存时间与Run步骤起止时间改用 [formatReadableDateTime](../../apps/workbench/src/lib/displayPreferences.ts)，按本设备显示时区呈现 `2026-09-23 08:00:05` 一类可读值，原始UTC保留在 `<time dateTime>`，未改原始时间、数据库或API。组件回归 `tests/readingPresentation.spec.ts` 新增 **5/5**（`**CANCELLED**`、列表、行内代码、代码块、链接渲染；生成中草稿与用户消息不渲染Markdown；时区切换与Asia/Shanghai/UTC/跨日/不可解析；资料与Run时间及空值未开始/未结束），全前端 **76 文件579/579**、`tsc --noEmit` 与 Vite 生产构建 exit0；原 `run-ui1820` 断言的原始ISO串按新展示同步。运行中的 Vite5173 已提供修复后模块（只读核对）。**原生 Windows 复验未验**：本轮工具未开放原生窗口控制，只有 shell/文件类工具，无法操作 DesktopDev 窗口（PID67772 仍在运行、原服务未动），因此正文换行、滚动、代码块与分栏的原生观感仍以上一行为准，本行状态维持部分通过，不以组件成绩替代原生验收 |
| DesktopDev 单实例退出23提示与本机启动接续（2026-10-01） | 已通过（守卫与当前启动范围） | 用户截图为原生 `Relay Agent is already open` / exit23；本次开始时已无桌面进程且命名互斥对象不存在，未强杀任何宿主或停止用户PG，历史具体占锁者无法还原。前台/后台启动增加同一进程及互斥对象预检，及时关闭探针句柄，原生并发门保留；迟到23明确为单实例检查失败并保留宿主具体原因，其他失败不隐藏。[隔离回归](../../scripts/test-desktop-dev-guard.test.ps1) Windows PowerShell5.1 **6场景通过**：前台/后台占锁在准备前拒绝、不留句柄、释放后继续、有进程时显示PID、迟到23、其他错误/工作目录恢复；私有随机mutex与工具seam，无真实桌面/PG/模型。开发API原暂存仅至0046，按当前确切测试包重新暂存并校对 **17,207 API资源**，Node/文件助手同步，旧API保留在本机 `output/acceptance-raw/desktop-dev-busy-20261001/dev-api-before/`。实际隐藏runner调用原菜单DesktopDev链、复用6189及原配置/data_root，Tauri debug编译exit0，当前宿主 **PID67772、真实窗口句柄2163816、标题Relay Agent、Responding=True**；其子API PID67824 `/health/live`200，Vite5173为200，原PG PID67976保留，runner47320仍运行。原生窗口创建位于API/监督器私有readiness后，窗口存在为该启动顺序证据；直接无凭据 `/health/ready`401是预期权限边界，不记200、不提取或公开临时凭据。必要输出留本机同目录 | 仅实际窗口创建/进程/存活与启动守卫，没有原生GUI操作或视觉、IME/DPI/业务写入验收；没有复验正常关窗、安装或此前关闭后宿主残留问题，不宣称该问题已修复。前述44878…目录包不因本次外置开发脚本修改而重打；本行接续不改其EXE身份。用户桌面和PG保留运行，未手动提交任务/聊天/Review/Run命令 |
| 连续工作区的隔离目录测试包与能力门（2026-10-01） | 已通过（目录身份与所列检查） | 在独立冻结目录运行 `build-release.ps1 -SkipInstall -TestPackage`，API/前端生产编译、文件助手与桌面 release 构建均exit0，未写运行中的 DesktopDev 输出；保留既有大chunk/混合导入警告。根重新验证包资源、恢复隔离的原生/三Node入口和全部当前源码：**17,210资源hash、440源码/配置/唯一tokens输入一致，缺失/新增未绑定/差异0，禁止配置0**。维护能力原门因optimized EXE缺完整输入比较字串误判，改为稳定输出标识预检＋空stdin/额外无效参数的有界精确错误帧核对；保留旧宿主拒绝、资源hash及恢复隔离门，脚本纳入来源fingerprint。真实optimized EXE反例与伪造/多帧/错误版本/nonce/超时/意外成功、旧包及恢复入口篡改检查 **4/4、0skip、exit0**，PS解析通过；不发送有效start、不获得维护锁或停止Job。最终包已更新 `test-release/`，旧包完整保留在 `output/acceptance-raw/ui-continuous-20261001/test-release-before/`；更新前后资源与源码核对均exit0。EXE SHA256 **44878b09ea3526b49b3271875e21bf816102a76c01a25aadc01ca38bad743a81**；确切清单副本、构建原失败和最终日志归本机同目录。方法/根因归[开发记录接续](../development/ui-live-integration-2026-09-28.md#连续工作区与优化发布包检查接续) | 仅目录包、编译和无效参数能力探针，不证明合法维护停机/备份/还原组合；不能由本次打包继承M07源码分片的总验收。未安装、未打开此包做新UI的真实Windows/IME/DPI或业务验收，未切用户配置/数据库或调用Provider；上一轮e456…包早于最后窄窗修复及并行后端源码接续，已明确不作为最终包 |
| 连续协作工作区与七类页面层级（2026-10-01 接续） | 部分通过（组件与只读浏览器范围通过） | 按[工作台 §17.6](../frontend/workbench-design.md#176-连续协作工作区2026-10-01)实施共享页头、52∶48 可调分栏/专注模式、摘要优先的提议与工具轨迹、紧凑成果/判断、确切版本差异提示及统一标题/间距；原 Owner 保持挂载，HTTP/数据库/权限/业务协议不变，Breaking Change: No。根最终全前端 **75 文件、574/574、exit0**，包含多会话/草稿/原命令、409、403 后读取失败、Review 失效、停止中及 IME 合成事件；随后唯一比例 token 定向10/10、末轮窄窗 CSS 修复后受影响3文件72/72与类型检查通过，不累加为另一轮全量。指定 gpt-6.1-sol 已分别复核布局与聊天/判断改动；后续打包子代理被账户拒绝，剩余由根完成。IAB 只读 GET-only 合成场景、默认分栏与收起的普通判断、1280×720 CSS 客户区：聊天记录可用 **292px**（原87）、成果正文滚动视口 **243px**（原73），输入器130px，版本/判断动作同时可达；拖动52→58、方向键、双击复位52、模式切换保留输入、提议展开、版本差异返回、Escape 焦点恢复均已观察。长 ACTION_APPROVAL 与展开事实采用整栏滚动，Tab 可达末尾拒绝入口，未提交决定。代表页面覆盖项目/总览、General/Thesis/Development 三工作台、Task/Artifact、Run/待审、资料、设置/连接；960×640回退、390×640成果末尾判断与完成入口可达。末轮复核曾发现短窄窗成果栏 intrinsic 宽度撑至2134px，添加最大宽度约束后该栏380px、内部scrollWidth=clientWidth、正文换行与末尾按钮复验通过，首轮裁切不计通过。全部输出/截图留本机 `output/acceptance-raw/ui-continuous-20261001/`，未写真实PG或调用Provider | 本行组件/浏览器实施轮次未覆盖原生窗口；后续原生代表场景结果见本表“连续工作区真实 Windows 页面独立复核”行，不混入本行浏览器成绩。真实IME与125%–150%DPI仍未验，组件合成组合事件不能替代输入法验收。完整33页面/特殊状态、真实业务四链、安装/升级/卸载与M04–M07总出口仍未闭合。最终目录包身份另见本表接续，不用浏览器或包hash替代原生/业务验收 |
| 最新 UI 的 DesktopDev 真实窗口只读验收（2026-10-01） | 部分通过（首轮布局失败已在最大化范围修复复验） | 用户已打开的真实 Tauri/WebView2 开发窗口，进程为 apps/desktop/src-tauri/target/debug/relay-desktop.exe，界面加载 127.0.0.1:5173；由 computer-use 原生窗口操作，读取本机 API 中的 UI取证-20260929 样本，未用浏览器 fixture 替代。首轮原生最大化/还原、主导航、T2 产物 v3→v1 的标题与正文同步、成果/检查/历史页签 End/方向键、Ctrl+K 中文资料检索及 Esc 返回、设置横向页签、工具面板与待处理空态已观察；工具缺协议如实显示未接入。951×782 工具截图下导航折叠且资料重排；1536×816 与1162×782为截图尺寸，未测 CSS 客户区或 DPI。零任务创建、消息发送、审批或模型调用 | 首轮 **P1**：资料加载正文后侧栏底部越窗、新建任务读取项目后验收/保存区被裁切，滚轮与 Ctrl+End 未能滚达；首轮 **P2**：标题栏承诺项目/任务/资料搜索而实际只查询四类资料。后续修复及最大化复验见下一行，原失败保留，不称缩窗已经通过。T2/T4 无已有 Session、待处理为0，故长审批/会话切换/草稿保护未覆盖；真实 IME 组合输入、125%–150% DPI、四条业务写入/恢复链、正式包及安装仍待验。结果绑定相应开发窗口时点，不覆盖后续代码改动 |
| 协作工作区与共享页壳结构对齐（2026-10-01 接续 §17.7） | 部分通过（浏览器与组件范围通过；全量回归被并行改动阻断） | 按[工作台 §17.7](../frontend/workbench-design.md#177-页头与成果区结构对齐2026-10-01接续-176)与[设计系统 §9.2](../frontend/design-system.md#92-共享页级原语2026-10-01)实施：新增 `PageHeader`/`FactBar`/`JudgmentBar` 三个共享原语；协作页头由 12 个常驻控件收敛为 1 个按钮加「更多操作」浮层（UNKNOWN、控制请求、执行失败时 Run 控制强制移回页头常驻）；事实条收回默认收起的展开区；成果区恢复文档层级，判断条改用 `JudgmentBar`（标题行含条件、执行权边界同行，截断产物版本 ID 移入「查看依据与绑定对象」并保留来源深链）；阅读区保留 `layout.workspace.centerMin` 下限、判断条贴底（`max-height:40rem` 下改正常流）；侧栏去掉已加载计数行与与主导航同路由的「开始一项工作」；输入器恢复单卡（此前卡内正文边框被后注入的 `.field textarea` 覆盖）。只读同构夹具 + 页面内路由拦截取样，1280×720：页头 **212→130px**、聊天记录 **170→287px**、成果正文 **44→416px**，均高于 §17.6 的 240px 下限；1487×1058 与效果图同尺寸，页头 130px、聊天 625px、正文 546px，浮层展开前后页头不变；960×640 与 390×844 根 `scrollWidth` 等于视口宽；业务 POST **0**。`tsc --noEmit` 与 Vite 生产构建 exit0；定向 `collaborationWorkspace` 57/57、`reviews`/`recentWorkPagination`/`navigation`/`taskDetail`/`artifactReader`/`controlInteractions`/`modelConnectionStrip` 全通过。取样脚本与输出留本机 `apps/workbench/scripts/ui-align-visual.spec.ts` 与 `output/acceptance-raw/ui-align-20261001/` | **全量回归当前为红**：已提交的 `a4409b1` 让 `apps/workbench/src/api/relayClient.ts` 把 `usage.cache_read_tokens`/`cache_creation_tokens` 变成必填字段（`nullableInteger` 对缺键抛错），但 8 个 spec 的夹具仍是旧 `usage` 形状，`assistProviderErrorClient`/`assist-flow`/`assist-preview`/`firstPartySkills`/`taskSkillProposal`/`blueprintLive`/`settingsView`/`collaborationWorkspace` 等共 52 例失败，**不属 UI 改动**；本行未触碰该文件。字号对齐见下一行。本行不含原生窗口、WebView2 字形、真实 IME、125%–150% DPI、完整业务写入/恢复、安装/升级/卸载；六类页面仍是各自内联页头与定义列表式右栏，推广属下一批；390 宽成果区需手动切区才可见，本轮只验无横向溢出；长 ACTION_APPROVAL 与提交后回执未在本轮重新取证 |
| 普通页面标题与区域标题字号对齐（2026-10-01） | 部分通过（浏览器与 token 层通过） | 用户比对根目录 `preview.html`（`docs/frontend/mockups/` 索引，7 组 55 张）后选择「放大字号但保留 Sans」，不采纳 2026-09-19 逐页图的衬线大标题。据此改唯一数值源：`font.size.page` 由 `{font.size.compactPage}`(1.75rem) 放开为 **2.5rem**，`font.size.section` 由 1.5rem 提到 **1.75rem**，`font.size.display`(3.5rem) 保留为历史值但页面主标题不再使用；`TodayView.css`/`SettingsView.css`/`CollaborationView.css` 里硬编码的 `compactPage` 标题改为 `font.size.page`，窄窗降级收敛到 `styles.css` 唯一一处 `@media (max-width: 40rem)`。**这推翻了 2026-09-28「今日主标题从 display 收到 compactPage」的单页特例**，今日页现与其余普通页同级。只读示例模式取样：`/today` `/projects` `/tasks` `/knowledge` `/reviews` `/settings` `/connections` `/activity` 八路由在 1280 宽主标题一律 **40px**、区域标题 **28px**，390 宽一律 **28px**，根 `scrollWidth` 等于视口宽；协作页同步放大后 1280×720 页头 130→**145px**、聊天记录 287→**272px**、成果正文仍 **416px**，均在 §17.6 的 240px 下限之上。`tsc --noEmit` exit0；`reviews`/`projects`/`knowledge`/`todayView`/`tasks`/`liveWorkspaceLists`/`uiRemediation20260928`/`productSupplement26`/`connectionsSettings` 共 9 文件 140 例通过。输出留本机 `output/acceptance-raw/ui-align-20261001/ordinary-1280x720/` 与 `ui-align-ordinary-type.json` | 全量回归同样被上一行的 `a4409b1` 阻断，本行未新增失败。**右栏内容形状未改**：当前仍是「标签: 值」定义列表，会露出「验收条件 ID / 请求身份 v1」这类技术身份，逐页图则是「大字值的用户语言事实 + 小标签 + 明确动作」——这是内容重排而非字号，需逐页决定放什么，属下一批的 `JudgmentBar`/`PageHeader` 推广。本行不含原生窗口、WebView2 字形、真实 IME、125%–150% DPI、完整业务写入/恢复与安装；衬线标题未采纳，`font.family.editorial` 仍只服务历史参考 |
| 全局控件与交互基线、最大化修复（2026-10-01） | 部分通过（共享规则及所涉最大化样本通过） | 沿用 tokens/共享 CSS/AppDialog/tabNavigation，补齐输入错误/只读/禁用、图标与危险按钮按下态、页签点击区及表单异步反馈；修复普通桌面页壳 Grid 高度与滚动，标题栏改为“搜索资料”。新增反例先失败再修复：任务校验错误聚焦、成功结果聚焦、readiness 输入冻结、迟到结果不抢命令面板焦点、弹层隐藏/禁用/闭合 details/IME/顶层焦点、资料/工具页签语义与键盘。根代理全量组件回归 **74 文件、549/549、0 失败、exit0**；之后迟到结果焦点补修的最终定向 **5 文件、44/44、exit0**，不累加为新全量。最后页签密度 CSS 调整后 `tsc --noEmit` 与隔离 Vite 生产构建均 exit0，输出 `output/acceptance-raw/ui-global-controls-20261001/build-accepted-final/`；已有 chunk 大小/混合导入警告保留。由 computer-use 操作真实 debug/WebView2 最大化窗口（1536×816 截图）：新建任务读取项目后可滚达验收/保存区，空表单保存仅触发客户端校验并回到首个错误；资料真实正文加载后侧栏底部可见，Home/End 切换后资料目录自动展开且焦点保留，四标签同排；T2 工具 End 到运行记录、执行输出独立展开/收起；Ctrl+K 初始输入焦点、Shift+Tab/Tab 和 Esc 后入口焦点恢复均观察通过。真实窗口零业务命令/Provider 调用，成功创建仅在组件 fixture 验证。规则归[设计系统 §6.2](../frontend/design-system.md#62-全局控件与交互实施基线2026-10-01)与[工作台 §17.5](../frontend/workbench-design.md#175-最大化优先的控件与交互接续2026-10-01) | 首轮两个 P1 与搜索 P2 在本轮最大化样本已修复复验；后续五图反馈修复见下一行，原分片成绩不自动覆盖后续修改。未做缩窗复验，按用户要求后置。全部33页面/状态、长审批/已有会话草稿、真实输入法组词与 DPI、四条完整业务/故障恢复链、正式桌面包及安装仍待验。新增 AppDialog 组合键过滤的组件通过不等于真实 IME 已通过；本轮前端构建不更新旧正式 EXE，不改变 API/数据库/命令 Owner 或原服务端待核对状态 |
| 用户五图控件反馈修复（2026-10-01） | 已通过（所列五处最大化样本） | 共享焦点改为沿原边界向内显示，保留无边框控件可见焦点、错误 danger 与实心主按钮 onAction；复合搜索/分段/文件入口同步取消外扩第二圈。会话 select/primary/secondary 共用 control.height；DevTools 根与输出抽屉改用 canvas；近期项目 summary 补 hover/pressed；紧凑 ModelConnectionStrip 固定剩余宽度、工具带顶端对齐并保留原生只读开合。根代理定向组件回归 **6 文件、85/85、0 失败、exit0**，覆盖模型只读条、协作、控件焦点、AppDialog、命令面板与近期工作分页；`tsc --noEmit` 与隔离 Vite 构建均 exit0，输出 `output/acceptance-raw/ui-control-feedback-20261001/build/`，既有 chunk/混合导入警告保留。computer-use 操作真实最大化 debug/WebView2（1536×816 截图）：Ctrl+K 输入单层焦点、Shift+Tab 关闭按钮及 Tab 返回输入可见焦点；会话下拉/新建/刷新等高，左右工具底色一致；项目分组展开及折叠时指针停留均有底色、移出恢复；连接摘要开合前后按钮和摘要位置保持不变，正文在下方自然展开。未点击创建/连接验证/运行控制或提交业务命令，零 Provider 调用 | 结论仅覆盖本行五处及受影响组件，未重跑前轮全量、不合并旧成绩。缩窗后置；全33页面/状态、长审批/已有会话草稿、真实 IME/DPI、完整业务与故障恢复、正式桌面包及安装仍不由本行证明。没有 API/数据库/路由或业务 Owner 变化 |
| 整套 UI 重做与交互覆盖（2026-10-01） | 部分通过（组件/浏览器视觉） | 用户已选[工作主线图](../frontend/mockups/2026-10-01/work-first.png)（1487×1058），共享页壳、协作与七类页面已重做。根代理实际运行 `vitest run --maxWorkers=2`：72 文件、521/521、0 失败、exit0；`tsc --noEmit` 通过。含 workId＋连接 epoch 的晚到面包屑隔离反例 `workBreadcrumbScope.spec.ts` 1/1、组合草稿/原命令保护、Review 移除/读取失败保留 Owner、确切历史版本缺失、知识切换和水平页签键盘等组件反例；随后 CreateTask 呈现与项目中文原因补修，六文件定向39/39、exit0；最后Run未决原因纯文案补修的三文件定向29/29、exit0，不拼成新全量。实际 in-app browser 使用隔离 loopback fixture API 8794，GET-only、0 业务提交、无真实 PG/Provider，检查项目/三工作台、两种Review、知识、设置横向页签、新建Task、Today、Task详情/成果/Run及项目连接只读页。最后协作390×640短窗、960×640及1487×1058长ACTION_APPROVAL展开依据均核对正文和末尾动作；Tab可聚焦请求修改/拒绝，零提交。1280×480展开导航后Tab到连接的父壳意外滚动已修，最终截图父容器scrollTop=0；历史v2→v1正文变化、Task页签ArrowRight到运行记录已观察。最终 `.jpg` 截图 `06/07-collaboration-390-{result,judgment}-final.jpg`、`10-collaboration-approval-expanded-{top-final,final}.jpg`、`13-short-window-navigation-final.jpg`及14–18页样本与测试日志留本机 `output/acceptance-raw/ui-work-first-20261001/`，详细视觉范围见[视觉 QA](../../design-qa.md)。此前隔离生产构建通过；后续控件修复后的最终隔离前端生产构建已通过，见本表全局控件行，非正式桌面包。初始缺陷及取舍分别见[审查](../research/agent-ui-review-2026-10-01.md)与[开发记录](../development/ui-live-integration-2026-09-28.md#18-工作主线整套-ui-重做与恢复-owner-保护2026-10-01) | 组件与只读 fixture 不能证明全部33页面/状态或四条完整业务路径均通过。最新 DesktopDev 的有限真实窗口只读结果见本表前两行；真实业务提交、PG/Provider组合与故障恢复、完整 Windows 状态/真实IME/125%–150% DPI/安装仍未验；没有本轮新发布桌面包，旧 EXE/构建通过不覆盖重做源码 |
| M04 文件/网页读取委托 UI | 已通过（组件＋确切包 Windows 读取） | 2026-09-30 `TaskDelegatePanel` 与 typed `delegateTask` 接入现有两种读取意图，默认 NONE、与 Mock 互斥；独立 Node24 定向组件21/21、`tsc --noEmit` 通过，覆盖载荷、配置/目标门禁、迟到响应与 UNKNOWN。首冻结包 EXE `e1ae929b4ee54b190a9b8502441764db067aa2c58b71dfaa8a03e783bd0a7734`、manifest `8f6c44b010c15df177852a7fe939313cb3f531f68237763661be4109280e84e9` 构建/包校验和加强最终产物断言后的 read2/2 通过。随后含 Skill JSON mode 修复的同表下述 `ae89f068` 确切包必要 read 复验2/2、exit0；[Windows 脚本](../../apps/desktop/tests/m04-real-read-skill-webview.mjs)均用独立PG/API/Worker＋真实Provider：FILE_READ ASK 等待时零 Invocation/模型调用，界面批准后读取一次；WEB_FETCH AUTO 读取一次。原 Delegate、Operation/Invocation、冻结连接、物理正文/hash、原 Manifest 重建 DRAFT 输入与唯一 call 匹配；CRITERION 接受前零完成，后唯一 Artifact/Completion。最终产物 bytes/SHA、Review、Verification、Completion 绑定同一版本，HUMAN 检查引用原UI决定；标题栏自然退出0、原进程树/来源listener/PG/临时根清理通过。完整日志仅留本机 `output/acceptance-raw/m04-20260930-read-*.log` | 自动化点击证明界面命令及完成门，真人质量/交互、完整 Windows 状态、安装与 M04 总出口另验。Skills 3/3 与 read2/2 为同一修复包的不同会话，不声称单轮 all5/5 或完整 UI 通过。扩大四组件首轮77/78，近期工作读取失权项失败；唯一必要单项复验1/1通过，未稳定复现或修复，不拼成整轮全绿 |
| 人工项目/任务/产物/完成与重开 | 已通过（基础链） | 2026-09-28 真实 API＋隔离 PG＋浏览器闭环，见[实施记录](../development/ui-live-integration-2026-09-28.md#4-真实业务闭环与逐页核查) | 最新源码与 Windows 全路径不自动继承 |
| Mock Delegate→Review→完成/重启恢复 | 已通过（基础链） | 2026-09-25 冻结 Windows 试用包，见[M03](m03-independent-acceptance.md) | 附加动作配置由测试 HTTP 完成，配置 UI 不包含在此结论 |
| Mock 完整并发、取消、UNKNOWN 可靠性 | 已通过（有限 Mock 基准） | 2026-09-30 当前源码真实 PG 全量 495 通过/0 失败/5 跳过，含确定性 G06 8/8、Manifest 对照及 20 项篡改；取消/完成两个独立进程竞跑均通过。同日冻结包真实 WebView2/PG 的 ACTION、UNKNOWN、在途 CANCEL、同页 SSE 及产物恢复均退出 0，G01–G08 必要 Mock 出口独立复核闭合。UNKNOWN 带诊断连续重启 3/3 保留原 Invocation、原 QUARANTINED claim，无重复效果/产物/完成；历史分片见[M03](m03-independent-acceptance.md) | 首次 UNKNOWN observer 曾退出 101，后续完整链及连续重启未再现，根因未定位，不能称已修复。Windows 在途 CANCEL 使用受控包内 Worker 与真实 UI，停机后由 harness 调用生产恢复 Owner，不冒充宿主自动回收组合。5 跳过为 4 项真实模型与 1 项 M06 Windows helper 无回执反例 |
| Mock 文件动作输入与原委托载荷 | 已通过（组件＋冻结包 Windows） | 2026-09-30 失焦反例先失败后通过，定向 7/7、Workbench 415/415、类型检查通过；冻结包真实 UI 连续键入目标/内容、提交原 Delegate 载荷，经 ACTION_APPROVAL→原动作一次效果→CRITERION→完成通过。根因见[开发记录](../development/m03-run-dispatch-slice.md#mock-文件动作的-react-委托与历史入口开发自检) | Connection/受管目录/权限策略仍由 HTTP 配置，不能称这些管理入口已通过 UI；不覆盖并行界面后续修改 |
| M03 本轮冻结包与桌面验收入口 | 已通过（确切包范围） | 2026-09-30 忽略目录 `output/acceptance-raw/m03-frozen-20260930-f51158d5` 独立构建、包校验及上述 Windows 链通过；EXE SHA-256 `8e9928f573c76903fcdfc93092d04273510da715b9c8c5f8fd296dc3fac92300`，manifest SHA-256 `b977a591a9ecc2e78ca092b396596b27e8df94a226010f1c81f36bc582140a0c`。[动作/UNKNOWN](../../apps/desktop/tests/m03-action-approval-webview.mjs)、[取消/产物](../../apps/desktop/tests/m03-review-resume-webview.mjs)均绑定原包及 0013；每次 PG 停止 0、临时目录删除 True | 首次退出 23 是已有开发窗口占单实例锁；用户授权结束该确切开发进程后复跑。旧开发窗正常关闭失败根因未定位，新包正常关闭通过仅覆盖所列基准；未替换目录测试入口，未验证安装/升级或最新完整 UI |
| Windows 产物续版、接受、重开与关闭 | 已通过（冻结包人工链） | 2026-09-30 `m03-review-resume-webview.mjs --artifact-lifecycle` 退出 0：5 次写命令均真实 UI，刷新后同 Artifact v1→v2，旧版正文/hash 不变，State 选用 v2/完成接受 v1；重开及包重启后 READY、当前完成指针清空、历史凭据保留且不继承。标题栏点击关闭，页面 close 一次、宿主自然退出 0/无 signal、已记录进程树停止 | 开始人工任务为 HTTP 前置；该链零 Run，无实际 Worker。首跑新增观察器因 Tauri invoke 不可写而断言失败，移除私有注入赋值、改只读 page close 事件后必要复跑通过；不改写首失败日志 |
| Windows 同页 SSE 断线重连 | 已通过（冻结包同页） | 2026-09-30 [同页脚本](../../apps/desktop/tests/m03-sse-same-page-reconnect.mjs)退出 0：定向结束原 PG SSE backend，原页面自行从 after=1 重连，seq 1→31/Run revision 6；原 host/API/supervisor 身份保持，无新增控制命令或 URL 凭据，PG 与临时目录清理通过 | 仅为所列可控断线；不替代真实 Provider、全 UI/IME/DPI 或安装验收 |
| 模型连接验证与配置保留 | 已通过（定向） | 2026-09-29 固定探针真实外呼、账本、重启配置保留，见[历史实跑](#61-本轮实跑) | 不等于全部模型业务可用 |
| 真实 DRAFT、HARD SEMANTIC、取消/abort | 已通过（定向） | 2026-09-29 隔离真实 Provider 原用例 4/4，见[进度历史](../development/codex-next-step-history-20260930.md)及[语义修复](#62-本轮发现并修复的缺陷)。2026-09-30 [DRAFT 用例](../../apps/api/test/integration/real-model.integration.test.ts)强化原 call→持久 Manifest→明确来源版本/完整正文 hash→候选原样回显：首轮 3/4，DRAFT 把整段中文描述当作标记而未完整回显；资料正文改为纯 ASCII 唯一标记后仅必要 DRAFT 复跑 1/1，未放松来源、回显或完成门断言，生产 prompt 未改；两轮 PG 清理通过 | 新强化条件没有单轮 4/4 全量成绩。普通业务的真实 Windows 闭环见下行；不代表所有 Provider/质量场景通过 |
| M04 原调用首文本与首预览持久计时 | 已通过（开发自检＋独立回归） | 2026-09-30 [0047](../../apps/api/migrations/0047_m04_model_call_first_output.sql)及原 Owner 写入、Trace HTTP/React 展示已接入。开发自检 36/36（DRAFT 预览 8、Assist 预览 8、迁移 9、CLI 5、Trace 6），独立受影响 PG 回归 64/64（Run Steps 8、Assist 45、预算 5、Provider 故障 6），均无失败/跳过；API 单元 144/144、受影响前端 24/24、两端类型检查通过。覆盖空帧不计、首值不覆盖、清预览保留、旧行空值、角色权限、真实 HTTP 字段、取消/旧 Worker 门禁及失败回滚。独立回归四临时根与端口、API/PG 清理通过 | `started_at` 是账本受理；首文本是合法 Owner 的回调观察，首预览是事务内写入，不是提交返回/Provider 收包/窗口显示。结构化提案和历史未知值不补造。独立回归首轮在启动阶段遇到 PowerShell 重定向继承管道等待，未进入业务测试；保留原输出，改外层文件句柄后通过，不能称产品故障修复 |
| M04 真实 Provider 与 Windows 协作定向闭环 | 已通过（确切冻结包） | 2026-09-30 [真实 WebView2 脚本](../../apps/desktop/tests/m04-real-model-webview.mjs)第二轮退出 0：UI 显式选源并 Delegate，原唯一 DRAFT call/Manifest/完整源 hash 与候选标记一致；UI Review 前零完成、接受后 Task DONE/Run COMPLETED/唯一版本与完成记录，Trace 显示持久时间。普通 Assist 首预览、第二轮不重供标记的历史回复，以及第三轮类型化提案通过；待接受零业务写，UI 接受＋原 command 重放同回执，只新增一个 HUMAN/INBOX Task/一条必需 HUMAN 条件/零新 Run。独立构建目录 `output/acceptance-raw/m04-frozen-20260930-d889f527` 包哈希校验通过，EXE `ecf9fcb45344abd73137a314c6feb3fc0339d010ec2a810be67716a28b2b3650`、manifest `c088d7b2df39533921d50e1dd846423767c1de1d269d3ab8d3cb497bef7a3f36`；0047 与包清单绑定。标题栏关闭，页面 close 一次、宿主自然退出 0/无 signal、原进程树停止，PG 停止 0/临时根删除 True | 第一轮提案标题未按“第一轮标记”命名而整链失败，原失败日志保留；第二轮将第三轮标题写为明确字面量，其余断言不减，不证明第三轮无提示历史检索（第二轮单独验证）。仅复制获授权模型白名单配置，使用合成资料、隔离 PG/Graph，不替换目录测试入口、不覆盖并行后续 UI。不涵盖真实服务故障、工具组合、全部 Skill/提案质量、IME/DPI 或安装 |
| Provider 六类错误的真实故障矩阵 | 未验收（真实服务）；受控链已通过 | 2026-09-30 `run-integration.ps1 -SkipBuild -UseCLocale -TestFile model-provider-faults` 退出 0、6/6；[新增矩阵](../../apps/api/test/integration/model-provider-faults.integration.test.ts)用真实 SDK Adapter 经既有 transport seam 对接隔离本地 HTTP，覆盖 401/AUTH、429/RATE_LIMIT、实际 deadline/TIMEOUT、合法 SSE 无 DONE/STREAM_BROKEN、422/PROTOCOL、headers 前断 socket/NETWORK。Assist 原 Owner→PG→独立 API 保留原唯一 call_id、正确 FAILED 分类，无部分正文/提案/预览；每类一次请求，listener/socket/API/PG 清理通过。原 Fake 及投影反例见[诊断记录](../development/ui-live-integration-2026-09-28.md#14-m04-run-模型调用诊断与本地错误归因2026-09-30) | Bridge 使用合成输入与测试凭据，仅清除物理 Response URL 并向本地传输，不改生产 HTTPS/SSRF 规则；不证明真实 Provider 服务、TLS/DNS 或 Windows 故障链。首轮测试隐私观测直接序列化 BigInt 失败，保留原日志，改十进制 string replacer 后仅必要矩阵复跑通过，未删除断言 |
| M04 模型原生工具参数的能力拒绝与证据保全 | 已通过（受控 SDK/PG/API） | 2026-09-30 原 7/7 暴露拒绝前已观察 request ID 未进入错误封套，四项窄单元先红后修复。当前 API 单元 152/152；[故障矩阵](../../apps/api/test/integration/model-provider-faults.integration.test.ts)10/10（原六类＋工具先/后正文两项合法 SSE＋已知/未知错误封套两项 PG seam）、预算回归 5/5，均零失败/跳过。原唯一 call、Message、HTTP 的 ID/已知或未知用量一致，`FAILED/ModelToolOutputError` 与 Provider 类别 null；失败后正文/提案/预览/Gateway 均零。工具先于正文的首时间空值；正文先于工具的首时间保留，单请求无重试。协调侧独立只读核对成绩、原 PID/端口和临时根清理；最后补非文本 URL 不进入封套的窄断言，端口单元复验 13/13。listener/socket/API/PG 清理通过，临时根删除 True；本机输出在 `output/acceptance-raw/m04-20260930-tool-metadata-*.log` | 已知规范化 usage 使用公开 SDK stream seam，已知/未知落库使用错误封套 seam，均不冒充真实 Provider wire/计费。当前 SDK 在流末才发规范化 usage，提前拒绝时未观察用量仍 NULL；空 ID 与非文本拒绝有单元反例。不是工具执行、真实服务故障或 Windows 修复验收；多工具及非流式组合未覆盖 |
| M04 Files/Web→真实模型→人工完成 | 已通过（隔离 PG/HTTP 图组合） | 2026-09-30 [opt-in 用例](../../apps/api/test/integration/real-model-read-sources.integration.test.ts)必要复跑 2/2、0 失败/跳过：临时合成文件和独占本机 HTTP 各一次真实读取，Capability 为 REAL/READ，冻结 Connection 身份/版本/config 与原 Operation 一致；唯一成功 Invocation 的正文与全文/片段 hash、原 DRAFT call 的 read IDs/模型配置指纹/非零用量/request ID、原持久 Manifest＋读证据重建的 input hash 均核对。标记只在正文，候选原样回显；HTTP Delegate 与 HUMAN Review，接受前零完成，之后 Task/Run 完成、唯一 Artifact/Completion；读取和模型调用在恢复后原样不变。Node24 编译通过，API/来源 listener/PG 清理通过，临时根删除 True。明确 fake 配置自检为 2 skip/0 fail，不启动 API/网页或外呼 | 首轮 0/2 失败在误查 Connection 的历史 FAKE 标签；实际派发按 Capability 使用真实 Adapter。仅将测试断言改到正确 REAL/READ 注册并加强冻结 Connection 校验，保留物理读取/hash/回显，不改生产默认或直接改 SQL 标签；首失败日志保留。图执行由测试进程 `runOneCommand`，不证明独立 Worker/Windows 读工具 UI；本机网页仅隔离 Connection 显式 `allow_private`。固定用户冻结读意图不等于模型原生工具参数执行 |
| M04 首批三个 Skill 的真实模型组合 | 已通过（确切包 Windows 定向）；稳定性/质量未验 | 2026-09-30 此前[HTTP 组合](../../apps/api/test/integration/real-model-skills.integration.test.ts)首轮 2/3、任务契约必要单项 1/1 保留。随后旧 Windows 包任务契约再次 `FAILED/OUTPUT_SCHEMA_INVALID`，另两项未运行；错误发生在严格解析阶段、早于提案构建，原正文未保存，具体拒绝字段未知。查明 Skill 内部 DISCUSS 漏 JSON mode 的独立代码缺口，三项受控 wire 回归先红后修；Port 18/18、严格 Skill 单元5/5，协调侧 Node24 全 API 单元157/157，零失败/跳过；只读独立复核无问题。修复包 `output/acceptance-raw/m04-frozen-20260930-ae89f068` 构建/包校验通过，EXE `c617e1081eaf62dfceff90e05e6a91ff73655a95bdd77e1ba1f1212deec57dbf`、manifest `6e9126bf02fc642049ad45c2d5c27a7a0995df775207c6874b779debaa0bf4d4`；[真实 WebView2 脚本](../../apps/desktop/tests/m04-real-read-skill-webview.mjs)单轮 skills 3/3、exit0：确切 `task-to-execution-contract@1.1.0`、`verification-plan@1.1.0`、`project-resume@1.0.0` 均由 UI 生成、独立 Worker 原唯一真实 call。冻结版本/SHA/基线、配置指纹/request ID/非零用量与输出 hash 核对；两提案接受前零业务变更，UI 双确认按三 hash/双 revision 接受及原 command 重放单效果，Task/acceptance 各+1，旧约束/条件/执行权保留、新条件必需 HUMAN、零 Run/Completion；恢复摘要只读、零 revision 变化/提案。标题栏自然退出0、原进程树/PG/临时根清理通过；首失败及最终日志仅留本机 `output/acceptance-raw/m04-20260930-*.log` | JSON mode 修复不证明历史失败的具体输出根因；单轮通过不代表稳定完成率、真人回复质量或 M04 总出口。自动化点击只证明接受命令，非真人质量判断；合成数据/隔离PG/原配置白名单范围不扩大。普通 DISCUSS 首预览、严格 schema 和 Owner 不变，不保存 raw 输出或自动重试。构建首轮遇并行 UI 未用 import，最小删除该 import 后通过；未替换用户目录测试入口。此前缺失/Fake/残缺配置各3 skip及动态导入修正保持原边界 |
| Assist/Run 调用诊断与取消归因 | 已通过（增量） | 2026-09-30 API 144/144、受影响 PG/HTTP 65/65，见[最终诊断记录](../development/ui-live-integration-2026-09-28.md#14-m04-run-模型调用诊断与本地错误归因2026-09-30) | M04 总验收及真实故障上浮全链 |
| Agent 聊天发送、导航保护与 Mock 回复 | 已通过（开发版基础链） | 2026-09-29 WebView2＋隔离 PG＋Mock，见[聊天验收](../development/ui-live-integration-2026-09-28.md#11-独立-agent-聊天验收2026-09-29) | 最新协作改版与真实 Provider/安装包另验 |
| 协作工作区的导航与任务入口 | 已通过（开发版导航） | 2026-09-30 此前菜单 6 真实 Windows 窗口实点项目页「协作」及任务详情入口，同一 Task 深链接与标题一致。随后按用户要求把近期工作改为所有 live 页常驻，窄屏纳入导航抽屉；切页保留列表，连接切换隔离旧 Workspace，刷新失权清掉旧条目。新增三项反例先失败后通过，导航定向 41/41、受影响列表及创建回归 18/18，最终 Node 24 前端全量 65 文件 456/456；类型检查与独立目录生产构建通过。只读浏览器夹具覆盖 1280/960/390 宽度及 400/500 短高度，所查场景无根横溢，短窗口与抽屉单层滚动，实点工作进入确切深链接并关闭抽屉；组件断言零业务 POST。规则见[工作台第 14.6 节](../frontend/workbench-design.md#146-已选方向的工作区与动作)，本机截图与输出为 `output/acceptance-raw/ui-fidelity-20260930/recent-*` | 本次常驻导航增量未重打桌面包或重跑真实 Windows/IME/DPI，浏览器夹具不证明 PG/Provider 业务链；目录测试包与完整协作业务、安装交付另验 |
| 最新协作页视觉与 Review 状态/草稿 | 部分通过 | 原三尺寸/Review 反例及前端 407/407 见[Review 修复](../development/ui-live-integration-2026-09-28.md#13-协作页参考图接续与-review-修复2026-09-30)。同日第二轮真实状态纠偏：受影响组件 63/63、类型检查与独立目录生产构建通过；正文 503 结束加载且只读一次、显式重试与迟到版本、委托折叠保留输入/UNKNOWN 不可隐藏、通知入口回归通过。八个浏览器场景覆盖 1512/1280/1024/900/390 宽度、640/480 短高度、320px 侧栏、长标题、无会话、失败/空文档、正常判断与未知委托；无整页横溢，新建/重读可滚达，通知弹层不越界且 Esc 关闭。此前真实窗口实点导航、列表局部滚动与最大化，本轮热更新真实窗口仅复核顶栏通知已呈现。2026-10-01 入口精修：Node 24 协作组件 31/31、类型检查与独立目录生产构建通过；既有只读视觉 12/12，选择表单 31 项断言覆盖 1920/1280/900/390 宽度、1032/844/800/500 高度、未选禁用、读取失败、间距、无根横溢及进入确切 Task，均零业务 POST。独立补查 390×500 加载/空列表的禁用与滚动可达、900/1280×500 活跃文档/检查/历史真实点击及讨论草稿保留通过，零写入。基准为本次 `CollaborationView.tsx` 与 CSS，截图与临时检查保存在 `output/acceptance-raw/collab-polish-20261001/`；规则见[设计系统](../frontend/design-system.md#51-协作工作区的视觉层级) | 最新真实产物任务的 Windows 状态复核尚未完成：开发窗口结束后另一项独立桌面验收占用单实例；真实 API 判断提交、完整 Windows/IME/DPI 状态矩阵另验；未重建目录测试包 |
| 全页面视觉/故障状态覆盖 | 部分通过；本轮重点整改复验通过 | 2026-09-30 按 ui-ux-pro-max 对照既有参考图，三工作台补任务/资料目录、确切版本正文和同任务 AI 入口；设置的本设备显示偏好保存/重载通过；Task Skill 同页生成入口、服务端合并提案、双确认与执行权门禁、蓝图候选摘要及 Run 待审批/已暂停/UNKNOWN 已复核。此前 22 项最终浏览器截图及 65 文件 439/439、后续 Task Skill 门禁 30/30 绑定原时点。最新结构修复覆盖待审列表/类型筛选与右侧判断、产物确切正文/编辑/预览及同页冲突对照、Task 合并提案/派生检查表和当前/历史完成凭据，取消重复内边距并保留原命令 Owner。独立只读代码复核后关闭 Task/产物列表失权泄露与403→503旧事实重新出现的反例；原A命令/B草稿、确切版本读取失败/重试/迟到、409显式换基线与未决确认仍有回归。最终 Node24 前端全量66文件474/474、类型检查和独立目录生产构建通过。只读浏览器夹具实查1487/1280/960/390或375宽度，所查场景无根横溢；Task确认、产物完成与待审判断各保留单实例，缩窗本地草稿保留，AI产物禁写，历史凭据无当前完成宣称，原未保存离开提示与只读抽屉Esc关闭可用。浏览器未执行业务POST，409、失权与命令恢复为组件模拟，不能混为真实PG或Windows流程。截图与完整输出留在本机 `output/acceptance-raw/ui-fidelity-20260930/detail-*`、`artifact-*`、`task-layout-*`，此前整改为 `fix-*`；旧矩阵见[历史实跑](#61-本轮实跑) | 当前33个页面/状态未完整逐图复验，知识capture、非空恢复/搜索等仍待补；产物冲突尚缺当前浏览器/真实业务同页取证，图中富文本编辑/自动合并未作为已实现能力。Development Git diff/CLI缺HTTP/UI协议。最新Windows/IME/DPI、真实Provider/PG全链未重跑；本轮未重打桌面包或安装验收。只读视觉夹具不证明业务写入/模型输出/验证成功 |
| 目录测试包的输入/资源完整性 | 已通过（记录时点静态范围） | 2026-09-30 389 个源码输入、17177 个资源哈希、字体许可及零链接检查通过，见[纠偏记录](../development/ui-live-integration-2026-09-28.md#16-整套页面视觉纠偏与发布输入冻结2026-09-30) | 后续源码变更须重新生成清单/校验；安装与真实窗口另验 |
| Today/三套工作台/知识/Trace/Lineage | 已实现待总验收 | 页面交互与分片测试已有记录，见[范围历史](../development/codex-next-step-history-20260930.md) | M05 完整真实业务与桌面验收 |
| 项目归档与关联写入栅栏 | 已实现待总验收 | 后端命令、live 入口与主要写入口已有开发自检，见[范围历史](../development/codex-next-step-history-20260930.md) | 完整集成与独立验收 |
| 文件/Git/CLI 与 UNKNOWN/PARTIAL 人工处置 | 部分通过 | PG/HTTP、隔离 Windows Job 和无回执恢复分片，见[M06](m06-independent-acceptance.md) | 确切包、人工交互与 M06 总出口 |
| Git 状态/diff 的协作 UI | 未接入 | Adapter 已存在，但缺 HTTP/UI 协议，见[协作规格](verification-plan.md#16-agent-协作主线验收提案) | 接入协议与真实改动归属验证 |
| 交互终端 / PDF 导入 | 未接入 | 当前只提供执行输出读取；两项未交付，见[当前入口](../../CODEX_NEXT_STEP.md) | 不以输出面板或其他格式导入代替 |
| 菜单 6 桌面开发启动 | 已通过（隔离启动回归）；最新 Windows 窗口未验 | 2026-10-01 [启动回归](../../scripts/test-desktop-launcher.test.ps1)经 Windows PowerShell 5.1 自检及协调 Agent 独立复跑均退出 0；使用小包/CLI 与桌面桩、真实隔离 PG：首次初始化、同包跳过清单解析/资源校验/迁移、停库后同库启动、变包先非空备份再迁移/Graph、配置保留、启动锁及 Start 坏资源拒绝通过；PG 与临时目录清理通过。原 2026-09-30 真实窗口/bootstrap/readiness、重复启动/并发 Stop 证据保留在[启动修复](../development/ui-live-integration-2026-09-28.md#15-菜单-6-桌面开发启动修复2026-09-30) | 本轮未重启当前开发窗口、重打包或刷新 API；CLI/桌面为桩，不代表真实业务 schema、窗口或安装验收；未覆盖数据库目录丢失或标记冲突恢复。首两次测试驱动分别受 PG 继承输出管道与 PS 5.1 空 ExitCode 影响，改文件输出及保留进程句柄后通过，不算产品故障修复。2026-10-02 修复菜单 Ctrl+C 直接关闭终端：启动器用 `Console.CancelKeyPress` 屏蔽自身终止并循环菜单，Ctrl+C 仍送达 tauri/cargo/Vite 并执行 `finally`，`dev-desktop.ps1` 把 STATUS_CONTROL_C_EXIT 视为正常停止，`dev-stack.bat` 菜单模式改为 `start` 交出控制台以避开 cmd 的 Terminate batch job 提示。[菜单回归](../../scripts/test-desktop-menu.test.ps1)3 场景通过（屏蔽、动作后回到菜单、非交互单次调用），两个既有启动回归复跑仍退出 0 | 未在用户当前窗口上实测交互式 Ctrl+C；隔离夹具以管道 stdin 驱动菜单、以 `GenerateConsoleCtrlEvent` 发送真实控制事件验证返回与清理，视觉与真实窗口仍需用户在重启后确认 |
| Windows DPI/IME 与最新 UI | 部分通过 | M02 基础窗口有 IME/DPI 证据；2026-09-29 当时 UI 的 125% 取证通过，见[M02](m02-independent-acceptance.md)和[实跑](#61-本轮实跑) | 最新改版未完整验；本轮 150% 矩阵未完成 |
| 冷启动/反馈与首输出延迟 | 部分通过 | 2026-09-30 收紧基准最终条件后的[固定 Mock 摘要](evidence/m03/mock-bench-20260930-181113-48a1ae1f/summary.json)：4 路 Delegate、8 完成/2 排队取消，10 条命令 DONE、10 个 Invocation IDLE、2 条控制 APPLIED 后停止；202 p50 22.32ms、队列领取 13474.5ms、完整 DRAFT 已持久草稿 14192.5ms、取消状态收敛 69ms。[初测](evidence/m03/mock-bench-20260930-180157-b4bf294e/summary.json)保留原口径。上述 M04 冻结包第二轮真实 Windows 单次观察：DRAFT 点击→视口首预览 3003ms（67 字符）、账本→首文本 705ms、首文本→首预览写入 41ms、账本→结算 74122ms；Assist 分别 2994ms（125 字符）、799ms、6ms、5092ms | 窗口值含轮询、滚动与动画帧，是首次可见观察上界，非精确首像素/首 token，也不是 p50/p95。Mock `first_persisted_draft` 取完整 DRAFT finished_at，不能当首片段。样本不足推断稳态尾延迟，排队取消不证明在途 abort；冷启动排队需分段测量，不由单次采样归咎某一依赖 |
| M07 数据库维护准入与原工作排空兼容 | 已通过（源码 PG/CLI 首片） | 2026-09-30 [0048](../../apps/api/migrations/0048_m07_admission_gate.sql)及[维护用例](../../apps/api/src/application/runtime-maintenance.ts)接入全库 NORMAL/DRAINING；[维护集成](../../apps/api/test/integration/maintenance-admission.integration.test.ts)自检15/15、协调侧重新编译独立15/15。覆盖真实 SHARE/UPDATE 竞争、等待后原回执重读、CAS/有界锁等待回滚、跨 Workspace、两类提案接受、新领取与 VERIFY 零新效果、角色权限/缺行失败关闭；原 Run 发布/Graph Saver、Assist/Web 结算、Gateway delivery 与 UNKNOWN/PARTIAL 安全终结保留身份。独立七组既有 PG 回归137/137（Run Dispatch27、Model Verify8、Gateway28、Assist45、Blueprint5、Web19、模型预算5）；API 单元158/158、两端类型检查及中文维护错误3/3通过。各组 PG 启停/迁移/Graph 退出0、临时根删除True；只读源码复核无阻断项。完整输出留本机 `output/acceptance-raw/m07-20260930-admission-*.log` | 本轮没有真实 Provider 外呼或新维护包 Windows 验收；停机证明组合使用原受信测试端口，不算真实 Windows Job 停机验收。DRAINING 允许原在途写入，FROZEN/完整备份恢复、旧包升级与安装仍待验。自检首轮数值型0漏超时/FIFO假设、helper筛选缺口与 VERIFY 嵌套事务失败均保留日志，已修复并必要复验；不拼成全仓 PG 或 M07 总通过 |
| M07 当前 Windows 会话原宿主停机与持续持锁 | 已通过（源码/debug 原生及 Node 管道） | 2026-10-01 [原生入口](../../apps/desktop/src-tauri/src/maintenance_session.rs)、[Node 协议](../../apps/api/src/runtime/desktop-maintenance-session.ts)及[CLI](../../apps/api/src/cli/maintenance.ts)独立复验：MSVC Rust 全 lib33/33，Node 定向12/12；[真实组合脚本](../../apps/desktop/tests/m07-maintenance-session.mjs)5/5且必要复跑通过，临时根删除True/owned进程0。真实 Job 含 API/Worker/孙进程，停机保原 ARMED、READY 期间第二入口 BUSY、原 nonce release/EOF及无凭据使用。debug EXE SHA-256 `5d4eb709e7b80e6a4c5e254981f8df456e658b6f4b8fcfdf3e277c7cabef63c4`；最小 native-test-package 仅检此能力/hash。握手后 sticky failure、RELEASED→坏帧→exit0、READY后意外EOF→exit0与release尾随超界均先红后绿；harness另补旧EXE marker前检和有界退出，旧EXE反例执行前拒绝。完整输出留 `output/acceptance-raw/m07-20261001-desktop-stop-*.log` | 不证明跨登录会话/独立CLI/外部写者已停，不包含 PG/Provider/GUI/安装或完整备份；guard不改 DRAINING或业务恢复。首次独立Rust误设test Node变量导致32/33，纠正后33/33；GNU测试runtime未进入suite、首轮Job计数与OShandle等待差异均保留失败日志，不当作已通过。新发布脚本能力字段尚未作完整新包验收 |
| M07 Windows 实际受管内容发布与排他安全点 | 已通过（源码/真实原生与 PG 分片） | 2026-10-01 [ADR-015](../decisions/ADR-015-managed-content-native-publication.md)接入同一原生助手的共享发布/排他会话；[CLI](../../apps/api/src/cli/content-freeze.ts)明确只冻结受管发布。独立重新编译后 native27/27（新内容7、原Files20）、真实Node/CLI/store15/15、API全单元178/178零skip；MSVC release helper Node/CLI/store另15/15。新[内容冻结PG](../../apps/api/test/integration/content-freeze.integration.test.ts)独立2/2：人工HTTP零Artifact/Version/Receipt/revision效果，解除后原命令重试及重新持锁时旧回执重放；原已派发Run UNKNOWN保原effect/target、不盲重发。独立既有PG产物18/18、Run步骤8/8、完整图/Saver62/62零skip（明确提供debug helper，含无回执强杀原case）；四套start/migration/Graph/stop均0、临时根删除True。API类型及只读源码复核通过。debug helper SHA-256 `01f34d9823eb6f0df57f9995ed3080e895ff1620303187ab9e914c295abb08ae`，release `da935fcefd0989848d59019da246f3c1db25ebde8b919a5554b4f066f8192859`；输出留 `output/acceptance-raw/m07-20261001-content-*.log` | 仅现版本ManagedContentStore实际原生IO；不是PG/Saver全冻结，不覆盖旧独立写者、外部FILE_WRITE/Git/CLI或手工修改，没有完整新桌面包/GUI/安装/备份恢复。release只释放自身锁，UNKNOWN仍须原受信Owner核对。自检首轮junction权限替代与回执header断言修正均保留失败日志和检查；worker图自检61通过/1条件skip并单独补1/1，协调侧完整62/62，不混成同一次成绩 |
| M07 本库 CONNECT/DDL锁与权限恢复机制探针 | 已通过（隔离PG机制，非产品备份） | 2026-10-01 [三组探针](../../apps/api/test/integration/database-maintenance-boundary.integration.test.ts)自检3/3；协调侧补两把会话锁在COMMIT后仍持续阻挡原业务/Graph安装入口，再独立编译运行3/3零skip。实际REVOKE提交后旧app仍能写、新app42501；原/新migrator可用，完整dump目录包含业务台账/Graph，临时空库restore读回测试事实和schema。受控app成员/CONNECT grant-option漂移不会被bootstrap修复；已flush原有效ACL后按本库已验证PID注入维护连接中断，撤销仍持久，原migrator从原ACL恢复且权限逐项相等，未增pg_signal_backend。wrapper build/start/migration/Graph/stop均0、临时根删除True；输出留 `output/acceptance-raw/m07-20261001-database-boundary-independent.log`，原自检留admission前缀日志 | 测试直接使用既有角色和PG机制，没有生产fence/recovery CLI、完整角色/额外授权预检或残余连接/prepared transaction拒绝Owner。管理员仅做临时库生命周期、漂移和确定性故障注入。临时restore未覆盖受管文件、ARMED隔离、外部资源/历史依赖或真实恢复放行；不称FROZEN、完整备份/升级通过 |
| M07 生产数据库连接维护与原ACL恢复 | 已通过（源码/真实PG与CLI分片） | 2026-10-01 [实际会话](../../apps/api/src/runtime/database-connect-fence.ts)、[CLI](../../apps/api/src/cli/database-connect-fence.ts)与[集成测试](../../apps/api/test/integration/database-connect-fence.integration.test.ts)：当前Agent重新编译自检14/14；指定gpt-6.1-sol只读复核后用原wrapper再次独立编译实跑14/14，零skip，源码/输入解析器/测试/wrapper基准未变，编译入口逐字对应。实际Application切DRAINING，原有效ACL/grant option准确恢复且凭据不改写；新app42501、受信dump可用、原两类DDL入口跨COMMIT等待，锁忙有界。旧app及Saver命名的真实app闲置连接、授权后启动对象锁、真实PREPARE后断连、角色/额外授权漂移、链接/损坏/错库均拒绝；外部ACL漂移不覆盖。实际CLI早期坏帧/尾随/超界拒绝成功输出、EOF/release恢复、强杀/已验证backend丢失保留撤销及凭据，显式恢复幂等。API全单元182/182（新[凭据/参数4项](../../apps/api/test/unit/database-connect-fence.test.ts)）、原维护15/15、机制探针3/3和文档检查通过；三套PG启停/迁移/Graph均0，临时根删除True。完整输出留 `output/acceptance-raw/m07-20261001-db-fence-*.log` | 仅数据库连接准入，frozen=false；Savers命名连接证明数据库边界，不替代真实Saver在途停机。未组合完整备份/文件manifest/隔离恢复，未重打完整新包或验安装。Owner/管理员、外部写者仍独立；未知目标库后台可保守拒绝。四个实测失败根因及修复见[开发记录](../development/m07-backup-recovery.md#数据库连接维护的失败边界)，保留初次观测设置错误/真实反例与复验。工作区外一次编译误输出的清理被自动审批拒绝，临时构建目录暂留，不影响上述临时PG清理 |
| M07 受管文件清单与原包历史定义保留 | 已通过（Windows源码内部入口/包fixture） | 2026-10-01 [文件复制](../../apps/api/src/runtime/backup-files.ts)、[只读元数据](../../apps/api/src/runtime/backup-paths.ts)及[原包核验](../../apps/api/src/runtime/backup-package.ts)已实现；文件自检12/12，协调侧重新编译全API204/204零skip（含文件12与包10）。原正文/orphan/staging/ARMED bytes/hash不改，ARMED只进evidence；未知条目、非空未受管缓存、目标占用、真实junction/hardlink/文件与目录ADS、失锁及目录/字节漂移拒绝。原包资源实际集合与hash逐项匹配，完整Skill/Pack正文/依赖从原包导出，缺定义/坏hash/重复身份拒绝且无新版fallback；改包、挂起导出和stdout超1MiB反例通过。指定gpt-6.1-sol只读复核后按最新源码独立编译包10/10零skip，5输入SHA前后同、5编译入口与默认dist一致；原SHA漂移轮保留，未混用成绩。fixture清理、类型检查和文档检查通过，输出留本机 `output/acceptance-raw/m07-20261001-backup-*.log` | 文件持锁断言为受控测试，不证明三类生产会话已组合；小资源包fixture不等于完整确切发布包。固定系统PowerShell/.NET仅元数据检查，受信运维边界不等于对抗同OS写者隔离。本行只覆盖基础入口；备份组合与新目标隔离还原看下列行；本行没有新PG或Provider外呼、GUI或安装验收 |
| M07 PostgreSQL完整归档机制 | 已通过（源码/真实PG分片） | 2026-10-01 [归档入口](../../apps/api/src/runtime/backup-postgres.ts)：指定gpt-6.1-sol自检单元7/7、真实PG3/3；根按原wrapper重新独立实跑3/3零skip。PG18实际regular stdout fd写wx custom归档；随机空目标库8张业务/Graph表JSON逐行一致，含checkpoint/blob/write。占用目标不覆盖、失锁拒绝、观察真实在途dump连接后Abort并等自己child退出，partial保留且原blocker仍活。类型检查、迁移/Graph/PG启停均0，临时根清理通过。输出留本机 `m07-20261001-backup-postgres-worker.log` 与 `backup-postgres-independent.log` | 固定标准migrator、本机PG18/sslmode=disable；子进程退出不代表PG backend即时消失，成功必须继续quiescent核对。不覆盖文件/ARMED隔离或产品恢复放行 |
| M07完整备份协调与历史未决身份 | 已通过（源码/Windows与PG组合范围） | 2026-10-01 [协调器](../../apps/api/src/runtime/backup.ts)、[业务核对](../../apps/api/src/runtime/backup-state.ts)及[CLI](../../apps/api/src/cli/backup.ts)已组合三会话、原在途Owner、完整dump/清单和释放后complete。根最新组合7/7零skip：实际debug原生Job停止、内容/证据复制及空库归档核对；正文错配、未证明过期Worker、独立连接均拒；CLI在fence COMMIT后强杀无成功标记，原ACL显式恢复幂等、native父管道EOF释放。新增同名库替换/准入revision漂移在未修版2/2暴露错误成功，修后拒绝。人工关闭PARTIAL/NO_RECEIPT用真实Owner并保留UNKNOWN：子代理与根分别真实PG8/8，缺处置/stop proof或claim未释放仍拒；停止证明输入为fixture，真实Job覆盖由组合测试提供。最新全API217/217与关闭协议18/18零skip；指定gpt-6.1-sol按最终身份修正基准重新编译并独立组合7/7零skip，24输入SHA前后同、8关键生成入口默认/独占编译一致；旧5条基准不混。各PG已停止/清理；原失败轮与输出留本机 `output/acceptance-raw/m07-20261001-backup-*.log` | Windows当前登录会话、可信本机运维；小API资源fixture不等于确切发布包。源包二进制不复制，外部资源只留历史元数据，原UNKNOWN不盲清/重发；旧Assist核销ARMED后可能保守拒绝。本行通过不推进M07总出口ACCEPTED。新库/data_root隔离还原看下行；兼容/明确放行、确切新包与安装仍待实施 |
| M07恢复目标启动前隔离与包能力诊断 | 已通过（源码/真实Node入口与Rust分片） | 2026-10-01 [Node检查](../../apps/api/src/runtime/restore-isolation.ts)与[原生检查](../../apps/desktop/src-tauri/src/restore_isolation.rs)接入宿主启动/监督器重启及API/Worker。Node定向自检最终7/7，指定gpt-6.1-sol独占重新编译独立7/7；固定Node24的五实际子进程模式在DB连接/监听/ready/旧launch核销前拒绝，原ARMED及marker字节不变；空/坏JSON/伪造成功/目录/断开的junction均拒，路径检查错误保守拒。Rust自检7/7＋cargo check0，根独立定向7/7及全lib40/40；真实marker/root/祖先junction符合存在拒绝与无标记兼容，直接监督器入口无源ARMED消费、新启动目录或日志。API全单元最终224/224零skip，内容必要复验16/16；[包诊断](../../scripts/test-desktop-package.test.mjs)自检与独立各2/2，PS构建脚本parse0，309源码/输入fingerprint前后相同。缺能力/旧能力、任一Node入口脱线、旧EXE或未绑定模块在更新hash后仍拒作目标包，历史包基础诊断保留。首轮夹具rmdir错误、检查放错函数及桌面stdin残留已在定向反例后修正；全API前两轮分别缺助手/误指旧target助手各216/224，Rust首次全库缺RELAY_TEST_NODE为39/40，均保留原输出并按确切工具重跑，不删检查。原始输出留本机 `output/acceptance-raw/m07-20261001-restore-isolation-*.log` | Windows原生dangling symlink因1314权限不可创建，明确未覆盖，真实junction已覆盖；非Windows只插入源码，未实跑。新发布包/GUI/安装未验；包测试是小fixture，通用诊断不代替恢复协调器全清单/兼容核对。标记不是在线停机或目标数据库隔离；创建marker、新空库CONNECT隔离及产品还原看下行，明确放行仍待实现，M07总出口未完成 |
| M07新空库与新数据根隔离还原 | 已通过（Windows/PG源码隔离组合范围） | 2026-10-01 [协调器](../../apps/api/src/runtime/restore.ts)、[CLI](../../apps/api/src/cli/restore.ts)、[严格清单](../../apps/api/src/runtime/restore-backup.ts)与[文件入口](../../apps/api/src/runtime/restore-files.ts)已实现；固定PG18完整归档、原/目标包分别绑定、原48迁移与Graph/历史定义核对，staging/ARMED只进evidence，关闭后仍保CONNECT撤销/根marker。目标专用隔离真实PG自检及根独立各22/22；PG还原自检及根独立各5/5，原fence兼容独立14/14；相关单元最终根复验48/48零skip、155680ms，类型检查通过；源根单元首轮45/48因Cargo helper硬链接被正确拒绝，夹具改为逐字/SHA及nlink=1绑定的发布包普通副本，未放宽生产规则。组合此前5/6：全表/正文/原UNKNOWN身份、篡改/非空/重hash元数据拒绝、实际CLI强杀通过；末段换向未成功注入，真实诊断为pin句柄未关时rename EPERM，夹具改到实际连接和原pin句柄都关闭后注入，完整6条根复验6/6零skip。原data_root内嵌目标真实PG反例曾错误成功，源根保护修复后单项1/1同时拒绝原路径和同卷搬迁，源目录/记录及目标ACL未变；指定gpt-6.1-sol按最终冻结源码独立完整组合7/7零skip、912409ms，包含最终源根保护，不沿用旧增量。独立前后317项源码/配置/lock与64项SQL/原生输入、10工具SHA无漂移，314个内存重编译JS与默认dist逐字一致、类型诊断0；源码集合SHA `d68e4b279cba9493991abe8129d79e2c18d702bdf1a94d7cfe45c8995683a248`。各私有PG停止并清理，实际工具尾/exit及前后基准见本机 `output/acceptance-raw/m07-20261001-restore-independent.log`，注明非全量native stdout。失败输出留本机，不拼成整轮通过；规格见[测试计划](verification-plan.md#7-windows-桌面交付验证) | 当前Windows/PG18源码与小API资源fixture，未重打完整新包/GUI/安装。历史File ID仅用于保守拒绝，源根删除重建或跨卷复制后仍须运维确认选址。可信本机运维与路径前后检查不等于对抗同OS写者隔离；PG18前导SQL重置超时初值，取消后backend可能继续等锁，失败保持隔离、不给verified、不盲重试。明确放行/配置切换、历史及外部身份核对、还原元数据后续生命周期和M07总出口仍待闭合；两处独占编译输出清理被自动审批拒绝，已停止删除，PG清理不受影响 |
| M07非空恢复目标的业务只读维护核对 | 已通过（冻结Windows/PG源码范围） | 2026-10-01 [协调器](../../apps/api/src/runtime/restore-check.ts)、[CLI](../../apps/api/src/cli/restore-check.ts)、[严格材料](../../apps/api/src/runtime/restore-materials.ts)及[非空维护会话](../../apps/api/src/runtime/restore-database-isolation.ts)已实现。最终相关根单元32/32、新会话单元7/7零skip；真实PG新会话自检及根独立各15/15，原空库入口回归22/22，启停/迁移/Graph均0、私有根清理True。根实际备份→还原→维护函数/CLI单项复验1/1零skip、660699ms，合成PG环境不改变目标；全public/Graph行、清单字节/六材料、源数据及原UNKNOWN四ID/dispatch_count不变，目标app42501/marker拒启动，篡改marker/正文拒绝，自己的PG/native结束后报告。首轮该组合0/1因夹具120秒观察期限杀CLI，保留输出，夹具对齐产品原15分钟＋close余量，未删业务断言或放宽生产规则。独立只读审查发现受控reader继承PG环境，连接前纯构造反例已证实且修为显式参数；新反例实跑通过。指定gpt-6.1-sol独立材料/reader/会话单位19/19，0skip；最终完整8条独立组合8/8零skip、1362166ms（新增维护函数/CLI路径578689ms）；所有PG/迁移/Graph/启停退出0、私有根已删除。PRE/POST323源码/config/lock与67 SQL/bootstrap/native输入、14工具摘要一致；320内存重编译JS与默认dist逐字0差异、类型诊断0，源码集合SHA `981fd38235014698f990954efd695b28610b1de31ed163eb51c3cbac48c951b6`。本行绑定该冻结基准，不自动覆盖后续其余连接入口修正。原始尾/基准留本机 `output/acceptance-raw/m07-20261001-restore-check-*.log` 与既有worker日志，非全量native stdout | 仅当前Windows/PG18源码、小资源fixture和SELECTED状态投影/清单文件；原备份/原包仅STORED绑定，不认证历史真实性。内容锁首次可能创建sentinel，业务只读不等于FS零写。报告固定ISOLATED/NOT_GRANTED，完整历史执行/Graph正文兼容、目标依赖可调用性、外部live身份、配置/唯一Owner和明确激活仍待核对；报告不授未来放行，restore/evidence后续维护生命周期未闭合。未新发布包、GUI/安装或Provider外呼，M07总出口仍未完成 |
| M07维护数据库连接参数隔离 | 已通过（冻结Windows/PG源码范围） | 2026-10-01 [固定参数](../../apps/api/src/runtime/maintenance-connection.ts)接入备份attest/应用Pool、源fence hold/recover及空恢复目标；关键缺省连接项不继承进程PG环境，仍保留源显式远程/TLS/options、原有限本机URL和固定超时。实际无网络构造反例先证实四处继承；只读评审修正query提升Client/Pool内部选项及ssl=no-verify丢失导致TLS关闭。最终根相关单元36/36、子代理空目标单元6/6；源fence真实PG自检与根独立各16/16，空目标各23/23，零skip/exit0，原ACL恢复/原journal不变及target42501保留。root完整备份7/7零skip、96716ms，正向产品调用注入合成环境；原Job/正文/Graph/归档及故障断言保留。首轮单元14/16因SSL对象prototype比较，后仅归一比较字段；首轮备份0/7因实际DesktopDev占单实例guard，按原授权核对PID51796/EXE后正常关窗再复验，未绕过guard。相关私有PG启停/迁移/Graph全0且根已删除；worker22输入SHA无漂移。原输出/摘要留既有root、worker与independent raw日志，注明非全量native stdout。指定gpt-6.1-sol在新冻结基准独立单元11/11零skip、872ms，完整恢复8/8零skip、1313143ms；私有5a807c3c6a启停/迁移/Graph均0、已删除。PRE/POST325 API输入、67 SQL/native/config输入及18工具摘要无漂移，322 JS内存emit与默认dist逐字0差异、类型诊断0；源码集合SHA `9fd961aafede9c3a36d1a3e456e6694bd9601e0edcd51180d74eee134a50e62e`。根已读取实际工具尾/exit及清理摘要，不沿用上一行981成绩；本行仅绑定本次冻结输入，不覆盖下一片包依赖探针 | Breaking Change: Yes（运维URL不再通过PG环境补齐目标或凭据）；无HTTP/schema/migration变化。直接pin当前pg已传递使用的parser2.14.0，无升级。参数比较不等于真实TLS握手/证书验收；源码与小资源fixture不等于新完整发布包/GUI/安装，目标仍ISOLATED/NOT_GRANTED；M07总出口未完成 |
| M07目标包离线依赖加载与有限调用 | 已通过（冻结Windows/PG源码有限范围） | 2026-10-01 [探针](../../apps/api/src/runtime/restore-runtime-probe.ts)接既有restore-check；最终根相关单元35/35、318369ms、exit0/零skip与cancel，新probe16条使用完整普通生产库树16940文件/96283321bytes，树摘要前后相同。真实Node核对10直接库声明/metadata/ESM入口及传递ESM/CJS字节绑定，有限构造/compile/inject/本地图/parse；真实越界、进程/Worker/DNS、中文跨UTF8帧、晚导入、超输出/取消与60秒挂起在owned close后拒绝。首轮24/35为固定脚本括号缺失，后两轮各34/35分别为初始化错误未结构化、中文整包rename EPERM；修复不删断言，详见[根因](../development/m07-backup-recovery.md#目标运行包的有限离线依赖核对)。类型及实际脚本语法检查通过，原失败和最终输出留本机 `m07-20261001-runtime-probe-root.log`/worker日志；指定gpt-6.1-sol在新冻结基准独立35/35、317103ms、exit0/零skip与cancel；PRE/POST327 API输入、67 SQL/native/config及18tools无漂移，324 JS内存emit与默认dist逐字一致/类型诊断0，完整普通库树摘要b812bb…前后一致。源码集合SHA `2f75942e18c9bd8c9699a01e4d9746135f44cec127062b03dd6d7d8773e35053`，实际尾与输入核对留新runtime-probe-independent.log，不沿旧9fd成绩。首轮PG观察因外层日志管道卡pg_ctl，迁移/Graph/tests均未运行，原私有集群已准确停止/删除；根随后直接入口真实PG定向1/1、902193ms、exit0/零skip与cancel；实际函数/CLI核对保持每行、原UNKNOWN四ID/dispatch_count=1、材料字节、应用42501与ISOLATED/NOT_GRANTED，篡改仍拒绝；48迁移/Graph/PG启停均0、私有17de6db894及目标夹具实际已删除。此为改变的第八项定向出口，不继承历史完整8成绩；指定gpt-6.1-sol同冻结输入独立真实PG定向1/1、1450403ms（suite1454152ms）、exit0/零fail/cancel/skip，函数及实际CLI原断言全部通过；48迁移/Graph/PG启停均0、私有1d251aea4f已删除，根实际核原postmaster46064不存在。独立PG POST类型诊断0、默认324 JS逐字差异0，327 API输入/67 SQL-native-config/18工具及完整16940库树相对unit PRE与PG PRE无漂移；最终源码2f75942…/emit d284f5…/库树b812bb…保持，实际尾和FINAL_PROOF已读回，既有raw明确非全量native stdout | 仅PACKAGED_DEPENDENCIES_OFFLINE_ONLY；历史source包规则不变，目标包完整依赖要求为运维Breaking Change: Yes，HTTP/schema/migration无变化。没有数据库Saver/Provider/工具调用或新完整发布包/GUI/安装；五个pending继续保留，ISOLATED/NOT_GRANTED不变。占锁DesktopDev两次正常关窗后仍未退出，按原授权核对PID52944/EXE/启动时间/runner65288启动链后只结束该宿主，实际退出；未停止用户PG，正常关窗问题未定位 |
| M07受管资源根身份有限观察 | 自检通过；独立验收待补 | 2026-10-01 [根观察](../../apps/api/src/runtime/restore-resource-roots.ts)接restore-check，[单次原生请求](../../apps/api/src/runtime/restore-files.ts)与原源祖先保护复用；根实际编译exit0，新[单元15项](../../apps/api/test/unit/restore-resource-roots.test.ts)及原源根7项实跑22/22，fail/cancel/skip0、48868ms。工具末段未返回native exit字段，原handle已结束，不虚报捕获exit0。真实Rust File ID覆盖同路径替换、同卷搬迁/大小写别名、链接及null；协议/输出/10秒挂起/取消/持锁/助手漂移反例在自己的child close后结束，根正文/目录项不变。完整PG首轮0/8因before夹具错误假设旧登记助手ENOENT会返回null，尚未进入restore/check；仅改初始私有fixture，实登记后在备份快照前设置合法nullable字段，生产规则与原断言保留。修后原[完整组合](../../apps/api/test/integration/restore.integration.test.ts)8/8、exit0，fail/cancel/skip0、2115599ms；第八项函数与实际CLI1319720ms，三种根报告一致，外部正文/目录项、全部public/Graph行、原UNKNOWN四ID/dispatch_count、六材料、应用42501与ISOLATED/NOT_GRANTED均保持，篡改仍拒绝。48迁移/Graph/PG启停均0，私有cf0a831e6c已删除，原postmaster45620不存在，剩余还原fixture0。PRE/POST376源码/326JS及所列Node/helper/lock/wrapper摘要无漂移，内存emit与默认输出0差异/诊断0；源码SHA c9daaf3e84b59a1d0c3aeb060b43d8dd2a2ebe0dc6f113feb2735c467fe0ba12。普通依赖16940项本轮摘要6ac7d9…前后一致，与旧b812不同，十个直接版本匹配，不继承旧成绩；本次有限审计未声称冻结全部PG/desktop工具。实际尾、失败与最终比较留本机 output/acceptance-raw/m07-20261001-resource-root-root.log 及 pre/post.json，非全量native stdout | 仅REGISTERED_MANAGED_ROOT_IDENTITIES_ONLY，不读外部正文/创建外部sentinel、不改登记或执行权；128根/30秒合作预算与单次10秒，不承诺OS硬RTO。四种结果分列，全部五项pending及ISOLATED/NOT_GRANTED保留；维护CLI Breaking Change: Yes，HTTP/schema/migration无变化。指定gpt-6.1-sol返回当前ChatGPT账号不支持，用户明确要求保持该模型等待恢复；本轮独立审查/验收尚未完成，主代理自检不算独立通过。未验完整历史兼容、外部事实、激活、新发布包或安装 |
| Windows 安装/升级/卸载/备份恢复及 V1 总交付 | 未验收 | 发布诊断及上述维护/备份/隔离启动分片已有实现/验证，见[M07](m07-independent-acceptance.md) | 安装与完整备份恢复总矩阵；整体仍不通过 |

本表没有用不同轮次成绩拼成“当前全量通过”。2026-09-30 早先源码 PG 全量 491 通过/0 失败/5 跳过、后续受影响 65/65 与本轮 M03 全量 495/0/5 分别绑定实际运行时点；后续视觉以最近全量及其后受影响定向、最终包静态证据分别记载。最后辅助页与面包屑补修的反例和复验见纠偏记录；“未验收/未接入”不自动等于运行失败。本轮 M03/M04/M07 完整输出留在忽略目录 `output/acceptance-raw/m03-20260930-*.log`、`m04-20260930-*.log`、`m07-20260930-*.log`，含首失败及必要复跑；临时 PG 清理通过。并行 UI 改动不自动继承本轮前端或冻结包成绩。

## 原始输出归档

完整历史 stdout/stderr、逐进程 JSONL 和批量源码摘要已集中到[原始输出压缩包](evidence/raw-output-20260930.zip)：386 个证据条目（原历史 379 个，末轮 UI/发布补充 7 个），压缩包内 `_archive-index.json` 保存原路径和 SHA-256，本次逐项解压读取核对通过。`#entry=...` 链接指定 ZIP 内原条目；按需解压再复查，不作为默认 AI 上下文。原文件移至忽略的本机目录 `output/acceptance-raw/history-20260930/`，Git 删除项用于停止原始条目的版本保留，必要概要/截图/复跑脚本继续保留。后续输出遵循[保留规则](../README.md#6-验收结果与原始输出保留)。

## 历史验收记录

以下保留 2026-09-28/29 原始结论、失败与修复时点，不作为另一份当前状态表。

原记录：整体可用性验收（2026-09-28）

接续：用户报告整改完成后，本记录追加第 4 节独立复验；下方第 1–3 节保留首轮证据，不用新成绩覆盖历史失败。

范围：当前工作树的代码、实际浏览器页面、自动化回归与既有桌面证据。结论：**整体暂不通过**。人工基础闭环可运行，但不能作为真实模型可用、完整 UI 或 Windows 安装交付已完成的证明。

基准：HEAD `39edb226b418da139fdf9757a8963591dfe59ca6` 加现有未提交修改；本轮没有修改产品代码或用户配置。工作树存在其他开发改动，证据绑定本轮读取/运行时点，不自动覆盖后续修改。进度仍由 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md) 维护。

## 1. 实际验证

| 层次 | 本轮结果 | 证据与限制 |
|---|---|---|
| Workbench 单元/组件 | 56 文件，336/336 通过 | `evidence/overall-acceptance-2026-09-28/workbench-tests.log` |
| API 单元 | 130/130 通过 | `api-unit.log`，无真实 Provider 外呼 |
| 类型/构建 | Workbench tsc 通过，API 集成包装器 tsc 成功；Vite 生产构建通过 | `workbench-typecheck.log`、`api-integration.log`、`workbench-build.log`；前端输出到 output/overall-audit-build，未替换桌面包 |
| PostgreSQL 全量 | **461 项：449 通过、9 失败、3 跳过**，退出码 1 | 隔离临时 PG18，42 条迁移；耗时约 962 秒，PG 正常停止且临时目录删除 |
| 真实 API 人工闭环 | 1/1 通过 | `real-api-browser.log`；创建项目/任务→开始→保存版本→选用→完成→重开→刷新历史；临时 PG 停止且目录清理 |
| 实际页面 | 10 个 live 页面/状态只读检查，无 pageerror、无横向根溢出、无 action-error | [页面记录](evidence/overall-acceptance-2026-09-28/live-pages.json)，1280×800；另任务列表 960×640 截图。没有覆盖全部 33 页面/状态的业务交互 |
| 模型 | 现场 API 配置为真实 Provider，调用能力未验 | 设置显示 agnes-3.0-flash；只读状态不代表认证、协议、Worker 或生成成功。本轮未外发项目内容，未读取/输出密钥值 |
| Windows/安装 | 本轮未重建并复验确切 EXE、DPI、安装升级 | 历史桌面证据保持原边界，不能代替当前工作树验收 |

所有日志位于 `docs/testing/evidence/overall-acceptance-2026-09-28/`；日志可能被 Git 忽略，交接时须保留本地文件。页面记录只保存页面可见文字，不保存请求头或配置密钥。复跑脚本 `live-audit.mjs` 从本机配置在内存中完成认证，只做页面读取。

9 项失败分组：迁移基线 4、Skill 蓝图 3、控制顺序 1、网页导入 1。后面三组定向分别 5/5、1/1、1/1 通过，不覆盖全量失败。至少一个跳过项是 Windows helper 强杀无回执处置，不能将跳过视为通过。文档检查通过（98 Markdown、1773 链接、126 token、29 对比度检查）；关键源码 SHA 保存在 `source-hashes.json`，收尾核对未变化。

## 2. 按优先级的问题

### A01 / P1：模型“已配置”与“可用”没有闭环

**已确认产品缺口，调用失败根因尚待实测。** `apps/api/src/api/model-api.ts` 仅调用 `describeModelPortStatus(process.env)`；该函数只检查配置格式。`SettingsView.tsx` 展示模型名和端点，没有配置、验证连接、最近调用结果、Worker 实际配置一致性或修复入口。现场已有真实 Provider 配置，所以不能继续把“没有填模型”当成当前唯一原因，也不能说适配器完全不存在。

后端已有 `OpenAiCompatibleModelPort`，走流式输出，部分 Assist/语义验收要求 JSON 输出。真实端点是否兼容、授权是否有效、Worker 是否消费同一配置及调用是否落库，均未由只读页面证明。UI/API 已连接、模型已配置、模型调用成功必须分别呈现。

验收：在明确允许真实调用的阶段，使用不含项目资料的固定短文本验证端点，再核对 Assist 与 Delegate 的真实请求、流、终态和用量；401/403、429、超时、取消、断流、协议不兼容都有可理解反馈，不能回退 Mock 冒充成功。

### A02 / P1：测试版配置保存路径不完整

**代码确认。** `scripts/test-desktop.ps1` 的 Start 路径无条件 `WriteAllText` 重写 `.relay-test/desktop.env`，仅保留数据库和工作空间字段。若用户把模型参数加在该文件，下次 Start 会覆盖；`apps/api/.env` 又是另一条开发路径，不能假设桌面会加载它。宿主 `lib.rs` 从自己的 config path 启动 API，模型配置也可能从父进程继承，因此不能断言所有桌面实例必然是 Mock。

验收：明确开发/桌面配置 Owner 与来源；保存模型配置后 Start、Stop、重新 Build/Start 仍保留，API 与 Worker 指纹一致；密钥不出现在页面、日志、URL、截图和仓库中。不把运行态数据库字段与用户配置混写覆盖。

### A03 / P1：全量数据库回归出现红灯

**已复现。** `apps/api/test/integration/cli.integration.test.ts` 的 `migrate entry reports the applied migrations without repeating them` 仍要求迁移列表截止 0032，`ledger_rows === 32`；`migration.integration.test.ts` 的 ALL_MIGRATIONS 截止 0039，导致首次应用、advisory lock 和并发迁移三项失败。本轮真实库已应用 0042，共 42 条。不是据此认定迁移本身坏了，而是测试基线落后，当前不能宣称全量回归通过。

验收：核对新增迁移、账本、SHA 与幂等后修正有效预期，不删除断言；定向和全量复跑。不得将“退出 0”代替账本完整性检查。

### A04 / P1：页面仍把工程信息当成用户主流程

**现场可见。** 新建项目页完整截图高度 **4039px**（1280px 宽），创建表单下方直接铺开多版本 Pack、历史状态和长摘要；设置页同样大量铺开清单。项目列表把 UUID、`下一步 Task ID` 和“列表未单读 Task”等实现解释直接展示；这不是长期项目用户需要首先处理的信息。

验收：主区以项目名、目标、下一步标题和主要动作组织；版本/hash/历史组合折叠至“来源与技术详情”，保留可追溯性。新建项目默认只呈现当前创建所需内容，不用隐藏真实风险或删功能换取简洁。

### A05 / P1：响应式与视觉层级尚未逐页收敛

**现场可见。** 960×640 任务页第一条数据约从 y=557 开始，上半屏被标题、说明、筛选占据；搜索控件有重复边框感。1280×800 知识空态中“新建”按钮两字上下换行，列表标题又保留 `Knowledge 资料`；知识/待审仍使用明显偏大的标题，而今日已采用紧凑标题。页面可打开并不等于版式验收通过。

证据：[知识页面](evidence/overall-acceptance-2026-09-28/knowledge.png)、[创建项目](evidence/overall-acceptance-2026-09-28/projects-view-create.png)、[任务窄窗](evidence/ui-live-integration-2026-09-28/page-prompts/audit-tasks-viewport.png)。

验收：按已有 33 页面/状态映射逐页登记，覆盖有数据、空态、失败、等待人工、窄窗；共享标题/控件/筛选/阅读区保持一致；1280×800、960×640 与真实 Windows 125%/150% DPI 都留证据。沿用既有视觉方向与 token，不额外发动整体换风格。

### A06 / P2：若干入口仍没有承诺的操作能力

**代码确认，需逐项判断 V1 必需性。** `ProjectSkillView` 仍注明确认人/确认时间等待接口；`ConnectionsView` 的只读健康核对只刷新配置，不探测实际目录/主机可达性；Activity 的执行方筛选只覆盖已加载页。设置页仍说人工介入提醒“策略与调度尚未冻结”，与同日已确认规则和通知实现记录存在表述漂移。

验收：对照 V1 范围建立“入口→命令/查询→失败出口”清单。需要的功能补闭环；未承诺项明确边界，不为了消灭“暂不可用”而扩展深色主题、多语言或通用设置系统。通知策略已确认与偏好写接口未实现应分别描述。

### A07 / P2：构建有性能风险信号，未测量用户等待

**构建实测。** 主 JS 约 1094.56 kB，gzip 298.71 kB；所有主要页面由 router 静态导入；构建另报 Tauri window 同时静态/动态导入，动态导入不能拆分。不能仅凭大小断言卡顿，但需要测冷启动、路由切换、首反馈与模型首字延迟后再定向处理。

### A08 / P1：阶段证据和现场配置不一致，总交付证据不足

**文档与现场确认。** 当前主文档仍保留真实 Provider 关闭的门槛说明，现场 API 已配置真实 Provider；需要核实是否有后续用户授权和对应证据，不能自行关闭或改写用户配置。M03 总门槛、M04/M05 独立验收、M06 总出口与 M07 安装升级不能从组件绿灯推导通过。

验收：把历史通过、当前源码、当前 EXE 和当前配置各自绑定；补齐缺口后更新唯一阶段入口，不堆叠互相冲突的“当前接续”结论。

### A09 / P1：控制优先级回归在全量环境下失败

全量 PG 的 `M03 pending PAUSE, CANCEL and HANDOFF outrank an approved successor at the old START safe point` 失败；同一构建在隔离 PG 按 `run-command-order` 定向复跑通过。不能用单次转绿抹掉全量红灯，也不能据此认定生产暂停/取消必然失败。需核对完整失败堆栈、LOST 分支的停止证明与 requeue 顺序，区分测试编排缺陷和生产竞争；保留两份日志，并用可控 barrier 复现后验收。

最终失败点是 `HANDOFF: requeued delivery must claim the CONTROL_PENDING command`，并非最前面的 `CONTROL_PENDING` 优先级断言；整改应先检查 LOST 后重投递的测试编排，不把失败标题直接当作生产根因。

证据：`api-integration.log` 与 `control-order-recheck.log`。初次定向调用误选 `run-dispatch` 文件，没有产出目标用例成绩，已停止该次自建测试进程；包装器确认 PG 停止且临时目录删除。`control-priority-recheck.log` 的中止失败不算产品缺陷，也不算此用例的复验成绩。正确文件的定向运行 1/1 通过并正常清理。

### A10 / P1：Skill 蓝图用例在全量环境下失败，独立文件转绿

全量中“归档显式来源使蓝图失效”“Skill 冻结来源并应用同一候选”“基线变化与取消不生成候选”三项失败。`project-blueprint` 文件在另一隔离 PG 中 5/5 通过，不能直接认定三个产品功能均损坏，也不能抹掉全量失败。应检查共用数据库的待处理 Assist 消息、Worker 领取对象、前序测试清理及失败传播，使用请求 message ID 校验正确消费；根因待最终堆栈与确定性复现。

最终堆栈分别显示：来源预览 `stale` 为 undefined 而非 true、生成 tick 为 FAILED 而非 COMPLETED、tick 的 message ID 与当前请求不符。最后一个反例支持优先调查全局领取与共享数据，但仍不足以单独确认根因。证据：`api-integration.log`、`blueprint-recheck.log`。

### A11 / P1：网页导入全量计数受额外失败任务影响

`an AUTO web import lands the fetched page in Knowledge with provenance` 全量失败，tick 的 `[prepared, dispatched, succeeded, failed]` 实际为 `[1,1,1,1]`，预期 `[1,1,1,0]`。在隔离库定向 1/1 通过，且 PG/目录正常清理。该结果说明本轮成功导入同时存在一项失败统计，不能直接断言目标网页未导入。检查 `runWebImportTick` 的全局任务扫描、过期任务处理与测试遗留；保留来源和幂等断言，不删除 failed 计数后宣称通过。证据：`web-import-recheck.log`。

## 3. 结论边界与交接

这次确认了基础工程及人工闭环可运行，也确认了回归红灯和具体产品缺口。没有证据证明“所有模型调用都失败”，也没有证据证明“真实模型已经打通”。真实外呼、全部页面交互、故障恢复全组合和当前安装包仍待验收。

整改入口：[整体整改提示词](../../prompts/overall-remediation-2026-09-28.md)。本轮只做验收、证据与提示词，未实施整改。文档影响：更新阶段摘要和提示词导航；不改需求、架构、ADR、API 或数据模型，不新增重复路线图。

## 4. 整改后独立复验（2026-09-28 夜间）

用户报告任务已完成后，复验当前 HEAD 加未提交修改。**总体仍不通过：第一包已有修复、UI 局部改善，但第二包真实模型、第三包全页面 UI 与第四包桌面交付尚未完成。** 没有修改产品代码或用户配置；本节只验收、增加独立反例和维护文档。

### 4.1 核验范围与实跑

证据目录：`docs/testing/evidence/overall-recheck-2026-09-28/`。

| 检查 | 本轮结果 |
|---|---|
| 原有 Workbench 组件测试 | 56 文件，336/336 通过 |
| 新增下一步标题反例 | **2/2 失败**，证据独立于常规 336 项，不修改原测试集 |
| API 单元 | 130/130 通过 |
| Workbench 类型/构建 | 通过；JS 1098.29 kB，gzip 300.02 kB，仍有大包与无效动态导入警告 |
| 人工真实 API/PG 浏览器闭环 | 1/1 通过，PG 停止、临时目录清理 |
| 配置合并 | 提取生产脚本原合并块，在合成配置上验证模型字段保留、运行时键唯一、重复合并幂等，通过；未改真实配置 |
| Rust 配置白名单 | 正确 MSVC target 下 1/1 通过；首次误用机器默认 GNU target，测试进程以 STATUS_ENTRYPOINT_NOT_FOUND 退出，属于工具链执行问题，不算白名单断言失败 |
| 诊断脚本 | 2 通过、1 跳过 |
| 当前测试包 | **失败**：`test-release/desktop-build-manifest.json` 不存在；包核验脚本返回 ENOENT |
| live 页面 | 同前轮 10 个页面/状态检查，无页面异常和根横向溢出；新增任务 960×640 测量；并非全部 33 状态验收 |
| 独立全量 PG | **462 项：440 通过、19 失败、3 跳过**，退出 1；19 项均属首文件启动/清理异常，后续用例通过，原 9 个失败场景本轮全部通过；PG 正常停止且临时集群删除 |

开发方 `evidence/remediation-2026-09-28/full-pg-run1.log` 的 461 项（458 通过、0 失败、3 跳过）是开发自检记录。本轮未把它冒充独立实跑。3 个跳过涉及两个真实模型用例和一个需要 debug helper 的强杀用例，不构成真实 Provider 或完整恢复验收。

### 4.2 A01–A11 关闭判断

| 原项 | 状态 | 当前证据及剩余工作 |
|---|---|---|
| A01 模型闭环 | **未关闭** | 模型 API/config 代码与首轮 hash 相同；只增加设置页四态文案。verified/worker 均写死“尚未验证”，没有验证命令、结果查询、配置入口或真实模型闭环证据 |
| A02 桌面配置 | **部分通过** | 脚本合并与宿主模型键白名单通过源码级验证；没有当前确切包的 Start/Stop/重建保留配置及 API/Worker 实际指纹证明 |
| A03 迁移基线 | **对应修复通过** | 32/39 的过期清单补齐到 42，保留原完整性/幂等断言；独立全量对应 4 项通过，但全量总门槛仍受首文件启动问题影响 |
| A04 工程信息过重 | **部分改善，未关闭** | Pack 默认折叠，创建页从 4039px 降到 1906px；仍展示四个当前组合和工程解释。项目下一步新增标题，但存在本节反例 |
| A05 逐页布局 | **未关闭** | 知识“新建”仍上下换行；960×640 任务首行 y=533，首屏数据仍少。没有 33 状态、125%/150% Windows DPI 验收记录 |
| A06 能力/文案缺口 | **未关闭** | 通知页“策略与调度尚未冻结”旧文案仍在；确认事实、连接真实探测等原边界未完成，不把缺主题/语言列为强制新功能 |
| A07 性能 | **未关闭** | 没有新性能采样或路由拆包；主 JS 仍约 1.10MB，不据此断言必然卡顿 |
| A08 总交付与事实源 | **未关闭** | 配置来源报告解释浏览器/桌面差异，但阶段主文档未记录整改接续；当前测试包缺清单且 EXE 时间早于本轮宿主改动，无安装/升级证据 |
| A09 控制顺序 | **对应修复通过** | LOST 分支改为先 stop/reconcile/requeue，再重投递，并核对正确 worker/epoch；本轮对应场景通过，没有删断言或简单增加循环次数 |
| A10 蓝图 | **对应修复通过** | 归档测试通过领域命令取消遗留 Assist，蓝图新增领取 message ID 断言；保留来源失效与候选应用检查，本轮原 3 项通过 |
| A11 网页导入 | **对应修复通过** | Gateway fixture 在自身断言后结算遗留 import，保留网页导入的成功/失败计数断言，本轮对应场景通过 |

### 4.3 本轮新增确定缺陷：下一步标题刷新无效（P2）

位置：`apps/workbench/src/views/ProjectsView.tsx`，`taskTitles/resolvedTasks` 的 useEffect。ID 在发请求前即加入 resolvedTasks，成功和失败均永久保留，点击“刷新当前范围”只重读项目列表，不清除标题缓存。

两个反例均在当前组件上失败：

1. 首次显示“旧下一步”，服务端改名后点击刷新，仍显示旧标题。
2. 首次任务单读 503，服务端恢复后点击刷新，仍显示“标题暂不可读”，不再发第二次读取。

证据：[独立测试源](evidence/overall-recheck-2026-09-28/title-refresh.spec.ts)、`title-refresh.log`。复跑：在 apps/workbench 执行 `node node_modules/vitest/vitest.mjs run --config ../../docs/testing/evidence/overall-recheck-2026-09-28/title-refresh.config.ts`。应在显式刷新时重新校验标题，并给失败结果可重试出口；避免旧请求覆盖新一轮结果。不能只把 UUID 换成永不过期的缓存标题。

### 4.4 当前桌面包与模型工作包为何不能通过

- `test-release` 只有 exe、node、helper 和 api，缺 package manifest。`test-desktop.ps1` 在新启动时明确要求清单；已运行窗口不代表新启动可成功。EXE 时间为 20:59:51，宿主配置白名单修改为 22:41:48，不能证明新配置能力已经进入该包。本轮不重打包掩盖交付缺口，也不关闭用户现有窗口。
- 开发记录 `model-verification-design.md` 明确写 **Design only（实现阻塞）**。没有真实调用放行时不外呼是正确的，但不应停止不依赖真实调用的配置/验证入口实现及本地错误注入。本轮不补做实施、不擅自改变模型门槛；需按原提示词完成离线实现、门槛验证与获准后的真实调用证据。
- 设置页对浏览器实例也直接写“Worker 与 API 同一配置文件”，而配置来源报告明确 dev-stack 不启动 Worker。页面应反映当前宿主事实或标为未知，不能用桌面链说明替代浏览器 Worker 证据。

### 4.5 独立全量的启动异常与复验边界

首个 api-artifacts 文件的 before hook 未在 15 秒内获得 API liveness，18 个用例连带失败；after hook 对未赋值 api 调用 stop，留下测试/子进程，阻塞后续文件。核对 PID/父子关系及独立集群后，只终止本次自建的该测试和 API 子进程，让其余文件继续。之后同构建、隔离 PG 的 api-artifacts 文件独立 **18/18 通过**，PG 正常停止且目录清理。不能把此复跑与其余文件拼成一次无失败全量，也不能据此认定 18 个业务功能损坏。证据：`api-integration.log`、`api-artifacts-retry.log`。

最终堆栈确认 18 项均为 `the API did not become live within 15000ms`，第 19 项为 `Cannot read properties of undefined (reading 'stop')`，因此测试计数比首轮多了一个文件钩子失败。启动超时根因未定位，不武断归因负载；测试 harness 应在启动失败时回收已创建的子进程/数据目录，after hook 处理未完成初始化，避免挂住整个全量。关键源码收尾 hash 与本轮快照一致。文档检查最终通过。

文档影响：在本记录保留首轮与复验差异，更新唯一阶段入口；修复整改配置来源报告的 A02 锚点。没有改变需求、架构、API、数据模型或本轮生产实现。

## 5. 整改实现与独立复验（2026-09-29 凌晨）

用户授权按原整改提示词完成开发、返修、独立复验和文档同步。本轮由协调 Agent 分派并独立验收；实现者自报结果均经复跑核对。证据目录：docs/testing/evidence/remediation-2026-09-28/。

### 5.1 本轮实跑

| 检查 | 结果 |
|---|---|
| Workbench 类型检查 | 通过 |
| Workbench 组件测试 | 58 文件，**346/346 通过**（含标题反例 2、设置页六态、UI 整改新增项） |
| API 类型检查 | 通过 |
| API 单元（系统 node） | **135/135 通过**（含 model-port-verify 5） |
| 全量 PG 集成（单轮干净跑） | **469 项：466 通过、0 失败、3 跳过**，status: PASSED |
| 首文件 api-artifacts | **18/18 通过**，livenessMs≈1.8s，无启动超时连带 |
| 原标题 evidence 反例 | 2/2 通过（已纳入正式回归） |
| 桌面包 verify-desktop-package | Package hashes verified. |
| 桌面诊断 | package/node/webview2/config/database PASS；schema 在未迁移 DB 上 FAIL，Start 迁移后具备条件 |
| test-desktop Start 冷启动 | 退出 0；迁移 43 条、Graph ready、workspace 建立、3 个包进程运行 |

3 项跳过原因不变：2×RELAY_MODEL_* 未配置真实外呼、1×Windows helper 既有 SKIP。

### 5.2 A01–A11 与新增项关闭判断

| 原项 | 状态 | 本轮证据 |
|---|---|---|
| A01 模型闭环 | **离线闭环已关闭；真实外呼仍阻塞** | POST /model-port/verify + GET /model-port/verification + model_calls(kind=VERIFY)；设置页六态替换写死「尚未验证」；Fake 五分支（SUCCESS/AUTH/TIMEOUT/INVALID_MODEL/NETWORK）真实 PG 落账本；响应无密钥。真实 Provider 调用无放行记录，不外呼 |
| A02 桌面配置 | **部分通过** | 合并与白名单保持；	est-release 已重打包且含 manifest；Start 冷启动与升级备份链通过。Stop 须先关窗口（不强杀），重启保留完整链路待人工关窗后补测 |
| A03 迁移基线 | **保持通过并扩展** | 0043 入账后 cli/migration 清单基线补至 43；全量对应项通过 |
| A04 工程信息过重 | **部分关闭** | Pack 当前组合收进 <details>，首屏摘要一行 |
| A05 逐页布局 | **部分关闭** | 960×640 任务首行 y=312（原 533）；搜索双框消除；知识「新建」nowrap；1280×800 同步改善。**33 状态全矩阵与 Windows 125%/150% DPI 仍未验收** |
| A06 能力/文案缺口 | **部分关闭** | 通知偏好改为工作台 11.5 已确认规则；工程术语人话化。连接真实探测等边界未扩 |
| A07 性能 | **未关闭** | 未测冷启动/导航分位数；不宣称流畅或卡顿 |
| A08 总交付与事实源 | **部分关闭** | 本记录 + CODEX_NEXT_STEP 已同步；当前包 EXE SHA-256 6D3F80359336D7288FC8755E87D871E29C0EBB7E92E039DF889852FDEE6E8F87，manifest SHA-256 0E04E6A919BCAF5E5B46039D5EF047017265F1B14B8234F8E1BFD3F462A85ADC，17169 资源哈希通过；安装/升级/卸载属 M07 |
| A09 控制顺序 | **保持通过** | 全量对应场景通过 |
| A10 蓝图 | **保持通过** | 全量对应场景通过 |
| A11 网页导入 | **保持通过** | 全量对应场景通过 |
| 新：标题刷新 | **已关闭** | 根因 
esolvedTasks 请求前永久标记；改为结束后写入 + 刷新整批失效 + epoch 丢弃过期响应；反例 2/2 转绿并纳入 projectsTitleRefresh.spec.ts |
| 新：集成启动/清理 | **已关闭** | 失败回收本 PID+data_root；after 可选链；liveness 区分退出/spawn/未监听；干净全量 0 失败 |

### 5.3 当前桌面包

- 路径：	est-release/（uild-release.ps1 -TestPackage）
- EXE SHA-256：6D3F80359336D7288FC8755E87D871E29C0EBB7E92E039DF889852FDEE6E8F87
- manifest SHA-256：0E04E6A919BCAF5E5B46039D5EF047017265F1B14B8234F8E1BFD3F462A85ADC
- 构建时间（UTC）：2026-09-28T17:35:16Z
- 包内含 pi/dist/src/workflow/model-port-verify.js（本轮模型修复已进包）
- 会话 session.json.manifest_hash 与上述一致；升级前自动备份 .relay-test/before-upgrade-20260929-*.dump
- 窗口已由 Start 打开；未强制关闭用户窗口。Stop 需人工先关窗

### 5.4 剩余阻塞与最小解除条件

1. **真实模型外呼**：实现已完成；解除条件 = 用户放行记录 + 已配置 RELAY_MODEL_*，再跑设计第 4 节错误注入矩阵与真实任务链路。
2. **33 页面/状态与 DPI**：解除条件 = 真实 Windows 125%/150% 逐页取证（浏览器视口不可替代）。
3. **性能采样**：解除条件 = 冷启动/首反馈/委托领取/取消反馈的实测分位数。
4. **M07 安装升级卸载**：解除条件 = 按既有 M07 要求做安装包与数据保留验收。

### 5.5 边界声明

- **实现已完成**（离线可验证范围）：模型验证闭环、标题刷新、UI 优先项、集成测试启动/清理、桌面包清单。
- **真实环境验收未完成**：真实 Provider 外呼、Windows DPI 矩阵、安装升级、性能分位数。
- 未删除失败检查、未拼接不同轮次结果、未伪称真实模型已验。

## 6. 真实外呼验收与遗留缺陷修复（2026-09-29 白天）

用户授权在具备已配置 Provider（`apps/api/.env`，openai-compatible / agnes-3.0-flash，用户此前写入的已授权凭据）时运行真实外呼验证。本轮由协调 Agent 分派四个并行执行 Agent（模型外呼、UI/DPI 取证、性能采样、桌面修复）并独立核对各报告与证据；5.4 节四项剩余阻塞中的三项取得实质进展，另发现并修复两个新缺陷。密钥全程未读取/未输出，日志脱敏（`grep` 复核 0 命中）。

### 6.1 本轮实跑

| 检查 | 结果 |
|---|---|
| Workbench 组件测试 | 58 文件，**346/346 通过** |
| API 单元 | **136/136 通过**（新增 1 例 VERIFY 结算映射单测） |
| 全量 PG 集成（干净单轮） | **471 项：466 通过 / 0 失败 / 5 跳过，status: PASSED**；PG stop exit 0、临时集群删除。5 项跳过 = 2 真实模型 opt-in（既有）+ 2 本轮新增取消反例 opt-in（本轮全量未带外呼环境）+ 1 Windows helper 既有 |
| 真实连接验证 | **通过**：`POST /model-port/verify` 200，latency_ms=872，`model_calls(kind=VERIFY)` 落账本 input=79/output=10；并发第二次 409 `MODEL_VERIFY_IN_PROGRESS`（2.8ms，未外呼）；验证后 `matches_current_config=true` |
| 真实 DRAFT 任务链路 | **通过**：Delegate→BUILD_CONTEXT→真实 DRAFT→WAITING_APPROVAL；候选为真实模型文本且含预埋探针标记（证实消费显式选源）；`completion_records=0` 完成门保持；DRAFT 账本两次真实用量 |
| HARD SEMANTIC 真实语义检查 | 修复后 **4/4 PASSED**（修复前挂起 >25 分钟自死锁）：3.8–11 秒收敛 WAITING_APPROVAL，check_results 落库（fake=false、真实用量），账本无孤儿 STARTED |
| Fake 错误注入矩阵 | model-verify 集成 **8/8 通过** |
| Fake 定向集成回归 | 5 文件 **104 过 / 0 失败**（run-graph 59+1 opt-in skip、verification 25、run-steps 8、run-command-order 7、model-call-budget 5） |
| 33 状态矩阵 | **31 pass / 2 unverified / 0 fail**；1280×800 与 960×640 两轮横向溢出 0、pageerror 0、console error 0 |
| Windows DPI | 原值即 **125%**：桌面窗口 GetDpiForWindow=120、devicePixelRatio=1.25，九页 PrintWindow 真实截图取证通过、无裁剪/重叠；**150% 程序化不可达**（注册表+广播+进程重启均不生效，缺陷 D3 如实登记），未用浏览器缩放冒充；终态恢复与原值逐项一致 |
| 性能采样（生产构建实测） | 首屏导航→可交互 P50 230ms / P90 303ms；路由切换 P50 62–73ms（全 <100ms）；Delegate 反馈 12ms；CANCEL 收敛 18ms；Ctrl+K 打开 10ms / 输入→结果 314ms（含 250ms 前端防抖）。**决定：不需要性能修复**；弱网/远程形态风险信号与可选优化记录于 perf 证据 |
| Rust 单测（MSVC target） | **27/27 通过**、0 warning（新增 5 例：重启策略、日志轮转、时间戳、事件落盘、"重启恢复不杀活动 API Job"门控） |
| 桌面包重打包 | EXE SHA-256 `5FA62913…576354`，manifest SHA-256 `6D1AF179…4831C`，built_at_utc 2026-09-29T01:40:12Z；verify-desktop-package **17169 资源哈希通过** |
| 重启配置保留（A02 补测） | Start#1 → 白名单内探针键 → 正常关窗 → Stop → Start#2 键仍在 → 移除，**通过**（未知键会被宿主白名单拒绝属安全不变量，故用白名单键做探针） |

### 6.2 本轮发现并修复的缺陷

| 缺陷 | 级别 | 修复 | 验证 |
|---|---|---|---|
| **VERIFY 语义检查自死锁**：结果事务持有 runs 行锁（run-steps.ts:479 + run-repository.ts:132）→ 事务内 `verifyRun` → `recordModelInvocation` → `ModelCallRepository.begin()` 另开连接对同一 runs 行二次 `for update`（`identity.budget` 存在时）；Mock 路径因 Fake 检查器无 budget 从未暴露；Run 永久卡 VERIFYING | P1（真实模型路径阻断） | 对齐 DRAFT 模式：`prepareSemanticChecks` 把语义检查的模型调用+记账移到结果事务之外，结果事务内 `verifyRun` 消费预计算结果；取消经 AbortSignal + 持久化控制意图（纯 abort 不产生 CANCELLED，符合"控制意图必须持久化"）；ERROR ≠ FAIL ≠ PASS 语义不变 | 真实外呼 4/4 转绿；真实 PG 取消反例 2 例纳入正式回归（在途 CANCEL→账本 COMPLETED、abort+CANCEL→账本 CANCELLED 非 STARTED）；Fake 定向 104/0；单元 136/136。证据 `verify-deadlock-fix.log`、`real-model-semantics-after-fix.log` |
| **D1**：worker 单次非零退出 → supervisor 抛错退出 → `desktop_bootstrap` 永久失败，桌面重载即"本机服务不可用" | 高（桌面阻断级） | 宿主有界重启（连续 3 次预算 + 指数退避 2s/4s/8s + supervisor 稳定 300s 后预算重置）；bootstrap 只在 API 停止时报错；重启恢复只终止 supervisor/worker 树、保留活动 API Job（门控单测） | 真实复现 worker exit=1 → 宿主 2s 退避重启 → 3s 内恢复派发；崩溃后两次独立 bootstrap OK；claim 真实收敛、60s+ 无假活派发。证据 `desktop-fix.log`、`d1-regression.log` |
| **D2**：supervisor/worker stderr 被 `Stdio::null` 丢弃，崩溃不可观测 | 中 | stderr 改轮转日志 `<data-root>/logs/worker-supervisor.log`（8MiB 轮转保留一代），协议事件 + 退出码 + 重启诊断带 UTC 时间戳落盘；密钥扫描 0 命中 | 崩溃复现日志含 worker_exit code=1 与 supervisor stderr 原文 |

33 矩阵中 UI-19（已暂停）经桌面安全点协调路径真实应用 PAUSE 后补取证 pass；UI-20（UNKNOWN 恢复核对）、UI-22（动作批准）维持 unverified（分别需 debug helper 强杀场景与 Git 能力触发，不造假状态）。

### 6.3 A01–A11 状态刷新

| 原项 | 5.2 时状态 | 本轮状态 |
|---|---|---|
| A01 模型闭环 | 离线闭环已关闭；真实外呼阻塞 | **关闭（本轮授权 Provider 范围内）**：连接验证、真实 DRAFT 链路、真实语义检查（修复后）均为真实外呼通过；「连接验证通过」与「真实任务执行成功」分别取证、未互相冒充。Worker 可执行性探测仍为只读建议（方案 A/B 见 `model-task-chain.log`），不阻塞 A01 |
| A02 桌面配置 | 部分通过 | **关闭**：重启保留链路补测通过；安装/升级/卸载仍属 M07 范围 |
| A05 逐页布局 | 部分关闭 | **大部分关闭**：33 状态矩阵完成登记（31/2/0）；125% DPI 真实取证通过；150% 程序化不可达登记为 D3，需系统设置人工切换后取证 |
| A07 性能 | 未关闭 | **关闭**：实测分位数全优（6.1），决定不实施重构；保留弱网形态风险信号与可选优化（路由拆包、防抖 250ms→120–150ms）于 perf 证据 |
| A08 总交付与事实源 | 部分关闭 | 本节 + CODEX_NEXT_STEP 同步后**关闭** |
| A03/A04/A06/A09/A10/A11 | 保持 5.2 结论 | A09/A10/A11 本轮全量对应场景继续通过；A04 Pack 折叠等维持；A06 通知文案维持已确认规则，连接真实探测边界维持不扩 |

### 6.4 剩余阻塞与边界

1. **150% DPI 真实取证**：程序化不可达（D3）；解除条件 = 系统设置 UI 人工切换 150% 后按同法取证并恢复原值。
2. **UI-20 / UI-22**：需 debug helper 强杀场景 / Git 能力触发；解除条件 = 专用故障注入环境（M06 既有 debug 助手链路）。
3. **worker 自然崩溃根因**：exit=1（claim 后无 step 输出）根因未定位——worker catch 只写 `worker_failed`，apps/api 侧 supervisor 未透传 worker stderr（本轮授权范围外）；宿主自愈已兜底，解除条件 = apps/api 侧补 stderr 透传后按日志定位。
4. **M07 安装/升级/卸载**：未启动，属 M07 出口。
5. 真实外呼结论绑定当前 `.env` 的 agnes-3.0-flash 与本轮固定短文本/小任务；流式、长输出、多轮、精确计量未全测，不外推到其他 Provider 或形态。
6. **实现与验收边界声明**：真实模型（连接验证 + DRAFT + 语义检查，本轮授权 Provider）、浏览器 33 状态矩阵、125% DPI、性能分位数、桌面包（新 EXE）均已由真实运行验证；"真实环境验收未完成"仅剩 6.4.1–6.4.4。

证据目录：`docs/testing/evidence/final-2026-09-29/`（model-verify-live、model-task-chain、verify-deadlock-fix、real-model-semantics-after-fix、desktop-fix、restart-persist、d1-regression、regression、perf/）与 `docs/testing/evidence/ui-dpi-2026-09-29/`（33 矩阵登记、DPI 原值/截图/恢复验证、defects json 含 D1/D2 修复状态）。

### 6.5 用户报告"打不开"排查（2026-09-29 中午）

用户启动 test-release 桌面包报"打不开"。排查证据：`worker-supervisor.log`、`postgres.log`、进程/窗口实测（`.tmp-openfix` 截图）。

1. **用户启动记录正常**：09:41 / 09:45 两次 Start 的 PG、迁移、升级备份、supervisor 全部正常就绪；09:41 会话在启动后 2 分 15 秒被关闭（fast shutdown），09:45 为重试。
2. **主因——启动链慢且无窗口反馈**：Start 全链（包完整性校验 60s+ → PG → 迁移检查 → 升级备份 pg_dump → 宿主 → 窗口）需 1–3 分钟，期间无任何窗口出现；用户在等待期放弃并重试，体感即"打不开"。
3. **偶发因素——窗口最小化**：11:03 复现启动后窗口处于最小化态（IsIconic=1、rect -25600 屏幕外 159×27），SW_RESTORE 后窗口与 UI 完全正常（Workflow OS 侧栏与真实项目列表渲染正常，截图验证）。该现象累计 3 个会话观测到（取证 B 曾靠 ShowWindow(9) 恢复后截图），但受控重启复现未命中（第二次启动窗口正常）；窗口创建代码（`visible(false)`→`show()`、无位置持久化）与 frame_guard 均无最小化逻辑，触发者未定位，登记为观察项。
4. **worker 崩溃史与可观测性修复**：01:46 会话 worker 启动 1.5s 后 exit=1（领取取证残留 Run `6e5f6ffb` 后无 step 输出；该 Run 现已 PAUSED，不再触发）。worker catch 原本只输出 `worker_failed` 吞掉错误栈——已修复：`apps/api/src/worker/main.ts` catch 现输出完整 stack（本轮最小可观测性修复，已进 dist；**桌面包内仍为旧 worker，重打包待窗口关闭后进行**）。
5. **交付时点实例状态**：宿主/PG/API/窗口全部正常，UI 渲染正常，worker 待命，应用可用。

处置与遗留：
- 用户侧即时可用；再遇"点了没反应"先等 1–3 分钟（包校验+迁移+备份为启动链固定成本）。
- **取证残留孤儿 Run**：`8d19e398`（「UI取证-20260929 项目A / 委托任务T6-1」）卡 RUNNING + 孤儿 ACTIVE claim（epoch 3），每轮启动记录 `worker_recovery_required` 但恢复链对无 launch 记录的旧孤儿无收敛路径（`retainedClaims=0`）。它不阻塞新委托，但会持续显示"运行中"并阻挡该项目归档。建议经 UI 取消该任务运行；登记为"恢复协议对无 launch 记录孤儿 claim 的收敛缺口"（结构性，apps/api 侧，待后续授权）。
- worker 崩溃根因定位依赖下一次打包 worker 崩溃时的 stderr 栈（本轮已具备输出能力）。

## 7. 项目列表页头试点与协作事实条修复（2026-10-02）

范围：`/projects` 的 fixture 与 live 两个视图改用 `PageHeader` 原语，页头标题降到 `font.size.compactPage`、目标句降到 `font.size.meta`，范围切换与搜索收进一行紧凑工具栏。仅重组展示，**未改** API、数据库、路由、`data-testid` 与业务文案；§17.8 其余七类页型未动。同轮修复 `collaborationWorkspace.spec.ts` 的 5 例既有失败。

| 检查 | 结果 |
|---|---|
| Workbench 类型检查 | 通过 |
| 项目相关定向测试（projects / projectsTitleRefresh / projectArchiveLive / liveWorkspaceLists / createProjectOnboarding / projectOverview / projectTasks） | 7 文件 **38/38 通过** |
| Workbench 全量组件测试 | 78 文件 **593/593 通过** |
| `collaborationWorkspace.spec.ts` 稳定性 | 连续 4 次 64/64 通过 |
| 浏览器目视（Chromium，示例数据） | 1721×914 与 1280×720 两视口页头收紧，无溢出、无遮挡，范围切换与搜索同排可达 |

同轮修掉 `collaborationWorkspace.spec.ts` 的 5 例既有失败，根因都是实现按 §17.7 演进后测试与断言未跟上，不是新引入的缺陷：

1. **3 例**（暂停请求中 / 执行失败 + 外部 UNKNOWN / Run 失败原因）断言 `collab-facts`，而 `CollaborationView.tsx` 在 `runNeedsAttention` 时只把 Run 控制提到页头、事实条被整个丢掉。这违反[设计系统 §9.2](../frontend/design-system.md#92-共享页级原语2026-10-01)「折叠不是隐藏」——UNKNOWN 与无法确认的执行结果不能只剩展开后可见。已改为三类状态出现时事实条与 Run 控制一起常驻页头（同一分支内，不新增 testid）。
2. **1 例**（live 首次进入空工作区）断言旧空态文案「这次想推进什么」。§18.1 已把默认入口改为打开文件夹，实现与文案随之更新，断言改为新文案。
3. **1 例**（正文失败）断言内容只读一次却读到两次。该例在上述修复后连续 4 次通过，未复现；`ArtifactReaderPanel` 的自动展开 effect 依赖 `[client, loading, active 版本 id]`，`client` 身份或 `loading` 抖动都可能触发第二次读取，本次未定位到稳定触发路径，**登记为待观察项，不视为已修**。

未验证：真实 Windows 窗口与 DPI、中文输入法、live 模式浏览器渲染、屏幕阅读器与对比度实测，以及 hover／焦点／冲突／权限拒绝等异常分支。本轮不因此改写 6.4 的剩余阻塞，也不覆盖既有各项结论。

同轮还按 §17.8 收敛了 `/agent` 协作页的任务头：h1 落 `font.size.compactPage`、单行省略、状态芯片不换行，`PageHeader` 标题统一带 `title`，项目归属并入 `collab-current-need`（见[工作台 §17.10](../frontend/workbench-design.md#1710-聊天页任务头接续选定稿2026-10-02)）。

| 检查 | 结果 |
|---|---|
| Workbench 类型检查 | 通过 |
| Workbench 全量组件测试 | 78 文件 **593/593 通过** |
| `ui-align-visual.spec.ts`（仓库自带取样） | 2/2 通过；1487×1058 / 1280×720 / 960×640 / 390×844 四视口 `scrollW == viewportW`，无横向溢出 |
| 长任务名回归（临时脚本，复用夹具只改标题长度） | h1 = 28px，宽 684px，状态芯片同行；`collab-goal` 高 **105px，与短标题一致**；`title` 属性等于完整任务名；`scrollW 1487 = viewportW` |

取样输出留在本机 `output/acceptance-raw/ui-align-20261001/`，未纳入版本库。

按用户裁定，委托执行同步按选定稿收进「更多操作」，准入判定抽成 `delegateBlockedReasonFor` 单一来源，禁用原因留在页头常驻（见[工作台 §17.11](../frontend/workbench-design.md#1711-委托执行按选定稿收进更多操作2026-10-02)）：

| 检查 | 结果 |
|---|---|
| 委托相关回归（delegate-task / commandPalette / collaborationWorkspace / taskDetail / projectWorkbench） | 5 文件 **123/123 通过** |
| 类型检查 | 通过 |
| 浏览器：可委托（READY + 人工 + START） | 「更多操作」内委托可展开，页头无禁用原因，`collab-goal` 105px |
| 浏览器：不可委托（已取消） | 「更多操作」内显示「当前不可用」；页头首屏常驻「只有 READY 的任务可委托。」，`collab-goal` 138px |
| 两种状态下展开「更多操作」 | 页头高度不变（105 / 138），符合展开不推高上下文 |

**全量套件的负载相关偶发红：已定位三处，均为测试自身设计问题，非本轮产品改动引入。**

1. **已修：`tasks.spec.ts`「筛选刷新保留已知内容并标识更新」。** 原因是用例设 `setFixtureLatency(60)` 后用 `await flush(10)` 断言"刷新中"，拿真实 `setTimeout` 与 60ms 夹具延迟赛跑；机器繁忙时 10ms 窗口会错过刷新态。改为在筛选变更后不推进任何定时器直接断言（与同文件「提交中动词」用例的既有写法一致），并在 `afterEach` 复位 `setFixtureLatency`（此前未复位，会漏给同文件后续用例）。修后 4 次单跑 + 3 次全量均未再出现。
2. **未修：`run-events.spec.ts`「断线以已消费 seq 补历史」。** `expect(runReads - beforeBurst).toBeLessThanOrEqual(2)` 偶发得到 3。用例连发 10 个事件、每次 `flush(10)`，共约 100ms 真实时间；若生产侧去抖窗口更短或机器繁忙，就会多触发一次重读。断言本身是对的（要证明的是合并生效），但当前写法把去抖窗口和测试调度绑在一起。
3. **未修：`collaborationWorkspace.spec.ts` 的级联红。** 一次全量里该文件 **32/64 失败**，首个失败是 `Test timed out in 5000ms`，超时中断后清理未执行，后续用例继承坏状态，于是报出一堆"DOM selector not found"这类**假象**。`vitest.config.ts` 未设 `testTimeout`，走默认 5000ms；该文件单例就含 `flush(260)`、`flush(1_100)` 等大量真实等待，8 worker 并发下 5s 并不宽裕。

第 2、3 项的修法都要动别人的测试写法或全局测试配置（`testTimeout`、去抖断言的场景），超出本轮范围，未擅自改。**结论：当前不能把「全量一次绿」当稳定证据**，需单文件复跑或多次全量采样；上述三处修完后应重新采样确认。

## 8. 文件夹入口与对话直接执行（2026-10-02，开发自检）

范围：`prompts/folder-first-conversation.md` 的 A、B 两片（FC-01–FC-05、FC-08、FC-11 的服务端与组件部分）。**FC-06、FC-07、FC-09、FC-10 未验证。** 本节只记录本轮实际运行到的范围，不含独立复核、真实 Windows 与安装结果。

| 检查 | 结果 | 范围与基准 |
|---|---|---|
| 真实 PG 迁移 `0051_conversation_execution_requests` | 通过 | `migration.integration.test.ts` 9/9；迁移在临时 PostgreSQL 18.6 上从零应用、并发只应用一次、失败回滚 DDL 与账本。`0050_n02_impact_candidate_groups` 是并行 Agent 的同号 migration，未改动。 |
| 目录身份、复用、重放与歧义（真实 PG） | 通过 | `folder-first-conversation.integration.test.ts` 第 1–4 例：首次建立最小 Project + 受管资源、再次打开复用同一 `project_id`/`resource_id`、目录被删除后按原 `command_id` 重放、大小写别名不产生第二个写 Owner、嵌套根要求显式选定作用域、无效目录 422、多项目返回 `AMBIGUOUS` 并可显式选择。 |
| 对话执行链（真实 PG） | 通过 | 同文件第 5 例：`DISCUSS` 不创建 Task；`PREPARE` 候选先落库，同一原消息再提交不产生第二条请求也不重付模型成本；缺 `FILE_WRITE` 连接时 409 并给出具体原因；补齐连接与权限后建立真实 Task 并 Delegate 出带 `file-write-v1` + `cli-run-v1` 冻结意图的 Run；重复 Apply 返回同一 `task_id`/`run_id`。 |
| 真实受控文件修改与检查命令（真实 PG + 真实磁盘 + 真实子进程） | 通过 | 同文件第 5 例后半：未批准前 `answer.txt` 内容保持 `before`；`ACTION_APPROVAL` 批准后先落盘为 `after`；再经独立一次审批执行 `CLI_RUN`，`logical_operations.result_ref.outcome = SUCCEEDED`。两次批准都不产生外部副作用（`external_effect_executed = false`）。 |
| 候选与冻结动作的确定性规则（单元） | 通过 | `conversation-execution.test.ts` 6/6：不可判断的验收条件、目录外/绝对路径/超量变更、非受支持输出、解析失败与非法字段都退回聚焦澄清；Fake 标记不得与真实写入并存；冻结检查命令必须是可执行文件加参数数组。 |
| API 单元回归 | 通过 | `apps/api` 单元 320/320。需先设置 `RELAY_FILE_IO_HELPER`（原生文件 I/O helper），否则 `managed-content-*` 相关 8 例因环境缺失失败，与本功能无关。 |
| 关键真实 PG 套件回归 | 通过 | 逐个独立运行 `run-graph`、`run-steps`、`run-dispatch`、`api-delegations`、`gateway`、`real-tools-gateway`、`collaboration-controls`、`recovery`、`verification`、`assist`、`migration`、`folder-first-conversation` 均 `status: PASSED`。**全量 57 个集成套件未在一次运行内跑完**（进程被工具超时中止，临时集群已用 `pg_ctl` 干净关闭并删除）。 |
| 组件回归 | 通过 | `apps/workbench` 78 文件 593/593，含新增 `folderFirstConversation.spec.ts` 4/4。中途曾出现 5 例 `collaborationWorkspace.spec.ts` 失败（断言 `collab-facts` 在 Run 需要注意时仍可见），**已在本轮开始前于 HEAD 复现**（把 `CollaborationView.tsx`/`AssistView.tsx` 还原到 HEAD 后同样失败），属 §17.7 折叠事实条与既有断言不一致，本轮未修复；最终全绿是并行 Agent 随后修好该断言后的状态，本功能本身未触碰那条断言。 |
| 类型检查与构建 | 通过 | `apps/api` 与 `apps/workbench` 的 `tsc --noEmit` exit 0；`apps/workbench` `vite build` 通过。 |
| Tauri 宿主 | 编译通过，未运行 | `apps/desktop/src-tauri` 新增 `tauri-plugin-dialog 2.7.2` 与 `select_working_directory` 命令，`cargo check --locked --target x86_64-pc-windows-msvc` 通过。**没有重建桌面包，没有打开原生目录选择器，取消/重启/IME/DPI 完全未验。** |
| 真实 Provider | 未使用 | 本轮只用受控 Fake 模型端口解释候选；`.env` 的真实 Provider 配置未被读取或修改，也没有任何真实项目材料外发。 |

**已知限制（不构成通过）**

1. 目录登记命令 `OpenWorkingDirectory` 在会话未绑定 Project 时不能建立关联，因此「无目录普通讨论、需要项目资源时再补作用域」只在组件层保留输入，未实现同页补作用域后的续发。
2. 一次执行请求的 `expected_outputs.kind` 目前只支持 `MARKDOWN_DOCUMENT`（与固定工作流一致）；需要其他产物种类时退回聚焦澄清。
3. 会话内多任务的完整恢复矩阵（FC-06/07/09）与真实 Windows 取证（FC-10）未验证。
4. 工作区外仍暂留一个被占用的临时目录 `C:\Users\ASUS\AppData\Local\Temp\relay-api-integration-bc01ec50f6`（被中止的那次全量运行的 `server.log`）。本轮独占的临时集群已 `pg_ctl stop` 并删除；未对该目录继续强删。
5. `apps/workbench` 的 `views/*.css`、`styles.css`、`ArtifactImpactCheckPanel.tsx`、`ArtifactReaderPanel.tsx` 与 `docs/frontend/design-tokens.json` 的未提交修改来自并行 Agent，本轮未触碰、未回退，也未纳入本节结论。

**用户参与事项**

- 需要重建并运行桌面包，手工验证原生目录选择与取消、重开同一目录、关窗重启后的会话恢复、中文 IME 组合输入与 125%/150% DPI 下的入口可达性。本轮无法在工具内打开原生窗口，给不出这些证据。
- 需要一次人工复核：候选就绪时的「按这个执行」是否构成可接受的额外一步（当前实现保留这一步以免展示摘要变成隐式授权）。
## 9. 方案 2 全站生产接入（2026-10-02）

范围：按 [ui-option-2-pages 提示词](../../prompts/ui-option-2-pages.md) 改造现有 React 工作台——共享壳栏位分离、聊天区页头收敛、三类页型样板，然后推广到 37 个页面/状态单元与选定聊天页。交互归[工作台 §17.12](../frontend/workbench-design.md#1712-方案-2-全站生产接入2026-10-02)，组件与布局归[设计系统 §9.3.1](../frontend/design-system.md#931-方案-2-生产接入2026-10-02)，新增数值只有 `layout.navigation.railWidth`。**未改**路由、查询语义、`data-testid`、命令 Owner、HTTP 契约、数据库、权限与模型策略；**Breaking Change：No**。

| 检查 | 环境与基准 | 结果 |
|---|---|---|
| `npm run typecheck` | 当前工作区未提交源码 | 本轮改动全部通过；**收尾时共享工作区出现 2 个并行 Agent 的类型错误**，均在 `tests/connectionsSettings.spec.ts:248`（其进行中的 CLI_RUN/FAKE 新增用例），不属本轮文件 |
| `npm run build` | 同上（`tsc --noEmit && vite build`） | 本轮改动状态下通过；产物 CSS 210.64 kB / JS 1320.31 kB（gzip 25.85 / 360.65 kB）。收尾时因上述并行类型错误无法复跑 |
| `npm test` | 78 文件 | 本轮完成时 **595/595 通过**（基线 593；本轮新增 3 条断言、更新 4 处选择器）。收尾复跑为 596/597，1 例为 `run-events` 已知计时偶发（单独运行通过），另 2 例为并行 Agent 同期新增 |
| `npm run test:browser` | Chromium headless，1487×1058 / 1280×720，视口 4173 | 18 通过 / **6 失败**，6 例全部为既有失败，逐条归属见下 |
| `npx playwright test --config scripts/playwright.ui-align.config.ts` | 只读夹具 + 页面内拦截，不连数据库、不调 Provider | 3/3 通过 |

### 9.1 浏览器套件的 6 例失败（均为既有，非本轮引入）

本轮在当前产物上逐条取证，未修改任何断言来消除它们：

| 失败用例 | 归属与依据 |
|---|---|
| `真实 Run 与 Bearer SSE 提示触发权威快照` ×1 次 | **环境**：本机 4173 被一个遗留 socket 占住通配地址（Foxmail PID 9332 → 本地代理 7897），仓库 `webServer` 命令不带 `--strictPort`，Vite 回退到 4174 导致 Playwright 的 URL 探活失败。手工用 `--strictPort` 起在同一端口后该例通过，未改代码与配置 |
| `R02：创建页草稿会拦截侧栏和浏览器返回` | **既有偶发**：同代码连跑 3 次为 1 通过 / 2 失败，失败点在 `page.goBack()` 后草稿守卫对话框未出现。定位到浏览器历史与草稿守卫的时序，未在本轮深挖 |
| `浏览器预览不显示桌面窗口控制` ×1 | **既有断言与文档冲突**：`App.tsx:119` 无条件渲染 `DesktopTitleBar`，只有窗口控制受 Tauri 门控。这正是[工作台 §17.4](../frontend/workbench-design.md#174-当前实现与恢复边界)「浏览器显示业务入口，窗口控制仅由桌面宿主提供」的行为，且 `desktop-titlebar.spec.ts` 断言与之相符。该浏览器断言是过时的一条，本轮不为了让测试变绿而删掉浏览器的前进/后退/搜索/新建 |
| `键盘可达：辅助链接…` ×2、`桌面标题栏偏移下的辅助链接不遮挡窗口控制` ×1 | **既有缺陷**：`App.tsx` 中 `DesktopTitleBar` 排在 `AppShell`（跳到主要内容链接的宿主）之前，Tab 第一站落在标题栏搜索键而不是跳转链接。取证输出显示按 Tab 后 `document.activeElement` 为 `desktop-titlebar__search`。修复要同时处理视觉顺序与 Tab 顺序，属独立一轮，未在本轮夹带 |
| `项目摘要突出当前对象与状态` ×1 | **既有断言与实现不一致**：`ResponsiveRail` 的 `title` 只用作 `aria-label` 与抽屉标题，`.rail-content > h2` 来自 `ProjectsView` 自己的 `<h2 className="rail-heading">项目摘要</h2>`，测试期望的是所选项目名。未在本轮改动右栏结构 |

### 9.2 本轮实际验证到的内容

- **共享壳两列**：1487×1058 与 1280×720 实测图标导航栏 88px、近期工作栏 224px、主体填满余量；拖拽分隔条中心落在两列边界 ±14px 内；深链恢复的选中项正确；四个视口 `scrollW == viewportW`，无横向溢出。
- **键盘路径**：Tab 可聚焦聊天页头标题链接，`Enter` 落到 `/tasks/33333333-…`（实测），完整任务名不再只靠悬停。
- **窄窗收纳**：960×640 下两列 `display: none`，导航与近期工作改由抽屉承担（完整导航 10 项、近期工作 12 项可达）。
- **聊天区空间**：页头 1487×1058 与 1280×720 均为 **77px**（接入前 105px），与任务名长短无关；1280×720 聊天记录 340px、成果阅读区 416px，均在[工作台 §17.6](../frontend/workbench-design.md#176-连续协作工作区2026-10-01)的 240px 下限之上；390×844 走既有单区模式。
- **标题层级**：八个普通路由 1280px 主标题一律 40px（`/projects` 按既定紧凑值 28px），390px 一律 28px。过程中发现 `PageHeader` 原语此前没有声明标题字号、`h1` 落回浏览器默认 2em，已补为 `font.size.page`，并把窄窗回落规则扩展到该原语。
- **页签与焦点**：既有 `navigation`、`recentWorkPagination`、`sidebarResize`、`workBreadcrumbScope`、`collaborationWorkspace`、`collaborationLayoutPreferences`、`folderFirstConversation`、`delegate-task`、`draftGuardCoexistence`、`knowledgeReading`、`reviews` 等定向测试全部未改断言通过。

### 9.3 本轮未做（出口保持未验收）

1. **真实业务写入**：未在隔离真实 API/PG 上核验受影响页面的创建、编辑、判断与控制路径回执。浏览器证据只证明夹具与只读分支行为。
2. **真实 Provider**：未调用，未外发任何项目材料。
3. **Windows 窗口**：未重建桌面包，未验证原生目录选择、标题栏、100%/目标 DPI 与独立内容缩放、真实中文 IME、窄/短窗、关闭重开恢复。本轮工具不能打开原生窗口。
4. **安装/升级/卸载**：未做。
5. **完整 37 项的独立业务验收**：本轮完成的是布局与交互出口的接入与自动化/浏览器观察，不等于逐页业务验收通过。
6. **性能与可访问性实测**：未做屏幕阅读器与对比度实测；未做长列表大数据量游标性能观察。
7. **共享工作区并行改动**：本轮收尾时并行 Agent 正在改 `tests/connectionsSettings.spec.ts`，该文件带入 2 个类型错误，使 `npm run typecheck` 与 `npm run build` 在最终树上不再 exit0。本轮未触碰、未回退该文件；上文「本轮改动状态下通过」指本轮自身文件全部干净。

取样输出留在本机 `output/acceptance-raw/ui-align-20261001/`（含 `ui-align-shell.json` 与各视口截图），未纳入版本库。

## 10. 方案 2 接续验收与整改（2026-10-03）

范围：对 2026-10-02 已实施的本轮改造做接续验收。交互归[工作台 §17.12](../frontend/workbench-design.md#1712-方案-2-全站生产接入2026-10-02)，组件与布局归[设计系统 §9.3.1](../frontend/design-system.md#931-方案-2-生产接入2026-10-02)。本节只登记本轮**接续**的结果；未改路由、命令 Owner、草稿、版本、审批、恢复与 root-bound 能力配置，**Breaking Change：No**。上一轮 §9 的 6 例浏览器失败在本轮全部处理完毕。

### 10.1 整改（先验证，存在差异才改）

| # | 差异 | 判定与处置 |
|---|---|---|
| 1 | `tests/browser/real-api.spec.ts` 仍用 `.app-sidebar` 找主导航 | **实现改动打断的断链**：共享壳拆成两列后该选择器不存在，真实 API 验收在第 40 行就停住。改为 `.app-navrail` |
| 2 | `tests/browser/workbench.spec.ts` 窄窗断言 `.app-sidebar` 隐藏 | 元素不存在时 `toBeHidden()` 空过，断言失去意义。改为分别断言 `.app-navrail` 与 `.app-context-rail` 都收起 |
| 3 | `scripts/ui-polish-verify.mjs` 采集 `.eyebrow` 槽位 | 普通页头改用共享原语后 `/today` 已无该元素，指标恒为 null。改为 `.page-head-meta, .eyebrow` |
| 4 | 跳转链接不是第一个 Tab 站位 | **真实缺陷**：`App.tsx` 把 `DesktopTitleBar` 排在 `AppShell` 之前，Tab 第一站落在标题栏搜索键（取证：`document.activeElement` 为 `desktop-titlebar__search`），违反 WCAG 2.4.1。跳转链接是 `position: fixed`，改由窗口框架 `App.tsx` 持有并置于标题栏之前，视觉位置不变、Tab 顺序正确 |
| 5 | 断言「浏览器不显示整条标题栏」 | **断言与[工作台 §17.4](../frontend/workbench-design.md#174-当前实现与恢复边界)冲突**：该节规定浏览器显示前进/后退/搜索/新建，只有窗口控制由桌面宿主提供；`desktop-titlebar.spec.ts` 亦与之一致。断言改为验证没有窗口控制（`desktop-titlebar__controls`、关闭/最小化按钮均不存在），实质检查保留 |
| 6 | 断言项目摘要栏 `h2` 是项目名 | **断言早于 §17.9**：该节规定项目列表试点保留右栏结构不变，分区标题是「项目摘要」，当前对象由 `.rail-project-name` 承担。断言改为分别校验分区标题与对象名，并补 `.rail-intro` 非空，覆盖不减 |
| 7 | `run-real-api-browser.ps1` 从不设 `RELAY_FILE_IO_HELPER`、也不构建 API | **验收脚本缺口**：产物正文要经原生文件 I/O 发布到受管存储，缺该助手时每次保存都如实失败为「内容未能完整发布到受管存储」，真实写入路径根本没被走到。脚本补 cargo 构建 + 环境变量 + 每次用当前源码构建 API |
| 8 | 真实 API 用例在两处依赖默认展开的折叠区 | 「按已知 Project ID 打开」「版本详情与接受选择」「编辑页签」都是默认收起的次级入口。改为显式展开/切换，并顺带证明这些折叠入口在真实 API 下可达 |

### 10.2 实现与自检

| 检查 | 环境与基准 | 结果 |
|---|---|---|
| `npm run typecheck` / `npm run build` | `apps/workbench` 当前未提交源码 | 通过 / 通过 |
| `npm test` | 79 文件 | **606/607 通过**；1 例 `run-events.spec.ts` 为既有计时偶发（单独运行 5/5 通过） |
| `npm run test:browser` | Chromium headless，4173 端口 | **24/24 通过**（上一轮 18 通过 / 6 失败） |
| `npx playwright test --config scripts/playwright.ui-align.config.ts` | 只读夹具 + 页面内拦截 | 3/3 通过 |
| `npm run test`（`apps/api`） | 需 `RELAY_FILE_IO_HELPER` 指向 release 助手 | 325 例中 **321 通过 / 4 失败**；4 例全在 `test/unit/backup-package.test.ts`（M07 备份还原注册表导出，`BACKUP_PACKAGE_INVALID`），与本轮 UI 及真实 API 脚本无关，本轮未触碰该路径 |

### 10.3 独立验收：真实 API / PostgreSQL（已通过）

用仓库既有隔离入口 `apps/workbench/scripts/run-real-api-browser.ps1`：一次性 PostgreSQL 18.6 集群（动态回环端口、随机库名、`relay_migrator`/`relay_app` 真实角色）、53 条业务迁移 + 官方 Saver 图安装、工作空间初始化、真实 API、真实 Vite、真实浏览器；**不读 `.env`、不接用户库、临时目录校验后删除**。

覆盖的人工闭环：创建项目 → 创建任务 → 启动任务 → 打开任务详情 → 保存产物 v1 → 刷新 → 保存 v2 → 经 API 直读核对 `version_count=2` 且 `current_accepted_version_ids=[]` → 选用确切版本 → 勾选验收条件完成 → 核对「本轮接受」与「当前选用」两个指针分离 → 重开 → 核对接受被清除。

结果：**通过**（`playwright=0 pg_stop=0 temporary_removed=True`）。取样未新增文件，全部输出随脚本临时目录一并清除。

### 10.4 独立验收：Windows 桌面（部分通过，窗口观察出口仍未验收）

| 检查 | 结果 |
|---|---|
| `apps/desktop/scripts/build-release.ps1` | **通过**（465s，exit 0）。新包 SHA256 `3ca3cc62…`，17227 个资源文件参与哈希，0 个禁用配置文件，维护能力仅做无效参数探测 |
| `node scripts/verify-desktop-package.mjs apps/desktop/release` | **通过**：`Package hashes verified.` |
| 包与当前源码绑定 | 清单记录的 `AppShell.tsx` / `PageHeader.tsx` / `styles.css` 源哈希取自本轮改造后的源码；清单 `artifact_sha256` 与磁盘 exe 实际 SHA 一致 |
| 上一版包的完整性 | **发现不一致**：旧 `target/release/relay-desktop.exe`（2026-09-30）清单记录 `artifact_sha256=2ad7751a…`，磁盘实际为 `da6a9881…`，且清单源哈希早于本轮全部 UI 改造。该包已不能作为任何本轮结论的依据 |
| 真实窗口事实（`start-acceptance-session.ps1 -InstallGraph -UseCLocale` 一次性会话） | **窗口真实创建**：进程 `relay-desktop`，顶层窗口标题 `Relay Agent`，窗口类 `Tauri Window`，`IsWindowVisible=True`，窗口属主 PID 与进程一致，尺寸 1174×788，**窗口 DPI 120（125% 缩放）**；会话记录绑定新包 SHA。窗口经 WM_CLOSE 正常关闭，会话 `postgres_stop_exit=0 temporary_root_removed=True` |
| 桌面静态/守卫/菜单脚本 | `test-desktop-package.test.mjs` 3 通过 1 跳过、`diagnose-desktop.test.mjs` 2 通过、`test-desktop-dev-guard.test.ps1` PASS 6 场景、`test-desktop-menu.test.ps1` PASS 3 场景 |

**未验收（必须人工参与）**

1. **窗口内实际渲染**：截图/目视一致性、暖白与森林绿观感、导航与近期工作比例观感。
2. **原生目录选择**：打开文件夹对话框、取消、重开同一目录。
3. **真实中文 IME**：组合输入期间 Enter/Escape 不误触；浏览器合成的 composition 事件不能替代。
4. **DPI 对比与独立内容缩放**：只取到 125% 单点，100% 与 150% 未取，内容缩放与系统缩放的组合未验。
5. **关闭/重开恢复**：会话、目录与草稿在真实窗口生命周期下的恢复；`stop-acceptance-session.ps1` 按设计**要求先经真实 UI 关闭窗口**才清理集群，本次以 WM_CLOSE 代替，语义等价但非人工点击。
6. **安装/升级/卸载**：未做。

**发现的脚本缺陷**：`start-acceptance-session.ps1` 在窗口实际存活时仍报 `Release desktop exited during startup: 23`，并因此留下需要手工清理的孤立窗口与集群（本轮命中 2 次）。单实例退出码 23 的既有含义见 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)。本轮未修改该脚本，仅记录。

### 10.5 仍未通过的既有缺陷（未在本轮修复）

1. **浏览器返回不触发草稿守卫**：`/tasks?view=create` 填写草稿后按浏览器返回，导航会提交离开。插桩探针在 4188 端口下 4/4 次复现：URL 变为 `/tasks`、表单消失、4 秒内对话框始终为 0，草稿静默丢失；同一流程在 4173 下 5/5 通过。根因是 react-router `useBlocker` 无法可靠拦截浏览器已提交的 POP。`workbench.spec.ts` 的 R02 用例保留为真实闸门，本轮**未**放宽断言。
2. **`apps/api` 备份还原注册表 4 例失败**：`BACKUP_PACKAGE_INVALID`，属 M07 备份还原路径，本轮未触碰。
3. **`run-events.spec.ts` 计时偶发**：单独运行稳定通过，全量并行下偶发失败。

### 10.6 结论

- **已通过**：共享壳与聊天区、37 项页面/状态的接入回归、类型检查、生产构建、组件回归（606/607）、浏览器套件（24/24）、只读视觉与键盘取样、**真实 API/PG 人工闭环**、桌面包重建与完整性验证、真实窗口创建与 DPI 单点取样。
- **保持未验收**：Windows 窗口渲染观察、原生目录选择、真实中文 IME、DPI 多点对比与内容缩放、关闭重开恢复、安装/升级/卸载、完整 37 项的逐页人工业务验收、性能与屏幕阅读器实测。
- 结论绑定本节记录的文件基准；未把旧成绩、旧包或旧图升级为整体交付。
