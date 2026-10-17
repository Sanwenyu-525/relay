import type { RelayHttp } from "../core/http";
import { array, boolean, nullableInteger, nullableString, object, string, stringList } from "../core/primitives";

export interface RelayAssistModelRuntime {
  readonly messageId: string;
  readonly messageStatus: string;
  readonly snapshotAvailable: boolean;
  readonly preferredModel: string | null;
  readonly candidateModels: readonly string[];
  readonly currentCandidateModel: string | null;
  readonly actualModel: string | null;
  readonly maxCandidates: number | null;
  readonly routingStatus: string | null;
  readonly failureScope: string | null;
  readonly failureReason: string | null;
  readonly retryAfterAt: string | null;
  readonly freeDailyRemaining: number | null;
  readonly switches: readonly { fromModel: string | null; toModel: string | null; reason: string | null }[];
  readonly calls: readonly { id: string; model: string; status: string; inputTokens: number | null; outputTokens: number | null }[];
}

export async function getAssistModelRuntime(http: RelayHttp, messageId: string): Promise<RelayAssistModelRuntime> {
  const row = object(await http.request(http.workspacePath(`/assist-messages/${encodeURIComponent(messageId)}/model-runtime`)), "model runtime");
  if (string(row, "message_id", "model runtime") !== messageId) throw new Error("模型调用记录与当前消息不匹配。");
  return { messageId, messageStatus: string(row, "message_status", "model runtime"),
    snapshotAvailable: boolean(row, "snapshot_available", "model runtime"),
    preferredModel: nullableString(row, "preferred_model", "model runtime"),
    candidateModels: stringList(row, "candidate_models", "model runtime"),
    currentCandidateModel: nullableString(row, "current_candidate_model", "model runtime"),
    actualModel: nullableString(row, "actual_model", "model runtime"),
    maxCandidates: nullableInteger(row, "max_candidates", "model runtime"),
    routingStatus: nullableString(row, "routing_status", "model runtime"),
    failureScope: nullableString(row, "failure_scope", "model runtime"),
    failureReason: nullableString(row, "failure_reason", "model runtime"),
    retryAfterAt: nullableString(row, "retry_after_at", "model runtime"),
    freeDailyRemaining: nullableInteger(row, "free_daily_remaining", "model runtime"),
    switches: array(row, "switches", "model runtime").map((value) => {
      const item = object(value, "model switch");
      return { fromModel: nullableString(item, "from_model", "model switch"),
        toModel: nullableString(item, "to_model", "model switch"), reason: nullableString(item, "reason", "model switch") };
    }),
    calls: array(row, "calls", "model runtime").map((value) => {
      const item = object(value, "model call");
      return { id: string(item, "id", "model call"), model: string(item, "model", "model call"),
        status: string(item, "status", "model call"), inputTokens: nullableInteger(item, "input_tokens", "model call"),
        outputTokens: nullableInteger(item, "output_tokens", "model call") };
    }) };
}
