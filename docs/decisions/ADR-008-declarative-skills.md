# ADR-008：声明式 Relay Skill 复用既有执行与提案机制

## 状态与日期

Proposed，2026-09-20。依据为用户本轮提供的 Skill Layer 建议；本记录整理推荐取舍，不将粘贴建议中的全部分期与技术细节自动视为 Accepted。未实现，未替代既有 ADR。

同日后续：用户在闭环 Skill 评审后明确要求“加进去”，确认纳入首批优先级与核心/Skill 职责边界。技术方案整体仍 Proposed；该确认不自动接受所有未来 Pack、V1.5 Schema 前移或具体持久化设计。

同日扩展评审后，用户明确要求修改文档并补充必要内容：将 Pack、Profile、Recipe、Proposal、Adapter、Eval 和 Trigger 归并为同一扩展模型。方向纳入当前设计；具体注册格式、持久化字段和未来功能实现仍待冻结。

## 背景

从目标装配工作环境需要复用上下文选择、结构化输出、验证和模板，仅增加 Prompt 文件不足以保留输入输出与版本证据。现有系统已经拥有 Assist、Workflow、Gateway、Proposal 和领域写入口，应避免扩展机制重复承担这些职责。

## 候选方案

| 方案 | 优点 | 代价 |
|---|---|---|
| 只使用 Prompt 模板 | 最少定义与加载成本 | 无明确输出约束、依赖版本和应用边界 |
| 独立 Skill Runtime / 代码插件平台 | 可扩展任意执行和 UI | 增加第二套恢复/权限机制，超出 V1 范围 |
| 第一方声明式 Skill，组合现有入口 | 明确契约与来源，保留单一业务 Owner | 需要版本快照、注册引用校验和提案并发验证 |

## 推荐决策与原因

选择第三种，Goal-to-Project Blueprint 保留展示旗舰定位；首批工程顺序先任务定义、项目恢复和验收方案，再组合蓝图入口。Skill 声明 Capability 但不授予 Permission；不执行包内代码，不直接写 Project State，不让模型生成应用源码。

与原建议的两处具体差异：蓝图生成使用既有 Assist，先创建最小项目，不强制所有 Skill 进入 Task/Run；蓝图本地事实与显示变化原子应用，Rules/Workflow/验证配置是单独确认的后续建议。前者保持 Onboarding 和 Assist 边界，后者防止显示选择隐式改变执行契约。

不将 AI-generated Workbench 从原 V2 静默前移；V1.5 AI Schema 生成仍作为范围调整提案。现有四份契约的 Owner、执行权、验证与恢复规则不变。

补充取舍：不把八个能力名称等同八个独立 Skill 执行系统。修复在原 Workflow 内推进，交接包只组织安全点事实，确定性 delta 只由完成用例计算和提交；AI 对检查计划、阶段/风险与 Decision 只提出可审查建议。验收方案先于 Delegate 固定，新产物不继承旧 PASS，实际 Handoff 后再 Delegate 创建新 Run。这避免 Worker 自定通过标准以及模型生成内容成为执行权或事实依据。

扩展模型继续采用“组合现有入口”，不另立万能 Proposal Owner 或扩展引擎。Pack 固定成员版本，区分定义可用、提案选择、配置应用与实际授权；Recipe 复用 WorkflowDefinition/Version，Profile 各归对应模块。升级须保留用户修改并重新审查影响，恢复配置形成新 revision，不逆转外部效果。V1 基础 Eval 与运行时 Verification 分开，实际交付成员和组合都需回归；代价是定义/依赖快照保留与版本比较测试。仅保留字段更少的 Prompt 集不足以满足这些追溯约束，建设独立插件平台则超出当前需要。

## 代价与影响

影响需求范围说明、Skill 专题、Assist/Context 来源、蓝图提案持久化、模块 API、Workbench 预览与验收。新增的组合应用需要真实数据库事务与竞争测试；定义不可变带来历史保留成本。V1 无第三方安装、任意代码、自定义页面或自动升级效果。

## 后续

按[专题设计](../architecture/relay-skills.md)在 P11–P15 对应切片实现前冻结 schema、迁移和锁协议；沿用 P00 研究及阶段依赖，不提前搭插件框架。后续若采用自定义 Skill/Plugin，应另记来源信任、隔离与升级决策，保留本记录的边界与替代关系。
