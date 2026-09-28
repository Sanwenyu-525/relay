// Inspect and confirm the original no-receipt FILE_WRITE in packaged WebView2.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const [portText, runId, operationId, beforePath, afterPath] = process.argv.slice(2);
const port = Number(portText);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
assert.match(runId ?? '', uuid);
assert.match(operationId ?? '', uuid);
assert.ok(beforePath && afterPath);
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
  const preview = operation.getByTestId('file-write-preview');
  await preview.waitFor({ timeout: 20_000 });
  const visible = await preview.innerText();
  assert.match(visible, /原助手没有留下执行回执/u);
  assert.match(visible, /不能归因于原调用/u);
  assert.match(visible, /new\.txt/u);
  assert.match(visible, /existing\.txt/u);
  assert.match(visible, /当前目标 File ID/u);
  await operation.getByTestId('file-write-dispose-open').waitFor({ timeout: 20_000 });
  await page.screenshot({ path: beforePath, fullPage: true });
  await operation.getByTestId('file-write-dispose-open').click();
  await page.getByText('确认人工结清无回执文件写入').waitFor({ timeout: 10_000 });
  await page.getByTestId('file-write-dispose-confirm').click();
  await page.getByText(/原 FILE_WRITE 已人工结清|已找到原命令回执/u)
    .waitFor({ timeout: 30_000 });
  await page.screenshot({ path: afterPath, fullPage: true });
  console.log(JSON.stringify({ webview_no_receipt: 'PASS', run_id: runId,
    operation_id: operationId, before: beforePath, after: afterPath }));
} finally {
  await browser.close();
}
