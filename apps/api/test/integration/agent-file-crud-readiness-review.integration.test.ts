import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { createGatewayPolicy, registerManagedResource } from
  '../../src/application/gateway-configuration.js';
import { readWorkingDirectoryWriteReadiness } from
  '../../src/application/open-working-directory.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from
  './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-file-crud-readiness-review');
const roots: string[] = [];

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
});

after(async () => {
  await app.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test('a FILE_WRITE connection for another root does not make this directory ready', async () => {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const rootA = await mkdtemp(join(tmpdir(), 'relay-crud-root-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'relay-crud-root-b-'));
  roots.push(rootA, rootB);
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'file-crud-review' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId,
      title: 'two directories', projectType: 'DEVELOPMENT' });
  });
  const resourceA = await registerManagedResource(app.db,
    { workspaceId, projectId, rootPath: rootA });
  const resourceB = await registerManagedResource(app.db,
    { workspaceId, projectId, rootPath: rootB });
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
      workspaceId, projectId, config: { root_path: resourceA.canonicalRoot } });
    await repositories.gateway.addConnectionCapability(connection.id, 'FILE_WRITE');
    await repositories.workspaces.bumpAuthority(workspaceId);
  });
  await createGatewayPolicy(app.db, { workspaceId, projectId, capability: 'FILE_WRITE',
    actionType: 'APPLY_CHANGESET', targetPrefix: resourceB.canonicalRoot, decision: 'AUTO',
    maxPayloadBytes: 262144 });

  const readiness = await readWorkingDirectoryWriteReadiness(app.db, workspaceId,
    projectId, resourceB.resourceId);
  assert.equal(readiness.status, 'NEEDS_CONNECTION',
    'directory B has no write connection; a connection restricted to A must not project B as READY');
});
