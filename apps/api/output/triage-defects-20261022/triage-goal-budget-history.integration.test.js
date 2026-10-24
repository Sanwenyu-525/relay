import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{before,after} from 'node:test';
import fs from 'node:fs';
import {runMigrations} from '../../dist/src/infrastructure/migration-runner.js';
import {APP_DATABASE_URL,MIGRATION_DATABASE_URL,MIGRATIONS_DIRECTORY,openDatabase} from '../../dist/test/integration/integration-support.js';
import {createWorkspace,startTestApi,workspacePath} from '../../dist/test/integration/api-harness.js';
import {createAssistSession,requestAssistMessage} from '../../dist/src/application/assist-commands.js';
import {runAssistGenerationTick} from '../../dist/src/application/assist-runner.js';
import {runAssistGoalTick} from '../../dist/src/application/goal-advance.js';
import {createRepositories} from '../../dist/src/application/unit-of-work.js';
import {ManagedContentStore} from '../../dist/src/storage/managed-content-store.js';
import {FakeModelPort} from '../../dist/src/workflow/fake-model-port.js';
import {recordModelInvocation} from '../../dist/src/application/model-call-recorder.js';
const app=openDatabase(APP_DATABASE_URL,'triage-goal-budget-history');let api,wid;
before(async()=>{await runMigrations({connectionString:MIGRATION_DATABASE_URL,directory:MIGRATIONS_DIRECTORY});api=await startTestApi();wid=await createWorkspace(app.db);});
after(async()=>{await api?.stop();await app.close();});
test('one new grant window must enable one more call without repaying the previous goal history',async()=>{
 const repos=createRepositories(app.db);let modelCalls=0;
 const sid=(await createAssistSession(app.db,{workspaceId:wid,commandId:randomUUID(),projectId:null,title:'sequential goal budgets'})).result.session_id;
 const port={identity:{...new FakeModelPort().identity,budget:{callReservationTokens:1,scopeCallLimit:1,scopeTokenLimit:100000}},assist:async()=>{modelCalls++;return {kind:'CONTENT',content:JSON.stringify({reply:'完成了一项检查，继续。',goal:{state:'CONTINUE',success_criteria:[{key:'c1',statement:'全部检查通过',required:true}],criteria_status:[{key:'c1',status:'UNMET',evidence:'仍有检查'}],steps:[],current_step:null,progress:`已做${modelCalls}步`,questions:[],blocked_reason:null,adjustment:null}}),providerRequestId:`triage-${modelCalls}`,usage:{inputTokens:1,outputTokens:1,cacheReadTokens:null,cacheCreationTokens:null}};}};
 // Diagnostic decorator isolates the real budget Owner from the separately filed
 // default main-loop ledger bypass (#140). It records against the real RUNNING message.
 const rawAssist=port.assist;
 port.assist=async(request)=>{
  const m=await app.db.selectFrom('assist_messages').select('id').where('session_id','=',sid).where('role','=','ASSISTANT').where('status','=','RUNNING').executeTakeFirstOrThrow();
  return (await recordModelInvocation(app.db,{origin:{workspaceId:wid,kind:'ASSIST',assistMessageId:m.id},identity:port.identity,signal:request.signal,invoke:()=>rawAssist(request),settle:r=>({status:'COMPLETED',usage:r.usage,providerRequestId:r.providerRequestId})})).result;
 };
 const tick=()=>runAssistGoalTick(app.db,{workerId:`tick-${randomUUID()}`});
 const generation=async()=>{let out;for(let i=0;i<12;i++){out=await runAssistGenerationTick(app.db,{workerId:`generate-${randomUUID()}`,storage:new ManagedContentStore(api.dataRoot),modelPort:port,leaseMs:60000,maxMessages:1});if(out&&out.status!=='DISCARDED')break;}assert.ok(out);await tick();return out;};
 const resume=async(gid)=>{const r=await api.post(workspacePath(wid,`/assist-goals/${gid}/resume`),{command_id:randomUUID()});assert.equal(r.status,200,r.text);await tick();return r;};
 const first=(await requestAssistMessage(app.db,{workspaceId:wid,sessionId:sid,commandId:randomUUID(),chatMode:'GOAL',content:'旧目标'})).result.goal_id;
 assert.equal((await generation()).status,'COMPLETED');
 for(let i=0;i<2;i++){
  const failed=await generation();assert.equal(failed.errorCode,'MODEL_BUDGET_EXHAUSTED');
  await resume(first);assert.equal((await generation()).status,'COMPLETED');
 }
 assert.equal(modelCalls,3);
 const oldGrant=await repos.planGoals.sumGrants(first);assert.equal(oldGrant.calls,2);
 const cancel=await api.post(workspacePath(wid,`/assist-goals/${first}/cancel`),{command_id:randomUUID()});assert.equal(cancel.status,200,cancel.text);
 for(let i=0;i<3&&(await repos.planGoals.readGoal(first)).status!=='CANCELLED';i++)await tick();
 assert.equal((await repos.planGoals.readGoal(first)).status,'CANCELLED');
 const second=(await requestAssistMessage(app.db,{workspaceId:wid,sessionId:sid,commandId:randomUUID(),chatMode:'GOAL',content:'新目标'})).result.goal_id;
 const initialFailure=await generation();assert.equal(initialFailure.errorCode,'MODEL_BUDGET_EXHAUSTED');
 const callsBefore=modelCalls;
 await resume(second);
 const newGrant=await repos.planGoals.sumGrants(second);assert.equal(newGrant.calls,1);
 const afterGrant=await generation();
 const firstResumeCalls=modelCalls;
 const recovery=[];
 for(let i=0;i<2&&modelCalls===callsBefore;i++){
  await resume(second);const outcome=await generation();
  recovery.push({grant:await repos.planGoals.sumGrants(second),outcome,modelCalls});
 }
 const evidence={diagnosticBoundary:'normal domain commands and HTTP resume; test-only model-port recorder decorator isolates budget Owner from #140; no real Provider',oldGoal:first,oldGrant,oldGoalStatus:(await repos.planGoals.readGoal(first)).status,newGoal:second,newGrant,modelCallsBefore:callsBefore,modelCallsAfterFirstResume:firstResumeCalls,afterGrant,recovery,newGoalStatus:(await repos.planGoals.readGoal(second)).status};
 fs.writeFileSync('output/triage-defects-20261022/goal-budget-history.json',JSON.stringify(evidence,null,2));console.log('TRIAGE_GOAL_BUDGET_HISTORY',JSON.stringify(evidence));
 assert.equal(modelCalls,callsBefore+1,'control: enough repeated grants eventually permit a real controlled call');
 assert.equal(firstResumeCalls,callsBefore+1,'a newly granted one-call window must allow the next actual model call, not only offset revoked historical grants');
});
