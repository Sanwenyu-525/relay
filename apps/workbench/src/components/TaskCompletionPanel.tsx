import { useEffect, useRef, useState } from "react";
import { Check, Info, RotateCcw } from "lucide-react";
import { completionFrom, createCommandId, reopenFrom, RelayTransportError, type RelayAcceptanceCriterion, type RelayApiClient, type RelayCompletion } from "../api/relayClient";
import { describeLiveError, needsReceiptCheck, type LiveActionError } from "../lib/liveErrors";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { liveClient } from "../lib/relayConnection";
import type { DecimalRevision, TaskStatus } from "../types";

const wrongReceipt = (commandType: string, action: string): LiveActionError => ({
  kind: "unknown", message: `回执的命令类型是 ${commandType}，不是本次${action}；请核对 command ID。`, fieldErrors: []
});

/**
 * 完成结果与原冻结请求的可证事实核对（禅道 #28，DEV-0132）：解析成功不代表关联正确。
 * 完成提交绑定确切 Task、验收版本与产物集合（R4 验收版本绑定）；任何一项对不上都不能
 * 宣告成功、不能清原 ID，保持待核对等待回执。原样返回 null。
 */
function completionMismatch(result: RelayCompletion, request: PendingCompletion): string | null {
  if (result.taskId !== request.taskId) return `完成结果属于任务 ${result.taskId}，不是本次任务 ${request.taskId}；请核对原 command ID，本次完成保持待核对。`;
  if (result.status !== "DONE") return `完成结果显示任务状态是 ${result.status}，不是完成；请核对原 command ID，本次完成保持待核对。`;
  if (result.acceptanceRevision !== request.acceptanceRevision) return `完成结果依据的验收版本是 v${result.acceptanceRevision}，本次命令基于 v${request.acceptanceRevision}；请核对原 command ID，本次完成保持待核对。`;
  const committed = [...result.artifactVersionIds].sort().join("\n");
  const requested = [...request.artifactVersionIds].sort().join("\n");
  if (committed !== requested) return `完成结果接受的产物版本集合与本次命令不一致；请核对原 command ID，本次完成保持待核对。`;
  return null;
}

/**
 * 结果未知时冻结的完整原请求（禅道 #29，DEV-0131）：只保留 command ID 不够——
 * 用户随后编辑的说明／原因是新草稿，不能借旧 ID 组出新载荷；原样重试只发冻结对象。
 */
interface PendingCompletion {
  readonly commandId: string;
  readonly taskId: string;
  readonly expectedRevision: DecimalRevision;
  readonly acceptanceRevision: DecimalRevision;
  readonly artifactVersionIds: readonly string[];
  readonly statement: string;
  readonly acceptedCriterionIds: readonly string[];
  readonly reason: string | null;
}

interface PendingReopen {
  readonly commandId: string;
  readonly taskId: string;
  readonly expectedRevision: DecimalRevision;
  /** Missing only in durable records written before reopen cycle binding. */
  readonly acceptanceRevision?: DecimalRevision;
  readonly reason: string;
}

function reopenMismatch(result: ReturnType<typeof reopenFrom>, request: PendingReopen): string | null {
  if (result.taskId !== request.taskId) return `重开结果属于任务 ${result.taskId}，不是本次任务 ${request.taskId}；请核对原 command ID。`;
  if (result.status !== "READY") return `重开结果状态为 ${result.status}，不是 READY；请核对原 command ID。`;
  if (BigInt(result.revision) !== BigInt(request.expectedRevision) + 1n) return "重开结果的 Task 修订与原命令不符；请核对原 command ID。";
  if (request.acceptanceRevision !== undefined &&
    (result.previousAcceptanceRevision !== request.acceptanceRevision ||
      BigInt(result.acceptanceRevision) !== BigInt(request.acceptanceRevision) + 1n)) {
    return "重开结果的验收周期与原命令不符；请核对原 command ID。";
  }
  return null;
}

interface PendingTaskCommands {
  readonly completion: PendingCompletion | null;
  readonly reopen: PendingReopen | null;
  readonly available: boolean;
  readonly found: boolean;
}

function pendingTaskCommandsKey(client: RelayApiClient, taskId: string): string {
  return `relay:task-completion:v1:${encodeURIComponent(client.baseUrl)}:${encodeURIComponent(client.workspaceId)}:${taskId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecimalRevision(value: unknown): value is DecimalRevision {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isPendingCompletion(value: unknown, taskId: string): value is PendingCompletion {
  if (!isRecord(value)) return false;
  return typeof value.commandId === "string" && value.commandId !== "" && value.taskId === taskId &&
    isDecimalRevision(value.expectedRevision) && isDecimalRevision(value.acceptanceRevision) &&
    Array.isArray(value.artifactVersionIds) && value.artifactVersionIds.every((id) => typeof id === "string") &&
    new Set(value.artifactVersionIds).size === value.artifactVersionIds.length &&
    typeof value.statement === "string" && Array.isArray(value.acceptedCriterionIds) &&
    value.acceptedCriterionIds.every((id) => typeof id === "string") &&
    (value.reason === null || typeof value.reason === "string");
}

function isPendingReopen(value: unknown, taskId: string): value is PendingReopen {
  return isRecord(value) && typeof value.commandId === "string" && value.commandId !== "" &&
    value.taskId === taskId && isDecimalRevision(value.expectedRevision) &&
    (value.acceptanceRevision === undefined || isDecimalRevision(value.acceptanceRevision)) &&
    typeof value.reason === "string";
}

function readPendingTaskCommands(key: string, taskId: string): PendingTaskCommands {
  let serialized: string | null;
  try {
    serialized = localStorage.getItem(key);
    if (serialized === null) {
      const legacy = sessionStorage.getItem(key);
      serialized = legacy;
      if (legacy !== null) {
        localStorage.setItem(key, legacy);
        sessionStorage.removeItem(key);
      }
    }
  }
  catch { return { completion: null, reopen: null, available: false, found: false }; }
  if (serialized === null) return { completion: null, reopen: null, available: true, found: false };
  try {
    const value: unknown = JSON.parse(serialized);
    if (!isRecord(value) || value.version !== 1 || value.taskId !== taskId ||
      !(value.completion === null || isPendingCompletion(value.completion, taskId)) ||
      !(value.reopen === null || isPendingReopen(value.reopen, taskId))) {
      return { completion: null, reopen: null, available: false, found: true };
    }
    return { completion: value.completion, reopen: value.reopen, available: true, found: true };
  } catch { return { completion: null, reopen: null, available: false, found: true }; }
}

function writePendingTaskCommands(key: string, taskId: string, completion: PendingCompletion | null, reopen: PendingReopen | null): boolean {
  try {
    if (completion === null && reopen === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ version: 1, taskId, completion, reopen }));
    try { sessionStorage.removeItem(key); } catch { /* The durable record is already authoritative. */ }
    return true;
  } catch { return false; }
}

export interface CompletionTarget {
  readonly taskId: string;
  readonly taskStatus: TaskStatus;
  readonly taskRevision: DecimalRevision;
  readonly acceptanceRevision: DecimalRevision;
  readonly allowedActions: readonly string[];
  readonly criteria: readonly RelayAcceptanceCriterion[];
  /** 随完成提交的产物版本；null 表示该任务未声明产物要求，允许空集合。 */
  readonly acceptedVersion: { readonly artifactVersionId: string; readonly versionNumber: DecimalRevision } | null;
  /** 提供时由本组件管理“本轮接受”集合；未提供时兼容原有单版本调用方。 */
  readonly availableArtifactVersions?: readonly {
    readonly artifactId: string;
    readonly artifactTitle: string;
    readonly artifactVersionId: string;
    readonly versionNumber: DecimalRevision;
    readonly isLatest: boolean;
  }[];
  /** 当前完成周期已写入 CompletionRecord 的确切版本集合，只用于已完成 Task 的回显。 */
  readonly currentAcceptedArtifactVersionIds?: readonly string[];
  readonly writeBlockedReason: string | null;
}

export interface CompletionResult {
  readonly completionId: string;
  readonly revision: DecimalRevision;
  readonly acceptanceRevision: DecimalRevision;
}

/**
 * 完成是独立的短事务用例：任务状态、完成凭据与项目 State 一起提交。
 * 任务详情页与协作工作区共用本组件；模型回复结束、检查 PASS 和批准都不走这条路径。
 */
export default function TaskCompletionPanel({ live, target, onRefresh, compact }: {
  live: boolean;
  target: CompletionTarget;
  onRefresh: () => void | Promise<void>;
  compact?: boolean;
}) {
  const { taskId, taskStatus, taskRevision, acceptanceRevision, allowedActions, criteria, acceptedVersion, writeBlockedReason } = target;
  const [statement, setStatement] = useState("按当前验收标准完成，并接受所选产物版本。");
  const [reason, setReason] = useState("");
  const [acceptedCriterionIds, setAcceptedCriterionIds] = useState<string[]>([]);
  const [acceptanceSelection, setAcceptanceSelection] = useState({ taskId, revision: acceptanceRevision,
    artifactVersionIds: [] as string[] });
  const [completing, setCompleting] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [failure, setFailure] = useState<LiveActionError | null>(null);
  const [reopenReason, setReopenReason] = useState("");
  const [reopening, setReopening] = useState(false);
  const [reopenReceipt, setReopenReceipt] = useState<string | null>(null);
  const [reopenFailure, setReopenFailure] = useState<LiveActionError | null>(null);
  /** 冻结的原命令（state 驱动渲染，ref 供回执查询与重试读取），未知结果收口前不换 ID。 */
  const [pendingComplete, setPendingComplete] = useState<PendingCompletion | null>(null);
  const [pendingReopen, setPendingReopen] = useState<PendingReopen | null>(null);
  const pendingCompleteRef = useRef<PendingCompletion | null>(null);
  const pendingReopenRef = useRef<PendingReopen | null>(null);
  const activeClient = liveClient();
  const recoveryKey = activeClient ? pendingTaskCommandsKey(activeClient, taskId) : null;
  const [recoveryScope, setRecoveryScope] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const scopeRef = useRef(recoveryKey); scopeRef.current = recoveryKey;
  const targetRef = useRef(target); targetRef.current = target;
  const completionScopeRef = useRef<string | null>(null);
  const reopenScopeRef = useRef<string | null>(null);
  const persistedRecoveryRef = useRef<{ scopeKey: string | null; completion: boolean; reopen: boolean }>(
    { scopeKey: null, completion: false, reopen: false });
  const mountedRef = useRef(true);
  const completionFlightRef = useRef<object | null>(null);
  const reopenFlightRef = useRef<object | null>(null);
  const draftGuard = useRef<DraftGuard>({
    hasUnsavedChanges: () => false,
    discard: () => undefined,
    pendingCommandId: () => {
      const key = scopeRef.current;
      if (!key) return null;
      if (completionScopeRef.current === key && pendingCompleteRef.current) return pendingCompleteRef.current.commandId;
      if (reopenScopeRef.current === key && pendingReopenRef.current) return pendingReopenRef.current.commandId;
      return null;
    },
    pendingRecoversAfterLeave: () => {
      const key = scopeRef.current;
      const stored = persistedRecoveryRef.current;
      if (!key || stored.scopeKey !== key) return false;
      const hasCompletion = completionScopeRef.current === key && pendingCompleteRef.current !== null;
      const hasReopen = reopenScopeRef.current === key && pendingReopenRef.current !== null;
      return (hasCompletion || hasReopen) && (!hasCompletion || stored.completion) && (!hasReopen || stored.reopen);
    }
  });
  const recoveryReady = recoveryKey !== null && recoveryScope === recoveryKey;
  const currentPendingComplete = recoveryReady && completionScopeRef.current === recoveryKey &&
    pendingComplete?.taskId === taskId ? pendingComplete : null;
  const currentPendingReopen = recoveryReady && reopenScopeRef.current === recoveryKey &&
    pendingReopen?.taskId === taskId ? pendingReopen : null;

  function savePendingCommands(key: string, completion: PendingCompletion | null, reopen: PendingReopen | null): boolean {
    pendingCompleteRef.current = completion; pendingReopenRef.current = reopen;
    completionScopeRef.current = completion === null ? null : key;
    reopenScopeRef.current = reopen === null ? null : key;
    setPendingComplete(completion); setPendingReopen(reopen);
    const saved = writePendingTaskCommands(key, taskId, completion, reopen);
    persistedRecoveryRef.current = { scopeKey: key, completion: saved && completion !== null,
      reopen: saved && reopen !== null };
    setStorageWarning(!saved);
    return saved;
  }

  useEffect(() => {
    mountedRef.current = true;
    setDraftGuard(draftGuard.current);
    return () => {
      mountedRef.current = false;
      completionFlightRef.current = null; reopenFlightRef.current = null;
      clearDraftGuard(draftGuard.current);
    };
  }, []);

  useEffect(() => {
    completionFlightRef.current = null; reopenFlightRef.current = null;
    setCompleting(false); setReopening(false);
    setReceipt(null); setFailure(null); setReopenReceipt(null); setReopenFailure(null);
    if (recoveryKey === null) {
      setRecoveryScope(null);
      return;
    }
    const restored = readPendingTaskCommands(recoveryKey, taskId);
    const memoryCompletion = completionScopeRef.current === recoveryKey ? pendingCompleteRef.current : null;
    const memoryReopen = reopenScopeRef.current === recoveryKey ? pendingReopenRef.current : null;
    const completion = restored.available && restored.found ? restored.completion : memoryCompletion;
    const reopen = restored.available && restored.found ? restored.reopen : memoryReopen;
    pendingCompleteRef.current = completion; pendingReopenRef.current = reopen;
    completionScopeRef.current = completion === null ? null : recoveryKey;
    reopenScopeRef.current = reopen === null ? null : recoveryKey;
    setPendingComplete(completion); setPendingReopen(reopen);
    persistedRecoveryRef.current = { scopeKey: recoveryKey,
      completion: restored.available && restored.found && restored.completion !== null,
      reopen: restored.available && restored.found && restored.reopen !== null };
    setStorageWarning(!restored.available);
    setRecoveryScope(recoveryKey);
  }, [recoveryKey, taskId]);
  // 人工条件勾选绑定 Task＋验收版本＋确切接受产物版本（禅道 #27，DEV-0133）：
  // 从一个确切接受版本换到另一个不同版本、或退回未选，都作废旧勾选，要求重新确认。
  // 首轮尚未选定任何版本时的既有勾选（例如保存首个产物后该版被自动选中）不因此作废，
  // 即 null→A 不清——那些勾选不是为另一个版本做的；A→B / A→null 仍清，堵住绕道继承。
  const explicitAcceptance = target.availableArtifactVersions !== undefined;
  const acceptedArtifactVersionIds = explicitAcceptance
    ? acceptanceSelection.taskId === taskId && acceptanceSelection.revision === acceptanceRevision
      ? acceptanceSelection.artifactVersionIds : []
    : acceptedVersion ? [acceptedVersion.artifactVersionId] : [];
  const displayedAcceptedArtifactVersionIds = taskStatus === "DONE" && target.currentAcceptedArtifactVersionIds !== undefined
    ? target.currentAcceptedArtifactVersionIds : acceptedArtifactVersionIds;
  const acceptedVersionKey = [...acceptedArtifactVersionIds].sort().join("\n");
  const round = useRef({ taskId, revision: acceptanceRevision, lastVersionKey: acceptedVersionKey,
    explicitAcceptance });
  useEffect(() => {
    if (acceptanceSelection.taskId === taskId && acceptanceSelection.revision === acceptanceRevision) return;
    setAcceptanceSelection({ taskId, revision: acceptanceRevision, artifactVersionIds: [] });
  }, [taskId, acceptanceRevision]);
  useEffect(() => {
    const current = round.current;
    const sameRound = current.taskId === taskId && current.revision === acceptanceRevision;
    const invalidate = !sameRound ||
      (current.lastVersionKey !== acceptedVersionKey &&
        (explicitAcceptance || current.explicitAcceptance || current.lastVersionKey !== ""));
    round.current = { taskId, revision: acceptanceRevision, lastVersionKey: acceptedVersionKey,
      explicitAcceptance };
    if (!invalidate) return;
    setAcceptedCriterionIds([]);
  }, [taskId, acceptanceRevision, acceptedVersionKey, explicitAcceptance]);
  const done = taskStatus === "DONE";
  const requiredCriteria = criteria.filter((criterion) => criterion.required);
  const canComplete = live && writeBlockedReason === null && recoveryReady && !completing &&
    (currentPendingComplete !== null || (!storageWarning && allowedActions.includes("COMPLETE") &&
      requiredCriteria.every((criterion) => acceptedCriterionIds.includes(criterion.criterionId)) &&
      (target.availableArtifactVersions === undefined || acceptedArtifactVersionIds.every((id) =>
        target.availableArtifactVersions!.some((version) => version.artifactVersionId === id))) &&
      Boolean(statement.trim())));
  const canReopen = live && writeBlockedReason === null && recoveryReady && !reopening &&
    (currentPendingReopen !== null || (!storageWarning && allowedActions.includes("REOPEN") && Boolean(reopenReason.trim())));

  function toggleCriterion(criterionId: string, checked: boolean) {
    setAcceptedCriterionIds((current) => checked ? [...current, criterionId] : current.filter((id) => id !== criterionId));
  }

  function toggleAcceptedVersion(artifactVersionId: string, checked: boolean) {
    setAcceptanceSelection((current) => {
      const currentIds = current.taskId === taskId && current.revision === acceptanceRevision
        ? current.artifactVersionIds : [];
      const artifactVersionIds = checked
        ? currentIds.includes(artifactVersionId) ? currentIds : [...currentIds, artifactVersionId]
        : currentIds.filter((id) => id !== artifactVersionId);
      return { taskId, revision: acceptanceRevision, artifactVersionIds };
    });
  }

  function acceptedVersionDescription(artifactVersionId: string): string {
    const version = target.availableArtifactVersions?.find((item) => item.artifactVersionId === artifactVersionId);
    return version
      ? `${version.artifactTitle} v${version.versionNumber}（Artifact ${version.artifactId}；版本 ${version.artifactVersionId}）`
      : acceptedVersion?.artifactVersionId === artifactVersionId
        ? `v${acceptedVersion.versionNumber}（版本 ${artifactVersionId}）` : artifactVersionId;
  }

  function acceptedVersionsReceipt(artifactVersionIds: readonly string[]): string {
    return artifactVersionIds.length === 0 ? "无成果版本" :
      artifactVersionIds.map((id) => acceptedVersionDescription(id)).join("；");
  }

  async function completeTask() {
    const client = liveClient();
    const requestScope = recoveryKey;
    if (!client || !requestScope || pendingTaskCommandsKey(client, taskId) !== requestScope || completing || completionFlightRef.current) return;
    // 结果未知时重按完成＝按冻结的原请求原样重试；表单里的后续编辑是新草稿，不进旧命令。
    let request = completionScopeRef.current === requestScope ? pendingCompleteRef.current : null;
    if (request === null) {
      if (!canComplete) return;
      request = { commandId: createCommandId(), taskId, expectedRevision: taskRevision, acceptanceRevision,
        artifactVersionIds: [...acceptedArtifactVersionIds],
        statement: statement.trim(), acceptedCriterionIds, reason: reason.trim() || null };
      if (!savePendingCommands(requestScope, request,
        reopenScopeRef.current === requestScope ? pendingReopenRef.current : null)) {
        setFailure({ kind: "unknown", message: "无法持久保存原完成命令，未向服务端发送请求。请恢复本机存储后按原 command_id 继续。", fieldErrors: [] });
        return;
      }
    } else if (persistedRecoveryRef.current.scopeKey !== requestScope || !persistedRecoveryRef.current.completion) {
      setFailure({ kind: "unknown", message: "原完成命令未能持久保存，未重发请求。请恢复本机存储后按原 command_id 查询。", fieldErrors: [] });
      return;
    }
    const flight = {};
    completionFlightRef.current = flight;
    setCompleting(true); setFailure(null); setReceipt(null);
    try {
      const result = await client.completeHumanTask(request);
      if (!mountedRef.current || scopeRef.current !== requestScope || completionFlightRef.current !== flight) return;
      // client 已核对回包 command_id 与确切 Task；这里再按原冻结请求核对验收版本、
      // 完成状态与产物集合（#28）。错配抛错走 catch：保持冻结、不清原 ID、不宣告成功、
      // 不当作业务完成刷新。
      const mismatch = completionMismatch(result, request);
      if (mismatch !== null) throw new Error(mismatch);
      savePendingCommands(requestScope, null,
        reopenScopeRef.current === requestScope ? pendingReopenRef.current : null);
      const currentAcceptanceRevision = targetRef.current.taskId === request.taskId
        ? targetRef.current.acceptanceRevision : request.acceptanceRevision;
      if (currentAcceptanceRevision !== request.acceptanceRevision) {
        setReceipt(`已核实原验收版本 v${request.acceptanceRevision} 的历史完成回执：完成凭据 ${result.completionId}；当前验收版本为 v${currentAcceptanceRevision}，旧回执未用于当前周期。`);
      } else {
        setReceipt(`已完成本轮：完成凭据 ${result.completionId}，任务修订 v${result.revision}，验收版本 v${result.acceptanceRevision}；实际接受：${acceptedVersionsReceipt(result.artifactVersionIds)}${result.stateRevision === null ? "" : `，项目 State 修订 v${result.stateRevision}`}。历史凭据保留；再次编辑需要重开。`);
      }
      await onRefresh();
    } catch (caught) {
      if (!mountedRef.current || scopeRef.current !== requestScope || completionFlightRef.current !== flight) return;
      const described = describeLiveError(caught);
      setFailure(described);
      // 只有服务端明确业务拒绝才释放原命令；传输失败与 5xx／核对型错误保持冻结，等待回执或原样重试。
      if (pendingCompleteRef.current === request && completionScopeRef.current === requestScope &&
        described.kind !== "transport" && !needsReceiptCheck(caught)) {
        savePendingCommands(requestScope, null,
          reopenScopeRef.current === requestScope ? pendingReopenRef.current : null);
      }
    } finally {
      if (mountedRef.current && scopeRef.current === requestScope && completionFlightRef.current === flight) {
        completionFlightRef.current = null; setCompleting(false);
      }
    }
  }

  async function lookupCompleteReceipt() {
    const pending = currentPendingComplete; const client = liveClient(); const requestScope = recoveryKey;
    if (!client || !pending || !requestScope || completionScopeRef.current !== requestScope || completing || completionFlightRef.current) return;
    const flight = {};
    completionFlightRef.current = flight;
    setCompleting(true); setFailure(null);
    try {
      const body = await client.getCommandReceipt(pending.commandId);
      if (!mountedRef.current || scopeRef.current !== requestScope || completionFlightRef.current !== flight) return;
      if (body.commandId !== pending.commandId) { setFailure({ kind: "unknown", message: "回执 command_id 与原完成命令不符；请继续核对原 ID。", fieldErrors: [] }); return; }
      if (body.commandType !== "CompleteHumanTask") { setFailure(wrongReceipt(body.commandType, "完成")); return; }
      const result = completionFrom(body.result);
      // 回执不只核对 ID 与命令类型：还要按原冻结请求核对确切 Task、验收版本、完成状态
      // 与产物集合（#28）。错配时归结果未知：保持待核对、不清原 ID、不显示成功、不刷新。
      const mismatch = completionMismatch(result, pending);
      if (mismatch !== null) { setFailure({ kind: "unknown", message: mismatch, fieldErrors: [] }); return; }
      savePendingCommands(requestScope, null,
        reopenScopeRef.current === requestScope ? pendingReopenRef.current : null);
      const currentAcceptanceRevision = targetRef.current.taskId === pending.taskId
        ? targetRef.current.acceptanceRevision : pending.acceptanceRevision;
      if (currentAcceptanceRevision !== pending.acceptanceRevision) {
        setReceipt(`已核实原验收版本 v${pending.acceptanceRevision} 的历史完成回执：完成凭据 ${result.completionId}；当前验收版本为 v${currentAcceptanceRevision}，旧回执未用于当前周期。`);
      } else {
        setReceipt(`回执确认已完成：完成凭据 ${result.completionId}，任务修订 v${result.revision}；实际接受：${acceptedVersionsReceipt(result.artifactVersionIds)}。`);
      }
      await onRefresh();
    } catch (caught) {
      if (mountedRef.current && scopeRef.current === requestScope && completionFlightRef.current === flight) setFailure(describeLiveError(caught));
    } finally {
      if (mountedRef.current && scopeRef.current === requestScope && completionFlightRef.current === flight) {
        completionFlightRef.current = null; setCompleting(false);
      }
    }
  }

  async function reopenTask() {
    const active = liveClient();
    const requestScope = recoveryKey;
    if (!active || !requestScope || pendingTaskCommandsKey(active, taskId) !== requestScope || reopening || reopenFlightRef.current) return;
    let request = reopenScopeRef.current === requestScope ? pendingReopenRef.current : null;
    if (request === null) {
      if (!canReopen) return;
      request = { commandId: createCommandId(), taskId, expectedRevision: taskRevision,
        acceptanceRevision, reason: reopenReason.trim() };
      if (!savePendingCommands(requestScope,
        completionScopeRef.current === requestScope ? pendingCompleteRef.current : null, request)) {
        setReopenFailure({ kind: "unknown", message: "无法持久保存原重开命令，未向服务端发送请求。请恢复本机存储后按原 command_id 继续。", fieldErrors: [] });
        return;
      }
    } else if (persistedRecoveryRef.current.scopeKey !== requestScope || !persistedRecoveryRef.current.reopen) {
      setReopenFailure({ kind: "unknown", message: "原重开命令未能持久保存，未重发请求。请恢复本机存储后按原 command_id 查询。", fieldErrors: [] });
      return;
    }
    const flight = {};
    reopenFlightRef.current = flight;
    setReopening(true); setReopenFailure(null); setReopenReceipt(null);
    try {
      const result = await active.reopenTask(request);
      if (!mountedRef.current || scopeRef.current !== requestScope || reopenFlightRef.current !== flight) return;
      const mismatch = reopenMismatch(result, request);
      if (mismatch !== null) throw new RelayTransportError(mismatch);
      savePendingCommands(requestScope,
        completionScopeRef.current === requestScope ? pendingCompleteRef.current : null, null);
      setReopenReceipt(`已重开：回到${result.status}，新验收版本 v${result.acceptanceRevision}（原 v${result.previousAcceptanceRevision} 的历史凭据仍保留）。编辑前需要重新开始任务。`);
      setReopenReason(""); setAcceptedCriterionIds([]);
      await onRefresh();
    } catch (caught) {
      if (!mountedRef.current || scopeRef.current !== requestScope || reopenFlightRef.current !== flight) return;
      const described = describeLiveError(caught);
      setReopenFailure(described);
      if (pendingReopenRef.current === request && reopenScopeRef.current === requestScope &&
        described.kind !== "transport" && !needsReceiptCheck(caught)) {
        savePendingCommands(requestScope,
          completionScopeRef.current === requestScope ? pendingCompleteRef.current : null, null);
      }
    } finally {
      if (mountedRef.current && scopeRef.current === requestScope && reopenFlightRef.current === flight) {
        reopenFlightRef.current = null; setReopening(false);
      }
    }
  }

  async function lookupReopenReceipt() {
    const pending = currentPendingReopen; const client = liveClient(); const requestScope = recoveryKey;
    if (!client || !pending || !requestScope || reopenScopeRef.current !== requestScope || reopening || reopenFlightRef.current) return;
    const flight = {};
    reopenFlightRef.current = flight;
    setReopening(true); setReopenFailure(null);
    try {
      const body = await client.getCommandReceipt(pending.commandId);
      if (!mountedRef.current || scopeRef.current !== requestScope || reopenFlightRef.current !== flight) return;
      if (body.commandId !== pending.commandId) { setReopenFailure({ kind: "unknown", message: "回执 command_id 与原重开命令不符；请继续核对原 ID。", fieldErrors: [] }); return; }
      if (body.commandType !== "ReopenTask") { setReopenFailure(wrongReceipt(body.commandType, "重开")); return; }
      const result = reopenFrom(body.result);
      const mismatch = reopenMismatch(result, pending);
      if (mismatch !== null) { setReopenFailure({ kind: "unknown", message: mismatch, fieldErrors: [] }); return; }
      savePendingCommands(requestScope,
        completionScopeRef.current === requestScope ? pendingCompleteRef.current : null, null);
      setAcceptedCriterionIds([]);
      setReopenReceipt(`回执确认已重开：回到${result.status}，新验收版本 v${result.acceptanceRevision}。`);
      setReopenReason(""); await onRefresh();
    } catch (caught) {
      if (mountedRef.current && scopeRef.current === requestScope && reopenFlightRef.current === flight) setReopenFailure(describeLiveError(caught));
    } finally {
      if (mountedRef.current && scopeRef.current === requestScope && reopenFlightRef.current === flight) {
        reopenFlightRef.current = null; setReopening(false);
      }
    }
  }

  return <>
    <section className={compact ? "collaboration-completion" : "surface-panel"} data-testid="task-completion">
      <h2>检查与完成</h2>
      <p className="helper-text">完成是一次短事务：任务状态、完成凭据与项目 State 一起提交。检查通过不等于完成，完成也不等于执行成功。</p>
      {writeBlockedReason && <p className="disabled-reason">{writeBlockedReason}</p>}
      {storageWarning && <p className="disabled-reason" role="status" data-testid="task-completion-storage-warning">本机无法读取或更新待核对命令的持久恢复记录。请在此页核对原 command ID；无法安全保存恢复载荷时会阻止新提交。</p>}
      <fieldset className="field" disabled={done || !allowedActions.includes("COMPLETE")}>
        <legend className="field-label">必需验收条件（全部勾选才能完成）</legend>
        {!requiredCriteria.length && <p className="field-hint">当前验收版本没有必需条件。</p>}
        {requiredCriteria.map((criterion) => <label key={criterion.criterionId} className="choice-option">
          <input type="checkbox" checked={acceptedCriterionIds.includes(criterion.criterionId)}
            data-testid={`criterion-${criterion.criterionId}`} onChange={(event) => toggleCriterion(criterion.criterionId, event.target.checked)} />
          <span>{criterion.statement}<small>方式：{criterion.method}</small></span></label>)}
      </fieldset>
      {explicitAcceptance && <fieldset className="field" data-testid="completion-artifact-selection"
        disabled={done || !allowedActions.includes("COMPLETE")}>
        <legend className="field-label">本轮接受的成果版本（可多选）</legend>
        {!target.availableArtifactVersions!.length && <p className="field-hint">当前没有已核实的成果版本；可以按空集合完成。</p>}
        {target.availableArtifactVersions!.map((version) => <label key={`${version.artifactId}:${version.artifactVersionId}`}
          className="choice-option" data-testid={`completion-artifact-option-${version.artifactVersionId}`}>
          <input type="checkbox" checked={acceptedArtifactVersionIds.includes(version.artifactVersionId)}
            data-testid={`completion-artifact-${version.artifactVersionId}`}
            onChange={(event) => toggleAcceptedVersion(version.artifactVersionId, event.target.checked)} />
          <span><strong>{version.artifactTitle} · v{version.versionNumber}{version.isLatest ? " · 最新" : ""}</strong>
            <small>Artifact {version.artifactId}</small><small>ArtifactVersion {version.artifactVersionId}</small></span>
        </label>)}
        {acceptedArtifactVersionIds.some((id) => !target.availableArtifactVersions!.some((version) => version.artifactVersionId === id)) &&
          <p className="disabled-reason" role="alert">所选成果版本不在当前已核实列表中；刷新后确认版本仍可用。</p>}
      </fieldset>}
      <label className="field"><span className="field-label">接受说明</span><input value={statement} onChange={(event) => setStatement(event.target.value)} name="completion-statement" disabled={done} /></label>
      <label className="field"><span className="field-label">补充理由（可选）</span><input value={reason} onChange={(event) => setReason(event.target.value)} name="completion-reason" disabled={done} /></label>
      <p className="helper-text" data-testid="completion-artifact-summary">{taskStatus === "DONE" ? "本轮实际接受的产物版本：" : "将随完成提交的产物版本："}{displayedAcceptedArtifactVersionIds.length
        ? displayedAcceptedArtifactVersionIds.map((id) => acceptedVersionDescription(id)).join("；")
        : "无（该任务未声明产物要求时允许为空集合）"}</p>
      <div className="form-actions"><button className="primary-button" type="button" data-testid="task-complete" disabled={!canComplete} onClick={() => void completeTask()}>
        <Check aria-hidden="true" />{completing ? "正在提交" : "完成本轮"}</button></div>
      {!done && !allowedActions.includes("COMPLETE") && <p className="disabled-reason" data-testid="task-complete-reason"><Info aria-hidden="true" />服务端未投影 COMPLETE：只有进行中的人工任务可以完成。</p>}
      {done && <p className="disabled-reason" data-testid="task-complete-done"><Info aria-hidden="true" />该任务当前已完成；需要再次编辑请先重开。</p>}
      {receipt && <p className="receipt-message" role="status" data-testid="task-complete-receipt">{receipt}</p>}
      {failure && <p className="action-error" role="alert">{failure.message}</p>}
      {currentPendingComplete && <p className="helper-text" data-testid="task-complete-pending">上一次完成提交（原 command_id：{currentPendingComplete.commandId}）结果未核实。再次点击「完成本轮」会按原命令 ID 与原内容原样重发；表单中的新修改不会进入原命令。</p>}
      {currentPendingComplete && <button className="secondary-button" type="button" data-testid="task-complete-receipt-query" disabled={completing} onClick={() => void lookupCompleteReceipt()}>查询本次完成回执</button>}
    </section>
    {(done || allowedActions.includes("REOPEN") || reopenReceipt) && <section className={compact ? "collaboration-completion" : "surface-panel"} data-testid="task-reopen">
      <h2>重开任务</h2>
      <p className="helper-text">重开会建立新的验收版本并回到可开始；旧完成凭据与历史版本都保留，不会被删除或改写。</p>
      <label className="field"><span className="field-label">重开原因<span className="field-required" aria-hidden="true">*</span></span>
        <input value={reopenReason} onChange={(event) => setReopenReason(event.target.value)} name="reopen-reason" /></label>
      <div className="form-actions"><button className="secondary-button" type="button" data-testid="task-reopen-submit" disabled={!canReopen} onClick={() => void reopenTask()}>
        <RotateCcw aria-hidden="true" />{reopening ? "正在重开" : "重开任务"}</button></div>
      {reopenReceipt && <p className="receipt-message" role="status" data-testid="task-reopen-receipt">{reopenReceipt}</p>}
      {reopenFailure && <p className="action-error" role="alert">{reopenFailure.message}</p>}
      {currentPendingReopen && <p className="helper-text" data-testid="task-reopen-pending">上一次重开提交（原 command_id：{currentPendingReopen.commandId}）结果未核实。再次点击「重开任务」会按原命令 ID 与原原因原样重发；输入框中的新原因不会进入原命令。</p>}
      {currentPendingReopen && <button className="secondary-button" type="button" data-testid="task-reopen-receipt-query" disabled={reopening} onClick={() => void lookupReopenReceipt()}>查询本次重开回执</button>}
    </section>}
  </>;
}
