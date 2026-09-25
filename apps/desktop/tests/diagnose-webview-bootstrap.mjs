// CDP-only diagnosis of the exact release WebView; emits no bootstrap credential.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
const port = Number(process.argv[3]);
if (!/^relay-m02-acceptance-[0-9a-f]{32}$/i.test(root.split(/[\\/]/).at(-1) ?? '') ||
    !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Usage: node diagnose-webview-bootstrap.mjs <session-root> <CDP-port>');
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
  await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
  const result = await page.evaluate(async () => {
    let bootstrap;
    try { bootstrap = await window.__TAURI_INTERNALS__.invoke('desktop_bootstrap'); }
    catch (error) {
      const message = String(error).toLowerCase();
      const category = message.includes('frame') ? 'frame_guard'
        : message.includes('origin') ? 'origin_guard'
        : message.includes('no longer running') ? 'api_stopped'
        : message.includes('not allowed') || message.includes('permission') ? 'capability'
        : 'other';
      return { origin: location.origin, bootstrap: category, health: 'not_attempted' };
    }
    if (typeof bootstrap?.baseUrl !== 'string' || typeof bootstrap?.workspaceId !== 'string' ||
        typeof bootstrap?.bearerToken !== 'string') {
      return { origin: location.origin, bootstrap: 'invalid_shape', health: 'not_attempted' };
    }
    try {
      const response = await fetch(`${bootstrap.baseUrl}/health/ready`, {
        headers: { Authorization: `Bearer ${bootstrap.bearerToken}` },
      });
      const body = await response.json().catch(() => null);
      return { origin: location.origin, bootstrap: 'pass', health: response.status,
        readyBody: body?.status === 'ready' };
    } catch { return { origin: location.origin, bootstrap: 'pass', health: 'transport_rejected' }; }
  });
  const response = await page.reload({ waitUntil: 'domcontentloaded' });
  const csp = response?.headers()['content-security-policy'] ?? '';
  const connect = (csp.match(/(?:^|;)\s*connect-src\s+([^;]+)/)?.[1] ?? '').trim().split(/\s+/);
  console.log(`release_sha256=${hash}`);
  console.log(`page_origin=${result.origin} bootstrap=${result.bootstrap} health=${result.health} ready_body=${result.readyBody ?? 'n/a'}`);
  console.log(`html_csp_present=${Boolean(csp)} connect_sources=${connect.join(',')} frame_none=${/(?:^|;)\s*frame-src\s+'none'(?:;|$)/.test(csp)}`);
} finally { await browser.close(); }
