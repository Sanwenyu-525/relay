# API 与应用命令

角色：专题路由，不复制正文规则或当前实现状态。[返回文档入口](../README.md)。

改接口前核对所属章节、应用 Owner、命令身份与并发；API 变更注明 Breaking Change 与兼容策略。

| 要找什么 | 入口 | 读取边界 |
|---|---|---|
| HTTP 与命令契约 | [打开](http-command-contract.md) | 原章节路由，按端点/命令进入正文 |
| 模块接口 | [打开](module-api.md) | 模块补充，不复制 HTTP 字段 |
| 领域责任 | [打开](../architecture/domain-model.md) | 协调责任与领域边界 |
| 数据库 | [打开](../database/README.md) | 事务、约束与迁移 |

查到相关章节后读取必要的公共规则与上下游约束；历史日期、Accepted 与测试通过均不能自动扩展到当前源码。
