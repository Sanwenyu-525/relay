import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';

import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createDataRoot, createWorkspace } from './api-harness.js';
import {
  APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, expectSqlState, openDatabase,
} from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-model-selection-source-acceptance');

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  await createDataRoot();
});

after(async () => { await app.close(); });

test('OpenRouter connection without catalog provenance is rejected even without free_only', async () => {
  const workspaceId = await createWorkspace(app.db);
  const sessionId = randomUUID();
  await createRepositories(app.db).assist.insertSession({
    id: sessionId, workspaceId, projectId: null, taskId: null, title: 'Model source acceptance',
  });

  await expectSqlState('23514', 'OpenRouter connection requires catalog provenance', () => sql`
    insert into session_model_selection
      (session_id, connection, model, config_fingerprint, free_only,
       catalog_source, catalog_snapshot_seq, catalog_model_id, selected_by_command_id)
    values (${sessionId}, 'openrouter', 'fixture/free', ${'a'.repeat(64)}, false,
      null, null, null, ${randomUUID()}::uuid)
  `.execute(app.db));

  const result = await sql<{ count: string }>`select count(*)::text as count
    from session_model_selection where session_id = ${sessionId}`.execute(app.db);
  assert.equal(result.rows[0]?.count, '0');
});
