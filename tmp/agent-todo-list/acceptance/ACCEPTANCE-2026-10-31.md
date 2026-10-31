# 会话待办清单第四/五轮收口验收记录（2026-10-31）

任务来源：C2C「Relay-Agent Todo List 第四轮收口」——P1-A 工作轮次身份、P1-B 故障恢复、P1-C Chromium 验收。
执行者：ZCode 会话（实施者自检，非独立验收）。未 commit / push / 部署。

## 结论

- **P1-A 工作身份：已实现并验证。** 归属在首次判定时冻结持久化（迁移 0151 新表
  `assist_session_todo_turn_scopes`），修复两个现算口径的真实缺陷（插话静默切换作用域、
  恢复重算误判）。集成 TL-31..35 全绿。
- **P1-B 故障恢复：已核查并补充真实 tick 故障注入。** 生产恢复入口
  `reconcileTodoWriteSettlements` 由并行会话同日实现（四轮「执行链整改」），本轮审计其
  语义（W2 幂等重放 / W1 保持 REQUESTED / 异载荷不吞掉）并补 TL-40：真实
  `runAssistGenerationTick` 内完成补结算，不重写快照、不错误报告成功、不丢失原调用身份。
- **P1-C Chromium：4/4 通过**（含新增「迟到响应」用例）。`relay-connection-open` 缺失的
  真实原因是**跨项目端口冲突**（见下），与产品代码无关。

## P1-C 根因：relay-connection-open 缺失

- 现象：三例全部在 `getByTestId("relay-connection-open")` 超时；页面快照整页仅
  `generic: not found`。
- 排查：4173 端口由 PID 81472 监听，命令行 `node scripts/serve-preview.mjs`，父进程为
  **D:/Develop/task_dock**（另一项目的 Qoder 会话）的预览服务；对任意路径返回 404。
  Playwright `reuseExistingServer: true` 静默复用它，应用根本没渲染。
- 处置：不杀他人进程；`playwright.config.ts` 与 `sessionTodoList.spec.ts` 的 CORS origin
  改为可用 `RELAY_E2E_PORT` 覆盖（默认 4173，既有惯例同 `RELAY_RAIL_TEST_PORT`）。本轮以
  `RELAY_E2E_PORT=4317` 运行。其余 browser spec 仍写死 4173，下次运行如再遇占用需同样处理（未批量改动）。
- 附带：dev server 冷启动首屏编译可超默认 30s 用例预算，`sessionTodoList.spec.ts` 顶部
  `test.setTimeout(90_000)` 只覆盖编译等待（不遮蔽产品断言）。

## 原始命令与退出码

| # | 命令（cwd） | 结果 |
|---|---|---|
| 1 | `npx playwright test tests/browser/sessionTodoList.spec.ts`（4173 被占用） | 3 failed（relay-connection-open 缺失 → 根因如上） |
| 2 | `RELAY_E2E_PORT=4317 npx playwright test tests/browser/sessionTodoList.spec.ts` | 3 passed / 1 failed（首例 goto 30s 冷编译超时） |
| 3 | 同上（`test.setTimeout(90_000)` 后） | **4 passed (1.0m)** |
| 4 | 同上（类型修正后复跑） | **4 passed (1.3m)**：折叠/展开、长清单+短窗口+输入器位置、空快照清理、迟到响应 |
| 5 | `powershell -File apps/api/scripts/run-integration.ps1 -TestFile session-todos,session-todo-tool-loop`（首次） | FAILED——TL-31 我方断言口径错误（清单已收尾后读口按完成态解析新作用域），改用进行中场景 |
| 6 | 同上（修正后） | **PASSED**：`session-todos` 28/28、`session-todo-tool-loop` 3/3，tests exit 0，build exit 0 |
| 7 | `run-integration.ps1 -TestFile migration`（首次） | 13/14——0150 用例 `7n !== '7'` 为**陈旧 dist**（并行会话在构建后 2 分钟修了 String 包装），非真实缺陷 |
| 8 | 同上（新构建复跑） | **14/14 PASSED**（含 0150、0151 应用与镜像核对） |
| 9 | `node --test dist/test/unit/session-todos.test.js` | **9/9**，exit 0 |
| 10 | `npx vitest run tests/sessionTodoList.spec.tsx`（workbench） | **10/10**（首次一次瞬时错误，复跑干净） |
| 11 | `npx tsc --noEmit`（workbench） | exit 0（首轮有我方 4 处新用例类型错误，已修：未用变量、Promise 类型、`toHaveAttribute` 消息串改挂 `expect(locator, msg)`） |
| 12 | `npm run build`（workbench，tsc && vite build） | **BUILD_EXIT=0**（日志 `workbench-build.log`） |
| 13 | `npx tsc --noEmit`（apps/api） | exit 0 |
| 14 | `node scripts/check-docs.mjs`（仓库根） | exit 1——25 条断链全部位于本轮未触碰的历史文档（m02-react-migration、前端预览实施与验收、agent-ui-review-2026-10-01、acceptance-details/part-08、frontend-backend-acceptance-2026-09-21、m03-independent-acceptance，均指向已删除的 `output/acceptance-raw`/`artifacts` 存量路径）；本轮修改的三个文档（ADR-038、overall-acceptance、CODEX_NEXT_STEP）零新增断链，`check-docs.log` 已归档 |

日志归档：`api-migration-integration.log`（首轮）、`api-migration-integration-rerun.log`（14/14）、
`workbench-build.log`。截图：`01-todo-collapsed / 02-todo-expanded / 03-todo-long-short-window /
04-todo-cleared-new-turn / 05-todo-late-response.png`（同目录，源 `apps/workbench/results/session-todo-list/`）。
注：`tmp/` 不在 .gitignore，本目录为任务指定产物位，保持未跟踪。

## 本轮改动清单

后端（apps/api）：
- 新增迁移 `0151_assist_session_todo_turn_scopes.sql`：归属表（session×用户消息 → scope_key+basis，
  basis ∈ OPENED/CONTINUED_UNFINISHED/FORCED_NEW_PREFIX），历史回填仅补可从 scope_key 还原的开启轮次。
- `session-todo-repository.ts`：`resolveScopeKey()` 重写为「读冻结归属 → 未判定才 `attributeTurn()` 计算并冻结
  （`on conflict do nothing` + 回读）」；延续/前缀规则与第三轮一致，仅结果持久化。事件、快照、CAS、scope_seq 未动。
- 测试：`session-todos.integration.test.ts` 追加 TL-31..35；`session-todo-tool-loop.integration.test.ts`
  追加 TL-40（真实 tick 故障注入）；`migration.integration.test.ts` 镜像补 0150（并行会话漏登记）与 0151。

前端（apps/workbench）：
- `playwright.config.ts`：端口 `RELAY_E2E_PORT` 参数化（默认 4173 不变）。
- `tests/browser/sessionTodoList.spec.ts`：origin 随端口；冷启动预算 90s；新增「迟到响应」用例
  （RUNNING 夹具驱动轮询，第一次响应故意迟到，断言不回退版本、不替换条目）。

## 并行会话工作（本轮未重做、未覆盖）

- `reconcileTodoWriteSettlements` + `listPendingTodoWrites` + `hasCommittedEvent` + `legacyPayloadMatches`
  及 TL-28/29/30：同日并行会话「执行链整改」产出，本轮在其上加 TL-40 并复跑确认全绿。
- 迁移 0148/0149/0150、场景实验室等在途改动一律未触碰；`migration.integration.test.ts` 仅追加两行镜像登记。

## 审计发现与边界

1. **W1（事件未提交）行永久 REQUESTED**：并行会话的有意设计（「不重新执行、保持可诊断」）。
   代价：终态消息的悬挂行在工具轨迹投影里永远显示进行中，且每 tick 重扫（有界 200）。是否需要
   ABANDONED 收口留给独立验收裁决，本轮不代改。
2. reconcile 不按消息状态过滤（含 RUNNING 消息的行）：依赖幂等与 CAS 收敛，并发下安全但偶有重复核对。
3. 归属冻结以「首次观察」为准：插话轮次的归属取决于它被首次读/写解析的时点（TL-31 证明了
   进行中插话延续、收尾后观察开新作用域两个分支）。这是设计语义，不是缺陷。
4. 全量单测/集成、真实 Provider、Windows/WebView2、安装态未验（沿未闭合边界记录）。
