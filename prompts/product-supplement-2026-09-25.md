# 9 月 25 日补充：目标托管、成果共创与变化守护

## 授权与执行约定

2026-09-28 接续：本包初轮实现已经交付。用户随后确认的[锁定与影响检查规则](../docs/frontend/workbench-design.md#101-已确认的锁定与影响检查规则)取代下文对应待定产品选项；本轮讨论没有授权重新执行本包或新增代码。后续实施先补稳定块身份、版本/引用和候选命令契约，并按[新增验收规格](../docs/testing/verification-plan.md#13-锁定影响检查与提醒的已确认规则验收)验证。

2026-09-27 用户要求为 25、26、27 日内容分别编写提示词，并派三个 `gpt-6-sol` 子代理执行。本文件是 25 日的实现工作包；其余两包见 [26 日](product-supplement-2026-09-26.md)、[27 日](product-supplement-2026-09-27.md)。本次授权允许实施已有契约能够确定的产品增量，不表示尚未确定的自动化、锁定和影响传播方案已定稿。

工作目录 `D:/Develop/Relay-Agent`。先读 AGENTS、CODEX_NEXT_STEP、docs/README、contracts/01–04，以及领域模型、复用策略、ADR-010。事实源为 [总纲 0.2](../Personal_Workflow_OS_Master_Spec.md#02-协作形态补充2026-09-25proposed)、[范围补充](../docs/requirements/v1-scope.md#协作形态探索补充)、[交互第 10 节](../docs/frontend/workbench-design.md#10-成果共创与变化守护探索)与测试计划对应条目。逐项核对已有代码，不重做已有闭环。

你不是唯一修改者。保留工作区已有及其他代理的修改，不 reset、checkout、stash、清理或提交他人工作。协调 Agent 统一维护共享主文档、客户端和 API 注册等冲突点。发现超出归属的必要修改先把文件和最小接口方案发给协调 Agent，由其分配或集成。

## 本次责任与产出

1. 建立原设计条目到“已有实现、此次补齐、必要决策、后置”的映射，记录证据及原因。目标托管的当前事实/证据/阻塞/下一步、成果确切版本/来源/差异/修订、变化影响依据都必须有结论，不能只做其中一个按钮就宣布整日完成。
2. 完善现有 ProjectResumeView 的目标、事实来源、查询时间、已确认成果、待处理事项和下一步导航。没有已保存的比较基线仅显示当前快照，不制造“上次以来”。读取失败或分页不完整应如实保留缺口；打开页面不能取得执行权或触发模型。
3. 在现有 ArtifactPanel / ArtifactLineageView 路径补齐确切版本比较、来源检查和人工修订的必要体验。复用现有不可变版本与 CAS 命令；选择旧版本时正文、来源和差异绑定同一版本。保存冲突保稿，响应不明维持原命令核对，旧 PASS 不继承。已有代码已正确覆盖的只回归。
4. 变化影响以显式关系和可核对版本为依据；没有完整下游关系不得声称无影响。保留已完成的主动直接引用查询。后续授权增量按工作台 10.1 区分明确引用与 AI 推测、用户确认范围后才生成候选，按章节/段落保护锁定原文，人工新版本继承锁定，局部冲突只暂停依赖部分。原 Owner、稳定身份和必要持久化契约交协调 Agent 复核，不重新询问已确认选项，不静默实现自动扫描/应用或第二套业务状态。
5. 与 26 日分工：本包拥有恢复摘要和成果操作；26 日拥有统一待处理队列与需求验收视图。通过原 Task/Run/Review 路由互相导航，不复制队列或验收状态。

## 文件归属与验证

可修改：`apps/workbench/src/views/ProjectResumeView.tsx`、`ArtifactLineageView.tsx/.css`、`apps/workbench/src/components/ArtifactPanel.tsx`、本包新增的专用组件/样式/纯函数与定向测试；必要的 `apps/api/src/application/lineage-queries.ts`、`artifact-queries.ts` 先向协调 Agent 说明方案再分配。不改 TaskDetailView、TasksView、TodayView、KnowledgeView、RunView、共享 styles.css、relayClient.ts、API 注册、数据库迁移、构建脚本或发布包。

开发证据写入 `docs/development/product-supplement-2026-09-25.md`，由你独占；共享需求/交互/API/测试文档的建议交协调 Agent 合并。不要更新 CODEX_NEXT_STEP 或覆写原设计历史。API/数据库若确需变化，明确 Breaking Change 和兼容性并先协调文件归属。

执行时已协调的扩展：本包同时拥有 `lineage-repository.ts`、`lineage-queries.ts` 和专用 `artifact-direct-uses.integration.test.ts`，实现已登记直接边的只读反向查询。`lineage-api.ts` 与 `relayClient.ts` 由协调 Agent 集成，接口范围见 [HTTP 契约 10.45](../docs/api/http-command-contract.md#1045-产品补充产物版本的已登记直接引用2026-09-27)。不新增影响传播、权限或持久化状态。

至少验证：无基线、缺来源/部分读取、长正文/同版本/不同版本比较、切换后迟到响应、并发修订保稿、修订后不继承旧验证、只读页面零业务写入。运行相关 React 测试和类型检查，缺后端事实的情形不以 fixture 成绩替代。写共享 dist 或运行真实 PG 前向协调 Agent 申请构建时段；不可启动真实 Provider 或覆盖当前桌面 release。

交付：条目映射、实际修改文件、实际命令与通过/失败数、未实现及待决定项、未覆盖 Windows/真实业务范围。完成开发自检后等待协调 Agent 独立复核和修复指令，不宣称 M04/M05/M06 整体验收通过。
