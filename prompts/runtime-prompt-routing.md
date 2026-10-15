# 运行时提示词路由：并行实施任务书

日期：2026-10-11。用途：交给能访问 `D:/Develop/Relay-Agent` 的开发 Agent。状态：**已实施**（2026-10-11）：`apps/api/src/workflow/prompts/` 统一入口 `selectRuntimePrompt()` 与三个按职责分组的模板模块已落地，application 与模型端口侧七类调用已接线，模板正文单一来源，未新增依赖、API 或 migration。范围、实际验证结果与未闭合项归 [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)，运行时路由事实归[提示词设计 §2.1–2.3](../docs/architecture/agent-prompt-design.md#21-当前运行时提示词路由)。

现状、触发条件、组合与版本归[提示词设计 §2.1–2.3](../docs/architecture/agent-prompt-design.md#21-当前运行时提示词路由)。本文件只拥有实施范围、子代理分工和验收出口，不另维护一份路由事实表。

可将下方完整任务交给开发 Agent，或让它读取本文件后执行。

~~~text
你在 D:/Develop/Relay-Agent 工作。所有说明、进度和交付使用中文；代码标识符与 commit message 使用英文。

把当前“运行时提示词路由表”落成真实代码：建立有限、类型化的统一模板选择与组合入口，将现有调用迁到该入口，保留原有业务行为和协议。主 Agent 负责统一接口、接线、集成和独立复验；实际派发多个子代理，并让至少两个互不写同一文件的开发任务同时运行。不要只交付设计、伪代码或空注册表。

一、授权和目标

实际下发本任务，授权本专项所需的只读调查、最小代码修改、相关测试、构建、修复与文档维护；常规可逆工作直接推进。当前这份任务书的编写本身不表示已经启动开发。

本次交付应做到：
1. 可通过统一代码入口核对本次选择的路由、实际模板及适用版本；已有模型调用真正消费该入口返回的文本。
2. 现有场景的最终 system/user 消息、公共核心次数、Markdown/JSON 输出协议、工具声明和权限边界保持等价。
3. 原消息、冻结 Skill/方法、Task/Run、审批、控制、UNKNOWN、账本与完成 Owner 不因路由集中而改变。
4. 模板正文只有一处维护；现有文档路由表与实际代码一致；子代理自检后由主 Agent 在集成源码上独立复验。

本范围只集中现有提示词。不要自动实施 prompts/ 下的其他任务书；不要新增产品多 Agent Router、动态插件、任意 SKILL.md 加载、模型语义路由、通用 DSL、第二 Runtime、UI 配置页或新的上下文协议。开发子代理用于完成本次工程任务，不等于 Relay 产品获得多 Agent 功能。

不自动 commit/push、merge/deploy，不停用户正在使用的桌面或服务，不删除用户数据，不外发项目材料，不创建新的用户聊天或长期自动化。真实 Provider 验证需遵守执行时既有放行、合法来源与预算，路由重构不自动授权付费外呼。没有必要时不增加依赖、API 或 migration。

二、开工核对

先读以下入口，按涉及内容展开，不从历史提示词推断当前授权和完成状态：
- AGENTS.md、CODEX_NEXT_STEP.md、docs/README.md。
- docs/architecture/agent-prompt-design.md §2.1–2.3；第 3 节是职责草案，不能全部当作已实现功能。
- docs/testing/overall-acceptance-2026-09-28.md 的当前功能验收表。
- contracts/01-facts-and-ownership.md、02-state-and-execution.md、03-verification-and-approval.md、04-recovery-and-commit.md 的相关约束。
- docs/architecture/复用策略.md、docs/decisions/ADR-005-reuse-first.md，以及本范围涉及的 Skill/Runtime 规则。

检查 git status 和当前源码，记录待改文件的初始改动；同一工作区有其他任务在途。不要 reset/stash/clean 掩盖冲突，不覆盖别人的未提交修改，不批量格式化无关文件。需要共享文件时由主 Agent 统一改动，不能以子任务名义抢写。

重新核对真实入口：
- apps/api/src/workflow/agent-system-prompt.ts。
- application/assist-runner.ts、assist-commands.ts、assistant-readonly-round.ts、learning-round.ts。
- application/conversation-execution.ts、conversation-state.ts。
- workflow/openai-compatible-model-port.ts、model-port-verify.ts、fake-model-port.ts。
- skills/first-party-registry.ts、builtin-methods.ts；application/method-intent.ts、chat-commands.ts。
- workflow/checkers.ts、application/model-port-verification.ts。

说明当前已实现内容、差距、允许修改范围、并行所有权与成功条件。已有路由或模板提取若在执行时已经落地，接续真实缺口，不按本文件重建覆盖。

三、先冻结最小接口，再并行开发

主 Agent 先确定模板层、统一选择入口和调用方的职责。优先使用纯函数、封闭的类型化输入和有限分支；不为这项工作引入外部模板框架或动态配置系统。

建议在 workflow 下设一个统一入口和少量按职责分组的模板模块。文件名可以按当前仓库风格调整；一旦冻结，所有 Agent 按同一接口工作，不各建一套路由器。输入复用现有类型，避免为了统一而把无关调用压成一个宽泛 JSON 对象。

统一入口应接收当前调用已经确定的场景及必要数据，负责确定性选模板、组合文本和返回可核对的本次元数据。原应用用例仍负责查当前事实、校验/冻结 Skill 与方法、来源选择、权限、事务、调用预算和结果结算。路由器不得访问数据库、创建任务、发起模型调用或给工具准入。

首批元数据只保留实际使用的路由标识、专用模板版本、公共核心版本等必要内容。system 模板与连接验证的 user 探针应有清楚的类型区别；不要把验证探针变成 system 消息。为新登记模板定义版本时，明确适用起点；原公共核心及 Skill/方法版本继续保持原值。现有历史调用没有记录组合版本的地方保持未知，不倒填、不声称完整审计已经实现。本次不默认新增持久化或改调用账本。

提取模板必须说明谁返回“专用规则”，谁返回“最终 system”；二者不能含糊。所有需要公共核心的路径只能出现一次核心，语义检查和连接验证维持各自协议。优先保持最终文字、顺序和换行等价，避免借重构顺便改写提示词行为或破坏缓存前缀。

完成输入/输出契约、所有权表和必要基线核对后，马上真实派发 A/B，不能一直停在规划。

四、子代理派发与文件所有权

所有开发、调查和审查子代理统一使用 gpt-6.1-sol。派发工具支持 model 参数时必须显式填写 model: "gpt-6.1-sol"；不要选择锁定其他模型的角色。若指定模型不可用，报告实际限制，先完成不依赖派发的核对工作；不得换模型、虚构成功或将串行工作称作并行。

默认同时活跃为“主 Agent + 两个子代理”。若环境允许更多且确有独立文件边界，可以同时派发第三个工作包；若总并发上限为 3，则第一波 A/B 并行，第二波复用完成的子代理执行 C。始终遵守真实上限，不要求超额派发，也不把 A 完成后才启动 B 算作首波并行。

每次派发须给出：具体目标、只读输入、允许写入文件、禁止写入文件、已冻结接口、验证场景、交接格式和停止条件，并明确告诉子代理：
“你不是唯一在代码库中工作的 Agent。保留其他人的修改，不回退、不覆盖他人工作；发现共享文件变化时适配最新事实，需改所有权之外的文件时先交给主 Agent 协调。”

工作包 A：会话模板提取。
- 独占一个新增会话模板模块，例如 workflow/prompts/conversation-prompts.ts，以及对应的新增单元测试文件。
- 提取普通 Assist 五种 intent、第一方 Skill、内置方法、只读人设助手和学习搭档的模板构造。
- 只读原 assist-runner、assistant-readonly-round、learning-round、Skill/方法注册表，不修改原业务文件和公共核心。
- 保留 Skill ID/版本对应的输出分支、INSPECT/MODIFY 规则、人设/学习数据标记及所在消息位置。
- 验证各模板核心只出现一次、输出协议相同、动态数据不改变模板选择；交付可被主 Agent 导入的实际实现。

工作包 B：Run、验收与验证探针模板提取。
- 独占一个新增模块，例如 workflow/prompts/run-prompts.ts，以及对应的新增单元测试文件。
- 提取 DRAFT 无工具、只读工具、含 apply_changeset 三条分支；独立语义验收提示词；连接验证的固定 user 探针。
- 只读 openai-compatible-model-port、model-port-verify 和 checkers；不修改实际 SDK 调用、流式处理、工具结果协议、端口配置与原测试文件。
- 验证 DRAFT 选择来自实际工具清单，Semantic 不含公共核心，VERIFY 仍只有原 user 文本；候选输出要求保持原值。

工作包 C：两类解释模板提取，按可用槽位执行。
- 独占一个新增模块，例如 workflow/prompts/interpretation-prompts.ts，以及对应的新增单元测试文件。
- 提取 INTERPRETATION_SYSTEM_PROMPT 与 STATE_MAINTENANCE_SYSTEM_PROMPT。
- 只读 conversation-execution/conversation-state，不改原文件、业务候选、状态写入、回执、撤回和恢复规则。
- 保留 DISCUSS/CLARIFY/PREPARE 与 DISCUSS/CLARIFY/MAINTAIN 两套不同输出，原请求与上下文的边界及缺信息处理。

主 Agent 独占：
- 统一路由入口、公共路由类型/登记元数据及其测试。
- 所有原调用文件的接线，包括 assist-runner、assistant-readonly-round、learning-round、conversation-execution、conversation-state、OpenAI 端口和连接验证调用入口。
- 原有共享测试文件、重复模板删除、兼容导出、文档与功能地图目录的必要更新。
- 集成编译、相关 PG/HTTP 回归、独立审查和问题闭合。

主 Agent 可以在 A/B 并行时实现共享入口与测试骨架，但不能编辑子代理负责的模板文件。子代理不修改共享文档、不抢迁移序号、不自己复制新公共核心。发现接口不够用先反馈，由主 Agent改一处契约再通知所有相关子代理。

每个子代理交付：改动文件、实际导出接口、覆盖分支、运行命令/退出码、失败原因、遗留事项。临时编译输出用独立目录；数据库、端口和临时资源独立，不并发覆盖同一个 dist 或测试库。等待真实任务状态，不能只依据一句“完成”集成。

五、迁移时必须保留的行为

1. 会话模式优先：ASSISTANT/LEARNING 提前分流，不能进入普通 AGENT 的 Skill/方法/提案模板；普通 AGENT 保留冻结 Skill → 冻结方法 → AssistIntent 的顺序和互斥约束。
2. 方法绑定仍由原入口负责：/方法命令 → method_ref → 未显式选择时的自然语言识别；“讨论方法不绑定”只适用于自然语言识别分支，不顺便覆盖显式绑定。
3. 路由只消费已核对的冻结定义，不按 ID 查最新版本，不替换历史版本或重算冻结摘要；未知/不可用身份沿原错误出口处理，不回落到权限更大的模板。
4. 保留 DISCUSS、IMPACT_CHECK、IMPACT_CANDIDATE、PROPOSE_CANDIDATE、PROPOSE_TASK 的协议与作用域约束；新内部路由输入必须穷尽合法类型，未知值明确拒绝，不让任务提案默认分支吞掉未知值。
5. 只读助手的冻结人设、当前只读词表交集、学习的短状态/材料、{answer,increments} 信封与记录开关保持现有语义。不要调整学习计量、隐私清除或迟到结果处理。
6. DRAFT 根据本次实际工具清单选择模板；只读清单和含 apply_changeset 的清单不能串用。工具声明、冻结信封和 Gateway 准入仍是独立检查。
7. 请求解释只整理原目标和路径，不伪造文件正文；状态解释用当前指令与已标注上下文解析对象，候选写入仍归原 Owner。interpret() 不新增模型判断“选择哪个路由”的调用。
8. Semantic 保持独立窄提示词、PASS/FAIL/UNCERTAIN 和验证器故障语义，不加载执行者公共核心；VERIFY 仍是固定 user 探针。
9. 日常接续/返回核对仍为确定性投影，不为统一路由额外调用模型。普通 Assist 的未声明工具请求、两类解释的澄清回落、学习非法信封保留正文不写增量等失败出口保持一致。
10. 原引用和依赖若需要兼容导出，可以保留单一来源的再导出；不能保留两份可分别修改的正文，也不能由 workflow 反向导入 application 的运行实现形成循环依赖。

六、验证和独立复验

先用当前实际源码/模型请求捕获建立行为基线，再提取和接线。不要用历史 HEAD 代替当前未提交源码，不以改过的模板生成“旧期望”证明等价，不删除失败断言。发现真正已有缺陷，记录并区分本次引入或既有问题，不顺手扩到其他专项。

单元与端口层至少覆盖：
- 两种会话提前分流，普通 AGENT 的冻结 Skill/方法/五种 intent；未知路由及必要参数缺失。
- Skill 与方法冻结版本和各输出分支，不可用定义保持原失败；显式方法与自然语言讨论的不同选择语义。
- DRAFT 三个工具分支，公共核心恰好一次，Semantic/VERIFY 核心为零，VERIFY user 角色保持原样。
- 原执行解释与状态维护解释不同 schema；只读助手边界和学习信封。
- 对最终发给 Provider Adapter 的消息进行检查，比较重构前后 system/user/工具声明及流式/JSON 设置，而不只断言 routeId 字符串。

优先复用/扩展现有 agent-runtime-prompts、openai-compatible-model-port、openai-read-prompt、first-party-skills、builtin-methods、assistant-readonly-round、conversation-execution、conversation-state、learning-envelope、model-port-verify 等相关单元测试。测试应覆盖路由行为、错误和边界，不为每条文本写只复述实现的断言。

主 Agent 在集成后的最终源码独立运行类型检查、构建、相关单元/端口测试；按受影响入口运行现有 assist、chat-commands、assistant-readonly-round、learning-round、conversation-state 等必要真实 PostgreSQL/HTTP 回归。集成脚本的套件筛选和隔离参数以当前 apps/api/scripts/run-integration.ps1 为准，先读再用，不猜参数、不共用他人的测试数据库。纯提示词集中无需新增业务 migration，但相关调用接线不能只靠模板快照证明。

项目现有入口包括：
- pnpm --filter @relay-agent/api run typecheck
- pnpm --filter @relay-agent/api run build
- apps/api/package.json 中的 test / test:integration 及现有定向执行方式
- node scripts/check-docs.mjs
- git diff --check（明确区分本轮与原有工作区问题）

子代理自检不等于独立验收。主 Agent 复跑必要检查并审阅实际调用迁移；遇红灯据真实输出修复、复验。先确认编译产物是当前源码，不拿旧 dist 结果代替。已通过后只在新改动、失败或具体疑点要求时追加检查，避免无意义反复全量执行。

真实 Provider/Windows 没有实际运行就标明未验证；不把离线请求捕获或 PG 回归说成真实模型质量、桌面或安装验收。无本专项真实外呼授权时用现有可控端口覆盖模型消息，不以缺付费调用为由跳过本地实现和必要检查。

七、文档同步与收尾

以已有 docs/architecture/agent-prompt-design.md §2.1–2.3 为路由事实入口：更新“集中描述但无代码入口”等已失效表述、实际模块/调用路径、元数据/版本起点和剩余限制。模板正文仍只维护于源码。必要时调整 docs/README.md、prompts/README.md 与 docs/feature-map/catalog.json 的原关联，不新增第二份路由表。

当前阶段只归 CODEX_NEXT_STEP.md，实际验证只归统一功能验收表的受影响行；不要另建逐轮验收报告或复制全量日志。重要架构取舍确需 ADR 时记录真实理由与影响，不为模板文件移动虚构架构历史。明确 Breaking Change 与兼容方式；无 API/数据库变化则如实注明。

执行 Documentation Impact Check，只更新确实受影响的需求、架构、ADR、API、数据库、开发/测试说明、README、路线图/变更记录/已知问题入口；不为齐全创建空文档。运行文档检查并人工核对当前/历史范围。

最终报告：
1. 统一入口和已接入场景，真实并行的子代理分工。
2. 修改文件及必要设计理由，冻结身份/版本和原协议如何保留。
3. 主 Agent 独立运行的命令、退出码、通过/失败范围与基准限制。
4. 已同步文档、剩余缺口、未运行的真实 Provider/Windows 检查。

完成条件是现有调用真实接入、行为/边界回归通过、文档一致。不要把路由注册表存在、子代理自报通过或“以后再接线”当完成；常规可逆修复继续到本范围闭合。
~~~
