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
