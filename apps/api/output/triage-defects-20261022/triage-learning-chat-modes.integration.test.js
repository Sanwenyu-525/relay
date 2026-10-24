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
import {DomainError} from '../../dist/src/application/domain-error.js';
const app=openDatabase(APP_DATABASE_URL,'triage-learning-modes');let api,wid;
before(async()=>{await runMigrations({connectionString:MIGRATION_DATABASE_URL,directory:MIGRATIONS_DIRECTORY});api=await startTestApi();wid=await createWorkspace(app.db);});
after(async()=>{await api?.stop();await app.close();});
test('unsupported identity x mode combos are typed-rejected before accepting work; AGENT controls still settle',async()=>{
 const repos=createRepositories(app.db);const samples=[];
 for(const chatMode of ['PLAN','GOAL'])for(const conversationMode of ['AGENT','LEARNING']){
  const sid=(await createAssistSession(app.db,{workspaceId:wid,commandId:randomUUID(),projectId:null,title:`${conversationMode} ${chatMode}`,conversationMode})).result.session_id;
  const switched=await api.post(workspacePath(wid,`/assist-sessions/${sid}/chat-mode`),{command_id:randomUUID(),mode:chatMode});
  const supported=conversationMode==='AGENT';
  assert.equal(switched.status,supported?200:409,switched.text);
  if(!supported){
   assert.equal(switched.body.code,'CHAT_MODE_UNSUPPORTED_FOR_IDENTITY',switched.text);
   // 消息受理入口同样类型化拒绝（显式 chat_mode），且零目标/模式/消息副作用。
   const messageCountBefore=(await app.db.selectFrom('assist_messages').select('id').where('session_id','=',sid).execute()).length;
   let rejected=null;
   try{await requestAssistMessage(app.db,{workspaceId:wid,sessionId:sid,commandId:randomUUID(),chatMode,content:chatMode==='PLAN'?'为学习制定计划':'完成这次学习检查'});}
   catch(error){rejected=error;}
   assert.ok(rejected instanceof DomainError,'message entry must reject unsupported identity x mode with a typed DomainError');
   assert.equal(rejected.code,'CHAT_MODE_UNSUPPORTED_FOR_IDENTITY');
   assert.equal(rejected.status,409);
   const messageCountAfter=(await app.db.selectFrom('assist_messages').select('id').where('session_id','=',sid).execute()).length;
   const goalAfterSwitch=(await api.get(workspacePath(wid,`/assist-sessions/${sid}/goal`))).body.goal;
   samples.push({conversationMode,chatMode,switchHttp:switched.status,switchCode:switched.body.code,entryRejectCode:rejected.code,zeroSideEffects:messageCountBefore===messageCountAfter&&goalAfterSwitch===null});
   continue;
  }
  const sent=await requestAssistMessage(app.db,{workspaceId:wid,sessionId:sid,commandId:randomUUID(),content:chatMode==='PLAN'?'为学习制定计划':'完成这次学习检查'});
  let calls=0,learningRequests=0;
  const port={identity:new FakeModelPort().identity,assist:async(request)=>{
   calls++;if(request.learning)learningRequests++;
   const content=request.learning?'正常教学回答':JSON.stringify({reply:'已完成检查。',plan:{goal:'完成学习检查',scope:['只读学习'],steps:[{title:'检查'}],verification:[{statement:'检查完成',method:'HUMAN'}],open_questions:[]},goal:{state:'COMPLETE',success_criteria:[{key:'c1',statement:'检查完成',required:true}],criteria_status:[{key:'c1',status:'MET',evidence:'受控检查通过'}],steps:[],current_step:null,progress:'完成检查',questions:[],blocked_reason:null,adjustment:null}});
   return {kind:'CONTENT',content,...(request.learning?{learning:{increments:[],schemaError:null}}:{}),providerRequestId:`triage-${calls}`,usage:{inputTokens:1,outputTokens:1,cacheReadTokens:null,cacheCreationTokens:null}};
  }};
  const generate=async()=>{for(let i=0;i<12;i++){const r=await runAssistGenerationTick(app.db,{workerId:`generate-${randomUUID()}`,storage:new ManagedContentStore(api.dataRoot),modelPort:port,leaseMs:60000,maxMessages:1});if(r&&r.status!=='DISCARDED')return r;}assert.fail('generation did not settle');};
  assert.equal((await generate()).status,'COMPLETED');
  if(chatMode==='GOAL'){await runAssistGoalTick(app.db,{workerId:`tick-${randomUUID()}`});}
  const plans=await api.get(workspacePath(wid,`/assist-sessions/${sid}/plans`));assert.equal(plans.status,200,plans.text);
  const goal=await api.get(workspacePath(wid,`/assist-sessions/${sid}/goal`));assert.equal(goal.status,200,goal.text);
  samples.push({conversationMode,chatMode,switchHttp:switched.status,acceptedMessageMode:sent.result.chat_mode,goalId:sent.result.goal_id,calls,learningRequests,planCount:plans.body.versions.length,goal:goal.body.goal,rounds:goal.body.rounds,firstMessageGoalOutcome:(await repos.assist.readMessage(sent.result.assistant_message_id)).goal_outcome});
 }
 // AGENT 正对照：PLAN 产出一版计划；GOAL 首轮结构化结论结算到「等待人工验收」。
 assert.equal(samples[0].planCount,1);assert.equal(samples[2].goal.status,'AWAITING_ACCEPTANCE');
 // LEARNING×PLAN / LEARNING×GOAL：切换与受理入口都被类型化拒绝，零目标/消息副作用；
 // 教学轮次照常（既有 CHAT 教学能力不受影响），不再出现「受理 GOAL 后三轮 NO_STRUCTURE」。
 for(const sample of [samples[1],samples[3]]){
  assert.equal(sample.switchHttp,409);assert.equal(sample.switchCode,'CHAT_MODE_UNSUPPORTED_FOR_IDENTITY');
  assert.equal(sample.entryRejectCode,'CHAT_MODE_UNSUPPORTED_FOR_IDENTITY');assert.equal(sample.zeroSideEffects,true);
 }
 fs.writeFileSync('output/triage-defects-20261022/learning-chat-modes.json',JSON.stringify(samples,null,2));console.log('TRIAGE_LEARNING_CHAT_MODES',JSON.stringify(samples));
});
