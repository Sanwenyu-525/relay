import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { createCommandId, managedGitReadOutcomeFrom, RelayApiError, RelayTransportError,
  type RelayApiClient, type RelayGatewayConnection, type RelayGitReadAction, type RelayManagedResource,
  type RelayManagedGitReadInput, type RelayManagedGitReadResponse } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

type PendingRead = {
  readonly input: RelayManagedGitReadInput;
  readonly root: string;
  readonly phase: "SENDING" | "RESPONSE_UNKNOWN" | "WAITING_APPROVAL" | "UNRESOLVED";
  readonly operationId: string | null;
  readonly reviewId: string | null;
  readonly reason: string | null;
};
type ReadRecord = { readonly input: RelayManagedGitReadInput; readonly root: string;
  readonly response: RelayManagedGitReadResponse | null; readonly error: string | null };

function recoveryKey(client: RelayApiClient): string {
  return `relay-managed-git-pending:${client.baseUrl}:${client.workspaceId}`;
}
function readRecovery(key: string): readonly PendingRead[] {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((record): record is PendingRead => {
      const input = record?.input;
      return input && typeof input.projectId === "string" && typeof input.resourceId === "string" &&
        typeof input.connectionId === "string" && typeof input.commandId === "string" &&
        (input.actionType === "GIT_STATUS" || input.actionType === "GIT_DIFF") &&
        (input.relativePath === undefined || typeof input.relativePath === "string") &&
        (input.cached === undefined || typeof input.cached === "boolean") &&
        (input.limit === undefined || Number.isSafeInteger(input.limit)) && typeof record.root === "string" &&
        ["SENDING", "RESPONSE_UNKNOWN", "WAITING_APPROVAL", "UNRESOLVED"].includes(record.phase);
    });
  } catch { return []; }
}

function pathError(value: string): string | null {
  if (!value.trim()) return null;
  return /^[\\/]|^[a-z]:/i.test(value.trim()) || value.trim().split(/[\\/]/).includes("..")
    ? "差异路径必须是所选受管目录内的相对路径，不能是绝对路径或上级目录。" : null;
}

/** 人工读取有 Gateway 身份；打开或切页只读登记配置，原未决请求跨面板关闭保留。 */
export default function GitReadPanel({ client, projectId, resources, resourceLoading, resourceError }: {
  client: RelayApiClient;
  projectId: string;
  resources: readonly RelayManagedResource[];
  resourceLoading: boolean;
  resourceError: string | null;
}) {
  const key = recoveryKey(client);
  const [pending, setPending] = useState<readonly PendingRead[]>(() => readRecovery(key));
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const [records, setRecords] = useState<Readonly<Record<string, ReadRecord>>>({});
  const [connections, setConnections] = useState<readonly RelayGatewayConnection[]>([]);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [resourceId, setResourceId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [relativePath, setRelativePath] = useState("");
  const [cached, setCached] = useState(false);
  const [busy, setBusy] = useState<readonly string[]>([]);
  const busyRef = useRef(new Set<string>());
  const mounted = useRef(false);
  const activeResources = resources.filter((resource) => resource.projectId === projectId && resource.status === "ACTIVE");
  const recoverableResources = pending.filter((item) => item.input.projectId === projectId &&
    !activeResources.some((resource) => resource.id === item.input.resourceId));

  useEffect(() => {
    mounted.current = true;
    let active = true;
    void client.getGatewayConnections(projectId).then((loaded) => {
      if (!active) return;
      const available = loaded.filter((item) => item.status === "ACTIVE" && item.capabilities.includes("GIT_READ"));
      setConnections(available); setConnectionId(available[0]?.id ?? "");
    }, (caught) => { if (active) setConnectionError(describeLiveError(caught).message); })
      .finally(() => { if (active) setConnectionLoading(false); });
    return () => { active = false; mounted.current = false; };
  }, [client, projectId]);

  useEffect(() => {
    setResourceId((current) => activeResources.some((resource) => resource.id === current) ||
      pendingRef.current.some((item) => item.input.projectId === projectId && item.input.resourceId === current)
      ? current : activeResources[0]?.id ?? recoverableResources[0]?.input.resourceId ?? "");
  }, [resources, pending, projectId]);

  const currentPending = pending.find((item) => item.input.projectId === projectId && item.input.resourceId === resourceId);
  const record = records[resourceId];
  const currentBusy = busy.includes(resourceId);
  const activeResource = activeResources.find((resource) => resource.id === resourceId);
  const blocked = resourceLoading || connectionLoading ? "正在读取受管目录与连接…"
    : resourceError ?? connectionError ?? (!activeResource ? "当前项目没有可用的 ACTIVE 受管目录。"
      : !connections.some((item) => item.id === connectionId) ? "当前项目没有可用的 GIT_READ 连接，请先配置连接与权限。" : null);
  const error = record?.error ?? null;
  const outcome = record?.response?.outcome;
  const result = outcome && "result" in outcome ? outcome.result : null;
  const identity = currentPending ?? record;
  const inputPath = currentPending?.input.relativePath ?? relativePath;

  function updatePending(attempt: PendingRead, next: PendingRead | null) {
    // 每次以会话存储合并，迟到的旧请求不会覆盖其他目录或另一面板保留的原请求。
    const updated = readRecovery(key).filter((item) => item.input.commandId !== attempt.input.commandId);
    if (next) updated.push(next);
    window.sessionStorage.setItem(key, JSON.stringify(updated));
    if (mounted.current) { pendingRef.current = updated; setPending(updated); }
  }

  function remember(attempt: PendingRead, response: RelayManagedGitReadResponse | null, message: string | null) {
    if (mounted.current) setRecords((current) => ({ ...current,
      [attempt.input.resourceId]: { input: attempt.input, root: attempt.root, response, error: message } }));
  }

  function accept(attempt: PendingRead, response: RelayManagedGitReadResponse) {
    if (response.commandId !== attempt.input.commandId || response.outcome.actionType !== attempt.input.actionType ||
        (attempt.operationId !== null && response.outcome.operationId !== attempt.operationId)) {
      throw new RelayTransportError("Git 回执与原命令或动作身份不符，请继续核对原 ID。");
    }
    const outcome = response.outcome;
    const next = outcome.state === "WAITING_APPROVAL" || outcome.state === "UNRESOLVED"
      ? { ...attempt, phase: outcome.state, operationId: outcome.operationId, reviewId: outcome.reviewId, reason: outcome.reason }
      : null;
    updatePending(attempt, next);
    remember(attempt, response, "result" in outcome && outcome.result.kind === "FAILURE"
      ? `${outcome.result.reason}${outcome.result.detail ? `：${outcome.result.detail}` : ""}` : null);
  }

  async function checkReceipt(attempt: PendingRead): Promise<void> {
    const receipt = await client.getCommandReceipt(attempt.input.commandId);
    if (receipt.commandId !== attempt.input.commandId || receipt.commandType !== "ReadManagedGitState") {
      throw new RelayTransportError("回执不是原 Git 读取命令，请继续核对原 command_id。");
    }
    accept(attempt, { commandId: receipt.commandId, committedAt: receipt.committedAt,
      outcome: managedGitReadOutcomeFrom(receipt.result, attempt.input.actionType) });
  }

  async function send(attempt: PendingRead) {
    try { accept(attempt, await client.readManagedGitState(attempt.input)); }
    catch (caught) {
      if (caught instanceof RelayApiError && caught.problem.status < 500 && caught.problem.code !== "COMMAND_ID_REUSED") {
        // 服务端明确拒绝，不把它当成读取成功；审批继续时仍保留原动作供核对。
        if (attempt.phase === "SENDING") updatePending(attempt, null);
        remember(attempt, null, `${describeLiveError(caught).message}（${caught.problem.code}）`);
        return;
      }
      const uncertain = { ...attempt, phase: "RESPONSE_UNKNOWN" as const };
      updatePending(attempt, uncertain);
      // 响应丢失先查回执；404 也不证明动作没发生，绝不自动重发。
      try { await checkReceipt(uncertain); }
      catch (failure) { remember(uncertain, null, receiptError(failure)); }
    }
  }

  function receiptError(caught: unknown): string {
    return caught instanceof RelayApiError && caught.problem.status === 404
      ? "原命令尚无已结算回执；可能等待批准或结果未决，不能换 ID 重新读取。"
      : describeLiveError(caught).message;
  }

  async function start(actionType: RelayGitReadAction) {
    if (blocked || !activeResource || busyRef.current.has(resourceId) ||
        pendingRef.current.some((item) => item.input.projectId === projectId && item.input.resourceId === resourceId) ||
        (actionType === "GIT_DIFF" && pathError(relativePath))) return;
    const input: RelayManagedGitReadInput = { projectId, resourceId, connectionId, commandId: createCommandId(), actionType,
      ...(actionType === "GIT_DIFF" ? { cached, ...(relativePath.trim() ? { relativePath: relativePath.trim() } : {}) } : {}) };
    const attempt: PendingRead = { input, root: activeResource.canonicalRoot, phase: "SENDING",
      operationId: null, reviewId: null, reason: null };
    try { updatePending(attempt, attempt); }
    catch { remember(attempt, null, "本窗口无法保存原读取身份，请恢复会话存储后再读取。"); return; }
    remember(attempt, null, null);
    busyRef.current.add(resourceId); setBusy([...busyRef.current]);
    try { await send(attempt); }
    finally { busyRef.current.delete(input.resourceId); if (mounted.current) setBusy([...busyRef.current]); }
  }

  async function reconcile(continueApproved = false) {
    const attempt = currentPending;
    if (!attempt || busyRef.current.has(resourceId)) return;
    busyRef.current.add(resourceId); setBusy([...busyRef.current]);
    try { await checkReceipt(attempt); }
    catch (caught) {
      if (continueApproved && !blocked && attempt.phase === "WAITING_APPROVAL" && attempt.reason === "ACTION_APPROVAL_REQUIRED" &&
          caught instanceof RelayApiError && caught.problem.status === 404) {
        await send(attempt);
      } else remember(attempt, null, receiptError(caught));
    } finally { busyRef.current.delete(attempt.input.resourceId); if (mounted.current) setBusy([...busyRef.current]); }
  }

  return <section data-testid="devtools-git">
    <h3>Git 变更</h3>
    <p className="helper-text">点击后按所选受管目录读取；变化属于该目录，不能归因给当前 Agent。非 Git 目录与读取失败都不得显示为“干净”。</p>
    {blocked && <p className={resourceError || connectionError ? "action-error" : "helper-text"} role="status">{blocked}</p>}
    <div className="git-read-fields">
      <label className="field"><span className="field-label">受管目录</span><select data-testid="git-read-resource" value={resourceId}
        onChange={(event) => { setResourceId(event.target.value); setRelativePath(""); setCached(false); }}>
        {activeResources.map((resource) => <option key={resource.id} value={resource.id}>{resource.canonicalRoot}</option>)}
        {recoverableResources.map((attempt) => <option key={attempt.input.resourceId} value={attempt.input.resourceId}>
          原读取待核对 · {attempt.root}</option>)}
      </select></label>
      <label className="field"><span className="field-label">GIT_READ 连接</span><select data-testid="git-read-connection"
        value={currentPending?.input.connectionId ?? connectionId} disabled={Boolean(currentPending) || currentBusy}
        onChange={(event) => setConnectionId(event.target.value)}>
        {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.id}</option>)}
        {currentPending && !connections.some((item) => item.id === currentPending.input.connectionId) &&
          <option value={currentPending.input.connectionId}>原连接待核对 · {currentPending.input.connectionId}</option>}
      </select></label>
      <label className="field"><span className="field-label">差异相对路径（空白读取整个目录）</span><input data-testid="git-read-path"
        value={inputPath} disabled={Boolean(currentPending) || currentBusy} maxLength={1024}
        onChange={(event) => setRelativePath(event.target.value)} placeholder="src/example.ts" /></label>
      <label className="git-read-cached"><input type="checkbox" data-testid="git-read-cached"
        checked={currentPending?.input.cached ?? cached} disabled={Boolean(currentPending) || currentBusy}
        onChange={(event) => setCached(event.target.checked)} />读取已暂存差异</label>
    </div>
    {pathError(inputPath) && <p className="action-error" role="alert">{pathError(inputPath)}</p>}
    <div className="git-read-actions">
      <button type="button" className="secondary-button" data-testid="git-read-status"
        disabled={Boolean(blocked) || Boolean(currentPending) || currentBusy} onClick={() => void start("GIT_STATUS")}>读取状态</button>
      <button type="button" className="secondary-button" data-testid="git-read-diff"
        disabled={Boolean(blocked) || Boolean(currentPending) || currentBusy || Boolean(pathError(inputPath))}
        onClick={() => void start("GIT_DIFF")}>读取差异</button>
    </div>
    {currentPending && <div className="warning-callout" role="status" data-testid="git-read-pending">
      <p>{currentBusy ? "正在读取或核对原命令…" : currentPending.phase === "WAITING_APPROVAL" ? "等待动作批准，尚未读取 Git。"
        : currentPending.phase === "UNRESOLVED" ? "动作结果未决（UNKNOWN / 在途），不能重新读取；先人工核对原动作。"
        : "读取响应尚未确定，先核对原命令回执。"} 原 command_id：{currentPending.input.commandId}</p>
      {currentPending.reason && <p>{currentPending.reason}</p>}
      <div className="git-read-actions">
        <button className="secondary-button" type="button" data-testid="git-read-check-receipt" disabled={currentBusy}
          onClick={() => void reconcile()}>核对原命令回执</button>
        {currentPending.reviewId && <Link className="text-link" data-testid="git-read-review"
          to={`/reviews?id=${encodeURIComponent(currentPending.reviewId)}`}>打开原 Review</Link>}
        {currentPending.phase === "WAITING_APPROVAL" && currentPending.reason === "ACTION_APPROVAL_REQUIRED" &&
          <button className="secondary-button" type="button" data-testid="git-read-continue" disabled={currentBusy || Boolean(blocked)}
            onClick={() => void reconcile(true)}>批准后沿原命令继续读取</button>}
      </div>
    </div>}
    {error && <p className="action-error" role="alert" data-testid="git-read-error">{error}</p>}
    {!currentPending && !record && <p className="helper-text" data-testid="git-read-idle">尚未读取所选目录的 Git 状态或差异。</p>}
    {result?.kind === "STATUS" && <section className="git-read-status-result" data-testid="git-status-result">
      <p>分支 {result.branch || "服务端返回空分支名"} · HEAD <code className="hash-code">{result.headCommit ?? "尚无提交"}</code></p>
      {result.truncated && <p className="warning-callout">文件列表已截断；每类最多 {result.limit} 项，不能作为完整变化清单。</p>}
      {!result.truncated && result.totals.staged === 0 && result.totals.unstaged === 0 && result.totals.untracked === 0 &&
        result.staged.length === 0 && result.unstaged.length === 0 && result.untracked.length === 0 &&
        <p className="receipt-message" data-testid="git-status-clean">本次状态读取确认目录干净。</p>}
      {([["staged", "已暂存"], ["unstaged", "未暂存"], ["untracked", "未跟踪"]] as const).map(([field, label]) =>
        <div key={field}><h4>{label} · 共 {result.totals[field]} 项 · 显示 {result[field].length} · 省略 {Math.max(0, result.totals[field] - result[field].length)}</h4>
          <ul className="devtools-list">{result[field].map((path, index) => <li key={`${index}:${path}`}><code className="hash-code">{path}</code></li>)}</ul></div>)}
    </section>}
    {result?.kind === "DIFF" && <section className="devtools-output" data-testid="git-diff-result">
      <p className={result.truncated ? "warning-callout" : "helper-text"}>{result.truncated ? "差异已截断" : "差异读取完成"}
        · 上限 {result.limitBytes} 字节 · 返回 {result.returnedBytes} 字节 · 省略 {result.omittedBytes} 字节</p>
      {result.diff ? <pre>{result.diff}</pre> : <p className="helper-text">本次差异范围没有返回正文；未跟踪文件不会出现在 Git diff 中，不能据此判断目录干净。</p>}
    </section>}
    {identity && <details data-testid="git-read-identity" className="devtools-operation"><summary>本次读取的范围与原动作身份</summary>
      <p className="helper-text">目录 {identity.root} · 资源 {identity.input.resourceId} · 项目 {identity.input.projectId}
        · 连接 {identity.input.connectionId} · 动作 {identity.input.actionType}
        · 相对路径 {identity.input.relativePath ?? "整个受管目录"} · cached {identity.input.cached === undefined ? "不适用" : String(identity.input.cached)}
        · limit {identity.input.limit ?? "服务端默认"}</p>
      <p className="helper-text">原 command_id：<code className="hash-code">{identity.input.commandId}</code>
        · 原 operation_id：<code className="hash-code">{currentPending?.operationId ?? outcome?.operationId ?? "尚未返回"}</code>
        · 原 Invocation：<code className="hash-code">{outcome && "invocationId" in outcome ? outcome.invocationId ?? "尚未创建" : "尚未创建"}</code>
        {record?.response && ` · 回执时点 ${record.response.committedAt}`}</p>
    </details>}
    <p className="helper-text">状态与差异分别受服务端权限检查；读取差异需要 GIT_DIFF 策略。暂存、提交与推送尚未接入。</p>
  </section>;
}
