import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before } from 'node:test';

import { initializeWorkspace } from '../../src/application/initialize-workspace.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import {
  MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, createTemporaryDatabase, openDatabase,
} from './integration-support.js';
import {
  baseEnvironment, createDataRoot, portIsFree, sendRequest, withTimeout,
} from './api-harness.js';

const API_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'main.js');
const DATABASE_URL: string = (() => {
  const value = process.env.RELAY_TEST_DATABASE_URL;
  if (value === undefined) throw new Error('temporary PostgreSQL URL is required');
  return value;
})();

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
});

interface DesktopChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly port: number;
  readonly output: () => string;
  stop(): Promise<number | null>;
}

async function startDesktopChild(workspaceId: string, dataRoot: string, bearerToken: string): Promise<DesktopChild> {
  const nonce = randomBytes(16).toString('hex');
  const child = spawn(process.execPath, [API_ENTRY, '--desktop-child'], {
    env: {
      ...baseEnvironment({
        port: 8787, allowedOrigin: 'http://127.0.0.1:5173',
        bearerToken: 'a'.repeat(64), dataRoot, databaseUrl: DATABASE_URL,
      }),
      RELAY_DESKTOP_WORKSPACE_ID: workspaceId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  const ready = new Promise<{ port: number; workspaceId: string }>((resolveReady, rejectReady) => {
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      const lines = output.split('\n');
      for (const line of lines.slice(0, -1)) {
        let event: unknown;
        try { event = JSON.parse(line) as unknown; } catch { continue; }
        if (typeof event !== 'object' || event === null || !('nonce' in event) || event.nonce !== nonce) continue;
        if ('type' in event && event.type === 'desktop_error') {
          rejectReady(new Error(`desktop child rejected startup: ${String('code' in event ? event.code : '')}`));
          return;
        }
        if ('type' in event && event.type === 'desktop_ready' && 'port' in event && 'workspaceId' in event) {
          resolveReady({ port: Number(event.port), workspaceId: String(event.workspaceId) });
          return;
        }
      }
    });
    child.once('exit', (code) => rejectReady(new Error(`desktop child exited before readiness: ${code}`)));
  });
  child.stdin.write(`${JSON.stringify({ nonce, bearerToken })}\n`);
  const event = await withTimeout(ready, 20000, 'desktop private readiness');
  assert.equal(event.workspaceId, workspaceId);
  assert.ok(event.port > 1024);
  assert.equal(output.includes(bearerToken), false);
  assert.equal(output.includes(DATABASE_URL), false);
  assert.equal(stderr.includes(bearerToken), false);
  assert.equal(stderr.includes(DATABASE_URL), false);
  return {
    child, port: event.port, output: () => output,
    stop: async () => {
      const exit = new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));
      child.stdin.end();
      return withTimeout(exit, 10000, 'desktop child to close after pipe EOF');
    },
  };
}

async function rejectedDesktopChild(
  workspaceId: string, dataRoot: string, expectedCode: string,
  databaseUrl = DATABASE_URL, closeBeforeFrame = false,
): Promise<void> {
  const nonce = randomBytes(16).toString('hex');
  const bearerToken = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, [API_ENTRY, '--desktop-child'], {
    env: {
      ...baseEnvironment({
        port: 8787, allowedOrigin: 'http://127.0.0.1:5173',
        bearerToken: 'a'.repeat(64), dataRoot, databaseUrl,
      }),
      RELAY_DESKTOP_WORKSPACE_ID: workspaceId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.includes('"type":"desktop_error"')) child.stdin.end();
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  try {
    const closed = new Promise<number | null>((resolveClose) => child.once('close', resolveClose));
    if (closeBeforeFrame) child.stdin.end();
    else child.stdin.write(`${JSON.stringify({ nonce, bearerToken })}\n`);
    const exitCode = await withTimeout(closed, 20000, 'desktop rejection to close');
    assert.equal(exitCode, expectedCode === 'DESKTOP_STARTUP_INVALID' ? 2 : 1);
    const events = stdout.trim().split('\n').map((line) => JSON.parse(line) as {
      type: string; nonce: string; code: string;
    });
    assert.deepEqual(events, [{
      type: 'desktop_error', nonce: closeBeforeFrame ? '' : nonce, code: expectedCode,
    }]);
    assert.equal(stdout.includes(bearerToken), false);
    assert.equal(stdout.includes(databaseUrl), false);
    assert.equal(stderr.includes(bearerToken), false);
    assert.equal(stderr.includes(databaseUrl), false);
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
}

test('desktop child uses dynamic strict boundary, private readiness, EOF stop and rotating token', async () => {
  const dataRoot = await createDataRoot();
  const workspaceId = randomUUID();
  const db = openDatabase(DATABASE_URL, 'desktop-child-integration');
  let first: DesktopChild | undefined;
  let second: DesktopChild | undefined;
  try {
    await initializeWorkspace(db.db, {
      workspaceId, name: 'Desktop integration', commandId: randomUUID(), actorRef: 'test',
    });
    const firstToken = randomBytes(32).toString('hex');
    first = await startDesktopChild(workspaceId, dataRoot, firstToken);
    const port = first.port;
    const ready = await sendRequest(port, 'GET', '/health/ready', {
      origin: 'http://tauri.localhost',
      headers: { authorization: `Bearer ${firstToken}` },
    });
    assert.equal(ready.status, 200);
    assert.equal((await sendRequest(port, 'GET', '/health/ready')).status, 401);
    assert.equal((await sendRequest(port, 'GET', '/health/ready', {
      host: `localhost:${port}`, origin: 'http://tauri.localhost',
      headers: { authorization: `Bearer ${firstToken}` },
    })).status, 400);
    assert.equal((await sendRequest(port, 'GET', '/health/ready', {
      origin: 'http://127.0.0.1:5173',
      headers: { authorization: `Bearer ${firstToken}` },
    })).status, 403);
    assert.equal(await first.stop(), 0);
    assert.equal(await portIsFree(port), true);
    assert.equal(first.output().includes(firstToken), false);
    first = undefined;

    const secondToken = randomBytes(32).toString('hex');
    second = await startDesktopChild(workspaceId, dataRoot, secondToken);
    assert.equal((await sendRequest(second.port, 'GET', '/health/ready', {
      origin: 'http://tauri.localhost', headers: { authorization: `Bearer ${firstToken}` },
    })).status, 401);
    assert.equal((await sendRequest(second.port, 'GET', '/health/ready', {
      origin: 'http://tauri.localhost', headers: { authorization: `Bearer ${secondToken}` },
    })).status, 200);
    const secondPort = second.port;
    assert.equal(await second.stop(), 0);
    assert.equal(await portIsFree(secondPort), true);
    second = undefined;
  } finally {
    first?.child.kill();
    second?.child.kill();
    await db.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('desktop child rejects absent workspace, incompatible schema and early pipe close', async () => {
  const dataRoot = await createDataRoot();
  const emptyDatabase = await createTemporaryDatabase('desktop_schema');
  try {
    await rejectedDesktopChild(randomUUID(), dataRoot, 'WORKSPACE_UNAVAILABLE');
    await rejectedDesktopChild(randomUUID(), dataRoot, 'SCHEMA_UNAVAILABLE', emptyDatabase.appUrl);
    await rejectedDesktopChild(randomUUID(), dataRoot, 'DESKTOP_STARTUP_INVALID', DATABASE_URL, true);
  } finally {
    await emptyDatabase.drop();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
