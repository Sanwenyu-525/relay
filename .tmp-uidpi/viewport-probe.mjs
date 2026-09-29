import { chromium } from "@playwright/test";
const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
const p = b.contexts()[0].pages().find((x) => x.url().startsWith("http://tauri.localhost"));
console.log(JSON.stringify(await p.evaluate(() => ({ dpr: window.devicePixelRatio, inner: `${window.innerWidth}x${window.innerHeight}`, screen: `${screen.width}x${screen.height}` }))));
await b.close();
