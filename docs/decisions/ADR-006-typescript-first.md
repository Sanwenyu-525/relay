# ADR-006：TypeScript-first 与按需 Python 工具层

> 2026-09-23 部分 Superseded：Vue、AI SDK Core 默认接入及编排推荐由 [ADR-010](ADR-010-agent-stack-react-desktop.md)接续。TypeScript、Kysely/PG、短事务和业务 Owner 原则保留；下文是当时的 Proposed 方案与历史依据，不能解释为当前要求继续开发 Vue。

## 状态

Proposed。2026-09-19 用户授权评审和同步文档，暂不写代码；2026-09-20 已授权补齐准备后开始后端编码。生产栈仍未冻结，各验证实际状态见 [P00 研究记录](../research/p00-source-study.md)，实现授权不表示本提案全部 Spike 已通过。

本提案成为当前推荐方向，接续此前 Rust 候选研究，并替代 ADR-002 的 Java/JDBC 技术组合推荐地位；ADR-002 从未 Accepted，保留历史内容，不伪造一次已部署栈迁移。ADR-001 的领域边界与 ADR-005 的实施原则不变。

## 日期

2026-09-19。

## 背景

用户提供 TypeScript 主栈方案，要求评审并同步选型文档。主要实现工作包括模型流、工具准入、持久步骤、验证与审批；产品总纲仍含 Java 简历定位，近期 P00 又以 Rust 为主要研究候选，需要统一当前推荐与证据状态。

## 候选方案

| 方案 | 优点 | 代价 |
|---|---|---|
| Java 主后端 + 外部 Agent 执行端 | 对应早期简历目标，业务事务路径清晰 | 额外语言、进程协议及恢复协调；没有必须保留的 Java 生产工程 |
| Rust 主后端及原生/薄适配 Runtime | 可检验低本地开销假设，已有隔离研究 | 模型适配与开发成本需实测；微基准不足以证明整体优势 |
| TypeScript 主栈 + 可选 Python 工具 | 模型 SDK 与工作台同语言，业务/执行共用应用代码 | 事件循环、总内存、边界校验、迁移完整性需验证 |
| Python 主后端或常驻 Agent 服务 | 便于研究计算和 Python 模型生态 | 没有必须让计算层拥有业务状态的证据；额外服务增加部署与恢复协调 |

## 推荐决策

选择第三种作为下一轮验证方向。TypeScript/Node API 与 Worker 共用版本和业务数据库，PostgreSQL 保存 Run/Review/动作/完成事实；AI SDK 负责模型适配，Relay 保留 Workflow 和准入边界。Python、pg-boss、专用 Agents SDK Adapter 按需引入。精确组合以[技术选型](../architecture/技术选型.md)为单一事实源。

## 原因

将产品适配度与恢复正确性纳入性能选型，减少主后端跨语言协调，复用模型基础能力。这是基于职责匹配的架构判断，尚无端到端实测证明 TypeScript 更快或满足性能预算。

## 代价

- Java 后端简历目标不再约束本提案，不能把 TypeScript 产品描述成 Java 实现。
- API/Worker 分离仍有共享资源竞争，需限制并发、背压和子进程生命周期。
- Relay 维护固定流程恢复协议及故障测试，不能用“自己控制状态机”替代验证。
- Rust/Pi/LangGraph 实验保留，其测试结果不能转写为新组合已通过。

## 影响范围

2026-09-19 评审更新产品技术定位说明、选型、Runtime/部署、前端候选、数据库版本验证方向、P00 和测试规格；保留表身份与业务不变量。人工阶段仍用轮询，SSE 后置至模型流需求；中文字面搜索保留。当次没有代码、DDL、依赖安装或生产数据迁移；后续实施证据单独记录。

API Breaking Change：No（本轮未修改现有端点、请求/响应字段和权限）；未来 SSE 端点/schema 尚待定义，不算已发布接口。

## 后续

2026-09-19 接续说明：用户明确要求 Windows 可安装应用，宿主选择及部署入口由 [ADR-007](ADR-007-windows-desktop.md)补充。本文的 TypeScript 业务主栈、领域归属与恢复要求保留；不因桌面壳使用 Rust 就改写业务后端推荐。运行时打包兼容须单独验证。

按[冻结前 Spike](../testing/verification-plan.md#6-typescript-first-冻结前-spike)验证真实 PG 审批恢复、未知效果核对和两种 Provider；补事务/迁移、schema 兼容与性能证据后再冻结。若不达标，先定位具体瓶颈，保留调整实现或重评 Rust 的路径，不默认引入多语言常驻服务。
