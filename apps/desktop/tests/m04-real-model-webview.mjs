// Opt-in: fixed synthetic inputs only, a disposable PG/data root and a frozen package.
// Model credentials come only from the explicitly supplied, previously authorized project .env.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { state, releaseRoot, frozenPackage, sha, sql, waitFor, startSession, startHost, watchWebView,
  post, get, assertRuntimeRoleSeparation, processSnapshot, assertStopped, expect,
  uuid, runDesktopAcceptance } from './m03-review-resume-webview.mjs';

assert.equal(sha(join(releaseRoot, 'desktop-build-manifest.json')), process.argv[4], 'manifest differs from frozen input');
assert.equal(sha(join(releaseRoot, 'api', 'migrations', '0047_m04_model_call_first_output.sql')),
  process.argv[5], 'first-output migration differs from frozen input');
frozenPackage.set(join(releaseRoot, 'api', 'migrations', '0047_m04_model_call_first_output.sql'), process.argv[5]);
const configPath = resolve(process.argv[6] ?? '');
assert.equal(configPath.toLowerCase(), resolve('D:/Develop/Relay-Agent/apps/api/.env').toLowerCase(),
  'only the previously authorized project model configuration is supported');
const modelKeys = ['RELAY_MODEL_PROVIDER', 'RELAY_MODEL_API_KEY', 'RELAY_MODEL_NAME',
  'RELAY_MODEL_BASE_URL', 'RELAY_MODEL_TIMEOUT_MS', 'RELAY_MODEL_MAX_OUTPUT_TOKENS',
  'RELAY_MODEL_MAX_CALL_TOKENS', 'RELAY_MODEL_MAX_SCOPE_CALLS', 'RELAY_MODEL_MAX_SCOPE_TOKENS'];
const parsed = parseEnv(readFileSync(configPath, 'utf8'));
const model = Object.fromEntries(modelKeys.filter((key) => parsed[key] !== undefined)
  .map((key) => [key, parsed[key]]));
assert.equal(model.RELAY_MODEL_PROVIDER, 'openai-compatible', 'authorized model configuration is not real-provider enabled');
assert.ok(model.RELAY_MODEL_API_KEY && model.RELAY_MODEL_NAME, 'authorized model configuration is incomplete');
for (const value of Object.values(model)) assert.ok(!/[\r\n"\\]/u.test(value), 'model configuration cannot be copied safely');
const secrets = [model.RELAY_MODEL_API_KEY];

async function visibleText(page, locator, startedAt, kind) {
  await expect(locator).toBeVisible({ timeout: 180_000 });
  await expect(locator).not.toHaveText('', { timeout: 180_000 });
  await locator.scrollIntoViewIfNeeded();
  return locator.evaluate(async (element, input) => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const rect = element.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth)
      throw new Error('output text is outside the window viewport');
    return { kind: input.kind, click_to_visible_ms: Date.now() - input.startedAt,
      characters: element.textContent.length };
  }, { startedAt, kind });
}

async function callsFor(where) {
  return JSON.parse(await sql(`select coalesce(json_agg(json_build_object('id',id,'kind',kind,` +
    `'status',status,'provider',provider,'manifest_id',manifest_id,'input_sha256',input_sha256,` +
    `'started_at',started_at,'first_text_delta_at',first_text_delta_at,` +
    `'first_preview_persisted_at',first_preview_persisted_at,'settled_at',settled_at)` +
    ` order by started_at)::text,'[]') from model_calls where ${where}`));
}

function firstOutput(call) {
  assert.equal(call.status, 'COMPLETED');
  assert.equal(call.provider, 'openai-compatible');
  for (const key of ['started_at', 'first_text_delta_at', 'first_preview_persisted_at', 'settled_at'])
    assert.ok(Number.isFinite(Date.parse(call[key])), `missing ${key}`);
  assert.ok(Date.parse(call.first_text_delta_at) >= Date.parse(call.started_at));
  assert.ok(Date.parse(call.first_preview_persisted_at) >= Date.parse(call.first_text_delta_at));
  assert.ok(Date.parse(call.settled_at) >= Date.parse(call.first_preview_persisted_at));
  return { call_id: call.id,
    ledger_to_first_text_ms: Date.parse(call.first_text_delta_at) - Date.parse(call.started_at),
    first_text_to_preview_write_ms: Date.parse(call.first_preview_persisted_at) - Date.parse(call.first_text_delta_at),
    ledger_to_settlement_ms: Date.parse(call.settled_at) - Date.parse(call.started_at) };
}

async function runRealChain() {
  await startSession();
  // Only model keys are copied; isolated DB, Workspace and data-root keys remain owned by the session.
  appendFileSync(state.marker.config_path, '\n' + Object.entries(model)
    .map(([key, value]) => `${key}="${value}"`).join('\n') + '\n', 'utf8');
  const first = await startHost('m04-real');
  const { page, bootstrap } = first;
  await assertRuntimeRoleSeparation();
  const ledger = watchWebView(page, bootstrap);
  await page.goto('http://tauri.localhost/projects');
  await expect(page.getByTestId('relay-connection-open')).toContainText('已连接本机 API');
  await page.getByTestId('project-create-open').click();
  await page.locator('input[name="project-title"]').fill('M04 synthetic desktop acceptance');
  await page.locator('input[name="project-type"][value="GENERAL"]').check({ force: true });
  await page.getByTestId('project-create-submit').click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/tasks$/u);
  const projectId = /\/projects\/([0-9a-f-]{36})\/tasks$/u.exec(new URL(page.url()).pathname)?.[1];
  assert.match(projectId, uuid);
  const marker = `RELAY-M04-SOURCE-${randomUUID().slice(0, 8)}`;
  const sourceText = `独特标记：${marker}。这是一份验收用合成资料，主题是虚构的月光温室。`;
  const knowledge = await post(bootstrap, '/knowledge', { command_id: randomUUID(),
    project_id: projectId, title: 'M04 synthetic source', source_kind: 'NOTE', text: sourceText }, 201);
  const knowledgeId = knowledge.result.knowledge_id;
  assert.match(knowledgeId, uuid);
  await page.getByRole('link', { name: '新建任务' }).click();
  await page.locator('input[name="task-title"]').fill('M04 real model synthetic draft');
  await page.locator('input[name="task-expected-result"]').fill('依据显式选中资料写约800字Markdown，正文必须原样回显资料中的独特标记，并包含结论小节。');
  await page.locator('textarea[name="task-acceptance"]').fill('人工确认合成草稿和来源标记');
  await page.getByTestId('task-create-save').click();
  await expect(page.getByTestId('task-created-open-detail')).toBeVisible();
  const taskId = await page.getByTestId('task-created-open-detail').innerText();
  assert.match(taskId, uuid);
  await page.getByTestId('task-created-open-detail').click();
  await page.getByTestId('task-detail-tab-runs').click();
  const picker = page.getByTestId('task-delegate-panel').getByTestId('assist-source-picker');
  await picker.getByRole('searchbox').fill('M04 synthetic source');
  await picker.getByRole('button', { name: '查找来源' }).click();
  await picker.getByRole('checkbox').check();
  let observedPreview = null;
  let previewReadFailure = null;
  page.on('response', async (response) => {
    if (!response.url().startsWith(bootstrap.baseUrl) ||
        !/\/runs\/[0-9a-f-]{36}\/draft-preview$/u.test(new URL(response.url()).pathname) ||
        response.status() !== 200) return;
    try {
      const body = await response.json();
      if (observedPreview === null && body.preview_available && body.preview_text && body.model_call_id)
        observedPreview = body;
    } catch (error) { previewReadFailure = error; }
  });
  const runClickAt = await page.evaluate(() => Date.now());
  await page.getByTestId('task-delegate').click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/u);
  const runId = /\/runs\/([0-9a-f-]{36})$/u.exec(new URL(page.url()).pathname)?.[1];
  assert.match(runId, uuid);
  const visible = await visibleText(page, page.getByTestId('run-draft-preview').locator('pre'), runClickAt, 'RUN_DRAFT_PREVIEW');
  const preview = await waitFor(() => {
    if (previewReadFailure) throw new Error('the actual UI preview response could not be observed');
    return observedPreview;
  }, 5000, 'the original WebView preview response');
  assert.equal(preview.run_id, runId);
  assert.equal(preview.preview_available, true);
  assert.match(preview.model_call_id, uuid);
  const review = await waitFor(async () => {
    const run = await get(bootstrap, `/runs/${runId}`);
    assert.notEqual(run.status, 'FAILED', 'real Run failed before human Review');
    return (await get(bootstrap, `/runs/${runId}/reviews`)).items
      .find((item) => item.kind === 'CRITERION' && item.status === 'OPEN') ?? null;
  }, 180_000, 'real Provider DRAFT and human Review');
  const calls = await callsFor(`step_attempt_id in (select a.id from step_attempts a join run_steps s on s.id=a.step_id where s.run_id='${runId}') and kind='DRAFT'`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, preview.model_call_id);
  const stages = firstOutput(calls[0]);
  const trace = await get(bootstrap, `/runs/${runId}/trace`);
  assert.equal(trace.model_calls.find((call) => call.id === calls[0].id).first_text_delta_at,
    new Date(calls[0].first_text_delta_at).toISOString());
  const source = trace.manifests.find((manifest) => manifest.id === calls[0].manifest_id)?.sources
    .find((item) => item.source_ref === `knowledge:${knowledgeId}:v1`);
  assert.ok(source, 'Run lost the explicitly selected exact source version');
  assert.equal(source.source_sha256, createHash('sha256').update(sourceText).digest('hex'));
  const candidate = await sql(`select a.result_ref->>'content' from step_attempts a join run_steps s on s.id=a.step_id where s.run_id='${runId}' and s.step_kind='DRAFT' and a.status='SUCCEEDED'`);
  assert.ok(candidate.includes(marker), 'real model did not echo the unique selected-source marker');
  assert.equal(await sql(`select count(*) from completion_records where task_id='${taskId}'`), '0');
  assert.equal((await get(bootstrap, `/runs/${runId}/draft-preview`)).preview_available, false);
  assert.deepEqual(await callsFor(`id='${calls[0].id}'`), calls, 'preview cleanup changed first-output evidence');
  console.log(`run_first_output=${JSON.stringify({ ...visible, ...stages })}`);
  await page.getByTestId('run-reviews').getByRole('link', { name: '查看请求与判断依据' }).click();
  await expect(page).toHaveURL(new RegExp(`/reviews\\?id=${review.id}$`, 'u'));
  await page.getByTestId('review-decision-ACCEPT').click();
  await waitFor(async () => (await get(bootstrap, `/runs/${runId}`)).status === 'COMPLETED', 60_000, 'human acceptance and Business Commit');
  assert.equal((await get(bootstrap, `/tasks/${taskId}`)).status, 'DONE');
  assert.equal(await sql(`select count(*) from completion_records where task_id='${taskId}' and run_id='${runId}'`), '1');
  assert.equal(await sql(`select count(*) from artifact_versions where source_ref like 'run:${runId}/%'`), '1');
  await page.goto(`http://tauri.localhost/runs/${runId}`);
  await page.getByTestId('run-trace-toggle').click();
  await expect(page.getByTestId('run-trace')).toContainText(new Date(calls[0].first_text_delta_at).toISOString());
  await page.getByTestId('run-trace').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'D:/Develop/Relay-Agent/output/acceptance-raw/m04-20260930-real-run-trace.png' });

  // Ordinary Assist uses the actual UI sender, history and Supervisor; it does not delegate a Task.
  await page.goto(`http://tauri.localhost/tasks/${taskId}?skill=assist`);
  await page.getByTestId('assist-new-session').click();
  await expect(page.getByTestId('assist-draft')).toBeEnabled();
  const historyMarker = `RELAY-M04-HISTORY-${randomUUID().slice(0, 8)}`;
  await page.getByTestId('assist-draft').fill(`这是合成测试。请原样回显 ${historyMarker}，随后用约500字介绍虚构的月光温室，不提出业务修改。`);
  const assistClickAt = await page.evaluate(() => Date.now());
  await page.getByTestId('assist-send').click();
  const assistVisible = await visibleText(page, page.locator('[data-testid^="assist-live-preview-"] .assist-message-content').first(), assistClickAt, 'ASSIST_DISCUSS_PREVIEW');
  const sessionId = await waitFor(async () => {
    const sessions = await get(bootstrap, `/assist-sessions?task_id=${taskId}`);
    return sessions.items[0]?.id ?? null;
  }, 10_000, 'UI-created Assist session');
  const message = await waitFor(async () => {
    const messages = await get(bootstrap, `/assist-sessions/${sessionId}/messages`);
    const assistant = messages.items.find((item) => item.role === 'ASSISTANT');
    assert.notEqual(assistant?.status, 'FAILED', 'real Assist failed');
    return assistant?.status === 'COMPLETED' ? assistant : null;
  }, 180_000, 'real Assist message settlement');
  assert.ok(message.content.includes(historyMarker));
  const assistCalls = await callsFor(`assist_message_id='${message.id}'`);
  assert.equal(assistCalls.length, 1);
  console.log(`assist_first_output=${JSON.stringify({ ...assistVisible, ...firstOutput(assistCalls[0]) })}`);
  await page.getByTestId('assist-draft').fill('只回显上一轮我提供的独特标记，证明你读到了本会话历史。');
  await page.getByTestId('assist-send').click();
  const second = await waitFor(async () => {
    const messages = await get(bootstrap, `/assist-sessions/${sessionId}/messages`);
    const next = messages.items.find((item) => item.role === 'ASSISTANT' && item.id !== message.id);
    assert.notEqual(next?.status, 'FAILED', 'real multi-turn Assist failed');
    return next?.status === 'COMPLETED' ? next : null;
  }, 180_000, 'real multi-turn history response');
  assert.ok(second.content.includes(historyMarker));
  await expect(page.locator('.agent-message[data-role="ASSISTANT"] .assist-message-content').last())
    .toContainText(historyMarker, { timeout: 15_000 });
  assert.equal(await sql(`select count(*) from assist_proposals where session_id='${sessionId}'`), '0');
  assert.equal(await sql(`select count(*) from tasks where project_id='${projectId}'`), '1');
  assert.equal(await sql(`select count(*) from runs where task_id='${taskId}'`), '1');
  assert.equal(await sql(`select count(*) from completion_records where task_id='${taskId}'`), '1');
  await page.getByTestId('assist-intent').selectOption('PROPOSE_TASK');
  await page.getByTestId('assist-draft').fill(`请提出一个新的人工任务，标题为“${historyMarker} 人工核对”，目标是人工核对虚构温室资料，验收恰好一条必需的HUMAN人工确认。不启动执行。`);
  await page.getByTestId('assist-send').click();
  const proposal = await waitFor(async () => {
    const messages = await get(bootstrap, `/assist-sessions/${sessionId}/messages`);
    const structured = messages.items.find((item) => item.role === 'ASSISTANT' && item.intent === 'PROPOSE_TASK');
    assert.notEqual(structured?.status, 'FAILED', 'real typed Assist proposal failed schema validation');
    return (await get(bootstrap, `/assist-proposals?session_id=${sessionId}`)).items
      .find((item) => item.kind === 'TASK_DEFINITION' && item.status === 'PENDING') ?? null;
  }, 180_000, 'real schema-validated typed proposal');
  assert.ok(proposal.payload.title.includes(historyMarker),
    `typed synthetic task title omitted its explicit marker: ${JSON.stringify(proposal.payload.title)}`);
  assert.equal(proposal.target_type, 'PROJECT');
  assert.equal(proposal.target_id, projectId);
  assert.equal(proposal.payload.criteria.length, 1);
  assert.equal(proposal.payload.criteria[0].method, 'HUMAN');
  assert.equal(proposal.payload.criteria[0].required, true);
  assert.equal(await sql(`select count(*) from tasks where project_id='${projectId}'`), '1', 'a pending Assist proposal created a Task');
  const typedCalls = await callsFor(`assist_message_id='${proposal.message_id}'`);
  assert.equal(typedCalls.length, 1);
  assert.equal(typedCalls[0].provider, 'openai-compatible');
  assert.equal(typedCalls[0].status, 'COMPLETED');
  assert.equal(typedCalls[0].first_text_delta_at, null);
  assert.equal(typedCalls[0].first_preview_persisted_at, null);
  await page.locator('.assist-proposal').filter({ hasText: historyMarker }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'D:/Develop/Relay-Agent/output/acceptance-raw/m04-20260930-real-typed-proposal.png' });
  const accepted = page.waitForResponse((response) => response.request().method() === 'POST' &&
    new URL(response.url()).pathname.endsWith(`/assist-proposals/${proposal.id}/accept`), { timeout: 15_000 });
  await page.getByRole('button', { name: '接受此提案', exact: true }).click();
  const acceptedResponse = await accepted;
  assert.equal(acceptedResponse.status(), 200);
  const acceptedReceipt = await acceptedResponse.json();
  const newTaskId = acceptedReceipt.result.task_id;
  assert.match(newTaskId, uuid);
  const replay = await post(bootstrap, `/assist-proposals/${proposal.id}/accept`,
    JSON.parse(acceptedResponse.request().postData()), 200);
  assert.deepEqual(replay, acceptedReceipt, 'acceptance did not replay its original command receipt');
  const proposedTask = await get(bootstrap, `/tasks/${newTaskId}`);
  assert.equal(proposedTask.executor.kind, 'HUMAN');
  assert.equal(proposedTask.status, 'INBOX');
  assert.equal(proposedTask.acceptance.criteria.length, 1);
  assert.equal(proposedTask.acceptance.criteria[0].method, 'HUMAN');
  assert.equal(proposedTask.acceptance.criteria[0].required, true);
  assert.equal((await get(bootstrap, `/assist-proposals/${proposal.id}`)).status, 'ACCEPTED');
  const proposalCard = page.locator('.assist-proposal').filter({ hasText: historyMarker });
  await expect(proposalCard).toContainText('ACCEPTED');
  await expect(proposalCard.getByRole('button', { name: '接受此提案' })).toHaveCount(0);
  assert.equal(await sql(`select count(*) from tasks where project_id='${projectId}'`), '2');
  assert.equal(await sql(`select count(*) from runs where task_id='${newTaskId}'`), '0');
  console.log(`typed_proposal id=${proposal.id} call_id=${typedCalls[0].id} accepted_task_id=${newTaskId} ui_accept=true same_command_replay=true pending_business_writes=0 new_task_executor=HUMAN new_task_runs=0`);
  assert.equal(ledger.tokenInUrl, false);
  assert.equal(ledger.unauthorizedRequest, false);
  for (const log of state.hostLogs) for (const secret of [...secrets, bootstrap.bearerToken])
    assert.ok(!readFileSync(log, 'utf8').includes(secret), 'host log retained a credential');
  console.log(`real_chain project_id=${projectId} task_id=${taskId} run_id=${runId} source_versions=1 artifact_versions=1 completion_records=1 assist_turns=3 synthetic_input=true`);
  const tree = await processSnapshot(state.host.pid);
  let closed = 0;
  page.on('close', () => closed++);
  await page.getByTestId('desktop-titlebar').getByRole('button', { name: '关闭窗口', exact: true }).click().catch((error) => {
    if (!page.isClosed()) throw error;
  });
  await waitFor(() => state.host.exitCode !== null && page.isClosed(), 15_000, 'natural titlebar close');
  assert.equal(state.host.exitCode, 0);
  assert.equal(state.host.signalCode, null);
  assert.equal(closed, 1);
  await waitFor(async () => { try { await assertStopped(tree); return true; } catch { return false; } }, 10_000, 'private child process shutdown');
  state.browser = null;
  state.page = null;
  console.log('titlebar_ui_close=true host_natural_exit=0 recorded_process_tree_stopped=true');
}

await runDesktopAcceptance(runRealChain, 'M04_REAL_MODEL_WEBVIEW_REAL_PG=PASS', secrets);
