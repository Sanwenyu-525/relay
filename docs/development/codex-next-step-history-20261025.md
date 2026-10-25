# 进度历史快照（2026-10-25）

角色：整理前的完整进度快照，保留当时未提交记录与历史授权，不继续更新，也不作为当前任务指令。最新阶段与下一步只看 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)；仅按关键词定位相关小节。

# Relay 当前状态与下一步

更新：2026-10-25。角色：唯一阶段、模块与下一步入口。功能通过/未通过/未验收只看[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)；长篇经过保存在[历史快照](codex-next-step-history-20260930.md)，不作为默认交接输入。

## 长期协作与自动化调度模块任务书：P0-A 定时任务安全准入与冻结（2026-10-25，当前 Agent 直接执行，未 commit/push）

按长期协作与自动化调度模块任务书（用户 2026-10-25 粘贴输入，P0→P1→P2）开工。阶段 0 基线核对：本模块无前序进度条目；PT-01～PT-12 是验证计划 §44 的目标规格非成绩；无任何 agent 成员/团队表（P1 全新）；migration 现场最新 0137、两个 0135 重复编号仍在（运行器按文件名各自登记，均已可应用）。P0-A 对照任务书六项核查后确认四个真实缺口，全部先构造失败复现（`scheduled-task-p0a.integration.test.ts` 4 例先红）再修复：

- **发生时配置冻结**：occurrence 落库时新增 `frozen_template`/`frozen_execution_input`（迁移 `0138_scheduled_task_occurrence_freeze.sql`），分发/补跑一律用冻结副本——此前未提交的 CreateTask 会读到编辑后的新模板（#150 只覆盖已提交分支）；存量 DISPATCHING 行保持空副本回落计划当前值，不回填。
- **补跑前准入**：`resolveScheduledTaskOccurrence` 的 RETRY 在命令事务内先跑 `scheduledTaskDispatchFailure` 快照准入（新助手，与分发共用）：暂停/停用/到期/预算耗尽/项目归档/旧代次/上一轮未验收→`409 INVALID_TRANSITION`，不重开发生、不建 Task。
- **分发前准入**：`dispatchScheduledOccurrence` 在 CreateTask 未提交前同样先准入，必然不可执行直接 `BLOCKED`（新 reason 词表 `PLAN_NOT_ENABLED`/`SCHEDULE_GENERATION_STALE`/`PROJECT_ARCHIVED`/`EXECUTION_SCOPE_DRIFT`）；契约 §10.94「已知中间态」收窄为快照准入后到 Delegate 原事务准入前的并发窗口。
- **完成幂等与迟到写入守卫**：`markDispatched`/`markSettled`/`freezeExecution` 加 `status='DISPATCHING'` 条件；`markStarted` 只在 DISPATCHING→DISPATCHED 真正发生时执行——重复完成不重复累计 `runs_started`，迟到失败写入不覆盖 `DISPATCHED`（此前 review 发现 markDispatched 与 markStarted 本就同事务原子，双计只来自第二分发者沿同一发生重放，条件更新是对该兜底的可证修复）。

**已验证（实施者自检）**：真实临时 PG18.6＋HTTP `scheduled-task-p0a.integration.test.ts` **4/4 先红后绿**；回归 `scheduled-tasks`＋`scheduled-task-detail-history`＋`task-chain-execution`＋`task-chains` 集成全绿（`run-integration.ps1 -UseCLocale`，status PASSED，迁移含 0138，临时集群已清理）；单测 `zoned-time`/`scheduled-tasks`/`scheduled-task-scheduler` 18/18；API `tsc --noEmit` exit 0。**文档**：契约 §10.94（冻结段、补跑准入段、中间态收窄）、数据库 §103（0138 与条件写入）、验证计划 §37（第 4 条与故障覆盖现状）、[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「定时任务 P0-A」行。**未验**：多实例并发分发（维持 ADR-026 单进程假设）；真实 Windows 桌面内调度循环；独立验收未做。Breaking Change：No（新列有默认值，旧客户端不感知；RETRY 在必然不可执行态从 200 变 409 属缺陷修复口径，契约已同步）。

**下一步（P0-B，任务书阶段 2）**：工作台定时任务编辑/状态转换/续授权/补跑 UI 闭环，重点文件 `ScheduledTaskDetailView.tsx`、`CreateScheduledTaskView.tsx`、`scheduledTasks.ts` resources；服务端 EditScheduledTask/SetScheduledTaskStatus/ResolveScheduledTaskOccurrence 均已实现。P1-A 起为全新领域（ADR-034）。

### P1-A：项目级长期 Agent 成员（ADR-034 包 A，2026-10-25，当前 Agent 直接执行，未 commit/push）

全新领域（此前无任何成员表）。按任务书包 A 最小协议落地，migration `0139_project_agent_members`（现场核对最新为 0138 后分配）：`project_agent_members`（稳定身份：名称项目内唯一、角色键、职责创建时从模板拷贝、状态 `ACTIVE/INACTIVE/ARCHIVED`、运行方式、`model_selection`、`external_binding`、配置 revision）＋ `project_agent_coordinators`（一项目一行 PK，协调者指派/换人单事实，换人须带当前修订防并发互换覆盖）。应用 Owner `agent-members.ts` 四命令（Create/Edit/SetStatus/AssignCoordinator，全部 command_id 幂等＋workspace 隔离＋归档项目拒绝写）＋只读三入口；角色模板为代码级目录（五个键），不建表、不自动建齐团队；EXPLICIT 模型选择复用会话模型选择同一解析（类型化 `MODEL_NOT_REGISTERED`/`MODEL_PAID_NOT_AVAILABLE`，存指纹；INHERIT 执行时解析）；`external_binding` 目前只是展示标签不构成授权（可信绑定随 ADR-033 领取协议在包 C 落地）；ARCHIVED 为留档终态（拒编辑拒复活、可读）；后续消息/执行权包以「成员必须 ACTIVE」为闸门。`select-session-model.ts` 的两个类型化拒绝工厂改为导出复用（不复制第二份口径）。

**已验证（实施者自检）**：真实临时 PG18.6＋HTTP `agent-members.integration.test.ts` **4/4 PASSED**（按需创建＋模板默认职责＋重放＋撞名 422＋同职责多成员；编辑 CAS＋EXPLICIT 模型类型化拒绝且不推进修订＋状态转换合法集＋归档只读；协调者首指/重复 409/换人须修订/单行断言/停用成员不可担任；跨 workspace 404＋跨项目指派 404）；API `tsc --noEmit` exit 0。**文档**：契约 §10.113、数据库 §114、领域模型 §23 状态行、验收表「P1-A」行。**未验**：真实浏览器/Windows UI（P2-A 才接工作台）；外部运行方式可信绑定（依赖 ADR-033 领取协议，未实现）；成员身份参与真实执行（P1-C）；独立验收未做。Breaking Change：No（纯新增表与端点）。

**下一步（P1-B，任务书阶段 4）**：成员私聊/群聊/消息投递与讨论终止（PT-02/PT-04 核心），ADR-017 与 assist 消息体系为参照，成员消息以 P1-A 的 ACTIVE 闸门与 `project_agent_members` 身份为基础；模型互相唤醒属 P1-C。

### P1-B：成员私聊、群聊与消息（ADR-034 包 B 服务端记录面，2026-10-25，当前 Agent 直接执行，未 commit/push）

migration `0140_project_member_conversations`：`project_member_conversations`（私聊一成员一线程、群聊一项目一线程——两个部分唯一索引即「开启或继续」的唯一性裁决；`OPEN/CLOSED`＋六种终止原因码，关闭保留记录可重开）＋`project_member_messages`（持久身份、seq 会话内递增且唯一、`sender_kind`、**定向接收者数组**（私聊恒对方；群聊空集＝未定向由协调者接住，唤醒侧据此只唤醒谁，绝不默认广播全员）、六种意图、HANDOFF 受控载荷只引用原事实（外键 linked_task_id/linked_run_id＋键词表封闭 payload）、`processing_status` 词表已含 CLAIMED/PROCESSED/FAILED 但消费循环归包 C）。应用 Owner `member-conversations.ts` 三命令（Open/Send/SetStatus，command_id 幂等去重不依赖前端）＋三只读入口；闸门：开私聊与发送都要求成员 ACTIVE（停用拒发拒开、历史可读）、项目归档拒写、跨 workspace 404。**边界（如实）**：成员回信、互相唤醒、消费结算、记忆侧上下文隔离、模型语义质量全部未实现（包 C/真实 Provider）；本片只证明持久记录、定向事实、幂等与准入，不宣称协作闭环。

**已验证（实施者自检）**：真实临时 PG18.6＋HTTP `member-conversations.integration.test.ts` **5/5 PASSED**（一线程语义＋重放不新建；seq 递增＋同命令不重复＋私聊强制对方＋群聊定向校验/跨项目 404/未定向空集；HANDOFF 载荷键词表与互斥校验＋linked_task 外键引用；关闭需原因码/关闭拒发/重开清原因/CAS/关闭期间 seq 连续；停用拒收拒开历史可读＋归档拒写＋跨 workspace 404）；合并回归 `agent-members`＋`member-conversations`＋`scheduled-tasks`＋`scheduled-task-p0a`＋`scheduled-task-detail-history` 全绿（`run-integration.ps1 -UseCLocale` status PASSED）；API `tsc --noEmit` exit 0。**文档**：契约 §10.114、数据库 §115、领域模型 §23 状态、验收表「P1-B」行。**未验**：成员侧发送路径（sender MEMBER 归包 C）；前端读取（P2-A UI）；真实 Windows；独立验收未做。Breaking Change：No（纯新增）。

**下一步（P1-C，任务书阶段 5）**：授权范围内自动推进＋事件唤醒＋巡检＋Windows 生命周期（ADR-034 包 C/D：协调者复用 Task/Run 用例、`project_member_messages` 的消费结算与唤醒裁决、复用 PG Worker 与调度入口不建第二引擎、Tauri 生命周期按任务书 §8）。此后 P2-A 工作台接线、P2-B 真实小功能端到端。

### P0-B：定时任务编辑、续授权与补跑拒绝的 UI 闭环（2026-10-25，当前 Agent 直接执行，未 commit/push）

盘点结论：详情页已有暂停/继续/停用、补跑/忽略、待核对冻结与回执核对、Task/Run 深链、读取失败重读（DEV-0123/0124），资源层三个命令早已接线——真正缺口是**编辑入口**（含 EXPIRED 续授权路径）与新 reason 词表呈现。本轮补齐：

- **编辑页**：`CreateScheduledTaskView` 改双模式组件，路由 `/scheduled-tasks/:id/edit`（详情页动作区新增「编辑」）。按详情回填全部字段并复用创建页全部校验、草稿守卫与待核对冻结；首次日期从 `first_run_at` 在任务时区取墙钟日期，授权到期换算设备本地钟面；项目只读不可迁移；新增必填「修改原因」；提交带 `expected_revision`，版本冲突为明确拒绝（表单解锁、可发新命令），回执核对 `EditScheduledTask` 类型与对象。
- **EXPIRED 路径**：详情页到期时显示引导条（先编辑延长授权/提高次数上限，保存后仍保持已到期，再显式「继续」）；「继续」按钮对 EXPIRED 出现（`scheduled-task-resume`），服务端在原因未解除前 409 如实显示——与 #149 服务端口径一致，workbench-design §37 状态语义段已同步改写（原文「界面不给这个按钮」为 #149 前旧口径）。
- **新 reason 词表**：`PLAN_NOT_ENABLED`/`SCHEDULE_GENERATION_STALE`/`PROJECT_ARCHIVED`/`EXECUTION_SCOPE_DRIFT` 加入详情页中文说明；补跑被 409 拒绝按明确拒绝呈现，不进待核对冻结。

**已验证（实施者自检）**：新增 jsdom `scheduledTaskEdit.spec.tsx` **5/5**（回填含周规则勾选与只读项目、`expected_revision`+原因载荷、原因必填零提交、响应未知冻结＋回执未到→原 ID 重试→回执命中回详情、版本冲突解锁后新命令、EXPIRED 详情引导条与继续/补跑 409 呈现）；既有回归 `createScheduledTaskRecovery`+`scheduledTasks`+`scheduledTaskDetailPendingHistory`+`scheduledTaskRecovery` **20/20**、`navigation.spec.ts` **11/11**；workbench `tsc --noEmit` 本轮文件零错误（全量仍只剩并行会话既有 `tests/impactCandidateGroup.spec.ts:220`）；`vite build` exit 0。**文档**：workbench-design §37（编辑页段＋状态语义改写）。**未验**：真实 Chromium/WebView2 与窄窗、多 DPI；独立验收未做。UI skill 核对：可用列表中的 UI skill 均面向新界面/视觉设计，本轮为既有设计系统内扩表单与动作入口，按 workbench-design §37 与既有 tokens 直接实施。Breaking Change：No。

## 目标卡收成输入框上方的单行状态条（2026-10-25，当前 Agent 直接执行，未 commit/push）

用户指令（附 Codex 截图）：目标模式的 UI 只要在输入框上面显示一条。原实现是转录区顶部整张 `GoalCard`（0127/DEV-0103 三层卡）＋取消确认框。本轮改为 Codex 式单行：`GoalCard.tsx` 重写为 `.goal-strip`——单行只放目标图标、服务端状态芯片（沿用文字＋色点）、目标正文（超长省略号截断）、轮次/成功条件计数、动作键（暂停/取消为图标键，「继续/确认完成」带文字主行动），点击整行左侧展开详情区（目标全文、计划版本、当前步骤、进展、停止原因与问题、成功条件、步骤/轮次折叠、说明）；展开是本地视图偏好不发命令，内容超 `42vh` 区内滚动，窄窗（≤48rem）先收计数。条在输入卡**外**上方、同 chat-measure 列宽，出现/展开不改变输入卡形状。`AssistView.tsx` 移除转录区顶部挂载点、改挂输入卡上方（`ComposerDraftBar` 与输入卡之间）；取消确认 `AppDialog`、服务端 `actions` 口径、投影读取失败恢复（文案改「目标状态行」）不变。计划卡（details 折叠）、模式徽标、卡外说明行不动。规则同步[工作台 §44.2](../frontend/workbench-design.md#442-目标状态条与控制)（标题由「目标卡与控制」改为「目标状态条与控制」）。

**已验证（实施者自检）**：workbench `tsc --noEmit` 对本轮文件 exit 0（仓内另有他人未提交 `tests/impactCandidateGroup.spec.ts` 的存量 TS 报错，与本轮无关）；jsdom `chatPlanGoal` 16/16（新增「默认单行、细节展开/收起」用例）、`goalCancelConfirm` 1/1、`goalProjectionReadRecovery` 5/5；真实 Chromium `tests/browser/goalCardLayout.spec.ts` 按单行条改写后 3/3（单行截断、贴输入卡上方同宽、展开区滚动时单行与动作键不被挤走、第 0 轮空态无空壳）；探针页 `probe-goal-strip.html` 截图三档（收起/展开/390px 窄窗）人工核对通过（`apps/workbench/output/goal-strip-*.png`）。workbench 全量 jsdom 另有 36 个失败，经基线对比（还原本轮 GoalCard/CSS 复跑同批文件）确认全部为他人未提交改动的存量失败，本轮未新增。**未验**：真实 Provider 端到端与真实 WebView2 实窗；独立验收未做。Breaking Change：No（testid 保留，`goal-card-title`/`goal-card-plan-version` 行内位置与 `goal-card-rounds` 语义有变，仅前端内部）。

## 上下文圆环改为可点开的详情浮层（2026-10-25，当前 Agent 直接执行，未 commit/push）

用户指认「上下文圆圈点击打不开展示会话窗口的菜单」；核对全部历史（`git log -S ContextMeter`）确认圆环此前从未有过点击菜单——2026-10-22 起只有悬停一句话，用户记忆的是本工具 CLI 的同类交互，本次按该预期补齐。`AssistView.tsx` 的 `ContextMeter` 圆环本体改为按钮（`aria-haspopup="dialog"`＋`aria-expanded`，`aria-label` 与四态 `data-state` 不变），点击向上弹出 `.agent-chat-context-meter-menu`：最近一次模型调用的上下文 / 输出 / 缓存命中三行（未上报缓存的行不渲染、读不到上限写「占用不可算」、尚无调用为空态说明）加口径注（按该次调用重发完整历史计、分母 `max_call_tokens` 应用预算非物理窗口）；读数仍是底栏同一份 props，不新增用量来源。浮层与模型下拉共用 popoverMenu 独占、点外即收、Esc 还焦点；悬停一句话保留，浮层开着时悬停取空（`pathTooltip` 加 `dismissTooltip` 出口）。首条与会话两档输入器同款，首条恒为空态。

**已验证**：workbench `tsc --noEmit` exit 0；jsdom `collaborationWorkspace` 86/86（新增「点击打开、Esc 还焦点、点外即收」）；真实 Chromium `composerPopupGeometry` 6/6（新增 1000×800 用例：读数在场、右缘贴圆环、待在输入卡与视口内、与模型下拉双向互斥）、`composerCacheHitStability` 3/3、`modelSelectorDropdown`＋`composerSourcePanel` 11/11。规则同步[工作台 §28.8 尾部 2026-10-25 条](../frontend/workbench-design.md#288-v42-工作详情与成果预览接续2026-10-15)与[设计系统组件表 ContextMeter](../frontend/design-system.md)；check-docs 报错均为存量断链、不涉及本轮文件。**未验**：真实 WebView2 实窗与多 DPI。Breaking Change：No。

## @ 插件芯片三项用户指认：整体删除、菜单左对齐取证（2026-10-25，当前 Agent 直接执行，未 commit/push）

用户附两图指认当日新功能「@ 插件菜单＋输入内联芯片」：①退格可逐字删除插件名（芯片退化成裸 `@`，插件应作为整体）；②`@` 弹出菜单要左对齐。事实核对分两路：

- **整体删除（真实缺口，本轮修复）**：`ChatCommandInput.tsx` 的 onKeyDown 新增芯片整体删除分支——Backspace/Delete（含 Ctrl+Backspace 删词）会伤及某枚 mention 的按键把**选区预置到整段后放行**：删除仍由原生执行，一次按键删掉整枚且 **Ctrl+Z 可撤销**（程序化删文本会断撤销链，这是放行原生的理由）；光标点进芯片中间、部分选区同样扩成整段，相邻 mention 按删除方向分边，芯片前后普通文本与 `@` query 编辑不受影响。textarea 仍是唯一文本 Owner，镜像层与发送载荷未动。**演进**：第一版按 Slack/Notion 惯例做「先选中整块、再按一次删除」的两步反馈，用户以截图质疑「为什么有这个状态、要按两次」，同日第二轮改为一次删除（上表方案）——中间高亮态消失，撤销链保住。
- **菜单左对齐（当前代码已生效，取证＋防回归）**：真实 Chromium 临时探针实测工作树——`justify-content: flex-start` 已生效、图标与名称相邻靠左（间距 8px）、菜单左缘与输入框左缘同轴（353=353），`.chat-mention-option` 特异性 (0,4,0) 压过命令菜单 `span:first-child` 的 space-between (0,3,1)；用户截图对应的是该压制规则落盘前的旧渲染（截图菜单项还带 `@` 前缀，与当前结构不符）。代码未改，转为正式浏览器断言锁住——特异性数字接近，动这两条规则会悄悄翻车。

**已验证**：`pluginIcons.spec.tsx` 28/28（「芯片整体删除」8 例：一次删除预置选区、芯片中间、Delete 前缘、部分/完整选区、Ctrl+Backspace、相邻 mention 分边、query 编辑不误拦）；新 `tests/browser/composerPluginMention.spec.ts` 2/2（真实键盘删除闭环：删尾随空格→**一次退格删整枚**→Ctrl+Z 撤销恢复，全程无「@电脑操」中间态；菜单行内左对齐与外壳贴输入框左缘）；引用方回归 `chatCommandInput`+`assist-flow`+`assist-preview`+`assistantModeSwitch`+`composerAttachMenu` 114/114。契约归[工作台 §32.9 连接器与插件二级](../frontend/workbench-design.md#329-连接器与插件二级2026-10-17)的「插件图标与输入器插件标识」段（输入器标识条补删除整体化）。**未验边界**：光标点进芯片中间继续打字仍会把该 mention 拆成普通文本（纯 textarea 方案拦不住 IME，未做光标弹跳——与拖选/Shift 扩选冲突）；删除相邻 mention 的后一枚后光标贴着前一枚尾部，`@` 菜单会按既有边界规则弹出（可 Esc，属接受的行为）；真实 Windows/WebView2 实窗与独立验收未做；工作台全量 `tsc --noEmit` 本轮复跑时被并行会话 18:25 新改的 `tests/impactCandidateGroup.spec.ts:220`（`posted` 推断 `never`）挡住——该错误不在本轮文件、不 import 本轮任何模块（上一轮同命令 exit 0），不代修。Breaking Change：No。

## 新对话沿用最近打开的工作目录（2026-10-25，当前 Agent 直接执行，未 commit/push）

用户附欢迎页截图指认「新对话没有工作目录，要记住最后打开的会话所在的工作目录」，替代 §18.1.1/§17.13.1 原有「不沿用当前目录」的决定。实现只落在 `CollaborationView.tsx`：工作区级新对话（`?new=` 且无 `?dir=`/`?work=`/`?project=`/`?session=`）挂载即以 `recentWorkingDirectories` 首项为种子，走与左栏「＋」完全同一条 `openFolder` 链路（在途禁发、慢路径取消、回执核对、首条绑目录全部复用）；慢路径「取消并回到新对话」同时写 sessionStorage 取消标记（按 `?new=` 键），使显式 `?dir=` 取消后的重挂载与续记取消都不再自动打开。目录语义变更归 [workbench-design §18.1.1/§17.13.1](../frontend/workbench-design.md#1811-新对话直接起步2026-10-05-接续实施)。

**已验证**：`folderFirstConversation` 34/34（新增「续记走 openFolder 核对」「慢路径取消后不再续记」两条，后者覆盖同键重挂载）、`narrowWindowNewConversation` 单元 4/4 与浏览器 6/6（原「目录作用域不跟着带过去」两条改为锁新行为：目录沿用、任务上下文仍不继承、第二次 open 落账用 `expect.poll` 防重挂载竞态）、`newConversationEntry`＋`assistBinding` 20/20（「明确新对话不恢复旧会话」在无本机记录时仍零写命令）。**未验边界**：真实 Windows/WebView2 桌面实窗未复验；慢路径取消为真实 4s 等待用例，未注入更长时延；独立验收未做（按规则标记，不将自检改称独立验收）。

## 基础 Agent 执行能力与聊天 UI 独立验收（2026-10-25，当前 Agent 独立复跑＋定向修复，未 commit/push）

两个已知 P0 复验闭合：**P0-1** 暂停/取消提示由服务端 `goalStatus` 驱动（`PAUSING`/`CANCELLING` 先判，不按会话模式推断目标去向），**P0-2** 可恢复正文草稿／离开即丢的未持久化输入／已提交待按原 `command_id` 核对三类状态互不冒充，本轮补齐「暂存附件切讨论」这一路缺的回归。后端闭环、Supervisor 收敛、权限边界与三种模式准入以真实临时 PG 15 套件取证；UI 侧 DEV-0110（含 1162×782 报障现场）、DEV-0117、DEV-0103 由真实 Chromium 复跑。同时修掉四处测试自身缺陷：`folderFirstConversation` 用例预算被产品 4000ms 阈值吃穿造成同文件 24 例假红、`composerImageAttachments` 未等 jsdom 图片探测回退、两份浏览器规范仍锚在已删除的 `.agent-chat-source-options`、命中率稳定性缺 1162×782 档。同日第二轮独立复跑再收一处版式偏差：普通会话右翼把 2026-10-24 新增的工具面板键排在「工作详情」之后，违反 2026-10-17「详情固定在最后」，已在 `CollaborationView.tsx` 调整键序（详情仍最后），对应规范改为锁两键顺序、组贴右缘、两键同档，最终 10/10。同日第三轮复跑再收两处并行改动引入的回归：目录取消未摘 `dir`（`folderFirstConversation` 34/34 exit 0）与 `ChatCommandInput` 漏导 `useMemo` 导致 `/agent` 整页崩溃；浏览器三规范逐份隔离 3/3、3/3、10/10 exit 0，API `typecheck`／`build` exit 0，全量单测在显式 Node 24 下 943/945（唯一失败为缺发布夹具的 `restore-runtime-probe`，exit 1）。成绩、依据与未验边界见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)对应行。

**仍未闭合**：真实 Windows/Tauri/WebView2 实窗与关窗保护 `NOT_RUN`（本机无运行中的桌面实例）；`runAssistGoalTick` 只有集成覆盖、无函数级单测；860×800 窄窗浮层按自身芯片锚定会盖住换行后第一行的模式芯片（单枚浮层互斥、无不可点控件，判 P2，属版式设计范畴）；Workbench 全量 `tsc --noEmit` 当前被他人在跟踪外测试 `tests/projectPlanningFlows.spec.tsx:391` 的 TS2322 阻断（非本轮文件，`src/**` 单独 exit 0）；API 全量单测唯一失败 `restore-runtime-probe` 缺 `-TestPackage` 发布夹具。

## 禅道批次第八轮：会话删除＋读取失败恢复七条（2026-10-24/25，子代理串行修复＋协调集成，未 commit/push）

接续第七轮领取 8 条（#119/#113/#115/#132/#122/#103/#128/#134）全部交回；另按 #119 审计发现新登记 2 单（#157/#158），并行会话同期新登 2 单（#155/#156）。激活余 57 条：

- **#119（会话删除 500）核实处置**：修复已在本工作树提交 `aee2496c` 完成——deleteSession 按 grants→rounds→解除消息 goal 引用→goals→plans→delegation_attempts→delegations 显式顺序清理、0133 迁移补 0127/0128 六表 DELETE 授权、阻断面覆盖 0128；本批复跑探针绿（计划会话 200 清理）＋`assist-session-delete` 集成 18/18，按 fixed 交回、零代码改动。**审计新发现两缺口并钉红探针另立单**：#157（0132 撤回账本族未纳入删除，relay_app 缺 DELETE 授权＋快照 refcount 口径）、#158（0125 memory_auto_captures 双外键不在阻断面也不在清理面，需先定口径）——两者均随 #119 证据链登记，修复归属 0132 特性与记忆 Owner。
- **读取失败恢复族（#113/#115/#132/#122，子代理修复）**：#113 ProjectTasksView 依赖读取状态化（读取中/失败/确实空四态＋同项重试＋403 失权撤下，探针红→绿 detailReads 1→2）；#115 useRunToolCalls 成功分支结清旧 failure（新快照不再与「当前不可读」并存）；#132 ActivityView 新首页查询重置续页 Loading（刷新后不再卡死「正在读取后续页」，requestVersion 检查保留）；#122 AssistView 投影读取失败不再静默清空（错误提示区分 403/404 与暂时性、assist-refresh 覆盖投影＋页内重试，并行会话在途 diff 全程保留、中途对方再写入后逐项核对三处改动健在）。新增回归 4 spec 15 例，相关 11 套件 107 例全绿。
- **首读重试入口族（#103/#128/#134，子代理修复）**：#103 ComposerTargetPicker 显式 retryProjects（不自动清错误防请求风暴，任务清单侧由并行 useProjectTaskPages 迁移自带 retry）；#128 WritePermissionControl 新增只读重新核对（两作用域、checking 防重复、读到投影才清错误、与写命令待核对不混用、零 command_id）；#134 RecentWorkRail 归档读取状态化（渲染优先级修正，失败不再被占位遮住、失败不伪装空列表、错误仅影响归档段）。新增回归 16 例，writePermissionTier 32/32。
- **并行共存**：本批全程与并行会话（0132 撤回重构、插件面板、ProjectPlanningView 等）同树作业；AssistView/ComposerTargetPicker/RecentWorkRail 三处并行在途文件均按「先读 diff、定点编辑、事后复核」处理，双端 tsc 本批文件零错误（工作台剩余错误均在并行会话未跟踪文件 pluginIcons/projectPlanningFlows/ProjectPlanningView，属其在途工作）。

**族外存量红只报不修**：composerTargetPicker「任务要经过项目」一例与并行会话把组件迁到 getProjectTaskPagesPage 中途状态冲突（开工前基线同名复现）。**未验边界**：独立验收未做；除 #119 有真实 PG/HTTP 证据外均为 jsdom/受控 fetch 组件级；真实浏览器、真实故障注入、Windows 实窗未复验。成绩与未验边界归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「禅道批次第八轮」行。剩余激活 57 条全 S3；下一批建议：图片/草稿与上传族（#135/#136/#137/#138/#139）、待核对存量（#123/#124/#125/#126）、投影与轮询（#116）、模式切换与续页（#127/#129/#130/#131/#133）。

## 未归属会话的插件执行：电脑/浏览器操控哪里都能用（2026-10-25，当前 Agent 自检，未 commit/push）

用户附工作区级会话截图指认「@电脑操控 打开浏览器」得到「这条会话还没有归入任何项目，因此没有可用的电脑操控连接」，要求插件不依赖会话归属。事实核对后确认三层门：`assist-runner` 主流程路由只看只读工具（零工具的未归属会话走纯文本路径，拿不到执行候选协议）；阶段 C 落库门要求 `working_resource_id` 非空；`claimExecutionRequest` 要求会话绑定 Project。电脑/浏览器插件是安装级资源、按项目登记连接，机器动作在账本上必须绑受管资源（0126 矩阵），因此**不新增 origin/迁移**，改为借用归属：

- **主流程路由**（`assist-runner.ts`）：未归属会话在工作区存在可借用的机器插件（声明 COMPUTER_INPUT/BROWSER_ACTION 的 ACTIVE 连接 + 其归属项目仍有 ACTIVE 受管资源，`resolveWorkspaceMachineAttribution` 单一解析）时，零工具也走 AGENT_MAIN_LOOP；`agentMainLoopSystemPrompt` 新增 `readTools=false` 分支如实声明零工具并保留执行候选协议。
- **借用落库**（阶段 C）：仅「纯操作候选」（interaction=COMPUTER/BROWSER、无文件改动、无检查）借用归属落成执行请求；文件类候选照旧要求归入项目。归属不可用时**不落行也不拖垮回复结算**。
- **claim 归属解析**（`conversation-execution.ts`）：未归属会话带 `machineCapability` 时借用连接归属项目与其最早 ACTIVE 受管资源；缺连接按类型化原因拒绝；不带机器能力的直入路径维持「必须绑定 Project」旧规则。`planToolLoop` 对借用执行**收敛词表**——只给本次 interaction 的机器族工具，借来的受管根不给文件、Git、检查工具（不是用户的工作范围）。Task 记在插件连接归属项目名下。
- **能力事实块**（`assist-capability-notice.ts`）：未归属会话不再说「没有任何工具连接可用」，改为分别说明电脑/浏览器插件可用（指引 `interaction="COMPUTER"/"BROWSER"` 执行候选）或工作区未登记连接。
- **Workbench**（`AssistView.tsx`）：工作区级会话（无 target）也加载执行请求回执，任务轨迹与摘要沿既有面板展示。
- **仓储**：`gateway-repository` 新增 `listActiveConnectionsByCapability`（跨项目按能力找 ACTIVE 连接；文件族不走此通道——目录边界就是项目边界）。

**已验证**：API `tsc -p` exit 0；单测定向 `assist-capability-notice`＋`assistant-readonly-round`＋`conversation-prompts`＋`agent-runtime-prompts`＋`conversation-execution` **60/60**；真实临时 PG 集成新增 `conversation-machine-plugin` **7/7 PASSED**（未归属会话纯电脑/浏览器候选借用链路到冻结信封、文件候选不借用、无连接/无资源负例、原入口 typed 防线×2）；回归 `agent-main-loop-execution`（单独 **32/32**）＋`conversation-execution-autostart` **20/20**＋`agent-conversation-main-loop` **4/4**（三套件合并首轮曾出 1 次未定位红，同参数立即重跑与拆开重跑均全绿，判负载下偶发）。Workbench `tsc --noEmit` 本片文件零错误（全量仍被并行 `composerTargetPicker.spec.tsx` 既有错误挡住）。

**限制**：借用执行真实 Run 内的桌面动作链（租约/审批/Esc）未在真实 Windows 复验——信封断言停在冻结工具循环层，运行时链路沿用 computer-control 既有验收；真实模型对 `readTools=false` 模板与插件指引的遵循度未实测（FakeModelPort 单发信封）；并行工作树 40+ 未提交文件全程未触碰。**文档**：[agent-prompt-design §4.1](../architecture/agent-prompt-design.md#41-会话能力事实块2026-10-20-第二轮已实施)、[工作台 §36.6](../frontend/workbench-design.md#366-未归属会话的插件使用2026-10-25-已实施)、验收表本轮行。

## 任务与计划系统 P0–P2 实施接续（2026-10-25，当前 Agent 自检与整改复验，未 commit/push）

本轮补齐回执恢复和估时边界：N04 计划/范围命令核对身份、状态及读回对象，SELECT_SCOPE 校验项目；读回失败不清待核对命令。N06 CREATE/AUTHORIZE/STOP 同样保留原命令与载荷恢复，丢失创建回执后选择确切新链。用户估时覆盖执行、等待、复核、人工与经过时长，保存来源、毫秒安全换算、Task/估时 revision CAS、成功读回及旧验收不适用提示。P0/P1 基础实现仍由既有 Owner 承担：allowed_actions 投影、任务分页/切换隔离、N04 计划和推演、N06 单独授权任务链。

**已验证**：API 与 Workbench `tsc --noEmit` exit 0；Workbench Vite build exit 0；本轮目标 Workbench 两个 Vitest 文件 **21/21**（含 `PROPOSE_PLAN` 错项目回执保留 pending 后按正确原回执恢复并选中计划；`PROPOSE_SCOPE`、`SELECT_SCOPE`、`RESOLVE_ITEM` 未知回执错配后保留 pending、按原回执恢复并读回确切对象）；另 API 客户端 `taskChainsClient.spec.ts` **2/2**（包含错 `command_id` 回执拒绝）。受控 API Chromium **2/2**；隔离真实 PG/HTTP 十个 suite **71/71**；本轮执行 apps/api/scripts/run-integration.ps1 -UseCLocale -TestFile ...，未用 -SkipBuild，迁移包含 0136_artifact_task_workspace_scope，脚本 status PASSED，build/test/业务迁移/Graph 安装/PG 启停 exit 0，临时集群已清理。任务链 HTTP 覆盖缺准则/产物、未解 blocker、BLOCKS 顺序四类拒绝；任务分页 Hook 覆盖 120 项、去重、同游标重试、暂态失败保留、失权清空与切换迟到响应隔离。

**限制**：Workbench 全量尝试以 `--isolate=false` 运行后出现跨文件失败并被中止（exit 1），不能判全量通过；分页消费者三文件默认隔离复跑 **23/27**，4 个失败分别为知识导读按钮文案预期和 ComposerTargetPicker 对旧 `getProjectTasks` 调用的断言，本轮未扩修。独立复核未完成：C2C `workspace_info` 已确认工作区为 Relay-Agent；专用浏览器运行时和已保存的 ChatGPT 对话标签已打开；进入保存对话后页面退回 ChatGPT 首页并提示“浏览器检查未能完成”，按提示重载一次后仍超时，因此未发送 INIT/EXECUTED。真实 Windows/WebView2 未运行：当前无已构建桌面包或运行窗口；桌面验收构建会重写共享 API/Workbench 构建产物，本轮未在共享工作树启动该构建。Provider 和完整 N04/N06 使用收益也未运行。`node scripts/check-docs.mjs` exit 1，报告 27 个全仓缺失本地链接；未涉及本轮更新段落。

文档同步：[HTTP 契约 §10.77](../api/http-command-contract.md#1077-基础有限-markdown-任务链2026-10-14-协议)、[工作台 §18.7/§19/§21](../frontend/workbench-design.md#187-目标与任务的轻量起步)、[验证计划 §28/§30](../testing/verification-plan.md#28-基础下一段工作计划检查范围)、[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。实现入口：`apps/api/src/application/task-readiness.ts`、`apps/api/src/application/task-chains.ts`、`apps/workbench/src/lib/useProjectTaskPages.ts`、`apps/workbench/src/views/ProjectPlanningView.tsx`、`apps/workbench/src/views/ProjectTaskChainsView.tsx`。


## 待核对弹窗补离开出口＋弹层重排（2026-10-25，当前 Agent 直接执行，未 commit/push）

用户附「新建目标」页截图指认：命令结果待核对时弹窗只有「保留并继续编辑」一个出口，人被锁在页面里；并要求顺带优化弹层 UI。事实核对：#20/#22 的「只拦不放」把有恢复途径的命令也一并锁死——CreateGoalView/GoalProjectLinkPanel/TodayView 的原 ID 本就按作用域持久化、回页即恢复，协作页恢复区（collab-recovery）也按 sessionStorage 保留命令身份，硬拦与恢复设计自相矛盾。按最小实现修复，**不改任何命令发送/回执核对逻辑**：

- **DraftGuard 新增可选 `pendingRecoversAfterLeave`**：守卫自报「离开后回原入口仍能核对」；合并守卫要求所有在拦待核对命令都可恢复才放行出口，任一不可恢复维持只拦不放（默认 false，ReviewDecisionPanel/TaskAcceptanceEditPanel/WebImportPanel/KnowledgeView/定时任务族等无恢复途径的守卫行为不变）。
- **App 路由守卫弹层**：待核对态重排——副标题「离开不会取消这条命令」、正文区分可恢复（离开保留原 ID，回页继续核对）与不可恢复（说明为何拦）两种口径、原命令 ID 以 `.hash-code` 短码独立成行（`.dialog-command-id`）；「保留并继续编辑」在待核对态更名「留在本页核对回执」（草稿态不变）；可恢复时新增「离开并保留待核对」（`pending-keep-and-leave`，`blocker.proceed()` 不清任何状态）。**关窗弹层**同口径重排，新增「仍要关闭窗口」（`pending-close-anyway`，明示重开后不再提醒、生效结果去列表确认、不要重复创建）——关窗是用户显式决定，不属于应用侧盲重试。
- **CreateGoalView/GoalProjectLinkPanel/TodayView** 上报可恢复；**协作页**以「pending 已进恢复区」为判据上报，页内切换弹窗（requestTransition）保留 proceed 并新增「切换并保留待核对」（`collab-pending-switch`）。切换出口先把导航状态摘下（`navigationRef = cleanNavigation`），否则新会话首轮「无待核对」上报会被 reportNavigation 当成收口、把恢复区里未核对命令过滤掉。
- **已运行**：`goalPendingGate` 7/7（新增离开出口往返用例）、`narrowWindowNewConversation` 6/6、`newConversationEntry` 16/16（断言无任务作用域不出现离开出口）、`collaborationWorkspace` 83/84（新增切换出口用例；仅剩的「会话选项Escape」红为并行会话 AssistView 重写删掉 `agent-chat-source-options` 类的存量断裂）、`reviews` 28/28（断言面板 pending 无离开出口）、`taskAcceptanceEdit`＋`navigation`＋`knowledge` 50/50、`folderFirstConversation`＋定时任务族恢复回归全绿、`todayCommandRecovery/todayFormBaseline/todayView` 22/22。`tsc --noEmit` 本片文件零错误（全量仍被并行 `managedFileBrowse.spec.ts` 8 条既有错误挡住）。**文档**：本条即 CODEX_NEXT_STEP；验收表未新增行（属既有 #20/#22 行为的出口补齐，随下批验收归档）。
- **未验边界**：真实 Windows/WebView2 关窗路径（`pending-close-anyway` 仅在 Tauri 环境可达，jsdom 未覆盖）；视觉只核对过结构 token 未截图过真实渲染；独立验收未做。

## 「+」菜单补齐参考图三项：上传附件、文件、我的产物（2026-10-24，当前 Agent 直接执行，未 commit/push）

用户附参考产品加号菜单截图指认「红框部分还差一点」，并在范围问询中选择「补三项真实入口」。按最小实现落在 `apps/workbench/src/views/AssistView.tsx` 的 `ComposerAttach`，**不改后端、迁移、路由与既有四项的 `data-testid`**：

- **上传附件**：一级直接动作，隐藏 `<input type="file" accept="image/*">` 交给既有 `useStagedAttachments`；只编辑本次输入，不上传、不发送。
- **<工作目录>的文件**：二级按 `getGatewayConnections` 取 `FILE_QUERY` 连接，用后端已实现的 `readManagedFileState` 列受管根一层；同面板内进子目录/返回上级，文件插入 `@相对路径 ` mention；截断/跳过/失败/未决与缺口各有文案，失败不显示为空目录。
- **我的产物**：二级按当前 `taskId` 读 `getTaskArtifacts`，点一项插入 `@标题 vN ` mention；无任务归属说明去向，不跨任务猜清单。
- **边界**：文件与产物只是草稿 mention，不是消息附件/资料来源，也不授予权限；任意本地文件作为消息输入仍未接入。

**已运行**：`tests/composerAttachMenu.spec.tsx` **35/35**（新增四组用例：上传、文件读取与导航、文件失败/截断、产物）；`AssistView.tsx` 定向 `tsc --noEmit` exit 0；`vite build` exit 0。工作台全量 `tsc --noEmit` 当时被并行会话在途的 `tests/managedFileBrowse.spec.ts` 挡住；`assistantModeSwitch` 的「资料入口邻接」1 红为登记在案存量，与本片无关。**文档**：工作台 §32.1/§32.2/§32.3/§32.5/§32.8/§32.17、§33 段末与验收表本轮行。**未验**：真实 Windows/WebView2、真实 Chromium 几何、真实 API＋真实受管目录读取、原生图片选择器在 WebView2 的打开/取消；独立验收未做。

## Qoder 会话接续：空 diff 不占位确认＋「未开始」判据改读时派生（2026-10-24，当前 Agent 直接执行，未 commit/push）

接续 Qoder 会话 `edf6c298…` 的两个未完成任务（源自 WorkBuddy 会话 `4ae726ee`「无 git diff 时隐藏红框部分」与 `6f608295`「解释未开始状态的含义」，两会话均因 429/额度中断）：

- **任务一已实现并复核**：`ConversationDiffSummary.tsx` 的 `nothingToReport` 使「完整且空」与首读中整行不渲染；缺起点/非 Git 根/失权/读取失败仍出现。复跑 `conversationDiffSummary.spec.tsx` **29/29**；真实链路与三态截图证据已在验收表「会话 diff 入口」行。
- **任务二解释**：左栏「未开始」= 这段讨论还没有落过一条消息（不是任务状态、不是未读；行首圆点是未读，两者独立）。**同日接续用户已确认的加固**：标记与分叉入口的判据由 `lastMessageAt === null` 改为服务端读时派生的 `has_messages`（`exists(select 1 from assist_messages …)`）。API 列表逐行附带、单条 GET 单独派生（`readAssistSessionWithActivity`），HTTP `AssistSessionDto` 与前端 DTO/parse 同步；旧服务端缺字段时客户端按活动键回落。`last_message_at` 只保留排序职责。
- **已运行**：真实临时 PG18.6＋HTTP `assist-session-controls` **23/23 PASSED**（新增「活动键为空但确有消息」用例）；`sessionRowMenu.spec.ts` **26/26**（新增反例）；`conversationDiffSummary.spec.tsx` 29/29；`apps/api tsc --noEmit` exit 0。工作台全量 `tsc --noEmit` 仍有错误，但全部位于并行会话在改文件（`FileBrowsePanel.tsx`、`goalManagementLayout.spec.ts`、`relayClient.ts` 未用类型），本片文件零错误。
- **文档**：HTTP §10.91、数据库 §112、工作台 §28.1、验收表「左栏未开始误标」行。**未验**：独立验收、真实 Windows/WebView2；两个 0135 迁移编号重复仍未裁决（运行器按文件名各自登记，已实测两迁移均可应用）。

## 正式目标管理与项目状态写入：P0–P2 实施＋自检（2026-10-24，当前 Agent 直接执行，未 commit/push）

按任务书完成三阶段实施。**P0-A**：CreateGoal 与 LinkProjectGoal 的成功响应/原回执核对 `command_id`、Project、目标 Goal 与预期 revision（错配不清 pending、不宣布成功、不自动重发），续页 401/403/404 撤下受保护项目；新增 9 条反例先红后绿。**P0-B**：新增 `/goals` 列表（三范围、游标、去重、续页重试、失权撤数据）与 `/goals/:id` 详情，接入 EditGoal/ArchiveGoal、Project 改名、解除关联的 `explicit_task_ids` 影响清单与 `GOAL_LINK_IN_USE` 重确认。**P1-A**：修复真实缺陷——`StateCommandBodySchema` 的 action 联合漏 `ADD_BLOCKER` 且缺 `target_kind/target_id/reason`，HTTP 入口此前必然拒绝；新增 `ProjectStatePanel`（阶段按类型限词、下一步仅本项目任务、风险/阻塞/解除，单一 action＋State revision CAS＋冻结回执）。**P1-B**：Goal 详情与 `/working-directories/:id` 只读工作上下文，会话保留原 `session` 深链接。**P2**：Goal 详情汇总关联项目进展与 x/y 覆盖、失败项目单列；项目总览补 State 风险/阻塞、最近 5 条活动与覆盖说明。

**已运行**：工作台定向 **41/41**（`goalManagementLive` 8、`projectManagementPanels` 7、`goalProjectLink` 11、`goalProjectLinkPagination` 4、`createGoalEntry` 9、`goalPendingGate` 2 个新增相关用例）；真实 Chromium `goalManagementLayout` **2/2**（宽窗键盘/语义与 390px 无横向溢出、右栏抽屉 Esc）；真实临时 PG18.6＋HTTP `api-state` **11/11**（新增 ADD_BLOCKER 用例，schema 回退时先红、恢复后转绿）、`project-goal-maintenance` **4/4**（新增 P0 端到端场景：两项目关联→编辑→改名→解除→归档→历史可读）、`work-contexts` 2/2，合计 **17/17 status PASSED**。受影响既有回归 79/81：`projectOverview` 的 daily-view-confirmation 红在 HEAD 基线工作树复现（用例未桩 `GET /projects/:id/daily-continuation`）；`projectWorkbench` 的「和/与」文案断言与未改源码不一致；`taskSkillLive` 的 `assist-new-session` 红在 HEAD 基线复现。三条均非本片引入、未代修。

**2026-10-25 复验与修复**：独立只读审查发现 P1 命令恢复缺陷：Project 改名的 2xx 回执错配会因普通 Error 分类而清除 pending；State 与 Goal 的 2xx 契约解析异常也被当作明确拒绝清除 pending，可能允许同一事实换 command_id 重提。新增四条组件回归先红后绿；将改名字段错配改为专用响应错配类型，并把 RelayContractError 归入结果不明后，Workbench 六个定向文件 50/50。真实 Chromium 宽屏首轮 load 超时、窄屏通过、宽屏隔离复跑 1/1；临时 PG 合并首轮 api-state 未就绪失败、其余两套 6/6 通过，隔离重跑 api-state 11/11；Workbench tsc --noEmit 与 Vite production build 最终 exit 0。功能地图目录关系检查 exit 0；check-docs 仍报告 27 条仓库既有失效链接，与本轮改动前的 27 条相同，且没有一条指向本轮修改文件。独立只读复查确认修复后无其他 P0/P1；真实 Windows 详情/State/窄窗/多 DPI 仍未验。根因与防复发见 [开发记录](2026-10-25-command-response-recovery.md)。

**真实桌面验收（2026-10-24，Computer Use，部分完成）**：真实 `relay-desktop.exe` 窗口内已验证项目页「目标列表」入口、`/goals` 空态与范围导航、`记录目标` 表单输入与真实 CreateGoal 提交。**抓到并修复两处真实缺陷**：①`goals.revision` 数据库默认值为 0，而 CreateGoal 回执核对把「新建必为 v1」写死，真实成功响应被误判为错配并留下 pending；改为 v0 并同步 6 处夹具。②回执 404（`COMMAND_NOT_FOUND`）被 `isScopeLost` 先捕获，误清项目列表并隐藏关联提交入口；调整为先处理 COMMAND_NOT_FOUND。修复后工作台定向 41/41。桌面 Goal 详情、State 面板与 390px 窄窗尚未点验：Computer Use 被用户物理 Esc 停止，需恢复后继续。

**并行阻塞（2026-10-24 当时）**：并行会话新增 `apps/workbench/src/components/FileBrowsePanel.tsx` 停在半成品，孤立重复行导致 Vite 语法错误并阻断桌面与全部测试；本 Agent 只移除两条孤立重复行、未改语义，原文件备份于 `.relay-test/parallel-blocked/FileBrowsePanel.tsx.broken`（SHA-256 `73469BBF…F2A03`）。该文件与 `AssistView.tsx` 的类型错误仍在，工作台 `tsc --noEmit` 当时被这些并行文件阻断；本片文件在并行改动落地前曾 exit 0。

**未验边界**：独立实机验收未做（独立代码复查已完成）；桌面 Goal 详情/State/390px、多 DPI、全量工作台套件；`feature-map --check` 报告验收表已通过；check-docs 仍报告 27 条历史缺失链接，与改动前同数。完整证据归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「正式目标管理与项目状态写入」行，交互归[工作台 §51](../frontend/workbench-design.md#51-正式目标管理与项目状态写入2026-10-24已实施实机未验)。

## 工具面板「文件」页签后端：人工受管目录浏览与文件读取（2026-10-24，当前 Agent 直接执行，未 commit/push）

用户指令「开发工具面板的后端」（附右侧工具面板截图）。核对结论：六页签中网页（P0–P2 已落地）、变更（git-read）、运行记录/轨迹/执行输出（既有 Run 投影）均有后端，真实缺口是文件页签的**受管目录浏览与工作目录文件读取**——面板文案明示「目录浏览接口尚未接入」，0058 起 `USER_ACTION` 词表只放行 GIT_READ，tool-adapters 明记「人工触发的目录浏览仍无公开入口」。按推荐口径实施（用户未答范围问询）：只开 LIST_DIRECTORY＋READ_FILE，FIND_PATHS/SEARCH_TEXT 与交互终端不做（终端协议仍待设计）：

- **迁移 0134**（apps/api 与 src-tauri/resources 两处镜像）：只放宽 `ck_logical_operation_resource` 一支（FILE_READ/FILE_QUERY×USER_ACTION×绑定资源，正文以 0126 最新版逐支重述）；不建表、不回填、不改另两条 CHECK。
- **词表**（gateway-actions.ts）：`originAllows` USER_ACTION 分支改「能力×动作」双维放行；单测先红后绿抓到并修复一处真实漏洞（FILE_READ 动作名单误含 LIST_DIRECTORY，错位组合可借道）；prepare 的 USER_ACTION 分支按动作归一目标（原实现把 target 一律折叠成受管根本身，目录子路径被丢弃——集成探针定位后修复），admit 根内判定与 0060/0087 会话读取同口径，FILE_QUERY 派发 managedRoot 不再退化为查询目录自身。
- **新模块与端点**：`application/file-user-action.ts`＋`POST /projects/:p/managed-resources/:r/file-read`（api/file-user-action-api.ts，routes.ts 注册）。动作身份**纳入 command_id**（与 git 人工读取的仅参数确定性分界）：同命令崩溃重投只执行一次适配器、新命令产生新读取事实——目录浏览因此可刷新；审计事件 MANAGED_FILE_READ_REQUESTED 同事务落账；权限/排他/回执全复用 Gateway 既有裁决。
- **验证（实施者自检）**：真实临时 PG＋真实目录＋真实 HTTP——`file-user-action` 集成 **17/17**（含 ASK 确认链、类型化失败不折叠、幂等/崩溃重投/新命令新事实正反例、DB CHECK 行级守卫、迁移正文只放宽）；受影响回归 `git-user-action` 15/15、`gateway` 3、`gateway-reconcile` 6、`assistant-readonly-round` 6、`assist-session-tool-calls` 30、`agent-main-loop-execution` 32（会话写 admit 分支同改）、`local-directory-access` 8 全绿；词表单测 4 文件 55/55；`apps/api tsc --noEmit` exit 0。
- **文档**：tool-adapters 2026-10-24 段、HTTP §10.112、数据库 §113、workbench-design §14.9（三处「无服务端接口」表述更新）＋§50.6、验证计划 §20.7.1、验收表新行；`check-docs` 本片文件零错误。
- **交付**：前端提示词 [prompts/devtools-file-browse-frontend.md](../../prompts/devtools-file-browse-frontend.md)（连接选择复用 GitReadPanel、树形懒展开、三态硬性要求、测试范围）——前端接线未做，不构成授权当前 Agent 实施。

**剩余限制**：前端未接线（占位文案保留）；独立验收未做；真实 Windows junction/替换窗口沿 FILE_READ/FILE_QUERY 既有未闭合限制。**并行冲突观察**：工作树出现**两个 0135 迁移**（`0135_assist_session_last_message_backfill.sql` 与 `0135_workspace_context_budget.sql`，分别属不同并行会话，数据库文档 §112 归前者）——两者均不碰本片约束、互不冲突于运行面，但编号重复违反迁移惯例，需协调方重编号其一，本片未代改任何并行文件。

**同日前端接线（用户指令「继续做前端」，按本 Agent 交付的前端提示词执行）**：`FileBrowsePanel`（新组件）挂入「文件」页签受管目录列表之下——连接按能力分选（浏览 FILE_QUERY／读正文 FILE_READ，缺任一给独立指引与反馈）；树形懒展开（展开未读目录才发命令、收起再展开用快照、行内「刷新」强制新 command_id）；文件预览显示正文＋size＋sha256（只读）；三态硬性要求落地（截断显式、类型化失败不折叠成空目录、ASK 等待无结果字段＋Review 链接＋批准后沿原命令继续）；命令身份四阶段恢复沿用 GitReadPanel 同一套 sessionStorage 模式。API 层新增 `readManagedFileState` client 方法＋DTO/parse（复用 git-read 同构链路）。过程中抓到并修复两处组件缺陷：失败后 open-root 的守卫挡住重试；等待批准期间目录行悬挂「正在读取」。验证：新 spec `managedFileBrowse` **8/8**＋受影响回归 `devToolsPanel` 6/6、`gitReadPanel` 21/21、`browserPreview` 11/11、`gitReadClient` 13/13；工作台 `tsc --noEmit` 本片文件零错误（全仓剩余错误属并行会话 AssistView 在途）。**并行观察**：并行会话正基于同一 client 层在 AssistView「文件」二级入口实现另一处浏览（在途、含 TS 未收窄错误），两入口并存的产品归并待裁决，本片未触碰其文件。前端实机（真实浏览器/Windows/WebView2、真实 ASK 审批）未验。

## 三插件接续：GitHub 官方 Skill 登记、浏览器 Run 停止入队修复、安装级状态接线、电脑真实输入复验（2026-10-24，当前 Agent 直接执行，未 commit/push）

用户 `/goal` 指令「三个内置插件（GitHub/Chrome/Windows 电脑）完整接续」。先核对工作树（40+ 并行未提交文件，全程未触碰其文件），按 P0→P1→P2 顺序落地四件事：

- **GitHub 官方 Skill（§10/ADR-023 的最大遗留缺口）**：新增 `apps/api/src/skills/official-skills.ts` 独立登记（不进被归档校验冻结的 `FIRST_PARTY_REGISTRY`）——不可变身份 `github-gh@4537a92f…`、许可 MIT、来源 `cli/cli` 入登记；随包 `SKILL.md`、新增 Relay 边界附录 `skills/builtin/gh/RELAY_NOTES.md`、`LICENSE` 三文件按钉住 SHA-256 逐字校验（缺失/篡改即失败关闭，不注入）；**按需激活**＝当轮词表真实出现 `github_` 工具时在主流程 system 能力事实块后附加约 1 KiB 冻结摘要与边界块（上游 20 KB 正文从不进上下文）；`RELAY_OFFICIAL_SKILL_GITHUB=disabled` 设备级禁用（与 `RELAY_BROWSER_PROVIDER` 同一承载先例，界面入口留待后续）。上游正文未改一字；打包链核对确认 `package.json` `files` 与 `build-release.ps1` 校验均已含 `skills/builtin/gh`，`UPSTREAM.md` 过时的「尚未随包分发」接线状态行已更正。单测 `official-skills` **13/13**（身份冻结、三文件逐字校验红绿、无工具不注入、禁用生效、注入块与附录同源防漂移）。`assist-runner.ts` 主聊天路径接线注入；人设档/子代理/Run 轮次暂不注入，为已记边界。
- **GitHub 只读片收尾**：`github-read.integration.test.ts` 的逐动作列表由四个补齐为五个（`GITHUB_ISSUE_VIEW` 进 `GITHUB_ACTIONS`/`GITHUB_TOOLS` 与已认证用例的逐动作/回执断言）；真实临时 PG 集成 **8 通过＋1 跳过**——已认证用例因本机无 gh 登录态（`%APPDATA%\GitHub CLI` 不存在）保持 skip，如实记 NOT_RUN。**GitHub 写动作边界**：按任务书在[工具适配器 §4.2](../architecture/tool-adapters.md#42-github-写动作最小工程协议2026-10-24-冻结未实施) 冻结最小工程协议（`GITHUB_WRITE`/RUN 来源/幂等键/逐动作只读核对/UNKNOWN 禁盲重试），未实施、未放权。
- **浏览器 P0 缺陷（本轮最重要的修复）**：`requestBrowserSessionStop` 复用电脑 Esc 通道 `requestComputerControlStop`，而纯浏览器的 Run 根本没有 `computer_control_state` 行——`markStopRequested` 失败抛 409，**CANCEL 入队随同一事务整体回滚**，浏览器 stop 返回 200 却没有任何控制意图落库、任务永远停不下来（`browser-actions` 集成用例 `control_request_id` 断言 object≠string 暴露）。修复：新增 `requestBrowserRunStop`（锁内核对执行权→入队 CANCEL，不依赖电脑操控单行 CAS；电脑展示位尽力刷新），`browser/sessions.ts` 改走新通道；集成由红转绿 **PASSED**（6 通过＋1 真机用例显式 opt-in 跳过）。规则已写进[工作台 §36.3](../frontend/workbench-design.md#363-浏览器使用现有-chrome-的非激活标签页)。
- **统一体验**：`/plugins/status`（HTTP §10.104）此前在**前端零消费者**——连接页「本机运行时是否就绪回到会话的插件面板核对」与会话面板「运行时诊断归连接页」互指成环。`ConnectionsView` 三插件行新增 `connections-tool-runtime-*` 安装级状态（就绪/未安装/未配对/未登录/不可用＋悬停原因与补救，读取失败仅本行如实说明），与「已连接/已授权」分开呈现；`connectionsSettings` **31/31**（新增 2 例）。工作台 `tsc` 本轮文件零错误（全量仍被并行在途文件挡住）。
- **电脑**：`installShutdownHandlers` 补 `shutdownComputerRuntimeClient()`——API 停机时回收懒拉起的 runtime 子进程，不留孤儿输入通道。**真实 Windows 输入复验**：复用 10-18 遗留的自有测试记事本（内容即那条固定标记、无敏感内容），`RELAY_TEST_COMPUTER_WINDOW_ID` 显式 opt-in 跑 `computer-control` 集成 **11/11**（此前多轮该用例因桌面会话阻塞跳过；本轮桌面会话可访问，真实键鼠输入经完整 Gateway→桌面租约→Runtime 链落盘，截图读回确认两段标记并留档 `output/acceptance-raw/computer-browser-github-20261024/`）。

**同日验收接续（用户指令「开始验收」，同一 Agent 实施＋复验，不冒充独立验收）**：按验收角色重跑全部声明测试并补两处证据缺口，**抓到并修复一处实施缺口**——①官方 Skill 注入初版只接普通 Agent 主流程，验收新增的集成正例经人设档（ASSISTANT_READONLY）夹具实测**不注入**；已把注入下沉到只读轮次共用执行器 `runSessionReadonlyRounds`（`assistant-readonly-round.ts`，跟随工具而不跟随会话模式，人设档/普通 Agent/子代理一致覆盖），并补三例集成断言（system 携带 `github-gh@4537a92f` 身份与边界块且不含上游正文、停用连接后消失、`RELAY_OFFICIAL_SKILL_GITHUB=disabled` 不注入且工具词表不受影响）；②`GET /plugins/status` 补真实 API 探针（`browser-read` 集成新例：三插件恒在、状态在词表内、detail 非空、no-store、响应无凭据形态）。**验收复跑成绩**：API 全量 `tsc -p tsconfig.json` exit 0（并行会话已解除阻塞）、`official-skills`+`github-read`+`github-executable` 单测 40/40、`agent-conversation-main-loop`+`tool-loop`+前两者 55/55、浏览器八套件 57/57、电脑四套件 58/58、`computer-runtime` Rust `cargo test` **20/20**；真实临时 PG 集成 `github-read` **10 通过＋1 认证跳过 PASSED**、`browser-read` **7/7 PASSED**、`browser-actions` 6 通过＋1 真机跳过 PASSED（停止修复保持绿）、`computer-control` 10 通过＋1 跳过 PASSED（真实输入 11/11 同日已通过并留档；收尾复跑时用户已关闭测试记事本，按「不结束用户活动进程、不复开窗口打断使用」沿用当日证据）。相关文档（tool-adapters §4.1、relay-skills §10、ADR-023 增量）已同步「注入跟随工具」的最终口径。

**未验边界**：真实日常 Chrome 的保活复验与扩展重载（需用户手动操作）；桌面固定端口 43117 占用回退的真实启动路径（dev 窗口在用该端口，未实测）；真实已认证 GitHub 读取（无登录态）；安装包与安装态；ConnectionsView 安装级状态接线的真实浏览器点验；Run 工具循环与学习档轮次的注入；独立验收（需另一协调方，本行自检＋复验不替代）。成绩与限制归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)本轮行。**下一轮有限任务**：①用户重载扩展后复验日常 Chrome 保活/登录态复用；②官方 Skill 禁用的界面入口与 workspace 级持久化（需迁移与 UI 授权）；③按 §4.2 协议实施 GITHUB_WRITE 首片（待用户对该切片单独授权）；④Connection 页安装级状态接线的真实浏览器点验。

## 聊天用量文案：「输入」改「上下文」（2026-10-24，当前 Agent 直接修复，未 commit/push）

用户截图指认「每次回复下面的输入 token 看着像是本会话的而不是单次会话的」。取证 `relay_trial` 库 `model_calls`（127.0.0.1:12525）当晚两行：20:49:00 输入 4710/输出 47、20:49:50 输入 4757/输出 15，各有独立 `provider_request_id`——**数字没有算错**：聊天 API 每次调用重发完整历史，Provider 上报的 `input_tokens` 本就是该次调用的完整上下文，「输入」二字让它被读成本轮新增、把逐条递增读成会话累计错账。修复只改措辞不动口径：`AssistView.tsx` 圆环浮层与 `aria-label` 统一为「上下文 X / 65536 tokens（N%）」（`aria-label` 不再叠「上下文占用」前缀，就是浮层同一句），消息用量行改「用量：上下文 X、输出 Y tokens」；读数来源、四态区分、缓存命中率、百分比规则、`data-testid` 全部未动。验证：受影响两 spec 133 例 131 绿，2 红均为登记在案的并行存量（`assistantModeSwitch` 资料入口邻接断言、`collaborationWorkspace` `.agent-chat-source-options` 结构选择器，均不读文案）；`tsc --noEmit` 报错全在并行会话文件（relayClient/goal 族），`AssistView.tsx` 零错误；check-docs 的 28 条失败均为存量断链、不涉及本轮文件。规则同步[工作台 §28.8 尾部 2026-10-24 条](../frontend/workbench-design.md#288-v42-工作详情与成果预览接续2026-10-15)。未验：真实 WebView2 下长句浮层的实际宽度与换行。

## 验收结果优化轮：goal 控制归一缺口＋DEV-0110＋首条目标投影（2026-10-24，用户指令「根据验收结果优化」，当前 Agent 直接执行，未 commit/push）

接上一轮电脑操控插件实机验收的三条发现，逐条定性并修复：

- **①goal 控制意图归一缺口（确定性缺陷，最高价值）**：验收观察项「PAUSING 约 2 分钟未收敛」经查库定性为真缺陷——试用库里另有**一条用户真实目标 CANCELLING 停留 3 天**（10-21 至今）。根因：桌面 supervisor 按需拉起一次性 worker（`--once`/`--assist-once`，supervisor 日志 UTC 时间戳与 21:42 生成记录互证），而 `runAssistGoalTick` 只在持续 Worker 循环里运行——桌面拓扑下 PAUSING/CANCELLING、轮次归一与下一轮投递在两次派发之间**无人收口**。修复（`supervisor-main.ts`）：主循环加时间闸 goal tick（`RELAY_SUPERVISOR_GOAL_TICK_MS` 默认 2s，测试可调 0），调用同一个 `runAssistGoalTick`，置于 assist 派发之后（刚结算的轮次同一 pass 归一）；函数级唯一推进 Owner 不变，租约与锁定行短事务保证并发安全。**端到端验证**：独立 supervisor 直连试用库（真循环）＋真实领域入口 `resumeGoal`→`pauseGoal`，6 秒内自动归一 PAUSED，期间 supervisor 自动投递并结算一轮（round_count 1→2），日志 `supervisor_goal_tick` 在案；修复前同状态停留 30 分钟/3 天。API `tsc` exit 0、dist 已重建，桌面下次启动经 stage-api 写入时间自动暂存。
- **②DEV-0110（缓存命中率致工具栏换行/输入卡增高，2026-10-22 退回项）修复**：`.agent-chat-usage` `flex:none`→可收缩，命中率文本作收缩承担者（ellipsis），圆环 `flex:none` 恒不缩——命中文本出现先截断自己，不挤工具行换行。新增浏览器回归 `tests/browser/composerCacheHitStability.spec.ts` **2/2**（1280/1600 两档，有无命中率两夹具下输入卡与底栏高度差 <0.5px，并断言命中率文本在场证明条件真实切换）。
- **③首条 `/goal` 投影缺口**：实机核对确认**前缀解析服务端全链路生效**（库中会话 `chat_mode=GOAL`、目标行由首条消息命令建立并挂上回复）——验收时目标卡不出现是客户端投影缺口：目标重读效果增加 `confirmedFirstMessageCommandId` 依赖，首条 202 确认后目标卡随服务端事实出现。

**验证**：①见上；②浏览器 2/2；③`chatPlanGoal` 15/15、`draftGuardCoexistence`、`folderFirstConversation`、`sessionRoundTrace`、`firstMessageSendStability` 隔离全绿，`collaborationWorkspace` 仅余存量 `agent-chat-source-options` 红；本轮改动文件双端 `tsc` 零错误（工作台全量剩余错误均在并行会话在改文件）。期间并行会话的 `FileBrowsePanel.tsx` 一度语法错误挡住全部 vitest/浏览器（恢复后复跑）。成绩与未验边界归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「验收结果优化轮」行。**未验边界**：桌面整链真机复验未做（同一代码路径已由独立 supervisor 验证）；DEV-0110 的 A/B 摘除对照未做；关窗守卫仍未真机点验。未 commit/push。

## Agent 基础闭环 UI 一致性专项：DEV-0105 停止文案＋非持久附件离页保护（2026-10-24，当前 Agent 直接执行，未 commit/push）

用户 `/goal` 指令「基础 Agent 执行闭环与 UI 一致性专项」，P0×2 已修复、P1-1/P1-2 完成核验：

- **P0-1（DEV-0105 退回项「停止提示误报计划模式」）**：`ChatModeHint` 此前在 `goalStopping` 时无条件写「停下后才会进入计划模式」；服务端 `setChatMode` 切走 GOAL 时会话模式立即落 CHAT/PLAN、目标才慢慢进 `PAUSING`，退出到普通模式时该句是错的。改为按**服务端目标状态**（`PAUSING`/`CANCELLING`）投影：只报目标事实（暂停可从目标卡恢复／取消终止不再推进），不按会话模式宣称去向；当前档位由徽标承担。`AssistView` 改传 `goalStatus`。回归：`chatPlanGoal` 15/15（新增接线用例「活动目标在途退出 GOAL：说明行报安全停止不误报计划模式；目标 PAUSED 后说明行消失」＝迟到回执与重载恢复同投影）。
- **P0-2（协作页守卫恒 false）**：`CollaborationView` 的 `DraftGuard` 原写死 `hasUnsavedChanges: () => false`，暂存/上传中附件、技能输入、来源选择等**无本机持久化**的输入离页即丢且无人拦。修法：`AssistNavigationState` 新增 `unsaved`（与 `dirty` 分开——可恢复的会话/首条正文草稿只进 `dirty`），AssistView 两处导航上报、`LearningRecordsPanel` 同步投影；协作页守卫照实上报，App 路由阻断/beforeunload/桌面关闭确认随之生效；页内切换（换目录、选会话、切任务）在无未决命令但 `unsaved` 为真时弹「丢弃并继续/保留并继续编辑」确认，丢弃只清本页输入器登记的事实。期间修正一处自错：首条草稿其实已按 `firstDraftScope` 持久化（`folderFirstConversation` P2/A1 反例拦住），已从 `unsaved` 移除。回归：新增 `collaborationWorkspace`「不可恢复输入的离页保护」3 例（页内切目录保留/丢弃、跨页导航拦附件、首条附件拦而正文不拦）。
- **P1-1 核验（无确定性缺陷，未改代码）**：`SessionRoundTrace` 已按服务端五态呈现（REQUESTED/SETTLED/REJECTED/ABANDONED/UNKNOWN），拒绝原因原样回显——ASK 写入的「等待人工批准，原 operation_id=…」以 REJECTED+原因如实可见（会话无异步审批通道，服务端设计如此，不冒充已排队）；Run 轨迹另有 WAITING_APPROVAL 档（既有用例「等待批准与拒绝各有各的说法」）。在途 2s 轮询、终态补读一次；流式预览已实现（400ms 轮询、终态删预览回源数据库，最终回复以 DB 结算为唯一权威）。消息行区分 正在生成/生成失败(+errorCode+providerErrorKind 指引)/已取消；停止键 stopping 态承载「正在停止」。
- **P1-2 核验**：DEV-0117 已于 2026-10-23 修复（本轮 `folderFirstConversation` 含「首条消息绑定目录后左栏与顶栏按服务端事实重分组」通过）；DEV-0103 三层版式已落地（`goalCardLayout.spec.ts` 为浏览器侧证据，本轮未复跑 Playwright）。**DEV-0110「缓存命中率出现导致工具栏换行、输入卡增高」仍标退回**：hit-rate 文本有 12rem 上限与省略号，但出现时右端组变宽是否仍挤压换行需真实 Chromium 几何复测；本轮预算已满，记为下一轮候选（复现步骤：真实窗口 1280px 会话内首次命中缓存后逐帧量输入卡高度）。

**验证**：受影响面定向 7 文件 199 例 196 通过（`collaborationWorkspace`+`chatPlanGoal`+`draftGuardCoexistence`+`folderFirstConversation`+`sessionRoundTrace`+`composerImageAttachments`+`assistantModeSwitch`），3 失败均为存量/并行在途红（`agent-chat-source-options`、`message-attachment-image` 选择器已被并行改造移除，本轮未触碰其文件；`agent-chat-source-options` 在 src 全文检索为零命中）；本轮改动文件 `tsc --noEmit` 零错误，API 侧 `tsc` exit 0，剩余工作台错误全部位于并行会话在改文件（`relayClient.ts`/`createGoalEntry`/`goalProjectLink` 等，两轮采样间清单已变动，非本轮产物）。文档：工作台 §17.13.2、§44.2；`check-docs` 本轮触及文件零新增错误。**未验边界**：独立验收未做；真实 Windows/WebView2、真实切目录/关窗行为、Playwright 浏览器几何未复验。未 commit/push。

## 左栏「未开始」误标：0111 未回填的历史会话（2026-10-24，当前 Agent 直接修复，未 commit/push）

用户截图指认「有正文的会话被标未开始，这是bug吧」。核对后确认是**数据缺陷，不是标记逻辑错**：

- **根因**：`assist_sessions.last_message_at` 由迁移 0111 引入时**刻意不回填**，其兼容段写「旧行取 NULL（无消息）」——该前提不成立，0111 之前就已有消息的会话同样落在 NULL。当时只影响排序（回落 `created_at`），所以一直没暴露；2026-10-24 左栏把 `lastMessageAt === null` 读成「这段讨论还没有消息」后，老会话立刻自相矛盾。
- **本机取证**：`relay_trial`（PG 18.6，127.0.0.1:12525）实测 5 条有消息却 NULL 的会话，含用户截图那条 2026-10-16 15:35 建、6 条消息（15:35 `MODEL_FAILED`、15:42、16:01）的会话。
- **修复**：新增迁移 `0135_assist_session_last_message_backfill.sql`（单条 `UPDATE`，按 `assist_messages.created_at` 最大值只填 NULL 行，幂等，不动 `updated_at`/`revision`，不新增写入 Owner）。
- **已运行**：`UPDATE 5` → 复跑 `UPDATE 0`；`有消息却 last_message_at 为空` 计数 0，剩余 4 条 NULL 全部 0 消息；`sessionRowMenu.spec.ts` 25/25。
- **未做**：真实临时集群集成套件未跑（纯数据校准已在真实库逐行取证）；真实 Windows/WebView2 未点验；运行中的桌面实例要重新加载左栏才看到标记消失；该实例库仍停在 0132，0133/0134/0135 由下次启动的迁移器一并登记；既有空会话未清理（需另行授权）。契约与列语义同步到 [HTTP §10.91](../api/http-command-contract.md#1091-会话列表的活动排序键2026-10-18-源码实现迁移-0111)、[数据库 §112](../database/physical-design-postgresql.md#112-0135-会话活动键回填2026-10-24缺陷修复)、[工作台 §28.1](../frontend/workbench-design.md#281-左栏recentworkrail)。

## 禅道批次第七轮：完成/勾选/分页三条＋陈旧错误四条（2026-10-24，子代理串行修复＋协调集成，未 commit/push）

接续第六轮按族领取并修复 7 条（#28/#27/#19/#11/#23/#117/#118），全部交回禅道，激活余 63 条：

- **完成/勾选/分页族（#28/#27/#19，子代理修复）**：#28 client `completeHumanTask` 回包核对原 `command_id`＋确切 `task_id`，面板直接回包与原回执查询按冻结请求核对确切 Task／完成状态／验收版本／产物版本集合（`completionMismatch`），错配保持待核对不清原 ID、不宣告成功（探针三例错配红→绿，10/10）。#27 人工条件勾选绑定 Task＋验收版本＋确切接受版本——A→B、A→null 清勾选要求重新确认；口径说明：null→A 不清（既有 UI-11「保存首个产物后自动选中」流由 taskDetail 用例锁住），A→null 仍清堵绕道继承；ArtifactPanel 接受版本改从最近成功读取的版本事实解析，修掉刷新窗口假 A→null（探针两例红→绿）。#19 GoalProjectLinkPanel 复用 `getProjectsPage` cursor——加载更多入口、范围与剩余状态、去重、暂态失败保游标重试、刷新隔离迟到页、逐页手动；#20 pending 门槛沿用（探针第三例红→绿，nextReads 0→1）。
- **陈旧错误/失权族（#11/#23/#117/#118＋WebImport 相邻点，接手中断代理半成品完成）**：#11 经核实**已随 commit 6af3f14d 修复**（`POST /operations/:id/reconcile`＋RunView 核对按钮＋租约面板真实数据），本批复核验收底线后按 fixed 交回，零代码改动。#23 ContinuationPointPanel 拆分 listError 与写入/回执错误，成功读取撤旧读取错误、pending 门槛不动（探针 2/2 绿）。#117 useConversationDiff 新增 successSeq（失败不递增），已展开正文绑定当前侧快照——统计成功刷新后重读正文，同行数内容替换同样更新（探针 1/1 绿，DTO 无现成字段未新增接口）。#118 conversationDiff client 移除无条件 RelayTransportError 包装，401/403/404 撤下旧目录与正文报拒读、503/传输按 CD-17 保留标过期（探针 2/2 绿）。WebImportPanel `sendImport` 相邻点改 `needsReceiptCheck` 分类（typed 503 保 pending，web-import 11/11 含新增 2 例）。
- **半成品接手披露**：B 族前一次运行被中断，留下五文件半成品；接手代理逐文件评估后保留正确部分、修正两处缺陷（拒读用例 fixture 与 stats 文件不符、三处 TS 错误），并披露一处**超范围呈现改动**——会话 diff「完整且空/读取中」整行不再占位（引用户 2026-10-24 指令，配套测试自洽、不与契约矛盾），保留待用户确认，不满意可单独回退。

**族外存量红只报不修**：browser `conversationDiffLayout` 2 挂经 stash 对照判存量/flaky（几何量测逐帧一致）；全量套件 19 个失败文件经 HEAD 基线对照判并行在途与既有 flaky。**未验边界**：独立验收未做；全部为 jsdom/受控 fetch 组件级证据（#11 为静态复核），真实浏览器下拉鼠标路径、真实权限撤销、真实 PG/HTTP 错配场景、Windows 实窗未复验。成绩与未验边界归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「禅道批次第七轮」行。剩余激活 63 条；S2/P1 已全清，剩余以 P2/P3 为主，建议下一批按「失权与陈旧错误族」（#113/#115/#103/#128 等）与「归档/会话族」（#134/#119/#122）继续，另 #56 需求待用户评审。

## 右侧工具面板与内置网页预览：P0–P2 实施＋P3 部分验证（2026-10-24，当前 Agent 直接执行，未 commit/push）

用户指令「执行 `prompts/workbench-browser-preview.md`，完成右侧工具面板与内置网页预览的开发、修复及验收。先核对现有实现和未提交改动，按 P0–P3 推进，不只提交分析报告」。开工先核对了工作树（40+ 文件带并行会话未提交改动，全程未触碰其文件）并确认本专题此前**零实现**（`DevToolsPanel` 只有 文件/变更/终端占位/运行/轨迹，无网页容器；`tauri` 未启用 `unstable`），随后按 P0→P1→P2→P3 顺序落地：

- **P0 宿主容器**：新增 `apps/desktop/src-tauri/src/preview_webview.rs`。`Window::add_child` + `WebviewBuilder` 建原生子 WebView（`Cargo.toml` 启用 `tauri` 的 `unstable` 与 `Win32_UI_Shell`；`tauri-runtime-wry` 同名 feature 为空列表，**锁文件不变、零新依赖**）；独立 `data_directory`（`<data-root>/preview-webview`，独立 WebView2 环境 → Cookie/LocalStorage/SW 分家）＋`incognito(true)`（登录态不落盘，因此不需要「保留周期」设置）；`on_navigation` 对**每一次**导航（含重定向）重判地址策略、`on_new_window→Deny`、`on_download→false`、`add_ProcessFailed` 上报崩溃；9 条命令全部先校验调用方必须是 `main` webview；实例 `id` 永不复用＋`generation` 递增。
- **隔离的关键事实（读 Tauri 源码得出，已写进架构 §15.1 与 ADR-035）**：`RuntimeAuthority::resolve_access` 的匹配是 `webviews.any(...) || windows.any(...)`，capability `main-window` 只按窗口标签约束，**所以「另起一个 webview 标签」本身不构成隔离**——子 WebView 仍命中窗口级 capability。真正的来源闸是 capability 的 `remote.urls` 白名单（本仓只有 `http://127.0.0.1:5173`），因此该来源被地址策略**无条件**拒绝（dev 与 packaged 同一套行为，避免漂移）；同时拒绝 `tauri.localhost`/`ipc.localhost`、非 http/https、带凭据地址，并按「先判回环主机再比端口」拒绝本机 API 端口（IPv6 剥方括号、公网同号端口不误伤）。
- **P1 面板整合**：`DevToolsPanel` 页签改为 文件/变更/网页/终端/运行记录/轨迹，「网页」**常驻挂载**（切走再切回不重建、不重载页面）；无 Project 时文件与变更显示「需要项目」且**不读**受管目录（工具面板本身不再要求 `projectId !== null`）；`CollaborationView` 顶栏新增普通会话的工具面板键，与「工作详情」**互斥**占用同一右栏、抽屉态 Esc 可收且焦点回触发键；复用既有 `InspectorResizeHandle` 与容器查询断点，未新增第四列。
- **P2 网页预览**：新增 `BrowserPreviewPanel` + `lib/previewBridge.ts`（宿主桥，非桌面宿主返回 null，不退化成 iframe）+ `lib/previewUrl.ts`（与宿主同规则的地址预检）+ `lib/previewRestore.ts`（只存来源＋顺序＋选中项）。多标签新建/切换/关闭、地址栏、前进/后退/刷新/停止、实际 URL 与标题、系统浏览器打开；空白/加载中/已停止/进程崩溃四态分离；被策略拒绝的跳转只报原因、不改当前页面状态；`previewScope = workspaceId:sessionId`，切会话 `release_scope` 并清空标签，Project/Task 只作来源。
- **P3 验证**：新增 4 个测试文件 31 例（`previewUrl` 8、`previewRestore` 7、`browserPreview` 11、`devToolsPanel` 5）＋9 条 Rust 单测全绿；受影响回归 `gitReadPanel` 21/21；`tsc --noEmit` exit 0、`vite build` exit 0、`cargo check` exit 0 零告警、`cargo test --lib`（MSVC 目标）52 passed / 2 failed（2 红为环境既有：缺 `RELAY_TEST_NODE`、本机 junction 语义，未删除或放宽任何检查）。

**过程中抓到并修复的真实缺陷**：①`BrowserPreviewPanel` 的默认存储每次渲染新建对象又进依赖数组 → 自激死循环（`devToolsPanel` 用例挂死暴露，改 `useMemo` 稳定）；②`on_page_load` 回调内调 `with_webview` 会自锁（回调在主线程，`with_webview` 投回主线程并同步等待），改为工作台在 `LOAD_FINISHED` 后调 `preview_state` 取前进/后退可用性；③`app.manage(PreviewHost)` 原在建窗之后，窗口 `show()` 后首调可能报「状态未托管」，已前移到建窗之前。

**未验边界（据此不得宣称 P0 通过或功能交付）**：真实 Windows/WebView2 窗口的裁切、DPI 缩放、焦点与键盘、工作台弹窗遮挡、退出无残留容器；打包态与安装包；外页能否调用桌面 IPC 的攻击夹具（规则与命令面已就位，攻击验证待真机）；`unstable` API 在 Tauri 升级后的可用性。**独立验收未做**（任务书要求由另一协调 Agent 抽查 TP-05/06/08/09 与一条「对话→打开成果网页→人工检查→返回反馈」真实路径）。全量 vitest/Playwright 未跑（并行会话仍在改同一工作树）。成绩与未验边界归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「右侧工具面板与内置网页预览」行。

## 禅道批次第六轮：目标语义三条＋前端待核对四条＋SSRF 澄清（2026-10-24，子代理串行修复＋协调集成，未 commit/push）

接续第五轮继续按族领取并修复 7 条、澄清处置 1 条（#13），全部交回禅道，激活余 70 条：

- **目标语义族（#144/#141/#145，子代理修复）**：#144 `goalRoundSystem` 按绑定 `goal.plan_version_id` 读不可变计划整行，经 `goalStateForPrompt` 注入 `plan:{version,scope,steps[].detail,open_questions}` 与 `criteria.method`——按计划执行的目标轮次自此携带冻结计划的完整范围/步骤细节/验证方式/待定问题（不按最新版、不扩聊天历史、不强迫 reply 复制；模板补「计划段是冻结执行契约、open_questions 不构成授权」）。探针 7 项标记全 true；新增 `goal-round-frozen-plan-context` 3 例（逐字段＋换版仍冻结原版＋旧版需 allow_superseded）。#141 `ModelCallRepository.begin` 授予上限口径改为「基线窗口＋ACTIVE 全部授予＋已终结目标**已消费**的授予」（终结目标贡献＝min(授予量, max(0, 存续窗口用量−开始时基线余额))）——已消费才保留、未消费不转送，新目标首授予恰增一窗口不再反复补偿历史；探针红→绿（3→4 恰＋1），新增 `goal-budget-grant-accounting` 2 例。#145 身份×模式支持矩阵（AGENT 支持 CHAT/PLAN/GOAL，ASSISTANT/LEARNING 仅 CHAT），`CHAT_MODE_UNSUPPORTED_FOR_IDENTITY` 409 类型化拒绝覆盖四个写入口、事务回滚零副作用；探针红→绿，新增 `chat-mode-identity-boundary` 3 例（含 ASSISTANT 同族）。单测 28/28、`tsc` exit 0。
- **前端待核对族（#32/#30/#29/#24，子代理修复）**：#32 KnowledgeView submit catch 改用既有 `needsReceiptCheck` 分类——typed 503/5xx/传输失败保留 pending 与草稿返回 UNCERTAIN，仅明确业务拒绝才释放（Knowledge/Memory/Decision/Rule 共用调用点同 catch）；探针 2 个不同 ID→同一 ID。#30 WebImportPanel 独立注册 DraftGuard，未知窗口内导航被既有 useBlocker 阻断，201＋回执核对通过才解除未决；探针 leftWithoutGuard=false、pendingRecovered=true。#29 TaskCompletionPanel 按 ArtifactPanel PendingSave 模式冻结完成/重开完整原请求（修订/验收版本/产物版本集合/条件/声明理由），重按＝原样重发、编辑是新草稿；探针 payload diff 红→绿。#24 ReviewDecisionPanel 到期触发器（setTimeout＋visibilitychange）＋提交前按当前时间复核，过期后 0 POST；探针红→绿。新增回归 4 spec 11 例（knowledgeTypedErrorPending 3、completionPendingPayload 3、web-import 增 2、reviews 增 3），`tsc` exit 0。
- **#13（SSRF）澄清处置（notrepro）**：复核确认 `allow_private` 不可被外部内容或任务参数影响——只存在于 Gateway 连接 config（仅显式 true 可落库、设置者=连接编辑权持有者、命令回执＋审计），`web-fetch.ts:276` 只解除保留地址检查，主机绑定/Permission 门/逐跳校验三道门不解除；治理链归 [tool-adapters.md §WEB_FETCH 2026-10-22 澄清段](../architecture/tool-adapters.md)。按该段既定方向登记需求 #56「WEB_FETCH 私网例外按地址清单粒度控制」（评审中，待用户评审）。

**族外存量红只报不修**（同名同数复现，对应禅道其余激活单）：completionDefects 第 3-7 例（完成回执身份校验＝#28 族、验收版本变化清勾选＝#27 族）、RunControlPanel/ReviewDecisionPanel 的 503 清 pending（DEV-0123 族）、assist.integration「DISCUSS…不启动 Delegate」断言在 HEAD 即红、WebImportPanel `sendImport` 对非 409 仍清 pending（#32 同族相邻点，下批顺手收）。**未验边界**：独立验收未做；#141/#144/#145 有真实临时 PG＋HTTP 证据，前端族为 jsdom＋可控 fetch 组件级；真实 Windows/WebView2、真实断网/5xx 注入未复验。成绩与未验边界归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「禅道批次第六轮」行。剩余激活 70 条，S2 全清；下一批建议：#28/#27（完成回执身份与勾选继承）、#11/#23/#117/#118（Run 页 UNKNOWN、接续点/轨迹陈旧错误族）、#19（goal-link 分页）。

## 禅道批次第五轮：S2 大单五条＋高优四族共 13 条全绿（2026-10-24，子代理串行修复＋协调集成，未 commit/push）

用户指令「领取禅道上面的bug→修复→多开几个子智能体修复」。先把激活 90 条全部领取（`PUT /bugs/:id` assignedTo=admin），随后按优先级分四族修复 13 条并全部 `resolved/fixed` 交回，激活余 77 条：

- **定时任务族（#147/#151，子代理修复）**：#147 `latestOccurrence` 改 `unfinishedBoundTaskIds`——串行准入按「本计划全部未终态 Task」判定，无 task_id 的 SKIPPED/BLOCKED/RESOLVED 不再遮挡未验收任务；`requireScheduledTaskAdmission` 在 Delegate 原事务内复核上一任务终态（ADR-026）。#151 恢复分发复用 `frozen_execution` 前先 `requireTaskChainExecutionCurrent` 校验，漂移落 BLOCKED、原快照不覆盖；Delegate 事务内对非空冻结依据二次核对 CURRENT。探针 skip-chain/frozen-source-drift 红→绿；`scheduled-tasks`＋`scheduled-task-detail-history` 8/8、定向单测 20/20、apps/api `tsc` exit 0。
- **目标族（#140/#142/#143，接手被挂起超时杀掉的子代理半成品完成）**：评估确认三处修复与 +111 行测试已成形，一次假红系 dist 过期、重建后全绿。#140 `runAgentMainLoopGeneration` 无 invokeAssist 时与 `runSubagentChildGeneration` 同形态包 `recordModelInvocation`（PLAN/GOAL/AGENT 主流程逐次落 model_calls＋scope 预算闸门，OpenRouter 自计量路径不双包）；#142 `confirmGoalCompletion` 在锁定目标行同一事务内核对在途/缺账轮次消息，新 `GOAL_ROUNDS_UNSETTLED`（409）拒绝；#143 候选判定改「任一缺账」＋`listUnsettledRoundMessages` 按 seq 升序、逐条锁定行短事务结算，取消归一只落最后一条，advanceGoals 积压未清不投递下一轮。三探针红→绿；`chat-plan-goal`＋`assist-session-controls` 22/22（含两条新用例）、相关单测 40/40、`tsc` exit 0。
- **记忆族（#33/#99/#107/#109，子代理修复）**：#33 KnowledgeView 修订表单回填原到期时间（datetime-local 往返保秒精度，显式清空/改值才变）；#99 SaveMemoryDialog 创建 201 即持 memory_id、读回失败只重读原身份不重创建（checkReceipt 同语义）；#107 `parseExpiry` 拆纯载荷规范化与 `requireFutureExpiry`，createMemory/createMemoryFromMessage/addMemoryRevision 三处先按原回执重放再查时效（到期后重放 201 返回原 memory_id 零延期，新命令过去时刻仍 422）；#109 PendingCommand 增加 `resetComposer` 收尾语义，回执补查与直接成功一致、不再误清无关新建草稿。四探针红→绿；memory-module 8/8＋information/memory 相关 34 例真实 PG、工作台新增回归 22 例、双端 `tsc` exit 0。
- **工作台待核对族（#20/#21/#22/#25，子代理修复）**：#20 CreateGoalView/GoalProjectLinkPanel 作用域待核对门槛＋DraftGuard（handler 级拒绝新命令、原 ID 原载荷重试、跨 Workspace 隔离、重开恢复）；#21 TodayView 表单基线——未编辑随新事实同步、已编辑冻结差异并给「按最新事实重填／保留修改按新基线提交」双出口，409 冲突重提按新基线走；#22 TodayCommand 全链路作用域持久化（PIN/Focus/Planning 三类、切页拦截、回执 404 仅原 ID 重试）；#25 ReviewsView 401/403 失权剥壳清受限正文与原始 JSON、保留恢复锚点与回执入口。三探针本族 5 例红→绿；新增 4 spec 22 例、相关 15 文件 123 例全绿、`tsc` exit 0。

**过程记录**：子代理平台并发受限（`user concurrency limit exceeded`），四族改串行执行；一次孤儿临时 PG 集群已清理（`.relay-test/cluster` 长期集群未动）。并行会话的 0132 消息撤回与工作台大改全程在途，未触碰其任何文件，双端 `tsc` 全绿证明可共存。

**族外存量红只报不修**：RunControlPanel/ReviewDecisionPanel 503 后换新命令、Review 过期决定未拦、goal-link 项目列表无续读入口、goal-confirm 探针外 #32/DEV-0130 家族两条——均在改动前同名同数复现，对应禅道其余激活单。

**未验边界**：独立验收全部未做；除定时族与 #107 有真实 PG/HTTP 证据外，其余为受控探针＋真实临时 PG 集成（目标族）/jsdom 组件级（工作台与记忆前端族）；真实 Windows/WebView2、真实断网/5xx 注入未复验。成绩与未验边界归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「禅道批次第五轮」行。剩余激活 77 条，S2 剩 #144/#141；下一批建议按族继续：#144/#141/#145（目标语义）、#32/#30/#29/#24/#23（待核对/失权族）、#13（SSRF）。

## 未读修复接续与桌面开发入口去打包、脚本去留定案（2026-10-24，未 commit/push）

接续 Qoder 会话 258dbea3（该会话在用户最后一问处被终止）。**未读修复已由该会话完成并复核**：根因是单条会话 GET 的严格响应 schema `AssistSessionDto` 漏 `unread_at`，Fastify 序列化剥掉该字段（DB 写入、命令回执与列表读取均正常）；修复补 DTO 字段并新增单读断言，真实 PG `assist-session-controls` **22/22**、工作台 `sessionRowMenu` **24/24**，暂存 API 已重建载入修复；成绩与未验边界归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「会话行标记为未读」行。真实开发窗口的人工点验仍未做——用户随时可双击 `dev-desktop.bat` 起新窗口验证。

**桌面开发入口去打包**（同会话实施，本会话补完）：菜单 6 / `dev-stack.bat DesktopDev` 在测试环境已初始化（`.relay-test/session.json` ready）且暂存 CLI 与 `resources/node.exe` 完整时不再要求 `test-release/`（[test-desktop.ps1](../../scripts/test-desktop.ps1)，仅首次初始化仍须先 Build）；`dev-desktop.ps1` 使用 `.relay-test/desktop.env` 时默认数据目录对齐 `.relay-test/data`，并新增 `restart` 动作（先关闭旧 dev 窗口、等单实例锁退出，再前台重启）。本会话补上该会话承诺但未落地的仓库根双击入口 [dev-desktop.bat](../../dev-desktop.bat)（无参数即 `-Action restart`，带参数透传，ASCII-only 沿用 `dev-stack.bat` 惯例），部署文档 2026-10-24 条目同步。**脚本去留（用户终止前最后一问）定案：保留 `dev-desktop.ps1`**——AI 开发必须用命令行启停（`start`/`stop`/`status`/`restart`）做自主验证回路，且 bat 只是薄封装、真正的实现只有 ps1 一份；`dev-desktop.bat` 保留为用户双击入口，两者共用同一实现。回归（本会话在 restart 重构后复跑）：`test-desktop-dev-guard` 6 例、`test-desktop-launcher`、`test-desktop-menu` 3 例、新建 `test-desktop-dev-no-package` 4 例（真实临时 PG）全部通过；`node scripts/check-docs.mjs` 本片触及文件零错误（全仓剩余 14 条为并行会话文档的既有断链）。**未做**：真实 Windows 窗口的未读点验与 bat 双击实机验证（环境当前无运行窗口）；改动未 commit/push。

**双击实机反馈与三连修复（2026-10-24 用户试双击后指认「启动不了，失败还会直接关闭终端」）**：① bat 的 `%ERRORLEVEL%` 写在 if 括号块内被 cmd 解析期展开，失败也读到旧值、不进 pause 分支直接关窗——读取移到块外，失败现在停在「请按任意键继续」并保留错误输出（用非法动作实测）。② 真实启动失败根因是**试用专用 PostgreSQL 未运行**（12525 未监听，窗口 setup 钩子 panic `PostgreSQL is unavailable` exit 101）；直跑/双击路径补上与菜单 DesktopDev 同语义的自动启动（`pg_ctl` + 缺失场景中文报错）。③ 同路还缺补迁移：并行会话新增迁移 `0132` 后暂存迁移集超前于试用库，窗口报 `schema is incompatible`；现按 `Get-MigrationSetHash` 逐字同算法对暂存 `migrations/` 计哈希、与 `session.json` 比对，落后时先 `pg_dump` 备份再以暂存 CLI 跑 `migrate.js`＋`install-graph.js` 并回写哈希（两处算法需同步维护，已在两侧注释互指）。四项启动器回归在两处改动后复跑全过。**验证边界**：自动启动已实机走通（库被本路径拉起后 panic 从 unavailable 变为 schema）；补迁移分支因并行会话抢先以菜单路径完成同一迁移（session.json 15:18 已回写、0132 已在库）而按哈希相等静默跳过——其实际执行未由本会话跑过，逻辑与菜单路径同源；单实例互斥实测拒绝第二个启动（exit 23，属正常保护）。当前运行的 dev 窗口（15:20 起）属并行消息撤回会话，其 5173 Vite 已不在监听，后续由该会话处理；改动未 commit/push。

## 未决命令提示按类型分流：正文一行＋按需核对弹窗（2026-10-24 用户截图指令，未 commit/push）

用户指令：「像是这种提示，按照类型优化成toast，弹窗等等而不是这样一大堆文字加上乱七八糟样式失常的图标」。指认对象是会话页与首条输入器下方的未决命令整块——原因、原 command_id、两个出口连排，外加一枚样式失常的图标。承接同日「明确拒绝不是结果未知」，本轮只改呈现、测试与文档，服务端、HTTP 契约和命令身份未动：

- **新承载**（`apps/workbench/src/components/UnresolvedCommandDialog.tsx`）：`UnresolvedCommandStrip` 是正文唯一的一行证据——`helper-text` 文案加既有共享基类 `text-button` 的「查看核对」；`UnresolvedCommandDialog` 用 `AppDialog` 承载摘要、原因、「稍后处理／按原命令重试／查询回执」三个动作，原 command_id 与传输细节收进「技术详情」折叠区。弹窗不自动弹出，关掉后正文状态行仍在；重试期间保持打开并显示在途，成功后清 pending。
- **分流**（`AssistView.tsx`）：明确拒绝（`needsReceiptCheck` 为 false，命令未落库）不再保留 pending，原因走停留到关闭的 `Notice`；传输失败、5xx 与非 `RelayApiError` 照旧保留原命令，但正文只渲染上述一行状态。首条消息、建会话命令与会话内动作命令三处同一读法；在途阶段仍是「正在发送首条消息…」加行内「查询回执」，不提前摆 command_id。
- **样式**（`AssistView.css`）：删除旧 `.first-message-pending*` 大块样式，新增 `.unresolved-command-strip`（横向排布、`helper-text` 去底边）与 `.unresolved-command-details`；未新增 token 或色值。
- **测试**：`tests/mountApp.tsx` 新增 `openUnresolvedDialog(testId)`；`folderFirstConversation`、`newConversationEntry`、`taskSkillProposal` 的核对/重试动作改为先从正文状态行打开弹窗再点 portal 按钮；`folderFirstConversation` 反例 C 仍走正文在途行内「查询回执」，不经过弹窗。真实 Chromium 的 `uiOption2FirstSession` P1 同步断言「状态行不含 command_id → 弹窗内可见 command_id 与原因 → 稍后处理 → 重开 → 原命令重试」，并补上并行改动新引入的 `POST …/working-directory` 夹具路由。

验证：单文件顺序实跑 `folderFirstConversation` **32/32**、`newConversationEntry` 全过、`assistantModeSwitch` **50/50**、`collaborationWorkspace` **80/80**；`taskSkillProposal` 仅剩两条既有「迟到的事实读取 503/403」失败，已在 HEAD 基线工作树复现同数；工作台 `tsc --noEmit` exit 0。真实 Chromium 跑 `uiOption2FirstSession` P1（先补齐并行改动新引入的 `POST …/working-directory` 夹具路由）：状态行、弹窗中的 command_id 与原因、「稍后处理」后重开、按原命令重试清 pending、只建一次会话、两条消息同 ID 同原文，全部通过；该用例最后一条断言仍要求前端发 `execution-requests`，与当前「前端只确认原消息发送、解释交回主流程」的代码不符，属陈旧断言，本轮未改。共享红项不属本片：`assist-flow` 4 条（`.breadcrumbs` 缺失×2、项目/任务目标文本×2）在 HEAD 基线同数复现；`firstPartySkills` 1 条因并行会话把发送键改为图标按钮。**未做**：Windows WebView2、真实 API 的 5xx 与传输中断注入、独立验收。规则归[工作台 §13.1](../frontend/workbench-design.md#131-反馈通道的四类划分2026-10-17)，首条链补入[§18.5](../frontend/workbench-design.md#185-首条消息的未决命令与版本错配2026-10-032026-10-04-补首条过程-owner)与[§17.13.2](../frontend/workbench-design.md#17132-未发送草稿按作用域保留切换不再确认2026-10-19)。Breaking Change：No。

## 消息文件回退后端：并行实施冲突与本 Agent 让位（2026-10-24，未 commit/push）

用户指令「看一下产品文档，你去开发后端部分」经核对指向[总纲 §0.13](../../Personal_Workflow_OS_Master_Spec.md#013-内置工作方法与会话控制) 2026-10-24 补全的**消息文件回退完整增量**（[工作台 §27.3](../frontend/workbench-design.md#273-用户消息下的文件撤回按钮)、[运行架构 §8.5](../architecture/runtime-context.md#85-消息发送前文件基线与恢复-owner)、BC-12–BC-16）。本 Agent 按产品文档完成调研并落成「发送前字节基线」方案的首批代码（迁移 0132 草案、schema 行、内容寻址字节库、基线采集服务、回退仓储）后，发现**另一并行会话正在同一工作区活跃实施同一功能**（首写前像方案：`0132_assist_message_recall.sql`、`application/assist-message-recall.ts`、`assist/message-recall-repository.ts`、`files/message-file-preimage.ts`、`gateway-actions.ts` 写路径前像挂钩、`unit-of-work.ts`/`domain-error.ts`/`problem.ts`/`database-schema.ts` 接线与 `file-changeset.ts` 的 `contentBytes` 扩展；文件时间戳与本 Agent 的编辑同分钟，判定为在施而非遗留）。按 AGENTS「保护并行工作」，本 Agent 已**让位**：删除自己的四个新文件、移除自己在 `database-schema.ts` 追加的五个接口块，对方改动一律未动，工作区已回到对方在施状态；未 commit/push，无残留。

对在施实现的事实核对（快照时点约 2026-10-24 12:35，施工仍在进行，以下不构成独立验收）：① 首写前像与工作台 §27.3.4「不能靠首次写入时补拍快照冒充发送前」、运行架构 §8.5「必须在消息发送前建立与消息身份关联的可恢复文件基线」是**已确认产品规则层面的语义冲突**——消息发送后、该路径首次被写入前发生的外部修改会被当作「发送前」状态恢复；② 无回退前保护副本与单层「撤销这次回退」（§27.3.3）；③ 无容量/保留/去重策略（§27.3.4 推荐值；前像 bytea 直存 PG，单文件上限 8 MiB，未按推荐 50 MiB）；④ 撤回 RUNNING 期间没有写/新消息栅栏（§8.5「恢复期间新的冲突执行不能启动」），发起时的一次性在途检查不覆盖执行窗口；⑤ 无下一轮模型输入的回退事实注入（§27.3.2「下一轮模型输入必须包含当前恢复结果」）；⑥ 无受影响 DONE 任务重开（BC-16）；⑦ `maxWithdrawn` 方向规则（`message.seq <= maxWithdrawn` 拒绝）使「先撤更晚消息、再撤更早消息」不可行，与 §27.3.5「完成后再选择更早消息须重新计算」相反；⑧ 换绑目录后按当前会话根+跨根整体 uncertain，未按「原消息绑定的资源」（§27.3.4 目录与来源行）；⑨ `executeRecallPlan`/`findRecallById` 有脚手架残留死调用（`findRecallByMessage('')` 等真实执行空参 SQL）；⑩ `assist_messages.withdrawn_at` 同时标记用户消息与助手回复，其对「历史保留合法配对、不能删除单边消息制造从未执行」（§8.5 上下文与重新执行）的影响取决于后续上下文装配是否过滤 withdrawn 消息，尚未实施到 runner。方案取舍（轻量首写前像 vs 发送前基线＋FS 内容寻址库＋去重容量）与上述语义偏差需用户拍板唯一 Owner 与口径；本 Agent 的评审结论如上，**未代修对方代码**，等待指示。

同日接续（2026-10-24 13:30，用户指令「继续开发」）：本 Agent 转入**独立验收**角色，新增 `apps/api/test/integration/assist-message-recall-acceptance.integration.test.ts`（RA-01～RA-04，真实临时 PG＋真实 HTTP＋FakeModelPort 脚本驱动真实会话写路径，不造账本行；RA-03 按**现行实现**锁定 §27.3.5 方向规则现状，修正实现时应转红；RA-04 覆盖 DELETE 二进制按字节恢复）。首轮运行抓到**致命缺陷**：`assertRecallEligible` 把空串传给 `findLiveRunForSession` 的 uuid 参数，PG 22P02 → **撤回端点 100% 崩 500**；经进程内探针取到真实堆栈后反馈，实施会话已于同分钟修复（签名扩为 `string | null`、空值跳过排除子句）。修复后 RA-01～RA-04 **4/4 通过**（status PASSED）；实施会话自检套件 `assist-message-recall-runtime.integration.test.ts`（RR-01～03，与 RA 互补：RUNNING 撤回挡新消息含崩溃遗留、过期 RUNNING 按原回执接续、下一轮上下文只留撤回占位与回执摘要）由本 Agent 复跑 **3/3 通过**。实施会话同窗口已继续收口评审缺口：④ 消息栅栏已接线（`assist-commands.ts` 在撤回 RUNNING 期间拒绝新消息，仓储含过期认领与心跳）、⑤ 下一轮上下文已注入撤回回执事实行（撤回轮次保留成对占位、不删历史，符合 §8.5 合法配对；用户原文在模型输入中由占位替代，属可辩设计取舍）、⑨ 脚手架残留已清理。**截至 13:40 仍未实现**：② 单层「撤销这次回退」与回退前保护副本、③ 容量/保留/去重、⑥ 受影响 DONE 任务重开、⑦ 方向规则与 §27.3.5 相反、①首写前像 vs 发送前基线的语义口径、HTTP 契约/数据库设计/测试计划/验收表等实施侧文档同步。已实施子集的独立验收结论与未验边界归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「消息撤回（0132）后端已实施子集」行；本 Agent 未 commit/push。

**同日第二轮接续（2026-10-24 13:45–14:10，实施会话静默 15+ 分钟且无完工宣告后，本 Agent 按「继续开发」接手缺口②）**：在实施会话的既有设计上**补齐 §27.3.3 单层「撤销这次回退」与回退前保护副本**（不依赖语义口径①的拍板）：迁移 0132 追加 `assist_message_recall_protections`（撤回首个恢复写入前按路径保存当前字节；副本不可用则整次撤回不执行、逐文件 `PROTECTION_UNAVAILABLE`）与 `assist_message_recall_undos`（撤销回执，`UNIQUE(source_recall_id)` 单层）；`assist-message-recall.ts` 新增 `undoAssistMessageRecall`（只覆盖最近一次完整成功撤回中实际恢复过且有副本的文件；预检三分「目标态＝保护副本态→无需写 / 期望态＝撤回结果态→反向恢复 / 其余→冲突先不写任何文件」；独立命令与回执身份、幂等重放、过期 RUNNING 认领接续）；HTTP `POST/GET /assist-message-recalls/:id/undo`；`assist-commands.ts` 消息栅栏扩展到在途撤销。验收套件扩至 **RA-01~06 并与实施者 RR-01~03 合并实跑 9/9 PASSED**（RA-05 撤销恢复回退前内容＋单层重复返回原回执＋命令重放；RA-06 撤回后外部修改→撤销预检 409 不写、无回执行）。实现过程两处自身缺陷由用例先红后绿收口：`requested_at` 微秒 vs JS Date 毫秒精度使「更新撤回」判定误命中自身行（改 `(requested_at,id)` 元组比较，RA-05 实测命中）；撤销预检初版把「磁盘＝撤回结果」判为已撤销、把外部修改判为可恢复（正是 §27.3.3 禁止的旧授权覆盖新变化，重写三分后 RA-05/06 转绿）。接手期间持续采样确认实施会话未再写入（其未触碰文件时间戳全部停在 13:28 前）。**仍未实现**：③ 容量/保留/去重、⑥ 受影响 DONE 任务重开、⑦ 方向规则、①语义口径拍板、实施侧文档（HTTP 契约/数据库设计/测试计划 §26 映射）。成绩与未验边界归验收表同日更新行。未 commit/push。

**同日第三轮接续（2026-10-24 14:10–14:45，实施会话持续静默，接手缺口③容量/保留 §27.3.4）**：`files/message-file-preimage.ts` 新增 `readMessageSnapshotLimits`（默认 5 GiB 预算/30 天保留/8 MiB 单文件，env 仅测试与显式覆盖）；迁移 0132 两处 CHECK 词表加 `CAPACITY_FULL`；仓储新增 `snapshotUsage`（前像＋保护副本按工作区合计）与 `sweepExpiredSnapshots`（按年龄删过期且不被 RUNNING 撤回/撤销引用的快照）；前像侧（Gateway 写路径）与保护副本侧（撤回执行前）容量预算闸——占满停止新增并按 `CAPACITY_FULL` 如实降级，保护副本不可用则整次撤回不执行（沿用 §27.3.3 前置路径）；撤回与撤销入口触发保留清理；新增 `GET /workspaces/{w}/message-recall/settings`（生效配置/实际占用/最旧快照）。验收 RA-07（超预算降级两侧）与 RA-08（进程内＋API 子进程两条清理路径分别实证、过期后如实不可恢复、设置投影）先红后绿，套件扩至 **RA-01~08**，与 RR-01~03 合并重跑 **11/11 PASSED**。调试中定位两处测试自身问题：限额 env 必须设在本进程（写路径由测试进程的 tick 驱动，spawn env 只覆盖 API 子进程）；前像断言按随机 uuid 排序误判（改 created_at）。**剩余**：⑥ 受影响 DONE 任务重开（BC-16）未做；⑦ 方向规则与 ①语义口径待用户拍板；容量压力下最旧优先删除与内容去重、实施侧文档未做。未 commit/push。

**同日第四轮接续（2026-10-24 14:45–15:10，接手缺口⑥ BC-16）**：`assist-message-recall.ts` 新增 `reopenAffectedDoneTasks`（撤回结算后运行；受影响判定＝本次实际恢复（RESTORED）路径 ∩ 委派执行写入（`conversation_execution_requests.task_id`，仓储查询补该列）；仅 DONE 任务沿既有 `reopenTask` 入口重开——revision CAS、验收周期＋1、历史完成保留、不自动 Run；失败逐项写回执 `detail.task_reopens`，文件恢复与任务重开结果分别可见）；新增 `mergeRecallDetail`。验收 RA-09（委派执行→任务 DONE→撤回→自动重开＋无关 DONE 不重开负例）**写完但被存量回归挡住**：驱动委派执行的 executionPort 路径当前 MODEL_FAILED，**既有 `conversation-diff-attribution.integration.test.ts` 委派用例同因同红**（其会话直写用例仍绿），归因 2026-10-24 13:18 并入 `assist-runner.ts` 的 #140 model_calls 计量包裹（禅道第五轮批次）——请该批次负责人复跑 attribution 套件核对；RA-09 以带因 skip 留在套件（去 skip 即可复验）。最终合并：**RA 8 通过＋1 带因跳过＋RR 3 通过，status PASSED**。⑥ 判定为已实现、e2e 待 #140 回归修复后复验。**功能剩余待办**：⑦ 方向规则与 ①语义口径需用户拍板后实施；容量压力下最旧优先删除与内容去重、实施侧文档（HTTP 契约/数据库设计/测试计划 §26 映射）未做。未 commit/push。

**同日第五轮：两项用户拍板落实（2026-10-24 15:10–15:40）**：经 AskUserQuestion 取得两处口径裁决并当场记录进[工作台 §27.3.7](../frontend/workbench-design.md#2737-首版实现现状2026-10-24)：**①基线语义改回「发送前基线」**（现行首写前像实现须返工，发送后首写前的外部修改不得被当作发送前状态恢复——返工方案即本 Agent 上午的「发送前字节基线＋内容寻址库」设计，尚未实施，为下一工作项）；**②方向规则放开（§27.3.5）已当场实施**——移除 `assertRecallEligible` 的 `maxWithdrawn` 拒绝，`collectWriteEvents` 折入已结算撤回的恢复效果（新查询 `listRecallEffectsForFold`，仅 `COMPLETED` 撤回的 `RESTORED` 文件，状态＝各自基线态），`buildRecallPlan` 折叠排序从「消息 seq 优先」改为「时间优先」（写事件归属助手消息 seq=用户 seq+1、撤回效果挂目标用户 seq，按 seq 排会把撤回效果排到被撤销写入之前——RA-03 首跑实测命中后修正）；RA-03 断言翻转为新行为（先撤更晚再撤更早：预检期望态取撤回后状态 d1 而非最后写入 d2，恢复到更早基线 d0），**真实运行通过**。合并复跑：**RA 8 通过＋1 带因跳过（BC-16，#140 存量回归未修）＋RR 3 通过，status PASSED**。实施侧文档（HTTP §10.111/数据库 §111/测试计划 §26.4）经核对已由并行会话补齐，本 Agent 仅定点修正其中 BC-16 与方向规则两处过时描述。剩余：①发送前基线返工（裁决已记录、方案已备）、#140 回归修复后去 RA-09 skip 复跑、容量压力下最旧优先删除与内容去重。未 commit/push。

**同日第六轮：①发送前基线返工实施完成（2026-10-24 15:45–17:20，按用户拍板执行）**：迁移 0132 重构——`assist_message_file_preimages`（首写前像）整体移除，改为 `assist_message_baselines`（每条用户消息一份发送前基线，`uq_assist_baseline_message`，COMPLETE/INCOMPLETE＋原因）＋`assist_message_baseline_files`（逐文件条目：existed/blob_sha256/size_bytes/不可恢复原因；**列名用 `existed` 而非 `exists`——后者是 SQL 保留字，裸列名被解析成 EXISTS 函数返回 NULL，实测 NOT NULL 违例**）＋`assist_message_snapshot_blobs`（内容寻址字节库，同内容跨消息去重，容量与保留按此计量）。新采集模块 `assist-file-baseline.ts`：在消息准入事务内、用户消息行落库后对受管根递归枚举（跳过保护路径/符号链接，单文件 50 MiB/总扫描 512 MiB/2000 文件上限），只对字节库中不存在的内容重读入库（去重下常为空集）；失败/超限/预算占满按 INCOMPLETE 基线如实降级、不阻塞消息——**DB 阶段用 SQL SAVEPOINT 包裹而非 Kysely transaction()（后者在裸实例上从连接池另开新连接，看不到外层事务未提交的消息行，实测 FK 23503 的根因）**。撤回服务目标改读发送前基线（COMPLETE 无条目＝发送前不存在；INCOMPLETE 缺条目＝BASELINE_UNKNOWN；blob 缺失＝BASELINE_BLOB_MISSING），resume 接续同源；Gateway 写路径前像钩子与 `message-file-preimage.ts` 移除。测试适配：RA-07 改基线降级断言、新增 **RA-10 判定性场景**（消息发送后、会话首次写入前外部改文件→撤回恢复**发送前字节**而非外部内容——拍板语义的直接证明）并通过；RR-02 崩溃遗留夹具从前像改基线条目。**合并复跑 RA 9 通过＋1 带因跳过（BC-16，#140 未修）＋RR 3 通过，status PASSED**。期间环境事故：pnpm store 的 typescript 包目录损坏（空目录）导致 API 子进程连跑旧 dist、诊断被误导约 1 小时，`pnpm store prune`＋强制重装恢复。文档同步：工作台 §27.3.7、HTTP §10.111、数据库 §111（返工注记）、测试计划 §26.4、验收表行。剩余：#140 修复后去 RA-09 skip、容量压力下最旧优先删除、真实 Windows 文件系统验证。未 commit/push。

**实施侧文档同步（2026-10-24 14:45–15:00，未 commit/push）**：补齐撤回端点与迁移的主文档入口——[HTTP §10.111](../api/http-command-contract.md#10111-消息文件撤回单层撤销与快照设置2026-10-24-源码实现迁移-0132)（撤回/撤销/设置三个入口、DTO、幂等与 10 个错误码、首写前像偏差）、[物理设计 §111](../database/physical-design-postgresql.md#111-0132-消息文件撤回前像保护副本与单层撤销2026-10-24)（五张表、CHECK、索引、授权与回滚）、[工作台 §27.3.7](../frontend/workbench-design.md#2737-首版实现现状2026-10-24)（已落地入口与未闭合项）、[测试计划 §26.4](../testing/verification-plan.md#264-消息文件回退首版覆盖映射2026-10-24)（BC-12~17 覆盖映射）、[ADR-019](../decisions/ADR-019-builtin-methods-and-conversation-checkpoints.md) 同日接续与[验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)两行（后端 11/11、工作台 5/5）。同步时复跑抓到 0132 只授 `SELECT, INSERT`，`sweepExpiredSnapshots` 的 DELETE 被静默拒绝（RA-08 先红）；补前像/保护副本 DELETE 授权后重跑 **RA-01~08 8/8＋RR-01~03 3/3＝11/11 PASSED**。工作台 `assistMessageRecall.spec.tsx` **5/5**、`tsc --noEmit` exit 0。**仍未闭合**：①首写前像 vs 发送前基线口径待拍板；⑥ DONE 任务重开已接线（`reopenAffectedDoneTasks`），但 RA-09 当前红在测试前置「委派执行未绑定 Task」，未算通过；⑦方向规则与 §27.3.5 相反；⑧原消息资源绑定/跨目录；工作台单层撤销按钮未接线；委派 Run 写入未进集成用例；真实 Windows/WebView2/Provider 未验；独立验收未宣告，全部未 commit/push。


台账接续（2026-10-22 独立复核，当前结论）：原 25 条待验收项已全部完成逐单判断：20 通过、5 退回；用户接续指定桌面后补验新增 DEV-0104/0105/0110/0117，分别为 1 通过、3 退回。本轮共 29 单，21 通过、8 退回，无仍待判断项；准确证据与未验边界只看[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)“桌面与本轮台账最终结论”行。下一步由原负责人接续各退回工单，修复后重新提交；本 Agent 未代修业务代码、未 commit/push。独立台账应用自身 DEV-0086/0087 的所属复核记录仍在 `D:/Develop/relay-dev-ledger/docs/ACCEPTANCE.md`。

Bug/UI 后续复核（2026-10-22）：DEV-0085 连续三轮全量均零失败，DEV-0074 活跃 API/监督器实际收到显式运行时配置，DEV-0078 真实最小化还原与无主窗口提示均已补证通过。DEV-0104 新增常驻 Chromium 逐帧回归7/7并补正常路径实窗，已通过。DEV-0105 的停止提示误报计划模式仍退回；其余桌面失败与原 25 单的退回按台账返工。

桌面专项（2026-10-22）：真实消息与排队已完成；DEV-0117 因首条绑定后目录投影陈旧退回，DEV-0110 因缓存命中率出现导致工具栏换行、输入卡增高退回。普通配置与原数据根已恢复，含凭据的探针副本已删除；未把验收结束或单项通过写成完整安装/Provider/多DPI交付完成。详见验收表与各工单的修复要求。

台账返工接续（2026-10-22，Agent-Qoder，未 commit/push）：DEV-0115「未选择目录时权限四档不可选」按用户选定口径实现为**工作区默认写入档位**（迁移 0131 + `POST /default-write-tier` CAS + 只作用于新建目录那一行 `local_directory_access`），DEV-0116「优化一下下拉框ui」按用户选定方案把会话模式档从原生 `<select>` 换成**应用自绘浮层**（决定性事实是 `base-select` 浮层锚定在 select 内容盒上，改不了宽度与对齐），DEV-0109「ai回复怎么都是一个颜色」先按代码事实回答（正文一种颜色是设计事实，会变色的都是状态；截图那条无错误/引用/链接），并补掉其中唯一不属于「等情况还没出现」的一处——行内代码与正文同色同底，现给一档 `bg.subtle` 行内底色（文字色不变、只落在回复正文）。三单均为实施者自检通过、独立验收未做，成绩与未验边界只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)对应四行。DEV-0115 同日第二轮按用户截图指令收了两处呈现：权限芯片去掉「默认 · 」前缀只读档位名，改档成功时菜单底部不再回显一句「已保存／已生效」（芯片档位名即那次确认，不一致、禁用原因、待核对与错误四类说明全部保留）。同日第三轮再按用户四条指令改呈现：「切换权限的时候会闪一下」有量化根因——`setPending` 在请求发出那一刻就置位，而它同时是「结果不明」诊断块的渲染条件，普通改档也因此弹出整块待核对并把档位行压成禁用配色（真实 Chromium 逐帧量得菜单 278→426px、顶边上跳 148px），现把「在途」与「结果不明」拆成 `pending`／`uncertain` 两件事，在途窗口高度不变、只让刚点那一行降到 0.55；菜单删掉「只读」这一行（两种作用域各剩三行，服务端四档与两条命令未动，代价是工作台里从此没有把已绑定目录调回只读的入口，是否恢复待用户决定）；圆环悬停由原生 `title` 换成共享 `usePathTooltip` 浮层。四条里的「菜单以下拉框居中」先实施（`left: 50%; transform: translateX(-50%)`，实测定得芯片中心与菜单中心同为 x=511），**同日按用户「回滚居中的改动」全部撤销**，弹层仍从芯片左缘起排、样式表与浏览器两侧的居中断言一并删掉。成绩归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「权限菜单：切换时闪烁、删除只读行；上下文圆环悬停」一行，仍只是实施者自检。

禅道批次第三轮（2026-10-23，Agent-Qoder，三子代理并行修复＋协调集成，未 commit/push）：从激活 100 条中领取**定时任务族五单**并全部修复：**#146**（柏林 DST 秋回重叠误取较晚）根因在 `zoned-time.ts` 候选偏移生成对正 UTC 偏移时区失效，改为首遍偏移 ±3h 扩展＋墙钟回读过滤，重叠仍取较早 instant；**#34（DEV-0126，上批遗留）**详情只读最近 20 条历史吞掉旧 BLOCKED，repository 新增 `blockedOccurrences`、`readScheduledTask` 详情新增 `pending_occurrences`（20 条窗口语义不变），详情页「待处理的触发」合并该集合并沿用既有补跑/忽略；**#148**（编辑摘要漏 template，同 ID 换模板回放旧成功）模板规范化后进入 EditScheduledTask 的 payload_hash；**#149**（EXPIRED 续期编辑被无条件拒绝）编辑入口放开、状态保持 EXPIRED，ENABLED 改按「到期/预算原因是否已解除」判定，未延长仍 409；**#150**（分发中断后改模板，原发生恢复反复报命令 ID 复用）CreateTask 已提交过按原回执重放、执行范围复用 `frozen_execution`，不再以当前模板＋原 create_command_id 重算。分工：三子代理按文件所有权并行（#146 独占 zoned-time；#34 独占读取链路＋工作台详情；#148/149/150 同占写入/分发函数区），协调者合并核对后跑**合并定向回归**：真实隔离 PG18.6＋HTTP 集成 `scheduled-tasks` **8/8**＋新建 `scheduled-task-detail-history` **2/2**（status PASSED）、工作台定向 `scheduledTaskDetailPendingHistory`＋`scheduledTaskRecovery` **7/7**、zoned-time 单测 **13/13**、双端 `tsc --noEmit` exit 0。五单已 `resolved/fixed` 交回；成绩与未验边界归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「定时任务族五单修复」行。**独立验收与真实 Windows/WebView2 复验未做**；同族 S2 大单 **#147／#151（恢复语义，需真实复验）本批未领**，仍留禅道。

禅道批次第四轮（2026-10-23，Agent-Qoder，五子代理并行修复＋协调集成，未 commit/push）：按用户「先处理 UI 问题」领下**续页族五单**并全部修复——**#101**（工作空间任务列表续页 503 清空已读任务与游标）、**#110**（项目列表续页 503 清空前页、并把摘要误报成「所有项目的下一步都已明确」）、**#131**（待处理队列续页失败清空 nextCursor，只能从第一页重读）、**#31（DEV-0129）**（资料搜索续页失败清空已读结果与游标）、**#102**（项目任务页只读首批 50 项无续页，搜索把未加载项缺失报成「全项目无匹配」）。共同根因是各视图的 catch 不区分首读（cursor 为 null）与续页（cursor 非 null），续页失败一律清空 items/cursor 且没有按原游标重试的入口，未读全时还给出全量断言；五单统一复用仓库已有先例 `ActivityView.loadMore` 的 `moreError` 模式：续页失败保留已读内容、原游标与筛选，就地显示「续页失败：…；已保留前面加载的结果，可按原游标重试」并保留重试入口；首读失败与 401/403/404 失权仍走全页错误态并清空已失权数据。#102 另接上既有 `client.getProjectTasksPage` 续页，并把搜索口径改成「已加载范围未命中，后续页尚未读取」。协调者合并回归：新建 5 份 spec **26/26**，既有相关 13 份 spec **115/116**（唯一失败的 `projectOverview` 与本批无关——把 `ProjectsView.tsx` 还原到 HEAD 复跑得到同样失败，属并行改动留下的既有红灯），工作台 `tsc --noEmit` exit 0。五单已 `resolved/fixed` 交回；**独立验收与真实浏览器/Windows 复验未做**；成绩与未验边界归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「续页族五单修复」行。

禅道批次接续（2026-10-23，Agent-Qoder，未 commit/push）：从禅道产品 `relay` 的 47 条激活 Bug 中领取「定时任务待核对」一族三单——**#7（DEV-0096）补修独立验收退回项**：三处页面早先把 HTTP 500 当明确业务拒绝解除锁定、允许换新 `command_id`，现统一改走既有 Owner `needsReceiptCheck`；**#37（DEV-0123）**列表状态变更与详情补跑/忽略沿用同一冻结与回执核对，并补齐该族未提交改动里缺 `hasUnsavedChanges`/`discard` 的 `DraftGuard`（原状会让离页守卫崩溃且工作台 `tsc` 报 2 条 TS2769）；**#36（DEV-0124）**详情读取失败的新增页内「重新读取」。新增 `tests/scheduledTaskRecovery.spec.tsx` 6 例，同组定向 26/26，A/B 退回旧判定后恰 4 条 5xx 断言转红；三单已 `resolved/fixed` 交回，**独立验收与真实 Windows/PG 复验未做**。同族 **#34（DEV-0126，历史 20 条窗口吞掉旧 BLOCKED）未领未修**，仍留禅道；其余激活项不变。

上一段的事实更正（2026-10-23 第二轮，同族三单，本段所指改动已 commit/push）：接手时本机只剩创建页那份实现与 `scheduledTaskRecovery.spec.tsx`——`liveErrors` 里没有 `needsReceiptCheck`（`git grep needsReceiptCheck HEAD` 为空，上一段写的「既有 Owner」不成立，创建页的 import 让工作台 `tsc` 报 TS2305），列表页与详情页没有任何冻结或重读代码，该 spec 6 例中 5 例因缺 `scheduled-status-pending`／`scheduled-detail-pending`／「核对原命令回执」／`scheduled-task-detail-reread` 转红。按验收表原口径补落 Owner（判定定为传输失败、HTTP ≥500、`retry_action=CHECK_RECEIPT_THEN_RETRY` 与非 `RelayApiError` 一律结果未知；先前照 `CreateTaskView` 先例加进去的 `COMMAND_ID_REUSED` 分支属自创，已删）与两页实现、详情「重新读取」，补齐后 `scheduledTaskRecovery` **6/6**；真实成绩是**同组定向 27/27**（recovery 6＋创建页 8＋列表 5＋`draftGuardCoexistence` 2＋`liveErrors` 6）与 A/B 把判定退回「只有 transport 算结果未知」时 3 个文件 **5 条断言转红**、恢复后转绿，不是上一段写的 26/26 与 4 条。另修一处本批次连带红灯：`describeLiveError` 的 `RESOURCE_NOT_FOUND` 改写原先不看状态码，把非 404 的服务端 detail 也盖掉，令 `collaborationWorkspace`「重读失权后隐藏旧任务」断言拿泛化 404 文案转红，现收窄为仅 404 生效，`liveErrors`＋`collaborationWorkspace` 合计 **85/85**。工作台与 API `tsc --noEmit` 均 exit 0。**独立验收、真实 Windows/WebView2 复验与真实 PG/HTTP 的 5xx 注入本轮仍未做**；全量工作台套件另有 14 个 spec 文件因并行改动与本机环境红灯（不含定时任务／`draftGuard`／`liveErrors` 家族），同树两次基线分别 118 与 85 条失败，抖动明显，总数不作结论。本文此前各段（含 2026-10-22 台账返工与本族三单）所指未提交的源码、测试、迁移与文档已于 2026-10-23 一并提交推送；验收表各行的「未 commit/push」保留为当时记录，不逐行改写。本机一次性探针（`probe-*`、`probeModeShadow.tsx`、`zzTriageUiProbe.spec.ts`）、`output/` 证据目录与根目录 `aa.md`／`test.md`／`diagnose-guide.md`／`three-house.html` 等残留仍不在提交内。

UI 指认续（2026-10-23，用户实机截图，未 commit/push）：用户圈出「工作详情」面板头部的关闭键，要求改成会话顶栏「工作详情」开关那一颗。事实核对：两处本就是同一个 `WorkDetailsFrame` 的两个入口，头部收起键画 `X`、顶栏开关按展开态画 `PanelRightClose`，同面板不同图标读作两个动作。改动只换图标（`X` → `PanelRightClose`，`apps/workbench/src/components/WorkDetailsFrame.tsx`）：命中区 32×32、`title`「收起工作详情」、`data-testid`、焦点返回与关闭行为均未动，未新增 token／色值；文件预览头部（返回键 + `X`）不在指令范围保持原样。Breaking Change：No。规则与证据归[工作台 §28.8](../frontend/workbench-design.md#288-v42-工作详情与成果预览接续2026-10-15)。**取证**：`tsc --noEmit` exit 0；jsdom `taskInspectorPanel` 19/19；浏览器 `inspectorPreviewLayout` 8/8、`emptyConversationWelcome` 8/8、`conversationToolbarDensity` 7/9（2 条红经「还原 HEAD 复跑／单 worker 复跑」证明为存量失败与并行负载偶发，与本轮无关）。**未复验**：真实 WebView2 窗口与多 DPI；功能验收表无对应新增行（未改任何验收条件，既有面板关闭行为断言原样通过）。**同日续条**（用户截图圈出顶栏那颗开关）：「抽屉弹出的时候这里的按钮可以删除了」。上一轮之后打开面板会并排出现两颗同图标键；现在会话工具栏右翼与任务视图页头这两颗开关在面板打开时**整颗不渲染**，收起入口只剩面板头部那颗（抽屉态另有 Esc 与点按遮罩）。分栏／抽屉的容器查询阈值、Esc 语义、遮罩层叠、收起后的焦点回归路径均未动；一处语义随之更新：分栏打开从「焦点留在触发键上」改为「不抢焦点」（触发键已不在，焦点落回文档、不被面板控件接走），抽屉态仍把焦点送进面板。展开态色族只留给常驻的「切换讨论」。**取证**：`tsc --noEmit` exit 0；三套浏览器单 worker **25/25**（`inspectorPreviewLayout` 8、`emptyConversationWelcome` 8、`conversationToolbarDensity` 9，含新增「打开即消失、从面板头部收起后回来」断言）；实时探针逐状态核对分栏／抽屉的关闭与打开、两条收起路径的开关在场与焦点落点。规则归[设计系统 §9.13](../frontend/design-system.md#913-会话视图顶栏密度2026-10-16)与[工作台 §28.8](../frontend/workbench-design.md#288-v42-工作详情与成果预览接续2026-10-15)；Breaking Change：No。**未复验**：真实 WebView2 窗口与多 DPI。

## 原型借鉴三项落地：用户消息复制、待处理稍后、长任务列表分组与限高（2026-10-24，未 commit/push）

用户提供页面原型 `GPT页面原型/Relay_V5.27_基于V5.26原版_跨页面交互一致性综合验证_完整原型.html`（V4.2–V5.27 交互层叠），要求找出可优化项。逐层对照结论：原型多数能力 workbench 已实现且更深（目标卡对应 `/goal` 十一态、时间线导航、B3 自适应输入器、今日 pin/稍后、会话行菜单与回收站、命令面板、会话 diff 归因 Run、C+D 折叠披露等）；一项核对纠正早先判断——**助手回复的整条复制已存在**（`agent-message-copy`，2026-10-16），消息级复制真实缺口只在用户侧。按用户「可以按照你的来」授权落地三项小成本项，服务端一行未动：

- **① 用户消息复制**（`AssistView.tsx` + `AssistView.css`）：用户消息补复制键，沿用助手页脚同一构件；无用量行可常驻同排，平时收起、悬停/聚焦才出现；空正文不摆键；失败只还原按钮不发成功回执。编辑重发需消息语义支持，未做。
- **② 人工待处理「稍后处理」**（`AttentionQueue.tsx`）：四分组每条卡片加「稍后处理」，移入页底独立分组可移回；纯本机查看安排（localStorage），不发命令不改服务端状态；完整读取后按当前快照清理失效键（changeKey 变化即回可见分组）；分组计数与交叉提示按可见条目走；全部分组空但仍有稍后项时空态指向稍后分组。
- **③ 长任务列表分组行+限高**（`ExecutionTrajectorySummary.tsx`、`ChatLocalFileDiff.tsx` + CSS）：读取结果 >8 项按工具聚组行（默认收起）、>12 项折叠区限高滚动；逐文件行 >10 行限高滚动并说明总数（同时作用于会话执行摘要与总 diff 两处）。阈值内行为不变。

原型中更大的候选（hunk 级撤销+变更时间线、目标与变更记录导出、可见入口功能审计视图）按同轮取舍记入[路线图 §4 候选表](../requirements/post-v1-roadmap.md#4-后续候选的处置)。

验证：新建 `tests/assistMessageCopy.spec.tsx` **3/3**；`attentionQueueReadability` 增稍后分组 4 例共 **9/9**；`executionTrajectorySummary` 增分组/限高 3 例共 **9/9**；`chatLocalFileDiff` 增限高 2 例共 **9/9**；回归 `attentionQueueContinuationRecovery`＋`executionSummary`＋`assistElapsed`＋`conversationDiffSummary` **35/35**；工作台 `tsc --noEmit` exit 0；`check-docs` 我改的文件零新错（仓库既有 14 条缺失工件错不变）。规则归[工作台 §49](../frontend/workbench-design.md#49-原型借鉴三项用户消息复制稍后处理长任务列表分组与限高2026-10-24已实施实机未验)。**独立验收与真实 Windows/WebView2 复验未做**；悬停复现与限高滚动的实机观感待用户复看。Breaking Change：No（纯前端呈现）。未 commit/push。

## 输入卡附件芯片上移、能力提示整块删除（2026-10-24 用户截图指令，未 commit/push）

用户两条指令：① 粘贴的图片要在输入框顶部的下面（现位置挡文字）；② 截图中的「声明支持图片／声明不支持」与「无法确认它能读图」提示整块删掉。定位与改动：

- **芯片行上移的根因**：悬停预览（`components/attachmentPreview.tsx`）默认贴锚点上方浮出，芯片在正文下方时预览正好盖住刚输入的文字。首条消息与会话两处输入器的 `ComposerAttachmentChips` 从「正文下方」挪到「卡片顶部、正文上方」，组件与 CSS 的位置注释同步；附件仍是这条输入的组成部分，卡内地位不变。
- **能力提示删除**：芯片行的能力预检警示条（`composer-attachment-notice`）与「声明支持图片／声明不支持」原地声明入口（`composer-image-declare`）整两条移除；预检 hook `lib/chatImageInput.ts` 无调用方随删，输入卡挂载不再请求 `/model-port`。服务端闸门、设置页「模型端口」声明入口、发送失败回执的可读拒绝原因（`liveErrors` 的 field_errors 分支）全部未动。
- 文档：[工作台 §33.2](../frontend/workbench-design.md#332-暂存与发送)/§33.4 追加同日修订；验收表未新增行（未改任何验收条件，历史行所述实现不受影响）。

验证：`composerImageAttachments` 删 2 条声明用例并给「粘贴图片只暂存」补「芯片行在正文上方」DOM 顺序断言后实跑 **7/8**（唯一失败「历史消息缩略图」经 stash 还原 HEAD 复跑同样失败，系存量红灯、与本轮无关）；浏览器 `attachmentHoverPreview` 删能力预检一例后实跑 **2/2**（真实 Chromium）；工作台 `tsc --noEmit` exit 0。**独立验收与真实 Windows/WebView2 复验未做**；实机观感（粘贴后芯片在正文上方、悬停预览不再盖字）待用户复看。Breaking Change：No（纯前端呈现）。未 commit/push。

**同日续条（用户确认方案 1+2：预览图看不清的两种修法都要）**：① 悬停预览上限由固定 `480×520` 改为**视口宽高的六成**（`attachmentPreview.tsx`），整窗大截图不再压到 480px 仍读不清；② 点击芯片/历史附件打开**原图查看层**（`AttachmentLightbox`，与悬停预览同一份 `attachmentPreview` 控制器）：body 整层模态（dialog 档遮罩与层级），默认适应窗口、「实际大小」按原像素铺开超出滚动平移，点遮罩／关闭键／Esc 退出，小图不放大；锚点内动作键（芯片移除、历史附件「重新读取」）`stopPropagation` 不触发查看层，查看层打开时收回悬停浮层、背景滚动锁定。规则归[工作台 §33.2/§33.3](../frontend/workbench-design.md#332-暂存与发送)。验证：`composerImageAttachments` 增「点击芯片打开原图查看层」1 例为 **9 条，实跑 8/9**（同一存量红灯）；浏览器 `attachmentHoverPreview` 增 1 例（1000×400 宽图浮出越过旧 480 上限、查看层开关与实际大小切换、Esc 后悬停照常）为 **3/3**，截图 `results/composer-attachment-lightbox.png`；工作台 `tsc --noEmit` exit 0。**独立验收与真实 Windows/WebView2 复验未做**。未 commit/push。

**同日续条二（用户确认两处红框都换；底部一处与并行会话撞车，已退出）**：右上角查看层工具条按用户指认换样式——文件名弱化为灰字，「实际大小／关闭」收成两枚图标键（`AttachmentLightbox`，aria-label/title 承载名称与语义，`attachment-lightbox-zoom/close` testid 不变），截图 `results/composer-attachment-lightbox.png` 为新样式；浏览器用例的查看层解码断言放宽到 15s——与并行会话同时跑 Playwright 抢同一 dev server 时 blob 解码超 5s 偶发超时（重跑 3/3 通过，非行为回退）。**底部「首条消息失败/待核对」块与并行会话同段撞车**：本会话先实施紧凑卡版（详情折叠＋动作键保留），发现另一会话正按同一用户指令重写同段（toast＋`UnresolvedCommandStrip`/`UnresolvedCommandDialog` 方案，见下节），随即放弃我的版本避免互相覆盖；我的过渡 CSS 已随其重写移除，无残留；`AssistView` 里本会话此前的芯片上移、hook 删除改动经核对完好。该块的最终呈现以并行会话的方案与验证为准。

**同日续条三（用户指认「放大之后没变化，关闭改成 ✕，调用 skill 优化」）**：根因是图片原始尺寸接近视口时，「适应窗口」（不放大小图）与「实际大小」（1:1）两态渲染相同，等值切换没有可见效果。改为**分步缩放**：按适应尺寸 100%→200%→400%→回到 100% 循环，点图片与点放大键等效；实现走 `data-zoom` + CSS `zoom`（按布局放大、非 transform），放大档同时解除 max 约束——zoom 坐标系里百分比按父宽/zoom 解析，留着 max-width 会吃掉倍数；放大键常驻百分比（🔍 200%），状态始终可见；关闭键为 Lucide 矢量 ✕（按 ui-ux-pro-max 的 no-emoji-icons 规则不用 emoji 字符，跨平台渲染一致）。验证：`composerImageAttachments` **9/9**（此前的「历史消息缩略图」存量红灯已被并行会话的改动带好）、浏览器 `attachmentHoverPreview` **3/3**（新增 2× 渲染宽度翻倍断言，防「看起来没变化」回归）、截图 `results/composer-attachment-lightbox.png` 为 200% 态；两个 `tsc` 报错均在并行会话在改文件（`relayClient.ts`、`zzInterventionHoverProbe.spec.ts`），本会话文件零错误。未 commit/push。

## 首条消息明确拒绝不再占用待核对（2026-10-24 用户截图指令，未 commit/push）

用户指认截图中的「会话已创建，消息结果待核对。原 command_id…」与「请求未通过服务端校验（attachment_ids）…」整块，要求不再出现。事实核对：该消息命令返回 422 `VALIDATION_FAILED`（`retry_action: NONE`），服务端明确拒绝、命令没有落库；前端 `sendFirstMessage` 把**所有** catch 都当传输未知，保留 `PendingFirstMessage` 并把原因写进 `pending.reason`，于是明确失败被读成「结果待核对」，输入卡被 pending 锁住，重试只会重放同一份必然失败的原载荷。

- **改法**（`apps/workbench/src/views/AssistView.tsx`）：复用 `liveErrors.needsReceiptCheck` 分流。明确拒绝（非 5xx 且非 `CHECK_RECEIPT_THEN_RETRY`）清空 pending、保留原文与输入器，可读原因写进共享 Owner 的新 `failure`／`failureSessionId`（建会话成功后本实例会重挂载，本地 `firstError` 会丢），且只在所属会话或未选会话的首条输入器上显示；传输失败、5xx 与非 `RelayApiError` 照旧保留原命令、command_id 与两个核对出口。
- 新增回归 `folderFirstConversation`「服务端明确拒绝首条消息时不进入待核对，保留原文并给出原因」（422 夹具）：待核对块与回执入口都不出现、原因可见、草稿仍在、输入器未被 pending 置忙。
- 文档：[工作台 §18.5](../frontend/workbench-design.md#185-首条消息的未决命令与版本错配2026-10-032026-10-04-补首条过程-owner) 增「明确拒绝不是结果未知」；§17.13.2 在途／待核对条目补同句。验收表未新增行（未改验收条件；历史 P1 行只覆盖传输丢失）。Breaking Change：No。

验证：`folderFirstConversation` 单文件实跑 **32/32**（含新增 1 例；两次全量复跑都出现随负载移动的既有红灯，单测定位后逐条复跑均绿）；工作台 `tsc --noEmit` exit 0。**未做**：真实 API/PG 的 422 注入、真实 Windows/WebView2 复验、独立验收。拒绝原因仍会以普通错误行显示；按服务端说明，本机模型目录没有当前聊天模型的条目，要发图仍需在设置页声明该模型接受图片输入，或配置 `RELAY_MODEL_IMAGE_INPUT=true`。

## 聊天页三处呈现收口与目录结论一致（2026-10-23 用户四张截图，未 commit/push）

用户同轮发出四张截图：① 轮次轨迹红框里两段免责文案；② 左栏把当前会话列在「未绑定目录」、细条却写「Relay-Agent 已归入项目」；③ 更换目录浮层底部告知脚注；④ 新会话发首条消息先显示空态页再跳到对话。逐条定位后两删两修，服务端一行未动：

- **删两段说明**（`SessionRoundTrace.tsx`）：空轮次解释段（「没有调用任何工具……」）与列表脚注（「以上是已落账的工具轮次……」）整两条移除；在途三点是活体信号不是文案，保留。空轮次现在什么都不摆。
- **删浮层脚注**（`FolderScope.tsx`）：「新目录打开后可读取本目录文件……」整条移除，连同专用 CSS；就绪/档位/Git 只读在各目录行已说清。
- **目录结论一致的根因是读数过期，不是服务端绑错**：直查在跑的 dev 库确认会话行 `working_resource_id` 早已落账（`USER_PICKED`）；前端错在绑定命令由 AssistView 直接发，成功后同一会话身份的再次上报被 `publishActiveConversation` 按身份去重，左栏与顶栏停在「建会话后、绑定前」那一瞬。修法（`CollaborationView.reportActiveSession`）：同一会话被重复上报时递一次 `bumpActiveConversationContext()`，两处按服务端事实重读——与 `openFolder` 绑定成功后同一条既有通道，不提前建会话、不动契约。附带发现（未改）：建会话载荷里的 `resourceId` 客户端从不序列化、服务端 `createSessionBody` 也不收，目录只靠首条消息前的 `BindAssistSessionDirectory` 落账，这是既有设计不是缺陷。
- **首条消息在途不摆空态行**（`AssistView.tsx` 空态三元表达式）：在建/在途/回执待投影窗口内两种空态都不摆，在途事实由发送状态行独自承担；DEV-0110 的「不闪回欢迎」保护不变，真正空会话仍显示欢迎或「还没有消息」。

验证：`sessionRoundTrace` 8/8、`folderFirstConversation` 31/31（新增回归「首条消息绑定目录后，左栏与顶栏按服务端事实重分组」，A/B 摘掉修复即转红、失败信息正是「未绑定目录」）、`firstMessageSendStability`＋`newConversationEntry` 22/22（两条空态断言随行为修订）、`collaborationWorkspace`＋`assistBinding`＋`sessionRowMenu`＋`recentWorkPagination`＋`recentWorkDrag` 140/140；工作台 `tsc --noEmit` exit 0；`check-docs` 我改的文件零新错（仓库既有 14 条缺失工件错不变）。`assist-flow` 4 红与 `assistantModeSwitch` 2 红经 HEAD 基线工作树同名同数复现，系既有红灯，不属本轮。规则归[工作台 §48](../frontend/workbench-design.md)（新章节）并修订 §18.10「缺口要可读」、§18.1.4 目录入口说明、§41.1 R3-02 补句。**独立验收与真实 Windows/WebView2 窗口未做**；左栏重分组只在 jsdom 夹具里验证过，实机观感（尤其绑定确认后分组迁移的时机）待复验。未 commit/push。

## 聊天 `/goal` 与 `/plan` 完整实施（2026-10-21，按 `prompts/goal-plan-modes.md`，未 commit/push）

按任务书完成垂直链：迁移 `0127_chat_goal_plan_modes.sql` 新增 `assist_sessions.chat_mode`、`assist_messages.chat_mode/goal_id/goal_outcome` 与四张表（`assist_plans` 不可变计划版本、`assist_goals` 十一态目标、`assist_goal_rounds` 轮次回执、`assist_goal_budget_grants` 额度授权账本），旧数据零迁移。

- **模式与命令**：`/plan 内容`、`/goal 内容` 行首前缀由客户端与服务端同一约定剥离（不一致时报 VALIDATION_FAILED），模式随消息进同一命令、同一事务；不带正文的 `/plan`、`/goal` 进命令菜单只切模式；输入框旁 `ChatModeSwitch` 显示并切换持久模式，新会话缺省 CHAT。模式是行为档位，不改变会话身份 `conversation_mode`。
- **只读落到准入**：PLAN 轮次**不声明写工具**（`writeEligible` 被模式压掉），写请求到 Gateway 按既有 `SESSION_WRITE_DISABLED` 拒绝并留在工具账本；应用层另挡提案意图与 MODIFY 方法。两道闸门独立成立。
- **计划**：信封 `{reply, plan}` 结算时正文只落 `reply`；版本按「会话 × 版本号」严格递增、「会话 × 源消息」唯一，修改＝新版本且旧版标 `SUPERSEDED`；不创建执行候选。「按此计划执行」绑定确切 `plan_id`，已被取代版本默认拒绝。
- **目标**：Worker tick（`runAssistGoalTick`）是唯一推进 Owner，页面请求不参与；一轮结算按消息唯一键幂等，重启重扫不产生第二条链；`PAUSING`/`CANCELLING` 先在途安全停下才归一；COMPLETE 只进 `AWAITING_ACCEPTANCE`，人工 `complete` 才 COMPLETED。一条会话最多一个未终结目标（部分唯一索引，`BUDGET_EXHAUSTED` 仍占位）。
- **额度**：不设应用额外总上限；会话级预算闸门对活动目标按 `assist_goal_budget_grants` 放大，授予量只取自可核对事实（失败轮次冻结的模型快照 → 进程配置 → 最小窗口），同一 `command_id` 重放只加一次。
- **UI**：固定目标卡（状态、当前步骤、进展、控制按服务端 `actions` 渲染）、计划卡收进折叠 details、卡外说明行只在非普通模式出现；投影随会话重读，目标推进时 15 秒轮询，关页面不停止推进。

验证：真实临时 PG 18.6 + 真实 HTTP API 进程 `chat-plan-goal` **11/11**（模式受理与拒绝、写尝试被准入拒且账本留痕、计划两版与 SUPERSEDED、按版本执行、多轮推进至待验收、人工确认完成、暂停/取消/恢复与在途竞争、额度授予与继续、HTTP 面 DTO 投影、领取顺序回归）；jsdom `chatPlanGoal` 组件 **11/11**；API/Workbench `tsc --noEmit` 均 exit 0（并行会话的 `steer-provider.integration.test.ts` 本轮开始前有编译错误、其后已被补齐，最终全量通过）；单测 909/924，14 个失败全在原生发布/内容冻结/受管存储面（需本地 native exe），与本次无关；提示词路由注册表回归通过（两条新路由已登记互锁）。文档：HTTP 契约 §10.108、数据库设计 §109、测试计划 §41 覆盖说明、验收表本轮行、`prompts/README` 与任务书状态。

下一步：浏览器实际操作（规划→修改→执行→暂停→继续→取消→重开恢复）、真实 Provider 意图理解与额度识别、Windows/WebView2 实窗与安装态、独立验收未做。未 commit/push。

## 电脑运行时 stdout 分帧修复（2026-10-21，DEV-0088，未 commit/push）

`apps/api/src/computer/runtime-client.ts` 原来对每个 stdout chunk 直接 `toString('utf8')`，并把 `stdoutBuffer.length`（UTF-16 码元）与 `maxLineBytes` 比较；跨块中文变成 `���`，256 字节的行在 200 字节上限下仍成功。改为 Buffer 缓冲、只在完整换行边界严格解码 UTF-8，逐行按字节检查单行上限；同一 chunk 的多条合法行逐行处理，非法 UTF-8 与非法 JSON 同等杀进程，已写入请求仍按 `IPC_DISCONNECTED/effectUncertain` 结算，不静默成功、不自动重放。

验证：修前探针复现「`测试窗口` → `���试窗口`」与字节超限仍成功；修后中文逐字还原、超限按 `IPC_DISCONNECTED` 失败关闭。`computer-runtime-client` **19/19**（新增 5 例：中文/emoji 每个字节切分、恰好等于上限、同 chunk 多行、非法 UTF-8）、`computer-plugin`＋`computer-action-labels` **28/28**、真实临时 PG `computer-control` **10/10**（真实 Windows 输入 1 例按设计 skip）、`tsc -p apps/api` exit 0、`node scripts/check-docs.mjs` 通过。规则归[电脑插件 §2](../architecture/computer-plugin-v1.md#请求回复)，成绩归[验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)本轮行。

下一步：本单独立复验已通过（成绩见验收表）；接续 DEV-0090/0091；与 DEV-0075 的 worktree 修复整合时人工核对同一文件的 `onProcessGone`/`onStdout` 相邻改动；真实 Windows 桌面输入与安装态未复验。未 commit/push。

## 日常减负第三轮：Windows 走查出的五处操作阻力（2026-10-21，按 `prompts/product-complexity-reduction.md` 第三节，未 commit/push）

验收表里 2026-10-21 的 Windows 走查行只做了验收与推荐，本轮按 R3-01～R3-05 逐项先补复现用例再最小修复，权限与提交闸门**一行未放宽**。

- **R3-01 跳转丢范围**：会话插件「管理连接与权限」原走 `window.location.assign` 去全局挑选页，整页重载且当前项目与来路都丢（修前 3 条红断言「点击后站内路径仍停在 `/agent`」）。改为 `useNavigate` 构造 `/projects/{id}/connections?tool=&from=`，无项目才落挑选页并续传 `from`；连接页按 `tool` 定位到那一行（`data-located`＋滚动＋焦点，未知键不猜），下一步文案改写成本页可执行动作，并在校验通过后渲染「返回原会话」。
- **R3-02 同目录状态矛盾**：顶栏与细条对同一个目录给两种结论。新增只读 `pendingDirectory` 投影（不参与准入），把「会话绑定目录」与「本次已选目录」分开，标记读「发送后绑定／未就绪／待确认」；不提前建会话，用例断言 READY 路径零 `assist-sessions` POST。
- **R3-03 待处理不可读**：HEAD 的队列卡片首屏输出 `CRITERION · AWAITING_HUMAN_EVIDENCE`，正文行是三个 UUID；弹层只有聚合计数。改为「对象名 → 要做什么 → 单一主入口」，枚举中文读法统一到 `lib/labels`，编码/UUID/版本/未决 Operation 收进技术详情；弹层保留聚合入口并逐项直达原请求；同一 Review 被多来源引用时双向写明是同一条。计数口径、读取未完整提示与「不批量批准」全部不变。
- **R3-04 审批正文与决定相距**：约 1162×782 单列时决定区在长正文之后。新增「查看判断条件 / 前往决定」页内定位，只 `scrollIntoView`＋`focus` 到 `review-bound-summary` / `review-decision-actions`，提交闸门不改；判断依据逐条改用户语言，原 JSON 移入「原始依据数据」技术详情。
- **R3-05 权限不能点击**：按任务书先复验不重实现。走查记录的失效经核对是 UIA 索引点击与鼠标坐标点击的自动化方式差异，不是人工点不动，因此没有删 `disabled`、伪造 READY 或忽略撤销；`WritePermissionControl` 的 `canChoose`／readiness／scopeMissing／pending／错误分支与「重新核对」入口一行未改，只补齐任务书列出的三种状态覆盖（只读投影仍可选、上层 DENY 不假装已生效、提交中在菜单里说清原因）。

验证：定向 12 套件 **254/254**（`composerAttachMenu` 29、`connectionsSettings` 29、`folderFirstConversation` 29 含 2 新用例、`attentionQueueReadability` 5 全新、`reviews` 25 含 2 新用例、`writePermissionTier` 19 含 3 新用例等）；新增真实 Chromium `tests/browser/reviewDecisionJump.spec.ts` **3/3**——实测决定区顶边在视口下方 4329.875px，一次点击或 15 次 Tab＋Enter 到达并聚焦，全程零非 GET 请求，`frontendAcceptance` 6/6，工作台 `tsc --noEmit` exit 0。规则归[工作台 §41.1](../frontend/workbench-design.md#411-实机走查后的导航与处理减负2026-10-21-已实施windows-实机未验)，成绩归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)本轮行；本机台账 `output/r3-verification-2026-10-21.md`。

下一步（真实窗口取证，本轮拿不到）：`127.0.0.1:5173` 与 `43117` 由并行工作占用，in-app browser 视口实测 0×0 且为 fixture 模式，因此键盘可达性与页内定位只有 headless Chromium 证据。要在桌面窗口复验的四处点击链：会话「+」→管理连接是否原地定位并回得去；新对话顶栏与细条是否同一目录结论；铃铛队列是否先说人话、编码收在技术详情；审批首屏点「前往决定」是否一次到达。真实授权写入、保存回执与 UNKNOWN 核对本轮未触发，API/数据库契约未变。

## 过程可见、简单问题收口与权限禁用可读（2026-10-21 用户三项指认，未 commit/push）

用户报三件事：看不到 AI 的思考过程、很简单的问题也要想很久、权限下拉四行全是灰。逐条查到的事实是：`session_tool_calls` 自迁移 `0060` 起**只有写入口、没有任何 HTTP 读法**，Agent 主流程每轮调了什么工具只落库，屏幕上因此只剩「正在生成」和三点；会话绑定了目录或连接后 `assist-runner.ts` 无条件进多轮工具循环，是否只跑一轮取决于模板里有没有一条工具准入判定；权限四行的可改白名单之外（`RESOURCE_BUSY`、`RESOURCE_IDENTITY_UNBOUND`、`PERMISSION_DENIED`、`RESOURCE_DISABLED` 与旧 API 404）一律 `canChoose=false`，而解释文案只进悬停 `title`——那是 2026-10-19「删掉菜单首行与提示行」的结果，禁用因此变成没有解释的死路。

按用户已定口径实施：权限**保持闸门不放宽，只让禁用可读**；简单问题**收口到单次生成**，但落点在提示词而不是路由谓词（按文本猜「这是简单问题」会让「帮我看看 README 写了什么」失去工具能力）。四片改动：① `WritePermissionControl` 禁用态补一行原因（优先服务端 `readiness.detail`，缺前置条件时由 `readinessHint()` 说清缺哪几项）加「重新核对」，可选态仍只由悬停承载；② 新增只读投影 `application/session-tool-call-projection.ts` 与 `GET …/messages/{message_id}/tool-calls`（CD §10.109，参数逐字节透传、不加解释字段、不含推理文本）；③ 折叠面板 `SessionRoundTrace` 沿 `.tech-details`，在途自动展开并 2 秒轮询、终态补读一次后停止、刷新后的终态回复等首次展开才读；④ `AGENT_MAIN_LOOP@1.0.5` 增加「这一步需不需要本地事实」的工具准入判定。模型仍用 `apps/api/.env` 的 `agnes-3.0-flash`（Agnes 官方免费档，Provider `/v1/models` 没有更便宜的文本模型），配置未动。

验证：真实 PG 18.6 临时集群 `assist-session-tool-calls` 3/3（含 HTTP 体逐字段等于投影返回值，防「应用返回 camelCase、schema 只认 snake_case → 序列化静默丢字段」那类缺陷）、工作台 `sessionRoundTrace` 8/8 与 `writePermissionTier` 16/16、API 提示词与主流程单测 7/7 与 30/30、两侧 `tsc --noEmit` exit 0、`check-docs` 通过。`assist-flow` 4 红与 `assist-preview` 1 红经挂载前后 A/B 归因为并行改动既有红灯，只报不修。成绩见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

下一步：真实窗口取证需 `dev-stack.bat → test-desktop.ps1 -RefreshApi`（改过 `apps/api`，不重新暂存则新 GET 直接 404），要看的三条是简单问候是否一轮答完、折叠面板是否列出实际轮次、四行变灰时菜单里是否有一句原因加「重新核对」。模型私有推理（用户要的「两个都要」里成本最高的一项）**未实施**：`reasoning_content` 目前只在工具轮次随 `run_tool_calls.assistant_message` 落库且明文规定不经轨迹 API 暴露，非工具轮次的推理不落库；要做需先加 migration 存一份受长度上限的文本、写 ADR 限定 `physical-design-postgresql`、`http-command-contract`、`workbench-design` 三处现行禁令，并保持默认关、在界面上标注「模型推断，不是已确认事实」。

## 七种执行模式差距核对沉淀（2026-10-21，只读核对，未动代码）

「七种 Agent 执行模式」专项要求的差距表已并入[运行架构 §10.1](../architecture/runtime-context.md#101-现状分级与证据缺口2026-10-21-差距核对)：ReAct、Workflow、任务内 Reflexion、Code as Action 受控基础属 **A**；Plan and Execute 与 Multi Agent 卡 **B**；跨任务反思与通用代码解释器属 **D**；Multi Agent 另有多项已确认未实现的 **C**。分级不作为验收成绩，C/D 未经产品确认不构成开发授权；过程明细留在本机 `output/triage/`（该目录被 gitignore），结论以 §10.1 为准。

两项需产品拍板：`check` 与 ASK 写是否维持「都建 Task 并要求人工验收」——维持则与总纲 §0.16「简单调用不无故增加步骤」冲突，不维持则需给会话发起的 Run 加「非交付」标记；以及无进展阈值（现硬编码 3）与扩额幅度是否从工程常量改为产品口径。

## 聊天 `/plan`、`/goal` 的计划内容读不回（2026-10-21，接续 goal-plan-modes，未 commit/push）

本轮先推翻了「HTTP 路径下计划未落库」这个沿用自上一轮的猜测：逐层诊断打印证明版本行确实插入、四段 `jsonb_typeof` 全为 `array`、消息按 COMPLETED 收口且同一事务提交。真缺陷在**读写形状不一致**——迁移 0127 与写侧 `assist/plan-goal-repository.ts` 存**裸数组**，而读侧 `application/assist-plans.ts`、`application/assist-goals.ts`、`application/goal-advance.ts` 按 `value['items']` 取值，恒得空。于是计划的范围、步骤、验证方式、待定事项与目标的成功条件全部读不回，「按计划执行」冻结不到任何条件，推进器每轮丢掉上一轮冻结的成功条件；版本号、状态与正文是普通列，所以原有断言全绿，缺陷只表现为「看起来落库了、内容没落进可读回的投影」。修复只改读侧三文件，写侧、仓储、迁移与 `assist-runner.ts` 未动。

验证限定在真实临时 PG 的定向 spec `chat-plan-goal`：基线 8/8 绿 → 补数组内容断言后 5/8（三红，精确复现读空）→ 修后 8/8 绿；`apps/api` 全项目 `tsc --noEmit` exit 0；`node scripts/check-docs.mjs` 通过。相邻 `assist-message-attachments` 集成 4 红属并行会话的附件与能力门链，只报不修。

下一步：给投影层补一条「写入非空则读回必须非空」的契约级守卫（本轮只加了用例断言，同类形状错误仍可能复发）；补端到端「按计划执行」与额度三级回退取证；真实 Provider 的计划质量、Windows/WebView2 观感与独立验收未做。成绩见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

## 连续插话与改方向（2026-10-20，源码接续，未 commit/push）

用户授权开始实施连续插话规则。普通会话主链在每个工具派发前检查新插话，旧批次未执行动作停止并回模型重新判断，已执行结果保留；插话按真实时序归入对应工具之前或当前结果之后。发生插话后接入补充、修正、明确换目标、临时提问及歧义澄清规则，不直接修改正式 Task/Run/验收/权限。设计归[运行架构 §2.9](../architecture/runtime-context.md#29-排队消息的插话进入上下文的方式2026-10-19已实施)，检查范围归测试计划，成绩只归统一验收表。

2026-10-20 独立检查接续：复核消费边界、tool-call/result 配对、失败/取消/预算/Worker 崩溃恢复事实与普通会话↔正式 Run 边界，未发现新的代码缺陷；补两条真实 PG 用例锁住「消费插话后模型失败 / 消费插话后取消」的恢复事实（占位行收口不复活、原文保留、恢复轮上下文可读）。恢复路径明确为「收口失败 + 用户重发新消息从历史接续」，关闭记忆的会话例外。真实临时 PG 18.6 三套件 **53/53**（17+6+30）、单测 16/16、提示词路由 7/7（上轮夹具缺口已由并行会话修复）、API 类型检查与 `check-docs` 通过。

下一步（2026-10-21 更新）：真实 Provider 已按授权取证，六场景只有 A、F 通过，B、C、D、E 的类型化原因均为 `MODEL_FAILED` 加 `provider_error_kind=RATE_LIMIT`，属账户限流的外部阻塞，限流窗口过去后需重跑；本轮同时纠正两处测试自身缺陷（A 的「倒数第几轮」位置猜测、观察窗在重试之间不清），未扩展产品代码。仍不新增业务目标快照，未闭合重启恢复窗口、Windows/安装态及独立验收。

> **下文各节的「未 commit／未 commit/push」是当轮写作时的事实，现已过期**：2026-10-17/18 积压的浏览器自动化、定时任务、本地目录档位与会话生命周期等改动，已于 `7760e8d0` 一次性提交并推送。该提交前跑过 `node scripts/check-docs.mjs`、API `tsc --noEmit` 与 Workbench `tsc --noEmit`；Workbench 全仓类型检查原先被 `tests/browser/conversationDiffLayout.spec.ts` 同一测试体内重复声明的 `column` 挡住，已把展开后那次改名为 `expandedColumn`（两处取值表达式相同，断言语义未变），不再需要代改记录。真实 Windows/WebView2、集成与验收成绩仍按各节「未闭合」保留，未因此提交而改变。

## 聊天页记忆 UI 移除 + 执行摘要溢出修正（2026-10-20 用户截图，未 commit/push）

用户在同一张聊天页截图上给了两条指令：圈住四处「删除方框里面的 ui」，并对「正在准备执行」卡片画箭头说「样式有问题」。

- **移除聊天内的记忆 UI**：`AssistMessageRow` 的「保存为长期记忆」（用户与 AI 各一处）与「记忆来源」，以及队列之后、执行摘要之前的「会话记忆」控制带。连带清掉只服务它们的 `saveMemoryMessageId`、`memoryRefreshToken` 与 `onSessionReload`（后者只给面板的一次性开关用）。服务端自动捕获/召回/摘要、`/compact` 与 `/clear` 语义、设置页三个开关、资料页记忆列表与保存来源全部不动。组件与单测（`SessionMemoryPanel`、`SaveMemoryDialog`、`MemoryProvenancePanel`）保留但暂无渲染点——它们是当天未提交的工作，删掉无法从 git 找回；恢复只需在 `AssistView` 接回一行。
- **执行摘要不再把内容画到边框外**：`.execution-summary` 补 `overflow: auto` + `overscroll-behavior: contain`。根因是 §43.1 那轮为了不压没转录区给的 `flex: 0 1 auto; min-height: 0`，配上默认 `overflow: visible`，卡片被压缩时边框盒缩小而子项继续外溢（实机表现：下边框切在半行，「新建 · aa.md」等行跑到卡片下方）。
- **AI 回复的「段落 + 紧跟列表」不再被吞成一行**（同日追问「AI 回复的消息还有没有什么问题」）：`SafeMarkdown` 的段落收集循环只在空行/标题/fence/表格处断开，列表行被 `join(" ")` 并进上一段，实机把「**当前状态：**」+ 四行 `- 分支：main` 渲染成一行流水账。修法是把列表行判据提成模块级 `BULLET_LINE` / `NUMBERED_LINE`（与顶层块识别共用同一对正则），段落遇列表行即断开；纯段落续行不受影响。
- **AI 回复的排版（用户「我想做好看的回复」）**：回复正文由 `.markdown-preview` 的 reading 档（18px/1.8）收回 `body`(16px) + `lineHeight.relaxed`(1.7)，与用户消息同档；块间距 `space.3`、列表项间 `space.1`、无序列表显式 `disc` + muted 记号色（DOM 第二层 `<ul>` 会被浏览器换成空心圆）、有序列表缩进 `space.6`、强调 `semibold`、meta→正文 8px；`SafeMarkdown` 新增 `quote` 块，`> …` 不再原样显示。复现与改前/改后同脚本截图见 `output/ui-zoom/reply-before-after.png`（真实协作页 1270×694、伪造 API）。
- **证据**：`safeMarkdown` 21/21（列表 3 例 + 引用 2 例）、与 `readingPresentation`＋`taskDetail`＋`knowledgeCaptureLayout`＋`assistantModeSwitch` 合计 **105/105**；`assistMemoryView` 移除守卫 4/4、`executionSummary` 8/8、`sessionMemory` 13/13、`saveMemory` 11/11、`folderFirstConversation` 26/26；`conversationDiffLayout` 9/10（既有「文件夹细条名宽」）；`assist-flow` 单跑 4/11 红与既有基线一致；工作台 `tsc --noEmit` 只剩并行未跟踪的 `tests/tmpFlashProbe.spec.ts`。
- 规则归[工作台 §40.1](../frontend/workbench-design.md#401-聊天里的记忆-ui-全部移除2026-10-20-用户指认已实施实机未验)、[§43.2](../frontend/workbench-design.md#432-执行摘要的边框盒必须容纳自己的内容2026-10-20-用户截图已实施实机未验)与[§38.4](../frontend/workbench-design.md#384-段落与列表的边界列表必须能打断段落2026-10-20-用户截图已实施实机未验)。
- **未闭合**：真实 Windows/WebView2 窗口未目视（截图来自用户实机，本轮只有 Chromium 探针与 jsdom）；被压缩时卡片改为内部滚动而非完整展开，是否需要抬高高度下限由实机观感决定；移除后 `/compact` 没有读回面板，完成状态只能看服务端整理记录；同一条 AI 回复里「已在受管根目录创建 aa.md」与实际「只提交了执行候选」互相矛盾，属模型措辞（提示词纪律），本轮未改。

## 日常工具主链第三轮：推进 Owner 收归服务端 + 能力事实说明（2026-10-20 第二轮，未 commit/push）

用户反馈「关掉页面后台还推不推进」「任务/审批/验收仍繁琐」。逐项核实上一轮后，本轮只做两件能独立闭合的事，**没有**改授权模型、没有新增执行框架：

- **推进 Owner 从前端收到 Worker**：新增 `application/conversation-execution-autostart.ts`（`runConversationExecutionAutoStartTick()` + 仓储 `listAutoStartCandidates()` / `markAutoStartFailed()`），worker 每个 tick 调用一次。扫「PREPARE + 候选 READY + 无 Run + 阶段 READY/TASK_PREPARED」，沿请求行已固定的 `task/ready/delegate` 命令身份调既有 `applyConversationExecution()`。重复/迟到扫描只重放原回执。**这是「关掉页面后还能不能继续」的直接回答**，且不产生第二个推进状态。
- **失败带原因并退出扫描**：`DomainError.detail` 写回 `clarification.questions`，阶段记 `FAILED`；候选与阶段命令身份保留，建 Task 的 CAS 接受从 `FAILED` 前进（原来只接受 READY，导致「一次缺连接让候选永远无法接续」）。
- **`auto_start` 阶段感知**：`FAILED`/`DELEGATED` 不再为真，前端与服务端共用同一判定。
- **前端撤掉第二个 Owner**：删 `lib/planExecutionPreference.ts`（本设备「计划执行方式」）与 AssistView 的自动 applications effect；`ExecutionSummary` 只呈现阶段，唯一按钮是失败后的「继续原请求」，`task_id`/`run_id` 不再出现在日常界面。
- **能力缺口说真因**：新增 `application/assist-capability-notice.ts`，普通 Agent 的 `DISCUSS` 轮次在 system 末尾追加服务端事实块（有无项目/目录、写档位、本轮真实工具、缺哪几族能力），词表为空的那一轮也注入。它是事实说明、不授予任何能力。

证据：新增真实临时 PG 18.6 `conversation-execution-autostart` **4/4**；回归 `agent-main-loop-execution` 30 + `agent-conversation-main-loop` 11 + `assistant-readonly-round` 6 **47/47**；单测 `assist-capability-notice` **5/5**、`conversation-execution`＋`assistant-readonly-round` **30/30**；工作台 `executionSummary` **8/8**、`folderFirstConversation` **26/26**、`settingsView` **14/14**；两端类型检查（API `tsc -p` exit 0；工作台仅剩并行未跟踪的 `tests/tmpFlashProbe.spec.ts`）。API 全量单测 904 例 871 过 / 32 红，全部落在并行会话的 `backup-package.test.ts`（restore-runtime-probe 整套）与 HEAD 基线同样失败的 `file-changeset.test.ts` 悬空符号链接一例，无一条落在本片。

规则归[运行架构 §2.10.1](../architecture/runtime-context.md#2101-推进-owner-收归服务端与能力事实说明2026-10-20-第二轮)、[工作台 §43.1](../frontend/workbench-design.md#431-就绪候选由服务端推进界面只呈现阶段2026-10-20-第二轮已实施实机未验)、[HTTP §10.107.1](../api/http-command-contract.md#101071-服务端自动推进与失败原因投影2026-10-20-第二轮源码实现)、[提示词 §4.1](../architecture/agent-prompt-design.md#41-会话能力事实块2026-10-20-第二轮已实施)，规格归[测试计划](../testing/verification-plan.md#会话执行的服务端推进与失败恢复2026-10-20-第二轮)，成绩只归统一验收表。

**未闭合（按影响排序）**：

1. **浏览器/电脑仍要求项目与受管目录**。`logical_operations` 的来源 CHECK、`conversation_execution_requests.resource_id` 与 `prepareGatewayAction()` 都以受管资源为身份；解除需要让浏览器/电脑动作拥有可空的资源身份并重述三处 CHECK。这是库层身份变更，不是加一个分支；在没有确定「会话自身的归属身份」之前，用默认目录或别人的资源顶替都是错的。
2. **只要产生 Run 仍是正式任务**。检查命令（`check`）与 ASK 写都建 Task 并要求验收，用户说的「检查成功后卡在人工验收」属这一层。要拆「内部执行载体 vs 正式交付」，最小改动是让会话发起的 Run 携带「非交付」标记，完成时不进入 Artifact/人工接受/Business Commit；这是业务语义决定，未擅自动。
3. Worker tick 的**进程级**接线未单独起进程验证（函数与调用点已编译、集成用例直接驱动）；真实 Provider 措辞、真实浏览器/电脑操作、Windows/WebView2、安装态与独立验收未做。
4. 桌面暂存产物未刷新（本轮只改源码），要用新逻辑需要重跑 `stage-api.ps1` 并重开窗口。

## 工具主链与日常协作分层修正（2026-10-20，未 commit/push）

用户反馈文件工具、浏览器/电脑调用以及任务/审批/验收步骤都有问题。本轮修改后端执行接线，保留现有前端自动启动 Owner：

- 普通文件修改与明确 MODIFY 的方法轮共用会话直写；只有 AUTO/FULL 且本轮实际有写工具才采用可写模板，INSPECT 仍只读。
- ASK 写、AUTO 删除进入可恢复的原 Run 审批入口；后者在创建 Operation 前转交。已成功的文件修改不再入队，只把剩余检查或操作交给 Run。
- 执行候选新增可选 interaction=BROWSER|COMPUTER，传到已有 Run 工具循环；不要求操作连接配置文件根，不隐式授予范围权限。缺所需连接在登记 Task 前报告。
- 设计与边界归[运行架构 §2.10](../architecture/runtime-context.md#210-日常工具工作与正式交付分层2026-10-20-实施)、[ADR-031](../decisions/ADR-031-session-direct-write.md)、[工作台 §43](../frontend/workbench-design.md#43-日常工具执行不强制正式交付2026-10-20-后端已接续实机未验)；接口归 HTTP §10.107。成绩只看统一验收表。

未闭合：真实 Provider、浏览器/电脑操作及审批往返、Windows/WebView2、独立验收、安装态；尚无脱离项目/目录的操作会话，也未实现会话自身的异步审批恢复。浏览器/电脑逐动作确认数量未在本轮减少。下文“会话内直接写文件”节记录初版快照，其中 ASK 暴露写工具、方法恒只读、execution 恒空的设计已由本节接续替代。

## 日常减负第二轮：资料、规则、任务起步与记忆呈现（2026-10-20，按 `prompts/product-complexity-reduction.md` 第二节，未 commit）

用户要求「继续完成」第二轮 R2-01～R2-07。本轮只改入口层级与默认值承担者，没有动授权、版本绑定、事务与协议：

- **R2-01 普通资料**：新建/追加笔记只剩标题、正文与一个保存动作；来源与媒体类型收进「来源与收录设置」折叠；收录仪式（人工收录草稿／本次收录内容／对照来源／保存前核对／确认勾选）只在 `ARTIFACT_VERSION` 时展开。
- **R2-02 产物版本**：产物来源先列本项目可收录的版本（标题·版本·任务·时间），点一条即读该确切版本正文；「按版本 ID 指定」降为折叠入口；工作空间级资料直接说明去所属项目收录；`?artifact_version=` 只预填并读取，不代勾确认。
- **R2-03 规则**：表单只留陈述与强度，作用域/规则键/检查路径/方法/JSON 收进「范围与执行检查（高级）」；`POST /rules` 的 `rule_key` 改为可选，缺省取 `rule-<command_id>`（确定性派生，否则同 command_id 重放的载荷哈希会对不上），显式键原样提交；规则行改用陈述首行作名字。
- **R2-04/R2-05 任务**：「新建任务」默认一句话登记，「填写完整定义」为次要入口（空态主按钮同语义）；项目选择器打开即加载首屏并给「重试读取项目列表」，去掉「读取进行中项目」步骤，仍只取首屏不预取全库。
- **R2-06 定时任务**：每次任务标题默认跟随名称（改过才独立）；时区/次数/到期收进折叠，摘要行始终显示三项当前值，校验失败时摘要行指出展开可看原因。
- **R2-07 会话记忆**：双修订与「已清除至第 N 条」收进「诊断信息」，普通视图只说记住什么、摘要覆盖到第几条。

证据：新增 `knowledgeSimplify` **4/4**（笔记提交体、候选点选即读、省略 rule_key、显式 rule_key）；回归 `knowledge`＋`knowledgeCaptureLayout`＋`knowledgeReading`＋`projectKnowledgeGuide` **40/40**、`tasks`＋`liveTasks`＋`taskLightweightEntry`＋`createTaskProjectPicker` **26/26**、`scheduledTasks` **6/6**、`sessionMemory` **13/13**（本轮合计 **90/90**）；两端 `tsc --noEmit` 本轮路径零报错（工作台仅剩并行未跟踪的 `tests/tmpFlashProbe.spec.ts`）。规格归[工作台 §42](../frontend/workbench-design.md#42-日常减负第二轮资料规则任务起步与记忆呈现2026-10-20-已实施实机未验)，协议归 [HTTP §10.106](../api/http-command-contract.md#10106-规则键可由服务端生成2026-10-20-源码实现)，成绩归[验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)本轮行。

**未闭合**：本机无运行中的 PG，`information.integration.test.ts` 新增的规则键用例只过类型检查；R2-02 只有路由层支持「从产物详情带入」，阅读面板上仍无「收录为资料」按钮；真实 Windows/WebView2、多 DPI 与窄窗折叠观感未目视；产物候选列表未在真实项目上验证分页与只读失败；未做独立验收；未 commit/push。

## 会话内直接写文件（2026-10-20，ADR-031，未 commit）

用户先问「agent 操控本地文件都是通过工具吗」，接着问「上游也是这么做的吗」，最后选「会话内直接写」——此前会话轮次是「可读不可写」，写只能走「候选 → 委托 Run」两段式。

- **方向与边界**归 [ADR-031](../decisions/ADR-031-session-direct-write.md)：新增第六种来源 `AGENT_SESSION_WRITE`，**不复用** `AGENT_SESSION_READ`（放宽读身份会让「读身份只读」在库层失效）。只放行 `FILE_WRITE` 能力下的 `APPLY_CHANGESET` / `READ_CHANGE_SET`；`WRITE_FILE` 全文覆盖不开放——会话没有 `resource_claims`，并发写同一文件唯一可靠的闸门是 SHA-256 基线。
- **后端**：迁移 `0126`（三条 CHECK 按 0087/0105 最新正文逐条重述后追加新支）；`gateway-actions.ts` 新增来源类型、`originAllows` 分支、`originMatches`、`managedRootOrigin`、`hasCurrentGatewayEffectLease` 与 `read_change_set` 归属校验；`assistant-readonly-round.ts` 新增 `ASSISTANT_WRITE_TOOLS`、`assistantToolNames(available, allowWrite)`、写来源切换与 `SESSION_WRITE_NEEDS_APPROVAL`；`assist-read-tools.ts` 新增 `sessionWriteAllowed()` 并按档位裁剪；提示词 `AGENT_MAIN_LOOP` `1.0.2 → 1.0.3` 加写分支与纪律。变更集前置校验复用 Run 侧 `normalizeToolChanges`。
- **集成里抓到三个真实缺陷**（都不是设计问题，是漏改）：① `runSessionReadonlyRounds` 声明工具规格处仍用默认只读过滤，写工具算出来却没告诉模型；② `prepareGatewayAction` 的 `managedRootOrigin` 漏了新来源，写动作掉进公共 URL 分支报 `GATEWAY_TARGET_DENIED: P09 Fake 公共读取…`；③ Windows 原生路径身份表复合外键强制 `run_id`，会话写插不进去落 `UNKNOWN`。
- **证据**：`agent-main-loop-execution` 新增 4 例 → **21/21 PASSED**；`assistant-readonly-round` **6/6**＋`folder-first-conversation` 同批 PASSED；单测 5 文件 **59/59**；迁移 `0126` 临时集群实际应用；两端 `tsc` 对本片干净（API 仅剩并行会话在途的 `information.integration.test.ts` 3 条既有错误）。成绩归[验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)新增行，规则归[工具适配器](../architecture/tool-adapters.md)、[物理设计 §108](../database/physical-design-postgresql.md#108-0126-会话内直接写文件来源2026-10-20adr-031)。
- **未闭合（重要）**：**Windows 上会话写没有原生路径身份冻结**——`file_write_path_identity` 强制绑 Run，会话写走 `executeFileChangeset` 纯 Node 路径，存在 [ADR-012](../decisions/ADR-012-windows-file-io-handle-boundary.md) 的路径替换竞争窗口；ASK 档在会话里只做同步拒绝（不排队等批准）；真实 Provider 质量、真实 Windows/WebView2 窗口、多 DPI 未验；**前端零改动**，写工具在工具记录里按通用名展示，没有「已修改 N 个文件」的专门呈现。未做独立验收；未 commit/push。

## 工具行右端一组：上下文与模型下拉移到发送键左边（2026-10-20，未 commit）

用户指令「上下文和模型下拉按钮整体移动到发送按钮的左边，用tasteskill优化一下这一行所有按钮」。上一轮（§32.13）刚把这两枚放到工具行最左，本轮整体搬到发送键左边——同一个用户的连续调令：模型与上下文是发消息前最常核对的两项，贴在发送键旁比行首更近。

- **新顺序（两个输入器一致）**：`＋ [权限] [模式 ▾] [润色] [普通讨论 ▾] [资料 N] 〔上下文计量环 · 模型下拉〕 → 发送`；§32.13「计量环最左」按本条作废，其余邻接不变（「+」紧邻写档位、「资料」在「普通讨论」右侧）。
- **收成一组**：新容器 `.agent-chat-composer-tail`（`inline-flex`、组内 4px 节距、`flex:0 1 auto; min-width:0`）紧跟工具行、贴发送键左侧——窄栏换行时与发送键同处一行不拆开，长模型名由触发器省略号收尾不顶出卡片。
- **模型下拉锚点改右缘**（`left:auto; right:0`）：行右端后 22rem 清单会越出卡片右缘与视口；`modelSelectorDropdown` 的视口包含断言锁这条。
- **一行按钮逐项复核**：同高 32px、垂直中线对齐、四档状态（hover／展开／禁用／焦点）与 token 全区一致、命中区高于 `control.target.minimum`；零新增 token、零新增色值。
- **证据**：`composerSourcePanel.spec.ts` 3c 改写（工具行左端是「+」、底栏三子件 `工具行→tail→发送键`、tail 内 `计量环→模型`）三个视口 **5/5**；`assistantModeSwitch` **48/48**、同批 `composerDraftAssist`＋`modelSelector` **23/23**（三文件 71/71）；`modelSelectorDropdown` **6/6**；一次性探针在真实 Chromium 量过两处行序（会话 `＋ 写入档位待核对 ▾ 普通 Agent ▾ 润色 普通讨论 ▾ 资料 0 ▾ ○ 模型 ▾ ↑`、首条同构），脚本用后已删；`tsc --noEmit` 本轮路径零报错（仅剩并行会话未跟踪的 `tests/tmpFlashProbe.spec.ts` 旧错）。
- 规则归[工作台 §32.14](../frontend/workbench-design.md#3214-工具行右端一组上下文与模型下拉移到发送键左边2026-10-20)，成绩归[验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)新增行。**未做**真实 Windows/WebView2 与多 DPI 目视、未做独立验收；未 commit/push。

## 长期记忆自动捕获（2026-10-20，已实现，集成未验）

用户先指认「长期记忆应该是自动保存有价值的内容而不是手动」，在三个落点中选了「自动提取候选 + 一次确认」，随后又否决了确认环节（「要人手动确认感觉很麻烦」）。最终方向：**零点击、写入即生效、可撤销、明确标注**。

- 方向与代价归 [ADR-030](../decisions/ADR-030-zero-click-auto-memory.md)（取代 [ADR-029](../decisions/ADR-029-auto-memory-candidates.md) 的确认环节）。协议归 [HTTP §10.105](../api/http-command-contract.md#10105-长期记忆自动捕获2026-10-20迁移-0125)，物理列归[数据库 §107](../database/physical-design-postgresql.md#107-0125-长期记忆自动捕获2026-10-20adr-030)，产品行为归[工作台 §40](../frontend/workbench-design.md#40-长短期记忆2026-10-20产品行为已确认前端已接实机未验)。
- **后端**：迁移 `0125`（`memory_items.origin`、`workspace_memory_settings.auto_capture`、`memory_auto_captures` + 唯一键 + GRANT）；`application/memory-captures.ts`（归一化、指纹、advisory 锁、写入、撤销命令）、`memory-auto-capture.ts`（提取 prompt、JSON 解析、输入上限、失败静默）、`assist-runner` 结算后接线、`memory-recall` 排序与 `origin` 冻结、`assist-source-content` 透传；端点 `GET /memory-auto-captures`、`POST /memory-auto-captures/{id}/retire`；`POST /memory-settings` 的 `auto_capture` 为**可选**字段（缺省 true，旧客户端不受影响）。
- **前端**：设置页第三个开关「自动记住有价值的约定」；资料页记忆列表与详情标「自动记住」并说明确认方是 auto-capture；消息来源与足迹对 `AUTO_CAPTURE` 标「自动记住」。**没有新增面板、收件箱或角标**；撤销复用既有「停用记忆」。
- **证据**：API `tsc --noEmit` exit 0、`tsc -p` 构建 0；单测 `memory-auto-capture` **8/8**（归一化、指纹、UTF-8 摘要、三种 JSON 形态、空数组、非法/缺字段/超条数、8000 截断）；工作台 `memoryClient`＋`memorySettings`＋`sessionMemory`＋`saveMemory`＋`assistMemoryView`＋`memoryOrigin` **74/74**。
- **未闭合（重要）**：**没有跑真实 PG 集成**（迁移未应用、写入/撤销/限频/去重/召回排序均只有类型与单测证据）；真实 Provider 的提取质量、误报率与成本未验；`memory-auto-captures` 的读取端点没有前端入口（撤销走资料页既有停用，符合「不新增面板」）；未做独立验收；未 commit/push。

## 长短期记忆：前端接线（2026-10-20，未 commit）

按[完整长短期记忆前端](../../prompts/memory-module-frontend.md)接新增能力，保留既有长期三态／恢复前端，不改后端、不改用户库、不碰并行改动：

- **client**：新增 `apps/workbench/src/api/dtos/memory.ts`、`parse/memory.ts`、`resources/memory.ts`，由 `relayClient` 暴露九条端点；严格解析布尔／UUID／十进制修订／枚举，畸形响应显式失败。`/compact` 落在 `resources/chatControls.ts`，与 `/clear`、`/new` 共用 chat-commands 通道但不共用语义，且接受底层 `RequestMemoryCompaction` 的原始结果（重放回执可能没有前端包装 `kind`）。
- **设置**：`MemorySettingsCard` 挂在「AI 设置」页；两个开关独立、整行 CAS 提交、409 重读基线但保留草稿、传输失败保留原 command_id 只给查回执／原样重试。
- **保存**：已完成消息行新增「保存为长期记忆」；弹层重读原消息、标题正文可编辑、范围仅全局或原会话项目、提交原消息 UTF-8 SHA256（`lib/sha256.ts` 纯实现，避开 `crypto.subtle` 的安全上下文限制），成功后重读 Memory 与 provenance。
- **短期**：`SessionMemoryPanel` 位于队列之后、输入卡之前，仅有效普通 Agent 会话；四态可辨、202 后按 request_id 轮询并在终态与两分钟上限停止、取消 RUNNING 只说「已请求停止」、清除二次确认、一次性开关回调上层重读会话修订；消息足迹与资料页保存来源展开才读，`recorded=false`／`available=false`／合法空分开表达。
- **证据**：新增 `memoryClient` 25/25、`memorySettings` 6/6、`sessionMemory` 13/13、`saveMemory` 11/11、`assistMemoryView` 6/6；回归 knowledge 族 57/57、`settingsView` 16/16、`composerAttachMenu` 26/26、`assistantModeSwitch` 等五文件 111/111、`assistQueueSteer` 3/3；工作台 `tsc --noEmit` 仅剩并行会话的未跟踪临时探针（`tests/tmpFlashProbe.spec.ts`、`tests/browser/tmpComposerRowMeasure.spec.ts`），`vite build` exit 0。成绩归[验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「长短期记忆前端接线」行，行为归[工作台 §40](../frontend/workbench-design.md#40-长短期记忆2026-10-20产品行为已确认前端已接实机未验)。
- **未闭合**：本机无运行中的真实 API／PG，真实 API 浏览器链（保存→来源→设置关闭→整理→刷新读回→取消／失效→清除／一次性）未跑；真实 Chromium、Windows/WebView2、安装态、真实 Provider 摘要质量与缓存收益未验；未做独立验收。共享红项：`assist-flow` 4 例 `.breadcrumbs`、`assist-preview` 1 例 `assist-session-select` 为 HEAD 既有失败；`assist-target` 1 例因 `loadTarget` 在任务作用域不再带 `include_context`、而该用例桩只答 `include_context=true` 的形状，属并行未提交改动，未代改。

## 会话行的批量选择复选框（2026-10-20，未 commit）

用户指令「给会话 item 加一个复选框吧，方便删除记录」。按「选择 → 确认 → 逐条删除」实现，没有新增端点、没有改授权模型：

- **复选框与类型图标同一格。** 会话行（含归档段）在**本行悬停／键盘聚焦／已勾选**时，`.recent-work-kind` 那一格换成 14px 复选框（`font.size.meta`），图标以 `visibility: hidden` 让位；**不做整列常显**（同日用户指令「复选框不要常显」）。它是行按钮的兄弟节点（`<button>` 不能套可交互控件），绝对定位压在图标上，所以行高 32px、行距 34px 与标题可用宽一像素没动——`recentWorkRailDensity.spec.ts` **10/10** 仍绿，探针实测复选框 `112–126`、原图标 `112–124`、标题左缘 138，勾选后指针移开时只有 `[data-selected]` 的两处副本显形。
- **确认两键等宽对称**（同日用户指令「确认删除的弹窗要左右对齐，对称」）：取消态与确认态都复用 ⋯ 面板删除确认的 `.recent-work-confirm-actions`（`flex: 1 1 0`、`control.height.compact`、键间 `space.2`），左右边界与上面两行文字同一条；实测内容宽 169px 上「删除」`94–174`、「取消」`182–263`，各 80px。
- **选择只是选择。** 勾选不发命令、不推进修订；任务行没有删除命令，不参与选择；同一会话在「目标」与「工作区（目录）」两段里的两处副本共用一个会话 ID。
- **批量不是新端点。** 逐条发既有 `DeleteAssistSession`（ADR-027）：每段各取 `command_id`、各带该行读回来的 `expected_revision`，串行等回执后按段报告。被引用阻止（`SESSION_DELETE_BLOCKED`）的那段留在列表与选择集里并指向归档；`REVISION_CONFLICT` 只重读该条不重发；`RelayTransportError` 保留勾选、**锁死确认键**并说明「本次是否已删除尚未确定」，只能由「取消选择」退出——与 ⋯ 面板里那条单条删除同一读法。全部成功不留提示（行消失即回执；删除不可撤销，因此没有撤销条）。
- 证据：`sessionRowMenu.spec.ts` **23/23**（新增四例：勾选零命令与取消选择、两段各一条命令且 `command_id` 不重复、部分被引用阻止、回执不明锁键）、`recentWorkDrag` 8/8、`recentWorkPagination` 10/10、`tsc --noEmit` 对本片干净（仅剩并行会话未跟踪的 `tests/sessionMemory.spec.tsx`／`tmpFlashProbe.spec.ts` 两条既有错误）。规则归[工作台 §28.1](../frontend/workbench-design.md#281-左栏recentworkrail)，视觉与实测几何归[设计系统 §9.11](../frontend/design-system.md#911-近期工作栏窄列搜索框与行密度2026-10-16)，成绩归[验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「会话行批量选择复选框与批量删除」行。
- **未闭合**：真实 API／真实 PG 的批量删除链路未跑（复用单条删除的既有后端证据）；真实 WebView2 窗口、多 DPI、触屏与 IME 未验；未做独立验收；未 commit/push。

## 会话 diff 把大文件报成「删除」（2026-10-20，未 commit）

用户截图指「git diff 有问题，会话没有修改过文件，但是还是有 git diff」：入口行写「本次对话 · 52 个文件 +1057 −371」，展开里有「164 个文件行数不可统计」。

- **先复算再改**：把 trial 库该会话的真实基线（`0cbba366…`，2000 条、`FILE_COUNT_LIMIT`）取出来，用编译后的 `captureCurrentState` + `computeSnapshotDiff` 对当前磁盘复算，得到 `byAction={"MODIFY":70,"DELETE":147}`、`unavailable=164`——与截图对得上。
- **根因**：`classifyAction` 用「摘要是否为空」代替「文件是否存在」。超过单文件读取上限（1 MB）或采集时读失败的文件两侧都没有摘要（基线 `sha256: ''`、当前 `null`），当前侧因此被判成「不存在」→ `DELETE`，本仓库 147 个字体（`noto-*-variable.woff2`）与 `docs/**` 截图全部中招。
- **修法**：`classifyAction` 改吃 `{present, sha256}`，两侧都在而摘要读不到时返回 `UNVERIFIED`；字节数相同→不进文件列表，只计入新的 `coverage.unverifiable_files`；字节数不同→按不可统计的 `MODIFY` 列出（行数仍不编造）。`incomplete` 计入该条数，HTTP 投影与前端入口行／展开面板各补一条「N 个文件内容未核对」；总数不可统计时面板空态不再写「本次对话暂无文件变化」。
- **复算结果**：同一基线改后 `DELETE` 归零、`unavailable=17`（都是确实改了但正文超 64 KB 的 `MODIFY`）、`unverifiableFiles=147`。**真实 HTTP 复验**：起了一个独立探测实例（临时端口 43999、独立数据根、连 trial 库）打 `GET …/conversation-diff`，**200** 且响应里 `{"MODIFY":93}`、17 条不可统计、`unverifiable_files=147`、无 `DELETE`；实例已关、临时数据根已删。
- **剩下的数字不是本会话写入**：该会话建于 23:09:22.658、基线 23:09:22.877，只有 2 条消息／2 次工具调用；同一目录被其他 Agent 会话同期改写（复算期间 `53→72` 还在涨），属口径 B「目录净变化，含同期外部修改」。**是否加「本会话自身写入 N 个文件」的归因，等用户决定**，不擅自改已选口径。
- 规则归[工作台 §34.3/§34.4](../frontend/workbench-design.md#343-会话基线范围与恢复)，成绩归[验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「会话 diff：大文件被误报为删除」行。

## 日常操作减负（2026-10-20，按 `prompts/product-complexity-reduction.md`，未 commit）

用户下达该任务书并要求「继续完成」。本轮做了能独立闭合的四块，**没有**改授权模型、没有新增第二套准入事实：

- **P0-1 连接页分层**：`ConnectionsView` 顶部新增「可以用的工具」（本机文件 / Git 只读 / 网页抓取 / 命令行 / 电脑 / 浏览器 / GitHub），状态只读已有快照并把「已连接」与「已授权」分开；三段逐动作表单收进默认收起的「高级：逐动作配置」，列表、健康核对、撤销与回执核对原样保留。`FAKE_*` 只在 `?dev-capabilities=1` 出现。日常路径没有新机制：打开目录→应用建读取配置（既有 `ensureLocalDirectoryReadAccess`，`folder-first-conversation` 已证明零预置可读）→会话里直接读。
- **P0-2 插件详情**：新增 `GET /plugins/status`（安装级：电脑运行时、浏览器后端投影、`gh --version` + `gh auth status`）＋ 会话「+」→ 连接器里点插件原地展开详情，**运行环境**与**本项目授权**分两行；无项目归属也能看运行时，授权一行如实说「需要项目归属」。不再 `location.assign` 到通用配置页。项目级准入完全沿用原 Gateway。
- **P1-3 Git 只读**：迁移 `0124` 给 `local_directory_access` 加 `git_connection_id`；打开**仓库根**时自动建 `GIT_READ` 连接与 status/diff/log 三条 AUTO 策略（重新打开复用），子目录只报 `REPO_ROOT_REQUIRED`＋仓库根、不建连接，停用/撤销/历史规则 → `DISABLED`/`REVIEW_REQUIRED` 不自动恢复。工具侧 `GIT_READ` 改为精确根匹配（`connectionRootCovers`），文件能力仍按前缀。前端在细条与更换目录浮层显示 Git 状态，子目录可在原地「在仓库根打开」。
- **P1-4 恢复交互**：写入档位与默认视图在结果未知时先由程序核对一次回执，文案改为「正在核对是否保存成功 / 重新核对 / 重试保存」，`command_id`、原修订与目标档位收进可展开「诊断信息」；原 ID 与原载荷冻结不变。
- **P2 占位清理**：移除「+」→ 资料里的「选择本地文件」；设置执行策略里两行「暂不可用」合成一句说明。待实现需求仍在文档里，没有删需求。

证据：真实临时 PG `local-directory-access` **7/7**（LA-11–LA-15 新用例，迁移 0124 实际应用）、`folder-first-conversation` **20/20**（零预置读与真实写回未回归）、`plugins-status` **1/1**（真实 API 进程）；单测 `conversation-execution` 17/17；工作台 `connectionsSettings` 24/24、`composerAttachMenu`+`settingsView` 42/42、`writePermissionTier` 14/14、`viewConfiguration` 6/6；两端 `tsc --noEmit`（工作台仅剩并行未跟踪的 `tests/tmpFlashProbe.spec.ts`）。

### 回归对照（2026-10-20 同日）

- `assist-flow` 的 4 例失败已在 **HEAD 基线工作树**（`git worktree add D:/Develop/relay-baseline HEAD`）复现：同样是 4 failed / 7 passed，失败点为 `assist-target` 未解析到项目/任务名与 `.breadcrumbs` 缺失。结论：**不是本轮引入**，也不由共享工作树的未提交改动引入（HEAD 没有那些改动）。
- `settingsView.spec.ts` 的「读取失败就地显示错误并可重读」一例当前红：并行会话新增的未跟踪文件 `components/MemorySettingsCard.tsx`（被 `SettingsView.tsx:776` 引用）在该用例的 fetch 桩里没有对应端点，卡片渲染出「记忆设置读取失败：…」，撞上该用例的整页断言 `.not.toContain("读取失败：")`。与本轮改动无关，未改他人文件。

### P1-5 前半已接线：图片能力原地声明（2026-10-20 同日续做）

`MODEL_NOT_IN_CATALOG` 这一档不再把用户推去改 `RELAY_MODEL_IMAGE_INPUT`。芯片行下方直接给「声明支持图片 / 声明不支持」，
写当前 `provider + 模型名`（`PUT /model-capabilities/{provider}/{model}`），写完重读 `/model-port`，判定变 `DECLARED` 后提示与入口一起消失。
**只有这一档给入口**：`MODEL_LACKS_IMAGE_INPUT`（目录明确否定）与 `NOT_CONFIGURED`（缺连接）都不给，避免承诺做不到的事。
设置页「模型端口」新增「生效范围」一行（本实例共用、声明跟随 provider+模型名）。证据：`composerImageAttachments` **10/10**（新增原地声明与「目录否定不给入口」两例）、`settingsView` 25/26（唯一失败来自并行会话新增的 `MemorySettingsCard` 未在该用例的 fetch 桩里，见下）。
规则归[工作台 §33.2](../frontend/workbench-design.md#332-暂存与发送)。

### P1-5 差异分析（端点/凭据与多连接，未接线）

核对了当前源码与 `prompts/model-connection-capabilities.md` 的交付状态，差异如下：

| 问题 | 当前真实链路 | 用户多走的步骤 | 最小修改 | 保留约束 |
|---|---|---|---|---|
| 端点/模型/凭据分散 | 连接配置只来自进程环境变量（`RELAY_MODEL_PROVIDER` / `BASE_URL` / `MODEL` / `API_KEY`），`ModelPortCard` 只读展示，页面不能写密钥 | 改模型要改 `.relay-test\desktop.env` 并重开窗口 | 增加实例级「当前连接」配置端点，凭据走既有安全存储；env 保留为默认与兼容来源 | 密钥不出现在响应/日志/Context；不新造第二套 Provider 注册表 |
| 能力要单独声明 | 判定四层：目录 → 声明表（0121，按 `(provider, source_model_id)`）→ `RELAY_MODEL_IMAGE_INPUT` → 拒绝；唯一入口 `decideChatImageInput` | 先同步目录、再去设置页补声明、还要知道 env 优先级 | 声明入口跟随当前 `(provider, model)` 自动定位，缺项原地补；页面标出「结论来源：目录/声明/env/无」 | 判定优先级不反转；能力未知不假装支持 |
| 生效范围不可见 | `/model-port` 是单连接投影；会话级模型选择只完成一部分（阶段 C-2b 剩余） | 不知道改动影响本实例还是本会话 | 在接入面板标「生效范围：本实例 / 本会话」 | 多连接与会话选择继续走 C-2b，本项不接线 |

不接线的原因：这一项要动「页面能否写密钥、密钥存哪里、多连接是否共享能力声明」三个产品决策，并依赖尚未完成的多连接选择；按任务书「先完成差异分析再接线」处理，未擅自改授权面或复制一份 Provider 注册表。

**桌面暂存（2026-10-20 12:47–13:02 已刷新到当前整棵树）**：并行会话最后一次写 `apps/api` 是 08:49（此后 4 小时无写入），桌面未运行，因此按当前树重新暂存：
`pnpm --filter @relay-agent/api build`（tsc 0）→ 用上一次 deploy 留下的生产 `node_modules`（`package.json` 自 10-18 未变，依赖集相同、无符号链接）填 `resources/api/node_modules`，
再用 `/MIR` 覆盖 `dist/src`、`migrations`、`skills`，最后同步到 dev 实际读取的 `target/debug/api`。两处现在都是 **125 条迁移、400 个 `dist/src` 文件**，
含 `plugins-api.js` / `plugins/runtime-status.js` / `0124` / `0125`；用生产依赖做过 `import()` 冒烟（`plugins-api`、`open-working-directory`、`infrastructure/database` 全部可加载）。

- **`pnpm deploy` 今天会卡**：第一次 15 分钟停在 `resolved 86 / added 0`（网络解析无进展，非锁竞争），已终止并改用上面的本地拼装；产物与部署结果逐项核对一致（依赖数 11、包完整性、文件数）。下次若 deploy 再卡，直接走这条路径。
- **单测体检（API 894 例）**：870 过 / 23 红，归因为三组，**没有一组落在本片代码上**：
  1. **15 例 = 并行会话今天新增的 `restore-runtime-probe` 整套**：首例断言 `direct_dependencies.length === 10`，实际为 11（`package.json` 自 10-18 未变，`ws` 早已在列）→ 该套连带全红，属测试常量过期；
  2. **2 例 = `api` / `desktop-api` 的「refuses isolation before connecting」8 秒超时**（`timedOut: true`，无输出）：本机安全软件拖慢 ESM 冷启动，项目记忆已有同类记录；同组 `worker`/`supervisor` 用例通过；
  3. **3 例 = HEAD 基线同样失败**（dangling symlink 判定、root escape 冻结基线、`FREE_CALL_GUARD_UNAPPLIED`），已在基线工作树复跑确认。
- **注意**：这次暂存的是「能编译、能加载、但单测未全绿」的树。未绿部分属并行会话的记忆自动捕获切片，不影响启动，但该功能可能尚未定型。

**下次启动会做什么**：暂存已最新，`Get-ApiStaleness` 不再触发重建；启动器会先 `pg_dump` 备份，再把开发库从 `0120` 迁到 `0125`（0121 CREATE TABLE+GRANT、0122/0123/0124/0125 ADD COLUMN/CREATE TABLE，均无数据重写），然后起窗口。

**未闭合**：P1-5 只接了「图片能力原地声明 + 生效范围」这一半；端点/模型/凭据的统一写入与多连接切换未接线——它依赖尚未完成的多连接选择，按任务书要求先出差异分析再动（见上表）；`GET /plugins/status` 已有真实 API 进程证据（`plugins-status` 1/1），但真实 `gh` 登录态、真实浏览器后端与真实电脑运行时的具体组合未取证；真实 Windows/WebView2 与多 DPI 未目视；未做独立验收；未 commit/push。规则归[工作台 §41](../frontend/workbench-design.md#41-日常操作减负工具状态与高级配置分层2026-10-20-已实施实机未验)，接口归 HTTP §10.103/§10.104。

## 会话 diff 归因链：真实 Run 写盘端到端（2026-10-20 中午，未 commit）

用户「需要」——补上一轮标记为未取证的那一段：归因读的 `change_sets` 由生产代码在真实 Run 里写出，而不是测试自己塞的。

- 新增 `apps/api/test/integration/conversation-diff-attribution.integration.test.ts`：真实 HTTP 打开目录并切 AUTO 档 → 建会话、绑定 → **先建统计起点** → 真实主流程产出执行候选 → `applications` 委托出 Run → `runOneCommand` 用脚本化工具轮执行 `read_file` + `apply_changeset` → 磁盘真的变了。
- 断言两个方向：`change_sets` 恰好一行 `SUCCEEDED`、`change_set_files` 恰好 `src/a.ts MODIFY APPLIED`；会话口径只列 `src/a.ts`（+1 −0），同期人工改的 `src/other.ts` 只在目录口径里；`/file` 会话口径对别人的文件 `PATH_NOT_FOUND`。
- **三个夹具坑**（下次直接照做）：① 临时目录必须 `git init`，否则建立起点返回 `NOT_GIT_ROOT`；② 临时集群必须跑 `dist/src/cli/install-graph.js`（`RELAY_MIGRATION_DB_URL`），否则 `runOneCommand` 报 `relation relay_graph_v1.checkpoints does not exist`；③ 断言消息别直接 `JSON.stringify`，`baseline.revision` 是 bigint。
- 结果：本套件 **1/1 PASSED**，`conversation-diff` 主套件仍 **5/5**。只覆盖 MODIFY；脚本化工具轮不是真实 Provider；未 commit。

## 会话 diff：只认实际落盘 ＋ 工作详情「变更」页签（2026-10-20 上午第二轮，未 commit）

用户回复「接，完全不出现」——两个决定：① 工作详情接一个「目录总变化」视图；② 声明过但没落盘的路径**完全不出现**。

- **归因收紧**：`listWrittenPaths` 只留实际落盘的冻结变更集（`conversation_execution_requests.run_id` → `change_sets`/`change_set_files`，按 `canonical_root` 过滤），删掉「`candidate.file_changes` 声明」与「`session_tool_calls` 写调用」两处。理由：声明只代表打算改；当时判断写工具直连 Gateway 也落 `change_sets`，不需要单列。**2026-10-22 DEV-0107 更正**：后一个判断不成立——会话直写 `apply_changeset` 不建 Run、不写 `change_sets`，只留 `session_tool_calls` → `logical_operations`（`AGENT_SESSION_WRITE`）；已把会话工具账本这一路并回，否则新建的未跟踪文件在会话口径里不可见。详见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表) DEV-0107 行。
- **目录口径**：`GET …/conversation-diff` 与 `/conversation-diff/file` 新增 `scope=SESSION|DIRECTORY`（省略＝SESSION）。服务层 `ReadDiffInput.scope` 决定是否查写账本；目录口径直接按整段目录算。
- **工作详情「变更」页签**：`WorkDetailsFrame` 的页签清单改成可传入（默认仍是三页），会话详情插第四页「变更」，内联渲染 `ConversationDiffSummary scope="DIRECTORY" inline`；任务详情不加（没有会话基线）。内联形态去掉浮层阴影/描边/内边距。
- **证据**：diff 单元 **50/50**；真实临时 PG 集成 `conversation-diff` **5/5**（净变化/正文/换目录改走目录口径，新增会话口径为空与会话口径拒绝未写路径正文）；jsdom **17/17**；Chromium `conversationDiffLayout` **8/10**（2 例既有失败）、`emptyConversationWelcome` 页签改四页后 **7/7**、`inspectorPreviewLayout`＋`conversationToolbarDensity` 通过；**真实 HTTP** 同会话 `SESSION` 为 0 文件、`DIRECTORY` 为 91 文件 `+3061 −639`，`/file` 会话口径 `PATH_NOT_FOUND`、目录口径 137/4 行。
- **未取证**：真实 Run 写盘后的归因（集成层没造 `change_sets` 链，需完整 Run 夹具）；真实 Windows 窗口与真实 Provider 工具流。

## 会话 diff 收窄为「只统计本会话写入」（2026-10-20 上午，未 commit）

用户接着上一轮说「工作详情那里统计总目录就好了，这里就只统计当前会话的 git diff」——即对话入口不该把同目录其他会话/人工的同期修改算成「本次对话」。

- **归因**：新增 `ConversationDiffRepository.listWrittenPaths(workspaceId, sessionId, rootPath)`，三处并集——① 会话执行请求所对 Run 的冻结变更集（`change_sets`/`change_set_files`）；② `conversation_execution_requests.candidate.file_changes`（声明过、Run 还没落账也算）；③ 会话自己 `apply_changeset` 的 `session_tool_calls`（SETTLED/UNKNOWN）。按根过滤，换过目录不串段。**归因只圈候选**：行数仍由「基线 → 当前内容」算，声明了没改的路径因摘要相同自然消失。
- **范围进纯函数**：`computeSnapshotDiff` 新增 `scope`，范围内的路径若两端都没扫到记 `unscannedFiles`（不冒充零变化）；会话口径下「整目录没扫全」不再算这条统计的缺口。
- **不做无用扫描**：本会话没写过任何路径时直接返回空 diff（但仍检查根是否仍是 Git 仓库，`ROOT_NOT_GIT` 语义不变）。
- **契约**：diff 响应加 `scope: SESSION|DIRECTORY` 与 `coverage.unscanned_files`；`/conversation-diff/file` 只对本会话写过的路径给正文。
- **前端**：展开面板改成「只统计本会话写入的文件；同一目录里其他程序或其他会话的同期修改不计入」；会话口径的缺口措辞改成「写入路径未核对 / 不在扫描范围」。
- **证据**：diff 单元 **49/49**（新增 5 例）；真实临时 PG 集成 `conversation-diff` **5/5**（新增 `seedSessionWrite` 造真实归因行）；jsdom `conversationDiffSummary` **15/15**；Chromium `conversationDiffLayout` **8/10**（2 例为并行改动既有失败，`窄视口` 那条已 A/B 把夹具换回 DIRECTORY 复跑仍红）；**真实 HTTP** 探测实例返回 `scope=SESSION`、`total_files=0`、`files=[]`、`incomplete=false`（同一会话修复前是 52 个文件 +1057 −371），未写路径的正文请求 `PATH_NOT_FOUND`。
- **未做**：目录口径（`scope=DIRECTORY`）目前没有 UI 入口——用户说「工作详情那里统计总目录」，但工作详情现在没有 diff 视图，本次没有新建；真实 Windows 窗口与真实 Provider 工具流未复验。

## 聊天阅读列与输入器同轴（2026-10-19 深夜，未 commit）

用户发来截图指「这两个 ai 好像没有对齐，下面那个更靠左」，随后明确诉求是「左边跟输入框的左边对齐就好了」。**先证伪再动手**：截图像素里两处 `AI` 墨迹都在 x=43–57、逐像素相同（红线画在 x≈33，比两处标签都左 10px），真实 Chromium 里两条消息头的 `left` 也相同——「两条 AI 没对齐」不成立，真正的偏差在**消息列与输入器之间**。

- **根因**：消息列在 `.agent-chat-transcript` 里居中，而这个滚动容器的 `scrollbar-gutter: stable` 把自绘滚动条（12px）算进 padding box 的 inline-end，content box 右侧因此少 12px，消息列整体左偏 **6px**；输入器不在滚动容器里，没有这 12px。
- **修法**（`components/ChatTimelineNav.css` 一条规则 + `styles.css` 一个变量）：起边补回一整个滚动条宽度，`padding-inline: calc(var(--chat-timeline-gutter) + var(--chat-scrollbar-width)) var(--chat-timeline-gutter)`；滚动条厚度收成 `--chat-scrollbar-width`，与 `::-webkit-scrollbar` 同一处维护（CSS 读不到真实宽度，只能靠这一个常量）。目录细条、队列卡、空态快捷卡都按同一根中线居中，随消息列一起归位。
- **证据**：新增 `tests/browser/chatReadingColumn.spec.ts` **2/2**（宽档中线与左右缘 ≤1px、窄档左缘 ≤1px）；A/B 各跑一次——把该行退回旧写法，宽档用例红（`Received: 6`），窄档仍绿，改回后 2/2。改前/改后 1440 宽实测消息列 `495.19 → 501.19`，与输入卡 `501.19` 重合；`chatTimelineNavigation`＋`narrowWindowNewConversation` **17/17** 未回归。
- **残余**：阅读列落在 768–832px 那一段时，消息列满宽、输入卡按 measure（744px）居中，卡比列宽 16px（左右各 8px 对称外伸），左缘仍差 8px——属「卡宽于列」的另一条规则，本轮未改。`uiOption2FirstSession.spec.ts` 的「同宽」用例只比 `max-width` 字符串，且该套件当前被并行会话的发送链改动拖红（夹具在 `assist-copy-a-0` 超时），故断言另立一处。
- 规则归[工作台 §18.6](../frontend/workbench-design.md#186-页面原型结构对齐2026-10-03)，成绩归[验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「聊天阅读列与输入器同轴」行。未做独立验收，真实 Windows/WebView2 与多 DPI 未目视。

## 输入框图片链路：悬停预览、可读拒绝原因、能力预检（2026-10-19 深夜，未 commit）

用户连续指认四件事：粘贴的图片悬停看不到内容 → 历史消息也要 → 发送图片报「attachment_ids 不符合契约」→「为什么无法确认」「目录只收录 OpenRouter？应该所有模型都可以接进来的」。

- **悬停预览**：新增 `apps/workbench/src/components/attachmentPreview.tsx`（`useAttachmentPreview` / `attachmentPreviewHandlers` / `AttachmentPreviewLayer`），输入框芯片与历史消息附件共用一份；浮层走 portal + `position: fixed`，因为输入卡发送中 `overflow: hidden`、对话列本身也是滚动容器。翻面按**实际显示高度**而不是上限判断。
- **拒绝原因可读**：服务端所有 422 的 `detail` 恒为「请求结构不符合端点契约。」，真实原因只在 `field_errors[].message`；`lib/liveErrors.ts` 的 `VALIDATION_FAILED` 原先只拼字段名，现改为「请求未通过服务端校验（字段）：服务端说明」。
- **能力预检**：`GET /model-port` 新增 `image_input` 六态投影（`SUPPORTED|DECLARED|MODEL_LACKS_IMAGE_INPUT|MODEL_NOT_IN_CATALOG|NOT_CONFIGURED|UNKNOWN`），与发送闸门共用 `apps/api/src/application/chat-image-input.ts`；图片刚粘进来就在芯片行给出警示条，**只说明不拦发送**。
- **本机配置**：选项 6 读 `<repo>\.relay-test\desktop.env`（不是 `%APPDATA%`），已加 `RELAY_MODEL_IMAGE_INPUT=true`。依据：该模型官方写明原生多模态，且实测 `POST /chat/completions` 带 `image_url` data URL 返回 `prompt_tokens_details.image_tokens=64`。**运行中的 API 不重读 env**，改完必须重开窗口。
- **下一步（用户 2026-10-19「按你推荐来」→ 2026-10-20 凌晨已实施主体）**：[模型连接能力档案任务书](../../prompts/model-connection-capabilities.md)。结论是目录只是价格快照、不是模型注册表；能力声明改为按 `(provider, source_model_id)` 存档（迁移 0121），判定四层为**目录 → 声明表 → 环境变量 → 拒绝**。已交付：迁移与仓储、`/model-port` 的 `image_input_source`、`GET/PUT/DELETE /model-capabilities`（实例级配置，无命令回执，理由见 HTTP §10.100）、设置页三态声明入口、输入框提示对齐。**未做**：多连接切换与会话级模型选择接线（阶段 C-2b 剩余部分）。
- **本轮自检**：API 单测 `chat-image-input` 5/5；真实 PG 集成 `model-capabilities.integration.test.ts` **3/3**、`model-port.integration.test.ts` **2/2**（均通过临时集群跑通）；工作台 `settingsView` 16/16、`modelConnectionStrip` + `composerImageAttachments` 合计 29/29。**未验**：真实 Windows 窗口的声明保存（含 DPI/输入法）、多 Workspace 并发改同一模型声明的竞态、桌面壳暂存 API 是否已含 0121 迁移。

自检成绩与未验边界见[工作台 §33.4](../frontend/workbench-design.md#334-前端接线与只有图片的放行2026-10-18)；未做独立验收，未 commit/push。

## 会话模式下拉的浮层与选中态（2026-10-19 深夜，未 commit）

用户截图指令「优化一下这个下拉框，还有这个下拉按钮的选中态」。第一轮只改 `apps/workbench/src/views/AssistView.css`（把 `.agent-chat-mode-select` 收进既有 `appearance: base-select` 浮层块，并把 hover／`:open`／`:focus` 三档移到包裹 label 上）与 `tests/browser/uiOption2FirstSession.spec.ts` 的键序与一条失效断言，未动组件结构、未新增 token 或色值；同日第二轮（见下条接续）才动 `AssistView.tsx` 的行内顺序与浮层内容包装。

- 唯一行为变化：方向键不再直接换档，改为开浮层→移高亮→`Enter` 提交，`Escape` 不提交；接受该变化并写进文档，不加 JS 键盘垫片。
- 文档归位：交互与几何归[工作台 §25.1](../frontend/workbench-design.md#251-控件层级)，`base-select` 的方向键契约校正归[设计系统 §9.13](../frontend/design-system.md#913-会话视图顶栏密度2026-10-16)（原先「键盘照旧」那句已就地校正）。成绩归验收表「会话模式下拉的浮层与选中态收进设计系统」行。
- **同日接续（同一条未 commit 链的第二轮）**：用户「模型下拉按钮放到输入框左边，再左边是上下文圆圈；普通讨论是干嘛的，点击之后 ui 还会消失，关闭菜单之后 ui 又出来了」。①计量环与模型下拉移到工具行左端（两个输入器一致），§32.10 的「模型 → 资料 → 用量」作废；②点开就消失的根因是绝对定位挂在 `.agent-chat-options[open]` 上，`<summary>` 随整个 `<details>` 离开 flex 行——改为三处内容各包一层 `.agent-chat-options-panel`、只浮出内容，入口芯片常驻行内。规则与实测几何归[工作台 §32.13](../frontend/workbench-design.md#3213-工具行左端两枚事实与浮层只浮出内容2026-10-19-深夜接续)，成绩归验收表同节新增行，出口为 `composerSourcePanel.spec.ts` 的 3b 不变式（已 A/B 证明挂回旧选择器会红）与两处顺序常驻锁（3c 会话输入器 `toolOrder`、`assistantModeSwitch.spec.ts` 首条输入器 48/48）。
- **未闭合**：用户第二轮返图指认「没修好」，图中行序与 HEAD 一致；经核对该窗口是 `apps/desktop/src-tauri/target/debug/relay-desktop.exe`，devUrl 即已服务新模块的 `127.0.0.1:5173`（`curl` 取回的 `AssistView.tsx` 已含三处 `agent-chat-options-panel`），判为 WebView2 模块图陈旧，需窗口内 Ctrl+R，**重载后的实机目视仍未复验**。`uiOption2FirstSession.spec.ts` 另有 16 条红灯，共用夹具在 `assist-copy-a-0` 超时（该 testid 在 HEAD 与工作树都不存在，`AssistView.tsx:2362` 渲染的是 `assist-copy-${message.id}`），归并行会话改动的发送链路，本轮只报不修；`:218/:266` 另停在发送环节——页面 alert 显示 `/assist-sessions/:id/working-directory` 被夹具 404，来自新增 `adoptCreatedSession` 读回链（HEAD 无此函数），该 spec 路由未同步。`collaborationWorkspace.spec.ts` 5 条：4 条是新解析器把 `file_changes` 变成必填（`apps/workbench/src/api/parse/assist.ts:553`）而 `toolCalls` 夹具未带该字段，1 条（Escape 取 `#assist-source-query`）在 HEAD 上同样红，属 2026-10-18 浮层拆分遗留（首个 `.agent-chat-options` 匹配到的是「普通讨论」）。真实 Windows/WebView2 与多 DPI 目视未做。

## 记忆大模块（2026-10-20，后端工程出口完成，未 commit）

用户已扩大授权：「继续记忆模块，长期，短期等等，大模块做完了再给提示词」，并确认普通聊天「自动召回已确认记忆，并可关闭」。本轮按[完整工程边界](memory-module.md)完成长期显式保存/召回、短期历史/持久压缩、隔离失效/重启和管理投影的约定后端工程出口。统一前端任务书为[完整长短期记忆前端](../../prompts/memory-module-frontend.md)，接新增能力并保留既有三态/恢复，不将任务书交付当作已实施前端。

已接入普通 AGENT 的实际 plain/tool-loop 生成：长期明确保存/来源、可关闭自动召回、持久配置；短期原文窗口、手动/自动整理、HTTP实际重启后的读取与新Worker接续、清除/一次性模式和 `/compact`；来源足迹贯穿普通历史、摘要、派生答复与 fork，权限/目录变化重检。迁移为0118/0119/0120/0123，未修改用户库；并行0121/0122/0124不属于本模块。协议归 [HTTP §10.99](../api/http-command-contract.md#1099-长短期记忆接口2026-10-19)，前端行为归[工作台 §40](../frontend/workbench-design.md#40-长短期记忆2026-10-20产品行为已确认前端已接实机未验)。自检、独立代码复核、问题修复和独立真实PG复验出口已闭合，具体成绩只归统一验收表。此前共享构建受阻和分叉PG23514均已通过当前源码重编译与真实复验关闭，不再是本模块阻塞。下一步按统一任务书接前端；真实Provider摘要质量/缓存收益、浏览器、Windows及安装交付另验，不能由后端工程出口推定。

## 长期记忆：有效状态与筛选后端（2026-10-19，未 commit）

用户要求「继续开发记忆模块」，并选择「长期记忆状态与筛选」。本轮仅接既有 Memory 后端，不开发自动记忆、会话提取或学习模式，不改并行前端。

- Memory 列表/详情增加只读 effective_status：ACTIVE/EXPIRED/RETIRED，停用优先于过期；原持久 status 保持 ACTIVE/RETIRED。当前版本到期时按数据库时间投影为 EXPIRED，不写根状态、不推进修订、不新增版本或定时任务。
- `GET /memories` 可按 effective_status 筛选，默认 ALL 保持兼容，可组合原 project_id 范围；列表与详情以同一根/当前版本 SQL 查询投影，历史 revisions 不变。恢复过期记忆仍过期，明确确认的新修订才能续期或取消到期。
- 协议归 [HTTP §10.98](../api/http-command-contract.md#1098-长期记忆有效状态与筛选2026-10-19-后端接续)，责任归[信息与计划 §1.3](../architecture/information-planning.md#13-长期记忆的有效状态2026-10-19)，产品行为归[工作台 §13.3](../frontend/workbench-design.md#133-长期记忆状态与筛选2026-10-19已确认前端已接)。结果只归统一验收表「长期记忆状态与筛选后端」行。

对应前端提示词：[长期记忆状态与筛选前端任务书](../../prompts/memory-status-frontend.md)。当时前端 client/筛选/标签未接，已由下节接续；无新 migration，未修改用户库，未 commit/push。

## 长期记忆：有效状态与筛选前端（2026-10-19，未 commit）

按 `prompts/memory-status-frontend.md` 接前端，只改 `api/dtos|parse|resources/information.ts`、`relayClient` facade 与 `KnowledgeView` 的 Memory 页签，未动后端、数据库与其他页签。

- **client**：Memory DTO 增加只读 `effectiveStatus`（ACTIVE/EXPIRED/RETIRED）；缺字段（旧服务端）落为 null，显式 null 与未知枚举按契约错误失败；历史 revisions 不解析动态状态。`getMemories(projectId, effectiveStatus)` 默认 ALL 不追加参数，三态各自落到 `effective_status` 且可与 `project_id` 组合。
- **视图**：Memory 列表内新增「全部/有效/已过期/已停用」分段筛选，由真实 GET 裁决；切换清空旧行与选中项、迟到响应按读取版本号丢弃；列表与详情按 effectiveStatus 显示四种标签，同时保留确认信息、有效期与持久状态，已停用且到期仍显示「已停用」；首次空态、筛选无匹配与读取失败分开表达；不按浏览器时钟推断。
- **生命周期**：过期但未停用的记忆仍可停用与追加修订，详情给出续期入口并说明恢复不延长有效期；恢复回执改为「已恢复记忆的持久状态」，重读后仍到期显示「已过期」；停用/恢复后按当前筛选重读，不匹配项从列表移除并把详情落到剩余项。
- **证据**：新增 `memoryStatusClient` **4/4**、`memoryStatus` **7/7**（实现前 11 例全红）；回归 `knowledge` 18、`knowledgeReading` 9、`knowledgeContentClient` 5、`informationRestore` 9、`informationRestoreClient` 5，共 7 文件 **57/57**；Workbench `tsc --noEmit` 仅剩并行未跟踪的 `tests/tmpFlashProbe.spec.ts`，`vite build` exit 0。成绩归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)新增「长期记忆状态与筛选前端」行。

**未闭合**：本机无运行中的真实 API/PG，未跑真实 API 浏览器链路，Workspace/Project 范围与过期数据未取证；真实 Windows/WebView2、安装态、多 DPI 与真实 Provider 未验；未做独立验收，未 commit/push。此片完成不代表自动记忆、学习模式或全记忆产品已交付。

## 默认工作目录：前端接线（2026-10-19，未 commit）

用户下达 `/D:/Develop/Relay-Agent/prompts/default-working-directory-frontend.md`，按任务书接剩余前端部分：设置入口、真实接口、建会话后的作用域读回与来源呈现。后端、迁移与读取链未改，沿用并行会话在输入器、图片附件、插件菜单与模型选择器上的未提交改动。

- **client**：`get/set/clearWorkspaceDefaultDirectory` 走 `/default-working-directory` 与 `/default-working-directory/clear`；`UNSET` 修订读成 `0`，`UNAVAILABLE` 与未设置分开；回执核对 `command_id`、`workspace_id`、`resource_id` 与十进制 `revision`，任一处不符只抛 `RelayTransportError`。会话上下文新增 `working_directory.source`（`USER_PICKED / WORKSPACE_DEFAULT / null`），缺字段按历史未知，词表外值显式失败。
- **设置**：基本设置新增「默认工作目录」一行，五态可见（未设置/读取中/有效/失效/读取失败）；原生选择器＋非桌面手输回退；只有 `OpenWorkingDirectory` 回执 `READY` 且带受管资源才发设置命令，未就绪原样说明原因并保留原值，**只读目录也能设为默认**；设置/清除严格用最近读取的修订，`409` 重读并提示冲突而不覆盖；传输结果不明保留原命令/原载荷并走回执核对；换 Workspace 清空旧投影，迟到响应按版本闸丢弃；挂载、切分组与重读只发 GET，不写 localStorage。
- **会话**：建会话成功后按回执 `session_id` 读回上下文；服务端继承默认目录时会话本就带 Project，宿主据此切到该项目作用域，**不补第二次目录绑定**；空态说明句按 READY / UNAVAILABLE / 未设置分别措辞；细条与顶栏只在 `source=WORKSPACE_DEFAULT` 时标「默认目录（来自设置）」，`USER_PICKED` 与缺字段都不标。
- **证据**：Workbench `tsc --noEmit` exit 0、`vite build` 成功；新增 `settingsDefaultDirectory` **7/7**、`assistantClient` **18/18**（新增 8 例）、`folderFirstConversation` **26/26**（新增 3 例），连同 `settingsView` 15、`newConversationEntry`、`assistBinding`、`conversationDiffSummary` 共 7 文件 **103/103**。全量 1220 例中 18 例失败，其中 17 例与 HEAD 基线逐条一致（并行会话未提交改动），余下 `run-events` 时序断言在满载下偶发、单跑 5/5。成绩归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)新增「默认工作目录前端」行。

**未闭合**：本机无运行中的真实 API/PG，未跑真实 API 浏览器链路，也未为取证写入用户库；DD-06 完整 Gateway 矩阵、真实 Windows/WebView2、安装态、多 DPI 与真实 Provider 未验。未 commit/push。

## 资料与记忆规则恢复：前端接线（2026-10-19，未 commit）

用户下达「/D:/Develop/Relay-Agent/prompts/information-restore-frontend.md」，按任务书把三类反向命令接到资料页，未改后端与数据库。

- **client**：`unarchiveKnowledge / reactivateMemory / reactivateRule` 走 `/knowledge/{id}/unarchive`、`/memories/{id}/reactivate`、`/rules/{id}/reactivate`，请求体只有 `command_id + expected_revision`；回执核对 `command_id`、目标 ID、`status:"ACTIVE"` 与 `revision ≥ expected_revision`，任何一项不成立都按「结果不明」抛 `RelayTransportError`，不返回可用的信封。
- **撤销条**：资料归档与记忆/规则停用保持「单击即发」，`submit()` 只增补返回值（`CONFIRMED / REJECTED / UNCERTAIN`），其余调用者行为不变；正向回执确认后才弹「已归档资料 / 已停用记忆 / 已停用规则 · 撤销」。撤销用新 `command_id` 与**正向回执修订**，闭包捕获原 API、类型、对象 ID 与范围，不读之后变化的 `selected`；回执不明时不给撤销条，保留就地「无法核对」与原 `command_id` 核对入口。
- **失败与永久入口**：撤销冲突或网络失败把同一条浮层升级为 Notice 并指向列表里的永久入口。三类列表本来就返回非活动项，因此未另建管理页——详情阅读区末尾新增「恢复这条资料 / 记忆 / 规则」，用**当次读回**的对象修订，冲突先重读事实再要求重新决定；归档 Project 下沿用既有写入守卫禁用并给出原因。文案统一写明只恢复状态：正文版本与确认记录、Memory 有效期、待核对候选、规则/上下文修订与旧 Run 效果都不回退。
- **证据**：新增 `informationRestoreClient` **5/5**、`informationRestore` **9/9**；回归 `knowledge`、`knowledgeReading`、`knowledgeContentClient`、`knowledgeCaptureLayout`、`feedback`、`projectKnowledgeGuide` 6 文件 **56/56**；Workbench `tsc --noEmit` exit 0、`vite build` 成功。成绩归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)新增「资料与记忆规则恢复前端」行；规则归[工作台 §13.2](../frontend/workbench-design.md#132-危险操作的两条通道2026-10-18)，协议补充归 [HTTP §10.97](../api/http-command-contract.md#1097-资料归档与记忆规则停用的反向命令2026-10-19-后端实现)。
- **未闭合**：本机无运行中的真实 API/PG，**未跑真实 API 浏览器链路**，也未为取证写入用户库；真实 Windows/WebView2、安装态与多 DPI 未验；连接/资源反向命令与不可逆族统一确认框仍未实施。未 commit/push。

## 资料与记忆规则恢复：后端反向命令（2026-10-19，未 commit）

用户要求「先给前端开发提示词，然后继续下一个功能的后端开发」。默认工作目录的前端任务书已交付：[前端接续任务书](../../prompts/default-working-directory-frontend.md)，只负责设置入口、真实接口、创建后上下文读回与来源呈现；本轮未执行前端产品开发。

下一个后端切片接续工作台 §13.2 的已确认撤销规则：新增 `UnarchiveKnowledge / ReactivateMemory / ReactivateRule` 与三条 POST API，复用 Information Owner、根修订、Workspace authority、Project 归档栅栏和原状态写入口；没有新增迁移。只恢复状态并保存前向回执与关键审计，不改不可变版本、Memory 确认/有效期、Decision 或归档产生的待核对候选。已 ACTIVE 不重复推进修订；并发命令、原命令重放与失效基线按原幂等机制收敛。规则恢复仍推进 rule_revision/context_revision，不回退原 Run 契约或已发生效果。

对应前端接续入口已补齐：[资料、记忆与规则恢复前端任务书](../../prompts/information-restore-frontend.md)，覆盖三接口 client、撤销条、永久恢复入口、异常回执核对与验证；前端开发已由顶部「资料与记忆规则恢复：前端接线」执行完成。

协议归 [HTTP §10.97](../api/http-command-contract.md#1097-资料归档与记忆规则停用的反向命令2026-10-19-后端实现)，责任归[信息与计划 §1.2](../architecture/information-planning.md#12-生命周期恢复2026-10-19-后端实现)，实际结果只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「资料与记忆规则恢复后端」行。下一步：本族前端撤销条与永久恢复入口已由顶部前端接线节接续；连接/资源反向命令与不可逆族统一确认框仍待后续切片。权限策略撤销不开放撤销。未 commit/push，未修改用户库。

## 默认工作目录：后端配置与创建继承（2026-10-19，未 commit）

用户下达「继续开发后端部分」，本轮接续已确认的默认工作目录方案，完成后端最小读取闭环；前端产品代码未改，保留已有输入器、模型选择器与桌面宿主等并行改动。

- 新增迁移 `0117_workspace_default_directory.sql`（原计划号 0111 已占用）：Workspace 单行配置、独立 revision、清除保留修订；会话新增可空来源列，历史不回填。
- 配置命令与只读查询已接 HTTP：设置/清除遵守原 command_id 幂等与 revision CAS；跨 Workspace、失效目录与重叠根不覆盖原配置。GET 不登记目录、不创建权限；配置引用原 OpenWorkingDirectory 的受管资源。
- 仅无 Project/Task 的普通 AGENT 在创建短事务内继承有效默认目录；ASSISTANT/LEARNING 与显式作用域不继承。失效回落为无目录；原读取链不增加兜底。显式绑定标为 USER_PICKED，分叉保留原来源，设置变更不改历史会话。API/数据库协议归 [HTTP §10.96](../api/http-command-contract.md#1096-workspace-默认工作目录2026-10-19-后端实现)与[数据库 §104](../database/physical-design-postgresql.md#104-0117-workspace-默认目录2026-10-19)，任务书已标注后端接续与剩余项。

实际结果与环境只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「默认工作目录后端」行。该轮剩余出口中的「配置设置入口与来源消费未接入」已由顶部「默认工作目录：前端接线」节接续；仍剩完整 DD-06 Gateway 新建/修改/删除矩阵未闭合，真实 Provider、Windows 与用户库升级未验。本轮没有 commit/push，没有迁移用户库。

## 七会话遗留任务收口（2026-10-19，未 commit）

用户要求「继续 workbuddy ai 没完成的七个会话任务」。逐条核对 `C:/Users/ASUS/.workbuddy/projects/d-Develop-Relay-Agent` 下的会话与 `tasks/` 状态后，遗留项归为四类；代码侧多数已在 `7760e8d0` 落地，缺的是**逐项复验**与三处真实缺口。

- **会话映射**：`5e5cdb68`（图片附件 6 项）与 `dfa64938`（粘贴 2 项）合成一条线；`bfcfa4d9`（会话 diff 缺真实 PG 测试）；`c8a1a76d`（电脑插件真机取证与文档）；`1bdcf8fb`、`0ecd7d25`、`7471f34a` 核对后无遗留工作（前者的「删除横线」已完成、末尾是新请求遇 429；后两者被用户中断，未产生待办）。
- **附件线：补两个真实缺口**。① 会话输入器没把「已暂存未发送的图片」算进未保存保护，切路由会静默丢图——现并入 `dirty`，`discardDraft` 一并回收；② 上传成功但命令被 422 明确拒绝时芯片已随 `clear()` 清空，图片消失——现在只对**明确拒绝**把文件还回输入框，传输失败不还原（那时命令可能已入库，恢复会诱导重发）。文档侧 §33.2 原写「前端按目录 `image_input` 预检」与实现不符，已改为以服务端 422 为准绳。
- **diff 线：补真实 PG 集成测试**。旧记录的理由是「本环境无 PG」，实际 `run-integration.ps1` 的一次性临时集群可用。新增 `apps/api/test/integration/conversation-diff.integration.test.ts` **5/5 PASSED**：基线幂等只留一条有效行、`MODIFY/CREATE/DELETE` 行数与合计一致、展开正文与总数同源、`NO_RESOURCE`／`NO_BASELINE`／`NOT_GIT_ROOT`／`ROOT_NOT_GIT` 四态、换目录不跨段求和。
- **电脑线：重建 release 并更正证据**。旧 `relay-computer-runtime.exe` 是 10-16 产物，已按 10-18 改动 `cargo build --release` 重建；只读探针（环境探测、8 窗口、2560x1440 截图）与外部 kill 后透明重连均为当前构建实测。文档把 `cargo test` 18→20、`computer-plugin` 25→27、输入工具 8→9、滚动「向零取整」对齐实现，并把 2026-10-16 真机验收如实记为 **11/12**（剪贴板核对失败），不再写成通过。`docs/README.md` 补电脑插件导航行。

**实际验证**：Workbench 定向 `composerImageAttachments` **7/7**、`tsc --noEmit` exit 0；API `tsc -p` exit 0、`conversation-diff-*` 单元 **61/61**；真实临时 PG `assist-message-attachments` **5/5** 与 `conversation-diff` **5/5** 均 `status PASSED`；`cargo test` **20/20**、API `computer-*` 定向 **42/42**、`computer-control` 集成 **10 通过/1 跳过**；`node scripts/check-docs.mjs` exit 0。成绩已写入[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)顶部三行。

**同日追加（用户指认「加号的菜单看不到这三个插件」）**：「+ → 连接器与插件」二级顶部新增「内置插件」分组，恒列电脑操控、浏览器操控、GitHub——原来它们只随项目连接登记出现在「已连接能力」里，无项目归属时整块为空。固定的是身份与去向（点击进 `/settings/connections`），状态仍逐项取自服务端连接登记，未新增前端能力词表。`composerAttachMenu` **26/26**、`tsc` exit 0，规则归[工作台 §32.9](../frontend/workbench-design.md#329-连接器与插件二级2026-10-17)。同时按用户要求重打测试包，使桌面窗口里的 UI 与 API 都包含本轮改动（用户此前截图里的「`/content` 不符合契约」来自包内旧 API 的 schema，源码 `assistMessageContent` 早已允许空正文）。

**同晚收敛（用户指认「为什么这里需要项目中授权……这些都是过度设计」）**：上一段的三行插件各自挂着「需在项目中授权」，加上菜单脚注与「已连接能力」的同类空态，同一句话在同一个面板里出现四次。现改为：读不到连接登记时**不写状态**（无从判断，不编「未授权」），面板首句只说「连接器随项目配置」，必然为空的「已连接能力」整节不渲染，措辞收成 `connectorScope` / `connectorScopeNote` 一份；`/settings/connections` 删掉「按已知项目 ID 打开」的手输 UUID 表单（开发自测残留）。`composerAttachMenu` **26/26**、`assistantModeSwitch` **47/47**、`connectionsSettings` **23/23**、`tsc` exit 0；真实 Chromium 临时预览页量得面板 156×330、首句单行（截图 `apps/workbench/results/attach-connectors-no-project.png`）。真实 Windows 窗口与 DPI 未取证，改动未 commit。

**同晚第三轮：连接器作用域收敛方案 C 落地（后端，用户授权「按照你的来」）**：新增 `CopyGatewaySettings`——`POST /projects/:project_id/gateway-settings/copy`，把来源项目的 ACTIVE 受管资源、连接（含边界 config 与能力）与 ACTIVE 策略的当前生效版本一次命令复制进目标项目（资源按 identity、策略按 capability+action+target、连接按 config+能力判重跳过；advisory 锁 7162,9 与回执同事务）。**不做** `project_id` 可空：按项目登记是 authority 链与审计的基础，复制只消重复劳动。契约归 [HTTP §10.101](../api/http-command-contract.md#10101-连接与权限沿用复制2026-10-19-后端实现)，前端提示词归 [prompts/gateway-settings-copy-frontend.md](../../prompts/gateway-settings-copy-frontend.md)（按 AGENTS 规则本轮不自动实施前端）。集成测试 `gateway-settings-copy.integration.test.ts` **真实临时 PG status PASSED 4/4**（复制落库、判重、同 command_id 原样重放、只复制 ACTIVE、来源=目标与跨 Workspace 拒绝；首跑夹具把来源/目标建成了跨 Workspace，已修正为同 Workspace 两项目）。过程中顺手修了并行会话 `model-capability-repository.ts` 三处漏 `.execute(this.db)` 的机械错误（当时它挡住整树 build）。改动未 commit。

**同晚第二轮：「+」撤出目录入口（用户指认「选择目录之类的都是过度设计」，已授权「按照你的来」）**：目录有常驻 Owner（协作页目录细条，目录名即「更换目录」、弹层含手动输入与近期目录），「+」里再放「选择工作文件夹」既是重复实现又读成门禁。删除一级「选择工作文件夹」行与目录二级，`ComposerAttach` 的 `onFolder`/`onOpenRecentFolder`/`recentFolders`/`folderPath`/`folderBound` 与 `AssistView`/`AssistSessionPanel`/`CollaborationView` 的整段转发链一并移除，一级五项收为四项；目录行为契约不变（仍走 `requestFolderTransition` 守卫与 `OpenWorkingDirectory`，原生选择器优先，`requestFocusFolder` 保留给候选目录场景）。证据：`composerAttachMenu` **25/25**、`assistantModeSwitch` **47/47**、`folderFirstConversation` **26/26**、`tsc` 对本片文件干净；`collaborationWorkspace` **9/79 失败**为并行会话既有改动所致（draft 守卫、资料检索、轨迹与 Review 各片，与本轮改动文件无交集），未逐例复核归因。规则归[工作台 §32.3](../frontend/workbench-design.md#323-二级资料与命令的接入点)。


**未闭合**：真实 Windows 窗口的粘贴/拖拽与九个电脑输入方法、真实 Provider 多模态语义与工具流、安装态打包、多显示器；diff 的 HTTP 路由与 DTO 形状、并发首个请求、采集不完整分支未在本轮套件断言。工作树另含并行会话对 `ModelSelector.tsx`、`AssistView.css`、`design-system.md` 的未提交改动，未触碰、未回退。全部改动**未 commit**。

## 任务栏待处理角标（2026-10-19，未 commit）

用户以任务栏截图问「relay 现在有任务角标吗」，核实为**没有**（桌面端此前无任何 overlay／托盘实现，图标右下角的橙色块是应用图标自带的暂停形徽章），随后要求补上。

- **实现**：新增 `apps/workbench/src/lib/taskbarBadge.ts`，在 32×32 canvas 上画角标 → `Image.new(RGBA)` → `getCurrentWindow().setOverlayIcon()`。数量取自 `InterventionNotifications` 每次 `getInterventions()` 的结果，与顶栏铃铛同一份事项，不新建计数事实源；数量未变不重设，组件卸载（切回示例数据、退出应用）时撤掉，超过 99 显示 `99+`；宿主拒绝或无 canvas 时只 `console.warn`，不打断轮询。**未新增 Rust 代码、图片资源或 PNG 依赖**：走 `JsImage::Rgba` 分支，不需要 tauri 的 `image-png` 特性（`from_bytes`/`from_path` 才需要）；已在本地 cargo registry 核对 `tauri-2.11.6/src/image/mod.rs:145` 直接 `muda::Icon::from_rgba(rgba, width, height)`，不经 PNG 解码。
- **宿主权限**：`apps/desktop/src-tauri/capabilities/default.json` 增加 `core:window:allow-set-overlay-icon` 与 `core:image:allow-new`，**须重新构建桌面端才生效**。
- **测试接线**：`tests/setup.ts` 补 jsdom 缺失的 `getContext` 桩（只可调用、不产出像素），`interventionNotifications.spec.ts` 的宿主桩补 `setOverlayIcon` 与 `@tauri-apps/api/image`，避免铃铛用例每条刷一遍宿主告警。
- **证据**：新增 `taskbarBadge` **5/5**（文案边界、绘制顺序与字号、非桌面模式不碰宿主、同数量不重设、宿主拒绝只告警）；`interventionNotifications` 7、`desktop-titlebar`、`projectReminderNotifications` 回归共 **14/14**；`vite build` exit 0；`tsc --noEmit` 仅剩并行会话的两处报错（未跟踪的 `tests/tmpFlashProbe.spec.ts`、`assistantModeSwitch.spec.ts` 的未使用导入），不涉及本片路径；`cargo check` exit 0 且 `gen/schemas/capabilities.json` 已含两条新权限（说明标识符被 ACL 接受）。**全量 vitest A/B**：把本片改动临时退回 HEAD 跑一遍是 104 failed／1135 passed，带本片是 102 failed／1142 passed（多的 5 例正是本片新增用例），即本片不引入新红灯；现有红灯来自并行会话未提交的改动（如 `useChatImageInputNotice` 未定义、`live-task-accepted-facts` 选择器缺失），未代改。真实 Chromium（vite dev 4173 ＋ Playwright）直接调用 `drawBadge` 出图，32/24/16px 与深浅两种底色对照见本机 `apps/workbench/results/taskbar-badge-2026-10-19/sheet-scales.png`，贴到任务栏机器人图标右下的合成预览见同目录 `relay-mock2-zoom.png`（四张原图 `badge-1/7/42/99+.png` 同目录保留）：16px 单字符可读、两位以上发糊，白色描边在深浅底色下都能把圆盘分离出来（这一版外观随后被用户判为「太难看」，见下条）。规则归[工作台 §11.5](../frontend/workbench-design.md#115-已确认的人工介入提醒规则)，外观归[设计系统 §1](../frontend/design-system.md#1-视觉依据与提取边界)，成绩归验收表新增「任务栏待处理角标」行。
- **外观重画（同日第二轮，用户指令「角标太难看了，用 tasteskill 优化一下」）**：按 taste-skill 的读法把角标当宿主表面状态标记处理，取 Windows 数字徽章的语言而不是 iOS 红点。四处改动：① 3px 白圈收成一圈 1px 纸面细边（原圈把红盘吃成 24px，读起来是甜甜圈）；② 砖红 `#A34F43` 提为 `#BE3E2C`，数字与细边走 `color.palette.paper` 的 `#FBFCFA` 而非纯白；③ 外形按位数变：一位 28px 圆盘、两位 30×26 胶囊、`99+` 30×22 胶囊，三个字符不再挤进正圆；④ 字号 22/20/13、字族 Segoe UI Variable Display 回落 Segoe UI，基线按 cap-height 0.7em 算到视觉中心，替掉 `textBaseline: middle` 加 `+1` 的近似。**证据**：`taskbarBadge` 5/5（绘制顺序断言已钉住两两半圆的胶囊几何）、`interventionNotifications` 7/7、`vite build` exit 0、`tsc --noEmit` 本片路径无报错；`apps/workbench/probe-badge-restyle.mjs` 用 `typescript` API 转译 `taskbarBadge.ts` 后在真实 Chromium 执行同一份 `drawBadge`，改前/改后 × 深浅底色 × 1:1 任务栏（含应用图标相邻）× 4× 像素放大的六栏对照见 `apps/workbench/results/taskbar-badge-2026-10-19/restyle-sheet.png`，页面无脚本错误；1:1 档单双字符清晰、`99+` 仍偏挤。数值同步到[设计系统 §1](../frontend/design-system.md#1-视觉依据与提取边界)，验收表同行更新。
- **未闭合**：**Windows 外壳的实际叠加未取证**——需要重新构建桌面端、连真实 API 且有 ≥1 条待人工介入事项才能在任务栏看到它；多 DPI／任务栏图标实际取用哪一层、安装态、独立验收均未做；未 commit/push。Chromium 出图只证明绘制代码，不代替宿主叠加效果。

## 危险操作可撤销化与会话物理删除（2026-10-18，未 commit）

用户下达「危险操作像是会话归档删除，都要有一个 toast 可以让用户撤销动作」，两轮澄清后裁定：撤销条替代确认框、覆盖全部危险操作、会话新增物理删除且不可撤销、不可逆族只给确认框。规则唯一归[工作台 §13.2](../frontend/workbench-design.md#132-危险操作的两条通道2026-10-18)，删除边界归 [ADR-027](../decisions/ADR-027-session-physical-delete.md)。**未 commit/push**。

- **已落地前四阶段的一部分**：① 命令式撤销条机制（`openUndoFeedback`／`escalateFeedback`／`closeUndoFeedback`，同键单条、升级 Notice 不新增 token/CSS、计时归宿主）；② 会话归档接撤销（归档成功弹 8 秒 Snackbar，撤销再发一条新 `command_id` 的「重开」，修订取归档回执；回执不明不给撤销）；③ 会话物理删除（迁移 `0116` 只授 DELETE；`DeleteAssistSession` 按子→父显式删会话自有账本；九类跨对象引用与在途消息整条拒绝；`activity_records` 写 `ASSIST_SESSION_DELETED`；前端菜单 danger 项 + `AppDialog` 确认、无撤销条）；④ 项目归档接撤销并去掉原确认框（`UnarchiveProject` 只把 `archived_at` 写回 NULL，已 ACTIVE 不推进修订，撤销用归档回执修订）。
- **契约已同步**：`contracts/01` A03、`contracts/03` 有效性表与保留段、`domain-model` 会话责任行；新增 ADR-027。
- **实际证据**：`tests/feedback.spec.tsx` 11/11；`tests/sessionRowMenu.spec.ts` 19/19；真实临时 PG `assist-session-delete.integration.test.ts` 9/9（`run-integration.ps1 -TestFile assist-session-delete` status PASSED）；`projectArchiveLive.spec.ts` 4/4、`listViewCopy.spec.ts` 归档回执用例、真实临时 PG `project-archive.integration.test.ts` 14/14（两条撤销归档）；两侧 `tsc --noEmit` 对本片文件干净。
- **未闭合**：真实 Windows/WebView2 与多 DPI 未复核；迁移 `0116` 是否已在用户库应用未取证；资料归档与记忆/规则停用反向命令已于 2026-10-19 接入后端（见顶部接续节，前端未接）；连接与资源停用的反向命令（阶段 4 剩余）与不可逆族统一确认框（阶段 5）未实施。共享工作树里 `AssistView` 来源面板与 `conversationDiffLayout` 仍有他人未提交的类型错误，未代改。

## 会话分叉：带历史 fork（迁移 0113，2026-10-18 源码实现，未 commit）

用户先要求「复制会话 ID」写成 `relay://sessions/<id>`，随后追加「支持右键打开菜单、增加归档、fork（fork 后的会话名加『（1）』）」。归档、右键与浮层间距在前一轮落地；本轮补 fork，并按用户选定「带历史 fork」实现真复制。**未 commit/push**，成绩只归验收表新行。

- **服务端**：`ForkAssistSession` + `POST /assist-sessions/{id}/fork`（201）。迁移 0113 只加可空自引用列 `assist_sessions.forked_from_session_id`（无索引/CHECK/GRANT，Breaking Change: No）。子会话整行搬运身份列、`revision=0`、置顶/未读/活动键归零；只复制 COMPLETED 消息与图片附件、`seq` 从 1 重排；提案、usage/请求号/worker/错误码/模型身份对（0098 成对约束）不复制。源会话一行不改、不推进修订；归档、在途、陈旧修订与跨 Workspace 各有栅栏；同 `command_id` 重放返回同一子会话。
- **标题**：末位（n）→（n+1），否则（1）；编号跟被分叉那条自己的标题走（同一源两次都是（1））；200 上限截正文保编号，按完整码点退让。
- **前端**：会话行菜单在「取消未读」后、分组线前加 `GitFork`「分叉这段讨论」；成功后不重读源行，按回执里的子会话身份定向重读；归档态不出现该入口。
- **实际验证**：真实临时 PG `assist-session-controls` **22/22**（新增 5 条）、入口栅栏单测 **6/6**、Workbench `sessionRowMenu` **19/19**、API `tsc --noEmit` exit0、`node scripts/check-docs.mjs` 通过。Playwright 定向 **6/9**：失败载荷已确认菜单实际含「分叉这段讨论」；1 条红灯来自并行未提交的第 7 项「删除这段讨论」，另 2 条因并行未提交的 `AssistView.tsx` JSX 语法错误导致 dev 构建失败，均非本片。
- **未闭合/取舍**：真实 Windows/WebView2 窗口未点验；子会话历史不回显当时的模型选择；同一源多次分叉标题相同，靠列表时间区分；迁移台账套件当前因并行流未登记 0114/0115 而红，非本迁移引入。规则归 [HTTP §10.93](../api/http-command-contract.md#1093-会话分叉2026-10-18-源码实现迁移-0113)、[数据库 §102](../database/physical-design-postgresql.md#102-0113-会话分叉血缘2026-10-18-源码实现)、[工作台 §28.1](../frontend/workbench-design.md#281-左栏recentworkrail)。

## 会话按最后消息时间自动上浮（迁移 0111，2026-10-18 源码实现，未 commit）

用户先问「会话 item 现在有按照 AI 最晚回复时间自动排序的功能吗」，确认没有后指定口径「就按消息的最后时间算吧，不管是 ai 还是用户」，并要求参考上游实现；随后以「需要」批准完整落地方案。本轮已实施，**未 commit/push**，成绩只归功能验收表新行。

- **口径**：取**活动序**（不分发送方，失败或取消的那一轮同样上浮），不是 OpenCode 那种只在用户发起时 touch 的「最近问序」。服务端排序为 `pinned_at desc nulls last, coalesce(last_message_at, created_at) desc, id desc`；手动拖拽排出来的本机次序仍优先于活动序。
- **迁移 0111**：`assist_sessions.last_message_at timestamptz NULL`，只加列，不回溯历史、不加索引、不加 GRANT，Breaking Change: No。写入 Owner 恰两个：`insertMessage`（用户消息与发送时预插的 PENDING ASSISTANT 行）与 `settleGeneration`（CAS 命中后结算），都以 `greatest(last_message_at, now())` 单调推进；**不推进 `revision` 与 `updated_at`**，否则在途生成会把改名、置顶、未读等人工命令的 CAS 基线打成 409；预览帧 `assist_message_previews` 不 touch。
- **投影与前端**：HTTP 会话 DTO 增补只读 `last_message_at`（命令回执形状不变，迟到结算不会把列表读法变成写）；Workbench 解析为容缺可空字段并在客户端 `compareSessions` 用 `lastMessageAt ?? createdAt` 排同一档，与服务端 `coalesce` 同义。任务行排序与悬停摘要卡仍按/显示 `updatedAt`——后者是元数据写入时刻，改显示口径属另一轮界面决定。
- **上游对照**：采纳 ZCode `touchSession`＋`max(time_updated, ?)` 的单键单调推进；Codex 把 `updated_at` 与 `recency_at` 分开、DSH 用 `max(createdAt, lastPromptAt)`，与本方案同向。对照与取舍归[数据库 §100](../database/physical-design-postgresql.md#100-0111-会话活动排序键2026-10-18-源码实现)与 [HTTP §10.91](../api/http-command-contract.md#1091-会话列表的活动排序键2026-10-18-源码实现迁移-0111)。
- **实际验证**：真实临时 PG `assist-session-controls` **18/18 PASSED**（新增四例：列形状且不推进修订、单调推进、列表上浮、结算推进与迟到结算不推进）；Workbench `recentWorkDrag.spec.ts` **8/8**（新增活动序 3/1/2 与置顶压在活动序上）；本片文件 `tsc --noEmit` 干净；`node scripts/check-docs.mjs` exit0。集成脚本以 `-SkipBuild` 运行——全量构建被共享工作树中并行未提交文件的类型错误挡住，改用一次性 scratch tsconfig 发 dist，因此「整仓构建通过」未验。
- **未闭合**：左栏只在挂载、整列重读与行内命令后的定向重读时取新序，**没有轮询也没有事件订阅**，AI 回完那一刻这一行不会当场跳位；真实 Windows/WebView2 窗口未复验；Workbench 全量 vitest 在并行编辑下存在与本片无关的红灯，未作为证据。迁移号占用更新：0111 为本功能，0112/0113 已被并行工作占用，当前下一个空闲为 **0114**。

## 计划执行方式设置：生成计划后自动执行还是人工确认（2026-10-18）

用户下达「给 relay 的计划模式增加一个设置，可以选择是生成计划后自动执行还是需要人工确认」。已实施（**未 commit**）：服务端契约与 `auto_start` 投影不变，新增**本设备偏好**（`apps/workbench/src/lib/planExecutionPreference.ts`，localStorage `relay.workbench.planExecution`，默认 `AUTO` 保持既有行为）；设置页「执行策略」分组新增 `plan-execution` 卡片（`settings-plan-execution-mode` / `settings-plan-execution-save`）；对话面板在 `CONFIRM` 档不自动应用就绪候选，摘要保留「按这个目标执行」，点击后按原 `request_id` 进入原 Task/Run 链并按 §18.4 自动切到原 Task。权限、Gateway 准入、范围授权与 DELETE 确切确认不因此改变任何一条；授权来源始终是最初那条用户消息。产品规则归[工作台 §18.4.2](../frontend/workbench-design.md#1842-计划执行方式生成计划后自动执行还是人工确认2026-10-18已实施)。

**实际证据**：workbench `tsc --noEmit` 对本片文件零错误（两个测试文件的既有报错来自并行实例未提交改动）；`vitest run` 定向 5 文件 **67/67**（`settingsView` 15、`executionSummary` 7、`folderFirstConversation` 22 含新增「人工确认」反例、`displayPreferences` 7、`conversationExecutionClient` 4）；另跑 `collaborationWorkspace`/`assistantModeSwitch`/`assistBinding`/`conversationStateMaintenance` 4 文件 **145 通过 / 4 失败**，该 4 例经 `git worktree` HEAD 基线复跑同名失败，为既有失败，与本片无关。

**未闭合**：真实 API/PG 与真实 Windows/WebView2 窗口未取证；偏好仅本设备生效，多设备同步不在本片范围；功能验收表未新增成绩行，待真实链路取证后再记。

## 输入器权限档位改四档并新增「完全访问」（2026-10-18）

用户实机指认对话输入器的权限下拉，要求按通用 Agent 口径改成**请求批准 / 自动批准 / 完全访问（红色）**，并澄清两点：「完全访问」要做成真实新档位（不是文案），「只读」保留为菜单第四行。本片按已批准计划实施，**未 commit/push**，成绩只归验收表新行。

- **范围差异（重要）**：`FULL` 只覆盖 **FILE_WRITE 能力族**——该目录内的新建、修改、删除不再逐次确认。Git 提交/推送、CLI、浏览器、电脑控制、目录外动作仍按各自策略逐次确认；把目录档位扩成跨能力族授权会违反「能力与权限分开」，`git push` 更是不可逆外部副作用。
- **后端**：迁移 `0112_local_directory_full_access.sql` 只放宽 `local_directory_access` 的档位 CHECK（加值、不动既有行、不加 GRANT）。网关判定词表仍是 `AUTO/ASK/DENY`，`FULL` 落的是与 `AUTO` 逐字相同的策略行，差别只记在 `write_tier` 一列，因此 prepare 与 dispatch 都通过**同一个** `directoryHasFullAccess` 按 `resource_id` 现算，豁免只并入 `scopeCovered` 一个条件；`evaluateScopeGrant` 与 `SCOPE_GRANT_DELETE_REQUIRES_APPROVAL` 保持不动（范围授权永远不含删除，这是范围授权的边界，不是目录档位的边界）。投影新增 FULL 分支文案，界面按 `write_tier` 而非 `policy_decision` 区分 AUTO 与 FULL。
- **前端**：`WritePermissionControl` 四档 = 请求批准（`Hand`）／自动批准（`Zap`）／完全访问（`Flame`，整行与芯片取 `--relay-color-status-danger-text`）／只读（`Lock`）；四图标取轮廓互异的一组，不再全用盾牌族。菜单行改为「图标列 + 文本列」的 grid，不新增 token。底栏摘要行与芯片共用同一份 `tierLabels`，删除 `AssistView` 里的第二套枚举。
- **实际验证**：API `tsc --noEmit` exit0；API 定向单测 **67/67**（`check-trust-basis`、`gateway-exec-allowlist`、`file-changeset`）；真实临时 PG 定向四套件 `local-directory-access`／`migration`／`cli`／`folder-first-conversation` **36/36**，含两例新增——`FULL` 档位往返＋策略行仍 `AUTO`＋未知取值 422，以及完全访问目录内 DELETE 不产生 `ACTION_APPROVAL` 且真实落盘（同套件既有的 AUTO 删除仍需确认那例同时保持绿）；Workbench `writePermissionTier` **13/13**、`popoverMenu` 5/5、`newConversationEntry` 12/12。全量 Workbench jsdom 仍有 **17 个文件红**（collaborationWorkspace、assistantModeSwitch、taskSkillProposal、folderFirstConversation 等，失败点集中在 `[data-testid="assist-draft"]`、项目总览文案、工具轨迹文案），全量 API 单测 **832 例 / 800 通过 / 31 失败**，两组红灯与上一节记录的他人并行改动清单同源，只报不修；Workbench 全量 typecheck 仍被 `tests/browser/zz-reviewsTypographyProbe.spec.tsx` 的未使用变量阻塞。
- **偏离计划两处**：① 计划里的 `check-trust-basis.test.ts` FULL 单测没有落地——`evaluateScopeGrant` 不掌握目录档位，豁免发生在 Gateway 准入，因此改由上面的集成用例正面覆盖；② `ensureLocalDirectoryReadAccess` 的反向推导不需改（已有档位记录时提前返回），`FULL` 只可能来自显式命令。
- **顺手修正他人红**：`migration.integration.test.ts` 的 `ALL_MIGRATIONS` 里 `0113_assist_session_fork` 被并列写了两遍（并行编辑产物），会让该套件按 114 条断言而真实只有 113 条；已删掉重复行。`cli.integration.test.ts` 的 `ledger_rows` 与两份迁移清单在本片开工前已被并行改成 113，无需再改。
- **未闭合**：桌面 dev 窗口实机点击未复验（须先 `-RefreshApi` 重新暂存后端，否则新 `write_tier` 值会被旧暂存 API 判 422）；真实 Windows/WebView2、多 DPI、IME 与安装态本轮不复验；`FULL` 没有浏览器端 Playwright 取证（现无 `write-permission` 浏览器 spec）；跨能力族（Git 也免确认）不在本片范围。

规则唯一归[工作台 §18.1.3](../frontend/workbench-design.md#1813-输入器的本目录写入档位2026-10-17)与 §18.1.4，服务面归[HTTP §10.86](../api/http-command-contract.md#1086-目录写入档位投影与只读查询2026-10-17-源码实现)，物理边界归[数据库 §101](../database/physical-design-postgresql.md#101-0112-本地目录完全访问档位2026-10-18-源码实现)，场景归[测试计划 §17.1.3/§17.1.4](../testing/verification-plan.md#1713-本目录写入档位2026-10-17)，取舍接续归 [ADR-016](../decisions/ADR-016-folder-first-conversation.md)；准入一致性口径补记在[工具适配器 §1.2](../architecture/tool-adapters.md)。

## 普通聊天文件增删改与方法 MODIFY 接续（2026-10-18）

用户反馈「relay 好像还没有增删改的能力」；确认范围是**对话 Agent 对绑定目录内文件执行 CREATE / MODIFY / DELETE**。本轮按已批准计划闭环整改，**未 commit/push**，成绩只归验收表「普通 Agent 文件 CRUD 接续」行；权限语义未变。

- **写提示词**：Run 写分支此前明确写「删除不在授权内」，与工具 schema 和 Gateway 能力冲突，真实模型因此不会请求删除。现允许三种动作；MODIFY/DELETE 必须先 `read_file` 并带真实 `sha256` 基线，CREATE 目标必须不存在，删除只在任务明确要求时提出，ASK/AUTO 不豁免、FULL 由系统判定，禁止以清空/覆盖/改名绕过确认；只读分支未动。`DRAFT_WRITE_TOOLS` 模板版本抬到 `1.0.2`。
- **方法 MODIFY**：此前「修好 / 改一下 / 更新文档」即使命中方法也只给只读方案。现本轮有真实读取工具时，方法提示词在冻结说明之后输出与主循环一致的执行信封（只声明路径与动作，不写正文）；`METHOD` 路由新增 `readTools` 并抬到 `1.0.1`。主流程记录候选时保留 `execution_method`；`INSPECT`、空行动与无工具轮仍只读，写候选被收口为 `CLARIFY`，零 Task/Run。
- **可见性**：执行摘要在确认前显示「新建 / 修改 / 删除 · 相对路径」，含 DELETE 时说明仍需 Run 内动作审批；聊天摘要的「N 项等待你批准」带审批入口，按 `operation_id` 匹配 `OPEN` 的 `ACTION_APPROVAL` 直达原 Review，无精确匹配或读取失败时回退到过滤页。
- **主流程输出协议（用户实机截图回归）**：模型在信封前多写一句结论时，旧解析按「整段必须是 JSON」把原文当正文落库，聊天直接显示 JSON、候选同时丢失。现允许 ≤400 字前言与代码框包裹的信封（仍须单个完整 JSON 对象，候选校验不变）；残缺信封优先救回 `reply`，否则保留前言或给出可读失败说明，绝不再把 JSON 原文当回复。执行候选与状态维护共用同一解析入口。

**实际验证**：API typecheck 通过；定向提示词单测 **28/29**（唯一红为 HEAD 既有的 DISCUSS 文案断言，未修他人红灯）；`folder-first-conversation` 真实临时 PG/HTTP/磁盘 **20/20**；核心回归 `tool-loop` **45/45**、`agent-conversation-main-loop` **8/8**、`real-tools-gateway` **55/55**、`agent-main-loop-execution` **17/17**、`gateway` **30/30**；Workbench 定向 **15/15**，scoped typecheck 通过（全量 typecheck 仍被并行未提交文件的类型错误阻塞，未修）。真实 Provider 的 DELETE 批准/拒绝用例已写入 `real-model-tool-loop.integration.test.ts`，因未配置 `RELAY_MODEL_*` 本轮 **5 例全部 skip、0 运行、未验**。2026-10-18 用户实机截图已暴露上述解析缺陷；修复后 `conversation-execution` 单测 **15/15**（新增 3 例）、`folder-first-conversation` 复跑 **20/20**。截图会话目录为只读，重发前须切到请求批准或更高档位；活动桌面仍运行 2026-10-17 暂存 API，本次修复与当日提示词变更均未载入，需关闭应用后 `-RefreshApi` 重启再验。真实 Windows/WebView2 写操作（含 DELETE 批准/拒绝与方法 MODIFY）与真实 Provider 仍未验；不得以脚本化模型、HTTP 或组件测试替代。

## 真实扩展复验：桌面端临时端口让桥接文件写成 0（2026-10-18）

用户装好扩展后，本轮做真实链路复验，暴露一个**卡住桌面端浏览器能力**的缺陷：桌面模式给 API 的请求端口是 0（临时端口），而 `ensureBridgeRegistration` 在 listen 之前执行，`bridge.json` 因此写成 `"port": 0`；Worker 的 `ExtensionBridgeProvider` 读这个端口去 POST 命令，`127.0.0.1:0` 永远失败——扩展连得上也没用，所有 `browser_*` 动作都会落到 `BROWSER_BACKEND_DISCONNECTED`。本机两份数据根实测都是 0。已修：`listen` 之后用**实际绑定端口**重写桥接文件（`syncBridgePort`，沿用原令牌），`api_listening` 报实际端口；单测 **36/36**（浏览器四套件）。

**同一次复验暴露的第二层未决问题**：扩展只认 `chrome.storage.local` 里的 `serverUrl`，而桌面端口每次启动都变（本机存的是上一次的 `127.0.0.1:4672`）。要让日常 Chrome 重启后仍可用，只能在「固定桥接端口（冲突回退）」与「固定端口单开桥接监听」之间选一个，两者都改变 ADR-025 的「单端口 + 手动配对」前提，本轮未单方面选，等用户决定。

另：本机已加载的扩展副本仍是旧 manifest（`granted_permissions` 只有 `debugger/storage/tabs`，没有本轮新增的 `alarms`），需要在 `chrome://extensions` 点一次「重新加载」才会用上新代码——这也是空闲保活无法在真实浏览器里生效的原因。

## 三插件第三轮：浏览器三处静默失效、电脑滚动报实际位移（2026-10-18）

用户下达「继续修复缺陷或者开发」。本轮继续按「承诺 vs 实现」对表，改的都是**结果与实际不一致**的地方，均未 commit；成绩只归验收表两行。

- **浏览器（Provider／适配层）**：① `browser_list_pages` 的 `truncated` 是死字段——Provider 先 `slice(0, MAX_PAGES)`，适配层再判「长度是否超上限」永远不成立；截断改为只在适配层做一次，`count` 保留真实总数。② `registration()` 把 `null` 也缓存，「桥接文件还没落盘」被固化成「永远没有桥接」，只能重启进程；改为只缓存成功结果、`dispose()` 清缓存。③ `browser_read_page` 承诺返回「加载状态」却没有该字段；扩展新增 `readyStateOf()`（CDP `Runtime.evaluate('document.readyState')`，取不到给 `null`），`BrowserSnapshot` 增加必填 `readyState`，适配层输出 `ready_state`。规则归[浏览器自动化 §14.5](../architecture/browser-automation-v1.md#145-两处静默失效的修复2026-10-18)，四套件 **35/35**。
- **电脑**：`computer.scroll` 把请求值写回结果（发 200 读到 200），而系统只接受整格（120），另一轴不足一格还会被静默丢掉。新增 `wheel_notches`／`WHEEL_NOTCH` 统一换算，结果报**实际**位移并在不同时带 `requested_delta_*`；任一轴非零但不足一格即 `INVALID_REQUEST`。`cargo test` **20/20**。

**仍未闭合**：真实日常 Chrome 的空闲保活／多标签页截断／页面 `loading` 态（需用户手动装扩展）、真实桌面指针与滚动（本机桌面会话阻塞）、`GITHUB_ISSUE_VIEW` 的真实已认证会话与真实 PG 集成、官方 Skill 登记/注入与最终安装态、GitHub 写动作（ADR-023 要求先冻结协议）。并行在途提示：`apps/api/src/application/zoned-time.ts` 曾一度未完成导致 `tsc` 全量编译失败（`noEmitOnError: true` 时 dist 不产出），已由该实例修复，本轮未触碰。

## 三插件第二轮：扩展空闲保活、电脑描述对齐、GitHub issue 详情（2026-10-18）

用户下达「继续开发 github、浏览器操控、电脑操控这三个插件」。本轮按上一节「仍未闭合」逐条筛出**不依赖用户操作或桌面会话**的三处，均为**未 commit**；成绩只归验收表三行。

- **浏览器（默认 extension 路线）**：`background.js` 末尾那句「service worker 被 Chrome 回收后由 WS 重连唤醒」不成立——被终止的 worker 连同 `onclose` 的退避定时器一起消失，`chrome.runtime.onStartup` 只在浏览器启动时触发。§14.3 的服务端 20 秒 `keepalive` 帧只覆盖「连接仍在」，管不到「连接已断且 worker 已回收」。补 `alarms` 权限 + 30 秒周期闹钟 `relay.keepalive`，`onAlarm` 走 `reconnectIfDown()`（`OPEN`/`CONNECTING` 不动，避免握手期插出第二条连接）。规则归[浏览器自动化 §14.4](../architecture/browser-automation-v1.md#144-空闲保活兜底chromealarms2026-10-18)，定向 **14/14**。
- **电脑**：`computer_type` 的定义自相矛盾——描述写「缺省 15ms、需要约 10ms 以上间隔」，参数说明写「缺省 30」，运行时 `DEFAULT_TYPE_DELAY_MS` 是 30（实测 20ms 确定性损坏、30/50ms 干净）。模型按描述排时序，已按运行时事实改写描述，并加一例**跨语言常量比对**（直接读 `input.rs`）防止三处再漂移。
- **GitHub**：补第五个只读动作 `GITHUB_ISSUE_VIEW`（`gh issue view <n> --repo <slug> --json …,comments`），补齐「能列不能读」。仍属 `GITHUB_READ`：无新能力、无迁移、无权限分支；正文 8 KiB、评论 10 条 × 2 KiB，剪裁由 `body_truncated`/`comments_total`/`comments_truncated` 显式说出。规则归[工具适配器 §4.1](../architecture/tool-adapters.md#41-github-只读查询01032026-10-17-开发自检)。

**仍未闭合（与上一节合并看）**：真实日常 Chrome 的空闲保活与登录态复用（需用户手动装扩展，Chrome 155 已忽略 `--load-extension`）、真实桌面指针移动（本机 `GetCursorPos` 拒绝访问）、`GITHUB_ISSUE_VIEW` 的真实已认证会话与真实 PG 集成（`github-read.integration.test.ts` 的逐动作列表仍是四个，本轮未改也未跑）、官方 Skill 登记/注入与最终安装态、GitHub 写动作（ADR-023 要求先冻结协议）。全量单测本机 **844 例 / 822 通过 / 21 失败 / 1 跳过**，失败全部落在 sealed-loader（15）、`conversation-prompts`（2）、`git-adapter`（1）、`file-io` 删除语义（1）、provider guard（1）等与本片无关项；本轮未修他人红灯。

## 新会话的默认工作目录：方案与任务书落盘，未实施（2026-10-18）

用户下达「新会话未选择目录的时候应该在默认目录工作，这个默认目录是可以用户配置的，上游中应该有」，随后按推荐选定两档：**本轮只落文档与任务书**；**默认目录没有本目录档位事实时按只读兜底**。本轮**未写产品代码、未新增迁移、未 commit/push**。

- **上游核实结果（判断成立一半）**：五个缓存仓库都保证 Agent 有确切 cwd，因此 Relay 现在的「没目录→以 `AGENT_SESSION_HAS_NO_WORKING_DIRECTORY` 拒本次读取、对话照常」在上游没有对应物；但只有 DeepSeek Harness 把它做成可配置项并与写边界闭合（`sandbox.workspaceRoot`，`mode` 默认 `read-only`）。ZCode 给非项目对话准备应用托管共享目录 `~/.zcode/workspace/default` 且越界**钳制**回根；Codex/OpenCode/Pi 的兜底都是**进程 cwd**——本项目不采纳，因为 API/Worker 的进程目录是安装目录而非用户内容，照搬会显示一个用户从未选择的目录。证据与缺口归[研究 §1.8](../research/p00-source-study.md#18-未选目录时的默认工作目录机制对照2026-10-18)。
- **采用的最小形态**：Workspace 级一条显式配置的默认目录，经既有 `OpenWorkingDirectory` 登记（因而连带其 Project 与 `local_directory_access` 档位），新会话在 `CreateAssistSession` **同一短事务**内继承并持久作用域来源；读取链不加兜底推断，缺目录仍按原类型化原因拒绝。不变量归[契约 01 §5](../../contracts/01-facts-and-ownership.md#5-projectgoal-与-inbox)，产品规则归[工作台 §18.1.5](../frontend/workbench-design.md#1815-未选目录时的默认工作目录2026-10-18已确认未实施)，责任与持久化归[运行架构 §2.8](../architecture/runtime-context.md#28-新会话的默认工作目录作用域2026-10-18已确认待实施)，场景归[测试计划 §17.1.5](../testing/verification-plan.md#1715-未选目录时的默认工作目录2026-10-18已确认未实施)，切片与停点归[任务书](../../prompts/default-working-directory.md)。
- **必须正面处理的既有口径**：契约 01 §5 禁的是「让模型猜默认目录」，用户配置属已确认事实，因此新增四条不变量把「默认作用域须持久可追溯、来源须在界面可见、失效须回落为没有默认目录」写死；`managed_resources.project_id NOT NULL` 决定默认目录必然连带一个 Project，故继承后新会话不再是工作空间级会话，空态说明句与 §18.1 表格随之收敛，但不删「不需要先创建项目、任务」的既有承诺。
- **接续约束**：本任务书与在途[本地目录交付链整改](../../prompts/remediation/local-directory-delivery-20261018.md)改同一批文件（`assist-commands.ts`、`assistant-readonly-round.ts`、`open-working-directory.ts`、`CollaborationView.tsx`、`AssistView.tsx`、工作台与本文件）。开工前按任务书第 3 节核对该片是否收口；未收口时只推进不重叠的迁移 `0111`、`Set/ClearWorkspaceDefaultDirectory` 与设置页三片。
- **本轮文档影响与未验范围**：实际迁移、命令、UI 与测试全部未动，功能验收表不记成绩；`node scripts/check-docs.mjs` 只证明链接与结构，不代表任何默认目录能力可运行。**迁移号需按当前占用重排**：任务书里的计划值 `0111` 已被会话活动排序键占用，`0112`（完全访问档位）与 `0113`（会话 fork）亦被并行工作占用，当前下一个空闲为 `0114`。

## 三插件接续：电脑补 move、浏览器补历史/双击/快照、GitHub 补 gh 解析与真实 argv（2026-10-18）

用户下达「继续开发 github、操控电脑、操控浏览器这三个插件，上游有源码可借鉴」。本轮按「工具承诺 vs 默认路线实际实现」逐条对表，改了四处只读代码就能看见的矛盾，均**未 commit**，成绩只归验收表三行。

- **电脑**：`computer_scroll` 的描述要求"先移动鼠标到目标区域"，但词表/适配器/运行时都没有移动动作。新增 `COMPUTER_MOVE` → `computer.move`（Rust `input::move_mouse` 早已存在，只是没进 `protocol::METHODS`），计入前台输入九项。`cargo test` 19/19、TS 定向 41/41。
- **浏览器（默认 extension 路线）**：`chrome.debugger.onEvent` 监听签名写错（`(message, sender)` → 真实是 `(source, method, params)`，导致每次导航等满 30 秒）、快照只遍历嵌套 `node.nodes` 而真实 CDP 是扁平 `childIds`（只能渲染根节点）、`history`/`double` 被 Provider 直接拒绝、截图无尺寸与摘要。四处均已修，新增扩展命令层测试 8/8（VM 跑真实 `background.js`）。规则归[浏览器自动化 §14.1](../architecture/browser-automation-v1.md#141-扩展命令层补齐2026-10-18)。
- **GitHub**：`gh` 只按 `PATH` 找（本机解包了 gh 2.102.0 却查不到），且 `GITHUB_REPO_VIEW` 用 `gh repo view --repo`——真实 gh 判 `unknown flag`，仓库是位置参数。补三级解析链（`RELAY_GH_PATH` → 随包 `gh.exe` → `PATH`）并改正 argv；真实探针从 `GH_ERROR` 变为 `GH_UNAUTHENTICATED`。

**仍未闭合**：真实桌面指针移动（本机 `GetCursorPos` 拒绝访问，桌面会话阻塞）、真实 Chrome 扩展（需用户手动加载并配对，Chrome 155 已忽略 `--load-extension`）、官方 Skill 登记/注入及最终安装态（真实已认证四只读复验已通过，详见验收表）、官方 Skill 注入与登记、GitHub 写动作。全量单测本机 **818 例 / 780 通过 / 37 失败 / 1 跳过**，失败集中在 sealed-loader、备份包、restore 隔离、prompt 与 git 适配器等并行在途或环境依赖项；已用改动前的旧 `dist` 复跑 `conversation-prompts`、`free-call-guard`、`git-adapter` 确认同样红，本轮未修他人红灯。

## 内置浏览器自动化（F26）：扩展桥接已实施，默认路线验收未通过（2026-10-18）

**当前结论（2026-10-18 复验）**：默认路线仍按 ADR-025：用户现有 Chrome＋MV3 扩展＋配对令牌。已修复连接路径、hello 令牌、丢失响应的 UNKNOWN 与 ignored/none 包装节点漏掉后代；真实隔离 Chromium 加载实际扩展后，配对、后台建页、读/填写/点击/截图/导航、拒绝用户页、关闭自有页、断线重连均通过。插件定向单测 108/108；真实已认证 GitHub 四只读动作经会话/Gateway/账本通过；电脑真实 Gateway→Runtime 记事本输入及 PG 停止状态通过。全量 API 编译已恢复，构建夹具兼容回归 7/7，目录包第三次构建被并行 Workbench 临时测试的未使用变量阻塞，尚未通过；包含 runtime/extension/gh Skill 原文的打包规则不能当作包已验收。**剩余出口**：日常 Chrome 的空闲保活/登录态复用（手动安装、配对和后台页动作已通过）、跨 Run 桌面全局输入互斥、真实 Overlay/Esc→Worker 停止、官方 Skill 登记与运行时注入、最终安装态；不能标三插件整体通过。成绩和限制唯一归[统一功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)；用户路径归[工作台 §36](../frontend/workbench-design.md#36-电脑浏览器与-github-能力的日常使用2026-10-18)。下文 CDP 旧成绩不替代当前默认路线。

### 历史回顾（2026-10-17，ADR-024 自有 Chrome/CDP 路线，现为非默认）

用户下达「为 Relay 桌面端增加内置 Chrome 浏览器操控能力」，并明确要求**先做架构审查、不要直接写代码**。本轮只做只读审查与选型，**未写产品源码、未新增迁移、未引入随包资源、未建动作词表、未 commit/push**；工作树审查前后均为干净（`main` @ `390d92f1`），迁移序号停在 `0104`。

**审查结论（依据源码，非文档转述）**：桌面为 Tauri `2.11.6` + React `19.3.0`；模型工具循环**全部在 Worker 进程**（`worker/main.ts` 同进程跑 Run 命令与 `runAssistGenerationTick`）；工具是 `workflow/tool-catalog.ts` 的冻结词表；权限是「能力→连接→策略→单动作 Review/本次任务范围授权」四段，`SCOPE_GRANT_ACTIONS` 是闭集；`apps/api/src`、`apps/workbench/src`、`apps/desktop/src-tauri/src` 中 **MCP 命中数为 0——仓库没有 MCP 运行时**；既有 `COMPUTER_*` 是 SendInput/GDI 的桌面 GUI 自动化，`execution-router` 的 `browser_cdp` 只是占位优先级位（Rust 侧 `not_configured`）；打包走 `build-release.ps1`（`pnpm deploy --prod` + 逐项清单校验），`tauri.conf.json` 只随包 node.exe/helper/api，**computer-runtime 尚未随包**。另发现既有缺口：前端 `RelayGatewayCapability` 只有 9 项，**缺 `COMPUTER_READ`/`COMPUTER_INPUT`/`GITHUB_READ`**，`ConnectionsView` 能力表同为硬编码 9 项。

**选型**：`chrome-devtools-mcp` `1.11.0`（Apache-2.0、Google 维护、`node >=23` 由随包 `v24.21.0` 满足、发布物自包含无运行时依赖、14 MB/370 文件、59 工具、`--pageIdRouting` 默认开启）；**由 Relay 拉起自有 Chrome**（独立 profile + `--remote-debugging-port=0`，读 `DevToolsActivePort` 取端口）→ MCP 以 `--browserUrl` 附着；新增**最小 MCP stdio 客户端**（不引官方 SDK）；浏览器为**独立能力族** `BROWSER_READ`/`BROWSER_ACTION`/`BROWSER_COMMIT` + 12 个 `browser_*` 工具，**不并入 `COMPUTER_*`**；`chrome-use` 的扩展+native messaging 路径 V1 不接入（改用户 Chrome、驱动真实标签页、标签组不能当隔离）。

**待用户拍板（开工前）**：① **D1 会话内是否允许浏览器动作**——现状 `ASSISTANT_READ`/`AGENT_SESSION_READ` 只放行只读能力，建议 V1 保持（chat 只读、动作走 Run），否则属于新增会话写身份的另一项架构变更；② **D2 是否复用用户已登录 Chrome**——建议 V1 不做；③ **D3 是否每 Run 独立 profile**——建议不进 V1。

**历史下一步（已被 ADR-025 取代）**：按[浏览器自动化 V1 第 10 节](../architecture/browser-automation-v1.md#10-分阶段实施计划每阶段有明确出口不跨阶段预建)的 M1→M6 推进；该方案属于 ADR-024 自有 Chrome/CDP 路线。原审查文档和测试规格保留历史，不代表当前默认路线。

### CDP M1 已实施：后端骨架与真实链路（2026-10-17，现为非默认路线）

用户确认开工，D1–D3 按建议默认执行（会话只读、不复用用户登录态、不做每 Run 独立 profile）。M1 已落地，**未 commit/push**：

- **能力与词表**：迁移 `0105` 登记 `BROWSER_READ`/`BROWSER_ACTION`/`BROWSER_COMMIT` 并逐条重述 `logical_operations` 的 origin×resource CHECK；12 个 `browser_*` 工具进冻结词表；`ADAPTER_DESCRIPTORS`、`capabilityFor`、`targetMatches` 的 `browser://<origin>` 分支、`normalizedBrowserTarget`、`SCOPE_GRANT_ACTIONS`（**只加 `BROWSER_ACTION`**，`BROWSER_COMMIT` 故意不入表）、委托信封能力、会话只读词表与目标全部接线。
- **新增 `apps/api/src/browser/`**：最小 MCP stdio 客户端（initialize/tools/list/tools/call/cancelled，无 SDK 依赖）、Chrome 启动器（独立 profile + `--remote-debugging-port=0` + 读 `DevToolsActivePort` + taskkill 兜底）、`McpBrowserProvider`（冻结映射 + 启动自检）、`BrowserSessionManager`（页面所有权/缺省页/页级互斥/STALE/取消→UNKNOWN）、`browser-adapter`（参数白名单、目标核对、上传路径根内解析）。
- **实测推翻三条按文档写的假设**（已写回主设计 §4.2.1）：上游 `pageId` 是 **number 且必填**；`new_page` 返回页面列表而非新 id；`navigate_page` 把失败写进正文；另外 `includeSnapshot` 在导航提交前取样，动作后改为重读并等页面稳定。
- **已运行**：`tsc --noEmit` 与 `tsc -p` exit 0；浏览器单测 **23/23**；`tool-loop` 词表封闭性更新后与 `restore-isolation` 合计 **50/50**；真实链路冒烟（真实 Chrome `155.0.8059.40` + 后端 `1.11.0`，`output/acceptance-raw/browser-f26-m1-20261017/smoke.log`）走通「就绪→建页→快照→填写→错误 uid→截图→提交后拿到新页面→后退→file:// 被拒→关闭→dispose」；`scripts/fetch-browser-mcp.mjs --verify` 的 sha512 与 registry `integrity` 逐字一致。
- **全量单测基线对比**：789 例中 8 例红，1 例是本次词表断言（已更新转绿），其余 7 例经 `git stash` 基线复跑确认为既有失败（`conversation-prompts`、`file-changeset`、`file-write-frozen-diff`、`free-call-guard`、`git-adapter` 各 1，`restore-isolation` 2 例为全量并发下的抖动，单跑 7/7）。**注意**：基线对比时 `git stash -u` 误收了并行实例未提交的前端改动，已从 `stash@{0}` 逐文件恢复（`AssistView.tsx`/`.css`/`composerAttachMenu.spec.tsx` 已还原；`docs/frontend/workbench-design.md` 以并行实例的更新版本为准未覆盖）；`stash@{0}` 暂未丢弃，作为该实例 `workbench-design.md` 快照的保险。
- **M1 未做**：`browser_sessions` 状态表与风险分类器（M3，迁移 `0106`）、`/browser/*` HTTP（M2）、UI（M5）、随包资源与 `lib.rs` 注入（M6）。**F26 仍为未验收**；真实 Windows 窗口、安装态、多任务真实 PG 链路、用户接管实测都还没有证据。

**历史下一步（已过期）**：M2（读工具端到端 + `GET /browser/status`），随后 M3 的动作与权限；以上是切换默认路线前的 CDP 实施计划。

### CDP M2 已实施：读能力过完整 Gateway + 跨进程健康投影（2026-10-17，现为非默认路线）

- **迁移 `0106`**：单行表 `browser_backend_state`（Worker 实测的后端健康结论；与 `0096` 同理由——三个进程只共享 PG，但基数不同：后端是安装级资源，单行正是真实基数）。**显式 `GRANT SELECT, INSERT, UPDATE` 给 `relay_app`、无 DELETE**；顺带记录既有缺口：`0096` 的 `computer_control_state` 建表时没授 `relay_app`，若应用角色不是表所有者，`GET /computer/control-session` 会在运行期报权限错误（未修，不在本片范围）。
- **`GET /workspaces/{id}/browser/status`**：`Cache-Control: no-store`；URL 保留工作区段只因全站路由前缀，处理器不读它——健康结论是安装级诊断，不是工作区业务数据。API 进程**不会**为回答它去启动自己的浏览器实例（那会变成两个 Chrome）。
- **实测修正第二处设计**：目标合成值改为**主机形式** `browser://example.com` / `browser://127.0.0.1:5155`，`browser://` 单独作「全部站点」前缀（策略创建要求前缀非空），`browser://unknown` 表示站点未知。原 `browser://https://…`（协议塞进 scheme）被自己的目标归一拒绝——集成测试第一次跑就撞上，已修正并写回主设计 §13。
- **已运行**：浏览器单测 **25/25**；真实 PostgreSQL `browser-read.integration.test.ts` **6/6**（整体 PASSED，临时集群已删除）——BROWSER_READ 全链路成功 + 投影 READY、按站点收窄、非法目标 `GATEWAY_TARGET_DENIED`、后端不可用派发失败 + 投影 `CHROME_MISSING`、`BROWSER_ACTION` 无范围授权时 AUTO 降级 `WAITING_APPROVAL`、真实 API 进程经 HTTP 读同一行。日志 `output/acceptance-raw/browser-f26-m1-20261017/integration-browser-read-3.log`。
- **未做**：`GET /browser/sessions` 与 stop（M3，等 `browser_sessions` 表）、风险分类器（M3）、UI（M5）、随包与安装态（M6）。**F26 仍未验收**。

## 会话顶栏图标工具栏、会话目录图标与拖拽分隔条（2026-10-17）

用户 UI 指令已实施（未 commit/push）：①「工作详情」由带文字按钮改为纯图标开关——收起态 `PanelRightOpen`、展开态 `PanelRightClose`，32×32 命中区、18px 图标，收起透明、悬停浅底、展开落选中底色；`title`／`aria-label` 随状态切换「展开工作详情／收起工作详情」，`aria-expanded`／`aria-controls`、点击处理与焦点返回保留，会话顶栏与任务页头共用同一文案派生。②右翼相邻键一并收到同一档：「切换讨论」「新建会话」「任务视图」全部只留图标，四键同高 32×32、图标 18px、间距 `space.2`、悬停/展开/禁用同套状态，`title`／`aria-label` 保留完整中文名称，工作详情固定最后；三颗作用域键的显示条件与点击语义未动。会话顶栏**未新增「更多」**：没有明确的低频动作可收，任务/项目/运行低频入口已在任务 PageHeader 既有「更多操作」菜单，关键状态也不折进浮层。③会话目录由「会话目录：路径末段」文字改为 `Folder` 图标，完整路径进入悬停提示与可访问名称，未绑定目录时降 muted；关联目标仍保留文字。④全局 `.drag-separator`（侧栏手柄与协作分栏条共用）的线由 `border.control` 实色调浅为 55% 混合色，悬停/键盘聚焦/拖拽三态同色同宽，指针移出命中区也不再消失。零新增 token／色值。

**实际证据**：workbench `tsc --noEmit` exit 0；`conversationToolbarDensity.spec.ts` **9/9**（四键顺序/纯图标/32×32/18px/可访问名称/逐键悬停底色/键盘焦点环/详情固定最后；任务页头 `aria-expanded` 与文案翻转；900×800 四键不重叠且无横向溢出），同行 `recentWorkRailDensity`＋`frontendAcceptance`＋`inspectorPreviewLayout`＋`emptyConversationWelcome`＋`narrowWindowNewConversation` 共 **46/46**；分隔条用例锁静止透明、悬停半透明、拖拽与悬停逐值相同且移出命中区仍保持。截图 `results/conversation-toolbar-icons-wide.png`、`conversation-toolbar-icons-narrow.png`、`work-details-icon-task-header.png` 已逐张核对。定向 jsdom 182/190，8 条红全部落在他人并行改动的 `assist-flow` 与 `collaborationWorkspace` 工具轨迹/执行摘要段（只报不修）。文档同步[设计系统 §6.3／§9.13](../frontend/design-system.md#63-全局滚动条与拖拽分隔条2026-10-17)与[工作台 §28.8](../frontend/workbench-design.md#288-v42-工作详情与成果预览接续2026-10-15)，成绩归验收表相应行。

**未闭合**：真实 Windows/WebView2 窗口、多 DPI 与安装态未复验；dist 未重建，桌面生产包仍是上一版；共享工作树中他人未提交改动未触碰。

## 对话输入器「本目录写入档位」：芯片与只读投影（2026-10-17）

用户要求输入器增加与通用 Agent 同形、语义按本项目改写的权限档位入口。已实现（未 commit/push）：首条与会话输入器「+」右侧的紧凑芯片，三档为「每次确认／本次任务自动／不开放写入」，**没有「完全访问」**——V1 不提供始终允许，删除不在范围授权动作里，`DENY` 不被批准或范围授权覆盖。档位只读服务端投影，最严格优先排序与准入共用 `rankActivePolicies`；命中上层受管根时只读显示并指向「连接与权限」；改档沿既有创建/加版本（带 `expected_revision`）/撤销命令，回执后重读投影，丢响应保留原 `command_id`。服务端新增只读 `GET …/managed-resources/{id}/write-readiness`，与打开目录共用同一投影函数。

**实际证据**：workbench `tsc --noEmit` exit0、`writePermissionTier.spec.tsx` **8/8**（含未绑定态常驻、菜单短文案长度守卫、旧版 API 404 降级）、首条输入相关 4 套件 **84/84**、`folderFirstConversation`＋`assistBinding` **31/31**；真实 Chromium＋dev server＋路由伪造 live API 中未选目录即显示「未选择目录」芯片；真实 PG 长链路投影断言通过（AUTO 下 READY＋条目坐标，同目录再压 ASK 后变 ASK）。用户实机截图指出「未选择目录」时芯片消失，已按 §18.1.3「常驻」改为未绑定态（未选择目录／未归入项目／未绑定目录，三档禁用且零查询）；截图中 404 已核对为桌面暂存 API（10-16）缺该路由，需 `-RefreshApi` 后复验，非源码缺失；菜单同时按「一大堆字」反馈压缩为每档一行。`folder-first-conversation` 集成套件整体仍为红，仅两例既有失败（任务创建 422 `title/objective` 控制字符；越界读取用例的驱动器断言 `SUCCEEDED` 与自身「允许非 SETTLED」矛盾），与本片无关，按共享工作树规则只报不修。新 GET 尚无独立 HTTP 集成用例。

**未闭合**：真实 API＋浏览器闭环、真实 Windows/WebView2、多 DPI/IME 与安装态；若用桌面 dev 窗口查看，需按既有流程 `-RefreshApi` 重新暂存 API。规则归[工作台 §18.1.3](../frontend/workbench-design.md#1813-输入器的本目录写入档位2026-10-17)，服务面归[HTTP §10.86](../api/http-command-contract.md#1086-目录写入档位投影与只读查询2026-10-17-源码实现)，场景归[测试计划 §17.1.3](../testing/verification-plan.md#1713-本目录写入档位2026-10-17)，成绩归验收表新行。

## 三项 opencode 在途任务收口：模型下拉、点击后界面、会话 diff（2026-10-17）

用户要求把 opencode 侧三个未完成任务「都在你这里继续」并「派三个子智能体并行执行」。**未 commit、未 push**，成绩只归统一验收表。

- **模型选择器：居中弹窗→锚定下拉**。用户参考图指令「直接一个下拉框就可以了，不需要一个弹窗……不需要倍率，只需要名字」：`ModelSelector.tsx` 重写为 `aria-haspopup="listbox"` 触发键＋向上锚定弹层，删除确认键与 `applyOnSelect`，首条与会话两种入口都点选即应用并收起，条目可见文本只有模型名（细节留 `title`），外部点击／Esc 收起并回焦、刷新中不收。规则与两轮指令归[工作台 §27.5](../frontend/workbench-design.md)，视觉归[设计系统 §9.16](../frontend/design-system.md)，成绩与真实 API 闭环归验收表「免费模型生产链」行。
- **点击后界面 CT-01／CT-02**：遮罩吃掉面板点击的缺陷与「资料／生成方式」职责分离＋面板限高与状态保持已修，定向浏览器规格 `inspectorPreviewLayout` 9/9、`composerSourcePanel` 5/5。
- **会话局部与总 diff W1–W3**：后端 `conversation-diff/` 模块＋会话只读端点＋迁移 `0097`/`0102`，前端两处位置（逐编辑局部行、输入卡外上方总数）与同源派生／有界轮询落地；本轮把三条断言对齐到[工作台 §34.4](../frontend/workbench-design.md#34-会话局部与总-diff) 已写的规则（过去时动词跟随账本动作、「部分不可统计」是入口级标记、保留可信值时不在面板里重复一条失败），并把这三条补写回 §34.4——不是改产品代码迁就测试。**W4 未闭合**：`apps/api/test/integration` 没有任何 conversation-diff 套件，真实 PG＋一次性 Git 仓库、真实 HTTP 失权、真实 Provider 分块工具流、真实 Windows 窗口都欠取证；[任务书](../../prompts/conversation-live-diff.md)状态行与工作台 §34 状态行同步为「W1–W3 已实施、W4 未闭合」。
- **共享工作树现状**（本轮实测）：`apps/api` 编译到临时 outDir exit 0、5 个 conversation-diff 单元文件 52/52；workbench `tsc --noEmit` exit 0、全量 `vitest run` **122/132 文件通过**、真实 Chromium 浏览器全量 **157/157 通过**，10 个失败文件全部在本专项之外（他人在途的 `assist-flow`/`assist-preview`/`collaborationWorkspace`/`firstPartySkills`/`run-events`/`createTaskProjectPicker`、需本机 8787 API 的 `live*`、他人新增 `components/ComposerDraftAssist.css:75` 旧式 `max-width: 48rem` 引起的 `responsiveTiers`）；`folderFirstConversation` 单跑 19/19、`collaborationWorkspace` 单跑 4 failed/73 passed。他人红灯按约束只报不修。

**下一步（待用户定，不自动开工）**：① W4 先补 conversation-diff 的真实 PG／一次性 Git 集成套件再谈验收；② 真实 Windows/WebView2 窗口核对下拉观感、CT-01/CT-02 与两处 diff 位置；③ 图片附件前端 T5–T8 仍等并行热文件安静后接线。

## 按日常使用顺序接续后端（2026-10-17，基础链路已闭合）

用户继续授权后端开发，沿用 GPT-6 Luna 实施、主 Agent 独立验收，并要求详细任务书、按首次/高频使用排序、以链路打通为停止条件。[日常后端任务书](../../prompts/daily-backend-chains.md)的三段现已闭合：① 目标编辑/归档与项目改名；② 先记下尚无验收条件的 Inbox 原任务，再首次归入项目，保留身份/验收/讨论；③ 经原入口补齐验收、就绪/开始→成果固定版本→人工接受/完成→重开→项目/今日再次接续。精确新增接口分别归[基础维护](../api/project-goal-maintenance.md)与[首次归属](../api/task-project-binding.md)。主 Agent已审查并独立重新编译、运行串行真实链路，实际成绩只归统一验收表。未新建迁移、前端接线或替代 Task/Run/完成 Owner；共享回执映射与 Task 会话创建的共享锁由主 Agent定点接线，不覆盖模型/工具主循环在途段落。首次编译曾被会话控制文件的缺失类型/组装函数阻挡；用户明确确认该部分修改结束并授权补齐后，仅恢复缺失声明和既有结果组装，未扩展会话控制入口。当前停止于这条基础日常后端链路已通；后续页面消费、任意跨 Project 迁移、真实 Agent/模型及桌面交付仍须按各自专项范围接续，不由本片成绩自动放行。

## 目标与普通工作区：后端基础工作上下文（2026-10-17）

用户授权先区分目标与普通工作区，只开发后端、避开并行改动，由 **GPT-6 Luna** 实施、主 Agent 验收。[执行任务书](../../prompts/goal-directory-backend.md)已实际派发；按用户追加要求补成六步说明，固定文件所有权、响应形状、SQL 作用域、原命令链路及检查出口。现已新增 Goal/目录两个只读 `work-context` 入口：Goal 沿当前显式 Goal–Project 关联汇集项目、目录和非 Task 会话，普通目录仅汇集精确绑定自身的会话；同一会话始终保持原 ID，无关联 Goal 的目录正常可读。未新增领域事实、迁移、权限或前端接线；现有源文件只在原本干净的 `project-api.ts` 增加导入及注册，未编辑在途模型、会话执行、目录打开和前端热文件。接口边界归 [API 补充](../api/goal-directory-work-context.md)，基础链路成绩归统一验收表。后端本片已完成；后续如需页面消费此能力，应待前端热文件可协调后单独接线，本轮不自动推进。

## 内置 GitHub Skill 前移进 V1 主线：本轮仅范围决策与文档（2026-10-17）

用户在三条备选（保持在 post-V1 分支 / 只做只读切片 / 前移主线）中明确选择**移主线**，否决[后续路线第 4 节](../requirements/post-v1-roadmap.md#4-后续候选的处置)原有的后置处置。本轮**只写文档**：新建 [ADR-023](../decisions/ADR-023-builtin-github-skill.md)；[范围矩阵](../requirements/v1-scope.md#内置-github-skill-范围补充)新增 **F25** 行与其范围节；[扩展专题第 10 节](../architecture/relay-skills.md#10-内置官方-skill-包)定义官方包的定义落点/分发/激活/启用规则；后续路线该行处置改为「已前移」并保留原条件。**未写源码、未新增随包资源、未动动作词表或迁移、未派子代理、未 commit/push**；GitHub 能力未实施、未验收，验收表不新增成绩行。

已定边界一句概括：后端用官方 `gh` CLI 经既有受信 CLI 通路与可执行准入；上游 Skill 原文不改写、Relay 边界另置附录；登记落点用与内置方法同构的独立冻结表，不进参与备份包校验的第一方注册表；首片只读；本地暂存/提交/推送复用 `GIT_WRITE`，GitHub 侧写动作须先冻结 UNKNOWN 核对协议才可进入词表。

**对主线的挤压**（用户需在开工前据此定优先级，不是本次已排定的顺序）：

| 在途专项 | 冲突点 |
|---|---|
| 免费模型生产链剩余（阶段 A 契约、C-2b、阶段 D、自动目录生命周期、单模型额度有界接续） | Luna 与主 Agent 分工正在改 `tool-loop.ts`、`assist-runner.ts`、`openai-compatible-model-port.ts`、`database-schema.ts` 与 `apps/workbench/**`；GitHub 片的按需激活注入与 Skill 登记落在同一批会话/工具链文件 |
| ADR-019 剩余（BC-05 `SKILL.md` 定制、会话压缩、消息文件恢复、前端命令菜单接线） | 官方包若要落成文件形态必须等 BC-05；本轮改走独立登记正是为了不阻塞，代价是之后一次同规则迁移 |
| 内置方法→写执行链的闭合（本文件 2026-10-11 段的未闭合 ①） | GitHub 写动作直接依赖它；未闭合则写片不能开工，只读片不受影响 |
| 会话局部/总 diff（工作台 §34）、粘贴图片前端 T5–T8 | 与 GitHub 片同样落在 `AssistView`/composer 热文件；前两轮已因并行实例在途而主动待接线 |
| 迁移序号与共享文档 | 迁移已到 `0095`，`0093/0094/0095` 期间发生过分让；GitHub 片若需新表只能顺延，HTTP 契约/物理设计/验收表同为并行热文件 |

**下一步（待用户定，不自动开工）**：① 只读片排在免费模型剩余链路之前还是之后；② 若先做，按 [ADR-023 的后续](../decisions/ADR-023-builtin-github-skill.md#后续)先冻结「获准的只读子命令集合 + 同一受管根上的仓库身份核对」工程协议，再补 API/测试计划规格；③ 三项待确认仍未批准：是否随包 `gh.exe`（Sidecar）、GitHub 写动作片在主线队列中的位置、上游 Skill 的来源 SHA 与许可固定方式。

### F25 实施首轮（2026-10-17，用户下达「开始执行任务」）

执行通路核对推翻了 ADR 里的一条假设：**项目内不存在合法的只读外部 CLI 通路**——`CLI_RUN` 是写语义（默认 ASK、失败即隔离、核对恒 UNKNOWN），会话读取词表不放行它，且入口必须是在连接上点名的绝对路径文件、连接没有更新端点。据此按 `0092 COMPUTER_READ` 的先例改走**新增 `GITHUB_READ` 能力 + 专用只读 adapter**，偏离与四条源码依据已记入 [ADR-023 的实施前核对与偏离](../decisions/ADR-023-builtin-github-skill.md#实施前核对与偏离2026-10-17)，范围随之修正的是首片不再「零迁移」。**已完成**：官方 `gh` Skill 原文逐字写入工作区（`apps/api/skills/builtin/gh/SKILL.md`，331 行 / 20,279 bytes，SHA-256 `49e3798…f7caad`）+ MIT `LICENSE` + `UPSTREAM.md` 固定上游提交 `4537a92f3352c8c4c1fd1b8febba1596059fc9e0`、记「不改写正文、Relay 边界另置附录、正文的 7 处 `gh api` 是待约束命令面而非授权」。**未接线且如实标注**：`apps/api` 只做 `tsc` 构建、`files` 仅含 `dist/src`/`migrations`，官方文本既没进包也进不了运行时提示；`GITHUB_READ` 的能力登记表、迁移、adapter 与连接尚未写。**另需决策**：官方文本落成随包资源（要动暂存与 `bundle.resources`）还是逐字内嵌常量 + sha256 一致性测试。`check-docs` 通过；本轮未运行任何代码测试。（能力、迁移、adapter 与测试在同一轮接续完成，见下条。）

### F25 只读片实现与开发自检（2026-10-17，同一轮接续）

**已实现（未 commit/push）**：迁移 `0103_github_read.sql` 登记 `GITHUB_READ`（`REAL`/`READ`）并逐条重述资源 CHECK；`apps/api/src/github/github-adapter.ts` 走本地 `git` remote 身份闸门、结构化 argv、环境白名单、30 秒超时/取消、有界投影与类型化失败；四个只读动作进入工具目录与会话只读词表，按 ACTIVE 连接逐轮激活，Permission 按动作分别裁决；`gh api` 与模型自带仓库名都不在词表内。官方原文仍未进入打包或运行时提示，独立官方包登记仍未建。

**实际证据**：`github-read.test.ts` **16/16**；真实 PostgreSQL 集成 `github-read.integration.test.ts` **8/8**（含 `0103` 原始 INSERT 正反例、连接停用当轮收词、`GH_REPO_UNIDENTIFIED`、模型仓库名到不了适配器、`gh_api` 被拒且不落 Operation、逐动作 Permission、与 `FILE_READ` 共存）；受 CHECK 重述影响的既有套件回归 **85/85**（助手只读 6、人工 Git 15、真实工具 Gateway 54、迁移 10），退出码 0，临时集群正常删除。文档已同步：[工具适配器 §4.1](../architecture/tool-adapters.md#41-github-只读查询01032026-10-17-开发自检)、[扩展专题 §10](../architecture/relay-skills.md#10-内置官方-skill-包)、[ADR-023](../decisions/ADR-023-builtin-github-skill.md#首片实施记录2026-10-17开发自检)、[范围矩阵](../requirements/v1-scope.md#内置-github-skill-范围补充)、[测试计划 §35](../testing/verification-plan.md#35-内置-github-skill-只读片0103)、[物理设计 §93](../database/physical-design-postgresql.md#93-0103-github-只读能力2026-10-17-源码实现开发自检)与验收表新行。

**未闭合，不得当作已验收**：本机没有安装 `gh`，没有真实已认证读取、权限失败或限流证据；官方 Skill 未随包分发、未登记、未注入提示，内置项禁用设置未做；GitHub 侧写动作未开工；无真实 Windows 窗口与安装包验收。F25 整体仍未验收。**仍待用户拍板**：① 随包 `gh.exe`（Sidecar）进入时点；② GitHub 写动作片在主线队列中的位置；③ 上游来源与许可虽已按「固定提交 SHA + 保留 LICENSE」落库，该长期维护方式仍未获用户确认。

## 免费模型生产链与额度接续：Luna 实施及协调复验（2026-10-17）

用户明确要求先验收、编写提示词并由 **GPT-6 Luna** 子代理执行，持续修复到跑通。本轮实际派发 `gpt-6-luna`，不是仅交付任务书；[执行分工](../../prompts/free-model-catalog.md#2026-10-17-实际执行派发gpt-6-luna)定义执行者与协调者文件责任。基线已重新验收，0095 来源约束反例已转绿，成绩只归统一验收表。当前推进剩余 A/C-2b/D、自动目录生命周期和单模型额度有界接续，保留既有业务 Owner、原默认路径与并行改动；不因工作树未提交永久停在阶段 0，也不覆盖已确认同时写入的文件段落。

Luna 负责本专项后端源码/必要迁移/API与数据库契约和定向测试；主 Agent 接手前端选择器/client/首条发送接线与定向检查，并负责架构主文档、独立端到端验收和修复反馈。用户先选择完成受控 Provider HTTP＋真实 PG＋浏览器验收，随后提供独立 OpenRouter 凭据；协调者仅在临时进程内存使用，认证已通过，尚未执行真实生成。先完成受控生产链，再进行无敏感内容的最小真实调用，逐项核对实际型号、限制与计量，不能将认证通过冒充模型或零结算通过。安装/Windows 证据仍需分别取证，不自动升级用户库或重启用户桌面实例。

## 会话局部与总 diff：方案与提示词留痕（2026-10-16）

用户要求文件编辑记录旁的实时局部 diff，以及输入框上方居中的总 diff，已选择 B「本轮对话开始以来的净变化」。本轮仅编制方案和[开发任务书](../../prompts/conversation-live-diff.md)，未改产品源码、数据库或运行验收成绩，不启动开发、不重排其他专项。已确认选择与推荐默认唯一归[工作台 §34](../frontend/workbench-design.md#34-会话局部与总-diff)，视觉归设计系统 §9.15，待运行规格归测试计划 §34；后续明确下发任务书后，先核定持久会话基线/原身份与工具参数流，再开发后端、client 和两个 UI 位置。产品讨论须写入对应主方案、防止实现静默偏离的维护规则已补入[文档规范 §4](../README.md#4-变更规则与验收)。

## 输入框粘贴图片与消息附件：后端全链路落地，前端待接线（2026-10-16）

按用户确认的全链路方案（[实施计划](../superpowers/plans/2026-10-16-composer-paste-image-attachments.md)）与「先文档后前端」推进，当前 Agent 单独实施、未 commit/push。**后端已实现（T1–T4）**：迁移 `0093` 附件表（`bytea` + CHECK 白名单/上限/字节一致，只授 SELECT/INSERT/UPDATE）；暂存端点 `POST /assist-sessions/:id/message-attachments`（路由级 bodyLimit 4MiB，非幂等命令）；`RequestAssistMessage` 可选 `attachment_ids`（进 payload hash、事务内绑定、归属/去重/≤4张/≤6MiB、无附件载荷逐字不变）；目录能力 `image_input` 三态 + 发送闸门（按 `RELAY_MODEL_NAME` 查目录，无条目/非 true 拒绝，不冒充可用）；`AssistTurn.parts` 多模态组装（仅当前消息附件，历史降级文本占位）+ OpenAI 端口 LangChain 1.2 标准图片块。**文档已同步**：[HTTP §10.85](../api/http-command-contract.md#1085-assist-消息图片附件2026-10-18-前后端接线)、[数据库 §91](../database/physical-design-postgresql.md#91-0093-assist-消息图片附件2026-10-16-源码实现)、[工作台 §33](../frontend/workbench-design.md#33-输入框粘贴图片与消息附件)（标注前端未接线）、验收表新行（**未验收**）、`check-docs` 通过。**证据（如实）**：`apps/api` 全量 `tsc --noEmit` 通过（唯一错误来自并行实例在途的 `model-catalog-repository` 重构与其测试错位）；受影响 4 个单测 **58/58**（临时编译目录执行，未触碰共享 dist）。**待办（T5–T8）**：前端粘贴/拖拽捕获与附件 chip（`AssistView`/`ChatCommandInput`/`relayClient` 全是并行实例热文件，按用户决定待热文件安静后接线）、消息气泡缩略图、前端 jsdom/浏览器规格、真实 PG 集成测试（空载单跑）、真实 Provider 多模态样本。**并行协调**：同仓实例在改 `model-catalog-repository/pricing`（本片逐次重读后定点编辑，双向保留）；对方 `0094` 迁移已顺延避让我方 `0093`，双方文档互认。

## 「+」两级上下文菜单与二级能力入口（2026-10-16）

用户实际下发「+ 菜单与二级能力菜单」实施提示词（一级＝想做什么、二级＝具体选什么；基于真实代码增量改、优先复用既有组件、不得为完成 UI 造假业务）。本轮由当前 Agent 单独实施前端，未派子代理、未 commit/push、未改后端/数据库/权限/业务命令。**已实现**：`views/AssistView.tsx` 把原平铺四项弹层重构为数据驱动的两级菜单——一级/二级共用同一行组件（`AttachRow`），四项能力不各写一份；二级向右展开，右侧放不下翻左、下方放不下按底对齐，两侧都不够时面板内滚动；点击展开（刻意不用 hover，避免缝隙闪断）、点击外部关闭、Esc 先收二级再收一级、↑↓/→/←/Enter 键盘导航、候选行状态位（资料计数、已绑目录对勾、已选 Skill 对勾）全部来自真实事实。**接入既有能力，零新协议**：「检索项目资料」打开既有资料选择面板；「对话中的资料」取会话消息上真实出现过的引用（去重、三类、三元组齐全）；「最近使用」目录复用协作页持有的真实近期目录与同一目录入口（含草稿守卫，`CollaborationView` 仅新增 `recentFolders`/`onOpenRecentFolder` 两个透传 props）；命令清单复用 `GET /chat-commands` 与内联菜单同一套 `chatCommandScope`/`chatCommandStatus`（已从 `ChatCommandInput` 导出复用，不另写一份）。新增本机偏好 `lib/recentSourceRefs.ts`（仿 `recentWorkingDirectories`，只记 kind/rootId/version 三元组、不缓存正文，服务端受理后写入）。**如实禁用并写明接入点**：本地文件选择（`desktopHost` 只有目录选择器）、管理工作区（无工作区管理 UI）、Skill 生成两条（只有只读盘点与「选择已有 Skill」）；禁用行不显示 chevron、不进入焦点顺序。

**同日追加（用户截图「菜单右侧留白太多」）。** 面板原本写死 `min-width: 15rem`（Chromium 实测 235px），而最宽一行只占约 145px，短行右侧最多空出 108px 空白带。改为 `width: max-content`（宽度由最宽一行决定，保留 `max-width` 上限），并把行尾状态位与 chevron 收进一个 `margin-left: auto` 的尾组：一级面板收到 **200px**、二级 **194px**，逐行尾组右缘距行右缘恒为 8px（＝左内边距），各行 chevron 落在同一列。脚注/空态/二级脚注用 `width: 0; min-width: 100%` 退出固有宽度计算——不排除这条，二级面板会被长脚注撑回 345px（实测）。`tests/composerAttachMenu.spec.tsx` 加一条尾组结构断言锁住对称前提，共 **16/16**。

**证据（如实分层）。** 已运行：组件契约 `tests/composerAttachMenu.spec.tsx` **16/16**；真实 `/agent` 路由回归 `tests/assistantModeSwitch.spec.ts` **47/47**（含两条新增集成：目录二级→既有「更换目录」对话框、命令二级→真实登记填入首条草稿且零 POST；该文件同轮另有并行实例新增的输入器布局结构断言，两者共存且全绿）；`apps/workbench` 全量 `tsc --noEmit` 通过；`vite build` exit 0；`check-docs` exit 0（169 篇/3904 链接）。**未跑**：浏览器 Playwright 规格、真实 Windows 窗口/DPI/原生 IME、真实模型（本片不涉及模型调用）。为让真实路由用例能点到目录入口，`tests/setup.ts` 补了 `Element.prototype.scrollIntoView` 空实现（jsdom 无布局，真实浏览器有）。全量 vitest 在共享工作树内与并行实例同跑出现成组用例级抖动（同文件单跑全绿），故只用上列定向出口作证据；并行实例造成的既有红灯（`collaborationWorkspace` 执行摘要文案、`run-events` SSE 时序、`assist-flow`/`firstPartySkills` 的 `?skill=assist` 夹具已被其「旧 Assist 入口统一到 `/agent`」取代、`responsiveTiers` 报其新增 `ComposerDraftAssist.css`）不并入本片，也未代为修改。

交互归[工作台 §32](../frontend/workbench-design.md#32-两级上下文菜单与二级能力入口)，视觉归[设计系统 §9.14](../frontend/design-system.md#914-两级上下文菜单视觉补充)（token 零新增），规格与实际运行范围归[测试计划 §33](../testing/verification-plan.md#33-两级上下文菜单验收规格)，成绩只归统一验收表「「+」两级上下文菜单与二级能力入口（2026-10-16）」行。**不改变**：不重排免费模型专项与阶段 C/D 顺序、不改模型目录或普通 Agent 主循环、不启动压缩/Skill 定制/文件恢复。

## 免费模型来源约束反例修复（0095）与剩余链路门控（2026-10-16）

用户实际下发「先修来源约束漏洞，再完成剩余闭环（含单模型额度耗尽自动接续）」。本轮**先复现再修**：真实 PG 单跑 [`model-selection-source-acceptance`](../../apps/api/test/integration/model-selection-source-acceptance.integration.test.ts) **0/1**（`openrouter` + `free_only=false` + 目录三列 NULL 写入成功，期望 23514），确认根因是**两条约束各自都被 NULL 语义绕过**——0089 的 `(connection='default' OR catalog_source='openrouter')` 在来源为 NULL 时求值 NULL（`false OR NULL = NULL` 视为通过），0094 的 `(connection <> 'default' OR catalog_source IS NULL)` 在 `openrouter` 时左支恒真。修复为追加迁移 **`0095_session_model_selection_openrouter_provenance.sql`**：`CHECK (connection <> 'openrouter' OR (catalog_source='openrouter' AND catalog_snapshot_seq IS NOT NULL AND catalog_model_id IS NOT NULL))`（`connection` 非空且只两枚，`<>` 恒为确定布尔；非默认分支全用显式 `IS NOT NULL`），并带**只读预检**——用 `IS DISTINCT FROM` 统计将违反的既有行，>0 即 `RAISE EXCEPTION ERRCODE='23514'` 回滚整个迁移，明确阻止而非伪造来源/改写/删行。反例文件与断言一字未改。**证据**：`tsc -p tsconfig.json` exit0；真实 PG `-TestFile model-selection-source-acceptance,session-model-selection,model-catalog-sync` **exit 0**（95 项迁移含 0095；反例 **1/1**、选择 **7/7** 含新增「不误伤合法组合」三组合、目录 **8/8**）；8 件定向单测 **91/91** 保持；`check-docs` 与 `git diff --check` exit0。成绩只归[统一验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「免费模型模块阶段 0 整改（2026-10-16）」行，数据库说明新增 §92 并更正 §90 的「后续需追加」表述。

**剩余链路仍未实施（本轮未动生产接线）**：OpenRouter 服务端独立连接与凭据引用、会话选择与首条消息的实际模型绑定、Run 创建冻结配置/有序候选/接续策略、实际调用入口读取冻结约束并附零价硬限制、自动刷新生命周期、前端选择器，以及**单模型额度耗尽的有界自动接续**。门控未满足：本轮 23:39 仍实测到并行实例在改 `tool-loop.ts`、22:5x 改 `assist-runner.ts`/`openai-compatible-model-port.ts`/`database-schema.ts`，前端整层在改（computer-use 与粘贴图片两个专项同树在途）。这些改动落点与之重叠，且无调用方时预建表列违反「不建占位」规则；不把「反例已转绿」当模块完成。恢复信号与整批接通要求见上一节。

## 免费模型阶段 0 独立复验：反向来源约束待修（2026-10-16）

本轮用户仅要求验收，未补产品实现。阶段 0 原有整改已复验，但新增独立真实 PG 反例发现 `openrouter + free_only=false + 目录三列NULL` 仍被 0089/0094 放行；已保留 `model-selection-source-acceptance.integration.test.ts`，更正数据库文档的“合并后语义完备”结论，并接续专项任务书阶段 0。成绩只归统一验收表原“免费模型模块阶段 0 整改”行；该红例已由同日 0095 修复（见上一节），阶段 A/C-2b/D 仍在门控后。实际 OpenRouter 聊天、自动刷新生命周期、Run 候选冻结/UI 与额度自动接续仍未实施，不将原有定向检查通过当完整模块通过。

## 免费模型阶段 0 整改完成（2026-10-16）

用户实际下发[专项任务书](../../prompts/free-model-catalog.md)的**阶段 0**。本轮只做阶段 0：先复现失败，再最小修复转绿，不扩展阶段 A–D。**已修**：① 目录同步集成测试的 `before` hook 改用应用角色**本来就持有**的 `DELETE`（不再用 `TRUNCATE`，不给生产角色补危险权限），原 6 条断言一条未删；② 追加迁移 **`0094_session_model_selection_source_guard.sql`**，用显式 `IS NULL` 钉住「`default` 连接不得携带 OpenRouter 目录来源」（`0095+` 仍空；0089 不改写，台账按内容 sha256 校验）；③ 目录来源完整性收紧——非空畸形结果、不完整分页、同一 id 矛盾重复一律不发布且保留旧快照，未知计价项只有明确为零才放行，工具能力改按官方结构从模型**顶层** `supported_parameters` 解析；④ 同步在**领取租约的同一行锁内**按当前发布头复核 TTL/退避/刷新间隔。**证据**：真实 PG 94 项迁移 + 两套集成全绿（`model-catalog-sync` **8/8**、`session-model-selection` **6/6**）、PG 启停 exit0、临时集群已删除，`apps/api` 全量 `tsc --noEmit` exit 0，免费模型 6 件定向单测 **56/56**。原 6 项目录套件是**首次真正执行**（此前全灭于 before hook），其中 4 条时间预算/CAS 前置与事实不符，已按夹具修正（补时间推进、补一次真实 intervening publish）而非删除断言。成绩只归[统一验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「免费模型模块阶段 0 整改（2026-10-16）」行。

**未做且在门控内**：阶段 A 剩余工程契约、阶段 C-2b（OpenRouter 服务端独立连接与真实聊天外呼、Run 创建冻结非密钥模型快照与候选策略、五处端口构造点读取冻结约束、目录转收费的下次调用拒绝）、阶段 D（前端选择器与 live 客户端接线），以及本次新增必交目标**单模型额度耗尽的有界自动接续**。恢复信号不变：`run-steps`/`conversation-*`/`checkers` 与 `apps/workbench/**` 不再被并行实例改动、或对方已提交。本轮实测**仍有并行实例在改**这些文件与 `model-catalog-*`（已逐次重读后定点编辑并保留其改动），故未动。无真实 OpenRouter 凭据与放行，真实外呼、浏览器、Windows 窗口与安装包保留未验；免费保证与零结算不成立。

## 免费模型验收与额度接续任务书更新（2026-10-16）

用户本轮明确“先验收并更新开发任务书”，不补产品实现，不解除 C-2b/阶段 D 的共享热文件门控。阶段 B/C-2a 的真实 PG 验收发现测试夹具与数据库约束问题，新增来源校验/并发整改前置；成绩和运行限制只见[统一验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)“免费模型模块独立验收”行。该轮要求的[专项任务书阶段 0](../../prompts/free-model-catalog.md)已于同日完成，见上一节；下一步是阶段 A 剩余契约与阶段 C-2b，仍受同一热文件门控。

新目标为[后续路线 §9.1.1](../requirements/post-v1-roadmap.md#911-免费额度耗尽自动接续)：单模型额度耗尽后，按冻结有序免费候选有界接续；账户/平台共享额度耗尽停止，保留原消息/Run、实际模型尝试与切换记录，不转收费、不重跑工具。该目标未实施，替代旧“永不切其他免费模型”的设计限制；旧门控和其他模块顺序不变。

## 会话顶栏触发框收窄（2026-10-16）

按用户红框截图接续 §9.13：触发框此前按弹性主列拉伸，短标题右侧空场一整条、选择箭头孤悬最右端与标题断开。改回收窄到内容宽（`min-width: 6rem`、封顶 `min(12rem,40cqi)`，长标题在 select 上截断、完整值在 title），中列 `space-between` 把「新建会话」钉回右缘、与「工作详情」保持相邻成组；透明边框、悬停淡底、compact 同高与浮层样式不变。新增 `conversationToolbarDensity.spec.ts` 常驻回归（锁收窄、封顶、右缘钉住与透明边框）；`narrowWindowNewConversation`＋`emptyConversationWelcome`＋`recentWorkRailDensity`＋`chatTimelineNavigation` 单 worker 33/33；顺带修 `recentWorkRailDensity.spec.ts` 两处 `panelActionColors` null 安全（前一轮未提交改动遗留，曾阻塞 `tsc --noEmit`）。`tsc --noEmit` 与 `vite build` 通过、dist 已重建——生产模式桌面窗口需重启加载（用户 22:06 截图中的下拉边框即旧 dist 渲染，源码在 Chromium 探针中已证实为透明边框）。仅前端展示，不改业务事实、命令、权限或 API；视觉归[设计系统 §9.13](../frontend/design-system.md#913-会话视图顶栏密度2026-10-16)，成绩归验收表「会话视图顶栏密度」行；真实 Windows 窗口与多 DPI 未复验。

## 会话顶栏改左右两翼（2026-10-16）

用户指令：顶栏改为左侧会话信息、右侧「工作详情」，「新建会话」作为冗余入口删除。已实现：左翼＝会话身份下拉 + 作用域两行（同一信息块，行距 `space.1`），右翼＝动作区（`control.height.compact` 同高、内边距 `space.3`、图标 0.875rem，≤46rem 收文字只留图标）。**「新建会话」只在工作空间级删除**——全局「新对话」只建无作用域讨论，任务/目录归属下那颗键是「在同一任务/目录里再开一段」的唯一入口，故保留在右翼；这一取舍与理由已写进设计与验收。`AssistView.tsx` 把 select 与按钮拆成两个节点（各一份定义、两处容器只摆放），非工具栏会话带不变。**取证**：`conversationToolbarDensity.spec.ts` 重写为三例（左右翼几何、无归属无「新建会话」、任务归属保留且排在「工作详情」前）3/3；`narrowWindowNewConversation`＋`emptyConversationWelcome`＋`recentWorkRailDensity`＋`chatTimelineNavigation`＋`frontendAcceptance` 单 worker 41/41；`newConversationEntry` 两条依赖该键的守卫用例改挂到仍有该入口的路径后 10/10（其一覆盖范围如实收窄，见验收表）；`tsc --noEmit` exit0、`vite build` 重建 dist（生产模式窗口需重启加载）。视觉归[设计系统 §9.13](../frontend/design-system.md#913-会话视图顶栏密度2026-10-16)，成绩归验收表「会话视图顶栏密度」行；真实 Windows 窗口与多 DPI 未复验。

## 会话顶栏 taste 审计：去卡片与作用域分档（2026-10-16）

用户要求用 taste-skill 优化会话顶栏。技能已装入 `C:\Users\ASUS\.workbuddy\skills`（完整版 `design-taste-frontend` 与市场版 `design-taste-plus`），其 §13 自述把密集产品 UI 列为 out of scope，故只取其可迁移条款（§4.4 卡片只在需要层级时用、§9.C 间距数学、§4.5 空态不冒充取值），视觉权威仍是项目设计系统。三处改动（零新增 token／色值，`data-testid`、文案、路由与 Owner 全未动）：① 去卡片——顶栏由「纸面卡里再套带描边圆角的卡」改为透明底、无描边圆角、仅一条下缘细分线，读作转录区 chrome；② 作用域两行间距 `space.4` → `space.6`（12px 字号下 16px 黏成一串）；③ 占位状态（尚未关联目标／未绑定目录／待核对）降到 muted 档，真实取值仍 secondary，不拿「没有事实的说法」冒充取值。`conversationToolbarDensity.spec.ts` 追加第二例锁住这三条；连同 narrowWindowNewConversation＋emptyConversationWelcome＋recentWorkRailDensity＋chatTimelineNavigation＋frontendAcceptance 单 worker 38/38；`tsc --noEmit` exit0、`vite build` 重建 dist（生产模式窗口需重启加载）。视觉归[设计系统 §9.13](../frontend/design-system.md#913-会话视图顶栏密度2026-10-16)，成绩归验收表「会话视图顶栏密度」行；真实 Windows 窗口与多 DPI 未复验。

## 会话顶栏收成单行与顶栏去下拉（2026-10-17，接续上面三轮）

用户实机截图四条指令：顶栏太高、「工作详情」键换样式、文字被顶栏盖住时要渐变、左侧只要会话名不要下拉框；并要求 UI 改动走 taste-skill。已实现（零新增 token／色值，路由、命令、Owner 与业务事实未动）：顶栏由两行收成单行（1487×900 实测 75px → 49px）；右翼三颗键改 ghost（静止透明、悬停 `selection.hover`、按下与展开 `selection.bg`/`selection.text`、禁用降 muted）；正文滚过转录区上缘时绘制 32px 条件渐隐带，停在顶部不画，且不新增滚动 Owner；`/agent` 顶栏左翼改为会话名纯文字，`select` 只剩非顶栏的会话带（`?skill=` 页）。**按指令删控件、按证据留能力**：同作用域读出 ≥2 条讨论时右翼补一颗「切换讨论」浮层键（Task 绑定会话不进近期工作栏，没有它就回不到旧讨论），走同一 `selectSession`，离开保护与同名去重文案一字未改；顶栏随之抬到 `zIndex.sticky`，浮层才不被后画的正文盖住。**取证**：`conversationToolbarDensity` 重写为五例 5/5，与 `inspectorPreviewLayout`＋`chatTimelineNavigation`＋`narrowWindowNewConversation`＋`headerHeightToken`＋`responsiveFoldGeometry`＋`emptyConversationWelcome` 同批单 worker 干净复跑 50/50；jsdom 迁移四文件中 3 个文件 76/76、`collaborationWorkspace` 73/77（4 条属并行的工具轨迹／执行摘要用例，只报不修）；`tsc --noEmit` 剩余报错只在他人 `conversationDiffSummary`／`chatLocalFileDiff` 测试文件。视觉归[设计系统 §9.13](../frontend/design-system.md#913-会话视图顶栏密度2026-10-16)，成绩归验收表「会话视图顶栏密度」行。**未复验**：真实 WebView2 窗口与多 DPI；dist 未重建，生产模式窗口仍是上一版顶栏——要看实机效果走 dev 窗口。

## 转录区上下两条边同套渐隐与回底键收成整圆（2026-10-17，接续上面四轮）

用户实机截图两条指令：「文字被未选择目录这一行遮盖的时候也要有同样的渐变效果」「回到底部的箭头改成圆形背景」。纯展示层，零新增 token／色值，`data-testid`、文案、路由、命令与滚动 Owner 未动，Breaking Change：No。① 底缘加一条与上缘同源的条件渐隐带（`space.8`＝32px、`bg.surface` → 透明、`pointer-events: none`、`data-bottom-fade="on"` 才绘制）；上下两条边的判定合并为一个 `syncEdgeFades`，除真实滚动外还挂在消息整批替换与视口自身变矮两处——这两处都不产生 `scroll` 事件，只挂 `onScroll` 会让长会话切短会话时渐变永久压在第一条消息上；底缘阈值取 `remaining > 1` 而非 `> 0`，避开高 DPI 下小数 `scrollTop` 让停在底部仍绘制。阅读意图（`followLatest`／`atLatest` 的 32px 档）仍只由真实滚动决定，尺寸变化不改读者位置。② 回底键按文档本意是「边长 `control.height.compact`」，代码只写了 `min-height`，于是全局 `.icon-button` 的 `height: control.height`（40px）生效、32×40 配 `radius.round` 读成竖胶囊；补上同源 `height` 即为整圆，命中区没缩。**取证**：`conversationToolbarDensity` 第三例扩为上下两条边＋键形，单 worker 5/5；`chatTimelineNavigation` 单 worker 11/11；jsdom 全量 1067/1089，22 条失败里没有一条提到本轮三个新标识（`data-top-fade`／`data-bottom-fade`／`assist-latest`），全部落在他人未提交范围（`assist-flow` 仍找 V4.2 已删的 `.breadcrumbs`／`assist-target`、工具轨迹契约、live 夹具、`ComposerDraftAssist.css` 旧式断点）；`tsc --noEmit` 剩余报错同样只在他人三处测试文件。**未复验**：真实 WebView2 与多 DPI；dist 未重建；同批 `uiOption2FirstSession` 16 例红，停在夹具发送流程（`assist-copy-a-0` 不出现、近期工作栏报「当前会话暂未能在近期工作中核对」），归因他人未提交的 `RecentWorkRail.tsx` 改写（+492 行），本轮只报不修。视觉归[设计系统 §9.13](../frontend/design-system.md#913-会话视图顶栏密度2026-10-16)，成绩归验收表「会话视图顶栏密度」行。

## 聊天列纸面左右同色（2026-10-17，接续上面五轮）

用户实机截图一条指令：「输入框左右两侧怎么颜色不一样？左边是正常的背景白色，右边的颜色暗一点，是因为渐变吗？顶栏也有这个问题」。**归因不在本轮那两条上下遮罩**（纵向渐变、只画 32px 横带，产生不了竖边），而是 2026-10-16 外壳分层给 `.app-content` 铺的一条 `linear-gradient(to right, bg.surface calc(100% − layout.workspace.sideWidth), transparent)`：它的前提是「卡片右缘接近屏幕右缘时淡出回桌面」，而实测卡片与窗口右缘齐平（1480 视口 `.app-content` 右缘 = innerWidth = 1480），右边没有桌面可退，这条 544px 宽的横向渐变只把正文右半染向 `bg.subtle`——逐像素核对：改前输入卡两侧各 195.6px 留白是 #FFFFFF 对 #F8FAF7，顶栏那行从 x≈1100 起一路淡到右缘；顺带把转录区那两条洗向 `bg.surface` 的遮罩也打穿了（带子越往下越「亮」）。修法是一行：`.app-content` 平铺 `bg.surface`，几何、描边、圆角与顶部桌面带未动，零新增 token／色值，Breaking Change：No。**取证**：`conversationToolbarDensity` 新增一例——截整窗一行真实像素、在页面里用 canvas 解码，比对输入卡两侧与消息列两侧留白的 RGB 逐通道相同且等于 `bg.surface`（祖先层叠的结果只看计算样式测不出），本片六例 1487×900 单 worker 6/6；A/B 证明断言会咬：把渐变挂回去，像素档读回 `[250, 251, 249]` 对 `[255, 255, 255]`、计算样式档报 `backgroundImage` 非 `none`。同批七个相关规格 56 例 52/56，4 条红全是 `inspectorPreviewLayout` 的 `sessionNameRightWing 交叠 66px²`，A/B 复跑（挂回渐变）同样红，归因他人未提交的 `CollaborationView.css`（+239 行）会话名 `max-width: min(20rem, 50cqi)` 那一档；同一 spec 第七例（他人 15:21 追加）与 `src/api/resources/gateway.ts`（他人 15:22 未提交，`RelayWriteReadiness`／`writeReadinessFrom` 未导入）的 2 条 `tsc` 报错同理，均只报不修。视觉归[设计系统 §9.13](../frontend/design-system.md#913-会话视图顶栏密度2026-10-16)，成绩归验收表「会话视图顶栏密度」行。**未复验**：真实 WebView2 窗口与多 DPI（探针是 headless Chromium）；dist 未重建，生产模式窗口仍是上一版纸面——要看实机效果走 dev 窗口。

## 输入框自动分点与手动润色接入源码（2026-10-16）

用户实际下发[开发任务书](../../prompts/composer-outline-and-polish.md)，本轮由当前 Agent 单独接入源码，未派子代理、未 commit/push。**已实现**：服务端 `workflow/composer-draft.ts`（模型只回原文**码点**边界序号，程序按原文切片并只加 `N. ` 与换行；润色只回 `{text}`；畸形协议整条拒绝）、两条运行时提示词路由 `COMPOSER_OUTLINE`/`COMPOSER_POLISH`（`workflow/prompts/composer-prompts.ts`，不加载公共核心）、端口 `ComposerDraftPort` 与 `OpenAiCompatibleModelPort.draftAssist()`、用例 `application/composer-draft-assist.ts`（准入 + 既有 `model_calls` 记一行 `kind='COMPOSER'` 无作用域 + 实例闸门）、端点 `POST /composer/draft-assist`、前端 `components/ComposerDraftAssist` 接入首条与已有会话两处正文 Owner。迁移 `0091` 只给 `model_calls.kind` 加枚举值 `'COMPOSER'` 并补无作用域分支，**不新建表、不加列**。协议归 HTTP §10.84，物理归[数据库设计 §89](../database/physical-design-postgresql.md)，交互归[工作台 §30](../frontend/workbench-design.md#30-输入框自动分点与手动润色)（含 §30.6 实施默认），提示词路由归[提示词设计 §2.1](../architecture/agent-prompt-design.md#21-当前运行时提示词路由)，运行范围归[测试计划 §31.1](../testing/verification-plan.md#31-输入框自动分点与手动润色验收规格)。

**证据（如实分层）。** 已运行：`composer-draft` 单测 **10/10**、`composer-draft-port` 单测 **3/3**（受控 HTTP 捕获最终发出体，证明请求只含当前草稿、`json_object`、无工具）、前端 `composerDraftAssist.spec.tsx` **13/13**、浏览器 `composerDraftAssist.spec.ts` **3/3**（真实 Chromium，含润色键在输入卡工具行内的键位回归）、`apps/api` 与 `apps/workbench` 全量 `tsc --noEmit` 均通过。**已写未跑**：真实 PG 集成 `composer-draft-assist.integration.test.ts`（`COMPOSER` 行无作用域 + 真实 usage、业务计数不变、畸形协议仍记 `COMPLETED`、失败记 `FAILED`、闸门不写行、未配置/超长开事务前拒绝、HTTP 401/409/422）——共享工作树有并行实例、机器非空载，按项目规则未并发跑 `run-integration.ps1`，留待空载 `-TestFile composer-draft-assist` 单跑。**未验**：真实 Provider 的语义质量样本（切点是否落在正确需求边界、是否保留否定与条件）、真实 Windows 窗口的 IME/DPI 与安装态、三方案预览的 B/C 两种呈现（CO-12，原型任务书未下发）。同日按用户截图反馈修正键位：**润色键从「输入卡上方独立一行」移进输入卡工具行**（与「资料 / 模式」同一行，原型 `#polishBtn` 的位置），浮层改为锚定提示行上方的非模态绝对定位，不再推动布局。

**不改变**：不重排免费模型专项（阶段 C-2b 与阶段 D 仍受主循环热文件静默门控）、不扩展到压缩/Skill 定制/文件恢复，未新增产品验收成绩（成绩仍只归统一验收表）。

## Agent 入口与目录读取修复（2026-10-16）

**2026-10-18 当前独立复验：D1–D4 限定范围通过，交付链继续整改**：协调者亲自重新构建并运行真实 PG/HTTP/磁盘四套24/24、Workbench三文件32/32及类型检查，四项已通过，不再停在“实施者自检待复验”。发现 `local-directory-access.js` 在当前编译输出与桌面 `resources/api` 中不同、debug/API副本无该模块；零配置真实浏览器链仍缺证据。已生成[产物与浏览器接续任务书](../../prompts/remediation/local-directory-delivery-20261018.md)，按用户授权继续派原 GPT-6 Luna 子代理执行。活动用户窗口不重启、不恢复电脑接管；本轮新 PG 集群均已清理，上一轮被自动审批拒绝删除的自有临时目录保留并明确限制。分层成绩只归统一验收表。

**2026-10-18 D1–D4 修复实施者自检通过，待协调者独立复验**：原独立验收的四个反例分别确认默认读取权限复活、物理目录删除后精确命令重放失败、重试载荷 revision 漂移及目录选择告知缺少默认只读说明。本轮按[整改任务书](../../prompts/remediation/local-directory-access-acceptance-20261018.md)补历史策略范围核对、已有回执先判定、前端冻结命令载荷/作用域并区分历史回执与当前投影，以及真实目录入口说明。真实临时 PG 的四个相关集成套件 **24/24**，Workbench 三个定向文件 **32/32**，API/Workbench typecheck 与 Workbench production build 通过；证据、旧 RED 和自检/待复验边界只记在[统一验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。真实 Provider、浏览器零预置权限及 Windows/活动桌面副本仍未验；没有操作用户桌面或 commit/push。

**2026-10-18 本地目录免手工配置（应用实现已接入）**：用户确认基础文件不应要求手工配置连接/策略。主动选目录默认只读，写档位由 Application 管理精确目录的 Gateway 配置；连接与策略页保留给外部服务、特殊能力、排错和历史/限制管理，不是普通本地文件链路的前置步骤。实现边界归[工作台 §18.1.4](../frontend/workbench-design.md#1814-本地目录权限设置2026-10-18已确认已实施)，API/数据库合同分别见[HTTP §10.86](../api/http-command-contract.md#1086-目录写入档位投影与只读查询2026-10-17-源码实现)和[数据库 §98](../database/physical-design-postgresql.md#98-0109-本地目录访问档位元数据2026-10-18-源码实现)。真实运行成绩及残余 UI/Provider/桌面载入范围归统一验收表。

**2026-10-18 普通聊天文件 CRUD 接续（服务端/真实 PG/HTTP/磁盘范围通过）**：在原会话此前的执行选择与 Run 回填基础上，修复就绪/执行连接按 canonical root 匹配；补齐 DELETE 拒绝时同事务结算原工具调用，避免 Review 已拒绝而 Run 工具行永久等待。受控模型端口经普通聊天消息、原申请/Apply/Run 和原消息投影走通 CREATE、MODIFY、DELETE 批准与拒绝，真实磁盘字节及原消息结果核验通过；同一项目双根、Gateway 与工具循环专项回归通过。真实 Provider 有界调用未通过（192K/8-call 运行超时，65K 运行预算耗尽且仅结算 find_paths），Windows/WebView2 交互未验；API 资源暂存与 Workbench dist 已更新，但正在运行的 `target/debug/api` 仍是旧副本，桌面窗口未重启。细节与证据只归统一验收表「本地目录免手工配置」及「普通 Agent 文件 CRUD 接续」行。任务书指定的物理 Escape 边界仍有效；未操作活动桌面窗口，也未派子代理、未 commit/push。

按用户本次问题接续阶段 D：任务/项目旧 Assist 入口统一到 `/agent`，任务默认聊天并复用目录条、工具栏与详情外壳。首条先绑定持久目录再发送，未知重试保留原身份；普通发送移除两种抢先解释，终态只读回主流程候选。GET 执行请求增量回显原资源与候选，无 migration。真实测试库原先无工具连接，本次通过既有配置 Owner 仅为 Relay-Agent 根设置读取连接及四种只读动作策略，其他目录不自动获权。**同日接续（computer-use 真实窗口验收）**：三入口同址、工作详情三页签与关闭行为一致、先选目录发首条（持久绑定＋`list_directory` SETTLED＋真实模型回复真实名称）、只读零新增 Task/Run/执行请求（计数 5/2/4 前后不变）、无绑定如实提示；重开恢复时发现并修复归属行「当前项目」占位缺陷（`CollaborationView` 的 `projectTitle` 只随任务路径解析，现沿目录绑定 projectId 用既有 `getProject` 解析），修复后真实窗口复验通过。MODEL_FAILED 间歇失败（当日 2 败/4 成）取证后排除超时、预算与两类请求形状（直连协议探针 4/4 全 200），未能在带诊断产物上复现，按现有证据不归因本地实现、倾向 Provider 外部故障；临时诊断 `DEBUG-directory-read` 已从源码与两处 dist 清除并重建同步，干净产物复验成功。临时诊断落盘代码未当作修复；错误分类沿用 `MODEL_FAILED`＋`session_tool_calls` 对照。边界与成绩只归验收表「Agent 入口统一与目录读取」行；原「阶段 A/B/C」行的「阶段 D 未实施」已标注为 2026-10-15 时点结论。完整 Run 结果投影（AM-06 剩余）和安装包仍为后续，不改变免费模型等并行工作顺序。

## V4.3 原型对齐接续：项目接续与无会话空态（2026-10-16）

用户下发 [V4.3 整改任务书](../../prompts/v43-prototype-alignment.md)，按任务书派发子 Agent A（项目与接续）与 B（工作台首屏/输入区），两包均被用户中断、部分改动落树；主 Agent 遵「不改别人改动」只补 [ProjectSkillView.tsx](../../apps/workbench/src/views/ProjectSkillView.tsx) `readOverviewFacts` 返回对象缺的 `tasks/tasksNextCursor/tasksReadFailed` 三字段，并把一条未跟上 V43-01 外壳收纳契约的过时浏览器断言（`projects-empty-state` 在 `/projects` 等 `recent-work-empty`）对齐为整栏隐藏。**V43-04/V43-06 通过**（组件 + 真实 API + 电脑插件真实窗口复验：接续摘要卡/继续工作仅导航/查看动态带 project_id 过滤/归档说明；无会话任务聊天视图直接给输入卡、旧三选一停顿页消失）；**V43-05 未实施**（真实窗口首屏仍 11 建议常驻、工具行未紧凑化，子 Agent B 中断前未完成）。`tsc --noEmit`/`vite build`/`check-docs` exit0；任务书定向组 58/58、项目组 33/34、协作组 128/130、浏览器 frontendAcceptance 12/12 与 projects-empty-state 6/6。3 个失败均非产品缺陷（两个是新测试夹具自身 bug：缺 `/daily-continuation` GET 桩、`pathname` 与含 origin 的 `${prefix}` 比较永不匹配；1 个为验收表既有记录），待其 Owner 修复。成绩只归统一验收表「V4.3 原型对齐接续」行；下一步优先补 V43-05 与两个夹具缺陷。

聊天区左侧消息时间线导航已由设计推进到首版实现：点击节点定位原会话对应消息，交互归[工作台 §31](../frontend/workbench-design.md#31-聊天消息时间线导航)，视觉归[设计系统 §9.12](../frontend/design-system.md#912-聊天消息时间线导航设计补充)，规格与实际运行范围归[测试计划 §32](../testing/verification-plan.md#32-聊天消息时间线导航验收规格)，成绩归验收表「聊天消息时间线导航」行。范围只有前端只读消费：新增 `components/ChatTimelineNav`，接入 standalone 聊天列，零 API、零 migration、零业务命令、零模型调用。原「节点粒度／长会话／窄窗待核定」三项按实施默认收口（只索引用户提问、导航轨局部滚动不缩命中区、聊天列 ≤48rem 降为左缘紧凑展开入口），嵌入态任务详情会话历史与真实 Windows／DPI 仍未做。不改变业务与后续开发顺序。

近期工作栏按用户确认的两行方案调整：标题独占首行，副行简写更新时间并以轮廓图标区分会话，同组同名项保留时分；增加行内与分组留白、减少树形缩进，保留既有字号与拖拽栏宽。交互归工作台 §28.1，视觉归设计系统 §9.11，实际检查与未覆盖范围归功能验收表原「近期工作栏窄列搜索与行密度」行；不改变业务与后续开发顺序。

同日按用户校正接续「目标／工作区（目录）」导航：以正式 Goal 经 Project 的已有多对多关系聚合跨目录会话，目录入口按持久化的会话资源绑定分组，原任务入口保留；两处恢复同一会话与历史，正文分别显示关联目标及会话目录。 按后续截图反馈统一根区标题、内层分组与条目的视觉层级，空态降为辅助提示，任务入口支持折叠。新增可选只读 `include_context` 投影，无 schema/migration 或执行权限变更，也未新增会话直接绑定 Goal。交互、视觉、API 分别归原主文档，运行结果归验收表「目标与目录会话导航」行；真实 Windows／DPI 仍待复验。

同日再按截图反馈收四处：① **修掉「工作区（目录）」收不起来**——原实现按「当前项在哪一组」常驻强制展开，活动会话必然落在该段，点 summary 的同一拍就被改回展开；改为折叠偏好是唯一依据，只在定位（切换到另一条会话或任务）时展开它所在的区与组一次。② 根区标题的 `bg.subtle` 淡底由常驻收回悬停/按下，静止不铺底。③ 空态短提示（「暂无关联目标」等）在栏内水平居中。④ 条目列表在树线内侧再留 `space.0.5`，激活标记随条目一起右移 2px，不再贴着竖线画。本轮只动左栏展示与一条本地偏好读写时序，不改业务事实、命令、权限或 API；交互归工作台 §28.1，视觉归设计系统 §9.11，成绩归验收表原行。

同日第三轮按截图反馈去掉近期工作栏根区之间的分隔线：目标／工作区（目录）／任务入口（含已归档）连排时三条横线把一列切成分段，撤掉后层级由字号档、字重、缩进与 `space.3` 间距＋`space.2` 内边距承担；栏底「查找更多任务 / 会话」的边框按「分隔的是列表与栏底动作、不是并列根区」保留（该入口连同边框已于同日第四轮删除，见下段）。仅样式与常驻断言，不改结构、折叠偏好与 API；视觉归设计系统 §9.11，交互归工作台 §28.1，成绩归验收表原行。

同日第四轮按用户对搜索框与栏底入口功能重合的确认，删除栏底「查找更多任务 / 会话」入口：面板只读与左栏相同的端点（任务仅第一页、无搜索翻页），是更弱的重复入口；`components/TargetPicker.tsx` 与 `.recent-work-more`／`.rail-picker` 样式无调用方一并删除，窄档换行遗留（设计系统 §9.11）随之关闭。左栏（搜索＋「更早的任务」）成为任务与会话唯一导航入口；同轮修掉 `recentWorkRailDensity` 第三轮记录的 ⋯ 菜单既有红（同一会话在目标区与目录区各渲染一行、行内操作 testid 两份相同，`.first()` 命中未悬停副本），该文件 5/5 全绿。交互归工作台 §28.1，视觉归设计系统 §9.11，成绩归验收表原行。

同日第七轮按用户三张实机截图复提左栏间距：① 「四个根区间距没有统一」——取证发现第五轮的「拉齐 12px」只在任务入口展开时成立：已归档段在 `recent-work-list` 包装层之外，相邻兄弟选择器覆盖不到「任务入口 ↔ 已归档」，展开时靠末组 margin 塌穿包装层凑到 12px，一收起就塌成 0px（四区实测 `[12, 12, 0]`，已归档贴着任务入口）；把已归档段移进同一包装层（仍挂 `loadedCount` 之外，归档后重开入口不消失），任意折叠组合下三处间隙都是 `space.3`。② 「item 的间距再减小，而且要统一」——第五轮把行距收到 `space.0-5` 只落在基座列表上，分组覆盖仍留 `space.1`，分组内 36px、已归档区 34px 两档并存；撤掉该覆盖后一列只有一档 34px 行距，密度用例行距下限随同从 `space.1` 收到 `space.0-5`。③ 消息图标疑问不是缺陷：`MessageSquare` 只画在会话行、任务行没有，以图标区分两种行类型（可访问名称另带「会话 · 」前缀）。新增常驻回归用例锁住「任意折叠组合下四区间距同一档＋分组与已归档行距同档」；同步修 `sessionRowMenu` 辅助函数排除归档段副本、`liveTasks` 存量 URL 期望补 `include_context=true`。仅前端展示与结构，不改业务事实、命令、权限或 API；视觉归设计系统 §9.11，交互归工作台 §28.1，成绩归验收表「目标与目录会话导航」行；真实 Windows／DPI 仍未复验。

同日第八轮按用户实机反馈「间距还是太大」再收一档：条目行距已触紧凑 token 下限（32px 行高＋2px＝34px），唯一还能收的是块间距——根区 `margin-top` 与分组下外边距同步由 `space.3`(12px) 收到 `space.2`(8px)（分组下外边距会塌穿包装层顶住根区间距，必须同步改，只改根区无效）。层级留白成为 8px（根区／分组）→ 4px（段标题→分组）→ 2px（条目）整档缩放，段标题→分组与条目行距未动。密度用例同一档断言随同改指 `space.2`，该文件 7/7；`sessionRowMenu`＋`liveTasks`＋`recentWorkPagination`＋`assistBinding` 30/30；浏览器四规格 40/40（R02 在并跑中两次报红、单跑与复跑均过，对照运行换另一用例红，属 §9.11 记载的并发抖动，非本片改动）。仅样式数值，不改结构、业务事实、命令、权限或 API；视觉归设计系统 §9.11，成绩归验收表「目标与目录会话导航」行；真实 Windows／DPI 仍未复验。

## 前端定向验收与整改（2026-10-16）

按用户「验收，修改一下前端，不需要派发子 agent」独立完成项目列表、待处理、动态三个页面的明确缺陷整改。项目列表/待处理/动态及动态别名收纳近期工作栏与调宽把手，返回工作台恢复原偏好；待处理请求改为全宽卡片，正文与判断默认单列、宽窗才并排，消除旧 `:has` 特异性覆盖留下的空轨；动态补中文事件名称、已加载项类别与执行方组合筛选，完整身份留依据，检查结算不冒充通过。顺带补齐前端 `vite/client` 类型入口，修复既有错误页使用 `import.meta.env` 导致的构建类型错误。交互与根因归[工作台设计](../frontend/workbench-design.md)，布局规则归[设计系统](../frontend/design-system.md)，运行结果只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

本轮不修改后端、数据库、权限或业务命令，不 commit/push，不替换用户的 API/PG。其余 V4.3 原型差距（项目接续整合、紧凑输入区、无会话任务的聊天入口、其他路由会话栏收纳）仍需后续按实际范围推进；本次页面整改不改变模型目录或普通 Agent 主循环的阶段边界。

## 会话模型选择落地：阶段 C 第二批（2026-10-15，只做后端）

按用户「只做后端、边写边让集成待跑」推进阶段 C 的会话模型选择数据面。已实现：迁移 `0089` 新建全局表 `session_model_selection`（`session_id` 主键引用 `assist_sessions`；`connection ∈ {default,openrouter}`、`model`、非密钥 `config_fingerprint`、`free_only`、目录三列 `catalog_source/seq/model_id`、CAS `revision`、`selected_by_command_id`；两条 CHECK 把「免费必带目录依据」与「非默认连接必来自 openrouter」钉死，只授 `SELECT/INSERT/UPDATE` 不给 `DELETE`）。纯分类器 `model-selection-resolve.ts` 依「命中进程默认模型→default、否则查严格免费目录→openrouter、都不命中/收费→如实拒绝」判定，不做外呼也不伪造快照。Owner `selectSessionModel` 复用既有幂等命令基建（`runIdempotentCommand` 的 `revision`/CAS/原回执重放），把 `/model <名称>` 接到 `execute-chat-command`，并新增只读 `GET /assist-sessions/:id/model-selection`；`envelope.ts` 补 `SelectSessionModel` 资源链接。协议归 HTTP §10.82，物理归[数据库设计 §88](../database/physical-design-postgresql.md)。

**范围边界（本批只接通默认连接）。** 落库、重放、跨会话/跨 workspace 隔离与只读回显针对**默认连接**（`RELAY_MODEL_*` 已有聊天端口）已闭合；目录命中的 **OpenRouter 免费项本批如实拒绝** `OPENROUTER_CHAT_NOT_WIRED`——OpenRouter 聊天外呼配置解析尚未建、不预建无当前调用方的端口，Run 创建冻结非密钥模型快照与五处端口构造点读选择传 `freeGuard` 一并留作 C-2b（`0090+`）。选择不写 `model_calls`、不改动 Run。

**证据（如实分层）。** 分类器定向单测 `model-selection-resolve` **7/7 通过**（真跑）；`apps/api` 全量 `tsc --noEmit`（含集成测试文件）**exit 0**。真实 PG 集成 `session-model-selection.integration.test.ts`（默认选择落库/重放不推进 revision/新命令 CAS 推进/跨会话隔离/跨 workspace `RESOURCE_NOT_FOUND`/仓库层 CAS 真值表/openrouter 拒绝不落库/归档 `INVALID_TRANSITION` 不留回执/0089 三条 CHECK 用 `expectSqlState('23514')`）**已编写并通过类型检查，本轮未执行**——共享工作树另有并行实例活跃、机器非空载时并发 `run-integration.ps1` 会挂死或偶发假失败，留待空载以 `-TestFile session-model-selection` 单跑。真实 Provider、HTTP、浏览器与 Windows 安装态**未取证**；按 §8，无凭据下**不宣称免费保证或零收费成立**。Breaking Change：No（`POST /chat-commands` 结果新增 `MODEL_SELECTION` kind + 新增只读 GET，旧读取方忽略新 kind 即可）。**阶段 D（最小 UI 选择器 + live 客户端）与真实 Provider/浏览器/Windows 仍未做。**

## 免费调用硬限制与冻结约束词汇：阶段 C 首批（2026-10-15）

按「依赖顺序分批闭合」推进阶段 C 的**第一批=安全关键的免费硬保护**（§8 以「硬限制未验证不宣称零收费」为总闸，先钉这一环）。已实现：`workflow/frozen-model-constraint.ts`（随调用携带的**非密钥**冻结快照类型 + 严格解析，缺省/畸形不伪造模型身份或免费约束）；`workflow/free-call-guard.ts`（对 `freeOnly` 约束生成服务商端 `provider.max_price` 绝对零价 + `allow_fallbacks:false` + `require_parameters:true`，覆盖 prompt/completion/request/image，**不用 `openrouter/free`**、不改写确切模型）；`OpenAiCompatibleModelPort` 新增**可选**第三参数把硬限制注入 `wireFetch`（普通外呼与 reasoning 续轮重建客户端均携带，非免费时请求体逐字不变，原默认不受目录故障影响）。协议归 HTTP §10.82，边界归[运行架构 §8.6](../architecture/runtime-context.md)。

**证据（如实）。** `apps/api` 全量 `tsc --noEmit` 通过；`frozen-model-constraint`/`free-call-guard`/`openai-compatible-free-guard` 三新件单测连既有 `openai-compatible-model-port` 回归 **51/51 通过**——受控 HTTP 用真实 SDK 捕获**最终发出体**，证明零价硬限制到达外呼边界。**这只是请求体形状取证**：真实 OpenRouter 是否接受并据此零结算、跨续轮/重启按持久化快照恢复、选择命令 revision/CAS 与原回执重放均需真实凭据与真实 PG，本轮无凭据且共享工作树有并行实例，**未运行**，不宣称零收费保证成立。

**下一批（阶段 C 剩余依赖，尚未做）。** 「会话选择（`revision`/幂等/原回执重放）Owner + `/model` 接线」已由上一节（阶段 C 第二批）实现，本批只接通默认连接、OpenRouter 目录项如实拒绝。**仍待做的 C-2b（`0090+`）**：OpenRouter 聊天外呼配置解析与真实连接、Run 创建冻结非密钥模型快照，再把冻结约束读取接入五处端口构造点（`run-steps`/`delegate-task`/`conversation-execution`/`conversation-state`/`checkers`）并覆盖目录转收费的下次调用拒绝、`UNKNOWN` 原身份核对。这些改动落在并行实例正在编辑的热文件（尤其 0087 普通 Agent 主循环与前端），且 FM-06/FM-07 出口需空载真实 PG+HTTP，故不预建无当前调用方的表列、不与并行实例抢改热路径。**C-2b 与阶段 D 同受「主循环热文件静默」门控**（用户 2026-10-15 决定停在 C-2a 干净边界）：恢复信号＝`run-steps`/`conversation-*`/`checkers` 与 `apps/workbench/**` 不再被并行实例改动或对方已提交；空载时再整批做，C-2b 须一次接通「OpenRouter 聊天外呼→Owner 停止拒绝 `openrouter`→Run 创建冻结快照→五处端口按 `free_only` 传 `freeGuard`」这条完整链，不拆成无消费者的悬垂步骤。**真实 Provider/浏览器/Windows 仍未做。**

## 免费模型目录同步与严格免费判定：阶段 B 源码实现（2026-10-15）

用户已实际下发[专项任务书](../../prompts/free-model-catalog.md)，完成**阶段 B**：OpenRouter 免费目录同步 + 严格免费判定，以及只读/手动刷新两个新端点。**该轮只交付阶段 B：会话模型选择其后的阶段 C 第二批已落地（见顶部「会话模型选择落地」节，且只接通默认连接），Run 模型冻结与 OpenRouter 聊天端到端仍未做（C-2b）；免费调用硬保护已在阶段 C 首批落地并取证。阶段 D（最小 UI 选择器 + live 客户端接线）未做。** 协议归 HTTP §10.81，物理归[数据库设计 §87（迁移 0088）](../database/physical-design-postgresql.md)，判定规则边界归[运行架构 §8.6](../architecture/runtime-context.md)、范围归[后续路线 §9.1](../requirements/post-v1-roadmap.md#91-免费模型分组与自动同步)。

**做了什么。** 迁移 `0088` 新建两张全局表（`model_catalog_sync_state` 单例发布头 + 跨进程租约 + 失败退避；`model_catalog_entries` 逐条严格判定，随成功发布同事务整体替换）。`ModelCatalogRepository` 作为独占 SQL Owner 经 `unit-of-work` 登记；同步用例 `syncModelCatalog` 把网络拉取放在事务外，租约领取与 CAS 发布各是独立短事务，来源失败保留旧快照与上次成功时间、只记原因并推进指数退避，合法空目录如实清空。严格免费判定按「本次文本调用计价项」`prompt/completion/request` **字符串精确判零**（极小非零不误判为零），缺失/非法/负数/来源新增非零项一律保守拒绝。目录凭据独立于聊天凭据、端点复用 `guardedModelFetch`（公开 https、锁同源与路径前缀、拒重定向、发前复查 DNS），来源/字节/条目/耗时全部有界。`GET /model-catalog`（默认只回严格免费，`?all=true` 连非免费一起供核对）与 `POST /model-catalog/refresh`（结构化 status，非幂等命令）挂在既有 Bearer 守卫的工作区前缀下，与 `/model-port` 同一先例。

**已运行**：严格判定、配置/生命周期决策、来源传输与凭据/端点隔离的定向单测 **26/26 通过**；`apps/api` 全量 `tsc --noEmit`（含集成测试文件）**exit 0**。**未运行**：同步用例的真实 PG 集成测试 `model-catalog-sync.integration.test.ts`（租约去重/CAS 不倒退/失败保留/空目录清空/绝不写 `model_calls`）已编写并通过类型检查，但**本轮未执行**——共享工作树内另有并行执行实例，并发跑 `run-integration.ps1` 会挂死/偶发假失败，留待机器空载时以 `-TestFile model-catalog-sync` 单跑。真实 OpenRouter 外呼、浏览器与 Windows 安装态**未取证**（无授权凭据，用户选择「无凭据/不放行，仅隔离验证」）。

**限制与下一步。** 阶段 B 只交付目录同步与严格判定。其后的阶段 C 分批推进：免费调用硬保护已在首批落地取证、会话模型选择命令（带 revision/幂等）已在第二批落地（仅接通默认连接，OpenRouter 目录项如实拒绝），Run 模型冻结与 OpenRouter 聊天端到端仍未做（C-2b）；阶段 D 的最小选择器 UI + live 客户端接线未做。各批均不预建无当前调用方的表或列。阶段 B 本轮未新增产品验收成绩，实际通过与否以功能验收表为准；不扩展到压缩、Skill 定制或文件恢复。

## 免费模型分组：文档与开发任务书（2026-10-15）

用户本轮仅授权更新文档并交付开发提示词，该轮未启动实现（同日阶段 B 已实现，见上一节）。首版默认 OpenRouter 官方目录、独立免费分组、24 小时成功缓存与手动刷新、具体模型选择、会话覆盖与 Run 冻结、每次调用严格免费准入。范围归[后续路线 §9.1](../requirements/post-v1-roadmap.md#91-免费模型分组与自动同步)，执行入口为[专项任务书](../../prompts/free-model-catalog.md)。后续实际下发时先核对模型选择基础能力和旧 Run 兼容；不重排其他既定开发工作，不启动压缩/定制/文件恢复，不新增验收成绩。

## 目录作用域细条 + 窄窗外壳折叠点（2026-10-15）

**细条**：`/agent` 输入卡上方的目录作用域由居中胶囊改回常驻状态线——整列一条分隔线、内容与输入卡同宽同轴、无圆角无阴影（回到 `design-system.md` 原有规则，此前实现走偏）；目录名 `body`+medium 当事实主角、归属 `meta`+muted 次要、窄窗先省略归属并用 `title` 给完整路径；状态短语只说后果（「执行前需归入项目」/「目录未就绪，暂不能执行写操作」），完整原因仍给读屏与 tooltip；［更换目录］改按 chips 规则的有边框紧凑键。token 零新增。

**外壳折叠点**：由 `width < 64rem` 下移到 `width < 48rem`，48rem–64rem 保留三列（150% DPI 下 960–1440 物理像素不再只剩中栏），该区间侧栏取默认列宽、不采用户拖拽宽度；`<64rem` 块按职责拆成「外壳收纳」与「页面密度」，另修掉无渲染点的死规则 `.brand`。设计与计划见 [spec](../superpowers/specs/2026-10-15-narrow-window-shell-fold-design.md) 与 [计划](../superpowers/plans/2026-10-15-narrow-window-shell-fold.md)（三任务，各自独立提交）。

**已运行**：`tsc --noEmit` exit 0、`vite build` exit 0、`vitest` 920/922（两项既有失败：执行摘要文案与 `run-events` SSE 时序，后者单跑 5/5）、`responsiveTiers` 守卫 2/2、浏览器 96/99（`workbench.spec.ts` 的「宽表在局部滚动」是 2026-10-11 项目页重设计移除右栏后的残留测试，与本轮无关且改前同样失败；另两项在全量并发下不稳定、单跑通过）、`check-docs` exit 0。**未取证**：真实 Windows 窗口 150% DPI 下跨 1024px 拖动的切换观感。

**契约与实现曾脱节，已校正**：`window.content.initialWidth` 写 1280、`minWidth` 写 960，而桌面壳实际以 1160×780 建窗且未设 `min_inner_size`（`apps/desktop/src-tauri/src/lib.rs`）。两条 token 描述已改为「目标约束 + 实现实况 + 为什么不能加强制下限」，窗口尺寸段的窄窗区间同步更正为 `< 48rem`。

## V4.2 工作台接线第二轮：正文读取根因闭合 + 版本可达（2026-10-15）

**根因（先复现后定位，类别 C 环境错配，不是代码或数据缺陷）**：种子「截图种子产物.md」v2 正文读不出，是**存储根不一致**——种子文件发布在 `D:/Relay-Agent-data`（`apps/api/.env` 的 dev 根），而当前调试窗口由 `scripts/test-desktop.ps1` 设 `RELAY_DESKTOP_DATA_ROOT=D:\Develop\Relay-Agent\.relay-test\data`（API sidecar → 127.0.0.1:8728，同一 12525/`relay_trial` 库）。隔离只读 API 实例双向交叉证实：trial 根 → v1/v2 均 503 `EVIDENCE_UNAVAILABLE`（detail 受管内容文件缺失）而清单 200；改用 `D:/Relay-Agent-data` → v1/v2 均 **200** 且正文、sha256、size 与数据库逐字节一致，此时反而是另一成果 503。数据库行、hash、size、版本号、来源均正确；桌面宿主内 API 与 Worker 共用同一 `data_root`（`lib.rs` 831/848），无产品级根不一致。本轮**未改配置、未迁移数据、未动种子**——窗口内可读与否要由用户决定改 `RELAY_DESKTOP_DATA_ROOT` 或迁文件，按停止条件待授权。

**本轮实现**：正文失败透出服务端 detail 真因（MISSING/TAMPERED/UNREADABLE 不再压扁，保留原版本重读）；预览新增同一成果「确切版本」切换（v2↔v1，`aria-pressed`、返回焦点仍是原成果按钮）；进展页 attention 与成果页尾各补一条进入记录页的去处。`tsc --noEmit`、`vite build`、`git diff --check` 均 exit0；vitest **937/939**（两项失败为既有问题：开工基线单次 935/936 只含 `executionSummary` 文案，另一项 `run-events` SSE 时序是已记录的既有 flake、单独复跑 5/5，两项均与本轮改动文件无关）；定向 `taskInspectorPanel` **17/17**；后端 `tsc` exit0、`managed-content-store` **6/6**、真实 PG+HTTP `api-artifacts` 集成 **18/18**。电脑插件实测既有调试窗口：错误真因可见、版本切换后标题/aria/页脚 62 字节同步、返回与关闭焦点、页签方向键/End/Home、成果页尾入口跳记录页；切到任务 `9c6ae9f2` 打开另一成果 **正文正常读出（2439 字节、AI 来源）**，正常读取与历史种子失败在同一真实窗口各自成立；窄窗浮层关闭键可达；项目/资料/全部任务代表页无退化。成绩与限制只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)原 V4.2 行，交互归[工作台 §28.8](../frontend/workbench-design.md#288-v42-工作详情与成果预览接续2026-10-15)。**聊天发送已验**：独立「你好」测试会话真实发出一条无写入意图的测试消息，收到真实模型回复与真实 token 用量，PG 核对新建 Task=0/Run=0（纯讨论未被误判为执行），未触碰用户原会话。**同日第三轮补齐**：A→B 预览隔离、同任务刷新保留预览、判断/编辑/Run 控制入口可达（只读取证，未点决策）、真实窗口 1280×800 与 1440×900 覆盖（本机 125% DPI，物理≠CSS 视口，截图留 `output/v42-acceptance/windows-native-20261015-1280x800.png` 与 `-1440x900.png`，窗口已恢复最大化）。**V4.2 正文读取修复完成（2026-10-15，用户指令「修复发现的问题」授权）**：把缺失的两份受管内容从 `D:/Relay-Agent-data` **复制**（保留源文件）到窗口实际使用的 `RELAY_DESKTOP_DATA_ROOT`（`.relay-test\data`），复制前后 sha256/size 与数据库登记值逐字节一致（v2 9e02…/77B、v1 f1ca…/62B）；未改数据库、hash、正文、版本号、接受事实、配置或种子原文件。真实窗口复验：v2 与 v1 正文均读出、版本切换同步，**历史种子 v2 正文在当前窗口由「未通过」转为通过**；截图 `output/v42-acceptance/windows-native-20261015-seed-v1-readable.png`。**未验证**：安装包、多 DPI、IME。

## 普通 Agent 连续工具主流程（2026-10-15，文档与任务书）

用户确认普通 Agent 不再固定拆成无工具聊天、执行解释、状态维护解释三条独立模型分支。目标是一条原消息主流程按必要工具推进并回到原会话：纯读取复用会话只读机制、不制造 Task/Run；文件修改/检查沿原 Task/Run，业务维护沿原 Owner；确定性模板路由、模式隔离、权限、控制、UNKNOWN 与业务完成边界保持。产品规则归总纲 §0.5.1，取舍归 ADR-022，工程责任归领域模型 §12.6，交互归工作台 §18.10，验收规格归测试计划 §17.2。

本轮授权仅更新文档并交付[重构任务书](../../prompts/agent-conversation-main-loop-refactor.md)，不修改代码、运行协议或数据库，不宣称截图原消息已完成根因复现或读取已修复。下一步由用户实际下发任务书后，核对源码及现有会话只读/Run/状态维护入口，先复现，再按持久身份、兼容与停止边界分批重构；不重做已实现模块或扩展为新 Runtime/多 Agent 项目。

## 阶段 A/B/C 已实施（2026-10-15，接上一节）

用户已实际下发该任务书，本轮完成**阶段 A（复现＋最小持久协议）、阶段 B（会话只读闭环）与阶段 C（执行候选、状态维护候选、会话↔Run 推进责任与会话内 Run 排他）**；**阶段 D 未做**。实际成绩与限制只看[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)“普通 Agent 连续工具主流程·阶段 A/B/C（2026-10-15）”行，本节不重复数字。

**复现到的根因（不是截图推断）。** 普通 AGENT 会话此前在 `assist-runner` 主分支里**不声明任何工具**，模型一旦请求工具就被结算成 `TOOL_CALLS_WITHOUT_DECLARED_TOOLS`；同时「这条会话绑定哪个目录」只存在于浏览器组件状态，服务端只能按项目**取第一个受管资源**。这正是用户看到「没有文件读取能力」的结构性来源。

**一个实测到的额外事实**：`method-intent.ts` 把 `readme` 列为 `docs-maintenance` 的触发词，所以任务书自己举的「读取 README.md」会被绑成**方法轮次**，而方法轮次同样没有任何工具——尽管方法模板自己要求「只依据实际读取到的内容下结论」。已改为：方法轮次保留自己的模板、但同样拿到只读工具，而不是为它新造一个合并 schema。

**阶段 C 第一段做了什么。** 主流程收尾那一次模型输出改为 `{reply, execution}` 信封，候选经**既有** `validateConversationCandidate()` 判定后落进**原** `conversation_execution_requests` 行（复用原 `claimExecutionRequest`＋`saveInterpretation`，准入、幂等与三个阶段命令身份只有一份实现），因此**不再需要第二次解释模型调用**。本段**不自动应用**：`applyConversationExecution` 与 `auto_start` 未改，Task/Run 仍只在用户动作后出现。信封解析刻意容错——不是信封就当普通回复，模型编造候选时最多「这一次没整理成候选」，绝不会凭空造出 Task/Run。

**阶段 C 第二段做了什么。** 同一信封再加 `maintenance` 字段，形状与旧解释入口的输出**完全相同**——合法性仍只由既有 `validateStateMaintenanceCandidate()` 判定，主流程没有为状态维护另立一套更宽松的规则。`recordStateMaintenanceCandidate()` 复用原 `claimStateMaintenanceRequest()` 与 `settleStateInterpretation()`，因此基线冻结、幂等、必要决定、独立条目、部分成功与整组撤回**都只有一份实现**；`maintenance: null` 不产生任何请求行，所以纯讨论与文件读取的零状态写入是被断言守住的。**这里有一个必须真实处理的时序红线（R3）**：旧入口在**自己那次**模型调用之前 claim，基线因此天然新鲜；主流程的模型调用发生在更早，等到拿到信封才 claim，冻结到的就不是模型看到的那一版，模型在途期间的人工修改会被吸收成原基线。因此新增 `freezeStateInterpretationBaseline()`，在**发出模型请求之前**取一次快照，经新的可选 `frozenBaseline` 原样传下去。执行候选与状态维护候选各用**分开**的派生命令身份，两张请求行各自幂等、互不覆盖。同样刻意**不自动应用**：`applyStateMaintenance` 与前端「明确指令自动生效」都未改。

**阶段 C 第三段做了什么（推进责任与会话内 Run 排他）。** 先补 RED，实测到的缺口很具体：同一条会话里，第二条**同样明确**的修改请求也会走到建 Task／Delegate，于是出现**两个 Task、两个 Run 并行推进同一目录**——正是任务书点名的「聊天和后台各自规划出同一套工作」。因此 `applyConversationExecution()` 在**建 Task 之前**新增一道 `findLiveRunForSession()` 守卫：问「这条会话上是否已有**别的**请求到了 DELEGATED、且它那个 Run 还没收口」，有则按类型化 `EXECUTOR_CONFLICT`（409）拒绝，并在 detail 里指回原 Run——调用方该去接续那条链，而不是另起一条。守卫放在建 Task 之前，因此被拒绝时不会留下半个 Task，原链的请求→Task→Run 指认也不动；活动状态集与 Task 级 `findLiveRunForTask()` **逐字一致**，「活动」这个定义不能在两处各写一份，否则收口语义会悄悄漂移。原 Run 收口（`FAILED` 等）后，同一会话仍可正常再发起执行，接续不被历史活动误挡。消息轮次本身不驱动 Run：委托之后再跑消息 tick，没有新消息就不启动，也绝不改变 Run 状态。

**阶段 C 通过条件核账**：AM-05–09 已有定向 PG 证据；「不存在两套相同工作」现在由会话内排他守卫与 `findLiveRunForTask()` 双重守住。

**下一步按顺序**：
1. **阶段 C 余下**——Run 结果按**原身份**投影回原会话（AM-06 后半）：可展开原产物、工具与检查依据；业务完成仍只由原验证/人工接受/完成用例推进，不因模型说「完成了」自动提交。这是阶段 C 唯一还没做完的一段。
2. **阶段 D**——迁移前端「由新发消息自动发起解释」这 13 条规格反例后，再删掉 `AssistView` 里的解释调用。当前删掉会让它们转红，因此已回退；服务端侧的第二次模型判定已经消除。

会话读取轮次尚不做流式预览（与人设档、学习档一致）。真实 Provider、Windows 窗口与安装仍未验；本轮未重打包，**用户当前窗口没有加载本次代码**。

## 工作台 UI 对齐 V4.2 页面原型（2026-10-14）

用户给出 `GPT页面原型/Relay_V4.2_工作详情与成果预览.html`，要求按原型重构 UI 且不改功能与业务逻辑，并选定「全站统一视觉 / 接入现有 token 体系」。当前 Agent 把原型那套冷绿语言收敛进唯一 `docs/frontend/design-tokens.json`（只改基础色与语义别名，不新建第二套色值表），因此配色、卡片与徽标圆角、卡片投影一次改动即传播全站；原型过浅的 `--muted`/`--warn` 在同色系内加深到通过既有 4.5:1 门槛。右侧 `TaskInspectorPanel` 重构为原型「工作详情」三页签（进展/成果/记录）与成果深预览。

无新依赖、无迁移、不改业务规则、命令 Owner、API、路由与任何写入路径；`tsc --noEmit` 与 `node scripts/check-docs.mjs` 通过，`vitest run` 918/919、`playwright test` 92/96，5 例失败全部为既有问题（其中 2 例已用「token 还原到 HEAD 后仍复现」直接排除）。顺带修掉一处真实布局缺陷：工作详情打开时四栏走 flex，成果栏按自身内容宽度抢占空间，1280 宽下中栏只剩 71px，现改为沿用双栏比例的网格。2026-10-15 按用户要求把所有横向列宽改为「百分比 + 上下限」（clamp），不同分辨率下比例一致；修掉两个对应 CSS 陷阱：clamp 的 `%` 在网格里会拿轨道宽当基准（必须写在 `grid-template-columns`）、拖拽手柄与列宽必须同源。设计取舍归 design-system §9.8/§9.9，实际成绩只归统一验收表「工作台 UI 对齐 V4.2 原型」行。原型的「变更」页签无真实 diff 数据源故未实现；真实 Windows WebView2 字形、DPI、IME 与全站逐页视觉仍未验收。

2026-10-15 页面重构接续：用户中途要求停止子代理，后续由当前 Agent 直接完成接线修复、布局、测试与浏览器复核。工作详情现可从真实成果清单打开确切版本；清单/正文错误、重读、跨任务隔离、键盘与返回焦点分别处理。聊天＋详情收起独立成果栏但保留挂载，人工判断与用户选定布局可恢复；修复双视图容器漏传高度导致输入卡停在页面中部，并按现有 token 收紧标题。Run 完成、待判断、失败与任务正式完成不混淆。交互归 workbench-design §28.8，范围与执行输入见[任务书](../../prompts/v42-workbench-refactor.md)，本轮实际成绩与既有失败只在统一验收表原 V4.2 行维护。仍未重新打包或验证 Windows 安装应用，不扩大为后端或运行时改造。

同日按用户指定的“电脑”插件，直接操作既有 `relay-desktop.exe` 调试窗口与本机 API 复查；未派子代理。补修窄/短窗标题旧覆写、人工执行者与无 Run 完成提示、正文不可用时误套完成拒绝文案。现有种子任务的真实 v2 正文重读后仍不可用，未修改种子、数据库或真实文件；具体通过项与这一未通过项只维护在统一验收表，不把此前夹具正文成功继承为真实 WebView2 正文通过。当前调试窗口加载 5173 前端；安装包未重新交付。

## 任务链基础修改与检查接续（2026-10-14）

当前 Agent 单独把原普通文件修改、配置检查、范围授权和明确 MODIFY 方法接入现有任务链。创建只保存候选规格；明确执行授权后原 Delegate 按项/Run 签发范围，不超过链期限、不跨 Run 终态。原变化集基线和真实子进程结果可读，检查失败可在原循环修正后重查，原人工验收完成后才接下项；未给范围授权时走原 ACTION_APPROVAL，DENY 不覆盖，INSPECT 不进入修改。前端只扩原客户端，无 UI。

复用 0085 规格与既有 Run 授权表，无新迁移或依赖，不升级用户库；协议归 HTTP §10.79、数据库 §86，领域模型 §21/ADR-021 接续 Owner，检查范围归测试计划 §30，实际成绩只归统一验收表「任务链基础修改与检查」行。后续继续核对其他独立基础模块；自定义 Skill/方法、活动无缝续期、UI、真实 Provider/Windows 与完整 N06 仍未通过，不扩大到并发故障全矩阵。

## 任务链基础只读文件与来源接续（2026-10-14，前序切片）

当前 Agent 单独在原任务链项追加只读执行规格：支持原固定文件读取或限定目录/文件工具循环，选定确切资料版本和原会话 INSPECT 方法。资源身份/配置、连接和来源依据保存，在原 ready/Delegate 新准入时核对；原 Gateway/权限与工具账本承担实际读取和拒绝，不由链批准。原方法定义/消息、资料和动作进入同一 Run，原人工验收完成后再继续；前端只扩原客户端，无 UI。

0085 只追加 execution_spec 列，旧项为空、旧摘要不变，无新依赖、不升级用户运行库。协议归 HTTP §10.78、数据库 §86，领域模型 §21/ADR-021 接续资源配置与领取 epoch 边界；检查范围归测试计划 §30，实际结果只归统一验收表「任务链基础只读文件与来源」行。首轮误冻结领取 epoch 导致正常读取后下一项失效，已改核对资源配置/身份；不删除原隔离或权限检查。后续接已有受控写入/检查范围或其他独立基础模块；文件写入/CLI、自定义方法、UI、真实 Provider/Windows、并发故障全矩阵与完整 N06 尚未通过。

## 基础有限 Markdown 任务链接续（2026-10-14，前序切片）

当前 Agent 单独接 N06 第一片：创建固定既有任务范围不执行，明确确认累计任务/调用限额与有效期后沿原 ready/Delegate/Run/LangGraph 串行推进；上一项原人工验收和 COMPLETE 的确切 Task/Run/Completion 基准满足后才进入下一项。调用预留与原账本 STARTED 同事务，未知保留占用；暂停/撤销/到期复用原持久控制，实际应用前保持 PAUSING，重开先人工确认，原身份/文件/累计消耗保持。前端只接五个方法，无新 UI。

0084 纯追加两表，无新依赖，不升级用户运行库；责任/取舍归 ADR-021、领域模型 §21，协议归 HTTP §10.77、数据库 §85，检查范围归测试计划 §30，实际成绩只归统一验收表「基础有限 Markdown 任务链」行。首片只允许内部 Markdown 成果，不带外部工具或资源；来源/方法/工具范围、活动中续期、真实 Provider/Windows/故障全出口和 N06 整体仍未通过。后续先接已有工具循环的有限范围或核对其他独立基础模块，不以本片宣称整个任务链或 M/N 总交付完成。

## 基础一次性继续项目提醒接续（2026-10-14，前序切片）

当前 Agent 单独接 N05 基础功能：确认绝对时刻与原时区、配置 revision/实际时刻代次、API 存活期间扫描、独立到时/错过事项和 HANDLE/DISMISS；暂停/禁用/继续不重复原发生，改时间保存新发生而保留旧待处理。客户端提供配置/事项/原计划引用，原通知轮询在没有必须介入事项时投递项目提醒，复用宿主权限和投递回执，旧点击先重读当前项目/事项；没有新页面、样式或布局。

0083 纯追加两表，无新依赖，不升级用户运行库；协议归 HTTP 契约 §10.76、数据库设计 §84、领域模型 §20，基本检查归测试计划 §29，实际结果只归统一验收表「基础一次性继续项目提醒」行。触发与通知均不创建计划/Task/Run/模型请求；API 关闭停止扫描，Schema 未就绪/维护排空不写新发生。下一步核对 N06 任务集合、原委托/完成/控制与预算入口后接基础有限任务链，继续由当前 Agent 完成。设置/待处理 UI、Windows 原生投递、完整 PV05/PV08、收益与 M/N 总出口仍未据此通过。

## 基础固定容量范围推演接续（2026-10-14，前序切片）

当前 Agent 单独沿 N04 基础计划接第 3 批范围比较：用户从未应用的既有计划发起，在同一容量/窗口/Task/验收/估时/Goal 基线下保存 ALL/SHRINK/DEFER；缩小任务集保留必要前置，推迟指定任务传播至下游，来源/未知与延后影响可读，不改原验收。显式不可靠估时按未知/必要诊断处理，资料与权限仍待执行核验。用户选方案经原计划 Owner 生成新候选，再由原入口逐项接受/拒绝；选择本身不建 Task、启动 Run 或授执行权，客户端读回部分结果。

0082 只追加推演表，无新依赖、不升级用户运行库；协议归 HTTP 契约 §10.75、数据库设计 §83、领域模型 §19，基础场景归测试计划 §27，实际结果只归统一验收表「基础固定容量范围推演」行。前端只接四个方法，无 UI、自然语言发起、自动推演、任务内部验收缩减或收益验证。后续继续核对 N05 一次性提醒等独立基础模块；完整 N04/N05/N06、Windows/安装和真实使用收益未借此放行。

## 基础下一段工作计划接续（2026-10-14，前序切片）

按用户继续实现基础文档模块、只做前后端功能的授权，当前 Agent 单独接 N04 数据片：原 Task 估时按验收周期追加，本段容量与诊断预算由用户手动提供，固定窗口下按明确目标/主线、BLOCKS 必要前置、原优先级/截止日期生成候选，逐项接受/拒绝。未知关键估时提出独立诊断，接受沿原 Task Owner 建 ME/HUMAN/INBOX 与自己的输出/验收；原任务不完成，计划不授执行权限。前端只加客户端，无 UI、日历、后台自动重排或会话新候选。

0081 纯追加估时/计划两表，无新依赖，不升级用户运行库；协议归 HTTP 契约 §10.74、数据库设计 §82、领域模型 §18，检查范围归测试计划 §28，实际结果只归统一验收表「基础下一段工作计划」行。估时分项不重复相加，未知总时间不从分项推算；计划保守串行，不推测跨任务重叠收益，资料/权限缺口仍待原执行入口核验。下一步复核 N04 基础片可供范围推演复用的候选/容量/逐项应用，再接其他基础模块；完整 N04/PV04、N05/N06、UI、真实 Provider 和实用收益未据此通过。

## 基础工作段预期与产出复盘接续（2026-10-14，前序切片）

当前 Agent 单独接第 3 批工作段数据功能：保存同项目既有 Task/验收/Goal 引用与确认预期，结束保存本段完成记录/确切产物引用、未完成或基线变化、Task 范围已登记用量和未知。返工/人工介入先候选，确认后计入、撤回保留历史，结束事实不被后续事件纠正改写；临时回顾按当前验收周期读取最近登记预期，缺失项保持 UNKNOWN。前端只接客户端，原会话支持“接下来做这几项，结束后复盘”，不创建 Task、启动 Run 或应用计划。

0080 追加工作段/事件表与会话候选，无新依赖，不升级用户运行库；协议归 HTTP 契约 §10.73、数据库设计 §81 和领域模型 §17，实际结果归统一功能验收表「基础工作段预期与产出复盘」行。用量覆盖范围仅已有 Task 绑定调用账本，金额没有历史记录，不能补估；完成引用不等于新增文件可用性核对。后续先核对 N04 的当前计划/容量/应用前置，再接基础范围推演或其他独立文档模块，不借此宣称整个第三批、UI、真实 Provider 或收益已完成。

## 基础决定前提与复审接续（2026-10-14，前序切片）

当前 Agent 单独接第 2 批决定复审数据链：明确登记本项目决定依赖的资料版本或假设，Knowledge 新版本/归档（含事务内组合入口）、Hypothesis 定义/观察/用户结论变化时在原事务中准备候选，关联资料变化可传播至假设前提；只保存未确认假设建议不触发。相关命令回执提供新候选数量和项目查询入口，前端提供登记/读取/处理方法，不做 UI 或后台监控。

0079 纯追加前提/候选表，无新依赖，不升级用户运行库。前后引用、决定/前提版本及指纹去重由复审入口保存；用户保留决定或忽略候选留理由/历史，不改变 Decision/Task/Run。替代仍走原 Decision Owner，来源再次变化或决定替代后旧候选不可行动。协议归 HTTP 契约 §10.72、数据库设计 §80 与领域模型 §16，实际结果归统一功能验收表「基础决定前提与复审」行。本节保留前序切片，基础工作段复盘已由上节接续；UI、真实模型分析/解释和收益试验仍未验证。

## 基础假设记录与用户结论接续（2026-10-14，前序切片）

按用户继续开发基础文档模块的授权，当前 Agent 单独进入第 2 批假设数据功能：项目内建档、不可变定义版本、观察追加、候选建议和明确用户确认，前端提供 API 客户端；会话“把这个想法记成假设”沿原状态维护链建档，缺主张/方法/标准先澄清。假设应用入口拥有新记录，Knowledge 只提供确切来源引用，Task/Run/Verification/Review/Decision 责任不变；没有新 UI、模型分析后台或统计平台。

0078 为追加表/候选值，无新依赖，不升级用户运行库；协议归 HTTP 契约 §10.71、数据库设计 §79 与领域模型 §15，实际检查归统一功能验收表「基础假设记录与用户结论」行。来源、定义或观察变化后保留旧结论并标不再适用，停止投入只是候选建议。本节保留前序切片，基础决定复审已由上节接续；消息/Task UI 双入口、真实 Provider 解释质量及收益试验仍未验证。

## 基础会话验收耗时补录接续（2026-10-14，前序切片）

当前 Agent 在原会话状态维护链追加 REPORT_ACCEPTANCE_TIME，解释前冻结试用身份/版本，用户一句话补录准备与整体验收耗时；数字和单位按原文核对，试用不唯一或口径不明沿原澄清入口。应用沿原观察 Owner 和原命令回执，保留未提到的原耗时及纠正历史，读回来源消息；不改变 Task/Run、计时状态或正式验收。前端只接客户端方法与来源解析，不改 UI。

0077 只追加候选值和观察来源列，无新端点或依赖，不升级用户运行库。实际检查归统一功能验收表「基础会话验收耗时补录」行；可控解释与真实数据库/HTTP 分开限定，不据此认定真实 Provider 解释质量或窗口可用。基础验收数据链已覆盖材料、计时、补录和比较；本节保留前序切片，基础假设记录已由上节接续，消息/Task UI 双入口留待重构，正式收益试验未运行。

## 基础验收对比接续（2026-10-14，前序切片）

在材料与试用记录上继续接前后端基础比较：已结束原流程记录冻结 revision、人工观察 ID、用户目标百分比和样本口径，新证据试用在开始时绑定基线；读取全部关联样本，分别比较找证据、准备和已含准备的总验收耗时。缺项保持未知，漏验自述不算成功，材料/验收/基线变化保留历史并标过期。不做 UI、统计平台或压力测试，也不把单样本状态当实际收益证明。

0076 为纯追加表/列，比较应用入口只写冻结参考、原试用入口保存样本与人工自述，Task/Run/Verification 责任不变。协议归 HTTP 契约 §10.69 与数据库设计 §77，实际验证归统一功能验收表。本节保留前序切片，基础自然语言补录由上节接续；消息/Task UI 双入口继续留给后续重构，正式收益试验未运行。

## 基础验收材料与试用记录接续（2026-10-14，前序切片）

按用户继续开发文档模块的授权，当前 Agent 单独接第 1 批基础数据功能：文本/Markdown 沿原 Knowledge 导入，按 Task、验收修订、条件与确切被测版本关联，查询缺项、材料可用性与版本匹配，撤销保留历史；新增原流程/证据视图试用、开始/暂停/继续/结束和人工准备/总耗时补录，原流程可独立记录，纠正保留来源历史。前端只加 API 客户端、DTO 与解析，不改 UI。

材料和试用应用入口各自拥有新增记录，Task/Run/正式 Verification/Review/Completion 沿原 Owner；0074/0075 为纯追加迁移，无新依赖，不升级用户运行库。协议及实际验证归各自事实源，不把基础正常流程扩成压力测试或整体交付。本节保留前序切片范围，冻结基线与基础对比已由上节接续；自然语言补录、消息/Task UI 双入口和后两批能力仍未接入，收益试验尚未进行。

## 基础前后端功能接续（2026-10-14）

用户收敛范围为最基础的前后端功能，前端 UI 后续由用户重构，本轮不做布局、样式或页面重构，不扩展极端场景和压力测试。当前 Agent 单独修正执行客户端：`applications` 的成功响应是命令回执，Task/Run 等阶段字段须从 `result` 读取，不能从顶层读取而把已成功委托解析成失败。复用已有后端接口与业务 Owner，无新 API、migration 或依赖。

补齐普通会话的基础正常组合检查：HTTP 消息与解释请求 → Task/Run → 生产 Worker/LangGraph 真实读取 → 成果内容 API → 人工验收 → 完成记录。使用独立 PG 与本地 Fake，结果和限制只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「基础前后端执行组合」行；不据此升级真实 Provider、Windows 或安装出口。后续仍按基础功能缺口推进，UI 重构不在当前范围；模型切换、压缩、定制和完整恢复继续后置。

## 基础执行请求接续（2026-10-13）

用户继续授权基础功能开发，当前 Agent 单独补齐原请求接续：任务已建立但执行准备失败时，会话读回真实阶段并保留继续入口；原委托已经提交而请求阶段保存失败时，按原命令回执核对并关联原 Run。沿用现有 Task/Run、权限与维护准入，无新接口字段、migration 或依赖，不扩展压力测试。

数据库反例与页面反例已先复现后修正，实际结果及窗口限制只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「基础执行请求接续」行。本轮电脑插件只观察已有开发窗口，未停止或修改该实例，不把项目页观察算作新接续链验收。后续继续普通用户会话到执行/成果回执的基础组合；模型切换、压缩、定制与完整恢复仍后置。

## 基础执行结果展示补齐（2026-10-13）

用户继续授权后续基础开发；当前 Agent 单独修正普通 Agent 结果展示，不扩展模型切换、压缩或压力测试。工具回执 `outcome: FAILED` 即使没有 `reason`，聊天摘要和逐步轨迹也明确显示失败；失败写入不计作完成写入，缺失结果显示「结果未提供」，已有结果时仍展示在途调用。读取/检索与写入按调用次数呈现，避免把目录浏览算成文件数、把一批变更算成文件处数。只消费原回执，不改权限、运行账本或完成条件。

新增正常失败→修正→复检、在途与缺失结果反例先复现，随后定向组件与构建通过；具体成绩只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「基础执行结果展示」行。此次没有更新测试目录包中的摘要，因此当前源码组件证据不冒充该包的 Windows 运行结果。

电脑插件本轮已能激活、导航、输入并操作原自有 Relay 窗口，补验已有命令菜单展开和方法选择只插入草稿；PG核对零消息/Run/模型调用/完成记录。未复制模型密钥、未调用真实 Provider。原完整文件执行/用户会话组合仍未验；自有草稿与窗口、独立 PG 已收尾，原 Session 记录只作历史，不再代表可用环境。后续优先补普通用户会话到执行/成果回执的基础组合路径；完整模型切换/压缩/定制/恢复继续后置。

## 电脑插件窗口验收：等待桌面输入恢复（2026-10-13，原准备轮）

接续状态：本轮已恢复有限窗口操作并收尾原自有环境，实际结果见上节和统一验收表；以下保留最初准备与输入阻塞时点，不能再按原 Session 记录宣称环境仍在等待或复用其已删除的 PG。

用户明确要求 `computer-use` 验收。本轮已从当前源码重建 `test-release` 并启动独立 PG/Graph 与真实 Relay/WebView2 窗口；准备合成工作目录及原领域入口的受控读写连接，没有改用户原配置/运行数据库。插件成功读到当前窗口的工作台/项目导航和连接状态，但激活原窗口、重新选择窗口后的唯一重试均返回 `GetCursorPos failed: 拒绝访问 (0x80070005)`，因此没有执行点击或输入，也没有取得常规会话/文件执行的 Windows 通过证据。具体结果、包身份与限制只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「电脑插件常规 Agent 窗口验收」行。

已请用户解锁并返回普通桌面（若原本未锁定则说明状态）；还在等待是否允许把现有模型配置临时复制到自有验收 `desktop.env` 的明确回复，未写入模型密钥。当前窗口使用本地 Fake，未发模型请求。自有验收窗口/PG 暂留以便桌面恢复后接续，不能在输入访问失败时宣称窗口已正常关闭；会话由本机 `output/acceptance-raw/computer-agent-20261013/session-ref.json` 指向，后续只按该记录操作与收尾。下一步先重新观察窗口，再进行菜单/普通会话、有限读写及成果回执的真实操作，不用 API 或浏览器夹具替代窗口动作。

## 常规 Agent 主链复跑与顺序修正（2026-10-13）

用户要求常规 Agent 能力没跑通就继续。本轮当前 Agent 单独复跑普通读写、已配置检查及失败修正，先取得基础真实 PG/文件证据，再使用既有 `openai-compatible / agnes-3.0-flash` 配置在自有隔离目录和数据库做生产 Worker/LangGraph 的真实模型修复探针，每个 Run 调用上限限定为 16，不改用户配置或运行数据库。

首轮真实模型完成修复却未满足“先检查再读取”的原任务顺序，定位为 DRAFT 固定“先查找与读取”覆盖冻结目标。最小修改工具模板遵守冻结顺序，要求检查优先时先取实际输出、下一轮再据证据读取/修复；读写权限、UNKNOWN、原动作身份和人工完成门保持原链。两条工具模板版本更新为 `1.0.1`；补提示词定向反例，保留真实模型原行为断言。随后发现真实模型探针的检查清单预期未跟上现有 `trust_basis` 协议，改为委托前实测并校验完整入口/脚本摘要，没有删失败断言。

修正后真实模型、检查失败修正与候选保存/重放已跑通；精确成绩、初轮失败和限制只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「常规 Agent 主链与检查顺序」行。当前源码已取得所列常规后端能力证据，仍需真实用户会话解释、产品配置与 Windows 窗口组合验证；不把合成目录的单次模型成功当整体交付或稳定性。模型切换、压缩、定制与完整文件恢复仍后置，不继续扩展压力测试。自有 PG/合成目录全部收尾，未停止用户实例、未 commit/push、未派子代理。

## 基础聊天命令菜单接续（2026-10-13）

用户继续授权基础开发。本轮由当前 Agent 单独补首条与已有会话的 `/` 菜单：按需读取既有后端登记，支持中英文检索、用途/默认范围与接入状态、键盘和鼠标插入、退出保留草稿、清单失败重试；选择只编辑原草稿，发送仍沿原会话/方法入口。普通档显示登记方法，学习/人设档保持原只读身份；模型切换、压缩、定制与完整文件恢复未扩展，无 API/数据库或依赖变更。

浏览器发现内联菜单会把窄窗口输入器挤出视野，已改为上方浮层并保留失败几何断言；相关断点布局测试改为等待真实输入草稿恢复后量几何，未降低断言。结果与当前保留失败只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「基础聊天命令菜单」行。`computer-use` 在自有 Chrome 夹具窗口连续返回身份校验错误，未取得插件操作或 Relay/WebView2 菜单验收；自动浏览器/组词模拟不计真实 Windows/IME 或 Provider 通过。

后续仍优先基础 Agent 使用缺口及本片真实窗口补验；`/model`、`/compact`、自动压缩、定制 Skill 与完整消息文件恢复后置。未改用户 `.env` 或运行数据库、未停止用户实例、未 commit/push、未派子代理；自有测试窗口与服务已收尾。以下小节保留各轮时点，其中菜单未实施的表述已由本节接续。

## 基础会话入口：Windows 验收与显示修复（2026-10-13）

用户继续授权基础开发，并指出验收使用电脑插件；当前 Agent 单独使用 `computer-use` 的 `@oai/sky` 操作真实 Relay/WebView2 窗口。先从当前源码生成测试目录包，在独立 PG/Graph 环境验证首条普通消息、`/clear` 和原历史读回；随后修正真实窗口发现的两个基础显示问题：同名会话选项增加设备时区下的更新时间和「当前」标记，近期工作按协作页发布的确切会话 ID 读回该行，保留已加载任务分页，不维护第二套业务状态。

最终两处修复通过当前源码的开发 Windows 窗口复核，另验证普通/学习档 `/new`、学习首条消息/记录面板/后续记录关闭，以及 `/undo` 的具体回执指引。所有模型均为本地 Fake，真实 Provider 与完整状态撤回、安装总出口不据此通过；修复前目录包与最终开发窗口分别限定证据，未重新打含最后两处显示修复的发布包。实际结果与限制归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「基础会话入口 Windows 验收与修复」行。

自有验收窗口、开发 Vite 和独立 PG 已收尾，测试集群删除；未改用户 `.env` 或数据库、不 commit/push、不派子代理、不扩展压力测试。后续仍优先基础 Agent 使用缺口；`/model`、`/compact`、定制 Skill、自动压缩与完整消息文件恢复继续后置。下节“真实 Windows 尚未验证”是该输入实施轮时点，本节只补所列实际窗口路径。

## 基础聊天命令输入接续（2026-10-13）

用户要求继续开发并明确不再开子 Agent。本轮由当前 Agent 独自接已有基础控制：已有会话输入 `/clear`、`/new`（含既有中文别名）通过原 chat-commands 端点创建空会话，核对原回执与新会话身份/绑定后切换，原历史保留；响应丢失或详情暂不可读时保留原命令 ID，可查回执或原载荷重试。未发资料、补充输入、学习记录草稿与在途状态调整先处理后再新建，尚无会话时系统命令只说明使用条件，不创建再清空，也不发模型消息。

`/undo` 明确引导用户在具体消息下点击「撤回本次调整」，沿已有目标、范围确认、原撤回身份与补偿 Owner；不猜历史目标。`/model`、`/compact` 明确提示尚未接通。基础正常流程检查结果归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「基础聊天命令输入」行；这轮无 API/数据库变更、不新增压力测试，也未升级用户运行数据库或调用真实 Provider。以下后端轮中“前端命令未接线”仅表示该轮时点；输入接续已由本节覆盖，命令菜单与真实 Windows 操作仍后置。

## 基础 Agent 后端接续（2026-10-13）

用户要求继续基础 Agent 后端，只需功能链路能通、不做严格或压力测试，并明确要求多开子 Agent。主 Agent 负责方法到执行主链，两个实际派发的 `gpt-6.1-sol` 分别负责基础会话控制与模型工具续轮，按整文件所有权协作；主 Agent 统一检查接缝、构建与有限真实 PG/HTTP/文件流程。未启动新 UI、模型切换、压缩、定制 Skill、压力/收益实验，也未 commit/push、改用户 `.env`、停止用户实例或调用真实 Provider。

**本轮实现**：① `/diagnose 修好…`、`/docs 更新文档…` 的明确修改行动从解析/消息冻结一致进入原执行候选，再随 Run 契约保留方法快照、参数与原消息来源，复用 Task/READY/Delegate、读/改/检查、候选保存和原人工判断入口；只读方法不因模型输出获得写能力，学习/人设助手不能直接进入普通执行。② `POST /assist-sessions/{id}/chat-commands` 接通 `/clear`、`/new` 与使用原 `undo_command_id` 的 `/undo`，保留身份/绑定/历史及原回执；前端命令输入尚未接线。③ 工具续轮保留实际 assistant 正文与可选 `reasoning_content`，通过 migration `0073_model_tool_turn_assistant_message.sql` 随 Run 工具账本持久；旧 NULL 不补造历史，SDK 局部回填不改变原计量或权限。

**接续边界**：当前已收敛到上述基础后端，实际结果只看[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「基础 Agent 后端三个模块」行。新增工具协议运行前需将数据库升级到 0073；本轮只迁移了自有隔离测试库，没有更新用户运行实例。真实 Provider/Windows 与完整前端命令操作仍未验，`/model`、`/compact` 和 `SKILL.md` 定制继续后置。以下日期段是原时点状态，其中“方法写链未接通/系统命令只解析”不再是本轮基础实现状态。

## 学习模式工作包 C：基础功能（2026-10-13）

用户选择继续工作包 C，随后明确「只需要最基础功能，不需要各种压力测试」。本轮由当前 Agent 单独完成学习档切换、自由学习首条消息、记录查看/接续、UI 纠正/单项删除/全清、消息级与会话级记录开关，以及明确转入普通执行会话。复用现有 Assist、命令回执、目录和草稿 Owner；只同步相关文档，不自动提交或调用真实 Provider。

后端补 `GET /learning-sessions/{id}/state`，读取持久记录控制与最近 200 个轮次的最小状态；明确 UI 纠正可省略 `source_message_id`，模型增量仍严格校验本轮依据。首次记录控制 CAS 的缺行版本 0 已补原子插入，不扩大权限、不新增 migration。前端学习身份不触发执行/状态维护解释，不提供 Skill/提案；转执行新建 AGENT 会话，带学习目标、可编辑的最近回答与当前可用来源，后续沿原执行、权限与验收链。

**当前接续**：基础功能实现及所列定向检查已收口，结果与限制只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「学习模式工作包 C 基础功能」行。本轮不扩展压力/负载测试、成本实验或工作包 D。真实浏览器与前后端组合、Windows/IME/DPI、真实 Provider 与效果仍未验；学习对话中的自然语言执行请求尚不自动跨会话转发，当前使用明确「转入执行」入口。以下日期小节保留当时状态；其中 C 未实施的表述不作为当前缺口。

## 后端验收整改与回归收口（2026-10-12）

按[后端修复与回归收口任务书](../../prompts/remediation/backend-acceptance-remediation-20261011.md)执行：逐项复现并修复 2026-10-11 后端独立验收的 **R1–R8** 八个真实反例，把有效独立反例转为正式测试，修正迁移/CLI 数量断言与 f24 并发测试时序，再跑真实 PG/HTTP 定向与全量回归。具体成绩、环境阻塞与未覆盖项只归[功能验收表本轮行](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。未修改 `.env`、未停用户实例、未 reset/stash/clean、未 commit/push、未调用真实 Provider、未实施新 UI。

**8 个反例全部闭合（实现 + 正式回归，红→绿）**：

| 反例 | 根因 | 最小修改 |
|---|---|---|
| R1 显式 Skill 与自然语言方法双写导致 HTTP500 | `requestAssistMessage` 对含 `skill_ref` 的消息仍跑自然语言方法识别，同条消息写 `skill_snapshot` + `method_snapshot`，撞 `0071` 的 `ck_assist_message_method_exclusive` | `assist-commands.ts`：显式 `skill_ref` 走 `resolveMethodFreeRequest`（保留 `/命令` 输入校验，不绑定方法身份）；无显式 Skill 的原路径不变 |
| R2 失权 Worker 的迟到结算仍写学习证据 | 结算只看轮次状态，不核对领取身份 | `applySettlement` 在同一事务内核对消息仍 `RUNNING` 且 `worker_id` 匹配；失权 → `REJECTED/LEASE_LOST`、零新增、消息 `DISCARDED` |
| R3 持久取消被迟到 CONTENT 绕过 | 结算不读 `cancel_requested`，正文结算无条件标 `COMPLETED` | 同一事务内核对取消意图；取消先提交 → `CANCELLED`/零新增；增量先提交 → 既有事实不倒删 |
| R4 最近 20 条之外的删除被旧轮复活 | 轮次只冻结「最近 20 条证据涉及」的知识点，其余被解释成无限制写入 | 冻结**全部**既有知识点，并加身份分区 `$identities`（`slug → generation`）识别「删除后同名重建」 |
| R5 已解除 GAP 仍进未决项 | 两个读取入口按 `kind === 'GAP'` 判定 | 统一按 `disposition === 'PENDING_REVIEW'`；`SUPERSEDED`/`WITHDRAWN` 保留为历史 |
| R6 清除扫描与 epoch 推进之间的并发结算 | 清除与结算没有一致序列，旧 epoch 证据残留 | 两处取同一 workspace 级 `pg_advisory_xact_lock`，统一「先锁再碰轮次行」顺序 |
| R7 generation 校验后的人工纠正被旧轮越过 | 校验与写入不在同一临界区 | `insertEvidence` 的 `expectedGeneration` + `for update` 重读，把校验与写入放进同一临界区 |
| R8 无可信依据仍写「实际表现」 | 保存前不校验依据，模型可自称依据 | 应用按候选性质绑定 `source_message_id`，结算校验存在/属于本轮/性质匹配/本轮有真实输入；缺依据 422 `LEARNING_EVIDENCE_REF_INVALID` 且零新增 |

**独立复验（不只看测试汇总）**：修复后由当前 Agent 在一次性 PG18.6 集群上新建独占库，独立操作 4 个关键反例并直接读 PG/HTTP 事实（`output/_independent-remediation.json`）：R1 显式 Skill 消息 HTTP **202**、DB 中助手行 `skill_snapshot` 非空且方法三列全空；R2 失权 Worker → `DISCARDED`、消息 `FAILED/LEASE_LOST`、轮次 `REJECTED/LEASE_LOST`、证据 **0** 行；R3 持久取消 → `cancel_requested=true`、消息与轮次 `CANCELLED`、证据 **0** 行；R8 跳过轮次的无依据 OBSERVE → `LEARNING_EVIDENCE_REF_INVALID`、知识点与证据均 **0** 行。探针库已 DROP，未连接用户数据库。

**测试与隔离环境修正**：`migration`/`cli` 集成断言同步到真实清单 **72**（0070 之后追加 0071/0072，`ledger_rows` 72），保留完整迁移名、hash、重复执行零新增、旧 schema 升级与 0071/0072 实质断言；`f24-proposal-idempotency` 用既有 `holdReceiptInsert` 屏障保证有效请求先持候选锁并提交，异载荷再核对原 receipt 报 409 `COMMAND_ID_REUSED`（未给未成功提交的 command 加身份预占协议）；`learning-late-settlement` 用可控模型屏障 + `pg_stat_activity` 锁等待固定提交顺序。

**文档同步**：[HTTP 契约 §10.65/§10.66](../api/http-command-contract.md)（身份优先级、依据绑定、领取身份与取消、基线冻结范围、清除边界、纠正临界区、已解除缺口；Breaking Change：No）、[物理设计 §73](../database/physical-design-postgresql.md)（冻结基线形状与 advisory 锁，无新迁移）、[ADR-020](../decisions/ADR-020-learning-mode-record-protocol.md)（R1–R8 实现落点与已核定语义边界）、[测试计划 §25](../testing/verification-plan.md#25-学习模式验收规格)（反例转正式回归映射）。`node scripts/check-docs.mjs` exit0。

**环境阻塞（与本轮改动无关，不计入产品缺陷）**：本机原生 `relay-file-io-helper.exe` 的受管内容写入路径返回 `DELETE_FAILED`（直接探测：`ManagedContentStore.publish` → `StorageUnavailableError`；helper 协议层 `WindowsContentError: DELETE_FAILED`），落在 `content-freeze`/`managed-content-store`/`file-write-frozen-diff`/`git-adapter` 单元与全部落盘集成用例上。这与工作记忆 2026-10-07 记录的同一族阻塞一致；helper 二进制与产品源码未变。**备份/恢复维护门**：2026-10-11 验收时阻塞于非自有桌面实例（PID34280），该实例现已退出，本轮按自有隔离环境复跑，结论见验收表。

**未闭合与推荐下一步**：① 环境阻塞需用户决定——给仓库/临时目录加安全软件排除项后复跑，或换干净机器复跑；② 学习模式工作包 C（协作页学习档单选框、记录查看/纠正/删除/清空组件、明确转执行）与 D（真实 Windows 窗口、授权 Provider、成本阈值冻结、LM-16 效果）仍未实施，本轮不自动启动；③ 内置方法后续阶段（`MODIFY` 写执行链、`SKILL.md` 定制、系统命令接线、会话级模型选择与压缩）仍未实施。并行会话在同一工作区活跃，后续读写共享文件前须重新核对最新基准。

## 后端独立验收与整改入口（2026-10-11）

本轮当前源码后端整体**未通过**。已完成源码基准核对、全量单元、全量真实 PG/HTTP、独立业务反例及只读复核；具体成绩、环境阻塞与未覆盖项只归[功能验收表本轮行](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。未修改产品源码或正式测试，未停用户桌面实例。

**推荐下一步**：先修显式 Skill 与自然语言方法的唯一身份，再修学习轮次的失权/取消、删除与纠正 generation、清除 epoch、本轮可信依据和已解除 GAP 的读取边界；随后修正迁移数量断言与 f24 并发测试顺序，补不占用用户实例的备份恢复验收。用户本次要求交付提示词，[后端修复与回归收口任务书](../../prompts/remediation/backend-acceptance-remediation-20261011.md)已写成、**尚未执行**；不自动进入方法后续阶段、学习前端、真实 Provider 或 Windows/安装开发。

下方各专项小节保留其实施时点。尤其“学习模式：协议冻结与工作包 A”中的 B 未实施与 fail-closed 描述属于当时快照：本轮源码已有 learning-round/Context/调用计量接线，正式 learning-round 集成通过，但独立迟到写入与版本反例失败，**不能继续把 A 时点描述当当前实现，也不能把 B 已出现当完成验收**。当前缺口与执行范围以上述验收表、整改任务书及实时源码为准。

## 运行时提示词路由统一入口（2026-10-11）

用户下发[并行实施任务书](../../prompts/runtime-prompt-routing.md)后，由主 Agent 冻结接口、接线并独立复验，**实际并行派发子代理**完成模板提取：首波 A（会话模板）/B（Run 与验证模板）中，任务书指定模型 `gpt-6.1-sol` 在当前账号不可用（派发被工具拒绝，如实报告而非静默换模型），A 重派后与 C（两类解释模板）、一个只读审查员**三路同时运行**，文件所有权互不重叠；未自动 commit/push、未 reset/stash/clean、未停用户桌面实例、未调用真实 Provider、未实施其他专项。

**已实现**：`apps/api/src/workflow/prompts/` 下 ① `route-types.ts`——封闭路由输入联合、16 条路由登记表（routeId / 模板版本 / 核心版本 / 模板位置）、`SYSTEM` 与 `USER_PROBE` 判别联合返回；② `index.ts`——唯一入口 `selectRuntimePrompt()` / `selectRuntimeSystemPrompt()`，switch + `never` 穷尽守卫，未知路由抛 `UnknownRuntimePromptRouteError`；③ `conversation-prompts.ts`（Assist 五意图、第一方 Skill、内置方法、只读助手、学习搭档）、`interpretation-prompts.ts`（执行解释、状态维护解释）、`run-prompts.ts`（DRAFT 三分支、语义验收、连接验证探针）——正文单一来源，各自只组合一次公共核心。七处原调用（`assist-runner`、`assistant-readonly-round`、`learning-round`、`conversation-execution`、`conversation-state`、`openai-compatible-model-port`、`model-port-verify`）改为经统一入口取模板；`assistantSystemPrompt`/`learningSystemPrompt`/`INTERPRETATION_SYSTEM_PROMPT`/`STATE_MAINTENANCE_SYSTEM_PROMPT`/`VERIFY_PROMPT` 保留为单一来源的兼容再导出，无第二份正文。`conversation-execution.ts` 与 `openai-compatible-model-port.ts` 保持原 CRLF 行尾。

**实际运行（最终源码）**：`tsc --noEmit -p tsconfig.json`/`tsc -p` 均 exit0；接线后经统一入口对改动前捕获的 32 个基线键逐字节复比对 **45/45 通过**（含 16 条路由元数据、核心恰好一次、未知路由拒绝）；定向 16 个受影响单元套件 **131/131 exit0**；**后端全量单元 541：526 通过 / 14 失败 / 1 跳过**——14 条全部落在 `backup-package`(4)、`content-freeze`(5)、`managed-content-store`(3)、`restore-isolation`(2) 的本机原生 helper / 备份恢复族环境阻塞，无一涉及 prompts / assist / conversation-state / learning。**真实 PG/HTTP**（一次性 PG18.6、逐套件独占库、build/migration/graph/start/stop 均 exit0、临时集群已删）：第一批 12 套件 **11 套件全绿**，第二批 7 套件 **6 套件全绿**。`node scripts/check-docs.mjs` **exit0**；`npm run feature-map:check` 通过。

**有意行为变化**：未知 `AssistIntent` 由旧实现的「落入任务提案默认分支」改为显式抛错（任务书 §5.4）；五种合法意图文本与协议不变。**Breaking Change：No**——无 API、数据库、migration 或新依赖；调用账本仍未记录组合版本，历史缺项保持未知，不宣称提示词审计已完成。

**未闭合（下一步）**：① **被并行工作包缺陷阻塞**：`assist.integration.test` 8 例与 `f24-proposal-idempotency.integration.test` 3 例失败，根因不在本轮——失败在 `assist-commands.requestAssistMessage` → `insertMessage` 的 INSERT 上，报迁移 `0071` 的 `ck_assist_message_method_exclusive`：含 `skillRef` 的消息因自然语言方法识别同时写入 `skill_snapshot` 与 `method_snapshot`。调用栈位于提示词代码执行之前，属「内置方法与会话检查点」工作包的自然语言绑定未考虑已绑定 Skill 的场景；需其 Owner 修正后补 `SKILL`/`METHOD` 两条路由的真实 PG 证据。② 组合版本入调用账本、解释接入统一调用记录仍未做（见[提示词设计 §7](../architecture/agent-prompt-design.md#7-与当前源码的差距)）。③ 未调用真实 Provider、未跑真实 Windows 与安装。④ 14 条全量单元失败为本机环境阻塞，未停非自有桌面实例、未放宽维护门。并行会话在同一工作区活跃（`0072`/`src/learning/`、`0071` 方法工作包），后续读写共享文件前须重新核对最新基准。

## 学习模式：协议冻结与工作包 A（2026-10-11）

用户下发[完整实施与验收提示词](../../prompts/learning-mode.md)并选择「开始实施，先冻结协议」后，由当前 Agent 单独执行：**未派子代理**（指定 `gpt-6.1-sol` 在当前账号不可用，按提示词要求报告限制而非静默降级）、未创建其他聊天、未自动 commit/push、未 reset/stash/clean、未停用户桌面实例、未调用真实 Provider。实际成绩只归[功能验收表本轮行](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)，本节只记范围、边界与下一步。

**协议冻结**：[ADR-020](../decisions/ADR-020-learning-mode-record-protocol.md) 落定独立 `LEARNING` 会话身份、五张记录表与唯一写入 Owner、同轮有限增量信封、**调用模型前冻结的结算基线**、清除代次与迟到结果、命令幂等与回执形状、Context 选择规则、逐次调用计量、转执行不升权；[领域模型 §13.4](../architecture/domain-model.md#134-工程协议2026-10-11-冻结未实施)、[后续路线 §8](../requirements/post-v1-roadmap.md#8-学习模式的范围与实施前置)、[文档入口](../README.md) 已接续。

**工作包 A 已实现**：迁移 `0072`（重建 `ck_assist_session_mode` 为三分支、`assist_messages.learning_record_disabled`、五张学习表）；`learning/learning-repository.ts` ＋ `application/learning-records.ts` ＋ `api/learning-api.ts`（六端点），注册进 `Repositories`；`assist-commands` 增加学习身份准入与 `record_learning` 开关；`conversation-state` 改为只放行 `AGENT`；`assist-runner` 对学习身份 **fail closed**。

**实际运行（最终源码）**：API `tsc --noEmit` exit0；workbench `tsc --noEmit` exit0；**真实 PG 定向集成 `learning-records` 7/7 PASSED、exit0**（首轮 6/7，红在「清除后迟到轮次报 `UNAVAILABLE` 而非 `STALE`」，据此把 `learning_rounds` 改为保留为最小控制元数据并把代次校验提到状态校验之前，复跑转绿）。**回归**：后端全量单元 508 条 **493 通过 / 14 失败 / 1 跳过**——14 条全部落在 `backup-package`(4)、`content-freeze`(5)、`managed-content-store`(3)、`file-write-frozen-diff`(1)、`restore-isolation`(1)，即本机原生 helper / 备份恢复族的环境阻塞，**无一涉及 assist / conversation-state / learning**；前端受会话枚举与 parser 影响的 5 个定向规格 **68/68**。`scripts/check-docs.mjs` **exit0**。原始输出 `output/learning-int.txt`（首轮）、`output/learning-int2.txt`、`output/learning-int3.txt`（复跑 7/7）。

**文档**：[ADR-020](../decisions/ADR-020-learning-mode-record-protocol.md)、[物理设计 §73](../database/physical-design-postgresql.md)、[HTTP 契约 §10.66](../api/http-command-contract.md)、[领域模型 §13.4](../architecture/domain-model.md)、[后续路线 §8](../requirements/post-v1-roadmap.md)、[文档入口](../README.md)、[功能验收表本轮行](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。Breaking Change：No。

**未闭合（下一步，按工作包顺序）**：① **B——教学轮次**：模型端口的同轮有限增量信封（含 Fake 与真实 Provider 兼容）、学习专用 Context 装配与短路线/可选检查/接续、**每次调用与重试进 `recordModelInvocation`**（明确不照抄助手只读轮次的计量缺口）、受控故障注入；② **C——产品入口**：协作页学习档单选框（parser 已能识别 `LEARNING`）、状态变化与记录查看/纠正/删除/清空组件、明确转执行；③ **D——独立复验**：真实 Windows 窗口、授权 Provider、成本阈值冻结与 LM-16 学习效果评价协议；④ 学习身份目前发送消息会以 `LEARNING_ROUND_NOT_AVAILABLE` 失败，这是**有意的 fail-closed 安全边界**，不是可用功能——B 落地前不得对外宣称学习模式可用。并行会话在同一工作区活跃，后续读写共享文档前须重新核对最新基准。

## 内置工作方法与聊天命令：首批后端切片（2026-10-11）

用户下发[内置方法与会话检查点实施提示词](../../prompts/builtin-methods-and-conversation-checkpoints.md)后，由当前 Agent 单独执行**阶段 A（缺口与协议冻结）与阶段 B 的后端核心**：未派子代理、未创建其他聊天、不自动 commit/push、未 reset/stash/clean、未停用户桌面实例、未触碰并行会话在途文件（学习模式 `0072` 与 `src/learning/`）。**阶段 C–F（DeepSeek 协议/压缩、消息文件恢复、前端接线）未进入**；本轮不宣称该专项完成。

**已实现（后端）**：① `apps/api/src/skills/builtin-methods.ts` —— 三条内置方法（`code-review`/`fault-diagnosis`/`docs-maintenance`，各 `@1.0.0`）固定英文命令名、中文别名、默认作用范围、默认行动、能力需求与验证说明；定义 + `sha256` 冻结，`inspectFrozenMethodSnapshot` 校验形状/摘要自洽/未知字段。② `apps/api/src/application/chat-commands.ts` —— 方法与五条系统命令（`/clear`、`/new`、`/model`、`/undo`、`/compact`）共用登记表，英文与中文别名同义；只认行首 `/名称`，代码块与 `/usr/bin/env` 类路径不触发，未知命令/非法参数类型化拒绝；解析是纯函数（不写存储、不调模型、不执行动作）。③ `apps/api/src/application/method-intent.ts` —— 确定性自然语言识别，区分「讨论/审查/诊断/修复/文档维护」与「当前/全项目」；「讨论」优先于「修好」。④ 迁移 `0071` 给 `assist_messages` 加 `method_snapshot`/`method_action`/`method_argument`（三列齐备或全空、与 `skill_snapshot` 互斥），发送时冻结方法身份；只读方法轮复用原 Assist 生成链与既有系统边界，不新建 SkillRun；只读 `ASSISTANT` 会话请求 `MODIFY` 一律 409。⑤ 两条只读端点 `GET /chat-commands`、`POST /chat-commands/resolve`（无 `command_id`、无回执、零副作用）。

**工程取舍（已记录）**：方法**不放进**第一方 Skill 注册表——那张表被冻结、归档并参与备份包校验（`inspectBackupRegistryArchive` 逐字校验 4 个 id 与 `definition` 键集），塞入执行型方法会改归档契约。方法定义单独冻结，命令登记统一解析两张表。

**实际运行（最终源码）**：API `tsc --noEmit` **exit 0**；单元 `builtin-methods.test.ts` **5/5**；定向复跑 `builtin-methods`+`first-party-skills`+`assistant-readonly-round` **17/17**；**后端全量单元 508：497 通过 / 10 失败 / 1 跳过**——10 例全部是既有 Windows file-io/AV 环境阻塞族（native freeze、content-freeze、managed-content、restore/desktop-api isolation），与本轮改动无关、未修改。**真实 PG/HTTP 集成 `chat-commands` 4/4 PASSED、exit 0**（首轮 3/4：断言把校验失败写成 400，实际是 **422**，改正后复跑通过）。`node scripts/check-docs.mjs` **exit 1**——2 个错误全部来自并行会话的项目页重设计文件（`design-system.md:490` 与 `superpowers/specs/2026-10-11-projects-page-redesign-design.md` 的外部越界链接），本轮新增链接零错误。

**文档**：[HTTP 契约 §10.65](../api/http-command-contract.md)、[物理设计 §72](../database/physical-design-postgresql.md)（迁移 `0071`）、[Skill 专题 §9.5](../architecture/relay-skills.md#95-实施状态2026-10-11首批后端切片)、[测试计划 §26.1 覆盖映射](../testing/verification-plan.md#261-首批后端切片覆盖映射2026-10-11)。Breaking Change：No。

**未闭合（下一步，按阶段顺序）**：① 阶段 B 剩余——方法到**写**执行链的绑定（`MODIFY` 目前只产生只读分析与方案，实际修改仍需既有会话执行入口）、`SKILL.md` 个人/项目定制与草稿/启用协议、系统命令的实际应用用例接线、前端输入位置菜单与 IME/草稿交互；② 阶段 C——模型协议完整回传（`renderToolTurns` 仍以空正文 `AIMessage` + tools 重建，未带 `reasoning_content` 与 assistant 前置正文）、会话级模型选择与 Run 模型冻结、三层上下文整理与检查点；③ 阶段 D/E——消息发送前可恢复文件基线与撤回按钮、安全停写与 Task 重开；④ 阶段 F——前端真实接线；⑤ 真实 DeepSeek 与真实 Windows 未验。

**并行工作区提醒**：同一工作区另有会话在途（学习模式 `0072`、`src/learning/`、`assist-api.ts` 的 `record_learning`）。后续读写前须重新核对共享文件；本轮未覆盖其改动。

## 协作页 UI 结构重塑（2026-10-10，与 NLS 整改并行）

用户下发「按已写入 superpower 文档的 /agent 页 UI 改造方案实施」后，由当前 Agent 单独完成实施、测试、真实 Chromium 核对与文档同步：**未派子代理、未创建其他聊天、不自动 commit/push、未 reset/stash/clean、未停用户桌面 PID34280**。实际成绩只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)，交互规则归[工作台 §28](../frontend/workbench-design.md#28-协作页结构重塑2026-10-10)，外观规则归[设计系统 §6](../frontend/design-system.md#协作页结构原语2026-10-10)。

**范围**：只动 `/agent` 的工作区级会话态（`task === null`）与承载它的左栏；不动风格基调、标题带、左导航栏与有任务态布局；token 零新增。设计依据是并行会话已提交的 [spec](../superpowers/specs/2026-10-10-collab-page-ui-optimization-design.md)。

**实现**：① 左栏 `RecentWorkRail` —— 「＋ 新对话」升为置顶主按钮；行高 `control.height.comfort` 的密列表（主名 `body`/medium 单行省略 + 副行 `meta`）；组标题带计数、折叠状态写本地偏好；工作区级会话与任务同列；当前项 `selection.bg` + 2px 主色左线；「查找更多任务 / 会话」就地展开（原 `CollaborationView` 内部的选择器抽成共享组件 `TargetPicker`）。② 主区删除两个顶部 `details` 大块，欢迎卡标题降为 `compactPage` 并内嵌编号引导卡。③ 文件夹作用域收成输入卡上方的常驻细条（新组件 `FolderScopeBar`，常态/未归属/未就绪三态，告警整条换 `status.warning`），`FolderScope` 控件整体迁入「更换目录」对话框。④ 输入区 chips 统一为 `radius.round` + `border.control` + `bg.surface`，「回到最新」改为胶囊悬浮键。

**实测（最终源码）**：workbench `tsc --noEmit` exit0；**全量 vitest 100 文件 862/863、exit1**——唯一失败为 `run-events` SSE 时序（单跑复跑 **5/5**，与全量 PG 并行负载下的既有 flake 同类，本轮保留首轮结果）；`vite build` exit0；**全量 Chromium 94 通过 / 1 失败（`workbench.spec.ts` R02 既有 flake，见验收表前行记录）**；真实 Chromium 逐屏截图核对三态（空态 / READY 细条 / 有会话）结构与设计稿一致。

**测试同步**：结构变化使 10 个组件 spec 与 4 个 Playwright 布局 spec 的既有选择器失效，逐处按新结构改写（目录入口改走「更换目录」框并注明 portal 查询原因、选择器改走左栏就地展开区、请求清单补上新增的会话读取、两例断言旧外观的用例改为断言新胶囊规格）；`recentWorkPagination` 新增「工作区级会话与任务同列」「分组折叠偏好持久化」两例。未删除任何失败检查。

**降级取舍**：会话列表读不到时左栏按「任务列表照常 + 一行说明会话读不到」呈现，不把已读到的任务一起清掉，也不假装没有会话。

**文档**：工作台新增 §28（含与设计稿的 5 处差异确认）；设计系统 §6 补 chips / 细条 / 欢迎卡 / 回到最新四条外观规则；`scripts/check-docs.mjs` 由 exit1（13 处断链）转为 **exit0**——顺带修正 spec 与验收表中的相对路径断链，不改语义。

**未闭合（下一步）**：① 真实 Windows 窗口的中文 IME 组词与 DPI 100%/150% 输入卡版式未取证；② 全站推广未做（本轮只协作页）；③ 新建讨论后左栏需手动刷新才出现（与任务创建后的既有行为一致，未加自动刷新）；④ 会话读取失败只有说明、没有重试入口。

## 自然语言状态维护复验整改与第五节切片（2026-10-10，当前结论）

用户下发[复验后整改任务书](../../prompts/remediation/natural-language-state-maintenance-acceptance-20261010.md)后，由当前 Agent 单独完成实施、测试、真实浏览器复验与文档同步：**未派子代理、未创建其他聊天、不自动 commit/push、未 reset/stash/clean、未停用户桌面 PID34280**。实际成绩只归[功能验收表本轮行](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)，本节只记范围与边界。

**六项反例红→绿**：R1 拒绝语义（`DECLINED` 终态 + 写事务内 `expected_revision` CAS + 回执先行）、R2 任务版本冻结（`baseline_ref.task_revision` + 链式期望版本）、R3 解释基线在**调用模型之前**冻结（`conversation_state_requests.interpretation_baseline`，缺基线 `STATE_BASELINE_MISSING` 保守拒绝）、R4 `after_ref` 记 Owner 返回新版本 + 补偿链 CAS + 同任务范围后缀校验、R5 决定回执先于状态前置（同命令重放 200 / 异载荷 `COMMAND_ID_REUSED` / 并发收敛原回执）、R6 展示签发记录逐项核对（`project_daily_view_presentations`，污染基线 `PROJECT_DAILY_VIEW_BASELINE_REPAIRED` 恢复）。红灯证据：R1/R2/R3/R4/R5/R6 各有失败日志（`output/acceptance-raw/nls-fix-r1-20261010/red*.log`）。

**第五节剩余切片**：`SYNC_EXTERNAL_RESULT`（只读核对 + `CONVERSATION_EXTERNAL_CHECKED` 审计，不完成不接受）、`COMPLETE_TASK`（沿原完成 Owner，接受声明绑定原消息原文，冻结任务/验收版本）、`UNDO_STATE_CHANGE`（自然语言撤回，冻结同会话唯一已生效调整，复用 `withdrawals` 用例，0/多候选类型化失败）、`POST /projects/{id}/return-reviews`（返回轻量核对，事实指纹持久 `project_return_reviews`，复用同记录、变化重核，失权 404 零写入）——迁移 `0068`/`0069`/`0070` 追加，Breaking Change：No（新增 kind 与新端点）。前端：`DECLINED`/核对/完成/撤回回执明细行、决定命令身份按展示版本复用、接续卡轻量核对行、只读核对与撤回回执不再提供撤回入口。

**实际运行（最终源码）**：API `tsc --noEmit`/`tsc -p` exit0；**定向 8 源码套件 110/110、exit0**（conversation-state 43、project-return-review 3、project-daily-continuation 12、check-trust-gate 25、拒绝收口 2、api-state 10、cli 5、migration 10，材料绑定与拒绝收口未退化）；**后端全量单元 503：502 通过/0 失败/1 跳过、exit0**（跳过仍为本机目录替换链接边界用例）。**真实浏览器组合验收 exit0：14/14 检查全过**（真实 Chromium + 一次性 PG18.6 + 真实 API/UI/Worker + 本机忽略目录的确定性解释适配）：返回轻量核对行、R1「不调整不执行」（回执 `DECLINED` + 服务端 `DISCOVERY`）、NL 状态自动生效、自然语言撤回回 `DISCOVERY`、计划调整后按钮撤回、外部成果核对不完成、明确完成 DONE、刷新回执持久、页面零未捕获异常；**数据库层事实**（`output/acceptance-raw/nls-browser-20261010/evidence/db-facts.txt`）：`SET_PHASE=DECLINED 1`、`SET_PHASE/SET_TASK_PLANNING=COMPENSATED 各1`、`SYNC/COMPLETE/UNDO_STATE_CHANGE=APPLIED 各1`、`可完成任务 DONE+t`、`计划任务 priority 为空（撤回恢复）`、四类审计与回执各 1、`project_return_reviews CHANGED 1`；截图 6 张同目录。**前端**：`tsc --noEmit` exit0、`vite build` exit0；定向 4 规格 99/99；全量首轮 **861：860 通过/1 失败**（`run-events` SSE 时序，与全量 PG 并行负载下的既有 flake，首轮保留），单跑复跑 **5/5**。首轮全量 PG（Slice B/C 前的 dist）**73 套件 843：810/19 失败/14 跳过**，19 = backup 7＋restore 8（`MAINTENANCE_SESSION_BUSY`，用户桌面互斥量，未停该实例）＋ cli 1＋migration 3（dist 旧迁移清单，重建后定向复跑已绿）；**最终源码全量 PG 终轮另行结算，结果只写验收表**。`scripts/check-docs.mjs` exit1——11 个错误全部来自并行会话已提交的 `docs/superpowers/specs/2026-10-10-collab-page-ui-optimization-design.md`（链接目标不存在），本任务触及的文档链接零错误、未修改他人文件。

**文档**：[HTTP 契约 §10.63/§10.64](../api/http-command-contract.md)、[物理设计 §68–§71](../database/physical-design-postgresql.md)、[领域模型 §12.5](../architecture/domain-model.md)、[工作台 §18.9](../frontend/workbench-design.md)、[测试计划 §24 形式化落点](../testing/verification-plan.md#24-自然语言状态维护与自动接续验收规格)。

**未闭合（下一步）**：① 真实 Windows 组合窗口、中文 IME/DPI、安装/升级/卸载未验；② 备份/恢复 15 条仍需不占用用户实例的环境补验；③ Slice B 的 run 侧验证会话错误分支（FAIL/ERROR 检查结果的对话内呈现）与「错误分支/未知目录」场景、Slice C 的执行型检查（FrozenCheck 外呼、目录资源与模型预算核算）仍按 §24 与任务书缺口清单标为未覆盖；④ 需求/计划与 Goal 内容写入口仍无领域 Owner；⑤ 真实 Provider 解释质量未验。并行会话在同一工作区活跃（今日提交 `f8c39d5`、在途 CSS/规格改动），后续读写前须重新核对共享文件。

下节为独立复验原始结论（整改输入），再下节为复验前实施记录，均已由本节更新。

## 自然语言状态维护整改独立复验（2026-10-10，整改输入）

用户提供实施会话后，由当前 Agent 单独读取当前源码、编译并从真实 PG/HTTP 与 Chrome 浏览器插件复验，未派子代理、未修改产品源码或正式测试。**整体未通过，不能标记任务全部完成。** 前轮反例已落成正式回归，但新增既有任务与决定续答仍有独立失败；成绩、原始输出与限制只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)最新行，不继承实施者自述。

下一步按[复验后整改提示词](../../prompts/remediation/natural-language-state-maintenance-acceptance-20261010.md)先修六项：① `DECLINE` 仍清空待决定并自动生效，浏览器点击「不调整」后阶段实际进入 RELEASE；② 任务计划候选未冻结 Task revision，覆盖确认后的人工修改；③ 模型在途的新 State 修改被结算时读取的最新 revision 吸收并覆盖；④ 任务计划 `after_ref` 保存生效前 revision，无后续修改也误报撤回冲突；⑤ 决定续答在幂等回执检查前校验当前状态，同原命令响应丢失重放 409；⑥ 查看确认只校验序号上限，未绑定实际签发的展示身份/事实，接受虚构版本后正常查看不能推进基线。恢复反例与现有材料绑定/拒绝收口保持通过，勿重写这些已验证路径。

以上复验通过后，继续原任务书尚未完成的自然语言撤回、外部成果核对与返回轻量检查，再补真实 Windows 组合验收。需求/计划及 Goal 内容写入口的缺口继续明确列为未接入。浏览器本轮已使用真实 API/PG 与可控模型，不能提升为真实 Provider、产品认证、Windows IME/DPI 或安装验收。用户桌面仍为 PID34280（本轮核对启动时间 2026-10-08 22:43:31），未停止；备份/恢复占用出口仍待独立环境补验。

下节为整改实施自检记录，当前下一步以上节为准。

## 响应式收敛回写与 layout.header.height 语义澄清（2026-10-10，并行于 NLS 整改）

用户说明另一 Agent 正在执行[自然语言状态维护任务](../../prompts/natural-language-state-maintenance.md)后，本会话继续开发其余部分并避开该任务范围。选取的收尾片与 NLS 文件零重叠：只改 `apps/workbench/src/**/*.css`、`docs/frontend/*` 与三个新增测试，未动 AssistView/CollaborationView/DailyContinuationCard/relayClient/labels、迁移与应用层，未提交、未停他人进程。

**断点收敛已收口**：新增 `apps/workbench/tests/responsiveTiers.spec.ts` 把[设计系统 §9.6](../frontend/design-system.md#96-控件基座与响应式收敛2026-10-08)的档位规则变成守卫——宽度断点只允许四档语义值 48/64/80/90rem，禁 `.9375rem` 补丁、禁 min/max 双触发、禁旧式 `max-width` 写法。RED 列出 31 处遗留后逐处归并：Reviews 的 60rem 标题档与全局 `<64rem` 重复，**删除**而非换档；styles、ArtifactPanel、Run、TaskDetail、LiveTaskSkillFacts、TaskCheckPlanPreview 的 40rem 兜底档并入 `<48rem`；其余 `.9375rem` 与双触发改写为 range 语法，逐处注释。附带发现：TaskDetailView 的 40rem 规则写在非 grid 容器的 `dl` 上，历来无实际效果，已在其注释中固化，避免后人误判。

**`layout.header.height` 语义已澄清**：该 token 自本节起专指 `.app-topbar` 实际高度，值由 3.5rem（更早布局遗留）更正为 **2.8125rem**（`control.height.comfort` + `border.width`）；桌面上方固定区总高 = 原生标题栏 `control.nav.height` + 该 token，`html.app-desktop` 滚动预留、通知浮层 max-height、ActivityView sticky 偏移都按这一口径统一。真实 Chromium 先实测 RED（token 56px vs 顶栏 44px）后 2/2 绿。

**验证**：workbench `tsc --noEmit` exit0；全量 vitest 串行 **100 文件 861/861、exit 0**；全量 Chromium **94 通过 / 1 失败**（`workbench.spec.ts` R02 草稿守卫拦截浏览器返回，路径文件均为他人 10-08/10-09 在途修改，验收表早有「R02 偶发」记录，单独复跑仍失败，不计本轮）；新增两个浏览器用例 6/6 + 2/2，其中折行边界用例经反向验证（临时删规则转红、恢复转绿）。

**文档**：[设计系统 §5 顶栏行与 §9.6](../frontend/design-system.md)、[工作台 §17.15](../frontend/workbench-design.md#1715-控件交互基线与响应式收敛2026-10-08)、`design-tokens.json`（值＋description＋updated）已同步；验收表新增本轮行并更新控件基座行剩余项。

**遗留**：① `views/AssistView.css` 一处旧式 `max-width: 64rem` 属 NLS 在途文件，守卫已豁免其语法检查，待其 Owner 归一；② 真实 Windows 目视、IME/DPI、屏幕阅读器、安装未验；③ 备份/恢复 15 条仍在维护互斥量下未复跑；④ `node scripts/check-docs.mjs` 现 exit 1，11 个错误全部来自当日 22:02 他人在建、被 git 忽略的 `docs/superpowers/specs/2026-10-10-collab-page-ui-optimization-design.md`（失效本地链接），需其 Owner 修链接或补图；本机 Markdown 链接核对在该文件修复前不可过。

## 自然语言状态维护整改与既有对象/决定续答（2026-10-10，复验前实施记录）

用户下发[本轮整改提示词](../../prompts/remediation/natural-language-state-maintenance-acceptance-20261010.md)后，由当前 Agent 单独完成实施、测试、复验与文档同步：**未派子代理、未创建其他聊天、未向其他任务发送材料、未自动创建 goal**。上一节的独立验收只作为整改输入，不继承为本轮成绩。实际运行结果只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)本轮行；本节只记范围、下一步与边界。

**A/B/C 三段（上轮 10 个失败场景）已落成正式回归**：反例 A/B 与同值修订、目标身份替换按确认时点的适用基线（迁移 `0064.baseline_ref`）识别冲突，保留当前事实并按冲突表达；非法 `decision_required` 与混合/全非法条目整单澄清、不产生写入；整组撤回先只读预检（`GET .../undo-plan`），有不可撤回项时**一项都不补偿**，由用户勾选具体范围并回传 `plan_digest`，范围与方案在同一条语句里持久（`undo_scope`），CAS 输方不执行；同 `command_id` 改来源 409 `COMMAND_ID_REUSED`、同原消息并发只调一次模型、模型明确失败结算为可读 `FAILED`（新 `command_id` 沿原请求恢复）、`UNDOING` 中断按原 `undo_command_id` 继续剩余补偿；日常查看基线改为服务端签发展示序号（迁移 `0065`），State 不变也能推进、迟到旧确认不覆盖新查看，任务集合超 200 条按截断标记且 delta 置未知。

**第五节纵向场景**：新增 `SET_TASK_PLANNING`（迁移 `0066`，沿原 Owner `SetTaskPlanningMetadata`，只改模型给出的字段、截止日期冻结客户端时区）；`decision_required.blocked_changes` 让独立且明确的修改不被另一项必要决定整组冻结；新增 `POST .../decision-replies` 一句话续答，绑定展示版本（不符 409 `DECISION_STALE`）并由原 applications 继续原请求；解释输入带上同会话上下文与既有回执，使纠正/续答对得上原对象（上下文只供理解、不构成授权）。前端接线：冲突与「已存在」分开表达、撤回方案面板（勾选具体范围）、待决定的一句话回答入口、接续卡改用服务端展示身份。

**实际运行**：后端 `tsc --noEmit`/`tsc -p` exit0；**后端全量单元 502：501 通过、0 失败、1 跳过、exit0**（唯一一次失败是断言未同步 `blocked_changes`，修正后整轮复跑取得该结果；跳过仍为本机不能把目录替换为链接的边界用例）；真实 PG 定向日志 7 源码套件 exit0（conversation-state 22、project-daily 10、check-trust-gate 25、check-trust-refusal-lifecycle 2、api-state 10、cli 5、migration 10 等全绿）；**实施全量原输出复核：73 源码套件 825 条，通过 796、失败 15、跳过 14**，15 条失败**全部**为 `backup` 7＋`restore` 8 的 `MAINTENANCE_SESSION_BUSY`（非自有桌面 PID34280 持有命名互斥量，未停该实例、未放宽维护门），14 跳过为真实 Provider opt-in 13＋Windows helper 1。前端 `tsc --noEmit` exit0、全量 vitest **99 文件 858/858**、`vite build` exit0；`scripts/check-docs.mjs` exit0。原始输出留本机 `output/acceptance-raw/nls-remediation/`。

**文档**：[HTTP 契约 §10.61/§10.62](../api/http-command-contract.md)（新增 decision-replies/undo-plan、`presentation_seq` 必填）、[物理设计 §63–§67](../database/physical-design-postgresql.md)（追加迁移 0064/0065/0066）、[领域模型 §12.5](../architecture/domain-model.md)、[工作台 §18.9](../frontend/workbench-design.md)、[测试计划 §24](../testing/verification-plan.md)（形式化回归落点表）。**Breaking Change：Yes**——`daily-view-confirmations` 新增必填 `presentation_seq`，其余为新增端点/字段与追加迁移。

**未闭合（下一步）**：① 第六节外部成果核对与返回轻量检查**未进入**——返回卡仍只查询并确认基线，没有真实检查触发、证据复用与预算门，按出口要求继续标为未闭合；② 纯自然语言触发整组撤回**未接入**（候选词表没有对应 kind，撤回目前只有按钮入口，已沿请求行的原 `undo_command_id` 用例执行）；需求/计划领域无 Owner，相关维护仍是未接入口；③ 真实浏览器与真实 Windows 组合路径本轮**未运行**（只做了组件级与真实 PG/HTTP 证据）；④ 备份恢复 15 条仍需在不占用用户实例的环境补验；⑤ 真实 Provider 理解质量、安装/升级/卸载未验。

## 后端与自然语言状态维护独立验收（2026-10-10，前轮验收记录）

当前 Agent 单独验收，未派子代理、未修改产品源码。按新定位验收：明确指令沿原 Owner 维护事实，摘要展示实际变化与必要决定；简化操作不取消版本、权限、完成条件或 UNKNOWN 核对。**上轮批准失效后的拒绝收口与原 Task 接续已闭合；自然语言维护与自动接续整体未通过，A/C 只有有限路径实现，不能直接称两片完成。** 实际检查与环境限制只归[功能验收表本轮行](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

下一步先按[本轮整改提示词](../../prompts/remediation/natural-language-state-maintenance-acceptance-20261010.md)修复：原对象/基线绑定、非法候选的保守处理、撤回整组事前核对、原命令与在途恢复、日常多对象基线。补齐原请求绑定的自然语言纠正/撤回及必要决定续答，明确需求/计划与既有对象维护缺口。以上复验后再进入依赖它们的外部成果核对、返回轻量检查与 Windows 组合路径；不重写已通过的 CT-12，不把显示接续卡当作检查已运行。提示词交付不自动启动整改，仍不派子代理。

后端回归另需同步新增 ADD_BLOCKER 的精确接口断言，以及 0062/0063 后 CLI/迁移的 63 项清单与计数；维护占用的备份/恢复出口保持可见，不停止非自有桌面实例或放宽维护门换绿色。真实 Provider、Windows 新流程与安装出口未验收。

以下保留实施与前轮验收记录；当前下一步以上节为准。

## 自然语言状态维护：首批切片实施记录（2026-10-09，前轮）

用户下发[专项提示词](../../prompts/natural-language-state-maintenance.md)后，本轮由协调者＋两个实施子代理（后端/前端文件所有权互不重叠）并行实施。**Slice A（对话状态维护）与 Slice C（返回项目日常接续卡）已实施并经协调者复验**；外部进展核对（Slice B）未进入；真实 Windows（Slice D）未验。成绩与限制只归[验收表「Slice A/C 实施轮」行](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

- **Slice A**：迁移 `0062` 两表（前轮已建）＋ `conversation-state.ts` 用例/仓库/五端点；每条变更沿原 Owner 短事务生效（SetProjectState/CreateTask/addTaskDependency/createGoal/linkProjectGoal/createDecision/createKnowledge/addKnowledgeVersion），`undo_command_id` 整组逆序补偿，无撤销入口如实 `COMPENSATION_FAILED`。前端 AssistView 回执：MAINTAIN 自动生效（无接受按钮）、DECISION_REQUIRED 不自动应用、两步整组撤回、PARTIAL 折叠态可见。真实 PG `conversation-state` **7/7**、单元 **6/6**；前端组件 **7/7**。协调者修复接缝缺陷：撤回身份必须用请求行固化的 `undo_command_id`（投影已携带），不由客户端新造命令。
- **Slice C**：迁移 `0063` `project_daily_view_baselines`（每项目一行查看基线、presentation 幂等、迟到确认单调不覆盖、不复制业务正文）；`GET /daily-continuation`＋`POST /daily-view-confirmations`；`DailyContinuationCard` 挂 `/projects/:id` 顶部，确认针对已展示结果（viewed_fact_refs 回显），「已查看」不是接受；N01 命名点行为不变。真实 PG `project-daily-continuation` **6/6**、单元 **8/8**；前端组件 **7/7**。协调者修复接缝缺陷：确认载荷补 `unresolved_blocker_count`。
- **共享检查（协调者亲跑）**：前端 `tsc --noEmit` exit0、全量 vitest **99 文件 855/855**；后端 `tsc -p` exit0、全量单元 **501：500 通过/0 失败/1 跳过 exit0**（并发重复运行曾使 `restore-isolation` 相撞，串行复跑为准）；`collaborationWorkspace` 两条 Enter 用例按新增解释 POST 更新计数（加路径断言，未放宽）。**Slice B 前置**：CT-12 拒绝生命周期在当前源码 **2/2 PASSED**——上一节所记「批准失效后拒绝收口」阻塞已被并行后端整改闭合，其余整改范围（Permission 撤销 RESUME 严格断言、维护占用出口）不属本任务、未执行。
- **文档**：[HTTP 契约 §10.61/§10.62](../api/http-command-contract.md)、[物理设计 §63/§64](../database/physical-design-postgresql.md)、[领域模型 §12.5](../architecture/domain-model.md)与[工作台 §18.9](../frontend/workbench-design.md)已标注实施边界；Breaking Change：No。
- **指定模型限制**：子代理调度工具不支持 `gpt-6.1-sol`（当前账号不可用，沿用既有记录），本轮未虚报独立复核；工程复验由协调者亲跑承担。

**下一步**：① Slice B——外部进展→成果/证据核对→原验收/完成入口（NLS-04/05/08/09），前置 CT-12 已绿，可直接开工；② Slice D——真实 Windows 窗口按「返回项目→一句话调整→连带决定→外部成果核对→纠正/撤回→重启接续」串联验收；③ Slice A 补充——真实模型解释质量探针、`decision_required` 回执内联决定的交互口径。

## 后端独立复验（2026-10-09，前轮）

用户要求再次验收并给接续提示词。本轮由当前 Agent 单独完成，未派子代理、未修改产品源码。**原材料绑定漏洞在本轮反例上被挡住，后端整体仍未通过**：真实 START→LangGraph 等待→批准产生的 RESUME 链中，材料漂移被拒且 Invocation 为 0，但工具行已 SETTLED、Review 已 DECIDED，原 Operation/Run 仍 WAITING_APPROVAL、Task 仍 WAITING；两个 outbox 已 DONE、无下一命令，继续推进返回 ACTION_UNKNOWN。根因是派发前授权拒绝只结算工具行，未通过领域入口闭合原动作与任务状态。现有“重新确认”测试创建独立新 Task/目录，“撤销”测试用了随机恢复命令且允许两种结果，不能证明原任务接续与严格撤权出口。

当前源码全量单元与真实 PG、独立批准/完整图探针、Windows debug helper 定向补验及清理结果只归[统一验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)本轮行。该轮 PG 失败均为 backup/restore 的 MAINTENANCE_SESSION_BUSY，正在运行的非自有桌面 PID34280 保留；restore-postgres 本轮全量通过，不能沿用实施轮的连接栅栏失败作为本轮失败。真实 Provider、Windows 界面业务与安装等出口不提升。

**后端下一步**：按[批准失效后的状态收口与真实复验提示词](../../prompts/remediation/backend-refusal-lifecycle-20261009.md)，补正式图反例、修复确定未执行拒绝的领域收口、证明原 Task/资源的合法接续，并收紧真实 RESUME 的范围授权/Permission 撤销测试。保留材料绑定与真实 UNKNOWN 保护，再复验相关回归和全量；维护占用出口需在合乎契约且不占用用户实例的环境中补跑。提示词已交付、尚未执行，不派子代理。

以下为前轮实施记录，当前下一步以上一节为准。

## 后端整改：批准材料绑定与全量回归收口（2026-10-09，前轮实施）

用户下发[后端整改提示词](../../prompts/remediation/backend-approval-and-regression-20261009.md)后，本轮由当前 Agent 单独执行，未派子代理、未创建其他聊天、未向其他任务发送材料。

**A（P1）已闭合**：2026-10-08 独立验收确认的根因是 `createGatewayReview` 的 `ACTION_APPROVAL` target 只绑定动作/路径/参数/连接与策略版本，没有绑定创建时观察到的检查材料，`requireCurrentGatewayGrant` 接受有效单动作批准后也不再要求当前材料相同。现由新增的 `application/approval-check-material.ts` 在既有 Owner 内补齐：建 Review 时把服务端实测的整份 `check-trust-basis` 写进 target（因而进入 `target_hash` 完整性校验），`resolveRunReview` 在保存 APPROVE 前与 `requireCurrentGatewayGrant` 在真实执行前各核对一次；核对输入只来自已持久化的 Operation 事实（`op.params` 的 executable/args ＋ 受管资源 canonical root）。规则与剩余边界归[工具适配器 §1.6](../architecture/tool-adapters.md#16-写差异与检查工具2026-10-04-实施)，正式场景归[测试计划 §20.10](../testing/verification-plan.md#2010-检查入口的信任摘要与检查证据适用性2026-10-07-实施) CT-11。Breaking Change：No，无数据库结构变化、无 migration。

**B 已按真实根因处理**：① 队列/维护状态隔离——根因是生产 Assist 领取 `claimNextPendingMessage` 按整库选取、不带 workspace 过滤，而运行器此前让全部集成文件共享一个库；`--test-concurrency=1` 不提供数据隔离。现改为每个测试文件用 `CREATE DATABASE ... TEMPLATE ... OWNER relay_migrator` 克隆独占库、跑完即删、文件仍串行，生产 claim 逻辑与维护/连接安全门未放宽。② 迁移完整性——`backup-history` 与 `database-maintenance-boundary` 写死的 48 改为用仓库当前迁移清单与 ledger **逐条双向核对**（缺行/多行/摘要不符均失败），不是把 48 改成 61。③ 完成验证 fixture——原输出种类反例被删空的 target 短路到 `VERIFICATION_TARGET_STALE`，已拆成两条独立用例分别锁绑定门与输出覆盖门。

**下一步**：以本次同一源码基准取得的真实 PG 全量结果为准继续处理剩余项（见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)对应行）。当前剩余 16 条全部集中在备份恢复族：`backup` 7 条＋`restore` 8 条是 `MAINTENANCE_SESSION_BUSY`，根因为本机存在非本次自有的运行中桌面实例（PID 34280 `relay-desktop.exe`）持有原生命名单实例互斥量——需在停掉该实例后复跑，不能停用维护门换绿色；`restore-postgres` 1 条连接栅栏失败单独复跑 2/2 通过。未闭合的出口不变：真实 Provider 调用、Windows 界面业务、安装/升级/卸载、产品多 Agent 与其他 M/N 功能均未在本任务范围内，不提升 M/N 总出口。

## 后端独立验收（2026-10-08，前轮）

用户要求验收后端且不派子代理，本轮由当前 Agent 单独核对当前未提交源码、构建及真实 PostgreSQL 反例。**后端整体未通过**：检查材料退回人工批准后，创建 Review 至批准前、以及批准至派发前再次修改检查脚本，旧批准均可执行新内容。根因与待修边界归[工具适配器 §1.6](../architecture/tool-adapters.md#16-写差异与检查工具2026-10-04-实施)，正式回归规格归[测试计划 §20.10](../testing/verification-plan.md#2010-检查入口的信任摘要与检查证据适用性2026-10-07-实施) CT-11；实际成绩、全量回归差异和清理结果只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。本轮未修改产品源码，不提升 M/N 总出口。该轮的两条漂移反例与三类全量回归问题已由上一节的后端整改处理。

## 草稿编辑焦点与无 Run 文案修复（2026-10-08，实施完成）

用户下发[两项有限修复提示词](../../prompts/remediation/draft-focus-and-no-run-copy-20261008.md)后，本轮**实际并行派发两个实施子代理**（A 焦点恢复：`draftGuard.ts`/`AssistView.tsx`/`CollaborationView.tsx`/`App.tsx`；B 无 Run 文案：`TaskAcceptanceEvidence.tsx`），文件所有权互不重叠；协调者统一修改共享测试 `taskDetailVisual.spec.ts` 的旧文案断言并独占共享构建。两项修复均先红后绿：**焦点恢复**——`DraftGuard.restoreFocus` 沿既有草稿 Owner 注册链，App.tsx 在 blocker blocked→unblocked 迁移效果中执行恢复（与 AppDialog 关闭清理同轮 passive flush，不用定时器），组件 **9/9**、浏览器 **8/8**；**无 Run 文案**——按真实 `runId` 分四种事实，无 Run 不再指引核对「当前/原 Run」，vitest **13/13**、布局浏览器 **16/16**（含 `getRunTrace` tripwire 计数 0、预览≠已执行/通过）。**协调者亲跑共享检查**：workbench `tsc --noEmit` exit0、全量 vitest **97 文件 841/841**、三个受影响 Playwright spec **32/32**、`vite build` exit0；`build-release.ps1` **exit 0**（manifest `desktop-build-manifest.json`、EXE SHA `ac06cc1e…1f191`、输入指纹 `86f4d2f2…5312`、17252 资源哈希、0 禁止配置文件）。成绩、反例范围与剩余限制只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「草稿继续编辑焦点与无 Run 文案（2026-10-08 实施轮）」行；焦点规则归[工作台 §17.13.2](../frontend/workbench-design.md)（该节已于 2026-10-19 被「未发送草稿按作用域保留」取代，历史焦点恢复行为不再生效）。

**下一步**：真实 Windows 窗口内按上一轮电脑插件复验的两条复现路径复验两处修复（新包已含修复，EXE `ac06cc1e…`）；编辑器禁用兜底分支与窗口关闭弹层/协作页 transition 弹层的默认回焦维持现状（按要求未接入恢复）。未验的绑定异常、UNKNOWN、IME/DPI及安装等不是本修复任务范围，不据此判当前功能失败或提升 M/N 总出口。

## 当前 release 的真实 Windows 限定业务复验（2026-10-08，前轮记录）

用户明确要求用电脑插件做真实验收。协调者使用 computer-use 实际操作当前 release 的 Windows/WebView2 窗口，并复用两个只读子代理并行核对包/实例身份与前后业务快照。**窄短窗新对话、草稿保护、原生目录取消/确认、同一会话归入项目并保留原消息身份，本次限定范围通过。** 当前包已在新的自有隔离实例真实运行，测试实例已正常关窗并准确清理。本次未改产品源码、未重建包、未重跑前轮工程/浏览器成绩；结果与限制只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)，不提升 M/N 总出口。

**前轮实施成绩（本次未重跑）**：workbench `tsc --noEmit` **exit 0**、组件全量 **97 文件 832/832**、Chromium 全量 **83/83**（串行）、窄窗新对话浏览器 **5/5**；`build-release.ps1` **exit 0**（17252 个资源哈希、0 个禁止配置文件）。

**前轮修掉的两项**：① 窄窗/短窗的全局「新对话」入口随左栏隐藏而消失，唯一替代路径藏在文件夹折叠区 —— 现抽出唯一 `/agent?new=<key>` href，宽窗与抽屉共用；② `build-release.ps1 -TestPackage` 构建一个目录而启动器硬编码读另一个目录、且从不比对 exe 与 manifest —— 现启动前强制包身份校验并把包身份写进 `session.json`。

**当前包与本次实例**：沿用 manifest `built_at_utc=2026-10-08T08:49:17Z`、EXE SHA `e4ba4145…dc16c` 的当前 release，四对关键源码/包资源经只读核对匹配。新自有实例宿主80452→API78884/1442、监督器78016、PG76860/1434，61条迁移和Graph存在，PG与live正常，真实业务读写成功。匿名ready401为权限边界，本次未另取凭据做外部认证ready探测。配置仅4个DB/Workspace键，宿主过滤继承Provider配置；实际账本为1次Fake Assist、0次真实Provider。

**下一步**：补原生绑定拒绝/响应丢失和未知Run控制回执跨revision/整页重读的剩余出口。现有release没有可靠的有限控制响应丢失注入能力，Playwright拦截、普通202/PENDING或Mock动作UNKNOWN均不能替代；保持未验收，不据此判产品失败或扩展生产架构。原ff4e…实例/marker/端口本次检查已不存在，旧资源故障与清理阻塞只保留历史；本次新cde4e864…实例启动exit0，电脑插件正常关窗后宿主/API/监督器已退出，匹配stop脚本exit0、PG停止、临时根删除True。残余目录 `…\Temp\relay-api-integration-04c2bc42f4` 仍保持记录、未重试。**未验**：安装/升级/卸载、真实中文IME、多DPI、屏幕阅读器和真实Provider；当前release的限定原生业务通过不等于整体交付。旧包备份仍在仓库外 `%TEMP%\opencode\release-backup-20261005`。

**本轮不推进其他 M／N 模块，不提升 M／N 总出口。**


## 当前桌面产物与窄窗新对话入口接续（2026-10-08，历史任务基准）

用户明确要求使用电脑插件验收后交付提示词。协调者实际操作真实 Windows/WebView2，并复用两个只读子代理并行核对运行资源和入口语义。**短窗任务详情阅读、完整编号展开、导航及目录选择取消保留草稿通过；窄窗全局新对话入口未迁移，替代入口藏在文件夹折叠区，属于可发现性缺口。当前原生后端和已有 release 资源仍旧，完整新包的 Windows 业务及安装出口未闭合。** 本次没有修改产品源码或正式测试，没有重跑前次工程/PG/浏览器成绩。实际范围、窗口身份与剩余项只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)，不提升 M/N 总出口。

**已执行**：[环境配置材料核对与真实业务验收接续](../../prompts/remediation/env-material-and-real-business-20261008.md)中的环境文件材料修复及未知控制命令整页重读恢复，均已进入当前实现并完成前次限定独立复验。保留已通过的验收依据正文和页头布局，不重复重做。

**下一步**：按[当前桌面产物、窄窗新对话入口与真实业务接续](../../prompts/remediation/current-desktop-and-new-conversation-20261008.md)，实际并行派发桌面准备与窄窗入口两个子任务，由协调者独占构建、隔离启停及电脑插件独立验收。提示词已交付，尚未执行；本次授权仅为验收与写提示词。下一轮需让当前源码的完整桌面资源确实运行在匹配初始化的自有环境，再补同会话目录绑定、拒绝/结果未知与控制命令整页重读的真实 Windows 证据。当前旧 debug 窗承载 5173 当前前端，但实际 bootstrap API 为 7661、旧 target/debug/api 资源、relay_trial，不能拼接成 8788/relay_acc_20261008_c 的浏览器业务成绩。真实 IME/DPI、屏幕阅读器及安装/升级/卸载仍未验，真实 Provider 未调用。残余 Temp/relay-api-integration-04c2bc42f4 清理此前被自动审核拒绝，本次未重试，保持人工处理记录。不扩展到其他 M/N 模块或全站响应式重构。

以下为之前的实施与独立复验时点，不继续沿用其“当前下一步”、已修复阻塞或工具不可用描述。

## 正文与页头复验完成；环境文件材料及真实业务待闭合（2026-10-08，前轮独立复验记录）

用户要求完成后再次验收并给出接续提示词。本轮实际复用两个只读验收子代理，分别独立核对当前后端与前端，协调者通过电脑插件复核真实 Windows/WebView2。验收依据正文与页头技术信息本片通过，已修复项不再重做；检查材料仍有环境文件读取漏算，且本轮未取得正式 PG 结果。确切成绩、反例范围、窗口身份与审核限制只归[统一验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)，不提升 M/N 总出口。

**下一步**：按[环境配置材料核对与真实业务验收接续](../../prompts/remediation/env-material-and-real-business-20261008.md)，修复或明确拒绝环境文件值被误当终止符的形态；先核对私有验收 wrapper 与原运行器差异，再取得当前源码的正式 PG 结果；补真实 API/PG 与 Windows 的同会话归属和未知控制核对。提示词已写、尚未执行，本轮没有修改产品源码。保留既有 Windows 窄/短窗、IME/DPI 与安装限制，已被审核拒绝清理的临时目录留待人工处理。

以下为之前的实施与复验时点，不继续沿用其“当前下一步”或工具不可用描述。

## 检查入口漏算与验收依据窄列整改（2026-10-08，实施记录）

用户要求按上一轮独立验收的三项缺陷直接整改并复验。本轮**实际派发两个实施子代理并行**（A 后端检查信任解析＋单元/真实 PG 集成；B 前端验收依据布局、任务页头元信息＋组件/浏览器回归），文件所有权互不重叠，协调者负责公共集成、独立复验、真实 Windows 复验与文档。**三项已确认缺陷全部修复，两项真实反例先红后绿**，成绩、原始证据与桌面覆盖边界只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)对应两行。

**本轮实际成绩（协调者亲跑，不继承上一轮成绩）**：固定 Node v24.21.0，`apps/api` 重编译 exit 0；定向单元 **51/51**；真实 PG `check-trust-gate` **12/12**（status PASSED、临时集群已删除）与 `tool-loop` **45/45**。workbench `tsc --noEmit` exit 0、`vite build` exit 0、组件全量 **95 文件 824/824**、Chromium 全量 **78/78**。

**修掉的三项**：① `check-trust-basis` 保留「选项已结束」状态，终止符之后真正被执行、名称以横线开头的入口计入冻结材料（`node -- --entry.mjs src/value.txt` 旧实现漏算，冻结后换入口仍 AUTO）；② 验收依据的无编号条件列表改用专属修饰类单列，原编号＋正文二列 grid 一字未动，正文不再落进 32px 编号列；③ 任务页头完整任务 ID 降为 `code` 小字缩略并保留可展开的完整值核对入口，元信息改分组换行。**协调者另行修正子代理的一处语义**：终止符只在入口之前有「选项结束」含义（Node 实测 `node check.mjs -- --verbose` 正常执行并把二者作为 argv 传下）。

**下一步**：真实 Windows／WebView2 窗口复验仍未做——本会话没有电脑／桌面控制插件（工具目录与 MCP 均无 sky／computer-use 类工具，已按规则有界重试后停止，不绕过插件）。窗口身份已核（PID 69560、debug `relay-desktop.exe`、SHA256 `52949ea4…b48e3`、标题 `Relay Agent`、Responding=True），但该 exe 是**旧构建**，不等于当前源码的新发布包。恢复 dev server 后确认 5173 提供的是已修复源码，可在下一次具备桌面控制能力时直接复验：任务详情滚动阅读完整验收依据、补充条件表单就地展开／空值禁用／取消、窄窗 Run 抽屉入口与滚动后焦点不被顶栏遮挡。另需留意两处环境与残留限制：`.relay-test` 试库缺 LangGraph checkpoint 表致 `/health/ready` 503（业务数据路径正常），以及 `node --env-file=-- check.mjs` 会读取名为 `--` 的文件而该文件不进材料（修复前既有行为，需受管根内存在该文件名才触发）。目录绑定／未知控制的真实桌面业务闭环、IME／DPI 与安装验收仍保留。

**本轮不提升 M／N 总出口。** 断点收敛仍未覆盖全站（Reviews 仍有 60rem/.9375，Knowledge 与 Run 仍有旧式及局部断点）；本轮不借此扩大为全站响应式重构。

## 优化 UI 与业务底线独立复验（2026-10-08，上一轮）

用户要求验收当前实现。本轮复用后端验收子代理，并另派前端只读验收子代理并行复核当前源码；协调者通过电脑插件操作真实 Windows/WebView2 窗口。旧五项缺陷的已测试形态已闭合，但本轮发现新的检查入口信任漏算与验收依据窄列问题，因此整体仍未通过。实际成绩、原始证据及真实桌面覆盖边界只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)，本轮未修改产品源码，不提升 M/N 总出口。

**下一步**：已由上一节接手（旧检查入口信任漏算与验收依据窄列整改）；任务页头完整 UUID 的呈现与既有降级规则也需对齐。修复后重新编译、复跑原回归和新增反例，再复核真实 Windows 的任务详情阅读路径；目录绑定/未知控制的真实桌面闭环、IME/DPI 与安装仍保留验收限制。

以下为各实施与验收时点的接续记录；已修复的旧红例不作为当前缺陷，当前下一步以上述段落与验收表为准。

## 控件基座与响应式收敛（2026-10-08，实施记录）

用户要求对全部按钮（含发送键）、表单控件、导航、状态提示做控件级精修并统一响应式。本轮先派 2 个只读审计代理（控件层/导航与响应式），再**实际派发 4 个实施子代理并行**（D1 styles.css 基座 +198/−22；D2 协作/Assist/Settings/CreateTask 收编；D3 断点收敛 9 处；D4 面包屑 Link 化+文件处置枚举中文），协调者补 token（`space.0.5`、contrastChecks 31→33）与 RunView h2 收尾。**修掉两个 P0**：全局 `[aria-busy]` 缺失、`.success-callout` 无定义致蓝图页裸段落；**一致性修复 12 项**：primary 双高度 compact 修饰符、输入 focus 弱于 hover、checkbox/radio 误套 min-height、发送键 token 引用（几何不变）、委托开关反馈补齐、断点 11 种写法收敛为三档语义、恰 80rem 双触发、死标题规则、裸 z-index、面包屑父级可点、Activity 选中行零位移方案、sticky top 实测修正。**不强改**：委托开关复合控件保留自有规则（反馈已对齐）、ARIA 两套语义并存各自合法。**验证（协调者实跑，exit 0）**：tsc、全量 **824/824**、生产构建、浏览器基线 **8/8**；子代理定向 117/117、58/58、19/19、全量 824/824。成绩与限制只见[验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「控件基座与响应式收敛（2026-10-08）」行；规则归[设计系统 §9.6](../frontend/design-system.md#96-控件基座与响应式收敛2026-10-08)与[工作台 §17.15](../frontend/workbench-design.md#1715-控件交互基线与响应式收敛2026-10-08)。**下一步**：桌面解锁后目视复验 48–60rem 区间与控件新状态；对比度运行时取色实测；`layout.header.height` token 语义澄清回写。本轮不提升 M/N 总出口。

## 前端视觉样板与全站收口；五项业务底线闭合（2026-10-07 晚）

用户以任务详情截图为样板要求直接实现优化 UI，并要求多子代理并行、完成一批自动推进下一批。本轮**实际派发 10 个执行子代理并行**（第一批 A1/A2/A3/A4/B，第二批 C1–C5），文件所有权互不重叠，协调者独立复验每批后自动推进。**四项未闭合缺陷已修复并有 RED→GREEN 证据**：检查信任的等号/分离式开关值漏算（A1）、取消终态后 REQUESTED 工具请求收口（A2，取消应用事务内直接收口，暂停路径不触碰）、RunControlPanel runKey 含 revision 丢未知控制命令（A3）、协作页绑定拒绝后历史消失（A4，归属未确认保持工作区级视图）。任务详情页按设计图完成布局重组、验收条件 grid、补充条件就地化与验收依据四事实呈现；列表/待处理/资料/设置/连接/今日/动态/协作/Run 九类页面完成枚举中文化、实现词清理、时间本地化与空态收口。

**工程成绩**（协调者实跑，exit 0）：workbench `tsc`、全量组件 **95 文件 824/824**、生产构建；API 单元 **468/0/1**（固定 Node + helper）；真实 PG `tool-loop` **45/45**、`check-trust-gate` **10/10**（子代理跑）；新增 `taskDetailVisual` Chromium 多分辨率 **8/8**。**真实 Windows**：`desktop-dev.ps1` 启动 relay-desktop（需 `RELAY_DESKTOP_CONFIG_PATH` 指向 `.relay-test\desktop.env`），语义树确认任务详情精修结构完整呈现；锁屏后桌面交互收敛，目录绑定/短窗/IME/DPI 未验。过程中恢复 workbench `node_modules/.bin` 垫片（workbench 为 pnpm 独立包，需在其目录 `pnpm install --ignore-workspace`）；结束了一个 10-06 关窗遗留的无窗口 relay-desktop 进程以释放编译锁。成绩、限制与未做项只见[验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「任务详情精修样板与全站视觉收口（2026-10-07，本轮）」行；规则归[工作台 §17.14](../frontend/workbench-design.md#1714-任务详情精修样板与全站视觉收口2026-10-07)与[设计系统 §9.5](../frontend/design-system.md#95-任务详情样板与全站枚举呈现2026-10-07)。**下一步**：桌面解锁后补真实目录绑定与短窗交互复验；指定模型独立验收仍按用户既定决策等待；各页局部映射择机收编 `labels.ts`。本轮不提升 M/N 总出口。

## 后端接续：检查信任摘要、证据适用性与控制归属（2026-10-07）

用户下发[后端接续任务书](../../prompts/remediation/backend-continuation-20261007.md)并要求继续执行（「有些可能已经做过了」）。开工核对确认：上一轮已写好阶段 A 的 RED 测试与占位实现及类型骨架，但**未实现、未接线**；阶段 B–E 无新产物。

**阶段 A/B/C 实现已接线，整体独立验收未通过**：检查信任摘要在冻结期落库并由 Gateway 核对，候选证据版本完成门与终态请求补偿已有实现。本次独立实测确认两类可执行参数被漏算，修改被执行脚本后摘要未变仍获 AUTO；取消已应用后未派发工具请求仍留 `REQUESTED`，现有补偿只有旧 Worker 再进执行入口时才触发。阶段 B 的候选版本与既有暂停/取消等定向真实 PG 出口本次已实际复跑，不再写「集成未跑」。下一步先修参数语义与取消安全点收口，并以新增反例及原回归独立复验；范围与成绩只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。规格归[测试计划 §20.6/§20.10](../testing/verification-plan.md#2010-检查入口的信任摘要与检查证据适用性2026-10-07-实施)。

**文件助手状态更正**：此前记录的 `DELETE_FAILED` 是当轮失败现象，未足以证明所有写路径永远不可跑或排除产品缺陷。本次现有 helper 的合成受管写入/清理成功，相关单元与真实 PG 写路径均能复跑；撤回「全部本机环境阻塞」及「已排除产品缺陷与调用口径」的确定归因，不据此要求修改系统安全策略。历史输出保留在本机，复发时按实际输入和 native 结果重新定位。当前优先级是修已复现的业务缺陷。

## 前端接续首波：同会话归属与工具事实（2026-10-07）

用户下发[前端接续任务书](../../prompts/remediation/frontend-continuation-20261007.md)后，本轮完成 FE-00 基准冻结与首波并行实施。**实际派发两个独立子代理**：A 做 FE-01 同会话目录/项目归属，B 做 FE-02/03 Git/轨迹/控制事实审计与缺口修复；文件所有权互不重叠，协调者负责公共集成、独立复验与文档。

**首波实现已接入，但独立验收未通过**：同会话目录归属与 `onActiveSessionChange` 接线、跨 Run 轨迹游标重置已有实现。本次受控反例确认：目录绑定被 409/403/404 拒绝后原未归属历史从当前界面消失；同 Run 的修订更新会清掉结果未知的控制命令 ID 与回执核对入口。下一步先修这两处并复验，不能按「FE-02/03 已满足」继续依赖模块。具体位置、成绩与限制只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

**工程与桌面结论分开**：本次类型与构建通过，全量组件仍有失败；受控反例确认上述缺陷。真实 Windows 已补待处理/资料/记忆/收件箱空态及原测试任务刷新读回，未覆盖有会话目录绑定和 Run 控制。因此本片保持未通过，不提升 M/N 总出口。规格归[测试计划 §17.1.1](../testing/verification-plan.md#1711-同会话目录项目归属2026-10-07)，交互归[工作台 §18.1.2](../frontend/workbench-design.md#1812-同会话目录项目归属2026-10-07)。

**剩余范围**：FE-04（助手身份/归档/首条恢复）与 FE-05（验收条件 CAS 与旧证据适用性界面）未进入；FE-06 全站空态/错误收口未完成，FE-07 真实 API/PG 浏览器未运行，FE-08 只补验收表所列的空态导航与原人工任务读回，总出口仍未完成。真实 Windows 原生目录选择、同会话历史、中文 IME、DPI、安装升级卸载仍待验。本轮不提升 M/N 总出口。

## 前后端长任务提示词与真实桌面接续（2026-10-07）

本轮用户要求按「先后端提示词 → 电脑插件真实 Windows 验收 → 前端提示词」交付。新入口为[后端接续任务书](../../prompts/remediation/backend-continuation-20261007.md)与[前端接续任务书](../../prompts/remediation/frontend-continuation-20261007.md)，均要求执行协调者实际派发两个独立子代理并行、共享文件单 Owner、分批复用及独立验收后推进；本轮只编写任务书与执行桌面验收，未启动任务书中的业务开发。

真实 Windows 本轮已从现有窗口创建明确标记的测试项目/人工任务，追加条件并刷新读回；范围与电脑插件最大化后点击边界故障只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「Windows 有数据人工创建与条件追加」行。下一步按任务书闭合单 Agent 后端信任/证据/恢复及前端同会话目录绑定、工具事实与人工处理；新提示词不扩大到产品多 Agent、M07 恢复激活或 N 后续，也不提升 M/N 总出口。测试项目与任务明确保留，未委托、未调用模型。

## Windows 页面巡检整改（2026-10-07，限定整改已复验）

用户已授权将巡检发现的四类问题写成[详细整改提示词](../../prompts/remediation/windows-page-acceptance-20261007.md)，并直接派给 `gpt-6-luna / max`（用户指定模型的最高可用推理档）。范围限定为摘要入口覆盖、首条助手消息呈现与准入、收件箱导航高亮、待处理/资料右栏空态；保留既有未提交修改，不推进其他 M/N 模块。执行者负责源码与自动化自检，协调 Agent 负责文档及独立复验。

四类问题已完成实现、自检与协调独立复验。真实 Windows 复验覆盖摘要开关、首条助手空清单准入、导航唯一高亮及待处理/资料右栏空态；工程测试成绩与剩余限制只维护[验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「真实 Windows 页面巡检及限定整改（2026-10-07）」行。两页默认自动选首条，非空未选中分支没有稳定页面操作复现，不为造测试新增功能。

接续授权（2026-10-07）：用户要求继续验收并直接派发，已按[第二轮详细提示词](../../prompts/remediation/windows-page-round2-20261007.md)复用 `gpt-6-luna / max` 执行者，限定修复 CLI_RUN 可执行文件配置 UI 与普通聊天底栏行高。两项红例已修复并经协调者独立复验，工程成绩及真实 Windows 短窗范围只归[验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「Windows 页面第二轮整改（2026-10-07）」行。下一步补齐有数据真实 Windows 业务路径及真实连接配置闭环；空工作空间巡检不提升为发送/恢复或安装验收，不自动推进其他 M/N 模块。

## 首装空态：说清「没有」并给出入口（2026-10-06）

用户反馈「没数据的时候好空」，裁定范围为首装空态、实现方式为共享组件逐步替换。新增共享组件 `components/EmptyState.tsx`（`regular` / `compact` 两形态，消费既有 token，未新增色值/圆角/时长/第二套尺寸），本轮替换 `/projects` 的 fixture 与 live 两个视图与左栏「近期的任务」。交互归[工作台 §17.13](../frontend/workbench-design.md#1713-首装空态说清没有并给出入口2026-10-06)，组件归[设计系统 §6 EmptyState](../frontend/design-system.md#emptystate2026-10-06)。

顺带修掉一个真实的分支不一致：live 视图的空态此前没有任何主操作——`onCreate` 已传入 `LiveProjectsListView` 却未在空态里使用，而 fixture 视图本就有「新建项目」。

范围区分是硬要求：首装为空、搜索无匹配、页签/归档范围为空是三件事，不能合并成同一句话；搜索无匹配不得暗示整个工作空间为空，归档范围为空不得提供「新建项目」这类无效入口。左栏只给文字动作，不放 primary。

**实际验证**：`typecheck` 通过、`build` 通过、浏览器用例 `projects-empty-state` **6/6 通过**（Chromium headless，页面内拦截伪造空工作空间；本轮独立复核更正此前记录的 4/4，该 spec 实为 6 条用例）。**归属更正（2026-10-07 独立复核）**：`uiOption2FirstSession.spec.ts:437` 的 `toolsHeight` 32 vs 40 失败**不是本轮引入**——结论成立，但此前归因写的是「未提交 `AssistView.css` 改动」，**该表述有误已更正**：实测该文件没有任何未提交改动，根因来自**已提交**的 `3abcc46`，其 `.agent-chat-mode-option { min-height: control-height }`（40px）作为底栏行首个子元素顶高整行；该 chip 破坏了 `design-tokens.json` 中 `radius.composer`「底栏行高与此键一致」的既有契约，**是真实缺陷但归属不在本轮**，修复点在 `AssistView.css`，需其所有者裁定。同轮由 4 个子代理分工复核工作台 API client 四层，两端 typecheck exit 0、前端全量 752/755，修掉传输层与 `createKnowledgeCurationCandidates` 两处真实缺陷并闭合了 24 个未跟踪文件的提交缺口，成绩与限制只见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)“工作台 API client 分层与传输层加固”行。

**未做**：其余 10 余处空态未替换；真实 Windows 窗口渲染、窄/短窗、DPI、真实中文 IME、屏幕阅读器与对比度实测均未做。**未决待用户裁定**：首装空态「新建项目」与页头常驻「新建项目」同屏两个 primary，当前保留两个（页头入口在「已归档」页签与列表非空时同样必须可发现），是否降级其中一个待定。成绩与限制只见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)“首装空态（2026-10-06）”行。

## 标题栏常用操作回到左侧（2026-10-05）

用户指出后退、前进、搜索、新建任务原本在标题栏左边，此前一轮被移到下一层应用顶栏。现已移回：`DesktopTitleBar` 渲染 `WorkbenchActions` 于拖动区之前，`AppShell` 不再重复承载；无面包屑页面在宽屏收起空顶栏。行为、准入与草稿保护未变，浏览器仍显示这四个入口、只有窗口控制归桌面宿主。开发自检 `tsc --noEmit` exit0、全量 vitest **733/733**、`vite build` 通过、新增浏览器用例 5/5；唯一失败的 `R02` 已用 `git stash` 在基线复核为既有偶发。**真实 Windows 窗口未验**，成绩与限制只见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)“标题栏常用操作回到左侧（2026-10-05）”行。

## 会话模式与人设助手（2026-10-06，后端已实施）

用户要求在协作页聊天框加一个切换模式的单选框，两档为「普通 Agent」与「像 grok bot 那种的」；随后明确 bot 只是举例、改称**助手**，并选定「团队角色」只作为组织方式进入本片（不引入多角色同场协作）。取舍见 [ADR-018](../decisions/ADR-018-assistant-conversations.md)，范围归[范围补充](../requirements/v1-scope.md#会话模式与人设助手补充)，工程责任归[运行架构 §2.6](../architecture/runtime-context.md#26-会话级只读工具轮次)。

**本轮完成（后端，提交 `f64b19e`/`c58f8de`/`1243d7b`）**：迁移 0059 建立 `assistant_profiles` 与会话身份列，身份在建立时冻结；迁移 0060 新增第四种 Gateway 来源与 `session_tool_calls`；助手会话复用既有领取/租约/取消/CAS，只换词表、账本与来源三处。真实 PG 出口：会话模式与助手配置 13/13、只读轮次 6/6、准入与撤销 6/6，回归 `tool-loop` 36/36、`folder-first-conversation` 7/7，API 单元 446 通过/0 失败/1 跳过，整仓 `tsc --noEmit` exit0。实际成绩与限制只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)“会话模式与人设助手（2026-10-05）”行。

**前端本轮完成（提交 `frontend`）**：协作页聊天框加两档单选框；助手档隐藏发送选项与执行摘要/提案入口、显示只读边界说明，消息行标注「审读 · 人设 v3」，发送不带 `intent` 与 `skill_ref`，有在途回复时整组禁用；助手下拉可就地新建（只读范围只提交受管根内相对路径）。jsdom 出口：解析 9/9、模式单选框 11/11；工作台全量 754 通过/1 失败（唯一失败在并行 Agent 在途的 `projects.spec.ts`，与本片无关）。

**未做**：模式深链——路由出口按 `pathname + search` 重挂载而工作目录是组件状态，身份进 URL 会把目录一起丢，已改为由协作页持有（见[工作台 §25.4](../frontend/workbench-design.md#254-导航与深链)），这是实测结论不是取舍遗留；导航分组；真实浏览器几何与原生 IME/DPI、未发送草稿的离页守卫在切档时的行为、只读工具卡片与归档冻结后的呈现；真实 Windows 人工路径与安装升级卸载；真实 Provider 下助手会话的质量与边界遵守。未运行规格归[测试计划 §23](../testing/verification-plan.md#23-会话模式与人设助手验收规格)。

**依赖与边界**：普通档行为逐字未变；A 档的「派发子 Agent」仍属 ADR-017 且至今零代码，因此单选框标签不得写该承诺。助手档不排队、拒绝 Skill 与提案、归档后冻结但历史可读；停止复用既有消息取消通道，不新增停止资源。多角色同场协作与 ADR-017 已否决的候选三重叠，须另开 ADR，本轮不做。

下一步：补浏览器几何与真实 Windows 人工路径验收（单选框方向键可达、中文输入法合成中回车不发送、窄窗不溢出、切档时的草稿守卫），并据此决定是否把工作目录搬进 URL 以支持深链。

## 传统 Agent 闭环接续（2026-10-05，当前工作范围）

按用户「继续推进传统 agent 能力闭环」接续单 Agent：已补普通检查失败回传、失败检查释放原 claim、生产图返回修正轮与冻结检查 ID 可发现性，并修正失败/UNKNOWN 在恢复时被误当成功的问题。真实 Provider 已经生产调度图完成「检查退出 1 → 定位/读 → 写 → 同一检查退出 0」定向探针，候选与 HUMAN Review 已持久化，重放无新增效果；生产图与恢复回归的确切结果、指定模型独立复核和限制只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)，不升级 M/N 总出口。

下一步：闭合脚本/构建配置的信任摘要与检查证据对产物版本的适用性，再验证当前源码对应的真实 Windows 会话路径及停止/恢复呈现。检查脚本 hash 和 Windows 进程 Job 边界仍有明确缺口，普通检查通过不替代人工接受。产品多 Agent A/B/C 不在本轮范围。

## 新对话入口（2026-10-05 接续）

接续聊天 `01a10a5c-81d0-7c21-8b61-5656bc905b3e` 的最新用户选择：**点击新对话直接看到输入框，文件夹按需选择**。入口与普通讨论已接入：明确新对话不恢复旧会话；空白页单列，目录和已有任务默认收起；首条发送再建会话，无目录也能读取历史并连续讨论。已修复首条未决状态不清、空读取后不刷新、旧候选跨会话和迟到原响应清空新草稿，实际验证只归验收表「新对话直接起步」行。

同日用户要求新建对话对齐已有对话截图：首条输入器已复用已有会话的阅读宽度、底部位置及工具栏，目录与接续已有任务入口收在主区顶部；功能与视觉验证仍只归验收表「新对话直接起步」行。

本片不推进 M/N 总出口。普通讨论后选目录的同会话归属前端已接入，但当前独立验收发现绑定拒绝后历史隐藏，尚未通过；接续状态以本文件上方前端接续节及验收表为准。此前验收条件与 Git UI 的未提交切片保留，不将它们的旧自检自动升级为验收。

## 读写主链（2026-10-05 首片，保留原验证范围）

**用户现在能否从文件夹会话让 AI 读取文件并实际修改代码？后端闭环已通过，工具轨迹源码已接入，真实窗口呈现仍待复核。** 真实 Provider + 真实磁盘目录验证：目标里不含目标路径（只说「src 目录里」），模型自行 `find_paths` → `read_file` → `apply_changeset` 三步全 `SETTLED`，磁盘内容含要求的新串且保留它读到的原标记串，用户既有的无关文件逐字节未变，再次推进同一 Run 不产生第二次写入。

本轮修掉四处使这条主链**在设计上不可用**的缺陷（每处都先落 RED 反例再改实现，规格见[测试计划 §20.4](../testing/verification-plan.md#204-读写主链与写能力开关2026-10-05-实施)，成绩归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)对应行）：

1. **提示词与能力错位**：声明了 `apply_changeset` 的 DRAFT 仍固定写「工具只读，不修改任何文件」。改为按本次实际授予的能力生成提示词——只读集保持只读，含编辑则改为「先用读取工具读到真实内容再提出变更」，并同时声明删除与越界不在授权内。只删限制不落实准入同样是错的，两侧一起改。
2. **写能力开关依赖提前猜文件名**：只按 `candidate.file_changes` 非空授予，而解释模型没有目录访问、拿不准路径是常态，于是「目录里那个解析函数修一下」永远拿不到写工具。候选新增与路径无关的布尔 `writes_files`，判定收敛到单一纯函数 `wantsConversationFileWrite`；只读盘点声明 `false` 就没有写权，因此补齐缺口不等于扩大授权。
3. **只读准备的恒真判断** `if (wantsWrite || true)`：无条件要求 `FILE_WRITE` 连接，只读请求被一条用不上的能力挡住，报错还指向错误项。已移除；纯只读任务改为不落 `allowed_actions` 为空的范围授权。
4. **真实模型实测才暴露的致命一处**：`apply_changeset` 词表只声明 `items: { type: 'object' }`，模型无从得知修改必须带 64 位基线摘要；同时 `validateToolArguments` 只处理标量，把 `changes` 数组从规范化结果里丢掉，必填检查随即报「缺少必填参数」。修这两处之前真实模型连续 4 次写请求**全部被拒**——只读能跑通，写永远跑不通。词表现在逐项声明字段，校验器只做数组形状检查、逐项语义仍归原函数。

该首片当时没有覆盖检查失败后的自主修正、写路径控制恢复与指定模型独立复核；它们的后续结果分别见验收表「传统 Agent 检查失败后的自主修正」与「单 Agent 依赖门」行，不继承首片成绩。仍未覆盖：当前源码对应的真实 Windows 会话人工路径、工具轨迹窗口呈现、原生目录选择、中文 IME、DPI 与 Provider 稳定性；首片曾多次遇到免费额度的 429，单次成功不证明稳定。删除、扩大范围与 Git 提交/推送仍不自动放行。

**当前结论：M01–M03 已在注明基准与范围内独立验收；M04–M07 总出口与 Windows 安装交付仍未完成。** 通过项绑定原运行环境和版本，不自动覆盖当前未提交修改。真实 Provider 已于 2026-09-29 获用户授权做定向验证，不把早期“保持关闭”当作现在的配置事实，也不自行扩大外发范围。

N 阶段（V1 后续长期协作）已按[整阶段提示词](../../prompts/post-v1-collaboration.md)开始接续，2026-10-02 完成 N00 测量缺口、N01 独立验收 P1 修复与 N02 首片实现；三者的实际范围、命令与剩余项只见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)“N00–N02 后续长期协作首轮”行。M 阶段状态不因 N 阶段推进而改变，N 阶段也不解除 M 出口。

## N 阶段当前状态

| 包 | 状态 | 当前范围与剩余出口 |
|---|---|---|
| N00 使用基线 | 脚本缺口已补，链路已通，基线未测 | `n00-baseline.mjs` 已接入 Trace 的 `first_text_delta_at`/`first_preview_persisted_at`。取数时发现桌面库停在 0048 导致 Trace 全量 500，已备份并补迁移至 51 行，脚本对真实 run 复跑 exit0。**基线本身待用户按 `n00-task-set.json` 填真实 `runs` 与 `observations` 后才产出**；未测前不得声称省时 |
| N01 项目接续点 | 工程自检通过，独立验收 P1 已修并复跑 | 独立验收的 P1 断言已改按 `ref_id`，当前源码连续 3 次 4/4 全绿；P3-1 规格缺口已登记。真实 Windows 人工路径与 PV01/PV08 未跑 |
| N02 跨成果共创 | 首片工程自检通过；独立验收阻塞项已修复复跑 | 候选组＋组合检查单（迁移 0050、四个端点、面板视图），真实 PG/HTTP 3/3、组件 3/3。首轮独立验收 CHANGES_REQUESTED 的唯一阻塞项（登记引用缺口核错父版本造成每项假缺口）已修并补两条断言。候选间依赖联动、不完整选择拒绝、组级回滚与真实 Windows 差异审阅未做 |
| N03 项目知识整理 | 后端与前端均已接入；独立验收 P1 与四项 P2 已修复复跑 | 导读编排（迁移 0052）+ 整理候选（迁移 0053），7 个端点，真实 PG 5/5（含接受/拒绝竞态与同 command_id 并发重放）。前端：知识页导读编排视图（重写 `ProjectKnowledgeGuide.tsx`）、谱系页整理候选面板（新增 `KnowledgeCurationPanel.tsx`）、workbench 606/607。首轮独立验收 CHANGES_REQUESTED 的 P1（被拒候选仍产生无归属知识版本）与 P2（拒绝态读取丢失、两处并发不返回原回执、工作空间级同名知识死路）均已修复。旧版客户端聚合导读已整体替换，项目目标不再出现在导读内。真实 Windows 与 PV03/PV08 未做 |
| N04 周期计划 | 基础数据片已接，完整出口未验 | 2026-10-14 当前授权接估时、固定容量、候选与逐项选择/独立诊断，协议归 HTTP §10.74；实际成绩只归统一验收表。前端只接客户端，完整重排/会话入口、Windows/实用出口仍缺，不继承旧轮仅规划的授权表述 |
| N05 有限触发 | 基础一次性数据/调度/客户端已接，完整出口未验 | 2026-10-14 沿当前授权接确认时刻、独立代次/发生、生命周期扫描与处理、原宿主投递功能；协议归 HTTP §10.76，成绩归统一验收表。设置/待处理 UI、Windows 原生投递与完整 PV05/PV08 仍缺，不自动放行 N06 |
| N06 有限连续委托 | 基础链及读取/修改/检查已接，完整出口未验 | 2026-10-14 接固定范围、累计预算/有效期、原 Owner 串行/控制/重开确认、确切资料和原方法行动，修改/配置检查复用原范围授权与审批；协议归 HTTP §10.77–10.79、ADR-021，成绩归统一验收表。自定义方法、活动续期、UI、Windows/PV06/PV08 与故障全出口仍缺 |
| N07 声明式配置 | 不进入 | 需 N03/N04 的实际重复使用证据；当前无该证据 |

N 阶段的实际结果、限制与归属分析只维护在功能验收表；本表只维护阶段状态。M 阶段与文件夹入口的分工、并行 Agent 的未提交改动与既有阻塞见下。


## 当前改造模块状态

| 模块 | 状态 | 当前范围与剩余出口 |
|---|---|---|
| M01：基线与适配 | ACCEPTED | [独立验收](../testing/m01-independent-acceptance.md)通过；保留原运行基准 |
| M02：React 与 Windows 基础 | ACCEPTED | [独立验收](../testing/m02-independent-acceptance.md)通过；不涵盖最新 UI 或安装总验收 |
| M03：Mock Runtime 与可靠性 | ACCEPTED | 2026-09-30 本轮后端源码与确切冻结包的有限 Mock G01–G08 出口独立复核通过；一次启动退出 101 未定位、后续连续重启未再现，保留风险，不称已修复。成绩、包身份、性能及 harness 边界只看[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表) |
| M04：模型、Context、Assist、低风险工具 | IN_PROGRESS | **2026-10-02 F24 修复轮**：两处提案接受幂等缺陷已修并复验（真实 PG/HTTP 受控行锁反例，先跑红后跑绿）；**第四项蓝图的真实模型定向测试新增并 4/4 通过**，覆盖生成只写候选、来源冻结、只读预览/Diff、基线不符 409、显式 Apply 只建 HUMAN/ME/INBOX Task、选择 Pack 不授权、重放与取消。同轮量化：`task-to-execution-contract@1.1.0` 真实调用 10 次 7 通过、3 次 `OUTPUT_SCHEMA_INVALID`，**稳定性未闭合**；四项 Skill 的质量案例/评分/重复次数/预算本轮未冻结，故只有契约合规性有证据。原调用首文本/首预览计时、选源 DRAFT→Review→完成、Assist 多轮/提案接受、Files/Web 图组合与读取委托 Windows UI 的既有定向成绩保留；真实服务故障、能力/质量、真实 Windows 与完整状态矩阵仍待验；基准和限制只看[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表) |
| M05：工作体验与追溯 | IN_PROGRESS（消息队列分片实现完成但未验收；首条消息恢复四类缺口已修待独立验收） | Today/工作台/知识/追溯及归档已有实现与分片自检；首条消息恢复 A/B/C/D 已修并自检（见[验收表 §10.9.1](../testing/overall-acceptance-details-20261025.md#1091-四类缺口的修复与复验2026-10-04)），独立验收缺；**轻量 Goal 创建入口已实施并复验**（同表「目标/任务轻量起步与状态接续」行）；当前 UI 和业务总验收未完成 |
| M06：真实工具与 Coding Worker | IN_PROGRESS | 文件/Git/CLI、账本、UNKNOWN/PARTIAL 人工处置及无回执恢复有分片验证；2026-10-02 补齐 **root-bound 能力配置入口**（`FILE_WRITE`/`GIT_READ`/`GIT_WRITE`/`CLI_RUN` 连接与策略此前无法从产品内创建，`resolveConnectionConfig` 与 HTTP schema 早已支持）；**2026-10-05 Git 动作触发的只读侧已补齐**（迁移 `0058` 新增第三种 origin `USER_ACTION` + `POST /projects/{id}/managed-resources/{id}/git-read`，真实 PG `git-user-action` **15/15**、API 单元 412 项 0 失败、`tsc --noEmit` exit 0）；**写侧与恢复驱动仍缺**——人工触发的暂存/提交/推送、受控 CLI 与目录浏览无公开入口（`USER_ACTION` 词表只放行 `GIT_READ`），`USER_ACTION` 的崩溃后自动恢复驱动尚未接入（`reconcileGatewayInvocation` 分支已就位但无调度器调用，停在 `DISPATCHING`/`UNKNOWN` 须人工核对、不盲重试）；前端 Git 页签源码已接入（2026-10-07 只读核对），独立与真实窗口验收仍缺；[确切包、人工交互及总出口](../testing/m06-independent-acceptance.md)仍待验 |
| M07：Windows 安装与 V1 总验收 | IN_PROGRESS | 完整备份CLI、启动隔离、新空库/data_root隔离还原CLI及非空目标业务只读维护核对已有实现；原/目标包分别绑定，目标CONNECT与标记保留，历史ARMED只进evidence，不自动放行或重发UNKNOWN。隔离还原原冻结源码出口已通过独立验收，维护核对冻结源码出口已通过独立验收，其余维护连接的PG环境继承已修正，冻结完整恢复组合独立复验已通过；小资源fixture不等于确切新发布包。后续为兼容/外部身份核对、明确放行及确切包维护链、安装/升级/卸载，实际结果只看功能验收表 |

## 当前实现与验证边界

- 普通聊天文件 CRUD 真实模型端到端（2026-10-19，用户报「最基础的增删改查还没跑通」）：核对后确认工具循环本身已可用（`real-model-tool-loop` 只读 1/1、写 1/1 本轮复跑通过），断点在**普通会话的执行候选**。三处产品设定问题已修：`expected_outputs.kind` 只认 `MARKDOWN_DOCUMENT` 导致模型写 `CODE_FILE` 时整条「改文件」请求被判澄清；主流程提示词让模型读成「只读工具＝不能改」而回方案并反问；只读轮次预算耗尽直接失败而无收尾。另把模型异常从统一的 `MODEL_FAILED` 拆成超时/输出不合法/预算三类。新增 opt-in 用例 `agent-file-crud-real-model` 从聊天消息走到磁盘（find→read→apply_changeset，写出 `RELAY-CHAT-OK`），首轮 `MODEL_FAILED` 后连续 6 次通过；定向单测 39/39、真实 PG `folder-first-conversation` 20/20 与 `local-directory-access-review` 4/4 通过。成绩与限制只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)首行，规则归[运行架构 §2.6](../architecture/runtime-context.md#263-两条容易被写错的边界)。未验真实 Windows 窗口，未复跑 DELETE 业务链，全量单测 21 项既有红灯不在本切片路径上。

- 真实 Provider 工具循环首次跑通（2026-10-04）：用户指出「最基础的 agent 能力还没跑通」，核对后确认 A 片机器部分（约 3000 行未提交实现）已存在且单元全绿，2026-10-03 独立验收的 8 项发现中 7 项已修；真正阻塞是两处。**其一**：`0055_m05_message_queue.sql` 末两条 `GRANT ... ON <index>` 是无效 SQL（PostgreSQL 报 `"..." is an index`），该迁移 100% 失败并挡住全部集成套件——已删除该两行（`0015` 的表级 GRANT 已覆盖，新索引自动继承）。并行 Agent 此前把同一文件诊断为「缺末尾换行」并临时移开，其验收行口径已过时。**其二**：真实 Provider 会边输出正文边调工具，`openai-compatible-model-port.ts` 把该形态判为 `ModelToolOutputError`，使工具循环整体不可用；已改为对已声明工具的入口返回 `TOOL_CALLS` 并携带 `preamble`，候选正文仍只来自无工具请求的那一轮，未声明工具的 Assist/Skill/语义检查拒绝语义不变。`real-model-tool-loop` 真实 Provider 定向验证 **1/1 通过**：模型自主发出 6 次工具调用且全部 `SETTLED`，5 次真实往返全部 `COMPLETED`、provider request id 与真实 token 用量齐全，候选正文原样回显了只存在于磁盘的 marker。**本轮只交付片 0**，成绩、限制与未做项只见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)“真实 Provider 工具循环首次跑通（2026-10-04）”行，规则归[运行架构 §2.3](../architecture/runtime-context.md#23-内部工具循环的对象身份与恢复2026-10-03-实施设计)。

- 循环终止与一次冲突适配（2026-10-04，本轮）：**预算耗尽原先完全没有代码级终止条件**——真实模型在轮次/调用预算用尽后，所有请求被拒，步骤却直接进入候选生成，模型端口回放工具请求后落到 `UNEXPECTED_MODEL_RESULT`，真实原因被掩盖成终态 FAILED（先用真实 PG 复现为 `RUN_FAILED` 再修）。现改为：一轮工具请求「无可派发项」时在同一次准备内再问一次模型并回传类型化拒绝原因——可修正拒绝（参数非法/未知工具/越界）继续下一轮，终止类拒绝（预算耗尽、冲突适配停止）先给一次收尾轮、仍无可派发项则由提交事务把 Run 停在 `WAITING_APPROVAL`（`wait_reason` 取本次准备第一个终止类拒绝，预算 → `REPEATED_FAILURE`，冲突 → `HUMAN_TOOL`），Task 转 `WAITING` 但执行权与 `ownership_epoch` 不变，用户可新预算（新委托）、接手或停止；**刻意不建 Review**——工具循环预算冻结在 Run 信封里不可就地调整，`RETRY_BUDGET` 决定分支又强绑验证 session 与产物版本，复用会造假关联。一次基线冲突的自动适配同时接入：合法适配须同时满足「针对已结算的真实 `CONFLICT`」「一次只针对一个路径」「基线等于冲突回执实测 `actualBaselineSha256`」「目标内容与被拒那次不同」，否则按 `TOOL_ADAPTATION_STALE_BASELINE`/`_CONTENT_UNCHANGED`/`_AMBIGUOUS`/`_TARGET_MISSING`/`_REQUIRES_HUMAN` 拒绝且不连 Operation、不写盘；合法适配落 `adaptation_of`/`adapted_path` 指回原始请求，不继承旧的单动作审批。规则归[运行架构 §2.3](../architecture/runtime-context.md#23-内部工具循环的对象身份与恢复2026-10-03-实施设计)与[工具适配器 §2](../architecture/tool-adapters.md#2-files)，规格归[测试计划 §20.3](../testing/verification-plan.md)。同时更正两处记录：`0056` 迁移注释称「只适配一次由深度约束保证」，实际 CHECK 只保证两列同在同缺，深度限制由应用层判定；本轮开工时记录的 `DesktopTitleBar.tsx:109` 解析错误（71 个 suite 失败）已不复现，两端类型检查与组件全量均绿，「消息队列顺序确定性」行的阻塞前提已消失。
- 产品入口已接（2026-10-04，用户选定**方案 B**）：文件夹首条对话在 Apply 时冻结 `tool_loop_action` + `scope_grant`，不再冻结 `file_write_action`/`cli_run_action`。解释候选的 `file_changes` 只剩 `path` + `action`，带 `content` 被确定性拒绝——解释模型没有任何目录访问，正文只能是编造，原提示词「缺少实际内容就 CLARIFY」正是最常见的「帮我改一下这个文件」反复被追问的原因，现在改由 Run 内模型读过真实文件后决定。工具词表按「本次真正要用、且本项目确实配了连接」生成（读集必备；写/检查按候选声明；`GIT_READ` 配了才给），少给一个工具就是少一条能力边界。授权只放行 `APPLY_CHANGESET` 与那份 `check-1` 冻结检查（删除永远不在其中），检查程序**实测**内容摘要，相对路径按受管根解析，解析不到就 409。栅栏未放松：每一次真实动作仍单独产生 `ACTION_APPROVAL`。规则归[HTTP 契约 §10.53](../api/http-command-contract.md#1053-文件夹入口与对话执行请求2026-10-02源码实现)、[工具适配器 §2](../architecture/tool-adapters.md#2-files)、[工作台 §18.4.1](../frontend/workbench-design.md#1841-文件改动由执行时的真实读取决定2026-10-04方案-b)；**Breaking Change：Yes（语义）**，路由、命令 Owner、权限与审批栅栏不变。真实 PG `folder-first-conversation` **5/5**：`DISCUSS`/`PREPARE`/重放、缺连接按第一项缺失能力报错、信封与授权的实际形状、以及模型真实「读 → 改 → 跑检查」三行全 `SETTLED` 且读到磁盘原文。**遗留**：确认文案仍是「按这个执行」，会让人误以为在确认具体内容，需按 §18.4.1 改写；C 片呈现未接入，因此协作页看不到逐步工具轨迹。
- 片 1／片 2 尚未开始（2026-10-04）：`preamble` 未持久化也未在下一轮回放，需一条 migration；工具轮次的 live preview 清空未做（实测普通 DRAFT 轮次经 `advanceRunStep` 同样不写预览行，与既有 delete-on-settle 设计纠缠）。

内部工具循环 A/B 片（2026-10-04）：用户实际下发[实施提示词](../../prompts/agent-native-tools.md)后已完成 A 片只读工具循环与 B 片范围授权。B 片落地：`run_scope_grants`（迁移 `0056`，随 Delegate 事务落库、边界不可改写、只有撤销可推进）、`evaluateScopeGrant` 作为唯一准入判定并在 prepare 与 admit 两处一致调用、写与检查工具 `apply_changeset`/`read_change_set`/`run_check`、删除在授权内仍回落单动作确认、未配置检查按类型化原因拒绝且不启动子进程。设计归[运行架构 §2.3](../architecture/runtime-context.md)、[工具适配器 §1.2/§1.5/§1.6](../architecture/tool-adapters.md)，物理设计归[第 59 节](../database/physical-design-postgresql.md)，HTTP 面归[命令契约 §10.55](../api/http-command-contract.md)，验收规格归[测试计划 §20.2](../testing/verification-plan.md)。**C 片呈现已接入（2026-10-05）**：新增只读投影 `GET /runs/{run_id}/tool-calls`（`run-tool-call-projection.ts`，`arguments`/`result_ref` 逐字节透传）与迁移 `0057_m04_run_tool_call_events`（把 `run_tool_calls` 登记为第 7 个 Run 刷新事件来源，只放宽 CHECK、不改表结构、不回填）。协作页两层呈现：聊天区在产生执行请求的 user 消息下一行摘要（只算 `SETTLED`），右栏工具面板新增「轨迹」页签逐轮卡片（折叠给出 head/tail 与省略计数，展开给参数与结果全文，审批四态分显）。**已做**：tool-loop **33/33**、migration **10/10**、run-graph **61/61**、folder-first-conversation **6/6**（均 exit 0、临时集群删除 True）、API 单元 **378 项 377 通过 / 0 失败 / 1 跳过**、本切片前端组件 **87/87**、前端生产构建 exit 0、`check-docs` exit 0。**复核修复轮**（另一模型的全新上下文复核，**非**项目定义的独立验收）：修 3 项 Critical（摘要把 `REJECTED`/`ABANDONED` 算成「进行中」、折叠态不渲染 head/tail 却宣称已显示且头尾重叠、配套断言掩盖缺陷）与 9 项 Important（变化集链接指向 API 路径落兜底页、展开区缺退出码与耗时、SSE 游标丢弃恒从 0 起无重连、`runId` 变 null 时 loading 卡死、审批四态未实现、`wait_reason` 暴露内部枚举、`AssistView` 取到最早而非最新一次执行、摘要只读一次、集成侧 TC-03 空跑）。为此给 `ReviewSchema` **只增**可空 `operation_id`。**未做且保持未验收**：真实 Chromium 浏览器点击、真实 API+PG 人工闭环、真实 Windows 窗口 / 中文 IME / DPI、安装升级卸载。**独立复核缺口**：指定的 `gpt-6.1-sol` 在当前账号不可用，本切片**未闭合**项目定义的独立验收出口。**共享工作区现状**：全量组件套件当前为红——`folderFirstConversation.spec.ts` 5 例与 `run-events.spec.ts` 1 例失败，失败选择器与用例名均属并行 Agent 在途的 `ui-option-2-first-session` 四类整改（`AssistView.tsx` 在验证期间被其改写），前端 `typecheck` 亦被其 `tests/browser/uiOption2FirstSession.spec.ts:551` 未使用变量阻断；本切片未触碰其任何文件，**不据此声称全量绿**。**另有一处文档重复待合并**：本轮写的 `verification-plan.md §20.4` 与并行 Agent 的 `§20.5` 同指 C 片。**遗留**：用户可主动触发的目录浏览入口仍未接入；Git 只读已由 `DevToolsPanel` 的 GIT 页签（`GitReadPanel`）承接（2026-10-07 源码核对，组件测试 21/21），但轨迹里的 Git 结果仍只标注来源、不可点；轨迹只给动作身份与核对去处，没有可点的差异视图。
规则归[工作台 §18.8](../frontend/workbench-design.md#188-工具轨迹的呈现2026-10-04c-片设计)，端点归[§10.53 之后的 §10.56](../api/http-command-contract.md)，物理设计归[第 60 节](../database/physical-design-postgresql.md)，规格归[§20.4](../testing/verification-plan.md)，上游依据归[研究 §1.6](../research/p00-source-study.md#16-工具调用呈现与刷新机制对照2026-10-04)。
一次基线冲突的自动适配**已接入并有真实 PG 出口**（`decideToolAdaptation` + `TL-15`–`TL-19`，见[测试计划 §20.3](../testing/verification-plan.md)），本轮补的是写工具的并发与冲突覆盖：重复投递只写一次、跨 Project 共享同一物理目录不互相覆盖、单动作批准不因撤销范围授权而失效、检查程序在授权后漂移即退回人工确认。仍未覆盖的是并发 Delegate、过期 Worker、停止与完成竞争下的写冲突，以及检查输出截断与取消的可辨性。真实 Provider 的 tool calling 兼容与质量、真实 Windows 人工路径未验。实际成绩只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)，不改变 M04–M07 模块状态。

- 消息队列顺序确定性（2026-10-04，方案 A，**未验收**）：用户选定只做消息层队列，不做执行链自动串接、不新增任何执行授权。上游对照已核（codex `thread/queue`、pi `durable` inbox、deepseek-harness `claim`，其余四套无队列序），规则只维护在[研究 §1.3](../research/p00-source-study.md)。已改 `0055_m05_message_queue.sql` + `claimNextPendingMessage` 排序加 `session_id` tiebreak；前端在 `AssistView` 加只读队列折叠面板（序号、原文摘要、逐条取消），未新增 HTTP 端点/API/权限，Breaking Change：No。**验证被并行 Agent 的未完成编辑阻塞**：`apps/workbench/src/components/DesktopTitleBar.tsx:109` 缺 `}` 导致 71 个 suite 解析失败，按共享工作区约束未覆盖其改动。可归因成绩只有定向 15/15、72/73（唯一失败是 `command-open` testid 在源码中已不存在，属并行改动）。实际状态与未做项只看[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)“消息队列顺序确定性（2026-10-04，方案 A）”行。本项**未**改 §0.6 连续工作授权、N06 与 `workbench-design.md:245`，M04–M07 总出口不变
- 产品 Agent 提示词接入（2026-10-03）：用户明确授权后，公共核心已由 `apps/api/src/workflow/agent-system-prompt.ts` 在现有 Assist/Skill、DRAFT 与原请求解释入口加载，专用输出/权限边界保留，语义检查继续独立。设计与代码职责归[提示词设计](../architecture/agent-prompt-design.md)，本轮工程结果归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。本项不启用工具循环或跨任务连续授权；当前桌面窗口未重启、冻结包未重建，真实模型质量仍待验，M04–M07 总出口不变。


- root-bound 能力配置入口与基线口径（2026-10-02）：连接与权限页此前只列 4 项 capability，用户无法创建 `FILE_WRITE`/`GIT_READ`/`GIT_WRITE`/`CLI_RUN` 连接，而文件夹入口对话执行正缺这类连接（服务端 409）。已按服务端 `rootBoundCaps` 展示 8 项、root-bound 必填目录、策略除公共读取外必选受管资源，并补真实 PG 集成反例（`run-integration.ps1 -TestFile gateway` 29/29）与前端组件 13/13、全前端 597/597、两端类型检查 exit0。**这只闭合配置入口**：截至当时 Git/CLI 动作触发仍无公开入口（`prepareGatewayAction` 只接受 `RUN`/`USER_IMPORT`）；**2026-10-21 口径修正（DEV-0069）**：Git 只读已由迁移 `0058` 的 `USER_ACTION` origin 与 `POST /projects/{project_id}/managed-resources/{resource_id}/git-read` 接入（只放行 `GIT_STATUS`/`GIT_DIFF`），前端 GIT 页签由 `GitReadPanel` 承接（组件测试 21/21）；**仍缺**人工暂存/提交/推送与受控 CLI 入口，目录浏览未接入，交互终端协议仍为 Proposed。范围与限制归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)“root-bound 能力配置入口”行，规则归[工作台 §14.9](../frontend/workbench-design.md#149-开发工作的工具入口)与[工具适配器](../architecture/tool-adapters.md)。
- 复跑口径（2026-10-02，本轮核对）：API 单元与集成必须用 `.research/runtime-cache` 里固定的 Node **v24.21.0**，不是 PATH 上的默认 `node`（本机为 v22.22.3）。用默认 node 跑 `npm test` 会因 `verifyBackupPackage` 的 `/^v24\.\d+\.\d+$/` 断言产生 12 例假失败；`content-freeze`/`managed-content-store` 还需 `RELAY_FILE_IO_HELPER` 指向 `apps/desktop/src-tauri/target/debug/relay-file-io-helper.exe`，否则另有 10 例 `CONTENT_IO_FAILED`。两者齐备时当前源码 API 单元 **320/320、0 失败**。集成测试本身已自带固定 Node 与 PG 18（`run-integration.ps1`）。本轮未改 `package.json` 的 `test` 脚本或 helper 解析逻辑，只记录口径。
- 桌面启动截图接续（2026-10-01）：退出23属于单实例检查，截图为已有实例占用；后续检查时占用已释放，历史具体Owner未知。开发入口补前台/后台提前检查和明确失败提示，原生守卫不变；开发API/Node/助手按确切测试包对齐后，已沿原DesktopDev链重新打开本机窗口。当前窗口与用户PG保持运行；守卫回归、资源校对、窗口创建/存活的范围只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。该启动接续不代表新UI原生视觉、正常关窗残留、IME/DPI或安装出口已闭合。
- 连续工作区接续（2026-10-01）：用户授权按 Agent UI 对照计划直接实施，无需追加审批。共享页头、可调分栏及专注模式、摘要优先的聊天/工具轨迹、紧凑成果/判断、阅读版本差异提示与七类页面层级已经接入，模式切换保留原命令 Owner。本设备布局只保存展示偏好；API、数据库、权限和业务协议不变。当前组件回归和只读浏览器空间出口已有通过证据，最终隔离目录测试包、确切身份及剩余限制只看[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。本轮工具未开放原生窗口控制，不能继承较早 DesktopDev 成绩作为新 UI 的 Windows/IME/DPI 验收；规则归[工作台 §17.6](../frontend/workbench-design.md#176-连续协作工作区2026-10-01)，优化包能力门的误判与安全探针依据归[开发记录接续](ui-live-integration-2026-09-28.md#连续工作区与优化发布包检查接续)。
- 同日较早阶段（2026-10-01）：用户已选择[工作主线图](../frontend/mockups/2026-10-01/work-first.png)，整套共享页壳、协作区与七类业务页面实施基本完成。工作台/项目/待处理/资料为主入口；近期工作去重、按项目分组并保留真实续页，主流程采用紧凑页头与阅读纸面。Task/Session、提议意图、确切 Review 版本、组合草稿保护及原未决命令核对已经接入，旧路由/query 和服务端命令 Owner 保留。随后按用户最大化优先要求补齐[全局控件与交互基线](../frontend/design-system.md#62-全局控件与交互实施基线2026-10-01)，修复页面壳裁切、搜索范围文案、表单错误焦点、连接检查输入错配及弹层/页签键盘行为；所涉最大化真实 DesktopDev 样本已复验；用户随后五图反馈中的外扩焦点、相邻控件高度、工具底色、分组悬停及连接摘要开合位移亦已修复并复验，最终隔离前端生产构建已通过。实际成绩和剩余项只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。没有本轮新发布包、真实业务写入或完整 Windows/IME/DPI/安装验收。业务规则见[工作台第 17 节](../frontend/workbench-design.md#17-整套-ui-重做提案2026-10-01)，原整套重做取舍及恢复根因见[开发记录](ui-live-integration-2026-09-28.md#18-工作主线整套-ui-重做与恢复-owner-保护2026-10-01)。
- 历史阶段（2026-09-29/30）：方向 1“对话主轴 · 双页工作桌”的协作精修与整套视觉纠偏已有当时的浏览器、自动化和目录测试包证据；最后辅助页与面包屑修正后曾重新打包，身份及范围仍绑定旧源。历史结果只看[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)，经过见[协作记录](ui-live-integration-2026-09-28.md#13-协作页参考图接续与-review-修复2026-09-30)和[纠偏记录](ui-live-integration-2026-09-28.md#16-整套页面视觉纠偏与发布输入冻结2026-09-30)。这些历史包与旧图不自动覆盖本轮工作主线，也未据此推进 M04–M07 总验收。
- 菜单 6 `DesktopDev` 同包已初始化时直接复用开发库，跳过完整清单解析/资源校验；停库自动启动，首次或变包继续校验及必要初始化/备份升级。2026-10-01 隔离启动回归通过；本轮控件复验使用既有 `dev-desktop.ps1 -Action start` 重新打开最大化开发窗口，仅作界面只读与客户端失败校验，启动耗时与完整启动流程未重测；原 Windows 窗口、私有引导/readiness、重复启动与并发 Stop 证据仍绑定 2026-09-30。启动规则归[本机部署](../deployment/本机部署.md#持久桌面测试入口)，实际成绩只看[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)，未重打包、刷新 API 或验完整业务。
- 菜单 6 真实启动修复（2026-10-06，用户两次报障）：两层根因。①门控错位：开发窗口执行 `src-tauri/resources/api` 暂存产物，旧迁移门只比较 `test-release` 包清单 SHA-256，`-RefreshApi` 新增迁移后包清单不变即整段跳过迁移，readiness 又要求迁移清单完全相等。已改为「包清单改变**或**暂存迁移集摘要相对 `session.json.dev_schema_hash` 改变」，并让 DesktopDev 的 migrate/install-graph/init-workspace 取自暂存产物；`.gitattributes` 固定迁移 SQL 为 LF。②库侧历史污染：`relay_trial` 台账中 `0054` 摘要对应一份应用后即被改写、已不可恢复的草稿版，实际 DDL 少两个约束分支，按用户授权重建试验库并重放 61 条迁移。③随后再次报 `PostgreSQL is unavailable`：`pg_ctl status` 报 running 但启动约 3 分钟后 autovacuum worker 以 `0xC0000142`（STATUS_DLL_INIT_FAILED）崩溃并触发 `all server processes terminated; reinitializing`，此后每个后端 `could not reserve shared memory region (487)`、连接即断；同模式 2026-09-29 已复发，属本机环境问题。已置 `autovacuum = off`（启动器在 initdb 后写入，规避触发点而非根治）并让启动器用应用角色真实探测连通性、失败先重启库再重试并打印 `postgres.log` 末尾。修复后真实窗口连续 6 分钟存活、启动器正常退出 0。真实窗口与 readiness 证据、回归覆盖与剩余限制只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)；本轮未实测交互式 Ctrl+C 停止、打包版 Start 窗口与安装流程，菜单 1 需先重新打包，旧集群副本 `.relay-test/cluster.pre-rebuild-20261006-005359` 暂留待用户处置。
- 历史接续（2026-09-30 晚）：三工作台的任务/资料目录、确切版本正文与同任务 AI 入口，本设备显示偏好，同页 Task 合并提案及蓝图/Run 状态呈现已接入；Task Skill 重读失败和 Task/产物失权后仍保留草稿与原命令，403 后遇到 503 不恢复旧受限事实。该增量未重打桌面包，当前仍保留其业务能力；知识收录、非空恢复/搜索等完整 33 页面/状态及最新 Windows 取证并未由本轮工作主线视觉样本全部覆盖，Git diff/CLI UI 协议仍缺。结果只在[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)维护。
- Git 只读动作与 UI 已接入（迁移 `0058` 的 `USER_ACTION` + `git-read`，前端 `GitReadPanel`），独立与真实窗口验收仍缺；人工暂存/提交/推送与受控 CLI 仍无公开入口，交互终端仍缺协议；PDF 导入、首输出分段统计及 Windows 安装交付仍未完成。本轮真实首预览仅有单次窗口观察，不能推断尾延迟或完整 UI 通过。V1 后续长期协作/N00–N07 属规划，Proposed 不自动成为当前实现授权。

## 下一步与当前授权

单 Agent 依赖门闭合第一段（2026-10-05，最新）：用户实际下发[专项提示词](../../prompts/bounded-multi-agent.md)后，本轮**没有**启动 A/B/C 多 Agent 代码——`gpt-6.1-sol` 仍不在可用模型列表（48 模型 / 9 provider），A→B→C 的链式独立验收门禁无法满足，用户 2026-10-01 已选保持指定模型、等待恢复；共享工作区另有并行 Agent 在写本专项要改的同一批文件。经用户决定，本轮只闭合提示词第 32 行的单 Agent 依赖门。核实后修正提示词一处过时前提：工具轨迹呈现**已在位**（`GET /runs/{run_id}/tool-calls`、`RunToolTrajectoryPanel.tsx`、`relayClient.ts:2355`、迁移 `0057`）。真正缺的是三条控制/恢复路径在**写工具**上的证据：三个预算用例只用 `list_directory`、`TL-09` 只存在于文件头注释、停止 × 写路径无任何用例。**修掉一处真实缺陷**：暂停期间派发写工具抛出未分类的 `GATEWAY_RUN_NOT_READY`（`claimRunForGateway` 在 try 之外且该码不在类型化拒绝词表内），一次人为停止被报成执行失败；现映射为类型化 `STOPPED` 与图状态 `CONTROL_PENDING`，请求行保持 `REQUESTED` 以保住动作身份。`tool-loop` **33/33**、`run-graph` 61 通过 / 0 失败、API 单元 377 通过 / 0 失败、首条命令恢复三 spec **99/99**。规格归[测试计划 §20.6](../testing/verification-plan.md)，成绩归[验收表「单 Agent 依赖门」行](../testing/overall-acceptance-2026-09-28.md)。**门还剩一项需用户参与**：在运行中的主会话里确认工具轨迹真实可见（bearer token 只在宿主内存，无法从外部复验桌面实例）。M/N 阶段状态不变。

有界多 Agent 与自动会话文档接续（2026-10-05）：接续用户 2026-10-04「生成文档」指令，规则归[总纲 §0.9](../../Personal_Workflow_OS_Master_Spec.md#09-有界多-agent-与自动会话)，后续入口为[专项提示词](../../prompts/bounded-multi-agent.md)。本轮仅补设计、ADR、未运行验收规格与执行导航；工程协议待核定，代码实施仍须另行明确授权。单 Agent 相关呈现/停止恢复是前置依赖，仍按原 Owner 接续，不改变 M/N 阶段状态。

转录区吸顶已回退、「我 / 时间」贴右缘（2026-10-05，最新）：**吸顶功能按用户要求整体回退**——删除 `lib/assistTranscriptPin.ts` 及其 spec、`AssistView` 的 `pinnedUserMessageId`/`syncPinnedUserMessage`/`userMessageIds`、`AssistView.css` 的 `.agent-message-slot[data-pinned="true"] { position: sticky }` 规则与 `<li>` 的 `data-pinned`、`collaborationWorkspace.spec.ts` 的 4 条吸顶用例与几何桩、2 条吸顶浏览器用例，以及并行 Agent 为该功能新建的 `assistStickyPinSync.spec.ts`。**未回退**同日单独确认的两项：①**「我 / 时间」贴整行右缘**（规则[工作台 18.6.1](../frontend/workbench-design.md#1861-用户消息的我-时间贴整行右缘2026-10-04)）；②**三点是「还在跑」的持续信号**（[18.6.2](../frontend/workbench-design.md#1862-三点是这条还在跑的持续信号2026-10-04)，此前三点只在首字未到时出现，preview 一到就整段消失，流式期间唯一的活体信号不见）。**回退原因**：实现期连续暴露三个真实缺陷（长用户消息被遮挡、候选未到上沿被拽到半空、sticky 生效后被钉行自身「永远可见」导致吸顶/取消抖动），修完仍引入 `setState` 自我触发的无限循环需改用 ref 绕开，且浏览器几何验证长期被既有布局缺陷阻塞。**「我 / 时间」返工**：用户截图指出绝对定位让 meta 压在第一行正文上，Chromium 实测重叠 **13px**；最终改为「meta 留在文档流 + 横向负外边距贴边」，右缘偏差依次量到 **32px → 16px → 16px → 0**，对应 `row-reverse` 负外边距方向、`right` 内边距、`justify-content` 对单行 `flex-wrap` 无效、`max-width: 100%` 抵消负外边距四个被忽略的约束；断言也从绑死 `<time>`/「我」改为断言 **meta 最后一个可见子元素**（夹具可无 `created_at`，绑死会量错对象报假象）。**验证**：全量组件 **85 文件 668/668**、两端 `tsc --noEmit` exit0、真实 Chromium `uiOption2FirstSession.spec.ts` **15/15**、`check-docs` exit0。**未覆盖**：真实 Windows 窗口观察、原生 IME、DPI 与内容缩放；转录容器 16px 视口既有布局缺陷未修。成绩与限制归[验收表 10.14](../testing/overall-acceptance-details-20261025.md#1014-吸顶已回退我-时间贴右缘两次返工2026-10-05)，回退原因归[工作台 18.6.3](../frontend/workbench-design.md#1863-已回退用户消息吸顶2026-10-04-实施同日回退)。**不改变 M04–M07 与 N 阶段状态。**

方案 2 首条消息恢复的四类缺口（2026-10-04，最新）：[整改提示词第 6 节](../../prompts/remediation/ui-option-2-first-session.md#6-整改后独立复验的接续任务2026-10-03)的 A/B/C/D 四类（五项失败反例）已实施并自检复验。**共同根因**是首条消息过程被拆散在会随「协作页按会话 key 重挂载 AssistView」卸载的组件局部 state 里——`pendingFirstMessage` 上轮已提到协作页，但 `firstExecution`、`firstDraft`、`creating`/`sendingFirst` 与创建命令携带的首条原文仍各自留在实例内，命令身份、在途阶段与解释结果因此不是同一份事实。**已改**：首条过程整体提升为协作页持有的 `FirstMessageOwner`（草稿/未决命令/在途/已解释 `command_id`/解释结果，带同步 `read()`）；换目录改走既有 `requestTransition` 守卫且先于 `OpenWorkingDirectory`；`resource_id` 在命令产生时固定、解释不再从当前作用域取值；同一原消息只解释一次、迟到失败不复活已清空 pending；创建回执恢复按原载荷续发首条；会话面板可接手挂载后才到达的解释结果。顺带删掉 `AssistView` 里一个被后一个 effect 完全覆盖的重复导航状态投影。**验证**：五项反例先落正式回归并**逐条反向撤销确认 5/5 失败**（还原后按 SHA-256 校验两个源文件与修复版逐字节一致）；修复后该文件 13/13、受影响 8 文件 124/124、全量组件 **79 文件 620/620**、真实 Chromium **38/38**、两端 `tsc --noEmit` 与生产构建 exit0、真实 PG `tool-loop` 25/25（迁移链完整）、`check-docs` exit0。**收尾时全量前端出现 2–5 例红灯，全部属并行 Agent 在途的转录区吸顶工作**（新增 `assistTranscriptPin.ts` 及其 spec，并改 `AppShell.tsx`/`AssistView.tsx`/`AssistView.css`/`collaborationWorkspace.spec.ts`），按共享工作区约束未覆盖未回退；隔离复核排除其正在写的 `collaborationWorkspace.spec.ts` 后本切片 7 spec **58/58**、`folderFirstConversation` **13/13**，五处修复在其改完后的源码中仍全部在位。**未覆盖**：五项反例的真实 API/PG 故障恢复与文件副作用、真实 Windows 窗口内观察、原生目录选择、中文 IME、DPI 与内容缩放、关闭重开、安装/升级/卸载；**独立验收（指定 `gpt-6.1-sol`）本轮不可用，未以自检替代**；浏览器 `R02` 偶发本轮连跑 5 次复现 2 次，判归 `App.tsx` 应用级守卫（该用例只在 `/tasks?view=create`，不渲染 `CollaborationView`），断言未放宽。成绩归[验收表 §10.9.1](../testing/overall-acceptance-details-20261025.md#1091-四类缺口的修复与复验2026-10-04)，规则归[工作台 §18.5](../frontend/workbench-design.md#185-首条消息的未决命令与版本错配2026-10-032026-10-04-补首条过程-owner)。

**轻量创建接续（新对话优先调整前）**：轻量创建与状态接续主路径（[总纲 §0.8](../../Personal_Workflow_OS_Master_Spec.md#08-状态驱动与轻量起步)、[工作台 §18.7](../frontend/workbench-design.md#187-目标与任务的轻量起步)、LC-01–LC-07）。**本轮已实施并复验三项入口**：Goal 轻量创建（`/projects?view=goal`）、Goal↔Project 关联（创建成功页，按 Project 修订 CAS）、Task 轻量起步（`/tasks?view=create&light=1`，固定暂存待整理、不带验收条件也不尝试 READY）。三 spec 合计 **17/17**，各自反向撤销实现后 **6/6、5/5、6/6 失败**；全量前端 **84 文件 657/657**、前端类型与生产构建 exit0；真实 PG `api-lists` 4/4、`api-state` 10/10、新增 `task-lightweight-fence` **1/1 PASSED**（零 criterion 的 Task 停在 INBOX，READY 被拒且事实不变）。**三个待决/未做项**：① 三项都还只是**并列入口，默认入口未切换**——`新建任务` 仍直达完整表单，切默认需重指向 10 个 spec 的 56 处断言且部分文件正被并行 Agent 修改，**是否现在切换需用户决定**；② **服务端出口已补**（2026-10-05 新增 `ReviseTaskAcceptance`，真实 PG **9/9**、单元 25/25、`task-lightweight-fence` 1/1 未被破坏，见[验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)与[契约 §10.58](../api/http-command-contract.md#1058-创建后人工补验收条件2026-10-05-源码实现)），**前端入口已接**（**2026-10-21 口径修正，DEV-0070**：`TaskDetailView` 已渲染 `TaskAcceptanceEditPanel`（`TaskDetailView.tsx:7`、`:172-174`），可用性规则在 `:105-116`——任务事实加载/刷新/读取失败、项目已归档或不可读、AI 持有执行权或仍有活动 `runId`、状态不在 `INBOX`/`READY`/`IN_PROGRESS` 时禁用，已完成任务须先重开，未知状态按禁用兜底；面板只追加条件并保留既有版本，组件测试 `taskAcceptanceEdit.spec.ts` **21/21**）；但全仓**没有**能放宽已确认必需条件的公开入口，若产品需要放宽须先定规则（`ReopenTask` 进新周期重建与 `MarkTaskReady` 前置冲突）；③ 建 Task 后普通会话未接回同一执行准备链（解释入口仅送本条消息）。

**轻量起步切片的全新上下文复核（2026-10-05，非独立验收）**：指定 `gpt-6.1-sol` 仍不可用，本轮以全新上下文复核补一轮，**明确不替代独立验收**。结论**部分一致、无 P1**：前端三 spec 实测 **17/17**、`tsc --noEmit` exit 0；逐条核对确认 `criteria === []`、`/ready` 计数 0、载荷键集合、Project 修订 CAS、`resource_id` 创建时固定、READY 栅栏真从 DB 读验收版本而非请求体——均为载荷级/行为级断言，非文案级。**2 项 P2**（均为「文档声称已做、断言没锁住」，已修）：①冲突后重新读取项目无断言——夹具两次返回同一 revision，删掉 `GoalProjectLinkPanel.tsx` 的 `await load(true)` 全部断言仍通过，而面板文案宣称「已重新读取项目」；已改为冲突后返回新修订并断言第二次 `expected_revision`，**受控反向验证确认会红**（`expected '2' to be '5'`），SHA-256 还原一致。②Task 轻量入口的响应丢失用例曾是 `if/else` 条件式断言、两条分支都过，「Task 手动核对 vs Goal 自动核对」这一事实无回归保护；**用户已决定保持差异化、先锁现状**，已改为单链路断言并同时锁住「未发生自动核对」（回执查询请求数 0、无已创建证据）与「保留原 `command_id`、`pendingStep` 未清」，两次受控反向验证均确认会红。**5 项 P3**：Goal 自动核对的 `command_id` 身份未锁（已修）、一条纯文案断言不承担名字暗示的职责、`CreateTaskView.tsx:415` 死三元与 `tab=inbox` 丢失（已修）、两层防御不对称（经核对**不构成缺陷**，服务端两层均成立）、文档精度（Goal↔Project 的服务端 CAS 反例实际靠既有 `api-tasks` 背书，验收表该行未提，属证据来源未写清而非虚假声称）。**复核者的一处报错已由主代理核实为不成立**：其称 `migration.integration.test.ts` 含 U+FFFD 编码损坏——仓库级扫描、检测方法自校、该文件字节级 `EF BF BD` 计数为 0 三重核实均未复现，不成立。**反向撤销实测 4/6 红而文档称 6/6**：原因是撤的东西不同（文档撤整个轻量分支、复核者撤分支内的提交意图），非造假，两人都证明测试能捕获回归。

方案 2 底栏底部对齐修复（2026-10-04）：用户截图指出输入框底部没对齐。原因是底栏那一行仍压在卡片 `padding-bottom` 与自身 `padding-bottom` 里，而绝对定位的发送键 `bottom: 0` 相对卡片 padding box，两行底边差 20px。已改为底栏 `margin-bottom` 抵消卡内下边距、`padding-bottom` 归零，使整行底边与键底边同在卡片内缘；两者同为 `2 × radius.composer` 高，竖直中心自然重合，回归断言中心偏差 ≤1px。**过程中修掉一个自己引入的真实缺陷**：首次补丁把三行说明文字插在上一段注释的 `*/` 之后，成为注释块外裸文本，CSS 解析器随即丢弃紧随其后的整条 `.agent-chat-composer-actions` 规则（底栏 padding/margin 计算值全为 0px）；靠浏览器实测而非读代码定位，已补一次「注释块外不得有裸中文行」的静态校验。**最终验证**：typecheck exit0、生产构建通过、全量组件回归 **612/612**、真实 Chromium 对齐用例 **14/14**、浏览器全量 **38/38**、`check-docs` exit 0。成绩归[验收表 §10.10](../testing/overall-acceptance-details-20261025.md#1010-输入区三次调整2026-10-04按参考图与-codex-输入框)，规则归[工作台 §18.6](../frontend/workbench-design.md#186-页面原型结构对齐2026-10-03)。

方案 2 输入区三次调整（2026-10-04，最新）：用户以 Codex 输入框为参考（明确「参考一下，不要照抄」），要求删头像、去掉「消息已排队」提示、加大发送键、底栏左侧行高与键一致。已处理：**删除消息行左右头像**（角色已由「我 / AI」标签与气泡位置区分，头像只是重复占位并挤窄正文列）；**删除「消息已排队；回复状态以服务端消息为准」这条 notice**（它只复述已提交的 202 回执，不携带新事实，消息的 PENDING/RUNNING 状态已在消息行说明），**取消意图、提案接受回执、原命令回执三类 notice 保留**，仍渲染在输入器列内而不是整宽底栏；**发送键放大到 32px 并改为正圆**——新增 `radius.composer = 1rem`，输入器卡片改用它，键直径取 `2 × radius.composer`，圆心落在圆角圆心上时与下边、右边**同时内切**、正好穿过圆角弧两端，「圆心重合」在这里是精确相切而非近似（形状参考 Codex 的圆形发送键，配色版式仍用本项目 token）；**底栏左侧行高与键由同一个 token 推导**（都是 `2 × radius.composer` = 32px），不再各写一个数字；32px 已高于 `control.target.minimum`，可点击目标不再依赖 `::after` 扩展命中区。**仍未实现且明确放弃的一条**：「该行所有元素做相同垂直位移」是几何硬约束——圆角圆心恒在外框内 `radius.composer` 处，任何高于 `2 × radius.composer`（32px）的行内元素以它为竖直中心必然越过卡片底边；底栏左侧 chip 已取到与键相同的 32px，此时整行已同一中心对齐，再整体下移会跨过底边，故保留 `align-items: center` 同行居中。**验证**：typecheck exit0、生产构建通过、真实 Chromium 对齐用例 **14/14**、浏览器全量 **38/38**、全量组件回归（Node 24.21.0 单 worker）**612/612**。**覆盖缺口（如实记录）**：原「命令回执落在输入器列内」浏览器用例**已删除**——发送路径不再产生任何 notice，前置动作无法触发提示，保留即空断言；其余三类 notice 的版式不再有自动化断言，当前浏览器夹具无法可靠触发。成绩与限制归[验收表 §10.10](../testing/overall-acceptance-details-20261025.md#1010-输入区三次调整2026-10-04按参考图与-codex-输入框)，规则归[工作台 §18.6](../frontend/workbench-design.md#186-页面原型结构对齐2026-10-03)。

方案 2 页面原型结构对齐 + 输入区二次调整（2026-10-03，最新）：用户以页面原型与实际截图提出 7 处结构差异并要求对齐，明确「原型是静态的，不要为了对齐写死距离」；随后又按参考图二次调整输入区。**宽度全部走 rem token**（消息列与输入器合并为同一 `layout.reading.maxWidth` = 72rem，当日新增的 `layout.composer.maxWidth` 已删除），回归断言相对关系而非绝对像素。已处理：消息流改为铺满中栏的滚动容器、阅读列在内容盒内居中（滚动条因此贴中栏右缘，取自 deepseek-harness `ChatView.module.css:54-63` 的 full-bleed scroller）；`/agent` 去掉面包屑并连带删除因此变成只写的 `workTrail` 取数 effect；页头去掉常驻的委托阻塞原因；命令回执移入输入器列不再横贯底栏（**未删除**——`notice` 是 7 处命令回执共用机制，删了会连带砍掉「受托已受理」等反馈）；左栏复用全局 `.search-field` 原语加搜索（**只筛已加载范围**，同时显示「已加载 N 项」）；每条已完成 AI 回复加纯客户端「复制」（**只有图标**，状态在 `aria-label`）。输入区二次调整：去掉输入框与正文之间的横线、去掉 textarea 拖拽改高（`resize: none`）；资料/讨论改无边框 chip + 右侧 chevron + 竖分隔线；回到最新只剩图标、透明背景、水平居中；发送键改为**圆心与卡片圆角圆心重合**（边长 `calc(2 × radius.control)` = 16px，实测偏差 ≤1px，完整落在卡内），painted 尺寸低于可点击目标下限故用 `::after` 把命中区扩到 `control.target.minimum`（WCAG 2.5.8 达标看命中区）。**两条未做到的约束已记录**：底部提示条不删；「该行所有元素做相同垂直位移」是几何硬约束——圆角圆心恒在底边内 8px 处，任何高于 16px 的行内元素（资料/讨论 chip 为 40px）以它为竖直中心必然越过卡片底边，故保留同行居中未强行位移。**实测第 7 项「双滚动条」不是缺陷**：`.collab-center` 内真正溢出的纵向滚动容器只有 `.agent-chat-transcript` 一个，已固化为回归。**本轮推翻了 §17.7 两条旧规则**（「面包屑承载上下文」与「委托阻塞原因必须留在首屏」），冲突与替代已记录。**通过出口**：typecheck exit0、生产构建通过、真实 Chromium 对齐用例 **14/14**、浏览器全量 **38/38**、全量组件回归（Node 24.21.0 单 worker）**612/612**。**`R02` 偶发已用 `git worktree` 在 HEAD 归因**：HEAD 与本轮工作树都是 4 次里 3 失败，且该用例全程只在 `/tasks?view=create`，判定既有不稳定、与本轮无关，断言未放宽。实际成绩与未覆盖出口只归[验收表 §10.9](../testing/overall-acceptance-details-20261025.md#109-页面原型结构对齐2026-10-03)，交互规则归[工作台 §18.6](../frontend/workbench-design.md#186-页面原型结构对齐2026-10-03)。**仍未验收**：窄窗/200% 缩放/真实 Windows 窗口内的实际观感；命中区扩展在真实指针与触屏下的手感；跨项目全量搜索；未读资料与赞跌；`apps/api` 备份还原注册表 4 例 `BACKUP_PACKAGE_INVALID`；并行 Agent 未提交的 `tool-loop-action.ts` 编译错误。

**共享文档事故（2026-10-04，经用户确认后处理）**：`CODEX_NEXT_STEP.md` 曾被并行 Agent 以有损方式重写，100 行中 61 行出现 U+FFFD 替换字符（463 个），每个标题被截断，文件内日期被改成 2026-10-04。全仓扫描确认**只有这一个文件受损**。后果是 `node scripts/check-docs.mjs` exit 1、13 个锚点错误。已按用户选择从 HEAD 恢复干净版本（损坏副本留在 `%TEMP%\CODEX_NEXT_STEP.corrupted-backup.md`）并重贴本轮记录；恢复同时丢掉了对方 2026-10-04 的内容，**需该 Agent 重发**。教训：重写这个文件不要用可能按字节切断多字节字符的方式（如 PowerShell 管道式重写），优先用编辑工具整段替换。

方案 2 四项整改与复验（2026-10-03）：本轮按[整改提示词](../../prompts/remediation/ui-option-2-first-session.md)修复首条草稿保护、原消息回执恢复、首条执行解释和待审版本错配提醒四项缺陷，先落四条反例回归（修复前均按预期失败）再改实现。**未改路由、命令 Owner、HTTP 契约、数据库与权限；Breaking Change：No。**首条消息未决命令上移到 `CollaborationView`（文件夹入口 `AssistView` 以会话为 key，建会话后必然重挂载，本地 state 会连同未决命令丢失）；首条发送与同 ID 重试共用一条路径，命令 ID 与载荷发送前固定，双击用同步 ref 闸而非 `setCreating`，连接已换时不猜结果；首条解释只在真实回执的 `user_message_id` 确定后走既有链，摘要仍由会话面板原 Owner 承载；版本错配提醒提取为单一节点，compact 纸面与完整待审页非紧凑正文都渲染。**通过出口**：定向 React 11 文件 157/157、Node 24.21.0 单 worker 全量 79 文件 **612/612**、新增 4 条真实 Chromium 点击 **4/4**（既有 24 项同批通过；`run-real-api-browser.ps1` 真实 API/PG **先 1/1 通过**，末次复跑被 `apps/api` 并行编译错误阻断，本轮改动只在 `apps/workbench`）。实际成绩与未覆盖出口只归[验收表 §10.8](../testing/overall-acceptance-details-20261025.md#108-四项整改的实现自检与复验2026-10-03)。**独立复验仍缺**：要求的 `gpt-6.1-sol` 在当前账号不可用，未静默降级、不以自检替代。M04–M07 与 N 阶段出口不变。

方案 2 接续验收与整改（2026-10-03）：用户要求对上一轮已实施的本轮改造做接续验收，先验证、存在差异才改，并补齐真实 API/PG 与 Windows、IME、DPI 验收。**已整改 8 处差异**（详见[验收表 §10](../testing/overall-acceptance-details-20261025.md#10-方案-2-接续验收与整改2026-10-03)）：3 处是共享壳拆分打断的选择器断链，1 处是真实缺陷——`App.tsx` 把桌面标题栏排在 `AppShell` 之前，跳转链接不是第一个 Tab 站位（违反 WCAG 2.4.1），已改由窗口框架持有；2 处是早于现行文档的旧断言（浏览器标题栏、项目摘要栏），按 §17.4 与 §17.9 校准后保留实质检查；1 处是 `run-real-api-browser.ps1` 从不设 `RELAY_FILE_IO_HELPER` 也不构建 API，导致真实 API 验收的产物写入路径根本没被走到，已补齐。**新通过出口**：真实 API/PG 人工闭环（一次性 PG 18.6 + 真实 API + 真实浏览器，创建项目→任务→启动→产物 v1/v2→选用→完成→重开全链通过，`playwright=0 pg_stop=0 temporary_removed=True`）；桌面发布包重建（465s，SHA `3ca3cc62…`）与完整性验证，真实顶层窗口（标题 `Relay Agent`、类 `Tauri Window`、属主 PID 一致、1174×788、**DPI 120**）。浏览器套件由 18 通过/6 失败转为 **24/24**，组件回归 606/607，类型检查与生产构建通过。**仍未验收**：Windows 窗口内渲染观察、原生目录选择、真实中文 IME、DPI 多点对比与内容缩放、关闭重开恢复、安装/升级/卸载，以及 `apps/api` 备份还原注册表的 4 例 `BACKUP_PACKAGE_INVALID`（属 M07 路径，本轮未触碰）。**仍未通过的既有缺陷**：浏览器返回不触发草稿守卫（插桩在 4188 下 4/4 复现草稿静默丢失，4173 下 5/5 通过），R02 用例保留为真实闸门未放宽；另发现 `start-acceptance-session.ps1` 在窗口实际存活时仍报退出码 23 并留下孤立窗口与集群（命中 2 次），本轮只记录未修改。M 阶段与 N 阶段状态不变。

方案 2 全站生产接入（2026-10-02）：用户把 [ui-option-2-pages 提示词](../../prompts/ui-option-2-pages.md) 作为开发指令下发，要求从现有实现接续，完成共享壳、聊天区和全部 37 个页面/状态单元，并按大模块自检→独立核验→修复复验推进。**已实施**：共享壳拆为图标导航栏（88px）+ 近期工作栏（224px，可拖拽），聊天页头 105→77px 且验收目标转入按需展开、标题成为指向确切任务页的键盘入口，`/projects`、`KnowledgeReader`、`/reviews` 三类样板先行，其余 28 个视图（含 live/fixture 双分支）接入共享 `PageHeader`，`/reviews` 在有可读确切产物版本时改为列表/正文/判断三列。过程中修掉两个真实缺陷：`PageHeader` 原语没有声明标题字号（`h1` 落回浏览器默认 2em，同一原语在不同页面不一致），以及窄窗回落规则未覆盖该原语。交互归[工作台 §17.12](../frontend/workbench-design.md#1712-方案-2-全站生产接入2026-10-02)，组件与布局归[设计系统 §9.3.1](../frontend/design-system.md#931-方案-2-生产接入2026-10-02)，新增数值只有 `layout.navigation.railWidth`。**未改**路由、查询语义、`data-testid`、命令 Owner、HTTP 契约、数据库、权限与模型策略；**Breaking Change：No**。实际成绩与未覆盖出口只见[功能验收表 §9](../testing/overall-acceptance-details-20261025.md#9-方案-2-全站生产接入2026-10-02)与 §10。

聊天区域效果图接续（2026-10-02）：用户反馈顶部任务信息挤占对话，已选[方案 2](../frontend/mockups/2026-10-02/conversation-workspace-selected.png)，随后明确只生成其他页面效果图、不改代码，并要求依据实际功能保留折叠入口。已按当前路由与生产组件生成 37 张页面/状态配套静态图，收录到旧[预览入口](../../preview.html)的 2026-10-02 分组；清单、生成依据和静态检查边界见[本轮目录](../frontend/mockups/2026-10-02/README.md)。适配范围归[工作台 §17.8](../frontend/workbench-design.md#178-聊天优先效果图与全站适配范围2026-10-02)，视觉归设计系统 §9.3。交互原型工作已停止；其临时目录清理被自动审批拒绝，未用原型结果更新功能成绩。该轮的「只生成图、不改代码」约束已由上面的生产接入取代。

后续阶段规划接续（2026-10-02/03）：用户要求继续逐题规划 N 阶段；样板、交付优先级及二轮 N04–N06 产品规则归[后续路线](../requirements/post-v1-roadmap.md)。隔日接续呈现归[工作台 §15.1](../frontend/workbench-design.md#151-隔日打开目录的事实接续卡2026-10-02已确认规划)，本段计划/一次性提醒/有限任务链呈现归[§19–21](../frontend/workbench-design.md#19-下一段工作计划n04已确认规划)。已同步规格与实施提示词；工程协议仍待逐片核定，本轮不启动开发或模型外呼，不改变既有并行实施授权、模块状态或验收结论。

文件夹入口接续（2026-10-02）：用户已实际发送[实施提示词](../../prompts/folder-first-conversation.md)，A、B 两片已实现并自检。**本功能未全部验证**：FC-06/07/09/10 未做，真实 Windows 原生目录选择、取消、重启、中文 IME 与 DPI 完全未验，也没有重建桌面包。

已实现并有证据：Windows 原生选目录命令（`tauri-plugin-dialog 2.7.2` + `select_working_directory`，仅 `cargo check` 通过）；`OpenWorkingDirectory` 命令按规范路径与 Windows 物理身份复用或建立最小 Project 与受管资源，重叠根要求显式选定作用域而不造第二个写 Owner；协作页无任务时可直接打开目录对话，首条发送自动建会话；`InterpretConversationMessage` / `ApplyConversationExecution` 两个命令把明确执行请求经既有 Task/READY/Delegate 入口落成真实 Run，并把 `CLI_RUN` 接进冻结契约与 Gateway 节点，使「真实文件修改 + 一次受控检查」可在同一 Run 内完成。新增迁移 `0051_conversation_execution_requests`（真实 PG 已验证；同号 `0050_n02_impact_candidate_groups` 属并行 Agent，未改动）。

证据与限制只看[功能验收表 §8](../testing/overall-acceptance-details-20261025.md#8-文件夹入口与对话直接执行2026-10-02开发自检)。`collaborationWorkspace.spec.ts` 的 5 例失败在 HEAD 即存在（`collab-facts` 在 Run 需要注意时被折叠），本轮未修复也不据此声称组件全绿。交互主文档为[工作台 §18.4](../frontend/workbench-design.md#184-当前实现的交互出口2026-10-02)，应用责任归[领域模型 §12.4](../architecture/domain-model.md#124-当前实现的对象与边界2026-10-02)，接口契约归[HTTP 命令契约 §10.53](../api/http-command-contract.md#1053-文件夹入口与对话执行请求2026-10-02源码实现)，物理设计归[第 56 节](../database/physical-design-postgresql.md#57-0051-m07-文件夹入口与对话执行请求2026-10-02源码实现)。M04–M07 模块状态不变，本入口完成不代表总出口通过。

M 阶段后端接续与本轮已单独授权的整套 UI 重做维持各自分工；不覆盖并行实现、用户配置或密钥，不扩大真实 Provider 外发。下列 UI 事项保持用户选图和既有业务边界。

当前用户优先事项（2026-10-01）：联网研究与工作主线基线盘点后，用户已授权直接实施连续工作区计划。实现、相关回归和七类代表页面的只读浏览器观察已经完成；本次隔离桌面测试包更新及确切来源以功能验收表为准。用户随后指定原聊天验收前端，已补真实DesktopDev最大化/还原代表页面、已有会话草稿保护、分栏和搜索的独立原生复核；范围与未覆盖状态只看[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)“连续工作区真实 Windows 页面独立复核”行。该行两处阅读体验待改已于同日修复：AI 已完成正文改用既有 SafeMarkdown（用户消息与生成中草稿仍纯文本、Skill 输出不重复），资料保存时间与 Run 步骤起止时间改用本设备显示时区的可读值并保留原始 ISO 于 `time.dateTime`，未改 API/数据库/业务 Owner。组件回归 5/5、全前端 76 文件 579/579、类型检查与生产构建 exit0；**原生 Windows 复验未验**，本轮工具未开放原生窗口控制，未以组件成绩替代原生验收，正文换行、滚动、代码块与分栏的原生观感仍待验。中文IME、DPI与完整页面/代表性业务恢复路径继续待验，本次验收未做业务写入。浏览器合成场景不替代这些出口。具体交互归工作台 §17.6 与设置页时区展示范围，研究引用归 Agent UI 研究接续。同日已推送 `619e7c7`（含 M04–M07 并行分片与上述两处修复），推送前后完成远程凭据与隐私审计：**全历史无真实凭据**，两项非凭据隐私文件只存在于历史、当前 HEAD 干净，经用户决定不改写历史，已知项与理由归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)“远程仓库凭据与隐私审计”行。保持 M01–M07 状态、并行后端分工与真实模型外发边界，不将局部验证作为整体安装交付。

同日较晚：用户以附件反馈「前端实现跟效果图差很多」，授权在现有未提交改动之上做结构对齐，范围只含共享页壳与协作/成果两页，数值继续归唯一 tokens，推广到其余五类页面属下一批。已引入 `PageHeader`/`FactBar`/`JudgmentBar` 三个共享原语；协作页头由 12 个常驻控件收敛为 1 个按钮加「更多操作」浮层（UNKNOWN、控制请求、执行失败强制移回常驻），事实条收回默认收起，成果区恢复文档层级并把截断产物版本 ID 移入依据折叠，成果正文给 `layout.workspace.centerMin` 下限、判断条贴底，侧栏去掉计数行与冗余的「开始一项工作」，输入器恢复单卡。只读同构夹具 1280×720：页头 212→130px、聊天 170→287px、成果正文 44→416px，1487×1058 与效果图同尺寸可直接并排，960/390 无横向溢出，业务 POST 为 0；类型检查与生产构建 exit0。规则归[设计系统 §9.2](../frontend/design-system.md#92-共享页级原语2026-10-01)与[工作台 §17.7](../frontend/workbench-design.md#177-页头与成果区结构对齐2026-10-01接续-176)，取样与限制归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)“协作工作区与共享页壳结构对齐”行。**当前全量组件回归为红**：并行进行中的 `relayClient.ts` 把 `usage.cache_read_tokens` 变成必填字段，既有夹具未提供该字段，52 例失败均源于此且不属于本轮 UI 改动；本轮未触碰该文件，也未覆盖其进行中的改动，原生 Windows/IME/DPI 与推广批次均未验。**该红灯已不再复现**：`relayClient.ts` 现用 `nullableOptionalInteger` 把 `usage.cache_read_tokens`/`cache_creation_tokens` 当可选上报字段处理，2026-10-02 全前端 78 文件 597/597；原失败事实与当时归属保留，不改写为当时已通过。

同日再晚：根目录新增未入库的 `preview.html`，是 `docs/frontend/mockups/` 的索引页（7 组 55 张）。逐张比对后发现 2026-09-19 逐页图与 2026-10-01 work-first 是两套字号，用户在「恢复衬线大标题 / 放大字号保留 Sans / 维持紧凑」中选择**放大字号但保留 Sans**，并维持 work-first 的 4 主入口导航、不恢复侧栏品牌。据此只改唯一数值源：`font.size.page` 由 `{font.size.compactPage}`(1.75rem) 放开为 2.5rem，`font.size.section` 1.5→1.75rem，`font.size.display` 保留但页面主标题不再使用；今日/设置/协作页硬编码的 `compactPage` 标题改回 `font.size.page`，窄窗降级收敛到 `styles.css` 唯一一处 `@media (max-width: 40rem)`。**这推翻了 2026-09-28「今日主标题收到 compactPage」的单页特例**，已在[设计系统 §4](../frontend/design-system.md#4-字体与排版)写明。示例模式取样：八个普通路由 1280 宽主标题一律 40px、区域标题 28px，390 宽一律 28px，无横向溢出；协作页同步放大后 1280×720 页头 130→145px、聊天 287→272px、成果正文仍 416px，均在 240px 下限之上。取样与限制归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)“普通页面标题与区域标题字号对齐”行。**六类页面的右栏内容形状仍是下一批**：当前是「标签: 值」定义列表、会露出「验收条件 ID / 请求身份 v1」这类技术身份，逐页图则是大字值的用户语言事实加明确动作，需逐页决定放什么。

注意工作区由并行 agent 共同使用：本轮结构对齐已被对方以 `7182f01` 提交，而其后我在做的字号改动一度被清空并需重做；`a4409b1` 已把 `cache_read_tokens` 必填化入库但未同步 8 个 spec 夹具，导致全仓 52 例红。后续动手前需确认对方是否仍在写同一批文件，提交前先核对 `git status`。

1. 用户已授权继续M阶段、关闭占锁开发窗口，要求列出用户参与事项后继续可独立工作。M04读取委托与三Skill的修复包定向链已推进，后续能力/质量及真实服务故障按工作包闭合；历史输出拒绝字段没有原正文可恢复，不宣称已定位。当前M07准入、原宿主停机、内容发布安全点及数据库连接维护/原ACL恢复分片已实现并分别验证。备份CLI已按[部署边界](../deployment/本机部署.md#4-备份恢复)组合实现，最终身份窗口修正及独立复验已闭合；隔离还原已组合目标专用CONNECT生命周期、刷盘启动标记、完整归档还原和只读核对，组合自检及独立复验已闭合，业务只读维护核对冻结源码独立完整组合已通过；其余已复现的维护连接PG环境继承已修正，原源fence显式TLS/options保留；新冻结范围的完整恢复独立复验已通过；目标包离线依赖加载与内存调用核对的冻结源码有限出口已通过独立单元及真实PG函数/CLI组合复验；受管资源根身份有限只读观察已实现，相关Windows单元22/22及完整PG组合8/8自检通过；独立审查和验收待指定gpt-6.1-sol恢复后补齐，再推进依赖此片的完整兼容/明确放行、确切新包维护链及安装。DRAINING、当前登录会话guard、数据库连接门或pg_dump均不能单独证明完整备份；不重做已通过功能、不覆盖并行UI、不扩大真实模型外发。原生模型工具调用仍主动拒绝，不称已接入执行。
2. 接续开发时先核对当前源码和已有通过分片，不重做已通过功能；按用户下一项范围补最新 UI/Windows、真实 Provider 故障与首输出、M06/M07 剩余出口。默认大模块自检、独立验收、修复复验后推进，已获授权的并行开发或验收后置保持原边界。
3. 读取[文档地图](../README.md)、[契约](../../contracts/README.md)、[大模块工作包](../../prompts/stack-migration.md)和[测试规格](../testing/verification-plan.md)中与本次任务相关的部分；仅为定位具体失败展开历史或日志，不扫描全部证据。

独立验收限制（2026-10-01）：gpt-6.1-sol返回当前ChatGPT账号不支持；用户已明确选择保持指定模型、等待恢复，不切换模型。主代理继续后端开发、自检与文档同步，本轮资源根身份分片的独立审查/验收留待补齐，不以主代理自检替代，也不提前推进依赖该出口的模块。

用户参与事项：目前没有阻塞上述可独立开发的必做操作。**两项最短具体确认**：(1) 打开任意 Run 的轨迹面板，确认不再 500——2026-09-30 起迁移到 0051 的库/代码不一致已修，但 bearer token 只存在于宿主内存，本轮无法从外部复验桌面实例；(2) 手工跑 `npm test` 前先切到 `.research/runtime-cache/node-v24.21.0-win-x64/node.exe` 并设 `RELAY_FILE_IO_HELPER=apps/desktop/src-tauri/target/debug/relay-file-io-helper.exe`，否则会看到 22 例与代码无关的失败。其余：新包准备完成后请人工确认协作/审批/取消、回复质量及中文输入/界面体验；可选准备第二台未安装 Relay 的 Windows 或干净虚拟机，用于 M07 安装/升级/卸载；如果已有能安全稳定制造限流/断流的 Provider 测试环境，可用于真实服务故障验收，当前不要求购买或提供新密钥。准备完成和实际参与记录再更新此入口，不把待人工确认算已通过。 **F24 追加一项（2026-10-02）**：(3) 四项 Skill 的**质量评分标准、重复次数与预算**需要在跑之前由你确认冻结——目前只有契约合规性（严格 schema、来源冻结、显式接受、无副作用）有证据，语义质量与可读性没有任何评分；不冻结就继续不出质量结论。(4) 蓝图链的真实 Windows 验收需要先重建确切发布包并跑 `apps/desktop/tests/m04-real-model-webview.mjs`；本轮**未重建**（桌面 `lib.rs`/`Cargo.toml` 正被并行修改，重建会产生与你现有安装不一致的身份），需要你确认何时冻结桌面源码再打包。

2026-10-01 接续交接：新空库产品restore已实现，最终相关单元与完整独立组合已通过，范围绑定功能验收表中的冻结源码。目标专用生命周期在撤销COMMIT后成功/失败/取消都保持CONNECT隔离；COMMIT前预检失败保留目标原ACL，不复用源fence的release。新根发布前刷盘marker，原/目标包分别核对，完整单事务还原及原状态/正文核对不消费旧Job、重发UNKNOWN或切换用户配置。真实反例修正了本机CIDR地址、系统schema用户对象空库漏检及原data_root内嵌目标错误成功；新根创建和权限变化前，以已核目标包助手只读比较原content_root_id与现存祖先，覆盖同卷搬迁，不放宽硬链接拒绝。独立审查修正准入字段投影与末段metadata路径检查。pg_restore前导SQL重置超时初值，取消后backend可能继续等待锁，保持隔离、不宣称静止，由受信运维核对处理。业务只读restore-check及非空目标专用会话、严格材料解码和CLI已实现，冻结源码已通过独立完整组合（未授激活）；受控状态reader的PG环境继承反例已修复，实际成绩与当前独立范围只看功能验收表，前端不在本线程改动范围。读取既有target-acl凭据，专用重持非空隔离目标，只锁/核对不写ACL或准入；核对本地恢复材料、当前状态投影/清单字节及确切包，现有内容冻结可能首次创建sentinel，必须如实说明。报告仅证明本次范围匹配，全部历史执行/目标依赖可调用性、外部资源live身份、配置选择/唯一Owner仍待核对，不授激活权；不把旧报告当未来放行依据。随后闭合明确激活、确切新包与安装矩阵；目标evidence/restore元数据须纳入后续维护生命周期，不复制为活动ARMED。选择及代价见[ADR-014接续](../decisions/ADR-014-database-maintenance-admission.md#2026-10-01-接续实现隔离还原不自动激活)，根因和Owner见[M07开发记录](m07-backup-recovery.md#新空库隔离还原与只读核对)，命令/限制归部署说明，成绩仅归功能验收表。本轮没有Provider外呼或完整新发布包/安装验收。占锁开发窗口已按原授权处理，实际关闭方式和未定位的正常关窗问题只看功能验收表，未停止用户PG。工作区外旧编译误输出清理因自动审批拒绝仍暂留 `D:\output\acceptance-raw\m07-admission-unit-independent-dist`，不影响本轮正确工作区编译或临时PG清理。

本轮独立编译暂留：`apps/api/dist/m07-restore-isolation-independent-9ea0dee2-4ee1-482d-a483-5d916a919053`。递归清理及随后经逐项路径/文件类型核对的非递归清理均被自动审批拒绝，仅返回 `blocked by policy`，已停止删除；309源码输入SHA与独立成绩不受影响。该目录只含本轮独占编译输出，不作为正式dist/src或发布包输入。

PG还原分片的两处本轮独占输出亦暂留：`output/acceptance-raw/m07-20261001-restore-postgres-worker-dist` 与 `apps/api/output/acceptance-raw/m07-20261001-restore-postgres-worker-dist`，各313个纯JS输出、已核对在工作区内且无reparse；自动审批拒绝递归删除，仅返回 `blocked by policy`，已停止、不重试。临时PG清理与源码不受影响，后续独立编译采用内存emit逐字核对，不新增dist目录。

文档维护与输出保留见[规则](../README.md#6-验收结果与原始输出保留)。所有日期块、原包身份和旧阶段经过可在历史快照及各专题记录恢复；这些记录不替代当前模块状态。

2026-10-17 晚（输入区布局第三轮）：按用户实机截图指认完成两处输入区稳定化——①模型调用信息（本条首选/实际/记录）从输入卡下方说明列移入最近一条 AI 回复的消息行；②在途锁定原因转视觉隐藏并挂到禁用模式盒 title，卡下方说明列在空闲与在途之间不再增减可见行；③输入卡 :focus-within 去掉 3px 光晕，发送/聚焦不再多一层阴影。改动：AssistView.tsx/.css、ConversationModeSwitch.tsx、assistantModeSwitch.spec.ts（新增 fieldset title 与 visually-hidden 断言）。验证：tsc --noEmit exit0；assistantModeSwitch+assistModelRuntime 定向 51/51；check-docs 通过；全量 vitest 复跑见验收表该行。真实 Chromium/Windows 窗口复验未做，登记为该行剩余项。注意本树并行 Agent 在改同一批文件（Attach 菜单、tech-details），本轮未动其改动。

2026-10-20 凌晨（排队消息的插话）：用户要求「有任务在执行时按一次回车进队列，再按一次回车就能发出去」，并参考上游的插话如何进入上下文。已按 deepseek-harness 的 Queue/Steer 语义实施（`agent.ts:167-173` 的 `next-step` inbox 与 `:359-364` 的「有插话就不结束这一轮」）：迁移 `0122` 增 `assist_messages.steer_requested`；命令 `SteerAssistMessage`（`POST /assist-messages/:id/steer`，与 `/cancel` 同形，只落意图）；主流程每次模型请求前 `drainSteerRequests()` 把命中行同一句收口为 `CANCELLED`+`STEERED` 并带回用户原文，作为 `system → 历史 → 工具轮次 → 插话` 的最后一段；模型已给正文但之后又有插话时本轮不结算、再跑一步，收尾轮不消费；占位行不进消息列表与历史，用户原文保留；领取路径同一句清零该列，迟到意图按普通排队被回答。前端空草稿 Enter 与队列每行「插话」按钮走同一命令，带图片的项不提供插话。证据：真实临时 PG `agent-conversation-main-loop` **11/11 PASSED**（含两条新用例）、单测 `assist-steer-context` 3/3、工作台 `assistQueueSteer` 3/3，两端 `tsc` 无本轮报错。**未覆盖**：插话与结算的竞争（落败即按普通排队）、单次生成路径不生效、真实 Chromium/Windows 窗口与 IME、独立验收；未 commit/push。规则归[工作台 §39](../frontend/workbench-design.md#39-排队消息的插话手势2026-10-19-已实施)、[运行时上下文 §2.9](../architecture/runtime-context.md#29-排队消息的插话进入上下文的方式2026-10-19已实施)、[HTTP §10.102](../api/http-command-contract.md#10102-排队消息的插话2026-10-19-源码实现)、[数据库 §106](../database/physical-design-postgresql.md#106-0122-排队消息的插话意图2026-10-19-源码实现)，成绩归[验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。
