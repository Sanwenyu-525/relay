# 功能验收汇总与历史记录

角色：唯一当前验收结果入口。2026-10-25 将长篇依据移至[详细记录](overall-acceptance-details-20261025.md)，未重跑测试、未改变原结论。

## 当前功能验收表

任务/执行/今日/收件箱日期夹具修正后，协调者直接复跑 Chromium **9/9通过**（2026-10-29），覆盖创建校验与成功反馈、长任务编辑焦点、加载/错误/空态、窄窗、200% CSS内容缩放及执行暂停/待批准/UNKNOWN；受控API证据不代表真实数据库业务提交。

2026-10-29 协调者直接验收（用户明确取消独立 Agent 要求）：当前源码 Workbench `npm run build` exit0（包含 `tsc --noEmit`），此前 pluginChipGeometry 类型阻塞已由并行会话修正，本次未覆盖其文件。协调者重新执行项目/目标 Chromium 22/22；14类页面的10–11px有效文字抽样低对比为0。任务浏览器首跑因专用4188服务未启动失败；启动后发现两个今日用例固定日期过期，测试改为按请求日期返回，保留产品日期一致性校验。此前失败记录保留，不继续作为当前构建阻塞。直接验收仍为 **PARTIAL**：真实审批提交及知识/设置/自动化全流程、Windows/WebView2、Provider、安装出口尚未闭合；无需另行独立Agent验收。

2026-10-29 非工作台修复补验：知识/设置/连接/定时列表与编辑定向 Vitest 79/79；真实 Chromium `/agent` 新会话与目录恢复回归及知识筛选共15/15。它们与本轮前批45/45、26/26分别报告，不替代未覆盖的深度业务流程。Impeccable 对协调者修改的三份CSS扫描返回空发现；`check-docs` exit1，25处缺失的历史证据链接，未修正或删除历史检查以取得通过。整体仍 PARTIAL。

按功能关键词检索后，只读取对应详情。结论是原记录的简短摘录，省略处明确标记；受验基准、证据环境、剩余项和历史失败必须以该条详情为准，不把自检视为独立验收，也不合并静态、PG/HTTP、Provider、浏览器、Windows 或安装证据。

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 非工作台 V5.28 接续修复（2026-10-28–29，HEAD `0af62cc7`＋共享未提交修改） | **PARTIAL**；独立验收 **NOT_TESTED**（用户后续明确禁止子智能体） | 路由源码生成完整清单，54 个路径/参数/query 变体的页面截图与环境限制见本机 `apps/workbench/output/ui-acceptance-20261028/route-inventory.json`。本轮协调者实跑共享可读性＋workbench Chromium 26/26；项目/今日/审批定向 Vitest 45/45。项目组22项和任务组独占测试落盘状态为 passed，未将其自检称独立验收。修复项目工作台皮肤、私有字号层级、辅助文字对比、主按钮特异性及内容缩放挤压。 | Workbench typecheck/build 本轮失败：并行新增 `pluginChipGeometry.spec.ts` 有4处TS错误；不得引用此前通过。部分页面只有 fixture 能力缺口提示或受控API证据；审批实际提交、知识/设置/自动化完整浏览器深交互、真实PG/Provider、Windows/WebView2、安装均未闭合或 NOT_TESTED；后续测试以新证据更新本行。 |
| 输入器与消息内联插件标识第二轮精修（2026-10-28/29，用户指认「像贴在普通文字表面的图标和标签」，实施者自检，未 commit/push） | **P0 几何闭合＋P1 视觉统一＋P2 场景矩阵（真实 Chromium 量测，非独立验收）**：芯片宽度改为按 `@标签` 首片段实测矩形下发 + 名称省略号收口，「盖住正文/光标落进名称」结构上不可能（同页注入旧样式做反证：旧画法加压后越右缘 20.86px、压住后续正文 17.28px，新画法误差 0）；唯一视觉件 `PluginChip` 统一编辑态与消息态（sage 容器底 + `radius.badge` + 21.6px 高，零新增 token），图标两态 16px、名称只读态升到 body；修掉只读态 `<img>` 基线导致的消息气泡撑高 1px；禁用/发送中同灰、`forced-colors` 补系统描边。证据：新增浏览器几何套件 **14/14**、第一轮浏览器 7/7（合 21/21）、芯片相关 jsdom **80/80**、4-worker 全量 **1882/1893**（11 项失败身份逐条属条目 336 既有基线，本轮路径零失败零新增）、`tsc --noEmit` exit 0、`vite build` exit 0、截图 24 张 | [详情 339](acceptance-details/part-19.md#条目-339) | ~~跨行 mention 只盖首片段（已知取舍）~~ **已被[详情 340](acceptance-details/part-19.md#条目-340)改掉：跨行时整枚芯片收起、原文恢复可见**；编辑态名称留 meta 档（宽度预算）；真实 Windows/WebView2 与真实高对比未验（暗色主题不适用）；125/150% 为根字号缩放非 DPI；独立验收未做；未 commit/push；数字绑定当前共享工作树快照。摘要不替代原记录 |
| 输入器跨行插件芯片的不可见占位修复与三态回归（2026-10-29 第三轮，用户指认「看不见的字符占位」，实施者自检，未 commit/push） | **P1 降级闭合＋P2 回归补齐（真实 Chromium 量测，非独立验收）**：`placeChips()` 按 `getClientRects()` 段数判定，mention 被 textarea 原生折行拆成两段以上时**整枚芯片收起**（`data-split="true"` → `display:none`，行尾不留半枚图标）、**原文 `@标签` 恢复可见**（`data-chip="off"` → `color: inherit`，禁用灰度仍跟着镜像层走）；折行规则一个字不改，禁止用镜像层 `nowrap` 强行不折行（会让光标与可见文字错位）。降级实测**零矩形位移**（强制降级前／后／还原三份快照比对），光标、选区、IME、撤销落点不变。证据：几何套件由 14 条扩到 **19/19**（新增三档宽度 × 21 档长度扫描分档、真实按键撤销恢复、多行消息 1162/390px、降级叠加 pending 禁用，并把「重载／真实发送回显／真正撤回」拆成三个互不替代的状态各自取证——撤回后芯片节点仍在 DOM 但 `checkVisibility()` 全部不可见）；第一轮浏览器 7/7、芯片 jsdom 35/35 保持；4-worker 全量 **1882/1893**（11 项失败身份逐条属条目 336 既有基线，同批两次跑数字一致，本轮路径零失败零新增）；`tsc --noEmit` exit 0、`vite build` exit 0、截图累计 34 张（本轮新增 10 张） | [详情 340](acceptance-details/part-19.md#条目-340) | **真实 Windows/WebView2 BLOCKED**：桌面壳固定命名互斥体 `Local\RelayAgentDesktopSingleInstance` 强制单实例，第二次启动以「Relay Agent is already open」退出；本机已有一个未开调试端口的实例属并行会话，接管需先关闭它，本轮未获授权不动。窄容器下跨行时用户读到的是 `@标签` 原文而非芯片（可读性与排版一致性的取舍）；真实 IME、高对比、DPI 仅在 Chromium 侧取证；独立验收未做；未 commit/push；数字绑定当前共享工作树快照。摘要不替代原记录 |
| 近期工作栏会话行的运行状态动效（2026-10-28，用户指令「切到别的会话也要看得出哪条在生成」，实施者自检，未 commit/push） | **实施者自检通过（本轮受验范围）**：会话投影新增读时派生字段 `run_state`（`assist_messages` 有无 `RUNNING`／`PENDING` 行，`RUNNING` 压过 `PENDING`），左栏把 12px 类型图标换成环——`RUNNING` 1s 一周匀速转（新 token `motion.loop.spin`）、`PENDING` 静止点线、终态回 `MessageSquare`，行与标题不转；轮询只在有会话运行期间存在（3s／40 拍后 10s／失败退避到 30s，页面不可见不发请求，无在途零请求），读失败保留上一次状态。证据：真实 PG/HTTP 6/6、jsdom 9/9、真实 Chromium 5/5；Workbench 与 API `tsc --noEmit` exit 0；回归 `recentWorkRailDensity`／`recentWorkRailNotStarted`／`recentWorkDragLine` 19 例中 15 过 4 失败，4 条在改动前同一工作树逐条复现一致（既有基线失败，非本轮引入） | [详情 338](acceptance-details/part-19.md#条目-338) | 真实 Windows/WebView2 未验；独立验收未做；未 commit/push；4 条既有浏览器失败属其他未提交改动；`PENDING` 长期不被认领时无超时降级；跨客户端发起的一轮只能靠下一拍列表读取获知。摘要不替代原记录 |
| 任务栏角标视觉重设计（2026-10-25/26，用户「红色区域过大、数字偏粗、边缘生硬，像附着在图标上的红色贴纸」） | 实施者自检通过：几何、字形、底色重做，角标单测 10/10，工作台 `tsc --noEmit` 归零，真实 Chromium 前后对照出图；Windows 任务栏叠加仍未取证 | [详情 337](acceptance-details/part-19.md#条目-337) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| N04→N06 联合业务路径最新复核（2026-10-27，接续进行中） | **PARTIALLY_ACCEPTED**：N04/N06 定向 Vitest 36/36；Workbench 当前源码 typecheck 与 Vite production build exit 0；隔离快照受控 Chromium 8/8；联合 PG/HTTP/生产 Worker 用例 1/1（FakeModelPort） | [详情 336](acceptance-details/part-19.md#条目-336) | Workbench 全量 Vitest 1866/1877 通过、11 失败/9 文件，均属于已有历史失败身份。当前 API typecheck exit 2，隔离快照 fresh build exit 1（Model Connections 编译错误及快照缺失 model-connection-api）；最新 PG/HTTP 批次 65/72，personal-planning 启动钩子超时、7 个主体未运行，同快照单跑 7/7。Windows/WebView2 项目列表与创建表单实际打开，但 CreateProject 未落库（projects=0、无回执）；随后 user-input guard 阻止继续操作。真实 Provider 未运行，P2 未运行 |
| 插件图标四项遗留缺陷闭环：P0 六枚 PNG 纳入版本管理、P1 选区并集删除、P1 禁用态重影、P1 gutter 补偿累积（2026-10-26，独立验收指认，当前 Agent 修复＋复验，未 commit/push） | **四项全部 PASS**：六张 PNG 精确 `git add` 并经 `vite build` 入产物（dist 含全部六枚带哈希文件）；选区删除改并集——全选含 mention 整行删除得空串、跨多枚全覆盖、不缩小已选普通文字，无选区方向语义不变；新增 (0,4,1) 禁用态透明规则消除发送 pending 期间底层原文与芯片重影（首条消息与会话两条输入器分别量测通过）；gutter 补偿改「清补偿→读基础→设绝对值」幂等方案，滚动/缩放/ResizeObserver 反复触发不叠加、归零即恢复。先写失败测试再修复（6 例 jsdom 初始失败转绿；CSS 修复回退验证用例转红） | [详情 335](acceptance-details/part-19.md#条目-335) | 真实 Windows/WebView2 未验（熄屏，浏览器侧完成）；`git add` 后未 commit/push；此前 typecheck/build 全量出口曾被并行文件错误挡住；当前快照 Workbench package build exit 0；独立 Agent 复核未做 |
| 模型连接与调用管理整改 P0-1 / P0-2 / P1-2 / P1-4（2026-10-26–27，实施＋受控自检，未 commit/push） | **P0 与 P1-2/P1-4 后端、P1-6 第一段定向通过（受控 Provider 接缝，非真实外呼）；P2 未实施**：Run 执行端改为只按冻结计划解析模型（`application/run-model-port.ts`），「冻结免费模型 A / 进程默认 B」「默认模型被改」「目录不再免费」「免费凭据被移除」四种情形分别以类型化原因停止且**零外呼、零账本**；DRAFT 与 SEMANTIC_CHECK 共用同一冻结身份（构造「进程默认 C / 冻结 A」反例验证）；免费外呼最终请求体带 `provider.max_price` 零价硬限制；换 Key 后旧 Run 停止（`MODEL_CREDENTIAL_CHANGED`）、旧验证失效（`credential_identity=CHANGED`）、账户冷却按凭据身份隔离且重启仍生效（0142 三列，凭据摘要不进快照/响应/日志）；账户额度与连接验证响应改为 64 KiB 流式有界读取；连接验证支持**显式目标**（`{connection:'openrouter',model}`），OpenRouter 目录型号用独立凭据 + 确切型号 + 零价硬限制探针，目录不免费/能力不足/目录过期一律不探测不记账（409 `MODEL_VERIFY_TARGET_NOT_ELIGIBLE` / `MODEL_VERIFY_CATALOG_STALE`），状态改为互斥 13 态（`state` + 目标级 `target_last`，`last` 保持实例级旧语义）。证据：`run-model-freeze-execution` 5/5、`run-model-freeze-semantic` 1/1、`model-credential-identity` 3/3；单测 `credential-identity`、`bounded-response` 及 6 个相关单测文件 56/56；相关集成回归 `model-verify` 8/8、`run-steps` 8/8、`model-call-budget` 5/5、`session-model-selection` 11/11、`assist-free-model-routing` 1/1、`assist-model-runtime` 2/2、`model-catalog-sync` 8/8、`model-capabilities` 3/3、`model-port` 2/2、`model-selection-source-acceptance` 1/1、`goal-budget-grant-accounting` 2/2、`model-verify-target` 4/4；单测 `model-verify-target` 9 例；Workbench `settingsView` 21/21、模型相关 25/25、`assistantModeSwitch` 50/50、`tsc --noEmit` exit 0 | [证据：冻结执行](../../apps/api/test/integration/run-model-freeze-execution.integration.test.ts)、[凭据身份](../../apps/api/test/integration/model-credential-identity.integration.test.ts) | 真实 Provider 未外呼；真实 Windows/WebView2 未验；P1-1 异常矩阵（部分 SSE、UNKNOWN、预算耗尽、非可移植工具历史等）沿用既有实现，未新增反例；P1-1 异常矩阵与 P1-3 预算/恢复为既有实现（本轮只补凭据维度与有界读取，未重跑全矩阵）；P1-5 目录同步生命周期经源码复核已覆盖启动/打开/周期/重启/手动/租约/退避/迟到响应八项（`model-catalog-sync` 8/8）；P1-6 第一段已实施：设置页改为消费服务端目标级 `state`（13 态映射为独立 chip）、按 `target_last` 显示「本目标最近一次」、凭据更换独立警示；**验证目标的选择入口（下拉选目录型号）仍未做**，Workbench 目前只用默认连接这一目标；P2 多 Provider 连接管理：**前置设施已完成、连接管理本身仍未开始**——新增 `apps/credential-helper`（Rust + Windows DPAPI 当前用户作用域 + 域分隔熵，`protect/resolve/delete/status`，引用即文件名且拒绝 `../`）、`credentials/credential-store.ts` 端口与 `dpapi-credential-store.ts` 子进程适配（类型化失败、错误不含秘密）、`cli/model-credential.js`（秘密只走 stdin）；证据：Rust 单测 5/5（真实 DPAPI 往返、落盘无明文、篡改拒绝）、Node 单测 7/7、真实二进制集成 **3/3**；凭据引用已接入默认连接（`RELAY_MODEL_API_KEY_REF` 等，API/Worker 启动最早期物化，歧义/缺失/存储不可用一律启动失败、不回落明文或默认模型，单测 9/9；真实 DPAPI 集成证明「库里的 Key → 可用配置、轮换后凭据身份变化而配置指纹不变」）；数据模型与实现顺序见 [ADR-036](../../docs/decisions/ADR-036-multi-provider-model-connections.md)；**阶段二已完成连接登记**：迁移 0143 + 七个端点（列表/读取/凭据存在性/创建/更新/轮换/启停），凭据只进系统凭据库、表里只留引用，轮换覆盖同一引用并加代数不留孤儿 blob，更新走 revision CAS、命令回执可重放；证据 `model-connections` 7/7（真实 PG + HTTP + DPAPI）、`migration` 12/12（清单已同步）；**阶段三已完成 Run 冻结与执行接线**：迁移 0144（工作区默认连接 + 契约 `connection_id`/`connection_credential_version`），`DelegateTask` 按默认连接冻结单候选、连接停用/缺凭据时委派失败不回落进程默认；执行端四道闸门（可见 → ACTIVE → 代数一致 → 指纹一致）后才解析秘密，停止原因类型化；证据 `run-model-connection` 4/4（含「进程默认是另一模型也不影响」「轮换后在途 Run 停止且零外呼」「改默认不影响已建 Run」）、`migration` 12/12；Workbench 新增连接管理卡（懒加载，列表/设为默认/启停/轮换/新增）`modelConnectionsSettings` 7/7、设置页回归 33/33；**仍未做**：会话选择接入连接、Assist 聊天按连接解析、连接级验证按钮；本行不替代原记录 |
| 任务与计划系统 P0–P2 第二轮独立验收与收口（2026-10-26，当前 Agent 独立验收＋确认缺口最小修复，未 commit/push） | **通过（本轮受验范围）**：修复 N04 PROPOSE_PLAN/PROPOSE_SCOPE 与 N06 CREATE 恢复在「合法并发推进」下永久卡住的三处缺口（按持久身份＋读回一致性核对，接受当前修订 ≥ 回执修订与合法前进状态，身份/载荷错配仍拒绝）；估时草稿并入既有 DraftGuard 离页保护；PROPOSE_PLAN 毫秒安全整数与上限对齐服务端；真实 Chromium 8/8（含 390px 窄窗、分页滚动、焦点恢复）、定向 Vitest 54/54、真实 PG/HTTP 10 套件 71/71（fresh build＋迁移＋Graph＋PG 启停 exit 0） | [详情 334](acceptance-details/part-19.md#条目-334) | 此前 Workbench 全量 tsc 仅剩 taskbarBadge.spec.ts:21 错误；当前快照 package build 已通过，全量 Vitest 未复跑；真实 Windows/WebView2 未验（用户确认屏幕锁定，本轮按指示只做浏览器侧）；真实 Provider 未验；N04/N06 整体出口与收益未闭合 |
| 内置插件图标接入与输入器插件标识复核（2026-10-26，实现/文档为并行会话已提交内容 `85a43a8e`；本轮独立复核＋真实 Chromium 截图验收，computer-use 插件受会话熄屏限制转浏览器完成） | **通过（jsdom 契约＋真实 Chromium 几何与渲染截图；非完整独立验收）**：六枚 256×256 RGBA 透明 PNG、PluginIcon 六 key 映射与装饰语义、附加菜单三行图标＋已连接状态、@ 菜单、输入器芯片（菜单插入＝手动输入、一次退格删整枚、Ctrl+Z 可撤销）、消息 mention 图标（邮箱/路径/未知 mention 无图标、原文保全）；截图 9 张留本机 `apps/workbench/output/plugin-icons-acceptance-20261025/` | [详情 333](acceptance-details/part-19.md#条目-333) | 真实 Windows/WebView2 原生窗口截图未验（用户确认熄屏，桌面像素捕获不可用）；125%/150% DPI 未实测；暗色主题不适用（工作台仅浅色一套）；六枚 PNG 资产已在[条目 335](acceptance-details/part-19.md#条目-335)纳入跟踪（staged 未 commit）；独立验收未做 |
| 插件一键启用：补齐缺失的登记入口并修复浏览器策略死前缀（2026-10-25，用户截图指认「用个插件这么麻烦」，当前 Agent 实施＋自检，未 commit/push） | **实施者自检通过；非独立验收**：修掉两处事实缺口——插件能力不在 HTTP 建连接白名单（表单提交即 422，插件连接此前没有任何可用登记入口）、浏览器策略被写成目录前缀永远匹配不上；新增 `EnableProjectPlugin` 一命令一事务补齐连接＋逐动作策略（只读 AUTO/操作 ASK，停用与撤销不绕过），连接页工具行加「一键启用」 | [详情 332](acceptance-details/part-19.md#条目-332) | 真实浏览器/桌面端到端未验；独立验收未做；具体限制见同条详情的「剩余项」 |
| 开发工具 Skills 完整性与跨 Agent 共享（2026-10-26，阶段二实施＋复核） | **部分通过，五 Agent 实际触发未闭环**：全机扫描 1168 个入口、712 个物理安装（含历史/插件缓存），695 项结构通过、17 个物理结构问题；公共源 76 项中 75 项结构通过。Taste v2.1.5 官方包 39/39；Codex 原生发现并读取 app-screen 规则，`draw.mjs --app --list styles` 只读 Smoke 成功；Vercel React 76/76 与固定提交逐项一致。六个目标 Skills Root 共 456 项：450 keep、6 blocked-source（`design-engineer` 缺三份 references），0 冲突、0 待新增链接；WorkBuddy、Qoder CN 的旧 Taste 副本经官方提交核对后移入备份。五套工具均可读共享 76/76、结构 75/76；Trae 保留 3 个既有同 ID 异版，其他四套为 0。审计测试 14/14；基线已更新且与 1168 个当前哈希一致。Impeccable 引擎命令及 UI UX Pro Max 搜索可运行 | [入口、来源与复验方法](../deployment/developer-skills.md)；当前逐项清单在本机 `%USERPROFILE%/.agents/skill-audit/inventory.json`，备份及旧基线位于 `%USERPROFILE%/.agents/skill-audit/backups/20261026-taste-v215`；本轮 `check-docs` 与修改前对照同为 27 条历史/本机缺失链接，无新增 | `design-engineer` 上游仍缺三份 references；17 个结构问题还包括历史 Taste、空 frontmatter 与厂商插件缓存中的失效引用/YAML。Trae 的 `brainstorming`、`novel-skill`、`writing-plans` 同 ID 异版保留；UI UX Pro Max 本地版与官方 2.15.0 有差异，未覆盖定制内容；Taste v1 来源未核实；32 份依赖清单未执行。Hallmark 因能力重叠且通用硬规则对 Relay 适用性不足而未安装。Trae、WorkBuddy、Qoder、ZCode 实际任务触发未实测（ZCode 活动窗口未触碰）；本轮未改 Relay 产品代码，也未做产品/Provider/安装总验收 |
| 成果与版本管理 P0–P2（2026-10-26，第二轮独立复验） | **部分验收**：迁移 0136 合法与冲突分支 2/2；真实 PG/HTTP 六套件 69/69；Workbench 定向 10 文件 120/120、typecheck 通过；两桌面脚本语法通过 | [详情 330](acceptance-details/part-19.md#条目-330) | 当前 WebView2、进程重启恢复、Workbench Vite build 与安装包未验；共享发布构建期间未启动竞争桌面构建；整体保留 PARTIAL |
| 模型回复生命周期：草稿、过程与最终正文的交接（2026-10-26，第二阶段实施＋自检，未 commit/push） | **部分通过（阅读区/交接/过程/排版已按真实 Chromium 验证；真实 Windows 与检查器打开态未验）**：草稿与正文合并为一个阅读区三态互斥（final/verifying/draft），终态帧到达后草稿留在原位直到权威消息行带回正文；失败/取消/失权立即清内容，网络不明保留列表并标「状态待核对」＋行内重读；过程摘要改说人话并修掉 `<details>` 程序化 toggle 误判；块距统一 12px、标题降档 20/18/16、表格并入同一节奏 | [详情 329](acceptance-details/part-01.md#条目-329) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 除 agent 页外其他页面视觉对齐：页头层级统一＋卡片语言与留白节奏（2026-10-25 两轮，用户指令，实施者自检，未 commit/push） | 实施者自检通过（两轮）：①页头层级——普通页面 h1 全局统一 compactPage(28px) 与 /agent 页同档、lede 降 meta、section 降回 1.5rem 恢复 28/24/20 层级链、任务详情产物标题回落 agent 页成果区同档，取代 2026-01 的 2.5rem 放大决定；②卡片语言与留白——radius.panel→1rem、主区留白→32px、section.gap→32px，项目卡/今日空态卡/配置面板升级白卡语言（白底＋shadow.card＋16px 圆角）；组件 63 例＋几何 23 例＋taskDetailVisual 8 例全过、build exit 0、逐页截图核对无破…（结论未完整展示，见详情） | [详情 039](acceptance-details/part-01.md#条目-039) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| P1-A 项目级长期 Agent 成员（ADR-034 包 A）（2026-10-26，第二阶段实施＋自检，未 commit/push） | 部分通过（身份/配置/协调者后端闭环已验；消息、执行权、外部绑定、UI 未实现）：迁移 0139 两表——project_agent_members（名称项目内唯一、角色五键、职责从模板拷贝、ACTIVE/INACTIVE/ARCHIVED 生命周期且 ARCHIVED 只读留档…（结论未完整展示，见详情） | [详情 001](acceptance-details/part-01.md#条目-001) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| P1-B 成员私聊、群聊与消息（ADR-034 包 B 服务端记录面）（2026-10-26，第二阶段实施＋自检，未 commit/push） | 部分通过（持久记录/定向接收者/幂等去重/讨论终止/ACTIVE 闸门后端已验；成员回信、互相唤醒、消费结算与 UI 未实现，归包 C/P2-A）：迁移 `0140` 两表，command_id 幂等三命令＋三只读入口，HANDOFF 只引用原事实 | [详情 328](acceptance-details/part-19.md#条目-328) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| P1-C 第一片：成员消息唤醒与消费结算（ADR-034 包 C 服务端唤醒循环）（2026-10-26，第二阶段实施＋自检＋真实进程回路，未 commit/push） | 部分通过（定向唤醒裁决/成员回信/消费结算/MEMBER 计量后端已验，真实 API＋Worker 进程回路与工作台活动流取证通过；协调者自动推进、成员间定向唤醒、外部领取、巡检合并、Windows 生命周期与 UI 未实现）：迁移 `0141` 消费列＋model_calls kind `MEMBER`，唤醒挂 Worker tick 复用既有循环；只有用户消息触发唤醒、一次只唤醒一个成员，成员回信未定向不进候选——互相回应不形成唤醒链由结构保证 | [详情 331](acceptance-details/part-19.md#条目-331) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 界面术语统一：目标收归 Goal、会话作用域改称工作对象（2026-10-21 裁定，2026-10-25 补实施） | 部分通过（中文文案与失效断言已改；tsc 仅余 1 处并行会话既有错；定向套件受并行在途改动干扰） | [详情 002](acceptance-details/part-01.md#条目-002) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 定时任务 P0-B：编辑、续授权与补跑拒绝的 UI 闭环（2026-10-26，第二阶段实施＋自检，未 commit/push） | 部分通过（组件级已验；真实浏览器/桌面未验）：CreateScheduledTaskView 双模式（创建/编辑）＋路由 /scheduled-tasks/:id/edit＋详情页「编辑」入口；编辑回填（任务时区墙钟日期、设备本地到期钟面、周规则勾选、项目只读）、必填修改原因、e…（结论未完整展示，见详情） | [详情 003](acceptance-details/part-01.md#条目-003) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 定时任务 P0-A：发生时配置冻结、补跑/分发前准入与完成幂等（2026-10-26，第二阶段实施＋自检，未 commit/push） | 部分通过（后端闭环已验；独立验收未做）：四个真实缺陷先构造失败复现再修复——①occurrence 落库时冻结 frozen_template/frozen_execution_input（迁移 0138），分发/补跑一律用冻结副本，未提交的 CreateTask 不再读到编辑后…（结论未完整展示，见详情） | [详情 004](acceptance-details/part-01.md#条目-004) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础 Agent 执行能力与聊天 UI 独立验收（2026-10-25，当前 Agent 独立复跑＋定向修复，未 commit/push） | 独立验收通过（本轮范围内无未解决 P0/P1）：Workbench npx tsc --noEmit 当轮 exit 0（同日第三轮复跑因他人未跟踪 tests/projectPlanningFlows.spec.tsx:391 报 TS2322 而 exit 2，仅限 src/…（结论未完整展示，见详情） | [详情 005](acceptance-details/part-01.md#条目-005) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Verification / Review / Completion P0–P2（2026-10-26 当前源码验收） | **CONDITIONALLY_ACCEPTED**：此前完整 API 回归 11 套件 118/118 通过；本轮 fresh API 7 套件 161 pass/0 fail/1 条件跳过，API typecheck/build 通过；Workbench 8 文件 79/79、package build 与 Chromium 3/3 通过。P0/P1 独立代码复核未发现必须修复项；P2 证据绑定通过，规模性能仅有合成基线且无 SLO。本轮 API 测试与独立集成进程重叠，未形成无并发基线。 | [详情 006](acceptance-details/part-01.md#条目-006) | 当前快照 Workbench package build exit 0，taskbarBadge.spec.ts:21 TS2322 已消失；Provider 与 Windows/WebView2 未运行；Review Inbox 无分页且 OPEN 目标逐条查询，性能数据为单次合成样本、无 SLO；check-docs 仍有 27 条历史/本机缺失链接，本条目未命中。 |
| 未归属会话的插件执行：电脑/浏览器操控哪里都能用（2026-10-25，用户附工作区级会话截图指认，实施者自检） | 实施者自检通过（API tsc -p exit 0；单测定向 assist-capability-notice＋assistant-readonly-round＋conversation-prompts＋agent-runtime-prompts＋conversation-exe…（结论未完整展示，见详情） | [详情 007](acceptance-details/part-01.md#条目-007) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Task 操作权限、项目任务分页与 N04/N06 页面（2026-10-25，当前 Agent 实施者自检） | 实施者自检通过；整体未独立验收：API 与 Workbench 全项目 TypeScript exit 0；Workbench Vite build exit 0；11 个定向 Vitest 文件 58/58；真实 Chromium 受控 API 页面流 2/2；真实临时 Pos…（结论未完整展示，见详情） | [详情 008](acceptance-details/part-01.md#条目-008) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 工具面板「文件」页签前端接线：受管目录浏览与文件读取（2026-10-24，当前 Agent 直接执行） | 实施者自检通过（jsdom 组件级：新 spec managedFileBrowse 8/8——显式点击才派发、相对路径展开、刷新＝新 command_id、截断显式、READ_FILE 正文/SHA-256、二进制类型化失败、缺连接指引与无 FILE_READ 反馈、目录失败不…（结论未完整展示，见详情） | [详情 009](acceptance-details/part-01.md#条目-009) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 「+」菜单补齐参考图三项：上传附件、文件、我的产物（2026-10-24，用户附参考菜单红框并确认「补三项真实入口」，实施者自检） | 实施者自检通过（apps/workbench/tests/composerAttachMenu.spec.tsx 35/35；AssistView.tsx 定向 tsc --noEmit exit 0；vite build exit 0；工作台全量 tsc --noEmit 被并…（结论未完整展示，见详情） | [详情 010](acceptance-details/part-01.md#条目-010) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 正式目标管理与项目状态写入（2026-10-24，任务书 P0–P2，当前 Agent 直接执行） | 实施者自检通过（工作台定向 41/41：goalManagementLive.spec.tsx 8、projectManagementPanels.spec.tsx 7、goalProjectLink.spec.ts 11、goalProjectLinkPagination.sp…；2026-10-25 关联身份校验加固轮：回执错配反例补齐＋失权 401/403/404 参数化＋关联跨 Workspace 隔离，9 文件 63/63，源码零修改；同日真实浏览器验收：创建→分页（50/55、杀 API 后暂态保留游标可重试）→续页关联回执→双击单命令，psql 账本 3/3/3 相符（结论未完整展示，见详情） | [详情 011](acceptance-details/part-01.md#条目-011) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 工具面板「文件」页签后端：人工受管目录浏览与文件读取（2026-10-24，迁移 0134，当前 Agent 直接执行） | 实施者自检通过（真实临时 PostgreSQL＋真实目录＋真实 HTTP：file-user-action 集成 17/17、git-user-action 回归 15/15；受影响回归 gateway 3/3、gateway-reconcile 6/6、assistant-re…（结论未完整展示，见详情） | [详情 012](acceptance-details/part-01.md#条目-012) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 三插件接续：GitHub 官方 Skill 登记与按需注入、浏览器 Run 停止入队、连接页安装级状态、电脑真实输入复验（2026-10-24，实施者自检） | 实施者自检＋同日验收复跑通过（验收复跑数字：API 全量 tsc -p tsconfig.json exit 0（并行会话已解除阻塞）、单测 official-skills+github-read+github-executable 40/40、agent-conversatio…（结论未完整展示，见详情） | [详情 013](acceptance-details/part-01.md#条目-013) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 验收结果优化轮：goal 控制意图归一缺口＋DEV-0110 输入卡稳定性＋首条目标投影（2026-10-24，用户指令「根据验收结果优化」，实施者自检） | 实施者自检通过（①API tsc exit 0＋dist 重建；②真实端到端：独立 supervisor（supervisor-main.js 直连试用库、真循环）＋真实领域入口 resumeGoal/pauseGoal，resume→pause 后 6 秒内自动归一 PAUSE…（结论未完整展示，见详情） | [详情 014](acceptance-details/part-01.md#条目-014) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Agent 闭环 UI 一致性专项：DEV-0105 停止文案误报＋协作页非持久附件离页保护（2026-10-24，实施者自检） | 实施者自检通过（受影响面定向 7 文件 199 例 196 通过：collaborationWorkspace＋chatPlanGoal＋draftGuardCoexistence＋folderFirstConversation＋sessionRoundTrace＋compose…（结论未完整展示，见详情） | [详情 015](acceptance-details/part-01.md#条目-015) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 右侧工具面板与上下文用量版面精修（2026-10-28，用户两张截图指令：工具面板页签/空态/宽度/底部抽屉＋上下文圆环读数＋用量详情浮层；当前 Agent 直接实施） | 实施者自检通过（真实 Chromium 新增 12 例全过：`conversationToolsPanel` 5/5——无项目默认落网页、空态带出口、面板贴右缘且页签不压收起键、抽屉展开自滚、窄窗抽屉不压窄聊天列、六页签可达与拖宽补文字；`composerPopupGeometry` 13/13——含圆环读数 7 档：未知/0%/3%/50%/80%/100%/上限不可用，逐档核对读数、`data-state`、弧的有无、警示色与浮层边界。jsdom 定向 `devToolsPanel` 6/6、`collaborationWorkspace` 85/86（唯一红为 2026-10-25 起既有的 `.agent-message-body` 直接子节点断言，与本轮无关）；工作台 `tsc --noEmit` exit 0。业务语义零改动：项目绑定、受管目录、Git 权限、Run/命令输出与「交互终端未接入」原样） | [工作台 §50.7](../frontend/workbench-design/part-14.md) · [设计系统组件表](../frontend/design-system/part-01.md) | Windows/WebView2 实机、多 DPI 缩放与原生网页预览层叠未验；全站只有浅色主题，深色模式无第二套配色可对；工具面板默认宽度在 ≤1900px 窗口里仍由 18rem 下限决定，宽度收益要到更宽窗口才显现 |
| 右侧工具面板与内置网页预览（2026-10-24，执行任务书 [workbench-browser-preview](../../prompts/workbench-browser-preview.md)：P0 宿主容器＋P1 面板整合＋P2 网页预览＋P3 部分验证） | 实施者自检通过（工作台定向 vitest 4 文件 31/31：previewUrl 8、previewRestore 7、browserPreview 11、devToolsPanel 5；受影响回归 gitReadPanel 21/21；工作台 tsc --noEmit ex…（结论未完整展示，见详情） | [详情 016](acceptance-details/part-02.md#条目-016) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 空会话不再能分叉＋左栏标「未开始」（2026-10-24，用户截图指认「已有会话为什么是新建会话的欢迎页」） | 实施者自检通过（真实临时 PG18.6 四套件 53/53＋API 单测 6/6＋jsdom 定向 46/46＋真实 Chromium 新增 1/1；API 与工作台 tsc --noEmit 均 exit 0）；真实 Windows/WebView2 未复验 | [详情 017](acceptance-details/part-02.md#条目-017) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 左栏「未开始」误标有内容的会话（2026-10-24，用户截图指认「这是bug吧」） | 缺陷已修复并取证（真实 PG18.6 本机实例回填 5 行、复跑 0 行、不变量 0 违反；sessionRowMenu.spec.ts 25/25；check-docs 本轮零新增告警）；同日接续把判据改为读时派生的 has_messages（实施者自检：API tsc --n…（结论未完整展示，见详情） | [详情 018](acceptance-details/part-02.md#条目-018) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 消息撤回（0132）后端已实施子集＋单层撤销＋容量保留（2026-10-24，核心撤回＝并行实施会话「首写前像」方案，单层撤销/保护副本与容量保留＝评审 Agent 在实施会话静默 15 分钟后分两轮接手补齐；分工经过见 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md) 同日条目） | 独立验收通过（真实临时 PG18.6 集群＋真实 HTTP：评审 Agent 新建 apps/api/test/integration/assist-message-recall-acceptance.integration.test.ts RA-01~06 实跑 6/6 PAS…（结论未完整展示，见详情） | [详情 019](acceptance-details/part-02.md#条目-019) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 消息撤回工作台入口（2026-10-24，实施者自检） | 实施者自检通过（jsdom apps/workbench/tests/assistMessageRecall.spec.tsx 5/5，tsc --noEmit exit 0） | [详情 020](acceptance-details/part-02.md#条目-020) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话 diff 入口：没有 git diff 时不占位（2026-10-24，用户截图指令「没有 git diff 的时候不显示这个红框部分」） | 实施者自检通过（真实链路＋jsdom＋Chromium 夹具三层） | [详情 021](acceptance-details/part-02.md#条目-021) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话顶栏展开工作详情时高度塌陷（2026-10-24，用户截图「展开工作详情的时候红框部分高度会改变」） | 实施者自检通过（headless Chromium page.route 夹具：1487×900 与 2032×1091 展开前后同为 44px；conversationToolbarDensity 10/10 含新增用例；tsc --noEmit exit 0）；真实 Wind…（结论未完整展示，见详情） | [详情 022](acceptance-details/part-02.md#条目-022) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 顶栏通知浮层呈现收口（2026-10-24，用户截图指令「用 skill 优化一下这个顶栏浮层」） | 实施者自检通过（jsdom interventionNotifications 8/8，含修正存量红灯 1 条与新增空态/层级断言；真实 Chromium 探针三场景前后实测；邻域 desktop-titlebar＋workBreadcrumbScope＋attentionQue…（结论未完整展示，见详情） | [详情 023](acceptance-details/part-02.md#条目-023) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 工作详情左边界拖拽调宽（2026-10-24，用户截图指令「给工作详情的左边界加上拖拽功能（聊天区左侧已实现可以复用）」） | 实施者自检通过（新增 jsdom inspectorResizeHandle 5/5；inspectorPreviewLayout 真实 Chromium 11/11，含新增分栏与抽屉拖拽 2 例；taskInspectorPanel 19/19、collaborationLay…（结论未完整展示，见详情） | [详情 024](acceptance-details/part-02.md#条目-024) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 原型借鉴三项：用户消息复制、待处理稍后、长任务列表分组与限高（2026-10-24，自用户提供的 V5.27 页面原型对照选取） | 实施者自检通过（新建 tests/assistMessageCopy.spec.tsx 3/3；attentionQueueReadability 9/9 含新增稍后分组 4 例、executionTrajectorySummary 9/9 含新增分组/限高 3 例、chatLo…（结论未完整展示，见详情） | [详情 025](acceptance-details/part-02.md#条目-025) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 聊天页三处呈现收口与目录结论一致（2026-10-23，用户四张截图：轨迹免责文案、目录不匹配、浮层脚注、首条空态闪页） | 实施者自检通过（jsdom 定向 9 文件 198/198，含新增回归 1 例先红后绿；工作台 tsc --noEmit exit 0）；真实 Windows/WebView2 未复验 | [详情 026](acceptance-details/part-02.md#条目-026) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 禅道批次第八轮：会话删除＋读取失败恢复（2026-10-24/25，禅道 #119/#113/#115/#132/#122/#103/#128/#134，子代理串行修复＋协调集成；新登记 #157/#158） | 实施者自检通过（探针红→绿：plan-session-delete 全程 PASSED＋assist-session-delete 集成 18/18（#119 核实已在提交 aee2496c 修复，零代码改动）；projectDependencyReadRetry、runTraj…（结论未完整展示，见详情） | [详情 027](acceptance-details/part-02.md#条目-027) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 禅道批次第七轮：完成/勾选/分页＋陈旧错误（2026-10-24，禅道 #11/#19/#23/#27/#28/#117/#118，子代理串行修复＋协调集成） | 实施者自检通过（探针 10/10：completionDefects 三例错配＋两例版本切换＋goalRecoveryDefects 分页例、continuationRecoveryDefects 2/2、conversationDiffBodyRefresh 1/1、conve…（结论未完整展示，见详情） | [详情 028](acceptance-details/part-02.md#条目-028) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 禅道批次第六轮：目标语义＋前端待核对＋SSRF 澄清（2026-10-24，禅道 #13(notrepro)／#24/#29/#30/#32/#141/#144/#145，子代理串行修复＋协调集成） | 实施者自检通过（探针全红→绿：plan-execution-context 7 项标记、goal-budget-history 3→4 恰＋1、learning-chat-modes 按修正契约、knowledgeDefects 二/四例、completionDefects 前两…（结论未完整展示，见详情） | [详情 029](acceptance-details/part-02.md#条目-029) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 禅道批次第五轮：S2 大单＋高优四族 13 条（2026-10-24，禅道 #20/#21/#22/#25/#33/#99/#107/#109/#140/#142/#143/#147/#151，子代理串行修复＋协调集成） | 实施者自检通过（探针全红→绿：定时 skip-chain/frozen-source-drift、目标 model-ledger/confirm-inflight/backlog-settlement、记忆 expiry-replay、工作台三族 5 例；真实临时 PG18.6＋…（结论未完整展示，见详情） | [详情 030](acceptance-details/part-02.md#条目-030) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 续页族五单修复（2026-10-23，禅道 #31／#101／#102／#110／#131，五子代理并行修复＋协调集成） | 实施者自检通过（新建 5 份 spec 26/26；既有相关 13 份 spec 115/116，唯一失败 projectOverview 经 HEAD 版 ProjectsView.tsx 复现同样失败，判为并行改动的既有红灯；工作台 tsc --noEmit exit 0）；…（结论未完整展示，见详情） | [详情 031](acceptance-details/part-02.md#条目-031) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 定时任务族五单修复（2026-10-23，禅道 #34／#146／#148／#149／#150，三子代理并行修复＋协调集成） | 实施者自检通过（合并真实隔离 PG18.6＋HTTP 集成 scheduled-tasks 8/8＋新建 scheduled-task-detail-history 2/2、status PASSED；工作台定向 scheduledTaskDetailPendingHistory…（结论未完整展示，见详情） | [详情 032](acceptance-details/part-03.md#条目-032) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 目标卡「取消目标」补事前确认 + 历史消息图片补尺寸预留（2026-10-23，禅道 #153 / #154） | 实施者自检通过（工作台 jsdom 新增 tests/goalCancelConfirm.spec.tsx 1/1、tests/messageAttachmentSizing.spec.tsx 1/1；真实 Chromium 单挂目标卡 1/1：确认框文案与初始焦点正确、dang…（结论未完整展示，见详情） | [详情 033](acceptance-details/part-03.md#条目-033) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 权限菜单：切换时闪烁、删除只读行；上下文圆环悬停（2026-10-22，接续 DEV-0115 第三轮；同轮的「菜单居中」已按用户指令回滚） | 实施者自检通过（工作台 jsdom writePermissionTier.spec.tsx 26/26，其中新增 2 例均为在途时序；受影响面 5 文件 176 例 173 通过，3 红全部属并行改造（1 条并行 liveErrors，2 条 assistantModeSwit…（结论未完整展示，见详情） | [详情 034](acceptance-details/part-03.md#条目-034) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 权限芯片去「默认」前缀、改档成功不再回显菜单底部文字（2026-10-22，接续 DEV-0115） | 实施者自检通过（工作台 jsdom writePermissionTier.spec.tsx 24/24 复跑；真实 Chromium defaultWriteTier.spec.ts 2/2 并留改后截图；workbench tsc --noEmit exit 0）；真实 Wi…（结论未完整展示，见详情） | [详情 035](acceptance-details/part-03.md#条目-035) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| AI 回复「都是一个颜色」核对 + 行内代码补底色（2026-10-22，DEV-0109） | 实施者自检通过（真实 Chromium 1270×900 replyTypography.spec.ts 3/3，其中新增一条按计算样式断言、A/B 去掉规则即红；workbench tsc --noEmit exit 0；check-docs 通过）；真实 Windows/We…（结论未完整展示，见详情） | [详情 036](acceptance-details/part-03.md#条目-036) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话模式下拉浮层脱离芯片 → 应用自绘浮层（2026-10-22，DEV-0116） | 实施者自检通过（真实 Chromium 1162×782 新增 conversationModeMenu.spec.ts 3/3 并留前后截图；composerSourcePanel.spec.ts 5/5；工作台 jsdom assistantModeSwitch.spec.t…（结论未完整展示，见详情） | [详情 037](acceptance-details/part-03.md#条目-037) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 未选择目录时权限四档不可选 → 工作区默认写入档位（2026-10-22，DEV-0115） | 实施者自检通过（真实临时 PostgreSQL 定向集成 18/18，其中新增 5 例；工作台 jsdom writePermissionTier 24/24 与客户端新增 2 例；真实 Chromium 1440×900 新场景 2/2 并留图；workbench tsc --…（结论未完整展示，见详情） | [详情 038](acceptance-details/part-03.md#条目-038) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 目录细条归属格与告警并存矛盾、会话轮次操作类能力说明（2026-10-22，DEV-0117） | 实施者自检通过（真实 Chromium 1440×900 改前/改后同一行 A/B 截图；定向 assistBinding 16/16，新增三档在改前表达式下 3/3 逐条红；API 定向单测 8/8、全量 unit 933 通过/0 失败/1 跳过（exit 0）；两侧 tsc…（结论未完整展示，见详情） | [详情 039](acceptance-details/part-01.md#条目-039) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 消息发送四相位布局/配色与排队消息样式（2026-10-22，DEV-0110） | 实施者自检通过（真实 Chromium 1162×782 四相位 A/B 截图＋几何/配色探针；定向 3 文件 34/34；独立验收同组 46/46；tsc --noEmit exit 0）；真实 Windows/WebView2 窗口未复验 | [详情 040](acceptance-details/part-03.md#条目-040) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 桌面与本轮台账最终结论（2026-10-22，原 25 单＋新增 4 单） | 原 25 单 20 通过、5 退回、0 待验；新增 DEV-0104 通过，DEV-0105/0110/0117 退回。合计 29 单：21 通过、8 退回 | [详情 041](acceptance-details/part-03.md#条目-041) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 桌面专项独立验收（2026-10-22，DEV-0110/0117） | 真实 Windows/WebView2 未通过；DEV-0117、DEV-0110 均已退回 | [详情 042](acceptance-details/part-03.md#条目-042) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Bug/UI 接续独立复核（2026-10-22，DEV-0104/0105/0110 与原待补证项） | DEV-0105 独立退回；DEV-0104 保留待验；DEV-0110 在途回归有 3 红，尚未归因 | [详情 043](acceptance-details/part-03.md#条目-043) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 电脑插件真实 Windows/WebView2 补验（2026-10-22，接续上述 25 单） | 新增 DEV-0093/0095/0097 通过，DEV-0092/0103 退回；原 25 单累计 17 通过、5 退回、3 保留待验收 | [详情 044](acceptance-details/part-03.md#条目-044) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 台账 25 条待验收项独立复核（2026-10-22，主工作区；覆盖本轮开始时的工单集合） | 14 条通过、3 条退回、8 条保留待验收；不代表整体交付 | [详情 045](acceptance-details/part-03.md#条目-045) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 新建会话/新对话触发聊天区抖动与闪烁（2026-10-22，DEV-0104） | 实施者自检通过（真实 Chromium 7 场景帧/几何探针；回归 30/30）；真实 Windows/WebView2 窗口未复验 | [详情 046](acceptance-details/part-03.md#条目-046) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话模式改为静态徽标＋「退出」，不再用下拉框（2026-10-22，DEV-0105） | 实施者自检通过（组件＋整视图回归 14/14；真实 Chromium 1162×782 实测 1/1）；真实 Windows/WebView2 窗口未复验 | [详情 047](acceptance-details/part-03.md#条目-047) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 代码块复制键：成功后弹出「复制成功」回执并在数秒后还原（2026-10-22，DEV-0108） | 实施者自检通过（真实 Chromium 1162×782 实测＋组件回归 35/35）；真实 Windows/WebView2 窗口未复验 | [详情 048](acceptance-details/part-03.md#条目-048) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话直写创建的未跟踪文件进入会话 diff（2026-10-22，DEV-0107） | 实施者自检通过（真实 PG＋真实临时 Git 仓库＋真实会话工具轮 2/2；既有 conversation-diff 5/5；diff 单测 69/69；A/B 旧查询转红）；真实 Windows/WebView2 窗口未验 | [详情 049](acceptance-details/part-03.md#条目-049) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 本目录写入档位菜单：图标整行居中与宽度再收一档（2026-10-21，DEV-0101） | 实施者自检通过（真实 Chromium 探针量测＋组件回归 19/19）；真实 Windows/WebView2 窗口未复验 | [详情 050](acceptance-details/part-03.md#条目-050) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 「+」→ 连接器 → 插件行只把 `@标签 ` 插进输入框（2026-10-22，DEV-0099） | 实施者自检通过（真实 Chromium 会话路由＋组件回归 31/31）；真实 Windows/WebView2 窗口未复验 | [详情 051](acceptance-details/part-04.md#条目-051) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 目标模式目标卡版式层级（2026-10-22，DEV-0103） | 实施者自检通过（真实 Chromium 完整态、窄窗滚动与第 0 轮空态＋浏览器回归 3/3）；真实 Windows/WebView2 窗口未复验 | [详情 052](acceptance-details/part-04.md#条目-052) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 批量删除失败后不再退回第三次确认（2026-10-22，DEV-0098） | 实施者自检通过（真实 Chromium 批量流程＋组件回归 24/24）；真实 Windows/WebView2 窗口未复验 | [详情 053](acceptance-details/part-04.md#条目-053) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 桌面宿主：已收敛启动记录清理失败不再杀掉整个应用（2026-10-21，DEV-0072，**主目录整合**） | 通过（MSVC cargo test --lib 45/45、cargo check exit 0）；真实桌面进程启动未验 | [详情 054](acceptance-details/part-04.md#条目-054) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 电脑操控运行时：启动失败不再谎称「效果未知」（2026-10-21，DEV-0075，**主目录整合**） | 通过（单元 24/24、真实 spawn ENOENT 复现、真实临时 PG computer-control 10/10、tsc exit 0）；真实桌面输入未验 | [详情 055](acceptance-details/part-04.md#条目-055) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 人工完成指针写入的守卫强度复核（2026-10-21，DEV-0028，**主目录整合**） | 前提不成立：守卫已存在；新增真实 PG 并发用例 2/2 锁住该不变量；未改产品代码 | [详情 056](acceptance-details/part-04.md#条目-056) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 长期记忆的来源类别与「由系统判断要不要记」（2026-10-21，ADR-032；接续 2026-10-19/20 记忆行） | 通过（真实临时 PG 1/1＋记忆相关集成 33/33＋单测 10/10＋工作台 36/36＋两端类型检查 exit 0＋check-docs 通过）；真实 Provider 提取质量与真实 Windows 窗口未验 | [详情 057](acceptance-details/part-04.md#条目-057) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 聊天 `/goal` 与 `/plan` 完整实施（2026-10-21，按 `prompts/goal-plan-modes.md`，迁移 0127） | 实施者自检通过（真实 PG/HTTP + jsdom）；浏览器、真实 Provider、Windows/WebView2 与独立验收未做 | [详情 058](acceptance-details/part-04.md#条目-058) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 模型芯片显示链：无显式选择时显示应用默认而非「模型」占位（2026-10-21，用户复述「要记住上一次选择的模型，不要每一个会话都先显示『模型』两个字」） | 实施者自检通过（jsdom）；真实 Windows/WebView2 窗口未复验 | [详情 059](acceptance-details/part-04.md#条目-059) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 电脑运行时 stdout 分块解码与单行字节限额（2026-10-21，接续上方 DEV-0088） | 通过（DEV-0088 本单独立复验通过；不代表整个电脑模块通过） | [详情 060](acceptance-details/part-04.md#条目-060) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 电脑运行时回复 envelope 严格校验（2026-10-21，DEV-0091） | 通过（受控假进程定向单测；不代表真实桌面协议） | [详情 061](acceptance-details/part-04.md#条目-061) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 电脑运行时旧进程迟到事件隔离（2026-10-21，DEV-0090） | 通过（受控假进程定向单测；不代表真实进程已失管场景） | [详情 062](acceptance-details/part-04.md#条目-062) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 今日页切换查询时区后眉线错一天（2026-10-21，DEV-0097） | 实施者自检通过（工作台 jsdom）；真实 Windows/WebView2 窗口未复验 | [详情 063](acceptance-details/part-04.md#条目-063) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 新对话草稿按内容作用域保存（2026-10-21，DEV-0092） | 实施者自检通过（工作台 jsdom）；真实 Windows/WebView2 窗口未复验 | [详情 064](acceptance-details/part-04.md#条目-064) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 定时任务创建表单离页保护（2026-10-21，DEV-0095） | 实施者自检通过（工作台 jsdom）；真实 Windows/WebView2 窗口未复验 | [详情 065](acceptance-details/part-04.md#条目-065) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 定时创建响应未知后的命令身份冻结与回执核对（2026-10-21，DEV-0096／禅道 #7） | 通过（确定性组件回归 8/8＋真实临时 PG/HTTP 重放 1/1；真实 Windows/WebView2 窗口未复验） | [详情 066](acceptance-details/part-04.md#条目-066) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 定时任务状态变更、时段补跑与详情读取的恢复入口（2026-10-22，禅道 #37／#36，原 DEV-0123／DEV-0124） | 实施者自检通过（2026-10-23 补做丢失实现后确定性组件回归 6/6＋A/B；真实 Windows/WebView2 窗口未复验） | [详情 067](acceptance-details/part-04.md#条目-067) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 记忆列表状态筛选标签溢出（2026-10-21，DEV-0093） | 实施者自检通过（真实 Chromium 1162×782 实测＋A/B）；真实 Windows/WebView2 窗口未复验 | [详情 068](acceptance-details/part-04.md#条目-068) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 目标推进扫描饥饿：50 个较旧静止目标挡住暂停/取消与轮次结算（2026-10-21，DEV-0094） | 通过（真实临时 PG 定向 1/1＋chat-plan-goal 全套 12/12＋A/B；不代表真实 Provider） | [详情 069](acceptance-details/part-04.md#条目-069) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 取消目标时 PENDING 轮次被 Worker 领取后异常逃出 tick（2026-10-21，DEV-0102） | 通过（真实临时 PG 定向 1/1＋chat-plan-goal 全套 13/13＋A/B；不代表真实 Provider） | [详情 070](acceptance-details/part-04.md#条目-070) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 首条消息也能先选项目资料并随首条消息冻结（2026-10-21，DEV-0100） | 实施者自检通过（工作台组件 40/40＋新增视图回归 1/1；真实 Windows/WebView2 窗口未复验） | [详情 071](acceptance-details/part-04.md#条目-071) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 台账待验收项独立复核与新 Bug 走查（2026-10-21，主工作区） | Relay 13 条通过、2 条退回、4 条保留待验收；不代表整体交付 | [详情 072](acceptance-details/part-04.md#条目-072) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| GitHub 插件登录态误报：探测读不到 Windows 凭据（2026-10-21，接续 [HTTP §10.104](../api/http-command-contract/part-07.md#10104-插件运行时状态2026-10-20-源码实现)） | 通过（真实 gh 2.102.0 隔离实测＋单测 4/4＋github-read 22/22＋构建 exit 0） | [详情 073](acceptance-details/part-04.md#条目-073) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 输入框图片附件：4 例活跃红灯修复（2026-10-21，接续 2026-10-19 六项收口行） | 通过（真实临时 PG assist-message-attachments 5/5；能力判定单测 5/5；构建 exit 0） | [详情 074](acceptance-details/part-04.md#条目-074) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 过程可见、简单问题收口与权限禁用可读（2026-10-21 用户三项指认，未 commit/push） | 部分通过（jsdom、真实临时 PG、提示词单测齐全；Windows/WebView2 窗口未复验） | [详情 075](acceptance-details/part-04.md#条目-075) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 日常操作阻力 Windows 定向走查（2026-10-21，只验收与提示词） | 部分通过：菜单、已抽查导航可达；上下文丢失与处理成本待整改 | [详情 076](acceptance-details/part-04.md#条目-076) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 日常减负第三轮整改 R3-01～R3-05（2026-10-21，接续上方 Windows 走查行，按 `prompts/product-complexity-reduction.md` 第三节） | 部分通过（jsdom 与真实 headless Chromium 取证通过；真实 Windows/WebView2 窗口未复验） | [详情 077](acceptance-details/part-05.md#条目-077) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 连续插话的真实 Provider 取证与两处测试缺陷（2026-10-21，接续下方 10-20 行） | 部分通过（真实模型实测仅场景 A、F 取得语义证据；B、C、D、E 因账户限流未取证）；确定性链已独立复跑 20/20 绿 | [详情 078](acceptance-details/part-05.md#条目-078) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Workbench 发送态输入器与聊天区观感（2026-10-21，接续 10-20 的闪烁、竖直重心、排队消息三条指认） | 实施者自检通过（jsdom 46/46 加真实 Chromium 浏览器 14/14）；真实 Windows/WebView2 窗口未运行 | [详情 079](acceptance-details/part-05.md#条目-079) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 聊天 `/plan`、`/goal` 的计划内容读不回（2026-10-21，接续下方 10-20 行；**根因不是「未落库」**） | 实施者自检通过（真实临时 PG 定向 spec 三段证据：基线 8/8 绿 → 补内容断言后 5/8 三红 → 修后 8/8 绿）；独立验收未做 | [详情 080](acceptance-details/part-05.md#条目-080) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 输入器工具行 select chip 文字贴顶（2026-10-20，用户截图「输入框底部那些的竖直重心没有在一个高度」） | 实施者自检通过（真实 Chromium 像素实测 A/B）；真实 Windows/WebView2 窗口未复验 | [详情 081](acceptance-details/part-05.md#条目-081) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 目录行「＋」新建会话时聊天区跳动（2026-10-20，用户截图三轮指认：初版「挑一下」→第二轮「还是会闪一下」并点名「正在核对目标与会话」→第三轮停在「正在打开目录…」） | 实施者自检通过（工作台 jsdom）；真实 Windows/WebView2 窗口未复验 | [详情 082](acceptance-details/part-05.md#条目-082) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 聊天 `/plan` 与 `/goal` 模式（2026-10-20，`prompts/goal-plan-modes.md`） | 实施者自检通过（真实临时 PG 18.6 + 两端类型检查 + 工作台 jsdom）；真实 Provider、真实窗口与独立验收未闭合 | [详情 083](acceptance-details/part-05.md#条目-083) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 连续插话与方向变化（2026-10-20，接续下方 10-19 插话初版） | 实施者自检部分通过：真实 PG/工具边界与失败恢复窗口通过（2026-10-21 确定性链在真实 PG 复跑 20/20 仍全绿）；真实模型意图理解已取证 2/6 场景，其余见上方 10-21 新行 | [详情 084](acceptance-details/part-05.md#条目-084) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| AI 回复正文排版：16px / 1.7、实心记号、统一块距、引用块（2026-10-20，用户「我想做好看的回复」） | 实施者自检通过（真实 Chromium 复现 + jsdom）；真实 Windows/WebView2 窗口未复验 | [详情 085](acceptance-details/part-05.md#条目-085) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| AI 回复「段落 + 紧跟列表」被吞成一行（2026-10-20，用户追问「还有没有什么问题」） | 实施者自检通过（工作台 jsdom）；真实 Windows/WebView2 窗口未复验 | [详情 086](acceptance-details/part-05.md#条目-086) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 聊天页记忆 UI 移除与执行摘要溢出修正（2026-10-20，用户截图两条指令） | 实施者自检通过（工作台 jsdom + 真实 Chromium 探针）；真实 Windows/WebView2 窗口未复验 | [详情 087](acceptance-details/part-05.md#条目-087) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话执行的服务端推进与失败恢复（2026-10-20 第二轮） | 实施者自检通过（真实临时 PG + jsdom）；真实 Provider、浏览器/电脑操作、Windows 窗口与独立验收未闭合 | [详情 088](acceptance-details/part-05.md#条目-088) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话内直接写与工具主链分层（2026-10-20，ADR-031 接续） | 实施者自检通过；真实 Provider、Windows 窗口、操作审批往返与独立验收未闭合 | [详情 089](acceptance-details/part-05.md#条目-089) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 日常减负第二轮：资料、规则、任务起步、定时任务与记忆呈现（2026-10-20，R2-01～R2-07） | 实施者自检通过（工作台 jsdom + 两端类型检查）；真实 PG 未跑 | [详情 090](acceptance-details/part-05.md#条目-090) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 目录内 Git 只读随目录授权成立（2026-10-20，P1-3） | 实施者自检通过（真实临时 PG 18.6 + 真实 git 仓库） | [详情 091](acceptance-details/part-05.md#条目-091) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 日常操作减负：工具状态分层、插件详情、保存失败呈现、占位入口清理（2026-10-20，P0-1/P0-2/P1-4/P2） | 实施者自检通过（工作台 jsdom） | [详情 092](acceptance-details/part-05.md#条目-092) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 完整长短期记忆后端（2026-10-20） | 约定后端工程出口通过：自检→独立代码复核→修复→独立真实PG复验 | [详情 093](acceptance-details/part-05.md#条目-093) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 长期记忆自动捕获（2026-10-20，ADR-030，零点击） | 实施者自检通过（类型 + 单测 + 前端组件）；真实 PG 集成未跑 | [详情 094](acceptance-details/part-05.md#条目-094) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 长短期记忆前端接线（2026-10-20，`prompts/memory-module-frontend.md`） | 实施者自检通过（工作台 jsdom + 类型检查 + 构建） | [详情 095](acceptance-details/part-05.md#条目-095) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 排队消息的插话（2026-10-19 深夜，用户「按一次回车进入队列，再按一次回车就能发出去」） | 已通过（真实临时 PG 18.6 + 真实主流程；前端 jsdom） | [详情 096](acceptance-details/part-05.md#条目-096) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 聊天阅读列与输入器同轴（2026-10-19 深夜，用户截图「这两个 ai 好像没有对齐」→「左边跟输入框的左边对齐就好了」） | 已通过（真实 Chromium 实测，A/B 各跑一次） | [详情 097](acceptance-details/part-06.md#条目-097) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 连接与权限沿用复制 `CopyGatewaySettings`（2026-10-19，后端） | 实施者自检通过 | [详情 098](acceptance-details/part-06.md#条目-098) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话模式下拉的浮层与选中态收进设计系统（2026-10-19 深夜，用户截图指令「优化一下这个下拉框，还有这个下拉按钮的选中态」） | 已通过（真实 Chromium 实测 + jsdom） | [详情 099](acceptance-details/part-06.md#条目-099) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 工具行左端两枚事实与浮层只浮出内容（2026-10-19 深夜接续，用户「模型下拉按钮放到输入框左边，再左边是上下文圆圈；普通讨论是干嘛的，点击之后 ui 还会消失，关闭菜单之后 ui 又出来了」） | 已通过（真实 Chromium 实测 + jsdom） | [详情 100](acceptance-details/part-06.md#条目-100) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 工具行右端一组：上下文与模型下拉移到发送键左边（2026-10-20，用户「上下文和模型下拉按钮整体移动到发送按钮的左边，用 tasteskill 优化一下这一行所有按钮」） | 实施者自检通过（真实 Chromium + jsdom） | [详情 101](acceptance-details/part-06.md#条目-101) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 历史消息内容块第二轮：来源条/等待批准/草稿/候选卡（2026-10-19 深夜，用户「应该还有其他 UI 元素吧？继续开发」） | 实施者自检通过 | [详情 102](acceptance-details/part-06.md#条目-102) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 「+」菜单撤出目录入口（2026-10-19） | 实施者自检通过 | [详情 103](acceptance-details/part-06.md#条目-103) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 发送键提交态不闪禁用灰（2026-10-19 深夜，用户反馈「发送消息界面会闪一下」） | 实施者自检通过 | [详情 104](acceptance-details/part-06.md#条目-104) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 任务栏待处理角标（2026-10-19 深夜） | 部分通过：绘制与宿主接口自检通过，Windows 外壳叠加未取证 | [详情 105](acceptance-details/part-06.md#条目-105) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 「+」二级弹层纵向定位：相对一级居中、贴底时底边对齐（2026-10-19 深夜） | 实施者自检通过 | [详情 106](acceptance-details/part-06.md#条目-106) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 历史消息内容块统一呈现（2026-10-19 深夜，用户「用 taste 这个 skill 美化一下 agent 的历史消息」） | 实施者自检通过 | [详情 107](acceptance-details/part-06.md#条目-107) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 输入器档位菜单图标、脚注与宽度收改（2026-10-19 晚两轮用户截图指令） | 实施者自检通过 | [详情 108](acceptance-details/part-06.md#条目-108) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 「+」菜单去掉说明文字（2026-10-19 晚） | 实施者自检通过 | [详情 109](acceptance-details/part-06.md#条目-109) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 连接器「授权」文案复读收敛（2026-10-19） | 实施者自检通过 | [详情 110](acceptance-details/part-06.md#条目-110) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 协作页删除消息行模型调用披露（2026-10-19） | 实施者自检通过 | [详情 111](acceptance-details/part-06.md#条目-111) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 长期记忆状态与筛选后端（2026-10-19） | 部分通过：后端开发自检通过，前端未接 | [详情 112](acceptance-details/part-06.md#条目-112) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 长期记忆状态与筛选前端（2026-10-19） | 部分通过：前端组件自检通过，真实 API 浏览器链路未跑 | [详情 113](acceptance-details/part-06.md#条目-113) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 普通聊天文件增删改查·真实模型端到端跑通（2026-10-19，用户报「最基础的增删改查还没跑通」） | 已通过（真实模型 + 真实 PG/HTTP/磁盘；首轮失败后连续 6 次通过） | [详情 114](acceptance-details/part-06.md#条目-114) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 默认工作目录前端（2026-10-19） | 部分通过：前端开发自检通过，整体未验收 | [详情 115](acceptance-details/part-06.md#条目-115) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 资料与记忆规则恢复前端（2026-10-19） | 部分通过：组件与类型检查通过，真实 API 浏览器链路未跑 | [详情 116](acceptance-details/part-06.md#条目-116) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 资料与记忆规则恢复后端（2026-10-19） | 部分通过：后端开发自检通过，前端未接 | [详情 117](acceptance-details/part-06.md#条目-117) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 新会话固定快捷语提示词优化（2026-10-19） | 源码已更新，预填自检通过；模型效果未验收 | [详情 118](acceptance-details/part-06.md#条目-118) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 默认工作目录后端（2026-10-19） | 部分通过：后端开发自检通过，整体未验收 | [详情 119](acceptance-details/part-06.md#条目-119) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 「+」菜单固定显示三个内置插件（2026-10-19，用户指认「加号的菜单看不到这三个插件」） | 通过（jsdom 26/26＋tsc exit 0）；真实 Windows 窗口未复验 | [详情 120](acceptance-details/part-06.md#条目-120) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 输入框粘贴图片与消息附件：六项收口复验（2026-10-19，接续 5e5cdb68 与 dfa64938 的未勾选任务） | 通过（限定工程范围）：Workbench jsdom 定向 7/7、真实临时 PG assist-message-attachments 5/5、双端 tsc --noEmit exit 0；真实 Windows 窗口与真实 Provider 未验 | [详情 121](acceptance-details/part-06.md#条目-121) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话局部与总 diff：真实 PG 集成补测（2026-10-19，接续 bfcfa4d9 的任务 5） | 通过（服务层）：新增 conversation-diff.integration.test.ts 5/5，真实临时 PG 18.6＋真实临时 Git 仓库，status PASSED；HTTP 端点层与 UI 不在本文件断言范围 | [详情 122](acceptance-details/part-06.md#条目-122) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话行批量选择复选框与批量删除（2026-10-20，用户指令「给会话 item 加一个复选框，方便删除记录」） | 限定工程范围通过（jsdom 23/23＋真实 Chromium 几何 10/10＋工作台 tsc 对本片干净）；真实 Windows/WebView2 窗口与多 DPI 未目视 | [详情 123](acceptance-details/part-07.md#条目-123) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话 diff：大文件被误报为删除（2026-10-20，用户截图「会话没有修改过文件，但是还是有 git diff」） | 已修（真实 HTTP＋真实 PG＋真实 2000 文件目录：DELETE 归零；diff 单元 44/44＋前端 13/13）；真实窗口未复验 | [详情 124](acceptance-details/part-07.md#条目-124) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话 diff 归因链端到端（2026-10-20，补上一行「未取证」的缺口） | 已通过（真实 PG＋真实 HTTP＋真实 Run Worker，1/1） | [详情 125](acceptance-details/part-07.md#条目-125) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话 diff 只认实际落盘＋工作详情「变更」页签（2026-10-20，用户「接，完全不出现」） | 已通过（真实 HTTP 双口径＋真实 PG 集成 5/5＋diff 单元 50/50＋jsdom 17/17＋Chromium 8/10 与工作详情三套件 25/25） | [详情 126](acceptance-details/part-07.md#条目-126) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话 diff 收窄为「只统计本会话写入」（2026-10-20，用户指令「工作详情那里统计总目录就好了，这里就只统计当前会话的 git diff」） | 已通过（真实 HTTP＋真实 PG 集成 5/5＋diff 单元 49/49＋jsdom 15/15＋Chromium 8/10，2 例为并行改动既有失败） | [详情 127](acceptance-details/part-07.md#条目-127) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 电脑插件 V1/V2 当前构建复验（2026-10-19，接续 c8a1a76d 的任务 8/9） | 部分通过：当前源码 release 的只读路径、崩溃重连、单测与文档检查全绿；真实键鼠输入与窗口激活未复验 | [详情 128](acceptance-details/part-07.md#条目-128) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话行菜单新增分叉（2026-10-18，用户指令「增加归档、fork（fork之后的那个会话名字加一个"（1）"）」，选定带历史 fork） | 部分通过（真实临时 PG 定向 22/22＋API 单测 6/6＋Workbench jsdom 19/19＋tsc 干净）；真实 Windows 窗口未复验 | [详情 129](acceptance-details/part-07.md#条目-129) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话顶栏删除「新建会话」加号（2026-10-18，用户截图指令） | 已通过（headless Chromium 定向 18/18＋jsdom 定向 19/23）；4 条 jsdom 红灯为共享工作树中他人未提交的目标标题回退，只报不修；真实 Windows 窗口未复验 | [详情 130](acceptance-details/part-07.md#条目-130) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 浏览器插件真实扩展复验：桌面端临时端口导致 `bridge.json` 写成 0（2026-10-18） | 已修（单测 36/36）；真实扩展端到端待重新加载扩展后复验 | [详情 131](acceptance-details/part-07.md#条目-131) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话按最后消息时间自动上浮（2026-10-18，用户确认口径「就按消息的最后时间算吧，不管是 ai 还是用户」） | 已通过（真实临时 PG 定向 18/18＋Workbench jsdom 定向 8/8＋本片 tsc 干净）；真实 Windows 窗口与左栏实时重排未验 | [详情 132](acceptance-details/part-07.md#条目-132) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 切换会话不再重排工作区分组（2026-10-23，用户截图「切换会话，会话工作区位置会交换」） | 已修（jsdom 定向 11/11＋左栏相关 5 文件 61/61＋工作台 tsc --noEmit 干净）；真实 Windows 窗口未复验 | [详情 133](acceptance-details/part-07.md#条目-133) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 消息落地即收敛：左栏活动序立即上浮（2026-10-23，用户在「立即发生／等下次重读」中选定立即发生） | 已实现（jsdom 定向 14/14＋左栏相关 7 文件 147/147＋工作台 tsc --noEmit 干净）；真实 Windows 窗口未复验 | [详情 134](acceptance-details/part-07.md#条目-134) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 目录行悬停「＋」新建会话（2026-10-18，用户截图指令「鼠标悬停 item 的时候要显示一个新建会话的按钮，点击自动以该目录新建一个空会话」） | 部分通过（jsdom 定向 33/33＋headless Chromium 9/9；真实 Windows 窗口未复验） | [详情 135](acceptance-details/part-07.md#条目-135) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 危险操作的可撤销化：会话归档撤销条与会话物理删除（2026-10-18，用户指令「危险操作像是会话归档删除，都要有一个 toast 可以让用户撤销动作」） | 限定工程范围通过（jsdom 19/19＋项目归档 9/9＋真实临时 PostgreSQL 9/9 与项目 14/14＋两侧 tsc --noEmit）；真实 Windows 窗口、多 DPI 与其余危险操作族未落地 | [详情 136](acceptance-details/part-07.md#条目-136) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 输入器权限档位四档化并新增「完全访问」真实档位（2026-10-18，用户实机截图指令） | 部分通过（真实临时 PG/HTTP/磁盘定向 36/36＋Workbench jsdom 定向 30/30＋两端 typecheck）；桌面 WebView2 实机点击未复验 | [详情 137](acceptance-details/part-07.md#条目-137) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| AI 消息头任务耗时（2026-10-18，用户截图指令） | 部分通过（jsdom 定向 5/5＋tsc 无本改动错误；真实窗口未复验） | [详情 138](acceptance-details/part-07.md#条目-138) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 浏览器插件三处静默失效（2026-10-18 第二轮） | 部分通过（四套件 35/35；真实 Chrome 多标签页与加载态未实测） | [详情 139](acceptance-details/part-07.md#条目-139) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 电脑插件滚动结果报实际位移（2026-10-18 第二轮） | 已通过（Rust 20/20） | [详情 140](acceptance-details/part-07.md#条目-140) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话行菜单：剪贴板 URI、整行右键与浮层间距（2026-10-18，用户截图指令） | 已通过（jsdom 定向＋headless Chromium 几何量测）；真实 Windows 窗口未复验 | [详情 141](acceptance-details/part-07.md#条目-141) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 新对话首屏：快捷卡两行、动态标签前置、提示词即拿即用、功能族分隔板（2026-10-18，用户截图指令） | 已通过（headless Chromium 实测 + jsdom） | [详情 142](acceptance-details/part-07.md#条目-142) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 输入框粘贴图片与消息附件（2026-10-18，前端接线） | 部分通过（前端 jsdom 6/6＋真实 PG 5/5＋双端 tsc；真实窗口与 Provider 未验） | [详情 143](acceptance-details/part-07.md#条目-143) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 电脑插件补 `computer_move`（2026-10-18，三插件接续） | 部分通过（Rust 19/19＋TS 定向 41/41；真实桌面输入未复验） | [详情 144](acceptance-details/part-07.md#条目-144) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 浏览器扩展默认路线补历史导航、双击与截图摘要（2026-10-18，三插件接续） | 此前增量自检通过；最新真实扩展成绩见 F26 主行 | [详情 145](acceptance-details/part-07.md#条目-145) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| GitHub 只读片补 `gh` 解析与真实 argv（2026-10-18，三插件接续） | 此前参数/失败分类通过；最新已认证读取成绩见 F25 首片主行 | [详情 146](acceptance-details/part-07.md#条目-146) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 浏览器扩展空闲保活兜底（2026-10-18，三插件接续） | 部分通过（VM 跑真实 background.js 定向 14/14；真实 Chrome 空闲未复验） | [详情 147](acceptance-details/part-08.md#条目-147) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 电脑插件 `computer_type` 描述与运行时默认值对齐（2026-10-18，三插件接续） | 已通过（定向单测锁定跨语言常量） | [详情 148](acceptance-details/part-08.md#条目-148) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| GitHub 只读补 `github_issue_view`（2026-10-18，三插件接续） | 部分通过（单测 22/22，含真实 gh 2.102.0 argv 探针；真实已认证读取与 PG 集成未复跑） | [详情 149](acceptance-details/part-08.md#条目-149) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Skill 不再按工作区过滤：清单全量 + 目标芯片交接（2026-10-18 第二轮，用户指令「不应该跟工作区产生强关联」） | 已通过（jsdom 定向）；真实路由端到端、Chromium 与 Windows 窗口未验 | [详情 150](acceptance-details/part-08.md#条目-150) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 「+」菜单的「选择 Skill 生成」与「连接器与插件」恒可展开（2026-10-18，用户截图指认「选择skill和连接器与插件点击不了」） | 已通过（jsdom 定向）；真实 Chromium 与真实 Windows 窗口未验 | [详情 151](acceptance-details/part-08.md#条目-151) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 生成中预览 SSE 推送：前端接线 + 契约 + 真实 PG 集成（2026-10-18） | 已通过（前端定向 + 真实临时 PG 集成） | [详情 152](acceptance-details/part-08.md#条目-152) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 近期工作栏搜索框光标高度与图标间距（2026-10-18，用户两轮截图指令） | 已通过（headless Chromium 像素实测 + jsdom） | [详情 153](acceptance-details/part-08.md#条目-153) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 收件箱页按 V5.11 原型改版（2026-10-18，用户原型图指令） | 已通过（jsdom + headless Chromium） | [详情 154](acceptance-details/part-08.md#条目-154) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 输入区两行合并：目录名即「更换目录」入口（2026-10-18，用户实机截图指令） | 已通过（headless Chromium + jsdom） | [详情 155](acceptance-details/part-08.md#条目-155) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 本地目录 D1–D4 协调复验与交付核对（2026-10-18，当前） | 四项修复独立验收通过；完整交付仍部分通过 | [详情 156](acceptance-details/part-08.md#条目-156) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 本地目录免配置·协调独立验收（2026-10-18） | 未通过，四项整改；正常路径范围通过 | [详情 157](acceptance-details/part-08.md#条目-157) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 本地目录免配置 D1–D4 修复自检（2026-10-18） | 实施者自检通过，待协调者独立复验 | [详情 158](acceptance-details/part-08.md#条目-158) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 本地目录免手工配置（2026-10-17，新确认目标） | 应用实现及真实 PG/HTTP 通过；整体部分验收 | [详情 159](acceptance-details/part-08.md#条目-159) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 执行中输入区布局稳定（2026-10-17 第三轮） | 限定工程范围通过（tsc --noEmit exit0＋assistantModeSwitch/assistModelRuntime 定向 51/51＋check-docs exit0）；真实 Chromium 与真实 Windows 窗口未复验 | [详情 160](acceptance-details/part-08.md#条目-160) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 普通 Agent 文件 CRUD 接续（2026-10-18） | 真实 PG/HTTP/磁盘与原消息结果通过；Provider/桌面出口未验 | [详情 161](acceptance-details/part-08.md#条目-161) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 内置浏览器自动化（F26，2026-10-17） | 部分通过（2026-10-18 日常 Chrome 安装、配对及页面动作通过；保活复验中） | [详情 162](acceptance-details/part-08.md#条目-162) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话顶栏图标工具栏、会话目录图标与拖拽分隔条（2026-10-17） | 部分通过（工程自检）；真实 Windows 窗口未验 | [详情 163](acceptance-details/part-08.md#条目-163) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 对话输入器本目录写入档位（2026-10-17） | 部分通过（工程自检）；真实 Windows 窗口与真实 API 浏览器闭环未验 | [详情 164](acceptance-details/part-08.md#条目-164) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 日常后端：目标/项目维护与 Inbox 原任务归入项目（2026-10-17） | 本轮基础链路独立验收通过；前端未接线 | [详情 165](acceptance-details/part-08.md#条目-165) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 目标与普通工作区后端工作上下文（2026-10-17） | 基础后端链路独立验收通过；前端未接线 | [详情 166](acceptance-details/part-08.md#条目-166) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话行 ⋯ 菜单条目左对齐与文字色（2026-10-17） | 限定工程范围通过（真实 Chromium 伪造 API 的计算样式量测）；真实 Windows 窗口与多 DPI 未复验 | [详情 167](acceptance-details/part-08.md#条目-167) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话行「标记为未读」与「复制会话 ID」（2026-10-17） | 限定工程范围通过（真实 PostgreSQL 集成＋jsdom＋真实 Chromium 伪造 API）；真实 Windows 窗口、多 DPI 与桌面暂存 API 实机未复验 | [详情 168](acceptance-details/part-08.md#条目-168) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 近期工作栏会话行拖拽改序与落位动效（2026-10-17） | 限定工程范围通过（jsdom 组件用例＋真实 Chromium 伪造 API 的几何与动画量测）；真实 Windows 窗口与多 DPI 未验收 | [详情 169](acceptance-details/part-08.md#条目-169) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 浮层反馈通道（Toast／Snackbar／Notice，2026-10-17） | 限定工程范围通过（jsdom 组件与页面用例＋类型检查）；真实 Windows 窗口与多 DPI 下的几何未复验，其余页面仍为就地反馈 | [详情 170](acceptance-details/part-09.md#条目-170) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 内置 GitHub Skill 只读片（F25 首片，2026-10-17） | 限定只读链通过（2026-10-18 真实已认证＋Gateway/PG）；F25 整体未验收 | [详情 171](acceptance-details/part-09.md#条目-171) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 免费模型生产链与额度自动接续（2026-10-17） | 未验收（Luna 实施与协调复验中）；本轮用户选择先完成可控端到端验收 | [详情 172](acceptance-details/part-09.md#条目-172) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 电脑操控全局状态 Overlay（2026-10-17） | 部分通过（2026-10-18 真实 Windows 输入与 PG 控制状态通过） | [详情 173](acceptance-details/part-09.md#条目-173) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话局部与总 diff（2026-10-16 编制，2026-10-17 W1–W3 实施） | 未验收（W1–W3 源码已落地并通过工程自检；W4 的真实 PG／一次性 Git 仓库／真实 Provider 工具流／真实 Windows 窗口全部未取证） | [详情 174](acceptance-details/part-09.md#条目-174) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 输入框粘贴图片与消息附件（2026-10-16） | 未验收（后端源码已实现＋定向单测通过；前端未接线，集成/浏览器/真实窗口未取证） | [详情 175](acceptance-details/part-09.md#条目-175) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 免费模型模块阶段 0 整改（2026-10-16） | 阶段 0 整改通过（含独立来源约束反例转绿）；生产免费外呼、自动刷新生命周期、Run 候选冻结、前端选择器与「单模型额度耗尽自动接续」仍未实施 | [详情 176](acceptance-details/part-09.md#条目-176) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 点击后界面定向验收（2026-10-16） | 部分通过；布局与信息层级需整改 | [详情 177](acceptance-details/part-09.md#条目-177) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 输入器底栏布局回归与输入卡恒定（2026-10-16） | 限定工程范围通过（仓外 Chromium 几何量测 + jsdom 结构断言）；真实 Windows 窗口与多 DPI 未复验 | [详情 178](acceptance-details/part-09.md#条目-178) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 免费模型模块独立验收（2026-10-16） | 未通过；定向单测通过，真实 PG 存在夹具阻塞与约束失败；自动额度接续为新增未实施目标 | [详情 179](acceptance-details/part-09.md#条目-179) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Agent 入口统一与目录读取（2026-10-16） | 限定范围通过（真实 Windows 窗口定向验收＋真实 PG/真实模型链路＋工程回归）；MODEL_FAILED 间歇失败未闭合，按现有证据不能归因于本地实现 | [详情 180](acceptance-details/part-09.md#条目-180) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 输入器「+」弹层收改（2026-10-16） | 限定工程范围通过（仓外 Chromium 静态探针量测 + jsdom 断言）；真实 Windows 窗口与多 DPI 未复验 | [详情 181](acceptance-details/part-09.md#条目-181) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 聊天消息时间线导航（2026-10-16） | 限定工程范围通过（组件 jsdom 与真实 Chromium 伪造 API）；真实 Windows 窗口与多 DPI 未验收 | [详情 182](acceptance-details/part-09.md#条目-182) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 近期工作栏会话行：单行化与浮层摘要/菜单（2026-10-16） | 限定工程范围通过（jsdom 与真实 Chromium 伪造 API）；真实 Windows 窗口与多 DPI 未验收 | [详情 183](acceptance-details/part-10.md#条目-183) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话视图顶栏密度（2026-10-16） | 限定工程范围通过；真实 Windows 窗口与多 DPI 未复验 | [详情 184](acceptance-details/part-10.md#条目-184) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 目标与目录会话导航（2026-10-16） | 限定工程范围通过；真实 Windows 未复验 | [详情 185](acceptance-details/part-10.md#条目-185) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| V4.3 原型对齐接续：项目接续与无会话空态（2026-10-16） | V43-04/V43-06 通过、V43-05 未实施；仅本表所列范围 | [详情 186](acceptance-details/part-10.md#条目-186) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 前端三页定向整改与 Windows 复验（2026-10-16） | 本轮限定范围通过；V4.3 全部原型对齐仍未完成 | [详情 187](acceptance-details/part-10.md#条目-187) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| V4.3 原型对齐：Windows 定向验收（2026-10-15） | 未通过原型对齐；部分既有读取与追溯链路通过 | [详情 188](acceptance-details/part-10.md#条目-188) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| V4.3 左侧两栏整改（外壳导航，2026-10-15） | 工程验证通过（真实 Chromium 目视与几何实测）；真实 Windows 窗口、多 DPI 未复验 | [详情 189](acceptance-details/part-11.md#条目-189) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 近期工作栏窄列搜索与行密度（2026-10-16） | 工程验证通过（真实 Chromium 四档几何实测）；真实 Windows 窗口、多 DPI 未复验 | [详情 190](acceptance-details/part-11.md#条目-190) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 普通 Agent 连续工具主流程·阶段 A/B/C（2026-10-15） | 阶段 A/B/C 的定向 PG/HTTP/真实文件与前端检查通过；AM-06 的结果投影、阶段 D（前端切换）、真实 Provider 与真实 Windows 未验 | [详情 191](acceptance-details/part-11.md#条目-191) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 工作台 UI 对齐 V4.2 原型（2026-10-14） | 工程验证通过；真实 API 通过；Windows 定向验收通过（含历史种子 v1/v2 正文在真实窗口读出）；安装、多 DPI、IME 未验证 | [详情 192](acceptance-details/part-11.md#条目-192) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 任务链基础修改与检查（2026-10-14） | 所列 PG/HTTP、实际文件与配置子进程、客户端检查通过；完整 N06 未验 | [详情 193](acceptance-details/part-11.md#条目-193) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 任务链基础只读文件与来源（2026-10-14） | 所列 PG/HTTP、真实文件读取与客户端检查通过；完整 N06 未验 | [详情 194](acceptance-details/part-11.md#条目-194) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础有限 Markdown 任务链（2026-10-14） | 所列基础 PG/HTTP/生产模块与客户端通过；完整 N06 未验 | [详情 195](acceptance-details/part-11.md#条目-195) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础一次性继续项目提醒（2026-10-14） | 所列基础 PG/HTTP/真实 API 重开与客户端功能通过；Windows 原生投递未验 | [详情 196](acceptance-details/part-11.md#条目-196) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础固定容量范围推演（2026-10-14） | 所列基础 PG/HTTP 与客户端检查通过；完整收益未验 | [详情 197](acceptance-details/part-11.md#条目-197) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础下一段工作计划（2026-10-14） | 所列基础 PG/HTTP 与客户端检查通过；完整 N04 未验 | [详情 198](acceptance-details/part-11.md#条目-198) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 任务与计划系统 P0–P1 整改复验（2026-10-25） | 部分通过（当前 Agent 分片自检；未独立验收） | [详情 199](acceptance-details/part-11.md#条目-199) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础工作段预期与产出复盘（2026-10-14） | 所列基础 PG/HTTP 与客户端检查通过；实际收益未验 | [详情 200](acceptance-details/part-11.md#条目-200) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础决定前提与复审（2026-10-14） | 所列基础 PG/HTTP 与客户端检查通过 | [详情 201](acceptance-details/part-12.md#条目-201) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础假设记录与用户结论（2026-10-14） | 所列基础 PG/HTTP 与客户端检查通过；真实模型分析未验 | [详情 202](acceptance-details/part-12.md#条目-202) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础会话验收耗时补录（2026-10-14） | 所列基础 PG/HTTP 与客户端检查通过；真实模型解释质量未验 | [详情 203](acceptance-details/part-12.md#条目-203) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础验收试用比较（2026-10-14） | 所列基础前后端数据检查通过；实际收益未验 | [详情 204](acceptance-details/part-12.md#条目-204) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础验收材料与试用记录（2026-10-14） | 所列基础数据功能检查通过；UI 与收益未验 | [详情 205](acceptance-details/part-12.md#条目-205) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础前后端执行组合（2026-10-14） | 所列基础功能检查通过 | [详情 206](acceptance-details/part-12.md#条目-206) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础执行请求接续（2026-10-13） | 所列基础 PG 与前端检查通过；新接续窗口操作未验 | [详情 207](acceptance-details/part-12.md#条目-207) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础执行结果展示（2026-10-13） | 所列定向组件检查通过；新摘要 Windows 文件执行未验 | [详情 208](acceptance-details/part-12.md#条目-208) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 电脑插件常规 Agent 窗口验收（2026-10-13） | 有限窗口操作已恢复；完整常规文件/模型执行仍未验 | [详情 209](acceptance-details/part-12.md#条目-209) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 常规 Agent 主链与检查顺序（2026-10-13） | 所列常规后端功能与真实模型修复闭环通过；产品会话/Windows 总出口未验 | [详情 210](acceptance-details/part-12.md#条目-210) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础聊天命令菜单（2026-10-13） | 菜单实现与定向检查通过；相关浏览器套件保留 1 条既有失败，真实 Windows 未验 | [详情 211](acceptance-details/part-12.md#条目-211) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础会话入口 Windows 验收与修复（2026-10-13） | 所列基础路径与两处显示修复通过；完整业务/Provider/安装出口未验 | [详情 212](acceptance-details/part-12.md#条目-212) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础聊天命令输入（2026-10-13） | 基础输入实现与定向组件检查通过；真实前后端组合/Windows 未验 | [详情 213](acceptance-details/part-12.md#条目-213) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 基础 Agent 后端三个模块（2026-10-13） | 基础实现与所列正常链路通过；真实 Provider/前端命令/完整环境未验 | [详情 214](acceptance-details/part-12.md#条目-214) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 学习模式工作包 C 基础功能（2026-10-13） | 基础实现与所列定向检查通过；完整环境出口未验 | [详情 215](acceptance-details/part-12.md#条目-215) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 当前源码后端独立验收（2026-10-11） | 未通过 | [详情 216](acceptance-details/part-12.md#条目-216) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 学习模式：协议冻结与工作包 A（2026-10-11） | 本片部分通过（工程协议冻结＋记录持久层的真实 PG 出口）；教学轮次、前端入口与转执行未实施 | [详情 217](acceptance-details/part-12.md#条目-217) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 运行时提示词路由统一入口（2026-10-11） | 本片通过（统一入口落地、七类调用接线、模板等价性 45 项核对、单元与真实 PG/HTTP 回归）；Skill/方法消息的两条集成回归被并行工作包的既有缺陷阻塞，按未闭合记录 | [详情 218](acceptance-details/part-12.md#条目-218) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 协作页 UI 结构重塑（2026-10-10） | 本片通过（工程、全量组件测试、全量真实 Chromium 与逐屏结构核对；真实 Windows IME/DPI、全站推广与需真实 API 的两个浏览器 spec 未闭合） | [详情 219](acceptance-details/part-12.md#条目-219) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 自然语言状态维护复验整改与第五节切片（2026-10-10，当前结论） | 六项反例红→绿、定向/单元/前端/真实浏览器组合通过；完整出口仍部分通过：备份恢复环境失败、Windows 组合窗口与部分 Slice B/C 场景未验 | [详情 220](acceptance-details/part-12.md#条目-220) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 响应式收敛回写与 `layout.header.height` 语义澄清（2026-10-10） | 本片通过（工程、档位守卫与真实 Chromium 边界几何；真实 Windows 与全站控件出口仍按前行判未闭合） | [详情 221](acceptance-details/part-12.md#条目-221) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 自然语言状态维护整改独立复验（2026-10-10，当前结论） | 未通过：原反例的正式回归通过，新增决定续答/既有任务/查看身份仍有 6 个独立失败；完整产品定位出口未闭合 | [详情 222](acceptance-details/part-12.md#条目-222) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 自然语言状态维护整改、既有对象与决定续答（2026-10-10，本轮实施） | A/C 整改出口与产品入口切片通过自检与场景复验；外部成果核对/返回轻量检查与组合验收出口未闭合 | [详情 223](acceptance-details/part-13.md#条目-223) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 后端拒绝收口、原任务接续与全量回归（2026-10-10，独立复验） | 拒绝收口与原 Task 接续限定通过；后端整体未通过：全量仍有 5 条未同步断言及 15 条维护占用场景失败，新状态维护缺陷见下行 | [详情 224](acceptance-details/part-13.md#条目-224) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 自然语言维护状态与简化接续（2026-10-10，独立验收） | 未通过：A/C 为有限实现，不能提升为完整状态维护及自动核对；外部进展核对 B、Windows 组合流程 D 未验 | [详情 225](acceptance-details/part-13.md#条目-225) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 自然语言状态维护与自动接续：Slice A/C 实施轮（2026-10-09） | 部分通过（Slice A 对话状态维护与 Slice C 日常接续卡的真实 PG/HTTP/组件工程证据齐全，协调者亲跑复验；外部进展核对（Slice B）未进入，真实 Windows 未验） | [详情 226](acceptance-details/part-13.md#条目-226) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 后端实施后独立复验（2026-10-09） | 材料绑定的已测安全反例通过；后端整体未通过：派发前确定拒绝未闭合原动作/任务状态，真实图链留下悬空等待；全量另有桌面维护占用失败 | [详情 227](acceptance-details/part-13.md#条目-227) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 当前源码后端独立验收（2026-10-08） | 未通过：人工批准未绑定当时的检查材料，2 条真实漂移反例执行了新脚本；全量回归另有验收基建与环境失败 | [详情 228](acceptance-details/part-13.md#条目-228) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 后端整改：批准材料绑定与全量回归收口（2026-10-09 实施轮） | P1 已闭合；后端整体仍未通过：剩余 16 条失败全部集中在需要真实桌面维护会话/连接栅栏的备份恢复族，根因是本机存在非本次自有的运行中桌面实例 | [详情 229](acceptance-details/part-13.md#条目-229) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 草稿继续编辑焦点与无 Run 文案（2026-10-08 实施轮） | 两项修复通过（先红后绿自动化回归＋协调者共享构建）；真实 Windows 复验本轮未做 | [详情 230](acceptance-details/part-13.md#条目-230) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 草稿编辑焦点与无 Run 文案（2026-10-08，电脑插件独立复验） | 两项交互细节待修复；任务创建与条件追加的限定业务通过 | [详情 231](acceptance-details/part-13.md#条目-231) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 控件基座与响应式收敛（2026-10-08，前轮） | 部分通过（工程、运行时色对与限定浏览器控件通过；完整 Windows 控件出口未验） | [详情 232](acceptance-details/part-13.md#条目-232) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 环境配置材料核对与真实业务验收（2026-10-08 前次独立复验；本次电脑插件接续） | 限定范围通过：环境文件材料、正式 PG 回归、前端工程与真实 API/PG 四组业务通过；Windows 页面与窄短窗通过；本次窄窗新对话入口可发现性待优化，完整桌面业务与安装未验 | [详情 233](acceptance-details/part-13.md#条目-233) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 当前桌面产物与窄窗新对话入口（2026-10-08 实施与构建；电脑插件复验） | 限定范围通过（当前release真实Windows新对话、草稿保护、原生目录与同会话归属）；整体出口未闭合 | [详情 234](acceptance-details/part-13.md#条目-234) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 任务详情验收依据阅读与页头技术信息（2026-10-08 前轮独立复验） | 本片通过（工程与限定真实 Windows 路径）；真实会话/控制与安装总出口未完成 | [详情 235](acceptance-details/part-13.md#条目-235) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 检查入口信任摘要：终止符修复与环境文件材料（2026-10-08 前轮独立复验） | 前轮材料信任未通过（本轮已闭合，见上行；保留环境文件读取漏算的历史证据）；原终止符修复的正式单元通过，真实PG出口该轮未取得 | [详情 236](acceptance-details/part-13.md#条目-236) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 前端同会话归属与工具事实缺口（2026-10-07 实施，2026-10-08 独立复验） | 通过旧两项缺陷的定向组件回归；真实桌面业务闭环未验收 | [详情 237](acceptance-details/part-13.md#条目-237) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Windows 有数据人工创建与条件追加（2026-10-07） | 已通过所列真实窗口路径；桌面业务与安装总出口仍未完成 | [详情 238](acceptance-details/part-13.md#条目-238) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Windows 页面第二轮整改（2026-10-07） | 两项整改通过（工程自检、协调独立回归及限定 Windows 复验） | [详情 239](acceptance-details/part-13.md#条目-239) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 真实 Windows 页面巡检及限定整改（2026-10-07） | 四类问题当轮整改通过；后续第二轮复验见本表第二轮行 | [详情 240](acceptance-details/part-13.md#条目-240) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 首装空态（2026-10-06） | 当轮部分通过；后续 Windows 局部复验见本表页面巡检行 | [详情 241](acceptance-details/part-14.md#条目-241) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 工作台 API client 分层与传输层加固（2026-10-07 独立复核） | 部分通过（两端 typecheck 通过、前端全量 752/755）；parse 层定向测试缺失、真 bug 已修；CLI_RUN UI 后续修复见本表第二轮行 | [详情 242](acceptance-details/part-14.md#条目-242) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话模式与人设助手（2026-10-05） | 当轮后端与 jsdom 已通过；后续首条空态 Windows 局部复验见本表页面巡检行，真实业务路径仍未验收 | [详情 243](acceptance-details/part-14.md#条目-243) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 传统 Agent 检查失败后的自主修正（2026-10-05） | 已通过本片后端工程与定向真实 Provider 出口；指定模型只读独立复核通过；真实 Windows 未验收 | [详情 244](acceptance-details/part-14.md#条目-244) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 新对话直接起步（2026-10-05 接续） | 已通过（当前前端工程与限定独立复验）；真实 Windows 未验收 | [详情 245](acceptance-details/part-14.md#条目-245) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M06 人工触发的受管 Git 只读入口（2026-10-05） | 部分通过（工程自检与真实 PG/HTTP 出口）；前端源码已接；崩溃恢复与独立验收未做 | [详情 246](acceptance-details/part-14.md#条目-246) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 创建后人工补验收条件（2026-10-05） | 部分通过（服务端出口已闭合并有真实 PG 证据）；前端源码已接，真实窗口与独立验收仍缺 | [详情 247](acceptance-details/part-14.md#条目-247) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 有界多 Agent 与自动主子会话 | 未接入；未验收 | [详情 248](acceptance-details/part-14.md#条目-248) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 单 Agent 依赖门：写路径的停止、预算与重启复核（2026-10-05） | 已通过（工程自检与回归）；独立复核与真实 Windows 人工路径未做 | [详情 249](acceptance-details/part-14.md#条目-249) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 目标/任务轻量起步与状态接续（2026-10-04） | 部分通过（Goal 轻量创建、Goal↔Project 关联、Task 轻量起步三项入口已实施并复验；默认入口未切换、状态接续与多轮来源整理仍未做） | [详情 250](acceptance-details/part-14.md#条目-250) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 本地功能地图与资料导航（2026-10-04） | 已通过（本机导航、索引与更新范围）；下载交互待验 | [详情 251](acceptance-details/part-14.md#条目-251) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 内部文件/Git 工具循环 B 片：范围授权与已配置检查（2026-10-04） | 部分通过（A/B 片开发自检与回归通过）；C 片与产品入口未接入 | [详情 252](acceptance-details/part-14.md#条目-252) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 读写主链与写能力开关（2026-10-05） | 读写闭环已通过（真实 Provider + 真实磁盘 1/1，真实 PG/磁盘 6/6）；协作页轨迹呈现与真实 Windows 人工路径未验 | [详情 253](acceptance-details/part-14.md#条目-253) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 内部文件/Git 工具循环 A 片（2026-10-04 修复复验） | A 片开发自检通过并修复独立验收的 7 项发现；B/C 未接入 | [详情 254](acceptance-details/part-14.md#条目-254) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 协作页工具轨迹呈现（C 片，2026-10-05） | 部分通过（工程自检与回归通过）；真实浏览器、Windows 与独立复核未做 | [详情 255](acceptance-details/part-14.md#条目-255) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 真实 Provider 工具循环首次跑通（2026-10-04） | 已通过（真实 Provider 定向验证）；预览清空、preamble 持久化与产品入口未做 | [详情 256](acceptance-details/part-15.md#条目-256) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 内部文件/Git 工具循环 A 片独立验收（2026-10-03） | 未通过（3 项 P1、4 项 P2）；B/C 未接入 | [详情 257](acceptance-details/part-15.md#条目-257) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话内可折叠执行计划（2026-10-03） | 未接入 | [详情 258](acceptance-details/part-15.md#条目-258) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 方案 2 整改后独立复核（2026-10-03） | 未通过（恢复与作用域仍有缺口）；四类缺口已于 2026-10-04 修复并自检复验，独立验收仍缺 | [详情 259](acceptance-details/part-15.md#条目-259) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 产品 Agent 公共提示词运行接入（2026-10-03） | 已通过（源码/工程接线）；真实模型质量未验收 | [详情 260](acceptance-details/part-15.md#条目-260) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| F24 第一方 Skill / Blueprint / Pack 接续复验（2026-10-03 跨候选修复轮） | 部分通过（本轮幂等修复已独立验收；真实模型质量与 Windows 待验） | [详情 261](acceptance-details/part-15.md#条目-261) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| root-bound 能力配置入口（2026-10-02） | 已通过（配置入口范围）；Git 只读已接，写侧与 CLI 仍未接入 | [详情 262](acceptance-details/part-15.md#条目-262) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| N03 项目知识整理后端首片（2026-10-02） | 部分通过（工程自检；独立验收 P1/P2 已修复复跑） | [详情 263](acceptance-details/part-15.md#条目-263) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 消息队列顺序确定性（2026-10-04，方案 A） | 未验收（实现完成，验证被并行 Agent 的编译错误阻塞） | [详情 264](acceptance-details/part-15.md#条目-264) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 标题栏常用操作回到左侧（2026-10-05） | 未验收（开发自检通过；真实 Windows 窗口未验） | [详情 265](acceptance-details/part-15.md#条目-265) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Trace 500：桌面库停在 0048 而代码需要 0049+（2026-10-02） | 已修复并复验（工程范围） | [详情 266](acceptance-details/part-15.md#条目-266) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| N00–N02 后续长期协作首轮（2026-10-02） | 部分通过（N01/N02 工程自检通过；N02 独立验收 CHANGES_REQUESTED 的唯一阻塞项已修复复跑；N00 基线未测） | [详情 267](acceptance-details/part-15.md#条目-267) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 「+」两级上下文菜单与二级能力入口（2026-10-16） | 已通过（本地工程范围；真实 Windows 窗口、DPI、浏览器层与真实模型未验） | [详情 268](acceptance-details/part-15.md#条目-268) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Goal 工作空间级列表与跨项目反向读（2026-10-01） | 已通过（仅两个只读 HTTP 端点） | [详情 269](acceptance-details/part-15.md#条目-269) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 远程仓库凭据与隐私审计（2026-10-01） | 已通过（无真实凭据；两项历史隐私项已知并保留） | [详情 270](acceptance-details/part-15.md#条目-270) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 连续工作区真实 Windows 页面独立复核（2026-10-01） | 部分通过（代表页面与基础交互通过） | [详情 271](acceptance-details/part-15.md#条目-271) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| DesktopDev 单实例退出23提示与本机启动接续（2026-10-01） | 已通过（守卫与当前启动范围） | [详情 272](acceptance-details/part-15.md#条目-272) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 连续工作区的隔离目录测试包与能力门（2026-10-01） | 已通过（目录身份与所列检查） | [详情 273](acceptance-details/part-15.md#条目-273) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 连续协作工作区与七类页面层级（2026-10-01 接续） | 部分通过（组件与只读浏览器范围通过） | [详情 274](acceptance-details/part-15.md#条目-274) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 最新 UI 的 DesktopDev 真实窗口只读验收（2026-10-01） | 部分通过（首轮布局失败已在最大化范围修复复验） | [详情 275](acceptance-details/part-15.md#条目-275) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 协作工作区与共享页壳结构对齐（2026-10-01 接续 §17.7） | 部分通过（浏览器与组件范围通过；全量回归被并行改动阻断） | [详情 276](acceptance-details/part-15.md#条目-276) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 普通页面标题与区域标题字号对齐（2026-10-01） | 部分通过（浏览器与 token 层通过） | [详情 277](acceptance-details/part-16.md#条目-277) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 全局控件与交互基线、最大化修复（2026-10-01） | 部分通过（共享规则及所涉最大化样本通过） | [详情 278](acceptance-details/part-16.md#条目-278) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 用户五图控件反馈修复（2026-10-01） | 已通过（所列五处最大化样本） | [详情 279](acceptance-details/part-16.md#条目-279) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 整套 UI 重做与交互覆盖（2026-10-01） | 部分通过（组件/浏览器视觉） | [详情 280](acceptance-details/part-16.md#条目-280) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M04 文件/网页读取委托 UI | 已通过（组件＋确切包 Windows 读取） | [详情 281](acceptance-details/part-16.md#条目-281) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 人工项目/任务/产物/完成与重开 | 已通过（基础链） | [详情 282](acceptance-details/part-16.md#条目-282) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Mock Delegate→Review→完成/重启恢复 | 已通过（基础链） | [详情 283](acceptance-details/part-16.md#条目-283) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Mock 完整并发、取消、UNKNOWN 可靠性 | 已通过（有限 Mock 基准） | [详情 284](acceptance-details/part-16.md#条目-284) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Mock 文件动作输入与原委托载荷 | 已通过（组件＋冻结包 Windows） | [详情 285](acceptance-details/part-16.md#条目-285) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M03 本轮冻结包与桌面验收入口 | 已通过（确切包范围） | [详情 286](acceptance-details/part-16.md#条目-286) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Windows 产物续版、接受、重开与关闭 | 已通过（冻结包人工链） | [详情 287](acceptance-details/part-16.md#条目-287) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Windows 同页 SSE 断线重连 | 已通过（冻结包同页） | [详情 288](acceptance-details/part-16.md#条目-288) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 模型连接验证与配置保留 | 已通过（定向） | [详情 289](acceptance-details/part-16.md#条目-289) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 真实 DRAFT、HARD SEMANTIC、取消/abort | 已通过（定向） | [详情 290](acceptance-details/part-16.md#条目-290) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M04 原调用首文本与首预览持久计时 | 已通过（开发自检＋独立回归） | [详情 291](acceptance-details/part-16.md#条目-291) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M04 真实 Provider 与 Windows 协作定向闭环 | 已通过（确切冻结包） | [详情 292](acceptance-details/part-16.md#条目-292) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Provider 六类错误的真实故障矩阵 | 未验收（真实服务）；受控链已通过 | [详情 293](acceptance-details/part-16.md#条目-293) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M04 模型原生工具参数的能力拒绝与证据保全 | 已通过（受控 SDK/PG/API） | [详情 294](acceptance-details/part-16.md#条目-294) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M04 Files/Web→真实模型→人工完成 | 已通过（隔离 PG/HTTP 图组合） | [详情 295](acceptance-details/part-16.md#条目-295) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M04 首批三个 Skill 的真实模型组合 | 已通过（确切包 Windows 定向）；稳定性/质量未验 | [详情 296](acceptance-details/part-16.md#条目-296) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Assist/Run 调用诊断与取消归因 | 已通过（增量） | [详情 297](acceptance-details/part-16.md#条目-297) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Agent 聊天发送、导航保护与 Mock 回复 | 已通过（开发版基础链） | [详情 298](acceptance-details/part-16.md#条目-298) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 协作工作区的导航与任务入口 | 已通过（开发版导航） | [详情 299](acceptance-details/part-16.md#条目-299) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 最新协作页视觉与 Review 状态/草稿 | 部分通过 | [详情 300](acceptance-details/part-16.md#条目-300) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 全页面视觉/故障状态覆盖 | 部分通过；本轮重点整改复验通过 | [详情 301](acceptance-details/part-16.md#条目-301) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 目录测试包的输入/资源完整性 | 已通过（记录时点静态范围） | [详情 302](acceptance-details/part-16.md#条目-302) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Today/三套工作台/知识/Trace/Lineage | 已实现待总验收 | [详情 303](acceptance-details/part-16.md#条目-303) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 项目归档与关联写入栅栏 | 已实现待总验收 | [详情 304](acceptance-details/part-16.md#条目-304) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 文件/Git/CLI 与 UNKNOWN/PARTIAL 人工处置 | 部分通过 | [详情 305](acceptance-details/part-16.md#条目-305) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Git 状态/diff 的协作 UI | 未接入 | [详情 306](acceptance-details/part-16.md#条目-306) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 交互终端 / PDF 导入 | 未接入 | [详情 307](acceptance-details/part-16.md#条目-307) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 菜单 6 桌面开发启动 | 已通过（真实 Windows 窗口 + 真实隔离 PG）；安装验收仍未做 | [详情 308](acceptance-details/part-16.md#条目-308) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Windows DPI/IME 与最新 UI | 部分通过 | [详情 309](acceptance-details/part-16.md#条目-309) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 冷启动/反馈与首输出延迟 | 部分通过 | [详情 310](acceptance-details/part-16.md#条目-310) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M07 数据库维护准入与原工作排空兼容 | 已通过（源码 PG/CLI 首片） | [详情 311](acceptance-details/part-16.md#条目-311) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M07 当前 Windows 会话原宿主停机与持续持锁 | 已通过（源码/debug 原生及 Node 管道） | [详情 312](acceptance-details/part-16.md#条目-312) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M07 Windows 实际受管内容发布与排他安全点 | 已通过（源码/真实原生与 PG 分片） | [详情 313](acceptance-details/part-16.md#条目-313) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M07 本库 CONNECT/DDL锁与权限恢复机制探针 | 已通过（隔离PG机制，非产品备份） | [详情 314](acceptance-details/part-16.md#条目-314) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M07 生产数据库连接维护与原ACL恢复 | 已通过（源码/真实PG与CLI分片） | [详情 315](acceptance-details/part-16.md#条目-315) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M07 受管文件清单与原包历史定义保留 | 已通过（Windows源码内部入口/包fixture） | [详情 316](acceptance-details/part-16.md#条目-316) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M07 PostgreSQL完整归档机制 | 已通过（源码/真实PG分片） | [详情 317](acceptance-details/part-16.md#条目-317) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M07完整备份协调与历史未决身份 | 已通过（源码/Windows与PG组合范围） | [详情 318](acceptance-details/part-16.md#条目-318) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M07恢复目标启动前隔离与包能力诊断 | 已通过（源码/真实Node入口与Rust分片） | [详情 319](acceptance-details/part-16.md#条目-319) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M07新空库与新数据根隔离还原 | 已通过（Windows/PG源码隔离组合范围） | [详情 320](acceptance-details/part-16.md#条目-320) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M07非空恢复目标的业务只读维护核对 | 已通过（冻结Windows/PG源码范围） | [详情 321](acceptance-details/part-17.md#条目-321) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M07维护数据库连接参数隔离 | 已通过（冻结Windows/PG源码范围） | [详情 322](acceptance-details/part-17.md#条目-322) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M07目标包离线依赖加载与有限调用 | 已通过（冻结Windows/PG源码有限范围） | [详情 323](acceptance-details/part-17.md#条目-323) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| M07受管资源根身份有限观察 | 自检通过；独立验收待补 | [详情 324](acceptance-details/part-17.md#条目-324) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 计划执行方式：生成计划后自动执行还是人工确认（2026-10-18，用户指令） | 部分通过（jsdom 定向 55/55；真实 API/PG 与 Windows 窗口未取证） | [详情 325](acceptance-details/part-17.md#条目-325) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| 会话行菜单：删除确认改就地浮层、未读行强调（2026-10-19，用户截图指令「删除这段讨论改成删除」「这个弹窗改成这样的简单弹窗」「标记为未读之后会话 item 没有 ui 上的变化需要加上变化」） | 通过（限定工程范围：jsdom 19/19＋headless Chromium 定向 2/2＋tsc 无本改动报错）；真实 WebView2 窗口与多 DPI 未复验 | [详情 326](acceptance-details/part-17.md#条目-326) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |
| Windows 安装/升级/卸载/备份恢复及 V1 总交付 | 未验收 | [详情 327](acceptance-details/part-17.md#条目-327) | 具体限制见同条详情的「剩余项」，摘要不替代原记录 |

| 正式目标管理与项目状态写入最终整改（2026-10-27） | **BLOCKED（自动化分层自检通过，最新源码与桌面验收未闭合）**：Workbench 14 个 Vitest 文件 137/137、typecheck/build 通过，真实 Chromium 14/14；9 组真实 PG/HTTP 58/58（迁移至 0143，覆盖双 Project Goal 主链）。随后并行 API 源码持续变化，release 构建因输入指纹变化中止；最新快照稳定性未确认 | [详情 011](acceptance-details/part-01.md#条目-011) | 当前源码 API/PG 需在并行改动停稳后复跑；最新源码 Windows/WebView2、干净 HEAD 构建、独立验收未完成。另一工作树持有单实例锁；六枚图标仍仅为暂存新增 |

## 原始输出归档

按需查看[原始输出入口](acceptance-details/part-17.md#原始输出归档)，保留原路径与证据限制。

## 历史验收记录

原小节和标题完整迁入[历史验收记录](acceptance-details/part-17.md#历史验收记录)，旧记录不自动覆盖后续改动。
