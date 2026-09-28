# 页面开发提示词

> 2026-09-23：逐页视觉与交互仍按本文；全量迁移范围、当前顺序及独立验收按 [M02](../../prompts/stack-migration.md#m02完整-react-工作台与-windows-桌面基础)。实际开发为 React，Windows 桌面是交付目标，不能按旧四页任务范围遗漏既有页面。

更新：2026-09-21。状态：Proposed 开发输入；不是已实现页面或测试通过证明。本任务只交付效果图与提示词。

本文件覆盖32张生成效果图与1张用户原始论文验收参考，共33个页面/状态开发单元。图片产出情况以[效果图目录](mockups/2026-09-19/README.md)为准；部分单元是同一路由的状态、页签或浮层，不要求新增路由。UI-30–33补充首批 Skill，真实接入遵守D阶段依赖。本文补充视觉实现任务，不替代 [P00–P22](../../prompts/README.md) 的工程依赖、契约和验收。

2026-09-26 文字接续：下述公共提示词、页面映射及相关逐页块已接入后续产品补充。原图未重绘，不包含全部新增候选交互；没有新图不允许遗漏已确定业务约束，也不允许按文字探索自动扩大页面开发范围。

## 使用方式

在新的开发会话中复制下面的“公共开发提示词”，再复制一项逐页提示词。也可以只复制逐页块：每块要求读取本文件公共约束。一次先实现一个闭合用户路径；不得把整套概念图作为越过 P00 或同时实现所有后端的授权。

依赖建议：页壳 → 项目/任务列表与创建 → 人工编辑/冲突/验收/完成 → Run/待审/控制 → 信息/Today/Assist/三种工作台 → 工具权限。顺序仅安排 UI 工作，真实业务接入仍遵守已有阶段依赖。

## 公共开发提示词

```text
在 D:/Develop/Relay-Agent 中实现本次指定页面。先读 AGENTS.md、CODEX_NEXT_STEP.md、docs/README.md、docs/frontend/workbench-design.md、docs/frontend/design-system.md、docs/frontend/design-tokens.json、docs/architecture/technology-selection.md、docs/decisions/ADR-007-windows-desktop.md，以及该页引用的契约/API。检查实际源码与未提交改动，再明确本次文件范围和验收条件。

产品接续：读取 prompts/README.md“产品补充的执行映射”及本文件“后续产品补充与页面映射”，按工作台第 10/11 节列出本页本次实现、回归核对、待讨论和后置项；图片没有画出的已确认约束仍须落实。新增提醒/队列排序、局部锁定/影响传播或验收关联等策略未定时，只先讨论依赖它的部分；缺接口不造假数据，不自动加导航、后端字段或通用框架。

知识阅读接续（2026-09-27）：UI-14–16 同时读取工作台与测试计划第 12 节、信息设计第 1.1 节。完整正文、来源和历史版本是人的阅读入口，模型离线不使受管内容不可读；不要只展示摘录/ID/hash，也不把原图未画出的导读、确认或沉淀候选当成已冻结方案。

范围：默认实现页面与其核心交互，不启动全平台后端、迁移或桌面壳重构。若已有正式工程，复用现有路由、组件、查询客户端和测试设施；缺工程时按已有阶段前置条件判断可执行范围，不静默冻结生产技术组合。React/TypeScript 按当前选型主文档执行，不因图片内的代码片段改变语言。具体代码实现与修复由当前 Agent 或明确分派的执行 Agent 完成；不得虚报模型调用。

视觉：先直接查看该页图片和原始参考图。遵循暖纸色浅底、墨绿主操作、宋体标题、细线与留白。所有数值从现有 design-tokens.json 复用，不复制第二套 token。图片是视觉参考；生成图的纹理、错误文案、额外字段、伪造数量和日期不能变成需求。正文、输入和代码必须是真实可交互文本，不能用整页 PNG 冒充实现。品牌显示名沿现有工程或明确标为待确认。

页壳：全局左导航为今日、项目、任务、知识、动态，待审是快捷入口；连接和设置置底。Goal/Artifact/Chat 不新增一级导航。全局页面使用工作空间上下文；项目视图使用真实项目上下文。通用/论文/开发切换只在适用的项目视图出现，只改展示，不改变活动 Run 契约。右侧只设一个按需上下文/判断区，小窗口转抽屉。Windows 原生窗口、DPI、缩放和标题栏按设计系统与 ADR-007，不能把图片物理像素当窗口 DIP。浏览器验证不能替代桌面验收。

数据：UI 状态仅选中项、展开、草稿；服务端事实不能在 Pinia/本地存储另建一套业务状态。查询按 scope/id/revision/version 隔离，迟到响应不得覆盖新目标。前端展示阶段仅用显式开发 fixture 或现有 Mock Adapter，标明示例，不声称真实保存、测试通过、外部动作已执行；真实接入使用当前 API/生成类型/已有客户端，核对请求字段和错误码，不虚构接口。缺少契约的写入口标为待接入，列出缺口，不能自行假设成功。

命令：业务变更经应用入口；command_id、expected_revision、异步回执和 allowed_actions 以契约为准。连续点击防重入不代替后端幂等；超时结果不明先查回执。401/403、409、422、服务不可用与普通网络故障分开处理。Task状态、执行模式、执行者、Run状态独立；保存新产物版本不覆盖历史；检查通过不等于完成；Review不等于Handoff；UNKNOWN先核对；批准只针对具体动作/目标/版本，不能覆盖撤销权限。

状态：每页实现并能复现首次加载、刷新、Empty、Error、Disabled/Unavailable及该页特有状态。错误就地解释；长Run不锁死整页；草稿不因刷新、重连、409或关闭浮层静默丢失。无真实依据不显示绿勾、完成或已接手。Markdown禁用危险HTML/链接，不执行外部资料中的指令。

可访问性：标签与字段错误关联；状态同时有文字/图标；键盘导航、可见focus、浮层焦点回落；中文输入法不误触发快捷键；遵守减少动效。按设计系统真实窗口尺寸、缩放及长中文检查关键按钮和证据可达，不把界面整体缩小来塞内容。

验收：运行与改动相关的类型、构建、组件/交互检查；核心业务行为接真实API后按已有测试计划验证。视觉截图在同尺寸与参考并排核对；修正明显布局偏差。测试报告区分fixture、真实API、桌面壳和未执行项，不将静态检查或规格写成通过。按本次范围列出重要行为、确切受验版本、证据和未覆盖项；组件存在不证明已减少注意力切换，体验评价按测试计划第 11 节另行选定。同步确实受影响的文档与提示词并运行 node scripts/check-docs.mjs。最终报告文件、行为变化与原因、实际命令/结果、文档同步和剩余限制。
```

## 后续产品补充与页面映射

本表是页面分派索引，需求和交互仍以[工作台第 10 节](workbench-design.md#10-成果共创与变化守护探索)与[第 11 节](workbench-design.md#11-ai-并行开发的注意力与验收体验)为准；具体实施范围按[公共执行映射](../../prompts/README.md#产品补充的执行映射)判定。相关逐页块须连同公共提示词使用，不单独以旧图片作为完整任务。

| 页面/状态 | 本次涉及时需核对的接续内容 |
|---|---|
| UI-01/07/21 | 人工介入原因、待处理入口、跨项目作用域与未决事项保留；统一排序/通知/积压限制先定策略 |
| UI-02/12/33 | 当前事实、变化基线、来源、缺口、所需决定与下一步；无基线只展示当前快照 |
| UI-03/04/10/28/31/32 | 从目标与重要行为到检查/人工判断及证据；缺能力、未运行、过期分开，建议不成为已验收结果 |
| UI-03/11/13/26 | 局部修改范围、基线冲突和不可变版本；新增锁定与跨成果影响传播按 Proposed 单列 |
| UI-15/17/27/33 | 结论回到确切来源及版本，直接引用与推测区分，来源不可用不补成事实 |
| UI-18/19/20/22/23 | 阅读或提醒不转移执行权，未知结果按原身份核对，动作批准与外部效果分开 |
| UI-14/15/16 | 按[共享知识库交互](workbench-design.md#12-人和-ai-共用的知识库体验)核对无需模型的正文阅读、来源/版本、修订及同源 AI 使用；项目导读和沉淀的未定组织方式先设计 |

## 图像与规范冲突处理

- 前期 projects/create-project/tasks 图继承了参考图的工作台页签，tasks 还有项目面包屑；全局开发实现必须使用工作空间上下文和正确全局导航，不能照抄这一处。
- 个别生成图附带任务类型、开始时间、额外筛选或不准确执行者词语；只实现当前契约/源码存在的字段，按真实枚举渲染。
- 编辑器图中的验收描述不能被解释为允许编辑产物时顺带弱化验收。变更验收走独立版本化命令。
- 设置图不批准深色主题、未定义偏好写接口或新的设置范围。图片中的通过、归档数、代码、日期均为示例。
- run-paused 的导航高亮与 reviews 的示例徽标数量存在偏差；开发时按实际路由和同一查询结果保持一致。run-unknown 修正版的小字“核对执行操作”应实现为“核对执行结果”。
- 这套图不穷举每个加载/空态；对应提示词要求将这些状态作为同一页面的可测试变体，不额外建立业务路由。

## 逐页提示词

### UI-01 今日工作台

[效果图](mockups/2026-09-19/today.png) · 页面/状态：`/today`

```text
请开发“今日工作台”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/today.png
页面/状态：/today。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：日期焦点、可继续任务、待审入口与建议依据。
数据语义：Focus/Pin/Later、资格条件、reason_codes、任务/项目和版本。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：继续任务、置顶/取消、稍后日期选择、打开待审。
状态与边界：无合格候选不改变焦点；阻塞/AI占有任务不进立即开始；查询失败不假空态。
对接入口：module-api Today/selection；信息与计划第4节。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：跨午夜/时区 Later 正确；Focus 不绕过依赖；不推测时长或自动排日历。
产品接续：按公共映射核对等待/阻塞与待审入口可达；Later/Focus 不消除必需待办，不擅自引入自动通知、积压阈值或取消在途任务。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-02 项目总览

[效果图](mockups/2026-09-19/project-overview.png) · 页面/状态：`/projects/:id/overview`

```text
请开发“项目总览”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/project-overview.png
页面/状态：/projects/:id/overview。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：项目当前 State、已确认/待明确、关键产物/决定、下一步侧栏。
数据语义：State revision/确认时间、phase、目标引用、关键版本、Next Action。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：打开任务和证据；显式确认 State 提案后更新。
状态与边界：State 建议过期重读；项目归档只读；来源不可用不以摘要当真相。
对接入口：HTTP Project State；module-api Proposal/Goal。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：状态不由任务数量推断；摘要能回到来源；AI提案不自动改 State。
产品接续：核对工作台第 11.2 节的目标、已确认事项、变化基线、缺口及下一步；无比较基线只给当前快照，未提供来源的设计原因标待确认。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-03 开发工作台

[效果图](mockups/2026-09-19/development-workbench.png) · 页面/状态：`/projects/:id/workbench/development`

```text
请开发“开发工作台”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/development-workbench.png
页面/状态：/projects/:id/workbench/development。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：受管根/隔离副本、版本化变化集、文件列表与diff、检查证据与接受面板。
数据语义：变化集版本、源基线、资源 scope、verification binding、Git/CLI capability。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：查看文件差异、受控测试、接受变化集；写回与 Git 动作单独准入。
状态与边界：未启用能力显示原因；检查失败不可绿勾；基线变化/UNKNOWN/资源冲突阻止应用。
对接入口：工具适配器设计、HTTP operations/Verification/Review；实际变化集接口先查实现。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：接受不等于已写回/commit/push；图中 Rust 是示例，不决定项目后端语言；CLI 仅受信配置。
产品接续：按第 11.3 节核对重要行为到检查/人工证据的关联及缺口；分支与组合版本各自绑定，不能把测试退出 0 显示成完整需求覆盖。新的关联结构或局部共创策略先讨论再接入。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-04 论文产物验收（原始参考）

[效果图](mockups/2026-09-19/../../../../exec-e4781944-a9b1-4906-8cd8-994841a0c21f.png) · 页面/状态：`/tasks/:id 产物验收状态`

```text
请开发“论文产物验收（原始参考）”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/exec-e4781944-a9b1-4906-8cd8-994841a0c21f.png
页面/状态：/tasks/:id 产物验收状态。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：论文产物版本条、正文、绑定版本的检查结果、引用依据、人工接受。
数据语义：ArtifactVersion、current/latest/accepted、验收版本、Verification、Review target与适用状态。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：打开原来源，选择版本查看，接受确切 v3 并完成，或请求修改。
状态与边界：证据未就绪/版本改变/验收变化/权限撤销使接受不可用；提交超时查回执。
对接入口：HTTP Verification/Review/完成用例；四份契约03与04。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：引用格式通过不代表论断获支持；接受版本和证据精确绑定；重复提交幂等；拒绝不自动转执行权。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-05 项目列表

[效果图](mockups/2026-09-19/pages/projects.png) · 页面/状态：`/projects`

```text
请开发“项目列表”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/projects.png
页面/状态：/projects。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：项目列表与选中项目摘要；进行中/归档筛选、搜索、新建入口。
数据语义：Project ID、标题、类型、明确阶段、当前目标、Next Action、State revision、待审数量。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：搜索和筛选保持作用域；打开项目；归档存在活动 Run/UNKNOWN 时展示阻塞原因。
状态与边界：空项目提供新建入口；失败可重取；归档冲突不移除原列表；不得按任务数量推断阶段。
对接入口：Project 查询/创建/归档；HTTP 契约、module-api 项目范围。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：全局面包屑正确；跨项目打开无串数据；归档拒绝时保留事实。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-06 创建项目

[效果图](mockups/2026-09-19/pages/create-project.png) · 页面/状态：`/projects 新建流程`

```text
请开发“创建项目”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/create-project.png
页面/状态：/projects 新建流程。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：名称、目标、类型和可选资料导入表单；右侧说明首次创建路径。
数据语义：项目输入草稿、Project Type、可选导入项、命令回执。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：校验后创建；成功进入项目；导入状态独立显示；模型建议必须用户 Apply。
状态与边界：未连接模型仍可创建；字段错误就地显示；超时查回执；不因导入失败丢项目。
对接入口：CreateProject；资料导入按 module-api Knowledge 长任务。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：无模型场景走通；重复点击不建两个项目；取消保留或明确放弃草稿。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-07 全部任务

[效果图](mockups/2026-09-19/pages/tasks.png) · 页面/状态：`/tasks`

```text
请开发“全部任务”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/tasks.png
页面/状态：/tasks。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：跨项目任务表、项目/状态/模式筛选、收件箱入口。
数据语义：Task ID、project_id 可空、工作状态、交互模式、执行者、revision、allowed_actions。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：筛选、打开任务、新建、进入收件箱；分别展示人工/Assist/Delegate。
状态与边界：空筛选可清除；读取错误可重试；刷新保留旧数据并注明更新。
对接入口：Task 列表查询，实际查询参数按 HTTP 契约/现有客户端。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：全局页不得使用项目面包屑或工作台切换；AI 辅助的执行者仍可为我。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-08 任务收件箱

[效果图](mockups/2026-09-19/pages/inbox.png) · 页面/状态：`/inbox`

```text
请开发“任务收件箱”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/inbox.png
页面/状态：/inbox。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：快速录入、待整理列表、选中任务编辑面板。
数据语义：无项目 Task、标题、说明、状态、人工执行者、revision。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：添加无项目任务、编辑内容、显式关联已有项目；不自动创建 Project。
状态与边界：录入空值报错；保存失败保留输入；冲突展示最新版本；无项目不能假装委托就绪。
对接入口：CreateTask/Task 修改；移动项目按 module-api 项目/任务范围。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：刷新后真实保存可见；未归属任务可人工打开；不得把勾选行视为业务完成。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-09 项目任务

[效果图](mockups/2026-09-19/pages/project-tasks.png) · 页面/状态：`/projects/:id/tasks`

```text
请开发“项目任务”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/project-tasks.png
页面/状态：/projects/:id/tasks。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：项目标题与总览/任务/资料导航；任务行和依赖说明面板。
数据语义：项目范围、Task 状态/模式/执行者、依赖 ID、阻塞原因、allowed_actions。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：打开前置任务、创建项目内任务；依赖不满足时禁用开始。
状态与边界：前置资料失效明确提示；依赖并发变化后重取；不以置顶绕过阻塞。
对接入口：Task/依赖查询，module-api dependency-links 与 dependency-unlinks。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：页面固定项目范围；禁止循环依赖由服务端判断；未指派/全组等图内生成词不得替代真实 executor 枚举。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-10 任务详情与验收标准

[效果图](mockups/2026-09-19/pages/task-detail.png) · 页面/状态：`/tasks/:id`

```text
请开发“任务详情与验收标准”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/task-detail.png
页面/状态：/tasks/:id。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：任务标题、三项独立元数据、概览/产物/执行记录、验收标准与编辑入口。
数据语义：Task revision、验收版本、required 条件、验证方式、当前 ArtifactVersion、依赖。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：编辑产物、开启只读辅助、进入委托范围确认；修改验收走专用命令。
状态与边界：已完成须重开；AI 持有时编辑入口改为请求接手；验收过期提示重读。
对接入口：Task/Artifact/Verification 查询；HTTP 验收修改命令。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：检查通过不直接 DONE；图内额外任务类型/开始时间/标签不自动加入需求或数据库。
产品接续：已接受的必需行为与新增风险候选分别呈现，检查关联缺失、未运行和证据过期均可见；新建议不能静默改变当前验收契约。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-11 人工编辑与保存版本

[效果图](mockups/2026-09-19/pages/artifact-editor.png) · 页面/状态：`/tasks/:id 产物编辑`

```text
请开发“人工编辑与保存版本”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/artifact-editor.png
页面/状态：/tasks/:id 产物编辑。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：Markdown 编辑/预览、版本条、未保存提示和保存新版本侧栏。
数据语义：基准版本、客户端草稿、Task revision、command_id、保存回执、current/latest/accepted 指针。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：保存创建不可变版本；离开前选择保留/放弃；安全 Markdown 预览。
状态与边界：保存中防重入；超时先查回执并保留原 command_id；409 保留草稿；重新编辑才新命令。
对接入口：Artifact 版本保存与命令回执，见 HTTP 契约。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：原版本不变；未知保存结果不盲建新版本；危险 HTML/链接不执行；不在编辑器顺手修改验收标准。
产品接续：成果共创按工作台第 10 节判定本次范围；不可变版本不等于已支持局部锁定或跨成果影响分析，未选定能力记录缺口，新版本不继承旧验证。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-12 通用工作台与 AI 辅助

[效果图](mockups/2026-09-19/pages/general-workbench.png) · 页面/状态：`/projects/:id/workbench/general`

```text
请开发“通用工作台与 AI 辅助”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/general-workbench.png
页面/状态：/projects/:id/workbench/general。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：通用页主区任务/产物/下一步，右区只读 AI Panel，不增加第二条侧栏。
数据语义：Project/Task、来源确切版本、Assist session/message、提案目标与 base revision。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：请求建议、查看提案差异、显式接受提案、保存结果。
状态与边界：无模型仍人工工作；流式失败保留已有输出；切任务后迟到响应留原会话。
对接入口：Workbench/ViewConfiguration、Assist、Proposal；module-api。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：切工作台不改 Run contract；Assist 不占执行权、不自动写事实；未接受提案明确标记。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-13 论文资料与草稿工作台

[效果图](mockups/2026-09-19/pages/thesis-workbench.png) · 页面/状态：`/projects/:id/workbench/thesis`

```text
请开发“论文资料与草稿工作台”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/thesis-workbench.png
页面/状态：/projects/:id/workbench/thesis。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：资料选择、候选草稿、引用核对与只读辅助侧栏。
数据语义：资料版本引用、候选文本、消息状态、ArtifactVersion、验收条目。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：选择确切来源版本，请求候选草稿，人工保存为新产物；打开引用证据。
状态与边界：资料不可用或生成失败明确提示；空资料提示选择；无模型禁用生成但可人工编辑。
对接入口：Knowledge/Assist/Artifact 查询与命令；不得虚构专门论文后端。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：候选不冒充已发布版本；引用存在与论断支持分开；不扩展成文献管理器。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-14 全局知识库

补充参考：[最新知识库图与实施边界](mockups/2026-09-27/README.md)。全局列表仍使用原图，收录流程按新图与工作台契约细化。

[效果图](mockups/2026-09-19/pages/knowledge.png) · 页面/状态：`/knowledge`

```text
请开发“全局知识库”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/knowledge.png
收录补充：docs/frontend/mockups/2026-09-27/knowledge-capture-review.png；先读取同目录 README.md，不从图像推导新增路由或授权。
页面/状态：/knowledge。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：资料搜索/来源/项目筛选、资料行、导入入口与支持格式提示。
数据语义：Knowledge root/version、source_kind、project scope、availability、import job status。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：导入 md/txt/笔记；公开网页通过受控 Web；打开资料详情。
状态与边界：异步导入展示排队/处理/失败；PDF/Office 不支持全文提取时明确禁用；重试遵守回执。
对接入口：module-api Knowledge、导入 Job、搜索。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：中文短查询可检出字面命中；导入成功不等于内容已验证；不可见资料不得泄漏。
知识阅读补充：列表/搜索是进入完整正文的入口，标明范围与来源，未检出、读取失败和无权限分开；Provider 关闭时本机已保存资料仍可查阅，不以“去问 AI”替代详情。项目导读不是本列表自动生成的承诺。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-15 资料详情与来源版本

最新阅读参考：[专注阅读](mockups/2026-09-27/knowledge-reading.png)，使用边界见[本批说明](mockups/2026-09-27/README.md)。下方旧图保留来源追溯。

[效果图](mockups/2026-09-19/pages/knowledge-detail.png) · 页面/状态：`/knowledge 资料详情`

```text
请开发“资料详情与来源版本”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/knowledge-detail.png
最新阅读参考：docs/frontend/mockups/2026-09-27/knowledge-reading.png（优先）；先读取同目录 README.md，正文必须正常滚动。
页面/状态：/knowledge 资料详情。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：正文纸面阅读、版本切换、来源与被引用关系侧栏。
数据语义：KnowledgeVersion、来源 URI、检索时间、媒体类型、版本与引用目标、可用性。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：读取历史版本；编辑保存为新版本；跳至引用产物。
状态与边界：原文移除显示不可用，不用当前正文冒充旧版本；新保存冲突保留输入。
对接入口：Knowledge versions；Lineage/来源查询以 module-api 既有接口为准。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：引用固定旧版本；网页重新抓取不覆盖历史；编辑笔记不自动变成 Rule。
知识阅读补充：按工作台第 12.2 节提供完整受管 Markdown/纯文本、安全渲染及适用的文内目录；只有摘录或部分内容时明确提示。选择版本绑定标题/正文/来源，缺失不以最新版兜底；区分原件与快照，阅读不调用模型，不能暗中写回原件或把收录标为验证。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-16 项目资料、记忆、决定与规则

补充参考：[项目导读](mockups/2026-09-27/knowledge-project-guide.png)与[收录确认](mockups/2026-09-27/knowledge-capture-review.png)，使用边界见[本批说明](mockups/2026-09-27/README.md)。原四类页签仍保留。

[效果图](mockups/2026-09-19/pages/project-information.png) · 页面/状态：`/projects/:id/knowledge`

```text
请开发“项目资料、记忆、决定与规则”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/project-information.png
最新补充：docs/frontend/mockups/2026-09-27/knowledge-project-guide.png 与 knowledge-capture-review.png；先读取该目录 README.md，不以视觉确认替代关系、字段和权限契约。
页面/状态：/projects/:id/knowledge。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：项目资料四类页签：资料/记忆/决定/规则；列表、详情与明确写操作。
数据语义：各类独立 ID/revision/版本、确认来源、适用范围、决定替代关系、Rule strength/enforcement。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：分别新增/修订信息；决定显式替代保留历史；Memory 要求用户确认；规则从 Owner 入口改版。
状态与边界：空类型提示正确入口；同层偏好冲突显示；HARD 冲突不可静默覆盖。
对接入口：module-api Knowledge/Memory/Decision/Rule 四类接口。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：不统一成万能写 API；替代无循环；Workspace/Project/Task 范围可辨；模型不自动写记忆。
知识阅读补充：四类页签可形成统一阅读导航，但保持原类型与写入口；导读引用目标/流程/决定/验收和经验，不复制当前状态。AI 整理先建议、显式接受后保存，确认需有具体含义；新增编排、关系或确认字段先确定契约，缺失时如实说明，不自动收录聊天与日志。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-17 全局动态与追溯

[效果图](mockups/2026-09-19/pages/activities-v2.png) · 页面/状态：`/activities`

```text
请开发“全局动态与追溯”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/activities-v2.png
页面/状态：/activities。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：按时间分组的动态、项目/actor 筛选、选中事件依据侧栏。
数据语义：actor、时间、command/entity refs、事件摘要、关联 Run/版本/验证。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：有界分页、打开关联任务与证据、查看直接来源链。
状态与边界：无事件空态；分页失败保留前页；历史正文 unavailable 可见；敏感值不显示。
对接入口：module-api Activity、Trace、Lineage 只读查询。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：批准与执行成功分开显示；不展示模型私有思考；跨项目范围先过滤。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-18 执行详情与暂停请求

[效果图](mockups/2026-09-19/pages/run-control-v2.png) · 页面/状态：`/runs/:id control=PENDING`

```text
请开发“执行详情与暂停请求”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/run-control-v2.png
页面/状态：/runs/:id control=PENDING。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：Run 步骤时间线、当前动作、暂停请求和资源面板；图展示 PENDING。
数据语义：Run/Step/Attempt、Task 执行者、control request、在途 operation、资源状态。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：提交暂停/取消/接手请求并轮询真实回执；查看操作证据。
状态与边界：同时覆盖运行中、请求中、FAILED、重连；PENDING 不显示已暂停/已交接；UNKNOWN 转核对。
对接入口：HTTP Run/control/operations，module-api trace。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：刷新不丢持久控制；停止与完成竞争以服务端结果为准；失败保留产物，重试创建新 Run。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-19 已暂停与安全接手

[效果图](mockups/2026-09-19/pages/run-paused.png) · 页面/状态：`/runs/:id PAUSED`

```text
请开发“已暂停与安全接手”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/run-paused.png
页面/状态：/runs/:id PAUSED。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：已暂停摘要、保存产物、恢复点、资源占用与恢复/接手操作。
数据语义：Run PAUSED、当前 AI 执行权、ownership、资源核对结果、handoff request。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：恢复 AI；请求人工接手；Handoff APPLIED 后才呈现人工编辑入口。
状态与边界：请求失败保持 PAUSED；PENDING 等待；资源仍占用必须如实显示；租约过期不能推断进程已停。
对接入口：HTTP Resume/Handoff 控制命令及 Run 查询。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：暂停不自动转移执行权；刷新后状态一致；接手完成再编辑，历史 Run 可追溯。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-20 执行结果未确认与恢复核对

[效果图](mockups/2026-09-19/pages/run-unknown-v2.png) · 页面/状态：`/runs/:id UNKNOWN`

```text
请开发“执行结果未确认与恢复核对”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/run-unknown-v2.png
页面/状态：/runs/:id UNKNOWN。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：已知/未知证据、动作时间线、目标与资源保护侧栏。
数据语义：原 operation ID、target、作用域、已记录回执、未确认范围、reconciliation 状态。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：发起核对、读取证据；仅按已验证的核对结果展示下一步。
状态与边界：无证据/核对失败保持 UNKNOWN；禁用重复执行、换 Adapter、强制成功。
对接入口：HTTP operations 查询及实际核对入口；若写入口尚未定义则标待接入，不自建成功开关。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：断连重开仍 UNKNOWN；不换动作 ID；明确核对与重试的差别。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-21 待审中心

[效果图](mockups/2026-09-19/pages/reviews.png) · 页面/状态：`/reviews`

```text
请开发“待审中心”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/reviews.png
页面/状态：/reviews。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：待审列表、紧急性/时间顺序、所选请求原因/版本/影响/证据/动作。
数据语义：item_kind、源 ID、target version/hash、阻塞性、allowed_actions、适用状态。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：进入单项判断；按类型转产物验收、提案或动作批准。
状态与边界：空列表说明无待审；过期请求显示原因与刷新入口；无权限禁用；不批量批准。
对接入口：module-api review-inbox；HTTP Review 和 Proposal 相应命令。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：每项一个明确决定；拒绝不等于执行失败；不在列表绕过证据自动接受。
产品接续：解释介入原因与有依据的延后影响，未知影响如实标注；集中审查仍逐项绑定当前对象，过期项不能因列表缓存继续批准，通知不自动制造 Review。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-22 特定 Git 动作批准

[效果图](mockups/2026-09-19/pages/action-approval.png) · 页面/状态：`/reviews/:id 动作批准`

```text
请开发“特定 Git 动作批准”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/action-approval.png
页面/状态：/reviews/:id 动作批准。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：动作、仓库、分支、变化集、提交信息与精确授权范围；批准/拒绝。
数据语义：动作 ID、内容/目标 hash、权限版本、Review revision、绑定变化集与证据。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：批准本次明确动作或拒绝；批准后等待动作回执，不假设成功。
状态与边界：目标变化/批准过期/权限撤销禁用批准并说明；提交超时先查回执。
对接入口：HTTP Review 决定；Gateway/Permission 准入由后端拥有。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：本地 commit 批准不授权 push 或后续动作；批准不是执行成功；不支持任意命令输入。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-23 连接与执行权限

[效果图](mockups/2026-09-19/pages/connections.png) · 页面/状态：`/settings/connections`

```text
请开发“连接与执行权限”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/connections.png
页面/状态：/settings/connections。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：连接列表、健康状态、能力、资源范围和权限详情。
数据语义：Connection、capability、PermissionPolicyVersion、ManagedResource、ExecutionConfiguration。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：健康检查、管理指定范围、禁用连接；健康检查不触发写副作用。
状态与边界：未连接/失效/未授权分别显示；缺受信配置时测试不可用；停用有 claim 资源按服务端拒绝。
对接入口：module-api Connection/Permission/资源/执行配置。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：连接不等于授权；secret_ref 不泄露密钥；批准不能覆盖撤销权限；不扩展 Connector 商城。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-24 设置与工作偏好

[效果图](mockups/2026-09-19/pages/settings.png) · 页面/状态：`/settings`

```text
请开发“设置与工作偏好”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/settings.png
页面/状态：/settings。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：基本设置表单与 AI/权限/本机运行/个性化设置入口；只实现当前有定义的项。
数据语义：现有设置模型、显示偏好、时区、view configuration；字段持久化 Owner 先核对。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：保存已支持偏好；AI Provider、权限与 Runtime 进入各自配置。
状态与边界：未定义的设置明确暂不可用，不造万能 settings API；深色主题未定义不得做假切换。
对接入口：ViewConfiguration/Connection/Permission 已定义接口；基本偏好缺契约标待确认。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：切视图不改活动 Run；修改界面时区不改 Later 存储语义；图内菜单是展示建议非新增契约。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-25 全局搜索与快捷操作

[效果图](mockups/2026-09-19/pages/search.png) · 页面/状态：`Ctrl+K 弹层`

```text
请开发“全局搜索与快捷操作”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/search.png
页面/状态：Ctrl+K 弹层。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：Ctrl+K 搜索/快捷操作浮层，分组结果、类型/版本/项目范围与键盘帮助。
数据语义：query、project scope、types、matched_fields、source refs、availability、cursor。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：中文输入；上下选择/Enter 打开/Esc 返回；快捷命令复用 GUI 准入。
状态与边界：短查询/空结果/读取失败清楚呈现；输入法组合输入不误触发；旧响应不覆盖新查询。
对接入口：module-api /search 只读接口；操作复用已有业务命令。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：先作用域过滤再检索；版本命中准确；不宣称语义检索；浮层焦点返回触发点。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-26 版本冲突与草稿保留

[效果图](mockups/2026-09-19/pages/version-conflict.png) · 页面/状态：`/tasks/:id 保存冲突`

```text
请开发“版本冲突与草稿保留”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/version-conflict.png
页面/状态：/tasks/:id 保存冲突。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：冲突持续提示、我的草稿/服务器当前版本对照、保留或整理新草稿。
数据语义：base version/revision、local draft、server version/revision、冲突码。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：查看差异，基于新版本人工整理；保留草稿稍后处理；新编辑使用新 command_id。
状态与边界：重取再冲突仍保留草稿；网络错误不清空内容；禁用静默覆盖和自动接受合并。
对接入口：HTTP 409 REVISION_CONFLICT 与产物查询/保存。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：两个受控客户端竞争保存可复现；草稿不丢；版本不可变；这不是独立领域对象或新路由。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-27 完成凭据与产物来源

[效果图](mockups/2026-09-19/pages/task-completed.png) · 页面/状态：`/tasks/:id DONE`

```text
请开发“完成凭据与产物来源”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/task-completed.png
页面/状态：/tasks/:id DONE。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：完成摘要、接受版本/验收/验证/人工决定与直接来源链、重开入口。
数据语义：DONE、completion receipt、accepted/current/latest versions、criterion version、verification/Review/lineage。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：查看完成依据；显式重开再编辑；历史证据保持只读。
状态与边界：历史证据 unavailable 如实显示；重复重开查回执；旧验证不自动继承新版本。
对接入口：HTTP Task/Artifact/Verification/重开；module-api lineage。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：完成与 PASS 分开；重开后当前视图刷新且旧依据仍可读；不得直接编辑已接受版本。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-28 AI 委托前确认

[效果图](mockups/2026-09-19/pages/delegate-v2.png) · 页面/状态：`/tasks/:id 委托流程`

```text
请开发“AI 委托前确认”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/delegate-v2.png
页面/状态：/tasks/:id 委托流程。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：委托确认页/对话框，任务、验收、配置、来源、流程、能力与范围。
数据语义：Task revision、acceptance version、execution config version、source refs、权限与allowed_actions。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：确认后调用 Delegate；成功读取 Run 和执行权，不由 UI 自行置 AI。
状态与边界：资料/配置失效、并发 Delegate、硬规则冲突时展示对应错误；无项目/缺条件不强行启动。
对接入口：HTTP Delegate；执行配置/Permission 查询。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：两请求只产生合法执行权；范围可复核；委托不授予无限权限；配置展示不包含凭据。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```

### UI-29 新建任务与执行准备

[效果图](mockups/2026-09-19/pages/task-create-v2.png) · 页面/状态：`/tasks 新建流程`

```text
请开发“新建任务与执行准备”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前页面，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/pages/task-create-v2.png
页面/状态：/tasks 新建流程。其中流程、页签、冲突或完成状态复用所属页面，不擅自注册新路由。
布局与组件：任务名、可选项目、预期结果、验收条件、人工/辅助意图与依赖入口。
数据语义：Task 输入、project_id 可空、expected_outputs、acceptance criteria、草稿/就绪条件。这里只列显示需求，字段名/枚举以真实DTO与契约为准。
主交互：保存任务或待整理；委托意图在任务满足条件后单独确认，不直接设 Delegate。
状态与边界：必填与验收错误按字段定位；草稿可暂存；命令未知查回执；依赖冲突不吞错。
对接入口：HTTP CreateTask/验收；module-api interaction-mode/依赖。读取现有实现确认接口，缺失部分报告为待接入。
专项验收：未归属人工任务可创建；重复点击不重复创建；就绪需明确验收；不添加自动排程。
交付可运行页面、相关必要检查与文档同步；明确模拟展示和真实业务验证的范围，不改写无关模块。
```


### UI-30 项目蓝图预览

[效果图](mockups/2026-09-19/extensions/project-blueprint.png) · 页面/状态：项目创建后的预览流程，复用项目入口。

```text
请开发“项目蓝图预览”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前交互，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/extensions/project-blueprint.png
布局与组件：只读当前/建议对照、待创建任务、工作台变化、后续配置与接受区。
数据与命令边界：读取 docs/architecture/relay-skills.md 第4–5节和 docs/api/module-api.md 第5节。接受绑定目标、候选和事实基线；改选后重新校验预览；新任务按 `INBOX` / `ME`（`executor_kind=HUMAN`）创建。Rules、执行配置及验证配置单独确认，不能随蓝图生效。
专项验收：覆盖生成失败、候选过期、修改后重新预览、应用冲突与超时查原回执。拒绝保留项目，接受不启动 Run，不隐藏 Review/恢复入口。
只在既有工程和D阶段前置能力具备后接入真实命令；缺接口标为待接入，不虚构成功。复用当前路由/注册组件，不新增 Skill 一级导航或独立执行系统。交付相关必要检查与文档同步，区分静态效果、fixture 与真实运行证据。
```

### UI-31 完善任务定义

[效果图](mockups/2026-09-19/extensions/task-definition.png) · 页面/状态：任务详情内的定义提案，复用任务入口。

```text
请开发“完善任务定义”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前交互，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/extensions/task-definition.png
布局与组件：原始意图、待确认定义、预期结果、验收条件、输入资料与建议模式，右侧确认区。
数据与命令边界：读取 docs/architecture/relay-skills.md 第7节及 Task/Proposal 当前契约。Task Owner 接受类型化提案，区分当前定义和建议；模式只作建议，ExecutionContract 在正式 Delegate 时冻结。
专项验收：覆盖来源失效、任务版本冲突、提案拒绝与接受成功。接受不自动开始或委托；AI 占有任务时遵守执行权；图中验收条件数量不构成限制。
只在既有工程和D阶段前置能力具备后接入真实命令；缺接口标为待接入，不虚构成功。复用当前路由/注册组件，不新增 Skill 一级导航或独立执行系统。交付相关必要检查与文档同步，区分静态效果、fixture 与真实运行证据。
```

### UI-32 生成验收方案

[效果图](mockups/2026-09-19/extensions/verification-plan.png) · 页面/状态：任务详情内的检查建议与缺少能力状态，复用任务入口。

```text
请开发“生成验收方案”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前交互，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/extensions/verification-plan.png
布局与组件：检查项、检查方式、未运行/人工判断/能力缺失标记、来源版本、禁用应用及原因。
数据与命令边界：读取 docs/architecture/relay-skills.md 第7节和第8.2节、contracts/03-verification-and-approval.md。Verification 拥有有效 CheckPlan，只组合注册检查器及合法参数；建议不能修改验收标准或弱化必需检查。
专项验收：覆盖可用方案、缺少必需检查器、基线过期、人工判断未完成。缺少必要能力时阻止应用并提供合规调整路径；不能把方案生成当成检查通过，不能直接生成执行代码。
产品接续：按第 11.3 节从需求与重要行为核对检查依据，显示遗漏候选、实际能力和未覆盖项；AI 编写测试或其他 Agent 赞同都不构成 PASS，不以已通过数量宣称完整覆盖。
只在既有工程和D阶段前置能力具备后接入真实命令；缺接口标为待接入，不虚构成功。复用当前路由/注册组件，不新增 Skill 一级导航或独立执行系统。交付相关必要检查与文档同步，区分静态效果、fixture 与真实运行证据。
```

### UI-33 继续这个项目

[效果图](mockups/2026-09-19/extensions/project-resume.png) · 页面/状态：项目内的只读恢复摘要，复用项目入口。

```text
请开发“继续这个项目”。先读取 D:/Develop/Relay-Agent/docs/frontend/page-development-prompts.md 的公共开发提示词并遵守；本段只限定当前交互，不扩大任务范围。
视觉参考：D:/Develop/Relay-Agent/docs/frontend/mockups/2026-09-19/extensions/project-resume.png
布局与组件：当前进展、风险、建议下一步、来源及时间；已完成项链接完成依据，待审项链接具体产物。
数据与命令边界：读取 docs/architecture/relay-skills.md 第7节及 docs/frontend/workbench-design.md。只读消费 State、Task、Decision、Artifact/Verification、Review 和 Activity；摘要保留版本来源，过期重新读取，不从聊天推断当前事实。
专项验收：覆盖没有比较基线、来源失效、摘要过期和切换项目后的迟到响应。无基线不生成虚假变化；检查通过不等于业务完成；查看摘要不开始任务、不恢复 Run、不改变执行权。
产品接续：摘要应支持回答上次确认、后续变化、已验证/未知、当前决定与下一步；已有字段不足时列缺口，新增基线存储先设计，不从聊天补造。实际操作跳转原命令入口并重新核对当前版本。
只在既有工程和D阶段前置能力具备后接入真实命令；缺接口标为待接入，不虚构成功。复用当前路由/注册组件，不新增 Skill 一级导航或独立执行系统。交付相关必要检查与文档同步，区分静态效果、fixture 与真实运行证据。
```
