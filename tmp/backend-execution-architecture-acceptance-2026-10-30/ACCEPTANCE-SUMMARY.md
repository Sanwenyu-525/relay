# 后端执行链整改独立验收 — 证据汇总（2026-10-30/31）

工作区：Relay-Agent（D:/Develop/Relay-Agent）。执行者：本轮 Codex/ZCode 会话（实施者自检）。
所有命令在本工作树（含并行会话未提交改动）上真实运行；每条命令与退出码逐条留档如下。

## 1. 实际修改文件（本轮执行链整改，全部最小改动）

| 文件 | 改动 |
|---|---|
| `apps/api/src/application/session-todo-tool.ts` | 抽取 `todoSettlementDigest`（正常结算与恢复同摘要）；新增 `reconcileTodoWriteSettlements`（事件已提交→原身份幂等重放+补结算；事件不存在→保持 REQUESTED；异载荷不吞掉） |
| `apps/api/src/application/assist-runner.ts` | 生成 tick 挂接恢复（租约清扫与委派核对之后）；机器候选登记失败写 `CONVERSATION_EXECUTION_REGISTRATION_FAILED` 活动审计（AI 主体、error_name、借用能力） |
| `apps/api/src/assist/session-tool-call-repository.ts` | 新增 `listPendingTodoWrites(limit)` 有界恢复扫描 |
| `apps/api/src/assist/session-todo-repository.ts` | 0150 前历史事件（`request_digest IS NULL`）重放改 `(content, status)` 序列比较（`legacyPayloadMatches`）；新增 `hasCommittedEvent` |
| `apps/api/src/application/conversation-execution.ts` | `MachineAttribution` 带回授权来源 `connectionId`；`CONVERSATION_EXECUTION_REQUESTED` 事件记录 `machine_capability`/`machine_connection_id`/`machine_attribution_borrowed` |
| `apps/desktop/scripts/stage-api.ps1` | 构建前采集源码指纹（不再事后补写掩盖构建期漂移）；构建产物先部署到 `api.staging-*` 再目录交换替换；部署/交换失败保留最后可用版本；staging/previous 残留清扫 |
| 测试 | `session-todos.integration.test.ts` +TL-28/29/30；`migration.integration.test.ts` +0149/0150 升级用例；`conversation-machine-plugin.integration.test.ts` +自有/跨项目借用审计两用例 |
| 文档 | `docs/decisions/ADR-038-session-todo-list.md`（第三轮第 3/4 点按修正后实现更新）；`docs/database/physical-design-postgresql/part-05.md`（§0149/§0150）；`docs/testing/overall-acceptance-2026-09-28.md`（本轮行）；`CODEX_NEXT_STEP.md`（本轮行） |

未触碰：并行会话的 0151 工作作用域实现、workbench 视图文件、模型错误分类（核查确认已由并行改动实现且带单测）。

## 2. 命令与退出码

| # | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | `tsc --noEmit -p tsconfig.json`（apps/api，含 test） | 0 | typecheck-api.log |
| 2 | `tsc --noEmit -p tsconfig.json`（apps/workbench） | 0 | typecheck-workbench.log |
| 3 | `node --test dist/test/unit/**/*.test.js`（全量，无 helper 环境） | 1 | 1039/1052；13 失败逐条归因见 §3 |
| 4 | 同上 + `RELAY_FILE_IO_HELPER`/`RELAY_CREDENTIAL_HELPER` 定向复跑 managed-content-store/content-freeze/restore-isolation | 1 | 21/23；剩余 2 条 restore-isolation 30s 超时抖动（worker/supervisor/desktop-supervisor 同族通过；本轮未触碰该代码路径） |
| 5 | `run-integration.ps1 -TestFile session-todos,session-todo-tool-loop,migration,conversation-machine-plugin,agent-main-loop-execution,conversation-execution-autostart` | 1 | 仅 TL-07（API 冷启动抖动，同文件次轮通过）与 0150 用例断言类型（bigint vs 字符串，已修）失败 |
| 6 | `run-integration.ps1 -TestFile migration`（修复后复跑） | 0 | **14/14**（含 0149/0150 两条升级用例） |
| 7 | `run-integration.ps1 -TestFile conversation-machine-plugin,session-todos`（终跑） | 0 | machine-plugin **9/9**、session-todos **28/28** |
| 8 | `stage-api.ps1 -RepoRoot D:\Develop\Relay-Agent -Force` | 0 | 真实构建+安全替换，指纹 3874dee74b51，无 staging/previous 残留 |
| 9 | `staged-api-acceptance.ps1`（一次性 PG 集群 + 暂存 CLI migrate/install-graph + 暂存 main.js 起服 + HTTP + 重启） | 0 | 9/9 全过，见 §4 |
| 10 | `node scripts/check-docs.mjs` | 1 | 25 处历史遗留缺失链接（与 2026-10-29 既有基线一致），本轮新增/修改文件 0 处 |

## 3. 验收项覆盖

1. **架构不变量与迁移兼容性**：migration 14/14（含 0149 LEGACY_UNCLASSIFIED 回填+CHECK+原入口失败关闭、0150 scope_seq 回填）。
2. **API typecheck/build/unit**：双包 tsc exit 0；单测 1039/1052（失败全部归因，8 条为缺原生 helper 既有模式）。
3. **真实 PG integration（升级+恢复）**：每文件独占库；session-todos 28/28 含 TL-28（历史事件重放）、TL-29/30（账本恢复+可诊断边界）、TL-40（并行会话的真实 tick 故障注入，验证本 reconcile）。
4. **机器能力四种组合与跨项目边界**：conversation-machine-plugin 9/9——电脑/浏览器借用链路、文件候选不借用、无连接、连接缺资源、类型化拒绝、自有项目连接（不记借用）与跨项目借用（审计 connectionId+borrowed）。
5. **会话/执行候选/Task-Run 链路**：agent-main-loop-execution（AM-05/06 候选落库→Task→READY→Delegate→Run、冲突与接续）、conversation-execution-autostart、session-todo-tool-loop（TL-20/21 全链路+TL-40）全部通过（批量 1 无失败记录，退出门核对）。
6. **todo_write 崩溃恢复/并发/历史重放/作用域**：TL-02/04/09/10/12/21/23/24/25/28/29/30/31..35/40 覆盖。
7. **桌面 API 构建、暂存、重启与 /todos 真实 HTTP**：§4。
8. **Windows 真实记事本打开**：**未做**——需电脑操控运行时与桌面单实例锁（并行实机工作占用），强行执行会互相干扰。

## 4. 暂存 API 实测断言（desktop/staged-api-acceptance.json）

- 暂存产物存在；`.build-info.json` sourceHash=3874dee74b51（构建前指纹）；无 `api.staging-*`/`api.previous-*` 残留。
- 暂存 CLI `migrate.js` exit 0、`install-graph.js` exit 0。
- 暂存 `main.js` 在一次性 PG 18.6 集群上起服，`GET /health/live` 200。
- `GET /api/v1/workspaces/:ws/assist-sessions/:id/todos`（未知会话）→ 404 `application/problem+json`、`code=RESOURCE_NOT_FOUND`。
- 未知路由 → 同形 problem+json 404（实测确认全局 notFoundHandler 自初始提交就整形**所有** 404；「裸 404」只可能来自代理层——工作台区分两者依据对照探测，而非响应码本身）。
- 进程 kill 后重启：liveness 200，todos 路由同一语义复现。

## 5. 架构决策与原因（简）

- **恢复入口放在生成 tick**（`failExpiredLeases` + `reconcileDelegationAttempts` 之后）：与 0128 委派核对同一形态，租约清扫先确认原生成已死，再按原调用身份补结算；有界扫描（200/次）防毒行拖垮 tick。
- **恢复只核对不重做**：事件表是「写入已提交」的唯一事实；查无事件时重新执行写入等于替一条已失败的生成伪造进度。
- **legacy 重放按 `(content, status)` 比较**：条目 id 是服务端为前端稳定 key 维护的内部身份，不是请求语义；0150 之前的事件没有摘要，重放不得因新增列误判同载荷为异载荷。
- **stage-api 构建前指纹**：构建后指纹会把「构建期间源码变化」写成一致并掩盖漂移；构建前指纹 + 下次启动 staleness 判定自愈且诚实。
- **目录交换替换**：删除-再部署在部署中断窗口里让本机没有任何可启动 API；交换失败即回滚原版本。

## 6. 剩余风险

- 验收 8（真实记事本）与 Tauri 真窗口交互未验；真实 Provider、安装态未验。
- restore-isolation 2 条 30s 超时抖动未归因到根因（高负载复现，历史上有同族记录）。
- 全量集成（70+ 套件）未逐套件重跑；按变更影响选了 6 个直接受影响套件 + 终跑 2 个。
- reconcile 的 W1 悬挂行（事件不存在的 REQUESTED）永久保留为可诊断状态，不自动 ABANDONED——工具轨迹投影的呈现收口留给独立验收。
- `check-docs` 25 处历史链接缺失维持既有基线，未以删检查换取通过。
