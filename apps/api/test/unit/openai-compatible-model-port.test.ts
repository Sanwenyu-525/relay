import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessageChunk } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';

import { FIRST_PARTY_REGISTRY } from '../../src/skills/first-party-registry.js';
import type { AssistRequest } from '../../src/workflow/fake-model-port.js';
import { CANDIDATE_OUTPUT_SCHEMA } from '../../src/workflow/markdown-deliverable.js';
import { OpenAiCompatibleModelPort, ModelCallBudgetError, ModelOutputBudgetError,
  ModelTimeoutError,
  ModelSourcePolicyError, ModelToolOutputError, SemanticResponseError }
  from '../../src/workflow/openai-compatible-model-port.js';
import type { ModelPortConfig } from '../../src/workflow/model-port-config.js';

const config: ModelPortConfig = {
  provider: 'openai-compatible', model: 'fixture-model', apiKey: 'fixture-key',
  baseUrl: 'https://models.vendor.com/v1', timeoutMs: 1_000,
  maxOutputTokens: 256, maxCallTokens: 4_096,
  maxScopeCalls: 32, maxScopeTokens: 262_144,
};
const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];

function event(content: string | null, finishReason: string | null = null,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): string {
  return `data: ${JSON.stringify({ id: 'chatcmpl-fixture',
    object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
    choices: content === null ? [] : [{ index: 0, delta: { role: 'assistant', content },
      finish_reason: finishReason }], ...(usage === undefined ? {} : { usage }) })}\n\n`;
}

function response(chunks: readonly string[], signal?: AbortSignal,
  finish: 'CLOSE' | 'STALL' | 'ERROR' = 'CLOSE'): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (finish === 'CLOSE') controller.close();
      if (finish === 'ERROR') controller.error(new Error('fixture stream broke'));
      if (finish === 'STALL') signal?.addEventListener('abort', () =>
        controller.error(new DOMException('aborted', 'AbortError')), { once: true });
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

function port(handler: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Response,
  overrides: Partial<ModelPortConfig> = {}): OpenAiCompatibleModelPort {
  return new OpenAiCompatibleModelPort({ ...config, ...overrides }, {
    lookup: publicLookup,
    fetch: async (input, init) => handler(input, init),
  });
}

function toolEvent(content = '',
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): string {
  return `data: ${JSON.stringify({ id: 'chatcmpl-tool-fixture',
    object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
    choices: [{ index: 0, delta: { role: 'assistant', content,
      tool_calls: [{ index: 0, id: 'fixture-tool', type: 'function',
        function: { name: 'write_file', arguments: '{"path":"synthetic.txt"}' } }] },
      finish_reason: 'tool_calls' }], ...(usage === undefined ? {} : { usage }) })}\n\n`;
}

for (const scenario of [
  { name: 'same-chunk wire usage is not guessed', chunks: [toolEvent('must not publish',
    { prompt_tokens: 41, completion_tokens: 9, total_tokens: 50 })],
  usage: { inputTokens: null, outputTokens: null }, deltas: [] },
  { name: 'prior empty and usage frames', chunks: [event(''),
    event(null, null, { prompt_tokens: 43, completion_tokens: 8, total_tokens: 51 }), toolEvent()],
  usage: { inputTokens: null, outputTokens: null }, deltas: [] },
  { name: 'partial text before tool refusal', chunks: [event('partial synthetic reply'),
    event(null, null, { prompt_tokens: 43, completion_tokens: 8, total_tokens: 51 }), toolEvent()],
  usage: { inputTokens: null, outputTokens: null }, deltas: ['partial synthetic reply'] },
  { name: 'unknown usage stays null', chunks: [toolEvent()],
  usage: { inputTokens: null, outputTokens: null }, deltas: [] },
]) {
  test(`tool refusal preserves request metadata: ${scenario.name}`, async () => {
    let calls = 0;
    const model = port(() => {
      calls += 1;
      return response([...scenario.chunks, 'data: [DONE]\n\n']);
    });
    const deltas: string[] = [];
    await assert.rejects(() => model.assist({ intent: 'DISCUSS', system: 'synthetic only',
      turns: [{ role: 'user', content: 'reply' }],
      onTextDelta: async (text) => { deltas.push(text); } }), (error) => {
      assert.ok(error instanceof ModelToolOutputError);
      assert.ok('providerRequestId' in error && 'usage' in error);
      assert.equal(error.providerRequestId, 'chatcmpl-tool-fixture');
      assert.deepEqual(error.usage, scenario.usage);
      assert.ok(!JSON.stringify(error).includes('synthetic.txt'), 'tool arguments entered error evidence');
      return true;
    });
    assert.deepEqual(deltas, scenario.deltas);
    assert.equal(calls, 1);
  });
}

for (const scenario of ['prior usage', 'same-chunk usage', 'empty request ID', 'non-text content'] as const) {
  test(`tool refusal retains normalized SDK metadata: ${scenario}`, async (t) => {
    // Explicit SDK chunk seam: current SSE conversion emits usage only at stream end.
    // This checks metadata already observed, not unread wire usage or real billing.
    t.mock.method(ChatOpenAI.prototype, 'stream', async () => (async function* () {
      if (scenario === 'prior usage') {
        yield Object.assign(new AIMessageChunk({ content: '', id: 'chatcmpl-known-usage' }), {
          usage_metadata: { input_tokens: 43, output_tokens: 8, total_tokens: 51 } });
      }
      if (scenario === 'non-text content') {
        yield new AIMessageChunk({ id: 'chatcmpl-known-usage',
          content: [{ type: 'image_url', image_url: { url: 'https://synthetic.invalid/image.png' } }] });
        return;
      }
      const tool = new AIMessageChunk({ content: 'must not publish',
        id: scenario === 'empty request ID' ? '' : 'chatcmpl-known-usage',
        tool_call_chunks: [{ name: 'write_file', args: '{"path":"synthetic.txt"}',
          id: 'fixture-tool', index: 0, type: 'tool_call_chunk' }] });
      yield scenario === 'same-chunk usage' ? Object.assign(tool, {
        usage_metadata: { input_tokens: 43, output_tokens: 8, total_tokens: 51 } }) : tool;
    })());
    const model = port(() => { throw new Error('controlled SDK chunks must not call transport'); });
    const deltas: string[] = [];
    await assert.rejects(() => model.assist({ intent: 'DISCUSS', system: 'synthetic',
      turns: [{ role: 'user', content: 'reply' }],
      onTextDelta: async (text) => { deltas.push(text); } }), (error) => {
      assert.ok(error instanceof ModelToolOutputError);
      assert.equal(error.providerRequestId, scenario === 'empty request ID'
        ? undefined : 'chatcmpl-known-usage');
      assert.deepEqual(error.usage, scenario === 'prior usage' || scenario === 'same-chunk usage'
        ? { inputTokens: 43, outputTokens: 8 } : { inputTokens: null, outputTokens: null });
      assert.ok(!JSON.stringify(error).includes('synthetic.txt'));
      assert.ok(!JSON.stringify(error).includes('https://synthetic.invalid/image.png'));
      return true;
    });
    assert.deepEqual(deltas, []);
  });
}

test('streamed fragments settle only after DONE and preserve optional usage', async () => {
  let calls = 0;
  const model = port((_input, init) => {
    calls += 1;
    assert.equal(init?.redirect, 'error');
    return response([event('# Hello'), event('\n\n## 摘要\n内容'),
      event('\n\n## 结论\n完成', 'stop'),
      event(null, null, { prompt_tokens: 34, completion_tokens: 19, total_tokens: 53 }),
      'data: [DONE]\n\n']);
  });
  const result = await model.generate({ manifest: { task: { title: 'Hello' } },
    outputSchema: CANDIDATE_OUTPUT_SCHEMA });
  assert.equal(result.kind, 'CONTENT');
  if (result.kind === 'CONTENT') {
    assert.equal(result.content, '# Hello\n\n## 摘要\n内容\n\n## 结论\n完成');
    assert.deepEqual(result.usage, { inputTokens: 34, outputTokens: 19 });
    assert.equal(result.providerRequestId, 'chatcmpl-fixture');
  }
  assert.equal(calls, 1);
  const withoutUsage = port(() => response([event('ok', 'stop'), 'data: [DONE]\n\n']));
  const assist = await withoutUsage.assist({ intent: 'DISCUSS', system: 'say ok',
    turns: [{ role: 'user', content: 'ok' }] });
  assert.equal(assist.kind, 'CONTENT');
  if (assist.kind === 'CONTENT') {
    assert.deepEqual(assist.usage, { inputTokens: null, outputTokens: null });
  }
});

test('plain DISCUSS publishes a text delta before DONE while structured Assist stays private', async () => {
  const encoder = new TextEncoder();
  let finish!: () => void;
  let first!: () => void;
  const firstDelta = new Promise<void>((resolve) => { first = resolve; });
  const streaming = port(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(event('首段')));
      finish = () => {
        controller.enqueue(encoder.encode(event('后段', 'stop') + 'data: [DONE]\n\n'));
        controller.close();
      };
    },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  let settled = false;
  const invocation = streaming.assist({ intent: 'DISCUSS', system: 'reply',
    turns: [{ role: 'user', content: 'hello' }],
    onTextDelta: async (piece) => {
      assert.equal(settled, false);
      if (piece === '首段') first();
      else assert.equal(piece, '后段');
    } }).then((result) => { settled = true; return result; });
  const firstArrived = await Promise.race([firstDelta.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000))]);
  const settledBeforeDone = settled;
  finish();
  assert.equal(firstArrived, true);
  assert.equal(settledBeforeDone, false);
  const result = await invocation;
  assert.equal(result.kind, 'CONTENT');
  if (result.kind === 'CONTENT') assert.equal(result.content, '首段后段');

  let structuredDelta = false;
  const structured = port(() => response([event('{"summary":"ok"}', 'stop'),
    'data: [DONE]\n\n']));
  await structured.assist({ intent: 'PROPOSE_TASK', system: 'json',
    turns: [{ role: 'user', content: 'task' }],
    onTextDelta: async () => { structuredDelta = true; } });
  assert.equal(structuredDelta, false);
});

const assistResponseFormatCases: readonly {
  readonly name: string; readonly intent: AssistRequest['intent'];
  readonly skill?: AssistRequest['skill']; readonly structured: boolean;
}[] = [
  { name: 'ordinary DISCUSS', intent: 'DISCUSS', structured: false },
  ...([
    ['task-to-execution-contract', '1.1.0'],
    ['verification-plan', '1.1.0'],
    ['project-resume', '1.0.0'],
  ] as const).map(([id, version]) => {
    const frozen = FIRST_PARTY_REGISTRY.skill(id, version)!;
    return { name: `${frozen.id}@${frozen.version}`, intent: 'DISCUSS' as const,
      skill: { id: frozen.id, version: frozen.version, facts: { synthetic: true } },
      structured: true };
  }),
  { name: 'PROPOSE_TASK', intent: 'PROPOSE_TASK', structured: true },
];

for (const scenario of assistResponseFormatCases) {
  test(`Assist response format: ${scenario.name}`, async () => {
    let calls = 0;
    let requestBody: Record<string, unknown> | undefined;
    const pieces = scenario.structured ? ['{"summary":', '"synthetic"}']
      : ['synthetic ', 'reply'];
    const model = port((_input, init) => {
      calls += 1;
      assert.equal(typeof init?.body, 'string');
      requestBody = JSON.parse(init!.body as string) as Record<string, unknown>;
      return response([event(pieces[0]!), event(pieces[1]!, 'stop'),
        event(null, null, { prompt_tokens: 34, completion_tokens: 19, total_tokens: 53 }),
        'data: [DONE]\n\n']);
    });
    const deltas: string[] = [];
    const result = await model.assist({ intent: scenario.intent,
      system: 'synthetic only', turns: [{ role: 'user', content: 'reply' }],
      skill: scenario.skill, onTextDelta: async (text) => { deltas.push(text); } });
    assert.equal(calls, 1);
    assert.deepEqual(result, { kind: 'CONTENT', content: pieces.join(''),
      providerRequestId: 'chatcmpl-fixture',
      usage: { inputTokens: 34, outputTokens: 19 } });
    assert.deepEqual(deltas, scenario.structured ? [] : pieces);
    assert.ok(requestBody);
    if (scenario.structured) {
      assert.deepEqual(requestBody.response_format, { type: 'json_object' });
    } else {
      assert.equal(Object.hasOwn(requestBody, 'response_format'), false);
    }
  });
}

test('DRAFT publishes Markdown fragments before DONE but settles only the complete response', async () => {
  const encoder = new TextEncoder();
  let finish!: () => void;
  let first!: () => void;
  const firstDelta = new Promise<void>((resolve) => { first = resolve; });
  const streaming = port(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(event('# 草稿')));
      finish = () => {
        controller.enqueue(encoder.encode(event('\n\n完整结尾', 'stop') +
          'data: [DONE]\n\n'));
        controller.close();
      };
    },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  let settled = false;
  const seen: string[] = [];
  const invocation = streaming.generate({ manifest: { task: { title: '草稿' } },
    outputSchema: CANDIDATE_OUTPUT_SCHEMA,
    onTextDelta: async (piece) => { seen.push(piece); if (piece === '# 草稿') first(); },
  }).then((result) => { settled = true; return result; });
  const arrived = await Promise.race([firstDelta.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000))]);
  assert.equal(arrived, true);
  assert.equal(settled, false);
  finish();
  const result = await invocation;
  assert.equal(result.kind, 'CONTENT');
  if (result.kind === 'CONTENT') assert.equal(result.content, '# 草稿\n\n完整结尾');
  assert.deepEqual(seen, ['# 草稿', '\n\n完整结尾']);
});

test('semantic JSON is exact and invalid complete responses keep usage evidence', async () => {
  const valid = port(() => response([event('{"verdict":"PASS",'),
    event('"reason":"成立"}', 'stop'),
    event(null, null, { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 }),
    'data: [DONE]\n\n']));
  assert.deepEqual(await valid.evaluate({ statement: '有摘要', content: '有摘要' }), {
    verdict: 'PASS', reason: '成立', providerRequestId: 'chatcmpl-fixture',
    usage: { inputTokens: 10, outputTokens: 7 },
  });
  const invalid = port(() => response([event('prefix {"verdict":"PASS","reason":"x"}', 'stop'),
    event(null, null, { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 }),
    'data: [DONE]\n\n']));
  await assert.rejects(() => invalid.evaluate({ statement: 'x', content: 'y' }),
    (error) => error instanceof SemanticResponseError &&
      error.providerRequestId === 'chatcmpl-fixture' &&
      error.usage.inputTokens === 10);
});

test('cancel, timeout, broken stream and local call budget never return partial content', async () => {
  const controller = new AbortController();
  const cancelled = port((_input, init) => {
    setTimeout(() => controller.abort(), 20);
    return response([event('partial')], init?.signal ?? undefined, 'STALL');
  });
  assert.deepEqual(await cancelled.assist({ intent: 'DISCUSS', system: 'x',
    turns: [{ role: 'user', content: 'x' }], signal: controller.signal }),
  { kind: 'CANCELLED' });

  const timedOut = port((_input, init) => response([event('partial')],
    init?.signal ?? undefined, 'STALL'), { timeoutMs: 40 });
  await assert.rejects(() => timedOut.assist({ intent: 'DISCUSS', system: 'x',
    turns: [{ role: 'user', content: 'x' }] }), ModelTimeoutError);

  const broken = port(() => response([event('partial')], undefined, 'ERROR'));
  await assert.rejects(() => broken.assist({ intent: 'DISCUSS', system: 'x',
    turns: [{ role: 'user', content: 'x' }] }));

  const prematureEnd = port(() => response([event('partial')]));
  await assert.rejects(() => prematureEnd.assist({ intent: 'DISCUSS', system: 'x',
    turns: [{ role: 'user', content: 'x' }] }));

  let invoked = false;
  const budget = port(() => { invoked = true; throw new Error('must not call'); },
    { maxCallTokens: 256, maxOutputTokens: 256 });
  await assert.rejects(() => budget.assist({ intent: 'DISCUSS', system: 'x',
    turns: [{ role: 'user', content: 'x' }] }), ModelCallBudgetError);
  assert.equal(invoked, false);

  const exceededActual = port(() => response([event('complete', 'stop'),
    event(null, null, { prompt_tokens: 200, completion_tokens: 120,
      total_tokens: 320 }), 'data: [DONE]\n\n']),
  { maxCallTokens: 300, maxOutputTokens: 256 });
  await assert.rejects(() => exceededActual.assist({ intent: 'DISCUSS',
    system: 'x', turns: [{ role: 'user', content: 'x' }] }),
  (error) => error instanceof ModelCallBudgetError &&
    error.usage?.inputTokens === 200 && error.usage.outputTokens === 120);

  const oversized = port(() => response([event('x'.repeat(4_100), 'stop'),
    'data: [DONE]\n\n']));
  await assert.rejects(() => oversized.assist({ intent: 'DISCUSS',
    system: 'x', turns: [{ role: 'user', content: 'x' }] }),
  ModelOutputBudgetError);
  await assert.rejects(() => budget.generate({ outputSchema: CANDIDATE_OUTPUT_SCHEMA,
    manifest: { sources: [{ selection_reason: 'RECENT_SCOPE_FALLBACK',
      content: 'do not send' }] } }), ModelSourcePolicyError);
  assert.equal(invoked, false);
});
