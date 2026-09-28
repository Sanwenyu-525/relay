import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import test, { after, before } from 'node:test';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistRequest, type AssistResult } from '../../src/workflow/fake-model-port.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { LineageRepository } from '../../src/artifact/lineage-repository.js';
import { ReviewRepository } from '../../src/review/review-repository.js';
import { RunRepository } from '../../src/run/run-repository.js';
import { TaskRepository } from '../../src/task/task-repository.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { requireAiTextLocks } from '../../src/application/artifact-commands.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { claimInterventionNotifications, listInterventionItems } from
  '../../src/application/attention-notifications.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, expectProblem, startTestApi,
  workspacePath, type TestApi } from './api-harness.js';

const database = openDatabase(APP_DATABASE_URL, 'relay-collaboration-controls');
let api: TestApi;
let workspaceId: string;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
  workspaceId = await createWorkspace(database.db);
});
after(async () => { await api.stop(); await database.close(); });

async function taskAndArtifact(content: string) {
  const projectCommand = randomUUID();
  const project = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/projects'),
    { command_id: projectCommand, title: '协作控制', project_type: 'GENERAL' }), 201, projectCommand);
  const taskCommand = randomUUID();
  const task = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: taskCommand, project_id: project.project_id, title: '人工修订',
    objective: '测试受管版本', criteria: [{ criterion_id: 'c1', statement: '人工核对' }],
  }), 201, taskCommand);
  const readyCommand = randomUUID();
  const ready = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${task.task_id}/ready`), { command_id: readyCommand,
    expected_revision: task.revision }), 200, readyCommand);
  const startCommand = randomUUID();
  const started = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${task.task_id}/start`), { command_id: startCommand,
    expected_revision: ready.revision }), 200, startCommand);
  const command = randomUUID();
  const artifact = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${task.task_id}/artifacts`), { command_id: command,
    expected_task_revision: started.revision, title: '正文',
    media_type: 'text/markdown', content }), 201, command);
  return { taskId: task.task_id as string, artifactId: artifact.artifact_id as string,
    versionId: artifact.version_id as string,
    artifactRevision: artifact.artifact_revision as string,
    taskRevision: artifact.task_revision as string };
}

test('lock command is idempotent, human revision rebinds original text, stale CAS fails', async () => {
  const created = await taskAndArtifact('# 结论\n\n保留原文。\n\n开放部分。');
  assert.equal((await listInterventionItems(database.db, workspaceId)).length, 0,
    'ordinary human work does not become a proactive intervention');
  const command = randomUUID();
  const body = { command_id: command, expected_artifact_revision: created.artifactRevision,
    expected_version_id: created.versionId, block_kind: 'PARAGRAPH', block_index: 1 };
  const path = workspacePath(workspaceId, `/artifacts/${created.artifactId}/text-locks`);
  const locked = expectCommandAccepted(await api.post(path, body), 200, command);
  assert.equal((locked.lock as { text: string }).text, '保留原文。');
  const replay = expectCommandAccepted(await api.post(path, body), 200, command);
  assert.equal((replay.lock as { id: string }).id, (locked.lock as { id: string }).id);
  expectProblem(await api.post(path, { ...body, command_id: randomUUID() }),
    409, 'REVISION_CONFLICT');
  const saveCommand = randomUUID();
  const saved = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/artifacts/${created.artifactId}/versions`), { command_id: saveCommand,
    expected_artifact_revision: locked.artifact_revision,
    expected_task_revision: created.taskRevision, media_type: 'text/markdown',
    content: '# 结论\n\n人工更新的原文。\n\n开放部分。' }), 201, saveCommand);
  const list = await api.get(path);
  assert.equal(list.status, 200, list.text);
  const current = ((list.body as { locks: { text: string; base_version_id: string }[] }).locks)[0]!;
  assert.equal(current.text, '人工更新的原文。');
  assert.equal(current.base_version_id, saved.version_id);
  await assert.rejects(requireAiTextLocks(createRepositories(database.db),
    new ManagedContentStore(api.dataRoot), created.artifactId,
    '# 结论\n\nAI 覆盖的原文。\n\n开放部分。'));
});

test('persisted locks reject trailing-space and internal-CRLF edits at the AI write guard', async () => {
  const cases = [
    { kind: 'SECTION', index: 0, original: '# 原文\n原文  \n# 开放\n旧内容',
      changed: '# 原文\n原文\n# 开放\n旧内容',
      adjacent: '# 原文\n原文  \n# 开放\n新内容',
      human: '# 原文\n人工原文  \n# 开放\n旧内容',
      afterHumanAi: '# 原文\n人工原文\n# 开放\n旧内容' },
    { kind: 'PARAGRAPH', index: 1,
      original: '# 原文\r\n\r\n第一行\r\n第二行\r\n\r\n开放',
      changed: '# 原文\r\n\r\n第一行\n第二行\r\n\r\n开放',
      adjacent: '# 原文\r\n\r\n第一行\r\n第二行\r\n\r\n新开放',
      human: '# 原文\r\n\r\n人工第一行\r\n第二行\r\n\r\n开放',
      afterHumanAi: '# 原文\r\n\r\n人工第一行\n第二行\r\n\r\n开放' },
  ] as const;
  const storage = new ManagedContentStore(api.dataRoot);
  for (const sample of cases) {
    const created = await taskAndArtifact(sample.original);
    const lockCommand = randomUUID();
    const path = workspacePath(workspaceId, `/artifacts/${created.artifactId}/text-locks`);
    const locked = expectCommandAccepted(await api.post(path, { command_id: lockCommand,
      expected_artifact_revision: created.artifactRevision,
      expected_version_id: created.versionId, block_kind: sample.kind,
      block_index: sample.index }), 200, lockCommand);
    const guard = (content: string) => requireAiTextLocks(createRepositories(database.db),
      storage, created.artifactId, content);
    await assert.rejects(guard(sample.changed));
    await guard(sample.adjacent);
    const saveCommand = randomUUID();
    const saved = expectCommandAccepted(await api.post(workspacePath(workspaceId,
      `/artifacts/${created.artifactId}/versions`), { command_id: saveCommand,
      expected_artifact_revision: locked.artifact_revision,
      expected_task_revision: created.taskRevision, media_type: 'text/markdown',
      content: sample.human }), 201, saveCommand);
    const after = await api.get(path);
    const rebound = (after.body as { locks: { status: string; base_version_id: string }[] }).locks[0]!;
    assert.equal(rebound.status, 'MAPPED');
    assert.equal(rebound.base_version_id, saved.version_id);
    await assert.rejects(guard(sample.afterHumanAi));
  }
  const legacy = await taskAndArtifact('# 旧记录\r\n\r\n第一行\r\n第二行');
  const lockCommand = randomUUID();
  const path = workspacePath(workspaceId, `/artifacts/${legacy.artifactId}/text-locks`);
  const locked = expectCommandAccepted(await api.post(path, { command_id: lockCommand,
    expected_artifact_revision: legacy.artifactRevision,
    expected_version_id: legacy.versionId, block_kind: 'PARAGRAPH',
    block_index: 1 }), 200, lockCommand);
  await sql`update artifact_text_locks set locked_text = ${'第一行\n第二行'}
    where artifact_id = ${legacy.artifactId}::uuid`.execute(database.db);
  const legacyGuard = (content: string) => requireAiTextLocks(createRepositories(database.db),
    storage, legacy.artifactId, content);
  await assert.rejects(legacyGuard('# 旧记录\r\n\r\n第一行\r\n第二行'));
  const saveCommand = randomUUID();
  const saved = await api.post(workspacePath(workspaceId, `/artifacts/${legacy.artifactId}/versions`), {
    command_id: saveCommand, expected_artifact_revision: locked.artifact_revision,
    expected_task_revision: legacy.taskRevision, media_type: 'text/markdown',
    content: '# 旧记录\r\n\r\n人工第一行\r\n第二行' });
  expectCommandAccepted(saved, 201, saveCommand);
  const legacyAfter = await api.get(path);
  assert.equal((legacyAfter.body as { locks: { status: string; text: string }[] }).locks[0]?.status, 'UNMAPPED');
  assert.equal((legacyAfter.body as { locks: { text: string }[] }).locks[0]?.text, '第一行\n第二行');
  await assert.rejects(legacyGuard('# 旧记录\r\n\r\n人工第一行\r\n第二行'));
});

test('manual impact analysis freezes versions and Fake output never applies a candidate automatically', async () => {
  const source = await taskAndArtifact('# 结果\n\n旧数据');
  const target = await taskAndArtifact('# 图表\n\n依赖旧数据');
  await new LineageRepository(database.db).insertExactEdge({ workspaceId,
    childVersionId: target.versionId, relation: 'DERIVED_FROM',
    parentKind: 'ARTIFACT_VERSION', parentId: source.versionId });
  const newCommand = randomUUID();
  const updated = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/artifacts/${source.artifactId}/versions`), { command_id: newCommand,
    expected_artifact_revision: source.artifactRevision,
    expected_task_revision: source.taskRevision, media_type: 'text/markdown',
    content: '# 结果\n\n新数据' }), 201, newCommand);
  const startCommand = randomUUID();
  const started = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/artifact-versions/${source.versionId}/impact-checks`), { command_id: startCommand,
    source_after_version_id: updated.version_id,
    expected_artifact_revision: updated.artifact_revision,
    analysis_target_version_ids: [target.versionId] }), 202, startCommand);
  const storage = new ManagedContentStore(api.dataRoot);
  const tick = await runAssistGenerationTick(database.db, { workerId: 'impact-fake',
    storage, modelPort: new FakeModelPort(), leaseMs: 30_000 });
  assert.equal(tick?.messageId, started.assistant_message_id);
  const check = await api.get(workspacePath(workspaceId,
    `/impact-checks/${started.impact_check_id}`));
  assert.equal(check.status, 200, check.text);
  const result = check.body as { status: string;
    direct_targets: { target_version_id: string; analysed: boolean }[];
    possibly_related: unknown[] };
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.direct_targets[0]?.target_version_id, target.versionId);
  assert.equal(result.direct_targets[0]?.analysed, true);
  const unselectedCommand = randomUUID();
  const unselected = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/artifact-versions/${source.versionId}/impact-checks`), { command_id: unselectedCommand,
    source_after_version_id: updated.version_id,
    expected_artifact_revision: updated.artifact_revision,
    analysis_target_version_ids: [] }), 202, unselectedCommand);
  await runAssistGenerationTick(database.db, { workerId: 'impact-no-target', storage,
    modelPort: new FakeModelPort(), leaseMs: 30_000 });
  const unselectedRead = await api.get(workspacePath(workspaceId,
    `/impact-checks/${unselected.impact_check_id}`));
  assert.equal(unselectedRead.status, 200, unselectedRead.text);
  const unselectedResult = unselectedRead.body as { possibly_related: unknown[];
    unanalysed_scope: string[]; direct_targets: { analysed: boolean }[] };
  assert.deepEqual(unselectedResult.possibly_related, []);
  assert.equal(unselectedResult.direct_targets[0]?.analysed, false);
  assert.ok(unselectedResult.unanalysed_scope.includes('未选入模型分析的直接引用正文'));
  const existing = await api.get(workspacePath(workspaceId, `/artifacts/${target.artifactId}`));
  assert.equal((existing.body as { latest_version_id: string }).latest_version_id, target.versionId);

  const lockCommand = randomUUID();
  const lock = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/artifacts/${target.artifactId}/text-locks`), { command_id: lockCommand,
    expected_artifact_revision: target.artifactRevision,
    expected_version_id: target.versionId, block_kind: 'PARAGRAPH', block_index: 1 }),
  200, lockCommand);
  const candidateCommand = randomUUID();
  const candidateStart = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/impact-checks/${started.impact_check_id}/candidates`), {
    command_id: candidateCommand, target_version_id: target.versionId,
    expected_target_revision: lock.artifact_revision, confirmed_possible: true,
  }), 202, candidateCommand);
  class ConflictingModelPort extends FakeModelPort {
    override async assist(request: AssistRequest): Promise<AssistResult> {
      if (request.intent !== 'IMPACT_CANDIDATE') return super.assist(request);
      return { kind: 'CONTENT', content: JSON.stringify({ markdown: '# 图表\n\nAI 覆盖原文' }),
        providerRequestId: 'fake-conflict', usage: { inputTokens: 10, outputTokens: 10 } };
    }
  }
  const candidateTick = await runAssistGenerationTick(database.db, { workerId: 'candidate-fake',
    storage, modelPort: new ConflictingModelPort(), leaseMs: 30_000 });
  assert.equal(candidateTick?.messageId, candidateStart.assistant_message_id);
  const applyCommand = randomUUID();
  const blocked = await api.post(workspacePath(workspaceId,
    `/impact-candidates/${candidateStart.candidate_id}/apply`), { command_id: applyCommand,
    expected_target_revision: lock.artifact_revision });
  expectProblem(blocked, 409, 'INVALID_TRANSITION');
  const afterBlocked = await api.get(workspacePath(workspaceId, `/artifacts/${target.artifactId}`));
  assert.equal((afterBlocked.body as { latest_version_id: string }).latest_version_id, target.versionId);

  const safeCommand = randomUUID();
  const safeStart = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/impact-checks/${started.impact_check_id}/candidates`), {
    command_id: safeCommand, target_version_id: target.versionId,
    expected_target_revision: lock.artifact_revision, confirmed_possible: true,
  }), 202, safeCommand);
  const safeTick = await runAssistGenerationTick(database.db, { workerId: 'safe-candidate-fake',
    storage, modelPort: new FakeModelPort(), leaseMs: 30_000 });
  assert.equal(safeTick?.messageId, safeStart.assistant_message_id);
  const applySafe = randomUUID();
  const applied = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/impact-candidates/${safeStart.candidate_id}/apply`), { command_id: applySafe,
    expected_target_revision: lock.artifact_revision }), 200, applySafe);
  assert.notEqual(applied.version_id, target.versionId);
  const replay = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/impact-candidates/${safeStart.candidate_id}/apply`), { command_id: applySafe,
    expected_target_revision: lock.artifact_revision }), 200, applySafe);
  assert.equal(replay.version_id, applied.version_id);
  expectProblem(await api.post(workspacePath(workspaceId,
    `/impact-candidates/${safeStart.candidate_id}/apply`), { command_id: randomUUID(),
    expected_target_revision: lock.artifact_revision }), 409, 'INVALID_TRANSITION');
  const lockAfterApply = await api.get(workspacePath(workspaceId,
    `/artifacts/${target.artifactId}/text-locks`));
  assert.equal(((lockAfterApply.body as { locks: { base_version_id: string }[] }).locks)[0]?.base_version_id,
    applied.version_id);
});

test('intervention receipts dedupe across requests and resolved reviews disappear', async () => {
  const reviewId = randomUUID();
  await new ReviewRepository(database.db).insertRequest({ id: reviewId, workspaceId,
    projectId: null, taskId: null, runId: null, verificationSessionId: null,
    criterionId: null, operationId: null, importJobId: null,
    kind: 'STATE_PROPOSAL', reason: '人工决定', targetHash: randomBytes(32),
    target: {}, evidence: {}, effect: {}, allowedDecisions: ['ACCEPT'], expiresAt: null });
  const first = await claimInterventionNotifications(database.db, workspaceId);
  assert.ok(first.some((item) => item.item_key === `review:${reviewId}`));
  const repeat = await claimInterventionNotifications(database.db, workspaceId);
  assert.ok(!repeat.some((item) => item.item_key === `review:${reviewId}`));
  await new ReviewRepository(database.db).decideRequest(reviewId, 0n);
  assert.ok(!(await listInterventionItems(database.db, workspaceId))
    .some((item) => item.item_key === `review:${reviewId}`));
});

test('invalid blank impact candidate cannot be applied after its read model reports FAILED', async () => {
  const source = await taskAndArtifact('# Source\n\nOld evidence');
  const target = await taskAndArtifact('# Target\n\nKeep this content');
  await new LineageRepository(database.db).insertExactEdge({ workspaceId,
    childVersionId: target.versionId, relation: 'DERIVED_FROM',
    parentKind: 'ARTIFACT_VERSION', parentId: source.versionId });
  const saveCommand = randomUUID();
  const updated = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/artifacts/${source.artifactId}/versions`), { command_id: saveCommand,
    expected_artifact_revision: source.artifactRevision,
    expected_task_revision: source.taskRevision, media_type: 'text/markdown',
    content: '# Source\n\nNew evidence' }), 201, saveCommand);
  const checkCommand = randomUUID();
  const check = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/artifact-versions/${source.versionId}/impact-checks`), { command_id: checkCommand,
    source_after_version_id: updated.version_id,
    expected_artifact_revision: updated.artifact_revision,
    analysis_target_version_ids: [target.versionId] }), 202, checkCommand);
  const storage = new ManagedContentStore(api.dataRoot);
  await runAssistGenerationTick(database.db, { workerId: 'blank-impact-check',
    storage, modelPort: new FakeModelPort(), leaseMs: 30_000 });
  for (const [caseName, output] of [
    ['blank', JSON.stringify({ markdown: '   ' })],
    ['malformed', '{"markdown":'],
    ['oversized', JSON.stringify({ markdown: 'x'.repeat(256 * 1024 + 1) })],
  ] as const) {
    const candidateCommand = randomUUID();
    const candidate = expectCommandAccepted(await api.post(workspacePath(workspaceId,
      `/impact-checks/${check.impact_check_id}/candidates`), { command_id: candidateCommand,
      target_version_id: target.versionId, expected_target_revision: target.artifactRevision,
      confirmed_possible: true }), 202, candidateCommand);
    class InvalidCandidateModelPort extends FakeModelPort {
      override async assist(request: AssistRequest): Promise<AssistResult> {
        if (request.intent !== 'IMPACT_CANDIDATE') return super.assist(request);
        return { kind: 'CONTENT', content: output,
          providerRequestId: `fake-${caseName}-candidate`, usage: { inputTokens: 1, outputTokens: 1 } };
      }
    }
    await runAssistGenerationTick(database.db, { workerId: `${caseName}-impact-candidate`,
      storage, modelPort: new InvalidCandidateModelPort(), leaseMs: 30_000 });
    const read = await api.get(workspacePath(workspaceId, `/impact-candidates/${candidate.candidate_id}`));
    assert.equal((read.body as { status: string; error_code: string }).status, 'FAILED', caseName);
    assert.equal((read.body as { error_code: string }).error_code, 'OUTPUT_SCHEMA_INVALID');
    const applyCommand = randomUUID();
    const applied = await api.post(workspacePath(workspaceId,
      `/impact-candidates/${candidate.candidate_id}/apply`), { command_id: applyCommand,
      expected_target_revision: target.artifactRevision });
    const after = await api.get(workspacePath(workspaceId, `/artifacts/${target.artifactId}`));
    assert.equal(applied.status, 409, JSON.stringify({ caseName, response: applied.body,
      originalVersionId: target.versionId, latestVersionId: (after.body as { latest_version_id: string }).latest_version_id }));
    expectProblem(applied, 409, 'INVALID_TRANSITION');
    assert.equal((after.body as { latest_version_id: string }).latest_version_id, target.versionId);
    const candidateAfter = await api.get(workspacePath(workspaceId,
      `/impact-candidates/${candidate.candidate_id}`));
    assert.equal((candidateAfter.body as { applied_version_id: string | null }).applied_version_id, null);
    const facts = await sql<{ versions: string; activities: string }>`
      select (select count(*) from artifact_versions where artifact_id = ${target.artifactId}::uuid) as versions,
        (select count(*) from activity_records where command_id = ${applyCommand}::uuid) as activities`
      .execute(database.db);
    assert.equal(facts.rows[0]?.versions, 1n);
    assert.equal(facts.rows[0]?.activities, 0n);
  }
});

test('latest failed Run remains actionable after Task execution pointer is released', async () => {
  const created = await taskAndArtifact('# 输出\n\n人工内容');
  await sql`update tasks set status = 'READY' where id = ${created.taskId}`.execute(database.db);
  const delegated = await delegateTask(database.db, { workspaceId, taskId: created.taskId,
    commandId: randomUUID(), expectedTaskRevision: created.taskRevision });
  const runId = delegated.result.run_id;
  const run = await new RunRepository(database.db).readRun(runId);
  assert.ok(run);
  await new RunRepository(database.db).advanceRun({ runId, expectedRevision: run.revision,
    status: 'FAILED', waitReason: '需要人工核对', terminal: true });
  const task = await new TaskRepository(database.db).readTask(created.taskId);
  assert.ok(task);
  const released = await new TaskRepository(database.db).releaseExecutionFromRun({
    taskId: created.taskId, runId, expectedRevision: task.revision, toStatus: 'READY' });
  assert.equal(released?.executor_run_id, null);
  const items = await listInterventionItems(database.db, workspaceId);
  assert.ok(items.some((item) => item.item_key === `run-failed:${runId}` &&
    item.target_url === `/runs/${runId}`));
});
