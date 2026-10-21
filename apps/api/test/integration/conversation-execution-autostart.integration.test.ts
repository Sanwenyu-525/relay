import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import test, { after, before } from 'node:test';

import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from
  './integration-support.js';
import { createDataRoot } from './api-harness.js';
import { applyConversationExecution } from '../../src/application/conversation-execution.js';
import { runConversationExecutionAutoStartTick } from
  '../../src/application/conversation-execution-autostart.js';
import { bindAssistSessionDirectory, createAssistSession, requestAssistMessage } from
  '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createGatewayPolicy, registerManagedResource } from
  '../../src/application/gateway-configuration.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort } from '../../src/workflow/fake-model-port.js';
import type { GatewayCapability } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';

/**
 * 会话执行请求的**服务端**推进 Owner（2026-10-20 第二轮）。
 *
 * 上一轮的链路是：主流程产出候选 → 前端 effect 读到 `auto_start` → 前端调
 * `POST …/applications`。用户提出的问题是直接的：**关掉页面之后，这条已经明确授权、
 * 已经落库的请求还会不会继续？** 这里的用例就是回答它。
 *
 * 四条不变量：
 *   * 只靠一个 Worker tick（**没有任何前端请求**）就能把 READY 候选推进到 Task/Run；
 *   * 重复、迟到扫描只重放原回执，不产生第二个 Task/Run；
 *   * 推进失败时必须把**具体原因**写回原请求行，并从自动扫描里退出（不刷成噪声）；
 *   * 失败行在补齐前置条件后仍可沿原身份人工接续——候选没有被丢掉。
 *
 * 范围：只验「谁推进、推进几次、失败怎么记」。Run 内部效果（真实写盘、审批、UNKNOWN）
 * 归 agent-main-loop-execution 与 gateway 套件，本文件不重复。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-conversation-autostart');
let dataRoot: string;
const roots: string[] = [];

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => {
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

interface Fixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly root: string;
  readonly canonicalRoot: string;
  readonly resourceId: string;
}

async function fixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-autostart-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export const relay = true;\n', 'utf8');

  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'autostart' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'autostart',
      projectType: 'DEVELOPMENT' });
  });
  const { resourceId, canonicalRoot } = await registerManagedResource(app.db,
    { workspaceId, projectId, rootPath: root });
  const capabilities: readonly GatewayCapability[] = ['FILE_QUERY', 'FILE_READ'];
  const readConnectionId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: readConnectionId,
      workspaceId, projectId, config: { root_path: canonicalRoot } });
    for (const capability of capabilities) {
      await repositories.gateway.addConnectionCapability(connection.id, capability);
    }
    await repositories.workspaces.bumpAuthority(workspaceId);
  });
  for (const [capability, actionType] of [['FILE_QUERY', 'LIST_DIRECTORY'],
    ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'], ['FILE_READ', 'READ_FILE']] as const) {
    await createGatewayPolicy(app.db, { workspaceId, projectId, capability, actionType,
      targetPrefix: canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
  }
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: '普通会话', projectId, conversationMode: 'AGENT' });
  await bindAssistSessionDirectory(app.db, { workspaceId, sessionId: session.result.session_id,
    commandId: randomUUID(), resourceId });
  return { workspaceId, projectId, sessionId: session.result.session_id, root, canonicalRoot,
    resourceId };
}

/** 写连接 + AUTO 档位：这样候选会走会话直写，不产生 Task/Run（用来对照本轮的 tick）。 */
async function addFileWriteConnection(fx: Fixture): Promise<string> {
  const connectionId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(fx.workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: connectionId,
      workspaceId: fx.workspaceId, projectId: fx.projectId,
      config: { root_path: fx.canonicalRoot } });
    await repositories.gateway.addConnectionCapability(connection.id, 'FILE_WRITE');
    await repositories.workspaces.bumpAuthority(fx.workspaceId);
  });
  await createGatewayPolicy(app.db, { workspaceId: fx.workspaceId, projectId: fx.projectId,
    capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET',
    targetPrefix: fx.canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
  const read = await sql<{ id: string }>`select id from gateway_connections
    where project_id = ${fx.projectId} and status = 'ACTIVE' and id <> ${connectionId}
    order by created_at limit 1`.execute(app.db);
  const readConnectionId = read.rows[0]?.id;
  assert.ok(readConnectionId !== undefined, '夹具必须已有读连接');
  await sql`insert into local_directory_access
    (resource_id, write_tier, read_connection_id, write_connection_id)
    values (${fx.resourceId}, 'AUTO', ${readConnectionId}, ${connectionId})
    on conflict (resource_id) do update set write_tier = 'AUTO',
      read_connection_id = ${readConnectionId},
      write_connection_id = ${connectionId}`.execute(app.db);
  return connectionId;
}

/**
 * 目标准备好、但写连接缺失：`writes_files=true` 的候选在 `applyConversationExecution()`
 * 里会因缺少 FILE_WRITE 连接失败——这正是「自动推进失败」的真实成因之一。
 */
function candidatePort(): AssistModelPort {
  const base = new FakeModelPort();
  const candidate: JsonObject = { title: '修改受管文件', objective: '把 src/index.ts 改为 false',
    criteria: [{ statement: 'src/index.ts 导出 false', required: true, method: 'HUMAN' }],
    expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
    file_changes: [{ path: 'src/index.ts', action: 'MODIFY' }], writes_files: true };
  return { identity: base.identity,
    assist: async () => ({ kind: 'CONTENT' as const,
      content: JSON.stringify({ reply: '按这个目标处理。', execution: candidate }),
      providerRequestId: 'autostart-candidate',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null } }) };
}

async function readyRequest(fx: Fixture): Promise<string> {
  const storage = new ManagedContentStore(dataRoot);
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '把 src/index.ts 改为 false' });
  const outcome = await runAssistGenerationTick(app.db, { workerId: `autostart-${randomUUID()}`,
    storage, modelPort: candidatePort(), leaseMs: 60_000, maxMessages: 1 });
  assert.ok(outcome !== undefined, '本次生成 tick 应当领取这条消息');
  const requests = await createRepositories(app.db).conversationExecutions
    .listSessionRequests(fx.workspaceId, fx.sessionId);
  const row = requests.find((item) => item.source_message_id === sent.result.user_message_id);
  assert.ok(row !== undefined, '主流程必须落一行原执行请求');
  assert.equal(row.candidate_status, 'READY');
  assert.equal(row.status, 'READY');
  assert.equal(row.run_id, null);
  return row.id;
}

async function taskAndRunCounts(projectId: string): Promise<{ tasks: number; runs: number }> {
  const tasks = await sql<{ count: string }>`select count(*)::text as count from tasks
    where project_id = ${projectId}`.execute(app.db);
  // runs 没有 project_id（它归 task + workspace）：按 task 归属数，避免把别的项目算进来。
  const runs = await sql<{ count: string }>`select count(*)::text as count from runs
    join tasks on tasks.id = runs.task_id
    where tasks.project_id = ${projectId}`.execute(app.db);
  return { tasks: Number(tasks.rows[0]?.count ?? '0'), runs: Number(runs.rows[0]?.count ?? '0') };
}

// ---------------------------------------------------------------- 推进

test('只靠 Worker tick 就把已授权的候选推进到执行，不需要任何前端请求', async () => {
  const fx = await fixture();
  // 读连接齐全、写连接缺失：候选的写意图会让 apply 失败，因此这里先补写连接，
  // 让这条用例只回答「谁推进」。
  await addFileWriteConnection(fx);
  const requestId = await readyRequest(fx);
  const before = await taskAndRunCounts(fx.projectId);
  assert.deepEqual(before, { tasks: 0, runs: 0 }, '主流程自身不建 Task/Run');

  const tick = await runConversationExecutionAutoStartTick(app.db);
  assert.equal(tick.failed.length, 0, `不得有失败：${JSON.stringify(tick.failed)}`);
  assert.equal(tick.applied.length, 1);
  assert.equal(tick.applied[0]?.requestId, requestId);
  assert.notEqual(tick.applied[0]?.runId ?? null, null);

  const row = await createRepositories(app.db).conversationExecutions.readRequest(requestId);
  assert.equal(row?.status, 'DELEGATED');
  assert.equal(row?.run_id, tick.applied[0]?.runId);
  assert.notEqual(row?.task_id, null);
  const after = await taskAndRunCounts(fx.projectId);
  assert.deepEqual(after, { tasks: 1, runs: 1 });
});

test('重复与迟到的扫描只重放原回执，不产生第二个 Task 或 Run', async () => {
  const fx = await fixture();
  await addFileWriteConnection(fx);
  const requestId = await readyRequest(fx);
  const first = await runConversationExecutionAutoStartTick(app.db);
  assert.equal(first.applied.length, 1);
  const runId = first.applied[0]?.runId;
  // 第二轮扫描：该行已 DELEGATED，不在候选名单里，tick 什么都不做。
  const second = await runConversationExecutionAutoStartTick(app.db);
  assert.deepEqual(second, { applied: [], failed: [] });
  // 就算有人拿着同一个 request_id 手动再提交一次，也只重放原回执。
  const replay = await applyConversationExecution(app.db,
    { workspaceId: fx.workspaceId, requestId });
  assert.equal(replay.run_id, runId);
  assert.deepEqual(await taskAndRunCounts(fx.projectId), { tasks: 1, runs: 1 });
});

// ---------------------------------------------------------------- 失败与恢复

test('推进失败把具体原因写回原请求并从自动扫描退出，不留半成品 Task', async () => {
  const fx = await fixture();
  const requestId = await readyRequest(fx);

  const tick = await runConversationExecutionAutoStartTick(app.db);
  assert.equal(tick.applied.length, 0);
  assert.equal(tick.failed.length, 1);
  assert.equal(tick.failed[0]?.requestId, requestId);

  const row = await createRepositories(app.db).conversationExecutions.readRequest(requestId);
  assert.equal(row?.status, 'FAILED');
  assert.equal(row?.run_id, null);
  assert.equal(row?.candidate_status, 'READY', '候选本身没有失效，失效的是这次推进的前置条件');
  const questions = (row?.clarification as { questions?: unknown } | null)?.questions;
  const reason = Array.isArray(questions) ? String(questions[0] ?? '') : '';
  // 原因必须是**可执行的**：指出缺哪个能力，而不是「请补充任务目标」这类无关要求。
  assert.match(reason, /FILE_WRITE/u);
  assert.doesNotMatch(reason, /验收标准|任务目标/u);
  assert.deepEqual(await taskAndRunCounts(fx.projectId), { tasks: 0, runs: 0 },
    '失败不得留下无法委托的 Task');

  // 同一个已知失败不会被自动重试成噪声：第二轮什么也不做。
  const again = await runConversationExecutionAutoStartTick(app.db);
  assert.deepEqual(again, { applied: [], failed: [] });
});

test('补齐前置条件后，失败行仍可沿原请求身份人工接续', async () => {
  const fx = await fixture();
  const requestId = await readyRequest(fx);
  await runConversationExecutionAutoStartTick(app.db);
  const failed = await createRepositories(app.db).conversationExecutions.readRequest(requestId);
  assert.equal(failed?.status, 'FAILED');

  // 用户在同页补齐 FILE_WRITE 连接与档位，然后点一次「继续原请求」。
  await addFileWriteConnection(fx);
  const applied = await applyConversationExecution(app.db,
    { workspaceId: fx.workspaceId, requestId });
  assert.equal(applied.status, 'DELEGATED');
  assert.notEqual(applied.run_id, null);
  assert.deepEqual(await taskAndRunCounts(fx.projectId), { tasks: 1, runs: 1 },
    '接续仍走原请求行固定的阶段命令身份，不产生第二套对象');
});
