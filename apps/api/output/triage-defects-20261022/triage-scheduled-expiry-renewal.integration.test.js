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
const app=openDatabase(APP_DATABASE_URL,'triage-scheduled-expiry-renewal');let api,wid,pid;
before(async()=>{await runMigrations({connectionString:MIGRATION_DATABASE_URL,directory:MIGRATIONS_DIRECTORY});api=await startTestApi();wid=await createWorkspace(app.db);const p=await api.post(workspacePath(wid,'/projects'),{command_id:randomUUID(),title:'expired renewal',project_type:'GENERAL'});assert.equal(p.status,201,p.text);pid=p.body.result.project_id;});
after(async()=>{await api?.stop();await app.close();});
test('expired schedule must accept an explicit authorized edit before enabling, as the HTTP contract specifies',async()=>{
 const repos=createRepositories(app.db);const samples=[];
 const makeBody=()=>({command_id:randomUUID(),confirmed:true,title:'renew schedule',template:{task_title:'检查样例',objective:'只读检查',mode:'AI_ASSIST',criteria:[{statement:'检查通过'}]},repeat_rule:{kind:'DAILY',interval_days:1},timezone:'Asia/Shanghai',local_time:'09:00',first_local_date:new Date(Date.now()+2*86400000).toISOString().slice(0,10),max_runs:5,authorization_expires_at:new Date(Date.now()+7*86400000).toISOString()});
 for(const expired of [false,true]){
  const body=makeBody();if(expired)body.authorization_expires_at=new Date(Date.now()+1200).toISOString();
  const created=await api.post(workspacePath(wid,`/projects/${pid}/scheduled-tasks`),body);assert.equal(created.status,201,created.text);const id=created.body.result.scheduled_task_id;
  if(expired){
   const remaining=new Date(body.authorization_expires_at).getTime()-Date.now();if(remaining>=0)await new Promise(r=>setTimeout(r,remaining+75));
   // Only make the isolated schedule due after the real authorization has expired.
   await sql`update scheduled_tasks set next_due_at=clock_timestamp() where id=${id}`.execute(app.db);
   await runScheduledTaskTick(app.db,new Date(Date.now()-86400000));
  }
  const before=await repos.scheduledTasks.read(id);assert.equal(before.status,expired?'EXPIRED':'ENABLED');
  const edit={...body,command_id:randomUUID(),expected_revision:String(before.revision),authorization_expires_at:new Date(Date.now()+14*86400000).toISOString(),reason:'用户显式延长授权'};
  const result=await api.post(workspacePath(wid,`/scheduled-tasks/${id}/edits`),edit);
  const after=await repos.scheduledTasks.read(id);let enable,detour;
  if(expired){
   enable=await api.post(workspacePath(wid,`/scheduled-tasks/${id}/status-changes`),{command_id:randomUUID(),expected_revision:String(after.revision),status:'ENABLED',reason:'延长授权后继续'});
   const paused=await api.post(workspacePath(wid,`/scheduled-tasks/${id}/status-changes`),{command_id:randomUUID(),expected_revision:String(after.revision),status:'PAUSED',reason:'诊断是否存在状态绕行'});
   assert.equal(paused.status,200,paused.text);
   const reroute=await api.post(workspacePath(wid,`/scheduled-tasks/${id}/edits`),{...edit,command_id:randomUUID(),expected_revision:paused.body.result.revision});
   detour={pauseHttp:paused.status,editAfterPauseHttp:reroute.status};
  }
  samples.push({expired,beforeStatus:before.status,editHttp:result.status,editBody:result.body,expiryBefore:before.authorization_expires_at.toISOString(),expiryAfterDirectEdit:after.authorization_expires_at.toISOString(),enableHttp:enable?.status,enableBody:enable?.body,detour});
 }
 assert.equal(samples[0].editHttp,200,'control: enabled schedule accepts explicit expiry extension');
 fs.writeFileSync('output/triage-defects-20261022/scheduled-expiry-renewal.json',JSON.stringify(samples,null,2));console.log('TRIAGE_SCHEDULED_EXPIRY_RENEWAL',JSON.stringify(samples));
 assert.equal(samples[1].editHttp,200,'contract says EXPIRED must first be editable to extend authorization');
});
