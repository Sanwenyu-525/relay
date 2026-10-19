# ADR-023：内置官方 GitHub Skill 进入 V1 主线

## 状态

Accepted（范围前移与首片边界）。2026-10-17 用户否决「留在 post-V1 可选分支」，明确要求把内置 GitHub Skill **移入 V1 主线**。本 ADR 记录该决策与首片边界；同日只读首片已实施到开发自检（源码、迁移 `0103`、官方原文入库，记录见下文），但**没有随包资源接线、官方包登记或安装包验证，整体未验收**。技术细节中标为待确认的三项（见「后续」）不因本 ADR 或首片实施自动批准。

## 日期

2026-10-17。

## 背景

用户需要的体验是一句话（例如「把当前修改提交并创建 PR」）就能让 Relay 完成 GitHub 工作，且**开箱即用**：不要求最终用户自行下载 Skill，也不要求先搭一个 GitHub MCP Server。

既有处置与此冲突：[后续路线第 4 节](../requirements/post-v1-roadmap.md#4-后续候选的处置)把「外部 Coding Worker、GitHub/MCP」列为可选开发分支，进入条件包含一个用户选定执行入口、稳定会话/回执、审批与停止能力验证，并要求另立 ADR。本 ADR 就是那个另立的取舍记录，同时替代该行对 GitHub 部分的后置处置。

仓库当时的相关事实（决定本片能复用什么、不能走捷径）：

* Skill 定义随应用发布，由只读注册表解析，且[明确禁止把引用解析成文件路径、远程 schema 或动态模块](../architecture/relay-skills.md#2-定义与版本绑定)；`FIRST_PARTY_REGISTRY` 被冻结、归档并参与备份包逐字校验，项目已为此把执行型方法单独放一张表（[扩展专题 §9.5](../architecture/relay-skills.md#9-内置工作方法与可定制-skill)）。
* 可外部编辑的 `SKILL.md` 目录与个人/项目定制（BC-05）仍是设计，目录发现、元数据格式与同名选择规则未冻结。
* Git 只读/写动作已有适配器与核对：`GIT_WRITE` 因可用 commit sha 与 remote ref sha 核对而标 `resumable: true`；`CLI_RUN` 因任意命令不能盲目重放而标 `resumable: false`，失败即 UNKNOWN 并阻断后续冲突执行。
* 受控 CLI 的可执行入口由连接上的 `allowed_executables` 点名准入，模型输出不构成授权。
* 项目内没有任何 GitHub 相关代码、端点或资源。

## 候选方案

| 决策面 | 候选 | 选择与理由 |
|---|---|---|
| GitHub 操作后端 | 自研 GitHub MCP Server / 官方 `gh` CLI / 直接打 REST API | **`gh` CLI**。免费开源，认证由 CLI 自身管理，进程取消、超时与输出捕获可直接复用受信 CLI 通路；MCP Server 会新增一个常驻服务和第二套凭据面，REST 直连会绕过既有的可执行准入 |
| Skill 定义落点 | 塞进第一方冻结注册表 / 与方法表同构的独立官方包登记 / 直接读随包 `SKILL.md` | **独立登记**。第一方那张表逐字参与备份包校验，加入新成员会改变归档契约并破坏既有回归；直接读文件目录要求 BC-05 先行，而它未实施。BC-05 落地后再迁移为文件形态 |
| 上游内容 | 重写一份 Relay 版说明 / 原样内置 / 原样内置加一层 Relay 边界附录 | **原样加附录**。保留官方 `gh` Skill 原文与许可，不改写正文；Relay 的边界（哪些子命令获准、写动作需审批、`gh api` 的处置）写在独立附录里，由 Gateway 与策略强制执行，不靠 Skill 文字自律 |
| 首片范围 | 只读 + 写一次交付 / 只读先行 | **只读先行**。PR 创建、评论、关闭 Issue 是外部副作用，当前无可查询的核对路径；按 AGENTS.md「UNKNOWN 先核对」，没有核对手段的写动作不能准入门 |
| `gh` 二进制分发 | 只检测系统 `gh` / Tauri Sidecar 随包 | **首版只检测系统 `gh` 并给安装引导**。随包 exe 会增大安装包、引入版本跟随与随包可执行文件的信任面；扩展点保留 |
| 凭据归属 | Relay 自建 token 存储 / 交给 `gh` 的凭据存储 | **交给 `gh`**。Relay 不落盘、不读取、不转存；聊天历史、日志与 Skill 文件不得出现凭据 |

## 最终决策

GitHub 内置 Skill 作为 V1 交付项 `[F25]` 进入主线，归 E 阶段（工具适配器），范围与前置唯一记在[范围矩阵的内置 GitHub Skill 补充](../requirements/v1-scope.md#内置-github-skill-范围补充)。

首片只做**只读**：仓库信息、Issue 查看与搜索、PR 查看与 diff、CI/Actions 运行状态与失败日志、Release 查看。调用走受信 CLI 通路，绑定当前 Workspace 的受管根，参数以结构化数组传入、优先 `--json` 取结构化结果。未安装 `gh`、未登录、目录不是 Git 仓库或没有 GitHub remote 时如实报告并给引导，不猜、不用其他仓库顶替。

写入分两片，各自另立工程协议后才开工：本地写（暂存/commit/push）**复用既有 `GIT_WRITE`**，不新建第二套提交链；GitHub 侧写（创建/更新 PR、创建/更新 Issue、评论）需要一个新的可核对入口，其「是否已生效」必须能用只读查询证实（例如按 head ref 与分支查 PR），核对协议未冻结前该动作不进入 Gateway 词表。高风险动作（合并、关闭、强制推送、删除）保持人工审批，且批准不覆盖已撤销的权限。

不新增 GitHub capability、不建 GitHub MCP Server、不建独立的 GitHub 管理页面或配置表单——Skill 列表、任务状态、工具调用日志与既有审批交互是唯一 UI 面。

## 实施前核对与偏离（2026-10-17）

按「开始执行」核对真实执行通路后，发现本 ADR「不新增 GitHub capability」那一句**建立在错误假设上**：项目里不存在合法的只读外部 CLI 通路。四条源码事实：

1. `RUN_BUILD`/`RUN_TEST`/`CLI_RUN` 一律映射到 `CLI_RUN` 能力（[gateway-actions.ts:266](../../apps/api/src/application/gateway-actions.ts)），而该能力的描述符是 `effectKind: WRITE`、`resumable: false`、`approvalPassthrough: false`（[adapter-metadata.ts:82-91](../../apps/api/src/gateway/adapter-metadata.ts#L82-L91)）——每次只读查询默认要人工批准，失败即隔离，核对函数恒返回 UNKNOWN（[cli-adapter.ts:236](../../apps/api/src/cli-worker/cli-adapter.ts#L236)）。把「查 PR 状态」建模成写效果是语义错误，不是配置问题。
2. 会话读取来源的词表只放 `FILE_READ`/`FILE_QUERY`/`GIT_READ`/`COMPUTER_READ`（[gateway-actions.ts:169-170](../../apps/api/src/application/gateway-actions.ts#L169-L170)），不含 `CLI_RUN`。走 CLI_RUN 时，用户在聊天里问「这个 PR 什么情况」必然被拒，只有 Run 内能跑——与「一句话完成」的产品要求直接冲突。
3. CLI 入口必须是**绝对路径且实测存在的文件**，逐项写死在 `CLI_RUN` 连接的 `allowed_executables`（[gateway-commands.ts:150-183](../../apps/api/src/application/gateway-commands.ts#L150-L183)），且连接**只有创建与禁用，没有更新端点**（[gateway-api.ts:85-123](../../apps/api/src/api/gateway-api.ts#L85-L123)）。系统 `gh` 因此要用户手填安装路径、每次改都要重建连接——「开箱即用」不成立。
4. 项目对同类问题已有先例：`git` 只读自带 `GIT_READ`；2026-10-16 的迁移 `0092` 为桌面只读观察新增 `COMPUTER_READ`（effect `READ`），并逐条重述 `ck_logical_operation_resource` 的既有分支（0054/0060/0087 的教训）。

**修订后的决策**：GitHub 只读走**新增 `GITHUB_READ` 能力 + 专用只读 adapter**（按名解析 `gh`，与 `git` 适配器同一口径依赖 PATH，结构化参数、`--json` 取结果），照 `0092` 的先例出一条迁移并逐条重述受影响的 CHECK 分支。**替代方案 `CLI_RUN` 复用被否**，理由即上表 1–3。原句其余部分继续有效：仍不自研 GitHub MCP Server、不新增 GitHub 页面或配置表单、写动作不在首片。

代价随之变化：首片不再是「零迁移」，它要动权限词表、`gateway_capabilities` 与只读来源词表，并需要新的连接类型；因此测试范围必须包含迁移的分支完整性与既有能力的回归，不能只测新读通路。

## 首片实施记录（2026-10-17，开发自检）

**已落地。** ① 上游 `gh` Skill 原文、MIT `LICENSE` 与 `UPSTREAM.md` 存于 `apps/api/skills/builtin/gh/`，固定提交 `4537a92…`、`SKILL.md` SHA-256 `49e3798…f7caad`，正文未改写；② 迁移 `0103` 登记 `GITHUB_READ`（`REAL`/`READ`）并完整重述 `ck_logical_operation_resource`，只放行 `ASSISTANT_READ`/`AGENT_SESSION_READ` 且必须绑定受管资源；③ `github-adapter.ts` 只认本地 `git` 解析出的 `github.com` remote、argv 结构化数组、环境白名单、超时/取消、有界投影与类型化失败；④ 四个只读工具进入工具目录与会话只读词表，按 ACTIVE 连接逐轮激活；⑤ 逐动作 Permission、停用连接即收回、与 `FILE_READ` 共存。证据：`github-read.test.ts` **16/16**、真实 PostgreSQL 上 `github-read.integration.test.ts` **8/8**，`0103` 在真实迁移链中应用成功；被 CHECK 重述影响的既有套件回归结果见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。实现边界唯一记在[工具适配器 §4.1](../architecture/tool-adapters.md#41-github-只读查询01032026-10-17-开发自检)。

**2026-10-18 增量**：只读动作由四个扩到五个（新增 `GITHUB_ISSUE_VIEW`，仍属 `GITHUB_READ`，无迁移、无权限分支）。本决策的其余边界不变：写动作仍须先冻结核对协议，官方包登记与运行时提示注入仍未建。

**未落地。** 官方包独立登记表/API、随包资源与 `bundle.resources` 接线、运行时提示注入、内置项禁用设置、BC-05 文件形态迁移均不存在；GitHub 侧写动作未开工；本机没有安装 `gh`，已认证的真实读取与限流/权限错误只能靠单元与注入式探测验证，不能算真实服务取证；真实 Windows 窗口、安装包与独立验收未做。首片不构成 F25 验收通过，也不满足「一句话提交并创建 PR」。

## 决策原因

用户要求的能力真实存在且可复用：官方 `gh` Skill 提供 Agent 使用 CLI 的成熟模式，Relay 侧的执行、准入、取消与核对机制已经就位，把它接成「连接允许清单里多点名一个可执行文件」远比自建一套工具系统便宜。

只读先行不是保守，而是本项目不变量的直接推论：任意 CLI 是 `resumable: false`，一次回复丢失就得到「PR 到底建了没有」。若首片就包含创建 PR，界面只能显示一个未核对的结果，等于把外部副作用降级成模型断言，违反完成由应用用例协调、UNKNOWN 先核对两条约束。

独立登记而非塞进冻结表，是为了不为了一个新成员去改备份包校验契约——同一取舍在内置方法上已经做过一次并有记录。

## 代价

* **主线挤压**：GitHub 片要动 Gateway 词表、连接配置、Context 提示注入、Skill 登记与随包资源清单，与在途的免费模型生产链、普通 Agent 主流程接续、`SKILL.md` 定制（BC-05）、会话压缩与消息文件恢复、会话局部/总 diff、图片附件前端接线共享同一批热文件与迁移序号。实际让位顺序记在[当前进度主文档](../../CODEX_NEXT_STEP.md)。
* **一次性迁移债**：先做独立登记，BC-05 落地后要把官方 Skill 迁到 `SKILL.md` 文件目录，版本与摘要规则须两处一致。
* **安装包身份**：随包资源参与发布输入指纹与包校验，`builtin-skills/` 目录要接进暂存脚本、Tauri `bundle.resources` 映射和开发路径解析；资源里禁止出现配置或凭据类文件这一既有检查同样适用。
* **首片不满足完整用户故事**：「一句话提交并创建 PR」在只读片内做不到，只能查 Issue/PR/CI 失败日志。
* **依赖用户机器上的 `gh`**：未安装时该 Skill 的可用性如实降级，不自动安装。
* **论文贡献不变**：功能数量不等于研究贡献，GitHub 集成不改变研究问题与评价协议；它进入主线只表示产品交付范围扩大。

## 影响范围与关系

受影响：Application（Gateway 动作词表与策略、Skill/方法登记与解析、Context 注入）、工具适配器层（受信 CLI 通路、可执行准入）、桌面打包（资源清单与包校验）、Workbench 的 Skill 列表与审批展示（复用，不新建页面）。不受影响：Task/Run/Project State 契约、Artifact 不可变版本、Verification、执行权与交接协议、模型端口。

详细规则各归唯一事实源：范围与前置归[范围矩阵](../requirements/v1-scope.md#内置-github-skill-范围补充)，Skill 定义/版本/启用边界归[扩展专题第 10 节](../architecture/relay-skills.md#10-内置官方-skill-包)，原后置处置归[后续路线第 4 节](../requirements/post-v1-roadmap.md#4-后续候选的处置)，当前阶段与让位顺序归 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)，实际成绩只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。验收规格待切片工程协议冻结时补入测试计划，本 ADR 不预写没有实现对象的通过条件。

沿用而非替代：[ADR-008](ADR-008-declarative-skills.md) 的声明式组合与不新增 Runtime 边界、[ADR-005](ADR-005-reuse-first.md) 的复用优先、[ADR-019](ADR-019-builtin-methods-and-conversation-checkpoints.md) 的方法/命令与注册表取舍、[ADR-007](ADR-007-windows-desktop.md) 的桌面与打包边界。外部内容仍是数据：Issue、PR 正文、评论与 CI 日志不能升级为规则或授权，这一点不因 Skill 内置而改变。

## 后续

待用户确认，不视为已批准：① 随包 `gh.exe`（Sidecar）的进入时点；② GitHub 写动作片在主线队列中的位置；③ 上游 Skill 的许可与来源固定方式（记录上游提交 SHA 并保留 LICENSE）。

工程前置（实施前先冻结，缺一就不开工）：GitHub 只读子命令的白名单集合与参数形状、`gh` 与 `git` 在同一受管根上的仓库身份核对（防止操作错仓库）、内置 Skill 的按需激活与上下文预算、禁用内置项的实际生效路径、`gh auth status` 探测的失败语义、写动作的核对查询协议。
