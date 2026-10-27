import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { startTestApi, workspacePath } from './api-harness.js';
import { sql } from 'kysely';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { bindAssistSessionDirectory, createAssistSession } from '../../src/application/assist-commands.js';
import { openWorkingDirectory } from '../../src/application/open-working-directory.js';
import { setWorkspaceDefaultDirectory } from '../../src/application/workspace-default-directory.js';
import { disableManagedResourceCommand } from '../../src/application/gateway-commands.js';
import { forkAssistSession } from '../../src/application/assist-session-controls.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase, APP_DATABASE_URL } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-default-directory');
const roots: string[] = [];
before(async () => { await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY }); });
after(async () => {
  await app.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-default-directory-'));
  roots.push(root);
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: 'default-directory' });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId, title: 'Default directory', projectType: 'DEVELOPMENT' });
  });
  return { workspaceId, projectId, root };
}

test('DD-02/09: HTTP set/clear preserve revisions, receipts and read-only access', async () => {
  const api = await startTestApi();
  try {
    const f = await fixture();
    const path = (suffix: string) => workspacePath(f.workspaceId, suffix);
    const endpoint = path('/default-working-directory');
    const empty = await api.get(endpoint);
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(empty.body, { resource_id: null, canonical_root: null, display_name: null,
      write_tier: null, default_write_tier: null, context_budget_tokens: null,
      status: 'UNSET', reason: null, revision: '0' });
    const opened = await api.post(path('/working-directories/open'), {
      command_id: randomUUID(), root_path: f.root, project_id: f.projectId });
    assert.equal(opened.status, 200, opened.text);
    const resourceId = (opened.body as { result: { association: { resource_id: string } } }).result.association.resource_id;
    // 打开目录即登记为默认（首次），因此这里直接是 READY/1，而不是 UNSET/0。
    const registered = await api.get(endpoint);
    assert.equal((registered.body as { status: string }).status, 'READY');
    assert.equal((registered.body as { resource_id: string }).resource_id, resourceId);
    assert.equal((registered.body as { revision: string }).revision, '1');
    const body = { command_id: randomUUID(), expected_revision: '1', resource_id: resourceId };
    const set = await api.post(endpoint, body);
    assert.equal(set.status, 200, set.text);
    assert.equal((set.body as { result: { revision: string } }).result.revision, '2');
    assert.deepEqual((await api.post(endpoint, body)).body, set.body);
    assert.equal((await api.post(endpoint, { ...body, resource_id: randomUUID() })).status, 409);
    // 目标已达成时陈旧修订不是冲突：重复声明同一个默认目录返回当前事实，不改修订。
    const redeclared = await api.post(endpoint, { ...body, command_id: randomUUID() });
    assert.equal(redeclared.status, 200, redeclared.text);
    assert.equal((redeclared.body as { result: { revision: string } }).result.revision, '2');
    const before = await createRepositories(app.db).gateway.readLocalDirectoryAccess(resourceId);
    const projection = await api.get(endpoint);
    assert.equal((projection.body as { status: string }).status, 'READY');
    assert.equal((projection.body as { write_tier: string }).write_tier, 'READ_ONLY');
    assert.deepEqual((await api.get(endpoint)).body, projection.body);
    assert.deepEqual(await createRepositories(app.db).gateway.readLocalDirectoryAccess(resourceId), before);
    const clear = await api.post(path('/default-working-directory/clear'), {
      command_id: randomUUID(), expected_revision: '2' });
    assert.equal(clear.status, 200, clear.text);
    assert.equal((clear.body as { result: { revision: string } }).result.revision, '3');
    assert.deepEqual((await api.post(endpoint, body)).body, set.body, 'replay survives later clear');
    assert.equal(((await api.get(endpoint)).body as { status: string }).status, 'UNSET');
    assert.equal((await api.post(endpoint, { ...body, command_id: randomUUID() })).status, 409, 'clear never resets revision');
  } finally { await api.stop(); }
});

async function configured() {
  const f = await fixture();
  const opened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), rootPath: f.root });
  assert.equal(opened.result.status, 'READY');
  const resourceId = opened.result.association!.resource_id;
  // 打开目录已把它登记为默认目录（修订 1），这里不再重复设置。
  return { ...f, resourceId };
}

test('DD-01/03/04: only unscoped AGENT creation inherits; explicit project and old sessions stay unchanged', async () => {
  const f = await fixture();
  const create = () => createAssistSession(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(), title: 'new' });
  const old = await create();
  assert.equal(old.result.project_id, null);
  const opened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), rootPath: f.root });
  const resourceId = opened.result.association!.resource_id;
  // 打开目录即登记为默认目录，不再需要额外的设置命令。
  assert.equal((await createRepositories(app.db).workspaces.readDefaultDirectory(f.workspaceId))?.resource_id,
    resourceId);
  const fresh = await create();
  assert.equal(fresh.result.project_id, f.projectId);
  const r = createRepositories(app.db);
  const row = await r.assist.readSession(fresh.result.session_id);
  assert.equal(row?.working_resource_id, resourceId);
  assert.equal(row?.working_directory_source, 'WORKSPACE_DEFAULT');
  assert.equal((await r.assist.readSession(old.result.session_id))?.working_resource_id, null);
  const explicit = await createAssistSession(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: 'explicit project' });
  assert.equal((await r.assist.readSession(explicit.result.session_id))?.working_resource_id, null);
  const learning = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    conversationMode: 'LEARNING', commandId: randomUUID(), title: 'learn' });
  assert.equal(learning.result.project_id, null);
  // 分叉要求可搬历史（2026-10-24）：先给这条会话落一轮已完成的消息。
  await sql`insert into assist_messages (id, session_id, seq, role, status, intent, content)
    values (${randomUUID()}, ${fresh.result.session_id}, 1, 'USER', 'COMPLETED', 'DISCUSS', '说过一句话')`
    .execute(app.db);
  const fork = await forkAssistSession(app.db, { workspaceId: f.workspaceId,
    sessionId: row!.id, commandId: randomUUID(), expectedRevision: '0' });
  assert.equal((await r.assist.readSession(fork.result.session_id))?.working_directory_source, 'WORKSPACE_DEFAULT');
  await bindAssistSessionDirectory(app.db, { workspaceId: f.workspaceId,
    sessionId: row!.id, commandId: randomUUID(), resourceId });
  assert.equal((await r.assist.readSession(row!.id))?.working_directory_source, 'USER_PICKED');
});

test('DD-03/09: HTTP source projection survives clear and creation receipt replay', async () => {
  const f = await configured();
  const api = await startTestApi();
  try {
    const path = (suffix: string) => workspacePath(f.workspaceId, suffix);
    const body = { command_id: randomUUID(), title: 'inherited' };
    const created = await api.post(path('/assist-sessions'), body);
    assert.equal(created.status, 201, created.text);
    const sessionId = (created.body as { result: { session_id: string } }).result.session_id;
    const projection = await api.get(path(`/assist-sessions/${sessionId}?include_context=true`));
    assert.equal(projection.status, 200, projection.text);
    assert.deepEqual((projection.body as { context: { working_directory: unknown } }).context.working_directory,
      { resource_id: f.resourceId, canonical_root: f.root, source: 'WORKSPACE_DEFAULT' });
    await setWorkspaceDefaultDirectory(app.db, { workspaceId: f.workspaceId,
      commandId: randomUUID(), expectedRevision: '1', resourceId: null });
    assert.deepEqual((await api.post(path('/assist-sessions'), body)).body, created.body);
    assert.deepEqual((await api.get(path(`/assist-sessions/${sessionId}?include_context=true`))).body, projection.body);
  } finally { await api.stop(); }
});

test('DD-05: disabled, archived and missing directories fall back without rewriting history or permissions', async () => {
  for (const failure of ['DISABLED', 'ARCHIVED', 'MISSING'] as const) {
    const f = await configured();
    const r = createRepositories(app.db);
    const old = await createAssistSession(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(), title: 'old' });
    const access = await r.gateway.readLocalDirectoryAccess(f.resourceId);
    if (failure === 'DISABLED') {
      const resource = await r.gateway.readResource(f.resourceId);
      await disableManagedResourceCommand(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
        resourceId: f.resourceId, commandId: randomUUID(), expectedRevision: resource!.revision.toString() });
    } else if (failure === 'ARCHIVED') {
      await withTransaction(app.db, async (repos) => {
        const project = await repos.projects.readProject(f.projectId);
        await repos.projects.archiveProject(f.projectId, project!.revision);
      });
    } else await rm(f.root, { recursive: true });
    const fresh = await createAssistSession(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(), title: 'fallback' });
    assert.equal(fresh.result.project_id, null, failure);
    assert.equal((await r.assist.readSession(fresh.result.session_id))?.working_resource_id, null);
    assert.equal((await r.assist.readSession(old.result.session_id))?.working_resource_id, f.resourceId);
    assert.deepEqual(await r.gateway.readLocalDirectoryAccess(f.resourceId), access);
    await assert.rejects(setWorkspaceDefaultDirectory(app.db, { workspaceId: f.workspaceId,
      commandId: randomUUID(), expectedRevision: '1', resourceId: f.resourceId }), /默认目录尚未就绪/);
    assert.equal((await r.workspaces.readDefaultDirectory(f.workspaceId))?.revision, 1n);
  }
});

test('DD-09: concurrent first requests replay one receipt; competing revisions have exactly one winner', async () => {
  const f = await configured();
  const api = await startTestApi();
  try {
    const endpoint = workspacePath(f.workspaceId, '/default-working-directory');
    const body = { command_id: randomUUID(), resource_id: f.resourceId, expected_revision: '1' };
    const results = await Promise.all([api.post(endpoint, body), api.post(endpoint, body)]);
    assert.deepEqual(results.map((r) => r.status), [200, 200], JSON.stringify(results));
    assert.deepEqual(results[0]!.body, results[1]!.body);
    const competitors = await Promise.all([api.post(endpoint, { ...body, command_id: randomUUID(), expected_revision: '2' }),
      api.post(`${endpoint}/clear`, { command_id: randomUUID(), expected_revision: '2' })]);
    assert.deepEqual(competitors.map((r) => r.status).sort(), [200, 409]);
    const other = await fixture();
    assert.equal((await api.post(workspacePath(other.workspaceId, '/default-working-directory'), {
      command_id: randomUUID(), expected_revision: '0', resource_id: f.resourceId })).status, 404);
  } finally { await api.stop(); }
});
