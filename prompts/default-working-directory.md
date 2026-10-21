# 新会话的默认工作目录（可用户配置）

日期：2026-10-18。2026-10-19 接续：**阶段 A/B 的后端已实施**（迁移实际编号 `0117`，原计划号 `0111` 已占用），设置页、前端 DTO 来源消费与阶段 C 未实施。原任务书保留切片与验收规格；接续时只做剩余项，不重做配置命令与创建继承。阶段状态归 [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)，运行结果归统一验收表。

## 1. 用户授权与本轮范围

2026-10-19 前端专用接续入口：[默认工作目录前端开发任务书](default-working-directory-frontend.md)。它依据已实现 HTTP 协议执行剩余前端工作，不重跑下面历史计划的后端阶段。

用户下达「新会话未选择目录的时候应该在默认目录工作，这个默认目录是可以用户配置的，上游中应该有」，并按推荐选项确认两件事：① 本轮先落文档与工作包；② **默认目录没有本目录档位事实时按只读兜底**。

目标一句话：用户在设置里显式配置一个默认工作目录之后，**没有主动选过目录的新会话**就能读取该目录内的真实文件，而不必每段讨论先点一次「选择目录」。

不在范围内：读取期临时兜底或猜目录；把默认目录写进本机 localStorage；进程 cwd 兜底；为默认目录新建第二套目录表、权限事实或写 Owner；自动挑选项目或为每段讨论重复建项目；删除、Git、CLI、浏览器、电脑与外部服务的任何权限扩大；ASSISTANT/LEARNING 身份边界调整。

## 2. 唯一事实源与最小阅读

规则已经落定，执行时按下表读取，不要重新设计：

| 内容 | 位置 |
|---|---|
| 业务不变量（默认作用域是用户确认事实、仍禁止模型猜、不自带写能力、失效回落） | [契约 01 §5](../contracts/01-facts-and-ownership.md#5-projectgoal-与-inbox) |
| 产品规则与界面呈现（设置入口、来源标注、文案、失效处理） | [工作台 §18.1.5](../docs/frontend/workbench-design.md#1815-未选目录时的默认工作目录2026-10-18已确认未实施) |
| 责任与持久化协议（Owner、迁移形状、创建事务继承、来源列、兼容） | [运行架构 §2.8](../docs/architecture/runtime-context.md#28-新会话的默认工作目录作用域2026-10-18已确认待实施) |
| 上游机制证据（五家兜底与边界耦合；为什么不用进程 cwd） | [研究 §1.8](../docs/research/p00-source-study.md#18-未选目录时的默认工作目录机制对照2026-10-18) |
| 验收规格 DD-01–10 | [测试计划 §17.1.5](../docs/testing/verification-plan.md#1715-未选目录时的默认工作目录2026-10-18已确认未实施) |

开工前先读现状代码，不要按文档臆写：`apps/api/src/application/assist-commands.ts`（`createAssistSession`、`bindAssistSessionDirectory`）、`apps/api/src/application/assistant-readonly-round.ts`（`agentSessionReadOrigin`）、`apps/api/src/application/open-working-directory.ts`（READY/AMBIGUOUS/NOT_READY 与最小 Project 建立）、`apps/api/src/assist/assist-repository.ts`（`working_resource_id` 投影与绑定写入）、`apps/api/src/api/assist-api.ts`、`apps/workbench/src/views/CollaborationView.tsx`（`openFolder`/`bindSessionDirectory`）、`apps/workbench/src/views/SettingsView.tsx`、`apps/workbench/src/views/AssistView.tsx`（空态说明句与目录细条）。

## 3. 与在途工作的关系（开工前必读）

[本地目录交付链整改任务书](remediation/local-directory-delivery-20261018.md) 与其验收件 `local-directory-access-acceptance-20261018.md` 在途，改的是**同一批文件**：`assist-commands.ts`、`assistant-readonly-round.ts`、`open-working-directory.ts`、`CollaborationView.tsx`、`AssistView.tsx`、`workbench-design.md` 与统一功能验收表。工作树由多个 Agent 并行编辑。

- 先 `git status` 与目标文件 diff，确认该片是否已落；已落地的目录读取修复**不重做、不回退**。
- 若整改任务书尚未收口，本任务书只推进**不与它重叠**的切片：迁移 `0111`、`SetWorkspaceDefaultDirectory`/`ClearWorkspaceDefaultDirectory` 命令与路由、SettingsView 配置行——这些不触碰读取链。`CreateAssistSession` 继承与读取链改动等该片收口后再做。
- 共享文件按目标段落定点编辑；他人红灯只报不修。不得为通过检查删除失败用例。

## 4. 阶段 A：真实目录登记与配置面（后端可独立验收）

1. 新增迁移 `apps/api/migrations/0111_workspace_default_directory.sql`：单行/Workspace 表（`workspace_id` 主键、`resource_id`、`revision`、`created_at`、`updated_at`），外键与 CHECK 按既有同类表口径；同时给 `assist_sessions` 增可空列 `working_directory_source`（取值 `USER_PICKED` / `WORKSPACE_DEFAULT`，资源为 NULL 时列必须为 NULL）。同步 `apps/api/src/infrastructure/database-schema.ts` 与 PG 物理设计文档。
2. 新增两条幂等命令与路由：`SetWorkspaceDefaultDirectory`（入参 `command_id`、`resource_id`；核对资源属于本 Workspace 且 ACTIVE，写入按 `revision` 乐观锁）、`ClearWorkspaceDefaultDirectory`。新增只读投影 `GET /workspaces/{id}/default-working-directory`，返回 `{resource_id, canonical_root, display_name, write_tier, status}` 或明确的「未设置」，形状参照 §18.1.3 的「档位只来自服务端投影」。
3. 配置面走真实路径：设置 → 基本设置新增「默认工作目录」一行，选择器复用 `desktopHost.selectWorkingDirectory()` 与既有 `POST /working-directories/open`，**READY 才允许写入默认值**；AMBIGUOUS/NOT_READY 时原样显示未就绪原因并保持原值；清除回到未设置。非桌面宿主沿用既有的手输路径回退口径，但手输仍要过同一条 open 命令。
4. 出口：DD-02、DD-08（「未设置」与已设置两态）、DD-09。真实 PG/HTTP 集成测试覆盖幂等重放、异载荷拒绝、丢响应按原 `command_id` 核对、并发写收敛；GET 与重开页面零写入。

## 5. 阶段 B：新会话继承默认作用域（创建事务内完成）

1. `createAssistSession` 在同一短事务内：当请求**未**显式给出目录作用域、Workspace 配了默认目录、且该资源仍 ACTIVE、其 Project 未归档时，写 `project_id`＝资源所属 Project、`working_resource_id`＝默认资源、`working_directory_source`＝`WORKSPACE_DEFAULT`；显式选了目录的会话写 `USER_PICKED`；任何默认未生效的情形都不报错、不猜另一个根，按「没有默认目录」建会话。
2. `BindAssistSessionDirectory` 三条边界与 `hasInflightMessages` 守卫**不放宽**：默认作用域在创建时建立，因此不与在途消息竞争；用户在会话内换目录走原命令，并把来源改为 `USER_PICKED`。
3. 读取链**不改**：`agentSessionReadOrigin()` 仍只按会话行读回一次受管资源，缺目录时保留 `AGENT_SESSION_HAS_NO_WORKING_DIRECTORY` 及其提示原文。禁止在此处新增「回落默认目录」的推断。
4. 投影与前端类型：会话上下文 `working_directory` 增加来源字段（`apps/api/src/api/assist-api.ts` 的 schema、`apps/workbench/src/api/resources/assist.ts` 的 DTO），只增字段属非破坏。
5. 出口：DD-03、DD-04、DD-05、DD-06、DD-07，以及 DD-01 的反例保持（未设置默认目录时既有断言逐字通过）。写档位只读兜底须用真实磁盘 hash 与 Gateway prepare/admit 证据，不能只靠前端禁用断言。

## 6. 阶段 C：来源可见与文案收敛

1. 目录细条与会话顶栏：继承默认目录时显示目录名并标注「默认目录（来自设置）」，点击仍是既有更换目录入口；用户显式选过目录后标注消失；未设置时保持现文案。数值与层级归设计系统，不新增 token。
2. 空态说明句（`AssistView.tsx` 的 `lede`）与首条「普通讨论」面板说明按 §18.1.5 最后一条收敛：不再承诺「不需要预先选择工作目录」为唯一路径，也不把默认目录写成新的必选步骤。保留「不需要先创建项目、任务」的既有承诺。
3. 写入档位芯片（§18.1.3/§18.1.4）在默认目录上照常显示只读，并提供既有切档入口；默认目录入口自身不提供「本次任务自动」。
4. 出口：DD-08、DD-10。真实 WebView2 窗口的走查与截图另报，不与合成证据混记。

## 7. 验证与运行产物

- 后端：`pnpm -C apps/api typecheck`（或仓库既有等价命令）、定向单测，再跑真实 PG 集成测试（`apps/api/test/integration/`，至少覆盖新建默认目录命令与 §5 的继承/回落用例）。
- 回归：`agent-conversation-main-loop.integration.test.ts`、`folder-first-conversation.integration.test.ts`、`assist-session-binding.integration.test.ts`、`work-contexts.integration.test.ts`，前端 `newConversationEntry.spec.ts`、`assistBinding.spec.ts`、`folderFirstConversation.spec.ts`、`conversationDiffSummary.spec.tsx`、`emptyConversationWelcome.spec.ts`。**DD-01 要求这些既有用例在不设置默认目录时不需要修改断言即可通过**；若必须改动，说明该改动只影响显式设置默认目录的路径。
- 文档：`node scripts/check-docs.mjs`。
- 完整过程输出按文档保留规则留在本机，`output/acceptance-raw/` 之外不新建报告；成绩与未验范围只写进[功能验收表](../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)相应行。

## 8. 停点与交付口径

出现下列情况先停下 reporting，不自行放宽：

- 需要改 `BindAssistSessionDirectory` 的边界、或在读取链引入任何兜底推断；
- 需要为默认目录新建第二张目录/权限表，或需要给无 Project 会话直接绑资源（与 `managed_resources.project_id NOT NULL` 冲突）；
- 默认目录与既有受管根重叠导致无法 READY，而产品上又要求「开箱即用」——此时按 §18.1.5 保持未设置并说明原因，不建第二个写 Owner；
- 与在途整改任务书在同一函数上产生实质冲突。

交付时简要说明：**改了什么、实际跑过哪些检查、文档同步到哪、剩余未验范围**。静态检查、真实 PG/HTTP、浏览器、真实 Windows 窗口、真实 Provider 五类证据分开报告，一种不能代替另一种；没有真实运行证据不得宣称已交付运行能力。
