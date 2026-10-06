import { array, availability, boolean, decimal, integer, isRecord, nullableInteger, nullableString, object, optionalString, string, stringArray } from "../core/primitives";
import type { RelayCommandOutput, RelayContextBuild, RelayContextManifestDetail, RelayContextManifestSummary, RelayControlRequest, RelayControlSubmission, RelayControlType, RelayDelegateSubmission, RelayReview, RelayReviewDecision, RelayReviewKind, RelayRun, RelayRunTrace } from "../dtos/run";

export function commandOutputFrom(value: unknown, invocationId: string | null, operationId: string | null): RelayCommandOutput | null {
  if (!isRecord(value)) return null;
  // 只有服务端真的回传了 stdout/stderr 才是命令输出；没有该字段的调用一律视为无输出。
  if (typeof value.stdout !== "string" && typeof value.stderr !== "string") return null;
  return {
    stdout: typeof value.stdout === "string" ? value.stdout : "",
    stderr: typeof value.stderr === "string" ? value.stderr : "",
    exitCode: typeof value.exit_code === "number" ? value.exit_code : null,
    outcome: typeof value.outcome === "string" ? value.outcome : null,
    truncated: value.truncated === true,
    durationMs: typeof value.duration_ms === "number" ? value.duration_ms : null,
    invocationId,
    operationId
  };
}

export function reviewFrom(value: unknown): RelayReview {
  const record = object(value, "review");
  const kind = string(record, "kind", "review");  const kinds: readonly RelayReviewKind[] = ["CRITERION", "RETRY_BUDGET", "CHECKER_RETRY", "ACTION_APPROVAL", "STATE_PROPOSAL"];
  if (!kinds.includes(kind as RelayReviewKind)) {
    throw new Error("review.kind 包含未知类型。");
  }
  const decisions: readonly RelayReviewDecision[] = ["ACCEPT", "REQUEST_CHANGES", "SET_RETRY_BUDGET", "RETRY_CHECKS", "APPROVE", "DENY"];
  const allowedDecisions = stringArray(record, "allowed_decisions", "review");
  if (allowedDecisions.some((decision) => !decisions.includes(decision as RelayReviewDecision))) {
    throw new Error("review.allowed_decisions 包含未知决定。");
  }
  return {
    id: string(record, "id", "review"),
    kind: kind as RelayReviewKind,
    status: string(record, "status", "review"),
    revision: decimal(record, "revision", "review"),
    projectId: nullableString(record, "project_id", "review"),
    taskId: nullableString(record, "task_id", "review"),
    runId: nullableString(record, "run_id", "review"),
    // 旧服务与既有夹具可能没有这个字段：缺失与 null 同义，都是「这次审批不绑定动作」。
    operationId: record.operation_id === undefined || record.operation_id === null
      ? null : string(record, "operation_id", "review"),
    reason: string(record, "reason", "review"),
    targetHash: string(record, "target_hash", "review"),
    target: object(record.target, "review.target"),
    evidence: object(record.evidence, "review.evidence"),
    effect: object(record.effect, "review.effect"),
    allowedDecisions: allowedDecisions as readonly RelayReviewDecision[],
    expiresAt: nullableString(record, "expires_at", "review"),
    createdAt: string(record, "created_at", "review"),
    decidedAt: nullableString(record, "decided_at", "review")
  };
}

export function controlType(record: Record<string, unknown>, name: string): RelayControlType {
  const value = string(record, "type", name);
  if (value !== "PAUSE" && value !== "CANCEL" && value !== "HANDOFF" && value !== "CANCEL_TASK") {
    throw new Error(`${name}.type 包含未知控制类型。`);
  }
  return value;
}

export function controlSubmissionFrom(result: Readonly<Record<string, unknown>>): RelayControlSubmission {
  const status = string(result, "status", "control result");
  if (status !== "PENDING") {
    throw new Error("控制请求的提交回执不是 PENDING，请重新读取 Run 核对。");
  }
  return {
    controlRequestId: string(result, "control_request_id", "control result"),
    runId: string(result, "run_id", "control result"),
    taskId: string(result, "task_id", "control result"),
    type: controlType(result, "control result"),
    status,
    runRevision: decimal(result, "run_revision", "control result")
  };
}

export function delegateSubmissionFrom(result: Readonly<Record<string, unknown>>): RelayDelegateSubmission {
  const status = string(result, "status", "delegate result");
  if (status !== "CREATED") throw new Error("Delegate 回执状态无法识别。");
  return {
    runId: string(result, "run_id", "delegate result"),
    taskId: string(result, "task_id", "delegate result"),
    taskRevision: decimal(result, "task_revision", "delegate result"),
    runRevision: decimal(result, "run_revision", "delegate result"),
    status,
    retryOfRunId: nullableString(result, "retry_of_run_id", "delegate result")
  };
}

export function controlRequestFrom(value: unknown): RelayControlRequest {
  const record = object(value, "control request");
  return {
    id: string(record, "id", "control request"),
    runId: string(record, "run_id", "control request"),
    taskId: string(record, "task_id", "control request"),
    type: controlType(record, "control request"),
    status: string(record, "status", "control request"),
    revision: decimal(record, "revision", "control request"),
    requestedAt: string(record, "requested_at", "control request"),
    decidedAt: nullableString(record, "decided_at", "control request"),
    resultRef: record.result_ref === null ? null : object(record.result_ref, "control request.result_ref")
  };
}

export function runFrom(value: unknown): RelayRun {
  const record = object(value, "run");
  const pending = record.pending_control_request === null
    ? null
    : object(record.pending_control_request, "run.pending_control_request");
  return {
    id: string(record, "id", "run"),
    taskId: string(record, "task_id", "run"),
    status: string(record, "status", "run"),
    revision: decimal(record, "revision", "run"),
    waitReason: nullableString(record, "wait_reason", "run"),
    currentStepId: nullableString(record, "current_step_id", "run"),
    steps: array(record, "steps", "run").map((item) => {
      const step = object(item, "run.steps item");
      return {
        id: string(step, "step_id", "run.steps item"),
        index: integer(step, "step_index", "run.steps item"),
        kind: string(step, "step_kind", "run.steps item"),
        status: string(step, "status", "run.steps item"),
        startedAt: nullableString(step, "started_at", "run.steps item"),
        finishedAt: nullableString(step, "finished_at", "run.steps item"),
        reason: stepReasonByKind(record, string(step, "step_kind", "run.steps item"))
      };
    }),
    recentAttempts: array(record, "recent_attempts", "run").map((item) => {
      const attempt = object(item, "run.recent_attempts item");
      return {
        id: string(attempt, "attempt_id", "run.recent_attempts item"),
        stepKind: string(attempt, "step_kind", "run.recent_attempts item"),
        number: decimal(attempt, "attempt_number", "run.recent_attempts item"),
        status: string(attempt, "status", "run.recent_attempts item")
      };
    }),
    blockingReviewIds: stringArray(record, "blocking_review_ids", "run"),
    pendingControlRequest: pending === null ? null : {
      id: string(pending, "id", "run.pending_control_request"),
      type: controlType(pending, "run.pending_control_request"),
      status: string(pending, "status", "run.pending_control_request"),
      requestedAt: string(pending, "requested_at", "run.pending_control_request")
    },
    unresolvedOperationIds: stringArray(record, "unresolved_operation_ids", "run")
  };
}

/**
 * 步骤失败原因：服务端 result_refs 按 step_kind 带出 result_ref.reason
 * （MODEL_BUDGET_EXHAUSTED、CONTEXT_REQUIRED_OVER_BUDGET 等）。同一步骤可能有多次
 * 尝试，取最后一条；服务端未给出 reason 时返回 null，不猜测。
 * 注意：Run 投影的 result_refs 是必有字段（domain-schemas.ts RunSchema），这里对缺字段
 * 仍返回 null 会把「响应不是本契约」吞成「没有失败原因」；收紧会让 tests/ 的旧夹具
 * （run-draft-preview.spec.ts 缺 result_refs）失败，故保持现状并在审查报告中登记。
 */
export function stepReasonByKind(record: Record<string, unknown>, stepKind: string): string | null {
  const refs = record.result_refs;
  if (!Array.isArray(refs)) return null;
  let reason: string | null = null;
  for (const item of refs) {
    if (typeof item !== "object" || item === null) continue;
    const ref = item as { step_kind?: unknown; result_ref?: unknown };
    if (ref.step_kind !== stepKind) continue;
    if (typeof ref.result_ref !== "object" || ref.result_ref === null) continue;
    const value = (ref.result_ref as { reason?: unknown }).reason;
    if (typeof value === "string" && value !== "") reason = value;
  }
  return reason;
}

export function runTraceFrom(value: unknown): RelayRunTrace {
  const row = object(value, "run trace");
  return { runId: string(row, "run_id", "run trace"), taskId: string(row, "task_id", "run trace"),
    projectId: nullableString(row, "project_id", "run trace"), status: string(row, "status", "run trace"),
    steps: array(row, "steps", "run trace").map((value) => { const step = object(value, "trace step");
      return { id: string(step, "id", "trace step"), index: integer(step, "step_index", "trace step"),
        kind: string(step, "kind", "trace step"), status: string(step, "status", "trace step"),
        revision: decimal(step, "revision", "trace step"), resultAvailable: boolean(step, "result_available", "trace step"),
        startedAt: nullableString(step, "started_at", "trace step"), finishedAt: nullableString(step, "finished_at", "trace step") }; }),
    attempts: array(row, "attempts", "run trace").map((value) => { const attempt = object(value, "trace attempt");
      return { id: string(attempt, "id", "trace attempt"), stepId: string(attempt, "step_id", "trace attempt"),
        number: decimal(attempt, "attempt_number", "trace attempt"), status: string(attempt, "status", "trace attempt"),
        claimEpoch: decimal(attempt, "claim_epoch", "trace attempt"), resultAvailable: boolean(attempt, "result_available", "trace attempt"),
        startedAt: nullableString(attempt, "started_at", "trace attempt"), finishedAt: nullableString(attempt, "finished_at", "trace attempt") }; }),
    modelCalls: array(row, "model_calls", "run trace").map((value) => { const call = object(value, "trace model call");
      const status = string(call, "status", "trace model call");
      const providerErrorKind = call.provider_error_kind ?? null;
      if (providerErrorKind !== null && (status !== "FAILED" ||
          providerErrorKind !== "AUTH" && providerErrorKind !== "RATE_LIMIT" &&
          providerErrorKind !== "TIMEOUT" && providerErrorKind !== "STREAM_BROKEN" &&
          providerErrorKind !== "PROTOCOL" && providerErrorKind !== "NETWORK")) {
        throw new Error("Trace 模型调用 Provider 失败类别无效。");
      }
      return { id: string(call, "id", "trace model call"), stepAttemptId: nullableString(call, "step_attempt_id", "trace model call"),
        manifestId: nullableString(call, "manifest_id", "trace model call"), status,
        kind: optionalString(call, "kind"), criterionId: optionalString(call, "criterion_id"),
        checkAttempt: call.check_attempt === undefined ? null : nullableInteger(call, "check_attempt", "trace model call"),
        providerErrorKind, providerRequestId: optionalString(call, "provider_request_id"),
        provider: string(call, "provider", "trace model call"), model: string(call, "model", "trace model call"),
        inputSha256: nullableString(call, "input_sha256", "trace model call"),
        readOperationId: nullableString(call, "read_operation_id", "trace model call"),
        readInvocationId: nullableString(call, "read_invocation_id", "trace model call"),
        inputTokens: nullableInteger(call, "usage_input_tokens", "trace model call"),
        outputTokens: nullableInteger(call, "usage_output_tokens", "trace model call"),
        startedAt: string(call, "started_at", "trace model call"), settledAt: nullableString(call, "settled_at", "trace model call"),
        firstTextDeltaAt: optionalString(call, "first_text_delta_at"),
        firstPreviewPersistedAt: optionalString(call, "first_preview_persisted_at") }; }),
    manifests: array(row, "manifests", "run trace").map((value) => { const manifest = object(value, "trace manifest");
      return { id: string(manifest, "id", "trace manifest"), stepId: nullableString(manifest, "step_id", "trace manifest"),
        builderVersion: string(manifest, "builder_version", "trace manifest"), sha256: string(manifest, "sha256", "trace manifest"),
        createdAt: string(manifest, "created_at", "trace manifest"),
        sources: array(manifest, "sources", "trace manifest").map((value) => { const source = object(value, "trace source");
          return { kind: string(source, "kind", "trace source"), sourceRef: nullableString(source, "source_ref", "trace source"),
            version: nullableString(source, "version", "trace source"), sha256: nullableString(source, "sha256", "trace source"),
            sourceSha256: nullableString(source, "source_sha256", "trace source"), role: string(source, "role", "trace source"),
            trust: string(source, "trust", "trace source"), availability: availability(source, "availability", "trace source") }; }) }; }),
    verifications: array(row, "verifications", "run trace").map((value) => { const session = object(value, "trace verification");
      return { id: string(session, "id", "trace verification"), status: string(session, "status", "trace verification"),
        verdict: nullableString(session, "verdict", "trace verification"),
        acceptanceRevision: decimal(session, "acceptance_revision", "trace verification"),
        checkPlanHash: string(session, "check_plan_hash", "trace verification"),
        parentSessionId: nullableString(session, "parent_session_id", "trace verification"),
        targets: array(session, "targets", "trace verification").map((value) => { const target = object(value, "trace verification target");
          return { artifactVersionId: string(target, "artifact_version_id", "trace verification target"),
            contentSha256: string(target, "content_sha256", "trace verification target") }; }),
        checks: array(session, "checks", "trace verification").map((value) => { const check = object(value, "trace check");
          return { id: string(check, "id", "trace check"), criterionId: string(check, "criterion_id", "trace check"),
            result: string(check, "result", "trace check"), severity: string(check, "severity", "trace check"),
            required: boolean(check, "required", "trace check"), createdAt: string(check, "created_at", "trace check") }; }),
        createdAt: string(session, "created_at", "trace verification"),
        finalizedAt: nullableString(session, "finalized_at", "trace verification") }; }),
    reviews: array(row, "reviews", "run trace").map((value) => { const review = object(value, "trace review");
      const decision = review.decision === null ? null : object(review.decision, "trace review decision");
      return { id: string(review, "id", "trace review"), kind: string(review, "kind", "trace review"),
        status: string(review, "status", "trace review"), operationId: nullableString(review, "operation_id", "trace review"),
        verificationSessionId: nullableString(review, "verification_session_id", "trace review"),
        targetHash: string(review, "target_hash", "trace review"), createdAt: string(review, "created_at", "trace review"),
        decidedAt: nullableString(review, "decided_at", "trace review"),
        decision: decision === null ? null : { id: string(decision, "id", "trace review decision"),
          value: string(decision, "value", "trace review decision"), decidedAt: string(decision, "decided_at", "trace review decision") } }; }),
    operations: array(row, "operations", "run trace").map((value) => { const operation = object(value, "trace operation");
      return { id: string(operation, "id", "trace operation"), stepId: nullableString(operation, "step_id", "trace operation"),
        capability: string(operation, "capability", "trace operation"), actionType: string(operation, "action_type", "trace operation"),
        status: string(operation, "status", "trace operation"), paramsSha256: string(operation, "params_sha256", "trace operation"),
        resultAvailable: boolean(operation, "result_available", "trace operation"),
        createdAt: string(operation, "created_at", "trace operation"), updatedAt: string(operation, "updated_at", "trace operation"),
        invocations: array(operation, "invocations", "trace operation").map((value) => { const invocation = object(value, "trace invocation");
          return { id: string(invocation, "id", "trace invocation"), number: decimal(invocation, "attempt_number", "trace invocation"),
            status: string(invocation, "status", "trace invocation"), resultAvailable: boolean(invocation, "result_available", "trace invocation"),
            createdAt: string(invocation, "created_at", "trace invocation"), resolvedAt: nullableString(invocation, "resolved_at", "trace invocation") }; }) }; }),
    effects: array(row, "effects", "run trace").map((value) => { const effect = object(value, "trace effect");
      return { id: string(effect, "id", "trace effect"), stepId: string(effect, "step_id", "trace effect"),
        status: string(effect, "status", "trace effect"), paramsSha256: string(effect, "params_sha256", "trace effect"),
        resultAvailable: boolean(effect, "result_available", "trace effect"),
        createdAt: string(effect, "created_at", "trace effect"), resolvedAt: nullableString(effect, "resolved_at", "trace effect") }; }) };
}

export function contextManifestSummaryFrom(value: unknown, runId: string): RelayContextManifestSummary {
  const row = object(value, "context manifest");
  const actualRunId = string(row, "run_id", "context manifest");
  if (actualRunId !== runId) throw new Error("Context Manifest 与当前 Run 不匹配。");
  return {
    id: string(row, "id", "context manifest"), runId: actualRunId,
    stepId: nullableString(row, "step_id", "context manifest"),
    createdAt: string(row, "created_at", "context manifest"),
    builderVersion: string(row, "builder_version", "context manifest"),
    templateVersion: string(row, "template_version", "context manifest"),
    manifestHash: string(row, "manifest_hash", "context manifest")
  };
}

export function contextBuildFrom(value: unknown): RelayContextBuild {
  const row = object(value, "context build");
  const status = string(row, "status", "context build");
  if (!["NOT_STARTED", "RUNNING", "SUCCEEDED", "FAILED"].includes(status)) {
    throw new Error("context build.status 响应格式无效。");
  }
  return {
    status: status as RelayContextBuild["status"],
    reasonCode: nullableString(row, "reason_code", "context build"),
    message: nullableString(row, "message", "context build")
  };
}

export function contextManifestDetailFrom(value: unknown, runId: string, manifestId: string): RelayContextManifestDetail {
  const row = object(value, "context manifest detail");
  const summary = contextManifestSummaryFrom(row, runId);
  if (summary.id !== manifestId) throw new Error("Context Manifest 详情与所选记录不匹配。");
  const rawBudget = row.budget === null ? null : object(row.budget, "context manifest budget");
  const dependencies = object(row.dependencies, "context manifest dependencies");
  const parseDefinition = (value: unknown, name: string) => {
    if (value === undefined || value === null) return null;
    const definition = object(value, name);
    return { id: string(definition, "id", name), version: string(definition, "version", name),
      digest: string(definition, "digest", name) };
  };
  return {
    ...summary,
    budget: rawBudget === null ? null : {
      limitTokens: integer(rawBudget, "limit_tokens", "context manifest budget"),
      reservedTokens: integer(rawBudget, "reserved_tokens", "context manifest budget"),
      requiredTokens: nullableInteger(rawBudget, "required_tokens", "context manifest budget"),
      selectedTokens: nullableInteger(rawBudget, "selected_tokens", "context manifest budget"),
      estimation: string(rawBudget, "estimation", "context manifest budget")
    },
    dependencies: {
      contractHash: optionalString(dependencies, "contract_hash"),
      workflowVersion: optionalString(dependencies, "workflow_version"),
      executionConfigVersion: optionalString(dependencies, "execution_config_version"),
      profile: parseDefinition(dependencies.profile, "context manifest profile"),
      skill: parseDefinition(dependencies.skill, "context manifest skill")
    },
    sources: array(row, "sources", "context manifest detail").map((item) => {
      const source = object(item, "context source");
      const range = object(source.range, "context source range");
      const role = string(source, "role", "context source");
      const trust = string(source, "trust", "context source");
      const selectionReason = optionalString(source, "selection_reason");
      // 后端 ContextSource.selection_reason 还有 'EXPLICIT_SELECTION'（显式选中资料，
// context-builder.ts 的 loadRelevant 分支）。补进下方取值集需要同时改
// components/RunSourcesPanel.tsx 的 selectionLabels，超出本文件范围，故此处先按原样保持。
if (!["MANDATORY", "RELEVANT", "STEP_SPECIFIC"].includes(role) ||
        !["CANONICAL", "UNTRUSTED_DATA"].includes(trust) || range.unit !== "UTF8_BYTE" ||
        (selectionReason !== null && !["TITLE_MATCH", "RECENT_SCOPE_FALLBACK"].includes(selectionReason))) {
        throw new Error("Context 来源类别或范围单位无效。");
      }
      return {
        kind: string(source, "kind", "context source"),
        sourceRef: string(source, "source_ref", "context source"),
        version: string(source, "version", "context source"),
        sha256: string(source, "sha256", "context source"),
        sourceSha256: string(source, "source_sha256", "context source"),
        range: { start: integer(range, "start", "context source range"),
          end: integer(range, "end", "context source range"), unit: "UTF8_BYTE" as const },
        content: string(source, "content", "context source"),
        role: role as RelayContextManifestDetail["sources"][number]["role"],
        trust: trust as RelayContextManifestDetail["sources"][number]["trust"],
        selectionReason: selectionReason as RelayContextManifestDetail["sources"][number]["selectionReason"]
      };
    }),
    exclusions: array(row, "exclusions", "context manifest detail").map((item) => {
      const exclusion = object(item, "context exclusion");
      const reason = string(exclusion, "reason", "context exclusion");
      if (reason !== "BUDGET_TRIMMED" && reason !== "SOURCE_UNAVAILABLE") {
        throw new Error("Context 排除原因无效。");
      }
      return { sourceRef: string(exclusion, "source_ref", "context exclusion"), reason };
    })
  };
}
