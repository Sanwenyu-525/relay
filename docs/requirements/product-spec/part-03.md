# 产品总纲：分册 03

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../../../Personal_Workflow_OS_Master_Spec.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

# 90. Knowledge Page

V1：

```text
All
Project
Source
Recent
```

支持：

- Add
- Search
- View
- Bind to Project
- Use in Context

2026-09-27 阅读目标补充：View 包含可读的完整受管正文、来源与版本，而不只是摘录和 ID；笔记修订产生新版本，历史引用不静默切到最新内容。用户无需先向 AI 提问就能访问已有知识。项目导读可围绕目标、核心流程、关键决定、验收要求和经验组织已有引用，其组织方式仍 Proposed，不复制一套项目状态。页面流程与异常状态统一见[工作台第 12 节](../../frontend/workbench-design/part-03.md#12-人和-ai-共用的知识库体验)，不在本节另定路由或存储字段。

---

# 91. Artifact Page

不设一级导航。

入口：

```text
Project → Artifacts
Task → Result
Run → Artifact
```

支持：

- Open
- Export
- Promote to Knowledge
- Re-run
- View Lineage

---

# 92. Activity Page

Timeline + Filters。

展示人 / AI / System 行为。

---

# 93. Review Inbox Page

集中所有：

- Approval
- HUMAN Verify
- State Change
- Workbench Change
- Repeated Failure

---

# 94. Connections

V1：

```text
Files
Git
Terminal
Web
```

未来：

```text
GitHub
Calendar
Mail
Drive
MCP
```

---

# 95. Settings

V1：

```text
Profile
AI Provider
Permission
Local Runtime
Personalization (basic)
Memory (basic)
```

---

# 96. Desktop / Mobile

长期定位：

```text
Desktop = Work Surface
Mobile = Control Surface
```

Mobile 主要：

- Today
- Next Action
- Quick Capture
- Chat
- Approval
- Notification
- Review

不复制完整 Desktop。

---

# 97. Onboarding

第一次只问：

```text
Project Name
What are you trying to achieve?
Import anything? (optional)
```

不要先配置：

- MCP
- Workflow
- 多模型
- Personality
- 复杂偏好

---

# 98. First Value Moment

创建 Project 后：

AI 建议：

- Initial State
- Milestones
- Next Action
- Workbench

用户 Apply。

---

# 99. Golden Path 1：继续 Project

```text
Today
→ Project
→ Project State
→ Next Action
```

---

# 100. Golden Path 2：Me

```text
Task
→ Me
→ Work
→ Result
→ Complete
→ Update Project State
```

---

# 101. Golden Path 3：AI Assist

```text
Task
→ AI Assist
→ AI Panel with Task Context
→ Human + AI
→ User Complete
→ Update Project State
```

---

# 102. Golden Path 4：Delegate AI

```text
Task
→ Delegate AI
→ Context Build
→ Workflow
→ Artifact
→ Verify
→ PASS / RETRY / HUMAN
→ Update Project State
```

---

# 103. Golden Path 5：Handoff

```text
Current Owner
→ Handoff Package
→ New Human / Agent / Workbench
→ Continue
```

---

# 104. Golden Path 6：Review

```text
Agent/System needs decision
→ Review Inbox
→ Accept / Reject / Modify / Later
→ Resume
```

---

# 105. V1 必做

## Product Core

- Personal Workspace
- Goal
- Project
- Project State
- Task
- Next Action
- Today
- Inbox
- Knowledge
- Artifact
- Activity
- Search

## Human + AI

- Me
- AI Assist
- Delegate AI
- Context-aware AI Panel
- Handoff
- Review Inbox

## Agent Runtime

- Context Builder
- Workflow Run
- Verification
- Retry
- Human Approval
- Pause / Resume / Cancel
- Trace
- Artifact Lineage

## Extensibility

- Built-in Workbench
- Project / Task Type Routing
- Rules / Policy Basic
- Tool Gateway
- Files / Git / Terminal / Web
- Local Runtime concept

## Control

- AUTO / ASK / DENY
- Connections
- Settings

---

# 106. V1.5

2026-09-28 规划接续：用户选择后续优先“长期项目协作：恢复上下文、成果共创、知识整理、有限自动推进”。具体推荐批次、最小范围、依赖与未决项统一见[后续路线](../post-v1-roadmap.md)。其中 V1.1 是本轮提出的协作打磨标签，不改变当前 V1 必需范围；N 工作包仍为规划，未授权开发。下方与第 107–108 节保留长期能力目录，不能理解为全部进入下一版或已选定实现。

- Calendar
- Work Session
- Today Auto Planning
- Dynamic Replanning
- Weekly Planning
- Goal Alignment
- Proactive Risk
- Opportunity Detection
- Daily Review
- Weekly Review
- Project Checkpoint
- Project Bootstrap
- GitHub
- Google Calendar
- MCP Client
- Custom Schema Workbench
- Automation Trigger
- Plan Confidence
- Context Inspector

---

# 107. V2

- Adaptive Personalization
- Behavior-feedback Planner
- Preference Learning
- Multi-model / Multi-agent Router
- Agent Performance Routing
- Workflow Learning
- AI-generated Workbench
- Advanced Automation
- Advanced Memory
- Advanced Analytics
- Workflow Builder
- Outbound MCP Server
- Advanced Proactive
- Mobile Control App

---

# 108. V2.x / Long-term

- Workbench Plugin SDK
- Custom Code Component
- Personal / Work Workspace Isolation
- Team Workspace
- Third-party Workbench
- External Agent Shared State
- Personal Agent Infrastructure
- Advanced Tool Routing
- Advanced Checkpoint / Replay

---

# 109. 明确不进入 V1

- Team Collaboration
- Company RBAC
- Slack / Teams Clone
- Jira Clone
- Notion Clone
- IDE Clone
- Email Client Clone
- Agent Marketplace
- MCP Marketplace
- Complex Knowledge Graph
- Universal Browser Automation
- Unlimited Autonomous Agent
- Self-trained Foundation Model
- Self-built General Coding Agent
- Arbitrary Generated Frontend Code
- Large SaaS Connector Catalog
- Complex Multi-model Router
- Full Calendar Optimizer
- Full Workflow Builder

---

# 110. 架构约束

后续 Codex / 开发必须遵守：

1. 不因为“Agent 很酷”而把普通逻辑 Agent 化。
2. 确定性逻辑优先普通代码。
3. V1 优先 Modular Monolith。
4. 不默认微服务。
5. 不默认复杂事件总线。
6. 不默认几十张表。
7. MCP 只是 Adapter。
8. Project State 是核心事实层。
9. Chat History 不是核心事实层。
10. Workflow Worker 不允许自己宣告完成。
11. 所有 Side Effect 经过 Permission。
12. High-risk 必须 Human Approval。
13. Workbench V1 不允许任意代码注入。
14. Context 必须按任务裁剪。
15. Trace 可观测，但不展示私有 CoT。
16. 后续新增 V1 功能必须证明“不加则核心闭环无法成立”。

---

# 111. 简历定位

推荐项目名描述：

**Personal Workflow OS — Stateful Agent Workflow Platform**

可强调：

- TypeScript Backend（当前推荐，实现并验证后才能作为项目经历）
- Stateful Agent Runtime
- Workflow Orchestration
- Context Engineering
- Agent Verification
- Human-in-the-loop
- Artifact Provenance
- Dynamic Workbench
- Tool Gateway
- Local Runtime
- Permission Engine
- Agent Observability
- Durable Workflow
- Handoff

避免只写：

> Spring Boot + Vue + LLM 的任务管理系统。

---

# 112. 潜在毕业论文研究切口

暂不冻结。

## A. Verification

不同 Verification Strategy 对 Agent Task Reliability 的影响。

## B. Context Engineering

不同 Context Selection Strategy 对长期 Project Agent 的效果。

## C. Adaptive Planning

Behavior Feedback 是否提高 Plan Acceptance / Goal Alignment。

## D. Dynamic Routing

基于 Task Type + Agent Historical Performance 的异构 Agent Routing。

## E. Workbench Adaptation

不同 Workbench 是否提升复杂任务可操作性 / 效率。

## F. Proactive Intervention

不同 Intervention Timing / Threshold 对用户接受率和中断成本的影响。

---

# 113. 下一阶段

下一阶段只进入：

```text
Domain Model
→ System Module Architecture
→ Core Data Flow
→ Workbench Architecture
→ Agent Runtime State Machine
→ Context Architecture
→ Tool Gateway
→ Permission Model
```

完成方案讨论后，再进入：

```text
Database
→ API
→ Frontend Route
→ Project Skeleton
→ Development Plan
```

---

# 114. 最终产品主线

Personal Workflow OS 必须围绕两条主线成立。

## 主线 A：长期工作推进

```text
Goal
→ Project State
→ Next Action
→ Human / AI Work
→ Verified Artifact
→ Review / Handoff
→ New Project State
```

## 主线 B：工作形态适配

```text
Project / Task Type
→ Workbench
→ Workflow
→ Tools
→ Rules
```

如果这两条主线成立，产品才真正拥有区别于普通 Todo、Notion、ChatGPT、Codex 和传统 Agent 平台的独立价值。

---

# 115. 产品冻结声明

当前功能讨论阶段的结论：

- 产品主方向已明确。
- V1 核心闭环已明确。
- Workbench 已正式纳入产品路线。
- Handoff / Review Inbox / Artifact Lineage / Rules 已正式纳入 V1。
- Planning / Proactive / Review / Personalization 已明确为后续版本。
- 不再继续无限新增产品模块。
- 后续如有新想法，必须先判断它属于：
  - V1 Critical
  - V1.5 Enhancement
  - V2 Intelligence
  - Long-term Ecosystem
  - Reject
- 当前应正式进入架构阶段。
