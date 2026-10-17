import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { buildToolTurns, decideToolAdaptation, gatewayParamsFor, MAX_TOOL_RESULT_BYTES,
  projectToolResult, ToolRequestRejected, toolTargetFor, validateToolArguments,
  type ToolLoopPlan } from '../../src/application/tool-loop.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import { CANDIDATE_OUTPUT_SCHEMA } from '../../src/workflow/markdown-deliverable.js';
import { INTERNAL_TOOL_DEFINITIONS, declaredToolSpecs, readInternalTool } from '../../src/workflow/tool-catalog.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import type { RunToolCallRow } from '../../src/infrastructure/database-schema.js';

const searchSpec = declaredToolSpecs(['search_text'])[0]!;
const gitDiffSpec = declaredToolSpecs(['git_diff'])[0]!;
const changesetSpec = declaredToolSpecs(['apply_changeset'])[0]!;

test('变更数组按词表声明的形状放行，不会因为校验器不认数组而被当成缺失必填参数', () => {
  // 反例：apply_changeset 的唯一参数是数组。校验器若只处理标量，规范化后 changes 会被
  // 丢掉，必填检查随即报「缺少必填参数」——真实模型每次写请求都会被确定性拒绝，
  // 读写主链就此不可用。
  const changes = [{ action: 'MODIFY', path: 'src/a.ts', baselineSha256: 'b'.repeat(64),
    content: 'export const a = 1;\n' }];
  const validated = validateToolArguments(changesetSpec, { changes });
  assert.deepEqual((validated as { changes?: unknown }).changes, changes);
  assert.throws(() => validateToolArguments(changesetSpec, { changes: 'src/a.ts' }),
    (error: unknown) => (error as ToolRequestRejected).reason === 'TOOL_ARGUMENT_INVALID');
});

test('写工具的声明把变更项字段讲清楚，模型才知道修改必须带真实基线摘要', () => {
  const propertiesOf = changesetSpec.parameters.properties as
    Record<string, { items?: { properties?: Record<string, { type?: string }> } }>;
  const item = propertiesOf.changes;
  assert.equal(typeof item, 'object');
  const properties = (item as { items?: { properties?: Record<string, { type?: string }> } })
    .items?.properties ?? {};
  // 这些字段名就是 normalizeToolChanges 逐项校验的那一套：声明与校验必须同名。
  assert.deepEqual(Object.keys(properties).sort(), ['action', 'baselineSha256', 'content', 'path']);
  assert.equal(properties.path?.type, 'string');
  assert.equal(properties.baselineSha256?.type, 'string');
  assert.equal(properties.content?.type, 'string');
});

function plan(allowed: readonly string[], root = join('D:', 'work')): ToolLoopPlan {
  return { intent: { intent_key: 'tool-loop-v1', resource_id: 'r1', connections: {
    FILE_QUERY: 'c1', FILE_READ: 'c2', GIT_READ: 'c3' },
    allowed_tools: allowed, max_rounds: 4, max_tool_calls: 8 },
    projectId: 'p1', resourceId: 'r1', canonicalRoot: root,
    specs: declaredToolSpecs(allowed),
    allowed: new Map(allowed.flatMap((name) => {
      const definition = readInternalTool(name);
      return definition === undefined ? [] : [[name, definition] as const];
    })) };
}

test('tool arguments are validated against the frozen schema, not model intent', () => {
  assert.deepEqual(validateToolArguments(searchSpec, { query: 'Relay' }), { query: 'Relay' });
  assert.throws(() => validateToolArguments(searchSpec, {}), ToolRequestRejected);
  assert.throws(() => validateToolArguments(searchSpec, { query: 7 }),
    (error: unknown) => error instanceof ToolRequestRejected &&
      (error as ToolRequestRejected).reason === 'TOOL_ARGUMENT_INVALID');
  // 词表声明 additionalProperties:false，模型多带的字段不能变成动作参数。
  assert.throws(() => validateToolArguments(searchSpec, { query: 'x', path: '../../etc' }),
    (error: unknown) => (error as ToolRequestRejected).reason === 'TOOL_ARGUMENT_UNKNOWN');
  assert.throws(() => validateToolArguments(gitDiffSpec, { staged: 'yes' }),
    (error: unknown) => (error as ToolRequestRejected).reason === 'TOOL_ARGUMENT_INVALID');
  assert.throws(() => validateToolArguments(searchSpec, { query: 'x'.repeat(5000) }),
    (error: unknown) => (error as ToolRequestRejected).reason === 'TOOL_ARGUMENT_TOO_LARGE');
});

test('declared optional numeric bounds are enforced instead of clamped silently', () => {
  const logSpec = declaredToolSpecs(['git_log'])[0]!;
  assert.deepEqual(validateToolArguments(logSpec, { max_count: 50 }), { max_count: 50 });
  assert.throws(() => validateToolArguments(logSpec, { max_count: 500 }),
    (error: unknown) => (error as ToolRequestRejected).reason === 'TOOL_ARGUMENT_OUT_OF_RANGE');
  assert.throws(() => validateToolArguments(logSpec, { max_count: 1.5 }), ToolRequestRejected);
});

test('the target and the Gateway parameters come from the frozen envelope, not the model', () => {
  const resolved = plan(['search_text', 'git_diff']);
  const search = readInternalTool('search_text')!;
  const diff = readInternalTool('git_diff')!;
  assert.equal(toolTargetFor(resolved, search, { query: 'x' }), join('D:', 'work'));
  assert.equal(toolTargetFor(resolved, search, { query: 'x', relative_path: 'src' }),
    join('D:', 'work', 'src'));
  // Git 只读的目标永远是受管根，模型不能用 relative_path 把它挪走。
  assert.equal(toolTargetFor(resolved, diff, { path: 'src' }), join('D:', 'work'));
  assert.deepEqual(gatewayParamsFor(diff, { path: 'src', staged: true, relative_path: 'src' }),
    { path: 'src', cached: true });
  assert.deepEqual(gatewayParamsFor(search, { query: 'x', limit: 5 }), { query: 'x', limit: 5 });
  assert.deepEqual(gatewayParamsFor(readInternalTool('read_file')!, { relative_path: 'a.ts' }), {});
});

test('the catalog is a closed list: every entry maps to a declared Gateway action', () => {
  const names = INTERNAL_TOOL_DEFINITIONS.map((entry) => entry.name);
  assert.deepEqual(names, ['apply_changeset', 'read_change_set', 'run_check',
    'list_directory', 'find_paths', 'search_text', 'read_file',
    'git_status', 'git_diff', 'git_log',
    // 0092: Computer Plugin V1 的十个桌面级工具。
    'computer_screenshot', 'computer_get_windows', 'computer_activate_window',
    'computer_click', 'computer_double_click', 'computer_scroll', 'computer_drag',
    'computer_type', 'computer_keypress', 'computer_hotkey',
    // 0103: F25 内置官方 GitHub Skill 首片的四个只读工具。
    'github_repo_view', 'github_pr_list', 'github_pr_view', 'github_issue_list']);
  for (const entry of INTERNAL_TOOL_DEFINITIONS) {
    assert.equal(readInternalTool(entry.name), entry);
    assert.equal(entry.spec.name, entry.name);
    assert.equal(entry.spec.parameters.additionalProperties, false);
  }
  assert.equal(readInternalTool('apply_change_set'), undefined);
  assert.equal(readInternalTool('delete_file'), undefined);
  assert.equal(readInternalTool('run_bash'), undefined);
  assert.equal(readInternalTool('computer.screenshot'), undefined,
    '点号命名不在词表内：provider 协议只接受 snake_case');
});

test('a bounded tool result is marked truncated instead of passing a partial body as complete', () => {
  const small = projectToolResult('SETTLED', { entries: [{ path: 'a.ts' }] }, null);
  assert.equal(small.includes('truncated'), false);
  const large = projectToolResult('SETTLED', { content: 'x'.repeat(MAX_TOOL_RESULT_BYTES * 2) }, null);
  assert.ok(Buffer.byteLength(large, 'utf8') <= MAX_TOOL_RESULT_BYTES + 64);
  assert.ok(large.includes('"truncated":true'));
  assert.ok(large.includes('omitted_bytes'));
});

test('a rejected or missing result is typed, never an empty success', () => {
  assert.deepEqual(JSON.parse(projectToolResult('REJECTED', null,
    { reason: 'TOOL_UNKNOWN', detail: '不在词表内' })),
  { ok: false, reason: 'TOOL_UNKNOWN', detail: '不在词表内' });
  assert.deepEqual(JSON.parse(projectToolResult('PREPARED', null, null)),
    { ok: false, reason: 'TOOL_RESULT_MISSING' });
});

function row(overrides: Partial<RunToolCallRow> & Pick<RunToolCallRow, 'round' | 'ordinal'>
  & Pick<RunToolCallRow, 'status'>): RunToolCallRow {
  return { id: `row-${overrides.round}-${overrides.ordinal}`,
    workspace_id: 'w', project_id: 'p', run_id: 'r', step_id: 's', step_attempt_id: 'a',
    model_call_id: 'm', provider_tool_call_id: `provider-${overrides.round}-${overrides.ordinal}`,
    tool_name: 'search_text', arguments: { query: 'Relay' },
    arguments_sha256: '0'.repeat(64), assistant_message: null, operation_id: null, result_ref: null,
    adaptation_of: null, adapted_path: null, revision: 1n,
    created_at: new Date(0), updated_at: new Date(0), ...overrides };
}

test('only fully settled rounds are replayed to the model', () => {
  const settled = row({ round: 0, ordinal: 0, status: 'SETTLED', operation_id: 'op-0' });
  const rejected = row({ round: 0, ordinal: 1, status: 'REJECTED',
    result_ref: { reason: 'TOOL_UNKNOWN', detail: '越界' } });
  const pending = row({ round: 1, ordinal: 0, status: 'REQUESTED' });
  const turns = buildToolTurns([settled, rejected, pending],
    new Map([['op-0', { count: 1, truncated: false } as JsonObject]]));
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.calls.length, 2);
  assert.equal(turns[0]!.results.length, 2);
  assert.equal(turns[0]!.results[0]!.isError, false);
  assert.equal(turns[0]!.results[1]!.isError, true);
  // Provider 的 tool_call_id 只是轮内配对标签，原样回传即可。
  assert.equal(turns[0]!.calls[0]!.providerToolCallId, 'provider-0-0');
});

test('settled tool rounds restore their saved assistant fields and keep old rows unknown', () => {
  const first = row({ round: 0, ordinal: 0, status: 'SETTLED', operation_id: 'op-0',
    assistant_message: { content: '我先读取文件。', reasoning_content: '按实际文件继续。' } });
  const second = row({ round: 0, ordinal: 1, status: 'SETTLED', operation_id: 'op-1' });
  const legacy = row({ round: 1, ordinal: 0, status: 'SETTLED', operation_id: 'op-2' });
  const turns = buildToolTurns([first, second, legacy], new Map([
    ['op-0', { count: 1 }], ['op-1', { count: 2 }], ['op-2', { count: 3 }],
  ]));
  assert.equal(turns[0]!.preamble, first.assistant_message?.content);
  assert.equal(turns[0]!.reasoningContent, first.assistant_message?.reasoning_content);
  assert.equal(turns[0]!.calls.length, 2);
  assert.equal(turns[1]!.preamble, '');
  assert.equal(turns[1]!.reasoningContent, undefined);
});

test('a settled operation whose result is gone is reported as an error to the model', () => {
  const turns = buildToolTurns([row({ round: 0, ordinal: 0, status: 'SETTLED', operation_id: 'gone' })],
    new Map());
  assert.equal(turns[0]!.results[0]!.isError, true);
  assert.deepEqual(JSON.parse(turns[0]!.results[0]!.content),
    { ok: false, reason: 'TOOL_RESULT_MISSING' });
});

test('a failed configured check is replayed as an error with its actual output', () => {
  const check = row({ round: 0, ordinal: 0, status: 'SETTLED',
    tool_name: 'run_check', arguments: { check_id: 'tests' }, operation_id: 'check-1' });
  // A normal nonzero CLI exit has no reason field. Settlement records receipt availability,
  // so SETTLED alone cannot tell the model whether the actual check passed.
  const failed: JsonObject = { outcome: 'FAILED', exitCode: 1,
    stdout: '1 failing test', stderr: 'expected 2, received 1', truncated: false };
  const turns = buildToolTurns([check], new Map([['check-1', failed]]));
  assert.equal(turns[0]!.results[0]!.isError, true);
  assert.deepEqual(JSON.parse(turns[0]!.results[0]!.content), failed);

  const passed: JsonObject = { outcome: 'SUCCEEDED', exitCode: 0,
    stdout: 'all tests passed', stderr: '', truncated: false };
  const repaired = buildToolTurns([check], new Map([['check-1', passed]]));
  assert.equal(repaired[0]!.results[0]!.isError, false);
  assert.deepEqual(JSON.parse(repaired[0]!.results[0]!.content), passed);
});

const STALE = 'a'.repeat(64);
const CURRENT = 'b'.repeat(64);

function changesetRow(id: string, overrides: Partial<RunToolCallRow> = {}): RunToolCallRow {
  return row({ id, round: Number(id.replace(/\D/g, '')) || 0, ordinal: 0, status: 'SETTLED',
    tool_name: 'apply_changeset',
    arguments: { changes: [{ path: 'src/index.ts', action: 'MODIFY',
      baselineSha256: STALE, content: '旧目标\n' }] }, ...overrides });
}

function conflicted(overrides: Partial<RunToolCallRow> = {}): RunToolCallRow {
  return changesetRow('row-0-0', { result_ref: { reason: 'SOME_CHANGES_FAILED_OR_CONFLICTED',
    changes: [{ path: 'src/index.ts', action: 'MODIFY', status: 'CONFLICT',
      baselineSha256: STALE, actualBaselineSha256: CURRENT }] }, ...overrides });
}

const reread = { changes: [{ path: 'src/index.ts', action: 'MODIFY', baselineSha256: CURRENT,
  content: '保留用户改动后的新目标\n' }] };

test('a conflict adaptation is bound to its origin, its re-read baseline and new content', () => {
  const decision = decideToolAdaptation({ prior: [conflicted()], changes: reread.changes });
  assert.deepEqual(decision, { kind: 'ADAPT', of: 'row-0-0', path: 'src/index.ts' });
});

test('a blind retry of the same stale baseline is refused, not treated as an adaptation', () => {
  const decision = decideToolAdaptation({ prior: [conflicted()], changes: [
    { path: 'src/index.ts', action: 'MODIFY', baselineSha256: STALE, content: '旧目标\n' }] });
  assert.equal(decision.kind, 'STOP');
  assert.equal(decision.kind === 'STOP' ? decision.reason : '', 'TOOL_ADAPTATION_STALE_BASELINE');
});

test('a new baseline with the old target text is refused as a disguised replay', () => {
  const decision = decideToolAdaptation({ prior: [conflicted()], changes: [
    { path: 'src/index.ts', action: 'MODIFY', baselineSha256: CURRENT, content: '旧目标\n' }] });
  assert.equal(decision.kind === 'STOP' ? decision.reason : '', 'TOOL_ADAPTATION_CONTENT_UNCHANGED');
});

test('only one adaptation is allowed, and an adapted request is never adapted again', () => {
  const adapted = changesetRow('row-1-0', { adaptation_of: 'row-0-0',
    adapted_path: 'src/index.ts',
    result_ref: { reason: 'SOME_CHANGES_FAILED_OR_CONFLICTED',
      changes: [{ path: 'src/index.ts', action: 'MODIFY', status: 'CONFLICT',
        baselineSha256: CURRENT, actualBaselineSha256: 'c'.repeat(64) }] } });
  // 原始请求已被适配过一次：再次要求适配必须停下来交给用户。
  const exhausted = decideToolAdaptation({ prior: [conflicted(), adapted], changes: [
    { path: 'src/index.ts', action: 'MODIFY', baselineSha256: 'c'.repeat(64),
      content: '第三次\n' }] });
  assert.equal(exhausted.kind === 'STOP' ? exhausted.reason : '', 'TOOL_ADAPTATION_REQUIRES_HUMAN');
  // 已经被适配过的那一行自己也不能再成为新的适配来源（深度限制）。
  const depth = decideToolAdaptation({ prior: [adapted], changes: [
    { path: 'src/index.ts', action: 'MODIFY', baselineSha256: 'c'.repeat(64),
      content: '第四次\n' }] });
  assert.equal(depth.kind === 'STOP' ? depth.reason : '', 'TOOL_ADAPTATION_REQUIRES_HUMAN');
});

test('an adaptation that touches several conflicted paths at once is not clearly separable', () => {
  const twoPaths = conflicted({ result_ref: { reason: 'SOME_CHANGES_FAILED_OR_CONFLICTED',
    changes: [{ path: 'src/index.ts', action: 'MODIFY', status: 'CONFLICT',
      baselineSha256: STALE, actualBaselineSha256: CURRENT },
    { path: 'README.md', action: 'MODIFY', status: 'CONFLICT',
      baselineSha256: STALE, actualBaselineSha256: CURRENT }] } });
  const decision = decideToolAdaptation({ prior: [twoPaths], changes: [
    { path: 'src/index.ts', action: 'MODIFY', baselineSha256: CURRENT, content: '一\n' },
    { path: 'README.md', action: 'MODIFY', baselineSha256: CURRENT, content: '二\n' }] });
  assert.equal(decision.kind === 'STOP' ? decision.reason : '', 'TOOL_ADAPTATION_AMBIGUOUS');
});

test('a vanished conflict target and an unrelated path are both refused or passed through', () => {
  const vanished = conflicted({ result_ref: { reason: 'SOME_CHANGES_FAILED_OR_CONFLICTED',
    changes: [{ path: 'src/index.ts', action: 'DELETE', status: 'CONFLICT',
      baselineSha256: STALE, actualBaselineSha256: null }] } });
  assert.equal(decideToolAdaptation({ prior: [vanished], changes: reread.changes }).kind, 'STOP');
  // 与冲突无关的路径仍是普通请求：没有冲突就没有适配问题。
  assert.equal(decideToolAdaptation({ prior: [conflicted()], changes: [
    { path: 'docs/new.md', action: 'CREATE', content: '# 新\n' }] }).kind, 'PLAIN');
  assert.equal(decideToolAdaptation({ prior: [], changes: reread.changes }).kind, 'PLAIN');
});

test('the deterministic Fake model walks its scripted rounds and then answers', async () => {
  const port = new FakeModelPort();
  const manifest: JsonObject = { task: { title: '工具循环' },
    contract: { objective: '按工具结果继续' },
    tool_script: [
      [{ name: 'search_text', arguments: { query: 'Relay' } }],
      [{ name: 'git_diff', arguments: {} }],
    ] };
  const tools = declaredToolSpecs(['search_text', 'git_diff']);
  const first = await port.generate({ manifest, outputSchema: CANDIDATE_OUTPUT_SCHEMA, tools });
  assert.equal(first.kind, 'TOOL_CALLS');
  if (first.kind !== 'TOOL_CALLS') return;
  assert.deepEqual(first.calls.map((call) => call.name), ['search_text']);
  const second = await port.generate({ manifest, outputSchema: CANDIDATE_OUTPUT_SCHEMA, tools,
    toolTurns: [{ calls: first.calls, results: [{ providerToolCallId: first.calls[0]!.providerToolCallId,
      name: 'search_text', content: '{"count":0}', isError: false }] }] });
  assert.equal(second.kind, 'TOOL_CALLS');
  if (second.kind !== 'TOOL_CALLS') return;
  assert.deepEqual(second.calls.map((call) => call.name), ['git_diff']);
  const third = await port.generate({ manifest, outputSchema: CANDIDATE_OUTPUT_SCHEMA, tools,
    toolTurns: [0, 1].map(() => ({ calls: second.calls, results: [] })) });
  // 脚本耗尽后回到普通生成：工具循环必须能真正收尾。
  assert.equal(third.kind, 'CONTENT');
});

test('without a script the Fake model keeps the original single-shot behaviour', async () => {
  const port = new FakeModelPort();
  const result = await port.generate({ manifest: { task: { title: 'T' } },
    outputSchema: CANDIDATE_OUTPUT_SCHEMA });
  assert.equal(result.kind, 'CONTENT');
});
