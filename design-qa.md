# 工作台视觉纠偏与复验 · 2026-09-30

当前结论：已实施共享与逐页纠偏，以下已测浏览器范围通过。完整特殊状态矩阵、真实 Windows/IME/DPI 与用户视觉接受仍未由本报告证明。

## 下午整套页面纠偏

用户指出“可能所有页面都有偏差”后，本轮把范围扩大到共享字体、品牌、侧栏、普通页、三工作台、任务、运行和知识，而非沿用下方 12:25 协作页的局部通过结论。协作页继续以选定方向 1「对话主轴 · 双页工作桌」为主真值，其余页面以现有 2026-09-19 图集核对暖纸、墨绿、宋体标题、白纸正文、细线和层级。图中未确认的字体名、尚未提供的数据与未接入能力不作为实现事实。

- 自托管完整 Noto Sans SC / Noto Serif SC 可变 WOFF2，消除不同机器系统回退造成的字形与换行漂移；两个文件约 18.8 MB，来源、版权、版本、原始与转换哈希见[来源记录](apps/workbench/src/assets/fonts/provenance.json)。完整 OFL 与两份版权声明同时进入 [public 分发许可](apps/workbench/public/licenses/NOTO-FONTS-LICENSE.txt)。没有新增运行依赖或第二套 token。
- 普通主标题 48px、窄窗 32px，今日继续保留用户选定的 32px。品牌与导航恢复视觉层级，默认侧栏 216px，既有用户调宽仍有效；修正未定义 space.5 和 row-title 引用。20 个 CSS 的 97 个变量引用均可映射到 131 项唯一 token（动态用户侧栏宽度例外）。
- 任务列表标题铺满工作区；任务详情的事实并列、右侧编辑动作纵向铺满；运行页信息与步骤用留白和细线分组。知识阅读为目录、正文、来源三列，确切 v2/v3 标题与正文匹配；三工作台、知识空搜索和项目连接的工作台设置默认收起，保留所有草稿、原命令、筛选、来源、编辑与权限入口。已应用活动范围自动展开，避免深链作用域藏在折叠区。
- 协作讨论正文实际使用 reading 字号/行高，纸面与判断合为阅读桌。判断说明按需展开，确切对象身份常驻；空说明请求修改会展开提示且零 POST。判断区约 250px，正文获得约 463px；1440×640 大量证据展开后可在判断区滚动到操作。390px 共用顶栏保留当前面包屑、搜索、收件箱与具名来源按钮，无横向溢出。
- 最后补查修正人工待处理及非协作 Assist 缺少页面内边距、窄窗刷新按钮被压成竖排的问题，复用现有 page-primary。AppShell 补齐总览/Assist 标签，并与项目及任务页面实际技能路由对齐，避免内容为 Assist 而顶栏显示蓝图或定义。

## 当前截图与交互覆盖

[主要页面缩略总览](docs/testing/evidence/frontend-visual-correction-20260930/page-overview.png)、[协作参考与最终实装](docs/testing/evidence/frontend-visual-correction-20260930/collaboration-reference-final.png)、[45 张原图尺寸/哈希与末轮 DOM 观察](docs/testing/evidence/frontend-visual-correction-20260930/final-page-metadata.json)为本轮证据。截图是 IAB 原始 `tab.screenshot({fullPage:false})`；文件名中的尺寸指 CSS 视口，部分有滚动页的输出图像是 1477×1003，不将输出像素冒充 CSS 像素。末轮文件只收录可对应的 25 项 DOM 观察，较早观察保留在[原始归档](docs/testing/evidence/raw-output-20260930.zip#entry=docs%2Ftesting%2Fevidence%2Ffrontend-visual-correction-20260930%2Fpages.json)。缩略总览仅用于扫描；协作并排图两侧均为 1487×1010 内容像素，参考只裁去 48px 宿主标题栏，没有缩放来伪装匹配。

| 范围 | 已测内容与边界 |
| --- | --- |
| 今日、项目列表/总览、任务列表/详情 | 正常数据、事实层级、编辑/范围入口、无根横向溢出；新建项目与任务表单只打开、取消，未提交 |
| 通用、论文、开发工作台 | 三种布局、配置折叠、状态/下一步/成果与未接入工具说明；关闭配置仍保持挂载 |
| 知识与项目资料 | 阅读当前 v3、切历史 v2、目录定位、来源、搜索/列表/管理入口；项目记忆、决定、规则为空范围，未伪造内容 |
| 协作 | 1487×1010、960×640、390×844；讨论/文档/检查/历史/工具切换与草稿保持；另测 1440×640 展开证据后判断按钮可达；已清自建草稿 |
| 活动、待审、连接、设置与搜索面板 | 默认与带 Task 范围深链、实际过滤值可见、正常判断身份、真实禁用原因、Ctrl+K 打开/关闭 |
| 任务产物、定义、检查与运行 | 阅读与原入口；Trace/CheckPlan/来源 Manifest 缺夹具时正确局部报错；Run SSE 重连未据此算流式成功 |
| 收件箱、项目任务、项目连接、蓝图与接续 | 补查常规入口；收件箱为合法空集合、蓝图无已保存提案、接续点为空；没有制造完成凭据或特殊终态 |
| 人工待处理、独立 Assist 与来源谱系 | 待处理有 Review/Task 项；项目 Assist 为空会话、任务 Assist 有三条保存消息；1487px 常规入口与项目 Assist/待处理 390px 无根溢出。来源元数据可读，缺失来源 Manifest 仍局部报错；未创建会话或发送消息 |

数据来自独立 loopback 4174 前端与 8796 只读同构夹具，GET/OPTIONS、POST405，无数据库或 Provider。产品现有连接提示只是客户端模式；不是这些夹具拥有真实 PG。夹具之前忽略 inbox 查询及版本 fallback 覆盖 lineage 已修正，Task/Run 归属核对后复采正常页；保留前端的范围拒绝与权限保护。

尚未在本轮单独采集完整正常内容或专用流程：全局记忆/决定/规则的有数据详情、完成凭据、人工冲突、委托确认、PENDING、PAUSED、UNKNOWN、动作批准、Task DONE，以及真实 Provider 故障流。状态单测或旧 33 图集不能替代本轮这些视觉证据。

## 本轮实际检查

- 最近一次全量 Workbench：63 文件 **412/412**，[日志](docs/testing/evidence/raw-output-20260930.zip#entry=docs%2Ftesting%2Fevidence%2Ffrontend-visual-correction-20260930%2Fworkbench-tests-last.log)。其后 Connections/ViewConfiguration 折叠增量 [16/16](docs/testing/evidence/raw-output-20260930.zip#entry=docs%2Ftesting%2Fevidence%2Ffrontend-visual-correction-20260930%2Fconnections-final.log)、辅助页间距的受影响回归 [45/45](docs/testing/evidence/raw-output-20260930.zip#entry=final-visual-20260930%2Fdocs%2Ftesting%2Fevidence%2Ffrontend-visual-correction-20260930%2Fsecondary-padding-final.log)、最终路由标签及任务详情 [29/29](docs/testing/evidence/raw-output-20260930.zip#entry=final-visual-20260930%2Fdocs%2Ftesting%2Fevidence%2Ffrontend-visual-correction-20260930%2Fbreadcrumb-final.log)通过；没有把最后增量称为已重跑全量。面包屑三项反例先[3 failed / 8 passed](docs/testing/evidence/raw-output-20260930.zip#entry=final-visual-20260930%2Fdocs%2Ftesting%2Fevidence%2Ffrontend-visual-correction-20260930%2Fbreadcrumb-red.log)，修复后同检查通过，未删除断言。
- 活动范围先[红灯](docs/testing/evidence/raw-output-20260930.zip#entry=docs%2Ftesting%2Fevidence%2Ffrontend-visual-correction-20260930%2Factivity-scope-red.log)，修复后的活动/任务定向 [25/25](docs/testing/evidence/raw-output-20260930.zip#entry=docs%2Ftesting%2Fevidence%2Ffrontend-visual-correction-20260930%2Flast-correction-tests-final.log)。先前完整 408/410 的旧标题/文案断言及一次错误修复的失败日志均保留，未删检查。
- 前端类型、生产构建与桌面目录测试包由[最终构建日志](docs/testing/evidence/raw-output-20260930.zip#entry=final-visual-20260930%2Fdocs%2Ftesting%2Fevidence%2Ffrontend-visual-correction-20260930%2Fdesktop-build-final.log)、[包审计](docs/testing/evidence/frontend-visual-correction-20260930/desktop-package-audit.json)绑定；最终清单发布前再次核对输入指纹，源码变动会拒绝发布，不能把旧 EXE 绑定新源码。包校验器 1/1 反例、冻结生产依赖与完整字体许可检查保留在同目录。
- 文档、原始截图尺寸/哈希和逐页元数据见同目录证据。设计系统、工作台交互、已有开发记录、部署说明与唯一阶段主文档同步；没有新增需求、业务架构、ADR、API、数据库或第二份进度文档。

## 12:25 协作页历史复验

下方保留当时范围、旧截图和回归结论。其“最新”“本轮”与 passed 均指 12:25 时点，不代表下午扩大范围后的最终源码、字体或发布包。

历史 final result: passed

本报告限定为已选方向 1「对话主轴 · 双页工作桌」的浏览器视觉与相关前端恢复自检；不是 Windows 宿主、真实 Provider、真实数据库业务或整体 M 阶段验收。最新复验：2026-09-30 12:25（UTC+08:00），下述 final-* 证据来自本轮修改之后。独立验收与最终生产构建由协调 Agent 另行记录。

## 比较依据与状态

- 主视觉真值：[完整窗口参考](docs/frontend/mockups/2026-09-29/collaboration-dialogue-window.png)。相关状态：[对话状态](docs/frontend/mockups/2026-09-29/collaboration-dialogue-selected.png)、[工具状态](docs/frontend/mockups/2026-09-29/collaboration-development-tools.png)。三图均实际打开查看；没有重新设计或生成新方向。
- 主参考原始 1487×1058；裁去上方 48px 原生宿主标题栏，内容为 1487×1010。不在浏览器画最小化、最大化或关闭按钮。
- 实现：`http://127.0.0.1:4174/agent?work=33333333-3333-4333-8333-333333333333`，in-app browser 原始 `tab.screenshot({fullPage:false})`，1487×1010 CSS px / 1487×1010 图像，DPR 约 1（运行值 1.0000000149）。没有缩放截图来伪装相同视口。
- 数据来自独立只读同构夹具 `http://127.0.0.1:8794`，复用 `collab-visual-fixtures.mjs`，只绑定 loopback，GET/OPTIONS，POST 返回 405；不连数据库或 Provider。产品显示「已连接本机 API」是既有客户端连接状态，此记录明确区分夹具与真实业务。
- 状态：同一 Task、已保存 v2 正文、三条讨论、一条 OPEN CRITERION Review。Review 的绑定版本使用真实 `target.artifact_version_id`，不以阅读区 latest 代替。参考的「接受 v2」是概念文案；实现维持契约的「接受这项判断」与真实 UUID、验收修订、条件 ID。
- 工具图是另一项开发任务的概念Git diff状态；实际只读夹具沿用当前论文Task，Git接口未接入。两者不是相同任务内容和能力状态，因此工具并排图只核对入口、右栏替换和声明边界，不用缺失diff、全宽概念输出区或代码密度作逐像素通过结论。真正工具能力与输出布局需要后续真实接入单独验收。
- before 保留原布局和当时消息流向末尾的滚动位置；after 保留第三条讨论可见的末尾位置。它们不是对话滚动位置逐像素差异测量。

## 对照证据

- 历史：[before](docs/testing/evidence/frontend-visual-fidelity-20260930/before-1487x1010.jpg)、[第一轮](docs/testing/evidence/frontend-visual-fidelity-20260930/iteration-1-1487x1010.jpg)、[上一轮 after](docs/testing/evidence/frontend-visual-fidelity-20260930/after-1487x1010.jpg)。最新实现：[最终桌面截图](docs/testing/evidence/frontend-visual-fidelity-20260930/final-dialogue-1487x1010.jpg)。
- [最新全视图同输入对照](docs/testing/evidence/frontend-visual-fidelity-20260930/comparison-final-full.png)：Reference / Final，同为1487×1010内容像素。
- [最新局部同输入对照](docs/testing/evidence/frontend-visual-fidelity-20260930/comparison-final-focused.png)：目标与事实条、文档正文、判断区域；字重、换行、绑定身份和按钮均可辨认。
- [最新工具对照](docs/testing/evidence/frontend-visual-fidelity-20260930/comparison-final-tools.png)与[最终工具截图](docs/testing/evidence/frontend-visual-fidelity-20260930/final-tools-1487x1010.jpg)：相关概念图与真实能力受限状态，明确不把概念Git diff当成已接入功能。旧`comparison-tools.png`仅保留迭代历史。
- [最新视口与排版元数据](docs/testing/evidence/frontend-visual-fidelity-20260930/final-viewport-metrics.json)、[最新控制台](docs/testing/evidence/frontend-visual-fidelity-20260930/final-console.json)。本轮组合脚本为同目录 `compose-final-comparison.py`，仅裁剪、并排分析，不改原截图内容。最新完整与局部图均实际打开后判断。历史组合仍由 `compose-comparison.py` 保存，不把历史截图重新标为最终证据。

## 发现与修复历史

| 轮次 | 发现、影响 | 修复及复验 |
| --- | --- | --- |
| 初始 blocked | P1：目标跨中右栏，文档标题降到约 327px；24px 主标题层级弱，版本列表将正文推到约 757px。P2：讨论继承卡片与表单间距，首屏少一条讨论；近期工作选中整圈边框密度偏重。 | 目标归中栏，右栏独立从顶部开始；主标题采用现有 48px token；版本列表与比较进可发现 details；讨论去掉重复卡片与继承 margin；近期工作改窄左线选中并复用图标。第一轮截图验证正文起点上移。 |
| 第一轮 blocked | P2：事实条与辅助工具仍占约 100px，第三条讨论出屏，判断按钮在首屏下方。 | 缩短事实辅助说明；模型、执行控制、发送选项与版本详细信息可展开；正文独立滚动，判断主要入口常驻；完成检查另列明确 details。保留说明、禁用原因与真实权限。 |
| 第二轮 blocked | P2：390px 面包屑换行把常驻输入推到屏外。P1：Review 正常态永久禁用；切换 CHECK/HISTORY/工具会丢失反馈及响应丢失的原命令；刷新旧请求存在可提交窗口。 | 窄窗 topbar 仅协作页收拢；修复基于 `reviews.length > 0` 的无条件 fallback，增加当前 Task/Project/Review 归属与读取检查；成功读取清旧错误；review request epoch 控制 loading；DOCUMENT 子树常挂载、非当前视图显式 hidden。反例先红后绿。 |
| 上一轮身份补充 | 复核决定必需身份不能全部折叠。 | compact 常驻 `reviewSummary(review)`、验收修订/条件 ID，以及动作类型/实际目标；hash 和完整元数据仍可展开。收紧紧凑区重复 margin 与标签行，不删表单。上一轮判断区高约 317px，接受按钮底部约 904px < 1010px。 |
| 本轮 blocked | P2：进行中标签紧贴目标标题，参考在项目行，改变标题层级；P2：项目/事实条/文档名的光学字重偏弱，扫描层级不清；P2：判断区整块浅绿与常驻UUID抢占主位，参考为浅绿标题带和白正文。 | 仅移动原状态文字到项目上下文行；用现有 primary、semibold token强化项目名、事实条及文档名；浅绿仅留判断标题带，正文改surface，完整UUID仍常驻并使用code字体/secondary色作为元数据。没有更改Task状态、Review目标、hooks、命令或token值。 |
| 本轮 final passed | 最新全图与局部对比已重看，无待修P0/P1/P2。 | `final-dialogue-1487x1010.jpg`及`comparison-final-{full,focused}.png`为修改后证据。接受按钮底部903.6px，常驻版本UUID/验收2/条件c1可读；960与390长文滚动后按钮底部分别541.6px与724.0px，均在视口内。 |

## 五项视觉表面

- **字体与排版**：主标题48px/60px、字重600，正文主标题32px/40px，文档UI标题24px/600，阅读正文18px/27px，均使用已有UI/editorial/code字体token。本轮项目名20px/600、事实条16px/600已实测，详见最新元数据。参考标题墨色更重，字体文件不可确认；保留既定本机回退与tokens，剩余字形、合成字重、抗锯齿差异列P3，不猜测新字体或下载依赖。状态已回项目行。
- **间距与布局**：中右分界约878px，参考约881px；三列工作桌、白纸正文、浅绿判断标题带及白正文、底部输入形成同一层级。桌面正文独立滚动，判断常驻。960px单区页签、390px抽屉导航与单区切换可返回讨论；正文和判断可滚动到末端，根scrollWidth分别为960/390。判断区仍比概念图高，是保留确切身份、请求修改说明和权限语义的有意约束，不以图覆盖契约。底部常驻按钮未被长文遮挡。
- **颜色与 token**：复用 paper/sidebar/surface、forest action、sage selection、separator/control 边框及现有 radius/space token。无第二套 token、无新依赖。暖底、白纸、低饱和绿与参考保持方向一致；生成图局部渐变及截图渲染色差不作为精确采样真值。
- **图像与资产**：界面使用真实 React 内容和已有 Lucide 图标库；没有静态图替代 UI、假原生标题栏或手绘品牌图片。Workflow OS 是已有示例文字品牌，参考也为文字。常规文档、时钟、用户、判断图标采用既有库；不存在需要新增的照片或插画资产。
- **文字与内容**：修正不确定概念文案到真实 API 事实；Review 不等于暂停/执行权转移，动作批准不代表已执行，latest/selected/accepted 不互相继承。附件、@ 引用、Git 与交互终端未接入仍明确表达。参考的消息附件卡没有可证明的服务端消息附件关系，因此未伪造。既有更多导航仍保留，未为截图删除业务入口。

## 实际交互与回归

- 浏览器：讨论/文档/检查/版本历史/工具切换；窄窗讨论草稿保留；有草稿换工作出现原保护对话；工具显示真实「未接入」边界；正文与判断滚动可达。
- 本轮重新验证文档→检查→版本历史→文档，说明草稿保留（实际AX回读输入仍为“视觉验收草稿：补充计算口径。”），随后清空测试草稿；版本历史下拉列出v2/v1；文件→变更及工具展开/收起成功。未向只读夹具提交任何业务写命令。
- 最新960×640：[讨论](docs/testing/evidence/frontend-visual-fidelity-20260930/final-discussion-960x640.jpg)、[文档起点](docs/testing/evidence/frontend-visual-fidelity-20260930/final-document-960x640.jpg)、[长文末端判断](docs/testing/evidence/frontend-visual-fidelity-20260930/final-judgment-960x640.jpg)、[工具](docs/testing/evidence/frontend-visual-fidelity-20260930/final-tools-960x640.jpg)。文档区滚动796px后接受按钮在500–541.6px，目标和事实条仍可见。
- 最新390×844：[讨论](docs/testing/evidence/frontend-visual-fidelity-20260930/final-discussion-390x844.jpg)、[长文末端判断](docs/testing/evidence/frontend-visual-fidelity-20260930/final-judgment-390x844.jpg)、[文件工具](docs/testing/evidence/frontend-visual-fidelity-20260930/final-tools-390x844.jpg)。根scrollWidth=390，长文滚动后接受按钮在682.4–724.0px，可达；输入及发送按钮保持在窗口内。窄窗没有独立已选效果图，按第14节和断点规则作韧性验证，不声称窄窗逐像素还原。
- [项目页](docs/testing/evidence/frontend-visual-fidelity-20260930/project-regression-1487x1010.jpg)、[项目内独立 Assist 技能页](docs/testing/evidence/frontend-visual-fidelity-20260930/standalone-assist-regression-1487x1010.jpg)：无 `.collab-page`，品牌仍为原 18px，协作页 AppShell/CSS 未外泄；Assist 空会话保持原创建入口。
- Review 业务反例：[最初禁用红灯](docs/testing/evidence/raw-output-20260930.zip#entry=docs%2Ftesting%2Fevidence%2Ffrontend-visual-fidelity-20260930%2Freview-red.log)；[恢复红灯](docs/testing/evidence/raw-output-20260930.zip#entry=docs%2Ftesting%2Fevidence%2Ffrontend-visual-fidelity-20260930%2Freview-recovery-red.log)（2 failed / 7 passed）；[修复绿灯](docs/testing/evidence/raw-output-20260930.zip#entry=docs%2Ftesting%2Fevidence%2Ffrontend-visual-fidelity-20260930%2Freview-green.log)（9 passed）。后续增加常驻动作绑定字段检查，最终回归见下一项。
- 定向：`collaborationWorkspace.spec.ts` 23 + `modelConnectionStrip.spec.ts` 4 + `reviews.spec.ts` 11 = **38/38 passed**，[完整日志](docs/testing/evidence/raw-output-20260930.zip#entry=docs%2Ftesting%2Fevidence%2Ffrontend-visual-fidelity-20260930%2Ftargeted-tests.log)。正常匹配/合法 null Project 可决定；归档、读取失败、Task/Project 不匹配与挂起刷新零新 POST；原接口原 revision/targetHash 提交；切换视图保留反馈及原 command_id，响应丢失后只查询一次原回执、零第二 POST。
- 前轮类型：Node24.21.0执行 `node_modules/typescript/bin/tsc --noEmit`，exit0。本轮最小呈现修改后的全量/类型/生产构建由协调Agent独立复验，本报告不抢写dist或沿用前轮结果声称新构建通过。
- 协调侧最终独立复验：[63文件407/407](docs/testing/evidence/raw-output-20260930.zip#entry=docs%2Ftesting%2Fevidence%2Ffrontend-visual-fidelity-20260930%2Fworkbench-final-bounded-independent.log)（maxWorkers=2）及[类型/生产构建](docs/testing/evidence/raw-output-20260930.zip#entry=docs%2Ftesting%2Fevidence%2Ffrontend-visual-fidelity-20260930%2Fworkbench-final-build-independent.log)通过；默认高并发两个既有时序断言失败、同源码19/19定向通过均保留在[接续记录](docs/development/ui-live-integration-2026-09-28.md#13-协作页参考图接续与-review-修复2026-09-30)。未删检查或放宽断言。另以IAB1487×1010重看最终全图/局部组合，核对判断可用、常驻绑定及检查→文档后讨论/反馈草稿保留；只读夹具零写命令、warn/error为零。
- 最终新验证 Tab 的 warn/error logs 为 **0**（`[]`）。旧 Tab 的历史告警不据此删除或混算；父代理修复嵌套 li 后重新采集。浏览器未点击 Review 写按钮，实际原命令写入由前端 mock 单测核验；只读夹具拒写。

## 文档影响与交付检查

- 本次没有 API/数据库/架构/依赖变化；没有新增 ADR 或第二份 token 文档。
- [文档检查日志](docs/testing/evidence/raw-output-20260930.zip#entry=docs%2Ftesting%2Fevidence%2Ffrontend-visual-fidelity-20260930%2Ffinal-docs-check.log)：`node scripts/check-docs.mjs`通过（Markdown107、链接1889、标题锚点1400、token131、对比度29）。[本轮源码与主截图SHA256](docs/testing/evidence/raw-output-20260930.zip#entry=docs%2Ftesting%2Fevidence%2Ffrontend-visual-fidelity-20260930%2Ffinal-source-hashes.json)限定证据对象。
- 视觉事实、Review 业务根因和测试由协调 Agent并入已有 workbench-design、开发与验收记录；唯一阶段进度仍是 CODEX_NEXT_STEP。
- 本轮呈现源码于2026-09-30 12:25（UTC+08:00）冻结；主视觉及上述浏览器交互无未处理P0/P1/P2。P3：参考与本机字体光学差异、390px工具末页签边界约0.4px的亚像素舍入（文字与按钮不遮挡）。参考消息附件和Git diff缺真实接口关系，属于已明示能力差异，不以假控件追求截图相似。
- 保留 4174 前端预览、8794 只读夹具与已标记 deliverable 的 IAB 验证页。Windows 标题栏/缩放/安装、真实业务端到端和整体 M 验收仍由相应验收流程完成，不由本报告替代。
