# D：Context、长期信息与完整工作体验

> 当前执行入口为 [M01–M07](stack-migration.md)。本文件保留原 P 阶段业务范围；模型统一 gpt-6-sol / ultra，UI 使用完整 React 迁移路线，技术选择按 ADR-010。不得按旧编号重建工程；前置与验收按公共契约及当前授权执行，后置不等于通过。

2026-09-26 产品接续：本阶段开始前按[公共执行映射](README.md#产品补充的执行映射)读取目标托管/成果共创/变化守护及注意力/验收补充。P11/P12 负责恢复与验收建议的事实输入，P13/P14 负责人工介入和成果交互，P15 负责确切证据导航；新增策略先定范围，不因引用本页自动执行全部探索项。已授权并行开发及验收后置按当前状态执行，旧 P 前置不覆盖新授权。

## P10：长期信息、规则与检索

```text
执行 P10，前置 P09。读 AGENTS.md、prompts/README.md、contracts/01-facts-and-ownership.md、docs/architecture/information-planning.md、docs/api/module-api.md。
范围：Knowledge/Memory/Decision/Rule 的类型化根/版本/写入口、基础搜索及管理 UI。Memory 仅显式确认，Decision 替代保留历史并拒绝环，Rule HARD 与 PREFERENCE/作用域/enforcement 分开；必要检查路径缺失不能默许执行。共享规则/关键输入变更遵守 authority 锁和执行契约失效。
知识库同时服务人和 AI：读取产品总纲第 33/90 节、信息设计第 1.1 节、工作台及测试计划第 12 节，核对确切版本全文读取、正文安全展示、来源及笔记修订，不把列表摘录当完整阅读。四类信息继续独立 Owner；导入/收录不等于验证，原件与版本快照分开，不重建需手工同步的第二份正文。导读编排、AI 建议沉淀或确认信息缺字段时先列契约缺口，不擅自增加状态/关系表。
导入先支持受管 txt/md/note 与产物版本引用，Web 抓取由 P17；不伪造尚未支持的 PDF/URL 正文。搜索先有界字面匹配，含中文、scope、版本、稳定排序；只在实测需要时加 pg_trgm，暂不加向量服务。
验证 A03/A04/A06、不可变版本、显式确认、跨范围搜索、中文短查询、Decision 循环及产物提升幂等。补 migration/OpenAPI，接回 P06 真实规则来源并回归，不留两套规则存储。
```

## P11：Context Builder

```text
执行 P11，前置 P10。读 AGENTS.md、prompts/README.md、docs/architecture/runtime-context.md、contracts/01-facts-and-ownership.md、contracts/03-verification-and-approval.md。
源码对照：按公共“本地源码参考要求”从 .research 核对 Pi 消息转换及当前采用 SDK 的输入组织机制；可复用转换能力，必需验收、来源版本和裁剪证据仍按 Relay 契约实现。
范围：Mandatory/Relevant/Step-specific 装配、预算、实际片段 Manifest、缓存失效与来源查询。以 Project/Task/Run canonical facts 和固定契约为输入，不把聊天历史作为当前真相。Verifier 上下文不采用 Worker 的自我评价。
接续目标托管与恢复摘要：消费当前目标、已确认事项、变化依据、未决风险和下一步所需的真实来源；事实、模型建议、来源缺失分别标注。没有比较基线只提供当前快照，不从聊天时间戳推断“离开后变化”；核对实际送入资料及预算，不为新摘要建立第二套 Project State。
共享知识核对：Workbench 阅读与 Context 引用同一知识版本，人可核对实际采用片段；知识更新不改写旧 Manifest。阅读不触发模型调用或资料外发，显式用于 AI 仍按当前选源、权限与预算，不把所有可搜索内容自动并入每个项目。
必需规则和验收不能被检索淘汰或裁剪；超限明确返回 CONTEXT_REQUIRED_OVER_BUDGET。可选片段裁剪留理由，token 估算标明；保存真正送模型的来源版本/hash/range/内容及模板版本，密钥排除。权限按当前准入判断，历史快照不授权未来动作。
替换 P05 fixture 上下文，并保留 Fake 测试。验证 A04–A06/C08：必需内容超预算、来源更新、过期缓存、无 Project Assist、重开/替代、外部注入指令不能升级权限。提供读取 Manifest 的 API/UI 证据，不暴露隐藏思考链。
```

## P12：真实模型与 AI Assist

Skill 补充（方向已确认，实现设计仍 Proposed，2026-09-20）：P11/P12/P14/P15 开始前读取 [Skill 专题](../docs/architecture/relay-skills.md)、[ADR-008](../docs/decisions/ADR-008-declarative-skills.md)及[补充验收](../docs/testing/verification-plan.md#8-relay-skill-与蓝图应用验收)。P11 纳入 Skill/依赖版本与 Context 缓存；P12 先实现任务定义、项目恢复、验收方案的第一方定义/Assist 输出，再接蓝图及其应用用例；P14 完成任务确认、项目恢复和内置模板 Preview/Diff/Apply；P15 补确切来源追溯。先冻结 schema、逻辑模型所需 migration 和全入口锁协议，再以真实 PG 验证竞争与回滚。此补充仅在本阶段获准实施时执行，不扩展当前 P00 授权，不新增 Skill Runtime、自定义页面或第三方安装器。

P12 必须复核 P05–P08 已有修复、Handoff 和完成事务证据：检查方案先于 Delegate，定向修复提交新版本并复验，checker ERROR 不改产物，交接包不提前转移 Owner，模型标记 deterministic 不可自动应用。Project Resume 覆盖任务重开、决定替代、验证撤销和缺少比较基线。先交四项首批目标；核心闭环按需包装，Decision Capture 与完整领域 Skill 目录仍是后续候选，不为凑八个 Skill 重写既有机制。

扩展组合补充：V1 要求最小第一方 Thesis/Development Pack，只组合已交付成员。读取[扩展模型](../docs/architecture/relay-skills.md#8-可组合扩展模型)及[版本评测](../docs/testing/verification-plan.md#9-扩展组合与版本评测)：P11 处理 Profile 约束与实际依赖记录；P12 处理只读 Pack 清单、固定成员解析、版本冲突/兼容校验和基础 Eval；P14 接领域组合选择、真实影响 Diff 与分别确认；P15 提供实际 Manifest 来源视图和历史读取鉴权。Recipe 复用既有 WorkflowVersion，Profile 各归原模块，Proposal 不成为万能写入口。产品名称统一“从目标创建项目蓝图”。不创建联网安装器、远程存储、自动 Trigger 或完整 Checkpoint；不要生成整个候选目录的空模块。

```text
执行 P12 的业务内容，按 M04 与当前授权接续，核对所需 P11 能力；启用真实 Provider 仍以前置 M03 独立验收通过为门槛，获准的非凭据开发和自检不等于真实启用。读 AGENTS.md、prompts/README.md、docs/architecture/runtime-context.md、docs/api/module-api.md、docs/frontend/workbench-design.md。
源码对照：按公共“本地源码参考要求”核对实际采用的 LangGraph/LangChain Provider 的流式、工具 schema、interrupt/checkpoint 与取消实现/测试；Pi、Vercel 历史研究仅作机制对照。核对当前正式依赖版本，保留 SDK 与持久 Gateway 的边界。
范围：一个真实 ModelPort、模型配置/secret_ref、用量/错误、Assist 会话与类型化提案、SemanticChecker 的真实适配。先核验官方 SDK/API 兼容性并锁版本；不因引入 SDK 替换领域生命周期。没有用户凭据时用 Fake 完成代码和故障测试，明确真实连通未验证。
沿用 P00 已验证的上游库/harness 和采用表，复用模型、流式输出与工具循环；只写业务适配。若换方案，先补差异和验证，不能到本阶段又默认从零实现模型协议和 Agent loop。
配置 schema/timeouts/预算/结构化输出；纯生成重试有界，工具请求必须走 P09；保留每次请求身份与未知用量。Assist 不持有自主写权，输出候选/提案，用户接受后复用真实业务命令，Task 被 AI 占有时先接手才能保存编辑。
UI 固定消息目标，切页后旧回复不落新 Task。测试模型超时、错误 schema、取消、预算耗尽、来源缺失、提案过期/重复接受、checker 独立上下文。真实模型演示记录实际用量与配置，不把一次成功当可靠性结论。
按工作台第 11.2/11.3 节复核已确认的 project-resume/verification-plan Skill：恢复建议附基线与来源，验收建议从已接受要求、规则及可用检查能力提出，不从本次实现反向缩减要求；需求遗漏候选与已接受 criterion 分开，不能自动改冻结契约。输出可供用户判断的变化、缺口与下一步，不以换一个 Judge 保证无误判。
```

## P13：Today 与个人选择

```text
执行 P13，前置 P04/P10。读 AGENTS.md、prompts/README.md、docs/architecture/information-planning.md、docs/frontend/workbench-design.md、docs/api/module-api.md。
范围：planning metadata、Pin/Later/Focus、确定性 Today API/UI。用户选择持久化，推荐只读；候选来自所有合格人工任务，不只各 Project Next Action。按文档明确排序键输出 reason_codes 与依据，不预测时长或虚构完成百分比。
先资格过滤再应用 Focus/Pin；AI 占有、依赖不满足、blocker 单独展示。Later 保存本地日期/时区，查询计算生效；Focus 空候选不擅自改焦点。Goal 默认继承与显式空集语义正确。
按工作台第 11.1 节核对本次已有等待/阻塞投影与待审导航；Later/Focus 不隐去尚未解决的必需人工事项或改变 Run 契约。跨项目统一队列、提醒合并和待审积压限制若纳入本次，先讨论排序/阈值/控制 Owner 并明确命令；未纳入则记录具体缺口，不擅自扩成调度器或后台监控。
测试 A07/A09、跨午夜/时区、重载重启、Pin 阻塞、同项目多个合格任务、稳定排序、过期 selection revision；桌面窗口中可重现。只增加实际需要表/索引并更新文档。
```

## P14：三套内置工作台

```text
执行 P14，前置 P04/P12/P13。读 AGENTS.md、prompts/README.md、docs/frontend/workbench-design.md、docs/architecture/runtime-context.md、docs/api/module-api.md。
范围：General/Thesis/Development 组件注册、ProjectState 视图、AI Panel、Review/Run 页面与 Connections 设置。复用同一事实查询，不复制 Task/Run。切工作台仅改变展示；执行配置更改是独立版本化命令。Project Type 阶段词汇不随页面变化。
General 展示下一步/任务/产物，Thesis 展示资料/草稿/引用证据，Development 展示真实 capability 状态和变化集/检查入口。E 阶段未接通工具时显示不可用，后续 P16–P19 接通；不做假 diff/假测试或动态页面平台。
按工作台第 10/11 节及逐页补充映射核对恢复摘要、人工决定和验收证据的闭合路径；展示重要行为、确切证据、未验证项及可追溯的变化原因。统一队列、局部锁定、影响传播等新增交互只有选定范围且契约闭合后才实现；缺字段明确待接入，不用固定文案或 fixture 冒充 live 能力。
知识入口按第 12 节提供到现有资料正文、决定与验收依据的可核对导航；项目导读仅在本次已确定组织方式时实现，没有资料或关系就显示缺口。Provider 关闭时已保存受管知识仍可通过本机 API 阅读，不能要求先向 AI 提问；不按最新内容替换历史引用。
按工作台设计补齐五项全局导航、Ctrl+K 与首次创建项目引导；模型建议只有用户 Apply 才写入，缺连接时人工路径仍可用。测试导航可达、跨项目筛选、建议过期/重复接受；不把 Today Focus 扩展为完整 Work Session。
组件/桌面 E2E 验证 A05、受控并发客户端冲突、202 与已完成区别、Review 过期、UNKNOWN 说明、键盘焦点、窄窗口/DPI 与安全 Markdown。不要仅截图演示；与真实 API 联调并记录尚未接通能力。
```

## P15：Activity、Trace 与 Lineage

```text
执行 P15，前置 P14。读 AGENTS.md、prompts/README.md、docs/architecture/information-planning.md、docs/api/module-api.md、contracts/04-recovery-and-commit.md。
范围：补齐业务审计写点、分页查询、Run 证据投影、产物来源关系与前端追溯。Activity 关键记录与业务同事务；Trace 从已有 Step/Invocation/Verification 查，不另造事实源。Lineage 用有限 typed relations，拒绝版本循环。
从完成凭据可跳到确切验收、产物、来源和判断；批准与动作结果分开展示。正文已失效/删除时标不可用，不用新正文顶替。日志/接口不含密钥、完整隐私文本或模型隐藏思考。
对本次涉及的恢复/验收视图核对“结论 → 原事实/版本/检查证据”是否可达；无直接关系不能仅凭标题或时间推断因果。共创影响分析的明确引用、待复核内容和模型推测分别呈现；新依赖关系或比较基线存储需要先完成对应设计，不借 Lineage 创建通用知识图谱。
测试 C08、D05/D06、审计回滚/重放不重复、Lineage 自环/循环、分页作用域与脱敏；E2E 完成一次完整证据导航。交付 D 阶段核验记录，保留 E 工具未完成状态。
```
