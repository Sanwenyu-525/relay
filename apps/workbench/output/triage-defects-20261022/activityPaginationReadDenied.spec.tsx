import {act} from "react";
import {afterEach,expect,it,vi} from "vitest";
import {activateRelayConnection,resetRelayConnectionForTest} from "../../src/lib/relayConnection";
import {flush,mountWorkbench} from "../../tests/mountApp";
let unmount:(()=>void)|null=null;
afterEach(()=>{unmount?.();unmount=null;resetRelayConnectionForTest();vi.unstubAllGlobals();});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
it.each([403,503])("动态续页返回%s应区分当前范围拒读和临时故障",async(status)=>{
 const requests:string[]=[];
 vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
  const url=new URL(String(input));
  if(url.pathname.endsWith('/projects'))return json({items:[],next_cursor:null});
  if(!url.pathname.endsWith('/activities'))return json({items:[],next_cursor:null});
  requests.push(url.search);
  if(url.searchParams.has('cursor'))return json({status,code:status===403?'FORBIDDEN':'DATABASE_UNAVAILABLE',title:status===403?'无权读取当前筛选范围':'数据库暂不可用',detail:'scope read failure',retryable:status===503,retry_action:status===503?'RETRY':'NONE'},status);
  return json({items:[{id:'private-activity',created_at:'2026-10-23T00:00:00Z',actor_kind:'SYSTEM',actor_ref:'system',command_id:null,event_type:'PRIVATE_PROBE_EVENT',summary:'PRIVATE_ACTIVITY_SUMMARY_PROBE',project_id:null,task_id:null,run_id:null,entity_refs:[]}],next_cursor:'next-page'});
 }));
 activateRelayConnection({baseUrl:'http://127.0.0.1:8787',workspaceId:'11111111-1111-4111-8111-111111111111',bearerToken:'test-token'});
 const mounted=await mountWorkbench('/activity');unmount=mounted.unmount;
 expect(mounted.wrapper.find('[data-testid="activity-basis-private-activity"]').exists()).toBe(true);
 const more=Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent?.trim()==='继续加载')!;
 await act(async()=>{more.click();});await flush();
 const previousRecordVisible=mounted.wrapper.find('[data-testid="activity-basis-private-activity"]').exists();
 const summaryVisible=mounted.wrapper.text().includes('PRIVATE_ACTIVITY_SUMMARY_PROBE');
 const errorVisible=mounted.wrapper.find('[role="alert"]').exists();
 console.log('TRIAGE_ACTIVITY_MORE_DENIED',JSON.stringify({status,requests,previousRecordVisible,summaryVisible,errorVisible}));
 expect(requests).toHaveLength(2);expect(errorVisible).toBe(true);
 expect(previousRecordVisible,'a definitive scope denial must clear previously loaded records; transient 503 may keep them').toBe(status===503);
});
