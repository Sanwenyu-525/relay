// Real packaged WebView2 + disposable PostgreSQL business path via CDP.
// Playwright fill() is synthetic input and is never evidence of Windows IME behavior.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
const port = Number(process.argv[3]);
if (!/^relay-m02-acceptance-[0-9a-f]{32}$/i.test(root.split(/[\\/]/).at(-1) ?? '') ||
    !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Usage: node check-webview-human-chain.mjs <session-root> <CDP-port>');
}
const session = JSON.parse(readFileSync(join(root, 'session.json'), 'utf8').replace(/^\uFEFF/, ''));
const hash = createHash('sha256').update(readFileSync(session.release_exe)).digest('hex');
if (hash !== session.release_sha256) throw new Error('Release hash differs from session marker');
const requireWorkbench = createRequire(new URL('../../workbench/package.json', import.meta.url));
const { chromium, expect } = requireWorkbench('@playwright/test');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const pages = browser.contexts().flatMap((context) => context.pages())
    .filter((page) => /^http:\/\/tauri\.localhost(?:\/|$)/.test(page.url()));
  if (pages.length !== 1) throw new Error(`Expected one packaged WebView, found ${pages.length}`);
  const page = pages[0];
  await page.goto('http://tauri.localhost/projects');
  await expect(page.getByTestId('relay-connection-open')).toContainText('已连接本机 API');
  await page.getByTestId('project-create-open').click();
  await page.locator('input[name="project-title"]').fill(`M02 WebView 闭环 ${session.session_id.slice(0, 8)}`);
  await page.locator('input[name="project-type"][value="GENERAL"]').check({ force: true });
  await page.getByTestId('project-create-submit').click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/tasks$/u);
  const projectId = /\/projects\/([0-9a-f-]{36})\/tasks$/u.exec(new URL(page.url()).pathname)?.[1];
  if (!projectId) throw new Error('Project ID missing after creation');

  await page.getByRole('link', { name: '新建任务' }).click();
  await page.locator('input[name="task-title"]').fill('M02 WebView 人工任务');
  await page.locator('input[name="task-expected-result"]').fill('可核对的 Markdown 产物');
  await page.locator('textarea[name="task-acceptance"]').fill('产物包含自检结论');
  await page.getByTestId('task-create-save').click();
  await expect(page.getByTestId('task-created-result')).toContainText('任务已创建');
  const taskId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u
    .exec(await page.getByTestId('task-created-result').innerText())?.[0];
  if (!taskId) throw new Error('Task ID missing after creation');

  await page.getByRole('button', { name: '返回任务入口' }).click();
  await page.locator('.app-sidebar').getByRole('link', { name: '项目' }).click();
  await page.locator('input[name="live-project-id"]').fill(projectId);
  await page.getByTestId('projects-live-open').click();
  await page.getByTestId('rail-trigger').click();
  const rail = page.getByRole('dialog', { name: '任务判断' });
  await expect(rail.getByTestId('project-task-start')).toBeEnabled();
  await rail.getByTestId('project-task-start').click();
  await expect(rail.getByText('已开始：', { exact: false })).toBeVisible();
  await rail.getByRole('link', { name: '打开任务详情' }).click();
  await expect(page.getByTestId('task-detail')).toContainText('M02 WebView 人工任务');
  await page.getByTestId('task-detail-tab-artifacts').click();
  await page.locator('textarea[name="artifact-content"]').fill('# 真实自检\n\n产物包含自检结论。');
  await page.getByTestId('artifact-save').click();
  await expect(page.getByTestId('artifact-save-receipt')).toContainText('v1');
  await page.getByTestId('artifact-select-version').click();
  await expect(page.getByText('项目 State 已选用', { exact: false })).toBeVisible();
  await page.locator('[data-testid^="criterion-"]').first().check();
  await page.getByTestId('task-complete').click();
  await expect(page.getByTestId('task-complete-receipt')).toContainText('已完成本轮');
  await page.locator('input[name="reopen-reason"]').fill('核对新一轮验收');
  await page.getByTestId('task-reopen-submit').click();
  await expect(page.getByTestId('task-reopen-receipt')).toContainText('已重开');
  console.log(`release_sha256=${hash} project_id=${projectId} task_id=${taskId} webview_pg_business_chain=pass synthetic_input=true`);
} finally { await browser.close(); }
