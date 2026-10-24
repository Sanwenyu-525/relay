import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import {
  readUserFileState, runUserFileReadCommand,
} from '../../src/application/file-user-action.js';
import { createGatewayConnectionCommand, createGatewayPolicyCommand,
  createManagedResourceCommand } from '../../src/application/gateway-commands.js';
import { resolveReview } from '../../src/application/review-decisions.js';
import { withTransaction, createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import {
  createDataRoot, startTestApi, workspacePath, type TestApi,
} from './api-harness.js';
import {
  APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase,
} from './integration-support.js';

/**
 * 人工触发的受管目录浏览与文件读取（迁移 0134，工具面板「文件」页签后端）。
 *
 * 真实 PostgreSQL + 真实临时目录。覆盖此前**没有公开入口**的两类动作：人工在受管资源上
 * 直接触发 LIST_DIRECTORY / READ_FILE，不经 Run、不建 Task。
 *
 * 与 git-user-action 套件互补的分界：本文件锁定**动作身份含 command_id** 的刷新语义——
 * 同一命令崩溃重投收敛到同一次读取，新命令产生新的读取事实；以及适配器口径的落点
 * （有界枚举、二进制/超大文件类型化失败）。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-0134-user-file-read');
let dataRoot: string;
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
  api = await startTestApi();
});
after(async () => {
  if (api !== undefined) await api.stop();
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code) : undefined;
}

interface UserFileFixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly root: string;
  readonly resourceId: string;
  readonly connectionId: string;
}

/**
 * 一个真实的 Project + 受管资源 + FILE_QUERY/FILE_READ 连接 + 两条 AUTO 策略。
 *
 * 夹具刻意**不建 Task、不建 Run**：人工动作没有执行链。策略按动作分别建立（LIST_DIRECTORY
 * × FILE_QUERY、READ_FILE × FILE_READ），只放行其中一条时另一条必须按权限拒绝。
 */
async function userFileFixture(input: {
  decision?: 'AUTO' | 'ASK' | 'DENY';
  capabilities?: readonly ('FILE_READ' | 'FILE_QUERY')[];
  policies?: readonly ('LIST_DIRECTORY' | 'READ_FILE')[];
} = {}): Promise<UserFileFixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `m0134-user-file-${workspaceId}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId,
      title: '0134 User File Read', projectType: 'DEVELOPMENT' });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
  });

  const root = join(dataRoot, `user-file-${randomUUID()}`);
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'alpha.txt'), 'alpha\n', 'utf8');
  await writeFile(join(root, 'beta.md'), '# beta\n', 'utf8');
  await writeFile(join(root, 'sub', 'nested.txt'), 'nested\n', 'utf8');

  const capabilities: readonly ('FILE_READ' | 'FILE_QUERY')[] =
    input.capabilities ?? ['FILE_QUERY', 'FILE_READ'];
  const created = await createGatewayConnectionCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), capabilities: [...capabilities], rootPath: root });
  const connectionId = created.result.connection_id!;
  const resource = await createManagedResourceCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), rootPath: root });
  const resourceId = resource.result.resource_id!;
  const policies = input.policies ?? ['LIST_DIRECTORY', 'READ_FILE'];
  for (const actionType of policies) {
    const policy = await createGatewayPolicyCommand(app.db, { workspaceId, projectId,
      commandId: randomUUID(),
      capability: actionType === 'LIST_DIRECTORY' ? 'FILE_QUERY' : 'FILE_READ', actionType,
      resourceId, decision: input.decision ?? 'AUTO', maxPayloadBytes: 65536 });
    assert.ok(policy.result.policy_id);
  }
  return { workspaceId, projectId, root, resourceId, connectionId };
}

function fileReadPath(fixture: UserFileFixture): string {
  return workspacePath(fixture.workspaceId,
    `/projects/${fixture.projectId}/managed-resources/${fixture.resourceId}/file-read`);
}

function fileReadBody(fixture: UserFileFixture, input: {
  actionType?: 'LIST_DIRECTORY' | 'READ_FILE'; connectionId?: string; commandId?: string;
  path?: string; limit?: number;
} = {}) {
  return {
    command_id: input.commandId ?? randomUUID(),
    connection_id: input.connectionId ?? fixture.connectionId,
    action_type: input.actionType ?? 'LIST_DIRECTORY',
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
}

async function activityRows(operationId: string) {
  const result = await sql<{ id: string; actor_kind: string; actor_ref: string;
    command_id: string | null; event_type: string; fact_refs: Record<string, unknown> }>`
    select id, actor_kind, actor_ref, command_id, event_type, fact_refs
    from activity_records where fact_refs->>'operation_id' = ${operationId}
    order by created_at, id`.execute(app.db);
  return result.rows;
}

async function invokeRows(operationId: string) {
  return withTransaction(app.db, (repositories) =>
    repositories.gateway.listInvocations(operationId));
}

async function operationCount(): Promise<string> {
  const result = await sql<{ count: string }>`
    select count(*)::text as count from logical_operations where origin = 'USER_ACTION'`.execute(app.db);
  return result.rows[0]!.count;
}

// ---------------------------------------------------------------------------
// 正向出口
// ---------------------------------------------------------------------------

test('人工 LIST_DIRECTORY 在受管根内读到一层真实条目，并留下人工审计', async () => {
  const f = await userFileFixture();
  const commandId = randomUUID();
  const outcome = await runUserFileReadCommand(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
    actionType: 'LIST_DIRECTORY', actorRef: 'user:local', commandId });

  assert.equal(outcome.result.state, 'SUCCEEDED', JSON.stringify(outcome.result));
  assert.equal(outcome.replayed, false);
  const listing = outcome.result as unknown as { operation_id: string;
    result: { entries: { path: string; kind: string }[]; count: number;
      limit: number; truncated: boolean; skipped: number } };
  const names = listing.result.entries.map((entry) => `${entry.kind}:${entry.path}`);
  // 适配器按名称排序（alpha.txt < beta.md < sub），期望按同一顺序断言。
  assert.deepEqual(names, ['file:alpha.txt', 'file:beta.md', 'directory:sub']);
  assert.equal(listing.result.count, 3);
  assert.equal(listing.result.limit, 200);
  assert.equal(listing.result.truncated, false);

  // 账本必须能回答「谁在什么时候读了哪个受管目录」：Operation + Invocation + 人工活动记录。
  const operation = await createRepositories(app.db).gateway.readOperation(listing.operation_id);
  assert.equal(operation?.origin, 'USER_ACTION');
  assert.equal(operation?.capability_key, 'FILE_QUERY');
  assert.equal(operation?.action_type, 'LIST_DIRECTORY');
  assert.equal(operation?.task_id, null);
  assert.equal(operation?.run_id, null);
  assert.equal(operation?.resource_id, f.resourceId);
  const invocations = await invokeRows(listing.operation_id);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0]!.status, 'SUCCEEDED');
  // 只读动作不建资源 claim（resource_claims 强制绑定 task/run），不与写动作争用目录。
  assert.equal(invocations[0]!.resource_claim_id, null);
  assert.equal(invocations[0]!.worker_id, null);

  const activities = await activityRows(listing.operation_id);
  assert.equal(activities.length, 1, JSON.stringify(activities));
  assert.equal(activities[0]!.actor_kind, 'HUMAN');
  assert.equal(activities[0]!.actor_ref, 'user:local');
  assert.equal(activities[0]!.command_id, commandId);
  assert.equal(activities[0]!.event_type, 'MANAGED_FILE_READ_REQUESTED');
  assert.equal(activities[0]!.fact_refs.resource_id, f.resourceId);
});

test('LIST_DIRECTORY 支持相对子目录，limit 在适配器内生效且截断显式', async () => {
  const f = await userFileFixture();
  await writeFile(join(f.root, 'gamma.txt'), 'gamma\n', 'utf8');

  const rootListing = await runUserFileReadCommand(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
    actionType: 'LIST_DIRECTORY', relativePath: 'sub', actorRef: 'user:local',
    commandId: randomUUID() });
  assert.equal(rootListing.result.state, 'SUCCEEDED', JSON.stringify(rootListing.result));
  const sub = (rootListing.result as unknown as { result: { entries: { path: string }[] } }).result;
  assert.deepEqual(sub.entries.map((entry) => entry.path), ['nested.txt']);

  // limit=2 时第 3 个条目被截断丢弃，truncated 必须如实为 true——截断的列表不能当完整证据。
  const bounded = await runUserFileReadCommand(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
    actionType: 'LIST_DIRECTORY', limit: 2, actorRef: 'user:local', commandId: randomUUID() });
  assert.equal(bounded.result.state, 'SUCCEEDED');
  const limited = (bounded.result as unknown as { result: { entries: unknown[]; limit: number;
    truncated: boolean } }).result;
  assert.equal(limited.entries.length, 2);
  assert.equal(limited.limit, 2);
  assert.equal(limited.truncated, true);
});

test('人工 READ_FILE 在受管根内读到真实正文与 SHA-256', async () => {
  const f = await userFileFixture();
  const outcome = await runUserFileReadCommand(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
    actionType: 'READ_FILE', relativePath: 'sub/nested.txt', actorRef: 'user:local',
    commandId: randomUUID() });
  assert.equal(outcome.result.state, 'SUCCEEDED', JSON.stringify(outcome.result));
  const read = (outcome.result as unknown as { operation_id: string;
    result: { content: string; size: number; sha256: string; truncated: boolean } }).result;
  assert.equal(read.content, 'nested\n');
  assert.equal(read.size, 7);
  assert.equal(read.sha256, createHash('sha256').update('nested\n').digest('hex'));
  assert.equal(read.truncated, false);
  const operation = await createRepositories(app.db).gateway.readOperation(
    (outcome.result as { operation_id: string }).operation_id);
  assert.equal(operation?.capability_key, 'FILE_READ');
  assert.equal(operation?.action_type, 'READ_FILE');
});

// ---------------------------------------------------------------------------
// 参数与边界反例
// ---------------------------------------------------------------------------

test('READ_FILE 缺路径、带 limit、绝对路径与 .. 段在 IO 前即被拒，且不留 Operation', async () => {
  const f = await userFileFixture();
  const before = await operationCount();
  const cases = [
    { actionType: 'READ_FILE' as const },
    { actionType: 'READ_FILE' as const, relativePath: 'alpha.txt', limit: 10 },
    { actionType: 'LIST_DIRECTORY' as const, relativePath: 'C:/Windows/System32' },
    { actionType: 'READ_FILE' as const, relativePath: '../outside.txt' },
  ];
  for (const input of cases) {
    await assert.rejects(async () => readUserFileState(app.db, { workspaceId: f.workspaceId,
      projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
      actorRef: 'user:local', ...input }),
    (error: unknown) => code(error) === 'VALIDATION_FAILED', JSON.stringify(input));
  }
  assert.equal(await operationCount(), before, '参数反例不得留下 Operation');
});

test('读取不存在的路径按类型化拒绝，不产生 Operation', async () => {
  const f = await userFileFixture();
  const before = await operationCount();
  for (const [actionType, relativePath] of [
    ['READ_FILE', 'missing.txt'], ['LIST_DIRECTORY', 'missing-dir'],
  ] as const) {
    await assert.rejects(async () => readUserFileState(app.db, { workspaceId: f.workspaceId,
      projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
      actionType, relativePath, actorRef: 'user:local' }),
    (error: unknown) => code(error) === 'GATEWAY_TARGET_DENIED', `${actionType} 缺失路径应被拒`);
  }
  assert.equal(await operationCount(), before);
});

test('人工入口不开放查找/搜索与写动作：FIND_PATHS / SEARCH_TEXT / 写动作一律被拒', async () => {
  const f = await userFileFixture();
  const before = await operationCount();
  for (const actionType of ['FIND_PATHS', 'SEARCH_TEXT', 'GIT_STAGE', 'WRITE_FILE', 'CLI_RUN']) {
    await assert.rejects(async () => readUserFileState(app.db, { workspaceId: f.workspaceId,
      projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
      actionType: actionType as 'LIST_DIRECTORY', actorRef: 'user:local' }),
    (error: unknown) => code(error) === 'GATEWAY_ORIGIN_DENIED', `${actionType} 应被拒`);
  }
  assert.equal(await operationCount(), before);
});

test('二进制与超大文件按类型化失败结算，不把失败折叠成空内容', async () => {
  const f = await userFileFixture();
  await writeFile(join(f.root, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  await writeFile(join(f.root, 'huge.txt'), 'x'.repeat(128 * 1024 + 1));

  for (const [file, reason] of [['binary.bin', 'FILE_BINARY_UNSUPPORTED'],
    ['huge.txt', 'FILE_TOO_LARGE']] as const) {
    const outcome = await runUserFileReadCommand(app.db, { workspaceId: f.workspaceId,
      projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
      actionType: 'READ_FILE', relativePath: file, actorRef: 'user:local',
      commandId: randomUUID() });
    assert.equal(outcome.result.state, 'FAILED', `${file}: ${JSON.stringify(outcome.result)}`);
    const result = (outcome.result as { result: Record<string, unknown> }).result;
    assert.equal(result.reason, reason);
    // 关键反例：失败不得携带 content 冒充读到了内容。
    assert.equal('content' in result, false, JSON.stringify(result));
    const invocations = await invokeRows((outcome.result as { operation_id: string }).operation_id);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0]!.status, 'FAILED');
  }
});

// ---------------------------------------------------------------------------
// 权限与准入
// ---------------------------------------------------------------------------

test('策略 ASK 先停在等待确认；确认后同一命令才真正读取且只读一次', async () => {
  const f = await userFileFixture({ decision: 'ASK' });
  const commandId = randomUUID();
  const first = await runUserFileReadCommand(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
    actionType: 'LIST_DIRECTORY', actorRef: 'user:local', commandId });
  assert.equal(first.result.state, 'WAITING_APPROVAL', JSON.stringify(first.result));
  const pending = first.result as { operation_id: string; review_id: string; reason: string };
  assert.equal(pending.reason, 'ACTION_APPROVAL_REQUIRED');
  // 等待确认时不得携带任何结果字段冒充已读到内容。
  assert.equal('result' in (pending as unknown as Record<string, unknown>), false);
  assert.equal((await invokeRows(pending.operation_id)).length, 0,
    'ASK 在确认前不得创建 Invocation');

  // 同一 command_id 在确认前重复投递仍停在等待，不会绕过确认读取。
  const replayed = await runUserFileReadCommand(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
    actionType: 'LIST_DIRECTORY', actorRef: 'user:local', commandId });
  assert.equal(replayed.result.state, 'WAITING_APPROVAL');

  const review = await withTransaction(app.db, (repositories) =>
    repositories.reviews.readRequest(pending.review_id));
  assert.ok(review);
  assert.equal(review.kind, 'ACTION_APPROVAL');
  assert.equal(review.operation_id, pending.operation_id);
  const decided = await resolveReview(app.db, { workspaceId: f.workspaceId,
    reviewId: pending.review_id, commandId: randomUUID(),
    expectedRevision: review.revision.toString(),
    targetHash: review.target_hash.toString('hex'), decision: 'APPROVE' });
  assert.equal(decided.result.effect.external_effect_executed, false);

  const approved = await runUserFileReadCommand(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
    actionType: 'LIST_DIRECTORY', actorRef: 'user:local', commandId });
  assert.equal(approved.result.state, 'SUCCEEDED', JSON.stringify(approved.result));
  assert.equal((await invokeRows(pending.operation_id)).length, 1);
});

test('策略 DENY 或缺策略时拒绝执行，不产生 Operation', async () => {
  const denied = await userFileFixture({ decision: 'DENY' });
  await assert.rejects(async () => readUserFileState(app.db, { workspaceId: denied.workspaceId,
    projectId: denied.projectId, resourceId: denied.resourceId, connectionId: denied.connectionId,
    actionType: 'LIST_DIRECTORY', actorRef: 'user:local' }),
  (error: unknown) => code(error) === 'GATEWAY_PERMISSION_DENIED');

  // 有连接、缺策略：FILE_READ 未授权不得被 LIST_DIRECTORY 的授权顶替。
  const halfAuthorized = await userFileFixture({ policies: ['LIST_DIRECTORY'] });
  await assert.rejects(async () => readUserFileState(app.db, {
    workspaceId: halfAuthorized.workspaceId, projectId: halfAuthorized.projectId,
    resourceId: halfAuthorized.resourceId, connectionId: halfAuthorized.connectionId,
    actionType: 'READ_FILE', relativePath: 'alpha.txt', actorRef: 'user:local' }),
  (error: unknown) => code(error) === 'GATEWAY_PERMISSION_DENIED');
});

test('连接缺对应能力或不存在时按类型化拒绝', async () => {
  const f = await userFileFixture({ capabilities: ['FILE_QUERY'] });
  await assert.rejects(async () => readUserFileState(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
    actionType: 'READ_FILE', relativePath: 'alpha.txt', actorRef: 'user:local' }),
  (error: unknown) => code(error) === 'GATEWAY_CONNECTION_DENIED');

  await assert.rejects(async () => readUserFileState(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, resourceId: f.resourceId, connectionId: randomUUID(),
    actionType: 'LIST_DIRECTORY', actorRef: 'user:local' }),
  (error: unknown) => code(error) === 'GATEWAY_CONNECTION_DENIED');
});

// ---------------------------------------------------------------------------
// 幂等与刷新语义（与 git 人工读取的分界）
// ---------------------------------------------------------------------------

test('同一 command_id 重复投递只读一次；换内容重放被确定性拒绝', async () => {
  const f = await userFileFixture();
  const commandId = randomUUID();
  const request = { workspaceId: f.workspaceId, projectId: f.projectId,
    resourceId: f.resourceId, connectionId: f.connectionId,
    actionType: 'LIST_DIRECTORY' as const, actorRef: 'user:local', commandId };

  const first = await runUserFileReadCommand(app.db, request);
  assert.equal(first.replayed, false);
  assert.equal(first.result.state, 'SUCCEEDED');
  const second = await runUserFileReadCommand(app.db, request);
  assert.equal(second.replayed, true);
  assert.equal((second.result as { operation_id: string }).operation_id,
    (first.result as { operation_id: string }).operation_id);
  assert.equal((await invokeRows((first.result as { operation_id: string }).operation_id)).length, 1);

  // 同一 command_id 换内容重放被拒绝，而不是悄悄读另一个路径。
  await assert.rejects(async () => runUserFileReadCommand(app.db, { ...request,
    relativePath: 'sub' }),
  (error: unknown) => error instanceof Error && error.name === 'CommandIdReusedError');
});

test('新 command_id 产生新的读取事实：目录变化后能看到（与 git 冻结语义的分界）', async () => {
  const f = await userFileFixture();
  const base = { workspaceId: f.workspaceId, projectId: f.projectId,
    resourceId: f.resourceId, connectionId: f.connectionId,
    actionType: 'LIST_DIRECTORY' as const, actorRef: 'user:local' };
  const first = await runUserFileReadCommand(app.db, { ...base, commandId: randomUUID() });
  assert.equal(first.result.state, 'SUCCEEDED');
  assert.equal(((first.result as unknown as { result: { count: number } }).result).count, 3);

  await writeFile(join(f.root, 'later.txt'), 'later\n', 'utf8');
  const second = await runUserFileReadCommand(app.db, { ...base, commandId: randomUUID() });
  assert.equal(second.result.state, 'SUCCEEDED');
  assert.equal(((second.result as unknown as { result: { count: number } }).result).count, 4);
  // 两次是不同的 Operation：每次点击都是一条新的读取事实。
  assert.notEqual((second.result as { operation_id: string }).operation_id,
    (first.result as { operation_id: string }).operation_id);
});

test('同一命令崩溃后重投返回同一次读取的落库结果，不第二次执行适配器', async () => {
  const f = await userFileFixture();
  const request = { workspaceId: f.workspaceId, projectId: f.projectId,
    resourceId: f.resourceId, connectionId: f.connectionId,
    actionType: 'READ_FILE' as const, relativePath: 'alpha.txt', actorRef: 'user:local',
    commandId: randomUUID() };
  const first = await readUserFileState(app.db, request);
  assert.equal(first.state, 'SUCCEEDED');

  // 回执尚未写下（模拟「读取已结算、回执补写前崩溃」）时的再次投递。
  const second = await readUserFileState(app.db, request);
  assert.equal(second.state, 'SUCCEEDED');
  assert.equal((second as { operation_id: string }).operation_id,
    (first as { operation_id: string }).operation_id);
  assert.equal((await invokeRows((first as { operation_id: string }).operation_id)).length, 1);
});

// ---------------------------------------------------------------------------
// HTTP 端点
// ---------------------------------------------------------------------------

test('HTTP 端点在 AUTO 下返回 200 与有界结果，重放附 Command-Replayed 头', async () => {
  const f = await userFileFixture();
  const body = fileReadBody(f, { commandId: randomUUID() });
  const response = await api.post(fileReadPath(f), body);
  assert.equal(response.status, 200, response.text);
  const envelope = response.body as { result: { state: string;
    result: { entries: { path: string }[] } } };
  assert.equal(envelope.result.state, 'SUCCEEDED');
  assert.deepEqual(envelope.result.result.entries.map((entry) => entry.path),
    ['alpha.txt', 'beta.md', 'sub']);

  const replay = await api.post(fileReadPath(f), body);
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.headers['command-replayed'], 'true');
  assert.deepEqual((replay.body as { result: unknown }).result, envelope.result);
});

test('HTTP 层参数校验与错误映射为可分辨的 Problem Details', async () => {
  const f = await userFileFixture();
  // READ_FILE 缺 path：422，字段可分辨。
  const missingPath = await api.post(fileReadPath(f),
    fileReadBody(f, { commandId: randomUUID(), actionType: 'READ_FILE' }));
  assert.equal(missingPath.status, 422, missingPath.text);
  assert.equal((missingPath.body as { code: string }).code, 'VALIDATION_FAILED');

  // 缺连接：409 走 Problem Details，不泄漏 SQL 或堆栈。
  const denied = await api.post(fileReadPath(f),
    fileReadBody(f, { commandId: randomUUID(), connectionId: randomUUID() }));
  assert.equal(denied.status, 409, denied.text);
  assert.equal((denied.body as { code: string }).code, 'GATEWAY_CONNECTION_DENIED');
  assert.equal(denied.text.includes('SELECT'), false);
});

// ---------------------------------------------------------------------------
// 迁移 0134 本身的数据库级守卫
// ---------------------------------------------------------------------------

test('0134 只放宽 capability × origin 矩阵：FILE_READ/FILE_QUERY × USER_ACTION 可入，写能力仍被拒', async () => {
  const f = await userFileFixture();
  const connection = await createRepositories(app.db).gateway.readConnection(f.connectionId);
  const policyRows = await sql<{ policy_id: string; version: string; capability_key: string }>`
    select v.policy_id, v.version::text as version, v.capability_key
    from gateway_permission_versions v
    join gateway_permission_policies p on p.id = v.policy_id
    where p.workspace_id = ${f.workspaceId} and p.project_id = ${f.projectId}
      and v.action_type = 'LIST_DIRECTORY' limit 1`.execute(app.db);
  assert.ok(policyRows.rows[0]);

  const base = {
    workspaceId: f.workspaceId, projectId: f.projectId,
    connectionId: f.connectionId, connectionVersion: connection?.version ?? 1n,
    policyId: policyRows.rows[0]!.policy_id, policyVersion: policyRows.rows[0]!.version,
    actionType: 'LIST_DIRECTORY', target: f.root, resourceId: f.resourceId,
  };
  // 每次插入用全新 id 与 intent_key（应用角色对 logical_operations 没有 DELETE，与
  // git 套件同口径：只插不清，留下 PREPARED 行证明「可入」这一事实本身）。
  const insertOperation = async (capability: string): Promise<unknown> => {
    const id = randomUUID();
    return sql`
    insert into logical_operations (id, workspace_id, project_id, origin, task_id, run_id,
      step_id, import_job_id, intent_key, connection_id, connection_version, connection_config,
      policy_id, policy_version, capability_key, action_type, normalized_target,
      params_hash, params, resource_id, status)
    values (${id}, ${base.workspaceId}, ${base.projectId}, 'USER_ACTION', null, null,
      null, null, ${`intent-${id}`}, ${base.connectionId}, ${base.connectionVersion},
      '{}'::jsonb, ${base.policyId}, ${base.policyVersion}, ${capability}, ${base.actionType},
      ${base.target}, ${Buffer.alloc(32)}, '{}'::jsonb, ${base.resourceId}, 'PREPARED')
    returning id`.execute(app.db);
  };

  // 迁移放宽后的两条只读能力可以落行（resource_id 必须绑定）。
  for (const capability of ['FILE_QUERY', 'FILE_READ']) {
    await assert.doesNotReject(async () => insertOperation(capability), `${capability} 应可入`);
  }
  // 写能力与脱离受管资源的形态仍被矩阵 CHECK 拒绝。
  for (const capability of ['GIT_WRITE', 'CLI_RUN', 'FILE_WRITE']) {
    await assert.rejects(async () => insertOperation(capability),
      (error: unknown) => typeof error === 'object' && error !== null &&
        (error as { code?: unknown }).code === '23514', `${capability} 应被拒`);
  }
});

test('0134 迁移正文只放宽 CHECK，不回填、不改表结构', async () => {
  const { readFile } = await import('node:fs/promises');
  const sqlText = await readFile(join(MIGRATIONS_DIRECTORY, '0134_user_action_file_read.sql'), 'utf8');
  assert.doesNotMatch(sqlText, /^\s*(insert|update|delete)\b/imu,
    '0134 不得回填或改写任何历史行');
  assert.doesNotMatch(sqlText, /\badd column\b/iu, '0134 不改表结构');
  assert.doesNotMatch(sqlText, /\bcreate table\b/iu, '0134 不新增表');
});
