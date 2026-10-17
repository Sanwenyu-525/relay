import type {
  RelayRunToolCall,
  RelayRunToolCallPreview,
  RelayRunToolCalls,
} from "../api/dtos/assist";

/**
 * 聊天局部 diff 的行派生（工作台 §34.2 / §34.4，CD-01、CD-11、CD-12、CD-13）。
 *
 * 只做「同源投影 → 展示行」的纯派生，不发请求也不存第二套状态：
 *   * 数字只有两种来源——已落盘的逐文件账本（`fileChanges`）或生成中的临时预览（`previews`）。
 *     预览行永远带 `preview: true`，界面据此显示「正在生成 · 预览 …」，绝不写成「已修改」，
 *     也不会进入会话总数。
 *   * `-1` 是「待核对」，不是 0：统一派生成 `null`，由界面省略数字而不是画成 `+0 −0`。
 *     缺基线、二进制、超限与失败同样给 `null` 加原因。
 *   * 行按原 Run 内的轮次与工具调用身份逐条产生，所以同一个文件被改三次就是三条，
 *     后来的编辑不重写旧行；重复的调用行按 `call.id` 去重，一次结算不会被算两遍。
 *   * 被拒（REJECTED）与中止（ABANDONED）不产生局部行：既没有落盘事实也没有目标内容，
 *     把它们画成一行数字等于凭空加数；失败原因仍由执行轨迹摘要承担。
 */

export type LocalFileDiffPhase =
  /** 生成中：来自临时预览或尚未结算的调用意图，不是落盘事实。 */
  "generating"
  /** 已冻结待批准：显示「待应用」，不冒充已修改。 */
  | "waitingApproval"
  /** 实际落盘账本支持的新增/修改/删除。 */
  | "applied"
  /** 结算为写入失败或基线冲突：有账本但没有可报的改动。 */
  | "failed"
  /** 结果待核对（UNKNOWN、缺逐文件证据、不可统计）：不画数字。 */
  | "pendingVerify";

export interface LocalFileDiffRow {
  readonly key: string;
  readonly path: string;
  readonly fileName: string;
  readonly action: "CREATE" | "MODIFY" | "DELETE" | "UNKNOWN";
  readonly phase: LocalFileDiffPhase;
  /** 待核对时为 null——界面省略数字，不显示 0。 */
  readonly added: number | null;
  readonly removed: number | null;
  /** 该行的数字来自临时预览而非落盘账本。 */
  readonly preview: boolean;
  /** 预览是否已收到完整目标；false 时删除侧不可信。 */
  readonly targetComplete: boolean;
  /** 预览正文被截断：数字只是下界，界面如实标注。 */
  readonly truncated: boolean;
  readonly unavailableReason: string | null;
  /** 归属的工具调用行；尚未派生调用行的预览为 null。 */
  readonly callId: string | null;
  readonly modelCallId: string;
  readonly ordinal: number;
  readonly operationId: string | null;
}

const WRITE_TOOL = "apply_changeset";

const identityOf = (modelCallId: string, ordinal: number) => `${modelCallId}:${ordinal}`;

/** Windows 与 POSIX 分隔符都取末段；完整路径仍原样保留，用于同行截断与 title。 */
export function diffFileName(path: string): string {
  const segments = path.split(/[/\\]/u).filter((segment) => segment !== "");
  return segments.length > 0 ? segments[segments.length - 1] : path;
}

/** `-1`（以及任何负数）都归为「待核对」，绝不折算成 0。 */
const countOf = (value: number): number | null => (value < 0 ? null : value);

interface ChangeIntent {
  readonly path: string;
  readonly action: "CREATE" | "MODIFY" | "DELETE" | "UNKNOWN";
}

/** 从原样保留的 `arguments.changes` 取路径与动作：只读意图，不解析内容也不数行数。 */
function intentsOf(call: RelayRunToolCall): readonly ChangeIntent[] {
  const changes = call.args.changes;
  if (Array.isArray(changes) === false) return [];
  const out: ChangeIntent[] = [];
  for (const entry of changes) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.path !== "string" || record.path === "") continue;
    const action = record.action === "CREATE" || record.action === "MODIFY" || record.action === "DELETE"
      ? record.action : "UNKNOWN";
    out.push({ path: record.path, action });
  }
  return out;
}

/** 预览行：可修正、可回落，不承诺单调；目标未收全时删除侧不给数字。 */
function previewRows(preview: RelayRunToolCallPreview, call: RelayRunToolCall | null,
  round: number): readonly LocalFileDiffRow[] {
  const waiting = call !== null && call.status === "WAITING_APPROVAL";
  return preview.files.map((file) => ({
    key: `${round}:${preview.modelCallId}:${preview.ordinal}:${file.path}`,
    path: file.path,
    fileName: diffFileName(file.path),
    action: file.action,
    phase: waiting ? "waitingApproval" as LocalFileDiffPhase : "generating" as LocalFileDiffPhase,
    added: countOf(file.added),
    removed: file.targetComplete ? countOf(file.removed) : null,
    preview: true,
    targetComplete: file.targetComplete,
    truncated: preview.truncated,
    unavailableReason: file.action === "UNKNOWN" ? "MODIFY_BASELINE_UNAVAILABLE" : null,
    callId: call?.id ?? null,
    modelCallId: preview.modelCallId,
    ordinal: preview.ordinal,
    operationId: call?.operationId ?? null,
  }));
}

/** 已结算的逐文件账本：只有这一支可以给出「已修改」，且只有可核对的行才带数字。 */
function settledRows(call: RelayRunToolCall, round: number): readonly LocalFileDiffRow[] {
  return call.fileChanges.map((file) => {
    const verifiable = file.status === "APPLIED" && file.unavailableReason === null &&
      file.added >= 0 && file.removed >= 0;
    const phase: LocalFileDiffPhase = verifiable ? "applied"
      : file.status === "FAILED" || file.status === "CONFLICT" ? "failed" : "pendingVerify";
    return {
      key: `${round}:${call.id}:${file.path}`,
      path: file.path,
      fileName: diffFileName(file.path),
      action: file.action,
      phase,
      added: verifiable ? file.added : null,
      removed: verifiable ? file.removed : null,
      preview: false,
      targetComplete: true,
      truncated: false,
      unavailableReason: file.unavailableReason ??
        (file.status === "UNKNOWN" ? "RESULT_UNVERIFIED" : null),
      callId: call.id,
      modelCallId: "",
      ordinal: call.ordinal,
      operationId: call.operationId,
    };
  });
}

/** 待批准、或已派发但还没有预览到达时，逐文件列出意图但不给数字（§34.4 待核对）。 */
function intentRows(call: RelayRunToolCall, round: number,
  phase: "waitingApproval" | "generating"): readonly LocalFileDiffRow[] {
  return intentsOf(call).map((intent) => ({
    key: `${round}:${call.id}:${intent.path}`,
    path: intent.path,
    fileName: diffFileName(intent.path),
    action: intent.action,
    phase,
    added: null,
    removed: null,
    preview: phase === "generating",
    targetComplete: false,
    truncated: false,
    unavailableReason: null,
    callId: call.id,
    modelCallId: "",
    ordinal: call.ordinal,
    operationId: call.operationId,
  }));
}

/**
 * 局部行的唯一派生入口。
 *
 * 顺序＝服务端给出的轮次与调用顺序（客户端不重排，重排会掩盖服务端顺序错误）；
 * 尚未落账的预览（模型还在流式输出参数、调用行还没写库）追加在末尾，按 ordinal 升序。
 */
export function localFileDiffRows(projection: RelayRunToolCalls | null,
  previews: readonly RelayRunToolCallPreview[]): readonly LocalFileDiffRow[] {
  if (projection === null) return [];
  const byIdentity = new Map<string, RelayRunToolCallPreview>();
  for (const preview of previews) {
    const key = identityOf(preview.modelCallId, preview.ordinal);
    const previous = byIdentity.get(key);
    // 同一身份只保留更高 revision：迟到片段不能覆盖新值（CD-13）。
    if (previous === undefined || BigInt(preview.revision) >= BigInt(previous.revision)) {
      byIdentity.set(key, preview);
    }
  }
  const rows: LocalFileDiffRow[] = [];
  const accounted = new Set<string>();
  const seenCalls = new Set<string>();
  let lastRound = 0;
  for (const round of projection.rounds) {
    lastRound = Math.max(lastRound, round.round);
    for (const call of round.calls) {
      if (call.toolName !== WRITE_TOOL) continue;
      // 重复事件或断线重放不新增编辑行：同一 call.id 只算一次。
      if (seenCalls.has(call.id)) continue;
      seenCalls.add(call.id);
      const identity = identityOf(round.modelCallId, call.ordinal);
      accounted.add(identity);
      if (call.status === "REJECTED" || call.status === "ABANDONED") continue;
      if (call.status === "SETTLED") { rows.push(...settledRows(call, round.round)); continue; }
      const preview = byIdentity.get(identity);
      if (call.status === "WAITING_APPROVAL") {
        rows.push(...(preview !== undefined
          ? previewRows(preview, call, round.round) : intentRows(call, round.round, "waitingApproval")));
        continue;
      }
      // REQUESTED / PREPARED：生成中。有预览就给预览数字，没有就只列待核对。
      rows.push(...(preview !== undefined
        ? previewRows(preview, call, round.round) : intentRows(call, round.round, "generating")));
    }
  }
  for (const preview of [...byIdentity.values()].sort((left, right) => left.ordinal - right.ordinal)) {
    if (accounted.has(identityOf(preview.modelCallId, preview.ordinal))) continue;
    rows.push(...previewRows(preview, null, lastRound + 1));
  }
  return rows;
}
