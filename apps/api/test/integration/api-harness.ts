import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeWorkspace } from '../../src/application/initialize-workspace.js';
import type { DbExecutor } from '../../src/infrastructure/database.js';

/**
 * P02 及后续 HTTP 集成测试共用基建：真实临时 PostgreSQL 集群（由 run-integration.ps1 建立）
 * + 真实监听端口上的真实 API 进程。测试通过 HTTP 断言契约，不走 Mock DB。
 */

const API_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'main.js');
const STARTUP_TIMEOUT_MS = 15000;
const EXIT_TIMEOUT_MS = 10000;
const PROBE_INTERVAL_MS = 100;

export function requireTestDatabaseUrl(): string {
  const value = process.env.RELAY_TEST_DATABASE_URL?.trim();

  if (value === undefined || value === '') {
    throw new Error(
      'RELAY_TEST_DATABASE_URL is required: run "pnpm run test:integration" so the wrapper can build the temporary PostgreSQL cluster',
    );
  }

  return value;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
  readonly body: unknown;
}

export interface RunningApi {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exit: Promise<number | null>;
  readOutput: () => string;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

export function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    work,
    delay(timeoutMs).then(() => {
      throw new Error(`timed out after ${timeoutMs}ms while waiting for ${label}`);
    }),
  ]);
}

export function pickFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createTcpServer();

    probe.on('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();

      if (address === null || typeof address === 'string') {
        probe.close();
        rejectPort(new Error('could not determine a free loopback port'));
        return;
      }

      const port = address.port;
      probe.close(() => {
        resolvePort(port);
      });
    });
  });
}

export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const probe = createTcpServer();

    probe.on('error', () => {
      resolveFree(false);
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => {
        resolveFree(true);
      });
    });
  });
}

export interface SendOptions {
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly host?: string;
  readonly origin?: string;
  /** 直接发送字符串 body（用于非法 JSON 等负例）。 */
  readonly rawBody?: string;
}

export function sendRequest(
  port: number,
  method: 'GET' | 'POST' | 'PATCH' | 'OPTIONS',
  path: string,
  options: SendOptions = {},
): Promise<HttpResponse> {
  return new Promise((resolveResponse, rejectResponse) => {
    const headers: Record<string, string> = {
      host: options.host ?? `127.0.0.1:${port}`,
      ...options.headers,
    };

    if (options.origin !== undefined) {
      headers.origin = options.origin;
    }

    const payload =
      options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));

    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload).toString();
    }

    const request = httpRequest(
      { host: '127.0.0.1', port, method, path, agent: false, headers },
      (response) => {
        const chunks: Buffer[] = [];

        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown;

          try {
            body = JSON.parse(text) as unknown;
          } catch {
            body = undefined;
          }

          resolveResponse({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text,
            body,
          });
        });
      },
    );

    request.on('error', rejectResponse);

    if (payload !== undefined) {
      request.write(payload);
    }

    request.end();
  });
}

export function startApi(env: Record<string, string | undefined>): RunningApi {
  const child = spawn(process.execPath, [API_ENTRY], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });

  const exit = new Promise<number | null>((resolveExit) => {
    child.on('exit', (code) => {
      resolveExit(code);
    });
  });

  return { child, exit, readOutput: () => output };
}

export async function waitForLiveness(api: RunningApi, port: number): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await sendRequest(port, 'GET', '/health/live');

      if (response.status === 200) {
        return;
      }
    } catch {
      // 服务尚未开始监听
    }

    await delay(PROBE_INTERVAL_MS);
  }

  throw new Error(`the API did not become live within ${STARTUP_TIMEOUT_MS}ms:\n${api.readOutput()}`);
}

export async function stopApi(api: RunningApi): Promise<number | null> {
  api.child.stdin.end();

  return withTimeout(api.exit, EXIT_TIMEOUT_MS, 'the API process to exit after stdin closed');
}

export async function createDataRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'relay-api-integration-data-'));
}

export function baseEnvironment(input: {
  port: number;
  allowedOrigin: string;
  bearerToken: string;
  dataRoot: string;
  databaseUrl?: string;
}): Record<string, string | undefined> {
  return {
    ...process.env,
    RELAY_API_BIND_HOST: '127.0.0.1',
    RELAY_API_PORT: String(input.port),
    RELAY_API_ALLOWED_ORIGINS: input.allowedOrigin,
    RELAY_API_BEARER_TOKEN: input.bearerToken,
    RELAY_DB_URL: input.databaseUrl ?? requireTestDatabaseUrl(),
    RELAY_DB_POOL_MAX: '4',
    RELAY_DB_CONNECT_TIMEOUT_MS: '2000',
    RELAY_DATA_ROOT: input.dataRoot,
    RELAY_LOG_LEVEL: 'info',
    RELAY_API_STOP_ON_STDIN_EOF: 'true',
  };
}

export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: string;
  readonly request_id: string;
  readonly retryable: boolean;
  readonly retry_action: string;
  readonly field_errors?: readonly { readonly field: string; readonly message: string }[];
  readonly conflict?: Record<string, unknown>;
  readonly command_id?: string;
}

export interface CommandEnvelopeBody {
  readonly command_id: string;
  readonly committed_at: string;
  readonly result: Record<string, unknown>;
  readonly links: { readonly resource: string };
}

export function expectProblemJson(response: HttpResponse): void {
  const contentType = response.headers['content-type'];

  assert.equal(typeof contentType, 'string');
  assert.match(contentType as string, /^application\/problem\+json/u);
  assert.equal(response.text.includes('node_modules'), false);
  assert.equal(response.text.includes(' at '), false);
}

/** 断言 Problem Details 的结构与 code，并返回便于进一步断言的 body。 */
export function expectProblem(
  response: HttpResponse,
  status: number,
  code: string,
): ProblemBody {
  expectProblemJson(response);
  assert.equal(response.status, status, `expected status ${status}: ${response.text}`);

  const body = response.body as ProblemBody;

  assert.equal(body.code, code, `unexpected code: ${response.text}`);
  assert.equal(body.status, status);
  assert.equal(typeof body.request_id, 'string');
  assert.equal(body.instance, `/requests/${body.request_id}`);
  assert.equal(typeof body.retryable, 'boolean');
  assert.equal(typeof body.retry_action, 'string');
  assert.equal(response.text.includes('postgresql://'), false);
  assert.equal(response.text.includes('SELECT'), false);

  return body;
}

export interface TestApi {
  readonly port: number;
  readonly allowedOrigin: string;
  readonly bearerToken: string;
  readonly dataRoot: string;
  readonly running: RunningApi;
  request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options?: SendOptions,
  ): Promise<HttpResponse>;
  get(path: string, options?: SendOptions): Promise<HttpResponse>;
  post(path: string, body: unknown, options?: SendOptions): Promise<HttpResponse>;
  patch(path: string, body: unknown, options?: SendOptions): Promise<HttpResponse>;
  stop(): Promise<number | null>;
}

/** 启动一个真实 API 进程（真实监听端口 + 真实 PostgreSQL），并返回带默认 Host/Bearer 的客户端。 */
export async function startTestApi(options: { databaseUrl?: string } = {}): Promise<TestApi> {
  const port = await pickFreePort();
  const allowedOrigin = `http://127.0.0.1:${await pickFreePort()}`;
  const bearerToken = randomBytes(32).toString('hex');
  const dataRoot = await createDataRoot();
  const running = startApi(baseEnvironment({
    port, allowedOrigin, bearerToken, dataRoot, ...options,
  }));
  const authorization = { authorization: `Bearer ${bearerToken}` };

  await waitForLiveness(running, port);

  const request: TestApi['request'] = (method, path, options = {}) =>
    sendRequest(port, method, path, {
      ...options,
      headers: { ...authorization, ...options.headers },
    });

  return {
    port,
    allowedOrigin,
    bearerToken,
    dataRoot,
    running,
    request,
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, { ...options, body }),
    patch: (path, body, options) => request('PATCH', path, { ...options, body }),
    stop: async () => {
      const exitCode = await stopApi(running);

      await rm(dataRoot, { recursive: true, force: true });

      return exitCode;
    },
  };
}

export function workspacePath(workspaceId: string, suffix?: string): string {
  const base = `/api/v1/workspaces/${workspaceId}`;

  return suffix === undefined ? base : `${base}${suffix}`;
}

/** 用应用角色建立 Workspace（含 authority 行、审计与回执），作为 HTTP 测试的作用域。 */
export async function createWorkspace(db: DbExecutor): Promise<string> {
  const workspaceId = randomUUID();

  await initializeWorkspace(db, {
    workspaceId,
    name: `workspace-${workspaceId.slice(0, 8)}`,
    commandId: randomUUID(),
    actorRef: 'test:harness',
  });

  return workspaceId;
}

/** 断言命令回执结构，并返回命令结果。 */
export function expectCommandAccepted(
  response: HttpResponse,
  status: 200 | 201 | 202,
  commandId: string,
): Record<string, unknown> {
  assert.equal(response.status, status, `expected ${status}: ${response.text}`);

  const body = response.body as CommandEnvelopeBody;

  assert.equal(body.command_id, commandId);
  assert.match(body.committed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/u);
  assert.equal(typeof body.result, 'object');
  assert.match(body.links.resource, /^\/api\/v1\/workspaces\//u);

  return body.result;
}
