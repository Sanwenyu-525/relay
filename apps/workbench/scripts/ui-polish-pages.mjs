// 页面扫描：共享字体/控件/空态规则对其他页面的影响面核查（live 连接）。
// 用法：node apps/workbench/scripts/ui-polish-pages.mjs
// 输出：docs/testing/evidence/ui-live-integration-2026-09-28/today-polish/pages/
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const uiIdx = process.argv.indexOf("--ui");
const ui = uiIdx > -1 ? process.argv[uiIdx + 1] : "http://127.0.0.1:5173";
const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const envText = readFileSync(`${repoRoot}apps/api/.env`, "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#")
  && line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
const apiBase = `http://127.0.0.1:${env.RELAY_API_PORT ?? 8787}`;
const outDir = `${repoRoot}docs/testing/evidence/ui-live-integration-2026-09-28/today-polish/pages/`;
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

async function connect() {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill("11111111-1111-4111-8111-111111111111");
  await page.locator('input[name="relay-bearer-token"]').fill(env.RELAY_API_BEARER_TOKEN);
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 15000 });
  await page.keyboard.press("Escape");
}

const targets = [
  ["projects", "/projects"],
  ["projects-create", "/projects?view=create"],
  ["tasks", "/tasks"],
  ["tasks-create", "/tasks?view=create"],
  ["inbox", "/tasks?tab=inbox"],
  ["knowledge", "/knowledge"],
  ["activity", "/activity"],
  ["reviews", "/reviews"],
  ["connections", "/connections"],
  ["settings", "/settings"]
];
const notes = [];
for (const [name, path] of targets) {
  await page.goto(`${ui}${path}`, { waitUntil: "networkidle" });
  await connect();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${outDir}page-${name}.png` });
  const info = await page.evaluate(() => {
    const controls = [...document.querySelectorAll("input, select")].slice(0, 12).map((el) => ({
      type: el.type ?? el.tagName.toLowerCase(),
      font: getComputedStyle(el).fontFamily.slice(0, 28),
      height: Math.round(el.getBoundingClientRect().height) }));
    const badFonts = controls.filter((row) => /monospace|times/i.test(row.font));
    const source = document.querySelector(".demo-notice")?.textContent ?? null;
    return { controls, badFonts, source };
  });
  notes.push({ name, source: info.source, badFonts: info.badFonts, controls: info.controls });
}
await page.close(); await browser.close();
writeFileSync(`${outDir}sweep.json`, JSON.stringify(notes, null, 2));
console.log(notes.map((n) => `${n.name}: badFonts=${n.badFonts.length}`).join("\n"));
