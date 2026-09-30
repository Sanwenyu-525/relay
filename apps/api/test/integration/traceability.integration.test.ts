import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { withTransaction } from '../../src/application/unit-of-work.js';
import { ModelCallRepository } from '../../src/model/model-call-repository.js';
import { MODEL_ERROR_CATEGORIES } from '../../src/workflow/model-error-classification.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  expectSqlState, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, expectProblem,
  startTestApi, workspacePath, type TestApi } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-traceability');
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => { await api?.stop(); await app.close(); });

function hash(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

async function createTask(workspaceId: string, projectId: string | null, title: string) {
  const commandId = randomUUID();
  const body = { command_id: commandId, project_id: projectId, title,
    objective: title, criteria: [{ statement: 'Human review' }] };
  const result = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/tasks'),
    body), 201, commandId);
  return { id: result.task_id as string, revision: result.revision as string,
    commandId, body };
}

async function createProject(workspaceId: string) {
  const commandId = randomUUID();
  const result = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/projects'), {
    command_id: commandId, title: `Trace ${commandId}`, project_type: 'GENERAL',
  }), 201, commandId);
  return result.project_id as string;
}

async function ready(workspaceId: string, taskId: string, revision: string) {
  const commandId = randomUUID();
  const result = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${taskId}/ready`), { command_id: commandId,
    expected_revision: revision }), 200, commandId);
  return result.revision as string;
}

async function seedVersion(workspaceId: string, taskId: string,
  artifactId = randomUUID(), versionNumber = 1n) {
  const versionId = randomUUID();
  await withTransaction(app.db, async (r) => {
    if (versionNumber === 1n) {
      await r.artifacts.insertArtifact({ id: artifactId, workspaceId, projectId: null,
        taskId, artifactKind: 'MARKDOWN_DOCUMENT', title: 'Lineage fixture' });
    }
    await r.artifacts.insertArtifactVersion({ id: versionId, artifactId, versionNumber,
      storageRef: `lineage/${versionId}.md`, contentHash: hash(versionId),
      size: BigInt(versionId.length), mediaType: 'text/markdown',
      sourceKind: 'HUMAN', sourceRef: null });
  });
  return { artifactId, versionId };
}

test('Activity paginates by scoped keyset, replays once and redacts raw facts', async () => {
  const workspaceId = await createWorkspace(app.db);
  const otherWorkspace = await createWorkspace(app.db);
  const p = await createProject(workspaceId);
  const own = await createTask(workspaceId, p, 'Audited task');
  const foreign = await createTask(otherWorkspace, null, 'Foreign task');
  const replay = await api.post(workspacePath(workspaceId, '/tasks'), own.body);
  assert.equal(replay.headers['command-replayed'], 'true');
  const sameCommand = await sql<{ count: bigint }>`select count(*)::bigint as count
    from activity_records where workspace_id = ${workspaceId}
      and command_id = ${own.commandId}`.execute(app.db);
  assert.equal(sameCommand.rows[0]?.count, 1n);
  const secret = 'TOP_SECRET_ACTIVITY_CREDENTIAL';
  await sql`insert into activity_records (id, workspace_id, actor_kind, actor_ref,
    command_id, project_id, task_id, run_id, event_type, fact_refs)
    values (${randomUUID()}, ${workspaceId}, 'SYSTEM', ${secret}, null, null,
      null, null, 'SENSITIVE_INTERNAL_EVENT', ${JSON.stringify({ token: secret,
        task_id: foreign.id })}::jsonb)`.execute(app.db);
  const first = await api.get(workspacePath(workspaceId, '/activities?limit=1'));
  assert.equal(first.status, 200, first.text);
  assert.equal(first.text.includes(secret), false);
  const page = first.body as { items: { id: string; actor_ref: string;
    entity_refs: { id: string }[] }[]; next_cursor: string | null };
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.actor_ref, 'REDACTED');
  assert.equal(page.items[0]?.entity_refs.some((ref) => ref.id === foreign.id), false);
  assert.ok(page.next_cursor);
  const second = await api.get(workspacePath(workspaceId,
    `/activities?limit=1&cursor=${encodeURIComponent(page.next_cursor!)}`));
  assert.equal(second.status, 200, second.text);
  assert.notEqual((second.body as { items: { id: string }[] }).items[0]?.id, page.items[0]?.id);
  const mismatched = await api.get(workspacePath(workspaceId,
    `/activities?limit=1&project_id=${p}&cursor=${encodeURIComponent(page.next_cursor!)}`));
  expectProblem(mismatched, 400, 'INVALID_CURSOR');
  expectProblem(await api.get(workspacePath(workspaceId,
    `/activities?task_id=${foreign.id}`)), 404, 'RESOURCE_NOT_FOUND');
  const foreignProject = await createProject(otherWorkspace);
  expectProblem(await api.get(workspacePath(workspaceId,
    `/activities?project_id=${foreignProject}`)), 404, 'RESOURCE_NOT_FOUND');
});

test('Activity rolls back with its business transaction', async () => {
  const workspaceId = await createWorkspace(app.db);
  const id = randomUUID();
  await assert.rejects(() => withTransaction(app.db, async (r) => {
    await r.activities.insertActivityRecord({ id, workspaceId, actorKind: 'SYSTEM',
      actorRef: 'test', commandId: null, projectId: null, taskId: null,
      eventType: 'ROLLBACK_PROBE', factRefs: { secret: 'never committed' } });
    throw new Error('rollback probe');
  }), /rollback probe/u);
  const rows = await sql<{ count: bigint }>`select count(*)::bigint as count
    from activity_records where id = ${id}`.execute(app.db);
  assert.equal(rows.rows[0]?.count, 0n);
});

test('Trace returns exact source summaries with current Workspace checks and no bodies', async () => {
  const workspaceId = await createWorkspace(app.db);
  const foreignWorkspace = await createWorkspace(app.db);
  const projectId = await createProject(workspaceId);
  const task = await createTask(workspaceId, projectId, 'Trace run');
  const revision = await ready(workspaceId, task.id, task.revision);
  const commandId = randomUUID();
  const delegated = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${task.id}/delegations`), { command_id: commandId,
    expected_task_revision: revision }), 202, commandId);
  const runId = delegated.run_id as string;
  const secret = 'TOP_SECRET_MODEL_PROMPT';
  const visibleId = randomUUID();
  const foreignId = randomUUID();
  await withTransaction(app.db, async (r) => {
    for (const [owner, id] of [[workspaceId, visibleId], [foreignWorkspace, foreignId]] as const) {
      await r.information.insertKnowledgeRoot(id, owner, null, 'Source');
      await r.information.insertKnowledgeVersion({ id: randomUUID(), workspaceId: owner,
        knowledgeId: id, projectId: null, version: 1n, sourceKind: 'NOTE',
        mediaType: 'text/markdown', text: secret, hash: hash(secret),
        artifactId: null, artifactVersionId: null, sourceUri: null, sourceRefs: {} });
      await r.information.setRootVersion('knowledge', id, 1n);
    }
  });
  const payload = { sources: [visibleId, foreignId].map((id) => ({ kind: 'KNOWLEDGE',
    source_ref: `knowledge:${id}:v1`, version: '1', sha256: hash(secret).toString('hex'),
    source_sha256: hash(secret).toString('hex'), role: 'RELEVANT',
    trust: 'UNTRUSTED_DATA', content: secret })).concat([{
    kind: secret, source_ref: secret, version: secret, sha256: secret,
    source_sha256: secret, role: secret, trust: secret, content: secret,
  }]), exclusions: [{ secret }] };
  await sql`insert into context_manifests (id, run_id, step_id, builder_version,
    manifest_hash, payload) values (${randomUUID()}, ${runId}, null, 'test',
      ${hash(JSON.stringify(payload))}, ${JSON.stringify(payload)}::jsonb)`.execute(app.db);
  const response = await api.get(workspacePath(workspaceId, `/runs/${runId}/trace`));
  assert.equal(response.status, 200, response.text);
  assert.equal(response.text.includes(secret), false);
  assert.equal(response.text.includes(foreignId), false);
  const body = response.body as { manifests: { sources: { source_ref: string | null;
    availability: string }[] }[]; reviews: unknown[]; operations: unknown[] };
  assert.equal(body.manifests[0]?.sources[0]?.availability, 'AVAILABLE');
  assert.equal(body.manifests[0]?.sources[1]?.source_ref, null);
  assert.equal(body.manifests[0]?.sources[1]?.availability, 'UNAVAILABLE');
  expectProblem(await api.get(workspacePath(foreignWorkspace,
    `/runs/${runId}/trace`)), 404, 'RESOURCE_NOT_FOUND');
  expectProblem(await api.get(workspacePath(foreignWorkspace,
    `/activities?run_id=${runId}`)), 404, 'RESOURCE_NOT_FOUND');
});

test('Trace exposes only failed Provider categories and preserves each model invocation identity', async () => {
  const workspaceId = await createWorkspace(app.db);
  const foreignWorkspace = await createWorkspace(app.db);
  const projectId = await createProject(workspaceId);
  const task = await createTask(workspaceId, projectId, 'Model diagnostics');
  const revision = await ready(workspaceId, task.id, task.revision);
  const commandId = randomUUID();
  const delegated = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${task.id}/delegations`), { command_id: commandId,
    expected_task_revision: revision }), 202, commandId);
  const runId = delegated.run_id as string;
  const attempts = [randomUUID(), randomUUID()];
  const manifestId = randomUUID();
  await withTransaction(app.db, async (r) => {
    const step = (await r.runs.listSteps(runId)).find((row) => row.step_kind === 'DRAFT')!;
    for (const [index, id] of attempts.entries()) {
      await r.runs.insertStepAttempt({ id, stepId: step.id,
        attemptNumber: BigInt(index + 1), attemptKey: `diagnostics-${index}` });
    }
    await r.runs.insertContextManifest({ id: manifestId, runId, stepId: step.id,
      builderVersion: 'diagnostics', manifestHash: hash('diagnostics'), payload: {} });
  });
  const calls = new ModelCallRepository(app.db);
  const identity = { provider: 'diagnostic-double', model: 'diagnostic-model',
    configFingerprint: hash('diagnostics').toString('hex') };
  const expected = new Map<string, { kind: string; step_attempt_id: string;
    criterion_id: string | null; check_attempt: number | null;
    provider_error_kind: string | null; provider_request_id: string | null }>();
  for (const [index, category] of MODEL_ERROR_CATEGORIES.entries()) {
    const id = randomUUID();
    const semantic = index >= 3;
    const stepAttemptId = attempts[index % 2]!;
    await calls.begin(id, { workspaceId, kind: semantic ? 'SEMANTIC_CHECK' : 'DRAFT',
      stepAttemptId, ...(semantic ? { criterionId: `c${index % 2}`, checkAttempt: 1 }
        : { manifestId }) }, identity);
    await calls.settle(id, { status: 'FAILED', errorKind: category,
      providerRequestId: `request-${index}`,
      ...(index === 0 ? { usage: { inputTokens: 7, outputTokens: null } } : {}) });
    expected.set(id, { kind: semantic ? 'SEMANTIC_CHECK' : 'DRAFT',
      step_attempt_id: stepAttemptId, criterion_id: semantic ? `c${index % 2}` : null,
      check_attempt: semantic ? 1 : null, provider_error_kind: category,
      provider_request_id: `request-${index}` });
  }
  for (const [status, errorKind] of [['FAILED', 'TOP_SECRET_LOCAL_ERROR_AND_TOKEN'],
    ['CANCELLED', 'AUTH'], ['COMPLETED', null], ['STARTED', null]] as const) {
    const id = randomUUID();
    await calls.begin(id, { workspaceId, kind: 'SEMANTIC_CHECK',
      stepAttemptId: attempts[1]!, criterionId: 'c1', checkAttempt: 2 }, identity);
    if (status !== 'STARTED') await calls.settle(id, { status, errorKind });
    expected.set(id, { kind: 'SEMANTIC_CHECK', step_attempt_id: attempts[1]!,
      criterion_id: 'c1', check_attempt: 2, provider_error_kind: null,
      provider_request_id: null });
  }
  const probeId = randomUUID();
  await calls.begin(probeId, { workspaceId, kind: 'VERIFY' }, identity);
  const response = await api.get(workspacePath(workspaceId, `/runs/${runId}/trace`));
  assert.equal(response.status, 200, response.text);
  const rows = (response.body as { model_calls: { id: string; provider: string;
    model: string; status: string; provider_request_id: string | null;
    usage_input_tokens: number | null; usage_output_tokens: number | null }[] })
    .model_calls;
  assert.equal(rows.length, expected.size);
  for (const row of rows) {
    const exact = expected.get(row.id);
    assert.ok(exact);
    for (const [key, value] of Object.entries(exact)) {
      assert.equal((row as unknown as Record<string, unknown>)[key], value, `${row.id}.${key}`);
    }
    assert.equal(row.provider, identity.provider);
    assert.equal(row.model, identity.model);
    assert.equal(row.usage_output_tokens, null);
    assert.equal(row.usage_input_tokens, row.provider_request_id === 'request-0' ? 7 : null);
    assert.equal(Object.hasOwn(row, 'error_kind'), false);
    assert.equal(Object.hasOwn(row, 'config_fingerprint'), false);
  }
  assert.equal(response.text.includes('TOP_SECRET_LOCAL_ERROR_AND_TOKEN'), false);
  assert.equal(response.text.includes(probeId), false);
  expectProblem(await api.get(workspacePath(foreignWorkspace,
    `/runs/${runId}/trace`)), 404, 'RESOURCE_NOT_FOUND');
});

test('Lineage rejects self, cross-Workspace and version cycles and marks missing content unavailable', async () => {
  const workspaceId = await createWorkspace(app.db);
  const foreignWorkspace = await createWorkspace(app.db);
  const task = await createTask(workspaceId, null, 'Lineage task');
  const foreignTask = await createTask(foreignWorkspace, null, 'Foreign lineage task');
  const first = await seedVersion(workspaceId, task.id);
  const second = await seedVersion(workspaceId, task.id);
  const foreign = await seedVersion(foreignWorkspace, foreignTask.id);
  await expectSqlState('23514', 'self lineage', () => withTransaction(app.db,
    (r) => r.lineage.insertExactEdge({ workspaceId, childVersionId: first.versionId,
      relation: 'DERIVED_FROM', parentKind: 'ARTIFACT_VERSION', parentId: first.versionId })));
  await expectSqlState('23514', 'cross Workspace lineage', () => withTransaction(app.db,
    (r) => r.lineage.insertExactEdge({ workspaceId, childVersionId: first.versionId,
      relation: 'DERIVED_FROM', parentKind: 'ARTIFACT_VERSION', parentId: foreign.versionId })));
  await withTransaction(app.db, async (r) => {
    await r.lineage.insertExactEdge({ workspaceId, childVersionId: first.versionId,
      relation: 'DERIVED_FROM', parentKind: 'ARTIFACT_VERSION', parentId: second.versionId });
    await r.lineage.insertExactEdge({ workspaceId, childVersionId: first.versionId,
      relation: 'DERIVED_FROM', parentKind: 'ARTIFACT_VERSION', parentId: second.versionId });
  });
  await expectSqlState('23514', 'version cycle', () => withTransaction(app.db,
    (r) => r.lineage.insertExactEdge({ workspaceId, childVersionId: second.versionId,
      relation: 'DERIVED_FROM', parentKind: 'ARTIFACT_VERSION', parentId: first.versionId })));
  const response = await api.get(workspacePath(workspaceId,
    `/artifact-versions/${first.versionId}/lineage`));
  assert.equal(response.status, 200, response.text);
  const body = response.body as { content_availability: string;
    direct_parents: { parent_id: string | null; availability: string }[] };
  assert.equal(body.content_availability, 'UNAVAILABLE');
  assert.equal(body.direct_parents.length, 1);
  assert.equal(body.direct_parents[0]?.availability, 'UNAVAILABLE');
  assert.equal(body.direct_parents[0]?.parent_id, null);
  expectProblem(await api.get(workspacePath(foreignWorkspace,
    `/artifact-versions/${first.versionId}/lineage`)), 404, 'RESOURCE_NOT_FOUND');
});

test('Human revision writes exact REVISED_FROM edge once with command replay', async () => {
  const workspaceId = await createWorkspace(app.db);
  const task = await createTask(workspaceId, null, 'Version correction');
  const readyRevision = await ready(workspaceId, task.id, task.revision);
  const startId = randomUUID();
  const started = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${task.id}/start`), { command_id: startId,
    expected_revision: readyRevision }), 200, startId);
  const firstId = randomUUID();
  const first = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${task.id}/artifacts`), { command_id: firstId,
    expected_task_revision: started.revision, title: 'Versioned',
    media_type: 'text/markdown', content: '# First' }), 201, firstId);
  const nextId = randomUUID();
  const nextBody = { command_id: nextId, expected_artifact_revision: first.artifact_revision,
    expected_task_revision: first.task_revision, media_type: 'text/markdown',
    content: '# Second' };
  const path = workspacePath(workspaceId, `/artifacts/${first.artifact_id}/versions`);
  const second = expectCommandAccepted(await api.post(path, nextBody), 201, nextId);
  const replay = await api.post(path, nextBody);
  assert.equal(replay.headers['command-replayed'], 'true');
  const lineage = await api.get(workspacePath(workspaceId,
    `/artifact-versions/${second.version_id}/lineage`));
  assert.equal(lineage.status, 200, lineage.text);
  assert.deepEqual((lineage.body as { direct_parents: { relation: string;
    parent_id: string }[] }).direct_parents.map((edge) => [edge.relation, edge.parent_id]),
  [['REVISED_FROM', first.version_id]]);

  const completeId = randomUUID();
  const completeBody = { command_id: completeId, expected_revision: second.task_revision,
    acceptance_revision: '1', artifact_version_ids: [first.version_id],
    acceptance: { statement: 'Reviewed the first version',
      accepted_criterion_ids: ['c1'] } };
  const completePath = workspacePath(workspaceId, `/tasks/${task.id}/complete`);
  const completed = expectCommandAccepted(await api.post(completePath,
    completeBody), 200, completeId);
  const completeReplay = await api.post(completePath, completeBody);
  assert.equal(completeReplay.headers['command-replayed'], 'true');
  const accepted = await api.get(workspacePath(workspaceId,
    `/artifact-versions/${first.version_id}/lineage`));
  assert.equal(accepted.status, 200, accepted.text);
  assert.deepEqual((accepted.body as { direct_parents: { relation: string;
    parent_id: string }[] }).direct_parents.map((edge) => [edge.relation, edge.parent_id]),
  [['ACCEPTED_BY', completed.completion_id]]);
  const unaccepted = await api.get(workspacePath(workspaceId,
    `/artifact-versions/${second.version_id}/lineage`));
  assert.equal(unaccepted.status, 200, unaccepted.text);
  assert.deepEqual((unaccepted.body as { direct_parents: { relation: string }[] })
    .direct_parents.map((edge) => edge.relation), ['REVISED_FROM']);
});
