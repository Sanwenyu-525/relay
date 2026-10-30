import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { createAssistSession, setSessionContextBudget } from '../../src/application/assist-commands.js';
import { createGatewayConnectionCommand, createManagedResourceCommand } from
  '../../src/application/gateway-commands.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createDataRoot, startTestApi, workspacePath, type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase }
  from './integration-support.js';

/**
 * 必读文件体积审计的 HTTP 面（2026-10-30）。
 *
 * 单测已经覆盖判定与扫描的纯逻辑；这里只锁 HTTP 面才暴露的问题：
 *   · DTO 投影是否真的把字段发出去（TypeBox response schema 会丢掉未声明字段，
 *     camelCase 直接返回会得到空体）；
 *   · 权限边界：没有覆盖该根的 ACTIVE FILE_READ 连接时**不扫也不读**；
 *   · 跨工作区不可见；
 *   · 文件被改后重新读取拿到新体积（不靠缓存骗读数）；
 *   · 非必读的大型资料不进清单。
 *
 * 真实 PostgreSQL + 真实临时目录 + 真实 API 进程；不连 Provider、不调模型。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-required-context');
let dataRoot: string;
let api: TestApi;

/** 262144 单次预算 + 8192 输出预留：分母固定，便于断言有效输入预算的确切差值。 */
const env = {
  RELAY_MODEL_PROVIDER: 'openai-compatible',
  RELAY_MODEL_API_KEY: 'required-context-test-key',
  RELAY_MODEL_NAME: 'test-model-without-catalog-entry',
  RELAY_MODEL_MAX_CALL_TOKENS: '262144',
  RELAY_MODEL_MAX_OUTPUT_TOKENS: '8192',
  RELAY_MODEL_MAX_SCOPE_TOKENS: '524288',
} as const;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
  api = await startTestApi({ env });
});
after(async () => {
  if (api !== undefined) await api.stop();
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
});

interface Fixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly root: string;
  readonly resourceId: string;
}

/**
 * 一个真实 Project + 受管资源（+ 可选 FILE_READ 连接）。
 *
 * 连接一律用**服务端读回的 `canonical_root`**：Windows 临时目录带 8.3 短名/大小写别名，
 * 用 `mkdtemp` 的原始路径建连接会判不出同一根，审计会静默落到「没有读取权限」——
 * 表现为「功能没生效」，而不是错误。
 */
async function fixture(input: { readonly withFileRead: boolean;
  readonly files?: Record<string, string> }): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `required-context-${workspaceId}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId,
      title: '必读文件审计', projectType: 'DEVELOPMENT' });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
  });
  const root = join(dataRoot, `required-${randomUUID()}`);
  await mkdir(join(root, 'docs'), { recursive: true });
  for (const [path, content] of Object.entries(input.files ?? {})) {
    const absolute = join(root, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
  const resource = await createManagedResourceCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), rootPath: root });
  const resourceId = resource.result.resource_id!;
  const stored = await createRepositories(app.db).gateway.readResource(resourceId);
  assert.ok(stored !== undefined);
  if (input.withFileRead) {
    await createGatewayConnectionCommand(app.db, { workspaceId, projectId, commandId: randomUUID(),
      capabilities: ['FILE_READ', 'FILE_QUERY'], rootPath: stored.canonical_root });
  }
  return { workspaceId, projectId, root, resourceId };
}

function auditPath(item: Fixture, query = ''): string {
  return workspacePath(item.workspaceId,
    `/working-directories/${item.resourceId}/required-context-audit${query}`);
}

interface AuditBody {
  readonly state: string; readonly severity: string; readonly detail: string;
  readonly fingerprint: string;
  readonly files: readonly { readonly path: string; readonly bytes: number;
    readonly estimated_tokens: number; readonly share: number | null;
    readonly category: string; readonly scope: string }[];
  readonly budget: { readonly provider_window_tokens: number | null;
    readonly provider_window_known: boolean; readonly call_budget_tokens: number;
    readonly call_budget_source: string;
    readonly effective_input_tokens: number | null; readonly confidence: string;
    readonly required_total_tokens: number; readonly reserves: { readonly output_tokens: number;
      readonly system_prompt_tokens: number; readonly tool_definition_tokens: number } };
  readonly reasons: readonly { readonly code: string }[];
  readonly access: { readonly project_id: string; readonly connection_id: string } | null;
  readonly thresholds: { readonly single_file: { readonly severe: number } };
}

async function readAudit(item: Fixture, query = ''): Promise<AuditBody> {
  const response = await api.get(auditPath(item, query));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body as AuditBody;
}

test('DTO 投影完整：大必读文件判为严重，非必读大文档不进清单', async () => {
  const item = await fixture({ withFileRead: true, files: {
    // 540 KB ≈ 180K tokens：在 262144 预算、减预留后的有效输入预算上远超 50%。
    'AGENTS.md': 'a'.repeat(540 * 1024),
    'docs/rules.md': 'b'.repeat(12 * 1024),
    'notes.md': 'c'.repeat(400 * 1024),
  } });
  const audit = await readAudit(item, '?agent=relay&refresh=1');
  assert.equal(audit.state, 'OK');
  assert.equal(audit.severity, 'SEVERE');
  // 只认规则入口：notes.md 是资料，不是必读。
  assert.deepEqual(audit.files.map((file) => file.path), ['AGENTS.md']);
  const agents = audit.files[0]!;
  assert.equal(agents.category, 'TASK_REQUIRED');
  assert.equal(agents.scope, 'ROOT');
  assert.equal(agents.bytes, 540 * 1024);
  assert.equal(agents.estimated_tokens, Math.ceil(540 * 1024 / 3));
  assert.ok(agents.share !== null && agents.share > 0.7);
  // 有效输入预算 = 262144 − 输出 8192 − 系统提示 − 工具 4096。
  const reserves = audit.budget.reserves;
  assert.equal(audit.budget.call_budget_tokens, 262_144);
  assert.equal(reserves.output_tokens, 8_192);
  assert.equal(reserves.tool_definition_tokens, 4_096);
  assert.equal(audit.budget.effective_input_tokens,
    262_144 - 8_192 - reserves.system_prompt_tokens - 4_096);
  assert.ok(audit.reasons.some((reason) => reason.code === 'SINGLE_FILE_SEVERE'));
  // 阈值随响应下发：界面不复制一份判定。
  assert.equal(audit.thresholds.single_file.severe, 0.5);
  // 「查看文件」用的读取入口来自本次审计。
  assert.ok(audit.access !== null);
  assert.equal(audit.access!.project_id, item.projectId);
});

test('模型窗口未知时只按调用预算估算，不冒充精确读数', async () => {
  const item = await fixture({ withFileRead: true, files: {
    'AGENTS.md': 'a'.repeat(30 * 1024),
  } });
  const audit = await readAudit(item, '?agent=relay&refresh=1');
  assert.equal(audit.budget.provider_window_tokens, null);
  assert.equal(audit.budget.provider_window_known, false);
  assert.equal(audit.budget.confidence, 'WINDOW_UNKNOWN');
  assert.ok(audit.reasons.some((reason) => reason.code === 'WINDOW_UNKNOWN'));
  // 没有占满预算，所以不是「严重」；只有窗口未知这一条说明性原因。
  assert.equal(audit.severity, 'NONE');
});

test('没有覆盖该根的 FILE_READ 连接：不扫也不读，如实说没权限', async () => {
  const item = await fixture({ withFileRead: false, files: {
    'AGENTS.md': 'a'.repeat(400 * 1024),
  } });
  const audit = await readAudit(item, '?agent=relay&refresh=1');
  assert.equal(audit.state, 'NO_FILE_ACCESS');
  assert.deepEqual(audit.files, []);
  assert.equal(audit.severity, 'NONE');
  assert.equal(audit.access, null);
});

test('跨工作区的目录按不可见处理，不泄漏文件清单', async () => {
  const item = await fixture({ withFileRead: true, files: { 'AGENTS.md': 'a'.repeat(1024) } });
  const other = await fixture({ withFileRead: true });
  const response = await api.get(workspacePath(other.workspaceId,
    `/working-directories/${item.resourceId}/required-context-audit`));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const audit = response.body as AuditBody;
  assert.equal(audit.state, 'SCAN_UNAVAILABLE');
  assert.deepEqual(audit.files, []);
});

test('文件被改写后重新审计拿到新体积与新指纹', async () => {
  const item = await fixture({ withFileRead: true, files: { 'AGENTS.md': 'a'.repeat(300) } });
  const before = await readAudit(item, '?agent=relay&refresh=1');
  assert.equal(before.files[0]?.bytes, 300);
  await writeFile(join(item.root, 'AGENTS.md'), 'a'.repeat(9_000), 'utf8');
  const after = await readAudit(item, '?agent=relay&refresh=1');
  assert.equal(after.files[0]?.bytes, 9_000);
  assert.notEqual(after.fingerprint, before.fingerprint);
  // 删掉之后不再出现在清单里。
  await rm(join(item.root, 'AGENTS.md'));
  const removed = await readAudit(item, '?agent=relay&refresh=1');
  assert.deepEqual(removed.files, []);
});

test('项目显式声明的必读文档计入；声明里的越界路径被拒', async () => {
  const item = await fixture({ withFileRead: true, files: {
    'guide.md': 'g'.repeat(64 * 1024),
    '.relay/context-required.json': JSON.stringify({ required_documents: [
      { path: 'guide.md', category: 'TASK_REQUIRED', reason: '每次开工都读' },
      { path: '../outside.md', category: 'AUTO_INJECTED' },
    ] }),
  } });
  const audit = await readAudit(item, '?agent=relay&refresh=1');
  assert.deepEqual(audit.files.map((file) => file.path), ['guide.md']);
  assert.equal(audit.files[0]!.scope, 'DECLARED');
});

test('0145：有会话时按会话档位算分母，不按工作区默认', async () => {
  const item = await fixture({ withFileRead: true, files: { 'AGENTS.md': 'a'.repeat(30 * 1024) } });
  const session = await createAssistSession(app.db, { workspaceId: item.workspaceId,
    projectId: item.projectId, title: '必读文件审计', commandId: randomUUID() });
  const sessionId = session.result.session_id;
  await setSessionContextBudget(app.db, { workspaceId: item.workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '0', budgetTokens: 524_288 });
  const audit = await readAudit(item, `?agent=relay&session_id=${sessionId}&refresh=1`);
  assert.equal(audit.budget.call_budget_tokens, 524_288);
  assert.equal(audit.budget.call_budget_source, 'SESSION');
  // 没有会话时回落到应用默认（本测试进程设了 262144）。
  const fallback = await readAudit(item, '?agent=relay&refresh=1');
  assert.equal(fallback.budget.call_budget_tokens, 262_144);
  assert.equal(fallback.budget.call_budget_source, 'APPLICATION_DEFAULT');
});

test('不同 Agent 的规则入口不同：同一目录换 Agent 得到不同清单', async () => {
  const item = await fixture({ withFileRead: true, files: {
    'AGENTS.md': 'a'.repeat(1_024),
    'CLAUDE.md': 'c'.repeat(2_048),
  } });
  const relay = await readAudit(item, '?agent=relay&refresh=1');
  const claude = await readAudit(item, '?agent=claude&refresh=1');
  assert.deepEqual(relay.files.map((file) => file.path), ['AGENTS.md']);
  assert.deepEqual(claude.files.map((file) => file.path), ['CLAUDE.md']);
  assert.equal(claude.files[0]!.category, 'AUTO_INJECTED');
});
