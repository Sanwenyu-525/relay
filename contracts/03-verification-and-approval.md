# 契约 03：验证、审批与有效期

状态：Proposed。Owner 和状态迁移见 [契约 01](01-facts-and-ownership.md)、[契约 02](02-state-and-execution.md)。

## 1. 三个不能合并的判断

- 执行成功：工具或 Worker 完成了指定动作。
- 验证通过：某组明确产物在指定验收契约下满足全部必需条件。
- 业务完成：有效验证与当前 Task/执行权匹配，且完成事务已提交。

工具返回成功或模型声明完成都不等于 Verification PASS；PASS 也不能单独替代完成事务。

## 2. 执行与验收契约

Run 开始时绑定以下逻辑内容：Task ID、acceptance_revision、明确的 objective/expected_result、required criteria、Workflow Version、工作配置版本、适用 HARD Rule 版本及关键输入版本。

Task 标题等非实质展示修改不必递增 acceptance_revision。目标、必需产物、验收条件、影响执行的配置变更必须递增对应契约版本。活动 Run 不能静默忽略这种变更。

V1 对实质验收契约变更采用保守策略：记录变更并暂停/安全停止原执行，用户明确重新 Delegate 创建关联的新 Run。可复用旧产物作为输入，但必须按新契约验证。单纯权限收紧立即影响未来动作；解除权限阻塞可在原 Run 上重新判定后恢复。

每个 criterion 至少有稳定 ID、判定陈述、required 标记、检查方式、适用对象。阶段推进若是项目决定，单独作为非阻塞建议；若明确列入此 Task 的 required criterion，就必须满足后才能完成。

## 3. 单项检查与总决策

单项检查使用：PASS / FAIL / UNCERTAIN / ERROR / NOT_RUN / NOT_APPLICABLE。检查结果还要带证据引用、检查器 ID/版本、时间和检查对象。NOT_APPLICABLE 必须由明确适用性规则给出，不能让 Worker 自行豁免必需条件。

Hard / Rule / Semantic 是职责分类，不强制每个任务都执行三个昂贵步骤。能确定性判定的用程序；重要过程约束在动作前阻止，并用执行证据审计；语义质量使用独立上下文判断，必要时交给人。

| 必需检查情况 | Verification 总决策 | 后续 |
|---|---|---|
| 全部满足，无未决必需人工项 | PASS | 尝试业务提交 |
| 明确可修正 FAIL 且有预算 | RETRY | 定向修正，提交新产物版本后再验证 |
| UNCERTAIN、需要责任判断或修正预算耗尽 | HUMAN | 阻塞 Review；不伪装成执行失败 |
| 检查器 ERROR / NOT_RUN | 不产生 PASS | 先有界重试检查本身；仍不可用则暂停或 HUMAN |
| 只有 Preference 不满足 | 记录建议 | 不单独导致 FAIL |

总决策保持 PASS / RETRY / HUMAN；尚未有充分检查结果时 Verification 记录保持未完成，不伪造这三个已决结果。所有必需 HARD 失败都不能被 Semantic PASS 或笼统人工“接受”覆盖。用户可改变验收契约，但新契约要产生新版本并重新走有效性检查。

人工验收是某条 criterion 的 HUMAN 证据，记录判断者与确切对象。Me/Assist 的人工完成保留 HUMAN completion basis，不制造自动检查已经通过的记录。

## 4. PASS 的绑定集合

Verification 至少绑定：

```text
task_id + acceptance_revision
run_id + execution_contract_ref
artifact_version_ids + content_digests
required_rule_versions
verifier_policy_version + checker_versions
critical_input_refs + evidence_refs
```

产物可能是一组文件/结果，验证必须覆盖该次验收所要求的集合，而非随便一个文件。代码检查的证据包含受验代码版本、测试集合/测试配置身份、实际命令配置与检查输出引用。

检查器版本记录用于追溯；升级检查器不自动宣布全部历史结果作废。若发现旧检查器有影响结果的缺陷，显式撤销受影响结果的当前适用性，历史记录保留。完成前是否必须使用新策略由生效策略决定，不能靠版本字符串不同直接全量重跑。

## 5. 有效性与失效表

| 变化 | 对旧验证/批准的处理 |
|---|---|
| 新 Artifact 版本 | 新版本未验证；旧版本历史结论保留 |
| 必需验收条件改变 | 旧 PASS 不能完成新 acceptance_revision |
| 影响该任务的 HARD Rule 改变 | 重新检查兼容性；不能确认兼容则停止并重建契约 |
| 无关 Task / 展示偏好改变 | 不自动使当前 PASS 失效 |
| 关键输入被更正或失效 | 暂停提交，重新验证受影响条件 |
| 审批动作参数、目标或内容改变 | 原批准不可用于新动作 |
| 权限撤销 | 未执行动作必须拒绝；旧批准不能覆盖撤销 |
| 仅出现新产物，但用户明确审核固定旧版本 | 保留对固定旧版本的判断；不自动转移到新版本 |
| Review 语义是“当前待提交版本”而当前选择改变 | 请求过期，重建请求 |
| Task 重开 | 历史 PASS 保留；不能用旧完成凭据直接完成新一轮工作 |

Review 因失效停止可执行，不抹去用户曾批准的历史事实。最终完成事务再核对绑定集合和当前适用性，避免“校验后又变化”的竞争窗口。

## 6. Approval 的精确授权对象

工具审批请求绑定：review_id、run_id、step_id、logical_operation_id、action_type、规范化目标、参数摘要、内容版本/摘要、作用域、请求版本与失效条件。有效期可由动作策略设置，不采用无依据的永久批准。

用户看到操作、目标、影响、原因、内容摘要/可检查差异。Approve/Deny 只针对该请求。拒绝后模型不能通过改工具名称或换 Adapter 绕过同一动作的拒绝。

批准在 Gateway 为相同 logical_operation_id 建立唯一调用记录时被保留/消费；批准与调用意图在同一数据库事务关联。不能“先用掉批准，崩溃后又没有对应动作”。同一动作的恢复仍关联原记录，不把恢复当成无限新授权；安全重试条件见契约 04。

最新 Permission 仍在执行前校验。一次批准不扩大 Scope，不修改永久 AUTO/ASK/DENY，不豁免系统禁止项。不能满足策略的动作保持 DENY，即便 Review 被错误创建也不能执行。

## 7. Verification 的证据边界

DOI 可解析只支持“标识可解析”；引用格式检查只支持“格式合格”。“此来源支持该论断”需要对应正文与语义判断；无法获取正文应标记证据不足。元数据正确、引用存在、论断支持是不同 criterion。

Worker 不决定自己的基准检查集合。测试被修改、删除或跳过必须进入变化证据；受保护基准不可由 Worker 自行削弱。新增测试可以形成新证据，但不能取代原来 required checks。

Verifier 接收验收契约、确切产物、来源和工具证据，不接收 Worker 的自我评价作为结论。独立上下文降低自我确认影响，但不承诺消除模型误判。

## 8. 最小逻辑命令

| 命令 | 核心输入 | 拒绝情形 |
|---|---|---|
| SubmitArtifact | run_id、epoch、内容引用/摘要、预期版本 | 执行权失效、停止请求未决、内容未持久化 |
| RecordCheckResult | verification_id、check_id、对象摘要、证据 | 对象不匹配、检查身份不合法、改写历史结果 |
| ResolveReview | review_id、expected_revision、明确决定、command_id | 请求过期、目标变化、重复 ID 内容不同 |
| RequestCompletion | run_id、verification_id、epoch、command_id | 契约不适用、必要 Review 未解决、有 UNKNOWN |

这些是应用层逻辑命令，不是已经存在的 HTTP 路由。具体 API 命名与错误码需与原接口对齐。

## 9. 验收规格

| 编号 | 场景 | 预期 |
|---|---|---|
| C01 | 产物没变，required 条件改变 | 旧 PASS 拒绝完成提交 |
| C02 | 人工批准 v2，提交 v3 | 批准不继承 |
| C03 | 批准后 Git 目标/内容改变 | 原审批无效，新动作重新判定 |
| C04 | 必需人工项未完成 | Run 不得 COMPLETED |
| C05 | 真实论文不支持引用论断 | 不能因 DOI 可解析就报告整体通过 |
| C06 | 测试删减、验证器超时 | 证据不足/ERROR 不等于 PASS |
| C07 | Preference 不满足、HARD 失败 | 前者不阻止完成，后者不能被语义赞同覆盖 |
| C08 | 来源内容改变 | 验证仍指向当时确切证据；新输入另行检查 |
| C09 | 重复审批/批准保留后重启 | 一个批准只关联一个逻辑动作，不丢失授权对应关系 |
