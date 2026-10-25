import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import {
  claimRunForGateway, dispatchGatewayAction, prepareGatewayAction, readGatewayOperation,
  type GatewayOrigin,
} from '../../src/application/gateway-actions.js';
import { createFakeConnection, createGatewayPolicy, registerManagedResource }
  from '../../src/application/gateway-configuration.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { replaceBrowserSessionManagerForTest } from '../../src/browser/client-holder.js';
import { BrowserSessionManager } from '../../src/browser/session-manager.js';
import { readBrowserBackendState } from '../../src/browser/state.js';
import type {
  BrowserHealth, BrowserPageRef, BrowserProvider, BrowserSnapshot,
} from '../../src/browser/provider.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { createDataRoot, startTestApi } from './api-harness.js';
import {
  APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase,
} from './integration-support.js';

/**
 * F26 M2：浏览器只读能力走完整 Gateway 生命周期（prepare → claim → dispatch → settle）
 * 的真实 PG 证据，以及 0106 健康投影的跨进程可见性。
 *
 * 浏览器后端用受控替身（不启动真实 Chrome）：本套件验证的是**准入、目标归一、
 * 账本与投影**，真实 Chrome 链路由 `browser-m1-smoke` 与后续 M4 的浏览器实测覆盖。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-browser-f26');
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

class StubProvider implements BrowserProvider {
  readonly kind = 'stub';
  readonly pages = new Map<number, { url: string; title: string }>([[1, { url: 'about:blank', title: '' }]]);
  nextId = 1;
  constructor(private readonly state: BrowserHealth) {}
  async ensureStarted(): Promise<BrowserHealth> { return this.state; }
  async health(): Promise<BrowserHealth> { return this.state; }
  async listPages(): Promise<readonly BrowserPageRef[]> {
    return [...this.pages.entries()].map(([pageId, page]) => ({ pageId, ...page }));
  }
  async newPage(input: { url?: string }): Promise<BrowserPageRef> {
    const pageId = this.nextId += 1;
    const url = input.url ?? 'about:blank';
    this.pages.set(pageId, { url, title: `page-${pageId}` });
    return { pageId, url, title: `page-${pageId}` };
  }
  async closePage(pageId: number): Promise<void> { this.pages.delete(pageId); }
  async readPage(pageId: number): Promise<BrowserSnapshot> { return this.snapshot(pageId); }
  async navigate(input: { pageId: number; url?: string }): Promise<BrowserSnapshot> {
    if (input.url !== undefined) this.pages.set(input.pageId, { url: input.url, title: 'nav' });
    return this.snapshot(input.pageId);
  }
  async click(input: { pageId: number }): Promise<BrowserSnapshot> { return this.snapshot(input.pageId); }
  async fill(input: { pageId: number }): Promise<BrowserSnapshot> { return this.snapshot(input.pageId); }
  async pressKey(input: { pageId: number }): Promise<BrowserSnapshot> { return this.snapshot(input.pageId); }
  async waitFor(input: { pageId: number }): Promise<BrowserSnapshot> { return this.snapshot(input.pageId); }
  async submitForm(input: { pageId: number }): Promise<BrowserSnapshot> { return this.snapshot(input.pageId); }
  async uploadFile(input: { pageId: number }): Promise<BrowserSnapshot> { return this.snapshot(input.pageId); }
  async screenshot(): Promise<{ width: number; height: number; bytes: number;
    sha256: string; mimeType: string }> {
    return { width: 100, height: 100, bytes: 1, sha256: 'a'.repeat(64), mimeType: 'image/png' };
  }
  async dispose(): Promise<void> {}
  private snapshot(pageId: number): BrowserSnapshot {
    const page = this.pages.get(pageId) ?? { url: '', title: '' };
    return { pageId, url: page.url, title: page.title, readyState: 'complete', truncated: false,
      text: `uid=1_0 RootWebArea url="${page.url}"`,
      elements: [{ uid: '1_0', role: 'RootWebArea', name: '', inForm: false }] };
  }
}

const READY: BrowserHealth = { status: 'READY', backendVersion: '1.11.0',
  chromeVersion: 'Chrome/155', tools: ['list_pages', 'take_snapshot'], detail: '就绪',
  remediation: null };

interface Fixture {
  workspaceId: string; projectId: string; taskId: string; runId: string; stepId: string;
  resourceId: string; connectionId: string;
}

async function fixture(input: {
  capability: 'BROWSER_READ' | 'BROWSER_ACTION';
  actionType: string; targetPrefix: string; decision?: 'AUTO' | 'ASK';
}): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `f26-${workspaceId}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'F26',
      projectType: 'DEVELOPMENT' });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
    await repositories.tasks.insertTask({ id: taskId, workspaceId, projectId, title: 'Browser',
      status: 'READY', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
      ownershipEpoch: 0n, currentCompletionId: null });
    await repositories.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: 'F26 浏览器', requiredOutputSpec: {}, source: 'CREATE' });
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
  const root = join(dataRoot, `f26-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const resource = await registerManagedResource(app.db, { workspaceId, projectId, rootPath: root });
  const connection = await createFakeConnection(app.db, { workspaceId, projectId,
    capabilities: [input.capability] });
  await createGatewayPolicy(app.db, { workspaceId, projectId, capability: input.capability,
    actionType: input.actionType, targetPrefix: input.targetPrefix,
    decision: input.decision ?? 'AUTO', maxPayloadBytes: 8192 });
  return { workspaceId, projectId, taskId, runId, stepId: step.id,
    resourceId: resource.resourceId, connectionId: connection.connectionId };
}

async function claim(f: Fixture): Promise<GatewayOrigin> {
  const workerId = `worker-${randomUUID()}`;
  const held = await claimRunForGateway(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId });
  return { kind: 'RUN', runId: f.runId, stepId: f.stepId, resourceId: f.resourceId,
    workerId, workerEpoch: BigInt(held.worker_epoch) };
}

function useProvider(provider: BrowserProvider): void {
  replaceBrowserSessionManagerForTest(
    new BrowserSessionManager({ dataRoot, provider }));
}

test('BROWSER_READ 走完整 Gateway：prepare → dispatch 成功并留下账本与健康投影', async () => {
  const f = await fixture({ capability: 'BROWSER_READ', actionType: 'BROWSER_LIST_PAGES',
    targetPrefix: 'browser://' });
  useProvider(new StubProvider(READY));
  const origin = await claim(f);
  const op = randomUUID();
  const prepared = await prepareGatewayAction(app.db, {
    workspaceId: f.workspaceId, operationId: op, intentKey: `intent-${randomUUID()}`,
    connectionId: f.connectionId, origin, actionType: 'BROWSER_LIST_PAGES',
    target: 'browser://unknown', params: {},
  });
  assert.equal(prepared.status, 'PREPARED');

  const dispatched = await dispatchGatewayAction(app.db, {
    workspaceId: f.workspaceId, operationId: op, origin });
  assert.equal(dispatched.status, 'SUCCEEDED');
  const result = dispatched.result_ref as { type: string; count: number;
    pages: Array<{ page_id: number; owned: boolean }> };
  assert.equal(result.type, 'browser_pages');
  assert.equal(result.count, 1);
  assert.equal(result.pages[0]?.owned, false, '用户/系统页对本任务 owned=false');

  const persisted = await readGatewayOperation(app.db, f.workspaceId, op);
  assert.equal(persisted.operation.status, 'SUCCEEDED');
  assert.equal(persisted.operation.capability_key, 'BROWSER_READ');
  assert.equal(persisted.operation.normalized_target, 'browser://unknown');

  const health = await readBrowserBackendState(app.db);
  assert.equal(health.status, 'READY');
  assert.equal(health.backend_version, '1.11.0');
  assert.equal(health.chrome_version, 'Chrome/155');
  assert.equal(health.tool_count, 2);
});

test('策略按站点收窄：只允许的 origin 放行，别的 origin 在 prepare 就被拒', async () => {
  const allowed = await fixture({ capability: 'BROWSER_READ', actionType: 'BROWSER_READ_PAGE',
    targetPrefix: 'browser://allowed.test' });
  useProvider(new StubProvider(READY));
  const origin = await claim(allowed);
  const ok = await prepareGatewayAction(app.db, {
    workspaceId: allowed.workspaceId, operationId: randomUUID(),
    intentKey: `intent-${randomUUID()}`, connectionId: allowed.connectionId, origin,
    actionType: 'BROWSER_READ_PAGE', target: 'browser://allowed.test', params: {},
  });
  assert.equal(ok.status, 'PREPARED');

  await assert.rejects(prepareGatewayAction(app.db, {
    workspaceId: allowed.workspaceId, operationId: randomUUID(),
    intentKey: `intent-${randomUUID()}`, connectionId: allowed.connectionId, origin,
    actionType: 'BROWSER_READ_PAGE', target: 'browser://other.test', params: {},
  }), (error: unknown) => code(error) !== undefined,
  '不在策略前缀内的站点必须被准入拒绝');
});

test('目标形状：不是 browser://<origin> 的合成值一律拒绝', async () => {
  const f = await fixture({ capability: 'BROWSER_READ', actionType: 'BROWSER_READ_PAGE',
    targetPrefix: 'browser://' });
  useProvider(new StubProvider(READY));
  const origin = await claim(f);
  for (const target of ['https://example.com', 'browser://https://a.test/path',
    'browser://user@a.test', 'browser://']) {
    await assert.rejects(prepareGatewayAction(app.db, {
      workspaceId: f.workspaceId, operationId: randomUUID(),
      intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
      actionType: 'BROWSER_READ_PAGE', target, params: {},
    }), (error: unknown) => code(error) === 'GATEWAY_TARGET_DENIED',
    `target ${target} 必须被拒绝`);
  }
});

test('后端不可用：派发以类型化原因失败，并把失败写进健康投影', async () => {
  const f = await fixture({ capability: 'BROWSER_READ', actionType: 'BROWSER_LIST_PAGES',
    targetPrefix: 'browser://' });
  useProvider(new StubProvider({
    status: 'CHROME_MISSING', backendVersion: null, chromeVersion: null, tools: [],
    detail: '未找到 Google Chrome。', remediation: '安装 Chrome 或设置 RELAY_BROWSER_CHROME_PATH。',
  }));
  const origin = await claim(f);
  const op = randomUUID();
  await prepareGatewayAction(app.db, {
    workspaceId: f.workspaceId, operationId: op, intentKey: `intent-${randomUUID()}`,
    connectionId: f.connectionId, origin, actionType: 'BROWSER_LIST_PAGES',
    target: 'browser://unknown', params: {},
  });
  const dispatched = await dispatchGatewayAction(app.db, {
    workspaceId: f.workspaceId, operationId: op, origin });
  assert.equal(dispatched.status, 'FAILED');
  const result = dispatched.result_ref as { reason: string; error: string };
  assert.equal(result.reason, 'BROWSER_CHROME_MISSING');
  assert.match(result.error, /RELAY_BROWSER_CHROME_PATH/);

  const health = await readBrowserBackendState(app.db);
  assert.equal(health.status, 'CHROME_MISSING');
  assert.equal(health.remediation !== null, true);
});

test('BROWSER_ACTION 默认需要审批：AUTO 策略也会被降级为 ASK', async () => {
  const f = await fixture({ capability: 'BROWSER_ACTION', actionType: 'BROWSER_CLICK',
    targetPrefix: 'browser://', decision: 'AUTO' });
  useProvider(new StubProvider(READY));
  const origin = await claim(f);
  const prepared = await prepareGatewayAction(app.db, {
    workspaceId: f.workspaceId, operationId: randomUUID(),
    intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
    actionType: 'BROWSER_CLICK', target: 'browser://unknown',
    params: { uid: '1_4' },
  });
  // approvalPassthrough=false：没有范围授权时 AUTO 必须降级为单动作审批。
  assert.equal(prepared.status, 'WAITING_APPROVAL');
  assert.ok(prepared.review_id !== null);
});

test('GET /browser/status 跨进程读到同一份健康投影', async () => {
  const f = await fixture({ capability: 'BROWSER_READ', actionType: 'BROWSER_LIST_PAGES',
    targetPrefix: 'browser://' });
  useProvider(new StubProvider(READY));
  const origin = await claim(f);
  const op = randomUUID();
  await prepareGatewayAction(app.db, {
    workspaceId: f.workspaceId, operationId: op, intentKey: `intent-${randomUUID()}`,
    connectionId: f.connectionId, origin, actionType: 'BROWSER_LIST_PAGES',
    target: 'browser://unknown', params: {},
  });
  await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: op, origin });

  const api = await startTestApi();
  try {
    const response = await api.get(`/api/v1/workspaces/${f.workspaceId}/browser/status`);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.headers['cache-control'], 'no-store');
    const body = response.body as { status: string; backend_version: string | null;
      tool_count: number; updated_at: string | null };
    assert.equal(body.status, 'READY');
    assert.equal(body.backend_version, '1.11.0');
    assert.equal(body.tool_count, 2);
    assert.match(body.updated_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await api.stop();
  }
});

test('GET /plugins/status 经真实 API 返回三个内置插件的安装级状态（不缓存、无凭据）', async () => {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `f26-plugins-${workspaceId}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  const api = await startTestApi();
  try {
    const response = await api.get(`/api/v1/workspaces/${workspaceId}/plugins/status`);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.headers['cache-control'], 'no-store');
    const body = response.body as { items: Array<{ plugin: string; state: string;
      detail: string; remediation: string | null }> };
    assert.deepEqual(body.items.map((item) => item.plugin).sort(),
      ['browser', 'computer', 'github'], '三个内置插件恒在');
    for (const item of body.items) {
      assert.match(item.state,
        /^(READY|NOT_INSTALLED|NOT_PAIRED|NOT_AUTHENTICATED|UNAVAILABLE)$/u,
        `${item.plugin} 状态必须在词表内：${item.state}`);
      assert.ok(item.detail.length > 0, `${item.plugin} 必须带可读 detail`);
      // 安装级探测不携带任何凭据形态。
      assert.doesNotMatch(JSON.stringify(item), /token|gho_|ghp_/iu);
    }
  } finally {
    await api.stop();
  }
});
