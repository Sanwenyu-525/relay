# 设计与编码提示词交付审计

日期：2026-09-19。角色：按时间追加的交付审计，各节描述当时目标和证据，不维护当前阶段。当前状态统一见 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)。审计对象是设计包，不是运行软件。

## 1. 目标与证据

| 交付要求 | 可直接检查的证据 | 判断 |
|---|---|---|
| 保留原产品范围，不只交人工原型 | [F01–F23](../requirements/v1-scope.md)，General/Thesis/Development、四类工具均列入 | 已有明确范围与阶段，研究为单独可选项 |
| 总体架构与模块责任 | [领域模型](../architecture/domain-model.md)、四份契约、ADR-001 | Owner/依赖/聚合/短事务齐全 |
| 技术与数据库设计 | [技术选型](../architecture/technology-selection.md)、逻辑/物理模型、ADR-002 | 有推荐与代价、FK/唯一/锁/恢复；不宣称 DDL 已执行 |
| 执行与 AI 设计 | [Runtime/Context](../architecture/runtime-context.md) | 固定流程、预算、契约冻结、模型端口、Assist/提案、输入证据 |
| 产品辅助模块 | [信息与计划](../architecture/information-planning.md) | Goal/长期信息/规则/检索/Today/审计/Lineage |
| 前端可实现交互 | [工作台](../frontend/workbench-design.md)、ADR-003 | 路由/三套页面/组件边界/状态/冲突/可访问性 |
| 工具与安全执行 | [适配器](../architecture/tool-adapters.md)、ADR-004 | Files/Web/Git/CLI 的输入、准入、未知核对和平台限制 |
| API 与错误 | [核心 API](../api/http-command-contract.md)、[模块 API](../api/module-api.md) | 公开/内部边界、幂等、revision、202、Problem Details |
| 测试和发布设计 | [测试](../testing/verification-plan.md)、[部署](../deployment/local-deployment.md) | 37 场景责任、真实 PG/故障/前端/备份恢复出口 |
| 分阶段编码提示词 | [P00–P22](../../prompts/README.md) | 23 段可复制任务；前置、范围、必读文档、验收、交付 |
| 毕业论文方向不丢失 | [实验协议](../research/evaluation-protocol.md)、P22 | 有组别/独立评价/指标/复现；无虚构结果 |

## 2. 一致性复核及修正

- Run 创建时冻结 ExecutionContract；BUILD_CONTEXT 改为复核并装配，避免前后两处重建验收。
- State 的提案复用 state_proposals，统一 ProposalDTO/人工 Inbox 只是投影，不增加第二个权威状态。
- Goal 使用 INHERIT/EXPLICIT，显式空集不会误当默认继承。
- mode 与 status/executor 分开；切工作台不改模式或 Run 契约；Delegate/安全交接由应用事务修改对应事实。
- 批准占用属于一个逻辑动作；调用绑定追加留痕，重试不覆盖原 invocation。
- 用户直接 URL 导入增加显式 USER_IMPORT 来源、真实 job/Project FK 与权限分支；不伪造 Run，不用空 run_id 免检查。
- 真实前端推荐 Vue/浏览器，技术选型、API 身份和部署说明已同步；未照搬 Manga 技术栈。
- 阶段 A/B 不提前开启真实副作用；C 的控制/资源/权限出口必须先过；三套工作台与真实工具在最终验收中不能以占位算完成。

## 3. 自动静态检查范围

检查所有 Markdown 相对文件链接、围栏配对和 JSON 示例；提取 23 个 Prompt 定义，核对 P00–P22 无缺失/重复；核对依赖表的引用存在且无环；核对 23 条功能映射均引用实际 Prompt；核对 37 个原契约场景全部出现在测试责任表。以上是文件与结构验证，不是业务测试。

完成前还逐项阅读新增设计与提示词的范围/验收，确认存在具体输入、边界、失败处理和产出要求。不能仅以“链接可点击”证明设计正确，也不能以这份审计替代未来代码审查。

## 4. 明确未完成的软件工作与外部核验

未创建 Personal Workflow OS 工程、完整 migration、实际 OpenAPI 或运行时服务；未运行 PostgreSQL/浏览器/模型/工具集成测试。这些是后续提示词要完成的编码交付，不属于本次设计包已完成的能力。

2026-09-19 接续任务时，已在目标目录取得 Master Spec、CODEX_NEXT_STEP 和 V1_ARCHITECTURE。已对照产品范围及关键状态语义，具体差异见第 6 节；不是运行时一致性证明。依赖精确补丁/SDK 与平台进程封装需要工程验证；用户仅明确确认本机 PostgreSQL，其他技术推荐保留 Proposed。导师认可、正式数据集和真实实验结果不由本包代替。

这不会阻止使用本包作为编码基线，但编码 Agent 遇到原件/代码证据冲突时应记录并处理，不能把推荐当不可修改历史。

## 5. 下一步

独立目录已确定为 D:/Develop/毕业论文项目。后续编码从 P00 开始，按依赖逐项交付。本审计第 1–7 节记录设计交付历史；当前已进入研究实验，见第 8 节。不把设计文件迁移当作工程实现完成。

## 6. 接续迁移与原件对照（2026-09-19）

来源任务：01a0b41b-2708-7f63-a60d-ee5a1f564651，标题“毕业论文选题架构讨论”。从 C:/Users/ASUS/.codex/visualizations/2026/09/18/01a0b41b-2708-7f63-a60d-ee5a1f564651 复制全部 36 个文件，复制时 SHA-256 逐文件一致。来源保留；本节后的整理只修改目标目录。目标原有三份文档未被复制覆盖，Master Spec 内容保持原样。

| 原件依据 | 对照结果与处理 |
|---|---|
| Master Spec 第 17、105 节 | 最终 V1 包含 General、Thesis、Development；阶段 A 不能代替完整 V1，现有范围矩阵符合 |
| 第 86、90、92 节 | 新工作台路由表漏列全局 Tasks/Knowledge/Activity，已补齐并绑定 P14 验收，不增加领域事实源 |
| 第 97–98 节 | 补明首次项目引导和建议 Apply；无模型时人工可用，真实建议接 P12/P14，不新增自动 Bootstrap |
| 第 11、14、42 节 | Today Focus 是每日结果；完整 Focus Mode 后置，Start Focus 入口仍有歧义。保留待确认，不擅自实现 Work Session |
| 第 20、27、38、84–85、115 节 | 通用 Schema、Automation、完整 Inspector、Time Travel、自动 Bootstrap 及主动规划后置；运行恢复检查点和来源证据仍属 V1 |
| V1_ARCHITECTURE 第 5.4 节 | 早期 FAILED 一律映射 Blocked；契约 02 改为 READY 或有依据的 BLOCKED，避免技术失败伪造业务阻塞。早期稿标记历史，当前编码按契约细化 |
| V1_ARCHITECTURE 第 5.1 节 | 早期审批/暂停可直接回原 phase；契约 02 先重查 Context/契约，未解决 Review 回原等待点，成功动作不重放 |
| V1_ARCHITECTURE 第 2.1 节 | 早期 Workflow 同时描述完成协调；后续领域模型明确应用层协调跨模块短事务，Workflow 拥有 Run 生命周期 |
| V1_ARCHITECTURE 第 1.2、8.2 节 | 无 Project Inbox 已有依据；允许无 Project 人工完成、同 Project 依赖限制仍是推荐细化，不宣称用户已冻结 |
| CODEX_NEXT_STEP 原进度 | “尚未进入数据库/API”已过期；保留原阶段说明，新增当前进度和导航 |

产品定义以 Master Spec 为依据；实现细化仍为 Proposed。上述后续细化不等于追认所有技术决策。当前目录未发现运行时代码或 Git 历史，无法进行实现兼容性验证；API 的 Breaking Change 保持待与实际实现核验。

文档影响检查：更新入口、范围说明、工作台设计、P14 提示词及原件状态；未改变数据库结构、API 端点、产品总纲或 ADR 决策状态。没有代码、数据库或浏览器业务测试结果。

迁移后静态验证：39 份 Markdown、168 个本地文件链接全部存在、代码围栏配对正常；P00–P22 共 23 个定义，无缺失或重复。这是文档结构验证，不是软件测试通过。

## 7. 实施方向修订（2026-09-19）

用户明确要求参考借鉴成熟项目而非从头自研，也不照抄；已确认 DeepSeek Harness 的具体仓库。新增[复用策略](../architecture/reuse-strategy.md)和 [ADR-005](../decisions/ADR-005-reuse-first.md)，同步入口、技术选型、Runtime、部署候选及 P00/P05/P08/P09/P12。P00 从直接建工程改为先做源码研究、采用表和最小复用验证，之后再按实测结论搭建。

本节记录实施方向初次修订时的状态：当时只核对官方文档/仓库入口并调整计划，尚未固定源码提交、运行框架或选定依赖。后续实验状态见第 8 节。旧物理表设计仍为候选；选型后先消除框架 checkpoint 与自研 Step/恢复器的重叠，再写 migration。产品范围、业务事务不变量和既有 Proposed ADR 未被静默改为 Accepted。

文档影响检查：需求约束、架构、ADR、实施提示词、入口和交付记录已同步；无实际 API、数据库或代码变更，无软件测试成绩。

## 8. P00 源码研究与性能优先调整（2026-09-19）

用户进一步明确借鉴机制即可，无需复制成熟项目代码；语言服务于实现；延迟、吞吐和内存都优先。Rust 成为主要候选，原 Java/JDBC/Flyway 组合不再是工程前置。具体代码按用户指定交由 Luna xhigh。

已固定六个上游提交并阅读相关实现与测试，建立隔离的恢复、受控工具及性能实验。证据与局限统一维护在 [P00 研究记录](../research/p00-source-study.md)，此处不重复测试数字。研究缓存不纳入产品源码；没有生产后端、V001、真实模型集成或 PostgreSQL 验收结果。

文档影响检查：更新实施约束、技术选型、部署/适配说明、数据库类型与迁移表述、ADR 历史标记、P00/P01、测试范围及入口状态。未新增产品功能、API 端点或生产数据表，Master Spec 与业务不变量保持原样。当前没有版本发布，不额外创建 CHANGELOG/ROADMAP/KNOWN_ISSUES 空模板，进度与限制使用现有记录。

## 9. TypeScript-first 方案评审（2026-09-19）

用户要求评审所提供方案并同步技术选型文档，暂不写代码。当前工作区为 D:/Develop/Relay-Agent；前文迁入路径保留历史，不补写没有证据的移动过程。当前 Git 尚无提交，原有文件均未跟踪，本轮使用编辑前文档副本核对差异，不把全部未跟踪文件记为本轮新增。

推荐方向改为 TypeScript-first + 可选 Python 工具层，新增 Proposed 的 [ADR-006](../decisions/ADR-006-typescript-first.md)。原 Java/JDBC 提案标记推荐关系被接续；Rust 实验保留对照，不把原实验成绩转为新方案成绩。Master Spec 说明 Java 简历定位取舍，V1 架构和入口同步当前推荐。

评审修正了无证据的性能保证、任意外部效果只执行一次的承诺，以及将 pg-boss/FTS/全量包目录作为首版硬要求的倾向。Assist 写入权限保持原约束；人工阶段轮询，模型阶段按需 SSE；中文搜索保留字面匹配。审批恢复、UNKNOWN、两 Provider Spike 及共同冻结门槛统一维护在测试计划，不复制成另一套验收编号。

已核对官方 Node/PostgreSQL 版本状态及 SDK、Fastify、Kysely、队列的相关能力资料，引用见技术选型；文档能力核验不等于依赖安装、兼容构建或源码级 Spike。旧环境限制未重新检测。

文档影响检查：需求技术定位、架构、ADR、API 进程/实时阶段说明、数据库版本与类型映射、部署、测试规格、README、P00 和既有计划入口已同步。API Breaking Change：No（没有修改既有端点、字段或权限）；没有代码、DDL、软件测试或发布，不新增 CHANGELOG/ROADMAP/KNOWN_ISSUES 模板。文档差异与链接检查结果在本轮交付说明报告。

## 10. 文档归属整理与现有图驱动的 UI 规范（2026-09-19）

用户要求开始规范化文档，并明确 UI 设计规范依据现有设计图。使用原始论文验收页与三张页面概念图核对视觉共性，按 impeccable 的提取方法整理；未重新生成或修改图像，没有实现产品页面。

文档归属：新增[文档地图](../README.md)，当前阶段收敛至 CODEX_NEXT_STEP，旧任务正文完整移到[历史存档](archive/2026-09-18-initial-design-task.md)；task_plan/progress/findings 标记历史。当前架构入口明确为 domain-model，V1_ARCHITECTURE 保留早期假设，不再混入当期技术推荐；修正 prompts 的旧工作区路径和重复版本表。旧任务正文迁出前后文本比较一致，四份业务契约未变。

UI 产出：[设计系统](../frontend/design-system.md)定义图像依据、字体用途、页壳、断点、组件状态、可访问性和验收；[token 数据](../frontend/design-tokens.json)保存唯一数值与别名。图像像素采样用于归一颜色，推荐尺寸、交互状态和响应式明确为补充设计，不冒充原始源文件精确值。当前只建立浅色基线；字体实装、品牌显示名、移动视图和浏览器验证仍有待确认/验证项。

新增[轻量检查脚本](../../scripts/check-docs.mjs)，由 GPT-5.6 Luna xhigh 实现与修复。无第三方依赖，限定当前 Markdown 内联链接/ATX 标题及 token 数据格式，不是完整 Markdown 解析器或可访问性认证工具。

本轮验证：

- node --check scripts/check-docs.mjs 与 node scripts/check-docs.mjs 通过；122 个 token 的引用和 29 组指定纯色对比度通过。
- 临时夹具验证坏同文档锚点、中文/重复标题、缺图片、项目目录越界、别名循环/悬空/类型不符/null 值和低对比度的正确退出行为；夹具已清理。
- 当前 Node 22.22.3 仅用于运行文档工具，不作为候选 Node 24 生产组合的兼容证明。
- 未执行页面渲染、浏览器 E2E、完整可访问性验收、真实 PG 或 Provider Spike；不记为这些能力已通过。

文档影响检查：更新文档治理、架构导航、技术选型引用、UI 规范、验收链接、开发审计、README、提示词和当前状态。没有新增产品功能、业务 API/字段、数据库 migration 或运行架构取舍，因此不新增 ADR/发布模板；API Breaking Change：No。检查工具是本轮唯一新增的可执行代码，生产工程与依赖状态保持未实现/待验证。

## 11. Windows 桌面交付修订（2026-09-19）

用户明确选择“Windows 可安装应用，有独立窗口和启动入口”，因此旧浏览器交付假设不再适用。原 [ADR-003](../decisions/ADR-003-browser-workbench.md) 从 Proposed 标为 Superseded 并保留历史；新增 [ADR-007](../decisions/ADR-007-windows-desktop.md)。已确认的是产品交付形态，壳框架、安装与生命周期细节仍 Proposed，未自动将技术栈冻结。

优先验证 Tauri 2 + Node sidecar，Electron 作为同工作量对照；薄 Rust 壳管理窗口/启动/监管，TypeScript API/Worker 继续拥有业务应用职责。保留 loopback HTTP 与短期 Bearer，窄 IPC 只引导连接和生命周期，不开放第二领域写入口。补充独立 PG 前提、运行时分发、实例验证、关闭恢复、升级停机及卸载保留数据。资源收益、打包兼容、签名和进程树终止均未实测。

UI 沿用原有四张图，明确图像属于客户区，补充原生标题栏、窗口工作区限制、DIP/CSS 单位、多屏/DPI 和中文输入法验收。token 版本由 0.1.0 调整到 0.2.0：新增四个 window.content.* 推荐值；layout.main.mobilePadding 改为 smallPadding、control.height.touch 改为 comfort，原值保留。当前无组件消费者；已同步文档引用，不宣称已迁移运行中主题。小窗口重排仍保留，不再把手机视图列为本轮交付。

文档影响检查：同步产品总纲/范围、架构/选型、ADR、HTTP 连接边界、部署、前端规范/token、人工切片、测试规格、入口与 P00/P04/P13/P14/P20 提示词。业务 HTTP 路径/DTO、数据库模型和四份契约未变，业务 API Breaking Change：No；部署体验确有变化。当前状态仍只由 CODEX_NEXT_STEP 维护，不新建重复路线图、问题清单或发布模板。

验证：node scripts/check-docs.mjs 通过，本地链接/锚点、126 个 token 引用与 29 组指定纯色对比度通过；检索旧交付假设，剩余浏览器提案仅作已标记历史或开发辅助。未运行桌面构建/安装、窗口渲染、真实 PG、三个业务 Spike 或桌面 Spike。本轮只改 Markdown 和 token JSON，没有产品代码、依赖安装、原图修改或可用安装包。

## 12. Relay Skill 与项目蓝图设计提案（2026-09-20）

用户提供将 Relay Skill Layer 纳入产品、以 Goal-to-Project Blueprint 为首个能力的建议。本轮按设计整合处理：新增 [Skill 专题](../architecture/relay-skills.md)和 Proposed 的 [ADR-008](../decisions/ADR-008-declarative-skills.md)，在范围矩阵增加 F24 并映射 P11/P12/P14/P15。未建立产品代码、Skill 安装器、独立 Runtime 或页面生成器。

与原建议对照：既有 Assist 不产生 Run，故首个蓝图采用“先创建最小 Project，再 Assist 提案”；不伪造 Task/Run 容器。蓝图的项目事实和视图变化经预览后原子应用，Rules/Workflow/验证配置是独立确认的后续建议，防止工作台应用隐含改写执行约束。自由阶段示例收敛至内置类型词汇。原总纲 AI-generated Workbench 在 V2，V1.5 生成 Page Schema 明确保留为待确认前移，不静默重写里程碑。

文档影响检查：同步产品总纲/范围、架构职责/Runtime、ADR、API 设计、逻辑模型/物理待落实项、Workbench 交互、测试规格、README/地图、提示词和当前阶段。API Breaking Change：No（新增设计扩展，既有普通 Assist 路径保留；没有已发布实现的兼容实测）。未执行 migration；四份业务契约的 37 项编号、执行权与安全不变量不变。沿用现有审计和当前状态，不新增重复路线图、CHANGELOG 或问题清单。

对照中另发现 Milestone 的总纲建议尚无完整当前写契约，且现有 API 没有项目类型变更命令；已在专题/范围中标注，只保留建议，不编造 State 字段或绕过类型规则。

验证：运行 node scripts/check-docs.mjs，全仓检查未通过；当次 12 处错误均来自本轮未修改的 docs/frontend/page-development-prompts.md，指向缺失的 mockups 说明/图片。本轮变更文档未报告链接/锚点错误，126 个 token 和 29 组指定对比度未报告错误。未修改该页面提示词或伪造缺失图片；需其产出齐备后重跑全仓检查。Skill/Blueprint 业务验收、真实 PG、UI 和 migration 均未执行，不计为通过。

## 13. 首批闭环 Skill 的范围与边界（2026-09-20）

用户补充八项核心 Skill 及后续/领域组合建议，经对照现有契约评审后明确要求“加进去”。将任务定义、项目恢复、验收方案与蓝图列为 F24 首批目标；蓝图保留展示旗舰，工程优先前三项。修复、交接和确定性状态提交复用既有核心能力，按需包装；Decision Capture 后续补充，其余目录作为候选保存在同一 Skill 专题，不新增重复规格或八套运行系统。

关键修正：验收方案先于 Delegate 确定；产物修复后新版本需验证，Checker ERROR 不触发改产物；交接资料生成不等于执行权转移，真实 Handoff 后再 Delegate 创建新 Run；确定性 delta 只能由完成用例计算并同事务提交，模型推断仍需确认。Resume 不把聊天、旧完成/决定或无基线的变化当当前事实。移除无依据的时长预测，区分智能 Knowledge 提升建议与已有显式提升能力。

文档影响检查：更新 Skill 专题、范围、产品总纲、ADR-008、Runtime、API 边界说明、Workbench 交互、测试规格、D 阶段提示词、地图和当前状态。方向已确认，技术细节仍 Proposed，未声称功能实现。API Breaking Change：No，本轮未新增公开路径或正式 DTO；数据库继续复用既有 Task/State 提案、Manifest、Run/Step、Artifact 与来源设计，无新增字段或 migration。检查了 README/路线图/已知问题/发布记录的归属，继续使用已有入口与审计，不制造重复文件；四份契约和原验收编号不变。

验证：修改前后运行 node scripts/check-docs.mjs，均报告同一组 12 处页面提示词缺失图像/目录链接；全仓检查仍未通过，本轮文档未新增检查错误。已核对首批与后续范围、核心 Owner、委托前验收和完成/交接边界的一致性。未运行产品测试、真实数据库或 UI；新增验收仅为规格，未修改无关图片或页面提示词。

## 14. 统一扩展组合、版本 Eval 与恢复边界（2026-09-20）

用户提供 Pack/Blueprint/Profile/Recipe/Proposal/Adapter/Eval/Trigger 建议，评审后明确要求修改文档并补充必要内容。沿用 relay-skills.md 扩展为同一专题，不另建重复扩展规格；产品入口名称改为“从目标创建项目蓝图”，保留原名来源说明。首批四项 Skill 不变，V1 增补最小第一方 Thesis/Development Pack 清单、基础版本 Eval 与既有 Manifest 的轻量来源视图，不要求实现全部候选领域能力。

补充固定成员/依赖版本与兼容校验，区分定义可用、提案选择、配置应用和实际授权；Profile 各归原模块，Recipe 复用 WorkflowVersion，Proposal 统一体验而不成为万能写 Owner。包更新保留用户修改并重新计算影响，自动发现不等于自动应用。配置恢复是新 revision，不能回滚外部效果、恢复旧审批/PASS/执行权。来源视图重新鉴权，不泄露未授权对象元数据；Eval 区分工程回归、任务 Verification 和可选论文研究。Importer/Trigger/Project Checkpoint 仅补后续边界，未创建实际自动化。

文档影响检查：同步总纲、范围、领域模型、扩展专题、Runtime、ADR-008、API 边界、逻辑/物理存储待落实项、前端交互、工程测试与研究边界、部署备份、D/F 实施提示词、README/地图和当前状态。API Breaking Change：No（设计补充，无新增已发布接口；实际 DTO/客户端兼容待冻结）。逻辑模型新增可选 Pack 来源及实际 Profile/Recipe 引用要求，未生成或执行 migration；旧记录不伪造回填。沿用现有当前状态与审计，未新增重复 ROADMAP/CHANGELOG/KNOWN_ISSUES；四份核心契约保持原 Owner、安全和恢复规则。

验证：修改前及补充后运行 node scripts/check-docs.mjs，仍只有原有 12 处页面提示词缺失图片/目录链接；本轮文档未报告新增错误，全仓检查不记为通过。人工复核名称、首批/后续分期、Pack 权限、Profile 职责、Eval 与 Verification、回滚边界和来源隐私；无产品代码、模型 Eval、真实 PG、UI 或备份实测。

## 15. 全套页面效果图与开发提示词（2026-09-20）

根据用户原图延展基础工作台和关键状态，交付28张生成图、1张用户参考及29个逐页开发单元。使用内置 Image Gen，保留5张修正版的原图；当前入口统一指向修正版。完整文件与生成记录见[效果图目录](../frontend/mockups/2026-09-19/README.md)，复制执行入口见[页面开发提示词](../frontend/page-development-prompts.md)。修正本地 Git 与远端文案混淆、暂停对象、委托前状态和可选项目等语义；仍有图像导航/徽标/小字偏差，已记录实施规则。

文档影响检查：维护工作台交互文档的静态产出节、文档地图和当前状态的UI证据行；不覆盖同时进行的扩展模型设计。需求、架构、ADR、API、数据库和测试规格未改变，无代码、迁移或发布变更；沿用本审计记录，不新建重复路线图/变更记录。后续新增扩展模型界面不计入本批覆盖。

验证：node scripts/check-docs.mjs 检查通过；此前记录的12处缺失图像/目录链接已随本套产出齐备而消除，历史失败记录保留。另核对29个唯一图片引用的存在性、PNG签名与尺寸、29个开发提示词章节及5个当前修正版入口，全部通过。没有执行产品业务测试或真实桌面验收，静态设计不代表产品已实现。

## 16. 后端开工检查与 P00 验证准备（2026-09-20）

用户要求开始后端编码，准备未完成则继续，并指定 Terra 极高执行。核对当前状态、研究证据、P00 提示词及技术冻结条件后，发现文档设计已形成，但真实 PG、AI SDK/Provider、恢复和桌面验证仍有缺项。本轮从隔离实验继续，未绕过出口生成生产后端或 V001。

实际使用 GPT-5.6 Terra xhigh 分别承担数据库基础与 SDK 边界实验；主 Agent 核对源码、证据与文档。建立项目内便携 Node/PostgreSQL，保留系统环境；补充 Kysely 内容哈希完整性验证，并用已安装精确版本的事务实测纠正源码推断。运行范围、命令、依赖与结果统一见 [P00 研究记录](../research/p00-source-study.md#7-后端开工前准备接续2026-09-20)及其链接的实验说明，不在本文重复维护测试成绩。

文档影响检查：同步 AGENTS、当前状态、技术选型/ADR-006 的授权时间边界、实验入口、测试规格说明及 [P00 Terra 接续提示词](../../prompts/00-foundation.md#terra-后端开工接续提示词)。清除当前入口仍指示 Luna 或“本轮暂不写代码”的冲突，保留历史实验与决策记录；人工切片引用当前状态，不再复制已失效的数据库环境描述。产品范围、四份契约、业务 API、数据模型和桌面交付承诺没有改变；API Breaking Change：No。新增 SQL 为实验夹具，不是正式 migration；不新建重复路线图、发布记录或 ADR。

准备实验通过不等于三个完整业务 Spike、生产栈冻结或 P01 已完成；后续同轮继续补跨进程审批/UNKNOWN 与最小桌面宿主实验，结果及未覆盖项仍统一放在研究记录。外部配置不足的真实 Provider 和未完成的完整恢复、桌面与性能验证继续保留。新增提示词要求逐段核对出口，首批生产后端从 P01 开始，不一次生成全部平台。

收尾验证：主 Agent 独立复验数据库基础、SDK 边界、跨进程恢复及桌面 release 路径；具体版本、运行 ID 与证据范围见研究记录。node scripts/check-docs.mjs 通过，人工核对授权、当前/历史状态和未覆盖出口；没有生产后端、业务 migration 或 API 变更，前端并行任务保持独立。

## 17. 后端工程骨架与 P01–P03 交付（2026-09-20）

用户要求开始后端编码。本轮先补齐并收紧 P00 恢复证据：主恢复 Worker 增加与资源/claim 的联合准入和结果提交、持久化两步推进、PASS/CompletionRecord 完成短事务及控制/完成的两种确定提交顺序；只读审查发现的三处空转断言（硬编码计数、注入点之前的恒零计数、"有界收敛"）与两处弱判据（PID 存活、锁等待未校核阻塞者）已修复，并用两次故意破坏运行证明断言可失败。随后按用户放行决定建立最小生产工程与 P01–P03。实现范围、断言与边界统一见[恢复实验说明](../../experiments/recovery-p00/README.md)与 [P00 研究记录](../research/p00-source-study.md#联合提交步骤推进与业务完成第三批证据2026-09-20)，本文不重复维护测试成绩。

交付形态：仓库根 pnpm workspace（只纳入 `apps/api`）与 Fastify/Kysely/TypeBox 后端，含配置外置与失败即退出、loopback Bearer、Host/Origin 边界、Problem Details、liveness/readiness 与退出处理；V001/0002 真实 migration 含复合与延迟外键、周期唯一、不可变表只读与真实双角色权限；Project/Goal/Task/State 应用用例与 HTTP；Artifact 受管内容存储与不可变版本、人工接受、完成/重开短事务。命令与配置示例写在根 README，未实现能力（Run/Verification/Worker/Gateway/OpenAPI/桌面壳/安装包）在其中单列。

文档影响检查：同步[当前状态](../../CODEX_NEXT_STEP.md)、根 README、[物理设计](../database/physical-design-postgresql.md)（追加 §11–§13 的 migration 内容、兼容性与回滚风险、存储布局）、[HTTP 契约](../api/http-command-contract.md)（追加 §10 实现状态与差异）及本文。首次发布 `/api/v1/workspaces/{id}` 下的人工切片端点；此前没有已发布接口与消费者，因此对既有集成方无破坏性变更，与设计正文的差异只在实现状态节记录。四份契约、产品范围与验收编号未改；未新增 ADR，也未新建重复路线图或发布记录。

验证：主 Agent 在最终源码上独立复跑——恢复实验 39 场景 PASSED（203 子进程、0 超时、`pg_ctl stop` 退出 0、无残留、输入摘要一致）；工程验收 4/4 与 30/30、P02 56/56、P03 69/69 真实 PostgreSQL 集成测试通过，单测 7/11/22/28 全绿，临时集群与 data_root 均清理，`node scripts/check-docs.mjs` 通过。仍挂账：Spike 3（无两个真实 Provider 端点）、多产物与人工处置链、生产权限/Gateway、桌面宿主剩余边界、固定工作量性能预算；挂账不等于通过，也不支持冻结 ADR-006/007。没有业务闭环 UI、桌面窗口或安装交付。


## 18. 技术选型适配、React 桌面迁移与 goal 提示词（2026-09-23）

用户先要求按 Agent Stack 附件增量接入，后明确全部既有界面迁移 React、做桌面端，再将本轮范围改为文档体系、提示词和配合 goal 的总提示词，并要求按项目实际选栈。核对代码后确认当前为 Vue/Fastify/Kysely/PG，有 Run/Review/控制与 Fake Gateway，无生产 SSE、LangGraph、独立 Agent Worker 或真实 Coding CLI。

新增 ADR-010 记录选择：React 全量迁移、Tauri 2 + Node sidecar 优先实施；保留 Kysely/PG，分发优先 PG 持久 command/outbox，不因原始附件增加 Drizzle 和 Redis/BullMQ；LangGraph/PostgresSaver 先验证适配出口。原始附件正文保留并标注来源角色，ADR-006 部分接续，ADR-007 保留桌面边界。当前技术选择、当前状态、工作包、验收规格与执行总提示词各有唯一主文档。

新增 M01–M07 工作包和 goal 提示词，原 P00–P22 保留业务索引与历史。具体开发使用 gpt-6-sol / ultra，执行者自检后协调 Agent 独立验收，失败修复复验，通过后继续。Mock 创建/SSE/审批/取消/故障恢复门槛先于真实模型；React 迁移与 Windows 安装分别有证据出口。

文档影响检查：同步需求入口、架构/ADR、Runtime、API/数据库迁移计划、部署、前端规则、测试规格、README/AGENTS/文档地图/当前状态与原阶段提示词。本轮 API Breaking Change：No；无生产代码、依赖、锁文件、DDL 或数据库迁移，没有启动 goal。历史测试数字未复跑，不声称新栈、模型、React 或桌面已完成。文档检查结果以本轮实际运行输出为准。

本轮实际修改文件（32 个，均为 Markdown）：

~~~text
AGENTS.md
Agent_Stack_Integration.md
CODEX_NEXT_STEP.md
Personal_Workflow_OS_Master_Spec.md
README.md
contracts/README.md
docs/README.md
docs/architecture/technology-selection.md
docs/architecture/runtime-context.md
docs/decisions/ADR-006-typescript-first.md
docs/decisions/ADR-007-windows-desktop.md
docs/decisions/ADR-010-agent-stack-react-desktop.md
docs/deployment/local-deployment.md
docs/frontend/workbench-design.md
docs/frontend/design-system.md
docs/frontend/page-development-prompts.md
docs/api/http-command-contract.md
docs/database/physical-design-postgresql.md
docs/requirements/v1-scope.md
docs/testing/verification-plan.md
docs/development/design-audit.md
prompts/README.md
prompts/00-foundation.md
prompts/A-human-core.md
prompts/B-workflow-verification.md
prompts/C-recovery-gateway.md
prompts/D-context-product.md
prompts/E-real-adapters.md
prompts/F-release-research.md
prompts/ui-first-four-terra.md
prompts/stack-migration.md
prompts/goal-stack-migration.md
~~~

已执行：node scripts/check-docs.mjs，检查通过（Markdown 68 个、链接 808 个、标题锚点 853 个、设计令牌 126 个、对比度 29 条）。另核对当前/历史入口、模型路由、Mock 前置门槛及 32 个实际文档路径与 UTF-8 内容；未执行产品类型检查、构建、数据库、模型或桌面测试，因为本轮没有代码变更。
