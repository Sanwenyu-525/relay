import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{before,after} from 'node:test';
import fs from 'node:fs';
import {sql} from 'kysely';
import {runMigrations} from '../../dist/src/infrastructure/migration-runner.js';
import {APP_DATABASE_URL,MIGRATION_DATABASE_URL,MIGRATIONS_DIRECTORY,openDatabase} from '../../dist/test/integration/integration-support.js';
import {createWorkspace,startTestApi,workspacePath} from '../../dist/test/integration/api-harness.js';
import {scanScheduledTasks,dispatchScheduledOccurrence} from '../../dist/src/application/scheduled-tasks.js';
import {freezeTaskChainExecution,requireTaskChainExecutionCurrent} from '../../dist/src/application/task-chain-execution.js';
import {addKnowledgeVersion} from '../../dist/src/application/information-commands.js';
import {createTask} from '../../dist/src/application/create-task.js';
import {createRepositories,withTransaction} from '../../dist/src/application/unit-of-work.js';
const app=openDatabase(APP_DATABASE_URL,'triage-scheduled-source-drift');let api,wid,pid;
before(async()=>{await runMigrations({connectionString:MIGRATION_DATABASE_URL,directory:MIGRATIONS_DIRECTORY});api=await startTestApi();wid=await createWorkspace(app.db);const p=await api.post(workspacePath(wid,'/projects'),{command_id:randomUUID(),title:'frozen source drift',project_type:'GENERAL'});assert.equal(p.status,201,p.text);pid=p.body.result.project_id;});
after(async()=>{await api?.stop();await app.close();});
test('scheduled recovery must check existing frozen source references instead of rebaselining them',async()=>{
 const repos=createRepositories(app.db),fixtures=[],samples=[];
 for(const drift of [false,true]){
  const k=await api.post(workspacePath(wid,'/knowledge'),{command_id:randomUUID(),project_id:pid,title:`source ${drift}`,source_kind:'NOTE',text:'v1 已确认的样例依据'});assert.equal(k.status,201,k.text);const kid=k.body.result.knowledge_id;
  const created=await api.post(workspacePath(wid,`/projects/${pid}/scheduled-tasks`),{command_id:randomUUID(),confirmed:true,title:`frozen ${drift}`,template:{task_title:'检查样例',objective:'按冻结依据检查',mode:'AI_ASSIST',criteria:[{statement:'检查完成'}]},repeat_rule:{kind:'DAILY',interval_days:1},timezone:'Asia/Shanghai',local_time:'09:00',first_local_date:new Date(Date.now()+2*86400000).toISOString().slice(0,10),max_runs:5,authorization_expires_at:new Date(Date.now()+7*86400000).toISOString(),execution:{context_sources:[{kind:'KNOWLEDGE',root_id:kid,version:'1'}]}});assert.equal(created.status,201,created.text);
  fixtures.push({drift,kid,id:created.body.result.scheduled_task_id});
 }
 await api.stop();api=undefined;
 for(const {drift,kid,id} of fixtures){
  await sql`update scheduled_tasks set next_due_at=clock_timestamp() where id=${id}`.execute(app.db);const ids=await scanScheduledTasks(app.db,new Date(Date.now()-86400000));let o;
  for(const candidate of ids){const row=await repos.scheduledTasks.readOccurrence(candidate);if(row.scheduled_task_id===id)o=row;}assert.ok(o);
  const schedule=await repos.scheduledTasks.read(id),t=schedule.template;
  const created=await createTask(app.db,{workspaceId:wid,commandId:o.create_command_id,projectId:pid,title:t.task_title,objective:t.objective,criteria:t.criteria,expectedOutputs:t.expected_outputs??{},mode:t.mode});const tid=created.result.task_id;
  await repos.scheduledTasks.bindTask(o.id,tid);
  const frozen=await withTransaction(app.db,r=>freezeTaskChainExecution(r,wid,pid,tid,schedule.execution_input));await repos.scheduledTasks.freezeExecution(o.id,frozen);
  if(drift){const root=await repos.information.readRoot('knowledge',kid);await addKnowledgeVersion(app.db,{workspaceId:wid,knowledgeId:kid,commandId:randomUUID(),expectedRevision:String(root.revision),source:{sourceKind:'NOTE',text:'v2 已变更的样例依据'}});}
  let originalCheck='CURRENT';try{await withTransaction(app.db,r=>requireTaskChainExecutionCurrent(r,wid,pid,frozen,tid));}catch(error){originalCheck=error.code??error.name;}
  await dispatchScheduledOccurrence(app.db,o.id);const after=await repos.scheduledTasks.readOccurrence(o.id);
  samples.push({drift,originalCheck,frozenBefore:frozen,frozenAfter:after.frozen_execution,occurrenceStatus:after.status,reason:after.reason,runId:after.run_id,taskStatus:(await repos.tasks.readTask(tid)).status,pinnedContextVersionBefore:frozen.context_sources[0].version,pinnedContextVersionAfter:after.frozen_execution.context_sources[0].version});
 }
 assert.equal(samples[0].originalCheck,'CURRENT');assert.equal(samples[0].occurrenceStatus,'DISPATCHED');assert.equal(samples[1].originalCheck,'INVALID_TRANSITION','control: existing frozen reference check detects real source drift');
 fs.writeFileSync('output/triage-defects-20261022/scheduled-frozen-source-drift.json',JSON.stringify(samples,null,2));console.log('TRIAGE_SCHEDULED_FROZEN_SOURCE_DRIFT',JSON.stringify(samples));
 assert.equal(samples[1].occurrenceStatus,'BLOCKED','recovery must not replace invalidated frozen references and grant execution');
 assert.deepEqual(samples[1].frozenAfter,samples[1].frozenBefore);
});
