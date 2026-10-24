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
import {buildRunContext} from '../../dist/src/application/context-builder.js';
import {createRepositories} from '../../dist/src/application/unit-of-work.js';
import {ManagedContentStore} from '../../dist/src/storage/managed-content-store.js';
const app=openDatabase(APP_DATABASE_URL,'triage-context-multiple-versions');let api,wid,pid;
before(async()=>{await runMigrations({connectionString:MIGRATION_DATABASE_URL,directory:MIGRATIONS_DIRECTORY});api=await startTestApi();wid=await createWorkspace(app.db);const p=await api.post(workspacePath(wid,'/projects'),{command_id:randomUUID(),title:'explicit version context',project_type:'GENERAL'});assert.equal(p.status,201,p.text);pid=p.body.result.project_id;});
after(async()=>{await api?.stop();await app.close();});
test('two accepted explicit versions of the same source must not silently collapse by root id',async()=>{
 const repos=createRepositories(app.db);const samples=[];
 const makeKnowledge=async(title,text)=>{const r=await api.post(workspacePath(wid,'/knowledge'),{command_id:randomUUID(),project_id:pid,title,source_kind:'NOTE',text});assert.equal(r.status,201,r.text);return r.body.result;};
 const first=await makeKnowledge('资料甲','V1_MARKER_original_fact');const kid=first.knowledge_id;
 const updated=await api.post(workspacePath(wid,`/knowledge/${kid}/versions`),{command_id:randomUUID(),expected_revision:first.revision,source_kind:'NOTE',text:'V2_MARKER_revised_fact'});assert.equal(updated.status,200,updated.text);
 const other=await makeKnowledge('资料乙','OTHER_MARKER_control_fact');
 for(const [name,refs] of [
  ['different-roots',[{kind:'KNOWLEDGE',root_id:kid,version:'1'},{kind:'KNOWLEDGE',root_id:other.knowledge_id,version:'1'}]],
  ['same-root-v1-v2',[{kind:'KNOWLEDGE',root_id:kid,version:'1'},{kind:'KNOWLEDGE',root_id:kid,version:'2'}]],
  ['same-root-v2-v1',[{kind:'KNOWLEDGE',root_id:kid,version:'2'},{kind:'KNOWLEDGE',root_id:kid,version:'1'}]],
 ]){
  const created=await createTask(app.db,{workspaceId:wid,projectId:pid,commandId:randomUUID(),title:'比较选定来源',objective:'核对两份明确选定的依据',criteria:[{statement:'依据核对完成'}],expectedOutputs:{},mode:'AI_ASSIST'});const tid=created.result.task_id;
  const ready=await markTaskReady(app.db,{workspaceId:wid,taskId:tid,commandId:randomUUID(),expectedRevision:created.result.revision});
  const delegated=await delegateTask(app.db,{workspaceId:wid,taskId:tid,commandId:randomUUID(),expectedTaskRevision:ready.result.revision,contextSources:refs});
  const rid=delegated.result.run_id,run=await repos.runs.readRun(rid),task=await repos.tasks.readTask(tid),contract=await repos.runs.readContract(rid);
  const built=await buildRunContext(app.db,{run,task,storage:new ManagedContentStore(api.dataRoot),budgetTokens:100000});assert.equal(built.kind,'READY');
  const explicit=built.payload.sources.filter(s=>s.selection_reason==='EXPLICIT_SELECTION');
  samples.push({name,submitted:refs,frozen:contract.frozen_snapshot.context_sources,explicitSources:explicit.map(s=>({ref:s.source_ref,version:s.version,content:s.content})),exclusions:built.payload.exclusions,budget:built.payload.budget});
 }
 assert.equal(samples[0].explicitSources.length,2,'control: two distinct roots fit in the context budget');
 fs.writeFileSync('output/triage-defects-20261022/context-multiple-versions.json',JSON.stringify(samples,null,2));console.log('TRIAGE_CONTEXT_MULTIPLE_VERSIONS',JSON.stringify(samples));
 assert.equal(samples[1].frozen.length,2);assert.equal(samples[2].frozen.length,2);
 assert.equal(samples[1].explicitSources.length,2,'different explicit immutable versions must not be silently deduplicated as one root');
});
