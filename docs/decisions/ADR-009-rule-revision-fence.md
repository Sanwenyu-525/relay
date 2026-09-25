# ADR-009：P10 使用 Workspace 级 Rule 版本栅栏

## 状态

Accepted（2026-09-23，P10 固定 Workflow 切片）

## 背景

Delegate 需要把适用 Rule 的版本与 CheckPlan 冻结。Rule 创建、更新或退役与 Delegate、步骤领取、Gateway 准入并发时，旧 Run 不能按新规则继续执行；已准入或已发布的效果仍必须按原身份登记与核对。

## 候选方案

1. 每个 Run 保存逐条 Rule 依赖，在每个准入点重算适用集合。影响范围较精确，但需要处理新增上层 Rule、Task/Project 范围变化与多条规则同时修改，当前固定 Workflow 的读取和锁集合会复杂化。
2. Workspace authority 增加单调 `rule_revision`。Rule mutation 持 UPDATE，Delegate/准入持 SHARE；Run 保存该值并在后续安全点比较。实现与测试边界明确，代价是无关 Project 的 Rule 更新也会使旧 Run 失效。

## 最终决策

P10 采用方案 2。Delegate 仍保存全部适用 Rule 的具体 ID/版本作为可追溯依据；`rule_revision` 只负责保守的并发失效裁决。已发生的受管发布或 Gateway Invocation outcome 保留原身份与结果，规则变化只阻止未准入的新动作。旧 Run 通过安全控制结束后按当前 Rule 重新 Delegate。

## 原因与代价

固定 Workflow 与本地单用户工程先需要可证明的锁顺序和安全失效；Workspace 单行 authority 与现有 Permission 撤销协议一致，真实 PG barrier 能覆盖两种提交顺序。代价是影响范围较大，不能把 `RULE_SNAPSHOT_STALE` 解读成“当前 Task 的某条适用 Rule 一定改变”。本阶段 Knowledge/Memory/Decision 尚不自动进入 Context 或 ExecutionContract；它们变成关键输入时，P11 必须另行冻结版本并决定相应失效键，不能复用 Rule 栅栏冒充 Context 依赖追踪。

## 影响范围与后续

影响 0009 migration、Delegate、Run 步骤、Gateway Worker 准入、API 错误以及真实 PG 并发测试；不改变既有 ArtifactVersion/Verification 历史。后续若缩小到逐 Run 依赖版本，须保留新增 Rule 的检测、authority 锁序、已发生效果的核对以及旧快照可读性。
