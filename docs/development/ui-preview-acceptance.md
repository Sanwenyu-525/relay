# 前端交互预览实施与验收

本文件是 `apps/workbench/` 前端交互预览**实现与验收状态的唯一主文档**，按批次追加记录。状态：已有可运行前端预览；2026-09-21 已完成 FE-01–04 fixture 修复、R03 接入前契约对齐、R04 视觉/文案复验、真实 API 最小闭环（第 9 节）与 UI-10/UI-11 的产物与完成/重开（第 10 节），默认仍是 fixture。生产 API 全覆盖、数据库业务验收、真实 AI 与 Windows 安装交付不在前端预览验收范围内。

| 批次 | 范围 | 提示词/依据 |
|---|---|---|
| 批次一（2026-09-20） | UI-30–33 四项 Skill 与共享页壳 | [四页提示词](../../prompts/ui-first-four-terra.md) |
| 批次二（2026-09-21） | UI-05/06/07/09/29 项目与任务列表、创建流程 | [页面开发提示词](../frontend/page-development-prompts.md) 公共约束与逐页块 |
| 批次三（2026-09-21） | UI-06/09/29 真实 API 接入（连接面板、创建项目、创建任务、读取与开始任务） | [P04 提示词](../../prompts/A-human-core.md#p04基础前端工作台) 与 [R03 对齐](ui-preview-acceptance.md#7-r03接入前契约与能力对齐)；证据见第 9 节 |
| 批次四（2026-09-21） | UI-10 任务详情、UI-11 产物编辑与完成/重开（真实 API 完整人工路径） | [P04 提示词](../../prompts/A-human-core.md#p04基础前端工作台)、[UI-10/UI-11 页面提示词](../frontend/page-development-prompts.md)；证据见第 10 节 |

视觉目标为[图像目录](../frontend/mockups/2026-09-19/README.md)；业务语义以[工作台交互](../frontend/workbench-design.md)、[设计系统](../frontend/design-system.md)与契约为准，token 数值只在 [design-tokens.json](../frontend/design-tokens.json) 维护。

## 1. 批次一：UI-30–33 四项 Skill

实施输入以[四页提示词](../../prompts/ui-first-four-terra.md)为准。交付项目蓝图预览、完善任务定义、生成验收方案、继续这个项目及共享页壳。

已核对范围：蓝图修改后形成新候选、拒绝保留项目、后续配置不随之生效；任务定义接受不开始或委托；验收方案缺少必需检查器时阻止应用；恢复摘要只读且来源可打开；局部页签与路由离开共用草稿守卫；浮层不叠加、Esc 与焦点回落；来源按 `id` 打开且标题内容一致。

三处与提示词不同的实现选择：局部状态用 `skill` 查询参数配合页内链接触发 `router.push`（`onBeforeRouteLeave` 不覆盖同记录查询变化，故另设草稿守卫）；fixture 提供 `?fixtureLatency` 与 `checkers-registered` 测试入口，后者只用于区分“缺少检查器”和“人工检查未完成”，应用按钮在任何模式下都保持禁用；任务定义接受不自动更新 CheckPlan 的 `taskRevision`，改为在验收页显示“基线已过期”。

## 2. 批次二：项目与任务列表、创建流程

范围：UI-05 项目列表、UI-06 创建项目、UI-07 全部任务、UI-09 项目任务、UI-29 新建任务与执行准备。

### 2.1 路由与上下文

| 页面 | 路由 | 说明 |
|---|---|---|
| UI-05 项目列表 | `/projects` | 进行中/已归档用 `?archived=1` 表达 |
| UI-06 创建项目 | `/projects?view=create` | 复用同一路由，不新增注册 |
| UI-07 全部任务 | `/tasks` | 全部/收件箱用 `?tab=inbox` 表达 |
| UI-29 新建任务 | `/tasks?view=create` | 复用同一路由，不新增注册 |
| UI-09 项目任务 | `/projects/:id/tasks` | 该路由已在工作台交互路由表中列出 |

全局页使用“工作空间”面包屑，不使用项目面包屑或工作台切换（与 `/tasks` 概念图的偏差已按提示词处理）。项目页使用真实项目名，名称按路由参数从 fixture 解析，跨项目打开不串数据。

### 2.2 与契约对齐的行为

- CreateTask 的 fixture 新任务为 `INBOX`、`mode=ME`、`executor=HUMAN`；界面表述为“待整理、由我执行”。`保存任务` 在创建后才模拟独立的 ready 校验，目标、验收与前置依赖满足时转为 `READY`，且不自动开始；`暂存待整理` 只创建。
- `AI 辅助` 按 interaction-mode 记录；`AI 委托` 只记录意图，DELEGATE_AI 不在此设置。
- 依赖登记按 `POST /tasks/{id}/dependency-links`；依赖未完成时 ready 不通过并给出原因。
- `开始任务` 按 `POST /tasks/{id}/start`：仅 READY 且无 AI 占有者的任务可开始，开始不等于完成。
- 归档按 `POST /projects/{id}/archive`；存在活动 Run 与未确认动作时按钮禁用并显示业务原因，拒绝时保留原列表事实。
- 项目类型决定阶段词汇（GENERAL/THESIS/DEVELOPMENT），阶段由用户显式设置，不按任务数量推断。
- 任务状态使用契约枚举 INBOX/READY/IN_PROGRESS/WAITING/BLOCKED/DONE/CANCELLED；工作状态、执行模式与当前执行者是三个独立事实，分别渲染。

### 2.3 规范符合性审计与修复

对照设计系统、公共开发提示词与既有实现逐项核对，本轮修复的偏差：

| 偏差 | 处理 |
|---|---|
| 面包屑对全局页套用项目上下文 | 全局页改为“工作空间”；项目/任务名按路由参数解析，新增 `getProjectTitle`/`getTaskTitle` |
| 侧栏 `<aside>` 与内层 `<nav>` 重复 `aria-label="主导航"` | 移除 `<aside>` 上的重复标签，保留可访问导航名 |
| 侧栏“项目/任务”硬编码 fixture ID | 改为指向 `/projects`、`/tasks` 列表 |
| `ProjectTask.status` 使用契约中不存在的 `WAITING_REVIEW` | 统一为契约枚举，并与任务列表共用同一份任务事实 |
| `TaskRecord.executionMode/executor` 是自由字符串 | 改为 `InteractionMode`/`ExecutorKind` 枚举，显示文案集中到 `src/lib/labels.ts` |
| `.status-chip` 缺成功/危险语气与图标槽位 | 补 `--success`/`--danger`；状态同时有图标与文字，工作状态不使用成功色 |
| 表单控件样式会在新建表单里重复 | 复用 `.edit-form` 同一组 token 规则，不复制色值与尺度 |
| 可点击行与 ARIA table role 冲突 | 改为“视觉表头 + `ul/li/button` 选择行”，表头对辅助技术隐藏，行按钮自带可访问名称 |
| `.visually-hidden` 在未定位的 flex 容器内造成 163px 页面横向溢出 | 给 `.segmented-option` 加 `position: relative`；Playwright 实测 5 个新页 overflow 均为 0 |
| 右区说明行套卡片边框，密度与概念图不符 | 右区内 `.suggestion-row` 去掉边框，勾选图标用成功色 |
| `/tasks` 概念图带项目面包屑与工作台切换 | 不照抄，按提示词实现为工作空间上下文 |
| 项目任务图内“全组”等生成词 | 不采用，改用真实 executor 枚举 |

### 2.4 与提示词不同的实现选择（供复验判断）

1. **创建成功后进入项目列表而不是项目详情页**：UI-02 项目总览尚未实现，`/projects/:id` 当前承载蓝图预览与继续项目两项 Skill；直接跳到 `/projects/:id` 会渲染另一个项目的事实。因此创建页把回执与导入状态作为一次性交接数据交给列表页，并选中新项目。交接数据只用于本次导航，刷新后自然消失，不写入业务事实。
2. **新建流程复用列表路由**：UI-06/UI-29 的“新建流程”以 `?view=create` 表达，符合“不擅自注册新路由”。
3. **项目内导航**：“总览”指向 `/projects/:id`（当前承载 Skill 页面），“资料”指向 `/projects/:id/knowledge`，后者落在未接入说明页，不伪造内容。
4. **归档入口位置**：概念图未展示归档按钮，按提示词“归档存在活动 Run/UNKNOWN 时展示阻塞原因”放在项目摘要右区，禁用时给出业务原因。
5. **收件箱**：`/tasks?tab=inbox` 只作为未归属任务的筛选，不替代尚未实现的收件箱页面（UI-08）。

## 3. 实际执行的检查

2026-09-21 在 `apps/workbench/` 执行（Node 24.21.0）：

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `npm run typecheck` | 通过，无输出 |
| 组件与交互测试 | `npm run test` | 59 项通过（8 个文件；批次二新增项目 10、任务 13、项目任务 5） |
| 生产构建 | `npm run build` | 通过；JS 233.61 kB（gzip 78.48 kB）、CSS 36.43 kB（gzip 5.12 kB） |
| 浏览器与视口测试 | `npm run test:browser` | 15 项通过（1487×1058、960×720、390×720） |
| 视觉对照截图 | `npm run screenshots` | 9 个页面 1487×1058 / DPR 1 截图写入 `apps/workbench/artifacts/screenshots/` |

人工对照 5 张新原图与截图后修正的问题：列表主操作按钮被压成两行、右区说明行卡片密度、阻塞行高度、创建项目页 163px 横向溢出。另按设计系统“刷新保留已知内容并标识更新”把筛选与归档后的整页加载改为就地更新提示。未做逐像素差异测量。

以上为开发过程自测，**不代替独立复验**；截图是浏览器渲染，不是桌面 WebView 验收。

## 4. 未完成与待验证

- FE-01–04 已在 fixture 范围内修复并通过针对性回归，见第 6 节；R03/R04 的后续对齐与视觉复验见第 7、8 节。完整图像逐像素、全部实际 CSS 对比度未测。
- 桌面 WebView 字体、DPI、100%–200% 系统缩放、中文输入法与 Windows 辅助技术。
- 真实 API 接入后的契约测试：`CreateProject`/`CreateTask`/`MarkTaskReady`/`StartHumanTask`/`dependency-links`/`archive` 目前只在 fixture 中模拟，回执文案均写明“本次演示”。R03 已确认项目列表、归档、资料导入、全量筛选与 Skill 写入仍无可直接接通的 API，不能用 fixture 成功外推。
- 尚未接入的页面入口：项目总览（UI-02）、项目资料（UI-16）、收件箱（UI-08）、任务详情（UI-10）、产物编辑（UI-11）、Run 控制（UI-18–20）、知识/动态/待审/连接/设置。
- 权限、delegation、执行权与 Review 的真实状态机；来源详情仍来自示例摘要。

## 5. 2026-09-21 独立复验

主 Agent 复跑构建（含类型检查）、59 项组件测试、15 项 Chromium 测试与 9 页截图均通过，人工查看全部截图并抽样对照项目列表原图，核对唯一 token 注入与 body 字体栈。上述仅证明明确覆盖范围。

补充真实浏览器操作发现 FE-01 错对象查询/接受定义、FE-02 成功后重复创建、FE-03 项目切换残留依赖、FE-04 离开创建页静默丢草稿。详细原始证据与步骤统一见[本轮独立验收](../testing/frontend-backend-acceptance-2026-09-21.md)，修复入口见[R02](../../prompts/remediation/R02-frontend-correctness.md)。这些问题已在第 6 节所述 fixture 范围内复验；之前各批次的“已核对”仍不能外推为真实 API、数据库或桌面交付通过。

真实接入前类型/能力对齐见[R03](../../prompts/remediation/R03-integration-alignment.md)，视觉与产品文案调整见[R04](../../prompts/remediation/R04-visual-copy-adjustment.md)。R02–R04 的执行结果分别在第 6–8 节记录；它们均不代表真实 API、数据库或桌面交付通过。

## 6. R02：对象隔离与创建闭环复验

R02 在不接真实 API、不增加桌面壳或通用状态框架的前提下完成。新增 `tests/remediation.spec.ts`，运行时状态只保存在 fixture 内存与组件草稿中。

| 编号 | 修复与复验范围 | 证据 |
|---|---|---|
| FE-01 | 项目 Skill 与任务 Skill 分别按路由 ID 查询；蓝图、恢复摘要、任务定义、验收建议的写入接收相同 ID。未提供 fixture 的已知/未知对象显示未提供状态，按钮不出现。 | 新任务路由不再显示或接受“确定实验评价指标”的定义；组件回归通过。 |
| FE-02 | 创建命令复用原 `commandId`；回执明确区分 APPLIED、NOT_SUBMITTED、UNKNOWN。任务成功后离开表单到结果态，新建另一项是显式动作。 | 定向回归覆盖响应丢失后查询、同 ID 重放、未提交、仍未知和单一 Task 数量。 |
| FE-03 | 项目改变会清掉失效依赖；adapter 写前校验目标项目、归档状态及依赖同项目，失败不 push Task；项目任务页带当前项目预填。 | 定向回归覆盖 A→B 清理、项目内预填及跨项目拒绝后列表无半成品。 |
| FE-04 | 创建项目/任务注册统一草稿守卫，拦截返回、侧栏、浏览器导航和 query 切换；刷新/关闭触发 `beforeunload` 提示。成功后不再拦截。 | 定向回归覆盖 query 切换对话框和 `beforeunload`；既有导航/browser 套件通过。 |

2026-09-21 检查：`npm run typecheck` 通过；`npm run test` 为 9 个文件、66 项通过；`npm run build` 通过（JS 241.08 kB，gzip 80.80 kB；CSS 36.43 kB，gzip 5.12 kB）；`npm run test:browser` 为 16 项 Chromium 通过。浏览器套件证明既有三类视口的页面和导航未回归，但不是 Windows WebView、真实 API 或数据库幂等验收。

## 7. R03：接入前契约与能力对齐

本节只记录已核对的接入边界；工作台运行时仍是 `fixtureAdapter`，没有新增空壳 API 客户端、Bearer 存储或假联调。

| 页面/动作 | 真实 API 当前事实 | 前端接入结论 |
|---|---|---|
| 项目列表、归档、资料导入 | 只有 `GET /projects/{id}` 与 `POST /projects`；无列表、归档或导入路由 | 继续 fixture-only；新建项目的 `goal`/`importFileName` 也没有当前 DTO 对应字段。 |
| 全空间/项目/Inbox 任务查询 | `GET /tasks` 只接受明确 `project_id` 或 `inbox=true`，使用稳定游标 `limit/cursor`；无全空间、状态、模式或文本筛选 | 不能把当前页面筛选映射为忽略筛选的请求；项目任务页也没有单一聚合 DTO。 |
| 创建、可开始、开始与依赖 | `POST /tasks`、`/ready`、`/start`、`/dependency-links` 是独立命令 | fixture 的“保存并检查可开始”不是一个真实命令；真实接入必须按创建后依次发命令并处理每一步回执。 |
| mode、executor 与 revision | `mode` 为 `ME`/`AI_ASSIST`，`DELEGATE_AI` 当前返回 `409 CAPABILITY_DISABLED`；`executor_kind` 是独立字段；版本字段为最多 19 位的十进制字符串 | 前端已将人工 mode 改为 `ME`，`executor=HUMAN` 保持独立；Task/验收 revision 使用字符串比较与递增，新增超过 `2^53` 的回归。 |
| 四项 Skill 与命令回执 | Task 定义/验收建议只有部分读取可借 `GET /tasks/{id}`；蓝图/提案、Resume 聚合及对应 accept/reject/write 路由不存在。`GET /commands/{command_id}` 有真实回执，但 404 不表达 fixture 的三态。 | 所有四项 Skill 与 fixture 的 APPLIED/NOT_SUBMITTED/UNKNOWN 演示语义继续标为未接入，不能伪造成功。 |
| readiness | `/health/live` 仅存活；`/health/ready` 需要 Bearer，并已通过受限兼容视图比对随包 migration 名称/SHA-256；数据库不可连为 `DATABASE_UNAVAILABLE`，schema 不兼容为 `SCHEMA_UNAVAILABLE`，不自动迁移 | fixture 没有调用真实健康检查；接入时必须显示两类 503 的可操作状态，不能把服务存活当作业务可用。 |

R03 复验：新增 `tests/decimalRevision.spec.ts`，`9007199254740992` 与 `9007199254740993` 的比较和递增保持精确；另覆盖新建、准备与开始执行的 revision `"0" → "1" → "2"`。`npm run test` 共 68 项通过，`npm run build` 通过。该结果只证明 fixture 类型消费边界，未发送任何真实 API 请求。

## 8. R04：视觉层级与产品文案复验

R04 只改现有项目列表右区、受影响回执与创建说明。右区将当前项目作为对象标题，把阶段、状态修订和待审数量汇为一处细边框状态摘要；未制造完成数字或新增色值。CreateTask、创建回执和委托提示改为“保存为待整理”“满足条件后可开始”“尚未开始执行”等结果说明，同时保留示例标记、版本、来源、禁用理由和错误处置。

`design-tokens.json` 未改；新增 CSS 只引用既有颜色、字号、边框与 `space.1/space.3`。复验结果：`npm run build` 通过（JS 241.40 kB，gzip 80.87 kB；CSS 36.99 kB，gzip 5.20 kB），`npm run test` 68/68，`npm run test:browser` 19/19，`npm run screenshots` 9/9。人工查看[项目列表截图](../../apps/workbench/artifacts/screenshots/ui-05-projects.png)和[新建任务截图](../../apps/workbench/artifacts/screenshots/ui-29-create-task.png)。浏览器回归通过 Chromium CDP `Emulation.setPageScaleFactor=2` 将 `visualViewport.scale` 实测为 2，再以键盘焦点打开右区并激活“打开项目”；另以 480×360 等效 CSS 视口检查右区打开/关闭、状态摘要、滚动至“打开项目”与整页横向溢出（0），结果截图见[等效缩放截图](../../apps/workbench/artifacts/screenshots/r04-200pct-equivalent.png)。

这不是 Windows 系统 DPI、浏览器工具栏缩放或桌面 WebView 验收；中文输入法、真实辅助技术、字体回退与 Windows 100%–200% 系统缩放仍待真实宿主验证。

## 9. 真实 API 接入最小闭环（2026-09-21）

状态：已在真实 `apps/api` + 真实 PostgreSQL 上跑通最小闭环。这是开发期自测证据，不是独立验收，也不代表 P04 全部完成、桌面交付或 37 个业务场景已通过。

| 项目 | 结论 |
|---|---|
| 连接模型 | 默认仍是 fixture。页壳右上「数据来源」打开连接面板，填入 API 地址、Workspace ID 与 Bearer 令牌；凭据只保存在当前页面内存，不写入 URL、localStorage、日志或源码，刷新即回到示例数据。 |
| 连接前提 | 只有 `GET /health/ready` 返回 200（database=up 且 schema=up）才进入 live；`DATABASE_UNAVAILABLE` 与 `SCHEMA_UNAVAILABLE` 分别给出可操作说明，服务存活不算业务可用。 |
| 已接入真实命令 | `POST /projects`、`POST /tasks`、`POST /tasks/{id}/ready`、`POST /tasks/{id}/dependency-links`、`POST /tasks/{id}/start`、`GET /projects/{id}`、`GET /tasks?project_id=`、`GET /tasks/{id}`、`GET /commands/{command_id}`。 |
| 仍未接入 | 项目列表与归档、资料导入、全空间任务筛选、四项 Skill 的提案与写入、产物版本与完成/重开界面（UI-10/UI-11）、Run 与 Review。live 模式下这些入口显示未接入原因，不展示示例事实，也不伪造成功。 |
| 契约取舍 | 项目目标与导入资料不在 `CreateProject` 契约内：live 下标注未接入且不提交。表单「预期结果」映射为 `CreateTask.objective`，验收标准按行映射为 `criteria`（`criterion_id`/`method` 由服务端补齐），`expected_outputs` 缺省。`DELEGATE_AI` 在 live 下禁用（服务端返回 `CAPABILITY_DISABLED`）。 |
| 幂等与错误 | 结果确定前沿用同一个 command ID；传输错误（无响应）提供「查询本次回执」，用 `GET /commands/{command_id}` 判定是否已提交，绝不换 ID 盲重试；409 `REVISION_CONFLICT` 保留版本差异并保留输入，422 的 `field_errors` 放回对应字段。revision 全程按十进制字符串处理。 |
| 可开始性 | live 下按钮启用依据是服务端投影的 `allowed_actions`，不是客户端推断；fixture 下沿用示例状态。 |

真实闭环验证（`.research/live-loop-2026-09-21/`，被 Git 忽略的开发期探针；不改 `apps/api`）：

| 检查 | 结果 |
|---|---|
| 一次性准备 | `setup-dev-environment.ps1`：独立 PostgreSQL 18.6 集群（127.0.0.1:55432，`relay_dev`，真实 `relay_migrator`/`relay_app`），迁移入口应用 `0001`–`0003`，Workspace 初始化得到 `workspace_id` |
| 服务启动 | `verify-live-loop.ps1` 以显式环境变量在 8790/5175 启动 API 与 Vite；`GET /health/ready` = 200，`{"database":{"status":"up"},"schema":{"status":"up"}}` |
| Chromium 闭环 | 连接 → 创建项目（`revision=0`，可读回）→ 创建任务（`POST /tasks` + `/ready` → `READY`、`revision=1`、`acceptance_revision=1`、2 条 criteria）→ 项目任务页读回 → 开始任务（`IN_PROGRESS`、`revision=2`）→ 整页刷新后回到示例数据、重连后仍读到「进行中」→ `GET /tasks?project_id=` 返回同一任务 |
| 数据库交叉核对 | `select id, status, revision from tasks` 返回同一行：`IN_PROGRESS` / `2`，证明写入的是 PostgreSQL 而非内存 fixture |
| Workbench 回归 | `npm run typecheck` 退出 0；`npm run test` 72/72（11 文件）；`npm run build` 通过（JS 274.42 kB / gzip 90.90 kB，CSS 37.57 kB / gzip 5.23 kB）；`npm run test:browser` 19/19 |

验证期间未改写 `apps/api/.env`：该文件在本轮被另一个写入者改成指向 127.0.0.1:5432，本探针改用显式环境变量与独立端口，避免覆盖他人未提交改动。该文件仍由使用者自行维护。

仍未验证：`AddTaskDependency` 在真实数据库下的环检测等域行为（闭环未选择依赖）、并发冲突的受控双客户端竞争、桌面窗口内的同一路径。

## 10. UI-10 任务详情与 UI-11 产物编辑（2026-09-21）

批次四把 P04 要求的人工路径在 live 模式下补齐：**录入 → 可开始 → 开始 → 保存 Markdown 版本 → 选择要接受的版本 → 检查必需项 → 完成 → 重开**。页面仍复用 `/tasks/:id`（无 `skill` 查询参数即任务详情），未新增路由。

| 项目 | 结论 |
|---|---|
| 页面与页签 | `/tasks/:id` 承载概览/产物/执行记录三个页签；`?skill=definition｜verification` 仍是既有 Skill 壳，两者互不取代。执行记录属 P15，显示为未接入，不伪造步骤结果。 |
| 真实读取 | 任务事实与验收条件来自 `GET /tasks/{id}`；“当前选用”来自 `GET /projects/{id}/state` 的 `selected_artifact_version_refs`，是服务端事实而不是本地记忆。 |
| 保存版本 | 首次保存走 `POST /tasks/{id}/artifacts`，之后续写走 `POST /artifacts/{id}/versions`；`expected_task_revision` 用当前任务 revision，`expected_artifact_revision` 用上次返回的产物 revision，`media_type` 固定 `text/markdown`，正文按 UTF-8 字节在客户端预检 256 KiB。 |
| 安全预览 | 当时的自研最小 Markdown 渲染器（[SafeMarkdown.vue](archive/m02-vue-workbench-baseline/src/components/SafeMarkdown.vue)）：**不使用 `v-html`**，原始 HTML 只作为文本显示；链接只对 http/https 生成 `<a>`，`javascript:` 等协议显示为未渲染。 |
| 选择接受 | `SELECT_ARTIFACT_VERSION` 是 Project State 类型化命令，`expected_revision` 用 State revision，并必须带 `source_ref`（本实现为 `human:workbench:task/<taskId>`）。界面明确区分“当前选用”（项目级）与“本轮接受”（完成凭据里的版本）。 |
| 完成与重开 | 完成要求勾选全部必需条件并提交 `acceptance_revision` 与所选版本；重开建立新验收版本并回到可开始，历史凭据保留。完成后编辑入口关闭并引导重开，结果回执不随按钮消失。 |
| 幂等与错误 | 每一步在结果确定前沿用同一个 command ID；传输错误提供“查询本次回执”并按 `command_type` 区分步骤；409 保留草稿与版本差异，422 的 `field_errors` 回填字段；`revision` 全程字符串。 |
| 会话内产物记忆 | 服务端没有“列出任务产物”的读取端点（待接入），因此版本列表只列本会话保存过的版本，并在界面上写明刷新后为空。这是 UI 状态，不是业务事实。 |
| 未接入 | 修改验收标准的专用命令、产物列表端点、Run/Trace 与 AI 辅助（AI 功能保持禁用，界面不出现可点的 AI 动作）。 |

真实闭环验证（同一 `.research/live-loop-2026-09-21/` 探针，不改 `apps/api`）：

| 检查 | 结果 |
|---|---|
| 完整路径 | Chromium 走完 连接 → 创建项目 → 创建任务（含 ready）→ 开始 → 任务详情 → 保存产物 v1 → 选择版本 → 完成 → 重开，16 项断言全部 PASS |
| 界面事实 | 保存回执含 sha256 与字节数；预览只有 1 个 `https://example.com/doc` 链接，`javascript:` 链接显示为“链接协议不受支持，未渲染”；完成后编辑锁定且保存按钮禁用；重开回执给出新验收版本 v2 |
| API 交叉核对 | 选择版本后 `selected_artifact_version_refs` 含该版本且 `source_ref` 为 `human:workbench:task/<taskId>`；完成后任务 `DONE` 且有 `current_completion_id`；重开后 `READY`、`acceptance_revision=2`、`current_completion_id=null` |
| 数据库交叉核对 | `artifact_versions` 有两行 `text/markdown`、`source_kind=HUMAN` 且 sha256 与界面一致；`completion_records=2`；`state_artifact_refs=1` |
| Workbench 回归 | `npm run typecheck` 退出 0；`npm run test` 80/80（12 文件）；`npm run build` 通过（JS 312.11 kB / gzip 101.41 kB，CSS 40.03 kB / gzip 5.48 kB）；`npm run test:browser` 19/19；`npm run screenshots` 9/9 |

本轮由真实闭环发现并修复的实现缺陷（桩测试无法覆盖）：`SELECT_ARTIFACT_VERSION` 缺少必需的 `source_ref` 时服务端返回 422 `REQUIRED_INPUT_MISSING`，已补上并加断言。

仍未验证：桌面 WebView 内的同一路径、Windows DPI/中文输入法、并发冲突的受控双客户端竞争、`AddTaskDependency` 的环检测、产物列表端点接入后的跨会话版本列表。
