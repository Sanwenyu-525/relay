import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{before,after} from 'node:test';
import fs from 'node:fs';
import {sql} from 'kysely';
import {runMigrations} from '../../dist/src/infrastructure/migration-runner.js';
import {APP_DATABASE_URL,MIGRATION_DATABASE_URL,MIGRATIONS_DIRECTORY,openDatabase} from '../../dist/test/integration/integration-support.js';
import {createWorkspace,startTestApi} from '../../dist/test/integration/api-harness.js';
import {createAssistSession,requestAssistMessage} from '../../dist/src/application/assist-commands.js';
import {runAssistGenerationTick} from '../../dist/src/application/assist-runner.js';
import {ManagedContentStore} from '../../dist/src/storage/managed-content-store.js';
import {OpenAiCompatibleModelPort} from '../../dist/src/workflow/openai-compatible-model-port.js';
const app=openDatabase(APP_DATABASE_URL,'triage-plan-goal-model-ledger');let api,wid;
before(async()=>{await runMigrations({connectionString:MIGRATION_DATABASE_URL,directory:MIGRATIONS_DIRECTORY});api=await startTestApi();wid=await createWorkspace(app.db);});
after(async()=>{await api?.stop();await app.close();});
test('default-compatible PLAN/GOAL calls must use the same ledger and scope budget as plain CHAT',async()=>{
 const results=[];
 for(const mode of ['CHAT','PLAN','GOAL']){
  let wireCalls=0;
  const content=JSON.stringify({summary:'已读现状。',proposals:[],reply:'已读现状。',plan:{goal:'补齐说明',scope:[],steps:[],verification:[{statement:'说明完整',method:'HUMAN'}],open_questions:[]},goal:{state:'CONTINUE',success_criteria:[{key:'c1',statement:'说明完整',required:true}],criteria_status:[],steps:[],current_step:null,progress:'读现状',questions:[],blocked_reason:null,adjustment:null}});
  const port=new OpenAiCompatibleModelPort({provider:'openai-compatible',model:'fixture-ledger',apiKey:'fixture-not-a-real-key',baseUrl:'https://models.vendor.com/v1',timeoutMs:1000,maxOutputTokens:256,maxCallTokens:65536,maxScopeCalls:1,maxScopeTokens:262144},{lookup:async()=>[{address:'8.8.8.8',family:4}],fetch:async()=>{wireCalls++;const chunk={id:`triage-${mode}-${wireCalls}`,object:'chat.completion.chunk',created:1,model:'fixture-ledger',choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:17,completion_tokens:3}};return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});}});
  const sid=(await createAssistSession(app.db,{workspaceId:wid,commandId:randomUUID(),projectId:null,title:`ledger ${mode}`})).result.session_id;
  const outcomes=[];
  for(let round=0;round<2;round++){
   const sent=await requestAssistMessage(app.db,{workspaceId:wid,sessionId:sid,commandId:randomUUID(),chatMode:mode,content:'核对现状'});
   let out;for(let i=0;i<12;i++){out=await runAssistGenerationTick(app.db,{workerId:`generate-${randomUUID()}`,storage:new ManagedContentStore(api.dataRoot),modelPort:port,leaseMs:60000,maxMessages:1});if(out?.messageId===sent.result.assistant_message_id&&out.status!=='DISCARDED')break;}
   outcomes.push(out);
  }
  assert.equal(outcomes[0].status,'COMPLETED',JSON.stringify(outcomes));
  const ledger=(await sql`select c.id,c.status,c.usage_input_tokens,c.usage_output_tokens from model_calls c join assist_messages m on m.id=c.assist_message_id where m.session_id=${sid}`.execute(app.db)).rows;
  results.push({mode,wireCalls,outcomes,ledgerRows:ledger.length,ledger});
 }
 assert.equal(results[0].wireCalls,1);assert.equal(results[0].ledgerRows,1);assert.equal(results[0].outcomes[1].errorCode,'MODEL_BUDGET_EXHAUSTED');
 fs.writeFileSync('output/triage-defects-20261022/plan-goal-model-ledger.json',JSON.stringify(results,null,2));console.log('TRIAGE_PLAN_GOAL_MODEL_LEDGER',JSON.stringify(results));
 assert.ok(results.slice(1).every(r=>r.wireCalls===1&&r.ledgerRows===1),'PLAN and GOAL default model routes bypassed ledger admission and allowed two calls under a one-call scope cap');
});

