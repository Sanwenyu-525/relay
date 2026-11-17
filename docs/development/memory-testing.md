# 长期记忆 V2 测试与验收记录

本文件记录 MEMORY-ACCEPTANCE-20261115 第二轮（2026-11-16）的真实运行证据。测试使用真实 PostgreSQL 18.6、真实 HTTP API 与 Workbench；编译通过、fixture、截图存在本身都不单独构成验收。第一轮报告保留在 [B-fix-report](../../tmp/MEMORY-V2-20261115/B-fix-report.md)，本轮结论与剩余项见 [最终报告](../../tmp/MEMORY-V2-20261115/C-final-acceptance-report.md)。

## 1. 迁移与隔离

| 数据库 | 用途 | ledger | 说明 |
|---|---|---|---|
| `relay_memory_final_20261115` | 全新迁移验证 | 170 行，最新 `0169_assist_skill_invocations` | 完整链一次应用；重复运行 `applied: []` |
| `relay_memory_ui_final_20261116` | 浏览器/操作验收 | 170 行，最新 0169 | 28 条记忆、5 条捕获任务、4 条 Skill 事件、1 项目/会话/用户消息 |
| `relay_memory_ui_20261115` | 第一轮旧 UI 库 | 0168 旧 checksum `8d3da836...` | 与当前 `4f918f35...` 不一致；不篡改 ledger、不强行应用 0169，本轮改用全新 UI 库 |
| `relay_trial` | 真实库（只读） | 167 行，最新 `0166_memory_actor_sources` | 未获授权，本轮没有写入 0167/0168/0169 |

`relay_memory_final_20261115` 中三条迁移 checksum：

- `0167_knowledge_organization`：`95110df548ec183941d7bf9559cdb4cbbff69102b02368c37a90d2d3d9c2d4a6`
- `0168_memory_capture_tasks`：`4f918f35212aee900f62db3339824cf5e839672c828745e23d7bf1661a5acd9c`
- `0169_assist_skill_invocations`：`792fe233bdc9ef5074bf2fe14603594f1fef1277c2543f5fd3de1e69fd159f06`

`0169` 已在隔离库核验表结构、`status` 白名单、`settled`/`RUNNING-started_at` 约束、`invocation_key` 唯一键、消息/会话索引和 `GRANT ... TO relay_app`。`migration.integration.test.ts` 的 `ALL_MIGRATIONS` 已补 0167/0168/0169。

## 2. 后端集成测试

命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 `
  -SkipBuild -UseCLocale -TestFile 'memory-system-v2,memory-module,memory-auto-capture,memory-status,assist-memory'
```

| 测试文件 | 最新结果 | 覆盖 |
|---|---|---|
| `memory-system-v2` | 9/9 PASSED | 显式/自动写入、去重与同键替代、敏感凭证、验证/固定、设置、HYBRID 拒绝、预算、整理、导入导出/删除、修订、作用域隔离 |
| `memory-module` | 11/11 PASSED | 真实模型输入中的记忆、来源身份、设置回放、显式来源、撤回、revision |
| `memory-status` | 3/3 PASSED | 有效状态、过期/停用过滤、默认 ALL 与项目隔离 |
| `memory-auto-capture` | 19/19 PASSED（16.4s） | 结算后落库、寒暄不提、关闭捕获、显式记住隔离、敏感/会话关闭回执、真实子进程崩溃、幂等、失败账本、并发去重、冻结模型路由、OpenRouter 资格 |
| `assist-memory` | 最新全量 0/29；前次 25/29；定向 2/2 PASSED | 压缩、Checkpoint、来源撤回、捕获屏障、自动压缩延迟/恢复、工具上下文、预算、恢复 |

`assist-memory` 最新全量 0/29 的根因仍是测试环境：首条 10,000 轮压缩用例在 `startTestApi` 阶段等待 30 秒仍未监听（子进程 alive、217 次探测 `ECONNREFUSED 127.0.0.1:10350`），后续 28 条级联；前一次 25/29 是同一 `manual HTTP compaction ... restart` 重启用例超时 + 3 条 `ECONNREFUSED`。单独运行该重启用例与捕获屏障用例为 **2/2 PASSED**。本轮更早在无并行构建负载时曾全量 **29/29 PASSED（约 186s）**；最新全量失败不能写成“全绿”，最终报告将其列为残余验证风险。

`memory-auto-capture` 的真实崩溃测试：

- 场景 A：子进程领取任务并进入 RUNNING 后 `taskkill /F /T`，3 秒租约过期，新 Worker `recoverExpired` 回收、重新领取并 SUCCEEDED；`attempts=2`，只写 1 条记忆、1 条来源；
- 场景 C：子进程在“记忆已提交、任务未结算”之间由 `beforeSettle` 注入点挂起，父进程看到 `CHILD_WRITTEN` 后 `taskkill`；重启后重放命中去重，返回 `{ duplicate: true, memoryId }`，任务 SUCCEEDED 且只保留 1 条记忆。这里进程被 OS 强制终止，但暂停窗口由测试注入点固定，不等同于完全无注入的真实崩溃；
- `forceKill()` 使用 `spawnSync('taskkill','/F','/T','/PID',...)`，不依赖 Node 的 `child.kill`。

`assist` 相关：Skill 事件持久化用例 1/1 PASSED；扩展后的 `assist HTTP surface` 2/2 PASSED（USER 消息无任务时 `memory_capture=null`；助手消息 AUTO 从 EMPTY → PENDING → SUCCEEDED，`saved_count=1`；Skill 摘要字段可见）。

## 3. 压缩前捕获屏障

真实集成覆盖：

1. 会话产生正常对话轮，捕获任务在即将被覆盖的旧轮（`fixture(17)`、`seq 26`）保持 PENDING；
2. 手动压缩返回 409 `MEMORY_CAPTURE_PENDING`；
3. 自动压缩遇到范围内 PENDING/RUNNING：当前消息照常 COMPLETED，原始 36 条消息不删，Checkpoint 保持 `null`，自动请求持久化为 deferred；
4. 捕获任务 SUCCEEDED 后，捕获 tick 恢复压缩请求，Checkpoint 提交到 `through_seq=26`，当前轮 35/36 保持原文，消息总数仍 36；
5. 任务置终态后不创建重复压缩请求；压缩模型失败保留原始消息与上一个有效 Checkpoint；
6. 手动屏障用例结束时取消自己建立的压缩请求，避免污染后续全局 tick。

## 4. Workbench 单元测试与静态检查

| 文件 | 结果 | 覆盖 |
|---|---|---|
| `tests/messageExecutionTraces.spec.tsx` | 3/3 PASSED | 无任务不渲染、AUTO+EXPLICIT 聚合、Skill 多事件 |
| `tests/memoryView.spec.tsx` | 2/2 PASSED | 真实列表/统计、筛选与新建命令 |
| `tests/assistMemoryView.spec.ts` | 4/4 PASSED | 聊天页不恢复旧记忆控制带、斜杠命令路由 |
| `tests/memoryStatusClient.spec.ts` | 4/4 PASSED | 有效状态查询参数 |
| API `tsc --noEmit` | EXIT=0 | 本轮代码 |
| Workbench `tsc --noEmit` | EXIT=0 | 本轮代码 |

`tests/memoryStatus.spec.ts` 是 2026-10 的旧 `/knowledge?kind=MEMORY` 页面测试，仍引用已删除的 `.knowledge-row`、`knowledge-*` selector；当前产品使用 `/memory`，本轮未改该文件，因此 8/8 失败。它不等于新页面回归失败，但“Workbench 全量测试全绿”尚未成立。相关新页面由 `memoryView.spec.tsx` 和真实浏览器证据覆盖。

## 5. 浏览器 E2E（真实 API + 真实 PostgreSQL）

真实栈：Workbench `http://127.0.0.1:4174`、API `http://127.0.0.1:3099`、PostgreSQL `127.0.0.1:12525/relay_memory_ui_final_20261116`。聊天四档由 `bu` 浏览器驱动；记忆页四档与轮询由项目自带 Playwright（headless Chromium）驱动，最终脚本 `browser-acceptance.mjs` 输出 `errors=[]`。

四档视口结果：

| 视口 | `innerWidth` | `documentElement.scrollWidth` | `body.scrollWidth` | 横向溢出 |
|---|---|---|---|---|
| 1660×895 | 1660 | 1660 | 1660 | 无 |
| 1280×800 | 1280 | 1280 | 1280 | 无 |
| 1024×768 | 1024 | 1024 | 1024 | 无 |
| 768×900 | 768 | 768 | 768 | 无 |

捕获面板异步刷新实测：

- 展开后立即读取，捕获请求数 2；
- PENDING 可见；
- 在数据库中把任务置为 SUCCEEDED，7.5 秒内列表显示“已捕获”，请求数 3；
- 同拍刷新统计：顶部“捕获待处理”从 1 变为 0，不再保留列表“已捕获”、头部“待处理 1”的旧状态；
- 再等 7 秒仍为 3，终态后停止轮询；
- `document.hidden` 跳过刷新、卸载清 timer 由代码路径与页面状态共同验证。

截图在 `tmp/MEMORY-V2-20261115/screenshots/`：

| 文件 | 内容 |
|---|---|
| `chat-trace-expanded-1660x895.png` | 聊天轨迹，1660 |
| `chat-trace-expanded-1280x800.png` | 聊天轨迹，1280 |
| `chat-trace-expanded-1024x768.png` | 聊天轨迹，1024 |
| `chat-trace-expanded-768x900.png` | 聊天轨迹，768；捕获与失败 Skill 已展开 |
| `memory-final-1660x895.png` | 记忆页，1660 |
| `memory-final-1280x800.png` | 记忆页，1280 |
| `memory-final-1024x768.png` | 记忆页，1024 |
| `memory-final-768x900.png` | 记忆页，768；筛选改 2 列，无文字截断 |
| `memory-capture-pending-1280x800.png` | 捕获面板 PENDING |
| `memory-capture-settled-1280x800.png` | 同一面板已捕获，顶部统计同步“捕获待处理 0” |

768 宽度原先筛选下拉被省略号截断；本轮把 54rem 以下改为 2 列后，`全部类型/全部验证状态/全部有效状态/全部来源/全部来源类型/全部工作空间` 完整显示，且仍无横向溢出。

## 6. 性能

本轮没有重跑 10,000 条性能基线；第一轮局部数据仍只代表当时临时库与单机环境，不作为 SLA：列表 p50 36.3ms / p95 126.1ms，统计 p50 38.4ms，选择性 FTS `EXPLAIN` 命中 GIN 4.2ms。第二轮新增的 6 秒轮询只在面板展开且存在 PENDING/RUNNING 时发生，终态即停；未做并发、冷缓存、网络故障压测。

## 7. 未验证与未实现

- **真实库迁移未执行**：`relay_trial` ledger 仍 0166；0167/0168/0169 只在隔离库验证，未经授权不写真实库。
- **`assist-memory` 最新全量不是全绿**：最新 0/29（首条 10,000 轮压缩的测试 API 30 秒未监听、后续级联）；前次 25/29 为同一 API 重启用例超时；定向 2/2 通过，早前非并发全量 29/29 通过；并行 Tauri 构建会放大该环境敏感性。
- **`memoryStatus.spec` 8/8 失败**：旧路由/旧 selector 的既有测试，未改动，未用删测试或放宽断言掩盖。
- **聊天四档由 `bu`、记忆页四档由 Playwright 采集**：两种浏览器路径都连接真实服务，但并非同一次页面会话内完成全部四档；WebView2/Windows 桌面窗口未验。
- **Skill 轨迹只覆盖第一方 Skill**：普通 MCP/文件工具仍在 `assist_session_tool_calls`，不会显示为 Skill；输入/输出只存脱敏截断摘要，不验证完整敏感参数审计。
- **崩溃场景 C 有测试注入点**：OS 强制终止真实，但暂停窗口由 `beforeSettle` 固定，不能写成完全无注入的自然崩溃。
- **未做全量 Workbench Vitest、全量 `assist` 集成、并发/冷缓存/网络故障性能压测**；这些不因定向通过而升级为全量验收。

## 8. 结论边界

本轮功能交付与真实证据覆盖显式/开关隔离、自动压缩屏障、真实子进程崩溃恢复、消息级捕获状态、Skill 事件持久化/展示、记忆页异步刷新和 OpenRouter 资格修复。仍按上述未验证项保留 **PARTIAL / B+** 边界；不把编译、fixture、截图或定向用例替代全量验收。完整证据、文件清单与完成度评级见 [最终报告](../../tmp/MEMORY-V2-20261115/C-final-acceptance-report.md)。
