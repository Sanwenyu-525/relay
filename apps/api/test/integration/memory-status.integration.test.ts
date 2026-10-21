import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after, before } from 'node:test';

import { addMemoryRevision, createMemory, restoreInformation, retireInformation }
  from '../../src/application/information-commands.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { startTestApi, workspacePath, type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase }
  from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-memory-status');
let api: TestApi;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => { await api?.stop(); await app.close(); });

async function fixture() {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: 'memory-status' });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId, title: 'memory', projectType: 'GENERAL' });
  });
  const path = (suffix: string) => workspacePath(workspaceId, suffix);
  return { workspaceId, projectId, path };
}

type Memory = { id: string; status: string; effective_status: string; revision: string;
  current_version: string; expires_at: string | null };
async function list(path: string): Promise<Memory[]> {
  const response = await api.get(path);
  assert.equal(response.status, 200, response.text);
  return response.body as Memory[];
}

test('memory management exposes effective status while preserving stored lifecycle status', async () => {
  const f = await fixture();
  const created = await createMemory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: 'confirmed', text: 'durable memory', confirmed: true });
  const result = await api.get(f.path(`/memories/${created.result.memory_id}`));
  assert.equal(result.status, 200, result.text);
  assert.equal((result.body as Memory).effective_status, 'ACTIVE');
  assert.equal((result.body as Memory).status, 'ACTIVE');
  assert.equal((await list(f.path('/memories?effective_status=ACTIVE'))).length, 1);
  assert.equal((await list(f.path('/memories?effective_status=EXPIRED'))).length, 0);
  assert.equal((await api.get(f.path('/memories?effective_status=UNKNOWN'))).status, 422);
});

test('expiry and retirement filters are disjoint; reactivation does not extend expired memory', async () => {
  const f = await fixture();
  const expiresAt = new Date(Date.now() + 1500).toISOString();
  const created = await createMemory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: 'expiring', text: 'short lived', confirmed: true, expiresAt });
  const id = created.result.memory_id!;
  const r = createRepositories(app.db);
  const before = await r.information.readRoot('memory', id);
  const versions = await r.information.listVersions('memory', id);
  const authority = await r.workspaces.readAuthority(f.workspaceId);
  await delay(Math.max(0, Date.parse(expiresAt) - Date.now() + 30));
  const expired = await list(f.path('/memories?effective_status=EXPIRED'));
  assert.deepEqual(expired.map((m) => m.id), [id]);
  assert.equal(expired[0]?.status, 'ACTIVE');
  const detail = await api.get(f.path(`/memories/${id}`));
  assert.deepEqual(detail.body, expired[0]);
  assert.equal((await list(f.path('/memories?effective_status=ACTIVE'))).length, 0);
  const search = await api.get(f.path('/search?q=short%20lived&types=MEMORY'));
  assert.equal(search.status, 200, search.text);
  assert.equal((search.body as { items: unknown[] }).items.length, 0);
  assert.equal((await r.information.listContextCandidates(f.workspaceId, f.projectId, 10))
    .some((candidate) => candidate.id === id), false);
  assert.deepEqual(await r.information.readRoot('memory', id), before, 'expiry is a read projection, no clock-driven write');
  assert.deepEqual(await r.workspaces.readAuthority(f.workspaceId), authority);
  assert.deepEqual(await r.information.listVersions('memory', id), versions);
  const retired = await retireInformation(app.db, { workspaceId: f.workspaceId, kind: 'memory', id,
    commandId: randomUUID(), expectedRevision: '0' });
  assert.equal((await list(f.path('/memories?effective_status=EXPIRED'))).length, 0);
  assert.deepEqual((await list(f.path('/memories?effective_status=RETIRED'))).map((m) => m.id), [id]);
  await restoreInformation(app.db, { workspaceId: f.workspaceId, kind: 'memory', id,
    commandId: randomUUID(), expectedRevision: retired.result.revision });
  assert.equal((await list(f.path('/memories')))[0]?.effective_status, 'EXPIRED');
  assert.deepEqual(await r.information.listVersions('memory', id), versions);
  await addMemoryRevision(app.db, { workspaceId: f.workspaceId, memoryId: id,
    commandId: randomUUID(), expectedRevision: '2', title: 'renewed', text: 'explicitly reconfirmed',
    confirmed: true, expiresAt: null });
  const renewed = await list(f.path('/memories?effective_status=ACTIVE'));
  assert.equal(renewed[0]?.current_version, '2');
  assert.equal(renewed[0]?.expires_at, null);
});

test('default ALL stays compatible and project filters retain global facts without leaking other scopes', async () => {
  const f = await fixture();
  const other = await fixture();
  const siblingProjectId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.projects.insertProject({ id: siblingProjectId, workspaceId: f.workspaceId,
      title: 'sibling scope', projectType: 'GENERAL' });
  });
  await createMemory(app.db, { workspaceId: f.workspaceId, projectId: siblingProjectId,
    commandId: randomUUID(), title: 'sibling', text: 'other project', confirmed: true });
  const ids: string[] = [];
  for (const projectId of [null, f.projectId]) {
    const created = await createMemory(app.db, { workspaceId: f.workspaceId, projectId,
      commandId: randomUUID(), title: 'scoped', text: 'confirmed scope', confirmed: true });
    ids.push(created.result.memory_id!);
  }
  await createMemory(app.db, { workspaceId: other.workspaceId, projectId: other.projectId,
    commandId: randomUUID(), title: 'foreign', text: 'must not leak', confirmed: true });
  await retireInformation(app.db, { workspaceId: f.workspaceId, kind: 'memory', id: ids[0]!,
    commandId: randomUUID(), expectedRevision: '0' });
  assert.deepEqual(await list(f.path('/memories')), await list(f.path('/memories?effective_status=ALL')));
  const scoped = await list(f.path(`/memories?project_id=${f.projectId}`));
  assert.deepEqual(new Set(scoped.map((m) => m.id)), new Set(ids));
  assert.equal((await api.get(f.path(`/memories?project_id=${other.projectId}`))).status, 404);
  assert.equal((await api.get(other.path(`/memories/${ids[0]}`))).status, 404);
});
