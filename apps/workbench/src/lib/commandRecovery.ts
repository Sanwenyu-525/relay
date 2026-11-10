import { RelayApiError, RelayContractError, RelayTransportError } from "../api/core/errors";
import type { RelayApiClient } from "../api/relayClient";
import type { RelayCommandReceipt } from "../api/dtos/projects";

/**
 * 未决命令的统一恢复协调者（AUTO-RECEIPT-RECOVERY）。
 *
 * 所有入口只做三件事：登记「原命令身份」、订阅同一份状态、在需要时把回执交给
 * Owner 校验并读回服务端事实。查询循环只在这里跑一份：同一 baseUrl + workspace +
 * command_id 永远只有一次在途核对，AssistView / CollaborationView / App 不各自起循环。
 *
 * 边界：
 * - 自动流程只查询原 command_id，不生成新 ID，也不重放任何写命令；用户明确点
 *   「以原命令重试」仍走各业务入口原有的同 ID 重试。
 * - 回执必须依次通过 command_id、command_type、会话/业务对象身份校验（模型/连接命令
 *   还校验 connection_id 或 model），再由 Owner 读回服务端状态；删除记录不代替成功。
 * - 查询失败按 UNAVAILABLE / DENIED / RECEIPT_MISSING / MALFORMED / IDENTITY_MISMATCH /
 *   UNVERIFIABLE / UNKNOWN 分类，404 不当作明确失败。
 * - 有限退避（默认 0/1/2/4/8 秒 + jitter），有次数上限；到上限停止自动查询，
 *   保留命令身份与恢复材料，等用户或下一次页面进入/焦点恢复再试。
 *
 * 持久化范围：记录落在 sessionStorage（键与既有协作页恢复区一致）。它只保证同一标签
 * 会话内的页面切换与重挂载；标签/进程关闭后不保证恢复，因此这里不宣称「重启后恢复」。
 * 键里带 baseUrl + workspaceId，不同 Workspace 不会混用同一条未决命令。
 */

export type RecoveryTargetKind = "PROJECT" | "TASK" | "SESSION";

export interface RecoveryRecord {
  readonly commandId: string;
  readonly commandType: string;
  readonly sessionId: string | null;
  readonly targetKind: RecoveryTargetKind;
  readonly targetId: string;
  /** 模型连接命令的服务端身份；用于回执校验，不用于展示。 */
  readonly connectionId?: string | null;
  /** 模型选择命令提交的型号；用于回执校验，不用于展示。 */
  readonly model?: string | null;
  /** 提案/验收等命令的业务对象 id；用于跨页核对，不用于展示。 */
  readonly objectId?: string | null;
}

export type RecoveryFailure =
  | "UNAVAILABLE"
  | "DENIED"
  | "RECEIPT_MISSING"
  | "MALFORMED"
  | "IDENTITY_MISMATCH"
  | "UNVERIFIABLE"
  | "UNKNOWN";

export type RecoveryPhase = "WAITING" | "CHECKING" | "RETRYING" | "EXHAUSTED" | "PAUSED";

export interface RecoveryEntry {
  readonly record: RecoveryRecord;
  readonly phase: RecoveryPhase;
  readonly attempts: number;
  readonly failure: RecoveryFailure | null;
  readonly httpStatus: number | null;
  readonly error: string | null;
}

export type RecoveryTrigger = "auto" | "manual";

export type ApplyOutcome = "APPLIED" | "KEPT";

export interface RecoveryOwner {
  readonly scope: string;
  /** 同一命令只有一个 Owner 认领：认领者负责强身份校验与服务端读回。 */
  claims: (record: RecoveryRecord) => boolean;
  /** 只做身份校验；返回 null 表示通过。 */
  verify: (record: RecoveryRecord, receipt: RelayCommandReceipt) => RecoveryFailure | null;
  /** 校验通过且读回确认后才允许返回 APPLIED；抛错会被重新分类并有限重试。 */
  apply: (record: RecoveryRecord, receipt: RelayCommandReceipt,
    context: { readonly trigger: RecoveryTrigger }) => Promise<ApplyOutcome>;
  fetchReceipt: (commandId: string, signal: AbortSignal) => Promise<RelayCommandReceipt>;
}

interface RecoveryPolicy {
  readonly delaysMs: readonly number[];
  readonly maxAttempts: number;
  readonly jitterRatio: number;
}

const DEFAULT_POLICY: RecoveryPolicy = {
  delaysMs: [0, 1_000, 2_000, 4_000, 8_000],
  maxAttempts: 5,
  jitterRatio: 0.2
};

let policy: RecoveryPolicy = DEFAULT_POLICY;

interface EntryState {
  readonly scope: string;
  record: RecoveryRecord;
  phase: RecoveryPhase;
  attempts: number;
  failure: RecoveryFailure | null;
  httpStatus: number | null;
  error: string | null;
  /**
   * 页面重进时已经重开过几轮自动查询预算（AUTO-RECEIPT-RECOVERY，2026-11-04）。
   * 记录本身没被解决前，重挂载次数不再无限兑换新的查询轮次。
   */
  ownerResets: number;
}

/**
 * 同一未决命令允许因「页面重进 / Owner 换人」重开自动预算的次数（2026-11-04）。
 *
 * 原先每次 Owner 挂载都无条件把 EXHAUSTED 的 attempts 归零并立即查询，反复切换
 * 会话或重挂载就变成无界自动查询。这里给有限预算：进入页面仍会自动核对（保留
 * 「网络超时但服务端已提交，重进后自动补回执」的行为），但同一记录最多重开
 * 这么多轮；之后只保留展示与手动「查询原命令回执」，不再占用网络。
 */
const MAX_OWNER_RESETS = 3;

const entries = new Map<string, EntryState>();
const loadedScopes = new Set<string>();
const owners = new Set<RecoveryOwner>();
const listeners = new Map<string, Set<(entries: readonly RecoveryEntry[]) => void>>();
const inflight = new Map<string, Promise<CheckOutcome>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const controllers = new Map<string, AbortController>();
let windowHooksAttached = false;

export type CheckOutcome =
  | { readonly kind: "RESOLVED"; readonly record: RecoveryRecord }
  | { readonly kind: "FAILED"; readonly record: RecoveryRecord; readonly failure: RecoveryFailure;
    readonly message: string; readonly httpStatus: number | null }
  | { readonly kind: "ABORTED" };

class RecoveryVerifyError extends Error {
  constructor(readonly failure: RecoveryFailure) {
    super(failure);
    this.name = "RecoveryVerifyError";
  }
}

export function recoveryScope(client: Pick<RelayApiClient, "baseUrl" | "workspaceId">): string {
  return `${client.baseUrl}:${client.workspaceId}`;
}

export function recoveryStorageKey(scope: string): string {
  return `relay-agent-chat-pending:${scope}`;
}

/** 恢复区的用户可读命令名；未知命令保留原枚举，供展开区核对，不猜测语义。 */
export function recoveryCommandLabel(commandType: string): string {
  switch (commandType) {
    case "DelegateTask": return "委托任务";
    case "SetProjectState": return "更新项目状态";
    case "SelectSessionModel": return "模型切换";
    case "SelectSessionConnection": return "模型连接切换";
    case "ClearSessionModelSelection": return "恢复跟随默认";
    case "RequestAssistMessage": return "发送消息";
    case "CancelAssistMessage": return "取消消息";
    case "RequestMemoryCompaction": return "整理会话记忆";
    case "SetChatMode": return "切换对话模式";
    case "ExecuteChatCommand": return "新建会话";
    case "AcceptAssistProposal": return "接受提案";
    case "CreateAssistSession": return "创建会话";
    default: return commandType;
  }
}

export function recoveryFailureLabel(failure: RecoveryFailure): string {
  switch (failure) {
    case "UNAVAILABLE": return "回执接口暂时不可访问";
    case "DENIED": return "服务端明确拒绝了回执查询";
    case "RECEIPT_MISSING": return "服务端还没有这条命令的回执";
    case "MALFORMED": return "回执格式异常";
    case "IDENTITY_MISMATCH": return "回执身份不匹配";
    case "UNVERIFIABLE": return "回执已返回，但服务端读回未确认";
    default: return "核对结果仍未能确认";
  }
}

function keyOf(scope: string, commandId: string): string {
  return `${scope}\u0000${commandId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordFrom(value: unknown): RecoveryRecord | null {
  if (!isRecord(value)) return null;
  const { commandId, commandType, sessionId, targetKind, targetId } = value;
  if (typeof commandId !== "string" || typeof commandType !== "string" || typeof targetId !== "string") return null;
  if (sessionId !== null && typeof sessionId !== "string") return null;
  if (targetKind !== "PROJECT" && targetKind !== "TASK" && targetKind !== "SESSION") return null;
  if (targetKind === "SESSION" && typeof sessionId !== "string") return null;
  const connectionId = typeof value.connectionId === "string" ? value.connectionId : null;
  const model = typeof value.model === "string" ? value.model : null;
  const objectId = typeof value.objectId === "string" ? value.objectId : null;
  return { commandId, commandType, sessionId, targetKind, targetId,
    ...(connectionId === null ? {} : { connectionId }), ...(model === null ? {} : { model }),
    ...(objectId === null ? {} : { objectId }) };
}

function readStored(scope: string): readonly RecoveryRecord[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(recoveryStorageKey(scope)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => { const record = recordFrom(item); return record === null ? [] : [record]; });
  } catch { return []; }
}

function writeStored(scope: string): boolean {
  try {
    const stored = window.sessionStorage.getItem(recoveryStorageKey(scope));
    if (stored !== null) {
      const parsed: unknown = JSON.parse(stored);
      if (!Array.isArray(parsed) || parsed.some((item) => recordFrom(item) === null)) return false;
    }
    window.sessionStorage.setItem(recoveryStorageKey(scope),
      JSON.stringify(entriesFor(scope).map((entry) => entry.record)));
    return true;
  } catch { return false; } // 身份仍留内存；要求提交前落盘的 Owner 可据此禁止新命令。
}

function snapshotFor(scope: string): readonly RecoveryEntry[] {
  return entriesFor(scope).map((entry) => ({ record: entry.record, phase: entry.phase, attempts: entry.attempts,
    failure: entry.failure, httpStatus: entry.httpStatus, error: entry.error }));
}

function entriesFor(scope: string): readonly EntryState[] {
  return [...entries.values()].filter((entry) => entry.scope === scope);
}

function notify(scope: string): void {
  const listenersForScope = listeners.get(scope);
  if (listenersForScope === undefined) return;
  const snapshot = snapshotFor(scope);
  for (const listener of listenersForScope) listener(snapshot);
}

function ensureLoaded(scope: string): void {
  if (loadedScopes.has(scope)) return;
  loadedScopes.add(scope);
  for (const record of readStored(scope)) {
    entries.set(keyOf(scope, record.commandId), entryFromRecord(scope, record));
  }
}

function entryFromRecord(scope: string, record: RecoveryRecord): EntryState {
  return { scope, record, phase: "WAITING", attempts: 0, failure: null, httpStatus: null, error: null,
    ownerResets: 0 };
}

/** 页面进入时加载本作用域的既有未决命令；已解决的不再复发。 */
export function openRecoveryScope(scope: string): readonly RecoveryEntry[] {
  ensureLoaded(scope);
  attachWindowHooks();
  return snapshotFor(scope);
}

export function subscribeRecoveries(scope: string, listener: (entries: readonly RecoveryEntry[]) => void): () => void {
  ensureLoaded(scope);
  attachWindowHooks();
  const set = listeners.get(scope) ?? new Set();
  set.add(listener);
  listeners.set(scope, set);
  listener(snapshotFor(scope));
  return () => { set.delete(listener); if (set.size === 0) listeners.delete(scope); };
}

/**
 * 登记未决命令。已有同 command_id 的记录保留原 target 身份（跨页既有记录），
 * 只补全模型/连接校验字段；不会因为重复上报而重启已完成的核对。
 */
export function upsertRecovery(scope: string, record: RecoveryRecord): boolean {
  ensureLoaded(scope);
  attachWindowHooks();
  const key = keyOf(scope, record.commandId);
  const existing = entries.get(key);
  if (existing !== undefined) {
    const merged: RecoveryRecord = {
      ...existing.record,
      ...(record.connectionId == null ? {} : { connectionId: record.connectionId }),
      ...(record.model == null ? {} : { model: record.model }),
      ...(record.objectId == null ? {} : { objectId: record.objectId })
    };
    existing.record = merged;
    const saved = writeStored(scope);
    notify(scope);
    return saved;
  }
  entries.set(key, entryFromRecord(scope, record));
  const saved = writeStored(scope);
  notify(scope);
  scheduleAttempt(scope, record.commandId, 0);
  return saved;
}

/** 只清这一条；调用方必须已经完成身份校验与服务端读回。 */
export function removeRecovery(scope: string, commandId: string): void {
  const key = keyOf(scope, commandId);
  const entry = entries.get(key);
  if (entry === undefined) return;
  const timer = timers.get(key);
  if (timer !== undefined) { clearTimeout(timer); timers.delete(key); }
  controllers.get(key)?.abort();
  controllers.delete(key);
  inflight.delete(key);
  entries.delete(key);
  writeStored(scope);
  notify(scope);
}

export function registerRecoveryOwner(owner: RecoveryOwner): () => void {
  ensureLoaded(owner.scope);
  attachWindowHooks();
  owners.add(owner);
  for (const entry of entriesFor(owner.scope)) {
    if (!owner.claims(entry.record)) continue;
    // 页面重新进入（新 Owner 挂载）时，即使上一轮已到上限也再给一轮查询预算：
    // 未解决命令要在进入页面后自动继续核对，而不是等焦点/网络事件。
    // 但每个记录的重开次数有上限：反复切换会话或重挂载不能让同一命令无界自动查询。
    if (entry.phase === "EXHAUSTED") {
      if (entry.ownerResets >= MAX_OWNER_RESETS) continue;
      entry.ownerResets += 1;
      entry.attempts = 0;
    }
    if (entry.phase === "WAITING" || entry.phase === "PAUSED" || entry.phase === "EXHAUSTED")
      scheduleAttempt(owner.scope, entry.record.commandId, 0);
  }
  return () => {
    owners.delete(owner);
    for (const entry of entriesFor(owner.scope)) {
      if (ownerFor(owner.scope, entry.record) !== null) continue;
      const key = keyOf(owner.scope, entry.record.commandId);
      controllers.get(key)?.abort();
      controllers.delete(key);
      inflight.delete(key);
      if (entry.phase === "CHECKING" || entry.phase === "RETRYING") {
        entry.phase = "PAUSED";
        notify(owner.scope);
      }
    }
  };
}

function ownerFor(scope: string, record: RecoveryRecord): RecoveryOwner | null {
  for (const owner of owners) if (owner.scope === scope && owner.claims(record)) return owner;
  return null;
}

/**
 * 手动核对：用户点击时立即跑一次，不等待退避；失败不重启自动循环。
 * 与自动循环共用同一在途 Promise，重复点击不会产生第二条查询。
 */
export function checkRecoveryNow(scope: string, commandId: string): Promise<CheckOutcome> {
  ensureLoaded(scope);
  const key = keyOf(scope, commandId);
  const timer = timers.get(key);
  if (timer !== undefined) { clearTimeout(timer); timers.delete(key); }
  return runAttempt(scope, commandId, "manual");
}

/** 页面重新获得焦点或网络恢复：各给一次机会，不恢复永久轮询。 */
export function wakeRecoveries(scope: string): void {
  ensureLoaded(scope);
  for (const entry of entriesFor(scope)) {
    // 焦点/网络恢复各给一次机会，但不重置重试预算：这一查失败后仍停在上限，
    // 不恢复永久轮询，也不消耗页面重进的预算。
    if (entry.phase === "EXHAUSTED" || entry.phase === "PAUSED" || entry.phase === "WAITING")
      scheduleAttempt(scope, entry.record.commandId, 0);
  }
}

function attachWindowHooks(): void {
  if (windowHooksAttached || typeof window === "undefined") return;
  windowHooksAttached = true;
  window.addEventListener("online", () => {
    for (const scope of loadedScopes) wakeRecoveries(scope);
  });
  window.addEventListener("focus", () => {
    for (const scope of loadedScopes) wakeRecoveries(scope);
  });
}

function jittered(delayMs: number): number {
  if (delayMs <= 0) return 1;
  const spread = delayMs * policy.jitterRatio;
  return Math.max(1, Math.round(delayMs + (Math.random() * 2 - 1) * spread));
}

function scheduleAttempt(scope: string, commandId: string, delayMs: number): void {
  const entry = entries.get(keyOf(scope, commandId));
  // RECOVERY-OWNER-REGISTRATION-20261106：无认领者时保持等待，不占用同轮后续 Owner 的在途槽。
  if (entry === undefined || ownerFor(scope, entry.record) === null) return;
  const key = keyOf(scope, commandId);
  if (inflight.has(key) || timers.has(key)) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    entry.phase = "PAUSED";
    notify(scope);
    return;
  }
  if (delayMs <= 0) {
    void runAttempt(scope, commandId, "auto");
    return;
  }
  armRetry(scope, entry, delayMs);
}

/**
 * 为刚失败的这次查询排下一次退避。
 *
 * 这里不能复用 `scheduleAttempt`：失败发生在 `performAttempt` 内部，此刻 `inflight`
 * 还持有当前 Promise（它会在 finally 里清除）。带着在途标记重排会把重试静默丢掉，
 * 表现为「第一次失败后就再也不查」。计时器与在途标记是两回事，退避只按计时器去重。
 */
function armRetry(scope: string, entry: EntryState, delayMs: number): void {
  const key = keyOf(scope, entry.record.commandId);
  if (timers.has(key)) return;
  entry.phase = "RETRYING";
  notify(scope);
  const timer = setTimeout(() => {
    timers.delete(key);
    void runAttempt(scope, entry.record.commandId, "auto");
  }, jittered(delayMs));
  timers.set(key, timer);
}

function runAttempt(scope: string, commandId: string, trigger: RecoveryTrigger): Promise<CheckOutcome> {
  const key = keyOf(scope, commandId);
  const entry = entries.get(key);
  if (entry === undefined) return Promise.resolve({ kind: "ABORTED" });
  const existing = inflight.get(key);
  if (existing !== undefined) return existing;
  const task = performAttempt(scope, entry, trigger);
  inflight.set(key, task);
  void task.finally(() => { if (inflight.get(key) === task) inflight.delete(key); });
  return task;
}

async function performAttempt(scope: string, entry: EntryState, trigger: RecoveryTrigger): Promise<CheckOutcome> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    if (trigger === "auto") entry.phase = "PAUSED";
    notify(scope);
    return { kind: "FAILED", record: entry.record, failure: "UNAVAILABLE", message: "当前离线，等网络恢复后继续核对。", httpStatus: null };
  }
  const owner = ownerFor(scope, entry.record);
  if (owner === null) {
    entry.phase = "WAITING";
    notify(scope);
    return { kind: "FAILED", record: entry.record, failure: "UNVERIFIABLE", message: "当前页面没有能认领这条命令的 Owner，已保留命令身份。", httpStatus: null };
  }
  const key = keyOf(scope, entry.record.commandId);
  const controller = new AbortController();
  controllers.set(key, controller);
  entry.phase = "CHECKING";
  entry.attempts += 1;
  notify(scope);
  try {
    const receipt = await owner.fetchReceipt(entry.record.commandId, controller.signal);
    if (controller.signal.aborted) return { kind: "ABORTED" };
    const failure = owner.verify(entry.record, receipt);
    if (failure !== null) throw new RecoveryVerifyError(failure);
    const outcome = await owner.apply(entry.record, receipt, { trigger });
    if (controller.signal.aborted) return { kind: "ABORTED" };
    if (outcome === "APPLIED") {
      const record = entry.record;
      removeRecovery(scope, record.commandId);
      return { kind: "RESOLVED", record };
    }
    const message = "回执已返回，但服务端读回未能确认这条命令的结果。";
    entry.phase = "EXHAUSTED";
    entry.failure = "UNVERIFIABLE";
    entry.httpStatus = null;
    entry.error = message;
    notify(scope);
    return { kind: "FAILED", record: entry.record, failure: "UNVERIFIABLE", message, httpStatus: null };
  } catch (caught) {
    if (controller.signal.aborted) return { kind: "ABORTED" };
    const classified = classifyFailure(caught);
    entry.failure = classified.failure;
    entry.httpStatus = classified.httpStatus;
    entry.error = classified.message;
    if (trigger === "auto" && RETRYABLE.has(classified.failure) && entry.attempts < policy.maxAttempts) {
      const delay = policy.delaysMs[Math.min(entry.attempts, policy.delaysMs.length - 1)] ?? 0;
      notify(scope);
      armRetry(scope, entry, delay);
    } else {
      entry.phase = "EXHAUSTED";
      notify(scope);
    }
    return { kind: "FAILED", record: entry.record, failure: classified.failure,
      message: classified.message, httpStatus: classified.httpStatus };
  } finally {
    if (controllers.get(key) === controller) controllers.delete(key);
  }
}

const RETRYABLE = new Set<RecoveryFailure>(["UNAVAILABLE", "RECEIPT_MISSING", "MALFORMED", "UNKNOWN"]);

function classifyFailure(caught: unknown): { failure: RecoveryFailure; httpStatus: number | null; message: string } {
  if (caught instanceof RecoveryVerifyError) {
    return { failure: caught.failure, httpStatus: null, message: verifyMessage(caught.failure) };
  }
  if (caught instanceof RelayApiError) {
    const problem = caught.problem;
    if (problem.status === 404 && problem.code === "COMMAND_NOT_FOUND")
      return { failure: "RECEIPT_MISSING", httpStatus: 404, message: "服务端还没有这条命令的回执；命令可能尚未提交。" };
    if (problem.status === 401 || problem.status === 403)
      return { failure: "DENIED", httpStatus: problem.status, message: problem.detail };
    if (problem.status === 429 || problem.status === 408 || problem.status >= 500)
      return { failure: "UNAVAILABLE", httpStatus: problem.status, message: problem.detail };
    if (problem.status === 404)
      return { failure: "UNAVAILABLE", httpStatus: 404, message: "回执接口暂时不可访问。" };
    return { failure: "DENIED", httpStatus: problem.status, message: problem.detail };
  }
  if (caught instanceof RelayContractError)
    return { failure: "MALFORMED", httpStatus: null, message: caught.message };
  if (caught instanceof RelayTransportError)
    return { failure: "UNAVAILABLE", httpStatus: null, message: caught.message };
  const message = caught instanceof Error ? caught.message : "核对时出现未知错误。";
  return { failure: "UNKNOWN", httpStatus: null, message };
}

function verifyMessage(failure: RecoveryFailure): string {
  switch (failure) {
    case "IDENTITY_MISMATCH": return "回执身份与记录不匹配；未清除命令身份。";
    case "MALFORMED": return "回执格式异常，无法据此确认结果。";
    case "UNVERIFIABLE": return "回执缺少可核对的服务端身份。";
    default: return recoveryFailureLabel(failure);
  }
}

export function isRecoveryFailure(value: unknown): value is RecoveryFailure {
  return typeof value === "string" && (RECOVERY_FAILURES as readonly string[]).includes(value);
}

const RECOVERY_FAILURES: readonly RecoveryFailure[] = ["UNAVAILABLE", "DENIED", "RECEIPT_MISSING",
  "MALFORMED", "IDENTITY_MISMATCH", "UNVERIFIABLE", "UNKNOWN"];

/**
 * 测试用确定性策略：缩短退避或关闭自动循环，避免测试依赖真实等待。
 * 只影响进程内策略，不写持久化状态；`null` 恢复默认。
 */
export function configureCommandRecoveryForTest(next: Partial<RecoveryPolicy> | null): void {
  policy = next === null ? DEFAULT_POLICY : { ...DEFAULT_POLICY, ...next };
}

/** 测试隔离：清空内存登记、计时器与在途查询；不触碰用户的 sessionStorage。 */
export function resetCommandRecoveryForTest(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  inflight.clear();
  entries.clear();
  loadedScopes.clear();
  owners.clear();
  listeners.clear();
  policy = DEFAULT_POLICY;
}
