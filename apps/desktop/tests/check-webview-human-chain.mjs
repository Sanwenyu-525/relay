// Real packaged WebView2 + disposable PostgreSQL business path via CDP.
// Playwright fill() is synthetic input and is never evidence of Windows IME behavior.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
  // 2026-10-25：导航栏从 .app-sidebar 重构为 .app-navrail（navigation-item 链接）；
  // 选择器跟随当前结构，「项目」入口的语义断言不变。
  await page.locator('.app-navrail').getByRole('link', { name: '项目' }).click();
  // 2026-10-25：「按 ID 打开」是深度链接备用入口，收在「高级」折叠（details）里，
  // 先展开摘要再填写；表单提交即导航，业务断言不变。
  await page.getByText('高级：粘贴项目 ID 打开任务').click();
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
  const firstContent = '# 真实自检\n\n产物包含自检结论。';
  await page.locator('textarea[name="artifact-content"]').fill(firstContent);
  const artifactSavePending = page.waitForResponse((response) => response.request().method() === 'POST' &&
    new URL(response.url()).pathname.endsWith(`/tasks/${taskId}/artifacts`));
  await page.getByTestId('artifact-save').click();
  const artifactSave = await artifactSavePending;
  assert.equal(artifactSave.status(), 201);
  const artifactSaveRequest = artifactSave.request().postDataJSON();
  const artifactSaveEnvelope = await artifactSave.json();
  assert.equal(artifactSaveEnvelope.command_id, artifactSaveRequest.command_id);
  const firstVersion = artifactSaveEnvelope.result;
  assert.equal(firstVersion.task_id, taskId);
  assert.equal(firstVersion.version_number, '1');
  assert.equal(firstVersion.sha256, createHash('sha256').update(firstContent).digest('hex'));
  assert.match(firstVersion.artifact_id, /^[0-9a-f-]{36}$/iu);
  assert.match(firstVersion.version_id, /^[0-9a-f-]{36}$/iu);
  await expect(page.getByTestId('artifact-save-receipt')).toContainText('v1');

  const authorization = await artifactSave.request().headerValue('authorization');
  assert.ok(authorization?.startsWith('Bearer '), 'the packaged WebView save request omitted its scoped bearer');
  const apiBase = new URL(artifactSave.url()).origin;
  const workspaceMatch = /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/tasks\/[0-9a-f-]{36}\/artifacts$/iu
    .exec(new URL(artifactSave.url()).pathname);
  if (!workspaceMatch) throw new Error('Artifact save request did not identify its Workspace scope');
  const workspaceId = workspaceMatch[1];
  const apiPath = `/api/v1/workspaces/${workspaceId}`;
  const apiHeaders = { authorization, origin: 'http://tauri.localhost', 'content-type': 'application/json' };
  async function apiGet(path) {
    const response = await fetch(`${apiBase}${apiPath}${path}`, { headers: apiHeaders, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, `GET ${path} returned ${response.status}`);
    return response.json();
  }
  async function apiPost(path, body, status) {
    const response = await fetch(`${apiBase}${apiPath}${path}`, { method: 'POST', headers: apiHeaders,
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, status, `POST ${path} returned ${response.status}`);
    return response.json();
  }
  const taskBeforeSecondArtifact = await apiGet(`/tasks/${taskId}`);
  const secondContent = '# 第二份成果\n\n由当前测试会话创建，用于验证跨 Artifact 的确切版本接受。';
  const secondArtifactCommand = { command_id: randomUUID(), expected_task_revision: taskBeforeSecondArtifact.revision,
    title: '第二份成果', media_type: 'text/markdown', content: secondContent };
  const secondArtifactEnvelope = await apiPost(`/tasks/${taskId}/artifacts`, secondArtifactCommand, 201);
  assert.equal(secondArtifactEnvelope.command_id, secondArtifactCommand.command_id);
  const secondVersion = secondArtifactEnvelope.result;
  assert.equal(secondVersion.task_id, taskId);
  assert.notEqual(secondVersion.artifact_id, firstVersion.artifact_id);
  assert.equal(secondVersion.version_number, '1');
  assert.equal(secondVersion.sha256, createHash('sha256').update(secondContent).digest('hex'));
  const secondArtifactReceipt = await apiGet(`/commands/${secondArtifactCommand.command_id}`);
  assert.equal(secondArtifactReceipt.command_type, 'CreateArtifactWithVersion');
  assert.deepEqual(secondArtifactReceipt.result, secondVersion);

  await page.reload();
  await expect(page.getByTestId('relay-connection-open')).toContainText('已连接本机 API');
  const acceptedVersionIds = [firstVersion.version_id, secondVersion.version_id].sort();
  await page.getByTestId(`completion-artifact-${firstVersion.version_id}`).check();
  await page.getByTestId(`completion-artifact-${secondVersion.version_id}`).check();
  await page.getByTestId(`artifact-read-${firstVersion.version_id}`).click();
  await expect(page.getByTestId(`completion-artifact-${firstVersion.version_id}`)).toBeChecked();
  await expect(page.getByTestId(`completion-artifact-${secondVersion.version_id}`)).toBeChecked();
  await page.locator('[data-testid^="criterion-"]').first().check();
  const completePath = `/api/v1/workspaces/${workspaceId}/tasks/${taskId}/complete`;
  const completePending = page.waitForResponse((response) => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === completePath);
  await page.getByTestId('task-complete').click();
  const completeResponse = await completePending;
  assert.equal(completeResponse.status(), 200);
  const completeRequest = completeResponse.request().postDataJSON();
  const completeEnvelope = await completeResponse.json();
  assert.equal(completeEnvelope.command_id, completeRequest.command_id);
  assert.deepEqual([...completeRequest.artifact_version_ids].sort(), acceptedVersionIds);
  assert.deepEqual([...completeEnvelope.result.artifact_version_ids].sort(), acceptedVersionIds);
  const completionId = completeEnvelope.result.completion_id;
  assert.match(completionId, /^[0-9a-f-]{36}$/iu);
  const completionReceipt = await apiGet(`/commands/${completeRequest.command_id}`);
  assert.equal(completionReceipt.command_type, 'CompleteHumanTask');
  assert.deepEqual(completionReceipt.result, completeEnvelope.result);
  await expect(page.getByTestId('task-complete-receipt')).toContainText('已完成本轮');
  const completionEvidence = await apiGet(`/completion-records/${completionId}`);
  assert.equal(completionEvidence.is_current, true);
  assert.deepEqual(completionEvidence.artifact_versions.map((version) => version.artifact_version_id).sort(), acceptedVersionIds);
  assert.deepEqual(completionEvidence.artifact_versions.map((version) => version.sha256).sort(),
    [firstVersion.sha256, secondVersion.sha256].sort());

  await page.reload();
  await expect(page.getByTestId('relay-connection-open')).toContainText('已连接本机 API');
  await expect(page.getByTestId(`completion-artifact-${firstVersion.version_id}`)).toBeDisabled();
  await expect(page.getByTestId(`completion-artifact-${secondVersion.version_id}`)).toBeDisabled();
  await expect(page.getByTestId('task-complete')).toBeDisabled();
  await expect(page.getByTestId('artifact-save')).toBeDisabled();
  await expect(page.getByTestId('completion-artifact-summary')).toContainText('本轮实际接受');
  await page.getByTestId('artifact-versions').locator('summary').click();
  await expect(page.getByTestId(`artifact-version-${firstVersion.version_id}`).locator('xpath=ancestor::li'))
    .toContainText('本轮接受');
  await expect(page.getByTestId(`artifact-version-${secondVersion.version_id}`).locator('xpath=ancestor::li'))
    .toContainText('本轮接受');

  const reopenReason = '核对多成果接受后的历史保留';
  await page.locator('input[name="reopen-reason"]').fill(reopenReason);
  const reopenPath = `/api/v1/workspaces/${workspaceId}/tasks/${taskId}/reopen`;
  const reopenPending = page.waitForResponse((response) => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === reopenPath);
  await page.getByTestId('task-reopen-submit').click();
  const reopenResponse = await reopenPending;
  assert.equal(reopenResponse.status(), 200);
  const reopenRequest = reopenResponse.request().postDataJSON();
  const reopenEnvelope = await reopenResponse.json();
  assert.equal(reopenEnvelope.command_id, reopenRequest.command_id);
  assert.equal(reopenEnvelope.result.previous_completion_id, completionId);
  assert.equal(reopenEnvelope.result.status, 'READY');
  const reopenedEvidence = await apiGet(`/completion-records/${completionId}`);
  assert.equal(reopenedEvidence.is_current, false);
  assert.deepEqual(reopenedEvidence.artifact_versions.map((version) => version.artifact_version_id).sort(), acceptedVersionIds);
  await expect(page.getByTestId('task-reopen-receipt')).toContainText('已重开');
  await page.reload();
  await expect(page.getByTestId('relay-connection-open')).toContainText('已连接本机 API');
  await expect(page.getByTestId(`completion-artifact-${firstVersion.version_id}`)).not.toBeChecked();
  await expect(page.getByTestId(`completion-artifact-${secondVersion.version_id}`)).not.toBeChecked();
  const reopenedArtifacts = await apiGet(`/tasks/${taskId}/artifacts`);
  assert.deepEqual(reopenedArtifacts.current_accepted_version_ids, []);
  assert.deepEqual((await apiGet(`/completion-records/${completionId}`)).artifact_versions
    .map((version) => version.artifact_version_id).sort(), acceptedVersionIds);
  console.log(`release_sha256=${hash} project_id=${projectId} task_id=${taskId} ` +
    `artifacts=${firstVersion.artifact_id},${secondVersion.artifact_id} ` +
    `accepted=${acceptedVersionIds.join(',')} completion_id=${completionId} ` +
    'completion_read_only=true reopen_history_retained=true webview_pg_business_chain=pass synthetic_input=true');
} finally { await browser.close(); }
