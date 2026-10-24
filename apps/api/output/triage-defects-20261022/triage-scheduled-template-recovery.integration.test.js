import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{before,after} from 'node:test';
import fs from 'node:fs';
import {sql} from 'kysely';
import {runMigrations} from '../../dist/src/infrastructure/migration-runner.js';
import {APP_DATABASE_URL,MIGRATION_DATABASE_URL,MIGRATIONS_DIRECTORY,openDatabase} from '../../dist/test/integration/integration-support.js';
import {createWorkspace,startTestApi,workspacePath} from '../../dist/test/integration/api-harness.js';
import {scanScheduledTasks,dispatchScheduledOccurrence,editScheduledTask,resolveScheduledTaskOccurrence} from '../../dist/src/application/scheduled-tasks.js';
import {createTask} from '../../dist/src/application/create-task.js';
import {createRepositories} from '../../dist/src/application/unit-of-work.js';
const app=openDatabase(APP_DATABASE_URL,'triage-scheduled-template-recovery');let api,wid,pid;
before(async()=>{await runMigrations({connectionString:MIGRATION_DATABASE_URL,directory:MIGRATIONS_DIRECTORY});api=await startTestApi();wid=await createWorkspace(app.db);const p=await api.post(workspacePath(wid,'/projects'),{command_id:randomUUID(),title:'template recovery',project_type:'GENERAL'});assert.equal(p.status,201,p.text);pid=p.body.result.project_id;});
after(async()=>{await api?.stop();await app.close();});
test('recovery after CreateTask must replay the frozen template even if the schedule was edited',async()=>{
 const repos=createRepositories(app.db);const fixtures=[];const samples=[];
 for(const changed of [false,true]){
  const body={command_id:randomUUID(),confirmed:true,title:`recovery ${changed}`,template:{task_title:'任务A',objective:'只核对样例A',mode:'AI_ASSIST',criteria:[{statement:'A样例通过'}]},repeat_rule:{kind:'DAILY',interval_days:1},timezone:'Asia/Shanghai',local_time:'09:00',first_local_date:new Date(Date.now()+2*86400000).toISOString().slice(0,10),max_runs:5,authorization_expires_at:new Date(Date.now()+7*86400000).toISOString()};
  const response=await api.post(workspacePath(wid,`/projects/${pid}/scheduled-tasks`),body);assert.equal(response.status,201,response.text);fixtures.push({changed,body,id:response.body.result.scheduled_task_id});
 }
 // Stop only the disposable API so its background scanner cannot consume the
 // deliberate durable prefix. All following calls use the real application Owners.
 await api.stop();api=undefined;
 for(const fixture of fixtures){
  const {id,body,changed}=fixture;
  await sql`update scheduled_tasks set next_due_at=clock_timestamp() where id=${id}`.execute(app.db);
  const ids=await scanScheduledTasks(app.db,new Date(Date.now()-86400000));
  let occurrence;for(const candidate of ids){const row=await repos.scheduledTasks.readOccurrence(candidate);if(row.scheduled_task_id===id)occurrence=row;}assert.ok(occurrence);assert.equal(occurrence.status,'DISPATCHING');
  const schedule=await repos.scheduledTasks.read(id),template=schedule.template;
  // Exact committed prefix of dispatchScheduledOccurrence: create and bind Task.
  // No fake Task/Run state and no handcrafted command receipt are inserted.
  const created=await createTask(app.db,{workspaceId:wid,commandId:occurrence.create_command_id,projectId:pid,title:String(template.task_title),objective:String(template.objective),criteria:template.criteria,expectedOutputs:template.expected_outputs??{},mode:String(template.mode)});
  const tid=created.result.task_id;await repos.scheduledTasks.bindTask(occurrence.id,tid);
  let edit;
  if(changed)edit=await editScheduledTask(app.db,{workspaceId:wid,scheduledTaskId:id,commandId:randomUUID(),expectedRevision:String(schedule.revision),title:body.title,template:{...body.template,task_title:'任务B',objective:'改为核对样例B',expected_outputs:{}},repeat:body.repeat_rule,timezone:body.timezone,localTime:body.local_time,firstLocalDate:body.first_local_date,maxRuns:body.max_runs,authorizationExpiresAt:body.authorization_expires_at,execution:undefined,confirmed:true,reason:'只修改未来任务模板'});
  await dispatchScheduledOccurrence(app.db,occurrence.id);
  const first=await repos.scheduledTasks.readOccurrence(occurrence.id);let retry;
  if(first.status==='BLOCKED'){
   await resolveScheduledTaskOccurrence(app.db,{workspaceId:wid,occurrenceId:occurrence.id,commandId:randomUUID(),expectedRevision:String(first.revision),action:'RETRY',reason:'沿原身份恢复'});
   await dispatchScheduledOccurrence(app.db,occurrence.id);const second=await repos.scheduledTasks.readOccurrence(occurrence.id);retry={status:second.status,reason:second.reason};
  }
  const task=await repos.tasks.readTask(tid);const current=await repos.scheduledTasks.read(id);const taskCount=await app.db.selectFrom('tasks').select('id').where('project_id','=',pid).where('id','=',tid).execute();
  samples.push({changed,editRevision:edit?.result.revision,generationBefore:String(schedule.schedule_generation),generationAfter:String(current.schedule_generation),createCommandId:occurrence.create_command_id,taskId:tid,taskStatus:task.status,taskObjective:task.objective,occurrenceStatus:first.status,reason:first.reason,runId:first.run_id,retry,originalTaskStillExists:taskCount.length===1,runsStarted:current.runs_started});
 }
 assert.equal(samples[0].occurrenceStatus,'DISPATCHED','control: unmodified template resumes the same committed Task');
 fs.writeFileSync('output/triage-defects-20261022/scheduled-template-recovery.json',JSON.stringify(samples,null,2));console.log('TRIAGE_SCHEDULED_TEMPLATE_RECOVERY',JSON.stringify(samples));
 assert.notEqual(samples[1].reason,'CommandIdReusedError','internal recovery must not reuse the create identity with a newly edited template');
});
