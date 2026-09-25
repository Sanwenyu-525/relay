# 前后端独立验收记录（2026-09-21）

角色：独立验收证据与问题清单；不是开发自测记录，也不替代[当前阶段](../../CODEX_NEXT_STEP.md)。第 1–6 节保留 2026-09-21 P00–P03 与 9 个 fixture 页面修复前的事实，第 7 节为当日复验；2026-09-23 P05/P06 的接续验收见第 8 节，R05 修复后结论见第 9 节，不倒改历史证据。

## 1. 初始结论与边界（修复前）

**本轮不放行整体前后端验收。** 既有自动化检查全部通过，但补充验收发现后端当前完成投影错误、前端跨对象读写错误及创建流程问题。问题仍未修复。

| 对象 | 判定 | 原因 |
|---|---|---|
| 后端既有自动化基线 | 通过 | 类型检查、构建、28 项单测、69 项真实 PG 集成测试通过 |
| 后端 P03 业务验收 | 未通过 | BE-01 违反 A03；重开后旧完成仍进入当前 State |
| 前端既有自动化基线 | 通过 | 构建含类型检查、59 项组件测试、15 项浏览器测试通过 |
| 前端 9 页 fixture 行为验收 | 未通过 | FE-01 串对象写入；FE-02/03/04 创建流程不闭合 |
| 浏览器视觉 | 完成有限人工检查 | 检查本轮 9 张截图，抽样对照项目列表原图；视觉方向可保留，未做逐像素或全页面对比度测量 |
| 前后端联调 | 未具备验收条件 | 前端仅调用 fixtureAdapter，尚未连接真实 API |
| Windows 桌面与安装 | 未验收 | 生产 apps 中无桌面宿主与安装包；实验不能替代生产桌面验收 |

执行环境：Windows、项目便携 Node 24.21.0、PostgreSQL 18.6，前端 Chromium。仓库当前尚无 Git commit，源文件均为未跟踪工作区内容，不能给出 HEAD/commit 验收锚点。本记录绑定本日所列路径与复现行为；后续修改须重验，不能沿用结论。

## 2. 独立运行证据

| 检查 | 命令 / 工作目录 | 本轮结果 |
|---|---|---|
| API 类型检查 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`，apps/api | 退出 0 |
| API 构建与单测 | `npm run test`，apps/api（脚本先执行 tsc） | 28/28，无跳过 |
| API 真实集成 | `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -SkipBuild`，仓库根 | 69/69；临时 PG 正常停止，临时集群目录删除 |
| 前端构建与类型 | `npm run build`，apps/workbench | 退出 0；JS 233.58 kB / gzip 78.48 kB，CSS 36.43 kB / gzip 5.12 kB；不是性能验收 |
| 前端组件 | `npm run test`，apps/workbench | 8 个文件、59/59 |
| 前端浏览器 | `npm run test:browser`，apps/workbench | 15/15，既有 1487×1058、960×720、390×720 用例 |
| 页面截图 | `npm run screenshots`，apps/workbench | 9/9，1487×1058、DPR 1；[截图目录](../../apps/workbench/artifacts/screenshots/) |
| 补充 PG+HTTP 探针 | 复用现有 migration、真实应用角色、API 子进程和一次性集群包装器 | 原 69 项仍通过，新增 1 项验收断言失败，定位 BE-01；另观测 BE-02 |
| 手工浏览器操作 | `playwright-cli` 独立会话，Vite 127.0.0.1:4175 | 复现 FE-01/02/03/04；仅操作示例数据 |

Node 命令先把 `.research/runtime-cache/node-v24.21.0-win-x64` 加到当前进程 PATH，不改系统运行时。PG 使用随机临时库与 relay_migrator/relay_app 角色，不连接用户业务库。第二轮故意加入反例断言，结果是 **69 pass / 1 fail**，不是现有测试突然回归。两轮 PG 均已停止并删除临时集群。

补充探针与输出保留在本地忽略目录 `.research/acceptance-2026-09-21/`，包含 `backend-probe.test.js`、`backend-probe.log`、`browser-probe.cjs`、`browser-probe.log`。为执行而临时放入 API dist 的探针已移除，未改生产源文件或既有测试；下列步骤与观察值是可随文档追踪的复现依据。浏览器原始快照在 `.playwright-cli/`，不作为必须提交的产品资产。

## 3. 已确认问题

优先级：P1 阻断本阶段行为验收；P2 应修复的正确性或体验问题；“接入缺口”表示尚未实现，不能冒充此次回归。编号只用于本次验收，独立于 P00–P22 开发阶段。

### BE-01 · P1 · 重开后旧完成仍属于当前 Project State

- 依据：[事实契约](../../contracts/01-facts-and-ownership.md) `completed_highlight_refs` 与 A03：重开后不再算当前完成，历史保留。
- 位置：[project-repository.ts](../../apps/api/src/project/project-repository.ts) `listProjectStateCompletionRefs`（本轮第 375 行起）；[state-queries.ts](../../apps/api/src/application/state-queries.ts) `buildProjectState`。
- 复现：创建 GENERAL 项目与人工 Task（含必需人工项）→ ready → start → complete → GET State → reopen → 再 GET State。所有命令使用新 command_id 和上一步返回的 revision；完成无产物要求的任务使用空版本集合。
- 实测：Task 已 READY、acceptance_revision 进入新周期，但旧 completion_id 仍出现在 `completed_highlight_refs` 和 `dependency_versions.completion_refs`。观测片段：

```json
{"reopenedStatus":"READY","highlightsBefore":1,"highlightsAfter":1,"staleCompletionPresent":true,"stateRevisionBefore":"1","stateRevisionAfter":"1"}
```

- 根因：查询仅将 state_completion_refs 与 completion_records 关联，没有依据 Task 当前状态、验收周期与 current_completion_id 过滤；READY Task 也未进入现有投影的 tasks 依赖版本集合。
- 影响：界面与未来 Context 会把重开任务误报为当前已完成；不能以旧凭据仍存在来解释为正常历史展示。
- 修复边界：保留历史记录；修正当前投影及其失效依据。不要通过删除旧 CompletionRecord 或提高 Task 状态掩盖问题。

### BE-02 · P2 · SET_PHASE 接受未知阶段

- 依据：阶段属于 Project Type 的阶段词汇；当前源码明确记录尚未校验，这是已知挂账，本轮补充实测。
- 位置：[state-commands.ts](../../apps/api/src/application/state-commands.ts) 第 111 行 `SET_PHASE`；[project-phase.ts](../../apps/api/src/project/project-phase.ts)。
- 复现：对有效 GENERAL 项目提交合法 expected_revision、`action=SET_PHASE`、`phase_key=NOT_A_REAL_PHASE`。
- 实测：HTTP 200，随后查询返回 `phase_key=NOT_A_REAL_PHASE`。
- 建议：在当前内置类型范围内拒绝未知或类型不匹配的值，复用一份阶段定义；不为此建立动态注册平台。收紧旧行为的兼容影响应在修复时明确记录，历史异常数据不能静默改写。

### FE-01 · P1 · 对象路由变化后仍读取和写入固定示例对象

- 位置：[fixtureAdapter.ts](../../apps/workbench/src/fixtures/fixtureAdapter.ts) `loadProject` 第 294 行、`acceptTaskDefinition` 第 382 行；四项 Skill 页及默认 `/tasks/:id`、`/projects/:id` 入口。
- 复现：创建名为 `AUDIT-duplicate-task` 的任务→列表打开 `/tasks/task-demo-1`。
- 实测：面包屑是新任务，正文却是“确定实验评价指标”；点击“接受这份定义”后，返回任务列表，原示例 `task-evaluation-metrics` 从 v1 变成 v2，新建任务仍 v1。
- 根因：`loadProject` 除 empty 特例外忽略输入 ID，始终返回固定 snapshot；接受/拒绝等写入也固定修改 state.projectTask / blueprint。页面确实展示示例数据，但这不能授权它修改另一示例对象。
- 修复边界：必须绑定目标 ID；没有该对象的 Skill 数据时显示未提供/未接入并禁用写入。无需为所有对象生成假提案，也不要求顺带实现 UI-10。

### FE-02 · P2 · 新建任务成功后再次保存会重复创建

- 位置：当时的 [CreateTaskView.vue](../development/archive/m02-vue-workbench-baseline/src/views/CreateTaskView.vue) `submit` 第 88 行与保存按钮；[fixtureAdapter.ts](../../apps/workbench/src/fixtures/fixtureAdapter.ts) `createTask`。
- 复现：填写名称、结果、验收项→保存成功→不修改表单，再点一次“保存任务”→返回列表。
- 实测：同名同内容出现 `/tasks/task-demo-1` 与 `/tasks/task-demo-2` 两条记录。
- 根因：submitting 只防在途并发，成功后表单仍可再次发起 CreateTask，没有成功后的流程转换或同一提交身份。
- 验收要求：同一份已成功提交的表单不能意外再次创建；新增另一个任务应有明确入口。ready 失败但 create 已成功时尤其不能重新 CreateTask。
- 关联静态缺口：超时场景仅抛出 fixture 错误，`lookupReceipt()` 不接 command_id、始终返回“未找到”。这不是后端回执查询的实现；修复中应覆盖已提交丢响应、未提交和仍未知三种结果，不能靠新 ID 盲重试。

### FE-03 · P2 · 切换项目后隐藏旧依赖仍被提交

- 位置：当时的 [CreateTaskView.vue](../development/archive/m02-vue-workbench-baseline/src/views/CreateTaskView.vue) projectId/dependencyId 与 dependencyOptions；[fixtureAdapter.ts](../../apps/workbench/src/fixtures/fixtureAdapter.ts) 第 581 行。
- 复现：所属项目选“人机协作工作流研究”→依赖选“确定实验评价指标”→所属项目改“Workflow OS”→保存。
- 实测：依赖 select 的可见值已为空，回执却报告已登记旧项目的前置任务，并因此阻止 ready。
- 根因：筛选 option 未清除 dependencyId；adapter 只验证依赖 ID 存在，不核对项目归属。
- 验收要求：项目变化清除失效依赖；adapter 拒绝跨项目输入且不创建半成品任务。项目任务页“新建任务”也应携带当前项目，并允许用户明确改变归属。

### FE-04 · P2 · 新建表单离开时草稿静默丢失

- 位置：当时的 [CreateTaskView.vue](../development/archive/m02-vue-workbench-baseline/src/views/CreateTaskView.vue) 第 253 行“返回列表”；[CreateProjectView.vue](../development/archive/m02-vue-workbench-baseline/src/views/CreateProjectView.vue)；[App.vue](../development/archive/m02-vue-workbench-baseline/src/App.vue) 按 fullPath 重建页面。
- 动态复现：填写未提交任务名→返回列表→再次新建。实测 dialog 数量 0，重入标题为空。
- 静态核对：创建项目页同样没有草稿守卫；该页路径未在本轮单独动态复现。已实现的 Skill 草稿守卫不能代表两个创建页已覆盖。
- 验收要求：返回、侧栏导航、前后退等离开路径提供保留/明确放弃；浏览器刷新/关闭给出未保存提示。不要未经需要把敏感草稿持久化到 localStorage。

## 4. 接入缺口与调整建议

| 编号 | 类型 | 当前事实与处理方式 |
|---|---|---|
| INT-01 | 接入前对齐 | 前端 mode 使用 HUMAN，API 使用 ME；executor_kind=HUMAN 是另一字段。revision 也有前端 number / API 十进制 string 差异，不能直接映射后用 Number 丢精度 |
| INT-02 | 能力缺口 | 前端项目列表/归档、全空间任务筛选、资料导入、interaction-mode 与 Skill 提案均有示例行为，现有 API 只覆盖其子集。先逐项列能力映射；缺失入口标不可用，不发明成功结果 |
| INT-03 | 已修复（后端 schema readiness） | 本记录初始复验时 readiness 只执行 `database.ping`。随后 `0003_schema_readiness` 增加应用角色可读的受限兼容视图，`/health/ready` 逐项比对随包迁移名称与 SHA-256，并在 schema 查询失败后复核数据库可达性；真实 PG+HTTP 已覆盖空库、缺最新迁移、当前清单、未知未来迁移、摘要不匹配与两次探测间断连。前端仍未接入真实 API，因此这不构成联调通过。 |
| UI-ADJ-01 | 可选视觉调整 | 项目列表截图保留暖白、墨绿、宋体标题及三栏；相对原图，右侧对象标题/状态层级较弱，搜索独占一行。可在现有 token 内调整，不恢复已被语义规范纠正的全局工作台切换 |
| UI-ADJ-02 | 文案调整 | 创建页与列表右区直接展示 CreateTask、INBOX、HUMAN、ready、Delegate 等实现术语，建议替换为用户结果与下一步说明；示例标记与禁用原因仍保留 |

本轮未发现 token 需要重建：CSS 变量来自唯一 design-tokens.json，浏览器 body 的 computed font-family 与 UI 字体栈一致；这不证明每个字形的真实回退字体、全部对比度或桌面字体可用性。9 张截图有纵向内容，截图内未出现某操作不代表该操作不可滚动到达；不据此虚构裁切缺陷。

明确排除一个未成立的疑点：创建后返回列表可以看到新任务。App.vue 按 fullPath 重建列表，因此本轮不将“创建后列表不刷新”列为缺陷。

文档原有漂移：CODEX_NEXT_STEP 开头停在 P02、后文已有 P03；README 开头仍说无人工完成/重开；AGENTS 当前阶段停在 P00；HTTP 状态说明仍称未暴露完成动作。本轮只修正这些当前描述并链接验收，不改历史测试记录或 ADR 状态。

## 5. 修复顺序与重新验收

独立提示词入口：[验收修复与调整](../../prompts/remediation/README.md)。这些文件与原 P00–P22、逐页开发提示词分开维护；以下是修复前的执行计划，实际执行与复验结果以第 7 节为准。

1. R01 修复 BE-01/02；R02 修复 FE-01–04，分别按提示词补有意义的回归用例。
2. R03 完成接口与交互语义对齐，明确尚缺 API 与 schema readiness 处理边界；不以创建此文档宣称已经联调。
3. R04 为可选视觉与文案调整，正确性缺陷优先。
4. 重验现有基线、新增反例、命令重放与历史保留。后端通过、fixture 通过、真实联调通过、桌面通过分别判定；不得合并成一个“全通过”。

未覆盖：全部 37 场景、P05+ Run/恢复/审批、真实 Provider、安装升级卸载、生产 WebView/IME/DPI、性能预算与全部安全边界。它们不属于当前阶段已通过能力。

## 6. 文档影响检查

本轮新增本验收记录与独立 R01–R04 提示词，更新 CODEX_NEXT_STEP、README、AGENTS 的过期当前描述、前端验收状态、文档导航与 HTTP 实现状态勘误。需求、架构、ADR、数据库和业务 API 行为未改变；未新建路线图/变更日志/问题库来重复维护同一清单。

`node scripts/check-docs.mjs` 通过：63 个 Markdown、673 个链接、126 个设计 token、29 条预设对比度检查。该结果只验证文档静态结构，不改变上述产品验收结论。本轮启动的浏览器会话、4175 前端服务与临时 PG 集群已关闭，补充 dist 探针已移除。

## 7. 修复后独立复验（2026-09-21）

**R01 后端范围与 R02 前端 fixture 范围通过复验；整体前后端联调、Windows 桌面与完整业务验收仍不放行。** 本节是对第 3 节问题的后续事实，不改变其修复前复现记录。

| 编号 | 修复后判定 | 独立复验证据与边界 |
|---|---|---|
| BE-01 | 已修复 | 当前 State 投影仅包含仍为 `DONE`、当前 `acceptance_revision` 与 `current_completion_id` 一致的完成周期；历史 CompletionRecord/HumanAcceptance/state refs 均保留。Reopen 同一短事务递增 Project State revision。另验证非空 `SET_NEXT_ACTION` 与 Reopen 一律按 Task → ProjectState 锁序，不出现 500/`40P01`。 |
| BE-02 | 已修复 | `SET_PHASE` 只接受同 Project Type 的内置阶段；未知、跨类型和空白输入返回 422 `VALIDATION_FAILED`，不写 State、回执或审计。该未发布工程的收紧行为已在 HTTP 契约标为 Breaking Change。 |
| FE-01 | 已修复（fixture） | Skill 的读取和写入均接收路由项目/任务 ID；没有对应 fixture 时显示未提供状态，不回退或写入固定示例对象。 |
| FE-02 | 已修复（fixture） | 创建意图复用原 `commandId`；回执模拟已应用、未提交、仍未知，响应丢失后可用相同 ID 核对。成功后进入结果态，不能重复保存产生第二个任务。 |
| FE-03 | 已修复（fixture） | 项目变更会清除失效依赖；adapter 写前校验项目、归档状态与依赖同项目，拒绝不留下半成品；项目任务页预填当前项目。 |
| FE-04 | 已修复（fixture） | 创建项目/任务均注册全局草稿守卫，覆盖侧栏、浏览器返回和 query 切换；`beforeunload` 提示未保存草稿，成功后正常离开。 |
| INT-01–03 | 已对齐，未联调 | 前端 mode 已改为 `ME`，executor 仍为独立 `HUMAN`；Task/验收 revision 已改十进制字符串并通过超过 `2^53` 回归。多个页面仍无真实 API；后端 readiness 已用真实 PG 覆盖 schema 兼容门，但 fixture 没有调用它。 |
| UI-ADJ-01/02 | 已复验（浏览器） | 项目摘要强化对象/阶段/待审层级，用户文案改为结果说明；未改 token 数值或业务契约。 |

主 Agent 最终实际运行：

| 检查 | 命令 / 工作目录 | 结果 |
|---|---|---|
| API 类型与单元 | `pnpm@9.15.9 run test`，`apps/api`，仓库便携 Node 24 | 28/28 通过 |
| API 真实 PG+HTTP | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-integration.ps1`，`apps/api` | 79/79 通过；含 schema readiness 的空库、缺 `0003`、当前清单、未知未来迁移、摘要不匹配和 schema 查询失败后的数据库复核；隔离临时集群停止、目录清理 |
| Workbench 构建 | `npm run build`，`apps/workbench` | 通过；JS 241.40 kB（gzip 80.87 kB）、CSS 36.99 kB（gzip 5.20 kB） |
| Workbench 组件 | `npm run test`，`apps/workbench` | 10 个文件、68/68 通过 |
| Workbench Chromium | `npm run test:browser`，`apps/workbench` | 19/19 通过（1487×1058、960×720、390×720、480×360 等效视口，及 Chromium CDP 内容缩放 200%） |
| 截图与缩放检查 | `npm run screenshots` 加 Chromium 黑盒检查 | 9/9 页面截图；CDP `pageScaleFactor=2` 后键盘可打开右区并激活主操作，480×360 等效视口右区/主操作可达，整页横向溢出为 0 |
| 文档静态检查 | `node scripts/check-docs.mjs`，仓库根 | 通过：63 个 Markdown、679 个链接、775 个标题锚点、126 个 token、29 条预设对比度检查 |

仍未通过或未验证：工作台没有真实 API 客户端，不能把 fixture 回执当数据库幂等；项目列表、归档、资料导入、全量任务筛选及四项 Skill 的真实写入仍缺 API；未运行全部 37 个验收场景；未验证真实桌面 WebView、Windows DPI/IME、安装/升级/卸载、Provider 或 P05+ 的 Run/Review/恢复。文档静态检查不代替上述产品验证。

## 8. P05/P06 接续独立验收（2026-09-23）

**修复前结论：既有基线通过，P05/P06 有两个 P1 阻塞项，暂不放行进入 P07。** 以下结果来自主 Agent 本轮实际运行；不是沿用 2026-09-22 自测数字。执行提示词见 [R05](../../prompts/remediation/R05-workflow-verification-gates.md)。

| 检查 | 本轮结果 | 证据边界 |
|---|---|---|
| API strict typecheck / build | 通过 | 仓库便携 Node 24.21.0，直接调用本地 TypeScript |
| API 单测 | 57/57 通过 | `node --test "dist/test/unit/**/*.test.js"` |
| API 真实 PG 集成基线 | 109/109 通过 | `run-integration.ps1 -SkipBuild`，先完成 build；临时 PG 停止、目录清理均成功 |
| 两项补充真实 PG 反例 | 总计 111，109 通过、2 失败 | 原 109 项保持通过；下述两项违反正确性断言 |
| Workbench typecheck / build | 通过 | 本地 vue-tsc、Vite，未改前端源码 |
| Workbench 组件测试 | 80/80 通过 | 12 个测试文件；部分 live 模式用模拟 fetch，不是实际 API 联调 |
| Chromium | 19/19 通过 | 现有 fixture 页面、键盘、视口与缩放；不等同 WebView 或安装交付 |

### R05-01 · P1 · 自动完成忽略声明的产物要求

- 位置：[complete-run.ts](../../apps/api/src/application/complete-run.ts) 的 `evaluateCompletionGate`/`completeRun`；对照 [completion-commands.ts](../../apps/api/src/application/completion-commands.ts) 的 `declaredArtifactKinds`/`requireDeclaredOutputs`。
- 复现：在 Delegate 前保存 `required_output_spec={artifacts:["MARKDOWN_DOCUMENT","TEST_REPORT"]}` 与必需 `MARKDOWN_STRUCTURE` 条件；固定 Workflow 仅生成 Markdown，验证后继续 COMPLETE。
- 实测：`STEP_SUCCEEDED / COMPLETED`、Task=`DONE`，数据库中仅有 `MARKDOWN_DOCUMENT`。`TEST_REPORT` 是当前不支持的类型；正确行为应拒绝不可判定的要求，不能假装满足。该反例不要求新增产物类型。
- 根因：执行契约保存了 `expected_outputs`，自动完成仅判断最新 PASS、验收 revision、撤销与文件 hash，没有核对声明要求。人工路径已经拒绝未知类型/非数组，两个入口语义不一致。
- 验收：固定 Workflow 不支持的声明明确拒绝；已存在 Run 的完成门也须保守拒绝，不写 CompletionRecord/State delta/成功审计。合法 Markdown 和既有人工路径保持通过。

### R05-02 · P1 · 旧 claim 结果使当前合法结果无法登记

- 位置：[run-steps.ts](../../apps/api/src/application/run-steps.ts) 的 `recordStaleAttemptResult`、[run-repository.ts](../../apps/api/src/run/run-repository.ts) 的 `markAttemptRejectedStale`。
- 复现：当前 attempt=`RUNNING`、epoch=1，先提交 epoch=0 结果，再提交 epoch=1 正确结果。
- 实测：旧结果虽被拒，却将当前 attempt 改为 `REJECTED_STALE`；随后正确结果 `accepted=false`。原 B08 用例恰好断言了该状态，未覆盖合法 Worker 后续可提交。
- 根因：记录旧结果的核对证据时更新了当前 attempt 的业务状态，且更新不带预期 epoch 条件。迟到拒绝和当前领取状态未分开处理。
- 验收：旧结果不得修改当前 claim 的状态/epoch/worker/lease/有效结果；合法结果仍可提交，重复及终态保持不可回写；补真实 PG 确定性竞争用例。

### 复现方式与尚未验收的边界

临时探针保存在 `.planning/acceptance-2026-09-23/probe.mjs`，完整本地输出为同目录 `probe.log`。根目录先 build，再以便携 Node 运行探针；探针只临时补充编译后的测试，`finally` 恢复两个 dist 文件，源码未改。探针复跑同一隔离 PG runner；输出明确 `111 tests / 109 pass / 2 fail`，停止退出码 0、临时目录已清理。它是修复前证据，不替代 Terra 应添加的正式源码回归测试。

尚未重验真实 API 前端整条人工路径；2026-09-21 的浏览器联调证据仍是历史证据。本轮未验收 P07 Review、P08 完整控制/恢复、真实 Provider、Windows WebView/IME/DPI 或安装升级卸载；不冻结 ADR-006/007。Run → Task 锁序和事务内有界本地 I/O 保留既有文档限制，不把它们伪称为本轮新复现问题。

文档影响：本轮更新本记录、当前阶段、README 与提示词入口；既有业务契约、ADR、数据库 schema 未由主 Agent 改动。修复的 API 行为与物理实现说明由 Terra 按实际变更同步，完成后追加复验事实。


## 9. R05 修复后独立复验（2026-09-23）

**R05-01、R05-02 已修复，本轮 P05/P06 已实现的 Fake Workflow 范围通过复验；整体产品仍未验收。** 用户明确要求直接下发 Terra 优先修复阻塞项，实际执行者为 gpt-5.6-terra / xhigh，主 Agent 负责修复前反例、差异审查和最终独立复跑。

| 问题 | 最终行为与证据 |
|---|---|
| R05-01 | 人工完成、Delegate 与自动 Gate 复用 declared-output-requirements.ts。真实 HTTP 对未知种类/非数组声明返回 409 INVALID_TRANSITION，Task 保持 READY、没有 live Run；历史冻结 Run 的快照和摘要在测试中一致，Gate 返回 COMPLETION_BLOCKED / DECLARED_OUTPUTS_UNSATISFIED，不写 Attempt、完成凭据、State 引用或成功审计；必需 Markdown 的 target 为空也阻止提交，合法 Markdown 与既有无产物要求人工路径继续通过。 |
| R05-02 | 旧 epoch 只追加 STEP_ATTEMPT_RESULT_REJECTED_STALE 审计，保留当前 claim；正确 epoch 随后成功，终态与重复提交不覆盖有效结果。额外真实 PG 用例持有显式行锁，旧提交仍可完成拒绝，合法结果在释放锁后以 RUNNING + claim_epoch 条件提交；原 B08 的步骤位置及版本数量断言保留。 |

主 Agent 在 Terra 结束编辑后执行以下最终检查，未使用子代理自测代替独立复验：

| 检查 | 实际执行 | 结果 |
|---|---|---|
| 类型与构建 | apps/api：仓库便携 Node 24.21.0 调用本地 TypeScript，tsc --noEmit -p tsconfig.json、tsc -p tsconfig.json | 均退出 0 |
| 单元测试 | apps/api：node --test "dist/test/unit/**/*.test.js" | 57/57，无失败/跳过 |
| PG 全量集成 | 根目录：powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -SkipBuild；使用上一步新构建 | 113/113，无失败/跳过；包含四项新增用例及增强后的 B08 |
| PG 清理 | 本轮独立临时集群 relay-api-integration-ef2fd9195d | start/stop 均退出 0，temporary cluster removed=True |
| 已应用 migration | 与修复前记录的 0001–0005 SHA-256 逐项比较 | 0 个差异，没有新 migration |
| 前端检查 | 沿用本轮第 8 节实跑；R05 未修改前端 | typecheck/build、80/80 组件、19/19 Chromium 通过；不重复未受影响的视觉回归 |

本次复用已有人工产物规则、Repository 的 PG 条件更新和 activity_records 审计；不引入依赖、调度器或通用恢复框架。HTTP 对 Delegate 的校验收紧在契约中标明 Breaking Change，旧异常 Run 保留冻结历史并在提交时阻塞，不自动改写要求。R05 不解决 P08 的过期扫描、资源隔离或完整执行权恢复。

文档同步：更新 CODEX_NEXT_STEP、README、HTTP 契约、PostgreSQL 物理设计、本验收记录与 R05 提示词/入口。需求、ADR 和数据库 schema 未改变；本次修复原因及回归留在现有验收记录，不另建重复 Bug 文档、路线图或问题库。最终文档静态检查结果记录在本节末尾。

下一步可按原顺序接续 P07，本轮没有实施。真实 API 前端全路径、完整 37 场景、真实 Provider、Windows WebView/IME/DPI 与安装升级卸载仍保持各自原验收边界，不因本轮通过而放行。

最终文档检查通过：64 个 Markdown、714 个链接、798 个标题锚点、126 个设计 token、29 条预设对比度检查。该结果仅证明静态文档检查通过。
