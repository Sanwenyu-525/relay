import {act} from "react";
import {afterEach,expect,it,vi} from "vitest";
import {activateRelayConnection,resetRelayConnectionForTest} from "../../src/lib/relayConnection";
import {flush,mountWorkbench} from "../../tests/mountApp";
let unmount:(()=>void)|null=null;
afterEach(()=>{unmount?.();unmount=null;resetRelayConnectionForTest();vi.unstubAllGlobals();});
const pid='22222222-2222-4222-8222-222222222222',sid='33333333-3333-4333-8333-333333333333',aid='44444444-4444-4444-8444-444444444444';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
it.each(['imageOnly','textImage','plan'].flatMap(kind=>[true,false].map(lost=>({kind,lost}))))('创建首条载荷完整性 $kind 响应丢失=$lost',async({kind,lost})=>{
 const wid=kind==='imageOnly'?'11111111-1111-4111-8111-111111111111':kind==='textImage'?'11111111-1111-4111-8111-111111111112':'11111111-1111-4111-8111-111111111113';
 let created=false,createId='',createCount=0,uploads=0;
 const messages:Record<string,unknown>[]=[];
 const session={id:sid,workspace_id:wid,project_id:pid,task_id:null,title:'receipt recovery',status:'ACTIVE',chat_mode:'CHAT',revision:'0',created_at:'2026-10-23T00:00:00Z',updated_at:'2026-10-23T00:00:00Z'};
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname;
  if(path.endsWith('/assist-sessions')&&init?.method==='POST'){createCount++;createId=JSON.parse(String(init.body)).command_id;if(lost)throw new TypeError('creation response lost after commit');created=true;return json({command_id:createId,committed_at:'2026-10-23T00:00:01Z',result:{...session,session_id:sid}},201);}
  if(path.endsWith(`/commands/${createId}`)&&createId){created=true;return json({command_id:createId,command_type:'CreateAssistSession',committed_at:'2026-10-23T00:00:01Z',result:{...session,session_id:sid}});}
  if(path.endsWith('/message-attachments')&&init?.method==='POST'){uploads++;return json({attachment_id:aid,byte_length:3,content_hash:'a'.repeat(64)},201);}
  if(path.endsWith(`/assist-sessions/${sid}/messages`)&&init?.method==='POST'){const body=JSON.parse(String(init.body));messages.push(body);return json({command_id:body.command_id,committed_at:'2026-10-23T00:00:02Z',result:{session_id:sid,user_message_id:'55555555-5555-4555-8555-555555555555',assistant_message_id:'66666666-6666-4666-8666-666666666666'}},202);}
  if(path.endsWith(`/projects/${pid}`))return json({id:pid,title:'recovery project',project_type:'GENERAL',revision:'1',state_revision:'1',archived_at:null});
  if(path.endsWith('/assist-sessions'))return json({items:created?[session]:[]});
  if(path.endsWith(`/assist-sessions/${sid}`))return json(session);
  return json({items:[],next_cursor:null});
 }));
 activateRelayConnection({baseUrl:'http://127.0.0.1:8787',workspaceId:wid,bearerToken:'test-token'});
 const mounted=await mountWorkbench(`/projects/${pid}?skill=assist`);unmount=mounted.unmount;
 const draft=mounted.wrapper.get('[data-testid="assist-first-draft"]');
 if(kind==='plan')await draft.setValue('/plan 只制定计划，不改文件');
 if(kind==='textImage')await draft.setValue('请看这张图');
 if(kind!=='plan'){
  const file=new File([new Uint8Array([1,2,3])],'image.png',{type:'image/png'});
  const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{items:[{kind:'file',type:file.type,getAsFile:()=>file}],files:[file],types:['Files']}});
  await act(async()=>{draft.element!.dispatchEvent(event);});await flush();
 }
 await mounted.wrapper.get('[data-testid="assist-first-send"]').trigger('click');await flush(100);
 expect(createCount).toBe(1);
 if(lost){expect(messages).toHaveLength(0);const query=Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent?.trim()==='查询创建回执');expect(query).toBeDefined();await act(async()=>{query!.click();});await flush(100);}
 console.log('TRIAGE_FIRST_CREATE_RECEIPT_PAYLOAD',JSON.stringify({kind,lost,createCount,uploads,messages}));
 expect(createCount).toBe(1);
 if(kind==='plan')expect(messages[0]?.chat_mode,'original PLAN behavior must survive creation receipt recovery').toBe('PLAN');
 else{expect(messages,'image-only first message must not be dropped by a text-only guard').toHaveLength(1);expect(messages[0]?.attachment_ids,'original image references must survive creation recovery').toEqual([aid]);}
});
