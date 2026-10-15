# 双视图工作台重设计（聊天视图 + 任务视图 + 右侧检查面板）

- 日期：2026-10-11。状态：Proposed。
- 依据：用户提供的静态交互原型 [relay_dual_view_prototype.html](../../frontend/mockups/2026-10-11/relay_dual_view_prototype.html)（2026-10-11 收录进仓库）。
- 约束来源：业务交互以[工作台交互](../../frontend/workbench-design.md)与契约为准；视觉规则归[设计系统](../../frontend/design-system.md)，数值唯一源为 [design-tokens.json](../../frontend/design-tokens.json)。本设计不改变业务状态、权限、命令 Owner、API 与数据库。

## 1. 目标与范围

**目标**：将 `/agent`（`CollaborationView`，协作工作台）在有任务态（`task !== null`）及整体页面结构上，从现有的「PageHeader + split/chat/result 三种并列布局 + 繁复展开区」改造成原型定义的 **双视图工作台（Dual-View Workbench）**：
1. **工作台统一页头（Workhead）**：面包屑导航（工作台 > 项目名 > 任务名）+ 任务标题与状态 Chip + 操作栏（编辑任务、Inspector 面板开关、更多操作）+ **视图切换 Tab（聊天视图 vs 任务视图）**。
2. **任务视图（Task View）**：
   - 顶部审批提示 Notice（如有未决审批）/ 完成提示 Card（任务已完成）。
   - **任务概览卡（Hero Overview）**：标题、目标、当前状态与 AI 执行者、快捷操作（开始执行/暂停/继续/前往确认）。
   - **执行进度指标卡（Metric Card）**：进度百分比、完成步骤数、进度条、状态指示。
   - **待确认操作卡（Approval Card）**：如有未决审阅/判断，以高保真卡片展示风险说明、目标及“批准并继续 / 拒绝”操作。
   - **三子页签（Subtabs）**：
     - **执行计划**：验收条件与步骤列表、状态徽章、调整计划入口、最近活动摘要。
     - **工具记录**：工具调用时间线（复用 `RunToolTrajectoryPanel` 核心能力），展示工具类型、摘要与时间。
     - **交付成果**：成果文件卡片网格，点击可在右侧 Inspector 快速预览 Markdown。
3. **聊天视图（Chat View）**：
   - 专注对话沟通流，内联计划进度卡（Inline Plan）、审批卡（Inline Approval）与完成小结（Completed Note）。
4. **右侧检查面板（Inspector）**：
   - 独立可折叠侧栏，支持在任意视图下切换展开。
   - 包含：任务执行进度、步骤清单、快捷操作、成果文件列表、当前上下文（所属项目、工作目录、执行模式等）。
   - 成果预览模式：在交付成果中点击文件时，直接在 Inspector 内展示 Markdown 预览。
5. **底部输入卡（Bottom Composer）**：
   - 沿用并融合情境感知 placeholder、模式 chips、工作目录细条与操作按钮。

## 2. 与现有实现的差异与取舍

| 项 | 现状 (`CollaborationView`) | 原型重塑 | 理由 |
|---|---|---|---|
| 视图切换 | `collab-layout-modes`: split(双栏) / chat(对话) / result(成果) | **聊天视图 (Chat) vs 任务视图 (Task)** | 对齐原型；双视图概念清晰，用户在对话与任务掌控间切换更自然 |
| 任务状态与进度 | 折叠在 details `collab-facts-disclosure` 中 | **常驻 Hero 概览卡 + 进度 Metric 卡** | 关键任务状态与执行指标首屏一目了然，无需翻找折叠栏 |
| 审批/待处理 | 窄侧栏/顶部 `JudgmentBar` | **Hero 下方突出卡片 + 聊天流内嵌卡片** | 危险操作和人工裁决是核心交互，高亮呈现并支持就地处理 |
| 工具轨迹与成果 | 挤在右侧 tablist（成果/检查/历史） | **任务视图的三子页签（执行计划/工具记录/交付成果）** | 层次清晰，每个子项享有充足展示宽度 |
| 右侧面板 | 右侧半屏（split）或整屏（result） | **按需展开的 Inspector（宽约 290px）** | 作为辅助信息面板与文件预览器，不与主内容区争夺视野 |
| 面包屑导航 | 仅在非 `/agent` 页展示 | **页头常驻面包屑（工作台 > 项目 > 任务）** | 补齐定位感知，对齐原型 |

## 3. 保留的业务不变量

1. **状态与命令 Owner 不变**：所有审批（ReviewDecision）、Run 控制（暂停/恢复）、Task 委托仍走严格的命令通道与 CAS 校验，绝对不绕过领域入口。
2. **未决命令与草稿保护不变**：`DraftGuard`、未决命令回执核对（`checkRecovery`）、归属状态机保留。
3. **无任务态（`task === null`）平滑过渡**：无任务时，左侧 RecentWorkRail 保持已优化结构，主区默认停留在「聊天视图」，可新建对话或选择工作。
4. **测试选择器兼容**：保留既有核心 `data-testid`（如 `collab-page`、`collab-center`、`collab-side` 等），必要时增加别名适配。
