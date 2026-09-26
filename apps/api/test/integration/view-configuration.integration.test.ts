import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createProject } from '../../src/application/create-project.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createWorkspace, expectProblem, startTestApi, workspacePath }
  from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-m05-view');
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
});
after(async () => { await app.close(); });

test('View Owner persists built-in template, CAS and replay without changing execution facts', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId,
    commandId: randomUUID(), title: '视图归属', projectType: 'THESIS' });
  const projectId = project.result.project_id;
  const api = await startTestApi();
  try {
    const path = `${workspacePath(workspaceId)}/projects/${projectId}/view-configuration`;
    const initial = await api.get(path);
    assert.equal(initial.status, 200);
    const start = initial.body as { revision: string; kind: string;
      template_sha256: string; pages: { page_id: string; position: number }[] };
    assert.equal(start.kind, 'thesis');
    assert.equal(start.revision, '0');
    assert.match(start.template_sha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(start.pages.map((page) => page.page_id),
      ['state', 'knowledge', 'tasks', 'artifacts', 'reviews']);
    const commandId = randomUUID();
    const body = { command_id: commandId, expected_revision: '0', kind: 'development' };
    const set = await api.post(path, body);
    assert.equal(set.status, 200);
    const changed = (set.body as { result: { kind: string; revision: string;
      pages: { page_id: string }[] } }).result;
    assert.equal(changed.kind, 'development');
    assert.equal(changed.revision, '1');
    assert.deepEqual(changed.pages.map((page) => page.page_id),
      ['state', 'tasks', 'runs', 'connections', 'reviews']);
    const replay = await api.post(path, body);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers['command-replayed'], 'true');
    assert.deepEqual((replay.body as { result: unknown }).result, changed);
    const stale = await api.post(path, { command_id: randomUUID(),
      expected_revision: '0', kind: 'general' });
    expectProblem(stale, 409, 'REVISION_CONFLICT');
    const unknown = await api.post(path, { command_id: randomUUID(),
      expected_revision: '1', kind: 'general', custom_page: 'arbitrary' });
    expectProblem(unknown, 422, 'VALIDATION_FAILED');
    const cross = await api.get(`${workspacePath(await createWorkspace(app.db))}` +
      `/projects/${projectId}/view-configuration`);
    expectProblem(cross, 404, 'RESOURCE_NOT_FOUND');
    const untouched = await sql<{ project_revision: string; state_revision: string;
      project_type: string }>`select p.revision::text as project_revision,
      ps.revision::text as state_revision, p.project_type from projects p
      join project_states ps on ps.project_id = p.id where p.id = ${projectId}`
      .execute(app.db);
    assert.deepEqual(untouched.rows[0], { project_revision: '0',
      state_revision: '0', project_type: 'THESIS' });
    const audit = await sql<{ count: string }>`select count(*)::text as count
      from activity_records where command_id = ${commandId}`.execute(app.db);
    assert.equal(audit.rows[0]!.count, '1');
  } finally { await api.stop(); }
});
