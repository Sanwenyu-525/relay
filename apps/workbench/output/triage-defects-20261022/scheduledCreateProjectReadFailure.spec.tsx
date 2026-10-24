import {createElement} from 'react';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,expect,it,vi} from 'vitest';
import CreateScheduledTaskView from '../../src/views/CreateScheduledTaskView';
import {activateRelayConnection,resetRelayConnectionForTest} from '../../src/lib/relayConnection';
import {mountReact,flush} from '../../tests/mountApp';
let unmount:(()=>void)|null=null;
afterEach(()=>{unmount?.();unmount=null;resetRelayConnectionForTest();vi.unstubAllGlobals();vi.restoreAllMocks();});
const wid='11111111-1111-4111-8111-111111111111',pid='22222222-2222-4222-8222-222222222222';
const project={id:pid,title:'可用项目',project_type:'GENERAL',archived_at:null,archive_status:'ACTIVE',revision:'1',state_revision:'1',phase_key:'PLANNING',next_action_task_id:null,created_at:'2026-10-23T00:00:00Z',updated_at:'2026-10-23T00:00:00Z'};
it('failed project lookup must be visible and retryable without losing the scheduled task draft',async()=>{
 let healthy=false,reads=0,posts=0;
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(init?.method==='POST'){posts++;throw new Error('unexpected write');}
  if(new URL(String(input)).pathname.endsWith('/projects')){reads++;return new Response(JSON.stringify(healthy?{items:[project],next_cursor:null}:{type:'/problems/database-unavailable',title:'暂时无法读取项目',status:503,code:'DATABASE_UNAVAILABLE',detail:'项目列表读取失败，请重试',retryable:true,retry_action:'RETRY_SAME_COMMAND'}),{status:healthy?200:503,headers:{'content-type':'application/json'}});}
  return new Response(JSON.stringify({items:[],next_cursor:null}),{status:200,headers:{'content-type':'application/json'}});
 }));
 activateRelayConnection({baseUrl:'http://127.0.0.1:8787',workspaceId:wid,bearerToken:'fixture-token'});
 const element=()=>createElement(MemoryRouter,null,createElement(CreateScheduledTaskView));
 const mounted=await mountReact(element());unmount=mounted.unmount;await flush(30);
 const beforeText=mounted.wrapper.text();
 const select=mounted.wrapper.get('[data-testid="scheduled-task-project"]').element as HTMLSelectElement;
 await mounted.wrapper.get('[data-testid="scheduled-task-title"]').setValue('保留我的定时草稿');
 await mounted.wrapper.get('[data-testid="scheduled-task-objective"]').setValue('整理样例');
 await mounted.wrapper.get('[data-testid="scheduled-task-criteria"]').setValue('摘要可读');
 healthy=true;await flush(30);
 await mounted.wrapper.get('form').trigger('submit');await flush(30);
 const retries=Array.from(mounted.wrapper.element.querySelectorAll('button')).filter(b=>/重试|重新读取|刷新项目/u.test(b.textContent??''));
 const evidence={initialProjectReads:reads,errorShownBeforeSubmit:/暂时无法读取项目|项目列表读取失败/u.test(beforeText),projectOptionCount:select.options.length,selectedProject:select.value,retryButtons:retries.length,draftTitle:(mounted.wrapper.get('[data-testid="scheduled-task-title"]').element as HTMLInputElement).value,submitOnlySaysProjectRequired:mounted.wrapper.text().includes('定时任务必须归属一个进行中的项目'),postCount:posts};
 // Verify the now-healthy transport and DTO on a clean remount, not by inventing a retry control.
 mounted.unmount();unmount=null;const recovered=await mountReact(element());unmount=recovered.unmount;await flush(30);
 const recoveredValue=(recovered.wrapper.get('[data-testid="scheduled-task-project"]').element as HTMLSelectElement).value;expect(recoveredValue).toBe(pid);
 console.log('TRIAGE_SCHEDULED_PROJECT_READ_FAILURE',JSON.stringify({...evidence,remountProject:recoveredValue,totalProjectReads:reads}));
 expect(evidence.initialProjectReads).toBe(1);expect(evidence.postCount).toBe(0);
 expect(evidence.errorShownBeforeSubmit,'failed project lookup is currently indistinguishable from an empty project list').toBe(true);
 expect(evidence.retryButtons).toBeGreaterThan(0);
});
