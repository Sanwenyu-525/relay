import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { createGatewayPolicy, registerManagedResource } from
  '../../src/application/gateway-configuration.js';
import { createGatewayConnectionCommand, revokeGatewayPolicyCommand } from
  '../../src/application/gateway-commands.js';
import { setLocalDirectoryWriteTier } from '../../src/application/local-directory-access.js';
import { openWorkingDirectory } from '../../src/application/open-working-directory.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from
  './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-local-access-independent-review');
const roots: string[] = [];

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
});

after(async () => {
  await app.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-local-access-review-'));
  roots.push(root);
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'independent review' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId,
      title: 'directory access review', projectType: 'DEVELOPMENT' });
  });
  return { workspaceId, projectId, root };
}

test('a committed directory tier command replays after its directory has disappeared', async () => {
  const f = await fixture();
  const opened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), rootPath: f.root });
  const input = { workspaceId: f.workspaceId, projectId: f.projectId,
    resourceId: opened.result.association!.resource_id, commandId: randomUUID(),
    expectedRevision: opened.result.write_readiness.access_revision, tier: 'ASK' as const };
  const committed = await setLocalDirectoryWriteTier(app.db, input);
  const repositories = createRepositories(app.db);
  const accessBefore = await repositories.gateway.readLocalDirectoryAccess(input.resourceId);
  const connectionsBefore = await repositories.gateway.listConnections(f.workspaceId, f.projectId);
  const policiesBefore = await repositories.gateway.listActivePolicies(f.workspaceId, f.projectId,
    'FILE_WRITE', 'APPLY_CHANGESET');
  await rmdir(f.root);
  const replay = await setLocalDirectoryWriteTier(app.db, input);
  assert.deepEqual(replay.result, committed.result,
    'the receipt is historical truth; replay must not require the original directory to still exist');
  assert.equal(replay.committedAt.toISOString(), committed.committedAt.toISOString());
  assert.equal(replay.replayed, true);
  assert.equal((await repositories.gateway.readLocalDirectoryAccess(input.resourceId))?.revision,
    accessBefore?.revision, 'replay does not advance the directory revision');
  assert.deepEqual(await repositories.gateway.listConnections(f.workspaceId, f.projectId), connectionsBefore);
  assert.deepEqual(await repositories.gateway.listActivePolicies(f.workspaceId, f.projectId,
    'FILE_WRITE', 'APPLY_CHANGESET'), policiesBefore);
  await assert.rejects(() => setLocalDirectoryWriteTier(app.db, { ...input, tier: 'AUTO' }),
    /already used with a different payload/u,
    'the same command ID with a changed tier is still rejected after the root disappears');
});

test('first directory setup does not replace a manually revoked read policy with AUTO', async () => {
  const f = await fixture();
  const resource = await registerManagedResource(app.db,
    { workspaceId: f.workspaceId, projectId: f.projectId, rootPath: f.root });
  await createGatewayConnectionCommand(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), capabilities: ['FILE_QUERY', 'FILE_READ'],
    rootPath: resource.canonicalRoot });
  const policy = await createGatewayPolicy(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, capability: 'FILE_READ', actionType: 'READ_FILE',
    targetPrefix: resource.canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
  const original = await createRepositories(app.db).gateway.readPolicy(policy.policyId);
  assert.ok(original);
  await revokeGatewayPolicyCommand(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    policyId: policy.policyId, commandId: randomUUID(), expectedRevision: original.revision.toString() });
  try {
    await openWorkingDirectory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
      commandId: randomUUID(), rootPath: f.root });
  } catch (error) {
    assert.match(error instanceof Error ? error.message : String(error), /撤销|限制|revok/iu);
  }
  const active = await createRepositories(app.db).gateway.listActivePolicies(f.workspaceId,
    f.projectId, 'FILE_READ', 'READ_FILE');
  assert.equal(active.filter((row) => row.target_prefix === resource.canonicalRoot &&
    row.decision === 'AUTO').length, 0,
  'an explicit directory selection must not silently recreate a revoked read permission under a new policy ID');
});

test('a revoked ancestor read rule blocks only roots it covers', async () => {
  const f = await fixture();
  const child = join(f.root, 'child');
  await mkdir(child);
  const parentPolicy = await createGatewayPolicy(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, capability: 'FILE_READ', actionType: 'READ_FILE',
    targetPrefix: f.root, decision: 'AUTO', maxPayloadBytes: 262144 });
  const parentRow = await createRepositories(app.db).gateway.readPolicy(parentPolicy.policyId);
  assert.ok(parentRow);
  await revokeGatewayPolicyCommand(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    policyId: parentPolicy.policyId, commandId: randomUUID(), expectedRevision: parentRow.revision.toString() });

  await assert.rejects(() => openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), rootPath: child }), /读取规则.*撤销/u);

  const unrelated = await mkdtemp(join(tmpdir(), 'relay-local-access-unrelated-'));
  roots.push(unrelated);
  const opened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), rootPath: unrelated });
  assert.equal(opened.result.status, 'READY');
  const active = await createRepositories(app.db).gateway.listActivePolicies(f.workspaceId, f.projectId,
    'FILE_READ', 'READ_FILE');
  assert.ok(active.some((row) => row.target_prefix === opened.result.canonical_root && row.decision === 'AUTO'),
    'a historical rule for one root must not block an unrelated root in the same project');
});

test('a later explicit read rule reauthorizes, while a revoked application-managed rule stays revoked', async () => {
  const f = await fixture();
  const resource = await registerManagedResource(app.db,
    { workspaceId: f.workspaceId, projectId: f.projectId, rootPath: f.root });
  const original = await createGatewayPolicy(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, capability: 'FILE_READ', actionType: 'READ_FILE',
    targetPrefix: resource.canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
  const originalRow = await createRepositories(app.db).gateway.readPolicy(original.policyId);
  assert.ok(originalRow);
  await revokeGatewayPolicyCommand(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    policyId: original.policyId, commandId: randomUUID(), expectedRevision: originalRow.revision.toString() });
  const reauthorized = await createGatewayPolicy(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, capability: 'FILE_READ', actionType: 'READ_FILE',
    targetPrefix: resource.canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
  const opened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), rootPath: f.root });
  assert.equal(opened.result.status, 'READY');
  const activeManual = await createRepositories(app.db).gateway.listActivePolicies(f.workspaceId, f.projectId,
    'FILE_READ', 'READ_FILE');
  assert.deepEqual(activeManual.filter((row) => row.target_prefix === resource.canonicalRoot).map((row) => row.id),
    [reauthorized.policyId], 'an explicit active rule is reused instead of replaced by a new default');

  const managedRoot = await mkdtemp(join(tmpdir(), 'relay-local-access-managed-'));
  roots.push(managedRoot);
  const managedOpened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), rootPath: managedRoot });
  const managedResourceId = managedOpened.result.association?.resource_id;
  assert.equal(typeof managedResourceId, 'string');
  const access = await createRepositories(app.db).gateway.readLocalDirectoryAccess(managedResourceId as string);
  assert.ok(access);
  const managedPolicyId = access.policy_ids.READ_FILE;
  assert.equal(typeof managedPolicyId, 'string');
  const managedPolicy = await createRepositories(app.db).gateway.readPolicy(managedPolicyId as string);
  assert.ok(managedPolicy);
  await revokeGatewayPolicyCommand(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    policyId: managedPolicy.id, commandId: randomUUID(), expectedRevision: managedPolicy.revision.toString() });
  await openWorkingDirectory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), rootPath: managedRoot });
  const afterReopen = await createRepositories(app.db).gateway.readPolicy(managedPolicy.id);
  assert.equal(afterReopen?.status, 'REVOKED');
  const accessAfterReopen = await createRepositories(app.db).gateway.readLocalDirectoryAccess(managedResourceId as string);
  assert.deepEqual(accessAfterReopen?.policy_ids, access.policy_ids,
    'reopening an app-managed directory preserves the revoked policy identity');
  assert.equal(accessAfterReopen?.policy_ids.READ_FILE, managedPolicy.id,
    'the original application-managed policy ID remains the recorded identity');
  const activeManagedPolicies = await createRepositories(app.db).gateway.listActivePolicies(f.workspaceId,
    f.projectId, 'FILE_READ', 'READ_FILE');
  assert.equal(activeManagedPolicies.filter((row) => row.target_prefix === managedRoot &&
    row.decision === 'AUTO').length, 0, 'reopening the managed root must not create a replacement AUTO policy');
});
