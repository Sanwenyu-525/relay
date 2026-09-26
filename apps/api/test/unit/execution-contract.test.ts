import assert from 'node:assert/strict';
import test from 'node:test';

import { freezeExecutionContract, readMockActionOperationId,
  readWebFetchAction } from '../../src/workflow/execution-contract.js';

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
