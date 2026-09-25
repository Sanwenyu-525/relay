// Attach to a disposable, CDP-instrumented WebView2 session of the exact release exe.
// This file does not launch or modify the product and never prints bootstrap values.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const sessionRoot = resolve(process.argv[2] ?? '');
const port = Number(process.argv[3]);
if (!/^relay-m02-acceptance-[0-9a-f]{32}$/i.test(sessionRoot.split(/[\\/]/).at(-1) ?? '') ||
    !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Usage: node check-webview-boundary.mjs <session-root> <CDP-port>');
}

const session = JSON.parse(readFileSync(join(sessionRoot, 'session.json'), 'utf8').replace(/^\uFEFF/, ''));
const releaseHash = createHash('sha256').update(readFileSync(session.release_exe)).digest('hex');
if (releaseHash !== session.release_sha256 || !Number.isInteger(session.desktop_pid) || session.desktop_pid <= 0) {
  throw new Error('Session marker and release executable do not match');
}

const requireWorkbench = createRequire(new URL('../../workbench/package.json', import.meta.url));
const { chromium } = requireWorkbench('@playwright/test');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
const pages = browser.contexts().flatMap((context) => context.pages())
  .filter((page) => /^http:\/\/tauri\.localhost(?:\/|$)/.test(page.url()));
if (pages.length !== 1) throw new Error(`Expected one packaged WebView, found ${pages.length}`);
const page = pages[0];
await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');

const bootstrap = await page.evaluate(async () => {
  try {
    const result = await window.__TAURI_INTERNALS__.invoke('desktop_bootstrap');
    return {
      valid: /^http:\/\/127\.0\.0\.1:\d+$/.test(result.baseUrl) &&
        typeof result.workspaceId === 'string' &&
        typeof result.bearerToken === 'string' && result.bearerToken.length === 64,
      baseUrl: result.baseUrl,
    };
  } catch { return { valid: false, baseUrl: '' }; }
});
if (!bootstrap.valid) throw new Error('Packaged main-frame bootstrap failed');

const response = await page.reload({ waitUntil: 'domcontentloaded' });
const csp = response?.headers()['content-security-policy'] ?? '';
const connectSources = csp.match(/(?:^|;)\s*connect-src\s+([^;]+)/)?.[1] ?? '';
const actualConnect = connectSources.trim().split(/\s+/).sort();
const expectedConnect = ["'self'", 'http://ipc.localhost', bootstrap.baseUrl].sort();
if (JSON.stringify(actualConnect) !== JSON.stringify(expectedConnect) ||
    !/(?:^|;)\s*frame-src\s+'none'(?:;|$)/.test(csp) ||
    !/(?:^|;)\s*script-src\s+'self'/.test(csp)) {
  throw new Error('The actual packaged HTML CSP omitted a required source or restriction');
}
await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
const reloadBootstrap = await page.evaluate(async () => {
  try {
    const result = await window.__TAURI_INTERNALS__.invoke('desktop_bootstrap');
    return typeof result.bearerToken === 'string' && result.bearerToken.length === 64;
  } catch { return false; }
});
if (!reloadBootstrap) throw new Error('Reloaded main-frame bootstrap failed');

const unknownRejected = await page.evaluate(async () => {
  try { await window.__TAURI_INTERNALS__.invoke('__relay_m02_unknown_command__'); return false; }
  catch { return true; }
});
if (!unknownRejected) throw new Error('Unknown IPC command unexpectedly succeeded');
const unauthorizedCoreRejected = await page.evaluate(async () => {
  try { await window.__TAURI_INTERNALS__.invoke('plugin:window|title', { label: 'main' }); return false; }
  catch { return true; }
});
if (!unauthorizedCoreRejected) throw new Error('Unpermitted core window title command succeeded');

await page.evaluate(() => { window.location.assign('https://relay-invalid.invalid/'); });
await new Promise((resolve) => setTimeout(resolve, 700));
if (!/^http:\/\/tauri\.localhost(?:\/|$)/.test(page.url())) {
  throw new Error('Remote top-level navigation was not rejected');
}

const frameResult = await page.evaluate(async () => {
  const frame = document.createElement('iframe');
  frame.src = 'about:blank';
  document.body.append(frame);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const invoke = frame.contentWindow?.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') return 'no_bridge';
  return Promise.race([
    invoke('desktop_bootstrap').then(() => 'leaked', () => 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 1500)),
  ]);
});
if (frameResult !== 'no_bridge' && frameResult !== 'rejected') {
  throw new Error(`Child-frame bootstrap was not rejected: ${frameResult}`);
}
const taintedMainRejected = await page.evaluate(async () => {
  try { await window.__TAURI_INTERNALS__.invoke('desktop_bootstrap'); return false; }
  catch { return true; }
});
if (!taintedMainRejected) throw new Error('Main bootstrap remained available after child-frame creation');

console.log(`release_sha256=${releaseHash}`);
console.log('packaged_bootstrap=pass reload_bootstrap=pass actual_csp=pass unknown_ipc=pass unpermitted_core_ipc=blocked remote_navigation=blocked');
console.log(`child_frame=${frameResult} post_frame_bootstrap=blocked`);
} finally {
  // Playwright documents close() on a connected Browser as disconnecting from its server.
  // No context was created by this probe, so this leaves the product WebView running.
  await browser.close();
}
