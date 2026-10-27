// Real Windows-WebView2 negative tests for the child preview webview (P0-2).
//
// Attach to the already-running, CDP-instrumented session started by
// scripts/start-acceptance-session.ps1. The main workbench opens one child preview
// webview onto a loopback probe page; that page runs the negative checks from inside
// real WebView2 and posts the report back here. This script does not start, close or
// modify the product and never prints bootstrap values.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const sessionRoot = resolve(process.argv[2] ?? '');
const port = Number(process.argv[3]);
if (!/^relay-m02-acceptance-[0-9a-f]{32}$/i.test(sessionRoot.split(/[\\/]/).at(-1) ?? '') ||
    !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Usage: node check-preview-boundary.mjs <session-root> <CDP-port>');
}

const session = JSON.parse((await readFile(join(sessionRoot, 'session.json'), 'utf8')).replace(/^\uFEFF/, ''));
const releaseHash = createHash('sha256').update(await readFile(session.release_exe)).digest('hex');
if (releaseHash !== session.release_sha256 || !Number.isInteger(session.desktop_pid) || session.desktop_pid <= 0) {
  throw new Error('Session marker and release executable do not match');
}

const requireWorkbench = createRequire(new URL('../../workbench/package.json', import.meta.url));
const { chromium } = requireWorkbench('@playwright/test');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const token = `relay-security-probe-${createHash('sha256').update(`${sessionRoot}:${Date.now()}`).digest('hex').slice(0, 16)}`;

function probePageScript() {
  return `(() => {
  const checks = [];
  const record = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const errorName = (error) => (error && error.name) || String(error);
  const permissionState = async (name) => {
    try { return (await navigator.permissions.query({ name })).state; } catch { return 'unsupported'; }
  };
  async function run() {
    const internals = window.__TAURI_INTERNALS__;
    record('ipc-internals-present', true, { present: typeof internals === 'object' && internals !== null,
      global: typeof window.__TAURI__, bridge: typeof (window.ipc && window.ipc.postMessage) });
    if (internals && typeof internals.invoke === 'function') {
      try { const value = await internals.invoke('desktop_bootstrap');
        record('ipc-bootstrap-denied', false, { keys: Object.keys(value || {}) });
      } catch (error) { record('ipc-bootstrap-denied', true, { error: String(error).slice(0, 260) }); }
      try { await internals.invoke('preview_open', { scope: 'security-probe-evil',
        url: 'https://example.com/', bounds: { x: 0, y: 0, width: 40, height: 40 } });
        record('ipc-preview-denied', false, 'preview_open succeeded from the preview webview');
      } catch (error) { record('ipc-preview-denied', true, { error: String(error).slice(0, 260) }); }
    } else {
      record('ipc-bootstrap-denied', true, 'no Tauri internals injected');
      record('ipc-preview-denied', true, 'no Tauri internals injected');
    }
    try {
      const frame = document.createElement('iframe');
      frame.src = '/frame.html';
      document.body.appendChild(frame);
      await new Promise((done) => { frame.onload = done; setTimeout(done, 3000); });
      const inner = frame.contentWindow && frame.contentWindow.__TAURI_INTERNALS__;
      record('iframe-ipc-absent', !inner, { present: !!inner });
    } catch (error) { record('iframe-ipc-absent', false, errorName(error)); }
    const popup = window.open('https://example.com/relay-popup-probe');
    await sleep(500);
    record('popup-denied', popup === null, { returned: popup === null ? 'null' : String(popup) });
    try {
      const anchor = document.createElement('a');
      anchor.href = '/download-probe';
      anchor.download = '${token}.txt';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      record('download-requested', true, 'clicked download link');
    } catch (error) { record('download-requested', false, errorName(error)); }
    await sleep(500);
    let notification = 'unsupported';
    try { notification = await Notification.requestPermission(); } catch (error) { notification = errorName(error); }
    record('permission-notifications-denied', notification === 'denied',
      { request: notification, state: await permissionState('notifications') });
    const media = await (async () => {
      try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
        return { resolved: true, name: 'granted' };
      } catch (error) { return { resolved: false, name: errorName(error), message: String(error).slice(0, 160) }; }
    })();
    record('permission-microphone-denied', media.name === 'NotAllowedError', { ...media, state: await permissionState('microphone') });
    const geolocation = await new Promise((done) => {
      const timer = setTimeout(() => done({ code: null, name: 'timeout' }), 5000);
      navigator.geolocation.getCurrentPosition(
        () => { clearTimeout(timer); done({ code: 0, name: 'granted' }); },
        (error) => { clearTimeout(timer); done({ code: error.code, name: 'denied' }); });
    });
    record('permission-geolocation-denied', geolocation.code === 1, { ...geolocation, state: await permissionState('geolocation') });
    const clipboard = await (async () => {
      try { await navigator.clipboard.readText(); return 'granted'; }
      catch (error) { return errorName(error); }
    })();
    record('permission-clipboard-denied', clipboard !== 'granted', { result: clipboard });
    const hrefBefore = location.href;
    for (const target of ['http://tauri.localhost/', 'http://ipc.localhost/ipc',
      'http://127.0.0.1:5173/', 'https://example.com/relay-nav-probe']) {
      location.href = target;
      await sleep(700);
      const stayed = location.href === hrefBefore;
      record('navigation-blocked:' + target, stayed, { href: location.href });
      if (!stayed) break;
    }
    await fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ checks, href: location.href, userAgent: navigator.userAgent }) });
  }
  run().catch((error) => {
    checks.push({ name: 'probe-script', pass: false, detail: String(error) });
    fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ checks, href: location.href, userAgent: navigator.userAgent }) }).catch(() => {});
  });
})();`;
}

function startProbeServer() {
  let resolveReport;
  const report = new Promise((done) => { resolveReport = done; });
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method === 'POST' && path === '/report') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      response.writeHead(204).end();
      try { resolveReport(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* keep waiting */ }
      return;
    }
    if (path === '/download-probe') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${token}.txt"` }).end('relay download probe');
      return;
    }
    if (path === '/frame.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<!doctype html><meta charset="utf-8"><title>relay probe frame</title><body>frame</body>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
      `<!doctype html><meta charset="utf-8"><title>Relay 安全负向探针</title><body>relay security probe</body><script>${probePageScript()}</script>`);
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, report, port: server.address().port })));
}

async function waitForReport(report, deadline) {
  let done = false;
  let value;
  report.then((result) => { done = true; value = result; });
  while (Date.now() < deadline) {
    if (done) return value;
    await sleep(250);
  }
  return undefined;
}

const { server, report, port: probePort } = await startProbeServer();
const probeUrl = `http://127.0.0.1:${probePort}/`;
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const checks = [];
const record = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 240)}`}`);
};
let snapshot;
try {
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => /^http:\/\/tauri\.localhost(?:\/|$)/.test(candidate.url()));
  if (!page) throw new Error('The packaged workbench WebView was not found');
  await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function', null, { timeout: 60_000 });

  const opened = await page.evaluate(async (url) => {
    try {
      return { ok: true, value: await window.__TAURI_INTERNALS__.invoke('preview_open', {
        scope: 'security-probe', url, bounds: { x: 24, y: 96, width: 720, height: 520 } }) };
    } catch (error) { return { ok: false, error: String(error).slice(0, 260) }; }
  }, probeUrl);
  record('preview-open', opened.ok, opened.ok ? { id: opened.value.id } : opened);
  if (opened.ok) snapshot = opened.value;

  const reported = opened.ok ? await waitForReport(report, Date.now() + 90_000) : undefined;
  if (reported) for (const entry of reported.checks) checks.push(entry);
  else record('probe-report', false, 'the preview page did not post its report');

  const downloadsDir = join(homedir(), 'Downloads');
  let downloaded = false;
  if (existsSync(downloadsDir)) {
    downloaded = (await readdir(downloadsDir)).some((name) => name === `${token}.txt`);
    if (downloaded) await rm(join(downloadsDir, `${token}.txt`), { force: true });
  }
  record('download-denied', reported !== undefined && !downloaded, { found: downloaded });

  const pagesBefore = browser.contexts().flatMap((context) => context.pages()).length;
  const popup = await page.evaluate(() => {
    const openedWindow = window.open('https://example.com/relay-main-popup-probe');
    return openedWindow === null ? 'null' : String(openedWindow);
  });
  await sleep(700);
  const pagesAfter = browser.contexts().flatMap((context) => context.pages()).length;
  record('main-popup-denied', popup === 'null' && pagesAfter === pagesBefore, { popup, pagesBefore, pagesAfter });

  const origin = page.url();
  await page.evaluate(() => { location.href = 'https://example.com/relay-main-nav-probe'; }).catch(() => {});
  await sleep(1200);
  record('main-navigation-blocked', page.url() === origin, { url: page.url() });
} catch (error) {
  record('harness', false, String(error));
} finally {
  if (snapshot) {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => /^http:\/\/tauri\.localhost(?:\/|$)/.test(candidate.url()));
    if (page) await page.evaluate(async (handle) => window.__TAURI_INTERNALS__
      .invoke('preview_close', { handle }), { id: snapshot.id, generation: snapshot.generation }).catch(() => {});
  }
  await browser.close().catch(() => {});
  server.close();
}

const failed = checks.filter((check) => !check.pass);
const summary = Object.fromEntries(checks.map((check) => [check.name, check.pass ? 'blocked/pass' : 'FAILED']));
console.log(`release_sha256=${releaseHash}`);
console.log(`preview_checks=${checks.length - failed.length}/${checks.length}`);
for (const [name, value] of Object.entries(summary)) {
  if (!name.startsWith('navigation-blocked:') && name !== 'preview-open' && name !== 'ipc-internals-present' &&
      name !== 'download-requested' && name !== 'main-bootstrap') console.log(`${name}=${value}`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
