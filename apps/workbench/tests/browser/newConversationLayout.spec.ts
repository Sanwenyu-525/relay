import { expect, test, type Page, type Route } from "@playwright/test";

// 新建对话的逐帧布局验收。API 仅使用隔离夹具，不访问真实数据库或 Provider。
// 与真实 Windows/WebView2 的目录加号、顶栏新对话及切目录证据分开报告。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_RAIL_TEST_PORT ?? "4173"}`;
const sessionId = "66666666-6666-4666-8666-666666666662";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

function session(title: string): unknown {
  return { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null, title,
    status: "ACTIVE", revision: "1", created_at: "2026-10-15T00:18:00Z",
    updated_at: "2026-10-15T00:18:00Z", pinned_at: null, unread_at: null,
    working_resource_id: null,
    context: { project_goals: [], working_directory: null } };
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("goal-card-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}


const projectId = "22222222-2222-4222-8222-222222222222";
const root = "D:\\Develop\\MyProject";
const project = {id:projectId,title:"MyProject",project_type:"GENERAL",revision:"1",state_revision:"1",archived_at:null};
async function directoryRoutes(page:Page,delay:number,fail:boolean,projectDelay=0) {
  let directoryOpened=false;let lateProjectReads=0;
  await page.route(`${apiBase}/**`,async route=>{
    const req=route.request(); const path=new URL(req.url()).pathname;
    const item={...(session("目录布局夹具") as object),project_id:projectId,working_resource_id:"res-1",conversation_mode:"AGENT",chat_mode:"CHAT",context:{project_goals:[],working_directory:{resource_id:"res-1",canonical_root:root,source:"USER_PICKED"}}};
    if(req.method()==="OPTIONS") return route.fulfill({status:204,headers:cors()});
    if(path==="/health/ready") return fulfillJson(route,{status:"ready"});
    if(path===`${prefix}/assist-sessions`) return fulfillJson(route,{items:[item]});
    if(path===`${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route,item);
    if(path===`${prefix}/projects/${projectId}`) { if(directoryOpened && projectDelay>0){lateProjectReads++;await new Promise(r=>setTimeout(r,projectDelay));}return fulfillJson(route,project);}
    if(path===`${prefix}/projects`) return fulfillJson(route,{items:[],next_cursor:null});
    if(path.endsWith("/goal")) return fulfillJson(route,{goal:null,rounds:[]});
    if(path.endsWith("/plans")) return fulfillJson(route,{latest:null,versions:[]});
    if(path.endsWith("/working-directories/open") && req.method()==="POST") {
      const body=req.postDataJSON(); directoryOpened=true;await new Promise(r=>setTimeout(r,delay));
      if(fail) return route.fulfill({status:409,contentType:"application/problem+json",headers:cors(),body:JSON.stringify({type:"/problems/conflict",title:"目录打开失败",status:409,detail:"独立验收受控拒绝",retryable:false,retry_action:"NONE"})});
      return fulfillJson(route,{command_id:body.command_id,committed_at:"2026-10-22T00:00:00Z",result:{canonical_root:body.root_path??root,display_name:"MyProject",status:"READY",reason:null,association:{project_id:projectId,project_title:"MyProject",project_archived:false,resource_id:"res-1",resource_status:"ACTIVE",file_write_identity_bound:true},created_project:false,created_resource:false,candidates:[],write_readiness:{status:"NEEDS_CONNECTION",detail:"测试目录只读"}},links:{resource:""}});
    }
    return fulfillJson(route,{items:[],next_cursor:null});
  });
  return {lateProjectReads:()=>lateProjectReads};
}
async function record(page:Page) {
  await page.evaluate(()=>{
    const w=window as typeof window & {layoutFrames?:number[][];stopLayout?:boolean};
    w.layoutFrames=[];w.stopLayout=false;
    const tick=()=>{if(w.stopLayout)return;const draft=document.querySelector('[data-testid="assist-first-draft"]');const card=draft?.closest('.agent-chat-composer');if(card && card.getBoundingClientRect().height>0){const b=card.getBoundingClientRect();w.layoutFrames!.push([b.top,b.bottom,b.height]);}requestAnimationFrame(tick);};requestAnimationFrame(tick);
  });
}
async function checkFrames(page:Page) {
  const frames=await page.evaluate(()=>{const w=window as typeof window & {layoutFrames?:number[][];stopLayout?:boolean};w.stopLayout=true;return w.layoutFrames??[];});
  expect(frames.length).toBeGreaterThan(5);
  const ranges=[0,1,2].map(i=>Math.max(...frames.map(f=>f[i]!))-Math.min(...frames.map(f=>f[i]!)));
  console.log("INDEPENDENT_LAYOUT",JSON.stringify({frames:frames.length,ranges,first:frames[0],last:frames.at(-1)}));
  expect(ranges[0]).toBeLessThanOrEqual(1);expect(ranges[1]).toBeLessThanOrEqual(1);expect(ranges[2]).toBeLessThanOrEqual(1);
}
for(const scenario of ["topbar","directory","project-late","switch-directory","slow-cancel","failure","repeated"] as const) {
  test(`independent new conversation ${scenario}`,async({page})=>{
    await page.setViewportSize({width:1162,height:782});
    const calls=await directoryRoutes(page,scenario==="slow-cancel"?5200:600,scenario==="failure",scenario==="project-late"?800:0);
    await page.goto(`/agent?session=${sessionId}`);await connect(page);
    await expect(page.getByTestId("assist-draft")).toBeVisible();
    await record(page);
    if(scenario==="topbar" || scenario==="switch-directory") await page.getByRole("link",{name:"新对话",exact:true}).click();
    else {
      const add=page.getByTestId("recent-work-new-in-res-1");
      const group=add.locator(".."); if(!(await group.evaluate(el=>(el as HTMLDetailsElement).open))) await group.locator(":scope > summary").click(); await group.locator(":scope > summary").hover();await add.click();
      if(scenario==="repeated") for(let i=0;i<4;i++){await add.locator("..").locator(":scope > summary").hover();await add.click();}
    }
    await expect(page.getByTestId("assist-first-draft")).toBeVisible();
    if(scenario==="switch-directory") {await page.getByTestId("folder-scope-change").click();await page.getByTestId("folder-manual-root").fill("D:/Develop/OtherProject");await page.getByTestId("folder-open-manual").click();}
    if(scenario==="slow-cancel") {
      await page.getByTestId("assist-first-draft").fill("保留测试草稿");
      await expect(page.getByTestId("collab-directory-slow")).toBeVisible({timeout:6500});
      await page.getByTestId("collab-directory-slow-cancel").click();
      await expect(page.getByTestId("assist-first-draft")).toHaveValue("保留测试草稿");
      await page.waitForTimeout(1600);
      await expect(page.getByTestId("assist-first-draft")).toHaveValue("保留测试草稿");
    } else if(scenario==="failure") {await expect(page.getByTestId("folder-error")).toBeVisible();await page.waitForTimeout(300);}
    else await page.waitForTimeout(scenario==="project-late"?2200:1200);
    if(scenario==="project-late") expect(calls.lateProjectReads()).toBeGreaterThan(0);
    await expect(page.getByText("正在核对对话工作对象与会话",{exact:false})).toHaveCount(0);
    await checkFrames(page);
  });
}
