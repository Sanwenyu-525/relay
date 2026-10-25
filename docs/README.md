# 文档入口

角色：全项目文档路由；只定位事实源，不承载业务规则、实时进度或验收成绩。

## 0. 最小阅读路径

1. 开工：[AGENTS](../AGENTS.md) → [当前进度](../CODEX_NEXT_STEP.md)。
2. 涉及实现/验收：在[验收简表](testing/overall-acceptance-2026-09-28.md#当前功能验收表)搜索功能，只读对应详情。
3. 根据任务选择下表的专题 README，再经主文档章节路由进入正文分册；读取相关公共契约及跨章依赖。
4. 仅在结论冲突、排查根因或研究机制时进入历史/研究。任务书存在不等于已授权执行；Accepted 不等于已实现/已验收。

## 1. 唯一事实源

| 本次任务 | 进入哪里 | 拥有什么 |
|---|---|---|
| 产品是什么、需求范围、后续方向 | [需求路由](requirements/README.md) | 产品总纲、V1 范围与后续路线 |
| 业务不变量、执行权、完成与恢复 | [契约包](../contracts/README.md) | 事实 Owner、状态、验证、审批与恢复约束 |
| 模块责任、Runtime、工具与 Context | [架构路由](architecture/README.md) | 实现边界、依赖和专题设计 |
| 为什么选择、被什么替代 | [决策路由](decisions/README.md) | ADR 状态与取舍 |
| API 参数、错误、幂等与查询 | [API 路由](api/README.md) | HTTP/应用命令与模块接口 |
| 表、约束、索引与迁移 | [数据库路由](database/README.md) | 逻辑关系、物理设计、兼容和恢复风险 |
| 页面、业务交互、视觉与 token | [前端路由](frontend/README.md) | 交互、组件外观与数值各自的唯一来源 |
| 测试场景、实际结果与证据限制 | [测试路由](testing/README.md) | 规格、当前验收和历史证据分开 |
| 启动、配置、安装与本机工具 | [部署路由](deployment/README.md) | 工程使用与运维入口 |
| 故障根因、历史开发经过 | [开发记录路由](development/README.md) | 设计原因与历史，不维护当前阶段 |
| 成熟机制和上游证据 | [研究路由](research/README.md) | 来源、实验及其局限 |
| 交给编码 Agent 的任务书 | [prompts](../prompts/README.md) | 执行输入，不能代替当前指令与事实源 |
| 按功能找代码/规格/测试 | [功能地图](feature-map/README.md) | 资料关联，不能代替业务验收 |

代码描述实际实现；契约描述目标约束；ADR 记录取舍；验收限定已证实范围。冲突时检查具体版本与范围，不按日期先后自动裁决，不为迎合文档修改正确代码。

## 2. 文档角色、状态与来源

见[维护规则 §2](documentation-maintenance.md#2-文档角色状态与来源)。

## 3. 决策与历史

当前 ADR 从[决策路由](decisions/README.md)进入；历史角色与保留规则见[维护规则 §3](documentation-maintenance.md#3-决策与历史)。

## 4. 变更规则与验收

见[维护规则 §4](documentation-maintenance.md#4-变更规则与验收)。

## 5. 轻量检查

文档变更运行 node scripts/check-docs.mjs，检查边界见[维护规则 §5](documentation-maintenance.md#5-轻量检查)。不以链接检查代替运行时验收。

## 6. 验收结果与原始输出保留

见[维护规则 §6](documentation-maintenance.md#6-验收结果与原始输出保留)。

## 7. 入口体积与更新边界

见[维护规则 §7](documentation-maintenance.md#7-入口体积与更新边界)与[分层路由 §8](documentation-maintenance.md#8-分层路由与正文维护)。
