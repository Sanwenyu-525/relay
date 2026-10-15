# 真实 Windows 页面巡检整改：四类问题

日期：2026-10-07。角色：本次限定修复的执行提示词。用户已授权写提示词并直接执行。

执行模型：`gpt-6-luna`，推理强度 `max`（该模型可用最高档）；这是用户明确指定，覆盖默认子代理模型，不得静默换模型。协调 Agent 负责独立复核和最终文档同步。

问题来源：[功能验收表](../../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)「真实 Windows 页面巡检及限定整改（2026-10-07）」行中的初次巡检。此提示词定义实施与验收要求，实际执行结果只归验收表，不以提示词内容声称修复或运行通过。

## 1. 工作目标、角色与共享工作区

你负责四类已复现页面问题的最小实现修复、自动化回归及自检。工作区 `D:/Develop/Relay-Agent`。最终要交出可独立复核的代码与测试，不只是分析或建议。

你不是独自在代码库中工作。开工先读 `git status --short` 和本片相关文件的 diff；已有大量未提交 UI 修改及未跟踪 EmptyState/测试文件，必须保留。不能覆盖、回退、暂存、提交他人修改；禁止 `git reset`、`git clean`、`git stash` 及整文件恢复。发生同一区域并发改动时，重新读当前文件、在当前内容上做最小修改，不用旧副本覆盖。不要自行 commit 或 push。不要再派子代理。

你的代码所有权：

- `apps/workbench/src/components/ResponsiveRail.tsx`，仅在布局责任需要时修改。
- `apps/workbench/src/styles.css`，仅修改本片摘要入口布局所需的选择器与媒体查询。
- `apps/workbench/src/views/AssistView.tsx`；如确有必要，可小范围修改 `ConversationModeSwitch` 实际所在文件，但不得重写助手配置功能。
- `apps/workbench/src/components/AppShell.tsx`，任务/收件箱导航活跃状态。
- `apps/workbench/src/views/ReviewsView.tsx`、`KnowledgeView.tsx`，只改本片右侧无选中内容的呈现。
- 与以上直接相关的现有组件测试；确需几何或端到端回归时，在 `apps/workbench/tests/browser/` 新增一个边界清晰的 spec 或补现有 spec。

其他生产文件原则上只读。如发现必须扩大范围，在给协调 Agent 的进度消息中说明具体依赖、原因与最小方案；继续能够独立完成的已授权部分。不要碰 API、数据库、migration、Worker、Provider、desktop Rust、依赖版本、锁文件或 `design-tokens.json` 数值。

文档文件由协调 Agent 持有，避免交叉写入：你不要修改提示词、`CODEX_NEXT_STEP.md`、验收表、workbench-design 或 design-system；交付时给出准确的文档补充建议与实跑证据，由协调 Agent 同步。文档维护仍属于本任务，不能因你不直接写文档就忽略它。

## 2. 开工读取及基准

先读根 `AGENTS.md`，再按范围读取：

1. `CODEX_NEXT_STEP.md` 顶部相关 UI/助手接续，不默认扫描全历史。
2. `docs/README.md` 第 1、4、6 节，明确事实源与原始输出规则。
3. 验收表顶部的本次 Windows 巡检行，以及会话模式/首装空态相关行。
4. `docs/frontend/workbench-design.md` 第 17.13、18.6、25 节；`docs/frontend/design-system.md` 的共享空态/适配规则；`docs/frontend/design-tokens.json` 只读。
5. `docs/decisions/ADR-018-assistant-conversations.md` 与现有助手 API DTO/会话身份字段，只为理解前端准入，不改后端。
6. 现有实现与测试，尤其 `assistantModeSwitch.spec.ts`、`navigation.spec.ts`、`reviews.spec.ts`、`knowledge.spec.ts`、`knowledgeReading.spec.ts`、`collaborationWorkspace.spec.ts`、`folderFirstConversation.spec.ts`、`tests/browser/projects-empty-state.spec.ts`、`tests/browser/uiOption2FirstSession.spec.ts`。

巡检时 HEAD 是 `216a41b`，加当时工作区未提交修改；开工重新核对当前 HEAD，不假定仍相同。巡检窗口为 `apps/desktop/src-tauri/target/debug/relay-desktop.exe`，页面 `http://127.0.0.1:5173`，显示连接本机 API、无项目/任务/助手。逻辑截图尺寸分别为 1162×782、843×782 与最大化 2048×1104。开发窗口不能算安装包。

先给出简短实施顺序与可验证成功条件，然后执行。不要把已授权修复变成新的需求访谈。代码是当前实现事实；若文档仍写「界面尚未实现」或「人设 Bot」，只报告该过时文本，由协调者定向更正，不能因此倒退已实现的「人设助手」。

## 3. 修复 A：项目摘要入口覆盖新建项目

复现：项目列表在 843×782 时「查看项目摘要」浮动按钮覆盖页头「新建项目」上部；1162×782 也相交。2048×1104 时右栏常驻、无此叠盖。

定位线索：`ResponsiveRail.tsx` 渲染 `.rail-trigger`；`styles.css` 在 `max-width: 79.9375rem` 中把它绝对定位到 `.page-layout` 右上。不要机械套旧行号，读取当前所有相关媒体查询与覆盖规则，尤其任务页已有局部规则。

要求：

- 摘要入口与标题、记录目标、新建项目必须占据互不覆盖的实际布局空间。优先使用现有布局流/局部容器与 token，不加空白占位假元素或随意写死新偏移。
- 不删除摘要入口，不移动标题栏常用操作；不改变项目创建、路由或筛选语义。
- 宽屏保持常驻右栏；窄屏摘要仍可打开、Esc 可关闭并返回合理焦点。
- 若共享 CSS 修复波及创建页/任务页，检查相应入口没有新的覆盖、横向溢出或操作丢失；优先限制作用域，避免为了一个页重写全站布局。
- 保留当前重复新建项目入口的既有产品决定，不擅自降级或删除 primary。

验收：真实 Chromium 在 843×782、1162×782、2048×1104 测量摘要入口与页头每个操作的 `boundingBox`，可见时矩形不相交。不能只断言 DOM 存在或截图没报错。每个可见入口可点击；大视口应验证常驻右栏且浮动入口不重复出现。补一组短窗例如 843×600，验证必要操作可滚达而非要求全部首屏塞下。注意浏览器 viewport 与原生截图尺寸的环境区别，在结果中标明。

## 4. 修复 B：首条助手消息的模式呈现和发送准入

复现：新对话输入中文草稿后切到人设助手，选择器显示「还没有助手，先新建一个」并禁用；但发送按钮仍可用，底栏仍显示「普通讨论」。真实巡检没有点击发送，所以不能声称已发生服务端写入或模型越权。

定位线索：`AssistView.tsx` 有 defer 创建的 `firstMessage` 分支和已有会话输入器分支。已有会话分支隐藏发送选项，不代表首条分支正确。首条 `sendFirst`、`createSession`、submit disabled 条件要一起检查，不能只改按钮颜色。

要求：

- 助手档的首条输入器也隐藏普通讨论/提案/Skill 发送选项；普通档保持原入口及行为。
- 助手档新建会话必须有当前已加载且有效、可用的助手身份。助手列表加载中、读取失败、无可用助手、已选 ID 不在可用列表/已归档时，不得通过按钮、Enter、表单 submit 或其他新建入口发出新的建会话/首条消息请求。
- 复用真实助手数据与既有状态，不能给默认 ID、挑一个并不存在的助手、自动创建助手或把失败当空列表。提示紧邻选择器或输入器，解释为什么不可发送及下一步（先新建/选择助手，或重新读取）。已有读取错误不能被通用空态覆盖。
- 使用最小的共享准入布尔值/原因复用到按钮与新提交处理，避免复制多套条件。客户端准入只是改善反馈，不替代后端权限验证。
- 普通档有文本时仍能发送、空白时不能发送；读到有效助手并选择后助手档能正常发送，request 冻结正确 `conversation_mode` 与 `assistant_profile_id`。助手内容不带有意义的 intent/Skill，沿用已有契约。
- 保留在途时模式禁用、中文合成中 Enter 不发送、Shift+Enter 换行、首条共享草稿 Owner、目录关联与已有离页守卫，不通过增加 URL 模式参数重挂载工作目录。
- 重点保护未知结果恢复：`PendingCreate` 已冻结的原命令及重试/核对通道不得因当前选择器变化而更换 action、ID 或载荷。区分「新提交准入」和「已发出原命令的恢复」；不要用新 guard 意外阻断原回执核对。无效助手身份不允许发新的命令；恢复流程必须保留原身份。
- 不扩展多 Agent、队列、人设编辑器或助手管理页面。切换尚未建成会话的首条模式时继续保留草稿；已有会话草稿按原守卫处理，不静默丢失。

测试必须包括：首条普通档入口保留；助手档普通讨论隐藏；空列表/错误/加载中/失效选择时按钮禁用并有原因；模拟 Enter/submit 后 `createAssistSession` 和消息发送 API 调用次数都为 0；有效助手可提交且 payload 正确；切档草稿保留；在途仍锁定。尽量补现有 spec、使用完整真实 DTO 形状，不用宽松 `any` 或无字段对象掩盖解析错误。

## 5. 修复 C：收件箱导航的当前页高亮

复现：点击 `/inbox` 后既有 router 重定向到 `/tasks?tab=inbox`；内容正确，但「全部任务」高亮、「收件箱」不高亮。`AppShell.tsx` 当前 NavLink 只按 pathname 判断。

要求：

- 保留 `/inbox` 兼容入口及 `/tasks?tab=inbox` 的既有路由契约，不为修高亮新建第二个收件箱页面。
- 按实际 path+tab 语义确定唯一选中的导航项。收件箱范围：仅收件箱选中；普通任务列表：仅全部任务选中。创建子视图带 `tab=inbox` 时不要失去归属。
- 同步视觉 class、`aria-current="page"` 与「当前页」辅助文本，不能视觉改了而屏幕阅读器仍说全部任务。
- 宽屏侧栏与窄屏导航抽屉复用同一判断，避免两套状态算法；其余主/辅助导航不退化。
- 不添加全局 store、通用路由 DSL 或新的导航框架，局部纯判断或已有参数即可。

测试包括：直接 `/tasks?tab=inbox`、经 `/inbox` 重定向、普通 `/tasks`、从收件箱进入创建后返回、切换到其他页。对所选项 class 和 aria-current 做具体断言，另断言竞争项非选中；窄窗抽屉的链接跳转后仍关闭。

## 6. 修复 D：无对象时右栏仍要求选择

复现：待处理 0 项时「为何需要你」仍要求选择一条待审请求；资料范围无条目时右栏仍要求选择一项资料查看详情与版本。

要求：

- 仅改 `ReviewsView` 与 `KnowledgeView` 的这两处未选中内容。不把首装空态替换范围扩成全站重做。
- 区分正在加载、读取失败、真实当前范围为空、有列表但未选中。没有对象时右栏要说清没有可选择的对象，不能提示选择不存在的对象；有对象时仍提示选择，选中后仍显示真实详情。
- 待处理没有请求是正常状态，不暗示整个任务或项目全部完成，也不加创建 Review/批准全部等动作。
- 资料文案按当前资料/记忆/决定/规则范围表达，不误称整个工作空间没有资料。若复用现有新建操作，仍经原 command/Owner，不新造写入口；不要求加按钮，最小文案与状态分支即可。
- 空态可复用已有 `EmptyState`，但别为了复用造成过度重构。不在错误/加载时渲染成功空态，不清空既有选中对象的有效历史。
- 不改审批判断、产物版本绑定、知识命令、搜索算法和权限。

测试包括每页列表空/有数据未选中/选中/加载/读失败，资料还覆盖至少一个非资料类别空范围，待处理至少覆盖筛选后空范围。确认错误文字仍可见且不会同时给出「暂无对象」成功判断。

## 7. 执行与验证顺序

1. 保存最小基准信息、读取相关 diff，确认本片红例；几何缺陷用真实浏览器反例，不用 jsdom 假坐标代替。
2. 逐项补能抓住实际问题的测试，在修复前运行并确认对应失败。共享目录不能回退他人代码，优先先写测试再改实现；确需反向验证只反转你自己的小片段并立刻还原。
3. 最小实现修复，分别跑定向回归。不允许删失败断言、skip 新红例、扩大容差、更新快照掩盖覆盖或把结果 mock 成成功。
4. 运行前端 typecheck、受影响组件套件、定向 Playwright 几何/导航/首条助手浏览器用例、生产 build。
5. 跑前端全量组件测试一次，分类报告。如果遇到已登记 `connectionsSettings.spec.ts` CLI_RUN UI 缺失或 `run-events` 时序失败，不跨范围补功能、不放宽断言；给出本轮新回归与既有失败的证据。已有 `uiOption2FirstSession` 32 vs 40 composer 行高失败也不在本轮四类问题中，不删除断言或修改 token 来迁就。
6. 向协调者交付实际命令、退出码、通过/失败数、受影响文件、未覆盖内容与必要文档修订建议。Windows 独立目视由协调者执行，不虚报你已做。

运行方式以 `apps/workbench/package.json` 为准。可用 `npm run typecheck`、`npm test -- <spec...>`、`npm run test:browser -- <spec...>`、`npm run build`。若 `.bin` 缺失，先检查对应包实体，可直接 `node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/vitest/vitest.mjs run ...`、`node node_modules/@playwright/test/cli.js test ...`，不为此盲目重装依赖。Playwright 默认 4173，当前用户原生窗口使用 5173；不要停止或占用用户现有服务，读取配置后采用独立测试入口。不能为测试访问用户密钥、发送真实 Provider 请求或写用户项目业务数据。

完整日志/批量截图放忽略目录 `output/acceptance-raw/windows-page-remediation-20261007/`，不新建长篇测试报告、不输出凭据。对于浏览器夹具，明确是拦截 API 的 Chromium 证据，不能升级成真实 API/PG 或 Windows 业务验收。

## 8. 完成定义与交付格式

四类问题均有代码修复和有效定向回归，普通模式、恢复身份、既有路由与非空详情行为未退化。typecheck 与 build 通过；本片新测试通过；全量失败按证据分类。不要将「发现方案」当实现完成。

最终以中文给协调 Agent：

1. 四类问题各自根因、修改点、当前行为，一项一段。
2. 修改文件列表与所有新增/调整测试的目的。
3. 实际验证命令、退出码、测试数量；红→绿证据简述。
4. 既有失败及本轮未验证项，清楚区分浏览器/真实 Windows/真实 API/安装。
5. 文档同步建议：交互规则归 workbench-design，若改共享布局则给 design-system 的限定修订；验收结果只归验收表本片行；进度与下一步只归 CODEX_NEXT_STEP。无 API/数据库变更则注明 Breaking Change：No，不新建 ADR。

协调整体完成条件：独立检查执行者 diff 与证据、必要复跑、computer-use 重验关键 Windows 页面，修复并复验后才给最终结论。用户未要求本片之外阶段，不推进其他 M/N 模块，不宣称安装交付。
