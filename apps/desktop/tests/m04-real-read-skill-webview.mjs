// Opt-in, synthetic-only Windows WebView2 composition. Business writes use HTTP Owners or UI.
// Usage: pinned node this-file EXE_SHA 0013_SHA manifest_SHA 0047_SHA apps/api/.env [read|skills|all]
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { state, releaseRoot, frozenPackage, sha, sql, waitFor,
  startSession, startHost, watchWebView, post, get, assertRuntimeRoleSeparation,
  processSnapshot, assertStopped, expect, uuid, runDesktopAcceptance }
  from './m03-review-resume-webview.mjs';

const scenario = process.argv[7] ?? 'all';
const skillIds = ['task-to-execution-contract', 'verification-plan', 'project-resume'];
const skillFilter = process.argv[8];
assert.ok(['read', 'skills', 'all'].includes(scenario) && process.argv.length <= 9 &&
  (!skillFilter || (scenario === 'skills' && skillIds.includes(skillFilter))),
  'select read, skills or all; an optional exact Skill id is supported only with skills');
for (const [index, relative] of [[4, 'desktop-build-manifest.json'],
  [5, 'api/migrations/0047_m04_model_call_first_output.sql']]) {
  assert.match(process.argv[index] ?? '', /^[0-9a-f]{64}$/u, 'a frozen SHA256 input is missing');
  const path = join(releaseRoot, relative);
  assert.equal(sha(path), process.argv[index], 'a frozen package input changed');
  frozenPackage.set(path, process.argv[index]);
}
const configPath = resolve(process.argv[6] ?? '');
assert.equal(configPath.toLowerCase(), resolve('D:/Develop/Relay-Agent/apps/api/.env').toLowerCase(),
  'only the previously authorized original project model configuration is supported');
const configSha = sha(configPath);
const modelKeys = ['RELAY_MODEL_PROVIDER', 'RELAY_MODEL_API_KEY', 'RELAY_MODEL_NAME',
  'RELAY_MODEL_BASE_URL', 'RELAY_MODEL_TIMEOUT_MS', 'RELAY_MODEL_MAX_OUTPUT_TOKENS',
  'RELAY_MODEL_MAX_CALL_TOKENS', 'RELAY_MODEL_MAX_SCOPE_CALLS', 'RELAY_MODEL_MAX_SCOPE_TOKENS'];
const parsed = parseEnv(readFileSync(configPath, 'utf8'));
const model = Object.fromEntries(modelKeys.filter((key) => parsed[key] !== undefined)
  .map((key) => [key, parsed[key]]));
assert.equal(model.RELAY_MODEL_PROVIDER, 'openai-compatible', 'the authorized real Provider is disabled');
assert.ok(model.RELAY_MODEL_API_KEY && model.RELAY_MODEL_NAME, 'authorized model configuration is incomplete');
for (const value of Object.values(model)) assert.ok(!/[\r\n"\\]/u.test(value),
  'model configuration cannot be copied safely');
const secrets = [model.RELAY_MODEL_API_KEY];

// Reuse only pure production functions, never a test Provider or a second business writer.
async function packaged(relative) {
  const path = join(releaseRoot, 'api/dist/src', relative);
  frozenPackage.set(path, sha(path));
  return import(pathToFileURL(path).href);
}
const [{ canonicalizeJson }, { attachReadEvidenceWithinBudget, draftInputHash },
  { CANDIDATE_OUTPUT_SCHEMA }, { extractWebText, WEB_TEXT_EXTRACTOR },
  { readModelPortConfig, computeModelConfigFingerprint },
  { FIRST_PARTY_REGISTRY, frozenSkillIdentity, frozenSkillSnapshot }] = await Promise.all([
  packaged('receipt/payload-hash.js'), packaged('application/run-read-evidence.js'),
  packaged('workflow/markdown-deliverable.js'), packaged('web/web-fetch.js'),
  packaged('workflow/model-port-config.js'), packaged('skills/first-party-registry.js'),
]);
frozenPackage.set(fileURLToPath(import.meta.url), sha(fileURLToPath(import.meta.url)));
const configured = readModelPortConfig(model);
assert.ok(configured, 'real model configuration did not pass production validation');
const fingerprint = computeModelConfigFingerprint(configured);
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const objectHash = (value) => hash(canonicalizeJson(value));
const same = (actual, expected, reason) => assert.equal(objectHash(actual), objectHash(expected), reason);
const row = async (query) => JSON.parse(await sql(query));
const listeners = [];
let page, bootstrap, ledger;

async function fixture(label, objective) {
  const project = (await post(bootstrap, '/projects', { command_id: randomUUID(),
    title: `M04 synthetic ${label}`, project_type: 'GENERAL' }, 201)).result;
  assert.match(project.project_id, uuid);
  const task = (await post(bootstrap, '/tasks', { command_id: randomUUID(),
    project_id: project.project_id, title: `Synthetic ${label} briefing`, objective,
    expected_outputs: { artifacts: ['MARKDOWN_DOCUMENT'], description: 'Original synthetic briefing',
      retention: { policy: 'keep-original' } },
    criteria: [{ criterion_id: 'human', statement: 'Human confirms the briefing is explicitly fictional',
      required: true, method: 'HUMAN', target_spec: {} }] }, 201)).result;
  assert.match(task.task_id, uuid);
  const ready = (await post(bootstrap, `/tasks/${task.task_id}/ready`, {
    command_id: randomUUID(), expected_revision: task.revision }, 200)).result;
  return { projectId: project.project_id, taskId: task.task_id, revision: ready.revision };
}

// Capture the exact original WebView request, without logging its body or model output.
async function uiCommand(pathPattern, click, status) {
  const base = `${bootstrap.baseUrl}/api/v1/workspaces/${bootstrap.workspaceId}`;
  const matches = (request) => request.method() === 'POST' && request.url().startsWith(base + '/') &&
    pathPattern.test(new URL(request.url()).pathname.slice(new URL(base).pathname.length));
  const requests = [];
  const observe = (request) => { if (matches(request)) requests.push(request); };
  page.on('request', observe);
  try {
    const pending = page.waitForResponse((response) => matches(response.request()), { timeout: 20_000 });
    void pending.catch(() => undefined);
    await click();
    const response = await pending;
    assert.equal(response.status(), status, 'the actual UI command failed');
    assert.equal(requests.length, 1, 'the UI submitted more than one original command');
    const body = JSON.parse(response.request().postData());
    assert.match(body.command_id, uuid);
    return { body, receipt: await response.json(), path: new URL(response.url()).pathname
      .slice(new URL(base).pathname.length) };
  } finally { page.off('request', observe); }
}

const callFields = ['id', 'kind', 'step_attempt_id', 'assist_message_id', 'manifest_id',
  'provider', 'model', 'config_fingerprint', 'input_sha256', 'read_operation_id',
  'read_invocation_id', 'provider_request_id', 'status', 'usage_input_tokens',
  'usage_output_tokens', 'error_kind', 'started_at', 'settled_at'];
async function calls(where) {
  return row(`select coalesce(json_agg(json_build_object(${callFields.map((key) =>
    `'${key}',c.${key}`).join(',')}) order by c.id)::text,'[]') from model_calls c where ${where}`);
}
const runCalls = (runId) => calls(`c.step_attempt_id in (select a.id from step_attempts a
  join run_steps s on s.id=a.step_id where s.run_id='${runId}')`);
function realCall(call, kind) {
  assert.equal(call.kind, kind);
  assert.equal(call.status, 'COMPLETED');
  assert.equal(call.error_kind, null);
  assert.equal(call.provider, 'openai-compatible');
  assert.equal(call.model, configured.model);
  assert.equal(call.config_fingerprint, fingerprint);
  assert.ok(call.provider_request_id && call.usage_input_tokens > 0 && call.usage_output_tokens > 0,
    'real Provider request identity or usage is missing');
  assert.ok(Number.isFinite(Date.parse(call.started_at)) &&
    Date.parse(call.settled_at) >= Date.parse(call.started_at), 'model call settlement is missing');
}

async function sourcePage(body) {
  const path = `/m04-synthetic-${randomUUID()}`;
  let hits = 0, rejected = 0;
  const server = createServer((request, response) => {
    if (request.url !== path) { response.writeHead(404); response.end(); return; }
    if (request.method !== 'GET' || request.headers.authorization !== undefined ||
      request.headers.cookie !== undefined) {
      rejected++; response.writeHead(400); response.end(); return;
    }
    hits++;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(body);
  });
  const source = { server, port: null, url: null, closed: false,
    hits: () => hits, rejected: () => rejected };
  listeners.push(source);
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  source.port = server.address().port;
  source.url = `http://127.0.0.1:${source.port}${path}`;
  return source;
}
async function closeSource(source) {
  if (source.closed) return;
  source.server.closeAllConnections();
  if (source.server.listening) await new Promise((done, fail) =>
    source.server.close((error) => error ? fail(error) : done()));
  assert.equal(source.server.listening, false);
  assert.equal(source.server.address(), null);
  if (source.port !== null) await new Promise((done, fail) => {
    const socket = createConnection({ host: '127.0.0.1', port: source.port });
    socket.setTimeout(2000, () => { socket.destroy(); fail(new Error('owned source listener probe timed out')); });
    socket.once('connect', () => { socket.destroy(); fail(new Error('owned source listener is still reachable')); });
    socket.once('error', (error) => { socket.destroy();
      if (error.code === 'ECONNREFUSED') done(); else fail(new Error('owned source listener shutdown is unverified')); });
  });
  source.closed = true;
  console.log(`synthetic_source_listener_closed=true port=${source.port}`);
}

async function reviewFor(runId, kind) {
  return waitFor(async () => {
    const run = await get(bootstrap, `/runs/${runId}`);
    assert.ok(!['FAILED', 'CANCELLED'].includes(run.status), `real ${kind} Run failed before Review`);
    const reviews = (await get(bootstrap, `/runs/${runId}/reviews`)).items
      .filter((item) => item.kind === kind && item.status === 'OPEN');
    assert.ok(reviews.length <= 1, 'the Run has duplicate open Reviews');
    return reviews[0] ?? null;
  }, 180_000, `original ${kind} Review`);
}
async function decide(review, decision) {
  await page.goto(`http://tauri.localhost/reviews?id=${review.id}`);
  const submitted = await uiCommand(new RegExp(`^/reviews/${review.id}/decisions$`, 'u'),
    () => page.getByTestId(`review-decision-${decision}`).click(), 200);
  assert.equal(submitted.body.decision, decision);
  assert.equal(submitted.body.expected_revision, review.revision);
  assert.equal(submitted.body.target_hash, review.target_hash);
  return submitted;
}

async function readEvidence(runId, f, kind, source) {
  const contracts = await row(`select coalesce(json_agg(json_build_object('run_id',run_id,
    'snapshot',frozen_snapshot,'hash',encode(contract_hash,'hex')))::text,'[]')
    from execution_contracts where run_id='${runId}'`);
  assert.equal(contracts.length, 1);
  const contract = contracts[0];
  assert.equal(contract.hash, objectHash(contract.snapshot));
  assert.ok(!canonicalizeJson(contract.snapshot).includes(source.marker),
    'the source marker leaked into the frozen Task contract');
  const action = contract.snapshot[kind === 'FILE_READ' ? 'file_read_action' : 'web_fetch_action'];
  assert.ok(action, 'the original Run did not freeze the UI-selected read action');
  assert.match(action.operation_id, uuid);
  assert.equal(action.connection_id, source.connectionId);
  if (kind === 'FILE_READ') {
    assert.equal(action.resource_id, source.resourceId);
    assert.equal(action.relative_target, 'source.txt');
  } else assert.equal(action.url, source.url);
  const operations = await row(`select coalesce(json_agg(json_build_object('id',id,
    'origin',origin,'task_id',task_id,'run_id',run_id,'step_id',step_id,'status',status,
    'capability_key',capability_key,'connection_id',connection_id,
    'connection_version',connection_version::text,'connection_config',connection_config,
    'policy_id',policy_id,'normalized_target',normalized_target,'result_ref',result_ref))::text,'[]')
    from logical_operations where run_id='${runId}'`);
  assert.equal(operations.length, 1);
  const operation = operations[0];
  assert.equal(operation.id, action.operation_id);
  assert.equal(operation.origin, 'RUN');
  assert.equal(operation.task_id, f.taskId);
  assert.equal(operation.run_id, runId);
  assert.equal(operation.capability_key, kind);
  assert.equal(operation.status, 'SUCCEEDED');
  assert.equal(operation.connection_id, source.connectionId);
  assert.equal(operation.policy_id, source.policyId);
  const connection = await row(`select json_build_object('version',version::text,
    'config',config)::text from gateway_connections where id='${source.connectionId}'`);
  assert.equal(operation.connection_version, connection.version);
  same(operation.connection_config, connection.config, 'original connection config changed');
  const capability = await row(`select json_build_object('adapter_kind',adapter_kind,
    'effect_kind',effect_kind)::text from gateway_capabilities where capability_key='${kind}'`);
  same(capability, { adapter_kind: 'REAL', effect_kind: 'READ' }, 'read capability is not real/read');
  const invocations = await row(`select coalesce(json_agg(json_build_object('id',id,
    'operation_id',operation_id,'run_id',run_id,'task_id',task_id,'status',status,
    'connection_version',connection_version::text,'connection_config',connection_config,
    'result_ref',result_ref) order by attempt_number)::text,'[]')
    from invocation_attempts where operation_id='${operation.id}'`);
  assert.equal(invocations.length, 1, 'the original read was implicitly retried');
  const invocation = invocations[0];
  assert.match(invocation.id, uuid);
  assert.equal(invocation.status, 'SUCCEEDED');
  assert.equal(invocation.operation_id, operation.id);
  assert.equal(invocation.run_id, runId);
  assert.equal(invocation.task_id, f.taskId);
  assert.equal(invocation.connection_version, operation.connection_version);
  same(invocation.connection_config, operation.connection_config, 'Invocation config differs from original operation');
  const result = invocation.result_ref;
  assert.ok(result);
  same(result, operation.result_ref, 'operation and original Invocation result differ');
  assert.equal(result.operation_id, operation.id);
  assert.equal(result.invocation_id, invocation.id);
  assert.equal(result.sha256, hash(source.body));
  assert.equal(hash(result.content), hash(source.text), 'original read content differs from physical source');
  const target = kind === 'FILE_READ' ? result.target : result.url;
  assert.equal(target, operation.normalized_target);
  if (kind === 'WEB_FETCH') {
    assert.equal(target, source.url);
    assert.equal(result.extractor, WEB_TEXT_EXTRACTOR);
    assert.equal(source.listener.hits(), 1);
    assert.equal(source.listener.rejected(), 0);
  } else assert.equal(sha(source.file), hash(source.body), 'physical source was changed');
  const read = { operationId: operation.id, invocationId: invocation.id, input: {
    kind, trust: 'UNTRUSTED_DATA', operation_id: operation.id, invocation_id: invocation.id,
    target: operation.normalized_target, source_sha256: result.sha256,
    content_sha256: hash(result.content), included_sha256: hash(result.content),
    content_bytes: Buffer.byteLength(result.content, 'utf8'),
    included_bytes: Buffer.byteLength(result.content, 'utf8'), input_truncated: false,
    adapter_truncated: result.text_truncated === true, text_available: result.text_available !== false,
    content: result.content, ...(kind === 'WEB_FETCH' ? { final_url: result.final_url ?? target,
      extractor: result.extractor ?? null } : {}) } };
  assert.equal(read.input.source_sha256, hash(source.body));
  assert.equal(read.input.included_sha256, hash(source.text));
  const modelCalls = await runCalls(runId);
  assert.equal(modelCalls.length, 1, 'the Run must make exactly one actual DRAFT call');
  const call = modelCalls[0];
  realCall(call, 'DRAFT');
  assert.equal(call.assist_message_id, null);
  assert.equal(call.read_operation_id, operation.id);
  assert.equal(call.read_invocation_id, invocation.id);
  const manifest = await row(`select json_build_object('payload',payload,
    'hash',encode(manifest_hash,'hex'),'step_id',step_id)::text from context_manifests
    where id='${call.manifest_id}' and run_id='${runId}'`);
  assert.equal(manifest.hash, objectHash(manifest.payload));
  assert.ok(!canonicalizeJson(manifest.payload).includes(source.marker),
    'the marker must enter only through the physical Gateway read');
  const originalSteps = await row(`select coalesce(json_agg(json_build_object('id',id,
    'kind',step_kind))::text,'[]') from run_steps where run_id='${runId}'`);
  assert.ok(originalSteps.some((step) => step.id === operation.step_id &&
    ['BUILD_CONTEXT', 'DRAFT'].includes(step.kind)), 'read action is not bound to an original Run step');
  const modelManifest = attachReadEvidenceWithinBudget(manifest.payload, read);
  assert.equal(modelManifest.tool_read.input_truncated, false, 'synthetic source did not fit the actual input budget');
  assert.equal(modelManifest.tool_read.included_sha256, hash(source.text));
  assert.equal(call.input_sha256, draftInputHash(modelManifest, CANDIDATE_OUTPUT_SCHEMA),
    'DRAFT did not consume the original read evidence');
  const attempts = await row(`select coalesce(json_agg(json_build_object('id',a.id,
    'status',a.status,'result_ref',a.result_ref) order by a.attempt_number)::text,'[]')
    from step_attempts a join run_steps s on s.id=a.step_id
    where s.run_id='${runId}' and s.step_kind='DRAFT'`);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].id, call.step_attempt_id);
  assert.equal(attempts[0].status, 'SUCCEEDED');
  assert.equal(attempts[0].result_ref.input_sha256, call.input_sha256);
  assert.ok(typeof attempts[0].result_ref.content === 'string' &&
    attempts[0].result_ref.content.includes(source.marker), 'real DRAFT omitted the unique physical-source marker');
  return { operationId: operation.id, invocationId: invocation.id, callId: call.id,
    candidateHash: hash(attempts[0].result_ref.content),
    candidateBytes: Buffer.byteLength(attempts[0].result_ref.content, 'utf8'),
    digest: objectHash({ contracts, operations, invocations, modelCalls, attempts }) };
}

async function candidateVersion(f, runId, criterion, evidence) {
  const versions = await row(`select coalesce(json_agg(json_build_object('id',v.id,
    'artifact_id',v.artifact_id,'storage_ref',v.storage_ref,'hash',encode(v.content_hash,'hex'),
    'size',v.size::text,'source_ref',v.source_ref))::text,'[]') from artifact_versions v
    join artifacts a on a.id=v.artifact_id where a.task_id='${f.taskId}'`);
  assert.equal(versions.length, 1, 'read Run did not publish exactly one candidate version');
  const version = versions[0];
  assert.match(version.id, uuid);
  const persist = await row(`select result_ref::text from run_steps where run_id='${runId}'
    and step_kind='PERSIST_CANDIDATE' and status='SUCCEEDED'`);
  assert.equal(persist.artifact_version_id, version.id);
  assert.equal(criterion.target.artifact_version_id, version.id, 'Review accepted a different candidate');
  assert.equal(criterion.target.content_hash, version.hash);
  assert.equal(version.hash, evidence.candidateHash, 'published candidate differs from original DRAFT');
  assert.equal(version.size, String(evidence.candidateBytes));
  assert.ok(version.source_ref.startsWith(`run:${runId}/`));
  const { ManagedContentStore } = await packaged('storage/managed-content-store.js');
  const content = await new ManagedContentStore(state.marker.data_root).readWithHashCheck(
    version.storage_ref, { contentHash: Buffer.from(version.hash, 'hex'), size: BigInt(version.size) });
  assert.equal(content.status, 'OK', 'published candidate content is missing, unsafe or tampered');
  assert.equal(hash(content.content), evidence.candidateHash, 'actual candidate bytes differ from original DRAFT');
  return version;
}

async function runRead(kind) {
  const f = await fixture(kind, 'Write a short Markdown briefing from the frozen Gateway read source. '
    + 'Copy the unique ASCII marker found in that source verbatim. Explain that the example is fictional.');
  const marker = 'RELAY_M04_READ_' + randomUUID().replaceAll('-', '').toUpperCase();
  const text = `Synthetic source only. The fictional greenhouse is called Moonlight. Marker: ${marker}`;
  const body = kind === 'FILE_READ' ? text : `<html><body><p>${text}</p></body></html>`;
  const source = { marker, body, text: kind === 'FILE_READ' ? text : extractWebText(body) };
  assert.ok(Buffer.byteLength(body, 'utf8') < 1024);
  const projectPath = `/projects/${f.projectId}`;
  if (kind === 'FILE_READ') {
    const root = join(state.marker.data_root, `synthetic-file-read-${randomUUID()}`);
    assert.ok(resolve(root).toLowerCase().startsWith(resolve(state.marker.data_root).toLowerCase() + '\\'));
    mkdirSync(root);
    source.file = join(root, 'source.txt');
    writeFileSync(source.file, body, { encoding: 'utf8', flag: 'wx' });
    const resource = (await post(bootstrap, `${projectPath}/managed-resources`, {
      command_id: randomUUID(), root_path: root }, 201)).result;
    source.resourceId = resource.resource_id;
    const managed = await get(bootstrap, `${projectPath}/managed-resources/${source.resourceId}`);
    source.connectionId = (await post(bootstrap, `${projectPath}/connections`, {
      command_id: randomUUID(), capabilities: ['FILE_READ'], root_path: managed.canonical_root }, 201))
      .result.connection_id;
  } else {
    source.listener = await sourcePage(body);
    source.url = source.listener.url;
    source.connectionId = (await post(bootstrap, `${projectPath}/connections`, {
      command_id: randomUUID(), capabilities: ['WEB_FETCH'], allowed_host: '127.0.0.1',
      allow_private: true }, 201)).result.connection_id;
  }
  assert.match(source.connectionId, uuid);
  source.policyId = (await post(bootstrap, `${projectPath}/permission-policies`, {
    command_id: randomUUID(), capability: kind, resource_id: source.resourceId ?? null,
    decision: kind === 'FILE_READ' ? 'ASK' : 'AUTO', max_payload_bytes: 1024,
    ...(kind === 'WEB_FETCH' ? { host: '127.0.0.1' } : {}) }, 201)).result.policy_id;
  assert.match(source.policyId, uuid);
  await page.goto(`http://tauri.localhost/tasks/${f.taskId}`);
  await page.getByTestId('task-detail-tab-runs').click();
  const panel = page.getByTestId('task-delegate-panel');
  await panel.getByTestId('task-read-kind').waitFor({ state: 'attached' });
  if (!await panel.getByTestId('task-read-kind').isVisible())
    await panel.getByTestId('delegate-config-toggle').click();
  await panel.getByTestId('task-read-kind').selectOption(kind);
  await expect(panel.getByTestId('task-read-connection')).toBeEnabled();
  await panel.getByTestId('task-read-connection').selectOption(source.connectionId);
  if (kind === 'FILE_READ') {
    await panel.getByTestId('task-read-resource').selectOption(source.resourceId);
    await panel.getByTestId('task-read-relative-target').fill('source.txt');
  } else await panel.getByTestId('task-read-url').fill(source.url);
  await expect(panel.getByTestId('task-read-blocked')).toHaveCount(0);
  await expect(panel.getByTestId('task-delegate')).toBeEnabled();
  const delegated = await uiCommand(new RegExp(`^/tasks/${f.taskId}/delegations$`, 'u'),
    () => panel.getByTestId('task-delegate').click(), 202);
  assert.equal(delegated.body.expected_task_revision, f.revision);
  same(delegated.body.context_sources ?? [], [], 'Delegate gained unselected sources');
  assert.equal(delegated.body.mock_gateway_action, undefined);
  const requested = kind === 'FILE_READ' ? { connection_id: source.connectionId,
    resource_id: source.resourceId, relative_target: 'source.txt' }
    : { connection_id: source.connectionId, url: source.url };
  same(delegated.body[kind === 'FILE_READ' ? 'file_read_action' : 'web_fetch_action'], requested,
    'Delegate request does not match the actual selected read controls');
  assert.equal(delegated.body[kind === 'FILE_READ' ? 'web_fetch_action' : 'file_read_action'], undefined);
  const runId = delegated.receipt.result.run_id;
  assert.match(runId, uuid);
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`, 'u'));
  if (kind === 'FILE_READ') {
    const approval = await reviewFor(runId, 'ACTION_APPROVAL');
    const original = await row(`select (frozen_snapshot->'file_read_action')::text
      from execution_contracts where run_id='${runId}'`);
    assert.equal(approval.target.operation_id, original.operation_id);
    assert.equal(await sql(`select count(*) from invocation_attempts where operation_id='${original.operation_id}'`), '0');
    assert.equal((await runCalls(runId)).length, 0, 'model was called before human read approval');
    assert.equal(await sql(`select count(*) from completion_records where task_id='${f.taskId}'`), '0');
    await decide(approval, 'APPROVE');
  }
  const criterion = await reviewFor(runId, 'CRITERION');
  if (kind === 'WEB_FETCH') assert.equal((await get(bootstrap, `/runs/${runId}/reviews`)).items
    .filter((item) => item.kind === 'ACTION_APPROVAL').length, 0, 'AUTO read unexpectedly asked for approval');
  assert.equal(await sql(`select count(*) from completion_records where task_id='${f.taskId}'`), '0',
    'DRAFT or model output completed the Task before human acceptance');
  const evidence = await readEvidence(runId, f, kind, source);
  const version = await candidateVersion(f, runId, criterion, evidence);
  const accepted = await decide(criterion, 'ACCEPT');
  await waitFor(async () => (await get(bootstrap, `/runs/${runId}`)).status === 'COMPLETED',
    60_000, 'UI human acceptance and Business Commit');
  assert.equal((await get(bootstrap, `/tasks/${f.taskId}`)).status, 'DONE');
  assert.equal(await sql(`select count(*) from runs where task_id='${f.taskId}'`), '1');
  assert.equal(await sql(`select count(*) from completion_records where task_id='${f.taskId}'`), '1');
  assert.equal(await sql(`select count(*) from completion_records where task_id='${f.taskId}' and run_id='${runId}'`), '1');
  assert.equal(await sql(`select count(*) from artifacts where task_id='${f.taskId}'`), '1');
  assert.equal(await sql(`select count(*) from artifact_versions v join artifacts a on a.id=v.artifact_id
    where a.task_id='${f.taskId}'`), '1');
  assert.equal(await sql(`select count(*) from artifact_versions v join artifacts a on a.id=v.artifact_id
    where a.task_id='${f.taskId}' and v.source_ref like 'run:${runId}/%'`), '1');
  same(await candidateVersion(f, runId, criterion, evidence), version, 'accepted candidate version changed');
  const completion = await row(`select json_build_object('id',id,'run_id',run_id,
    'verification_session_id',verification_session_id,'state_delta',state_delta)::text
    from completion_records where task_id='${f.taskId}'`);
  assert.equal(completion.run_id, runId);
  same(completion.state_delta.artifact_version_ids, [version.id], 'Completion lost the exact accepted version');
  assert.equal((await get(bootstrap, `/tasks/${f.taskId}`)).current_completion_id, completion.id);
  assert.match(completion.verification_session_id, uuid);
  const verified = await row(`select json_build_object('run_id',s.run_id,'task_id',s.task_id,
    'status',s.status,'version_id',t.artifact_version_id,'hash',encode(t.content_hash,'hex'))::text
    from verification_sessions s join verification_targets t on t.session_id=s.id
    where s.id='${completion.verification_session_id}'`);
  same(verified, { run_id: runId, task_id: f.taskId, status: 'PASS', version_id: version.id, hash: version.hash },
    'Completion verification does not bind the original candidate');
  const human = await row(`select evidence_refs::text from check_results
    where session_id='${completion.verification_session_id}' and criterion_id='human' and result='PASS'`);
  assert.equal(human.review_decision_id, accepted.receipt.result.decision_id,
    'Completion does not use the original UI Review decision');
  assert.equal((await readEvidence(runId, f, kind, source)).digest, evidence.digest,
    'human acceptance changed original read, DRAFT or model evidence');
  if (source.listener) await closeSource(source.listener);
  console.log(`real_ui_read kind=${kind} task_id=${f.taskId} run_id=${runId} operation_id=${evidence.operationId} invocation_id=${evidence.invocationId} call_id=${evidence.callId} original_read_calls=1 original_draft_calls=1 human_accept=true artifact_versions=1 completion_records=1`);
}

async function businessSnapshot(f) {
  return { project: await get(bootstrap, `/projects/${f.projectId}`),
    state: await get(bootstrap, `/projects/${f.projectId}/state`),
    tasks: await row(`select coalesce(json_agg(json_build_object('id',id,'title',title,'status',status,
      'mode',mode,'executor_kind',executor_kind,'executor_run_id',executor_run_id,
      'revision',revision::text,'acceptance_revision',acceptance_revision::text,
      'ownership_epoch',ownership_epoch::text,'current_completion_id',current_completion_id)
      order by created_at,id)::text,'[]') from tasks where project_id='${f.projectId}'`),
    acceptances: await row(`select coalesce(json_agg(json_build_object('task_id',a.task_id,
      'acceptance_revision',a.acceptance_revision::text,'objective',a.objective,
      'required_output_spec',a.required_output_spec) order by a.task_id,a.acceptance_revision)::text,'[]')
      from task_acceptances a join tasks t on t.id=a.task_id where t.project_id='${f.projectId}'`),
    criteria: await row(`select coalesce(json_agg(json_build_object('task_id',c.task_id,
      'acceptance_revision',c.acceptance_revision::text,'criterion_id',c.criterion_id,
      'statement',c.statement,'required',c.required,'method',c.method,'target_spec',c.target_spec)
      order by c.task_id,c.acceptance_revision,c.criterion_id)::text,'[]')
      from acceptance_criteria c join tasks t on t.id=c.task_id where t.project_id='${f.projectId}'`) };
}
async function noExecution(f) {
  for (const query of [
    `select count(*) from runs r join tasks t on t.id=r.task_id where t.project_id='${f.projectId}'`,
    `select count(*) from artifacts where project_id='${f.projectId}'`,
    `select count(*) from completion_records c join tasks t on t.id=c.task_id where t.project_id='${f.projectId}'`,
    `select count(*) from verification_sessions v join tasks t on t.id=v.task_id where t.project_id='${f.projectId}'`,
    `select count(*) from state_completion_refs where project_id='${f.projectId}'`,
  ]) assert.equal(await sql(query), '0', 'Skill generation or acceptance performed execution or completion');
}
async function taskBasis(f, skill, snapshot) {
  const task = snapshot.tasks.find((item) => item.id === f.taskId);
  const acceptance = snapshot.acceptances.find((item) => item.task_id === f.taskId &&
    item.acceptance_revision === task.acceptance_revision);
  const criteria = snapshot.criteria.filter((item) => item.task_id === f.taskId &&
    item.acceptance_revision === task.acceptance_revision).map((item) => ({
    criterion_id: item.criterion_id, statement: item.statement, required: item.required,
    method: item.method, target_spec: item.target_spec }));
  const facts = { task: { id: task.id, title: task.title, status: task.status, mode: task.mode,
    executor_kind: task.executor_kind, revision: task.revision, acceptance_revision: task.acceptance_revision,
    current_completion_id: task.current_completion_id }, acceptance: { objective: acceptance.objective,
    required_output_spec: acceptance.required_output_spec, criteria } };
  if (skill.id === 'verification-plan') {
    const preview = await get(bootstrap, `/tasks/${f.taskId}/check-plan-preview`);
    assert.equal(preview.status, 'AVAILABLE');
    facts.registered_checks = preview.check_plan.entries.map((entry) => ({
      criterion_id: entry.criterion_id, checker_id: entry.checker_id, checker_version: entry.checker_version,
      required: entry.required, severity: entry.severity }));
  }
  return { facts, baseline: { task_id: task.id, task_revision: task.revision,
    acceptance_revision: task.acceptance_revision, project_id: f.projectId } };
}
function projectBasis(f, snapshot) {
  const { project, state: projectState } = snapshot;
  const tasks = snapshot.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status,
    revision: task.revision, acceptance_revision: task.acceptance_revision,
    current_completion_id: task.current_completion_id, executor_kind: task.executor_kind,
    executor_run_id: task.executor_run_id }));
  assert.equal(projectState.blockers.length + projectState.risks.length +
    projectState.completed_highlight_refs.length, 0, 'resume fixture gained unrelated facts');
  return { baseline: { project_id: f.projectId, project_revision: project.revision,
    state_revision: projectState.revision, tasks: tasks.map((task) => ({ id: task.id,
      revision: task.revision, acceptance_revision: task.acceptance_revision,
      current_completion_id: task.current_completion_id })), decisions: [], verifications: [] },
  facts: { project: { id: f.projectId, title: project.title, project_type: project.project_type,
    revision: project.revision }, state: { revision: projectState.revision, phase_key: projectState.phase_key,
    next_action_task_id: projectState.next_action_task_id, blockers: [], risks: [], completed_highlights: [] },
  tasks, active_decisions: [], current_verifications: [], open_reviews: [] } };
}

async function runSkill(skillId) {
  const taskSkill = skillId !== 'project-resume';
  const version = taskSkill ? '1.1.0' : '1.0.0';
  const f = await fixture(skillId, 'Write a Markdown briefing for a fictional lunar greenhouse. '
    + 'Describe water reuse and lighting as a synthetic example without claiming real measurements.');
  const skill = FIRST_PARTY_REGISTRY.skill(skillId, version);
  assert.ok(skill);
  const registry = await get(bootstrap, `/skill-definitions/${skillId}/versions/${version}`);
  const identity = frozenSkillIdentity(skill);
  for (const [key, value] of Object.entries(identity)) same(registry[key], value, `bundled Skill ${key} differs from API`);
  assert.equal(registry.call_supported, true);
  assert.equal(registry.accept_supported, taskSkill);
  const before = await businessSnapshot(f);
  const basis = taskSkill ? await taskBasis(f, skill, before) : projectBasis(f, before);
  await noExecution(f);
  await page.goto(taskSkill ? `http://tauri.localhost/tasks/${f.taskId}?skill=${skillId === 'verification-plan' ? 'verification' : 'definition'}`
    : `http://tauri.localhost/projects/${f.projectId}?skill=assist`);
  const session = await uiCommand(/^\/assist-sessions$/u, () => page.getByTestId('assist-new-session').click(), 201);
  assert.equal(session.body[taskSkill ? 'task_id' : 'project_id'], taskSkill ? f.taskId : f.projectId);
  const sessionId = session.receipt.result.session_id;
  assert.match(sessionId, uuid);
  const selector = page.getByTestId('assist-skill');
  await selector.waitFor({ state: 'attached' });
  if (!await selector.isVisible()) await page.getByText(/^(发送选项|会话与选项) ·/u).click();
  await expect(selector).toBeEnabled();
  await selector.selectOption(`${skillId}@${version}`);
  const inputText = skillId === 'task-to-execution-contract' ? '虚构月光温室 Markdown 说明，明确区分供水与照明。'
    : taskSkill ? '人工检查正文明确区分供水与照明，不执行检查、不声称通过。' : '当前权威事实与下一步，不作历史变化比较。';
  const input = { [skillId === 'task-to-execution-contract' ? 'desired_result' : taskSkill ? 'risk_focus' : 'focus']: inputText };
  const content = skillId === 'task-to-execution-contract'
    ? '请完善这个虚构任务的 Markdown 期望结果说明，并增加一条必需 HUMAN 条件：人工确认正文明确区分供水与照明。只提出建议，保留原有约束。'
    : taskSkill ? '请只追加一条必需 HUMAN 检查：人工确认正文明确区分供水与照明。保留全部原条件，不执行检查，不声称通过。'
      : '请基于当前权威事实给出项目速览及下一步文字建议。不要修改任何业务状态，不描述自上次以来的变化。';
  await page.getByTestId('assist-skill-input').fill(inputText);
  await page.getByTestId('assist-draft').fill(content);
  const submitted = await uiCommand(new RegExp(`^/assist-sessions/${sessionId}/messages$`, 'u'),
    () => page.getByTestId('assist-send').click(), 202);
  same(submitted.body.skill_ref, { id: skillId, version }, 'UI sent the wrong exact Skill version');
  same(submitted.body.skill_input, input, 'UI sent different Skill input');
  same(submitted.body.source_refs, [], 'UI sent an unselected source');
  assert.equal(hash(submitted.body.content), hash(content), 'UI message changed before submission');
  assert.equal(submitted.body.intent, undefined);
  const messageId = submitted.receipt.result.assistant_message_id;
  assert.match(messageId, uuid);
  const message = await waitFor(async () => {
    const messages = (await get(bootstrap, `/assist-sessions/${sessionId}/messages`)).items;
    assert.equal(messages.length, 2, 'Skill generation gained an implicit retry or extra message');
    const current = messages.find((item) => item.id === messageId);
    assert.ok(current);
    if (['FAILED', 'CANCELLED', 'LEASE_LOST'].includes(current.status)) {
      const code = typeof current.error_code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(current.error_code)
        ? current.error_code : 'OTHER';
      console.log(`real_ui_skill_failure skill=${skillId} message_id=${messageId} status=${current.status} error_code=${code} actual_model_calls=${(await calls(`c.assist_message_id='${messageId}'`)).length}`);
      throw new Error('real Skill failed its original strict contract; no retry or schema downgrade is permitted');
    }
    return current.status === 'COMPLETED' ? current : null;
  }, 180_000, `real ${skillId} settlement`);
  assert.equal(message.session_id, sessionId);
  assert.equal(message.role, 'ASSISTANT');
  assert.equal(message.error_code, null);
  assert.equal(message.provider_error_kind, null);
  same(message.sources, [], 'Skill sources differ from exact UI source selection');
  for (const [key, value] of Object.entries(identity)) same(message.skill[key], value, `frozen Skill ${key} differs`);
  assert.equal(message.skill.definition_availability, 'AVAILABLE');
  assert.equal(message.skill.output_availability, 'HISTORICAL_SNAPSHOT');
  const output = message.skill_output;
  assert.equal(output.kind, skill.definition.output_kind);
  assert.equal(output.status, taskSkill ? 'SUGGESTED' : 'READ_ONLY');
  assert.equal(output.target_kind, taskSkill ? 'TASK' : 'PROJECT');
  assert.equal(output.target_id, taskSkill ? f.taskId : f.projectId);
  same(output.baseline, basis.baseline, 'Skill used a different Task/acceptance or Project baseline');
  assert.equal(output.basis_sha256, objectHash(basis.facts), 'Skill did not use the original authoritative facts');
  assert.equal(output.payload_sha256, objectHash(output.payload));
  assert.ok(Number.isFinite(Date.parse(output.as_of)));
  const original = await row(`select json_build_object('skill_snapshot',skill_snapshot,
    'skill_input',skill_input,'skill_output',skill_output)::text from assist_messages
    where id='${messageId}' and session_id='${sessionId}'`);
  same(original.skill_snapshot, frozenSkillSnapshot(skill), 'stored Skill definition/dependencies differ from bundled original');
  same(original.skill_input, input, 'stored Skill input differs from exact UI input');
  same(original.skill_output, output, 'UI Skill output differs from stored original');
  const modelCalls = await calls(`c.assist_message_id in (select id from assist_messages where session_id='${sessionId}')`);
  assert.equal(modelCalls.length, 1, 'Skill made more than one actual model call');
  realCall(modelCalls[0], 'ASSIST');
  assert.equal(modelCalls[0].assist_message_id, messageId);
  assert.equal(modelCalls[0].step_attempt_id, null);
  assert.equal(modelCalls[0].manifest_id, null);
  assert.equal(modelCalls[0].provider_request_id, message.provider_request_id);
  same(message.usage, { input_tokens: modelCalls[0].usage_input_tokens,
    output_tokens: modelCalls[0].usage_output_tokens }, 'UI message usage differs from original actual model call');
  same(await businessSnapshot(f), before, 'Skill model output changed business facts');
  await noExecution(f);
  const proposals = (await get(bootstrap, `/assist-proposals?session_id=${sessionId}`)).items;
  if (taskSkill) {
    assert.equal(proposals.length, 1, 'Task Skill did not produce exactly one strict merged proposal');
    const proposal = await get(bootstrap, `/assist-proposals/${proposals[0].id}`);
    assert.equal(proposal.message_id, messageId);
    assert.equal(proposal.target_type, 'TASK');
    assert.equal(proposal.target_id, f.taskId);
    assert.equal(proposal.kind, skillId === 'task-to-execution-contract' ? 'TASK_CONTRACT_CHANGE' : 'VERIFICATION_PLAN_CHANGE');
    assert.equal(proposal.status, 'PENDING');
    assert.equal(proposal.decision, null);
    assert.equal(proposal.payload_available, true);
    assert.equal(proposal.base_revision, basis.baseline.task_revision);
    assert.equal(proposal.base_acceptance_revision, basis.baseline.acceptance_revision);
    assert.equal(proposal.skill_sha256, skill.sha256);
    assert.equal(proposal.skill_output_sha256, objectHash(output));
    assert.equal(proposal.payload_hash, objectHash(proposal.payload));
    const old = before.acceptances[0];
    same(proposal.payload.required_output_spec.artifacts, old.required_output_spec.artifacts, 'Skill removed artifact requirements');
    same(proposal.payload.required_output_spec.retention, old.required_output_spec.retention, 'Skill removed original retention');
    for (const criterion of basis.facts.acceptance.criteria) {
      const preserved = proposal.payload.criteria.find((item) => item.criterion_id === criterion.criterion_id);
      assert.ok(preserved);
      for (const key of ['statement', 'required', 'method', 'target_spec']) same(preserved[key], criterion[key], `Skill changed preserved criterion ${key}`);
    }
    assert.ok(proposal.payload.added_criterion_ids.length > 0, 'requested HUMAN criterion was not added');
    for (const id of proposal.payload.added_criterion_ids) {
      const added = proposal.payload.criteria.find((item) => item.criterion_id === id);
      assert.ok(added, 'new criterion id is missing from the exact merged proposal');
      assert.equal(added.required, true, 'requested criterion became optional');
      assert.equal(added.method, 'HUMAN', 'requested criterion lost human acceptance');
    }
    if (skillId === 'verification-plan') {
      same(proposal.payload.objective, old.objective, 'verification Skill changed objective');
      same(proposal.payload.required_output_spec, old.required_output_spec, 'verification Skill changed output contract');
      assert.equal(output.payload.effective_check_plan, false);
    } else same(proposal.payload.required_output_spec.description, output.payload.expected_outputs.description,
      'Task definition proposal lost its original expected result description');
    const card = page.getByTestId('task-skill-proposal');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('task-skill-proposal-status')).toHaveText('提案基线与当前 Task/验收版本一致。');
    await card.getByText('核对目标、来源与内容摘要', { exact: true }).click();
    const summary = await card.locator('.proposal-source').innerText();
    for (const value of [f.taskId, proposal.payload_hash, proposal.skill_sha256, proposal.skill_output_sha256])
      assert.ok(summary.includes(value), 'actual proposal UI omitted its target or one of the three hashes');
    await card.getByRole('button', { name: '查看确认操作', exact: true }).click();
    const accepted = await uiCommand(new RegExp(`^/assist-proposals/${proposal.id}/accept$`, 'u'),
      () => card.getByTestId('task-skill-accept').click(), 200);
    assert.equal(accepted.body.expected_task_revision, proposal.base_revision);
    assert.equal(accepted.body.expected_acceptance_revision, proposal.base_acceptance_revision);
    assert.equal(accepted.body.payload_hash, proposal.payload_hash);
    assert.equal(accepted.receipt.result.revision, (BigInt(proposal.base_revision) + 1n).toString());
    assert.equal(accepted.receipt.result.acceptance_revision, (BigInt(proposal.base_acceptance_revision) + 1n).toString());
    const after = await businessSnapshot(f);
    same(after.project, before.project, 'Task Skill acceptance changed Project');
    same(after.state, before.state, 'Task Skill acceptance changed State');
    assert.equal(after.tasks.length, 1);
    assert.equal(after.tasks[0].revision, accepted.receipt.result.revision);
    assert.equal(after.tasks[0].acceptance_revision, accepted.receipt.result.acceptance_revision);
    for (const key of ['status', 'mode', 'executor_kind', 'executor_run_id', 'ownership_epoch', 'current_completion_id'])
      same(after.tasks[0][key], before.tasks[0][key], `Task Skill acceptance changed ${key}`);
    assert.equal(after.acceptances.length, 2);
    same(after.acceptances[0], old, 'Skill acceptance changed an immutable previous version');
    same(after.acceptances[1].objective, proposal.payload.objective, 'saved objective differs from confirmed proposal');
    same(after.acceptances[1].required_output_spec, proposal.payload.required_output_spec, 'saved output contract differs from confirmed proposal');
    same(after.criteria.filter((item) => item.acceptance_revision === old.acceptance_revision),
      before.criteria, 'Skill acceptance changed immutable original criteria');
    const nextCriteria = after.criteria.filter((item) =>
      item.acceptance_revision === accepted.receipt.result.acceptance_revision);
    assert.equal(nextCriteria.length, proposal.payload.criteria.length);
    for (const criterion of proposal.payload.criteria) {
      const saved = nextCriteria.find((item) => item.criterion_id === criterion.criterion_id);
      assert.ok(saved, 'accepted Skill omitted a confirmed criterion');
      for (const key of ['statement', 'required', 'method', 'target_spec'])
        same(saved[key], criterion[key], `saved criterion ${key} differs from the exact confirmed proposal`);
    }
    const current = await get(bootstrap, `/assist-proposals/${proposal.id}`);
    assert.equal(current.status, 'ACCEPTED');
    assert.equal(current.decision.command_id, accepted.body.command_id);
    same(current.decision.result, accepted.receipt.result, 'proposal decision lost its original receipt');
    const replay = await post(bootstrap, accepted.path, accepted.body, 200);
    same(replay, accepted.receipt, 'original command replay returned a different receipt');
    same(await businessSnapshot(f), after, 'original acceptance command was applied twice');
    assert.equal(await sql(`select count(*) from command_receipts where command_id='${accepted.body.command_id}'`), '1');
    assert.equal(await sql(`select count(*) from activity_records where command_id='${accepted.body.command_id}'
      and event_type='TASK_ACCEPTANCE_CHANGED'`), '1');
    await waitFor(async () => (await card.innerText()).includes('ACCEPTED'), 15_000, 'visible accepted proposal');
    await expect(card.getByTestId('task-skill-accept')).toHaveCount(0);
    await noExecution(f);
  } else {
    assert.equal(proposals.length, 0, 'read-only project resume created a writable proposal');
    const history = page.getByText('查看会话历史与原始建议', { exact: true });
    if (await history.count()) await history.click();
    const outputCard = page.getByTestId('assist-skill-output');
    await expect(outputCard).toBeVisible();
    assert.ok((await outputCard.innerText()).includes('READ_ONLY'), 'actual project resume UI lost READ_ONLY status');
    await expect(outputCard.getByRole('button')).toHaveCount(0);
    await expect(page.getByTestId('task-skill-accept')).toHaveCount(0);
    same(await businessSnapshot(f), before, 'read-only resume changed a business revision');
    await noExecution(f);
  }
  same(await calls(`c.assist_message_id in (select id from assist_messages where session_id='${sessionId}')`),
    modelCalls, 'acceptance or read-only display replaced the original model call');
  console.log(`real_ui_skill skill=${skillId}@${version} session_id=${sessionId} message_id=${messageId} call_id=${modelCalls[0].id} actual_model_calls=1 ${taskSkill ? 'human_accept=true same_command_replay=true task_revision_delta=1 acceptance_revision_delta=1' : 'read_only=true revision_changes=0'} runs=0 completion_records=0`);
}

async function runChain() {
  await startSession();
  appendFileSync(state.marker.config_path, '\n' + Object.entries(model)
    .map(([key, value]) => `${key}="${value}"`).join('\n') + '\n', 'utf8');
  ({ page, bootstrap } = await startHost(`m04-${scenario}`));
  secrets.push(bootstrap.bearerToken);
  await assertRuntimeRoleSeparation();
  ledger = watchWebView(page, bootstrap);
  let failure;
  try {
    if (scenario !== 'skills') for (const kind of ['FILE_READ', 'WEB_FETCH']) await runRead(kind);
    if (scenario !== 'read') for (const skillId of skillFilter ? [skillFilter] : skillIds)
      await runSkill(skillId);
  } catch (error) { failure = error; }
  const closed = await Promise.allSettled(listeners.map(closeSource));
  const cleanupFailures = closed.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failure || cleanupFailures.length) throw failure && !cleanupFailures.length ? failure
    : new AggregateError([...(failure ? [failure] : []), ...cleanupFailures], 'original scenario failure and owned source cleanup');
  assert.equal(ledger.tokenInUrl, false);
  assert.equal(ledger.unauthorizedRequest, false);
  for (const log of state.hostLogs) for (const secret of secrets)
    assert.ok(!readFileSync(log, 'utf8').includes(secret), 'host log retained a credential');
  assert.equal(sha(configPath), configSha, 'original authorized model configuration was changed');
  const tree = await processSnapshot(state.host.pid);
  let closeEvents = 0;
  page.on('close', () => closeEvents++);
  await page.getByTestId('desktop-titlebar').getByRole('button', { name: '关闭窗口', exact: true })
    .click().catch((error) => { if (!page.isClosed()) throw error; });
  await waitFor(() => state.host.exitCode !== null && page.isClosed(), 15_000, 'natural titlebar close');
  assert.equal(state.host.exitCode, 0);
  assert.equal(state.host.signalCode, null);
  assert.equal(closeEvents, 1);
  await waitFor(async () => { try { await assertStopped(tree); return true; } catch { return false; } },
    10_000, 'owned Windows process tree shutdown');
  state.browser = null; state.page = null;
  console.log('titlebar_ui_close=true host_natural_exit=0 recorded_process_tree_stopped=true owned_source_listeners_stopped=true');
}

// Shared cleanup also handles partial host startup and never deletes an unowned session.
await runDesktopAcceptance(runChain,
  `M04_REAL_READ_SKILL_WEBVIEW_REAL_PG_${scenario.toUpperCase()}${skillFilter ? '_' + skillFilter.toUpperCase().replaceAll('-', '_') : ''}=PASS`, secrets);
