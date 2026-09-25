# Personal Workflow OS：V1 实施契约包

> 2026-09-23 执行接续：业务 Owner、不变量和 A01–D11 保留。技术改造按 [ADR-010](../docs/decisions/ADR-010-agent-stack-react-desktop.md)与 [M01–M07](../prompts/stack-migration.md)推进；LangGraph 仅承载通用编排，不替代本契约的业务状态、审批及外部效果恢复规则。

日期：2026-09-18。状态：Proposed，供对照原始规范并定稿；不是已实现说明。

项目协作入口：[AGENTS.md](../AGENTS.md)。后续设计和实现从该入口读取本契约包。

下游设计：[领域模型与模块边界](../docs/architecture/domain-model.md)、[数据库逻辑模型](../docs/database/logical-model.md)、[技术选型](../docs/architecture/technology-selection.md)、[PostgreSQL 物理设计](../docs/database/physical-design-postgresql.md)、[API 契约](../docs/api/http-command-contract.md)与[首条工程切片](../docs/development/first-human-slice.md)（2026-09-19，Proposed）；取舍见 [ADR-001](../docs/decisions/ADR-001-domain-boundaries.md)及 [ADR-002](../docs/decisions/ADR-002-postgresql-jdbc.md)。用户已确认允许本机 PostgreSQL。下一项为 [TypeScript-first 提案](../docs/decisions/ADR-006-typescript-first.md) 的 P00 验证，通过后再搭工程、V001 及人工闭环。

依据：[完整聊天评审](../architecture-review.md)。三份原始文档已在当前目录取得；产品范围和关键语义对照见 [设计审计](../docs/development/design-audit.md)。本包记录明确的设计选择与验收条件，不将这些选择伪装成既有实现或已接受的历史决策。

## 四份契约

| 文档 | 解决的问题 |
|---|---|
| [01 事实与写入权](01-facts-and-ownership.md) | 谁拥有事实、谁能修改、视图与历史如何保持一致 |
| [02 状态与执行权](02-state-and-execution.md) | Task / Run / Review / Handoff 如何联动，以及暂停、恢复、接管 |
| [03 验证与审批](03-verification-and-approval.md) | 哪些证据可以判定完成，PASS 和批准何时失效 |
| [04 恢复与提交](04-recovery-and-commit.md) | 动作身份、UNKNOWN、文件与数据库边界、幂等完成和安全执行 |

阅读顺序为 01 → 02 → 03 → 04；同一规则只在所属契约定义，其余文档引用。

完整设计导航见[总入口](../README.md)，最终功能范围见[覆盖矩阵](../docs/requirements/v1-scope.md)，执行任务见[23 份编码提示词](../prompts/README.md)。本包不是把人工切片当成最终 V1；三套内置工作台及受控工具仍需按后续阶段交付。

## 本版明确采用的设计

这些是本包的推荐定稿值，可据原始规范调整；不需要为每项先暂停文档工作。

1. 单用户、同机模块化单体、单一业务事务数据库；用户已确认允许本机 PostgreSQL，显式 SQL 与短事务原则保留。当前推荐 TypeScript-first，Rust 保留研究对照，Java/JDBC 为历史候选；完整组合待 Spike 和工程验证。
2. 保留现有 11 个 Run 状态，用持久化控制请求表达“正在暂停/停止”，不先增加状态枚举。
3. 一个 Task 同时至多一个 AI 执行权占有者；一个实际工作目录同时至多一个受系统管理的写执行。跨 Task 也适用。
4. 验证、审批、完成提交分别有明确职责；人工确认结果不转移执行权，接手编辑才触发 Handoff。
5. Artifact 不可变；验证绑定产物、验收契约与证据；权限在动作执行前重新检查。
6. Activity 的关键证据与业务变更持久化，UI 通知可以提交后发送并从数据库补读。
7. Me 可完成无 Project 的个人小事项；AI Assist 在无 Project 时仅作对话建议；Delegate 和项目工具执行必须有唯一 Project 与明确作用域。
8. Task 默认在读取时继承 Project 的 Goal 关联；显式对齐是该关联集合的子集，不复制默认关联。
9. 第一条纵向实现路径限定为受管资料与 Markdown 产物。真实宿主 CLI 的安全配置作为后续里程碑的准入条件，不因名称在白名单就自动启用。

## 实施顺序与验证出口

| 阶段 | 实现切片 | 必须证明 |
|---|---|---|
| A | Project / Task / 不可变 Artifact / 人工完成 | 人可独立推进；重开保留历史且失效当前完成依据 |
| B | 固定顺序 Workflow + Fake Worker + 验证 + 完成提交 | 自动修正、人工验收、重复提交全部可测试；不依赖真实模型 |
| C | 持久化控制请求 + 重启恢复 + 写资源排他 | 在指定崩溃断点恢复，不重复动作或覆盖新执行者 |
| D | 真实模型 + 明确来源的 Context + 最小 Workbench | 运行使用可追溯来源，切换视图不改执行契约 |
| E | 受控 Git / CLI 与更多工作台 | 先通过安全执行准入和共享资源冲突测试，再开放相应能力 |

这是实现批次，不是删除最终 V1 功能清单；Master Spec 第 17 节已明确最终 V1 包含三套 Workbench。

## 评审问题覆盖

| 评审项 | 主契约 | 验收编号 |
|---|---|---|
| R1 工具与进程边界 | 04 | D08–D10 |
| R2 跨任务资源冲突 | 02、04 | B07、D07 |
| R3 停止请求持久化 | 02 | B03–B05 |
| R4 验收版本绑定 | 03 | C01–C04 |
| R5 验证证据范围 | 03 | C05–C07 |
| R6 恢复与业务提交 | 04 | D01–D06 |
| R7 Review / Handoff | 02 | B02、B05 |
| R8 Rule 强度 | 01、03 | A04、C07 |
| R9 Workbench 切换 | 01 | A05 |
| R10 State 事实所有权 | 01 | A01–A03 |
| R11 Context 证据重建 | 01、03 | A06、C08 |
| R12 Today 的事实与投影 | 01 | A07 |
| R13 Goal / Inbox / Memory | 01 | A08–A09 |
| R14 V1 范围 | 本索引 | 按 A–E 阶段出口验收 |

## 工程阶段仍需核对的事项

- 原架构中的实体、字段、状态与命令名称；本包名称是逻辑契约，不强制一概新建表或类。
- 数据库与事务框架是否能在同一事务中调用各模块写入口。
- 原架构允许无 Project 的 Inbox；当前契约进一步允许其人工完成，属于待确认细化。三套工作台已由产品总纲明确纳入 V1。
- 本地执行采用受信宿主模式还是实际隔离环境；在确定前，第一条实现路径不启用宿主代码执行。
- 当前是否已有 API。未取得现有接口，不能断言兼容性；Breaking Change：待与实际 API 对照。本包不发布新接口版本。

本次交付只有文档，没有运行时实现；验收编号是待实现的测试规格，不是已通过的自动化测试。文档影响范围为本契约包与评审索引，未修改漫剧项目的需求、架构或版本状态。
