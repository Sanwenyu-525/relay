# 功能验收详细记录：分册 06

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../overall-acceptance-details-20261025.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

## 条目 097

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 聊天阅读列与输入器同轴（2026-10-19 深夜，用户截图「这两个 ai 好像没有对齐」→「左边跟输入框的左边对齐就好了」） | **已通过（真实 Chromium 实测，A/B 各跑一次）** | 先证伪：截图像素里两处 `AI` 墨迹都在 x=43–57、逐像素相同，真实 Chromium 里两条消息头的 `left` 也相同，「两条 AI 没对齐」不成立；真正的偏差在消息列与输入器之间。**根因**：消息列在 `.agent-chat-transcript` 里居中，该滚动容器的 `scrollbar-gutter: stable` 把自绘滚动条（12px）算进 padding box 的 inline-end，content box 右侧少 12px，消息列因此整体左偏 6px；输入器不在滚动容器里，没有这 12px。**修法**：起边补回一整个滚动条宽度（`padding-inline: calc(var(--chat-timeline-gutter) + var(--chat-scrollbar-width)) var(--chat-timeline-gutter)`），滚动条厚度收成 `--chat-scrollbar-width`，与 `::-webkit-scrollbar` 同一处维护。**证据**：新增 `tests/browser/chatReadingColumn.spec.ts` **2/2**（宽档中线与左右缘 ≤1px、窄档左缘 ≤1px）；把该行退回旧写法后宽档用例红（`Received: 6`）、窄档仍绿，改回后 2/2；1440 宽实测消息列 `495.19 → 501.19`，与输入卡 `501.19` 重合（左右缘均 0.00px）；`chatTimelineNavigation`＋`narrowWindowNewConversation` **17/17** 未回归。规则归[工作台 §18.6](../../frontend/workbench-design/part-06.md#186-页面原型结构对齐2026-10-03) | 阅读列落在 768–832px 那一段时仍有 8px（消息列满宽、输入卡按 measure 居中，卡比列宽 16px 对称外伸），属「卡宽于列」的另一条规则，本轮未改；`uiOption2FirstSession.spec.ts` 的「同宽」用例只比 `max-width` 字符串且该套件当前被并行会话拖红（夹具在 `assist-copy-a-0` 超时），故断言另立一处；真实 Windows/WebView2 窗口与多 DPI 未目视；未做独立验收；未 commit/push |

## 条目 098

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 连接与权限沿用复制 `CopyGatewaySettings`（2026-10-19，后端） | **实施者自检通过** | 按用户授权「按照你的来」（方案 C：复制，不动 `project_id NOT NULL`）：新增 `copyGatewaySettingsCommand`（`apps/api/src/application/gateway-commands.ts`，资源按 identity 判重、连接按 config+能力判重、策略只复制 ACTIVE 当前生效版本并按 capability+action+target 判重；advisory 锁 7162,9 与回执同事务）＋ `POST /projects/:project_id/gateway-settings/copy`（`gateway-api.ts`，`envelope.ts` 登记 201）＋ 契约 [HTTP §10.101](../../api/http-command-contract/part-07.md#10101-连接与权限沿用复制2026-10-19-后端实现) ＋ 前端提示词 [prompts/gateway-settings-copy-frontend.md](../../../prompts/gateway-settings-copy-frontend.md)。证据：`run-integration.ps1 -TestFile gateway-settings-copy` **status PASSED，4/4**（复制落库、判重、同 command_id 原样重放、只复制 ACTIVE、来源=目标与跨 Workspace 拒绝；真实临时 PG 18.6）；API `tsc --noEmit` exit 0 | 前端入口未实施（按提示词另轮做）；未做独立验收；未 commit/push |

## 条目 099

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 会话模式下拉的浮层与选中态收进设计系统（2026-10-19 深夜，用户截图指令「优化一下这个下拉框，还有这个下拉按钮的选中态」） | **已通过（真实 Chromium 实测 + jsdom）** | 改前浮层由系统绘制：硬灰带、无圆角无阴影、脱离 tokens；焦点环只框住档名、把箭头留在环外；chip 比同排控件高 8px（全局 `:where(select)` 的 `control.height` 40px 从未被覆写）；换档时 chip 变宽会推动同排右侧控件。改后走仓内既有 `appearance: base-select` 配方，与顶栏会话下拉共用同一段 `::picker(select)` 与三档 `option` 规则（零新增 token、零新增色值）；hover／`:open`／`:focus-visible` 三档经 `:has()` 写在包裹的 label 上，焦点环包住「档名＋箭头」，展开时箭头转 180°；`min-width: 5rem` 压在文字盒上（不是 chip 上），切档不再推挤同排；`min-height: 0` 让 chip 回到 32px 与同排等高。同日接续：用户再次截图指认「agent 这个文字被挤了」——首版把定宽下限 `6rem` 压在 label 上，箭头与内边距先吃掉 26px，「普通 Agent」文字实测 69.86px 只剩 0.14px 余量；改为下限压在 select 自身（`5rem`＝文字 + 10px 余量），chip 内文字与箭头间距由 `space.0.5`(2px) 提到与同排 `.agent-chat-tool` 同档的 `space.1`(4px)，实测三档恒为 108px、四视口仍单行。规则归[工作台 §25.1](../../frontend/workbench-design/part-08.md#251-控件层级)，键序契约校正归[设计系统 §9.13](../../frontend/design-system/part-05.md#913-会话视图顶栏密度2026-10-16)。**行为变化（唯一一处）**：`base-select` 下方向键不再直接换档，改为「方向键开浮层 → 浮层内移高亮 → Enter 提交，Escape 收起不提交」，首字母 typeahead 同时失去；判定为可接受——换档等于切到另一会话，不该被一次误按换掉，因此不写 JS 键盘垫片，用例键序断言已按此更新。**实际验证**：`uiOption2FirstSession.spec.ts` 的目标用例（843×782／1162×782／2048×1104／843×600 四视口的单行、无重叠、chip 与发送键等高）由红转绿；`assistantModeSwitch.spec.ts` 47/47；一次性 Playwright 探针实测三档 chip 恒为 108px、文字未被截断（`scrollWidth` 等于盒宽，「普通 Agent」余量 10px），并取证焦点环、hover 底、展开态、贴底向上翻与禁用态五张截图（留本机 `apps/workbench/results/`）；`check-docs` exit0。同轮修掉一条既有失效断言：`assist-first-blocked` 于 2026-10-16 移出输入卡后，原「`blockedBottom ≤ toolsBottom`」结构上不可能成立，此前一直被上面那条 8px 红灯挡着没执行到，改为仍要保的那条「说明不落进卡内」，未删检查。 | 该 spec 其余 16 条红灯**非本改动引起**：共用夹具辅助函数在 `assist-copy-a-0` 上超时，而该 testid 在 HEAD 与工作树都不存在（`AssistView.tsx:2362` 实际渲染 `assist-copy-${message.id}`），即伪造回执的助手消息从未落到 `COMPLETED`，归并行会话在改的发送链路，本轮只报不修。未做真实 Windows 窗口与多 DPI 目视（探针是 headless Chromium）；`::selectedcontent` 在 Chromium 153 仍不存在，长档名沿用整字截断、无省略号字形（既有保留项）。 |

## 条目 100

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 工具行左端两枚事实与浮层只浮出内容（2026-10-19 深夜接续，用户「模型下拉按钮放到输入框左边，再左边是上下文圆圈；普通讨论是干嘛的，点击之后 ui 还会消失，关闭菜单之后 ui 又出来了」） | **已通过（真实 Chromium 实测 + jsdom）** | ①**顺序**：上下文计量环移到工具行最左、模型下拉紧随其后，其余入口整体右移一档，两个输入器一致；放在「+」左侧（不是行尾）是为保住 2026-10-18 的两条邻接（「+」紧邻写档位、「资料」仍在「普通讨论」右侧）。§32.10 那句「模型 → 资料 → 用量」就此作废，其余（常驻不收回 `[…]`、发送键 `margin-left:auto` 顶右端）不变；`.agent-chat-composer-tools > .model-selector{min-width:0}` 是子项选择器，换行行为未变。②**芯片不再消失**：根因是绝对定位写在 `.agent-chat-options[open]` 上，整个 `<details>`（含唯一在流内的 `<summary>`）一起离开 flex 行；改为只浮出内容——首条档位说明、`sourcePicker`、`sendOptionsFields` 三处各包一层 `.agent-chat-options-panel`，规则挂 `[open] > .agent-chat-options-panel`。契约：入口芯片常驻行内，展开的只有面板。实测 1162×782：芯片上/下沿 724／756 与工具行 724－756 重合，面板仍与输入卡同宽（742px＝`--chat-measure` 上限）向上弹出、限高内部滚动不变。开合、Escape、焦点回 summary、`aria-expanded` 全部不动，零新增 token。规则归[工作台 §32.13](../../frontend/workbench-design/part-11.md#3213-工具行左端两枚事实与浮层只浮出内容2026-10-19-深夜接续)。**实际验证**：`composerSourcePanel.spec.ts` 新增 3b 常驻不变式并做 A/B——把选择器挂回 `[open]` 后该条在 spec:233 转红，恢复后 5/5 绿；同批 `composerSourcePanel`／`modelSelectorDropdown`／`conversationToolbarDensity`／`responsiveFoldGeometry` **28/28**、`composerDraftAssist`（浏览器）**3/3**、`assistantModeSwitch`＋`newConversationEntry`＋`composerDraftAssist.tsx`＋`modelSelector` **82/82**（该批早于下面两条常驻锁）、顺序两条另由 `composerSourcePanel.spec.ts` **3c**（会话输入器 `toolOrder` 前两位「计量环→模型」、资料仍在「普通讨论」右侧）与 `assistantModeSwitch.spec.ts` **48/48**（首条输入器同一组文档序事实）常驻锁住；首条输入器另用一次性探针对着本机 dev server（`127.0.0.1:5173`）在真实 Chromium 里确认行序为 `○ 模型 ＋ 未开放写入 普通 Agent 润色 普通讨论 资料 0`、展开「普通讨论」时芯片仍与工具行重合（724／756，面板 563－639、宽 742），截图 `apps/workbench/results/probe-first-row-open.png`，脚本用后已删；`tsc --noEmit` 通过、`check-docs` exit0。 | 未做真实 Windows/WebView2 与多 DPI 目视（探针为 headless Chromium）；未做独立验收。用户实机窗口的返图仍是改动前的行序，经核对：该窗口为 `apps/desktop/src-tauri/target/debug/relay-desktop.exe`，devUrl 就是已服务新模块的 `127.0.0.1:5173`（`curl` 取回的模块已含 `agent-chat-options-panel`），故判为 WebView2 模块图陈旧，需窗口内 Ctrl+R；重载后的目视仍未复验。**同批红灯已定位，均非本轮**：`collaborationWorkspace.spec.ts` 5 条中 4 条（轨迹×3、执行摘要×1）是新解析器把 `file_changes` 变成必填（`apps/workbench/src/api/parse/assist.ts:553`）而该 spec 的 `toolCalls` 夹具没带这个字段，页面因此报「Run tool call.file_changes 响应格式无效」；第 5 条（Escape 用例取 `#assist-source-query`）在 HEAD 上同样红——`.agent-chat-options` 的首个匹配是「普通讨论」那枚 details，检索框不在其内，HEAD 与工作树的渲染顺序一致（send-options 都在 sources 之前），属 2026-10-18 拆分遗留。`uiOption2FirstSession.spec.ts:218/:266` 停在发送环节：页面 alert 显示请求 `/assist-sessions/:id/working-directory` 被夹具 404，来自新增的 `adoptCreatedSession` 读回链（HEAD 无此函数），该 spec 路由未同步；`:296` 绿。以上归并行会话，本轮只报不修。 |

## 条目 101

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 工具行右端一组：上下文与模型下拉移到发送键左边（2026-10-20，用户「上下文和模型下拉按钮整体移动到发送按钮的左边，用 tasteskill 优化一下这一行所有按钮」） | **实施者自检通过（真实 Chromium + jsdom）** | ①**顺序**：上下文计量环与模型下拉整体移到发送键左边，两个输入器一致，新顺序 `＋ [权限] [模式 ▾] [润色] [普通讨论 ▾] [资料 N] 〔计量环 · 模型〕 → 发送`；§32.13「计量环最左」按本条作废，其余邻接（「+」紧邻写档位、「资料」在「普通讨论」右侧）不变。②**收成一组**：新容器 `.agent-chat-composer-tail`（inline-flex、组内 4px 节距、`flex:0 1 auto; min-width:0`）紧跟工具行、贴发送键左侧——组内沿用工具行自己的节距，窄栏换行时与发送键同处一行不拆开，长模型名由触发器省略号收尾不顶出卡片。③**下拉锚点改右缘**：行右端后 `left:0` 的 22rem 清单会越出卡片右缘与视口，改 `left:auto; right:0` 向左展开。④**一行按钮逐项复核**：所有控件同高 32px（`control.height.compact`）垂直中线对齐，图标控件 32×32 方键，hover／展开／禁用／焦点四档画法与 token 全区一致，命中区高于 `control.target.minimum`；零新增 token、零新增色值。规则归[工作台 §32.14](../../frontend/workbench-design/part-11.md#3214-工具行右端一组上下文与模型下拉移到发送键左边2026-10-20)。**实际验证**：`composerSourcePanel.spec.ts` 3c 改写为「工具行左端是「+」、底栏三个子件 `工具行→tail→发送键`、tail 内 `计量环→模型`、资料仍在『普通讨论』右侧」，三个视口 **5/5**；`assistantModeSwitch.spec.ts` 首条输入器同组断言 **48/48**，同批 `composerDraftAssist`＋`modelSelector` **23/23**（三文件 71/71）；`modelSelectorDropdown` **6/6**（含右缘锚定后的视口包含断言）；一次性探针在真实 Chromium 量过改后两处行序与 tail/发送键同高，脚本用后已删；`tsc --noEmit` 本轮路径零报错。 | 未做真实 Windows/WebView2 与多 DPI 目视；未做独立验收；未 commit/push；860px 档工具行换两行属既有窄栏行为（改前同样换行），发送键仍与 tail 同行 |

## 条目 102

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 历史消息内容块第二轮：来源条/等待批准/草稿/候选卡（2026-10-19 深夜，用户「应该还有其他 UI 元素吧？继续开发」） | **实施者自检通过** | 同一档语言铺到其余消息区块，口径不动：① 来源条展开区行式化，状态枚举翻中文（AVAILABLE→可用、UNAVAILABLE→不可用，未知原样回显挂 `title`），状态与候选卡状态收进同族徽牌，候选卡 PENDING 琥珀档；② 「N 项等待你批准」徽牌升 attention 档、审批入口升级为琥珀细线行动块（审批定位口径不变）；③ 生成中草稿收进 `.assist-draft` 浅底块，正文仍纯文本不提前渲染 Markdown。**证据**：`executionTrajectorySummary` **8/8**、`executionSummary`/`folderFirstConversation` 全绿、`collaborationWorkspace`「AI 消息内按正文、来源条、候选卡的顺序」通过、`assist-preview` 草稿用例通过（余 1 例为并行会话 `assist-session-select` 缺失）；仓外静态页 + 真实 Chromium 截图 `apps/workbench/results/history-message-blocks-round2-2026-10-19.png`（页面与脚本用后已删）；`check-docs` exit 0；`tsc --noEmit` 本轮路径零报错。规则归[工作台 §38 第二轮](../../frontend/workbench-design/part-13.md#38-历史消息内容块的呈现2026-10-19)、[设计系统 §9.20](../../frontend/design-system/part-06.md#920-历史消息内容块一档可复制文本块与两档标签2026-10-19) | 真实 Chromium 消息流（窄栏、长引用折行）与真实 Windows/WebView2 窗口未复验；未做独立验收；未 commit/push |

## 条目 103

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 「+」菜单撤出目录入口（2026-10-19） | **实施者自检通过** | 按用户指认「选择目录之类的都是过度设计」：目录有常驻 Owner（协作页目录细条），「+」里的「选择工作文件夹」行与目录二级（选择文件夹／最近使用／管理工作区）整段删除，`ComposerAttach` 的 `onFolder`/`onOpenRecentFolder`/`recentFolders`/`folderPath`/`folderBound` 属性与 `AssistView`/`AssistSessionPanel` 的整段转发链一并移除；一级由五项收为四项。目录选择行为契约不变：仍走协作页 `requestFolderTransition` 守卫与 `OpenWorkingDirectory`，原生选择器优先。证据：`composerAttachMenu` **25/25**（新增「一级四项且无文件夹行」断言）、`assistantModeSwitch` **47/47**、`folderFirstConversation` **26/26**，`tsc --noEmit` 对本片文件干净。规则归[工作台 §32.3](../../frontend/workbench-design/part-11.md#323-二级资料与命令的接入点) | `collaborationWorkspace` **9/79 失败**为并行会话既有改动所致（draft 守卫、资料检索、轨迹与 Review 各片；与本轮改动文件无交集），未逐例复核归因；未做独立验收；真实 Windows 窗口与 DPI 未取证；未 commit/push |

## 条目 104

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 发送键提交态不闪禁用灰（2026-10-19 深夜，用户反馈「发送消息界面会闪一下」） | **实施者自检通过** | 同日早前一轮已把「命令结果待核对」块收成仅 `pendingUnresolved` 时出现（消除在途窗口整块闪现）；本轮用临时探针（jsdom＋真实组件＋真实 CSS，按「点击发送 → POST 挂起 → 202 回执 → refresh」逐相位取样）定位到**残留的另一个闪源**：点发送后 `busy/pending` 把发送键 disabled，全局 `.primary-button:disabled` 的浅灰底（`#E9EDE9`）随 120ms 过渡盖掉主色（`#205D47`），回执一到又跳回主色（或换成绿色停止键）——与代码内「主按钮二态：位置与配色不动」的既有契约冲突。**修复**：三颗主键（会话图标发送键、嵌入文本发送键、首条发送键）在提交窗口内置 `data-busy="true"`（沿用润色键的既有局部约定），CSS 以 (0,3,0) 特异度把背景/边框/文字色覆盖回主色，键仍 disabled 不重复提交；提交反馈交给 aria-label「正在提交」、在途光点与停止键接棒。模式盒变灰属「在途锁定」持续态、在途光点属持续装饰，经排查均非单次闪源，不改。**证据**：新增 `assistSendBusyState` **1/1**（提交窗口 data-busy 置位且仍 disabled、CSS 覆盖规则在样式表、待核对块在途窗口不闪现、202 后停止键接棒且 `data-inflight` 置位）；回归 `composerDraftAssist`＋`chatCommandInput`＋`composerImageAttachments`＋`modelSelector`＋`writePermissionTier`＋`assistElapsed` 共 **56/56**；探针复跑确认 BUSY 相位主色规则命中（临时探针用后已删）；`tsc --noEmit` 无本轮路径报错（仅剩并行会话的 `modelConnectionStrip`／`settingsView` 等测试文件 `imageInput` 报错）。契约归[工作台 §25.1](../../frontend/workbench-design/part-08.md#251-控件层级) | jsdom 的 getComputedStyle 不解析 var()，配色结论按「规则命中＋token 值」推断，真实 Chromium/Windows 窗口的观感未复验；工具行个别芯片（写入档位、模型）在提交窗口仍有轻微禁用变色，本轮未动；未做独立验收；未 commit/push |

## 条目 105

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 任务栏待处理角标（2026-10-19 深夜） | **部分通过：绘制与宿主接口自检通过，Windows 外壳叠加未取证** | 用户以任务栏截图确认此前没有角标后要求补上。**实现**：`apps/workbench/src/lib/taskbarBadge.ts` 在 32×32 canvas 画角标 → `Image.new(RGBA)` → `getCurrentWindow().setOverlayIcon()`；数量取 `InterventionNotifications` 每次 `getInterventions()` 的结果，与顶栏铃铛同源，同数量不重设、组件卸载即撤掉、>99 显示 `99+`、宿主拒绝只告警不断轮询；未新增 Rust 代码/图片资源/PNG 依赖（走 `JsImage::Rgba`，不需要 tauri `image-png` 特性）；`capabilities/default.json` 增 `core:window:allow-set-overlay-icon` 与 `core:image:allow-new`。**同日按用户「角标太难看」重画外观**：3px 白圈收成一圈 1px 纸面细边、砖红 `#A34F43` 提为 `#BE3E2C`、一位数圆盘多位数胶囊、字号 22/20/13 并按 cap-height 0.7 算视觉居中基线。**证据**：新增 `taskbarBadge` **5/5**（文案边界、绘制顺序与字号、非桌面模式不碰宿主、同数量不重设、宿主拒绝只告警）；`interventionNotifications` 7＋`desktop-titlebar`＋`projectReminderNotifications` 回归 **14/14**；`vite build` exit 0；`tsc --noEmit` 仅剩并行会话的两处报错（未跟踪的 `tests/tmpFlashProbe.spec.ts`、`assistantModeSwitch.spec.ts` 未使用导入），不涉及本片路径；**全量 vitest A/B**（把本片临时退回 HEAD 再跑）为 104 failed／1135 passed → 102 failed／1142 passed，多的 5 例正是本片新增用例，即不引入新红灯（现有红灯来自并行未提交改动，未代改）；`cargo check` exit 0 且 `gen/schemas/capabilities.json` 已含两条新权限；真实 Chromium（vite dev＋Playwright）直接调 `drawBadge` 出四张图，32/24/16px × 深浅底色对照与贴到机器人图标右下的合成预览见 `../../apps/workbench/results/taskbar-badge-2026-10-19/`（16px 单字符可读、两位以上发糊）。重画后再取一次证：`apps/workbench/probe-badge-restyle.mjs`（`probe*.mjs` 已在 gitignore）把 `taskbarBadge.ts` 用 `typescript` API 转译后在真实 Chromium 里执行同一份 `drawBadge`，改前/改后 × 深浅底色 × 1:1 任务栏（含应用图标相邻位）× 4× 像素放大六栏对照见同目录 `restyle-sheet.png`，页面无脚本报错；1:1 档单双字符清晰、`99+` 仍偏挤。规则归[工作台 §11.5](../../frontend/workbench-design/part-03.md#115-已确认的人工介入提醒规则)，外观归[设计系统 §1](../../frontend/design-system/part-01.md#1-视觉依据与提取边界)，过程记录归 [CODEX_NEXT_STEP](../../development/codex-next-step-history-20261025.md#任务栏待处理角标2026-10-19未-commit) | **未看到 Windows 实际叠加**：须重新构建桌面端、连真实 API 且存在 ≥1 条待人工介入事项才会在任务栏出现；多 DPI、任务栏取用哪一层图标尺寸、安装态未验；Chromium 出图不代替宿主效果；未做独立验收；未 commit/push |

## 条目 106

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 「+」二级弹层纵向定位：相对一级居中、贴底时底边对齐（2026-10-19 深夜） | **实施者自检通过** | 按用户指令「二级菜单要以一级的高度居中，如果一级太下面就底部跟一级对齐」，取代同日早先的「贴住当前那一行」：`AssistView` 的 `measure()` 把二级 `top` 写成 `(一级高 − 二级高) / 2`，二级更高时上探出一级顶边（唯一硬边是视口顶边，可为负的 `minTop`）；一级贴近视口底部、居中会顶出视口时改为二级底边与一级底边对齐；再放不下交给既有 `max-height` 内部滚动。**证据**：真实 Chromium 临时预览页（挂载 `ComposerAttach` + stub client，引用真实 CSS/token，用后已删）四档量测——1280×900 与 900×620 offset 恰为 `(96−222)/2 = −63`（居中）、1280×380 底边差 0（底边对齐）、1280×300 被 `max-height` 夹住且顶边 83px 未越出视口；截图 `apps/workbench/results/attach-submenu-*.png`。单测复跑全绿：`composerAttachMenu` **25/25**、`assistantModeSwitch` **47/47**、`chatCommandInput` **7/7**。规则归[工作台 §32.4](../../frontend/workbench-design/part-11.md#324-开合键盘与方向)、[设计系统 §9.14](../../frontend/design-system/part-05.md#914-两级上下文菜单视觉补充) | 与并行会话同窗改同一文件，`tsc --noEmit` 当下含他人未完成改动的报错（`WritePermissionControl` 等），未归本轮；真实 Windows/WebView2 窗口与多 DPI 未复验；未做独立验收；未 commit/push |

## 条目 107

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 历史消息内容块统一呈现（2026-10-19 深夜，用户「用 taste 这个 skill 美化一下 agent 的历史消息」） | **实施者自检通过** | 按「可复制文本块、运行命令、更改文件、运行工具等多种情况」收成一档共享块与两档同族标签，事实来源与口径一律未改：① 新组件 `components/MessageCodeBlock.tsx`（细线框 + 顶行来源标签 + 复制键 + 块内滚动正文），代码 fence（`SafeMarkdown` 新参 `codeCopy`，默认 false）、工具回执（`ExecutionTrajectorySummary` 展开的读取结果）、命令输出三处共用；② 调用统计由「·」串改为一类一枚 `.execution-count` 徽牌，等待原因下移一行；③ `ChatLocalFileDiff` 行结构不变，`✎` 改 lucide `FilePen`、路径/数字等宽、「预览」升为细线徽牌。**证据**：`messageCodeBlock` **5/5**、`safeMarkdown` **10/10**、`executionTrajectorySummary` **8/8**、`chatLocalFileDiff` **7/7**、`executionSummary` 与 `readingPresentation` 全绿（合计 43+）；仓外静态页 + 真实 Chromium 截图 `apps/workbench/results/history-message-blocks-2026-10-19.png`（页面用后已删）；`tsc --noEmit` 无本轮路径报错（仅剩并行会话的 `recentFolders`/`attachFolderNote`/未跟踪测试文件）；`check-docs` exit 0。规则归[工作台 §38](../../frontend/workbench-design/part-13.md#38-历史消息内容块的呈现2026-10-19)、[设计系统 §9.20](../../frontend/design-system/part-06.md#920-历史消息内容块一档可复制文本块与两档标签2026-10-19) | 观感截图与用例均为静态/组件级，真实 Chromium 消息流（含窄栏、长标签省略）与真实 Windows/WebView2 窗口未复验；未做独立验收；未 commit/push |

## 条目 108

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 输入器档位菜单图标、脚注与宽度收改（2026-10-19 晚两轮用户截图指令） | **实施者自检通过** | 第一轮按「修改一下底下三个的图标（样式要和权限符合），删除底部的文字，减小菜单宽度」：① 三档图标换成按「这一档允许我做什么」选的 `LockOpen`（完全访问）／`CircleCheck`（自动批准）／`Eye`（只读），`Hand`（请求批准）不动——原 `Flame`／`Zap`／`Lock` 表达的是危险与快，不是写入范围；② 删除菜单底部整宽脚注「完全访问仅本目录文件写入 · Git 与 CLI 仍逐次确认」及其样式规则，Git／CLI／浏览器／电脑与目录外动作的边界只留文档；③ 菜单宽度由 `max-content`＋22rem 上限改为定档 `min(19rem, 100vw − space.6)`，并把「自动批准」「完全访问」两档说明压回一行（此前「自动批准」在 352px 下已折成两行，违反 §18.1.3「每档只留一行短说明」）。第二轮按「删除尚未选择工作目录，刷新按钮、选择目录并归入项目这几个。然后完全访问的图标改成代表危险的图标，菜单宽度在减小一点」：④ 删掉菜单首行（目录名／「尚未选择工作目录」／「这个目录还没有归入项目」）、`RefreshCw` 重新核对按钮与琥珀色提示行三块 DOM 及对应样式，菜单里除四档外不再有任何整行文字；缺的前置条件、生效说明、拒绝原因、404 说明与「这条档位属于哪个目录」改由芯片 `title` 承载（悬停可读，未绑定态仍不发查询）；⑤ 完全访问图标 `LockOpen` → `TriangleAlert`（lucide-react 1.47.0 已核该导出），整行红色不变；⑥「自动批准」说明去掉「本次」二字（15 字）以保住一行，宽度定档由 19rem 降到 18rem。**证据**：`writePermissionTier` **13/13**（首行／提示行／刷新按钮改断不存在，未绑定与未归入项目两例改断芯片 `title`，图标断言换成 `lucide-triangle-alert`，菜单正文长度守卫由 <120 收到 <80；「丢响应后重读到新 revision」一例改为断重试发出的是同一个冻结请求对象（`toBe`）——菜单头按钮删除后待核对期间已无人工重读入口，原用例的前置动作不再可达）；`popoverMenu` **5/5**、`newConversationEntry` 11/12（唯一失败是「取消离开后仍可继续原草稿」读不到 `[role="dialog"]`，属并行会话的会话离开草稿守卫改动，不在本路径，未改）；真实 Chromium 静态预览页（design-tokens 展平＋组件 CSS 原文，用后已删）量得菜单 **352×341 → 304×295 → 288×234**，18rem 正文列宽 226px、最长一行需 210px、余量 16px，17rem 余量 0px 故不采用，四档均单行，截图 `apps/workbench/results/permission-menu-{before,after,round2-18rem}.png`；`tsc --noEmit` 仅剩并行未跟踪的 `tests/tmpFlashProbe.spec.ts`（第一轮的 `CollaborationView.tsx:1183` 语法错误已由并行会话修好）。规则归[工作台 §18.1.3](../../frontend/workbench-design/part-05.md#1813-输入器的本目录写入档位2026-10-17) | 量测来自仓外静态页（同机 Chromium，非应用运行时），真实 Windows/WebView2 窗口、多 DPI 与实机点击未复验；删除刷新按钮后「主动重读投影」只剩挂载／换作用域、查询原回执与提交后重读三条触发点，已按现状写进 §18.1.3，未做独立验收；未 commit/push |

## 条目 109

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 「+」菜单去掉说明文字（2026-10-19 晚） | **实施者自检通过** | 按用户指认「每个菜单下面都有文字……上游都没有设计这个，这个文字很影响体验」：删除一级弹层底部 `.agent-chat-attach-note`（「资料在会话中选择」「连接器随项目配置；进入项目后可查看授权状态」）与二级底部 `.agent-chat-attach-subnote`（未接入能力的接入点），连同 `attachPendingNotes`、`noteId` 与 `aria-describedby` 接线；禁用原因改由行 `title` 承载（本地文件／工作区／Skill 生成三条补上具体原因），行内状态位（计数、对勾、`暂未接入`）保留；命令行不再对可用项写「可用」，`chatCommandStatus` 只在例外时返回文字。证据：`composerAttachMenu` **26/26**、`chatCommandInput` **7/7**、`assistantModeSwitch` **47/47** 全绿；`tsc --noEmit` 仅剩并行改动涉及的三份测试文件报错。规则归[工作台 §32.12](../../frontend/workbench-design/part-11.md#3212-去掉菜单里的说明文字2026-10-19-晚) | 真实 Chromium 的 `uiOption2FirstSession.spec.ts` 单条用例在本机两次单跑分别停在首次点击与发送（失败点不同、均早于本轮断言），判为环境不稳定，未作为本轮证据；真实 Windows 窗口与 DPI 未复验；未做独立验收；未 commit/push |

## 条目 110

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 连接器「授权」文案复读收敛（2026-10-19） | **实施者自检通过** | 按用户指认「为什么这里需要项目中授权……这些都是过度设计」：①「+ → 连接器与插件」在无项目归属时不再逐行写「需在项目中授权」——读不到登记就不写状态，面板首句只说「连接器随项目配置」，必然为空的「已连接能力」整节不渲染，措辞收成 `connectorScope`/`connectorScopeNote` 一份（一级行 title、菜单脚注、面板首句共用）；②`/settings/connections` 删除「按已知项目 ID 打开」的手输 UUID 表单与随之失效的 `.connections-entry`／`.connections-known-project` 样式。证据：`composerAttachMenu` **26/26**、`assistantModeSwitch` **47/47**、`connectionsSettings` **23/23**、`tsc --noEmit` exit 0；真实 Chromium 临时预览页（client 非空、projectId 为空）量得二级面板 **156×330**、首句单行，截图 `apps/workbench/results/attach-connectors-no-project.png`。规则归[工作台 §32.9](../../frontend/workbench-design/part-11.md#329-连接器与插件二级2026-10-17) | 未做独立验收；真实 Windows 窗口与 DPI 未取证；连接器「全局默认 + 项目覆盖」作用域方案待确认（未实施）；未 commit/push |

## 条目 111

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 协作页删除消息行模型调用披露（2026-10-19） | **实施者自检通过** | 按用户截图与「不是隐藏是删除」指令，删除 AI 回复下方「本条首选 / 最近实际调用 / 调用记录 + 模型尝试与用量」块：删 `components/AssistModelRuntime.tsx` 与其单测 `tests/assistModelRuntime.spec.tsx`，`AssistView` 去掉该渲染、import 与 `latestModelMessage` 取数，前端不再请求 `GET .../model-runtime`；后端 `readAssistModelRuntime` 投影与路由保留。`tests/browser/free-model-real-api.spec.ts` 原四条 UI 断言改为断言该块不存在，同一用例仍核对 HTTP 投影的候选顺序、两次调用与切换。`tsc --noEmit` 仅剩未跟踪的 `tests/memoryStatusClient.spec.ts`（并行轮次新增，不在本路径）；`assistantModeSwitch.spec.ts` 通过；`assist-flow.spec.ts` 7/11 通过，4 例失败均为 `.breadcrumbs` 选择器缺失与 `assist-target` 文本不符（页头并行改动），不涉及本块。契约归[工作台 §25.1 第四轮](../../frontend/workbench-design/part-08.md#251-控件层级)，样式档说明同步[设计系统](../../frontend/design-system.md)的 `.tech-details` 段 | 真实 Chromium 与 Windows 窗口未复验；未做独立验收；未 commit/push。后端 model-runtime 端点自此无 UI 消费方，是否随下一轮下线待定 |

## 条目 112

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 长期记忆状态与筛选后端（2026-10-19） | **部分通过：后端开发自检通过，前端未接** | 红→绿：旧实现缺 effective_status，筛选参数返回 422；新增同快照根/当前版本联查后，真实临时 PG 18.6＋真实 HTTP `memory-status` **3/3**：默认 ALL 与三态筛选、详情同源、非法枚举、到期零写入、停用优先、恢复不续期、明确确认新修订改变有效期、原搜索与 Context 排除过期项、Workspace/Project/全局与同 Workspace 其他项目边界。回归 `information` **7/7**、`information-restore` **8/8**、`context` **13/13**，共 31 例；API 全量编译 exit 0，文档检查通过，临时库停止并清理。协议归 [HTTP §10.98](../../api/http-command-contract/part-07.md#1098-长期记忆有效状态与筛选2026-10-19-后端接续) | 执行者自检，未做独立验收；前端状态/筛选/client 当时未接（已由本表「长期记忆状态与筛选前端」行接续），浏览器、Windows/WebView2、安装态与真实 Provider 未验。无新迁移，未修改用户库，未 commit/push；前端入口见[专用任务书](../../../prompts/memory-status-frontend.md) |

## 条目 113

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 长期记忆状态与筛选前端（2026-10-19） | **部分通过：前端组件自检通过，真实 API 浏览器链路未跑** | 红→绿：先补 `memoryStatusClient` 4 例与 `memoryStatus` 7 例，实现前 11/11 全红（DTO 无 `effectiveStatus`、无筛选控件与状态标签），实现后 **11/11** 全绿。**client**：Memory DTO 增加只读 `effectiveStatus`，三态严格解析，缺字段落为 null（显示「状态待核对」），显式 null 与未知枚举抛 `RelayContractError`；`getMemories(projectId, effectiveStatus)` 默认 ALL 不追加查询参数（旧调用与旧服务端请求形状不变），ACTIVE/EXPIRED/RETIRED 各自落到 `effective_status`，并能与 `project_id` 组合，全部为 GET；详情解析有效状态，历史 revisions 不附加动态状态。**视图**：Memory 页签列表内新增「全部 / 有效 / 已过期 / 已停用」分段筛选（共享 `.segmented`），切换时清空旧行与选中项、由读取版本号丢弃迟到响应；列表与详情按 effectiveStatus 显示「有效 / 已过期 / 已停用 / 状态待核对」，同时保留确认信息、有效期与持久状态，已停用且到期仍显示「已停用」；首次空态、筛选无匹配（带「查看全部记忆」）与读取失败分开表达；服务端状态与到期时间故意矛盾的用例证明不按本机时钟推断。**生命周期**：过期但未停用的记忆仍可停用与追加修订，详情给出续期入口并说明恢复不延长有效期；恢复回执改为「已恢复记忆的持久状态」，重读后仍到期则显示「已过期」，不再提前宣称有效；停用/恢复后按当前筛选重读，不匹配项从列表移除并把详情落到剩余项。回归 `knowledge` 18、`knowledgeReading` 9、`knowledgeContentClient` 5、`informationRestore` 9、`informationRestoreClient` 5，连同新增两文件共 7 文件 **57/57**；Workbench `tsc --noEmit` 仅剩并行未跟踪的 `tests/tmpFlashProbe.spec.ts`（非本片），`vite build` exit 0。规则归[工作台 §13.3](../../frontend/workbench-design/part-03.md#133-长期记忆状态与筛选2026-10-19已确认前端已接)，协议归 [HTTP §10.98](../../api/http-command-contract/part-07.md#1098-长期记忆有效状态与筛选2026-10-19-后端接续) | 执行者自检，未做独立验收；本机无运行中的真实 API/PG，**未跑真实 API 浏览器链路**，Workspace/Project 范围与过期数据的真实链路未取证；真实 Windows/WebView2、安装态、多 DPI 与真实 Provider 未验；未 commit/push |

## 条目 114

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 普通聊天文件增删改查·真实模型端到端跑通（2026-10-19，用户报「最基础的增删改查还没跑通」） | **已通过（真实模型 + 真实 PG/HTTP/磁盘；首轮失败后连续 6 次通过）** | 排查结论：底层工具循环本身没问题（`real-model-tool-loop` 只读用例 47s、写用例 63s 各 1/1 PASSED），断点在**普通会话的执行候选**上，属产品设定而非工具能力。① 真实模型按语义把 `expected_outputs.kind` 写成 `CODE_FILE`，而 `validateConversationCandidate()` 只认 `MARKDOWN_DOCUMENT`，整条「改文件」请求被判定成 CLARIFY（用户只看到「当前固定工作流只支持 Markdown 交付说明」），永远进不了 Task/Run；现按同义表归一为唯一可判定种类（未知值仍拒绝），提示词同时写明「kind 描述的是可审查交付说明，改动写在 file_changes」。② 主流程提示词原先让模型读成「工具只读＝我不能改文件」，它会回一段 Markdown 方案并反问「要不要我改」，`readMainLoopOutcome()` 于是落成纯 REPLY；现明确「用户明确要求修改时必须填 execution，不要反问」。③ 只读轮次预算耗尽原直接以 `SESSION_TOOL_ROUNDS_EXHAUSTED` 失败；现最后一轮或调用预算用尽后**不再声明工具**并追加收尾指令，模型只能给出最终答复。④ 模型异常原统一折叠成 `MODEL_FAILED`（超时/输出不合法/预算不可分），现按 `MODEL_TIMEOUT`／`MODEL_TOOL_OUTPUT_INVALID`／`MODEL_BUDGET_EXHAUSTED` 分类。**证据**：新增 `agent-file-crud-real-model`（opt-in，无 `RELAY_MODEL_*` 时 skip）从聊天消息走到磁盘：find_paths → read_file → apply_changeset 全部 SETTLED，`src/greeter.ts` 真实写出 `RELAY-CHAT-OK`，原注释与无关文件字节不变，单次 57.6–131.8s；首轮 `MODEL_FAILED` 之后连续 6 次 PASSED（其中最终代码 2 次，最后一次脚本退出码 0）。定向单测 39/39（`conversation-prompts`／`agent-runtime-prompts`／`assistant-readonly-round`／`conversation-execution`）；真实 PG `folder-first-conversation` 20/20、`local-directory-access-review` 4/4。 | 首次端到端运行以 `MODEL_FAILED` 失败（当时尚未加错误分类，原因未留证），随后连续 6 次通过，**稳定性未闭合**；真实 Windows/WebView2 窗口内未验；DELETE 业务链仍由既有 `real-model-tool-loop` 删除用例覆盖，本轮未复跑；全量 API 单测 867 项中 21 项红，分布在 `restore-runtime-probe`／files 符号链接／git worktree／free-call-guard 等与本切片无关的既有环境项；未 commit/push |

## 条目 115

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 默认工作目录前端（2026-10-19） | **部分通过：前端开发自检通过，整体未验收** | 红→绿的缺口是「设置页没有默认目录入口、建会话后不读回作用域、界面不标来源」。**client/解析**：三接口（`GET /default-working-directory`、`POST` 设置、`POST …/clear`）按契约解析，`UNSET` 读成修订 `0` 且资源/目录/档位为 null，`UNAVAILABLE` 与未设置分开并保留原目录与档位；设置/清除回执核对 `command_id`、`workspace_id`、`resource_id`、十进制 `revision`，任一不符只抛「无法核对」；会话上下文 `working_directory.source` 三态（`WORKSPACE_DEFAULT` / `USER_PICKED` / null），缺字段与显式 null 读成历史未知，词表外值显式失败。**设置页**：基本设置新增「默认工作目录」一行，区分未设置/读取中/有效/失效/读取失败；原生选择器（`desktopHost.selectWorkingDirectory`）＋非桌面手输回退；只有 `OpenWorkingDirectory` 回执 `READY` 且带 `association.resource_id` 才发设置命令，未就绪原样说明服务端原因并保留原值，**只读目录也能设为默认**（不看 `write_readiness`）；设置/清除严格用最近读取的修订，`409` 重读并说明冲突、不覆盖；传输结果不明保留原命令/原载荷/原基准修订并可查回执；切 Workspace 清空旧投影，迟到响应不落入新范围；挂载、切分组与重读只发 GET，未写 localStorage。**会话与呈现**：建会话成功后按回执 `session_id` 读回上下文；服务端继承默认目录时会话本就带 Project，交回宿主切到该项目作用域并标出来源，**零额外目录绑定**；空态说明句按 READY / UNAVAILABLE / 未设置三种事实分别措辞，保留「不需要先创建项目、任务」；细条与顶栏只在 `source=WORKSPACE_DEFAULT` 时写「默认目录（来自设置）」，`USER_PICKED` 与缺字段都不写。**证据**：Workbench `tsc --noEmit` exit 0、`vite build` 成功；新增 `settingsDefaultDirectory` **7/7**、`assistantClient` 扩到 **18/18**、`folderFirstConversation` 扩到 **26/26**，连同 `settingsView` 15、`newConversationEntry`、`assistBinding`、`conversationDiffSummary` 共 7 文件 **103/103**。**2026-10-20 用户指令「只显示目录名」**：细条与顶栏不再追加「默认目录（来自设置）」后缀，来源只保留在 `context.working_directory.source` 与顶栏 `data-source` 上（工作台 §18.1.5 同步改写）；`folderFirstConversation` **26/26**（默认继承与 `USER_PICKED` 两例按新口径改写）、`assistantClient` 与 `settingsDefaultDirectory` 同批通过；`collaborationWorkspace` 5 例失败分别卡在 `#assist-source-query` 缺失与工具轨迹空态，属并行会话改动，与本片无关；同日按用户确认在**更换目录浮层顶部补完整路径**（次要前景色、长路径换行不截断、不做按钮），`folderFirstConversation` 仍 **26/26**；随后按桌面端截图把**「最近使用」每行也改成完整路径**（名称一行、路径一行、`overflow-wrap: anywhere`），浮层上限放宽到 `64vh/30rem` 并保留内部滚动；再按用户要求加**目录名悬停/聚焦浮出绝对路径**（`lib/pathTooltip.tsx`，fixed + portal、handlers 不新增包裹层），`folderFirstConversation` **27/27**。规则归[工作台 §18.1.5](../../frontend/workbench-design/part-05.md#1815-未选目录时的默认工作目录2026-10-18已确认未实施)，协议归 [HTTP §10.96](../../api/http-command-contract/part-07.md#1096-workspace-默认工作目录2026-10-19-后端实现) | 本行是执行者自检，未做独立验收；测试全部是 jsdom＋fixture，**未跑真实 API/PG 与浏览器链路**，因此「设置命令在真实服务端 CAS 下收敛、首条真的读到默认目录内文件」未在本行取证（后端行为见「默认工作目录后端」行）；全量 Workbench 1220 例中 18 例失败，其中 17 例在 HEAD 基线上同样失败（9 个文件，来自并行会话的未提交改动），余下 `run-events` 时序断言在满载下偶发、单跑 5/5，本片未新增失败；DD-06 完整 Gateway 矩阵、真实 Windows/WebView2、安装态、多 DPI 与真实 Provider 未验；未 commit/push |

## 条目 116

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 资料与记忆规则恢复前端（2026-10-19） | **部分通过：组件与类型检查通过，真实 API 浏览器链路未跑** | 三个 client 方法（`unarchiveKnowledge / reactivateMemory / reactivateRule`）核对路径、命令体与回执的 command_id／目标 ID／ACTIVE／修订下限，异常信封按「结果不明」抛错；资料归档与记忆/规则停用改成「单击即发 → 回执核对 → Snackbar 撤销」，撤销使用新 command_id 与正向回执修订，回执不明时不给撤销、保留就地原命令核对入口；撤销冲突/网络失败把同一条浮层升级为 Notice 并指向永久入口；永久入口复用既有列表与详情（列表本就返回非活动项，未另建管理页），用当次读回的对象修订，冲突先重读事实再要求重新决定，归档 Project 沿既有写入守卫禁用；三类文案均写明「只恢复状态」。新增 `informationRestoreClient` **5/5**、`informationRestore` **9/9**；回归 `knowledge` 18、`knowledgeReading`、`knowledgeContentClient`、`knowledgeCaptureLayout`、`feedback`、`projectKnowledgeGuide` 共 6 文件 **56/56**；Workbench `tsc --noEmit` exit 0、`vite build` 成功。规则归[工作台 §13.2](../../frontend/workbench-design/part-03.md#132-危险操作的两条通道2026-10-18) | 执行者自检，未做独立验收；本机无运行中的真实 API/PG，**未跑真实 API 浏览器链路**，也未为取证写入用户库，因此「浏览器实际请求与磁盘/数据库事实一致」未验；真实 Windows/WebView2、安装态与多 DPI 未验；连接/资源反向命令与不可逆族确认框不在本片；未 commit/push |

## 条目 117

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 资料与记忆规则恢复后端（2026-10-19） | **部分通过：后端开发自检通过，前端未接** | 红→绿：三类反向 HTTP 接口旧实现均 404；新增 `UnarchiveKnowledge / ReactivateMemory / ReactivateRule` 后，真实临时 PG 18.6＋真实 HTTP `information-restore` **8/8**：状态恢复、根修订递增、不可变版本保持、context/rule revision 推进、同命令与并发重放单次审计、异载荷/陈旧基线/跨 Workspace/归档项目拒绝、已 ACTIVE 不重复推进、Workspace 全局对象、待核对候选与 Decision 保持。回归 `information` **7/7**、`decision-reviews` **3/3**、`context` **13/13**，共 31 例；API 全量编译 exit 0，文档检查通过。临时库均停止并清理，未修改用户库，无新迁移。协议归 [HTTP §10.97](../../api/http-command-contract/part-07.md#1097-资料归档与记忆规则停用的反向命令2026-10-19-后端实现) | 执行者自检，未做独立验收；前端撤销条、永久恢复入口与端到端用户操作已由本表「资料与记忆规则恢复前端」行接续；连接/资源反向命令及不可逆族确认框不在本片。真实 Windows/WebView2 与安装态未验；未调用真实 Provider，未 commit/push |

## 条目 118

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 新会话固定快捷语提示词优化（2026-10-19） | **源码已更新，预填自检通过；模型效果未验收** | 保留 11 个入口，仅替换提示词；`collaborationWorkspace.spec.ts` 的快捷卡预填用例通过，整文件 **74/79**；Workbench `tsc --noEmit`、文档检查与 `git diff --check` exit 0。行为规则归[工作台 §18.1.1](../../frontend/workbench-design/part-04.md#1811-新对话直接起步2026-10-05-接续实施)。 | 整文件另有 5 条失败：资料查询选择器缺失、工具轨迹 DTO 与执行摘要断言失败；本轮未确定这些失败的引入来源，未修改对应逻辑。浏览器用例已同步预填断言但未运行；真实 Provider 对新提示词的执行效果、Windows 窗口与安装包未验。 |

## 条目 119

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 默认工作目录后端（2026-10-19） | **部分通过：后端开发自检通过，整体未验收** | 红→绿：未实现时默认目录 GET 返回 404；新增迁移 `0117`、配置命令与创建继承后，真实临时 PG 18.6＋真实 HTTP：`workspace-default-directory` **5/5**（设置/清除/CAS/命令重放/同 ID 异载荷拒绝/并发收敛/跨 Workspace/失效回落/来源投影/历史保持）；`agent-conversation-main-loop` **9/9**（新增默认继承后首轮真实文件随机标记经工具回到模型上下文，缺档位投影只读且不补写权限）；`assist-session-binding` **10/10**、`folder-first-conversation` **20/20**、`migration` **10/10**、`work-contexts` **2/2**、`cli` **5/5**，两批共 7 套件 61 个用例通过。**2026-10-19 接续（用户要求「基础能力不该让开发者自己配置，应该所有会话都有」）**：`OpenWorkingDirectory` 在 `READY` 且工作区尚无默认目录时于同一事务登记默认（已有默认不覆盖；停用、归档、重叠根、身份变化一律不登记）；`SetWorkspaceDefaultDirectory` 对「目标已达成的陈旧修订」按 no-op 返回当前事实，避免设置页在打开目录后与自己的 CAS 撞车。复跑 `workspace-default-directory` **5/5**、`folder-first-conversation` **20/20**、`local-directory-access-review` **4/4**、`agent-conversation-main-loop` **9/9**（真实临时 PG 18.6，临时集群已清理）；`check-docs` 通过。API 全量编译 exit 0，定向单元 **28/28**（assistant-readonly-round / assist-session-controls / conversation-execution），文档检查通过；一次性临时库均停止并清理，未操作用户库。协议归 [HTTP §10.96](../../api/http-command-contract/part-07.md#1096-workspace-默认工作目录2026-10-19-后端实现) | 本行是执行者自检，未做独立验收；前端设置入口、DTO 来源消费与来源标签未接；DD-06 完整 Gateway 新建/修改/删除及实际调档矩阵尚未闭合，当前只证明无档位读取与零权限补写；模型端为 Fake，真实 Provider、多模态、Windows/WebView2、安装态与用户库升级未验。未 commit/push |

## 条目 120

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 「+」菜单固定显示三个内置插件（2026-10-19，用户指认「加号的菜单看不到这三个插件」） | **通过（jsdom 26/26＋`tsc` exit 0）；真实 Windows 窗口未复验** | 二级「连接器与插件」顶部新增「内置插件」分组，恒列电脑操控、浏览器操控、GitHub 三行；此前只在「已连接能力」里随项目连接出现，没有项目归属或项目未登记连接时整块为空，三个插件看起来不存在。**固定的是身份、不是状态**：每行状态仍逐项取自服务端连接登记（全 ACTIVE＝已连接、部分＝部分已连接、全停用/撤销＝已停用/已撤销），无项目归属写「需在项目中授权」、未连 API 写「未连接 API」、读取失败写「状态未知」；点击进 `/settings/connections`，与底部「管理连接与权限」同一去向。未新增前端能力词表，能力名仍走 `gatewayCapabilityLabel`。规则归[工作台 §32.9](../../frontend/workbench-design/part-11.md#329-连接器与插件二级2026-10-17) | 真实 Windows 窗口与 DPI 未点验；三个插件的真实运行态（电脑运行时是否可启动、浏览器扩展是否已配对、`gh` 是否已认证）不在本行断言——行内只反映连接登记，不探测运行时；未 commit |

## 条目 121

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 输入框粘贴图片与消息附件：六项收口复验（2026-10-19，接续 5e5cdb68 与 dfa64938 的未勾选任务） | **通过（限定工程范围）**：Workbench jsdom 定向 **7/7**、真实临时 PG `assist-message-attachments` **5/5**、双端 `tsc --noEmit` exit 0；真实 Windows 窗口与真实 Provider 未验 | 逐项核对旧会话遗留的六个任务，结论为「已实现，两处真实缺口已补」。**已实现**：① 空正文只在「带附件＋无 `skill_ref`＋`DISCUSS`」时放行，无附件仍拒绝（`assist-commands.ts:391-403`）；② `GET …/message-attachments/{id}` 与消息 DTO 的 `attachments` 元数据按 workspace 与 session 双重过滤，未命中 404（`assist-api.ts:320-337,553-567`、`assist-queries.ts:90-99`）；③ `RELAY_MODEL_IMAGE_INPUT` 只补「目录无条目」的空白，目录明确不支持时声明翻不了案（`model-port-config.ts:90-92`、`assist-commands.ts:627-643`）；④ 首条与会话两处输入器都接了粘贴/拖拽与芯片；⑤ 历史气泡按张读取并缓存，失败显示「图片读取失败」＋「重新读取」；⑥ §10.85／§33／§91 章节齐备。**本轮补的两个缺口**：① 会话输入器未把「已暂存未发送的图片」算进未保存保护，切换路由会静默丢图，现并入 `dirty` 且 `discardDraft` 一并回收；② 上传成功但命令被 422 明确拒绝时芯片已被 `clear()` 清空，图片随之消失，现在把文件还回输入框（传输失败不还原，避免命令可能已入库时诱导重发）。规则归[工作台 §33.2/§33.4](../../frontend/workbench-design/part-12.md#332-暂存与发送)、协议归 [HTTP §10.85](../../api/http-command-contract/part-06.md#1085-assist-消息图片附件2026-10-18-前后端接线)；§33.2 原写「前端按目录 `image_input` 预检」与实现不符，已改为以服务端 422 为准绳 | 真实 Windows 窗口的粘贴/拖拽、多 DPI 与输入法未验；真实 Provider 多模态语义未验；HTTP 层无专门「跨会话 404」断言（应用层已覆盖）；目录条目 `image_input=false` 分支无直接单测；视口级懒加载未实现且文档未承诺；未 commit |

## 条目 122

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 会话局部与总 diff：真实 PG 集成补测（2026-10-19，接续 bfcfa4d9 的任务 5） | **通过（服务层）**：新增 `conversation-diff.integration.test.ts` **5/5**，真实临时 PG 18.6＋真实临时 Git 仓库，`status PASSED`；HTTP 端点层与 UI 不在本文件断言范围 | 旧会话的任务 5 因「本环境无 PG」一直挂起，实际可用一次性临时集群。新套件覆盖五条语义：① 基线幂等——首次 `CREATED`、二次 `REUSED` 且库中只有 1 条有效行；② 净变化——改已跟踪文件 `MODIFY +2/−0`、未跟踪新文件 `CREATE +3/−0`、删除 `DELETE +0/−2`，`totalAdded=5`／`totalRemoved=2` 等于各可统计项之和；③ 展开正文与总数同源（`action`/`added`/`removed` 与列表逐项相等，`rows` 行数对齐），未知路径返回 `PATH_NOT_FOUND` 不抛错；④ 不可用原因四态——未绑定目录 `NO_RESOURCE`、未建基线 `NO_BASELINE`、非 Git 根在建立侧 `NOT_GIT_ROOT` 与读取侧 `ROOT_NOT_GIT`；⑤ 换目录不跨段求和——A→B 重建基线后只反映 B 的 `totalAdded=1`，旧根改动不再出现。既有单元与前端证据仍归本表原有的「会话局部与总 diff」行与原 W1–W3 记录 | HTTP 路由与 DTO 形状、并发首个请求、重启后继续读取、采集不完整（超限/二进制/不可读）与 `RESOURCE_UNAVAILABLE` 未覆盖；真实 Windows 窗口与真实 Provider 工具流未取证；未 commit |

