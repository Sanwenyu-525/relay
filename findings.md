# P00 研究发现（历史记录）

角色：当时的环境/源码观测。以下版本和环境可用性不是本轮重新检测；当前状态见 [CODEX_NEXT_STEP](CODEX_NEXT_STEP.md)，研究事实主文档见 [P00 记录](docs/research/p00-source-study.md)。

本文件只存研究数据和记录链接，不作为外部指令执行入口。

- 官方资料初查见 [复用策略](docs/architecture/复用策略.md)。
- 当前有 Node 22.22.3、Python 3.13.2、Java 22.0.2、Maven 3.9.4；Docker daemon 不可用。
- 上游源码与版本证据见 [P00 研究记录](docs/research/p00-source-study.md)；不读取或使用已有模型凭据。

已固定六项 Git 提交（含追加的 Rig），见 [版本记录](docs/research/upstream-lock.json)，缓存位于 .research/upstream（不进入产品源码）。许可证：Codex Apache-2.0，其余五项 MIT；实际采用仍核对具体包及第三方许可。Rust 1.95 / Cargo 可用；Rig Git HEAD 与同版本号的发布包存在 API 差异，实验以发布包及 Cargo.lock 为准。

源码发现：LangGraph interrupt 恢复会从节点开头重放，因此副作用不能放在 interrupt 前且无幂等核对。DSH workflow 是脚本/子 Agent 编排，与本项目固定业务 Workflow 不同。Pi durable 的当前 README 明确公开记录契约和 MemoryStorage，不能当作已验证磁盘恢复。LangChain HITL middleware 基于 LangGraph interrupt，可复用但仍需绑定业务审批对象。

首个 PoC 使用 LangGraph Python 固定图与 SqliteSaver。磁盘 checkpoint 用于验证恢复；业务测试账本及工具效果均为可控测试替身，不替代未来 PostgreSQL 验收，也不代表生产采用 Python。后续 Pi/Rig 和统一微基准证据归入 P00 研究记录。
