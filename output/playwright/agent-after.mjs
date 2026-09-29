import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from '../../apps/workbench/node_modules/@playwright/test/index.mjs';
const env = process.loadEnvFile ? (process.loadEnvFile('apps/api/.env'), process.env) : {};
const base = `http://127.0.0.1:${env.RELAY_API_PORT || 8787}`;
const workspace = '11111111-1111-4111-8111-111111111111';
const root = `${base}/api/v1/workspaces/${workspace}`;
const out = 'output/playwright/agent-audit'; mkdirSync(out, {recursive:true});
const headers = { authorization: `Bearer ${env.RELAY_API_BEARER_TOKEN}`, 'content-type':'application/json' };
async function api(path, body) {
  const response = await fetch(root+path,{headers,method:body?'POST':'GET',body:body?JSON.stringify({command_id:randomUUID(),...body}):undefined});
  if(!response.ok) throw new Error(`API ${path}: ${response.status}`);
  return response.json();
}
const projects = await api('/projects?status=active');
let project = projects.items.find(p=>p.title==='Agent 聊天验收 2026-09-29');
if(!project) {const r=await api('/projects',{title:'Agent 聊天验收 2026-09-29',project_type:'GENERAL'});project={id:r.result.project_id};}
let sessions=(await api(`/assist-sessions?project_id=${project.id}`)).items;
for(let i=sessions.length;i<2;i++) await api('/assist-sessions',{project_id:project.id,title:`验收会话 ${i+1} · 切换与输入`});
sessions=(await api(`/assist-sessions?project_id=${project.id}`)).items;
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:5173/agent');
await page.getByTestId('relay-connection-open').click();
await page.locator('input[name="relay-base-url"]').fill(base);
await page.locator('input[name="relay-workspace-id"]').fill(workspace);
await page.locator('input[name="relay-bearer-token"]').fill(env.RELAY_API_BEARER_TOKEN);
await page.getByTestId('relay-connect').click();
await page.getByTestId('relay-connection-state').filter({hasText:'已连接'}).waitFor();
await page.keyboard.press('Escape');
await page.getByTestId(`agent-session-${sessions[0].id}`).click();
await page.getByTestId('assist-draft').waitFor();
const measures=[];
for(const [w,h] of [[1440,900],[1280,800],[960,640],[390,844]]) {
 await page.setViewportSize({width:w,height:h});
 await page.screenshot({path:`${out}/after-${w}.png`});
 measures.push(await page.evaluate(()=>{const r=document.querySelector('[data-testid="assist-draft"]').getBoundingClientRect();const s=document.querySelector('[data-testid="assist-send"]').getBoundingClientRect();return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,draftY:r.y,draftBottom:r.bottom,sendBottom:s.bottom,transcriptHeight:document.querySelector(".agent-chat-transcript").clientHeight};}));
}
await page.setViewportSize({width:1440,height:900});
await page.getByTestId('assist-draft').fill('未发送的验收草稿');
await page.getByTestId(`agent-session-${sessions[1].id}`).click();
await page.getByRole('dialog',{name:'未发送的内容'}).waitFor();
await page.keyboard.press('Escape');
const preserved=(await page.getByTestId('assist-draft').inputValue())==='未发送的验收草稿';
await page.getByTestId('agent-new').click();
await page.getByRole('dialog',{name:'未发送的内容'}).waitFor();
await page.getByRole('button',{name:'留在当前会话',exact:true}).click();
await page.locator('nav[aria-label="主导航"] a[href="/projects"]').click();
await page.getByRole('dialog',{name:'保留未保存的修改'}).waitFor();
await page.getByRole('button',{name:'保留并继续编辑',exact:true}).click();
await page.getByTestId(`agent-session-${sessions[1].id}`).click();
await page.getByTestId('agent-discard-draft').click();
await page.getByTestId(`agent-session-${sessions[1].id}`).filter({has:page.locator('span')}).waitFor();
await page.getByTestId('assist-draft').waitFor();
const discarded=(await page.getByTestId('assist-draft').inputValue())==='';
const report={measures,preserved,discarded,internalAndRouteGuards:true,errors};
writeFileSync(`${out}/after.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser.close();
if(!preserved||!discarded||measures.some(m=>m.documentWidth>m.width||m.draftY<0||m.sendBottom>m.height||m.transcriptHeight<96))process.exitCode=1;

