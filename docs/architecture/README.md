# 架构与模块责任

角色：专题路由，不复制正文规则或当前实现状态。[返回文档入口](../README.md)。

先读本次适用的契约，再定位对象 Owner、应用用例、事务和恢复边界。

| 要找什么 | 入口 | 读取边界 |
|---|---|---|
| 领域模型 | [打开](domain-model.md) | 模块责任与依赖 |
| 运行时与 Context | [打开](runtime-context.md) | Run、会话、Context、模型及恢复 |
| 技术选型 | [打开](技术选型.md) | 栈、依赖与门槛 |
| 复用策略 | [打开](复用策略.md) | 研究与复用原则 |
| 工具适配 | [打开](tool-adapters.md) | 权限、外部动作与核对 |
| Agent 提示词 | [打开](agent-prompt-design.md) | 产品运行时路由与源码 Owner |
| 扩展与 Skill | [打开](relay-skills.md) | 扩展协议及其状态 |
| 信息与计划 | [打开](information-planning.md) | 共享知识与计划边界 |
| 浏览器 | [打开](browser-automation-v1.md) | 宿主、Chrome 与页面所有权 |
| Windows 电脑 | [打开](computer-plugin-v1.md) | 桌面运行时与输入边界 |
| 电脑 V2 审查 | [打开](computer-plugin-v2-migration-audit.md) | 迁移候选与缺口，不自动替代 V1 |
| ADR | [打开](../decisions/README.md) | 选择依据及替代关系 |

查到相关章节后读取必要的公共规则与上下游约束；历史日期、Accepted 与测试通过均不能自动扩展到当前源码。
