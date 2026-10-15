import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';
import { createProject } from '../../src/application/create-project.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { createWorkspace, expectCommandAccepted, expectProblem, startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from './integration-support.js';
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-n02-groups');
// 登记引用只能由迁移角色改动：应用角色对 artifact_lineage_edges 只有 INSERT/SELECT，
// 下面「引用真的消失」的反例必须用迁移连接构造，否则 42501。
const migrator = openDatabase(MIGRATION_DATABASE_URL, 'relay-api-test-n02-migrator');
before(async () => {
    await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
        directory: MIGRATIONS_DIRECTORY });
});
after(async () => { await app.close(); await migrator.close(); });
/** 走真实 HTTP 写入以产出真实受管正文：组合检查要按摘要回读这些内容。 */
async function saveVersion(api, workspaceId, taskId, title, content, previous) {
    // 每次保存都读当前 Task 修订，不靠推算：成果写入会多次推进 Task 修订。
    const task = await api.get(workspacePath(workspaceId, `/tasks/${taskId}`));
    assert.equal(task.status, 200, task.text);
    const currentTaskRevision = String(task.body.revision);
    const commandId = randomUUID();
    const response = previous === undefined
        ? await api.post(workspacePath(workspaceId, `/tasks/${taskId}/artifacts`), { command_id: commandId, expected_task_revision: currentTaskRevision, title,
            media_type: 'text/markdown', content })
        : await api.post(workspacePath(workspaceId, `/artifacts/${previous.artifactId}/versions`), { command_id: commandId, expected_artifact_revision: previous.artifactRevision,
            expected_task_revision: currentTaskRevision, media_type: 'text/markdown', content });
    const result = expectCommandAccepted(response, 201, commandId);
    return { artifactId: String(result.artifact_id), versionId: String(result.version_id),
        artifactRevision: String(result.artifact_revision), taskRevision: String(result.task_revision) };
}
async function startTask(api, workspaceId, projectId, title) {
    const createId = randomUUID();
    const task = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/tasks'), { command_id: createId, project_id: projectId, title, objective: title,
        criteria: [{ criterion_id: 'c1', statement: '人工核对候选与引用' }] }), 201, createId);
    const taskId = String(task.task_id);
    const readyId = randomUUID();
    const ready = expectCommandAccepted(await api.post(workspacePath(workspaceId, `/tasks/${taskId}/ready`), { command_id: readyId, expected_revision: String(task.revision) }), 200, readyId);
    const startId = randomUUID();
    expectCommandAccepted(await api.post(workspacePath(workspaceId, `/tasks/${taskId}/start`), { command_id: startId, expected_revision: String(ready.revision) }), 200, startId);
    return taskId;
}
async function startImpactCheck(api, workspaceId, sourceV1, sourceV2, targetVersionIds) {
    const commandId = randomUUID();
    const response = await api.post(workspacePath(workspaceId, `/artifact-versions/${sourceV1.versionId}/impact-checks`), { command_id: commandId, source_after_version_id: sourceV2.versionId,
        expected_artifact_revision: sourceV2.artifactRevision,
        analysis_target_version_ids: [...targetVersionIds] });
    return String(expectCommandAccepted(response, 202, commandId).impact_check_id);
}
/** 与 Worker 落库形状一致：模型输出已定稿，候选正文只存在该消息里。 */
async function seedCandidate(input) {
    return withTransaction(app.db, async (r) => {
        const check = await r.impacts.read(input.checkId);
        const source = check && await r.artifacts.readArtifact(check.artifact_id);
        const target = await r.artifacts.readArtifact(input.targetArtifactId);
        const sessionId = randomUUID();
        const messageId = randomUUID();
        const candidateId = randomUUID();
        await r.assist.insertSession({ id: sessionId, workspaceId: input.workspaceId,
            projectId: input.projectId, taskId: input.taskId, title: 'N02 seeded candidate' });
        await r.assist.insertMessage({ id: randomUUID(), sessionId, seq: 1n, role: 'USER',
            status: 'COMPLETED', intent: 'DISCUSS', content: 'seeded', sources: [] });
        await r.assist.insertMessage({ id: messageId, sessionId, seq: 2n, role: 'ASSISTANT',
            status: 'COMPLETED', intent: 'IMPACT_CANDIDATE',
            content: JSON.stringify({ markdown: '# target one\nsynced with the source change.\n' }),
            sources: [] });
        await r.impacts.insertCandidate({ id: candidateId, workspaceId: input.workspaceId,
            checkId: input.checkId, sourceArtifactRevision: source.revision,
            targetArtifactId: input.targetArtifactId, targetArtifactRevision: target.revision,
            targetVersionId: input.targetVersionId, sessionId, messageId, confirmedPossible: false });
        return candidateId;
    });
}
test('N02 候选组只收已登记直接引用；同命令重放不产生第二个组', async () => {
    const workspaceId = await createWorkspace(app.db);
    const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
        title: 'co-creation', projectType: 'DEVELOPMENT' });
    const api = await startTestApi();
    try {
        const taskId = await startTask(api, workspaceId, project.result.project_id, 'review several candidates from one source change');
        const sourceV1 = await saveVersion(api, workspaceId, taskId, 'source', '# source v1\n');
        const targetOne = await saveVersion(api, workspaceId, taskId, 'ref one', '# ref one\n');
        const targetTwo = await saveVersion(api, workspaceId, taskId, 'ref two', '# ref two\n');
        const sourceV2 = await saveVersion(api, workspaceId, taskId, 'source', '# source v2\n', sourceV1);
        await withTransaction(app.db, async (r) => {
            for (const child of [targetOne, targetTwo]) {
                await r.lineage.insertExactEdge({ workspaceId, childVersionId: child.versionId,
                    relation: 'DERIVED_FROM', parentKind: 'ARTIFACT_VERSION',
                    parentId: sourceV1.versionId });
            }
        });
        const checkId = await startImpactCheck(api, workspaceId, sourceV1, sourceV2, [targetOne.versionId, targetTwo.versionId]);
        const groupCommandId = randomUUID();
        const groupResponse = await api.post(workspacePath(workspaceId, `/impact-checks/${checkId}/candidate-groups`), { command_id: groupCommandId, target_version_ids: [targetOne.versionId, targetTwo.versionId] });
        const created = expectCommandAccepted(groupResponse, 201, groupCommandId);
        assert.equal(created.item_count, '2');
        const groupId = String(created.group_id);
        const replay = await api.post(workspacePath(workspaceId, `/impact-checks/${checkId}/candidate-groups`), { command_id: groupCommandId, target_version_ids: [targetOne.versionId, targetTwo.versionId] });
        assert.equal(replay.status, 201);
        assert.equal(replay.headers['command-replayed'], 'true');
        assert.equal(String(replay.body.result.group_id), groupId);
        const stored = await withTransaction(app.db, async (r) => r.impacts.listGroupItems(groupId));
        assert.equal(stored.length, 2);
        const empty = (await api.get(workspacePath(workspaceId, `/impact-candidate-groups/${groupId}`))).body;
        assert.equal(empty.stale, false);
        assert.equal(empty.summary.total, 2);
        assert.equal(empty.summary.applied, 0);
        assert.equal(empty.summary.without_candidate, 2);
        assert.equal(empty.summary.unavailable, 0);
        // 检查范围缺口必须显式给出，不能让「有界」被读成「完整」。
        assert.ok(empty.unanalysed_scope.length > 0);
        // 一个目标定稿候选、另一个没有：组读必须如实呈现这种部分状态。
        const candidateId = await seedCandidate({ workspaceId,
            projectId: project.result.project_id, taskId, checkId,
            targetArtifactId: targetOne.artifactId, targetVersionId: targetOne.versionId });
        const partial = (await api.get(workspacePath(workspaceId, `/impact-candidate-groups/${groupId}`))).body;
        assert.equal(partial.summary.with_candidate, 1);
        assert.equal(partial.summary.without_candidate, 1);
        assert.equal(partial.summary.applied, 0);
        assert.equal(partial.items.find((item) => item.target_version_id === targetOne.versionId)?.candidate_id, candidateId);
        assert.equal(partial.items.find((item) => item.target_version_id === targetTwo.versionId)?.candidate_id, null);
        // 逐项应用仍走既有 ApplyArtifactImpactCandidate；组只旁读回执。
        const applyId = randomUUID();
        const appliedResult = expectCommandAccepted(await api.post(workspacePath(workspaceId, `/impact-candidates/${candidateId}/apply`), { command_id: applyId, expected_target_revision: targetOne.artifactRevision }), 200, applyId);
        assert.equal(appliedResult.artifact_id, targetOne.artifactId);
        assert.notEqual(appliedResult.version_id, targetOne.versionId);
        const afterApply = (await api.get(workspacePath(workspaceId, `/impact-candidate-groups/${groupId}`))).body;
        assert.equal(afterApply.summary.applied, 1);
        assert.equal(afterApply.summary.without_candidate, 1);
        const appliedItem = afterApply.items.find((item) => item.target_version_id === targetOne.versionId);
        assert.equal(appliedItem?.applied_version_id, String(appliedResult.version_id));
        assert.equal(appliedItem?.target_is_current_version, false);
        // 组本身不产生业务写：Task 修订只由那次应用推进。
        const task = await api.get(workspacePath(workspaceId, `/tasks/${taskId}`));
        assert.equal(task.body.revision, appliedResult.task_revision);
    }
    finally {
        await api.stop();
    }
});
test('N02 拒绝未登记目标、重复目标与来源变化后的再建组', async () => {
    const workspaceId = await createWorkspace(app.db);
    const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
        title: 'scope fences', projectType: 'DEVELOPMENT' });
    const api = await startTestApi();
    try {
        const taskId = await startTask(api, workspaceId, project.result.project_id, 'scope and staleness fences');
        const sourceV1 = await saveVersion(api, workspaceId, taskId, 'source', '# source v1\n');
        const targetOne = await saveVersion(api, workspaceId, taskId, 'ref one', '# ref one\n');
        const unrelated = await saveVersion(api, workspaceId, taskId, 'unrelated', '# unrelated\n');
        const sourceV2 = await saveVersion(api, workspaceId, taskId, 'source', '# source v2\n', sourceV1);
        await withTransaction(app.db, async (r) => {
            await r.lineage.insertExactEdge({ workspaceId, childVersionId: targetOne.versionId,
                relation: 'DERIVED_FROM', parentKind: 'ARTIFACT_VERSION', parentId: sourceV1.versionId });
        });
        const checkId = await startImpactCheck(api, workspaceId, sourceV1, sourceV2, [targetOne.versionId]);
        const groups = `/impact-checks/${checkId}/candidate-groups`;
        const unregistered = await api.post(workspacePath(workspaceId, groups), { command_id: randomUUID(), target_version_ids: [unrelated.versionId] });
        expectProblem(unregistered, 409, 'INVALID_TRANSITION');
        const duplicated = await api.post(workspacePath(workspaceId, groups), { command_id: randomUUID(), target_version_ids: [targetOne.versionId, targetOne.versionId] });
        expectProblem(duplicated, 422, 'VALIDATION_FAILED');
        const none = await api.post(workspacePath(workspaceId, groups), { command_id: randomUUID(), target_version_ids: [] });
        expectProblem(none, 422, 'VALIDATION_FAILED');
        const acceptedId = randomUUID();
        const accepted = expectCommandAccepted(await api.post(workspacePath(workspaceId, groups), { command_id: acceptedId, target_version_ids: [targetOne.versionId] }), 201, acceptedId);
        // 来源再变一版后，同一检查的候选组不能再建；旧组读为 stale。
        await saveVersion(api, workspaceId, taskId, 'source', '# source v3\n', sourceV2);
        const afterMove = await api.post(workspacePath(workspaceId, groups), { command_id: randomUUID(), target_version_ids: [targetOne.versionId] });
        expectProblem(afterMove, 409, 'INVALID_TRANSITION');
        const staleGroup = await api.get(workspacePath(workspaceId, `/impact-candidate-groups/${String(accepted.group_id)}`));
        assert.equal(staleGroup.body.stale, true);
        const otherWorkspaceId = await createWorkspace(app.db);
        const crossScope = await api.get(workspacePath(otherWorkspaceId, `/impact-candidate-groups/${String(accepted.group_id)}`));
        expectProblem(crossScope, 404, 'RESOURCE_NOT_FOUND');
    }
    finally {
        await api.stop();
    }
});
test('N02 组合检查绑定确切版本集合，且不把单项事实折算成整体 PASS', async () => {
    const workspaceId = await createWorkspace(app.db);
    const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
        title: 'combination check', projectType: 'DEVELOPMENT' });
    const api = await startTestApi();
    try {
        const taskId = await startTask(api, workspaceId, project.result.project_id, 'persist a coverage snapshot for an exact version set');
        const sourceV1 = await saveVersion(api, workspaceId, taskId, 'source', '# source v1\n');
        const targetOne = await saveVersion(api, workspaceId, taskId, 'ref one', '# ref one\n');
        const sourceV2 = await saveVersion(api, workspaceId, taskId, 'source', '# source v2\n', sourceV1);
        await withTransaction(app.db, async (r) => {
            await r.lineage.insertExactEdge({ workspaceId, childVersionId: targetOne.versionId,
                relation: 'DERIVED_FROM', parentKind: 'ARTIFACT_VERSION', parentId: sourceV1.versionId });
        });
        const checkId = await startImpactCheck(api, workspaceId, sourceV1, sourceV2, [targetOne.versionId]);
        const groupCommandId = randomUUID();
        const groupId = String(expectCommandAccepted(await api.post(workspacePath(workspaceId, `/impact-checks/${checkId}/candidate-groups`), { command_id: groupCommandId, target_version_ids: [targetOne.versionId] }), 201, groupCommandId).group_id);
        const path = `/impact-candidate-groups/${groupId}/combination-checks`;
        const combinationId = randomUUID();
        const result = expectCommandAccepted(await api.post(workspacePath(workspaceId, path), { command_id: combinationId,
            artifact_version_ids: [sourceV2.versionId, targetOne.versionId] }), 201, combinationId);
        assert.equal(result.item_count, '2');
        assert.ok(Number(result.gap_count) > 0);
        const replay = await api.post(workspacePath(workspaceId, path), { command_id: combinationId,
            artifact_version_ids: [sourceV2.versionId, targetOne.versionId] });
        assert.equal(replay.headers['command-replayed'], 'true');
        const snapshot = (await api.get(workspacePath(workspaceId, `/combination-checks/${String(result.combination_check_id)}`))).body;
        assert.equal(snapshot.overall_result, 'NONE');
        assert.ok(snapshot.overall_note.length > 0);
        assert.equal(snapshot.stale, false);
        assert.equal(snapshot.items.length, 2);
        assert.ok(snapshot.items.every((item) => item.is_current_version && item.readable));
        assert.ok(snapshot.items.every((item) => item.verification_status === null));
        assert.equal(snapshot.gaps.filter((gap) => gap.includes('单项验证会话')).length, 2);
        // 正常路径不得声称登记引用不存在：登记边是「变化前版本」的下游。
        assert.equal(snapshot.gaps.filter((gap) => gap.includes('登记引用')).length, 0);
        const group = (await api.get(workspacePath(workspaceId, `/impact-candidate-groups/${groupId}`))).body;
        assert.deepEqual(group.combination_check_ids, [String(result.combination_check_id)]);
        // 旧来源版本不在组范围内（组锚定 after 版本）。
        const outOfScope = await api.post(workspacePath(workspaceId, path), { command_id: randomUUID(), artifact_version_ids: [sourceV1.versionId] });
        expectProblem(outOfScope, 409, 'INVALID_TRANSITION');
        // 登记引用确实从当前事实中消失时，该缺口必须出现（不能只测正常路径）。
        await sql `delete from artifact_lineage_edges
      where child_version_id = ${targetOne.versionId}`.execute(migrator.db);
        const reopenedId = randomUUID();
        const afterEdgeGone = expectCommandAccepted(await api.post(workspacePath(workspaceId, path), { command_id: reopenedId,
            artifact_version_ids: [sourceV2.versionId, targetOne.versionId] }), 201, reopenedId);
        const reopened = (await api.get(workspacePath(workspaceId, `/combination-checks/${String(afterEdgeGone.combination_check_id)}`))).body;
        assert.equal(reopened.gaps.filter((gap) => gap.includes(targetOne.versionId) && gap.includes('登记引用')).length, 1);
    }
    finally {
        await api.stop();
    }
});
