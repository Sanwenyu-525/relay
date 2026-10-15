import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test,{before,after} from 'node:test';
import { sql } from 'kysely';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { applySafeControl } from '../../src/application/control-requests.js';
import { ModelCallRepository } from '../../src/model/model-call-repository.js';
import { runOneCommand } from '../../src/worker/run-command.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL,MIGRATION_DATABASE_URL,MIGRATIONS_DIRECTORY,openDatabase } from './integration-support.js';
import { createWorkspace,expectCommandAccepted,startTestApi,stopApi,workspacePath,delay,type TestApi } from './api-harness.js';
const app=openDatabase(APP_DATABASE_URL,'relay-task-chain-test');let api:TestApi;
const retainedApis:TestApi[]=[];
before(async()=>{await runMigrations({connectionString:MIGRATION_DATABASE_URL,directory:MIGRATIONS_DIRECTORY});api=await startTestApi();});
after(async()=>{await api?.stop();for(const previous of retainedApis)await previous.stop();await app.close();});
type Item={task_id:string;run_id:string|null;status:string;completion_id:string|null};
async function fixture(){const workspaceId=await createWorkspace(app.db);const path=(s:string)=>workspacePath(workspaceId,s);
 const post=async(s:string,body:Record<string,unknown>,status:200|201=200)=>{const id=typeof body.command_id==='string'?body.command_id:randomUUID();return expectCommandAccepted(await api.post(path(s),{command_id:id,...body}),status,id);};
 const read=async(s:string)=>{const r=await api.get(path(s));assert.equal(r.status,200,r.text);return r.body as Record<string,unknown>;};
 const projectId=(await post('/projects',{title:'有限任务链',project_type:'GENERAL'},201)).project_id as string;const ids=[];
 for(const title of ['第一项报告','第二项说明'])ids.push((await post('/tasks',{project_id:projectId,title,objective:`完成${title}`,criteria:[{criterion_id:'human',statement:'人工核对确切产物',method:'HUMAN'}]},201)).task_id as string);
 await post(`/tasks/${ids[1]}/dependency-links`,{expected_revision:'0',depends_on_task_id:ids[0],dependency_kind:'BLOCKS'});
 const r=createRepositories(app.db);const tasks=[];for(const id of ids){const t=(await r.tasks.readTask(id))!;tasks.push({task_id:id,expected_revision:t.revision.toString(),expected_acceptance_revision:t.acceptance_revision.toString()});}
 const created=await post(`/projects/${projectId}/task-chains`,{title:'顺序写两项',confirmed:true,tasks},201);const chainId=created.chain_id as string;
 const chain=()=>read(`/task-chains/${chainId}`);
 const wait=async(predicate:(v:Record<string,unknown>)=>boolean)=>{const until=Date.now()+10000;while(Date.now()<until){const v=await chain();if(predicate(v))return v;await delay(80);}throw new Error(`链状态未达预期：${JSON.stringify(await chain())}`);};
 const authorize=async(maxCalls=4)=>{const c=await chain();return post(`/task-chains/${chainId}/authorizations`,{expected_revision:c.revision,confirmed:true,max_tasks:2,max_model_calls:maxCalls,expires_at:new Date(Date.now()+600000).toISOString()});};
 const worker=()=>runOneCommand(app.db,{workerId:`chain-test:${randomUUID()}`,dataRoot:api.dataRoot,checkpointUrl:APP_DATABASE_URL});
 const approve=async(runId:string)=>{const list=await read('/reviews?status=OPEN');const review=(list.items as Record<string,unknown>[]).find(v=>v.run_id===runId);assert.ok(review);await post(`/reviews/${review.id}/decisions`,{expected_revision:review.revision,target_hash:review.target_hash,decision:'ACCEPT'});};
 const bound=async(index:number)=>(await wait(v=>(v.items as Item[])[index]?.run_id!==null)).items as Item[];
 return {workspaceId,projectId,ids,chainId,path,post,read,chain,wait,authorize,worker,approve,bound};
}
test('明确授权后生产 Worker/LangGraph 串行执行，原人工验收/完成后才进入下一项',async()=>{
 const f=await fixture();assert.equal((await f.chain()).status,'DRAFT');assert.ok(((await f.chain()).items as Item[]).every(i=>i.run_id===null));
 await f.authorize();const first=(await f.bound(0))[0]!;const runId=first.run_id!;
 assert.equal((await f.worker())?.runId,runId);assert.equal(((await f.chain()).items as Item[])[1]?.run_id,null);
 await f.approve(runId);await f.worker();const second=(await f.bound(1))[1]!;
 assert.equal(((await f.chain()).items as Item[])[0]?.status,'COMPLETED');assert.notEqual(second.run_id,runId);
 await f.worker();await f.approve(second.run_id!);await f.worker();const done=await f.wait(v=>v.status==='COMPLETED');
 assert.equal(done.task_reservations,2);assert.equal(done.calls_started,2);assert.ok((done.items as Item[]).every(i=>i.completion_id!==null));
 assert.equal(((await f.read(`/projects/${f.projectId}/task-chains`)).items as unknown[]).length,1);
});
test('累计模型调用上限阻止后续委托，未知用量保留原预留且不按零续跑',async()=>{
 const f=await fixture();await f.authorize(1);const runId=(await f.bound(0))[0]!.run_id!;
 await f.worker();await f.approve(runId);await f.worker();const blocked=await f.wait(v=>v.status==='BLOCKED');assert.equal(blocked.calls_started,1);assert.equal((blocked.items as Item[])[1]?.run_id,null);
 const g=await fixture();await g.authorize(3);const other=(await g.bound(0))[0]!.run_id!;await g.worker();
 const origin=(await sql<{step_attempt_id:string;manifest_id:string;input_sha256:string}>`select c.step_attempt_id,c.manifest_id,c.input_sha256 from model_calls c join step_attempts a on a.id=c.step_attempt_id join run_steps s on s.id=a.step_id where s.run_id=${other} order by c.started_at limit 1`.execute(app.db)).rows[0]!;
 const calls=new ModelCallRepository(app.db);const callId=randomUUID();await calls.begin(callId,{workspaceId:g.workspaceId,kind:'DRAFT',stepAttemptId:origin.step_attempt_id,manifestId:origin.manifest_id,inputHash:origin.input_sha256},{provider:'fake',model:'fixture',configFingerprint:'a'.repeat(64)});await calls.settle(callId,{status:'FAILED',errorKind:'FIXTURE_UNKNOWN_USAGE'});
 await g.approve(other);await g.worker();const unknown=await g.wait(v=>v.status==='BLOCKED');assert.equal(unknown.calls_started,2);assert.equal((unknown.model_usage as {uncertain_calls:number}).uncertain_calls,1);assert.equal((unknown.items as Item[])[1]?.run_id,null);
});
test('持久暂停请求与已暂停分开，明确续授权沿原 Run 恢复且累计预算不重置',async()=>{
 const f=await fixture();await f.authorize();const runId=(await f.bound(0))[0]!.run_id!;await f.worker();
 const c=await f.chain();const requested=await f.post(`/task-chains/${f.chainId}/controls`,{expected_revision:c.revision,action:'PAUSE',reason:'用户暂停这一段'});assert.equal(requested.status,'PAUSING');
 assert.equal((await applySafeControl(app.db,runId))?.status,'APPLIED');const paused=await f.wait(v=>v.status==='PAUSED');assert.equal(paused.calls_started,1);
 await f.authorize();await f.wait(v=>((v.items as Record<string,unknown>[])[0]?.current_run_status)!=='PAUSED');await f.worker();await f.approve(runId);await f.worker();
 const second=(await f.bound(1))[1]!;await f.worker();await f.approve(second.run_id!);await f.worker();const done=await f.wait(v=>v.status==='COMPLETED');assert.equal(done.calls_started,2);assert.equal((done.authorization_history as unknown[]).length,2);
});
test('真实 API 重开不自动启动剩余任务，用户再次确认后保留原身份继续',async()=>{
 const f=await fixture();await f.authorize();const runId=(await f.bound(0))[0]!.run_id!;await f.worker();
 const previous=api;retainedApis.push(previous);await stopApi(previous.running);api=await startTestApi({dataRoot:previous.dataRoot});const reopened=await f.wait(v=>v.status==='WAITING_RESUME');assert.equal((reopened.items as Item[])[0]?.run_id,runId);
 await f.approve(runId);await f.worker();await delay(800);assert.equal(((await f.chain()).items as Item[])[1]?.run_id,null);
 await f.authorize();const second=(await f.bound(1))[1]!;await f.worker();await f.approve(second.run_id!);await f.worker();await f.wait(v=>v.status==='COMPLETED');
});
test('短有效期到达阻止新委托，撤销不复活原授权或重置预算',async()=>{
 const f=await fixture();const c=await f.chain();await f.post(`/task-chains/${f.chainId}/authorizations`,{expected_revision:c.revision,confirmed:true,max_tasks:2,max_model_calls:3,expires_at:new Date(Date.now()+100).toISOString()});
 const expired=await f.wait(v=>v.status==='EXPIRED');assert.equal(expired.calls_started,0);assert.ok((expired.items as Item[]).every(i=>i.run_id===null));
 const revoked=await f.post(`/task-chains/${f.chainId}/controls`,{expected_revision:expired.revision,action:'REVOKE',reason:'用户不再执行此链'});assert.equal(revoked.status,'REVOKED');
 const retry=await api.post(f.path(`/task-chains/${f.chainId}/authorizations`),{command_id:randomUUID(),expected_revision:revoked.revision,confirmed:true,max_tasks:2,max_model_calls:3,expires_at:new Date(Date.now()+600000).toISOString()});assert.equal(retry.status,409,retry.text);
});
test('创建后任务依据改变不被旧授权静默覆盖，也不会创建 Run',async()=>{
 const f=await fixture();await f.post(`/tasks/${f.ids[0]}/planning-metadata`,{expected_revision:'0',priority:'HIGH',due_local_date:null,timezone:null});await f.authorize();
 const blocked=await f.wait(v=>v.status==='BLOCKED');assert.ok((blocked.items as Item[]).every(i=>i.run_id===null));
 assert.equal((await createRepositories(app.db).tasks.readTask(f.ids[0]!))?.priority,'HIGH');
});
