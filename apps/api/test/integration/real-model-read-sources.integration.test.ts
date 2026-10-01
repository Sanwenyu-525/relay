// Opt-in M04 composition: real Gateway reads and the configured real Provider.
// No valid model configuration means no API, source listener or model call is started.
// All source content is synthetic; credentials remain in the inherited environment.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createGatewayConnectionCommand } from '../../src/application/gateway-commands.js';
import { createGatewayPolicy, registerManagedResource }
  from '../../src/application/gateway-configuration.js';
import { attachReadEvidenceWithinBudget, draftInputHash, loadRunReadEvidence }
  from '../../src/application/run-read-evidence.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import type { ContextManifestRow, ModelCallRow }
  from '../../src/infrastructure/database-schema.js';
import { installGraphCheckpoints } from '../../src/infrastructure/graph-checkpoints.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { canonicalizeJson } from '../../src/receipt/payload-hash.js';
import { extractWebText, WEB_TEXT_EXTRACTOR } from '../../src/web/web-fetch.js';
import { runOneCommand } from '../../src/worker/run-command.js';
import { readFileReadAction, readWebFetchAction } from '../../src/workflow/execution-contract.js';
import { CANDIDATE_OUTPUT_SCHEMA } from '../../src/workflow/markdown-deliverable.js';
import { computeModelConfigFingerprint, describeModelPortStatus, readModelPortConfig }
  from '../../src/workflow/model-port-config.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath,
  type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase }
  from './integration-support.js';

const modelReady = describeModelPortStatus(process.env).configured;
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-real-read-sources');
let api: TestApi | undefined;

before(async () => {
  if (!modelReady) return;
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  await installGraphCheckpoints(MIGRATION_DATABASE_URL);
  api = await startTestApi();
});

after(async () => {
  const closed = await Promise.allSettled([api?.stop(), app.close()]);
  const failures = closed.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, 'real read-source cleanup failed');
  if (api) {
    assert.equal(closed[0]!.status, 'fulfilled');
    if (closed[0]!.status === 'fulfilled') assert.equal(closed[0]!.value, 0);
    console.log('real_read_source_cleanup api_exit=0 temporary_data_removed=true');
  }
});

async function command(workspaceId: string, path: string, body: object,
  status: 200 | 201 | 202): Promise<Record<string, unknown>> {
  assert.ok(api);
  const commandId = randomUUID();
  return expectCommandAccepted(await api.post(workspacePath(workspaceId, path),
    { ...body, command_id: commandId }), status, commandId);
}

async function syntheticTask(kind: string): Promise<{
  workspaceId: string; projectId: string; taskId: string; revision: string;
}> {
  const workspaceId = await createWorkspace(app.db);
  const project = await command(workspaceId, '/projects', {
    title: 'M04 synthetic ' + kind, project_type: 'GENERAL',
  }, 201);
  const projectId = project.project_id as string;
  const task = await command(workspaceId, '/tasks', {
    project_id: projectId, title: 'Synthetic ' + kind + ' candidate',
    objective: 'Write a short Markdown candidate from the frozen Gateway read source. '
      + 'Copy the unique ASCII marker found in that source verbatim, without changing or omitting it.',
    criteria: [{ criterion_id: 'human', statement: 'Human acceptance of the synthetic candidate',
      required: true, method: 'HUMAN' }],
  }, 201);
  const taskId = task.task_id as string;
  const ready = await command(workspaceId, '/tasks/' + taskId + '/ready', {
    expected_revision: task.revision,
  }, 200);
  return { workspaceId, projectId, taskId, revision: ready.revision as string };
}

async function sourcePage(body: string): Promise<{
  url: string; requests(): number; close(): Promise<void>;
}> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    if (request.method !== 'GET' || request.url !== '/source' ||
        request.headers.authorization !== undefined || request.headers.cookie !== undefined) {
      response.writeHead(400); response.end(); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: 'http://127.0.0.1:' + address.port + '/source', requests: () => requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) =>
        error ? reject(error) : resolve()));
      assert.equal(server.listening, false);
      assert.equal(server.address(), null);
    },
  };
}

for (const kind of ['FILE_READ', 'WEB_FETCH'] as const) {
  test('M04 ' + kind + ' supplies its original read to a real DRAFT and HUMAN completion',
    { skip: !modelReady && 'valid RELAY_MODEL_* configuration not ready', timeout: 240_000 }, async () => {
      assert.ok(api);
      const configured = readModelPortConfig(process.env);
      assert.ok(configured);
      const task = await syntheticTask(kind);
      const { workspaceId, projectId, taskId } = task;
      const marker = 'RELAY_M04_READ_' + randomUUID().replaceAll('-', '').toUpperCase();
      assert.match(marker, /^[A-Z0-9_]+$/u);
      const text = 'Synthetic source only. The fictional greenhouse is called Moonlight. Marker: ' + marker;
      const body = kind === 'FILE_READ' ? text : '<html><body><p>' + text + '</p></body></html>';
      const expectedText = kind === 'FILE_READ' ? text : extractWebText(body);
      const sourceHash = createHash('sha256').update(body, 'utf8').digest('hex');
      let page: Awaited<ReturnType<typeof sourcePage>> | undefined;
      let targetPath: string | undefined;
      try {
        let action: object;
        if (kind === 'FILE_READ') {
          const root = join(api.dataRoot, 'synthetic-read-' + randomUUID());
          await mkdir(root);
          targetPath = join(root, 'source.txt');
          await writeFile(targetPath, body, 'utf8');
          const resource = await registerManagedResource(app.db, { workspaceId, projectId, rootPath: root });
          const connection = await createGatewayConnectionCommand(app.db, { workspaceId, projectId,
            commandId: randomUUID(), capabilities: ['FILE_READ'], rootPath: resource.canonicalRoot });
          await createGatewayPolicy(app.db, { workspaceId, projectId, capability: 'FILE_READ',
            actionType: 'READ_FILE', targetPrefix: resource.canonicalRoot, decision: 'AUTO',
            maxPayloadBytes: 1024 });
          action = { file_read_action: { connection_id: connection.result.connection_id,
            resource_id: resource.resourceId, relative_target: 'source.txt' } };
        } else {
          page = await sourcePage(body);
          const connection = await createGatewayConnectionCommand(app.db, { workspaceId, projectId,
            commandId: randomUUID(), capabilities: ['WEB_FETCH'], allowedHost: '127.0.0.1',
            allowPrivate: true });
          await createGatewayPolicy(app.db, { workspaceId, projectId, capability: 'WEB_FETCH',
            actionType: 'WEB_FETCH', targetPrefix: '127.0.0.1', decision: 'AUTO', maxPayloadBytes: 1024 });
          action = { web_fetch_action: { connection_id: connection.result.connection_id, url: page.url } };
        }
        const delegated = await command(workspaceId, '/tasks/' + taskId + '/delegations', {
          expected_task_revision: task.revision, ...action,
        }, 202);
        const runId = delegated.run_id as string;
        const r = createRepositories(app.db);
        const contract = await r.runs.readContract(runId);
        assert.ok(contract);
        const frozen = kind === 'FILE_READ' ? readFileReadAction(contract.frozen_snapshot)
          : readWebFetchAction(contract.frozen_snapshot);
        assert.ok(frozen);
        const operationId = frozen.operation_id;
        const delivery = await runOneCommand(app.db, { workerId: 'real-read-' + randomUUID(),
          dataRoot: api.dataRoot, checkpointUrl: APP_DATABASE_URL });
        assert.equal(delivery?.runId, runId);
        assert.equal(delivery?.outcome, 'DONE');
        assert.equal((await r.runs.readRun(runId))?.status, 'WAITING_APPROVAL');

        const operation = await r.gateway.readOperation(operationId);
        assert.ok(operation);
        assert.equal(operation.run_id, runId);
        assert.equal(operation.capability_key, kind);
        assert.equal(operation.connection_id, frozen.connection_id);
        const connection = await r.gateway.readConnection(operation.connection_id);
        assert.ok(connection);
        assert.equal(operation.connection_version, connection.version);
        assert.deepEqual(operation.connection_config, connection.config);
        const capability = (await sql<{ adapter_kind: string; effect_kind: string }>`
          select adapter_kind, effect_kind from gateway_capabilities
          where capability_key=${operation.capability_key}`.execute(app.db)).rows[0];
        assert.deepEqual(capability, { adapter_kind: 'REAL', effect_kind: 'READ' });
        assert.equal(operation.status, 'SUCCEEDED');
        const invocations = await r.gateway.listInvocations(operationId);
        assert.equal(invocations.length, 1);
        const invocation = invocations[0]!;
        assert.equal(invocation.status, 'SUCCEEDED');
        assert.equal(invocation.result_ref?.operation_id, operationId);
        assert.equal(invocation.result_ref?.invocation_id, invocation.id);
        assert.equal(invocation.result_ref?.sha256, sourceHash);
        assert.equal(invocation.result_ref?.content, expectedText);
        assert.deepEqual(invocation.result_ref, operation.result_ref);
        if (page) {
          assert.equal(page.requests(), 1);
          assert.equal(invocation.result_ref?.extractor, WEB_TEXT_EXTRACTOR);
        }
        if (targetPath) assert.equal(await readFile(targetPath, 'utf8'), body);
        const read = await loadRunReadEvidence(r, runId);
        assert.ok(read);
        assert.equal(read.operationId, operationId);
        assert.equal(read.invocationId, invocation.id);
        assert.equal(read.input.content, expectedText);
        assert.equal(read.input.trust, 'UNTRUSTED_DATA');
        assert.equal(read.input.input_truncated, false);
        assert.equal(read.input.source_sha256, sourceHash);
        assert.equal(read.input.included_sha256,
          createHash('sha256').update(expectedText, 'utf8').digest('hex'));

        const calls = (await sql<ModelCallRow>`select c.* from model_calls c
          join step_attempts a on a.id=c.step_attempt_id join run_steps s on s.id=a.step_id
          where s.run_id=${runId}`.execute(app.db)).rows;
        assert.equal(calls.length, 1, 'one real DRAFT call and no implicit model retry');
        const call = calls[0]!;
        assert.equal(call.kind, 'DRAFT');
        assert.equal(call.status, 'COMPLETED');
        assert.equal(call.provider, 'openai-compatible');
        assert.equal(call.model, configured.model);
        assert.equal(call.config_fingerprint, computeModelConfigFingerprint(configured));
        assert.equal(call.read_operation_id, operationId);
        assert.equal(call.read_invocation_id, invocation.id);
        assert.ok((call.usage_input_tokens ?? 0) > 0);
        assert.ok((call.usage_output_tokens ?? 0) > 0);
        assert.ok(call.provider_request_id);
        const manifests = (await sql<ContextManifestRow>`select * from context_manifests
          where id=${call.manifest_id} and run_id=${runId}`.execute(app.db)).rows;
        assert.equal(manifests.length, 1);
        const manifest = manifests[0]!;
        assert.equal(manifest.manifest_hash.toString('hex'),
          createHash('sha256').update(canonicalizeJson(manifest.payload)).digest('hex'));
        assert.ok(!canonicalizeJson(manifest.payload).includes(marker),
          'the marker must enter only through the read source, never the Task or frozen contract');
        assert.equal(call.input_sha256, draftInputHash(
          attachReadEvidenceWithinBudget(manifest.payload, read), CANDIDATE_OUTPUT_SCHEMA));
        const draft = await r.runs.readStepByKind(runId, 'DRAFT');
        assert.ok(draft);
        const attempts = await r.runs.listAttempts(draft.id);
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0]!.id, call.step_attempt_id);
        assert.equal(attempts[0]!.status, 'SUCCEEDED');
        assert.equal(attempts[0]!.result_ref?.input_sha256, call.input_sha256);
        assert.equal(typeof attempts[0]!.result_ref?.content, 'string');
        assert.ok((attempts[0]!.result_ref!.content as string).includes(marker));
        assert.ok(!(attempts[0]!.result_ref!.content as string).includes('本候选依据目标'));
        assert.equal((await sql<{ count: bigint }>`select count(*) as count
          from completion_records where task_id=${taskId}`.execute(app.db)).rows[0]?.count, 0n);

        const listed = await api.get(workspacePath(workspaceId, '/reviews?status=OPEN'));
        assert.equal(listed.status, 200);
        const reviews = (listed.body as { items: { id: string; run_id: string; kind: string;
          revision: string; target_hash: string }[] }).items.filter((item) => item.run_id === runId);
        assert.equal(reviews.length, 1);
        const review = reviews[0]!;
        assert.equal(review.kind, 'CRITERION');
        await command(workspaceId, '/reviews/' + review.id + '/decisions', {
          expected_revision: review.revision, target_hash: review.target_hash, decision: 'ACCEPT',
        }, 200);
        const resumed = await runOneCommand(app.db, { workerId: 'real-read-resume-' + randomUUID(),
          dataRoot: api.dataRoot, checkpointUrl: APP_DATABASE_URL });
        assert.equal(resumed?.runId, runId);
        assert.equal(resumed?.outcome, 'DONE');
        assert.equal((await r.runs.readRun(runId))?.status, 'COMPLETED');
        assert.equal((await r.tasks.readTask(taskId))?.status, 'DONE');
        assert.equal((await sql<{ count: bigint }>`select count(*) as count from completion_records
          where task_id=${taskId} and run_id=${runId}`.execute(app.db)).rows[0]?.count, 1n);
        assert.equal((await sql<{ count: bigint }>`select count(*) as count from artifact_versions
          where source_ref like ${'run:' + runId + '/%'}`.execute(app.db)).rows[0]?.count, 1n);
        assert.deepEqual(await r.gateway.listInvocations(operationId), invocations);
        const resumedCalls = (await sql<ModelCallRow>`select c.* from model_calls c
          join step_attempts a on a.id=c.step_attempt_id join run_steps s on s.id=a.step_id
          where s.run_id=${runId}`.execute(app.db)).rows;
        assert.deepEqual(resumedCalls, calls, 'HUMAN resume must preserve the original model call');
        if (page) assert.equal(page.requests(), 1);
        console.log('real_read_source kind=' + kind + ' operation_id=' + operationId
          + ' invocation_id=' + invocation.id + ' call_id=' + call.id
          + ' gateway_calls=1 model_calls=1 completion_records=1 synthetic_input=true');
      } finally { await page?.close(); }
    });
}
