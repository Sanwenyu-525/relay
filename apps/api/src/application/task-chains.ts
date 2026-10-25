import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { TaskChainRow } from '../planning/task-chain-repository.js';
import { LOCAL_ACTOR_REF,httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { DomainError,invalidTransition,resourceNotFound,revisionConflict,validationFailed } from './domain-error.js';
import { lockWritableProjectInWorkspace,readProjectInWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { withTransaction,createRepositories,type Repositories } from './unit-of-work.js';
import { readAdmission } from './maintenance-admission.js';
import { reminderInstant } from './project-reminders.js';
import { requireDeclaredOutputs } from './declared-output-requirements.js';
import { delegateTask } from './delegate-task.js';
import { markTaskReady } from './task-commands.js';
import { enqueueControlLocked,resumeRun } from './control-requests.js';
import { lockTaskAndRun } from './lock-task-run.js';
import { freezeTaskChainExecution,executionSignature,taskChainDelegateExecution,type TaskChainExecutionInput } from './task-chain-execution.js';
type Scope={workspaceId:string;commandId:string};
const result=(c:TaskChainRow)=>({chain_id:c.id,project_id:c.project_id,status:c.status,revision:c.revision.toString()});
async function authority(r:Repositories,workspaceId:string) {if(await r.workspaces.lockAuthority(workspaceId,'share')===undefined) throw resourceNotFound('Workspace');}
async function audit(r:Repositories,input:Scope,c:TaskChainRow,event:string) {await r.activities.insertActivityRecord({id:randomUUID(),workspaceId:input.workspaceId,projectId:c.project_id,taskId:null,actorKind:'HUMAN',actorRef:LOCAL_ACTOR_REF,commandId:input.commandId,eventType:event,factRefs:result(c)});}
async function locked(r:Repositories,input:{workspaceId:string;chainId:string;expectedRevision:string}) {
 await authority(r,input.workspaceId);const c=await r.taskChains.read(input.chainId,true);
 if(c?.workspace_id!==input.workspaceId) throw resourceNotFound('TaskChain');
 await lockWritableProjectInWorkspace(r,input.workspaceId,c.project_id);
 if(c.revision!==requireRevision(input.expectedRevision,'expected_revision')) throw revisionConflict({entityType:'TASK_CHAIN',expectedRevision:input.expectedRevision,actualRevision:c.revision.toString()});return c;
}
export async function createTaskChain(db:DbExecutor,input:Scope & {projectId:string;title:string;confirmed:true;tasks:readonly {taskId:string;expectedRevision:string;expectedAcceptanceRevision:string;execution?:TaskChainExecutionInput}[]}) {
 if(input.confirmed!==true || !input.title.trim() || input.title.length>200 || input.tasks.length<1 || input.tasks.length>16 || new Set(input.tasks.map(t=>t.taskId)).size!==input.tasks.length) throw validationFailed([{field:'tasks',message:'需要确认标题和 1–16 个不同的既有任务。'}]);
 return runIdempotentCommand(db,{scopeKey:httpCommandScopeKey(input.workspaceId),commandId:input.commandId,commandType:'CreateTaskChain',target:{project_id:input.projectId},body:{title:input.title.trim(),confirmed:input.confirmed,tasks:input.tasks.map(t=>({task_id:t.taskId,expected_revision:t.expectedRevision,expected_acceptance_revision:t.expectedAcceptanceRevision,...(t.execution===undefined?{}:{execution:JSON.parse(JSON.stringify(t.execution)) as JsonObject})}))},execute:async r=>{
  await authority(r,input.workspaceId);await lockWritableProjectInWorkspace(r,input.workspaceId,input.projectId);
  const auth=(await r.workspaces.lockAuthority(input.workspaceId,'share'))!;
  const goals=(await r.projects.listProjectGoalLinks(input.projectId)).map(g=>({id:g.goal_id,revision:g.goal_revision.toString(),status:g.goal_status}));
  const captured=[];
  for(const [index,selected] of input.tasks.entries()) {
   const t=await r.tasks.readTaskForShare(selected.taskId);
   if(t?.workspace_id!==input.workspaceId || t.project_id!==input.projectId) throw resourceNotFound('Task');
   if(t.revision!==requireRevision(selected.expectedRevision,'expected_revision') || t.acceptance_revision!==requireRevision(selected.expectedAcceptanceRevision,'expected_acceptance_revision')) throw invalidTransition('任务或验收版本已变化。');
   if(!['INBOX','READY'].includes(t.status) || t.executor_kind!=='HUMAN') throw invalidTransition('首片任务链仅接待执行的人工所属任务。');
    const acceptance=await r.tasks.readAcceptanceVersion(t.id,t.acceptance_revision);
    if(acceptance===undefined) throw invalidTransition('当前验收版本不可读取。');
    const criteria=await r.tasks.listCriteria(t.id,t.acceptance_revision);
    if(!criteria.some(criterion=>criterion.required)) throw invalidTransition('任务至少需要一个必需验收条件才能进入固定任务链。');
    const declaredOutputs=requireDeclaredOutputs({task:t,acceptanceRevision:t.acceptance_revision,requiredOutputSpec:acceptance.required_output_spec});
    if(declaredOutputs.length===0) throw invalidTransition('任务需要声明至少一种当前支持的预期产物才能进入固定任务链。');
    const unresolvedBlockers=await r.projects.listUnresolvedBlockersForTask(input.projectId,t.id);
    if(unresolvedBlockers.length>0) throw invalidTransition('任务或项目仍有未解除 blocker，不能进入固定任务链。',{blockerIds:unresolvedBlockers.map(blocker=>blocker.id)});
   const deps=(await r.tasks.listDependencies(t.id)).filter(d=>d.dependency_kind==='BLOCKS');
   if(deps.some(d=>d.depends_on_status!=='DONE' && !input.tasks.slice(0,index).some(p=>p.taskId===d.depends_on_task_id))) throw invalidTransition('固定顺序需把未完成的必要前置排在当前任务之前。');
   const execution=await freezeTaskChainExecution(r,input.workspaceId,input.projectId,t.id,selected.execution);
   captured.push({task:t,execution,baseline:{title:t.title,status:t.status,revision:t.revision.toString(),acceptance_revision:t.acceptance_revision.toString(),dependencies:deps.map(d=>d.depends_on_task_id)}});
  }
  const c=await r.taskChains.insert(randomUUID(),input.workspaceId,input.projectId,input.title.trim(),{rule_revision:auth.rule_revision.toString(),goals,tool_scope:captured.some(p=>((p.execution.tool_loop_action?.allowed_tools??[]) as string[]).some(t=>['apply_changeset','run_check'].includes(t)))?'BOUNDED_FILES_AND_CHECKS':captured.some(p=>p.execution.file_read_action!==undefined||p.execution.tool_loop_action!==undefined)?'BOUNDED_READ_ONLY_FILES':'INTERNAL_MARKDOWN_ARTIFACTS_ONLY'});
  for(const [ordinal,p] of captured.entries()) await r.taskChains.insertItem({id:randomUUID(),chain_id:c.id,ordinal,task_id:p.task.id,task_revision:p.task.revision,acceptance_revision:p.task.acceptance_revision,baseline:p.baseline,ready_command_id:randomUUID(),delegate_command_id:randomUUID(),execution_spec:p.execution});
  await audit(r,input,c,'TASK_CHAIN_CREATED');return result(c);
 }});
}
export async function authorizeTaskChain(db:DbExecutor,input:Scope & {chainId:string;expectedRevision:string;runtimeId:string;confirmed:true;maxTasks:number;maxModelCalls:number;expiresAt:string}) {
 const expires=reminderInstant(input.expiresAt,'UTC');
 if(input.confirmed!==true || !Number.isInteger(input.maxTasks) || input.maxTasks<1 || input.maxTasks>16 || !Number.isInteger(input.maxModelCalls) || input.maxModelCalls<1 || input.maxModelCalls>100) throw validationFailed([{field:'budget',message:'需要明确确认任务数 1–16、调用数 1–100 和有效期。'}]);
 return runIdempotentCommand(db,{scopeKey:httpCommandScopeKey(input.workspaceId),commandId:input.commandId,commandType:'AuthorizeTaskChain',target:{chain_id:input.chainId},body:{expected_revision:input.expectedRevision,confirmed:input.confirmed,max_tasks:input.maxTasks,max_model_calls:input.maxModelCalls,expires_at:expires.toISOString()},execute:async r=>{
  const c=await locked(r,input);
  if(['ACTIVE','PAUSING','REVOKED','COMPLETED'].includes(c.status)) throw invalidTransition('请先核对原活动/停止状态，不能重复或复活撤销的授权。');
  const now=await r.taskChains.now();if(expires<=now || expires.getTime()-now.getTime()>86400000 || input.maxTasks<c.task_reservations || input.maxModelCalls<=c.calls_started || Number((await r.taskChains.usage(c.id)).uncertain)>0) throw invalidTransition('有效期需在未来 24 小时内，累计预算与未知用量不能重置。');
  const current=(await r.taskChains.items(c.id)).find(i=>i.status!=='COMPLETED');
  const run=current?.run_id==null?undefined:await r.runs.readRun(current.run_id);
  if(run!==undefined && ['FAILED','CANCELLED'].includes(run.status)) throw invalidTransition('原执行失败或取消，不能换 Run 自动重试。');
  const resumeId=run?.status==='PAUSED'?randomUUID():null;
  const updated=await r.taskChains.authorize(c.id,input.runtimeId,input.maxTasks,input.maxModelCalls,expires,{command_id:input.commandId,max_tasks:input.maxTasks,max_model_calls:input.maxModelCalls,expires_at:expires.toISOString(),task_reservations:c.task_reservations,calls_started:c.calls_started},resumeId);
  await audit(r,input,updated,'TASK_CHAIN_AUTHORIZED');return result(updated);
 }});
}
async function stopLocked(r:Repositories,c:TaskChainRow,target:string,reason:string,commandId?:string) {
 const item=(await r.taskChains.items(c.id)).find(i=>i.status!=='COMPLETED');
 if(item?.run_id==null) return r.taskChains.state(c.id,target,reason);
 const {task,run}=await lockTaskAndRun(r,item.run_id,c.workspace_id);
 if(['COMPLETED','FAILED','CANCELLED','PAUSED'].includes(run.status) || task.executor_run_id!==run.id) return r.taskChains.state(c.id,target,reason);
 const pending=await r.recovery.lockPendingControl(run.id);
 const control=pending??await enqueueControlLocked(r,{task,run,type:'PAUSE',...(commandId===undefined?{}:{commandId})});
 if(pending===undefined) await r.runs.touchRun(run.id,run.revision);
 return r.taskChains.state(c.id,'PAUSING',reason,target,control.id);
}
export async function stopTaskChain(db:DbExecutor,input:Scope & {chainId:string;expectedRevision:string;action:'PAUSE'|'REVOKE';reason:string}) {
 if(!input.reason.trim() || input.reason.length>4000) throw validationFailed([{field:'reason',message:'需要停止理由。'}]);
 return runIdempotentCommand(db,{scopeKey:httpCommandScopeKey(input.workspaceId),commandId:input.commandId,commandType:'StopTaskChain',target:{chain_id:input.chainId},body:{expected_revision:input.expectedRevision,action:input.action,reason:input.reason.trim()},execute:async r=>{
  const c=await locked(r,input);if(['PAUSING','REVOKED','COMPLETED'].includes(c.status)) throw invalidTransition('此链已经停止中或终止。');
  const updated=await stopLocked(r,c,input.action==='REVOKE'?'REVOKED':'PAUSED',input.reason.trim(),input.commandId);await audit(r,input,updated,'TASK_CHAIN_STOP_REQUESTED');return result(updated);
 }});
}
async function view(r:Repositories,c:TaskChainRow) {
 const items=[];for(const i of await r.taskChains.items(c.id)) {
  const task=await r.tasks.readTask(i.task_id);const run=i.run_id===null?undefined:await r.runs.readRun(i.run_id);
  items.push({item_id:i.id,ordinal:i.ordinal,task_id:i.task_id,status:i.status,baseline:i.baseline,execution_spec:i.execution_spec,task_revision:i.task_revision.toString(),acceptance_revision:i.acceptance_revision.toString(),run_id:i.run_id,completion_id:i.completion_id,current_task_status:task?.status??null,current_run_status:run?.status??null});
 }
 const usage=await r.taskChains.usage(c.id);
 return {...result(c),title:c.title,baseline:c.baseline,max_tasks:c.max_tasks,max_model_calls:c.max_model_calls,task_reservations:c.task_reservations,calls_started:c.calls_started,expires_at:c.expires_at?.toISOString()??null,reason:c.reason,control_request_id:c.control_request_id,authorization_history:c.authorization_history,items,
  model_usage:{recorded_calls:Number(usage.count),uncertain_calls:Number(usage.uncertain),known_input_tokens:Number(usage.input_known_count)===0?null:usage.known_input,known_output_tokens:Number(usage.output_known_count)===0?null:usage.known_output,total_tokens:Number(usage.count)>0&&Number(usage.uncertain)===0?(BigInt(usage.known_input)+BigInt(usage.known_output)).toString():null,monetary_cost:null}};
}
export async function readTaskChain(db:DbExecutor,workspaceId:string,id:string) {return withTransaction(db,async r=>{const c=await r.taskChains.read(id);if(c?.workspace_id!==workspaceId) throw resourceNotFound('TaskChain');return view(r,c);});}
export async function listTaskChains(db:DbExecutor,workspaceId:string,projectId:string) {return withTransaction(db,async r=>{await readProjectInWorkspace(r,workspaceId,projectId);const items=[];for(const c of await r.taskChains.list(workspaceId,projectId))items.push(await view(r,c));return {project_id:projectId,items};});}
export async function tickTaskChains(db:DbExecutor,runtimeId:string) {
 for(const located of await createRepositories(db).taskChains.active()) {
  const action=await withTransaction(db,async r=>{
   if((await readAdmission(r,'share')).mode!=='NORMAL') return;
   await authority(r,located.workspace_id);const c=(await r.taskChains.read(located.id,true))!;
   if(!['ACTIVE','PAUSING'].includes(c.status))return;
   const project=await r.projects.readProject(c.project_id);if(project?.archived_at!==null){await r.taskChains.state(c.id,'BLOCKED','PROJECT_ARCHIVED_OR_UNAVAILABLE');return;}
   const items=await r.taskChains.items(c.id);const item=items.find(i=>i.status!=='COMPLETED');
   if(c.status==='PAUSING') {
    const run=item?.run_id==null?undefined:await r.runs.readRun(item.run_id);
    if(run===undefined || ['PAUSED','COMPLETED','FAILED','CANCELLED'].includes(run.status)) await r.taskChains.state(c.id,c.stop_target??'PAUSED',c.reason);
    return;
   }
   if(c.runtime_id!==runtimeId)return;
   if(c.expires_at===null || c.expires_at<=await r.taskChains.now()){const last=c.authorization_history.at(-1);await stopLocked(r,c,'EXPIRED','AUTHORIZATION_EXPIRED',typeof last?.command_id==='string'?last.command_id:undefined);return;}
   if(item===undefined){await r.taskChains.state(c.id,'COMPLETED',null);return;}
   if(item.run_id!==null) {
    const run=await r.runs.readRun(item.run_id);const task=await r.tasks.readTask(item.task_id);
    const completion=task?.current_completion_id==null?undefined:await r.completions.readCompletionRecord(task.current_completion_id);
    if(task?.status==='DONE' && run?.status==='COMPLETED' && completion?.run_id===item.run_id && completion.acceptance_revision===item.acceptance_revision) {await r.taskChains.complete(c.id,item.id,completion.id);return;}
    if(run?.status==='PAUSED' && c.resume_command_id!==null && task!==undefined) return {kind:'RESUME' as const,c,item,taskRevision:task.revision.toString(),runRevision:run.revision.toString()};
    if(run===undefined || ['FAILED','CANCELLED','PAUSED'].includes(run.status)) await r.taskChains.state(c.id,'BLOCKED',`RUN_${run?.status??'UNAVAILABLE'}`);
    return;
   }
   if(Number((await r.taskChains.usage(c.id)).uncertain)>0 || c.calls_started>=c.max_model_calls || c.task_reservations>=c.max_tasks){await r.taskChains.state(c.id,'BLOCKED','BUDGET_OR_USAGE_UNKNOWN');return;}
   const task=await r.tasks.readTask(item.task_id);
   if(task===undefined){await r.taskChains.state(c.id,'BLOCKED','TASK_UNAVAILABLE');return;}
   return {kind:task.status==='INBOX'?'READY' as const:'DELEGATE' as const,c,item,taskRevision:item.task_revision.toString(),runRevision:''};
  });
  if(action===undefined)continue;
  try {
   const signature=executionSignature(action.item.execution_spec);const binding={chainId:action.c.id,itemId:action.item.id,runtimeId,...(signature===undefined?{}:{executionSignature:signature})};
   if(action.kind==='READY') await markTaskReady(db,{workspaceId:action.c.workspace_id,taskId:action.item.task_id,commandId:action.item.ready_command_id,expectedRevision:action.taskRevision,taskChainBinding:binding});
   else if(action.kind==='DELEGATE') await delegateTask(db,{workspaceId:action.c.workspace_id,taskId:action.item.task_id,commandId:action.item.delegate_command_id,expectedTaskRevision:action.taskRevision,taskChainBinding:binding,...taskChainDelegateExecution(action.item.execution_spec,action.c.expires_at)});
   else await resumeRun(db,{workspaceId:action.c.workspace_id,runId:action.item.run_id!,commandId:action.c.resume_command_id!,expectedTaskRevision:action.taskRevision,expectedRunRevision:action.runRevision,taskChainResume:{chainId:action.c.id,runtimeId}});
  } catch(error) {
   await withTransaction(db,async r=>{await authority(r,action.c.workspace_id);const c=(await r.taskChains.read(action.c.id,true))!;if(c.status==='ACTIVE') await r.taskChains.state(c.id,'BLOCKED',error instanceof DomainError?`${error.code}: ${error.detail}`:error instanceof Error?error.name:'ADMISSION_FAILED');});
  }
 }
}
