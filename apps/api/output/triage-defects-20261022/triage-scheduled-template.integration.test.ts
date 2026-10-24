import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { sql } from 'kysely';
import { runMigrations } from '../../dist/src/infrastructure/migration-runner.js';
import { createScheduledTask } from '../../dist/src/application/scheduled-tasks.js';
import { ScheduledTaskRepository } from '../../dist/src/planning/scheduled-task-repository.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from '../../dist/test/integration/integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, delay } from '../../dist/test/integration/api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'triage-scheduled-template');
let api;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => { await api?.stop(); await app.close(); });
async function fixture() {
  const workspaceId = await createWorkspace(app.db);
  const command = async (path, body, status = 201) => {
    const commandId = randomUUID();
    return expectCommandAccepted(await api.post(workspacePath(workspaceId, path), { command_id: commandId, ...body }), status, commandId);
  };
  const projectId = (await command('/projects', { title: 'isolated triage', project_type: 'GENERAL' })).project_id;
  return { workspaceId, projectId, command };
}
const firstDate = () => new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
const expiry = () => new Date(Date.now() + 7 * 86400000).toISOString();
const sentinel = { sentinel: 'must-preserve-verification-target' };

test('HTTP schedule creation must preserve criterion_id and target_spec', async () => {
  const f = await fixture();
  const created = await f.command(`/projects/${f.projectId}/scheduled-tasks`, {
    confirmed: true, title: 'HTTP custom criterion',
    template: { task_title: 'HTTP generated', objective: 'preserve criterion contract', mode: 'AI_ASSIST',
      criteria: [{ criterion_id: 'must_keep_id', statement: 'Keep exact condition', method: 'HUMAN', target_spec: sentinel }] },
    repeat_rule: { kind: 'DAILY', interval_days: 1 }, timezone: 'Asia/Shanghai', local_time: '09:00',
    first_local_date: firstDate(), max_runs: 5, authorization_expires_at: expiry()
  });
  const read = await api.get(workspacePath(f.workspaceId, `/scheduled-tasks/${created.scheduled_task_id}`));
  assert.equal(read.status, 200, read.text);
  const actual = read.body.template.criteria[0];
  console.log('TRIAGE_HTTP_TEMPLATE', JSON.stringify(actual));
  assert.deepEqual({ criterion_id: actual.criterion_id, target_spec: actual.target_spec },
    { criterion_id: 'must_keep_id', target_spec: sentinel });
});

test('dispatch must preserve stored custom criterion identity and target', async () => {
  const f = await fixture();
  const created = await createScheduledTask(app.db, {
    workspaceId: f.workspaceId, commandId: randomUUID(), projectId: f.projectId,
    title: 'Application custom criterion', confirmed: true,
    template: { task_title: 'Application generated', objective: 'preserve stored criterion contract', mode: 'AI_ASSIST', expected_outputs: {},
      criteria: [{ criterionId: 'must_keep_id', statement: 'Keep exact condition', method: 'HUMAN', targetSpec: sentinel }] },
    repeat: { kind: 'DAILY', interval_days: 1 }, timezone: 'Asia/Shanghai', localTime: '09:00',
    firstLocalDate: firstDate(), maxRuns: 5, authorizationExpiresAt: expiry(), execution: undefined
  });
  const id = created.result.scheduled_task_id;
  const stored = (await sql`select template from scheduled_tasks where id = ${id}`.execute(app.db)).rows[0].template.criteria[0];
  assert.equal(stored.criterion_id, 'must_keep_id');
  assert.deepEqual(stored.target_spec, sentinel);
  await sql`update scheduled_tasks set next_due_at = now() where id = ${id}`.execute(app.db);
  let row;
  for (let step = 0; step < 100; step++) {
    row = (await sql`select task_id, status, reason from scheduled_task_occurrences where scheduled_task_id = ${id}`.execute(app.db)).rows[0];
    if (row?.task_id) break;
    await delay(100);
  }
  assert.ok(row?.task_id, 'actual scheduler must create a task');
  const criteria = (await sql`select criterion_id, target_spec from acceptance_criteria where task_id = ${row.task_id}`.execute(app.db)).rows;
  console.log('TRIAGE_DISPATCH_CRITERIA', JSON.stringify({ stored, actual: criteria }));
  assert.deepEqual(criteria.map(c => ({ criterion_id: c.criterion_id, target_spec: c.target_spec })),
    [{ criterion_id: 'must_keep_id', target_spec: sentinel }]);
});

test('detail must retain actionable blocked occurrences older than its history preview', async () => {
  const f = await fixture();
  const created = await createScheduledTask(app.db, {
    workspaceId: f.workspaceId, commandId: randomUUID(), projectId: f.projectId,
    title: 'History visibility', confirmed: true,
    template: { task_title: 'History task', objective: 'retain pending action', mode: 'AI_ASSIST', expected_outputs: {},
      criteria: [{ statement: 'one condition' }] },
    repeat: { kind: 'DAILY', interval_days: 1 }, timezone: 'Asia/Shanghai', localTime: '09:00',
    firstLocalDate: firstDate(), maxRuns: 50, authorizationExpiresAt: expiry(), execution: undefined
  });
  const id = created.result.scheduled_task_id;
  const repository = new ScheduledTaskRepository(app.db);
  const oldId = randomUUID();
  for (let index = 0; index < 21; index++) {
    const oid = index === 0 ? oldId : randomUUID();
    await repository.insertOccurrence({ id: oid, scheduled_task_id: id, workspace_id: f.workspaceId, project_id: f.projectId,
      schedule_generation: 1n, sequence: BigInt(index + 1), due_at: new Date(Date.now() - (30 - index) * 86400000),
      timezone: 'Asia/Shanghai', missed: true, create_command_id: randomUUID(), ready_command_id: randomUUID(), delegate_command_id: randomUUID()
    }, index === 0 ? 'BLOCKED' : 'SKIPPED', index === 0 ? 'MISSED' : 'PREVIOUS_TASK_NOT_ACCEPTED');
    await sql`update scheduled_task_occurrences set created_at = clock_timestamp() - (${21-index}::text || ' minutes')::interval where id = ${oid}`.execute(app.db);
  }
  const read = await api.get(workspacePath(f.workspaceId, `/scheduled-tasks/${id}`));
  assert.equal(read.status, 200, read.text);
  const persisted = (await sql`select count(*)::int as count from scheduled_task_occurrences where scheduled_task_id=${id} and status='BLOCKED'`.execute(app.db)).rows[0].count;
  console.log('TRIAGE_OLD_BLOCKED', JSON.stringify({ persistedBlocked: persisted, returned: read.body.occurrences.length,
    returnedBlocked: read.body.occurrences.filter(o => o.status === 'BLOCKED').length, keys: Object.keys(read.body) }));
  assert.ok(read.body.occurrences.some(o => o.occurrence_id === oldId), 'actionable old BLOCKED item must be discoverable');
});
