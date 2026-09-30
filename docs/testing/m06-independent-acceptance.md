# M06 真实工具独立验收

初次验收日期：2026-09-27。初次结论：**退回**；2026-09-28 当前证据见增量 I，M06 仍为 **IN_PROGRESS**。

## 范围与输入

本轮按当前工作区最新代码增量验收 Gateway AUTO→ASK 审批降级修复，以及真实文件、Git、CLI 的 14 项集成用例。核对相关适配器边界，并新增 3 项真实隔离 PostgreSQL 反例。没有修改生产代码，没有启用真实 Provider，没有做桌面窗口或安装验收；不把本轮后端结果扩展为 M04/M05 或整体产品结论。

基准 HEAD：`6e209042261b4955bdf2488b1a5fb1a7e9254adf`，含原有未提交修改。生产文件与最终反例 SHA-256：

| 文件 | SHA-256 |
|---|---|
| `apps/api/src/application/gateway-actions.ts` | `8342e3cfc0f07b2deee16737503f900eb0bda0ae8d9a8bcfd65aff72e5fe122d` |
| `apps/api/src/files/file-changeset.ts` | `14a5f016991dda2b621718ecd6eb93015c82722edc563787ec0718cb6d129bc1` |
| `apps/api/src/cli-worker/cli-adapter.ts` | `f7be31c6387b32133ff308bb8dce4a645bb471339f8780132c80028e3e966c33` |
| `apps/api/test/integration/real-tools-gateway.integration.test.ts` | `3ae7506bb9e951b620ea535ef0de756caf7e7d9da44c29cc640ed469e1529273` |

## 实际验证

使用仓库便携 Node 24.21.0 和现有隔离 PG 脚本；测试只写一次性目录、数据库和本地 bare Git remote。

| 检查 | 结果 | 证据 |
|---|---|---|
| API 类型检查 | 通过，含新增反例 | `node apps/api/node_modules/typescript/bin/tsc --noEmit -p apps/api/tsconfig.json` |
| API 单元测试 | 103/103 | [日志](evidence/raw-output-20260930.zip#entry=docs%2Ftesting%2Fevidence%2Fm06-independent-20260927-unit.log) |
| 新增反例前全量真实 PG | 399 项：393 通过、4 失败、2 跳过 | [日志](evidence/raw-output-20260930.zip#entry=docs%2Ftesting%2Fevidence%2Fm06-independent-20260927-full-pg.log) |
| 新增反例后 real-tools 定向真实 PG | 17 项：原 14 项通过、新 3 项失败，无跳过 | [日志](evidence/raw-output-20260930.zip#entry=docs%2Ftesting%2Fevidence%2Fm06-independent-20260927-real-tools.log) |

命令：`powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1`；定向追加 `-TestFile real-tools-gateway`。两次构建、业务迁移、图安装、PG 启停退出码均为 0，临时集群均已删除。测试退出码均为 1，不能当作通过。

全量的 4 项失败为 `project-blueprint` 的 archived explicit source、goal-to-project-blueprint、baseline change and cancellation，以及 `web-fetch` 的 AUTO web import。与 2026-09-26 登记用例一致，本轮复现了失败，但未独立证明其根因或完成修复；不因历史称为偶发就豁免。全量构建发生在新增反例前，因此不含后加的 3 项测试。

## 退回项

### P1：CLI 未知副作用被当作失败并释放资源

真实子进程先写入 `cli-effect.txt`，随后在外部效果完成、结果结算前用 `afterFakeEffect` 抛出 `SimulatedGatewayCrash`。核实文件已存在、Invocation 为 DISPATCHING 且 `result_ref=null` 后，按原 Worker 身份核对。

实际为 `FAILED / RELEASED / CLAIMED`，期望为 `UNKNOWN / QUARANTINED / GATEWAY_OPERATION_UNRESOLVED`。原因是 `reconcileCliExecution(undefined)` 把缺少 PID 判为 STOPPED，Gateway 再映射为 FAILED，释放 claim；停止证据也不能证明任意 CLI 的外部效果。此处不是仅缺一个在途 PID 测试，而是已经实证丢失结果可错误开放后续执行。

修复出口：DISPATCHING 且无确定效果证据时保留 UNKNOWN 和资源隔离；无 PID、进程已退出都不能单独证明未执行或已知失败。保留原动作身份，复验红测试，并检查控制/恢复/跨 Task 资源保护。

### P1：无基线摘要的 MODIFY 可覆盖已有文件

APPLY_CHANGESET 的 MODIFY 只提供路径与新内容，不提供 `baselineSha256`；审批后实际返回 SUCCEEDED，并把 `original` 覆盖成 `overwrite`。Gateway 没有强制基线，适配器只在摘要存在时比较，无法检测候选生成后的外部编辑。

修复出口：MODIFY/DELETE 要求有效冻结基线并在落盘前比较；缺失或非法摘要拒绝，不以人工审批替代基线检查。核对 CREATE、部分应用和冲突保留行为。

### P1：路径别名绕过受保护文件校验

APPLY_CHANGESET 使用 `./.env` 时，Prepare 未按 `GATEWAY_TARGET_DENIED` 拒绝。`validateSafeRelativePath` 在 resolve 之前检查原始字符串，`./` 绕过以 `.env` 开头的保护规则，之后才归一到真实受保护路径。本反例实证准入漏拒绝，未实际写入 `.env`。

修复出口：按规范化后的根内相对路径执行保护检查；覆盖 `./`、根内 `..`、Windows 分隔符及大小写等价形式，保留逃逸与链接校验。

## 交付与限制

新增红测试保留在 [real-tools 集成测试](../../apps/api/test/integration/real-tools-gateway.integration.test.ts)，不跳过或弱化断言。未修生产代码；修复后须重跑这些反例与相关回归，再更新验收结论。原 14 项通过证明既有列明场景及审批降级正常路径，不表示真实工具整体安全出口通过。

文档影响检查：本轮只涉及验收证据、当前状态和适配器已知限制；没有需求、API、数据库或架构决策变更，不新建 ADR 或重复路线图。模块其余未完成项继续以 [当前进度](../../CODEX_NEXT_STEP.md) 为准。

## 修复结果（2026-09-27 开发自检，待协调 Agent 独立复验）

上方退回证据原样保留，作为当时的独立验收结论。以下为本轮按「仅修复、不扩展、不启用真实 Provider、不自行宣布模块验收」范围完成三项 P1 修复后的开发自检记录。改动仅限 `apps/api/src/application/gateway-actions.ts`、`apps/api/src/files/file-changeset.ts`、`apps/api/src/cli-worker/cli-adapter.ts` 及 `real-tools-gateway.integration.test.ts`、`file-changeset.test.ts`；无新增迁移、无公开 API 变更、未触碰 project-blueprint/run-command-order/web-fetch。

各项最小修复：

- **P1-1（CLI 丢失结果误释放资源）**：`reconcileCliExecution` 改为只在 `DISPATCHING` 丢失结果这条恢复路径上被调用，一律保守返回 `UNKNOWN` 且 `quarantined:true`——缺 PID 记 `DISPATCHING_RESULT_LOST_NO_PID`，有 PID 也只作存活证据；不再凭「无 PID」或「进程已退出」判 `STOPPED`/`FAILED` 释放 claim。Gateway 调用方随之按新签名取 `result_ref.pid` 传入。
- **P1-2（无基线 MODIFY 覆盖原文件）**：新增 `isFrozenBaseline`/`requireFrozenBaseline`；`APPLY_CHANGESET` 的 `MODIFY`/`DELETE` 在 prepare 缺有效 64 位十六进制基线即 `VALIDATION_FAILED`（批准之前拒绝），`executeFileChangeset` 在任何副作用前再校验一次，并把落盘前的基线比对从「仅摘要存在时比较」改为无条件比对；`WRITE_FILE` 缺基线派生为 `CREATE`，对既有文件记 CONFLICT 不覆盖。人工批准不可替代基线检查。
- **P1-3（路径别名绕过保护）**：`validateSafeRelativePath` 与 `isProtectedPath` 改为先 `resolve` 归一再据以计算根内相对路径并按前缀匹配（统一反斜杠、剥离 `./` 与根锚点前缀、大小写不敏感），逃逸检查仍先于保护检查；`./.env`、`src/../.env`、`foo/../.git/config` 等别名在 prepare 一律 `GATEWAY_TARGET_DENIED`。

新增 4 项真实隔离 PG 边界反例（DELETE 缺基线拒绝、携匹配基线的合法 MODIFY 仍应用、WRITE_FILE 缺基线不覆盖既有文件、规范化别名拒绝）与 4 项单测（别名/分隔符/大小写保护、归一化路径校验、基线格式校验、按动作强制基线）。

实际验证（便携 Node 24.21.0 + 现有隔离 PG 脚本，测试只写一次性目录/数据库/本地 bare remote）：

| 检查 | 结果 | 命令 |
|---|---|---|
| API 类型检查 | 通过 | `tsc --noEmit -p apps/api/tsconfig.json` |
| API 单元测试 | 107/107 | 随构建 |
| real-tools 定向真实 PG | 21/21（3 项原红转绿 + 4 项边界，无失败无跳过） | `-TestFile real-tools-gateway` |
| Gateway 回归 | 28/28 | `-TestFile gateway` |
| 恢复回归 | 17/17 | `-TestFile recovery` |
| CLI 回归 | 5/5 | `-TestFile cli` |
| 全量真实 PG | 406 项：399 通过 / 5 失败 / 2 跳过 | 完整 `run-integration.ps1` |

全量 5 项失败为 `project-blueprint` 的 archived explicit source、goal-to-project-blueprint、baseline change and cancellation，`run-command-order` 的「待处理 PAUSE/CANCEL/HANDOFF 旧 START 安全点优先」，以及 `web-fetch` 的 AUTO web import。五项均为计数/布尔/UUID 类 `AssertionError`，无任何 PostgreSQL 约束违反（无 23514/23505），且都不在本轮改动文件内；`-TestFile` 隔离单跑 `project-blueprint` 5/5、`run-command-order` 7/7、`web-fetch` 19/19 全部 `status: PASSED`，据此判定为共享库串行高负载偶发，而非本轮 P1 修复引入的回归。相比退回记录当时「新增反例前 399 项」，全量总数增至 406（+3 原反例 +4 边界反例）。

一处环境坑记录：不要用 `powershell -Command "... 2>&1 | Select-Object"` 包裹本脚本——脚本内 `Set-StrictMode`+`$ErrorActionPreference='Stop'` 会把 initdb 关于中文 locale「could not find suitable text search configuration」的 stderr 提示当成致命错误抛出（initdb 实际退出 0），造成假 `status: FAILED`；改用 `-File` 运行并把输出重定向到文件后再读尾部汇总行，真实结论以脚本自身 `tests exit code`/`status:` 为准。

结论：M06 保持 IN_PROGRESS，三项 P1 已修复并完成上述开发自检，等待协调 Agent 独立复验；本轮未启用真实 Provider、未做 Windows 会话或安装验收、未把后端结果扩展为 M06 整体出口放行。`change_sets`/`change_set_files` 持久表、固定图写意图接线、逐文件 diff UI、`RUN_BUILD`/`RUN_TEST` 模板、CLI `STILL_RUNNING` 在途 PID 直接观测反例、Windows 实测与其余未完成出口仍待后续。

## 协调侧定向独立复验（2026-09-27，非完整模块验收）

机器空闲时以 `-TestFile real-tools-gateway` 复跑定向套件 **21/21 全绿**（tests exit code 0、`status: PASSED`、临时集群已删除），逐项确认三项 P1 行为成立：缺有效基线的 `MODIFY`/`DELETE` 在 prepare `VALIDATION_FAILED` 且不触碰磁盘、携匹配基线的合法 `MODIFY` 仍应用、`WRITE_FILE` 缺基线派生 `CREATE` 不覆盖既有文件、`./.env`/`src/../.env`/`foo/../.git/config` 等规范化别名在 prepare `GATEWAY_TARGET_DENIED`、`CLI_RUN` 丢失结果保持 `UNKNOWN`+资源隔离且再领取被 `GATEWAY_OPERATION_UNRESOLVED` 阻断。

新增一项负载脆弱数据点：一次与并行集成跑争抢时，`CLI_RUN enforces the deadline as a timeout instead of hanging` 单例断言失败（期望 `TIMEOUT`、实得 `FAILED`，该用例耗时约 2.7 秒贴近 deadline 边界）；机器空载后同一用例通过。该用例走 `executeCliCommand` 正常 deadline→超时路径，不属本轮 P1 改动面（P1-1 仅改 `reconcileCliExecution` 恢复路径），归入既有「100 ms 轮询/5 秒超时类断言在高负载下脆弱」同族，登记为测试基建后续，不因单次抖动改判本轮修复。

本主机环境注记：这台中文 Windows 上直接以 `-File` 调 `run-integration.ps1` 时 `initdb` 会因缺少中文文本搜索配置**硬中止**（非仅 stderr 提示），给 `initdb` 追加 `--locale=C` 可解且集成库不用全文检索故无副作用。此 `--locale=C` 仅为本地复验绕过，未纳入提交、未改共享脚本。本记录是定向独立复验，不等同 M06 完整验收；M06 仍保持 IN_PROGRESS。

## 增量 A 独立复验退回（2026-09-27）

输入基准为 `b81f69e242d5b9e751e237a0628cc96779b6119f` 的变化集账本实现。协调侧使用隔离 PostgreSQL 18.6 和 `run-integration.ps1 -UseCLocale` 复跑 `real-tools-gateway` 23/23、`migration` 8/8、`cli` 5/5；三次脚本均报告 `status: PASSED`，临时集群已删除。`-UseCLocale` 是本轮给测试脚本新增的可选开关，默认行为不变；上述绿灯只覆盖已有用例，不能据此接受增量 A。

源码独立审查发现下列未覆盖的账本和恢复反例，故增量 A **退回修复，M06 仍为 IN_PROGRESS**：

1. `APPLY_CHANGESET` 接受与 `content` 不符的 `targetSha256`，执行与账本又把声明摘要当作实际写入摘要；可能写入 `real` 却把 `fake` 的摘要及 `SUCCEEDED` 固化。需在准入核对目标摘要，并从实际写入内容计算执行观测。
2. 同一变化集的重复或等价路径未拒绝；逐文件结果按路径建 `Map` 会覆盖先前冲突，入库时又按主键忽略后续行，可能出现整体 `SUCCEEDED`、唯一文件行 `CONFLICT`、声明文件数为 2 的矛盾。需按规范路径拒绝重复，并以守卫后的真实持久行数和状态决定汇总。
3. `DELETE` 恢复核对把非 `ENOENT` 读取错误也当作目标不存在；目标变目录或读取失败时可能错误收敛 `SUCCEEDED` 并释放资源。需把无法确认的读取结果保留为 `UNKNOWN`。
4. 0031 对逐文件相对路径设 1024 字节上限，准入和执行没有同一限制；较长路径可先落盘，再因账本约束 `23514` 使 Invocation 结算回滚并反复无法核对。需在副作用前对最终账本路径执行相同 UTF-8 字节限制。
5. 0031 的项目、Run、资源外键分别验证存在，未证明其与 `operation_id` 属于同一来源；同 Workspace 内可插入跨项目或跨 Run 的错账。需用追加迁移把来源动作与账本作用域、动作类型绑定，保留已应用的 0031 不变。

这些是代码审查确认的可构造路径，尚未在本节声称红灯集成测试已运行。修复与真实数据库复验结果另记，不用原 23/23 代替新反例的验收。

## 增量 A 修复与定向独立复验（2026-09-27）

上节五项退回结论保留为首版基准。本轮逐项修复并新增反例：目标摘要必须与实际 UTF-8 内容相符；规范化后重复的文件路径与超过 1024 UTF-8 字节的账本路径在 Prepare 拒绝；DELETE 核对仅把真正的 `ENOENT` 视为缺失；仓储按守卫后的持久文件行数和状态决定成功汇总。追加 [0032 迁移](../../apps/api/migrations/0032_m06_change_set_source_scope.sql) 将账本作用域、动作类型绑定到同一来源 operation，不改已应用的 0031。

独立复核又发现三类恢复/路径误判并补修。受管根在批准后被 junction 重定向时，旧实现会写到根外却以原根落账；父目录指向根外的链接会让核对读取根外目标；根内链接指向 `.git` 可绕过受保护路径。执行现在核对冻结根、逐级检查父目录后创建，恢复也拒绝根或父目录重定向；无法安全回读时为每个冻结文件留下未确认观测。原逻辑还会把 `afterAdmit` 崩溃前已存在或由外部补齐的目标误判为本次调用成功。FILE_WRITE 适配器返回后先以原 Invocation 的 `DISPATCHING` 且空 `result_ref` 做一次性回执 CAS；恢复需同时核对回执身份、冻结输入、逐文件报告与实际磁盘状态。没有回执、回执不符或部分结果时整体保留 `UNKNOWN` 和资源隔离；部分结果中只有回执确证且回读匹配的文件可记 `APPLIED`。原 `afterFakeEffect` 写后崩溃仍能凭回执和回读沿原身份收敛，不重发动作。

红态证据：新增路径单测在修复前为 9/12，根内 `.git` 链接反例为 12/13；真实 PG 的根替换和父目录根外匹配两例均曾错误返回 `SUCCEEDED`。四项回执归属 PG 反例在修复前失败：写后崩溃缺持久回执、适配器未调用却误成功、外部写入误成功、部分失败后外部补齐误成功。首轮绿态 PG 为 36/37，唯一失败是根重定向缺逐文件账本行，补齐未确认观测后通过。以上红态仅证明列明反例，未把未执行的其他测试写成失败。

协调侧使用仓库便携 Node 24.21.0，以当前工作区代码独立复验：

| 检查 | 结果 | 范围 |
|---|---|---|
| API 单测 | 113/113，无失败或跳过 | `apps/api/dist/test/unit/**/*.test.js`，含冻结根、父目录链接与受保护目录 |
| real-tools 真实隔离 PG | 37/37，无失败或跳过 | 批准、真实文件效果、逐文件账本、回执归属、来源外键、Git/CLI 既有回归 |
| migration 真实隔离 PG | 8/8 | 0032 纳入完整迁移链，`ledger_rows=32` |
| Gateway / recovery / CLI 真实隔离 PG | 28/28、17/17、5/5 | 原准入、控制恢复与 CLI 回归 |
| 文本差异 | 通过 | `git diff --check` |

真实 PG 均用 `run-integration.ps1 -TestFile <name> -UseCLocale` 串行启动一次性 PostgreSQL 18.6 集群；real-tools 构建、业务迁移、图安装、PG 启停均退出 0，各次脚本报告 `status: PASSED` 且临时集群已删除。`-UseCLocale` 只解决本机中文 locale 的 `initdb` 故障，默认脚本行为不变。

**结论：接受增量 A 的本节定向修复，M06 整体仍为 IN_PROGRESS。** 已验证的是真实隔离 PG 与测试文件系统路径；普通 Node 路径检查到实际读写之间仍有 TOCTOU 竞争，尚无句柄级隔离、真实 Windows 宿主/安装验收，也未开放真实 Provider。后续固定图写意图、diff UI 等依赖增量可在此基础上继续；不得把本节称为 M06 总出口通过。

## 增量 B：固定图文件写意图定向独立复验（2026-09-27）

`POST /tasks/{task_id}/delegations` 增加可选 `file_write_action`，与原三种 Gateway 意图互斥。Delegate 在创建 Run 前核对资源作用域、路径、重复目标、内容/摘要及数量边界；合法变化集连同 `file-write-v1` 和唯一原 `operation_id` 冻结到执行契约。DRAFT 成功后，固定图以该身份准备 `FILE_WRITE/APPLY_CHANGESET`；Gateway 仍决定 Connection、Permission、实际路径和基线冲突。ASK 不写磁盘，批准后的 RESUME 使用原 Review/Operation/Invocation 链，并由增量 A 的账本记录逐文件结果。

红态：新增两条真实 PG 图链在接线前均因新请求字段未识别返回 422（0/2）。开发侧补实现与用例后，协调侧独立运行当前源码：Node 24.21.0 类型检查退出 0、API 单测 115/115；`run-integration.ps1 -TestFile run-graph -UseCLocale` 57/57，构建、32 条业务迁移、图安装、PG 启停均退出 0；`-TestFile real-tools-gateway -UseCLocale -SkipBuild` 37/37，业务迁移、图安装与 PG 启停退出 0。两次一次性 PG 集群均已删除，脚本报告 `status: PASSED`；`git diff --check` 退出 0。图链断言包含批准前无效果、批准后原身份单次写入、逐文件账本与磁盘摘要、重复投递不重写、变化集输入无效或混用时不创建 Run；基线冲突后未进入 `PERSIST_CANDIDATE`，未产生第二次 Invocation 或自动重试，Task 未被虚报 DONE。

**当时结论：增量 B 的后端图接线通过上述定向独立复验，M06 仍为 IN_PROGRESS。** 后续审查发现混合 `APPLIED`/`CONFLICT` 的状态投影缺口并按下节修复；这里保留发现前的证据时点。本增量未提供前端委托入口或逐文件文本 diff，也未做真实 Windows 宿主、安装或 M06 总验收。

## 增量 B 后续恢复状态退回与修复（2026-09-27）

上节定向图链虽通过，独立核对又发现：混合 `APPLIED`/`CONFLICT` 的 Operation/Invocation 被结算为终态 `FAILED`，资源却 `QUARANTINED`、Run 仍 `RUNNING`。现有 Run 未决投影及恢复入口都不接纳这个终态，用户看不到原隔离动作，也不能按原 Invocation 核对；这违反[恢复契约](../../contracts/04-recovery-and-commit.md#3-调用协议)中 `FAILED` 仅用于可证明未执行的动作。新增真实 PG 断言在修复前 0/1，实得 `FAILED/FAILED/QUARANTINED` 而期望 `UNKNOWN/UNKNOWN/QUARANTINED`。

修复按适配器回执区分已知无效果与未决结果：只在所有文件均 `CONFLICT`，或冻结根在循环前整体拒绝且报告与回执自洽时，FILE_WRITE 可结算 `FAILED` 并释放 claim；只要有已应用文件或写入失败可能留下部分字节，原 Operation/Invocation 保持 `UNKNOWN` 和资源隔离。Run 查询于是继续展示原 `operation_id`；恢复入口可沿原 Invocation 核对。已固化的执行账本 `PARTIAL` 不被后到的恢复观察覆写。固定图对确定无效果的 `FAILED` 复用失败收敛用例，使 Run 失败、Task 回 READY，不留下 `RUNNING` 却无未决动作的状态。协调侧以修复后源码串行复跑：Node 24 类型检查和构建退出 0，文件写图链定向 4/4、完整 run-graph 58/58、real-tools 37/37、Gateway 28/28、recovery 17/17；真实 PG 脚本均为 `status: PASSED`，临时集群全部停止并删除。

这修正了原动作的可见性与可核对入口，**没有实现人工解除隔离**：恢复仍不能将真实部分应用误判为整体成功，也不会自动补写、换 ID 重试或释放 claim。人工处置必须另行保存停机证明、逐文件当前事实与明确决定；在该闭环实现前资源保持隔离，M06 仍为 `IN_PROGRESS`。

## 增量 C：逐文件账本只读查询开发自检（2026-09-27）

新增 `GET /operations/{operation_id}/change-sets`，沿原 Operation 的 Workspace 作用域读取 0031/0032 账本。它按 Invocation 返回逐文件冻结基线、目标摘要、执行观测摘要、状态与错误，只读已持久事实；执行前返回空数组，不读取当前磁盘，也不把 `PARTIAL` 展示为成功。详情与兼容边界见 [HTTP 契约 §10.42](../api/http-command-contract.md#1042-m06-文件写入逐文件账本只读查询2026-09-27)。

真实 PostgreSQL/HTTP 的两条定向用例先因路由不存在返回 404（0/2）；接线后为 2/2，通过执行前空账本、混合 `APPLIED/CONFLICT` 的按路径结果、跨 Workspace 404、`no-store` 和响应不含文件正文。`run-integration.ps1 -UseCLocale -TestFile real-tools-gateway -TestNamePattern 'M06 FILE_WRITE baseline hash conflict|M06 change_set ledger records per-file PARTIAL'` 定向 2/2，随后完整 `real-tools-gateway` 37/37；两次构建、32 条业务迁移、图安装、PG 启停均退出 0，脚本均 `status: PASSED`，一次性集群均已删除。`node scripts/check-docs.mjs` 与 `git diff --check` 也通过。本节为新增只读端点的开发自检，不替代全套 M06 或真实 Windows 验收。

人工解除隔离的前置核对发现：桌面旧 Job 的停机证据虽经受信启动帧传到 supervisor，现有 `run_invocations.stop_evidence` 会在重新领取时清空；原 FILE_WRITE Invocation 的旧 Worker epoch 尚无不可覆盖的持久停机证明。后续处置命令不能接收 UI 自报的 `oldProcessStopped` 布尔值，也不能仅凭租约到期或文件哈希解除隔离。需先把可信停机证明绑定原 Run/Operation/Invocation/Worker 身份，再核对逐文件当前事实与明确人工决定；在此之前保持 `UNKNOWN`/`QUARANTINED`。

## 增量 D：停机证明与部分写入人工处置开发自检（2026-09-27）

0033 新增原 FILE_WRITE Invocation 的桌面 Job 停机证明。它仅由 `recoverStoppedDesktopLaunch` 在原旧 claim 会话锁内、fence 前写入，联合外键/只插入权限保护身份和不可覆盖性；租约过期、普通 child close 与直接 Gateway 核对均不能生成。证明定向真实隔离 PG 先红 1/3（缺证明），实现后 5/5；原 run-dispatch 回归 22/22。该证据仍是后端对可信桌面启动帧的处理验证，未在真实 Windows Job handle 上验证活进程终止。

0034 与新增 HTTP GET/POST 将处置限定为 `KEEP_CURRENT_AND_FAIL_RUN`：用户先看到逐文件当前摘要和快照 hash，提交时重读同一冻结根与文件；无证明、已变化快照、根或目标不可安全读取、其他未决动作时保持隔离并拒绝。成功同事务保留原 Invocation `UNKNOWN`/逐文件 `PARTIAL`，写不可改写的人工决定与当前观测，将 Operation 标 `MANUALLY_CLOSED`、释放 claim、结清旧投递、Run 标 `FAILED`、Task 返 `READY`，不创建候选、完成记录或 Project State 提交。项目归档只将该已处置 Invocation 的 UNKNOWN 视为历史，其余未决事实继续阻断。

真实 PG/HTTP 的新增图链反例覆盖无证明 409、桌面 Job 恢复证明、非普通目标拒绝、预览后文件变动拒绝、重新确认后的持久状态/命令回执重放/无第二次 Invocation，以及归档不把已处置历史误判为活动 UNKNOWN。首次后端图链完整回归 59/59；审查发现“任意大当前文件在业务事务内整文件读取”的风险后，把观察移到短事务外、增加单文件 1 MiB 流式上限和 10 秒总超时，并补超限与历史逐文件投影断言。修复后定向图链 1/1、migration 8/8、project-archive-gate 5/5，TypeScript 检查通过；上述每次隔离 PG 脚本均报告 `status: PASSED` 且临时集群清理。完整 59/59 属限流修正前的代码时点，修正后的变更面由新增定向反例覆盖。此处仍不等于真实 Windows 桌面、逐文件文本 diff UI 或 M06 总出口验收。

React Run 页接入原 FILE_WRITE 动作的两条只读查询及显式处置命令：逐文件原账本、当前摘要、可信证明与阻断原因分开展示；处置后仍展示已保存的逐文件观察。二次确认绑定原 Invocation、Run/Task 修订、观察 hash 和 command_id；409 刷新事实。独立代码审查发现首版 UI 在 POST 响应丢失且原回执 404 时只有查询入口，无法用原 ID 恢复。修复后先把冻结命令存入按 API/Workspace/Operation 隔离的浏览器会话，重开页面保留原 ID；只有回执明确 `COMMAND_NOT_FOUND` 才开放同 ID、同载荷重试。新增断线→重开→404→原样复投反例后，定向 Vitest（含既有 Run 组件回归）14/14、前端 TypeScript 检查与构建通过。最新归档栅栏加强为只认可 `MANUALLY_CLOSED` 且存在匹配处置行后，新增图链在真实隔离 PG 再验 1/1，迁移和临时集群清理均通过。该 UI 自检仍未覆盖真实 Windows Job、WebView2 人工点击或安装包体验，也没有文本 diff 证据。

## 增量 D：真实 Windows Job 部分写入恢复复验（2026-09-27）

用当前源码构建的 release 目录包运行 `apps/desktop/scripts/test-m06-job-file-write.ps1`。脚本在一次性 PostgreSQL 和真实 Windows 桌面 Job 中创建双文件变化集：`CREATE` 已写入，`MODIFY` 因外部基线变化而冲突。测试专用 Worker 等待点只在隔离临时会话、桌面启动帧和显式环境变量同时成立时启用，停在原 Invocation 的适配器回执持久化后、结算前。测试读取原 `DISPATCHING` 回执、活动外层投递和 Job 内宿主/API/Supervisor/Worker 的 PID、创建时间、可执行文件，再强杀本次宿主；四个旧进程均退出，原 claim 和唯一 Invocation 未被抢先释放或重投。

首次真实 Windows 反例显示：重启后受信 Job 停机证明已持久绑定原 Invocation、Worker/epoch、投递 epoch/命令及旧 launch，Operation/Invocation 保持 `UNKNOWN`、资源保持 `QUARANTINED`，但崩溃前尚未落账的混合效果在恢复时首次建账为 `UNKNOWN`，人工处置因此受阻。这是 `recordReconciliation` 仅能新建 `SUCCEEDED/UNKNOWN` 账本的真实路径缺口，不是旧 Job 仍在运行。新增真实 PG 反例先红 0/1（实得 `UNKNOWN`），修复后要求原回执中每个 `APPLIED` 文件与当前目标摘要一致、每个 `CONFLICT` 文件与回执中的执行时摘要一致，且之前没有不可改写的 UNKNOWN 账本行，才在首次恢复建账为 `PARTIAL`。缺回执、回读错误、后来的外部改写或可能留下部分字节的失败仍为 `UNKNOWN`；原 Operation/Invocation 不因账本 PARTIAL 而变成功。后续独立审查发现原回执为“CREATE 应用、DELETE 因文件缺失而冲突”时，恢复账本会把后者误记为 `FAILED`；新增真实 PG 反例先红 38/39（该行实得 `FAILED`），改为只在逐文件回执及回读已确认时保留原报告状态，复跑 `real-tools-gateway` 39/39 通过。适配器报告 `FAILED`、可能留下部分字节的文件仍不自动解除隔离；构建、0034 迁移、图安装、PG 启停与临时集群清理通过。

修复版隔离 Windows 会话已完成原 Job 强杀→重启→原证明核对→部分写入人工处置全链：旧宿主/API/Supervisor/Worker 都退出；重启后原 Invocation 仍唯一且 `UNKNOWN`，账本 `PARTIAL`、claim `QUARANTINED`；逐文件确认 `new.txt=APPLIED` 且目标/磁盘摘要一致、`existing.txt=CONFLICT` 且原回执观测/磁盘摘要一致。明确 `KEEP_CURRENT_AND_FAIL_RUN` 后 Operation `MANUALLY_CLOSED`、Run `FAILED`、Task `READY`、claim `RELEASED`、原外层 dispatch `IDLE` 与 outbox `DONE`，原 Invocation 仍 `UNKNOWN` 且未产生第二次调用。独立审查后，验收脚本先持久化新宿主 PID、失败路径按已记录身份清理，清理失败不得报告 PASS；收紧后的 Windows 全链复跑通过，一次性数据库停止并删除。增量 E 源码构建并重跑 D 恢复链后的 release EXE SHA-256 为 `c6c9b7bd730752c0252b541025806ab26837cb2264dda9d092faf12f7b852ebc`，manifest SHA-256 为 `6d2b0cd9ca79abf29bc339b5b2f4f91065a708618214d44abad39d9623592080`；0033/0034 迁移 SHA-256 分别为 `297fdcf230f28bae6fe3a8f85de6eb81b725e098b67f6cb5e5358d8d0ffb8fe6`、`ad9cb839171e948039c05499a3a5a114bb3dd599b211c1e400aa636776fd735c`。逐项 ID、epoch、进程身份与文件 hash 的脱敏记录见 [Windows Job 验收证据](evidence/m06-windows-job-file-write.txt)。该记录验证真实 Job 和后端/API 处置；新增差异的 WebView2 自动化证据见增量 E。人工交互与 M06 总出口仍待完成；安装包总验收属 M07。

## 增量 E：冻结计划文本差异开发自检（2026-09-27）

现有 Operation 只有目标正文和 `MODIFY/DELETE` 基线摘要，旧动作无法从当前磁盘可靠还原准备时的原文。0035 对**新** FILE_WRITE 动作增加只追加基线证据：授权预检先核对 Run/Worker、Project/Resource、Connection/Permission；在同一授权持锁事务内有界读取普通文件、核对路径身份及冻结 SHA-256，最多保存 64 KiB UTF-8 原文。基线不可安全读取、摘要不符、二进制或超限时只记不可用原因，不影响原动作准入/执行语义；新 Operation 与证据同行提交，重复意图不覆盖。查询从冻结参数和证据生成只读 `FROZEN_INTENT` 文本差异，不读当前磁盘；历史动作缺正文则不给伪造 diff。CREATE 的空基线和 DELETE 的空目标按动作语义展示。React Run 页按需读取，标出计划、逐文件执行账本和当前磁盘证据各自来源。

开发自检：文件相关单测 15/15，真实隔离 PostgreSQL migration 8/8、`real-tools-gateway` 完整文件 44/44（含 APPLY_CHANGESET 三种动作、基线不匹配/二进制/超限、冻结后外部改写、WRITE_FILE basename、跨 Workspace 与证据不可改写），React 定向 Vitest 5/5；API 与 Workbench 类型检查通过，临时 PG 集群已清理。新增 HTTP/数据库契约分别见 [§10.44](../api/http-command-contract.md#1044-m06-文件写入冻结计划文本差异2026-09-27开发自检) 与 [§48](../database/physical-design-postgresql.md#48-0035-m06-冻结计划文本差异证据2026-09-27开发自检)。此处是开发自检：新 release 目录包包含 0035（SHA-256 `04947c66e1e21f5341b8faa8a74fd953e4297427d989e844cf1b1b28cef50c16`）；隔离 Windows Job 恢复脚本在此包再次通过，证据见 [Job 记录](evidence/m06-windows-job-file-write.txt)。真实 WebView2 自动打开 Run、展开原动作并点击差异面板，确认 CREATE/MODIFY 冻结文本、计划提示与尚无执行账本，截图见 [WebView2 证据](evidence/m06-webview-file-write-diff.png)，脱敏记录见 [文本证据](evidence/m06-webview-file-write-diff.txt)。自动化点击与截图检查不等于人工交互或安装包试用。Windows Node 不提供 `O_NOFOLLOW`，前后路径与句柄身份核对不能消除所有文件系统竞争窗口；M06 保持 `IN_PROGRESS`。

独立审查在增量 E 后又指出两处旧 FILE_WRITE 执行缺口：`MODIFY/DELETE` 对缺失的嵌套目标先创建父目录，再以“全冲突无文件效果”结算；大写合法基线 SHA-256 虽被输入校验接受，执行时却按大小写敏感比较。两条文件系统单测先复现，再改为仅 CREATE 可创建父目录、基线比较统一小写；新增真实 PG 反例确认缺失父目录的 MODIFY 为 `CONFLICT/FAILED` 且不留目录，含新增 16 文件限额反例的 `real-tools-gateway` 44/44 全绿。授权与基线读取之间的空窗改为同一持锁事务，Workspace 权限变更与 Task/Run 控制需等待捕获结束；最终 Prepare 仍重查权限与执行权。该修复后的新 release 已重跑隔离 Windows Job 恢复链和 WebView2 自动化差异面板，均通过，进程与临时数据库已清理。

**未解决的 M06 阻断风险：** 文件执行与恢复仍按路径先检查再做 I/O；外部进程可在间隙替换父目录 junction/目标链接，现有 Node/Windows 路径核对并非句柄级隔离。不能据当前测试宣称根外写入绝不可能或 UNKNOWN 一定可安全解除；M06 总出口继续阻断，后续需要句柄绑定的 Windows 文件操作/核对机制和竞争反例。

随后补充 Windows 相对路径段防护：`validateSafeRelativePath` 在归一前拒绝备用数据流冒号、保留设备名（含 COM/LPT 上标数字与扩展名）、禁用字符与控制字符、尾随点或空格；`APPLY_CHANGESET` 与 `WRITE_FILE` 均在 Prepare 走同一校验，后者在父目录 `realpath` 前先检查原始目标。单测先复现 ADS、COM¹ 与问号路径漏过，再修复为文件单测 16/16；真实隔离 PG 新增两种动作的审批前拒绝反例，完整 `real-tools-gateway` 45/45，迁移/图安装/PG 启停及临时集群清理通过。基于该源码重建的 release EXE SHA-256 为 `c6c9b7bd730752c0252b541025806ab26837cb2264dda9d092faf12f7b852ebc`，manifest SHA-256 为 `6d2b0cd9ca79abf29bc339b5b2f4f91065a708618214d44abad39d9623592080`；隔离 Windows Job 恢复链与真实 WebView2 自动点击再次通过，证据文件已绑定此包，进程和一次性 PG 均退出。该路径语法修复不解决上述竞争；[ADR-012](../decisions/ADR-012-windows-file-io-handle-boundary.md) 只记录 Proposed 句柄边界和必需反例，尚未实现。

## 增量 F：Windows 句柄边界开发自检（2026-09-27）

承接增量 E 的路径检查/实际 I/O 替换竞争。新 Windows `FILE_WRITE` 在准备时通过原生助手冻结受管根、父目录链和目标的卷号/File ID，0036 与原 Operation 同事务持久保存；执行及恢复只按冻结身份逐段从持有目录句柄打开。`WRITE_FILE` 从受管资源根锚定，0037 允许其新冻结差异和账本共用根相对路径，旧动作保持原历史行。旧 Windows Operation 缺物理身份不在恢复时重建；在途动作仍以原 Invocation 的回执和真实观察核对，证据不足则 `UNKNOWN` 与隔离，不换 ID 重试。

真实 Windows 反例揭示，独占打开旧目标仍挡不住新建根外硬链接，因此原地 `MODIFY` 不安全。助手改为暂存完整目标字节、标记删除待定并在写入前重新检查链接数；随后通过持有句柄的无覆盖换名提交。`MODIFY` 先把旧对象移到受管父目录的随机备份，再把暂存对象放到原名；目标名空窗被外部抢占或提交后证据不明时报告 `effect_uncertain`，Gateway 保留原调用 `DISPATCHING` 供恢复转为 `UNKNOWN`，不会把它结算为确定无效果的 `FAILED`。杀进程可留下暂存/备份，不能只凭文件名或摘要自动清理、重试。助手最多 16 文件，执行正文总量 256 KiB，单文件读/摘要上限 1 MiB；超限或助手缺失不回退到 Node 路径写入。

开发自检：`cargo fmt --check`、离线 `cargo check`/Clippy `-D warnings`/release 构建通过；原生真实 Windows 测试 15/15，覆盖根/祖先 junction、普通父目录及同内容目标替换、备用数据流、硬链接抢占（含暂存创建到删除待定的闩锁）、部分成功后效果不明、进程中断清理。助手单独离线构建时 SHA-256 为 `8bf87a470f3e827abc3d78675bc1646c8d8f483884f6e5297984ed5d017564eb`；桌面脚本在锁定 MSVC 环境重新构建的随包助手 SHA-256 为 `af7015fddc042bf79b044bd38bd3ac2f6cecfb265257bce028873a8f6c8796c9`，与当前 release 文件及 manifest 一致。API TypeScript 构建通过；隔离 PG `real-tools-gateway` 48/48（含新增普通父目录、同内容目标替换及同内容恢复反例），迁移完整链 37 行且 migration 8/8，临时 PG 集群全部停止删除。曾有一轮 47/48：CLI 超时杀树时 `close` 抢先把 TIMEOUT 记为 FAILED；设置终止中的优先状态后复跑 48/48，无跳过。桌面 `test-release` 目录包构建成功，EXE SHA-256 `7b1e7e7ff9389081a6b2a1b401a03ee461514122d65bf604e9b15073f9c0e96a`，17155 个发布资源摘要与清单一致，禁用配置文件 0，`verify-desktop-package.mjs` 通过。此处是开发自检；真实 Job 恢复链、人工交互与 M06 总出口需继续验收，安装包仍属 M07。

随后从同一源码重建当时的 `apps/desktop/release`（EXE SHA-256 `6c4f3dbaebf8ebf0efe75585bba1ef794124495fb3060f4ab34e3445b417086c`，manifest SHA-256 `62cb2bf27203a5adf62ef8b103365eb232c48ca8db27d0ff5d46735e60e68bc5`）；17155 项资源清单与独立包核验通过。该包当时的真实 Windows Job 链再次通过：回执停在原 Invocation，强杀宿主后旧宿主/API/Supervisor/Worker 全部退出；重启后原调用唯一且 `UNKNOWN`、账本 `PARTIAL`、资源隔离，CREATE 已应用/原 MODIFY 冲突逐文件与磁盘一致；明确处置后 Run 失败、Task 返 READY、claim 释放，原 Invocation 仍留历史 `UNKNOWN`，一次性 PG 停止删除。该包当时的真实 WebView2 自动化截图与文本检查再次通过，临时会话已清理。此段为历史构建记录，下方证据文件已由最新包复验覆盖。包构建 SHA 不等于安装器或人工交互验收。**M06 整体仍为 IN_PROGRESS**：尚需独立审查、更多句柄边界竞争出口（尤其注册时旧资源物理身份与中途崩溃残留）、人工交互及总验收；原生助手不为任意同用户代码提供 OS 沙箱。

包构建后另补嵌套 `WRITE_FILE` 正常执行反例：冻结差异与账本均返回 `nested/note.txt`，账本根为受管资源根，磁盘正文与目标一致。使用该确切**随包助手**的隔离 PG `real-tools-gateway` 复跑 49/49，无失败或跳过，临时集群停止删除；新增反例仅在测试源码，不改变上述 release 二进制。

最后收紧了 API 对原生助手返回的根身份、路径、动作、逐文件状态及目标摘要的校验，避免不完整回执被结算为成功；修正校验表达式后 API 构建通过，使用随包助手的隔离 PG `real-tools-gateway` 再次 49/49，37 条迁移全部应用，临时集群停止删除。由该源码重建的当前 `apps/desktop/release` EXE SHA-256 为 `f9ef6375799e8caedfa789b1ffd0106e8c0e3afda0450d6d2eade3e8f21971a5`，manifest SHA-256 为 `a5b2e1c58ee9ea62c37f5cc76bf86421ae5ced58d5f9a313a957d4875f2a4b85`，随包原生助手 SHA-256 为 `af7015fddc042bf79b044bd38bd3ac2f6cecfb265257bce028873a8f6c8796c9`；17155 项资源独立核验通过。该确切包的 [真实 Windows Job 记录](evidence/m06-windows-job-file-write.txt)通过原 Invocation 强杀、恢复、`PARTIAL` 账本、资源隔离和人工处置全链；真实 WebView2 [自动化截图](evidence/m06-webview-file-write-diff.png)与 [文本记录](evidence/m06-webview-file-write-diff.txt)显示冻结计划与执行账本分开，截图已人工查看；两次临时 PG 和进程均清理。以上仍是开发自检，不代表安装器、人工交互或 M06 总验收通过。

新增原生 Windows 空窗强杀反例：在 `MODIFY` 把原目标按持有句柄移至随机备份、尚未提交新目标时终止助手。首次断言期望仅残留旧备份，实得两个残留；核对后确认旧内容备份仍是冻结的目标 File ID，新内容暂存是另一 File ID，原目标名缺失。按真实行为固定回归后，原生助手测试 16/16、`cargo fmt --check` 通过。此轮只修改测试和文档，现有 release EXE SHA-256 与随包助手 SHA-256 均未变；它证明了缺回执时不能仅按文件名自动整理，当前恢复会保留原 Invocation `UNKNOWN` 和资源隔离，但人工处置入口只接受有确定 `PARTIAL` 账本的场景。下一步须先给无回执崩溃残留设计可核验、绑定原调用的观察与处置出口，再考虑释放资源；本反例不等于该出口已经完成。

## 增量 G：无回执崩溃残留的人工处置开发自检（2026-09-27）

承接上述强杀反例。新 Windows 动作在原 FILE_WRITE Invocation 无执行回执、账本 `UNKNOWN` 时，原生助手以冻结根和父链 File ID 为边界，只读观察每个目标及同目录 `.__relay-file-io-` 候选的 File ID/sha256；候选不被归因于原调用。观察有界且安全、可信桌面 Job 停机证明、资源隔离和原业务栅栏均满足时，Run 页允许人工确认“保留当前目标与候选残留、失败旧 Run、任务交还人工”。处置快照绑定原 Invocation、变化集和目标/候选身份及摘要；提交前重读，变化则 409。原 Invocation 和账本 `UNKNOWN` 保留，程序不清理、补写或自动重试文件。复用 0034 表和命令回执，没有新 migration。

真实 Windows 强杀后发现同父目录两目标的候选会被助手重复打开：第一个目标观察持有独占候选句柄，第二次打开同一候选报 `NT_OPEN_FAILED`，导致完整观察被拒。增加先红后绿的同父目录反例，助手改为按父目录路径和 File ID 复用一次候选观察，并将目标、候选和父链句柄保持到整单最终重枚举和目录时间复核；没有放松共享限制。原生 `cargo fmt --check`、离线 `cargo check`/Clippy/release 构建及真实 Windows 测试 20/20 通过；当前独立构建助手 SHA-256 为 `A03FD152DC357ADC62C3E18485EE304A35E15038FD6025105AC329BF5E205CB3`。

隔离 PostgreSQL/HTTP/Worker 定向 1/1 通过，无跳过且临时 PG 已停止删除：真实 helper 在 MODIFY 备份换名空窗强杀后，目标名缺失、两份残留保留；恢复前无可信证明不能处置，恢复后 `NO_RECEIPT` 预览显示目标缺失与两份候选；外部修改候选使旧观察哈希 409，刷新后显式结清。结果原 Operation `MANUALLY_CLOSED`、Invocation `UNKNOWN`、账本 `UNKNOWN`、claim `RELEASED`、Run `FAILED`、Task `READY`，仍只有一次 Invocation，目标和残留未被处置命令修改。旧 `PARTIAL` 人工处置图链定向 1/1 再通过；`real-tools-gateway` 完整 49/49 再通过，两轮隔离 PG 均停止删除。React Run 页定向组件 6/6 与生产构建通过，覆盖无回执候选展示、非归因提示和原调用/观察摘要提交。此处为开发自检；真实打包 Windows Job/WebView2 路径及 M06 独立总验收需另行绑定确切发布包。外部进程在最终文件观察后仍可修改内容，`complete:true` 不是持续锁定的磁盘快照。

随后发布目录构建从该时点源码完成，EXE SHA-256 `2ae333ee4a33f2047c39db2006f7a8c31afba0ce76eaec37d1a726decc2e5f2a`，manifest SHA-256 `85d3b728bec66896bdfb8e536948b3c51a9d37609c5082a8982af97bb06c8084`，随包助手 SHA-256 `a4036204937a0910565f129fd8d65fe9629972deabb261961da7ef4badd82978`；17,155 个资源摘要与清单独立核验，禁用配置文件 0。该确切包的 [真实 Windows Job 记录](evidence/m06-windows-job-file-write.txt)再次通过旧 `PARTIAL` 回执停机、恢复、隔离与人工处置全链；[WebView2 文本记录](evidence/m06-webview-file-write-diff.txt)与[截图](evidence/m06-webview-file-write-diff.png)再次显示冻结计划与执行账本分开，截图已人工查看。两次隔离桌面会话的进程和 PG 均清理。它们是相邻既有路径的真实包复验；无回执强杀处置的完整桌面 Job/WebView2 同场景、人工交互和 M06 总出口仍未验收。构建后共享工作区的其他模块继续修改了若干源码文件，故该包只绑定构建时的确切源码快照，不代表后续所有工作区改动已装包。

另以 debug 助手只负责确定性制造备份换名空窗强杀，并改用上述**随包 release 助手**执行恢复残留观察；真实隔离 PG/HTTP/Worker 原反例再次 1/1 通过，无跳过，临时 PG 已清理。debug 闩锁不在 release 助手中，不能把这条组合自检称为确切包的完整桌面 Job 同场景验收。

## 增量 H：受管资源登记身份栅栏开发自检（2026-09-28）

0038 为受管资源增加登记时 `file_write_root_id`，旧行保留 NULL。新 Windows 资源登记在事务外用原生助手捕获目录身份，应用事务写入；助手拒绝的根仍可供其他能力登记，但 `file_write_identity_bound=false`。Windows 新文件写动作在准备期要求非空登记身份，并比较当前根 File ID；普通目录在登记后、准备前替换，返回 `GATEWAY_RESOURCE_ROOT_CHANGED` 且不生成 Operation/Review。旧资源返回 `GATEWAY_RESOURCE_IDENTITY_REQUIRED`，不能把当前目录回填成登记时对象。原已准备 Operation 继续依靠 0036 的冻结证据。应用数据库角色不能更新登记身份列；资源详情只读返回绑定标志，Connections 页提示重新登记路径。创建命令回执保持原字符串字段形状和目录失踪后的幂等重放。

真实隔离 PostgreSQL（临时集群均停止删除）迁移 8/8、`real-tools-gateway` 51/51（含新增普通根替换与历史空身份 2 项、应用角色改写列被 `42501` 拒绝）、`gateway` HTTP 回执/资源详情定向 1/1，无失败或跳过。React Connections 定向组件 9/9，API/Workbench TypeScript 检查及生产构建通过。后端测试使用上一确切包随附的原生助手读取登记与准备身份。

随后从当前源码构建新桌面目录包：EXE SHA-256 `4120cd3dfb8210db2664dbf2da27a1341e7e7d14b7d4d956c9052be5b09fee07`，manifest SHA-256 `ad822bf76cd54543a3500b067cfc00a34bfaa0f2c34a33a51f8b8fc815a3d695`，随包助手 SHA-256 `a4036204937a0910565f129fd8d65fe9629972deabb261961da7ef4badd82978`；17,156 个资源摘要核验通过，禁用配置文件 0。0038 migration 已包含在包内。该确切包的[真实 Windows Job 记录](evidence/m06-windows-job-file-write.txt)再次通过旧 `PARTIAL` 回执强杀宿主、可信停机、原 UNKNOWN/隔离与显式人工处置全链；[WebView2 文本](evidence/m06-webview-file-write-diff.txt)和[冻结差异截图](evidence/m06-webview-file-write-diff.png)再次显示冻结计划差异与执行账本分开。同包另自动进入 Connections 页核对当前受管资源 ID 与“Windows 文件写入目录身份：已绑定”，[截图](evidence/m06-webview-managed-root-identity.png)已人工查看。三次一次性 PG/桌面会话均停止删除，旧进程身份核对后无存活。该包只代表构建时源码快照，以上路径不等于无回执强杀的完整桌面 Job/WebView2 同场景、人工交互或 M06 总验收。M06 继续 IN_PROGRESS。

0038 后续发现：旧唯一约束仍覆盖 `DISABLED` 资源，因此“停用后同路径重新登记”无法执行。追加 0039，将唯一性限定为同项目同路径的活动资源；历史资源、动作、占用、批准均不改绑。新增真实 Windows/PG 反例证明旧空身份资源可停用后以新 ID 重新登记，新行捕获根 File ID；HTTP 创建、停用、重建及目录失踪后的同命令回执重放定向 1/1。0039 后重新跑完整迁移 8/8、Gateway 28/28、real-tools 52/52，均无失败或跳过；隔离数据库停止删除。上段 0038 包为历史时点快照，其证据文件现已由下段新包复跑结果更新。

包含 0039 的最终桌面目录包 EXE SHA-256 `577a731e3022e540e38edc6a152301afc31b5a585e75eabb999919bbd5863efc`，manifest SHA-256 `39a4d96f673e34b514739bfa2da58281acf53909d9d5cd7afd1cae156a128e93`，随包助手 SHA-256 `a4036204937a0910565f129fd8d65fe9629972deabb261961da7ef4badd82978`；17,157 个资源摘要及 0039 migration 核验通过，禁用配置文件 0。此确切包的[Windows Job 记录](evidence/m06-windows-job-file-write.txt)和 [WebView2 记录](evidence/m06-webview-file-write-diff.txt)均重新生成并通过；[冻结差异截图](evidence/m06-webview-file-write-diff.png)与[目录身份截图](evidence/m06-webview-managed-root-identity.png)来自同一包的 WebView2 会话。两次一次性 PG/桌面会话已清理。桌面 Job 复验覆盖旧 `PARTIAL` 回执路径，不覆盖无回执强杀残留的完整桌面同场景；人工交互与 M06 总验收仍待完成，M06 保持 IN_PROGRESS。

## 增量 I：确切桌面包无回执强杀与 WebView2 处置复验（2026-09-28）

使用上节包含 0039 的同一 release EXE（SHA-256 `577a731e3022e540e38edc6a152301afc31b5a585e75eabb999919bbd5863efc`）和随包原生助手，在一次性 Windows Job + PostgreSQL 会话中先产生原 `FILE_WRITE` Invocation。测试程序仅在隔离数据库锁住这条 Invocation，让助手完成真实文件写入后、回执 UPDATE 落库前强杀旧桌面宿主；先确认旧宿主、API、Supervisor、Worker 均退出，再终止仍排队等待行锁的该测试数据库语句并解锁。测试第一版在解锁后发现排队语句仍可提交回执，说明 **Job 退出并不等于数据库中已送出的语句即时取消**；这是故障注入的关键边界，不能把“已停机”本身当作“无回执”证明。最终复跑在解锁后确认原 Invocation 的 `result_ref` 仍为空、调用次数为 1，随后才重启桌面。

重启后可信停机证明与原 Invocation、Worker ID/epoch、投递 epoch、command ID 和 launch ID 对应；原 Operation/Invocation 均为 `UNKNOWN`，账本 `UNKNOWN`、资源 `QUARANTINED`，没有第二次 Invocation。只读处置预览为 `NO_RECEIPT` 且允许在当前观察下人工决定。真实 WebView2 自动打开原 Run，核对“没有留下执行回执”“不能归因于原调用”、逐文件当前 File ID 与“保留当前目标与候选残留并结束旧 Run”按钮，截图见[处置前](evidence/m06-webview-no-receipt-before.png)；自动点击二次确认后，Run `FAILED`、Task `READY`、claim `RELEASED`，原 Invocation 仍 `UNKNOWN` 且只有一条，已落盘的新文件摘要不变，截图见[处置后](evidence/m06-webview-no-receipt-after.png)。脱敏的 ID、哈希、状态及会话清理结果见[Windows Job 无回执记录](evidence/m06-windows-job-no-receipt.txt)，最终 `M06_WINDOWS_JOB_NO_RECEIPT=PASS`，临时 PG 和桌面进程已清理。

此发布包反例在**助手完成文件效果后、回执保存前**中断；MODIFY 换名空窗留下备份与暂存候选的反例仍是原生 debug 助手加隔离图链，尚未在确切 release 包的完整桌面同场景复现。WebView2 自动操作也不等于人工交互试用或 M06 总验收，M06 保持 IN_PROGRESS。
