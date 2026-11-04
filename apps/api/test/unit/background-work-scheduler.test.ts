import assert from 'node:assert/strict';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';

import type { RelayDatabase } from '../../src/infrastructure/database.js';
import type { SchemaReadinessChecker } from '../../src/infrastructure/schema-readiness.js';
import { registerBackgroundWorkScheduler } from '../../src/runtime/background-work-scheduler.js';

/**
 * 常驻后台工作调度器（ENG-SA-01）的异常收口与生命周期。
 *
 * 这一层只回答「谁来周期性喊一声」，领取/租约/CAS 都在各 Application tick 里。
 * 因此这里不读库、不调模型，只钉住调度器自己的四条责任：
 *   1. readiness 不就绪时整轮直接返回，不进入任何阶段；
 *   2. 探针本身抛出意外错误时被记录成 `BACKGROUND_WORK_TICK_CRASHED`，不产生
 *      unhandledRejection（否则 Node 默认行为会终止整个 API 进程）；
 *   3. 任一阶段失败只影响该阶段，下一轮照常调度；
 *   4. shutdown 之后不再安排新的 timer，并等待在途那一轮结束。
 *
 * 数据库侧的「多实例同时领取只成功一次」由 `skip locked` + 租约 + CAS 保证，
 * 证据在真实 PostgreSQL 的 background-work-dispatch 集成测试里，不在本文件。
 */

const TICK_INTERVAL_MS = 1000;

// 本文件只测调度器自身，不spawn子进程；显式声明 test 形态，让「test 环境默认不启用
// 并发闸」的判定成立（并发闸用例自己显式设置 RELAY_MAX_CONCURRENT_EXECUTIONS 开启）。
process.env.NODE_ENV ??= 'test';
/** 一轮 tick 的间隔是 1s，观察两轮要留出抖动余量。 */
const TWO_TICKS_MS = TICK_INTERVAL_MS * 2 + 700;

interface LoggedEvent {
  readonly level: 'warn' | 'error';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

interface FakeApp {
  readonly app: FastifyInstance;
  readonly logs: readonly LoggedEvent[];
  runHook(name: 'onReady' | 'onClose'): Promise<void>;
}

/**
 * 只实现调度器真正用到的那两个成员：`log` 与 `addHook`。
 *
 * 调度器的依赖类型是具体的 `RelayDatabase` / `SchemaReadinessChecker` 类，
 * 它们带私有字段，结构类型无法满足，所以这里按测试替身的惯例显式断言成目标类型：
 * 替身只提供 `checkReadiness`，而 `executor` 是一碰就报错的守卫对象。
 */
function fakeApp(): FakeApp {
  const logs: LoggedEvent[] = [];
  const hooks = new Map<string, Array<() => Promise<void> | void>>();
  const record = (level: 'warn' | 'error') =>
    (fields: Record<string, unknown>, message: string) => {
      logs.push({ level, fields, message });
    };

  const app = {
    log: { warn: record('warn'), error: record('error') },
    addHook(name: string, handler: () => Promise<void> | void) {
      const list = hooks.get(name) ?? [];
      list.push(handler);
      hooks.set(name, list);
    },
  } as unknown as FastifyInstance;

  return {
    app,
    logs,
    async runHook(name) {
      for (const handler of hooks.get(name) ?? []) await handler();
    },
  };
}

/**
 * 一碰就抛的 executor：readiness 不就绪时它绝不该被访问，
 * 一旦被访问就说明「不就绪也进了阶段」这条不变量被破坏。
 */
function guardedExecutor(): RelayDatabase['executor'] {
  return new Proxy({} as RelayDatabase['executor'], {
    get(_target, property) {
      throw new Error(`executor must not be touched (accessed ${String(property)})`);
    },
  });
}

function fakeDatabase(
  checkReadiness: () => Promise<{ database: 'up' | 'down'; schema: 'up' | 'down' | 'unknown' }>,
): RelayDatabase {
  return {
    executor: guardedExecutor(),
    checkReadiness,
  } as unknown as RelayDatabase;
}

const readinessDown = async () => ({ database: 'down' as const, schema: 'unknown' as const });
const readinessUp = async () => ({ database: 'up' as const, schema: 'up' as const });

async function waitUntil(condition: () => boolean, timeoutMs: number, label: string):
Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function start(
  database: RelayDatabase,
): { readonly fake: FakeApp; stop(): Promise<void> } {
  const fake = fakeApp();
  registerBackgroundWorkScheduler(fake.app, {
    database,
    schemaReadiness: {} as SchemaReadinessChecker,
  });
  return { fake, stop: () => fake.runHook('onClose') };
}

test('readiness 不就绪：整轮直接返回，不进入任何阶段，也不报错', async () => {
  let probes = 0;
  const database = fakeDatabase(async () => { probes += 1; return readinessDown(); });
  const scheduler = start(database);
  try {
    await scheduler.fake.runHook('onReady');
    // 两轮 tick 都不该碰 executor；guardedExecutor 会在被访问时抛错并被记成阶段失败。
    await waitUntil(() => probes >= 2, TWO_TICKS_MS, 'second readiness probe');
    // 构造期的一次性环境事实：测试进程没有模型配置，调度器按 B1 接缝记
    // BACKGROUND_MODEL_UNAVAILABLE（无配置不再回退 Fake）；readiness 不就绪本身
    // 仍然零阶段、零错误——除此之外不允许任何日志。
    assert.deepEqual(scheduler.fake.logs, [
      { level: 'warn', fields: { code: 'BACKGROUND_MODEL_UNAVAILABLE' },
        message: 'background_member_wakeup_skipped_without_model_config' },
    ]);
  } finally {
    await scheduler.stop();
  }
});

test('探针抛错：记为 BACKGROUND_WORK_TICK_CRASHED，不产生 unhandledRejection，下一轮继续', async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);

  let probes = 0;
  const database = fakeDatabase(async () => {
    probes += 1;
    // 第一轮成功（onReady 正常返回），之后每轮都抛出探针级意外错误。
    if (probes === 1) return readinessUp();
    throw new Error('readiness probe exploded');
  });

  const scheduler = start(database);
  try {
    await scheduler.fake.runHook('onReady');
    await waitUntil(() => probes >= 3, TWO_TICKS_MS * 2, 'recovery after crashed tick');

    const crashed = scheduler.fake.logs.filter((entry) =>
      entry.fields.code === 'BACKGROUND_WORK_TICK_CRASHED');
    assert.ok(crashed.length >= 1, 'crash must be logged, not swallowed silently');
    const first = crashed[0]!;
    assert.equal(first.level, 'error');
    // 诊断信息足够定位：错误类型与消息都在，且不掺入连接串之类的凭据。
    assert.equal(first.fields.error_name, 'Error');
    assert.equal(first.fields.error_message, 'readiness probe exploded');
    assert.equal(first.message, 'background_work_tick_unexpected_failure');

    // 关键回归：抛错之后仍安排下一轮，探针次数继续增长（3 次以上）。
    assert.ok(probes >= 3, `scheduler must keep ticking after a crash (probes=${String(probes)})`);
    assert.deepEqual(rejections, [], 'crashed tick must not surface as unhandledRejection');
  } finally {
    await scheduler.stop();
    process.off('unhandledRejection', onRejection);
  }
});

test('首拍探针抛错：onReady 不被击穿，记 BACKGROUND_WORK_TICK_CRASHED 后照常重排', async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);

  // 第一次探针就抛：这是 onReady 里的首拍，收口缺失会让 API 启动失败。
  let probes = 0;
  const database = fakeDatabase(async () => {
    probes += 1;
    throw new Error('first probe exploded');
  });

  const scheduler = start(database);
  try {
    await scheduler.fake.runHook('onReady');
    await waitUntil(() => probes >= 3, TWO_TICKS_MS * 2, 'retry after first-tick crash');

    const crashed = scheduler.fake.logs.filter((entry) =>
      entry.fields.code === 'BACKGROUND_WORK_TICK_CRASHED');
    assert.ok(crashed.length >= 1, 'first-tick crash must be logged');
    assert.equal(crashed[0]!.fields.error_message, 'first probe exploded');
    assert.ok(probes >= 3, `scheduler must keep ticking after a first-tick crash (probes=${String(probes)})`);
    assert.deepEqual(rejections, [], 'first-tick crash must not surface as unhandledRejection');
  } finally {
    await scheduler.stop();
    process.off('unhandledRejection', onRejection);
  }
});

test('并发闸显式开启时先于各阶段读取：让路时不进入任何工作阶段', async () => {
  // test 环境默认不启用闸；显式设置 env 即为显式开启（生产由 loadConfig 传入同值）。
  process.env.RELAY_MAX_CONCURRENT_EXECUTIONS = '1';
  try {
    let probes = 0;
    const database = fakeDatabase(async () => { probes += 1; return readinessUp(); });
    const scheduler = start(database);
    try {
      await scheduler.fake.runHook('onReady');
      await waitUntil(() => scheduler.fake.logs.length > 0, TWO_TICKS_MS, 'gate stage log');
      const failed = scheduler.fake.logs.filter((entry) =>
        entry.fields.code === 'BACKGROUND_WORK_TICK_FAILED');
      const stages = new Set(failed.map((entry) => String(entry.fields.stage)));
      // executor 是守卫对象：闸的准入读数必然失败并被收口；关键不变量是
      // 准入失败后**不再进入任何工作阶段**（WEB_IMPORT/EXECUTION_AUTOSTART 等无日志）。
      assert.ok(stages.has('CONCURRENCY_ADMISSION'), 'gate admission must be consulted first');
      for (const stage of ['WEB_IMPORT', 'EXECUTION_AUTOSTART', 'MEMBER_WAKEUP', 'SESSION_TITLE']) {
        assert.ok(!stages.has(stage), `stage ${stage} must not run when admission is unresolved`);
      }
    } finally {
      await scheduler.stop();
    }
  } finally {
    delete process.env.RELAY_MAX_CONCURRENT_EXECUTIONS;
  }
});

test('阶段失败只影响该阶段：被记录后下一轮照常领取', async () => {
  let probes = 0;
  // readiness 就绪 → 会进入阶段；executor 是守卫对象，第一次访问即抛，
  // 由 runStage 收口成 BACKGROUND_WORK_TICK_FAILED，整轮不因此崩溃。
  const database = fakeDatabase(async () => { probes += 1; return readinessUp(); });
  const scheduler = start(database);
  try {
    await scheduler.fake.runHook('onReady');
    await waitUntil(() => scheduler.fake.logs.length > 0, TWO_TICKS_MS, 'stage failure log');

    const failed = scheduler.fake.logs.filter((entry) =>
      entry.fields.code === 'BACKGROUND_WORK_TICK_FAILED');
    const stages = new Set(failed.map((entry) => String(entry.fields.stage)));
    // 每个进入的阶段各自收口：一个阶段抛错不会带走后面的阶段。
    for (const stage of ['WEB_IMPORT', 'EXECUTION_AUTOSTART', 'SESSION_TITLE']) {
      assert.ok(stages.has(stage), `stage ${stage} must report its own failure`);
    }
    for (const entry of failed) {
      assert.equal(entry.level, 'warn');
      assert.equal(typeof entry.fields.error_name, 'string');
      assert.ok(String(entry.fields.error_message).length > 0, 'diagnostic message must be kept');
    }
    // 读不到数据库时维护准入如实拒绝（fail closed），不能把「查不到」当成「可以执行」。
    const failClosed = failed.filter((entry) =>
      String(entry.fields.error_message).includes('MAINTENANCE_UNAVAILABLE'));
    assert.ok(failClosed.length >= 1, 'unreadable maintenance admission must fail closed');

    const probesAfterFirstFailure = probes;
    await waitUntil(() => probes > probesAfterFirstFailure, TWO_TICKS_MS, 'tick after stage failure');
  } finally {
    await scheduler.stop();
  }
});

test('同一阶段同一失败只记一次，避免每秒刷屏', async () => {
  let probes = 0;
  const database = fakeDatabase(async () => { probes += 1; return readinessUp(); });
  const scheduler = start(database);
  try {
    await scheduler.fake.runHook('onReady');
    // 等第一轮的全部阶段都跑完（probes 走到 3 说明已经进入第三轮），再取基线。
    await waitUntil(() => probes >= 3, TWO_TICKS_MS * 2, 'third tick started');
    const afterFirst = scheduler.fake.logs.length;
    assert.ok(afterFirst > 0, 'first round must log stage failures');
    await sleep(TWO_TICKS_MS);
    // 同样的失败签名不再重复记录；计数不会随 tick 次数线性增长。
    assert.equal(scheduler.fake.logs.length, afterFirst);
  } finally {
    await scheduler.stop();
  }
});

test('tick 不重叠：慢探针期间不会并行进入第二轮', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  let probes = 0;
  const database = fakeDatabase(async () => {
    probes += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    // 探针耗时超过 tick 间隔：若调度器不等当前轮结束就会重叠。
    await sleep(TICK_INTERVAL_MS + 200);
    concurrent -= 1;
    return readinessDown();
  });

  const scheduler = start(database);
  try {
    await scheduler.fake.runHook('onReady');
    await waitUntil(() => probes >= 2, TICK_INTERVAL_MS * 4, 'second tick after slow probe');
    assert.equal(maxConcurrent, 1, 'ticks must be single-flight');
  } finally {
    await scheduler.stop();
  }
});

test('shutdown 后不再安排新的 timer，并等待在途那一轮结束', async () => {
  let probes = 0;
  let secondProbeDone = false;
  const database = fakeDatabase(async () => {
    probes += 1;
    const isSecond = probes === 2;
    await sleep(300);
    if (isSecond) secondProbeDone = true;
    return readinessDown();
  });

  const scheduler = start(database);
  await scheduler.fake.runHook('onReady');

  // 让下一轮进入在途状态，再在它完成前关闭。
  await waitUntil(() => probes >= 2, TWO_TICKS_MS, 'second tick started');
  assert.equal(secondProbeDone, false, 'tick must still be in flight when shutdown starts');

  await scheduler.stop();
  assert.equal(secondProbeDone, true, 'shutdown must await the in-flight tick');

  const probesAtShutdown = probes;
  await sleep(TWO_TICKS_MS);
  assert.equal(probes, probesAtShutdown, 'no tick may be scheduled after shutdown');
});
