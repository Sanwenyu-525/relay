import {createElement} from "react";
import {afterEach,expect,it,vi} from "vitest";
import WritePermissionControl from "../../src/components/WritePermissionControl";
import {RelayApiClient} from "../../src/api/relayClient";
import {flush,mountReact} from "../../tests/mountApp";
let unmount:(()=>void)|null=null;
afterEach(()=>{unmount?.();unmount=null;vi.unstubAllGlobals();});
const wid="11111111-1111-4111-8111-111111111111",pid="22222222-2222-4222-8222-222222222222",rid="33333333-3333-4333-8333-333333333333";
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{"content-type":"application/json"}});
it.each([false,true])("目录档位回执错配=%s时应按确切目录身份决定是否解除待核对",async(mismatch)=>{
 const client=new RelayApiClient({baseUrl:"http://127.0.0.1:8787",workspaceId:wid,bearerToken:"test-token"});
 let commandId="",receiptReads=0;
 vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname;
  if(init?.method==="POST"){commandId=JSON.parse(String(init.body)).command_id;throw new TypeError("response lost");}
  if(path.includes('/commands/')){receiptReads++;return json({command_id:commandId,command_type:"SetLocalDirectoryWriteTier",committed_at:"2026-10-23T00:00:00Z",result:{project_id:pid,resource_id:mismatch?"44444444-4444-4444-8444-444444444444":rid,write_tier:"FULL",revision:"2"}});}
  return json({status:"READY",detail:"当前目录仍是请求批准",policy_decision:"ASK",write_tier:"ASK",access_revision:"2"});
 }));
 const mounted=await mountReact(createElement(WritePermissionControl,{client,projectId:pid,resourceId:rid,canonicalRoot:"D:\\fixture"}));unmount=mounted.unmount;await flush();
 await mounted.wrapper.get('[data-testid="write-permission-full"]').trigger("click");await flush();
 const pending=mounted.wrapper.find('[data-testid="write-permission-pending"]').exists();
 const enabled=mounted.wrapper.get('[data-testid="write-permission-full"]').attributes("disabled")===undefined;
 const confirmed=mounted.wrapper.find('[data-testid="write-permission-confirmed"]').text();
 console.log("TRIAGE_WRITE_PERMISSION_RECEIPT_TARGET",JSON.stringify({mismatch,receiptReads,pending,enabled,confirmed}));
 expect(receiptReads).toBe(1);
 expect(pending,"a receipt for another resource must not confirm this directory's pending write").toBe(mismatch);
});
