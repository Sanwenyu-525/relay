# R01：后端当前完成事实与阶段校验修复

状态：已执行（2026-09-21）。BE-01 与 BE-02 已在 `apps/api` 修复并通过真实 PostgreSQL + HTTP 回归；本记录只证明 R01 后端范围，不续写 P00–P22，也不授权 P05、前端、桌面或全部 37 个验收场景。

执行结果：新增真实 PG+HTTP 反例后，初始修复前 71 项集成测试为 69 通过 / 2 失败；初始修复后 71/71 通过。审查再补两条并发/回滚反例后，主 Agent 使用隔离临时 PostgreSQL 复跑为 73/73 通过，临时集群正常停止并清理。BE-01 保留历史 CompletionRecord/HumanAcceptance/state_completion_refs，查询仅投影 Task 当前 DONE 周期的完成指针，并在重开短事务中按 Task → ProjectState 锁序递增 State revision。BE-02 收紧 `SET_PHASE` 为内置 GENERAL/THESIS/DEVELOPMENT 词汇；未知、跨类型和空白 phase 现在返回 422 `VALIDATION_FAILED`，不写 State、回执或审计。该未发布工程的行为收紧是 Breaking Change；不静默改写已存异常值，人工应读取当前 State revision 后用合法 `SET_PHASE` 命令纠正。

审查后补充（2026-09-21，已由主 Agent 统一复验）：

- P1：非空 `SET_NEXT_ACTION` 现先以 `SELECT … FOR UPDATE` 锁并校验目标 Task 必须属于路径中的 Project，再锁 `project_states`、校验 State revision 并写入。`next_action_task_id = null` 仍只锁 State。该顺序与 Complete/Reopen 一致为 Task → ProjectState，消除原 State → Task 反向等待；真实 PG + HTTP 回归让同一 DONE Task 的 SET_NEXT_ACTION 与 Reopen 在受控临界区并发，只接受正常的 200 或 `REVISION_CONFLICT` 409，不允许 500/`40P01`。
- P2：对 `project_states` revision 更新注入一次性失败，证明 Reopen 的 Task、复制出的新 acceptance/criteria、State revision、回执与审计同一短事务回滚，历史 completion/human acceptance 不变；移除故障后使用同一 `command_id` 重试成功，再次重放不重复写入 acceptance、State、回执或审计。未改写既有 migration。

```text
请在 D:/Develop/Relay-Agent 修复 2026-09-21 验收中的 BE-01 和 BE-02。

先读 AGENTS.md、CODEX_NEXT_STEP.md、docs/testing/frontend-backend-acceptance-2026-09-21.md，
以及 contracts/01-facts-and-ownership.md 的 State/A03、contracts/03 的验收失效、
contracts/04 的完成重放、docs/api/http-command-contract.md、现有 Project Type 阶段定义。
已有数据、未提交改动和历史 migration 不得覆盖。采用最小修复，不搭新平台。

负责范围：apps/api 的 State 查询、阶段校验、必要应用协调与相关测试；同步对应事实源文档。
不改 apps/workbench、不开发模型/Run/桌面、不改既有 0001/0002 migration 内容。

第一步：先在真实 PostgreSQL + HTTP 集成测试复现 BE-01。
创建项目和人工任务，ready/start/complete 后查询 State，再 reopen 并查询 State。
当前错误：Task 已 READY，但旧 completion_id 仍在 completed_highlight_refs 和依赖集合。
在现有 api-artifacts/api-state 测试中加入回归，不用 mock 数据库替代。

第二步：修复当前完成投影。
重点检查 project-repository.ts 的 listProjectStateCompletionRefs、state-queries.ts、
completion-commands.ts。当前适用性至少需要核对 Task 状态、acceptance_revision、
current_completion_id 与所引用 CompletionRecord 的一致性。
历史 CompletionRecord/HumanAcceptance/state_completion_refs 保留，禁止删除历史来让测试通过。
明确 State revision 与 dependency_versions 的失效策略：重开之后，客户端不得复用旧完成视图。
若通过依赖版本而非 State revision 表达变化，必须覆盖相关 Task 并验证消费者能识别；
若更新 State revision，遵守现有 Task→ProjectState 锁序，在同一短事务保证一致性。
不要增加第二套完成状态；查询事实来自现有 Owner。

必测：
1. 初次完成显示一个当前完成依据；重开后当前依据撤下而历史仍可查。
2. 重开后旧完成 command_id 原样重放，只返回历史回执，不恢复当前完成高亮。
3. 新周期再次完成，只显示新周期的当前依据，不累加旧周期为当前完成。
4. 其他 Task 的有效完成不受影响；无 Project 的人工事项仍能完成/重开。
5. 新增协调写入若失败，整笔回滚；并发完成/重开及版本冲突保持原语义。

第三步：处理 BE-02。
当前 SET_PHASE 仅校验字符串，NOT_A_REAL_PHASE 可以被持久化。
复用当前 GENERAL/THESIS/DEVELOPMENT 内置阶段定义，建立最小类型相关校验；
不要建通用注册表、插件框架或开放任意字符串作为“兼容”。
未知值、其他类型的阶段、空白值应返回明确字段错误且不改变 State/回执/审计。
合法值更新、同命令重放、版本冲突仍通过。
不要静默迁移已有异常值；在文档说明识别和人工纠正路径。
HTTP 行为由旧接受变为拒绝，明确 Breaking Change 及未发布阶段的兼容说明。

验证：使用仓库便携 Node 24 跑 API typecheck/build、全部单测和真实 PG 集成测试，
确认临时集群停止且目录清理。不得借用用户业务数据库。
文档：更新 HTTP 实现差异、必要数据/查询说明、当前进度和验收记录；不修改 ADR 接受状态。
运行 node scripts/check-docs.mjs。
最后列出每个 BE 编号是否已修复、实际运行命令/数量、回归证据和剩余风险。
此结果只证明后端范围，不宣布前端、桌面或全部 37 场景通过。
```
