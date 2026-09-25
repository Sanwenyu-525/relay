import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { dirname, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';

import { installGraphCheckpoints } from '../../src/infrastructure/graph-checkpoints.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { RunEventRepository } from '../../src/run/run-event-repository.js';
import {
  createTemporaryDatabase, expectSqlState, MIGRATIONS_DIRECTORY, openDatabase,
  type TemporaryDatabase,
} from './integration-support.js';
import {
  createWorkspace, delay, expectCommandAccepted, sendRequest, startTestApi, withTimeout, workspacePath,
  type TestApi,
} from './api-harness.js';

const WORKER_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'worker', 'main.js');
let temporaryDatabase: TemporaryDatabase;
let app: ReturnType<typeof openDatabase>;
let api: TestApi;
let workspaceId: string;

before(async () => {
  temporaryDatabase = await createTemporaryDatabase('m03_events');
  await runMigrations({ connectionString: temporaryDatabase.migrationUrl, directory: MIGRATIONS_DIRECTORY });
  await installGraphCheckpoints(temporaryDatabase.migrationUrl);
  app = openDatabase(temporaryDatabase.appUrl, 'relay-m03-events-test');
  api = await startTestApi({ databaseUrl: temporaryDatabase.appUrl });
  workspaceId = await createWorkspace(app.db);
});

after(async () => {
  if (api !== undefined) await api.stop();
  if (app !== undefined) await app.close();
  if (temporaryDatabase !== undefined) await temporaryDatabase.drop();
});

async function delegatedRun(): Promise<{ runId: string; taskId: string; delegateBody: {
  command_id: string; expected_task_revision: string;
} }> {
  const projectCommand = randomUUID();
  const project = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/projects'), {
    command_id: projectCommand, title: `event-${projectCommand.slice(0, 8)}`, project_type: 'GENERAL',
  }), 201, projectCommand);
  const taskCommand = randomUUID();
  const task = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: taskCommand, project_id: project.project_id,
    title: 'SSE Run', objective: 'Verify durable Run events',
    criteria: [{ statement: 'Human checks the result' }],
  }), 201, taskCommand);
  const readyCommand = randomUUID();
  const ready = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${task.task_id as string}/ready`), {
    command_id: readyCommand, expected_revision: task.revision,
  }), 200, readyCommand);
  const delegateBody = { command_id: randomUUID(), expected_task_revision: ready.revision as string };
  const delegated = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${task.task_id as string}/delegations`), delegateBody), 202, delegateBody.command_id);
  return { runId: delegated.run_id as string, taskId: task.task_id as string, delegateBody };
}

interface StreamHint { readonly id: string; readonly kind: string }

async function openStream(target: TestApi, runId: string, input: {
  readonly workspace?: string; readonly after?: string; readonly lastEventId?: string;
  readonly origin?: string;
} = {}): Promise<{ readonly status: number; readonly allowedOrigin: string | null;
  next(): Promise<StreamHint>; close(): Promise<void> }> {
  const controller = new AbortController();
  const path = workspacePath(input.workspace ?? workspaceId,
    `/runs/${runId}/events${input.after === undefined ? '' : `?after=${encodeURIComponent(input.after)}`}`);
  const response = await fetch(`http://127.0.0.1:${target.port}${path}`, {
    headers: { Authorization: `Bearer ${target.bearerToken}`, Accept: 'text/event-stream',
      ...(input.lastEventId === undefined ? {} : { 'Last-Event-ID': input.lastEventId }),
      ...(input.origin === undefined ? {} : { Origin: input.origin }) },
    signal: controller.signal,
  });
  assert.ok(response.body, 'SSE response must have a body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  return {
    status: response.status,
    allowedOrigin: response.headers.get('access-control-allow-origin'),
    next: async () => withTimeout((async () => {
      while (true) {
        const end = pending.indexOf('\n\n');
        if (end >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (frame.startsWith(':')) continue;
          const id = frame.split('\n').find((line) => line.startsWith('id: '))?.slice(4);
          const data = frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
          assert.ok(id && data, `incomplete SSE frame: ${frame}`);
          const parsed = JSON.parse(data) as { kind: string };
          return { id, kind: parsed.kind };
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE closed before the expected event');
        pending += decoder.decode(chunk.value, { stream: true });
      }
    })(), 10_000, 'SSE event'),
    close: async () => {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

test('Run events start at one, roll back without a gap, and are immutable to relay_app', async () => {
  const run = await delegatedRun();
  const events = new RunEventRepository(app.db);
  const initial = await events.latestVisibleSeq(workspaceId, run.runId);
  assert.equal(initial, 1n);
  const replay = await api.post(workspacePath(workspaceId,
    `/tasks/${run.taskId}/delegations`), run.delegateBody);
  assert.equal(replay.status, 202, replay.text);
  assert.equal(await events.latestVisibleSeq(workspaceId, run.runId), initial);
  await assert.rejects(app.db.transaction().execute(async (transaction) => {
    await sql`update runs set revision = revision + 1 where id = ${run.runId}`.execute(transaction);
    throw new Error('rollback event with business fact');
  }), /rollback event with business fact/u);
  assert.equal(await events.latestVisibleSeq(workspaceId, run.runId), initial);
  await sql`update runs set worker_lease_until = worker_lease_until where id = ${run.runId}`.execute(app.db);
  assert.equal(await events.latestVisibleSeq(workspaceId, run.runId), initial);
  await sql`update runs set revision = revision + 1 where id = ${run.runId}`.execute(app.db);
  assert.equal(await events.latestVisibleSeq(workspaceId, run.runId), initial + 1n);
  assert.deepEqual((await events.listAfter(run.runId, 0n, 10)).map((row) => row.seq), [1n, 2n]);
  await expectSqlState('42501', 'immutable Run event UPDATE', () => sql`
    update run_events set kind = 'RUN_CHANGED' where run_id = ${run.runId}
  `.execute(app.db));
  await expectSqlState('42501', 'immutable Run event DELETE', () => sql`
    delete from run_events where run_id = ${run.runId}
  `.execute(app.db));
});

test('SSE enforces bearer, Host, Origin, Workspace and canonical cursor forms', async () => {
  const run = await delegatedRun();
  const path = workspacePath(workspaceId, `/runs/${run.runId}/events`);
  const noBearer = await api.get(path, { headers: { authorization: '' } });
  assert.equal(noBearer.status, 401);
  assert.equal((await api.get(path, { host: `untrusted.invalid:${api.port}` })).status, 400);
  assert.equal((await api.get(path, { origin: 'https://not-allowed.invalid' })).status, 403);
  const otherWorkspace = await createWorkspace(app.db);
  assert.equal((await api.get(workspacePath(otherWorkspace, `/runs/${run.runId}/events`))).status, 404);
  for (const afterCursor of ['-1', '01', '9223372036854775808', '2']) {
    assert.equal((await api.get(`${path}?after=${afterCursor}`)).status, 422, afterCursor);
  }
  assert.equal((await api.get(`${path}?after=0&after=1`)).status, 422);
  assert.equal((await api.get(path, { headers: { 'Last-Event-ID': 'bad' } })).status, 422);
  const preflight = await sendRequest(api.port, 'OPTIONS', path, {
    origin: api.allowedOrigin,
    headers: { 'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization,last-event-id' },
  });
  assert.equal(preflight.status, 204);
  assert.match(String(preflight.headers['access-control-allow-headers']), /last-event-id/u);
  const headerStream = await openStream(api, run.runId, {
    lastEventId: '0', origin: api.allowedOrigin,
  });
  try {
    assert.equal(headerStream.status, 200);
    assert.equal(headerStream.allowedOrigin, api.allowedOrigin);
    assert.deepEqual(await headerStream.next(), { id: '1', kind: 'RUN_CHANGED' });
  } finally { await headerStream.close(); }
  const queryStream = await openStream(api, run.runId, { after: '0', lastEventId: 'bad' });
  try {
    assert.equal(queryStream.status, 200);
    assert.equal((await queryStream.next()).id, '1');
  } finally { await queryStream.close(); }
});

test('Run lock serializes cross-transaction event seq in commit order', async () => {
  const run = await delegatedRun();
  const events = new RunEventRepository(app.db);
  const initial = await events.latestVisibleSeq(workspaceId, run.runId);
  const step = await sql<{ id: string }>`select id from run_steps where run_id = ${run.runId} order by step_index limit 1`.execute(app.db);
  assert.ok(step.rows[0]);
  const writerA = openDatabase(temporaryDatabase.appUrl, 'relay-event-writer-a');
  const writerB = openDatabase(temporaryDatabase.appUrl, 'relay-event-writer-b');
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const started = new Promise<void>((done) => { entered = done; });
  try {
    const first = writerA.db.transaction().execute(async (transaction) => {
      await sql`update runs set revision = revision + 1 where id = ${run.runId}`.execute(transaction);
      entered();
      await held;
    });
    await withTimeout(started, 5000, 'first writer to lock Run');
    const second = writerB.db.transaction().execute(async (transaction) => {
      await sql`update run_steps set revision = revision + 1 where id = ${step.rows[0]!.id}`.execute(transaction);
    });
    assert.equal(await events.latestVisibleSeq(workspaceId, run.runId), initial);
    release();
    await withTimeout(Promise.all([first, second]), 5000, 'ordered Run commits');
    const committed = await events.listAfter(run.runId, initial ?? 0n, 10);
    assert.deepEqual(committed.map((row) => row.kind), ['RUN_CHANGED', 'STEP_CHANGED']);
    assert.deepEqual(committed.map((row) => row.seq), [initial! + 1n, initial! + 2n]);
  } finally {
    release();
    await writerA.close();
    await writerB.close();
  }
});

test('separate API stream replays Worker commits and reconnects after API restart', async () => {
  const run = await delegatedRun();
  // Earlier cases deliberately leave their transport rows pending. Isolate this
  // independent Worker fixture so --once selects the Run under observation.
  await sql`
    update run_command_outbox set status = 'DONE', settled_at = clock_timestamp()
    where status = 'PENDING' and command_id <> (
      select id from run_commands where run_id = ${run.runId} and kind = 'START'
    )
  `.execute(app.db);
  const events = new RunEventRepository(app.db);
  const beforeWorker = await events.latestVisibleSeq(workspaceId, run.runId);
  assert.ok(beforeWorker !== null);
  let secondApi = await startTestApi({ databaseUrl: temporaryDatabase.appUrl });
  try {
    const live = await openStream(secondApi, run.runId, { after: beforeWorker.toString() });
    try {
      assert.equal(live.status, 200);
      const worker = spawn(process.execPath, [WORKER_ENTRY, '--once'], {
        env: { ...process.env, RELAY_DB_URL: temporaryDatabase.appUrl,
          RELAY_DATA_ROOT: api.dataRoot, RELAY_WORKER_ID: `worker:${randomUUID()}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      worker.stdout.setEncoding('utf8');
      worker.stderr.setEncoding('utf8');
      worker.stdout.on('data', (chunk: string) => { output += chunk; });
      worker.stderr.on('data', (chunk: string) => { output += chunk; });
      const exit = new Promise<number | null>((done) => worker.once('close', done));
      const hint = await live.next();
      assert.equal(hint.id, (beforeWorker + 1n).toString());
      assert.equal(await withTimeout(exit, 20_000, 'independent Worker'), 0, output);
      const kinds = (await events.listAfter(run.runId, beforeWorker, 100)).map((row) => row.kind);
      assert.ok(kinds.includes('STEP_CHANGED'), `missing Step event: ${kinds}`);
      assert.ok(kinds.includes('ATTEMPT_CHANGED'), `missing Attempt event: ${kinds}`);
      assert.ok(kinds.includes('EFFECT_CHANGED'), `missing effect event: ${kinds}`);
    } finally { await live.close(); }
    await secondApi.stop();
    secondApi = await startTestApi({ databaseUrl: temporaryDatabase.appUrl });
    const latest = await events.latestVisibleSeq(workspaceId, run.runId);
    assert.ok(latest !== null && latest > beforeWorker);
    const historical = await openStream(secondApi, run.runId, { after: '0' });
    try {
      for (let seq = 1n; seq <= latest; seq++) {
        assert.equal((await historical.next()).id, seq.toString());
      }
    } finally { await historical.close(); }
    const resumed = await openStream(secondApi, run.runId, { after: latest.toString() });
    try {
      await sql`update runs set revision = revision + 1 where id = ${run.runId}`.execute(app.db);
      assert.equal((await resumed.next()).id, (latest + 1n).toString());
    } finally { await resumed.close(); }
  } finally {
    if (!secondApi.running.child.killed) await secondApi.stop().catch(() => undefined);
  }
});

test('committed control intent and safe point emit contiguous refresh hints', async () => {
  const run = await delegatedRun();
  const events = new RunEventRepository(app.db);
  const before = await events.latestVisibleSeq(workspaceId, run.runId);
  assert.ok(before !== null);
  const task = await api.get(workspacePath(workspaceId, `/tasks/${run.taskId}`));
  const runView = await api.get(workspacePath(workspaceId, `/runs/${run.runId}`));
  assert.equal(task.status, 200);
  assert.equal(runView.status, 200);
  const commandId = randomUUID();
  const result = await api.post(workspacePath(workspaceId, `/runs/${run.runId}/control-requests`), {
    command_id: commandId,
    expected_task_revision: (task.body as { revision: string }).revision,
    expected_run_revision: (runView.body as { revision: string }).revision,
    type: 'PAUSE',
  });
  assert.equal(result.status, 202, result.text);
  const rows = await events.listAfter(run.runId, before, 20);
  assert.ok(rows.some((row) => row.kind === 'CONTROL_CHANGED'));
  assert.ok(rows.some((row) => row.kind === 'RUN_CHANGED'));
  rows.forEach((row, index) => assert.equal(row.seq, before + BigInt(index + 1)));
  const paused = await api.get(workspacePath(workspaceId, `/runs/${run.runId}`));
  assert.equal((paused.body as { status: string }).status, 'PAUSED');
});

test('SSE disconnect does not cancel a Run and reconnect fills only committed history', async () => {
  const run = await delegatedRun();
  const first = await openStream(api, run.runId, { after: '0' });
  assert.equal((await first.next()).id, '1');
  await first.close();
  const stillRunning = await api.get(workspacePath(workspaceId, `/runs/${run.runId}`));
  assert.equal(stillRunning.status, 200);
  assert.equal((stillRunning.body as { status: string }).status, 'CREATED');
  await sql`update runs set revision = revision + 1 where id = ${run.runId}`.execute(app.db);
  const reconnected = await openStream(api, run.runId, { after: '1' });
  try {
    assert.equal((await reconnected.next()).id, '2');
  } finally { await reconnected.close(); }
});

test('a non-reading SSE peer cannot stall PG/GET and reconnects after a large durable backlog', async () => {
  const run = await delegatedRun();
  const events = new RunEventRepository(app.db);
  const start = await events.latestVisibleSeq(workspaceId, run.runId);
  assert.ok(start !== null);
  const backlog = 50000n;
  let resolveClose!: () => void;
  const closed = new Promise<void>((done) => { resolveClose = done; });
  let request: ReturnType<typeof httpRequest> | undefined;
  const response = await new Promise<IncomingMessage>((done, fail) => {
    request = httpRequest({ host: '127.0.0.1', port: api.port, method: 'GET',
      path: workspacePath(workspaceId, `/runs/${run.runId}/events?after=${start.toString()}`),
      headers: { Authorization: `Bearer ${api.bearerToken}`, Accept: 'text/event-stream' },
    }, (stream) => {
      stream.pause();
      stream.once('close', resolveClose);
      stream.socket?.once('close', resolveClose);
      done(stream);
    });
    request.on('error', fail);
    request.end();
  });
  try {
    assert.equal(response.statusCode, 200);
    await sql`
      insert into run_events (run_id, seq, kind)
      select ${run.runId}::uuid, number::bigint, 'RUN_CHANGED'
      from generate_series(${start + 1n}::bigint, ${start + backlog}::bigint) as number
    `.execute(app.db);
    assert.equal(await events.latestVisibleSeq(workspaceId, run.runId), start + backlog);
    const snapshot = await withTimeout(api.get(workspacePath(workspaceId,
      `/runs/${run.runId}`)), 5000, 'GET while the SSE peer is paused');
    assert.equal(snapshot.status, 200, snapshot.text);
  } finally {
    request?.destroy();
    response.destroy();
    await withTimeout(closed, 5000, 'the paused SSE peer to close after client disconnect');
    await delay(20);
  }
  const resumed = await openStream(api, run.runId, { after: start.toString() });
  try { assert.equal((await resumed.next()).id, (start + 1n).toString()); }
  finally { await resumed.close(); }
});
