# M06 真实工具独立验收

日期：2026-09-27。结论：**退回，M06 保持 IN_PROGRESS**。

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
| API 单元测试 | 103/103 | [日志](evidence/m06-independent-20260927-unit.log) |
| 新增反例前全量真实 PG | 399 项：393 通过、4 失败、2 跳过 | [日志](evidence/m06-independent-20260927-full-pg.log) |
| 新增反例后 real-tools 定向真实 PG | 17 项：原 14 项通过、新 3 项失败，无跳过 | [日志](evidence/m06-independent-20260927-real-tools.log) |

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
