import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { buildToolTurns, gatewayParamsFor, MAX_TOOL_RESULT_BYTES, projectToolResult,
  ToolRequestRejected, toolTargetFor, validateToolArguments,
  type ToolLoopPlan } from '../../src/application/tool-loop.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import { CANDIDATE_OUTPUT_SCHEMA } from '../../src/workflow/markdown-deliverable.js';
import { INTERNAL_TOOL_DEFINITIONS, declaredToolSpecs, readInternalTool } from '../../src/workflow/tool-catalog.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import type { RunToolCallRow } from '../../src/infrastructure/database-schema.js';

const searchSpec = declaredToolSpecs(['search_text'])[0]!;
const gitDiffSpec = declaredToolSpecs(['git_diff'])[0]!;

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
  assert.deepEqual(names, ['list_directory', 'find_paths', 'search_text', 'read_file',
    'git_status', 'git_diff', 'git_log']);
  for (const entry of INTERNAL_TOOL_DEFINITIONS) {
    assert.equal(readInternalTool(entry.name), entry);
    assert.equal(entry.spec.name, entry.name);
    assert.equal(entry.spec.parameters.additionalProperties, false);
  }
  assert.equal(readInternalTool('apply_changeset'), undefined);
  assert.equal(readInternalTool('run_bash'), undefined);
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
    arguments_sha256: '0'.repeat(64), operation_id: null, result_ref: null, revision: 1n,
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

test('a settled operation whose result is gone is reported as an error to the model', () => {
  const turns = buildToolTurns([row({ round: 0, ordinal: 0, status: 'SETTLED', operation_id: 'gone' })],
    new Map());
  assert.equal(turns[0]!.results[0]!.isError, true);
  assert.deepEqual(JSON.parse(turns[0]!.results[0]!.content),
    { ok: false, reason: 'TOOL_RESULT_MISSING' });
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