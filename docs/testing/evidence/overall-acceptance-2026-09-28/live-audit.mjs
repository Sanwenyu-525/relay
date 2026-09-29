import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../../apps/workbench/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const env = Object.fromEntries(readFileSync(new URL('../../../../apps/api/.env', import.meta.url), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => [l.slice(0,l.indexOf('=')), l.slice(l.indexOf('=')+1).trim()]));
const browser = await chromium.launch();
const page = await browser.newPage({viewport:{width:1280,height:800}});
const errors=[];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://127.0.0.1:5173');
await page.getByTestId('relay-connection-open').click();
await page.locator('input[name="relay-base-url"]').fill(`http://127.0.0.1:${env.RELAY_API_PORT ?? 8787}`);
await page.locator('input[name="relay-workspace-id"]').fill('11111111-1111-4111-8111-111111111111');
await page.locator('input[name="relay-bearer-token"]').fill(env.RELAY_API_BEARER_TOKEN);
await page.getByTestId('relay-connect').click();
await page.getByTestId('relay-connection-state').filter({hasText:'已连接'}).waitFor();
await page.keyboard.press('Escape');
const results=[];
for (const route of ['/today','/projects','/tasks','/knowledge','/activity','/reviews','/connections','/settings','/projects?view=create','/tasks?view=create']) {
  await page.evaluate(route => { history.pushState({}, '', route); window.dispatchEvent(new PopStateEvent('popstate')); }, route);
  await page.waitForTimeout(1100);
  const name=route.replace(/[^a-z0-9]/g,'-');
  await page.screenshot({path:new URL(`${name}.png`,import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'), fullPage:true});
  results.push({route,...await page.evaluate(()=>({title:document.querySelector('h1')?.textContent,bodyFont:getComputedStyle(document.body).fontFamily,overflow:document.documentElement.scrollWidth>innerWidth,alerts:[...document.querySelectorAll('[role="alert"],.action-error')].map(x=>x.textContent),text:document.querySelector('main')?.innerText}))});
}
writeFileSync(new URL('live-pages.json',import.meta.url),JSON.stringify({results,errors},null,2));
console.log(JSON.stringify(results.map(({route,title,bodyFont,overflow,alerts})=>({route,title,bodyFont,overflow,alerts})),null,2));
await browser.close();
