import {act,createElement} from "react";
import {MemoryRouter} from "react-router-dom";
import {afterEach,expect,it,vi} from "vitest";
import AttentionQueue from "../../src/components/AttentionQueue";
import {RelayApiError,type RelayApiClient} from "../../src/api/relayClient";
import {flush,mountReact} from "../../tests/mountApp";
let unmount:(()=>void)|null=null;
afterEach(()=>{unmount?.();unmount=null;});
it("待处理队列后续页503应保留失败页游标和原地重试入口",async()=>{
 let fail=true;const cursors:(string|null)[]=[];
 const client={getInterventions:vi.fn(async()=>[]),getReviews:vi.fn(async()=>[]),getProjectsPage:vi.fn(async()=>({items:[],nextCursor:null})),getWorkspaceTasksPage:vi.fn(async(cursor:string|null)=>{
  cursors.push(cursor);const index=cursor===null?0:Number(cursor.slice(1));
  if(index===10&&fail)throw new RelayApiError({status:503,code:"DATABASE_UNAVAILABLE",detail:"continuation page unavailable",retryable:true,retryAction:null,fieldErrors:[],expectedRevision:null,actualRevision:null});
  return {items:[{id:`t${index}`,projectId:"p",title:`task ${index}`,status:"READY",executor:"HUMAN",executorRunId:null,unresolvedBlockerIds:[],waitingReason:null,revision:"1"}],nextCursor:index<10?`c${index+1}`:null};
 })} as unknown as RelayApiClient;
 const mounted=await mountReact(createElement(MemoryRouter,null,createElement(AttentionQueue,{client})));unmount=mounted.unmount;await flush();
 const more=()=>Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(b=>b.textContent?.includes("继续读取后续页"));
 expect(cursors).toHaveLength(10);expect(more()).toBeDefined();
 await act(async()=>{more()!.click();});await flush();
 const continuationAvailable=!!more();
 const firstPagePreserved=mounted.wrapper.find('[data-testid="attention-task-t0"]').exists();
 const incomplete=mounted.wrapper.find('[data-testid="attention-incomplete"]').exists();
 fail=false;
 if(more()){await act(async()=>{more()!.click();});await flush();}
 const recoveredWithoutRestart=mounted.wrapper.find('[data-testid="attention-task-t10"]').exists();
 const cursorHistoryBeforeRestart=[...cursors];
 await mounted.wrapper.get('[data-testid="attention-refresh"]').trigger("click");await flush();
 expect(more()).toBeDefined();
 await act(async()=>{more()!.click();});await flush();
 const recoveredAfterRestart=mounted.wrapper.find('[data-testid="attention-task-t10"]').exists();
 console.log("TRIAGE_ATTENTION_PAGE_FAILURE",JSON.stringify({cursorHistoryBeforeRestart,cursors,continuationAvailable,firstPagePreserved,incomplete,recoveredWithoutRestart,recoveredAfterRestart}));
 expect(firstPagePreserved).toBe(true);expect(incomplete).toBe(true);
 expect(recoveredAfterRestart).toBe(true);
 expect(continuationAvailable,"a failed continuation page needs an original-cursor retry without rereading all previous pages").toBe(true);
});
