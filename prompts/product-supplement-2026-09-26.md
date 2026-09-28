# 9 月 26 日补充：人工待处理队列与面向需求的验收

## 授权与依据

2026-09-27 用户授权三个 `gpt-6-sol` 子代理分别执行三日产品补充。本文件覆盖 26 日设计及随后同步到提示词的要求；相邻责任见 [25 日](product-supplement-2026-09-25.md)、[27 日](product-supplement-2026-09-27.md)。工作目录 `D:/Develop/Relay-Agent`。

先读 AGENTS、CODEX_NEXT_STEP、docs/README、contracts/01–04、领域模型、复用策略和 ADR-010。主依据为 [总纲 0.4](../Personal_Workflow_OS_Master_Spec.md#04-ai-并行开发中的注意力与验收依据)、[范围](../docs/requirements/v1-scope.md#ai-并行开发体验补充)、[交互第 11 节](../docs/frontend/workbench-design.md#11-ai-并行开发的注意力与验收体验)、[验证第 11 节](../docs/testing/verification-plan.md#11-ai-并行开发体验验证提案)及 [公共执行映射](README.md#产品补充的执行映射)。先查现有 live 收件箱、Today、Task 和检查/验证 API，不按概念图重新造业务事实。

你不是唯一修改者，不能撤销或覆盖他人已有修改。协调 Agent 维护共享客户端、API 注册、主文档和集成。超出归属的必要修改先给协调 Agent 具体文件与接口方案；不自行改共享文件或占用新 migration 序号。

## 实施责任

1. 将设计逐项映射为已有/此次实现/待定/后置并给证据。覆盖统一待处理、恢复入口、需求验收及组合版本证据；恢复摘要正文由 25 日包负责，本包提供导航和契约配合。
2. 在 TasksView 的独立人工待处理视图及 Today 导航组织跨项目事项，保留 Project/Task/Run/Review 身份、等待原因、下一步和数据完整性。原 `/tasks?tab=inbox` 是未归属项目的 HUMAN/ME 任务，必须保留原语义。相同事项按稳定业务身份去重，正常运行与需要决定区分。分页/查询失败不能隐藏必需待办或显示零风险；Later/Focus 不等于处理完成。
3. 进入原 Review/Run/Task 命令入口逐项处理；无一键批准不同目标，无前端自造状态、暂停或调度。保留并发变更后的刷新与过期提示。优先沿用服务端已有排序；新增排序规则须可解释，不自行发明紧急期限。
4. 在 TaskDetailView 的验收区域补齐“目标/重要行为/必需性/受验对象/检查及人工证据/缺口/下一步”。复用真实 acceptance、CheckPlan、Artifact/Verification/Completion 查询。明确未关联、未运行、ERROR、证据缺失、旧结果不适用与当前有效证据；不将当前计划当作运行结果、不以测试通过数推断完整覆盖，不从分支分别通过推断组合版本通过。
5. 通知投递、积压阈值、自动降低并发及新增执行连接仍需产品策略；列出最小建议交协调 Agent，不为该包启动监控服务或新的调度器。项目理解/注意力改善实验仅列未验证范围，不编造成效。

## 所有权与验证

可修改：`apps/workbench/src/views/TasksView.tsx`、`TodayView.tsx/.css`、`TaskDetailView.tsx`、`LiveTaskSkillFactsView.tsx`，本包新增的专用组件/纯函数/样式和定向测试。不改 ArtifactPanel、ProjectResumeView、KnowledgeView、RunView、relayClient.ts、共享 styles.css、路由和 API 注册；需要这些改动时提交协调 Agent 集成。现有 API 缺字段时提交确切最小读取方案，不假装字段存在。

独占证据文档：`docs/development/product-supplement-2026-09-26.md`；共享交互/API/测试文档变更说明交协调 Agent，不改 CODEX_NEXT_STEP 或原设计历史。

至少验证：两个项目多事项、重复信号、已被其他入口处理、UNKNOWN、Later/Focus 下未解决项可达、分页/失败不假完整、验收条件无检查、检查未运行/出错/过期、不同产物与验收版本不串用、组合证据缺失。React 定向测试及类型检查必跑。涉及事务/数据库的变化必须真实隔离 PG，由协调 Agent 安排共享构建时段；前端 fixture 测试不冒充服务端及 Windows 验收。真实 Provider 保持关闭，不覆盖 release。

交付条目映射、文件、实际测试结果与限制，供协调 Agent 独立复核。只把已实现和已验证的增量写为完成，不宣称 M05 或整体产品验收通过。
