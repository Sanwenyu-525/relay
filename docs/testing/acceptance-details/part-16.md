# 功能验收详细记录：分册 16

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../overall-acceptance-details-20261025.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

## 条目 277

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 普通页面标题与区域标题字号对齐（2026-10-01） | 部分通过（浏览器与 token 层通过） | 用户比对根目录 `preview.html`（`docs/frontend/mockups/` 索引，7 组 55 张）后选择「放大字号但保留 Sans」，不采纳 2026-09-19 逐页图的衬线大标题。据此改唯一数值源：`font.size.page` 由 `{font.size.compactPage}`(1.75rem) 放开为 **2.5rem**，`font.size.section` 由 1.5rem 提到 **1.75rem**，`font.size.display`(3.5rem) 保留为历史值但页面主标题不再使用；`TodayView.css`/`SettingsView.css`/`CollaborationView.css` 里硬编码的 `compactPage` 标题改为 `font.size.page`，窄窗降级收敛到 `styles.css` 唯一一处 `@media (max-width: 40rem)`。**这推翻了 2026-09-28「今日主标题从 display 收到 compactPage」的单页特例**，今日页现与其余普通页同级。只读示例模式取样：`/today` `/projects` `/tasks` `/knowledge` `/reviews` `/settings` `/connections` `/activity` 八路由在 1280 宽主标题一律 **40px**、区域标题 **28px**，390 宽一律 **28px**，根 `scrollWidth` 等于视口宽；协作页同步放大后 1280×720 页头 130→**145px**、聊天记录 287→**272px**、成果正文仍 **416px**，均在 §17.6 的 240px 下限之上。`tsc --noEmit` exit0；`reviews`/`projects`/`knowledge`/`todayView`/`tasks`/`liveWorkspaceLists`/`uiRemediation20260928`/`productSupplement26`/`connectionsSettings` 共 9 文件 140 例通过。输出留本机 `output/acceptance-raw/ui-align-20261001/ordinary-1280x720/` 与 `ui-align-ordinary-type.json` | 全量回归同样被上一行的 `a4409b1` 阻断，本行未新增失败。**右栏内容形状未改**：当前仍是「标签: 值」定义列表，会露出「验收条件 ID / 请求身份 v1」这类技术身份，逐页图则是「大字值的用户语言事实 + 小标签 + 明确动作」——这是内容重排而非字号，需逐页决定放什么，属下一批的 `JudgmentBar`/`PageHeader` 推广。本行不含原生窗口、WebView2 字形、真实 IME、125%–150% DPI、完整业务写入/恢复与安装；衬线标题未采纳，`font.family.editorial` 仍只服务历史参考 |

## 条目 278

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 全局控件与交互基线、最大化修复（2026-10-01） | 部分通过（共享规则及所涉最大化样本通过） | 沿用 tokens/共享 CSS/AppDialog/tabNavigation，补齐输入错误/只读/禁用、图标与危险按钮按下态、页签点击区及表单异步反馈；修复普通桌面页壳 Grid 高度与滚动，标题栏改为“搜索资料”。新增反例先失败再修复：任务校验错误聚焦、成功结果聚焦、readiness 输入冻结、迟到结果不抢命令面板焦点、弹层隐藏/禁用/闭合 details/IME/顶层焦点、资料/工具页签语义与键盘。根代理全量组件回归 **74 文件、549/549、0 失败、exit0**；之后迟到结果焦点补修的最终定向 **5 文件、44/44、exit0**，不累加为新全量。最后页签密度 CSS 调整后 `tsc --noEmit` 与隔离 Vite 生产构建均 exit0，输出 `output/acceptance-raw/ui-global-controls-20261001/build-accepted-final/`；已有 chunk 大小/混合导入警告保留。由 computer-use 操作真实 debug/WebView2 最大化窗口（1536×816 截图）：新建任务读取项目后可滚达验收/保存区，空表单保存仅触发客户端校验并回到首个错误；资料真实正文加载后侧栏底部可见，Home/End 切换后资料目录自动展开且焦点保留，四标签同排；T2 工具 End 到运行记录、执行输出独立展开/收起；Ctrl+K 初始输入焦点、Shift+Tab/Tab 和 Esc 后入口焦点恢复均观察通过。真实窗口零业务命令/Provider 调用，成功创建仅在组件 fixture 验证。规则归[设计系统 §6.2](../../frontend/design-system/part-02.md#62-全局控件与交互实施基线2026-10-01)与[工作台 §17.5](../../frontend/workbench-design/part-04.md#175-最大化优先的控件与交互接续2026-10-01) | 首轮两个 P1 与搜索 P2 在本轮最大化样本已修复复验；后续五图反馈修复见下一行，原分片成绩不自动覆盖后续修改。未做缩窗复验，按用户要求后置。全部33页面/状态、长审批/已有会话草稿、真实输入法组词与 DPI、四条完整业务/故障恢复链、正式桌面包及安装仍待验。新增 AppDialog 组合键过滤的组件通过不等于真实 IME 已通过；本轮前端构建不更新旧正式 EXE，不改变 API/数据库/命令 Owner 或原服务端待核对状态 |

## 条目 279

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 用户五图控件反馈修复（2026-10-01） | 已通过（所列五处最大化样本） | 共享焦点改为沿原边界向内显示，保留无边框控件可见焦点、错误 danger 与实心主按钮 onAction；复合搜索/分段/文件入口同步取消外扩第二圈。会话 select/primary/secondary 共用 control.height；DevTools 根与输出抽屉改用 canvas；近期项目 summary 补 hover/pressed；紧凑 ModelConnectionStrip 固定剩余宽度、工具带顶端对齐并保留原生只读开合。根代理定向组件回归 **6 文件、85/85、0 失败、exit0**，覆盖模型只读条、协作、控件焦点、AppDialog、命令面板与近期工作分页；`tsc --noEmit` 与隔离 Vite 构建均 exit0，输出 `output/acceptance-raw/ui-control-feedback-20261001/build/`，既有 chunk/混合导入警告保留。computer-use 操作真实最大化 debug/WebView2（1536×816 截图）：Ctrl+K 输入单层焦点、Shift+Tab 关闭按钮及 Tab 返回输入可见焦点；会话下拉/新建/刷新等高，左右工具底色一致；项目分组展开及折叠时指针停留均有底色、移出恢复；连接摘要开合前后按钮和摘要位置保持不变，正文在下方自然展开。未点击创建/连接验证/运行控制或提交业务命令，零 Provider 调用 | 结论仅覆盖本行五处及受影响组件，未重跑前轮全量、不合并旧成绩。缩窗后置；全33页面/状态、长审批/已有会话草稿、真实 IME/DPI、完整业务与故障恢复、正式桌面包及安装仍不由本行证明。没有 API/数据库/路由或业务 Owner 变化 |

## 条目 280

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 整套 UI 重做与交互覆盖（2026-10-01） | 部分通过（组件/浏览器视觉） | 用户已选[工作主线图](../../frontend/mockups/2026-10-01/work-first.png)（1487×1058），共享页壳、协作与七类页面已重做。根代理实际运行 `vitest run --maxWorkers=2`：72 文件、521/521、0 失败、exit0；`tsc --noEmit` 通过。含 workId＋连接 epoch 的晚到面包屑隔离反例 `workBreadcrumbScope.spec.ts` 1/1、组合草稿/原命令保护、Review 移除/读取失败保留 Owner、确切历史版本缺失、知识切换和水平页签键盘等组件反例；随后 CreateTask 呈现与项目中文原因补修，六文件定向39/39、exit0；最后Run未决原因纯文案补修的三文件定向29/29、exit0，不拼成新全量。实际 in-app browser 使用隔离 loopback fixture API 8794，GET-only、0 业务提交、无真实 PG/Provider，检查项目/三工作台、两种Review、知识、设置横向页签、新建Task、Today、Task详情/成果/Run及项目连接只读页。最后协作390×640短窗、960×640及1487×1058长ACTION_APPROVAL展开依据均核对正文和末尾动作；Tab可聚焦请求修改/拒绝，零提交。1280×480展开导航后Tab到连接的父壳意外滚动已修，最终截图父容器scrollTop=0；历史v2→v1正文变化、Task页签ArrowRight到运行记录已观察。最终 `.jpg` 截图 `06/07-collaboration-390-{result,judgment}-final.jpg`、`10-collaboration-approval-expanded-{top-final,final}.jpg`、`13-short-window-navigation-final.jpg`及14–18页样本与测试日志留本机 `output/acceptance-raw/ui-work-first-20261001/`，详细视觉范围见[视觉 QA](../../../design-qa.md)。此前隔离生产构建通过；后续控件修复后的最终隔离前端生产构建已通过，见本表全局控件行，非正式桌面包。初始缺陷及取舍分别见[审查](../../research/agent-ui-review-2026-10-01.md)与[开发记录](../../development/ui-live-integration-2026-09-28.md#18-工作主线整套-ui-重做与恢复-owner-保护2026-10-01) | 组件与只读 fixture 不能证明全部33页面/状态或四条完整业务路径均通过。最新 DesktopDev 的有限真实窗口只读结果见本表前两行；真实业务提交、PG/Provider组合与故障恢复、完整 Windows 状态/真实IME/125%–150% DPI/安装仍未验；没有本轮新发布桌面包，旧 EXE/构建通过不覆盖重做源码 |

## 条目 281

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| M04 文件/网页读取委托 UI | 已通过（组件＋确切包 Windows 读取） | 2026-09-30 `TaskDelegatePanel` 与 typed `delegateTask` 接入现有两种读取意图，默认 NONE、与 Mock 互斥；独立 Node24 定向组件21/21、`tsc --noEmit` 通过，覆盖载荷、配置/目标门禁、迟到响应与 UNKNOWN。首冻结包 EXE `e1ae929b4ee54b190a9b8502441764db067aa2c58b71dfaa8a03e783bd0a7734`、manifest `8f6c44b010c15df177852a7fe939313cb3f531f68237763661be4109280e84e9` 构建/包校验和加强最终产物断言后的 read2/2 通过。随后含 Skill JSON mode 修复的同表下述 `ae89f068` 确切包必要 read 复验2/2、exit0；[Windows 脚本](../../../apps/desktop/tests/m04-real-read-skill-webview.mjs)均用独立PG/API/Worker＋真实Provider：FILE_READ ASK 等待时零 Invocation/模型调用，界面批准后读取一次；WEB_FETCH AUTO 读取一次。原 Delegate、Operation/Invocation、冻结连接、物理正文/hash、原 Manifest 重建 DRAFT 输入与唯一 call 匹配；CRITERION 接受前零完成，后唯一 Artifact/Completion。最终产物 bytes/SHA、Review、Verification、Completion 绑定同一版本，HUMAN 检查引用原UI决定；标题栏自然退出0、原进程树/来源listener/PG/临时根清理通过。完整日志仅留本机 `output/acceptance-raw/m04-20260930-read-*.log` | 自动化点击证明界面命令及完成门，真人质量/交互、完整 Windows 状态、安装与 M04 总出口另验。Skills 3/3 与 read2/2 为同一修复包的不同会话，不声称单轮 all5/5 或完整 UI 通过。扩大四组件首轮77/78，近期工作读取失权项失败；唯一必要单项复验1/1通过，未稳定复现或修复，不拼成整轮全绿 |

## 条目 282

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 人工项目/任务/产物/完成与重开 | 已通过（基础链） | 2026-09-28 真实 API＋隔离 PG＋浏览器闭环，见[实施记录](../../development/ui-live-integration-2026-09-28.md#4-真实业务闭环与逐页核查) | 最新源码与 Windows 全路径不自动继承 |

## 条目 283

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| Mock Delegate→Review→完成/重启恢复 | 已通过（基础链） | 2026-09-25 冻结 Windows 试用包，见[M03](../m03-independent-acceptance.md) | 附加动作配置由测试 HTTP 完成，配置 UI 不包含在此结论 |

## 条目 284

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| Mock 完整并发、取消、UNKNOWN 可靠性 | 已通过（有限 Mock 基准） | 2026-09-30 当前源码真实 PG 全量 495 通过/0 失败/5 跳过，含确定性 G06 8/8、Manifest 对照及 20 项篡改；取消/完成两个独立进程竞跑均通过。同日冻结包真实 WebView2/PG 的 ACTION、UNKNOWN、在途 CANCEL、同页 SSE 及产物恢复均退出 0，G01–G08 必要 Mock 出口独立复核闭合。UNKNOWN 带诊断连续重启 3/3 保留原 Invocation、原 QUARANTINED claim，无重复效果/产物/完成；历史分片见[M03](../m03-independent-acceptance.md) | 首次 UNKNOWN observer 曾退出 101，后续完整链及连续重启未再现，根因未定位，不能称已修复。Windows 在途 CANCEL 使用受控包内 Worker 与真实 UI，停机后由 harness 调用生产恢复 Owner，不冒充宿主自动回收组合。5 跳过为 4 项真实模型与 1 项 M06 Windows helper 无回执反例 |

## 条目 285

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| Mock 文件动作输入与原委托载荷 | 已通过（组件＋冻结包 Windows） | 2026-09-30 失焦反例先失败后通过，定向 7/7、Workbench 415/415、类型检查通过；冻结包真实 UI 连续键入目标/内容、提交原 Delegate 载荷，经 ACTION_APPROVAL→原动作一次效果→CRITERION→完成通过。根因见[开发记录](../../development/m03-run-dispatch-slice.md#mock-文件动作的-react-委托与历史入口开发自检) | Connection/受管目录/权限策略仍由 HTTP 配置，不能称这些管理入口已通过 UI；不覆盖并行界面后续修改 |

## 条目 286

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| M03 本轮冻结包与桌面验收入口 | 已通过（确切包范围） | 2026-09-30 忽略目录 `output/acceptance-raw/m03-frozen-20260930-f51158d5` 独立构建、包校验及上述 Windows 链通过；EXE SHA-256 `8e9928f573c76903fcdfc93092d04273510da715b9c8c5f8fd296dc3fac92300`，manifest SHA-256 `b977a591a9ecc2e78ca092b396596b27e8df94a226010f1c81f36bc582140a0c`。[动作/UNKNOWN](../../../apps/desktop/tests/m03-action-approval-webview.mjs)、[取消/产物](../../../apps/desktop/tests/m03-review-resume-webview.mjs)均绑定原包及 0013；每次 PG 停止 0、临时目录删除 True | 首次退出 23 是已有开发窗口占单实例锁；用户授权结束该确切开发进程后复跑。旧开发窗正常关闭失败根因未定位，新包正常关闭通过仅覆盖所列基准；未替换目录测试入口，未验证安装/升级或最新完整 UI |

## 条目 287

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| Windows 产物续版、接受、重开与关闭 | 已通过（冻结包人工链） | 2026-09-30 `m03-review-resume-webview.mjs --artifact-lifecycle` 退出 0：5 次写命令均真实 UI，刷新后同 Artifact v1→v2，旧版正文/hash 不变，State 选用 v2/完成接受 v1；重开及包重启后 READY、当前完成指针清空、历史凭据保留且不继承。标题栏点击关闭，页面 close 一次、宿主自然退出 0/无 signal、已记录进程树停止 | 开始人工任务为 HTTP 前置；该链零 Run，无实际 Worker。首跑新增观察器因 Tauri invoke 不可写而断言失败，移除私有注入赋值、改只读 page close 事件后必要复跑通过；不改写首失败日志 |

## 条目 288

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| Windows 同页 SSE 断线重连 | 已通过（冻结包同页） | 2026-09-30 [同页脚本](../../../apps/desktop/tests/m03-sse-same-page-reconnect.mjs)退出 0：定向结束原 PG SSE backend，原页面自行从 after=1 重连，seq 1→31/Run revision 6；原 host/API/supervisor 身份保持，无新增控制命令或 URL 凭据，PG 与临时目录清理通过 | 仅为所列可控断线；不替代真实 Provider、全 UI/IME/DPI 或安装验收 |

## 条目 289

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 模型连接验证与配置保留 | 已通过（定向） | 2026-09-29 固定探针真实外呼、账本、重启配置保留，见[历史实跑](part-17.md#61-本轮实跑) | 不等于全部模型业务可用 |

## 条目 290

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 真实 DRAFT、HARD SEMANTIC、取消/abort | 已通过（定向） | 2026-09-29 隔离真实 Provider 原用例 4/4，见[进度历史](../../development/codex-next-step-history-20260930.md)及[语义修复](part-17.md#62-本轮发现并修复的缺陷)。2026-09-30 [DRAFT 用例](../../../apps/api/test/integration/real-model.integration.test.ts)强化原 call→持久 Manifest→明确来源版本/完整正文 hash→候选原样回显：首轮 3/4，DRAFT 把整段中文描述当作标记而未完整回显；资料正文改为纯 ASCII 唯一标记后仅必要 DRAFT 复跑 1/1，未放松来源、回显或完成门断言，生产 prompt 未改；两轮 PG 清理通过 | 新强化条件没有单轮 4/4 全量成绩。普通业务的真实 Windows 闭环见下行；不代表所有 Provider/质量场景通过 |

## 条目 291

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| M04 原调用首文本与首预览持久计时 | 已通过（开发自检＋独立回归） | 2026-09-30 [0047](../../../apps/api/migrations/0047_m04_model_call_first_output.sql)及原 Owner 写入、Trace HTTP/React 展示已接入。开发自检 36/36（DRAFT 预览 8、Assist 预览 8、迁移 9、CLI 5、Trace 6），独立受影响 PG 回归 64/64（Run Steps 8、Assist 45、预算 5、Provider 故障 6），均无失败/跳过；API 单元 144/144、受影响前端 24/24、两端类型检查通过。覆盖空帧不计、首值不覆盖、清预览保留、旧行空值、角色权限、真实 HTTP 字段、取消/旧 Worker 门禁及失败回滚。独立回归四临时根与端口、API/PG 清理通过 | `started_at` 是账本受理；首文本是合法 Owner 的回调观察，首预览是事务内写入，不是提交返回/Provider 收包/窗口显示。结构化提案和历史未知值不补造。独立回归首轮在启动阶段遇到 PowerShell 重定向继承管道等待，未进入业务测试；保留原输出，改外层文件句柄后通过，不能称产品故障修复 |

## 条目 292

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| M04 真实 Provider 与 Windows 协作定向闭环 | 已通过（确切冻结包） | 2026-09-30 [真实 WebView2 脚本](../../../apps/desktop/tests/m04-real-model-webview.mjs)第二轮退出 0：UI 显式选源并 Delegate，原唯一 DRAFT call/Manifest/完整源 hash 与候选标记一致；UI Review 前零完成、接受后 Task DONE/Run COMPLETED/唯一版本与完成记录，Trace 显示持久时间。普通 Assist 首预览、第二轮不重供标记的历史回复，以及第三轮类型化提案通过；待接受零业务写，UI 接受＋原 command 重放同回执，只新增一个 HUMAN/INBOX Task/一条必需 HUMAN 条件/零新 Run。独立构建目录 `output/acceptance-raw/m04-frozen-20260930-d889f527` 包哈希校验通过，EXE `ecf9fcb45344abd73137a314c6feb3fc0339d010ec2a810be67716a28b2b3650`、manifest `c088d7b2df39533921d50e1dd846423767c1de1d269d3ab8d3cb497bef7a3f36`；0047 与包清单绑定。标题栏关闭，页面 close 一次、宿主自然退出 0/无 signal、原进程树停止，PG 停止 0/临时根删除 True | 第一轮提案标题未按“第一轮标记”命名而整链失败，原失败日志保留；第二轮将第三轮标题写为明确字面量，其余断言不减，不证明第三轮无提示历史检索（第二轮单独验证）。仅复制获授权模型白名单配置，使用合成资料、隔离 PG/Graph，不替换目录测试入口、不覆盖并行后续 UI。不涵盖真实服务故障、工具组合、全部 Skill/提案质量、IME/DPI 或安装 |

## 条目 293

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| Provider 六类错误的真实故障矩阵 | 未验收（真实服务）；受控链已通过 | 2026-09-30 `run-integration.ps1 -SkipBuild -UseCLocale -TestFile model-provider-faults` 退出 0、6/6；[新增矩阵](../../../apps/api/test/integration/model-provider-faults.integration.test.ts)用真实 SDK Adapter 经既有 transport seam 对接隔离本地 HTTP，覆盖 401/AUTH、429/RATE_LIMIT、实际 deadline/TIMEOUT、合法 SSE 无 DONE/STREAM_BROKEN、422/PROTOCOL、headers 前断 socket/NETWORK。Assist 原 Owner→PG→独立 API 保留原唯一 call_id、正确 FAILED 分类，无部分正文/提案/预览；每类一次请求，listener/socket/API/PG 清理通过。原 Fake 及投影反例见[诊断记录](../../development/ui-live-integration-2026-09-28.md#14-m04-run-模型调用诊断与本地错误归因2026-09-30) | Bridge 使用合成输入与测试凭据，仅清除物理 Response URL 并向本地传输，不改生产 HTTPS/SSRF 规则；不证明真实 Provider 服务、TLS/DNS 或 Windows 故障链。首轮测试隐私观测直接序列化 BigInt 失败，保留原日志，改十进制 string replacer 后仅必要矩阵复跑通过，未删除断言 |

## 条目 294

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| M04 模型原生工具参数的能力拒绝与证据保全 | 已通过（受控 SDK/PG/API） | 2026-09-30 原 7/7 暴露拒绝前已观察 request ID 未进入错误封套，四项窄单元先红后修复。当前 API 单元 152/152；[故障矩阵](../../../apps/api/test/integration/model-provider-faults.integration.test.ts)10/10（原六类＋工具先/后正文两项合法 SSE＋已知/未知错误封套两项 PG seam）、预算回归 5/5，均零失败/跳过。原唯一 call、Message、HTTP 的 ID/已知或未知用量一致，`FAILED/ModelToolOutputError` 与 Provider 类别 null；失败后正文/提案/预览/Gateway 均零。工具先于正文的首时间空值；正文先于工具的首时间保留，单请求无重试。协调侧独立只读核对成绩、原 PID/端口和临时根清理；最后补非文本 URL 不进入封套的窄断言，端口单元复验 13/13。listener/socket/API/PG 清理通过，临时根删除 True；本机输出在 `output/acceptance-raw/m04-20260930-tool-metadata-*.log` | 已知规范化 usage 使用公开 SDK stream seam，已知/未知落库使用错误封套 seam，均不冒充真实 Provider wire/计费。当前 SDK 在流末才发规范化 usage，提前拒绝时未观察用量仍 NULL；空 ID 与非文本拒绝有单元反例。不是工具执行、真实服务故障或 Windows 修复验收；多工具及非流式组合未覆盖 |

## 条目 295

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| M04 Files/Web→真实模型→人工完成 | 已通过（隔离 PG/HTTP 图组合） | 2026-09-30 [opt-in 用例](../../../apps/api/test/integration/real-model-read-sources.integration.test.ts)必要复跑 2/2、0 失败/跳过：临时合成文件和独占本机 HTTP 各一次真实读取，Capability 为 REAL/READ，冻结 Connection 身份/版本/config 与原 Operation 一致；唯一成功 Invocation 的正文与全文/片段 hash、原 DRAFT call 的 read IDs/模型配置指纹/非零用量/request ID、原持久 Manifest＋读证据重建的 input hash 均核对。标记只在正文，候选原样回显；HTTP Delegate 与 HUMAN Review，接受前零完成，之后 Task/Run 完成、唯一 Artifact/Completion；读取和模型调用在恢复后原样不变。Node24 编译通过，API/来源 listener/PG 清理通过，临时根删除 True。明确 fake 配置自检为 2 skip/0 fail，不启动 API/网页或外呼 | 首轮 0/2 失败在误查 Connection 的历史 FAKE 标签；实际派发按 Capability 使用真实 Adapter。仅将测试断言改到正确 REAL/READ 注册并加强冻结 Connection 校验，保留物理读取/hash/回显，不改生产默认或直接改 SQL 标签；首失败日志保留。图执行由测试进程 `runOneCommand`，不证明独立 Worker/Windows 读工具 UI；本机网页仅隔离 Connection 显式 `allow_private`。固定用户冻结读意图不等于模型原生工具参数执行 |

## 条目 296

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| M04 首批三个 Skill 的真实模型组合 | 已通过（确切包 Windows 定向）；稳定性/质量未验 | 2026-09-30 此前[HTTP 组合](../../../apps/api/test/integration/real-model-skills.integration.test.ts)首轮 2/3、任务契约必要单项 1/1 保留。随后旧 Windows 包任务契约再次 `FAILED/OUTPUT_SCHEMA_INVALID`，另两项未运行；错误发生在严格解析阶段、早于提案构建，原正文未保存，具体拒绝字段未知。查明 Skill 内部 DISCUSS 漏 JSON mode 的独立代码缺口，三项受控 wire 回归先红后修；Port 18/18、严格 Skill 单元5/5，协调侧 Node24 全 API 单元157/157，零失败/跳过；只读独立复核无问题。修复包 `output/acceptance-raw/m04-frozen-20260930-ae89f068` 构建/包校验通过，EXE `c617e1081eaf62dfceff90e05e6a91ff73655a95bdd77e1ba1f1212deec57dbf`、manifest `6e9126bf02fc642049ad45c2d5c27a7a0995df775207c6874b779debaa0bf4d4`；[真实 WebView2 脚本](../../../apps/desktop/tests/m04-real-read-skill-webview.mjs)单轮 skills 3/3、exit0：确切 `task-to-execution-contract@1.1.0`、`verification-plan@1.1.0`、`project-resume@1.0.0` 均由 UI 生成、独立 Worker 原唯一真实 call。冻结版本/SHA/基线、配置指纹/request ID/非零用量与输出 hash 核对；两提案接受前零业务变更，UI 双确认按三 hash/双 revision 接受及原 command 重放单效果，Task/acceptance 各+1，旧约束/条件/执行权保留、新条件必需 HUMAN、零 Run/Completion；恢复摘要只读、零 revision 变化/提案。标题栏自然退出0、原进程树/PG/临时根清理通过；首失败及最终日志仅留本机 `output/acceptance-raw/m04-20260930-*.log` | JSON mode 修复不证明历史失败的具体输出根因；单轮通过不代表稳定完成率、真人回复质量或 M04 总出口。自动化点击只证明接受命令，非真人质量判断；合成数据/隔离PG/原配置白名单范围不扩大。普通 DISCUSS 首预览、严格 schema 和 Owner 不变，不保存 raw 输出或自动重试。构建首轮遇并行 UI 未用 import，最小删除该 import 后通过；未替换用户目录测试入口。此前缺失/Fake/残缺配置各3 skip及动态导入修正保持原边界 |

## 条目 297

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| Assist/Run 调用诊断与取消归因 | 已通过（增量） | 2026-09-30 API 144/144、受影响 PG/HTTP 65/65，见[最终诊断记录](../../development/ui-live-integration-2026-09-28.md#14-m04-run-模型调用诊断与本地错误归因2026-09-30) | M04 总验收及真实故障上浮全链 |

## 条目 298

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| Agent 聊天发送、导航保护与 Mock 回复 | 已通过（开发版基础链） | 2026-09-29 WebView2＋隔离 PG＋Mock，见[聊天验收](../../development/ui-live-integration-2026-09-28.md#11-独立-agent-聊天验收2026-09-29) | 最新协作改版与真实 Provider/安装包另验 |

## 条目 299

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 协作工作区的导航与任务入口 | 已通过（开发版导航） | 2026-09-30 此前菜单 6 真实 Windows 窗口实点项目页「协作」及任务详情入口，同一 Task 深链接与标题一致。随后按用户要求把近期工作改为所有 live 页常驻，窄屏纳入导航抽屉；切页保留列表，连接切换隔离旧 Workspace，刷新失权清掉旧条目。新增三项反例先失败后通过，导航定向 41/41、受影响列表及创建回归 18/18，最终 Node 24 前端全量 65 文件 456/456；类型检查与独立目录生产构建通过。只读浏览器夹具覆盖 1280/960/390 宽度及 400/500 短高度，所查场景无根横溢，短窗口与抽屉单层滚动，实点工作进入确切深链接并关闭抽屉；组件断言零业务 POST。规则见[工作台第 14.6 节](../../frontend/workbench-design/part-03.md#146-已选方向的工作区与动作)，本机截图与输出为 `output/acceptance-raw/ui-fidelity-20260930/recent-*` | 本次常驻导航增量未重打桌面包或重跑真实 Windows/IME/DPI，浏览器夹具不证明 PG/Provider 业务链；目录测试包与完整协作业务、安装交付另验 |

## 条目 300

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 最新协作页视觉与 Review 状态/草稿 | 部分通过 | 原三尺寸/Review 反例及前端 407/407 见[Review 修复](../../development/ui-live-integration-2026-09-28.md#13-协作页参考图接续与-review-修复2026-09-30)。同日第二轮真实状态纠偏：受影响组件 63/63、类型检查与独立目录生产构建通过；正文 503 结束加载且只读一次、显式重试与迟到版本、委托折叠保留输入/UNKNOWN 不可隐藏、通知入口回归通过。八个浏览器场景覆盖 1512/1280/1024/900/390 宽度、640/480 短高度、320px 侧栏、长标题、无会话、失败/空文档、正常判断与未知委托；无整页横溢，新建/重读可滚达，通知弹层不越界且 Esc 关闭。此前真实窗口实点导航、列表局部滚动与最大化，本轮热更新真实窗口仅复核顶栏通知已呈现。2026-10-01 入口精修：Node 24 协作组件 31/31、类型检查与独立目录生产构建通过；既有只读视觉 12/12，选择表单 31 项断言覆盖 1920/1280/900/390 宽度、1032/844/800/500 高度、未选禁用、读取失败、间距、无根横溢及进入确切 Task，均零业务 POST。独立补查 390×500 加载/空列表的禁用与滚动可达、900/1280×500 活跃文档/检查/历史真实点击及讨论草稿保留通过，零写入。基准为本次 `CollaborationView.tsx` 与 CSS，截图与临时检查保存在 `output/acceptance-raw/collab-polish-20261001/`；规则见[设计系统](../../frontend/design-system/part-01.md#51-协作工作区的视觉层级) | 最新真实产物任务的 Windows 状态复核尚未完成：开发窗口结束后另一项独立桌面验收占用单实例；真实 API 判断提交、完整 Windows/IME/DPI 状态矩阵另验；未重建目录测试包 |

## 条目 301

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 全页面视觉/故障状态覆盖 | 部分通过；本轮重点整改复验通过 | 2026-09-30 按 ui-ux-pro-max 对照既有参考图，三工作台补任务/资料目录、确切版本正文和同任务 AI 入口；设置的本设备显示偏好保存/重载通过；Task Skill 同页生成入口、服务端合并提案、双确认与执行权门禁、蓝图候选摘要及 Run 待审批/已暂停/UNKNOWN 已复核。此前 22 项最终浏览器截图及 65 文件 439/439、后续 Task Skill 门禁 30/30 绑定原时点。最新结构修复覆盖待审列表/类型筛选与右侧判断、产物确切正文/编辑/预览及同页冲突对照、Task 合并提案/派生检查表和当前/历史完成凭据，取消重复内边距并保留原命令 Owner。独立只读代码复核后关闭 Task/产物列表失权泄露与403→503旧事实重新出现的反例；原A命令/B草稿、确切版本读取失败/重试/迟到、409显式换基线与未决确认仍有回归。最终 Node24 前端全量66文件474/474、类型检查和独立目录生产构建通过。只读浏览器夹具实查1487/1280/960/390或375宽度，所查场景无根横溢；Task确认、产物完成与待审判断各保留单实例，缩窗本地草稿保留，AI产物禁写，历史凭据无当前完成宣称，原未保存离开提示与只读抽屉Esc关闭可用。浏览器未执行业务POST，409、失权与命令恢复为组件模拟，不能混为真实PG或Windows流程。截图与完整输出留在本机 `output/acceptance-raw/ui-fidelity-20260930/detail-*`、`artifact-*`、`task-layout-*`，此前整改为 `fix-*`；旧矩阵见[历史实跑](part-17.md#61-本轮实跑) | 当前33个页面/状态未完整逐图复验，知识capture、非空恢复/搜索等仍待补；产物冲突尚缺当前浏览器/真实业务同页取证，图中富文本编辑/自动合并未作为已实现能力。Development Git diff/CLI缺HTTP/UI协议。最新Windows/IME/DPI、真实Provider/PG全链未重跑；本轮未重打桌面包或安装验收。只读视觉夹具不证明业务写入/模型输出/验证成功 |

## 条目 302

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 目录测试包的输入/资源完整性 | 已通过（记录时点静态范围） | 2026-09-30 389 个源码输入、17177 个资源哈希、字体许可及零链接检查通过，见[纠偏记录](../../development/ui-live-integration-2026-09-28.md#16-整套页面视觉纠偏与发布输入冻结2026-09-30) | 后续源码变更须重新生成清单/校验；安装与真实窗口另验 |

## 条目 303

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| Today/三套工作台/知识/Trace/Lineage | 已实现待总验收 | 页面交互与分片测试已有记录，见[范围历史](../../development/codex-next-step-history-20260930.md) | M05 完整真实业务与桌面验收 |

## 条目 304

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 项目归档与关联写入栅栏 | 已实现待总验收 | 后端命令、live 入口与主要写入口已有开发自检，见[范围历史](../../development/codex-next-step-history-20260930.md) | 完整集成与独立验收 |

## 条目 305

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 文件/Git/CLI 与 UNKNOWN/PARTIAL 人工处置 | 部分通过 | PG/HTTP、隔离 Windows Job 和无回执恢复分片，见[M06](../m06-independent-acceptance.md) | 确切包、人工交互与 M06 总出口 |

## 条目 306

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| Git 状态/diff 的协作 UI | 未接入 | Adapter 已存在，但缺 HTTP/UI 协议，见[协作规格](../verification-plan/part-02.md#16-agent-协作主线验收提案) | 接入协议与真实改动归属验证 |

## 条目 307

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 交互终端 / PDF 导入 | 未接入 | 当前只提供执行输出读取；两项未交付，见[当前入口](../../../CODEX_NEXT_STEP.md) | 不以输出面板或其他格式导入代替 |

## 条目 308

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 菜单 6 桌面开发启动 | 已通过（真实 Windows 窗口 + 真实隔离 PG）；安装验收仍未做 | 2026-10-06 两轮真实故障，均已修复并用真实窗口取证。**首轮 `SCHEMA_UNAVAILABLE`/exit 101**：开发窗口执行的是 `src-tauri/resources/api` 暂存产物而迁移门只看测试包清单哈希，`-RefreshApi` 新增迁移后数据库落后、readiness 要求清单完全相等即阻断；门改为「包清单 SHA-256 改变**或**暂存迁移集摘要相对 `session.json.dev_schema_hash` 改变」，DesktopDev 的 migrate/install-graph/init-workspace 一律取自暂存产物；新增 `.gitattributes` 固定 `apps/api/migrations/*.sql` 为 LF（`0054` 曾被 autocrlf 转成 CRLF，与库内摘要不符）。库侧发现并处置：`relay_trial` 台账中 `0054` 摘要对应一份 2026-10-03 应用、10-04 才首次提交的草稿版，实际 DDL 少了 `WEB_FETCH`/`FILE_WRITE` 两个约束分支且已不可恢复，按授权重建试验库（initdb→bootstrap→61 条迁移→Graph→工作区）；证据为迁移 61/61、`relay_app` 兼容视图 61 行、Graph 0..4、`ck_logical_operation_resource` 含 WEB_FETCH/FILE_WRITE。**次轮 `PostgreSQL is unavailable`/exit 101**：`pg_ctl status` 报 running、端口在监听，但日志显示启动约 3 分钟后 `autovacuum worker ... 0xC0000142`（STATUS_DLL_INIT_FAILED）→ `all server processes terminated; reinitializing`，此后每个后端 `could not reserve shared memory region (487)`、连接即断；同模式 2026-09-29 已复发过一次，`pg_ctl stop`+`start` 可稳定复现（两次启动分别在 3 分 3 秒后崩溃），属本机环境问题而非配置或数据损坏。处置：启动器在 `initdb` 后写入 `relay-trial-managed` 段并置 `autovacuum = off`；不再以「postmaster 存在」当「数据库可用」，改用应用角色真实探测（`Test-DatabaseReachable`），失败先重启库再重试一次、仍失败则打印 `postgres.log` 末尾 8 行并中止。修复后证据：postmaster 已运行 17 分钟，修复点之后 487 错误/0xC0000142/reinitializing/autovacuum 行均为 0，定时 checkpoint 正常；真实窗口连续 6 分钟存活且每次探测 `61` 行，`dispatch_ready` 就绪，`CloseMainWindow` 后启动器以 0 正常退出（Vite 与启动锁均已释放，未使用强杀）。[启动回归](../../../scripts/test-desktop-launcher.test.ps1)累计新增「暂存迁移集变化但包清单未变须从暂存产物迁移」「试验集群必须带 autovacuum=off」「可达/不可达判定」三项断言并通过；[菜单](../../../scripts/test-desktop-menu.test.ps1)、[开发守卫](../../../scripts/test-desktop-dev-guard.test.ps1)复跑退出 0 | 本机 autovacuum worker 的 0xC0000142 属环境层（疑似 DLL 注入/安全软件），`autovacuum = off` 是去掉触发点的规避而非根治，若日后出现其它子进程同类崩溃需另行排查；未实测交互式 Ctrl+C 停止、打包版 Start 窗口与安装/升级流程；菜单 1 仍需先重新打包（测试包 48 条迁移 vs 库 61 条，按完全相等规则必然不兼容）；`resources/api` 含未提交的 0059/0060/0061 WIP 迁移，改动它们需再经菜单 6 启动一次补迁移 |

## 条目 309

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| Windows DPI/IME 与最新 UI | 部分通过 | M02 基础窗口有 IME/DPI 证据；2026-09-29 当时 UI 的 125% 取证通过，见[M02](../m02-independent-acceptance.md)和[实跑](part-17.md#61-本轮实跑) | 最新改版未完整验；本轮 150% 矩阵未完成 |

## 条目 310

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 冷启动/反馈与首输出延迟 | 部分通过 | 2026-09-30 收紧基准最终条件后的[固定 Mock 摘要](../evidence/m03/mock-bench-20260930-181113-48a1ae1f/summary.json)：4 路 Delegate、8 完成/2 排队取消，10 条命令 DONE、10 个 Invocation IDLE、2 条控制 APPLIED 后停止；202 p50 22.32ms、队列领取 13474.5ms、完整 DRAFT 已持久草稿 14192.5ms、取消状态收敛 69ms。[初测](../evidence/m03/mock-bench-20260930-180157-b4bf294e/summary.json)保留原口径。上述 M04 冻结包第二轮真实 Windows 单次观察：DRAFT 点击→视口首预览 3003ms（67 字符）、账本→首文本 705ms、首文本→首预览写入 41ms、账本→结算 74122ms；Assist 分别 2994ms（125 字符）、799ms、6ms、5092ms | 窗口值含轮询、滚动与动画帧，是首次可见观察上界，非精确首像素/首 token，也不是 p50/p95。Mock `first_persisted_draft` 取完整 DRAFT finished_at，不能当首片段。样本不足推断稳态尾延迟，排队取消不证明在途 abort；冷启动排队需分段测量，不由单次采样归咎某一依赖 |

## 条目 311

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| M07 数据库维护准入与原工作排空兼容 | 已通过（源码 PG/CLI 首片） | 2026-09-30 [0048](../../../apps/api/migrations/0048_m07_admission_gate.sql)及[维护用例](../../../apps/api/src/application/runtime-maintenance.ts)接入全库 NORMAL/DRAINING；[维护集成](../../../apps/api/test/integration/maintenance-admission.integration.test.ts)自检15/15、协调侧重新编译独立15/15。覆盖真实 SHARE/UPDATE 竞争、等待后原回执重读、CAS/有界锁等待回滚、跨 Workspace、两类提案接受、新领取与 VERIFY 零新效果、角色权限/缺行失败关闭；原 Run 发布/Graph Saver、Assist/Web 结算、Gateway delivery 与 UNKNOWN/PARTIAL 安全终结保留身份。独立七组既有 PG 回归137/137（Run Dispatch27、Model Verify8、Gateway28、Assist45、Blueprint5、Web19、模型预算5）；API 单元158/158、两端类型检查及中文维护错误3/3通过。各组 PG 启停/迁移/Graph 退出0、临时根删除True；只读源码复核无阻断项。完整输出留本机 `output/acceptance-raw/m07-20260930-admission-*.log` | 本轮没有真实 Provider 外呼或新维护包 Windows 验收；停机证明组合使用原受信测试端口，不算真实 Windows Job 停机验收。DRAINING 允许原在途写入，FROZEN/完整备份恢复、旧包升级与安装仍待验。自检首轮数值型0漏超时/FIFO假设、helper筛选缺口与 VERIFY 嵌套事务失败均保留日志，已修复并必要复验；不拼成全仓 PG 或 M07 总通过 |

## 条目 312

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| M07 当前 Windows 会话原宿主停机与持续持锁 | 已通过（源码/debug 原生及 Node 管道） | 2026-10-01 [原生入口](../../../apps/desktop/src-tauri/src/maintenance_session.rs)、[Node 协议](../../../apps/api/src/runtime/desktop-maintenance-session.ts)及[CLI](../../../apps/api/src/cli/maintenance.ts)独立复验：MSVC Rust 全 lib33/33，Node 定向12/12；[真实组合脚本](../../../apps/desktop/tests/m07-maintenance-session.mjs)5/5且必要复跑通过，临时根删除True/owned进程0。真实 Job 含 API/Worker/孙进程，停机保原 ARMED、READY 期间第二入口 BUSY、原 nonce release/EOF及无凭据使用。debug EXE SHA-256 `5d4eb709e7b80e6a4c5e254981f8df456e658b6f4b8fcfdf3e277c7cabef63c4`；最小 native-test-package 仅检此能力/hash。握手后 sticky failure、RELEASED→坏帧→exit0、READY后意外EOF→exit0与release尾随超界均先红后绿；harness另补旧EXE marker前检和有界退出，旧EXE反例执行前拒绝。完整输出留 `output/acceptance-raw/m07-20261001-desktop-stop-*.log` | 不证明跨登录会话/独立CLI/外部写者已停，不包含 PG/Provider/GUI/安装或完整备份；guard不改 DRAINING或业务恢复。首次独立Rust误设test Node变量导致32/33，纠正后33/33；GNU测试runtime未进入suite、首轮Job计数与OShandle等待差异均保留失败日志，不当作已通过。新发布脚本能力字段尚未作完整新包验收 |

## 条目 313

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| M07 Windows 实际受管内容发布与排他安全点 | 已通过（源码/真实原生与 PG 分片） | 2026-10-01 [ADR-015](../../decisions/ADR-015-managed-content-native-publication.md)接入同一原生助手的共享发布/排他会话；[CLI](../../../apps/api/src/cli/content-freeze.ts)明确只冻结受管发布。独立重新编译后 native27/27（新内容7、原Files20）、真实Node/CLI/store15/15、API全单元178/178零skip；MSVC release helper Node/CLI/store另15/15。新[内容冻结PG](../../../apps/api/test/integration/content-freeze.integration.test.ts)独立2/2：人工HTTP零Artifact/Version/Receipt/revision效果，解除后原命令重试及重新持锁时旧回执重放；原已派发Run UNKNOWN保原effect/target、不盲重发。独立既有PG产物18/18、Run步骤8/8、完整图/Saver62/62零skip（明确提供debug helper，含无回执强杀原case）；四套start/migration/Graph/stop均0、临时根删除True。API类型及只读源码复核通过。debug helper SHA-256 `01f34d9823eb6f0df57f9995ed3080e895ff1620303187ab9e914c295abb08ae`，release `da935fcefd0989848d59019da246f3c1db25ebde8b919a5554b4f066f8192859`；输出留 `output/acceptance-raw/m07-20261001-content-*.log` | 仅现版本ManagedContentStore实际原生IO；不是PG/Saver全冻结，不覆盖旧独立写者、外部FILE_WRITE/Git/CLI或手工修改，没有完整新桌面包/GUI/安装/备份恢复。release只释放自身锁，UNKNOWN仍须原受信Owner核对。自检首轮junction权限替代与回执header断言修正均保留失败日志和检查；worker图自检61通过/1条件skip并单独补1/1，协调侧完整62/62，不混成同一次成绩 |

## 条目 314

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| M07 本库 CONNECT/DDL锁与权限恢复机制探针 | 已通过（隔离PG机制，非产品备份） | 2026-10-01 [三组探针](../../../apps/api/test/integration/database-maintenance-boundary.integration.test.ts)自检3/3；协调侧补两把会话锁在COMMIT后仍持续阻挡原业务/Graph安装入口，再独立编译运行3/3零skip。实际REVOKE提交后旧app仍能写、新app42501；原/新migrator可用，完整dump目录包含业务台账/Graph，临时空库restore读回测试事实和schema。受控app成员/CONNECT grant-option漂移不会被bootstrap修复；已flush原有效ACL后按本库已验证PID注入维护连接中断，撤销仍持久，原migrator从原ACL恢复且权限逐项相等，未增pg_signal_backend。wrapper build/start/migration/Graph/stop均0、临时根删除True；输出留 `output/acceptance-raw/m07-20261001-database-boundary-independent.log`，原自检留admission前缀日志 | 测试直接使用既有角色和PG机制，没有生产fence/recovery CLI、完整角色/额外授权预检或残余连接/prepared transaction拒绝Owner。管理员仅做临时库生命周期、漂移和确定性故障注入。临时restore未覆盖受管文件、ARMED隔离、外部资源/历史依赖或真实恢复放行；不称FROZEN、完整备份/升级通过 |

## 条目 315

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| M07 生产数据库连接维护与原ACL恢复 | 已通过（源码/真实PG与CLI分片） | 2026-10-01 [实际会话](../../../apps/api/src/runtime/database-connect-fence.ts)、[CLI](../../../apps/api/src/cli/database-connect-fence.ts)与[集成测试](../../../apps/api/test/integration/database-connect-fence.integration.test.ts)：当前Agent重新编译自检14/14；指定gpt-6.1-sol只读复核后用原wrapper再次独立编译实跑14/14，零skip，源码/输入解析器/测试/wrapper基准未变，编译入口逐字对应。实际Application切DRAINING，原有效ACL/grant option准确恢复且凭据不改写；新app42501、受信dump可用、原两类DDL入口跨COMMIT等待，锁忙有界。旧app及Saver命名的真实app闲置连接、授权后启动对象锁、真实PREPARE后断连、角色/额外授权漂移、链接/损坏/错库均拒绝；外部ACL漂移不覆盖。实际CLI早期坏帧/尾随/超界拒绝成功输出、EOF/release恢复、强杀/已验证backend丢失保留撤销及凭据，显式恢复幂等。API全单元182/182（新[凭据/参数4项](../../../apps/api/test/unit/database-connect-fence.test.ts)）、原维护15/15、机制探针3/3和文档检查通过；三套PG启停/迁移/Graph均0，临时根删除True。完整输出留 `output/acceptance-raw/m07-20261001-db-fence-*.log` | 仅数据库连接准入，frozen=false；Savers命名连接证明数据库边界，不替代真实Saver在途停机。未组合完整备份/文件manifest/隔离恢复，未重打完整新包或验安装。Owner/管理员、外部写者仍独立；未知目标库后台可保守拒绝。四个实测失败根因及修复见[开发记录](../../development/m07-backup-recovery.md#数据库连接维护的失败边界)，保留初次观测设置错误/真实反例与复验。工作区外一次编译误输出的清理被自动审批拒绝，临时构建目录暂留，不影响上述临时PG清理 |

## 条目 316

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| M07 受管文件清单与原包历史定义保留 | 已通过（Windows源码内部入口/包fixture） | 2026-10-01 [文件复制](../../../apps/api/src/runtime/backup-files.ts)、[只读元数据](../../../apps/api/src/runtime/backup-paths.ts)及[原包核验](../../../apps/api/src/runtime/backup-package.ts)已实现；文件自检12/12，协调侧重新编译全API204/204零skip（含文件12与包10）。原正文/orphan/staging/ARMED bytes/hash不改，ARMED只进evidence；未知条目、非空未受管缓存、目标占用、真实junction/hardlink/文件与目录ADS、失锁及目录/字节漂移拒绝。原包资源实际集合与hash逐项匹配，完整Skill/Pack正文/依赖从原包导出，缺定义/坏hash/重复身份拒绝且无新版fallback；改包、挂起导出和stdout超1MiB反例通过。指定gpt-6.1-sol只读复核后按最新源码独立编译包10/10零skip，5输入SHA前后同、5编译入口与默认dist一致；原SHA漂移轮保留，未混用成绩。fixture清理、类型检查和文档检查通过，输出留本机 `output/acceptance-raw/m07-20261001-backup-*.log` | 文件持锁断言为受控测试，不证明三类生产会话已组合；小资源包fixture不等于完整确切发布包。固定系统PowerShell/.NET仅元数据检查，受信运维边界不等于对抗同OS写者隔离。本行只覆盖基础入口；备份组合与新目标隔离还原看下列行；本行没有新PG或Provider外呼、GUI或安装验收 |

## 条目 317

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| M07 PostgreSQL完整归档机制 | 已通过（源码/真实PG分片） | 2026-10-01 [归档入口](../../../apps/api/src/runtime/backup-postgres.ts)：指定gpt-6.1-sol自检单元7/7、真实PG3/3；根按原wrapper重新独立实跑3/3零skip。PG18实际regular stdout fd写wx custom归档；随机空目标库8张业务/Graph表JSON逐行一致，含checkpoint/blob/write。占用目标不覆盖、失锁拒绝、观察真实在途dump连接后Abort并等自己child退出，partial保留且原blocker仍活。类型检查、迁移/Graph/PG启停均0，临时根清理通过。输出留本机 `m07-20261001-backup-postgres-worker.log` 与 `backup-postgres-independent.log` | 固定标准migrator、本机PG18/sslmode=disable；子进程退出不代表PG backend即时消失，成功必须继续quiescent核对。不覆盖文件/ARMED隔离或产品恢复放行 |

## 条目 318

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| M07完整备份协调与历史未决身份 | 已通过（源码/Windows与PG组合范围） | 2026-10-01 [协调器](../../../apps/api/src/runtime/backup.ts)、[业务核对](../../../apps/api/src/runtime/backup-state.ts)及[CLI](../../../apps/api/src/cli/backup.ts)已组合三会话、原在途Owner、完整dump/清单和释放后complete。根最新组合7/7零skip：实际debug原生Job停止、内容/证据复制及空库归档核对；正文错配、未证明过期Worker、独立连接均拒；CLI在fence COMMIT后强杀无成功标记，原ACL显式恢复幂等、native父管道EOF释放。新增同名库替换/准入revision漂移在未修版2/2暴露错误成功，修后拒绝。人工关闭PARTIAL/NO_RECEIPT用真实Owner并保留UNKNOWN：子代理与根分别真实PG8/8，缺处置/stop proof或claim未释放仍拒；停止证明输入为fixture，真实Job覆盖由组合测试提供。最新全API217/217与关闭协议18/18零skip；指定gpt-6.1-sol按最终身份修正基准重新编译并独立组合7/7零skip，24输入SHA前后同、8关键生成入口默认/独占编译一致；旧5条基准不混。各PG已停止/清理；原失败轮与输出留本机 `output/acceptance-raw/m07-20261001-backup-*.log` | Windows当前登录会话、可信本机运维；小API资源fixture不等于确切发布包。源包二进制不复制，外部资源只留历史元数据，原UNKNOWN不盲清/重发；旧Assist核销ARMED后可能保守拒绝。本行通过不推进M07总出口ACCEPTED。新库/data_root隔离还原看下行；兼容/明确放行、确切新包与安装仍待实施 |

## 条目 319

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| M07恢复目标启动前隔离与包能力诊断 | 已通过（源码/真实Node入口与Rust分片） | 2026-10-01 [Node检查](../../../apps/api/src/runtime/restore-isolation.ts)与[原生检查](../../../apps/desktop/src-tauri/src/restore_isolation.rs)接入宿主启动/监督器重启及API/Worker。Node定向自检最终7/7，指定gpt-6.1-sol独占重新编译独立7/7；固定Node24的五实际子进程模式在DB连接/监听/ready/旧launch核销前拒绝，原ARMED及marker字节不变；空/坏JSON/伪造成功/目录/断开的junction均拒，路径检查错误保守拒。Rust自检7/7＋cargo check0，根独立定向7/7及全lib40/40；真实marker/root/祖先junction符合存在拒绝与无标记兼容，直接监督器入口无源ARMED消费、新启动目录或日志。API全单元最终224/224零skip，内容必要复验16/16；[包诊断](../../../scripts/test-desktop-package.test.mjs)自检与独立各2/2，PS构建脚本parse0，309源码/输入fingerprint前后相同。缺能力/旧能力、任一Node入口脱线、旧EXE或未绑定模块在更新hash后仍拒作目标包，历史包基础诊断保留。首轮夹具rmdir错误、检查放错函数及桌面stdin残留已在定向反例后修正；全API前两轮分别缺助手/误指旧target助手各216/224，Rust首次全库缺RELAY_TEST_NODE为39/40，均保留原输出并按确切工具重跑，不删检查。原始输出留本机 `output/acceptance-raw/m07-20261001-restore-isolation-*.log` | Windows原生dangling symlink因1314权限不可创建，明确未覆盖，真实junction已覆盖；非Windows只插入源码，未实跑。新发布包/GUI/安装未验；包测试是小fixture，通用诊断不代替恢复协调器全清单/兼容核对。标记不是在线停机或目标数据库隔离；创建marker、新空库CONNECT隔离及产品还原看下行，明确放行仍待实现，M07总出口未完成 |

## 条目 320

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| M07新空库与新数据根隔离还原 | 已通过（Windows/PG源码隔离组合范围） | 2026-10-01 [协调器](../../../apps/api/src/runtime/restore.ts)、[CLI](../../../apps/api/src/cli/restore.ts)、[严格清单](../../../apps/api/src/runtime/restore-backup.ts)与[文件入口](../../../apps/api/src/runtime/restore-files.ts)已实现；固定PG18完整归档、原/目标包分别绑定、原48迁移与Graph/历史定义核对，staging/ARMED只进evidence，关闭后仍保CONNECT撤销/根marker。目标专用隔离真实PG自检及根独立各22/22；PG还原自检及根独立各5/5，原fence兼容独立14/14；相关单元最终根复验48/48零skip、155680ms，类型检查通过；源根单元首轮45/48因Cargo helper硬链接被正确拒绝，夹具改为逐字/SHA及nlink=1绑定的发布包普通副本，未放宽生产规则。组合此前5/6：全表/正文/原UNKNOWN身份、篡改/非空/重hash元数据拒绝、实际CLI强杀通过；末段换向未成功注入，真实诊断为pin句柄未关时rename EPERM，夹具改到实际连接和原pin句柄都关闭后注入，完整6条根复验6/6零skip。原data_root内嵌目标真实PG反例曾错误成功，源根保护修复后单项1/1同时拒绝原路径和同卷搬迁，源目录/记录及目标ACL未变；指定gpt-6.1-sol按最终冻结源码独立完整组合7/7零skip、912409ms，包含最终源根保护，不沿用旧增量。独立前后317项源码/配置/lock与64项SQL/原生输入、10工具SHA无漂移，314个内存重编译JS与默认dist逐字一致、类型诊断0；源码集合SHA `d68e4b279cba9493991abe8129d79e2c18d702bdf1a94d7cfe45c8995683a248`。各私有PG停止并清理，实际工具尾/exit及前后基准见本机 `output/acceptance-raw/m07-20261001-restore-independent.log`，注明非全量native stdout。失败输出留本机，不拼成整轮通过；规格见[测试计划](../verification-plan/part-01.md#7-windows-桌面交付验证) | 当前Windows/PG18源码与小API资源fixture，未重打完整新包/GUI/安装。历史File ID仅用于保守拒绝，源根删除重建或跨卷复制后仍须运维确认选址。可信本机运维与路径前后检查不等于对抗同OS写者隔离；PG18前导SQL重置超时初值，取消后backend可能继续等锁，失败保持隔离、不给verified、不盲重试。明确放行/配置切换、历史及外部身份核对、还原元数据后续生命周期和M07总出口仍待闭合；两处独占编译输出清理被自动审批拒绝，已停止删除，PG清理不受影响 |

