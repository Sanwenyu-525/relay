import assert from 'node:assert/strict';
import test from 'node:test';

import type { JsonObject } from '../../src/infrastructure/json.js';
import { CANDIDATE_OUTPUT_SCHEMA } from '../../src/workflow/markdown-deliverable.js';
import { OpenAiCompatibleModelPort } from '../../src/workflow/openai-compatible-model-port.js';
import type { ModelPortConfig } from '../../src/workflow/model-port-config.js';
import { buildFreePriceGuard, FreeCallGuardError, withProviderGuard }
  from '../../src/workflow/free-call-guard.js';
import type { FrozenModelConstraint } from '../../src/workflow/frozen-model-constraint.js';

// 与真实端口单测同一 harness：经完整 ChatOpenAI SDK 与 guardedModelFetch，最后用注入的 fetch
// 捕获「即将发出」的最终 HTTP body，证明免费硬限制到达外呼边界，而不只是内部参数（FM-07）。

const config: ModelPortConfig = {
  provider: 'openai-compatible', model: 'free/model-x', apiKey: 'fixture-key',
  baseUrl: 'https://models.vendor.com/v1', timeoutMs: 1_000,
  maxOutputTokens: 256, maxCallTokens: 4_096, maxScopeCalls: 32, maxScopeTokens: 262_144,
};
const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];

function event(content: string | null, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk',
    created: 1, model: 'free/model-x',
    choices: content === null ? [] : [{ index: 0, delta: { role: 'assistant', content },
      finish_reason: finishReason }] })}\n\n`;
}

function response(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

const freeConstraint: FrozenModelConstraint = {
  connection: { provider: 'openai-compatible', model: 'free/model-x',
    configFingerprint: 'c'.repeat(64) },
  freeOnly: true,
  catalogBasis: { source: 'openrouter', snapshotSeq: '4', sourceModelId: 'free/model-x' },
};

// 记录每次调用的最终 body，按调用顺序取用。
function recordingPort(bodies: JsonObject[], guard?: ReturnType<typeof buildFreePriceGuard>):
  OpenAiCompatibleModelPort {
  return new OpenAiCompatibleModelPort(config, {
    lookup: publicLookup,
    fetch: async (_input, init) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as JsonObject);
      return response([event('ok', 'stop'), 'data: [DONE]\n\n']);
    },
  }, guard);
}

const DRAFT_TOOLS = [{ name: 'search_text', description: '搜索受管根内文本',
  parameters: { type: 'object', properties: { query: { type: 'string' } },
    required: ['query'], additionalProperties: false } }] as const;

test('免费选择：最终外呼 body 附绝对零价硬限制并保留确切模型，绝不落到 openrouter/free', async () => {
  const bodies: JsonObject[] = [];
  const model = recordingPort(bodies, buildFreePriceGuard(freeConstraint));
  const result = await model.generate({ manifest: { task: { title: '免费目录取证' },
    contract: { objective: '证明零价硬限制到达外呼边界' } },
    outputSchema: CANDIDATE_OUTPUT_SCHEMA });
  assert.equal(result.kind, 'CONTENT');
  assert.equal(bodies.length, 1);
  const body = bodies[0]!;
  const provider = body.provider as JsonObject;
  assert.deepEqual(provider.max_price, { prompt: 0, completion: 0, request: 0, image: 0 });
  assert.equal(provider.allow_fallbacks, false);
  assert.equal(provider.require_parameters, true);
  // 具体免费型号：model 仍是冻结的确切 ID，不是随机路由。
  assert.equal(body.model, 'free/model-x');
  assert.ok(!JSON.stringify(body).includes('openrouter/free'));
});

test('非免费连接（原默认）：最终外呼 body 不注入任何 provider 路由，不受目录影响', async () => {
  const bodies: JsonObject[] = [];
  // 无 guard（buildFreePriceGuard 对非免费约束返回 undefined，端口不包裹）。
  const model = recordingPort(bodies, buildFreePriceGuard(
    { ...freeConstraint, freeOnly: false }));
  assert.equal(buildFreePriceGuard({ ...freeConstraint, freeOnly: false }), undefined);
  await model.generate({ manifest: { task: { title: '原默认' } },
    outputSchema: CANDIDATE_OUTPUT_SCHEMA });
  const body = bodies[0]!;
  assert.equal(Object.hasOwn(body, 'provider'), false);
  assert.equal(body.model, 'free/model-x');
});

test('免费硬限制跨续轮与工具轮次仍逐次携带', async () => {
  const bodies: JsonObject[] = [];
  // 逐轮工具脚本需要端口在两轮都注入；用 assist 带一轮历史工具轮次触发第二次外呼。
  const model = new OpenAiCompatibleModelPort(config, {
    lookup: publicLookup,
    fetch: async (_input, init) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as JsonObject);
      return response([event('已找到结果。', 'stop'), 'data: [DONE]\n\n']);
    },
  }, buildFreePriceGuard(freeConstraint));
  await model.assist({ intent: 'DISCUSS', system: '带工具历史',
    turns: [{ role: 'user', content: '查找' }], tools: DRAFT_TOOLS,
    toolTurns: [{ calls: [{ providerToolCallId: 't1', name: 'search_text',
      arguments: { query: 'Relay' } }],
    results: [{ providerToolCallId: 't1', name: 'search_text', content: '{"count":1}',
      isError: false }] }] });
  assert.equal(bodies.length, 1);
  const provider = bodies[0]!.provider as JsonObject;
  assert.deepEqual(provider.max_price, { prompt: 0, completion: 0, request: 0, image: 0 });
});

test('reasoning 续轮（请求局部重建客户端）同样携带免费硬限制', async () => {
  const bodies: JsonObject[] = [];
  const reasoningChunk = (text: string): string => `data: ${JSON.stringify({
    id: 'chatcmpl-r', object: 'chat.completion.chunk', created: 1, model: 'free/model-x',
    choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: text },
      finish_reason: null }] })}\n\n`;
  const model = new OpenAiCompatibleModelPort(config, {
    lookup: publicLookup,
    fetch: async (_input, init) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as JsonObject);
      return response([reasoningChunk('先读取实际文件。'), event('已完成。', 'stop'),
        'data: [DONE]\n\n']);
    },
  }, buildFreePriceGuard(freeConstraint));
  // 首轮返回纯文本但带 reasoning_content，端口不重建；直接断言本轮 body 带硬限制。
  const result = await model.assist({ intent: 'DISCUSS', system: '推理续轮',
    turns: [{ role: 'user', content: 'x' }] });
  assert.equal(result.kind, 'CONTENT');
  const provider = bodies[0]!.provider as JsonObject;
  assert.deepEqual(provider.max_price, { prompt: 0, completion: 0, request: 0, image: 0 });
});

test('freeOnly guard 对缺失、非法或非模型请求体 fail closed，不发出无约束请求', async () => {
  let outbound = 0;
  const guarded = withProviderGuard(async () => {
    outbound += 1;
    return new Response('unexpected');
  }, buildFreePriceGuard(freeConstraint)!);
  for (const init of [undefined, { body: 'not json' }, { body: '[]' },
    { body: '{"messages":[]}' }]) {
    await assert.rejects(() => guarded('https://openrouter.ai/api/v1/chat/completions', init),
      FreeCallGuardError);
  }
  assert.equal(outbound, 0);
});
