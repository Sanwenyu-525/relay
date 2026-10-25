# Personal Workflow OS — Master Product Specification

> 2026-09-23 接续：用户确认 React 全量迁移与 Windows 桌面交付，并要求按项目现状选栈。技术事实源为 [技术选型](docs/architecture/技术选型.md)及 [ADR-010](docs/decisions/ADR-010-agent-stack-react-desktop.md)；本文原始技术示例不覆盖当前选择。既有业务闭环、范围编号和视觉保留。

> 状态：功能讨论阶段基本完成，本文档作为后续 Codex / 架构设计 / 开发规划的**产品事实源（Product Source of Truth）**。  
> 当前阶段：**尚未冻结数据库、API、具体技术栈实现、表结构、前端组件实现。**  
> 目标：优先满足长期自用价值、产品适配度与性能、Agent Engineering 价值、毕业论文可研究性。  
> 原则：如后续架构设计与本文冲突，应先指出冲突，不应自行修改产品定义。

2026-09-19 技术定位评审注：原目标包含“Java 后端简历价值”。用户本轮要求评审 TypeScript-first 并同步文档，当前推荐不再以 Java 标签约束后端；生产组合仍为 Proposed，见 [ADR-006](docs/decisions/ADR-006-typescript-first.md)。本次调整技术定位，不改变三种工作模式、三套工作台或业务验收范围；本轮不写代码。

2026-09-19 交付形态确认：用户要求 **Windows 可安装应用，有独立窗口和启动入口**。现有工作台设计图用于桌面内容区；框架与安装实现尚未冻结，见 [ADR-007](docs/decisions/ADR-007-windows-desktop.md)及[范围矩阵](docs/requirements/v1-scope.md)。

---

# 0. Executive Summary


<!-- DOC-ROUTER -->

> 本文件现为专题路由。完整正文已按原章节迁入下列分册，原章节标题与锚点保留为跳转入口；不要把路由文件当作完整规格读取，也不要在此追加实现正文。

## 分册导航

先按标题定位；命中后读取对应正文及其必要的公共规则。新内容修改所属分册，新增章节同步本路由；跨章依赖不因拆分而消失。

| 分册 | 章节范围 |
|---|---|
| [分册 01](docs/requirements/product-spec/part-01.md) | 0.1 一句话定义 → 0.14.5 计划推演 |
| [分册 02](docs/requirements/product-spec/part-02.md) | 0.15 聊天目标与计划模式 → 89. Task Detail |
| [分册 03](docs/requirements/product-spec/part-03.md) | 90. Knowledge Page → 115. 产品冻结声明 |

## 原章节路由

以下仅保留兼容锚点，具体规则只在链接的正文维护。

## 0.1 一句话定义

[读取正文](docs/requirements/product-spec/part-01.md#01-一句话定义)

## 0.2 协作形态补充（2026-09-25，Proposed）

[读取正文](docs/requirements/product-spec/part-01.md#02-协作形态补充2026-09-25proposed)

## 0.3 三个核心关键词

[读取正文](docs/requirements/product-spec/part-01.md#03-三个核心关键词)

### Stateful

[读取正文](docs/requirements/product-spec/part-01.md#stateful)

### Delegated

[读取正文](docs/requirements/product-spec/part-01.md#delegated)

### Verified

[读取正文](docs/requirements/product-spec/part-01.md#verified)

## 0.4 AI 并行开发中的注意力与验收依据

[读取正文](docs/requirements/product-spec/part-01.md#04-ai-并行开发中的注意力与验收依据)

## 0.5 文件夹入口与对话直接执行（2026-10-01，产品规则已确认）

[读取正文](docs/requirements/product-spec/part-01.md#05-文件夹入口与对话直接执行2026-10-01产品规则已确认)

### 0.5.1 普通 Agent 的连续工具主流程（2026-10-15，已确认、待重构）

[读取正文](docs/requirements/product-spec/part-01.md#051-普通-agent-的连续工具主流程2026-10-15已确认待重构)

### 0.5.2 本地目录无需手工连接配置（2026-10-18，已确认、已实施）

[读取正文](docs/requirements/product-spec/part-01.md#052-本地目录无需手工连接配置2026-10-18已确认已实施)

## 0.6 Agent 协作行为（2026-10-03，已确认设计）

[读取正文](docs/requirements/product-spec/part-01.md#06-agent-协作行为2026-10-03已确认设计)

## 0.7 会话内可折叠执行计划（2026-10-03，推荐设计）

[读取正文](docs/requirements/product-spec/part-01.md#07-会话内可折叠执行计划2026-10-03推荐设计)

## 0.8 状态驱动与轻量起步

[读取正文](docs/requirements/product-spec/part-01.md#08-状态驱动与轻量起步)

### 0.8.1 自然语言维护项目状态

[读取正文](docs/requirements/product-spec/part-01.md#081-自然语言维护项目状态)

## 0.9 有界多 Agent 与自动会话

[读取正文](docs/requirements/product-spec/part-01.md#09-有界多-agent-与自动会话)

## 0.10 需求驱动的软件协作

[读取正文](docs/requirements/product-spec/part-01.md#010-需求驱动的软件协作)

### 目标与讨论范围

[读取正文](docs/requirements/product-spec/part-01.md#目标与讨论范围)

### 已确认的未来功能

[读取正文](docs/requirements/product-spec/part-01.md#已确认的未来功能)

### 冲突、拒绝与有效事实

[读取正文](docs/requirements/product-spec/part-01.md#冲突拒绝与有效事实)

### 与既有设计的关系

[读取正文](docs/requirements/product-spec/part-01.md#与既有设计的关系)

### 项目事项与外部 Agent 共享任务协作

[读取正文](docs/requirements/product-spec/part-01.md#项目事项与外部-agent-共享任务协作)

## 0.11 会话模式与人设助手（2026-10-05 已确认设计）

[读取正文](docs/requirements/product-spec/part-01.md#011-会话模式与人设助手2026-10-05-已确认设计)

## 0.12 学习模式

[读取正文](docs/requirements/product-spec/part-01.md#012-学习模式)

### 目标与已确认规则

[读取正文](docs/requirements/product-spec/part-01.md#目标与已确认规则)

### 首版边界与责任

[读取正文](docs/requirements/product-spec/part-01.md#首版边界与责任)

## 0.13 内置工作方法与会话控制

[读取正文](docs/requirements/product-spec/part-01.md#013-内置工作方法与会话控制)

## 0.14 验收证据与投入判断

[读取正文](docs/requirements/product-spec/part-01.md#014-验收证据与投入判断)

### 0.14.1 验收缺口视图

[读取正文](docs/requirements/product-spec/part-01.md#0141-验收缺口视图)

### 0.14.2 假设验证与首个价值试验

[读取正文](docs/requirements/product-spec/part-01.md#0142-假设验证与首个价值试验)

### 0.14.3 决定复审

[读取正文](docs/requirements/product-spec/part-01.md#0143-决定复审)

### 0.14.4 有效产出复盘

[读取正文](docs/requirements/product-spec/part-01.md#0144-有效产出复盘)

### 0.14.5 计划推演

[读取正文](docs/requirements/product-spec/part-01.md#0145-计划推演)

## 0.15 聊天目标与计划模式

[读取正文](docs/requirements/product-spec/part-02.md#015-聊天目标与计划模式)

## 0.16 七种 Agent 执行模式与产品能力边界

[读取正文](docs/requirements/product-spec/part-02.md#016-七种-agent-执行模式与产品能力边界)

## 0.17 长期项目协作的差异化体验

[读取正文](docs/requirements/product-spec/part-02.md#017-长期项目协作的差异化体验)

### 0.17.1 成果失效提醒

[读取正文](docs/requirements/product-spec/part-02.md#0171-成果失效提醒)

### 0.17.2 项目接手演练

[读取正文](docs/requirements/product-spec/part-02.md#0172-项目接手演练)

### 0.17.3 决策重审提醒

[读取正文](docs/requirements/product-spec/part-02.md#0173-决策重审提醒)

### 0.17.4 修改前的影响预演

[读取正文](docs/requirements/product-spec/part-02.md#0174-修改前的影响预演)

### 0.17.5 面向用户的成果验收

[读取正文](docs/requirements/product-spec/part-02.md#0175-面向用户的成果验收)

### 0.17.6 围绕待决定事项组织工作

[读取正文](docs/requirements/product-spec/part-02.md#0176-围绕待决定事项组织工作)

### 0.17.7 围绕成果工作的专用工作台

[读取正文](docs/requirements/product-spec/part-02.md#0177-围绕成果工作的专用工作台)

## 0.18 项目级长期 Agent 团队与跨会话协作

[读取正文](docs/requirements/product-spec/part-02.md#018-项目级长期-agent-团队与跨会话协作)

### 0.18.1 成员、会话与项目工作

[读取正文](docs/requirements/product-spec/part-02.md#0181-成员会话与项目工作)

### 0.18.2 与既有闭环及停止条件的关系

[读取正文](docs/requirements/product-spec/part-02.md#0182-与既有闭环及停止条件的关系)

# 1. 产品边界

[读取正文](docs/requirements/product-spec/part-02.md#1-产品边界)

## 1.1 产品不是

[读取正文](docs/requirements/product-spec/part-02.md#11-产品不是)

## 1.2 核心价值

[读取正文](docs/requirements/product-spec/part-02.md#12-核心价值)

# 2. 顶层工作闭环

[读取正文](docs/requirements/product-spec/part-02.md#2-顶层工作闭环)

# 3. Workspace

[读取正文](docs/requirements/product-spec/part-02.md#3-workspace)

## 3.1 定义

[读取正文](docs/requirements/product-spec/part-02.md#31-定义)

## 3.2 V1

[读取正文](docs/requirements/product-spec/part-02.md#32-v1)

## 3.3 长期

[读取正文](docs/requirements/product-spec/part-02.md#33-长期)

## 3.4 Global Today

[读取正文](docs/requirements/product-spec/part-02.md#34-global-today)

# 4. Goal

[读取正文](docs/requirements/product-spec/part-02.md#4-goal)

## 4.1 定义

[读取正文](docs/requirements/product-spec/part-02.md#41-定义)

## 4.2 关系

[读取正文](docs/requirements/product-spec/part-02.md#42-关系)

## 4.3 UI

[读取正文](docs/requirements/product-spec/part-02.md#43-ui)

# 5. Project

[读取正文](docs/requirements/product-spec/part-02.md#5-project)

## 5.1 定义

[读取正文](docs/requirements/product-spec/part-02.md#51-定义)

## 5.2 Project 包含

[读取正文](docs/requirements/product-spec/part-02.md#52-project-包含)

## 5.3 核心原则

[读取正文](docs/requirements/product-spec/part-02.md#53-核心原则)

# 6. Project State

[读取正文](docs/requirements/product-spec/part-02.md#6-project-state)

## 6.1 定义

[读取正文](docs/requirements/product-spec/part-02.md#61-定义)

## 6.2 示例

[读取正文](docs/requirements/product-spec/part-02.md#62-示例)

## 6.3 来源

[读取正文](docs/requirements/product-spec/part-02.md#63-来源)

## 6.4 更新规则

[读取正文](docs/requirements/product-spec/part-02.md#64-更新规则)

### User Update

[读取正文](docs/requirements/product-spec/part-02.md#user-update)

### Task Completion

[读取正文](docs/requirements/product-spec/part-02.md#task-completion)

### AI Suggestion

[读取正文](docs/requirements/product-spec/part-02.md#ai-suggestion)

## 6.5 信息优先级

[读取正文](docs/requirements/product-spec/part-02.md#65-信息优先级)

# 7. Milestone

[读取正文](docs/requirements/product-spec/part-02.md#7-milestone)

# 8. Task

[读取正文](docs/requirements/product-spec/part-02.md#8-task)

## 8.1 定义

[读取正文](docs/requirements/product-spec/part-02.md#81-定义)

## 8.2 Task 核心信息

[读取正文](docs/requirements/product-spec/part-02.md#82-task-核心信息)

## 8.3 Task Status

[读取正文](docs/requirements/product-spec/part-02.md#83-task-status)

## 8.4 Execution Mode

[读取正文](docs/requirements/product-spec/part-02.md#84-execution-mode)

### Me

[读取正文](docs/requirements/product-spec/part-02.md#me)

### AI Assist

[读取正文](docs/requirements/product-spec/part-02.md#ai-assist)

### Delegate AI

[读取正文](docs/requirements/product-spec/part-02.md#delegate-ai)

# 9. Task Dependency

[读取正文](docs/requirements/product-spec/part-02.md#9-task-dependency)

# 10. Work Session

[读取正文](docs/requirements/product-spec/part-02.md#10-work-session)

# 11. Today

[读取正文](docs/requirements/product-spec/part-02.md#11-today)

## 11.1 定义

[读取正文](docs/requirements/product-spec/part-02.md#111-定义)

## 11.2 V1 Today

[读取正文](docs/requirements/product-spec/part-02.md#112-v1-today)

### Today's Focus

[读取正文](docs/requirements/product-spec/part-02.md#todays-focus)

### Next Actions

[读取正文](docs/requirements/product-spec/part-02.md#next-actions)

### AI Working

[读取正文](docs/requirements/product-spec/part-02.md#ai-working)

### Inbox

[读取正文](docs/requirements/product-spec/part-02.md#inbox)

### Insights

[读取正文](docs/requirements/product-spec/part-02.md#insights)

# 12. Planning

[读取正文](docs/requirements/product-spec/part-02.md#12-planning)

## 12.1 Planning 输入

[读取正文](docs/requirements/product-spec/part-02.md#121-planning-输入)

## 12.2 三层 Planning

[读取正文](docs/requirements/product-spec/part-02.md#122-三层-planning)

### Strategic

[读取正文](docs/requirements/product-spec/part-02.md#strategic)

### Tactical

[读取正文](docs/requirements/product-spec/part-02.md#tactical)

### Execution

[读取正文](docs/requirements/product-spec/part-02.md#execution)

## 12.3 Next Action

[读取正文](docs/requirements/product-spec/part-02.md#123-next-action)

## 12.4 LLM 与 Planner 分工

[读取正文](docs/requirements/product-spec/part-02.md#124-llm-与-planner-分工)

## 12.5 Buffer

[读取正文](docs/requirements/product-spec/part-02.md#125-buffer)

## 12.6 Duration Learning

[读取正文](docs/requirements/product-spec/part-02.md#126-duration-learning)

## 12.7 Plan Confidence

[读取正文](docs/requirements/product-spec/part-02.md#127-plan-confidence)

# 13. Replanning

[读取正文](docs/requirements/product-spec/part-02.md#13-replanning)

## 13.1 Scope

[读取正文](docs/requirements/product-spec/part-02.md#131-scope)

## 13.2 目标

[读取正文](docs/requirements/product-spec/part-02.md#132-目标)

## 13.3 Human Override

[读取正文](docs/requirements/product-spec/part-02.md#133-human-override)

# 14. Focus Mode

[读取正文](docs/requirements/product-spec/part-02.md#14-focus-mode)

# 15. Workbench

[读取正文](docs/requirements/product-spec/part-02.md#15-workbench)

## 15.1 定义

[读取正文](docs/requirements/product-spec/part-02.md#151-定义)

# 16. Workbench 分层

[读取正文](docs/requirements/product-spec/part-02.md#16-workbench-分层)

## Project Workbench

[读取正文](docs/requirements/product-spec/part-02.md#project-workbench)

## Task Workbench

[读取正文](docs/requirements/product-spec/part-02.md#task-workbench)

# 17. V1 内置 Workbench

[读取正文](docs/requirements/product-spec/part-02.md#17-v1-内置-workbench)

## General Workbench

[读取正文](docs/requirements/product-spec/part-02.md#general-workbench)

## Research / Thesis Workbench

[读取正文](docs/requirements/product-spec/part-02.md#research-thesis-workbench)

## Development Workbench

[读取正文](docs/requirements/product-spec/part-02.md#development-workbench)

# 18. Workbench Routing

[读取正文](docs/requirements/product-spec/part-02.md#18-workbench-routing)

# 19. Workbench Navigation Injection

[读取正文](docs/requirements/product-spec/part-02.md#19-workbench-navigation-injection)

# 20. Schema-driven UI

[读取正文](docs/requirements/product-spec/part-02.md#20-schema-driven-ui)

## 20.1 AI Workbench Modification

[读取正文](docs/requirements/product-spec/part-02.md#201-ai-workbench-modification)

## 20.2 Relay Skill 设计补充（2026-09-20，Proposed）

[读取正文](docs/requirements/product-spec/part-02.md#202-relay-skill-设计补充2026-09-20proposed)

# 21. Workflow

[读取正文](docs/requirements/product-spec/part-02.md#21-workflow)

## 21.1 定义

[读取正文](docs/requirements/product-spec/part-02.md#211-定义)

## 21.2 V1 Workflow

[读取正文](docs/requirements/product-spec/part-02.md#212-v1-workflow)

# 22. Workflow Node 类型

[读取正文](docs/requirements/product-spec/part-02.md#22-workflow-node-类型)

# 23. Workflow Definition / Version / Run

[读取正文](docs/requirements/product-spec/part-02.md#23-workflow-definition-version-run)

# 24. Workflow Durability

[读取正文](docs/requirements/product-spec/part-02.md#24-workflow-durability)

# 25. Workflow Budget / Stop Condition

[读取正文](docs/requirements/product-spec/part-02.md#25-workflow-budget-stop-condition)

# 26. Retry Semantics

[读取正文](docs/requirements/product-spec/part-02.md#26-retry-semantics)

### Transient Failure

[读取正文](docs/requirements/product-spec/part-02.md#transient-failure)

### Execution Failure

[读取正文](docs/requirements/product-spec/part-02.md#execution-failure)

### Reasoning Failure

[读取正文](docs/requirements/product-spec/part-02.md#reasoning-failure)

### Repeated Failure

[读取正文](docs/requirements/product-spec/part-02.md#repeated-failure)

# 27. Automation

[读取正文](docs/requirements/product-spec/part-02.md#27-automation)

# 28. Verification

[读取正文](docs/requirements/product-spec/part-02.md#28-verification)

## 28.1 核心原则

[读取正文](docs/requirements/product-spec/part-02.md#281-核心原则)

## 28.2 三层

[读取正文](docs/requirements/product-spec/part-02.md#282-三层)

### Hard Check

[读取正文](docs/requirements/product-spec/part-02.md#hard-check)

### Rule Check

[读取正文](docs/requirements/product-spec/part-02.md#rule-check)

### Semantic Judge

[读取正文](docs/requirements/product-spec/part-02.md#semantic-judge)

# 29. Handoff

[读取正文](docs/requirements/product-spec/part-02.md#29-handoff)

## 29.1 定义

[读取正文](docs/requirements/product-spec/part-02.md#291-定义)

## 29.2 Handoff Package

[读取正文](docs/requirements/product-spec/part-02.md#292-handoff-package)

## 29.3 支持

[读取正文](docs/requirements/product-spec/part-02.md#293-支持)

# 30. Review Inbox

[读取正文](docs/requirements/product-spec/part-02.md#30-review-inbox)

# 31. Artifact

[读取正文](docs/requirements/product-spec/part-02.md#31-artifact)

# 32. Artifact Lineage

[读取正文](docs/requirements/product-spec/part-02.md#32-artifact-lineage)

# 33. Knowledge

[读取正文](docs/requirements/product-spec/part-02.md#33-knowledge)

## 33.1 定义

[读取正文](docs/requirements/product-spec/part-02.md#331-定义)

# 34. Memory

[读取正文](docs/requirements/product-spec/part-02.md#34-memory)

# 35. Decision

[读取正文](docs/requirements/product-spec/part-02.md#35-decision)

# 36. Context

[读取正文](docs/requirements/product-spec/part-02.md#36-context)

# 37. Context Priority

[读取正文](docs/requirements/product-spec/part-02.md#37-context-priority)

### Tier 1 Mandatory

[读取正文](docs/requirements/product-spec/part-02.md#tier-1-mandatory)

### Tier 2 Relevant

[读取正文](docs/requirements/product-spec/part-02.md#tier-2-relevant)

### Tier 3 On-demand Retrieval

[读取正文](docs/requirements/product-spec/part-02.md#tier-3-on-demand-retrieval)

### Tier 4

[读取正文](docs/requirements/product-spec/part-02.md#tier-4)

# 38. Context Inspector

[读取正文](docs/requirements/product-spec/part-02.md#38-context-inspector)

# 39. Rules / Policy

[读取正文](docs/requirements/product-spec/part-02.md#39-rules-policy)

# 40. AI Panel

[读取正文](docs/requirements/product-spec/part-02.md#40-ai-panel)

# 41. GUI + Natural Language

[读取正文](docs/requirements/product-spec/part-02.md#41-gui-natural-language)

# 42. Command Bar

[读取正文](docs/requirements/product-spec/part-02.md#42-command-bar)

# 43. Search

[读取正文](docs/requirements/product-spec/part-02.md#43-search)

# 44. Activity / Trace

[读取正文](docs/requirements/product-spec/part-02.md#44-activity-trace)

# 45. Run Detail

[读取正文](docs/requirements/product-spec/part-02.md#45-run-detail)

# 46. Agent 可观测性

[读取正文](docs/requirements/product-spec/part-02.md#46-agent-可观测性)

# 47. Tool Gateway

[读取正文](docs/requirements/product-spec/part-02.md#47-tool-gateway)

# 48. Adapter

[读取正文](docs/requirements/product-spec/part-02.md#48-adapter)

# 49. Capability

[读取正文](docs/requirements/product-spec/part-02.md#49-capability)

# 50. Tool Metadata

[读取正文](docs/requirements/product-spec/part-02.md#50-tool-metadata)

# 51. Risk Model

[读取正文](docs/requirements/product-spec/part-02.md#51-risk-model)

# 52. Permission

[读取正文](docs/requirements/product-spec/part-02.md#52-permission)

# 53. Resource Scope

[读取正文](docs/requirements/product-spec/part-02.md#53-resource-scope)

# 54. Scoped Tool Access

[读取正文](docs/requirements/product-spec/part-02.md#54-scoped-tool-access)

# 55. Tool Fallback

[读取正文](docs/requirements/product-spec/part-02.md#55-tool-fallback)

# 56. Connection Failure

[读取正文](docs/requirements/product-spec/part-02.md#56-connection-failure)

# 57. Human Tool

[读取正文](docs/requirements/product-spec/part-02.md#57-human-tool)

# 58. Local Runtime

[读取正文](docs/requirements/product-spec/part-02.md#58-local-runtime)

# 59. MCP

[读取正文](docs/requirements/product-spec/part-02.md#59-mcp)

## Inbound

[读取正文](docs/requirements/product-spec/part-02.md#inbound)

## Outbound

[读取正文](docs/requirements/product-spec/part-02.md#outbound)

# 60. Proactive Agent

[读取正文](docs/requirements/product-spec/part-02.md#60-proactive-agent)

# 61. Risk Detection

[读取正文](docs/requirements/product-spec/part-02.md#61-risk-detection)

# 62. Opportunity Detection

[读取正文](docs/requirements/product-spec/part-02.md#62-opportunity-detection)

# 63. Intervention Decision

[读取正文](docs/requirements/product-spec/part-02.md#63-intervention-decision)

# 64. Proactive Level

[读取正文](docs/requirements/product-spec/part-02.md#64-proactive-level)

# 65. Notification Budget

[读取正文](docs/requirements/product-spec/part-02.md#65-notification-budget)

# 66. Risk Lifecycle

[读取正文](docs/requirements/product-spec/part-02.md#66-risk-lifecycle)

# 67. Snooze

[读取正文](docs/requirements/product-spec/part-02.md#67-snooze)

# 68. Focus / Attention Model

[读取正文](docs/requirements/product-spec/part-02.md#68-focus-attention-model)

# 69. Intervention Feedback

[读取正文](docs/requirements/product-spec/part-02.md#69-intervention-feedback)

# 70. Intervention Evidence

[读取正文](docs/requirements/product-spec/part-02.md#70-intervention-evidence)

# 71. Review / Analytics

[读取正文](docs/requirements/product-spec/part-02.md#71-review-analytics)

# 72. Review 层级

[读取正文](docs/requirements/product-spec/part-02.md#72-review-层级)

### Execution Review

[读取正文](docs/requirements/product-spec/part-02.md#execution-review)

### Daily Review

[读取正文](docs/requirements/product-spec/part-02.md#daily-review)

### Weekly Review

[读取正文](docs/requirements/product-spec/part-02.md#weekly-review)

### Monthly Review

[读取正文](docs/requirements/product-spec/part-02.md#monthly-review)

# 73. Gap Analysis

[读取正文](docs/requirements/product-spec/part-02.md#73-gap-analysis)

# 74. Goal Alignment

[读取正文](docs/requirements/product-spec/part-02.md#74-goal-alignment)

# 75. Feedback

[读取正文](docs/requirements/product-spec/part-02.md#75-feedback)

### Explicit

[读取正文](docs/requirements/product-spec/part-02.md#explicit)

### Implicit

[读取正文](docs/requirements/product-spec/part-02.md#implicit)

# 76. Learning Evidence

[读取正文](docs/requirements/product-spec/part-02.md#76-learning-evidence)

# 77. Personalization Review

[读取正文](docs/requirements/product-spec/part-02.md#77-personalization-review)

# 78. Preference Drift

[读取正文](docs/requirements/product-spec/part-02.md#78-preference-drift)

# 79. Agent Evaluation

[读取正文](docs/requirements/product-spec/part-02.md#79-agent-evaluation)

# 80. Workflow Evaluation

[读取正文](docs/requirements/product-spec/part-02.md#80-workflow-evaluation)

# 81. Workflow Learning

[读取正文](docs/requirements/product-spec/part-02.md#81-workflow-learning)

# 82. Human Attention Optimization

[读取正文](docs/requirements/product-spec/part-02.md#82-human-attention-optimization)

# 83. Review Inbox 与 Proactive 区别

[读取正文](docs/requirements/product-spec/part-02.md#83-review-inbox-与-proactive-区别)

# 84. Checkpoint / Time Travel

[读取正文](docs/requirements/product-spec/part-02.md#84-checkpoint-time-travel)

# 85. Project Bootstrap

[读取正文](docs/requirements/product-spec/part-02.md#85-project-bootstrap)

# 86. Information Architecture

[读取正文](docs/requirements/product-spec/part-02.md#86-information-architecture)

# 87. Today UI

[读取正文](docs/requirements/product-spec/part-02.md#87-today-ui)

# 88. Project Detail

[读取正文](docs/requirements/product-spec/part-02.md#88-project-detail)

# 89. Task Detail

[读取正文](docs/requirements/product-spec/part-02.md#89-task-detail)

# 90. Knowledge Page

[读取正文](docs/requirements/product-spec/part-03.md#90-knowledge-page)

# 91. Artifact Page

[读取正文](docs/requirements/product-spec/part-03.md#91-artifact-page)

# 92. Activity Page

[读取正文](docs/requirements/product-spec/part-03.md#92-activity-page)

# 93. Review Inbox Page

[读取正文](docs/requirements/product-spec/part-03.md#93-review-inbox-page)

# 94. Connections

[读取正文](docs/requirements/product-spec/part-03.md#94-connections)

# 95. Settings

[读取正文](docs/requirements/product-spec/part-03.md#95-settings)

# 96. Desktop / Mobile

[读取正文](docs/requirements/product-spec/part-03.md#96-desktop-mobile)

# 97. Onboarding

[读取正文](docs/requirements/product-spec/part-03.md#97-onboarding)

# 98. First Value Moment

[读取正文](docs/requirements/product-spec/part-03.md#98-first-value-moment)

# 99. Golden Path 1：继续 Project

[读取正文](docs/requirements/product-spec/part-03.md#99-golden-path-1继续-project)

# 100. Golden Path 2：Me

[读取正文](docs/requirements/product-spec/part-03.md#100-golden-path-2me)

# 101. Golden Path 3：AI Assist

[读取正文](docs/requirements/product-spec/part-03.md#101-golden-path-3ai-assist)

# 102. Golden Path 4：Delegate AI

[读取正文](docs/requirements/product-spec/part-03.md#102-golden-path-4delegate-ai)

# 103. Golden Path 5：Handoff

[读取正文](docs/requirements/product-spec/part-03.md#103-golden-path-5handoff)

# 104. Golden Path 6：Review

[读取正文](docs/requirements/product-spec/part-03.md#104-golden-path-6review)

# 105. V1 必做

[读取正文](docs/requirements/product-spec/part-03.md#105-v1-必做)

## Product Core

[读取正文](docs/requirements/product-spec/part-03.md#product-core)

## Human + AI

[读取正文](docs/requirements/product-spec/part-03.md#human-ai)

## Agent Runtime

[读取正文](docs/requirements/product-spec/part-03.md#agent-runtime)

## Extensibility

[读取正文](docs/requirements/product-spec/part-03.md#extensibility)

## Control

[读取正文](docs/requirements/product-spec/part-03.md#control)

# 106. V1.5

[读取正文](docs/requirements/product-spec/part-03.md#106-v15)

# 107. V2

[读取正文](docs/requirements/product-spec/part-03.md#107-v2)

# 108. V2.x / Long-term

[读取正文](docs/requirements/product-spec/part-03.md#108-v2x-long-term)

# 109. 明确不进入 V1

[读取正文](docs/requirements/product-spec/part-03.md#109-明确不进入-v1)

# 110. 架构约束

[读取正文](docs/requirements/product-spec/part-03.md#110-架构约束)

# 111. 简历定位

[读取正文](docs/requirements/product-spec/part-03.md#111-简历定位)

# 112. 潜在毕业论文研究切口

[读取正文](docs/requirements/product-spec/part-03.md#112-潜在毕业论文研究切口)

## A. Verification

[读取正文](docs/requirements/product-spec/part-03.md#a-verification)

## B. Context Engineering

[读取正文](docs/requirements/product-spec/part-03.md#b-context-engineering)

## C. Adaptive Planning

[读取正文](docs/requirements/product-spec/part-03.md#c-adaptive-planning)

## D. Dynamic Routing

[读取正文](docs/requirements/product-spec/part-03.md#d-dynamic-routing)

## E. Workbench Adaptation

[读取正文](docs/requirements/product-spec/part-03.md#e-workbench-adaptation)

## F. Proactive Intervention

[读取正文](docs/requirements/product-spec/part-03.md#f-proactive-intervention)

# 113. 下一阶段

[读取正文](docs/requirements/product-spec/part-03.md#113-下一阶段)

# 114. 最终产品主线

[读取正文](docs/requirements/product-spec/part-03.md#114-最终产品主线)

## 主线 A：长期工作推进

[读取正文](docs/requirements/product-spec/part-03.md#主线-a长期工作推进)

## 主线 B：工作形态适配

[读取正文](docs/requirements/product-spec/part-03.md#主线-b工作形态适配)

# 115. 产品冻结声明

[读取正文](docs/requirements/product-spec/part-03.md#115-产品冻结声明)

