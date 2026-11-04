import type { FastifyInstance } from 'fastify';

import { DEFAULT_MAX_CONCURRENT_EXECUTIONS } from '../config/config.js';
import { runConversationExecutionAutoStartTick } from '../application/conversation-execution-autostart.js';
import { executionConcurrencyGateEnabled, planExecutionAdmission } from '../application/execution-concurrency.js';
import { runMemberWakeupTick } from '../application/member-wakeup.js';
import { runSessionTitleGenerationTick } from '../application/session-title-generation.js';
import { runWebImportTick } from '../application/web-import-runner.js';
import type { RelayDatabase } from '../infrastructure/database.js';
import type { SchemaReadinessChecker } from '../infrastructure/schema-readiness.js';
import { FakeModelPort, type AssistModelPort } from '../workflow/fake-model-port.js';
import { readModelPortConfig } from '../workflow/model-port-config.js';
import { createModelPort } from '../workflow/model-port-factory.js';

/**
 * 后台工作项的常驻推进 Owner（ENG-SA-01）。
 *
 * 成员唤醒、会话执行自动推进、网页导入原本只挂在持续 Worker 的循环分支里，而实际发布的拓扑是
 * 「常驻 Supervisor + 按需一次性 Worker」：`--once` 只领 Run 命令，`--assist-once` 只做会话生成，
 * 没有任何进程会走到那三个分支。于是这三类后台事实在桌面宿主和 `dev-stack -WithWorker` 里都没有
 * 执行者，只能等有人手工启动持续 Worker，或者等页面来喊一声。
 *
 * 挂在 API 而不是 Supervisor 里有两个原因：
 *   * API 是唯一在所有拓扑都常驻的进程（不带 Worker 的开发栈也只有它）；
 *   * Supervisor 的循环是串行派发路径，一次成员唤醒的模型调用在租约内可以持续数十秒，
 *     内联进去会推迟同进程的 Run 派发。
 *
 * 三段全部复用既有 Application tick：领取、租约、CAS、维护准入与幂等结算都在那些函数里，
 * 这里只回答「谁来周期性喊这一声」，不是第二套调度引擎。与手工启动的持续 Worker 同时在跑也
 * 安全——每个 tick 自己 fenced，重复扫描只会重放既有结算。空闲时候选查询返回空集，不产生模型调用。
 *
 * 模型可用性（0157）：标题请求在没有真实配置时由 tick 内部的规则降级兜底，不外呼；
 * 配置残缺只停掉成员唤醒这一段，不让它拖死导入与执行推进。成员唤醒的模型端口在
 * 调用期抛出的 typed 不可用错误由成员唤醒本身按类型化失败落账（settleWakeupFailed
 * 持久 error.code、不重试外呼、不吞成成功）——「无配置不再回退 FakeModelPort」的
 * 端口层改动归模型侧（见 OVERALL-FIX-20261104-A HANDOFF），本调度器对两种世界都
 * 只做通用 typed 错误处理，不硬编码错误码。
 *
 * 并发准入（runtime-context §2.12「并发上限」）：每一拍先读系统级在途执行数，达到
 * `RELAY_MAX_CONCURRENT_EXECUTIONS` 上界时整拍让路（只记可观测事实，不重试领取）；
 * 已在途的调用不受影响，被闸住的候选下一拍自然再试。test 环境默认不启用（既有套件
 * 的崩溃用例会在共享库遗留在途行，会把闸变成抖动源），显式设置 env 即为显式开启。
 */

const TICK_INTERVAL_MS = 1000;

/** 直接调用（单测、嵌入式宿主）没有经过 loadConfig：非法值告警后用默认上界，不静默。 */
function readCapLeniently(app: FastifyInstance): number {
  const raw = process.env.RELAY_MAX_CONCURRENT_EXECUTIONS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_MAX_CONCURRENT_EXECUTIONS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 64) {
    app.log.warn({ code: 'BACKGROUND_CONCURRENCY_CAP_INVALID', value: raw },
      'background_concurrency_cap_invalid_using_default');
    return DEFAULT_MAX_CONCURRENT_EXECUTIONS;
  }
  return value;
}

export function registerBackgroundWorkScheduler(
  app: FastifyInstance,
  d: { database: RelayDatabase; schemaReadiness: SchemaReadinessChecker;
    concurrencyCap?: number },
): void {
  // 认领身份按进程唯一：宿主重启后的新进程不能顶着旧身份去接续一条可能还活着的租约。
  const workerId = `api:${process.pid}`;
  const controller = new AbortController();
  // 并发上界：路由层传入配置校验后的值；直接调用（单测）时宽松读环境变量（非法值
  // 告警后用默认上界，不经 loadConfig 的调用方仍留下可定位的事实，不静默）。
  const concurrencyCap = d.concurrencyCap ?? readCapLeniently(app);
  // test 环境默认不启用并发闸（既有用例遗留的在途行会把闸变成抖动源）；
  // 显式设置 RELAY_MAX_CONCURRENT_EXECUTIONS 即为显式开启。
  const concurrencyGateActive = executionConcurrencyGateEnabled();
  // 与 Worker 同一口径：未配置真实模型走离线 Mock；配置残缺只停掉成员唤醒这一段，
  // 不让它拖死不需要模型的导入与执行推进。端口调用期的 typed 错误由成员唤醒落账，
  // 不在这里吞掉（见文件头注释与 OVERALL-FIX-20261104-A HANDOFF 的分工说明）。
  let memberWakeupModelPort: AssistModelPort | undefined;
  try {
    const config = readModelPortConfig(process.env);
    memberWakeupModelPort = config === undefined ? new FakeModelPort() : createModelPort(config);
  } catch {
    app.log.warn({ code: 'BACKGROUND_MEMBER_WAKEUP_DISABLED', reason: 'MODEL_CONFIG_INVALID' },
      'background_member_wakeup_disabled_by_invalid_model_config');
  }

  let active = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const lastFailures = new Map<string, string>();
  let lastThrottleKey: string | undefined;

  const runStage = async <T>(stage: string, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      const value = await work();
      lastFailures.delete(stage);
      return value;
    } catch (error) {
      const name = error instanceof Error ? error.name : typeof error;
      const message = error instanceof Error ? error.message : String(error);
      // 同一阶段的同一失败只记一次，避免每秒刷屏；失败变化时重新记录，便于定位。
      const signature = `${name}:${message}`;
      if (lastFailures.get(stage) !== signature) {
        lastFailures.set(stage, signature);
        app.log.warn({ code: 'BACKGROUND_WORK_TICK_FAILED', stage,
          error_name: name, error_message: message }, 'background_work_tick_failed');
      }
      return undefined;
    }
  };

  const tick = async () => {
    try {
      const readiness = await d.database.checkReadiness(d.schemaReadiness);
      if (!active || readiness.database !== 'up' || readiness.schema !== 'up') return;
      // 并发闸：读不到在途数（DB 抖动）按不可执行处理，宁可少一拍也不盲目领取。
      if (concurrencyGateActive) {
        const admission = await runStage('CONCURRENCY_ADMISSION',
          () => planExecutionAdmission(d.database.executor, concurrencyCap));
        if (admission === undefined) return;
        if (!admission.admitted) {
          // 可观测的让路事实：数字变化时更新一条，不在每秒刷屏。
          const key = `${admission.active}/${admission.cap}`;
          if (lastThrottleKey !== key) {
            lastThrottleKey = key;
            app.log.warn({ code: 'BACKGROUND_WORK_THROTTLED', active_executions: admission.active,
              concurrency_cap: admission.cap }, 'background_work_throttled_by_concurrency_cap');
          }
          return;
        }
      }
      lastThrottleKey = undefined;
      await runStage('WEB_IMPORT', () =>
        runWebImportTick(d.database.executor, { signal: controller.signal }));
      await runStage('EXECUTION_AUTOSTART', () =>
        runConversationExecutionAutoStartTick(d.database.executor));
      if (memberWakeupModelPort !== undefined) {
        await runStage('MEMBER_WAKEUP', () => runMemberWakeupTick(d.database.executor,
          { workerId, modelPort: memberWakeupModelPort, signal: controller.signal }));
      }
      // 0157：标题请求的推进者。放在最后：标题是异步展示事实，不能反过来推迟成员唤醒；
      // 没有在途请求时只多一条返回空集的领取查询，有请求时一次 tick 最多一次辅助外呼。
      await runStage('SESSION_TITLE', () => runSessionTitleGenerationTick(d.database.executor, {
        workerId, modelPort: memberWakeupModelPort, signal: controller.signal }));
    } finally {
      if (active) {
        timer = setTimeout(() => {
          // 两次 tick 之间没有任何调用方 await inFlight：runStage 只包住各阶段，
          // 若 readiness 探针本身抛出意外错误，被替换前的 rejected promise 会成为
          // unhandledRejection 并按 Node 默认行为终止整个 API 进程。这里显式收口，
          // 记录后由下一轮继续调度；阶段失败仍由 runStage 记日志，不在此掩盖。
          inFlight = tick().catch(reportTickCrash);
        }, TICK_INTERVAL_MS);
        timer.unref();
      }
    }
  };

  const reportTickCrash = (error: unknown): void => {
    app.log.error({ code: 'BACKGROUND_WORK_TICK_CRASHED', error_name:
      error instanceof Error ? error.name : typeof error,
      error_message: error instanceof Error ? error.message : String(error) },
      'background_work_tick_unexpected_failure');
  };

  app.addHook('onReady', async () => {
    active = true;
    // 首拍与重排臂同一收口：onReady 里的 await 不能被首拍意外错误击穿（否则 API 启动失败）。
    inFlight = tick().catch(reportTickCrash);
    await inFlight;
  });
  app.addHook('onClose', async () => {
    active = false;
    // 退出只拦「尚未开始的调用」；已在途的唤醒不补写结算，留下的 CLAIMED 由租约清扫收敛。
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
    await inFlight;
  });
}
