# C 片实施提示词：协作页工具轨迹呈现

更新：2026-10-04。角色：`prompts/agent-native-tools.md` 五节 C 片的实施输入，**独立于 A/B 片**——A/B 片已实施并有证据，本文只做呈现与配套刷新事件，不重做工具循环、不重做范围授权、不重做写入与检查链。设计规则归[工作台 §18.8](../../docs/frontend/workbench-design.md#188-工具轨迹的呈现2026-10-04c-片设计)，端点归[命令契约 §10.56](../../docs/api/http-command-contract.md)，物理设计归[第 60 节](../../docs/database/physical-design-postgresql.md)，验收规格归[测试计划 §20.4](../../docs/testing/verification-plan.md)，上游依据归[研究 §1.6](../../docs/research/p00-source-study.md#16-工具调用呈现与刷新机制对照2026-10-04)。**本文交付本身不启动开发。**

---

**Goal：** 让用户在协作页看到「模型这一轮实际对磁盘做了什么」——聊天区一行摘要 + 右栏逐轮轨迹，全部来自已落库事实。

**Architecture：** 新增一个只读投影端点 `GET /runs/{run_id}/tool-calls`，直接读 `run_tool_calls` 已有的 `arguments` / `result_ref`（模型当时实际消费的同一份内容，逐字节可对账）；新增一条迁移把 `run_tool_calls` 登记为 Run 刷新事件来源，前端按事件提示重读投影，**不做轮询**。前端两层：聊天区在产生执行请求的 user 消息下挂一行摘要，右栏工具面板新增「轨迹」页签承载逐轮卡片。

**Tech Stack：** TypeScript、Fastify + TypeBox、Kysely/PostgreSQL（含 plpgsql 触发器）、React + Vitest、Playwright（真实 Chromium）。

**Spec：** 上文四个事实源小节。计划与规格冲突时以规格为准，并回头修计划。

## 全局约束

- 工作区由多个 Agent 共享。动手前先 `git status --short`，确认没有他人正在写同一批文件；**不得回退或覆盖他人未提交改动**。本计划涉及的 `apps/api/src/api/run-api.ts`、`apps/workbench/src/views/AssistView.tsx`、`apps/workbench/src/components/DevToolsPanel.tsx` 都有并行改动历史，逐处合并而不是整文件重写。
- API 单元与集成必须用固定 Node **v24.21.0**：`.research/runtime-cache/node-v24.21.0-win-x64/node.exe`。PATH 上的默认 `node`（本机 v22.22.3）会让 `verifyBackupPackage` 产生 12 例假失败。
- `RELAY_FILE_IO_HELPER` 必须是**绝对路径**；不设该变量让脚本自行构建并设绝对路径也可以。给相对路径会让 4 个套件报 `spawn …relay-file-io-helper.exe ENOENT`——那是调用口径错误，不是产品缺陷。
- 不新增业务依赖、不引入前端框架或新 HTTP 客户端。不改既有路由、命令 Owner、权限与审批栅栏。
- 不动 `run_tool_calls` 表结构、不回填历史、不新增业务表。本计划唯一的新迁移只放宽一个 CHECK 并加触发器。
- `DevToolsPanel` 的 FILES / GIT 页签「未接入」占位**本轮保留**（§18.8）。不得以静态假数据把它们填成「已接入」。
- 轨迹区是**只读呈现**：不出现批准 / 暂停 / 取消 / 重试按钮。
- 真实 Provider 外呼仅限已有明确授权与合成材料；不扩大外发范围，不输出密钥。Fake 模型 + 真实工具只证明工具与业务链，**不证明**真实 Provider 的 tool calling 质量。
- 子代理必须显式 `model: gpt-6.1-sol`；该模型不可用时**报告独立出口缺口**，不以自检替代、不静默降级。
- 自建集群/目录/子进程只清理本次资源；不停止用户现有窗口或 PostgreSQL。

## 重点复核（规格暗示但没有任务覆盖的输入）

按最可能咬人的顺序。每条都在下面指定任务的步骤里有对应测试。

1. **用户在 Run 正在写盘时打开轨迹页签**——期望看到该轮的真实状态（含「等待你批准」），不是空白也不是上一轮的旧行。→ 任务 3 TC-07、任务 5。
2. **连接在运行中被禁用（失权）后重读轨迹**——期望如实显示失权/未派发原因，而不是沿用撤销前的成功结果。→ 任务 3 TC-06、任务 5。
3. **结果被工具自身截断**——期望界面显示「已截断 + 省略字节数」，任何层都不得把它渲染成完整内容。→ 任务 2 TC-03、任务 5。
4. **同一个 `run_tool_calls` 行被重复投递/重放**——期望投影里仍然只有一行，不出现重复轮次。→ 任务 3 TC-01。
5. **Run 处于 `WAITING_APPROVAL` 且 `wait_reason` 为预算耗尽**——期望摘要与轨迹都不宣称「已完成」。→ 任务 6。

---

## 任务 1：迁移 `0057`——把工具调用登记为 Run 刷新事件来源

**Files：**
- Create: `apps/api/migrations/0057_m04_run_tool_call_events.sql`
- Modify: `apps/api/test/integration/migration.integration.test.ts`

**Interfaces：**
- Consumes: 既有 `relay_append_run_event()`（`0012_m03_run_events.sql:19-56`）、`ck_run_events_kind`（同文件 12-14 行）。
- Produces: 新事件种类 `TOOL_CALL_CHANGED`；迁移文件本身。前端与 API 任务只依赖这个字符串常量，不依赖迁移内部写法。

- [ ] **Step 1：写失败断言。** 在 `migration.integration.test.ts` 的既有迁移链用例里加两条断言：
  1. `select tgname from pg_trigger where tgrelid = 'run_tool_calls'::regclass` 恰好返回 INSERT 与 UPDATE 两个触发器。
  2. `run_events` 的 CHECK 允许 `TOOL_CALL_CHANGED`：对既有 Run 直接 `insert into run_events (run_id, seq, kind) values (<该 run>, <max(seq)+100>, 'TOOL_CALL_CHANGED')` 不抛约束错误。
  修复前这两条都必须失败（触发器不存在、CHECK 不含该值）。
- [ ] **Step 2：跑一次确认失败。** `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile migration`。期望：失败，错误提到 `ck_run_events_kind` 或枚举缺值。
- [ ] **Step 3：写迁移。** 三条改动，顺序固定：
  1. `alter table run_events drop constraint ck_run_events_kind;` 后用**完整重述**的六个原取值加上 `TOOL_CALL_CHANGED` 重新 `add constraint`（与 `0054` 重述 `ck_logical_operation_resource` 同一教训：就地追加会漏掉历史分支）。
  2. `create or replace function relay_append_run_event()`：在现有 `CASE TG_TABLE_NAME` 里加一个 `when 'run_tool_calls'` 分支，`event_run_id := NEW.run_id`、`event_kind := 'TOOL_CALL_CHANGED'`（`run_id` 就在行上，不需要像 `step_attempts` 那样回查）。**保留函数体其余部分逐字不变**，特别是开头的 `PERFORM ... FROM runs WHERE id = event_run_id FOR UPDATE` 与 `max(seq)+1` 取序号——锁序不能动。
  3. 两个触发器，`AFTER INSERT` 与 `AFTER UPDATE`，`WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.operation_id IS DISTINCT FROM NEW.operation_id OR OLD.result_ref IS DISTINCT FROM NEW.result_ref)`。**不要**把 `revision` 放进 `WHEN`：这三列已覆盖全部状态推进，纳入 `revision` 只会为同一次推进多发一条提示。
  - 文件头注释按既有迁移风格写明依据（`0012` 第 1-3 行与本计划第 60 节），并注明触发器以 `SECURITY INVOKER` 执行、复用 `0012` 已有的 `GRANT SELECT, INSERT ON run_events TO relay_app`，因此**不需要新增 GRANT**。
- [ ] **Step 4：跑迁移套件确认通过。** 同 Step 2 的命令。期望：exit 0，临时集群删除 True。
- [ ] **Step 5：确认断言转绿且历史未回填。** 重跑 Step 2 的命令，期望两条新断言都通过。再确认迁移前后既有 Run 的 `run_events` 行数与内容不变（TC-08 的迁移侧部分）。**触发器在真实工具调用上的发事件行为由任务 3 TC-07 在完整夹具里覆盖**，本任务不为此拼造父链。
- [ ] **Step 6：Commit。** `git add apps/api/migrations/0057_m04_run_tool_call_events.sql apps/api/test/integration/migration.integration.test.ts`，message 用英文（例：`feat(m04): register run tool calls as run event source`）。

## 任务 2：后端只读投影

**Files：**
- Create: `apps/api/src/application/run-tool-call-projection.ts`
- Modify: `apps/api/src/api/run-api.ts`（新增一条 GET 路由，追加在 `draft-preview` 之后）
- Modify: `apps/api/src/api/domain-schemas.ts`（新增投影响应 schema）
- Test: `apps/api/test/unit/run-tool-call-projection.test.ts`

**Interfaces：**
- Consumes: `RunToolCallRepository.listByRun(runId)`（`apps/api/src/run/run-tool-call-repository.ts:74`，**已存在，不要新写 SQL**）、`requireWorkspaceVisible`、`resourceNotFound('Run')`（`apps/api/src/application/run-queries.ts:83-90` 的既有写法）。
- Produces:
  ```ts
  // apps/api/src/application/run-tool-call-projection.ts
  export interface RunToolCallProjection {
    readonly run_id: string;
    readonly run_status: string;
    readonly wait_reason: string | null;
    readonly rounds: readonly {
      readonly round: number;
      readonly model_call_id: string;
      readonly calls: readonly {
        readonly id: string;
        readonly ordinal: number;
        readonly tool_name: string;
        readonly status: 'REQUESTED' | 'PREPARED' | 'WAITING_APPROVAL' | 'SETTLED' | 'REJECTED' | 'ABANDONED';
        readonly arguments: JsonObject;
        readonly arguments_sha256: string;
        readonly provider_tool_call_id: string;
        readonly operation_id: string | null;
        readonly adaptation_of: string | null;
        readonly adapted_path: string | null;
        readonly result_ref: JsonObject | null;
        readonly created_at: string;
        readonly updated_at: string;
      }[];
    }[];
  }
  export async function readRunToolCalls(
    db: DbExecutor, workspaceId: string, runId: string,
  ): Promise<RunToolCallProjection>;
  ```
  路由响应字段名与此接口一致（snake_case），由 `domain-schemas.ts` 里的 TypeBox schema 固定，`additionalProperties: false`。

- [ ] **Step 1：写失败测试（TC-01/02/03/04）。** `run-tool-call-projection.test.ts` 用可控假数据覆盖：按 `(round, ordinal)` 升序输出（TC-01）；六个状态各一行、状态词不折叠不合并（TC-02）；`result_ref` 原样透传含 `{ truncated: true, omitted_bytes: N }` 后缀，不重新序列化（TC-03）；未派发行的 `operation_id` 为 `null` 且 `result_ref: null` 与 `result_ref: {}` 分别可辨（TC-04）；Run 不可见或跨 `workspace_id` 时抛 `resourceNotFound('Run')`。
- [ ] **Step 2：跑一次确认失败。** 固定 Node 下 `node --test apps/api/dist/test/unit/run-tool-call-projection.test.js`（先 `corepack pnpm --dir apps/api run build`）。期望：模块不存在。
- [ ] **Step 3：实现 `readRunToolCalls`。** `await requireWorkspaceVisible(db, workspaceId)`；读 Run（`repositories.runs.readRun`）并按既有条件 `run === undefined || run.workspace_id !== workspaceId` 抛 404；`listByRun(runId)` 后按 `round` 升序分组、组内按 `ordinal` 升序。**不要**重新计算或裁剪 `arguments` / `result_ref`，**不要**为工具结果加第二套 `summary` 字段——折叠行的一行摘要在前端现算。空数组是合法结果（200），不是错误。
- [ ] **Step 4：加路由。** `run-api.ts` 追加 `app.get('/runs/:run_id/tool-calls', { schema: { params: WorkspaceRunParamsSchema, response: { 200: RunToolCallProjectionSchema } } }, ...)`，handler 体照抄同文件 `draft-preview` 的形状：设 `Cache-Control: no-store`、`try { return await readRunToolCalls(...) } catch (error) { return sendReadError(reply, error, request.id) }`。
- [ ] **Step 5：跑单元确认通过。** 同 Step 2。期望全绿。
- [ ] **Step 6：Commit。** `git add apps/api/src/application/run-tool-call-projection.ts apps/api/src/api/run-api.ts apps/api/src/api/domain-schemas.ts apps/api/test/unit/run-tool-call-projection.test.ts`。

## 任务 3：真实 PG 集成——跑完工具循环后读投影

**Files：**
- Modify: `apps/api/test/integration/tool-loop.integration.test.ts`

**Interfaces：**
- Consumes: 任务 2 的 `readRunToolCalls`；该文件既有的工具循环夹具与 `RunToolCallRepository`（文件内已有 `import { RunToolCallRepository }`，见其第 20 行）。
- Produces: TC-01/04/06/07/08 的真实 PG 证据；不产出新接口。

- [ ] **Step 1：加用例 TC-07（刷新事件恰好一条）。** 复用既有「模型读 → 改 → 跑检查」用例跑完后，断言：`select kind from run_events where run_id = ...` 中 `TOOL_CALL_CHANGED` 的条数 **等于** 该 Run 工具行状态推进的次数，且 `seq` 与既有事件连续无洞。
- [ ] **Step 2：加用例 TC-01/04（顺序与身份）。** 同一 Run 读投影，断言 `(round, ordinal)` 升序、无重复行、`operation_id` 为 `null` 的行确实存在（至少有 `REJECTED` 行）。
- [ ] **Step 3：加用例 TC-06（拒绝原因与失权）。** 覆盖三种 `REJECTED`：`TOOL_CHECK_NOT_CONFIGURED`（未配置检查）、越界路径、`TOOL_ADAPTATION_STALE_BASELINE`。每条断言 `result_ref.reason` 与 `.detail` 非空。**另加一条失权场景**：授权撤销后同一请求被拒，投影如实显示拒绝原因，不显示撤销前的成功结果。
- [ ] **Step 4：加用例 TC-08（历史不回填）。** 断言迁移前后既有 Run 的 `run_events` 行数与内容不变；空工具 Run 的投影是 200 + 空数组（不是 404）。
- [ ] **Step 5：跑集成。** `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile tool-loop`。期望：既有 25 项加本轮新增全绿、exit 0、临时集群删除 True。**若失败不得删测试或放宽断言换绿。**
- [ ] **Step 6：顺带复跑被同批改动影响的套件。** 至少 `-TestFile run-graph`、`-TestFile folder-first-conversation`（后者覆盖产品入口的工具循环链）。
- [ ] **Step 7：Commit。**

## 任务 4：前端客户端类型与读取方法

**Files：**
- Modify: `apps/workbench/src/api/relayClient.ts`

**Interfaces：**
- Consumes: 任务 2 的响应字段名（snake_case）。
- Produces:
  ```ts
  export interface RelayRunToolCall {
    readonly id: string; readonly round: number; readonly ordinal: number;
    readonly toolName: string;
    readonly status: 'REQUESTED' | 'PREPARED' | 'WAITING_APPROVAL' | 'SETTLED' | 'REJECTED' | 'ABANDONED';
    readonly args: Readonly<Record<string, unknown>>; readonly argsSha256: string;
    readonly providerToolCallId: string; readonly operationId: string | null;
    readonly adaptationOf: string | null; readonly adaptedPath: string | null;
    readonly resultRef: Readonly<Record<string, unknown>> | null;
    readonly createdAt: string; readonly updatedAt: string;
  }
  export interface RelayRunToolCalls {
    readonly runId: string; readonly runStatus: string; readonly waitReason: string | null;
    readonly rounds: readonly { readonly round: number; readonly modelCallId: string;
      readonly calls: readonly RelayRunToolCall[] }[];
  }
  // RelayApiClient
  async getRunToolCalls(runId: string): Promise<RelayRunToolCalls>;
  ```
  命名与既有 `RelayRunTrace` / `getRunTrace`（同文件 2282 行）同构。

- [ ] **Step 1：写解析函数与方法的类型检查反例。** 先只加类型、不加实现，让 `apps/workbench` 的 `typecheck` 失败于缺 `getRunToolCalls`。
- [ ] **Step 2：实现。** `getRunToolCalls` 照 `getRunGatewayOperations`（同文件 2286 行）的形状：`await this.request(this.workspacePath('/runs/${encodeURIComponent(runId)}/tool-calls'))`，再用既有 `object` / `string` / `optionalString` / `array` / `nullableString` / `decimal` 辅助函数解析。**`id` 与 `providerToolCallId` 都要解析，但前端一律用 `id` 作 React key**（`providerToolCallId` 跨 Run 可重名）。`rounds` 的顺序直接信任服务端，不再本地排序。
- [ ] **Step 3：跑 typecheck。** 固定 Node 下 `corepack pnpm --dir apps/workbench run typecheck`。期望 exit 0。
- [ ] **Step 4：Commit。**

## 任务 5：右栏「轨迹」页签

**Files：**
- Create: `apps/workbench/src/components/RunToolTrajectoryPanel.tsx`
- Create: `apps/workbench/src/components/RunToolTrajectoryPanel.css`
- Modify: `apps/workbench/src/components/DevToolsPanel.tsx`（页签名加 `TRACE`，`Tab` 联合类型同步）
- Test: `apps/workbench/tests/runToolTrajectory.spec.ts`

**Interfaces：**
- Consumes: 任务 4 的 `getRunToolCalls` 与 `RelayRunToolCall`；既有 `describeLiveError`（`apps/workbench/src/lib/liveErrors.ts`）、既有 `handleTabListKeyDown`、既有 `devtools-*` class 命名与 CSS 变量。
- Produces: `export default function RunToolTrajectoryPanel({ client, run }: { client: RelayApiClient; run: RelayRun | null })`。刷新依据既有 `run.revision` 变化，不另加 prop。

- [ ] **Step 1：写组件反例（先失败）。** 覆盖 §20.4 的 TC-09~TC-14：无 run 时不显示「已完成」；Loading 有 `role="status"`；读取失败有 `role="alert"`；空 `rounds` 显示「本次 Run 没有工具请求」而不是空白；折叠态显示「省略 N 行」且 N 与展开后行数一致；`resultRef` 含 `truncated` 时显示 `omitted_bytes`；`WAITING_APPROVAL` 显示「等待你批准」并给出指向既有 Review 的链接（用 `operationId`）；`REJECTED` 显示 `reason` + `detail`；`REQUESTED` / `PREPARED` 不进计数；`waitReason` 非空时显示该原因；轨迹区内**不存在**批准/暂停/取消/重试按钮（按可访问名断言不存在）。
- [ ] **Step 2：跑一次确认失败。** 固定 Node、单 worker：`corepack pnpm --dir apps/workbench run test -- --maxWorkers=1`，只跑新文件。期望：文件不存在。
- [ ] **Step 3：实现折叠。** 折叠行 = 状态标签 + 目标（客户端类型上是 `call.args.relative_path`，HTTP 字段是 `arguments.relative_path`；缺省时用工具名）+ head/tail 预览 + 「省略 N 行」展开按钮。head/tail 切分写成文件内的一个纯函数 `headTailCap(total: number, maxLines: number, expanded: boolean): { headLines: number; tailLines: number; hiddenLines: number }`（`headLines = Math.ceil(maxLines / 2)`），渲染层不重复算。**折叠预算按渲染后的屏幕行计**，不要按 `\n` 切出来的逻辑行；一条超长路径不得撑破布局。
- [ ] **Step 4：实现写操作与检查的挂接。** `operationId` 非空且 `tool_name` 是 `apply_changeset` 时，在展开区给出既有 `/operations/{id}/change-sets` 与 `/operations/{id}/file-write-diff` 链接；`run_check` 展开区显示退出码与 stdout/stderr 截断标记。**不自己再渲染一份变化集内容**，只链到既有端点（§18.8「改动清单从既有账本派生」）。
- [ ] **Step 5：实现刷新。** 打开页签、Run 事实变更（`runRevision` 变化）、以及既有 Run SSE 提示到达时重读；`run === null` 或 Run 终态后停止轮询（**本任务不做定时轮询**，只按事件与事实变更触发；若无 hint 可用则如实显示最后一次读取时间，不假装实时）。断线重读后不复活已清除的旧行：重读成功即整体替换，不做增量合并。
- [ ] **Step 6：接进页签。** `DevToolsPanel.tsx` 的页签名数组加 `["TRACE", "轨迹", ListTree]`（图标从 `lucide-react` 现有导出里取，不新增依赖）。**FILES / GIT / TERMINAL 三个页签的内容一字不改。**
- [ ] **Step 7：跑测试与 typecheck。** 同 Step 2 加 `typecheck`。期望全绿。
- [ ] **Step 8：Commit。**

## 任务 6：聊天区摘要行

**Files：**
- Modify: `apps/workbench/src/views/AssistView.tsx`（摘要渲染挂在 `messages.map` 内、命中 `execution.sourceMessageId` 的 user 消息行下）
- Modify: `apps/workbench/src/views/CollaborationView.tsx`（若 execution 列表不在此处传入，按既有 props 形状下传，不新增数据源）
- Test: `apps/workbench/tests/folderFirstConversation.spec.ts`（既有文件，追加用例）

**Interfaces：**
- Consumes: 既有 `RelayConversationExecution.sourceMessageId` / `.runId` / `.waitReason`；任务 4 的 `getRunToolCalls`。
- Produces: 一行摘要，形状为「读了 N 个文件 · 改了 N 个 · 检查失败」这类按类别聚合的短句，外加一个跳到右栏轨迹页签的入口。

- [ ] **Step 1：写反例。** 断言：没有 `runId` 的执行请求不挂摘要；有 `runId` 但一行工具都没结算时显示「正在读取…」而不是「读了 0 个」；`REJECTED` 存在时摘要出现失败标记；`waitReason` 为预算耗尽时摘要**不出现**任何完成态措辞；`REQUESTED` / `PREPARED` 行不计入数字（TC-09、重点复核 5）。
- [ ] **Step 2：跑一次确认失败。** 单 worker 只跑该文件。
- [ ] **Step 3：实现。** 按 `sourceMessageId` 建索引，摘要行渲染在对应 user 消息气泡下方。**读类聚合成一项、写与检查各自成项、失败数单列**（Codex 的 `Read a, b, c` + `· N failed` 形态）。摘要只依据 `SETTLED` 行计算。点击摘要跳到右栏「轨迹」页签——通过既有 `WorkspaceSidePanel` 的 `devToolsOpen` 状态打开，不新增路由。
- [ ] **Step 4：跑测试与 typecheck。**
- [ ] **Step 5：Commit。**

## 任务 7：确认文案改写与占位标注

**Files：**
- Modify: 解释候选确认文案所在的组件（`AssistView.tsx` 或其执行摘要子组件，先定位再改）
- Modify: `apps/workbench/src/components/DevToolsPanel.tsx`（轨迹卡片上的 Git/检查结果加「本次由模型调用产生」标注）
- Test: 对应既有 spec 追加断言

**Interfaces：**
- Consumes: §18.4.1 已定的语义。
- Produces: 不含内容暗示的确认文案；带来源标注的只读结果卡片。

- [ ] **Step 1：定位现有文案。** 搜出字面「按这个执行」所在组件，确认它属于解释候选的确认路径而不是别处。
- [ ] **Step 2：改写。** 按 §18.4.1：说明「按这个目标执行，文件内容会在执行时读取后决定」。具体措辞归设计系统 token 与既有文案风格，不新造语气。
- [ ] **Step 3：加来源标注。** 轨迹卡片里模型产生的 Git / 检查结果旁标注「本次由模型调用产生」，**不提供可点按钮**（重点复核 §18.8 与 TC-13）。
- [ ] **Step 4：跑相关组件回归与 typecheck。**
- [ ] **Step 5：Commit。**

## 任务 8：真实浏览器点击与全量回归

**Files：** 无新增源文件；只跑验证。

- [ ] **Step 1：组件全量。** 固定 Node、单 worker：`corepack pnpm --dir apps/workbench run test -- --maxWorkers=1`。期望 0 失败。**不得删测试或放宽断言换绿**；若出现既有不稳定用例（如 `R02`），按既有归因方式用 `git worktree` 在 HEAD 复跑判定归属，不在本任务顺手修。
- [ ] **Step 2：真实 Chromium。** 用既有浏览器入口（`apps/workbench/tests/browser/` 下按本次交互新增的用例）。新增点击至少覆盖：打开轨迹页签 → 展开某轮 → 看到省略计数与展开全文 → 审批态显示四个状态之一。先核对该套件硬编码的端口确属本项目再启动。
- [ ] **Step 3：生产构建。** `corepack pnpm --dir apps/workbench run build`；`corepack pnpm --dir apps/api run typecheck`。期望 exit 0。
- [ ] **Step 4：API 全量单元。** 固定 Node 下 `node --test apps/api/dist/test/unit/**/*.test.js`。期望 0 失败（opt-in 真实模型用例跳过属正常）。
- [ ] **Step 5：文档检查。** `node scripts/check-docs.mjs`。期望 exit 0。
- [ ] **Step 6：** 真实 Windows 窗口、中文 IME、DPI、安装/升级/卸载**本轮不做**，按 §20.4 保持未验收，不得用浏览器成绩替代。

## 任务 9：独立复核与文档同步

**Files：**
- Modify: `docs/testing/overall-acceptance-2026-09-28.md`（本轮实际成绩与基准）
- Modify: `CODEX_NEXT_STEP.md`（只更新阶段/阻塞/下一步）
- Modify: `docs/architecture/runtime-context.md:116` 与 `docs/architecture/tool-adapters.md`（把「C 片未接入」改为已接入并注明边界；只改确实过期的表述）
- Modify: `prompts/README.md` / 本目录 `README.md`（登记本提示词）

- [ ] **Step 1：独立复核。** 派未承担本片实现的 Agent，显式 `model: gpt-6.1-sol`，在当前受验基准独立复核 §20.4 的 TC-01~TC-14。**该模型不可用时报告独立出口缺口**，不以自检替代、不静默降级。
- [ ] **Step 2：修完复验。** 发现问题先补能失败的回归再修；修复后重跑受影响套件。
- [ ] **Step 3：同步文档。** 实际结果只进统一验收表；阶段与下一步只进 `CODEX_NEXT_STEP`；不新建状态文档，不追加逐轮测试输出。完整过程输出留 `output/acceptance-raw/c-slice-tool-trajectory-20261004/`。
- [ ] **Step 4：跑 `node scripts/check-docs.mjs` 并人工核对**事实源、当前/历史边界与链接语义。
- [ ] **Step 5：最终报告（中文）。** 实际跑通的用户路径、关键代码与契约变化、每片自检/独立验收及受验基准、真实 Provider 与 Windows 的实测与未测项、文档同步、剩余阻塞与资源清理。明确声明本片通过**不**代表 M04/M06/M07 或 V1 总交付通过。
