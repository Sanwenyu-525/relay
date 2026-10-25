# Relay Agent：提示词与输入协议设计

日期：2026-10-03。角色：产品 Agent 提示词与输入协议的设计说明；本文件不被运行程序加载。状态：**协作原则已确认，公共核心与现有入口已接入源码；完整目标协议的剩余增量为 Proposed，真实模型行为评价未运行。**

位置约定：本文件在 `docs/architecture/` 解释分层、边界和设计取舍。运行核心由 `apps/api/src/workflow/agent-system-prompt.ts` 维护，现有调用入口追加专用规则；根目录 `prompts/` 按其已有约定维护给编码 Agent 的实施任务。设计中的目标数据示意不是运行时配置，不直接把整份文档发送给模型。

用户确认的角色、自主范围和跨任务边界归[产品总纲 §0.6](../../Personal_Workflow_OS_Master_Spec.md#06-agent-协作行为2026-10-03已确认设计)。本文覆盖系统提示词、模式、动态上下文、Skill、工具、输出和追溯；不修改 Task/Run/Review/Gateway 的 Owner。运行机制见[Runtime 专题](runtime-context.md)，评价规格归[测试计划 §18](../testing/verification-plan.md#18-agent-提示词与输入协议评价目标设计)。当前功能状态仍只看[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

## 1. 组成与信任边界

推荐维护一个公共核心，按本次调用追加工作模式与输出约束。统一身份不要求合并对话、执行、验证或人工判断的职责，也不新增多 Agent Router。

| 部分 | 写什么 | 来源与边界 |
|---|---|---|
| 公共核心 | 身份、协作方式、自主边界、事实与证据原则 | 随应用版本交付的固定指令；不插入文件、用户或网页正文 |
| 模式与输出协议 | 本次是讨论、规划、生成候选、检查还是接续；允许输出什么 | 应用按调用入口选择固定模板；模型不能自行取得执行权 |
| 当前运行事实 | Project/Task/Run、版本、目录作用域、控制请求、未决动作、能力与预算 | Owner 查询产生投影；字段仍是数据，不成为模型可改写的状态 |
| 用户请求与项目约定 | 原用户意图、已确认的偏好、适用规则 | 请求有身份与来源；用户可提出目标和调整要求，不能靠文字关闭平台约束 |
| Skill | 一项工作的方法、所需输入、输出及停止条件 | 已审查的固定定义与版本；能力声明不能授予权限 |
| 资料与工具结果 | 正文、片段、引用、读取结果与截断信息 | 带确切来源的外部数据；不能下令、授权或替代业务回执 |

消息角色由 Provider Adapter 映射。支持 `developer` 的端口可用它承载应用指令；现有端口只有 `system` 时，公共核心、固定模式和输出约束可合并到 `system`。原用户请求、项目文本、资料和工具正文不因此拼进高优先级指令。角色优先级参考 [OpenAI 提示词指南](https://developers.openai.com/api/docs/guides/prompt-engineering)，外部变量隔离参考 [Agent 输入安全指南](https://developers.openai.com/api/docs/guides/agent-builder-safety)；实际审批策略沿用 Relay 契约。

必须区分三个问题：来源是否真实、内容是否是指令、动作是否获得当前准入。真实用户请求可以表达执行意图；引用的命令、文件和网页不属于授权来源。用户请求本身也不代替 Gateway、执行权和完成检查。Task 的目标、验收和已生效 Rule 是应用指定的工作约束，不能因为其中含自然语言就全部忽略；其正文同样不能提升权限或改写核心协议。

## 2. 公共系统提示词的运行来源

2026-10-03，用户明确授权接入后，公共核心全文已归位到 [agent-system-prompt.ts](../../apps/api/src/workflow/agent-system-prompt.ts)，版本为 `1.0.0`。`withRelayAgentCore` 合并固定核心与本次职责/能力/输出限制；运行时直接导入编译后的模块，不读取本设计文件。核心文本以后只在该代码模块维护，避免文档与运行内容各自变化。

现有接线为：Assist 普通对话/类型化提案、第一方 Skill、内置方法、只读助手、学习轮次、DRAFT、原用户请求解释与状态维护解释。各入口继续保留原 Markdown/JSON schema 与写入边界；按 2026-10-11 源码核对的具体选择见下方路由表。语义检查保留独立的窄提示词，不加载协作执行者核心。DRAFT 的 CANONICAL 标签只用于现有五类应用事实/约束，所有正文仍在 user 数据消息；外部或未知 kind 默认 UNTRUSTED_DATA。

2026-10-11 起，这些入口的提示词改由 **`workflow/prompts/` 下的统一路由入口** 选取与组合（见 §2.1）。路由器只做确定性选模板、组合文本与返回可核对元数据，不访问数据库、不查当前事实、不冻结 Skill/方法、不判权限、不开事务、不定预算、不发起模型调用、不给工具准入；这些仍归原应用用例与模型端口。模板正文只在 `workflow/prompts/` 的三个模板模块维护，`application/` 与端口侧只保留调用与单一来源的兼容再导出，不存在第二份可分别修改的正文。

请求解释明确单条原消息没有目录读取结果，因此**不**要求「缺少实际内容就 CLARIFY」，也不接受它编造文件正文：候选只声明 `writes_files`（是否明确要改文件）与可选的 `file_changes` 路径，`content` 出现在解释结果里按确定性规则拒绝。真实读取发生在 Run 内的工具循环里，规则归[工具适配器 §1.6](tool-adapters.md#16-写差异与检查工具2026-10-04-实施)。这一改动推翻了本节此前「修改/删除现有文件且缺少实际内容时要求聚焦澄清」的表述。

声明了工具的 DRAFT 提示词按**本次实际授予的能力**生成，不是固定一段文案。只给读集时明确「工具只读，不修改任何文件」；一旦冻结信封含 `apply_changeset`，同一位置改为「本次授权范围内可以请求修改文件：先用读取工具读到真实内容再提出变更」，并同时声明删除文件与目录范围之外都不在授权内。提示词与能力错位在两个方向上都会破坏主链：仍写「只读」时模型按提示不取证，删掉限制却不落实准入时模型会把请求当授权。工程结果只看[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)；真实模型质量评价与桌面冻结包仍未做。

### 2.1 当前运行时提示词路由

2026-10-15 接续：下表仍描述已有源码，不是普通消息的目标编排。用户已确认[连续工具主流程](#24-普通-agent-主流程与模板选择的区别)，源码尚未切换；不要把“保留模板选择器”解释为必须保留三次独立的模型意图判断。

核对日期：2026-10-11（本次为**代码入口落地后的核对**）。此表集中描述当前源码的选择规则，供开发和审查导航；程序不读取此表。当前选择由 `apps/api/src/workflow/prompts/` 的统一入口 `selectRuntimePrompt()` 完成，原应用用例与模型端口仍负责事实查询、身份冻结、权限、事务、预算与结算。源码接线不表示真实 Provider、Windows 或完整功能已经验收；结果仍归统一功能验收表。第 3 节的职责草案与此处的已实现分支分别阅读。

表中的“公共核心”指 `RELAY_AGENT_CORE_PROMPT@1.0.0`。专用模板正文只在所链接的源码维护；此处记录触发条件、组合和输出，不复制全文。`assist()` / `interpret()` 接收 Application 准备好的 `system`，真实端口直接发送；`generate()` / `evaluate()` / 连接验证在端口或用例内经统一入口取各自固定模板。统一入口对需要公共核心的模板只组合一次核心，并对未知路由显式拒绝，不让任何默认分支吞掉未知值。

统一入口与登记表（本轮的代码事实）：

| 层 | 文件 | 职责 |
|---|---|---|
| 共享契约与登记表 | [route-types.ts](../../apps/api/src/workflow/prompts/route-types.ts) | 合法路由输入（封闭联合）、返回形状、20 条路由的元数据 |
| 统一入口 | [index.ts](../../apps/api/src/workflow/prompts/index.ts) | `selectRuntimePrompt()` 选模板、组合文本、返回本次元数据 |
| 会话档模板 | [conversation-prompts.ts](../../apps/api/src/workflow/prompts/conversation-prompts.ts) | Assist 五意图、第一方 Skill、内置方法、只读助手、学习搭档、普通 Agent 主流程与短期记忆整理 |
| 解释模板 | [interpretation-prompts.ts](../../apps/api/src/workflow/prompts/interpretation-prompts.ts) | 原用户执行请求解释、项目状态维护解释 |
| Run 与验证模板 | [run-prompts.ts](../../apps/api/src/workflow/prompts/run-prompts.ts) | DRAFT 三分支、语义验收、连接验证固定 user 探针 |
| 草稿辅助模板 | [composer-prompts.ts](../../apps/api/src/workflow/prompts/composer-prompts.ts) | 输入框草稿分点（只给边界序号）与润色（只给 `{text}`） |

返回类型上，`SYSTEM`（可发给 Provider 的 system 消息）与 `USER_PROBE`（连接验证探针）是判别联合的两个成员，探针不可能被当成 system 发出。每条路由的元数据含 `routeId`、专用模板版本、公共核心版本与模板维护位置；专用模板版本自 2026-10-11 的这次集中提取起登记为 `1.0.0`，公共核心与 Skill/方法定义版本仍保持各自原值。历史调用没有记录组合版本的地方保持未知——不倒填，也不声称完整提示词审计已经实现。

| 场景 | 触发与选择条件 | 实际模板组合与输出 | 模板与调用入口 |
|---|---|---|---|
| 短期记忆整理 | 普通 AGENT 的持久手动/AUTO整理请求，已结算原文与合法前一摘要 | `ASSIST_MEMORY_COMPACT@1.0.0`：公共核心＋接续规则，历史以UNTRUSTED_DATA传入；仅JSON `{summary}`，不声明工具、不写长期事实/权限/业务完成 | [assist-memory-runner](../../apps/api/src/application/assist-memory-runner.ts) → `selectRuntimeSystemPrompt()` → [conversation-prompts](../../apps/api/src/workflow/prompts/conversation-prompts.ts) 的 `assistMemoryCompactSystemPrompt()` → 冻结工作模型 `assist()` |
| 只读人设助手 | Assist 会话 `conversation_mode = ASSISTANT`，在普通 Agent 分支前返回 | 公共核心 + 冻结人设快照 + 只读范围与边界；正文回答，可请求本轮实际可用的只读工具 | [assist-runner](../../apps/api/src/application/assist-runner.ts) → [assistant-readonly-round](../../apps/api/src/application/assistant-readonly-round.ts) 的 `assistantSystemPrompt()` / `runAssistantReadonlyRounds()` → `assist()` |
| 学习搭档 | Assist 会话 `conversation_mode = LEARNING`，在普通 Agent 分支前返回 | 公共核心 + 教学规则 + 本轮相关学习状态与获准来源；只读工具及 `{answer, increments}` 信封 | [assist-runner](../../apps/api/src/application/assist-runner.ts) → [learning-round](../../apps/api/src/application/learning-round.ts) 的 `learningSystemPrompt()` / `runLearningRounds()` → `assist()` |
| 第一方 Skill | 普通 Agent 消息绑定可调用的 `skill_snapshot`；发送时由显式 `skill_ref.id/version` 查表并冻结 | 公共核心 + Skill 边界 + 该版本 `definition.instructions` + 按 Skill ID/版本选择的 JSON 输出协议 | [assist-commands](../../apps/api/src/application/assist-commands.ts) → [first-party-registry](../../apps/api/src/skills/first-party-registry.ts) → [assist-runner](../../apps/api/src/application/assist-runner.ts) 的 `systemPromptForSkill()` → `assist()` |
| 内置工作方法 | 普通 Agent 消息绑定 `method_snapshot`；显式 `/方法命令` 优先，其次 `method_ref`，未显式选择时才做确定性自然语言识别；该识别分支中，讨论方法不绑定 | 公共核心 + 冻结方法说明 + `INSPECT` / `MODIFY` 约束；INSPECT 只读；明确 MODIFY 且本轮有真实写工具时直接修改，其余剩余工作交原执行入口 | [assist-commands](../../apps/api/src/application/assist-commands.ts) 的 `resolveMethodRequest()`、[method-intent](../../apps/api/src/application/method-intent.ts)、[builtin-methods](../../apps/api/src/skills/builtin-methods.ts) → [assist-runner](../../apps/api/src/application/assist-runner.ts) 的 `systemPromptForMethod()` → `assist()` |
| 普通讨论 | 普通 Agent 消息无 Skill/方法，`intent = DISCUSS` | 公共核心 + Assist 边界；Markdown 回答，不声明工具 | [assist-runner](../../apps/api/src/application/assist-runner.ts) 的 `systemPromptFor()` → `assist()` |
| 影响检查 | 同上，`intent = IMPACT_CHECK` | 公共核心 + 影响分析约束；JSON `possibly_related`，只引用输入的直接目标版本 ID | [assist-runner](../../apps/api/src/application/assist-runner.ts) 的 `systemPromptFor()` → `assist()` |
| 影响候选 | 同上，`intent = IMPACT_CANDIDATE` | 公共核心 + 目标产物候选约束；JSON `markdown`，不自动应用 | [assist-runner](../../apps/api/src/application/assist-runner.ts) 的 `systemPromptFor()` → `assist()` |
| 交付候选提案 | 同上，`intent = PROPOSE_CANDIDATE`，会话须绑定 Task | 公共核心 + 候选提案约束；JSON `summary` / `proposal.title` / `proposal.markdown` | [assist-commands](../../apps/api/src/application/assist-commands.ts) 校验作用域 → [assist-runner](../../apps/api/src/application/assist-runner.ts) 的 `systemPromptFor()` → `assist()` |
| 任务定义提案 | 同上，`intent = PROPOSE_TASK`，会话须绑定 Project；选择函数当前以最后的默认分支实现 | 公共核心 + 任务定义约束；JSON `summary` / `proposal`，包含目标、验收条件和期望产物 | [assist-commands](../../apps/api/src/application/assist-commands.ts) 校验作用域 → [assist-runner](../../apps/api/src/application/assist-runner.ts) 的 `systemPromptFor()` → `assist()` |
| 原用户执行请求解释 | 应用调用 `interpretConversationMessage()`；会话须 ACTIVE 且绑定 Project，原用户消息与该项目的 ACTIVE 目录资源合法；它是独立用例，不是普通讨论模板里的自动切换 | 公共核心 + `INTERPRETATION_SYSTEM_PROMPT` 的专用规则；JSON `DISCUSS / CLARIFY / PREPARE`，只整理目标、验收和路径，不生成文件正文 | [conversation-execution](../../apps/api/src/application/conversation-execution.ts) → `interpret()` |
| 项目状态维护解释 | 应用调用 `interpretStateMaintenance()`；会话须 ACTIVE、绑定 Project 且模式为 AGENT；沿合法原用户消息身份处理候选，已结算请求回读 | 公共核心 + `STATE_MAINTENANCE_SYSTEM_PROMPT` 的专用规则；JSON `DISCUSS / CLARIFY / MAINTAIN`、有限 `changes` 与 `decision_required`；上下文和回执帮助解析对象，实际写入由后续用例负责 | [conversation-state](../../apps/api/src/application/conversation-state.ts) → `interpret()` |
| DRAFT 无工具 | `generate()` 收到的工具清单为空 | 公共核心 + `DRAFT_SYSTEM_PROMPT` 的候选生成规则 + `DRAFT_OUTPUT_SPEC`；完整 Markdown 候选 | [openai-compatible-model-port](../../apps/api/src/workflow/openai-compatible-model-port.ts) 的 `generate()` |
| DRAFT 只读工具 | 工具清单非空，且不含 `apply_changeset` | 公共核心 + `draftToolSystemPrompt(false)` + `DRAFT_OUTPUT_SPEC`；可请求声明的只读工具，最终输出 Markdown 候选 | [openai-compatible-model-port](../../apps/api/src/workflow/openai-compatible-model-port.ts) 的 `generate()` |
| DRAFT 含写工具 | 工具清单非空，且含 `apply_changeset` | 公共核心 + `draftToolSystemPrompt(true)` + `DRAFT_OUTPUT_SPEC`；声明授权范围内的文件修改，实际动作继续经过 Gateway 和冻结授权 | [openai-compatible-model-port](../../apps/api/src/workflow/openai-compatible-model-port.ts) 的 `generate()` |
| 语义验收检查 | 检查器调用 `evaluate(statement, content)` | 独立验收提示词，不组合公共核心；JSON `PASS / FAIL / UNCERTAIN` 与理由，解析故障不算通过 | [checkers](../../apps/api/src/workflow/checkers.ts) 的 `ModelSemanticChecker` → [openai-compatible-model-port](../../apps/api/src/workflow/openai-compatible-model-port.ts) 的 `evaluate()` |
| 草稿分点 | 草稿辅助用例按操作类型选 `COMPOSER_OUTLINE`；仅在草稿适用时（非空、非斜杠命令、未分行、长度在界内）才发起 | 独立窄提示词，不组合公共核心；JSON `{"breaks":[整数,...]}`，序号按 Unicode 码点、0 起、左闭右开；切片与编号由 `workflow/composer-draft.ts` 按原文完成，模型不返回改写文本 | [composer-draft-assist](../../apps/api/src/application/composer-draft-assist.ts) → [openai-compatible-model-port](../../apps/api/src/workflow/openai-compatible-model-port.ts) 的 `draftAssist()` |
| 草稿润色 | 同上，操作类型为 `COMPOSER_POLISH`；由用户点击「润色」触发，不自动发起 | 独立窄提示词，不组合公共核心；JSON `{"text":"<润色后的完整草稿>"}`，明确要求保留否定、数字、条件、范围与已有分点 | [composer-draft-assist](../../apps/api/src/application/composer-draft-assist.ts) → [openai-compatible-model-port](../../apps/api/src/workflow/openai-compatible-model-port.ts) 的 `draftAssist()` |
| 模型连接验证 | 应用调用模型端口验证用例；辅助探针，不属于 Agent 工作模式 | 固定 user 文本 `VERIFY_PROMPT = relay-verify-1`；没有 system 提示词或公共核心，非流式短调用 | [model-port-verification](../../apps/api/src/application/model-port-verification.ts) → [model-port-verify](../../apps/api/src/workflow/model-port-verify.ts) |

日常接续卡与返回检查目前由 [project-daily-continuation](../../apps/api/src/application/project-daily-continuation.ts) / [project-return-review](../../apps/api/src/application/project-return-review.ts) 生成事实、差异与适用性投影，没有额外模型提示词。第一方 `project-resume` Skill 则属于表中的 Skill 模型调用，两条路径分别维护。

上表“模板与调用入口”列仍写原调用文件，因为它们仍是**调用方**：选择动作现在统一经 `selectRuntimePrompt()`，模板正文改由上表的三个模板模块唯一维护。例：只读人设助手是 [assistant-readonly-round](../../apps/api/src/application/assistant-readonly-round.ts) 调 `selectRuntimePrompt({ kind: 'ASSISTANT_READONLY', ... })`，正文来自 `conversation-prompts.ts`；连接验证是 [model-port-verify](../../apps/api/src/workflow/model-port-verify.ts) 的 `VERIFY_PROMPT = connectionVerifyUserProbe()`，经统一入口以 `USER_PROBE` 返回，既不是 system 模板也不是 Agent 工作模式。

### 2.2 选择优先级与失败处理

1. Assist 先按持久会话模式选择 `ASSISTANT`、`LEARNING` 或普通 `AGENT` 路径。前两条提前返回，不进入普通 Agent 的 Skill/方法选择。普通 Agent 内的选择顺序是冻结 Skill → 冻结方法 → `AssistIntent`；消息写入约束要求 Skill 与方法快照互斥。这三种分流都在 `assist-runner.ts` 的同一个选择函数里完成，映射到 `SKILL` / `METHOD` / `ASSIST_*` 路由。
2. Skill/方法选择按冻结身份核对，不替换为“最新版本”重放。未知引用在发送时拒绝；生成时不可用分别结算为 `SKILL_DEFINITION_UNAVAILABLE` / `METHOD_DEFINITION_UNAVAILABLE`，不悄悄回落到普通讨论。五种 `AssistIntent` 经**穷尽映射表**转到各自路由，映射不到时显式抛 `UnknownRuntimePromptRouteError`——旧实现里“任务提案是最后一个默认分支”的隐式兜底已消除，未知意图不再被生成成任务提案。
3. 执行解释与状态维护解释通过两个应用用例选取不同 system 模板；Provider 的 `interpret()` 不自行判断该走哪条路。DRAFT 工具模板根据本次实际工具清单选取，能力仍须在动作边界重新准入。普通 Assist 未声明工具却收到工具请求时，按 `TOOL_CALLS_WITHOUT_DECLARED_TOOLS` 失败结算。
4. 只读助手缺少冻结人设身份时以 `ASSISTANT_SESSION_IDENTITY_MISSING` 失败；两类解释入口遇到非法输出或未声明的工具请求时退回澄清；学习信封非法时保留可读回答，不写学习增量。这些处理保留各用例边界，不切换到权限更大的模板继续。
5. 路由集中本身不改变任何权限、冻结身份、输出协议与失败处理：公共核心对需要它的模板只出现一次，语义检查与连接验证不加载核心；`assist()` / `interpret()` 仍消费 Application 准备好的 `system`，`generate()` 仍把 `request.tools` 原样交给 SDK，`evaluate()` 仍以 `json_object` 结构输出。

2026-10-20 接续：`AGENT_MAIN_LOOP@1.0.4` 按本轮实际写工具可见性选模板，不再因档位存在就宣称能写；`METHOD@1.0.2` 的明确 MODIFY 可复用会话直写，INSPECT 仍只读。输出 `execution` 仅承载未完成的检查、操作或尚未创建动作的审批需求，已成功写入不重复声明。`interaction=BROWSER|COMPUTER` 传给既有 Run 工具循环；它不是授权。详见[运行架构 §2.10](runtime-context.md#210-日常工具工作与正式交付分层2026-10-20-实施)。

2026-10-21 接续（模板 `1.0.4` → `1.0.5`）：用户指认「一个很简单的问题需要思考很久」。本轮只加一条**工具准入判定**：要不要调用工具取决于这一步需不需要本地事实——问候、概念解释、复述本次对话里已经给出的内容，本轮直接输出正文，不为了显得严谨先列一次目录。`assist-runner.ts` 进入多轮循环的谓词（会话绑定了目录或连接即进循环）**没有**改成按文本猜「这是简单问题」：那种启发式会让「帮我看看 README 写了什么」这类纯文本提问失去工具能力，属于用户没要的功能回退。收口落点是让模型第一轮就答完——主流程本轮不请求工具时，一次模型调用即结算正文，不新增分支。改善幅度需真实窗口取证，不预设数字；「过程为什么慢」的可读性由协作页的轮次折叠面板承担（[工作台 §18.10](../frontend/workbench-design.md)、[CD §10.109](../api/http-command-contract.md)）。

### 2.3 版本与维护范围

| 对象 | 当前源码版本事实 | 维护入口与限制 |
|---|---|---|
| 公共核心 | `RELAY_AGENT_CORE_PROMPT_VERSION = 1.0.0` | [agent-system-prompt](../../apps/api/src/workflow/agent-system-prompt.ts)；`withRelayAgentCore()` 只组合字符串，不选择场景 |
| 第一方 Skill | `task-to-execution-contract@1.0.0/1.1.0`、`project-resume@1.0.0`、`verification-plan@1.0.0/1.1.0`、`goal-to-project-blueprint@1.0.0` | [first-party-registry](../../apps/api/src/skills/first-party-registry.ts)；定义、依赖与摘要冻结。`verification-plan@1.0.0` 只保留历史读取，不用于新调用 |
| 内置工作方法 | `code-review@1.0.0`、`fault-diagnosis@1.0.0`、`docs-maintenance@1.0.0` | [builtin-methods](../../apps/api/src/skills/builtin-methods.ts)；方法定义及摘要冻结，独立于第一方 Skill 注册表 |
| 运行时提示词路由 | 20 条路由（会话档11、解释2、Run3、验证2、草稿辅助2）；统一入口 `selectRuntimePrompt()`，返回 `SYSTEM` 或 `USER_PROBE` | [route-types.ts](../../apps/api/src/workflow/prompts/route-types.ts) 与 [index.ts](../../apps/api/src/workflow/prompts/index.ts)；路由器不访问数据库、不发起模型调用、不给工具准入，未知路由显式拒绝 |
| 专用系统模板与输出规则 | 集中提取时为 `1.0.0`；2026-10-13 `DRAFT_READ_ONLY_TOOLS` / `DRAFT_WRITE_TOOLS` 为 `1.0.1`，其他模板仍 `1.0.0` | 正文只在 `workflow/prompts/conversation-prompts.ts`、`interpretation-prompts.ts`、`run-prompts.ts` 维护；公共核心版本、Skill/方法定义版本不能代替整个组合版本，旧调用缺失的组合版本保持未知 |
| 连接验证探针 | 固定文本 `relay-verify-1`，随模板版本 `1.0.0` 登记；没有独立的提示词版本字段 | [run-prompts](../../apps/api/src/workflow/prompts/run-prompts.ts) 的 `connectionVerifyUserProbe()`；探针文本不是 Agent 模板版本，也不组合公共核心 |

新增或修改提示词时，同步本表的触发条件、组合、输出和源码入口；只有源码存在的版本号才写入版本列。分支相关的已有回归入口包括 [agent-runtime-prompts](../../apps/api/test/unit/agent-runtime-prompts.test.ts)、[runtime-prompt-router](../../apps/api/test/unit/runtime-prompt-router.test.ts)、[conversation-prompts](../../apps/api/test/unit/conversation-prompts.test.ts)、[interpretation-prompts](../../apps/api/test/unit/interpretation-prompts.test.ts)、[run-prompts](../../apps/api/test/unit/run-prompts.test.ts)、[openai-compatible-model-port](../../apps/api/test/unit/openai-compatible-model-port.test.ts)、[first-party-skills](../../apps/api/test/unit/first-party-skills.test.ts)、[builtin-methods](../../apps/api/test/unit/builtin-methods.test.ts)、[assistant-readonly-round](../../apps/api/test/unit/assistant-readonly-round.test.ts)、[conversation-execution](../../apps/api/test/unit/conversation-execution.test.ts)、[conversation-state](../../apps/api/test/unit/conversation-state.test.ts) 与 [learning-round 集成](../../apps/api/test/integration/learning-round.integration.test.ts)。这些链接表示检查入口，不表示本次已运行或通过。

开发任务书仍由 [prompts 总目录](../../prompts/README.md)、[整改目录](../../prompts/remediation/README.md)与[功能地图](../feature-map/README.md)导航；是否执行取决于当前用户授权和进度入口。它们不参与上表的运行时模板选择，本文也不新增开发任务授权。原集中提取不改变合法路由文本与调用边界；后续行为修正单独记录如下。**Breaking Change：No**——无 API 或数据库协议变化。

2026-10-13 工具 DRAFT 的顺序修正：原固定指令“先查找与读取”与冻结目标“先运行已配置检查”相冲突，真实模型先探索再检查，虽完成修复与复检仍未满足目标顺序。`1.0.1` 改为按冻结任务安排工具顺序；要求先检查且本次提供 `run_check` 时，先取得实际输出，下一轮再依据失败证据查找、读取和修复，不在同轮猜尚未返回的结果。写前实读、删除/越界限制、Gateway 准入、UNKNOWN 与人工完成门保持原边界；检查输出仍只是原任务的证据，不新增授权。定向真实模型与图恢复的结果只归统一验收表，旧调用缺少组合版本仍保持未知。

### 2.4 普通 Agent 主流程与模板选择的区别

2026-10-15，**已确认、待重构**，依据[ADR-022](../decisions/ADR-022-agent-conversation-main-loop.md)。确定性的 `selectRuntimePrompt()` 负责模式、冻结 Skill/方法及专用输出模板选择，继续保留；普通聊天后额外调用模型判定 `DISCUSS/CLARIFY/PREPARE`、再并行判定 `DISCUSS/CLARIFY/MAINTAIN`，属于工作编排，不能用模板集中管理来证明这种编排合理。

目标普通 AGENT 轮次消费应用核对的原请求、会话历史、当前目录/对象事实、实际可见工具和已结算结果。模型在这条主流程中直接决定回答、聚焦澄清或请求必要工具，不再对每条消息预先支付两个独立的分类调用。工具请求只提出动作，具体授权、版本、审批和业务合法性由原应用入口确定；工具结果返回原轮次后继续推进或收尾。一次主流程可包含多次真实模型调用，所有调用、拒绝及失败按原用量/调用账本记录，缺失用量保持未知。

**收尾输出的信封（阶段 C 已实施）。** 不再需要工具时，主流程这一次模型输出是一个 JSON 对象 `{"reply": "<给用户看的 Markdown>", "execution": null | {…}}`：`reply` 是原消息的回复正文，`execution` 是**可选的**类型化任务候选，形状与旧解释入口的 `ConversationTaskCandidate` 完全相同，由同一份既有确定性校验 `validateConversationCandidate()` 判定。三条边界：候选只是声明「动什么范围」，**不含文件正文**（正文仍由执行阶段读真实文件后决定）；候选是否落库由应用按原准入决定，模型说了不算；解析失败或不是信封时整段正文按普通回复处理，不产生任何执行对象——这条容错是双向的，模型改用自然语言时用户照样拿到可读回复，模型编造候选时最多「这一次没整理成候选」，绝不会凭空造出 Task/Run。`AGENT_MAIN_LOOP` 模板版本随此从 `1.0.0` 升到 `1.0.1`。

普通回复必须与实际工具能力和工作阶段一致：当前已提供读取工具时不套用“本轮无工具”提示；等待 Run、审批或读取失败时依据持久回执说明，不先由独立聊天分支生成相反结论。模型不能仅凭目录上下文声称读过内容。用户原指令与应用事实分段传入；路径、文件名、资料、工具和历史正文保持数据身份，不能升级为系统指令或新授权。

显式 Skill/方法仍按冻结身份与其输出协议执行；专用提案、语义验证、连接验证、ASSISTANT 和 LEARNING 不因主流程统一而改成一个通用输出 schema。新普通消息不再强制经过旧解释模型；旧解释模板及其读取/重放兼容按[领域模型 §12.6](domain-model.md#126-普通-agent-主流程的应用边界)处理。本文不预定新增模板名或源码版本，实施后再更新 §2.1–2.3 的实际路由事实。

## 3. 工作模式与专用提示词

下列模式是目标调用职责标签，**不是新增的 Task.mode、Run.status 或 AssistIntent 持久枚举**。接入时映射现有入口，必要扩展另行设计 API/数据库兼容性。只把当前调用需要的模式文本交给模型。

| 职责 | 追加的指令草案 | 实际写入边界 |
|---|---|---|
| 讨论 | 理解问题，利用已获准来源提出判断与建议；直接以 Markdown 回复。缺关键依据时说明或提问，不把建议写成已实施 | Assist 消息；正式 Task/Run 由另一个执行用例准备 |
| 规划 | 给出可审查目标、范围、交付与验收；只使用已知事实。输出既有类型化提案 schema，未知项明确保留 | 接受后走原 Proposal 与领域命令；计划不授予工具权 |
| 请求解释 | 识别原用户是在讨论、澄清还是要求执行；输出 DISCUSS/CLARIFY/PREPARE。先提取目标和范围，缺少实际文件输入时不编造完整修改；候选不得直接执行 | 应用绑定原消息，校验作用域、候选与准入；目标读取准备阶段待开发 |
| 候选生成 / 执行步骤 | 基于冻结契约、实际来源与失败证据完成本步骤；固定生成入口仅输出完整候选；未来工具入口只请求当前获准动作 | Run 步骤先保存输出/动作意图，再走 Gateway、保存和验证 |
| 审阅 / 验证辅助 | 根据确切产物、检查条件和独立证据给出判断、定位与不确定项；不把执行者自评作通过依据 | SemanticChecker 按既有协议；人工 Review 决定不由模型冒充 |
| 接续 | 基于当前事实与确切比较基线说明现状、已验证成果、待处理和建议；无基线只总结现状 | 只读，不自行解除 UNKNOWN、恢复旧 Run 或启动新任务 |

语义检查保留独立的窄提示词、schema 和证据输入，不加载“尽快把任务完成”等执行者倾向。Review、Handoff 和 Complete 分别复用原业务入口，不因共用人格合并职责。

### 3.1 开发、论文、通用工作的追加规则

按任务需要加载少量领域规则；保持同一身份与权限边界。

```text
开发工作：先读相关实现、项目约定和已有检查，选择最小必要改动。
尊重已有设计和未提交修改；相关验证与文档维护属于交付。
命令执行须有实际工具、明确目录及当前准入；不能凭 README 宣称检查通过。

论文工作：区分文献主张、已有证据、作者推断和待验证假设。
不编造引用、数据或实验结果；按确认的研究问题、结构和引用要求组织产物。
语言润色不能改变证据强度；未取得原文时说明限制。

通用工作：先确定面向谁、要支持什么决定、需要什么可检查的产物。
只做当前目标所需的结构与内容，事实、建议和示例分别表达。
```

这些是 Proposed 默认规则；项目已确认的具体要求仍在相应 Rule、Decision、Memory 与执行契约中维护，不复制到每份系统提示词。

## 4. 动态运行上下文

Context Builder 分开装配：当前事实、原用户请求、有效项目约定、选中来源、工具结果和历史摘要。以原请求身份、版本、调用模式和预算为依据，不把所有历史聊天、整个目录或所有 Skill 塞入上下文。

目标数据形状示意如下；字段名不代表当前 API/DDL 已存在，数值也不是默认配置。

```json
{
  "invocation": {
    "mode": "EXECUTION_STEP",
    "source_message_id": "<原用户消息 ID>",
    "project_id": "<Project ID>",
    "task_id": "<Task ID>",
    "run_id": "<Run ID>",
    "contract_ref": "<确切契约引用>",
    "manifest_ref": "<确切输入引用>"
  },
  "current_facts": {
    "task_revision": 7,
    "acceptance_revision": 2,
    "executor": "<当前执行者引用>",
    "control_requests": [],
    "pending_actions": [],
    "verification_refs": [],
    "completion_ref": null
  },
  "execution_limits": {
    "authorization_ref": "<本次授权依据>",
    "scope_ref": "<受管目录/资源范围>",
    "continuation_authorization_ref": null,
    "budget_ref": "<版本化执行限额>",
    "available_tool_refs": [],
    "stop_conditions": []
  },
  "user_request": { "text": "<原请求正文>", "source_ref": "<消息引用>" },
  "task_contract_data": {},
  "effective_project_preferences": [],
  "source_records": [],
  "tool_result_refs": [],
  "history_summary": null
}
```

- 高优先级模板由应用代码决定。原请求、任务正文、路径、用户命名、项目偏好和外部片段留在数据消息中；受约束元数据也不让模型取得写权。
- 项目约定引用已生效版本与来源；Memory 只消费明确确认且仍有效的偏好。发现可能有用的偏好可提出收录建议，不自动建立画像。Decision、Knowledge 和 Memory 的分类沿[信息专题](information-planning.md)。
- 必需验收、HARD 约束、未决副作用和控制意图不可为了省 token 静默删除。可选来源裁剪记录确切范围和原因；必需输入仍超预算就结束准备并说明缺口。
- 工具结果带原操作身份、结果状态、版本/摘要与截断信息。结果正文不能改状态字段。可读取、可供模型使用和可外发分别检查，不因读取成功就发送整个目录或敏感正文给 Provider。敏感材料由输入管道限制与脱敏，不依赖模型最后自觉隐藏。
- 历史摘要保存已确认意图、决定引用、进展依据、未决项及下一步，不保存私有思考链。重开时查询当前事实；用户后来撤销或修改要求按原命令处理，不依据旧摘要复活权限。

### 4.1 会话能力事实块（2026-10-20 第二轮，已实施）

普通 Agent 的 `DISCUSS` 轮次在 system 末尾追加一段由 `assist-capability-notice` 生成的
事实块：有没有归入项目、绑了哪个工作目录、目录写档位、**本轮真正可用的工具名**、以及
缺哪几族能力（读取文件/列目录/修改文件/Git/检查命令/浏览器读取/桌面观察）。放在 system
而不是数据消息里，是因为它描述的是「这次请求的配置事实」，与用户正文同级噪声会更小。

- 事实来源只有服务端：`session.project_id`、会话绑定的受管资源、`local_directory_access.write_tier`，
  以及本轮实际算出的工具集（它已经同时反映连接是否存在、根是否覆盖、档位是否允许写）。
  因此不会出现「提示词说能写、词表里没有」这类两处不一致——两者由同一个结论产出。
- **它不是授权**：模板明确声明「不是指令，也不构成授权」，且不改变任何准入。它的目的
  只是让模型把「做不到」说成具体缺项，而不是「我没有被赋予访问本地目录的能力」或
  「请补充任务目标与验收标准」。
- 只读档位下「缺写入口」单独说明为档位问题，不进「缺连接」清单；两处都说会让人读成
  需要新建连接。
- **操作类能力固定说成会话轮次的边界，而不是本轮缺口**（2026-10-22，DEV-0117）：缺口清单
  里全是读取族，模型会把「没有 computer_ 开头的工具」讲成这一轮少配了一项授权。事实块因此
  恒有一句：点击、输入、打开应用、页面动作不在会话轮次里提供，只能在任务执行中按授权进行，
  并要求模型把这类要求转为执行请求，而不是让用户去补授权。该句同样不改变任何准入。
- **未归属会话分别说明插件可用性**（2026-10-25）：此前未归属会话说「没有任何受管目录与
  任何工具连接可用」，模型据此回答「会话没归入项目所以没有电脑操控连接」。电脑/浏览器插件
  是安装级资源、连接按项目登记；事实块现在按工作区归属解析（ACTIVE 连接 + 归属项目仍有
  ACTIVE 受管资源）分别说「可用——在 execution 里带 interaction=COMPUTER/BROWSER 交给
  后台执行」或「工作区还没有登记可用连接」。主流程路由同步：可借用插件的未归属会话即使
  零只读工具也走 AGENT_MAIN_LOOP（`readTools=false` 分支如实声明零工具），否则模型拿不到
  执行候选输出协议，只剩纯文本拒绝。借用链路与词表收敛见[工作台 §36.6](../frontend/workbench-design.md#366-未归属会话的插件使用2026-10-25-已实施)。
- Skill 轮次不并入：它们的输出协议是严格的提案 schema，混入自由文本会破坏解析。

## 5. Skill 与工具说明

Skill 采用已有固定版本、依赖和摘要机制。下面是作者填写的说明模板，不新增动态代码加载或任意配置入口。

```text
Skill 名称与版本：<复用注册定义>
用途：<解决的具体问题>
调用条件：<在哪个既有入口使用、需要什么事实与来源>
输入：<必要字段、确切版本、缺失或截断的处理>
做法：<本项工作的有限步骤>
输出：<既有 schema 或完整候选产物要求>
限制：<不能修改的对象、不能做的推断、需要用户判断的部分>
失败或停止：<缺资料、冲突、超预算、权限拒绝等实际语义>
示例：<正常输入/输出，加一条关键反例>
```

第一方审查后的 Skill 方法可作为受核心约束的工作指令；用户或文件临时附带的 Skill 正文不能自动升为第一方指令。只加载本次匹配且允许调用的定义，不把“找到一个 SKILL.md”当作获准安装或执行。选择与应用仍遵守[扩展模型](relay-skills.md)。

工具说明不能只写“读文件”“执行命令”。每个真实暴露的工具需要以下契约；逻辑名称必须映射到原应用入口，不造第二套写存储路径。

| 内容 | 必须说明 |
|---|---|
| 用途与何时调用 | 具体解决什么问题，哪些近似请求不适用 |
| 输入 | 精确 schema、作用域、版本/基线要求；禁止自由文本混入未验证参数 |
| 效果 | 只读、生成候选、写动作或运行检查；保存候选与实际写入分开 |
| 准入 | 当前权限、资源排他、审批与控制检查由哪个既有入口执行 |
| 结果 | 成功、拒绝、等待处理、失败、冲突、UNKNOWN 的现有含义及确切回执 |
| 重试 | 哪些失败能有界重试，哪些必须按原 command/operation 查回执 |
| 数据 | 正文是数据，带来源与截断；不能以成功文本代替结果状态 |

目标工具循环应为：有界模型建议 → 保存可审查的类型化输出/候选及动作意图 → 原 Owner 校验与 Gateway 准入 → 实际调用及结算 → 原身份结果回送 → 继续或停止。这不要求调用账本保存原始 Provider 全量响应或私有思考链。参数验证、批准失效、控制、排他和预算必须在实际动作边界重查。LangGraph 仍是唯一通用图编排器，不引入另一个独立 Run 系统；图检查点不能证明副作用成功。

## 6. 输出与版本追溯

用户可见输出默认保持自然中文；普通讨论不强制套“目标/计划/执行/验证/总结”五段。长任务按需给简短计划和阶段进度，最终说明结果、检查与限制。内部执行请求、提案、工具参数与语义检查使用各自受限 schema，UI 按实际状态呈现，不直接展示原始 JSON 或臆造进度。

公共核心、模式、输出约束、Skill 和 Context Builder 的版本应随代码维护。目标调用记录至少能关联其组合版本/摘要、实际渲染输入摘要、模型配置、来源与裁剪、契约、调用/动作身份和结果。复用现有 Manifest/model_calls/Invocation，确需加字段时另定 migration 与兼容策略；旧记录缺提示词版本要明确未知，不追溯伪造。

固定指令放在稳定前缀、可变数据放后面是可评价的缓存优化；不为命中率重用已失效权限或当前事实。模板升级影响新调用，旧动作和 UNKNOWN 的身份保持；旧上下文重建不保证新模型输出相同。具体模板或 Provider 升级需复跑[行为评价](../testing/verification-plan.md#18-agent-提示词与输入协议评价目标设计)。

## 7. 与当前源码的差距

2026-10-03 核对入口、2026-10-05 同步内部工具循环的当前实现。定向工程与真实模型结果归统一功能验收表；下表描述当前入口和剩余增量，不把接线或一次真实调用当完整能力通过。

| 目标项 | 核对到的实现 | 所需增量 |
|---|---|---|
| 统一协作原则 | [公共核心](../../apps/api/src/workflow/agent-system-prompt.ts)已被 [Assist](../../apps/api/src/application/assist-runner.ts)、[DRAFT 端口](../../apps/api/src/workflow/openai-compatible-model-port.ts)、[请求解释](../../apps/api/src/application/conversation-execution.ts)实际引用；语义检查仍独立 | 真实模型行为/质量评价与当前桌面包接入仍待验；不合并 Owner |
| 明确的指令/数据分层 | Manifest 的 CANONICAL/UNTRUSTED_DATA 不变；DRAFT 对 CANONICAL＋事实/约束 kind 白名单修正标签；Skill/解释已区分原用户目标与引用内容 | 全部目标动态事实包与完整读取准备仍待接入；标签不授予权限 |
| 基于真实项目读取后准备修改 | 执行解释只收到单条原用户消息，没有历史、目录内容或工具；生成 file_changes/check 不意味着读过仓库 | 在原请求作用域内先受控读取，再生成确切变化候选；读取与准备进度需原身份恢复 |
| 有界动态工具循环 | 原 DRAFT 内已支持完整 Provider 工具请求、持久轮次、真实读取/写入/检查及普通失败输出回传；冻结检查 ID 由同 Run 词表列出，生产图支持检查失败后的修正轮 | `preamble` 持久化、脚本正文信任、受验产物与检查证据的版本适用性、真实 Windows 与质量/兼容出口仍缺；保持 Gateway 和 Run Owner |
| 会话执行计划 | 本次定向检索未发现自由计划工具；已有固定 RunStep/Trace 不能替代模型分解清单 | 按[运行架构 §2.4](runtime-context.md#24-会话执行计划的归属与持久更新推荐设计)增加有界内部计划工具、持久快照与原结果回送；工具可用时多步骤工作按需更新，简单讨论不强制清单；所有项完成仍不判 PASS 或业务完成 |
| 意图与执行准入 | 原消息身份/内容摘要已绑定；PREPARE 语义由模型判断，应用确定性校验结构、路径、作用域及准入 | 评价误判讨论/引用/执行的反例；候选预览和当前授权依据可核对，不能声称已存在独立确定性语义鉴别 |
| 完整调用与提示词追溯 | DRAFT/Assist 有调用账本；解释直接调用 interpret。DRAFT 输入摘要未覆盖实际 system/最终渲染消息；Skill 定义摘要不等于公共提示词版本 | 将解释接入统一调用记录，补组合提示词与渲染输入摘要；本轮已把模板集中到统一入口并登记路由元数据（`routeId` + 模板版本 + 核心版本），但**调用账本仍未记录组合版本**，历史缺项保持未知；不得把路由元数据存在当成提示词审计已完成 |
| 隔日接续与跨任务持续工作 | 已有事实接续/Skill 基础；完整接续呈现、N06 有限连续授权仍按原阶段推进 | 对接当前事实包与授权生命周期；连续工作复用[后续路线](../requirements/post-v1-roadmap.md)，不另造调度器或默认后台授权 |

现有公共模板与原 Run 工具协议已有接线；后续补调用版本追溯、实际读取后的准备、检查信任与版本适用性，跨任务工作按既有 N06 依赖推进。每步有自己的工程、真实模型、恢复与 Windows 出口，不把改提示词当全部能力完成。

## 8. 待核定项与本轮边界

后续工程参数与模型基准继续归执行配置、[后续路线](../requirements/post-v1-roadmap.md)、[内部工具循环方向](runtime-context.md#21-relay-内部工具循环接入方向2026-10-03)和扩展专题；已确认的产品规则不在本页重新标为待确认。尚未冻结的额度/步数、Provider 工具协议与评价参数不在核心提示词里写死猜测值。领域追加规则与完整动态上下文仍按各自目标设计接入，不宣称本次公共核心接线已实现全部模板。

用户随后明确要求接入运行代码，本轮已实施公共核心与现有模式接线、输入标签修正及相关回归。**Breaking Change：No**；没有新增依赖、端点、migration、工具循环或自动化。当前桌面窗口未重启，冻结包未重建；没有真实 Provider 质量、工具自主性或完整目标 Agent 已通过的结论。模块总出口不因这项增量通过而改变。
