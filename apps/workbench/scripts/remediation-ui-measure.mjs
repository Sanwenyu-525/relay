import { chromium } from "@playwright/test";
import { readFileSync, copyFileSync, mkdirSync } from "node:fs";

const repoRoot = "D:/Develop/Relay-Agent";
const envText = readFileSync(`${repoRoot}/apps/api/.env`, "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#")
  && line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await page.goto("http://127.0.0.1:5173/knowledge", { waitUntil: "networkidle" });
await page.getByTestId("relay-connection-open").click();
await page.locator('input[name="relay-base-url"]').fill(`http://127.0.0.1:${env.RELAY_API_PORT ?? 8787}`);
await page.locator('input[name="relay-workspace-id"]').fill("11111111-1111-4111-8111-111111111111");
await page.locator('input[name="relay-bearer-token"]').fill(env.RELAY_API_BEARER_TOKEN);
await page.getByTestId("relay-connect").click();
await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 15000 });
await page.keyboard.press("Escape");
await page.waitForTimeout(1200);

const data = await page.evaluate(() => {
  const create = document.querySelector('[data-testid="knowledge-create"]');
  const tabs = [...document.querySelectorAll('[data-testid^="knowledge-tab-"]')].map((el) => el.textContent?.trim());
  const empty = document.querySelector(".knowledge-list .helper-text")?.textContent?.trim();
  const r = create?.getBoundingClientRect();
  const style = create ? getComputedStyle(create) : null;
  return {
    createText: create?.textContent?.trim(),
    createWidth: r ? Math.round(r.width) : null,
    createHeight: r ? Math.round(r.height) : null,
    whiteSpace: style?.whiteSpace,
    // 单行按钮高度应接近控件高（约40-48px）；若换行会出现约两倍行高
    approxLines: r && style ? Math.round(r.height / parseFloat(style.lineHeight || "24")) : null,
    tabs,
    empty,
  };
});
console.log(JSON.stringify(data, null, 2));

const outDir = `${repoRoot}/docs/testing/evidence/remediation-2026-09-28/ui/`;
mkdirSync(outDir, { recursive: true });
await page.screenshot({ path: `${outDir}remediation-knowledge-live-1280-viewport.png` });
await page.screenshot({ path: `${outDir}remediation-knowledge-live-1280-full.png`, fullPage: true });
await browser.close();
