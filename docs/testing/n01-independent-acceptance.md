# N01 项目接续点首片 — 独立验收记录

日期：2026-09-29。角色：独立验收者（非实现者）。对象：`prompts/post-v1-collaboration.md` 的 N01 首个切片（手动保存/查看/比较项目接续点）。

## 1. 结论

**CHANGES_REQUESTED**

工程侧（后端契约、并发、幂等、只增迁移、前端冻结与回执核对）证据充分且与契约一致；**发现 1 项数据库层完整性缺陷（P1）与 2 项覆盖率/文档口径问题（P2）**，另有多项未验证边界。修复 P1 并补齐 P2 的取证后即可复验放行。

本结论**只解除 N01 自身依赖，不自动授权 N02**；也不改变 M01–M07 出口、真实 Provider 门槛或 Windows 验收状态。

## 2. 基准

### 2.1 代码基准

- 分支 `main`，`HEAD = 7949de4`（`test(workbench): 添加 UI 状态取证与 Live 对照 Playwright 脚本`）。
- 工作树含大量他人未提交改动（N01 之外）。验收开始时 `git status --porcelain` 共 80 条，含 `RunView.tsx`、`TaskDetailView.tsx`、`router.tsx`、`styles.css`、`AppShell.tsx`、`ArtifactPanel.tsx`、`ReviewsView.tsx` 与未跟踪的 `CollaborationView*`、`DevToolsPanel*` 等。
- 本次验收**未修改任何生产代码**：未执行 `git checkout/stash/clean/reset`，未回退他人改动，验收结束后的 `git status` 仍为 80 条且不含本记录以外的新增/删除。
- Node 实测 `v22.22.3`（`package.json` 要求 `>=24 <25`，pnpm 打印 engine 警告）。集成脚本内部使用仓库自带 `node-v24.21.0`，故 PG 集成链路在 Node 24 下运行；Workbench 的 vitest/vite 在 Node 22 下运行。该差异记录为环境限制。

### 2.2 验收文件清单（与实现者自述一致，已逐个核对存在）

新增：`apps/api/migrations/0044_project_continuation_points.sql`、`apps/api/src/project/continuation-point-repository.ts`、`apps/api/src/application/project-continuation-points.ts`、`apps/api/src/api/project-continuation-api.ts`、`apps/api/test/integration/project-continuation.integration.test.ts`、`apps/workbench/src/components/ContinuationPointPanel.tsx`、`apps/workbench/tests/continuationPoint.spec.ts`。

修改：`database-schema.ts`（2 个 Row 类型 + 2 张表映射）、`unit-of-work.ts`（注册 `continuationPoints`）、`routes.ts`（注册路由）、`envelope.ts`（`resourcePathOf` 新增一个 case）、`domain-schemas.ts`（`WorkspaceContinuationPointParamsSchema`）、`migration.integration.test.ts` / `cli.integration.test.ts`（清单 44）、`relayClient.ts`（DTO + 3 方法 + 解析器）、`ProjectResumeView.tsx`（挂载面板 + 2 处文案）、`projectResumeLive.spec.ts`（跟随文案）、`docs/api/http-command-contract.md` §10.51、`docs/frontend/workbench-design.md` §15、`CODEX_NEXT_STEP.md`。

**不属于 N01 但同文件混入的他人改动**（验收中单独识别，不计入 N01 结论）：`relayClient.ts` 中的 `RelayTaskSummary.updatedAt`、`RelayRunGatewayOperation.invocations`、`RelayGatewayInvocationResult`、`RelayCommandOutput` 属协作工作区切片；`verification-plan.md`（AGUX 表）、`docs/README.md`、`design-system.md`、`page-development-prompts.md`、`router.tsx` 的 `/agent` 亦属该切片。

## 3. 我实际运行的命令与结果

全部在一次性临时 PostgreSQL 集群上运行（`run-integration.ps1` 自建自清，每次返回 `temporary cluster removed: True`）。

| 命令 | 结果 |
|---|---|
| `pnpm --filter @relay-agent/api run typecheck` | 通过（`tsc --noEmit` 无输出） |
| `pnpm --filter @relay-agent/api run test` | **136 tests / 136 pass / 0 fail / 0 skipped**，6.09s |
| `run-integration.ps1 -TestFile project-continuation` | **2 / 2 pass**，14.4s，`ledger_rows: 44`，集群已清理 |
| `run-integration.ps1 -TestFile migration` | **8 / 8 pass**，`ledger_rows` 清单含 `0044_project_continuation_points` |
| `run-integration.ps1 -TestFile schema-readiness` | **6 / 6 pass** |
| `run-integration.ps1 -TestFile cli` | **5 / 5 pass**，`ledger_rows: 44` |
| `apps/workbench` `pnpm run typecheck` | 通过 |
| `apps/workbench` `pnpm run build` | 通过（`index-CpOAzD81.js` 1,169.11 kB / gzip 319.87 kB），仅既有 chunk 体积与 Tauri 动态导入告警 |
| `vitest run tests/continuationPoint.spec.ts` | **3 / 3 pass** |
| `vitest run tests/projectResumeLive.spec.ts` | **3 / 3 pass** |
| `vitest run`（全量，第 1 次） | **362 项：360 pass / 2 fail**（`run-events.spec.ts`、`tasks.spec.ts`） |
| `vitest run`（全量，第 2 次） | **362 项：361 pass / 1 fail**（仅 `run-events.spec.ts`） |
| 隔离复跑 `run-ui1820` / `run-events` / `tasks` | **6 / 6、5 / 5、14 / 14 全部通过** |
| `node scripts/check-docs.mjs`（写本记录前） | 通过：Markdown 106、链接 1860、锚点 1371、令牌 131、对比度 29 |

**自建反例取证（本记录专用，验收后已删除，不属于交付产物）**：

| 临时文件 | 结果 |
|---|---|
| `apps/api/test/integration/zz-accept-n01.integration.test.ts`（A–J，10 例） | **10 / 10 pass**，29.8s，`status: PASSED`，集群已清理 |
| `apps/workbench/tests/zz-accept-continuation.spec.ts`（6 例） | **6 / 6 pass** |

### 3.1 全量前端 1 例偶发红的判定

两次全量的失败集合不同（第 1 次 `run-events`+`tasks`，第 2 次仅 `run-events`），三个文件隔离复跑均全绿。`RunView.tsx` 属他人未提交改动范围，N01 未触及 `RunView`/`TasksView`。判定为**共享负载下的既有时序脆弱，不是 N01 回归**。实现者自述的失败项是 `run-ui1820`，与本轮实测不符（该文件两次全量均未失败，隔离 6/6 通过）；此项表述需在 `CODEX_NEXT_STEP` 更正。

## 4. 不变量逐条判定

| # | 不变量 | 判定 | 我自己的证据 |
|---|---|---|---|
| 1 | 只保存确切版本引用，不复制业务状态；比较读现时事实 | **通过** | 迁移只存 `state_phase_key`/`state_revision`/`next_action_task_id` + `(ref_kind, ref_id, ref_revision, ordinal)`，无正文列。捕获后直接查 `projects`/`state_revision` 与 `tasks` 均未被改写（自检 test 1）；我另测：Task 保持 `IN_PROGRESS`、`project_states.revision` 保持 `1`，GET 列表/详情/比较三轮后接续点仍只有 1 行。 |
| 2 | 捕获不停活动 Run；打开项目不重设基线 | **通过（范围受限）** | 捕获代码路径不引用 `r.runs`；实测进行中 Task 捕获与两次比较后仍 `IN_PROGRESS`。**但未在真实活动 Run（RUNNING/worker 在途）下取证**，见 §6。 |
| 3 | 同事务对 Project 取 `FOR UPDATE`，排除并发 Task 插入，被进行中归档挡住 | **通过** | `project-continuation-points.ts:134` 调 `lockProjectExclusive`（= `select … for update`）。实测：在事务内持有该行锁时并发 `createTask` 900ms 未完成，释放后成功；归档（`archive-project.ts:42` 同一把 `FOR UPDATE`）同样被挡住，释放后成功。 |
| 4 | 同 `command_id` 同内容 → 原回执 + `Command-Replayed: true`；异内容 → `COMMAND_ID_REUSED` | **通过（补测）** | 实现者只覆盖了同内容重放。我另测：同 ID 改 `name` → 409 `COMMAND_ID_REUSED`；同 ID 改 `note` → 409；同 ID 同内容 → 201 + `command-replayed: true`；三次后 `project_continuation_points` 仍为 1 行。 |
| 5 | 跨 Workspace / 跨 Project 读取一律 404 | **通过** | 实现者覆盖跨 Workspace 详情读取。我另测：跨 Workspace **捕获 POST** → 404、跨 Workspace 列表 → 404、未知 Project 列表 → 404、未知接续点 → 404。`readPointRow` 先 `readProjectInWorkspace` 再比对 `row.workspace_id`/`row.project_id`，不泄漏存在性。 |
| 6 | `interpretation` 恒为 `null`，前端不用摘要顶替事实 | **通过** | 应用层 `interpretation: null`；响应 schema `Type.Null()`（无法返回非空）；比较响应体实测 `interpretation === null`；面板无任何解读渲染，`artifacts` 版本不显示为"最新"。 |
| 7 | 提交不确定时冻结原 `command_id`，只提供查回执 | **通过** | 我自建 6 例前端反例全绿：网络异常→冻结并只查原回执、连点 3 次只发 1 次 POST、回执 `command_id`/`project_id`/`name` 三种不匹配均按无法核对处理且仍冻结、确定性 4xx（409）解除冻结并允许换新 ID 重提、损坏 sessionStorage 不崩溃也不凭空产生待核对命令、别的项目的待核对命令不被本项目接管（不查询其回执）。 |
| 8 | 无新增前端路由；未改 Project State/Task/Artifact/Run/Review 形状或状态机 | **通过** | `router.tsx` 无 `continuation` 路由（接续点挂在既有 `projects/:id` + `?skill=resume`）。以"移除 0044 后重跑迁移到第二个库、与当前库逐项 diff"证明：新增列只出现在两张新表，**删除列 0、既有列定义变更 0、删除索引 0、删除/改名约束 0、既有约束定义变更 0**。 |
| 9 | 读取复核当前作用域；来源缺失标 `MISSING`，不以最新版替代 | **部分通过** | 作用域复核成立（第 5 条）。`SUPERSEDED` 时 `current_revision` 仍返回捕获时版本（实测 `'1'`）、`note` 说明"已有更新版本 v2"，符合"不以最新版替代"。**但 `MISSING` 分支在当前 V1 下不可达**（见 F-3）。 |
| 10 | 迁移只新增对象；已应用迁移内容摘要未被改动 | **通过** | 同第 8 条的双库 diff 证据。`0043` 及更早文件未被触碰（`git status` 未列出任何 `apps/api/migrations/00[0-4][0-3]*` 的修改）。 |

## 5. 发现项

### F-1（P1）`ck_project_continuation_point_refs_target` 不是 NULL 安全的，数据库层并未真正保证"引用绑到目标对象"

- **位置**：`apps/api/migrations/0044_project_continuation_points.sql:38-41`
- **实测**：以迁移角色（`relay_migrator`）插入
  `ref_kind='TASK', ref_id=<任意 uuid>, task_id=NULL, artifact_version_id=NULL` → **插入成功**；
  `ref_kind='ARTIFACT_VERSION', ref_id=<任意 uuid>, task_id=NULL, artifact_version_id=NULL` → **插入成功**。
  随后用应用角色回查，两条脏行确实已落库（`count = 2`）。
- **根因**：PostgreSQL 的 CHECK 只在结果为 **FALSE** 时拒绝；`artifact_version_id = ref_id` 在左值为 NULL 时求值为 NULL，`NULL AND … ` 结果为 NULL，于是整条 CHECK 通过。而 `ref_id` 自身**没有任何外键**，完整性完全依赖这条 CHECK——一旦目标列为 NULL，就得到一条完全无引体的悬挂引用。
- **与既有表述冲突**：迁移注释写"两类引用都保留数据库级完整性"；契约 §10.51 与 N01 自检把 DB 级完整性作为该设计的收益。当前实现只能拒绝"目标列非空但与 `ref_id` 不符"，不能拒绝"目标列为空"。
- **用户影响**：当前**无直接用户可见缺陷**——`ContinuationPointRepository.insertRef`（`continuation-point-repository.ts:39-40`）按 `refKind` 必填对应列，应用层不会产生这种行。但该保证正是本设计选择的纵深防御；一旦出现其它写入方（后续迁移、运维脚本、人工排障、未来接续点编辑/删除功能），脏引用会静默落库，且因为比较逻辑按 `ref_kind` 分支读 `ref_id`，脏行会表现为"来源当前不可见"，把数据损坏伪装成正常业务状态。
- **修复验收要求**：把 CHECK 改为 NULL 安全（例：`CHECK (ref_kind = 'TASK' AND task_id IS NOT NULL AND task_id = ref_id AND artifact_version_id IS NULL) OR (ref_kind = 'ARTIFACT_VERSION' AND artifact_version_id IS NOT NULL AND artifact_version_id = ref_id AND task_id IS NULL)`，或给两列加 `NOT NULL` 的分列约束）；补真实 PG 反例覆盖 `ref_kind='TASK'` 且 `task_id IS NULL`、`ref_kind='ARTIFACT_VERSION'` 且 `artifact_version_id IS NULL` 两例并断言 `23514`。因迁移只追加原则，应新增 `0045` 修正或直接修正尚未发布的 `0044`（后者需说明理由，二者取一并保持台账一致）。

### F-2（P2）`ARTIFACT_VERSION` 引用路径与 `CURRENT`/`SUPERSEDED` 标签在实现者测试中完全没有覆盖

- **实测**：实现者集成测试只覆盖 `TASK` 引用（`project-continuation.integration.test.ts:50` 断言 `ref_kind` 全为 `TASK`，`ref_count = 2`）。我在自建 A 例中补齐：`state_artifact_refs → ARTIFACT_VERSION` 引用确实被捕获（`captured_revision='1'`）；仅追加 v2 后 `change` 由 `CURRENT` 变 `SUPERSEDED`、`current_revision` 仍为 `'1'`、`note` 为"该成果已有更新版本 v2"、`artifact_version_added` 为空。**行为正确，但零回归保护**。
- **用户影响**：成果版本变化是 N01"隔日回来比较"最主要的价值来源之一；一旦回归（改成返回最新版、或漏判 `SUPERSEDED`），现有测试不会变红。
- **修复验收要求**：把该路径并入 `project-continuation.integration.test.ts`（真实 PG + 真实 API：ready→start→建 artifact v1→`SELECT_ARTIFACT_VERSION`→捕获→比较得 `CURRENT`→追加 v2→比较得 `SUPERSEDED` 且 `current_revision` 仍为捕获版本）。

### F-3（P2）`MISSING` 分支在当前 V1 下不可达，契约对该分支的表述没有证据支撑

- **事实**：`src` 中不存在 `delete from tasks` / `delete from artifact_versions`；而 N01 自己的外键（`project_continuation_point_refs.task_id` / `.artifact_version_id`）会**阻止**这些行被删除。因此"任务被删/成果版本不可用 → `MISSING`"在 API 层无法复现。契约 §10.51"来源缺失或失权标为 `MISSING`"目前只有代码分支、无反例。
- **附带差异**：`task_id` 外键是 `DEFERRABLE INITIALLY DEFERRED`，`artifact_version_id` 不是。捕获总是先读后写、两者都无需延迟，这个不对称没有理由，增加理解成本。
- **用户影响**：低（无删除路径即无实际影响）。但"缺失/失权"是后续切片（删除接续点、来源失权）的前置契约，提前写成已实现事实会让后续切片误判边界。
- **修复验收要求**：二选一——(a) 把 §10.51 与 workbench §15 中 `MISSING` 的表述降级为"首片不可达的防御分支"并说明不可达原因；或 (b) 补一条可达反例（例如经迁移角色构造指向已不可读来源的行）并在契约中写明构造方式。同时说明 `task_id` 外键为何需要 DEFERRABLE，若无理由则去掉。

### F-4（P2）比较与列表未对每条引用复核其仍属于本 Project

- **位置**：`project-continuation-points.ts:216-239`（按 `ref_id` 读 Task / ArtifactVersion，未校验 `project_id` / `workspace_id`）
- **可达性**：仅当库里存在"接续点 A 引用了 Project B 的对象"的行时才会泄漏该对象的 `status` / `version_number`。应用层写不进去（捕获只读本项目），应用角色对两张新表只有 `SELECT/INSERT`（实测 `role_table_grants` 恰为这 4 条授权），需迁移角色或直接改库才能构造。
- **用户影响**：当前无。与不变量 9"读取始终复核当前权限"存在口径差：接续点本身复核了作用域，引用没有。
- **修复验收要求**：在 `resolveRefChanges` 中对每条引用加一道 `task.project_id === 目标 projectId` / `artifact.project_id === 目标 projectId` 判定，不匹配按 `MISSING` 处理；或明确记录"引用归属由写入端保证"并在契约写明。

### F-5（P3）前端一旦冻结了待核对命令，在回执始终查不到时没有退出路径

- **位置**：`ContinuationPointPanel.tsx:153-155, 209-214`
- **实测行为**：`pending !== null` 时保存按钮恒禁用，界面只提供"查询原命令回执"。若该命令确实从未到达服务端，回执永远 `COMMAND_NOT_FOUND`，本会话内用户再也无法保存新接续点（只能重开页面；`sessionStorage` 仍在，冻结随之恢复）。
- **用户影响**：低频但真实的死路。它与设计文档"只提供查询原命令回执"一致，因此**不是实现偏离规格**，而是规格本身未覆盖这一分支。
- **修复验收要求**：由实现者与产品确认是否提供显式的"确认此命令未保存并重新提交"二次确认出口（须换新 `command_id` 并二次确认），或在 workbench §15 明确记录该死路是本片已知限制。

### F-6（P3，非 N01）`relayClient.ts` 共享文件被两个切片同时编辑，且留下一处格式损坏

`apps/workbench/src/api/relayClient.ts` 的 `getProjectGoals` 方法签名与其后的 `return` 挤在同一行（原为换行）。不影响功能（类型检查与构建通过），但说明该共享文件缺少切片归属约定。建议在 N02 分派前明确共享文件所有权。

## 6. 未覆盖项与限制

- **未在真实活动 Run 下取证**：环境未启动 worker/dispatcher，"捕获不停活动 Run"只由代码路径（捕获不引用 `r.runs`）与"进行中 Task 保持 `IN_PROGRESS`"支撑，不是真实 RUNNING Run 的实测。
- **未做真实 Windows 人工路径**：没有 Tauri 宿主、窗口或 DPI 取证；面板的窄窗、输入法、键盘可达性、真实 sessionStorage 行为未在 WebView2 下验证。`ContinuationPointPanel` 复用了既有 `resume-section` / `run-list` / `primary-button` / `warning-callout` 等类名，本次未核对它们在 `styles.css`（他人未提交改动）中的实际表现。
- **未验证 `listProjectContinuationPoints` 的 N+1**：该方法对列表中每个接续点各发一次 `listRefs`（1 + N 次查询，N ≤ 50）。单用户同机、数据量由 50 条列表上限约束，可接受，仅登记不作缺陷；未做查询次数计量。
- **未验证 `maxLength` 的浏览器端截断**：jsdom 的 `setValue` 直接赋值，不经过 UA 的 `maxlength` 截断，因此我只能断言控件声明了 `maxLength=120/2000`；服务端 120/2000 的实际拒绝已在集成测试 B 取证。真实粘贴/输入法下的截断行为未验。
- **未验证 Decision / Rule / Knowledge / 未决事项的捕获**：路线图 §N01 提到"Decision/Rule/Knowledge 版本引用及未决事项"，本切片只实现 Task 与 State 当前选用成果版本。路线图同时写"精确纳入集合…在设计中冻结"，因此本切片是已收敛的子集而非缺失，但 §15 与 §10.51 应显式写出"本片纳入集合 = 未终结 Task ＋ State 当前选用成果版本"，避免读者以为已覆盖 N01 全部纳入对象。
- **未验证真实 Provider / 模型外呼**：本切片不调用模型，`interpretation` 恒 null，无相关风险。
- **环境差异**：Workbench 的 typecheck/build/vitest 在 Node 22.22.3 下运行（仓库要求 `>=24 <25`），API 集成在仓库自带 Node 24.21.0 下运行。
- **并发捕获的窗口极短**：我用 `Promise.all` 同时发两个捕获（单进程 HTTP）。真正的多进程/多连接并发捕获未在真实多客户端下取证；不过两者都经同一把 Project 行锁串行化，且共享的 `runIdempotentCommand` 有唯一约束裁决，实现者与我的证据方向一致。

## 7. 放行判定

放行条件（全部满足后复验）：

1. 修 F-1，并补两条 NULL 目标列的真实 PG 反例（断言 `23514`）。
2. 把 F-2 的 `ARTIFACT_VERSION` + `CURRENT`/`SUPERSEDED` 路径并入正式集成测试。
3. 按 F-3 二选一处置 `MISSING` 的表述与 `DEFERRABLE` 不对称，并在契约/设计文档写明"本片纳入集合"边界。
4. 按 F-4 决定是否加引用归属复核，或在契约写明该保证由写入端承担。
5. 复跑本记录 §3 全部命令，并在 `CODEX_NEXT_STEP` 更正失败用例名（`run-events` 而非 `run-ui1820`）。

工程通过、Windows 体验与使用收益分别报告：本记录只覆盖**工程**。真实 Windows 人工路径与 PV08 的"隔日返回能否正确指出关键变化"体验记录**未运行**，不得据此宣称 N01 的用户路径已验收。

---

## 复验（第二轮）

日期：2026-09-29。角色：独立验收者（第二轮；与第一轮同一角色，非实现者）。对象：第一轮 §7 五项放行条件中的 P1、P2-1、P2-2、P2-3、P3-2 修复，以及是否引入回归。第一轮原文未删改。

### R1. 结论

**CHANGES_REQUESTED**

**数据库层缺陷 P1 已真实修复**（0045 与 `resolveRefChanges` 的归属复核均经我自建反例取证），**但 P2-1 的修复是一个写错方向、且约 50% 概率失败的正式集成测试**：我连续 5 次运行 `run-integration.ps1 -TestFile project-continuation`，**4 次失败、1 次通过**，失败恒定落在 `project-continuation.integration.test.ts:197`。这既是覆盖率问题，也是"新测试本身红"，按第一轮口径属 P1 级阻塞项。另有 1 项 P2（workbench §15 未按放行条件更新）与 3 项 P3 残留。

本轮**不放行**，**不解除 N01 对 N02 的依赖**，不自动授权 N02；不改变 M01–M07 出口、真实 Provider 门槛或 Windows 验收状态。

### R2. 基准

- 分支 `main`，`HEAD = 7949de4`（与第一轮相同）。
- 工作树中他人未提交改动仍在持续增加：本轮开始时 `git status --porcelain` 86 条，结束时 97 条（增量为他人并发写入，非本轮改动）。本轮**未修改任何生产代码**，未执行 `git checkout/stash/clean/reset`。
- 本轮唯一写入：临时反例文件 `apps/api/test/integration/zz-accept-n01-r2.integration.test.ts`（5 例）与本小节。临时文件已删除，删除后 `git status --porcelain` 中 `zz-accept` 匹配 **0** 条。
- Node `v22.22.3`（`package.json` 要求 `>=24 <25`，pnpm 打印 engine 警告）；集成脚本内部使用仓库自带 `node-v24.21.0`。与第一轮相同。
- **工作树在本轮验收期间被他人并发编辑**：`apps/api/src/application/assist-runner.ts` 的 `LastWriteTime` 为 `2026-09-29 21:51:27`，与我读取时刻同一秒；该文件一度处于 `TS2304: Cannot find name 'modelErrorEvidence'`（2 处）的不编译状态，使 3 次 `run-integration.ps1` 在 tsc 构建阶段提前失败（`tests exit code: not run`）。该文件**不属于 N01**。下表结果均取自构建成功的那次运行或重跑后的运行。

### R3. 我实际运行的命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm --filter @relay-agent/api run typecheck` | 通过（`tsc --noEmit` 无输出，exit 0） |
| `pnpm --filter @relay-agent/api run test` | **136 / 136 pass / 0 fail**，5.94s |
| `run-integration.ps1 -TestFile project-continuation`（共 5 次） | **1 PASSED / 4 FAILED**（4 tests，3 pass 1 fail），失败恒定在 `project-continuation.integration.test.ts:197` |
| `run-integration.ps1 -TestFile migration` | 通过（`ledger_rows: 45`，`applied` 末两项为 0044、0045）；另 3 次因他人并发编辑导致 tsc 构建失败，已重跑覆盖 |
| `run-integration.ps1 -TestFile schema-readiness` | **6 / 6 pass**，`ledger_rows: 45` |
| `run-integration.ps1 -TestFile cli` | **5 / 5 pass**，`ledger_rows: 45` |
| `apps/workbench` `pnpm exec vitest run tests/continuationPoint.spec.ts` | **3 / 3 pass** |
| `apps/workbench` `pnpm exec vitest run tests/projectResumeLive.spec.ts` | **3 / 3 pass** |
| `apps/workbench` `pnpm run typecheck` | **失败，10 个错误**（详见 R6） |
| `node scripts/check-docs.mjs`（写本小节前） | 通过：Markdown 107、链接 1862、锚点 1388、设计令牌 131、对比度 29 |
| **自建反例** `apps/api/test/integration/zz-accept-n01-r2.integration.test.ts`（5 例） | **5 / 5 pass**，16.1s，`status: PASSED`，临时集群自清 |

`project-continuation` 五次运行的原始判定与失败信息（节选，两次不同随机 UUID）：

```
attempt 1  # tests 4  # pass 3  # fail 1  status: FAILED
           project-continuation.integration.test.ts:197
           + actual   '353f6bcb-1d36-48b9-9c3c-5c170a383fc3'   (v1)
           - expected '9db56175-3568-4931-9b7b-630281cb057a'   (v2)
attempt 2  status: PASSED
attempt 3  + actual   '8219be86-b22a-4ee9-80e7-24987f8ad071'
           - expected 'a19a7254-e371-4b4e-8104-b085076b441c'   status: FAILED
attempt 4  status: FAILED
attempt 5  status: FAILED
```

### R4. 自建反例（5 例，全部通过）

| 编号 | 覆盖 | 关键取证 |
|---|---|---|
| R2-P1-a | 引用目标栅栏 | 以**应用角色**（`APP_DATABASE_URL`）直连插入 7 种脏行，逐条断言 SQLSTATE **23514**：`ref_kind='TASK'` 且 `task_id IS NULL`；`TASK` 且 `task_id≠ref_id`；`TASK` 且同时带 `artifact_version_id`；`ARTIFACT_VERSION` 且 `artifact_version_id IS NULL`；`ARTIFACT_VERSION` 却带 `task_id`；`ref_revision=-1`；`ordinal=-1`。**同一连接、同一角色随后插入一条合法 TASK 引用成功**（该接续点计数 2→3），证明前 7 条的拒绝来自 CHECK 而非权限。`pg_get_constraintdef` 匹配 `IS NOT NULL`；两个目标外键名为 `fk_project_continuation_point_refs_task` / `..._artifact_version`，`condeferrable=false`、`condeferred=false`。 |
| R2-P1-b | 台账 | 以迁移角色读 `relay_schema_migrations`：恰有 0044、0045 两行，**总行数 45**；`0044_project_continuation_points` 的 `content_sha256` 与仓库文件 SHA-256 **一致**。 |
| R2-P1-c | 0044→0045 升级 | 用缺 0045 的迁移目录夹具建独立临时库 → `ledgerRows = 44`；用**应用角色**插入接续点 + 合法 TASK 引用 + 一条 `ARTIFACT_VERSION`/目标列 NULL 的脏行，**脏行成功落库**，且此时 `project_continuation_point_refs_task_id_fkey.condeferrable = true`（复现第一轮记录）。→ 再应用含 0045 的目录：该库**显式抛错**（`assert.rejects` 通过，未静默改写）。→ 干净库：写入接续点与合法引用后应用 0045，`applied = ['0045_continuation_point_ref_target_guard']`、`ledgerRows = 45`，既有接续点 **1** 行、既有合法引用 **1** 行完整存活，随后新脏行被 23514 拒绝。 |
| R2-P2-1 | 成果版本全链（真实 PG + 真实 HTTP） | `SELECT_ARTIFACT_VERSION(v1)` → 捕获 → 立即比较得 `CURRENT`（`current_revision='1'`）→ 同 Artifact 追加 v2 → 比较得 `SUPERSEDED` 且 `current_revision` 仍为 `'1'` → `SELECT_ARTIFACT_VERSION(v2)` → 重新捕获 → 新接续点**同时含 v1（`SUPERSEDED`）与 v2（`CURRENT`，`captured_revision='2'`）**。**生产行为完全正确。** |
| R2-P2-3 | 引用归属复核 + 误伤检查 | 以**应用角色**（持有 `INSERT`，不需要迁移角色）向 A 项目的接续点写入 B 项目的 Task 引用与 B 项目的成果版本引用（PK/FK/CHECK 全部合法，**这是可达路径**）→ 比较响应中两条均为 `MISSING`、`current_revision = null`；同一响应里 A 项目的 Task 为 `UNCHANGED`（改标题后为 `REVISED` / `current_revision='1'`）、A 项目的成果版本为 `CURRENT`；`interpretation === null`；跨 Workspace 读比较端点仍 **404 `RESOURCE_NOT_FOUND`**。 |

### R5. 逐条待复验项判定

| 项 | 声明 | 我的判定 | 依据 |
|---|---|---|---|
| **P1** `ck_..._refs_target` NULL 不安全 | 由 0045 修正 | **已真实修复** | R2-P1-a：7 种脏行全部 23514；约束定义含 `IS NOT NULL`；两个目标外键已统一为即时检查（原 `task_id` 的 DEFERRABLE 已消除）。0045 是纯追加：只 `DROP CONSTRAINT` + `ADD CONSTRAINT`，不触碰其它表/列/索引。 |
| **P1 附** 0044 未被改写 | 以 0045 追加修正 | **未被语义改写，但文件被追加了注释** | `0044_project_continuation_points.sql:22-24` 新增 2 行注释，指向 0045 并要求"不要按这里的旧形态重写历史迁移"；DDL 语义未变——R2-P1-c 的"只到 0044"独立库复现了第一轮记录的同一行为（脏行落库 + `task_id` 外键 DEFERRABLE）。台账 45 行、0044 摘要与文件一致（R2-P1-b）。**注意**：全新库中该摘要等式由构造保证，真正有判别力的是"只到 0044"的独立库证据。 |
| **0044/0045 可升级** | 统一为即时检查 | **通过** | R2-P1-c：干净库可追加升级，既有点与合法引用存活；已存在的 TASK 引用在非 deferrable FK 下仍合法。**附带风险**：若某环境在 0044 期间已存在脏行，0045 会因 `ADD CONSTRAINT` 校验既有行而失败（我实测为显式失败，不静默改写）。0044 期间**应用角色本身就能写脏行**，因此"脏行只可能来自运维脚本"的假设不成立；该兼容风险未写进契约（见 R7-4）。 |
| **P2-1** `ARTIFACT_VERSION` / `CURRENT`+`SUPERSEDED` 覆盖 | 已补集成覆盖 | **未修好（P1 级）** | 正式测试 `project-continuation.integration.test.ts:190-199` 断言写错方向且不稳定，5 次运行 4 红。根因：`state_artifact_refs` 只有插入、没有取消选用（`state-commands.ts:168-197`），重新选用 v2 后 State 仍同时含 v1 与 v2，捕获会把**两条** `ARTIFACT_VERSION` 引用写入新接续点；测试用 `changes.find(ref => ref.ref_kind === 'ARTIFACT_VERSION')` 取 ordinal 最小的一条，而 ordinal 来自 `listProjectStateArtifactRefs` 的 `order by artifact_version_id`（uuid 随机）→ 命中 v1 还是 v2 约各 50%。**生产行为经 R2-P2-1 证明正确**，错的只是测试。 |
| **P2-2** `MISSING` 口径 + `DEFERRABLE` 不对称 | 0045 已统一为即时检查，契约措辞已改 | **部分修复** | 代码侧完成（见 R2-P1-a）。契约 §10.51 已写明 `MISSING`"主要覆盖跨项目或被迁移角色构造的脏引用，**不是常规业务路径**"，并禁止据此宣称已具备"来源删除后的恢复"。**workbench-design §15 未同步**：仍写"捕获来源缺失时显示'当前不可见'"，未写不可达原因；第一轮放行条件第 3 条要求的"本片纳入集合 = 未终结 Task ＋ State 当前选用成果版本"只写进了 §10.51，§15 未写；§15 末行仍写"独立验收未做"，与已存在的本记录矛盾。 |
| **P2-3** 逐条复核引用归属 | 已在 `resolveRefChanges` 内复核 | **已修且无误伤** | `project-continuation-points.ts:220`（Task）与 `:233`（成果版本）均比较 `project_id`，不匹配按 `MISSING` / `current_revision=null` 返回。R2-P2-3 用**应用角色**（可达路径）构造跨项目引用并验证为 `MISSING`，同时验证本项目引用仍为 `UNCHANGED` / `REVISED` / `CURRENT`，未被一律打成 `MISSING`。 |
| **P3-1** 冻结后无退出路径 | 不修（规格缺口） | **未修，且未记录** | 第一轮 F-5 的行为描述仍成立：回执恒为 `COMMAND_NOT_FOUND` 时，本会话无法再保存新接续点。workbench §15 仍只写"只提供「查询原命令回执」"，未把它登记为本片已知限制。 |
| **P3-2** `relayClient.ts` 换行损坏 | 已修 | **已修** | `apps/workbench/src/api/relayClient.ts:1285-1288` 签名与 `return` 已分行。 |

### R6. 回归检查

- **端点形状、状态码、幂等重放、跨作用域 404**：官方 `project-continuation` 的前两个用例在 5 次运行中**每次都通过**（唯一失败的是第 3 例）；P1 修复只改 CHECK 与外键定义，未触及 `routes.ts` 的路径、`domain-schemas.ts` 的响应 schema 或状态码。我另行复验跨 Workspace 读比较端点仍 404（R2-P2-3）。P2-1 的失败不涉及端点契约。
- **API 静态与单元**：`typecheck` 通过；`136 / 136 pass`。
- **Workbench typecheck 归属核实（结论：声明成立）**：失败，共 **10** 个错误——`src/components/AppShell.tsx` 3 个（`TS6133` 未使用 `ChevronDown` / `Clock` / `secondaryNavigation`），`src/views/CollaborationView.tsx` 7 个（6 个 `TS6133` 未使用导入/变量，`TS2552 Cannot find name 'RunProgress'` 1 个）。**落在 N01 文件（`src/api/relayClient.ts`、`src/components/ContinuationPointPanel.tsx`、`src/views/ProjectResumeView.tsx`、`tests/continuationPoint.spec.ts`、`tests/projectResumeLive.spec.ts`）里的错误数为 0。** `apps/workbench/tsconfig.json` 的 `include` 覆盖 `src/**` 与 `tests/**`，且 `tsc --noEmit` 报出全部错误，因此这是全量判定而非抽样。**据此不构成 N01 回归**；我未触碰这两个他人文件。
- **前端 N01 规格**：`continuationPoint.spec.ts` 3/3、`projectResumeLive.spec.ts` 3/3，与第一轮一致。

### R7. 仍存在的问题

1. **（P1）`apps/api/test/integration/project-continuation.integration.test.ts:190-199` 断言错误且随机失败**。5 次运行 4 红。用户影响：正式回归网对"成果版本引用"这条 N01 最核心的路径**实际不存在保护**，且按单次运行判定会随机变红。修复验收要求：改为按 `ref_id` 定位——`v1 → SUPERSEDED`、`current_revision='1'`、`note` 含 v2；重新选用后新接续点 `v2 → CURRENT`、`captured_revision='2'`，并同时断言 `v1` 在新接续点中仍为 `SUPERSEDED`（可另断言 `ref_count = 3`）。**至少连续 3 次运行全绿**才算修好；只跑一次不算。
2. **（P2）`docs/frontend/workbench-design.md` §15 未按第一轮放行条件第 3 条更新**：缺"本片纳入集合"、缺 `MISSING` 不可达说明、末行仍称"独立验收未做"。
3. **（P2）验证数字与实测不符**：`docs/api/http-command-contract.md` §10.51"真实 PG/HTTP 集成 4 项"与 `CODEX_NEXT_STEP.md` 2026-09-29 段落的"4/4"均为单次通过运行的记录，与我 4/5 失败的实测冲突。修复后须重跑并更正（本轮按约束未改 `CODEX_NEXT_STEP.md`）。
4. **（P3）0045 的兼容风险未记录**：若某环境在 0044 期间已有脏行，`ADD CONSTRAINT` 校验既有行会使迁移失败（我实测为显式失败，非静默损坏）。契约 §10.51 应写明该语义；由于 0044 期间应用角色即可写脏行，这不是纯理论风险。
5. **（P3）P3-1 死路未登记为已知限制**（见 R5）。

### R8. 未验证项与限制

- **未在真实活动 Run（RUNNING/worker 在途）下取证**（第一轮同项，仍未验）。
- **未做真实 Windows 人工路径**：无 Tauri 宿主、窗口或 WebView2 取证；`ContinuationPointPanel` 复用的既有类名在 `styles.css`（他人未提交改动）中的实际表现未核对。
- **未跑全量 workbench vitest**：本轮只跑 N01 的两个 spec 文件；第一轮记录的全量偶发红（`run-events` / `tasks`）属他人未提交改动范围。
- **未验证真实 Provider / 模型外呼**：本片不调用模型，`interpretation` 恒 `null`，无相关风险。
- **未验证浏览器 `maxlength` 截断**（第一轮同项，jsdom 不经过 UA 截断）。
- **并发编辑导致的不可重复性**：`assist-runner.ts` 的编译错误使部分运行无法到达测试阶段；我的所有结论只对各次运行时的文件内容成立。若要给出可复现的最终判定，应在他人停止编辑后重跑 R3 全表。
- **0044 摘要等式的判别力有限**：在全新库中台账摘要必然等于当前文件摘要；"0044 未被实质改写"的实质证据是"只到 0044"的独立库复现了第一轮的 NULL 不安全行为与 DEFERRABLE 外键（R2-P1-c）。
- `listProjectContinuationPoints` 的 N+1、`MAX_REFS=200` / `MAX_LIST=50` 上限、Decision/Rule/Knowledge 未纳入捕获（第一轮同项，仍未验 / 仍为已收敛子集）。

### R9. 放行判定

**CHANGES_REQUESTED。** 修复以下两项并复跑 R3 全表后可再次提交复验：

1. 按 R7-1 更正 `project-continuation.integration.test.ts` 第 3 例的断言（按 `ref_id` 定位，不依赖 `ref_kind` 的首条命中），连续 3 次运行全绿。
2. 按 R7-2 / R7-3 更新 `workbench-design.md` §15、契约 §10.51 的验证数字与 `CODEX_NEXT_STEP.md`，并按 R7-4 补记 0045 的兼容风险。

R7-4、R7-5 与 R8 各项不阻塞放行，但须随修复一并记录。

工程通过、Windows 体验与使用收益分别报告：本小节同样**只覆盖工程**。数据库层 P1 已取得真实 PG 证据；真实 Windows 人工路径与 PV08"隔日返回能否正确指出关键变化"的体验记录**仍未运行**。

**本结论不放行，不解除 N01 对 N02 的依赖，不自动授权 N02，不改变原 V1 目标。**
