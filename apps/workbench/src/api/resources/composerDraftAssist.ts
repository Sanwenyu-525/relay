import { RelayTransportError } from "../core/errors";
import type { RelayHttp } from "../core/http";
import { nullableInteger, nullableString, object, string } from "../core/primitives";

/**
 * 发送前草稿辅助（工作台 §30）。
 *
 * 客户端**不**做切片、不猜边界：服务端只回三态——分点建议文本、润色文本、或「没有建议」。
 * 这样「按原文切片」的保真只在服务端一处实现，前端不可能用模型改写文本冒充原文。
 */

export type ComposerDraftOperation = "OUTLINE" | "POLISH";

export type RelayComposerDraftAssist =
  | { readonly status: "OUTLINE"; readonly itemCount: number; readonly text: string }
  | { readonly status: "POLISH"; readonly text: string }
  | { readonly status: "NO_SUGGESTION" };

export async function requestComposerDraftAssist(http: RelayHttp, input: {
  readonly operation: ComposerDraftOperation;
  readonly text: string;
  readonly signal?: AbortSignal;
}): Promise<RelayComposerDraftAssist> {
  const body = object(await http.request(http.workspacePath("/composer/draft-assist"), {
    method: "POST",
    body: JSON.stringify({ operation: input.operation, text: input.text }),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  }, 200), "composer draft assist");
  const status = string(body, "status", "composer draft assist");
  if (status === "OUTLINE") {
    const itemCount = nullableInteger(body, "item_count", "composer draft assist");
    const text = nullableString(body, "text", "composer draft assist");
    // 标着 OUTLINE 却没有可用文本/条目数：按不可核对处理，调用方保留原草稿。
    if (itemCount === null || text === null) {
      throw new RelayTransportError("分点建议无法核对，草稿已保留。");
    }
    return { status: "OUTLINE", itemCount, text };
  }
  if (status === "POLISH") {
    const text = nullableString(body, "text", "composer draft assist");
    if (text === null || text === "") {
      throw new RelayTransportError("润色结果无法核对，草稿已保留。");
    }
    return { status: "POLISH", text };
  }
  if (status === "NO_SUGGESTION") return { status: "NO_SUGGESTION" };
  throw new RelayTransportError("草稿辅助返回了未知状态，草稿已保留。");
}
