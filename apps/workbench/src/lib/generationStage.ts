import type {
  RelayAssistGenerationPhase,
  RelayAssistMessage,
} from "../api/dtos/assist";

/**
 * 回复等待阶段的**只读展示投影**（2026-11-01 AGENT_STREAM_VISIBILITY）。
 *
 * 本文件只把服务端已确认的事实翻成一句等待文案：
 *   * 阶段来自 `message.generationProgress`（由 `model_calls` 与消息状态派生）；
 *   * PENDING 只表示「已提交、Worker 尚未领取」，不写成「正在生成」；
 *   * 没有阶段读数（旧服务端、未知枚举）只回退到「正在生成」，不从等待时长推断。
 *
 * 2026-11-10：聊天流只保留这一行阶段文案。逐段耗时（提交→请求登记、首流、
 * 首正文、首预览）不再在阶段行下展开，原始时间戳随「导出会话」的 `model_calls`
 * 提供；本文件不再派生诊断读数。
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
