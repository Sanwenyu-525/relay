# 日常用户路径后端接续：详细执行任务书

日期：2026-10-17。用户已授权继续其他后端功能，沿用 GPT-6 Luna 实施、主 Agent 验收；顺序以用户首次使用与日常高频使用为准，出口是功能链路实际打通。不是只交计划，也不是重做已经可用的模块。

## 总顺序与当前责任

1. 整理工作对象：目标创建后能修改和归档，项目创建后能改名；两种工作上下文仍引用原对象。
2. 开始具体工作：核对现有任务创建、就绪、人工/AI执行与控制入口，发现基础链路断点才修，不重写在途主循环。
3. 接受结果并继续：核对成果固定版本、人工接受/完成、重开和项目/今日接续；复用现有 Owner，不以模型回复冒充完成。

主 Agent 负责第二、三项现状核对与后续分配。你当前只执行第一项；通过后等待主 Agent 给下一片具体缺口，不自行发明功能。不要以第一项通过宣称整个接续目标完成。

## 并行文件保护

你不是独自在代码库工作。不要覆盖或回退别人改动；每次编辑前重读。当前会话/模型/工具链、目录打开、前端与数据库类型有并行改动，全部避开。不要 commit/push/stash/reset，不碰用户数据库、凭据或正在运行的桌面/API。

你拥有：

- `apps/api/src/project/project-repository.ts`：仅追加 Goal 编辑/归档、Project 改名所需的锁与 CAS 方法。
- 新增 `apps/api/src/application/goal-commands.ts`。
- 新增 `apps/api/src/application/project-presentation-commands.ts`。
- 新增 `apps/api/src/api/project-maintenance-api.ts`：本片 schema 与路由。
- `apps/api/src/api/project-api.ts`：仅增加新注册器 import/call，保留上一片 work-context 接线。
- `apps/api/src/application/project-goal-links.ts`：仅在 LinkProjectGoal 增加 Goal SHARE 锁和 ACTIVE 校验，解除不改。
- `apps/api/src/application/activity-queries.ts`：只增加三条新事件的中文摘要。
- 新增 `apps/api/test/integration/project-goal-maintenance.integration.test.ts`。
- 新增 `docs/api/project-goal-maintenance.md`：接口/行为补充，不写验收成绩。

共享 `api/envelope.ts` 由主 Agent仅添加三个命令的资源回执映射，你不要改它。不要改 routes.ts/domain-schemas.ts/unit-of-work.ts/database-schema.ts、已有迁移、assist/conversation/model/tool-loop/gateway/worker、任何前端文件。其他文档主 Agent维护。

## 已核对的真实缺口与依据

- `docs/api/module-api.md` 已列 `/goals/{id}/revisions` 与 `/goals/{id}/archive`；现有 project-api.ts 只有 Goal 创建和读取，没有这两个写入口。
- Goal 是 Workspace 级业务事实，Project 拥有其 Goal 关系；Task/Run/完成与 Goal 自身的生命周期分开。
- Project 目前支持创建/读取/归档，缺改名；任务已有 `PATCH /tasks/:id` presentation 编辑，可参考其局部 CAS 风格。
- `GoalRow` 已有 title/description/status/revision/updated_at；Project 已有 title/revision。无需新增表、migration、版本历史框架或 Owner。

## 第一步：先读这些现有实现

读 AGENTS.md、CODEX_NEXT_STEP.md 当前相关段、contracts/01-facts-and-ownership.md §5，以及：

- application/create-goal.ts：标题/说明校验、Goal初始状态、回执与审计。
- application/create-project.ts、archive-project.ts：Project状态/归档栅栏。
- application/project-goal-links.ts：Project revision、关联/解除与影响清单。
- application/command.ts：原命令回执先于状态校验；不要另写幂等框架。
- application/task-commands.ts 的 editTaskPresentation：小范围展示修改。
- application/actor.ts、revisions.ts、shared/text.ts：scope、revision解析、文本上限。
- application/work-context-queries.ts、project/work-context-repository.ts：上一片两种上下文读回。
- test/integration/api-harness.ts：真实 API 前缀 `/api/v1/workspaces`；命令结果在 `.body.result`。

## 第二步：冻结三个用户动作

### A. 修改目标标题与说明

`POST /api/v1/workspaces/:workspace_id/goals/:goal_id/revisions`

请求：`{ command_id, expected_revision, title, description }`。两个文本都显式提交，description 允许空串以清空；title 必填。schema additionalProperties=false，不接受 status/project/task/权限字段。

命令名 `EditGoal`。成功 200，result：`{goal_id,title,description,status,revision}`；links.resource 指向现有 Goal GET。

具体步骤：

1. 校验/归一化 title（goalTitle=200）、description（goalDescription=2000），复用 checkRequiredText/checkOptionalText/normalizeText；不要自建不同上限。
2. expected_revision 用 requireRevision 解析，scope 用 httpCommandScopeKey。
3. runIdempotentCommand 内先确认 Workspace；锁该 Goal FOR UPDATE，找不到或跨 Workspace ->404。
4. ARCHIVED Goal 拒绝编辑（既有 invalidTransition 409），不暗中重开。
5. expected_revision 不符 ->既有 REVISION_CONFLICT，带 GOAL/expected/actual。
6. CAS UPDATE 仅改 title/description/revision+1/updated_at。若更新落空，仍按409处理。
7. 同事务写一次 `GOAL_UPDATED` 审计，refs带goal_id、前后revision、改变的字段或新标题即可；不把完整说明复制进日志。
8. 返回新结果，原 command_id 同载荷重放保持旧回执和相同200，即使Goal后来又改/归档。

### B. 归档目标

`POST /api/v1/workspaces/:workspace_id/goals/:goal_id/archive`

请求：`{command_id,expected_revision}`；命令名 `ArchiveGoal`；成功200，result：`{goal_id,status:'ARCHIVED',revision}`。

Workspace/Goal锁/作用域/CAS/回执沿A。只改Goal状态、revision和updated_at，同事务写 `GOAL_ARCHIVED` 审计。归档保留原Goal ID、所有project_goals与Task显式对齐、会话、Task/Run与成果历史，不联动完成/取消/解绑。

归档后：默认active Goal列表不再列出，archived/all列表可读；原Goal单读与work-context仍可读且带ARCHIVED；新Project不能再关联该已归档Goal。LinkProjectGoal 在现有Project锁之后用已有 `lockGoal`（FOR SHARE）替代普通readGoal，检查Goal ACTIVE，不ACTIVE按invalidTransition409；归档只锁Goal，不反向锁Project，避免Project→Goal和Goal→Project死锁。解除已有关系仍用原入口，无额外清理。

本片不做恢复/删除Goal、不重算Task、不重规划运行、不新增统一状态引擎。

### C. 修改项目标题

`PATCH /api/v1/workspaces/:workspace_id/projects/:project_id`

请求：`{command_id,expected_revision,title}`；命令名 `EditProjectPresentation`；成功200，result：`{project_id,title,revision}`。

仅改title，复用200字符标题校验。用runIdempotentCommand，Project行锁（可复用lockProjectInWorkspace已有NO KEY UPDATE及归档检查），确保Workspace与Project相符，CAS改title/revision+1/updated_at。写一次 `PROJECT_PRESENTATION_UPDATED` 审计。不能改project_type、ProjectState.revision、phase、Goal关联、目录、会话、Task验收或Run。已归档项目沿现有 PROJECT_ARCHIVED 409拒绝改名；正常重放在状态判断前返回原回执。

## 第三步：API和回执接线

- 在 project-maintenance-api.ts 本文件定义TypeBox request/response/params；复用createCommandHandler、commandEnvelopeSchema、错误映射。
- 路由在project-api.ts里注册，不改热文件routes.ts。三个写入口都必须进Application。
- 主 Agent将在envelope.resourcePathOf的原CreateGoal组追加EditGoal/ArchiveGoal，在原CreateProject组追加EditProjectPresentation；你验收时必须断言首次响应与GET /commands/:id回执的links.resource正确一致，不能用指向Workspace根的链接冒充完整闭环。
- Activity中文摘要：GOAL_UPDATED=修改目标，GOAL_ARCHIVED=归档目标，PROJECT_PRESENTATION_UPDATED=修改项目名称；本片只加三个映射，不改筛选设计。

## 第四步：三条紧凑的真实PG/HTTP链路

只新增本片三条集成test，不跑全仓压力/Provider/Windows/浏览器，不写与实现逐行对应的单测。

1. **目标创建→关联→修改→两个上下文读回**：HTTP创建Goal/Project，关联，用受管目录夹具+既有会话绑定；修改标题/说明；Goal GET、Goal列表、Goal work-context、目录linked_goals读回新标题和修订且原id不变。保存并核对Task/Run/会话/关系及ProjectState未被修改。原ID同载荷重放只一份审计/回执；同ID改载荷409 COMMAND_ID_REUSED；旧expected_revision409；空标题/超限说明422；跨Workspace404。description空串确实清空。
2. **目标归档→默认列表排除→历史保留**：原链建好后归档Goal；active不含、archived/all仍含，原关联/会话/Task事实保持；work-context真实ARCHIVED。新Project关联该Goal被409拒绝且零链接/revision推进；解除已有关系仍可。重复原command成功重放；新ID重复归档409；归档后编辑409。不要用测试直接UPDATE代替新写入口。
3. **项目改名→各入口新名称→工作事实保持**：HTTP创建项目、Goal关联与目录；PATCH改名，Project GET/list/Goal projects和目录上下文均更新标题；project_type、ProjectState/Task/Run/目录会话/Goal关联不变。测试原command回执链接、一次审计、旧revision409/跨Workspace404/空标题422，未知project_type请求字段被422拒绝；原Owner归档项目后PATCH409。基本链路通即止。

测试使用已有api-harness、command helper、临时PG与随机Workspace；应用数据库角色不能TRUNCATE。SQL快照显式类型、revision::text避免bigint/string假失败。业务计数/revision快照在主动合法变更前后区分清楚。

## 第五步：自检与交回

使用主 Agent准备的隔离wrapper（收到路径后再跑），TestFile=project-goal-maintenance，不碰共享dist。首次运行前确认主 Agent已添加回执映射。

失败先看实际HTTP响应、schema、命令revision/回执和SQL条件；不删失败断言，不改无关热文件，不用仓储直写绕过业务命令。测试通过后停止修改本片文件，由主 Agent独立复验；有明确缺口再继续修。

API文档写精确字段、状态码、归档行为、回执重放、Breaking Change: No；现有列/约束已足够，无数据库结构变更，Goal字段原地CAS修改不是不可变Artifact版本。不要把API“revisions”误实现成新的Goal版本表。

交回需列：实际修改文件、三接口shape、链路1/2/3具体证据、命令与真实结果、发现并修复的问题、并行保护、文档/剩余限制。不要宣称完成主Agent尚未验收的第二/第三阶段或整产品交付。

## 第二片：先记在 Inbox，再归入项目并完成工作

本节由主 Agent 核对真实源码后追加。**第一片交回且主 Agent通知后执行**，不要两片混写。真实缺口：Task 支持 project_id=null 的 Me Inbox，却没有将原Task归入Project的命令；不是重新创建Task或复制一个新ID能解决的问题。

### 用户路径和范围

先记一条未归属事项 → 选择项目整理进去 → 保留原任务、验收和讨论 → 原就绪/开始入口 → 保存成果 → 人工接受/完成 → 项目与今日读回 → 重开后继续。当前实现是**首次归入项目**，不冒充文档里仍Proposed的任意跨Project迁移、移回Inbox或批量搬迁。

### 文件所有权

在第一片既有文件保持不动的基础上，你拥有：

- 新增 application/task-project-binding.ts、api/task-project-binding-api.ts。
- task/task-repository.ts：只追加归入Project的CAS更新和必要阻挡事实SELECT。
- application/task-commands.ts：仅AddTaskDependency中把上游Task读取改为FOR SHARE后核对Workspace/Project，避免归属改变与依赖新建并发生成跨Project关系；保留其他行为。
- api/task-api.ts：只加新注册器import/call。
- application/activity-queries.ts：只加 TASK_PROJECT_ASSIGNED 中文摘要。
- 新增 test/integration/task-project-binding.integration.test.ts。
- 新增 docs/api/task-project-binding.md。

主 Agent拥有envelope新命令资源映射，以及**assist-commands.ts仅创建Task会话时读取Task的那几行**共享锁修正；其余会话/模型在途段落仍禁改。其他热文件和任何迁移仍禁改。

### 接口和确定的业务规则

`POST /api/v1/workspaces/:workspace_id/tasks/:task_id/project-binding`

命令名 `AssignInboxTaskToProject`。body仅 `{command_id,expected_revision,project_id}`；不接受goal_ids/mode/status/验收/权限字段。成功200，result `{task_id,project_id,status,revision,acceptance_revision}`，links.resource指原Task。目标Project必须同Workspace且未归档；不存在/跨Workspace404，归档409 PROJECT_ARCHIVED。

1. 解析revision和目标UUID；进入原runIdempotentCommand，保证回执在状态判断前重放。
2. 按既有顺序锁Task FOR UPDATE并核对Workspace，再取目标Project归档KEY SHARE栅栏。旧revision409。
3. 只接受原project_id=null、状态INBOX或READY、HUMAN执行权且executor_run_id=null的Task。已归属其他Project、新ID重复归入、执行中/完成/取消Task均409 INVALID_TRANSITION；不隐式接手/取消/跨项目搬迁。原command同载荷重放仍200。
4. 不能把历史成果或旧执行链悄悄搬走：若该Task有既有Artifact、Run、CompletionRecord，拒绝并解释本入口用于尚未执行的Inbox整理。查询三类exists即可，无需通用迁移框架。
5. 若存在任何传入/传出的task_dependencies，拒绝409且保持关系，提示先明确处理依赖；不能静默删除或遗留跨Project依赖。新建依赖两个Task读取都须与Task归入互斥，上游FOR SHARE修正正为此服务。
6. 保留Task的title/status/mode、acceptance_revision与不可变验收定义、planning metadata/selection、executor_kind/ownership_epoch；只改project_id、revision+1、updated_at。默认INHERIT随Project当前Goals读取，不能创建Task显式Goal对齐或更改验收。
7. 本Task已有的project_id=null会话可以随Task归属变化：使用既有Assist仓储方法，不新建会话、不改消息/来源/归档/模式。先listSessions(workspaceId,undefined,taskId,'ALL')，按id顺序逐个锁readSession(id,true)，确认仍是本Task且原project_id=null、working_resource_id=null；有PENDING/RUNNING消息则整笔409，提示稍后归入。无在途时用原bindSessionProject更新同会话project与revision。
8. 在同一短事务内CAS Task与会话归属、写一次TASK_PROJECT_ASSIGNED审计及回执；任一步失败全部回滚。不建Run/Task/Goal/目录、不绑定资源、不授予文件权限、不改ProjectState。
9. 归入Project后READY任务是否可开始由原readiness/start重核；目标Project有阻塞时不能因归入成功绕过它。本命令不自动READY、不自动START、不Delegate。

### 必需的锁与作用域修正（小范围，不是新故障矩阵）

- createAssistSession目前在指定task_id时无锁读取Task，稍后插入session。主 Agent将改为readTaskForShare并核对Workspace，使新建Task会话与归入项目互斥；否则等待Task外键锁的会话可能带着旧project_id提交。
- AddTaskDependency当前锁下游Task、无锁读上游Task。你仅将上游改成readTaskForShare并显式404/同Project核对，使“作为依赖上游的Task归属变化”不会留下跨Project依赖。不要改图算法/重做并发调度。
- 会话归入所用锁顺序Task→Project→Session；会话创建从Task SHARE→Project，不反向锁Task。归入有在途消息必须拒绝，不能把旧回复挪到新作用域。

### 三条紧凑集成测试

**1. 完整日常工作链。** HTTP创建未归属Task（保留原title/objective/criteria），创建Project和Goal关联；归入原Task并断言ID/验收不变，Inbox列表消失、Project列表出现、继承目标有效。调用原ready/start；原POST /tasks/:id/artifacts保存受管Markdown，GET确切版本正文一致；原complete提交该version与acceptance，Task=DONE，Project State引用确切完成凭据，GET /completion-records/:id与项目daily-continuation/Today读回事实；原reopen后Task=READY、acceptance_revision增加、旧凭据仍可读且is_current=false，再读Today可继续。要复用现有api-artifacts/completion/today用例的确切body，不猜字段。不调用Provider、不伪造Run/PASS。

**2. 会话与幂等。** 现有Inbox Task附一条无在途会话，归入后session id/history保持、project更新；原回执重放不多加revision/审计，GET命令回执资源链接正确。同ID不同目标Project409，旧revision409；归入其他Workspace目标404，归档目标Project409，失败时Task与会话都未变。另一个有在途消息的Inbox Task归入被拒且无半成品；可用持久fixture设置在途，不启动真实模型。

**3. 依赖和执行边界。** InboxTask有入/出依赖时归入拒绝，关系与revision不变；移除原依赖后可归入。执行中Task拒绝；新ID给已归入Task再次归入409。用一个可控事务持有Task行锁、并发创建Task会话，验证等待后session读取新Project即可，不新增压力循环。正常链路通过即止。

### 本片交回与文档

仍用隔离wrapper，TestFile=task-project-binding。新接口schema放新API文件，不改domain-schemas。API补充注明Breaking Change: No、无migration、首次归入与跨Project迁移的边界、会话在途拒绝、保持验收和不扩权限。交回后由主 Agent独立复跑；原始命令/失败/修复如实汇报。

### 本轮审查明确禁止的假通过

- 不能用GET请求一个只有POST的路由，再把404当成跨Workspace保护；必须用真实写方法、合法请求体和另一Workspace。
- TypeScript的类型断言不会裁剪JSON字段。比较响应子集时先显式构造/map子集，或者断言完整shape，不能用缺字段的期望对象与完整响应deepEqual。
- `expectCommandAccepted`必须传真实commandId；命令结果读`.body.result`。Task默认继承的目标在`goal_alignment.effective_goal_ids`，`goal_ids`只表示显式对齐集合。
- 依赖的真实写入口是POST `dependency-links`/`dependency-unlinks`，没有猜测的DELETE `/dependencies`。请求字段以task-api及现有测试为准。
- 项目/Today/接续API的200不是业务链路已通的证据，必须核对原Task、确切Completion/ArtifactVersion引用及重开前后的实际可继续状态。
- 锁竞争场景不能仅sleep后假定请求已抵达；先用当前临时库的pg_stat_activity观测到Task FOR SHARE等待，再释放持有锁。只做一个固定场景，不建设压力框架。
