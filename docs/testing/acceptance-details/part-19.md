# 功能验收详细记录：分册 19

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../overall-acceptance-details-20261025.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

### 10.9.1 四类缺口的修复与复验（2026-10-04）

范围：上表四类缺口（五项反例）的实现方自检与修复后复验。基准为 HEAD `20a9254` 加本节所列文件的当前未提交内容。**这是修复方自检，不替代独立验收**；受控故障夹具（响应丢失、响应延迟）不证明真实后端接受或文件副作用。

**共同根因**：首条消息过程被拆散在会随「协作页按会话 key 重新挂载 AssistView」而卸载的组件局部 state 里——`pendingFirstMessage` 已在上一轮提到协作页，但 `firstExecution`、`firstDraft`、`creating`/`sendingFirst` 与创建命令携带的首条原文仍各自留在实例内。命令身份、在途阶段与解释结果因此不是同一份事实，迟到回调与重挂载后的新实例会各自推进一次。

**实现（最小改动，只动协作页与 AssistView）**

| 缺口 | 处理 |
|---|---|
| A 换目录绕过保护 | `CollaborationView` 新增 `requestFolderTransition`，两处 `FolderScope` 的 `onOpen` 统一经既有 `requestTransition`；守卫先于 `OpenWorkingDirectory`，不在决定前发目录命令 |
| A 原资源绑定 | `PendingFirstMessage` 增加 `resourceId`，在命令产生时固定；`interpretFirstMessage` 只用该值，不再从当前 `executionScope` 取 |
| B 摘要交接 | 首条过程整体提升为协作页持有的 `FirstMessageOwner`（`draft`/`pending`/`busy`/`interpreted`/`execution` + 同步 `read()`）；会话面板新增按 `request_id` 接手的 effect，使解释结果在面板挂载之后到达也能渲染 |
| C 重复解释 | 在途闸与「已解释」声明都落在同一 Owner 上：同一 `command_id` 只解释一次；迟到失败仅在 pending 仍指向同一命令时才写回，不复活已清空状态 |
| D 创建恢复吞首条 | `PendingCreate` 携带 `firstContent` 与 `resourceId`；`checkCreateReceipt` 恢复会话后按原载荷续发同一条首条过程 |

顺带删掉 `AssistView` 里一个被后一个 effect 完全覆盖的重复导航状态投影（同一 `onNavigationStateChange` 被调用两次，后者总是胜出）。

**验证（Fixed Node 24.21.0）**

- 五项反例先落为正式回归（`folderFirstConversation.spec.ts` 新增 describe「整改后独立复验的接续反例」），并**逐条反向撤销五处修复后确认 5/5 失败**（A1 弹窗标题为 `undefined`、D 的 messages POST 为 0 条），还原后按 SHA-256 校验两个源文件与修复版逐字节一致。
- 修复后该文件 **13/13**；受影响 8 文件 **124/124**；全量组件 **79 文件 620/620**（较修复前 613 增加 5 项新反例与 2 项修正）。
- 前端 `tsc --noEmit` exit0；生产构建 exit0；API `tsc --noEmit` exit0。
- 真实 Chromium 浏览器套件 **38/38**、exit0。
- `node scripts/check-docs.mjs` exit0（124 Markdown、2767 链接、1666 锚点、139 token、31 对比度）。

**未覆盖**：五项反例的真实 API/PG 故障恢复与文件副作用、真实 Windows 窗口内观察、原生目录选择、中文 IME、系统 DPI 与内容缩放、关闭重开、安装/升级/卸载均未跑，仍保持未验收；独立验收（指定 `gpt-6.1-sol`）本轮不可用，未以自检替代。既有 `apps/api` 备份还原注册表 4 例 `BACKUP_PACKAGE_INVALID` 未处理。未外呼 Provider、未重建桌面包，M/N 阶段总出口不变。

**并行 Agent 在途改动导致的当轮红灯（如实记录，未覆盖、未回退）**：本轮收尾复跑时，另一 Agent 正在同一工作区实现转录区吸顶（新增 `src/lib/assistTranscriptPin.ts`、`tests/assistTranscriptPin.spec.ts`，并改 `AppShell.tsx`、`AssistView.tsx`、`AssistView.css`、`collaborationWorkspace.spec.ts`，最后一次写入 22:32–23:04）。全量组件因此在 79→80 文件、621→630 用例之间波动，出现 2–5 例失败，**全部集中在该吸顶工作**（`assistTranscriptPin.spec.ts` 的「部分露出也算还在视野里」与 `collaborationWorkspace.spec.ts` 的三条吸顶断言）。按共享工作区约束本轮未覆盖、未回退、未修改这些文件。**隔离复核**：排除该 Agent 正在写的 `collaborationWorkspace.spec.ts` 后，本切片涉及的 7 个 spec **58/58 通过**；`folderFirstConversation.spec.ts` 单独 **13/13**。本轮五处修复在该 Agent 改完后的源码中仍全部在位（已逐处核对 `FirstMessageOwner`、`pending.resourceId`、`adoptedRequestId`、`interpreted` 声明、`firstContent` 续发与 `requestFolderTransition`）。当前全量红灯属对方在途工作，不构成本轮结论。

**同一在途工作随后影响浏览器套件**：Goal 轻量入口切片收尾时，真实 Chromium 连跑 3 次为 36–37 通过 / 1–2 失败，失败恒为 `uiOption2FirstSession.spec.ts:380`「复制是纯客户端剪贴板动作」——`locator.click` 在 `assist-copy-a-0` 上等待 *visible, enabled and stable* 直至 30s 超时。该 Agent 新增的 `.agent-message-slot[data-pinned="true"] { position: sticky }`（`AssistView.css:70`）使消息槽在滚动容器内吸附，元素停在吸附边界时不再满足 Playwright 的 stable 判定。本切片不修改转录区、`assist-copy` 按钮或该 CSS；按共享工作区约束未覆盖、未回退、未放宽断言。此前同一轮还复现过 `R02` 偶发（见上）。两项均判归对方在途工作。

**浏览器套件的 `R02` 偶发（本轮复现，与本轮改动无关）**：真实 Chromium 全量连跑 5 次为 3 次 38/38、2 次 37/38，唯一失败恒为 `workbench.spec.ts:145` 的 `R02：创建页草稿会拦截侧栏和浏览器返回`。该用例全程只在 `/tasks?view=create`，其两个对话框文案由 `App.tsx:126/130/133` 的应用级 `useBlocker` 提供；`CollaborationView` 只挂在 `router.tsx:31` 的 `/agent`，本轮改动的 `AssistView`/`CollaborationView` 在该用例中从不渲染。断言未放宽，与 §10.5、§10.9 登记的同一既有时序不稳定一致。

### 10.9 页面原型结构对齐（2026-10-03）

用户以「页面原型 vs 实际截图」提出 7 处差异并要求对齐。**原型是静态图，只用来定结构与层级，不用来抄像素**：所有宽度都是 rem token，跟随根字号与用户缩放；回归断言的是相对关系（卡片上限 > 消息列上限、上限单位是 rem），不是某个绝对距离。**Breaking Change：No**（未改路由、命令 Owner、HTTP 契约、数据库与权限），但**改了两处既有设计决定**，见下表「与旧规则的冲突」。

| # | 差异 | 处理 | 与旧规则的冲突 |
|---|---|---|---|
| 2 | 消息列被卡在 800px，宽窗时两侧各空约 440px | `layout.reading.maxWidth` 由 `50rem` 放宽到 `60rem` | 无。数值仍只在 `design-tokens.json` 一处 |
| 3 | 输入卡与消息列被同一条规则绑成同宽 | 同日按用户要求**保持同宽并合并为单一 token**：`layout.reading.maxWidth` 60→72rem，删除当日新增的 `layout.composer.maxWidth`。消息流改为铺满中栏（滚动容器 full-bleed），阅读 measure 由居中的 `.agent-message-list` 收窄 | 与原型「卡片比消息列宽」不同，是用户后续明确指示；滚动容器 full-bleed + 内容列居中取自 deepseek-harness `ChatView.module.css:54-63` |
| 4a | `/agent` 多一行面包屑 | `/agent` 不再渲染面包屑；连带删除因此变成只写的 `workTrail` state 与其取数 effect（每次进工作台多两次无用读取） | **与 §17.7 冲突**：面包屑原是项目/任务上下文的常驻来源。现改由页头 `collab-current-need` 那行承载，标题的 `titleHref` 仍是返回确切任务的入口 |
| 4b | 页头多一行「只有 READY 的任务可委托」 | 移除该常驻行 | **与 §17.7 冲突**：原文要求委托准入被拒的原因必须留在首屏。现由「更多操作」内的 `TaskDelegatePanel` 就地显示，原因不再丢失但不再常驻 |
| 5 | 底部整宽「消息已排队」提示条 | **未删除**：`notice` 是 7 处命令回执共用机制，直接删会连带砍掉「受托已受理」「原命令被拒绝」等反馈。改为渲染在输入器这一列内，不再横贯工作区 | 与原型不一致，属有意保留 |
| 1 | 左栏无搜索框 | 复用全局 `.search-field` 原语新增搜索框，**只筛已加载范围**，并同时显示「已加载 N 项」与无匹配说明，不假装是全量搜索 | 无。未新增服务端搜索 |
| 6 | 对话下方「未读取资料 + 复制/赞/踩」 | **只做复制**：生产代码没有 `未读` 领域概念，赞/跌也没有写路径，照原型画就是假入口。复制是纯客户端剪贴板，挂在每条已完成 AI 回复上，不落库 | 另两项按用户决定推迟 |
| 7 | 疑似双滚动条 | **实测不是缺陷**：`.collab-center` 内真正溢出的纵向滚动容器只有 `.agent-chat-transcript` 一个，断言已固化为回归 | 无 |

**改动清单**：`AssistView.css`、`styles.css`、`AssistView.tsx`、`CollaborationView.tsx`、`AppShell.tsx`、`RecentWorkRail.tsx`、`design-tokens.json`；测试 `uiOption2FirstSession.spec.ts`（新增 6 条真实 Chromium 结构用例）、`collaborationWorkspace.spec.ts`、`workBreadcrumbScope.spec.ts`。

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | exit0 |
| `npm run build` | 通过（JS 1337.90 kB / gzip 365.14 kB） |
| 全量组件回归（Node 24.21.0，`--maxWorkers=1`） | 79 文件 **612/612 通过**，378.71s |
| 真实 Chromium 结构对齐用例 | 新增 6 条 **6/6 通过** |
| 真实 Chromium 全量套件 | 34 项中 33 通过 |

**`R02` 偶发与归因**：全量浏览器套件唯一失败是既有 `R02`（创建页草稿拦截浏览器返回，`workbench.spec.ts:157`），属 §10.5 已登记项。为避免把锅甩给本轮，用 `git worktree` 在 HEAD `20a9254` 上单独复跑该用例 4 次：**HEAD 3 失败 / 1 通过**，与本轮工作树的 3 失败 / 1 通过一致，且该用例全程只在 `/tasks?view=create`，不渲染本轮任何改动。判定为既有时序不稳定，与本轮无关；断言未放宽。

**本轮未覆盖**

1. 窄窗、200% 内容缩放与真实 Windows 窗口内的观感未取样；宽度是 rem token，但各断点下的实际观感仍需真实窗口确认。
2. 「未读资料」与「赞/跌」未实现，需要新增领域状态与写路径，超出本轮范围。
3. 左栏搜索只覆盖已加载页；跨项目全量搜索需要新增服务端查询，未做。
4. §10.5 的 `R02` 偶发、`apps/api` 备份还原注册表 4 例 `BACKUP_PACKAGE_INVALID`、并行 Agent 未提交的 `tool-loop-action.ts` 编译错误均未处理。

**输入区二次调整（2026-10-03，按参考图）**

| # | 差异 | 处理 | 依据与限制 |
|---|---|---|---|
| 宽度 | 消息列与输入器不同宽 | 两者合并为同一 `layout.reading.maxWidth`（72rem），当日新增的 `layout.composer.maxWidth` 已删除 | 宽度必须一致，否则滚动条会贴着其中一侧 |
| 资料/讨论 | 带边框的方盒、无展开指示 | 改无边框 chip + 右侧 chevron（打开时旋转 180°），两枚 chip 之间一条竖分隔线；去掉 `+ / −` 前缀符号 | `deepseek-harness` `InputBar.module.css:337-358` 同为无边框 + 右侧 chevron，但它用 `gap: 12px` **不用**分隔线；分隔线按参考图保留，属有意偏离上游 |
| 拖拽调高 | 分隔线删了但仍能拖 textarea 改高度 | `resize: none` | vercel-ai `chat-input.tsx:47-48` 聊天输入器同样 `resize-none`；deepseek-harness 用 contenteditable + CSS 封顶，也无拖拽把手。四个检出均无自定义 resize 把手实现 |
| 回到最新 | 带文字、带底色、靠右 | 只有图标，透明背景、无边框、无阴影，水平居中 | deepseek-harness `ChatView.tsx:287-298` 同为 icon-only + `aria-label`，但它是**实心**圆按钮靠右；此处按要求改为透明居中 |
| 发送键尺寸 | 比常规按钮小一号 | 改为「圆心与卡片圆角圆心重合」：边长 `calc(2 × radius.control)` = 16px，完整落在卡内 | 见下方几何说明 |
| 滚动条 | 聊天区内出现滚动条 | 消息流改为铺满中栏的滚动容器（full-bleed），阅读列居中收窄 | deepseek-harness `ChatView.module.css:54-63`「the scroller itself stays full-bleed」；vercel-ai 无此做法 |

**发送键几何（已实装，含一处未做到的约束）**

圆角圆心只由卡片外框与 `radius.control`（8px）决定，**与卡内边距无关**，恒在卡片外框内 8px 处。要让键的圆心落在该点且不越界，键的边长上限就是 `2 × 8 = 16px`——这就是「改变形状大小去适配」的唯一无越界解，已按此实现：键绝对定位在卡片右下角，边长 `calc(2 * var(--relay-radius-control))`，圆角同值，因而与卡片圆角同心。

1. **16px 的 painted 尺寸低于可点击目标下限。** 用 `::after` 把命中区扩到 `control.target.minimum`（24px），符合 WCAG 2.5.8「达标看命中区」。回归同时断言 painted 尺寸 = 2×radius、圆心偏差 ≤1px、命中区 ≥ 下限。
2. **「该行所有元素做相同的垂直位移」未能实现，是几何硬约束。** 圆角圆心恒在底边内 8px 处；任何高于 16px 的元素若以它为竖直中心必然越过卡片底边。资料/讨论 chip 为 40px（`control.height`），做不到与 16px 的键同位移而不越界。因此保留 `align-items: center` 的同行居中，未强行位移。若必须同位移，只能把 chip 压到 ≤16px（低于可点击目标下限）或放大卡片圆角——两者都已被用户当前指示排除。

**本轮新增真实 Chromium 回归（4 条）**：输入区无横线 + `resize: none` + 发送键同心与命中区；资料/讨论无边框 chip + chevron + 竖分隔线；回到最新无文字/透明/水平居中（偏差 ≤1px）；消息列与输入器同宽 + 滚动容器铺满中栏 + 阅读列在内容盒内居中。

**本批验证**：typecheck exit0；build 通过；真实 Chromium 对齐用例 **14/14**；浏览器全量 **38/38**（`R02` 本次通过，该用例仍是 §10.5 登记的偶发项）。全量组件回归结果见本节后续记录。

**仍未覆盖**：窄窗/200% 缩放/真实 Windows 窗口观感；命中区扩展在真实指针与触屏下的手感；跨项目全量搜索；未读资料与赞跌；`apps/api` 备份还原注册表 4 例 `BACKUP_PACKAGE_INVALID`；并行 Agent 未提交的 `tool-loop-action.ts` 编译错误。

### 10.10 输入区三次调整（2026-10-04，按参考图与 Codex 输入框）

**输入区三次调整（2026-10-04，按参考图与 Codex 输入框）**

| # | 差异 | 处理 | 依据与限制 |
|---|---|---|---|
| 左右头像 | 每条消息左侧/右侧有头像 | **删除头像元素与相关样式** | 角色已由「我 / AI」标签与气泡位置区分，头像只是重复占位并挤窄正文列 |
| 「消息已排队」 | 每次发送后底部提示「消息已排队；回复状态以服务端消息为准。」 | **删除这条 notice** | 它只复述已提交的 202 回执，不携带新事实；消息的 PENDING/RUNNING 状态已在消息行说明。**其余 notice 保留**（取消意图、提案接受回执、原命令回执），它们各自说明不同结果，仍渲染在输入器列内 |
| 发送键尺寸 | 16px 太小 | 键放大到 **32px**：新增 `radius.composer = 1rem`，输入器卡片改用它，键边长 `calc(2 × radius.composer)` | 键要与卡片圆角同心且不越界，边长上限就是 `2 × radius`；8px 圆角只容得下 16px 的键，所以圆角必须同步放大 |
| 发送键形状 | 方形 | 改为**正圆**（`radius.round`），直径 `2 × radius.composer` | 直径等于 2×radius 的圆，圆心落在卡片圆角圆心上时与下边、右边**同时内切**，正好穿过圆角弧两端——「圆心重合」在这里是精确相切而非近似。形状参考 Codex 的圆形发送键，配色与版式仍用本项目 token |
| 底栏左侧行高 | 与键不同高 | `.agent-chat-composer-tools` 及其 chip 取 `min-height: calc(2 × var(--relay-radius-composer))`，与键**由同一个 token 推导** | 32px 已高于 `control.target.minimum`（24px），可点击目标不再依赖 `::after` 扩展 |

**「该行所有元素做相同垂直位移」这条仍未实现，且现在是明确放弃而不是遗漏**：圆角圆心恒在卡片外框内 `radius.composer` 处；任何高于 `2 × radius.composer`（32px）的行内元素若以它为竖直中心必然越过卡片底边。底栏左侧 chip 高度已取到与键相同的 32px，此时整行以同一中心对齐；若再把它下移到圆角圆心，32px 的行会跨过底边 16px。因此保留 `align-items: center` 的同行居中。

**本批新增/调整的真实 Chromium 回归**：消息行无头像 + 发送后无「消息已排队」（1 条）；发送键同心、正圆、放大到 32px、底栏左侧行高与键一致（并入原同心用例）；原「命令回执落在输入器列」用例**已删除**——发送路径不再产生任何 notice，前置动作无法触发提示，保留即空断言。**已知覆盖缺口**：其余三类 notice（取消、提案回执、原命令回执）仍渲染在输入器列内，但当前浏览器夹具无法可靠触发，其版式不再有自动化断言。

**本批验证**：typecheck exit0；生产构建通过；真实 Chromium 对齐用例 **14/14**；浏览器全量 **38/38**；全量组件回归（Node 24.21.0 单 worker）见本节记录。

**底栏底部对齐修复（2026-10-04）**：用户截图指出「输入框底部没有对齐」。原因是底栏那一行仍压在卡片 `padding-bottom`（12px）与自身 `padding-bottom` 里，而绝对定位的发送键 `bottom: 0` 是相对卡片 padding box——两行底边因此差 20px，视觉上左侧 chip 明显浮在按键上方。修法：底栏 `margin-bottom: calc(-1 * var(--relay-space-3))` 抵消卡内下边距、`padding-bottom` 归零，使整行底边与键底边同在卡片内缘；两者同为 `2 × radius.composer` 高，竖直中心自然重合。回归断言底栏与按键的竖直中心偏差 ≤1px。

**过程中发现并修掉一个自己引入的真实缺陷**：首次打补丁时把三行说明文字插在上一段注释的 `*/` 之后，成了注释块外的裸文本，CSS 解析器随即丢弃紧随其后的整条 `.agent-chat-composer-actions` 规则——表现是底栏所有 padding/margin 计算值全为 `0px`。是靠浏览器实测（computed style 全 0）定位的，不是靠读代码猜的。已修正注释块并加了一次「注释块外不得有裸中文行」的静态校验。教训：用脚本改 CSS 时，插入位置必须落在注释块内部，改完要回读确认解析结果，不能只看 diff。

**本轮最终验证（2026-10-04）**：typecheck exit0；生产构建通过；全量组件回归（Node 24.21.0 单 worker）79 文件 **612/612**；真实 Chromium 对齐用例 **14/14**；浏览器全量 **38/38**。`node scripts/check-docs.mjs` exit 0。唯一仍未闭合的是本节记录的 notice 版式覆盖缺口，与并行 Agent 未提交的 `apps/api` 编译错误。

### 10.11 多轮上下文核对与重复消息复读（2026-10-04，只记录不改代码）

**用户报告的现象**：协作页同一会话连发三条内容相同的「你好」，AI 三次回复逐字相同，且输入 token 只从 1947 涨到 1985，用户据此怀疑「Agent 没有上下文」。

**核对结论：上下文正常，重复回复是模型行为。** 取证方式为直接读运行中的真实库（本机 `relay_trial`，`assist_sessions.title` 含 `1790646373833` 的会话，共 20 条消息），不是靠读代码推断。输入 token 增量与「新加入的那一轮」逐轮精确对应：

| assistant seq | 本轮用户输入 | 输入 token | 增量 |
|---|---|---|---|
| 12 | 你好 | 1808 | — |
| 14 | 你现在能改文件吗 | 1831 | +23 = 该用户句约 10 + 上轮回复 9 + 角色开销 |
| 16 | 你好 | 1947 | +116 = 「你好」2 + seq 14 那条 106 token 长回复 + 开销 |
| 18 | 你好 | 1966 | +19 = 「你好」2 + 上轮回复 9 + 开销 |
| 20 | 你好 | 1985 | +19 = 同上 |

若历史未发送，同一输入的三次调用 token 数应完全相同（增量恒为 0）。代码路径与之一致：`assist-commands.ts` 分配 USER `seq` / ASSISTANT `seq+1`；`listCompletedHistory` 取 `seq <= assistantSeq AND status='COMPLETED'`（`assist-repository.ts:104`），配对的用户消息必然在内；`openai-compatible-model-port.ts:150` 将 `turns` 逐条映射为 Human/AIMessage 原样发出。**注意排除一个误读**：seq 2 的首条回复里出现「继续讨论 UI 取证相关」，那句来自 scope 头的 Project 标题「UI取证-20260929 空项目B」，**不是**历史，不能当作上下文已送达的证据。

**复读的真实成因**（模型侧，非上下文缺失）：`temperature: 0` 贪心解码（`openai-compatible-model-port.ts:78`）+ 末轮结构同构——历史中已存在「你好 → 你好！有什么需要我协助的吗？」，当前末句又是「你好」，复制上一轮即最高概率延续。反证：seq 10 的「你好」因上一轮问的是别的问题，回复明显不同；seq 12 是**首次**连续「你好」就已塌成通用问候。

**已知能力缺口（用户选择本轮只记录、不改代码）**：提示词未告知模型「用户可能重复发送同一条消息」，代码也没有去重或提示，该模型在此情形只会复读。后续若要处理，最小改动是在 `systemPromptFor('DISCUSS')` 增加一条约束（不逐字复读上一条，改为指出重复并追问真实意图），不改路由/命令 Owner/HTTP 契约/数据库，无 Breaking Change。**本项未修改任何代码，未跑任何测试，不构成任何功能通过或修复结论。**

### 10.12 缓存命中率与上下文占用的诚实舍入（2026-10-04）

**改动范围**：仅 `apps/workbench/src/views/AssistView.tsx` 的 `ContextMeter` 展示层，新增模块级纯函数 `formatUsagePercent`，并为两处百分比各加一条回归。**未改** API、数据库、Provider 适配、命令 Owner、权限与 `data-testid`；`design-tokens.json` 未新增数值（只改算法不改视觉）。**Breaking Change：No。**

**修复的两个缺陷**（均先写测试确认在旧实现下失败）：

| 缺陷 | 旧行为 | 新行为 |
|---|---|---|
| 部分命中被四舍五入成满命中 | `input=1000, cache_read=996` 显示「缓存命中 100%」——把 4 个 token 未命中读成完美命中，方向最坏 | 显示「缓存命中 99.6%」 |
| 上报超出分母未钳制 | `cache_read=1200 > input=1000` 显示「缓存命中 120%」 | 钳到「缓存命中 100%」 |

**分母口径经源码核对后确认不变**：Relay 两条 Provider 路径（`model-port-verify.ts:198` 读 `usage.prompt_tokens`；`openai-compatible-model-port.ts:232` 读 `usage_metadata.input_tokens`）都是 OpenAI 兼容语义，`input_tokens` 已含 cached 部分；迁移 `0049` 的 `ck_model_calls_cache_within_input` 约束 `cache_read + cache_creation <= input_tokens` 与之一致。**因此未采用 deepseek-harness 的三桶求和公式**——该式成立是因为 DeepSeek 原生 API 的 cache 与 input 互斥，语义相反，照抄会算错。只借鉴其「不让部分命中显示成 100%」的意图并简化为整数阈值舍入。上游对照归[研究 §1.4](../../research/p00-source-study.md)，规则归[工作台 §18.6](../../frontend/workbench-design.md)。

**验证**：算法正确性另以穷举核对（分母 1–2000、分子 0–分母−1，共 2,001,000 组合）：`value < limit` 时输出 `100` 的次数为 **0**，最大值 `99.9`；`value >= limit` 恒为 `100`。四条既有场景（`75%`/`未采集`×2/`尚无模型调用`）结果不变，作为回归保护未改。工程出口：两端 `tsc --noEmit` exit 0、生产构建 exit 0、组件回归 **79 文件 615/615**、`node scripts/check-docs.mjs` exit 0。

**过程中修掉的两处他人未提交缺陷**（非本轮设计范围，但阻塞全部验证，且修复意图无歧义）：`AssistView.tsx` 的 props **类型**声明了 `firstMessageOwner`/`firstMessageProcess`、函数体也读取它们，但**解构模式漏绑**导致 `ReferenceError` 使整个组件无法渲染；`pendingFirstMessage`/`onPendingFirstMessageChange` 反之——解构已绑、类型未声明。`firstMessageOwner` 经 `git show HEAD` 确认在 HEAD 中不存在，属并行 Agent 未提交的重构缺口。本轮只补这两组绑定与其类型声明，未改其重构逻辑。

**覆盖缺口（如实记录）**：未跑真实 Windows 窗口观察、浏览器验证与真实 Provider 读数；`9999/10000` 一类两位小数读数（显示 `99.9`）无组件断言覆盖，仅由穷举核对覆盖「不出现假 100%」这一不变量。**本项不改变 M04–M07 与 N 阶段任何状态。**

**同项追加：N00 基线脚本扩缓存命中率测量（2026-10-04）**。只扩 `apps/api/scripts/n00-baseline.mjs` 的既有聚合，**未新增端点、表、迁移或页面**（Trace 响应 `trace-api.ts:34-35` 本就返回两个缓存字段，脚本此前取到未用）。新增：路径级 `cache_hit_percent_total`、`cache_read/creation/basis_input_tokens`、`cache_reported/unknown_calls`，以及按 `started_at` 排列的 `cache_by_call` 逐调用序列（用于定位前缀失效断点）；报告新增「缓存命中率」小节。**口径**：`null` 表示 Provider 未上报，报告显示「未采集」，绝不按 0% 计。`node --check` exit0。

**真实库核对（本机 `relay_trial` 的 `model_calls`）**：15 次调用、18394 输入 token、`usage_cache_read_tokens` **上报数为 0** ——朴素算法会输出 0%，真实情况是该 Provider 从未上报缓存字段，新口径输出「未采集」。这正是必须区分 null 与 0 的实证。另以三组合成数据核对聚合逻辑：前缀稳定（60%）、前缀每轮失效（0%）、混合上报（分母只算 2 次已上报调用得 4000 而非 5000，命中率 50%）。

**本项未产出任何真实命中率基线**：`n00-task-set.json` 三条路径的 `runs` 仍为空，且本机无稳定的真实 Provider 多轮长会话——命中率只在多轮带长前缀时才有意义。因此**不得声称命中率已提升或已测得**。上游机制对照与口径依据归[研究 §1.4](../../research/p00-source-study.md)与 §1.5。

### 10.13 用户消息在视野外时吸顶（2026-10-04）

**需求**：AI 回复很长时，让人知道眼下这段正文是从哪条原始消息来的。**规则与视觉约束**归[工作台 §18.6.1](../../frontend/workbench-design/part-06.md#1863-已回退用户消息吸顶2026-10-04-实施同日回退)。**改动**：新增 `apps/workbench/src/lib/assistTranscriptPin.ts`（纯判定函数）、`AssistView.tsx` 的 `pinnedUserMessageId` state 与 `syncPinnedUserMessage`、`AssistView.css` 一条 `.agent-message-slot[data-pinned="true"]` sticky 规则。**未改**路由、命令 Owner、HTTP 契约、数据库、权限、`data-testid` 与既有 `assist-latest`；`design-tokens.json` 无新增数值（只复用 `color.bg.canvas`）。**Breaking Change：No。**

**首版实现有两个真实缺陷，均由用户截图与真实 Chromium 用例暴露，不是靠读代码发现：**

| 缺陷 | 现象 | 根因 | 修法 |
|---|---|---|---|
| 长消息被遮挡 | 吸顶行的不透明底色盖住上方那条还露在视野里的用户消息 | 初版只判「顶边越过上沿」取最后一条。长用户消息顶边早越过，而它**下面**那条越得更彻底，于是选中下面那条，正好盖住长消息剩余部分 | 判定改为「视野里没有任何用户消息」——用户自己看得见的那条就不提示，也就不会被遮挡 |
| 吸顶凭空出现在半空 | 最新那条还在视口下方 1019px 时被吸到上沿 | 「视野里没有用户消息」成立，但候选顶边尚未到达上沿，sticky 只能按住已该滚出的行 | 增加第二条：候选顶边必须已越过上沿 |

**第三条修正是 Chromium 用例量出来的 `offset = 1019px` 逼出来的**，不是推测：`position: sticky` 生效后被钉行顶边恒等于容器上沿，即它永远「可见」；若把它算进「视野里还有用户消息」，每次滚动都会取消吸顶、下一帧又吸上，**来回抖动**。因此可见性判定必须排除当前被钉的那条（纯函数第三参 `ignoreIndex`）。

**验证（本轮实际跑出的结果）**：判定规则纯函数 `assistTranscriptPin.spec.ts` **7/7**，含长消息遮挡、压线、容器偏移与空列表；组件回归 `collaborationWorkspace.spec.ts` **71/71**（新增 4 例：视野内不显示/视野外吸顶、长消息不遮挡、AI 行永不被选中、隐藏布局不重算），几何按文档坐标 + `scrollTop` 推算以保证滚动自洽；受影响三文件 **87/87**；两端 `tsc --noEmit` 对本轮文件无错；`node scripts/check-docs.mjs` exit 0。全量组件回归 **81 文件 637/638**，唯一失败 `run-events.spec.ts > 断线以已消费 seq 补历史` 单跑 **5/5 通过**、全量稳定失败，`git diff --name-only` 确认本轮未触及 `run-events.spec.ts` 与 `RunView`，判为并发下既有不稳定，**未因此放宽断言**。

**未覆盖出口（如实记录，不声称通过）**：
- **真实 Chromium 几何验证被既有布局缺陷阻塞**：`.collab-center` 的转录容器当前被压到 **16px 高**（`.collab-center` 实测 672px，而 `scrollHeight` 1616px）。`styles.css` 正被并行 Agent 大幅改动（45 增 21 删），该压缩当时无法在不动他人未提交工作的前提下归因修复。两条浏览器用例因此**显式 `test.skip` 并附原因**，不是假通过。吸顶的真实 sticky 几何与不透明底色遮挡效果**尚未取得浏览器证据**。该布局缺陷已于同日定位并修掉，见 [§10.15](part-19.md#1015-转录容器-16px-视口缺陷已修2026-10-05)；吸顶功能本身随后按 §10.14 整体回退。
- 该浏览器套件另有 1 例既有失败「复制是纯客户端剪贴板动作」：已用 `git stash` 移除本轮 `AssistView` 改动后复跑**照样失败**，确认与本轮无关。
- 未跑真实 Windows 窗口观察、真实 Provider 会话、原生 IME、DPI 与内容缩放。真实窗口下的观感与长消息体验未验。
- 并行 Agent 的未提交文件（`CreateGoalView.tsx`、`createGoalEntry.spec.ts`、`zz-debug.spec.ts`）当前使 `tsc --noEmit` 报 6 处错误，均不在本轮文件内，按共享工作区约束未覆盖。

**本项不改变 M04–M07 与 N 阶段任何状态。**

**同项追加：人工反馈后的两处修正（2026-10-04）**。用户在真实窗口试用后指出两点：①「我 / 时间」那两个字样被推得很右、不跟消息走；②生成中三点动效消失。

| 反馈 | 根因 | 修法 |
|---|---|---|
| 「我 / 时间」不在右侧 | 用户消息是 `row-reverse` 的右对齐气泡，meta 是气泡第一个子元素、落在气泡内侧；消息短时那两个字停在离右缘很远的位置 | meta 相对整行绝对定位右对齐；脱离文档流后用 `::before` 补回等高一行防止正文上移。气泡宽度与右对齐不变 |
| 三点动效消失 | **不是动效被禁用**，是三点根本没渲染：渲染条件含 `content === null` 且排除「preview 可读」，preview 一到达条件就为假，流式输出期间唯一的活体信号整段消失，只剩静态草稿文字 | 三点改为 `RUNNING`/`PENDING` 期间一直显示，与有无正文、预览无关；取消中不显示 |

**本轮验证**：新用例在**回退实现后确认失败**（`expected false to be true`，preview 到达后三点消失），恢复修复版后 `assist-preview.spec.ts` **7/7**。

### 10.15 转录容器 16px 视口缺陷已修（2026-10-05）

**用户报告的现象**：输入框上方与消息区之间有一条读不到文字的空白带，最新回复看不全。§10.13 与 §10.14 两次记为「被既有布局缺陷阻塞、无法在不动他人未提交工作的前提下归因修复」的那个缺陷，本轮已定位并修复。

**取证方式**：用真实 Chromium 夹具逐层量 `getBoundingClientRect` 与 `getComputedStyle`，不是读代码推断。缺陷态下 `.collab-center` 高 672px，`.agent-chat-transcript` 只有 **16px**（正好一行文字高），`scrollHeight` 3322px，最新一条 995px 高的回复只有 8px 落在滚动窗口内。

**根因（三处，缺一不可）**：

| # | 元素 | 实测 | 机制 |
|---|---|---|---|
| 1 | `.agent-assist` | `flex: 1`（`flex-basis: 0`） | `basis:0` 时该项不按内容参与收缩，同列目录范围条占 424–478px 也不肯让出高度，整列只剩 174px |
| 2 | `.assist-queue` 空态 | `min-height: 4.5rem`（72px）、`visibility: hidden` | 原本为「0↔1 时转录区高度不跳动」预留的**不可见占位**，于是每一条会话都在输入器上方永久留出一条 72px 空白带 |
| 3 | `.execution-summary` | `flex: 0 1 auto` + 默认 `min-height: auto` | flex 项目默认拒绝缩到内容以下，267px 的摘要反过来把转录区压没 |

三处都作用在「这一列里唯一可伸缩的转录区」上，所以它被挤成一条缝；**没有任何元素绘制在文字之上**，视觉上的「遮挡」是高度没分配给文字。

**改动**：`AssistView.css`（转录区 `flex: 1 1 auto` + 阅读下限、空队列不占位）、`CollaborationView.css`（`.agent-assist` basis 改 `auto`）、`FolderScope.css`（执行摘要 `min-height: 0`）。**Breaking Change：No**（纯展示层，未改路由、命令 Owner、HTTP 契约、数据库、权限与 `design-tokens.json`）。规则归[工作台 §18.6.0](../../frontend/workbench-design/part-06.md#1860-消息区高度不再被同列区块挤没2026-10-05)。

**新增回归 1 条**（`uiOption2FirstSession.spec.ts`「空队列占位不占高度，消息区不被输入器上方的空白挤掉」）：空队列占位零高度、消息区与输入器之间无任何不可见占位、消息区高度守住绝对下限 96px 且占中栏 >15%、滚动位置已跟随最新。**先写断言并确认它在缺陷实现下失败**（`queueHeight` 实收 72、`transcriptHeight` 实收 16），再改实现。

**一处断言口径修正**：「对话区只有一个纵向滚动容器」原先扫描 `.collab-center` 全部后代，修复后目录范围条展开时会自己滚动（`max-height: 40%`，实测内容 485px）而被计入。它是消息区上方的**上下文入口**，不是对话区的一部分，断言改为排除 `.folder-scope-bar` / `.collab-existing-work` 子树；对话区内部仍只允许消息流一个滚动 Owner，断言未放宽到「一个也没有」。

**本轮验证（实际跑出）**：`tsc --noEmit` exit 0；全量组件回归 **89 文件 730/730 通过**；真实 Chromium `uiOption2FirstSession.spec.ts` **16/16 通过**；`node scripts/check-docs.mjs` exit 0。

**如实记录的覆盖缺口**：

- 未跑真实 Windows 窗口观察、系统 DPI 与内容缩放（200%）、中文 IME。缺陷态与修复态的几何证据均来自真实 Chromium 1280×720 与 2000×1140 两个视口，真实窗口观感仍待验证。
- `run-events.spec.ts > 断线以已消费 seq 补历史` 在全量跑批中偶发失败、单跑 4 次全通过；§10.13/§10.14 已登记为并发下既有不稳定，本轮连跑全量 3 次均 730/730，**未因此放宽任何断言**。
- 目录范围条展开时的内部滚动是新增的第二个滚动容器。它只在用户主动展开上下文面板时存在，收起时对话区仍是唯一滚动 Owner；是否改为完全折叠以彻底消除双滚动条，属产品决定，本轮未做。

**本项不改变 M04–M07 与 N 阶段任何状态。**

### 10.14 吸顶已回退、「我 / 时间」贴右缘两次返工（2026-10-05）

**吸顶部分已按用户要求整体回退**：删除 `src/lib/assistTranscriptPin.ts` 与 `tests/assistTranscriptPin.spec.ts`、`AssistView` 的 `pinnedUserMessageId` state / `pinnedUserMessageIdRef` / `setPinnedUserMessageId` / `syncPinnedUserMessage` / `userMessageIds`、`AssistView.css` 的 `.agent-message-slot[data-pinned="true"]` 规则、`<li>` 上的 `data-pinned` 属性、`collaborationWorkspace.spec.ts` 中 4 条吸顶用例与几何桩、2 条吸顶浏览器用例，以及并行 Agent 为该功能新建的 `tests/assistStickyPinSync.spec.ts`（功能已回退，其配套测试必然失败，属本次回退范围）。**未回退**的是同日单独提出并确认的「我 / 时间」贴整行右缘与三点常显两项，规则归[工作台 §18.6.1](../../frontend/workbench-design/part-06.md#1861-用户消息的我-时间贴整行右缘2026-10-04)与 [§18.6.2](../../frontend/workbench-design/part-06.md#1862-三点是这条还在跑的持续信号2026-10-04)，回退原因归[§18.6.3](../../frontend/workbench-design/part-06.md#1863-已回退用户消息吸顶2026-10-04-实施同日回退)。

**回退原因（如实记录）**：该功能在实现期连续暴露三个真实缺陷（长用户消息被遮挡、候选未到上沿被拽到半空、sticky 生效后被钉行自身「永远可见」导致吸顶/取消来回抖动），修完仍引入 `setState` 自我触发的无限循环（`Maximum update depth exceeded`），需改用 ref 绕开；同时浏览器几何验证长期被既有布局缺陷阻塞（转录容器视口 16px，该缺陷已于同日修掉，见 §10.15），只能靠人工观察。

**「我 / 时间」贴右缘的返工（2026-10-05）**：用户用真实截图指出 meta 绝对定位后**「我 / 时间」压在第一行正文上**。新增 Chromium 几何断言量到实际重叠 **13px**，确认不是观感问题。最终方案为「meta 留在文档流 + 横向负外边距贴边」。方向全部靠实测纠正，右缘偏差依次为 **32px → 16px → 16px → 0**，分别对应四个被忽略的约束：`row-reverse` 下负外边距方向相反、`right` 的内边距、`justify-content` 对单行 `flex-wrap` 容器无效、`.agent-message-body > *` 的 `max-width: 100%` 抵消负外边距。

**断言自身也修过一处**：曾把「贴右缘」绑死在 `<time>` 与「我」上，而夹具消息可无 `created_at`，量的是错对象、报出 16px 假象。改为断言 **meta 最后一个可见子元素** 的右缘，并同时覆盖「正文起点不低于 meta 盒底」。

**最终验证**：全量组件 **85 文件 668/668 通过**（多于回退前，含并行 Agent 同期补入的用例）、两端 `tsc --noEmit` exit 0、真实 Chromium `uiOption2FirstSession.spec.ts` **15/15 通过**、`check-docs` exit 0。**仍未覆盖**：真实 Windows 窗口观察、原生 IME、DPI 与内容缩放；转录容器 16px 视口的既有布局缺陷当时未修，已于同日修掉（见 §10.15）。

**本项不改变 M04–M07 与 N 阶段任何状态。**

## 条目 328

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| P1-B 成员私聊、群聊与消息（ADR-034 包 B 服务端记录面）（2026-10-25，当前 Agent 实施＋自检，未 commit/push） | **部分通过（持久记录/定向/幂等/终止/闸门后端已验；成员回信、唤醒、消费、UI 未实现）**：迁移 `0140` 两表——会话表以部分唯一索引表达「私聊一成员一线程、群聊一项目一线程」，`OPEN/CLOSED`＋六种终止原因码（关闭保留记录可重开）；消息表持久身份＋seq 会话内唯一＋定向接收者数组（群聊空集＝未定向由协调者接住，唤醒侧据此只唤醒谁，绝不默认广播全员）＋六种意图＋HANDOFF 受控载荷（键词表封闭、外键引用原事实，不复制业务状态）；`processing_status` 词表已含 CLAIMED/PROCESSED/FAILED 但消费循环归包 C。应用 Owner `member-conversations.ts` 三命令（Open/Send/SetStatus，command_id 幂等去重不依赖前端）＋三只读入口（列表/详情/游标消息）；闸门：开私聊与发送都要求成员 ACTIVE（停用拒发拒开、历史可读）、项目归档拒写、跨 workspace 404。消息不给成员任何额外权限（不产生执行权、不代答验收） | 真实临时 PG18.6＋HTTP `member-conversations.integration.test.ts` **5/5 PASSED**（一线程语义＋重放不新建；seq 递增＋同命令不重复＋私聊强制对方＋群聊定向校验/跨项目 404/未定向空集；HANDOFF 载荷键词表与互斥校验＋linked_task 外键引用；关闭需原因码/关闭拒发/重开清原因/CAS/关闭期间 seq 连续；停用拒收拒开历史可读＋归档拒写＋跨 workspace 404）；合并回归 agent-members＋member-conversations＋scheduled-tasks＋scheduled-task-p0a＋scheduled-task-detail-history 全绿（`run-integration.ps1 -UseCLocale` status PASSED）；API `tsc --noEmit` exit 0。契约 §10.114、数据库 §115、领域模型 §23 已同步。2026-10-25 同日由未参与实施的 Agent 在含并行改动的工作树上复验：`member-conversations` 5/5、agent-members＋scheduled-tasks＋scheduled-task-p0a＋scheduled-task-detail-history 回归 `run-integration.ps1 -UseCLocale` status PASSED、`tsc --noEmit` exit 0，上述记录仍成立（复验非独立验收） | 未验（PT-02/04 部分）：成员侧发送与互相唤醒（包 C，模型调用未接）；重复投递的消费幂等（消费循环未实现）；读取失权后的前端行为与群聊不广播全员的运行时证明（P2-A/C）；真实 Provider 语义质量；真实 Windows；独立验收未做 |

## 条目 330

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 成果与版本管理 P0–P2（2026-10-26，第二轮独立复验，未 commit/push） | **部分通过（P0 数据/API 与 P2 定向回归通过；桌面出口阻塞）**。P0-A：桌面脚本已改用当前“本轮接受”控件，明确分开 Project State 选用、阅读版本与完成接受，并增加多 Artifact 多版本集合及重启后原命令恢复断言。P0-B：0136 合法 Inbox/Project 数据迁移通过；历史跨 Workspace 冲突按 fail-fast 拒绝且不改写数据。P0-C：Artifact、Completion、Project State 与异常回执恢复集成通过。P2：确切来源/正文、版本比较、候选组依赖、陈旧及 UNKNOWN 恢复回归通过 | 迁移 `run-integration.ps1 -UseCLocale -TestFile migration -TestNamePattern '0136'` **2/2**，临时 PG 清理成功：合法路径迁移后 `relay_app` 跨 Workspace 插入收到 **23503 / fk_artifacts_workspace_task**；冲突分支为 **0136 / 23514**，原 Task/Acceptance/Artifact 数据摘要及 migration ledger 保持不变、无半完成约束。API `run-integration.ps1 -UseCLocale -TestFile 'api-artifacts,task-completion-pointer,artifact-impact-groups,artifact-direct-uses,verification,task-acceptance-command'` **6 套件 69/69**，build、业务迁移、Graph install、PG 启停 exit 0，临时集群清理成功；Workbench 10 个目标文件 **120/120**（Vitest 使用 host Node 22.22.3），便携 Node 24.21.0 直接运行 `tsc --noEmit -p apps/workbench/tsconfig.json` exit 0；两个桌面脚本由便携 Node 24.21.0 `--check` 通过。 | 本轮未取得当前 release 包：另一会话的 `build-release.ps1` 正使用共享构建路径，故没有启动竞争构建；真实 WebView2 多版本流程、关闭实例后重启恢复、Workbench Vite build、安装包均 **未验证**。P0/P1/P2 整体仍为 PARTIAL；不得升为模块整体完成 |

## 条目 331

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| P1-C 第一片：成员消息唤醒与消费结算（ADR-034 包 C 服务端唤醒循环，2026-10-25，当前 Agent 实施＋自检，未 commit/push） | **部分通过（唤醒裁决/成员回信/消费结算/MEMBER 计量后端已验；协调者自动推进、成员间定向唤醒、外部领取、巡检合并、Windows 生命周期与 UI 未实现，归后续片/P2-A）**：迁移 `0141`——消息表补领取/租约/attempts/结算列并以 CHECK 与 processing_status 绑死；RECORDED→CLAIMED 条件更新是唯一领取点；model_calls 新增无作用域 kind `MEMBER`＋`member_message_id`（真实调用逐次计量，指回触发消息）。唤醒裁决（`member-wakeup.ts`，挂 Worker tick，复用既有循环不建第二引擎）：私聊→对方、群聊定向→指定成员、未定向→协调者，一次只唤醒一个成员；**只有用户发送的消息是唤醒触发**，成员回信未定向且不进候选——互相回应不形成唤醒链由结构保证；停用/外部成员、关闭会话、归档项目不唤醒（消息保留 RECORDED 等待，不记失败）。成员回信 sender_kind=MEMBER、seq 会话内递增、与原消息 PROCESSED 结算＋活动记录同一短事务。模型按 PT-08 解析：INHERIT 用默认端口；EXPLICIT 存储型号/指纹与当前端口不符或 openrouter 路由未接时类型化失败（`MEMBER_MODEL_CONFIG_CHANGED`/`MEMBER_MODEL_ROUTE_UNAVAILABLE`），不静默降级；模型失败不自动重试；崩溃由租约清扫收敛（上限 2 次尝试，超限 `WAKEUP_ATTEMPTS_EXHAUSTED`）。提示词新路由 `MEMBER_WAKEUP`（含公共核心，回信只是协作记录不产生执行权/验收/权限变更） | 真实临时 PG18.6＋HTTP `member-wakeup.integration.test.ts` **5/5 PASSED**（定向/未定向/私聊唤醒裁决＋每消息恰好一次模型调用与一条回信；第二 Worker 不重复领取、在途 CLAIMED 不被抢、恰好一条 MEMBER 账本行；租约过期上限内重试一次 attempts=2、超限收口零调用；停用/外部/关闭/归档四类准入保留 RECORDED 零调用；EXPLICIT 两类类型化失败＋FAKE_ASSIST_THROW 失败不重试且账本如实 FAILED）；合并回归 member-wakeup＋member-conversations＋agent-members＋migration＋chat-plan-goal＋goal-budget-grant-accounting＋scheduled-tasks＋scheduled-task-p0a＋scheduled-task-detail-history 全绿（`run-integration.ps1 -UseCLocale` status PASSED）；单测 `runtime-prompt-router`＋`conversation-prompts` 16/16（新路由登记互锁）；API `tsc --noEmit` exit 0。**文档**：数据库 §116、领域模型 §23 状态行。实施中修正一处设计缺陷：初版未过滤成员回信触发，群聊一次回应会唤醒协调者再级联——改为只有用户消息是唤醒触发后才通过。**同日真实进程回路验收（用户要求以 computer-use 插件执行，实施者驱动）**：一次性 PG18.6（142 迁移含 0141）＋真实 API 进程（8792）＋真实 Worker 进程（FakeModelPort，stdout 经 Tee 落盘），HTTP 建项目/成员/协调者/群聊/私聊并发消息——Worker 自主循环两次输出 `worker_member_wakeup`（未定向→协调者 d6a99373、私聊→开发成员 40933ef7，均 PROCESSED），HTTP 读回各一条 MEMBER 回信且触发消息 PROCESSED；多轮 tick 后回信仍各一条（真实进程幂等）；关闭会话后发送 409 INVALID_TRANSITION；`model_calls` 恰两行 kind=MEMBER/COMPLETED、真实 token 用量、member_message_id 关联；真实浏览器连工作台（/health/ready 200）活动流呈现完整证据链（AGENT_MEMBER_CREATED→COORDINATOR_ASSIGNED→MEMBER_MESSAGE_SENT×2→**MEMBER_MESSAGE_PROCESSED×2（执行方 AI）**→STATUS_CHANGED），截图两张（活动流＋事件依据面板，未知事件 UI 如实标注不冒充已知语义），Worker 窗口 AX 文本取证两条唤醒事件；验收后进程按端口/命令行精确清理，临时集群与目录删除，未触碰并行会话进程 | 未验：真实 Provider 语义质量（Fake 端口只证协议）；真实 Windows/Worker 进程长跑与宿主停机后的租约收敛（单测以注入时钟与 SQL 模拟；本回路为短时运行，未验关窗后恢复语义）；EXPLICIT openrouter 成员唤醒路由（依赖 assist 消息行的免费路由机制，未接）；协调者复用 Task/Run 用例自动推进、成员间定向互相唤醒、外部成员领取（ADR-033）、事件/巡检合并与 Windows 生命周期（包 C/D 后续片）；前端读取（P2-A）；独立验收未做（本回路为实施者驱动的真实环境验证，不替代独立验收） |

## 条目 332

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 插件一键启用：补齐缺失的登记入口并修复浏览器策略死前缀（2026-10-25，用户截图指认「用个插件这么麻烦」，当前 Agent 实施＋自检，未 commit/push） | **实施者自检通过；非独立验收**。修掉两处事实缺口：①`POST /connections` 与 permission-policies 的 capability 白名单不含插件能力，高级表单选 `COMPUTER_INPUT` 等提交即 422——插件连接此前**没有任何可用登记入口**（测试与真实 API 均经仓储直插）；②`policyScope` 无 BROWSER 分支，浏览器策略被写成目录前缀，与准入端 `browser://<origin>` 目标永远匹配不上（死策略）。新增 `EnableProjectPlugin`（`POST /projects/{id}/plugins/{plugin_key}/enable`，201，command_id 幂等）：一个短事务补齐连接（缺的能力挂一条新连接）＋每个 `(能力, 动作, 目标)` 一条策略——电脑 `computer://desktop`、浏览器 `browser://`、GitHub 按项目内 ACTIVE 受管根逐目录；只读族（COMPUTER_READ/BROWSER_READ/GITHUB_READ）AUTO、操作族（COMPUTER_INPUT/BROWSER_ACTION/BROWSER_COMMIT）ASK；停用过的连接与撤销过的策略只计数上报不新建绕过（与 ensureGitReadAccess 同纪律）；GitHub 无受管目录时 `skipped_no_resource` 计数。浏览器策略手动创建补可选 `host`（host[:port]，缺省 `browser://`=全部站点）并拒绝 `resource_id`。前端：连接页工具行「一键启用」按钮（本机明确未就绪时禁用并给原因；回执计数含阻断/跳过原样呈现，走既有 pending/回执/UNKNOWN 重试机制）；高级表单浏览器能力改站点前缀字段、电脑/浏览器不再强制选受管资源；项目选择器透传 `?tool=` 定位键 | 真实临时 PG18.6＋真实 HTTP `enable-project-plugin.integration.test.ts` **6/6 PASSED**（电脑 1 连接＋11 策略计数与 ASK/AUTO 分布、同 command_id 重放原结果＋新 command_id 零新建、DISABLED 连接只计数不绕过、撤销策略只计数不恢复、GitHub 无/有受管目录两态、HTTP 能力白名单接受插件能力＋enable 路由 201/重放头/未知键 422）；回归 gateway＋gateway-settings-copy＋conversation-machine-plugin `run-integration.ps1` status PASSED；API `tsc --noEmit` exit 0；Workbench `connectionsSettings.spec.ts` **35/35**（新增 4 例：一键启用提交与回执计数、阻断呈现、本机未就绪禁用、`tool` 透传）；Workbench `vite build` exit 0。契约 [HTTP §10.115](../../api/http-command-contract/part-08.md#10115-一键启用内置插件2026-10-25-源码实现) 已同步 | 未验：真实浏览器/桌面端到端（按钮到真实插件动作，WebView2 未运行）；Workbench 全量 `tsc --noEmit` 仍有并行既有错（`taskbarBadge.spec.ts:21` TS2322，与本项无关，基线对照确认）；全量 vitest 在并行负载下存在与本项无关的既有抖动（单文件复跑与 HEAD 基线对照均一致）；未 commit/push；独立验收未做 |

## 条目 333

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 内置插件图标接入与输入器插件标识复核（2026-10-26，实现/测试/文档为并行会话已提交内容 `85a43a8e`；本轮为独立复核＋真实 Chromium 截图验收） | **通过（受验范围：jsdom 契约、真实 Chromium 几何用例与渲染截图；非完整独立验收）**。六枚 256×256 RGBA 透明 PNG（`apps/workbench/src/assets/plugin-icons/`，四角全透明、可见墨迹居中、16px 下均可辨）；`PluginIcon` 六 key 映射与装饰语义（`alt=""`＋`aria-hidden`，不引入图标库）；「+ → 连接器与插件」三行图标（Lucide 只服务其余通用操作）、`@` 菜单、输入器芯片（菜单插入＝手动输入同一枚，mention 删除/撤销后芯片同步消失、一次退格删整枚、Ctrl+Z 可撤销）、用户消息 mention 图标（`user@GitHub.com`、`src/@GitHub/x`、`@未知插件`、`@GitHubX` 均无图标，消息原文保全） | Vitest `pluginIcons.spec.tsx` **28/28**＋`composerAttachMenu.spec.tsx` **37/37**；真实 Chromium（Playwright 受控 API 夹具）`composerPluginMention.spec.ts` **2/2**；workbench `vite build` exit 0（六枚 PNG 带哈希进入 `dist/assets/`）。另以受控 API 夹具做真实 Chromium 截图验收（1440×900 与 480×800）：附加菜单三行「图标＋名称＋已连接」、`@` 下拉三行带图标且首行高亮、芯片为 Codex 风格紧凑形态（小图标＋短名、无底色）、消息列表 mention 图标且邮箱无图标、窄窗布局正常——截图 9 张落盘 `apps/workbench/output/plugin-icons-acceptance-20261025/`（按保留规则留本机）。实现与交互/视觉契约见[设计系统 §9.22](../../frontend/design-system/part-06.md#922-内置插件图标与输入器插件标识2026-10-25)、[工作台 §32.9](../../frontend/workbench-design/part-11.md#329-连接器与插件二级2026-10-17) | 真实 Windows/WebView2 原生窗口截图未验（验收会话时桌面显示器关闭/锁屏，屏幕像素捕获与会话前台激活被 OS 会话级阻断，computer-use 插件仅完成真实 Chromium 无障碍层验证后转 Playwright 截图）；125%/150% DPI 未实测；暗色主题场景不适用（工作台当前仅浅色一套主题，见设计系统 §9.22）；六枚 PNG 资产已在本机磁盘但**尚未 `git add`**（代码已随 `85a43a8e` 提交，克隆仓库会缺资源）；workbench 全量 `tsc --noEmit` 的 `taskbarBadge.spec.ts:21` 既有错与本项无关（同[条目 332](#条目-332) 基线对照）；独立验收未做 |

## 条目 334

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 任务与计划系统 P0–P2 第二轮独立验收与收口（2026-10-26，当前 Agent 独立验收＋确认缺口最小修复，未 commit/push） | **通过（本轮受验范围内无未解决 P0/P1；非 N04/N06 整体出口）**。三处恢复缺口先构造失败再修复：①N04 `PROPOSE_PLAN` 恢复以计划修订严格相等判定——原计划创建后另一页面处理计划项即永久卡住，改为持久身份（planId/projectId/项目计划列表归属＋详情列表读回一致）核对，接受当前修订 ≥ 回执修订；②N04 `PROPOSE_SCOPE` 同类缺口——另一页面合法选定推演（PROPOSED→SELECTED）后永久卡住，读回接受 PROPOSED/SELECTED 且修订不倒退，回执状态仍须严格 PROPOSED；③N06 `CREATE` 恢复因链状态不再是 DRAFT 永久卡住——接受 DRAFT 之后全部合法前进状态（ACTIVE/WAITING_RESUME/PAUSING/PAUSED/REVOKED/EXPIRED/BLOCKED/COMPLETED），链身份与项目归属核对在前。三处均未放松身份/载荷错配拒绝。估时编辑草稿保护补齐：TaskChoice 估时输入提升为按 taskId 的视图级草稿并入既有 DraftGuard（未保存离开拦截、保留后输入保留、加载更多任务后草稿不丢、明确丢弃才清空、原命令核对成功后清草稿不阻塞离页、restoreFocus 回焦估时输入器），未另建第二套离页系统。PROPOSE_PLAN 输入对齐服务端校验：毫秒安全整数、容量 1–604800000ms、诊断预算为正且不超过容量。N04 不自动执行任务、N06 不绕过授权/Review/Completion/累计预算、RESOLVE_ITEM 按确切项状态恢复、授权历史精确核对（错 command_id/预算/期限/chain_id 拒绝）、PAUSING→PAUSED/REVOKED、API 重启 WAITING_RESUME、未知调用不按零消耗、创建 DRAFT 不启动 Run 等沿用前轮实现并复验，未重做 | 新增回归 RED→GREEN：临时还原旧严格判定后 4 个新用例恰好失败、16 个既有用例不受影响，复原后全绿（`tests/projectPlanningFlows.spec.tsx` 20/20，含 PROPOSE_PLAN 推进恢复、PROPOSE_SCOPE 被另一页面选定恢复、任务链创建后被授权至 ACTIVE 恢复、估时草稿离页保护 4 个新用例）；定向 Vitest 7 文件 **54/54**（另含 projectTaskPages 7、taskChainsClient、composerTargetPicker、projectKnowledgeGuide、projectTasksViewPagination、personalPlanningClient）；真实 Chromium（Playwright 受控 API 夹具＋dev server 当前源码）`tests/browser/projectPlanningFlows.spec.ts` **8/8**：计划候选生成、范围推演三方案与选择后逐项决策、用户估时写入读回与旧验收失效展示、计划命令响应丢失后原回执恢复、任务链创建/授权/暂停三条独立命令、任务链创建响应丢失后被另一页面授权至 ACTIVE 的原命令恢复、390px 窄窗无横向溢出＋25 项分页加载、估时草稿离开拦截＋焦点回到估时输入；真实临时 PostgreSQL/HTTP 10 套件 **71/71**（api-tasks 17、personal-planning 7、plan-scope-simulations 4、scheduled-task-detail-history 2、scheduled-tasks 8、task-acceptance-command 9、task-chain-execution 9、task-chains 7、task-completion-pointer 2、today 6；脚本 fresh build、业务迁移、Graph 安装、PG 启停 exit 0，临时集群清理 True，完整日志 `output/acceptance-raw/n04-n06-reaccept-integration-20261026.log`）；API `tsc --noEmit` exit 0；API fresh build（删 dist 重建）exit 0；workbench `vite build` exit 0；`node scripts/check-docs.mjs` 仍为既有 27 处历史缺失本地链接，无新增（exit 1）；workbench 全量 Vitest 历史日志实为 1721/1819 通过、98 失败、18 个失败文件；原列 15 个文件外漏记 `assist-target.spec.ts`、`run-events.spec.ts`、`run-ui1820.spec.ts`（各 1 例），且当时 `responsiveTiers` 仍报告两个计划/任务链 CSS 断点；历史日志 `apps/workbench/output/vitest-full-20261026.log` | Workbench 全量 `tsc --noEmit` exit 2 仅剩并行会话既有错 `tests/taskbarBadge.spec.ts:21` TS2322（同[条目 199](part-11.md#条目-199)、[条目 332](#条目-332) 基线，非本轮改动）；真实 Windows/WebView2 桌面验收未做——用户确认屏幕锁定（熄屏需登录），computer-use 桌面像素捕获与会话前台激活不可用，按用户指示本轮只做浏览器侧；真实 Provider 未验；N04/N06 完整使用收益与整体 N 阶段出口未闭合；未 commit/push |

## 条目 335

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 插件图标四项遗留缺陷闭环：P0 六枚 PNG 纳入版本管理、P1 选区并集删除、P1 禁用态重影、P1 gutter 补偿累积（2026-10-26，独立验收指认，当前 Agent 修复＋复验，未 commit/push） | **四项全部 PASS（jsdom 契约＋真实 Chromium 几何/计算样式/键盘闭环）**。P0-01：六张 256×256 RGBA 透明 PNG（Pillow 复验可解码、四角全透明）以精确路径 `git add` 纳入跟踪（`git status` 恰好 6 个 A、不触碰其他文件），`vite build` exit 0 且 `dist/assets/` 含全部六枚带哈希产物，`git check-ignore` 确认无忽略规则拦截。P1-01：Backspace/Delete 触及 mention 的预置选区从「第一枚相交 mention 覆盖」改为**所有被触及 mention 与原选区的并集**——全选「前文 @GitHub 后文」删除得到空串（旧实现把预置缩成 3,10 一段、留下前后文）、跨两枚 mention 的部分选择全部覆盖、只碰普通文字不预置；无选区的方向语义（Backspace 向左/Delete 向右）与 Ctrl+Backspace 删词不变。P1-02：会话输入器禁用规则 (0,3,1)（提交窗口不画禁用灰那条）把 `color`/`-webkit-text-fill-color` 刷回正文色压过芯片态 (0,2,1) 透明，发送 pending 期间底层 mention 原文与芯片两层可见文字；新增 `.chat-command-input .chat-command-surface[data-chips="on"] > textarea:disabled`（(0,4,1)，与导入顺序无关）修复，纯文本草稿不受影响。P1-03：`placeChips()` 把已含补偿的计算值当基础值再 `calc` 叠加，滚动/缩放/ResizeObserver 反复触发越叠越宽；改为「先清行内补偿→读基础 padding→设基础+当前 gutter 绝对值」，任意次重复结果不变、gutter 归零即恢复。P1-02 与 P1-01/P1-03 均按先写失败测试再修复执行（6 例 jsdom 初始失败，修复后转绿；CSS 修复回退验证用例确实转红） | Workbench Vitest：`pluginIcons.spec.tsx` **35/35**（新增选区并集 5 例＋gutter 幂等 2 例，其中 1 例既有断言按并集规则更新：完整覆盖选区不再缩回恰好整段）、`composerAttachMenu.spec.tsx` **37/37**、`chatCommandInput.spec.tsx` **8/8**，合计 **80/80**；Playwright（真实 Chromium 受控 API 夹具）`composerPluginMention.spec.ts` **7/7**（既有 2 例＋新增：全选删除→空串→Ctrl+Z 恢复全文与芯片、跨两枚部分选择、会话输入器 pending 禁用态 `color`/`-webkit-text-fill-color` 全透明且芯片仍可见、首条消息输入器（`assist-first-draft`）pending 禁用态同断言、gutter 幂等——滚动 ×3＋视口缩放 ×2 后 padding 同一绝对值、芯片矩形与 mention 矩形偏差 ≤1px、清空草稿后补偿无残留）；`tsc --noEmit` 对本轮文件零错误（全量仅剩并行会话 `goalManagementLive.spec.tsx` 未提交改动与 `taskbarBadge.spec.ts` 既有基线错）；`vite build` exit 0。截图：`pending-disabled-no-ghost.png`、`first-composer-pending-no-ghost.png`、`gutter-chips-scrolled.png` 等落盘 `apps/workbench/output/plugin-icons-acceptance-20261025/`。产品规则已同步：[设计系统 §9.22](../../frontend/design-system/part-06.md#922-内置插件图标与输入器插件标识2026-10-25)、[工作台 §32.9](../../frontend/workbench-design/part-11.md#329-连接器与插件二级2026-10-17) | 真实 Windows/WebView2 原生窗口未验（沿用条目 333 的熄屏结论，本轮按用户指示只做浏览器侧）；`git add` 后未 commit/push（按任务约束留给用户）；typecheck/build 全量出口仍被并行会话两个文件的既有错误挡住（与本项无关，逐文件核对为本轮零新增）；独立验收的独立 Agent 复核未做（本轮为修复方复验） |

## 条目 336

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| N04→N06 计划、范围选择与有限连续委托的联合复验（2026-10-26，当前共享工作树；HEAD `29ce53cb`，未 commit/push） | **局部 P0 与浏览器证据通过；N04/N06 整体仍未闭合。** 真实 PG/HTTP 联合用例沿同一 Project 完成：创建带依赖 Tasks→写用户估时→建周期计划→范围推演选 SHRINK→逐项接受前置和主线、拒绝排除项→建 Task Chain→明确授权→生产 Worker 执行→人工 Review→Completion→下一项 Run。断言授权前 Runs 为 0，首项 Review 前第二项无 Run，首项 Completion 后才出现下一项；模型端口为 FakeModelPort，不是实际 Provider。计划中的排除项在选定计划中保留为可审阅条目，测试按契约明确拒绝。另仅把 `ProjectPlanningView.css` 与 `ProjectTaskChainsView.css` 的断点从 `max-width` 改为等价范围语法；未改动其它页面 CSS | Workbench N04/N06 五个关键 spec 33/33；真实 Chromium（受控 API）`projectPlanningFlows.spec.ts` 8/8；真实临时 PostgreSQL/HTTP 的 10 套件 71/71；新增 PG/HTTP/生产 Worker 联合集成用例 1/1，脚本 fresh build、业务迁移、Graph 安装、PostgreSQL 启停 exit 0，临时集群清理为 True。Node 24 API typecheck 与 fresh build exit 0；当前源码 Workbench Vite build exit 0；`node scripts/check-docs.mjs` exit 1，报告与既有基线相同的 27 个缺失本地链接，本轮没有新增链接错误。当前可靠全量结果采用 4 workers：1822/1844 通过、22 失败分布在 15 个文件。22 个失败身份全部已存在于原始日志（98/1819、18 文件），与原始集合相比 76 个身份本次未复现：TaskDetail 17 项经本轮首版 Artifact revision=0/回执 hash 修复和测试夹具校正后，taskDetail.spec.ts 28/28、artifactSaveRecovery.spec.tsx 8/8；另有 AssistBinding 15、CollaborationWorkspace 43、Run SSE 1 项在受限并发复跑中未复现，未逐条隔离，暂记“未复现”而不宣称根因已关闭。当前 22 项逐项归因见本条附表。该次（2026-10-26）`responsiveTiers` 检查列出 8 条旧式 max-width 规则，分布在 7 个 CSS 文件（ComposerDraftAssist.css、GoalPlanCards.css、InboxView.css、protoPage.css 两处、ReviewsView.css、ScheduledTasksView.css、TodayView.css）；本轮改过的两个 N04/N06 CSS 不在报告中。当前 Workbench 全量 tsc --noEmit 仅报 tests/taskbarBadge.spec.ts:21 TS2322：测试夹具把 options.ink 的 Ink \| "throw" 联合值直接赋给 Ink，未先缩窄哨兵分支；归属任务栏角标测试，不是本轮业务代码改动 | Windows/WebView2 被标记 BLOCKED：刷新窗口枚举后再次激活 Relay Agent 仍超时；按 computer-use Skill 的重试规则停止 UI 操作。真实 Provider 未运行；P2 规模/切换稳定性测试因 P1 桌面出口未闭合而 NOT_RUN。原始日志：`apps/workbench/output/vitest-full-20261026-post-css.log`、`apps/workbench/output/vitest-full-20261026-limited-workers.log`（4 workers，本轮全量结果）、`apps/workbench/output/vitest-full-20261026.log`（原始默认并发全量结果）、`typecheck-post-css-20261026.log`、`build-post-css-20261026.log`、`playwright-n04-n06-closeout-20261026.log`；`apps/api/output/n04-n06-closeout-integration-20261026.log`、`n04-n06-business-flow-e2e-retry-20261026.log`、`typecheck-node24-closeout-20261026.log`、`build-node24-closeout-20261026.log`；本轮没有向 ChatGPT 网页发送材料，留待用户手动验收 |

### 当前 Workbench 全量 Vitest 失败归因（4 workers）

原始默认并发日志为 98 失败 / 1721 通过 / 1819 总数、18 个失败文件；4-worker 受限批次为 22 失败 / 1822 通过 / 1844 总数、15 个失败文件、exit 1。清除 ANSI 后按完整失败身份比较：22 项全部属于原始 98 项，无新增；76 项原失败该批次未复现。15 文件子集相对原始 18 文件缺少 assistBinding.spec.ts（原始 15 例）、run-events.spec.ts（1 例）、taskDetail.spec.ts（17 例），没有新增失败文件。历史文档另有一份“15 个范围外文件”枚举，曾漏列 assist-target.spec.ts、run-events.spec.ts、run-ui1820.spec.ts；它与 4-worker 的 15 个实际失败文件不是同一口径。受限并发日志提示 jsdom 环境重复创建与资源占用；“未复现”不等同已独立关闭。默认并发另一次出现 135 失败 / 1709 通过，单独重跑 assistantModeSwitch.spec.ts 为 50/50；不把该批次当作基准。

以下 owner 指模块/测试维护面，不推测共享工作树中的个人作者。除表内注明外，相关源码与测试文件未出现在本轮改动列表；无法证明并行未提交改动是引入者。

| # | 当前失败用例 | 直接观察与归因 | 模块 owner / 分类 |
|---|---|---|---|
| 1 | assist-target.spec.ts：切换 Project 到 Task 后迟到的旧目标响应不能落到新目标 | 页面落入请求错误态。当前客户端请求含 assist-sessions?task_id=...，测试 mock 只响应 assist-sessions?include_context=true，因此 mock 抛 unexpected request，未到达迟到响应断言。 | Assist 工作对象 / 测试夹具漏接带 task_id 的查询；历史失败 |
| 2 | assistantClient.spec.ts：UNSET revision 读成 0、其余字段为 null | DTO 解析器按已加入的上下文预算字段返回 contextBudgetTokens: null，深比较期望对象漏掉该字段。 | Workspace 默认目录客户端 / 断言未同步字段；历史失败 |
| 3 | collaborationWorkspace.spec.ts：AI 消息正文、来源条、候选卡顺序 | Markdown 正文现在嵌在 .assist-reply 容器中；测试只扫描 .agent-message-body 的直接子节点，导致找不到嵌套的 assist-message-markdown。 | Assist 消息呈现 / DOM 结构断言过时；历史失败 |
| 4 | firstPartySkills.spec.ts：显式选择 Skill 后重试保持 skill_ref/skill_input | 2026-10-27 核对：任务会话使用 standalone 图标发送键；按钮正文仅含图标，运行名称放在 aria-label 和 title。测试仍按按钮文本查找“运行 task-to-execution-contract”，在后续重试断言之前失败。 | M04 第一方 Skill / 发送键断言待该模块核对；历史失败 |
| 5 | knowledgeCaptureLayout.spec.ts：重读来源失权后清除正文和确认 | 断言预期 source permission revoked，实际页面错误被新的 tasks?project_id=...&limit=12 未处理请求覆盖。 | Knowledge 收录 / 分页任务读取夹具未更新；历史失败 |
| 6 | knowledgeReading.spec.ts：项目导读未保存时显示空态 | 断言仍查找“全部加入”，当前文案是“加入已加载目标（0）”；同一夹具也漏接带 limit=12 的任务页查询。 | Knowledge 导读 / 文案断言与分页夹具过时；历史失败 |
| 7 | knowledgeSimplify.spec.ts：产物候选列表选择确切版本 | 候选 selector 不存在；测试 mock 仍只响应无 limit 的 tasks?project_id=...，新分页查询导致候选任务未加载。 | Knowledge 简化入口 / 分页任务读取夹具未更新；历史失败 |
| 8 | memoryClient.spec.ts：来源失效时只返回 status | parser 现在明确返回 sourceKind: "UNKNOWN"（不可用来源为 null），期望对象未纳入此 DTO 字段。 | Memory 客户端 / DTO 断言未同步字段；历史失败 |
| 9 | projectOverview.spec.ts：接续卡、查看动态过滤与零新增业务写入 | 2026-10-27 核对：接续卡先读取 daily-continuation，成功展示后才提交 daily-view-confirmations；该测试夹具只为后者的 POST 提供返回，未处理前者的 GET，读取失败后不会发送确认。 | Project Overview / 夹具缺少接续投影 GET；历史失败 |
| 10 | projectWorkbench.spec.ts：真实模式只读投影并游标加载 | 只因精确文案断言仍要求“真实 Git diff、受控测试和 Coding CLI 尚未接入”；当前页面是“真实 Git diff、受控测试与 Coding CLI 尚未接入此工作台；这里不生成变化集或检查结果”。 | Project Workbench / 断言文案过时；历史失败 |
| 11 | responsiveTiers.spec.ts：断点落在四档语义值 | 当前快照检查到 9 条旧式 max-width、分布在 8 个文件：ComposerDraftAssist.css:75、GoalPlanCards.css:231、styles.css:340、InboxView.css:309、protoPage.css:638/645、ReviewsView.css:134、ScheduledTasksView.css:77、TodayView.css:259。`styles.css:340` 位于未提交工作树新增的 600px 桌面标题栏媒体规则中；具体作者不据此推断。N04/N06 修改的 ProjectPlanningView.css、ProjectTaskChainsView.css 均不在失败列表。该守卫报告 CSS 语法规则，不代表断点运行时失败。 | Workbench 响应式样式 / 9 条待维护规则；历史失败，含当前未提交样式新增项 |
| 12 | run-ui1820.spec.ts：UNKNOWN 结果核对文案、资源保护和证据入口 | 断言要求旧词“待接入”；当前文案已经展开说明 operation_id 核对、结果未知和资源隔离，测试的固定字符串不再匹配。 | Run UI / 文案断言过时；历史失败 |
| 13 | taskbarBadge.spec.ts：一位数小圆盘 | 圆弧与坐标一致；测试期望填色 #B9452F、字号 17.5px，当前绘制常量为 #BC4630、18.5px。 | Taskbar Badge / 设计常量与测试契约未同步；历史失败 |
| 14 | taskbarBadge.spec.ts：两位数短胶囊 | 两端弧线几何一致，失败点是期望 #B9452F、实际 #BC4630。 | Taskbar Badge / 同上 |
| 15 | taskbarBadge.spec.ts：三位数短胶囊 | 胶囊几何一致，失败点是期望 #B9452F、实际 #BC4630。 | Taskbar Badge / 同上 |
| 16 | taskbarBadge.spec.ts：只画一层底色 | 无描边/渐变断言通过到颜色比较，期望 #B9452F、实际 #BC4630。 | Taskbar Badge / 同上 |
| 17 | taskbarBadge.spec.ts：按墨迹居中 | 横纵坐标为 19.200,23.500，字号期望 17.5px、实际 18.5px。 | Taskbar Badge / 字号断言未同步当前绘制常量 |
| 18 | taskbarBadge.spec.ts：取不到墨迹包围盒时退回估值 | 测试按 17.5px 推导 y=24.125，实际 18.5px 推导 y=24.475。 | Taskbar Badge / 同上 |
| 19 | taskSkillLive.spec.ts：定义页嵌入同任务建议入口 | 测试要求嵌入式定义页出现 assist-new-session；当前页面提供“打开此任务的 Assist”链接，嵌入视图不提供独立新建会话按钮。 | Task Skill live / 旧入口断言；历史失败 |
| 20 | taskSkillProposal.spec.ts：迟到事实读取 503 后恢复 | 失败时点 task-skill-refresh 的按钮因 Assist 预选 Skill 计入未保存输入而禁用；读取错误继续显示符合当前 guard。测试没有先清除预选 Skill，程序化 click 不会触发 refresh。 | Task Skill 当前事实 / 测试前置状态不满足刷新条件；历史失败 |
| 21 | taskSkillProposal.spec.ts：迟到事实读取 403 后恢复 | 与 503 用例相同：预选 Skill 使事实刷新按钮禁用，故没有产生测试预期的成功重读。 | Task Skill 当前事实 / 同上 |
| 22 | taskSkillProposal.spec.ts：定义页双确认、未知回执沿原命令恢复 | 有未决命令时通用离页守卫按钮当前显示“留在本页核对回执”，测试却按旧文案查找“保留并继续编辑”。 | Task Skill 提案 / 安全状态文案断言过时；历史失败 |

未归因问题仍保留在对应模块，不扩大为 N04/N06 本轮代码修复。taskbarBadge.spec.ts:21 的 TS2322 也在该测试 owner 范围：options.ink 的 "throw" | Ink 没有先缩窄就赋给 Ink。以上失败文件没有本轮授权改动；作者层面的“其他会话引入”没有证据，不能据 dirty tree 猜测。

### 2026-10-27 接续复验（进行中）

- 当次主工作树为 `main` / `29ce53cb`，包含并行未提交改动。同步快照 Workbench 全量 Vitest：1866/1877 通过、11 失败分布在 9 个文件、exit 1；11 个失败身份全部属于 2026-10-26 已记录集合，未出现新身份。快照与主树 `apps/workbench/src`、`apps/workbench/tests` 的 617 个相关文件仅 `tests/browser/projectPlanningFlows.spec.ts` 有差异（浏览器测试不属于本轮 Vitest）。这 11 项对应上表 #1、#3–5、#11–12、#19–22，全部也是原始默认并发和 4-worker 受限批次中的既有失败；没有一项来自 N04/N06 修改文件。历史“15 个范围外文件”枚举与 4-worker 批次的“15 个实际失败文件”是不同口径，文件集合差异见上方归因说明。上表 #13–18 任务栏角标失败本次仍未复现；其余失败归属各自模块的测试/维护面，不能据共享工作树状态推断个人作者。运行日志位于隔离快照 `output/vitest-full-20261027-synced-snapshot.log`。
- N04/N06 定向 Vitest 36/36；当前主树 task-chain UI/client 回归（projectPlanningFlows.spec.tsx、taskChainsClient.spec.ts、taskChainExecutionClient.spec.ts）24/24、exit 0，覆盖计划/任务链状态与命令恢复，不代表规模稳定性或 Windows 桌面验收；隔离快照受控 API Chromium 8/8。Workbench 当前源码 `pnpm exec tsc --noEmit` exit 0，Vite production build exit 0（有大 chunk 与动态导入提示）。当前主树 API typecheck exit 2，错误集中于 Model Connections 的 `ModelConnectionCommandResult`/`JsonObject`、`RETRY_LATER` 不属于 `RetryAction`、`model-connection-repository.ts` 重复 `Error.name`；隔离快照 fresh build exit 1，另有 routes 引用的 `model-connection-api.js` 未同步。原 taskbarBadge TS2322 未出现；API 当前源码不能记为 typecheck/build 通过。`node scripts/check-docs.mjs` exit 1，报告 25 个缺失本地目标（均在本轮未修改文档）；`node scripts/feature-map.mjs --check` exit 0，21 模块/180 项功能/584 个关联文件。证据日志 `apps/api/output/typecheck-20261027-after-source-sync.log`、隔离快照 `output/desktop-build-20261027-current-source.log`。
- 隔离 PostgreSQL/HTTP 首次快照 11 套件 72/72；同步后续 API 生产代码后的批次 65/72、exit 1：personal-planning 套件的 API 启动钩子在 30 秒内未就绪，7 个测试主体未运行；其余 65 项包含联合业务链 1/1。该套件在同一编译快照按原条件单独复跑 7/7、exit 0，临时数据库已清理；原整批仍记为失败，不能把不同批次合并称为一次 72/72 通过。该批次与后续未通过 typecheck 的当前 Model Connections 源码不是同一完整 API 构建，不能代替当前 API 全量验收。
- Windows/WebView2 实际操作未完成。隔离 Tauri 包 `test-release/relay-desktop.exe`（构建于 2026-10-27 04:32 UTC）连接专用临时 PostgreSQL 与 workspace；创建项目的未知结果经只读 SQL 核查后，`projects` 行数为 0、`CreateProject` 回执为 0，确认该次提交未落库，未重放命令。用户确认关闭其他实例后，目标窗口成功激活，Projects 页显示 0 个项目；创建表单加载并填写了临时名称，但 CreateProject 提交控件返回未知结果。随后只读查询隔离库 relay_m02_acceptance：projects=0，command_receipts 仅有 InitializeWorkspace 与 SetWorkspaceDefaultWriteTier，无 CreateProject 回执，确认未落库且未重放。之后新的桌面输入再次被 user-input guard 拦截，停止后续桌面操作。该包不是当前 API 全量源码的 fresh build；当前 API typecheck/build 被 Model Connections 编译错误阻断。Windows/WebView2 业务验收标为 BLOCKED，真实 Provider 与 P2 规模/切换稳定性未运行。

## 条目 337

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 任务栏待处理角标视觉重设计（2026-10-25/26，用户「红色区域过大、数字偏粗、边缘生硬，像附着在图标上的红色贴纸」） | **实施者自检通过：几何、字形、底色重做；角标单测 10/10；工作台 `tsc --noEmit` 归零；真实 Chromium 出前后对照图；Windows 任务栏叠加仍未取证** | 只动绘制与其直接测试，业务语义（`getInterventions()` 同源、0 撤角标、同数量不重设、非 Tauri 不调宿主、宿主失败只告警）逐条保留。**先量后画**：① 三组候选（A 系统红克制型、B 品牌协调型、C 极简型）在真实 Chromium 按 1:1 真实像素、3× 与 8× 最近邻、深浅两档任务栏底色比对，C 在 16px 槽位下数字糊掉淘汰，落地 B 的血缘并吸收 A 的字号可读性；② **几何**：墨迹右下缘锚到画布 30（留 1 设备像素空气）。旧版 28px 圆盘 + 2px 白圈把 32px 画布铺满，Windows 按槽位整块缩放后红盘吃掉整个 overlay——这是「贴纸感」的物理原因；现一位数 24px 圆盘（面积较 28px 盘降约 27%），两位数与 `99+` 统一 30×22 短胶囊（1.36 长宽比，高度不随位数跳）；③ **只画一层底**：取消白圈与描边，深浅底色靠底盘对比撑住；④ **底色** `#BC4630`（H≈9°、S≈59%，比 `#BE3E2C` 更暖更沉、与图标橙色圆环同族），数字 `#FFF7F3`；对 `#1f1f1f` / `#e6e6e6` 约 3.2:1 / 4.2:1，暖白字约 5.0:1；⑤ **字形**：字号 18.5 / 14.5 / 11.5px、字重 600（700 缩小后糊成坨），字族优先 Segoe UI Variable Text、回落 Display 与经典 Segoe UI；⑥ **按墨迹居中**：`measureText` 的 `actualBoundingBox*` 算偏移（`1` 不再因 advance 宽于字面而偏左），取不到度量才退回 cap-height 0.7 估值，仍不抛错。**证据**：`taskbarBadge.spec.ts` **10/10**（文案边界含 10/99/100、圆盘与胶囊几何及 30 锚定、单层底无 stroke、墨迹居中与度量不可用两条路径、非桌面不碰宿主、同数量不重设、宿主拒绝只告警）；`npx tsc --noEmit` **exit 0**（顺带清掉前表归因里的 `taskbarBadge.spec.ts:21` TS2322——成因是 `"throw" \| Ink` 未先缩窄就赋给 `Ink`）；全量 vitest **1800/1831 通过、31 失败分布在 16 个其它文件**，本轮路径 0 失败；真实 Chromium（不经 vite，直接转译模块执行同一份 `drawBadge`）：`apps/workbench/probe-badge-restyle.mjs` 同时载入 `85a43a8e` 旧版与工作区版，出 1:1 真实像素、3× 最近邻、100/125/150/200% 缩放档、8 枚连续排列四组对照；墨迹实测（设备像素）`1` 3.5×6.5、`7`/`9` 5×6.5、`42` 7.9×5、`99+` 9.6×4，`99+` 侧向余量约 2.5 设备像素无裁切；图与 `ink-metrics.json` 留 `apps/workbench/results/taskbar-badge-2026-10-25/`。规则归[设计系统 §1](../../frontend/design-system/part-01.md#1-视觉依据与提取边界)，数量语义归[工作台 §11.5](../../frontend/workbench-design/part-03.md#115-已确认的人工介入提醒规则) | **Windows 实际叠加仍未取证**：本环境禁止运行时编译或加载互操作代码（`Add-Type` 与 `csc.exe` 均被安全策略拒绝），无法自建 `ITaskbarList3` 探针宿主抓任务栏；正在运行的 `relay-desktop` 是旧构建且数量取自真实 API，无法按 1/7/42 分档。真实 overlay 槽位尺寸（约 16px）与 DWM 抗锯齿仍是 Chromium 模拟推断，不用它替代宿主验收。125/150/200% 由同一 32px 位图按槽位尺寸缩放模拟，未在真实 DPI 下截图。三套候选只保留落地的一套，未进产品代码。未做独立验收；本轮 3 个文件已被并行会话提交 `29ce53cb` 一并带入，本轮未自行 commit/push，也未代其改其它路径 |
