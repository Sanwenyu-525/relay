import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { delegateTask } from '../../src/application/delegate-task.js';
import {
  claimGatewayWorker, claimRunForGateway, dispatchGatewayAction, prepareGatewayAction,
  readGatewayOperation, reconcileGatewayInvocation, releaseGatewayWorker, SimulatedGatewayCrash,
  type GatewayOrigin,
} from '../../src/application/gateway-actions.js';
import {
  createFakeConnection, createGatewayPolicy, disableManagedResource, registerManagedResource,
} from '../../src/application/gateway-configuration.js';
import { resolveReview } from '../../src/application/review-decisions.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import type { GatewayCapability } from '../../src/infrastructure/database-schema.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { isProcessAlive } from '../../src/cli-worker/process-tree.js';
import type { ChangeSetLedgerFile } from '../../src/files/change-set-repository.js';
import { createDataRoot, startTestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, expectSqlState, openDatabase } from './integration-support.js';

// M06 real-tools verification: drives the already-wired FILE_WRITE / GIT_READ /
// GIT_WRITE / CLI_RUN adapters through the full Gateway lifecycle (prepare -> approve
// -> dispatch -> reconcile) against a REAL temporary directory, a REAL git repository
// and REAL child processes. This is the M06 exit evidence ("真实工具与故障/冲突测试"),
// which Fake Gateway results cannot substitute.

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-m06-real-tools');
let dataRoot: string;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

function sha256(text: string): string { return createHash('sha256').update(text).digest('hex'); }

function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

/** Plain git for *test fixture setup only* (never the audited adapter path). */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
}
function headSha(cwd: string): string { return git(cwd, ['rev-parse', 'HEAD']).trim(); }
function lastMessage(cwd: string): string { return git(cwd, ['log', '-1', '--format=%s']).trim(); }
/** Reads back the object id a `origin <ref>` currently points at, or '' when absent. */
function gitRemoteSha(cwd: string, ref: string): string {
  const out = git(cwd, ['ls-remote', 'origin', ref]);
  const firstLine = out.split('\n')[0] ?? '';
  return (firstLine.split(/\s+/)[0] ?? '').trim();
}

interface RealFixture {
  workspaceId: string; projectId: string; taskId: string; runId: string; stepId: string;
  root: string; resourceId: string; connectionId: string; policyId: string;
}

/** Boots a RUNNING Run with a frozen DRAFT step, a managed resource rooted at a real
 * temp dir (optionally a committed git repo), a connection carrying the target
 * capability and a matching permission policy. */
async function realFixture(input: {
  capabilities: readonly GatewayCapability[]; capability: GatewayCapability;
  actionType: string; decision?: 'AUTO' | 'ASK'; gitRepo?: boolean; maxPayloadBytes?: number;
}): Promise<RealFixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `m06-${workspaceId}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'M06 Real Tools', projectType: 'DEVELOPMENT' });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
    await repositories.tasks.insertTask({ id: taskId, workspaceId, projectId, title: 'Real tool',
      status: 'READY', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
      ownershipEpoch: 0n, currentCompletionId: null });
    await repositories.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: 'M06 真实工具', requiredOutputSpec: {}, source: 'CREATE' });
    await repositories.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
      statement: '人工核对', required: true, method: 'HUMAN', targetSpec: {} });
  });
  const delegated = await delegateTask(app.db, { workspaceId, taskId, commandId: randomUUID(), expectedTaskRevision: '0' });
  const runId = delegated.result.run_id;
  const storage = new ManagedContentStore(dataRoot);
  for (const kind of ['BUILD_CONTEXT', 'DRAFT']) {
    const advanced = await advanceRunStep(app.db, { runId, workerId: `setup-${randomUUID()}`, storage });
    assert.equal(advanced.status, 'STEP_SUCCEEDED', `${kind}: ${JSON.stringify(advanced)}`);
  }
  const step = await withTransaction(app.db, (repositories) => repositories.runs.readStepByKind(runId, 'DRAFT'));
  assert.ok(step);

  const root = join(dataRoot, `m06-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  if (input.gitRepo) {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'relay@test.local']);
    git(root, ['config', 'user.name', 'Relay Test']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    await writeFile(join(root, 'README.md'), 'seed\n', 'utf8');
    git(root, ['add', '--', 'README.md']);
    git(root, ['commit', '-q', '-m', 'seed']);
  }
  const resource = await registerManagedResource(app.db, { workspaceId, projectId, rootPath: root });
  const connection = await createFakeConnection(app.db, { workspaceId, projectId, capabilities: input.capabilities });
  const policy = await createGatewayPolicy(app.db, { workspaceId, projectId, capability: input.capability,
    actionType: input.actionType, targetPrefix: resource.canonicalRoot, decision: input.decision ?? 'AUTO',
    maxPayloadBytes: input.maxPayloadBytes ?? 8192 });
  return { workspaceId, projectId, taskId, runId, stepId: step.id, root: resource.canonicalRoot,
    resourceId: resource.resourceId, connectionId: connection.connectionId, policyId: policy.policyId };
}

async function claim(f: RealFixture, workerId = `worker-${randomUUID()}`) {
  const held = await claimRunForGateway(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId });
  const origin: GatewayOrigin = { kind: 'RUN', runId: f.runId, stepId: f.stepId,
    resourceId: f.resourceId, workerId, workerEpoch: BigInt(held.worker_epoch) };
  return origin;
}

async function approve(workspaceId: string, reviewId: string) {
  const review = await withTransaction(app.db, (repositories) => repositories.reviews.readRequest(reviewId));
  assert.ok(review);
  return resolveReview(app.db, { workspaceId, reviewId, commandId: randomUUID(),
    expectedRevision: review.revision.toString(), targetHash: review.target_hash.toString('hex'), decision: 'APPROVE' });
}

/** Non-passthrough writes are downgraded AUTO -> ASK at prepare, so the happy path
 * always runs prepare -> approve -> new-epoch claim -> dispatch. Returns the fresh
 * worker origin authorized to dispatch the approved operation. */
async function approveAndReclaim(f: RealFixture, operationId: string, reviewId: string) {
  const decided = await approve(f.workspaceId, reviewId);
  assert.equal(decided.result.effect.external_effect_executed, false, 'approval alone executes nothing');
  const nextId = `worker-${randomUUID()}`;
  const nextEpoch = BigInt((await claimGatewayWorker(app.db, { workspaceId: f.workspaceId, operationId, workerId: nextId })).worker_epoch);
  const origin: GatewayOrigin = { kind: 'RUN', runId: f.runId, stepId: f.stepId,
    resourceId: f.resourceId, workerId: nextId, workerEpoch: nextEpoch };
  return origin;
}

/** Reads back the single invocation of a just-dispatched operation. */
async function soleInvocation(workspaceId: string, operationId: string) {
  const persisted = await readGatewayOperation(app.db, workspaceId, operationId);
  const invocation = persisted.invocations[0];
  assert.ok(invocation, 'operation must have an invocation');
  return { invocationId: invocation.id, status: invocation.status, operationStatus: persisted.operation.status };
}

/** M06 增量A：按 invocation 读回 change_sets 账本头与按路径排序的不可变逐文件行。 */
async function readLedger(invocationId: string) {
  return withTransaction(app.db, async (repositories) => {
    const cs = await repositories.changeSets.readByInvocation(invocationId);
    if (cs === undefined) return undefined;
    return { cs, files: await repositories.changeSets.listFiles(cs.id) };
  });
}

// ---------------------------------------------------------------------------
// P16 Files / changeset through the Gateway
// ---------------------------------------------------------------------------

test('M06 frozen FILE_WRITE diff uses immutable planned baseline and target text', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  await writeFile(join(f.root, 'modify.txt'), 'before\nold\n');
  await writeFile(join(f.root, 'delete.txt'), 'remove me\n');
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root, params: { changes: [
      { path: 'create.txt', action: 'CREATE', content: 'created\n' },
      { path: 'modify.txt', action: 'MODIFY', baselineSha256: sha256('before\nold\n'),
        content: 'before\nnew\n' },
      { path: 'delete.txt', action: 'DELETE', baselineSha256: sha256('remove me\n') },
    ] } });
  assert.equal(prepared.status, 'WAITING_APPROVAL');
  const api = await startTestApi();
  try {
    const path = `/api/v1/workspaces/${f.workspaceId}/operations/${op}/file-write-diff`;
    const response = await api.get(path);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.headers['cache-control'], 'no-store');
    const body = response.body as { operation_id: string; basis: string; files: Array<{
      relative_path: string; availability: string; before_text: string | null;
      after_text: string | null; baseline_sha256: string | null; target_sha256: string | null;
    }> };
    assert.equal(body.operation_id, op);
    assert.equal(body.basis, 'FROZEN_INTENT');
    const byPath = new Map(body.files.map((file) => [file.relative_path, file]));
    assert.equal(byPath.get('create.txt')?.availability, 'AVAILABLE');
    assert.equal(byPath.get('create.txt')?.before_text, '');
    assert.equal(byPath.get('create.txt')?.after_text, 'created\n');
    assert.equal(byPath.get('modify.txt')?.availability, 'AVAILABLE');
    assert.equal(byPath.get('modify.txt')?.before_text, 'before\nold\n');
    assert.equal(byPath.get('modify.txt')?.after_text, 'before\nnew\n');
    assert.equal(byPath.get('modify.txt')?.baseline_sha256, sha256('before\nold\n'));
    assert.equal(byPath.get('modify.txt')?.target_sha256, sha256('before\nnew\n'));
    assert.equal(byPath.get('delete.txt')?.availability, 'AVAILABLE');
    assert.equal(byPath.get('delete.txt')?.before_text, 'remove me\n');
    assert.equal(byPath.get('delete.txt')?.after_text, '');
    const rows = await sql<{ relative_path: string }>`select relative_path from file_write_frozen_diffs
      where operation_id=${op} order by relative_path`.execute(app.db);
    assert.deepEqual(rows.rows.map((row) => row.relative_path), ['delete.txt', 'modify.txt'],
      'CREATE has an implicit empty baseline, not a persisted snapshot');
    await expectSqlState('42501', 'rewriting frozen baseline evidence', () => sql`
      update file_write_frozen_diffs set baseline_text='forged' where operation_id=${op}
    `.execute(app.db));
    await expectSqlState('42501', 'deleting frozen baseline evidence', () => sql`
      delete from file_write_frozen_diffs where operation_id=${op}
    `.execute(app.db));
    await writeFile(join(f.root, 'modify.txt'), 'outside edit\n');
    const reread = await api.get(path);
    assert.equal(reread.status, 200, reread.text);
    assert.equal((reread.body as typeof body).files.find((file) => file.relative_path === 'modify.txt')?.before_text,
      'before\nold\n', 'current disk must not replace the frozen planned baseline');
    const outside = await api.get(`/api/v1/workspaces/${randomUUID()}/operations/${op}/file-write-diff`);
    assert.equal(outside.status, 404);
  } finally { await api.stop(); }
});

test('M06 frozen FILE_WRITE diff marks mismatched, binary and oversized baselines unavailable', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  await writeFile(join(f.root, 'mismatch.txt'), 'actual\n');
  const binary = Buffer.from([0, 1, 2]);
  await writeFile(join(f.root, 'binary.txt'), binary);
  const oversized = 'a'.repeat(64 * 1024 + 1);
  await writeFile(join(f.root, 'oversized.txt'), oversized);
  const op = randomUUID();
  await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin: await claim(f),
    actionType: 'APPLY_CHANGESET', target: f.root, params: { changes: [
      { path: 'mismatch.txt', action: 'MODIFY', baselineSha256: sha256('wrong\n'), content: 'new\n' },
      { path: 'binary.txt', action: 'MODIFY', baselineSha256: createHash('sha256').update(binary).digest('hex'),
        content: 'new\n' },
      { path: 'oversized.txt', action: 'MODIFY', baselineSha256: sha256(oversized), content: 'new\n' },
    ] } });
  const api = await startTestApi();
  try {
    const response = await api.get(`/api/v1/workspaces/${f.workspaceId}/operations/${op}/file-write-diff`);
    assert.equal(response.status, 200, response.text);
    const files = (response.body as { files: Array<{ relative_path: string; availability: string;
      unavailable_reason: string | null; before_text: string | null; after_text: string | null }> }).files;
    assert.deepEqual(files.map((file) => [file.relative_path, file.availability, file.unavailable_reason]), [
      ['mismatch.txt', 'UNAVAILABLE', 'BASELINE_SHA_MISMATCH'],
      ['binary.txt', 'UNAVAILABLE', 'BINARY_OR_INVALID_UTF8'],
      ['oversized.txt', 'UNAVAILABLE', 'TEXT_TOO_LARGE'],
    ]);
    assert.ok(files.every((file) => file.before_text === null && file.after_text === null));
  } finally { await api.stop(); }
});

test('M06 frozen WRITE_FILE diff uses the ledger path and immutable modify baseline', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'WRITE_FILE' });
  const target = join(f.root, 'nested', 'note.txt');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, 'original\n');
  const op = randomUUID();
  await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin: await claim(f),
    actionType: 'WRITE_FILE', target,
    params: { content: 'replacement\n', baseline_sha256: sha256('original\n') } });
  const api = await startTestApi();
  try {
    await writeFile(target, 'external edit\n');
    const response = await api.get(`/api/v1/workspaces/${f.workspaceId}/operations/${op}/file-write-diff`);
    assert.equal(response.status, 200, response.text);
    assert.deepEqual((response.body as { files: Array<{ relative_path: string; action: string;
      availability: string; before_text: string | null; after_text: string | null }> }).files.map((file) => ({
      path: file.relative_path, action: file.action, availability: file.availability,
      before: file.before_text, after: file.after_text,
    })), [{ path: process.platform === 'win32' ? 'nested/note.txt' : 'note.txt',
      action: 'MODIFY', availability: 'AVAILABLE',
      before: 'original\n', after: 'replacement\n' }]);
    const rows = await sql<{ relative_path: string }>`select relative_path from file_write_frozen_diffs
      where operation_id=${op}`.execute(app.db);
    assert.deepEqual(rows.rows.map((row) => row.relative_path),
      [process.platform === 'win32' ? 'nested/note.txt' : 'note.txt']);
  } finally { await api.stop(); }
});

test('M06 Windows nested WRITE_FILE keeps its diff and ledger under the managed root',
  { skip: process.platform !== 'win32' }, async () => {
    const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'WRITE_FILE' });
    const target = join(f.root, 'nested', 'note.txt');
    await mkdir(dirname(target));
    await writeFile(target, 'original\n');
    const op = randomUUID();
    const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
      intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin: await claim(f),
      actionType: 'WRITE_FILE', target,
      params: { content: 'replacement\n', baseline_sha256: sha256('original\n') } });
    const next = await approveAndReclaim(f, op, prepared.review_id!);
    const dispatched = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
      operationId: op, origin: next });
    assert.equal(dispatched.status, 'SUCCEEDED');
    assert.equal(await readFile(target, 'utf8'), 'replacement\n');
    const { invocationId } = await soleInvocation(f.workspaceId, op);
    const ledger = await readLedger(invocationId);
    assert.ok(ledger);
    assert.equal(ledger.cs.canonical_root, f.root);
    assert.equal(ledger.files[0]?.relative_path, 'nested/note.txt');
    const api = await startTestApi();
    try {
      const response = await api.get(`/api/v1/workspaces/${f.workspaceId}/operations/${op}/file-write-diff`);
      assert.equal(response.status, 200, response.text);
      assert.equal((response.body as { files: Array<{ relative_path: string }> }).files[0]?.relative_path,
        ledger.files[0]?.relative_path);
    } finally { await api.stop(); }
  });

test('M06 direct APPLY_CHANGESET bounds frozen baseline capture to 16 files', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  const op = randomUUID();
  await assert.rejects(prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin: await claim(f),
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: Array.from({ length: 17 }, (_, index) => ({
      path: `file-${index}.txt`, action: 'CREATE', content: 'new\n',
    })) } }), (error: unknown) => code(error) === 'VALIDATION_FAILED');
  const count = await sql<{ count: number }>`select count(*)::integer as count from logical_operations
    where id=${op}`.execute(app.db);
  assert.equal(count.rows[0]?.count, 0);
});

test('M06 FILE_WRITE APPLY_CHANGESET forces ASK, then writes real files after approval', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  const origin = await claim(f);
  const content = 'hello relay\n';
  const changes = [{ path: 'src/./a.txt', action: 'CREATE', content, targetSha256: sha256(content) }];
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root, params: { changes } });
  assert.equal(prepared.status, 'WAITING_APPROVAL', 'FILE_WRITE is not approval-passthrough; AUTO must downgrade to ASK');
  assert.equal(prepared.invocation_id, null);
  assert.ok(prepared.review_id);

  const next = await approveAndReclaim(f, op, prepared.review_id!);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next });
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(await readFile(join(f.root, 'src', 'a.txt'), 'utf8'), content, 'the real file must exist with the exact content');
  const ref = result.result_ref as { changes: Array<{ status: string; targetSha256?: string }> };
  assert.equal(ref.changes[0]?.status, 'APPLIED');
  assert.equal(ref.changes[0]?.targetSha256, sha256(content), 'result records the applied target hash');

  // M06 增量A：成功执行后应固化一份不可变账本，逐文件哈希与真实落地一致。
  const { invocationId } = await soleInvocation(f.workspaceId, op);
  const ledger = await readLedger(invocationId);
  assert.ok(ledger, 'FILE_WRITE must persist a change_set ledger on settle');
  assert.equal(ledger.cs.status, 'SUCCEEDED');
  assert.equal(ledger.cs.operation_id, op);
  assert.equal(ledger.files.length, 1);
  assert.equal(ledger.files[0]?.relative_path, 'src/a.txt');
  assert.equal(ledger.files[0]?.action, 'CREATE');
  assert.equal(ledger.files[0]?.baseline_sha256, null, 'CREATE has no frozen baseline');
  assert.equal(ledger.files[0]?.target_sha256, sha256(content));
  assert.equal(ledger.files[0]?.actual_sha256, sha256(content));
  assert.equal(ledger.files[0]?.status, 'APPLIED');
  assert.equal(await withTransaction(app.db, (r) => r.changeSets.countByInvocation(invocationId)), 1,
    'one settled invocation persists exactly one ledger');

  // A second dispatch on the settled operation must be rejected (no blind re-run).
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next }),
    (error: unknown) => code(error) === 'GATEWAY_OPERATION_SETTLED');
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId: next.workerId, workerEpoch: next.workerEpoch });
});

test('M06 FILE_WRITE baseline hash conflict leaves the existing file untouched', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  await writeFile(join(f.root, 'notes.md'), 'original\n', 'utf8');
  const origin = await claim(f);
  const changes = [{ path: 'notes.md', action: 'MODIFY', baselineSha256: sha256('a different baseline'), content: 'overwrite\n' }];
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root, params: { changes } });
  const api = await startTestApi();
  try {
    const pending = await api.get(`/api/v1/workspaces/${f.workspaceId}/operations/${op}/change-sets`);
    assert.equal(pending.status, 200, pending.text);
    assert.deepEqual((pending.body as { change_sets: unknown[] }).change_sets, [],
      'approval before dispatch must not invent an execution ledger');
  } finally { await api.stop(); }
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next });
  assert.equal(result.status, 'FAILED', 'a stale baseline is a conflict, not a silent overwrite');
  assert.equal(await readFile(join(f.root, 'notes.md'), 'utf8'), 'original\n', 'conflict must not touch the real file');
  const conflict = (result.result_ref as { changes?: Array<{ status: string }> }).changes?.[0];
  assert.equal(conflict?.status, 'CONFLICT');
  // M06 增量A：部分成功固化为 PARTIAL 账本，冲突文件的实际摘要记录为磁盘原值（未被覆盖）。
  const { invocationId } = await soleInvocation(f.workspaceId, op);
  const ledger = await readLedger(invocationId);
  assert.ok(ledger, 'a conflicted changeset still persists a ledger for evidence');
  assert.equal(ledger.cs.status, 'PARTIAL');
  assert.equal(ledger.files.length, 1);
  assert.equal(ledger.files[0]?.relative_path, 'notes.md');
  assert.equal(ledger.files[0]?.action, 'MODIFY');
  assert.equal(ledger.files[0]?.status, 'CONFLICT');
  assert.equal(ledger.files[0]?.actual_sha256, sha256('original\n'), 'ledger records the untouched on-disk hash');
  assert.equal(ledger.files[0]?.target_sha256, sha256('overwrite\n'));
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId: next.workerId, workerEpoch: next.workerEpoch });
});

test('M06 missing MODIFY parent leaves no directory before a no-effect FAILED settlement', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  const absentDir = join(f.root, 'new-dir');
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin: await claim(f),
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: [{ path: 'new-dir/missing.txt', action: 'MODIFY',
      baselineSha256: sha256('old\n'), content: 'replacement\n' }] } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next });
  assert.equal(result.status, 'FAILED');
  assert.equal((result.result_ref as { changes?: Array<{ status: string }> }).changes?.[0]?.status, 'CONFLICT');
  await assert.rejects(stat(absentDir), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    'no-effect settlement must not leave an empty parent directory');
});

test('M06 DELETE conflict ledger preserves the observed existing content digest', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  await writeFile(join(f.root, 'keep.txt'), 'still here\n', 'utf8');
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: [{ path: 'keep.txt', action: 'DELETE', baselineSha256: sha256('wrong\n') }] } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next });
  assert.equal(result.status, 'FAILED');
  assert.equal(await readFile(join(f.root, 'keep.txt'), 'utf8'), 'still here\n');
  const { invocationId } = await soleInvocation(f.workspaceId, op);
  const ledger = await readLedger(invocationId);
  assert.ok(ledger);
  assert.equal(ledger.files[0]?.status, 'CONFLICT');
  assert.equal(ledger.files[0]?.actual_sha256, sha256('still here\n'));
});

test('M06 FILE_WRITE rejects protected paths and root-escape at prepare', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  const origin = await claim(f);
  for (const bad of ['.env', '.git/config', '../outside.txt', '../../etc/passwd']) {
    await assert.rejects(prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: randomUUID(),
      intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
      actionType: 'APPLY_CHANGESET', target: f.root, params: { changes: [{ path: bad, action: 'CREATE', content: 'x' }] } }),
    (error: unknown) => code(error) === 'GATEWAY_TARGET_DENIED', `path ${bad} must be denied`);
  }
});

test('M06 Windows FILE_WRITE rejects unsafe path segments before approval',
  { skip: process.platform !== 'win32' }, async () => {
    const changeset = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE',
      actionType: 'APPLY_CHANGESET' });
    const changesetOrigin = await claim(changeset);
    for (const path of ['src/config.txt:secret', 'src/COM¹.txt', 'src/file.',
      'src/bad?.txt', 'src/bad\u0001.txt']) {
      await assert.rejects(prepareGatewayAction(app.db, { workspaceId: changeset.workspaceId,
        operationId: randomUUID(), intentKey: `intent-${randomUUID()}`,
        connectionId: changeset.connectionId, origin: changesetOrigin,
        actionType: 'APPLY_CHANGESET', target: changeset.root,
        params: { changes: [{ path, action: 'CREATE', content: 'x' }] } }),
      (error: unknown) => code(error) === 'GATEWAY_TARGET_DENIED', `changeset: ${path}`);
    }
    const single = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE',
      actionType: 'WRITE_FILE' });
    const singleOrigin = await claim(single);
    for (const path of ['payload.txt:secret', 'bad?.txt', 'bad\u0000.txt', 'missing./payload.txt']) {
      await assert.rejects(prepareGatewayAction(app.db, { workspaceId: single.workspaceId,
        operationId: randomUUID(), intentKey: `intent-${randomUUID()}`,
        connectionId: single.connectionId, origin: singleOrigin,
        actionType: 'WRITE_FILE', target: join(single.root, path),
        params: { content: 'x' } }),
      (error: unknown) => code(error) === 'GATEWAY_TARGET_DENIED', `WRITE_FILE: ${path}`);
    }
  });

test('M06 FILE_WRITE rejects a false target digest before approval or disk writes', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  const origin = await claim(f);
  await assert.rejects(prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: randomUUID(),
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: [{ path: 'digest.txt', action: 'CREATE', content: 'real\n', targetSha256: sha256('fake\n') }] } }),
  (error: unknown) => code(error) === 'VALIDATION_FAILED');
  await assert.rejects(readFile(join(f.root, 'digest.txt')),
    (error: unknown) => code(error) === 'ENOENT');
});

test('M06 FILE_WRITE requires explicit content for CREATE and MODIFY at prepare', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  await writeFile(join(f.root, 'existing.txt'), 'original\n', 'utf8');
  const origin = await claim(f);
  for (const change of [
    { path: 'new.txt', action: 'CREATE' },
    { path: 'existing.txt', action: 'MODIFY', baselineSha256: sha256('original\n') },
  ]) {
    await assert.rejects(prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: randomUUID(),
      intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
      actionType: 'APPLY_CHANGESET', target: f.root, params: { changes: [change] } }),
    (error: unknown) => code(error) === 'VALIDATION_FAILED', `${change.action} requires explicit content`);
  }
  assert.equal(await readFile(join(f.root, 'existing.txt'), 'utf8'), 'original\n');
  await assert.rejects(readFile(join(f.root, 'new.txt')), (error: unknown) => code(error) === 'ENOENT');
});

test('M06 FILE_WRITE rejects equivalent paths and overlong UTF-8 ledger paths at prepare', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET',
    maxPayloadBytes: 8192 });
  const origin = await claim(f);
  for (const paths of [['src/a.txt', 'src/./a.txt'], ['src/a.txt', 'src/../src/a.txt'],
    ...(process.platform === 'win32' ? [['Case.txt', 'case.txt']] : [])]) {
    await assert.rejects(prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: randomUUID(),
      intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
      actionType: 'APPLY_CHANGESET', target: f.root,
      params: { changes: paths.map((path) => ({ path, action: 'CREATE', content: 'x' })) } }),
    (error: unknown) => code(error) === 'VALIDATION_FAILED', `duplicate paths ${paths.join(', ')}`);
  }
  const longPath = [...Array(11)].map(() => '界'.repeat(32)).join('/') + '/a.txt';
  assert.ok(Buffer.byteLength(longPath, 'utf8') > 1024);
  await assert.rejects(prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: randomUUID(),
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: [{ path: longPath, action: 'CREATE', content: 'x' }] } }),
  (error: unknown) => code(error) === 'VALIDATION_FAILED');
  await assert.rejects(readFile(join(f.root, longPath)), (error: unknown) => code(error) === 'ENOENT');
});

test('M06 FILE_WRITE DELETE reconciliation keeps UNKNOWN when the path becomes a directory', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  await writeFile(join(f.root, 'gone.txt'), 'old\n', 'utf8');
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: [{ path: 'gone.txt', action: 'DELETE', baselineSha256: sha256('old\n') }] } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
    hooks: { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('after delete'); } } }), SimulatedGatewayCrash);
  await mkdir(join(f.root, 'gone.txt'));
  const { invocationId } = await soleInvocation(f.workspaceId, op);
  const result = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId, operationId: op,
    invocationId, oldProcessStopped: true, stoppedWorkerId: next.workerId, stoppedWorkerEpoch: next.workerEpoch });
  assert.equal(result.status, 'UNKNOWN');
  const ledger = await readLedger(invocationId);
  assert.ok(ledger);
  assert.equal(ledger.cs.status, 'UNKNOWN');
  assert.notEqual(ledger.files[0]?.status, 'APPLIED');
});

test('M06 FILE_WRITE crash after write reconciles SUCCEEDED; tampering reconciles UNKNOWN and blocks re-claim', async () => {
  // (A) Crash after the physical write: the exact content is present, so reconcile confirms SUCCEEDED.
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  const origin = await claim(f);
  const content = 'durable\n';
  const changes = [{ path: 'keep.txt', action: 'CREATE', content, targetSha256: sha256(content) }];
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root, params: { changes } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
    hooks: { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('after write'); } } }), SimulatedGatewayCrash);
  const stuck = await soleInvocation(f.workspaceId, op);
  assert.equal(stuck.status, 'DISPATCHING');
  const receipt = (await readGatewayOperation(app.db, f.workspaceId, op)).invocations[0]?.result_ref;
  assert.equal((receipt?.file_write_receipt as { operation_id?: string } | undefined)?.operation_id, op,
    'adapter returned before the crash, so its original invocation must have a durable receipt');
  const overwritten = await withTransaction(app.db, (repositories) => repositories.gateway.stageFileWriteReceipt(
    stuck.invocationId, op, { kind: 'FILE_WRITE_ADAPTER_V1', operation_id: randomUUID() }));
  assert.equal(overwritten, undefined, 'the original adapter receipt cannot be replaced');
  const okReconcile = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId, operationId: op,
    invocationId: stuck.invocationId, oldProcessStopped: true, stoppedWorkerId: next.workerId, stoppedWorkerEpoch: next.workerEpoch });
  assert.equal(okReconcile.status, 'SUCCEEDED', 'present content matching the target hash reconciles as done');
  assert.equal(await readFile(join(f.root, 'keep.txt'), 'utf8'), content);
  // M06 增量A：崩溃后由核对固化账本（结算未落账），全匹配=SUCCEEDED 且唯一一份。
  const ledgerA = await readLedger(stuck.invocationId);
  assert.ok(ledgerA, 'reconcile to SUCCEEDED must persist a ledger');
  assert.equal(ledgerA.cs.status, 'SUCCEEDED');
  assert.equal(ledgerA.files.length, 1);
  assert.equal(ledgerA.files[0]?.relative_path, 'keep.txt');
  assert.equal(ledgerA.files[0]?.status, 'APPLIED');
  assert.equal(ledgerA.files[0]?.target_sha256, sha256(content));
  assert.equal(ledgerA.files[0]?.actual_sha256, sha256(content));
  assert.equal(await withTransaction(app.db, (r) => r.changeSets.countByInvocation(stuck.invocationId)), 1,
    'crash-then-reconcile persists exactly one ledger');

  // (B) Tamper after crash: content no longer matches, so reconcile stays UNKNOWN and the Run cannot be re-claimed.
  const g = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  const go = await claim(g);
  const gchanges = [{ path: 'fragile.txt', action: 'CREATE', content: 'expected\n', targetSha256: sha256('expected\n') }];
  const gop = randomUUID();
  const gprepared = await prepareGatewayAction(app.db, { workspaceId: g.workspaceId, operationId: gop,
    intentKey: `intent-${randomUUID()}`, connectionId: g.connectionId, origin: go,
    actionType: 'APPLY_CHANGESET', target: g.root, params: { changes: gchanges } });
  const gnext = await approveAndReclaim(g, gop, gprepared.review_id!);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: g.workspaceId, operationId: gop, origin: gnext,
    hooks: { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('after write'); } } }), SimulatedGatewayCrash);
  await writeFile(join(g.root, 'fragile.txt'), 'hijacked\n', 'utf8');
  const gInvocation = (await soleInvocation(g.workspaceId, gop)).invocationId;
  const unknown = await reconcileGatewayInvocation(app.db, { workspaceId: g.workspaceId, operationId: gop,
    invocationId: gInvocation, oldProcessStopped: true, stoppedWorkerId: gnext.workerId, stoppedWorkerEpoch: gnext.workerEpoch });
  assert.equal(unknown.status, 'UNKNOWN', 'a mismatched partial write cannot be reported as success');
  // M06 增量A：篡改后核对不固化成功，账本记为 UNKNOWN 且唯一一份，供证据链追溯。
  const gInvocationRow = await soleInvocation(g.workspaceId, gop);
  const ledgerB = await readLedger(gInvocationRow.invocationId);
  assert.ok(ledgerB, 'reconcile to UNKNOWN must persist a ledger');
  assert.equal(ledgerB.cs.status, 'UNKNOWN');
  assert.equal(await withTransaction(app.db, (r) => r.changeSets.countByInvocation(gInvocationRow.invocationId)), 1);
  await assert.rejects(claimRunForGateway(app.db, { workspaceId: g.workspaceId, runId: g.runId, workerId: `worker-${randomUUID()}` }),
    (error: unknown) => code(error) === 'GATEWAY_OPERATION_UNRESOLVED');
});

test('M06 FILE_WRITE does not attribute an existing CREATE target to an uncalled adapter', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  await writeFile(join(f.root, 'preexisting.txt'), 'expected\n');
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: [{ path: 'preexisting.txt', action: 'CREATE', content: 'expected\n' }] } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
    hooks: { afterAdmit: async () => { throw new SimulatedGatewayCrash('before adapter call'); } } }), SimulatedGatewayCrash);
  const stuck = await soleInvocation(f.workspaceId, op);
  const result = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId, operationId: op,
    invocationId: stuck.invocationId, oldProcessStopped: true,
    stoppedWorkerId: next.workerId, stoppedWorkerEpoch: next.workerEpoch });
  assert.equal(result.status, 'UNKNOWN');
  const ledger = await readLedger(stuck.invocationId);
  assert.ok(ledger);
  assert.equal(ledger.cs.status, 'UNKNOWN');
  assert.notEqual(ledger.files[0]?.status, 'APPLIED');
});

test('M06 FILE_WRITE does not attribute an external afterAdmit write to the adapter', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: [{ path: 'external.txt', action: 'CREATE', content: 'expected\n' }] } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
    hooks: { afterAdmit: async () => {
      await writeFile(join(f.root, 'external.txt'), 'expected\n');
      throw new SimulatedGatewayCrash('external actor wrote before adapter call');
    } } }), SimulatedGatewayCrash);
  const stuck = await soleInvocation(f.workspaceId, op);
  const result = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId, operationId: op,
    invocationId: stuck.invocationId, oldProcessStopped: true,
    stoppedWorkerId: next.workerId, stoppedWorkerEpoch: next.workerEpoch });
  assert.equal(result.status, 'UNKNOWN');
  const ledger = await readLedger(stuck.invocationId);
  assert.ok(ledger);
  assert.notEqual(ledger.files[0]?.status, 'APPLIED');
});

test('M06 FILE_WRITE partial adapter receipt cannot be upgraded by a later matching disk state', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  await writeFile(join(f.root, 'conflict.txt'), 'original\n');
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: [
      { path: 'applied.txt', action: 'CREATE', content: 'applied\n' },
      { path: 'conflict.txt', action: 'MODIFY', baselineSha256: sha256('wrong\n'), content: 'target\n' },
    ] } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
    hooks: { afterFakeEffect: async () => {
      await writeFile(join(f.root, 'conflict.txt'), 'target\n');
      throw new SimulatedGatewayCrash('outside actor matched the failed target');
    } } }), SimulatedGatewayCrash);
  const stuck = await soleInvocation(f.workspaceId, op);
  const result = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId, operationId: op,
    invocationId: stuck.invocationId, oldProcessStopped: true,
    stoppedWorkerId: next.workerId, stoppedWorkerEpoch: next.workerEpoch });
  assert.equal(result.status, 'UNKNOWN');
  const ledger = await readLedger(stuck.invocationId);
  assert.ok(ledger);
  assert.equal(ledger.cs.status, 'UNKNOWN');
  const byPath = new Map(ledger.files.map((row) => [row.relative_path, row]));
  assert.equal(byPath.get('applied.txt')?.status, 'APPLIED', 'the receipt and disk both prove this one file');
  assert.notEqual(byPath.get('conflict.txt')?.status, 'APPLIED', 'an external write cannot repair the failed adapter result');
});

test('M06 FILE_WRITE crash after a partial adapter receipt preserves a PARTIAL ledger', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  await writeFile(join(f.root, 'conflict.txt'), 'external change\n');
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: [
      { path: 'applied.txt', action: 'CREATE', content: 'applied\n' },
      { path: 'conflict.txt', action: 'MODIFY', baselineSha256: sha256('original\n'), content: 'target\n' },
    ] } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
    hooks: { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('after partial receipt'); } } }),
  SimulatedGatewayCrash);
  const stuck = await soleInvocation(f.workspaceId, op);
  assert.equal(await readLedger(stuck.invocationId), undefined);
  const result = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId, operationId: op,
    invocationId: stuck.invocationId, oldProcessStopped: true,
    stoppedWorkerId: next.workerId, stoppedWorkerEpoch: next.workerEpoch });
  assert.equal(result.status, 'UNKNOWN');
  const ledger = await readLedger(stuck.invocationId);
  assert.ok(ledger);
  assert.equal(ledger.cs.status, 'PARTIAL');
  const byPath = new Map(ledger.files.map((row) => [row.relative_path, row]));
  assert.equal(byPath.get('applied.txt')?.status, 'APPLIED');
  assert.equal(byPath.get('conflict.txt')?.status, 'CONFLICT');
  assert.equal((await soleInvocation(f.workspaceId, op)).invocationId, stuck.invocationId);
});

test('M06 FILE_WRITE recovery preserves a missing DELETE as CONFLICT in a PARTIAL ledger', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: [
      { path: 'applied.txt', action: 'CREATE', content: 'applied\n' },
      { path: 'missing.txt', action: 'DELETE', baselineSha256: sha256('original\n') },
    ] } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
    hooks: { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('after partial receipt'); } } }),
  SimulatedGatewayCrash);
  const stuck = await soleInvocation(f.workspaceId, op);
  const result = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId, operationId: op,
    invocationId: stuck.invocationId, oldProcessStopped: true,
    stoppedWorkerId: next.workerId, stoppedWorkerEpoch: next.workerEpoch });
  assert.equal(result.status, 'UNKNOWN');
  const ledger = await readLedger(stuck.invocationId);
  assert.ok(ledger);
  assert.equal(ledger.cs.status, 'PARTIAL');
  const byPath = new Map(ledger.files.map((row) => [row.relative_path, row]));
  assert.equal(byPath.get('applied.txt')?.status, 'APPLIED');
  assert.equal(byPath.get('missing.txt')?.status, 'CONFLICT');
  assert.equal(byPath.get('missing.txt')?.actual_sha256, null);
  assert.equal((await soleInvocation(f.workspaceId, op)).invocationId, stuck.invocationId);
});

test('M06 FILE_WRITE rejects a receipt whose file report disagrees with frozen input', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  await writeFile(join(f.root, 'forged.txt'), 'expected\n');
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: [{ path: 'forged.txt', action: 'CREATE', content: 'expected\n' }] } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
    hooks: { afterAdmit: async () => { throw new SimulatedGatewayCrash('before adapter call'); } } }), SimulatedGatewayCrash);
  const stuck = await soleInvocation(f.workspaceId, op);
  const staged = await withTransaction(app.db, (repositories) => repositories.gateway.stageFileWriteReceipt(
    stuck.invocationId, op, { kind: 'FILE_WRITE_ADAPTER_V1', operation_id: op,
      invocation_id: stuck.invocationId, outcome: 'SUCCEEDED', result: {
        operation_id: op, invocation_id: stuck.invocationId,
        changes: [{ path: 'forged.txt', action: 'CREATE', status: 'APPLIED',
          targetSha256: sha256('different\n') }],
      } }));
  assert.ok(staged, 'the test installs a malformed receipt under the original invocation');
  const result = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId, operationId: op,
    invocationId: stuck.invocationId, oldProcessStopped: true,
    stoppedWorkerId: next.workerId, stoppedWorkerEpoch: next.workerEpoch });
  assert.equal(result.status, 'UNKNOWN');
  const ledger = await readLedger(stuck.invocationId);
  assert.ok(ledger);
  assert.notEqual(ledger.files[0]?.status, 'APPLIED');
});

test('M06 FILE_WRITE receipt cannot confirm a target after its frozen root is redirected', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: [{ path: 'payload.txt', action: 'CREATE', content: 'expected\n' }] } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
    hooks: { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('after adapter receipt'); } } }), SimulatedGatewayCrash);
  const outside = join(dataRoot, `m06-outside-${randomUUID()}`);
  await mkdir(outside);
  await writeFile(join(outside, 'payload.txt'), 'expected\n');
  await rename(f.root, `${f.root}-old`);
  await symlink(outside, f.root, 'junction');
  const stuck = await soleInvocation(f.workspaceId, op);
  const result = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId, operationId: op,
    invocationId: stuck.invocationId, oldProcessStopped: true,
    stoppedWorkerId: next.workerId, stoppedWorkerEpoch: next.workerEpoch });
  assert.equal(result.status, 'UNKNOWN');
  const ledger = await readLedger(stuck.invocationId);
  assert.ok(ledger);
  assert.notEqual(ledger.files[0]?.status, 'APPLIED');
});

test('M06 FILE_WRITE refuses a managed root replaced by a junction before dispatch', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: [{ path: 'payload.txt', action: 'CREATE', content: 'expected\n' }] } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  const outside = join(dataRoot, `m06-outside-${randomUUID()}`);
  await mkdir(outside);
  await rename(f.root, `${f.root}-old`);
  await symlink(outside, f.root, 'junction');
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next });
  assert.equal(result.status, 'FAILED');
  await assert.rejects(readFile(join(outside, 'payload.txt')), (error: unknown) => code(error) === 'ENOENT');
});

test('M06 Windows FILE_WRITE refuses an ordinary root replaced after resource registration',
  { skip: process.platform !== 'win32' }, async () => {
    const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE',
      actionType: 'APPLY_CHANGESET' });
    const registered = await sql<{ file_write_root_id: string | null }>`
      select file_write_root_id from managed_resources where id = ${f.resourceId}
    `.execute(app.db);
    assert.match(registered.rows[0]?.file_write_root_id ?? '', /^[0-9a-f]{16}:[0-9a-f]{32}$/);
    await rename(f.root, `${f.root}-registered`);
    await mkdir(f.root);
    const origin = await claim(f);
    const operationId = randomUUID();
    await assert.rejects(prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
      operationId, intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId,
      origin, actionType: 'APPLY_CHANGESET', target: f.root,
      params: { changes: [{ path: 'payload.txt', action: 'CREATE', content: 'forbidden\n' }] } }),
    (error: unknown) => code(error) === 'GATEWAY_RESOURCE_ROOT_CHANGED');
    const operations = await sql<{ count: bigint }>`
      select count(*)::bigint as count from logical_operations where id = ${operationId}
    `.execute(app.db);
    assert.equal(operations.rows[0]?.count, 0n);
    await assert.rejects(readFile(join(f.root, 'payload.txt')),
      (error: unknown) => code(error) === 'ENOENT');
  });

test('M06 Windows FILE_WRITE requires explicit re-registration of a legacy resource',
  { skip: process.platform !== 'win32' }, async () => {
    const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE',
      actionType: 'APPLY_CHANGESET' });
    await assert.rejects(sql`
      update managed_resources set file_write_root_id = null where id = ${f.resourceId}
    `.execute(app.db), (error: unknown) => code(error) === '42501');
    const migrator = openDatabase(MIGRATION_DATABASE_URL, 'relay-m06-legacy-root-fixture');
    try {
      await sql`update managed_resources set file_write_root_id = null
        where id = ${f.resourceId}`.execute(migrator.db);
    } finally { await migrator.close(); }
    const origin = await claim(f);
    const operationId = randomUUID();
    await assert.rejects(prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
      operationId, intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId,
      origin, actionType: 'APPLY_CHANGESET', target: f.root,
      params: { changes: [{ path: 'payload.txt', action: 'CREATE', content: 'forbidden\n' }] } }),
    (error: unknown) => code(error) === 'GATEWAY_RESOURCE_IDENTITY_REQUIRED');
  });

test('M06 disabled legacy resource can be re-registered with a new physical identity',
  { skip: process.platform !== 'win32' }, async () => {
    const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE',
      actionType: 'APPLY_CHANGESET' });
    const migrator = openDatabase(MIGRATION_DATABASE_URL, 'relay-m06-legacy-reregistration');
    try {
      await sql`update managed_resources set file_write_root_id = null
        where id = ${f.resourceId}`.execute(migrator.db);
    } finally { await migrator.close(); }
    await disableManagedResource(app.db, { workspaceId: f.workspaceId, resourceId: f.resourceId });
    const renewed = await registerManagedResource(app.db, { workspaceId: f.workspaceId,
      projectId: f.projectId, rootPath: f.root });
    assert.notEqual(renewed.resourceId, f.resourceId);
    assert.equal(renewed.canonicalRoot, f.root);
    const rows = await sql<{ id: string; status: string; file_write_root_id: string | null }>`
      select id, status, file_write_root_id from managed_resources
      where project_id = ${f.projectId} and canonical_root = ${f.root} order by created_at, id
    `.execute(app.db);
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows.find((row) => row.id === f.resourceId)?.status, 'DISABLED');
    assert.equal(rows.rows.find((row) => row.id === f.resourceId)?.file_write_root_id, null);
    assert.equal(rows.rows.find((row) => row.id === renewed.resourceId)?.status, 'ACTIVE');
    assert.match(rows.rows.find((row) => row.id === renewed.resourceId)?.file_write_root_id ?? '',
      /^[0-9a-f]{16}:[0-9a-f]{32}$/);
  });

test('M06 Windows FILE_WRITE refuses a replaced ordinary parent with the same path',
  { skip: process.platform !== 'win32' }, async () => {
    const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
    await mkdir(join(f.root, 'nested'));
    const origin = await claim(f);
    const op = randomUUID();
    const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
      intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
      actionType: 'APPLY_CHANGESET', target: f.root,
      params: { changes: [{ path: 'nested/payload.txt', action: 'CREATE', content: 'expected\n' }] } });
    const next = await approveAndReclaim(f, op, prepared.review_id!);
    await rename(join(f.root, 'nested'), join(f.root, 'old-nested'));
    await mkdir(join(f.root, 'nested'));
    const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next });
    assert.equal(result.status, 'FAILED');
    await assert.rejects(readFile(join(f.root, 'nested', 'payload.txt')),
      (error: unknown) => code(error) === 'ENOENT');
    await assert.rejects(readFile(join(f.root, 'old-nested', 'payload.txt')),
      (error: unknown) => code(error) === 'ENOENT');
  });

test('M06 Windows FILE_WRITE refuses a same-content target with a different file identity',
  { skip: process.platform !== 'win32' }, async () => {
    const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
    await writeFile(join(f.root, 'payload.txt'), 'original\n');
    const origin = await claim(f);
    const op = randomUUID();
    const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
      intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
      actionType: 'APPLY_CHANGESET', target: f.root,
      params: { changes: [{ path: 'payload.txt', action: 'MODIFY',
        baselineSha256: sha256('original\n'), content: 'updated\n' }] } });
    const next = await approveAndReclaim(f, op, prepared.review_id!);
    await rename(join(f.root, 'payload.txt'), join(f.root, 'old-payload.txt'));
    await writeFile(join(f.root, 'payload.txt'), 'original\n');
    const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next });
    assert.equal(result.status, 'FAILED');
    assert.equal(await readFile(join(f.root, 'payload.txt'), 'utf8'), 'original\n');
    assert.equal(await readFile(join(f.root, 'old-payload.txt'), 'utf8'), 'original\n');
  });

test('M06 Windows FILE_WRITE recovery refuses a same-content replacement after execution',
  { skip: process.platform !== 'win32' }, async () => {
    const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
    const origin = await claim(f);
    const op = randomUUID();
    const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
      intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
      actionType: 'APPLY_CHANGESET', target: f.root,
      params: { changes: [{ path: 'payload.txt', action: 'CREATE', content: 'expected\n' }] } });
    const next = await approveAndReclaim(f, op, prepared.review_id!);
    await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
      hooks: { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('after adapter receipt'); } } }),
    SimulatedGatewayCrash);
    await rename(join(f.root, 'payload.txt'), join(f.root, 'old-payload.txt'));
    await writeFile(join(f.root, 'payload.txt'), 'expected\n');
    const { invocationId } = await soleInvocation(f.workspaceId, op);
    const result = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId, operationId: op,
      invocationId, oldProcessStopped: true,
      stoppedWorkerId: next.workerId, stoppedWorkerEpoch: next.workerEpoch });
    assert.equal(result.status, 'UNKNOWN');
    const ledger = await readLedger(invocationId);
    assert.ok(ledger);
    assert.notEqual(ledger.files[0]?.status, 'APPLIED');
  });

test('M06 FILE_WRITE recovery refuses matching content behind a parent junction', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: [{ path: 'nested/payload.txt', action: 'CREATE', content: 'expected\n' }] } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
    hooks: { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('after real write'); } } }), SimulatedGatewayCrash);
  const outside = join(dataRoot, `m06-outside-${randomUUID()}`);
  await mkdir(outside);
  await writeFile(join(outside, 'payload.txt'), 'expected\n');
  await rename(join(f.root, 'nested'), join(f.root, 'old-nested'));
  await symlink(outside, join(f.root, 'nested'), 'junction');
  const { invocationId } = await soleInvocation(f.workspaceId, op);
  const result = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId, operationId: op,
    invocationId, oldProcessStopped: true, stoppedWorkerId: next.workerId, stoppedWorkerEpoch: next.workerEpoch });
  assert.equal(result.status, 'UNKNOWN');
  const ledger = await readLedger(invocationId);
  assert.ok(ledger);
  assert.equal(ledger.cs.status, 'UNKNOWN');
  assert.notEqual(ledger.files[0]?.status, 'APPLIED');
});

// ---------------------------------------------------------------------------
// M06 增量A：多文件部分成功的账本按路径逐条固化，冲突项不覆盖
// ---------------------------------------------------------------------------
test('M06 change_set ledger records per-file PARTIAL for a multi-file changeset with one conflict', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  await writeFile(join(f.root, 'stale.txt'), 'original\n', 'utf8');
  const origin = await claim(f);
  const created = 'created\n';
  const changes = [
    { path: 'new.txt', action: 'CREATE', content: created, targetSha256: sha256(created) },
    { path: 'stale.txt', action: 'MODIFY', baselineSha256: sha256('wrong-baseline'), content: 'overwrite\n' },
  ];
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root, params: { changes } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next });
  assert.equal(result.status, 'UNKNOWN', 'a partially applied write stays on the original unresolved action');
  assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), created, 'the non-conflicting file still lands');
  assert.equal(await readFile(join(f.root, 'stale.txt'), 'utf8'), 'original\n', 'the conflicting file is untouched');
  const { invocationId } = await soleInvocation(f.workspaceId, op);
  const ledger = await readLedger(invocationId);
  assert.ok(ledger);
  assert.equal(ledger.cs.status, 'PARTIAL', 'mixed APPLIED + CONFLICT is a partial ledger');
  assert.equal(ledger.files.length, 2);
  const byPath = new Map(ledger.files.map((row) => [row.relative_path, row]));
  assert.equal(byPath.get('new.txt')?.status, 'APPLIED');
  assert.equal(byPath.get('new.txt')?.actual_sha256, sha256(created));
  assert.equal(byPath.get('new.txt')?.target_sha256, sha256(created));
  assert.equal(byPath.get('stale.txt')?.status, 'CONFLICT');
  assert.equal(byPath.get('stale.txt')?.actual_sha256, sha256('original\n'));
  assert.equal(byPath.get('stale.txt')?.target_sha256, sha256('overwrite\n'));
  const ledgerApi = await startTestApi();
  try {
    const path = `/api/v1/workspaces/${f.workspaceId}/operations/${op}/change-sets`;
    const response = await ledgerApi.get(path);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.headers['cache-control'], 'no-store');
    const published = response.body as { operation_id: string; change_sets: Array<{
      invocation_id: string; status: string; evidence_source: string; files: Array<{
        relative_path: string; status: string; actual_sha256: string | null;
      }> }> };
    assert.equal(published.operation_id, op);
    assert.equal(published.change_sets.length, 1);
    assert.equal(published.change_sets[0]?.invocation_id, invocationId);
    assert.equal(published.change_sets[0]?.status, 'PARTIAL');
    assert.equal(published.change_sets[0]?.evidence_source, 'EXECUTION');
    assert.deepEqual(published.change_sets[0]?.files.map((file) =>
      [file.relative_path, file.status, file.actual_sha256]), [
      ['new.txt', 'APPLIED', sha256(created)],
      ['stale.txt', 'CONFLICT', sha256('original\n')],
    ]);
    assert.equal(response.text.includes(JSON.stringify(created).slice(1, -1)), false,
      'ledger read must not publish escaped file content');
    const outside = await ledgerApi.get(`/api/v1/workspaces/${randomUUID()}/operations/${op}/change-sets`);
    assert.equal(outside.status, 404, 'another workspace cannot read operation evidence');
  } finally { await ledgerApi.stop(); }
  await assert.rejects(releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    workerId: next.workerId, workerEpoch: next.workerEpoch }),
  (error: unknown) => code(error) === 'GATEWAY_OPERATION_UNRESOLVED');
  const reconciled = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId,
    operationId: op, invocationId, stoppedWorkerId: next.workerId,
    stoppedWorkerEpoch: next.workerEpoch, oldProcessStopped: true });
  assert.equal(reconciled.status, 'UNKNOWN');
  assert.equal((await readLedger(invocationId))?.cs.status, 'PARTIAL',
    'a later observation cannot erase the immutable execution summary');
});

// ---------------------------------------------------------------------------
// M06 增量A：全成功的多文件变化集逐条固化为不可变证据，且按 invocation 幂等
// ---------------------------------------------------------------------------
test('M06 change_set ledger binds real per-file facts to the invocation and cannot be rewritten', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  await writeFile(join(f.root, 'mod.txt'), 'before\n', 'utf8');
  await writeFile(join(f.root, 'del.txt'), 'gone\n', 'utf8');
  const origin = await claim(f);
  const created = 'fresh\n';
  const updated = 'after\n';
  const changes = [
    { path: 'add.txt', action: 'CREATE', content: created, targetSha256: sha256(created) },
    { path: 'mod.txt', action: 'MODIFY', baselineSha256: sha256('before\n'), content: updated, targetSha256: sha256(updated) },
    { path: 'del.txt', action: 'DELETE', baselineSha256: sha256('gone\n') },
  ];
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root, params: { changes } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next });
  assert.equal(result.status, 'SUCCEEDED');
  const { invocationId } = await soleInvocation(f.workspaceId, op);
  const ledger = await readLedger(invocationId);
  assert.ok(ledger, 'a settled write must leave a durable ledger');
  assert.equal(ledger.cs.status, 'SUCCEEDED');
  assert.equal(ledger.cs.file_count, 3, 'file_count is the declared file count of this changeset');
  assert.equal(ledger.cs.action_type, 'APPLY_CHANGESET');
  assert.equal(ledger.cs.operation_id, op);
  assert.equal(ledger.cs.evidence_source, 'EXECUTION');
  // 相对路径只有配上账本记录的规范根才可复现：直接按该根回读真实磁盘。
  const root = ledger.cs.canonical_root;
  assert.equal(await readFile(join(root, 'add.txt'), 'utf8'), created);
  assert.equal(await readFile(join(root, 'mod.txt'), 'utf8'), updated);
  await assert.rejects(readFile(join(root, 'del.txt')),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT', 'the delete really happened');
  const byPath = new Map(ledger.files.map((row) => [row.relative_path, row]));
  assert.equal(byPath.get('add.txt')?.baseline_sha256, null, 'CREATE has no baseline to freeze');
  assert.equal(byPath.get('add.txt')?.actual_sha256, sha256(created));
  assert.equal(byPath.get('mod.txt')?.baseline_sha256, sha256('before\n'));
  assert.equal(byPath.get('mod.txt')?.observed_baseline_sha256, sha256('before\n'));
  assert.equal(byPath.get('mod.txt')?.actual_sha256, sha256(updated));
  assert.equal(byPath.get('del.txt')?.status, 'APPLIED');
  assert.equal(byPath.get('del.txt')?.target_sha256, null, 'DELETE expects absence, so no target hash');
  assert.equal(byPath.get('del.txt')?.actual_sha256, null, 'DELETE success is proven by the path being gone');

  // 幂等锚点：一次 invocation 至多一份账本（换主键重复插也要撞唯一约束），核对只能回到同一行。
  await expectSqlState('23505', 'a second change_set for the same invocation', () => sql`
    insert into change_sets (id, invocation_id, operation_id, workspace_id, project_id, run_id,
      resource_id, action_type, canonical_root, status, evidence_source, file_count)
    values (${randomUUID()}, ${invocationId}, ${op}, ${f.workspaceId}, ${f.projectId}, ${f.runId},
      ${f.resourceId}, 'APPLY_CHANGESET', ${root}, 'SUCCEEDED', 'EXECUTION', 3)
  `.execute(app.db));
  // 不可变：逐文件行写定即不可改删；账本头只开放汇总状态列，身份列不在授权内。
  await expectSqlState('42501', 'rewriting a recorded file fact', () => sql`
    update change_set_files set status = 'FAILED' where change_set_id = ${ledger.cs.id}
  `.execute(app.db));
  await expectSqlState('42501', 'deleting a recorded file fact', () => sql`
    delete from change_set_files where change_set_id = ${ledger.cs.id}
  `.execute(app.db));
  await expectSqlState('42501', 'deleting a ledger header', () => sql`
    delete from change_sets where id = ${ledger.cs.id}
  `.execute(app.db));
  await expectSqlState('42501', 're-pointing a ledger at another invocation', () => sql`
    update change_sets set invocation_id = ${randomUUID()} where id = ${ledger.cs.id}
  `.execute(app.db));
  assert.equal(await withTransaction(app.db, (r) => r.changeSets.countByInvocation(invocationId)), 1);
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId: next.workerId, workerEpoch: next.workerEpoch });
});

test('M06 change_set source FK rejects a different action, resource or project', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  const otherRoot = join(dataRoot, `m06-other-${randomUUID()}`);
  await mkdir(otherRoot);
  const other = await registerManagedResource(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, rootPath: otherRoot });
  const otherProjectId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.projects.insertProject({ id: otherProjectId, workspaceId: f.workspaceId,
      title: 'Other source project', projectType: 'DEVELOPMENT' });
    await repositories.projects.insertProjectState(otherProjectId, 'PLANNING');
  });
  const otherProjectRoot = join(dataRoot, `m06-other-project-${randomUUID()}`);
  await mkdir(otherProjectRoot);
  const otherProjectResource = await registerManagedResource(app.db, { workspaceId: f.workspaceId,
    projectId: otherProjectId, rootPath: otherProjectRoot });
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: [{ path: 'source.txt', action: 'CREATE', content: 'source\n' }] } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
    hooks: { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('before ledger settle'); } } }), SimulatedGatewayCrash);
  const { invocationId } = await soleInvocation(f.workspaceId, op);
  assert.equal(await readLedger(invocationId), undefined, 'the crash left an invocation without a ledger');
  for (const [actionType, projectId, resourceId] of [
    ['WRITE_FILE', f.projectId, f.resourceId],
    ['APPLY_CHANGESET', f.projectId, other.resourceId],
    ['APPLY_CHANGESET', otherProjectId, otherProjectResource.resourceId],
  ]) {
    await expectSqlState('23503', `source mismatch ${actionType}/${projectId}/${resourceId}`, () => sql`
      insert into change_sets (id, invocation_id, operation_id, workspace_id, project_id, run_id,
        resource_id, action_type, canonical_root, status, evidence_source, file_count)
      values (${randomUUID()}, ${invocationId}, ${op}, ${f.workspaceId}, ${projectId}, ${f.runId},
        ${resourceId}, ${actionType}, ${f.root}, 'UNKNOWN', 'EXECUTION', 1)
    `.execute(app.db));
  }
  assert.equal(await readLedger(invocationId), undefined);
});

test('M06 change_set summary trusts guarded persisted file facts and row count', async () => {
  for (const variant of ['digest mismatch', 'duplicate rows']) {
    const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
    const origin = await claim(f);
    const op = randomUUID();
    const content = 'effect\n';
    const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
      intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
      actionType: 'APPLY_CHANGESET', target: f.root,
      params: { changes: [{ path: 'proof.txt', action: 'CREATE', content }] } });
    const next = await approveAndReclaim(f, op, prepared.review_id!);
    await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
      hooks: { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('before ledger settle'); } } }), SimulatedGatewayCrash);
    const { invocationId } = await soleInvocation(f.workspaceId, op);
    const file: ChangeSetLedgerFile = { relative_path: 'proof.txt', action: 'CREATE', baseline_sha256: null,
      observed_baseline_sha256: null, target_sha256: sha256(content),
      actual_sha256: variant === 'digest mismatch' ? sha256('fake\n') : sha256(content),
      status: 'APPLIED', error: null, diff_ref: null };
    const files = variant === 'duplicate rows' ? [file, file] : [file];
    const ledger = await withTransaction(app.db, (repositories) => repositories.changeSets.recordExecution({
      workspace_id: f.workspaceId, project_id: f.projectId, run_id: f.runId,
      resource_id: f.resourceId, operation_id: op, invocation_id: invocationId,
      action_type: 'APPLY_CHANGESET', canonical_root: f.root,
    }, randomUUID(), files, 'SUCCEEDED'));
    assert.equal(ledger.status, 'PARTIAL', `${variant} cannot yield a successful ledger`);
    const persisted = await readLedger(invocationId);
    assert.ok(persisted);
    assert.equal(persisted.files.length, 1);
    assert.equal(persisted.files[0]?.status, variant === 'digest mismatch' ? 'CONFLICT' : 'APPLIED');
  }
});

// ---------------------------------------------------------------------------
// P18 Git adapter through the Gateway (real throwaway repository)
// ---------------------------------------------------------------------------

test('M06 GIT_READ runs real git status with AUTO passthrough', async () => {
  const f = await realFixture({ capabilities: ['GIT_READ'], capability: 'GIT_READ', actionType: 'GIT_STATUS', gitRepo: true });
  await writeFile(join(f.root, 'new.md'), 'untracked\n', 'utf8');
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'GIT_STATUS', target: f.root, params: {} });
  assert.equal(prepared.status, 'PREPARED', 'GIT_READ is approval-passthrough so AUTO admits directly');
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin });
  assert.equal(result.status, 'SUCCEEDED');
  const status = (result.result_ref as { status: { branch: string; headCommit: string | null; untracked: string[] } }).status;
  assert.equal(status.branch, 'main');
  assert.ok(status.headCommit, 'the real repository HEAD commit is reported');
  assert.ok(status.untracked.includes('new.md'), 'real untracked file is surfaced');
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId: origin.workerId, workerEpoch: origin.workerEpoch });
});

test('M06 GIT_WRITE rejects a wrong parent without creating a commit', async () => {
  const f = await realFixture({ capabilities: ['GIT_WRITE'], capability: 'GIT_WRITE', actionType: 'GIT_COMMIT', gitRepo: true });
  const parent = headSha(f.root);
  await writeFile(join(f.root, 'feature.txt'), 'work\n', 'utf8');
  git(f.root, ['add', '--', 'feature.txt']); // stage with fixture git so the adapter only commits
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'GIT_COMMIT', target: f.root, params: { message: 'should not land', expected_parent_sha: '0'.repeat(40) } });
  assert.equal(prepared.status, 'WAITING_APPROVAL', 'GIT_WRITE is not approval-passthrough');
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next });
  assert.equal(result.status, 'FAILED', 'a parent mismatch must fail, not commit');
  assert.equal(headSha(f.root), parent, 'the repository HEAD is unchanged after a rejected commit');
  assert.equal(lastMessage(f.root), 'seed', 'no new commit landed');
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId: next.workerId, workerEpoch: next.workerEpoch });
});

test('M06 GIT_WRITE commit requires approval then writes for real', async () => {
  const f = await realFixture({ capabilities: ['GIT_WRITE'], capability: 'GIT_WRITE', actionType: 'GIT_COMMIT', gitRepo: true });
  const parent = headSha(f.root);
  await writeFile(join(f.root, 'feature.txt'), 'work\n', 'utf8');
  git(f.root, ['add', '--', 'feature.txt']);
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'GIT_COMMIT', target: f.root, params: { message: 'feat: real commit', expected_parent_sha: parent } });
  assert.equal(prepared.status, 'WAITING_APPROVAL');
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next });
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(lastMessage(f.root), 'feat: real commit');
  const newSha = headSha(f.root);
  assert.notEqual(newSha, parent);
  const commitResult = result.result_ref as { commitSha: string; parentSha: string };
  assert.equal(commitResult.commitSha, newSha);
  assert.equal(commitResult.parentSha, parent);
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId: next.workerId, workerEpoch: next.workerEpoch });
});

test('M06 GIT_WRITE rejects force-push and flag-injection refs at prepare', async () => {
  const f = await realFixture({ capabilities: ['GIT_WRITE'], capability: 'GIT_WRITE', actionType: 'GIT_PUSH', gitRepo: true });
  const origin = await claim(f);
  for (const ref of ['+main', '--force', '-u origin main']) {
    await assert.rejects(prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: randomUUID(),
      intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
      actionType: 'GIT_PUSH', target: f.root, params: { remote: 'origin', ref } }),
    (error: unknown) => error instanceof Error, `ref ${ref} must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// P19 Controlled CLI through the Gateway (real child processes)
// ---------------------------------------------------------------------------

test('M06 CLI_RUN executes a real child process and records exit code and stdout', async () => {
  const f = await realFixture({ capabilities: ['CLI_RUN'], capability: 'CLI_RUN', actionType: 'CLI_RUN', maxPayloadBytes: 8192 });
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'CLI_RUN', target: f.root,
    params: { executable: process.execPath, args: ['-e', 'process.stdout.write("cli-ok:"+ (1+1))'] } });
  assert.equal(prepared.status, 'WAITING_APPROVAL', 'CLI_RUN cannot bypass approval');
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next });
  assert.equal(result.status, 'SUCCEEDED');
  const ref = result.result_ref as { exitCode: number; stdout: string; outcome: string };
  assert.equal(ref.outcome, 'SUCCEEDED');
  assert.equal(ref.exitCode, 0);
  assert.equal(ref.stdout, 'cli-ok:2');
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId: next.workerId, workerEpoch: next.workerEpoch });
});

test('M06 CLI_RUN sanitizes the child environment (drops secret-bearing variables)', async () => {
  const f = await realFixture({ capabilities: ['CLI_RUN'], capability: 'CLI_RUN', actionType: 'CLI_RUN' });
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'CLI_RUN', target: f.root,
    params: { executable: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      env: { LEAKED_TOKEN: 'super-secret-should-not-leak', RELAY_APP_SECRET: 'nope' } } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next });
  assert.equal(result.status, 'SUCCEEDED');
  const stdout = (result.result_ref as { stdout: string }).stdout;
  assert.equal(stdout.includes('super-secret-should-not-leak'), false, 'TOKEN-bearing env must be stripped');
  assert.equal(stdout.includes('nope'), false, 'RELAY_-prefixed env must be stripped');
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId: next.workerId, workerEpoch: next.workerEpoch });
});

test('M06 CLI_RUN enforces the deadline as a timeout instead of hanging', async () => {
  const f = await realFixture({ capabilities: ['CLI_RUN'], capability: 'CLI_RUN', actionType: 'CLI_RUN' });
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'CLI_RUN', target: f.root,
    params: { executable: process.execPath, args: ['-e', 'setTimeout(() => process.exit(0), 15000)'] } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
    deadline: new Date(Date.now() + 2500) });
  assert.equal(result.status, 'FAILED', 'a timed-out build/test is a failure, not a success');
  const ref = result.result_ref as { outcome: string };
  assert.equal(ref.outcome, 'TIMEOUT');
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId: next.workerId, workerEpoch: next.workerEpoch });
});

// ---------------------------------------------------------------------------
// M06 recovery counterexamples: crash after a real external effect, reconciled
// from the actual world (a real bare remote / a real process tree) rather than
// trusted from a lost exit code.
// ---------------------------------------------------------------------------

/** Attaches a throwaway bare repository under the data root as `origin` and returns it. */
async function attachBareRemote(root: string): Promise<string> {
  const remoteDir = join(dataRoot, `remote-${randomUUID()}`);
  await mkdir(remoteDir, { recursive: true });
  git(remoteDir, ['init', '-q', '--bare', '-b', 'main']);
  git(root, ['remote', 'add', 'origin', remoteDir]);
  return remoteDir;
}

test('M06 GIT_PUSH lands on the real remote then a crash reconciles SUCCEEDED via ls-remote', async () => {
  const f = await realFixture({ capabilities: ['GIT_WRITE'], capability: 'GIT_WRITE', actionType: 'GIT_PUSH', gitRepo: true });
  await attachBareRemote(f.root);
  await writeFile(join(f.root, 'feature.txt'), 'push me\n', 'utf8');
  git(f.root, ['add', '--', 'feature.txt']);
  git(f.root, ['commit', '-q', '-m', 'feat: to be pushed']);
  const pushedSha = headSha(f.root);

  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'GIT_PUSH', target: f.root, params: { remote: 'origin', ref: 'main', expected_commit_sha: pushedSha } });
  assert.equal(prepared.status, 'WAITING_APPROVAL', 'GIT_WRITE cannot bypass approval');
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  // The push physically completes inside the adapter; crash before the result is settled.
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
    hooks: { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('after push'); } } }), SimulatedGatewayCrash);
  const stuck = await soleInvocation(f.workspaceId, op);
  assert.equal(stuck.status, 'DISPATCHING', 'the crash leaves the real effect unaccounted for');

  // Reconcile reads the exact remote ref back over the wire; matching object id is proof of success.
  const remoteSha = gitRemoteSha(f.root, 'main');
  assert.equal(remoteSha, pushedSha, 'the remote genuinely received the commit');
  const okReconcile = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId, operationId: op,
    invocationId: stuck.invocationId, oldProcessStopped: true, stoppedWorkerId: next.workerId, stoppedWorkerEpoch: next.workerEpoch });
  assert.equal(okReconcile.status, 'SUCCEEDED', 'a push confirmed on the remote is settled SUCCEEDED, not re-run');
});

test('M06 GIT_PUSH whose remote does not match reconciles UNKNOWN and blocks a new claim', async () => {
  const f = await realFixture({ capabilities: ['GIT_WRITE'], capability: 'GIT_WRITE', actionType: 'GIT_PUSH', gitRepo: true });
  await attachBareRemote(f.root);
  await writeFile(join(f.root, 'feature.txt'), 'push me\n', 'utf8');
  git(f.root, ['add', '--', 'feature.txt']);
  git(f.root, ['commit', '-q', '-m', 'feat: maybe pushed']);
  const expectedSha = headSha(f.root);

  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'GIT_PUSH', target: f.root, params: { remote: 'origin', ref: 'main', expected_commit_sha: expectedSha } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
    hooks: { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('after push'); } } }), SimulatedGatewayCrash);
  const stuck = await soleInvocation(f.workspaceId, op);
  // External actor advances the remote so the recorded intent's exact object id can no
  // longer be confirmed against the current remote state (target changed -> original
  // approval is stale; success cannot be asserted and the effect cannot be blindly retried).
  await writeFile(join(f.root, 'later.txt'), 'later\n', 'utf8');
  git(f.root, ['add', '--', 'later.txt']);
  git(f.root, ['commit', '-q', '-m', 'remote moved on']);
  git(f.root, ['push', '-q', 'origin', 'main']);
  assert.notEqual(gitRemoteSha(f.root, 'main'), expectedSha, 'the remote has advanced past the recorded commit');
  const unknown = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId, operationId: op,
    invocationId: stuck.invocationId, oldProcessStopped: true, stoppedWorkerId: next.workerId, stoppedWorkerEpoch: next.workerEpoch });
  assert.equal(unknown.status, 'UNKNOWN', 'a moved-on remote cannot be reported as success or blindly retried');
  await assert.rejects(claimRunForGateway(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId: `worker-${randomUUID()}` }),
    (error: unknown) => code(error) === 'GATEWAY_OPERATION_UNRESOLVED');
});

test('M06 CLI_RUN timeout through the Gateway tears down the whole process tree (no orphaned grandchild)', async () => {
  const f = await realFixture({ capabilities: ['CLI_RUN'], capability: 'CLI_RUN', actionType: 'CLI_RUN' });
  const pidFile = join(f.root, 'grandchild.pid');
  // Parent spawns a long-lived grandchild, records its pid, then keeps itself alive
  // so the only way the grandchild dies is the tree kill on timeout.
  const parentScript =
    'const {spawn}=require("child_process");const fs=require("fs");' +
    'const gc=spawn(process.execPath,["-e","setInterval(function(){},9e9)"],{stdio:"ignore"});' +
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(gc.pid));` +
    'setTimeout(function(){},120000);';
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'CLI_RUN', target: f.root, params: { executable: process.execPath, args: ['-e', parentScript] } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
    deadline: new Date(Date.now() + 3000) });
  assert.equal(result.status, 'FAILED');
  assert.equal((result.result_ref as { outcome: string }).outcome, 'TIMEOUT');
  const grandchildPid = Number((await readFile(pidFile, 'utf8')).trim());
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, 'the grandchild must have recorded its pid');
  // killProcessTree has already been awaited by the adapter; poll a bounded margin for the OS to reap it.
  let stillAlive = true;
  const pollUntil = Date.now() + 10_000;
  while (Date.now() < pollUntil) {
    if (!isProcessAlive(grandchildPid)) { stillAlive = false; break; }
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(stillAlive, false, `timed-out CLI must terminate the grandchild pid ${grandchildPid}, not orphan it`);
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId: next.workerId, workerEpoch: next.workerEpoch });
});

test('M06 FILE_WRITE rejects a protected path with a dot prefix at prepare', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  const origin = await claim(f);
  await assert.rejects(prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: randomUUID(),
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: [{ path: './.env', action: 'CREATE', content: 'protected' }] } }),
  (error: unknown) => code(error) === 'GATEWAY_TARGET_DENIED', './.env must be denied before approval');
});

test('M06 FILE_WRITE cannot overwrite an existing file without a baseline hash', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  await writeFile(join(f.root, 'notes.md'), 'original\n', 'utf8');
  const origin = await claim(f);
  const op = randomUUID();
  let prepared: Awaited<ReturnType<typeof prepareGatewayAction>>;
  try {
    prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
      intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
      actionType: 'APPLY_CHANGESET', target: f.root,
      params: { changes: [{ path: 'notes.md', action: 'MODIFY', content: 'overwrite\n' }] } });
  } catch (error) {
    assert.equal(code(error), 'VALIDATION_FAILED', 'missing baseline should be rejected as invalid input');
    assert.equal(await readFile(join(f.root, 'notes.md'), 'utf8'), 'original\n');
    return;
  }
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next });
  assert.deepEqual({ status: result.status, content: await readFile(join(f.root, 'notes.md'), 'utf8') },
    { status: 'FAILED', content: 'original\n' }, 'an approved MODIFY without a baseline cannot silently overwrite the file');
});

test('M06 CLI_RUN lost result after a real write remains UNKNOWN and keeps the resource quarantined', async () => {
  const f = await realFixture({ capabilities: ['CLI_RUN'], capability: 'CLI_RUN', actionType: 'CLI_RUN' });
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'CLI_RUN', target: f.root,
    params: { executable: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync("cli-effect.txt", "effect-done\\n")'] } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next,
    hooks: { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('after CLI write'); } } }), SimulatedGatewayCrash);
  assert.equal(await readFile(join(f.root, 'cli-effect.txt'), 'utf8'), 'effect-done\n', 'the real child effect completed');
  const stuck = await readGatewayOperation(app.db, f.workspaceId, op);
  const invocation = stuck.invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.status, 'DISPATCHING');
  assert.equal(invocation.result_ref, null, 'the child PID and exit result were not persisted');
  assert.ok(invocation.resource_claim_id);

  const reconciled = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId, operationId: op,
    invocationId: invocation.id, oldProcessStopped: true,
    stoppedWorkerId: next.workerId, stoppedWorkerEpoch: next.workerEpoch });
  const claimRow = await withTransaction(app.db, (repositories) => repositories.gateway.readClaim(invocation.resource_claim_id!));
  let reclaim: string = 'CLAIMED';
  try {
    await claimRunForGateway(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId: `worker-${randomUUID()}` });
  } catch (error) {
    reclaim = code(error) ?? 'UNKNOWN_ERROR';
  }
  assert.deepEqual({ reconciliation: reconciled.status, claim: claimRow?.status, reclaim },
    { reconciliation: 'UNKNOWN', claim: 'QUARANTINED', reclaim: 'GATEWAY_OPERATION_UNRESOLVED' },
    'a lost CLI result cannot prove no side effect or grant another writer');
});

test('M06 FILE_WRITE rejects a DELETE without a frozen baseline at prepare', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  await writeFile(join(f.root, 'gone.txt'), 'to be deleted\n', 'utf8');
  const origin = await claim(f);
  await assert.rejects(prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: randomUUID(),
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root, params: { changes: [{ path: 'gone.txt', action: 'DELETE' }] } }),
  (error: unknown) => code(error) === 'VALIDATION_FAILED', 'DELETE without a baseline must be rejected as invalid input');
  assert.equal(await readFile(join(f.root, 'gone.txt'), 'utf8'), 'to be deleted\n', 'rejection cannot remove the real file');
});

test('M06 FILE_WRITE still applies MODIFY when the frozen baseline matches', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  await writeFile(join(f.root, 'notes.md'), 'original\n', 'utf8');
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'APPLY_CHANGESET', target: f.root,
    params: { changes: [{ path: 'notes.md', action: 'MODIFY', baselineSha256: sha256('original\n'), content: 'updated\n' }] } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next });
  assert.equal(result.status, 'SUCCEEDED', 'a correct frozen baseline must still permit the legitimate MODIFY');
  assert.equal(await readFile(join(f.root, 'notes.md'), 'utf8'), 'updated\n');
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId: next.workerId, workerEpoch: next.workerEpoch });
});

test('M06 WRITE_FILE without a baseline becomes CREATE and cannot overwrite an existing file', async () => {
  // Field-conversion consistency: the single-file WRITE_FILE path derives its action
  // from baseline_sha256, so a missing baseline degrades to CREATE and must not
  // silently overwrite — the same protection the changeset MODIFY path enforces.
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'WRITE_FILE' });
  await writeFile(join(f.root, 'keep.md'), 'original\n', 'utf8');
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op,
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'WRITE_FILE', target: join(f.root, 'keep.md'), params: { content: 'overwrite\n' } });
  const next = await approveAndReclaim(f, op, prepared.review_id!);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin: next });
  assert.equal(result.status, 'FAILED', 'WRITE_FILE without a baseline cannot overwrite an existing file');
  assert.equal(await readFile(join(f.root, 'keep.md'), 'utf8'), 'original\n', 'the existing file must be preserved');
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId: next.workerId, workerEpoch: next.workerEpoch });
});

test('M06 FILE_WRITE denies root-internal path aliases at the real PG prepare', async () => {
  const f = await realFixture({ capabilities: ['FILE_WRITE'], capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET' });
  const origin = await claim(f);
  for (const alias of ['./.env', 'src/../.env', 'foo/../.git/config']) {
    await assert.rejects(prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: randomUUID(),
      intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
      actionType: 'APPLY_CHANGESET', target: f.root, params: { changes: [{ path: alias, action: 'CREATE', content: 'x' }] } }),
    (error: unknown) => code(error) === 'GATEWAY_TARGET_DENIED', `${alias} must be denied after normalization`);
  }
});
