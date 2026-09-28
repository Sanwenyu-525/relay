# Goal：技术栈改造与后续 V1 开发

2026-09-28 接续：新[N 工作包](post-v1-collaboration.md)是独立的后续规划，不属于本 goal；完成 V1 后不因仓库中存在这些提示词自动继续，需要后续明确的执行范围。

使用方式：在目标任务中启用 goal，将下列内容作为目标提示词；不假定某个客户端的斜杠命令参数语法。本轮仅提供提示词，没有创建 goal 或设定 token 预算。

~~~text
在 D:/Develop/Relay-Agent 持续完成现有技术栈改造与后续 V1 开发，交付保留既有功能和视觉的 React Windows 桌面应用。默认每完成一个大模块即独立验收，修复并复验通过后继续下一模块；用户已允许的并行开发与验收后置按 CODEX_NEXT_STEP 和当前指令执行，直到所有必需出口有证据通过。

先读 AGENTS.md、CODEX_NEXT_STEP.md、docs/README.md、docs/decisions/ADR-010-agent-stack-react-desktop.md、docs/architecture/技术选型.md、prompts/README.md、prompts/stack-migration.md 和 docs/testing/verification-plan.md 第 10 节。附件 Agent_Stack_Integration.md 是原始参考；采用适配本项目的决策，不机械照搬全部组件。

同时读取 Personal_Workflow_OS_Master_Spec.md 第 0.2/0.4 节、docs/requirements/v1-scope.md 两项产品探索补充、docs/frontend/workbench-design.md 第 10/11 节及 docs/testing/verification-plan.md 第 11 节。目标托管、成果共创、变化守护，以及减少注意力切换、恢复理解和补足验收依据，按 prompts/README.md“产品补充的执行映射”落实到本次模块。先列每项的实现/回归核对/待讨论/后置/不适用及依据；不把全部 Proposed 加入本 goal，也不只做页面清单而遗漏已确认约束。

涉及知识资料时，同时读产品总纲第 33/90 节、information-planning 第 1.1 节、工作台及测试计划第 12 节。核对人能否无需模型浏览完整正文、来源与历史版本，以及 AI 是否引用同一来源的确切版本；不能只交搜索/摘录管理页或第二套 AI 正文。项目导读、原件接入和建议沉淀按范围补充确定本次增量，不自动新增双向同步、向量库或通用 Wiki。

需要新增提醒策略、并发限制、锁定/依赖关系、外部执行入口或验收关联模型时，先讨论影响本次实现的未决项，再冻结范围、Owner 与验收依据；继续不依赖这些决策的已授权工作。复用现有事实和单一写入口，不创建通用调度器、多 Agent Router 或第二套完成状态。恢复摘要须可追溯，验收须显示缺口，单任务通过不得冒充组合版本通过；具体义务仍按已接受契约与本次范围执行。

你负责协调和独立验收；具体实现、测试、构建和修复按已授权范围分派给执行 Agent。分派时明确文件/模块所有权，要求保留他人的修改，不虚报模型调用。执行者自检不等于验收通过。

使用 goal 工具维护这个长期目标。先查看当前 goal，没有活动目标才创建；已有同一目标则继续，不重复创建，不自行设 token 预算或改用户预算。遵守工具的暂停/阻塞/完成规则；用户要求暂停时记录进度并停止。上下文压缩或自动接续后从文档和实际文件恢复，不重复重建或把一轮回复结束当作目标完成。

按 prompts/stack-migration.md 的 M01–M07 执行：
M01 现状基线、稳定依赖及技术适配；M02 全部既有界面迁移 React 与 Windows 桌面基础；M03 Mock Agent Runtime 和可靠性闭环；M04 真实模型、Context、Assist、低风险工具；M05 完整工作体验和追溯；M06 真实工具/Coding Worker；M07 Windows 安装交付和 V1 总验收。

技术选择：React + TypeScript + Vite；Tauri 2 + Node sidecar 优先实施；保留 Node 24 LTS、Fastify 5、Kysely/pg/PostgreSQL 和既有迁移。LangGraph.js 1.x/官方 PostgresSaver 先通过兼容出口再接入。API 与 Worker 分进程，分发优先 PostgreSQL 持久 command/outbox；不无依据新增 Drizzle、Redis/BullMQ 或多套 Runtime。正式稳定版本核验兼容后精确锁定，不用 beta/RC 或浮动 latest。

React 是完整迁移，逐路由、页面、组件和交互核对，不只替换页壳。保持现有 UI/token、业务数据、鉴权、回执、revision 和唯一领域写入口；旧迁移只追加，不重写历史。保留当前可用功能，未接通能力准确标识。开发 Compose 和浏览器自测不能替代桌面安装交付。

先完整通过 Mock 的 Task/Run 创建、SSE、审批、取消、幂等、失租、双 Worker、崩溃恢复和 UNKNOWN 测试，再启用真实模型。LangGraph 是唯一通用图，领域入口仍控制业务完成和权限；PG 分发只派 command。checkpoint 不保证副作用 exactly-once；UNKNOWN 按原 operation_id 核对，审批等待释放槽位，取消送到实际客户端/子进程，SSE 从 PG 重放，断页不取消。

每模块由执行者实现和自检，交 READY_FOR_ACCEPTANCE。独立验收按当前用户范围执行；未后置时，你在当前文件基准上独立复跑必要测试和反例，检查真实 PG/进程/桌面证据，给出 ACCEPTED、CHANGES_REQUESTED 或 BLOCKED 及依据。未通过则交回修复并复验，未获允许时不进入依赖它的下一模块；后置项保留未验收状态和最终出口。普通模块通过后自动继续已授权工作，无需重复问用户是否继续。

只在 CODEX_NEXT_STEP.md 维护当前模块、状态、下一步和阻塞；具体证据写入对应测试/开发记录并链接。每模块报告实际修改文件、实际命令/退出码、已执行测试、未验证项、风险和文档同步，运行 node scripts/check-docs.mjs。原 P00–P22 保留业务覆盖和历史；不重做已通过功能，P22 论文实验和 V1.5 不属于此目标。

交接同时说明行为变化、原因、影响、当前人工决定与下一步，附“重要要求 → 确切版本及检查/人工证据 → 未覆盖项”的本次映射。测试数量、图像、Agent 数量不证明产品目标达成；第 11 节体验评价仅在本次明确选定范围后执行，未运行则保留候选状态。同步公共、模块、单段及受影响逐页提示词，历史证据与修复提示词不改写为新增开发授权。

真实 Provider 配置或 Windows 条件缺失时明确记录，继续不依赖它的已授权工作，不伪造通过或降低门槛。只用用户为本项目提供的凭据，不扫描宿主会话密钥。保持简洁进度汇报；不自动推送、公开发布或向外部协作平台发送项目材料。

只有 M01–M07 的必要出口、既有业务回归和 Windows 安装验收全部通过且无阻塞，才能标记 goal complete。最终交付实际文件清单、运行/安装说明、各模块证据、实测结果、已知限制和未验证可选项。未完成时如实保持状态，不能因上下文、时间或预算将尽冒充完成。
~~~
