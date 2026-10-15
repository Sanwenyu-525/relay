import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { sql } from 'kysely';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, delay, type TestApi } from './api-harness.js';
const app = openDatabase(APP_DATABASE_URL, 'relay-project-reminder-test'); let api: TestApi;
before(async () => { await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY }); api = await startTestApi(); });
after(async () => { await api?.stop(); await app.close(); });
type Occurrence = { occurrence_id: string; reminder_id: string; project_id: string; status: string; revision: string; due_at: string; timezone: string; missed: boolean; plan_entry: string; can_plan: boolean; execution_admission: string };
async function fixture() {
  const workspaceId = await createWorkspace(app.db); const path = (s: string) => workspacePath(workspaceId, s);
  const command = async (s: string, body: Record<string, unknown>, status: 200 | 201 = 200) => {
    const id = typeof body.command_id === 'string' ? body.command_id : randomUUID(); return expectCommandAccepted(await api.post(path(s), { command_id: id, ...body }), status, id);
  };
  const read = async (s: string) => { const response = await api.get(path(s)); assert.equal(response.status, 200, response.text); return response.body as Record<string, unknown>; };
  const projectId = (await command('/projects', { title: '提醒继续项目', project_type: 'GENERAL' }, 201)).project_id as string;
  const occurrences = async () => (await read(`/reminder-occurrences?project_id=${projectId}`)).items as Occurrence[];
  const waitFor = async (count: number) => {
    const until = Date.now() + 8000;
    while (Date.now() < until) { const items = await occurrences(); if (items.length === count) return items; await delay(100); }
    assert.equal((await occurrences()).length, count, '真实服务扫描未在窗口内形成预期事项'); return occurrences();
  };
  return { workspaceId, projectId, path, command, read, occurrences, waitFor };
}
test('真实服务到时只形成一次事项，禁用/通知被拒仍保留待处理，读取计划入口不执行', async () => {
  const f = await fixture(); const dueAt = new Date(Date.now() + 2000).toISOString();
  const body = { command_id: randomUUID(), confirmed: true, title: '继续写报告', due_at: dueAt, timezone: 'Asia/Shanghai' };
  const reminder = await f.command(`/projects/${f.projectId}/reminders`, body, 201);
  await f.command(`/projects/${f.projectId}/reminders`, body, 201);
  const first = (await f.waitFor(1))[0]!; assert.equal(first.missed, false); assert.equal(first.due_at, dueAt); assert.equal(first.timezone, 'Asia/Shanghai');
  assert.equal(first.execution_admission, 'NOT_GRANTED'); assert.equal(first.can_plan, true); assert.ok(first.plan_entry.endsWith(`/projects/${f.projectId}/period-plans`));
  await f.command(`/project-reminders/${reminder.reminder_id}/status-changes`, { expected_revision: reminder.revision, status: 'DISABLED', reason: '关闭未来提醒' });
  const claim = await api.post(f.path('/project-reminders/notifications/claim'), {}); assert.equal(claim.status, 200, claim.text);
  const items = (claim.body as { items: { item_key: string; change_key: string }[] }).items; assert.equal(items.length, 1);
  const denied = await api.post(f.path('/attention/notifications/settle'), { item_key: items[0]!.item_key, change_key: items[0]!.change_key, status: 'DENIED' }); assert.equal(denied.status, 200, denied.text);
  const duplicate = await api.post(f.path('/project-reminders/notifications/claim'), {}); assert.equal((duplicate.body as { items: unknown[] }).items.length, 0);
  assert.equal((await f.read(`/reminder-occurrences/${first.occurrence_id}`)).status, 'PENDING');
  const before = await f.read(`/projects/${f.projectId}`); await f.read(`/reminder-occurrences/${first.occurrence_id}`); assert.deepEqual(await f.read(`/projects/${f.projectId}`), before);
  const handled = { command_id: randomUUID(), expected_revision: first.revision, action: 'DISMISS', reason: '本次先不继续' };
  await f.command(`/reminder-occurrences/${first.occurrence_id}/resolutions`, handled); await f.command(`/reminder-occurrences/${first.occurrence_id}/resolutions`, handled);
  assert.equal((await f.occurrences())[0]?.status, 'DISMISSED');
  const counts = await sql<{ runs: string; calls: string; plans: string }>`select
    (select count(*)::text from runs where workspace_id = ${f.workspaceId}) as runs,
    (select count(*)::text from model_calls where workspace_id = ${f.workspaceId}) as calls,
    (select count(*)::text from period_plans where workspace_id = ${f.workspaceId}) as plans`.execute(app.db);
  assert.deepEqual(counts.rows[0], { runs: '0', calls: '0', plans: '0' });
});
test('暂停/继续不重复原发生，显式改实际时刻形成新发生且保留旧待处理与设置时区', async () => {
  const f = await fixture(); const oldDue = new Date(Date.now() - 10000).toISOString();
  const reminder = await f.command(`/projects/${f.projectId}/reminders`, { title: '继续项目', due_at: oldDue, timezone: 'Asia/Shanghai', confirmed: true }, 201);
  const original = (await f.waitFor(1))[0]!;
  const paused = await f.command(`/project-reminders/${reminder.reminder_id}/status-changes`, { expected_revision: '1', status: 'PAUSED', reason: '先暂停' });
  const resumed = await f.command(`/project-reminders/${reminder.reminder_id}/status-changes`, { expected_revision: paused.revision, status: 'ENABLED', reason: '恢复提醒' });
  await delay(1200); assert.equal((await f.occurrences()).length, 1); assert.equal(resumed.schedule_generation, '1');
  const newDue = new Date(Date.now() - 1000).toISOString();
  const edited = await f.command(`/project-reminders/${reminder.reminder_id}/edits`, { expected_revision: resumed.revision, title: '稍后继续项目', due_at: newDue, timezone: 'UTC', confirmed: true, reason: '明确修改时刻' });
  assert.equal(edited.schedule_generation, '2'); const both = await f.waitFor(2);
  assert.equal(both.find((o) => o.occurrence_id === original.occurrence_id)?.due_at, oldDue);
  assert.equal(both.find((o) => o.occurrence_id === original.occurrence_id)?.timezone, 'Asia/Shanghai');
  assert.ok(both.every((o) => o.status === 'PENDING'));
  assert.equal(both.find((o) => o.occurrence_id !== original.occurrence_id)?.due_at, newDue);
  const read = await f.read(`/project-reminders/${reminder.reminder_id}`); assert.equal((read.history as unknown[]).length, 4);
  const handled = await f.command(`/reminder-occurrences/${original.occurrence_id}/resolutions`, { expected_revision: '1', action: 'HANDLE', reason: '已看过原提醒' }); assert.equal(handled.status, 'HANDLED');
  assert.equal((await f.occurrences()).filter((o) => o.status === 'PENDING').length, 1);
});
test('真实 API 退出期间不触发，重开补一次有效错过事项，暂停事项不补且再次重开身份不变', async () => {
  const f = await fixture(); const dueAt = new Date(Date.now() + 2500).toISOString();
  const active = await f.command(`/projects/${f.projectId}/reminders`, { title: '有效提醒', due_at: dueAt, timezone: 'Asia/Shanghai', confirmed: true }, 201);
  const paused = await f.command(`/projects/${f.projectId}/reminders`, { title: '暂停提醒', due_at: dueAt, timezone: 'Asia/Shanghai', confirmed: true }, 201);
  await f.command(`/project-reminders/${paused.reminder_id}/status-changes`, { expected_revision: '1', status: 'PAUSED', reason: '不触发此项' });
  await api.stop(); await delay(2700);
  const closed = await sql<{ count: string }>`select count(*)::text as count from project_reminder_occurrences where workspace_id = ${f.workspaceId}`.execute(app.db);
  assert.equal(closed.rows[0]?.count, '0');
  api = await startTestApi(); const first = (await f.waitFor(1))[0]!; assert.equal(first.reminder_id, active.reminder_id); assert.equal(first.missed, true);
  await api.stop(); api = await startTestApi(); await delay(1100);
  const afterReopen = await f.occurrences(); assert.equal(afterReopen.length, 1); assert.equal(afterReopen[0]?.occurrence_id, first.occurrence_id);
});
