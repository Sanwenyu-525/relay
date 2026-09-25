# 契约 01：事实来源与唯一写入权

状态：Proposed。范围与未确认项见 [契约索引](README.md)。

## 1. 总原则

每种当前事实只有一个逻辑 Owner。Application 协调用例可在同一事务调用多个模块的写入口，但不能绕过入口修改其存储。Agent、前端、Workbench 视图与 Context Builder 都不是业务事实的写入 Owner。

允许不可变快照、可重建缓存和带版本的副本；禁止多个可独立修改且都被视为最新真相的副本。用户确认记录的是来源与责任，不保证被确认内容在客观上必然真实。

## 2. 所有权表

| 事实 | 唯一写入模块 | 修改入口/来源 | 当前视图与历史规则 |
|---|---|---|---|
| Project 归属、类型、关联 Goal | Project | 用户明确操作 | 活动 Run 期间禁止静默迁移 Task 的 Project |
| Project State | Project | 用户命令、确定性规则、已接受建议 | 增量修改 + revision；保留变更出处 |
| Task 状态、执行模式、验收条件、显式 Goal 对齐 | Task | 用户命令、Application 协调 | 验收契约版本独立于普通展示字段修改 |
| Task 当前执行权与 ownership_epoch | Task | Delegate / Handoff / Run 终止协调 | 至多一个 AI 占有者；epoch 单调递增 |
| Run / Step / Attempt / 控制请求 | Workflow | 执行器通过 Workflow 命令 | 终态不复活；请求与迁移留痕 |
| Artifact 与不可变版本 | Artifact | 内容入库、用户提交、Worker 提交 | 已发布版本不原地覆盖；当前选择另存引用 |
| Verification 证据和结论 | Verification | 检查器、人工检查结果提交 | 历史结论不可被新结果改写 |
| Review 请求与人工决定 | Review | 协调器创建、用户处理 | 请求绑定对象版本；决定不等于完成业务操作 |
| Permission 策略与版本 | Permission | 明确权限设置 | 使用时判定；Review 批准不能改永久策略 |
| Tool Operation / Invocation / 结果 | Gateway | 受控调用与核对流程 | 逻辑动作身份稳定；未知不能当失败重放 |
| Knowledge / Memory | 对应信息模块 | 用户导入/明确保存/确认建议 | 可编辑信息有 revision，历史证据可定位 |
| Decision / Rule | 对应领域模块 | 用户明确决定/规则配置 | 替代、失效可追溯；硬规则与偏好明确 |
| Today 的 Pin / Later / Focus | Today 用户选择存储 | 用户操作 | 按用户、日期及所用时区保存 |
| Today 排名、Human Summary、Agent Context | 无独立业务写权 | 从上述事实装配 | 带来源版本；可缓存，不反向充当事实 |

表中模块为逻辑责任，不要求一行一个工程、Service 或数据库表。

## 3. Project State 字段契约

| 字段 | 本版语义 | 更新与失效 |
|---|---|---|
| phase_key | Project Type 定义的阶段标识 | 用户明确修改；AI 只建议。V1 不隐含自动阶段跳转 |
| completed_highlight_refs | 当前仍适用的已完成 Task/里程碑依据 | 通过来源事实解析，不复制 Task 状态；重开后不再算当前完成 |
| in_progress | 当前工作的派生视图 | 从 Task/执行权计算，不维护第二份状态清单 |
| blockers | 已阻止特定工作的约束 | 必须含目标引用、原因、来源；仅在明确解除条件满足时自动解除 |
| risks | 可能影响工作的已确认风险 | AI 观察先作建议；不能从文本相似自动认定已解决 |
| next_action_task_id | 用户选定或已接受的项目推进方向 | 不代表全局优先级；不满足执行条件时展示原因，不推荐 Start |
| key_decision_refs | 当前关键决定的引用 | 解析状态；SUPERSEDED 不作为有效决定注入 |
| key_artifact_version_refs | 明确选择的产物版本 | 新版本不自动替换；撤销/不适用时显示原因 |

`revision` 覆盖 Project State 自有字段修改。组合视图还应携带依赖对象的版本清单或等价快照标识，不能用一个 State revision 冒充所有 Task/Decision 都没变化。

必要的确定性完成 delta 可以只更新引用/审计，不要求每个完成任务都进入 highlights。阶段建议独立创建，非必需建议不阻塞 Task 完成。

## 4. 状态修改命令

逻辑输入：`project_id, expected_revision, command_id, typed_changes, source_type, source_ref`。

仅开放已定义操作，如选择 Next Action、增加有依据的 highlight、增改风险、用户设置阶段。不接收模型任意覆盖全对象，不接受任意字段路径赋值。

处理顺序：校验权限与来源 → revision 比较 → 引用有效性 → 领域规则 → 保存新 revision 与变更记录。revision 冲突不采用 last-write-wins；返回当前版本，由调用方重建意图。相同 command_id 与相同请求重复返回原结果；相同 ID 不同请求拒绝。

AI 建议独立保存 `base_revision + changes + evidence_refs`；批准时重新检查，过期后不自动套用。确定性来源必须有明确映射规则，不能仅因为 LLM 输出了 structured JSON 就视为确定性事实。

## 5. Project、Goal 与 Inbox

- Delegate 和所有项目工具调用要求 Task 唯一 Project。未满足条件时拒绝启动，不让模型猜默认目录。
- Me 可在 Inbox 中处理并完成无 Project 小事项；不因此伪造 Project State delta。
- 无 Project 的 AI Assist 只提供建议；使用项目资料/工具前选择 Project 并建立作用域。
- Task 无显式 Goal 对齐时，在读取时继承 Project 当前 Goals；显式对齐只能选同 Workspace 且已关联 Project 的 Goals。
- 解除 Project–Goal 关联时，若存在显式 Task 对齐，返回受影响清单，要求在同一个明确操作内清理；不静默遗留无效关系。
- 存在活动 Run、待核对动作或待完成交接时，不允许 Task 跨 Project 迁移。

## 6. Rules 与长期信息

Rule 必须表达 `scope, strength(HARD/PREFERENCE), applicability, revision, enforcement`。enforcement 明确是程序强制、程序事后检查、语义检查或人工判断；自由文本不自动获得确定性检测能力。

Hard Rule 合并不得由下层放宽；Preference 可以按更具体作用域覆盖。无法同时满足的硬规则阻止执行并请求解决。用户可在有权管理的规则来源层明确修改；一次工具批准不能当作永久规则变更。

“优先原始论文”默认是 Preference；若要必需使用原始来源，明确改写为 HARD 并提供检查方法。“新建分支”和“在非保护分支工作”是不同规则，不互相替代。

归类原则：当前进度进 State；正式技术选择进 Decision；执行约束进 Rule；长期偏好进 Memory；可供阅读的资料进 Knowledge。其他层需要相同内容时引用 Owner；Decision 类型的 Memory 仅保存引用。

## 7. Workbench 与 Context

查看不同 Workbench 是展示选择，不影响活动 Run 的规则、工作流或权限。修改 Task 工作配置是显式命令，递增执行契约版本，按 [契约 03](03-verification-and-approval.md) 处理失效。

Run 绑定 Workflow/工作配置版本。最新安全约束和权限对未来动作生效，不能凭旧快照继续执行被撤销的动作；旧动作保留当时的执行证据。

Context 来源至少包含来源 ID、版本/内容摘要、实际使用片段或可读取的不可变版本、截取范围、构建器/模板版本。只保存 URL 或当前文件路径不满足历史证据重建要求。保存敏感片段应最小化并排除凭据；若内容已按保留策略移除，明确“历史正文不可用”，不伪装可完整复现。

Human Summary 缓存携带来源版本并在过期时刷新或标记。Context 裁剪不能去掉必需约束；超预算应缩小任务或停止构建并说明原因。检索内容和工具结果永远不能自行提升为 Rule 或 Permission。

## 8. Today

候选从所有可开始/可继续的 Task 产生，不只取每项目一个 Next Action。先过滤未满足依赖、已取消、AI 正持有执行权等不适合人工开始的工作，再排序。Pin 只影响合格候选的排序；Later 按用户确认的本地日期生效；Focus 是用户选择的结果目标。

推荐理由由实际命中的规则生成，不凭空写出风险、预计分钟或完成百分比。排序和摘要可重建，用户的 Pin/Later/Focus 必须可恢复。

## 9. 验收规格

| 编号 | 场景 | 预期 |
|---|---|---|
| A01 | AI 提交完整 State 覆盖对象 | 拒绝；只能执行已定义增量 |
| A02 | State r7 建议在 r8 后被批准 | 不覆盖 r8，重新校验/重建建议 |
| A03 | 完成任务被重开、Decision 被替代 | 当前视图与新 Context 不再使用过期完成/决定，历史不删除 |
| A04 | Task 偏好与上层 HARD 冲突 | 不放宽；明确冲突 |
| A05 | 运行中切换浏览工作台 | Run 执行契约和适用硬边界不变 |
| A06 | 原网页/文件更新 | 能定位运行当时所用证据，或明确其不可用 |
| A07 | Later 后刷新/重启、Pin 阻塞任务 | Later 保留；Pin 不突破执行条件 |
| A08 | 无 Project 的 Me/Delegate | Me 可完成；Delegate 被拒绝 |
| A09 | Project Goal 关联改变 | 默认继承随之更新；显式关联冲突被处理 |
