import {act} from "react";
import {afterEach,expect,it,vi} from "vitest";
import {activateRelayConnection,resetRelayConnectionForTest} from "../../src/lib/relayConnection";
import {flush,mountWorkbench} from "../../tests/mountApp";
let unmount:(()=>void)|null=null;
afterEach(()=>{unmount?.();unmount=null;resetRelayConnectionForTest();vi.unstubAllGlobals();});
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{"content-type":"application/json"}});
function activity(id:string){return {id,created_at:"2026-10-23T00:00:00Z",actor_kind:"SYSTEM",actor_ref:"system",command_id:null,event_type:"PROBE_EVENT",summary:id,project_id:null,task_id:null,run_id:null,entity_refs:[]};}
it("动态续页在途时刷新，旧请求结束后新列表必须能继续加载",async()=>{
 let firstReads=0,oldSettled=false;
 let resolveOld:((value:Response)=>void)|undefined;
 const calls:string[]=[];
 vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
  const url=new URL(String(input));
  if(url.pathname.endsWith('/projects'))return json({items:[],next_cursor:null});
  if(!url.pathname.endsWith('/activities'))return json({items:[],next_cursor:null});
  const cursor=url.searchParams.get('cursor');calls.push(cursor??"FIRST");
  if(cursor==="old-page")return new Promise<Response>(resolve=>{resolveOld=value=>{oldSettled=true;resolve(value);};});
  if(cursor==="new-page")return json({items:[activity('new-page-item')],next_cursor:null});
  firstReads++;
  return json({items:[activity(firstReads===1?'initial-item':'refreshed-item')],next_cursor:firstReads===1?'old-page':'new-page'});
 }));
 activateRelayConnection({baseUrl:"http://127.0.0.1:8787",workspaceId:"11111111-1111-4111-8111-111111111111",bearerToken:"test-token"});
 const mounted=await mountWorkbench('/activity');unmount=mounted.unmount;
 const findButton=(text:string)=>Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent?.trim()===text);
 await act(async()=>{findButton('继续加载')!.click();});await flush();
 expect(resolveOld).toBeDefined();
 const refresh=findButton('刷新当前范围')!;expect(refresh.disabled).toBe(false);
 await act(async()=>{refresh.click();});await flush();
 expect(mounted.wrapper.find('[data-testid="activity-basis-refreshed-item"]').exists()).toBe(true);
 await act(async()=>{resolveOld!(json({items:[activity('old-page-item')],next_cursor:null}));});await flush();
 const more=findButton('继续加载')??findButton('正在读取后续页');
 const stuck=more?.disabled===true;
 const staleIgnored=!mounted.wrapper.find('[data-testid="activity-basis-old-page-item"]').exists();
 console.log('TRIAGE_ACTIVITY_REFRESH_DURING_MORE',JSON.stringify({calls,firstReads,oldSettled,staleIgnored,moreLabel:more?.textContent,stuck}));
 expect(oldSettled).toBe(true);expect(staleIgnored).toBe(true);
 expect(stuck,'refresh must reset load-more state even when the prior request is discarded by requestVersion').toBe(false);
});
