import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{before,after} from 'node:test';
import fs from 'node:fs';
import {runMigrations} from '../../dist/src/infrastructure/migration-runner.js';
import {APP_DATABASE_URL,MIGRATION_DATABASE_URL,MIGRATIONS_DIRECTORY,openDatabase} from '../../dist/test/integration/integration-support.js';
import {createWorkspace,startTestApi,workspacePath} from '../../dist/test/integration/api-harness.js';
import {resolveLocalDateTime,nextDueAt} from '../../dist/src/application/zoned-time.js';
import {createRepositories} from '../../dist/src/application/unit-of-work.js';
const app=openDatabase(APP_DATABASE_URL,'triage-scheduled-dst');let api,wid,pid;
before(async()=>{await runMigrations({connectionString:MIGRATION_DATABASE_URL,directory:MIGRATIONS_DIRECTORY});api=await startTestApi();wid=await createWorkspace(app.db);const p=await api.post(workspacePath(wid,'/projects'),{command_id:randomUUID(),title:'DST clock check',project_type:'GENERAL'});assert.equal(p.status,201,p.text);pid=p.body.result.project_id;});
after(async()=>{await api?.stop();await app.close();});
test('scheduled fall-back overlap must persist the earlier valid instant in both east and west UTC zones',async()=>{
 const samples=[];const repos=createRepositories(app.db);
 for(const sample of [
  {timezone:'America/New_York',localDate:'2026-11-01',hour:1,minute:30,earlier:'2026-11-01T05:30:00.000Z',later:'2026-11-01T06:30:00.000Z'},
  {timezone:'Europe/Berlin',localDate:'2026-10-25',hour:2,minute:30,earlier:'2026-10-25T00:30:00.000Z',later:'2026-10-25T01:30:00.000Z'}
 ]){
  const formatter=new Intl.DateTimeFormat('sv-SE',{timeZone:sample.timezone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  const earlierWall=formatter.format(new Date(sample.earlier)),laterWall=formatter.format(new Date(sample.later));assert.equal(earlierWall,laterWall,'two distinct instants must be the same local wall time');
  const [year,month,day]=sample.localDate.split('-').map(Number);const localTime=`${String(sample.hour).padStart(2,'0')}:${String(sample.minute).padStart(2,'0')}`;
  const resolved=resolveLocalDateTime({year,month,day},{hour:sample.hour,minute:sample.minute},sample.timezone).toISOString();
  const next=nextDueAt({rule:{kind:'DAILY',interval_days:1},timezone:sample.timezone,localTime,from:new Date(new Date(sample.earlier).getTime()-86400000),anchor:new Date(sample.earlier)}).toISOString();
  const created=await api.post(workspacePath(wid,`/projects/${pid}/scheduled-tasks`),{command_id:randomUUID(),confirmed:true,title:`overlap ${sample.timezone}`,template:{task_title:'检查说明',objective:'只读检查样例',mode:'AI_ASSIST',criteria:[{statement:'检查完成'}]},repeat_rule:{kind:'DAILY',interval_days:1},timezone:sample.timezone,local_time:localTime,first_local_date:sample.localDate,max_runs:1,authorization_expires_at:new Date(Date.now()+30*86400000).toISOString()});
  assert.equal(created.status,201,created.text);const id=created.body.result.scheduled_task_id;const row=await repos.scheduledTasks.read(id);assert.ok(row);
  samples.push({...sample,earlierWall,laterWall,resolved,nextDueCalculated:next,httpCreate:created.status,persistedFirst:row.first_run_at.toISOString(),persistedNext:row.next_due_at.toISOString(),delayMs:row.first_run_at.getTime()-new Date(sample.earlier).getTime()});
 }
 assert.equal(samples[0].persistedFirst,samples[0].earlier,'New York control must choose earlier instant');
 fs.writeFileSync('output/triage-defects-20261022/scheduled-dst-overlap.json',JSON.stringify(samples,null,2));console.log('TRIAGE_SCHEDULED_DST_OVERLAP',JSON.stringify(samples));
 assert.equal(samples[1].persistedFirst,samples[1].earlier,'Berlin overlap must not silently choose the later instant');
});
