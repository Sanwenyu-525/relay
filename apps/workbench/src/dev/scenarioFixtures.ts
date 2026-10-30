import type {
  RelayAssistLivePreview, RelayAssistMessage, RelayAssistMessageRecall,
  RelayAssistMessageRecallSummary, RelayRunToolCall, RelayRunToolCallFileChange, RelayRunToolCallPreview,
  RelayRunToolCallPreviewFile, RelayRunToolCalls,
  RelaySessionToolCall, RelaySessionToolCallStatus, RelaySessionToolCalls,
} from "../api/dtos/assist";
import type { RelayFileWriteChangeSet, RelayFileWriteFrozenDiff } from "../api/dtos/artifacts";
import type { RelayReview, RelayRun } from "../api/dtos/run";

/**
 * 场景夹具：构造**真实 DTO 形状**的模拟对象。
 *
 * 两条约束：
 *   * 类型来自产品自己的 `api/dtos`，不是实验室另定义的一套。产品字段变了，这里编译不过，
 *     而不是界面静默少一块。
 *   * 身份一律带 `mock-` 前缀，肉眼与自动化都能一眼区分模拟对象；演示正文里的凭据、
 *     路径、命令都是无害占位内容，不含真实令牌，也不指向真实文件。
 */

export const MOCK = {
  workspaceId: "mock-workspace",
  projectId: "mock-project",
  taskId: "mock-task",
  sessionId: "mock-session",
  userMessageId: "mock-msg-user",
  assistantMessageId: "mock-msg-assistant",
  runId: "mock-run",
  operationId: "mock-op",
  modelCallId: "mock-model-call"
} as const;

/** 固定基准时刻：所有时间戳由它派生，保证两次运行得到同一份数据。 */
const T0 = Date.parse("2026-10-30T09:00:00.000Z");

export function at(seconds: number): string {
  return new Date(T0 + seconds * 1_000).toISOString();
}

type MessagePatch = Partial<RelayAssistMessage>;

export function userMessage(content: string, patch: MessagePatch = {}): RelayAssistMessage {
  return assistantOrUser("USER", { content, ...patch });
}

export function assistantMessage(patch: MessagePatch = {}): RelayAssistMessage {
  return assistantOrUser("ASSISTANT", patch);
}

function assistantOrUser(role: "USER" | "ASSISTANT", patch: MessagePatch): RelayAssistMessage {
  return {
    id: role === "USER" ? MOCK.userMessageId : MOCK.assistantMessageId,
    sessionId: MOCK.sessionId,
    seq: role === "USER" ? "1" : "2",
    role,
    status: role === "USER" ? "COMPLETED" : "RUNNING",
    createdAt: at(0),
    updatedAt: at(1),
    intent: "DISCUSS",
    content: null,
    errorCode: null,
    providerErrorKind: null,
    sources: [],
    skill: null,
    skillInput: null,
    skillOutput: null,
    usage: { inputTokens: 12480, outputTokens: 316, cacheReadTokens: null, cacheCreationTokens: null },
    cancelRequested: false,
    steerRequested: false,
    attachments: [],
    withdrawnAt: null,
    withdrawnByRecallId: null,
    recall: null,
    ...patch
  };
}

/** 会话里的一问一答：绝大多数场景只需要这一对。 */
export function pair(assistantPatch: MessagePatch, userText = "把这次的改动过程说清楚"): RelayAssistMessage[] {
  return [userMessage(userText), assistantMessage(assistantPatch)];
}

export function livePreview(patch: Partial<RelayAssistLivePreview> = {}): RelayAssistLivePreview {
  return {
    sessionId: MOCK.sessionId,
    messageId: MOCK.assistantMessageId,
    status: "RUNNING",
    previewRevision: "1",
    previewText: null,
    previewTruncated: false,
    previewAvailable: false,
    ...patch
  };
}

/** 流式草稿：按 1× 时长切片，长度由调用方给，不依赖随机网络。 */
export function draftOf(full: string, ratio: number): string {
  const taken = Math.max(0, Math.min(full.length, Math.round(full.length * ratio)));
  return full.slice(0, taken);
}

type CallPatch = Partial<RelaySessionToolCall> & {
  readonly toolName: string;
  readonly status?: RelaySessionToolCallStatus;
};

export function sessionCall(index: number, patch: CallPatch): RelaySessionToolCall {
  return {
    id: `mock-call-${String(index + 1).padStart(2, "0")}`,
    round: 0,
    ordinal: index,
    status: patch.status ?? "SETTLED",
    args: patch.args ?? {},
    rejectionReason: patch.rejectionReason ?? null,
    rejectionDetail: patch.rejectionDetail ?? null,
    requestedAt: patch.requestedAt ?? at(index * 2),
    settledAt: patch.settledAt ?? (patch.status && patch.status !== "SETTLED" ? null : at(index * 2 + 1)),
    ...patch
  };
}

/**
 * 会话轮次账本。**不写结果正文**——`session_tool_calls` 没有那一列，
 * 实验室因此不会在会话侧凭空长出一段「读取结果」（那是 Run 侧的事实）。
 */
export function sessionTrace(rounds: readonly (readonly RelaySessionToolCall[])[],
  messageId: string = MOCK.assistantMessageId): RelaySessionToolCalls {
  return {
    sessionId: MOCK.sessionId,
    messageId,
    messageStatus: "RUNNING",
    rounds: rounds.map((calls, round) => ({ round, calls }))
  };
}

/** 单轮快捷写法。 */
export function traceOf(calls: readonly RelaySessionToolCall[],
  messageId: string = MOCK.assistantMessageId): RelaySessionToolCalls {
  return sessionTrace([calls], messageId);
}

export function readCall(index: number, relativePath: string,
  patch: Partial<RelaySessionToolCall> = {}): RelaySessionToolCall {
  return sessionCall(index, { toolName: "read_file", args: { relative_path: relativePath }, ...patch });
}

/** Run 侧调用（有 result_ref，因此能如实展示 stdout、退出码、逐文件账本）。 */
export function runCall(index: number, patch: Partial<RelayRunToolCall> & { toolName: string }): RelayRunToolCall {
  const operationId = patch.operationId ?? (patch.toolName === "apply_changeset" || patch.toolName === "run_check"
    ? `${MOCK.operationId}-${index + 1}` : null);
  return {
    id: patch.id ?? `mock-run-call-${String(index + 1).padStart(2, "0")}`,
    round: patch.round ?? 0,
    ordinal: patch.ordinal ?? index,
    status: patch.status ?? "SETTLED",
    args: patch.args ?? {},
    argsSha256: patch.argsSha256 ?? "a".repeat(64),
    providerToolCallId: patch.providerToolCallId ?? `mock-tc-${index + 1}`,
    operationId,
    adaptationOf: null,
    adaptedPath: null,
    resultRef: patch.resultRef ?? null,
    createdAt: patch.createdAt ?? at(index * 3),
    updatedAt: patch.updatedAt ?? at(index * 3 + 2),
    fileChanges: patch.fileChanges ?? [],
    ...patch
  };
}

/** 第 N 轮的模型调用身份：`runProjection` 就是按这个规则给出的，预览行必须对齐同一个身份。 */
export const modelCallOf = (round: number): string => `${MOCK.modelCallId}-${round}`;

export function runProjection(rounds: readonly (readonly RelayRunToolCall[])[], patch:
  { readonly runStatus?: string; readonly waitReason?: string | null; readonly runId?: string } = {}
): RelayRunToolCalls {
  return {
    runId: patch.runId ?? MOCK.runId,
    runStatus: patch.runStatus ?? "RUNNING",
    waitReason: patch.waitReason ?? null,
    rounds: rounds.map((calls, round) => ({ round, modelCallId: `${MOCK.modelCallId}-${round}`, calls }))
  };
}

/** 命令回执：退出码与 stdout/stderr 的真实落库形状。 */
export function commandResult(stdout: string, exitCode: number,
  patch: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return { stdout, exit_code: exitCode, ...patch };
}

/** 写类工具的逐文件账本。`added/removed` 为 -1 表示待核对。 */
export function fileChange(path: string, action: RelayRunToolCallFileChange["action"],
  patch: Partial<RelayRunToolCallFileChange> = {}): RelayRunToolCallFileChange {
  return { path, action, status: "APPLIED", added: 4, removed: 1, unavailableReason: null, ...patch };
}

export function runPreviewFile(patch: Partial<RelayRunToolCallPreviewFile> & { path: string }):
  RelayRunToolCallPreviewFile {
  return { action: "MODIFY", added: 2, removed: 0, targetComplete: true, ...patch };
}

export function runPreview(modelCallId: string, ordinal: number,
  files: readonly RelayRunToolCallPreviewFile[],
  patch: Partial<Omit<RelayRunToolCallPreview, "files">> = {}): RelayRunToolCallPreview {
  return {
    modelCallId, ordinal, toolName: "apply_changeset", revision: "1",
    truncated: false, updatedAt: at(3), files, ...patch
  };
}

export function labRun(patch: Partial<RelayRun> = {}): RelayRun {
  return {
    id: MOCK.runId,
    taskId: MOCK.taskId,
    status: patch.status ?? "RUNNING",
    revision: patch.revision ?? "7",
    waitReason: patch.waitReason ?? null,
    currentStepId: "mock-step-3",
    steps: patch.steps ?? [
      { id: "mock-step-1", index: 1, kind: "GENERATE_CANDIDATE", status: "SUCCEEDED",
        startedAt: at(0), finishedAt: at(20), reason: null },
      { id: "mock-step-2", index: 2, kind: "EXECUTE_TOOL_LOOP", status: "SUCCEEDED",
        startedAt: at(20), finishedAt: at(48), reason: null },
      { id: "mock-step-3", index: 3, kind: "VERIFY_CHECKS", status: patch.status === "FAILED" ? "FAILED" : "RUNNING",
        startedAt: at(48), finishedAt: null, reason: patch.steps ? null : (patch.status === "FAILED" ? "CHECK_FAILED" : null) }
    ],
    recentAttempts: patch.recentAttempts ?? [
      { id: "mock-attempt-1", stepKind: "VERIFY_CHECKS", number: "1", status: "RUNNING" }
    ],
    blockingReviewIds: patch.blockingReviewIds ?? [],
    pendingControlRequest: patch.pendingControlRequest ?? null,
    unresolvedOperationIds: patch.unresolvedOperationIds ?? [],
    ...patch
  };
}

/** ACTION_APPROVAL 审批记录：只用于演示「等待批准」这一档，按钮不改真实审批。 */
export function approvalReview(operationId: string, patch: Partial<RelayReview> = {}): RelayReview {
  return {
    id: `mock-review-${operationId}`,
    kind: "ACTION_APPROVAL",
    status: "OPEN",
    revision: "1",
    projectId: MOCK.projectId,
    taskId: MOCK.taskId,
    runId: MOCK.runId,
    operationId,
    reason: "写入受管目录需要人工批准",
    targetHash: "b".repeat(64),
    target: { relative_path: "src/lib/order.ts" },
    evidence: { basis: "FROZEN_INTENT" },
    effect: { files: 1 },
    allowedDecisions: ["APPROVE", "DENY"],
    expiresAt: at(3_600),
    createdAt: at(60),
    decidedAt: null,
    ...patch
  };
}

export function frozenDiff(relativePath: string, beforeText: string, afterText: string,
  patch: Partial<RelayFileWriteFrozenDiff["files"][number]> = {}): RelayFileWriteFrozenDiff {
  return {
    operationId: MOCK.operationId,
    basis: "FROZEN_INTENT",
    files: [{
      relativePath, action: "MODIFY",
      baselineSha256: "c".repeat(64), targetSha256: "d".repeat(64),
      availability: "AVAILABLE", unavailableReason: null, beforeText, afterText, ...patch
    }]
  };
}

export function changeSets(operationId: string, relativePath: string,
  status = "APPLIED"): readonly RelayFileWriteChangeSet[] {
  return [{
    id: `mock-changeset-${operationId}`, invocationId: `mock-invocation-${operationId}`,
    status, files: [{ relativePath, action: "MODIFY", status, error: null }]
  }];
}

/** 消息来源条目：`origin` 是记忆来源才有的字段，其余来源为 null。 */
export function sourceOf(sourceRef: string, status = "AVAILABLE",
  reason: string | null = null): RelayAssistMessage["sources"][number] {
  return { sourceRef, kind: null, rootId: null, version: null, status, reason, origin: null };
}

/** 消息上随列表读回的撤回摘要（逐文件回执另按需要读）。 */
export function recallSummary(patch: Partial<RelayAssistMessageRecallSummary> = {}): RelayAssistMessageRecallSummary {
  return {
    id: "mock-recall", messageId: MOCK.userMessageId, assistantMessageId: MOCK.assistantMessageId,
    status: "COMPLETED", plannedFiles: 2, restoredFiles: 2, skippedFiles: 0, completedAt: at(90), ...patch
  };
}

export function recallReceipt(patch: Partial<RelayAssistMessageRecall> = {}): RelayAssistMessageRecall {
  return {
    id: "mock-recall", messageId: MOCK.userMessageId, assistantMessageId: MOCK.assistantMessageId,
    status: "COMPLETED", plannedFiles: 2, restoredFiles: 2, skippedFiles: 0, completedAt: at(90),
    rootPath: "mock://managed/root", detail: {}, requestedAt: at(88),
    files: [
      { path: "src/lib/order.ts", status: "RESTORED", reason: null, baseline: "PRESENT", baselineSha256: "e".repeat(64) },
      { path: "src/lib/new.ts", status: "ALREADY_RESTORED", reason: "发送前不存在，已删除", baseline: "ABSENT", baselineSha256: null }
    ],
    ...patch
  };
}

/* ---------------- 正文夹具：Markdown / 代码 / 表格 ---------------- */

export const MARKDOWN_RICH = [
  "## 这一轮做了什么",
  "",
  "先把配置读了一遍，再核对依赖顺序，最后改了一处导入。",
  "",
  "### 读取",
  "",
  "1. `package.json` 确认工作区根",
  "2. `pnpm-workspace.yaml` 确认包列表",
  "3. `apps/workbench/package.json` 确认脚本",
  "",
  "> 结论：顺序问题只出在 workbench 自己的依赖声明上。",
  "",
  "| 检查 | 结果 | 耗时 |",
  "| --- | --- | --- |",
  "| typecheck | 通过 | 8.4s |",
  "| test | 通过 | 21.2s |",
  "| docs | 2 条链接待修 | 1.1s |",
  "",
  "```ts",
  "import { compareDecimalRevisions } from \"./decimalRevision\";",
  "",
  "export function isNewer(left: string, right: string): boolean {",
  "  return compareDecimalRevisions(left, right) > 0;",
  "}",
  "```",
  "",
  "- 没有改动业务契约，也没有新增依赖。",
  "- 其余文件保持原样。"
].join("\n");

export const MARKDOWN_LONG = Array.from({ length: 24 }, (_, index) => [
  `### ${index + 1}. 段落`,
  "",
  `这一段说明第 ${index + 1} 项的取舍与影响，长度足够把阅读列撑满，用来检查超长正文的排版与折行。`,
  "包含一个行内代码 `example.ts` 与一条列表：",
  "",
  "- 前提条件",
  "- 失败处理",
  "- 恢复入口",
  ""
].join("\n")).join("\n");

export const CODE_BLOCK_LONG = Array.from({ length: 120 }, (_, index) =>
  `  const step${index + 1} = normalize(${index + 1}); // 第 ${index + 1} 行，用来量代码块内部的滚动与复制`).join("\n");

export const TABLE_WIDE = [
  "| 场景 | 宿主 | 状态 | 组件 | 检查 | 说明 |",
  "| --- | --- | --- | --- | --- | --- |",
  ...Array.from({ length: 14 }, (_, index) =>
    `| C${String(index + 1).padStart(2, "0")} | RUN_SUMMARY | SETTLED | ChatLocalFileDiff | visible | 第 ${index + 1} 条宽表格行，用来检查表头换行与横向溢出 |`)
].join("\n");

export const MIXED_CJK = [
  "这一轮把 `activityPresentation.ts` 的投影拆成两层：会话侧只报请求与结算，Run 侧才带 result_ref。",
  "",
  "- 中文与英文混排（TypeScript / React / PostgreSQL）要检查断行不撑破阅读列。",
  "- 标点收尾：全角逗号、顿号、书名号《》与半角括号 (demo) 并存。",
  "- URL 与路径：`apps/workbench/src/dev/scenarioWorld.ts`、`D:/Develop/Relay-Agent`。",
  "",
  "```bash",
  "pnpm --filter relay-workbench-fixture run test",
  "```",
  "",
  "最后一句：排版应保持同一阅读宽度，不出现行内代码把行高顶开的情况。"
].join("\n");

export const LONG_PATH = [
  "apps/workbench/src/components/activityPresentation/very/deep/path/that/keeps/going/",
  "and/still/goes/deeper/nested/inside/the/tree/ActivityRowPresentationProbe.tsx"
].join("/");

/**
 * 一条很长的**已配置检查标识**。
 *
 * `run_check` 的入参契约只有 `check_id`（`tool-catalog.ts:105-108`：「只能按 check_id 点名
 * 已配置命令，不能提交任意命令字符串」），所以「命令很长」这一档在真实语义里表现为
 * 标识串很长，而不是模型交来一整行 shell。逐字不裁中段这件事照旧可验。
 */
export const LONG_CHECK_ID = [
  "integration:e2e:nightly",
  "workbench-build-production",
  "empty-out-dir",
  "sourcemap-off",
  `marker-${"MARKER".repeat(12)}`
].join(":");

export const LONG_STDOUT = Array.from({ length: 400 }, (_, index) =>
  `[2026-10-30T09:00:${String(index % 60).padStart(2, "0")}] worker=${index % 8} stage=verify line=${index} status=ok payload=${"x".repeat(24)}`).join("\n");

export const LONG_STDERR = Array.from({ length: 60 }, (_, index) =>
  `ERROR ${index + 1}: cannot resolve dependency graph node #${index + 1} — expected an explicit edge, got an implicit one`).join("\n");
