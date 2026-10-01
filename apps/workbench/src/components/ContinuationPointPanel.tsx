import { useEffect, useRef, useState } from "react";
import { createCommandId, RelayApiError, type RelayApiClient, type RelayCommandEnvelope,
  type RelayContinuationComparison, type RelayContinuationPointSummary,
  type RelayContinuationRefChange } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

const changeLabels: Readonly<Record<RelayContinuationRefChange, string>> = {
  UNCHANGED: "未变化", REVISED: "已修订", CLOSED: "已终结", MISSING: "当前不可见",
  CURRENT: "仍是当前选用版本", SUPERSEDED: "已有更新版本"
};

interface PendingCapture {
  readonly id: string;
  readonly name: string;
  readonly note: string | null;
}

function pendingKey(client: RelayApiClient, projectId: string): string {
  return `relay:continuation-point:${client.baseUrl}:${client.workspaceId}:${projectId}`;
}

function readPending(key: string): PendingCapture | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.name !== "string") return null;
    return { id: row.id, name: row.name, note: typeof row.note === "string" ? row.note : null };
  } catch { return null; }
}

function savePending(key: string, pending: PendingCapture | null): void {
  try {
    if (pending) sessionStorage.setItem(key, JSON.stringify(pending));
    else sessionStorage.removeItem(key);
  } catch { /* 冻结命令仍保留在当前页面内。 */ }
}

/** 保存接续点后只按回执确认，不凭 HTTP 成功推断已写入。 */
function confirmedPoint(envelope: RelayCommandEnvelope, command: PendingCapture,
  projectId: string): RelayContinuationPointSummary {
  if (envelope.commandId !== command.id) throw new Error("回执的 command_id 与提交的不一致。");
  const result = envelope.result as Record<string, unknown>;
  if (result["project_id"] !== projectId || result["name"] !== command.name) {
    throw new Error("回执中的项目或名称无法核对。");
  }
  return {
    id: String(result["id"]), projectId, name: command.name,
    note: typeof result["note"] === "string" ? result["note"] : null,
    capturedAt: String(result["captured_at"]),
    capturedState: result["captured_state"] as RelayContinuationPointSummary["capturedState"],
    refCount: Number(result["ref_count"])
  };
}

export default function ContinuationPointPanel({ client, projectId, captureBlockedReason = null, factsReadable = true }: {
  readonly client: RelayApiClient;
  readonly projectId: string;
  readonly captureBlockedReason?: string | null;
  readonly factsReadable?: boolean;
}) {
  const [points, setPoints] = useState<readonly RelayContinuationPointSummary[]>([]);
  const [comparison, setComparison] = useState<RelayContinuationComparison | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<PendingCapture | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [comparisonBusy, setComparisonBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const scope = useRef(0);
  const factReadVersion = useRef(0);
  const readable = useRef(factsReadable);
  readable.current = factsReadable;
  const key = pendingKey(client, projectId);

  async function load(activeClient: RelayApiClient, request: number) {
    if (!readable.current) return;
    const factRequest = ++factReadVersion.current;
    setComparisonBusy(false);
    setLoading(true);
    try {
      const next = await activeClient.getContinuationPoints(projectId);
      if (request !== scope.current || factRequest !== factReadVersion.current || !readable.current) return;
      setPoints(next);
      setError((current) => current ?? (next.length ? null : null));
    } catch (caught) {
      if (request === scope.current && factRequest === factReadVersion.current && readable.current) setError(describeLiveError(caught).message);
    } finally { if (request === scope.current && factRequest === factReadVersion.current) setLoading(false); }
  }

  async function open(pointId: string) {
    if (!readable.current || busy || comparisonBusy || loading) return;
    const request = scope.current;
    const factRequest = ++factReadVersion.current;
    setComparison(null); setComparisonBusy(true); setError(null);
    try {
      const next = await client.compareContinuationPoint(projectId, pointId);
      if (request === scope.current && factRequest === factReadVersion.current && readable.current) setComparison(next);
    } catch (caught) {
      if (request === scope.current && factRequest === factReadVersion.current && readable.current) setError(describeLiveError(caught).message);
    } finally { if (request === scope.current && factRequest === factReadVersion.current) setComparisonBusy(false); }
  }

  async function checkReceipt(command: PendingCapture) {
    const request = scope.current;
    setBusy(true);
    try {
      const receipt = await client.getCommandReceipt(command.id);
      if (request !== scope.current) return;
      if (receipt.commandType !== "CreateProjectContinuationPoint") {
        throw new Error("原命令回执类型不匹配。");
      }
      const confirmed = confirmedPoint(receipt, command, projectId);
      setPending(null); savePending(key, null); setError(null);
      setMessage(`接续点「${confirmed.name}」已按回执确认保存，包含 ${confirmed.refCount} 项引用。`);
      await load(client, request);
    } catch (caught) {
      if (request !== scope.current) return;
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setError(`原命令回执暂未找到。原 command_id：${command.id}；核对前不会生成新命令。`);
      } else setError(`原命令回执仍无法核对：${describeLiveError(caught).message}`);
    } finally { if (request === scope.current) setBusy(false); }
  }

  async function capture(command: PendingCapture) {
    const request = scope.current;
    setPending(command); savePending(key, command); setBusy(true); setError(null); setMessage(null);
    try {
      const envelope = await client.captureContinuationPoint({ projectId, commandId: command.id,
        name: command.name, note: command.note });
      if (request !== scope.current) return;
      const confirmed = confirmedPoint(envelope, command, projectId);
      setPending(null); savePending(key, null); setName(""); setNote("");
      setMessage(`接续点「${confirmed.name}」已保存，包含 ${confirmed.refCount} 项引用。`);
      await load(client, request);
    } catch (caught) {
      if (request !== scope.current) return;
      if (caught instanceof RelayApiError && caught.problem.status < 500 &&
        caught.problem.code !== "COMMAND_ID_REUSED") {
        setPending(null); savePending(key, null);
        setError(describeLiveError(caught).message);
      } else {
        setError("提交结果尚不明确，正在查询原 command_id 回执。");
        await checkReceipt(command);
      }
    } finally { if (request === scope.current) setBusy(false); }
  }

  useEffect(() => {
    scope.current++;
    setPoints([]); setComparison(null);
    setError(null); setMessage(null);
    const restored = readPending(key);
    setPending(restored);
    if (restored) void checkReceipt(restored);
    return () => { scope.current++; };
  }, [client, projectId, key]);

  useEffect(() => {
    factReadVersion.current++;
    setComparisonBusy(false);
    setPoints([]); setComparison(null);
    if (factsReadable) void load(client, scope.current);
    else setLoading(false);
    return () => { factReadVersion.current++; };
  }, [client, projectId, factsReadable]);

  const trimmedName = name.trim();
  const blockedReason = busy || loading ? "正在核对当前事实。" :
    pending !== null ? "上一次保存结果尚未核对，不能提交新命令。" :
      captureBlockedReason ?? (trimmedName === "" ? "接续点名称不能为空。" : null);

  return <section className="resume-section" aria-label="项目接续点" data-testid="continuation-panel">
    <h2>接续点</h2>
    <p className="helper-text">接续点由你显式保存：它记录当时的 Project State 版本、未决任务与当前选用成果版本，不复制正文，也不会因为打开本页而改变当前事实。保存不停止正在执行的 Run。</p>
    {loading && <p role="status">正在读取已保存的接续点…</p>}
    {!factsReadable && <p className="helper-text">项目事实尚未读取确认，已隐藏接续点及对比。草稿与原命令回执仍保留。</p>}
    {factsReadable && !loading && points.length === 0 && pending === null &&
      <p className="helper-text">还没有保存过接续点；本页不会用“当前事实”冒充“上次看到的样子”。</p>}
    {factsReadable && points.length > 0 && <ul className="run-list">{points.map((point) => <li key={point.id}>
      <button className="inline-link" type="button" data-testid="continuation-open"
        disabled={busy || loading || comparisonBusy}
        onClick={() => void open(point.id)}>{point.name}</button>
      <small>保存于 <time dateTime={point.capturedAt}>{new Date(point.capturedAt).toLocaleString("zh-CN")}</time>
        · 捕获 State v{point.capturedState.revision}（{point.capturedState.phaseKey}）· {point.refCount} 项引用
        {point.note ? ` · ${point.note}` : ""}</small>
    </li>)}</ul>}
    {factsReadable && comparisonBusy && <p role="status">正在读取接续点对比…</p>}
    {factsReadable && comparison && <div data-testid="continuation-comparison">
      <h3>与当前事实的差异</h3>
      <p className="helper-text">捕获于 <time dateTime={comparison.continuationPoint.capturedAt}>{new Date(comparison.continuationPoint.capturedAt).toLocaleString("zh-CN")}</time>；当前 State v{comparison.currentState.revision}（{comparison.currentState.phaseKey}）。以下都是可核对的事实差异，本版不生成解读。</p>
      <ul className="run-list">
        <li>Project State 版本：{comparison.facts.stateRevisionChanged ? "已变化" : "未变化"}</li>
        <li>阶段：{comparison.facts.phaseChanged
          ? `已从 ${comparison.continuationPoint.capturedState.phaseKey} 变为 ${comparison.currentState.phaseKey}`
          : "未变化"}</li>
        <li>下一步 Task：{comparison.facts.nextActionChanged ? "已改变" : "未改变"}</li>
      </ul>
      {comparison.refChanges.length > 0 && <><h4>捕获时的引用</h4>
        <ul className="run-list">{comparison.refChanges.map((ref) => <li key={`${ref.refKind}:${ref.refId}`}>
          {ref.refKind === "TASK"
            ? <><span>任务 {ref.refId}</span> · 捕获时 revision v{ref.capturedRevision}</>
            : <><span>成果版本 {ref.refId}</span> · 捕获时 v{ref.capturedRevision}</>}
          <small>{changeLabels[ref.change]}{ref.currentRevision ? ` · 当前 v${ref.currentRevision}` : ""}
            {ref.note ? ` · ${ref.note}` : ""}</small>
        </li>)}</ul></>}
      {comparison.facts.taskAdded.length > 0 && <><h4>捕获之后新增的未决任务</h4>
        <ul className="run-list">{comparison.facts.taskAdded.map((task) => <li key={task.taskId}>
          {task.title} · {task.status}<small>任务 {task.taskId}</small></li>)}</ul></>}
      {comparison.facts.artifactVersionAdded.length > 0 && <><h4>捕获之后新增选用成果版本</h4>
        <ul className="run-list">{comparison.facts.artifactVersionAdded.map((ref) => <li key={ref.artifactVersionId}>
          成果 {ref.artifactId} · v{ref.versionNumber}<small>版本 {ref.artifactVersionId}</small></li>)}</ul></>}
    </div>}
    <details open={pending !== null || error !== null} className="continuation-capture-form"><summary>保存新的接续点</summary>
    <label className="field"><span className="field-label">接续点名称</span>
      <input data-testid="continuation-name" value={name} maxLength={120} disabled={busy}
        onChange={(event) => setName(event.target.value)} placeholder="例如：写方法前" /></label>
    <label className="field"><span className="field-label">接续说明（可选）</span>
      <input data-testid="continuation-note" value={note} maxLength={2000} disabled={busy}
        onChange={(event) => setNote(event.target.value)} placeholder="留给下次回来时的一句话" /></label>
    <button className="primary-button" type="button" data-testid="continuation-capture"
      disabled={blockedReason !== null}
      onClick={() => void capture({ id: createCommandId(), name: trimmedName,
        note: note.trim() === "" ? null : note.trim() })}>
      {busy ? "正在核对" : "保存当前接续点"}</button>
    {blockedReason && <p className="disabled-reason">{blockedReason}</p>}
    </details>
    {error && <p className="action-error" role="alert">{error}</p>}
    {message && <p className="success-callout" role="status">{message}</p>}
    {pending && <div className="warning-callout" data-testid="continuation-pending">
      <strong>保存结果待核对</strong>
      <p>原 command_id：{pending.id} · 名称「{pending.name}」。核对完成前不会生成新命令，也不会重复保存。</p>
      <button className="secondary-button" type="button" disabled={busy}
        onClick={() => void checkReceipt(pending)}>查询原命令回执</button>
    </div>}
  </section>;
}
