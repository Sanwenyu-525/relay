import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, type TestApi } from './api-harness.js';

/**
 * P1-A 项目级长期 Agent 成员（ADR-034 包 A，迁移 0139）：
 * 按需创建、模板默认职责、身份跨会话持久、生命周期与 CAS、协调者单点、
 * 跨工作区隔离与 EXPLICIT 模型选择的类型化拒绝。
 */
const app = openDatabase(APP_DATABASE_URL, 'relay-agent-member-test');
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => { await api?.stop(); await app.close(); });

type Member = {
  agent_member_id: string; project_id: string; name: string; role_key: string; duties: string;
  status: string; run_mode: string; is_coordinator: boolean; revision: string;
  model_selection: Record<string, unknown>; external_binding: Record<string, unknown>;
};
type ListPayload = { project_id: string; coordinator_member_id: string | null; coordinator_revision: string | null; items: Member[] };

async function fixture() {
  const workspaceId = await createWorkspace(app.db);
  const path = (segment: string) => workspacePath(workspaceId, segment);
  const command = async (segment: string, body: Record<string, unknown>, status: 200 | 201 = 200) => {
    const id = typeof body.command_id === 'string' ? body.command_id : randomUUID();
    return expectCommandAccepted(await api.post(path(segment), { command_id: id, ...body }), status, id);
  };
  const read = async (segment: string) => {
    const response = await api.get(path(segment));
    assert.equal(response.status, 200, response.text);
    return response.body as Record<string, unknown>;
  };
  const projectId = (await command('/projects', { title: '成员测试项目', project_type: 'GENERAL' }, 201)).project_id as string;
  return { workspaceId, projectId, path, command, read };
}

function memberBody(overrides: Record<string, unknown> = {}) {
  return { name: '后端开发', role_key: 'DEVELOPMENT', run_mode: 'BUILTIN', ...overrides };
}

test('按需创建成员：默认职责来自模板、同命令重放原结果、同名拒绝、角色校验', async () => {
  const f = await fixture();
  const url = `/projects/${f.projectId}/agent-members`;
  const body = memberBody({ command_id: randomUUID() });
  const created = await f.command(url, body, 201) as unknown as Member;
  assert.equal(created.status, 'ACTIVE');
  assert.equal(created.role_key, 'DEVELOPMENT');
  assert.ok(created.duties.includes('授权范围'), '默认职责必须拷贝自角色模板');

  const replay = await f.command(url, body, 201) as unknown as Member;
  assert.equal(replay.agent_member_id, created.agent_member_id, '同 command_id 必须重放原结果');
  const rows = await sql<{ count: string }>`select count(*)::text as count from project_agent_members
    where project_id = ${f.projectId}`.execute(app.db);
  assert.equal(rows.rows[0]!.count, '1');

  const dup = await api.post(f.path(url), memberBody({ command_id: randomUUID() }));
  assert.equal(dup.status, 422, dup.text);
  assert.equal((dup.body as { code: string }).code, 'VALIDATION_FAILED');

  const badRole = await api.post(f.path(url), memberBody({ command_id: randomUUID(), role_key: 'CEO' }));
  assert.equal(badRole.status, 422, badRole.text);

  // 同一项目可以有多个相同职责成员（ADR-034：不按角色去重）。
  const second = await f.command(url, memberBody({ command_id: randomUUID(), name: '后端开发二' }), 201);
  assert.ok((second as unknown as Member).agent_member_id !== created.agent_member_id);

  // 重开（新请求）后身份仍在：列表按项目读回同一批成员。
  const list = await f.read(`/projects/${f.projectId}/agent-members`) as unknown as ListPayload;
  assert.equal(list.items.length, 2);
  assert.ok(list.items.some((item) => item.agent_member_id === created.agent_member_id));
});

test('生命周期与配置修订：编辑 CAS、状态转换合法集、归档后只读', async () => {
  const f = await fixture();
  const created = await f.command(`/projects/${f.projectId}/agent-members`, memberBody(), 201) as unknown as Member;
  const id = created.agent_member_id;

  // EXPLICIT 模型选择：本实例无默认连接且目录为空 → 类型化拒绝，不静默换型号。
  const rejected = await api.post(f.path(`/agent-members/${id}/edits`), {
    command_id: randomUUID(), expected_revision: created.revision, name: created.name,
    duties: created.duties, run_mode: 'BUILTIN', reason: '尝试绑定模型',
    model_selection: { mode: 'EXPLICIT', model: 'gpt-imaginary-9' },
  });
  assert.equal(rejected.status, 400, rejected.text);
  assert.equal((rejected.body as { code: string }).code, 'MODEL_NOT_REGISTERED');
  const afterReject = await f.read(`/agent-members/${id}`) as unknown as Member;
  assert.equal(afterReject.revision, created.revision, '被拒绝的编辑不得推进修订');
  assert.equal((afterReject.model_selection as { mode: string }).mode, 'INHERIT');

  const edited = await f.command(`/agent-members/${id}/edits`, {
    command_id: randomUUID(), expected_revision: created.revision, name: '后端开发（资深）',
    duties: '负责存储层与迁移评审。', run_mode: 'BUILTIN', reason: '明确职责',
  }) as unknown as Member;
  assert.equal(edited.revision, (Number(created.revision) + 1).toString());

  const stale = await api.post(f.path(`/agent-members/${id}/edits`), {
    command_id: randomUUID(), expected_revision: created.revision, name: '旧修订', duties: '不应生效',
    run_mode: 'BUILTIN', reason: '旧修订',
  });
  assert.equal(stale.status, 409, stale.text);
  assert.equal((stale.body as { code: string }).code, 'REVISION_CONFLICT');

  const paused = await f.command(`/agent-members/${id}/status-changes`, {
    command_id: randomUUID(), expected_revision: edited.revision, status: 'INACTIVE', reason: '暂停职责',
  }) as unknown as Member;
  assert.equal(paused.status, 'INACTIVE');
  const resumed = await f.command(`/agent-members/${id}/status-changes`, {
    command_id: randomUUID(), expected_revision: paused.revision, status: 'ACTIVE', reason: '恢复职责',
  }) as unknown as Member;
  assert.equal(resumed.status, 'ACTIVE');

  const sameStatus = await api.post(f.path(`/agent-members/${id}/status-changes`), {
    command_id: randomUUID(), expected_revision: resumed.revision, status: 'ACTIVE', reason: '同状态',
  });
  assert.equal(sameStatus.status, 409, sameStatus.text);

  const archived = await f.command(`/agent-members/${id}/status-changes`, {
    command_id: randomUUID(), expected_revision: resumed.revision, status: 'ARCHIVED', reason: '项目不再需要',
  }) as unknown as Member;
  assert.equal(archived.status, 'ARCHIVED');

  const editArchived = await api.post(f.path(`/agent-members/${id}/edits`), {
    command_id: randomUUID(), expected_revision: archived.revision, name: '改归档成员', duties: '不应生效',
    run_mode: 'BUILTIN', reason: '归档后编辑',
  });
  assert.equal(editArchived.status, 409, editArchived.text);
  const revive = await api.post(f.path(`/agent-members/${id}/status-changes`), {
    command_id: randomUUID(), expected_revision: archived.revision, status: 'ACTIVE', reason: '复活',
  });
  assert.equal(revive.status, 409, revive.text);
  // 归档成员记录保留、仍可读。
  const stillReadable = await f.read(`/agent-members/${id}`) as unknown as Member;
  assert.equal(stillReadable.status, 'ARCHIVED');
});

test('协调者：首次指派、重复指派拒绝、更换需当前修订、停用成员不可担任', async () => {
  const f = await fixture();
  const url = `/projects/${f.projectId}/coordinator-assignments`;
  const developer = await f.command(`/projects/${f.projectId}/agent-members`,
    memberBody({ name: '开发成员' }), 201) as unknown as Member;
  const coordinator = await f.command(`/projects/${f.projectId}/agent-members`,
    memberBody({ name: '协调成员', role_key: 'COORDINATION' }), 201) as unknown as Member;

  const assigned = await f.command(url, { command_id: randomUUID(), member_id: coordinator.agent_member_id, reason: '指定协调者' }) as unknown as { revision: string };
  const list = await f.read(`/projects/${f.projectId}/agent-members`) as unknown as ListPayload;
  assert.equal(list.coordinator_member_id, coordinator.agent_member_id);
  assert.ok(list.items.find((item) => item.agent_member_id === coordinator.agent_member_id)!.is_coordinator);
  assert.ok(!list.items.find((item) => item.agent_member_id === developer.agent_member_id)!.is_coordinator);

  const sameMember = await api.post(f.path(url), {
    command_id: randomUUID(), member_id: coordinator.agent_member_id, reason: '重复指派',
  });
  assert.equal(sameMember.status, 409, sameMember.text);

  // 换人不带当前协调者修订：并发互换保护，必须 409。
  const swapNoRevision = await api.post(f.path(url), {
    command_id: randomUUID(), member_id: developer.agent_member_id, reason: '换人不带修订',
  });
  assert.equal(swapNoRevision.status, 409, swapNoRevision.text);
  assert.equal((swapNoRevision.body as { code: string }).code, 'REVISION_CONFLICT');

  const swapped = await f.command(url, {
    command_id: randomUUID(), expected_coordinator_revision: assigned.revision,
    member_id: developer.agent_member_id, reason: '更换协调者',
  }) as unknown as { agent_member_id: string };
  assert.equal(swapped.agent_member_id, developer.agent_member_id);
  const afterSwap = await f.read(`/projects/${f.projectId}/agent-members`) as unknown as ListPayload;
  assert.equal(afterSwap.coordinator_member_id, developer.agent_member_id);
  // 协调者是单行事实：表里永远只有一行。
  const rows = await sql<{ count: string }>`select count(*)::text as count from project_agent_coordinators
    where project_id = ${f.projectId}`.execute(app.db);
  assert.equal(rows.rows[0]!.count, '1');

  // 停用成员不能被指派为协调者。
  const paused = await f.command(`/agent-members/${developer.agent_member_id}/status-changes`, {
    command_id: randomUUID(), expected_revision: (await f.read(`/agent-members/${developer.agent_member_id}`) as unknown as Member).revision,
    status: 'INACTIVE', reason: '先停用',
  }) as unknown as Member;
  assert.equal(paused.status, 'INACTIVE');
  const assignInactive = await api.post(f.path(url), {
    command_id: randomUUID(), expected_coordinator_revision: afterSwap.coordinator_revision!,
    member_id: developer.agent_member_id, reason: '指派停用成员',
  });
  assert.equal(assignInactive.status, 409, assignInactive.text);
});

test('跨工作区与跨项目隔离：别的 workspace 读不到、别的项目成员不能当协调者', async () => {
  const f = await fixture();
  const other = await fixture();
  const member = await f.command(`/projects/${f.projectId}/agent-members`, memberBody(), 201) as unknown as Member;

  const foreignRead = await api.get(other.path(`/agent-members/${member.agent_member_id}`));
  assert.equal(foreignRead.status, 404, foreignRead.text);

  const foreignAssign = await api.post(other.path(`/projects/${other.projectId}/coordinator-assignments`), {
    command_id: randomUUID(), member_id: member.agent_member_id, reason: '跨项目指派',
  });
  assert.equal(foreignAssign.status, 404, foreignAssign.text);
});
