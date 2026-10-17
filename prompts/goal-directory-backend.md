# 目标与普通工作区：后端基础工作上下文切片

日期：2026-10-17。范围：用户明确要求后端开发、避开并行改动、由 GPT-6 Luna 实施，主 Agent 独立验收。本文是本轮已获授权的执行任务书，不替代领域契约或进度主文档。

## 目标与业务边界

目前已有 Goal 创建、Goal–Project 显式关联、目录打开/绑定和会话上下文投影，但后端缺少按“目标入口”和“目录入口”直接取得工作上下文的闭环。按现有语义补齐两个只读 HTTP 入口：
- 目标是正式 Goal，经既有 project_goals 可跨多个项目/目录汇集会话。
- UI 普通工作区指 managed_resources 目录；数据库 Workspace 仍是隔离边界。
- 目标和目录可以交叉，不能互斥归类；同一会话始终是同一 ID。Goal–Project 关联不是 Task 显式对齐。
- 仅补只读投影，沿既有创建/关联/绑定命令完成写链路；不做新实体、迁移、自动关联、Goal 直接绑定会话、前端、权限扩展或模型调用。

## 开工与所有权

你不是独自在代码库工作。不得还原、覆盖他人改动；每次编辑前重新读取，出现新增同文件编辑立即告诉主 Agent 并让出碰撞文件。用户这次明确指定 gpt-6-luna，覆盖 AGENTS 默认子代理模型。

先读 AGENTS.md、CODEX_NEXT_STEP.md 当前相关段、contracts/01-facts-and-ownership.md §5、docs/architecture/domain-model.md 的 Goal Owner、docs/frontend/workbench-design.md §31 的目标/目录语义，以及相关源码。不要重跑历史任务书。

你拥有以下文件/责任，其他文件不要修改：
- 新增 apps/api/src/project/work-context-repository.ts：只读 SQL 投影，WHERE 一律核对 workspace_id。
- 新增 apps/api/src/application/work-context-queries.ts：Goal/目录上下文读取及 DTO，复用既有守卫/Owner。
- 新增 apps/api/src/api/work-context-api.ts：TypeBox 请求/响应 schema 与只读路由，同文件即可，无需通用 schema 抽象。
- apps/api/src/api/project-api.ts：目前干净；只加 import 和调用 registerWorkContextRoutes，以避开正被修改的 routes.ts。
- 新增 apps/api/test/integration/work-contexts.integration.test.ts：少量真实 HTTP/PG 场景，使用现有 harness。
- 新增 docs/api/goal-directory-work-context.md：本功能唯一 API 补充契约与设计原因，包含 Breaking Change: No、端点示例、读取范围与空态、无新增数据库结构。共享 HTTP 契约/验收表/进度由主 Agent 协调维护。

特别禁止改动 apps/workbench/**、assist-*.ts、assist-repository.ts、conversation-execution.ts、open-working-directory.ts、working-directory-api.ts、domain-schemas.ts、routes.ts、unit-of-work.ts、database-schema.ts、tool-loop/model/free-model/computer/github 相关代码、任何已有迁移与进行中的文档段落。不要 commit/push/stash/reset，不要改用户库或重启用户服务。

## 最小实现

建议端点（若源码发现名称已有冲突，先报告主 Agent）：
1. GET /api/v1/workspaces/:workspace_id/goals/:goal_id/work-context
   返回 kind: GOAL，goal 的确切 id/title/description/status/revision；当前显式关联的项目（包含归档状态）；这些项目登记的目录（包含状态）；归属于这些项目且 task_id=null 的真实会话引用。Goal 无项目时正常 200 空集合；不能因未绑定目录而漏掉目标的项目会话。
2. GET /api/v1/workspaces/:workspace_id/working-directories/:resource_id/work-context
   返回 kind: DIRECTORY，目录真实 id/canonical_root/status、所属项目（包含归档状态）、项目关联的 Goal（包括状态）与仅 working_resource_id 等于该目录的非 Task 会话引用。未关联 Goal 的普通目录正常可用，linked_goals=[]，不要推断/创建 Goal。项目其他目录或未绑定目录的会话不能混入。

会话仅返回导航必要字段（同一 id、project_id、title、status、revision、working_resource_id 等），不返回正文或凭据。不从名字/路径猜关联。默认仅 ACTIVE 会话；可选 status=ACTIVE|ARCHIVED|ALL，保持既有会话习惯，非法值 422。Task 会话仍由原 Task 入口管理并明确文档，不冒充目标任务对齐。本轮可沿现有会话列表的全集读取方式，不建设新分页框架或上限静默截断。

复用既有 bearer 与 requireWorkspaceVisible、错误 Problem Details；不存在/跨 Workspace 的 Goal/资源返回 404。每个 SQL 的关联都保持 workspace/project 一致；若目录已停用或项目归档，读回真实状态，不隐式开放执行。读取不变更任何 revision，不产生 Task/Run/关联/回执/审计。

## 自检

仅必要检查：API TypeScript 编译；本文件两条完整的真实 PG+HTTP 场景即可覆盖下述基础链路，不做全仓测试/压力/模型/浏览器/Windows：
- 一个 Goal 关联两个项目和不同目录，原 Goal 创建→项目关联→会话绑定→上下文读回；同一会话从目标/目录入口读回同 ID；包含已关联项目但未绑定目录的会话。
- 普通未关联 Goal 目录仍能读取自己的会话，其他目录会话不混入；解除关联后下一次读取反映新事实且会话 ID/历史不变。
- 目标无项目、目录无会话的空态；404 跨工作区/不存在对象；ACTIVE/ARCHIVED 过滤和非法值；读取前后业务计数与 revision 不变。

使用现有 apps/api/scripts/run-integration.ps1 -TestFile work-contexts -UseCLocale 临时集群。共享 dist 可能正被其他实例构建，优先临时 outDir 编译；如需 wrapper 运行，通知主 Agent 协调，避免覆盖并行 dist。若既有全量类型因他人进行中修改失败，记录准确错误，不擅改热文件。迁移无需新增。

完成时返回：文件、实际 API shape、验证命令/结果、可复验方式、未验证限制，明确只做后端。主 Agent 负责独立验收与共享进度/验收文档。

## 细化执行步骤（用户追加要求：不得自行省略关键步骤）

下面细化既定范围，不授权扩展新功能。已有正确代码继续复用；不得因为任务书变详细就推倒重写。每完成一步对照其出口，未通过先修当前问题，不跳去做 UI、模型或新架构。

### 第一步：确认事实与文件边界

1. 用 `git status --short` 查看当前工作树，再仅查看本任务所有权文件的 diff。不要把所有未提交改动当作自己的成果。
2. 必须核对以下实际入口，而不是猜名字：
   - `apps/api/src/api/project-api.ts`：Goal 创建、项目关联/解除，以及本片注册落点。
   - `apps/api/src/application/project-goal-links.ts`：关联属于 Project，必须使用其 revision；Goal revision 不能替代它。
   - `apps/api/src/application/assist-commands.ts`：会话创建与 `bindAssistSessionDirectory`；绑定只定作用域，不授予文件访问能力。
   - `apps/api/src/assist/assist-repository.ts`：会话确切目录字段是 `working_resource_id`，不是按项目第一个目录推测。
   - `apps/api/test/integration/api-harness.ts`：API 前缀实际是 `/api/v1/workspaces`，命令响应结果在 `response.body.result`。
3. 新增文件若已由本轮创建，先读当前内容再补；若发现其他实例接手同一文件，报告并让出该文件。不要覆盖它继续工作。

出口：能列出本片涉及的 Goal、project_goals、projects、managed_resources、assist_sessions 五种已有事实；没有新增表、状态写入 Owner 或授权概念。

### 第二步：固定响应结构

以下字段是本片约定，应用返回值、TypeBox schema、文档 JSON 示例、HTTP 断言必须一致。

```ts
type GoalWorkContext = {
  kind: 'GOAL';
  goal: { id: string; title: string; description: string; status: string; revision: string };
  projects: Array<{
    id: string; title: string; project_type: string;
    archive_status: 'ACTIVE' | 'ARCHIVED'; archived_at: string | null; revision: string;
    directories: Array<{
      id: string; canonical_root: string; status: string; revision: string;
    }>;
  }>;
  sessions: SessionReference[];
};
type DirectoryWorkContext = {
  kind: 'DIRECTORY';
  directory: {
    id: string; canonical_root: string; status: string; revision: string;
    project: {
      id: string; title: string; project_type: string;
      archive_status: 'ACTIVE' | 'ARCHIVED'; archived_at: string | null; revision: string;
    };
  };
  linked_goals: Array<{ id: string; title: string; status: string; revision: string }>;
  sessions: SessionReference[];
};
type SessionReference = {
  id: string; project_id: string; title: string; status: string;
  revision: string; working_resource_id: string | null;
};
```

- 所有 revision 返回十进制字符串。日期返回 ISO 字符串，未归档返回 null。
- Goal 的目录已嵌在项目下，不额外要求 `directories[].project_id`；仓储查询可保留它用于分组，应用层组装时去掉。
- 会话查询已经排除 Task 会话，响应不用再带 `task_id`。
- 不返回 messages、连接配置、token、文件正文或任何执行授权字段。
- `projects`、`directories`、`linked_goals`、`sessions` 为空时返回 `[]`，不能用 null、假示例或“读取失败”的空集合代替。

出口：两种入口有明确 kind 和不同主体，交叉出现的会话 ID 保持相同，未关联 Goal 的目录仍有完整 DIRECTORY 响应。

### 第三步：写最小只读仓储

SQL 放在 `project/work-context-repository.ts`；应用层不拼 SQL，API 层不直写存储。无需接入正被修改的 unit-of-work.ts，直接在专用 application 查询中构建只读仓储。

1. `readGoal(workspaceId, goalId)`：按两列精确读取，找不到返回 undefined。
2. Goal 项目：`project_goals pg JOIN projects p`，同时核对 `p.id=pg.project_id` 与 `p.workspace_id=pg.workspace_id`，WHERE 固定 workspace 和 goal。
3. Goal 目录：沿相同关联取 `managed_resources`，同时核对项目和 workspace。不隐藏停用目录，返回真实 status。
4. Goal 会话：沿相同关联取 `assist_sessions`，同时核对项目和 workspace，再限定 `s.task_id IS NULL` 与请求的会话状态。`working_resource_id IS NULL` 的会话仍应保留。
5. `readDirectory(workspaceId, resourceId)`：资源 JOIN 所属项目，JOIN 同时核对 project 与 workspace；按路径中的 workspace/resource 精确读取。
6. 目录 Goal：只读该项目 `project_goals JOIN goals`，JOIN 同时核对 workspace 与 goal ID，保留实际 Goal status。
7. 目录会话：WHERE 必须同时具备 workspace_id、已核实的所属 project_id、working_resource_id=请求资源、task_id IS NULL、会话状态。不能只按项目取全部会话。
8. 顺序使用已有 created_at/id 等持久字段给出稳定顺序即可；不实现拖拽排序、不改 updated_at、不截断后冒充全集。

出口：仓储只有 SELECT，没有 INSERT/UPDATE/DELETE、事件发布、调用模型或调用目录打开命令。

### 第四步：组装应用查询与接路由

1. `readGoalWorkContext` / `readDirectoryWorkContext` 先调用现有 `requireWorkspaceVisible`，再读取目标主体；主体不存在统一 `resourceNotFound`。
2. `status` 未传视为 ACTIVE；ACTIVE 对应仅 ACTIVE，会话 ARCHIVED 对应仅 ARCHIVED，ALL 对应两种；非法字符串按既有 `validationFailed` 返回 422，不能静默改成 ACTIVE。
3. 查询多个独立集合可以 Promise.all；这是导航读模型，不是运行契约快照，不能把输出用于自动 Delegate 或直接执行。
4. 路由在 `work-context-api.ts` 定义 schema，复用 sendReadError。
5. schema 用单个 Type.Object 定义最终对象；需要复用已有本文件 schema 时可展开 `.properties`。不要用多个 `additionalProperties:false` 的 Type.Intersect 拼出无法序列化的对象。
6. `project-api.ts` 仅新增 import 与 registerWorkContextRoutes 调用，其他原接口不改。

出口：HTTP 实际返回所有约定字段；没有“application 能返回、serializer 却漏掉/报缺字段”的错位；旧 Project/Goal 写入口保持原有行为。

### 第五步：只写两条有辨别力的基础集成测试

复用现有真实 PG/HTTP harness，不造 Mock DB，不写新的通用测试框架。下面可以各写一个 test，每个 test 中串行推进。

**链路 A：目标→两个项目→两个目录→同一会话→解除关联。**

1. 使用 `createWorkspace(app.db)` 建本片测试 Workspace，另建一个 Workspace 作隔离检查。
2. 用真实 HTTP `POST /goals` 创建 Goal；`POST /projects` 创建 P1/P2；从 `.body.result` 获取 ID 和 revision。
3. 对 P1/P2 各 `POST /projects/:id/goal-links`，body 为 `{command_id, expected_revision: 最新Project修订, goal_id}`；成功 200。保存返回的新 revision，不猜修订数字。
4. 目录资源登记可使用测试夹具，因为本片不改文件系统登记协议。为 P1/P2 各准备 D1/D2。
5. 通过 `POST /assist-sessions` 创建 S1(P1)、S2(P2)、S3(P1)；通过 `POST /assist-sessions/:id/working-directory` 的 `{command_id,resource_id}` 把 S1 绑定 D1、S2 绑定 D2，S3 保持无目录。命令成功码：创建 201，绑定 200。
6. 在读取之前保存业务快照：本 Workspace 的 tasks/runs/project_goals/command_receipts/activity_records 计数，以及本片 Goal/Project/资源/会话 revision。可以少量 SQL 聚合完成，不建立新快照系统。
7. GET Goal work-context：kind=GOAL，项目恰为 P1/P2，各自目录 ID 对应 D1/D2，会话恰为 S1/S2/S3，S3.working_resource_id=null。
8. GET D1 work-context：kind=DIRECTORY，主体与所属项目正确，linked_goals 包含原 Goal，只含 S1。S1.id 与目标入口中的 ID 相同。
9. 外 Workspace 访问这两个主体都应 404；非法 status 返回 422。
10. 所有纯 GET 后再次保存快照，与第6步相同；不要把后续主动归档/解除产生的合法变更混进“读接口零写入”的比较。
11. 归档 S1 后核对默认 ACTIVE 不含它，ARCHIVED 只含它，ALL 又能读到它；归档尽量沿既有命令。注意归档合法改变 revision，所以归档后重新取需要的修订。
12. **解除前先 GET Goal?status=ALL，确认 S1/S3 确实还存在；**再通过既有 `POST /projects/P1/goal-unlinks`，body 包含最新 Project revision、goal_id、expected_impacted_task_ids:[]（本片没有显式对齐Task）。解除后再 GET Goal?status=ALL：S1/S3消失，P2/S2保留；GET D1?status=ALL：linked_goals=[]，S1仍保留同一ID。
13. 不能只对已归档的 S1 用默认 ACTIVE 做解除断言：无论关联是否正确解除，它本来就不在 ACTIVE 结果里，这会产生假通过。

**链路 B：普通目录无需 Goal 就能工作，空态与同项目目录隔离。**

1. 新 Workspace，建一个不关联任何 Goal 的普通项目 P3；另建一个没有任何项目关联的空 Goal G0。
2. 为 P3 登记 D3/D4，创建 ACTIVE 会话 S4/S5 分别绑定两目录；另可登记没有会话的 D5 用于目录空态。
3. GET D3：linked_goals=[]，sessions 恰含 S4；不能含同项目的 S5。GET D4恰含S5。普通目录“可用”必须有一条会话读回，不能只用空数组证明。
4. GET G0：projects=[]、sessions=[]。GET无会话目录：sessions=[]，主体仍可见。
5. 随机不存在 Goal/资源 ID 返回404。若需要检查 Task 会话排除，在上述夹具内加一条已有 Task 会话并断言不混入即可，不新建专门大套件。

出口：测试证据覆盖实际写入口→持久事实→两种GET→原会话→显式解除；不能只repository插入后测GET就宣称完整业务链路已验。

### 第六步：编译、运行、定位与交回

1. 类型检查用 Node24 与现有 tsc；新 SQL 测试需要给 `sql<{字段:类型}>` 显式类型，避免 rows 是 unknown。
2. 共享 dist 不碰。主 Agent 已准备隔离 wrapper：
   `powershell -NoProfile -ExecutionPolicy Bypass -File output/acceptance-raw/work-contexts-20261017/run-isolated.ps1 -TestFile work-contexts -UseCLocale`
   它只改变编译输出与可执行入口位置，测试仍跑真实临时 PG18.6/HTTP；不用用户现有库。
3. 编译失败时先看报错文件：自己文件就修；其他在途文件就发主 Agent，不能顺手改它。编译没过、PG没启动时明确说未运行测试。
4. 运行失败时保留失败断言和输出摘要。按“实际响应→schema→查询条件→夹具/命令修订”的顺序定位；不要删断言、放宽返回值或换成仓储直写来绕开失败。
5. 自检过后报告主 Agent，停写产品文件，让主 Agent审核和独立复跑。主 Agent提出具体修复时继续在原文件内修改，不扩范围。
6. API补充文档与实际响应一致，接口前缀写 `/api/v1/workspaces`。不要在API文档复制测试成绩；结果由主 Agent写唯一验收表。

交回格式：

```text
模型：GPT-6 Luna（实际派发）
修改文件：逐个列出，说明用途
API：两个GET及最终响应形状
基础链路：逐项对应链路A/B，明确写入口是否实际调用
验证：命令、真实结果、编译与PG是否实际运行
失败和修复：发生过什么、如何修复；没有则不编造
并行保护：本轮没有写哪些热文件，有无发现冲突
文档：API补充及需主Agent同步项
限制：无前端接线、无用户实例升级；其他未跑项如实说明
```
