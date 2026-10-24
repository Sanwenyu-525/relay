import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{before,after} from 'node:test';
import fs from 'node:fs';
import {runMigrations} from '../../dist/src/infrastructure/migration-runner.js';
import {APP_DATABASE_URL,MIGRATION_DATABASE_URL,MIGRATIONS_DIRECTORY,openDatabase} from '../../dist/test/integration/integration-support.js';
import {createWorkspace,startTestApi,workspacePath} from '../../dist/test/integration/api-harness.js';
import {createTask} from '../../dist/src/application/create-task.js';
import {markTaskReady} from '../../dist/src/application/task-commands.js';
import {delegateTask} from '../../dist/src/application/delegate-task.js';
import {advanceRunStep} from '../../dist/src/application/run-steps.js';
import {ManagedContentStore} from '../../dist/src/storage/managed-content-store.js';
const app=openDatabase(APP_DATABASE_URL,'triage-context-retired-explicit');let api,wid,pid;
before(async()=>{await runMigrations({connectionString:MIGRATION_DATABASE_URL,directory:MIGRATIONS_DIRECTORY});api=await startTestApi();wid=await createWorkspace(app.db);const p=await api.post(workspacePath(wid,'/projects'),{command_id:randomUUID(),title:'context identity redaction',project_type:'GENERAL'});assert.equal(p.status,201,p.text);pid=p.body.result.project_id;});
after(async()=>{await api?.stop();await app.close();});
test('retired explicit sources must disappear from embedded CONTRACT data as well as source rows',async()=>{
 const samples=[];
 for(const explicit of [false,true]){
  const secret=`RETIRED_CONTENT_MARKER_${explicit}`;
  const k=await api.post(workspacePath(wid,'/knowledge'),{command_id:randomUUID(),project_id:pid,title:'资料',source_kind:'NOTE',text:secret});assert.equal(k.status,201,k.text);const kid=k.body.result.knowledge_id;
  const created=await createTask(app.db,{workspaceId:wid,projectId:pid,commandId:randomUUID(),title:'资料',objective:'检查选定资料',criteria:[{statement:'检查通过'}],expectedOutputs:{},mode:'AI_ASSIST'});const tid=created.result.task_id;
  const ready=await markTaskReady(app.db,{workspaceId:wid,taskId:tid,commandId:randomUUID(),expectedRevision:created.result.revision});
  const delegated=await delegateTask(app.db,{workspaceId:wid,taskId:tid,commandId:randomUUID(),expectedTaskRevision:ready.result.revision,...(explicit?{contextSources:[{kind:'KNOWLEDGE',root_id:kid,version:'1'}]}:{})});const rid=delegated.result.run_id;
  const built=await advanceRunStep(app.db,{runId:rid,workerId:`context-${randomUUID()}`,storage:new ManagedContentStore(api.dataRoot)});assert.equal(built.status,'STEP_SUCCEEDED');assert.equal(built.step_kind,'BUILD_CONTEXT');
  const list=await api.get(workspacePath(wid,`/runs/${rid}/context-manifests`));assert.equal(list.status,200,list.text);assert.equal(list.body.items.length,1);
  const url=workspacePath(wid,`/runs/${rid}/context-manifests/${list.body.items[0].id}`);
  const before=await api.get(url);assert.equal(before.status,200,before.text);assert.ok(JSON.stringify(before.body).includes(secret));
  const archive=await api.post(workspacePath(wid,`/knowledge/${kid}/archive`),{command_id:randomUUID(),expected_revision:k.body.result.revision});assert.equal(archive.status,200,archive.text);
  const after=await api.get(url);assert.equal(after.status,200,after.text);const serialized=JSON.stringify(after.body);
  samples.push({explicit,knowledgeId:kid,knowledgeRowsBefore:before.body.sources.filter(s=>s.kind==='KNOWLEDGE').length,knowledgeRowsAfter:after.body.sources.filter(s=>s.kind==='KNOWLEDGE').length,bodyStillVisible:serialized.includes(secret),identityStillVisible:serialized.includes(kid),identityLocations:after.body.sources.filter(s=>JSON.stringify(s).includes(kid)).map(s=>({kind:s.kind,source_ref:s.source_ref,content:s.content})),budget:after.body.budget,exclusions:after.body.exclusions});
 }
 assert.equal(samples[0].bodyStillVisible,false);assert.equal(samples[0].identityStillVisible,false,'automatic source control removes the retired identity');assert.equal(samples[1].bodyStillVisible,false,'redaction does remove the retired body');assert.equal(samples[1].knowledgeRowsAfter,0);
 fs.writeFileSync('output/triage-defects-20261022/context-retired-explicit-identity.json',JSON.stringify(samples,null,2));console.log('TRIAGE_CONTEXT_RETIRED_EXPLICIT',JSON.stringify(samples));
 assert.equal(samples[1].identityStillVisible,false,'retired source identity must not survive inside a visible CONTRACT source');
});
