import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import test, { after, before } from 'node:test';

import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createAssistantProfile } from '../../src/application/assistant-profile-commands.js';
import { createGatewayConnectionCommand, createGatewayPolicyCommand } from
  '../../src/application/gateway-commands.js';
import { registerManagedResource } from '../../src/application/gateway-configuration.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { SessionToolCallRepository } from '../../src/assist/session-tool-call-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort } from '../../src/workflow/fake-model-port.js';
import type { GatewayCapability } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from
  './integration-support.js';

/**
 * GitHub 只读片（迁移 0103 / F25 / ADR-023）在真实 PostgreSQL 上的出口。
 *
 * 单元测试证明「结构上越不了界」，这里证明三件单元测试给不出的事：
 *   * 迁移真的能应用，重述后的 `ck_logical_operation_resource` 既放行 GitHub 会话读取，
 *     也照样拒掉 RUN 来源与不绑资源的行（0054 漏分支必须由真实 PG 复核，不能靠肉眼）；
 *   * 词表按当前 ACTIVE 连接裁剪：有 GITHUB_READ 连接才出现四个工具，停用连接当轮就消失；
 *   * 一次真实派发落到 Gateway 账本上，失败以类型化原因回传模型，而不是假装查到空结果。
 *
 * 本机的 `gh` 状态不作为前提：仓库身份是本地 git 判定，因此「目录不是 GitHub 仓库」
 * 这条在所有主机上确定成立；装了 gh 的主机只会走到更后面的真实调用。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-github-read');
let dataRoot: string;
const roots: string[] = [];

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => {
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const GITHUB_ACTIONS = ['GITHUB_REPO_VIEW', 'GITHUB_PR_LIST', 'GITHUB_PR_VIEW', 'GITHUB_ISSUE_LIST'];
const GITHUB_TOOLS = ['github_repo_view', 'github_pr_list', 'github_pr_view', 'github_issue_list'];

interface GithubFixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly root: string;
  readonly resourceId: string;
  readonly connectionId: string;
  readonly connectionVersion: bigint;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly canonicalRoot: string;
}

/** 真实临时目录 + 受管资源 + 声明能力的连接 + AUTO 策略 + 人设会话。 */
async function fixture(options: {
  readonly capabilities?: readonly GatewayCapability[];
  /** 是否把受管根做成一个真的有 GitHub remote 的 git 仓库。 */
  readonly githubRemote?: boolean;
  readonly githubRepo?: string;
  readonly policyActions?: readonly string[];
} = {}): Promise<GithubFixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-github-it-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Relay\nGitHub 只读片\n', 'utf8');
  if (options.githubRemote === true) {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin',
      `https://github.com/${options.githubRepo ?? 'Sanwenyu-525/relay'}.git`],
      { cwd: root });
  }

  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `github-${workspaceId}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId,
      title: 'GitHub 只读片', projectType: 'DEVELOPMENT' });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
  });
  const { resourceId, canonicalRoot } = await registerManagedResource(app.db,
    { workspaceId, projectId, rootPath: root });

  const capabilities = options.capabilities ?? ['GITHUB_READ'];
  // 只有绑目录的能力（文件系统/Git/CLI）才能在连接上写 root_path；GITHUB_READ 与
  // COMPUTER_* 同形，连接配置为空，绑定关系落在受管资源与权限前缀上。
  const rootBound = ['FILE_READ', 'FILE_QUERY', 'FILE_WRITE', 'GIT_READ', 'GIT_WRITE', 'CLI_RUN']
    .some((capability) => capabilities.includes(capability as GatewayCapability));
  const created = await createGatewayConnectionCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), capabilities: [...capabilities],
    ...(rootBound ? { rootPath: canonicalRoot } : {}) });
  const connectionId = created.result.connection_id!;

  let policyId = '';
  let policyVersion = '';
  for (const actionType of options.policyActions ?? GITHUB_ACTIONS) {
    const policy = await createGatewayPolicyCommand(app.db, { workspaceId, projectId,
      commandId: randomUUID(), capability: 'GITHUB_READ', actionType, resourceId,
      decision: 'AUTO', maxPayloadBytes: 262144 });
    if (actionType === 'GITHUB_REPO_VIEW') {
      policyId = policy.result.policy_id!;
      const versions = await sql<{ version: string }>`
        select active_version::text as version from gateway_permission_policies
        where id = ${policyId}`.execute(app.db);
      policyVersion = versions.rows[0]!.version;
    }
  }
  if (capabilities.includes('FILE_READ')) {
    await createGatewayPolicyCommand(app.db, { workspaceId, projectId, commandId: randomUUID(),
      capability: 'FILE_READ', actionType: 'READ_FILE', resourceId, decision: 'AUTO',
      maxPayloadBytes: 262144 });
  }
  const connection = await sql<{ version: bigint }>`
    select version from gateway_connections where id = ${connectionId}`.execute(app.db);

  const 助手 = await createAssistantProfile(app.db, { workspaceId, commandId: randomUUID(),
    name: '审读', roleDescription: '只读复核 GitHub 状态', tone: '简短' });
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: 'GitHub 会话', projectId, conversationMode: 'ASSISTANT',
    assistantProfileId: 助手.result.assistant_profile_id as string });
  return { workspaceId, projectId, sessionId: session.result.session_id, root, resourceId,
    connectionId, connectionVersion: connection.rows[0]!.version, policyId, policyVersion,
    canonicalRoot };
}

/**
 * 发一条消息并跑一次生成 tick。
 *
 * `script` 按轮声明要请求的工具；`port` 用来驱动 Fake 不会主动制造的越界请求。
 * 记录声明给模型的工具名与回传给模型的内容——这两样是「模型实际看到什么」的唯一证据。
 */
async function ask(fx: GithubFixture, content: string,
  port?: AssistModelPort): Promise<{ readonly status: string; readonly errorCode: string | null;
  readonly declaredTools: readonly string[];
  readonly fedBack: readonly { name: string; content: string }[] }> {
  const storage = new ManagedContentStore(dataRoot);
  const modelPort = port ?? new FakeModelPort();
  const original = modelPort.assist.bind(modelPort);
  let declaredTools: readonly string[] = [];
  let fedBack: readonly { name: string; content: string }[] = [];
  modelPort.assist = async (request) => {
    declaredTools = (request.tools ?? []).map((spec) => spec.name);
    if ((request.toolTurns?.length ?? 0) > fedBack.length) {
      fedBack = request.toolTurns!.flatMap((turn) => turn.results
        .map((result) => ({ name: result.name, content: result.content })));
    }
    return original(request);
  };
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content });
  const outcome = await runAssistGenerationTick(app.db, { workerId: `github-${randomUUID()}`,
    storage, modelPort, leaseMs: 60_000, maxMessages: 1 });
  assert.ok(outcome !== undefined, '本次生成 tick 应当领取这条消息');
  const message = await createRepositories(app.db).assist.readMessage(
    sent.result.assistant_message_id);
  return { status: message?.status ?? 'MISSING', errorCode: message?.error_code ?? null,
    declaredTools, fedBack };
}

/** 按脚本发工具的便捷入口。 */
async function askWithScript(fx: GithubFixture, script: readonly (readonly { name: string;
  arguments: Record<string, unknown> }[])[]): ReturnType<typeof ask> {
  const scripted = new FakeModelPort();
  const original = scripted.assist.bind(scripted);
  scripted.assist = async (request) => {
    const turns = request.turns.length === 0 ? [{ role: 'user' as const,
      content: `FAKE_ASSIST_TOOLS ${JSON.stringify(script)}` }] : request.turns;
    return original({ ...request, turns });
  };
  return ask(fx, `FAKE_ASSIST_TOOLS ${JSON.stringify(script)}`, scripted);
}

/** 一个只请求指定工具与参数的端口：词表外的工具与越界参数都靠它送进来。 */
function singleToolPort(toolName: string, toolArguments: JsonObject): AssistModelPort {
  let round = 0;
  return {
    identity: new FakeModelPort().identity,
    assist: async () => {
      round += 1;
      if (round === 1) {
        return { kind: 'TOOL_CALLS', calls: [{ providerToolCallId: `stub-${round}`,
          name: toolName, arguments: toolArguments }], preamble: '', providerRequestId: 'stub-1',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
            cacheCreationTokens: null } };
      }
      return { kind: 'CONTENT', content: '（stub）已按只读结果回答。', providerRequestId: 'stub-2',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
          cacheCreationTokens: null } };
    },
  };
}

async function operationCount(projectId: string, actionType?: string): Promise<string> {
  const rows = actionType === undefined
    ? await sql<{ count: string }>`select count(*)::text as count from logical_operations
        where project_id = ${projectId}`.execute(app.db)
    : await sql<{ count: string }>`select count(*)::text as count from logical_operations
        where project_id = ${projectId} and action_type = ${actionType}`.execute(app.db);
  return rows.rows[0]!.count;
}

/* —— 迁移与行级约束 ————————————————————————————— */

test('0103 登记只读能力，重述后的资源 CHECK 逐条保留既有分支', async () => {
  const capabilities = await sql<{ adapter: string; effect: string }>`
    select adapter_kind as adapter, effect_kind as effect from gateway_capabilities
    where capability_key = 'GITHUB_READ'`
    .execute(app.db);
  assert.equal(capabilities.rows.length, 1, 'GitHub 只读能力必须唯一登记');
  assert.equal(capabilities.rows[0]!.effect, 'READ', '本片只登记读取效果');
  assert.equal(capabilities.rows[0]!.adapter, 'REAL', '真实适配器，不是 FAKE 夹具能力');

  const check = await sql<{ definition: string }>`
    select pg_get_constraintdef(oid) as definition from pg_constraint
    where conname = 'ck_logical_operation_resource'
      and conrelid = 'public.logical_operations'::regclass`
    .execute(app.db);
  const definition = check.rows[0]!.definition;
  for (const kept of ['FAKE_WRITE', 'FAKE_PUBLIC_READ', 'WEB_FETCH', 'FILE_READ', 'FILE_QUERY',
    'FILE_WRITE', 'GIT_READ', 'GIT_WRITE', 'CLI_RUN', 'USER_ACTION', 'ASSISTANT_READ',
    'AGENT_SESSION_READ', 'COMPUTER_READ', 'COMPUTER_INPUT', 'GITHUB_READ']) {
    assert.ok(definition.includes(`'${kept}'`), `ck_logical_operation_resource 丢掉了 ${kept}`);
  }
});

test('GitHub 动作只能绑定受管资源、只能来自会话读取：越界的行被 CHECK 拒掉', async () => {
  const fx = await fixture();
  // 行级 CHECK 是数据库层的最后一道，探针必须用 DDL 角色直写；应用角色没有
  // logical_operations 的写权限，正常业务只经由应用入口落账。
  const ddl = openDatabase(MIGRATION_DATABASE_URL, 'relay-api-test-github-read-ddl');
  try {
    async function insertOperation(input: { readonly id: string; readonly origin: string;
      readonly resourceId: string | null }): Promise<void> {
      await sql`
        insert into logical_operations (id, workspace_id, project_id, origin, task_id, run_id,
          step_id, import_job_id, intent_key, connection_id, connection_version, connection_config,
          policy_id, policy_version, capability_key, action_type, normalized_target, params_hash,
          params, resource_id, status)
        values (${input.id}, ${fx.workspaceId}, ${fx.projectId}, ${input.origin}, null, null, null,
          null, ${`intent-${input.id}`}, ${fx.connectionId}, ${fx.connectionVersion}, '{}'::jsonb,
          ${fx.policyId}, ${fx.policyVersion}, 'GITHUB_READ', 'GITHUB_REPO_VIEW',
          ${fx.canonicalRoot}, ${Buffer.alloc(32)}, '{}'::jsonb, ${input.resourceId}, 'PREPARED')`
        .execute(ddl.db);
    }

    const positiveId = randomUUID();
    await insertOperation({ id: positiveId, origin: 'ASSISTANT_READ', resourceId: fx.resourceId });
    const stored = await sql<{ capability: string; resource: string | null }>`
      select capability_key as capability, resource_id::text as resource from logical_operations
      where id = ${positiveId}`.execute(ddl.db);
    assert.equal(stored.rows[0]!.capability, 'GITHUB_READ');
    assert.equal(stored.rows[0]!.resource, fx.resourceId, 'GitHub 动作必须钉在受管资源上');

    // 三条反例：本片不放行 RUN，也不给 USER_ACTION；资源身份不能缺。
    for (const [origin, resourceId] of [['RUN', fx.resourceId], ['USER_ACTION', fx.resourceId],
      ['ASSISTANT_READ', null]] as const) {
      await assert.rejects(() => insertOperation({ id: randomUUID(), origin, resourceId }),
        `CHECK 必须拒掉 origin=${origin} resource=${String(resourceId)}`);
    }
    await sql`delete from logical_operations where id = ${positiveId}`.execute(ddl.db);
  } finally {
    await ddl.close();
  }
});

/* —— 按需激活 —— ———————————————————————————————— */

test('有 GITHUB_READ 连接时四个工具才进词表，停用连接当轮立刻消失', async () => {
  const fx = await fixture();
  // 连接本身不绑目录：GitHub 查询的边界来自受管资源 + 权限前缀，不是连接配置。
  const connectionConfig = await sql<{ config: JsonObject }>`
    select config from gateway_connections where id = ${fx.connectionId}`.execute(app.db);
  assert.deepEqual(connectionConfig.rows[0]!.config, {},
    'GITHUB_READ 连接不携带目录边界');

  const first = await askWithScript(fx, [[{ name: 'github_repo_view', arguments: {} }]]);
  assert.equal(first.status, 'COMPLETED', JSON.stringify(first));
  assert.deepEqual(first.declaredTools.slice().sort(), [...GITHUB_TOOLS].sort(),
    '声明给模型的工具应当恰好是四个 GitHub 只读工具');

  // 停用连接：连接上的能力就是词表的上界，旧会话不靠任何冻结快照续命。
  await createRepositories(app.db).gateway.setConnection({ id: fx.connectionId, status: 'DISABLED',
    config: {} });
  const second = await askWithScript(fx, [[{ name: 'github_repo_view', arguments: {} }]]);
  assert.equal(second.declaredTools.length, 0,
    `连接停用后不得再声明 GitHub 工具：${JSON.stringify(second.declaredTools)}`);
  const rows = await new SessionToolCallRepository(app.db).listBySession(fx.sessionId);
  assert.equal(rows.length, 1, '能力收回后不得再产生新的读取事实');
});

test('受管目录不是 GitHub 仓库时以类型化原因失败，不假装查到空结果', async () => {
  const fx = await fixture();
  const outcome = await askWithScript(fx, [[{ name: 'github_repo_view', arguments: {} }]]);
  assert.equal(outcome.status, 'COMPLETED', JSON.stringify(outcome));

  const rows = await new SessionToolCallRepository(app.db).listBySession(fx.sessionId);
  assert.equal(rows.length, 1, JSON.stringify(rows.map((row) => [row.tool_name, row.status])));
  // 只读轮次对「派发过但没有成功结果」记 UNKNOWN：内容照实回传，状态不写成成功。
  assert.equal(rows[0]!.status, 'UNKNOWN');
  assert.equal(rows[0]!.rejection_reason, null, '这不是被拒的请求，而是一次真实发生并结算的读取');
  assert.ok(rows[0]!.operation_id !== null);

  const operations = await sql<{ origin: string; capability: string; target: string;
    resource: string | null; action: string }>`
    select origin, capability_key as capability, normalized_target as target,
      resource_id::text as resource, action_type as action from logical_operations
    where id = ${rows[0]!.operation_id}`.execute(app.db);
  assert.equal(operations.rows[0]!.capability, 'GITHUB_READ');
  assert.equal(operations.rows[0]!.origin, 'ASSISTANT_READ');
  assert.equal(operations.rows[0]!.action, 'GITHUB_REPO_VIEW');
  assert.equal(operations.rows[0]!.resource, fx.resourceId);
  assert.equal(operations.rows[0]!.target, fx.canonicalRoot,
    'GitHub 查询的目标就是这个受管根，不接受别的指名');

  const fedBack = outcome.fedBack.find((item) => item.name === 'github_repo_view');
  assert.ok(fedBack !== undefined, '失败原因必须回传给模型，而不是静默消失');
  assert.match(fedBack.content, /GH_REPO_UNIDENTIFIED/u);
  assert.match(fedBack.content, /不会去查任何一个仓库/u);
  assert.equal(await operationCount(fx.projectId, 'GITHUB_PR_LIST'), '0');

  // 只读轮次不建立执行链。
  assert.equal((await sql<{ count: string }>`select count(*)::text as count from tasks
    where project_id = ${fx.projectId}`.execute(app.db)).rows[0]!.count, '0');
});

test('受管根真的有 GitHub remote 时身份闸门放行，派发走到真实 gh 调用', async () => {
  const fx = await fixture({ githubRemote: true });
  const outcome = await askWithScript(fx, [[{ name: 'github_pr_list',
    arguments: { state: 'open', limit: 3 } }]]);
  assert.equal(outcome.status, 'COMPLETED', JSON.stringify(outcome));
  const fedBack = outcome.fedBack.find((item) => item.name === 'github_pr_list');
  assert.ok(fedBack !== undefined, JSON.stringify(outcome));
  assert.doesNotMatch(fedBack.content, /GH_REPO_UNIDENTIFIED/u,
    '身份已核对成功，不得再报「目录没有 GitHub remote」');
  // 装了 gh 就真发一次调用（结果带不可信标记），没装则必须是类型化的缺失提示；
  // 两种都不允许伪装成一次成功的空查询。
  assert.ok(/untrusted_external_content/u.test(fedBack.content) ||
    /GH_CLI_UNAVAILABLE|GH_UNAUTHENTICATED|GH_NETWORK_ERROR|GH_FORBIDDEN|GH_NOT_FOUND|GH_TIMEOUT|GH_ERROR/u
      .test(fedBack.content),
  `派发结果要么带不可信标记，要么是类型化失败：${fedBack.content.slice(0, 200)}`);
});

test('已认证真实 GitHub：四个只读工具经会话与 Gateway 成功并保存回执', {
  skip: process.env.RELAY_TEST_AUTH_GITHUB !== '1',
}, async () => {
  execFileSync(process.env.RELAY_GH_PATH ?? 'gh', ['auth', 'status'], { stdio: 'pipe' });
  // 只给测试临时目录登记公开官方仓库；不修改工作区 remote，不在 GitHub 创建测试对象。
  const fx = await fixture({ githubRemote: true, githubRepo: 'cli/cli' });
  const query = async (name: string, args: JsonObject): Promise<Record<string, unknown>> => {
    const outcome = await askWithScript(fx, [[{ name, arguments: args }]]);
    assert.equal(outcome.status, 'COMPLETED');
    const feedback = outcome.fedBack.find((item) => item.name === name);
    assert.ok(feedback, `missing feedback for ${name}`);
    const result = JSON.parse(feedback.content) as Record<string, unknown>;
    assert.equal(result.untrusted_external_content, true, `${name} must return a real result`);
    return result;
  };
  await query('github_repo_view', {});
  const list = await query('github_pr_list', { state: 'all', limit: 1 });
  const first = (list.items as { number: number }[])[0];
  assert.ok(first && Number.isInteger(first.number), 'public fixture must provide a real PR');
  await query('github_pr_view', { number: first.number });
  await query('github_issue_list', { state: 'all', limit: 1 });
  const rows = await new SessionToolCallRepository(app.db).listBySession(fx.sessionId);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.status === 'SETTLED'), 'all four receipts must settle');
  const operations = await sql<{ count: string }>`select count(*)::text as count
    from logical_operations where project_id = ${fx.projectId} and status = 'SUCCEEDED'`
    .execute(app.db);
  assert.equal(operations.rows[0]!.count, '4', 'all four Gateway operations must succeed');
});

test('模型带进来的仓库名到不了适配器，词表外的 gh api 入口直接拒掉', async () => {
  const fx = await fixture();
  // 参数在 Gateway 之前按动作白名单收窄：`repo` 不进网关参数，更不进 gh 的 argv。
  const crossed = await ask(fx, '列一下别人的仓库',
    singleToolPort('github_pr_list', { repo: 'someone/else', state: 'open' }));
  assert.equal(crossed.status, 'COMPLETED', JSON.stringify(crossed));
  const rows = await new SessionToolCallRepository(app.db).listBySession(fx.sessionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'UNKNOWN', '目录不是 GitHub 仓库，查询以类型化失败结束');
  const operation = await sql<{ params: JsonObject }>`
    select params from logical_operations where id = ${rows[0]!.operation_id!}`.execute(app.db);
  assert.deepEqual(operation.rows[0]!.params, { state: 'open', limit: 10 },
    '被冻结的参数里不能出现模型给的仓库名');

  const outside = await ask(fx, '直接打 api', singleToolPort('gh_api', { endpoint: '/repos/x/y' }));
  assert.equal(outside.status, 'COMPLETED', JSON.stringify(outside));
  const outsideRows = await new SessionToolCallRepository(app.db).listBySession(fx.sessionId);
  assert.equal(outsideRows.length, 2);
  assert.equal(outsideRows[1]!.status, 'REJECTED');
  assert.equal(outsideRows[1]!.rejection_reason, 'TOOL_NOT_READ_ONLY',
    'gh api 不是词表内的工具，连一次 Operation 都不该产生');
  assert.equal(outsideRows[1]!.operation_id, null);
  assert.equal(await operationCount(fx.projectId, 'GITHUB_PR_LIST'), '1',
    '唯一的 PR 列表动作是上一步收窄过参数的那一次');
});

test('权限词表按动作分别放行：只授权 repo_view 时列 PR 仍被 Gateway 拒绝', async () => {
  const fx = await fixture({ policyActions: ['GITHUB_REPO_VIEW'] });
  const outcome = await askWithScript(fx, [[{ name: 'github_pr_list', arguments: { state: 'open' } }]]);
  assert.equal(outcome.status, 'COMPLETED', JSON.stringify(outcome));
  const rows = await new SessionToolCallRepository(app.db).listBySession(fx.sessionId);
  const listRow = rows.find((row) => row.tool_name === 'github_pr_list');
  assert.ok(listRow !== undefined, JSON.stringify(rows.map((row) => row.tool_name)));
  assert.equal(listRow.status, 'REJECTED',
    '缺该动作的 Permission 不能因为别的动作被授权而放行');
  assert.equal(await operationCount(fx.projectId, 'GITHUB_PR_LIST'), '0');
});

test('GitHub 只读与文件读取共存时互不越界：文件读取仍只在自己的受管根内', async () => {
  const fx = await fixture({ capabilities: ['FILE_READ', 'GITHUB_READ'] });
  const outcome = await askWithScript(fx, [
    [{ name: 'read_file', arguments: { relative_path: 'README.md' } }],
    [{ name: 'github_repo_view', arguments: {} }],
  ]);
  assert.equal(outcome.status, 'COMPLETED', JSON.stringify(outcome));
  assert.match(outcome.fedBack.find((item) => item.name === 'read_file')?.content ?? '',
    /GitHub 只读片/u, '文件读取必须拿到磁盘上的真实正文');
  assert.match(outcome.fedBack.find((item) => item.name === 'github_repo_view')?.content ?? '',
    /GH_REPO_UNIDENTIFIED/u, '这个受管根不是 git 仓库，GitHub 侧应失败关闭');
});
