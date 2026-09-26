# ADR-011：Project 归档采用行锁栅栏与持久事实负面准入

## 状态与日期

Accepted，2026-09-26。仅覆盖当前单机 PostgreSQL Project 归档；独立与桌面验收状态另见测试记录。

## 背景

Project 的 Task、Run、Gateway、Import 与 Assist 各有写入 Owner。单纯设置 `projects.archived_at` 会允许旧事务在归档后提交，也无法证明租约过期的模型或外部动作已安全停止。归档需保留历史，同时阻止未来关联业务写入。

## 候选方案

| 方案 | 优点 | 代价 |
|---|---|---|
| 仅前端禁用按钮与写入口读时检查 | 改动小 | 归档与写提交可竞跑，后台入口可绕过 |
| 将 Project/Task/Run 纳入单个大聚合并全量锁行 | 规则集中 | 与现有 Owner/Task→ProjectState 锁序冲突，扩大事务和死锁面 |
| Project 行作为跨 Owner 的归档串行化点，归档锁下查持久阻断事实 | 不改变事实 Owner，短事务可用数据库锁裁决竞争 | 每个关联写入口必须参加栅栏；阻断清单须随新在途能力维护 |

## 决策

采用第三种。普通 Project 业务写事务在不可逆写前持 `FOR KEY SHARE` 并核对未归档，归档事务先持同一 Project 行的 `FOR UPDATE`。模型调用的 STARTED 预约也先取该栅栏，再锁 Run 或 AssistSession 的预算范围并插入计量行；事务提交后才可外呼 Provider。归档事务不反向锁 Task，而在锁内查询活动执行、未决投递/Step/Attempt/Review、Gateway Operation/Invocation/效果/资源、Import、Assist 与 STARTED 模型调用。任何未安全收敛事实都拒绝；租约时间不作为放行依据。通过后只更新 Project 的 `archived_at/revision`，并同事务写关键审计和命令回执。外部调用不进入数据库事务。

## 原因、代价与影响

先取得栅栏的业务写会在归档检查前提交；归档先提交后，新写会在栅栏处读到归档并拒绝。Task 自身写入仍按既有 Task→Project 顺序，避免归档对所有 Task 加反向行锁。Project 排他路径与其他多对象事务仍可能在数据库层出现死锁；此时整笔事务回滚，不能把死锁当成归档成功或外部效果已知。新增业务在途类型必须进入负面准入，并经真实 PostgreSQL 竞争反例确认；否则不能宣称该类型支持安全归档。当前契约只支持归档，不提供自动恢复归档或自动取消在途工作。

影响应用命令、Project Repository、所有关联写 Owner、HTTP 错误与真实 PG 测试；不新增表或改写 migration。详细字段与错误见 [HTTP 契约](../api/http-command-contract.md)，锁与回执见 [物理设计](../database/physical-design-postgresql.md)。
