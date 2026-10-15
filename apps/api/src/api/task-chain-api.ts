import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { createTaskChain,authorizeTaskChain,stopTaskChain,readTaskChain,listTaskChains } from '../application/task-chains.js';
import { commandEnvelopeSchema, DelegateTaskBodySchema } from './domain-schemas.js';
import { INTERNAL_TOOL_DEFINITIONS } from '../workflow/tool-catalog.js';
import { createCommandHandler,sendReadError,type RouteDependencies } from './envelope.js';
import { TOOL_LOOP_MAX_ROUNDS,TOOL_LOOP_MAX_TOOL_CALLS,MAX_EXPLICIT_CONTEXT_SOURCES } from '../workflow/execution-contract.js';
const strict={additionalProperties:false} as const;const uuid=Type.String({format:'uuid'});const revision=Type.String({pattern:'^[0-9]+$'});
const params=Type.Object({workspace_id:uuid,id:uuid},strict);const projectParams=Type.Object({workspace_id:uuid,project_id:uuid},strict);
const result=Type.Object({chain_id:uuid,project_id:uuid,status:Type.String(),revision},strict);
const execution=Type.Object({
 context_sources:Type.Optional(Type.Array(Type.Object({kind:Type.Union([Type.Literal('KNOWLEDGE'),Type.Literal('MEMORY'),Type.Literal('DECISION')]),root_id:uuid,version:Type.String({pattern:'^[1-9][0-9]*$'})},strict),{maxItems:MAX_EXPLICIT_CONTEXT_SOURCES})),
 file_read_action:Type.Optional(Type.Object({connection_id:uuid,resource_id:uuid,relative_target:Type.String({minLength:1,maxLength:1024})},strict)),
 tool_loop_action:Type.Optional(Type.Object({resource_id:uuid,connections:Type.Object({FILE_QUERY:Type.Optional(uuid),FILE_READ:Type.Optional(uuid),GIT_READ:Type.Optional(uuid),FILE_WRITE:Type.Optional(uuid),CLI_RUN:Type.Optional(uuid)},strict),allowed_tools:Type.Array(Type.Union(INTERNAL_TOOL_DEFINITIONS.map(t=>Type.Literal(t.name))),{minItems:1,maxItems:INTERNAL_TOOL_DEFINITIONS.length,uniqueItems:true}),max_rounds:Type.Integer({minimum:1,maximum:TOOL_LOOP_MAX_ROUNDS}),max_tool_calls:Type.Integer({minimum:1,maximum:TOOL_LOOP_MAX_TOOL_CALLS})},strict)),
 scope_grant:Type.Optional(Type.Object({resource_id:uuid,allowed_actions:Type.Array(Type.Union([Type.Literal('APPLY_CHANGESET'),Type.Literal('CLI_RUN')]),{minItems:1,maxItems:2,uniqueItems:true}),checks:DelegateTaskBodySchema.properties.scope_grant.properties.checks,expires_at:Type.Optional(Type.String({format:'date-time'}))},strict)),
 method_message_id:Type.Optional(uuid)
},strict);
const createBody=Type.Object({command_id:uuid,title:Type.String({minLength:1,maxLength:200}),confirmed:Type.Literal(true),tasks:Type.Array(Type.Object({task_id:uuid,expected_revision:revision,expected_acceptance_revision:revision,execution:Type.Optional(execution)},strict),{minItems:1,maxItems:16})},strict);
const authBody=Type.Object({command_id:uuid,expected_revision:revision,confirmed:Type.Literal(true),max_tasks:Type.Integer({minimum:1,maximum:16}),max_model_calls:Type.Integer({minimum:1,maximum:100}),expires_at:Type.String({format:'date-time'})},strict);
const stopBody=Type.Object({command_id:uuid,expected_revision:revision,action:Type.Union([Type.Literal('PAUSE'),Type.Literal('REVOKE')]),reason:Type.String({minLength:1,maxLength:4000})},strict);
export function registerTaskChainRoutes(app:FastifyInstance,d:RouteDependencies,runtimeId:string) {
 app.post('/projects/:project_id/task-chains',{schema:{params:projectParams,body:createBody,response:{201:commandEnvelopeSchema(result)}}},createCommandHandler(d,{commandType:'CreateTaskChain',bodySchema:createBody,execute:async({executor,params,body})=>{
  const outcome=await createTaskChain(executor,{workspaceId:params.workspace_id??'',projectId:params.project_id??'',commandId:body.command_id,title:body.title,confirmed:body.confirmed,tasks:body.tasks.map(t=>({taskId:t.task_id,expectedRevision:t.expected_revision,expectedAcceptanceRevision:t.expected_acceptance_revision,...(t.execution===undefined?{}:{execution:t.execution})}))});return {outcome,result:outcome.result};}}));
 app.post('/task-chains/:id/authorizations',{schema:{params,body:authBody,response:{200:commandEnvelopeSchema(result)}}},createCommandHandler(d,{commandType:'AuthorizeTaskChain',bodySchema:authBody,execute:async({executor,params,body})=>{
  const outcome=await authorizeTaskChain(executor,{workspaceId:params.workspace_id??'',chainId:params.id??'',commandId:body.command_id,expectedRevision:body.expected_revision,runtimeId,confirmed:body.confirmed,maxTasks:body.max_tasks,maxModelCalls:body.max_model_calls,expiresAt:body.expires_at});return {outcome,result:outcome.result};}}));
 app.post('/task-chains/:id/controls',{schema:{params,body:stopBody,response:{200:commandEnvelopeSchema(result)}}},createCommandHandler(d,{commandType:'StopTaskChain',bodySchema:stopBody,execute:async({executor,params,body})=>{
  const outcome=await stopTaskChain(executor,{workspaceId:params.workspace_id??'',chainId:params.id??'',commandId:body.command_id,expectedRevision:body.expected_revision,action:body.action,reason:body.reason});return {outcome,result:outcome.result};}}));
 app.get('/task-chains/:id',{schema:{params}},async(request,reply)=>{try{const p=request.params as {workspace_id:string;id:string};return await readTaskChain(d.database.executor,p.workspace_id,p.id);}catch(e){return sendReadError(reply,e,request.id);}});
 app.get('/projects/:project_id/task-chains',{schema:{params:projectParams}},async(request,reply)=>{try{const p=request.params as {workspace_id:string;project_id:string};return await listTaskChains(d.database.executor,p.workspace_id,p.project_id);}catch(e){return sendReadError(reply,e,request.id);}});
}
