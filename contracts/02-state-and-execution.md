# 契约 02：状态、控制请求与执行权迁移

状态：Proposed。事实 Owner 见 [契约 01](01-facts-and-ownership.md)。

## 1. 三个独立维度

- Task 状态表达工作状态：INBOX / READY / IN_PROGRESS / WAITING / BLOCKED / DONE / CANCELLED。
- Run 状态表达本轮执行：CREATED / CONTEXT_BUILDING / PLANNING / RUNNING / WAITING_APPROVAL / VERIFYING / RETRYING / PAUSED / COMPLETED / FAILED / CANCELLED。
- Task 执行权表达当前谁可以继续工作：HUMAN 或指定 AI Run；不等于用户账号所有权。

Run 终态为 COMPLETED、FAILED、CANCELLED。手动再次执行创建新 Run 并关联原 Run；自动 Retry 增加当前 Run 内 Attempt。已终态 Run 不改回运行态。

V1 非 Delegate 的 AI Assist 不持有自主执行权；若需要自主修改项目资源，走明确的 Delegate 入口。人工确认由 Review 表达，不能借 UI 文案暗中改变 Owner。

## 2. 不变量

1. 一个 Task 至多一个未释放的 AI 执行权占有者；PAUSED / WAITING_APPROVAL 仍占有执行权。
2. 每次授予/转移执行权递增 ownership_epoch。Run 的写提交必须匹配 Task 当前 epoch 和 run_id。
3. Worker 领取还具有独立 lease/claim epoch；Worker 过期与 Task Handoff 是不同事情，两层都要校验。
4. Task 执行权不能替代工作目录排他，资源规则见契约 04。
5. 决定“停止”不等于已停止；在途动作未安全终结时不得把接手完成展示给用户。
6. 终态后的模型迟到回复不得推进状态；在途外部动作的迟到证据仅交给核对流程处理。

## 3. Run 迁移表

表中未列出的迁移一律拒绝。状态迁移、reason、resume_phase、revision 与必要审计在同一事务写入。

| 当前状态 | 事件/条件 | 下一状态 | 关键动作 |
|---|---|---|---|
| CREATED | 获得合法 claim 且无停止请求 | CONTEXT_BUILDING | 复核创建 Run 时已冻结的执行契约，构建当前 Context |
| CONTEXT_BUILDING | 必需上下文齐全 | PLANNING | 保存来源证据 |
| PLANNING | 计划满足固定工作流约束 | RUNNING | 持久保存步骤位置 |
| PLANNING | 恢复时最终产物已提交，待验证或待完成 | VERIFYING | 复用已持久化执行结果，不重新执行成功动作 |
| RUNNING | 非最终执行步骤成功 | RUNNING | 推进下一顺序步骤 |
| RUNNING | 最终候选产物已持久化 | VERIFYING | 创建绑定版本的验证 |
| VERIFYING | 必需条件满足且业务提交成功 | COMPLETED | 只能通过契约 04 的完成用例 |
| VERIFYING | 有可修正问题且预算未耗尽 | RETRYING | 保存失败证据与定向修正目标 |
| RETRYING | 重建上下文并通过契约检查 | RUNNING | 新 Attempt，保留旧版本 |
| 执行中状态 | 明确需要人工判断/授权/限定操作 | WAITING_APPROVAL | reason + blocking Review + resume_phase |
| WAITING_APPROVAL | 阻塞项均合法解决 | CONTEXT_BUILDING | 重新校验后规划剩余步骤，不重放已完成动作 |
| WAITING_APPROVAL | 用户要求按原契约修正，且有预算 | RETRYING | 保存反馈，重新检查原契约仍适用 |
| CREATED/执行中/等待状态 | Pause 请求安全处理完毕 | PAUSED | 保存恢复位置；保留 AI 执行权 |
| 执行中状态 | 连接不可用或必须核对未知动作 | PAUSED | reason=WAITING_CONNECTION / RECONCILIATION_REQUIRED |
| PAUSED | Resume 合法且无未决控制/未知动作 | CONTEXT_BUILDING | 重新检查契约、权限和资源 |
| PAUSED | 恢复时原阻塞 Review 仍未解决 | WAITING_APPROVAL | 返回原等待点，不提前继续执行 |
| 非终态 | Cancel/Handoff 请求安全处理完毕 | CANCELLED | 释放 Run；按下面事件表处理 Task 执行权 |
| 执行中状态 | 不可恢复执行错误，且无未决副作用 | FAILED | 保存原因，释放 AI 执行权 |

“执行中状态”指 CONTEXT_BUILDING / PLANNING / RUNNING / VERIFYING / RETRYING。预算耗尽默认进入 WAITING_APPROVAL + REPEATED_FAILURE，由用户选择新预算、接手或停止，不无限自动重试。

WAITING_APPROVAL 恢复后即使重新走准备阶段，也必须从持久化的剩余步骤继续。已成功的动作不能因为重新构建 Context 就再执行。

PAUSED 的恢复先检查阻塞 Review：仍未解决时进入 WAITING_APPROVAL，否则才进入 CONTEXT_BUILDING。短暂基础设施错误可在原 phase 下进行有界重试，保存独立调用 Attempt；本表的 RETRYING 专指产物修正，不能用它绕过未知副作用核对。

## 4. Task 与执行权事件表

| 用户/系统事件 | Task 结果 | Run 结果 | 执行权 |
|---|---|---|---|
| Delegate 合法任务 | IN_PROGRESS | 创建 CREATED | HUMAN → AI(run_id)，epoch +1 |
| AI 请求必需判断 | WAITING，记录等待原因 | WAITING_APPROVAL | 仍是 AI |
| 用户确认某项结果 | 判断尚未全齐则 WAITING，否则 IN_PROGRESS | 重新校验后恢复 | 不转移 |
| 用户拒绝工具操作 | 不执行该动作；可替代则继续，否则保留待决定 | 不把拒绝伪装成工具失败自动重试 | 不转移 |
| 用户要求修改产物 | IN_PROGRESS | 有预算则 RETRYING，否则保持等待 | 仍是 AI |
| 用户 Pause | WAITING，原因 USER_PAUSED | 安全点后 PAUSED | 仍是 AI |
| 用户 Resume | IN_PROGRESS | CONTEXT_BUILDING | 仍是原 AI Run |
| 用户 Stop AI | READY；有明确业务阻塞则 BLOCKED | 安全结束后 CANCELLED | AI → HUMAN，epoch +1 |
| 用户接手编辑 | IN_PROGRESS | 安全结束后 CANCELLED | AI → HUMAN，epoch +1 |
| 用户取消 Task | CANCELLED | 存在活动 Run 时先走安全停止 | 最终释放 AI 权利；不能先宣称取消已完成 |
| AI 本轮不可恢复失败 | READY 或有依据的 BLOCKED | FAILED | AI → HUMAN，epoch +1 |
| 合法验证且完成提交 | DONE | COMPLETED | AI → HUMAN，epoch +1；保留历史执行者信息 |
| 人工完成 Me/Assist 任务 | DONE，completion_basis=HUMAN | 不伪造 Run | HUMAN |
| 用户重开已完成 Task | READY；重新建立验收契约版本 | 历史 Run 不变 | HUMAN |

WAITING 是工作正在等待，BLOCKED 必须有可解释的业务阻塞依据。Provider 超时本身不能自动制造业务 blocker。

## 5. 持久化控制请求

逻辑字段：request_id、run_id、type(PAUSE/CANCEL/HANDOFF/CANCEL_TASK)、requested_by、requested_at、status(PENDING/APPLIED/REJECTED/SUPERSEDED)、result_ref。Run 保存当前未决请求引用与 revision。

接收命令后先持久化，UI 显示“已请求，等待安全结束”；执行器在领取下一步、执行 Gateway 动作前、完成提交前检查请求。若正执行无法立即中断的操作，记录等待与核对进度。

并发控制请求使用预期 revision 串行裁决：相同 request_id 重复返回原结果；不同意图冲突返回当前待处理请求，不能后到者静默覆盖。若用户明确替换请求，保存 SUPERSEDED 关系。Resume 不能绕过未处理的 Cancel/Handoff。

完成提交与停止请求竞争时由数据库事务确定顺序：完成先提交则停止返回“已完成”；停止先入库则完成用例拒绝继续提交，先处理停止。不得两边都报告成功并留下矛盾状态。

## 6. Handoff 安全点

Handoff 顺序：持久请求 → 禁止新动作 → 当前动作结束或核对 → 确认无旧进程持续写入 → 保存候选产物和交接引用 → 原 Run 终态与 Owner 转移在同一事务完成。

旧动作状态 UNKNOWN 时，不开放新写执行；展示“接手等待核对”。用户只作人工确认不需要 Handoff。用户明确接手后再次 Delegate 创建新 Run，引用最新产物、人工更改和交接证据。

Human Tool 仅授予一个明确的人工步骤，例如手动上传某份文件；不隐含整个工作区编辑权。若该人工步骤修改受管文件，应改走完整 Handoff，再产生新版本。

用户可能在系统外自行编辑文件，系统不能靠 Owner 字段禁止操作；落盘前版本检查及冲突展示见契约 04。

## 7. 验收规格

| 编号 | 场景 | 预期 |
|---|---|---|
| B01 | 并发 Delegate / 重复请求 | 至多一个有效 AI 执行权占有者 |
| B02 | 人工接受验证检查 | Owner 不变；满足条件后恢复或完成 |
| B03 | Pause 入库后刷新/重启 | 请求不丢，下一步不会被继续领取 |
| B04 | Cancel 与完成同时到达 | 事务顺序产生唯一一致结果 |
| B05 | 接手时有在途写动作 | 安全结束/核对前不转交写权 |
| B06 | FAILED 后手动再试 | 新 Run 关联旧 Run，历史不复活 |
| B07 | 不同 Task 写同一根目录 | 遵守资源排他，不只检查 Task Owner |
| B08 | 旧 claim/ownership_epoch 结果返回 | 拒绝业务提交，保留必要核对证据 |
