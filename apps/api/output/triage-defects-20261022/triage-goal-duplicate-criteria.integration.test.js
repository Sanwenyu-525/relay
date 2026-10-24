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
const app = openDatabase(APP_DATABASE_URL, 'triage-goal-duplicate-criteria');
let api, wid;
before(async () => { await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY }); api = await startTestApi(); wid = await createWorkspace(app.db); });
after(async () => { await api?.stop(); await app.close(); });
test('a single criterion report must not satisfy two distinct required criteria with a duplicate key', async () => {
  const repos = createRepositories(app.db);
  const results=[];
  for(const duplicate of [true,false]) {
    const sid=(await createAssistSession(app.db,{workspaceId:wid,commandId:randomUUID(),projectId:null,title:`duplicate ${duplicate}`})).result.session_id;
    const sent=await requestAssistMessage(app.db,{workspaceId:wid,sessionId:sid,commandId:randomUUID(),chatMode:'GOAL',content:'补齐说明并验证'});
    const envelope={reply:'只验证了第一项，第二项还没有验证。',goal:{state:'COMPLETE',success_criteria:[{key:'c1',statement:'单元测试通过',required:true},{key:duplicate?'c1':'c2',statement:'安装包启动验证通过',required:true}],criteria_status:[{key:'c1',status:'MET',evidence:'仅单元测试已通过；没有运行安装包'}],steps:[],current_step:null,progress:'只完成第一项验证',questions:[],blocked_reason:null,adjustment:null}};
    const port={identity:new FakeModelPort().identity,assist:async()=>({kind:'CONTENT',content:JSON.stringify(envelope),providerRequestId:'triage-evidence',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:null,cacheCreationTokens:null}})};
    for(let i=0;i<12;i++) {
      const out=await runAssistGenerationTick(app.db,{workerId:`triage-${randomUUID()}`,storage:new ManagedContentStore(api.dataRoot),modelPort:port,leaseMs:60000,maxMessages:1});
      if(out?.messageId===sent.result.assistant_message_id && out.status!=='DISCARDED')break;
    }
    assert.equal((await repos.assist.readMessage(sent.result.assistant_message_id)).status,'COMPLETED');
    const tick=await runAssistGoalTick(app.db,{workerId:`tick-${randomUUID()}`});
    const projection=await api.get(workspacePath(wid,`/assist-sessions/${sid}/goal`));
    assert.equal(projection.status,200,projection.text);
    results.push({duplicate,goal:projection.body.goal,rounds:projection.body.rounds,settled:tick.settled.find(x=>x.goalId===sent.result.goal_id)});
    // Keep later samples independent of the control's legitimately queued continuation.
    if(!duplicate) assert.notEqual(projection.body.goal.status,'AWAITING_ACCEPTANCE');
  }
  assert.equal(results[1].goal.criteria[1].status,'PENDING');
  fs.writeFileSync('output/triage-defects-20261022/goal-duplicate-criteria.json',JSON.stringify(results,null,2));
  console.log('TRIAGE_GOAL_DUPLICATE_CRITERIA',JSON.stringify(results.map(r=>({duplicate:r.duplicate,status:r.goal.status,criteria:r.goal.criteria,note:r.rounds[0]?.note}))));
  assert.notEqual(results[0].goal.status,'AWAITING_ACCEPTANCE','a report for c1 must not mark the distinct installation criterion as MET');
});
