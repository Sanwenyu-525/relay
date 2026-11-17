import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';

import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath,
  type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase }
  from './integration-support.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';

/**
 * 2026-11-15 第二轮任务页专项：真实 PostgreSQL + 真实 Relay API + 真实 Workbench 的联合验收。
 *
 * 浏览器不拦截正常数据：`/tasks` 的列表、项目名、任务详情都走 startTestApi 启动的真实进程
 * 与临时 PostgreSQL。只有「刷新失败保留旧数据 / 失权清空」这两步用 Playwright route 注入
 * 503/401——这是验证失败后果必须的故障注入，不替代正常读取。
 *
 * 数据全部由真实 API 命令创建；WAITING 的 Run 与冻结契约、BLOCKED 的依赖、归档 Project
 * 用真实表写入（与 task-list-read-budget 同一口径），不用前端夹具。
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '../../..');
const repoRoot = resolve(apiRoot, '../..');
const workbenchRoot = resolve(repoRoot, 'apps', 'workbench');
const evidenceDir = resolve(repoRoot, 'tmp', 'tasks-ui-backend-20261115');
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-task-page-real-e2e');
let api: TestApi;
let vite: ChildProcess | undefined;
let browser: BrowserLike | undefined;

interface PageLike {
  goto(url: string, options?: unknown): Promise<unknown>;
  screenshot(options: unknown): Promise<unknown>;
  getByTestId(id: string): {
    click(): Promise<void>;
    fill(value: string): Promise<void>;
    isVisible(): Promise<boolean>;
    textContent(): Promise<string | null>;
    count(): Promise<number>;
    first(): { click(): Promise<void>; textContent(): Promise<string | null> };
  };
  locator(selector: string): {
    click(): Promise<void>;
    fill(value: string): Promise<void>;
    first(): { textContent(): Promise<string | null>; click(): Promise<void> };
    count(): Promise<number>;
    innerText(): Promise<string>;
  };
  on(event: string, handler: (arg: any) => void): void;
  goBack(options?: unknown): Promise<unknown>;
  getByText(text: string | RegExp, options?: unknown): {
    first(): { textContent(): Promise<string | null>; click(): Promise<void> };
  };
  getByRole(role: string, options?: unknown): { first(): { isVisible(): Promise<boolean> } };
  waitForSelector(selector: string, options?: unknown): Promise<unknown>;
  waitForFunction(fn: () => boolean, options?: unknown): Promise<unknown>;
  url(): string;
  keyboard: { press(key: string): Promise<void> };
  route(url: string, handler: (route: {
    fulfill(options: unknown): Promise<void>; abort(): Promise<void> }) => Promise<void>): Promise<void>;
  unroute(url: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
}

interface BrowserLike {
  newPage(options?: unknown): Promise<PageLike>;
  close(): Promise<void>;
}

function responseJson(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

async function createProject(workspaceId: string, title: string,
  projectType = 'GENERAL'): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/projects'), {
    command_id: commandId, title, project_type: projectType,
  });
  return expectCommandAccepted(response, 201, commandId).project_id as string;
}

async function createTask(workspaceId: string, projectId: string | null, title: string): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: commandId, project_id: projectId, title,
    objective: `完成 ${title}`, criteria: [{ statement: '核对结果' }],
  });
  return expectCommandAccepted(response, 201, commandId).task_id as string;
}

/** Run 与 execution_contracts 必须同事务（fk_runs_contract 延迟外键）；再把 Task 改成 AI WAITING。 */
async function parkAsWaiting(workspaceId: string, taskId: string, waitReason: string): Promise<void> {
  const runId = randomUUID();
  await app.db.transaction().execute(async (trx) => {
    await sql`
      insert into runs (id, workspace_id, task_id, status, ownership_epoch, wait_reason)
      values (${runId}, ${workspaceId}, ${taskId}, 'WAITING_APPROVAL', 1, ${waitReason})
    `.execute(trx);
    await sql`
      insert into execution_contracts (run_id, task_id, acceptance_revision, workflow_key,
        workflow_version, execution_config_version, contract_hash, frozen_snapshot)
      values (${runId}, ${taskId}, 1, 'task-execution', 'v1', 'v1',
        ${Buffer.alloc(32, 1)}::bytea, '{}'::jsonb)
    `.execute(trx);
    await sql`
      update tasks set status = 'WAITING', mode = 'DELEGATE_AI', executor_kind = 'AI',
        executor_run_id = ${runId}, revision = revision + 1
      where id = ${taskId}
    `.execute(trx);
  });
}

async function waitForVite(origin: string, timeoutMs = 60_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${origin}/tasks`);
      if (response.ok) return true;
    } catch {
      // Vite 还没监听：继续等。
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  return false;
}

function startVite(port: number): ChildProcess {
  const viteEntry = resolve(workbenchRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteEntry, '--host', '127.0.0.1',
    '--port', String(port), '--strictPort'], {
    cwd: workbenchRoot,
    env: { ...process.env, BROWSER: 'none', RELAY_E2E_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { output += chunk; });
  child.stderr?.on('data', (chunk: string) => { output += chunk; });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`[real-e2e] Vite exited ${code}\n${output.slice(-1000)}`);
  });
  return child;
}

async function readText(page: PageLike, testId: string): Promise<string> {
  const node = page.getByTestId(testId);
  return (await node.textContent()) ?? '';
}

async function connect(page: PageLike, origin: string, workspaceId: string): Promise<void> {
  await page.goto(`${origin}/tasks`);
  page.on('console', (message: any) => console.log('[browser-console]', message.type(), message.text()));
  page.on('pageerror', (error: any) => console.log('[browser-error]', error.message));
  page.on('response', (response: any) => {
    if (String(response.url()).includes('/tasks') || String(response.url()).includes('/projects')) {
      console.log('[http]', response.status(), response.url());
    }
  });
  await page.getByTestId('relay-connection-open').click();
  await page.locator('input[name="relay-base-url"]').fill(`http://127.0.0.1:${api.port}`);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill(api.bearerToken);
  await page.getByTestId('relay-connect').click();
  await page.waitForSelector('[data-testid="relay-connection-state"]:has-text("已连接")',
    { timeout: 10_000 });
  await page.keyboard.press('Escape');
}

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});

after(async () => {
  await browser?.close();
  vite?.kill();
  await api?.stop();
  await app.close();
});

test('真实 API + 真实 PostgreSQL：任务列表、原因、归档、游标、详情与刷新失败边界', async () => {
  assert.ok(api, '真实 API 必须已启动');
  const workspaceId = await createWorkspace(app.db);
  const projectA = await createProject(workspaceId, '真实项目甲', 'THESIS');
  const projectB = await createProject(workspaceId, '真实项目乙', 'DEVELOPMENT');
  const archivedProject = await createProject(workspaceId, '真实归档项目', 'GENERAL');

  // 46 条普通任务先建，保证特殊任务落在第一页；总共 52 条，验证游标还有第二页。
  const filler: string[] = [];
  for (let index = 0; index < 46; index += 1) {
    filler.push(await createTask(workspaceId, index % 3 === 0 ? projectA : index % 3 === 1 ? projectB : null,
      `真实任务 ${String(index + 1).padStart(2, '0')}`));
  }
  const dependencyTask = filler.find((_id, index) => index % 3 === 0) ?? filler[0]!;
  const waitingTask = await createTask(workspaceId, projectA, '真实等待审批任务');
  const blockedTask = await createTask(workspaceId, projectA, '真实阻塞任务');
  const archivedTask = await createTask(workspaceId, archivedProject, '归档项目里的任务');
  const projectBTask = await createTask(workspaceId, projectB, '项目乙里的任务');
  const inboxTask = await createTask(workspaceId, null, '真实收件箱任务');
  const extraBTask = await createTask(workspaceId, projectB, '项目乙第二条任务');

  await parkAsWaiting(workspaceId, waitingTask, 'ACTION_APPROVAL_REQUIRED');
  await sql`
    insert into task_dependencies (workspace_id, task_id, depends_on_task_id, dependency_kind)
    values (${workspaceId}, ${blockedTask}, ${dependencyTask}, 'BLOCKS')
  `.execute(app.db);
  await sql`update tasks set status = 'BLOCKED' where id = ${blockedTask}`.execute(app.db);
  // 归档栅栏会拒绝新任务写入：必须先建任务，再归档。
  await sql`update projects set archived_at = now() where id = ${archivedProject}`.execute(app.db);

  // 真实 Workbench 与真实 API 同源放行：Vite 页面 origin 必须等于 API 的 allowedOrigin。
  const origin = api.allowedOrigin;
  const vitePort = Number(new URL(origin).port);
  vite = startVite(vitePort);
  assert.ok(await waitForVite(origin), 'Vite 未能在 60s 内提供 /tasks');
  const requireFromHere = createRequire(import.meta.url);
  const playwright = requireFromHere(resolve(workbenchRoot, 'node_modules', '@playwright', 'test')) as {
    chromium: { launch(options?: unknown): Promise<BrowserLike> };
  };
  browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  mkdirSync(evidenceDir, { recursive: true });

  try {
    await connect(page, origin, workspaceId);
    try {
      await page.waitForSelector('[data-testid="tasks-live-count"]', { timeout: 15_000 });
    } catch (error) {
      await page.screenshot({ path: resolve(evidenceDir, 'real-api-debug.png'), fullPage: true });
      console.log('[real-e2e] body after connect:\n' + (await page.locator('body').innerText()).slice(0, 2500));
      throw error;
    }
    const firstCount = await readText(page, 'tasks-live-count');
    assert.match(firstCount, /已加载 50 项/u, `首屏应为 50 项真实任务：${firstCount}`);
    assert.match(firstCount, /仍有后续页/u);
    await page.screenshot({ path: resolve(evidenceDir, 'real-api-tasks-1440.png'), fullPage: true });

    // 真实 Project 名称（按 ID 批量读）与归档后缀。
    const tableText = await page.locator('.task-table-card').first().textContent();
    assert.ok(tableText?.includes('真实项目甲'), '项目甲名称应来自真实 /projects?ids=');
    assert.ok(tableText?.includes('真实项目乙'));
    assert.ok(tableText?.includes('真实归档项目（已归档）'), '归档项目必须带真实归档后缀');
    assert.ok(!tableText?.includes(projectA), '不得把 Project UUID 当作名称');
    // 真实 WAITING Run 的 wait_reason 与真实 BLOCKED 依赖事实。
    assert.ok(tableText?.includes('等待你批准动作'), 'WAITING 应显示真实 ACTION_APPROVAL_REQUIRED 文案');
    assert.ok(tableText?.includes('1 个前置任务未完成'), 'BLOCKED 应显示真实依赖计数');
    assert.ok(tableText?.includes('未归属项目'), '未归属任务必须保留');

    // 任务详情是真实路由跳转与真实详情读取。
    await page.getByTestId(`task-row-link-${waitingTask}`).click();
    await page.waitForSelector('[data-testid="task-detail-reason"]', { timeout: 10_000 });
    const detailText = await page.locator('[data-testid="task-detail-reason"]').first().textContent();
    assert.ok(detailText?.includes('等待你批准动作'), `详情原因应走同一真实事实：${detailText}`);
    await page.screenshot({ path: resolve(evidenceDir, 'real-api-task-detail.png'), fullPage: true });
    // 连接状态只在当前页面内存中；必须用浏览器后退，不能整页 goto 重新加载（否则会回到 fixture）。
    await page.goBack();
    await page.waitForSelector('[data-testid="tasks-live-count"]', { timeout: 10_000 });

    // 真实游标分页：第二页只有 2 条最早的任务。
    await page.getByTestId('tasks-live-load-more').click();
    await page.waitForSelector('[data-testid="tasks-live-count"]:has-text("已加载 52 项")',
      { timeout: 10_000 });
    const afterMore = await readText(page, 'tasks-live-count');
    assert.match(afterMore, /52/u);
    assert.match(afterMore, /已到列表末页/u);

    // 真实刷新：新任务先经真实 API 写入，再从浏览器刷新读到。
    const refreshedTask = await createTask(workspaceId, projectA, '刷新后新增的真实任务');
    await page.getByTestId('tasks-live-refresh').click();
    await page.waitForSelector('.task-table-card:has-text("刷新后新增的真实任务")',
      { timeout: 10_000 });
    assert.ok((await readText(page, 'tasks-live-count')).includes('已加载 50 项'), '刷新后回到第一页 50 项');
    // DTO 解析一致性：新任务的项目名同样经批量读解析，不是 UUID。
    assert.ok((await page.locator('.task-table-card').first().textContent())?.includes('真实项目甲'));

    // 故障注入 1：503 只影响名称/刷新提示，不丢已读任务。
    await page.route('**/tasks?scope=all', async (route: { fulfill(options: unknown): Promise<void> }) => {
      await route.fulfill({ status: 503, contentType: 'application/problem+json',
        headers: { 'access-control-allow-origin': origin },
        body: JSON.stringify({ code: 'DATABASE_UNAVAILABLE', detail: '真实数据库暂时不可达（注入）' }) });
    });
    await page.getByTestId('tasks-live-refresh').click();
    await page.waitForSelector('[data-testid="tasks-live-refresh-error"]', { timeout: 10_000 });
    const staleCount = await readText(page, 'tasks-live-count');
    assert.match(staleCount, /已加载 50 项/u, '503 刷新失败必须保留旧数据');
    assert.ok((await page.locator('.task-table-card').first().textContent())?.includes('刷新后新增的真实任务'));
    await page.screenshot({ path: resolve(evidenceDir, 'real-api-refresh-503.png'), fullPage: true });
    await page.unroute('**/tasks?scope=all');

    // 故障注入 2：401 属于失权，必须清空旧行并回到全页错误态。
    await page.route('**/tasks?scope=all', async (route: { fulfill(options: unknown): Promise<void> }) => {
      await route.fulfill({ status: 401, contentType: 'application/problem+json',
        headers: { 'access-control-allow-origin': origin },
        body: JSON.stringify({ code: 'AUTH_REQUIRED', detail: '凭据已失效（注入）' }) });
    });
    await page.getByTestId('tasks-live-refresh').click();
    await page.waitForSelector('div.page-state--error', { timeout: 10_000 });
    assert.equal(await page.getByTestId('tasks-live-count').count(), 0, '失权后不得保留计数与旧行');
    assert.equal(await page.getByTestId(`task-row-${refreshedTask}`).count(), 0);
    await page.unroute('**/tasks?scope=all');

    // 恢复：解除注入后再刷新，真实 API 数据回来。
    await page.locator('button:has-text("重新读取")').first().click();
    await page.waitForSelector('[data-testid="tasks-live-count"]', { timeout: 10_000 });
    assert.match(await readText(page, 'tasks-live-count'), /已加载 50 项/u);
    assert.ok((await page.locator('.task-table-card').first().textContent())?.includes('刷新后新增的真实任务'));

    writeFileSync(resolve(evidenceDir, 'real-api-e2e.json'), JSON.stringify({
      apiPort: api.port, origin, workspaceId, firstPage: 50, totalAfterMore: 52,
      waitingTask, blockedTask, archivedTask, projectBTask, inboxTask, extraBTask,
      refreshedTask, detail: '真实 route /tasks/:id', injectedFailures: ['503 refresh', '401 auth'],
    }, null, 2));
  } finally {
    await browser?.close();
  }
});
