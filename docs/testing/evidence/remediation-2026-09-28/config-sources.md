# 模型配置来源核实（2026-09-28 整改第一包）

范围：只读盘点当前工作区三条链的配置来源与状态。只输出 provider / 模型名 / 端点 / 指纹，不输出任何密钥值。本报告对应[整体验收 A01/A02/A08](../../overall-acceptance-2026-09-28.md) 与[整改提示词第一包第 2–3 条](../../../../prompts/overall-remediation-2026-09-28.md)。

## 1. 结论表

| 链 | 配置来源 | 启动注入方式 | provider / 模型 | 端点 | 指纹（sha256，不含密钥） |
|---|---|---|---|---|---|
| 浏览器 dev API（dev-stack） | `apps/api/.env` | `node --env-file=.env dist/src/main.js` | `openai-compatible` / `agnes-3.0-flash` | `https://api.agnes-ai.cn/v1` | `c71bbfef65746fd1d80af71af751972989911378160d8791080a4dd2336f9c4a` |
| 桌面 API（test-desktop / EXE） | `.relay-test/desktop.env`（或 `%APPDATA%\dev.relay.agent\desktop.env`） | 宿主 `lib.rs` 以 `node --env-file=<config>` 启动 API | `fake`（未配置；改前该文件仅有 4 个运行时键） | — | fake 端口（`fake-model-v1`） |
| 桌面 Worker / Supervisor | 同一 `desktop.env` | Supervisor 同样经 `--env-file` 启动，Worker `spawn` 继承 `process.env` | 与桌面 API 同源 → `fake` | — | 同上 |

环境变量扫描：`Process` / `User` / `Machine` 三个作用域均无 `RELAY_*` 变量——桌面链不依赖系统环境注入。

指纹算法与生产一致（`openai-compatible-model-port.ts` 的 `configFingerprint`）：sha256(provider+model+baseUrl+timeoutMs+四项上限)，**不含 API Key**。复现命令见本目录日志。

## 2. 事实与边界

1. 现场浏览器显示真实 Provider 的来源是 `apps/api/.env`（含 `RELAY_MODEL_*` 六个键），不是桌面配置；**不能据此声称桌面已配置**。桌面当前为 Mock，属配置事实而非故障。
2. 桌面 API 与 Worker 消费同一份 `desktop.env`（同一 `--env-file` + 进程继承），配置来源一致；改前 `lib.rs` 键白名单只允许 4 个运行时键，`RELAY_MODEL_*` 会被宿主以 `unsupported setting` 拒绝——这是 2026-09-27 曾确认的「桌面包固定 Mock」边界。
3. 本次整改按 [A02 验收标准](../../overall-acceptance-2026-09-28.md#a02-p1测试版配置保存路径不完整)（「保存模型配置后 Start、Stop、重新 Build/Start 仍保留，API 与 Worker 指纹一致」）放开该边界：
   - `lib.rs` 白名单加入 9 个 `RELAY_MODEL_*` 键（其余键仍拒绝）；
   - `scripts/test-desktop.ps1` Start 由整文件重写改为合并：4 个运行时键归脚本，其余键归用户，Start/Stop/重打包不丢；
   - `scripts/diagnose-desktop.mjs` 白名单与提示同步；`desktop.env.example` 补充可选模型键说明。
   密钥边界不变：只存本地配置文件，经 `--env-file` 传给 API/Supervisor/Worker，不入库、不进 UI、不写日志。
4. dev-stack 只启动 API，不启动 Supervisor/Worker；浏览器链的执行闭环依赖外部启动的 Worker 进程。设置页如实显示「Worker 可执行：尚未验证」，不伪造探测结果。
5. 配置存在 ≠ 调用成功。真实外呼验证属第二包，且当前没有放行记录，保持阻塞。

## 3. 验证记录

- Start 合并逻辑：临时 desktop.env 注入模型键后按新脚本逻辑合并 → 4 运行时键重写、模型键与注释保留、无重复键（本目录 `merge-check` 输出，见会话记录）。
- `workbench tsc --noEmit` 通过；`node --test scripts/diagnose-desktop*.test.mjs` 2 通过（1 项需真实发布包，属既有 SKIP）。
- `cargo test`（lib.rs 新增 `desktop_config_accepts_runtime_and_model_keys_and_rejects_others`）在全量 PG 回归结束后执行，结果另行补记。
