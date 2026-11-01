import type {
  RelayAssistGenerationPhase,
  RelayAssistGenerationProgress,
  RelayAssistMessage,
} from "../api/dtos/assist";
import { formatActivityDuration } from "./activityPresentation";

/**
 * 回复等待阶段的**只读展示投影**（2026-11-01 AGENT_STREAM_VISIBILITY）。
 *
 * 本文件只把服务端已确认的事实翻成一句等待文案与一组延迟读数：
 *   * 阶段来自 `message.generationProgress`（由 `model_calls` 与消息状态派生）；
 *   * PENDING 只表示「已提交、Worker 尚未领取」，不写成「正在生成」；
 *   * 没有阶段读数（旧服务端、未知枚举）只回退到「正在生成」，不从等待时长推断；
 *   * 诊断行不混算服务端时钟与本机时钟：领取时刻和前端绘制如实标为未记录/未观测。
 *
 * 它不产生任何业务状态，也不替模型编造 reasoning 或工具步骤。
 */

export type GenerationStageKey = "AWAITING_WORKER" | RelayAssistGenerationPhase | "UNKNOWN";

export interface GenerationStageView {
  readonly key: GenerationStageKey;
  readonly text: string;
}

const PHASE_TEXT: Readonly<Record<RelayAssistGenerationPhase, string>> = {
  PREPARING_CONTEXT: "正在准备上下文",
  WAITING_MODEL: "等待模型响应",
  // 只承诺「已收到数据」：可能是 reasoning，也可能是工具参数；没有正文就不说正在写正文。
  MODEL_STREAMING: "模型已响应，等待正文",
  // 正文增量可能藏在结构化信封里，尚未通过安全投影；不承诺「已经能读到」。
  MODEL_OUTPUT: "已收到模型输出，正在整理为回复",
  PROCESSING: "正在处理模型返回结果",
};

/**
 * 在途回复的一句话阶段。终态返回 null（终态由正文、失败行与 meta 行表达）。
 * 调用方只在「没有可见草稿/工具主进度/取消意图」时渲染它。
 */
export function generationStageView(message: Pick<RelayAssistMessage,
  "status" | "generationProgress">): GenerationStageView | null {
  if (message.status === "PENDING") return { key: "AWAITING_WORKER", text: "等待处理" };
  if (message.status !== "RUNNING") return null;
  const progress = message.generationProgress;
  if (progress === null || progress === undefined) return { key: "UNKNOWN", text: "正在生成" };
  return { key: progress.phase, text: PHASE_TEXT[progress.phase] };
}

export interface GenerationDiagnosticRow {
  readonly label: string;
  /** 已确认的时长，或一句如实的「未收到 / 未记录 / 未观测」。 */
  readonly value: string;
}

const STATUS_TEXT: Readonly<Record<
  NonNullable<RelayAssistGenerationProgress["latestCall"]>["status"], string>> = {
  STARTED: "进行中",
  COMPLETED: "已结束",
  FAILED: "失败",
  CANCELLED: "已取消",
};

/** 只有两端都是有效时刻才报时长；缺失的一端必须如实说明，不补造。 */
function span(from: string | null, to: string | null): string | null {
  if (from === null || to === null) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return formatActivityDuration(end - start);
}

/**
 * 延迟诊断的最小读数（就地展开，不常驻正文）。
 *
 * 每条标签都写明区间：排队与上下文准备合并为一段（服务端没有领取时刻），
 * Provider 首事件不等于首个正文 token，前端绘制只有本机读数、不与服务端时钟相加。
 */
export function generationStageDiagnostics(message: Pick<RelayAssistMessage,
  "createdAt" | "generationProgress">): readonly GenerationDiagnosticRow[] {
  const progress = message.generationProgress;
  if (progress === null || progress === undefined) return [];
  const latest = progress.latestCall;
  const rows: GenerationDiagnosticRow[] = [{
    label: "模型请求",
    value: latest === null ? `尚未登记（已尝试 ${progress.callCount} 次）`
      : `第 ${progress.callCount} 次 · ${STATUS_TEXT[latest.status]}`,
  }];
  if (latest === null) return rows;
  rows.push({
    label: "提交 → 模型请求登记（含排队与准备）",
    value: span(message.createdAt, latest.startedAt) ?? "未记录",
  }, {
    label: "模型请求 → 首个流事件",
    value: latest.firstStreamEventAt === null ? "尚未收到"
      : span(latest.startedAt, latest.firstStreamEventAt) ?? "未记录",
  }, {
    label: "首个流事件 → 首个正文",
    value: latest.firstTextDeltaAt === null ? "尚未收到正文"
      : latest.firstStreamEventAt === null ? "首个流事件未记录"
        : span(latest.firstStreamEventAt, latest.firstTextDeltaAt) ?? "未记录",
  }, {
    label: "首个正文 → 预览可见",
    value: latest.firstPreviewPersistedAt === null ? "尚未写入预览"
      : latest.firstTextDeltaAt === null ? "首个正文未记录"
        : span(latest.firstTextDeltaAt, latest.firstPreviewPersistedAt) ?? "未记录",
  });
  if (latest.settledAt !== null) rows.push({
    label: "模型请求 → 调用结算",
    value: span(latest.startedAt, latest.settledAt) ?? "未记录",
  });
  rows.push({
    // 不是「未观测」：服务端确实没有这个观测点，排队时长因此并入上一段。
    label: "Worker 领取时刻",
    value: "未记录（排队与上下文准备合并计算）",
  }, {
    // 本机时钟不能与服务器时刻直接相加，因此只标未观测，不报一个看似精确的数。
    label: "前端首次绘制延迟",
    value: "本机未观测",
  });
  return rows;
}
