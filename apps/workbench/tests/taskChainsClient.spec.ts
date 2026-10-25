import {afterEach,expect,it,vi} from 'vitest';
import {RelayApiClient} from '../src/api/relayClient';
afterEach(()=>vi.unstubAllGlobals());
it('任务链客户端明确传授权累计上限与期限，保留暂停中和原 Run/完成引用',async()=>{
 const posts:Record<string,unknown>[]=[];let state='DRAFT';
 vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{const result={chain_id:'c1',project_id:'p1',status:state,revision:'1'};
  if(init?.method==='POST'){const body=JSON.parse(String(init.body));posts.push(body);state=url.endsWith('/controls')?'PAUSING':url.endsWith('/authorizations')?'ACTIVE':'DRAFT';return new Response(JSON.stringify({command_id:body.command_id,committed_at:'2026-10-14T00:00:00Z',result:{...result,status:state}}),{status:url.endsWith('/task-chains')?201:200});}
  const row={...result,title:'本段',baseline:{tool_scope:'INTERNAL_MARKDOWN_ARTIFACTS_ONLY'},max_tasks:2,max_model_calls:4,task_reservations:1,calls_started:1,expires_at:'2026-10-14T01:00:00Z',reason:'用户暂停',control_request_id:'pause1',authorization_history:[{calls_started:0}],items:[{run_id:'run1',completion_id:null,status:'RUNNING'}],model_usage:{uncertain_calls:0,monetary_cost:null}};
  return new Response(JSON.stringify(url.endsWith('/task-chains')?{project_id:'p1',items:[row]}:row),{status:200});}));
 const api=new RelayApiClient({baseUrl:'http://127.0.0.1:8787',workspaceId:'w1',bearerToken:'test'});
 await api.createTaskChain({commandId:'create',projectId:'p1',title:'本段',confirmed:true,tasks:[{taskId:'t1',expectedRevision:'0',expectedAcceptanceRevision:'1'}]});
 await api.authorizeTaskChain({commandId:'auth',chainId:'c1',expectedRevision:'1',confirmed:true,maxTasks:2,maxModelCalls:4,expiresAt:'2026-10-14T01:00:00Z'});
 await api.stopTaskChain({commandId:'stop',chainId:'c1',expectedRevision:'2',action:'PAUSE',reason:'用户暂停'});const c=await api.getTaskChain('c1');expect(c.status).toBe('PAUSING');expect(c.items[0]?.run_id).toBe('run1');expect(c.callsStarted).toBe(1);
 expect((await api.getProjectTaskChains('p1')).items).toHaveLength(1);expect(posts[1]).toMatchObject({confirmed:true,max_tasks:2,max_model_calls:4,expires_at:'2026-10-14T01:00:00Z'});
});
it('创建回执 command_id 不匹配时拒绝结果',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>{
  return new Response(JSON.stringify({command_id:'other-command',committed_at:'2026-10-14T00:00:00Z',
   result:{chain_id:'c1',project_id:'p1',status:'DRAFT',revision:'1'}}),{status:201});}));
 const api=new RelayApiClient({baseUrl:'http://127.0.0.1:8787',workspaceId:'w1',bearerToken:'test'});
 await expect(api.createTaskChain({commandId:'create',projectId:'p1',title:'本段',confirmed:true,
  tasks:[{taskId:'t1',expectedRevision:'0',expectedAcceptanceRevision:'1'}]})).rejects.toThrow('任务链回执与原命令/身份不匹配。');
});
