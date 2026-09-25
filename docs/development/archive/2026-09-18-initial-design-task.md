# 初始架构设计任务（历史材料）

角色：2026-09-18 阶段任务存档。归档整理：2026-09-19。以下指令只表达当时任务边界，不作为当前执行授权；当前状态见 [CODEX_NEXT_STEP](../../../CODEX_NEXT_STEP.md)，产品定义见 [Master Spec](../../../Personal_Workflow_OS_Master_Spec.md)。历史文字中的“同目录”指当时来源目录。

## 原始阶段任务（历史保留）

以下是 2026-09-18 架构讨论阶段的范围及停止条件；后续会话已推进设计阶段，不作为当前仍禁止阅读数据库/API 设计的指令。

你将基于同目录下的：

`Personal_Workflow_OS_Master_Spec.md`

开始下一阶段。

## 重要约束

当前不要直接开始大规模编码。

不要：

- 自行扩大 V1
- 默认微服务
- 默认复杂分布式架构
- 默认大量 MCP
- 默认多 Agent
- 默认多模型 Router
- 一开始设计几十张数据库表
- 把所有业务逻辑 Agent 化

优先采用：

- Java / Spring Boot
- Modular Monolith
- 明确领域边界
- Stateful Workflow
- Durable Run
- Human-in-the-loop
- Verification
- Context Engineering
- Tool Gateway

## 第一阶段输出顺序

请按以下顺序输出并讨论：

### 1. Domain Model

至少覆盖：

- Workspace
- Goal
- Project
- Project State
- Milestone
- Task
- Workbench
- Workflow Definition
- Workflow Version
- Workflow Run
- Artifact
- Artifact Lineage
- Verification
- Knowledge
- Memory
- Decision
- Rule
- Handoff
- Review Item
- Activity / Trace
- Capability
- Tool
- Permission

要求：

- 明确职责
- 明确 Aggregate / Entity / Value Object 候选
- 明确关系
- 明确哪些是 V1
- 避免过度 DDD

### 2. System Module Architecture

至少：

- Project Module
- Goal Module
- Task Module
- Today Module
- Workbench Module
- Workflow Module
- Agent Runtime
- Context Module
- Verification Module
- Artifact Module
- Knowledge Module
- Review Module
- Activity / Trace Module
- Rules Module
- Handoff Module
- Tool Gateway
- Permission Module
- Local Runtime
- AI Provider Module

要求：

- 给出边界
- 模块依赖方向
- 哪些同步调用
- 哪些可用 Domain Event
- 但不要为了事件而事件化

### 3. Core Data Flow

至少画清：

#### Delegate AI

Task
→ Context Build
→ Workflow Run
→ Execute
→ Artifact
→ Verify
→ Retry/Human
→ Update Project State

#### Me

Task
→ User Result
→ Complete
→ Update Project State

#### AI Assist

Task
→ Context-aware Chat
→ User Complete
→ Update Project State

#### Handoff

Current Owner
→ Handoff Package
→ New Owner
→ Continue

#### Review

System needs decision
→ Review Inbox
→ User decision
→ Resume

### 4. Workbench Architecture

必须讨论：

- Project Type
- Task Type
- Workbench Resolver
- Route Registry
- Core Routes
- Dynamic Routes
- Page Schema
- Block Registry
- Workflow Binding
- Capability Binding
- Rule Binding

V1 不允许 arbitrary code injection。

### 5. Agent Runtime State Machine

至少包含：

- CREATED
- CONTEXT_BUILDING
- PLANNING
- RUNNING
- WAITING_APPROVAL
- VERIFYING
- RETRYING
- PAUSED
- COMPLETED
- FAILED
- CANCELLED

说明：

- 每个状态进入/退出条件
- Pause / Resume
- Retry
- Human Approval
- Handoff
- Artifact
- Verification

### 6. Context Architecture

必须说明：

- Context source
- Priority
- Scope
- Budget
- Retrieval
- Rules injection
- Decision precedence
- Project State precedence
- Raw Conversation 限制

### 7. Tool Gateway

必须抽象：

- Capability
- Tool
- Adapter
- Risk
- Side Effect
- Reversibility
- Scope
- Permission
- Fallback

Adapter 至少兼容：

- Native
- REST
- MCP
- CLI
- Local
- Human

### 8. V1 风险审计

检查：

- 是否过度设计
- 是否与 Notion / Todo / Codex 重叠过多
- 哪些功能会拖慢 V1
- 哪些功能需要再砍
- 哪些架构现在可以只留接口

## 输出完成后停止

在以下内容之前不要继续：

- Database Schema
- REST API List
- Frontend Component Tree
- Code Skeleton
- Implementation

先等待架构方案确认。
