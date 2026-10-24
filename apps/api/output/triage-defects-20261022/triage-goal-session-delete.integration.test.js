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
const app=openDatabase(APP_DATABASE_URL,'triage-goal-delete');let api,wid;
before(async()=>{await runMigrations({connectionString:MIGRATION_DATABASE_URL,directory:MIGRATIONS_DIRECTORY});api=await startTestApi();wid=await createWorkspace(app.db);});
after(async()=>{await api?.stop();await app.close();});
test('terminal pure GOAL sessions must delete or return an explicit domain blocker, never HTTP500',async()=>{
 const repos=createRepositories(app.db);const samples=[];
 const port={identity:new FakeModelPort().identity,assist:async()=>({kind:'CONTENT',content:JSON.stringify({reply:'检查完成。',goal:{state:'COMPLETE',success_criteria:[{key:'c1',statement:'检查通过',required:true}],criteria_status:[{key:'c1',status:'MET',evidence:'受控检查成功'}],steps:[],current_step:null,progress:'完成',questions:[],blocked_reason:null,adjustment:null}}),providerRequestId:'triage-delete',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:null,cacheCreationTokens:null}})};
 const makeSession=async(title)=>(await createAssistSession(app.db,{workspaceId:wid,commandId:randomUUID(),projectId:null,title})).result.session_id;
 const deleteSession=async(sid)=>{const row=await repos.assist.readSession(sid);return api.post(workspacePath(wid,`/assist-sessions/${sid}/delete`),{command_id:randomUUID(),expected_revision:String(row.revision)});};
 const plain=await makeSession('plain control');const control=await deleteSession(plain);assert.equal(control.status,200,control.text);
 for(const action of ['cancel','complete']){
  const sid=await makeSession(`terminal goal ${action}`);const sent=await requestAssistMessage(app.db,{workspaceId:wid,sessionId:sid,commandId:randomUUID(),chatMode:'GOAL',content:'检查完成后结束'});const gid=sent.result.goal_id;
  if(action==='complete'){
   let generated;for(let i=0;i<12;i++){generated=await runAssistGenerationTick(app.db,{workerId:`generate-${randomUUID()}`,storage:new ManagedContentStore(api.dataRoot),modelPort:port,leaseMs:60000,maxMessages:1});if(generated?.messageId===sent.result.assistant_message_id&&generated.status!=='DISCARDED')break;}assert.equal(generated.status,'COMPLETED');
   await runAssistGoalTick(app.db,{workerId:`tick-${randomUUID()}`});
  }
  const ended=await api.post(workspacePath(wid,`/assist-goals/${gid}/${action}`),{command_id:randomUUID()});assert.equal(ended.status,200,ended.text);
  if(action==='cancel')for(let i=0;i<2;i++)await runAssistGoalTick(app.db,{workerId:`tick-${randomUUID()}`});
  const status=(await repos.planGoals.readGoal(gid)).status;assert.equal(status,action==='cancel'?'CANCELLED':'COMPLETED');
  assert.equal((await repos.planGoals.listPlans(sid)).length,0);assert.equal(await repos.planGoals.readInflightRoundMessage(gid),undefined);
  const blockers=await repos.assist.listDeleteBlockers(sid);const beforeRounds=await repos.planGoals.listRounds(gid);
  const deleted=await deleteSession(sid);
  samples.push({action,status,planCount:0,blockers,beforeRoundCount:beforeRounds.length,deleteHttp:deleted.status,deleteBody:deleted.body,sessionPreserved:(await repos.assist.readSession(sid))!==undefined,messagePreserved:(await repos.assist.readMessage(sent.result.assistant_message_id))!==undefined,goalPreserved:(await repos.planGoals.readGoal(gid))!==undefined,roundsPreserved:(await repos.planGoals.listRounds(gid)).length});
 }
 fs.writeFileSync('output/triage-defects-20261022/goal-session-delete.json',JSON.stringify({controlHttp:control.status,samples},null,2));console.log('TRIAGE_GOAL_SESSION_DELETE',JSON.stringify({controlHttp:control.status,samples}));
 for(const sample of samples)assert.ok(sample.deleteHttp===200||sample.deleteHttp===409,`${sample.action} terminal goal returned ${sample.deleteHttp}`);
});
