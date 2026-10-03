# Relay 当前状态与下一步

更新：2026-10-03。角色：唯一阶段、模块与下一步入口。功能通过/未通过/未验收只看[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)；长篇经过保存在[历史快照](docs/development/codex-next-step-history-20260930.md)，不作为默认交接输入。

**当前结论：M01–M03 已在注明基准与范围内独立验收；M04–M07 总出口与 Windows 安装交付仍未完成。** 通过项绑定原运行环境和版本，不自动覆盖当前未提交修改。真实 Provider 已于 2026-09-29 获用户授权做定向验证，不把早期“保持关闭”当作现在的配置事实，也不自行扩大外发范围。

N 阶段（V1 后续长期协作）已按[整阶段提示词](prompts/post-v1-collaboration.md)开始接续，2026-10-02 完成 N00 测量缺口、N01 独立验收 P1 修复与 N02 首片实现；三者的实际范围、命令与剩余项只见[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)“N00–N02 后续长期协作首轮”行。M 阶段状态不因 N 阶段推进而改变，N 阶段也不解除 M 出口。

## N 阶段当前状态

| 包 | 状态 | 当前范围与剩余出口 |
|---|---|---|
| N00 使用基线 | 脚本缺口已补，链路已通，基线未测 | `n00-baseline.mjs` 已接入 Trace 的 `first_text_delta_at`/`first_preview_persisted_at`。取数时发现桌面库停在 0048 导致 Trace 全量 500，已备份并补迁移至 51 行，脚本对真实 run 复跑 exit0。**基线本身待用户按 `n00-task-set.json` 填真实 `runs` 与 `observations` 后才产出**；未测前不得声称省时 |
| N01 项目接续点 | 工程自检通过，独立验收 P1 已修并复跑 | 独立验收的 P1 断言已改按 `ref_id`，当前源码连续 3 次 4/4 全绿；P3-1 规格缺口已登记。真实 Windows 人工路径与 PV01/PV08 未跑 |
| N02 跨成果共创 | 首片工程自检通过；独立验收阻塞项已修复复跑 | 候选组＋组合检查单（迁移 0050、四个端点、面板视图），真实 PG/HTTP 3/3、组件 3/3。首轮独立验收 CHANGES_REQUESTED 的唯一阻塞项（登记引用缺口核错父版本造成每项假缺口）已修并补两条断言。候选间依赖联动、不完整选择拒绝、组级回滚与真实 Windows 差异审阅未做 |
| N03 项目知识整理 | 后端与前端均已接入；独立验收 P1 与四项 P2 已修复复跑 | 导读编排（迁移 0052）+ 整理候选（迁移 0053），7 个端点，真实 PG 5/5（含接受/拒绝竞态与同 command_id 并发重放）。前端：知识页导读编排视图（重写 `ProjectKnowledgeGuide.tsx`）、谱系页整理候选面板（新增 `KnowledgeCurationPanel.tsx`）、workbench 606/607。首轮独立验收 CHANGES_REQUESTED 的 P1（被拒候选仍产生无归属知识版本）与 P2（拒绝态读取丢失、两处并发不返回原回执、工作空间级同名知识死路）均已修复。旧版客户端聚合导读已整体替换，项目目标不再出现在导读内。真实 Windows 与 PV03/PV08 未做 |
| N04 周期计划 | 未进入 | N01/N03 已有首片工程输入，真实 Windows/完整使用出口仍缺；本轮仅规划，未授权开工 |
| N05 有限触发 | 未进入 | 依赖 N04；一次性、错过处置及绝对时刻规则已确认，提醒调度/持久去重工程协议待核定 |
| N06 有限连续委托 | 未进入 | 依赖 N04＋N05；串行、重启人工继续及到期安全暂停已确认，授权/预算/控制组合工程协议待核定 |
| N07 声明式配置 | 不进入 | 需 N03/N04 的实际重复使用证据；当前无该证据 |

N 阶段的实际结果、限制与归属分析只维护在功能验收表；本表只维护阶段状态。M 阶段与文件夹入口的分工、并行 Agent 的未提交改动与既有阻塞见下。


## 当前改造模块状态

| 模块 | 状态 | 当前范围与剩余出口 |
|---|---|---|
| M01：基线与适配 | ACCEPTED | [独立验收](docs/testing/m01-independent-acceptance.md)通过；保留原运行基准 |
| M02：React 与 Windows 基础 | ACCEPTED | [独立验收](docs/testing/m02-independent-acceptance.md)通过；不涵盖最新 UI 或安装总验收 |
| M03：Mock Runtime 与可靠性 | ACCEPTED | 2026-09-30 本轮后端源码与确切冻结包的有限 Mock G01–G08 出口独立复核通过；一次启动退出 101 未定位、后续连续重启未再现，保留风险，不称已修复。成绩、包身份、性能及 harness 边界只看[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表) |
| M04：模型、Context、Assist、低风险工具 | IN_PROGRESS | **2026-10-02 F24 修复轮**：两处提案接受幂等缺陷已修并复验（真实 PG/HTTP 受控行锁反例，先跑红后跑绿）；**第四项蓝图的真实模型定向测试新增并 4/4 通过**，覆盖生成只写候选、来源冻结、只读预览/Diff、基线不符 409、显式 Apply 只建 HUMAN/ME/INBOX Task、选择 Pack 不授权、重放与取消。同轮量化：`task-to-execution-contract@1.1.0` 真实调用 10 次 7 通过、3 次 `OUTPUT_SCHEMA_INVALID`，**稳定性未闭合**；四项 Skill 的质量案例/评分/重复次数/预算本轮未冻结，故只有契约合规性有证据。原调用首文本/首预览计时、选源 DRAFT→Review→完成、Assist 多轮/提案接受、Files/Web 图组合与读取委托 Windows UI 的既有定向成绩保留；真实服务故障、能力/质量、真实 Windows 与完整状态矩阵仍待验；基准和限制只看[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表) |
| M05：工作体验与追溯 | IN_PROGRESS | Today/工作台/知识/追溯及归档已有实现与分片自检；当前 UI 和业务总验收未完成 |
| M06：真实工具与 Coding Worker | IN_PROGRESS | 文件/Git/CLI、账本、UNKNOWN/PARTIAL 人工处置及无回执恢复有分片验证；2026-10-02 补齐 **root-bound 能力配置入口**（`FILE_WRITE`/`GIT_READ`/`GIT_WRITE`/`CLI_RUN` 连接与策略此前无法从产品内创建，`resolveConnectionConfig` 与 HTTP schema 早已支持）；Git/CLI **动作触发协议仍缺**：`prepareGatewayAction` 只接受 `RUN`/`USER_IMPORT`，补齐需新增 origin 词表 migration 与准入/派发/核对分支；[确切包、人工交互及总出口](docs/testing/m06-independent-acceptance.md)仍待验 |
| M07：Windows 安装与 V1 总验收 | IN_PROGRESS | 完整备份CLI、启动隔离、新空库/data_root隔离还原CLI及非空目标业务只读维护核对已有实现；原/目标包分别绑定，目标CONNECT与标记保留，历史ARMED只进evidence，不自动放行或重发UNKNOWN。隔离还原原冻结源码出口已通过独立验收，维护核对冻结源码出口已通过独立验收，其余维护连接的PG环境继承已修正，冻结完整恢复组合独立复验已通过；小资源fixture不等于确切新发布包。后续为兼容/外部身份核对、明确放行及确切包维护链、安装/升级/卸载，实际结果只看功能验收表 |

## 当前实现与验证边界

规划入口（2026-10-03）：[内部文件与 Git 工具循环实施提示词](prompts/agent-native-tools.md)已按用户确认规则交付，覆盖三片开发与独立验收。用户本轮选择只生成提示词，未启动该专项实现，不改变上述模块状态或既有功能成绩。

- 产品 Agent 提示词接入（2026-10-03）：用户明确授权后，公共核心已由 `apps/api/src/workflow/agent-system-prompt.ts` 在现有 Assist/Skill、DRAFT 与原请求解释入口加载，专用输出/权限边界保留，语义检查继续独立。设计与代码职责归[提示词设计](docs/architecture/agent-prompt-design.md)，本轮工程结果归[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)。本项不启用工具循环或跨任务连续授权；当前桌面窗口未重启、冻结包未重建，真实模型质量仍待验，M04–M07 总出口不变。


- root-bound 能力配置入口与基线口径（2026-10-02）：连接与权限页此前只列 4 项 capability，用户无法创建 `FILE_WRITE`/`GIT_READ`/`GIT_WRITE`/`CLI_RUN` 连接，而文件夹入口对话执行正缺这类连接（服务端 409）。已按服务端 `rootBoundCaps` 展示 8 项、root-bound 必填目录、策略除公共读取外必选受管资源，并补真实 PG 集成反例（`run-integration.ps1 -TestFile gateway` 29/29）与前端组件 13/13、全前端 597/597、两端类型检查 exit0。**这只闭合配置入口**：Git/CLI 动作触发仍无公开入口，`prepareGatewayAction` 只接受 `RUN`/`USER_IMPORT`，协作页「Git 变更」「交互终端」继续声明未接入；交互终端协议仍为 Proposed，不在本次范围。范围与限制归[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)“root-bound 能力配置入口”行，规则归[工作台 §14.9](docs/frontend/workbench-design.md#149-开发工作的工具入口)与[工具适配器](docs/architecture/tool-adapters.md)。
- 复跑口径（2026-10-02，本轮核对）：API 单元与集成必须用 `.research/runtime-cache` 里固定的 Node **v24.21.0**，不是 PATH 上的默认 `node`（本机为 v22.22.3）。用默认 node 跑 `npm test` 会因 `verifyBackupPackage` 的 `/^v24\.\d+\.\d+$/` 断言产生 12 例假失败；`content-freeze`/`managed-content-store` 还需 `RELAY_FILE_IO_HELPER` 指向 `apps/desktop/src-tauri/target/debug/relay-file-io-helper.exe`，否则另有 10 例 `CONTENT_IO_FAILED`。两者齐备时当前源码 API 单元 **320/320、0 失败**。集成测试本身已自带固定 Node 与 PG 18（`run-integration.ps1`）。本轮未改 `package.json` 的 `test` 脚本或 helper 解析逻辑，只记录口径。
- 桌面启动截图接续（2026-10-01）：退出23属于单实例检查，截图为已有实例占用；后续检查时占用已释放，历史具体Owner未知。开发入口补前台/后台提前检查和明确失败提示，原生守卫不变；开发API/Node/助手按确切测试包对齐后，已沿原DesktopDev链重新打开本机窗口。当前窗口与用户PG保持运行；守卫回归、资源校对、窗口创建/存活的范围只归[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)。该启动接续不代表新UI原生视觉、正常关窗残留、IME/DPI或安装出口已闭合。
- 连续工作区接续（2026-10-01）：用户授权按 Agent UI 对照计划直接实施，无需追加审批。共享页头、可调分栏及专注模式、摘要优先的聊天/工具轨迹、紧凑成果/判断、阅读版本差异提示与七类页面层级已经接入，模式切换保留原命令 Owner。本设备布局只保存展示偏好；API、数据库、权限和业务协议不变。当前组件回归和只读浏览器空间出口已有通过证据，最终隔离目录测试包、确切身份及剩余限制只看[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)。本轮工具未开放原生窗口控制，不能继承较早 DesktopDev 成绩作为新 UI 的 Windows/IME/DPI 验收；规则归[工作台 §17.6](docs/frontend/workbench-design.md#176-连续协作工作区2026-10-01)，优化包能力门的误判与安全探针依据归[开发记录接续](docs/development/ui-live-integration-2026-09-28.md#连续工作区与优化发布包检查接续)。
- 同日较早阶段（2026-10-01）：用户已选择[工作主线图](docs/frontend/mockups/2026-10-01/work-first.png)，整套共享页壳、协作区与七类业务页面实施基本完成。工作台/项目/待处理/资料为主入口；近期工作去重、按项目分组并保留真实续页，主流程采用紧凑页头与阅读纸面。Task/Session、提议意图、确切 Review 版本、组合草稿保护及原未决命令核对已经接入，旧路由/query 和服务端命令 Owner 保留。随后按用户最大化优先要求补齐[全局控件与交互基线](docs/frontend/design-system.md#62-全局控件与交互实施基线2026-10-01)，修复页面壳裁切、搜索范围文案、表单错误焦点、连接检查输入错配及弹层/页签键盘行为；所涉最大化真实 DesktopDev 样本已复验；用户随后五图反馈中的外扩焦点、相邻控件高度、工具底色、分组悬停及连接摘要开合位移亦已修复并复验，最终隔离前端生产构建已通过。实际成绩和剩余项只归[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)。没有本轮新发布包、真实业务写入或完整 Windows/IME/DPI/安装验收。业务规则见[工作台第 17 节](docs/frontend/workbench-design.md#17-整套-ui-重做提案2026-10-01)，原整套重做取舍及恢复根因见[开发记录](docs/development/ui-live-integration-2026-09-28.md#18-工作主线整套-ui-重做与恢复-owner-保护2026-10-01)。
- 历史阶段（2026-09-29/30）：方向 1“对话主轴 · 双页工作桌”的协作精修与整套视觉纠偏已有当时的浏览器、自动化和目录测试包证据；最后辅助页与面包屑修正后曾重新打包，身份及范围仍绑定旧源。历史结果只看[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)，经过见[协作记录](docs/development/ui-live-integration-2026-09-28.md#13-协作页参考图接续与-review-修复2026-09-30)和[纠偏记录](docs/development/ui-live-integration-2026-09-28.md#16-整套页面视觉纠偏与发布输入冻结2026-09-30)。这些历史包与旧图不自动覆盖本轮工作主线，也未据此推进 M04–M07 总验收。
- 菜单 6 `DesktopDev` 同包已初始化时直接复用开发库，跳过完整清单解析/资源校验；停库自动启动，首次或变包继续校验及必要初始化/备份升级。2026-10-01 隔离启动回归通过；本轮控件复验使用既有 `dev-desktop.ps1 -Action start` 重新打开最大化开发窗口，仅作界面只读与客户端失败校验，启动耗时与完整启动流程未重测；原 Windows 窗口、私有引导/readiness、重复启动与并发 Stop 证据仍绑定 2026-09-30。启动规则归[本机部署](docs/deployment/本机部署.md#持久桌面测试入口)，实际成绩只看[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)，未重打包、刷新 API 或验完整业务。
- 历史接续（2026-09-30 晚）：三工作台的任务/资料目录、确切版本正文与同任务 AI 入口，本设备显示偏好，同页 Task 合并提案及蓝图/Run 状态呈现已接入；Task Skill 重读失败和 Task/产物失权后仍保留草稿与原命令，403 后遇到 503 不恢复旧受限事实。该增量未重打桌面包，当前仍保留其业务能力；知识收录、非空恢复/搜索等完整 33 页面/状态及最新 Windows 取证并未由本轮工作主线视觉样本全部覆盖，Git diff/CLI UI 协议仍缺。结果只在[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)维护。
- Git 只读 UI 与交互终端仍缺协议；PDF 导入、首输出分段统计及 Windows 安装交付仍未完成。本轮真实首预览仅有单次窗口观察，不能推断尾延迟或完整 UI 通过。V1 后续长期协作/N00–N07 属规划，Proposed 不自动成为当前实现授权。

## 下一步与当前授权

方案 2 接续验收与整改（2026-10-03）：用户要求对上一轮已实施的本轮改造做接续验收，先验证、存在差异才改，并补齐真实 API/PG 与 Windows、IME、DPI 验收。**已整改 8 处差异**（详见[验收表 §10](docs/testing/overall-acceptance-2026-09-28.md#10-方案-2-接续验收与整改2026-10-03)）：3 处是共享壳拆分打断的选择器断链，1 处是真实缺陷——`App.tsx` 把桌面标题栏排在 `AppShell` 之前，跳转链接不是第一个 Tab 站位（违反 WCAG 2.4.1），已改由窗口框架持有；2 处是早于现行文档的旧断言（浏览器标题栏、项目摘要栏），按 §17.4 与 §17.9 校准后保留实质检查；1 处是 `run-real-api-browser.ps1` 从不设 `RELAY_FILE_IO_HELPER` 也不构建 API，导致真实 API 验收的产物写入路径根本没被走到，已补齐。**新通过出口**：真实 API/PG 人工闭环（一次性 PG 18.6 + 真实 API + 真实浏览器，创建项目→任务→启动→产物 v1/v2→选用→完成→重开全链通过，`playwright=0 pg_stop=0 temporary_removed=True`）；桌面发布包重建（465s，SHA `3ca3cc62…`）与完整性验证，真实顶层窗口（标题 `Relay Agent`、类 `Tauri Window`、属主 PID 一致、1174×788、**DPI 120**）。浏览器套件由 18 通过/6 失败转为 **24/24**，组件回归 606/607，类型检查与生产构建通过。**仍未验收**：Windows 窗口内渲染观察、原生目录选择、真实中文 IME、DPI 多点对比与内容缩放、关闭重开恢复、安装/升级/卸载，以及 `apps/api` 备份还原注册表的 4 例 `BACKUP_PACKAGE_INVALID`（属 M07 路径，本轮未触碰）。**仍未通过的既有缺陷**：浏览器返回不触发草稿守卫（插桩在 4188 下 4/4 复现草稿静默丢失，4173 下 5/5 通过），R02 用例保留为真实闸门未放宽；另发现 `start-acceptance-session.ps1` 在窗口实际存活时仍报退出码 23 并留下孤立窗口与集群（命中 2 次），本轮只记录未修改。M 阶段与 N 阶段状态不变。

方案 2 全站生产接入（2026-10-02）：用户把 [ui-option-2-pages 提示词](prompts/ui-option-2-pages.md) 作为开发指令下发，要求从现有实现接续，完成共享壳、聊天区和全部 37 个页面/状态单元，并按大模块自检→独立核验→修复复验推进。**已实施**：共享壳拆为图标导航栏（88px）+ 近期工作栏（224px，可拖拽），聊天页头 105→77px 且验收目标转入按需展开、标题成为指向确切任务页的键盘入口，`/projects`、`KnowledgeReader`、`/reviews` 三类样板先行，其余 28 个视图（含 live/fixture 双分支）接入共享 `PageHeader`，`/reviews` 在有可读确切产物版本时改为列表/正文/判断三列。过程中修掉两个真实缺陷：`PageHeader` 原语没有声明标题字号（`h1` 落回浏览器默认 2em，同一原语在不同页面不一致），以及窄窗回落规则未覆盖该原语。交互归[工作台 §17.12](docs/frontend/workbench-design.md#1712-方案-2-全站生产接入2026-10-02)，组件与布局归[设计系统 §9.3.1](docs/frontend/design-system.md#931-方案-2-生产接入2026-10-02)，新增数值只有 `layout.navigation.railWidth`。**未改**路由、查询语义、`data-testid`、命令 Owner、HTTP 契约、数据库、权限与模型策略；**Breaking Change：No**。实际成绩与未覆盖出口只见[功能验收表 §9](docs/testing/overall-acceptance-2026-09-28.md#9-方案-2-全站生产接入2026-10-02)与 §10。

聊天区域效果图接续（2026-10-02）：用户反馈顶部任务信息挤占对话，已选[方案 2](docs/frontend/mockups/2026-10-02/conversation-workspace-selected.png)，随后明确只生成其他页面效果图、不改代码，并要求依据实际功能保留折叠入口。已按当前路由与生产组件生成 37 张页面/状态配套静态图，收录到旧[预览入口](preview.html)的 2026-10-02 分组；清单、生成依据和静态检查边界见[本轮目录](docs/frontend/mockups/2026-10-02/README.md)。适配范围归[工作台 §17.8](docs/frontend/workbench-design.md#178-聊天优先效果图与全站适配范围2026-10-02)，视觉归设计系统 §9.3。交互原型工作已停止；其临时目录清理被自动审批拒绝，未用原型结果更新功能成绩。该轮的「只生成图、不改代码」约束已由上面的生产接入取代。

后续阶段规划接续（2026-10-02/03）：用户要求继续逐题规划 N 阶段；样板、交付优先级及二轮 N04–N06 产品规则归[后续路线](docs/requirements/post-v1-roadmap.md)。隔日接续呈现归[工作台 §15.1](docs/frontend/workbench-design.md#151-隔日打开目录的事实接续卡2026-10-02已确认规划)，本段计划/一次性提醒/有限任务链呈现归[§19–21](docs/frontend/workbench-design.md#19-下一段工作计划n04已确认规划)。已同步规格与实施提示词；工程协议仍待逐片核定，本轮不启动开发或模型外呼，不改变既有并行实施授权、模块状态或验收结论。

文件夹入口接续（2026-10-02）：用户已实际发送[实施提示词](prompts/folder-first-conversation.md)，A、B 两片已实现并自检。**本功能未全部验证**：FC-06/07/09/10 未做，真实 Windows 原生目录选择、取消、重启、中文 IME 与 DPI 完全未验，也没有重建桌面包。

已实现并有证据：Windows 原生选目录命令（`tauri-plugin-dialog 2.7.2` + `select_working_directory`，仅 `cargo check` 通过）；`OpenWorkingDirectory` 命令按规范路径与 Windows 物理身份复用或建立最小 Project 与受管资源，重叠根要求显式选定作用域而不造第二个写 Owner；协作页无任务时可直接打开目录对话，首条发送自动建会话；`InterpretConversationMessage` / `ApplyConversationExecution` 两个命令把明确执行请求经既有 Task/READY/Delegate 入口落成真实 Run，并把 `CLI_RUN` 接进冻结契约与 Gateway 节点，使「真实文件修改 + 一次受控检查」可在同一 Run 内完成。新增迁移 `0051_conversation_execution_requests`（真实 PG 已验证；同号 `0050_n02_impact_candidate_groups` 属并行 Agent，未改动）。

证据与限制只看[功能验收表 §8](docs/testing/overall-acceptance-2026-09-28.md#8-文件夹入口与对话直接执行2026-10-02开发自检)。`collaborationWorkspace.spec.ts` 的 5 例失败在 HEAD 即存在（`collab-facts` 在 Run 需要注意时被折叠），本轮未修复也不据此声称组件全绿。交互主文档为[工作台 §18.4](docs/frontend/workbench-design.md#184-当前实现的交互出口2026-10-02)，应用责任归[领域模型 §12.4](docs/architecture/domain-model.md#124-当前实现的对象与边界2026-10-02)，接口契约归[HTTP 命令契约 §10.53](docs/api/http-command-contract.md#1053-文件夹入口与对话执行请求2026-10-02源码实现)，物理设计归[第 56 节](docs/database/physical-design-postgresql.md#57-0051-m07-文件夹入口与对话执行请求2026-10-02源码实现)。M04–M07 模块状态不变，本入口完成不代表总出口通过。

M 阶段后端接续与本轮已单独授权的整套 UI 重做维持各自分工；不覆盖并行实现、用户配置或密钥，不扩大真实 Provider 外发。下列 UI 事项保持用户选图和既有业务边界。

当前用户优先事项（2026-10-01）：联网研究与工作主线基线盘点后，用户已授权直接实施连续工作区计划。实现、相关回归和七类代表页面的只读浏览器观察已经完成；本次隔离桌面测试包更新及确切来源以功能验收表为准。用户随后指定原聊天验收前端，已补真实DesktopDev最大化/还原代表页面、已有会话草稿保护、分栏和搜索的独立原生复核；范围与未覆盖状态只看[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)“连续工作区真实 Windows 页面独立复核”行。该行两处阅读体验待改已于同日修复：AI 已完成正文改用既有 SafeMarkdown（用户消息与生成中草稿仍纯文本、Skill 输出不重复），资料保存时间与 Run 步骤起止时间改用本设备显示时区的可读值并保留原始 ISO 于 `time.dateTime`，未改 API/数据库/业务 Owner。组件回归 5/5、全前端 76 文件 579/579、类型检查与生产构建 exit0；**原生 Windows 复验未验**，本轮工具未开放原生窗口控制，未以组件成绩替代原生验收，正文换行、滚动、代码块与分栏的原生观感仍待验。中文IME、DPI与完整页面/代表性业务恢复路径继续待验，本次验收未做业务写入。浏览器合成场景不替代这些出口。具体交互归工作台 §17.6 与设置页时区展示范围，研究引用归 Agent UI 研究接续。同日已推送 `619e7c7`（含 M04–M07 并行分片与上述两处修复），推送前后完成远程凭据与隐私审计：**全历史无真实凭据**，两项非凭据隐私文件只存在于历史、当前 HEAD 干净，经用户决定不改写历史，已知项与理由归[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)“远程仓库凭据与隐私审计”行。保持 M01–M07 状态、并行后端分工与真实模型外发边界，不将局部验证作为整体安装交付。

同日较晚：用户以附件反馈「前端实现跟效果图差很多」，授权在现有未提交改动之上做结构对齐，范围只含共享页壳与协作/成果两页，数值继续归唯一 tokens，推广到其余五类页面属下一批。已引入 `PageHeader`/`FactBar`/`JudgmentBar` 三个共享原语；协作页头由 12 个常驻控件收敛为 1 个按钮加「更多操作」浮层（UNKNOWN、控制请求、执行失败强制移回常驻），事实条收回默认收起，成果区恢复文档层级并把截断产物版本 ID 移入依据折叠，成果正文给 `layout.workspace.centerMin` 下限、判断条贴底，侧栏去掉计数行与冗余的「开始一项工作」，输入器恢复单卡。只读同构夹具 1280×720：页头 212→130px、聊天 170→287px、成果正文 44→416px，1487×1058 与效果图同尺寸可直接并排，960/390 无横向溢出，业务 POST 为 0；类型检查与生产构建 exit0。规则归[设计系统 §9.2](docs/frontend/design-system.md#92-共享页级原语2026-10-01)与[工作台 §17.7](docs/frontend/workbench-design.md#177-页头与成果区结构对齐2026-10-01接续-176)，取样与限制归[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)“协作工作区与共享页壳结构对齐”行。**当前全量组件回归为红**：并行进行中的 `relayClient.ts` 把 `usage.cache_read_tokens` 变成必填字段，既有夹具未提供该字段，52 例失败均源于此且不属于本轮 UI 改动；本轮未触碰该文件，也未覆盖其进行中的改动，原生 Windows/IME/DPI 与推广批次均未验。**该红灯已不再复现**：`relayClient.ts` 现用 `nullableOptionalInteger` 把 `usage.cache_read_tokens`/`cache_creation_tokens` 当可选上报字段处理，2026-10-02 全前端 78 文件 597/597；原失败事实与当时归属保留，不改写为当时已通过。

同日再晚：根目录新增未入库的 `preview.html`，是 `docs/frontend/mockups/` 的索引页（7 组 55 张）。逐张比对后发现 2026-09-19 逐页图与 2026-10-01 work-first 是两套字号，用户在「恢复衬线大标题 / 放大字号保留 Sans / 维持紧凑」中选择**放大字号但保留 Sans**，并维持 work-first 的 4 主入口导航、不恢复侧栏品牌。据此只改唯一数值源：`font.size.page` 由 `{font.size.compactPage}`(1.75rem) 放开为 2.5rem，`font.size.section` 1.5→1.75rem，`font.size.display` 保留但页面主标题不再使用；今日/设置/协作页硬编码的 `compactPage` 标题改回 `font.size.page`，窄窗降级收敛到 `styles.css` 唯一一处 `@media (max-width: 40rem)`。**这推翻了 2026-09-28「今日主标题收到 compactPage」的单页特例**，已在[设计系统 §4](docs/frontend/design-system.md#4-字体与排版)写明。示例模式取样：八个普通路由 1280 宽主标题一律 40px、区域标题 28px，390 宽一律 28px，无横向溢出；协作页同步放大后 1280×720 页头 130→145px、聊天 287→272px、成果正文仍 416px，均在 240px 下限之上。取样与限制归[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)“普通页面标题与区域标题字号对齐”行。**六类页面的右栏内容形状仍是下一批**：当前是「标签: 值」定义列表、会露出「验收条件 ID / 请求身份 v1」这类技术身份，逐页图则是大字值的用户语言事实加明确动作，需逐页决定放什么。

注意工作区由并行 agent 共同使用：本轮结构对齐已被对方以 `7182f01` 提交，而其后我在做的字号改动一度被清空并需重做；`a4409b1` 已把 `cache_read_tokens` 必填化入库但未同步 8 个 spec 夹具，导致全仓 52 例红。后续动手前需确认对方是否仍在写同一批文件，提交前先核对 `git status`。

1. 用户已授权继续M阶段、关闭占锁开发窗口，要求列出用户参与事项后继续可独立工作。M04读取委托与三Skill的修复包定向链已推进，后续能力/质量及真实服务故障按工作包闭合；历史输出拒绝字段没有原正文可恢复，不宣称已定位。当前M07准入、原宿主停机、内容发布安全点及数据库连接维护/原ACL恢复分片已实现并分别验证。备份CLI已按[部署边界](docs/deployment/本机部署.md#4-备份恢复)组合实现，最终身份窗口修正及独立复验已闭合；隔离还原已组合目标专用CONNECT生命周期、刷盘启动标记、完整归档还原和只读核对，组合自检及独立复验已闭合，业务只读维护核对冻结源码独立完整组合已通过；其余已复现的维护连接PG环境继承已修正，原源fence显式TLS/options保留；新冻结范围的完整恢复独立复验已通过；目标包离线依赖加载与内存调用核对的冻结源码有限出口已通过独立单元及真实PG函数/CLI组合复验；受管资源根身份有限只读观察已实现，相关Windows单元22/22及完整PG组合8/8自检通过；独立审查和验收待指定gpt-6.1-sol恢复后补齐，再推进依赖此片的完整兼容/明确放行、确切新包维护链及安装。DRAINING、当前登录会话guard、数据库连接门或pg_dump均不能单独证明完整备份；不重做已通过功能、不覆盖并行UI、不扩大真实模型外发。原生模型工具调用仍主动拒绝，不称已接入执行。
2. 接续开发时先核对当前源码和已有通过分片，不重做已通过功能；按用户下一项范围补最新 UI/Windows、真实 Provider 故障与首输出、M06/M07 剩余出口。默认大模块自检、独立验收、修复复验后推进，已获授权的并行开发或验收后置保持原边界。
3. 读取[文档地图](docs/README.md)、[契约](contracts/README.md)、[大模块工作包](prompts/stack-migration.md)和[测试规格](docs/testing/verification-plan.md)中与本次任务相关的部分；仅为定位具体失败展开历史或日志，不扫描全部证据。

独立验收限制（2026-10-01）：gpt-6.1-sol返回当前ChatGPT账号不支持；用户已明确选择保持指定模型、等待恢复，不切换模型。主代理继续后端开发、自检与文档同步，本轮资源根身份分片的独立审查/验收留待补齐，不以主代理自检替代，也不提前推进依赖该出口的模块。

用户参与事项：目前没有阻塞上述可独立开发的必做操作。**两项最短具体确认**：(1) 打开任意 Run 的轨迹面板，确认不再 500——2026-09-30 起迁移到 0051 的库/代码不一致已修，但 bearer token 只存在于宿主内存，本轮无法从外部复验桌面实例；(2) 手工跑 `npm test` 前先切到 `.research/runtime-cache/node-v24.21.0-win-x64/node.exe` 并设 `RELAY_FILE_IO_HELPER=apps/desktop/src-tauri/target/debug/relay-file-io-helper.exe`，否则会看到 22 例与代码无关的失败。其余：新包准备完成后请人工确认协作/审批/取消、回复质量及中文输入/界面体验；可选准备第二台未安装 Relay 的 Windows 或干净虚拟机，用于 M07 安装/升级/卸载；如果已有能安全稳定制造限流/断流的 Provider 测试环境，可用于真实服务故障验收，当前不要求购买或提供新密钥。准备完成和实际参与记录再更新此入口，不把待人工确认算已通过。 **F24 追加一项（2026-10-02）**：(3) 四项 Skill 的**质量评分标准、重复次数与预算**需要在跑之前由你确认冻结——目前只有契约合规性（严格 schema、来源冻结、显式接受、无副作用）有证据，语义质量与可读性没有任何评分；不冻结就继续不出质量结论。(4) 蓝图链的真实 Windows 验收需要先重建确切发布包并跑 `apps/desktop/tests/m04-real-model-webview.mjs`；本轮**未重建**（桌面 `lib.rs`/`Cargo.toml` 正被并行修改，重建会产生与你现有安装不一致的身份），需要你确认何时冻结桌面源码再打包。

2026-10-01 接续交接：新空库产品restore已实现，最终相关单元与完整独立组合已通过，范围绑定功能验收表中的冻结源码。目标专用生命周期在撤销COMMIT后成功/失败/取消都保持CONNECT隔离；COMMIT前预检失败保留目标原ACL，不复用源fence的release。新根发布前刷盘marker，原/目标包分别核对，完整单事务还原及原状态/正文核对不消费旧Job、重发UNKNOWN或切换用户配置。真实反例修正了本机CIDR地址、系统schema用户对象空库漏检及原data_root内嵌目标错误成功；新根创建和权限变化前，以已核目标包助手只读比较原content_root_id与现存祖先，覆盖同卷搬迁，不放宽硬链接拒绝。独立审查修正准入字段投影与末段metadata路径检查。pg_restore前导SQL重置超时初值，取消后backend可能继续等待锁，保持隔离、不宣称静止，由受信运维核对处理。业务只读restore-check及非空目标专用会话、严格材料解码和CLI已实现，冻结源码已通过独立完整组合（未授激活）；受控状态reader的PG环境继承反例已修复，实际成绩与当前独立范围只看功能验收表，前端不在本线程改动范围。读取既有target-acl凭据，专用重持非空隔离目标，只锁/核对不写ACL或准入；核对本地恢复材料、当前状态投影/清单字节及确切包，现有内容冻结可能首次创建sentinel，必须如实说明。报告仅证明本次范围匹配，全部历史执行/目标依赖可调用性、外部资源live身份、配置选择/唯一Owner仍待核对，不授激活权；不把旧报告当未来放行依据。随后闭合明确激活、确切新包与安装矩阵；目标evidence/restore元数据须纳入后续维护生命周期，不复制为活动ARMED。选择及代价见[ADR-014接续](docs/decisions/ADR-014-database-maintenance-admission.md#2026-10-01-接续实现隔离还原不自动激活)，根因和Owner见[M07开发记录](docs/development/m07-backup-recovery.md#新空库隔离还原与只读核对)，命令/限制归部署说明，成绩仅归功能验收表。本轮没有Provider外呼或完整新发布包/安装验收。占锁开发窗口已按原授权处理，实际关闭方式和未定位的正常关窗问题只看功能验收表，未停止用户PG。工作区外旧编译误输出清理因自动审批拒绝仍暂留 `D:\output\acceptance-raw\m07-admission-unit-independent-dist`，不影响本轮正确工作区编译或临时PG清理。

本轮独立编译暂留：`apps/api/dist/m07-restore-isolation-independent-9ea0dee2-4ee1-482d-a483-5d916a919053`。递归清理及随后经逐项路径/文件类型核对的非递归清理均被自动审批拒绝，仅返回 `blocked by policy`，已停止删除；309源码输入SHA与独立成绩不受影响。该目录只含本轮独占编译输出，不作为正式dist/src或发布包输入。

PG还原分片的两处本轮独占输出亦暂留：`output/acceptance-raw/m07-20261001-restore-postgres-worker-dist` 与 `apps/api/output/acceptance-raw/m07-20261001-restore-postgres-worker-dist`，各313个纯JS输出、已核对在工作区内且无reparse；自动审批拒绝递归删除，仅返回 `blocked by policy`，已停止、不重试。临时PG清理与源码不受影响，后续独立编译采用内存emit逐字核对，不新增dist目录。

文档维护与输出保留见[规则](docs/README.md#6-验收结果与原始输出保留)。所有日期块、原包身份和旧阶段经过可在历史快照及各专题记录恢复；这些记录不替代当前模块状态。
