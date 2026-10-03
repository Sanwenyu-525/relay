# 方案 2 的全站静态效果图

日期：2026-10-02。状态：37 张配套静态图已生成。图片生成阶段仅产出设计提案，不修改产品代码；用户随后另行下发实施指令，已有生产接入，见[工作台 §17.12](../../workbench-design.md#1712-方案-2-全站生产接入2026-10-02)。图片本身仍不是运行验收证据。

业务交互归[工作台 §17.8](../../workbench-design.md#178-聊天优先效果图与全站适配范围2026-10-02)及 §17.12，视觉规则归[设计系统 §9.3](../../design-system.md#93-聊天页方案-2-与共享壳适配2026-10-02效果图)及 §9.3.1，数值仍由[现有 tokens](../../design-tokens.json)维护。2026-10-01 工作优先方案保留为此前实现依据；当前实际成绩与未覆盖出口只看[功能验收表 §9](../../../testing/overall-acceptance-2026-09-28.md#9-方案-2-全站生产接入2026-10-02)。

按图改造现有页面的[执行提示词](../../../../prompts/ui-option-2-pages.md)已补齐，并按已有实施复核接续起点：覆盖 37 项的路由/组件、生成图偏差、先复核后整改与分批验收。本轮验收、修订提示词不自动启动新的实施，也不把目录中的图升级为运行能力证明。

## 范围与依据

- 1 张[用户选定的会话方向](conversation-workspace-selected.png)，以及 37 张页面/状态效果图；完整清单与提示词见[generation-prompts.json](generation-prompts.json)。
- 按当前 React 路由、生产组件和真实 API 分支核对功能；旧图只作视觉参考。全局功能核对见[function-facts-global.json](function-facts-global.json)，资料与执行状态核对见[function-facts-review-knowledge.json](function-facts-review-knowledge.json)。这些文件仅记录本次生图依据，不替代业务规范。
- 主导航保留工作台、项目、待处理、资料；「更多入口」中的今日、全部任务、动态、收件箱在本轮展示为展开；设置和连接与同步保留。
- 项目导航与对象内页签保留各自作用域。当前未接入的 Git diff、受控测试和 Coding CLI 显示尚未接入；连接不代表授权，暂停不代表接手，UNKNOWN 不代表失败后可以盲重试。
- 新增覆盖当前实际入口：人工待处理汇总、项目连接与权限、产物来源追溯、项目 Assist。阅读态与冲突态属于现有页面状态，不新增业务路由。

## 查看与检查

统一在[现有效果图库](../../../../preview.html)的 2026-10-02 分组查看，旧参考图保留。效果图中的示例名称、数量、正文、按钮布局和尺度属于设计建议，最终实施须按当前契约与 tokens 校准。

本轮检查范围为文件完整性、提示词与功能映射、生成图目视核对、图库语法和链接、文档链接。未进行 Windows、DPI、IME、API 写入、真实执行或恢复验收，也不更新功能验收成绩。

此前误启动的独立交互原型已停止且不属于本次交付。自动审批拒绝了删除新增原型目录的清理操作，该未使用目录暂留，没有接入生产应用。

## 配套图片索引

| 编号 | 效果图 | 类型 |
|---|---|---|
| UI-01 | [今日工作台](today.png) | 页面/阅读态 |
| UI-02 | [项目总览](project-overview.png) | 页面/阅读态 |
| UI-03 | [开发工作台](development-workbench.png) | 页面/阅读态 |
| UI-04 | [论文产物验收](thesis-acceptance.png) | 页面/阅读态 |
| UI-05 | [项目列表](projects.png) | 页面/阅读态 |
| UI-06 | [创建项目](create-project.png) | 页面/阅读态 |
| UI-07 | [全部任务](tasks.png) | 页面/阅读态 |
| UI-08 | [任务收件箱](inbox.png) | 页面/阅读态 |
| UI-09 | [项目任务](project-tasks.png) | 页面/阅读态 |
| UI-10 | [任务详情与验收标准](task-detail.png) | 页面/阅读态 |
| UI-11 | [人工编辑与保存版本](artifact-editor.png) | 页面/阅读态 |
| UI-12 | [通用工作台与 AI 辅助](general-workbench.png) | 页面/阅读态 |
| UI-13 | [论文资料与草稿工作台](thesis-workbench.png) | 页面/阅读态 |
| UI-14 | [全局知识库](knowledge.png) | 页面/阅读态 |
| UI-15 | [资料详情与来源版本](knowledge-detail.png) | 页面/阅读态 |
| UI-16 | [项目资料、记忆、决定与规则](project-information.png) | 页面/阅读态 |
| UI-17 | [全局动态与追溯](activities.png) | 页面/阅读态 |
| UI-18 | [执行详情与暂停请求](run-control.png) | 关键状态 |
| UI-19 | [已暂停与安全接手](run-paused.png) | 关键状态 |
| UI-20 | [执行结果未确认与恢复核对](run-unknown.png) | 关键状态 |
| UI-21 | [待审中心](reviews.png) | 页面/阅读态 |
| UI-22 | [特定 Git 动作批准](action-approval.png) | 关键状态 |
| UI-23 | [连接与执行权限](connections.png) | 页面/阅读态 |
| UI-24 | [设置与工作偏好](settings.png) | 页面/阅读态 |
| UI-25 | [全局搜索与快捷操作](search.png) | 页面/阅读态 |
| UI-26 | [版本冲突与草稿保留](version-conflict.png) | 关键状态 |
| UI-27 | [完成凭据与产物来源](task-completed.png) | 关键状态 |
| UI-28 | [AI 委托前确认](delegate.png) | 页面/阅读态 |
| UI-29 | [新建任务与执行准备](task-create.png) | 页面/阅读态 |
| UI-30 | [项目蓝图预览](project-blueprint.png) | 页面/阅读态 |
| UI-31 | [完善任务定义](task-definition.png) | 页面/阅读态 |
| UI-32 | [验收蓝图与检查计划](verification-plan.png) | 页面/阅读态 |
| UI-33 | [继续这个项目](project-resume.png) | 页面/阅读态 |
| UI-34 | [人工待处理汇总](attention-queue.png) | 页面/阅读态 |
| UI-35 | [项目连接与权限](project-connections.png) | 页面/阅读态 |
| UI-36 | [产物版本来源](artifact-lineage.png) | 页面/阅读态 |
| UI-37 | [项目 Assist](project-assist.png) | 页面/阅读态 |

少量导航文字漏绘、示例文案及字号/控件布局偏差记录在三份生成日志中；图中可用能力仍以当前组件与服务端投影为准。核心状态与权限误导已逐页修正，不把静态图作为运行证据。
