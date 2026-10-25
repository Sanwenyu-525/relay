# Runtime、Workflow、Context 与 AI Assist

2026-10-11 已确认产品增量：[第 8 节](#8-会话压缩与消息文件恢复)记录优先适配 DeepSeek 的压缩、持久接续和消息文件恢复边界；2026-10-19 普通 AGENT 记忆接续见该节与 ADR-028，不能用早期“新增机制未实施”覆盖后续源码。2026-10-24 消息文件回退首版后端与消息入口已落地（迁移 0132，HTTP §10.111）；发送前基线语义、受影响任务重开与完整验收仍未闭合，见 §8.5。既有 Run、会话身份、Gateway、计量及业务完成 Owner 保留，具体协议与参数仍须按该节冻结。

> 当前接续（2026-09-24）：[ADR-010](../decisions/ADR-010-agent-stack-react-desktop.md)选择的 LangGraph.js 1.4.17 与官方 PostgresSaver 1.0.5 已接入 M03 固定 Mock Workflow，后端固定图分片已独立验收，整体验收仍待 G01–G08。PG 持久 command/outbox 负责分发；一个 Run 只使用一个图线程，节点复用既有 `advanceRunStep` 业务入口。旧的 AI SDK Core/ToolLoopAgent 推荐仅保留历史解释。M03 Mock 创建、SSE、审批、取消和故障恢复整体验收通过后才进入真实 Provider。Run/Review/Gateway/完成仍归既有 Owner，检查点不能替代业务事实或外部效果核对。

日期：2026-09-19。状态：Proposed。状态迁移唯一事实源：[契约 02](../../contracts/02-state-and-execution.md)；验证：[契约 03](../../contracts/03-verification-and-approval.md)。


<!-- DOC-ROUTER -->

> 本文件现为专题路由。完整正文已按原章节迁入下列分册，原章节标题与锚点保留为跳转入口；不要把路由文件当作完整规格读取，也不要在此追加实现正文。

## 分册导航

先按标题定位；命中后读取对应正文及其必要的公共规则。新内容修改所属分册，新增章节同步本路由；跨章依赖不因拆分而消失。

| 分册 | 章节范围 |
|---|---|
| [分册 01](runtime-context/part-01.md) | 1. 运行职责与模型端口 → 2.6.4 控制与停止 |
| [分册 02](runtime-context/part-02.md) | 2.7 普通 Agent 的连续工作轮次（2026-10-15，已确认、待重构） → 8.4 当前缺口与冻结条件 |
| [分册 03](runtime-context/part-03.md) | 8.5 消息发送前文件基线与恢复 Owner → 10.1 现状分级与证据缺口（2026-10-21 差距核对） |

## 原章节路由

以下仅保留兼容锚点，具体规则只在链接的正文维护。

## 1. 运行职责与模型端口

[读取正文](runtime-context/part-01.md#1-运行职责与模型端口)

## 2. 固定 Workflow

[读取正文](runtime-context/part-01.md#2-固定-workflow)

### 2.1 Relay 内部工具循环接入方向（2026-10-03）

[读取正文](runtime-context/part-01.md#21-relay-内部工具循环接入方向2026-10-03)

### 2.2 内部工具循环实施与验收顺序（2026-10-03，推荐方案）

[读取正文](runtime-context/part-01.md#22-内部工具循环实施与验收顺序2026-10-03推荐方案)

### 2.3 内部工具循环的对象、身份与恢复（2026-10-03 实施设计）

[读取正文](runtime-context/part-01.md#23-内部工具循环的对象身份与恢复2026-10-03-实施设计)

### 2.4 会话执行计划的归属与持久更新（推荐设计）

[读取正文](runtime-context/part-01.md#24-会话执行计划的归属与持久更新推荐设计)

### 2.5 有界子 Agent 的委派与会话关联

[读取正文](runtime-context/part-01.md#25-有界子-agent-的委派与会话关联)

#### 2.5.1 对象、责任与复用差异

[读取正文](runtime-context/part-01.md#251-对象责任与复用差异)

#### 2.5.2 身份、短事务与输入版本

[读取正文](runtime-context/part-01.md#252-身份短事务与输入版本)

#### 2.5.3 能力、预算与消息来源

[读取正文](runtime-context/part-01.md#253-能力预算与消息来源)

#### 2.5.4 失败、控制与恢复

[读取正文](runtime-context/part-01.md#254-失败控制与恢复)

### 2.6 会话级只读工具轮次

[读取正文](runtime-context/part-01.md#26-会话级只读工具轮次)

#### 2.6.1 为什么复用既有生成身份，而不是另建一条执行链

[读取正文](runtime-context/part-01.md#261-为什么复用既有生成身份而不是另建一条执行链)

#### 2.6.2 只读动作仍然走 Gateway

[读取正文](runtime-context/part-01.md#262-只读动作仍然走-gateway)

#### 2.6.3 两条容易被写错的边界

[读取正文](runtime-context/part-01.md#263-两条容易被写错的边界)

#### 2.6.4 控制与停止

[读取正文](runtime-context/part-01.md#264-控制与停止)

### 2.7 普通 Agent 的连续工作轮次（2026-10-15，已确认、待重构）

[读取正文](runtime-context/part-02.md#27-普通-agent-的连续工作轮次2026-10-15已确认待重构)

#### 2.7.1 主流程的最小持久协议（2026-10-15 实施前核对结果）

[读取正文](runtime-context/part-02.md#271-主流程的最小持久协议2026-10-15-实施前核对结果)

### 2.8 新会话的默认工作目录作用域（2026-10-18，已确认、待实施）

[读取正文](runtime-context/part-02.md#28-新会话的默认工作目录作用域2026-10-18已确认待实施)

### 2.9 排队消息的「插话」进入上下文的方式（2026-10-19，已实施）

[读取正文](runtime-context/part-02.md#29-排队消息的插话进入上下文的方式2026-10-19已实施)

#### 连续插话与方向变化（2026-10-20，已授权、源码实现）

[读取正文](runtime-context/part-02.md#连续插话与方向变化2026-10-20已授权源码实现)

### 2.10 日常工具工作与正式交付分层（2026-10-20 实施）

[读取正文](runtime-context/part-02.md#210-日常工具工作与正式交付分层2026-10-20-实施)

#### 2.10.1 推进 Owner 收归服务端与能力事实说明（2026-10-20 第二轮）

[读取正文](runtime-context/part-02.md#2101-推进-owner-收归服务端与能力事实说明2026-10-20-第二轮)

## 3. Context Builder 管道

[读取正文](runtime-context/part-02.md#3-context-builder-管道)

### P11 当前实现边界（2026-09-23）

[读取正文](runtime-context/part-02.md#p11-当前实现边界2026-09-23)

## 4. 检查器与总判定

[读取正文](runtime-context/part-02.md#4-检查器与总判定)

## 5. AI Assist 与提案

[读取正文](runtime-context/part-02.md#5-ai-assist-与提案)

### P12 当前实现边界（2026-09-25，M04 开发自检）

[读取正文](runtime-context/part-02.md#p12-当前实现边界2026-09-25m04-开发自检)

## 6. 可验收结果

[读取正文](runtime-context/part-02.md#6-可验收结果)

## 7. 产品 Agent 提示词与输入协议

[读取正文](runtime-context/part-02.md#7-产品-agent-提示词与输入协议)

## 8. 会话压缩与消息文件恢复

[读取正文](runtime-context/part-02.md#8-会话压缩与消息文件恢复)

### 8.1 模型容量、工作预算与压缩时机

[读取正文](runtime-context/part-02.md#81-模型容量工作预算与压缩时机)

### 8.2 DeepSeek 的协议与缓存

[读取正文](runtime-context/part-02.md#82-deepseek-的协议与缓存)

### 8.3 接续摘要与持久恢复

[读取正文](runtime-context/part-02.md#83-接续摘要与持久恢复)

### 8.4 当前缺口与冻结条件

[读取正文](runtime-context/part-02.md#84-当前缺口与冻结条件)

### 8.5 消息发送前文件基线与恢复 Owner

[读取正文](runtime-context/part-03.md#85-消息发送前文件基线与恢复-owner)

### 8.6 模型目录、会话选择与免费调用边界

[读取正文](runtime-context/part-03.md#86-模型目录会话选择与免费调用边界)

## 9. 聊天目标与计划模式的运行边界

[读取正文](runtime-context/part-03.md#9-聊天目标与计划模式的运行边界)

## 10. 七种 Agent 模式的实现映射

[读取正文](runtime-context/part-03.md#10-七种-agent-模式的实现映射)

### 10.1 现状分级与证据缺口（2026-10-21 差距核对）

[读取正文](runtime-context/part-03.md#101-现状分级与证据缺口2026-10-21-差距核对)

