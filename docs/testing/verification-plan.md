# 测试、故障注入与发布出口

当前功能通过、未通过与未验收统一维护在[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)。本页维护规格；下文既有运行数字为各自时点的历史样本，不作为第二份当前成绩表。原始输出保留规则见[文档规范](../README.md#6-验收结果与原始输出保留)。

日期：2026-09-19。状态：生产测试设计，尚未执行生产验收。业务场景编号以[契约包](../../contracts/README.md)的 A01–A09、B01–B08、C01–C09、D01–D11 为准，共 37 项。P00 已另行运行隔离实验，范围和结果见[实验记录](../research/p00-source-study.md)，不能据此将这 37 项标为通过。


<!-- DOC-ROUTER -->

> 本文件现为专题路由。完整正文已按原章节迁入下列分册，原章节标题与锚点保留为跳转入口；不要把路由文件当作完整规格读取，也不要在此追加实现正文。

## 分册导航

先按标题定位；命中后读取对应正文及其必要的公共规则。新内容修改所属分册，新增章节同步本路由；跨章依赖不因拆分而消失。

| 分册 | 章节范围 |
|---|---|
| [分册 01](verification-plan/part-01.md) | 1. 分层证据 → 10.1 模块状态与独立验收 |
| [分册 02](verification-plan/part-02.md) | 10.2 M03 必需可靠性场景 → 16.1 工作主线整套重做的补充规格（2026-10-01） |
| [分册 03](verification-plan/part-03.md) | 17. 文件夹与对话直接执行验收规格 → 20.5 C 片：工具轨迹呈现（2026-10-04 设计） |
| [分册 04](verification-plan/part-04.md) | 20.6 写路径的停止、预算与重启复核（2026-10-05 实施） → 23.4 与既有套件的回归要求 |
| [分册 05](verification-plan/part-05.md) | 24. 自然语言状态维护与自动接续验收规格 → 28. 基础下一段工作计划检查范围 |
| [分册 06](verification-plan/part-06.md) | 27. 验收证据与投入判断验收规格 → 37. 普通 Agent 文件增删改与方法 MODIFY 接续（2026-10-18） |
| [分册 07](verification-plan/part-07.md) | 37. 周期定时启动任务验收规格（2026-10-18） → 50. AI 回复场景实验室的桌面入口与集成验收（2026-10-30） |

## 原章节路由

以下仅保留兼容锚点，具体规则只在链接的正文维护。

## 1. 分层证据

[读取正文](verification-plan/part-01.md#1-分层证据)

## 2. 37 项责任映射

[读取正文](verification-plan/part-01.md#2-37-项责任映射)

## 3. 故障点接口

[读取正文](verification-plan/part-01.md#3-故障点接口)

## 4. 额外产品与安全验收

[读取正文](verification-plan/part-01.md#4-额外产品与安全验收)

## 5. 阶段出口

[读取正文](verification-plan/part-01.md#5-阶段出口)

## 6. TypeScript-first 冻结前 Spike

[读取正文](verification-plan/part-01.md#6-typescript-first-冻结前-spike)

### Spike 1：审批后跨进程恢复

[读取正文](verification-plan/part-01.md#spike-1审批后跨进程恢复)

### Spike 2：外部成功但结果未落库

[读取正文](verification-plan/part-01.md#spike-2外部成功但结果未落库)

### Spike 3：Provider 可替换性

[读取正文](verification-plan/part-01.md#spike-3provider-可替换性)

### 共同冻结门槛

[读取正文](verification-plan/part-01.md#共同冻结门槛)

## 7. Windows 桌面交付验证

[读取正文](verification-plan/part-01.md#7-windows-桌面交付验证)

## 8. Relay Skill 与蓝图应用验收

[读取正文](verification-plan/part-01.md#8-relay-skill-与蓝图应用验收)

### 首批闭环 Skill 的补充场景

[读取正文](verification-plan/part-01.md#首批闭环-skill-的补充场景)

## 9. 扩展组合与版本评测

[读取正文](verification-plan/part-01.md#9-扩展组合与版本评测)

## 10. 技术栈改造的大模块验收

[读取正文](verification-plan/part-01.md#10-技术栈改造的大模块验收)

### 10.1 模块状态与独立验收

[读取正文](verification-plan/part-01.md#101-模块状态与独立验收)

### 10.2 M03 必需可靠性场景

[读取正文](verification-plan/part-02.md#102-m03-必需可靠性场景)

### 10.3 前端、真实模型与最终交付

[读取正文](verification-plan/part-02.md#103-前端真实模型与最终交付)

## 11. AI 并行开发体验验证提案

[读取正文](verification-plan/part-02.md#11-ai-并行开发体验验证提案)

### 11.1 场景与反例

[读取正文](verification-plan/part-02.md#111-场景与反例)

### 11.2 指标与证据限制

[读取正文](verification-plan/part-02.md#112-指标与证据限制)

## 12. 共享知识库的阅读与来源验证

[读取正文](verification-plan/part-02.md#12-共享知识库的阅读与来源验证)

## 13. 锁定影响检查与提醒的已确认规则验收

[读取正文](verification-plan/part-02.md#13-锁定影响检查与提醒的已确认规则验收)

## 14. V1 后续长期协作验收提案

[读取正文](verification-plan/part-02.md#14-v1-后续长期协作验收提案)

### 14.1 使用效果的可复核口径

[读取正文](verification-plan/part-02.md#141-使用效果的可复核口径)

### 14.2 每包放行材料

[读取正文](verification-plan/part-02.md#142-每包放行材料)

## 15. 交互状态与反馈验收

[读取正文](verification-plan/part-02.md#15-交互状态与反馈验收)

## 16. Agent 协作主线验收提案

[读取正文](verification-plan/part-02.md#16-agent-协作主线验收提案)

### 16.1 工作主线整套重做的补充规格（2026-10-01）

[读取正文](verification-plan/part-02.md#161-工作主线整套重做的补充规格2026-10-01)

## 17. 文件夹与对话直接执行验收规格

[读取正文](verification-plan/part-03.md#17-文件夹与对话直接执行验收规格)

### 17.1 轻量创建与状态接续

[读取正文](verification-plan/part-03.md#171-轻量创建与状态接续)

### 17.1 新对话直接起步（2026-10-05）

[读取正文](verification-plan/part-03.md#171-新对话直接起步2026-10-05)

### 17.1.1 同会话目录/项目归属（2026-10-07）

[读取正文](verification-plan/part-03.md#1711-同会话目录项目归属2026-10-07)

### 17.1.2 目标与目录会话导航（2026-10-16）

[读取正文](verification-plan/part-03.md#1712-目标与目录会话导航2026-10-16)

### 17.1.3 本目录写入档位（2026-10-17）

[读取正文](verification-plan/part-03.md#1713-本目录写入档位2026-10-17)

### 17.1.4 本地目录免手工配置（2026-10-18，已确认、已实施）

[读取正文](verification-plan/part-03.md#1714-本地目录免手工配置2026-10-18已确认已实施)

### 17.1.5 未选目录时的默认工作目录（2026-10-18，已确认、未实施）

[读取正文](verification-plan/part-03.md#1715-未选目录时的默认工作目录2026-10-18已确认未实施)

### 17.2 普通 Agent 连续工具主流程

[读取正文](verification-plan/part-03.md#172-普通-agent-连续工具主流程)

## 18. Agent 提示词与输入协议评价（目标设计）

[读取正文](verification-plan/part-03.md#18-agent-提示词与输入协议评价目标设计)

## 19. 会话执行计划验收规格

[读取正文](verification-plan/part-03.md#19-会话执行计划验收规格)

## 20. 模型内部工具循环验收规格

[读取正文](verification-plan/part-03.md#20-模型内部工具循环验收规格)

### 20.2 B 片：范围授权、普通修改与已配置检查（2026-10-04 实施）

[读取正文](verification-plan/part-03.md#202-b-片范围授权普通修改与已配置检查2026-10-04-实施)

### 20.3 循环终止条件与一次冲突适配（2026-10-04 实施）

[读取正文](verification-plan/part-03.md#203-循环终止条件与一次冲突适配2026-10-04-实施)

### 20.4 读写主链与写能力开关（2026-10-05 实施）

[读取正文](verification-plan/part-03.md#204-读写主链与写能力开关2026-10-05-实施)

### 20.5 C 片：工具轨迹呈现（2026-10-04 设计）

[读取正文](verification-plan/part-03.md#205-c-片工具轨迹呈现2026-10-04-设计)

### 20.6 写路径的停止、预算与重启复核（2026-10-05 实施）

[读取正文](verification-plan/part-04.md#206-写路径的停止预算与重启复核2026-10-05-实施)

### 20.7 人工触发的受管 Git 只读（2026-10-05 实施）

[读取正文](verification-plan/part-04.md#207-人工触发的受管-git-只读2026-10-05-实施)

### 20.7.1 人工触发的受管目录浏览与文件读取（2026-10-24 实施，迁移 0134）

[读取正文](verification-plan/part-04.md#2071-人工触发的受管目录浏览与文件读取2026-10-24-实施迁移-0134)

### 20.8 创建后人工补验收条件（2026-10-05 实施）

[读取正文](verification-plan/part-04.md#208-创建后人工补验收条件2026-10-05-实施)

### 20.9 传统 Agent 检查失败后的自主修正（2026-10-05）

[读取正文](verification-plan/part-04.md#209-传统-agent-检查失败后的自主修正2026-10-05)

### 20.10 检查入口的信任摘要与检查证据适用性（2026-10-07 实施）

[读取正文](verification-plan/part-04.md#2010-检查入口的信任摘要与检查证据适用性2026-10-07-实施)

## 21. 有界多 Agent 与自动会话验收规格

[读取正文](verification-plan/part-04.md#21-有界多-agent-与自动会话验收规格)

## 22. 未来需求驱动软件协作验收规格

[读取正文](verification-plan/part-04.md#22-未来需求驱动软件协作验收规格)

## 23. 会话模式与人设助手验收规格

[读取正文](verification-plan/part-04.md#23-会话模式与人设助手验收规格)

### 23.1 已实现并有真实 PostgreSQL 证据的后端子项

[读取正文](verification-plan/part-04.md#231-已实现并有真实-postgresql-证据的后端子项)

### 23.2 前端单选框与呈现

[读取正文](verification-plan/part-04.md#232-前端单选框与呈现)

### 23.3 未运行：真实窗口与真实 Provider

[读取正文](verification-plan/part-04.md#233-未运行真实窗口与真实-provider)

### 23.4 与既有套件的回归要求

[读取正文](verification-plan/part-04.md#234-与既有套件的回归要求)

## 24. 自然语言状态维护与自动接续验收规格

[读取正文](verification-plan/part-05.md#24-自然语言状态维护与自动接续验收规格)

## 25. 学习模式验收规格

[读取正文](verification-plan/part-05.md#25-学习模式验收规格)

## 26. 内置 Skill、命令、压缩与消息文件恢复验收规格

[读取正文](verification-plan/part-05.md#26-内置-skill命令压缩与消息文件恢复验收规格)

### 26.1 首批后端切片覆盖映射（2026-10-11）

[读取正文](verification-plan/part-05.md#261-首批后端切片覆盖映射2026-10-11)

### 26.2 基础后端接续检查（2026-10-13）

[读取正文](verification-plan/part-05.md#262-基础后端接续检查2026-10-13)

### 26.3 免费模型目录与选择验收规格

[读取正文](verification-plan/part-05.md#263-免费模型目录与选择验收规格)

### 26.4 消息文件回退首版覆盖映射（2026-10-24）

[读取正文](verification-plan/part-05.md#264-消息文件回退首版覆盖映射2026-10-24)

## 30. 基础有限 Markdown 任务链检查范围

[读取正文](verification-plan/part-05.md#30-基础有限-markdown-任务链检查范围)

## 29. 基础一次性项目提醒检查范围

[读取正文](verification-plan/part-05.md#29-基础一次性项目提醒检查范围)

## 28. 基础下一段工作计划检查范围

[读取正文](verification-plan/part-05.md#28-基础下一段工作计划检查范围)

## 27. 验收证据与投入判断验收规格

[读取正文](verification-plan/part-06.md#27-验收证据与投入判断验收规格)

## 31. 输入框自动分点与手动润色验收规格

[读取正文](verification-plan/part-06.md#31-输入框自动分点与手动润色验收规格)

### 31.1 本轮实际覆盖（2026-10-16）

[读取正文](verification-plan/part-06.md#311-本轮实际覆盖2026-10-16)

## 32. 聊天消息时间线导航验收规格

[读取正文](verification-plan/part-06.md#32-聊天消息时间线导航验收规格)

### 32.1 本轮实际覆盖

[读取正文](verification-plan/part-06.md#321-本轮实际覆盖)

## 33. 两级上下文菜单验收规格

[读取正文](verification-plan/part-06.md#33-两级上下文菜单验收规格)

### 33.1 本轮实际覆盖

[读取正文](verification-plan/part-06.md#331-本轮实际覆盖)

## 34. 会话局部与总 diff 验收规格

[读取正文](verification-plan/part-06.md#34-会话局部与总-diff-验收规格)

## 35. 内置 GitHub Skill 只读片（0103）

[读取正文](verification-plan/part-06.md#35-内置-github-skill-只读片0103)

## 36. 内置浏览器自动化验收规格（2026-10-17）

[读取正文](verification-plan/part-06.md#36-内置浏览器自动化验收规格2026-10-17)

## 37. 普通 Agent 文件增删改与方法 MODIFY 接续（2026-10-18）

[读取正文](verification-plan/part-06.md#37-普通-agent-文件增删改与方法-modify-接续2026-10-18)

## 37. 周期定时启动任务验收规格（2026-10-18）

[读取正文](verification-plan/part-07.md#37-周期定时启动任务验收规格2026-10-18)

## 38. 资料与记忆规则恢复（2026-10-19）

[读取正文](verification-plan/part-07.md#38-资料与记忆规则恢复2026-10-19)

## 39. 长期记忆状态与筛选（2026-10-19）

[读取正文](verification-plan/part-07.md#39-长期记忆状态与筛选2026-10-19)

## 40. 完整长短期记忆后端（2026-10-20）

[读取正文](verification-plan/part-07.md#40-完整长短期记忆后端2026-10-20)

## 日常工具执行分层回归（2026-10-20）

[读取正文](verification-plan/part-07.md#日常工具执行分层回归2026-10-20)

## 会话执行的服务端推进与失败恢复（2026-10-20 第二轮）

[读取正文](verification-plan/part-07.md#会话执行的服务端推进与失败恢复2026-10-20-第二轮)

## 41. 聊天目标与计划模式验收规格

[读取正文](verification-plan/part-07.md#41-聊天目标与计划模式验收规格)

### 已实现的自动化覆盖（2026-10-21，实施者自检）

[读取正文](verification-plan/part-07.md#已实现的自动化覆盖2026-10-21实施者自检)

### 连续插话的定向回归规格（2026-10-20）

[读取正文](verification-plan/part-07.md#连续插话的定向回归规格2026-10-20)

## 42. 长期项目协作差异化体验的目标验收

[读取正文](verification-plan/part-07.md#42-长期项目协作差异化体验的目标验收)

## 43. 外部 Agent 共享任务协作的目标验收

[读取正文](verification-plan/part-07.md#43-外部-agent-共享任务协作的目标验收)

## 44. 长期 Agent 团队与跨会话协作的目标验收

[读取正文](verification-plan/part-07.md#44-长期-agent-团队与跨会话协作的目标验收)

## 45. 右侧工具面板与内置网页预览的目标验收

[读取正文](verification-plan/part-07.md#45-右侧工具面板与内置网页预览的目标验收)

## 46. 正式目标管理与项目状态写入的验收映射（2026-10-24）

[读取正文](verification-plan/part-07.md#46-正式目标管理与项目状态写入的验收映射2026-10-24)

## 47. 成果版本管理 P0–P2 验收规格（2026-10-25）

[读取正文](verification-plan/part-07.md#47-成果版本管理-p0p2-验收规格2026-10-25)

## 48. N04 到 N06 联合验收与 P2 稳定性门槛（2026-10-26）

[读取正文](verification-plan/part-07.md#48-n04-到-n06-联合验收与-p2-稳定性门槛2026-10-26)

## 49. AI 回复场景实验室：全状态回放与批量截图的开发期出口（2026-10-30）

[读取正文](verification-plan/part-07.md#49-ai-回复场景实验室全状态回放与批量截图的开发期出口2026-10-30)

## 50. AI 回复场景实验室的桌面入口与集成验收（2026-10-30）

[读取正文](verification-plan/part-07.md#50-ai-回复场景实验室的桌面入口与集成验收2026-10-30)

