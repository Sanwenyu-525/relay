import { createServer, request } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const expectedOrigin = 'http://tauri.localhost';
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

const configLine = await new Promise((resolve) => input.once('line', resolve));
const config = JSON.parse(configLine);

if (
  typeof config !== 'object' ||
  config === null ||
  typeof config.token !== 'string' ||
  typeof config.expectedOrigin !== 'string'
) {
  process.stderr.write('P00 sidecar did not receive a valid private bootstrap payload.\n');
  process.exit(1);
}

const token = config.token;
const allowedOrigin = config.expectedOrigin;
const workerNonce = randomBytes(32).toString('hex');
const worker = spawn(process.execPath, [fileURLToPath(new URL('./fake-worker.mjs', import.meta.url))], {
  stdio: ['pipe', 'pipe', 'ignore'],
});
worker.stdin.write(`${JSON.stringify({ instance_nonce: workerNonce })}\n`);
const workerExit = new Promise((resolve) => {
  worker.once('exit', (code) => resolve(code));
});
const workerInstanceValid = await new Promise((resolve, reject) => {
  let output = '';
  worker.stdout.setEncoding('utf8');
  worker.stdout.on('data', (chunk) => {
    output += chunk;
    const newline = output.indexOf('\n');
    if (newline === -1) {
      if (output.length > 4096) {
        reject(new Error('FakeWorker readiness exceeded the P00 limit'));
      }
      return;
    }
    const line = output.slice(0, newline);
    try {
      const readiness = JSON.parse(line);
      if (readiness?.type !== 'ready' || readiness.instance_nonce !== workerNonce) {
        reject(new Error('FakeWorker readiness did not identify this sidecar instance'));
        return;
      }
      resolve(true);
    } catch {
      reject(new Error('FakeWorker sent invalid readiness data'));
    }
  });
  worker.once('error', reject);
  worker.once('exit', () => reject(new Error('FakeWorker exited before readiness')));
});
let server;
let stopping = false;

function tokenMatches(value) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(value ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function respond(response, statusCode, body, origin) {
  const headers = {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  };
  if (origin === allowedOrigin) {
    headers['access-control-allow-origin'] = allowedOrigin;
    headers.vary = 'Origin';
  }
  response.writeHead(statusCode, headers);
  response.end(JSON.stringify(body));
}

function respondPreflight(response, origin) {
  response.writeHead(204, {
    'access-control-allow-headers': 'authorization',
    'access-control-allow-methods': 'GET',
    'access-control-allow-origin': allowedOrigin,
    'access-control-max-age': '0',
    vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  });
  response.end();
}

function expectedHost(port) {
  return `127.0.0.1:${port}`;
}

function requestStatus(port, headers) {
  return new Promise((resolve, reject) => {
    const probe = request(
      {
        headers,
        host: '127.0.0.1',
        method: 'GET',
        path: '/p00/handshake',
        port,
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      },
    );
    probe.once('error', reject);
    probe.end();
  });
}

async function runNegativeProbes(port) {
  const host = expectedHost(port);
  const [noTokenStatus, badHostStatus, badOriginStatus] = await Promise.all([
    requestStatus(port, { Host: host, Origin: allowedOrigin }),
    requestStatus(port, {
      Authorization: `Bearer ${token}`,
      Host: `localhost:${port}`,
      Origin: allowedOrigin,
    }),
    requestStatus(port, {
      Authorization: `Bearer ${token}`,
      Host: host,
      Origin: 'https://wrong-origin.invalid',
    }),
  ]);
  return {
    bad_host_status: badHostStatus,
    bad_origin_status: badOriginStatus,
    no_token_status: noTokenStatus,
  };
}

async function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  worker.stdin.end('shutdown\n');
  const workerStopped = await Promise.race([
    workerExit.then((code) => code === 0),
    new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  server.close(() => process.exit(workerStopped ? 0 : 1));
  setTimeout(() => process.exit(1), 1_500).unref();
}

input.on('line', (line) => {
  if (line === 'shutdown') {
    void stop();
  }
});

server = createServer((req, response) => {
  const port = server.address().port;
  const origin = req.headers.origin;

  if (req.url !== '/p00/handshake') {
    respond(response, 404, { error: 'not_found' }, origin);
    return;
  }
  if (req.headers.host !== expectedHost(port)) {
    respond(response, 421, { error: 'wrong_host' }, origin);
    return;
  }
  if (origin !== allowedOrigin) {
    respond(response, 403, { error: 'wrong_origin' }, origin);
    return;
  }
  if (req.method === 'OPTIONS') {
    const requestedHeaders = req.headers['access-control-request-headers'] ?? '';
    if (
      req.headers['access-control-request-method'] !== 'GET' ||
      !requestedHeaders
        .split(',')
        .map((header) => header.trim().toLowerCase())
        .includes('authorization')
    ) {
      respond(response, 403, { error: 'invalid_preflight' }, origin);
      return;
    }
    respondPreflight(response, origin);
    return;
  }
  if (req.method !== 'GET') {
    respond(response, 405, { error: 'method_not_allowed' }, origin);
    return;
  }
  if (!tokenMatches(req.headers.authorization)) {
    respond(response, 401, { error: 'unauthorized' }, origin);
    return;
  }

  respond(response, 200, { ready: true }, origin);
});

server.listen(0, '127.0.0.1', async () => {
  try {
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('sidecar did not receive a TCP address');
    }
    const verification = await runNegativeProbes(address.port);
    if (
      verification.no_token_status !== 401 ||
      verification.bad_host_status !== 421 ||
      verification.bad_origin_status !== 403
    ) {
      throw new Error('sidecar negative probes did not receive required statuses');
    }
    process.stdout.write(
      `${JSON.stringify({
        node_version: process.version,
        fake_worker_ready: true,
        worker_instance_valid: workerInstanceValid,
        port: address.port,
        type: 'ready',
        verification,
      })}\n`,
    );
  } catch {
    process.stderr.write('P00 sidecar startup verification failed.\n');
    process.exit(1);
  }
});
