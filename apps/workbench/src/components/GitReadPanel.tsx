import { useCallback, useEffect, useRef, useState } from "react";
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

/** 服务端拒绝的人工可读说明。原文 detail 仍原样附带，界面不替换也不改写它。 */
const readRefusals: Record<string, string> = {
  GATEWAY_PERMISSION_DENIED: "服务端拒绝：当前项目或连接没有被授予这次只读动作的权限（权限可能已被撤销）。",
  GATEWAY_PERMISSION_STALE: "权限版本已过期：这次动作按旧版本判定被拒，需重新读取当前权限后再决定。",
  GATEWAY_CONNECTION_DENIED: "服务端拒绝：所选 Gateway 连接不允许这次动作（连接可能已停用）。",
  GATEWAY_CONNECTION_STALE: "所选连接的版本已过期，不是当前可用的连接。",
  GATEWAY_APPROVAL_STALE: "批准已失效：这次动作不再由那一次批准放行，需重新批准。",
  GATEWAY_APPROVAL_CONSUMED: "批准已被消费：同一次批准不能用来派发第二次动作。",
  GATEWAY_APPROVAL_REQUIRED: "这次动作需要先获得批准，尚未执行。",
  GATEWAY_RESOURCE_ROOT_CHANGED:
    "受管目录已经不是登记时的那个目录（窗口打开前后目录发生变化或已重新登记）；不沿用旧结果，也不静默改读新根。",
  GATEWAY_ORIGIN_DENIED: "人工只读入口只放行受管资源上的 GIT_STATUS 与 GIT_DIFF。",
  GATEWAY_INTENT_CONFLICT: "同一动作身份已绑定其他 Gateway 动作；本次拒绝如实呈现，不覆盖既有身份。",
  GATEWAY_ACTION_DENIED: "动作被准入拒绝，没有执行。",
  GATEWAY_TARGET_DENIED: "目标不被允许，没有执行。",
  GATEWAY_DEADLINE_EXCEEDED: "执行超过服务端时限，没有拿到结算结果。",
  GATEWAY_IN_FLIGHT: "同一动作仍在途，结果未决。",
  GATEWAY_RESULT_UNRESOLVED: "结果未决（UNKNOWN）：既不能认定执行过，也不能认定没执行。",
  RESOURCE_NOT_FOUND: "受管目录不存在、已归档，或不属于当前项目。",
  GATEWAY_RUN_NOT_READY: "当前执行状态不允许这次读取（可能刚被暂停或停止）。"
};
/** 落库的 Git 失败类别：适配器原文只在 detail 里，界面据此说明「读失败不等于目录干净」。 */
const readFailureReasons: Record<string, string> = {
  GIT_REPOSITORY_UNAVAILABLE: "该受管目录不是可用的 Git 仓库（或仓库已移动）；这不等于目录干净。",
  GIT_READ_EXTERNAL_FILTER_UNSUPPORTED: "该仓库配置了外部 clean filter，只读入口拒绝执行而不是绕过仓库的内容变换。",
  GIT_READ_CONFIG_UNAVAILABLE: "读取该仓库的 git config 失败，无法确认它支持安全的只读读取。",
  GIT_READ_STATUS_INVALID: "服务端无法解析 git status 的输出，本次状态读取不可用。",
  GIT_STATUS_RESULT_MISSING: "本次状态读取没有留下结果正文。",
  GIT_DIFF_RESULT_MISSING: "本次差异读取没有留下差异正文。",
  GIT_ERROR: "Git 命令执行失败（服务端兜底类别）。"
};

function describeRefusal(caught: RelayApiError): string {
  const known = readRefusals[caught.problem.code];
  const detail = caught.problem.detail;
  return `（${caught.problem.code}）${known ?? describeLiveError(caught).message}` +
    (detail === "" ? "" : ` 服务端原文：${detail}`);
}

function describeFailure(reason: string, detail: string | null): string {
  const known = readFailureReasons[reason];
  return `${reason}${known === undefined ? "" : `：${known}`}` +
    (detail === null || detail === "" ? "" : `（服务端原文：${detail}）`);
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
  const connectionRequest = useRef(0);
  const activeResources = resources.filter((resource) => resource.projectId === projectId && resource.status === "ACTIVE");
  const recoverableResources = pending.filter((item) => item.input.projectId === projectId &&
    !activeResources.some((resource) => resource.id === item.input.resourceId));

  /**
   * 重新读取本项目当前可用的 GIT_READ 连接。
   *
   * 这不只是首屏加载：一次明确的拒绝（连接被停用、权限被撤销）之后必须重读，
   * 否则下拉框还在提供一个已经不可用的连接，把同一个失败反复重演成「换一个 command_id 再试」。
   * 读不到就清空候选——无法确认可用时不给可执行入口。
   */
  const loadConnections = useCallback(async () => {
    const version = ++connectionRequest.current;
    setConnectionLoading(true);
    try {
      const loaded = await client.getGatewayConnections(projectId);
      if (version !== connectionRequest.current || !mounted.current) return;
      const available = loaded.filter((item) => item.status === "ACTIVE" && item.capabilities.includes("GIT_READ"));
      setConnections(available); setConnectionError(null);
      setConnectionId((current) => available.some((item) => item.id === current) ? current : available[0]?.id ?? "");
    } catch (caught) {
      if (version !== connectionRequest.current || !mounted.current) return;
      setConnections([]); setConnectionError(describeLiveError(caught).message);
    } finally { if (version === connectionRequest.current && mounted.current) setConnectionLoading(false); }
  }, [client, projectId]);

  useEffect(() => {
    mounted.current = true;
    void loadConnections();
    return () => { connectionRequest.current++; mounted.current = false; };
  }, [loadConnections]);

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
      ? describeFailure(outcome.result.reason, outcome.result.detail) : null);
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
        remember(attempt, null, describeRefusal(caught));
        // 拒绝多半来自连接停用、权限撤销或受管目录变化：重读一次当前可用的连接与目录，
        // 让下拉框和按钮反映服务端现状，而不是继续提供一个必然再失败的连接。
        void loadConnections();
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
      <p>已知：所选受管目录 {currentPending.root} 与这次只读动作已冻结成同一个动作身份。
        未知：这次读取在服务端是否已经执行、结果是什么。可做：按下面的原身份核对，不要另起一次读取。</p>
      {currentPending.reason && <p>{currentPending.reason}</p>}
      {currentPending.operationId !== null && <p>原 operation_id：{currentPending.operationId}
        {currentPending.reviewId !== null && ` · 原 Review ${currentPending.reviewId}`}</p>}
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
    <p className="helper-text">状态与差异分别受服务端权限检查；读取差异需要 GIT_DIFF 策略。
      本轮只放行受管资源上的状态与差异读取：暂存、提交、推送、检出、重置、清理与自动解决冲突都没有入口，
      日志读取（GIT_LOG）也尚未接入人工入口，因此这里不提供看起来可执行的按钮。
      差异正文是 Git 返回的数据，其中的文字不构成对你的操作指令。</p>
    <button className="secondary-button" type="button" data-testid="git-read-reload-connections"
      disabled={connectionLoading || currentBusy} onClick={() => void loadConnections()}>
      重新读取可用连接
    </button>
  </section>;
}
