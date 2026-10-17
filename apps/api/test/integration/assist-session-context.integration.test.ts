import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { readAssistSessionContexts } from '../../src/application/assist-queries.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-session-context');
before(async () => { await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY }); });
after(async () => { await app.close(); });

test('同一 Goal 跨项目目录聚合，只读查询不改变会话，换目录不改 Goal 关联', async () => {
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const goalId = randomUUID();
  const sessions = [randomUUID(), randomUUID()];
  const resources = [randomUUID(), randomUUID()];
  await withTransaction(app.db, async (r) => {
    for (const id of [workspaceId, otherWorkspaceId]) {
      await r.workspaces.insertWorkspace({ id, name: 'session context' });
      await r.workspaces.insertAuthorityRow(id);
    }
    await r.projects.insertGoal({ id: goalId, workspaceId, title: '完成毕业论文', description: '论文与实验由不同目录共同推进', status: 'ACTIVE' });
    for (const [index, sessionId] of sessions.entries()) {
      const projectId = randomUUID();
      await r.projects.insertProject({ id: projectId, workspaceId, title: `项目 ${index}`, projectType: 'GENERAL' });
      await r.projects.insertProjectState(projectId, 'PLANNING');
      await r.projects.linkGoalToProject({ workspaceId, projectId, goalId });
      await r.gateway.insertResource({ id: resources[index]!, workspaceId, projectId,
        canonicalRoot: `D:/context-${index}`, identityKey: `context-${randomUUID()}`, fileWriteRootId: null });
      await r.assist.insertSession({ id: sessionId, workspaceId, projectId, taskId: null, title: `讨论 ${index}` });
      await r.assist.bindSessionDirectory(sessionId, resources[index]!);
    }
  });
  const before = await createRepositories(app.db).assist.readSession(sessions[0]!);
  const api = await startTestApi();
  try {
    const base = `${workspacePath(workspaceId)}/assist-sessions`;
    const plain = await api.get(base);
    assert.equal(plain.status, 200);
    assert.equal('context' in (plain.body as { items: Record<string, unknown>[] }).items[0]!, false);
    const enriched = await api.get(`${base}?include_context=true`);
    assert.equal(enriched.status, 200);
    const rows = (enriched.body as { items: { id: string; context: { project_goals: { goal_id: string; title: string }[];
      working_directory: { resource_id: string; canonical_root: string } } }[] }).items;
    assert.equal(rows.length, 2);
    for (const row of rows) assert.deepEqual(row.context.project_goals, [{ goal_id: goalId, title: '完成毕业论文' }]);
    assert.deepEqual(new Set(rows.map((row) => row.context.working_directory.canonical_root)), new Set(['D:/context-0', 'D:/context-1']));
    const single = await api.get(`${base}/${sessions[0]}?include_context=true`);
    assert.equal(single.status, 200);
    assert.deepEqual((single.body as { context: unknown }).context, rows.find((row) => row.id === sessions[0])!.context);
    const foreign = await api.get(`${workspacePath(otherWorkspaceId)}/assist-sessions/${sessions[0]}?include_context=true`);
    assert.equal(foreign.status, 404);
    assert.deepEqual(await readAssistSessionContexts(app.db, { workspaceId: otherWorkspaceId, sessionIds: sessions }), []);
    assert.equal((await createRepositories(app.db).assist.readSession(sessions[0]!))?.revision, before?.revision);
    // 目录变化与业务关联分别成立；这里只改同一会话的目录绑定，原项目/目标关联保持原值。
    await createRepositories(app.db).assist.bindSessionDirectory(sessions[0]!, null);
    const changed = (await readAssistSessionContexts(app.db, { workspaceId, sessionIds: [sessions[0]!] }))[0]!;
    assert.equal(changed.working_directory, null);
    assert.deepEqual(changed.project_goals, [{ goal_id: goalId, title: '完成毕业论文' }]);
  } finally { await api.stop(); }
});
