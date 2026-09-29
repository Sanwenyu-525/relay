// 临时验证脚本：附着 dev 窗口 CDP，确认页面加载与 desktop_bootstrap 真实返回。
// 只打印非敏感字段（端口、workspace id），不打印令牌。
import { chromium } from "@playwright/test";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages()[0];
console.log("page url:", page.url());

const bootstrap = await page.evaluate(async () => {
  return await window.__TAURI_INTERNALS__.invoke("desktop_bootstrap");
});
const summary = {};
for (const [k, v] of Object.entries(bootstrap)) {
  if (typeof v === "string" && v.length > 40) {
    summary[k] = `<string len=${v.length}>`;
  } else if (typeof v === "object" && v !== null) {
    summary[k] = Object.fromEntries(
      Object.entries(v).map(([ik, iv]) => [
        ik,
        typeof iv === "string" && iv.length > 40 ? `<string len=${iv.length}>` : iv,
      ]),
    );
  } else {
    summary[k] = v;
  }
}
console.log("desktop_bootstrap:", JSON.stringify(summary, null, 2));

const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400));
console.log("body text head:", JSON.stringify(bodyText));

await page.screenshot({ path: ".tmp-ui-polish/dev-window-live.png" });
console.log("screenshot saved: .tmp-ui-polish/dev-window-live.png");
await browser.close();
