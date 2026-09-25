import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { streamText, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { modelFailure, relayBoundaryTools, toCandidateOrRejection, writeArtifactInputSchema } from './boundary.js';

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const validInput = {
  target: 'artifacts/candidate.md',
  content: '# Candidate\n',
};

async function consume(result: { stream: AsyncIterable<unknown> }) {
  const parts: unknown[] = [];
  for await (const part of result.stream) {
    parts.push(part);
  }
  return parts;
}

async function httpValidationStatus(payload: unknown): Promise<number> {
  const app = Fastify({
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
      },
    },
  });
  app.post('/candidate', { schema: { body: writeArtifactInputSchema } }, async () => ({ accepted: true }));
  await app.ready();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/candidate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
    return response.statusCode;
  } finally {
    await app.close();
  }
}

async function sdkOutcomeForJson(payload: unknown) {
  const result = streamText({
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: 'tool-call' as const, toolCallId: 'call-shared-schema', toolName: 'write_artifact', input: JSON.stringify(payload) },
            { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage },
          ],
        }),
      }),
    }),
    tools: relayBoundaryTools,
    prompt: 'Create a candidate artifact.',
    streamRetries: 0,
    onError: () => {},
  });
  await consume(result);
  return toCandidateOrRejection({
    toolCalls: await result.toolCalls,
    responseMessages: [],
    response: {},
    provider: 'mock-provider',
    modelId: 'mock-model-id',
  });
}

test('同一 TypeBox schema 经 Fastify 和 AI SDK 实际校验时对未知字段与类型强制转换一致拒绝', async () => {
  const fixtures: readonly { expectedHttp: number; name: string; payload: unknown; accepted: boolean }[] = [
    { name: '合法输入', payload: validInput, expectedHttp: 200, accepted: true },
    { name: '缺少 content', payload: { target: validInput.target }, expectedHttp: 400, accepted: false },
    { name: '未知字段', payload: { ...validInput, ignoredBySomeValidators: true }, expectedHttp: 400, accepted: false },
    { name: '数字 content 不得被 HTTP 强制为字符串', payload: { target: validInput.target, content: 42 }, expectedHttp: 400, accepted: false },
  ];

  for (const fixture of fixtures) {
    const [httpStatus, sdkOutcome] = await Promise.all([
      httpValidationStatus(fixture.payload),
      sdkOutcomeForJson(fixture.payload),
    ]);
    assert.equal(httpStatus, fixture.expectedHttp, fixture.name);
    assert.equal(sdkOutcome.kind === 'candidate', fixture.accepted, fixture.name);
  }
  assert.equal('execute' in relayBoundaryTools.write_artifact, false);
});

test('真实 AI SDK 流同时给出文本、完整参数和可 JSON 往返的候选，且没有自动 execute', async () => {
  const model = new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-ai-sdk-p00',
    doStream: async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: null,
        chunkDelayInMs: null,
        chunks: [
          {
            type: 'response-metadata' as const,
            id: 'response-ai-sdk-p00',
            modelId: 'mock-ai-sdk-p00',
            timestamp: new Date('2026-09-20T00:00:00.000Z'),
          },
          { type: 'text-start' as const, id: 'text-1' },
          { type: 'text-delta' as const, id: 'text-1', delta: '候选已经生成。' },
          { type: 'text-end' as const, id: 'text-1' },
          { type: 'tool-input-start' as const, id: 'call-ai-sdk-p00', toolName: 'write_artifact' },
          { type: 'tool-input-delta' as const, id: 'call-ai-sdk-p00', delta: '{"target":"artifacts/' },
          { type: 'tool-input-delta' as const, id: 'call-ai-sdk-p00', delta: 'candidate.md","content":"# Candidate\\n"}' },
          { type: 'tool-input-end' as const, id: 'call-ai-sdk-p00' },
          {
            type: 'tool-call' as const,
            toolCallId: 'call-ai-sdk-p00',
            toolName: 'write_artifact',
            input: JSON.stringify(validInput),
          },
          { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage },
        ],
      }),
    }),
  });
  const result = streamText({
    model,
    tools: relayBoundaryTools,
    toolChoice: { type: 'tool', toolName: 'write_artifact' },
    prompt: 'Create a candidate artifact.',
    streamRetries: 0,
  });

  const parts = await consume(result);
  assert.equal(await result.text, '候选已经生成。');
  assert.ok(parts.some(part => (part as { type?: string }).type === 'tool-input-delta'));
  assert.equal('execute' in relayBoundaryTools.write_artifact, false);

  const outcome = toCandidateOrRejection({
    toolCalls: await result.toolCalls,
    responseMessages: await result.responseMessages,
    response: await result.response,
    provider: model.provider,
    modelId: model.modelId,
  });

  assert.equal(outcome.kind, 'candidate');
  if (outcome.kind !== 'candidate') {
    throw new Error('expected candidate');
  }
  assert.equal(outcome.candidate.response.id, 'response-ai-sdk-p00');
  assert.equal(outcome.candidate.toolCall.id, 'call-ai-sdk-p00');
  assert.deepEqual(outcome.candidate.toolCall.input, validInput);
  assert.ok(JSON.stringify(outcome.candidate.responseMessages).includes('call-ai-sdk-p00'));
  assert.deepEqual(
    JSON.parse(JSON.stringify(outcome.candidate)),
    outcome.candidate,
  );
});

test('非法 JSON 参数被 AI SDK 标为无效，边界不产生候选', async () => {
  const result = streamText({
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: 'tool-call' as const, toolCallId: 'call-invalid-json', toolName: 'write_artifact', input: '{"target":' },
            { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage },
          ],
        }),
      }),
    }),
    tools: relayBoundaryTools,
    prompt: 'Create a candidate artifact.',
    streamRetries: 0,
    onError: () => {},
  });

  await consume(result);
  const toolCalls = await result.toolCalls;
  assert.equal((toolCalls[0] as { invalid?: boolean }).invalid, true);
  assert.deepEqual(
    toCandidateOrRejection({ toolCalls, responseMessages: [], response: {}, provider: 'mock-provider', modelId: 'mock-model-id' }),
    { kind: 'rejected', reason: 'invalid_tool_input' },
  );
});

test('JSON 合法但缺字段且含额外字段时，AI SDK 的 TypeBox 校验不产生候选', async () => {
  const result = streamText({
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            {
              type: 'tool-call' as const,
              toolCallId: 'call-invalid-schema',
              toolName: 'write_artifact',
              input: '{"target":"artifacts/candidate.md","unexpected":true}',
            },
            { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage },
          ],
        }),
      }),
    }),
    tools: relayBoundaryTools,
    prompt: 'Create a candidate artifact.',
    streamRetries: 0,
  });

  await consume(result);
  const toolCalls = await result.toolCalls;
  assert.equal((toolCalls[0] as { invalid?: boolean }).invalid, true);
  assert.deepEqual(
    toCandidateOrRejection({ toolCalls, responseMessages: [], response: {}, provider: 'mock-provider', modelId: 'mock-model-id' }),
    { kind: 'rejected', reason: 'invalid_tool_input' },
  );
});

test('本实验只接受一个完整候选，多个合法调用明确拒绝', async () => {
  const result = streamText({
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: 'tool-call' as const, toolCallId: 'call-first', toolName: 'write_artifact', input: JSON.stringify(validInput) },
            { type: 'tool-call' as const, toolCallId: 'call-second', toolName: 'write_artifact', input: JSON.stringify(validInput) },
            { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage },
          ],
        }),
      }),
    }),
    tools: relayBoundaryTools,
    prompt: 'Create a candidate artifact.',
    streamRetries: 0,
  });

  await consume(result);
  assert.deepEqual(
    toCandidateOrRejection({ toolCalls: await result.toolCalls, responseMessages: [], response: {}, provider: 'mock-provider', modelId: 'mock-model-id' }),
    { kind: 'rejected', reason: 'multiple_tool_calls' },
  );
});

test('截断的工具参数只有增量、没有完整 tool-call，边界不产生候选', async () => {
  const result = streamText({
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: 'tool-input-start' as const, id: 'call-truncated', toolName: 'write_artifact' },
            { type: 'tool-input-delta' as const, id: 'call-truncated', delta: '{"target":"artifacts/' },
            { type: 'error' as const, error: new Error('connection lost') },
          ],
        }),
      }),
    }),
    tools: relayBoundaryTools,
    prompt: 'Create a candidate artifact.',
    streamRetries: 0,
    onError: () => {},
  });

  const parts = await consume(result);
  assert.ok(parts.some(part => (part as { type?: string }).type === 'tool-input-delta'));
  assert.equal(parts.some(part => (part as { type?: string }).type === 'tool-call'), false);
  assert.deepEqual(
    toCandidateOrRejection({ toolCalls: await result.toolCalls, responseMessages: [], response: {}, provider: 'mock-provider', modelId: 'mock-model-id' }),
    { kind: 'rejected', reason: 'incomplete_tool_input' },
  );
});

test('Provider 错误映射为有界失败且没有候选', async () => {
  const result = streamText({
    model: new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('provider unavailable');
      },
    }),
    tools: relayBoundaryTools,
    prompt: 'Create a candidate artifact.',
    streamRetries: 0,
    onError: () => {},
  });

  const parts = await consume(result);
  const error = (parts.find(part => (part as { type?: string }).type === 'error') as { error: unknown }).error;
  assert.deepEqual(modelFailure(error, false), { kind: 'model_failure', reason: 'stream_error', message: 'provider unavailable' });
});

test('取消信号到达 SDK 模型边界并映射为有界失败', { timeout: 1_000 }, async () => {
  const abortController = new AbortController();
  let observedAbort = false;
  let abortHandled = false;
  let cancellationError: Error | undefined;
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => {
    resolveStarted = resolve;
  });
  const result = streamText({
    model: new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        observedAbort = abortSignal !== undefined;
        resolveStarted?.();
        const error = new Error('request cancelled');
        error.name = 'AbortError';
        cancellationError = error;
        return {
          stream: new ReadableStream({
            start(controller) {
              abortSignal?.addEventListener(
                'abort',
                () => {
                  abortHandled = true;
                  controller.error(error);
                },
                { once: true },
              );
            },
          }),
        };
      },
    }),
    tools: relayBoundaryTools,
    prompt: 'Create a candidate artifact.',
    abortSignal: abortController.signal,
    streamRetries: 0,
    onError: () => {},
  });

  const consuming = consume(result);
  await started;
  abortController.abort();
  const parts = await consuming;
  assert.equal(observedAbort, true);
  assert.equal(abortHandled, true);
  assert.equal(parts.some(part => (part as { type?: string }).type === 'tool-call'), false);
  assert.deepEqual(modelFailure(cancellationError, abortController.signal.aborted), { kind: 'model_failure', reason: 'cancelled', message: 'request cancelled' });
});
