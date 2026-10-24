import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import fs from 'node:fs';
import { runMigrations } from '../../dist/src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from '../../dist/test/integration/integration-support.js';
import { createWorkspace, startTestApi } from '../../dist/test/integration/api-harness.js';
import { createAssistSession, requestAssistMessage } from '../../dist/src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../dist/src/application/assist-runner.js';
import { runAssistGoalTick } from '../../dist/src/application/goal-advance.js';
import { pauseGoal } from '../../dist/src/application/assist-goals.js';
import { createRepositories } from '../../dist/src/application/unit-of-work.js';
import { ManagedContentStore } from '../../dist/src/storage/managed-content-store.js';
import { FakeModelPort } from '../../dist/src/workflow/fake-model-port.js';
const app = openDatabase(APP_DATABASE_URL, 'triage-goal-advance-starvation');
let api, wid;
before(async () => { await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY }); api = await startTestApi(); wid = await createWorkspace(app.db); });
after(async () => { await api?.stop(); await app.close(); });
async function newGoal(title) {
  const sid = (await createAssistSession(app.db, {workspaceId: wid, commandId: randomUUID(), projectId: null, title})).result.session_id;
  const sent = await requestAssistMessage(app.db, {workspaceId: wid, sessionId: sid, commandId: randomUUID(), content: title, chatMode: 'GOAL'});
  return {sessionId: sid, goalId: sent.result.goal_id, messageId: sent.result.assistant_message_id};
}
test('ten inflight goals must not starve another ready goal outside the candidate page', async () => {
  const repos = createRepositories(app.db);
  const ready = await newGoal('ready goal');
  const port = {identity: new FakeModelPort().identity, assist: async () => ({kind: 'CONTENT', content: JSON.stringify({reply: '已读现状，继续补齐。', goal: {state: 'CONTINUE', success_criteria: [{key: 'c1', statement: '补齐说明', required: true}], criteria_status: [{key: 'c1', status: 'UNMET', evidence: '尚未写入'}], steps: [{title: '补齐说明', status: 'DOING'}], current_step: '补齐说明', progress: '已读现状', questions: [], blocked_reason: null, adjustment: null}}), providerRequestId: 'triage-goal-advance', usage: {inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null}})};
  for (let i=0;i<12;i++) {
    const outcome = await runAssistGenerationTick(app.db, {workerId: `triage-${randomUUID()}`, storage: new ManagedContentStore(api.dataRoot), modelPort: port, leaseMs: 60000, maxMessages: 1});
    if (outcome?.messageId === ready.messageId && outcome.status !== 'DISCARDED') break;
  }
  assert.equal((await repos.assist.readMessage(ready.messageId)).status, 'COMPLETED');
  const inflight = [];
  for(let i=0;i<10;i++) inflight.push(await newGoal(`pending goal ${i}`));
  const ticks=[];
  for(let i=0;i<3;i++) ticks.push(await runAssistGoalTick(app.db, {workerId: `tick-${randomUUID()}`}));
  const blockedGoal = await repos.planGoals.readGoal(ready.goalId);
  assert.equal(blockedGoal.status, 'ACTIVE');
  assert.equal(blockedGoal.round_count, 1);
  assert.equal(await repos.planGoals.readInflightRoundMessage(ready.goalId), undefined);
  assert.ok(ticks[0].settled.some(x=>x.goalId===ready.goalId));
  assert.ok(ticks.every(x=>x.skipped.filter(y=>y.reason==='INFLIGHT_ROUND').length===10));
  await pauseGoal(app.db, {workspaceId:wid, goalId:inflight[0].goalId, commandId:randomUUID()});
  const control = await runAssistGoalTick(app.db, {workerId:`control-${randomUUID()}`});
  assert.ok(control.advanced.some(x=>x.goalId===ready.goalId), JSON.stringify(control));
  const evidence={ready, inflightGoalCount:inflight.length, ticks, readyStatusBeforeControl:blockedGoal.status, readyRoundCount:blockedGoal.round_count, controlAfterPausingOneInflightGoal:control};
  fs.writeFileSync('output/triage-defects-20261022/goal-advance-starvation-evidence.json', JSON.stringify(evidence,null,2));
  console.log('TRIAGE_GOAL_ADVANCE_STARVATION',JSON.stringify(evidence));
  assert.ok(ticks.some(x=>x.advanced.some(y=>y.goalId===ready.goalId)), 'ready goal never enqueued over three ticks; only pausing one unrelated inflight goal opens the candidate page');
});
