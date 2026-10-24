import {act,createElement} from "react";
import {MemoryRouter} from "react-router-dom";
import {afterEach,expect,it,vi} from "vitest";
import RecentWorkRail from "../../src/components/RecentWorkRail";
import {RelayApiClient} from "../../src/api/relayClient";
import {flush,mountReact} from "../../tests/mountApp";
let unmount:(()=>void)|null=null;
afterEach(()=>{unmount?.();unmount=null;vi.unstubAllGlobals();});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
it("归档列表首次读取503后应显示错误，不能仍提示尚未展开读取",async()=>{
 let failing=true,archiveReads=0;
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
  const url=new URL(String(input));
  if(url.pathname.endsWith('/assist-sessions')&&url.searchParams.get('status')==='ARCHIVED'){
   archiveReads++;
   if(failing)return json({status:503,code:'DATABASE_UNAVAILABLE',title:'数据库暂不可用',detail:'archive read unavailable',retryable:true,retry_action:'RETRY'},503);
  }
  return json({items:[],next_cursor:null});
 }));
 const client=new RelayApiClient({baseUrl:'http://127.0.0.1:8787',workspaceId:'11111111-1111-4111-8111-111111111111',bearerToken:'test-token'});
 const mounted=await mountReact(createElement(MemoryRouter,null,createElement(RecentWorkRail,{client,currentTaskId:null})));unmount=mounted.unmount;await flush();
 const archived=mounted.wrapper.get('[data-testid="recent-work-archived"]').element as HTMLDetailsElement;
 await act(async()=>{archived.open=true;archived.dispatchEvent(new Event('toggle',{bubbles:true}));});await flush();
 expect(archiveReads).toBeGreaterThan(0);
 const errorVisible=mounted.wrapper.find('[data-testid="recent-work-archived-error"]').exists();
 const unopenedHint=mounted.wrapper.get('[data-testid="recent-work-archived"]').text().includes('展开时读取归档列表');
 failing=false;
 await act(async()=>{archived.open=false;archived.dispatchEvent(new Event('toggle',{bubbles:true}));});await flush();
 await act(async()=>{archived.open=true;archived.dispatchEvent(new Event('toggle',{bubbles:true}));});await flush();
 const recoveredAfterReopen=mounted.wrapper.get('[data-testid="recent-work-archived"]').text().includes('暂无归档会话');
 console.log('TRIAGE_RECENT_ARCHIVE_READ_ERROR',JSON.stringify({archiveReads,errorVisible,unopenedHint,recoveredAfterReopen}));
 expect(recoveredAfterReopen).toBe(true);
 expect(errorVisible,'a completed failed archive read must render its recorded error instead of the unopened placeholder').toBe(true);
});
