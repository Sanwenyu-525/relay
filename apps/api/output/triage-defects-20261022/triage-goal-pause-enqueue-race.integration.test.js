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
import { PlanGoalRepository } from '../../dist/src/assist/plan-goal-repository.js';
import { ManagedContentStore } from '../../dist/src/storage/managed-content-store.js';
import { FakeModelPort } from '../../dist/src/workflow/fake-model-port.js';
const app=openDatabase(APP_DATABASE_URL,'triage-goal-pause-enqueue-race');
let api,wid;
before(async()=>{await runMigrations({connectionString:MIGRATION_DATABASE_URL,directory:MIGRATIONS_DIRECTORY});api=await startTestApi();wid=await createWorkspace(app.db);});
after(async()=>{await api?.stop();await app.close();});
for(const control of ['pause','cancel']) test(`a committed ${control} after the advance lease claim must prevent enqueueing a new round`,async()=>{
 const repos=createRepositories(app.db);
 const sid=(await createAssistSession(app.db,{workspaceId:wid,commandId:randomUUID(),projectId:null,title:'pause enqueue race'})).result.session_id;
 const sent=await requestAssistMessage(app.db,{workspaceId:wid,sessionId:sid,commandId:randomUUID(),chatMode:'PLAN',content:'制定计划'});
 let modelCalls=0;
 const port={identity:new FakeModelPort().identity,assist:async()=>{modelCalls++;return {kind:'CONTENT',content:JSON.stringify({reply:'只做一小步。',plan:{goal:'补齐说明',scope:[],steps:[{title:'读现状'}],verification:[{statement:'说明完整',method:'HUMAN'}],open_questions:[]},goal:{state:'CONTINUE',success_criteria:[],criteria_status:[],steps:[],current_step:null,progress:'读现状',questions:[],blocked_reason:null,adjustment:null}}),providerRequestId:`triage-${modelCalls}`,usage:{inputTokens:1,outputTokens:1,cacheReadTokens:null,cacheCreationTokens:null}};}};
 const generate=()=>runAssistGenerationTick(app.db,{workerId:`generate-${randomUUID()}`,storage:new ManagedContentStore(api.dataRoot),modelPort:port,leaseMs:60000,maxMessages:1});
 for(let i=0;i<12;i++){const out=await generate();if(out?.messageId===sent.result.assistant_message_id&&out.status!=='DISCARDED')break;}
 const plan=(await repos.planGoals.listPlans(sid))[0];assert.ok(plan);
 const start=await api.post(workspacePath(wid,`/assist-sessions/${sid}/goals`),{command_id:randomUUID(),plan_id:plan.id});
 assert.equal(start.status,200,start.text);
 const gid=start.body.result.goal.goal_id;
 assert.equal(await repos.planGoals.readInflightRoundMessage(gid),undefined);
 const original=PlanGoalRepository.prototype.updateGoal;
 let pauseResult,pausedBeforeInsert,inflightAtPause,injected=false;
 PlanGoalRepository.prototype.updateGoal=async function(id,revision,patch){
  const applied=await original.call(this,id,revision,patch);
  if(applied&&id===gid&&patch.leaseOwner&&!injected){
   injected=true;
   pauseResult=await api.post(workspacePath(wid,`/assist-goals/${gid}/${control}`),{command_id:randomUUID()});
   assert.equal(pauseResult.status,200,pauseResult.text);
   if(control==='cancel') await runAssistGoalTick(app.db,{workerId:`control-settle-${randomUUID()}`});
   pausedBeforeInsert=(await repos.planGoals.readGoal(gid)).status;
   inflightAtPause=await repos.planGoals.readInflightRoundMessage(gid);
  }
  return applied;
 };
 let tick;
 try{tick=await runAssistGoalTick(app.db,{workerId:`advance-${randomUUID()}`});}
 finally{PlanGoalRepository.prototype.updateGoal=original;}
 assert.equal(injected,true);assert.equal(pausedBeforeInsert,control==='pause'?'PAUSING':'CANCELLED');assert.equal(inflightAtPause,undefined);
 const afterTick=await repos.planGoals.readInflightRoundMessage(gid);
 const callsBefore=modelCalls;
 let generated;
 if(afterTick)generated=await generate();
 const evidence={control,pauseStatus:pauseResult.status,pausedBeforeInsert,noInflightAtPause:inflightAtPause===undefined,tick,enqueuedAfterPause:afterTick?{id:afterTick.id,status:afterTick.status}:null,modelCallsAfterPause:modelCalls-callsBefore,generationAfterPause:generated,goalAfter:(await repos.planGoals.readGoal(gid)).status};
 fs.writeFileSync(`output/triage-defects-20261022/goal-${control}-enqueue-race.json`,JSON.stringify(evidence,null,2));
 console.log('TRIAGE_GOAL_PAUSE_ENQUEUE_RACE',JSON.stringify(evidence));
 assert.equal(afterTick,undefined,'pause was already committed with no inflight messages; worker must not enqueue a new round');
});
