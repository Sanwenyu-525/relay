// Exercise the same Tauri destroy command used after the React close confirmation.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
const port = Number(process.argv[3]);
if (!/^relay-m02-acceptance-[0-9a-f]{32}$/i.test(root.split(/[\\/]/).at(-1) ?? '') ||
    !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Usage: node close-session-window.mjs <session-root> <CDP-port>');
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
  await pages[0].evaluate(() => { void window.__TAURI_INTERNALS__.invoke('plugin:window|destroy', { label: 'main' }); });
  console.log(`release_sha256=${hash} destroy_requested=true`);
} finally { await browser.close().catch(() => undefined); }
