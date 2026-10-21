import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ComputerRuntimeClient, ComputerRuntimeError,
  type ComputerRuntimeProcessLike, type SpawnProcess } from '../../src/computer/runtime-client.js';
import { COMPUTER_PROTOCOL_VERSION } from '../../src/computer/protocol.js';

/**
 * 受控假进程：不依赖真实二进制，按 JSON-lines 协议回应。
 * 行为由脚本决定：正常回应、进程自杀、不回应（超时）、坏行、版本漂移。
 */
class FakeComputerProcess extends EventEmitter {
  stdinWrites: string[] = [];
  killed = false;
  /** true = 模拟 spawn 失败（可执行文件不存在）：永远不发 'spawn'，只发 'error'。 */
  readonly spawnFails: boolean;
  private stdoutListeners: ((chunk: Buffer) => void)[] = [];

  constructor(options: { spawnFails?: boolean } = {}) {
    super();
    this.spawnFails = options.spawnFails === true;
  }

  /**
   * 真实 Node 只在进程确实起来时发 'spawn'（spawn 失败只有 'error'）。
   * 假进程在客户端登记监听后的微任务里发一次，保证「先 attach、后 spawn」的时序成立。
   */
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    if (event === 'spawn' && !this.spawnFails) {
      queueMicrotask(() => { this.emit('spawn'); });
    }
    return super.on(event, listener);
  }

  get stdin() {
    const self = this;
    return {
      write(data: string) { self.stdinWrites.push(data); },
      end() {},
    };
  }

  get stdout() {
    const self = this;
    return { on(_event: 'data', listener: (chunk: Buffer) => void) { self.stdoutListeners.push(listener); } };
  }

  get stderr() {
    return { on() {} };
  }

  kill(): boolean {
    this.killed = true;
    // 真实进程被 kill 后会退出；假进程同步触发 exit，让客户端走同一条断开路径。
    queueMicrotask(() => this.emit('exit', null));
    return true;
  }

  /** 向客户端推送一行 reply。 */
  emitReply(requestId: string, result: Record<string, unknown>): void {
    this.emitBytes(replyLine(requestId, result));
  }

  /** 原样推送任意字节块：用于模拟管道在任意位置切分。 */
  emitBytes(chunk: Buffer): void {
    for (const listener of this.stdoutListeners) listener(chunk);
  }

  /** 向客户端推送一行 error reply。 */
  emitError(requestId: string, code: string, message: string, retryable: boolean): void {
    const line = JSON.stringify({ version: COMPUTER_PROTOCOL_VERSION, request_id: requestId,
      success: false, error: { code, message, retryable } }) + '\n';
    for (const listener of this.stdoutListeners) listener(Buffer.from(line, 'utf8'));
  }

  /** 推送一行非 JSON 垃圾。 */
  emitRaw(line: string): void {
    for (const listener of this.stdoutListeners) listener(Buffer.from(line, 'utf8'));
  }
}

function replyLine(requestId: string, result: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ version: COMPUTER_PROTOCOL_VERSION, request_id: requestId,
    success: true, result }) + '\n', 'utf8');
}

function clientWith(process: FakeComputerProcess,
  options: { idleReapMs?: number; maxLineBytes?: number } = {}): ComputerRuntimeClient {
  return new ComputerRuntimeClient({
    executable: 'fake-runtime.exe',
    mode: 'mock',
    // 假进程满足结构形状；on 的事件名联合比 EventEmitter 宽，这里做一次窄转换。
    spawnProcess: (() => process) as SpawnProcess,
    idleReapMs: options.idleReapMs ?? 60_000,
    requestTimeoutMs: 200,
    ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
  });
}

/** 冲刷微任务与一轮宏任务：确保「attach 后、写入后」的测试前提真的成立。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test('一次请求走完整生命周期：懒启动 → 写一行 → 按 request_id 收到结果', async () => {
  const process = new FakeComputerProcess();
  const client = clientWith(process);
  assert.equal(client.alive, false, '构造客户端不得启动进程');
  const pending = client.request('computer.get_windows', {});
  await flush();
  assert.equal(process.stdinWrites.length, 1, '第一次请求才 spawn 并写入一行');
  const request = JSON.parse(process.stdinWrites[0]!.trim());
  assert.equal(request.version, COMPUTER_PROTOCOL_VERSION);
  assert.equal(request.method, 'computer.get_windows');
  assert.equal(typeof request.request_id, 'string');
  process.emitReply(request.request_id, { windows: [] });
  const result = await pending;
  assert.deepEqual(result, { windows: [] });
  assert.equal(client.alive, true, '会话内保持进程，不随请求退出');
});

test('运行时 error reply 转成带原始 code 的 ComputerRuntimeError', async () => {
  const process = new FakeComputerProcess();
  const client = clientWith(process);
  const pending = client.request('computer.activate_window', { window_id: '123' });
  await flush();
  const request = JSON.parse(process.stdinWrites[0]!.trim());
  process.emitError(request.request_id, 'WINDOW_NOT_FOUND', 'window 123 no longer exists', true);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ComputerRuntimeError);
    assert.equal(error.code, 'WINDOW_NOT_FOUND');
    assert.equal(error.retryable, true);
    assert.equal(error.effectUncertain, false);
    return true;
  });
});

test('进程崩溃：在途请求失败且标记效果未知，下一个请求透明重连', async () => {
  const first = new FakeComputerProcess();
  const client = new ComputerRuntimeClient({
    executable: 'fake-runtime.exe',
    mode: 'mock',
    idleReapMs: 60_000,
    requestTimeoutMs: 200,
    spawnProcess: (() => first) as SpawnProcess,
  });
  const pending = client.request('computer.click', { x: 1, y: 2 });
  await flush();
  // 请求已写入后进程死掉：点击可能已到达桌面，必须按效果未知处理。
  first.emit('exit', 1);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ComputerRuntimeError);
    assert.equal(error.code, 'IPC_DISCONNECTED');
    assert.equal(error.effectUncertain, true, '已写入的请求效果未知，必须可核对');
    return true;
  });
  assert.equal(client.alive, false);
  // 重连：换一个假进程，同一个客户端再次请求必须成功。
  const second = new FakeComputerProcess();
  (client as unknown as { spawnProcess: SpawnProcess }).spawnProcess = (() => second) as SpawnProcess;
  const retried = client.request('computer.get_windows', {});
  await flush();
  const request = JSON.parse(second.stdinWrites[0]!.trim());
  second.emitReply(request.request_id, { windows: [{ id: '7' }] });
  assert.deepEqual(await retried, { windows: [{ id: '7' }] });
});

test('旧进程迟到的 close/error 不清掉新进程与在途请求', async () => {
  const first = new FakeComputerProcess();
  const client = new ComputerRuntimeClient({
    executable: 'fake-runtime.exe',
    mode: 'mock',
    idleReapMs: 60_000,
    requestTimeoutMs: 200,
    spawnProcess: (() => first) as SpawnProcess,
  });
  const pending = client.request('computer.click', { x: 1, y: 2 });
  await flush();
  first.emit('exit', 1);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ComputerRuntimeError);
    assert.equal(error.code, 'IPC_DISCONNECTED');
    assert.equal(error.effectUncertain, true);
    return true;
  });

  const second = new FakeComputerProcess();
  (client as unknown as { spawnProcess: SpawnProcess }).spawnProcess = (() => second) as SpawnProcess;
  const retried = client.request('computer.get_windows', {});
  await flush();
  assert.equal(client.alive, true, '新进程应已启动');

  // 旧进程的迟到事件：不得再触碰新进程或它的在途请求。
  first.emit('close', 1);
  first.emit('error', new Error('stale spawn error'));
  await flush();
  assert.equal(client.alive, true, '旧进程事件不能清掉新进程');
  const request = JSON.parse(second.stdinWrites[0]!.trim());
  second.emitReply(request.request_id, { windows: [] });
  assert.deepEqual(await retried, { windows: [] });
  assert.equal(second.killed, false, '新进程不能被旧事件杀掉');
});

test('未写入就崩溃的请求按 RUNTIME_UNAVAILABLE 失败，不谎称效果未知', async () => {
  const process = new FakeComputerProcess();
  const client = clientWith(process);
  // 同步 emit：此刻 attach 已完成（监听器已登记）但写入尚未排到，
  // 客户端必须放弃这次请求，而不是把请求写进已断开的管道。
  const pending = client.request('computer.screenshot', {});
  process.emit('exit', null);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ComputerRuntimeError);
    assert.equal(error.code, 'RUNTIME_UNAVAILABLE');
    assert.equal(error.effectUncertain, false);
    return true;
  });
});

test('进程根本没起来（可执行文件不存在）：请求按 RUNTIME_UNAVAILABLE 失败，不谎称效果未知', async () => {
  const process = new FakeComputerProcess({ spawnFails: true });
  const client = clientWith(process);
  const pending = client.request('computer.click', { x: 1, y: 2 });
  await flush();
  // 写管道发生在启动结果到达之前：请求字节已交给管道，但进程从未存在。
  assert.equal(process.stdinWrites.length, 1, '启动失败前写入照样发生');
  process.emit('error', new Error('spawn C:\\missing\\relay-computer-runtime.exe ENOENT'));
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ComputerRuntimeError);
    assert.equal(error.code, 'RUNTIME_UNAVAILABLE');
    assert.equal(error.retryable, true);
    assert.equal(error.effectUncertain, false,
      '进程从未起来：没有派发就没有外部副作用，不该要求人工核对');
    return true;
  });
  assert.equal(client.alive, false);
});

test('真实 spawn 失败（可执行文件不存在）：按 RUNTIME_UNAVAILABLE 失败且不拖垮进程', async () => {
  if (process.platform !== 'win32') return; // 真实模式在非 Windows 会被平台守卫先挡掉。
  const client = new ComputerRuntimeClient({
    executable: 'C:\\relay-nonexistent-dir\\relay-computer-runtime.exe', mode: 'real' });
  await assert.rejects(client.request('computer.get_windows', {}), (error: unknown) => {
    assert.ok(error instanceof ComputerRuntimeError);
    assert.equal(error.code, 'RUNTIME_UNAVAILABLE');
    assert.equal(error.effectUncertain, false);
    return true;
  });
  assert.equal(client.alive, false);
  client.dispose();
});

test('超时杀掉整个进程，下一个请求在新进程上重新开始', async () => {
  const first = new FakeComputerProcess();
  const client = clientWith(first, { idleReapMs: 60_000 });
  const pending = client.request('computer.screenshot', {});
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ComputerRuntimeError);
    assert.equal(error.code, 'TIMEOUT');
    return true;
  });
  assert.equal(first.killed, true, '超时必须杀掉进程，不能留着可能卡死的运行时');
  assert.equal(client.alive, false);
});

test('取消只解除等待，不杀死进程', async () => {
  const process = new FakeComputerProcess();
  const client = clientWith(process);
  const controller = new AbortController();
  const pending = client.request('computer.click', { x: 1, y: 2 }, { signal: controller.signal });
  await flush();
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ComputerRuntimeError);
    assert.equal(error.code, 'USER_CANCELLED');
    return true;
  });
  assert.equal(process.killed, false, '取消输入动作不得杀进程：效果可能已发生');
  assert.equal(client.alive, true);
});

test('无法解析的回复行杀死进程：协议漂移不靠猜后续行形状', async () => {
  const process = new FakeComputerProcess();
  const client = clientWith(process);
  const pending = client.request('computer.get_windows', {});
  await flush();
  process.emitRaw('this is not json\n');
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ComputerRuntimeError);
    return true;
  });
  assert.equal(process.killed, true);
});

test('畸形回复 envelope 失败关闭：null/数组/假成功/坏 result/坏 error', async () => {
  const cases: { label: string; line: (id: string) => string }[] = [
    { label: 'null', line: () => 'null' },
    { label: '数组', line: () => '[]' },
    { label: '基本类型', line: () => '"reply"' },
    {
      label: 'success 是字符串 false',
      line: (id) => JSON.stringify({ version: COMPUTER_PROTOCOL_VERSION, request_id: id,
        success: 'false', result: { clicked: true } }),
    },
    {
      label: '缺少 request_id',
      line: () => JSON.stringify({ version: COMPUTER_PROTOCOL_VERSION, success: true, result: {} }),
    },
    {
      label: 'request_id 非字符串',
      line: () => JSON.stringify({ version: COMPUTER_PROTOCOL_VERSION, request_id: 7,
        success: true, result: {} }),
    },
    {
      label: '成功但 result 是字符串',
      line: (id) => JSON.stringify({ version: COMPUTER_PROTOCOL_VERSION, request_id: id,
        success: true, result: 'ok' }),
    },
    {
      label: '成功但缺少 result',
      line: (id) => JSON.stringify({ version: COMPUTER_PROTOCOL_VERSION, request_id: id,
        success: true }),
    },
    {
      label: '失败但 error 为 null',
      line: (id) => JSON.stringify({ version: COMPUTER_PROTOCOL_VERSION, request_id: id,
        success: false, error: null }),
    },
    {
      label: '失败但 retryable 不是布尔',
      line: (id) => JSON.stringify({ version: COMPUTER_PROTOCOL_VERSION, request_id: id,
        success: false, error: { code: 'INPUT_FAILED', message: 'x', retryable: 'false' } }),
    },
  ];

  for (const item of cases) {
    const process = new FakeComputerProcess();
    const client = clientWith(process);
    const pending = client.request('computer.get_windows', {});
    await flush();
    const requestId = JSON.parse(process.stdinWrites[0]!.trim()).request_id as string;
    process.emitRaw(`${item.line(requestId)}\n`);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ComputerRuntimeError, `${item.label} 应失败关闭`);
      assert.equal(error.code, 'IPC_DISCONNECTED', `${item.label} 应按失联结算`);
      assert.equal(error.effectUncertain, true, `${item.label} 已写入请求应保持效果未知`);
      return true;
    }, `${item.label} 不能假成功或抛未捕获异常`);
    assert.equal(process.killed, true, `${item.label} 必须杀掉进程`);
    assert.equal(client.alive, false, `${item.label} 进程应已断开`);
  }
});

test('未知 request_id 的合法回复被忽略，不打断当前请求', async () => {
  const process = new FakeComputerProcess();
  const client = clientWith(process);
  const pending = client.request('computer.get_windows', {});
  await flush();
  const requestId = JSON.parse(process.stdinWrites[0]!.trim()).request_id as string;
  process.emitRaw(JSON.stringify({ version: COMPUTER_PROTOCOL_VERSION,
    request_id: 'unknown-request', success: true, result: { ignored: true } }) + '\n');
  assert.equal(process.killed, false, '未知 request_id 的合法回复不应杀进程');
  assert.equal(client.alive, true);
  process.emitReply(requestId, { windows: [] });
  assert.deepEqual(await pending, { windows: [] });
});

test('版本不匹配的回复杀死进程', async () => {
  const process = new FakeComputerProcess();
  const client = clientWith(process);
  const pending = client.request('computer.get_windows', {});
  await flush();
  const request = JSON.parse(process.stdinWrites[0]!.trim());
  const line = JSON.stringify({ version: 'relay-computer-v0', request_id: request.request_id,
    success: true, result: {} }) + '\n';
  process.emitRaw(line);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ComputerRuntimeError);
    return true;
  });
  assert.equal(process.killed, true);
});

test('并发请求共享同一进程，回复按 request_id 各自归位', async () => {
  const process = new FakeComputerProcess();
  const client = clientWith(process);
  const first = client.request('computer.screenshot', {});
  const second = client.request('computer.get_windows', {});
  await flush();
  assert.equal(process.stdinWrites.length, 2, '并发请求不重复 spawn');
  const firstId = JSON.parse(process.stdinWrites[0]!.trim()).request_id as string;
  const secondId = JSON.parse(process.stdinWrites[1]!.trim()).request_id as string;
  assert.notEqual(firstId, secondId);
  // 故意乱序回复：关联必须按 request_id，不按到达顺序。
  process.emitReply(secondId, { windows: [] });
  process.emitReply(firstId, { width: 1920 });
  assert.deepEqual(await second, { windows: [] });
  assert.deepEqual(await first, { width: 1920 });
});

test('V2 新错误码原样透传，不被折叠成 RUNTIME_UNAVAILABLE', async () => {
  const process = new FakeComputerProcess();
  const client = clientWith(process);
  const pending = client.request('computer.click', { x: 1, y: 1 });
  await flush();
  const request = JSON.parse(process.stdinWrites[0]!.trim());
  process.emitError(request.request_id, 'FOREGROUND_NOT_AUTHORIZED',
    'desktop input requires authorization', false);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ComputerRuntimeError);
    assert.equal(error.code, 'FOREGROUND_NOT_AUTHORIZED');
    assert.equal(error.retryable, false);
    return true;
  });
});

test('环境探测按 TTL 缓存，进程重建后失效', async () => {
  const process = new FakeComputerProcess();
  const client = clientWith(process);
  const first = client.describeEnvironment();
  await flush();
  const firstRequest = JSON.parse(process.stdinWrites[0]!.trim());
  assert.equal(firstRequest.method, 'computer.describe_environment');
  process.emitReply(firstRequest.request_id, { platform: 'windows',
    mode_availability: { background: { status: 'unavailable' },
      isolated: { status: 'unavailable' }, foreground: { status: 'requires_user_authorization' } } });
  await first;
  // TTL 内再读：不再发请求。
  const cached = await client.describeEnvironment();
  assert.equal((cached as { platform?: string }).platform, 'windows');
  assert.equal(process.stdinWrites.length, 1, 'TTL 内必须命中缓存，不重复探测');
  // 进程死亡后缓存失效（DPI/子会话/显示器都可能变了）。
  process.emit('exit', 1);
  const probe = client.describeEnvironment();
  await flush();
  assert.equal(process.stdinWrites.length, 2, '进程重建后必须重新探测');
  const secondRequest = JSON.parse(process.stdinWrites[1]!.trim());
  process.emitReply(secondRequest.request_id, { platform: 'windows' });
  await probe;
});

test('dispose 失败所有在途请求并终止进程', async () => {
  const process = new FakeComputerProcess();
  const client = clientWith(process);
  const pending = client.request('computer.screenshot', {});
  await flush();
  client.dispose();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ComputerRuntimeError);
    assert.equal(error.code, 'RUNTIME_UNAVAILABLE');
    return true;
  });
  assert.equal(process.killed, true);
  assert.equal(client.alive, false);
});

test('非 Windows 真实模式在启动前就失败关闭', async () => {
  if (process.platform === 'win32') return; // Windows 上真实模式允许启动，由真实二进制决定。
  const client = new ComputerRuntimeClient({ executable: 'never-spawned.exe', mode: 'real',
    spawnProcess: () => { throw new Error('must not spawn'); } });
  await assert.rejects(client.request('computer.screenshot', {}),
    (error: unknown) => error instanceof ComputerRuntimeError &&
      error.code === 'RUNTIME_UNAVAILABLE');
});

test('interrupt 立即杀掉进程：在途请求按效果未知失败，后续输入不再执行', async () => {
  const process = new FakeComputerProcess();
  const client = clientWith(process);
  const pending = client.request('computer.type', { text: 'hello' });
  await flush();
  assert.equal(client.alive, true);
  client.interrupt();
  assert.equal(process.killed, true, 'interrupt 必须杀进程，而不是只解除等待');
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ComputerRuntimeError);
    assert.equal(error.code, 'IPC_DISCONNECTED');
    assert.equal(error.effectUncertain, true, '在途输入的外部效果按未知核对');
    return true;
  });
  assert.equal(client.alive, false);
});

test('UTF-8 回复在任意字节边界拆包仍逐字还原', async () => {
  const result = { title: '测试窗口🙂', code: '中' };
  const placeholder = '00000000-0000-4000-8000-000000000000';
  const bytes = replyLine(placeholder, result);
  // 每一个切分位置都试一次：包括落在中文三字节与 emoji 四字节内部的位置。
  for (let split = 1; split < bytes.length; split += 1) {
    const process = new FakeComputerProcess();
    const client = clientWith(process);
    const pending = client.request('computer.get_windows', {});
    await flush();
    const requestId = JSON.parse(process.stdinWrites[0]!.trim()).request_id as string;
    const actual = replyLine(requestId, result);
    process.emitBytes(actual.subarray(0, split));
    process.emitBytes(actual.subarray(split));
    assert.deepEqual(await pending, result, `split=${split} 时中文/emoji 必须逐字节还原`);
    client.dispose();
  }
});

test('同一 chunk 的多条合法行逐行处理，总字节数不当作单行超限', async () => {
  const process = new FakeComputerProcess();
  const client = clientWith(process, { maxLineBytes: 200 });
  const first = client.request('computer.get_windows', {});
  const second = client.request('computer.get_windows', {});
  await flush();
  const firstId = JSON.parse(process.stdinWrites[0]!.trim()).request_id as string;
  const secondId = JSON.parse(process.stdinWrites[1]!.trim()).request_id as string;
  const firstLine = replyLine(firstId, { title: '中'.repeat(20) });
  const secondLine = replyLine(secondId, { title: '文'.repeat(20) });
  assert.ok(Buffer.byteLength(firstLine) + Buffer.byteLength(secondLine) > 200,
    '前提：两行合计超过单行上限');
  assert.ok(Buffer.byteLength(firstLine) - 1 <= 200 && Buffer.byteLength(secondLine) - 1 <= 200,
    '前提：每一行都不超过单行上限');
  process.emitBytes(Buffer.concat([firstLine, secondLine]));
  assert.deepEqual(await first, { title: '中'.repeat(20) });
  assert.deepEqual(await second, { title: '文'.repeat(20) });
  assert.equal(process.killed, false, '同一 chunk 多条合法行不得误杀进程');
  assert.equal(client.alive, true);
});

test('单行字节数恰好等于上限时接受', async () => {
  const result = { title: '中'.repeat(45) };
  const placeholder = '00000000-0000-4000-8000-000000000000';
  const contentBytes = Buffer.byteLength(replyLine(placeholder, result)) - 1;
  const process = new FakeComputerProcess();
  const client = clientWith(process, { maxLineBytes: contentBytes });
  const pending = client.request('computer.get_windows', {});
  await flush();
  const requestId = JSON.parse(process.stdinWrites[0]!.trim()).request_id as string;
  process.emitBytes(replyLine(requestId, result));
  assert.deepEqual(await pending, result, '恰好等于字节上限的行必须接受');
  assert.equal(process.killed, false);
});

test('单行字节超限杀掉进程，在途请求按效果未知结算', async () => {
  const process = new FakeComputerProcess();
  const client = clientWith(process, { maxLineBytes: 200 });
  const pending = client.request('computer.get_windows', {});
  await flush();
  const requestId = JSON.parse(process.stdinWrites[0]!.trim()).request_id as string;
  const line = replyLine(requestId, { title: '中'.repeat(45) });
  assert.ok(Buffer.byteLength(line) - 1 > 200, '前提：该行字节数超过上限');
  assert.ok(line.toString('utf8').length - 1 < 200,
    '前提：码元数未超限，旧的码元比较会误接受这一行');
  process.emitBytes(line);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ComputerRuntimeError);
    assert.equal(error.code, 'IPC_DISCONNECTED');
    assert.equal(error.effectUncertain, true, '已写入请求必须保持 UNKNOWN 语义');
    return true;
  });
  assert.equal(process.killed, true);
  assert.equal(client.alive, false);
});

test('非法 UTF-8 不静默替换字符：杀掉进程并按失联结算', async () => {
  const process = new FakeComputerProcess();
  const client = clientWith(process);
  const pending = client.request('computer.get_windows', {});
  await flush();
  const requestId = JSON.parse(process.stdinWrites[0]!.trim()).request_id as string;
  // 完整的一行 JSON，但字符串里插入一个残缺的「中」（E4 B8）再回到 ASCII。
  const invalid = Buffer.concat([
    Buffer.from(`{"version":"${COMPUTER_PROTOCOL_VERSION}","request_id":"${requestId}",`
      + '"success":true,"result":{"title":"', 'utf8'),
    Buffer.from([0xe4, 0xb8]),
    Buffer.from('"}}\n', 'utf8'),
  ]);
  process.emitBytes(invalid);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ComputerRuntimeError);
    assert.equal(error.code, 'IPC_DISCONNECTED');
    assert.equal(error.effectUncertain, true);
    return true;
  });
  assert.equal(process.killed, true, '无效协议必须失败关闭，不能继续解析后续行');
  assert.equal(client.alive, false);
});
