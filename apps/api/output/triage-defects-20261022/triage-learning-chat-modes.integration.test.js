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
const app=openDatabase(APP_DATABASE_URL,'triage-learning-modes');let api,wid;
before(async()=>{await runMigrations({connectionString:MIGRATION_DATABASE_URL,directory:MIGRATIONS_DIRECTORY});api=await startTestApi();wid=await createWorkspace(app.db);});
after(async()=>{await api?.stop();await app.close();});
test('accepted learning PLAN and GOAL modes must be supported or rejected before accepting work',async()=>{
 const repos=createRepositories(app.db);const samples=[];
 for(const chatMode of ['PLAN','GOAL'])for(const conversationMode of ['AGENT','LEARNING']){
  const sid=(await createAssistSession(app.db,{workspaceId:wid,commandId:randomUUID(),projectId:null,title:`${conversationMode} ${chatMode}`,conversationMode})).result.session_id;
  const switched=await api.post(workspacePath(wid,`/assist-sessions/${sid}/chat-mode`),{command_id:randomUUID(),mode:chatMode});assert.equal(switched.status,200,switched.text);
  const sent=await requestAssistMessage(app.db,{workspaceId:wid,sessionId:sid,commandId:randomUUID(),content:chatMode==='PLAN'?'为学习制定计划':'完成这次学习检查'});
  let calls=0,learningRequests=0;
  const port={identity:new FakeModelPort().identity,assist:async(request)=>{
   calls++;if(request.learning)learningRequests++;
   const content=request.learning?'正常教学回答':JSON.stringify({reply:'已完成检查。',plan:{goal:'完成学习检查',scope:['只读学习'],steps:[{title:'检查'}],verification:[{statement:'检查完成',method:'HUMAN'}],open_questions:[]},goal:{state:'COMPLETE',success_criteria:[{key:'c1',statement:'检查完成',required:true}],criteria_status:[{key:'c1',status:'MET',evidence:'受控检查通过'}],steps:[],current_step:null,progress:'完成检查',questions:[],blocked_reason:null,adjustment:null}});
   return {kind:'CONTENT',content,...(request.learning?{learning:{increments:[],schemaError:null}}:{}),providerRequestId:`triage-${calls}`,usage:{inputTokens:1,outputTokens:1,cacheReadTokens:null,cacheCreationTokens:null}};
  }};
  const generate=async()=>{for(let i=0;i<12;i++){const r=await runAssistGenerationTick(app.db,{workerId:`generate-${randomUUID()}`,storage:new ManagedContentStore(api.dataRoot),modelPort:port,leaseMs:60000,maxMessages:1});if(r&&r.status!=='DISCARDED')return r;}assert.fail('generation did not settle');};
  assert.equal((await generate()).status,'COMPLETED');
  if(chatMode==='GOAL'){
   await runAssistGoalTick(app.db,{workerId:`tick-${randomUUID()}`});
   if(conversationMode==='LEARNING')for(let i=0;i<2;i++){assert.equal((await generate()).status,'COMPLETED');await runAssistGoalTick(app.db,{workerId:`tick-${randomUUID()}`});}
  }
  const plans=await api.get(workspacePath(wid,`/assist-sessions/${sid}/plans`));assert.equal(plans.status,200,plans.text);
  const goal=await api.get(workspacePath(wid,`/assist-sessions/${sid}/goal`));assert.equal(goal.status,200,goal.text);
  samples.push({conversationMode,chatMode,switchHttp:switched.status,acceptedMessageMode:sent.result.chat_mode,goalId:sent.result.goal_id,calls,learningRequests,planCount:plans.body.versions.length,goal:goal.body.goal,rounds:goal.body.rounds,firstMessageGoalOutcome:(await repos.assist.readMessage(sent.result.assistant_message_id)).goal_outcome});
 }
 assert.equal(samples[0].planCount,1);assert.equal(samples[2].goal.status,'AWAITING_ACCEPTANCE');
 fs.writeFileSync('output/triage-defects-20261022/learning-chat-modes.json',JSON.stringify(samples,null,2));console.log('TRIAGE_LEARNING_CHAT_MODES',JSON.stringify(samples));
 assert.notEqual(samples[3].goal.stop_reason?.code,'NO_PROGRESS','accepted GOAL must not be doomed by a generation route without goal envelopes');
});
