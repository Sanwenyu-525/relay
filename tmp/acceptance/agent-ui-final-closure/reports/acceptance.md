# 基础 Agent 与 AI 回复 UI · 最终独立验收收口报告

- 日期：2026-10-31
- 执行者：ZCode（独立验收轮，非实施自检）
- 仓库：`D:/Develop/Relay-Agent`，HEAD `4cc630da376140691e05cdf25db9dabbb5665c4f`（main，验收开始与结束时同一 commit）
- 证据根目录：`tmp/acceptance/agent-ui-final-closure/`

---

## 1. 最终结论：**PASS**

本轮「基础 Agent 与 AI 回复 UI」专项收口可以正式结束。三项整改全部完成并有新鲜的真实执行证据；场景实验室 145/145 通过（0 FAIL / 0 NOT_COVERED / 0 NOT_RUN），G05、X03、A03 保持通过且判定来自当前代码；未提交工作树的内容变化可被证据指纹识别，测试期间源码漂移会产生 STALE 而不是虚假 PASS；新会话来源身份的六类负向边界补齐并全绿。

**边界声明**：本 PASS 只覆盖本轮专项收口。真实 Provider 语义质量、Windows/WebView2 实机、安装交付及并行会话在途的其他模块不在其内。全仓仍有大量并行会话的未提交改动，本报告只声明本轮涉及的 8 个文件（§4）。

### 严格完成条件核对（任务书 §8）

| # | 条件 | 结果 | 证据 |
|---|---|---|---|
| 1 | 最新 Playwright 真实执行，原始日志与当前测试代码一致 | ✅ run3：18/18、PW_EXIT=0，用例名与行号即当前文件（G05 用例名「不得推移正在读的轨迹行」@495:3） | `logs/playwright-run-20261031-run3.log` |
| 2 | 场景实验室 145/145，0 FAIL / 0 NOT_COVERED / 0 NOT_RUN | ✅ | `results-scenario-lab/browser-verdicts.json`、`summary.json` |
| 3 | G05 / X03 / A03 保持通过 | ✅ G05 判定 PASS（锚点位移 0px，19px 为滚动补偿量）、X03 pass、A03 pass（6 帧） | `results-scenario-lab/scenario-lab-acceptance.md`「实测发现」 |
| 4 | 未提交工作树源码内容变化可被证据机制识别 | ✅ 内容指纹（221 个关键文件逐个 SHA-256）；反例①–⑤ 9/9 通过；start→end 快照实际抓到唯一内容差异 | `evidence/source-snapshot.json`、`logs/digest-test-run3.log` |
| 5 | 测试期间源码漂移不产生虚假 PASS | ✅ 两个 spec 批次前后各取一次逐文件指纹，漂移先落盘标 STALE 再红；报告侧拒绝任何 STALE/指纹冲突 | `assistScenarioLab.spec.ts` / `assistScenarioLabShots.spec.ts` 本轮新增断言 |
| 6 | 无来源 / 重复新建 / 非法来源 / 跨 Workspace 反例通过 | ✅ 前端 7/7（场景 A/B/C/D-1/D-2/D-3/F）；API 集成 SB-09/SB-10 新增通过，SB-02 既有跨 Workspace 用例通过 | `logs/budget-negative-run*.log`、`logs/session-context-budget-integration-run2.log` |
| 7 | 类型检查、构建、组件测试、生产隔离通过 | ✅ typecheck 0、build 0、组件电池 215/215、隔离退出 0（开发 10 处命中/生产 0 处） | `logs/workbench-typecheck.log` 等 |
| 8 | 无新增 P0/P1 问题 | ✅ 本轮发现并修复的 2 个缺陷均为来源身份的边界加固（P2 级），修复带失败反例 | §2 整改二 |
| 9 | 原始证据完整存放指定 tmp 子目录 | ✅ 本目录（logs / evidence / results-scenario-lab / reports） | — |

---

## 2. 三项整改结果

### 整改一（P1）：最新 Playwright 原始执行证据

- **原问题**：`apps/workbench/results/scenario-lab/playwright-run.log`（10-30 15:36）仍是旧版 G05 用例名（「状态行换措辞造成的位置推移（实测记录，不算通过）」），与当前测试代码不对应，不能作为 145/145 的执行证明。
- **实际处理**：在冻结源码后完整重跑两个 spec（run3）；输出经 `RELAY_SCENARIO_LAB_RESULTS_DIR` 挪到本证据区（`apps/workbench/results/scenario-lab/` 历史证据原样未动）。run1 因 dev server 连接复用抖动在 F06 导航 30s 超时（spec 注释已记录的已知环境问题，非产品缺陷），run2 全过后证据模块又清理了两个未用参数，为使「记录指纹 = 实际运行内容」严格成立而重跑 run3——run1/run2 日志全部留档可查，未删改。
- **修改文件**：`apps/workbench/tests/browser/assistScenarioLab.spec.ts`、`assistScenarioLabShots.spec.ts`（证据目录可配置 + 漂移检测，见整改二）。
- **执行事实**：命令 `RELAY_E2E_PORT=4176 RELAY_SCENARIO_LAB_RESULTS_DIR=… pnpm exec playwright test tests/browser/assistScenarioLab.spec.ts tests/browser/assistScenarioLabShots.spec.ts --workers=1`；Node v22.22.3 / pnpm 9.15.9；18 passed（5.3m），PW_EXIT=0；记录指纹 `a9c17ad3…`（221 文件）与 `evidence/source-snapshot-end.json` 逐字一致；截图 219 张 = 190 逐帧 + 26 流程帧 + 3 外壳；控制台错误 0；stale=false。
- **证据位置**：`logs/playwright-run-20261031{-run2,-run3}.log`、`results-scenario-lab/`（browser-verdicts.json / shots-meta.json / summary.json / scenario-lab-acceptance.md / screenshots/）。

### 整改二（P2）：源码证据指纹增强

- **原问题**：`workspaceDigest` 只对 `git status --porcelain` 文本做哈希——同一文件连续修改两次，路径列表相同、摘要不变，未提交内容变化无法被证明。
- **实际处理**（最小增强，未新增依赖）：
  1. `scenarioLabEvidence.ts` 新增**关键输入内容指纹**：关键输入 = 从 `ScenarioLabView`/`scenarioHost` 出发的相对导入闭包（覆盖实验室真正挂载的全部产品源码，含 AssistView 传递引入的 SessionRoundTrace 等）+ 验收代码 + 构建/隔离配置，共 221 个文件；逐文件按**盘上字节** SHA-256，排序后折叠成整体摘要。已暂存、未暂存、未跟踪一视同仁（跑的就是盘上这份）；路径统一 `/` 分隔，跨平台稳定。
  2. `GitEvidence`/`sourceEvidence` 增加 `sourceDigest`/`sourceFileCount`，原 `workspaceDigest` 保留（继续证明「当时不干净」）。
  3. 批量判定与截图批次**运行前后各取一次逐文件指纹**：漂移先把 `stale: true` + `driftFiles` 写进判定/元数据文件再断言失败——证据留盘、用例红；报告侧新增指纹三处一致性核对（判定 vs 截图 vs 当前盘上源码）并拒绝任何 STALE 记录进入 PASS 报告。
  4. 报告正文新增「源码内容指纹」行。
- **反例测试**（`tests/scenarioLabEvidenceDigest.spec.ts`，9/9 通过）：①相同 git 状态路径列表、内容改变→摘要必变（真 git 仓库夹具，含「旧式路径列表摘要不变」的盲区演示）；②已暂存与未跟踪内容都进摘要；③运行期间改动→逐文件漂移被抓出；④无关文件不影响关键输入摘要（真实仓库钉住：CollaborationView 与 apps/api 不在闭包内）；⑤文件缺失/损坏→拒绝出指纹；真实仓库确定性、清单覆盖面与闭包追法（目录索引/副作用 css/裸模块名不追）。
- **测试结果**：9/9（`logs/digest-test-run3.log`）；start→end 快照实测抓到的唯一差异恰为证据模块自身。
- **证据位置**：`evidence/source-snapshot{,-start,-end}.json`、`evidence/source-file-digests-{start,end}.json`、`evidence/build-source-snapshot.mts`。

### 整改三（P2）：上下文档位继承负向回归

- **原问题**：新会话档位继承缺少「重复新建、空/非法来源、跨 Workspace、响应丢失重试」的直接反例。
- **实际处理**：先写失败反例（TDD），据此实施两处**最小修复**，随后全绿：
  - **修复①** `AppShell.tsx`：来源守卫由 `=== null` 改为「非空字符串」判定——场景 C 实测未定义身份会把字面 `source_session=undefined` 写进 URL（先红），修复后不出现。
  - **修复②** `AssistView.tsx`：URL 深链 `source_session` 就地净化——字面 `"null"`/`"undefined"`/空串当作没有来源（场景 D-2 实测创建命令先收到字符串 `"null"`，修复后不收）。合法畸形 UUID（`not-a-uuid`）仍**原样上交**、由服务端契约拒绝，界面不替服务端改写或静默丢弃（场景 D-1 钉住这份诚实）。
  - 场景 A/B/D-3/F 为纯新增测试（无源码修改）：无当前会话按默认 256K 建；空白页重复新建不带来源也不继承已离开的 512K；来源不存在按契约回退默认档；创建响应丢失后按原命令重试——command_id/来源/显式 1024K 档全部冻结、载荷逐字相同、服务端幂等回放不建第二条，且在途未决时切到别的会话不换冻结来源。
- **反例测试**：前端 `tests/contextBudgetSourceEdgeCases.spec.tsx` 7/7（`logs/budget-negative-run1.log` 修复前 4 红 → `run3.log` 7 绿）；API 集成新增 SB-09（来源不存在/被删除/空串→默认档）与 SB-10（HTTP 面字面 "null"/"not-a-uuid" 被 422 拒绝；合法无此行来源按默认档建出），SB-02 既有跨 Workspace 用例通过（场景 E 的服务端事实）。
- **证据位置**：`logs/budget-negative-run{1,2,3}.log`、`logs/budget-regression.log`、`logs/session-context-budget-integration{,-run2}.log`。

---

## 3. 验收统计

| 类别 | 结果 | 说明 |
|---|---|---|
| 浏览器测试（Playwright，真实 Chromium） | **PASS** | run3：18/18 用例、145/145 场景判定、190/190 声明帧截图、154 条浏览器侧检查、控制台错误 0 |
| 组件测试（Vitest/jsdom） | **PASS** | 电池 7 文件 215/215：scenarioLabMatrix、sessionRoundTrace、activityPresentation、contextBudgetInheritance、contextBudgetP0Boundaries、scenarioLabEvidenceDigest、contextBudgetSourceEdgeCases；另档位族回归 26/26 |
| 类型检查 | **PASS** | apps/workbench `tsc --noEmit` 退出 0；apps/api 退出 0 |
| 构建 | **PASS** | workbench `vite build`（含 tsc）退出 0 |
| 生产隔离 | **PASS** | `check-scenario-lab-isolation.mjs` 退出 0：开发构建 10 处命中、生产构建 0 处 |
| PostgreSQL 集成 | **PARTIAL** | session-context-budget 套件 10 条：7 过（含本轮新增 SB-09/SB-10）；SB-04/06/08 三条**存量红**（见 §5，非本轮引入） |
| Windows / WebView2 实机 | **NOT_RUN** | 本轮任务书范围外；此前记录的实机出口（accept-scenario-lab-tauri 7/7）属于上一轮证据，本轮不沿用 |
| 真实 Provider | **NOT_RUN** | 实验室为受控回放，本就不触 Provider；未做真实模型演示 |

---

## 4. Git 与代码一致性

- **HEAD**：开始 `4cc630da` → 结束 `4cc630da`（无变化；未执行 reset/stash/commit/push）。
- **源码内容指纹**：start `c3ff9c10…`（run1/run2 记录值）→ end `a9c17ad3…`（run3 记录值 = 最终盘上状态，两者逐字一致）。差异仅 1 个文件：`apps/workbench/tests/browser/scenarioLabEvidence.ts`（证据模块自身清理未用参数，非行为变更），据此以 run3 为最终证据轮。
- **执行期间源码变化**：关键输入在 run1/run2/run3 任一批次前后均无漂移（三次 `stale=false`、`driftFiles=[]`）；并行会话在仓库其他文件的改动（未提交路径数 61→64）不属实验室闭包，按设计不使本轮证据失效。
- **本轮实际修改的 8 个文件**（其余 60+ 个未提交路径均为并行会话所有，未触碰）：
  - `apps/workbench/tests/browser/scenarioLabEvidence.ts`（上轮新建的未跟踪文件，本轮增强：内容指纹/漂移/闭包）
  - `apps/workbench/tests/browser/assistScenarioLab.spec.ts`、`assistScenarioLabShots.spec.ts`（目录可配置 + 前后指纹 + STALE + 报告核对）
  - `apps/workbench/src/components/AppShell.tsx`（newConversationHref 来源守卫；该文件原有并行改动，本轮只动这一段）
  - `apps/workbench/src/views/AssistView.tsx`（urlSourceSessionId 净化；同上，只动这一段）
  - `apps/workbench/tests/scenarioLabEvidenceDigest.spec.tsx`（新增 9 例）
  - `apps/workbench/tests/contextBudgetSourceEdgeCases.spec.tsx`（新增 7 例）
  - `apps/api/test/integration/session-context-budget.integration.test.ts`（新增 SB-09/SB-10）
- **其他任务未提交文件是否受影响**：否。全程未使用 checkout/stash/reset/clean；未覆盖、未回退任何他人改动。

## 5. 剩余问题（仅真实未解决项）

1. **session-context-budget 套件的 SB-04/06/08 三条存量红**：`MODEL_BUDGET_EXHAUSTED`，落点在并行会话未提交的执行链改动区（`assist-runner.ts` +116 行等，与本轮 0 相交）；两次独立复跑结果相同（确定性），按任务书规则标 INCONCLUSIVE 不予修复。需该改动区的 Owner 收口。
2. **run1 的 F06 整页导航 30s 超时**：dev server 连接复用抖动（spec 注释已记录的已知环境问题），重跑即过；高频并行负载下偶发，不阻断验收。
3. **NOT_RUN 项**：Windows/WebView2 实机、真实 Provider（见 §3），继续按各自任务书另行验收。
4. 本轮全部改动**未 commit/push**；CODEX_NEXT_STEP 与功能验收表未登记本轮结果（并行会话共写该文件，登记时机留给协调者）。

## 6. 证据索引

```
tmp/acceptance/agent-ui-final-closure/
├─ reports/acceptance.md                        ← 本报告
├─ evidence/
│  ├─ source-snapshot.json                      ← 双相位指纹 + 221 文件清单（任务书要求件）
│  ├─ source-snapshot-{start,end}.json          ← 双相位完整快照
│  ├─ source-file-digests-{start,end}.json      ← 逐文件摘要（漂移归因依据）
│  ├─ test-results.json                         ← Playwright 用例明细 + 判定/截图元数据（任务书要求件）
│  ├─ isolation.json                            ← 生产隔离证据副本
│  ├─ build-source-snapshot.mts / vitest.snapshot.config.mts / build-test-results.mjs
├─ logs/                                        ← 全部原始命令输出（含退出码、环境、三次 Playwright 轮次）
└─ results-scenario-lab/                        ← 本轮实验室证据区（RELAY_SCENARIO_LAB_RESULTS_DIR 指向）
   ├─ browser-verdicts.json / shots-meta.json / summary.json / scenario-lab-acceptance.md
   ├─ screenshots/（219 张 PNG + JSON 登记，逐张 SHA-256 可核对）
   └─ stream-frames.json / scroll-stability.json / panel-shift.json / screenshots-{last-frame,flows}.json
```

历史证据 `apps/workbench/results/scenario-lab/`（10-30 轮）原样未动。
