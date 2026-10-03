import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createProject } from '../../src/application/create-project.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { createWorkspace, expectCommandAccepted, expectProblem, startTestApi,
  workspacePath, type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-n03-guide');
const migrator = openDatabase(MIGRATION_DATABASE_URL, 'relay-api-test-n03-migrator');
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
});
after(async () => { await app.close(); await migrator.close(); });

async function startTask(api: TestApi, workspaceId: string, projectId: string, title: string) {
  const createId = randomUUID();
  const task = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/tasks'),
    { command_id: createId, project_id: projectId, title, objective: title,
      criteria: [{ criterion_id: 'c1', statement: '人工核对来源' }] }), 201, createId);
  const taskId = String(task.task_id);
  const readyId = randomUUID();
  const ready = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${taskId}/ready`), { command_id: readyId, expected_revision: String(task.revision) }),
  200, readyId);
  const startId = randomUUID();
  expectCommandAccepted(await api.post(workspacePath(workspaceId, `/tasks/${taskId}/start`),
    { command_id: startId, expected_revision: String(ready.revision) }), 200, startId);
  return taskId;
}

/** 走既有 Information 命令登记资料与决定，返回确切 ID；导读不新增这些对象的写入口。 */
/** 走既有 Information 命令登记资料；导读不新增这些对象的写入口。 */
async function seedKnowledge(api: TestApi, workspaceId: string, projectId: string, title: string) {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/knowledge'), {
    command_id: commandId, project_id: projectId, title,
    source_kind: 'NOTE', text: `${title} 正文。` });
  const knowledgeId = String(expectCommandAccepted(response, 201, commandId).knowledge_id);
  const listed = await api.get(workspacePath(workspaceId, `/knowledge/${knowledgeId}/versions`));
  const versions = listed.body as { id: string }[];
  return { knowledgeId, versionId: versions[0]!.id };
}

async function seedDecision(api: TestApi, workspaceId: string, projectId: string, title: string) {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/decisions'), {
    command_id: commandId, project_id: projectId, title, choice: '方案一', rationale: '取证需要',
    alternatives: [], costs: [] });
  return String(expectCommandAccepted(response, 201, commandId).decision_id);
}

interface GuideView {
  readonly exists: boolean;
  readonly revision: string;
  readonly entry_count: number;
  readonly entries: readonly { ordinal: number; ref_kind: string; reference_mode: string;
    target_id: string; label: string | null; resolved_version_id: string | null;
    is_current: boolean; resolution: string; note: string }[];
  readonly gaps: readonly string[];
}

test('N03 导读按确切引用编排：PINNED 与 CURRENT 可分辨，替换式保存不产生第二份正文', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'guide', projectType: 'THESIS' });
  const projectId = project.result.project_id;
  const api = await startTestApi();
  try {
    const taskId = await startTask(api, workspaceId, projectId, '导读任务');
    const knowledge = await seedKnowledge(api, workspaceId, projectId, '知识一');
    const decisionId = await seedDecision(api, workspaceId, projectId, '决定一');

    const guideUrl = `${workspacePath(workspaceId)}/projects/${projectId}/knowledge-guide`;
    const empty = (await api.get(guideUrl)).body as GuideView;
    assert.equal(empty.exists, false);
    assert.equal(empty.revision, '0');
    assert.equal(empty.entry_count, 0);

    const saveId = randomUUID();
    const saved = await api.request('PUT', guideUrl, { body: { command_id: saveId,
      expected_revision: '0', entries: [
        { ref_kind: 'KNOWLEDGE', reference_mode: 'PINNED',
          knowledge_id: knowledge.knowledgeId, pinned_version_id: knowledge.versionId,
          label: '先读这条' },
        { ref_kind: 'DECISION', reference_mode: 'CURRENT', decision_id: decisionId }] } });
    assert.equal(saved.status, 200, saved.text);
    const result = expectCommandAccepted(saved, 200, saveId);
    assert.equal(result.entry_count, '2');
    assert.equal(result.revision, '1');

    const view = (await api.get(guideUrl)).body as GuideView;
    assert.equal(view.exists, true);
    assert.equal(view.revision, '1');
    assert.equal(view.entry_count, 2);
    assert.equal(view.entries[0]?.label, '先读这条');
    assert.equal(view.entries[0]?.resolution, 'AVAILABLE');
    assert.equal(view.entries[0]?.is_current, true);
    assert.equal(view.entries[0]?.resolved_version_id, knowledge.versionId);
    assert.equal(view.entries[1]?.resolution, 'AVAILABLE');

    // 保存导读不改写任何被引用的对象，也不新增知识版本。
    const versions = await api.get(workspacePath(workspaceId,
      `/knowledge/${knowledge.knowledgeId}/versions`));
    assert.equal((versions.body as unknown[]).length, 1);

    // 旧 revision 被拒；同 command 重放返回原回执。
    const staleId = randomUUID();
    const stale = await api.request('PUT', guideUrl, { body: { command_id: staleId,
      expected_revision: '0', entries: [] } });
    expectProblem(stale, 409, 'REVISION_CONFLICT');
    const replay = await api.request('PUT', guideUrl, { body: { command_id: saveId,
      expected_revision: '0', entries: [
        { ref_kind: 'KNOWLEDGE', reference_mode: 'PINNED',
          knowledge_id: knowledge.knowledgeId, pinned_version_id: knowledge.versionId,
          label: '先读这条' },
        { ref_kind: 'DECISION', reference_mode: 'CURRENT', decision_id: decisionId }] } });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers['command-replayed'], 'true');
    assert.equal(((await api.get(guideUrl)).body as GuideView).revision, '1');

    // 知识新增版本后：PINNED 仍解析到钉住的确切版本并标为 STALE，CURRENT 跟随当前。
    const addVersionId = randomUUID();
    const added = expectCommandAccepted(await api.post(workspacePath(workspaceId,
      `/knowledge/${knowledge.knowledgeId}/versions`),
      { command_id: addVersionId, expected_revision: '0',
      source_kind: 'NOTE', text: '知识一 的第二版。' }), 200, addVersionId);
    const reListed = await api.get(workspacePath(workspaceId,
      `/knowledge/${knowledge.knowledgeId}/versions`));
    const newVersionId = (reListed.body as { id: string }[])[0]!.id;
    assert.notEqual(newVersionId, knowledge.versionId);
    assert.equal(added.knowledge_id, knowledge.knowledgeId);
    const after = (await api.get(guideUrl)).body as GuideView;
    assert.equal(after.entries[0]?.resolved_version_id, knowledge.versionId);
    assert.equal(after.entries[0]?.is_current, false);
    assert.equal(after.entries[0]?.resolution, 'STALE');
    assert.match(after.entries[0]?.note ?? '', /仍按钉住的确切版本阅读/u);

    const currentId = randomUUID();
    expectCommandAccepted(await api.request('PUT', guideUrl, { body: { command_id: currentId,
      expected_revision: '1', entries: [
        { ref_kind: 'KNOWLEDGE', reference_mode: 'CURRENT',
          knowledge_id: knowledge.knowledgeId }] } }), 200, currentId);
    const followed = (await api.get(guideUrl)).body as GuideView;
    assert.equal(followed.entries[0]?.resolved_version_id, newVersionId);
    assert.equal(followed.entries[0]?.is_current, true);
    void taskId;
  } finally { await api.stop(); }
});

test('N03 导读拒绝错配目标、重复条目与跨项目引用', async () => {
  const workspaceId = await createWorkspace(app.db);
  const first = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'guide-a', projectType: 'THESIS' });
  const second = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'guide-b', projectType: 'THESIS' });
  const api = await startTestApi();
  try {
    await startTask(api, workspaceId, first.result.project_id, '甲任务');
    await startTask(api, workspaceId, second.result.project_id, '乙任务');
    const mine = await seedKnowledge(api, workspaceId, first.result.project_id, '本项目知识');
    const other = await seedKnowledge(api, workspaceId, second.result.project_id, '他项目知识');
    const guideUrl = `${workspacePath(workspaceId)}/projects/${first.result.project_id}/knowledge-guide`;

    const put = async (entries: unknown[]) => api.request('PUT', guideUrl,
      { body: { command_id: randomUUID(), expected_revision: '0', entries } });

    // ref_kind 与目标列错配
    expectProblem(await put([{ ref_kind: 'DECISION', reference_mode: 'CURRENT',
      knowledge_id: mine.knowledgeId }]), 409, 'INVALID_TRANSITION');
    // 同时给两个目标
    expectProblem(await put([{ ref_kind: 'KNOWLEDGE', reference_mode: 'CURRENT',
      knowledge_id: mine.knowledgeId, decision_id: other.knowledgeId }]), 409,
    'INVALID_TRANSITION');
    // 重复引用同一对象
    expectProblem(await put([
      { ref_kind: 'KNOWLEDGE', reference_mode: 'CURRENT', knowledge_id: mine.knowledgeId },
      { ref_kind: 'KNOWLEDGE', reference_mode: 'CURRENT', knowledge_id: mine.knowledgeId }]),
    409, 'INVALID_TRANSITION');
    // PINNED 必须给出确切知识版本
    expectProblem(await put([{ ref_kind: 'KNOWLEDGE', reference_mode: 'PINNED',
      knowledge_id: mine.knowledgeId }]), 409, 'INVALID_TRANSITION');
    // CURRENT 不能同时钉版本
    expectProblem(await put([{ ref_kind: 'KNOWLEDGE', reference_mode: 'CURRENT',
      knowledge_id: mine.knowledgeId, pinned_version_id: mine.versionId }]), 409,
    'INVALID_TRANSITION');
    // 钉住不属于该知识的版本
    expectProblem(await put([{ ref_kind: 'KNOWLEDGE', reference_mode: 'PINNED',
      knowledge_id: mine.knowledgeId, pinned_version_id: other.versionId }]), 409,
    'INVALID_TRANSITION');
    // 非知识类型不允许 PINNED
    const decisionId = await seedDecision(api, workspaceId, first.result.project_id, '决定一');
    expectProblem(await put([{ ref_kind: 'DECISION', reference_mode: 'PINNED',
      decision_id: decisionId, pinned_version_id: mine.versionId }]), 409,
    'INVALID_TRANSITION');
    // 跨项目引用
    expectProblem(await put([{ ref_kind: 'KNOWLEDGE', reference_mode: 'CURRENT',
      knowledge_id: other.knowledgeId }]), 409, 'INVALID_TRANSITION');

    assert.equal(((await api.get(guideUrl)).body as GuideView).exists, false);

    // CHECK 与外键真的挡住脏行：目标列错配、ref_kind 不符、钉版本与模式冲突。
    const rows: readonly { label: string; entry: Record<string, unknown> }[] = [
      { label: 'ref_kind 与目标列错配', entry: { ordinal: 0, ref_kind: 'DECISION',
        reference_mode: 'CURRENT', knowledge_id: mine.knowledgeId } },
      { label: '两个目标列同时非空', entry: { ordinal: 0, ref_kind: 'KNOWLEDGE',
        reference_mode: 'CURRENT', knowledge_id: mine.knowledgeId, decision_id: randomUUID() } },
      { label: 'PINNED 缺 pinned_version_id', entry: { ordinal: 0, ref_kind: 'KNOWLEDGE',
        reference_mode: 'PINNED', knowledge_id: mine.knowledgeId } },
      { label: 'CURRENT 却带 pinned_version_id', entry: { ordinal: 0, ref_kind: 'KNOWLEDGE',
        reference_mode: 'CURRENT', knowledge_id: mine.knowledgeId,
        pinned_version_id: mine.versionId } },
      { label: 'ref_kind 为空标签', entry: { ordinal: 0, ref_kind: 'MEMORY',
        reference_mode: 'CURRENT', knowledge_id: mine.knowledgeId } },
    ];
    for (const row of rows) {
      await assert.rejects(async () => {
        await withTransaction(app.db, async (r) => {
          const guide = await r.knowledgeGuides.insertGuide({ id: randomUUID(),
            workspaceId, projectId: first.result.project_id });
          await sql`insert into project_knowledge_guide_entries (guide_id, ordinal, ref_kind,
            reference_mode, knowledge_id, decision_id, pinned_version_id)
            values (${guide.id}, ${String(row.entry.ordinal)}, ${String(row.entry.ref_kind)},
              ${String(row.entry.reference_mode)}, ${row.entry.knowledge_id as string},
              ${(row.entry.decision_id as string) ?? null},
              ${(row.entry.pinned_version_id as string) ?? null})`.execute(app.db);
        });
      }, `脏行未被拒绝：${row.label}`);
    }
  } finally { await api.stop(); }
});

interface SavedArtifact { artifactId: string; versionId: string;
  artifactRevision: string; taskRevision: string }

/** 首个版本建新成果；之后按原成果追加新版本，用来验证来源基线失效。 */
async function appendArtifactVersion(api: TestApi, workspaceId: string, taskId: string,
  title: string, content: string, previous?: SavedArtifact): Promise<SavedArtifact> {
  // 每次保存都读当前 Task 修订：成果写入会多次推进 Task 修订，不靠上次返回值推算。
  const task = await api.get(workspacePath(workspaceId, `/tasks/${taskId}`));
  assert.equal(task.status, 200, task.text);
  const taskRevision = String((task.body as { revision: string }).revision);
  const commandId = randomUUID();
  let response;
  if (previous === undefined) {
    response = await api.post(workspacePath(workspaceId, `/tasks/${taskId}/artifacts`),
      { command_id: commandId, expected_task_revision: taskRevision, title,
        media_type: 'text/markdown', content });
  } else {
    // Artifact 修订也可能已被别的命令推进，每次都读当前值，不靠上次返回值推算。
    const artifact = await api.get(workspacePath(workspaceId,
      `/artifacts/${previous.artifactId}`));
    assert.equal(artifact.status, 200, artifact.text);
    response = await api.post(workspacePath(workspaceId,
      `/artifacts/${previous.artifactId}/versions`),
    { command_id: commandId,
      expected_artifact_revision: String((artifact.body as { revision: string }).revision),
      expected_task_revision: taskRevision, media_type: 'text/markdown', content });
  }
  const result = expectCommandAccepted(response, 201, commandId);
  return { artifactId: String(result.artifact_id), versionId: String(result.version_id),
    artifactRevision: String(result.artifact_revision),
    taskRevision: String(result.task_revision) };
}

interface CandidateView {
  readonly id: string;
  readonly source_artifact_version_id: string;
  readonly suggested_title: string;
  readonly suggested_knowledge_id: string | null;
  readonly similar: readonly { knowledge_id: string; title: string; reason: string }[];
  readonly status: string;
  readonly accepted_knowledge_id: string | null;
  readonly accepted_knowledge_version_id: string | null;
  readonly stale_reason: string | null;
  readonly rejected_at: string | null;
}

test('N03 整理候选只提示不合并；接受走既有知识命令，来源变化后旧候选失效', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'curation', projectType: 'THESIS' });
  const projectId = project.result.project_id;
  const api = await startTestApi();
  try {
    const taskId = await startTask(api, workspaceId, projectId, '整理任务');
    const artifact = await appendArtifactVersion(api, workspaceId, taskId, '调研笔记',
      '# 调研笔记\n正文。\n');
    const base = `${workspacePath(workspaceId)}/projects/${projectId}`;

    // 用户主动请求：候选只是建议，此刻不产生任何知识版本。
    const createId = randomUUID();
    const created = expectCommandAccepted(await api.post(
      `${base}/knowledge-curation-candidates`,
    { command_id: createId, sources: [{ artifact_version_id: artifact.versionId,
      suggested_title: '调研笔记' }] }), 201, createId);
    const candidateIds = created.candidate_ids as string[];
    assert.equal(candidateIds.length, 1);
    const listed = (await api.get(`${base}/knowledge-curation-candidates`)).body as
      { items: CandidateView[] };
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0]?.status, 'PROPOSED');
    assert.equal(listed.items[0]?.suggested_knowledge_id, null);
    assert.deepEqual(listed.items[0]?.similar, []);
    const knowledgeNow = await api.get(workspacePath(workspaceId, `/knowledge?project_id=${projectId}`));
    assert.equal((knowledgeNow.body as unknown[]).length, 0);

    // 同标题的知识存在时：只提示相似并建议归入，不自动合并。
    const seedId = randomUUID();
    expectCommandAccepted(await api.post(workspacePath(workspaceId, '/knowledge'),
    { command_id: seedId, project_id: projectId, title: '调研笔记',
      source_kind: 'NOTE', text: '既有笔记。' }), 201, seedId);
    const dupId = randomUUID();
    const dup = expectCommandAccepted(await api.post(
      `${base}/knowledge-curation-candidates`,
    { command_id: dupId, sources: [{ artifact_version_id: artifact.versionId }] }), 201, dupId);
    const dupCandidateId = (dup.candidate_ids as string[])[0]!;
    const dupView = ((await api.get(`${base}/knowledge-curation-candidates`)).body as
      { items: CandidateView[] }).items.find((item) => item.id === dupCandidateId)!;
    assert.equal(dupView.suggested_knowledge_id !== null, true);
    assert.equal(dupView.similar.length, 1);
    assert.match(dupView.similar[0]!.reason, /完全相同/u);
    // 提示不改变既有知识，也不新增版本。
    const afterHint = await api.get(workspacePath(workspaceId,
      `/knowledge/${dupView.suggested_knowledge_id!}/versions`));
    assert.equal((afterHint.body as unknown[]).length, 1);

    // 接受：走既有 AddKnowledgeVersion，产生新版本且旧版本不被覆盖。
    const acceptId = randomUUID();
    const accepted = expectCommandAccepted(await api.post(
      `${base}/knowledge-curation-candidates/${dupCandidateId}/accept`,
    { command_id: acceptId }), 200, acceptId);
    assert.equal(accepted.mode, 'NEW_VERSION');
    assert.equal(accepted.knowledge_id, dupView.suggested_knowledge_id);
    const afterAccept = await api.get(workspacePath(workspaceId,
      `/knowledge/${accepted.knowledge_id}/versions`));
    assert.equal((afterAccept.body as unknown[]).length, 2);
    assert.equal(accepted.knowledge_version_id,
      (afterAccept.body as { id: string }[])[0]!.id);

    // 接受不复用新命令身份重发：已接受的候选只能按原命令查回执，不能再产生版本。
    expectProblem(await api.post(`${base}/knowledge-curation-candidates/${dupCandidateId}/accept`,
    { command_id: randomUUID() }), 409, 'INVALID_TRANSITION');
    const versionsAfterReplay = await api.get(workspacePath(workspaceId,
      `/knowledge/${accepted.knowledge_id}/versions`));
    assert.equal((versionsAfterReplay.body as unknown[]).length, 2);

    // 来源成果再变一版后，旧候选标为 STALE 且不能接受。
    await appendArtifactVersion(api, workspaceId, taskId, '调研笔记', '# 调研笔记\n改过了。\n',
      artifact);
    const staleId = randomUUID();
    const stale = expectCommandAccepted(await api.post(
      `${base}/knowledge-curation-candidates`,
    { command_id: staleId, sources: [{ artifact_version_id: artifact.versionId,
      suggested_title: '另一条笔记' }] }), 201, staleId);
    const staleCandidateId = (stale.candidate_ids as string[])[0]!;
    await appendArtifactVersion(api, workspaceId, taskId, '调研笔记', '# 调研笔记\n又改了。\n',
      artifact);
    const staleView = ((await api.get(`${base}/knowledge-curation-candidates`)).body as
      { items: CandidateView[] }).items.find((item) => item.id === staleCandidateId)!;
    assert.equal(staleView.status, 'STALE');
    assert.match(staleView.stale_reason ?? '', /来源成果已变化/u);
    expectProblem(await api.post(`${base}/knowledge-curation-candidates/${staleCandidateId}/accept`,
    { command_id: randomUUID() }), 409, 'INVALID_TRANSITION');

    // P2-1：拒绝是终态，读取模型必须能表达，不能继续报 PROPOSED。
    const rejectReadId = randomUUID();
    expectCommandAccepted(await api.post(`${base}/knowledge-curation-candidates`,
    { command_id: rejectReadId, sources: [{ artifact_version_id: artifact.versionId,
      suggested_title: '拒绝后读取' }] }), 201, rejectReadId);
    const rejectReadList = (await api.get(`${base}/knowledge-curation-candidates`)).body as
      { items: CandidateView[] };
    const rejectReadCandidate = rejectReadList.items.find((item) =>
      item.suggested_title === '拒绝后读取')!;
    const rejectReadCommandId = randomUUID();
    expectCommandAccepted(await api.post(
      `${base}/knowledge-curation-candidates/${rejectReadCandidate.id}/reject`,
    { command_id: rejectReadCommandId }), 200, rejectReadCommandId);
    const afterRejectRead = ((await api.get(`${base}/knowledge-curation-candidates`)).body as
      { items: CandidateView[] }).items.find((item) => item.id === rejectReadCandidate.id)!;
    assert.equal(afterRejectRead.status, 'REJECTED');
    assert.equal(typeof afterRejectRead.rejected_at, 'string');
    assert.equal(afterRejectRead.stale_reason, null);

    // P2-4：工作空间级同名知识不得成为建议归入目标（否则是永远无法执行的动作）。
    const wsKnowledgeId = randomUUID();
    expectCommandAccepted(await api.post(workspacePath(workspaceId, '/knowledge'),
    { command_id: wsKnowledgeId, project_id: null, title: '空间级笔记',
      source_kind: 'NOTE', text: '工作空间级。' }), 201, wsKnowledgeId);
    // 用当前最新版本：上面的 STALE 用例已给同一成果追加过版本，旧版本提的候选本就失效。
    const wsArtifact = await appendArtifactVersion(api, workspaceId, taskId, '空间级来源',
      '# 空间级来源\n');
    const wsDupId = randomUUID();
    expectCommandAccepted(await api.post(`${base}/knowledge-curation-candidates`,
    { command_id: wsDupId, sources: [{ artifact_version_id: wsArtifact.versionId,
      suggested_title: '空间级笔记' }] }), 201, wsDupId);
    const wsDupList = (await api.get(`${base}/knowledge-curation-candidates`)).body as
      { items: CandidateView[] };
    const wsDup = wsDupList.items.find((item) => item.suggested_title === '空间级笔记')!;
    assert.equal(wsDup.suggested_knowledge_id, null);
    assert.equal(wsDup.status, 'PROPOSED');
    // 建议新建时可正常接受，不会撞「其他项目」。
    const wsAcceptId = randomUUID();
    const wsAccepted = expectCommandAccepted(await api.post(
      `${base}/knowledge-curation-candidates/${wsDup.id}/accept`,
    { command_id: wsAcceptId }), 200, wsAcceptId);
    assert.equal(wsAccepted.mode, 'CREATED');

    // 拒绝后不能再接受。
    const rejectCreateId = randomUUID();
    expectCommandAccepted(await api.post(`${base}/knowledge-curation-candidates`,
    { command_id: rejectCreateId, sources: [{ artifact_version_id: artifact.versionId,
      suggested_title: '将被拒绝的笔记' }] }), 201, rejectCreateId);
    const rejectList = (await api.get(`${base}/knowledge-curation-candidates`)).body as
      { items: CandidateView[] };
    const rejectId = rejectList.items.find((item) =>
      item.suggested_title === '将被拒绝的笔记')!.id;
    const rejectCommandId = randomUUID();
    expectCommandAccepted(await api.post(`${base}/knowledge-curation-candidates/${rejectId}/reject`,
    { command_id: rejectCommandId }), 200, rejectCommandId);
    expectProblem(await api.post(`${base}/knowledge-curation-candidates/${rejectId}/accept`,
    { command_id: randomUUID() }), 409, 'INVALID_TRANSITION');

    // 跨项目成果不能提候选；跨 Workspace 一律 404。
    const other = await createProject(app.db, { workspaceId, commandId: randomUUID(),
      title: 'other', projectType: 'THESIS' });
    const otherTask = await startTask(api, workspaceId, other.result.project_id, '他项目任务');
    const otherArtifact = await appendArtifactVersion(api, workspaceId, otherTask, '他项目成果',
      '# 他项目\n');
    expectProblem(await api.post(`${base}/knowledge-curation-candidates`,
    { command_id: randomUUID(),
      sources: [{ artifact_version_id: otherArtifact.versionId }] }), 409,
    'INVALID_TRANSITION');
    const otherWorkspaceId = await createWorkspace(app.db);
    expectProblem(await api.get(workspacePath(otherWorkspaceId,
      `/projects/${projectId}/knowledge-curation-candidates`)), 404, 'RESOURCE_NOT_FOUND');
    expectProblem(await api.post(workspacePath(otherWorkspaceId,
      `/projects/${projectId}/knowledge-curation-candidates/${dupCandidateId}/accept`),
    { command_id: randomUUID() }), 404, 'RESOURCE_NOT_FOUND');
    void candidateIds;
  } finally { await api.stop(); }
});

test('N03 接受与拒绝竞态只能有一个结论；同 command_id 重放返回原回执', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'curation-race', projectType: 'THESIS' });
  const projectId = project.result.project_id;
  const api = await startTestApi();
  try {
    const taskId = await startTask(api, workspaceId, projectId, '竞态任务');
    const artifact = await appendArtifactVersion(api, workspaceId, taskId, '竞态笔记',
      '# 竞态笔记\n');
    const base = `${workspacePath(workspaceId)}/projects/${projectId}`;
    const decisionForGuide = await seedDecision(api, workspaceId, projectId, '竞态决定');
    const knowledgeBefore = await api.get(workspacePath(workspaceId,
      `/knowledge?project_id=${projectId}`));
    assert.equal((knowledgeBefore.body as unknown[]).length, 0);

    const propose = async (title: string) => {
      const id = randomUUID();
      const created = expectCommandAccepted(await api.post(
        `${base}/knowledge-curation-candidates`,
      { command_id: id, sources: [{ artifact_version_id: artifact.versionId,
        suggested_title: title }] }), 201, id);
      return (created.candidate_ids as string[])[0]!;
    };
    const knowledgeCount = async () => {
      const listed = await api.get(workspacePath(workspaceId,
        `/knowledge?project_id=${projectId}`));
      return (listed.body as unknown[]).length;
    };

    // P1-1：接受与拒绝并发。被拒绝的候选绝不能留下知识版本。
    // 每一轮接受赢就 +1 条知识；拒绝赢则一条都不加。
    // 注意：所有候选都指向同一个成果版本，而 createKnowledge 对已提升的
    // ArtifactVersion 会返回既有知识而不新建。因此计数按「本轮前后增量」断言，
    // 不断言绝对条数——绝对条数会被提升去重影响，与竞态无关。
    for (const title of ['竞态一', '竞态二', '竞态三']) {
      const before = await knowledgeCount();
      const candidateId = await propose(title);
      const [accepted, rejected] = await Promise.all([
        api.post(`${base}/knowledge-curation-candidates/${candidateId}/accept`,
          { command_id: randomUUID() }),
        api.post(`${base}/knowledge-curation-candidates/${candidateId}/reject`,
          { command_id: randomUUID() })]);
      // 输家可能是 409（候选已被对侧决定）或 500（两个事务在同一条候选行上互等后
      // 死锁被数据库中止）；两者都不产生业务效果，客户端都应按「查原回执」处理。
      assert.ok(accepted.status === 200 || rejected.status === 200,
        `${title}: 两侧都失败 accept=${accepted.text} reject=${rejected.text}`);
      assert.ok([409, 500].includes(accepted.status === 200 ? rejected.status : accepted.status),
        `${title}: 输家应是 409 或 500，实际 accept=${accepted.status} ` +
        `reject=${rejected.status}`);
      const final = ((await api.get(`${base}/knowledge-curation-candidates`)).body as
        { items: CandidateView[] }).items.find((item) => item.id === candidateId)!;
      if (accepted.status === 200) {
        // 接受赢：候选 ACCEPTED，且绑定到了确切的知识版本。
        assert.equal(final.status, 'ACCEPTED');
        assert.ok(final.accepted_knowledge_version_id);
      } else {
        // 拒绝赢：候选 REJECTED，且绑定为空。
        assert.equal(final.status, 'REJECTED');
        assert.equal(final.accepted_knowledge_version_id, null);
        // 被拒绝的候选绝不能留下知识版本——这是 P1-1 的核心断言。
        assert.equal(await knowledgeCount(), before,
          `${title}: 被拒绝的候选留下了孤立知识版本`);
      }
    }

    // P2-2：同一 command_id 顺序重放必须返回原回执与 Command-Replayed 头。
    const replayCandidate = await propose('重放候选');
    const beforeReplay = await knowledgeCount();
    const replayCommandId = randomUUID();
    const firstAccept = expectCommandAccepted(await api.post(
      `${base}/knowledge-curation-candidates/${replayCandidate}/accept`,
    { command_id: replayCommandId }), 200, replayCommandId);
    const secondAccept = await api.post(
      `${base}/knowledge-curation-candidates/${replayCandidate}/accept`,
    { command_id: replayCommandId });
    assert.equal(secondAccept.status, 200, secondAccept.text);
    assert.equal(secondAccept.headers['command-replayed'], 'true');
    const replayed = (secondAccept.body as { result: Record<string, unknown> }).result;
    assert.equal(replayed.knowledge_version_id, firstAccept.knowledge_version_id);
    assert.equal(await knowledgeCount(), beforeReplay, '重放不得产生第二个知识版本');

    // 同 command_id 并发两次接受：恰好一次真正执行，另一次是原回执重放。
    const raceCandidate = await propose('并发接受');
    const beforeRace = await knowledgeCount();
    const raceCommandId = randomUUID();
    const raced = await Promise.all([
      api.post(`${base}/knowledge-curation-candidates/${raceCandidate}/accept`,
        { command_id: raceCommandId }),
      api.post(`${base}/knowledge-curation-candidates/${raceCandidate}/accept`,
        { command_id: raceCommandId })]);
    const raceStatuses = raced.map((response) => response.status).sort();
    assert.deepEqual(raceStatuses, [200, 200], raced.map((r) => r.text).join('\n'));
    assert.equal(raced.filter((response) =>
      response.headers['command-replayed'] === 'true').length, 1,
      raced.map((r) => `${r.status}/${r.headers['command-replayed']}`).join(' '));
    const versions = raced.map((response) =>
      ((response.body as { result: { knowledge_version_id: string } }).result)
        .knowledge_version_id);
    assert.equal(versions[0], versions[1]);
    assert.equal(await knowledgeCount(), beforeRace, '并发接受只应产生一个知识版本');

    // P2-3：同 command_id 并发两次保存导读，另一次必须是原回执重放。
    const emptyGuideId = randomUUID();
    expectCommandAccepted(await api.put(`${base}/knowledge-guide`,
    { command_id: emptyGuideId, expected_revision: '0', entries: [] }), 200, emptyGuideId);
    const guideCommandId = randomUUID();
    const concurrency = await Promise.all([
      api.put(`${base}/knowledge-guide`, { command_id: guideCommandId, expected_revision: '1',
        entries: [{ ref_kind: 'DECISION', reference_mode: 'CURRENT',
          decision_id: decisionForGuide }] }),
      api.put(`${base}/knowledge-guide`, { command_id: guideCommandId, expected_revision: '1',
        entries: [{ ref_kind: 'DECISION', reference_mode: 'CURRENT',
          decision_id: decisionForGuide }] })]);
    const concurrencyStatuses = concurrency.map((response) => response.status).sort();
    assert.deepEqual(concurrencyStatuses, [200, 200],
      concurrency.map((r) => `${r.status} ${r.text}`).join('\n'));
    // 并发同命令必须只有一次真正执行：另一侧是原回执重放。
    assert.equal(concurrency.filter((response) =>
      response.headers['command-replayed'] === 'true').length, 1,
      concurrency.map((r) => `${r.status}/${r.headers['command-replayed']}`).join(' '));
    const guide = (await api.get(`${base}/knowledge-guide`)).body as GuideView;
    // 上面的空保存已把修订推到 1；本次并发保存只应再推一次到 2。
    assert.equal(guide.revision, '2', '并发同命令只应推进一次修订');
    assert.equal(guide.entry_count, 1);
  } finally { await api.stop(); }
});

test('N03 导读读取始终复核作用域：跨 Workspace 404，被替代的决定如实标注', async () => {
  const workspaceId = await createWorkspace(app.db);
  const otherWorkspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'guide-scope', projectType: 'THESIS' });
  const projectId = project.result.project_id;
  const api = await startTestApi();
  try {
    await startTask(api, workspaceId, projectId, '范围任务');
    const decisionId = await seedDecision(api, workspaceId, projectId, '将被替代的决定');
    const guideUrl = `${workspacePath(workspaceId)}/projects/${projectId}/knowledge-guide`;
    const saveId = randomUUID();
    expectCommandAccepted(await api.request('PUT', guideUrl, { body: { command_id: saveId,
      expected_revision: '0', entries: [
        { ref_kind: 'DECISION', reference_mode: 'CURRENT', decision_id: decisionId }] } }),
    200, saveId);

    // 跨 Workspace 读同一 project 一律 404，不泄露存在性。
    expectProblem(await api.get(workspacePath(otherWorkspaceId,
      `/projects/${projectId}/knowledge-guide`)), 404, 'RESOURCE_NOT_FOUND');
    expectProblem(await api.request('PUT', workspacePath(otherWorkspaceId,
      `/projects/${projectId}/knowledge-guide`), { body: { command_id: randomUUID(),
        expected_revision: '0', entries: [] } }), 404, 'RESOURCE_NOT_FOUND');

    // 决定被替代后，导读保留原条目并标注 SUPERSEDED，不静默换成新决定。
    const successorId = await seedDecision(api, workspaceId, projectId, '接替的决定');
    const supersedeId = randomUUID();
    expectCommandAccepted(await api.post(workspacePath(workspaceId,
      `/decisions/${decisionId}/supersessions`),
    { command_id: supersedeId, expected_revision: '0', replacement_decision_id: successorId }),
    200, supersedeId);

    const view = (await api.get(guideUrl)).body as GuideView;
    assert.equal(view.entry_count, 1);
    assert.equal(view.entries[0]?.target_id, decisionId);
    assert.equal(view.entries[0]?.resolution, 'SUPERSEDED');
    assert.match(view.entries[0]?.note ?? '', /保留原决定，不改写历史/u);

    // 被替代的决定不会再出现在当前决定列表里，导读是独立事实。
    // 被替代的决定不再出现在当前决定列表里；导读是独立事实，仍保留原条目并标注 SUPERSEDED。
    const listed = await api.get(workspacePath(workspaceId,
      `/decisions/${decisionId}`));
    assert.equal((listed.body as { status: string }).status, 'SUPERSEDED');
    assert.equal((listed.body as { superseded_by_id: string }).superseded_by_id, successorId);
    const successor = await api.get(workspacePath(workspaceId,
      `/decisions/${successorId}`));
    assert.equal((successor.body as { status: string }).status, 'ACTIVE');
  } finally { await api.stop(); }
});
