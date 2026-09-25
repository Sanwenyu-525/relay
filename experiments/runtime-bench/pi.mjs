import { agentLoop } from '@earendil-works/pi-agent-core';
import { EventStream } from '@earendil-works/pi-ai';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const model = {
  id: 'fixture', name: 'fixture', api: 'openai-responses', provider: 'openai',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192, maxTokens: 128,
};

export async function run({ delay = 0, denied = false, unknown = false,
  toolDelay = 0, signal, toolName = 'gateway', toolArgs = { text: 'fixture' } } = {}) {
  let calls = 0;
  let effects = 0;
  const streamFn = (_model, _context, options) => {
    const stream = new EventStream(e => ['done', 'error'].includes(e.type),
      e => e.type === 'done' ? e.message : e.error);
    const respond = () => {
      calls++;
      const aborted = options?.signal?.aborted;
      const content = calls === 1
        ? [{ type: 'toolCall', id: 'call-1', name: toolName, arguments: toolArgs }]
        : [{ type: 'text', text: '# Result\n\nfixture' }];
      const message = { role: 'assistant', content: aborted ? [] : content,
        api: model.api, provider: model.provider, model: model.id,
        stopReason: aborted ? 'aborted' : calls === 1 ? 'toolUse' : 'stop',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now() };
      stream.push(aborted ? { type: 'error', reason: 'aborted', error: message }
        : { type: 'done', reason: message.stopReason, message });
    };
    delay ? setTimeout(respond, delay) : queueMicrotask(respond);
    return stream;
  };
  const tools = [{ name: 'gateway', label: 'Controlled tool', description: 'Fixture only',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async () => {
      if (toolDelay) await new Promise(resolve => setTimeout(resolve, toolDelay));
      effects++;
      return { content: [{ type: 'text', text: unknown ? 'UNKNOWN' : 'fixture' }],
        details: { outcome: unknown ? 'UNKNOWN' : 'SUCCEEDED' }, terminate: unknown };
    } }];
  const context = { messages: [], tools };
  const config = { model, convertToLlm: m => m, toolExecution: 'sequential',
    beforeToolCall: async () => denied ? { block: true, reason: 'DENIED', terminate: true } : undefined,
    shouldStopAfterTurn: () => calls >= 2 };
  const stream = agentLoop([{ role: 'user', content: 'fixture', timestamp: Date.now() }],
    context, config, signal, streamFn);
  const messages = await stream.result();
  return { calls, effects, messages };
}

const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

async function bench() {
  for (let i = 0; i < 20; i++) await run();
  const samples = [];
  for (let i = 0; i < 200; i++) {
    const start = performance.now();
    const result = await run();
    if (result.calls !== 2 || result.effects !== 1) throw new Error('Incorrect workload');
    samples.push(performance.now() - start);
  }
  const start = performance.now();
  for (let batch = 0; batch < 10; batch++) {
    await Promise.all(Array.from({ length: 16 }, () => run({ toolDelay: 5 })));
  }
  return { runtime: 'pi', sequential_p50_ms: percentile(samples, .5),
    sequential_p95_ms: percentile(samples, .95),
    concurrency: 16, concurrent_runs_per_second: 160000 / (performance.now() - start),
    rss_bytes: process.memoryUsage().rss, iterations: 200, simulated_io_ms: 5,
    persistence: 'none' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify({ ready: true, pid: process.pid }));
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    if (line === 'run') console.log(JSON.stringify(await bench()));
    input.close();
    break;
  }
}
