# A：人工可用的完整闭环

> 当前执行入口为 [M01–M07](stack-migration.md)。本文件保留原 P 阶段业务范围；模型统一 gpt-6-sol / ultra，UI 使用完整 React 迁移路线，技术选择按 ADR-010。不得按旧编号重建已存在工程或跳过当前模块验收。

各段可单独复制；先满足 prompts/README.md 中的依赖。

## P01：V001 与持久化基础

```text
你是负责开发的 Terra，执行 P01，模型配置沿用 prompts/README.md。先读 AGENTS.md、CODEX_NEXT_STEP.md、prompts/README.md、docs/database/logical-model.md、docs/database/physical-design-postgresql.md、docs/development/first-human-slice.md。
源码对照：按公共“本地源码参考要求”读取 .research/upstream/kysely 的事务、Migrator 与相关测试，并核对 experiments/typescript-p00 已记录的 SQL 失败及会话锁限制；确认源码版本与实际依赖一致后再写迁移入口，不机械复制上游或实验 SQL。
前置：核对 P00 验证和生产工程搭建的实际证据，包括输入版本、构建/启动/鉴权与遗留项；前置未满足时报告具体缺项，不用基础数据库实验代替。你负责本段 migration、Repository、测试及受影响文档；你不是唯一开发者，不覆盖他人改动，不修改 apps/workbench 或重建既有工程。
范围：V001、按 P00 选型实现显式 SQL Repository、事务/命令回执基础和 PG 集成测试。实现 Workspace/Project/Goal/Task/验收/人工接受/Artifact/完成凭据/State 必要类型引用/审计。不要在 V001 引用尚未存在的 Run/Verification 表；未来字段在后续 migration 添加。支持共享数据源的一次事务，Repository 不自行提前提交。
将物理设计示例转成完整 DDL；实现真实 PK/FK/CHECK/唯一/延迟外键，应用和迁移角色分开。command_id+scope 唯一并校验 payload hash；不可变历史无 UPDATE/DELETE 权限。提供 Workspace 初始化，不依赖手工改 DB。
使用 P00 选定并验证的 PostgreSQL 大版本，设计中的旧版本 SQL 片段不直接视为可运行 migration。先按人工切片列出纳入 V001 的表/约束及留待后续 migration 的引用，保持逻辑模型中的身份与 Owner；不为未实现阶段一次生成全库。规范化命令摘要保留算法/编码版本，bigint 不转成有损 number，Repository 使用应用传入的同一事务连接。
真实 PG 验证空库迁移/重复启动、并发迁移和历史完整性、延迟 FK 在 COMMIT 失败、跨 Workspace 引用、NULL 约束、完成周期唯一及应用角色权限。加入多 Repository 同事务故障整体回滚、相同命令重放/异 payload 拒绝和大整数往返证据；不靠 Mock DB 或测试角色的超级用户权限掩盖应用角色问题。没有 PG 不能用 H2 冒充通过。
运行相关类型检查、构建、真实数据库测试和 node scripts/check-docs.mjs。交付 migration、Repository、测试、实际命令/退出结果/证据路径；数据库文档说明迁移内容、兼容性和回滚风险，README 维护真实命令，CODEX_NEXT_STEP.md 维护阶段。测试映射只标本段实际覆盖，不将建表通过记为完整 A 阶段验收。既有历史已应用迁移不改写。
本段完成后交回主 Agent，明确 P02 是否具备前置；首批生产后端到 P01 为止，不开发 P02 应用用例、UI 或 Agent，不以未来未实现 API 生成占位实现。
```

## P02：Project、Goal、Task 与 State

```text
执行 P02，前置 P01。读 AGENTS.md、prompts/README.md、contracts/01-facts-and-ownership.md、docs/api/http-command-contract.md、docs/api/module-api.md、docs/architecture/information-planning.md。
范围：Project/Goal/Task/State 应用用例、HTTP DTO、测试。实现创建/读取、INBOX→READY→人工 IN_PROGRESS、依赖检查、展示字段更新、Goal INHERIT/EXPLICIT（含显式空集）与原子解除关联、类型化 State 更新、人工取消。禁止任意 PATCH status/owner 或 State 全对象覆盖。
Me Inbox 可无 Project，Delegate 此阶段未开放；Project Type 阶段词汇独立于工作台。State 组合视图返回依赖版本；revision 与验收版本分开。更新需要 command_id 和预期版本，重复成功返回原回执，异请求同 ID 拒绝。实现相应 Problem Details 与鉴权/作用域。
验证 A01/A02/A08/A09、Goal 并发影响变化、依赖环、跨项目引用和两个客户端版本冲突。新增实际需要的 schema 用新 migration，别改已应用 V001。同步 API schema/需求与测试，保留他人改动；下一任务 P03。
```

## P03：Artifact、人工完成与重开

```text
执行 P03，前置 P02。读 AGENTS.md、prompts/README.md、contracts/03-verification-and-approval.md、contracts/04-recovery-and-commit.md、docs/api/http-command-contract.md、docs/database/physical-design-postgresql.md。
范围：受管 Markdown 存储、Artifact 版本、人工接受、完成/重开事务与测试。先保存完整内容/hash，再登记不可变版本；宿主路径由服务端生成，不接受用户绝对路径。旧版本不覆盖，新版本不继承验收。人工编辑要求 HUMAN 且 IN_PROGRESS；无产物要求允许空集合。
Complete 用一次短事务完成 Task、必要 State delta、HumanAcceptance/CompletionRecord、回执和审计。重开新建 acceptance_revision，保留历史，旧命令重放只返回历史结果。不得伪造 Run 或自动 PASS。
真实 PG 和存储故障验证：并发不同 command 完成一次、同 ID 重放、提交失败整体回滚、内容发布后 DB 失败留下孤儿、证据缺失拒绝完成、重开后旧回执不改变新周期。覆盖 A03、C01/C02 的人工适用部分、D05/D06。暂不自动清理文件。交付运行证据与文档，下一任务 P04/P05。
```

## P04：基础前端工作台

```text
执行 P04，前置 P03。读 AGENTS.md、prompts/README.md、docs/frontend/workbench-design.md、docs/frontend/design-system.md、docs/frontend/design-tokens.json、docs/api/http-command-contract.md。
范围：React 页面壳、Project/Inbox/Task/Artifact 人工路径与 API client。使用既定工具链；前端状态只存 UI 状态，Task 真相来自后端。实现录入→Ready→Start→保存 Markdown 版本→选择版本接受→完成→重开。内容预览禁用危险 HTML，不把草稿当已保存版本。
实现局部 Loading、空态、字段错误、409 差异保留、未知提交结果查回执。同一提交保留 command_id 至确定结果；修改请求才换 ID。revision 按字符串处理，旧查询不覆盖新状态。界面可键盘操作，不用颜色代替状态文字。
按 ADR-007 在真实桌面窗口中对真实 API 验证完整人工路径、重载/重连、重开、无 Project/无产物事项和过期响应；并发冲突用受控测试客户端竞争，不扩展产品多窗口。覆盖窗口标题栏、DPI 与中文输入法。禁止用永久 mock 或仅浏览器页面展示交付。同步前端/运行说明，报告未实现 AI 功能仍禁用。
```
