import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import fs from 'node:fs';
import { runMigrations } from '../../dist/src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from '../../dist/test/integration/integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath } from '../../dist/test/integration/api-harness.js';
const app = openDatabase(APP_DATABASE_URL, 'triage-return-review-evidence-limit');
let api;
before(async () => { await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY }); api = await startTestApi(); });
after(async () => { await api?.stop(); await app.close(); });
test('return review must include new completion evidence after the first 100 completed tasks', async () => {
  const wid = await createWorkspace(app.db);
  const command = async (path, body, status = 200) => { const id = randomUUID(); return expectCommandAccepted(await api.post(workspacePath(wid, path), { command_id: id, ...body }), status, id); };
  const read = async path => { const r = await api.get(workspacePath(wid, path)); assert.equal(r.status, 200, r.text); return r.body; };
  const project = await command('/projects', { title: '101 completed tasks return review', project_type: 'GENERAL' }, 201);
  const pid = project.project_id;
  const complete = async i => {
    const task = await command('/tasks', { project_id: pid, title: `completed-${i}`, objective: `check-${i}`, criteria: [{ criterion_id: 'c1', statement: 'human evidence', method: 'HUMAN' }] }, 201);
    const ready = await command(`/tasks/${task.task_id}/ready`, { expected_revision: task.revision });
    const started = await command(`/tasks/${task.task_id}/start`, { expected_revision: ready.revision });
    const done = await command(`/tasks/${task.task_id}/complete`, { expected_revision: started.revision, acceptance_revision: task.acceptance_revision, acceptance: { statement: 'human confirmed', accepted_criterion_ids: ['c1'] } });
    assert.equal(done.status, 'DONE'); return { taskId: task.task_id, ...done };
  };
  for (let i = 1; i <= 100; i++) await complete(i);
  const daily = await read(`/projects/${pid}/daily-continuation`);
  await command(`/projects/${pid}/daily-view-confirmations`, { presentation_id: daily.presentation.presentation_id, presentation_seq: daily.presentation.presentation_seq, viewed_state_revision: daily.current.state_revision,
    viewed_fact_refs: { phase_key: daily.current.phase_key, next_action_task_id: daily.current.next_action_task_id, open_task_ids: daily.current.open_task_ids, open_task_ids_truncated: daily.current.open_task_ids_truncated, unresolved_blocker_count: daily.current.unresolved_blocker_count } });
  const first = await command(`/projects/${pid}/return-reviews`, {});
  assert.equal(first.evidence.length, 100); assert.equal(first.status, 'APPLICABLE');
  const latest = await complete(101);
  const after = await command(`/projects/${pid}/return-reviews`, {});
  const latestIncluded = after.evidence.some(e => e.task_id === latest.taskId);
  const result = { firstReviewId: first.review_id, afterReviewId: after.review_id, afterStatus: after.status, reused: after.reused, evidenceCount: after.evidence.length, latestTaskId: latest.taskId, latestIncluded, latestCompletion: latest, responseKeys: Object.keys(after) };
  fs.writeFileSync('D:/Develop/Relay-Agent/apps/api/output/triage-defects-20261022/return-review-evidence-limit.json', JSON.stringify(result, null, 2));
  console.log('TRIAGE_RETURN_REVIEW_EVIDENCE_LIMIT', JSON.stringify(result));
  assert.ok(latestIncluded, 'a new completion must be included or explicitly mark review coverage incomplete');
  assert.notEqual(after.review_id, first.review_id);
});
