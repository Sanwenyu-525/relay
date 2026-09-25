import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { sql } from 'kysely';

import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath,
  type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, openDatabase } from './integration-support.js';

// This file is deliberately *.bench.ts, outside the default *.test.js integration suite.
// scripts/run-m03-mock-benchmark.ps1 opts it into the existing isolated-PG wrapper.
const SUCCESS_COUNT = 8;
const CANCEL_COUNT = 2;
const DELEGATE_CONCURRENCY = 4;
const MOCK_MODEL_DELAY_MS = 250;
const POLL_MS = 500;
const DEADLINE_MS = 300_000;
const outputDir = process.env.RELAY_M03_BENCH_OUTPUT_DIR;
if (!outputDir) throw new Error('RELAY_M03_BENCH_OUTPUT_DIR is required');

interface Sample {
  kind: 'success' | 'cancel';
  index: number;
  taskId: string;
  readyRevision: string;
  runId?: string;
  delegateStartedAtMs?: number;
  delegateAcceptedAtMs?: number;
  delegateLatencyMs?: number;
  cancelStartedAtMs?: number;
  cancelAcceptedAtMs?: number;
  cancelLatencyMs?: number;
  controlRequestId?: string;
  observedTerminalAtMs?: number;
  finalRunStatus?: string;
  finalTaskStatus?: string;
  runCreatedAtMs?: number;
  runTerminalAtMs?: number;
  draftFinishedAtMs?: number;
  candidateFinishedAtMs?: number;
  commandCreatedAtMs?: number;
  commandClaimedAtMs?: number;
  commandStatus?: string;
  attemptCount?: number;
  retryCount?: number;
  eventCount?: number;
}

interface ResourceRecord {
  kind: string;
  at_ms: number;
  pid: number;
  role: string;
  rss_bytes: number;
  cpu_delta_ms: number;
  loop_p95_ms: number | null;
  loop_p99_ms: number | null;
  loop_max_ms: number | null;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function quantiles(values: readonly number[]) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const at = (fraction: number): number | null => {
    if (sorted.length === 0) return null;
    const position = fraction * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return Math.round((sorted[lower]! + (sorted[upper]! - sorted[lower]!) *
      (position - lower)) * 100) / 100;
  };
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99),
    min: sorted[0] ?? null, max: sorted.at(-1) ?? null,
    tailInference: sorted.length >= 100 ? 'descriptive' : 'insufficient_samples' };
}

async function mapLimit<T>(items: readonly T[], limit: number,
  work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const index = next++;
      await work(items[index]!);
    }
  }));
}

function startSupervisor(api: TestApi, metricsImport: string): {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  close: Promise<number | null>;
  stop: () => Promise<number | null>;
} {
  const log = createWriteStream(join(outputDir!, 'supervisor.log'));
  const child = spawn(process.execPath,
    [resolve(process.cwd(), 'dist/src/worker/supervisor-main.js')], {
      env: { ...process.env, NODE_ENV: 'test',
        NODE_OPTIONS: metricsImport,
        RELAY_DB_URL: APP_DATABASE_URL, RELAY_DATA_ROOT: api.dataRoot,
        RELAY_WORKER_TEST_MODEL_DELAY_MS: String(MOCK_MODEL_DELAY_MS),
        RELAY_SUPERVISOR_STOP_ON_STDIN_EOF: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
  let pending = '';
  let readyDone = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  const readyTimeout = setTimeout(() => readyReject(new Error('supervisor readiness timed out')), 15_000);
  const close = new Promise<number | null>((resolveClose) => {
    child.once('close', (code) => {
      clearTimeout(readyTimeout);
      if (!readyDone) readyReject(new Error(`supervisor exited before readiness: ${code}`));
      log.end();
      resolveClose(code);
    });
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    log.write(chunk);
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!readyDone && line.includes('"type":"supervisor_ready"')) {
        readyDone = true;
        clearTimeout(readyTimeout);
        readyResolve();
      }
      newline = pending.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk: string) => log.write(chunk));
  child.once('error', (error) => readyReject(error));
  return { child, ready, close, stop: async () => {
    child.stdin.end();
    const stopped = await Promise.race([close, sleep(20_000).then(() => null)]);
    if (stopped !== null) return stopped;
    child.kill('SIGTERM');
    return Promise.race([close, sleep(10_000).then(() => null)]);
  } };
}

async function readResources(): Promise<ResourceRecord[]> {
  const files = (await readdir(outputDir!)).filter((name) => /^node-\d+\.jsonl$/u.test(name));
  const records: ResourceRecord[] = [];
  for (const name of files) {
    for (const line of (await readFile(join(outputDir!, name), 'utf8')).split(/\r?\n/u)) {
      if (line) records.push(JSON.parse(line) as ResourceRecord);
    }
  }
  return records;
}

function summarizeResources(records: readonly ResourceRecord[]) {
  const byPid = new Map<number, ResourceRecord[]>();
  for (const record of records) byPid.set(record.pid,
    [...(byPid.get(record.pid) ?? []), record]);
  const processes = [...byPid.entries()].map(([pid, samples]) => ({
    pid, role: samples[0]!.role, samples: samples.length,
    cpu_ms: Math.round(samples.reduce((sum, item) => sum + item.cpu_delta_ms, 0) * 100) / 100,
    peak_rss_bytes: Math.max(...samples.map((item) => item.rss_bytes)),
    event_loop_sample_p95_ms: quantiles(samples.flatMap((item) => item.loop_p95_ms === null
      ? [] : [item.loop_p95_ms])),
    event_loop_max_ms: Math.max(0, ...samples.map((item) => item.loop_max_ms ?? 0)),
  }));
  const active = new Map<number, number>();
  let sampledNodeTreePeakRssBytes = 0;
  for (const record of [...records].sort((a, b) => a.at_ms - b.at_ms)) {
    active.set(record.pid, record.rss_bytes);
    sampledNodeTreePeakRssBytes = Math.max(sampledNodeTreePeakRssBytes,
      [...active.values()].reduce((sum, value) => sum + value, 0));
    if (record.kind === 'exit') active.delete(record.pid);
  }
  return { processes, sampled_node_tree_peak_rss_bytes: sampledNodeTreePeakRssBytes,
    total_node_cpu_ms: Math.round(processes.reduce((sum, item) => sum + item.cpu_ms, 0) * 100) / 100 };
}

test('M03 fixed Mock workload against independent API, supervisor, Worker and isolated PG',
  { timeout: 600_000 }, async () => {
    const db = openDatabase(APP_DATABASE_URL, 'relay-m03-mock-benchmark');
    const samples: Sample[] = [];
    const dbSamples: Array<{ at_ms: number; roundtrip_ms?: number;
      active_connections?: number; lock_waiters?: number; error?: string }> = [];
    let api: TestApi | undefined;
    let supervisor: ReturnType<typeof startSupervisor> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let dbProbeBusy = false;
    let failure: string | null = null;
    let failedDuringRun = false;
    const priorNodeOptions = process.env.NODE_OPTIONS;
    const restoreNodeOptions = () => {
      if (priorNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = priorNodeOptions;
    };
    const metricsImport = `${priorNodeOptions ? `${priorNodeOptions} ` : ''}--import=${pathToFileURL(
      resolve(process.cwd(), 'scripts/m03-mock-metrics-preload.mjs')).href}`;
    try {
      const workspaceId = await createWorkspace(db.db);
      process.env.NODE_OPTIONS = metricsImport;
      api = await startTestApi();
      restoreNodeOptions();
      const projectCommand = randomUUID();
      const project = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/projects'), {
        command_id: projectCommand, title: 'M03 fixed Mock benchmark', project_type: 'GENERAL',
      }), 201, projectCommand);

      for (let index = 0; index < SUCCESS_COUNT + CANCEL_COUNT; index++) {
        const kind = index < SUCCESS_COUNT ? 'success' : 'cancel';
        const createCommand = randomUUID();
        const task = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/tasks'), {
          command_id: createCommand, project_id: project.project_id,
          title: `M03 Mock ${kind} ${index + 1}`,
          objective: 'Produce a short fixed Mock Markdown deliverable',
          criteria: [{ criterion_id: 'structure', statement: 'Markdown structure is complete',
            method: 'MARKDOWN_STRUCTURE' }],
        }), 201, createCommand);
        const readyCommand = randomUUID();
        const ready = expectCommandAccepted(await api.post(workspacePath(workspaceId,
          `/tasks/${task.task_id as string}/ready`), {
          command_id: readyCommand, expected_revision: task.revision,
        }), 200, readyCommand);
        samples.push({ kind, index, taskId: task.task_id as string,
          readyRevision: ready.revision as string });
      }

      supervisor = startSupervisor(api, metricsImport);
      await supervisor.ready;
      timer = setInterval(() => {
        if (dbProbeBusy) return;
        dbProbeBusy = true;
        const started = performance.now();
        const at = Date.now();
        void sql<{ active_connections: number; lock_waiters: number }>`
          select count(*)::integer as active_connections,
            count(*) filter (where wait_event_type = 'Lock')::integer as lock_waiters
          from pg_stat_activity where datname = current_database()
        `.execute(db.db).then((result) => {
          dbSamples.push({ at_ms: at, roundtrip_ms: performance.now() - started,
            active_connections: result.rows[0]?.active_connections ?? 0,
            lock_waiters: result.rows[0]?.lock_waiters ?? 0 });
        }, (error: unknown) => {
          dbSamples.push({ at_ms: at,
            error: error instanceof Error ? error.message : 'database probe failed' });
        }).finally(() => { dbProbeBusy = false; });
      }, 500);

      await mapLimit(samples, DELEGATE_CONCURRENCY, async (sample) => {
        const commandId = randomUUID();
        const started = performance.now();
        sample.delegateStartedAtMs = Date.now();
        const delegated = expectCommandAccepted(await api!.post(workspacePath(workspaceId,
          `/tasks/${sample.taskId}/delegations`), {
          command_id: commandId, expected_task_revision: sample.readyRevision,
        }), 202, commandId);
        sample.delegateAcceptedAtMs = Date.now();
        sample.delegateLatencyMs = performance.now() - started;
        sample.runId = delegated.run_id as string;
      });

      await Promise.all(samples.filter((sample) => sample.kind === 'cancel').map(async (sample) => {
        const [taskView, runView] = await Promise.all([
          api!.get(workspacePath(workspaceId, `/tasks/${sample.taskId}`)),
          api!.get(workspacePath(workspaceId, `/runs/${sample.runId}`)),
        ]);
        assert.equal(taskView.status, 200);
        assert.equal(runView.status, 200);
        const commandId = randomUUID();
        const started = performance.now();
        sample.cancelStartedAtMs = Date.now();
        const cancelled = expectCommandAccepted(await api!.post(workspacePath(workspaceId,
          `/tasks/${sample.taskId}/cancel`), {
          command_id: commandId,
          expected_task_revision: (taskView.body as { revision: string }).revision,
          expected_run_revision: (runView.body as { revision: string }).revision,
        }), 202, commandId);
        sample.cancelAcceptedAtMs = Date.now();
        sample.cancelLatencyMs = performance.now() - started;
        sample.controlRequestId = cancelled.control_request_id as string;
      }));

      const deadline = Date.now() + DEADLINE_MS;
      while (Date.now() < deadline && samples.some((sample) => sample.observedTerminalAtMs === undefined)) {
        for (const sample of samples.filter((item) => item.observedTerminalAtMs === undefined)) {
          const runView = await api.get(workspacePath(workspaceId, `/runs/${sample.runId}`));
          assert.equal(runView.status, 200);
          const status = (runView.body as { status: string }).status;
          if (!['COMPLETED', 'CANCELLED', 'FAILED'].includes(status)) continue;
          sample.observedTerminalAtMs = Date.now();
          sample.finalRunStatus = status;
          const taskView = await api.get(workspacePath(workspaceId, `/tasks/${sample.taskId}`));
          assert.equal(taskView.status, 200);
          sample.finalTaskStatus = (taskView.body as { status: string }).status;
        }
        if (samples.some((sample) => sample.observedTerminalAtMs === undefined)) await sleep(POLL_MS);
      }
      assert.equal(samples.filter((sample) => sample.observedTerminalAtMs === undefined).length,
        0, 'some fixed Mock tasks did not converge before the deadline');

      for (const sample of samples) {
        const facts = await sql<{ created_at: Date; terminal_at: Date | null;
          draft_at: Date | null; candidate_at: Date | null; attempt_count: number;
          retry_count: number; event_count: number }>`
          select r.created_at, r.terminal_at,
            (select finished_at from run_steps where run_id = r.id and step_kind = 'DRAFT') as draft_at,
            (select finished_at from run_steps where run_id = r.id and step_kind = 'PERSIST_CANDIDATE') as candidate_at,
            (select count(*)::integer from step_attempts a join run_steps s on s.id = a.step_id
              where s.run_id = r.id) as attempt_count,
            (select count(*)::integer from step_attempts a join run_steps s on s.id = a.step_id
              where s.run_id = r.id and a.attempt_number > 1) as retry_count,
            (select count(*)::integer from run_events where run_id = r.id) as event_count
          from runs r where r.id = ${sample.runId}
        `.execute(db.db);
        assert.ok(facts.rows[0]);
        sample.runCreatedAtMs = facts.rows[0].created_at.getTime();
        if (facts.rows[0].terminal_at) sample.runTerminalAtMs = facts.rows[0].terminal_at.getTime();
        if (facts.rows[0].draft_at) sample.draftFinishedAtMs = facts.rows[0].draft_at.getTime();
        if (facts.rows[0].candidate_at) sample.candidateFinishedAtMs = facts.rows[0].candidate_at.getTime();
        sample.attemptCount = facts.rows[0].attempt_count;
        sample.retryCount = facts.rows[0].retry_count;
        sample.eventCount = facts.rows[0].event_count;
        const command = await sql<{ created_at: Date; claimed_at: Date | null;
          status: string }>`
          select c.created_at, o.claimed_at, o.status from run_commands c
          join run_command_outbox o on o.command_id = c.id
          where c.run_id = ${sample.runId} and c.kind = 'START'
        `.execute(db.db);
        assert.ok(command.rows[0]);
        sample.commandCreatedAtMs = command.rows[0].created_at.getTime();
        if (command.rows[0].claimed_at) sample.commandClaimedAtMs = command.rows[0].claimed_at.getTime();
        sample.commandStatus = command.rows[0].status;
      }

      assert.equal(samples.filter((sample) => sample.kind === 'success' &&
        sample.finalRunStatus === 'COMPLETED' && sample.finalTaskStatus === 'DONE').length,
      SUCCESS_COUNT, 'all baseline tasks must complete successfully');
      assert.equal(samples.filter((sample) => sample.kind === 'cancel' &&
        sample.finalRunStatus === 'CANCELLED' && sample.finalTaskStatus === 'CANCELLED').length,
      CANCEL_COUNT, 'all cancellation tasks must converge to CANCELLED');
    } catch (error) {
      failedDuringRun = true;
      failure = error instanceof Error ? error.message : 'benchmark failed';
      throw error;
    } finally {
      if (timer) clearInterval(timer);
      while (dbProbeBusy) await sleep(20);
      const supervisorExit = supervisor ? await supervisor.stop() : null;
      const apiExit = api ? await api.stop() : null;
      if (supervisor && supervisorExit !== 0) failure ??= `supervisor exit code: ${supervisorExit}`;
      if (api && apiExit !== 0) failure ??= `API exit code: ${apiExit}`;
      const apiLog = api?.running.readOutput() ?? '';
      await db.close();
      restoreNodeOptions();
      await writeFile(join(outputDir, 'api.log'), apiLog);
      const resources = await readResources();
      const completed = samples.filter((sample) => sample.kind === 'success' &&
        sample.finalRunStatus === 'COMPLETED');
      const cancelled = samples.filter((sample) => sample.kind === 'cancel' &&
        sample.finalRunStatus === 'CANCELLED');
      const firstStarted = Math.min(...samples.flatMap((sample) => sample.delegateStartedAtMs === undefined
        ? [] : [sample.delegateStartedAtMs]));
      const lastCompleted = Math.max(...completed.flatMap((sample) => sample.runTerminalAtMs === undefined
        ? [] : [sample.runTerminalAtMs]));
      const summary = {
        status: failure === null ? 'MEASURED' : 'FAILED', failure,
        fixed_workload: { success_count: SUCCESS_COUNT, cancel_count: CANCEL_COUNT,
          delegate_concurrency: DELEGATE_CONCURRENCY, mock_model_delay_ms: MOCK_MODEL_DELAY_MS,
          poll_interval_ms: POLL_MS, checkpoint: 'PostgresSaver',
          model: 'FakeModelPort', criterion: 'MARKDOWN_STRUCTURE',
          gateway_action: 'none', approval: 'none' },
        runtime: { node: process.version, supervisor_exit: supervisorExit, api_exit: apiExit },
        latency_ms: {
          delegate_202: quantiles(samples.flatMap((sample) => sample.delegateLatencyMs === undefined
            ? [] : [sample.delegateLatencyMs])),
          command_queue_to_claim: quantiles(samples.flatMap((sample) =>
            sample.commandCreatedAtMs === undefined || sample.commandClaimedAtMs === undefined
              ? [] : [sample.commandClaimedAtMs - sample.commandCreatedAtMs])),
          first_persisted_draft: quantiles(completed.flatMap((sample) =>
            sample.runCreatedAtMs === undefined || sample.draftFinishedAtMs === undefined
              ? [] : [sample.draftFinishedAtMs - sample.runCreatedAtMs])),
          first_published_candidate: quantiles(completed.flatMap((sample) =>
            sample.runCreatedAtMs === undefined || sample.candidateFinishedAtMs === undefined
              ? [] : [sample.candidateFinishedAtMs - sample.runCreatedAtMs])),
          run_completion: quantiles(completed.flatMap((sample) =>
            sample.runCreatedAtMs === undefined || sample.runTerminalAtMs === undefined
              ? [] : [sample.runTerminalAtMs - sample.runCreatedAtMs])),
          cancel_202: quantiles(cancelled.flatMap((sample) => sample.cancelLatencyMs === undefined
            ? [] : [sample.cancelLatencyMs])),
          cancel_convergence: quantiles(cancelled.flatMap((sample) =>
            sample.cancelAcceptedAtMs === undefined || sample.observedTerminalAtMs === undefined
              ? [] : [sample.observedTerminalAtMs - sample.cancelAcceptedAtMs])),
          database_probe_roundtrip: quantiles(dbSamples.flatMap((sample) =>
            sample.roundtrip_ms === undefined ? [] : [sample.roundtrip_ms])),
        },
        throughput_success_per_second: Number.isFinite(firstStarted) && Number.isFinite(lastCompleted) &&
          lastCompleted > firstStarted ? Math.round(completed.length * 100_000 /
            (lastCompleted - firstStarted)) / 100 : null,
        database: { probe_samples: dbSamples.length,
          failed_probe_samples: dbSamples.filter((sample) => sample.error !== undefined).length,
          samples_with_lock_waiters: dbSamples.filter((sample) => (sample.lock_waiters ?? 0) > 0).length,
          max_lock_waiters_observed: Math.max(0, ...dbSamples.map((sample) => sample.lock_waiters ?? 0)) },
        retries_observed: samples.reduce((sum, sample) => sum + (sample.retryCount ?? 0), 0),
        resources: summarizeResources(resources),
        measurement_notes: [
          'P95/P99 are descriptive order statistics only when fewer than 100 samples are present.',
          'First output is DRAFT persisted, not a streamed first token; candidate is PERSIST_CANDIDATE finished.',
          'Run completion uses database timestamps; cancellation convergence ends at a 500 ms HTTP poll observation.',
          'Node tree RSS is sampled from instrumented child processes and omits PostgreSQL server memory.',
          'The 250 ms Mock model delay is test-only and part of this fixed workload.',
        ],
        not_measured: ['first streamed token (FakeModelPort is not streamed)',
          'actual Provider token cost', 'PostgreSQL server process CPU/RSS',
          'production desktop process tree'],
      };
      await writeFile(join(outputDir, 'raw.json'), JSON.stringify({ samples, dbSamples,
        resourceRecords: resources }, null, 2));
      await writeFile(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));
      process.stdout.write(`${JSON.stringify({ type: 'm03_mock_benchmark_summary',
        status: summary.status, success: completed.length, cancelled: cancelled.length,
        evidence_dir: outputDir })}\n`);
      if (failure !== null && !failedDuringRun) throw new Error(failure);
    }
  });
