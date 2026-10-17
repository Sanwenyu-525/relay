# 三个子智能体并行派发记录（2026-10-17）

角色：本轮从 opencode 接手的三个未完成任务的**派发任务书原文**存档。进度与成绩不在这里维护：阶段归 [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)，真实验收结果只归[功能验收表](../docs/testing/overall-acceptance-2026-09-28.md)。

背景：opencode 因免费模型配额 429 中断了三个会话，用户要求「都在你这里继续」。主 Agent 接手后先完成 CT-01 的根因修复与几何断言复跑（9/9），再把剩下三块边界清晰、文件不相交的工作派给三个子智能体并行执行。三份任务书都包含同一套共享工作树约束（禁改清单、最小改动、不新增 token、只用 fixture/伪造 API 验证、如实分层报告）。

| 子智能体 | 承接的原任务 | 范围 | 主要文件 |
|---|---|---|---|
| `ct02-inspector` | 点击穿透 UI 优化 CT-02 | 资料面板职责分离、限高内部滚动、四态保留、勾选不触发执行 | `AssistSourcePicker.tsx`、`migrated-scoped.css`、新增 `tests/browser/composerSourcePanel.spec.ts`、工作台 §32.7 |
| `t2-acceptance` | 模型选择弹窗显示优化 | 真实浏览器验收复跑（FreeModels）＋残留文档口径 | `scripts/run-real-api-browser.ps1`、`ModelSelector.tsx`、工作台 §17.6／契约 §10.30／p00 §1.1 |
| `t3-w3-ui` | conversation-live-diff W3 | 两个 UI 位置（局部逐文件增删行＋输入卡外居中总 diff） | `AssistView.tsx/.css`、`relayClient.ts`（补 `getRunToolCallPreviews`）、新增组件与 spec |

分工裁决：`AssistView.tsx` 与 `AssistView.css` 这一轮唯一写入者给 `t3-w3-ui`；因此 CT-02 与模型选择器两处「必须动 AssistView 才能闭合」的剩余项收回主 Agent，等 W3 交回后再做，见[派下发清单](#派发-3-剩余待办由主-agent-承接)。

---

## 派发 1：CT-02 详情面板整改（`ct02-inspector`）

```text
你在 Relay-Agent 仓库（D:/Develop/Relay-Agent）里继续一个被中断的前端专项。用户已授权在本机直接改代码并跑测试。全程中文汇报，代码标识符和 commit message 用英文，不要 commit/push。

## 背景
有一份「点击穿透 / 详情面板 UI 优化」任务书：`D:/Develop/Relay-Agent/prompts/click-through-ui-optimization.md`，含 CT-01…CT-06 若干条款。CT-01（抽屉遮罩把面板自己的 tab 与关闭键全部盖住，导致 7 条 Playwright 几何断言失败）已经由我修完并验证：
- 根因修复在 `apps/workbench/src/views/CollaborationView.css`（约 446–472 行那一档 `@container collaboration (max-width: calc(26rem + 0.5rem + 30rem))`）：遮罩改成只在真的存在预览抽屉时才铺上——`.collab-columns:has(> .task-inspector--preview) .collab-inspector-scrim { display: block; }`，因为这一档（52–56.5rem）只把深预览收成抽屉，工作详情仍是常驻分栏。
- 出口测试 `apps/workbench/tests/browser/inspectorPreviewLayout.spec.ts` 现在 9/9 通过（命令：`cd /d/Develop/Relay-Agent/apps/workbench && npx playwright test inspectorPreviewLayout --reporter=line --timeout=60000`，复用已在监听 127.0.0.1:4173 的 vite dev）。

**你的范围是 CT-02（以及任务书里明确属于 CT-02 的条款），不要重做 CT-01，也不要为了让 CT-01 用例变绿而改上面那条遮罩规则或那几个几何断言。** 先读任务书原文确认 CT-02 的确切条款，再动手。已知 CT-02 大致涉及：工作详情面板里「资料」与「生成方式/意图」两类信息职责分离；面板限高并在内部滚动；空态/无结果/读取失败/重试四类状态保留；本地文件类条目在不满足条件时如实禁用而不是假装可用；勾选资料不得触发执行或模型调用。以任务书为准，我这段转述不作为规格。

## 相关文件（起点，不是全集，请自己核对当前源码）
- `apps/workbench/src/views/CollaborationView.tsx`（`task-inspector`、`collab-inspector-scrim`、`collab-conversation-inspector-toggle/close` 等 testid 在这里）
- `apps/workbench/src/views/CollaborationView.css`
- `apps/workbench/src/styles.css`（全局与弹窗样式，约 3500+ 行，没有 src/styles/ 目录）
- 承载详情面板内容的组件需要你从 CollaborationView 的 import 顺藤摸瓜找（TaskInspectorPanel 之类，`.inspector-*` 类族）
- 测试入口：`apps/workbench/tests/`（vitest + jsdom，用假 client 挂载组件）与 `apps/workbench/tests/browser/`（Playwright + `page.route("http://127.0.0.1:8787/**")` 伪造 live API）

## 这个仓库的硬性约束（违反会被判为偏离）
1. 工作树被多个 Agent 同时编辑。`AssistView.tsx/.css`、`relayClient.ts`、`dtos/assist.ts`、`parse/assist.ts`、`collaborationWorkspace.spec.ts`、`tests/browser/uiOption2FirstSession.spec.ts` 现在正被别的 Agent 高频改动——**你绝对不要编辑这些文件**；如果 CT-02 必须动到其中之一，停下来在汇报里写清楚「需要改哪里、为什么」，不要直接改。
2. 编辑任何文件前都要重新读它（别人可能刚改过）。改动只做任务所需的最小修改，不顺手重构、不改别人的断言来让红灯消失、不删历史。
3. 视觉数值只能来自既有 token：`--relay-*` 由 `apps/workbench/src/lib/tokens.ts` 读 `docs/frontend/design-tokens.json` 注入，**本轮不许新增 token 数值**。间距/圆角/字号/层级/动效沿用既有档位。UI 业务交互规则归 `docs/frontend/workbench-design.md`，视觉规则归 `docs/frontend/design-system.md`，数值归 `docs/frontend/design-tokens.json`。
4. 验证要求见下节，不能用静态检查冒充真实渲染。

## 环境与验证套路（已实测可用）
- 127.0.0.1:4173 和 5173 上 vite dev 已在跑；8787 上真实 API **没有**在听；本地 PostgreSQL 5432 **没有**在听。所以只能走 fixture/伪造 API 路线，不要尝试起后端或数据库。
- Playwright：`cd /d/Develop/Relay-Agent/apps/workbench && npx playwright test <spec> --reporter=line --timeout=60000`。坑：冷启动第一条常撞 30s 超时，所以要带 `--timeout=60000`；**并发全量跑会产出假红灯**，归因前先单跑那几个 spec；一次性探针文件命名 `zz*.spec.ts` 用完必须删掉。
- 度量坑（前几轮踩出来的，直接沿用）：带 transition 的属性在 `hover()` 后立刻读 `getComputedStyle` 拿到的是过渡首帧，要 `waitForTimeout` ≥ 260ms；`:focus-visible` 不会被 `element.focus()` 触发，需 focus 后按一次 Tab 再 Shift+Tab；伪元素用 `getComputedStyle(el,'::before')` 拿已解析 px；`elementFromPoint` 对超出可视视口的点返回 null，别读成「元素不存在」。
- 类型检查：`cd /d/Develop/Relay-Agent/apps/workbench && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`（注意：`npx tsc` 会解析到一个假包，必须用这个相对路径）。**这个工作树里别人留了 4 个 tsc 错误，我已修完，现在基线是 0 错**；如果你跑出来不是 0，先判断是不是别人在你之后新引入的，不要去改别人的文件。
- 单测：`cd /d/Develop/Relay-Agent/apps/workbench && npx vitest run tests/<file>.spec.tsx`（vitest 5，`--reporter=basic` 不存在，别用）。
- 文档改动后跑 `node scripts/check-docs.mjs`（在仓库根）。

## 交付
1. 实现 CT-02 要求的改动（最小 diff）。
2. 为新增/改变的不变量补上常驻断言（vitest 结构断言为主；涉及真实几何才加 Playwright 断言，并复用 `inspectorPreviewLayout.spec.ts` 里已有的 `measure()` 风格，不要在别人正改动的 spec 里塞）。
3. 实际跑过：相关 vitest 文件、你改动涉及的 Playwright spec、workbench tsc。**如实列出跑过什么、结果如何、哪些没跑以及为什么。**
4. 若 CT-02 影响文档中已写明的交互规则，更新对应那一处主文档并标注「已实现/待真实 Windows 验收」的真实状态；不要新建重复文档，不要往统一功能验收表里写没跑过的成绩（验收表只在 `docs/testing/overall-acceptance-2026-09-28.md` 维护真实结果）。
5. 最后用中文汇报：改了哪些文件（绝对路径＋行号）、CT-02 每条的满足状态（已满足/部分满足/无来源/环境阻塞）、真实跑了哪些检查与结果、剩余限制、以及任何你认为需要我裁决的冲突。汇报控制在 500 字以内，不要贴大段代码。
```

## 派发 2：模型选择真实浏览器验收复跑（`t2-acceptance`）

```text
你在 Relay-Agent 仓库（D:/Develop/Relay-Agent）里收一个被中断的前端专项「模型选择弹窗显示优化」的最后验收环节。用户已授权本机直接改代码并跑测试。全程中文汇报，代码标识符与 commit message 用英文，不要 commit/push。

## 已完成、不要重做的部分
- 模型选择器：触发器显示具体模型名、弹窗清单每项只显名（细节进 `title` 与 `aria-label`）、行 hover/当前选择 Check、高度上限内部滚动。规格已写在 `docs/frontend/design-system.md` 第 9.16 节（约 776 行起）与 `docs/frontend/workbench-design.md` 的 §27.5。
- 单测出口已存在：`apps/workbench/tests/modelSelector.spec.tsx` 七条 + `tests/newConversationEntry.spec.ts` 的首条免费模型用例。
- 用户最后一句指令「显示缓存的那个圆圈左边不要显示缓存未采集」已实现：`apps/workbench/src/views/AssistView.tsx` 里 `ContextMeter` 在 Provider 没上报缓存读数时**整格不渲染**（既不写「缓存未采集」，也不把 null 画成 0%），只保留右侧占用圆环；`apps/workbench/tests/collaborationWorkspace.spec.ts` 两个场景改成断言 `[data-testid="assist-cache-hit"]` 不存在。**这部分不要改回来。**

## 你的两件事
### 1（主要）：真实浏览器验收复跑
唯一入口是 `D:/Develop/Relay-Agent/apps/workbench/scripts/run-real-api-browser.ps1`，参数 `-Scenario FreeModels`（另一个取值是 M02）。它会自建一次性 PostgreSQL 18 集群、一次性 artifact 根、一次性 bearer token，跑完清理，不读 `.env` 也不碰已有数据库。

**已知阻塞（需要你修）**：脚本在 `Set-StrictMode -Version Latest` 下引用了一个从未定义的变量 `$fixturePreloadUrl`（约在 156–165 行，那段是给 Playwright 传 `--import file://` 的修复）。上一次执行因此直接失败，`playwright=` 结果为空。你要：读脚本上下文 + 它实际调用的 spec（`apps/workbench/tests/browser/free-model-real-api.spec.ts` 或 `real-api.spec.ts`，看脚本怎么选），确认这个 preload 到底应该指向哪个文件/URL，把它**定义出来或删掉多余引用**（选真实需要的那一侧），保持两处 `--import` 用法一致。注意仓库记忆里的两个 PowerShell 坑：① PS5.1 会把含中文的 UTF-8 脚本按 GBK 误读，改动尽量别新增中文字面量到会被误读的位置；② 脚本首行 `#` 之前若混入重复 BOM（ef bb bf ×2）会报「意外的属性 param/CmdletBinding」。

前置条件按脚本自身校验：它要求 `apps/api/dist/src/main.js`、`dist/src/cli/migrate.js`、`install-graph.js`、`init-workspace.js` 已构建，以及 `.research/runtime-cache/node-v24.21.0-win-x64/node.exe`、`.research/runtime-cache/postgresql-18.6-2/pgsql/bin/*`、`apps/file-io-helper/target/x86_64-pc-windows-msvc/debug/relay-file-io-helper.exe`。缺哪个就按仓库现有脚本/包命令构建哪个（API 构建用 `apps/api/node_modules/typescript`，`npx tsc` 会解析到假包；`./node_modules/.bin/tsc` 是可靠写法）。**不要为了跑通而削弱脚本里的清理与校验逻辑。**

跑完必须如实分层报告：脚本是否成功、真实 FreeModels 场景在真实 Chromium + 真实 API 下哪些断言过了、哪些没过、以及是否根本没跑到浏览器阶段。跑不过就把准确报错与根因带回来，不要伪造通过，也不要删失败检查后自报通过。

### 2：残留文档口径
现在还有两处文档在描述「缓存未采集」这个已被移除的可见文案，请按当前实现校正，并且只改受影响那一处、不要新建文档：
- `docs/frontend/workbench-design.md` 约 789 行
- `docs/research/p00-source-study.md` 约 107 行
`docs/superpowers/specs/` 下的历史规格属于历史记录，**不要改**。改完在仓库根跑 `node scripts/check-docs.mjs` 并人工核对事实源边界（已实现 / 推荐 / 待验收不要混写）。真实成绩只在 `docs/testing/overall-acceptance-2026-09-28.md` 的统一功能验收表维护——只有你真的跑过的才写，没跑过的写进「限制」。

## 这个仓库的硬性约束
1. 工作树被多个 Agent 同时编辑。**你禁改**：`apps/workbench/src/views/AssistView.tsx`、`src/views/AssistView.css`、`src/views/CollaborationView.tsx/.css`、`src/styles.css`、`src/migrated-scoped.css`、`src/api/relayClient.ts`、`src/api/dtos/assist.ts`、`src/api/parse/assist.ts`、`tests/collaborationWorkspace.spec.ts`、`tests/browser/uiOption2FirstSession.spec.ts`、`tests/browser/inspectorPreviewLayout.spec.ts`、`tests/browser/composerSourcePanel.spec.ts`、`tests/assist-source-picker.spec.ts`、`tests/modelSelector.spec.tsx`、`apps/workbench/scripts/**`、`docs/**`。如果验收必须动其中之一，停下来在汇报里写清楚需要改哪里、为什么，别自己动手。
2. 每次编辑前重新读该文件；只做任务所需的最小修改。
3. 8787 上真实 API 与 5432 上 PostgreSQL 当前都**没有在监听**；127.0.0.1:4173 与 5173 有 vite dev 在跑（有桌面 WebView2 窗口连着 5173，别动那两个端口上的进程）。不要另起一个和脚本抢端口/抢 dist 的第二个 PG 集群——另有一个 Agent 正在做前端 W3，它不会跑真实 API。
4. 不要把 token、密钥、连接串写进任何文档或汇报。

## 交付
中文汇报（600 字以内，不贴大段代码）：脚本改了什么（绝对路径＋行号）、真实跑了哪些命令与逐层结果（构建→PG→API→浏览器→断言）、文档校正了哪两处、`check-docs` 结果、真实 Windows/Provider 仍未验收的部分、以及需要我裁决的问题。
```

## 派发 3：conversation-live-diff W3 两个 UI 位置（`t3-w3-ui`）

```text
你在 Relay-Agent 仓库（D:/Develop/Relay-Agent）里继续一个被中断的专项「conversation-live-diff：会话局部与总 diff」。服务端 W1/W2 与客户端读取层已完成，**你的任务是 W3：把两个 UI 位置接上并自检**。用户已授权本机直接改代码并跑测试。全程中文汇报，代码标识符与 commit message 用英文，不要 commit/push。

## 先读这些权威输入（按顺序，别跳）
1. `D:/Develop/Relay-Agent/AGENTS.md`（已在你上下文里）与任务书 `D:/Develop/Relay-Agent/prompts/conversation-live-diff.md`（重点 §4 的 W3 与 W4 段）。
2. 产品规则唯一来源：`docs/frontend/workbench-design.md` 第 1957 行起 §34「会话局部与总 diff」（§34.1 已确认选择、§34.2 两种比较与文案样例、§34.3 基线与失效、§34.4 预览与刷新、§34.5 边界）。
3. 视觉：`docs/frontend/design-system.md` 第 767 行起 §9.15（局部 diff 与文件名同行、路径可截断但数字不被截断、总 diff 在输入卡外上方居中、一行文字按钮作展开入口不加厚卡片、新增绿/删除红且保留 `+`/`−` 与可访问名、`font-variant-numeric: tabular-nums`、数字直接切换不做补间、reduced-motion、**本轮不新增数值 token**）。
4. 验收规格：`docs/testing/verification-plan.md` 第 1361 行起 §34 的 CD-01…CD-20（你主要对齐 CD-01、CD-11、CD-12、CD-13、CD-17、CD-18、CD-19；CD-02…CD-10、CD-14…CD-16、CD-20 属服务/真实环境，本轮不要求你验，但不要声称它们通过）。

用户已明确选择口径 **B「本轮对话开始以来的净变化」**，禁止换成 HEAD 到工作区、每次工具行数累加或每条消息重置。

## 已经存在的东西（当输入用，不要重造）
服务端（`apps/api`，已编译通过）：
- `src/conversation-diff/`（`net-diff-service.ts`、`diff-engine.ts`、`conversation-diff-repository.ts`、`tool-call-preview.ts`、`tool-call-preview-repository.ts`）
- 端点：`src/api/assist-api.ts` 第 607 行 `GET /assist-sessions/:id/conversation-diff`、第 621 行 `GET .../conversation-diff/file`、第 651 行 `POST .../conversation-diff/baseline`；`src/api/run-api.ts` 第 136 行 `GET /runs/:run_id/tool-call-previews`；`src/api/domain-schemas.ts` 第 706 行有 `file_changes`。
- `src/application/run-tool-call-projection.ts` 第 94 行恒定输出 `file_changes`。

前端读取层（`apps/workbench`）：
- DTO：`src/api/dtos/assist.ts` — `RelayRunToolCall.fileChanges`（**必填数组**，166 行）、`RelayRunToolCallFileChange`(173)、`RelayRunToolCallPreview/PreviewFile/Previews`(197–218)、`RelayConversationDiff`/`RelayConversationDiffFile`/`RelayConversationDiffFileRow`/`RelayConversationFileDiff`/`RelayConversationDiffUnavailableReason`(402–445)。
- 解析：`src/api/parse/assist.ts`（`conversationDiffFrom`、`conversationDiffFileDetailFrom`、`runToolCallPreviewsFrom` 在 619 行）。
- 资源：`src/api/resources/conversationDiff.ts`（`getConversationDiff` / `getConversationDiffFileDetail` / `establishConversationDiffBaseline`），`src/api/resources/run.ts` 第 99 行 `getRunToolCallPreviews`。
- client 方法：`src/api/relayClient.ts` 第 576/580 行附近 `getConversationDiff`、`getConversationDiffFile`（刚补上）、`establishConversationDiffBaseline`。**`getRunToolCallPreviews` 还没挂到 `RelayApiClient` 类上**（类里 746 行只有 `getRunToolCalls`）——生成中预览要用它就自己按同一风格补一个方法，别改别人的行。
- hook：`src/lib/useConversationDiff.ts`（4s 有界轮询、版本守卫防迟到响应覆盖新值、`enabled=false` 时整份清空、暴露 `refresh()`）。`src/lib/useRunToolCalls.ts` 是同类既有写法，参考它的竞态/挂载处理方式。
- 聊天侧既有：`src/views/AssistView.tsx` 第 1546 行 `assist-live-preview-${message.id}`（那是**草稿文本**的生成中预览，不是文件 diff）；第 2068/2231 行是它的轮询；第 2804 行挂了 `ExecutionTrajectorySummary`。`src/components/ExecutionTrajectorySummary.tsx` 是执行轨迹摘要组件，已在消费 `RelayRunToolCall`。

## W3 要交付的两个位置
1. **局部**：聊天里具体文件编辑记录旁显示该次编辑的逐文件增删行（数据来自同源的 `fileChanges` 实际结算；生成中用 tool-call previews，落盘后换成实际数）。文案形态按 §34.2：`✎ 正在生成 <文件名> · 预览 +66 −2` → `✎ 已修改 <文件名> +78 −5`。要点：同一文件被改多次要留下多条局部历史，后来编辑不重写旧记录；预览/待核对用既有次级文字，**只有实际落盘账本支持才显示「已修改」**；待核对/不可统计不能画成 `+0 −0`；缺基线不猜行数。
2. **总数**：输入卡外上方居中的会话净 diff，一行文字按钮就是展开入口（`本次对话 · 3 个文件 +145 −8`），展开标题「本次对话的文件变化」，显示基线时间、目录、逐文件增删行、可用性与完整正文（正文走 `getConversationDiffFile`，与总数同一修订），并说明「包含该目录自基线起的同期修改，不代表全部由 Agent 产生」。状态要可辨：统计中 / 空净变化 / 无目录 / 非 Git 根 / 缺基线 / 失权 / 部分不可统计 / 刷新失败（失败保留上次可信值并标「截至…」）。CD-05 的「从现在开始统计」要能主动触发并显示新起点时间。

硬约束：路径变长、数字位数变化**不得**挤掉发送/停止按钮或草稿辅助入口；不得改变输入卡高度；不得动 composer 既有的发送、附件、分点/润色、斜杠菜单、未保存保护与在途控制逻辑；切会话后旧响应立即不可见；失权时隐藏正文。

## 这个仓库的硬性约束（违反算偏离）
1. **工作树被多个 Agent 同时编辑。** 你现在是 `AssistView.tsx` / `AssistView.css` 这一轮的唯一写入者；另有两个 Agent 分别在改 `AssistSourcePicker.tsx`+`migrated-scoped.css`+`CollaborationView.*` 和 `scripts/run-real-api-browser.ps1`+文档。**禁改**：`src/views/CollaborationView.tsx`、`src/views/CollaborationView.css`、`src/styles.css`、`src/migrated-scoped.css`、`src/components/AssistSourcePicker.tsx`、`scripts/run-real-api-browser.ps1`、`tests/browser/inspectorPreviewLayout.spec.ts`、`tests/browser/composerSourcePanel.spec.ts`、`tests/browser/uiOption2FirstSession.spec.ts`、`tests/browser/free-model-real-api.spec.ts`、`tests/assist-source-picker.spec.ts`、`tests/modelSelector.spec.tsx`、`apps/workbench/scripts/**`、`docs/**`。
   `tests/collaborationWorkspace.spec.ts` 里有一条既有断言钉住 `#assist-source-query` 必须位于 `.agent-chat-options` 内、Esc 焦点归位——**不要为了让它过而改它**；如果你的改动撞它，先汇报。
2. 每次编辑前重新 Read 该文件的对应区域；只做最小 hunk，**绝不用 Write 整文件覆盖**（AssistView.tsx 是数千行的热文件）。发现文件内容和你上次读的不一样，重读再改。
3. 不新增 token 数值；位置/层级/动效沿用 `--relay-*` 既有档位（token 由 `src/lib/tokens.ts` 读 `docs/frontend/design-tokens.json` 注入）。
4. 不为展示需求新造第二套业务状态、不改 `arguments`/`result_ref` 塞历史、不直读磁盘、不自己跑 Git。总数只反映已落盘，生成预览不进总数。
5. 优先新建自己的组件与 spec 文件，而不是往别人正在改的 spec 里塞用例。

## 环境与验证（已实测）
- 8787 真实 API 与 5432 PostgreSQL 当前**没有在监听**：走 fixture/假 client 路线，**不要跑** `run-real-api-browser.ps1`（另一个 Agent 独占它，两个 PG 集群会抢端口与 dist）。
- 127.0.0.1:4173、5173 有 vite dev 在跑（5173 上挂着真实桌面 WebView2 窗口，别动那两个端口的进程）。前端改完不必重启，Vite 会热更。
- 单测：`cd /d/Develop/Relay-Agent/apps/workbench && npx vitest run tests/<file>.spec.tsx`（vitest 5；`--reporter=basic` 不存在）。假 client 挂载用现成的 `tests/mountApp.ts` 里的 `mountReact`/`flush`。
- 浏览器：`cd /d/Develop/Relay-Agent/apps/workbench && npx playwright test <spec> --reporter=line --timeout=60000`（复用 4173；冷启动第一条常撞 30s 超时所以必须带 `--timeout=60000`；**并发全量跑会产出假红灯，归因前先单跑**）。伪造 live API 用 `page.route("http://127.0.0.1:8787/**")`，响应必须过 `src/api/parse/*` 的契约（例如 task 的 `executor` 必须是 `{kind:"HUMAN"|"AI", ...}` 对象，写 null 会让 `getTask` 抛错、页面退回工作空间级视图，测的就不是目标入口）。一次性探针文件命名 `zz*.spec.ts`，**用完必须删**。
- 类型检查：`cd /d/Develop/Relay-Agent/apps/workbench && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`（`npx tsc` 会解析到假包，别用）。我刚才清到 0 错，但别的 Agent 在并行改动，你现在可能看到若干**不属于你**的报错（此前观察到 `src/components/Feedback.tsx`、`tests/assistModelRuntime.spec.tsx`、`tests/browser/zz-connect-diag.spec.ts`、`tests/recentWorkDrag.spec.ts`）——那些不要去修，只保证你文件的 hunk 不新增错误，并把别人残留的错误如实写进汇报。
- API 侧如需确认投影，可用 `apps/api` 里 `./node_modules/.bin/tsc --noEmit`，但不要改 `apps/api` 源码，除非 W3 明确需要新字段且你能说明为什么。

## 交付
1. W3 两个位置的真实实现（含展开、刷新、竞态守卫、各状态呈现）。
2. 新增常驻断言覆盖你实现的不变量（局部历史多条、预览不进总数、迟到响应不覆盖、状态可辨、窄/宽视口不遮发送停止、键盘开合回焦）。
3. 实跑并如实分层报告：vitest 跑了哪些文件与结果、Playwright 跑了哪些与结果、tsc 现状（你的 vs 别人的）。**不能用 fixture/无头浏览器结论宣称真实 PG 或真实 Windows 已验收**；CD-02…CD-10、CD-14…CD-16、CD-20 没跑就明确写「未运行，原因」。
4. 中文汇报（700 字以内，不贴大段代码）：改了哪些文件（绝对路径＋行号）、CD-01/11/12/13/17/18/19 各自状态（已满足/部分满足/无来源/环境阻塞）、实跑结果、剩余限制、需要我裁决的冲突（尤其是任何必须动禁改文件才能闭合的项）。
```

## 派发 3 剩余待办（由主 Agent 承接）

两个子智能体都交回「必须动 `AssistView.tsx` 才能闭合」的项，因该文件本轮唯一写入者已给 `t3-w3-ui`，收回主 Agent 排队：

1. 会话内模型选择改为「点条目即应用并关闭」，与工作台 §27.5 的 2026-10-17 指令及 `free-model-real-api.spec.ts` 第 105 行一致；同时同步单测出口 `modelSelector.spec.tsx` 第 40–53 行。涉及 `AssistView.tsx` 第 3197 行会话输入器调用点（`applyOnSelect` 只在第 922 行首条输入器传入）。
2. CT-02 的彻底拆分：`AssistView.tsx` 第 2953–2991 行把 `sendOptions` 与资料面板挂在同一个 `<details>` 内，需要拆成两块；连带 `tests/collaborationWorkspace.spec.ts` 第 599–628 行既有断言。
3. `AssistView.tsx` 第 2849 行仍写「缓存未采集」的代码注释已随实现过期（该格现在不渲染）。
4. `#assist-source-query` 在协作页重复挂载两次（TaskDelegatePanel 与 composer）属遗留 id 冲突，本轮未动。