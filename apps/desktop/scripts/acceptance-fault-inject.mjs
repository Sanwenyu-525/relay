// Test-infrastructure-only transport fault injection for real Windows acceptance.
// It connects to the packaged WebView2 through its CDP debugging port and uses the
// DevTools Fetch domain to fail a bounded number of matching HTTP requests, so the
// coordinator can separate "request never submitted" from "submitted but response lost":
//   --stage request  : fail before the request leaves the client; the server never
//                      receives it (no command record, no binding fact).
//   --stage response : let the server finish and answer, print the URL/method/postData
//                      (contains command_id) and the server status code, hold a
//                      verification window (--hold-ms), then fail the client response;
//                      the server has committed while the client sees a network error.
// After --count hits the interceptor removes itself (Fetch.disable) and the script
// closes only its own CDP connection; every non-matching request is untouched and the
// transport returns to normal. This script never touches app source, the database, or
// the desktop process. Structured JSON logs go to stdout and output/acceptance-raw/.
import { createRequire } from 'node:module';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage: node acceptance-fault-inject.mjs
  --cdp-port <1-65535>            required; WebView2 remote debugging port
  --url-pattern <glob>            required to arm; e.g. */assist-sessions/*/binding
                                    or */runs/*/control-requests (must not match
                                    GET receipts: /commands/:id, GET /assist-sessions/:id)
  --stage <request|response>      required to arm; where the failure is injected
  --count <n>                     hits before auto-disarm (default 1)
  --method <HTTP method>          only this method is failed, others pass through
                                    even when the URL pattern matches (default POST)
  --hold-ms <ms>                  response-stage verification window before
                                    failRequest (default 2000)
  --wait-timeout <ms>             how long to wait for the tauri.localhost page
                                    (default 120000)
  --arm-timeout <ms>              how long interception stays armed without reaching
                                    --count before disarming with exit code 3
                                    (default 120000)
  --log-dir <dir>                 evidence root; a timestamped run subdirectory is
                                    created inside (default <workspace>/output/acceptance-raw)
  --print-connection              print {baseUrl, workspaceId} from desktop_bootstrap
                                    (never prints the bearer token)
  --probe <url>                   self-test: after arming, run one fetch from the page
                                    context, expect it rejected by the interceptor
  --probe-method <HTTP method>    default POST
  --probe-body <json>             default {"command_id":"<uuid>","project_id":"<uuid>"}
Exit codes: 0 ok; 2 usage; 3 armed but never reached --count before --arm-timeout;
4 could not reach the WebView2 debugging port or page.`;

function fail(code, message) { console.error(message); console.error(USAGE); process.exit(code); }

const args = { method: 'POST', count: 1, 'hold-ms': 2000, 'wait-timeout': 120000,
  'arm-timeout': 120000, 'probe-method': 'POST' };
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith('--')) fail(2, `Unexpected argument: ${token}`);
  const key = token.slice(2);
  const flagOnly = ['print-connection'];
  if (flagOnly.includes(key)) { args[key] = true; continue; }
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) fail(2, `Missing value for --${key}`);
  args[key] = value; i += 1;
}
const cdpPort = Number(args['cdp-port']);
const urlPattern = args['url-pattern'];
const stage = args.stage;
const count = Number(args.count);
const method = String(args.method).toUpperCase();
const holdMs = Number(args['hold-ms']);
const waitTimeout = Number(args['wait-timeout']);
const armTimeout = Number(args['arm-timeout']);
const probeUrl = args.probe;
const probeMethod = String(args['probe-method']).toUpperCase();
const probeBody = args['probe-body'] ??
  JSON.stringify({ command_id: randomUUID(), project_id: randomUUID() });
if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) fail(2, 'Invalid --cdp-port');
if (!Number.isInteger(count) || count < 1 || count > 64) fail(2, 'Invalid --count');
if (!Number.isInteger(holdMs) || holdMs < 0 || holdMs > 600000) fail(2, 'Invalid --hold-ms');
if (!Number.isInteger(waitTimeout) || waitTimeout < 1000) fail(2, 'Invalid --wait-timeout');
if (!Number.isInteger(armTimeout) || armTimeout < 1000) fail(2, 'Invalid --arm-timeout');
const arming = urlPattern !== undefined || stage !== undefined;
if (arming) {
  if (typeof urlPattern !== 'string' || urlPattern.length === 0) fail(2, 'Arming requires --url-pattern');
  if (stage !== 'request' && stage !== 'response') fail(2, '--stage must be request or response');
  if (method === 'GET' && stage === 'response') {
    // GET has no body worth holding; still allowed, just unusual for acceptance.
  }
} else if (!args['print-connection'] && !probeUrl) {
  fail(2, 'Nothing to do: provide --url-pattern + --stage, or --print-connection, or --probe');
}
if (probeUrl && !arming) fail(2, '--probe requires arming (--url-pattern + --stage)');
if (probeUrl !== undefined && !/^https?:\/\//u.test(probeUrl)) fail(2, '--probe must be an absolute http(s) URL');

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, '..', '..', '..');
const runDir = join(args['log-dir'] ? resolve(args['log-dir']) : join(workspaceRoot, 'output', 'acceptance-raw'),
  `fault-inject-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`);
mkdirSync(runDir, { recursive: true });
const logPath = join(runDir, 'events.jsonl');
function log(record) {
  const line = JSON.stringify({ ...record, ts: new Date().toISOString() });
  console.log(line);
  appendFileSync(logPath, `${line}\n`, 'utf8');
}
log({ event: 'start', cdp_port: cdpPort, arming, url_pattern: urlPattern ?? null, stage: stage ?? null,
  count, method, hold_ms: holdMs, probe: probeUrl ?? null, log_dir: runDir });

const requireWorkbench = createRequire(new URL('../../workbench/package.json', import.meta.url));
const { chromium } = requireWorkbench('@playwright/test');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const PAGE_PATTERN = /^http:\/\/tauri\.localhost(?:\/|$)/u;

// Wait for the packaged window to exist and finish loading before arming anything.
const started = Date.now();
let browser = null;
let page = null;
while (Date.now() - started < waitTimeout) {
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 1500 });
    const candidate = browser.contexts().flatMap((context) => context.pages())
      .find((item) => PAGE_PATTERN.test(item.url()));
    if (candidate) { page = candidate; break; }
    await browser.close().catch(() => {});
    browser = null;
  } catch { /* WebView not listening yet; retry until the deadline. */ }
  await sleep(500);
}
if (!page) {
  log({ event: 'error', detail: 'tauri.localhost page not found before wait-timeout' });
  if (browser) await browser.close().catch(() => {});
  process.exit(4);
}
log({ event: 'page_ready', url: page.url(), elapsed_ms: Date.now() - started });

if (args['print-connection']) {
  const connection = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('desktop_bootstrap'));
  // baseUrl and workspaceId are safe to print; the bearer token never leaves the page.
  log({ event: 'connection', base_url: connection.baseUrl, workspace_id: connection.workspaceId });
}

let exitCode = 0;
if (arming) {
  const context = page.context();
  const session = await context.newCDPSession(page);
  const requestStage = stage === 'request' ? 'Request' : 'Response';
  await session.send('Fetch.enable', { patterns: [{ urlPattern, requestStage }] });
  log({ event: 'armed', stage, url_pattern: urlPattern, method, count });

  let hits = 0;
  let armed = true;
  let reachCount;
  const reached = new Promise((done) => { reachCount = done; });
  session.on('Fetch.requestPaused', async (event) => {
    const { requestId, request, responseStatusCode } = event;
    try {
      if (request.method.toUpperCase() !== method) {
        log({ event: 'bypass', url: request.url, method: request.method,
          reason: 'method filter' });
        if (requestStage === 'Request') await session.send('Fetch.continueRequest', { requestId });
        else await session.send('Fetch.continueResponse', { requestId });
        return;
      }
      hits += 1;
      // The printed postData is exactly what the workbench submitted (contains command_id).
      log({ event: 'hit', n: hits, stage, url: request.url, method: request.method,
        post_data: request.postData ?? null,
        response_status_code: responseStatusCode ?? null });
      if (stage === 'response' && holdMs > 0) {
        // Verification window: the server already answered (and committed), the client
        // still has no result. Coordinator can check the server side right now.
        await sleep(holdMs);
      }
      await session.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
      log({ event: 'failed_request', n: hits, error_reason: 'Failed' });
      if (hits >= count && armed) {
        armed = false;
        await session.send('Fetch.disable');
        log({ event: 'disarmed', reason: 'count reached', hits });
        reachCount();
      }
    } catch (error) {
      log({ event: 'handler_error', detail: error instanceof Error ? error.message : String(error) });
    }
  });

  async function runProbe(attempt) {
    const result = await page.evaluate(async ({ url, m, body }) => {
      try {
        const response = await fetch(url, { method: m,
          headers: { 'content-type': 'application/json',
            authorization: 'Bearer acceptance-fault-inject-probe-not-valid' },
          body: m === 'GET' || m === 'HEAD' ? undefined : body });
        const text = await response.text();
        return { rejected: false, status: response.status, bodyPreview: text.slice(0, 300) };
      } catch (error) {
        return { rejected: true, error: error instanceof Error ? error.message : String(error) };
      }
    }, { url: probeUrl, m: probeMethod, body: probeBody });
    log({ event: 'probe_result', attempt, url: probeUrl, method: probeMethod, ...result });
    return result;
  }

  if (probeUrl) await runProbe(1);
  const outcome = await Promise.race([
    reached.then(() => 'count'),
    sleep(armTimeout).then(() => 'timeout'),
  ]);
  if (outcome === 'timeout') {
    armed = false;
    await session.send('Fetch.disable').catch(() => {});
    log({ event: 'disarmed', reason: 'arm-timeout', hits });
    exitCode = 3;
  }
  if (probeUrl && exitCode === 0) {
    // Interceptor is disarmed now: the same request must go through normally,
    // which also proves the server itself is alive and answering.
    const second = await runProbe(2);
    if (!second.rejected) log({ event: 'transport_restored', status: second.status });
    else { log({ event: 'transport_not_restored', error: second.error }); exitCode = 5; }
  }
} else {
  log({ event: 'done', detail: 'connection mode only' });
}

await browser.close().catch(() => {});
log({ event: 'exit', code: exitCode, log_path: logPath });
process.exit(exitCode);
