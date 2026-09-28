# 页面效果图目录

最新知识库补充：用户已确认 [2026-09-27 三张概念图](../2026-09-27/README.md)，分别覆盖项目导读、专注阅读和收录确认。UI-15 阅读以新图为参考，旧列表和分类页仍保留；本目录下方数量描述原批次。

更新：2026-09-20。状态：静态设计概念，示例数据；未实现产品页面。

以用户原图的暖白、墨绿、宋体标题、细线与留白为风格基准，形成 **32 张页面效果图 + 1 张原始参考**，对应 **33 个页面/状态开发单元**。基础批次的5张修正版替换当前浏览入口，原图仍保留；修正版不另算新页面。生成使用内置 Image Gen。

范围覆盖基础工作台、任务/产物闭环、资料、审批、执行控制与关键异常状态；2026-09-20 接续补充首批四项 Skill 的交互概念。状态、流程和浮层不等于独立路由；Pack/Profile、来源视图等其余扩展交互尚未配图，按最新范围文档继续细化，不从效果图扩张需求。

[逐页开发提示词](../../page-development-prompts.md)提供可复制的公共约束与33个逐页任务；交互以[工作台规范](../../workbench-design.md)为准，视觉规则以[设计系统](../../design-system.md)和唯一[token数值源](../../design-tokens.json)为准。

## 全部页面

点击图片列查看完整效果图；编号与逐页开发提示词一致。

| 编号 | 页面 | 页面/状态 | 当前效果图 |
|---|---|---|---|
| UI-01 | 今日工作台 | /today | [查看图片](today.png) |
| UI-02 | 项目总览 | /projects/:id/overview | [查看图片](project-overview.png) |
| UI-03 | 开发工作台 | /projects/:id/workbench/development | [查看图片](development-workbench.png) |
| UI-04 | 论文产物验收（原始参考） | /tasks/:id 产物验收状态 | [查看图片](../../../../exec-e4781944-a9b1-4906-8cd8-994841a0c21f.png) |
| UI-05 | 项目列表 | /projects | [查看图片](pages/projects.png) |
| UI-06 | 创建项目 | /projects 新建流程 | [查看图片](pages/create-project.png) |
| UI-07 | 全部任务 | /tasks | [查看图片](pages/tasks.png) |
| UI-08 | 任务收件箱 | /inbox | [查看图片](pages/inbox.png) |
| UI-09 | 项目任务 | /projects/:id/tasks | [查看图片](pages/project-tasks.png) |
| UI-10 | 任务详情与验收标准 | /tasks/:id | [查看图片](pages/task-detail.png) |
| UI-11 | 人工编辑与保存版本 | /tasks/:id 产物编辑 | [查看图片](pages/artifact-editor.png) |
| UI-12 | 通用工作台与 AI 辅助 | /projects/:id/workbench/general | [查看图片](pages/general-workbench.png) |
| UI-13 | 论文资料与草稿工作台 | /projects/:id/workbench/thesis | [查看图片](pages/thesis-workbench.png) |
| UI-14 | 全局知识库 | /knowledge | [查看图片](pages/knowledge.png) |
| UI-15 | 资料详情与来源版本 | /knowledge 资料详情 | [查看图片](pages/knowledge-detail.png) |
| UI-16 | 项目资料、记忆、决定与规则 | /projects/:id/knowledge | [查看图片](pages/project-information.png) |
| UI-17 | 全局动态与追溯 | /activities | [查看图片](pages/activities-v2.png) |
| UI-18 | 执行详情与暂停请求 | /runs/:id control=PENDING | [查看图片](pages/run-control-v2.png) |
| UI-19 | 已暂停与安全接手 | /runs/:id PAUSED | [查看图片](pages/run-paused.png) |
| UI-20 | 执行结果未确认与恢复核对 | /runs/:id UNKNOWN | [查看图片](pages/run-unknown-v2.png) |
| UI-21 | 待审中心 | /reviews | [查看图片](pages/reviews.png) |
| UI-22 | 特定 Git 动作批准 | /reviews/:id 动作批准 | [查看图片](pages/action-approval.png) |
| UI-23 | 连接与执行权限 | /settings/connections | [查看图片](pages/connections.png) |
| UI-24 | 设置与工作偏好 | /settings | [查看图片](pages/settings.png) |
| UI-25 | 全局搜索与快捷操作 | Ctrl+K 弹层 | [查看图片](pages/search.png) |
| UI-26 | 版本冲突与草稿保留 | /tasks/:id 保存冲突 | [查看图片](pages/version-conflict.png) |
| UI-27 | 完成凭据与产物来源 | /tasks/:id DONE | [查看图片](pages/task-completed.png) |
| UI-28 | AI 委托前确认 | /tasks/:id 委托流程 | [查看图片](pages/delegate-v2.png) |
| UI-29 | 新建任务与执行准备 | /tasks 新建流程 | [查看图片](pages/task-create-v2.png) |
| UI-30 | 项目蓝图预览 | 项目创建后的蓝图预览状态 | [查看图片](extensions/project-blueprint.png) |
| UI-31 | 完善任务定义 | 任务详情内的定义提案 | [查看图片](extensions/task-definition.png) |
| UI-32 | 生成验收方案 | 任务详情内的检查方案建议 | [查看图片](extensions/verification-plan.png) |
| UI-33 | 继续这个项目 | 项目内的只读恢复摘要 | [查看图片](extensions/project-resume.png) |

## 首批 Skill 交互补图

UI-30–33 依据[扩展专题首批能力](../../../architecture/relay-skills.md#7-首批闭环能力与后续目录)，复用项目/任务入口。图中的建议、来源版本、检查能力与日期均为示例；为保持同系列一致，画面日期沿用2026-09-19，实际生成于2026-09-20。

- 蓝图：本次变更与后续配置分别展示；新任务进入收件箱，不自动开始；拒绝建议保留项目。
- 任务定义：提案待确认，接受定义与开始/委托分开；三条验收条件仅为样例，不是固定数量。
- 验收方案：展示缺少检查器的状态及禁用原因，不跳过必需检查、不生成虚假通过结果。
- 继续项目：只读摘要保留来源及完成依据；无比较基线不显示上次变化，不自动恢复执行。

逐张检查了导航、中文核心文案、建议/事实区分与关键操作；恢复摘要补齐了初稿遗漏的“完成依据”入口。生成图仍有参考图的轻微纹理与示例待审徽标，实现时遵守纯色 token 和真实查询。四图不是连续时刻的同一任务快照，不应据此推导状态转换。

## 修正与实施边界

- 动态页：选中事件与右侧详情一致。
- 暂停请求页：暂停的是 Run，Task 仍为进行中；隔离副本不宣称进程隔离。
- 委托页：委托前为可开始，当前执行者仍是我；说明不冒充用户确认。
- 新建任务页：项目为可选，不强制三条验收条件。
- 结果待核对页：本地 Git 提交与本机服务连接中断；UNKNOWN 先核对，不盲重试或更换动作身份。

已知图像偏差：projects/create-project/tasks 误继承项目工作台页签，tasks 还有项目面包屑；全局页面应使用工作空间上下文。run-paused 导航高亮、reviews 示例徽标数量需按真实路由与查询结果实现。run-unknown 修正版小字“核对执行操作”应为“核对执行结果”。其他额外字段、计数、日期和生成文字不构成功能契约。图片中的纹理与字体像素不能覆盖 tokens；状态、加载、错误、键盘与 Windows DPI 仍需实际实现和验证。

这次只维护图像、开发输入与导航，不改变需求、架构、API 或数据库契约，也不构成功能或桌面验收通过。

## 生成依据与可追溯记录

- [原始用户参考](../../../../exec-e4781944-a9b1-4906-8cd8-994841a0c21f.png)
- [首批3张完整提示词](prompts.md)
- [25页生成计划与基础提示词](pages/generation-prompts.json)
- [接续生成调用记录](pages/continuation-record.json)
- [5页修正记录](pages/revision-record.json)
- [首批四项 Skill 补图完整提示词与修正记录](extension-record.json)

前9张补充图的临时追加约束未完整持久化，生成计划不冒充逐字调用日志。修正记录区分前会话可恢复摘要与本会话实际调用；不补造缺失回执。
