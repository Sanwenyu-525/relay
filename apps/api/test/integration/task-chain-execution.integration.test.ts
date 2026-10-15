import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import test,{before,after} from 'node:test';
import {createRepositories} from '../../src/application/unit-of-work.js';
import {createGatewayConnectionCommand,disableGatewayConnectionCommand} from '../../src/application/gateway-commands.js';
import {createGatewayPolicy,registerManagedResource} from '../../src/application/gateway-configuration.js';
import {createKnowledge,addKnowledgeVersion} from '../../src/application/information-commands.js';
import {runAssistGenerationTick} from '../../src/application/assist-runner.js';
import {FakeModelPort,type FakeToolScript} from '../../src/workflow/fake-model-port.js';
import {ManagedContentStore} from '../../src/storage/managed-content-store.js';
import {runOneCommand} from '../../src/worker/run-command.js';
import {runMigrations} from '../../src/infrastructure/migration-runner.js';
import {APP_DATABASE_URL,MIGRATION_DATABASE_URL,MIGRATIONS_DIRECTORY,openDatabase} from './integration-support.js';
import {createWorkspace,expectCommandAccepted,startTestApi,workspacePath,delay,type TestApi} from './api-harness.js';
const app=openDatabase(APP_DATABASE_URL,'relay-chain-read-test');let api:TestApi;
before(async()=>{await runMigrations({connectionString:MIGRATION_DATABASE_URL,directory:MIGRATIONS_DIRECTORY});api=await startTestApi();});
after(async()=>{await api?.stop();await app.close();});
async function fixture(decision:'AUTO'|'DENY'='AUTO',editing=false){
 const workspaceId=await createWorkspace(app.db);const path=(s:string)=>workspacePath(workspaceId,s);
 const post=async(s:string,body:Record<string,unknown>,status:200|201|202=200)=>{const id=typeof body.command_id==='string'?body.command_id:randomUUID();return expectCommandAccepted(await api.post(path(s),{command_id:id,...body}),status,id);};
 const read=async(s:string)=>{const r=await api.get(path(s));assert.equal(r.status,200,r.text);return r.body as Record<string,unknown>;};
 const projectId=(await post('/projects',{title:'任务链实际读取',project_type:'GENERAL'},201)).project_id as string;
 const root=join(api.dataRoot,`chain-read-${randomUUID()}`);await mkdir(root);const content=`实际资料 ${randomUUID()}\r\n`;await writeFile(join(root,'notes.md'),content);
 const resource=await registerManagedResource(app.db,{workspaceId,projectId,rootPath:root});
 const connection=await createGatewayConnectionCommand(app.db,{workspaceId,projectId,commandId:randomUUID(),capabilities:editing?['FILE_QUERY','FILE_READ','FILE_WRITE','CLI_RUN']:['FILE_QUERY','FILE_READ'],rootPath:root,...(editing?{allowedExecutables:[process.execPath]}:{})});const connectionId=connection.result.connection_id!;
 await createGatewayPolicy(app.db,{workspaceId,projectId,capability:'FILE_READ',actionType:'READ_FILE',targetPrefix:resource.canonicalRoot,decision,maxPayloadBytes:4096});
 await createGatewayPolicy(app.db,{workspaceId,projectId,capability:'FILE_QUERY',actionType:'LIST_DIRECTORY',targetPrefix:resource.canonicalRoot,decision,maxPayloadBytes:4096});
 if(editing)for(const [capability,actionType] of [['FILE_WRITE','APPLY_CHANGESET'],['CLI_RUN','CLI_RUN']] as const)await createGatewayPolicy(app.db,{workspaceId,projectId,capability,actionType,targetPrefix:resource.canonicalRoot,decision,maxPayloadBytes:65536});
 const knowledge=await createKnowledge(app.db,{workspaceId,projectId,commandId:randomUUID(),title:'已确认要求',source:{sourceKind:'NOTE',text:'固定确切来源版本，不应自动换成新资料。'}});
 const tasks=[];for(const title of ['核对来源','继续核对'])tasks.push(await post('/tasks',{project_id:projectId,title,objective:'读取已登记资料并交付核对报告',criteria:[{criterion_id:'human',statement:'人工核对原资料和实际读取',method:'HUMAN'}]},201));
 const selected=tasks.map(t=>({task_id:t.task_id,expected_revision:t.revision,expected_acceptance_revision:t.acceptance_revision}));
 const loop={resource_id:resource.resourceId,connections:{FILE_QUERY:connectionId,FILE_READ:connectionId},allowed_tools:['list_directory','read_file'],max_rounds:6,max_tool_calls:6};
 const fixed={connection_id:connectionId,resource_id:resource.resourceId,relative_target:'notes.md'};
 const sources=[{kind:'KNOWLEDGE',root_id:knowledge.result.knowledge_id!,version:'1'}];
 const create=async(executions:Record<string,unknown>[])=>post(`/projects/${projectId}/task-chains`,{title:'读取两项',confirmed:true,tasks:selected.map((t,i)=>({...t,execution:executions[i]}))},201);
 const chain=(id:string)=>read(`/task-chains/${id}`);
 const wait=async(id:string,predicate:(r:Record<string,unknown>)=>boolean)=>{const until=Date.now()+10000;while(Date.now()<until){const c=await chain(id);if(predicate(c))return c;await delay(80);}throw new Error(`未达预期 ${JSON.stringify(await chain(id))}`);};
 const authorize=async(id:string)=>post(`/task-chains/${id}/authorizations`,{expected_revision:(await chain(id)).revision,confirmed:true,max_tasks:2,max_model_calls:editing?16:8,expires_at:new Date(Date.now()+600000).toISOString()});
 const worker=(script?:FakeToolScript)=>runOneCommand(app.db,{workerId:`chain-read:${randomUUID()}`,dataRoot:api.dataRoot,checkpointUrl:APP_DATABASE_URL,...(script===undefined?{}:{fakeToolScript:script})});
 const approve=async(runId:string)=>{const reviews=(await read('/reviews?status=OPEN')).items as Record<string,unknown>[];const review=reviews.find(v=>v.run_id===runId);assert.ok(review);await post(`/reviews/${review.id}/decisions`,{expected_revision:review.revision,target_hash:review.target_hash,decision:'ACCEPT'});};
 return {workspaceId,projectId,path,post,read,root,content,resource,connectionId,knowledge,selected,loop,fixed,sources,create,chain,wait,authorize,worker,approve};
}
type Item={run_id:string|null;execution_spec:Record<string,unknown>;completion_id:string|null};
test('链中只读循环与固定读取实际读文件，确切资料和原会话只读方法进入原 Run',async()=>{
 const f=await fixture();const session=await f.post('/assist-sessions',{project_id:f.projectId,title:'原方法依据'},201);
 const sent=await f.post(`/assist-sessions/${session.session_id}/messages`,{content:'/review 核对 notes.md，仅检查'},202);
 assert.equal((await runAssistGenerationTick(app.db,{workerId:`method:${randomUUID()}`,leaseMs:10000,storage:new ManagedContentStore(api.dataRoot),modelPort:new FakeModelPort()}))?.status,'COMPLETED');
 const created=await f.create([{context_sources:f.sources,tool_loop_action:f.loop,method_message_id:sent.user_message_id},{context_sources:f.sources,file_read_action:f.fixed}]);const id=created.chain_id as string;
 assert.equal((await f.chain(id)).status,'DRAFT');await f.authorize(id);const first=((await f.wait(id,c=>(c.items as Item[])[0]?.run_id!==null)).items as Item[])[0]!;
 await f.worker([[{name:'list_directory',arguments:{}}],[{name:'read_file',arguments:{relative_path:'notes.md'}}]]);
 const r=createRepositories(app.db);const calls=await r.toolCalls.listByRun(first.run_id!);assert.deepEqual(calls.map(c=>c.tool_name),['list_directory','read_file']);assert.equal(calls[1]?.result_ref?.content,f.content);
 const contract=(await r.runs.readContract(first.run_id!))!;assert.equal((contract.frozen_snapshot.context_sources as Record<string,unknown>[])[0]?.root_id,f.knowledge.result.knowledge_id);
 const method=contract.frozen_snapshot.execution_method as {source_message_id:string;method_snapshot:{id:string}};assert.equal(method.source_message_id,sent.user_message_id);assert.equal(method.method_snapshot.id,'code-review');
 await f.approve(first.run_id!);await f.worker();const second=((await f.wait(id,c=>(c.items as Item[])[1]?.run_id!==null)).items as Item[])[1]!;
 await f.worker();const operations=await r.gateway.listRunOperations(second.run_id!);assert.equal(operations[0]?.status,'SUCCEEDED');
 await f.approve(second.run_id!);await f.worker();const done=await f.wait(id,c=>c.status==='COMPLETED');assert.ok((done.items as Item[]).every(i=>i.completion_id!==null));assert.equal(await readFile(join(f.root,'notes.md'),'utf8'),f.content);
});
test('已有 DENY 权限不被链授权放宽，失败读取不启动后项或改文件',async()=>{
 const f=await fixture('DENY');const created=await f.create([{tool_loop_action:f.loop},{file_read_action:f.fixed}]);const id=created.chain_id as string;await f.authorize(id);
 const first=((await f.wait(id,c=>(c.items as Item[])[0]?.run_id!==null)).items as Item[])[0]!;
 await f.worker([[{name:'read_file',arguments:{relative_path:'notes.md'}}]]);
 const r=createRepositories(app.db);const operations=await r.gateway.listRunOperations(first.run_id!);assert.equal(operations.length,0,'权限拒绝发生在准备前，不应出现已派操作');
 const tools=await r.toolCalls.listByRun(first.run_id!);assert.ok(tools.some(t=>t.status==='REJECTED'&&t.result_ref?.reason==='GATEWAY_PERMISSION_DENIED'));
 assert.equal(((await f.chain(id)).items as Item[])[1]?.run_id,null);assert.equal(await readFile(join(f.root,'notes.md'),'utf8'),f.content);
});
test('原资料版本和连接变化时旧规格保留，重新授权也不静默切来源',async()=>{
 const f=await fixture();const created=await f.create([{context_sources:f.sources,file_read_action:f.fixed},{context_sources:f.sources,file_read_action:f.fixed}]);const id=created.chain_id as string;const before=await f.chain(id);
 await addKnowledgeVersion(app.db,{workspaceId:f.workspaceId,knowledgeId:f.knowledge.result.knowledge_id!,commandId:randomUUID(),expectedRevision:f.knowledge.result.revision,source:{sourceKind:'NOTE',text:'新版本待重新确认'}});
 await f.authorize(id);const changed=await f.wait(id,c=>c.status==='BLOCKED');assert.ok((changed.items as Item[]).every(i=>i.run_id===null));assert.deepEqual((changed.items as Item[])[0]?.execution_spec,(before.items as Item[])[0]?.execution_spec);
 const g=await fixture();const another=await g.create([{file_read_action:g.fixed},{file_read_action:g.fixed}]);const other=another.chain_id as string;
 const connection=(await createRepositories(app.db).gateway.readConnection(g.connectionId))!;
 await disableGatewayConnectionCommand(app.db,{workspaceId:g.workspaceId,projectId:g.projectId,connectionId:g.connectionId,commandId:randomUUID(),expectedVersion:connection.version.toString()});
 await g.authorize(other);const blocked=await g.wait(other,c=>c.status==='BLOCKED');assert.ok((blocked.items as Item[]).every(i=>i.run_id===null));
});
test('链不能登记任意工具或命令，其他项目资源不生成候选',async()=>{
 const f=await fixture();const bad=await api.post(f.path(`/projects/${f.projectId}/task-chains`),{command_id:randomUUID(),title:'不能扩大',confirmed:true,tasks:f.selected.map(t=>({...t,execution:{tool_loop_action:{...f.loop,allowed_tools:['shell_exec']}}}))});assert.equal(bad.status,422,bad.text);
 const g=await fixture();const wrong=await api.post(f.path(`/projects/${f.projectId}/task-chains`),{command_id:randomUUID(),title:'不可跨范围',confirmed:true,tasks:f.selected.map(t=>({...t,execution:{file_read_action:g.fixed}}))});assert.equal(wrong.status,404,wrong.text);
 assert.equal(((await f.read(`/projects/${f.projectId}/task-chains`)).items as unknown[]).length,0);
});

async function editFixture(decision:'AUTO'|'DENY'='AUTO') {
 const f=await fixture(decision,true);const marker=`已修改 ${randomUUID()}\n`;const checker=join(f.root,'check.mjs');
 await writeFile(checker,`import {readFileSync} from 'node:fs';\nconst ok=readFileSync('notes.md','utf8')===${JSON.stringify(marker)};\nconsole.log(ok?'chain-check-ok':'chain-check-failed');process.exitCode=ok?0:1;\n`);
 const check={id:'notes-check',executable:process.execPath,args:[checker],executable_sha256:createHash('sha256').update(await readFile(process.execPath)).digest('hex'),max_output_bytes:4096};
 const loop={...f.loop,connections:{...f.loop.connections,FILE_WRITE:f.connectionId,CLI_RUN:f.connectionId},allowed_tools:['read_file','apply_changeset','run_check']};
 const grant={resource_id:f.resource.resourceId,allowed_actions:['APPLY_CHANGESET','CLI_RUN'],checks:[check]};
 const edit={name:'apply_changeset',arguments:{changes:[{action:'MODIFY',path:'notes.md',baselineSha256:createHash('sha256').update(f.content).digest('hex'),content:marker}]}};
 return {...f,marker,checker,check,edit,editLoop:loop,grant};
}

test('明确修改方法沿原范围授权实际改文件，检查失败后修正并重查，人工完成才接后项',async()=>{
 const f=await editFixture();const session=await f.post('/assist-sessions',{project_id:f.projectId,title:'原修改方法'},201);
 const sent=await f.post(`/assist-sessions/${session.session_id}/messages`,{content:'/docs 更新文档 notes.md，并运行已配置检查'},202);
 assert.equal((await runAssistGenerationTick(app.db,{workerId:`edit-method:${randomUUID()}`,leaseMs:10000,storage:new ManagedContentStore(api.dataRoot),modelPort:new FakeModelPort()}))?.status,'COMPLETED');
 const created=await f.create([{tool_loop_action:f.editLoop,scope_grant:f.grant,method_message_id:sent.user_message_id},{tool_loop_action:{...f.editLoop,allowed_tools:['run_check']},scope_grant:{...f.grant,allowed_actions:['CLI_RUN']}}]);const id=created.chain_id as string;
 assert.equal((await f.chain(id)).status,'DRAFT');assert.ok(((await f.chain(id)).items as Item[]).every(i=>i.run_id===null));
 await f.authorize(id);const first=((await f.wait(id,c=>(c.items as Item[])[0]?.run_id!==null)).items as Item[])[0]!;
 const r=createRepositories(app.db);const grant=(await r.scopeGrants.readByRun(first.run_id!))!;assert.deepEqual(grant.allowed_actions,['APPLY_CHANGESET','CLI_RUN']);assert.equal(grant.survives_run_terminal,false);assert.ok(grant.expires_at!==null&&grant.expires_at.getTime()<=Date.parse((await f.chain(id)).expires_at as string));
 const method=(await r.runs.readContract(first.run_id!))!.frozen_snapshot.execution_method as {action:string;source_message_id:string};assert.equal(method.action,'MODIFY');assert.equal(method.source_message_id,sent.user_message_id);
 await f.worker([[{name:'run_check',arguments:{check_id:'notes-check'}}],[{name:'read_file',arguments:{relative_path:'notes.md'}}],[f.edit],[{name:'run_check',arguments:{check_id:'notes-check'}}]]);
 const calls=await r.toolCalls.listByRun(first.run_id!);assert.deepEqual(calls.map(c=>c.tool_name),['run_check','read_file','apply_changeset','run_check']);assert.equal(calls[0]?.result_ref?.exitCode,1);assert.equal(calls[3]?.result_ref?.exitCode,0);assert.match(String(calls[3]?.result_ref?.stdout),/chain-check-ok/);assert.equal(await readFile(join(f.root,'notes.md'),'utf8'),f.marker);
 const write=calls[2]!;const sets=await r.changeSets.listByOperation(write.operation_id!);const files=await r.changeSets.listFiles(sets[0]!.id);assert.equal(files[0]?.status,'APPLIED');assert.equal(files[0]?.actual_sha256,createHash('sha256').update(f.marker).digest('hex'));
 assert.equal(((await f.chain(id)).items as Item[])[1]?.run_id,null);await f.approve(first.run_id!);await f.worker();
 const second=((await f.wait(id,c=>(c.items as Item[])[1]?.run_id!==null)).items as Item[])[1]!;assert.notEqual(second.run_id,first.run_id);assert.deepEqual((await r.scopeGrants.readByRun(second.run_id!))?.allowed_actions,['CLI_RUN']);
 await f.worker([[{name:'run_check',arguments:{check_id:'notes-check'}}]]);await f.approve(second.run_id!);await f.worker();assert.equal((await f.wait(id,c=>c.status==='COMPLETED')).status,'COMPLETED');
});

test('链的工具范围不替代写入批准，未给范围授权时原 ACTION_APPROVAL 确认后才落盘',async()=>{
 const f=await editFixture();const created=await f.create([{tool_loop_action:{...f.editLoop,allowed_tools:['apply_changeset']}},{file_read_action:f.fixed}]);const id=created.chain_id as string;await f.authorize(id);
 const first=((await f.wait(id,c=>(c.items as Item[])[0]?.run_id!==null)).items as Item[])[0]!;const script:FakeToolScript=[[f.edit]];await f.worker(script);
 const r=createRepositories(app.db);assert.equal(await r.scopeGrants.readByRun(first.run_id!),undefined);assert.equal((await r.toolCalls.listByRun(first.run_id!))[0]?.status,'WAITING_APPROVAL');assert.equal(await readFile(join(f.root,'notes.md'),'utf8'),f.content);assert.equal(((await f.chain(id)).items as Item[])[1]?.run_id,null);
 const review=((await f.read('/reviews?status=OPEN')).items as Record<string,unknown>[]).find(v=>v.run_id===first.run_id&&v.kind==='ACTION_APPROVAL');assert.ok(review);
 await f.post(`/reviews/${review.id}/decisions`,{expected_revision:review.revision,target_hash:review.target_hash,decision:'APPROVE'});await f.worker(script);assert.equal(await readFile(join(f.root,'notes.md'),'utf8'),f.marker);assert.equal(((await f.chain(id)).items as Item[])[1]?.run_id,null);
});

test('已有 DENY 不被明确修改范围授权覆盖，不改文件、不接后项',async()=>{
 const f=await editFixture('DENY');const created=await f.create([{tool_loop_action:{...f.editLoop,allowed_tools:['apply_changeset']},scope_grant:{...f.grant,allowed_actions:['APPLY_CHANGESET'],checks:[]}},{file_read_action:f.fixed}]);const id=created.chain_id as string;await f.authorize(id);
 const first=((await f.wait(id,c=>(c.items as Item[])[0]?.run_id!==null)).items as Item[])[0]!;await f.worker([[f.edit]]);
 const r=createRepositories(app.db);assert.ok((await r.toolCalls.listByRun(first.run_id!)).some(c=>c.status==='REJECTED'&&c.result_ref?.reason==='GATEWAY_PERMISSION_DENIED'));assert.equal((await r.gateway.listRunOperations(first.run_id!)).length,0);assert.equal(await readFile(join(f.root,'notes.md'),'utf8'),f.content);assert.equal(((await f.chain(id)).items as Item[])[1]?.run_id,null);
});

test('检查脚本变化阻止旧规格准入，未配置检查 ID 不能发起命令',async()=>{
 const f=await editFixture();const execution={tool_loop_action:{...f.editLoop,allowed_tools:['run_check']},scope_grant:{...f.grant,allowed_actions:['CLI_RUN']}};
 const created=await f.create([execution,execution]);const id=created.chain_id as string;const before=await f.chain(id);await writeFile(f.checker,'console.log("changed");\n');await f.authorize(id);
 const blocked=await f.wait(id,c=>c.status==='BLOCKED');assert.ok((blocked.items as Item[]).every(i=>i.run_id===null));assert.deepEqual((blocked.items as Item[])[0]?.execution_spec,(before.items as Item[])[0]?.execution_spec);
 const g=await editFixture();const next=await g.create([{tool_loop_action:{...g.editLoop,allowed_tools:['run_check']},scope_grant:{...g.grant,allowed_actions:['CLI_RUN']}},{file_read_action:g.fixed}]);const other=next.chain_id as string;await g.authorize(other);
 const first=((await g.wait(other,c=>(c.items as Item[])[0]?.run_id!==null)).items as Item[])[0]!;await g.worker([[{name:'run_check',arguments:{check_id:'unconfigured'}}]]);const r=createRepositories(app.db);assert.ok((await r.toolCalls.listByRun(first.run_id!)).some(c=>c.result_ref?.reason==='TOOL_CHECK_NOT_CONFIGURED'));assert.equal((await r.gateway.listRunOperations(first.run_id!)).length,0);assert.equal(((await g.chain(other)).items as Item[])[1]?.run_id,null);
});

test('原 INSPECT 方法不能被链规格改成文件写入，缺检查配置也不保存候选',async()=>{
 const f=await editFixture();const session=await f.post('/assist-sessions',{project_id:f.projectId,title:'保持只读'},201);
 const sent=await f.post(`/assist-sessions/${session.session_id}/messages`,{content:'/review 核对 notes.md，仅检查'},202);
 await runAssistGenerationTick(app.db,{workerId:`inspect:${randomUUID()}`,leaseMs:10000,storage:new ManagedContentStore(api.dataRoot),modelPort:new FakeModelPort()});
 const refused=await api.post(f.path(`/projects/${f.projectId}/task-chains`),{command_id:randomUUID(),title:'不能扩方法',confirmed:true,tasks:f.selected.map(t=>({...t,execution:{tool_loop_action:f.editLoop,scope_grant:f.grant,method_message_id:sent.user_message_id}}))});assert.equal(refused.status,409,refused.text);
 const missing=await api.post(f.path(`/projects/${f.projectId}/task-chains`),{command_id:randomUUID(),title:'缺检查配置',confirmed:true,tasks:f.selected.map(t=>({...t,execution:{tool_loop_action:{...f.editLoop,allowed_tools:['run_check']}}}))});assert.equal(missing.status,409,missing.text);
 assert.equal(((await f.read(`/projects/${f.projectId}/task-chains`)).items as unknown[]).length,0);
});
