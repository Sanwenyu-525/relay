import { useEffect, useRef, useState } from "react";
import { createCommandId, RelayApiError, RelayTransportError, viewConfigurationFrom,
  type RelayApiClient, type RelayCommandEnvelope, type RelayViewConfiguration, type RelayViewKind }
  from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import "./ViewConfigurationPanel.css";

const kinds: readonly { kind: RelayViewKind; label: string }[] = [
  { kind: "general", label: "通用" }, { kind: "thesis", label: "论文" },
  { kind: "development", label: "开发" }
];
const pageLabels: Readonly<Record<string, string>> = {
  state: "项目状态", tasks: "任务", artifacts: "产物", reviews: "待审",
  knowledge: "资料", runs: "运行", connections: "连接"
};
interface PendingViewCommand {
  readonly id: string;
  readonly expectedRevision: string;
  readonly kind: RelayViewKind;
  readonly conflict: boolean;
}

function commandKey(client: RelayApiClient, projectId: string): string {
  return `relay:view-configuration:${client.baseUrl}:${client.workspaceId}:${projectId}`;
}

function readPending(key: string): PendingViewCommand | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || !/^(0|[1-9][0-9]*)$/u.test(String(row.expectedRevision)) ||
      !kinds.some((item) => item.kind === row.kind)) return null;
    return { id: row.id, expectedRevision: String(row.expectedRevision),
      kind: row.kind as RelayViewKind, conflict: row.conflict === true };
  } catch { return null; }
}

function savePending(key: string, pending: PendingViewCommand | null): void {
  try {
    if (pending) sessionStorage.setItem(key, JSON.stringify(pending));
    else sessionStorage.removeItem(key);
  } catch { /* The active page still retains the frozen command. */ }
}

function kindLabel(kind: RelayViewKind): string {
  return kinds.find((item) => item.kind === kind)?.label ?? kind;
}

function confirmedResult(envelope: RelayCommandEnvelope, command: PendingViewCommand,
  projectId: string): RelayViewConfiguration {
  if (envelope.commandId !== command.id) throw new RelayTransportError("回执的 command_id 不匹配。");
  const result = viewConfigurationFrom(envelope.result);
  if (result.projectId !== projectId || result.kind !== command.kind ||
    BigInt(result.revision) <= BigInt(command.expectedRevision)) {
    throw new RelayTransportError("回执中的项目、视图或修订无法核对。");
  }
  return result;
}

export default function ViewConfigurationPanel({ client, projectId, browseKind, projectArchivedAt }: {
  readonly client: RelayApiClient | null;
  readonly projectId: string;
  /** 有值时为工作台浏览页；无值时为项目设置。 */
  readonly browseKind?: RelayViewKind;
  /** undefined 表示 Project 事实尚未确认或读取失败。 */
  readonly projectArchivedAt?: string | null;
}) {
  const [current, setCurrent] = useState<RelayViewConfiguration | null>(null);
  const [selectedKind, setSelectedKind] = useState<RelayViewKind | null>(null);
  const [pending, setPending] = useState<PendingViewCommand | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mayRetry, setMayRetry] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const pendingRef = useRef<PendingViewCommand | null>(null);
  const scope = useRef(0);
  const key = client ? commandKey(client, projectId) : null;

  async function refresh(activeClient: RelayApiClient, request: number): Promise<RelayViewConfiguration | null> {
    setLoading(true); setError(null);
    try {
      const next = await activeClient.getViewConfiguration(projectId);
      if (next.projectId !== projectId) throw new Error("视图配置查询返回了其他项目的数据。");
      if (request === scope.current) setCurrent(next);
      return next;
    } catch (caught) {
      if (request === scope.current) setError(describeLiveError(caught).message);
      return null;
    } finally { if (request === scope.current) setLoading(false); }
  }

  function freeze(command: PendingViewCommand | null) {
    pendingRef.current = command;
    setPending(command);
    if (key) savePending(key, command);
  }

  async function resolveSuccess(activeClient: RelayApiClient, command: PendingViewCommand,
    envelope: RelayCommandEnvelope, request: number) {
    const result = confirmedResult(envelope, command, projectId);
    if (request !== scope.current) return;
    setCurrent(result);
    freeze(null); setMayRetry(false); setError(null);
    const latest = await refresh(activeClient, request);
    if (request !== scope.current) return;
    setMessage(latest === null ? "原命令回执已确认；最新配置查询失败，请稍后刷新。" :
      latest.revision === result.revision && latest.kind === result.kind
        ? `默认工作台已保存为${kindLabel(result.kind)}；回执与最新配置一致。`
        : "原命令回执已确认；服务端当前配置已有后续修订，页面显示最新查询结果。");
  }

  async function checkReceipt(command: PendingViewCommand, activeClient: RelayApiClient, request: number) {
    setBusy(true);
    try {
      const receipt = await activeClient.getCommandReceipt(command.id);
      if (request !== scope.current) return;
      if (receipt.commandType !== "SetViewConfiguration") throw new RelayTransportError("原命令回执类型不匹配。");
      await resolveSuccess(activeClient, command, receipt, request);
    } catch (caught) {
      if (request !== scope.current) return;
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetry(!command.conflict);
        setError(command.conflict
          ? "这个视图在别处已被改过，而且没查到这次保存的结果。先核对最新配置，再明确重新提交。"
          : "还没查到这次保存的结果。可以重新核对；确认没有保存时再重试。");
      } else setError("还无法核对这次保存的结果，请稍后重新核对。");
    } finally { if (request === scope.current) setBusy(false); }
  }

  useEffect(() => {
    const request = ++scope.current;
    pendingRef.current = null; setPending(null); setCurrent(null); setSelectedKind(null);
    setMayRetry(false); setError(null); setMessage(null);
    if (!client || !key) return () => { scope.current++; };
    const restored = readPending(key);
    pendingRef.current = restored; setPending(restored);
    if (restored) setSelectedKind(restored.kind);
    void refresh(client, request).then((next) => {
      if (request !== scope.current) return;
      if (next && !restored) setSelectedKind(next.kind);
      if (restored) void checkReceipt(restored, client, request);
    });
    return () => { scope.current++; pendingRef.current = null; };
  }, [client, projectId, key]);

  async function send(command: PendingViewCommand, retry = false) {
    if (!client || busy || !current || (!retry && (projectArchivedAt !== null || loading || error !== null)) ||
      (pendingRef.current && (!retry || pendingRef.current !== command))) return;
    const request = scope.current;
    freeze(command); setBusy(true); setMayRetry(false); setError(null); setMessage(null);
    try {
      const envelope = await client.setViewConfiguration({ projectId, commandId: command.id,
        expectedRevision: command.expectedRevision, kind: command.kind });
      if (request === scope.current) await resolveSuccess(client, command, envelope, request);
    } catch (caught) {
      if (request !== scope.current) return;
      if (caught instanceof RelayApiError && caught.problem.code === "REVISION_CONFLICT") {
        const conflicted = { ...command, conflict: true };
        freeze(conflicted);
        setError(`${describeLiveError(caught).message} 这次没有覆盖任何内容；请核对最新配置后再决定。`);
        await refresh(client, request);
        if (request === scope.current) await checkReceipt(conflicted, client, request);
      } else if (caught instanceof RelayApiError && caught.problem.status < 500 &&
        caught.problem.code !== "COMMAND_ID_REUSED") {
        freeze(null);
        setError(describeLiveError(caught).message);
      } else {
        // 结果未知：先由程序核对一次回执（有界），查不到才把「重新核对/重试保存」交给用户。
        setError("保存结果还没确认，正在核对…");
        await checkReceipt(command, client, request);
      }
    } finally { if (request === scope.current) setBusy(false); }
  }

  const chosen = browseKind ?? selectedKind ?? current?.kind ?? "general";
  const writeBlockedReason = projectArchivedAt === undefined ? "Project 事实尚未确认，不能保存默认视图。" :
    projectArchivedAt !== null ? "项目已归档，不能保存新的默认视图。" :
      loading || error ? "当前事实正在核对或读取失败，不能保存默认视图。" : null;
  return <section className="view-configuration-panel" aria-label="项目工作台配置">
    <h2>工作台默认视图</h2>
    {client === null ? <p className="helper-text">当前为示例预览；这里没有持久化的视图配置。</p> : <>
      {loading && <p role="status">正在读取服务端视图配置…</p>}
      {current && <>
        <p>当前默认：<strong>{kindLabel(current.kind)}</strong> · 配置修订 v{current.revision}</p>
        <p className="helper-text">来源：服务端内置模板 v{current.templateVersion} · SHA-256 <code>{current.templateSha256}</code></p>
        <p className="helper-text">当前默认的服务端页面顺序：</p>
        <ol className="view-configuration-pages">{[...current.pages].sort((a, b) => a.position - b.position)
          .map((page) => <li key={page.pageId}>{pageLabels[page.pageId] ?? page.pageId}
            <small> {page.pageId} · {page.visible ? "显示" : "隐藏"} · position {page.position}</small></li>)}</ol>
        {browseKind ? <p className="helper-text">正在浏览：{kindLabel(browseKind)}。
          {/* 2026-10-24 用户指令：浏览的就是当前默认时不再复述；只有临时浏览另一档才说明后果。 */}
          {browseKind === current.kind ? "" : "这只是临时浏览，尚未保存为默认视图；上方页面顺序属于当前默认模板。"}</p> :
          <label className="field"><span className="field-label">选择新的默认视图</span>
            <select data-testid="view-kind-select" value={chosen} disabled={pending !== null || busy}
              onChange={(event) => setSelectedKind(event.target.value as RelayViewKind)}>
              {kinds.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}
            </select></label>}
        <button className="primary-button" type="button" data-testid="view-save-default"
          disabled={pending !== null || busy || writeBlockedReason !== null || chosen === current.kind}
          onClick={() => void send({ id: createCommandId(), expectedRevision: current.revision,
            kind: chosen, conflict: false })}>{busy ? "正在核对" : `将${kindLabel(chosen)}设为默认`}</button>
        {writeBlockedReason && <p className="disabled-reason" data-testid="view-archive-reason">{writeBlockedReason}</p>}
        <p className="helper-text">仅保存展示组合；Project Type、State、Task 与 Run 不随之更改。页面顺序由服务端模板解析，不提供逐页编辑。</p>
      </>}
      {error && <p className="action-error" role="alert">{error}</p>}
      {message && <p className="success-callout" role="status">{message}</p>}
      {pending && <div className="warning-callout" data-testid="view-pending">
        {/* 2026-10-20（P1-4）：这里先说「保存有没有成功」，命令标识、修订与目标只进诊断。
            结果未知时 send() 已经自动核对过一次回执，用户只在没查到时才需要决定。 */}
        <strong>{pending.conflict ? "默认视图已被别处改过" : "保存结果还没确认"}</strong>
        <p>{busy ? "正在核对是否保存成功…" : pending.conflict
          ? "这个视图在别处已经被改过；先核对最新修订，再决定是否按它重新保存。"
          : "还没查到这次保存的结果；核对之前不会生成新的保存。"}</p>
        <button className="secondary-button" type="button" disabled={busy} data-testid="view-recheck"
          onClick={() => client && void checkReceipt(pending, client, scope.current)}>重新核对</button>
        {mayRetry && !pending.conflict && <button className="secondary-button" type="button" disabled={busy}
          data-testid="view-retry" onClick={() => void send(pending, true)}>重试保存</button>}
        {pending.conflict && current && BigInt(current.revision) > BigInt(pending.expectedRevision) &&
          <button className="secondary-button" type="button" disabled={busy || loading}
          data-testid="view-reconfirm"
          onClick={() => { freeze(null); setError(null); setMessage("已保留目标选择；请按当前修订明确重新提交。"); }}>
          按当前修订重新确认</button>}
        <details className="tech-details" data-testid="view-diagnostics">
          <summary>诊断信息</summary>
          <p className="helper-text">命令：SetViewConfiguration · 标识：<code className="hash-code">{pending.id}</code></p>
          <p className="helper-text">原修订 v{pending.expectedRevision} · 目标：{kindLabel(pending.kind)}</p>
        </details>
      </div>}
      <button className="secondary-button" type="button" disabled={loading || busy}
        onClick={() => client && void refresh(client, scope.current)}>刷新当前配置</button>
    </>}
  </section>;
}
