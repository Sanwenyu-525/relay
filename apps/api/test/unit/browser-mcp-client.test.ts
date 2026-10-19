import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserBackendError, McpStdioClient } from '../../src/browser/mcp-client.js';

type Listener = (value: never) => void;

/** 受控 MCP 进程替身：把 stdin 的每一行交给 handler，由测试决定怎么回。 */
class FakeProcess {
  readonly writes: Record<string, unknown>[] = [];
  private stdoutListener: ((chunk: Buffer) => void) | null = null;
  private exitListener: ((code: number | null) => void) | null = null;
  killed = false;
  /** 收到 tools/call 时如何回应。 */
  onCall: (message: Record<string, unknown>) => void = (message) => {
    this.respond({ jsonrpc: '2.0', id: message.id, result: { content: [] } });
  };

  readonly stdin = {
    write: (data: string): unknown => {
      for (const line of data.split('\n')) {
        if (line.trim() === '') continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        this.writes.push(message);
        this.handle(message);
      }
      return undefined;
    },
    end: (): void => {},
  };

  readonly stdout = {
    on: (_event: 'data', listener: (chunk: Buffer) => void): unknown => {
      this.stdoutListener = listener;
      return undefined;
    },
  };

  readonly stderr = {
    on: (_event: 'data', _listener: (chunk: Buffer) => void): unknown => undefined,
  };

  on(event: 'error' | 'exit' | 'close', listener: Listener): unknown {
    if (event === 'exit') this.exitListener = listener as (code: number | null) => void;
    return undefined;
  }

  kill(): boolean {
    this.killed = true;
    this.exitListener?.(0);
    return true;
  }

  respond(message: Record<string, unknown>): void {
    this.stdoutListener?.(Buffer.from(`${JSON.stringify(message)}\n`, 'utf8'));
  }

  private handle(message: Record<string, unknown>): void {
    if (message.method === 'initialize') {
      this.respond({ jsonrpc: '2.0', id: message.id,
        result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '1.11.0' } } });
      return;
    }
    if (message.method === 'tools/list') {
      this.respond({ jsonrpc: '2.0', id: message.id, result: { tools: [
        { name: 'list_pages', description: '', inputSchema: {} },
        { name: 'click', description: '', inputSchema: {} },
      ] } });
      return;
    }
    if (message.method === 'tools/call') {
      this.onCall(message);
      return;
    }
    // notifications/initialized 与 notifications/cancelled 没有 id，不回。
  }
}

function makeClient(process: FakeProcess, options: { requestTimeoutMs?: number } = {}) {
  return new McpStdioClient({
    nodeExecutable: 'node', entry: 'entry.js', args: [], env: {},
    spawnProcess: () => process,
    ...(options.requestTimeoutMs === undefined
      ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });
}

test('MCP 握手：initialize 与 notifications/initialized 的顺序与形状', async () => {
  const process = new FakeProcess();
  const client = makeClient(process);
  const info = await client.start();
  assert.deepEqual(info, { name: 'fake', version: '1.11.0' });
  assert.equal(process.writes[0]?.method, 'initialize');
  const params = process.writes[0]?.params as Record<string, unknown>;
  assert.equal(params.protocolVersion, '2025-06-18');
  assert.deepEqual(params.clientInfo, { name: 'relay-agent', version: '0.1.0' });
  assert.equal(process.writes[1]?.method, 'notifications/initialized');
  client.dispose();
});

test('tools/list 与 tools/call：文本/图片/结构化结果都被保留', async () => {
  const process = new FakeProcess();
  const client = makeClient(process);
  await client.start();
  const tools = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['list_pages', 'click']);

  process.onCall = (message) => {
    process.respond({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text: 'Took a screenshot.' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' }],
      structuredContent: { pages: [{ id: 1, url: 'about:blank', title: '' }] },
    } });
  };
  const result = await client.callTool('take_screenshot', { pageId: 1 }, { mutating: false });
  assert.equal(result.text, 'Took a screenshot.');
  assert.equal(result.images[0]?.mimeType, 'image/png');
  assert.deepEqual(result.structured, { pages: [{ id: 1, url: 'about:blank', title: '' }] });
  assert.equal(result.isError, false);
  client.dispose();
});

test('上游 isError 原样带回，不抛出', async () => {
  const process = new FakeProcess();
  const client = makeClient(process);
  await client.start();
  process.onCall = (message) => {
    process.respond({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text: 'Element uid "9_9" not found on page 1.' }],
      isError: true,
    } });
  };
  const result = await client.callTool('click', { pageId: 1, uid: '9_9' }, { mutating: true });
  assert.equal(result.isError, true);
  assert.match(result.text, /not found/);
  client.dispose();
});

test('进程在请求中途退出：在途调用以断开失败且标记效果未知', async () => {
  const process = new FakeProcess();
  const client = makeClient(process);
  await client.start();
  process.onCall = () => { process.kill(); };
  await assert.rejects(
    client.callTool('click', { pageId: 1, uid: '1_4' }, { mutating: true }),
    (error: unknown) => error instanceof BrowserBackendError &&
      error.code === 'BROWSER_BACKEND_DISCONNECTED' && error.effectUncertain);
  assert.equal(client.alive, false);
});

test('取消：发出 notifications/cancelled 而不是杀进程，且按效果未知拒绝', async () => {
  const process = new FakeProcess();
  const client = makeClient(process);
  await client.start();
  process.onCall = () => { /* 永不回复，模拟慢动作 */ };
  const controller = new AbortController();
  const pending = client.callTool('click', { pageId: 1, uid: '1_4' },
    { mutating: true, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending,
    (error: unknown) => error instanceof BrowserBackendError &&
      error.code === 'BROWSER_USER_CANCELLED' && error.effectUncertain);
  const cancelled = process.writes.find((write) => write.method === 'notifications/cancelled');
  assert.ok(cancelled !== undefined, '必须发协议原生取消');
  assert.equal(process.killed, false, '取消不杀进程');
  client.dispose();
});

test('单请求超时会杀掉进程：不让可能卡死的后端继续派发', async () => {
  const process = new FakeProcess();
  const client = makeClient(process, { requestTimeoutMs: 50 });
  await client.start();
  process.onCall = () => { /* 不回复 */ };
  await assert.rejects(
    client.callTool('click', { pageId: 1, uid: '1_4' }, { mutating: true }),
    (error: unknown) => error instanceof BrowserBackendError &&
      error.code === 'BROWSER_TIMEOUT' && error.effectUncertain);
  assert.equal(process.killed, true);
  assert.equal(client.alive, false);
});
