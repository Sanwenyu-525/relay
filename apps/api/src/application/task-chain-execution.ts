import { createHash } from 'node:crypto';
import type { JsonObject } from '../infrastructure/json.js';
import type { InformationRootRow } from '../infrastructure/database-schema.js';
import type { ContextSourceRef } from '../workflow/execution-contract.js';
import { TOOL_LOOP_MAX_ROUNDS,TOOL_LOOP_MAX_TOOL_CALLS,MAX_EXPLICIT_CONTEXT_SOURCES } from '../workflow/execution-contract.js';
import { readInternalTool, INTERNAL_TOOL_DEFINITIONS } from '../workflow/tool-catalog.js';
import { freezeScopeChecks } from './run-scope-grant.js';
import { availableFrozenMethod,type RunMethodBinding } from '../skills/builtin-methods.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { invalidTransition,resourceNotFound,validationFailed } from './domain-error.js';
import type { DelegateTaskInput } from './delegate-task.js';
import type { Repositories } from './unit-of-work.js';
export interface TaskChainExecutionInput {
 context_sources?:readonly ContextSourceRef[];
 file_read_action?:NonNullable<DelegateTaskInput['fileReadAction']>;
 tool_loop_action?:NonNullable<DelegateTaskInput['toolLoopAction']>;
 scope_grant?:NonNullable<DelegateTaskInput['scopeGrant']>;
 method_message_id?:string;
}
interface InformationRef {kind:ContextSourceRef['kind'];root_id:string;revision:string;current_version:string}
interface ResourceRef {resource_id:string;revision:string;identity_key:string;canonical_root:string}
interface ConnectionRef {connection_id:string;capability:string;version:string}
export interface TaskChainExecutionSpec extends JsonObject {
 context_sources?:JsonObject[];file_read_action?:JsonObject;tool_loop_action?:JsonObject;
 execution_method?:RunMethodBinding;source_refs?:JsonObject[];resource_refs?:JsonObject[];connection_refs?:JsonObject[];
 scope_grant?:JsonObject;
}
const capabilities=new Set(INTERNAL_TOOL_DEFINITIONS.map(t=>t.capability));
export function executionSignature(spec:JsonObject) {return Object.keys(spec).length===0?undefined:createHash('sha256').update(canonicalizeJson(spec)).digest('hex');}
export async function freezeTaskChainExecution(r:Repositories,workspaceId:string,projectId:string,taskId:string,input:TaskChainExecutionInput|undefined):Promise<TaskChainExecutionSpec> {
 if(input===undefined)return {};
 if(input.file_read_action!==undefined && input.tool_loop_action!==undefined)throw invalidTransition('固定读取与工具循环只能选一种。');
 const sources:JsonObject[]=[];const sourceRefs:JsonObject[]=[];const resourceRefs:JsonObject[]=[];const connectionRefs:JsonObject[]=[];
 const seen=new Set<string>();
 if((input.context_sources?.length??0)>MAX_EXPLICIT_CONTEXT_SOURCES)throw validationFailed([{field:'context_sources',message:`最多选 ${MAX_EXPLICIT_CONTEXT_SOURCES} 个确切来源。`}]);
 for(const source of input.context_sources??[]) {
  if(!['KNOWLEDGE','MEMORY','DECISION'].includes(source.kind)||!/^\d+$/u.test(source.version)||BigInt(source.version)<1n)throw invalidTransition('资料引用需要支持的种类与正版本。');
  const key=`${source.kind}:${source.root_id}:${source.version}`;if(seen.has(key))continue;seen.add(key);
  const kind=source.kind.toLowerCase() as 'knowledge'|'memory'|'decision';
  const root=await r.information.readRoot<InformationRootRow>(kind,source.root_id);
  if(root?.workspace_id!==workspaceId || root.project_id!==null&&root.project_id!==projectId)throw resourceNotFound('Context source');
  if(root.status!=='ACTIVE' || await r.information.readVersion(kind,root.id,BigInt(source.version))===undefined)throw invalidTransition('所选资料版本不可用。');
  sources.push({kind:source.kind,root_id:source.root_id,version:source.version});sourceRefs.push({kind:source.kind,root_id:root.id,revision:root.revision.toString(),current_version:root.current_version.toString()});
 }
 const read=input.file_read_action;const loop=input.tool_loop_action;const grant=input.scope_grant;
 if(grant!==undefined&&loop===undefined)throw invalidTransition('范围授权需要工具循环规格。');
 if(loop!==undefined) {
  if(loop.allowed_tools.length===0 || new Set(loop.allowed_tools).size!==loop.allowed_tools.length || loop.allowed_tools.some(t=>readInternalTool(t)===undefined))throw invalidTransition('任务链只能使用原注册工具。');
  if(!Number.isInteger(loop.max_rounds)||loop.max_rounds<1||loop.max_rounds>TOOL_LOOP_MAX_ROUNDS||!Number.isInteger(loop.max_tool_calls)||loop.max_tool_calls<1||loop.max_tool_calls>TOOL_LOOP_MAX_TOOL_CALLS)throw invalidTransition('工具循环预算超出原入口上限。');
  if(Object.keys(loop.connections).some(c=>!capabilities.has(c as never)) || loop.allowed_tools.some(t=>loop.connections[readInternalTool(t)!.capability]===undefined))throw invalidTransition('工具缺少对应受管连接。');
  if(grant!==undefined&&(grant.resource_id!==loop.resource_id||grant.survives_run_terminal===true||grant.allowed_actions.length===0||new Set(grant.allowed_actions).size!==grant.allowed_actions.length||grant.allowed_actions.some(a=>!['APPLY_CHANGESET','CLI_RUN'].includes(a)||!loop.allowed_tools.some(t=>readInternalTool(t)!.actionType===a))))throw invalidTransition('范围授权只能收窄本项修改/检查工具，不能跨 Run 或扩大动作范围。');
  if(loop.allowed_tools.includes('run_check')&&(grant===undefined||!grant.allowed_actions.includes('CLI_RUN')||grant.checks.length===0))throw invalidTransition('运行检查需明确范围授权和已配置检查清单。');
 }
 if(read!==undefined && (!read.relative_target.trim()||read.relative_target.length>1024))throw invalidTransition('需要明确受管根内文件路径。');
 const resourceId=read?.resource_id??loop?.resource_id;
 let scopeGrant:JsonObject|undefined;
 if(resourceId!==undefined) {
  const resource=await r.gateway.readResource(resourceId);
  if(resource?.workspace_id!==workspaceId || resource.project_id!==projectId || resource.status!=='ACTIVE')throw resourceNotFound('Managed resource');
  resourceRefs.push({resource_id:resource.id,revision:resource.revision.toString(),identity_key:resource.identity_key,canonical_root:resource.canonical_root});
  for(const [capability,connectionId] of Object.entries(read===undefined?loop!.connections:{FILE_READ:read.connection_id})) {
   const c=await r.gateway.readConnection(connectionId);
   if(c?.workspace_id!==workspaceId || c.project_id!==projectId || c.status!=='ACTIVE' || !await r.gateway.hasConnectionCapability(c.id,capability as never))throw invalidTransition('任务链连接不可用或能力不匹配。');
   connectionRefs.push({connection_id:c.id,capability,version:c.version.toString()});
  }
  if(grant!==undefined) {
   if(grant.expires_at!==undefined&&(!Number.isFinite(Date.parse(grant.expires_at))||Date.parse(grant.expires_at)<=Date.now()))throw invalidTransition('范围授权期限需为未来有效时刻。');
   const checks=await freezeScopeChecks(resource.canonical_root,grant.checks,taskId);
   if(checks.some(c=>c.trust_basis!.materials.find(m=>m.role==='EXECUTABLE')?.sha256!==c.executable_sha256))throw invalidTransition('检查入口摘要与实际程序不匹配。');
   scopeGrant={resource_id:grant.resource_id,allowed_actions:[...grant.allowed_actions],checks:checks as unknown as JsonObject[],...(grant.expires_at===undefined?{}:{expires_at:grant.expires_at})};
  }
 }
 let method:RunMethodBinding|undefined;
 if(input.method_message_id!==undefined) {
  const user=await r.assist.readMessage(input.method_message_id);const session=user===undefined?undefined:await r.assist.readSession(user.session_id);
  if(user?.role!=='USER'||user.status!=='COMPLETED'||session?.workspace_id!==workspaceId||session.project_id!==projectId||session.conversation_mode!=='AGENT'||session.task_id!==null&&session.task_id!==taskId)throw invalidTransition('方法来源需同项目普通会话的原用户消息。');
  const reply=await r.assist.readMessageAtSeq(session.id,user.seq+1n);
  if(reply?.role!=='ASSISTANT'||reply.status!=='COMPLETED'||reply.method_snapshot===null||availableFrozenMethod(reply.method_snapshot)===null||!['INSPECT','MODIFY'].includes(reply.method_action??''))throw invalidTransition('需要原会话可核对的冻结方法与行动。');
  const writes=loop?.allowed_tools.includes('apply_changeset')===true;
  if(reply.method_action==='INSPECT'&&writes||reply.method_action==='MODIFY'&&!writes)throw invalidTransition('方法行动与文件修改范围不一致。');
  method={method_snapshot:reply.method_snapshot,action:reply.method_action as 'INSPECT'|'MODIFY',argument:reply.method_argument,session_id:session.id,source_message_id:user.id};
 }
 return {...(sources.length===0?{}:{context_sources:sources,source_refs:sourceRefs}),...(read===undefined?{}:{file_read_action:{...read}}),
  ...(loop===undefined?{}:{tool_loop_action:{resource_id:loop.resource_id,connections:{...loop.connections},allowed_tools:[...loop.allowed_tools],max_rounds:loop.max_rounds,max_tool_calls:loop.max_tool_calls}}),
  ...(resourceRefs.length===0?{}:{resource_refs:resourceRefs,connection_refs:connectionRefs}),...(scopeGrant===undefined?{}:{scope_grant:scopeGrant}),...(method===undefined?{}:{execution_method:method})};
}
export async function requireTaskChainExecutionCurrent(r:Repositories,workspaceId:string,projectId:string,spec:JsonObject,taskId:string) {
 for(const ref of (spec.source_refs??[]) as unknown as InformationRef[]) {
  const root=await r.information.readRoot<InformationRootRow>(ref.kind.toLowerCase() as 'knowledge'|'memory'|'decision',ref.root_id);
  if(root?.workspace_id!==workspaceId||root.status!=='ACTIVE'||root.project_id!==null&&root.project_id!==projectId||root.revision.toString()!==ref.revision||root.current_version.toString()!==ref.current_version)throw invalidTransition('任务链资料依据已变化，原版本保留，请重新圈定。');
 }
 for(const ref of (spec.resource_refs??[]) as unknown as ResourceRef[]) {
  const root=await r.gateway.readResource(ref.resource_id);
  if(root?.workspace_id!==workspaceId||root.project_id!==projectId||root.status!=='ACTIVE'||root.revision.toString()!==ref.revision||root.identity_key!==ref.identity_key||root.canonical_root!==ref.canonical_root)throw invalidTransition('任务链受管资源依据已变化。');
 }
 for(const ref of (spec.connection_refs??[]) as unknown as ConnectionRef[]) {
  const c=await r.gateway.readConnection(ref.connection_id);
  if(c?.workspace_id!==workspaceId||c.project_id!==projectId||c.status!=='ACTIVE'||c.version.toString()!==ref.version||!await r.gateway.hasConnectionCapability(c.id,ref.capability as never))throw invalidTransition('任务链连接依据已变化。');
 }
 if(spec.scope_grant!==undefined) {
  const grant=spec.scope_grant as unknown as NonNullable<DelegateTaskInput['scopeGrant']>;
  if(grant.expires_at!==undefined&&Date.parse(grant.expires_at)<=Date.now())throw invalidTransition('本项范围授权已到期。');
  const resource=(spec.resource_refs as unknown as ResourceRef[])[0]!;
  await freezeScopeChecks(resource.canonical_root,grant.checks,taskId);
 }
 if(spec.execution_method!==undefined) {
  const method=spec.execution_method as RunMethodBinding;const user=await r.assist.readMessage(method.source_message_id);const session=user===undefined?undefined:await r.assist.readSession(user.session_id);
  if(user?.role!=='USER'||user.status!=='COMPLETED'||session?.id!==method.session_id||session.workspace_id!==workspaceId||session.project_id!==projectId||session.conversation_mode!=='AGENT'||availableFrozenMethod(method.method_snapshot)===null)throw invalidTransition('原会话方法依据不可用。');
 }
}
export function taskChainDelegateExecution(spec:JsonObject,chainExpiresAt?:Date|null):Pick<DelegateTaskInput,'contextSources'|'fileReadAction'|'toolLoopAction'|'scopeGrant'|'executionMethod'> {
 const grant=spec.scope_grant as unknown as NonNullable<DelegateTaskInput['scopeGrant']>|undefined;
 const expiresAt=grant?.expires_at===undefined?chainExpiresAt:new Date(Math.min(Date.parse(grant.expires_at),chainExpiresAt?.getTime()??Infinity));
 return {...(spec.context_sources===undefined?{}:{contextSources:spec.context_sources as unknown as ContextSourceRef[]}),
  ...(spec.file_read_action===undefined?{}:{fileReadAction:spec.file_read_action as unknown as NonNullable<DelegateTaskInput['fileReadAction']>}),
  ...(spec.tool_loop_action===undefined?{}:{toolLoopAction:spec.tool_loop_action as unknown as NonNullable<DelegateTaskInput['toolLoopAction']>}),
  ...(grant===undefined?{}:{scopeGrant:{...grant,...(expiresAt==null?{}:{expires_at:expiresAt.toISOString()}),survives_run_terminal:false}}),
  ...(spec.execution_method===undefined?{}:{executionMethod:spec.execution_method as RunMethodBinding})};
}
