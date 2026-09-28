// Probe the packaged WebView2 against one disposable FILE_WRITE Run.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const [portText, runId, operationId, screenshotPath,
  projectId, resourceId, identityScreenshotPath] = process.argv.slice(2);
const port = Number(portText);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
assert.match(runId ?? '', uuid);
assert.match(operationId ?? '', uuid);
assert.ok(screenshotPath);
assert.match(projectId ?? '', uuid);
assert.match(resourceId ?? '', uuid);
assert.ok(identityScreenshotPath);

const requireWorkbench = createRequire(new URL('../../workbench/package.json', import.meta.url));
const { chromium } = requireWorkbench('@playwright/test');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 });
try {
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => /^http:\/\/tauri\.localhost(?:\/|$)/u.test(candidate.url()));
  assert.ok(page, 'packaged WebView2 main frame absent');
  await page.goto(`http://tauri.localhost/runs/${runId}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('run-detail').waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: '查看动作历史' }).click();
  const operation = page.getByTestId('run-file-write-operation').filter({ hasText: operationId });
  await operation.waitFor({ timeout: 20_000 });
  await operation.getByTestId('file-write-diff-open').click();
  const diff = operation.getByTestId('file-write-frozen-diff');
  await diff.waitFor({ timeout: 20_000 });
  const visible = await diff.innerText();
  assert.match(visible, /冻结计划文本差异/u);
  assert.match(visible, /仅描述计划，不代表文件已应用/u);
  assert.match(visible, /new\.txt · CREATE/u);
  assert.match(visible, /existing\.txt · MODIFY/u);
  assert.match(visible, /baseline/u);
  assert.match(visible, /updated by original invocation/u);
  assert.doesNotMatch(visible, /文本差异不可用/u);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.goto(`http://tauri.localhost/projects/${projectId}/connections`,
    { waitUntil: 'domcontentloaded' });
  const resource = page.locator('.connections-list li').filter({ hasText: resourceId });
  await resource.getByText('Windows 文件写入目录身份：已绑定').waitFor({ timeout: 20_000 });
  await page.screenshot({ path: identityScreenshotPath, fullPage: true });
  console.log(JSON.stringify({ webview_file_write_diff: 'PASS', run_id: runId,
    operation_id: operationId, screenshot: screenshotPath,
    managed_root_identity: 'BOUND', identity_screenshot: identityScreenshotPath }));
} finally {
  await browser.close();
}
