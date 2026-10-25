# Personal Workflow OS：PostgreSQL 物理数据库设计

> 2026-09-28 增量：`0040_collaboration_artifact_text_locks.sql` 保存当前锁定原文及映射状态；`0041_collaboration_impact_checks.sql` 扩展 Assist intent 并保存确切来源/目标与候选；`0042_collaboration_attention.sql` 保存已发现的锁冲突原目标及通知去重回执。三份 migration 在隔离 PostgreSQL 18.6 成功应用，详见[专项开发记录](../development/collaboration-controls-2026-09-28.md)。新表为空起步，既有版本不改写；回滚删表会丢失当前锁定/回执，须先停写并保存事实。

> 2026-09-24 当前实现：保留 Kysely/pg、业务表及已应用 SQL migration/SHA 台账；M03 已追加 `0011` 的 command/outbox/invocation、`0012` 的 Run 刷新事件及 `0013` 的每 Run 命令顺序。官方 PostgresSaver 的固定 schema 安装与 Worker 接入已通过后端固定图分片独立复验；Windows 组合及 M03 整体仍待验收。业务事务与检查点按稳定身份对账，不能假装原子。

日期：2026-09-19。状态：Proposed。用户已确认允许本机 PostgreSQL；完整技术组合、DDL 与协议仍需工程验证。上游：[逻辑模型](logical-model.md)、[技术选型](../architecture/技术选型.md)。

本文件给出 PostgreSQL 17 基线上的类型、约束、索引、锁协议和建表顺序。SQL 块是需合入后续 migration 的设计片段，不是可以逐段运行的完整脚本。本文业务 DDL 尚未完成真实数据库验证；[P00 基础实验](../research/p00-source-study.md#7-后端开工前准备接续2026-09-20)不代表这些业务 migration 或并发验收通过。

TypeScript-first 评审后的新工程目标候选为 PostgreSQL 18 + Kysely/pg，见 [ADR-006](../decisions/ADR-006-typescript-first.md)。下文 17 基线片段与引用保留来源，P00 必须在 18 上验证后再生成 migration，不能把改版本号当作兼容性通过。没有已部署数据库，不存在本轮生产升级或数据迁移。


<!-- DOC-ROUTER -->

> 本文件现为专题路由。完整正文已按原章节迁入下列分册，原章节标题与锚点保留为跳转入口；不要把路由文件当作完整规格读取，也不要在此追加实现正文。

## 分册导航

先按标题定位；命中后读取对应正文及其必要的公共规则。新内容修改所属分册，新增章节同步本路由；跨章依赖不因拆分而消失。

| 分册 | 章节范围 |
|---|---|
| [分册 01](physical-design-postgresql/part-01.md) | 1. 类型、时间与命名 → 17. 0006 Review 与后继验证会话（2026-09-23 P07） |
| [分册 02](physical-design-postgresql/part-02.md) | 18. 0007 持久控制与受控 Fake 恢复（2026-09-23 P08） → 43. 0030 M06 真实工具能力登记（2026-09-26，开发自检） |
| [分册 03](physical-design-postgresql/part-03.md) | 44. 0031 M06 变化集证据账本（2026-09-27，开发自检） → 71. 0070 自然语言撤回的候选白名单（2026-10-10 源码实现） |
| [分册 04](physical-design-postgresql/part-04.md) | 72. 0071 内置工作方法与聊天命令（2026-10-11 源码实现） → 99. 0110 电脑控制状态的应用角色权限（2026-10-18） |
| [分册 05](physical-design-postgresql/part-05.md) | 100. 0111 会话活动排序键（2026-10-18 源码实现） → 115. 0140 成员私聊、群聊与消息（2026-10-25，ADR-034 包 B） |

## 原章节路由

以下仅保留兼容锚点，具体规则只在链接的正文维护。

## 1. 类型、时间与命名

[读取正文](physical-design-postgresql/part-01.md#1-类型时间与命名)

## 2. 核心关系的物理收敛

[读取正文](physical-design-postgresql/part-01.md#2-核心关系的物理收敛)

### 2.1 建立循环引用的实际顺序

[读取正文](physical-design-postgresql/part-01.md#21-建立循环引用的实际顺序)

### 2.2 必要约束片段

[读取正文](physical-design-postgresql/part-01.md#22-必要约束片段)

## 3. State、Review 和证据不使用裸多态 ID

[读取正文](physical-design-postgresql/part-01.md#3-statereview-和证据不使用裸多态-id)

## 4. 锁定协议与权限撤销

[读取正文](physical-design-postgresql/part-01.md#4-锁定协议与权限撤销)

## 5. 工作认领、准入与完成 SQL 路径

[读取正文](physical-design-postgresql/part-01.md#5-工作认领准入与完成-sql-路径)

### 5.1 Worker 先锁 Task，再锁 Run

[读取正文](physical-design-postgresql/part-01.md#51-worker-先锁-task再锁-run)

### 5.2 Prepare 与 Admit 分开

[读取正文](physical-design-postgresql/part-01.md#52-prepare-与-admit-分开)

### 5.3 Complete 的完整顺序

[读取正文](physical-design-postgresql/part-01.md#53-complete-的完整顺序)

## 6. 索引与查询清单

[读取正文](physical-design-postgresql/part-01.md#6-索引与查询清单)

## 7. 内容存储、备份与数据保留

[读取正文](physical-design-postgresql/part-01.md#7-内容存储备份与数据保留)

## 8. Migration 拆分与验证出口

[读取正文](physical-design-postgresql/part-01.md#8-migration-拆分与验证出口)

## 9. 完整模块设计的增量落点

[读取正文](physical-design-postgresql/part-01.md#9-完整模块设计的增量落点)

## 10. 本轮验证边界与下一步

[读取正文](physical-design-postgresql/part-01.md#10-本轮验证边界与下一步)

## 11. V001 实际 migration 与兼容性（2026-09-20 实施记录）

[读取正文](physical-design-postgresql/part-01.md#11-v001-实际-migration-与兼容性2026-09-20-实施记录)

### 11.1 实际纳入的表与约束

[读取正文](physical-design-postgresql/part-01.md#111-实际纳入的表与约束)

### 11.2 权限

[读取正文](physical-design-postgresql/part-01.md#112-权限)

### 11.3 留待后续 migration 的引用

[读取正文](physical-design-postgresql/part-01.md#113-留待后续-migration-的引用)

### 11.4 与第 1–6 节的差异

[读取正文](physical-design-postgresql/part-01.md#114-与第-16-节的差异)

### 11.5 迁移兼容性与回滚风险

[读取正文](physical-design-postgresql/part-01.md#115-迁移兼容性与回滚风险)

## 12. 0002 实际 migration 与兼容性（2026-09-20 P02 实施记录）

[读取正文](physical-design-postgresql/part-01.md#12-0002-实际-migration-与兼容性2026-09-20-p02-实施记录)

### 12.1 内容

[读取正文](physical-design-postgresql/part-01.md#121-内容)

### 12.2 兼容性与回滚风险

[读取正文](physical-design-postgresql/part-01.md#122-兼容性与回滚风险)

### 12.3 本批次涉及的锁序（P02 实际写法）

[读取正文](physical-design-postgresql/part-01.md#123-本批次涉及的锁序p02-实际写法)

## 13. P03 内容存储与完成/重开（2026-09-20 实施记录）

[读取正文](physical-design-postgresql/part-01.md#13-p03-内容存储与完成重开2026-09-20-实施记录)

### 13.1 P03 本身没有新增业务 migration

[读取正文](physical-design-postgresql/part-01.md#131-p03-本身没有新增业务-migration)

## 14. 0003 Schema readiness 兼容门（2026-09-21）

[读取正文](physical-design-postgresql/part-01.md#14-0003-schema-readiness-兼容门2026-09-21)

### 13.2 实际内容布局与写入顺序

[读取正文](physical-design-postgresql/part-01.md#132-实际内容布局与写入顺序)

### 13.3 本批次涉及的锁序

[读取正文](physical-design-postgresql/part-01.md#133-本批次涉及的锁序)

### 13.4 残余风险与未落实项

[读取正文](physical-design-postgresql/part-01.md#134-残余风险与未落实项)

## 15. 0004 实际 migration 与兼容性（2026-09-21 P05 实施记录）

[读取正文](physical-design-postgresql/part-01.md#15-0004-实际-migration-与兼容性2026-09-21-p05-实施记录)

### 15.1 内容

[读取正文](physical-design-postgresql/part-01.md#151-内容)

### 15.2 与第 1–6 节的差异与细化

[读取正文](physical-design-postgresql/part-01.md#152-与第-16-节的差异与细化)

### 15.3 本批次涉及的锁序

[读取正文](physical-design-postgresql/part-01.md#153-本批次涉及的锁序)

### 15.4 兼容性与残余风险

[读取正文](physical-design-postgresql/part-01.md#154-兼容性与残余风险)

## 16. 0005 实际 migration 与兼容性（2026-09-22 P06 实施记录）

[读取正文](physical-design-postgresql/part-01.md#16-0005-实际-migration-与兼容性2026-09-22-p06-实施记录)

### 16.1 内容

[读取正文](physical-design-postgresql/part-01.md#161-内容)

### 16.2 与第 1–6 节的差异与细化

[读取正文](physical-design-postgresql/part-01.md#162-与第-16-节的差异与细化)

### 16.3 本批次涉及的锁序

[读取正文](physical-design-postgresql/part-01.md#163-本批次涉及的锁序)

### 16.4 兼容性与残余风险

[读取正文](physical-design-postgresql/part-01.md#164-兼容性与残余风险)

## 17. 0006 Review 与后继验证会话（2026-09-23 P07）

[读取正文](physical-design-postgresql/part-01.md#17-0006-review-与后继验证会话2026-09-23-p07)

## 18. 0007 持久控制与受控 Fake 恢复（2026-09-23 P08）

[读取正文](physical-design-postgresql/part-02.md#18-0007-持久控制与受控-fake-恢复2026-09-23-p08)

## 19. 0008 Fake Gateway 与权限准入（2026-09-23 P09）

[读取正文](physical-design-postgresql/part-02.md#19-0008-fake-gateway-与权限准入2026-09-23-p09)

## 20. 0009 长期信息与规则栅栏（2026-09-23 P10）

[读取正文](physical-design-postgresql/part-02.md#20-0009-长期信息与规则栅栏2026-09-23-p10)

## 21. 0010 Context 来源版本与 Manifest（2026-09-23 P11）

[读取正文](physical-design-postgresql/part-02.md#21-0010-context-来源版本与-manifest2026-09-23-p11)

## 22. 0011 Run 命令、投递与整线程领取（2026-09-24 M03 首片）

[读取正文](physical-design-postgresql/part-02.md#22-0011-run-命令投递与整线程领取2026-09-24-m03-首片)

## 23. 0012 Run 刷新事件（2026-09-24 M03 SSE 后端片）

[读取正文](physical-design-postgresql/part-02.md#23-0012-run-刷新事件2026-09-24-m03-sse-后端片)

## 24. 0013 每 Run 命令顺序与 Review 唤醒（2026-09-24 M03 后端片）

[读取正文](physical-design-postgresql/part-02.md#24-0013-每-run-命令顺序与-review-唤醒2026-09-24-m03-后端片)

## 25. 官方图检查点的独立安装（2026-09-24 M03 后端分片已独立验收）

[读取正文](physical-design-postgresql/part-02.md#25-官方图检查点的独立安装2026-09-24-m03-后端分片已独立验收)

## 26. 固定 Mock Gateway 动作接入现有图（2026-09-24，开发自检中）

[读取正文](physical-design-postgresql/part-02.md#26-固定-mock-gateway-动作接入现有图2026-09-24开发自检中)

## 27. 0015 Assist 会话、消息与类型化提案（2026-09-25 M04 开发自检）

[读取正文](physical-design-postgresql/part-02.md#27-0015-assist-会话消息与类型化提案2026-09-25-m04-开发自检)

## 28. 0016 WEB_FETCH 公共网页只读适配器（2026-09-25 M04 开发自检）

[读取正文](physical-design-postgresql/part-02.md#28-0016-web_fetch-公共网页只读适配器2026-09-25-m04-开发自检)

## 29. 0017 URL 导入与 Knowledge 结算（2026-09-26 M04/P17 开发自检）

[读取正文](physical-design-postgresql/part-02.md#29-0017-url-导入与-knowledge-结算2026-09-26-m04p17-开发自检)

## 30. 0018 统一模型调用事实（2026-09-26 M04 开发自检）

[读取正文](physical-design-postgresql/part-02.md#30-0018-统一模型调用事实2026-09-26-m04-开发自检)

## 31. 0019 DRAFT 读取输入追溯（2026-09-26 M04 开发自检）

[读取正文](physical-design-postgresql/part-02.md#31-0019-draft-读取输入追溯2026-09-26-m04-开发自检)

## 32. 0020 Today 用户选择与 Task 调度元数据（2026-09-26 M05 开发自检）

[读取正文](physical-design-postgresql/part-02.md#32-0020-today-用户选择与-task-调度元数据2026-09-26-m05-开发自检)

## 33. 0021 Activity 范围与精确 Artifact Lineage（2026-09-26 M05/P15 开发自检）

[读取正文](physical-design-postgresql/part-02.md#33-0021-activity-范围与精确-artifact-lineage2026-09-26-m05p15-开发自检)

## 34. 0022 Assist 第一方 Skill 冻结快照（2026-09-26 M04/P12 开发自检）

[读取正文](physical-design-postgresql/part-02.md#34-0022-assist-第一方-skill-冻结快照2026-09-26-m04p12-开发自检)

## 35. 0023 当前 Task Skill 提案与验收版本（2026-09-26 M04/P12 开发自检）

[读取正文](physical-design-postgresql/part-02.md#35-0023-当前-task-skill-提案与验收版本2026-09-26-m04p12-开发自检)

## 36. 0024 内置 ViewConfiguration（2026-09-26 M05/P14 开发自检）

[读取正文](physical-design-postgresql/part-02.md#36-0024-内置-viewconfiguration2026-09-26-m05p14-开发自检)

## 37. 0025 Project Blueprint 候选与来源（2026-09-26）

[读取正文](physical-design-postgresql/part-02.md#37-0025-project-blueprint-候选与来源2026-09-26)

## 38. 0026 真实模型调用预算预留（2026-09-26）

[读取正文](physical-design-postgresql/part-02.md#38-0026-真实模型调用预算预留2026-09-26)

## 39. 0027 Workspace 列表键集索引（2026-09-26 M05/P14）

[读取正文](physical-design-postgresql/part-02.md#39-0027-workspace-列表键集索引2026-09-26-m05p14)

## 40. Project 归档串行化与提交（2026-09-26，无迁移）

[读取正文](physical-design-postgresql/part-02.md#40-project-归档串行化与提交2026-09-26无迁移)

## 41. 0028 Assist 生成中临时草稿（2026-09-26 M04 开发自检）

[读取正文](physical-design-postgresql/part-02.md#41-0028-assist-生成中临时草稿2026-09-26-m04-开发自检)

## 42. 0029 Run DRAFT 生成中临时草稿（2026-09-26 M04 开发自检）

[读取正文](physical-design-postgresql/part-02.md#42-0029-run-draft-生成中临时草稿2026-09-26-m04-开发自检)

## 43. 0030 M06 真实工具能力登记（2026-09-26，开发自检）

[读取正文](physical-design-postgresql/part-02.md#43-0030-m06-真实工具能力登记2026-09-26开发自检)

## 44. 0031 M06 变化集证据账本（2026-09-27，开发自检）

[读取正文](physical-design-postgresql/part-03.md#44-0031-m06-变化集证据账本2026-09-27开发自检)

## 45. 0032 M06 账本来源作用域约束（2026-09-27，定向独立复验）

[读取正文](physical-design-postgresql/part-03.md#45-0032-m06-账本来源作用域约束2026-09-27定向独立复验)

## 46. 0033 M06 桌面 Job 停机证明（2026-09-27，开发自检）

[读取正文](physical-design-postgresql/part-03.md#46-0033-m06-桌面-job-停机证明2026-09-27开发自检)

## 47. 0034 M06 部分文件写入的人工处置（2026-09-27，开发自检）

[读取正文](physical-design-postgresql/part-03.md#47-0034-m06-部分文件写入的人工处置2026-09-27开发自检)

## 48. 0035 M06 冻结计划文本差异证据（2026-09-27，开发自检）

[读取正文](physical-design-postgresql/part-03.md#48-0035-m06-冻结计划文本差异证据2026-09-27开发自检)

## 49. 0036 M06 文件路径物理身份（2026-09-27，开发中）

[读取正文](physical-design-postgresql/part-03.md#49-0036-m06-文件路径物理身份2026-09-27开发中)

## 50. 0037 M06 单文件冻结差异的根相对路径（2026-09-27，开发自检）

[读取正文](physical-design-postgresql/part-03.md#50-0037-m06-单文件冻结差异的根相对路径2026-09-27开发自检)

## 51. 0038 M06 受管资源登记时物理身份（2026-09-28，开发自检）

[读取正文](physical-design-postgresql/part-03.md#51-0038-m06-受管资源登记时物理身份2026-09-28开发自检)

## 52. 0039 M06 已停用资源的同路径重新登记（2026-09-28，开发自检）

[读取正文](physical-design-postgresql/part-03.md#52-0039-m06-已停用资源的同路径重新登记2026-09-28开发自检)

## 53. 0046 M04 Assist Provider 失败类别（2026-09-30）

[读取正文](physical-design-postgresql/part-03.md#53-0046-m04-assist-provider-失败类别2026-09-30)

## 54. 0047 M04 首输出观察时间（2026-09-30）

[读取正文](physical-design-postgresql/part-03.md#54-0047-m04-首输出观察时间2026-09-30)

## 55. 0048 M07 数据库级新工作准入门（2026-09-30，源码实现）

[读取正文](physical-design-postgresql/part-03.md#55-0048-m07-数据库级新工作准入门2026-09-30源码实现)

## 58. 0052/0053 N03 项目知识导读与整理候选（2026-10-02）

[读取正文](physical-design-postgresql/part-03.md#58-00520053-n03-项目知识导读与整理候选2026-10-02)

## 56. 0050 N02 跨成果候选组与组合检查（2026-10-02）

[读取正文](physical-design-postgresql/part-03.md#56-0050-n02-跨成果候选组与组合检查2026-10-02)

## 57. 0051 M07 文件夹入口与对话执行请求（2026-10-02，源码实现）

[读取正文](physical-design-postgresql/part-03.md#57-0051-m07-文件夹入口与对话执行请求2026-10-02源码实现)

## 58. 0054 M04 模型工具循环与 FILE_QUERY（2026-10-03，源码实现）

[读取正文](physical-design-postgresql/part-03.md#58-0054-m04-模型工具循环与-file_query2026-10-03源码实现)

## 59. 0056 M04 本次任务范围授权与一次自动适配留痕（2026-10-04，源码实现）

[读取正文](physical-design-postgresql/part-03.md#59-0056-m04-本次任务范围授权与一次自动适配留痕2026-10-04源码实现)

## 60. 0057 M04 工具调用的 Run 刷新事件（2026-10-04 设计，2026-10-05 源码实现）

[读取正文](physical-design-postgresql/part-03.md#60-0057-m04-工具调用的-run-刷新事件2026-10-04-设计2026-10-05-源码实现)

## 61. 0058 M06 人工动作的 Gateway 来源（2026-10-05 源码实现）

[读取正文](physical-design-postgresql/part-03.md#61-0058-m06-人工动作的-gateway-来源2026-10-05-源码实现)

## 62. 0059/0060 M04 会话模式与人设助手（2026-10-05 源码实现）

[读取正文](physical-design-postgresql/part-03.md#62-00590060-m04-会话模式与人设助手2026-10-05-源码实现)

### 62.1 0059：助手配置与会话身份

[读取正文](physical-design-postgresql/part-03.md#621-0059助手配置与会话身份)

### 62.2 0060：第四种 Gateway 来源与会话级工具账本

[读取正文](physical-design-postgresql/part-03.md#622-0060第四种-gateway-来源与会话级工具账本)

## 63. 0062 自然语言状态维护的请求与变更账本（2026-10-09 源码实现）

[读取正文](physical-design-postgresql/part-03.md#63-0062-自然语言状态维护的请求与变更账本2026-10-09-源码实现)

## 64. 0063 返回项目的日常查看基线（2026-10-09 源码实现）

[读取正文](physical-design-postgresql/part-03.md#64-0063-返回项目的日常查看基线2026-10-09-源码实现)

## 65. 0064 确认时点的适用基线与已确认撤回方案（2026-10-10 源码实现）

[读取正文](physical-design-postgresql/part-03.md#65-0064-确认时点的适用基线与已确认撤回方案2026-10-10-源码实现)

## 66. 0065 日常查看的服务端展示序号（2026-10-10 源码实现）

[读取正文](physical-design-postgresql/part-03.md#66-0065-日常查看的服务端展示序号2026-10-10-源码实现)

## 67. 0066 既有任务的计划调整（2026-10-10 源码实现）

[读取正文](physical-design-postgresql/part-03.md#67-0066-既有任务的计划调整2026-10-10-源码实现)

## 68. 0067 复验整改：DECLINED 终态、解释基线前置与展示签发记录（2026-10-10 源码实现）

[读取正文](physical-design-postgresql/part-03.md#68-0067-复验整改declined-终态解释基线前置与展示签发记录2026-10-10-源码实现)

## 69. 0068 外部成果核对与完成指令（2026-10-10 源码实现）

[读取正文](physical-design-postgresql/part-03.md#69-0068-外部成果核对与完成指令2026-10-10-源码实现)

## 70. 0069 返回轻量核对记录（2026-10-10 源码实现）

[读取正文](physical-design-postgresql/part-03.md#70-0069-返回轻量核对记录2026-10-10-源码实现)

## 71. 0070 自然语言撤回的候选白名单（2026-10-10 源码实现）

[读取正文](physical-design-postgresql/part-03.md#71-0070-自然语言撤回的候选白名单2026-10-10-源码实现)

## 72. 0071 内置工作方法与聊天命令（2026-10-11 源码实现）

[读取正文](physical-design-postgresql/part-04.md#72-0071-内置工作方法与聊天命令2026-10-11-源码实现)

## 73. 0072 学习模式的会话身份与个人学习记录（2026-10-11 源码实现）

[读取正文](physical-design-postgresql/part-04.md#73-0072-学习模式的会话身份与个人学习记录2026-10-11-源码实现)

## 74. 0073 工具续轮的 assistant 协议数据（2026-10-13）

[读取正文](physical-design-postgresql/part-04.md#74-0073-工具续轮的-assistant-协议数据2026-10-13)

## 75. 0074 Task 验收参考材料（2026-10-14）

[读取正文](physical-design-postgresql/part-04.md#75-0074-task-验收参考材料2026-10-14)

## 76. 0075 Task 验收试用记录（2026-10-14 基础协议）

[读取正文](physical-design-postgresql/part-04.md#76-0075-task-验收试用记录2026-10-14-基础协议)

## 77. 0076 验收试用冻结比较（2026-10-14 协议）

[读取正文](physical-design-postgresql/part-04.md#77-0076-验收试用冻结比较2026-10-14-协议)

## 78. 0077 会话验收耗时补录（2026-10-14 协议）

[读取正文](physical-design-postgresql/part-04.md#78-0077-会话验收耗时补录2026-10-14-协议)

## 79. 0078 基础假设记录（2026-10-14 协议）

[读取正文](physical-design-postgresql/part-04.md#79-0078-基础假设记录2026-10-14-协议)

## 80. 0079 决定前提与复审候选（2026-10-14 协议）

[读取正文](physical-design-postgresql/part-04.md#80-0079-决定前提与复审候选2026-10-14-协议)

## 82. 0081 基础下一段工作计划（2026-10-14 协议）

[读取正文](physical-design-postgresql/part-04.md#82-0081-基础下一段工作计划2026-10-14-协议)

## 81. 0080 基础工作段复盘（2026-10-14 协议）

[读取正文](physical-design-postgresql/part-04.md#81-0080-基础工作段复盘2026-10-14-协议)

## 86. 0085 任务链执行规格（2026-10-14 协议）

[读取正文](physical-design-postgresql/part-04.md#86-0085-任务链执行规格2026-10-14-协议)

## 85. 0084 基础有限任务链（2026-10-14 协议）

[读取正文](physical-design-postgresql/part-04.md#85-0084-基础有限任务链2026-10-14-协议)

## 84. 0083 基础一次性项目提醒（2026-10-14 协议）

[读取正文](physical-design-postgresql/part-04.md#84-0083-基础一次性项目提醒2026-10-14-协议)

## 83. 0082 基础范围推演（2026-10-14 协议）

[读取正文](physical-design-postgresql/part-04.md#83-0082-基础范围推演2026-10-14-协议)

## 87. 0088 免费模型目录快照与同步状态（2026-10-15 源码实现，阶段 B）

[读取正文](physical-design-postgresql/part-04.md#87-0088-免费模型目录快照与同步状态2026-10-15-源码实现阶段-b)

## 88. 0089 会话模型选择（2026-10-15 源码实现，阶段 C 首批）

[读取正文](physical-design-postgresql/part-04.md#88-0089-会话模型选择2026-10-15-源码实现阶段-c-首批)

## 89. 0091 输入框草稿辅助的调用证据（2026-10-16 源码实现）

[读取正文](physical-design-postgresql/part-04.md#89-0091-输入框草稿辅助的调用证据2026-10-16-源码实现)

## 90. 0094 会话模型选择的来源组合约束修正（2026-10-16 源码实现，阶段 0 整改）

[读取正文](physical-design-postgresql/part-04.md#90-0094-会话模型选择的来源组合约束修正2026-10-16-源码实现阶段-0-整改)

## 91. 0093 Assist 消息图片附件（2026-10-16 源码实现）

[读取正文](physical-design-postgresql/part-04.md#91-0093-assist-消息图片附件2026-10-16-源码实现)

## 92. 0095 会话模型选择的 OpenRouter 来源反向约束（2026-10-16 源码实现，阶段 0 整改）

[读取正文](physical-design-postgresql/part-04.md#92-0095-会话模型选择的-openrouter-来源反向约束2026-10-16-源码实现阶段-0-整改)

## 93. 0103 GitHub 只读能力（2026-10-17 源码实现，开发自检）

[读取正文](physical-design-postgresql/part-04.md#93-0103-github-只读能力2026-10-17-源码实现开发自检)

## 94. 0104 会话未读标记（2026-10-17 源码实现）

[读取正文](physical-design-postgresql/part-04.md#94-0104-会话未读标记2026-10-17-源码实现)

## 95. 0106 浏览器后端健康投影（2026-10-17 源码实现）

[读取正文](physical-design-postgresql/part-04.md#95-0106-浏览器后端健康投影2026-10-17-源码实现)

## 96. 0107 浏览器任务状态（2026-10-17 源码实现）

[读取正文](physical-design-postgresql/part-04.md#96-0107-浏览器任务状态2026-10-17-源码实现)

## 97. 0108 范围授权词表补全（2026-10-17 源码实现）

[读取正文](physical-design-postgresql/part-04.md#97-0108-范围授权词表补全2026-10-17-源码实现)

## 98. 0109 本地目录访问档位元数据（2026-10-18 源码实现）

[读取正文](physical-design-postgresql/part-04.md#98-0109-本地目录访问档位元数据2026-10-18-源码实现)

## 99. 0110 电脑控制状态的应用角色权限（2026-10-18）

[读取正文](physical-design-postgresql/part-04.md#99-0110-电脑控制状态的应用角色权限2026-10-18)

## 100. 0111 会话活动排序键（2026-10-18 源码实现）

[读取正文](physical-design-postgresql/part-05.md#100-0111-会话活动排序键2026-10-18-源码实现)

## 101. 0112 本地目录完全访问档位（2026-10-18 源码实现）

[读取正文](physical-design-postgresql/part-05.md#101-0112-本地目录完全访问档位2026-10-18-源码实现)

## 102. 0113 会话分叉血缘（2026-10-18 源码实现）

[读取正文](physical-design-postgresql/part-05.md#102-0113-会话分叉血缘2026-10-18-源码实现)

## 103. 0116 会话物理删除授权（2026-10-18 源码实现）

[读取正文](physical-design-postgresql/part-05.md#103-0116-会话物理删除授权2026-10-18-源码实现)

## 103. 0115 周期定时启动任务（2026-10-18 源码实现）

[读取正文](physical-design-postgresql/part-05.md#103-0115-周期定时启动任务2026-10-18-源码实现)

## 104. 0117 Workspace 默认目录（2026-10-19）

[读取正文](physical-design-postgresql/part-05.md#104-0117-workspace-默认目录2026-10-19)

## 105. 0118–0119 长短期记忆（2026-10-19）

[读取正文](physical-design-postgresql/part-05.md#105-01180119-长短期记忆2026-10-19)

## 106. 0122 排队消息的插话意图（2026-10-19 源码实现）

[读取正文](physical-design-postgresql/part-05.md#106-0122-排队消息的插话意图2026-10-19-源码实现)

## 107. 0125 长期记忆自动捕获（2026-10-20，ADR-030）

[读取正文](physical-design-postgresql/part-05.md#107-0125-长期记忆自动捕获2026-10-20adr-030)

## 108. 0126 会话内直接写文件来源（2026-10-20，ADR-031）

[读取正文](physical-design-postgresql/part-05.md#108-0126-会话内直接写文件来源2026-10-20adr-031)

## 109. 0127 聊天目标与计划模式（2026-10-20 源码实现）

[读取正文](physical-design-postgresql/part-05.md#109-0127-聊天目标与计划模式2026-10-20-源码实现)

## 110. 0130 记忆来源类别与自动捕获写入修正（2026-10-21，ADR-032）

[读取正文](physical-design-postgresql/part-05.md#110-0130-记忆来源类别与自动捕获写入修正2026-10-21adr-032)

## 111. 0132 消息文件撤回、前像、保护副本与单层撤销（2026-10-24）

[读取正文](physical-design-postgresql/part-05.md#111-0132-消息文件撤回前像保护副本与单层撤销2026-10-24)

## 112. 0135 会话活动键回填（2026-10-24，缺陷修复）

[读取正文](physical-design-postgresql/part-05.md#112-0135-会话活动键回填2026-10-24缺陷修复)

## 113. 0134 人工受管目录浏览与文件读取（2026-10-24）

[读取正文](physical-design-postgresql/part-05.md#113-0134-人工受管目录浏览与文件读取2026-10-24)

## 114. 0139 项目级长期 Agent 成员（2026-10-25，ADR-034 包 A）

[读取正文](physical-design-postgresql/part-05.md#114-0139-项目级长期-agent-成员2026-10-25adr-034-包-a)

## 116. 0136 Artifact 与 Task 的 Workspace 复合范围约束（2026-10-25）

[读取正文](physical-design-postgresql/part-05.md#116-0136-artifact-与-task-的-workspace-复合范围约束2026-10-25)

## 115. 0140 成员私聊、群聊与消息（2026-10-25，ADR-034 包 B）

[读取正文](physical-design-postgresql/part-05.md#115-0140-成员私聊群聊与消息2026-10-25adr-034-包-b)

