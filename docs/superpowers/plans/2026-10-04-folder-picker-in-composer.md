# 工作空间级会话与输入区作用域行 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让协作页在没有打开目录时也能直接聊天，并把选择文件夹的控件放进输入区上方的作用域行。

**Architecture:** 后端新增一条 `BindAssistSessionProject` 命令把 `project_id IS NULL` 的会话归入项目；前端 `AssistView` 增加 target-less 模式渲染无项目会话；`CollaborationView` 把 `folder-scope-bar` 从页面顶部移到输入区上方并透传会话归属；`RecentWorkRail` 增加一次无参数 `getAssistSessions()` 取数渲染「未归属的讨论」分组。

**Tech Stack:** TypeScript、Fastify、Kysely/PostgreSQL 18、React 19、Vitest、`node:test`。

**Spec:** `docs/superpowers/specs/2026-10-04-folder-picker-in-composer-design.md`

## Global Constraints

- **不改数据库结构。** `assist_sessions.project_id` 已可空，无迁移。
- **不改 `openWorkingDirectory` 的 `OVERLAPPING_OTHER_PROJECT` 判定。** 该规则防止同一物理目录出现第二个写 Owner。
- **绑定命令只改 `project_id`**，不带 `resource_id`、不改 `task_id`、不自动发生。
- **不得提供「移出项目」**（反向解绑）。
- **不删除 `TargetPicker`。**
- 破坏性变更：**Yes**（新增端点与命令 + 一处语义收紧：已归属会话不可重绑）。
- 中文界面文案；代码标识符与 commit message 用英文。
- 单元与集成测试必须用固定 Node **v24.21.0**（`.research/runtime-cache/node-v24.21.0-win-x64`），不是 PATH 上的默认 node。用默认 node 跑会产生 12 例 `BACKUP_PACKAGE_INVALID` 假失败。
- `content-freeze` / `managed-content-store` 相关单元还需 `RELAY_FILE_IO_HELPER` 指向 `apps/desktop/src-tauri/target/debug/relay-file-io-helper.exe`，否则另有 10 例 `CONTENT_IO_FAILED`。
- 文档改动后运行 `node scripts/check-docs.mjs`，须 exit 0。

## Review Focus

以下输入类别规格未逐条覆盖，但用户会真实遇到。每条已指派给拥有该代码的任务：

1. **同一工作空间下已有活跃项目，用户却新建了无归属会话** —— 绑定必须要求显式选定项目，不自动挑「最近项目」。→ Task 1
2. **绑定命令响应丢失（传输失败）** —— 必须能按原 `command_id` 核对，不能换 ID 重试，否则可能重复绑定或漏绑定。→ Task 1（同 `command_id` 重放返回同一结果）、Task 5（查询回执 + 按原命令重试双出口）
3. **侧栏未归属分组与会话内绑定并发** —— 绑定成功后侧栏要消失；用户可能停留在旧列表上看到已消失项，刷新才准。→ Task 5
4. **用户在未归属状态下点「新建会话」按钮（草稿为空）** —— 该按钮走 `createSession()` 直接调用（`AssistView.tsx:450`），**绕过** `sendFirst` 的空内容早退，因此标题推导会真的执行到 `target.title`。target-less 下 `target` 为 `null`，直接取属性会抛错。→ Task 3
5. **用户已有未发送草稿时点「归入已有项目」** —— 绑定不改消息内容，但必须走既有 `requestTransition` 守卫，不能静默丢弃草稿。→ Task 3

---

## File Structure

**新建：**

| 文件 | 职责 |
|---|---|
| `apps/api/test/integration/assist-session-binding.integration.test.ts` | 绑定命令的真实 PG 出口 |

**修改：**

| 文件 | 改动 |
|---|---|
| `apps/api/src/assist/assist-repository.ts` | 新增 `bindSessionProject` |
| `apps/api/src/application/assist-commands.ts` | 新增 `bindAssistSessionProject` |
| `apps/api/src/api/assist-api.ts` | 新增绑定端点 |
| `apps/api/src/api/envelope.ts` | 注册新命令类型的资源定位 |
| `apps/workbench/src/api/relayClient.ts` | 新增 `bindAssistSession` |
| `apps/workbench/src/views/AssistView.tsx` | target-less 模式 + 标题推导 |
| `apps/workbench/src/views/CollaborationView.tsx` | 作用域行移位 + `session` 查询参数 + 绑定控件 |
| `apps/workbench/src/components/FolderScope.tsx` | 补 `OVERLAPPING_OTHER_PROJECT` 文案 |
| `apps/workbench/src/components/RecentWorkRail.tsx` | 未归属分组 |
| `apps/workbench/src/views/CollaborationView.css` | 作用域行定位样式 |

---

### Task 1: 绑定命令的仓储与应用层

**Files:**
- Modify: `apps/api/src/assist/assist-repository.ts`（在 `archiveSession` 之后追加）
- Modify: `apps/api/src/application/assist-commands.ts`（在 `createAssistSession` 之后追加）
- Test: `apps/api/test/integration/assist-session-binding.integration.test.ts`（新建）

**Interfaces:**
- Consumes: `repositories.assist.readSession(id, lock)`、`lockWritableProjectInWorkspace(repositories, workspaceId, projectId)`、`runIdempotentCommand`、`invalidTransition`、`resourceNotFound`。全部已存在于本文件 import 列表。
- Produces:
  ```ts
  // assist-repository.ts
  async bindSessionProject(id: string, projectId: string): Promise<void>

  // assist-commands.ts
  export type BindAssistSessionProjectResult = {
    readonly session_id: string;
    readonly project_id: string;
    readonly revision: string;
  };
  export interface BindAssistSessionProjectInput {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly commandId: string;
    readonly projectId: string;
  };
  export async function bindAssistSessionProject(
    db: DbExecutor,
    input: BindAssistSessionProjectInput,
  ): Promise<CommandOutcome<BindAssistSessionProjectResult>>;
  ```

- [ ] **Step 1: 写失败测试**

新建 `apps/api/test/integration/assist-session-binding.integration.test.ts`，照抄 `folder-first-conversation.integration.test.ts:37-45` 的 `openDatabase` / `runMigrations` / `createDataRoot` 引导与 `after` 清理，import 改为：

```ts
import { bindAssistSessionProject, createAssistSession, requestAssistMessage } from
  '../../src/application/assist-commands.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { createCommandId, createProject, createWorkspace } from './api-harness.js';
```

第一个测试：

```ts
test('工作空间级会话绑定到项目后归属落库', async () => {
  const workspaceId = await createWorkspace(app);
  const projectId = await createProject(app, workspaceId);
  const session = await createAssistSession(app.executor, {
    workspaceId, commandId: createCommandId(), projectId: null, title: '先聊聊' });
  assert.equal(session.result.project_id, null);

  const bound = await bindAssistSessionProject(app.executor, {
    workspaceId, sessionId: session.result.session_id,
    commandId: createCommandId(), projectId });

  assert.equal(bound.result.project_id, projectId);
  const read = await readSessionRow(app.executor, session.result.session_id);
  assert.equal(read.project_id, projectId);
  assert.ok(BigInt(read.revision) > 0n);
});
```

同文件另加四个测试，各自断言一个拒绝路径：

- `已归属会话不可重绑` —— 先建带 `projectId` 的会话，绑定到另一项目，断言 `code === 'INVALID_TRANSITION'` 且原 `project_id` 不变。
- `绑定到已归档项目被拒绝` —— 归档目标项目后绑定，断言 `INVALID_TRANSITION`，且**没有创建新项目**。
- `跨工作空间项目被拒绝` —— 用另一个 workspace 的 projectId，断言 `resourceNotFound` 对应的 404 错误码。
- `同 command_id 重放返回同一结果` —— 同一 `commandId` 调两次，断言两次 `result.session_id` 与 `revision` 相同，且 `replayed` 第二次为 true。

- [ ] **Step 2: 运行测试确认失败**

```
cd apps/api; powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-integration.ps1 -TestFile assist-session-binding
```

Expected: FAIL —— `Cannot find module '../../src/application/assist-commands.js'` 导出 `bindAssistSessionProject`，或 TS 编译错误 `has no exported member`。

- [ ] **Step 3: 加仓储方法**

`assist-repository.ts` 在 `archiveSession` 之后追加（沿用文件既有的 `sql` 标签模板风格）：

```ts
/** 绑定只改归属，不碰 task_id：会话仍可讨论，但执行准入另由目录决定。 */
async bindSessionProject(id: string, projectId: string): Promise<void> {
  await sql`update assist_sessions set project_id = ${projectId}, revision = revision + 1,
    updated_at = now() where id = ${id}`.execute(this.db);
}
```

- [ ] **Step 4: 加应用命令**

`assist-commands.ts` 在 `createAssistSession` 之后追加。校验顺序不可调换，每一条都是规格钉死的语义：

1. `projectId` 为空串 → `validationFailed`（字段 `project_id`）。
2. `readSession(sessionId, true)` 行锁 —— **必须先于归属判定**，否则并发绑定同一会话时后到者会读到过期的 `project_id` 并成功。
3. 会话不存在或跨 workspace → `resourceNotFound('Assist session')`。
4. `project_id !== null` → `invalidTransition('这段讨论已经归属于某项目，不能改写归属。')`。
5. `status !== 'ACTIVE'` → `invalidTransition('会话已归档，不能归入项目。')`。
6. 项目不存在或跨 workspace → `resourceNotFound('Project')`。
7. 项目已归档 → `invalidTransition('项目已归档，不能归入；不会为此新建项目。')`。**此处在锁项目之前**，归档项目不得获得写锁。
8. `lockWritableProjectInWorkspace(repositories, input.workspaceId, input.projectId)`。
9. `hasInflightMessages(sessionId)` 为真 → `invalidTransition('这段讨论还有消息在途，等它结束再归入项目。')`。
10. `bindSessionProject`，再 `readSession` 读回，返回 `{ session_id, project_id: updated.project_id ?? '', revision: toDecimalString(updated.revision) }`。读回为空则抛 `Error('assist session row vanished within its binding transaction')`。

命令壳照 `createAssistSession`（`:69-104`）：`scopeKey: httpCommandScopeKey(input.workspaceId)`、`commandType: 'BindAssistSessionProject'`、`target: { session_id: input.sessionId }`、`body: { project_id: input.projectId }`。

- [ ] **Step 5: 加 `hasInflightMessages`**

`assist-repository.ts` 追加（在途定义为 `PENDING` 或 `RUNNING`，与 `AssistView` 的消息状态一致）：

```ts
/** 在途消息未结束时改归属会让回复落到与发送时不同的作用域，因此绑定必须先拒绝。 */
async hasInflightMessages(sessionId: string): Promise<boolean> {
  const rows = await sql<{ present: boolean }>`select exists(
    select 1 from assist_messages where session_id = ${sessionId}
    and status in ('PENDING', 'RUNNING')) as present`.execute(this.db);
  return rows.rows[0]?.present === true;
}
```

- [ ] **Step 6: 运行测试确认通过**

```
cd apps/api; powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-integration.ps1 -TestFile assist-session-binding
```

Expected: PASS 5/5。

- [ ] **Step 7: 提交**

```bash
git add apps/api/src/assist/assist-repository.ts apps/api/src/application/assist-commands.ts apps/api/test/integration/assist-session-binding.integration.test.ts
git commit -m "feat(api): bind workspace-level assist sessions to a project"
```

---

### Task 2: 绑定 HTTP 端点

**Files:**
- Modify: `apps/api/src/api/assist-api.ts`（`registerAssistRoutes` 内，`POST /assist-sessions/:id/messages` 之前）
- Modify: `apps/api/src/api/envelope.ts`（`case 'CreateAssistSession'` 之后）
- Test: `apps/api/test/integration/assist-session-binding.integration.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `bindAssistSessionProject(db, input)`。
- Produces: `POST /api/v1/workspaces/{workspace_id}/assist-sessions/{session_id}/binding`，body `{ command_id: uuid, project_id: uuid }`，返回 `201` command envelope，`result` 为 `BindAssistSessionProjectResult`。

- [ ] **Step 1: 写失败测试**

在 Task 1 的测试文件追加（HTTP 层用 `api-harness` 的请求助手，形状照抄既有 assist 端点测试）：

```ts
test('绑定端点经 HTTP 归入会话并返回确切修订', async () => {
  const workspaceId = await createWorkspace(app);
  const projectId = await createProject(app, workspaceId);
  const session = await createAssistSession(app.executor, {
    workspaceId, commandId: createCommandId(), projectId: null, title: '先聊聊' });

  const response = await postBinding(app, workspaceId, session.result.session_id,
    { command_id: createCommandId(), project_id: projectId });

  assert.equal(response.status, 201);
  assert.equal(response.body.result.project_id, projectId);
});

test('绑定请求缺 project_id 返回 422', async () => {
  // 断言 status 422 且 fieldErrors 含 field === 'project_id'
});
```

- [ ] **Step 2: 运行确认失败**

```
cd apps/api; powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-integration.ps1 -TestFile assist-session-binding
```

Expected: FAIL —— 404，端点未注册。

- [ ] **Step 3: 注册端点**

`assist-api.ts`：新增 body schema（照 `createSessionBody` 写法，`Type.Object({ command_id: uuid, project_id: uuid }, strict)`），并在 `registerAssistRoutes` 内追加：

```ts
app.post('/assist-sessions/:id/binding', { schema: { params: sessionItem, body: bindSessionBody,
  response: { 201: commandEnvelopeSchema(BindSessionResult) } } },
createCommandHandler(dependencies, { commandType: 'BindAssistSessionProject',
  bodySchema: bindSessionBody,
  execute: async ({ executor, params, body }) => {
    const outcome = await bindAssistSessionProject(executor, {
      workspaceId: params.workspace_id ?? '', sessionId: params.id ?? '',
      commandId: body.command_id, projectId: body.project_id });
    return { outcome, result: outcome.result };
  } }));
```

`BindSessionResult` schema 形状照 `AssistSessionResult`，字段为 `session_id: uuid`、`project_id: uuid`、`revision: string`。

- [ ] **Step 4: 注册 envelope 资源定位**

`envelope.ts` 的 `case 'CreateAssistSession':` 之后追加：

```ts
case 'BindAssistSessionProject':
  return typeof result.session_id === 'string' ? `assist-sessions/${result.session_id}` : undefined;
```

- [ ] **Step 5: 运行确认通过**

Expected: PASS 7/7。

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/api/assist-api.ts apps/api/src/api/envelope.ts apps/api/test/integration/assist-session-binding.integration.test.ts
git commit -m "feat(api): expose assist session binding endpoint"
```

---

### Task 3: `AssistView` 的 target-less 模式

**Files:**
- Modify: `apps/workbench/src/views/AssistView.tsx:150-151`、`:404-407`、`:415`、`:283-286`
- Test: `apps/workbench/src/views/AssistView.test.tsx`（既有文件，追加用例）

**Interfaces:**
- Consumes: 无新增后端接口。
- **Produces:** `AssistView` 新增可选 prop `unassignedSession?: RelayAssistSession | null`。提供时进入 target-less 模式：`target` 为 `null` 不阻塞渲染，标题取首条消息前 30 字、为空时用 `新讨论`。

- [ ] **Step 1: 写失败测试**

```tsx
test('未归属会话在没有项目与目录时也能渲染消息流与输入区', () => {
  render(<AssistView standalone deferSessionCreation unassignedSession={unassigned} />);
  expect(screen.getByTestId("assist-first-draft")).toBeTruthy();
  // 且不再出现 target 缺失的占位
  expect(screen.queryByText("正在核对对话目标与会话")).toBeNull();
});

test('未归属会话的标题取首条消息前 30 字', () => {
  // 建会话命令的 title 应为长消息的前 30 字，不含换行
});

test('未归属状态下点新建会话按钮不会因 target 为空而抛错', () => {
  // 该按钮直连 createSession()，绕过 sendFirst 的空内容早退；草稿为空时
  // target.title 会被真的取到 —— target-less 下 target 为 null
  fireEvent.click(screen.getByTestId('assist-new-session'));
  expect(screen.queryByText(/Cannot read/)).toBeNull();
});
```

- [ ] **Step 2: 运行确认失败**

```
cd apps/workbench; npx vitest run src/views/AssistView.test.tsx
```

Expected: FAIL —— 渲染出「正在核对对话目标与会话」。

- [ ] **Step 3: 实现 target-less 模式**

三处改动：

1. `:406` 的早退改为仅在 `targetKind` 已给定且与已载入 `target` 不符时早退；`unassignedSession` 模式下跳过该早退。
2. `:408` 的 `projectWriteBlockedReason` 在 `unassignedSession` 模式下固定为 `null`（没有项目就没有归档与项目事实可失败；目录准入由 `executionScope` 单独判定）。
3. `:283-286` 的 `title`：target 存在时保持 `关于${target.title}`；否则取 `content.replace(/\s+/g, ' ').slice(0, 30)`。

   **两处必须一起改**：`title` 与 `projectId`/`taskId` 都从 `target` 取（`:284-285`）。target-less 下草稿为空时（用户点「新建会话」按钮而非发送），`content` 为空串且 `target` 为 `null` —— 此时 `content.slice(0, 30)` 得空串，违反 `0015_m04_assist.sql:11` 的 `CHECK (title <> '')`，而 `target.title` 会直接抛 TypeError。空内容时用固定标题 `新讨论`。

   注意 `sendFirst`（`:419`）的空内容早退**不覆盖**这条路径：`assist-new-session`（`:450`）直连 `createSession()`。

- [ ] **Step 4: 运行确认通过**

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/workbench/src/views/AssistView.tsx apps/workbench/src/views/AssistView.test.tsx
git commit -m "feat(workbench): render assist conversations without a project target"
```

---

### Task 4: 作用域行移位与未归属文案

**Files:**
- Modify: `apps/workbench/src/views/CollaborationView.tsx:493-518`（`folder !== null` 分支）
- Modify: `apps/workbench/src/views/CollaborationView.tsx:456-470`（`folder === null` 分支）
- Modify: `apps/workbench/src/components/FolderScope.tsx:80-87`（`notReadyReason`）
- Modify: `apps/workbench/src/views/CollaborationView.css`
- Test: `apps/workbench/src/views/CollaborationView.test.tsx`（既有文件，追加用例）

**Interfaces:**
- Consumes: Task 3 的 `unassignedSession` prop。
- Produces: 无论 `folder` 是否为 `null`，协作页中栏都渲染 `AssistView`；`folder-scope-bar` 位于消息区与输入区之间。未归属时作用域行显示「未归属的讨论」+ `[选择文件夹]` + `[归入已有项目]`。

- [ ] **Step 1: 写失败测试**

```tsx
test('未打开目录时中栏仍渲染聊天输入区', () => {
  render(<CollaborationLive client={client} />);   // 经由默认导出的连接包装
  expect(screen.getByTestId("assist-first-draft")).toBeTruthy();
});

test('目录不就绪时聊天框仍可用', () => {
  // folder.status = "NOT_READY", reason = "OVERLAPPING_OTHER_PROJECT"
  expect(screen.getByTestId("assist-first-draft")).toBeTruthy();
  expect(screen.getByTestId("folder-scope-not-ready").textContent)
    .toContain("落在另一个已受管根之内");
});

test('未归属会话不提供重绑入口', () => {
  expect(screen.queryByTestId("collab-bind-session-project")).toBeNull();
});

test('未归属会话不提供执行入口并说明先做什么', () => {
  // 0051 的 project_id NOT NULL 会让请求必然失败，界面必须先说明而不是等数据库报错
  expect(screen.queryByTestId("execution-start")).toBeNull();
  expect(screen.getByTestId("collab-unassigned-execution-hint").textContent)
    .toContain("归入项目");
});
```

- [ ] **Step 2: 运行确认失败**

```
cd apps/workbench; npx vitest run src/views/CollaborationView.test.tsx
```

Expected: FAIL —— 未打开目录时没有 `assist-first-draft`。

- [ ] **Step 3: 合并两个分支**

把 `:456` 的三层三元改为按 `task === null` 二分：`task === null` 时中栏**总是**渲染作用域行 + `AssistView`，`folder === null` 只是作用域行显示 `[选择文件夹]` 而非目录路径。删除 `:507` 的 `folderProjectId !== null &&` 条件 —— 该条件正是 `NOT_READY` 时聊天框消失的原因。

`targetKind`/`targetId` 改为：`folderProjectId !== null` 时传 `PROJECT` + `folderProjectId`（现状不变），否则传 `unassignedSession`。

未归属会话**不得**渲染执行入口（`execution-start`），改为渲染 `collab-unassigned-execution-hint`，文案说明「先把这段讨论归入项目，再选目录，才能进入执行」。规格 §5 明确要求界面先于请求说明 —— 用户不该拿到一条数据库约束错误。

- [ ] **Step 4: 补 `OVERLAPPING_OTHER_PROJECT` 文案**

`FolderScope.tsx:80-87` 的 `switch` 追加一支：

```ts
case "OVERLAPPING_OTHER_PROJECT":
  return "这个目录落在另一个已受管根之内或包含它。先选定作用域，不会另建第二个写 Owner。";
```

- [ ] **Step 5: 加作用域行样式**

`CollaborationView.css`：`folder-scope-bar` 改为位于消息区与 `.agent-chat-composer` 之间（DOM 顺序即视觉顺序，无需 `order`）。沿用既有 token，不新增数值。

- [ ] **Step 6: 运行确认通过**

```
cd apps/workbench; npx vitest run src/views/CollaborationView.test.tsx src/views/AssistView.test.tsx
```

- [ ] **Step 7: 运行前端全量**

```
cd apps/workbench; npx vitest run
```

Expected: 全部通过，无新增失败。

- [ ] **Step 8: 提交**

```bash
git add apps/workbench/src/views/CollaborationView.tsx apps/workbench/src/views/CollaborationView.css apps/workbench/src/components/FolderScope.tsx apps/workbench/src/views/CollaborationView.test.tsx
git commit -m "feat(workbench): move folder scope above the composer and keep chat available"
```

---

### Task 5: 侧栏「未归属的讨论」分组与会话深链

**Files:**
- Modify: `apps/workbench/src/api/relayClient.ts`（新增 `bindAssistSession`）
- Modify: `apps/workbench/src/components/RecentWorkRail.tsx:33-65`、`:109-120`
- Modify: `apps/workbench/src/views/CollaborationView.tsx:61-62`（`session` 查询参数）
- Test: `apps/workbench/src/components/RecentWorkRail.test.tsx`（既有文件，追加用例）

**Interfaces:**
- Consumes: Task 2 的 `POST .../assist-sessions/{id}/binding`。
- Produces:
  ```ts
  // relayClient.ts
  async bindAssistSession(input: {
    sessionId: string; commandId: string; projectId: string
  }): Promise<RelayAssistSession>;

  // CollaborationView：新增只读查询参数 ?session={sessionId}，与 ?work={taskId} 并存，session 优先
  ```

- [ ] **Step 1: 写失败测试**

```tsx
test("侧栏列出未归属的讨论且不混入项目分组", async () => {
  // getAssistSessions 返回 [{ id: "s1", projectId: null, status: "ACTIVE", title: "先聊聊" }]
  expect(screen.getByTestId("recent-work-unassigned")).toBeTruthy();
  expect(screen.getByText("先聊聊")).toBeTruthy();
});

test("已归属的会话不出现在未归属分组", async () => {
  // projectId 非 null 的会话不进该分组
});

test("未归属会话直接显示其标题", async () => {
  // projectId null、status ACTIVE；title 非空由 0015 的 CHECK (title <> '') 保证
  render(<RecentWorkRail client={client} />);
  expect(screen.getByTestId("recent-work-unassigned").textContent).toContain("先聊聊");
});

test("点击未归属会话跳到带 session 参数的深链", async () => {
  // 断言 navigate 被调用为 "/collab?session=s1"
});
```

- [ ] **Step 2: 运行确认失败**

```
cd apps/workbench; npx vitest run src/components/RecentWorkRail.test.tsx
```

Expected: FAIL —— `recent-work-unassigned` 不存在。

- [ ] **Step 3: 加客户端方法**

`relayClient.ts` 照 `createAssistSession` 的写法新增 `bindAssistSession`，POST 到 `/assist-sessions/${sessionId}/binding`，body `{ command_id, project_id }`，返回 `sessionDto` 形状映射为 `RelayAssistSession`。

- [ ] **Step 4: 侧栏取数与分组**

`RecentWorkRail.tsx` 的 `load` 在 `Promise.all` 中加入 `client.getAssistSessions()`（**不传参数**，服务端不加过滤条件）。存入 `Loaded` 状态的 `unassigned` 字段，筛 `projectId === null && status === "ACTIVE"`。

渲染时在项目分组之后追加独立分组，`data-testid="recent-work-unassigned"`，标题「未归属的讨论」，**不套 `<details>` 项目语义**。点击 `navigate("/collab?session=" + id)`。

侧栏条目直接用 `session.title`。`0015_m04_assist.sql:11` 的 `CHECK (title <> '')` 保证标题非空，因此不需要也不应加「空讨论」之类的兜底文案。

该分组的额外请求若失败（401/403/404），按既有 `RelayApiError` 分支处理：`setError(message)`，不静默显示空分组 —— 空分组会被误读成「没有未归属讨论」。

- [ ] **Step 5: 协作页接受 `session` 参数**

`CollaborationView.tsx:61-62` 读取 `search.get("session")`。`workId` 与 `sessionId` 同时存在时 `session` 优先：该分支下 `task` 保持 `null`，`folder` 保持现状（不因为恢复会话而自动打开目录），中栏按 Task 4 的 target-less 路径渲染并加载该会话。

- [ ] **Step 6: 加绑定控件**

Task 4 的作用域行在未归属时追加 `[归入已有项目]` 按钮（`data-testid="collab-bind-session-project"`）。点击后走既有 `requestTransition` 守卫（草稿保护，Review Focus 第 5 条），再选项目、最后调 `client.bindAssistSession`。成功后刷新侧栏并移除该会话的未归属状态。

已归属时不渲染此按钮（Review Focus 第 1 条：不自动挑最近项目，必须显式选择）。

绑定采用「查询回执 + 按原命令重试」双出口，形状照 `CollaborationView.tsx` 既有的 `checkRecovery` / `recoveries` 机制（`:349-367`）：`command_id` 与载荷在点击时固定并随未决记录留存；传输失败时保留原 `command_id`，不换 ID 重试（Review Focus 第 2 条）。回执查不到时停在未决状态，不猜结果。

- [ ] **Step 7: 运行确认通过**

```
cd apps/workbench; npx vitest run src/components/RecentWorkRail.test.tsx
cd apps/workbench; npx vitest run
```

- [ ] **Step 8: 提交**

```bash
git add apps/workbench/src/api/relayClient.ts apps/workbench/src/components/RecentWorkRail.tsx apps/workbench/src/views/CollaborationView.tsx apps/workbench/src/components/RecentWorkRail.test.tsx
git commit -m "feat(workbench): surface unassigned discussions in the recent work rail"
```

---

### Task 6: 文档同步

**Files:**
- Modify: `docs/frontend/workbench-design.md`（§18.1、§18.4、§18.5）
- Modify: `docs/api/http-command-contract.md`（新增绑定端点）
- Modify: `docs/architecture/domain-model.md`（§12）
- Modify: `docs/frontend/design-system.md`（作用域行与未归属分组）
- Modify: `CODEX_NEXT_STEP.md`

- [ ] **Step 1: 更新工作台设计 §18.1**

在目录入口表格后补：未选目录时可先普通讨论，会话为工作空间级（`project_id` 为空）；归入项目是显式动作，不自动挑选；已归属会话不可改写归属；不提供移出项目。

- [ ] **Step 2: 更新 §18.4**

补作用域行位于输入区上方、target-less 模式、`folder-scope-bar` 不再是页面顶部区块。更新元素清单，加入 `recent-work-unassigned`、`collab-bind-session-project`。

- [ ] **Step 3: 更新 §18.5**

补绑定命令的未决回执沿用原 `command_id` 核对、不换 ID 重试。

- [ ] **Step 4: 更新 HTTP 契约**

在 assist 会话段新增绑定端点，标注 **Breaking Change：Yes**、无迁移。

- [ ] **Step 5: 更新领域模型 §12 与设计系统**

§12 补会话归属的应用责任；设计系统补作用域行与「未归属的讨论」分组的视觉规则，说明该分组不套项目语义。

- [ ] **Step 6: 运行文档检查**

```
node scripts/check-docs.mjs
```

Expected: exit 0。

- [ ] **Step 7: 提交**

```bash
git add docs CODEX_NEXT_STEP.md
git commit -m "docs: record workspace-level sessions and the composer scope row"
```

---

## 出口

全部任务完成后必须实际运行并如实记录，不得以规格替代结果：

```
cd apps/api; powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-integration.ps1 -TestFile assist-session-binding
cd apps/api; npx tsc --noEmit -p tsconfig.json
cd apps/workbench; npx tsc --noEmit
cd apps/workbench; npx vitest run
node scripts/check-docs.mjs
```

**未覆盖、不得声称通过**：真实 Windows 原生选择器、取消、重启、中文 IME、DPI、内容缩放；侧栏与绑定的真实浏览器端到端；真实模型下的 target-less 对话质量；`OVERLAPPING_OTHER_PROJECT` 状态在真实窗口内的完整人工路径。