import { RelayApiError, RelayTransportError } from "../api/core/errors";
import type { RelayApiClient } from "../api/relayClient";
import type { LabMethod, ScenarioFailure, ScenarioRunner, ScenarioWorld } from "./scenarioWorld";
import { MOCK } from "./scenarioFixtures";

/**
 * 场景实验室的模拟数据出口（仅开发构建可用）。
 *
 * 它只做一件事：把当前模拟世界**按真实 client 的方法签名**交给真实组件，
 * 让组件走自己原有的读取、轮询、身份核对与错误分支。因此这里没有任何渲染逻辑，
 * 也没有第二条时间线——组件读到的形状与线上同构。
 *
 * 四条保证：
 *   * 没有 HTTP、没有数据库、没有 Provider、没有子进程；方法体只读本机内存对象。
 *   * 未模拟的出口一律显式抛错，而不是回一个看起来能用的空值。哪天实验室意外依赖了
 *     别的出口，界面会直接说「没有模拟」，不会悄悄画出一块假象。
 *   * 读取按「调用那一刻的世界」立即返回，事件流（`readRunEvents`）才做有界等待。
 *     舞台在每一帧换一份 client 身份，真实 hook 因此在推进的同一刻重读一次，
 *     于是「单步执行」看到的是这一步的结果，不用等组件自己的 2 秒轮询。
 *   * 注入的失败走真实错误类型，`describeLiveError()` 因此给出与线上一致的中文说明。
 */

/** 事件流的有界等待上限：短于组件自身的 2 秒轮询，避免与产品节奏打架。 */
const HOLD_MS = 1_200;

function notFound(detail: string): RelayApiError {
  return new RelayApiError({
    status: 404, code: "RESOURCE_NOT_FOUND", detail, retryable: false,
    retryAction: null, fieldErrors: [], expectedRevision: null, actualRevision: null
  });
}

function failureError(failure: ScenarioFailure | undefined): RelayApiError | RelayTransportError | null {
  if (failure === undefined) return null;
  if (failure.kind === "http") {
    return new RelayApiError({
      status: failure.status, code: failure.code, detail: failure.detail,
      retryable: failure.status >= 500, retryAction: null, fieldErrors: [],
      expectedRevision: null, actualRevision: null
    });
  }
  if (failure.kind === "transport") {
    return new RelayTransportError(failure.message ?? "模拟：请求未获得服务端响应。");
  }
  // empty 与 mismatch 不是错误，由各读取体按语义返回空集合或错身份投影。
  return null;
}

export function createScenarioClient(runner: ScenarioRunner): RelayApiClient {
  const current = (): ScenarioWorld => runner.world;

  async function serve<T>(method: LabMethod, read: (world: ScenarioWorld) => T): Promise<T> {
    const world = current();
    const error = failureError(world.fail[method]);
    if (error !== null) throw error;
    return read(world);
  }

  const surface = {
    /** 与真实 client 同名：面板按连接身份核对，这里给出可见的模拟标识。 */
    baseUrl: "mock://scenario-lab",
    workspaceId: MOCK.workspaceId,

    async getAssistSessionToolCalls(sessionId: string, messageId: string) {
      return serve("getAssistSessionToolCalls", (world) => {
        if (world.fail.getAssistSessionToolCalls?.kind === "empty") {
          return { sessionId, messageId, messageStatus: "COMPLETED", rounds: [] };
        }
        // 已知消息但还没有账本 ＝ 服务端此刻确实返回零轮次（刚开始生成时就是这种读数），
        // 不是「读不到」；404 只留给实验室里不存在的消息身份。
        const known = world.messages.some((message) => message.id === messageId);
        if (!known) throw notFound("模拟：实验室里没有这条消息。");
        const trace = world.traces[messageId];
        return trace === undefined
          ? { sessionId, messageId, messageStatus: "RUNNING", rounds: [] }
          : { ...trace, sessionId, messageId };
      });
    },

    async getAssistMessageRecall(messageId: string) {
      return serve("getAssistMessageRecall", (world) => {
        if (world.recallReceipt === null) throw notFound("模拟：这条消息没有撤回回执。");
        return { ...world.recallReceipt, messageId };
      });
    },

    async getRunToolCalls(runId: string) {
      return serve("getRunToolCalls", (world) => {
        if (world.runToolCalls === null) throw notFound("模拟：这次执行没有工具轨迹。");
        // 身份不匹配（E10）：投影声明别的 Run，真实 hook 因此整份作废并说明原因。
        if (world.fail.getRunToolCalls?.kind === "mismatch") {
          return { ...world.runToolCalls, runId: "mock-run-other" };
        }
        return { ...world.runToolCalls, runId };
      });
    },

    async getRunToolCallPreviews(runId: string) {
      return serve("getRunToolCallPreviews", (world) => ({ runId, previews: world.runPreviews }));
    },

    async getRunReviews(runId: string) {
      return serve("getRunReviews", (world) => world.reviews.map((review) => ({ ...review, runId })));
    },

    async getFileWriteFrozenDiff(operationId: string) {
      return serve("getFileWriteFrozenDiff", (world) => {
        if (world.frozenDiff === null) throw notFound("模拟：没有冻结计划文本。");
        return { ...world.frozenDiff, operationId };
      });
    },

    async getFileWriteChangeSets(operationId: string) {
      return serve("getFileWriteChangeSets", (world) =>
        world.changeSets.map((set) => ({ ...set, invocationId: `mock-invocation-${operationId}` })));
    },

    /** 执行事件流：`streamDown` 时按真实降级路径抛错，hook 因此转成按 revision 轮询。 */
    async readRunEvents(_runId: string, after: string, signal: AbortSignal,
      onEvent: (seq: string) => void, onOpen: () => void): Promise<void> {
      if (current().streamDown) throw new Error("模拟：执行事件流不可用，已降级为轮询。");
      onOpen();
      let seen = runner.seq;
      while (!signal.aborted && seen === runner.seq) {
        await runner.wait(seen, HOLD_MS);
        seen = runner.seq;
      }
      if (signal.aborted) return;
      // 游标只用于续读，模拟里按单调递增给出即可。
      onEvent(String((Number(after) || 0) + 1));
    },

    /** 其余出口不进实验室：显式失败，不用空值冒充「服务端确实没有」。 */
    async notSimulated(name: string): Promise<never> {
      throw new Error(`场景实验室没有模拟这个出口：${name}`);
    }
  };

  return new Proxy(surface, {
    get(target, property) {
      if (typeof property === "symbol" || !(property in target)) {
        if (property === "then") return undefined;
        return (...args: unknown[]) => surface.notSimulated(`${String(property)}(${args.length} 个参数)`);
      }
      return Reflect.get(target, property);
    }
  }) as unknown as RelayApiClient;
}
