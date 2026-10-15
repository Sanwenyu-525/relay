import {afterEach,expect,it,vi} from 'vitest';
import {RelayApiClient} from '../src/api/relayClient';
afterEach(()=>vi.unstubAllGlobals());
it('任务链客户端传递显式资料、只读循环/固定读取与原方法消息身份',async()=>{
 let body:Record<string,unknown>={};vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({command_id:body.command_id,committed_at:'2026-10-14T00:00:00Z',result:{chain_id:'c1',project_id:'p1',status:'DRAFT',revision:'1'}}),{status:201});}));
 const api=new RelayApiClient({baseUrl:'http://127.0.0.1:8787',workspaceId:'w1',bearerToken:'test'});
 await api.createTaskChain({commandId:'create',projectId:'p1',title:'只读链',confirmed:true,tasks:[{taskId:'t1',expectedRevision:'0',expectedAcceptanceRevision:'1',execution:{contextSources:[{kind:'KNOWLEDGE',rootId:'k1',version:'1'}],toolLoopAction:{resourceId:'r1',connections:{FILE_READ:'connection1'},allowedTools:['read_file'],maxRounds:4,maxToolCalls:4},methodMessageId:'m1'}},{taskId:'t2',expectedRevision:'0',expectedAcceptanceRevision:'1',execution:{fileReadAction:{connectionId:'connection1',resourceId:'r1',relativeTarget:'notes.md'}}}]});
 const tasks=body.tasks as {execution:Record<string,unknown>}[];
 expect(tasks[0]?.execution).toEqual({context_sources:[{kind:'KNOWLEDGE',root_id:'k1',version:'1'}],tool_loop_action:{resource_id:'r1',connections:{FILE_READ:'connection1'},allowed_tools:['read_file'],max_rounds:4,max_tool_calls:4},method_message_id:'m1'});
 expect(tasks[1]?.execution.file_read_action).toEqual({connection_id:'connection1',resource_id:'r1',relative_target:'notes.md'});
});

it('修改与检查客户端只传明确范围和配置，不新增跨 Run 授权',async()=>{
 let body:Record<string,unknown>={};vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({command_id:body.command_id,committed_at:'2026-10-14T00:00:00Z',result:{chain_id:'c1',project_id:'p1',status:'DRAFT',revision:'1'}}),{status:201});}));
 const api=new RelayApiClient({baseUrl:'http://127.0.0.1:8787',workspaceId:'w1',bearerToken:'test'});
 await api.createTaskChain({commandId:'create-edit',projectId:'p1',title:'修改并检查',confirmed:true,tasks:[{taskId:'t1',expectedRevision:'0',expectedAcceptanceRevision:'1',execution:{toolLoopAction:{resourceId:'r1',connections:{FILE_WRITE:'write',CLI_RUN:'check'},allowedTools:['apply_changeset','run_check'],maxRounds:6,maxToolCalls:6},scopeGrant:{resourceId:'r1',allowedActions:['APPLY_CHANGESET','CLI_RUN'],checks:[{id:'tests',executable:'C:/node.exe',args:['check.mjs'],executableSha256:'a'.repeat(64),maxOutputBytes:4096}],expiresAt:'2026-10-14T12:00:00Z'},methodMessageId:'m1'}}]});
 const execution=(body.tasks as {execution:Record<string,unknown>}[])[0]!.execution;
 expect(execution.tool_loop_action).toEqual({resource_id:'r1',connections:{FILE_WRITE:'write',CLI_RUN:'check'},allowed_tools:['apply_changeset','run_check'],max_rounds:6,max_tool_calls:6});
 expect(execution.scope_grant).toEqual({resource_id:'r1',allowed_actions:['APPLY_CHANGESET','CLI_RUN'],checks:[{id:'tests',executable:'C:/node.exe',args:['check.mjs'],executable_sha256:'a'.repeat(64),max_output_bytes:4096}],expires_at:'2026-10-14T12:00:00Z'});
 expect(execution.method_message_id).toBe('m1');
});
