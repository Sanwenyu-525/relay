import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import fs from 'node:fs';
import { runMigrations } from '../../dist/src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from '../../dist/test/integration/integration-support.js';
import { createWorkspace, startTestApi, workspacePath } from '../../dist/test/integration/api-harness.js';
import { createAssistSession, requestAssistMessage } from '../../dist/src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../dist/src/application/assist-runner.js';
import { runAssistGoalTick } from '../../dist/src/application/goal-advance.js';
import { createRepositories } from '../../dist/src/application/unit-of-work.js';
import { ManagedContentStore } from '../../dist/src/storage/managed-content-store.js';
import { FakeModelPort } from '../../dist/src/workflow/fake-model-port.js';
const app = openDatabase(APP_DATABASE_URL, 'triage-goal-empty-evidence');
let api, wid;
before(async () => { await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY }); api = await startTestApi(); wid = await createWorkspace(app.db); });
after(async () => { await api?.stop(); await app.close(); });
test('COMPLETE with MET but missing evidence must not be described as all required criteria having evidence', async () => {
  const repos = createRepositories(app.db);
  const results=[];
  for(const evidence of [null,'   ','已运行定向测试，结果通过']) {
    const sid=(await createAssistSession(app.db,{workspaceId:wid,commandId:randomUUID(),projectId:null,title:`evidence ${evidence}`})).result.session_id;
    const sent=await requestAssistMessage(app.db,{workspaceId:wid,sessionId:sid,commandId:randomUUID(),chatMode:'GOAL',content:'补齐说明并验证'});
    const envelope={reply:'已经完成。',goal:{state:'COMPLETE',success_criteria:[{key:'c1',statement:'定向测试通过',required:true}],criteria_status:[{key:'c1',status:'MET',evidence}],steps:[],current_step:null,progress:'完成',questions:[],blocked_reason:null,adjustment:null}};
    const port={identity:new FakeModelPort().identity,assist:async()=>({kind:'CONTENT',content:JSON.stringify(envelope),providerRequestId:'triage-evidence',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:null,cacheCreationTokens:null}})};
    for(let i=0;i<12;i++) {
      const out=await runAssistGenerationTick(app.db,{workerId:`triage-${randomUUID()}`,storage:new ManagedContentStore(api.dataRoot),modelPort:port,leaseMs:60000,maxMessages:1});
      if(out?.messageId===sent.result.assistant_message_id && out.status!=='DISCARDED')break;
    }
    assert.equal((await repos.assist.readMessage(sent.result.assistant_message_id)).status,'COMPLETED');
    const tick=await runAssistGoalTick(app.db,{workerId:`tick-${randomUUID()}`});
    const projection=await api.get(workspacePath(wid,`/assist-sessions/${sid}/goal`));
    assert.equal(projection.status,200,projection.text);
    results.push({inputEvidence:evidence,goal:projection.body.goal,rounds:projection.body.rounds,settled:tick.settled.find(x=>x.goalId===sent.result.goal_id)});
  }
  assert.equal(results[2].goal.status,'AWAITING_ACCEPTANCE');
  assert.equal(results[2].goal.criteria[0].evidence,'已运行定向测试，结果通过');
  fs.writeFileSync('output/triage-defects-20261022/goal-empty-evidence.json',JSON.stringify(results,null,2));
  console.log('TRIAGE_GOAL_EMPTY_EVIDENCE',JSON.stringify(results.map(r=>({inputEvidence:r.inputEvidence,status:r.goal.status,criterion:r.goal.criteria[0],reason:r.goal.stop_reason,note:r.rounds[0]?.note}))));
  assert.ok(results.slice(0,2).every(r=>r.goal.status!=='AWAITING_ACCEPTANCE'),'null/blank evidence must not satisfy evidence-based completion gate');
});
