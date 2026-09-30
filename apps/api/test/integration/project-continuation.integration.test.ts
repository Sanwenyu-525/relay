import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createProject } from '../../src/application/create-project.js';
import { createTask } from '../../src/application/create-task.js';
import { editTaskPresentation } from '../../src/application/task-commands.js';
import { runStateCommand } from '../../src/application/state-commands.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { createWorkspace, expectProblem, startTestApi, workspacePath }
  from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-n01-continuation');
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
});
after(async () => { await app.close(); });

const newTask = async (workspaceId: string, projectId: string, title: string) =>
  (await createTask(app.db, { workspaceId, commandId: randomUUID(), projectId, title,
    objective: title, criteria: [], expectedOutputs: {}, mode: 'ME' })).result.task_id;

/** 用应用角色与真实 Repository 播种 Artifact 版本，与 api-state 集成测试同一路径。 */
async function seedArtifact(workspaceId: string, projectId: string, taskId: string):
Promise<string> {
  return withTransaction(app.db, async (repositories) => {
    const artifactId = randomUUID();
    await repositories.artifacts.insertArtifact({ id: artifactId, workspaceId, projectId, taskId,
      artifactKind: 'MARKDOWN_DOCUMENT', title: 'continuation-artifact' });
    return artifactId;
  });
}

/** 同一 Artifact 追加新版本，旧版本永不覆盖。 */
async function appendArtifactVersion(artifactId: string, versionNumber: bigint): Promise<string> {
  return withTransaction(app.db, async (repositories) => {
    const versionId = randomUUID();
    await repositories.artifacts.insertArtifactVersion({ id: versionId, artifactId, versionNumber,
      storageRef: `artifacts/${artifactId}/v${versionNumber}/content.md`,
      contentHash: createHash('sha256').update(`body-${versionNumber}`, 'utf8').digest(),
      size: 4n, mediaType: 'text/markdown', sourceKind: 'HUMAN', sourceRef: null });
    return versionId;
  });
}

test('N01 接续点捕获当前事实、比较真实变化，且不产生第二套业务状态', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: '接续点', projectType: 'DEVELOPMENT' });
  const projectId = project.result.project_id;
  const firstTaskId = await newTask(workspaceId, projectId, '未决一');
  const secondTaskId = await newTask(workspaceId, projectId, '未决二');
  const api = await startTestApi();
  try {
    const collection = `${workspacePath(workspaceId)}/projects/${projectId}/continuation-points`;
    const commandId = randomUUID();
    const captured = await api.post(collection,
      { command_id: commandId, name: '收工前', note: '等评审' });
    assert.equal(captured.status, 201);
    const point = (captured.body as { result: { id: string; ref_count: number;
      captured_state: { phase_key: string; revision: string };
      refs: { ref_kind: string; ref_id: string; captured_revision: string }[] } }).result;
    assert.equal(point.captured_state.phase_key, 'DISCOVERY');
    assert.equal(point.captured_state.revision, '0');
    assert.equal(point.ref_count, 2);
    assert.deepEqual(point.refs.map((ref) => ref.ref_id).sort(),
      [firstTaskId, secondTaskId].sort());
    assert.ok(point.refs.every((ref) => ref.ref_kind === 'TASK' && ref.captured_revision === '0'));

    const replay = await api.post(collection, { command_id: commandId, name: '收工前', note: '等评审' });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers['command-replayed'], 'true');
    assert.deepEqual((replay.body as { result: unknown }).result, point);

    const listed = await api.get(collection);
    assert.equal(listed.status, 200);
    assert.equal((listed.body as { items: { id: string }[] }).items.length, 1);
    const single = await api.get(`${collection}/${point.id}`);
    assert.equal(single.status, 200);
    assert.equal((single.body as { refs: unknown[] }).refs.length, 2);

    // 捕获本身不得改写 Project、Project State 或 Task 的任何事实。
    const untouched = await sql<{ project_revision: string; state_revision: string }>`
      select p.revision::text as project_revision, ps.revision::text as state_revision
      from projects p join project_states ps on ps.project_id = p.id
      where p.id = ${projectId}`.execute(app.db);
    assert.deepEqual(untouched.rows[0], { project_revision: '0', state_revision: '0' });

    await runStateCommand(app.db, { workspaceId, projectId, commandId: randomUUID(),
      expectedRevision: '0', action: 'SET_PHASE', params: { phase_key: 'IMPLEMENTATION' } });
    await editTaskPresentation(app.db, { workspaceId, taskId: firstTaskId,
      commandId: randomUUID(), expectedRevision: '0', title: '未决一（改过标题）' });
    const addedTaskId = await newTask(workspaceId, projectId, '未决三');

    const compared = await api.get(`${collection}/${point.id}/comparison`);
    assert.equal(compared.status, 200);
    const comparison = compared.body as { current_state: { phase_key: string; revision: string };
      facts: { state_revision_changed: boolean; phase_changed: boolean;
        task_added: { task_id: string; status: string }[] };
      ref_changes: { ref_id: string; change: string; current_revision: string | null }[];
      interpretation: null };
    assert.equal(comparison.facts.state_revision_changed, true);
    assert.equal(comparison.facts.phase_changed, true);
    assert.equal(comparison.current_state.phase_key, 'IMPLEMENTATION');
    assert.deepEqual(comparison.facts.task_added.map((task) => task.task_id), [addedTaskId]);
    const changes = new Map(comparison.ref_changes.map((ref) => [ref.ref_id, ref]));
    assert.equal(changes.get(firstTaskId)?.change, 'REVISED');
    assert.equal(changes.get(firstTaskId)?.current_revision, '1');
    assert.equal(changes.get(secondTaskId)?.change, 'UNCHANGED');
    assert.equal(comparison.interpretation, null);
  } finally { await api.stop(); }
});

test('N01 接续点拒绝跨作用域读取、非法输入与已归档项目', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: '接续点边界', projectType: 'GENERAL' });
  const projectId = project.result.project_id;
  const api = await startTestApi();
  try {
    const collection = `${workspacePath(workspaceId)}/projects/${projectId}/continuation-points`;
    const captured = await api.post(collection,
      { command_id: randomUUID(), name: '边界', note: null });
    assert.equal(captured.status, 201);
    const pointId = (captured.body as { result: { id: string } }).result.id;

    const blank = await api.post(collection, { command_id: randomUUID(), name: '   ', note: null });
    expectProblem(blank, 422, 'VALIDATION_FAILED');
    const unknownField = await api.post(collection, { command_id: randomUUID(), name: '越界字段',
      note: null, rollback: true });
    expectProblem(unknownField, 422, 'VALIDATION_FAILED');
    expectProblem(await api.get(`${collection}/${randomUUID()}`), 404, 'RESOURCE_NOT_FOUND');

    const otherWorkspaceId = await createWorkspace(app.db);
    expectProblem(await api.get(`${workspacePath(otherWorkspaceId)}/projects/${projectId}` +
      `/continuation-points/${pointId}`), 404, 'RESOURCE_NOT_FOUND');

    const archived = await api.post(`${workspacePath(workspaceId)}/projects/${projectId}/archive`,
      { command_id: randomUUID(), expected_revision: '0' });
    assert.equal(archived.status, 200);
    const afterArchive = await api.post(collection,
      { command_id: randomUUID(), name: '归档后', note: null });
    expectProblem(afterArchive, 409, 'PROJECT_ARCHIVED');
  } finally { await api.stop(); }
});

test('N01 接续点覆盖成果版本引用，并区分 CURRENT 与 SUPERSEDED', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: '成果引用', projectType: 'DEVELOPMENT' });
  const projectId = project.result.project_id;
  const taskId = await newTask(workspaceId, projectId, '产物任务');
  const artifactId = await seedArtifact(workspaceId, projectId, taskId);
  const firstVersionId = await appendArtifactVersion(artifactId, 1n);
  await runStateCommand(app.db, { workspaceId, projectId, commandId: randomUUID(),
    expectedRevision: '0', action: 'SELECT_ARTIFACT_VERSION',
    params: { artifact_version_id: firstVersionId, source_ref: `task:${taskId}` } });
  const api = await startTestApi();
  try {
    const collection = `${workspacePath(workspaceId)}/projects/${projectId}/continuation-points`;
    const captured = await api.post(collection,
      { command_id: randomUUID(), name: '选定 v1', note: null });
    assert.equal(captured.status, 201);
    const point = (captured.body as { result: { id: string; ref_count: number;
      refs: { ref_kind: string; ref_id: string; captured_revision: string }[] } }).result;
    assert.equal(point.ref_count, 2);
    const versionRef = point.refs.find((ref) => ref.ref_kind === 'ARTIFACT_VERSION');
    assert.equal(versionRef?.ref_id, firstVersionId);
    assert.equal(versionRef?.captured_revision, '1');

    const secondVersionId = await appendArtifactVersion(artifactId, 2n);
    const supersededCheck = await api.get(`${collection}/${point.id}/comparison`);
    const changes = new Map((supersededCheck.body as { ref_changes: { ref_kind: string;
      ref_id: string; change: string; current_revision: string | null;
      note: string | null }[] }).ref_changes
      .map((ref) => [`${ref.ref_kind}:${ref.ref_id}`, ref]));
    const firstChange = changes.get(`ARTIFACT_VERSION:${firstVersionId}`);
    assert.equal(firstChange?.change, 'SUPERSEDED');
    assert.equal(firstChange?.current_revision, '1');
    assert.match(String(firstChange?.note), /v2/u);

    await runStateCommand(app.db, { workspaceId, projectId, commandId: randomUUID(),
      expectedRevision: '1', action: 'SELECT_ARTIFACT_VERSION',
      params: { artifact_version_id: secondVersionId, source_ref: `task:${taskId}` } });
    const recaptured = await api.post(collection,
      { command_id: randomUUID(), name: '选定后', note: null });
    const recapturedId = (recaptured.body as { result: { id: string } }).result.id;
    const current = await api.get(`${collection}/${recapturedId}/comparison`);
    const currentChanges = new Map((current.body as { ref_changes: { ref_kind: string;
      ref_id: string; change: string; captured_revision: string }[] }).ref_changes
      .map((ref) => [`${ref.ref_kind}:${ref.ref_id}`, ref]));
    // state_artifact_refs 只插不删：重选 v2 后 State 同时持有 v1 与 v2，接续点因此捕获两条。
    // 必须按 ref_id 断言；按 ref_kind 取第一条会随 UUID 排序在 v1/v2 之间摇摆。
    assert.equal(currentChanges.get(`ARTIFACT_VERSION:${firstVersionId}`)?.change, 'SUPERSEDED');
    const secondChange = currentChanges.get(`ARTIFACT_VERSION:${secondVersionId}`);
    assert.equal(secondChange?.captured_revision, '2');
    assert.equal(secondChange?.change, 'CURRENT');
  } finally { await api.stop(); }
});

test('N01 引用目标的 CHECK 拒绝 NULL 脏行（0045 修复的 NULL 不安全）', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: '脏行栅栏', projectType: 'GENERAL' });
  const projectId = project.result.project_id;
  const taskId = await newTask(workspaceId, projectId, '脏行任务');
  const api = await startTestApi();
  try {
    const collection = `${workspacePath(workspaceId)}/projects/${projectId}/continuation-points`;
    const captured = await api.post(collection,
      { command_id: randomUUID(), name: '栅栏', note: null });
    const pointId = (captured.body as { result: { id: string } }).result.id;
    const dirty: readonly { label: string; kind: string; refId: string; taskId: string | null;
      artifactVersionId: string | null }[] = [
      { label: 'TASK 缺 task_id', kind: 'TASK', refId: taskId, taskId: null,
        artifactVersionId: null },
      { label: 'ARTIFACT_VERSION 缺 artifact_version_id', kind: 'ARTIFACT_VERSION',
        refId: randomUUID(), taskId: null, artifactVersionId: null },
      { label: 'ref_kind 与目标列错配', kind: 'ARTIFACT_VERSION', refId: randomUUID(),
        taskId: null, artifactVersionId: null },
    ];
    for (const row of dirty) {
      let rejected = false;
      try {
        await sql`insert into project_continuation_point_refs (continuation_point_id, ref_kind,
          ref_id, ref_revision, ordinal, task_id, artifact_version_id)
          values (${pointId}, ${row.kind}, ${row.refId}, 0, 90, ${row.taskId},
            ${row.artifactVersionId})`.execute(app.db);
      } catch { rejected = true; }
      assert.equal(rejected, true, `脏行未被拒绝：${row.label}`);
    }
    const refs = await sql<{ count: string }>`select count(*)::text as count
      from project_continuation_point_refs where continuation_point_id = ${pointId}`
      .execute(app.db);
    assert.equal(refs.rows[0]!.count, '1');
  } finally { await api.stop(); }
});