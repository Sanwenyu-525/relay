# 测试启动与清理整改（2026-09-28/29）

## 1. 范围

修复独立复验中的首文件 `api-artifacts` 启动超时连带失败与 `after` 钩子 `undefined.stop`，补阶段耗时证据与失败回收。不改业务断言。

## 2. 根因定位

### 2.1 原失败形态（overall-recheck-2026-09-28）

- before hook：`the API did not become live within 15000ms`，且错误尾部 `api.readOutput()` **为空**（进程 15s 内无任何 stdout/stderr）。
- 18 个用例被 before 失败连带失败；after hook 对未赋值 `api` 调 `stop` → `Cannot read properties of undefined (reading 'stop')`。
- 隔离复跑 18/18 通过；全量日志中后续文件正常，说明不是业务断言损坏。

### 2.2 缺陷拆分

| 层 | 问题 | 定性 |
|---|---|---|
| harness | `waitForLiveness` 不区分「未监听」「子进程已退出」「spawn 失败」，空输出挂死与慢启动都拖满 15s | 诊断缺陷 |
| harness | `startTestApi` 在 liveness 失败后不回收已 spawn 的 API 子进程与临时 data_root | 资源泄漏 |
| 测试 after | `api.stop()` / `server.close()` 在 before 未赋值时抛 TypeError，掩盖真实错误并留下子进程 | 清理缺陷 |
| 超时 | 成功启动实测 liveness 1.5–5.9s（全量 70+ 次采样）；15s 对正常路径足够，但空输出挂死时加长超时只会掩盖 | 不单靠加超时 |

原「15s 空输出」现场无法在修复后复现；本轮用退出即失败 + spawn 错误捕获 + 阶段计时把下一次现场变成可归因证据，而不是继续盲等。

### 2.3 阶段耗时（本轮实测）

| 阶段 | 证据 | 典型值 |
|---|---|---|
| initdb | `[timing] initdbMs` | 5003–5543 ms |
| postgres start | `[timing] postgresStartMs` | 277–412 ms |
| business migration | `[timing] businessMigrationMs` | 651–699 ms |
| API liveness（全量 70+ 次） | `[api-harness] live ... livenessMs` | 1534–5883 ms（中位约 1650） |
| first output | `firstOutputMs` | 与 livenessMs 几乎同时（`api_listening` 在 listen 后打印） |

结论：库就绪与迁移均在 6s 内；API 进程启动到 `/health/live` 200 正常约 1.6s。原 15s 超时不是「机器慢」导致的常规超时。

## 3. 修改

1. `api-harness.ts`
   - liveness 探测：子进程已退出 / spawn error → 立即失败并带 pid、exitCode、firstOutputMs、outputBytes。
   - 成功路径打印 `[api-harness] live ...` 阶段耗时。
   - `startTestApi` 失败时 `discardFailedStart`：只停止本 harness 的子进程 PID + 删除本 data_root。
   - `stopApi` stdin 优雅退出超时后 `child.kill()`（仍只针对本 PID）。
   - 探测请求带 2s 超时，避免 connect 挂起堵死循环。
   - 启动超时 15s→30s：在「退出即失败」之后作为冷启动余量（实测最大成功 5.9s），不是唯一修复手段。
2. `api-artifacts.integration.test.ts` after：触发器清理与 `api?.stop()` / `appDatabase.close()` 用 try/finally 分离。
3. 其他 integration after（api-state/api-tasks/api-lists/… 与 web-fetch 的 `server`）：`api?.stop()` / 防御未初始化资源，不删业务断言。
4. `run-integration.ps1`：initdb / postgres start / business migration 耗时输出。

## 4. 实测计数

### 4.1 定向 api-artifacts（-SkipBuild -TestFile api-artifacts）

- 发现 18 / 通过 18 / 失败 0 / 跳过 0
- 首用例 before 含启动约 2.3s；日志：`api-artifacts-targeted.log`

### 4.2 全量 PG 集成（当前基线，`run-integration.ps1 -SkipBuild`）

- **发现 469 / 通过 462 / 失败 4 / 跳过 3**；status FAILED（仅因下述基线）
- **首文件 api-artifacts 18/18 通过**，`[api-harness] live ... livenessMs=1756`，无启动超时连带，无 `undefined.stop` / `undefined.close`。
- 4 项失败全部是迁移清单基线仍停在 42，而实际已有 `0043_model_call_verify`（并行任务新增）：
  - `cli`：migrate entry 清单缺 0043
  - `migration`×3：V001 应用清单、advisory lock、并发迁移计数 `43 !== 42`
- 3 项跳过：2×`RELAY_MODEL_*` 未配置（real-model）、1× Windows helper 杀进程场景（既有 SKIP）。
- 日志：`full-integration-baseline.log`（本文件为修复后当前基准，不与其他轮次拼接）

### 4.3 全量 PG 集成（修复后首轮，带 build）

- 发现 473 / 通过 305 / 失败 165 / 跳过 3
- 首文件 api-artifacts 已通过；失败主因是 `0043` 迁移文件在该轮运行中被改动 → `MigrationIntegrityError` 大面积连带（非 harness）。日志：`full-integration-after-fix.log`

## 5. 验收对照

| 条件 | 状态 |
|---|---|
| 全量无「首文件启动超时连带失败」 | 已满足（api-artifacts 首文件通过） |
| 清理钩子不再抛 `undefined.stop` | 已满足；web-fetch 同类 `undefined.close` 一并修 |
| 有阶段耗时证据 | 见 §2.3 与日志 `[timing]` / `[api-harness]` |
| 业务断言未删 | 已保持 |

## 6. 剩余限制

- 原 15s 空输出挂死现场未复现；若再发，新错误信息可直接区分退出/spawn/未监听。
- 全量仍差 4 项：`cli`/`migration` 迁移清单基线未纳入 `0043_model_call_verify`（并行任务新增迁移，基线归该任务维护）。属清单过期，不是启动/清理缺陷。
- 两轮全量计数分别记录，不拼接为一次通过。
- 未全局杀进程；回收只针对 harness 自 spawn 的 PID 与临时目录。
