import assert from 'node:assert/strict';
import test from 'node:test';

import type { JsonObject } from '../../src/infrastructure/json.js';
import type { AssistRequest, ModelToolSpec } from '../../src/workflow/fake-model-port.js';
import { AnthropicMessagesModelPort } from '../../src/workflow/anthropic-messages-model-port.js';
import { createModelPort } from '../../src/workflow/model-port-factory.js';
import { OpenAiCompatibleModelPort } from '../../src/workflow/openai-compatible-model-port.js';
import { ModelCallBudgetError, ModelCapabilityUnsupportedError, ModelOutputBudgetError,
  ModelToolOutputError } from '../../src/workflow/model-port-errors.js';
import { classifyProviderError } from '../../src/workflow/model-error-classification.js';
import type { ModelPortConfig } from '../../src/workflow/model-port-config.js';
import { CANDIDATE_OUTPUT_SCHEMA } from '../../src/workflow/markdown-deliverable.js';

/**
 * Anthropic Messages 端口的协议级测试。
 *
 * 这些用例只证明「端口发出的 HTTP 请求、读到的 SSE 事件与失败分类符合 Anthropic
 * Messages 的协议」，不证明任何真实 Provider 的账户、配额或模型可用性。
 */

const config: ModelPortConfig = {
  provider: 'anthropic-messages', protocol: 'anthropic-messages',
  model: 'claude-fixture', apiKey: 'fixture-anthropic-key',
  baseUrl: 'https://anthropic.vendor.com/v1', timeoutMs: 1_000,
  maxOutputTokens: 256, maxCallTokens: 4_096,
  maxScopeCalls: 32, maxScopeTokens: 262_144,
};
const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];

interface CapturedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

function sse(events: readonly { readonly event: string;
  readonly data: unknown }[], options: { readonly finish?: 'CLOSE' | 'TRUNCATE' } = {}): Response {
  const encoder = new TextEncoder();
  const text = events.map((entry) =>
    `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`).join('');
  const payload = options.finish === 'TRUNCATE'
    ? text.slice(0, Math.max(0, text.lastIndexOf('event: message_stop'))) : text;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json' } });
}

function port(handler: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Response,
  overrides: Partial<ModelPortConfig> = {}): {
  readonly port: AnthropicMessagesModelPort;
  readonly requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const created = new AnthropicMessagesModelPort({ ...config, ...overrides }, {
    lookup: publicLookup,
    fetch: async (input, init) => {
      requests.push({ url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return handler(input, init);
    },
  });
  return { port: created, requests };
}

const textStream = [
  { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_fixture',
    model: 'claude-fixture', usage: { input_tokens: 31, output_tokens: 1,
      cache_read_input_tokens: 7, cache_creation_input_tokens: 5 } } } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0,
    content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0,
    delta: { type: 'text_delta', text: '你好' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0,
    delta: { type: 'text_delta', text: '，世界' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'message_delta', data: { type: 'message_delta',
    delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
];

test('请求使用 Anthropic Messages 原生端点与认证头，不伪装成 Chat Completions', async () => {
  const { port: created, requests } = port(() => sse(textStream));
  const result = await created.assist({ intent: 'DISCUSS', system: '系统边界',
    turns: [{ role: 'user', content: '你好' }] });
  assert.equal(result.kind, 'CONTENT');
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  // 端点：/messages（不是 /chat/completions）。
  assert.equal(request.url, 'https://anthropic.vendor.com/v1/messages');
  // 认证：x-api-key + anthropic-version；不带 Bearer。
  assert.equal(request.headers.get('x-api-key'), 'fixture-anthropic-key');
  assert.equal(request.headers.get('anthropic-version'), '2023-06-01');
  assert.equal(request.headers.get('authorization'), null);
  // 请求体：system 顶层、max_tokens 必填、stream=true、没有 response_format。
  assert.equal(request.body.model, 'claude-fixture');
  assert.equal(request.body.system, '系统边界');
  assert.equal(request.body.max_tokens, 256);
  assert.equal(request.body.stream, true);
  assert.equal('response_format' in request.body, false);
  assert.deepEqual(request.body.messages, [{ role: 'user', content: '你好' }]);
});

test('流式正文、Provider 请求标识与缓存用量都进入既有运行时', async () => {
  const { port: created } = port(() => sse(textStream));
  const deltas: string[] = [];
  const result = await created.assist({ intent: 'DISCUSS', system: 's',
    turns: [{ role: 'user', content: 'hi' }],
    onTextDelta: async (text) => { deltas.push(text); } });
  assert.equal(result.kind, 'CONTENT');
  if (result.kind !== 'CONTENT') return;
  assert.equal(result.content, '你好，世界');
  assert.equal(result.providerRequestId, 'msg_fixture');
  assert.equal(result.usage.inputTokens, 31);
  assert.equal(result.usage.outputTokens, 12);
  assert.equal(result.usage.cacheReadTokens, 7);
  assert.equal(result.usage.cacheCreationTokens, 5);
  // 未提交的文本增量与最终正文一致；没有把工具轮次的正文提前发布。
  assert.deepEqual(deltas, ['你好', '，世界']);
});

const tools: readonly ModelToolSpec[] = [{ name: 'read_file',
  description: '读取文件', parameters: { type: 'object',
    properties: { path: { type: 'string' } }, required: ['path'] } as JsonObject }];

const toolStream = [
  { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_tool',
    usage: { input_tokens: 20, output_tokens: 1 } } } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id: 'toolu_fixture', name: 'read_file', input: {} } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"path":' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0,
    delta: { type: 'input_json_delta', partial_json: '"README.md"}' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'message_delta', data: { type: 'message_delta',
    delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
];

test('工具声明用 input_schema，流式参数增量只预览、完整参数才进入派发结果', async () => {
  const { port: created, requests } = port(() => sse(toolStream));
  const argumentDeltas: string[] = [];
  const result = await created.assist({ intent: 'DISCUSS', system: 's',
    turns: [{ role: 'user', content: '读 README' }], tools,
    onToolArgumentsDelta: async (delta) => { argumentDeltas.push(delta.argumentsText); } });
  assert.equal(result.kind, 'TOOL_CALLS');
  if (result.kind !== 'TOOL_CALLS') return;
  assert.deepEqual(result.calls, [{ providerToolCallId: 'toolu_fixture',
    name: 'read_file', arguments: { path: 'README.md' } }]);
  // 声明形状是 Anthropic 的 input_schema，不是 OpenAI 的 parameters。
  const declared = (requests[0]!.body.tools as Record<string, unknown>[])[0]!;
  assert.deepEqual(declared.input_schema, tools[0]!.parameters);
  assert.equal('parameters' in declared, false);
  // 只读预览拿到的是累计原文；半截内容不会被当成参数执行。
  assert.deepEqual(argumentDeltas, ['{"path":', '{"path":"README.md"}']);
});

test('历史上具轮次转成 assistant(tool_use) + user(tool_result)', async () => {
  const { port: created, requests } = port(() => sse(textStream));
  await created.assist({ intent: 'DISCUSS', system: 's',
    turns: [{ role: 'user', content: '继续' }],
    toolTurns: [{ calls: [{ providerToolCallId: 'toolu_prev', name: 'read_file',
      arguments: { path: 'a.txt' } }],
      results: [{ providerToolCallId: 'toolu_prev', name: 'read_file',
        content: '文件内容', isError: false }] }] });
  const messages = requests[0]!.body.messages as { role: string;
    content: unknown }[];
  assert.equal(messages.length, 3);
  assert.equal(messages[1]!.role, 'assistant');
  assert.deepEqual(messages[1]!.content, [{ type: 'tool_use', id: 'toolu_prev',
    name: 'read_file', input: { path: 'a.txt' } }]);
  assert.equal(messages[2]!.role, 'user');
  assert.deepEqual(messages[2]!.content, [{ type: 'tool_result',
    tool_use_id: 'toolu_prev', content: '文件内容' }]);
});

test('图片按 Anthropic 的 base64 source 发送', async () => {
  const { port: created, requests } = port(() => sse(textStream));
  await created.assist({ intent: 'DISCUSS', system: 's',
    turns: [{ role: 'user', content: '看图', parts: [
      { type: 'image', mediaType: 'image/png', dataBase64: 'aGVsbG8=' }] }] });
  assert.deepEqual((requests[0]!.body.messages as { content: unknown }[])[0]!.content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    { type: 'text', text: '看图' },
  ]);
});

test('任何依赖 response_format=json_object 的请求都在外呼之前明确拒绝', async () => {
  let calls = 0;
  const { port: created } = port(() => { calls += 1; return sse(textStream); });
  const structured: AssistRequest = { intent: 'PROPOSE_CANDIDATE', system: 's',
    turns: [{ role: 'user', content: 'x' }], responseFormat: 'json_object' };
  await assert.rejects(created.assist(structured),
    (error: unknown) => error instanceof ModelCapabilityUnsupportedError);
  await assert.rejects(created.interpret({ system: 's', userContent: 'x' }),
    (error: unknown) => error instanceof ModelCapabilityUnsupportedError);
  await assert.rejects(created.draftAssist({ operation: 'POLISH', text: 'x' }),
    (error: unknown) => error instanceof ModelCapabilityUnsupportedError);
  // 零外呼：拒绝发生在构造请求之前。
  assert.equal(calls, 0);
});

test('取消把 AbortSignal 交给传输层，返回 CANCELLED 而不是「空回复」', async () => {
  const controller = new AbortController();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(inner) {
      inner.enqueue(encoder.encode(`event: message_start\ndata: ${
        JSON.stringify({ type: 'message_start', message: { id: 'msg_abort',
          usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n`));
      controller.signal.addEventListener('abort', () =>
        inner.error(new DOMException('aborted', 'AbortError')), { once: true });
    },
  });
  const { port: created } = port(() => new Response(stream,
    { headers: { 'content-type': 'text/event-stream' } }));
  const pending = created.assist({ intent: 'DISCUSS', system: 's',
    turns: [{ role: 'user', content: 'x' }], signal: controller.signal });
  controller.abort();
  assert.equal((await pending).kind, 'CANCELLED');
});

test('HTTP 失败按既有词表分类，401 是 AUTH', async () => {
  const { port: created } = port(() => jsonResponse({ type: 'error', error: {
    type: 'authentication_error', message: 'invalid x-api-key' } }, 401));
  await assert.rejects(created.assist({ intent: 'DISCUSS', system: 's',
    turns: [{ role: 'user', content: 'x' }] }),
  (error: unknown) => {
    assert.equal(classifyProviderError(error), 'AUTH');
    assert.match(String((error as Error).message), /HTTP 401/);
    return true;
  });
});

test('stop_reason=max_tokens 按输出预算拒绝', async () => {
  const truncated = textStream.map((entry) => entry.event === 'message_delta'
    ? { event: entry.event, data: { type: 'message_delta',
      delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 256 } } }
    : entry);
  const { port: created } = port(() => sse(truncated));
  await assert.rejects(created.assist({ intent: 'DISCUSS', system: 's',
    turns: [{ role: 'user', content: 'x' }] }),
  (error: unknown) => error instanceof ModelOutputBudgetError);
});

test('缺少 message_stop 的「干净 EOF」按断流拒绝，不冒充完整回复', async () => {
  const { port: created } = port(() => sse(textStream, { finish: 'TRUNCATE' }));
  await assert.rejects(created.assist({ intent: 'DISCUSS', system: 's',
    turns: [{ role: 'user', content: 'x' }] }),
  (error: unknown) => classifyProviderError(error) === 'STREAM_BROKEN');
});

test('未声明的工具名按不支持的输出拒绝', async () => {
  const undeclared = toolStream.map((entry) => entry.event === 'content_block_start'
    ? { event: entry.event, data: { type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'toolu_x', name: 'delete_everything',
        input: {} } } }
    : entry);
  const { port: created } = port(() => sse(undeclared));
  await assert.rejects(created.assist({ intent: 'DISCUSS', system: 's',
    turns: [{ role: 'user', content: 'x' }], tools }),
  (error: unknown) => error instanceof ModelToolOutputError);
});

test('生成前预算闸门：输入估算 + 输出预留超过单次上限即拒绝，零外呼', async () => {
  let calls = 0;
  const { port: created } = port(() => { calls += 1; return sse(textStream); },
    { maxCallTokens: 1_024 });
  const huge = 'x'.repeat(4_000);
  await assert.rejects(created.generate({ manifest: { task: { title: huge },
    contract: { objective: huge } }, outputSchema: CANDIDATE_OUTPUT_SCHEMA }),
  (error: unknown) => error instanceof ModelCallBudgetError);
  assert.equal(calls, 0);
});

test('语义验收按提示词严格解析 JSON，不设置 response_format', async () => {
  const verdictStream = [
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_verdict',
      usage: { input_tokens: 8, output_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0,
      content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: '{"verdict":"PASS","reason":"覆盖目标"}' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta',
      delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
  const { port: created, requests } = port(() => sse(verdictStream));
  const verdict = await created.evaluate({ statement: '目标已覆盖', content: '正文' });
  assert.equal(verdict.verdict, 'PASS');
  assert.equal(verdict.reason, '覆盖目标');
  assert.equal('response_format' in requests[0]!.body, false);
});

test('端口工厂按显式协议分派，不按 URL 或型号猜', () => {
  assert.ok(createModelPort({ ...config }) instanceof AnthropicMessagesModelPort);
  assert.ok(createModelPort({ ...config, provider: 'openai-compatible',
    protocol: 'openai-compatible' }) instanceof OpenAiCompatibleModelPort);
  // 缺省 protocol 按历史语义为 OpenAI 兼容。
  assert.ok(createModelPort({ ...config, provider: 'openai-compatible',
    protocol: undefined }) instanceof OpenAiCompatibleModelPort);
});

test('Anthropic 端口拒绝被当作 OpenAI 兼容配置构造', () => {
  assert.throws(() => new AnthropicMessagesModelPort({ ...config,
    provider: 'openai-compatible', protocol: 'openai-compatible' }),
  /ANTHROPIC_PORT_REQUIRES_ANTHROPIC_PROTOCOL/u);
});
