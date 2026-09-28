// Disposable M06 Windows Job acceptance helper. Never prints the private API token or file contents.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const [phase, rootArg, runArg, operationArg] = process.argv.slice(2);
const phases = ['seed', 'approve', 'facts', 'preview', 'dispose'];
if (!phases.includes(phase) || !rootArg ||
    !/^relay-m02-acceptance-[0-9a-f]{32}$/iu.test(basename(resolve(rootArg)))) {
  throw new Error('Usage: node m06-seed-file-write.mjs <seed|approve|facts|preview|dispose> <sessionRoot> [runId] [operationId]');
}
const root = resolve(rootArg);
assert.equal(await realpath(root), root, 'session root must not be a link');
const session = JSON.parse(readFileSync(join(root, 'session.json'), 'utf8').replace(/^\uFEFF/u, ''));
assert.equal(resolve(session.data_root), join(root, 'data'));
assert.equal(await realpath(session.data_root), resolve(session.data_root), 'data root must not be a link');
assert.equal(resolve(session.config_path), join(root, 'desktop.env'));
assert.match(session.workspace_id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu);
const releaseRoot = dirname(session.release_exe);
assert.equal(basename(session.release_exe).toLowerCase(), 'relay-desktop.exe');
assert.ok(existsSync(join(releaseRoot, 'node.exe')));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
if (phase === 'seed') assert.equal(session.desktop_pid, 0, 'seed before starting the desktop host');
if (phase === 'approve' && (!uuid.test(runArg ?? '') || !uuid.test(operationArg ?? ''))) {
  throw new Error('approve requires <runId> <operationId>');
}
const operationId = phase === 'approve' ? operationArg : runArg;
if (phase !== 'seed' && phase !== 'approve' && !uuid.test(operationId ?? '')) {
  throw new Error(`${phase} requires <operationId>`);
}

function inDataRoot(path) {
  const checked = resolve(path);
  const delta = relative(resolve(session.data_root), checked);
  assert.ok(delta && delta !== '..' && !delta.startsWith('..\\') && !delta.startsWith('../') &&
    !isAbsolute(delta), 'file target must stay inside this session data root');
  return checked;
}

async function withDatabase(action) {
  const config = readFileSync(session.config_path, 'utf8').replace(/^\uFEFF/u, '');
  const line = config.split(/\r?\n/u).find((entry) => entry.startsWith('RELAY_DB_URL='));
  assert.ok(line, 'session DB URL missing');
  const url = new URL(line.slice('RELAY_DB_URL='.length));
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(Number(url.port), session.postgres_port);
  const requireRelease = createRequire(join(releaseRoot, 'api', 'package.json'));
  const { Client } = requireRelease('pg');
  const db = new Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  await db.connect();
  try { return await action(db); }
  finally { await db.end(); }
}

async function one(db, query, parameters) {
  return (await db.query(query, parameters)).rows[0] ?? null;
}

async function facts(id) {
  return withDatabase(async (db) => {
    const operation = await one(db, `select id, status, run_id, task_id from logical_operations
      where id=$1 and workspace_id=$2 and capability_key='FILE_WRITE' and origin='RUN'`,
    [id, session.workspace_id]);
    const frozen = operation ? null : await one(db, `select c.run_id, c.task_id from execution_contracts c
      join runs r on r.id=c.run_id where r.workspace_id=$2
        and c.frozen_snapshot->'file_write_action'->>'operation_id'=$1`, [id, session.workspace_id]);
    assert.ok(operation || frozen, 'frozen FILE_WRITE operation not found in this workspace');
    const runId = operation?.run_id ?? frozen.run_id;
    const taskId = operation?.task_id ?? frozen.task_id;
    const latest = await one(db, `select id, status, worker_id, worker_epoch, resource_claim_id, result_ref
      from invocation_attempts where operation_id=$1 order by attempt_number desc limit 1`, [id]);
    const count = await one(db, 'select count(*)::integer as count from invocation_attempts where operation_id=$1', [id]);
    const ledger = latest && await one(db, 'select id, status from change_sets where invocation_id=$1', [latest.id]);
    const ledgerFiles = ledger ? (await db.query(`select relative_path, action, status,
      baseline_sha256, observed_baseline_sha256, target_sha256, actual_sha256
      from change_set_files where change_set_id=$1 order by relative_path`, [ledger.id])).rows : [];
    const claim = latest?.resource_claim_id && await one(db, 'select id, status from resource_claims where id=$1', [latest.resource_claim_id]);
    const run = await one(db, 'select id, status, worker_epoch from runs where id=$1', [runId]);
    const task = await one(db, 'select id, status from tasks where id=$1', [taskId]);
    const dispatch = await one(db, 'select status, epoch, command_id, worker_id from run_invocations where run_id=$1', [runId]);
    const proof = latest && await one(db, `select invocation_id, operation_id, run_id, worker_id,
      worker_epoch, dispatch_epoch, command_id, launch_id, stop_evidence
      from file_write_stop_proofs where invocation_id=$1`, [latest.id]);
    const outboxCommandId = dispatch?.command_id ?? proof?.command_id;
    const outbox = outboxCommandId && await one(db,
      'select status, command_id from run_command_outbox where command_id=$1', [outboxCommandId]);
    return { operation: operation ? { id: operation.id, status: operation.status } : null,
      invocation: latest ? { id: latest.id, status: latest.status, worker_id: latest.worker_id,
        worker_epoch: latest.worker_epoch,
        result_ref_kind: latest.result_ref?.file_write_receipt?.kind ?? null } : null,
      ledger: ledger ? { id: ledger.id, status: ledger.status, files: ledgerFiles } : null,
      claim: claim ? { id: claim.id, status: claim.status } : null,
      run: run ? { id: run.id, status: run.status, worker_epoch: run.worker_epoch } : null,
      task: task ? { id: task.id, status: task.status } : null,
      dispatch: dispatch ? { status: dispatch.status, epoch: dispatch.epoch,
        command_id: dispatch.command_id, worker_id: dispatch.worker_id } : null,
      outbox: outbox ? { status: outbox.status, command_id: outbox.command_id } : null,
      stop_proof: proof, invocation_count: count?.count ?? 0 };
  });
}

async function withPrivateApi(action) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('NODE_') || key.startsWith('RELAY_')) delete environment[key];
  }
  environment.RELAY_DATA_ROOT = session.data_root;
  const api = spawn(join(releaseRoot, 'node.exe'), [
    `--env-file=${session.config_path}`, join(releaseRoot, 'api', 'dist', 'src', 'main.js'), '--desktop-child',
  ], { cwd: releaseRoot, env: environment, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const nonce = randomUUID().replaceAll('-', '');
  const bearerToken = randomBytes(32).toString('hex');
  const closed = new Promise((done, fail) => { api.once('error', fail); api.once('close', done); });
  let stopped = false;
  async function closeWithin(milliseconds) {
    let timer;
    try { return await Promise.race([closed, new Promise((done) => {
      timer = setTimeout(() => done('timeout'), milliseconds);
    })]); } finally { clearTimeout(timer); }
  }
  try {
    const lines = createInterface({ input: api.stdout });
    const ready = new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error('private seed API did not become ready')), 30000);
      lines.on('line', (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.nonce !== nonce) return;
        if (event.type === 'desktop_error') { clearTimeout(timer); fail(new Error(`private API startup rejected: ${event.code}`)); }
        else if (event.type === 'desktop_ready') { clearTimeout(timer); done(event); }
      });
      api.once('close', () => { clearTimeout(timer); fail(new Error('private seed API exited before readiness')); });
    });
    api.stdin.write(`${JSON.stringify({ nonce, bearerToken })}\n`);
    const event = await ready;
    assert.equal(event.workspaceId, session.workspace_id);
    assert.ok(Number.isInteger(event.port) && event.port >= 1 && event.port <= 65535);
    const baseUrl = `http://127.0.0.1:${event.port}/api/v1/workspaces/${session.workspace_id}`;
    async function request(method, suffix, body, expectedStatus = 200) {
      const response = await fetch(`${baseUrl}${suffix}`, { method,
        headers: { authorization: `Bearer ${bearerToken}`, origin: 'http://tauri.localhost',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json();
      assert.equal(response.status, expectedStatus,
        `${method} ${suffix} returned ${response.status} (${value?.code ?? 'no code'})`);
      if (method === 'POST') {
        assert.equal(value.command_id, body.command_id);
        return value.result;
      }
      return value;
    }
    const result = await action(request);
    api.stdin.end();
    assert.equal(await closeWithin(7000), 0, 'private seed API did not stop on stdin EOF');
    stopped = true;
    return result;
  } finally {
    if (!stopped) {
      api.stdin.end();
      const result = await closeWithin(3000);
      if (result === 'timeout') { api.kill(); await closed; }
    }
  }
}

async function seed() {
  return withPrivateApi(async (request) => {
    const project = await request('POST', '/projects', {
      command_id: randomUUID(), title: 'M06 Windows Job partial FILE_WRITE', project_type: 'GENERAL',
    }, 201);
    const fileRoot = inDataRoot(join(session.data_root, `m06-file-write-${randomUUID()}`));
    await mkdir(fileRoot);
    await writeFile(join(fileRoot, 'existing.txt'), 'baseline\n');
    const resource = await request('POST', `/projects/${project.project_id}/managed-resources`, {
      command_id: randomUUID(), root_path: fileRoot,
    }, 201);
    assert.equal(resource.canonical_root, fileRoot);
    const connection = await request('POST', `/projects/${project.project_id}/connections`, {
      command_id: randomUUID(), capabilities: ['FILE_WRITE'], root_path: fileRoot,
    }, 201);
    await request('POST', `/projects/${project.project_id}/permission-policies`, {
      command_id: randomUUID(), capability: 'FILE_WRITE', resource_id: resource.resource_id,
      decision: 'AUTO', max_payload_bytes: 262144,
    }, 201);
    const task = await request('POST', '/tasks', {
      command_id: randomUUID(), project_id: project.project_id,
      title: 'M06 partial file write recovery', objective: 'Keep the original file write identity for recovery',
      criteria: [{ criterion_id: 'human', statement: 'Review the result', method: 'HUMAN' }],
    }, 201);
    const ready = await request('POST', `/tasks/${task.task_id}/ready`, {
      command_id: randomUUID(), expected_revision: task.revision,
    });
    const delegateCommandId = randomUUID();
    const delegated = await request('POST', `/tasks/${task.task_id}/delegations`, {
      command_id: delegateCommandId, expected_task_revision: ready.revision,
      file_write_action: { connection_id: connection.connection_id, resource_id: resource.resource_id,
        changes: [{ path: 'new.txt', action: 'CREATE', content: 'created by original invocation\n' },
          { path: 'existing.txt', action: 'MODIFY', content: 'updated by original invocation\n',
            baselineSha256: createHash('sha256').update('baseline\n').digest('hex') }] },
    }, 202);
    const frozen = await withDatabase((db) => one(db,
      "select frozen_snapshot->'file_write_action'->>'operation_id' as operation_id from execution_contracts where run_id=$1",
      [delegated.run_id]));
    assert.ok(uuid.test(frozen?.operation_id ?? ''), 'frozen operation ID missing');
    return { phase: 'seed', project_id: project.project_id, task_id: task.task_id,
      run_id: delegated.run_id, operation_id: frozen.operation_id,
      delegate_command_id: delegateCommandId, resource_id: resource.resource_id,
      connection_id: connection.connection_id, file_root: fileRoot,
      existing_path: join(fileRoot, 'existing.txt'), new_path: join(fileRoot, 'new.txt'),
      new_expected_sha256: createHash('sha256').update('created by original invocation\n').digest('hex'),
      existing_baseline_sha256: createHash('sha256').update('baseline\n').digest('hex'),
      existing_conflict_sha256: createHash('sha256').update('external change before approved write\n').digest('hex'),
      existing_target_sha256: createHash('sha256').update('updated by original invocation\n').digest('hex') };
  });
}

async function approve(runId, id) {
  return withPrivateApi(async (request) => {
    const operation = await request('GET', `/operations/${id}`);
    assert.equal(operation.run_id, runId);
    assert.equal(operation.status, 'WAITING_APPROVAL');
    assert.equal(operation.action_type, 'APPLY_CHANGESET');
    const fileRoot = inDataRoot(operation.normalized_target);
    assert.equal(await realpath(fileRoot), fileRoot, 'managed root must not be redirected');
    const reviews = await request('GET', `/runs/${runId}/reviews`);
    const review = reviews.items.find((item) => item.kind === 'ACTION_APPROVAL' &&
      item.status === 'OPEN' && item.target?.operation_id === id);
    assert.ok(review?.allowed_decisions?.includes('APPROVE'), 'original ASK review not open');
    const existingPath = join(fileRoot, 'existing.txt');
    assert.equal((await lstat(existingPath)).isSymbolicLink(), false);
    assert.equal(await readFile(existingPath, 'utf8'), 'baseline\n');
    await writeFile(existingPath, 'external change before approved write\n');
    const approveCommandId = randomUUID();
    await request('POST', `/reviews/${review.id}/decisions`, {
      command_id: approveCommandId, expected_revision: review.revision,
      target_hash: review.target_hash, decision: 'APPROVE',
    });
    const resumed = await withDatabase((db) => one(db,
      "select id from run_commands where run_id=$1 and kind='RESUME' and source_command_id=$2",
      [runId, approveCommandId]));
    assert.ok(uuid.test(resumed?.id ?? ''), 'original RESUME command missing');
    return { phase: 'approve', run_id: runId, operation_id: id, review_id: review.id,
      approve_command_id: approveCommandId, resume_command_id: resumed.id,
      file_root: fileRoot };
  });
}

async function dispose(id) {
  return withPrivateApi(async (request) => {
    const operation = await request('GET', `/operations/${id}`);
    inDataRoot(operation.normalized_target);
    const preview = await request('GET', `/operations/${id}/file-write-disposition`);
    assert.equal(preview.operation_id, id);
    assert.equal(preview.can_dispose, true,
      `FILE_WRITE cannot be disposed: ${preview.blocking_reasons?.join(',') ?? 'unknown'}`);
    assert.ok(uuid.test(preview.invocation_id ?? ''));
    assert.match(preview.observation_sha256, /^[0-9a-f]{64}$/u);
    const commandId = randomUUID();
    const result = await request('POST', `/operations/${id}/file-write-disposition`, {
      command_id: commandId, invocation_id: preview.invocation_id,
      decision: 'KEEP_CURRENT_AND_FAIL_RUN', expected_run_revision: preview.run_revision,
      expected_task_revision: preview.task_revision,
      expected_observation_sha256: preview.observation_sha256,
    });
    assert.equal(result.operation_id, id);
    assert.equal(result.invocation_id, preview.invocation_id);
    assert.equal(result.run_status, 'FAILED');
    return { phase: 'dispose', operation_id: id, invocation_id: preview.invocation_id,
      command_id: commandId, disposition_id: result.disposition_id,
      run_id: result.run_id, run_status: result.run_status,
      task_id: result.task_id, task_status: result.task_status,
      observation_sha256: result.observation_sha256 };
  });
}

async function preview(id) {
  return withPrivateApi(async (request) => {
    const value = await request('GET', `/operations/${id}/file-write-disposition`);
    assert.equal(value.operation_id, id);
    return { phase: 'preview', operation_id: id, invocation_id: value.invocation_id,
      observation_mode: value.observation_mode, can_dispose: value.can_dispose,
      blocking_reasons: value.blocking_reasons, files: value.files };
  });
}

const result = phase === 'seed' ? await seed() : phase === 'approve'
  ? await approve(runArg, operationArg) : phase === 'facts'
    ? await facts(operationId) : phase === 'preview'
      ? await preview(operationId) : await dispose(operationId);
console.log(JSON.stringify(result));
