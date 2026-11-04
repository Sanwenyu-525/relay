import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assistGenerationProgressDto,
  projectAssistGenerationProgress,
  type AssistGenerationCallRow,
} from '../../src/application/assist-generation-progress.js';

/** 固定时刻，避免用例依赖墙钟；顺序关系由 T0 → T3 明确表达。 */
const T0 = new Date('2026-11-01T07:00:00.000Z');
const T1 = new Date('2026-11-01T07:00:02.000Z');
const T2 = new Date('2026-11-01T07:00:03.500Z');
const T3 = new Date('2026-11-01T07:00:05.000Z');

function call(patch: Partial<AssistGenerationCallRow> = {}): AssistGenerationCallRow {
  return {
    assist_message_id: 'm-1',
    status: 'STARTED',
    started_at: T0,
    first_stream_event_at: null,
    first_text_delta_at: null,
    first_preview_persisted_at: null,
    settled_at: null,
    ...patch,
  };
}

test('没有任何调用时，阶段是准备上下文而不是等待模型', () => {
  const progress = projectAssistGenerationProgress([]);
  assert.equal(progress.phase, 'PREPARING_CONTEXT');
  assert.equal(progress.callCount, 0);
  assert.equal(progress.latestCall, null);
});

test('请求已登记但未收到任何流事件 → 等待模型响应', () => {
  const progress = projectAssistGenerationProgress([call()]);
  assert.equal(progress.phase, 'WAITING_MODEL');
  assert.equal(progress.callCount, 1);
  assert.equal(progress.latestCall?.startedAt.toISOString(), T0.toISOString());
});

test('只收到流事件（reasoning 或工具参数）而正文尚未到达 → 模型已响应，等待正文', () => {
  const progress = projectAssistGenerationProgress([call({ first_stream_event_at: T1 })]);
  assert.equal(progress.phase, 'MODEL_STREAMING');
  assert.equal(progress.latestCall?.firstTextDeltaAt, null);
});

test('首个正文增量已到 → 已收到模型输出（预览仍可能为空）', () => {
  const progress = projectAssistGenerationProgress([call({
    first_stream_event_at: T1,
    first_text_delta_at: T2,
    first_preview_persisted_at: T3,
  })]);
  assert.equal(progress.phase, 'MODEL_OUTPUT');
});

test('最新调用已结算而消息仍 RUNNING → 正在处理模型返回结果', () => {
  const progress = projectAssistGenerationProgress([call({
    status: 'COMPLETED',
    first_stream_event_at: T1,
    first_text_delta_at: T2,
    settled_at: T3,
  })]);
  assert.equal(progress.phase, 'PROCESSING');
  assert.equal(progress.latestCall?.settledAt?.toISOString(), T3.toISOString());
});

test('工具续轮时只看最新一次调用，次数照实累计', () => {
  const progress = projectAssistGenerationProgress([
    call({ status: 'COMPLETED', first_stream_event_at: T0,
      first_text_delta_at: T0, settled_at: T0 }),
    call({ started_at: T1 }),
  ]);
  assert.equal(progress.phase, 'WAITING_MODEL');
  assert.equal(progress.callCount, 2);
  assert.equal(progress.latestCall?.status, 'STARTED');
});

test('没有调用时 DTO 也合法：call_count=0 且 latest_call=null', () => {
  const dto = assistGenerationProgressDto(projectAssistGenerationProgress([]));
  assert.deepEqual(dto, {
    phase: 'PREPARING_CONTEXT',
    call_count: 0,
    latest_call: null,
  });
});

test('已结算的失败与取消同样落到处理结果阶段', () => {
  for (const status of ['FAILED', 'CANCELLED'] as const) {
    const progress = projectAssistGenerationProgress([call({ status,
      first_stream_event_at: T1, settled_at: T3 })]);
    assert.equal(progress.phase, 'PROCESSING');
    assert.equal(progress.latestCall?.status, status);
  }
});

test('DTO 逐字转 ISO，缺失时间保持 null', () => {
  const dto = assistGenerationProgressDto(projectAssistGenerationProgress([call({
    first_stream_event_at: T1,
  })]));
  assert.equal(dto.phase, 'MODEL_STREAMING');
  assert.equal(dto.call_count, 1);
  assert.deepEqual(dto.latest_call, {
    status: 'STARTED',
    started_at: T0.toISOString(),
    first_stream_event_at: T1.toISOString(),
    first_text_delta_at: null,
    first_preview_persisted_at: null,
    settled_at: null,
  });
});
