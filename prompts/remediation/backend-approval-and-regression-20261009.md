# 后端整改：人工批准材料绑定与全量回归收口

日期：2026-10-09。状态：**已执行（2026-10-09，由当前 Agent 单独完成，未派子代理）。** 输入来自 2026-10-08 后端独立验收；实际结果只归[功能验收表](../../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)，当前进度只归[CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)。实施落点：新增 `apps/api/src/application/approval-check-material.ts`；改动 `gateway-actions.ts`、`review-decisions.ts`、`tool-loop-action.ts`、`check-trust-gate.integration.test.ts`、`verification.integration.test.ts`、`backup-history.integration.test.ts`、`database-maintenance-boundary.integration.test.ts`、`integration-support.ts` 与 `run-integration.ps1`。规则归[工具适配器 §1.6](../../docs/architecture/tool-adapters.md#16-写差异与检查工具2026-10-04-实施)，正式场景归[测试计划 §20.10](../../docs/testing/verification-plan.md#2010-检查入口的信任摘要与检查证据适用性2026-10-07-实施)。原始输出留本机忽略目录 `output/acceptance-raw/backend-remediation-20261009/`，未提交 Git。

以下正文为下发时的任务书，保留原文不再随实施结果改写。下文提到「本次编写提示词不启动开发」，指的是编写当时；该任务已于 2026-10-09 实际执行。

以下正文可直接交给执行 Agent。用户实际下发本任务后，授权范围为所述后端修复、测试基建整改、复验与必要文档同步；本次编写提示词不启动开发。

## 可直接使用的提示词

你在 `D:/Develop/Relay-Agent` 工作。接续当前实现，修复最新后端验收发现的人工批准材料绑定缺陷，并处理阻碍可信全量回归的测试问题。**整个任务由你单独完成，不派子代理，不创建其他聊天，不向其他任务发送材料。** 历史任务书中的强制并行要求不适用于本任务。全部解释和交付说明使用中文。

先读现有事实与失败证据，再给出简短计划并执行。不要停在方案、静态检查或单套件通过；按真实失败修复、复验，直到本任务的出口闭合，或明确记录无法独立解除的实际阻塞。例行读取、可逆修复、构建、临时数据库测试和文档维护直接推进。

### 1. 范围、基准与必读输入

本任务依次完成三个部分：A 人工批准与检查材料绑定；B 测试隔离、迁移完整性断言和完成验证 fixture；C 当前源码的后端回归与文档收口。保留已经闭合的检查入口解析、环境文件材料核对、取消/暂停、UNKNOWN、原动作身份与权限撤销保护，不重新实现旧任务。

开工阅读：

- [AGENTS](../../AGENTS.md)、[当前进度](../../CODEX_NEXT_STEP.md)、[文档地图](../../docs/README.md)及[当前验收表](../../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)。
- [验证与批准契约](../../contracts/03-verification-and-approval.md)、[恢复与提交契约](../../contracts/04-recovery-and-commit.md)；涉及 Owner、执行权或状态时再读契约 01/02。
- [领域模型](../../docs/architecture/domain-model.md)、[工具适配器 §1.6](../../docs/architecture/tool-adapters.md#16-写差异与检查工具2026-10-04-实施)、[测试计划 §20.10](../../docs/testing/verification-plan.md#2010-检查入口的信任摘要与检查证据适用性2026-10-07-实施)，尤其 CT-11 及完成验证的两个独立门。

原始证据位于本机忽略目录 `output/acceptance-raw/backend-acceptance-20261008-01a11be3/`。优先读 `summary.json`、`full-failures.json`、`approval-observations.json` 和 `approval-probe-r2.log`；定位具体失败后再读对应日志。不要把全量输出提交到 Git，也不要把私有编译探针当作正式测试源码。

以下仅是 **2026-10-08 的验收基准**，不是修复后成绩：

- HEAD `216a41badb24d0579bbd63c1efaaf2e1952bdc86` 加当时未提交源码；448 个后端输入前后无漂移，Node v24.21.0，API 类型检查、编译与 native helper 构建通过。
- 单元 487 条：485 通过、1 失败、1 跳过，exit 1。`restore-isolation` 全量中启动超时，独跑 7/7 通过；不能据此抹去全量失败。
- 真实 PostgreSQL 全量 70 个源码套件、776 条：718 通过、44 失败、14 跳过，exit 1。共享队列/维护状态与旧断言已有证据，其他失败仍须逐项归因。
- 人工批准探针：未漂移对照通过，两条再次修改脚本的反例失败，均真实执行 `UNAPPROVED_SCRIPT` 并进入 SUCCEEDED。首轮探针自身诊断错误已排除，不算产品缺陷。
- 独立数据库复跑：tool-loop 45/45、assistant-readonly-round 6/6、assist-live-preview 8/8、backup-postgres 3/3、cross-candidate Accept 1/1；verification 26 通过/1 失败；backup-history 两条失败。独跑成绩不能继承为新全量成绩。

先检查 Git 状态和相关源码变化，记录本次基准。工作区有大量已有未提交改动，不能 reset、stash、clean、覆盖他人修改、自动 commit 或 push。日期和旧行号只用于定位；代码与当前契约为准。

本任务不包含前端整改、真实 Provider 调用、Windows 界面业务、安装/升级/卸载、产品多 Agent 或其他 M/N 功能。不得提升 M/N 总出口。新依赖、核心架构或权限范围变化须先说明必要性与差异，不为本次修复提前建设通用框架。

### 2. A：先闭合人工批准材料绑定（P1）

重点追踪现有 `apps/api/src/application/gateway-actions.ts` 的 `createGatewayReview`、`reviewMatchesOperation`、`requireCurrentGatewayGrant`、`admitGatewayInvocation`，以及 `check-trust-basis.ts`、`run-scope-grant.ts`、`review-decisions.ts`、`apps/api/src/worker/tool-loop-action.ts` 和相关仓储/target hash。在 `apps/api/test/integration/check-trust-gate.integration.test.ts` 补正式回归，先复现 RED，再做最小修复并取得 GREEN。

已确认根因：材料变化能让范围授权退回 ASK，但 ACTION_APPROVAL Review target 没绑定创建 Review 时观察到的材料依据；旧有效 APPROVE 因此仍可绕过材料漂移检查。只修范围授权比较不足以闭合此问题。

实现必须满足：

1. Review 创建时，把可信服务端实际观察到的检查材料依据绑定到确切 target 与其完整性校验。优先复用现有摘要、Review 与领域入口；不能信任调用方自报摘要，不能另建第二套授权 Owner。
2. 批准提交与最终派发准入均核对对应材料；依据已变更、无法可信读取或不匹配时，旧批准不能驱动实际执行。沿现有协议处理过期与重新确认，并保留历史判断和原 Operation/Invocation 关系。
3. 合法的新确认能够批准修订后的材料。Review 应绑定其创建时的新材料，不能永远比较最初范围授权摘要，让已审阅的新版本无法执行。
4. 旧记录缺少材料依据时采用保守拒绝/重新确认策略，不猜测补摘要，不把旧批准自动升级为有效。权限撤销依然优先，APPROVE 不豁免当前权限或其他版本门。
5. UNKNOWN 先按原身份核对，不盲重试、不新建动作或换 Adapter 绕过。网络、进程和文件等待不放入长数据库事务；保持现有资源排他与在途动作保护。

正式测试至少覆盖以下独立场景，使用真实 PG、受管临时目录及可观察的真实 Node 检查脚本：

| 场景 | 必须验证的结果 |
|---|---|
| 冻结后修改脚本，创建 Review，材料此后保持不变，再批准与派发 | 当前 Review 可执行其确切材料，产生预期 stdout 与账本 |
| Review 创建后、批准前再次修改脚本 | 旧 target 不得批准并执行新脚本，未出现未批准副作用 |
| 批准后、派发前再次修改脚本 | 旧批准不能进入真实执行，Operation/Invocation 与拒绝原因可核对 |
| 材料变更后重新按领域入口确认新依据 | 新的有效批准可正常执行，旧依据保持可追溯 |
| 已批准后撤销权限，或审批/历史记录缺材料依据 | 不放行、不伪造依据 |
| 已知脚本、配置或环境文件材料漂移 | 所有已支持材料均受同一批准失效规则约束，既有解析回归仍通过 |

测试核对真实账本、调用是否发生、状态与 stdout，不能只断言某个抛错文本；不引用不存在的诊断字段。明确最终核对与外部进程实际读取之间的边界，不能把这些测试宣称为操作系统级完全隔离或任意动态依赖安全。若修复仍留有已知可复现的未批准材料执行路径，保持未通过并说明。

### 3. B：处理全量失败，保持业务安全门

在 A 的定向回归通过后，按 `full-failures.json` 分类处理原失败：已确认产品缺陷、fixture/隔离问题、运行环境问题、尚未归因。每个修复都要对应实际失败，未归因项不得统一归为“测试不稳定”。

**队列与维护状态隔离。** 原运行器给全部集成文件共享一个数据库，`--test-concurrency=1` 不等于数据隔离。全局 Assist/Run 队列及维护状态可让后续套件领取其他 fixture 的消息或触发维护门。先定位各套件创建与遗留的对象，再选择最小的 fixture 清理或套件数据库隔离方案；允许运行器创建独占临时数据库并串行执行。生产全局调度语义正常，不能改生产 claim 逻辑、加测试专用绕过或禁用维护/连接安全门来换绿色。

原两文件组合 `artifact-impact-groups` → `assist-live-preview` 可复现污染，单独 assist-live-preview 8/8 通过。修复后重复这个组合，证明消息、Run 与维护状态不串套件。模型回调与子进程等待需要有限超时和有效诊断；失败后也应安全关闭自有连接/进程并收尾。对 `MAINTENANCE_SESSION_BUSY`、`DATABASE_FENCE_OTHER_CONNECTION`、启动超时分别查真实根因，不能仅增大超时或忽略异常。

**迁移完整性。** `backup-history.integration.test.ts` 与 `database-maintenance-boundary.integration.test.ts` 存在完整迁移数硬编码 48，验收时当前为 61。用可信当前 migration 文件清单/校验和与实际 ledger 核对完整性，保留确切版本恢复场景；不要只把 48 改成 61，也不要把实际条数与自身比较或删除失败断言。已有 migration 不回写。

**完成验证 fixture。** `verification.integration.test.ts` 的输出类型反例未绑定当前 PERSIST_CANDIDATE，提前返回 `VERIFICATION_TARGET_STALE`，旧断言却期待 `DECLARED_OUTPUTS_UNSATISFIED`。完成仍被 BLOCKED，此项当前不是已确认误完成缺陷。分别保留两条有效测试：候选版本失配必须 STALE；绑定一致但 artifact_kind 不满足冻结 expected_outputs 必须 DECLARED_OUTPUTS_UNSATISFIED。不能只改错误码断言而丢掉输出覆盖门。

**环境与清理。** 历史 PG 日志出现过 Windows 共享内存 error 487，尚未证明它解释所有失败。必要时做受控对照并保留对应输出；不自动修改系统安全策略、生产 PG 配置或关闭保护。清理前核对绝对目录、集群/PID、父子进程和本次身份，只停止本次自有资源。中止组合探针留下的旧业务临时目录尚未逐个确认身份，不能按 Temp 前缀批量删除或声称它们均已清理。

### 4. C：按当前源码复验

固定使用仓库现有 Node v24.21.0 和便携 PG 18.6，不升级依赖或运行时。真实集成使用独占临时集群、`relay_migrator`/`relay_app` 真实角色，不连接用户业务数据库。关闭本次测试进程继承的真实模型 opt-in 配置，不能输出凭据、改用户 `.env` 或调用真实 Provider。

先独占构建，再运行定向测试；不得并发写共享 `dist` 或 cargo target。枚举当前源码测试清单，防止旧编译产物、私有探针或已删除测试进入正式全量。

推荐顺序：

1. API 类型检查与编译；涉及真实文件动作时核对/构建当前 native helper，不能使用身份不明的旧二进制。
2. 新增 CT-11 正式反例与未漂移/重新确认对照，相关信任摘要单元测试和 check-trust-gate 全套；再跑 tool-loop 及受影响的批准、权限、UNKNOWN、停止/完成竞争回归。
3. verification 两个完成门及全套，迁移/备份/维护相关套件，队列污染组合，以及其他原失败的定向复跑。恢复启动失败必须有新诊断和收尾证据。
4. 最后对同一稳定源码基准执行一次必要的后端单元全量和真实 PG 集成全量。原 PG 全量约 36 分钟，先解决定向失败，避免无意义重复；最终仍必须取得可追溯全量结果。逐项说明 skip 是预期 opt-in/平台限制还是核心出口未运行，skip 不算 pass。

现有命令入口如下，执行前确认工作目录和参数仍匹配当前脚本。API 的 tsc 两条命令在 `apps/api` 内分别执行：

```powershell
& 'D:/Develop/Relay-Agent/.research/runtime-cache/node-v24.21.0-win-x64/node.exe' node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
& 'D:/Develop/Relay-Agent/.research/runtime-cache/node-v24.21.0-win-x64/node.exe' node_modules/typescript/bin/tsc -p tsconfig.json
```

以下入口在仓库根目录执行；`-SkipBuild` 只在确切当前源码已编译后使用，`-TestFile` 接收简单 basename：

```powershell
cargo build --locked --target x86_64-pc-windows-msvc --manifest-path apps/file-io-helper/Cargo.toml
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -SkipBuild -UseCLocale -TestFile check-trust-gate
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -SkipBuild -UseCLocale
```

其他定向套件和单元全量依当前源码/脚本核定。保留运行器 finally 中停止 PG、关闭进程、删除确切临时集群的能力。原始输出保存在新的本机忽略目录，汇报命令、exit code、通过/失败/跳过数量、源码基准和清理结果。独跑与全量分别列出，不拼接旧成绩，不通过删测试或收窄全量名单制造全绿。

### 5. 文档与完成出口

完成代码后做 Documentation Impact Check，只同步实际影响：

- 更新[工具适配器](../../docs/architecture/tool-adapters.md)的批准材料边界，说明真实实现及剩余限制；更新[测试计划](../../docs/testing/verification-plan.md)的正式场景与隔离方式。
- 实际验收结果只更新[统一功能验收表](../../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)受影响行；当前状态和下一步只更新[CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)。不新建逐轮重复报告，不复制全量日志。
- 若实际改变 API/持久化结构，更新对应契约文档，注明 Breaking Change、兼容策略及 migration 风险；没有结构变化就不制造 migration 或 ADR。重大根因只在现有合适归属补充必要说明。
- 更新本任务状态与提示词导航。运行 `node scripts/check-docs.mjs`，并人工核对事实、链接及当前/历史边界。

验收出口：两条旧批准执行新材料的反例均被正式测试挡住，未漂移及合法重新确认对照真实执行；权限/身份/UNKNOWN 与原检查解析保护保留；原失败按真实根因得到处理并取得当前全量结果。任何仍失败、取消、超时或核心 skip 均明确列为剩余阻塞，不能只凭 P1 定向通过宣布后端整体通过。

最终交付简述修复行为与根因、改动文件、实际验证、文档同步和剩余限制。给出关键批准/材料/Operation 关系及副作用证据，不泄露敏感材料；区分本次运行与历史基准。没有真实 Provider、Windows 业务或安装证据时，不宣称这些出口已验收。
