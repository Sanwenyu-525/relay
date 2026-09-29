import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test, { after, before } from 'node:test';

import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { managedContentRef, resolveStoredContentPath } from '../../src/storage/managed-content-store.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, type TestApi } from './api-harness.js';

const database = openDatabase(APP_DATABASE_URL, 'relay-api-test-direct-uses');
let api: TestApi;
let workspaceId: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
  workspaceId = await createWorkspace(database.db);
});
after(async () => { await api?.stop(); await database.close(); });

test('direct-uses only exposes recorded same-workspace child versions with readable evidence', async () => {
  const created = await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: randomUUID(), project_id: null, title: '比较直接引用', objective: '核对版本来源',
    criteria: [{ criterion_id: 'c1', statement: '来源可核对' }],
  });
  assert.equal(created.status, 201, created.text);
  const taskId = (created.body as { result: { task_id: string } }).result.task_id;
  let taskRevision = (created.body as { result: { revision: string } }).result.revision;
  for (const step of ['ready', 'start']) {
    const response = await api.post(workspacePath(workspaceId, `/tasks/${taskId}/${step}`), {
      command_id: randomUUID(), expected_revision: taskRevision,
    });
    assert.equal(response.status, 200, response.text);
    taskRevision = (response.body as { result: { revision: string } }).result.revision;
  }
  const firstCommand = randomUUID();
  const firstResponse = await api.post(workspacePath(workspaceId, `/tasks/${taskId}/artifacts`), {
    command_id: firstCommand, expected_task_revision: taskRevision, title: '实验结果',
    media_type: 'text/markdown', content: '# 原结果',
  });
  const first = expectCommandAccepted(firstResponse, 201, firstCommand);
  const artifactId = first.artifact_id as string;
  const firstId = first.version_id as string;
  const endpoint = workspacePath(workspaceId, `/artifact-versions/${firstId}/direct-uses`);
  const empty = await api.get(endpoint);
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual((empty.body as { direct_uses: unknown[] }).direct_uses, []);
  assert.equal((empty.body as { complete: boolean }).complete, false);

  const nextCommand = randomUUID();
  const nextResponse = await api.post(workspacePath(workspaceId, `/artifacts/${artifactId}/versions`), {
    command_id: nextCommand, expected_artifact_revision: first.artifact_revision,
    expected_task_revision: first.task_revision, media_type: 'text/markdown', content: '# 修订结果',
  });
  const next = expectCommandAccepted(nextResponse, 201, nextCommand);
  const nextId = next.version_id as string;
  const uses = await api.get(endpoint);
  assert.equal(uses.status, 200, uses.text);
  assert.deepEqual((uses.body as { direct_uses: unknown[] }).direct_uses.map((entry) => {
    const row = entry as { relation: string; child_artifact_version_id: string; availability: string };
    return [row.relation, row.child_artifact_version_id, row.availability];
  }), [['REVISED_FROM', nextId, 'AVAILABLE']]);
  assert.equal((uses.body as { scope: string }).scope, 'RECORDED_DIRECT_ONLY');
  assert.equal((uses.body as { has_more: boolean }).has_more, false);

  const otherWorkspace = await createWorkspace(database.db);
  const foreign = await api.get(workspacePath(otherWorkspace, `/artifact-versions/${firstId}/direct-uses`));
  assert.equal(foreign.status, 404);

  await rm(resolveStoredContentPath(api.dataRoot, managedContentRef(artifactId, nextId)));
  const missingChild = await api.get(endpoint);
  assert.equal(missingChild.status, 200, missingChild.text);
  const hidden = (missingChild.body as { direct_uses: { availability: string; child_artifact_version_id: string | null;
    child_artifact_id: string | null; child_version_number: string | null }[] }).direct_uses[0];
  assert.deepEqual(hidden, { ...hidden, availability: 'UNAVAILABLE', child_artifact_version_id: null,
    child_artifact_id: null, child_version_number: null });

  await rm(resolveStoredContentPath(api.dataRoot, managedContentRef(artifactId, firstId)));
  const missingSource = await api.get(endpoint);
  assert.equal(missingSource.status, 200, missingSource.text);
  assert.equal((missingSource.body as { source_content_availability: string }).source_content_availability, 'UNAVAILABLE');
  assert.deepEqual((missingSource.body as { direct_uses: unknown[] }).direct_uses, []);
});
