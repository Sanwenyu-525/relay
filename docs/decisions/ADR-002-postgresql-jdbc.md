# ADR-002：以 PostgreSQL 和显式 JDBC 作为推荐持久化方案

## 状态 / 日期

Superseded（推荐方案层面），2026-09-19，由 Proposed 的 [ADR-006](ADR-006-typescript-first.md)接续；本 ADR 从未 Accepted 或作为生产栈实施。PostgreSQL 部署前提与显式事务原则保留。与 [ADR-001](ADR-001-domain-boundaries.md)互补，不替代其领域边界。

后续约束更新：用户要求性能优先并将 Rust 纳入主要候选。以下保留早期 Java/JDBC/Flyway 推荐的历史依据；它未被接受为生产技术栈，现进入重新评估。PostgreSQL 部署前提与显式事务原则保留，当前候选以[技术选型](../architecture/technology-selection.md)为准，待工程验证后记录最终决策。

## 背景与候选

任务执行权、审批绑定、持久停止和完成提交需要可测试的事务竞争语义。

- SQLite + 显式 SQL：部署更轻；需要单写者协议与 busy 恢复设计。
- PostgreSQL + JPA：关系库能力合适；关键锁与跨聚合提交仍需显式控制，当前没有对象图持久化收益要求。
- PostgreSQL + Spring JDBC：SQL、CAS 与锁范围清晰，代价是维护更多映射代码与本机数据库服务。

## 推荐决策

选择 PostgreSQL 17.x + Spring JDBC + Flyway 作为本轮物理设计基线，配合 Java 21 / Spring Boot 4.1.x。精确补丁与依赖树在实际工程验证后锁定，不宣称已编译或已部署。

## 原因与代价

优先让已有事务和恢复承诺可直接实现、可在真实数据库中验证。接受数据库服务的安装、备份与升级成本，不将单机桌面体验等同于零服务依赖。

若用户要求零服务安装，则重新评估 SQLite，不维持双数据库兼容层；以新 ADR 记录替代关系。迁移成本包括锁 SQL、并发协议、索引和集成测试，不能仅更换 JDBC URL。

## 影响与后续

影响 Repository、应用事务、migration、开发部署及测试；不改变 Task/Run 生命周期、权限范围或前端选型。依据与官方链接统一保存在[技术选型](../architecture/technology-selection.md)，落地方式见[物理设计](../database/physical-design-postgresql.md)。

下一阶段用真实 PostgreSQL 核验 DDL、交叉引用插入、竞争事务和崩溃恢复；冻结状态在 ADR-006 维护，本历史提案不再作为默认开工方案。
