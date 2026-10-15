import assert from 'node:assert/strict';
import test from 'node:test';

import { Value } from '@sinclair/typebox/value';

import { RunToolCallsSchema } from '../../src/api/domain-schemas.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import type { RunRow, RunStatus, RunToolCallRow, RunToolCallStatus } from '../../src/infrastructure/database-schema.js';
import { projectRunToolCalls } from '../../src/application/run-tool-call-projection.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const RUN_STATUS_UUID = '22222222-2222-4222-8222-222222222222';

/** 夹具 id 必须是真 UUID：响应 schema 按 UUID_PATTERN 校验，写不出形状的 id 等于没测 schema。 */
function id(kind: 'call' | 'model' | 'operation', round: number, ordinal: number): string {
  return `${kind === 'call' ? 'aaaaaaaa' : kind === 'model' ? 'bbbbbbbb' : 'cccccccc'}-0000-4000-8000-${
    String(round).padStart(6, '0')}${String(ordinal).padStart(6, '0')}`;
}

/** 只填投影真正读到的列；其余列给占位值，避免测试被无关字段绑死。 */
function row(overrides: Partial<RunToolCallRow> & Pick<RunToolCallRow, 'round' | 'ordinal' | 'status'>): RunToolCallRow {
  return {
    id: id('call', overrides.round, overrides.ordinal),
    workspace_id: 'ws', project_id: 'project', run_id: RUN_ID,
    step_id: 'step', step_attempt_id: `attempt-${overrides.round}`,
    model_call_id: id('model', overrides.round, 0),
    provider_tool_call_id: `provider-${overrides.round}-${overrides.ordinal}`,
    tool_name: 'read_file',
    arguments: { relative_path: 'a.ts' },
    arguments_sha256: 'a'.repeat(64),
    assistant_message: null,
    operation_id: null,
    result_ref: null,
    adaptation_of: null,
    adapted_path: null,
    revision: 1n,
    created_at: new Date('2026-10-04T01:00:00.000Z'),
    updated_at: new Date('2026-10-04T01:00:01.000Z'),
    ...overrides,
  };
}

function run(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: RUN_ID, workspace_id: 'ws', task_id: 'task', status: 'RUNNING' as RunStatus,
    revision: 3n, ownership_epoch: 1n, retry_of_run_id: null, resume_phase: null,
    wait_reason: null, current_step_id: 'step', worker_epoch: 0n, worker_id: null,
    worker_lease_until: null,
    created_at: new Date('2026-10-04T01:00:00.000Z'),
    updated_at: new Date('2026-10-04T01:00:02.000Z'),
    terminal_at: null,
    ...overrides,
  };
}

test('groups tool calls by round and orders each round by ordinal', () => {
  const projection = projectRunToolCalls(run(), [
    row({ round: 1, ordinal: 1, status: 'SETTLED' }),
    row({ round: 0, ordinal: 2, status: 'SETTLED' }),
    row({ round: 1, ordinal: 0, status: 'SETTLED' }),
    row({ round: 0, ordinal: 0, status: 'SETTLED' }),
  ]);

  assert.deepEqual(projection.rounds.map((round) => round.round), [0, 1]);
  assert.deepEqual(projection.rounds.map((round) => round.calls.map((call) => call.ordinal)),
    [[0, 2], [0, 1]]);
  assert.equal(projection.run_id, RUN_ID);
  assert.equal(projection.run_status, 'RUNNING');
  assert.equal(projection.wait_reason, null);
});

test('carries every closed status through without folding or renaming it', () => {
  const statuses: readonly RunToolCallStatus[] = ['REQUESTED', 'PREPARED', 'WAITING_APPROVAL',
    'SETTLED', 'REJECTED', 'ABANDONED'];
  const projection = projectRunToolCalls(run(), statuses.map((status, index) =>
    row({ round: 0, ordinal: index, status })));

  assert.deepEqual(projection.rounds[0]?.calls.map((call) => call.status), [...statuses]);
});

test('passes arguments and result_ref through byte for byte', () => {
  // 截断后缀是模型当时实际收到的内容：重新序列化会改变字节，界面与模型就对不上账。
  const resultRef = { entries: ['a', 'b'], truncated: true, omitted_bytes: 4096 };
  const projection = projectRunToolCalls(run(), [row({ round: 0, ordinal: 0, status: 'SETTLED',
    arguments: { relative_path: 'src/x.ts', limit: 7 }, result_ref: resultRef,
    assistant_message: { content: '我先查找文件。', reasoning_content: 'Provider protocol data' } })]);

  const call = projection.rounds[0]?.calls[0];
  assert.deepEqual(call?.arguments, { relative_path: 'src/x.ts', limit: 7 });
  assert.deepEqual(call?.result_ref, resultRef);
  assert.equal(JSON.stringify(call?.result_ref), JSON.stringify(resultRef));
  assert.equal('assistant_message' in (call ?? {}), false);
  assert.equal(JSON.stringify(projection).includes('Provider protocol data'), false);
});

test('keeps a missing result distinct from an empty one and an undispatched operation null', () => {
  const projection = projectRunToolCalls(run(), [
    row({ round: 0, ordinal: 0, status: 'REQUESTED', result_ref: null, operation_id: null }),
    row({ round: 0, ordinal: 1, status: 'SETTLED', result_ref: {}, operation_id: id('operation', 0, 1) }),
  ]);

  const [missing, empty] = projection.rounds[0]?.calls ?? [];
  assert.equal(missing?.result_ref, null);
  assert.equal(missing?.operation_id, null);
  assert.deepEqual(empty?.result_ref, {});
  assert.equal(empty?.operation_id, id('operation', 0, 1));
});

test('keeps the rejected reason and the adaptation lineage visible', () => {
  const projection = projectRunToolCalls(run(), [
    row({ round: 0, ordinal: 0, status: 'REJECTED', result_ref: { reason: 'TOOL_CHECK_NOT_CONFIGURED', detail: 'check-1 未配置' } }),
    row({ round: 1, ordinal: 0, status: 'SETTLED', adaptation_of: id('call', 0, 0), adapted_path: 'src/x.ts' }),
  ]);

  const rejected = projection.rounds[0]?.calls[0];
  assert.deepEqual(rejected?.result_ref, { reason: 'TOOL_CHECK_NOT_CONFIGURED', detail: 'check-1 未配置' });
  const adapted = projection.rounds[1]?.calls[0];
  assert.equal(adapted?.adaptation_of, id('call', 0, 0));
  assert.equal(adapted?.adapted_path, 'src/x.ts');
});

test('reports no rounds for a Run that never asked for a tool', () => {
  const projection = projectRunToolCalls(run({ wait_reason: 'REPEATED_FAILURE' }), []);
  assert.deepEqual(projection.rounds, []);
  assert.equal(projection.wait_reason, 'REPEATED_FAILURE');
});

test('carries the row identity and timestamps without inventing a duration', () => {
  const projection = projectRunToolCalls(run(), [row({ round: 0, ordinal: 0, status: 'SETTLED' })]);
  const call = projection.rounds[0]?.calls[0];
  assert.equal(call?.id, id('call', 0, 0));
  assert.equal(call?.provider_tool_call_id, 'provider-0-0');
  assert.equal(call?.created_at, '2026-10-04T01:00:00.000Z');
  assert.equal(call?.updated_at, '2026-10-04T01:00:01.000Z');
  assert.equal(call?.round, 0);
  assert.ok(Object.keys(call ?? {}).every((key) => key !== 'revision'),
    '投影不暴露可变列：界面不需要 revision，暴露它会诱使前端把它当身份');
});

test('does not mutate the rows it projects', () => {
  const rows = [row({ round: 0, ordinal: 0, status: 'SETTLED' })];
  // revision 是 bigint，JSON.stringify 不可用；structuredClone 同时保留 BigInt 与 Date。
  const snapshot = structuredClone(rows);
  projectRunToolCalls(run(), rows);
  assert.deepEqual(rows, snapshot);
});

test('ignores an unknown tool name instead of failing the whole projection', () => {
  // 词表是封闭的，但历史行可能来自更早的部署。丢掉整份轨迹会让人看不到已经发生过的调用。
  const projection = projectRunToolCalls(run(), [row({ round: 0, ordinal: 0, status: 'SETTLED',
    tool_name: 'tool_from_older_deployment' })]);
  assert.equal(projection.rounds[0]?.calls[0]?.tool_name, 'tool_from_older_deployment');
});

test('exposes arguments as an object even when a legacy row stored a non-object', () => {
  const legacy = row({ round: 0, ordinal: 0, status: 'SETTLED' });
  const projection = projectRunToolCalls(run(), [
    { ...legacy, arguments: 'not-an-object' as unknown as JsonObject },
  ]);
  assert.deepEqual(projection.rounds[0]?.calls[0]?.arguments, {});
});

test('the HTTP response schema accepts every projected shape', () => {
  // 集成套件全部直接调用应用层，没有 HTTP harness；响应 schema 与 DTO 的漂移只会在真实
  // 请求时被 Fastify 静默拒绝或裁剪。这里把投影结果直接喂给 schema，锁住两者一致。
  const projection = projectRunToolCalls(run({ wait_reason: 'REPEATED_FAILURE' }), [
    row({ round: 0, ordinal: 0, status: 'REQUESTED' }),
    row({ round: 0, ordinal: 1, status: 'REJECTED', result_ref: { reason: 'R', detail: 'D' } }),
    row({ round: 1, ordinal: 0, status: 'SETTLED', operation_id: id('operation', 1, 0), result_ref: { truncated: true } }),
  ]);
  const errors = [...Value.Errors(RunToolCallsSchema, projection)];
  assert.deepEqual(errors.map((error) => `${error.path}: ${error.message}`), []);
});

test('the HTTP response schema rejects an unknown status rather than passing it through', () => {
  // 反向断言：证明上一条不是空跑。若 schema 真的在校验，未知状态必须被拒。
  const projection = projectRunToolCalls(run(), [row({ round: 0, ordinal: 0, status: 'SETTLED' })]);
  const drifted = { ...projection,
    rounds: [{ ...projection.rounds[0]!, calls: [{ ...projection.rounds[0]!.calls[0]!,
      status: 'ALMOST_SETTLED' }] }] };
  assert.equal(Value.Check(RunToolCallsSchema, drifted), false);
});
