/**
 * 预览停稳判定（场景实验室 V2.1）。
 *
 * 旧实现超时后只要「当前场景身份对」就直接返回 DOM，等于把没停稳的中间状态
 * 当成可测量的事实。这里只返回明确的三种结果：稳定、超时（附具体原因）、取消；
 * 调用方只有拿到 `ok` 才允许跑断言。等待与时钟可注入，便于覆盖迟到响应、
 * 反复更新、持续加载与取消竞争。
 */

export const SETTLE_TIMEOUT_MS = 2_500;
export const SETTLE_INTERVAL_MS = 80;
/** 同一段正文要连续读到的次数；2 = 至少三次相同读数，排除一次异步回填的抖动。 */
export const SETTLE_STABLE_READS = 2;

export interface PreviewReading {
  readonly scenarioId: string | null;
  readonly text: string;
}

export interface SettleToken {
  cancelled: boolean;
}

export type SettleTimeoutKind = "unmounted" | "identity" | "unstable";

export type SettleOutcome =
  | { readonly status: "ok"; readonly reading: PreviewReading }
  | { readonly status: "timeout"; readonly kind: SettleTimeoutKind; readonly detail: string }
  | { readonly status: "cancelled"; readonly detail: string };

export interface SettleOptions {
  readonly expectedId: string;
  readonly token: SettleToken;
  readonly read: () => PreviewReading | null;
  readonly wait?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly stableReads?: number;
}

const defaultWait = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * 等预览「挂的是这一条 + 正文连续不变」。
 *
 * 取消与超时是两种事实：取消不产生任何验收结果；超时产生「无法稳定验证」并带原因。
 */
export async function settleScenarioPreview(options: SettleOptions): Promise<SettleOutcome> {
  const wait = options.wait ?? defaultWait;
  const now = options.now ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? SETTLE_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? SETTLE_INTERVAL_MS;
  const stableReads = options.stableReads ?? SETTLE_STABLE_READS;
  const started = now();
  let previousText: string | null = null;
  let stable = 0;
  let last: PreviewReading | null = null;
  let sawExpectedIdentity = false;

  while (true) {
    if (options.token.cancelled) {
      return { status: "cancelled", detail: "批次已取消，未记录这一条场景的验收结果" };
    }
    await wait(intervalMs);
    if (options.token.cancelled) {
      return { status: "cancelled", detail: "批次已取消，未记录这一条场景的验收结果" };
    }
    last = options.read();
    if (last === null) {
      previousText = null;
      stable = 0;
    } else if (last.scenarioId !== options.expectedId) {
      sawExpectedIdentity = false;
      previousText = null;
      stable = 0;
    } else {
      sawExpectedIdentity = true;
      stable = last.text === previousText ? stable + 1 : 0;
      previousText = last.text;
      if (stable >= stableReads) return { status: "ok", reading: last };
    }
    if (now() - started >= timeoutMs) break;
  }

  if (last === null) {
    return { status: "timeout", kind: "unmounted",
      detail: "预览区没有挂载任何场景，断言无处可跑" };
  }
  if (!sawExpectedIdentity) {
    return { status: "timeout", kind: "identity",
      detail: `预览区挂的是「${last.scenarioId ?? "未知场景"}」，不是 ${options.expectedId}；不把上一条场景的残留读成结果` };
  }
  return { status: "timeout", kind: "unstable",
    detail: `预览正文在 ${String(timeoutMs)}ms 内没有连续 ${String(stableReads + 1)} 次停稳，最后一次读数长度 ${String(last.text.length)}` };
}
