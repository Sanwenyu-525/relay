import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import fs from 'node:fs';
import { runMigrations } from '../../dist/src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from '../../dist/test/integration/integration-support.js';
import { createWorkspace, startTestApi, workspacePath } from '../../dist/test/integration/api-harness.js';
import { createAssistSession, requestAssistMessage } from '../../dist/src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../dist/src/application/assist-runner.js';
import { createRepositories } from '../../dist/src/application/unit-of-work.js';
import { ManagedContentStore } from '../../dist/src/storage/managed-content-store.js';
import { FakeModelPort } from '../../dist/src/workflow/fake-model-port.js';
const app = openDatabase(APP_DATABASE_URL, 'triage-plan-session-delete');
let api, wid;
before(async () => { await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY }); api = await startTestApi(); wid = await createWorkspace(app.db); });
after(async () => { await api?.stop(); await app.close(); });
async function session(title) { return (await createAssistSession(app.db, {workspaceId: wid, commandId: randomUUID(), projectId: null, title})).result.session_id; }
test('deleting a normally settled PLAN session must not fall through to an unhandled FK error', async () => {
  const repos = createRepositories(app.db);
  const plainId = await session('plain delete control');
  const plain = await repos.assist.readSession(plainId);
  const control = await api.post(workspacePath(wid, `/assist-sessions/${plainId}/delete`), {command_id: randomUUID(), expected_revision: String(plain.revision)});
  assert.equal(control.status, 200, control.text);
  const sid = await session('completed plan delete');
  const sent = await requestAssistMessage(app.db, {workspaceId: wid, sessionId: sid, commandId: randomUUID(), content: '只制定计划', chatMode: 'PLAN'});
  const port = {identity: new FakeModelPort().identity, assist: async () => ({kind: 'CONTENT', content: JSON.stringify({reply: '方案已经成形。', plan: {goal: '梳理流程', scope: ['web'], steps: [{title: '读现状'}], verification: [{statement: '人工走查', method: 'HUMAN'}], open_questions: []}}), providerRequestId: 'triage-plan-delete', usage: {inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null}})};
  for (let i=0;i<12;i++) {
    const outcome = await runAssistGenerationTick(app.db, {workerId: `triage-${randomUUID()}`, storage: new ManagedContentStore(api.dataRoot), modelPort: port, leaseMs: 60000, maxMessages: 1});
    if (outcome?.messageId === sent.result.assistant_message_id && outcome.status !== 'DISCARDED') break;
  }
  const message = await repos.assist.readMessage(sent.result.assistant_message_id);
  assert.equal(message.status, 'COMPLETED');
  const plans = await repos.planGoals.listPlans(sid);
  assert.equal(plans.length, 1);
  const blockers = await repos.assist.listDeleteBlockers(sid);
  assert.deepEqual(blockers, []);
  const current = await repos.assist.readSession(sid);
  const response = await api.post(workspacePath(wid, `/assist-sessions/${sid}/delete`), {command_id: randomUUID(), expected_revision: String(current.revision)});
  const afterSession = await repos.assist.readSession(sid);
  const afterMessage = await repos.assist.readMessage(sent.result.assistant_message_id);
  const afterPlans = await repos.planGoals.listPlans(sid);
  const evidence = {controlStatus: control.status, planMessageStatus: message.status, planCount: plans.length, blockers, deleteStatus: response.status, deleteBody: response.body, deleteText: response.text, sessionPreserved: !!afterSession, messagePreserved: !!afterMessage, plansPreserved: afterPlans.length};
  fs.writeFileSync('output/triage-defects-20261022/plan-session-delete-evidence.json', JSON.stringify(evidence, null, 2));
  console.log('TRIAGE_PLAN_SESSION_DELETE', JSON.stringify(evidence));
  assert.ok(response.status === 200 || response.status === 409, `expected successful cleanup or explicit domain blocker, got ${response.status}: ${response.text}`);
});
