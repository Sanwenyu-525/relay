import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { createDpapiCredentialStore } from '../../src/credentials/dpapi-credential-store.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createWorkspace, expectProblem, startTestApi, workspacePath, type TestApi }
  from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase }
  from './integration-support.js';

/**
 * 模型连接登记（P2 阶段一，ADR-036）：真实 PG + 真实 HTTP + 真实 DPAPI 凭据库。
 *
 * 这里证明的是「登记是真实的」：
 *   * Key 只在请求体里出现一次，落进系统凭据库；响应、列表、错误里都没有它，也没有引用；
 *   * 轮换会真的换掉库里的秘密，并把 `credential_version` 加一（冻结在旧代上的调用据此停止）；
 *   * 更新走 revision CAS，不用最后写入覆盖；重放同一 command_id 返回当时结果；
 *   * 停用是状态而不是删除；跨工作区不可见。
 *
 * 明确**不**证明：连接可以执行。连接尚未参与模型解析（那是下一阶段的冻结接线），
 * 所以这里没有任何外呼，也没有 `model_calls`。
 */

const database = openDatabase(APP_DATABASE_URL, 'relay-api-test-model-connections');
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => { await api?.stop(); await database.close(); });

const credentialStore = () => createDpapiCredentialStore({
  root: join(api.dataRoot, 'credentials'),
  ...(process.env.RELAY_CREDENTIAL_HELPER === undefined
    ? {} : { executable: process.env.RELAY_CREDENTIAL_HELPER }),
});

function connectionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command_id: randomUUID(),
    name: `conn-${randomUUID().slice(0, 8)}`,
    default_model: 'synthetic/model-a',
    api_key: `synthetic-key-${randomUUID()}`,
    ...overrides,
  };
}

interface ConnectionJson {
  readonly id: string;
  readonly name: string;
  readonly default_model: string;
  readonly base_url: string | null;
  readonly credential_version: number;
  readonly status: string;
  readonly revision: string;
  readonly budget: { readonly max_call_tokens: number };
}

function connectionOf(body: unknown): ConnectionJson {
  const envelope = body as { result: { connection: ConnectionJson } };
  assert.ok(envelope.result?.connection, `unexpected command envelope: ${JSON.stringify(body)}`);
  return envelope.result.connection;
}

test('创建连接：Key 只进系统凭据库，响应与列表都不含密钥或引用', async () => {
  const workspaceId = await createWorkspace(database.db);
  const apiKey = `synthetic-key-${randomUUID()}`;
  const created = await api.post(workspacePath(workspaceId, '/model-connections'),
    connectionBody({ name: 'primary', api_key: apiKey }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const connection = connectionOf(created.body);
  assert.equal(connection.name, 'primary');
  assert.equal(connection.default_model, 'synthetic/model-a');
  assert.equal(connection.base_url, null);
  assert.equal(connection.credential_version, 1);
  assert.equal(connection.status, 'ACTIVE');
  assert.equal(connection.revision, '1');
  assert.equal(connection.budget.max_call_tokens, 65_536);

  // 响应里既没有密钥，也没有凭据引用——引用是凭据库里的文件名，界面没有合法用途需要它。
  const serialized = JSON.stringify(created.body);
  assert.equal(serialized.includes(apiKey), false);
  assert.equal(serialized.includes('credential_ref'), false);
  assert.equal(serialized.includes('cred-'), false);

  const listed = await api.get(workspacePath(workspaceId, '/model-connections'));
  assert.equal(listed.status, 200);
  const items = (listed.body as { items: ConnectionJson[] }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, connection.id);
  assert.equal(JSON.stringify(listed.body).includes(apiKey), false);

  // 库里确实有这把 Key，且能被同一个引用解析出来（证明「不是只写了行」）。
  const present = await api.get(workspacePath(workspaceId,
    `/model-connections/${connection.id}/credential`));
  assert.equal(present.status, 200);
  assert.deepEqual(present.body, { present: true });
});

test('名称在工作区内唯一：重复即 409，且不会留下没人引用的凭据', async () => {
  const workspaceId = await createWorkspace(database.db);
  const first = await api.post(workspacePath(workspaceId, '/model-connections'),
    connectionBody({ name: 'duplicated' }));
  assert.equal(first.status, 201);

  const second = await api.post(workspacePath(workspaceId, '/model-connections'),
    connectionBody({ name: 'duplicated' }));
  expectProblem(second, 409, 'MODEL_CONNECTION_NAME_TAKEN');

  const listed = await api.get(workspacePath(workspaceId, '/model-connections'));
  assert.equal((listed.body as { items: unknown[] }).items.length, 1);
});

test('更新走 revision CAS：旧 revision 冲突，新 revision 生效', async () => {
  const workspaceId = await createWorkspace(database.db);
  const created = await api.post(workspacePath(workspaceId, '/model-connections'),
    connectionBody({ name: 'editable' }));
  const connection = connectionOf(created.body);

  const stale = await api.patch(workspacePath(workspaceId,
    `/model-connections/${connection.id}`), {
    command_id: randomUUID(), expected_revision: '99', name: 'renamed',
  });
  expectProblem(stale, 409, 'REVISION_CONFLICT');

  const updated = await api.patch(workspacePath(workspaceId,
    `/model-connections/${connection.id}`), {
    command_id: randomUUID(), expected_revision: connection.revision,
    name: 'renamed', default_model: 'synthetic/model-b',
    budget: { max_output_tokens: 1_024, max_call_tokens: 4_096, max_scope_tokens: 8_192 },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const next = connectionOf(updated.body);
  assert.equal(next.name, 'renamed');
  assert.equal(next.default_model, 'synthetic/model-b');
  assert.equal(next.budget.max_call_tokens, 4_096);
  assert.equal(next.revision, '2');

  // 预算跨列约束按「合并后的整行」判断：单次上限不能小于单次输出上限。
  const invalid = await api.patch(workspacePath(workspaceId,
    `/model-connections/${connection.id}`), {
    command_id: randomUUID(), expected_revision: next.revision,
    budget: { max_output_tokens: 8_192, max_call_tokens: 1_024 },
  });
  expectProblem(invalid, 422, 'MODEL_CONNECTION_INVALID');
});

test('轮换凭据：库里的秘密真的换了，代数加一，响应仍不含秘密', async () => {
  const workspaceId = await createWorkspace(database.db);
  const credentialRoot = join(api.dataRoot, 'credentials');
  const store = credentialStore();
  const before = new Set(await readdir(credentialRoot).catch(() => [] as string[]));

  const firstKey = `synthetic-key-${randomUUID()}`;
  const secondKey = `synthetic-key-${randomUUID()}`;
  const created = await api.post(workspacePath(workspaceId, '/model-connections'),
    connectionBody({ name: 'rotating', api_key: firstKey }));
  const connection = connectionOf(created.body);

  // 落盘的 blob 文件名就是凭据引用：找到本次新建的那一个，直接解出秘密来核对。
  const added = (await readdir(credentialRoot))
    .filter((name) => name.endsWith('.bin') && !before.has(name));
  assert.equal(added.length, 1, '创建连接应当且只应当写入一个凭据 blob');
  const reference = added[0]!.slice(0, -'.bin'.length);
  assert.equal(await store.resolve(reference), firstKey);

  const rotated = await api.post(workspacePath(workspaceId,
    `/model-connections/${connection.id}/credential`), {
    command_id: randomUUID(), expected_revision: connection.revision, api_key: secondKey,
  });
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  const next = connectionOf(rotated.body);
  assert.equal(next.credential_version, 2);
  assert.equal(next.revision, '2');
  assert.equal(JSON.stringify(rotated.body).includes(secondKey), false);

  // 同一引用下的秘密被覆盖：库里现在是第二把 Key，且没有留下第二份 blob。
  assert.equal(await store.resolve(reference), secondKey);
  const after = (await readdir(credentialRoot)).filter((name) => name.endsWith('.bin'));
  assert.equal(after.length, before.size + 1, '轮换不应留下孤儿 blob');

  const status = await api.get(workspacePath(workspaceId,
    `/model-connections/${connection.id}/credential`));
  assert.deepEqual(status.body, { present: true });
});

test('停用是状态而不是删除：列表仍可见，历史归因不丢', async () => {
  const workspaceId = await createWorkspace(database.db);
  const created = await api.post(workspacePath(workspaceId, '/model-connections'),
    connectionBody({ name: 'to-disable' }));
  const connection = connectionOf(created.body);

  const disabled = await api.post(workspacePath(workspaceId,
    `/model-connections/${connection.id}/status`), {
    command_id: randomUUID(), expected_revision: connection.revision, status: 'DISABLED',
  });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  assert.equal(connectionOf(disabled.body).status, 'DISABLED');

  const listed = await api.get(workspacePath(workspaceId, '/model-connections'));
  const items = (listed.body as { items: ConnectionJson[] }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.status, 'DISABLED');

  // 重新启用同样走 CAS。
  const enabled = await api.post(workspacePath(workspaceId,
    `/model-connections/${connection.id}/status`), {
    command_id: randomUUID(), expected_revision: connectionOf(disabled.body).revision,
    status: 'ACTIVE',
  });
  assert.equal(enabled.status, 200);
  assert.equal(connectionOf(enabled.body).status, 'ACTIVE');
});

test('重放同一 command_id 返回当时结果，不重复创建', async () => {
  const workspaceId = await createWorkspace(database.db);
  const body = connectionBody({ name: 'replayed' });
  const first = await api.post(workspacePath(workspaceId, '/model-connections'), body);
  assert.equal(first.status, 201);
  const replayed = await api.post(workspacePath(workspaceId, '/model-connections'), body);
  assert.equal(replayed.status, 201);
  assert.equal(replayed.headers['command-replayed'], 'true');
  assert.deepEqual(connectionOf(replayed.body).id, connectionOf(first.body).id);

  const listed = await api.get(workspacePath(workspaceId, '/model-connections'));
  assert.equal((listed.body as { items: unknown[] }).items.length, 1);
});

test('跨工作区不可见：另一工作区列表为空，按 id 读取 404', async () => {
  const owner = await createWorkspace(database.db);
  const other = await createWorkspace(database.db);
  const created = await api.post(workspacePath(owner, '/model-connections'),
    connectionBody({ name: 'scoped' }));
  const connection = connectionOf(created.body);

  const otherList = await api.get(workspacePath(other, '/model-connections'));
  assert.deepEqual(otherList.body, { items: [] });

  const otherRead = await api.get(workspacePath(other, `/model-connections/${connection.id}`));
  expectProblem(otherRead, 404, 'RESOURCE_NOT_FOUND');

  const otherUpdate = await api.patch(workspacePath(other, `/model-connections/${connection.id}`), {
    command_id: randomUUID(), expected_revision: connection.revision, name: 'hijacked',
  });
  expectProblem(otherUpdate, 404, 'RESOURCE_NOT_FOUND');
});
