# UI 精修与真实前后端联通（2026-09-28，开发自检）

状态：开发自检完成，未经协调侧独立验收。本轮由 `prompts/ui-live-integration-polish.md` 授权，包含 UI 精修、真实数据来源核查与 Tauri dev 开发链路；同日接续第 10 节"今日页截图专项整改"。M03–M07 模块门槛与真实 Provider 门槛不变。

## 1. 用户可用的启动入口（本轮结论）

| 入口 | 命令 | 说明 |
|---|---|---|
| 桌面测试包（日常使用） | `dev-stack.bat Build` → `dev-stack.bat Start` | 真实窗口 + 随包 API/Worker + 专用测试库；本轮重建的包包含全部前端、API 与 Rust 改动 |
| 桌面开发窗口（改前端代码时） | `powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop\scripts\dev-desktop.ps1` | 真实 Tauri 窗口加载 Vite 开发服务器：前端改动经 HMR 数秒内生效，Rust 改动由 `tauri dev` 自动重编译并重启窗口；不生成安装包 |
| 浏览器预览 | `dev-stack.bat Preview` | 需修复后的 `scripts/dev-stack.ps1`；默认示例数据，连接对话框填 API 地址 + Workspace + Bearer 后进入 live，刷新即回示例（凭据只存内存，属设计约束） |

`dev-desktop.ps1` 说明：资源从 `src-tauri\resources\`（由 `dev-stack.bat Build` 维护）暂存到 dev Resource 目录；配置默认优先 `.relay-test\desktop.env`，可用 `-ConfigPath` 指定；与打包版共用单实例互斥，二者不可同时运行；`-RefreshApi` 重建并重新暂存 apps/api。`tauri dev` 会监听 `src-tauri` 源码变化自动重启应用。

## 2. "像是在看模拟数据"的根因

1. **`scripts/dev-stack.ps1` 文件头存在双重 UTF-8 BOM**，Windows PowerShell 5.1 解析失败，`dev-stack.bat Preview` 一执行就报解析错误——标准浏览器预览入口当时完全不可用。已修复为单 BOM（其余 .ps1 扫描无同类问题）。
2. **浏览器预览凭据只存内存**：刷新或直接 `goto` 都会回到示例模式；页面顶栏有「示例数据 / 已连接本机 API」状态（本轮加了状态圆点），行为本身是安全设计，未改动。
3. **`apps/api/.env` 指向的 `127.0.0.1:5432/relay_dev` 在本机不存在**（无 PostgreSQL 服务、无监听），Preview 能启动 API 但 `/health/ready` 503 `DATABASE_UNAVAILABLE`，live 连接必然失败。本轮验证使用一次性隔离集群；用户日常路径应使用 `dev-stack.bat Start`（专用测试库）或修正 `.env` 指向已初始化的库。此为环境事实，未改 `.env`。
4. **桌面 dev 链路缺失**：此前只有"完整打包→运行"一条路，改界面也要重打包。本轮打通 `tauri dev`（见下节），消除"改界面必须打包"的成本。

## 3. Tauri dev 桌面链路（新增，最小改动）

打包产物行为不变；全部改动为 additive 或 `tauri::is_dev()` 门控：

- `tauri.conf.json`：`build` 增加 `devUrl: http://127.0.0.1:5173`（`frontendDist` 不变，`tauri build --no-bundle` 流程不受影响）。
- `src-tauri/src/lib.rs`：新增 `DEV_ORIGIN` 常量、`frontend_origin()`、`is_dev_frontend_origin()`、`is_allowed_frontend_navigation()`；窗口导航守卫与 `desktop_bootstrap` 的来源核对在 dev 构建放行 `127.0.0.1:5173`，打包构建仍只放行 `http://tauri.localhost`。`start_api` 仅在 dev 构建向 API 子进程注入 `RELAY_DESKTOP_EXTRA_ORIGIN`。
- `apps/api/src/main.ts`：desktop-child 的允许来源在存在 `RELAY_DESKTOP_EXTRA_ORIGIN` 时做 additive 合并；打包产物仍为 `http://tauri.localhost` 单一来源（Breaking Change: No）。
- `capabilities/default.json`：增加 `remote.urls = [http://127.0.0.1:5173]`，否则 dev 来源没有 IPC 权限；打包窗口的导航守卫会拦截该来源，不构成打包面扩大。
- `apps/desktop/scripts/dev-desktop.ps1`（新增）与 `apps/desktop/.gitignore`（新增 dev 暂存路径忽略）。

已验证（真实 dev 窗口，CDP 与窗口截图）：dev 窗口加载 Vite 前端并通过 `desktop_bootstrap` 进入 live（返回私有端口/workspace/内存令牌）；修改 TSX 文案 4 秒内在窗口内生效（HMR）；修改 `lib.rs` 后 `tauri dev` 自动重编译（约 7–30 秒）并重启窗口，重连正常。诊断中发现并修复的顺序：导航守卫 → capabilities remote → bootstrap 来源检查 → API CORS origin，每步以 CDP 页面内执行确认。

## 4. 真实业务闭环与逐页核查

- 既有 `apps/workbench/tests/browser/real-api.spec.ts`（`apps/workbench/scripts/run-real-api-browser.ps1` 自建一次性 PG18 + 真实 API）：**PASSED**——创建项目→创建任务→开始→保存 v1/v2 产物→选用→按固定版本完成→重开→刷新后历史/选用/接受指针一致，临时集群已清理。
- 另在隔离集群上通过真实 UI 完成同一闭环（项目 `61c07020…`、任务 `18abeaf5…`），全程无页面错误、无 4xx/5xx；随后逐页截图核对（今日/项目/任务/收件箱/知识/动态/待审/连接/创建表单/项目详情/任务详情）。
- 空库空态：`/projects`、`/today` 在空库显示真实空态与创建入口，无样例数据填充。

### 覆盖表（实际路由为核查基准）

| 页面/入口 | 数据来源 | 本轮处理 | 结果 |
|---|---|---|---|
| `/today` | live `GET /today` | 标题改为中文 display 层级（日期眉线 +「把今天留给重要的事」）、查询行紧凑化、今日焦点卡显示任务标题、延后/计划表单收进 details、状态徽标弱化 | 截图+测试 8/8 |
| `/projects`（空/有数据） | live 分页列表 | 视觉核对，未改业务 | 截图 |
| `/projects?view=create` | live CreateProject | 视觉核对 | 截图 |
| `/tasks`、`/tasks?view=create`、`/tasks?tab=inbox` | live 列表/创建/收件箱 | 测试集成修复（interventions 端点） | 测试 |
| `/tasks/:id`（任务详情） | live Task/产物/Run | eyebrow「真实任务」→「任务」、「三个独立事实」→「当前状态」、验收依据面板标题/说明人话化、预期产物 chips、CheckPlan hash 用 `hash-code` 样式 | 截图+测试 |
| `/activity` | live Activity | 中文标题「动态」、本地时间、事件类型中文映射、工程 ID 收进「追溯详情」details | 截图+测试 |
| `/artifact-versions/:id/lineage` | live Lineage | 英文 H1 →「来源追溯」，说明文案更新 | 测试 |
| `/knowledge`、`/reviews`、`/connections`、`/today`（fixture） | fixture/live | 视觉核对，未改业务 | 截图 |
| 顶栏数据来源按钮 | 内存连接状态 | 增加 live/示例状态圆点（文字仍为主要指示） | 截图 |
| 桌面标题栏 | Tauri IPC | dev 窗口下可用性随本轮链路验证 | 窗口截图 |

## 5. 视觉精修依据

对照 `docs/frontend/mockups/2026-09-28/`（操作型标题栏 v2）、原始锚点图与 `2026-09-19` 参考集。数值只消费现有 `design-tokens.json`（新增 `hash-code`、`expected-output-chip`、状态圆点等局部样式均引用既有 token，未新增数值源）。文案原则：契约语义保留在界面（资格/修订/回执核对），但改用用户语言表达，且不弱化「不能据此宣称通过」类诚实提示。

## 6. 测试与构建证据

- workbench：`tsc --noEmit` 通过；vitest 全量 **53 文件 312/312 通过**（含本轮更新的 todayView/navigation/taskDetail/activityView/artifactLineage 及 5 个 live 列表 spec 的 interventions 集成修复）；`vite build` 生产构建通过。
- api：`tsc --noEmit` 通过；单元测试 **126/126**；真实 PG 闭环由上述浏览器脚本覆盖（一次性集群）。
- 桌面：`tauri dev` 增量编译与窗口运行通过；`dev-stack.bat Build` 重建 release 包两轮。第一轮包 EXE SHA-256 `a6d9ca9118bbe73a2cfa4fd52a924b07ac770725e51b196d732ad1b841a80e51` 的打包窗口实测暴露本轮引入的回归——`desktop_bootstrap` 来源检查把 `username().is_empty()` 误写为非空才放行，打包窗口全部进入「本机服务不可用」；修复后第二轮包 EXE SHA-256 `3fc13ec03704d83b6666240a01f4deb9e941f722074bba2abea3a11e56755a3b`（17,166 项资源清单核验、0 违禁配置文件）经 `dev-stack.bat Start` 与直接 EXE 启动实测：CDP 确认 `desktop_bootstrap` 返回真实私有连接（试用 Workspace），窗口显示 live 项目页真实空态（[截图](../testing/evidence/ui-live-integration-2026-09-28/test-release-window-live.png)）。该回归仅存在于本轮第一轮打包产物，未进入任何此前已交付包。
- `node scripts/check-docs.mjs` 通过。

## 7. 关键截图证据

| 证据 | 文件 |
|---|---|
| 今日页 fixture 基线（精修前） | [today-fixture-before.png](../testing/evidence/ui-live-integration-2026-09-28/today-fixture-before.png) |
| 今日页 live（精修后，隔离集群真实数据） | [today-live-after.png](../testing/evidence/ui-live-integration-2026-09-28/today-live-after.png) |
| 动态页 live（精修后） | [activity-live-after.png](../testing/evidence/ui-live-integration-2026-09-28/activity-live-after.png) |
| 任务详情 live（精修后） | [task-detail-live-after.png](../testing/evidence/ui-live-integration-2026-09-28/task-detail-live-after.png) |
| tauri dev 真实桌面窗口 live | [tauri-dev-window-live.png](../testing/evidence/ui-live-integration-2026-09-28/tauri-dev-window-live.png) |

## 8. 模型端口只读状态页（用户确认"只读状态页"方案后接续）

用户指出没有模型配置页面。现状与边界：模型配置只存在于服务实例环境变量（`RELAY_MODEL_PROVIDER` 等，`apps/api/src/workflow/model-port-config.ts` 读取），桌面 `desktop.env` 白名单刻意不含模型键，因此桌面包固定使用 Mock 模型端口；密钥不入库/不入 UI 是既有安全边界。经用户逐项选择确认，本轮实现**只读状态页**，不做可编辑配置：

- API：`GET /api/v1/workspaces/{workspace_id}/model-port` 返回 `{provider: fake|openai-compatible|invalid, configured, model, base_url}`；`describeModelPortStatus` 保证密钥与超时/预算等配置不进入响应，`base_url` 已由端点策略约束为无凭据的公网 https 地址。见 [HTTP 契约 §10.49](../api/http-command-contract.md#1049-模型端口只读状态2026-09-28开发自检)。
- 前端：`/settings` 从占位页改为真实 `SettingsView`（侧栏「设置」入口此前落到范围外占位，属既有缺口）；第一卡显示模型端口状态，Mock 状态明确标注"既定门槛，不是故障"；原 Pack 固定清单与连接入口保留；示例模式不伪造实例状态。
- 测试：API 单测 4/4（含密钥不出现在序列化结果）、真实 PG/HTTP 集成 2/2（`run-integration.ps1 -TestFile model-port`，含 401/422 边界）；workbench 组件测试新增 4 项（含"服务端泄漏 api_key 字段时前端也不渲染"反例），全量 54 文件 316/316；`vite build` 通过。

## 9. 边界与未验证项

- 未验证：真实模型 Provider（门槛未开）、安装/升级/卸载（M07）、Windows 100%/125%/150% 缩放的实测矩阵、屏幕阅读器与输入法实测、`/settings` 等未接线入口、知识阅读窗口的桌面人工交互。
- `dev-desktop.ps1` 的 Rust 监听重启验证基于两轮实际 lib.rs 修改；更复杂的 Rust 改动（如新增命令）未逐一验证。
- 独立验收未做；本轮全部结论为开发自检，不改变 M03–M07 出口状态。

## 10. 今日页截图专项整改（2026-09-28 接续，开发自检）

用户看过运行截图仍认为粗糙，按[专项提示词](../../prompts/ui-live-integration-polish.md)第 4 节执行逐项整改，先今日页后共性推广。**本节全部结论为开发自检，不是独立验收。**

### 10.1 基准与量化（整改前）

以隔离一次性环境（便携 PG + 真实 API + Vite，Playwright 1280×800/DPR1）建立同条件基线，量化确认：主标题 56px（display 3.5rem）且首屏占据 70px 行盒；三个零数量分组各带 24px 宋体标题与整行"当前查询中没有此类任务"；日期输入为**完全未样式化的原生控件**（computed：`monospace 13.3px`、`2px inset` 边框、高 21px），时区输入同；"任务能否开始、如何排序由服务端……"工程长句位于标题下第二视觉位；今日焦点为左右两端分离的宽面板；live 模式右上连接按钮与右下固定"已连接本机 API · 写入真实 PostgreSQL"重复。用户截图中的"标题上沿被裁"在 scrollY=0 首屏**未复现**（h1.top=125px，顶栏底=64px，完整可见），判定为滚动状态；已核对路由返回（App 已有 `scrollTo(0,0)`）并补 `scroll-padding-top` 修复锚点/焦点滚入被 sticky 顶栏遮挡的场景。基线截图与指标见[专项证据 before/](../testing/evidence/ui-live-integration-2026-09-28/today-polish/before/)（含 metrics.json）。

### 10.2 修改内容（T01–T10 对应）

- 代码：`apps/workbench/src/views/TodayView.tsx`（渲染结构、文案、项目标题单读、时区编辑行、全空态、资格文案按真实状态区分）、`TodayView.css`（重写）、`src/styles.css`（控件字体/几何继承、scroll-padding）、`src/components/AppShell.tsx`（live 不再渲染底部连接文字）、`src/App.tsx`（桌面时挂 `app-desktop` 类）、`tests/todayView.spec.ts`、`tests/commandPalette.spec.ts`、`tests/navigation.spec.ts`（文案与选择器同步）。文案仅改展示语言，API 字段/命令/状态枚举不变；置顶/延后/今日焦点对应 pin/later/focus 原命令。
- 交互与状态：焦点未选/已选/失效三态、置顶往返、延后展示、非法时区就地报错且不覆盖已生效时区、刷新反馈、全空单一空态（新建任务/查看全部任务真实入口）、零分组收敛、提交结果待核对与回执核对保留、首次加载显示"正在读取…"且不显示 0 个任务。
- 排版角色：今日主标题 display→`compactPage`（design-system 第 4 节角色规则同步修改）。

### 10.3 标准开发环境直启（响应用户"不要写到 temp，直接在开发环境启动前后端"）

初始化本机标准开发数据库 `/.relay-dev/`（不入 Git，`.gitignore` 已加）：便携 PG18 监听 127.0.0.1:5432、`relay_dev` 库、42 条迁移、Graph、两个工作空间（`11111111…` 混合测试数据、`22222222…` 空态验证）。`apps/api/.env` 无需修改即可直连。实测：`dev-stack.bat Preview -SmokeSeconds 30 -SkipBuild` 标准入口启动/自检/停止全链通过（API ready 200）；日常验证用 `sleep infinity | node --env-file=.env dist/src/main.js` + Vite 5173。README 开发节已补充该环境与启动/停止命令。测试数据通过真实 API 领域入口持久化（seed 脚本 `apps/workbench/scripts/ui-polish-seed.mjs`），仅为测试数据，不冒充真实工作记录。

### 10.4 整改后证据（同条件）

证据目录 [today-polish/](../testing/evidence/ui-live-integration-2026-09-28/today-polish/)：`before/`、`before-mixed/`（整改前同条件基线），`after/`（空态工作空间）、`after-mixed/`（混合任务工作空间）、`pages/`（项目/任务/收件箱/知识/动态/待审/连接/设置/创建表单 live 逐页）、`desktop-dev-window.png`（tauri dev 真实窗口）、各目录 metrics.json（computed style 量化）与 interactions.json（交互结果）。

- 量化对比（first-entry-1280，空态）：h1 56px→32px；日期输入 `monospace 13.3px/21px`→YaHei UI/40px 统一控件；文档高 857→800（首屏无滚动）；零分组 DOM 消失；live 底部重复提示消失（demo-notice 仅剩示例模式）。
- 交互回执（真实 API）：设为今日焦点→`SetFocusSelection` 回执核对→焦点卡显示任务名与真实项目标题；清除焦点恢复；置顶/取消置顶往返经 `SetTaskSelection`；非法时区（Not/AZone）就地报错且已生效时区不变；路由离开返回 scrollY=0 且标题完整；空态"新建任务"导航至真实 `/tasks?view=create` 表单。全绿（interactions.json）。
- 页面扫描（共享规则影响面）：10 个 live 页面截图，原生字体（monospace/times）命中 0，示例模式底部标识保留、live 模式无重复连接文字。

### 10.5 检查与构建

- workbench `tsc --noEmit` 通过；vitest 全量通过（含 todayView 8 项与文案同步更新后的 navigation/commandPalette）；`vite build` 通过；`node scripts/check-docs.mjs` 通过。
- 桌面：`dev-desktop.ps1` 真实窗口实测本轮前端（HMR 生效），PrintWindow 截图核对标题栏/侧栏/live 页面渲染。
- 未做：重新打包 release EXE 的桌面验收（本轮改动未经 `dev-stack.bat Build` 出包）、100%/125%/150% 系统缩放矩阵、屏幕阅读器/IME 实测。今日页以外的页面仅做共享层视觉扫描，未逐页深修。

### 10.6 控件观感校正（用户反馈"白色输入框按钮突兀"接续）

用户在真实桌面窗口核查任务页时问"白色输入框按钮是没加 CSS 还是开发完就这样"。核对结论：**这些控件一直有样式，白色来自既有 token**（`color.palette.surface=#FFFFFF` 叠在暖纸 `#FAF8F3` 画布上）；但对照效果图（knowledge-capture-review、thesis-review-window-v2）确认两处真实偏差——效果图输入/次级按钮为**浅暖细边 + 约 8px 圆角**，而实现用的 `color.palette.control=#858A80`（灰绿中灰）边框偏重、`radius.control/panel=0.25rem` 偏方。校正：`color.palette.control` → `#8E8A80`（暖灰，仍满足 contrastChecks 对画布/表面 ≥3:1 的既有检查，check-docs 实测通过）、`radius.control/panel` → `0.5rem`。仅改 token 值，不改语义结构；10 个 live 页面复扫无回归（[pages/](../testing/evidence/ui-live-integration-2026-09-28/today-polish/pages/)，校正前对照 [pages-before-control-soften/](../testing/evidence/ui-live-integration-2026-09-28/today-polish/pages-before-control-soften/)），真实桌面窗口经 HMR 复核（desktop-dev-window-softened.png），定向组件测试 18/18。另注：用户截图的任务页为空是 dev-desktop 配置连的 `.relay-test` 测试工作空间本身无任务，不是数据缺失。

## 11. 独立 Agent 聊天验收（2026-09-29）

用户指定侧栏独立聊天入口，并提供 Codex 截图作为布局参考。本轮由协调 Agent 独立验证，初验不通过后退回修复；最终结果见本节后续复验记录。证据目录：[agent-audit](../../output/playwright/agent-audit/)。验收数据通过 API / UI 写入专用测试项目；不是用户工作结果。

### 11.1 初验发现

- 视觉：1440×900 的输入框 top=1015.5px，1280×800 同样在首屏之外；960×640 top=1284.48px。主区叠加大标题、会话表单、资料卡，未形成参考图的消息区与常驻输入区。
- 窄窗：390×844 下 documentWidth=422，存在横向溢出。
- 草稿：切换会话直接卸载旧面板，未发送草稿变为空，缺少保护。
- 桌面运行：真实 WebView2 新建会话后发送，超过 30 秒仍为 PENDING。代码核对发现 Supervisor 仅扫描 Run 分发队列并启动 `worker --once`，而该模式明确跳过 Assist tick；不是把轮询超时推定为模型故障。
- 模型设置：真实页面能显示 Mock / 未配置 / Worker 未探测状态；仍为只读，不具备编辑保存 Provider、模型、端点、密钥的功能。本轮未擅自扩大配置写入范围。

### 11.2 已执行的独立验证

- 浏览器连接现有开发 API：发送持久化 PENDING → 取消持久化 CANCELLED → 刷新页面、重新连接后历史仍存在；没有 pageerror。证据 `functional.json`。
- 响应丢失：测试代理先让 POST 在真实 API 提交，再丢弃响应；UI 查询原 command_id 回执成功，核对身份后恢复。GET 断线显示错误，重读恢复。证据 `recovery.json`。失败脚本遗留的专用测试 PENDING 已通过取消入口清理。
- 隔离 PostgreSQL：Assist 集成 29/29、实时预览集成 6/6；包含生成、取消、失败、租约丢失、提案约束和事务回滚，不代表真实 Provider 调用。
- 设置页组件测试 10/10；真实页面截图 `settings.png`。
- 桌面基线：Windows WebView2 开发宿主 SHA-256 `6466253bccf811500b87cbd12ffcec7727bcada73ee35dcbf313793eb86d9756`，加载 Vite 当前前端，独立 PG / Mock。验收脚本先用旧 release 迁移，缺少 0040–0043；补齐当前迁移后宿主启动成功。此过程不更新发布包，不替代安装升级验收。

### 11.3 修复后的独立复验

- 页面按 Codex 参考的会话列表 / 消息 / 输入区分工收紧；去除独立页重复会话选择，资料与发送选项折叠。修正全局样式优先级、Grid 的 start 对齐和 Outlet 包装层高度，避免内容把视口撑开；短窗口仍保留至少 96px 可滚动消息区。展开资料/发送选项后可滚动到操作区。
- 浏览器四尺寸均无横向溢出且输入/发送在首屏：1440×900 消息区 435px、1280×800 为 335px、960×640 为 96px、390×844 为 283px。见 `after.json`、`after-*.png`；这是浏览器视口尺寸，不是系统 DPI 矩阵。
- 未发送内容的切会话、新建、路由离开提示、Esc 保留、明确丢弃均实测通过。未确认命令内部切换被阻止；外部路由离开后回来仍可查询同一 command_id，sessionStorage 不存消息正文，见 `navigation-recovery.json`。资料展开、选项选择和 Tab 到取消按钮有真实 DOM 验证，未据此宣称屏幕阅读器验收。
- 长消息区首次显示末尾，本人发送后跟随新消息；上翻到历史后刷新保持 scrollTop=0，见 `scroll.json`。无页面脚本异常。
- 桌面 Supervisor 改为分别派发一次 Run 和一次 Assist 子 Worker；宿主中断不伪造用户取消，失联领取按原身份收敛。实现细节和自检见 [Run 分发记录](m03-run-dispatch-slice.md)。协调侧独立重跑 `run-dispatch` 27/27 通过，PG 迁移/Graph/启停/清理通过，见 `dispatch-integration.log`。
- 修复后的 5 个编译运行文件复制到验收用 debug 资源，确切 SHA-256 见 `desktop-runtime-hashes.json`（不以 EXE 哈希单独代表完整资源）。真实 WebView2 + 独立 PG + Mock Worker：UI 新建 Project、选择目标、新建会话、发送后自动生成 COMPLETED，零 pageerror；见 `desktop-functional.json`。当前 Windows 125% / WebView DPR=1.25，CSS 视口 1160×780，消息区 224px、末尾差值 0、发送按钮 bottom=719.2px，见 `desktop-final.png`。
- 前端全量组件 60 文件 353/353；最后滚动修正后定向 5 文件 22/22、生产构建通过。构建仍有既有大 chunk / Tauri 动静态混合 import 提示，不作为本轮功能失败或性能回归证据。文档检查通过。

**本轮结论：独立聊天开发版在上述浏览器 / Windows WebView2 / Mock 范围通过。** 模型配置编辑仍未实现；真实 Provider 对话、本轮修改后的发布包、安装升级卸载、其它系统 DPI、真实中文 IME 和屏幕阅读器没有在本轮验证。没有把开发宿主或 Mock 通过扩大为完整发布验收。

文档影响检查：更新交互规则、当前进度与已有开发记录；本轮没有新增 HTTP API、数据库迁移、领域权限或框架依赖，不另建重复 ADR / API / 数据库规格。
- 补充：延迟首次会话列表响应后先打开新建选择器，响应返回不会抢占新建界面，见 `list-race.json`。验收结束已通过真实窗口关闭按钮退出宿主，随后按会话标记停止并移除隔离 PostgreSQL 临时目录；标准开发服务保留。
