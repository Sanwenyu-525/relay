import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fakeLearningEnvelope, parseLearningEnvelope,
} from '../../src/workflow/fake-model-port.js';
import {
  learningIncrementFromEnvelope, learningSettlementCommandId,
} from '../../src/application/learning-records.js';

/**
 * 教学信封与增量搬运的确定性单元测试（0072 / ADR-020 §4）。
 *
 * 这里验的是「模型给什么形状会被接受」这条边界：信封多一个键就整封拒绝、
 * 候选缺字段不补默认值——两处都是「候选不能夹带任意字段」的落点。
 */

test('信封只接受 answer 与 increments 两个键', () => {
  const ok = parseLearningEnvelope(JSON.stringify({ answer: '短解释', increments: [] }));
  assert.equal(ok.schemaError, null);
  assert.equal(ok.answer, '短解释');
  assert.deepEqual(ok.increments, []);

  const extra = parseLearningEnvelope(JSON.stringify({ answer: '短解释', increments: [],
    sql: 'drop table users' }));
  assert.match(extra.schemaError ?? '', /UNEXPECTED_FIELDS:sql/u);
  assert.deepEqual(extra.increments, [], '整封拒绝时不带出任何增量');
});

test('信封不合法时保留可读正文，不伪造增量', () => {
  const notJson = parseLearningEnvelope('这不是 JSON，而是一段讲解。');
  assert.equal(notJson.schemaError, 'LEARNING_ENVELOPE_NOT_JSON');
  assert.equal(notJson.answer, '这不是 JSON，而是一段讲解。');

  const array = parseLearningEnvelope('[1,2,3]');
  assert.equal(array.schemaError, 'LEARNING_ENVELOPE_NOT_OBJECT');

  const noAnswer = parseLearningEnvelope(JSON.stringify({ increments: [] }));
  assert.equal(noAnswer.schemaError, 'LEARNING_ENVELOPE_ANSWER_MISSING');

  const noIncrements = parseLearningEnvelope(JSON.stringify({ answer: '有正文' }));
  assert.equal(noIncrements.schemaError, 'LEARNING_ENVELOPE_INCREMENTS_MISSING');
  assert.equal(noIncrements.answer, '有正文');

  const badEntry = parseLearningEnvelope(JSON.stringify({ answer: '有正文',
    increments: ['EXPOSE'] }));
  assert.equal(badEntry.schemaError, 'LEARNING_ENVELOPE_INCREMENT_NOT_OBJECT');
  assert.deepEqual(badEntry.increments, []);
});

test('增量搬运只搬形状，缺失字段不补默认值', () => {
  const complete = learningIncrementFromEnvelope({ op: 'OBSERVE', topic: '后端可靠性',
    concept: '幂等性', scenario: '同 ID 异载荷', detail: '能指出必须拒绝',
    source_message_id: '11111111-2222-4333-8444-555555555555' });
  assert.deepEqual(complete, { op: 'OBSERVE', topic: '后端可靠性', concept: '幂等性',
    scenario: '同 ID 异载荷', detail: '能指出必须拒绝',
    source_message_id: '11111111-2222-4333-8444-555555555555' });

  // 模型少给场景：留空串，交给校验层以类型化原因拒绝——不在这里补成「通用」。
  const missingScenario = learningIncrementFromEnvelope({ op: 'OBSERVE', topic: '后端可靠性',
    concept: '幂等性', detail: '能指出必须拒绝', source_message_id: 'u1' });
  assert.equal(missingScenario.scenario, '');

  const slug = learningIncrementFromEnvelope({ op: 'EXPOSE', topic: '后端可靠性',
    concept: '幂等性', concept_slug: 'idempotency', scenario: '响应丢失', detail: '讲解过',
    source_message_id: 'a1' });
  assert.equal(slug.concept_slug, 'idempotency');

  // 依据引用缺失同样不补默认值：留空串，由 Owner 的校验层拒绝（R8）。
  const missingBasis = learningIncrementFromEnvelope({ op: 'OBSERVE', topic: '后端可靠性',
    concept: '幂等性', scenario: '同 ID 异载荷', detail: '能指出必须拒绝' });
  assert.equal(missingBasis.source_message_id, '');
});

test('结算命令 ID 由轮次身份派生，稳定且是 UUID 形状', () => {
  const roundId = '11111111-2222-4333-8444-555555555555';
  const first = learningSettlementCommandId(roundId);
  assert.equal(first, learningSettlementCommandId(roundId), '同一轮次派生同一命令 ID');
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(first, learningSettlementCommandId(
    '11111111-2222-4333-8444-555555555556'), '不同轮次得到不同命令 ID');
});

test('Fake 教学信封按行式标记构造增量，其余文本作为正文', () => {
  const envelope = fakeLearningEnvelope([
    '为什么响应丢失会造成重复提交？',
    'LEARNING: EXPOSE | 后端可靠性 | 幂等性 | 响应丢失重试 | 讲解了响应丢失为何需要幂等键',
    'LEARNING: GAP | 后端可靠性 | 幂等键作用域 | 跨任务重试 | 把作用域误当成整库唯一',
  ].join('\n'));
  assert.equal(envelope.increments.length, 2);
  assert.equal(envelope.increments[0]?.op, 'EXPOSE');
  assert.equal(envelope.increments[1]?.scenario, '跨任务重试');
  assert.match(envelope.answer, /响应丢失会造成重复提交/u);
  assert.ok(!envelope.answer.includes('LEARNING:'), '标记行不进入给用户看的正文');

  const empty = fakeLearningEnvelope('只是聊两句，没有标记。');
  assert.deepEqual(empty.increments, [], '没有标记就没有增量——跳过不制造升级');

  const malformed = fakeLearningEnvelope('LEARNING: EXPOSE | 只有两段');
  assert.deepEqual(malformed.increments, [], '字段数不对的标记被忽略，不猜');
});
