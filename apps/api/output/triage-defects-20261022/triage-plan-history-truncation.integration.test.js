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
const app=openDatabase(APP_DATABASE_URL,'triage-plan-history-truncation');
let api,wid;
before(async()=>{await runMigrations({connectionString:MIGRATION_DATABASE_URL,directory:MIGRATIONS_DIRECTORY});api=await startTestApi();wid=await createWorkspace(app.db);});
after(async()=>{await api?.stop();await app.close();});
test('session plans read must not silently hide version 1 after 21 normal plan revisions',async()=>{
 const repos=createRepositories(app.db);
 const sid=(await createAssistSession(app.db,{workspaceId:wid,commandId:randomUUID(),projectId:null,title:'21 plan revisions'})).result.session_id;
 let current=0;
 const port={identity:new FakeModelPort().identity,assist:async()=>({kind:'CONTENT',content:JSON.stringify({reply:`计划第${current}版。`,plan:{goal:`版本${current}`,scope:[],steps:[{title:'读现状'}],verification:[{statement:'人工核对',method:'HUMAN'}],open_questions:[]}}),providerRequestId:`plan-${current}`,usage:{inputTokens:1,outputTokens:1,cacheReadTokens:null,cacheCreationTokens:null}})};
 for(current=1;current<=21;current++){
  const sent=await requestAssistMessage(app.db,{workspaceId:wid,sessionId:sid,commandId:randomUUID(),chatMode:'PLAN',content:`修改为计划${current}`});
  for(let i=0;i<12;i++){
   const out=await runAssistGenerationTick(app.db,{workerId:`triage-${randomUUID()}`,storage:new ManagedContentStore(api.dataRoot),modelPort:port,leaseMs:60000,maxMessages:1});
   if(out?.messageId===sent.result.assistant_message_id&&out.status!=='DISCARDED')break;
  }
  assert.equal((await repos.assist.readMessage(sent.result.assistant_message_id)).status,'COMPLETED');
 }
 const stored=await repos.planGoals.listPlans(sid,100);
 assert.equal(stored.length,21);
 const first=stored.find(p=>p.version===1);
 const read=await api.get(workspacePath(wid,`/assist-sessions/${sid}/plans`));
 assert.equal(read.status,200,read.text);
 assert.equal(read.body.latest.version,21);
 const old=await api.get(workspacePath(wid,`/assist-sessions/${sid}/plans/${first.id}`));
 assert.equal(old.status,200,old.text);assert.equal(old.body.version,1);
 const evidence={storedVersions:stored.map(p=>p.version),read:read.body,oldVersionByKnownId:old.body,responseKeys:Object.keys(read.body)};
 fs.writeFileSync('output/triage-defects-20261022/plan-history-truncation.json',JSON.stringify(evidence,null,2));
 console.log('TRIAGE_PLAN_HISTORY_TRUNCATION',JSON.stringify({storedCount:stored.length,returnedCount:read.body.versions.length,returnedVersions:read.body.versions.map(p=>p.version),responseKeys:Object.keys(read.body),oldVersionByKnownIdStatus:old.status}));
 assert.equal(read.body.versions.length,21,'all stored versions must be available or accompanied by a working continuation contract');
});
