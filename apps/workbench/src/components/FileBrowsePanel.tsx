import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { createCommandId, managedFileReadOutcomeFrom, RelayApiError, RelayTransportError,
  type RelayApiClient, type RelayDirectoryEntry, type RelayFileBrowseAction,
  type RelayGatewayConnection, type RelayManagedFileReadInput, type RelayManagedFileReadResponse,
  type RelayManagedResource } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

/**
 * 人工受管目录浏览与文件读取（HTTP §10.112，迁移 0134）。
 *
 * 与 GitReadPanel 同一套纪律：打开或切页只读登记配置，浏览与读文件都是携带命令身份的
 * 显式动作；原未决命令跨面板关闭保留，结果不明先核对回执、绝不换 ID 重发。
 * 每次点击生成新 command_id——这是服务端约定的刷新语义（新命令＝新的读取事实）。
 */

type Purpose = { readonly kind: "LISTING"; readonly dirPath: string } |
  { readonly kind: "PREVIEW"; readonly filePath: string };

type PendingFileCommand = {
  readonly input: RelayManagedFileReadInput;
  readonly root: string;
  readonly purpose: Purpose;
  readonly phase: "SENDING" | "RESPONSE_UNKNOWN" | "WAITING_APPROVAL" | "UNRESOLVED";
  readonly operationId: string | null;
  readonly reviewId: string | null;
  readonly reason: string | null;
};

type ListingState = {
  readonly status: "loading" | "done" | "failed";
  readonly entries: readonly RelayDirectoryEntry[];
  readonly count: number;
  readonly limit: number;
  readonly truncated: boolean;
  readonly skipped: number;
  readonly error: string | null;
};

type PreviewState = {
  readonly path: string;
  readonly status: "loading" | "done" | "failed";
  readonly content: string | null;
  readonly size: number | null;
  readonly sha256: string | null;
  readonly truncated: boolean;
  readonly error: string | null;
};

function recoveryKey(client: RelayApiClient): string {
  return `relay-managed-file-pending:${client.baseUrl}:${client.workspaceId}`;
}

function readRecovery(key: string): readonly PendingFileCommand[] {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((record): record is PendingFileCommand => {
      const input = record?.input;
      return input && typeof input.projectId === "string" && typeof input.resourceId === "string" &&
        typeof input.connectionId === "string" && typeof input.commandId === "string" &&
        (input.actionType === "LIST_DIRECTORY" || input.actionType === "READ_FILE") &&
        (input.relativePath === undefined || typeof input.relativePath === "string") &&
        (input.limit === undefined || Number.isSafeInteger(input.limit)) &&
        typeof record.root === "string" && record.purpose &&
        (record.purpose.kind === "LISTING" ? typeof record.purpose.dirPath === "string"
          : record.purpose.kind === "PREVIEW" ? typeof record.purpose.filePath === "string" : false) &&
        ["SENDING", "RESPONSE_UNKNOWN", "WAITING_APPROVAL", "UNRESOLVED"].includes(record.phase);
    });
  } catch { return []; }
}

/** 服务端拒绝的人工可读说明。原文 detail 仍原样附带，界面不替换也不改写它。 */
const readRefusals: Record<string, string> = {
  GATEWAY_PERMISSION_DENIED: "服务端拒绝：当前项目或连接没有被授予这次只读动作的权限（浏览与读取是两条独立策略，只配其一是正确的失败关闭）。",
  GATEWAY_PERMISSION_STALE: "权限版本已过期：这次动作按旧版本判定被拒，需重新读取当前权限后再决定。",
  GATEWAY_CONNECTION_DENIED: "服务端拒绝：所选连接不允许这次动作（连接可能已停用或缺对应能力）。",
  GATEWAY_CONNECTION_STALE: "所选连接的版本已过期，不是当前可用的连接。",
  GATEWAY_APPROVAL_STALE: "批准已失效：这次动作不再由那一次批准放行，需重新批准。",
  GATEWAY_APPROVAL_CONSUMED: "批准已被消费：同一次批准不能用来派发第二次动作。",
  GATEWAY_APPROVAL_REQUIRED: "这次动作需要先获得批准，尚未执行。",
  GATEWAY_RESOURCE_ROOT_CHANGED:
    "受管目录已经不是登记时的那个目录（可能已重新登记）；不沿用旧结果，也不静默改读新根。",
  GATEWAY_ORIGIN_DENIED: "人工只读入口只放行受管资源上的 LIST_DIRECTORY 与 READ_FILE。",
  GATEWAY_INTENT_CONFLICT: "同一动作身份已绑定其他 Gateway 动作；本次拒绝如实呈现，不覆盖既有身份。",
  GATEWAY_ACTION_DENIED: "动作被准入拒绝，没有执行。",
  GATEWAY_TARGET_DENIED: "目标不被允许（路径可能不存在、不是普通文件或目录、或属于受保护路径），没有执行。",
  GATEWAY_DEADLINE_EXCEEDED: "执行超过服务端时限，没有拿到结算结果。",
  GATEWAY_IN_FLIGHT: "同一动作仍在途，结果未决。",
  GATEWAY_RESULT_UNRESOLVED: "结果未决（UNKNOWN）：既不能认定执行过，也不能认定没执行。",
  RESOURCE_OCCUPIED: "该目录正被其他在途动作占用或隔离（如一次未完成的写入）；稍后重试，不要反复换命令。",
  RESOURCE_NOT_FOUND: "受管目录不存在、已归档，或不属于当前项目。",
  VALIDATION_FAILED: "请求参数被服务端拒绝（例如 READ_FILE 缺路径或带了不支持的字段）。"
};
/** 落库的读取失败类别：失败不等于「目录为空」或「文件为空」，界面据此说明。 */
const readFailureReasons: Record<string, string> = {
  FILE_QUERY_DIRECTORY_UNREADABLE: "查询目录当前不可读（可能刚被删除或改名）。",
  FILE_QUERY_RESULT_MISSING: "本次目录读取没有留下结果正文。",
  FILE_READ_RESULT_MISSING: "本次文件读取没有留下正文。",
  FILE_BINARY_UNSUPPORTED: "该文件包含二进制内容（含 NUL 字节），只读入口不支持预览正文。",
  FILE_TOO_LARGE: "该文件超过 128 KiB 的读取上限，不能整篇读出。",
  FILE_NOT_REGULAR: "目标不是普通文件（可能是目录或特殊文件）。",
  FILE_UNAVAILABLE: "目标文件当前不可读（可能刚被删除、改名或被占用）。",
  GATEWAY_TARGET_CHANGED: "读取前后目标路径发生了替换（realpath 变化），结果按失败结算。",
  GATEWAY_DEADLINE_EXCEEDED: "执行超过服务端时限。"
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

function joinPath(dirPath: string, name: string): string {
  return dirPath === "" ? name : `${dirPath}/${name}`;
}

export default function FileBrowsePanel({ client, projectId, resources, resourceLoading, resourceError }: {
  client: RelayApiClient;
  projectId: string;
  resources: readonly RelayManagedResource[];
  resourceLoading: boolean;
  resourceError: string | null;
}) {
  const key = recoveryKey(client);
  const [pending, setPending] = useState<readonly PendingFileCommand[]>(() => readRecovery(key));
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const [connections, setConnections] = useState<readonly RelayGatewayConnection[]>([]);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [resourceId, setResourceId] = useState("");
  const [listings, setListings] = useState<Record<string, ListingState>>({});
  const [expanded, setExpanded] = useState<Readonly<Set<string>>>(() => new Set());
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const connectionRequest = useRef(0);

  const activeResources = resources.filter((resource) => resource.projectId === projectId && resource.status === "ACTIVE");
  const queryConnections = connections.filter((item) => item.status === "ACTIVE" && item.capabilities.includes("FILE_QUERY"));
  const readConnections = connections.filter((item) => item.status === "ACTIVE" && item.capabilities.includes("FILE_READ"));
  const queryConnectionId = queryConnections[0]?.id ?? "";
  const readConnectionId = readConnections[0]?.id ?? "";
  const recoverableResources = pending.filter((item) => item.input.projectId === projectId &&
    !activeResources.some((resource) => resource.id === item.input.resourceId));

  /** 与 GitReadPanel 同理由：拒绝之后必须重读连接，否则候选里还留着必然再失败的连接。 */
  const loadConnections = useCallback(async () => {
    const version = ++connectionRequest.current;
    setConnectionLoading(true);
    try {
      const loaded = await client.getGatewayConnections(projectId);
      if (version !== connectionRequest.current || !mounted.current) return;
      setConnections(loaded); setConnectionError(null);
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

  // 切资源即换树：已读目录与预览不跨目录保留，也不把旧目录的读取挪到新资源上重放。
  useEffect(() => { setListings({}); setExpanded(new Set()); setPreview(null); }, [resourceId]);

  const activeResource = activeResources.find((resource) => resource.id === resourceId);
  const currentPending = pending.find((item) => item.input.projectId === projectId && item.input.resourceId === resourceId);
  const blocked = resourceLoading || connectionLoading ? "正在读取受管目录与连接…"
    : resourceError ?? connectionError ?? (!activeResource ? "当前项目没有可用的 ACTIVE 受管目录。"
    : queryConnectionId === "" ? "当前项目没有可用的 FILE_QUERY 连接，无法浏览目录；请先在项目连接页配置。"
    : null);

  function updatePending(attempt: PendingFileCommand, next: PendingFileCommand | null) {
    // 以会话存储合并，迟到的旧请求不会覆盖其他目录或另一面板保留的原请求。
    const updated = readRecovery(key).filter((item) => item.input.commandId !== attempt.input.commandId);
    if (next) updated.push(next);
    window.sessionStorage.setItem(key, JSON.stringify(updated));
    if (mounted.current) { pendingRef.current = updated; setPending(updated); }
  }

  function remember(attempt: PendingFileCommand, response: RelayManagedFileReadResponse | null, message: string | null) {
    if (!mounted.current) return;
    if (attempt.purpose.kind === "LISTING") {
      const dirPath = attempt.purpose.dirPath;
      setListings((current) => ({ ...current, [dirPath]:
        response === null && message === null
          ? { status: "loading", entries: [], count: 0, limit: 0, truncated: false, skipped: 0, error: null }
          : response === null
            ? { status: "failed", entries: [], count: 0, limit: 0, truncated: false, skipped: 0, error: message }
            : routeListing(response) }));
    } else {
      const filePath = attempt.purpose.filePath;
      setPreview(response === null && message === null
        ? { path: filePath, status: "loading", content: null, size: null, sha256: null, truncated: false, error: null }
        : response === null
          ? { path: filePath, status: "failed", content: null, size: null, sha256: null, truncated: false, error: message }
          : { path: filePath, ...routePreview(response) });
    }
  }

  function routeListing(response: RelayManagedFileReadResponse):
    Pick<ListingState, "status" | "entries" | "count" | "limit" | "truncated" | "skipped" | "error"> {
    const outcome = response.outcome;
    const settled = outcome.state === "SUCCEEDED" || outcome.state === "FAILED" ? outcome : null;
    if (settled === null) throw new Error("未决文件读取不能携带已结算结果。");
    if (settled.result.kind === "FAILURE") {
      return { status: "failed", entries: [], count: 0, limit: 0, truncated: false, skipped: 0,
        error: describeFailure(settled.result.reason, settled.result.detail) };
    }
    if (settled.result.kind !== "LISTING") throw new Error("目录读取返回的不是目录列表。");
    return { status: "done", entries: settled.result.entries, count: settled.result.count,
      limit: settled.result.limit, truncated: settled.result.truncated,
      skipped: settled.result.skipped, error: null };
  }

  function routePreview(response: RelayManagedFileReadResponse):
    Pick<PreviewState, "status" | "content" | "size" | "sha256" | "truncated" | "error"> {
    const outcome = response.outcome;
    const settled = outcome.state === "SUCCEEDED" || outcome.state === "FAILED" ? outcome : null;
    if (settled === null) throw new Error("未决文件读取不能携带已结算结果。");
    if (settled.result.kind === "FAILURE") {
      return { status: "failed", content: null, size: null, sha256: null, truncated: false,
        error: describeFailure(settled.result.reason, settled.result.detail) };
    }
    if (settled.result.kind !== "CONTENT") throw new Error("文件读取返回的不是文件正文。");
    return { status: "done", content: settled.result.content, size: settled.result.size,
      sha256: settled.result.sha256, truncated: settled.result.truncated, error: null };
  }

  function accept(attempt: PendingFileCommand, response: RelayManagedFileReadResponse) {
    if (response.commandId !== attempt.input.commandId ||
        response.outcome.actionType !== attempt.input.actionType ||
        (attempt.operationId !== null && response.outcome.operationId !== attempt.operationId)) {
      throw new RelayTransportError("文件读取回执与原命令或动作身份不符，请继续核对原 ID。");
    }
    const outcome = response.outcome;
    const next = outcome.state === "WAITING_APPROVAL" || outcome.state === "UNRESOLVED"
      ? { ...attempt, phase: outcome.state, operationId: outcome.operationId, reviewId: outcome.reviewId, reason: outcome.reason }
      : null;
    updatePending(attempt, next);
    if (next !== null) return;
    if (attempt.purpose.kind === "LISTING") {
      if (!mounted.current) return;
      const dirPath = attempt.purpose.dirPath;
      setListings((current) => ({ ...current, [dirPath]: routeListing(response) }));
    } else {
      if (!mounted.current) return;
      const filePath = attempt.purpose.filePath;
      setPreview({ path: filePath, ...routePreview(response) });
    }
  }

  async function checkReceipt(attempt: PendingFileCommand): Promise<void> {
    const receipt = await client.getCommandReceipt(attempt.input.commandId);
    if (receipt.commandId !== attempt.input.commandId || receipt.commandType !== "ReadManagedFileState") {
      throw new RelayTransportError("回执不是原文件读取命令，请继续核对原 command_id。");
    }
    accept(attempt, { commandId: receipt.commandId, committedAt: receipt.committedAt,
      outcome: managedFileReadOutcomeFrom(receipt.result, attempt.input.actionType) });
  }

  async function send(attempt: PendingFileCommand) {
    try { accept(attempt, await client.readManagedFileState(attempt.input)); }
    catch (caught) {
      if (caught instanceof RelayApiError && caught.problem.status < 500 && caught.problem.code !== "COMMAND_ID_REUSED") {
        if (attempt.phase === "SENDING") updatePending(attempt, null);
        remember(attempt, null, describeRefusal(caught));
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

  async function runCommand(actionType: RelayFileBrowseAction, purpose: Purpose) {
    if (blocked || !activeResource || busyRef.current || currentPending) return;
    if (actionType === "LIST_DIRECTORY" && queryConnectionId === "") return;
    if (actionType === "READ_FILE" && readConnectionId === "") {
      // 浏览与读文件是两条独立策略/连接：只配了浏览时不把点击吞成无反馈。
      setPreview({ path: purpose.kind === "PREVIEW" ? purpose.filePath : "", status: "failed",
        content: null, size: null, sha256: null, truncated: false,
        error: "当前项目没有可用的 FILE_READ 连接，不能打开文件正文；请先在项目连接页配置 FILE_READ 连接与策略。" });
      return;
    }
    const relativePath = purpose.kind === "LISTING" ? purpose.dirPath : purpose.filePath;
    const input: RelayManagedFileReadInput = { projectId, resourceId, connectionId:
      actionType === "LIST_DIRECTORY" ? queryConnectionId : readConnectionId,
      commandId: createCommandId(), actionType,
      ...(relativePath === "" ? {} : { relativePath }) };
    const attempt: PendingFileCommand = { input, root: activeResource.canonicalRoot, purpose,
      phase: "SENDING", operationId: null, reviewId: null, reason: null };
    try { updatePending(attempt, attempt); }
    catch {
      remember(attempt, null, "本窗口无法保存原读取身份，请恢复会话存储后再读取。");
      return;
    }
    remember(attempt, null, null);
    busyRef.current = true; setBusy(true);
    try { await send(attempt); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }

  async function reconcile(continueApproved = false) {
    const attempt = currentPending;
    if (!attempt || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await checkReceipt(attempt); }
    catch (caught) {
      if (continueApproved && !blocked && attempt.phase === "WAITING_APPROVAL" &&
          attempt.reason === "ACTION_APPROVAL_REQUIRED" &&
          caught instanceof RelayApiError && caught.problem.status === 404) {
        await send(attempt);
      } else remember(attempt, null, receiptError(caught));
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }

  function toggleDir(dirPath: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(dirPath)) next.delete(dirPath); else next.add(dirPath);
      return next;
    });
    // 展开未读过的目录才发命令；已读过的沿用快照，刷新走行内按钮（新命令＝新事实）。
    if (!listings[dirPath]) void runCommand("LIST_DIRECTORY", { kind: "LISTING", dirPath });
  }

  function renderEntries(dirPath: string, entries: readonly RelayDirectoryEntry[], depth: number) {
    return <ul className="file-browse-list" data-testid={`file-browse-entries-${dirPath || "root"}`}>
      {entries.map((entry) => {
        const childPath = joinPath(dirPath, entry.path);
        const isDir = entry.kind === "directory";
        const isExpanded = expanded.has(childPath);
        return <li key={entry.path} className="file-browse-item">
          {isDir
            ? <span className="file-browse-row" style={{ paddingLeft: depth * 14 }}>
                <button type="button" className="text-button file-browse-toggle"
                  data-testid={`file-browse-dir-${childPath}`}
                  onClick={() => toggleDir(childPath)}>{isExpanded ? "▾" : "▸"} {entry.path}</button>
                <button type="button" className="text-button file-browse-refresh"
                  data-testid={`file-browse-refresh-${childPath}`}
                  disabled={busy || Boolean(currentPending)}
                  onClick={() => void runCommand("LIST_DIRECTORY", { kind: "LISTING", dirPath: childPath })}>刷新</button>
              </span>
            : entry.kind === "file"
              ? <button type="button" className="text-button file-browse-file"
                style={{ paddingLeft: depth * 14 + 18 }}
                data-testid={`file-browse-file-${childPath}`}
                disabled={busy || Boolean(currentPending)}
                title={entry.size === null ? undefined : `${entry.size} 字节`}
                onClick={() => { setPreview({ path: childPath, status: "loading", content: null, size: entry.size,
                  sha256: null, truncated: false, error: null });
                  void runCommand("READ_FILE", { kind: "PREVIEW", filePath: childPath }); }}>
                {entry.path}{entry.size === null ? "" : ` · ${entry.size} B`}
              </button>
              : <span className="file-browse-row helper-text" style={{ paddingLeft: depth * 14 + 18 }}>{entry.path} · 其他类型</span>}
          {isDir && isExpanded && renderDir(childPath, depth + 1)}
        </li>;
      })}
    </ul>;
  }

  function renderDir(dirPath: string, depth: number) {
    const state = listings[dirPath];
    // 这次读取已停在等待批准或未决：目录行如实指向待核对提示，不悬挂「正在读取」。
    if (currentPending !== undefined && currentPending.purpose.kind === "LISTING" &&
        currentPending.purpose.dirPath === dirPath) {
      return <p className="helper-text" role="status">这次目录读取尚未结算（等待批准或结果未决），见下方待核对提示。</p>;
    }
    if (state === undefined) {
      return <p className="helper-text" role="status">正在读取目录…</p>;
    }
    if (state.status === "loading") return <p className="helper-text" role="status">正在读取目录…</p>;
    if (state.error !== null) {
      return <p className="action-error" role="alert" data-testid={`file-browse-error-${dirPath || "root"}`}>
        {state.error} 这不等于目录为空或目录干净。</p>;
    }
    return <>
      {state.truncated && <p className="warning-callout" role="status">目录条目已截断：仅返回前 {state.entries.length} 项（上限 {state.limit}），不能作为完整清单。</p>}
      {state.skipped > 0 && <p className="helper-text">已按服务端规则跳过 {state.skipped} 个受保护或构建产物目录。</p>}
      {state.entries.length === 0 && !state.truncated
        ? <p className="helper-text">该目录没有可显示的条目（受保护与构建产物目录不列出）。</p>
        : renderEntries(dirPath, state.entries, depth)}
    </>;
  }

  return <section data-testid="file-browse" className="file-browse">
    <h3>目录浏览</h3>
    <p className="helper-text">浏览与读文件都是显式动作，产生服务端审计记录；这里只读，不写入、不上传、不执行。工作目录文件是受管目录下的普通文件，与任务产物版本不同源。</p>
    {blocked && <p className={resourceError || connectionError ? "action-error" : "helper-text"} role="status"
      data-testid="file-browse-blocked">{blocked}</p>}
    {!blocked && <div className="file-browse-fields">
      <label className="field"><span className="field-label">受管目录</span>
        <select data-testid="file-browse-resource" value={resourceId} disabled={Boolean(currentPending) || busy}
          onChange={(event) => setResourceId(event.target.value)}>
          {activeResources.map((resource) => <option key={resource.id} value={resource.id}>{resource.canonicalRoot}</option>)}
          {recoverableResources.map((attempt) => <option key={attempt.input.resourceId} value={attempt.input.resourceId}>
            原读取待核对 · {attempt.root}</option>)}
        </select></label>
      <p className="helper-text">浏览用 FILE_QUERY 连接{queryConnectionId === "" ? "（当前无可用连接）" : ""}
        {readConnectionId === "" ? "；读文件需要 FILE_READ 连接，当前项目没有配置，只能浏览不能打开正文。" : "；读文件用 FILE_READ 连接。"}</p>
    </div>}
    {!blocked && <div className="git-read-actions">
      <button type="button" className="secondary-button" data-testid="file-browse-open-root"
        disabled={Boolean(currentPending) || busy}
        onClick={() => { setExpanded((current) => new Set(current).add(""));
          void runCommand("LIST_DIRECTORY", { kind: "LISTING", dirPath: "" }); }}>
        {listings[""]?.status === "done" ? "重新读取根目录" : "读取根目录"}</button>
    </div>}
    {!blocked && currentPending && <div className="warning-callout" role="status" data-testid="file-browse-pending">
      <p>{busy ? "正在读取或核对原命令…" : currentPending.phase === "WAITING_APPROVAL"
        ? "等待动作批准，尚未读取。" : currentPending.phase === "UNRESOLVED"
        ? "动作结果未决（UNKNOWN / 在途），不能重新读取；先人工核对原动作。"
        : "读取响应尚未确定，先核对原命令回执。"}
        原 command_id：{currentPending.input.commandId}</p>
      <p>已知：目录 {currentPending.root} 与这次{currentPending.input.actionType === "LIST_DIRECTORY"
        ? `目录浏览（${currentPending.input.relativePath ?? "受管根"}）` : `文件读取（${currentPending.input.relativePath ?? ""}）`}
        已冻结成同一个动作身份。未知：这次读取在服务端是否已经执行、结果是什么。
        可做：按原身份核对，不要另起一次读取。</p>
      {currentPending.reason && <p>{currentPending.reason}</p>}
      {currentPending.operationId !== null && <p>原 operation_id：{currentPending.operationId}
        {currentPending.reviewId !== null && ` · 原 Review ${currentPending.reviewId}`}</p>}
      <div className="git-read-actions">
        <button className="secondary-button" type="button" data-testid="file-browse-check-receipt" disabled={busy}
          onClick={() => void reconcile()}>核对原命令回执</button>
        {currentPending.reviewId && <Link className="text-link" data-testid="file-browse-review"
          to={`/reviews?id=${encodeURIComponent(currentPending.reviewId)}`}>打开原 Review</Link>}
        {currentPending.phase === "WAITING_APPROVAL" && currentPending.reason === "ACTION_APPROVAL_REQUIRED" &&
          <button className="secondary-button" type="button" data-testid="file-browse-continue" disabled={busy || Boolean(blocked)}
            onClick={() => void reconcile(true)}>批准后沿原命令继续读取</button>}
      </div>
    </div>}
    {!blocked && expanded.has("") && renderDir("", 0)}
    {preview && <section className="devtools-operation" data-testid="file-preview">
      <h4>文件预览 · <code className="hash-code">{preview.path}</code></h4>
      {preview.status === "loading" && <p className="helper-text" role="status">正在读取文件…</p>}
      {preview.status === "failed" && <p className="action-error" role="alert" data-testid="file-preview-error">{preview.error}</p>}
      {preview.status === "done" && <>
        <p className="helper-text">大小 {preview.size ?? "?"} 字节 · SHA-256 <code className="hash-code">{preview.sha256}</code>
          {preview.truncated ? " · 内容已截断" : ""}</p>
        <pre className="devtools-output">{preview.content}</pre>
      </>}
    </section>}
  </section>;
}
