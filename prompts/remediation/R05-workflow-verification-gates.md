# R05：P05/P06 独立验收阻塞项修复

日期：2026-09-23。执行配置：`gpt-5.6-terra / xhigh`。这是本轮修复提示词，不是 P07 的实施授权。主 Agent 负责独立验收。

执行状态：已下发 Terra 并完成；主 Agent 最终源码独立复跑 57/57 单测、113/113 真实 PG 集成通过，见[修复后验收记录](../../docs/testing/frontend-backend-acceptance-2026-09-21.md#9-r05-修复后独立复验2026-09-23)。以下保留原始执行任务与修复前证据要求，不应无条件重复执行。

## 可直接交给 Terra 的提示词

```text
你是本轮 Terra 执行子代理，工作区 D:/Develop/Relay-Agent，使用 gpt-5.6-terra / xhigh。所有汇报用中文。完成 R05 的实现、回归测试与必要文档同步后交回主 Agent，不继续 P07/P08。

先读 AGENTS.md、CODEX_NEXT_STEP.md、prompts/README.md 的公共约束与本地源码参考要求，以及 docs/testing/frontend-backend-acceptance-2026-09-21.md 第 8 节。再定向读 contracts/02-state-and-execution.md、contracts/03-verification-and-approval.md、contracts/04-recovery-and-commit.md、docs/api/http-command-contract.md 第 10 节、docs/database/physical-design-postgresql.md 第 15/16 节。

你并非独自在仓库工作。保留他人改动，不使用 reset/clean 或批量覆盖；当前仓库大量文件未跟踪，不把 untracked 当可删除文件。你的所有权范围是 apps/api 中 R05 必需的应用用例、Repository、最小业务校验和测试，以及相应 HTTP/物理设计文档的实现说明。主 Agent 维护 CODEX_NEXT_STEP、验收记录、README 与提示词状态；报告供主 Agent 更新，不与其争写。不要自动提交或 push。

已有基线：主 Agent 独立复跑 API strict typecheck/build、57/57 单测、109/109 真实 PG 集成；Workbench typecheck/build、80/80 组件、19/19 Chromium 均通过。但两个额外真实 PG 反例失败，故不能沿用“P05/P06 完成且可验收”的结论。原测试数量只是修复前基线，不是本次目标数字。

R05-01（P1）：自动完成忽略冻结契约中的 expected_outputs.artifacts。
复现：在 Delegate 之前合法保存 required_output_spec={artifacts:['MARKDOWN_DOCUMENT','TEST_REPORT']}，配一条 required MARKDOWN_STRUCTURE criterion；固定 Workflow 只产出 MARKDOWN_DOCUMENT，VERIFY PASS 后 COMPLETE 仍成功、Task=DONE。TEST_REPORT 在当前系统是不支持的种类，这个反例要求拒绝，绝不是要求增加该产物类型。人工完成已明确拒绝未知种类和非数组形态，自动路径不能静默放行。
重点文件：src/application/complete-run.ts、delegate-task.ts、completion-commands.ts、workflow/execution-contract.ts、workflow/check-plan.ts。
最小修复：复用或提取人工路径已有的产物要求校验，保证自动路径对冻结要求和确切验收版本集合做 fail-closed 核对；可以在 Delegate 提前拒绝固定 Workflow 无法满足的要求，但 COMPLETE 必须守住已存在 Run 的提交边界。不要仅修改文案或清空用户要求，不新增通用产物框架。合法单 Markdown、无产物要求的既有约定保持一致。拒绝不能写完成凭据、State delta 或成功审计；保持现有 COMPLETION_BLOCKED 无新增尝试/业务写入的约定，若选择别的明确错误语义必须说明并同步契约。
回归：未知种类、非数组、合法 Markdown、既有 Run 冻结了不可满足要求、验证目标不足时拒绝，以及人工完成原有行为。入口拒绝场景至少经真实 HTTP 验证一次，完成 Gate 用真实 PG 内部应用端口验证。

R05-02（P1）：迟到结果破坏当前有效 claim。
复现：某 StepAttempt 当前 RUNNING/claim_epoch=1；recordStaleAttemptResult 用 epoch=0 提交，markAttemptRejectedStale 把当前行改成 REJECTED_STALE；随后 epoch=1 的合法结果也 accepted=false。原 B08 测试只断言旧结果被拒，并未断言有效领取者仍能提交。
重点文件：src/application/run-steps.ts 的 recordStaleAttemptResult、src/run/run-repository.ts 的 markAttemptRejectedStale/recordAttemptOutcome。
最小修复：拒绝旧 claim 的业务提交并保存必要核对证据，同时保持当前有效 attempt 的 status、epoch、worker、lease、result 不被旧提交污染；利用现有审计/证据入口即可，不为此提前建设 P08 调度器。有效结果须经当前归属与 CAS 等现有约束；重复和终态结果不回写历史。核查读取与写入之间的竞争，不以进程内 mutex 代替 PG 条件更新/锁。原测试中把当前行改成 REJECTED_STALE 的断言应按契约纠正，同时保留迟到拒绝和步骤不推进的原检查，不能删除覆盖。
回归：旧 epoch 拒绝且当前 claim 完整保留；之后正确 epoch 成功；成功后迟到/重复不污染终态；真实 PG 下旧与新结果竞争，结果必须可确定地核对。优先 barrier 或明确锁同步，不用随机 sleep 冒充竞争证明。

开始前用正式回归用例复现问题，再最小修复。历史临时探针 .planning/acceptance-2026-09-23/probe.mjs 和 probe.log 只作定位依据：探针会临时改 dist 然后还原，不应成为正式测试入口，也不要与 build 并发运行。把验证移入源码测试。通用 fencing 机制按 prompts/README 定向核对本地固定版本上游资料；纯产物集合业务规则无需强套框架。

验证使用仓库便携 Node 24.21.0、PostgreSQL 18.6；不读取宿主凭据、不碰用户库、不修改系统运行时。使用 apps/api/scripts/run-integration.ps1 创建隔离 PG，确认停止和临时目录清理。必须跑 strict typecheck、build、单测、全量真实 PG 集成和 node scripts/check-docs.mjs；不要为无前端改动重复全部视觉测试。已应用 migration 不改写；确实需要 schema 时才新增 migration 并解释必要性。API 行为收紧标明 Breaking Change 与兼容策略，历史测试数字保留为历史。

交付：两个问题的根因、改动文件、最小复现与修复后断言、实际命令/测试数量、PG 清理结果、文档变更及剩余限制。不要将 Fake Runtime、局部 fencing 测试称为真实 Provider、完整恢复、P07 Review 或 Windows 安装交付。完成即停止，由主 Agent 独立复验后决定是否进入 P07。
```
