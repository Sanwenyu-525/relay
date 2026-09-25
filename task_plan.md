# P00 研究计划（历史快照）

角色：历史研究计划，不再维护项目当前状态。当前阶段、缺口和下一步只看 [CODEX_NEXT_STEP](CODEX_NEXT_STEP.md)。下文 complete/in_progress/pending 均为当时研究范围，不能用于判断现在是否可以开工。

2026-09-19 接续状态：本轮仅评审 TypeScript-first 并同步文档，不继续编码或运行实验。当前推荐与下一轮验证出口见 [ADR-006](docs/decisions/ADR-006-typescript-first.md)和[测试计划](docs/testing/verification-plan.md#6-typescript-first-冻结前-spike)。下文为此前 Rust/Pi/LangGraph 研究计划及其状态，新组合未据此标记完成。

目标：固定六个候选项目源码依据，比较两个组合，运行最小恢复与执行 PoC，并依据证据决定工程入口。

用户追加约束：技术栈性能优先。新增 Pi 与 LangGraph 的本地固定工作量基准，区分无持久化框架开销与磁盘持久化成本；不以模拟模型耗时推断真实模型服务性能。

进一步追加：延迟/吞吐/内存都要，研究 Rust。Java 不再固定前提；增加 Rust 原生 Rig 候选，优先验证低开销执行组合，保留已有 LangGraph 恢复实验成果。

最新澄清：借鉴机制即可，不强制搬入源码或依赖框架。具体代码由 GPT-5.6 Luna 极高（xhigh）实现与修复。

| 阶段 | 状态 | 验收 |
|---|---|---|
| 环境与上游版本 | complete | 提交/许可/源码路径可追溯 |
| 责任边界与组合选择 | complete | 主要与替代候选、机制采用表；生产选型未冻结 |
| 最小 PoC | in_progress | 真实框架、持久恢复、重复/失效/未知结果与完成测试 |
| 工程入口评估与文档同步 | pending | 证据、限制、当前状态一致 |

## 环境问题

- Docker daemon 未运行；不使用 H2/内存测试宣称 PostgreSQL 通过。
- 原 Java 推荐进入重新评估；Rust 工具链存在，生产组合仍需编译与真实数据库验证。
