// Run after the exact bundled Node child of this disposable session has exited.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
const port = Number(process.argv[3]);
if (!/^relay-m02-acceptance-[0-9a-f]{32}$/i.test(root.split(/[\\/]/).at(-1) ?? '') ||
    !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Usage: node check-sidecar-exit.mjs <session-root> <CDP-port>');
}
const session = JSON.parse(readFileSync(join(root, 'session.json'), 'utf8').replace(/^\uFEFF/, ''));
const hash = createHash('sha256').update(readFileSync(session.release_exe)).digest('hex');
if (hash !== session.release_sha256) throw new Error('Release hash differs from session marker');
const requireWorkbench = createRequire(new URL('../../workbench/package.json', import.meta.url));
const { chromium } = requireWorkbench('@playwright/test');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const pages = browser.contexts().flatMap((context) => context.pages())
    .filter((page) => /^http:\/\/tauri\.localhost(?:\/|$)/.test(page.url()));
  if (pages.length !== 1) throw new Error(`Expected one packaged WebView, found ${pages.length}`);
  const page = pages[0];
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="desktop-service-unavailable"]').waitFor({ timeout: 10000 });
  const rejected = await page.evaluate(async () => {
    try { await window.__TAURI_INTERNALS__.invoke('desktop_bootstrap'); return false; }
    catch (error) { return String(error).includes('no longer running'); }
  });
  if (!rejected || await page.locator('[data-testid="relay-connection-open"], [data-testid="project-create-open"]').count() !== 0 ||
      (await page.locator('body').innerText()).includes('示例数据')) {
    throw new Error('Dead sidecar returned bootstrap or exposed the fixture workbench');
  }
  console.log(`release_sha256=${hash} dead_sidecar_bootstrap=blocked reload_page=blocked fixture_actions=absent`);
} finally { await browser.close(); }
