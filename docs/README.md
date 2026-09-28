# 文档入口与维护规范

当前改造导航（2026-09-24）：[ADR-010](decisions/ADR-010-agent-stack-react-desktop.md)记录技术取舍与用户决定；[技术选型](architecture/technology-selection.md)维护目标组合；[CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)独占当前模块状态；[大模块提示词](../prompts/stack-migration.md)维护工作包；[验收门槛](testing/verification-plan.md#10-技术栈改造的大模块验收)维护出口；[goal 提示词](../prompts/goal-stack-migration.md)是长期执行入口；[M01 开发记录](development/m01-stack-baseline.md)保存基线和适配证据。原始 [Agent Stack 附件](../Agent_Stack_Integration.md)作为来源保留，已适配项以 ADR-010 为准，不重复维护第二份技术真相。

角色：当前文档地图与维护规则。更新：2026-09-21。

2026-09-26 产品补充接续导航：[执行映射](../prompts/README.md#产品补充的执行映射)将产品总纲第 0.2/0.4 节接入总提示词、模块、分阶段与[逐页提示词](frontend/page-development-prompts.md#后续产品补充与页面映射)。该映射负责分派入口与范围判定，不替代产品定义或当前进度。

本文定义每类内容的主文档、阅读顺序和变更检查，不复制技术选型、业务状态枚举或项目进度。协作约束见 [AGENTS](../AGENTS.md)，当前阶段、缺口与下一步只在 [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)维护。新接手者从这三处进入，不从历史提示词判断当前授权或实现状态。

## 1. 唯一事实源

“当前”指现在应读取的设计版本，不代表已批准或已实现。下表每一行只指定一个主入口，详细规则在主入口所链接的所属文档维护。

| 内容 | 主文档 | 边界 |
|---|---|---|
| 产品定义与目标 | [Master Spec](../Personal_Workflow_OS_Master_Spec.md) | 不重复维护技术依赖版本和实时进度 |
| V1 最小范围与阶段覆盖 | [范围矩阵](requirements/v1-scope.md) | 对照产品定义，不以第一切片代表完整 V1 |
| 当前阶段、阻塞、下一步 | [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md) | 历史研究日志不另写一份当前进度 |
| 业务不变量 | [契约包](../contracts/README.md) | 01–04 分别拥有事实、执行、验证、恢复；其他文档引用 |
| 当前架构与模块职责 | [领域模型](architecture/domain-model.md) | 架构主入口；运行/信息/工具专题补充实现边界 |
| 共享知识来源与长期信息 | [信息与计划](architecture/information-planning.md#11-人和-ai-共用知识来源) | 人与 AI 同源的版本、原件及收录边界；阅读交互归工作台第 12 节，产品定义归 Master Spec 第 33/90 节 |
| 扩展组合、Skill 与蓝图协议 | [Relay 扩展模型](architecture/relay-skills.md) | Pack/Profile/Recipe/Proposal 复用既有模块，设计仍 Proposed；API/存储字段和 Eval 规格各归所属文档 |
| 主栈、可选依赖与冻结门槛 | [技术选型](architecture/technology-selection.md) | 不在 README、提示词或 UI 文档复制版本表 |
| 决策理由与替代关系 | [ADR 入口](#3-决策与历史) | 保存为什么；不代替当前实现证据 |
| 逻辑数据关系 | [逻辑模型](database/logical-model.md) | 物理类型/索引/锁协议见其对应物理设计 |
| 数据库物理约束 | [物理设计](database/physical-design-postgresql.md) | DDL 片段不是已执行 migration；未来以实际 migration 核验 |
| API 命令与错误 | [HTTP 契约](api/http-command-contract.md) | 模块补充见 [module-api](api/module-api.md)，同一字段只在所属接口定义 |
| 页面结构与业务交互 | [工作台交互](frontend/workbench-design.md) | 路由、命令、状态与权限，不拥有 token 色值 |
| 页面效果图与开发输入 | [页面开发提示词](frontend/page-development-prompts.md)、[效果图目录](frontend/mockups/2026-09-19/README.md)、[最新知识库图](frontend/mockups/2026-09-27/README.md) | 原批次32张生成图与1张原始参考，另补充3张知识库图；仍为33个页面/状态单元，不代表实现或新增路由 |
| UI 视觉、组件与适配 | [设计系统](frontend/design-system.md) | 基于现有图；组件外观与可访问性交互，不重定义业务状态 |
| UI 数值与语义别名 | [design-tokens.json](frontend/design-tokens.json) | 数值唯一来源；图片、提示词和 Markdown 不另维护可冲突数值表 |
| 前端预览实现与验收 | [前端预览记录](development/ui-preview-acceptance.md) | 按批次记录已实现交互、自测证据与待验证项；不是桌面验收 |
| 验收规格与分层证据要求 | [测试计划](testing/verification-plan.md) | 规格不是结果；研究结果引用原记录 |
| 前后端独立验收证据 | [2026-09-21 验收](testing/frontend-backend-acceptance-2026-09-21.md) | 当前已实现范围的复跑、补充反例与问题；不替代阶段主文档 |
| 独立修复与调整任务 | [验收修复提示词](../prompts/remediation/README.md) | 与原开发提示词分开；以各 R 记录的执行与证据边界为准 |
| 部署、身份与运维 | [本机部署](deployment/local-deployment.md) | 当前为设计；实际启动命令在有工程后写根 README |
| 研究证据 | [P00 研究记录](research/p00-source-study.md) | 固定来源、运行结果、限制；不替代生产能力证明 |
| 开发/文档变更的原因 | [设计交付审计](development/design-audit.md) | 按时间追加记录，不承担最新状态表 |
| 25–27 日产品补充实施证据 | [25 日恢复与成果](development/product-supplement-2026-09-25.md)、[26 日人工待处理与验收](development/product-supplement-2026-09-26.md)、[27 日知识阅读与收录](development/product-supplement-2026-09-27.md) | 条目映射、实际代码、自检与协调复核边界；当前进度仍归 CODEX_NEXT_STEP |
| 实施任务入口 | [prompts](../prompts/README.md) | 引用主文档；提示词只能在当前用户授权范围内执行 |

代码描述实际实现；契约描述目标约束；ADR 描述取舍；测试结果描述已证实范围。冲突时核对这四类证据，不能用“谁更新得晚”自动裁决，也不能因历史图里有某项功能就扩大范围。

## 2. 文档角色、状态与来源

关键当前文档在开头说明角色/范围、状态、更新日期及主依据。已有日期/状态块可直接补充，不要求统一 front matter，也不为格式重写所有历史记录。

| 维度 | 用法 |
|---|---|
| 文档角色 | 当前主文档、专题补充、历史材料、证据记录、生成来源；决定如何阅读，不表达实现程度 |
| Proposed / Draft | 推荐或待讨论，不是默认批准；明确未决条件和验证出口 |
| Accepted | 有明确接受依据的决策；只在注明范围生效，不代表代码完成 |
| Superseded / Deprecated | 链接接续文档并保留历史，不删除取舍依据 |
| 实现/验证状态 | 单独写未实现、已实现待验收、实际证据及限制；不把 Passed 当文档审批状态 |

实现建议、图像采样值、推断和待确认信息必须标明来源性质。资料来源是图片时，不把观察到的像素或生成内容当成 CSS 真值、真实业务数据、源码或测试证据。

日期标记更新发生时间，不自动作状态优先级。历史环境信息写明当时检查，不持续用“当前可用”描述旧检查结果。具体路径优先使用仓库相对链接；仅启动配置和工作区定位需要绝对路径。

## 3. 决策与历史

当前决策集合：[ADR-001](decisions/ADR-001-domain-boundaries.md)、[ADR-004](decisions/ADR-004-user-import-origin.md)、[ADR-005](decisions/ADR-005-reuse-first.md)、[ADR-006](decisions/ADR-006-typescript-first.md)、[ADR-007](decisions/ADR-007-windows-desktop.md)、[ADR-008](decisions/ADR-008-declarative-skills.md)、[ADR-009](decisions/ADR-009-rule-revision-fence.md)、[ADR-010](decisions/ADR-010-agent-stack-react-desktop.md)、[ADR-011](decisions/ADR-011-project-archive-serialization.md)、[ADR-012](decisions/ADR-012-windows-file-io-handle-boundary.md)。分别以各文件状态为准；此列表不统一批准它们。[ADR-002](decisions/ADR-002-postgresql-jdbc.md)保留早期持久化技术提案，[ADR-003](decisions/ADR-003-browser-workbench.md)保留已被 Windows 桌面要求替代的浏览器提案。

2026-09-20 新增 [ADR-008](decisions/ADR-008-declarative-skills.md)：声明式 Skill 与蓝图应用，技术方案状态 Proposed；同日用户确认纳入评审后的首批闭环方向，目录统一见 Skill 专题。V1.5 AI Schema 生成的范围前移仍待确认，详见范围矩阵。

| 历史材料 | 保留目的 | 当前替代入口 |
|---|---|---|
| [原始架构评审](../architecture-review.md) | 问题与取舍来源 | 契约包、领域模型 |
| [早期 V1 架构稿](architecture/V1_ARCHITECTURE.md) | 早期模块和状态语义 | 领域模型及主题设计；不再向旧稿正文同步新栈 |
| [初始设计任务](development/archive/2026-09-18-initial-design-task.md) | 当时的任务范围和停止条件 | CODEX_NEXT_STEP、当前用户指令 |
| [task_plan](../task_plan.md)、[progress](../progress.md)、[findings](../findings.md) | P00 研究过程快照 | 当前进度只看 CODEX_NEXT_STEP，实验事实看 P00 研究记录 |
| [图像生成提示词](frontend/mockups/2026-09-19/prompts.md) | 生成依据与示例文案来源 | 交互规范、设计系统和 tokens |

历史材料不追加当期实现指令；只有必要的角色标记、勘误与接续链接。旧记录中的路径、日期和测试数字按当时范围保留。

## 4. 变更规则与验收

变更先定位主文档，再修改其事实和理由；入口只更新链接或必要摘要。不要靠复制整段设计在多处“同步”。架构取舍改变时更新对应专题和 ADR；技术版本改变时更新选型/锁文件；UI 数值改变时改 token，交互改变时改工作台文档。

产品设定或验收要求发生变化时，同时检查执行入口：`prompts/README.md` 的映射与接续块、goal 总提示词、M 模块与交接模板、受影响 P 阶段和逐页提示词。入口给出主文档引用、本次责任、范围判定与证据要求；只增加链接而不更新冲突的执行指令不算同步完成。仍为 Proposed 的内容保留待定项，已授权工作不因未选定探索项一律停止；历史提示词及修复/验收证据只保留接续导航，不改写历史范围或成绩。

结束前执行 Documentation Impact Check：需求、架构、ADR、API、数据库、开发记录、测试、README、路线图、变更记录、已知问题。仅更新受影响项；目前不为清单齐全创建空的 ROADMAP/CHANGELOG/KNOWN_ISSUES。阶段缺口放当前状态，改动经过放既有审计，实验限制放研究记录。

当前文档验收至少包括：唯一主入口、明确状态、历史不冒充当前、相对链接可达、没有新重复数值源；UI 还需 token 引用和对比度检查。语义一致性仍需人工核对，脚本不能证明产品契约已经实现。

## 5. 轻量检查

仓库根目录运行：

```sh
node scripts/check-docs.mjs
```

使用 Node 内置模块，无依赖安装；这是文档工具，不是生产 Node 版本兼容证明。检查主要入口和 docs/contracts/prompts 中的本地 Markdown 链接与标题锚点，以及 token JSON 的别名、类型和指定对比度组合。不会访问网络、读取凭据、运行实验或修改文件。

非零退出时修复错误再交付。远程页面有效性、文案事实、像素还原、实际 CSS 对比度、键盘/辅助技术行为和技术兼容性不在此脚本证明范围。未来确有工程后再把 OpenAPI/migration/token 消费者的对应检查接入工程，不提前建立通用文档平台。
