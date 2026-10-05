# 会话模式单选框与人设 bot 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在协作页聊天框加一个两档单选框，A 档是现有普通 Agent（语义不变），B 档是用户自建具名 bot 的人设会话——可用只读工具读真实文件与已选资料，但绝不建 Task、绝不委派、绝不写入、绝不申请审批。

**Architecture:** B 档不新建执行链，复用既有 Assist 生成身份（`assist_messages` 的 PENDING→RUNNING 领取、`worker_id`、心跳租约、`cancel_requested` 轮询、Worker CAS 结算）。只新增三处：`bot_profiles` 与 `assist_sessions` 的身份列；`session_tool_calls` 会话级工具账本；Gateway 第四种 origin `ASSIST_BOT`（只读）。模式只作为会话建立时冻结的身份，读取时按当前连接与权限裁剪词表。

**Tech Stack:** TypeScript、Fastify、Kysely、PostgreSQL 18、React 19 + Vite、Vitest、Playwright（Chromium）、Node 24.21.0（`.research/runtime-cache`，不是 PATH 上的 v22）

**Spec:** `docs/superpowers/specs/2026-10-05-conversation-mode-and-persona-bots-design.md`

## Global Constraints

这些约束适用于每一个任务，不再逐条重复：

- 唯一逻辑写入 Owner 不变：会话与消息事实只由 `AssistRepository` 写；bot 配置只由 `BotProfileRepository` 写；工具请求只由 `SessionToolCallRepository` 写。
- B 档**绝不**产生 `tasks`、`runs`、`run_scope_grants`、`run_tool_calls`、Review、`CompletionRecord`、`ACTION_APPROVAL`。
- B 档**会**产生只读 `logical_operations` / `invocation_attempts` 行，`capability_key ∈ {FILE_READ, FILE_QUERY, GIT_READ}`。
- 人设快照冻结的是**文本，不是能力**。每轮按当前连接与权限重新裁剪工具词表；连接被删立刻失去对应工具。
- 会话建立后 `conversation_mode` / `bot_profile_id` / `bot_profile_revision` / `bot_role_snapshot` 不可改写。换 bot 必须换会话。
- B 档模型回复永远不是 PASS，不进 Verification / Review / CompletionRecord。
- A 档标签不得写「可派发子 Agent」——ADR-017 至今零代码。
- 不启动第二 Runtime、不引入新依赖、不建通用 DSL、不留无调用方的占位模块。
- 迁移编号实施时按当时链末取（本计划写作时链末为 `0058`），不预占、不改已应用迁移。
- Node 一律用 `.research/runtime-cache/node-v24.21.0-win-x64/node.exe`；API 单元需 `RELAY_FILE_IO_HELPER` 指向 `apps/desktop/src-tauri/target/debug/relay-file-io-helper.exe`。
- 说明、进度与交付用中文；代码标识符与 commit message 用英文。
- 共享工作区有并行 Agent 的在途改动（`AppShell.tsx`、`DesktopTitleBar.tsx`、`styles.css`、`titlebar*` spec、`design-system.md`、`workbench-design.md` 等）。不覆盖、不回退、不顺手重构别人的文件；自己的任务只碰本计划列出的文件。

## Review Focus

规格没说、但真实用户一定会碰到、且最容易被漏掉的输入与状况。每条都在下面某个任务的步骤里有对应测试：

1. **B 档模型请求写工具**——必须类型化拒绝并回传，而不是静默丢弃或照做。用户在界面上要看得见这次被拒。（Task 2）
2. **bot 已归档但用户还在那条会话里发消息**——必须被拒并给「重新选择 bot」入口，不能靠旧快照继续放行。（Task 3）
3. **bot 建好后连接被删**——B 档词表必须当场收窄，而不是沿用建会话时的能力。（Task 3）
4. **同一条消息在网络抖动下重复提交**——同 `command_id` 同载荷必须返回原对象，不能建出两条消息或两个轮次。（Task 3）
5. **B 档会话里连发第二条**——必须 409 明确拒绝，不能变成看不见的队列。（Task 3）

---

### Task 1: bot 配置与会话模式冻结

**Files:**
- Create: `apps/api/migrations/0059_m04_persona_bot_sessions.sql`
- Create: `apps/api/src/assist/bot-profile-repository.ts`
- Create: `apps/api/src/application/bot-profile-commands.ts`
- Create: `apps/api/src/api/bot-profile-api.ts`
- Modify: `apps/api/src/infrastructure/database-schema.ts`（新增 `BotProfileRow`、`SessionToolCallRow`；`AssistSessionRow` 增 5 个字段）
- Modify: `apps/api/src/application/unit-of-work.ts`（注册 `botProfiles`）
- Modify: `apps/api/src/application/assist-commands.ts`（`createAssistSession` 接模式并冻结快照）
- Modify: `apps/api/src/api/routes.ts`（挂载 bot 路由）
- Test: `apps/api/test/unit/bot-profile.test.ts`
- Test: `apps/api/test/integration/persona-bot-session.integration.test.ts`

**Interfaces:**
- Consumes: 既有 `runIdempotentCommand`、`requireRevision`、`validationFailed`、`invalidTransition`、`resourceNotFound`、`AssistRepository.insertSession`。
- Produces:
  ```ts
  export type ConversationMode = 'AGENT' | 'BOT';

  export interface BotProfileRow {
    readonly id: string; readonly workspace_id: string; readonly name: string;
    readonly role_description: string; readonly tone: string | null;
    readonly read_scope: JsonObject; readonly revision: bigint;
    readonly status: 'ACTIVE' | 'ARCHIVED'; readonly created_at: Date; readonly updated_at: Date;
  }

  // application/bot-profile-commands.ts
  export function frozenRoleSnapshot(profile: BotProfileRow): JsonObject;
  export function personaDisplayLabel(snapshot: JsonObject, revision: bigint): string;
  export async function createBotProfile(db: DbExecutor, input: {
    readonly workspaceId: string; readonly commandId: string; readonly name: string;
    readonly roleDescription: string; readonly tone?: string | undefined;
    readonly readScope?: JsonObject | undefined;
  }): Promise<CommandOutcome<JsonObject>>;
  export async function reviseBotProfile(db: DbExecutor, input: {
    readonly workspaceId: string; readonly botProfileId: string; readonly commandId: string;
    readonly expectedRevision: string; readonly name: string;
    readonly roleDescription: string; readonly tone?: string | undefined;
    readonly readScope?: JsonObject | undefined;
  }): Promise<CommandOutcome<JsonObject>>;
  export async function archiveBotProfile(db: DbExecutor, input: {
    readonly workspaceId: string; readonly botProfileId: string; readonly commandId: string;
    readonly expectedRevision: string;
  }): Promise<CommandOutcome<JsonObject>>;

  // assist-commands.ts 的入参新增（既有调用不传即 AGENT，语义不变）
  export interface CreateAssistSessionInput {
    readonly workspaceId: string;
    readonly commandId: string;
    readonly projectId?: string | null;
    readonly taskId?: string | null;
    readonly title: string;
    /** 缺省即 'AGENT'；既有调用方不传时语义不变。 */
    readonly conversationMode?: ConversationMode | undefined;
    /** conversationMode='BOT' 时必填。 */
    readonly botProfileId?: string | undefined;
  }
  ```

- [ ] **Step 1: 写失败的迁移测试**

在 `apps/api/test/integration/persona-bot-session.integration.test.ts` 新建文件，参照同目录既有迁移测试的建库/夹具写法（读 `apps/api/test/integration/migration.integration.test.ts` 的开头与 `tool-loop.integration.test.ts` 的夹具助手）。断言：

```ts
// 1) 新表与新列存在
const cols = await sql<{ column_name: string }>`
  select column_name from information_schema.columns
  where table_name = 'assist_sessions'
    and column_name in ('conversation_mode','bot_profile_id','bot_profile_revision',
      'bot_role_snapshot','remember')`.execute(db);
assert.equal(cols.rows.length, 5);

// 2) CHECK：mode=BOT 必须带 bot_profile_id，AGENT 必须不带
await assert.rejects(() => sql`
  insert into assist_sessions (id, workspace_id, project_id, task_id, title,
    conversation_mode, bot_profile_id)
  values (${randomUUID()}, ${ws}, null, null, 'x', 'BOT', null)`.execute(db));

// 3) 既有会话按 AGENT 读出（默认值）
// 4) bot_profiles 同 workspace 重名被拒（唯一索引忽略已归档）
```

- [ ] **Step 2: 跑测试确认失败**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile persona-bot-session`
Expected: FAIL——表/列不存在。

- [ ] **Step 3: 写迁移 `0059_m04_persona_bot_sessions.sql`**

照 `apps/api/migrations/0058_m06_user_action_origin.sql` 的注释风格：开头写清为什么需要这三张形状、哪些 CHECK 被放宽、不新增 GRANT 的理由。内容：

```sql
-- 新表 bot_profiles：workspace 作用域，name 部分唯一（忽略 ARCHIVED）。
create table bot_profiles (
  id uuid primary key,
  workspace_id uuid not null references workspaces (id),
  name text not null,
  role_description text not null,
  tone text,
  read_scope jsonb not null default '{}'::jsonb,
  revision bigint not null default 1,
  status text not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_bot_profile_status check (status in ('ACTIVE','ARCHIVED'))
);
create unique index uq_bot_profile_name on bot_profiles (workspace_id, lower(name))
  where status = 'ACTIVE';
create index ix_bot_profile_workspace on bot_profiles (workspace_id, status, id);

-- assist_sessions 增列：既有行按 AGENT 读出，不虚构 bot 关系。
alter table assist_sessions add column conversation_mode text not null default 'AGENT';
alter table assist_sessions add column bot_profile_id uuid references bot_profiles (id);
alter table assist_sessions add column bot_profile_revision bigint;
alter table assist_sessions add column bot_role_snapshot jsonb;
alter table assist_sessions add column remember boolean not null default true;
alter table assist_sessions add constraint ck_assist_session_mode check (
  (conversation_mode = 'AGENT' and bot_profile_id is null and bot_profile_revision is null
    and bot_role_snapshot is null)
  or (conversation_mode = 'BOT' and bot_profile_id is not null
    and bot_profile_revision is not null and bot_role_snapshot is not null)
);
```

`session_tool_calls` 表**在 Task 2 建**（与 `ASSIST_BOT` origin 同一条迁移，见 Task 2 Step 3），本迁移只做身份。

- [ ] **Step 4: 加 schema 行与 repository**

`database-schema.ts` 加 `BotProfileRow`（签名见 Interfaces）；`AssistSessionRow` 追加：

```ts
  readonly conversation_mode: 'AGENT' | 'BOT';
  readonly bot_profile_id: string | null;
  readonly bot_profile_revision: bigint | null;
  readonly bot_role_snapshot: JsonObject | null;
  readonly remember: boolean;
```

新建 `apps/api/src/assist/bot-profile-repository.ts`，方法签名：`insert(input)`、`read(id, lock?)`、`listActive(workspaceId)`、`revise(input: { id; expectedRevision; name; roleDescription; tone; readScope })`（`where id = $ and revision = $ and status = 'ACTIVE'`，返回是否命中）、`archive(id, expectedRevision)`、`listSessionIds(botProfileId)`。全部用既有 `sql` 标签风格。

- [ ] **Step 5: 写命令层单元测试**

`apps/api/test/unit/bot-profile.test.ts`（node:test，纯函数部分不碰 DB）：

```ts
test('frozenRoleSnapshot 只含四个字段，不含权限', () => {
  const snapshot = frozenRoleSnapshot(profileFixture);
  assert.deepEqual(Object.keys(snapshot).sort(),
    ['name','read_scope','role_description','tone']);
  assert.equal('capabilities' in snapshot, false);
  assert.equal('connections' in snapshot, false);
});

test('personaDisplayLabel 用建会话时冻结的修订，不读当前 bot', () => {
  assert.equal(personaDisplayLabel({ name: '审读' }, 3n), '审读 · 人设 v3');
});

test('read_scope 只能缩小，扩大范围的路径被拒', () => { /* 见 Step 6 的 validateReadScope */ });
```

- [ ] **Step 6: 实现命令层**

`bot-profile-commands.ts`：三个用例都用 `runIdempotentCommand`，`commandType` 分别为 `CreateBotProfile` / `ReviseBotProfile` / `ArchiveBotProfile`；`revise`/`archive` 先 `requireRevision` 再持行锁 CAS；重名捕获唯一冲突后翻译为 `validationFailed([{ field: 'name', message: '已有同名 bot，请换一个名字。' }])`，**不得**改动已有行。

`read_scope` 只接受 `{}` 或 `{ roots: string[] }`，且每项必须是受管根内的相对路径；出现 `..`、绝对路径或空串 → `validationFailed`。这是「只能缩小」的唯一实现点，注释写明 bot 不携带任何能力。

`unit-of-work.ts` 注册 `botProfiles`。

- [ ] **Step 7: `createAssistSession` 冻结身份**

在既有 `execute` 内、`repositories.assist.insertSession` 之前插入：`conversationMode === 'BOT'` 时读 bot（须 `ACTIVE` 且同 workspace），把 `bot_profile_revision` 与 `frozenRoleSnapshot` 一起传给 `insertSession`；`AGENT` 时四个 bot 字段全为 `null`。`body` 里带上 `conversation_mode` 与 `bot_profile_id`，使同 `command_id` 异载荷被既有 `CommandIdReusedError` 拒绝。

- [ ] **Step 8: 加 HTTP 端点**

`bot-profile-api.ts`：`POST /workspaces/{workspace_id}/bot-profiles`、`POST /bot-profiles/{id}/revise`、`POST /bot-profiles/{id}/archive`、`GET /workspaces/{workspace_id}/bot-profiles`（只列 `ACTIVE`）。沿用 `api/envelope.ts` 的响应包装与 `domain-schemas.ts` 的校验风格；`routes.ts` 挂载。建会话端点新增两个**可选** body 字段 `conversation_mode` / `bot_profile_id`。

- [ ] **Step 9: 跑测试确认通过**

Run: 迁移集成 + 单元
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile persona-bot-session
$env:RELAY_FILE_IO_HELPER="apps/desktop/src-tauri/target/debug/relay-file-io-helper.exe"
node --test "apps/api/dist/test/unit/bot-profile.test.js"
```
Expected: 全部 PASS，临时集群删除为 true。

- [ ] **Step 10: 类型检查**

Run: `pnpm --filter @relay-agent/api run typecheck`
Expected: exit 0。

- [ ] **Step 11: Commit**

```bash
git add apps/api/migrations apps/api/src apps/api/test
git commit -m "feat(api): add persona bot profiles and frozen conversation modes"
```

---

### Task 2: B 档只读执行：ASSIST_BOT origin 与会话级工具轮次

**Files:**
- Create: `apps/api/migrations/0060_m04_assist_bot_origin.sql`
- Create: `apps/api/src/assist/session-tool-call-repository.ts`
- Create: `apps/api/src/application/persona-bot-loop.ts`
- Modify: `apps/api/src/application/gateway-actions.ts`（`GatewayOrigin` 增 `ASSIST_BOT`、`originAllows`、`originDenialDetail`、`operationBelongsToOrigin`）
- Modify: `apps/api/src/application/assist-runner.ts`（按 `session.conversation_mode` 分派）
- Modify: `apps/api/src/infrastructure/database-schema.ts`（`SessionToolCallRow`）
- Test: `apps/api/test/unit/persona-bot-loop.test.ts`
- Test: `apps/api/test/integration/persona-bot-round.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ConversationMode`、`BotProfileRow`、`AssistSessionRow.bot_role_snapshot`；既有 `declaredToolSpecs`、`readInternalTool`、`validateToolArguments`、`ToolRequestRejected`、`prepareGatewayAction`、`dispatchGatewayAction`、`recordModelInvocation`、`AssistRepository.isCancelRequested`。
- Produces:
  ```ts
  // application/persona-bot-loop.ts
  export const BOT_READ_ONLY_TOOLS: readonly InternalToolName[];
  export function botToolNames(available: readonly InternalToolName[]): readonly InternalToolName[];
  export function botSystemPrompt(snapshot: JsonObject, readScopeRoots: readonly string[]): string;
  export async function runPersonaBotGeneration(db: DbExecutor, input: {
    readonly session: AssistSessionRow; readonly message: AssistMessageRow;
    readonly workerId: string; readonly storage: ManagedContentStore;
    readonly modelPort: AssistModelPort; readonly signal: AbortSignal;
    readonly onTextDelta?: ((piece: string) => Promise<void>) | undefined;
  }): Promise<AssistGenerationOutcome>;

  // assist/session-tool-call-repository.ts
  export interface SessionToolCallRow {
    readonly id: string; readonly session_id: string; readonly message_id: string;
    readonly round: number; readonly ordinal: number; readonly tool_name: string;
    readonly arguments: JsonObject; readonly arguments_sha256: string;
    readonly status: 'REQUESTED'|'SETTLED'|'REJECTED'|'ABANDONED'|'UNKNOWN';
    readonly operation_id: string | null; readonly rejection_reason: string | null;
    readonly rejection_detail: string | null; readonly result_digest: string | null;
    readonly requested_at: Date; readonly settled_at: Date | null;
  }
  ```

- [ ] **Step 1: 写失败的纯函数测试**

`apps/api/test/unit/persona-bot-loop.test.ts`：

```ts
test('botToolNames 只保留只读工具，且按连接可用集求交', () => {
  assert.deepEqual([...botToolNames(['read_file','find_paths','apply_changeset','run_check'])],
    ['read_file','find_paths']);
});

test('botSystemPrompt 声明只读边界且不含执行承诺', () => {
  const prompt = botSystemPrompt({ name: '审读', role_description: '只读复核', tone: null,
    read_scope: {} }, []);
  assert.match(prompt, /只读/);
  assert.match(prompt, /不创建任务|不新建 Task/);
  assert.equal(/可以(修改|写入)|可以派发/.test(prompt), false);
});
```

再加一条：`botToolNames` 在 `read_scope` 指定根时返回的 `find_paths` 参数说明里出现该根（Step 3 的实现决定）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "apps/api/dist/test/unit/persona-bot-loop.test.js"`（先 `pnpm --filter @relay-agent/api run build`）
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 写迁移 `0060_m04_assist_bot_origin.sql`**

照 `0058` 的四条 CHECK 形状，逐条**完整重述**既有分支再追加（`0054` 曾因漏掉分支造成 9 例既有动作违反约束，注释里写明这个教训）：

1. `ck_logical_operation_origin` 追加 `(origin = 'ASSIST_BOT' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NULL)`
2. `ck_logical_operation_resource` 追加 `(capability_key IN ('FILE_READ','FILE_QUERY','GIT_READ') AND origin = 'ASSIST_BOT' AND resource_id IS NOT NULL)`
3. `ck_invocation_run_identity` 追加 ASSIST_BOT 支：绑定 `resource_id`、`task_id`/`run_id`/`ownership_epoch`/`worker_id`/`worker_epoch`/`resource_claim_id`/`claim_token`/`claim_epoch` **全为 NULL**（只读不建 claim，与 `0058` 同理：资源排他靠 `listOccupiedResources()` 拒绝，不靠 claim 争用）
4. 新建 `session_tool_calls`：唯一约束 `(session_id, message_id, round, ordinal)`；外键到 `assist_sessions(id)` 与 `assist_messages(id)`；`operation_id` 指向 `logical_operations(id)`，**可空**（被拒请求不连 Operation）

- [ ] **Step 4: 写 origin 单元断言**

在 `apps/api/test/unit/persona-bot-loop.test.ts` 加：

```ts
test('ASSIST_BOT 只放行只读动作，写类一律拒绝', () => {
  assert.equal(originAllows({ kind: 'ASSIST_BOT', projectId: 'p', resourceId: 'r',
    sessionId: 's', messageId: 'm' }, 'READ_FILE', 'FILE_READ'), true);
  assert.equal(originAllows({ kind: 'ASSIST_BOT', projectId: 'p', resourceId: 'r',
    sessionId: 's', messageId: 'm' }, 'APPLY_CHANGESET', 'FILE_WRITE'), false);
  assert.equal(originAllows({ kind: 'ASSIST_BOT', projectId: 'p', resourceId: 'r',
    sessionId: 's', messageId: 'm' }, 'GIT_STAGE', 'GIT_WRITE'), false);
  assert.equal(originAllows({ kind: 'ASSIST_BOT', projectId: 'p', resourceId: 'r',
    sessionId: 's', messageId: 'm' }, 'CLI_RUN', 'CLI_RUN'), false);
});
```

- [ ] **Step 5: 实现 origin 与准入**

`gateway-actions.ts`：

```ts
export type GatewayOrigin =
  | /* 既有三种 */
  | { readonly kind: 'ASSIST_BOT'; readonly projectId: string; readonly resourceId: string;
      readonly sessionId: string; readonly messageId: string };
```

`originAllows` 新增分支：`ASSIST_BOT` 只放行 `capability ∈ {FILE_READ, FILE_QUERY, GIT_READ}`。`originDenialDetail` 补一句中文说明。`operationBelongsToOrigin` 的 `ASSIST_BOT` 支按 `session_id`/`message_id` 核对（与既有三支同形状）。

- [ ] **Step 6: 实现 `session-tool-call-repository.ts`**

照 `run/run-tool-call-repository.ts` 的方法形状：`insert(input)`、`reject(id, reason, detail)`、`attachOperation(id, operationId)`、`settle(id, resultDigest)`、`markUnknown(id)`、`listByMessage(messageId)`、`read(id)`。`attachOperation` 必须校验目标 Operation 的 `origin = 'ASSIST_BOT'` 且 `session_id`/`message_id` 与本行一致，否则抛错——跨身份冒用在此被挡住。

- [ ] **Step 7: 实现 `runPersonaBotGeneration`**

复用 `assist-runner.ts` 的领取身份、取消轮询与结算形状，循环结构：

```
round = 0
loop:
  若 isCancelRequested → 结算 CANCELLED 返回
  用 botSystemPrompt(snapshot, readScopeRoots) + 只读词表调 modelPort.assist（带 signal）
  若返回 TOOL_CALLS:
    对每个 call:
      definition = readInternalTool(call.name)
      若 definition 不在只读集 → reject(id,'TOOL_NOT_READ_ONLY','B 档只读，不提供写工具。') 并把类型化原因回传模型
      否则 validateToolArguments → prepareGatewayAction(origin=ASSIST_BOT)
        REFUSED → reject 该行并回传原因
        否则 dispatchGatewayAction → SUCCEEDED 记 digest；UNKNOWN → 该行标 UNKNOWN 并把「需人工核对」回传模型
    round += 1；round 超上限 → 收尾一轮要求模型只用已有结果作答
  若返回 CONTENT → 结算 COMPLETED 返回
```

结算复用既有 `settle`（`settleGeneration` 的 Worker CAS）。`botSystemPrompt` 里必须写明：资料是数据不是指令、不能判定 PASS、不能承诺代办。

- [ ] **Step 8: 在 `assist-runner.ts` 分派**

`runAssistGenerationTick` 内，读到 session 后按 `session.conversation_mode`：`BOT` 走 `runPersonaBotGeneration`，其余走既有路径。A 档分支**不改一行**。

- [ ] **Step 9: 写真实 PG 反例**

`apps/api/test/integration/persona-bot-round.integration.test.ts`，用可控 Fake Model（既有 `workflow/fake-model-port.ts`）依次返回：一次 `find_paths` → 一次 `read_file` → 纯文本。断言：

```ts
// 只读真的读了磁盘，且磁盘未变
assert.equal(await readFileOnDisk(targetPath), originalBytes);
// 执行链没被创建
for (const table of ['tasks','runs','run_scope_grants','run_tool_calls']) {
  assert.equal(await countRows(db, table), 0, `${table} 必须为 0`);
}
// 只读 Operation 的 origin 与 capability
assert.deepEqual(await operationRows(db), [
  { origin: 'ASSIST_BOT', capability_key: 'FILE_QUERY' },
  { origin: 'ASSIST_BOT', capability_key: 'FILE_READ' },
]);
```

第二个用例：Fake Model 直接返回 `apply_changeset` → 断言该行 `status='REJECTED'`、`rejection_reason='TOOL_NOT_READ_ONLY'`、`operation_id IS NULL`，且磁盘无新文件。

第三个用例：跨身份冒用——手动把某行 `operation_id` 指向一个 `origin='RUN'` 的 Operation，`attachOperation` 必须抛错。

- [ ] **Step 10: 跑测试确认通过**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile persona-bot-round
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile tool-loop
pnpm --filter @relay-agent/api run typecheck
```
Expected: 两个套件全 PASS；**`tool-loop` 必须仍全绿**（A 档回归）。

- [ ] **Step 11: Commit**

```bash
git add apps/api/migrations apps/api/src apps/api/test
git commit -m "feat(api): run persona bot rounds as read-only session tool calls"
```

---

### Task 3: 准入、幂等、停止与权限撤销

**Files:**
- Modify: `apps/api/src/application/assist-commands.ts`（`requestAssistMessage` 的模式规则）
- Test: `apps/api/test/integration/persona-bot-admission.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `createAssistSession` 模式字段；Task 2 的 `botToolNames`。
- Produces: 无新导出。B 档规则全部落在既有 `requestAssistMessage` 内。

- [ ] **Step 1: 写五条反例**

`persona-bot-admission.integration.test.ts`：

```ts
test('B 档第二条在途消息被 409 拒绝，不排队', async () => { /* 发两条，第二条 invalidTransition */ });
test('B 档拒绝 skill_ref 与非 DISCUSS intent', async () => { /* 两个用例 */ });
test('bot 归档后既有会话发消息被拒，并给出重新选择入口的错误码', async () => { /* 断言 code 与 detail 含 bot 名 */ });
test('bot 归档后读取历史仍可读', async () => { /* 消息列表照常返回 */ });
test('连接被删后 B 档词表收窄为不含该能力的工具', async () => {
  /* 删 FILE_READ 连接后重跑一轮，断言 session_tool_calls 无 read_file，
     且模型收到的是类型化原因而不是静默 */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `run-integration.ps1 -TestFile persona-bot-admission`
Expected: 至少前四条 FAIL。

- [ ] **Step 3: 实现准入规则**

`requestAssistMessage` 的 `execute` 内，在既有 `intent` 校验之后加：

- `session.conversation_mode === 'BOT'` 时：`input.skillRef !== undefined` → `validationFailed`（B 档不调 Skill）；`intent !== 'DISCUSS'` → `invalidTransition`（B 档只有只读回答）
- B 档且 `await repositories.assist.hasInflightMessages(session.id)` → `invalidTransition('这段对话正在回答上一条，请等它结束再发。')`。**不引入队列**；错误文案不得出现「排队」
- B 档且会话 `status !== 'ACTIVE'` → 既有归档分支照旧
- 会话关联的 bot 已 `ARCHIVED` → `invalidTransition`，detail 必须含 bot 名与「重新选择 bot」指引

`body` 加入 `conversation_mode`，使同 `command_id` 在 A/B 之间重放被 `CommandIdReusedError` 拒绝。

- [ ] **Step 4: 连接撤销即时收窄**

`persona-bot-loop.ts` 每轮调用 `botToolNames(availableForCurrentConnections)`，`availableForCurrentConnections` 从**当前**连接解析（复用既有 `resolveConnectionConfig` 形状），不读 `bot_role_snapshot` 里的任何能力信息。在函数注释里写明：快照冻结文本，不冻结能力。

- [ ] **Step 5: 停止复用既有通道**

确认 `cancelAssistMessage` 对 B 档消息同样生效（`setCancelRequested` → 轮询 abort → `settleGeneration` CAS）。**不加新列、不加新端点**。在 `assist-runner.ts` 的 B 档分支注释里写明这一复用。

- [ ] **Step 6: 跑测试确认通过**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile persona-bot-admission
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile folder-first-conversation
pnpm --filter @relay-agent/api run typecheck
```
Expected: 新套件全 PASS；`folder-first-conversation`（A 档入口）仍全绿。

- [ ] **Step 7: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(api): refuse queued, skill and archived-bot messages in persona sessions"
```

---

### Task 4: 前端模式单选框与两档呈现

**Files:**
- Modify: `apps/workbench/src/api/relayClient.ts`（bot 清单/建/改/归档、建会话模式字段、会话模式读取、工具轨迹读取）
- Create: `apps/workbench/src/components/ConversationModeSwitch.tsx`
- Create: `apps/workbench/src/components/BotProfilePicker.tsx`
- Modify: `apps/workbench/src/views/AssistView.tsx`（工具行接入、模式切导航、B 档呈现）
- Modify: `apps/workbench/src/views/AssistView.css`
- Test: `apps/workbench/tests/conversationModeSwitch.spec.ts`
- Test: `apps/workbench/tests/personaBotComposer.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 HTTP 端点与建会话字段；既有 `relayClient` 的 `AssistSession` 类型与错误处理形状。
- Produces:
  ```ts
  // api/relayClient.ts
  export interface BotProfile { readonly id: string; readonly name: string;
    readonly roleDescription: string; readonly tone: string | null;
    readonly readScope: ReadScope; readonly revision: string;
    readonly status: 'ACTIVE' | 'ARCHIVED'; }
  export type ConversationMode = 'AGENT' | 'BOT';

  // components/ConversationModeSwitch.tsx
  export interface ConversationModeSwitchProps {
    readonly mode: ConversationMode; readonly disabled: boolean;
    readonly disabledReason: string | null;
    readonly onChange: (next: ConversationMode) => void;
  }

  // components/BotProfilePicker.tsx
  export interface BotProfilePickerProps {
    readonly profiles: readonly BotProfile[]; readonly selectedId: string | null;
    readonly remember: boolean; readonly disabled: boolean;
    readonly onSelect: (id: string) => void;
    readonly onRememberChange: (next: boolean) => void;
    readonly onCreate: (input: { name: string; roleDescription: string;
      tone: string | null }) => Promise<void>;
  }
  ```

- [ ] **Step 1: 写失败的组件测试**

`apps/workbench/tests/conversationModeSwitch.spec.ts`：

```ts
test('两个单选项渲染，A 档默认选中', () => { /* getByRole('radio', { name: '普通 Agent' }) checked */ });
test('在途时两档都禁用并给出原因', () => { /* disabledReason 文案可见 */ });
test('radio 组可用方向键切换', () => { /* keyboard */ });

// tests/personaBotComposer.spec.ts
test('B 档隐藏发送选项，显示只读说明', () => { /* queryByTestId('assist-intent') 为 null */ });
test('A 档保留发送选项', () => { /* 存在 */ });
test('B 档工具行含 bot 选择与不记住开关', () => { /* 两者存在 */ });
test('B 档不渲染执行摘要', () => { /* ExecutionSummary 缺席 */ });
test('切到 B 档触发导航而不是原地改权限', () => { /* 断言 onNavigateToBot 被调用 */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node apps/workbench/node_modules/vitest/vitest.mjs run tests/conversationModeSwitch.spec.ts tests/personaBotComposer.spec.ts`（工作目录 `apps/workbench`）
Expected: FAIL — 组件不存在。

- [ ] **Step 3: 扩展 `relayClient`**

按既有方法形状加：`listBotProfiles`、`createBotProfile`、`reviseBotProfile`、`archiveBotProfile`；`createAssistSession` 增可选 `conversationMode` / `botProfileId`；`AssistSession` 读取 `conversationMode` / `botProfileId` / `botProfileRevision` / `remember`。字段名用 API 的 snake_case，读时转 camel（沿用既有严格校验风格：缺字段报错，不静默默认）。

- [ ] **Step 4: 实现两个组件**

`ConversationModeSwitch`：真 `<input type="radio">`，共用 `name="conversation-mode"`；两 label 为 `普通 Agent` / `人设 Bot`；`disabled` 时两档都禁并渲染 `disabledReason`。**A 档 label 不得包含「子 Agent」字样**（Review Focus 1 的文案侧对应）。

`BotProfilePicker`：一个 `<select>`（选项文案 `名字 · v修订`）+「+ 新建 bot」项 + 就地小表单 + `remember` checkbox + 固定说明「只读：不改文件、不建任务、不派子 Agent」。表单提交失败时错误就地显示，不清空用户已填内容。

- [ ] **Step 5: 接入 `AssistView`**

工具行 `agent-chat-composer-tools` **最左侧**插入 `ConversationModeSwitch`；`BOT` 时在其后插入 `BotProfilePicker` 并隐藏既有 `sendOptions`；`AGENT` 时保持现状。切换走 `onModeChange`：解析目标会话（`AGENT` → 该目录普通会话；`BOT` → 该 bot × 目录会话，缺则建），有未发草稿时先走既有 `requestTransition` 守卫，在途时禁用。

B 档消息行的角色标签改显 `bot 名 · 人设 v修订`；B 档不渲染 `ExecutionSummary`。

- [ ] **Step 6: 样式**

只复用 `design-tokens.json` 既有 token，不新增数值到第二处。radio 与既有 chip 的行高、间距对齐同一行的「资料 N」。

- [ ] **Step 7: 跑测试确认通过**

```powershell
cd apps/workbench
node .\node_modules\vitest\vitest.mjs run tests/conversationModeSwitch.spec.ts tests/personaBotComposer.spec.ts
node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
```
Expected: 两个新 spec 全 PASS，typecheck exit 0。

- [ ] **Step 8: 全量前端回归**

Run: `node .\node_modules\vitest\vitest.mjs run`
Expected: 全部 PASS。**若出现失败，先判断是否属并行 Agent 在途文件**（`AppShell.tsx`、`DesktopTitleBar.tsx`、`styles.css`、`titlebar*` spec）——是则记录并隔离，不覆盖对方改动，不据此声称全量绿。

- [ ] **Step 9: Commit**

```bash
git add apps/workbench/src apps/workbench/tests
git commit -m "feat(workbench): switch between agent and persona bot conversations"
```

---

### Task 5: 浏览器验收与文档同步

**Files:**
- Create: `apps/workbench/tests/browser/personaBotMode.spec.ts`
- Create: `docs/decisions/ADR-018-persona-bot-conversations.md`
- Modify: `Personal_Workflow_OS_Master_Spec.md`、`docs/requirements/v1-scope.md`、`docs/architecture/runtime-context.md`、`docs/database/physical-design-postgresql.md`、`docs/api/http-command-contract.md`、`docs/frontend/workbench-design.md`、`docs/testing/verification-plan.md`、`CODEX_NEXT_STEP.md`、`docs/testing/overall-acceptance-2026-09-28.md`
- Modify: `docs/frontend/design-system.md`（只在复用既有控件时补链接，不新增第二套 token）

**Interfaces:**
- Consumes: Task 1–4 的全部实现。
- Produces: 文档与验收事实，无代码接口。

- [ ] **Step 1: 写真实 Chromium 用例**

`tests/browser/personaBotMode.spec.ts`，沿用既有浏览器 spec 的启动与断言风格：两档切换、B 档隐藏发送选项、切模式产生导航且不重复建会话、B 档消息行显示 bot 名与人设修订、中文 IME 合成中回车不发送、窄窗（390px）不溢出、radio 组键盘可达。

- [ ] **Step 2: 跑浏览器用例**

Run: `cd apps/workbench; node .\node_modules\playwright\cli.js test personaBotMode`
Expected: 全 PASS。失败先排除环境（需真实 API + PG），环境不具备就**如实标注未运行**，不改成伪造夹具。

- [ ] **Step 3: 写 ADR-018**

背景 / 候选（新增会话身份 vs 复用 Run 身份 vs 建 Task 承载）/ 最终决策（会话级只读轮次 + `ASSIST_BOT` origin）/ 决策原因 / 代价 / 影响范围 / 与 ADR-017 的关系（**新增一种会话身份，不推翻也不前移多 Agent**）/ 后续。Breaking Change 标 Yes（语义）。状态只写「设计已批准，实施中」或按实际进度，不得预写通过结论。

- [ ] **Step 4: 同步其余文档**

- 总纲**新增一节**（不塞进 §0.9），并交叉引用 §0.9
- `v1-scope` 新增同名补充
- `runtime-context` 新增「会话级只读工具轮次的对象身份与恢复」，写清锁序位置与为何不与 Run 竞争
- `physical-design-postgresql` 两张新表 + `assist_sessions` 五列 + `ASSIST_BOT` 四条 CHECK
- `http-command-contract` 四个新端点 + 建会话请求体扩展，标注 Breaking Change 与兼容策略
- `workbench-design` 新增一节（控件层级、切换语义、两档呈现、停止与暂停的差异呈现）
- `verification-plan` 新增**未运行**验收规格（MA-PB 段）
- `CODEX_NEXT_STEP` 写当前阶段、下一步、以及「A 档派发子 Agent 仍缺，ADR-017 未开工」
- 验收表**只更新实际跑过的行**；未跑的 Windows / IME / DPI / 真实 Provider 明确写未运行

- [ ] **Step 5: 文档检查**

Run: `node scripts/check-docs.mjs`
Expected: exit 0。

- [ ] **Step 6: 全量验证并记录**

```powershell
$env:RELAY_FILE_IO_HELPER="apps/desktop/src-tauri/target/debug/relay-file-io-helper.exe"
node --test "apps/api/dist/test/unit/**/*.test.js"
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile persona-bot-session
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile persona-bot-round
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile persona-bot-admission
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile tool-loop
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile folder-first-conversation
pnpm --filter @relay-agent/api run typecheck
cd apps/workbench; node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
node .\node_modules\vitest\vitest.mjs run
```
Expected: 全部通过。把确切命令与退出码写进验收表对应行；失败项如实写失败，不删除检查后自报通过。

- [ ] **Step 7: Commit**

```bash
git add docs contracts Personal_Workflow_OS_Master_Spec.md CODEX_NEXT_STEP.md apps/workbench/tests/browser
git commit -m "docs: record the persona bot decision and acceptance results"
```

## 不在本计划范围

- ADR-017 的有界多 Agent 与自动主子会话（派发子 Agent 仍是零代码）
- 多 bot 群聊、长期角色记忆、跨项目 bot 路由（需另开 ADR）
- 真实 Windows 窗口、原生 IME、DPI、安装升级卸载验收
- 真实 Provider 的 B 档会话质量验证
- B 档的写能力、Task 提案、Skill 调用