import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateToolRows, type ProjectToolAvailability, type ProjectToolKey,
  type ToolAvailabilityFacts,
} from '../../src/application/tool-availability.js';
import type { ActivePolicy } from '../../src/gateway/gateway-repository.js';
import type { GatewayCapability, GatewayConnectionRow } from '../../src/infrastructure/database-schema.js';
import type { PluginRuntimeStatus } from '../../src/plugins/runtime-status.js';

/**
 * 工具有效性投影（PLUGIN-P0-01）。
 *
 * 这些用例都在核对同一件事：**界面结论必须等于 Gateway 的准入结论**。因此每个用例
 * 都构造成「此前会被界面误判成可用」的具体配置，而不是随手造数据。
 */

const ROOT = 'D:\\Workspace\\relay';
const CREATED = new Date('2026-11-01T00:00:00.000Z');

function connection(capabilities: readonly GatewayCapability[],
  overrides: { readonly status?: 'ACTIVE' | 'DISABLED'; readonly root?: string | null;
    readonly host?: string } = {}): ToolAvailabilityFacts['connections'][number] {
  const root = overrides.root === undefined ? ROOT : overrides.root;
  const row: GatewayConnectionRow = {
    id: `conn-${capabilities.join('-')}`, workspace_id: 'w1', project_id: 'p1',
    adapter_kind: 'REAL', status: overrides.status ?? 'ACTIVE', version: 1n,
    config: { ...(root === null ? {} : { root_path: root }),
      ...(overrides.host === undefined ? {} : { allowed_host: overrides.host }) },
    created_at: CREATED, updated_at: CREATED,
  };
  return { row, capabilities: new Set(capabilities) };
}

function policy(capability: GatewayCapability, actionType: string, decision: 'AUTO' | 'ASK' | 'DENY',
  targetPrefix = ROOT, maxPayloadBytes = 262144): ActivePolicy {
  return { id: `policy-${capability}-${actionType}-${decision}`, workspace_id: 'w1', project_id: 'p1',
    status: 'ACTIVE', active_version: 1n, revision: 1n, created_at: CREATED, updated_at: CREATED,
    policy_id: `policy-${capability}-${actionType}-${decision}`, version: 1n,
    capability_key: capability, action_type: actionType, target_prefix: targetPrefix,
    decision, max_payload_bytes: maxPayloadBytes, version_created_at: CREATED } as ActivePolicy;
}

function facts(input: { readonly connections: readonly ToolAvailabilityFacts['connections'][number][];
  readonly policies?: readonly ActivePolicy[];
  readonly resources?: readonly { readonly canonical_root: string }[];
  readonly policyIncomplete?: boolean }): ToolAvailabilityFacts {
  return { connections: input.connections, policies: input.policies ?? [],
    resources: input.resources ?? [{ canonical_root: ROOT }],
    policyIncomplete: input.policyIncomplete ?? false };
}

function readyRuntime(): readonly PluginRuntimeStatus[] {
  return [
    { plugin: 'computer', state: 'READY', detail: '电脑运行时已就位。', remediation: null },
    { plugin: 'browser', state: 'READY', detail: '浏览器桥接扩展已配对。', remediation: null },
    { plugin: 'github', state: 'READY', detail: 'GitHub CLI 已安装并已登录。', remediation: null },
  ];
}

function rowOf(rows: readonly ProjectToolAvailability[], tool: ProjectToolKey): ProjectToolAvailability {
  const row = rows.find((entry) => entry.tool === tool);
  assert.ok(row !== undefined, `缺少工具行 ${tool}`);
  return row;
}

test('七行工具各覆盖一批动作，动作总数固定，不会因为漏配能力而静默少判', () => {
  const rows = evaluateToolRows(facts({ connections: [] }), readyRuntime());
  assert.deepEqual(rows.map((row) => row.tool),
    ['files', 'git', 'web', 'cli', 'computer', 'browser', 'github']);
  // 每个动作只属于一个能力，能力只属于一行：总数即词表规模。
  assert.deepEqual(rows.map((row) => row.counts.total), [7, 3, 1, 3, 11, 12, 5]);
});

test('只授权 read_file 时文件行只能是「只读可用」，不能代表整行（含写入）可用', () => {
  // 这是 PLUGIN-P0-01 的反例：旧实现在 FILE_READ 上看到一条非拒绝策略就把整行写成
  // 「可用」，而行文案同时承诺「按档位写入当前目录」。
  const rows = evaluateToolRows(facts({
    connections: [connection(['FILE_READ', 'FILE_QUERY', 'FILE_WRITE'])],
    policies: [policy('FILE_READ', 'READ_FILE', 'AUTO')],
  }), readyRuntime());
  const files = rowOf(rows, 'files');
  assert.equal(files.state, 'READ_ONLY');
  assert.match(files.detail, /只有读取类动作已授权/);
  assert.equal(files.counts.auto, 1);
  assert.equal(files.counts.not_authorized, 6);
});

test('电脑插件只授权截图时，整行不能被读作可执行鼠标键盘', () => {
  const rows = evaluateToolRows(facts({
    connections: [connection(['COMPUTER_READ', 'COMPUTER_INPUT'])],
    policies: [policy('COMPUTER_READ', 'COMPUTER_SCREENSHOT', 'AUTO', 'computer://desktop'),
      policy('COMPUTER_READ', 'COMPUTER_GET_WINDOWS', 'AUTO', 'computer://desktop')],
  }), readyRuntime());
  const computer = rowOf(rows, 'computer');
  assert.equal(computer.state, 'READ_ONLY');
  assert.equal(computer.counts.auto, 2);
  assert.equal(computer.counts.not_authorized, 9);
});

test('授权齐全也不等于自动可执行：适配器不允许 AUTO 直通的动作仍标为需要审批', () => {
  // FILE_WRITE 的 approvalPassthrough=false：策略写成 AUTO 也只表示「不必逐次确认范围」，
  // 派发前仍要单动作批准或本次任务范围授权。界面若显示「可用」而模型以为能直接写，
  // 就是 P0-01 说的「错误描述为自动可执行」。
  const capabilities: readonly GatewayCapability[] = ['FILE_READ', 'FILE_QUERY', 'FILE_WRITE'];
  const actions: readonly [GatewayCapability, string][] = [
    ['FILE_READ', 'READ_FILE'], ['FILE_QUERY', 'LIST_DIRECTORY'], ['FILE_QUERY', 'FIND_PATHS'],
    ['FILE_QUERY', 'SEARCH_TEXT'], ['FILE_WRITE', 'APPLY_CHANGESET'],
    ['FILE_WRITE', 'READ_CHANGE_SET'], ['FILE_WRITE', 'WRITE_FILE'],
  ];
  const rows = evaluateToolRows(facts({
    connections: [connection(capabilities)],
    policies: actions.map(([capability, action]) => policy(capability, action, 'AUTO')),
  }), readyRuntime());
  const files = rowOf(rows, 'files');
  assert.equal(files.state, 'NEEDS_APPROVAL');
  assert.equal(files.counts.auto, 4, '四个读取类动作可自动准入');
  assert.equal(files.counts.needs_approval, 3, '三个写入类动作仍需审批');
  assert.equal(files.counts.not_authorized, 0);
});

test('连接停用或撤销后状态随之变化，不会继续显示可用', () => {
  const disabled = evaluateToolRows(facts({
    connections: [connection(['FILE_READ'], { status: 'DISABLED' })],
    policies: [policy('FILE_READ', 'READ_FILE', 'AUTO')],
  }), readyRuntime());
  assert.equal(rowOf(disabled, 'files').state, 'DISABLED');

  // 撤销后的连接不再出现在列表里（服务端只保留 ACTIVE/DISABLED），策略单独撤销时
  // 会落到「没有匹配策略」而不是继续可用。
  const revokedPolicy = evaluateToolRows(facts({
    connections: [connection(['FILE_READ'])],
    policies: [],
  }), readyRuntime());
  assert.equal(rowOf(revokedPolicy, 'files').state, 'NOT_AUTHORIZED');
});

test('明确 DENY 的策略不会被「存在其它非拒绝策略」掩盖', () => {
  const rows = evaluateToolRows(facts({
    connections: [connection(['GIT_READ'])],
    policies: [policy('GIT_READ', 'GIT_STATUS', 'DENY'), policy('GIT_READ', 'GIT_DIFF', 'DENY'),
      policy('GIT_READ', 'GIT_LOG', 'DENY')],
  }), readyRuntime());
  const git = rowOf(rows, 'git');
  assert.equal(git.state, 'DENIED');
  assert.equal(git.counts.denied, 3);
  assert.equal(git.counts.auto, 0);
});

test('策略目标前缀不覆盖当前受管目录时不算授权', () => {
  // 旧实现只看「有没有一条非拒绝策略」，完全不看 target_prefix 是否落在本项目的目录上。
  const rows = evaluateToolRows(facts({
    connections: [connection(['FILE_READ'])],
    policies: [policy('FILE_READ', 'READ_FILE', 'AUTO', 'D:\\Other\\project')],
  }), readyRuntime());
  assert.equal(rowOf(rows, 'files').state, 'NOT_AUTHORIZED');

  // 同一份策略在目录匹配时才算数：证明判定确实读了目标而不是只读了决定。
  const matched = evaluateToolRows(facts({
    connections: [connection(['FILE_READ'])],
    policies: [policy('FILE_READ', 'READ_FILE', 'AUTO', ROOT)],
  }), readyRuntime());
  assert.equal(rowOf(matched, 'files').state, 'READ_ONLY');
});

test('连接的目录边界不覆盖受管目录时，该连接不承载这个能力', () => {
  const rows = evaluateToolRows(facts({
    connections: [connection(['FILE_READ'], { root: 'D:\\Elsewhere' })],
    policies: [policy('FILE_READ', 'READ_FILE', 'AUTO')],
  }), readyRuntime());
  assert.equal(rowOf(rows, 'files').state, 'NOT_AUTHORIZED');
  assert.equal(rowOf(rows, 'files').counts.unavailable, 7);
});

test('插件运行时不可用时状态是「本机不可用」，即使授权与连接都齐备', () => {
  // 本机确实没有 gh：授权齐全也只会在第一次调用时失败，界面必须先说清这一步。
  const rows = evaluateToolRows(facts({
    connections: [connection(['GITHUB_READ'], { root: null })],
    policies: [policy('GITHUB_READ', 'GITHUB_REPO_VIEW', 'AUTO'),
      policy('GITHUB_READ', 'GITHUB_PR_LIST', 'AUTO')],
  }), [{ plugin: 'computer', state: 'READY', detail: '', remediation: null },
    { plugin: 'browser', state: 'READY', detail: '', remediation: null },
    { plugin: 'github', state: 'NOT_INSTALLED', detail: '没有找到可执行的 GitHub CLI（gh）。',
      remediation: '安装 gh 后重试。' }]);
  const github = rowOf(rows, 'github');
  assert.equal(github.state, 'RUNTIME_UNAVAILABLE');
  assert.match(github.detail, /没有找到可执行的 GitHub CLI/);
});

test('读不到生效策略版本时状态是无法确认，而不是默认可用', () => {
  const rows = evaluateToolRows(facts({
    connections: [connection(['FILE_READ'])],
    policies: [policy('FILE_READ', 'READ_FILE', 'AUTO')],
    policyIncomplete: true,
  }), readyRuntime());
  const files = rowOf(rows, 'files');
  assert.equal(files.state, 'UNKNOWN');
  assert.match(files.detail, /不推断可用/);
});

test('没有登记任何连接时是未配置，而不是「未授权」或「可用」', () => {
  const rows = evaluateToolRows(facts({ connections: [] }), readyRuntime());
  for (const row of rows) assert.equal(row.state, 'NOT_CONFIGURED');
});

test('浏览器只按站点授权时，结论降级为「仅部分站点」，不冒充全部站点可用', () => {
  const rows = evaluateToolRows(facts({
    connections: [connection(['BROWSER_READ'], { root: null })],
    policies: [policy('BROWSER_READ', 'BROWSER_READ_PAGE', 'AUTO', 'browser://example.com')],
  }), readyRuntime());
  const browser = rowOf(rows, 'browser');
  assert.equal(browser.state, 'SITE_SCOPED');
  assert.equal(browser.counts.site_scoped, 1);

  // 全部站点策略存在时按正常授权处理。
  const allSites = evaluateToolRows(facts({
    connections: [connection(['BROWSER_READ'], { root: null })],
    policies: [policy('BROWSER_READ', 'BROWSER_READ_PAGE', 'AUTO', 'browser://')],
  }), readyRuntime());
  assert.equal(rowOf(allSites, 'browser').state, 'READ_ONLY');
});

test('网页抓取按连接登记的允许主机核对策略主机，主机不一致不算授权', () => {
  const rows = evaluateToolRows(facts({
    connections: [connection(['WEB_FETCH'], { root: null, host: 'example.org' })],
    policies: [policy('WEB_FETCH', 'WEB_FETCH', 'AUTO', 'other.org')],
  }), readyRuntime());
  assert.equal(rowOf(rows, 'web').state, 'NOT_AUTHORIZED');

  const matched = evaluateToolRows(facts({
    connections: [connection(['WEB_FETCH'], { root: null, host: 'example.org' })],
    policies: [policy('WEB_FETCH', 'WEB_FETCH', 'AUTO', 'example.org')],
  }), readyRuntime());
  assert.equal(rowOf(matched, 'web').state, 'READY');
});

test('载荷上限小于空参数编码的 2 字节时，该策略等于不可用', () => {
  // 与 Gateway `selectedPolicy` 的判定同一口径：超过上限即拒绝，不是「差不多能用」。
  const rows = evaluateToolRows(facts({
    connections: [connection(['FILE_READ'])],
    policies: [policy('FILE_READ', 'READ_FILE', 'AUTO', ROOT, 1)],
  }), readyRuntime());
  assert.equal(rowOf(rows, 'files').state, 'DENIED');
});
