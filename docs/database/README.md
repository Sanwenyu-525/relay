# 数据库与迁移

角色：专题路由，不复制正文规则或当前实现状态。[返回文档入口](../README.md)。

先定位业务关系，再查物理约束与实际 migration。文档 DDL 不等于 migration 已执行。

| 要找什么 | 入口 | 读取边界 |
|---|---|---|
| 逻辑模型 | [打开](logical-model.md) | 实体、关系和引用 |
| PostgreSQL 物理设计 | [打开](physical-design-postgresql.md) | 约束、索引、锁与逐次迁移 |
| 实际 migration | [打开](../../apps/api/migrations) | 以源码核对编号、兼容与部署镜像 |
| 测试规格 | [打开](../testing/verification-plan.md) | 真实数据库、幂等与恢复反例 |

查到相关章节后读取必要的公共规则与上下游约束；历史日期、Accepted 与测试通过均不能自动扩展到当前源码。
