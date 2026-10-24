import {afterEach,expect,it,vi} from "vitest";
import {activateRelayConnection,resetRelayConnectionForTest} from "../../src/lib/relayConnection";
import {flush,mountWorkbench} from "../../tests/mountApp";
let unmount:(()=>void)|null=null;
afterEach(()=>{unmount?.();unmount=null;resetRelayConnectionForTest();vi.unstubAllGlobals();});
const pid='22222222-2222-4222-8222-222222222222';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
it.each([503,500,0])('首条创建未知结果%s必须保留原创建命令以核对',async(status)=>{
 const wid=status===503?'11111111-1111-4111-8111-111111111121':status===500?'11111111-1111-4111-8111-111111111122':'11111111-1111-4111-8111-111111111123';
 const commands:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{const p=new URL(String(input)).pathname;
  if(p.endsWith('/assist-sessions')&&init?.method==='POST'){
   const id=JSON.parse(String(init.body)).command_id;commands.push(id);
   if(status===0)throw new TypeError('response lost');
   return json({status,code:status===503?'DATABASE_UNAVAILABLE':'INTERNAL_ERROR',title:'创建结果待核对',detail:'write outcome requires receipt check',retryable:false,retry_action:'CHECK_RECEIPT_THEN_RETRY',command_id:id},status);
  }
  if(p.endsWith(`/projects/${pid}`))return json({id:pid,title:'create unknown probe',project_type:'GENERAL',revision:'1',state_revision:'1',archived_at:null});
  return json({items:[],next_cursor:null});
 }));
 activateRelayConnection({baseUrl:'http://127.0.0.1:8787',workspaceId:wid,bearerToken:'test-token'});
 const mounted=await mountWorkbench(`/projects/${pid}?skill=assist`);unmount=mounted.unmount;
 await mounted.wrapper.get('[data-testid="assist-first-draft"]').setValue('首条原始请求');
 await mounted.wrapper.get('[data-testid="assist-first-send"]').trigger('click');await flush();
 expect(commands).toHaveLength(1);
 const queryVisible=Array.from(document.querySelectorAll('button')).some(b=>b.textContent?.trim()==='查询创建回执');
 const retainedRetry=mounted.wrapper.find('[data-testid="assist-first-create-retry"]').exists();
 await mounted.wrapper.get('[data-testid="assist-first-send"]').trigger('click');await flush();
 console.log('TRIAGE_FIRST_CREATE_TYPED_UNKNOWN',JSON.stringify({status,queryVisible,retainedRetry,commands,uniqueIds:new Set(commands).size}));
 expect(queryVisible,'receipt-check errors must retain the exact creation identity, not return to a fresh-create path').toBe(true);
 expect(new Set(commands).size).toBe(1);
});
