# B：Fake Workflow、验证与 Review

> 当前执行入口为 [M01–M07](stack-migration.md)。本文件保留原 P 阶段业务范围；模型统一 gpt-6-sol / ultra，UI 使用完整 React 迁移路线，技术选择按 ADR-010。不得按旧编号重建工程；前置与验收按公共契约及当前授权执行，后置不等于通过。

## P05：固定流程与 Fake Runtime

```text
执行 P05，前置 P03。读 AGENTS.md、prompts/README.md、contracts/02-state-and-execution.md、docs/architecture/runtime-context.md、docs/database/physical-design-postgresql.md。
源码对照：按公共“本地源码参考要求”从 .research 定向核对 Pi loop/取消、Codex 轮次事件及采用表涉及的恢复机制；报告具体实现/测试与本项目固定 Workflow 的差异，不因进入实现阶段丢弃 P00 依据。
范围：Workflow/Run/Step/Attempt、Delegate、FakeModelPort、受约束步骤结果、相关 migration/API。创建 Run 时冻结验收契约；BUILD_CONTEXT 不重写快照。Task owner 与 worker claim 分开，PAUSED/WAITING_APPROVAL 仍占业务执行权；终态不复活，人工重试新 Run/retry_of。
按 P00 的采用表实现 markdown-deliverable-v1 固定步骤和最小 runtime 适配；优先复用已验证执行能力，不另写重复 Agent loop。先用固定上下文 fixture，不提前写通用 Builder。模型/存储在事务外，应用层推进，Runtime 不写 Task DONE。没有 P06/P07 时最终候选保持待验证，不以 Fake PASS 假报完成。
测试 B01/B06/A08：并发 Delegate 最多一个 live Run、重复命令、无 Project 拒绝、已终态重试、步骤结果去重和迟到 epoch。用真实 PG，不能仅进程内 mutex。文档注明此阶段只运行 Fake 无外部副作用，交付给 P06。
```

## P06：Verification 与完成 Gate

```text
执行 P06，前置 P05。读 AGENTS.md、prompts/README.md、contracts/03-verification-and-approval.md、contracts/04-recovery-and-commit.md、docs/architecture/runtime-context.md。
范围：CheckPlan/Checker registry、Session/CheckResult、PASS/RETRY/HUMAN、修正预算、自动完成用例。验收/规则/输入/产物/hash/检查器版本都绑定；Checker ERROR/NOT_RUN 不得算 PASS。Worker 无权删 required checks、改基准或自我验收。
产品补充核对：按公共执行映射读取工作台第 11.3 节。交付中列出重要验收行为对应的检查/人工证据和缺口，区分检查未建立、未运行、错误与旧证据不再适用；不新增一套状态枚举，不以全部现有测试通过证明要求完整覆盖。已实现部分仅做本次必要增量和回归。
实现 Markdown/引用存在等确定性检查及 FakeSemanticChecker，真实语义接入由 P12 完成。HARD 失败不能被语义赞同或笼统人工接受覆盖；Preference 不单独失败。修正创建新产物/Session，检查器故障重试检查器而不生成新产物。预算耗尽产生待人工请求契约，P07 连接 UI。
完成仍经统一短事务，PASS 保存后可仅重试提交。测试 C01–C08 相关条件、D04/D05、真引用不支持结论、基准删减、验证撤销与更新验收。报告 Fake 边界，不声称验证器能保证事实绝对正确。
```

## P07：Review 与人工判断

```text
执行 P07，前置 P06。读 AGENTS.md、prompts/README.md、contracts/02-state-and-execution.md、contracts/03-verification-and-approval.md、docs/api/http-command-contract.md、docs/frontend/workbench-design.md。
范围：Review 类型绑定、请求/决定/效果、Inbox UI、产物判断/修正/预算、State 提案接受。决定与 DB 效果同事务；Approve 不等于外部执行，Review 不转 Task owner。动作批准预分配 operation 身份，消费由 P09 衔接。
请求绑定确切版本、hash、目标及有效期；重复相同决定幂等，目标过期拒绝，固定旧版本接受不转移给新版本。状态建议必须 base_revision 和类型化命令，不由模型全量覆盖 State。先解决 P06 必需 HUMAN 再允许完成。
产品补充核对：读取工作台第 11.1 节，既有待审入口应说明为什么需要人、当前对象和可选决定；集中查看不等于批量批准，未知延后影响不得编造。统一跨项目队列、通知阈值和积压控制仍按公共映射先定范围，不把每条进度事件都转成 Review 或自行新增后台提醒。
验证 B02、C02/C03/C04/C09、A02：决定后仍保留执行权、不同版本拒绝、审批重启不丢、预算改变有限、拒绝操作不伪装失败自动重试。UI 展示对象/证据/影响，禁止一个含糊“继续”按钮。交付后进入 P08。
```
