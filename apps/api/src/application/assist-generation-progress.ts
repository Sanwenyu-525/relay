import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { createRepositories } from './unit-of-work.js';

/**
 * 会话回复的**执行阶段只读投影**（2026-11-01 AGENT-STREAM-VISIBILITY）。
 *
 * 这不是新的业务状态机：阶段完全由既有事实派生——
 *   * `assist_messages.status`（PENDING 尚未领取 / RUNNING 已领取）由调用方读取；
 *   * 本轮全部 `PRIMARY` `model_calls` 行的 `status` 与四个既有时间字段。
 *
 * 于是每个阶段都能回答「Relay 现在确实走到哪一步」，而不用客户端按等待时长猜测：
 *   * 没有调用行 → 已领取、尚未登记模型请求（上下文/记忆准备阶段）；
 *   * 最新调用 STARTED、无首事件 → 请求已登记，等待 Provider 响应；
 *   * 有首事件、无首正文 → Provider 已开始返回数据（可能只是 reasoning 或工具参数），
 *     此时还没有任何可展示正文；
 *   * 有首正文 → 已收到文本增量（结构化信封可能仍不可安全投影）；
 *   * 最新调用已结算而消息仍 RUNNING → 正在处理模型返回结果（派发工具或续轮）。
 *
 * 不写任何一行，不引入第二套状态：`model_calls` 仍是调用事实的唯一 Owner，
 * 预览与消息仍是展示数据的 Owner。辅助外呼（记忆提取/压缩）按 `purpose='PRIMARY'`
 * 排除，不冒充本轮回复的进度。
 */

export const ASSIST_GENERATION_PHASES = ['PREPARING_CONTEXT', 'WAITING_MODEL',
  'MODEL_STREAMING', 'MODEL_OUTPUT', 'PROCESSING'] as const;
export type AssistGenerationPhase = (typeof ASSIST_GENERATION_PHASES)[number];

export interface AssistGenerationCallRow {
  readonly assist_message_id: string;
  readonly status: 'STARTED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  readonly started_at: Date;
  readonly first_stream_event_at: Date | null;
  readonly first_text_delta_at: Date | null;
  readonly first_preview_persisted_at: Date | null;
  readonly settled_at: Date | null;
}

export interface AssistGenerationCallProgress {
  readonly status: AssistGenerationCallRow['status'];
  readonly startedAt: Date;
  readonly firstStreamEventAt: Date | null;
  readonly firstTextDeltaAt: Date | null;
  readonly firstPreviewPersistedAt: Date | null;
  readonly settledAt: Date | null;
}

export interface AssistGenerationProgress {
  readonly phase: AssistGenerationPhase;
  /** 这一轮回复已登记的 PRIMARY 调用数（工具续轮各算一次）。 */
  readonly callCount: number;
  /** 最近一次调用；还没有任何调用时为 null（此刻连请求都还没登记）。 */
  readonly latestCall: AssistGenerationCallProgress | null;
}

/**
 * 从同一消息的调用行派生阶段。行必须按 `(started_at, id)` 升序传入，
 * 最新一次调用就是数组最后一行；本函数不重新排序，避免与仓储口径分叉。
 */
export function projectAssistGenerationProgress(
  calls: readonly AssistGenerationCallRow[]): AssistGenerationProgress {
  const latest = calls.at(-1);
  if (latest === undefined) {
    return { phase: 'PREPARING_CONTEXT', callCount: 0, latestCall: null };
  }
  const latestCall: AssistGenerationCallProgress = {
    status: latest.status,
    startedAt: latest.started_at,
    firstStreamEventAt: latest.first_stream_event_at,
    firstTextDeltaAt: latest.first_text_delta_at,
    firstPreviewPersistedAt: latest.first_preview_persisted_at,
    settledAt: latest.settled_at,
  };
  let phase: AssistGenerationPhase;
  if (latest.status !== 'STARTED') {
    // 调用已结算、消息仍 RUNNING：模型这一轮已经结束，接下来是工具执行或下一轮准备。
    phase = 'PROCESSING';
  } else if (latest.first_stream_event_at === null) {
    phase = 'WAITING_MODEL';
  } else if (latest.first_text_delta_at === null) {
    // reasoning / 工具参数也可能先到；这里只承诺「已收到数据、还没有正文」。
    phase = 'MODEL_STREAMING';
  } else {
    phase = 'MODEL_OUTPUT';
  }
  return { phase, callCount: calls.length, latestCall };
}

/** 一批在途消息一次读齐；没有调用的消息得到 PREPARING_CONTEXT，不由客户端补猜。 */
export async function readAssistGenerationProgress(db: DbExecutor,
  messageIds: readonly string[]): Promise<ReadonlyMap<string, AssistGenerationProgress>> {
  if (messageIds.length === 0) return new Map();
  const rows = await createRepositories(db).modelCalls
    .generationRowsForAssistMessages(messageIds);
  const grouped = new Map<string, AssistGenerationCallRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.assist_message_id) ?? [];
    list.push(row);
    grouped.set(row.assist_message_id, list);
  }
  return new Map(messageIds.map((id) =>
    [id, projectAssistGenerationProgress(grouped.get(id) ?? [])]));
}

/** HTTP DTO（snake_case）；时间逐字转 ISO，缺失保持 null。 */
export function assistGenerationProgressDto(progress: AssistGenerationProgress): JsonObject {
  const latest = progress.latestCall;
  return {
    phase: progress.phase,
    call_count: progress.callCount,
    latest_call: latest === null ? null : {
      status: latest.status,
      started_at: latest.startedAt.toISOString(),
      first_stream_event_at: latest.firstStreamEventAt?.toISOString() ?? null,
      first_text_delta_at: latest.firstTextDeltaAt?.toISOString() ?? null,
      first_preview_persisted_at: latest.firstPreviewPersistedAt?.toISOString() ?? null,
      settled_at: latest.settledAt?.toISOString() ?? null,
    },
  };
}
