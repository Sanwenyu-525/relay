# 功能验收详细记录：分册 18

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../overall-acceptance-details-20261025.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

## 7. 项目列表页头试点与协作事实条修复（2026-10-02）

范围：`/projects` 的 fixture 与 live 两个视图改用 `PageHeader` 原语，页头标题降到 `font.size.compactPage`、目标句降到 `font.size.meta`，范围切换与搜索收进一行紧凑工具栏。仅重组展示，**未改** API、数据库、路由、`data-testid` 与业务文案；§17.8 其余七类页型未动。同轮修复 `collaborationWorkspace.spec.ts` 的 5 例既有失败。

| 检查 | 结果 |
|---|---|
| Workbench 类型检查 | 通过 |
| 项目相关定向测试（projects / projectsTitleRefresh / projectArchiveLive / liveWorkspaceLists / createProjectOnboarding / projectOverview / projectTasks） | 7 文件 **38/38 通过** |
| Workbench 全量组件测试 | 78 文件 **593/593 通过** |
| `collaborationWorkspace.spec.ts` 稳定性 | 连续 4 次 64/64 通过 |
| 浏览器目视（Chromium，示例数据） | 1721×914 与 1280×720 两视口页头收紧，无溢出、无遮挡，范围切换与搜索同排可达 |

同轮修掉 `collaborationWorkspace.spec.ts` 的 5 例既有失败，根因都是实现按 §17.7 演进后测试与断言未跟上，不是新引入的缺陷：

1. **3 例**（暂停请求中 / 执行失败 + 外部 UNKNOWN / Run 失败原因）断言 `collab-facts`，而 `CollaborationView.tsx` 在 `runNeedsAttention` 时只把 Run 控制提到页头、事实条被整个丢掉。这违反[设计系统 §9.2](../../frontend/design-system/part-02.md#92-共享页级原语2026-10-01)「折叠不是隐藏」——UNKNOWN 与无法确认的执行结果不能只剩展开后可见。已改为三类状态出现时事实条与 Run 控制一起常驻页头（同一分支内，不新增 testid）。
2. **1 例**（live 首次进入空工作区）断言旧空态文案「这次想推进什么」。§18.1 已把默认入口改为打开文件夹，实现与文案随之更新，断言改为新文案。
3. **1 例**（正文失败）断言内容只读一次却读到两次。该例在上述修复后连续 4 次通过，未复现；`ArtifactReaderPanel` 的自动展开 effect 依赖 `[client, loading, active 版本 id]`，`client` 身份或 `loading` 抖动都可能触发第二次读取，本次未定位到稳定触发路径，**登记为待观察项，不视为已修**。

未验证：真实 Windows 窗口与 DPI、中文输入法、live 模式浏览器渲染、屏幕阅读器与对比度实测，以及 hover／焦点／冲突／权限拒绝等异常分支。本轮不因此改写 6.4 的剩余阻塞，也不覆盖既有各项结论。

同轮还按 §17.8 收敛了 `/agent` 协作页的任务头：h1 落 `font.size.compactPage`、单行省略、状态芯片不换行，`PageHeader` 标题统一带 `title`，项目归属并入 `collab-current-need`（见[工作台 §17.10](../../frontend/workbench-design/part-06.md#1710-聊天页任务头接续选定稿2026-10-02)）。

| 检查 | 结果 |
|---|---|
| Workbench 类型检查 | 通过 |
| Workbench 全量组件测试 | 78 文件 **593/593 通过** |
| `ui-align-visual.spec.ts`（仓库自带取样） | 2/2 通过；1487×1058 / 1280×720 / 960×640 / 390×844 四视口 `scrollW == viewportW`，无横向溢出 |
| 长任务名回归（临时脚本，复用夹具只改标题长度） | h1 = 28px，宽 684px，状态芯片同行；`collab-goal` 高 **105px，与短标题一致**；`title` 属性等于完整任务名；`scrollW 1487 = viewportW` |

取样输出留在本机 `output/acceptance-raw/ui-align-20261001/`，未纳入版本库。

按用户裁定，委托执行同步按选定稿收进「更多操作」，准入判定抽成 `delegateBlockedReasonFor` 单一来源，禁用原因留在页头常驻（见[工作台 §17.11](../../frontend/workbench-design/part-06.md#1711-委托执行按选定稿收进更多操作2026-10-02)）：

| 检查 | 结果 |
|---|---|
| 委托相关回归（delegate-task / commandPalette / collaborationWorkspace / taskDetail / projectWorkbench） | 5 文件 **123/123 通过** |
| 类型检查 | 通过 |
| 浏览器：可委托（READY + 人工 + START） | 「更多操作」内委托可展开，页头无禁用原因，`collab-goal` 105px |
| 浏览器：不可委托（已取消） | 「更多操作」内显示「当前不可用」；页头首屏常驻「只有 READY 的任务可委托。」，`collab-goal` 138px |
| 两种状态下展开「更多操作」 | 页头高度不变（105 / 138），符合展开不推高上下文 |

**全量套件的负载相关偶发红：已定位三处，均为测试自身设计问题，非本轮产品改动引入。**

1. **已修：`tasks.spec.ts`「筛选刷新保留已知内容并标识更新」。** 原因是用例设 `setFixtureLatency(60)` 后用 `await flush(10)` 断言"刷新中"，拿真实 `setTimeout` 与 60ms 夹具延迟赛跑；机器繁忙时 10ms 窗口会错过刷新态。改为在筛选变更后不推进任何定时器直接断言（与同文件「提交中动词」用例的既有写法一致），并在 `afterEach` 复位 `setFixtureLatency`（此前未复位，会漏给同文件后续用例）。修后 4 次单跑 + 3 次全量均未再出现。
2. **未修：`run-events.spec.ts`「断线以已消费 seq 补历史」。** `expect(runReads - beforeBurst).toBeLessThanOrEqual(2)` 偶发得到 3。用例连发 10 个事件、每次 `flush(10)`，共约 100ms 真实时间；若生产侧去抖窗口更短或机器繁忙，就会多触发一次重读。断言本身是对的（要证明的是合并生效），但当前写法把去抖窗口和测试调度绑在一起。
3. **未修：`collaborationWorkspace.spec.ts` 的级联红。** 一次全量里该文件 **32/64 失败**，首个失败是 `Test timed out in 5000ms`，超时中断后清理未执行，后续用例继承坏状态，于是报出一堆"DOM selector not found"这类**假象**。`vitest.config.ts` 未设 `testTimeout`，走默认 5000ms；该文件单例就含 `flush(260)`、`flush(1_100)` 等大量真实等待，8 worker 并发下 5s 并不宽裕。

第 2、3 项的修法都要动别人的测试写法或全局测试配置（`testTimeout`、去抖断言的场景），超出本轮范围，未擅自改。**结论：当前不能把「全量一次绿」当稳定证据**，需单文件复跑或多次全量采样；上述三处修完后应重新采样确认。

## 8. 文件夹入口与对话直接执行（2026-10-02，开发自检）

范围：`prompts/folder-first-conversation.md` 的 A、B 两片（FC-01–FC-05、FC-08、FC-11 的服务端与组件部分）。**FC-06、FC-07、FC-09、FC-10 未验证。** 本节只记录本轮实际运行到的范围，不含独立复核、真实 Windows 与安装结果。

| 检查 | 结果 | 范围与基准 |
|---|---|---|
| 真实 PG 迁移 `0051_conversation_execution_requests` | 通过 | `migration.integration.test.ts` 9/9；迁移在临时 PostgreSQL 18.6 上从零应用、并发只应用一次、失败回滚 DDL 与账本。`0050_n02_impact_candidate_groups` 是并行 Agent 的同号 migration，未改动。 |
| 目录身份、复用、重放与歧义（真实 PG） | 通过 | `folder-first-conversation.integration.test.ts` 第 1–4 例：首次建立最小 Project + 受管资源、再次打开复用同一 `project_id`/`resource_id`、目录被删除后按原 `command_id` 重放、大小写别名不产生第二个写 Owner、嵌套根要求显式选定作用域、无效目录 422、多项目返回 `AMBIGUOUS` 并可显式选择。 |
| 对话执行链（真实 PG） | 通过 | 同文件第 5 例：`DISCUSS` 不创建 Task；`PREPARE` 候选先落库，同一原消息再提交不产生第二条请求也不重付模型成本；缺连接时 409 并给出**第一项缺失能力**的具体原因；补齐连接与权限后建立真实 Task 并 Delegate 出 Run；重复 Apply 返回同一 `task_id`/`run_id`。**2026-10-04 方案 B**：该 Run 冻结的是 `tool_loop_action`（读集 + `apply_changeset`/`read_change_set`/`run_check`）与 `scope_grant`（`APPLY_CHANGESET` + `CLI_RUN`），不再有 `file_write_action`/`cli_run_action`；授权含一份 `check-1` 冻结检查与实测程序摘要。缺连接时先报 `FILE_QUERY`。 |
| 真实受控文件修改与检查命令（真实 PG + 真实磁盘 + 真实子进程） | 通过 | **2026-10-04 方案 B 改为工具循环真实链**：Run 内模型先 `read_file` 读到磁盘上的真实 `before`，再 `apply_changeset`（带实测基线）落盘为 `after`，再 `run_check` 按 `check_id` 真实执行；三行工具账本全 `SETTLED`，读到的内容断言包含 `before` 而不是预制答案。**2026-10-02 的固定链证据（未批准前内容保持 `before`、两次独立 `ACTION_APPROVAL`、`result_ref.outcome = SUCCEEDED`）绑定当时的源码基准，不继承为现行实现的能力**。 |
| 候选与冻结动作的确定性规则（单元） | 通过 | `conversation-execution.test.ts` 7/7：不可判断的验收条件、目录外/绝对路径/大小写重复/超量变更、非受支持输出、解析失败与非法字段都退回聚焦澄清；**带 `content` 的 `file_changes` 被拒**（正文由执行时决定）；Fake 标记不得与真实写入并存；冻结检查命令必须是可执行文件加参数数组。 |
| API 单元回归 | 通过 | `apps/api` 单元 320/320。需先设置 `RELAY_FILE_IO_HELPER`（原生文件 I/O helper），否则 `managed-content-*` 相关 8 例因环境缺失失败，与本功能无关。 |
| 关键真实 PG 套件回归 | 通过 | 逐个独立运行 `run-graph`、`run-steps`、`run-dispatch`、`api-delegations`、`gateway`、`real-tools-gateway`、`collaboration-controls`、`recovery`、`verification`、`assist`、`migration`、`folder-first-conversation` 均 `status: PASSED`。**全量 57 个集成套件未在一次运行内跑完**（进程被工具超时中止，临时集群已用 `pg_ctl` 干净关闭并删除）。 |
| 组件回归 | 通过 | `apps/workbench` 78 文件 593/593，含新增 `folderFirstConversation.spec.ts` 4/4。中途曾出现 5 例 `collaborationWorkspace.spec.ts` 失败（断言 `collab-facts` 在 Run 需要注意时仍可见），**已在本轮开始前于 HEAD 复现**（把 `CollaborationView.tsx`/`AssistView.tsx` 还原到 HEAD 后同样失败），属 §17.7 折叠事实条与既有断言不一致，本轮未修复；最终全绿是并行 Agent 随后修好该断言后的状态，本功能本身未触碰那条断言。 |
| 类型检查与构建 | 通过 | `apps/api` 与 `apps/workbench` 的 `tsc --noEmit` exit 0；`apps/workbench` `vite build` 通过。 |
| Tauri 宿主 | 编译通过，未运行 | `apps/desktop/src-tauri` 新增 `tauri-plugin-dialog 2.7.2` 与 `select_working_directory` 命令，`cargo check --locked --target x86_64-pc-windows-msvc` 通过。**没有重建桌面包，没有打开原生目录选择器，取消/重启/IME/DPI 完全未验。** |
| 真实 Provider | 未使用 | 本轮只用受控 Fake 模型端口解释候选；`.env` 的真实 Provider 配置未被读取或修改，也没有任何真实项目材料外发。 |

**已知限制（不构成通过）**

0. **2026-10-04 方案 B 的未覆盖项**（用户已选定该形态，见本节对话执行链两行）：C 片协作页呈现未接入——用户确认后只能从 Task/Run 看到「已受理」与最终成果，看不到逐步工具轨迹、参数与结果展开；`DevToolsPanel` 的「Git 变更 / 交互终端 · 未接入」占位因此**不能**替换。解释候选的确认文案尚未按[工作台 §18.4.1](../../frontend/workbench-design/part-05.md#1841-文件改动由执行时的真实读取决定2026-10-04方案-b)改写，仍是「按这个执行」，会让人误以为在确认具体内容。真实 Provider 的 tool calling 质量、真实 Windows 窗口、IME/DPI 与安装未验。
1. 目录登记命令 `OpenWorkingDirectory` 在会话未绑定 Project 时不能建立关联，因此「无目录普通讨论、需要项目资源时再补作用域」只在组件层保留输入，未实现同页补作用域后的续发。
2. 一次执行请求的 `expected_outputs.kind` 目前只支持 `MARKDOWN_DOCUMENT`（与固定工作流一致）；需要其他产物种类时退回聚焦澄清。
3. 会话内多任务的完整恢复矩阵（FC-06/07/09）与真实 Windows 取证（FC-10）未验证。
4. 工作区外仍暂留一个被占用的临时目录 `C:\Users\ASUS\AppData\Local\Temp\relay-api-integration-bc01ec50f6`（被中止的那次全量运行的 `server.log`）。本轮独占的临时集群已 `pg_ctl stop` 并删除；未对该目录继续强删。
5. `apps/workbench` 的 `views/*.css`、`styles.css`、`ArtifactImpactCheckPanel.tsx`、`ArtifactReaderPanel.tsx` 与 `docs/frontend/design-tokens.json` 的未提交修改来自并行 Agent，本轮未触碰、未回退，也未纳入本节结论。

**用户参与事项**

- 需要重建并运行桌面包，手工验证原生目录选择与取消、重开同一目录、关窗重启后的会话恢复、中文 IME 组合输入与 125%/150% DPI 下的入口可达性。本轮无法在工具内打开原生窗口，给不出这些证据。
- 需要一次人工复核：候选就绪时的「按这个执行」是否构成可接受的额外一步（当前实现保留这一步以免展示摘要变成隐式授权）。
## 9. 方案 2 全站生产接入（2026-10-02）

范围：按 [ui-option-2-pages 提示词](../../../prompts/ui-option-2-pages.md) 改造现有 React 工作台——共享壳栏位分离、聊天区页头收敛、三类页型样板，然后推广到 37 个页面/状态单元与选定聊天页。交互归[工作台 §17.12](../../frontend/workbench-design/part-06.md#1712-方案-2-全站生产接入2026-10-02)，组件与布局归[设计系统 §9.3.1](../../frontend/design-system/part-02.md#931-方案-2-生产接入2026-10-02)，新增数值只有 `layout.navigation.railWidth`。**未改**路由、查询语义、`data-testid`、命令 Owner、HTTP 契约、数据库、权限与模型策略；**Breaking Change：No**。

| 检查 | 环境与基准 | 结果 |
|---|---|---|
| `npm run typecheck` | 当前工作区未提交源码 | 本轮改动全部通过；**收尾时共享工作区出现 2 个并行 Agent 的类型错误**，均在 `tests/connectionsSettings.spec.ts:248`（其进行中的 CLI_RUN/FAKE 新增用例），不属本轮文件 |
| `npm run build` | 同上（`tsc --noEmit && vite build`） | 本轮改动状态下通过；产物 CSS 210.64 kB / JS 1320.31 kB（gzip 25.85 / 360.65 kB）。收尾时因上述并行类型错误无法复跑 |
| `npm test` | 78 文件 | 本轮完成时 **595/595 通过**（基线 593；本轮新增 3 条断言、更新 4 处选择器）。收尾复跑为 596/597，1 例为 `run-events` 已知计时偶发（单独运行通过），另 2 例为并行 Agent 同期新增 |
| `npm run test:browser` | Chromium headless，1487×1058 / 1280×720，视口 4173 | 18 通过 / **6 失败**，6 例全部为既有失败，逐条归属见下 |
| `npx playwright test --config scripts/playwright.ui-align.config.ts` | 只读夹具 + 页面内拦截，不连数据库、不调 Provider | 3/3 通过 |

### 9.1 浏览器套件的 6 例失败（均为既有，非本轮引入）

本轮在当前产物上逐条取证，未修改任何断言来消除它们：

| 失败用例 | 归属与依据 |
|---|---|
| `真实 Run 与 Bearer SSE 提示触发权威快照` ×1 次 | **环境**：本机 4173 被一个遗留 socket 占住通配地址（Foxmail PID 9332 → 本地代理 7897），仓库 `webServer` 命令不带 `--strictPort`，Vite 回退到 4174 导致 Playwright 的 URL 探活失败。手工用 `--strictPort` 起在同一端口后该例通过，未改代码与配置 |
| `R02：创建页草稿会拦截侧栏和浏览器返回` | **既有偶发**：同代码连跑 3 次为 1 通过 / 2 失败，失败点在 `page.goBack()` 后草稿守卫对话框未出现。定位到浏览器历史与草稿守卫的时序，未在本轮深挖。2026-10-05 标题栏左侧复位一轮再次命中：全量 Playwright 44 通过 / 该例失败，单跑通过；已用 `git stash` 把本轮改动全部移除后在基线上跑全量，**同样只有该例失败**，故与该轮改动无因果关系 |
| `浏览器预览不显示桌面窗口控制` ×1 | **既有断言与文档冲突**：`App.tsx:119` 无条件渲染 `DesktopTitleBar`，只有窗口控制受 Tauri 门控。这正是[工作台 §17.4](../../frontend/workbench-design/part-04.md#174-当前实现与恢复边界)「浏览器显示业务入口，窗口控制仅由桌面宿主提供」的行为，且 `desktop-titlebar.spec.ts` 断言与之相符。该浏览器断言是过时的一条，本轮不为了让测试变绿而删掉浏览器的前进/后退/搜索/新建 |
| `键盘可达：辅助链接…` ×2、`桌面标题栏偏移下的辅助链接不遮挡窗口控制` ×1 | **既有缺陷**：`App.tsx` 中 `DesktopTitleBar` 排在 `AppShell`（跳到主要内容链接的宿主）之前，Tab 第一站落在标题栏搜索键而不是跳转链接。取证输出显示按 Tab 后 `document.activeElement` 为 `desktop-titlebar__search`。修复要同时处理视觉顺序与 Tab 顺序，属独立一轮，未在本轮夹带 |
| `项目摘要突出当前对象与状态` ×1 | **既有断言与实现不一致**：`ResponsiveRail` 的 `title` 只用作 `aria-label` 与抽屉标题，`.rail-content > h2` 来自 `ProjectsView` 自己的 `<h2 className="rail-heading">项目摘要</h2>`，测试期望的是所选项目名。未在本轮改动右栏结构 |

### 9.2 本轮实际验证到的内容

- **共享壳两列**：1487×1058 与 1280×720 实测图标导航栏 88px、近期工作栏 224px、主体填满余量；拖拽分隔条中心落在两列边界 ±14px 内；深链恢复的选中项正确；四个视口 `scrollW == viewportW`，无横向溢出。
- **键盘路径**：Tab 可聚焦聊天页头标题链接，`Enter` 落到 `/tasks/33333333-…`（实测），完整任务名不再只靠悬停。
- **窄窗收纳**：960×640 下两列 `display: none`，导航与近期工作改由抽屉承担（完整导航 10 项、近期工作 12 项可达）。
- **聊天区空间**：页头 1487×1058 与 1280×720 均为 **77px**（接入前 105px），与任务名长短无关；1280×720 聊天记录 340px、成果阅读区 416px，均在[工作台 §17.6](../../frontend/workbench-design/part-04.md#176-连续协作工作区2026-10-01)的 240px 下限之上；390×844 走既有单区模式。
- **标题层级**：八个普通路由 1280px 主标题一律 40px（`/projects` 按既定紧凑值 28px），390px 一律 28px。过程中发现 `PageHeader` 原语此前没有声明标题字号、`h1` 落回浏览器默认 2em，已补为 `font.size.page`，并把窄窗回落规则扩展到该原语。
- **页签与焦点**：既有 `navigation`、`recentWorkPagination`、`sidebarResize`、`workBreadcrumbScope`、`collaborationWorkspace`、`collaborationLayoutPreferences`、`folderFirstConversation`、`delegate-task`、`draftGuardCoexistence`、`knowledgeReading`、`reviews` 等定向测试全部未改断言通过。

### 9.3 本轮未做（出口保持未验收）

1. **真实业务写入**：未在隔离真实 API/PG 上核验受影响页面的创建、编辑、判断与控制路径回执。浏览器证据只证明夹具与只读分支行为。
2. **真实 Provider**：未调用，未外发任何项目材料。
3. **Windows 窗口**：未重建桌面包，未验证原生目录选择、标题栏、100%/目标 DPI 与独立内容缩放、真实中文 IME、窄/短窗、关闭重开恢复。本轮工具不能打开原生窗口。
4. **安装/升级/卸载**：未做。
5. **完整 37 项的独立业务验收**：本轮完成的是布局与交互出口的接入与自动化/浏览器观察，不等于逐页业务验收通过。
6. **性能与可访问性实测**：未做屏幕阅读器与对比度实测；未做长列表大数据量游标性能观察。
7. **共享工作区并行改动**：本轮收尾时并行 Agent 正在改 `tests/connectionsSettings.spec.ts`，该文件带入 2 个类型错误，使 `npm run typecheck` 与 `npm run build` 在最终树上不再 exit0。本轮未触碰、未回退该文件；上文「本轮改动状态下通过」指本轮自身文件全部干净。

取样输出留在本机 `output/acceptance-raw/ui-align-20261001/`（含 `ui-align-shell.json` 与各视口截图），未纳入版本库。

## 10. 方案 2 接续验收与整改（2026-10-03）

范围：对 2026-10-02 已实施的本轮改造做接续验收。交互归[工作台 §17.12](../../frontend/workbench-design/part-06.md#1712-方案-2-全站生产接入2026-10-02)，组件与布局归[设计系统 §9.3.1](../../frontend/design-system/part-02.md#931-方案-2-生产接入2026-10-02)。本节只登记本轮**接续**的结果；未改路由、命令 Owner、草稿、版本、审批、恢复与 root-bound 能力配置，**Breaking Change：No**。上一轮 §9 的 6 例浏览器失败在本轮全部处理完毕。

### 10.1 整改（先验证，存在差异才改）

| # | 差异 | 判定与处置 |
|---|---|---|
| 1 | `tests/browser/real-api.spec.ts` 仍用 `.app-sidebar` 找主导航 | **实现改动打断的断链**：共享壳拆成两列后该选择器不存在，真实 API 验收在第 40 行就停住。改为 `.app-navrail` |
| 2 | `tests/browser/workbench.spec.ts` 窄窗断言 `.app-sidebar` 隐藏 | 元素不存在时 `toBeHidden()` 空过，断言失去意义。改为分别断言 `.app-navrail` 与 `.app-context-rail` 都收起 |
| 3 | `scripts/ui-polish-verify.mjs` 采集 `.eyebrow` 槽位 | 普通页头改用共享原语后 `/today` 已无该元素，指标恒为 null。改为 `.page-head-meta, .eyebrow` |
| 4 | 跳转链接不是第一个 Tab 站位 | **真实缺陷**：`App.tsx` 把 `DesktopTitleBar` 排在 `AppShell` 之前，Tab 第一站落在标题栏搜索键（取证：`document.activeElement` 为 `desktop-titlebar__search`），违反 WCAG 2.4.1。跳转链接是 `position: fixed`，改由窗口框架 `App.tsx` 持有并置于标题栏之前，视觉位置不变、Tab 顺序正确 |
| 5 | 断言「浏览器不显示整条标题栏」 | **断言与[工作台 §17.4](../../frontend/workbench-design/part-04.md#174-当前实现与恢复边界)冲突**：该节规定浏览器显示前进/后退/搜索/新建，只有窗口控制由桌面宿主提供；`desktop-titlebar.spec.ts` 亦与之一致。断言改为验证没有窗口控制（`desktop-titlebar__controls`、关闭/最小化按钮均不存在），实质检查保留 |
| 6 | 断言项目摘要栏 `h2` 是项目名 | **断言早于 §17.9**：该节规定项目列表试点保留右栏结构不变，分区标题是「项目摘要」，当前对象由 `.rail-project-name` 承担。断言改为分别校验分区标题与对象名，并补 `.rail-intro` 非空，覆盖不减 |
| 7 | `run-real-api-browser.ps1` 从不设 `RELAY_FILE_IO_HELPER`、也不构建 API | **验收脚本缺口**：产物正文要经原生文件 I/O 发布到受管存储，缺该助手时每次保存都如实失败为「内容未能完整发布到受管存储」，真实写入路径根本没被走到。脚本补 cargo 构建 + 环境变量 + 每次用当前源码构建 API |
| 8 | 真实 API 用例在两处依赖默认展开的折叠区 | 「按已知 Project ID 打开」「版本详情与接受选择」「编辑页签」都是默认收起的次级入口。改为显式展开/切换，并顺带证明这些折叠入口在真实 API 下可达 |

### 10.2 实现与自检

| 检查 | 环境与基准 | 结果 |
|---|---|---|
| `npm run typecheck` / `npm run build` | `apps/workbench` 当前未提交源码 | 通过 / 通过 |
| `npm test` | 79 文件 | **606/607 通过**；1 例 `run-events.spec.ts` 为既有计时偶发（单独运行 5/5 通过） |
| `npm run test:browser` | Chromium headless，4173 端口 | **24/24 通过**（上一轮 18 通过 / 6 失败） |
| `npx playwright test --config scripts/playwright.ui-align.config.ts` | 只读夹具 + 页面内拦截 | 3/3 通过 |
| `npm run test`（`apps/api`） | 需 `RELAY_FILE_IO_HELPER` 指向 release 助手 | 325 例中 **321 通过 / 4 失败**；4 例全在 `test/unit/backup-package.test.ts`（M07 备份还原注册表导出，`BACKUP_PACKAGE_INVALID`），与本轮 UI 及真实 API 脚本无关，本轮未触碰该路径 |

### 10.3 独立验收：真实 API / PostgreSQL（已通过）

用仓库既有隔离入口 `apps/workbench/scripts/run-real-api-browser.ps1`：一次性 PostgreSQL 18.6 集群（动态回环端口、随机库名、`relay_migrator`/`relay_app` 真实角色）、53 条业务迁移 + 官方 Saver 图安装、工作空间初始化、真实 API、真实 Vite、真实浏览器；**不读 `.env`、不接用户库、临时目录校验后删除**。

覆盖的人工闭环：创建项目 → 创建任务 → 启动任务 → 打开任务详情 → 保存产物 v1 → 刷新 → 保存 v2 → 经 API 直读核对 `version_count=2` 且 `current_accepted_version_ids=[]` → 选用确切版本 → 勾选验收条件完成 → 核对「本轮接受」与「当前选用」两个指针分离 → 重开 → 核对接受被清除。

结果：**通过**（`playwright=0 pg_stop=0 temporary_removed=True`）。取样未新增文件，全部输出随脚本临时目录一并清除。

### 10.4 独立验收：Windows 桌面（部分通过，窗口观察出口仍未验收）

| 检查 | 结果 |
|---|---|
| `apps/desktop/scripts/build-release.ps1` | **通过**（465s，exit 0）。新包 SHA256 `3ca3cc62…`，17227 个资源文件参与哈希，0 个禁用配置文件，维护能力仅做无效参数探测 |
| `node scripts/verify-desktop-package.mjs apps/desktop/release` | **通过**：`Package hashes verified.` |
| 包与当前源码绑定 | 清单记录的 `AppShell.tsx` / `PageHeader.tsx` / `styles.css` 源哈希取自本轮改造后的源码；清单 `artifact_sha256` 与磁盘 exe 实际 SHA 一致 |
| 上一版包的完整性 | **发现不一致**：旧 `target/release/relay-desktop.exe`（2026-09-30）清单记录 `artifact_sha256=2ad7751a…`，磁盘实际为 `da6a9881…`，且清单源哈希早于本轮全部 UI 改造。该包已不能作为任何本轮结论的依据 |
| 真实窗口事实（`start-acceptance-session.ps1 -InstallGraph -UseCLocale` 一次性会话） | **窗口真实创建**：进程 `relay-desktop`，顶层窗口标题 `Relay Agent`，窗口类 `Tauri Window`，`IsWindowVisible=True`，窗口属主 PID 与进程一致，尺寸 1174×788，**窗口 DPI 120（125% 缩放）**；会话记录绑定新包 SHA。窗口经 WM_CLOSE 正常关闭，会话 `postgres_stop_exit=0 temporary_root_removed=True` |
| 桌面静态/守卫/菜单脚本 | `test-desktop-package.test.mjs` 3 通过 1 跳过、`diagnose-desktop.test.mjs` 2 通过、`test-desktop-dev-guard.test.ps1` PASS 6 场景、`test-desktop-menu.test.ps1` PASS 3 场景 |

**未验收（必须人工参与）**

1. **窗口内实际渲染**：截图/目视一致性、暖白与森林绿观感、导航与近期工作比例观感。
2. **原生目录选择**：打开文件夹对话框、取消、重开同一目录。
3. **真实中文 IME**：组合输入期间 Enter/Escape 不误触；浏览器合成的 composition 事件不能替代。
4. **DPI 对比与独立内容缩放**：只取到 125% 单点，100% 与 150% 未取，内容缩放与系统缩放的组合未验。
5. **关闭/重开恢复**：会话、目录与草稿在真实窗口生命周期下的恢复；`stop-acceptance-session.ps1` 按设计**要求先经真实 UI 关闭窗口**才清理集群，本次以 WM_CLOSE 代替，语义等价但非人工点击。
6. **安装/升级/卸载**：未做。

**发现的脚本缺陷**：`start-acceptance-session.ps1` 在窗口实际存活时仍报 `Release desktop exited during startup: 23`，并因此留下需要手工清理的孤立窗口与集群（本轮命中 2 次）。单实例退出码 23 的既有含义见 [CODEX_NEXT_STEP](../../../CODEX_NEXT_STEP.md)。本轮未修改该脚本，仅记录。

### 10.5 仍未通过的既有缺陷（未在本轮修复）

1. **浏览器返回不触发草稿守卫**：`/tasks?view=create` 填写草稿后按浏览器返回，导航会提交离开。插桩探针在 4188 端口下 4/4 次复现：URL 变为 `/tasks`、表单消失、4 秒内对话框始终为 0，草稿静默丢失；同一流程在 4173 下 5/5 通过。根因是 react-router `useBlocker` 无法可靠拦截浏览器已提交的 POP。`workbench.spec.ts` 的 R02 用例保留为真实闸门，本轮**未**放宽断言。
2. **`apps/api` 备份还原注册表 4 例失败**：`BACKUP_PACKAGE_INVALID`，属 M07 备份还原路径，本轮未触碰。
3. **`run-events.spec.ts` 计时偶发**：单独运行稳定通过，全量并行下偶发失败。

### 10.6 结论

以下保留接续实施轮的成绩；当前源码独立复核新增的失败与结论见 §10.7，不能仅凭以下自检通过放行。

- **已通过**：共享壳与聊天区、37 项页面/状态的接入回归、类型检查、生产构建、组件回归（606/607）、浏览器套件（24/24）、只读视觉与键盘取样、**真实 API/PG 人工闭环**、桌面包重建与完整性验证、真实窗口创建与 DPI 单点取样。
- **保持未验收**：Windows 窗口渲染观察、原生目录选择、真实中文 IME、DPI 多点对比与内容缩放、关闭重开恢复、安装/升级/卸载、完整 37 项的逐页人工业务验收、性能与屏幕阅读器实测。
- 结论绑定本节记录的文件基准；未把旧成绩、旧包或旧图升级为整体交付。

## 11. 首装空态：说清「没有」并给出入口（2026-10-06）

范围：用户反馈「没数据的时候好空」。本轮建立共享空态组件 `components/EmptyState.tsx`，并替换 `/projects` 的 fixture 与 live 两个视图与左栏「近期的任务」。交互归[工作台 §17.13](../../frontend/workbench-design/part-06.md#1713-首装空态说清没有并给出入口2026-10-06)，组件与 token 归[设计系统 §6 EmptyState](../../frontend/design-system/part-01.md#emptystate2026-10-06)。**未新增色值、圆角、时长或第二套尺寸**，**未改**路由、命令 Owner、HTTP 契约、数据库与权限，**Breaking Change：No**；新增 `data-testid`：`projects-empty`、`projects-archived-empty`、`projects-live-no-match`、`projects-fixture-no-match`、`projects-rail-empty`、`recent-work-empty`。

### 11.1 实现与自检

| 检查 | 环境与基准 | 结果 |
|---|---|---|
| `npm run typecheck` | `apps/workbench` 当前未提交源码 | 通过 |
| `npm run build` | `tsc --noEmit && vite build` | 通过 |
| `npx playwright test projects-empty-state` | Chromium headless，4173 端口，页面内拦截伪造空工作空间 | **4/4 通过** |
| `npx playwright test uiOption2FirstSession` | 同上 | **15 通过 / 1 失败**，失败例非本轮引入，见 §11.3 |

新增 4 条浏览器用例覆盖：首装空态的三件套与主操作、图标 `aria-hidden`、右栏与左栏首装不再给无效指引、归档范围为空不提供无效新建入口、搜索无匹配与工作空间为空分属不同状态。`recent-work-no-match` 的既有断言（`uiOption2FirstSession.spec.ts:379`）未改断言即通过。

**本轮修的真实缺陷**：`LiveProjectsListView` 的空态此前**没有任何主操作**——`onCreate` 已传入却在空态里未使用，而 fixture 视图空态本就有「新建项目」。同一页面两个分支对同一状态给出不同入口，本轮对齐。

### 11.2 本轮实际验证到的内容

- **首装空态**（1600×1000 实测）：主区有真实 `h2`、说明项目是什么与下一步、新建项目与记录目标两个真实入口；范围说明（已加载 0 项 · 当前搜索显示 0 项 · 已到列表末页）仍在空态之上，未因列表为空而消失。
- **右栏**：首装时不再显示「选择已加载项目查看确切 ID、阶段和修订」——范围里没有可选对象时那是无效指引。
- **归档范围**：为空时说明归档保留历史事实，只给「回到进行中」，**不提供**新建项目。
- **搜索无匹配**：只说明「已加载 N 项里没有命中」并说明搜索只覆盖已加载范围，不暗示整个工作空间为空。
- **左栏**：紧凑空态 +「新建任务」文字动作，无 primary（侧栏承担定位）。
- **视觉**：全部复用既有 token；无新增色值；不套卡片；按内容高度靠上排列。四个视口未逐一复测横向溢出。

### 11.3 未通过与归属

`uiOption2FirstSession.spec.ts:437`「输入区不画分隔线、不允许拖拽调高；发送键圆心与卡片圆角圆心重合」失败：`composer.toolsHeight` 期望 32px、实际 40px。

**与本轮无因果关系，已取证**：把本轮新增的全部 `.empty-state` 选择器改名为惰性类名后重跑，**同一例以同一数值失败**（32 vs 40），证明本轮 CSS 未参与。根因是工作区中**本轮之前就已存在**的未提交改动：`AssistView.css` 新增的 `.agent-chat-mode-option` 与 `.agent-chat-assistant-create > summary` 使用 `min-height: var(--relay-control-height)`（2.5rem = 40px），位于 `.agent-chat-composer-tools` 内，撑高了该行；与既有测试的 32px（发送键直径）断言冲突。

本轮**未触碰**该文件与该断言，也未删改测试让成绩变绿。该冲突属那条并行改动的收尾事项（要么让 chip 行高回到 32px，要么更新断言并说明新的控件高度契约），留待其所有者处理。

### 11.4 本轮未做（出口保持未验收）

1. **其余页面空态未替换**：`/tasks`、三工作台、`/knowledge`、`/reviews`、`/settings`、`/connections`、对象详情与 Run 仍有 10 余处一行 `helper-text` 空态。共享组件已就位，替换范围待后续推进。
2. **真实 Windows 窗口渲染**：未重建桌面包，未在真实窗口内目视核对空态的字号观感、暖白与森林绿观感、窄/短窗表现、DPI 与真实中文 IME。浏览器截图不代替真实窗口验收。
3. **屏幕阅读器实测**：图标 `aria-hidden` 与真实 heading 是按规则实现并有断言覆盖，但未做实际读屏软件验证。
4. **对比度实测**：未用工具测 `--relay-color-text-muted` 在 `--relay-color-bg-subtle` 上的实际对比度数值。
5. **首装空态的两个 primary**：空态「新建项目」与页头常驻「新建项目」同屏并存。当前保留两个，理由见 §11.5，属**待用户裁定**的未决取舍。

### 11.5 未决取舍

| 项 | 现状 | 说明 |
|---|---|---|
| 两个 primary | 保留两个 | 页头入口在「已归档」页签与列表非空时同样必须可发现，且不因空态出现而隐藏（避免布局跳变）。skill 的 `primary-action` 与设计系统 §6「一个决策区一个主操作」要求一屏只突出一个 CTA——两者不在同一决策区内，但同屏仍可能被读成重复。是否把其中一个降为次要待定，改动可逆 |

### 10.7 当前源码的独立复核（2026-10-03）

用户再次要求实际验收。基准为 HEAD `20a9254a552e0656ceadedda94c994483251bdf3`，受验开始时生产源码没有未提交改动，既有未跟踪原型目录未触碰。本轮主 Agent 运行类型、构建、全量回归、真实浏览器与隔离 API/PG；指定 `gpt-6.1-sol` 独立审查并运行四项反例，主 Agent 读取原日志和观察并复核。**结论：CHANGES_REQUESTED，尚未修复；本验收任务未修改生产代码或正式测试。**

收尾时其他并行任务开始修改 Gateway、File Query、新增 `0054_m04_agent_tool_loop.sql` 及其文档，未覆盖或回退。此时 `apps/workbench/src` 与正式测试无未提交差异；本轮前端结论仍绑定受验源码，真实 API/PG 的53迁移成绩绑定运行时点，不覆盖后来的0054与工具循环增量。

| 检查 | 本轮实际结果与范围 |
|---|---|
| 类型与构建 | 固定 Node 24.21.0，`apps/workbench` 的 `npm run typecheck`、`npm run build` 均 exit0；构建仍有大 chunk 与静态/动态混用导入警告，不作为这四项缺陷的原因 |
| 既有全量组件回归 | `npm test -- --maxWorkers=1` **79 文件、607/607、exit0**，457.52s。首轮默认并发与类型/构建同时运行为 492 通过/115 失败，主要见超时与 overlapping act 级联；定向单 worker 24/24、随后同基准完整单 worker 通过。没有修改正式断言或超时，不把首轮 115 条当成 115 个独立产品缺陷；并发运行的时序稳定性仍未闭合 |
| 既有浏览器场景 | Chromium headless，单 worker，在隔离 Vite 4196 上 **23/24**。唯一 Run SSE 失败因夹具硬编码 `access-control-allow-origin: http://127.0.0.1:4173`；核对既有 4173 的进程命令确为本工作区 Vite 后，原用例、原断言在 4173 **1/1 通过**。本轮全部 24 个场景已验证，未将两个端口写成一次完整 24/24 运行 |
| 真实 API/PG 人工闭环 | 直接运行 `apps/workbench/scripts/run-real-api-browser.ps1`，**1/1、exit0**；本次当前 API 编译、53 条迁移、Graph 安装及工作空间初始化后，创建项目/任务、启动、保存 v1/v2、选用、完成、重开通过。最终 `playwright=0 pg_stop=0 temporary_removed=True`。首轮外层日志重定向使 pg_ctl 输出句柄卡住，尚未跑业务；准确关闭该次私有集群后脚本失败退出并清理，直接重跑通过，没有停止用户库 |
| 浏览器布局取样 | 只读夹具 + 当前生产组件，1721×914、1280×720、960×640、390×844 的根 `scrollWidth` 均等于视口宽；宽窗导航 88px、近期栏 224px，前两个视口聊天页头 77px，窄窗两栏收起。项目、任务、待审、知识、今日、连接、设置七个有效路由未发现根横向溢出。此为布局取样，不是 37 项完整业务验收 |
| 新增缺陷反例 | 四项期望行为测试均 **FAIL**，无测试超时/act 级联；前三项另在真实 Chromium 页面复现，待审版本项为完整 `/reviews` 的 jsdom 页面运行。反例保存在本机忽略目录，没有混入原 607 项或修改正式测试让成绩变绿 |

**当前阻断项**

| 优先级 | 缺陷、根因与复现 |
|---|---|
| P1 | **首条消息响应丢失，原命令无法核对。** `AssistView.tsx:194–204` 先清建会话 pending 并调用 `loadTarget` 增加请求版本，首条消息 command_id 只存局部；catch 因版本变化返回。组件夹具模拟服务端已接受消息后丢响应，观察原 pending=null、无命令 ID/回执入口/错误，仍能离页；Chromium 中建会话成功后中断消息响应，同样无原 ID、恢复按钮或 alert。后者只证明客户端网络失败处理，不证明真实数据库已提交 |
| P2 | **首条未发送草稿没有离页保护。** `AssistView.tsx:126–130` 未将 `firstDraft` 纳入 dirty/discard。组件与 Chromium：打开无会话目录，输入后点击主导航“项目”，无对话框离开，返回同目录草稿为空。这是普通 Link 导航缺陷，与 §10.5 的浏览器 POP 历史反例分开 |
| P2 | **首条明确执行输入跳过执行解释。** `AssistView.tsx:199–200` 只发送消息，未复用普通发送的 `requestExecution(sent.userMessageId)`（约 644 行）。组件与 Chromium 的首条消息均发出，但 execution-requests POST=0、无摘要；组件同目录同会话普通发送正控制 POST=1且摘要存在。未调用真实模型或建立 Task/Run |
| P2 | **待审阅读另一版缺少判断绑定错配提醒。** `ReviewsView.tsx:133–134` 使用非紧凑 reader，`ArtifactReaderPanel.tsx:232–241` 只在 compact 分支展示警示。完整待审页面成功读取绑定 v1 后切读 v2，Review 身份保持不变，判断仍绑定 v1，但警示不存在、返回按钮为0，POST=0。当前绑定没有被错误修改；缺陷是阅读/判断版本差异不可见 |

前三项浏览器取证首轮临时夹具把建会话返回为200，而真实客户端要求201，导致两个探针未进入目标路径；修正临时夹具后均到达首条消息路径并复现。另三次误用 `/memory`、`/decisions`、`/rules` 的样本落到 Unsupported 页，不纳入上述七个有效路由。保留这些辅助探针失误，不记为产品失败或通过。

原日志、临时反例、结构化观察与截图留本机 `output/acceptance-raw/ui-option2-independent-20261003/`，包括 `component-tests-single-worker.log`、`browser-tests.log`、`browser-4173.log`、`first-session-run.log`、`review-version-run.log`、`browser-probes.json` 与修正后的 `browser-probes-first-session.json`。本轮只更新本表与当前下一步，并交付独立[整改提示词](../../../prompts/remediation/ui-option-2-first-session.md)，原开发提示词保留。

**未覆盖**：真实 Windows 窗口内观察、原生目录选择、真实中文 IME、系统 DPI 多点与独立内容缩放、窗口重启恢复、安装/升级/卸载、真实 Provider 质量与完整 37 项逐页业务验收。§10.4 的旧窗口创建/包身份证据保留，未升级为本轮当前源码的完整桌面通过；没有重建包或改变 M04–M07/N 阶段出口。

### 10.8 四项整改的实现、自检与复验（2026-10-03）

本节保留实施轮的修复与自检成绩；用户再次要求验收后，动态会话、在途响应与换目录的新增反例仍失败，当前独立结论见§10.9。现有断言通过不等于首条恢复出口完整闭合。

范围：按[整改提示词](../../../prompts/remediation/ui-option-2-first-session.md)修复 §10.7 的四项阻断。基准为 `20a9254a552e0656ceadedda94c994483251bdf3` 加本轮改动；**未改路由、命令 Owner、HTTP 契约、数据库与权限，未新增业务 API 或 migration**；保留已实施的共享壳、`PageHeader`、`titleHref`、设置真实保存、模型验证六态与配置指纹、八类能力与 root-bound 配置。**Breaking Change：No**。服务端协议未变动，因此不需要补真实 PG 集成。

先落回归再改实现：四个反例在修复前均按预期失败（P1 `assist-first-pending` 不存在、P2 无守卫对话框、P3 `source_message_id` 为 undefined、P4 非紧凑形态无 `collab-review-version-mismatch`）。

| 缺陷 | 修复 | 关键约束的落点 |
|---|---|---|
| P1 首条消息响应丢失后原命令无法恢复 | `AssistView` 新增 `PendingFirstMessage`（`sessionId`/`commandId`/`content`/`reason`），在发送前固定命令身份；传输失败不再被推断为业务失败，改为保留原命令与真实原因，并给出「查询首条回执」与「按原命令重试」。首条发送与同 ID 重试共用一条发送路径；回执只按原 `command_id` 查询并校验 `command_type` 与 `session_id`；防双击用同步 ref 闸；连接已换时不猜结果 | 该状态**上移到 `CollaborationView`**：文件夹入口的 `AssistView` 以会话为 key，建会话成功后必然重新挂载，本地 state 会连同未决命令一起丢失。父级持有后新实例立即重新投影，守卫与两个恢复出口在重挂载后仍可达 |
| P2 首条未发送草稿离页丢失 | `firstDraft` 纳入既有 `dirty`/`discard` 投影，与已选资料同一份保护 | 未新增第二套对话框：上层 `combinedGuard.discard()` 在存在未决命令时本就拒绝放弃，首条消息未决命令也走同一投影 |
| P3 首条明确执行输入跳过执行解释 | 首条发送成功后按**消息回执里的真实 `user_message_id`** 与确切目录 `resource_id` 走既有 `execution-requests` 链；核对成功后才解释，回执未确定时不猜 `source_message_id` | 解释结果交给会话面板既有 `initialExecution` 承载，摘要与「按这个执行」仍由原 Owner 渲染与执行，没有第二套确认门；前端不做关键词判断，也不自动建立 Task |
| P4 待审页阅读其他版本无错配提醒 | `ArtifactReaderPanel` 把错配提醒提取为单一节点，compact 纸面与完整待审页的非紧凑正文两种形态都渲染 | 提醒显示正在阅读版本与判断绑定版本并提供「返回判断版本」；只重读确切绑定版本，不改 Review、审批目标或命令载荷，也不为显示提示切换页面布局 |

| 检查 | 环境与基准 | 结果 |
|---|---|---|
| `npm run typecheck` / `npm run build` | `apps/workbench` 当前未提交源码 | 通过 / 通过（CSS 212.66 kB、JS 1337.25 kB） |
| 定向 React 回归 | `folderFirstConversation` / `artifactReader` / `reviews` / `collaborationWorkspace` / `assist-*` / `knowledgeReading` / `taskDetail` / `draftGuardCoexistence` | 11 文件 **157/157 通过** |
| 全量组件回归 | 固定 Node 24.21.0，`npm test -- --maxWorkers=1` | 79 文件 **612/612 通过**，exit0，340.48s（基线 607，本轮 +5 条反例） |
| 既有浏览器场景 + 四项真实点击 | Chromium headless，本工作区 Vite 固定 4173（该端口此前只有遗留 socket、无 LISTENING，已核对确属本项目后自行拉起） | 新增 4 条 **4/4 通过**；全量 28 项在同批通过过一次，本轮末次复跑出现 1 例既有 `R02` 失败，单独连跑 4 次为 3 通过 / 1 失败，属 §10.5 已登记的 POP 偶发，非本轮改动（该用例走任务创建页草稿守卫，与文件夹首条链无交集），R02 断言未放宽 |
| 真实 API/PG 人工闭环 | `run-real-api-browser.ps1`，一次性 PG 18.6 + 真实 API | 本轮**先 1/1 通过**（`playwright=0 pg_stop=0 temporary_removed=True`），**末次复跑未能执行**：`apps/api` 当前编译失败于并行 Agent 未提交的 `src/worker/tool-loop-action.ts:164`（`GatewayOperationStatus` 含 `FAILED`，不能赋给 `WAITING_APPROVAL \| PREPARED`）。该文件不由本轮产生，本轮改动只在 `apps/workbench`，无法在不触碰他人进行中改动的前提下复跑 |

**四项反例的双层覆盖**：Vitest 组件回归（`folderFirstConversation.spec.ts` 四条、`artifactReader.spec.ts` 一条）与真实 Chromium 点击（新增 `tests/browser/uiOption2FirstSession.spec.ts` 四条）均覆盖草稿保留/放弃、响应丢失后的同 ID 重试与回执核对、首条与普通发送都走执行解释且纯讨论不建任务、Review v1→v2→返回 v1 且绑定与业务 POST 不随阅读改变。首条发送与同 ID 重试共用一条发送路径，命令 ID 与载荷在发送前固定；防双击用同步 ref 闸而不是 `setCreating`（同一 tick 内状态尚未生效，靠它防不住重建或重发）；连接已换时不猜结果，保留未决命令与原因。「已提交但响应丢失」在两处都明确标注为**受控故障**（组件夹具抛传输错误 / 浏览器 `route.abort`），不冒充服务端真实失败。

**本轮未覆盖**

1. 真实 API/PG 的文件夹入口首条会话链**未**单跑一条端到端，且末次真实 API 复跑被上述并行编译错误阻断；现有真实闭环只覆盖项目/任务/产物/选用/完成/重开。四项修复的客户端行为由组件与真实浏览器两层覆盖，真实写入路径未因此改变。
2. 首条消息同 ID 重试与回执核对只有夹具与浏览器证据，**未**在真实 PG 上验证服务端对同一 `command_id` 的幂等重放。
3. §10.7 首轮并发运行 115 条失败的时序稳定性仍未闭合；本轮按提示词固定 `--maxWorkers=1`。
4. §10.5 的浏览器返回 POP 偶发（本轮实测 4 次中 1 次失败）与 `apps/api` 备份还原注册表 4 例 `BACKUP_PACKAGE_INVALID` 仍未修复，不属本轮范围。
5. §10.4 与 §10.7 的 Windows 窗口内观察、原生目录选择、真实中文 IME、系统 DPI 多点与独立内容缩放、窗口重启恢复、安装/升级/卸载仍未验收，本轮未重建桌面包、未改变 M04–M07 与 N 阶段出口。

### 10.9 整改后的独立复验（2026-10-03）

范围：用户再次要求验收，对§10.8未提交的 UI 修复独立复核。基准为 HEAD `20a9254a552e0656ceadedda94c994483251bdf3` 加 `AssistView`、`CollaborationView`、`ArtifactReaderPanel` 及相关正式回归的当前修改。主 Agent 运行工程、组件、Chromium和隔离API/PG；指定 `gpt-6.1-sol` 子代理独立审查并运行换目录/创建回执反例，主 Agent 读取实际观察与日志。受验11项源码、测试、配置的运行前后SHA256无变化。本次没有修改生产代码或正式测试，保留其他任务的后端工具循环改动。

**结论：CHANGES_REQUESTED。** 普通Link首条草稿保护、消息丢响应后的原ID/原载荷重试、首条执行解释POST及非紧凑Review版本提醒已有通过证据；首条完整恢复与摘要显示仍不通过。

| 检查 | 本次独立结果与限制 |
|---|---|
| 前端类型与生产构建 | 固定Node24.21.0，`npm run typecheck`、`npm run build`均exit0；CSS212.66kB、JS1337.25kB。未重建桌面包 |
| 受影响组件回归 | 9文件**151/151、exit0**，单worker：`folderFirstConversation`、`artifactReader`、`reviews`、`collaborationWorkspace`、`assist-flow`、`assist-preview`、`knowledgeReading`、`taskDetail`、`draftGuardCoexistence`。§10.8的612/612保留为实施者自检，本次未再跑全量；已有新增故障反例失败，未扩大成无关全仓验收 |
| 四项正式浏览器场景 | 将原`uiOption2FirstSession.spec.ts`夹具与四个原断言复制到本机独立脚本，只改模块导入路径和输出位置；真实Chromium、4173、本次独占Vite，**4/4通过**。与下述新增摘要/竞态反例在同批执行，没有降低原断言 |
| 首条摘要与回执竞态 | 真实Chromium两个新增期望行为反例均**FAIL**：PREPARE请求已发但摘要不存在；同一消息回执与迟到响应触发两次解释。竞态探针首轮误用按钮testid，未进入故障点；按实际`assist-first-receipt`修正临时脚本后单独复跑，实得两个不同解释command_id。首轮辅助超时不算产品失败 |
| 换目录与创建回执恢复 | 指定子代理用正式React/Router与受控fetch，单worker，3项期望行为反例均**FAIL**（709/1027/1022ms，无超时或act级联）。动态会话列表和125ms响应延迟确保实际发生重挂载，未用永久空会话夹具掩盖问题 |
| API类型与真实基础闭环 | 当前API `tsc --noEmit` exit0，§10.8所述编译阻断本次没有复现。直接运行既有`run-real-api-browser.ps1`：一次性PG18.6、54条业务迁移、Graph安装、真实API/Vite/Chromium；项目→任务→启动→产物v1/v2→选用→完成→重开**1/1通过**，`playwright=0 pg_stop=0 temporary_removed=True`。只证明该人工闭环在运行时基准通过，不证明新增工具循环总出口、文件夹首条故障恢复或真实Provider质量 |

**仍需整改的四类缺口（五项实际失败反例）**

| 优先级 | 复现、根因与边界 |
|---|---|
| P1 | **换目录绕过保护，未决消息使用新资源解释。** `CollaborationView.tsx:315–324`直接打开/替换目录，没有走既有转换守卫。反例1：原草稿dirty=true，换到另一项目目录无对话框、原文清空。反例2：原消息command_id与确切回执保持，但换目录后向原session的execution-requests发`resource_id=res-2`，原为res-1；`AssistView.tsx:215–220`从当前executionScope取资源。这仅证明客户端错误载荷，未验证真实后端接受，更不证明文件副作用 |
| P2 | **首条解释成功后的摘要没有进入当前会话。** 浏览器：建会话1次、解释POST1次、无alert，`execution-summary`数量0。`AssistView.tsx:237`的onSessionCreated令`CollaborationView.tsx:496`按session重挂载，解释结果随后写旧实例firstExecution；会话面板约571行只初始化一次initialExecution。正式P3只查POST与来源，未查摘要可见，因而仍能通过 |
| P2 | **原消息在途时，回执核对与迟到响应重复解释。** 浏览器受控夹具保留原消息响应，重挂载后“查询首条回执”已启用；正确回执核对成功后释放原响应，同一msg-1/res-1实际产生2次execution-requests，解释command_id不同。`creating`/`sendingFirst`仍属于旧实例，新实例没有共享忙碌状态，两条成功路径均生成新解释ID。只证明重复客户端调用，未建立两个真实Task或执行文件动作 |
| P2 | **创建回执恢复吞掉首条内容。** 组件夹具先接受创建命令、125ms后丢响应；查询原CreateAssistSession回执成功后正常会话出现，但首条输入卸载、普通输入为空、messages POST=0、pending清空。`AssistView.tsx:295–306`只恢复会话并重挂载，没有交接首条原载荷与后续发送阶段 |

本机必要原始输出在`output/acceptance-raw/ui-option2-recheck-20261003-192920/`：`source-before.json`/`source-after.json`、类型/构建/定向组件日志、`browser-independent.log`、`browser-race-rerun.log`及两个浏览器观察JSON/截图、`agent-folder-run.log`与三个组件观察JSON。未为每次验收新建受控报告；本节是唯一结果入口，当前整改输入更新至[提示词第6节](../../../prompts/remediation/ui-option-2-first-session.md#6-整改后独立复验的接续任务2026-10-03)。隔离PG临时根已清理，本次独占Vite在收尾停止；用户既有服务未操作。

未关闭：五项反例的真实API/PG故障恢复、窗口内观察、原生目录选择、真实中文IME、系统DPI与内容缩放、关闭重开、安装/升级/卸载、37项完整业务验收及既有POP偶发。没有外呼Provider、没有重打桌面包，M/N阶段总出口不变。

