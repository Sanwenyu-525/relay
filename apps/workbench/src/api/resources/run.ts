import { isRunEventCursor } from "../runEvents";
import { readRunEventHints } from "../runEvents";
import type { DecimalRevision } from "../../types";
import { RelayRunEventHttpError, RelayTransportError } from "../core/errors";
import { RelayHttp } from "../core/http";
import { array, boolean, decimal, directList, nullableString, object, optionalString, string } from "../core/primitives";
import { assistSourceBody, runToolCallPreviewsFrom, runToolCallsFrom } from "../parse/assist";
import { commandEnvelopeFrom } from "../parse/projects";
import { commandOutputFrom, contextBuildFrom, contextManifestDetailFrom, contextManifestSummaryFrom, controlRequestFrom, controlSubmissionFrom, delegateSubmissionFrom, reviewFrom, runFrom, runTraceFrom } from "../parse/run";
import type { RelayAssistSourceRef, RelayRunToolCallPreviews, RelayRunToolCalls } from "../dtos/assist";
import type { RelayFileReadAction, RelayMockGatewayAction, RelayWebFetchAction } from "../dtos/gateway";
import type { RelayCommandEnvelope, RelayCommandReceipt } from "../dtos/projects";
import type { RelayContextManifestDetail, RelayContextManifestList, RelayControlRequest, RelayControlSubmission, RelayControlType, RelayDelegateSubmission, RelayResumeSubmission, RelayReview, RelayReviewDecision, RelayRun, RelayRunDraftPreview, RelayRunGatewayOperation, RelayRunTrace } from "../dtos/run";

export async function getCommandReceipt(http: RelayHttp, commandId: string): Promise<RelayCommandReceipt> {
  const body = await http.request(http.workspacePath(`/commands/${encodeURIComponent(commandId)}`));
  const envelope = commandEnvelopeFrom(body);
  const record = object(body, "command receipt");
  return { ...envelope, commandType: string(record, "command_type", "command receipt") };
}

export async function getReviews(http: RelayHttp): Promise<readonly RelayReview[]> {
  const body = await http.request(`${http.workspacePath("/reviews")}?status=OPEN`);
  const record = object(body, "review list");
  return array(record, "items", "review list").map(reviewFrom);
}

export async function getReview(http: RelayHttp, reviewId: string): Promise<RelayReview> {
  return reviewFrom(await http.request(http.workspacePath(`/reviews/${encodeURIComponent(reviewId)}`)));
}

export async function delegateTask(http: RelayHttp, input: { readonly taskId: string; readonly commandId: string; readonly expectedTaskRevision: DecimalRevision; readonly mockGatewayAction?: RelayMockGatewayAction; readonly fileReadAction?: RelayFileReadAction; readonly webFetchAction?: RelayWebFetchAction; readonly contextSources?: readonly RelayAssistSourceRef[]; }): Promise<RelayDelegateSubmission> {
  const body = await http.request(http.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/delegations`), {
    method: "POST",
    body: JSON.stringify({ command_id: input.commandId, expected_task_revision: input.expectedTaskRevision,
      ...(input.contextSources?.length ? { context_sources: input.contextSources.map(assistSourceBody) } : {}),
      ...(input.mockGatewayAction === undefined ? {} : { mock_gateway_action: {
        connection_id: input.mockGatewayAction.connectionId,
        resource_id: input.mockGatewayAction.resourceId,
        target: input.mockGatewayAction.target,
        content: input.mockGatewayAction.content
      } }),
      ...(input.fileReadAction === undefined ? {} : { file_read_action: {
        connection_id: input.fileReadAction.connectionId,
        resource_id: input.fileReadAction.resourceId,
        relative_target: input.fileReadAction.relativeTarget
      } }),
      ...(input.webFetchAction === undefined ? {} : { web_fetch_action: {
        connection_id: input.webFetchAction.connectionId,
        url: input.webFetchAction.url
      } }) })
  }, 202);
  try {
    const envelope = commandEnvelopeFrom(body);
    const result = delegateSubmissionFrom(envelope.result);
    if (envelope.commandId !== input.commandId || result.taskId !== input.taskId) throw new Error("Delegate 回执与命令不匹配。");
    return result;
  } catch {
    throw new RelayTransportError("Delegate 回执无法核对，请查询原 command_id。");
  }
}

export async function getRun(http: RelayHttp, runId: string): Promise<RelayRun> {
  return runFrom(await http.request(http.workspacePath(`/runs/${encodeURIComponent(runId)}`)));
}

export async function getRunDraftPreview(http: RelayHttp, runId: string): Promise<RelayRunDraftPreview> {
  const row = object(await http.request(http.workspacePath(`/runs/${encodeURIComponent(runId)}/draft-preview`)),
    "Run DRAFT preview");
  if (string(row, "run_id", "Run DRAFT preview") !== runId) {
    throw new RelayTransportError("Run 草稿预览与当前执行记录不匹配。");
  }
  const epoch = nullableString(row, "attempt_claim_epoch", "Run DRAFT preview");
  if (epoch !== null && !/^\d+$/u.test(epoch)) throw new RelayTransportError("Run 草稿轮次序号无效。");
  const available = boolean(row, "preview_available", "Run DRAFT preview");
  const stepAttemptId = nullableString(row, "step_attempt_id", "Run DRAFT preview");
  const modelCallId = nullableString(row, "model_call_id", "Run DRAFT preview");
  const previewText = nullableString(row, "preview_text", "Run DRAFT preview");
  if (available && (stepAttemptId === null || epoch === null) || previewText !== null && modelCallId === null) {
    throw new RelayTransportError("Run 草稿预览缺少当前轮次身份。");
  }
  return { runId, runStatus: string(row, "run_status", "Run DRAFT preview"),
    stepAttemptId, attemptClaimEpoch: epoch, modelCallId,
    previewRevision: decimal(row, "preview_revision", "Run DRAFT preview"),
    previewText, previewTruncated: boolean(row, "preview_truncated", "Run DRAFT preview"),
    previewAvailable: available };
}

export async function getRunTrace(http: RelayHttp, runId: string): Promise<RelayRunTrace> {
  return runTraceFrom(await http.request(http.workspacePath(`/runs/${encodeURIComponent(runId)}/trace`)));
}

export async function getRunToolCalls(http: RelayHttp, runId: string): Promise<RelayRunToolCalls> {
  return runToolCallsFrom(await http.request(
    http.workspacePath(`/runs/${encodeURIComponent(runId)}/tool-calls`)));
}

/** 生成中的工具预览（工作台 §34.4）：可丢弃、可空；Run 终态或调用已结算时为空列表。 */
export async function getRunToolCallPreviews(http: RelayHttp, runId: string): Promise<RelayRunToolCallPreviews> {
  return runToolCallPreviewsFrom(await http.request(
    http.workspacePath(`/runs/${encodeURIComponent(runId)}/tool-call-previews`)));
}

export async function getRunGatewayOperations(http: RelayHttp, runId: string): Promise<readonly RelayRunGatewayOperation[]> {
  const body = await http.request(http.workspacePath(`/runs/${encodeURIComponent(runId)}/operations`));
  return directList(body, "Run operation list", (item) => {
    const row = object(item, "Run operation");
    const operationId = string(row, "id", "Run operation");
    const invocations = array(row, "invocations", "Run operation").map((invocation) => {
      const record = object(invocation, "Run invocation");
      const invocationId = optionalString(record, "id");
      return { id: invocationId, status: string(record, "status", "Run invocation"),
        createdAt: optionalString(record, "created_at"),
        resolvedAt: record.resolved_at === undefined || record.resolved_at === null
          ? null : string(record, "resolved_at", "Run invocation"),
        commandOutput: commandOutputFrom(record.result_ref, invocationId, operationId) };
    });
    return { id: operationId, status: string(row, "status", "Run operation"),
      actionType: string(row, "action_type", "Run operation"),
      normalizedTarget: string(row, "normalized_target", "Run operation"),
      invocationStatuses: invocations.map((invocation) => invocation.status),
      invocations };
  });
}

/** One authenticated SSE connection. The caller owns reconnects and authoritative GET refreshes. */
export async function readRunEvents(http: RelayHttp, runId: string, after: string, signal: AbortSignal, onEvent: (seq: string) => void, onOpen: () => void): Promise<void> {
  if (!isRunEventCursor(after)) throw new Error("执行事件游标无效。");
  let response: Response;
  try {
    response = await fetch(`${http.baseUrl}${http.workspacePath(`/runs/${encodeURIComponent(runId)}/events`)}?after=${after}`, {
      headers: { Accept: "text/event-stream", Authorization: http.authHeader },
      cache: "no-store",
      signal
    });
  } catch {
    if (signal.aborted) return;
    throw new RelayTransportError("执行事件连接中断。");
  }
  if (signal.aborted) return;
  if (!response.ok) throw new RelayRunEventHttpError(response.status);
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) {
    throw new RelayTransportError("服务端没有返回执行事件流。");
  }
  onOpen();
  await readRunEventHints(response.body, after, signal, onEvent);
}

export async function getRunContextManifests(http: RelayHttp, runId: string): Promise<RelayContextManifestList> {
  const record = object(await http.request(http.workspacePath(`/runs/${encodeURIComponent(runId)}/context-manifests`)), "context manifest list");
  return {
    items: array(record, "items", "context manifest list").map((item) => contextManifestSummaryFrom(item, runId)),
    build: contextBuildFrom(record.build)
  };
}

export async function getRunContextManifest(http: RelayHttp, runId: string, manifestId: string): Promise<RelayContextManifestDetail> {
  const body = await http.request(http.workspacePath(`/runs/${encodeURIComponent(runId)}/context-manifests/${encodeURIComponent(manifestId)}`));
  return contextManifestDetailFrom(body, runId, manifestId);
}

export async function getRunReviews(http: RelayHttp, runId: string): Promise<readonly RelayReview[]> {
  const body = await http.request(http.workspacePath(`/runs/${encodeURIComponent(runId)}/reviews`));
  return array(object(body, "run reviews"), "items", "run reviews").map(reviewFrom);
}

export async function getControlRequest(http: RelayHttp, runId: string, requestId: string): Promise<RelayControlRequest> {
  const body = await http.request(http.workspacePath(`/runs/${encodeURIComponent(runId)}/control-requests/${encodeURIComponent(requestId)}`));
  return controlRequestFrom(body);
}

export async function requestRunControl(http: RelayHttp, input: { readonly runId: string; readonly commandId: string; readonly expectedTaskRevision: DecimalRevision; readonly expectedRunRevision: DecimalRevision; readonly type: RelayControlType; }): Promise<RelayControlSubmission> {
  const body = await http.request(http.workspacePath(`/runs/${encodeURIComponent(input.runId)}/control-requests`), {
    method: "POST",
    body: JSON.stringify({
      command_id: input.commandId,
      expected_task_revision: input.expectedTaskRevision,
      expected_run_revision: input.expectedRunRevision,
      type: input.type
    })
  }, 202);
  try {
    const envelope = commandEnvelopeFrom(body);
    const result = controlSubmissionFrom(envelope.result);
    if (envelope.commandId !== input.commandId || result.runId !== input.runId || result.type !== input.type) {
      throw new Error("控制回执与提交的命令不匹配。");
    }
    return result;
  } catch {
    throw new RelayTransportError("控制回执无法核对，请查询原 command_id。");
  }
}

export async function resumeRun(http: RelayHttp, input: { readonly runId: string; readonly commandId: string; readonly expectedTaskRevision: DecimalRevision; readonly expectedRunRevision: DecimalRevision; }): Promise<RelayResumeSubmission> {
  const body = await http.request(http.workspacePath(`/runs/${encodeURIComponent(input.runId)}/resume`), {
    method: "POST",
    body: JSON.stringify({
      command_id: input.commandId,
      expected_task_revision: input.expectedTaskRevision,
      expected_run_revision: input.expectedRunRevision
    })
  }, 202);
  try {
    const envelope = commandEnvelopeFrom(body);
    const result = {
      runId: string(envelope.result, "run_id", "resume result"),
      status: string(envelope.result, "status", "resume result"),
      runRevision: decimal(envelope.result, "run_revision", "resume result")
    };
    if (envelope.commandId !== input.commandId || result.runId !== input.runId) {
      throw new Error("恢复回执与提交的命令不匹配。");
    }
    return result;
  } catch {
    throw new RelayTransportError("恢复回执无法核对，请查询原 command_id。");
  }
}

export async function decideReview(http: RelayHttp, input: { readonly reviewId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; readonly targetHash: string; readonly decision: RelayReviewDecision; readonly feedback?: string; readonly retryBudget?: number; }): Promise<RelayCommandEnvelope> {
  const body = await http.request(http.workspacePath(`/reviews/${encodeURIComponent(input.reviewId)}/decisions`), {
    method: "POST",
    body: JSON.stringify({
      command_id: input.commandId,
      expected_revision: input.expectedRevision,
      target_hash: input.targetHash,
      decision: input.decision,
      ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
      ...(input.retryBudget === undefined ? {} : { retry_budget: input.retryBudget })
    })
  });
  try {
    const envelope = commandEnvelopeFrom(body);
    const result = envelope.result;
    if (envelope.commandId !== input.commandId || result.review_id !== input.reviewId ||
        result.decision !== input.decision || typeof result.decision_id !== "string" ||
        typeof result.revision !== "string" || !/^\d+$/.test(result.revision)) throw new Error("Review 回执与决定不匹配。");
    return envelope;
  } catch {
    throw new RelayTransportError("Review 决定回执无法核对，请查询原 command_id。");
  }
}
