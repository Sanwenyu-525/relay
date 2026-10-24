import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{before,after} from 'node:test';
import fs from 'node:fs';
import {sql} from 'kysely';
import {runMigrations} from '../../dist/src/infrastructure/migration-runner.js';
import {APP_DATABASE_URL,MIGRATION_DATABASE_URL,MIGRATIONS_DIRECTORY,openDatabase} from '../../dist/test/integration/integration-support.js';
import {createWorkspace,startTestApi,workspacePath} from '../../dist/test/integration/api-harness.js';
import {runScheduledTaskTick} from '../../dist/src/application/scheduled-tasks.js';
import {createRepositories} from '../../dist/src/application/unit-of-work.js';
const app=openDatabase(APP_DATABASE_URL,'triage-scheduled-skip-chain');let api,wid,pid;
before(async()=>{await runMigrations({connectionString:MIGRATION_DATABASE_URL,directory:MIGRATIONS_DIRECTORY});api=await startTestApi();wid=await createWorkspace(app.db);const p=await api.post(workspacePath(wid,'/projects'),{command_id:randomUUID(),title:'schedule skip chain',project_type:'GENERAL'});assert.equal(p.status,201,p.text);pid=p.body.result.project_id;});
after(async()=>{await api?.stop();await app.close();});
test('a skipped occurrence must not hide the earlier unaccepted task on the following tick',async()=>{
 const repos=createRepositories(app.db);
 const created=await api.post(workspacePath(wid,`/projects/${pid}/scheduled-tasks`),{command_id:randomUUID(),confirmed:true,title:'do not stack pending tasks',template:{task_title:'检查说明',objective:'只读检查',mode:'AI_ASSIST',criteria:[{statement:'人工确认检查结果'}]},repeat_rule:{kind:'DAILY',interval_days:1},timezone:'Asia/Shanghai',local_time:'09:00',first_local_date:new Date(Date.now()+2*86400000).toISOString().slice(0,10),max_runs:5,authorization_expires_at:new Date(Date.now()+7*86400000).toISOString()});
 assert.equal(created.status,201,created.text);const id=created.body.result.scheduled_task_id;
 const openedAt=new Date(Date.now()-86400000);
 const forceNextSlot=async(count)=>{
  // Only this isolated schedule's due timestamp is advanced; no Task/Run or occurrence state is forged.
  await sql`update scheduled_tasks set next_due_at = clock_timestamp() where id=${id}`.execute(app.db);
  await runScheduledTaskTick(app.db,openedAt);
  for(let i=0;i<100;i++){const rows=await repos.scheduledTasks.occurrences(id,20);if(rows.length>=count&&rows.every(r=>r.status!=='DISPATCHING'))return rows;await new Promise(r=>setTimeout(r,50));}
  assert.fail('occurrences did not settle');
 };
 const first=(await forceNextSlot(1)).find(r=>r.sequence===1n);assert.ok(first);assert.equal(first.status,'DISPATCHED');assert.ok(first.task_id);
 const originalTask=await repos.tasks.readTask(first.task_id);assert.ok(originalTask);assert.ok(!['DONE','CANCELLED'].includes(originalTask.status));
 const second=(await forceNextSlot(2)).find(r=>r.sequence===2n);assert.ok(second);assert.equal(second.status,'SKIPPED');assert.equal(second.reason,'PREVIOUS_TASK_NOT_ACCEPTED');assert.equal(second.task_id,null);
 const third=(await forceNextSlot(3)).find(r=>r.sequence===3n);assert.ok(third);
 const taskAfter=await repos.tasks.readTask(first.task_id);const tasks=await app.db.selectFrom('tasks').select(['id','status']).where('project_id','=',pid).execute();const row=await repos.scheduledTasks.read(id);
 const detail=await api.get(workspacePath(wid,`/scheduled-tasks/${id}`));assert.equal(detail.status,200,detail.text);
 const evidence={originalTask:{id:first.task_id,before:originalTask.status,after:taskAfter.status},occurrences:(await repos.scheduledTasks.occurrences(id,20)).map(r=>({sequence:String(r.sequence),status:r.status,reason:r.reason,taskId:r.task_id,runId:r.run_id})),taskCount:tasks.length,tasks,runsStarted:row.runs_started,thirdHttpProjection:detail.body.occurrences.find(r=>r.sequence==='3')};
 fs.writeFileSync('output/triage-defects-20261022/scheduled-skip-chain.json',JSON.stringify(evidence,null,2));console.log('TRIAGE_SCHEDULED_SKIP_CHAIN',JSON.stringify(evidence));
 assert.ok(!['DONE','CANCELLED'].includes(taskAfter.status),'control: original task is still unaccepted');
 assert.equal(third.status,'SKIPPED','one skipped slot must not release the previous unaccepted Task gate');
 assert.equal(tasks.length,1);
});
