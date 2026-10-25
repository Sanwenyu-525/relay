# 测试规格与发布出口：分册 06

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../verification-plan.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

## 27. 验收证据与投入判断验收规格

2026-10-11 定义规格。依据[总纲 §0.14](../../requirements/product-spec/part-01.md#014-验收证据与投入判断)、[工作台 §29](../../frontend/workbench-design/part-10.md#29-验收证据与投入判断)和[后续路线 §10](../../requirements/post-v1-roadmap/part-02.md#10-验收证据与投入判断的范围和分期)。以下为目标规格，编号不等于实现或通过；2026-10-14 基础代码已映射 EVI-02/03 的导入、确切关联/读回/撤销，EVI-04 的旧验收关联标记，EVI-06 的持久计时及 EVI-07 的人工补录/未知/纠正来源。真实 PG/HTTP 入口为 [task-acceptance-materials](../../../apps/api/test/integration/task-acceptance-materials.integration.test.ts)，前端解析为 [materials client](../../../apps/workbench/tests/taskAcceptanceMaterialsClient.spec.ts) 与 [trials client](../../../apps/workbench/tests/taskAcceptanceTrialsClient.spec.ts)。协议归 HTTP 契约 §10.67–68 和数据库设计 §75–76；实际成绩仅在统一功能验收表记录，未覆盖规格不预填通过。EVI 编号仅用于本节场景映射，不新增 F/N 工作包。

| 编号 / 场景 | 必须验证的行为和反例 |
|---|---|
| EVI-01 单 Task 范围 | 默认只核对该 Task 已登记条件及确切证据；无明确查漏请求不调用模型扩大条件。AI 建议不自动成为生效验收要求或检查通过 |
| EVI-02 主动选材 | 内部证据与用户选入的文本日志、测试输出、Markdown 可回到确切正文版本与来源；不被动扫描全仓、外部 Agent 或账户，文件/工具正文不构成授权 |
| EVI-03 材料关联 | Task、验收修订、条件、被测版本和材料版本逐项核对；缺项、错关联、跨作用域、失权和不可读材料保留明确缺口，不能补猜或创建正式 CheckResult/PASS |
| EVI-04 证据适用性 | 条件或产物变化、旧 Trace 匹配、单项与组合检查分别覆盖；未运行、失败、工具故障、缺失、过期和待核实不合并为通过或普通失败 |
| EVI-05 同源入口 | 交付消息摘要与 Task 详情消费同一投影；部分读取失败和对象切换迟到响应不掩盖缺口或覆盖新对象。补救走原入口，不隐式启动新的完整补验闭环 |
| EVI-06 轻量计时 | 找证据开始、结束、暂停、继续留下可核对记录；有效计时、暂停和总经过时间可区分，暂停不改变 Task/Run。刷新、中断、重复提交及恢复按已核定持久化协议验证 |
| EVI-07 补录与总成本 | 一句话补录绑定正确试用，准备成本另列并计入总验收耗时；未记录项保持未知。查找节省但计入准备成本后总验收耗时未降低的反例，不能呈现为整体省时 |
| EVI-08 对比与护栏 | 相近任务/材料规模交替原流程和新视图，保留样本差异、原始时长及失败；基线后、对比前冻结相对降幅和口径。重复同题的熟悉效应、漏验及旧证据误用不被成功汇总隐藏 |
| EVI-09 假设建档 | 建议记录与明确用户请求区分；明确一句话可完成建档确认，不强制额外表单。假设可选，不要求每个小功能建档；首批试用不依赖完整假设系统 |
| EVI-10 结论与投入 | Agent 建议和用户确认分别保存来源/适用版本；证据不足为无结论，可靠充分但未达冻结目标时只建议停止下一阶段投入，不自动取消 Task、改计划或写业务完成 |
| EVI-11 决定复审 | 只对显式前提/关联假设的已记录变化准备候选；相关回执和项目摘要可追溯。未登记历史理由不补猜，候选不自动替代 Decision，不启动工作；基线更新后的旧候选须复核 |
| EVI-12 工作段基线 | 用户主动圈定功能/任务集，开始保存既有确认预期不创建任务、启动 Run 或应用计划；临时回顾缺历史预期保持未知，不用当前结果倒造基线 |
| EVI-13 产出与事件统计 | 预期、确切已验收产出、返工、介入和实际调用成本分开；多次重跑不能自动算返工。疑似事件先候选、确认后统计，重复确认不得重复计数，缺失用量/时间不补零 |
| EVI-14 主动范围推演 | 只有用户发起才生成首版推演，Agent 可提示入口；同一可用时间下比较全部做/缩小范围/推迟任务，候选明确范围、依赖和延后后果，不加入资源扩充维度 |
| EVI-15 推演与执行 | 固定基线、未知估时、来源变化、部分应用和活动任务竞争覆盖；未知不能承诺日期，选择方案走原计划 Owner，不自动 Delegate/审批或改活动 Task |
| EVI-16 Owner 与恢复 | 按核定协议，用真实持久化验证材料关系、假设结论、计时/预期、复审/统计候选的唯一写入口、revision、幂等、并发纠正与中断；迟到结果不能覆盖新基线，UNKNOWN 先按原身份核对 |
| EVI-17 真实体验与收益 | 匹配源码包，在真实 Windows 验证选材、摘要展开、计时暂停、自然语言补录及决定/计划入口；使用效果与功能正确性分别结算，文档/Fake/组件通过不作为实际省时或交付证明 |

领域规则用单元测试，新增关联、版本、幂等和候选处理用真实数据库；可控中断验证计时及候选恢复，界面检查成功、Loading、失败、冲突、未知与返回后的真实状态。实际试用保留准备成本和必要正确性反例，样本及阈值在运行前冻结，不预填数值或通过率。实际成绩只在运行后进入[统一功能验收表](../overall-acceptance-2026-09-28.md#当前功能验收表)，规格不维护当前阶段。

2026-10-14 比较数据补充映射：EVI-07/08 的已含准备总成本、未知、零基线、事前目标与观察版本冻结、全部试用保留、漏验自述和基线/材料变化标记，对应 [comparison unit](../../../apps/api/test/unit/task-acceptance-comparison.test.ts)、[comparison HTTP/PG](../../../apps/api/test/integration/acceptance-comparisons.integration.test.ts) 和 [comparison client](../../../apps/workbench/tests/taskAcceptanceComparisonsClient.spec.ts)。这是基础数据协议检查，不证明实际相似样本、交替顺序、熟悉效应控制或收益。

会话补录补充映射：EVI-07 的原文数字/单位、明确试用/聚焦澄清、来源消息、保留未提耗时及纠正历史，以及 EVI-16 的冻结试用 revision/原命令重放，对应 [statement unit](../../../apps/api/test/unit/acceptance-time-statement.test.ts)、[conversation HTTP/PG](../../../apps/api/test/integration/acceptance-time-conversation.integration.test.ts) 与 [conversation client](../../../apps/workbench/tests/acceptanceTimeConversationClient.spec.ts)。解释使用可控端口，真实 Provider 与 UI/Windows 效果分别待验。

基础假设补充映射：EVI-09/10 的明确建档、主张/方法/标准版本、观察与来源、建议和用户确认分离、证据不足无结论、停止投入仅建议，以及 EVI-16 的原命令/revision/旧定义和观察适用性，对应 [hypothesis unit](../../../apps/api/test/unit/hypotheses.test.ts)、[hypothesis HTTP/PG](../../../apps/api/test/integration/hypotheses.integration.test.ts) 与 [hypothesis client](../../../apps/workbench/tests/hypothesesClient.spec.ts)。这是数据功能检查，候选判断由调用方提交，不代表实际调用模型做过分析；真实 Provider、UI、收益可靠性与决定复审分别待验。

决定复审补充映射：EVI-11 的明确资料/假设前提、来源变化时事务内候选、未登记不推测、未确认假设建议不触发、用户保留/忽略及原决定替代；EVI-16 的指纹去重、来源/前提/决定基线适用性和原命令重放，对应 [review HTTP/PG](../../../apps/api/test/integration/decision-reviews.integration.test.ts) 与 [review client](../../../apps/workbench/tests/decisionReviewsClient.spec.ts)。复审不调用模型、不自动改决定/Task/Run；UI 与实际使用收益仍待后续验证。

工作段补充映射：EVI-12/13 的既有 Task/Goal/验收预期保存、本段新完成引用、未完成/基线变化/先前完成、确认事件与撤回历史、已知/缺失模型用量、无历史预期未知；EVI-16 的开始/结束/事件原命令与 revision，对应 [segment unit](../../../apps/api/test/unit/work-segments.test.ts)、[segment HTTP/PG](../../../apps/api/test/integration/work-segments.integration.test.ts) 与 [segment client](../../../apps/workbench/tests/workSegmentsClient.spec.ts)。模型账本为受控记录夹具，未跑真实 Provider 成本/效果；完整文件可用性沿原完成证据入口，本片不替代该检查或新增正式 PASS。

范围推演补充映射：EVI-14/15 的用户主动发起、同一容量/Task/验收/估时/Goal 基线、ALL/SHRINK/DEFER、必要前置与受影响下游、来源可靠性/未知、不改在途 Task、原计划候选与逐项应用；EVI-16 的原命令/来源版本/部分结果，对应 [scope unit](../../../apps/api/test/unit/plan-scope-simulations.test.ts)、[scope HTTP/PG](../../../apps/api/test/integration/plan-scope-simulations.integration.test.ts) 与 [scope client](../../../apps/workbench/tests/scopeSimulationsClient.spec.ts)。核对选择只创建新候选、原窗口不重置、Task 不因选择变化、诊断在原逐项入口才创建、原命令不重复建计划或诊断，来源变化保留旧比较并拒绝旧选择。原计划已部分应用需重新圈定，不能把选择成功当整段应用完成。资料/权限只标待执行核验，完成日期不承诺；无 UI、自动推演或真实收益证据。

## 31. 输入框自动分点与手动润色验收规格

2026-10-15。依据[工作台 §30](../../frontend/workbench-design/part-10.md#30-输入框自动分点与手动润色)；**本轮仅目标规格，以下未运行，不表示功能通过或已实施。** 实际结果仍只进入[统一功能验收表](../overall-acceptance-2026-09-28.md#当前功能验收表)。

| 编号 | 场景与必须验证的反例 |
|---|---|
| CO-01 触发 | 停笔才请求，中文组词期间零请求；相同已处理/已忽略版本不重复请求；空文、禁用、在途发送和斜杠命令不触发；短输入、已有清晰列表不强拆或反复编号 |
| CO-02 原话保真 | 分点仅用原文切片加格式，顺序不变、无遗漏/重叠/越界；去掉程序新增格式后逐字重建原文。覆盖重复句、中文/emoji、空白/标点、路径/URL/代码；畸形边界拒绝，不显示模型重写文本为保真结果 |
| CO-03 需求语义 | 覆盖否定、数字、条件、因果、先后关系及无标点多需求；不把原因强拆、不把「不要做」变成待做。确定性保真测试与真实模型语义样本质量分别说明 |
| CO-04 建议采用 | 提示不抢焦点，查看/忽略不改原文；采用才替换，撤销分点精确恢复采用前草稿。未采用建议不混入发送，无合理分点时不强拆 |
| CO-05 润色入口 | 不依赖先采用分点，点击才调用，重复点击不重复提交；成功保留已有分点并切换同一按钮，失败保留原文和润色入口；空结果/非法响应不得清空草稿 |
| CO-06 原文撤销 | 采用分点→润色→手动修改→撤销，逐字等于点击润色前快照，恢复已有编号，手动修改一并丢弃；提示可见、无需确认框、不调用模型；再次润色以新快照为准 |
| CO-07 迟到隔离 | 分点/润色在途编辑、发送、切会话/工作区/连接、卸载后返回均不覆盖；覆盖改文后又改回相同文本的反例，不能仅凭字符串相等采用旧结果 |
| CO-08 发送与恢复 | 只发送可见草稿一次，不因辅助操作创建消息/Task/Run；成功清理本次辅助状态，失败保留草稿/快照，未知回执保留原发送载荷。原机制恢复草稿时匹配恢复快照，否则不展示虚假的撤销能力 |
| CO-09 暂停与失败 | 润色成功后的编辑不触发自动分点，撤销/成功发送后恢复；分点失败不阻止正常发送，无配置/超时/预算拒绝如实显示，无无限重试或伪造成功 |
| CO-10 服务边界 | 既有鉴权、工作区/会话范围、长度/超时/频率与预算约束成立；只送当前草稿和必要规则，不读取文件/历史、不执行草稿命令；真实调用计入既有用量，不为整理创建占位 Task/Run |
| CO-11 输入兼容 | 首条与已有会话均可用；原 Enter/Shift+Enter、斜杠菜单、中文 IME、资料/目录和草稿离页守卫不退化；键盘查看/采用/撤销、读屏提示与窄窗不遮挡发送分别检查 |
| CO-12 三方案预览 | A 浮层/B 卡内/C 侧边均走同一交互语义，结构明显不同；可输入、停笔、查看、采用、润色、手改、撤销、失败重试及模拟发送；数据全为标注的模拟，不能调用真实模型/API或改产品业务事实 |

纯切片验证、定时/请求版本及撤销状态用定向单元和组件测试；服务端准入/真实记账改动涉及持久化时补对应真实 PG/HTTP 检查，不因本功能默认添加 migration。浏览器覆盖实际输入与焦点、布局和错误路径。真实 Provider 样本评价、真实 Windows IME/DPI 与安装态分别取证；fixture、组件通过和原型截图不能替代它们。

### 31.1 本轮实际覆盖（2026-10-16）

2026-10-16 按[开发任务书](../../../prompts/composer-outline-and-polish.md)接入源码（实现默认 A，见[工作台 §30.6](../../frontend/workbench-design/part-10.md#30-输入框自动分点与手动润色)），下列出口已实际运行：

- `apps/api/test/unit/composer-draft.test.ts`（**10/10**）——CO-02 的确定性部分：文档示例去掉程序新增编号/换行后逐字重建原文；重复句、空白与标点、路径与 URL、emoji（代理对按码点计数）保真；畸形边界 9 类拒绝（非 JSON、非对象、多余字段、非整数、越界、非递增、条目超限、空白段）；空边界是合法回答；CO-05 的润色协议（空串/多余字段/非 JSON/超长一律拒绝，拒绝 ≠ 清空草稿）；CO-01 的适用性（短输入、已分行、斜杠命令、空文）。
- `apps/api/test/unit/composer-draft-port.test.ts`（**3/3**）——CO-10 的请求形状：两条路由的登记元数据与统一入口一致、不加载公共核心；受控 HTTP 捕获**最终发出体**，证明分点请求只含 system 模板 + 当前草稿（草稿标注 UNTRUSTED_DATA、其中的指令仍是数据）、`response_format=json_object`、无工具声明；润色走另一条模板。
- `apps/workbench/tests/composerDraftAssist.spec.tsx`（**13/13**）——CO-01/04/05/06/07/08/09 的状态机：停笔前零请求、短输入不请求、组词期间零请求、忽略后同一版本不重复请求、查看不改原文、采用替换、撤销分点精确恢复、Esc 关闭浮层并交回焦点、润色中态与「同一按钮变撤销」、开始润色结束分点撤销入口、撤销润色逐字恢复润色前快照并丢弃手动修改（含 `aria-describedby` 后果提示）、润色失败与空结果保留草稿且可重试、辅助失败如实显示且不阻止发送、迟到隔离（在途编辑后丢弃；改回相同文本也不复用旧结果）、草稿清空后复位、来源变化清空，以及**键位回归**：润色键在 `.agent-chat-composer-tools` 内、提示行与其同级、浮层绝对定位不推动布局。
- `apps/workbench/tests/browser/composerDraftAssist.spec.ts`（真实 Chromium，API 全部 `page.route` 伪造，不连数据库、不调 Provider，**3/3**）——主路径与迟到覆盖：提示行不抢焦点、润色键确实落在输入卡工具行内（按边界框比对，不另起一行）、浮层锚在提示行上方且不推动布局也不遮输入卡与发送键、采用/撤销真的改回输入框内容、润色按钮二态与后果提示可读屏、在途编辑后旧回包不覆盖草稿；同时断言除草稿辅助外零写请求（辅助不创建消息/Task/Run）。
- `apps/api` 全量 `tsc --noEmit`、`apps/workbench` 全量 `tsc --noEmit` 通过。

**已写未运行**：`apps/api/test/integration/composer-draft-assist.integration.test.ts`（真实 PG）覆盖 CO-08/CO-09/CO-10 的持久化部分——`model_calls` 的 `COMPOSER` 行无 Run/会话作用域且按 `COMPLETED` 结算真实 usage、业务计数（tasks/runs/assist_messages）前后不变、不适用时不写行、畸形协议仍记 `COMPLETED`、Provider 失败记 `FAILED` 与错误分类、闸门限流不写行也不外呼、未配置与超长在开事务之前拒绝、HTTP 401/409/422。共享工作树另有并行实例、机器非空载时并发 `run-integration.ps1` 会挂死或偶发假失败，故**留待空载以 `-TestFile composer-draft-assist` 单跑**，本轮不计入通过。

**未覆盖，不得当作已验**：**真实 Provider 的语义质量样本**（是否切在正确需求边界、是否把原因强拆、是否把「不要做」变成待做——CO-03 的语义部分只有协议与保真证据，没有质量评价）；**真实 Windows 窗口的 IME 组词、DPI 与安装态**；**三方案预览**（CO-12，原型任务书未下发）；跨连接/工作区切换的迟到回包（组件按来源 + 版本核对，未做双连接实机取证）。

## 32. 聊天消息时间线导航验收规格

2026-10-16 定义规格，同日实施首版并按下列范围运行。业务与阅读行为以[工作台 §31](../../frontend/workbench-design/part-10.md#31-聊天消息时间线导航)为唯一来源，视觉规则以[设计系统 §9.12](../../frontend/design-system/part-04.md#912-聊天消息时间线导航设计补充)为准；本节只登记规格与实际运行范围，成绩只记[功能验收表](../overall-acceptance-2026-09-28.md#当前功能验收表)。

- 核对每个节点绑定原会话与确切消息，重复内容、相同时间和流式更新不串位；点击首/中/末节点后目标开头可读，固定顶栏不遮挡，连续点击以最后目标为准。
- 悬停及键盘聚焦显示原文片段，截断可辨、无模型调用；预览不自动跳转或抢焦点，Enter/Space 可跳转，Esc 可关闭，手动滚动更新当前位置。
- 跳到历史后收到新消息、流式内容增长或布局变化不强拉到底部；回到最新后原跟随规则恢复，未发送草稿与原发送/停止入口不退化，导航零业务写入。
- 空会话、读取中、失败、部分历史已加载及目标暂不可读分别核对；只展示真实可读范围，不以相邻消息替代失效目标；切会话/工作区/连接后旧预览与迟到跳转不得作用于新消息流。
- 长会话、窄短窗、键盘、减少动态效果及真实 Windows/DPI 分别检查：刻度命中区不重叠、浮层不越界、不挡输入/发送，消息流仍是唯一正文滚动容器。组件与浏览器结果不代替真实窗口证据，实际成绩只记统一功能验收表。
- 刻度组在轨道可视高度内垂直居中，长会话放不下时退回从顶排列且第一条刻度仍可达；指针在轨道内移动时刻度长度按「指针到刻度中心的距离」连续递减（峰值在指针处、超出影响半径回默认档），移出轨道后复位，当前位置那档不被压短，联动不改变节点身份、命中区与跳转目标（2026-10-16 同日第二轮）。

### 32.1 本轮实际覆盖

2026-10-16 同日第二轮的刻度组居中与悬停长度联动已并入下列两条出口，数量按本轮结果更新。

两条出口都跑过：`tests/chatTimelineNav.spec.tsx`（Vitest + jsdom，19 例）负责身份与算术——节点只落用户消息、缺失正文不建节点、首/中/末落点等于「该条开头 − `space.2`」、重复文字与跨会话同 ID 不串位、目标缺失只提示不跳转、截断长度与省略号、富文本按文本呈现、Esc 消费与不消费的分界、`aria-current` 跟随滚动、卸载与连点清除落点强调；第二轮新增四例覆盖「距离 → 刻度长度」纯函数（峰值、单调递减、超半径与非法距离回基准）、指针在轨道内按距离写长度（峰值随指针移动、当前位置档不被压短）、指针移出后清空内联长度并回落各自默认档、触屏点按不进入联动。`tests/browser/chatTimelineNavigation.spec.ts`（Playwright Chromium 1440×900 与 900×700，API 全部 `page.route` 伪造，不连数据库、不调 Provider，11 例）负责真实布局下的行为——落点确实停在读区上沿（平滑滚动动画结束后再量）、末条受物理滚动上限约束时如实落在底部、浮层不压输入器与发送键且不抢输入焦点、导航期间零非 GET 请求且草稿保留、历史阅读期新消息到达（末尾 RUNNING 回复经 1.5s 轮询转完成并新增一轮）不打回底部且「回到最新」仍可用、导航轨滚轮只滚自己、切会话后旧节点/预览/跳转全失效、空态与读取中/失败不伪造节点、窄列降为紧凑入口且展开仍是浮层、`prefers-reduced-motion` 下落点仍准确；第二轮新增两例在真实几何下核对联动形状（峰值在指针处且严格长于其余、按距离排开的非当前刻度单调不增、相邻档高于基准又低于峰值、超出 72px 半径回 8px、当前位置档保持 16px、移出后按默认档复位）与居中（短会话首尾留白等量、长会话溢出时只剩轨道自身内边距且首刻度仍在可视区内）。

本轮顺带修正了该浏览器用例的进入方式与一处断言语域：`openChat` 原先点 `collab-viewtab-chat`，而协作页的任务表头在聊天视图下整块 `hidden`（`CollaborationView` 的 `collab-goal`，同日并行改动），页签此刻不可见；聊天视图本来就是默认视图（`useState<"chat" | "task">("chat")`），故改为直接等聊天列渲染。「导航与预览零业务写入」一例把并行在途的输入器草稿助手端点 `POST /composer/draft-assist`（打字后自行发起，与时间线无关）排除在断言外，其余任何非 GET 请求仍必须为空。

未覆盖，不得当作已验：**真实 Windows 窗口与 DPI**（本轮只有 Chromium 无头视口）、**嵌入态任务详情里的会话历史**（未接入，见工作台 §31.4）、**部分历史已加载**（读取入口一次返回 `limit=200`，没有更早历史的续读路径，因此该分支无对象可测）、跨连接/工作区切换的迟到跳转（组件按会话身份核对，未做双连接实机取证）。截图留本机 `apps/workbench/results/chat-timeline-*.png`（第二轮新增 `chat-timeline-tick-falloff.png`、`chat-timeline-centered.png`）。

## 33. 两级上下文菜单验收规格

2026-10-16 定义规格，同日实施并按下列范围运行。业务与交互契约以[工作台 §32](../../frontend/workbench-design/part-11.md#32-两级上下文菜单与二级能力入口)为准，视觉以[设计系统 §9.14](../../frontend/design-system/part-05.md#914-两级上下文菜单视觉补充)为准。

- 一级七项（2026-10-24 起）保留原身份与顺序并在顶部补齐参考菜单三项：上传附件、文件、我的产物、选择文件与资料、选择 Skill 生成、输入命令、连接器与插件；状态提示只反映真实事实（已选资料数、已绑定目录、已选 Skill），没有对应事实时不显示提示，也不编造计数。
- 点击一级行展开/收起二级且一级保持打开；点二级行执行后收起两级，且**不改动未发送草稿**；点击外部一次收起两级；Esc 先收二级（焦点回原一级行）再收一级（焦点回「+」）。
- **hover 展开（2026-10-17 用户指令）**：指针悬停一级行即展开该行二级，在两行之间移动即切换；指针移开两级后二级延时收起而一级保持打开；hover 打开的二级被点一次是「固定」（之后移开不收），再点一次才收起；禁用的行 hover 不展开。二级纵向**相对一级弹层居中**（2026-10-19 用户指令，取代「贴住当前那一行」）：`top = (一级高 − 二级高) / 2`，二级更高时上探出一级顶边、唯一硬边是视口顶边；一级贴近视口底部时改为二级底边与一级底边对齐；两档都放不下交给 `max-height` 内部滚动。
- **二级列表在前（2026-10-17 用户指令「子菜单应该直接将文件、skill 列出来」）**：资料二级先列项目资料（当前项目 `ACTIVE` 知识、取 `currentVersion`、最多 20 条、超出指向检索）→ 对话中的资料 → 最近引用 → 检索；本地文件行已于 2026-10-19 移除（图片选择由一级「上传附件」承担，任意本地文件仍不接入）。Skill 二级先列发送选项那一份 `skills`（每个 id 只列最新版本、不可调用项禁用并标「不可调用」、点击写入同一处 `selectedSkillKey`）→ 生成类两条（禁用）→ 在发送选项里选择。项目资料读取失败只在该节说明，不遮挡其余入口。
- **参考菜单三项（2026-10-24）**：一级「上传附件」是直接动作，打开本机图片选择器（PNG/JPEG/GIF/WebP）并交给既有 `useStagedAttachments`，不上传、不发送；「文件」二级用 `POST …/managed-resources/:r/file-read` 的 `LIST_DIRECTORY` 列受管根一层，目录行在同一面板内进入子目录（出现「返回上级」）、文件行插入 `@相对路径 ` mention，`truncated`/`skipped`/失败/未决与无目录/无连接各有文案，失败不显示成空目录；「我的产物」二级用 `getTaskArtifacts` 列当前任务产物最新版本、点一项插入 `@标题 vN ` mention，无任务归属说明去向。文件与产物只是草稿 mention，不是消息附件或 `RelayAssistSourceRef`；不出现第三级。
- 二级方向按实际空间决定：右侧放不下且左侧放得下时翻到左侧；纵向贴住当前行、越界向上收、放不下时收窄面板高度由内部滚动兜住；不得出现横向溢出或改变页面布局。
- 「对话中的资料」只列当前会话消息上真实出现过的引用（去重、三元组齐全、只收知识/记忆/决定三类），没有时给空态文案；开关只改本次候选输入，不发送、不落库、不发新命令；达到每次消息 10 个的上限时未选中项禁用而不是静默丢弃点击。
- 「最近使用」目录来自真实近期目录并复用协作页的目录入口与草稿守卫；无记录时给空态。命令清单来自 `GET /chat-commands` 真实登记、与输入框内联菜单同一套过滤与状态口径，点击只把命令填进草稿。
- 尚未接入的能力（任意本地文件作为消息输入——一级「上传附件」只收图片、管理工作区、Skill 生成两条）如实禁用：行内只写「暂未接入」，原因与接入点只在行的 `title` 里；菜单不再有整段脚注（2026-10-19 用户指认「很影响体验」，见工作台 §32.12）。禁用的行不显示 chevron、不进入焦点顺序，也不带 `aria-expanded`。
- **「选择 Skill 生成」与「连接器与插件」恒可展开（2026-10-18 用户指认「点击不了」）**：没有项目/任务归属、未连接本机 API 这些情况下保留 `disabled === false` 与 chevron，缺口由二级面板第一句（`noteFor` 的同一句文案）说明；连接器面板在无项目时不再停在「正在读取连接器…」，而是直接说明按项目登记，「管理连接与权限」仍可点。仅「没有二级可讲」的行（首条消息的资料、无目录入口时的文件夹）保持禁用。
- **Skill 清单全量 + 目标芯片（2026-10-18 第二轮，用户指令「不应该跟工作区产生强关联」）**：两处输入器的「+ → 选择 Skill 生成」都列出全部内置 Skill（只按输出契约白名单过滤，不按 `target.kind` 过滤）；缺上下文的行尾标 `需任务 / 需项目` 并在 `title` 说明。首条输入器选中这类 Skill 后，工具行出现目标芯片：项目来自 `GET /projects?status=active`、任务来自 `GET /tasks?project_id=`，前端不写死；选定后交回宿主以 `?work=` / `?project=` 切作用域并带 `?skill=` 预选、`?new=` 新开对话。会话输入器（归属已冻结）只标注 + 禁用，`<select>` 同步不可选并说明去哪补。芯片不建会话、不改归属。
- 键盘：Tab 按原生顺序、↑↓ 在当前层内移动、→ 展开二级并把焦点交给第一个可用项、← 收二级回原一级行、Enter 激活、Esc 两段关闭；组词期间的键不触发菜单动作。
- **连接器与插件二级（2026-10-17 用户指令「github、chrome 和电脑插件放到 UI 里，不硬编码、动态读取」）**：一级第五项恒可展开（2026-10-18 起，无项目归属时面板说明缺口，见上一条）；清单动态来自 `GET /projects/:id/gateway-connections`，前端只有能力键 → 中文名映射（`lib/labels.ts` 的 `gatewayCapabilityLabel`，连接页共用，未知键回退原文）；每个能力一行、用 `p` 状态行而不是按钮（连接器是执行时的准入语义，不是消息附件），停用/撤销连接如实标注；空清单与读取失败各有文案；「管理连接与权限」走既有 `/settings/connections`。
- 动效只做轻微位移与淡入（`motion.duration.fast`），`prefers-reduced-motion: reduce` 与 `html[data-motion="off"]` 下动画为 `none` 且状态文字不变。
- 面板宽度收缩到内容、行内左右留白对称（2026-10-16 用户截图指认「菜单右侧留白太多」后补）：一级与二级面板都由最宽的一行决定宽度，行尾状态位与 chevron 组成一个右对齐的尾组，各行尾组右缘距行右缘相等；空态不参与固有宽度计算，长说明只折行、不撑宽面板（脚注已于 2026-10-19 删除）。

### 33.1 本轮实际覆盖

**2026-10-17 追加（hover 展开、二级列表化与连接器二级）**：`tests/composerAttachMenu.spec.tsx` **24/24 全绿**（原 16 例 + 新增 8 例：hover 展开／固定／移开延时收起／禁用行不 hover、项目资料直接列出并勾选、项目资料读取失败、Skill 直接列出与选中、连接器动态清单与空态/读取失败文案）；`tests/connectionsSettings.spec.ts` **23/23 全绿**（连接能力清单扩到 15 项，覆盖电脑 / GitHub / 浏览器三族）；`tests/assistantModeSwitch.spec.ts` **47/47 全绿**（真实 `/agent` 路由下的「+」弹层既有用例仍走点击语义）；`apps/workbench` `tsc --noEmit` 通过。真实 Chromium 用临时预览页量过 hover 展开、贴行定位（二级面板 `data-flip`、贴住当前行、超视口时收窄高度内部滚动）、移开 500ms 后二级收起且一级保持打开，预览页与截图脚本用后已删。未跑：Playwright 产品页面、真实 Windows 窗口与 DPI。

**2026-10-18 追加（Skill 与连接器入口恒可展开）**：`tests/composerAttachMenu.spec.tsx` **24/24**、`tests/assistantModeSwitch.spec.ts` **47/47**、`tsc --noEmit` exit0。改动把两项一级行的 `disabled` 去掉（无归属/无项目时仍可点开），断言随之从「禁用 + 无 `aria-expanded`」改为「可展开 + 面板首句说明缺口 + `title` 与脚注同源」；连接器无项目一例新增「面板不再停在『正在读取连接器…』且管理入口仍在」。未跑：真实 Chromium/Playwright 产品页面、真实 Windows 窗口与多 DPI。

**2026-10-18 第二轮追加（Skill 清单全量与目标芯片）**：`tests/composerAttachMenu.spec.tsx` **25/25**（新增「清单全量：缺上下文的行标注、能就地补齐时仍可选、归属冻结时禁用并说明」）、`tests/composerTargetPicker.spec.tsx` **4/4**（新建：项目清单来自接口、任务经项目两级、空清单与读取失败文案、无 API/发送中不可展开）、`tests/assistantModeSwitch.spec.ts` **47/47**（`/agent` 首条不再有 Skill 脚注，只有资料与连接器两条）。`tsc --noEmit` 通过；同一时刻 `tests/composerImageAttachments.spec.tsx` 有并行会话未完成的改动（`init` 未定义），与本轮无关。`?skill=` 深链预选、`?work=` / `?project=` 作用域切换只有 jsdom 断言与源码核对，未跑真实路由端到端。

**2026-10-19 晚追加（去掉菜单说明文字）**：`tests/composerAttachMenu.spec.tsx` **26/26**、`tests/chatCommandInput.spec.tsx` **7/7**、`tests/assistantModeSwitch.spec.ts` **47/47** 全绿。断言从「脚注存在且被 `aria-describedby` 引用」改为「`.agent-chat-attach-note` / `.agent-chat-attach-subnote` 节点数为 0、原因在行 `title` 上、可用的命令不再有状态标签」。`tsc --noEmit` 仅剩并行改动涉及的三份测试文件（`composerAttachmentPreview`、`memoryStatusClient`、`tmpFlashProbe`）报错，与本轮无关。真实 Chromium 的 `uiOption2FirstSession.spec.ts` 单条用例在本机两次单独运行分别停在首次点击与发送环节（失败点不同、均早于本轮改动的断言），判为**该用例在本机的不稳定**，未作为本轮证据。

**2026-10-19 晚追加（二级纵向定位：相对一级居中 / 贴底时底边对齐）**：真实 Chromium 临时预览页（挂载 `ComposerAttach` + stub client，引用真实 CSS 与 token，用后已删）量得四档——1280×900 与 900×620 下二级 offset 恰为 `(96−222)/2 = −63`（居中）；一级贴底档（1280×380）二级底边与一级底边差 0；二级比视口还高的极端档（1280×300）被 `max-height` 夹住、面板顶边 83px 未越出视口。截图留 `apps/workbench/results/attach-submenu-*.png`。单测套件复跑全绿：`composerAttachMenu` **25/25**、`assistantModeSwitch` **47/47**、`chatCommandInput` **7/7**（三份并跑时出现过成组抖动，单跑全绿，与 §33 首轮的并发提醒同因）。未跑：真实 Windows 窗口与多 DPI。

2026-10-16 首次实施：

两条出口都跑过。`tests/composerAttachMenu.spec.tsx`（Vitest + jsdom，**16 例全绿**）在组件层锁定菜单框架：一级四项与状态位、二级开合、引用开关与 10 个上限、三类空态、键盘四键、Esc 两段、外部点击、方向翻转、未接入项的禁用与脚注、命令清单读取失败文案，以及**尾组结构**（状态位与 chevron 同组、面板不写死最小宽度——jsdom 量不到几何，这条结构断言与下面的 Chromium 实测共同守住对称规则）。`tests/assistantModeSwitch.spec.ts`（**47/47 全绿**，该文件另含并行实例新增的输入器布局结构断言）在真实 `/agent` 路由下补两条集成用例：目录二级展开→未接入项禁用→「选择文件夹」打开协作页既有的「更换目录」对话框；命令二级列出真实登记→点击把 `/review ` 填进首条草稿且零 POST。`apps/workbench` 全量 `tsc --noEmit` 通过、`vite build` exit 0。

几何证据（真实 Chromium，临时量测页引用真实 CSS 与真实 token 值，用后已删、不作为产品页面保留）：一级面板宽度 235px → **200px**、二级面板 → **194px**；各级逐行实测「尾组右缘距行右缘」恒为 8px＝左内边距；对照组（长脚注不排除固有宽度）二级面板会被撑到 345px，故 `width: 0; min-width: 100%` 是必要而非装饰；二级面板 25 行超高滚动时 `scrollWidth === clientWidth`，无横向溢出。

为让真实路由用例能点到目录入口，`tests/setup.ts` 补了 `Element.prototype.scrollIntoView` 的空实现（jsdom 无布局，真实浏览器有；既有 `window.scrollTo` 同一做法）。

未覆盖，不得当作已验：**真实 Windows 窗口、DPI 与原生 IME**；**浏览器层 Playwright 规格**（本轮未跑）；**真实模型**（本片不涉及模型调用）；「左右两侧都放不下」的极端窄窗档位。全量 vitest 本轮在共享工作树内与并行实例同时运行，出现成组的用例级抖动（同一文件单跑全绿），故只把上列定向出口作为本片证据：`collaborationWorkspace` 的 1 例执行摘要文案与 `run-events` 的 SSE 时序是既有失败；`assist-flow`（4 例）与 `firstPartySkills`（1 例）走 `?skill=assist` 项目/任务子页，其路由假设已被并行实例「旧 Assist 入口统一到 `/agent`」（`ProjectSkillView.tsx` 改为 `<Navigate to="/agent?project=…">`）取代，属该改动的待同步夹具，与本片无关；`responsiveTiers` 的 1 例报的是并行实例新增的 `components/ComposerDraftAssist.css` 旧式 `max-width` 写法。

## 34. 会话局部与总 diff 验收规格

2026-10-16，**以下均为待运行规格，不是通过证据**。产品规则唯一见[工作台 §34](../../frontend/workbench-design/part-12.md#34-会话局部与总-diff)，视觉见[设计系统 §9.15](../../frontend/design-system/part-05.md#915-会话-diff-的展示建议)，实施见[专项提示词](../../../prompts/conversation-live-diff.md)。场景编号 CD 用于需求、测试与交付映射，不新增业务状态枚举。

| 编号 | 场景与通过条件 |
|---|---|
| CD-01 两个位置 | 聊天逐文件编辑记录旁显示局部数；输入卡外上方居中显示会话总数；不是只在右栏或最终回复显示 |
| CD-02 正确起点 | 预置已暂存、未暂存、未跟踪内容后开始会话，初始增删为零；随后只计相对真实会话快照的变化；内容与 HEAD 不同也不能算初始新增 |
| CD-03 净变化 | 同一行反复修改后恢复、新建再删除、删除再恢复，净数各自回零，局部历史仍保留；两处数量允许不同但各自基线明确 |
| CD-04 生命周期 | 连续两条用户消息、多个 Run、暂停恢复、刷新及重启 API/Worker 后，沿原会话起点；真正新会话使用自己的基线 |
| CD-05 历史和目录 | 旧会话无起点时不可用；主动从现在开始显示新起点；换目录另建明确新段，不跨段汇总，返回旧目录不误用过期 epoch |
| CD-06 范围与拒绝 | 根为仓库子目录时不读取兄弟目录；覆盖未忽略的新文件；忽略项、敏感文件、越界、Windows 大小写/重解析点、子模块按原权限与范围处理，失权不可通过历史正文绕过 |
| CD-07 Git 不副作用 | 真实临时仓库中确认基线建立/查询不创建 commit/stash/分支、不改 index；用户暂存或提交后原会话数值仍成立；无初始提交也能建立内容基线 |
| CD-08 基线竞争与容量 | 并发首次请求只发布一个有效起点；捕获中遇到目录变化有界重试或明确不可用；大文件/文件数/总量超限列明，不把部分数据冒充完整；失败不丢原消息、不破坏原执行流程 |
| CD-09 生成中更新 | 可控模型分多批输出 `apply_changeset` 参数，至少两次真实预览变化出现在流结束与工具派发之前；不是前端定时造数或完整结果到达后的补间 |
| CD-10 片段解析 | JSON 转义换行、反斜杠、拆开的 Unicode、半截 content、路径晚到、多文件、两个交错工具调用均归属正确；不数原始 JSON 行、不执行片段；输出/CPU/频率有上限 |
| CD-11 预览语义 | 完整 MODIFY 目标到达前不把未到达文件尾部算成已删除；缺基线不猜行数；预览可修正、不标已修改，也不进入总数 |
| CD-12 准入和实际结果 | 等待批准、拒绝、取消、写入失败、部分应用与 UNKNOWN 逐文件真实显示；成功数绑定原操作及确切实际内容；UNKNOWN 不盲重试，目录统计不替原动作结算 |
| CD-13 多轮与迟到 | 切会话、目录、重试/新模型调用及权限变化后，旧片段/查询/终态事件不能复活旧数据；重复事件不新增编辑行或累计数字 |
| CD-14 外部编辑 | 会话激活时人工/受控 CLI/另一会话写入，在约定刷新预算内反映于总数；标明同期修改而非 Agent 归因，不越过目录资源排他 |
| CD-15 一致性与断线 | 总数和展开列表绑定同一修订及采样时间；事件断开后可补读，重新连接不重放加数；旧 revision 不能覆盖新值 |
| CD-16 字符与文件类型 | 中文、空文件、无末尾换行、CRLF/LF、二进制、重命名按方案固定规则；二进制不能编造行数，新增/删除/修改路径数按统一规则核对 |
| CD-17 空与错误 | 无目录、非 Git 根、缺基线、失权、统计中、空净变化、部分不可统计、刷新失败分别可辨；失败保留上次可信值和时间但不掩盖失权，不把未知显示为零 |
| CD-18 展开阅读 | 局部打开原编辑前后；总入口打开原会话起点到同一当前修订；展开时正文与统计匹配，历史查看不误读当前磁盘；超限明确而不假装完整 |
| CD-19 布局与可访问性 | 窄/宽视口长文件名、数字位数变化不遮发送/停止，不改变输入卡高度、草稿/光标/组词；键盘开合与回焦、可访问名、颜色/符号与 reduced-motion 正确 |
| CD-20 真实环境分层 | 真 PG 验证基线发布/唯一性/epoch/恢复；真 HTTP/API-client 验证权限与字段；临时真 Git 仓库验证净变化；浏览器验证实时流及位置；真实 Provider 和 Windows 窗口另行报告，不能用 Fake 或截图替代 |

先用受控片段与故障点固定身份、预览、实际结果和重启恢复，再在一次性目录/Git 仓库中做读写实验，不能拿用户当前工作目录作破坏性测试。涉及持久化约束必须执行真实 PG，不能以模拟 Repository 代替。具体刷新预算、扫描和响应上限在实现时先确定并写入接口/相关文档，再按同值验证；不把方案中的推荐周期当已测延迟。运行后只在统一功能验收表维护实际成绩与限制，本节保持测试契约。

## 35. 内置 GitHub Skill 只读片（0103）

2026-10-17。范围与取舍见 [ADR-023](../../decisions/ADR-023-builtin-github-skill.md)，实现边界见[工具适配器 §4.1](../../architecture/tool-adapters.md#41-github-只读查询01032026-10-17-开发自检)。场景编号 GH 只覆盖首片只读；GitHub 侧写动作与随包 Skill 资源另行补规格。

| 编号 | 场景与通过条件 |
|---|---|
| GH-01 能力与动作词表 | 只有 `GITHUB_READ` 一个只读能力，四个动作（仓库信息、PR 列表、PR 查看、Issue 列表）；词表外动作与 `gh_api` 一律拒绝，不进入 Gateway，不产生 Operation |
| GH-02 来源与资源 | 只放行 `ASSISTANT_READ`/`AGENT_SESSION_READ` 且必须绑定受管资源；`RUN`、`USER_ACTION`、`USER_IMPORT` 与无资源行被数据库 CHECK 拒绝；三条相关约束逐条重述而非覆盖 |
| GH-03 按需激活 | 只有存在 ACTIVE `GITHUB_READ` 连接时四个工具才进当轮词表；停用连接后下一轮立即消失，历史读取不受影响 |
| GH-04 目标绑定 | 目标恒为用例选定的受管根，Permission 按该根前缀判定；模型参数中的仓库名被丢弃/拒绝，适配器 argv 的 `--repo` 只能来自本地解析结果 |
| GH-05 仓库身份 | 从受管根的真实 `git` remote 解析，只认 `github.com` 的 https/ssh/scp 写法，多 remote 按名确定性选择；没有 GitHub remote 时报 `GH_REPO_UNIDENTIFIED`，不发网络请求 |
| GH-06 参数与进程边界 | `execFile`/`shell:false` 结构化 argv，固定只读标志；环境为显式白名单，不转发 `RELAY_`/token；超时与取消有界 |
| GH-07 缺失 CLI | 本机没有 `gh` 时结算 `FAILED` + `GH_CLI_UNAVAILABLE` 并给安装提示，不显示为空列表 |
| GH-08 失败分类 | 未登录、网络、仓库未识别、查无此项、权限/限流、超时分别可辨；错误不泄露凭据，不把失败当成功或空结果 |
| GH-09 有界投影 | 列表条数、PR 正文、状态检查数量有上限，截断显式可见并保留总数；所有外部正文带不可信标记 |
| GH-10 逐动作权限 | `repo_view` 与 `pr_list` 等动作分别受 Permission 约束；只授权一个动作时另一个仍被拒；被拒请求不落 Operation |
| GH-11 与其他能力共存 | `GITHUB_READ` 不放宽 `FILE_READ`/`FILE_QUERY`/`GIT_READ` 的范围，文件读取仍被限制在自己的受管根；只读轮次不创建 Task/Run/范围授权 |
| GH-12 真实 PG 与既有回归 | `0103` 在真实 PostgreSQL 迁移链应用成功；原始 INSERT 正向/反向反例通过；受约束重述影响的既有套件（助手只读、人工 Git、真实工具 Gateway、迁移）全部保持通过 |
| GH-13 真实 Windows 与安装包 | 真实 Windows/WebView2 窗口、打包后资源解析与安装验收；本片未运行，不得以开发模式顶替 |
| GH-14 真实已认证读取 | 在安装并登录 `gh` 的机器上执行四类读取，核对真实仓库、权限失败、限流与网络错误；本片未运行 |

**本轮实际覆盖（2026-10-17，开发自检）。** GH-01–GH-12 已由 `github-read.test.ts`（**16/16**）与真实 PostgreSQL 上的 `github-read.integration.test.ts`（**8/8**）覆盖；受 `0103` CHECK 重述影响的既有集成套件回归 **85/85**（助手只读 6、人工 Git 15、真实工具 Gateway 54、迁移 10），退出码 0，临时集群正常关停并删除。GH-13/GH-14 未运行：本机没有安装 `gh`，无法提供真实已认证读取或限流证据；官方 Skill 原文尚未进入打包与运行时提示，也没有 GitHub 写动作。上述成绩只说明开发自检通过，不构成 F25 验收。

## 36. 内置浏览器自动化验收规格（2026-10-17）

范围与选型见[浏览器自动化 V1](../../architecture/browser-automation-v1.md)，取舍见 [ADR-024](../../decisions/ADR-024-builtin-browser-automation.md)。本节为**未运行规格**：架构审查完成，源码、迁移与随包资源均未开始，验收表对应行记「未实施」。场景编号 BR 覆盖 F26 首片（浏览器自有实例 + 页面级隔离 + 三能力）。

| 编号 | 场景与通过条件 |
|---|---|
| BR-01 启动与连接 | Relay 拉起自有 Chrome（独立 profile、`--remote-debugging-port=0`、读 `DevToolsActivePort`），MCP 以 `--browserUrl` 附着；`ensureStarted` 返回 `READY`，`tools/list` 覆盖冻结映射表全部所需工具；不复用用户默认 profile |
| BR-02 缺失与不兼容 | Chrome 未安装/路径无效 → `CHROME_MISSING` + 可操作诊断，不抛栈；后端入口缺失 → `BACKEND_MISSING`；上游工具缺失或版本不符 → `INCOMPATIBLE`，不做降级猜测 |
| BR-03 读取与有界投影 | `browser_read_page` 返回 url/title/readyState/a11y 快照与 uid，超限截断显式标记；`browser_screenshot` 只返回摘要（宽高/字节/sha256），图片正文不进账本与日志 |
| BR-04 定位与元素不存在 | 只接受快照 uid；uid 不存在/已失效返回类型化失败并提示重读，不退回坐标点击、不静默重试 |
| BR-05 加载超时与等待 | `browser_wait_for` 在文本出现时成功、超时按类型化失败结算；导航超时不留下半可信动作，结果为 UNKNOWN 且页面标记 STALE |
| BR-06 页面所有权 | 未登记 page_id（用户自建页、其他 Run 的页）→ `BROWSER_PAGE_NOT_OWNED`，不导航、不点击、不关闭；`browser_close_page` 只关闭自有页 |
| BR-07 缺省页语义 | 缺省 `page_id` 恒为本 owner 自建默认页；不存在「缺省=用户聚焦标签页」分支；默认页被用户关闭后要求重新 `new_page`，不自动改选别的页 |
| BR-08 并行隔离 | 两个 Run 各绑一页交错执行，结果互不串页；同一 page_id 上的操作串行（页级互斥），不同页可并行 |
| BR-09 取消 | 取消后发出 MCP `notifications/cancelled`；在途写类动作按 UNKNOWN 结算、页面标记 STALE；不把「可能已发生」算成失败，也不在 STALE 未清时继续操作 |
| BR-10 崩溃与恢复 | `chrome.exe` 被杀或 MCP 退出 → 检测断连、关闭残留、丢弃所有权、重建实例；在途动作 UNKNOWN；任务得到「浏览器已重启，需重新打开页面」的明确提示，不认领旧页 |
| BR-11 用户接管 | 用户在自有页上操作或外部改动 DOM 后，旧 uid 失效、快照版本变化；Agent 必须重新读取后才可继续，禁止盲目重复点击或提交 |
| BR-12 权限分级 | `BROWSER_READ` 可 AUTO；`BROWSER_ACTION` 默认 ASK、可被「本次任务允许」覆盖；`BROWSER_COMMIT` 在有范围授权时仍 `WAITING_APPROVAL`；提交类点击被风险分类器升级为单动作 ASK |
| BR-13 目标与策略 | `normalized_target` 为 `browser://<origin>`（未知时 `browser://unknown`），origin 取自服务端已知页面状态或本次导航目标而非模型自报；策略可按 origin 收窄 |
| BR-14 外部内容不升级权限 | 页面文本与快照只作为数据；网页内指令不改变能力、策略、授权或工具词表；`evaluate_script` 等任意 JS 执行不在词表内 |
| BR-15 按需激活与只读边界 | 只有存在 ACTIVE `BROWSER_*` 连接时相应工具才进当轮词表；会话只读轮次只拿到 `BROWSER_READ` 四工具，写工具不出现 |
| BR-16 迁移与既有回归 | `0105` 在真实 PostgreSQL 迁移链应用成功；`logical_operations` 的 origin×resource CHECK 逐条重述后历史动作仍合法；`tool-catalog` 词表封闭性与助手只读集合回归通过 |
| BR-17 打包与安装 | `fetch-browser-mcp.mjs` 按固定版本 + integrity 取包；`build-release.ps1` 校验入口、`package.json.version`、`LICENSE`/第三方声明与产物清单；安装后能解析资源并启动，卸载无残留（不写注册表/扩展/PATH） |
| BR-18 真实 Windows 与安装态 | 真实 Windows/WebView2 窗口下的面板状态、暂停/停止、审批卡与轨迹展示；安装态冷启动；未运行不得以 dev 窗口或 mock 顶替 |

**本轮实际覆盖（2026-10-17，M1 开发自检）。** BR-01 已运行（真实 Chrome `155.0.8059.40` + 后端 `1.11.0`：独立 profile 起停、`DevToolsActivePort` 取端口、`tools/list` 26 个工具通过冻结映射自检、`READY`）；BR-02 部分（`CHROME_MISSING`/`BACKEND_MISSING`/`INCOMPATIBLE` 三条分支有代码与类型化错误码，只有路径缺失分支被真实触发过）；BR-03 部分（快照有界与截图摘要已实测：762×484、19,789 B、sha256 可核对，图片正文未进结果）；BR-04 已运行（错误 uid 得到 `BROWSER_ELEMENT_NOT_FOUND`，不回退坐标点击）；BR-06/BR-07 已运行（未登记页 `BROWSER_PAGE_NOT_OWNED`、缺省页只可能是自建页、两任务互不串页）；BR-13 已运行（`browser://<origin>` 目标由导航目标或该页已知 origin 生成，页面被改走后 `BROWSER_PAGE_STATE_CHANGED`）；BR-16 部分（`0105` 尚未在真实 PG 迁移链上跑过，仅 `tsc` 与词表断言通过）。

**未运行**：BR-05（加载超时/等待超时只有单测替身）、BR-08 的真实双 Run 交错（需真实 PG + Worker）、BR-09/BR-10/BR-11 的真实链路（取消底层停止、`chrome.exe` 被杀后的重建、用户接管后恢复——STALE 语义有单测，真实浏览器未验）、BR-12（权限分级需真实 Gateway 审批链）、BR-14（外部内容不升级权限的端到端）、BR-15（会话只读词表只有静态断言）、BR-17/BR-18（打包与安装态）。这些缺口不因 M1 冒烟通过而消失。

## 37. 普通 Agent 文件增删改与方法 MODIFY 接续（2026-10-18）

用户反馈「relay 好像还没有增删改的能力」；本轮范围是**对话 Agent 对绑定目录内文件执行 CREATE / MODIFY / DELETE**。只补执行链与可见性，不改删除确认、AUTO 不豁免、FULL 由系统判定或 Gateway 准入语义。实际成绩只在[统一功能验收表](../overall-acceptance-2026-09-28.md#当前功能验收表)维护。

- **写提示词**：`run-prompts.test.ts`、`agent-runtime-prompts.test.ts`、`runtime-prompt-router.test.ts` 覆盖写分支允许三种动作、MODIFY/DELETE 必须先 `read_file` 并带真实 `sha256`、CREATE 目标必须不存在、删除只在任务明确要求时提出、ASK/AUTO 不豁免、FULL 由系统判定、禁止以清空/覆盖/改名绕过确认，以及只读分支不出现写文案；`DRAFT_WRITE_TOOLS` 模板版本为 `1.0.2`。
- **方法 MODIFY**：`conversation-prompts.test.ts` 覆盖「冻结方法说明在前、执行协议在后」、`INSPECT`/空行动/无工具轮仍只读；`folder-first-conversation.integration.test.ts` 的真实 PG/HTTP/磁盘用例验证 `/diagnose 修好 answer.txt` 产出带 `execution_method` 的写候选（`writes_files: true` 与 `file_changes`）、经原 Apply 建立 Run、真实读取基线后落盘；`INSPECT` 的脚本化写候选被收口为 `CLARIFY`，零 Task/Run、磁盘不变。该文件本轮 **20/20**。
- **真实模型删除**：`real-model-tool-loop.integration.test.ts` 增加 DELETE 批准与拒绝两例——批准后只有指定目标消失、无关文件不变；拒绝后字节不变、Run 以 `ACTION_APPROVAL_DENIED` 收口且不产生恢复命令。用例只在配置 `RELAY_MODEL_*` 时运行；本轮未配置 Provider，**5 例全部 skip、0 运行、未验**。脚本化模型、HTTP 与组件结果不能替代真实 Provider。
- **前端**：`executionSummary.spec.ts` 验证候选文件动作列表与含 DELETE 的审批提示；`executionTrajectorySummary.spec.ts` 验证等待审批链接的精确 `operation_id` 匹配、无匹配回退与读取失败回退；`conversationExecutionClient.spec.ts` 验证 `file_changes` 解析、旧投影缺字段为空数组、非法形状报错。定向 **15/15**；scoped typecheck 通过。
- **主流程输出协议（2026-10-18 用户实机截图回归）**：真实窗口里模型先写一句结论再贴信封，旧解析要求「整段输出必须是 JSON」，于是把原文当普通回复落库，聊天直接显示 JSON、候选同时丢失。现允许信封前最多 400 字前言与代码框包裹；信封仍必须是单个完整 JSON 对象，候选合法性不变。残缺信封不再原样展示：优先救回 `reply` 字符串，其次保留 JSON 前的结论，都没有时给出可读失败说明。执行候选与状态维护共用同一解析入口，避免两处判定漂移。`conversation-execution.test.ts` **15/15**（新增前言、代码框、残缺信封 3 例）；`folder-first-conversation` 复跑 **20/20**，`agent-conversation-main-loop` **8/8**。
- **回归（真实临时 PG/HTTP/磁盘）**：`tool-loop` **45/45**、`agent-conversation-main-loop` **8/8**、`real-tools-gateway` **55/55**、`agent-main-loop-execution` **17/17**、`gateway` **30/30**，均 exit 0，临时集群已删除。API typecheck exit 0。
- **未验**：真实 Provider 的 DELETE 批准/拒绝；真实 Windows/WebView2 窗口的 CREATE / MODIFY / DELETE（含批准与拒绝）与方法 MODIFY。用户实机截图只证明解析缺陷存在并被修复，截图会话的目录档位仍为只读（输入器显示「未开放写入」），重发前须切到请求批准或更高档位；活动桌面仍运行 2026-10-17 暂存 API，本次解析修复与当日提示词变更均未载入，需关闭应用后以 `-RefreshApi` 重新暂存并重启再验。全量 API 单测唯一红为 HEAD 既有的 DISCUSS 文案断言；Workbench 全量 typecheck 仍被并行未提交文件阻塞，均未修改。

