// Wait for the packaged window after supervisor recovery; never print its bearer.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const port = Number(process.argv[2]);
const timeoutMs = Number(process.argv[3] ?? '180000');
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 600000);
const requireWorkbench = createRequire(new URL('../../workbench/package.json', import.meta.url));
const { chromium } = requireWorkbench('@playwright/test');
const started = Date.now();
const deadline = started + timeoutMs;
let lastError = 'WebView not ready';
let ready = false;
while (Date.now() < deadline) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1500 });
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => /^http:\/\/tauri\.localhost(?:\/|$)/u.test(candidate.url()));
    if (!page) throw new Error('packaged main frame absent');
    const accepted = await page.evaluate(async () => {
      const connection = await window.__TAURI_INTERNALS__.invoke('desktop_bootstrap');
      return /^http:\/\/127\.0\.0\.1:\d+$/u.test(connection.baseUrl) &&
        typeof connection.workspaceId === 'string' &&
        /^[0-9a-f]{64}$/u.test(connection.bearerToken);
    });
    assert.equal(accepted, true, 'desktop bootstrap rejected after supervisor recovery');
    console.log(JSON.stringify({ packaged_bootstrap: 'ready', elapsed_ms: Date.now() - started }));
    ready = true;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  if (ready) break;
  await new Promise((done) => setTimeout(done, 250));
}
if (!ready) throw new Error(`Desktop readiness timed out: ${lastError}`);
