import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import {
  claimRunForGateway, dispatchGatewayAction, prepareGatewayAction, readGatewayOperation,
  type GatewayOrigin, type GatewayActionType,
} from '../../src/application/gateway-actions.js';
import { createFakeConnection, createGatewayPolicy, registerManagedResource }
  from '../../src/application/gateway-configuration.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { RunScopeGrantRepository } from '../../src/application/run-scope-grant.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { replaceBrowserSessionManagerForTest } from '../../src/browser/client-holder.js';
import { BrowserSessionManager } from '../../src/browser/session-manager.js';
import { ExtensionBridgeProvider } from '../../src/browser/extension-provider.js';
import { parseSnapshotText } from '../../src/browser/snapshot-parse.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import type {
  BrowserHealth, BrowserPageRef, BrowserProvider, BrowserSnapshot,
} from '../../src/browser/provider.js';
import { readBrowserSessions } from '../../src/browser/sessions.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { createDataRoot, startTestApi } from './api-harness.js';
import {
  APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase,
} from './integration-support.js';

/**
 * F26 M3：浏览器**动作**与权限的真实 PG 证据。
 *
 * 覆盖三件事：范围授权只覆盖 BROWSER_ACTION（不覆盖 BROWSER_COMMIT）、提交类点击被
 * 启发式分类器升级为单动作审批、任务状态表与 stop 入口。浏览器后端用受控替身——
 * 真实 Chrome 链路由 M1 冒烟与 M4 的浏览器实测覆盖。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-browser-f26-actions');
let dataRoot: string;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code) : undefined;
}

const READY: BrowserHealth = { status: 'READY', backendVersion: '1.11.0',
  chromeVersion: 'Chrome/155', tools: ['list_pages'], detail: 'ok', remediation: null };

/** 页面内容可配置：`form` 表示带表单与提交按钮，`plain` 表示只有链接。 */
class ScriptedProvider implements BrowserProvider {
  readonly kind = 'scripted';
  readonly clicks: string[] = [];
  private extra: BrowserPageRef | null = null;
  constructor(private readonly form: boolean) {}
  async ensureStarted(): Promise<BrowserHealth> { return READY; }
  async health(): Promise<BrowserHealth> { return READY; }
  async listPages(): Promise<readonly BrowserPageRef[]> {
    const pages: BrowserPageRef[] = [{ pageId: 1, url: 'https://app.test/', title: 'App' }];
    if (this.extra !== null) pages.push(this.extra);
    return pages;
  }
  async newPage(input: { url?: string }): Promise<BrowserPageRef> {
    const profile = { pageId: 2, url: input.url ?? 'about:blank', title: 'new' };
    this.extra = profile;
    return profile;
  }
  async closePage(pageId: number): Promise<void> { void pageId; }
  async readPage(pageId: number): Promise<BrowserSnapshot> {
    return { pageId, url: 'https://app.test/', title: 'App', readyState: 'complete',
      truncated: false,
      text: 'uid=1_0 RootWebArea "App"', elements: this.elements() };
  }
  async navigate(input: { pageId: number; url?: string;
    history?: 'back' | 'forward' | 'reload' }): Promise<BrowserSnapshot> {
    void input;
    return this.readPage(2);
  }
  async click(input: { pageId: number; uid: string }): Promise<BrowserSnapshot> {
    this.clicks.push(input.uid);
    return this.readPage(input.pageId);
  }
  async fill(input: { pageId: number; uid: string; text: string }): Promise<BrowserSnapshot> {
    void input;
    return this.readPage(input.pageId);
  }
  async pressKey(input: { pageId: number; key: string }): Promise<BrowserSnapshot> {
    void input;
    return this.readPage(input.pageId);
  }
  async waitFor(input: { pageId: number; text: string;
    timeoutMs: number }): Promise<BrowserSnapshot> { void input; return this.readPage(input.pageId); }
  async submitForm(input: { pageId: number; uid: string }): Promise<BrowserSnapshot> {
    this.clicks.push(`submit:${input.uid}`);
    return this.readPage(input.pageId);
  }
  async uploadFile(input: { pageId: number; uid: string;
    absolutePath: string }): Promise<BrowserSnapshot> {
    void input;
    return this.readPage(input.pageId);
  }
  async screenshot(): Promise<{ width: number; height: number; bytes: number;
    sha256: string; mimeType: string }> {
    return { width: 100, height: 100, bytes: 1, sha256: 'a'.repeat(64), mimeType: 'image/png' };
  }
  async dispose(): Promise<void> {}
  private elements() {
    const base = [{ uid: '1_0', role: 'RootWebArea', name: 'App', inForm: false },
      { uid: '1_6', role: 'link', name: '普通链接', inForm: false }];
    if (!this.form) return base;
    return [...base,
      { uid: '1_2', role: 'form', name: '', inForm: false },
      { uid: '1_4', role: 'textbox', name: '关键词', inForm: true },
      { uid: '1_5', role: 'button', name: '提交查询', inForm: true }];
  }
}

interface Fixture {
  workspaceId: string; projectId: string; taskId: string; runId: string; stepId: string;
  resourceId: string; connectionId: string; root: string;
}

async function fixture(input: {
  capability: 'BROWSER_ACTION' | 'BROWSER_COMMIT';
  actionType: string; decision?: 'AUTO' | 'ASK';
  /** 同一能力下还需要放行的其它动作（例如先建页再点击）。 */
  extraActionTypes?: readonly string[];
}): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `f26-${workspaceId}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'F26 Actions',
      projectType: 'DEVELOPMENT' });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
    await repositories.tasks.insertTask({ id: taskId, workspaceId, projectId,
      title: 'Browser actions', status: 'READY', mode: 'ME', acceptanceRevision: 1n,
      executorKind: 'HUMAN', ownershipEpoch: 0n, currentCompletionId: null });
    await repositories.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: 'F26 浏览器动作', requiredOutputSpec: {}, source: 'CREATE' });
    await repositories.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
      statement: '人工核对', required: true, method: 'HUMAN', targetSpec: {} });
  });
  const delegated = await delegateTask(app.db, { workspaceId, taskId,
    commandId: randomUUID(), expectedTaskRevision: '0' });
  const runId = delegated.result.run_id;
  const storage = new ManagedContentStore(dataRoot);
  for (const kind of ['BUILD_CONTEXT', 'DRAFT']) {
    const advanced = await advanceRunStep(app.db, { runId, workerId: `setup-${randomUUID()}`, storage });
    assert.equal(advanced.status, 'STEP_SUCCEEDED', `${kind}: ${JSON.stringify(advanced)}`);
  }
  const step = await withTransaction(app.db, (repositories) =>
    repositories.runs.readStepByKind(runId, 'DRAFT'));
  assert.ok(step);
  const root = join(dataRoot, `f26-act-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const resource = await registerManagedResource(app.db, { workspaceId, projectId, rootPath: root });
  const connection = await createFakeConnection(app.db, { workspaceId, projectId,
    capabilities: [input.capability] });
  await createGatewayPolicy(app.db, { workspaceId, projectId, capability: input.capability,
    actionType: input.actionType, targetPrefix: 'browser://', decision: input.decision ?? 'AUTO',
    maxPayloadBytes: 8192 });
  for (const actionType of input.extraActionTypes ?? []) {
    await createGatewayPolicy(app.db, { workspaceId, projectId, capability: input.capability,
      actionType, targetPrefix: 'browser://', decision: input.decision ?? 'AUTO',
      maxPayloadBytes: 8192 });
  }
  return { workspaceId, projectId, taskId, runId, stepId: step.id,
    resourceId: resource.resourceId, connectionId: connection.connectionId, root };
}

async function claim(f: Fixture): Promise<GatewayOrigin> {
  const workerId = `worker-${randomUUID()}`;
  const held = await claimRunForGateway(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId });
  return { kind: 'RUN', runId: f.runId, stepId: f.stepId, resourceId: f.resourceId,
    workerId, workerEpoch: BigInt(held.worker_epoch) };
}

/** 建一个只授权 BROWSER_ACTION（不含 BROWSER_COMMIT）的本次任务范围授权。 */
async function grantBrowserAction(f: Fixture): Promise<void> {
  await new RunScopeGrantRepository(app.db).insert({
    workspaceId: f.workspaceId, projectId: f.projectId, runId: f.runId, taskId: f.taskId,
    resourceId: f.resourceId, canonicalRoot: f.root, allowedActions: ['BROWSER_ACTION'], checks: [],
  });
}

/** 先建一个属于本任务的页：任何页面动作的前置，否则缺省页不存在、动作必然失败。 */
async function createOwnPage(f: Fixture, origin: GatewayOrigin): Promise<void> {
  const created = randomUUID();
  const prepared = await prepareGatewayAction(app.db, {
    workspaceId: f.workspaceId, operationId: created, intentKey: `intent-${randomUUID()}`,
    connectionId: f.connectionId, origin, actionType: 'BROWSER_NEW_PAGE',
    target: 'browser://app.test', params: { url: 'https://app.test/' },
  });
  assert.equal(prepared.status, 'PREPARED', '建页应被授权放行：' + JSON.stringify(prepared));
  assert.equal((await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: created, origin })).status, 'SUCCEEDED');
}

function useProvider(provider: BrowserProvider): void {
  replaceBrowserSessionManagerForTest(new BrowserSessionManager({ dataRoot, provider }));
}

test('范围授权覆盖 BROWSER_ACTION：AUTO 直接派发成功并写入任务状态', async () => {
  const f = await fixture({ capability: 'BROWSER_ACTION', actionType: 'BROWSER_NAVIGATE',
    extraActionTypes: ['BROWSER_NEW_PAGE'] });
  useProvider(new ScriptedProvider(false));
  await grantBrowserAction(f);
  const origin = await claim(f);
  await createOwnPage(f, origin);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, {
    workspaceId: f.workspaceId, operationId: op, intentKey: `intent-${randomUUID()}`,
    connectionId: f.connectionId, origin, actionType: 'BROWSER_NAVIGATE',
    target: 'browser://app.test', params: { url: 'https://app.test/next' },
  });
  assert.equal(prepared.status, 'PREPARED',
    '授权覆盖范围内不应再要单动作审批；实际 ' + JSON.stringify(prepared));
  const dispatched = await dispatchGatewayAction(app.db, {
    workspaceId: f.workspaceId, operationId: op, origin });
  assert.equal(dispatched.status, 'SUCCEEDED');
  assert.equal((dispatched.result_ref as { url: string }).url, 'https://app.test/');

  const sessions = await readBrowserSessions(app.db, f.workspaceId);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.owner_kind, 'RUN');
  assert.equal(sessions[0]?.owner_id, f.runId);
  assert.equal(sessions[0]?.page_id, 2);
  assert.equal(sessions[0]?.state, 'RUNNING');
  assert.equal(sessions[0]?.action_type, 'BROWSER_NAVIGATE');
  assert.equal(sessions[0]?.action_label, '导航到新地址');
});

test('BROWSER_COMMIT 永不被范围授权覆盖：提交表单仍需单动作审批', async () => {
  const f = await fixture({ capability: 'BROWSER_COMMIT', actionType: 'BROWSER_SUBMIT_FORM' });
  useProvider(new ScriptedProvider(true));
  // 连接不带 BROWSER_COMMIT 时连 prepare 都进不去；这里补一个带该能力的连接验证授权层本身。
  const connection = await createFakeConnection(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, capabilities: ['BROWSER_COMMIT'] });
  await grantBrowserAction(f);
  const origin = await claim(f);
  const prepared = await prepareGatewayAction(app.db, {
    workspaceId: f.workspaceId, operationId: randomUUID(),
    intentKey: `intent-${randomUUID()}`, connectionId: connection.connectionId, origin,
    actionType: 'BROWSER_SUBMIT_FORM', target: 'browser://app.test', params: { uid: '1_5' },
  });
  // allowedActions 只有 BROWSER_ACTION，BROWSER_COMMIT 不在其中 → 授权覆盖不到它，
  // 而且 approvalPassthrough=false 本身就要求单动作批准。
  assert.equal(prepared.status, 'WAITING_APPROVAL',
    '提交类动作永不被范围授权覆盖；实际 ' + JSON.stringify(prepared));
  assert.ok(prepared.review_id !== null);
});

test('提交类点击被分类器升级：授权范围内的 AUTO 也会变成单动作审批', async () => {
  const f = await fixture({ capability: 'BROWSER_ACTION', actionType: 'BROWSER_CLICK',
    extraActionTypes: ['BROWSER_NEW_PAGE'] });
  useProvider(new ScriptedProvider(true));
  await grantBrowserAction(f);
  const origin = await claim(f);
  await createOwnPage(f, origin);
  const prepared = await prepareGatewayAction(app.db, {
    workspaceId: f.workspaceId, operationId: randomUUID(),
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'BROWSER_CLICK', target: 'browser://app.test',
    // 不给 page_id：缺省就是本任务刚建的那一页。
    params: { uid: '1_5' },
  });
  assert.equal(prepared.status, 'WAITING_APPROVAL',
    '提交类点击必须被升级；实际 ' + JSON.stringify(prepared));
  assert.ok(prepared.review_id !== null);
  // 审批文案必须说明"为什么这一步要确认"，而不是抽象的"需要批准"。
  const review = await withTransaction(app.db, (repositories) =>
    repositories.reviews.readRequest(prepared.review_id!));
  assert.ok(review !== undefined);
  assert.match(review.reason, /提交|表单/);
  // 文案必须说清"这是提交类动作"，而不是笼统的"需要批准"或"授权失效"。
  assert.doesNotMatch(review.reason, /范围授权不再自动放行/);
});

test('普通链接点击不被升级：授权范围内 AUTO 直接派发', async () => {
  const f = await fixture({ capability: 'BROWSER_ACTION', actionType: 'BROWSER_CLICK',
    extraActionTypes: ['BROWSER_NEW_PAGE'] });
  const provider = new ScriptedProvider(false);
  useProvider(provider);
  await grantBrowserAction(f);
  const origin = await claim(f);
  await createOwnPage(f, origin);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, {
    workspaceId: f.workspaceId, operationId: op, intentKey: `intent-${randomUUID()}`,
    connectionId: f.connectionId, origin, actionType: 'BROWSER_CLICK',
    target: 'browser://app.test', params: { uid: '1_6' },
  });
  assert.equal(prepared.status, 'PREPARED',
    '普通链接点击不应被升级；实际 ' + JSON.stringify(prepared));
  const dispatched = await dispatchGatewayAction(app.db, {
    workspaceId: f.workspaceId, operationId: op, origin });
  assert.equal(dispatched.status, 'SUCCEEDED',
    '普通链接点击应直接派发；实际 ' + JSON.stringify(dispatched));
  assert.deepEqual(provider.clicks, ['1_6']);
});

test('任务状态跨进程可见，stop 让任务与 Run 一起停下', async () => {
  const f = await fixture({ capability: 'BROWSER_ACTION', actionType: 'BROWSER_NAVIGATE',
    extraActionTypes: ['BROWSER_NEW_PAGE'] });
  useProvider(new ScriptedProvider(false));
  await grantBrowserAction(f);
  const origin = await claim(f);
  await createOwnPage(f, origin);
  const op = randomUUID();
  await prepareGatewayAction(app.db, {
    workspaceId: f.workspaceId, operationId: op, intentKey: `intent-${randomUUID()}`,
    connectionId: f.connectionId, origin, actionType: 'BROWSER_NAVIGATE',
    target: 'browser://app.test', params: { url: 'https://app.test/next' },
  });
  await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin });

  const api = await startTestApi();
  try {
    const list = await api.get(`/api/v1/workspaces/${f.workspaceId}/browser/sessions`);
    assert.equal(list.status, 200, list.text);
    assert.equal(list.headers['cache-control'], 'no-store');
    const body = list.body as { sessions: Array<{ owner_id: string; state: string;
      action_label: string | null }>; idle_ms: number };
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0]?.owner_id, f.runId);
    assert.equal(body.sessions[0]?.state, 'RUNNING');
    assert.equal(body.sessions[0]?.action_label, '导航到新地址');
    assert.equal(typeof body.idle_ms, 'number');

    const stopped = await api.post(
      `/api/v1/workspaces/${f.workspaceId}/browser/sessions/RUN/${f.runId}/stop`, {});
    assert.equal(stopped.status, 200, stopped.text);
    assert.equal((stopped.body as { state: string }).state, 'STOP_REQUESTED');
    assert.equal(typeof (stopped.body as { control_request_id: string | null })
      .control_request_id, 'string');

    const after = await api.get(`/api/v1/workspaces/${f.workspaceId}/browser/sessions`);
    const afterBody = after.body as { sessions: Array<{ state: string }> };
    assert.equal(afterBody.sessions[0]?.state, 'STOP_REQUESTED');

    // Run 控制意图必须真的入队：状态停机后动作不应继续派发。
    const operation = await readGatewayOperation(app.db, f.workspaceId, op);
    assert.equal(operation.operation.status, 'SUCCEEDED');
  } finally {
    await api.stop();
  }
});

test('停止不存在的任务是幂等空操作，不泄露其它工作区', async () => {
  const f = await fixture({ capability: 'BROWSER_ACTION', actionType: 'BROWSER_NAVIGATE' });
  const api = await startTestApi();
  try {
    const response = await api.post(
      `/api/v1/workspaces/${f.workspaceId}/browser/sessions/RUN/${randomUUID()}/stop`, {});
    assert.equal(response.status, 200, response.text);
    assert.equal((response.body as { state: string }).state, 'STOPPED');
  } finally {
    await api.stop();
  }
});

test('real daily Chrome MV3 actions share the Run Gateway permission and PostgreSQL receipts', {
  skip: process.env.RELAY_TEST_BROWSER_BRIDGE_DATA_ROOT === undefined,
}, async () => {
  const bridgeDataRoot = process.env.RELAY_TEST_BROWSER_BRIDGE_DATA_ROOT;
  const fixtureUrl = process.env.RELAY_TEST_BROWSER_FIXTURE_URL;
  assert.ok(bridgeDataRoot && fixtureUrl, 'explicit local bridge and fixture are required');
  const url = new URL(fixtureUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/browser-fixture');
  const target = `browser://${url.host}`;
  const f = await fixture({ capability: 'BROWSER_ACTION', actionType: 'BROWSER_NEW_PAGE',
    extraActionTypes: ['BROWSER_FILL', 'BROWSER_CLICK', 'BROWSER_CLOSE_PAGE'] });
  await grantBrowserAction(f);
  const readConnection = await createFakeConnection(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, capabilities: ['BROWSER_READ'] });
  for (const actionType of ['BROWSER_READ_PAGE', 'BROWSER_WAIT_FOR', 'BROWSER_SCREENSHOT']) {
    await createGatewayPolicy(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
      capability: 'BROWSER_READ', actionType, targetPrefix: target,
      decision: 'AUTO', maxPayloadBytes: 8192 });
  }
  const provider = new ExtensionBridgeProvider({ dataRoot: bridgeDataRoot });
  const previous = replaceBrowserSessionManagerForTest(new BrowserSessionManager({ dataRoot, provider }));
  const origin = await claim(f);
  const operationIds: string[] = [];
  const readTypes = new Set(['BROWSER_READ_PAGE', 'BROWSER_WAIT_FOR', 'BROWSER_SCREENSHOT']);
  let pageId: number | undefined;
  const execute = async (actionType: GatewayActionType, params: JsonObject): Promise<JsonObject> => {
    const operationId = randomUUID();
    const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
      operationId, intentKey: randomUUID(), origin, actionType, target, params,
      connectionId: readTypes.has(actionType) ? readConnection.connectionId : f.connectionId });
    assert.equal(prepared.status, 'PREPARED', `${actionType}: ${JSON.stringify(prepared)}`);
    const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId, origin });
    assert.equal(result.status, 'SUCCEEDED', `${actionType}: ${JSON.stringify(result)}`);
    operationIds.push(operationId);
    assert.ok(result.result_ref);
    return result.result_ref as JsonObject;
  };
  try {
    const created = await execute('BROWSER_NEW_PAGE', { url: fixtureUrl });
    assert.equal(typeof created.page_id, 'number');
    pageId = created.page_id as number;
    const page = { page_id: String(pageId) };
    const snapshot = await execute('BROWSER_WAIT_FOR', { ...page, text: 'Acceptance marker', timeout_ms: 10_000 });
    await execute('BROWSER_READ_PAGE', page);
    const elements = parseSnapshotText(String(snapshot.snapshot)).elements;
    const textbox = elements.find((element) => element.role === 'textbox');
    const button = elements.find((element) => element.role === 'button' && element.name === 'Save marker');
    assert.ok(textbox && button);
    await execute('BROWSER_FILL', { ...page, uid: textbox.uid, text: 'real-gateway-browser-marker' });
    await execute('BROWSER_CLICK', { ...page, uid: button.uid });
    const observed = await execute('BROWSER_WAIT_FOR', { ...page,
      text: 'Saved: real-gateway-browser-marker', timeout_ms: 10_000 });
    assert.match(String(observed.snapshot), /Saved: real-gateway-browser-marker/);
    const screenshot = await execute('BROWSER_SCREENSHOT', page);
    assert.ok(typeof screenshot.bytes === 'number' && screenshot.bytes > 0);
    assert.match(String(screenshot.sha256), /^[a-f0-9]{64}$/);
    await execute('BROWSER_CLOSE_PAGE', page);
    pageId = undefined;
    for (const operationId of operationIds) {
      const persisted = await readGatewayOperation(app.db, f.workspaceId, operationId);
      assert.equal(persisted.operation.status, 'SUCCEEDED');
      assert.equal(persisted.operation.run_id, f.runId);
      assert.equal(persisted.operation.normalized_target, target);
    }
    assert.equal(operationIds.length, 8);
  } finally {
    if (pageId !== undefined) await provider.closePage(pageId).catch(() => {});
    replaceBrowserSessionManagerForTest(previous);
  }
});
