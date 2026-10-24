import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
page.on("pageerror", (error) => console.log("PAGEERROR:", String(error).slice(0, 400)));
page.on("console", (message) => { if (message.type() === "error") console.log("CONSOLE:", message.text().slice(0, 300)); });
await page.goto("http://127.0.0.1:5211/agent", { waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(1500);
await page.waitForTimeout(2500);
console.log("TITLE:", await page.title());
console.log("BODY:", (await page.evaluate(() => document.body.innerText)).slice(0, 700));
console.log("URL:", page.url());
const connect = page.getByText("连接本机 API", { exact: false }).first();
if (await connect.count()) { await connect.click().catch((e) => console.log("click fail", String(e).slice(0,120))); await page.waitForTimeout(2500); }
console.log("BODY2:", (await page.evaluate(() => document.body.innerText)).slice(0, 500));
console.log("HASCOMPOSER:", await page.locator(".agent-chat-composer").count());
const composer = page.locator(".agent-chat-composer").first();
await composer.scrollIntoViewIfNeeded().catch(() => {});
await page.screenshot({ path: "results/composer-mode-select-20261018.png", clip: { x: 0, y: 0, width: 1180, height: 800 } });
const tools = await page.evaluate(() => {
  const t = document.querySelector(".agent-chat-composer-tools");
  const s = document.querySelector(".agent-chat-mode-select-field");
  const perm = document.querySelector('[data-testid="write-permission-chip"]');
  const c = document.querySelector(".agent-chat-composer");
  const box = (n) => n ? (({left, right, top, bottom, height}) => ({left, right, top, bottom, height}))(n.getBoundingClientRect()) : null;
  return { tools: box(t), mode: box(s), perm: box(perm), composer: box(c),
    permText: perm?.textContent ?? null, modeValue: document.querySelector(".agent-chat-mode-select")?.value ?? null,
    toolsHeight: t?.getBoundingClientRect().height ?? null };
});
console.log(JSON.stringify(tools, null, 2));
await browser.close();
