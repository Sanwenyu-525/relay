# Personal Workflow OS — Master Product Specification

> 2026-09-23 接续：用户确认 React 全量迁移与 Windows 桌面交付，并要求按项目现状选栈。技术事实源为 [技术选型](docs/architecture/technology-selection.md)及 [ADR-010](docs/decisions/ADR-010-agent-stack-react-desktop.md)；本文原始技术示例不覆盖当前选择。既有业务闭环、范围编号和视觉保留。

> 状态：功能讨论阶段基本完成，本文档作为后续 Codex / 架构设计 / 开发规划的**产品事实源（Product Source of Truth）**。  
> 当前阶段：**尚未冻结数据库、API、具体技术栈实现、表结构、前端组件实现。**  
> 目标：优先满足长期自用价值、产品适配度与性能、Agent Engineering 价值、毕业论文可研究性。  
> 原则：如后续架构设计与本文冲突，应先指出冲突，不应自行修改产品定义。

2026-09-19 技术定位评审注：原目标包含“Java 后端简历价值”。用户本轮要求评审 TypeScript-first 并同步文档，当前推荐不再以 Java 标签约束后端；生产组合仍为 Proposed，见 [ADR-006](docs/decisions/ADR-006-typescript-first.md)。本次调整技术定位，不改变三种工作模式、三套工作台或业务验收范围；本轮不写代码。

2026-09-19 交付形态确认：用户要求 **Windows 可安装应用，有独立窗口和启动入口**。现有工作台设计图用于桌面内容区；框架与安装实现尚未冻结，见 [ADR-007](docs/decisions/ADR-007-windows-desktop.md)及[范围矩阵](docs/requirements/v1-scope.md)。

---

# 0. Executive Summary

## 0.1 一句话定义

**Personal Workflow OS** 是一个以 **Goal / Project State** 为长期工作状态，以 **Task** 为人机协作与工作分配单位，以 **Workflow + Verification** 为 AI 执行闭环，并可根据不同 Project / Task 类型切换 **Workbench** 的个人 Agent 工作系统。

## 0.2 协作形态补充（2026-09-25，Proposed）

来源：用户提供的 Agent 产品形态讨论及本轮项目评估，并要求补充到文档。此节保存产品探索方向，不代表相关能力已实现、验收通过或已加入当前开发工作包；当前进度仍以 [CODEX_NEXT_STEP](CODEX_NEXT_STEP.md)为准。

建议的产品表达：**围绕真实项目成果，让人与 AI 持续推进、局部修改、可靠交接，并用证据确认完成。** 在既有 Goal / State / Task / Artifact 闭环上，以目标托管为主线、成果共创为主要操作方式、守护机制发现值得处理的变化。

| 方向 | 核心体验 | 需要解决的边界 |
|---|---|---|
| 目标托管 | 用户回来时能看到当前事实、完成证据、阻塞和下一步，并从真实状态接续 | 托管责任须明确结果、证据、可修改范围、人工决定、资源预算及停止条件；维护下一步建议与自动执行下一步是不同权限 |
| 成果共创 | 人与 Agent 操作同一份成果，支持局部调整、差异审查和版本追溯 | 依赖须绑定来源与版本；确定影响、待复核内容和模型推测分开；新版本不能继承旧版本的验证或批准 |
| 守护机制 | 在授权监控范围内发现变化，准备建议，在值得处理时提醒用户 | 监控授权不等于修改授权；需合并重复提醒，未变化或不可行动时保持安静；不能把推测直接写成事实 |

专属任务页面围绕业务对象及其关系组织，例如论文的“论点—证据—章节”，而不只是为聊天生成不同布局。优先探索用户确认的明确引用与版本关联，不预设通用知识图谱或新增运行时。具体关系模型、影响传播规则和写入口仍待设计。

即时工具型界面可作为以上体验的辅助：围绕当前问题展示权重比较、影响范围或版本差异；受控组件只调用既有授权业务入口，生成界面不增加写入权。流程内嵌型 Agent 可复用这套闭环，在确定流程中的必要节点提供判断。实时教练、世界/仿真型 Agent 作为其他产品形态保留认知，不纳入当前 Relay 交付范围。

本方向深化既有定位，不以“长期目标”或“持续运行”本身作为独有能力，也不据此替换现有执行器。优先验证一条真实项目流程；候选场景与交互判据见[成果共创与变化守护](docs/frontend/workbench-design.md#10-成果共创与变化守护探索)，阶段边界见[范围补充](docs/requirements/v1-scope.md#协作形态探索补充)。

## 0.3 三个核心关键词

### Stateful

系统始终知道：

- 这个 Project 为什么存在
- 当前做到哪里
- 已经做了什么
- 哪些 Decision 仍然有效
- 下一步是什么
- 当前有哪些 Risk / Blocker
- 哪些工作由人做、哪些交给 AI

### Delegated

每个 Task 由用户决定：

- **Me**
- **AI Assist**
- **Delegate AI**

系统支持 Human ↔ Agent 之间持续交接，而不是每次重新解释上下文。

### Verified

AI 输出不等于完成。

任何委托任务最终必须进入：

```text
Artifact
→ Verification
→ PASS / RETRY / HUMAN
```

Worker 无权自己宣布任务完成。

## 0.4 AI 并行开发中的注意力与验收依据

2026-09-26 补充。来源：用户提出以下两个问题，希望 Relay 能够解决，并要求将讨论更新到相关文档。问题与产品目标作为本次需求输入；具体交互、接入方式和评价协议仍为 Proposed，不代表已实现、已验收或已调整当前工作包。

1. **注意力分散。** 开发者在一个项目中委托多个 Agent，或同时推进多个项目；等待执行期间不断切换，返回时又要恢复上下文。统一窗口只能减少找入口的成本，仍需解决反复查看、无效打断和重建理解的问题。
2. **验收依据不足。** AI 快速产出代码后，开发者对具体实现的熟悉程度可能下降，难以识别重要场景与遗漏。需要分别补足实现理解和业务要求，不能仅以增加测试数量替代明确“必须保证什么”。

本次产品目标：**让开发者把有限注意力放在关键决定上，并把 AI 的产出变成有依据、可理解、可接手的项目成果。** 这是既有长期项目协作定位的深化；General、Thesis、Development 的通用核心保留，优先建议用 Development 场景验证效果。

建议围绕三项体验形成闭环：

| 体验方向 | 用户应能回答的问题 | 责任边界 |
|---|---|---|
| 统一待处理队列 | 哪些事情现在需要我，为什么需要我，延后会有什么影响？ | 基于既有 Task/Run/Review/控制事实汇总；展示优先级不改变执行权、审批或业务状态 |
| 上下文恢复摘要 | 上次确认了什么，离开后改变了什么，现在如何接手？ | 结论关联来源、时间与版本；事实、建议和未知分开，没有比较基线时不虚构变化 |
| 面向需求的验收视图 | 哪些重要行为已验证，哪些仍缺依据，能否接受当前成果？ | 关联需求、验收条件、变更影响与真实证据；现有测试通过不等于重要要求完整覆盖 |

补充考虑：待验收成果积压可能成为新的瓶颈，应探索与人工处理能力匹配的并发限制；实现与测试可能共享同一个误解，应以事先明确的要求、既有回归和实际运行证据校核；多个任务分别通过不能替代最终组合版本的验证；交付说明应帮助用户持续理解行为、设计原因、影响与限制。上述风险是设计动机，不是本项目已测得的结论，也不承诺自动发现全部缺陷或影响。

外部执行工具的接入需要可信的任务关联、状态、产物版本与验证回执；聊天摘要或模型自报完成不足以确认业务结果。首个候选闭环优先复用一个真实执行入口，再评估扩展，不由此新增多 Agent Router 或大量 Connector。

具体交互由[工作台第 11 节](docs/frontend/workbench-design.md#11-ai-并行开发的注意力与验收体验)维护，分期边界见[范围补充](docs/requirements/v1-scope.md#ai-并行开发体验补充)，候选场景、基线与衡量方法见[验证计划第 11 节](docs/testing/verification-plan.md#11-ai-并行开发体验验证提案)。Agent 数、代码量与测试数量不能单独证明这些产品目标已达成。

---

# 1. 产品边界

## 1.1 产品不是

明确避免做成：

- AI Todo
- Notion Clone
- Jira Clone
- Codex Clone
- IDE Clone
- Email Client Clone
- Agent Marketplace
- MCP Marketplace
- 通用低代码平台
- 万能 Browser Automation
- 自研通用 Coding Agent
- 大而全企业协作平台

## 1.2 核心价值

产品持续回答五个问题：

1. **我当前真正重要的 Goal 是什么？**
2. **各 Project 现在真实处于什么状态？**
3. **下一步最值得推进什么？**
4. **这一步应该我做、AI 辅助、还是交给 AI？**
5. **AI 做完之后，是否真的满足要求？**

---

# 2. 顶层工作闭环

```text
Goal
 ↓
Project State
 ↓
Next Action
 ↓
Task
 ↓
┌──────────────┬──────────────┬──────────────┐
│              │              │
Me          AI Assist      Delegate AI
│              │              │
│              │         Workflow Run
│              │              ↓
│              │          Artifact
│              │              ↓
│              │          Verification
│              │        ↙      ↓      ↘
│              │      PASS   RETRY   HUMAN
│              │         \      |      /
└──────────────┴──────────── Result
                               ↓
                       Update Project State
                               ↓
                          Next Action
```

长期闭环：

```text
Plan
→ Execute
→ Observe
→ Verify
→ Review
→ Learn
→ Replan
```

---

# 3. Workspace

## 3.1 定义

Workspace 是以下内容的边界：

- Project
- Goal
- Memory
- Knowledge
- Tool Connection
- Permission
- Rules
- Context
- Activity

它不是普通文件夹。

## 3.2 V1

只实现：

```text
Personal Workspace
```

## 3.3 长期

支持：

```text
Personal
Work
Team
```

其中：

- Memory 隔离
- Knowledge 隔离
- Tool / Connection 隔离
- Permission 隔离
- Rules 隔离

## 3.4 Global Today

未来多 Workspace 后，可以存在 Global Today。

注意：

```text
Workspace
→ Summary Projection
→ Global Today
```

Global Today 只读取 Workspace 摘要，不把不同 Workspace 全量 Memory / Knowledge 混合进入同一个 Agent Context。

---

# 4. Goal

## 4.1 定义

Goal 是结果（Outcome），不是活动（Activity）。

正确：

```text
拿到 Java 后端实习
完成毕业论文并答辩
Smart Tasks 达到可部署与简历展示水平
```

错误：

```text
学习 Java
写论文
做项目
```

## 4.2 关系

```text
Workspace
 ├── Goals
 └── Projects
       ↕
Goal / Project Many-to-Many
```

一个 Goal 可以由多个 Project 共同推进。

一个 Project 可以服务多个 Goal。

Goal 不跨 Workspace。

## 4.3 UI

Goal 是一级领域概念，但 V1 **不设 Goal 一级导航页面**。

Goal 主要出现在：

- Project
- Today
- Weekly Review
- Goal Alignment
- Planning

---

# 5. Project

## 5.1 定义

Project 是：

> 拥有目标、状态、上下文和生命周期的一组持续工作。

## 5.2 Project 包含

```text
Project
├── Goal
├── Current State
├── Milestone
├── Task
├── Workbench
├── Knowledge
├── Decision
├── Artifact
├── Workflow
├── Activity
├── Rule
└── Conversation
```

## 5.3 核心原则

Project 的核心不是：

```text
Task Folder
```

而是：

```text
Current State
```

---

# 6. Project State

## 6.1 定义

Project State 是当前项目的**机器可读事实状态**。

它应该回答：

- 当前阶段
- 已完成
- 进行中
- 阻塞
- 风险
- 下一步
- 当前关键 Decision
- 当前关键 Artifact

## 6.2 示例

```text
Project: Personal Workflow OS

Phase:
Product Definition

Completed:
- Goal / Project / Task
- Planning
- Workflow
- Verification
- Proactive
- Integration
- Workbench

In Progress:
- Master Spec

Risk:
- Thesis research cut not frozen

Next Action:
- Domain Model + System Architecture
```

## 6.3 来源

Project State 可以由：

1. User Explicit Update
2. Deterministic Task / Workflow Result
3. AI Suggested Update

AI 推断必须和事实区分。

## 6.4 更新规则

### User Update

直接更新事实。

### Task Completion

Task Verification PASS 后，可以更新确定性状态。

### AI Suggestion

例如：

```text
AI suggests:
Phase Product Definition
→ System Design
```

必须：

```text
Accept / Reject
```

V1 不允许 AI 任意重写整个 Project State。

## 6.5 信息优先级

```text
Live Project State
>
Explicit Decision
>
Validated Memory
>
Knowledge
>
Raw Conversation
```

---

# 7. Milestone

Milestone 存在，但不是产品核心。

用途：

- 表示阶段
- 帮助 Progress
- 帮助 Goal Progress
- 帮助 Project Bootstrap

V1 保持轻量。

---

# 8. Task

## 8.1 定义

Task 是：

> 最小可执行、可产生结果、可被验证的工作单位。

## 8.2 Task 核心信息

```text
Title
What
Why
Project
Goal
Input
Expected Result
Acceptance Criteria
Estimated Effort
Execution Mode
Dependency
Status
Result
```

## 8.3 Task Status

用户可见状态保持简单：

```text
Inbox
Ready
In Progress
Waiting
Blocked
Done
Cancelled
```

不要把：

```text
PLANNING
EXECUTING
VERIFYING
RETRYING
```

直接暴露为 Task Status。

这些属于 Workflow Run State。

## 8.4 Execution Mode

V1 用户心智固定为：

```text
Me
AI Assist
Delegate AI
```

### Me

用户自己完成。

### AI Assist

AI 作为 Copilot，打开 Task Context Chat。

### Delegate AI

系统创建 Workflow Run 并完整执行。

---

# 9. Task Dependency

支持 Task 之间依赖：

```text
Task A
→ blocks
Task B
```

主要用于：

- Next Action
- Risk
- Replanning
- Project State

---

# 10. Work Session

Task != Work Session。

Task 表示工作。

Work Session 表示：

> 某个真实时间段执行该 Task。

一个 Task 可以：

- 跨多天
- 多个 Session
- 被中断后继续

完整 Work Session / Calendar 进入 V1.5。

---

# 11. Today

## 11.1 定义

Today 不是：

> 今天到期的任务。

Today 是：

> 系统根据 Goal、Project State、Task、Deadline、Risk 等形成的当前决策层。

## 11.2 V1 Today

包含：

### Today's Focus

一天一个主结果。

例如：

```text
完成 Personal Workflow OS Master Spec
```

不是：

```text
工作 90 分钟
```

### Next Actions

展示：

- Task
- Project
- Estimated Effort
- Execution Mode

操作：

```text
Start
AI Assist
Delegate AI
Later
```

### AI Working

展示当前 Workflow Run：

```text
Running
Verifying
Waiting Approval
```

### Inbox

快速捕获未分类事项。

### Insights

V1 只做轻量：

- 当前高优先级项目
- 可 Delegate Task
- 简单 Deadline 提示

---

# 12. Planning

完整自动 Planning 在 V1.5。

## 12.1 Planning 输入

```text
Goals
Project State
Tasks
Calendar
Deadlines
Dependencies
Available Time
Preferences
Recent Progress
Actual Duration
```

## 12.2 三层 Planning

### Strategic

周 / 月层：

> 哪些 Goal / Project 应获得时间。

### Tactical

Today 层：

> 今天做哪些 Task。

### Execution

Now 层：

> 现在下一步做什么。

## 12.3 Next Action

全局可用：

```text
What should I do now?
```

输出：

- 当前 Next Action
- 为什么
- 预计时间
- Start

## 12.4 LLM 与 Planner 分工

LLM：

- 语义
- Task 分解
- Soft Constraint
- 解释
- 冲突语义分析

Deterministic Planner：

- 时间
- Deadline
- Duration
- Dependency
- Calendar
- Hard Constraint

## 12.5 Buffer

Planner 不允许填满 100% 可用时间。

必须保留 Buffer。

## 12.6 Duration Learning

记录：

```text
Estimated Duration
vs
Actual Duration
```

未来自动修正 Task Estimate Bias。

## 12.7 Plan Confidence

长期可显示：

```text
Plan Confidence
```

它表示排程的不确定性，而不是 LLM 自信分。

必须提供可解释原因。

---

# 13. Replanning

真正的 Agent Planning 价值在 Replanning。

触发：

- Task 提前完成
- Task 超时
- 新增紧急 Task
- Calendar Change
- Deadline Change
- Blocked
- Workflow Failure
- Project Risk Change
- User Request

## 13.1 Scope

```text
LOCAL
TODAY
WEEK
PROJECT
```

## 13.2 目标

Replanning 默认：

> **Minimal Disruption**

不要每次重排整个一天。

## 13.3 Human Override

用户任何时候可：

```text
Not today
Move
Skip
Pin
```

系统只能重新规划，不能强迫用户。

---

# 14. Focus Mode

后续支持。

进入 Focus 后只显示：

- Current Task
- Goal
- Work Session
- Relevant Knowledge
- AI Chat

Focus 结束：

```text
Completed
Partially Completed
Continue Later
Blocked
```

系统记录 Actual Duration 与 Progress。

---

# 15. Workbench

## 15.1 定义

Workbench 是：

> 为某一类工作组合专属页面、导航、工具、Workflow 和 Rules 的工作界面。

Workbench 回答：

```text
How do I work here?
```

Workflow 回答：

```text
How should this work be executed?
```

二者必须区分。

---

# 16. Workbench 分层

可以同时存在：

## Project Workbench

决定整个 Project 的工作结构。

## Task Workbench

针对某类 Task 提供专属工作界面。

---

# 17. V1 内置 Workbench

## General Workbench

```text
Overview
Tasks
Knowledge
Artifacts
Activity
```

## Research / Thesis Workbench

```text
Overview
Research
Sources
Notes
Synthesis
Writing
Experiments
References
Tasks
Knowledge
Artifacts
Activity
```

## Development Workbench

```text
Overview
Requirements
Development
Changes
Build
Tests
Verification
Release
Tasks
Knowledge
Artifacts
Activity
```

---

# 18. Workbench Routing

```text
Project / Task
↓
Type
↓
Workbench Resolver
↓
Workbench
```

例如：

```text
Research Task
→ Research Workbench

Development Task
→ Development Workbench

General Task
→ Task Detail
```

---

# 19. Workbench Navigation Injection

核心导航不能被破坏。

系统核心：

```text
Overview
Tasks
Knowledge
Artifacts
Activity
```

Workbench 可以动态注入：

```text
Research
Writing
Experiments
```

或：

```text
Requirements
Development
Tests
```

---

# 20. Schema-driven UI

V1.5 开始。

AI / User 不直接生成任意 React/Vue 页面。

而是生成：

```text
Page Schema
+
Blocks
```

Block 可能包括：

- Task List
- Table
- Kanban
- Document
- Artifact List
- Knowledge List
- Timeline
- Metrics
- Workflow Run List
- AI Panel

## 20.1 AI Workbench Modification

未来用户可说：

> 给论文加一个实验管理页。

AI 应：

```text
Modify Workbench Configuration
```

而不是：

```text
Modify Application Source Code
```

## 20.2 Relay Skill 设计补充（2026-09-20，Proposed）

本轮建议将可复用能力组织为 Relay Skill：Instructions、Context Profile、Workflow Binding、Capability Requirements、Output Schema、Verification 与可选 UI Blueprint。Skill Pack 是领域组合；Skill 不授予权限、不新增 Runtime、不直接写事实或注入代码。设计与取舍见 [Skill 专题](docs/architecture/relay-skills.md)和 [ADR-008](docs/decisions/ADR-008-declarative-skills.md)。

首个候选 `goal-to-project-blueprint`（“从目标创建项目蓝图”）沿用第 97–98 节：先创建最小 Project，再通过 Assist 建议状态、里程碑、任务与内置 Workbench，用户 Preview / Diff / Apply。V1 只配置三种内置模板及注册页面；Rules 与 Workflow 等执行配置分别确认，不因应用工作台而生效。

分期差异显式保留：原第 106 节已有 Custom Schema Workbench，第 107 节将 AI-generated Workbench 放在 V2；本轮“V1.5 由 Skill 生成 Page Schema”为待确认前移提案，尚未替换原里程碑。完整 Project Bootstrap 不因首个蓝图 Skill 自动前移至 V1。分期主表见[范围矩阵](docs/requirements/v1-scope.md)，不是已交付功能。

2026-09-20 后续确认：用户要求纳入评审后的闭环 Skill 方向。V1 首批包含完善任务定义、继续项目、生成验收方案和项目蓝图；蓝图保留展示旗舰定位，工程先落实前三项。修复、交接和确定性状态更新复用核心闭环，Decision Capture 后续补充，完整目录与边界只在 [Skill 专题第 7 节](docs/architecture/relay-skills.md#7-首批闭环能力与后续目录)维护。验收在 Delegate 前确定；PASS 后仍需完成事务，交接摘要不转移执行权。具体实现仍为设计，未新增已交付能力。

同日统一扩展模型：Relay Pack 组合 Blueprint 模板、Skills、既有 Workflow Recipe、分属各模块的 Profiles、Rules、Artifact/Workbench 模板及 Eval。原 Skill Pack 是同一概念，统一组合边界见[扩展模型](docs/architecture/relay-skills.md#8-可组合扩展模型)。V1 最小第一方 Thesis/Development Pack 随应用发布，选择不等于应用或授权；既有 Proposal 统一审查体验，领域 Owner 负责写入。基础 Eval 与轻量 Sources View 纳入工程，完整 Inspector/Importer/Automation/Project Checkpoint 后置。更新与配置恢复需显式审查，不承诺回滚外部效果，也不自动应用新包。分期细目由范围矩阵维护。

---

# 21. Workflow

## 21.1 定义

Task：

> What

Workflow：

> How

Automation：

> When

## 21.2 V1 Workflow

至少支持：

```text
Plan
Execute
Verify
Retry
Human
Pause
Resume
Cancel
```

默认 Sequential。

后续：

```text
Parallel
Condition
```

---

# 22. Workflow Node 类型

长期：

```text
Action
Agent
Condition
Parallel
Human
Verification
```

原则：

> Deterministic Workflow Skeleton + Agentic Nodes

---

# 23. Workflow Definition / Version / Run

必须概念分离：

```text
Workflow Definition
↓
Version
↓
Workflow Run
```

历史 Run 必须保留对应版本。

---

# 24. Workflow Durability

长期 Agent Workflow 必须支持：

- Pause
- Resume
- Retry
- Cancel
- Recover
- Checkpoint

Workflow 失败不能要求整次重新开始。

---

# 25. Workflow Budget / Stop Condition

后续支持：

```text
Token Budget
Cost Budget
Time Budget
Retry Budget
No-progress Condition
Success Condition
Failure Condition
Human Stop
```

避免无限循环。

---

# 26. Retry Semantics

必须区分：

### Transient Failure

Retry Same。

### Execution Failure

Retry with Failure Feedback。

### Reasoning Failure

Replan。

### Repeated Failure

Switch Agent / Human / Stop。

---

# 27. Automation

完整 Automation V1.5。

Trigger 类型：

```text
Manual
Schedule
Event
State
Agent-detected
```

概念：

```text
Automation
= Trigger + Workflow
```

Proactive Agent 可以被视为：

```text
Smart Trigger + Workflow
```

---

# 28. Verification

## 28.1 核心原则

Worker 只能：

```text
SUBMIT
```

Verifier 决定：

```text
PASS
RETRY
HUMAN
```

## 28.2 三层

### Hard Check

例如：

- File Exists
- Build Pass
- Test Pass
- HTTP Result
- Schema Validation

### Rule Check

依据 Acceptance Criteria / Project Rules。

### Semantic Judge

LLM / Vision 判断质量。

---

# 29. Handoff

## 29.1 定义

Handoff 解决：

> 工作由另一个人 / Agent / Workbench 接管时，如何无损继续。

## 29.2 Handoff Package

```text
Objective
Current State
Completed Work
Decisions
Constraints
Relevant Artifacts
Verification Status
Open Problems
Next Action
Owner
```

## 29.3 支持

```text
Human → Agent
Agent → Human
Agent A → Agent B
Workbench A → Workbench B
Today → Tomorrow
```

---

# 30. Review Inbox

统一处理所有“AI 需要人判断”的事情。

包括：

- Verification HUMAN
- High-risk Tool Approval
- Project State Change
- Workbench Change
- Repeated Agent Failure
- Decision Confirmation
- Permission Request

操作：

```text
Accept
Reject
Modify
Later
```

原则：

> AI 处理可以处理的，真正需要人的判断才进入 Review Inbox。

---

# 31. Artifact

Artifact 是：

> Task / Workflow 的实际产物。

例如：

- Markdown
- PDF
- Code Change
- Test Report
- Research Report
- Image
- Generated Spec

Artifact 不自动等于 Knowledge。

---

# 32. Artifact Lineage

V1 推荐保留基础 Provenance。

```text
Artifact
Produced By
Task
Workflow Run
Agent / Model
Sources
Generated At
Verification
Version
```

版本链：

```text
v1
↓
Verifier Failure
↓
v2
↓
User Modification
↓
v3 PASS
```

---

# 33. Knowledge

## 33.1 定义

Knowledge 是：

> 供人阅读、理解和复用，并供 AI 按授权检索和引用的外部 / 项目知识内容。

2026-09-27 补充：用户明确提出知识库也需要给人使用。本节将原先偏 Agent 的定义补全为人和 AI 共用的知识来源，帮助用户恢复项目理解、查找设计依据和关键要求；有知识页面或可检索内容不代表人的阅读体验已经完成。具体阅读组织仍需按现有能力设计，不改变当前模块进度。

V1：

- File
- Web Link
- Note
- Validated Artifact

按既有 Workspace / Project 作用域组织；项目入口便于理解当前项目，工作空间入口便于查找可复用资料，跨范围使用仍须核对权限。

人的浏览、正文阅读、版本核对和笔记修订不以调用模型为前提。AI 使用同一来源的确切版本及必要片段；Context 快照和检索索引可派生，不另维护一份独立的“AI 知识正文”。仓库中的 README、架构文档、ADR 等优先保留原来源，通过显式引用或有来源的版本快照接入，引用不等于已具备自动同步。

知识库保留重要资料与可复用成果，不自动收录全部聊天和执行日志。AI 整理先形成建议，由用户确认内容及归类后经既有入口保存；收录、读过或认可摘要不等于内容已验证。Knowledge、Memory、Decision、Rule 和 Artifact 仍保留各自语义，知识入口可以聚合导航，不能把它们合并为同一种可任意写入的正文。

目标与分期见[知识库范围补充](docs/requirements/v1-scope.md#人和-ai-共用的知识库补充)，版本与来源责任见[信息设计](docs/architecture/information-planning.md#11-人和-ai-共用知识来源)，人的交互见[工作台第 12 节](docs/frontend/workbench-design.md#12-人和-ai-共用的知识库体验)。知识内容支持寻找验收依据，但不替代实际验证，也不保证需求完整性。

V1 不做：

- Knowledge Graph
- Wiki Clone
- Full Document Suite

---

# 34. Memory

Memory ≠ Chat History。

Memory 是：

> 值得跨 Session 保存的长期信息。

可能类型：

```text
FACT
INFERENCE
PREFERENCE
DECISION
SUGGESTION
```

Scope：

```text
Global
Workspace
Project
Task
```

长期支持：

- Create
- Update
- Supersede
- Forget
- Archive

---

# 35. Decision

Decision 独立于 Memory。

包含：

```text
Decision
Rationale
Alternatives
Status
Supersedes
```

Status：

```text
ACTIVE
SUPERSEDED
```

防止旧 Decision 污染当前 Context。

---

# 36. Context

Context 不是存储。

Context 是：

> 单次 Agent Run 动态装配的信息。

Context Builder 输入：

```text
System Policy
Task
Goal
Project State
Decision
Relevant Memory
Relevant Knowledge
Recent Activity
Tool Results
Applicable Rules
```

---

# 37. Context Priority

建议：

### Tier 1 Mandatory

```text
Task
Goal
Project State
Policy
Rules
```

### Tier 2 Relevant

```text
Recent Decision
Relevant Memory
Dependency
```

### Tier 3 On-demand Retrieval

```text
Knowledge
Old Activity
Previous Artifact
```

### Tier 4

Raw Conversation 仅必要时加入。

---

# 38. Context Inspector

建议加入长期产品。

用户 / 开发者可以查看：

- 本次 Run 使用了哪些 Context
- 使用了哪些 Knowledge
- 使用了哪些 Memory
- 哪些 Decision 生效
- 哪些内容被忽略

用途：

- Trust
- Debug
- Eval
- Context Engineering 论文实验

不展示私有 Chain-of-Thought。

---

# 39. Rules / Policy

V1 加基础版。

层级：

```text
Global
↓
Workspace
↓
Project
↓
Workbench
↓
Task Override
```

示例 Development：

```text
新功能必须新建分支
修改后运行测试
禁止自动 push main
优先复用已有代码
```

示例 Research：

```text
重要事实必须有来源
禁止编造引用
优先原始论文
事实与推断分离
```

Context Builder 只注入 Applicable Rules。

---

# 40. AI Panel

Chat 不做一级导航。

右侧 AI Panel 常驻 / 可收起。

Context Scope：

```text
Current Page
Current Task
Current Project
Workspace
```

AI Panel 用途：

- Explain
- Assist
- Delegate
- Ask Why
- Query State
- Modify Plan
- Explain Verification Failure

---

# 41. GUI + Natural Language

原则：

> 核心操作必须有 GUI，不允许全部依赖聊天。

例如必须有：

```text
Delegate AI
```

不能要求用户只能输入：

```text
“把这个任务交给 AI”
```

---

# 42. Command Bar

`Ctrl + K`

V1：

- Search
- New Task
- New Project
- Open Project
- Start Focus
- Delegate Current Task
- Open Activity

Chat：

```text
Reasoning / Conversation
```

Command Bar：

```text
Navigation / Action
```

---

# 43. Search

V1 搜索：

```text
Project
Task
Knowledge
Artifact
```

可以支持全文 + 基础语义搜索。

不做复杂 AI Search。

---

# 44. Activity / Trace

Activity 回答：

> 人和 AI 最近发生了什么。

事件：

```text
User Created Task
AI Started Run
Knowledge Read
Artifact Generated
Verification Failed
Retry
PASS
Project State Updated
```

筛选：

```text
All
Me
AI
System
```

维度：

```text
Project
Task
Run
```

---

# 45. Run Detail

核心信息：

```text
Run
Task
Status
Workflow Progress
Context Used
Tools
Artifacts
Verification
Retry
Approval
```

操作：

```text
Pause
Resume
Cancel
Retry
Approve
Reject
```

---

# 46. Agent 可观测性

系统应该记录：

- Run
- Step
- Tool Call
- Artifact
- Verification
- Retry
- Approval
- Handoff

不要记录 / 展示私有 CoT。

展示：

- Decision Evidence
- Context Sources
- Tool Results
- Verification Evidence

---

# 47. Tool Gateway

产品绝不依赖大量 MCP。

统一：

```text
Workflow
↓
Capability
↓
Tool Registry
↓
Tool Gateway
↓
Adapter
```

---

# 48. Adapter

允许：

- Native
- Local
- REST / SDK
- MCP
- CLI
- Browser
- Human

Browser 是最后兜底。

---

# 49. Capability

示例：

```text
READ_FILE
WRITE_FILE
SEARCH_WEB
RUN_COMMAND
RUN_TEST
GIT_COMMIT
GIT_PUSH
CREATE_EVENT
SEND_EMAIL
```

Workflow 不关心 Provider。

---

# 50. Tool Metadata

Tool / Capability 必须描述：

```text
Risk
Side Effect
Reversibility
Scope
Permission
Reliability
```

---

# 51. Risk Model

长期：

```text
Risk 0
Read-only

Risk 1
Low-risk reversible

Risk 2
Meaningful but recoverable

Risk 3
External/high-impact

Risk 4
Sensitive/destructive
```

---

# 52. Permission

Task Autonomy != Tool Permission。

V1：

```text
Read Operations      AUTO
Low-risk Write       AUTO
External Action      ASK
Destructive          ASK / DENY
```

长期决策：

```text
Autonomy
+
Risk
+
Tool Policy
+
Reversibility
+
Confidence
→ AUTO / ASK / DENY
```

---

# 53. Resource Scope

Tool 必须限制作用域。

例如：

```text
Project:
Smart Tasks

File Scope:
D:\Develop\smart_tasks/**
```

不能默认访问整个磁盘。

---

# 54. Scoped Tool Access

Agent 不应该看到所有 Tool。

```text
Task
↓
Capability Resolver
↓
Relevant Tools Only
```

例如 Research Agent 不需要 Git Push。

---

# 55. Tool Fallback

同一个 Capability 可以有多个 Provider：

```text
READ_GITHUB_ISSUE

Providers:
REST
MCP
```

系统可根据：

- Reliability
- Latency
- Availability
- Cost

fallback。

---

# 56. Connection Failure

Tool Connection 失效不能只报 Failed。

状态：

```text
WAITING_CONNECTION
```

用户可：

```text
Reconnect
Skip
Use Fallback
```

---

# 57. Human Tool

如果无法自动执行：

```text
Automatic Step
→ Human Step
```

例如：

```text
Please send the document to your advisor.
```

用户确认完成后 Workflow Resume。

---

# 58. Local Runtime

这是产品长期重要差异点。

V1 至少保留概念，并优先支持：

- Files
- Git
- Terminal
- Web

长期：

- Maven
- npm
- Docker
- Local Model
- Local MCP
- ComfyUI
- Coding Agent CLI

---

# 59. MCP

MCP 是 Adapter，不是地基。

长期两种角色：

## Inbound

```text
Workflow OS
→ MCP Client
→ External MCP
```

## Outbound

```text
External Agent
→ Workflow OS MCP Server
```

未来 Workflow OS 可以暴露：

```text
get_today
get_project_state
create_task
run_workflow
search_memory
delegate_task
submit_artifact
```

---

# 60. Proactive Agent

完整能力 V1.5 / V2。

闭环：

```text
Observe
→ Detect
→ Assess
→ Decide
→ Intervene
→ Feedback
→ Learn
```

---

# 61. Risk Detection

首批：

```text
Deadline Risk
Progress Risk
Dependency Risk
Workload Risk
Execution Risk
Goal Alignment Risk
```

风险更多使用：

```text
Deterministic / Rule / Statistical
```

---

# 62. Opportunity Detection

首批：

```text
Delegate Opportunity
Automation Opportunity
Batch Opportunity
Next-step Opportunity
Knowledge Reuse Opportunity
```

机会更多适合：

```text
Agentic / Semantic
```

---

# 63. Intervention Decision

发现风险 != 通知。

至少评估：

```text
Severity
Urgency
Confidence
Actionability
User Cost
Interruption Cost
```

---

# 64. Proactive Level

```text
P0 Silent
P1 Insight
P2 Suggest
P3 Notify
P4 Act
```

P4 必须受 Permission 控制。

---

# 65. Notification Budget

支持：

- Daily Budget
- Cooldown
- Dedup
- Aggregation
- Escalation

例如：

```text
Max interruptive notifications / day
```

同一个 Risk 不重复刷屏。

---

# 66. Risk Lifecycle

```text
Detected
→ Monitoring
→ Escalated
→ Resolved
```

随着 Deadline / Confidence 升高，提高介入等级。

---

# 67. Snooze

支持语义化：

```text
今天不提醒
本周不提醒这个项目
Deadline 剩两天再提醒
只显示在 Today
```

---

# 68. Focus / Attention Model

第一版长期可用简单状态：

```text
FOCUSING
AVAILABLE
BUSY
OFFLINE
```

Focus 时提高通知门槛。

---

# 69. Intervention Feedback

记录：

```text
Accepted
Rejected
Ignored
Snoozed
Modified
```

用于未来调整主动程度。

---

# 70. Intervention Evidence

用户可点：

```text
Why?
```

看到：

- Deadline
- Progress
- Recent Progress
- Estimated Remaining Work
- Available Time
- Confidence

展示证据，不展示 CoT。

---

# 71. Review / Analytics

核心不是日报，而是：

```text
Expected
vs
Actual
```

---

# 72. Review 层级

### Execution Review

单 Task / Run。

### Daily Review

今天计划 vs 实际。

### Weekly Review

Goal / Project Allocation。

### Monthly Review

Goal 是否真正推进。

---

# 73. Gap Analysis

至少：

```text
Time Gap
Completion Gap
Priority Gap
Planning Gap
Agent Gap
```

---

# 74. Goal Alignment

比较：

```text
Declared Priority
vs
Actual Time / Work
```

只陈述偏差，不替用户做价值判断。

---

# 75. Feedback

### Explicit

```text
Accept
Reject
Modify
Too Early
Too Late
Don't Suggest Again
```

### Implicit

```text
Move Task
Delete AI Task
Ignore Suggestion
Actual Duration
Repeated Replan
```

权重：

```text
Explicit
>
Repeated Implicit
>
Single Implicit
```

---

# 76. Learning Evidence

不能：

```text
Observation
→ Preference
```

应：

```text
Observation
→ Evidence
→ Pattern
→ Hypothesis
→ Validated Preference
```

---

# 77. Personalization Review

Weekly Review 可以显示：

```text
What the system learned
```

用户：

```text
Correct
Incorrect
Edit
```

---

# 78. Preference Drift

Preference 应具有：

```text
confidence
evidence_count
last_observed
decay
status
```

长期无证据，Confidence 下降。

---

# 79. Agent Evaluation

系统不仅 Review 用户，也 Review Agent。

例如：

```text
Task Type
Success Rate
First-pass Rate
Retry Rate
Human Reject Rate
Cost
Latency
```

未来可以反哺 Router。

---

# 80. Workflow Evaluation

记录：

```text
Runs
Success
Average Retry
Common Failure
Average Duration
```

未来做 Workflow Learning。

---

# 81. Workflow Learning

例如用户连续多次手动增加同一 Step：

系统建议：

```text
Add this step to default Workflow?
```

属于 V2。

---

# 82. Human Attention Optimization

长期产品目标不是：

```text
More Task Completion
```

而是：

```text
Goal Progress
+
Human Attention
+
Agent Capacity
```

高判断 / 高创造 / 高责任：

```text
Human
```

高重复 / 高检索 / 高结构化：

```text
Agent
```

---

# 83. Review Inbox 与 Proactive 区别

Review Inbox：

> 需要用户决策的事项。

Proactive：

> 系统主动识别值得关注的问题 / 机会。

Proactive 不应直接等于弹通知。

---

# 84. Checkpoint / Time Travel

V1.5。

Checkpoint 管：

```text
Project State
Tasks
Decision
Workbench Config
Workflow Config
Artifact References
```

功能：

```text
View
Compare
Restore
```

Git 管源码。

Project Checkpoint 管工作状态。

---

# 85. Project Bootstrap

V1.5。

导入现有：

```text
Folder
Repo
Documents
```

自动分析：

- README
- Git
- Directory
- pom / package
- Docs
- Recent Commit

建议：

- Project Type
- Workbench
- Initial State
- Knowledge
- Next Action

---

# 86. Information Architecture

V1 一级导航：

```text
Today
Projects
Tasks
Knowledge
Activity
```

底部：

```text
Connections
Settings
```

预留：

```text
Automation (Later/Beta)
```

---

# 87. Today UI

```text
Today's Focus
Next Actions
AI Working
Inbox
Insight
```

---

# 88. Project Detail

基础 Tabs：

```text
Overview
Tasks
Knowledge
Artifacts
Activity
```

Workbench 可动态注入。

---

# 89. Task Detail

显示：

```text
What
Why
Project
Goal
Expected Result
Acceptance Criteria
Estimated Effort
Execution Mode
Dependencies
Result
```

按钮：

```text
Me
AI Assist
Delegate AI
```

---

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

2026-09-27 阅读目标补充：View 包含可读的完整受管正文、来源与版本，而不只是摘录和 ID；笔记修订产生新版本，历史引用不静默切到最新内容。用户无需先向 AI 提问就能访问已有知识。项目导读可围绕目标、核心流程、关键决定、验收要求和经验组织已有引用，其组织方式仍 Proposed，不复制一套项目状态。页面流程与异常状态统一见[工作台第 12 节](docs/frontend/workbench-design.md#12-人和-ai-共用的知识库体验)，不在本节另定路由或存储字段。

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
