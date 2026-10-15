import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import { bindAssistSessionProject, createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createDataRoot, startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from './integration-support.js';
/**
 * 工作空间级会话绑定到项目的真实 PG 出口。
 *
 * 覆盖规格 §4.2：绑定只改 project_id，不改 task_id；已归属会话不可重绑；归档项目与
 * 跨工作空间项目被拒；在途消息未结束时拒绝；同一 command_id 重放命中同一结果。
 */
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-session-binding');
let dataRoot;
before(async () => {
    await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
    dataRoot = await createDataRoot();
});
after(async () => {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
});
async function workspace(name) {
    const workspaceId = randomUUID();
    await withTransaction(app.db, async (repositories) => {
        await repositories.workspaces.insertWorkspace({ id: workspaceId, name });
        await repositories.workspaces.insertAuthorityRow(workspaceId);
    });
    return workspaceId;
}
async function project(workspaceId, title) {
    const projectId = randomUUID();
    await withTransaction(app.db, async (repositories) => {
        await repositories.projects.insertProject({ id: projectId, workspaceId, title,
            projectType: 'GENERAL' });
        await repositories.projects.insertProjectState(projectId, 'PLANNING');
    });
    return projectId;
}
async function archive(projectId) {
    await withTransaction(app.db, async (repositories) => {
        const current = await repositories.projects.readProject(projectId);
        assert.ok(current !== undefined);
        await repositories.projects.archiveProject(projectId, current.revision);
    });
}
async function activeProjectCount(workspaceId) {
    const page = await createRepositories(app.db).projects.listProjectsPage({
        workspaceId, status: 'active', limit: 100, before: null
    });
    return page.length;
}
async function unassigned(workspaceId, title) {
    const created = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
        projectId: null, title });
    assert.equal(created.result.project_id, null);
    return created.result.session_id;
}
async function readSession(sessionId) {
    const row = await createRepositories(app.db).assist.readSession(sessionId);
    assert.ok(row !== undefined);
    return { project_id: row.project_id, task_id: row.task_id, revision: row.revision, status: row.status };
}
test('工作空间级会话绑定到项目后归属落库', async () => {
    const workspaceId = await workspace('bind-happy');
    const projectId = await project(workspaceId, '目标项目');
    const sessionId = await unassigned(workspaceId, '先聊聊');
    const bound = await bindAssistSessionProject(app.db, { workspaceId, sessionId,
        commandId: randomUUID(), projectId });
    assert.equal(bound.result.project_id, projectId);
    assert.equal(bound.result.session_id, sessionId);
    const read = await readSession(sessionId);
    assert.equal(read.project_id, projectId);
    assert.ok(read.revision > 0n);
    // 只改归属：task_id 必须仍为空，否则讨论会被静默绑到某个任务上。
    assert.equal(read.task_id, null);
});
test('已归属会话不可重绑', async () => {
    const workspaceId = await workspace('bind-already');
    const first = await project(workspaceId, '第一个项目');
    const second = await project(workspaceId, '第二个项目');
    const created = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
        projectId: first, title: '已有归属' });
    await assert.rejects(() => bindAssistSessionProject(app.db, { workspaceId,
        sessionId: created.result.session_id, commandId: randomUUID(), projectId: second }), (error) => error.code === 'INVALID_TRANSITION');
    assert.equal((await readSession(created.result.session_id)).project_id, first);
});
test('绑定到已归档项目被拒绝且不新建项目', async () => {
    const workspaceId = await workspace('bind-archived');
    const projectId = await project(workspaceId, '归档项目');
    await archive(projectId);
    const sessionId = await unassigned(workspaceId, '待绑定');
    const before = await activeProjectCount(workspaceId);
    await assert.rejects(() => bindAssistSessionProject(app.db, { workspaceId, sessionId,
        commandId: randomUUID(), projectId }), (error) => error.code === 'INVALID_TRANSITION');
    assert.equal(await activeProjectCount(workspaceId), before);
    assert.equal((await readSession(sessionId)).project_id, null);
});
test('跨工作空间项目被拒绝', async () => {
    const workspaceId = await workspace('bind-cross-owner');
    const otherWorkspaceId = await workspace('bind-cross-other');
    const foreignProject = await project(otherWorkspaceId, '别人的项目');
    const sessionId = await unassigned(workspaceId, '待绑定');
    await assert.rejects(() => bindAssistSessionProject(app.db, { workspaceId, sessionId,
        commandId: randomUUID(), projectId: foreignProject }), (error) => error.code === 'RESOURCE_NOT_FOUND');
    assert.equal((await readSession(sessionId)).project_id, null);
});
test('有在途消息时拒绝绑定', async () => {
    const workspaceId = await workspace('bind-inflight');
    const projectId = await project(workspaceId, '目标项目');
    const sessionId = await unassigned(workspaceId, '在途会话');
    // 未接模型端口时该消息停在 PENDING，正是绑定必须拒绝的在途状态。
    await requestAssistMessage(app.db, { workspaceId, sessionId, commandId: randomUUID(),
        content: '还在生成中的一条消息' });
    await assert.rejects(() => bindAssistSessionProject(app.db, { workspaceId, sessionId,
        commandId: randomUUID(), projectId }), (error) => error.code === 'INVALID_TRANSITION');
    assert.equal((await readSession(sessionId)).project_id, null);
});
test('同一 command_id 重放命中同一结果', async () => {
    const workspaceId = await workspace('bind-replay');
    const projectId = await project(workspaceId, '目标项目');
    const sessionId = await unassigned(workspaceId, '重放会话');
    const commandId = randomUUID();
    const first = await bindAssistSessionProject(app.db, { workspaceId, sessionId, commandId, projectId });
    const replay = await bindAssistSessionProject(app.db, { workspaceId, sessionId, commandId, projectId });
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.session_id, first.result.session_id);
    assert.equal(replay.result.revision, first.result.revision);
    assert.equal((await readSession(sessionId)).revision, BigInt(first.result.revision));
});
test('project_id 为空串按校验失败拒绝', async () => {
    const workspaceId = await workspace('bind-blank');
    const sessionId = await unassigned(workspaceId, '空项目号');
    await assert.rejects(() => bindAssistSessionProject(app.db, { workspaceId, sessionId,
        commandId: randomUUID(), projectId: '' }), (error) => error.code === 'VALIDATION_FAILED');
});
test('绑定端点经 HTTP 归入会话并返回确切修订', async () => {
    const workspaceId = await workspace('bind-http');
    const projectId = await project(workspaceId, '目标项目');
    const sessionId = await unassigned(workspaceId, '先聊聊');
    const api = await startTestApi();
    try {
        const response = await api.post(`${workspacePath(workspaceId)}/assist-sessions/` +
            `${sessionId}/binding`, { command_id: randomUUID(), project_id: projectId });
        assert.equal(response.status, 200);
        const body = response.body;
        assert.equal(body.result.project_id, projectId);
        assert.equal((await readSession(sessionId)).project_id, projectId);
        assert.equal((await readSession(sessionId)).revision, BigInt(body.result.revision));
    }
    finally {
        await api.stop();
    }
});
test('绑定端点缺少 project_id 返回 422', async () => {
    const workspaceId = await workspace('bind-http-missing');
    const sessionId = await unassigned(workspaceId, '缺项目号');
    const api = await startTestApi();
    try {
        const response = await api.post(`${workspacePath(workspaceId)}/assist-sessions/` +
            `${sessionId}/binding`, { command_id: randomUUID() });
        assert.equal(response.status, 422);
    }
    finally {
        await api.stop();
    }
});
test('绑定端点对已归属会话返回 409', async () => {
    const workspaceId = await workspace('bind-http-conflict');
    const projectId = await project(workspaceId, '第一个项目');
    const created = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
        projectId, title: '已有归属' });
    const api = await startTestApi();
    try {
        const response = await api.post(`${workspacePath(workspaceId)}/assist-sessions/` +
            `${created.result.session_id}/binding`, { command_id: randomUUID(), project_id: projectId });
        assert.equal(response.status, 409);
    }
    finally {
        await api.stop();
    }
});
