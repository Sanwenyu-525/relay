import assert from 'node:assert/strict';
import test from 'node:test';

import { freezeExecutionContract, readMockActionOperationId,
  readFileWriteAction, readWebFetchAction } from '../../src/workflow/execution-contract.js';

test('file write changes and one operation identity are frozen into the contract hash', () => {
  const change = { path: 'src/result.txt', action: 'CREATE' as const, content: '' };
  const input = { taskId: '11111111-1111-1111-1111-111111111111', acceptanceRevision: 1n,
    objective: 'o', expectedOutputs: {}, criteria: [],
    fileWriteAction: { operation_id: '22222222-2222-2222-2222-222222222222',
      intent_key: 'file-write-v1' as const,
      connection_id: '33333333-3333-3333-3333-333333333333',
      resource_id: '44444444-4444-4444-4444-444444444444', changes: [change] } };
  const frozen = freezeExecutionContract(input);
  change.content = 'changed later';
  assert.deepEqual(readFileWriteAction(frozen.snapshot)?.changes, [
    { path: 'src/result.txt', action: 'CREATE', content: '' },
  ]);
  assert.equal(readMockActionOperationId(frozen.snapshot), input.fileWriteAction.operation_id);
  const changed = freezeExecutionContract({ ...input, fileWriteAction: { ...input.fileWriteAction,
    changes: [{ path: 'src/result.txt', action: 'CREATE', content: 'changed later' }] } });
  assert.notEqual(frozen.contractHash.toString('hex'), changed.contractHash.toString('hex'));
});

test('malformed frozen file write intent is rejected on read', () => {
  assert.throws(() => readFileWriteAction({ file_write_action: {
    operation_id: 'o', intent_key: 'file-write-v1', connection_id: 'c', resource_id: 'r',
    changes: [{ path: 'a.txt', action: 'CREATE' }, { path: 'b.txt', action: 'UNKNOWN' }],
  } }), /invalid/);
  assert.throws(() => readFileWriteAction({ file_write_action: {
    operation_id: 'o', intent_key: 'file-write-v1', connection_id: 'c', resource_id: 'r',
    changes: [],
  } }), /invalid/);
});

test('a frozen web fetch action round-trips and resolves its operation identity', () => {
  const frozen = freezeExecutionContract({
    taskId: '11111111-1111-1111-1111-111111111111',
    acceptanceRevision: 1n,
    objective: '读一个公开网页',
    expectedOutputs: {},
    criteria: [],
    webFetchAction: {
      operation_id: '22222222-2222-2222-2222-222222222222',
      intent_key: 'mock-web-fetch-v1',
      connection_id: '33333333-3333-3333-3333-333333333333',
      url: 'https://example.com/spec',
    },
  });

  const action = readWebFetchAction(frozen.snapshot);
  assert.equal(action?.operation_id, '22222222-2222-2222-2222-222222222222');
  assert.equal(action?.intent_key, 'mock-web-fetch-v1');
  assert.equal(action?.connection_id, '33333333-3333-3333-3333-333333333333');
  assert.equal(action?.url, 'https://example.com/spec');
  assert.equal(readMockActionOperationId(frozen.snapshot), action?.operation_id);
});

test('a malformed frozen web fetch action is rejected on read', () => {
  assert.throws(() => readWebFetchAction({
    web_fetch_action: { operation_id: '22222222-2222-2222-2222-222222222222',
      intent_key: 'mock-web-fetch-v1', connection_id: '33333333-3333-3333-3333-333333333333' },
  }));
  assert.throws(() => readWebFetchAction({
    web_fetch_action: { operation_id: '22222222-2222-2222-2222-222222222222',
      intent_key: 'write-marker-v1', connection_id: '33333333-3333-3333-3333-333333333333',
      url: 'https://example.com/spec' },
  }));
  assert.equal(readWebFetchAction({}), undefined);
});

test('the unified intent identity covers write, file read and web fetch alike', () => {
  const web = freezeExecutionContract({
    taskId: '11111111-1111-1111-1111-111111111111', acceptanceRevision: 1n,
    objective: 'o', expectedOutputs: {}, criteria: [],
    webFetchAction: { operation_id: 'w1', intent_key: 'mock-web-fetch-v1',
      connection_id: 'c', url: 'https://example.com/' },
  });
  const file = freezeExecutionContract({
    taskId: '11111111-1111-1111-1111-111111111111', acceptanceRevision: 1n,
    objective: 'o', expectedOutputs: {}, criteria: [],
    fileReadAction: { operation_id: 'f1', intent_key: 'mock-file-read-v1',
      connection_id: 'c', resource_id: 'r', relative_target: 'a.md' },
  });
  const write = freezeExecutionContract({
    taskId: '11111111-1111-1111-1111-111111111111', acceptanceRevision: 1n,
    objective: 'o', expectedOutputs: {}, criteria: [],
    mockGatewayAction: { operation_id: 'm1', intent_key: 'mock-write-marker-v1',
      connection_id: 'c', resource_id: 'r', target: 't', content: 'x' },
  });
  assert.equal(readMockActionOperationId(web.snapshot), 'w1');
  assert.equal(readMockActionOperationId(file.snapshot), 'f1');
  assert.equal(readMockActionOperationId(write.snapshot), 'm1');
});
