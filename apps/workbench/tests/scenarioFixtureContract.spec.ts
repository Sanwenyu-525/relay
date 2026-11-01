import { describe, expect, it } from "vitest";
import type { RelayHttp } from "../src/api/core/http";
import {
  assistMessageFrom, assistMessageRecallFrom, assistMessageRecallSummaryFrom, assistProposalFrom,
  conversationDiffFileDetailFrom, conversationDiffFrom, conversationExecutionFrom,
  runToolCallPreviewsFrom, runToolCallsFrom, sessionToolCallFrom, sessionToolCallsFrom,
  toolCallFrom, toolCallStatus
} from "../src/api/parse/assist";
import { reviewFrom, runFrom } from "../src/api/parse/run";
import { getFileWriteChangeSets, getFileWriteFrozenDiff } from "../src/api/resources/artifacts";
import { assistLivePreviewFrom } from "../src/api/resources/assist";
import {
  approvalReview, at, assistantMessage, candidateProposal, changeSets, commandResult, draftOf, frozenDiff,
  labRun, livePreview, MARKDOWN_RICH, MOCK, modelCallOf, pair, readCall, recallReceipt, recallSummary,
  runCall, runPreview, runPreviewFile, runProjection, sessionTrace, userMessage
} from "../src/dev/scenarioFixtures";

/**
 * 实验室夹具的数据契约验证（UI-LAB-REAL-PARITY-01 P0-C）。
 *
 * 验的是这一句话：**实验室里那份数据，正是服务端真发出来时产品解析器会解析出来的那个值。**
 *
 * 夹具本来就是 TS DTO 字面量，类型检查只能证明「形状像个 DTO」，证明不了它能从线上响应
 * （snake_case wire）里读出来。字段名写错、状态词表用错一侧、该缺的可选字段缺错了档，
 * 类型全都放行，界面上却是一块永远读不出来的死区域。所以这里把代表性的模拟响应喂给
 * **产品自己的解析函数**，再断言解析结果逐字段等于夹具。
 *
 * 三类用例，缺一不可：
 *   * 正向：夹具的每一族——消息 / 流式草稿 / 会话轮次 / Run 轨迹 / 生成中预览 /
 *     冻结 Diff 与逐文件账本 / 会话总 Diff / 候选提案 / 撤回 / 审批 / Run / 执行结果。
 *   * 合法边界：旧服务端确实没有那些字段时的默认读法——既不报错，也不猜一个值。
 *   * 必须失败：缺必填、状态词不认识、错误类型串了位置、身份对不上。这些不能静默通过。
 *
 * 这里不复制任何解析规则：断言读的是产品的函数、产品的错误文案。
 */

/** 线上响应按字段名写死，「产品改了字段名」一定反映为这里的失败。 */
const wire = (row: Record<string, unknown>): Record<string, unknown> => row;

/** 用真实 client 的解析入口跑一份 wire（这两个方法就是资源层实际用到的全部表面）。 */
function httpReturning(body: unknown): RelayHttp {
  return { workspacePath: (path: string) => path, request: async () => body } as unknown as RelayHttp;
}

/** 服务端消息行的完整线上形状：与 `assistMessageFrom` 逐字段对齐。 */
function wireMessage(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return wire({
    id: MOCK.assistantMessageId, session_id: MOCK.sessionId, seq: "2", role: "ASSISTANT",
    status: "RUNNING", created_at: at(0), updated_at: at(1), intent: "DISCUSS", content: null,
    error_code: null, provider_error_kind: null, sources: [], skill: null, skill_input: null,
    skill_output: null, usage: { input_tokens: 12480, output_tokens: 316, cache_read_tokens: null,
      cache_creation_tokens: null },
    cancel_requested: false, steer_requested: false, attachments: [], withdrawn_at: null,
    withdrawn_by_recall_id: null, recall: null, ...patch
  });
}

function wireSessionCall(call: ReturnType<typeof readCall>): Record<string, unknown> {
  return wire({ id: call.id, round: call.round, ordinal: call.ordinal, tool_name: call.toolName,
    status: call.status, arguments: call.args, rejection_reason: call.rejectionReason,
    rejection_detail: call.rejectionDetail, requested_at: call.requestedAt, settled_at: call.settledAt });
}

function wireRunCall(call: ReturnType<typeof runCall>,
  extra: Record<string, unknown> = {}): Record<string, unknown> {
  return wire({ id: call.id, round: call.round, ordinal: call.ordinal, tool_name: call.toolName,
    status: call.status, arguments: call.args, arguments_sha256: call.argsSha256,
    provider_tool_call_id: call.providerToolCallId, operation_id: call.operationId,
    adaptation_of: call.adaptationOf, adapted_path: call.adaptedPath, result_ref: call.resultRef,
    created_at: call.createdAt, updated_at: call.updatedAt,
    file_changes: call.fileChanges.map((file) => ({ path: file.path, action: file.action,
      status: file.status, added: file.added, removed: file.removed,
      unavailable_reason: file.unavailableReason })), ...extra });
}

function wirePreview(preview: ReturnType<typeof runPreview>,
  files?: readonly Record<string, unknown>[]): Record<string, unknown> {
  return wire({ model_call_id: preview.modelCallId, ordinal: preview.ordinal,
    tool_name: preview.toolName, revision: preview.revision, truncated: preview.truncated,
    updated_at: preview.updatedAt,
    files: files ?? preview.files.map((file) => ({ path: file.path, action: file.action,
      added: file.added, removed: file.removed, target_complete: file.targetComplete })) });
}

function wireReviewShape(): Record<string, unknown> {
  const review = approvalReview(`${MOCK.operationId}-1`);
  return wire({ id: review.id, kind: review.kind, status: review.status, revision: review.revision,
    project_id: review.projectId, task_id: review.taskId, run_id: review.runId,
    operation_id: review.operationId, reason: review.reason, target_hash: review.targetHash,
    target: review.target, evidence: review.evidence, effect: review.effect,
    allowed_decisions: review.allowedDecisions, expires_at: review.expiresAt,
    created_at: review.createdAt, decided_at: review.decidedAt });
}

/** Run 投影的线上形状：步骤失败原因只从 `result_refs` 带出，不写在步骤上。 */
function wireRunShape(status = "RUNNING",
  resultRefs: readonly Record<string, unknown>[] = []): Record<string, unknown> {
  return wire({ id: MOCK.runId, task_id: MOCK.taskId, status, revision: "7", wait_reason: null,
    current_step_id: "mock-step-3", result_refs: resultRefs,
    steps: [{ step_id: "mock-step-1", step_index: 1, step_kind: "GENERATE_CANDIDATE",
      status: "SUCCEEDED", started_at: at(0), finished_at: at(20) },
    { step_id: "mock-step-2", step_index: 2, step_kind: "EXECUTE_TOOL_LOOP",
      status: "SUCCEEDED", started_at: at(20), finished_at: at(48) },
    { step_id: "mock-step-3", step_index: 3, step_kind: "VERIFY_CHECKS",
      status: status === "FAILED" ? "FAILED" : "RUNNING", started_at: at(48), finished_at: null }],
    recent_attempts: [{ attempt_id: "mock-attempt-1", step_kind: "VERIFY_CHECKS",
      attempt_number: "1", status: "RUNNING" }],
    blocking_review_ids: [], pending_control_request: null, unresolved_operation_ids: [] });
}

describe("夹具 ↔ 产品解析器：消息本体", () => {
  it("正常助手消息：解析结果逐字段等于夹具", () => {
    expect(assistMessageFrom(wireMessage({ status: "COMPLETED", content: MARKDOWN_RICH }))).toEqual(
      assistantMessage({ status: "COMPLETED", content: MARKDOWN_RICH }));
  });

  it("一问一答这一对（pair 夹具）两条都读得出来", () => {
    const [expectedUser, expectedAssistant] = pair({ status: "COMPLETED", content: MARKDOWN_RICH });
    expect(assistMessageFrom(wireMessage({ status: "COMPLETED", content: MARKDOWN_RICH })))
      .toEqual(expectedAssistant);
    expect(assistMessageFrom(wireMessage({ id: MOCK.userMessageId, seq: "1", role: "USER",
      status: "COMPLETED", content: expectedUser.content }))).toEqual(expectedUser);
  });

  it("来源、用量与不可用来源：夹具写什么就解析出什么，不给缺位补默认值", () => {
    const parsed = assistMessageFrom(wireMessage({
      status: "COMPLETED", content: "结论来自这三份资料。",
      sources: [{ source_ref: "docs/frontend/workbench-design.md", kind: null, root_id: null,
        version: null, status: "AVAILABLE", reason: null, origin: null },
      { source_ref: "已删除的历史快照", kind: null, root_id: null, version: null,
        status: "UNAVAILABLE", reason: "来源条目已不存在", origin: null }],
      usage: { input_tokens: 48210, output_tokens: 913, cache_read_tokens: 32768,
        cache_creation_tokens: null }
    }));
    expect(parsed.sources).toEqual([
      { sourceRef: "docs/frontend/workbench-design.md", kind: null, rootId: null, version: null,
        status: "AVAILABLE", reason: null, origin: null },
      { sourceRef: "已删除的历史快照", kind: null, rootId: null, version: null, status: "UNAVAILABLE",
        reason: "来源条目已不存在", origin: null }]);
    expect(parsed.usage).toEqual({ inputTokens: 48210, outputTokens: 913, cacheReadTokens: 32768,
      cacheCreationTokens: null });
  });

  it("模型失败：错误码与 Provider 类别一起读回（A14 那一档的形状）", () => {
    expect(assistMessageFrom(wireMessage({ status: "FAILED", error_code: "MODEL_TIMEOUT",
      provider_error_kind: "TIMEOUT" }))).toEqual(
      assistantMessage({ status: "FAILED", errorCode: "MODEL_TIMEOUT", providerErrorKind: "TIMEOUT" }));
  });

  it("取消终态、被撤回标记与撤回摘要都能从同一行读出来", () => {
    expect(assistMessageFrom(wireMessage({ status: "CANCELLED" })).status).toBe("CANCELLED");
    const summary = recallSummary();
    expect(assistMessageFrom(wireMessage({ withdrawn_at: at(90), withdrawn_by_recall_id: summary.id,
      recall: { id: summary.id, message_id: summary.messageId,
        assistant_message_id: summary.assistantMessageId, status: summary.status,
        planned_files: summary.plannedFiles, restored_files: summary.restoredFiles,
        skipped_files: summary.skippedFiles, completed_at: summary.completedAt }
    }))).toEqual(assistantMessage({ withdrawnAt: at(90), withdrawnByRecallId: summary.id,
      recall: summary }));
  });

  it("旧服务端没有那些字段＝合法边界：按默认读，不报错也不猜", () => {
    const legacy = wireMessage();
    for (const key of ["provider_error_kind", "skill_input", "skill_output", "attachments",
      "withdrawn_at", "withdrawn_by_recall_id", "recall", "steer_requested"]) delete legacy[key];
    // cache_* 是 Provider 可选上报项：整段缺失读成「未上报」，不是 0。
    legacy.usage = { input_tokens: 12480, output_tokens: 316 };
    const parsed = assistMessageFrom(legacy);
    expect(parsed.usage).toEqual({ inputTokens: 12480, outputTokens: 316, cacheReadTokens: null,
      cacheCreationTokens: null });
    expect(parsed.attachments).toEqual([]);
    expect(parsed.recall).toBeNull();
    expect(parsed.withdrawnAt).toBeNull();
    expect(parsed.steerRequested).toBe(false);
    expect(parsed).toEqual(assistantMessage());
  });

  it("必须失败：不认识的角色与状态、串到非 FAILED 上的 Provider 类别、缺必填", () => {
    expect(() => assistMessageFrom(wireMessage({ status: "QUEUED" }))).toThrow(/状态无法识别/);
    expect(() => assistMessageFrom(wireMessage({ role: "SYSTEM" }))).toThrow(/角色无法识别/);
    expect(() => assistMessageFrom(wireMessage({ status: "COMPLETED", provider_error_kind: "TIMEOUT" })))
      .toThrow(/Provider 失败类别无效/);
    expect(() => assistMessageFrom(wireMessage({ seq: 2 }))).toThrow(/seq/);
    expect(() => assistMessageFrom(wireMessage({ content: undefined }))).toThrow(/content/);
    expect(() => assistMessageFrom(wireMessage({ usage: null }))).toThrow(/usage/);
  });
});

describe("夹具 ↔ 产品解析器：流式草稿", () => {
  it("草稿帧逐字段等于 livePreview 夹具", () => {
    const text = draftOf(MARKDOWN_RICH, 0.55);
    expect(assistLivePreviewFrom(wire({
      session_id: MOCK.sessionId, message_id: MOCK.assistantMessageId, status: "RUNNING",
      preview_revision: "4", preview_text: text, preview_truncated: false, preview_available: true
    }), MOCK.sessionId, MOCK.assistantMessageId)).toEqual(
      livePreview({ previewRevision: "4", previewText: text, previewAvailable: true }));
  });

  it("截断与终态帧也读得出夹具那一档", () => {
    expect(assistLivePreviewFrom(wire({
      session_id: MOCK.sessionId, message_id: MOCK.assistantMessageId, status: "COMPLETED",
      preview_revision: "9", preview_text: "整段草稿", preview_truncated: true, preview_available: true
    }), MOCK.sessionId, MOCK.assistantMessageId)).toEqual(
      livePreview({ status: "COMPLETED", previewRevision: "9", previewText: "整段草稿",
        previewTruncated: true, previewAvailable: true }));
  });

  it("必须失败：身份对不上与状态不认识走同一句契约错误", () => {
    const base = wire({ session_id: MOCK.sessionId, message_id: MOCK.assistantMessageId,
      status: "RUNNING", preview_revision: "1", preview_text: null, preview_truncated: false,
      preview_available: false });
    // 迟到的别条消息帧：产品把身份核对与词表核对写在同一句里，这里如实认它。
    expect(() => assistLivePreviewFrom(wire({ ...base, message_id: "some-other-message" }),
      MOCK.sessionId, MOCK.assistantMessageId)).toThrow(/不匹配/);
    expect(() => assistLivePreviewFrom(wire({ ...base, session_id: "some-other-session" }),
      MOCK.sessionId, MOCK.assistantMessageId)).toThrow(/不匹配/);
    expect(() => assistLivePreviewFrom(wire({ ...base, status: "QUEUED" }),
      MOCK.sessionId, MOCK.assistantMessageId)).toThrow(/不匹配/);
    expect(() => assistLivePreviewFrom(wire({ ...base, preview_revision: 1 }),
      MOCK.sessionId, MOCK.assistantMessageId)).toThrow(/preview_revision/);
  });
});

describe("夹具 ↔ 产品解析器：工具轨迹（会话侧与 Run 侧词表不混用）", () => {
  it("会话轮次账本：读取、未结算、被拒、未知都从 wire 读得出来", () => {
    const calls = [
      readCall(0, "package.json"),
      readCall(1, "pnpm-workspace.yaml", { status: "REQUESTED", settledAt: null }),
      readCall(2, "docs/README.md", { status: "REJECTED", settledAt: null,
        rejectionReason: "WRITE_OUTSIDE_ALLOWED_ROOT", rejectionDetail: "写入点不在受管目录内" }),
      readCall(3, "apps/workbench/package.json", { status: "UNKNOWN", settledAt: null })
    ];
    const trace = sessionTrace([calls]);
    expect(sessionToolCallsFrom(wire({
      session_id: MOCK.sessionId, message_id: MOCK.assistantMessageId, message_status: "RUNNING",
      rounds: [{ round: 0, calls: calls.map(wireSessionCall) }]
    }))).toEqual(trace);
  });

  it("会话侧的 UNKNOWN 合法、Run 侧的 UNKNOWN 非法：两套词表确实分开", () => {
    expect(sessionToolCallFrom(wireSessionCall(readCall(0, "a.ts", { status: "UNKNOWN" }))))
      .toEqual(readCall(0, "a.ts", { status: "UNKNOWN" }));
    expect(() => toolCallStatus("UNKNOWN")).toThrow(/状态无效/);
    expect(() => toolCallFrom(wireRunCall(runCall(0, { toolName: "read_file",
      status: "UNKNOWN" as never }))))
      .toThrow(/状态无效/);
  });

  it("Run 轨迹：参数、命令回执与逐文件账本一起等于夹具", () => {
    const calls = [
      runCall(0, { toolName: "read_file", args: { relative_path: "package.json" } }),
      runCall(1, { toolName: "run_command", args: { check_id: "typecheck" },
        operationId: `${MOCK.operationId}-2`, resultRef: commandResult("done", 0) }),
      runCall(2, { toolName: "apply_changeset", status: "WAITING_APPROVAL",
        fileChanges: [{ path: "src/lib/order.ts", action: "MODIFY", status: "APPLIED", added: 4,
          removed: 1, unavailableReason: null }] })
    ];
    const projection = runProjection([calls]);
    expect(runToolCallsFrom(wire({
      run_id: MOCK.runId, run_status: "RUNNING", wait_reason: null,
      rounds: projection.rounds.map((round, index) => ({ round: index,
        model_call_id: round.modelCallId, calls: calls.map(wireRunCall) }))
    }))).toEqual(projection);
  });

  it("生成中的写入预览：-1 读成待核对，不折算成 0", () => {
    const preview = runPreview(modelCallOf(1), 0, [
      runPreviewFile({ path: "src/lib/order.ts", added: -1, removed: -1 }),
      runPreviewFile({ path: "src/lib/new.ts", action: "CREATE", added: 12, removed: 0,
        targetComplete: false })
    ]);
    expect(runToolCallPreviewsFrom(wire({ run_id: MOCK.runId, previews: [wirePreview(preview)] })))
      .toEqual({ runId: MOCK.runId, previews: [preview] });
  });

  it("必须失败：账本缺轮次、文件动作不认识、预览的文件动作不认识", () => {
    expect(() => runToolCallsFrom(wire({ run_id: MOCK.runId, run_status: "RUNNING" })))
      .toThrow(/rounds/);
    expect(() => toolCallFrom(wireRunCall(runCall(0, { toolName: "read_file" }),
      { file_changes: [{ path: "a.ts", action: "RENAME", status: "APPLIED", added: 1, removed: 0,
        unavailable_reason: null }] }))).toThrow(/文件动作无法识别/);
    expect(() => toolCallFrom(wireRunCall(runCall(0, { toolName: "read_file" }),
      { file_changes: [{ path: "a.ts", action: "MODIFY", status: "SETTLED", added: 1, removed: 0,
        unavailable_reason: null }] }))).toThrow(/文件状态无法识别/);
    expect(() => runToolCallPreviewsFrom(wire({ run_id: MOCK.runId,
      previews: [wirePreview(runPreview(modelCallOf(0), 0, [runPreviewFile({ path: "a.ts" })]),
        [{ path: "a.ts", action: "RENAME", added: 1, removed: 0, target_complete: true }])] })))
      .toThrow(/文件动作无效/);
  });
});

describe("夹具 ↔ 产品解析器：文件写入 Diff 与会话总 Diff", () => {
  it("冻结文本差异走产品自己的读法（动作与可用性词表都在内）", async () => {
    const body = wire({ operation_id: MOCK.operationId, basis: "FROZEN_INTENT",
      files: [{ relative_path: "src/lib/order.ts", action: "MODIFY", baseline_sha256: "c".repeat(64),
        target_sha256: "d".repeat(64), availability: "AVAILABLE", unavailable_reason: null,
        before_text: "const a = 1;", after_text: "const a = 2;" }] });
    expect(await getFileWriteFrozenDiff(httpReturning(body), MOCK.operationId))
      .toEqual(frozenDiff("src/lib/order.ts", "const a = 1;", "const a = 2;"));
    // 身份核对：别的动作的差异不能画到这一行上。
    await expect(getFileWriteFrozenDiff(httpReturning(wire({ ...body, operation_id: "mock-op-other" })),
      MOCK.operationId)).rejects.toThrow(/与原动作不匹配/);
    await expect(getFileWriteFrozenDiff(httpReturning(wire({ ...body, basis: "CURRENT_DISK" })),
      MOCK.operationId)).rejects.toThrow(/与原动作不匹配/);
  });

  it("不可用的那一档：没有正文但必须有原因；AVAILABLE 却没正文必须失败", async () => {
    const unavailable = frozenDiff("src/lib/bin.png", "", "", { availability: "UNAVAILABLE",
      unavailableReason: "二进制内容不参与文本 diff", beforeText: null, afterText: null,
      targetSha256: null });
    await expect(getFileWriteFrozenDiff(httpReturning(wire({ operation_id: MOCK.operationId,
      basis: "FROZEN_INTENT", files: [{ relative_path: "src/lib/bin.png", action: "MODIFY",
        baseline_sha256: "c".repeat(64), target_sha256: null, availability: "UNAVAILABLE",
        unavailable_reason: "二进制内容不参与文本 diff", before_text: null, after_text: null }] })),
      MOCK.operationId)).resolves.toEqual(unavailable);
    // AVAILABLE 却没正文＝响应自己残缺，必须失败：界面据此不能画一块空白 diff。
    await expect(getFileWriteFrozenDiff(httpReturning(wire({ operation_id: MOCK.operationId,
      basis: "FROZEN_INTENT", files: [{ relative_path: "a.ts", action: "MODIFY",
        baseline_sha256: "c".repeat(64), target_sha256: "d".repeat(64), availability: "AVAILABLE",
        unavailable_reason: null, before_text: null, after_text: "x" }] })), MOCK.operationId))
      .rejects.toThrow(/缺少正文/);
    await expect(getFileWriteFrozenDiff(httpReturning(wire({ operation_id: MOCK.operationId,
      basis: "FROZEN_INTENT", files: [{ relative_path: "a.ts", action: "RENAME",
        baseline_sha256: "c".repeat(64), target_sha256: "d".repeat(64), availability: "AVAILABLE",
        unavailable_reason: null, before_text: "a", after_text: "b" }] })), MOCK.operationId))
      .rejects.toThrow(/状态无效/);
  });

  it("逐文件账本（change-sets）读得出夹具那一档，动作不符必须失败", async () => {
    const body = wire({ operation_id: MOCK.operationId,
      change_sets: [{ id: `mock-changeset-${MOCK.operationId}`,
        invocation_id: `mock-invocation-${MOCK.operationId}`, status: "APPLIED",
        files: [{ relative_path: "src/lib/order.ts", action: "MODIFY", status: "APPLIED",
          error: null }] }] });
    expect(await getFileWriteChangeSets(httpReturning(body), MOCK.operationId))
      .toEqual(changeSets(MOCK.operationId, "src/lib/order.ts"));
    await expect(getFileWriteChangeSets(httpReturning(wire({ ...body, operation_id: "mock-op-other" })),
      MOCK.operationId)).rejects.toThrow(/与原动作不匹配/);
  });

  it("会话总 Diff：净变化与覆盖读成产品 DTO；旧形状按目录口径与未知覆盖读", () => {
    expect(conversationDiffFrom(wire({
      available: true, scope: "SESSION", baseline_captured_at: at(0), baseline_revision: "12",
      root_path: "mock://managed/root", resource_id: "mock-resource", incomplete: false,
      coverage: { baseline: { complete: true, reason: null, files: 3, listed: 3 },
        current: { complete: false, reason: "SCAN_LIMIT", files: 3, listed: 2 },
        unchecked_files: 1, unverified_files: 0, unverifiable_files: 0, unscanned_files: 1 },
      total_files: 1, total_added: 4, total_removed: 1,
      files: [{ path: "src/lib/order.ts", action: "MODIFY", added: 4, removed: 1,
        unavailable_reason: null }]
    })).coverage).toEqual({
      baseline: { complete: true, reason: null, files: 3, listed: 3 },
      current: { complete: false, reason: "SCAN_LIMIT", files: 3, listed: 2 },
      uncheckedFiles: 1, unverifiedFiles: 0, unverifiableFiles: 0, unscannedFiles: 1 });
    // 旧服务端没有 scope / coverage：按目录口径读、覆盖记为未知，而不是猜一个。
    const legacy = conversationDiffFrom(wire({
      available: true, baseline_captured_at: at(0), baseline_revision: "12",
      root_path: "mock://managed/root", resource_id: "mock-resource", incomplete: true,
      total_files: 0, total_added: 0, total_removed: 0, files: []
    }));
    expect({ scope: legacy.scope, coverage: legacy.coverage })
      .toEqual({ scope: "DIRECTORY", coverage: null });
    expect(conversationDiffFrom(wire({ available: false, reason: "NO_BASELINE" })))
      .toEqual({ available: false, reason: "NO_BASELINE" });
    expect(() => conversationDiffFrom(wire({ available: false, reason: "TOO_BUSY" })))
      .toThrow(/不可用原因无效/);
    expect(() => conversationDiffFrom(wire({ available: "maybe" }))).toThrow(/可用性标记无效/);
  });

  it("单文件 diff 明细：行类型与截断标记如实读回", () => {
    expect(conversationDiffFileDetailFrom(wire({
      available: true, path: "src/lib/order.ts", action: "MODIFY", added: 1, removed: 1,
      unavailable_reason: null, rows_truncated: true, rows_unavailable_reason: null,
      rows: [{ kind: "CONTEXT", old_line: 3, new_line: 3, text: "export const limit = 5;" },
        { kind: "REMOVE", old_line: 4, new_line: null, text: "const a = 1;" },
        { kind: "ADD", old_line: null, new_line: 4, text: "const a = 2;" }]
    }))).toEqual({
      available: true, path: "src/lib/order.ts", action: "MODIFY", added: 1, removed: 1,
      unavailableReason: null, rowsTruncated: true, rowsUnavailableReason: null,
      rows: [{ kind: "CONTEXT", oldLine: 3, newLine: 3, text: "export const limit = 5;" },
        { kind: "REMOVE", oldLine: 4, newLine: null, text: "const a = 1;" },
        { kind: "ADD", oldLine: null, newLine: 4, text: "const a = 2;" }]
    });
    // 行内类型不认识与可用性标记缺失都必须失败：这里没有「当没这行」这一档。
    expect(() => conversationDiffFileDetailFrom(wire({ available: true, path: "a.ts",
      action: "RENAME", added: 1, removed: 0, unavailable_reason: null, rows: null,
      rows_truncated: false, rows_unavailable_reason: null }))).toThrow(/动作无效/);
    expect(() => conversationDiffFileDetailFrom(wire({ available: true, path: "a.ts",
      action: "MODIFY", added: 1, removed: 0, unavailable_reason: null,
      rows: [{ kind: "HUNK", old_line: 1, new_line: 1, text: "x" }],
      rows_truncated: false, rows_unavailable_reason: null }))).toThrow(/行类型无效/);
    expect(() => conversationDiffFileDetailFrom(wire({ available: "yes", path: "a.ts" })))
      .toThrow(/可用性标记无效/);
  });
});

describe("夹具 ↔ 产品解析器：提案、撤回、审批、Run 与执行结果", () => {
  it("候选成果提案读得出 candidateProposal 夹具；没见过的类型必须失败", () => {
    expect(assistProposalFrom(wire({
      id: "mock-proposal-1", session_id: MOCK.sessionId, message_id: MOCK.assistantMessageId,
      target_id: MOCK.taskId, base_revision: "3", payload_hash: "f".repeat(64),
      payload_available: true, status: "PENDING", kind: "CANDIDATE_MARKDOWN", target_type: "TASK",
      payload: { title: "本轮改动说明", media_type: "text/markdown",
        markdown: "## 本轮改动\n\n- 读取三处配置\n- 修改一个文件" }
    }))).toEqual(candidateProposal());
    expect(() => assistProposalFrom(wire({ id: "p", session_id: MOCK.sessionId,
      message_id: MOCK.assistantMessageId, target_id: MOCK.taskId, base_revision: "3",
      payload_hash: "f".repeat(64), payload_available: true, status: "PENDING",
      kind: "SOMETHING_NEW", target_type: "TASK", payload: {} }))).toThrow(/类型或目标无法识别/);
    expect(() => assistProposalFrom(wire({ id: "p", session_id: MOCK.sessionId,
      message_id: MOCK.assistantMessageId, target_id: MOCK.taskId, base_revision: "3",
      payload_hash: "f".repeat(64), payload_available: true, status: "APPROVED",
      kind: "CANDIDATE_MARKDOWN", target_type: "TASK", payload: {} }))).toThrow(/类型或状态无法识别/);
  });

  it("撤回摘要与逐文件回执读得出夹具那一档；未知状态与未知基线必须失败", () => {
    const receipt = recallReceipt();
    const body = wire({ id: receipt.id, message_id: receipt.messageId,
      assistant_message_id: receipt.assistantMessageId, status: receipt.status,
      planned_files: receipt.plannedFiles, restored_files: receipt.restoredFiles,
      skipped_files: receipt.skippedFiles, completed_at: receipt.completedAt,
      root_path: receipt.rootPath, detail: {}, requested_at: receipt.requestedAt,
      files: receipt.files.map((file) => ({ path: file.path, status: file.status,
        reason: file.reason, baseline: file.baseline, baseline_sha256: file.baselineSha256 })) });
    expect(assistMessageRecallFrom(body)).toEqual(receipt);
    expect(assistMessageRecallSummaryFrom(body)).toEqual(recallSummary());
    expect(() => assistMessageRecallSummaryFrom(wire({ ...body, status: "PENDING" })))
      .toThrow(/撤回状态无法识别/);
    expect(() => assistMessageRecallFrom(wire({ ...body,
      files: [{ path: "a.ts", status: "RESTORED", reason: null, baseline: "GONE",
        baseline_sha256: null }] }))).toThrow(/基线状态无法识别/);
  });

  it("审批记录读得出 approvalReview 夹具；未知类型与未知决定必须失败", () => {
    expect(reviewFrom(wireReviewShape())).toEqual(approvalReview(`${MOCK.operationId}-1`));
    expect(() => reviewFrom(wire({ ...wireReviewShape(), kind: "SOMETHING_NEW" })))
      .toThrow(/未知类型/);
    expect(() => reviewFrom(wire({ ...wireReviewShape(), allowed_decisions: ["FORCE"] })))
      .toThrow(/未知决定/);
  });

  it("Run 投影读得出 labRun 夹具；步骤失败原因只从 result_refs 来", () => {
    expect(runFrom(wireRunShape())).toEqual(labRun());
    expect(runFrom(wireRunShape("FAILED", [{ step_kind: "VERIFY_CHECKS",
      result_ref: { reason: "CHECK_FAILED" } }]))).toEqual(labRun({ status: "FAILED" }));
    // 没有 result_refs 时不猜原因：这一档必须是 null，界面才不会编出失败原因。
    expect(runFrom(wireRunShape("FAILED")).steps[2].reason).toBeNull();
  });

  it("会话执行结果：详情档读得出候选与检查，未知决定与坏检查参数必须失败", () => {
    const body = wire({ request_id: "mock-exec-1", session_id: MOCK.sessionId,
      source_message_id: MOCK.userMessageId, resource_id: "mock-resource",
      root_path: "mock://managed/root", decision: "PREPARE", status: "READY",
      candidate_status: "CANDIDATE", questions: ["确认写入范围吗？"], task_id: null, run_id: null,
      revision: "4", auto_start: false,
      candidate: { title: "收口依赖顺序", objective: "只改 workbench 的依赖声明",
        check: { executable: "node", args: ["scripts/check-docs.mjs"] },
        file_changes: [{ path: "apps/workbench/package.json", action: "MODIFY" }] } });
    expect(conversationExecutionFrom(body)).toEqual({
      requestId: "mock-exec-1", sessionId: MOCK.sessionId, sourceMessageId: MOCK.userMessageId,
      resourceId: "mock-resource", rootPath: "mock://managed/root", decision: "PREPARE",
      status: "READY", candidateStatus: "CANDIDATE", questions: ["确认写入范围吗？"],
      title: "收口依赖顺序", objective: "只改 workbench 的依赖声明",
      check: { executable: "node", args: ["scripts/check-docs.mjs"] },
      fileChanges: [{ path: "apps/workbench/package.json", action: "MODIFY" }],
      autoStart: false, taskId: null, runId: null, revision: "4" });
    // 没有 candidate 是合法形状（这一轮不落地），读成 null 而不是空对象。
    const bare = conversationExecutionFrom(wire({ ...body, decision: "DISCUSS", candidate: null }));
    expect({ title: bare.title, check: bare.check, fileChanges: bare.fileChanges })
      .toEqual({ title: null, check: null, fileChanges: [] });
    expect(() => conversationExecutionFrom(wire({ ...body, decision: "JUST_DO_IT" })))
      .toThrow(/decision 无法识别/);
    expect(() => conversationExecutionFrom(wire({ ...body,
      candidate: { check: { executable: "node", args: [1] } } }))).toThrow(/args/);
    expect(() => conversationExecutionFrom(wire({ ...body,
      candidate: { file_changes: [{ path: "a.ts", action: "RENAME" }] } }))).toThrow(/无法识别/);
  });
});
