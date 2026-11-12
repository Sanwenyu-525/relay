import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, RotateCcw, Search } from "lucide-react";
import {
  RELAY_DIAGNOSTIC_LEVELS, type RelayApiClient, type RelayDiagnosticFileInfo,
  type RelayDiagnosticInventory, type RelayDiagnosticLogEntry, type RelayDiagnosticLogLevel,
  type RelayDiagnosticProcessStatus, type RelayDiagnosticsQuery,
  type RelayDiagnosticsRuntimeStatus,
} from "../api/relayClient";
import { describeLiveRead } from "../lib/liveErrors";
import {
  nativeLogDirectoryAvailable, openLogDirectory, saveDiagnosticsExport,
} from "../lib/desktopHost";

const PAGE_SIZE = 100;
const EXPORT_LIMIT = 1000;
const AUTO_REFRESH_MS = 10_000;

const levelLabels: Record<RelayDiagnosticLogLevel, string> = {
  fatal: "fatal", error: "error", warn: "warn", info: "info", debug: "debug", trace: "trace",
};

const processLabels: Record<string, string> = {
  api: "API", worker: "Worker", supervisor: "Supervisor",
  desktop: "桌面宿主", "supervisor-host": "宿主 Supervisor",
};

const correlationFields = [
  "request_id", "command_id", "session_id", "message_id", "model_call_id",
  "project_id", "task_id", "run_id", "operation_id", "invocation_id", "worker_id",
] as const;

type CorrelationField = (typeof correlationFields)[number];

const correlationLabels: Record<CorrelationField, string> = {
  request_id: "request_id（请求追溯号）",
  command_id: "command_id（命令 ID）",
  session_id: "session_id（会话 ID）",
  message_id: "message_id（消息 ID）",
  model_call_id: "model_call_id（模型调用 ID）",
  project_id: "project_id（项目 ID）",
  task_id: "task_id（任务 ID）",
  run_id: "run_id（运行 ID）",
  operation_id: "operation_id（操作 ID）",
  invocation_id: "invocation_id（调用 ID）",
  worker_id: "worker_id（Worker ID）",
};

interface FilterState {
  readonly file: string;
  readonly level: RelayDiagnosticLogLevel;
  readonly process: string;
  readonly keyword: string;
  readonly since: string;
  readonly until: string;
  readonly event: string;
  readonly anyId: boolean;
  readonly idField: CorrelationField;
  readonly idValue: string;
}

function emptyFilters(): FilterState {
  return { file: "", level: "info", process: "", keyword: "", since: "", until: "",
    event: "", anyId: true, idField: "request_id", idValue: "" };
}

function processLabel(value: string): string {
  return processLabels[value] ?? value;
}

function levelTone(level: RelayDiagnosticLogLevel): "danger" | "warning" | "neutral" {
  if (level === "fatal" || level === "error") return "danger";
  if (level === "warn") return "warning";
  return "neutral";
}

function messageOf(entry: RelayDiagnosticLogEntry): string | null {
  const message = entry.record?.message;
  if (typeof message === "string" && message !== "") return message;
  return entry.raw !== null && entry.raw !== "" ? entry.raw : null;
}

function messagePreview(entry: RelayDiagnosticLogEntry): string {
  const message = messageOf(entry);
  if (message === null) return "（无消息字段）";
  const firstLine = message.split("\n", 1)[0] ?? message;
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}

function recordText(entry: RelayDiagnosticLogEntry): string {
  if (entry.record !== null) return JSON.stringify(entry.record, null, 2);
  return entry.raw ?? "（没有可展示的原始内容）";
}

function stackOf(entry: RelayDiagnosticLogEntry): string | null {
  const stack = entry.record?.stack;
  return typeof stack === "string" && stack !== "" ? stack : null;
}

function formatBytes(value: number | null): string {
  if (value === null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}

function localStamp(): string {
  return new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
}

function buildQuery(filters: FilterState): { query: RelayDiagnosticsQuery } | { error: string } {
  let since: string | undefined;
  let until: string | undefined;
  if (filters.since !== "") {
    const parsed = Date.parse(filters.since);
    if (Number.isNaN(parsed)) return { error: "开始时间格式无效。" };
    since = new Date(parsed).toISOString();
  }
  if (filters.until !== "") {
    const parsed = Date.parse(filters.until);
    if (Number.isNaN(parsed)) return { error: "结束时间格式无效。" };
    until = new Date(parsed).toISOString();
  }
  if (since !== undefined && until !== undefined && Date.parse(since) > Date.parse(until)) {
    return { error: "开始时间不能晚于结束时间。" };
  }
  const ids = filters.idValue.trim();
  return { query: {
    file: filters.file === "" ? undefined : filters.file,
    minLevel: filters.level,
    processes: filters.process === "" ? undefined : [filters.process],
    keyword: filters.keyword.trim() === "" ? undefined : filters.keyword.trim(),
    eventPattern: filters.event.trim() === "" ? undefined : filters.event.trim(),
    since, until,
    anyId: ids !== "" && filters.anyId ? ids : undefined,
    correlation: ids !== "" && !filters.anyId ? { [filters.idField]: ids } : undefined,
  } };
}

function diagnosticSummary(client: RelayApiClient, entry: RelayDiagnosticLogEntry): string {
  const record = entry.record;
  const lines = [
    "# Relay 开发者诊断摘要",
    `生成时间: ${new Date().toISOString()}`,
    `API: ${client.baseUrl}`,
    `Workspace: ${client.workspaceId}`,
    `记录: ${entry.ts ?? "时间未知"} ${entry.level} ${entry.event ?? "（无事件名）"}`,
    `来源: ${entry.file}#${entry.offset}`,
    `消息: ${messageOf(entry) ?? "（无消息）"}`,
  ];
  const present = correlationFields.filter((field) => {
    const value = record?.[field];
    return typeof value === "string" && value !== "";
  });
  if (present.length > 0) {
    lines.push(`关联: ${present.map((field) => `${field}=${String(record?.[field])}`).join(" ")}`);
  }
  if (entry.truncated) lines.push("注意: 原始行超过上限，已被截断。");
  return lines.join("\n");
}

function processTone(status: RelayDiagnosticProcessStatus["status"]): string {
  switch (status) {
    case "running": return "success";
    case "failed": return "danger";
    default: return "neutral";
  }
}

function processStatusLabel(status: RelayDiagnosticProcessStatus["status"]): string {
  switch (status) {
    case "running": return "运行中";
    case "stopped": return "已停止";
    case "failed": return "失败";
    default: return "未知";
  }
}

function copyText(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (clipboard === undefined) return Promise.resolve(false);
  return clipboard.writeText(text).then(() => true).catch(() => false);
}

function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
}

/**
 * 设置 › 开发者诊断（2026-11-12）。
 *
 * 日志读取走带授权的本机 API；文件白名单、路径围栏、脱敏与大小上限都在服务端。
 * 本组件只负责筛选、分页、详情与导出，不把日志文件路径当作用户输入，
 * 也不在自动刷新失败后继续定时重试。
 */
export default function DeveloperDiagnosticsPanel({ client, active }: {
  readonly client: RelayApiClient | null;
  readonly active: boolean;
}) {
  // 导出与读取共用同一份已应用筛选：诊断文件卡导出的就是列表当前展示的范围。
  const [appliedQuery, setAppliedQuery] = useState<RelayDiagnosticsQuery>({});
  return <>
    <LogsCard client={client} active={active} appliedQuery={appliedQuery}
      onApply={setAppliedQuery} />
    <RuntimeCard client={client} active={active} />
    <FilesCard client={client} active={active} appliedQuery={appliedQuery} />
  </>;
}

function LogsCard({ client, active, appliedQuery, onApply }: {
  readonly client: RelayApiClient | null;
  readonly active: boolean;
  readonly appliedQuery: RelayDiagnosticsQuery;
  readonly onApply: (query: RelayDiagnosticsQuery) => void;
}) {
  const [filters, setFilters] = useState<FilterState>(emptyFilters);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [entries, setEntries] = useState<readonly RelayDiagnosticLogEntry[]>([]);
  const [inventory, setInventory] = useState<RelayDiagnosticInventory | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [matchedCount, setMatchedCount] = useState(0);
  const [scannedBytes, setScannedBytes] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [copyNotice, setCopyNotice] = useState<{ readonly tone: "ok" | "error"; readonly text: string } | null>(null);
  const requestVersion = useRef(0);
  const inFlight = useRef(false);
  const appliedRef = useRef(appliedQuery);
  appliedRef.current = appliedQuery;
  const autoRefreshRef = useRef(autoRefresh);
  autoRefreshRef.current = autoRefresh;
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;

  const read = useCallback(async (query: RelayDiagnosticsQuery,
    cursor: string | undefined, mode: "replace" | "append") => {
    if (client === null) return;
    const request = ++requestVersion.current;
    inFlight.current = true;
    if (mode === "append") setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const page = await client.getDiagnosticsLogs(query, PAGE_SIZE, cursor);
      if (request !== requestVersion.current) return;
      setInventory(page.inventory);
      setNextCursor(page.nextCursor);
      setMatchedCount(page.matchedCount);
      setScannedBytes(page.scannedBytes);
      setTruncated(page.truncated);
      setEntries((current) => {
        if (mode === "replace") return page.records;
        const seen = new Set(current.map((entry) => entry.id));
        return [...current, ...page.records.filter((entry) => !seen.has(entry.id))];
      });
      if (mode === "replace") {
        setSelectedId((current) => {
          if (current === null) return null;
          return page.records.some((entry) => entry.id === current) ? current : null;
        });
      }
    } catch (caught) {
      if (request !== requestVersion.current) return;
      setError(describeLiveRead(caught));
      // 自动刷新失败即停止：不在失败状态上继续定时重试，等用户手动确认后再说。
      if (autoRefreshRef.current && mode === "replace") setAutoRefresh(false);
    } finally {
      if (request === requestVersion.current) {
        inFlight.current = false;
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [client]);

  useEffect(() => {
    requestVersion.current += 1;
    inFlight.current = false;
    setEntries([]); setInventory(null); setNextCursor(null); setMatchedCount(0);
    setScannedBytes(0); setTruncated(false); setSelectedId(null); setError(null);
  }, [client]);

  useEffect(() => {
    if (client === null) return;
    void read(appliedQuery, undefined, "replace");
    return () => { requestVersion.current += 1; };
  }, [client, read, appliedQuery]);

  useEffect(() => {
    if (active) return;
    setAutoRefresh(false);
  }, [active]);

  useEffect(() => {
    if (!autoRefresh || !active || client === null) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || inFlight.current) return;
      void read(appliedRef.current, undefined, "replace");
    }, AUTO_REFRESH_MS);
    return () => { window.clearInterval(timer); };
  }, [autoRefresh, active, client, read]);

  const applyFilters = () => {
    const built = buildQuery(filters);
    if ("error" in built) { setFilterError(built.error); return; }
    setFilterError(null);
    onApply(built.query);
  };

  const resetFilters = () => {
    setFilters(emptyFilters());
    setFilterError(null);
    onApply({});
  };

  const loadMore = () => {
    if (nextCursor === null || loading || loadingMore) return;
    void read(appliedQuery, nextCursor, "append");
  };

  const copy = async (kind: "error" | "summary") => {
    if (client === null || selected === null) return;
    const text = kind === "summary" ? diagnosticSummary(client, selected)
      : [
        `[${selected.ts ?? "时间未知"}] ${selected.level} ${selected.event ?? ""}`.trim(),
        messageOf(selected) ?? "（无消息）",
        stackOf(selected) ?? "",
        `来源: ${selected.file}#${selected.offset}`,
      ].filter((line) => line !== "").join("\n");
    const ok = await copyText(text);
    setCopyNotice(ok
      ? { tone: "ok", text: kind === "summary" ? "诊断摘要已复制到剪贴板。" : "错误详情已复制到剪贴板。" }
      : { tone: "error", text: "无法写入剪贴板：请在下方原始内容中手动选择复制。" });
  };

  const fileOptions = inventory?.files ?? [];

  return <section className="settings-card" data-testid="diagnostics-logs">
    <h2>日志与错误</h2>
    <p className="helper-text">
      只读本机受管日志（API、Worker、Supervisor、桌面宿主）；服务端按只读白名单读取并脱敏，
      不提供任意文件路径。
    </p>
    <form className="settings-diagnostics-filters" data-testid="diagnostics-filters" onSubmit={(event) => {
      event.preventDefault();
      applyFilters();
    }}>
      <div className="settings-field">
        <label htmlFor="diagnostics-keyword">关键词</label>
        <input id="diagnostics-keyword" data-testid="diagnostics-keyword" value={filters.keyword}
          maxLength={200} placeholder="事件名、消息或错误码"
          onChange={(event) => { setFilters({ ...filters, keyword: event.target.value }); }} />
      </div>
      <div className="settings-field">
        <label htmlFor="diagnostics-min-level">最低级别</label>
        <select id="diagnostics-min-level" data-testid="diagnostics-min-level" value={filters.level}
          onChange={(event) => { setFilters({ ...filters, level: event.target.value as RelayDiagnosticLogLevel }); }}>
          <option value="trace">全部级别（含 trace）</option>
          {RELAY_DIAGNOSTIC_LEVELS.filter((level) => level !== "trace").map((level) => (
            <option key={level} value={level}>{levelLabels[level]}</option>
          ))}
        </select>
      </div>
      <div className="settings-field">
        <label htmlFor="diagnostics-process">进程</label>
        <select id="diagnostics-process" data-testid="diagnostics-process" value={filters.process}
          onChange={(event) => { setFilters({ ...filters, process: event.target.value }); }}>
          <option value="">全部进程</option>
          {Object.entries(processLabels).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>
      <div className="settings-field">
        <label htmlFor="diagnostics-file">文件</label>
        <select id="diagnostics-file" data-testid="diagnostics-file" value={filters.file}
          onChange={(event) => { setFilters({ ...filters, file: event.target.value }); }}>
          <option value="">全部文件</option>
          {fileOptions.map((file) => (
            <option key={file.name} value={file.name}>{file.label} · {file.name}</option>
          ))}
        </select>
      </div>
      <div className="settings-field">
        <label htmlFor="diagnostics-since">开始时间</label>
        <input id="diagnostics-since" data-testid="diagnostics-since" type="datetime-local"
          value={filters.since}
          onChange={(event) => { setFilters({ ...filters, since: event.target.value }); }} />
      </div>
      <div className="settings-field">
        <label htmlFor="diagnostics-until">结束时间</label>
        <input id="diagnostics-until" data-testid="diagnostics-until" type="datetime-local"
          value={filters.until}
          onChange={(event) => { setFilters({ ...filters, until: event.target.value }); }} />
      </div>
      <details className="settings-diagnostics-advanced-filter" data-testid="diagnostics-advanced-filter">
        <summary>高级筛选（事件模式与关联 ID）</summary>
        <div className="settings-diagnostics-advanced-grid">
          <div className="settings-field">
            <label htmlFor="diagnostics-event">事件名模式</label>
            <input id="diagnostics-event" data-testid="diagnostics-event" value={filters.event}
              maxLength={200} placeholder="例如 worker_job_failed 或 worker_*"
              onChange={(event) => { setFilters({ ...filters, event: event.target.value }); }} />
            <p className="helper-text">支持 * 通配；留空不限事件。</p>
          </div>
          <div className="settings-field">
            <label htmlFor="diagnostics-id-field">关联字段</label>
            <select id="diagnostics-id-field" data-testid="diagnostics-id-field"
              value={filters.anyId ? "" : filters.idField}
              onChange={(event) => {
                const value = event.target.value;
                setFilters(value === "" ? { ...filters, anyId: true }
                  : { ...filters, anyId: false, idField: value as CorrelationField });
              }}>
              <option value="">任意关联 ID</option>
              {correlationFields.map((field) => (
                <option key={field} value={field}>{correlationLabels[field]}</option>
              ))}
            </select>
          </div>
          <div className="settings-field">
            <label htmlFor="diagnostics-id-value">关联 ID 值</label>
            <input id="diagnostics-id-value" data-testid="diagnostics-id-value" value={filters.idValue}
              maxLength={200} placeholder="粘贴 request_id / task_id / run_id 等"
              onChange={(event) => { setFilters({ ...filters, idValue: event.target.value }); }} />
            <p className="helper-text">按精确值匹配；不会把缺失的 ID 补造出来。</p>
          </div>
        </div>
      </details>
      {filterError !== null && <p className="action-error" role="alert"
        data-testid="diagnostics-filter-error">{filterError}</p>}
      <div className="settings-diagnostics-filter-actions">
        <button type="submit" className="primary-button" data-testid="diagnostics-query">
          <Search aria-hidden="true" />查询日志</button>
        <button type="button" className="secondary-button" data-testid="diagnostics-refresh"
          disabled={loading} onClick={() => { void read(appliedQuery, undefined, "replace"); }}>
          <RotateCcw aria-hidden="true" />刷新当前结果</button>
        <label className="settings-diagnostics-auto">
          <input type="checkbox" checked={autoRefresh} disabled={!active || client === null}
            data-testid="diagnostics-auto-refresh"
            onChange={(event) => { setAutoRefresh(event.target.checked); }} />
          每 10 秒自动刷新（离开本页或失败后停止）
        </label>
        <button type="button" className="text-button" data-testid="diagnostics-reset"
          onClick={resetFilters}>重置筛选</button>
      </div>
    </form>

    <div className="settings-diagnostics-result-head">
      <p className="helper-text" data-testid="diagnostics-count">
        {error !== null
          ? entries.length > 0
            ? "本次读取失败，下面保留的是上一次成功读取的结果。"
            : "本次读取失败，没有可展示的日志。"
          : loading && entries.length === 0
            ? "正在读取日志…"
            : `匹配 ${matchedCount} 条；已加载 ${entries.length} 条；扫描 ${formatBytes(scannedBytes)}。`}
      </p>
      {truncated && <p className="helper-text" data-testid="diagnostics-truncated">
        已达到本次扫描或返回上限，更早的记录可能未包含；可缩小时间范围或用筛选缩小范围。
      </p>}
    </div>
    {error !== null && <div className="action-error" role="alert" data-testid="diagnostics-error">
      <p>读取失败：{error}</p>
      <button className="secondary-button" type="button" data-testid="diagnostics-error-retry"
        onClick={() => { void read(appliedQuery, undefined, "replace"); }}>
        <RotateCcw aria-hidden="true" />重试</button>
    </div>}

    <div className="settings-diagnostics-body">
      <div className="settings-diagnostics-list-pane">
        {entries.length === 0 && error === null && !loading
          ? <p className="settings-diagnostics-empty" data-testid="diagnostics-empty" role="status">
            当前筛选没有匹配的日志。可放宽级别、时间范围或清空关键词后重试。</p>
          : <ul className="settings-log-list" data-testid="diagnostics-log-list">
            {entries.map((entry) => <li key={entry.id}>
              <button type="button" className="settings-log-row" data-testid="diagnostics-log-row"
                aria-pressed={entry.id === selectedId} data-level={entry.level}
                onClick={() => { setSelectedId(entry.id); setCopyNotice(null); }}>
                <time className="settings-log-time" dateTime={entry.ts ?? undefined}>
                  {entry.ts ?? "时间未知"}</time>
                <span className={`status-chip status-chip--${levelTone(entry.level)}`}>
                  {entry.level}</span>
                <span className="settings-log-process">{processLabel(entry.process)}</span>
                <span className="settings-log-event">{entry.event ?? "（无事件名）"}</span>
                <span className="settings-log-message">{messagePreview(entry)}</span>
              </button>
            </li>)}
          </ul>}
        {nextCursor !== null && entries.length > 0 && <button className="secondary-button"
          type="button" data-testid="diagnostics-load-more" disabled={loadingMore}
          onClick={loadMore}>{loadingMore ? "正在加载…" : "加载更多"}</button>}
      </div>
      <LogDetail entry={selected} copyNotice={copyNotice} onCopy={(kind) => void copy(kind)} />
    </div>
  </section>;
}

function LogDetail({ entry, copyNotice, onCopy }: {
  readonly entry: RelayDiagnosticLogEntry | null;
  readonly copyNotice: { readonly tone: "ok" | "error"; readonly text: string } | null;
  readonly onCopy: (kind: "error" | "summary") => void;
}) {
  if (entry === null) {
    return <aside className="settings-log-detail" data-testid="diagnostics-detail">
      <h3>记录详情</h3>
      <p className="helper-text">从左侧选择一条日志查看消息、堆栈与原始记录。</p>
    </aside>;
  }
  const stack = stackOf(entry);
  return <aside className="settings-log-detail" data-testid="diagnostics-detail">
    <div className="settings-log-detail-head">
      <h3>{entry.event ?? "（无事件名）"}</h3>
      <button className="secondary-button secondary-button--compact" type="button"
        data-testid="diagnostics-copy-error" onClick={() => onCopy("error")}>复制错误</button>
      <button className="secondary-button secondary-button--compact" type="button"
        data-testid="diagnostics-copy-summary" onClick={() => onCopy("summary")}>复制诊断摘要</button>
    </div>
    {copyNotice !== null && <p className={copyNotice.tone === "ok" ? "settings-save-result" : "action-error"}
      role={copyNotice.tone === "ok" ? "status" : "alert"}
      data-testid="diagnostics-copy-result">{copyNotice.text}</p>}
    <dl className="settings-diagnostic-list">
      <div><dt>时间</dt><dd>{entry.ts ?? "时间未知"}</dd></div>
      <div><dt>级别</dt><dd><span className={`status-chip status-chip--${levelTone(entry.level)}`}>
        {entry.level}</span></dd></div>
      <div><dt>进程</dt><dd>{processLabel(entry.process)}</dd></div>
      <div><dt>来源</dt><dd><code className="hash-code">{entry.file}#{entry.offset}</code>
        {entry.truncated ? "（原始行已截断）" : ""}</dd></div>
    </dl>
    <p className="settings-log-detail-message">{messageOf(entry) ?? "（无消息字段）"}</p>
    {stack !== null && <pre className="settings-log-pre" data-testid="diagnostics-stack">{stack}</pre>}
    <details className="settings-diagnostics" data-testid="diagnostics-raw">
      <summary>原始记录</summary>
      <pre className="settings-log-pre">{recordText(entry)}</pre>
    </details>
  </aside>;
}

function RuntimeCard({ client, active }: { readonly client: RelayApiClient | null; readonly active: boolean }) {
  const [runtime, setRuntime] = useState<RelayDiagnosticsRuntimeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const read = useCallback(async () => {
    if (client === null) return;
    const request = ++requestVersion.current;
    setLoading(true); setError(null);
    try {
      const next = await client.getDiagnosticsRuntime();
      if (request !== requestVersion.current) return;
      setRuntime(next);
    } catch (caught) {
      if (request !== requestVersion.current) return;
      setError(describeLiveRead(caught));
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    requestVersion.current += 1;
    setRuntime(null); setError(null);
  }, [client]);

  useEffect(() => {
    if (client === null || !active) return;
    void read();
    return () => { requestVersion.current += 1; };
  }, [client, active, read]);

  return <section className="settings-card" data-testid="diagnostics-runtime">
    <div className="settings-diagnostics-card-head">
      <h2>运行状态</h2>
      <button className="secondary-button secondary-button--compact" type="button"
        data-testid="diagnostics-runtime-refresh" disabled={loading || client === null}
        onClick={() => { void read(); }}>
        <RotateCcw aria-hidden="true" />{loading ? "读取中…" : "刷新状态"}</button>
    </div>
    <p className="helper-text">只反映本次读取时能核实的进程与数据库事实；不能核实时显示「未知」。</p>
    {client === null
      ? <p className="helper-text">示例模式没有本机进程与日志目录：连接本机 API 后可读取运行状态。</p>
      : error !== null
        ? <div className="action-error" role="alert" data-testid="diagnostics-runtime-error">
          <p>运行状态读取失败：{error}</p></div>
        : runtime === null
          ? <p className="helper-text" role="status">正在读取运行状态…</p>
          : <dl className="settings-fact-grid settings-runtime-grid">
            <div className="settings-fact" data-testid="diagnostics-api">
              <dt>API 进程</dt>
              <dd><span className="status-chip status-chip--success">运行中</span>{" "}
                PID {runtime.api.pid} · 已运行 {formatUptime(runtime.api.uptimeSeconds)}
                <span className="helper-text">Node {runtime.api.node}；启动于 {runtime.api.startedAt}
                  。本页能返回状态，本身就说明 API 正在响应。</span></dd>
            </div>
            <ProcessFact testId="diagnostics-worker" label="Worker" status={runtime.worker} />
            <ProcessFact testId="diagnostics-supervisor" label="Supervisor" status={runtime.supervisor} />
            <div className="settings-fact" data-testid="diagnostics-database">
              <dt>数据库</dt>
              <dd>
                <span className={`status-chip status-chip--${
                  runtime.database.status === "up" ? "success"
                    : runtime.database.status === "down" ? "danger" : "neutral"}`}>
                  {runtime.database.status === "up" ? "可用"
                    : runtime.database.status === "down" ? "不可达" : "未知"}</span>{" "}
                schema：{runtime.database.schema === "up" ? "可用"
                  : runtime.database.schema === "down" ? "不可用" : "未知"}
                {runtime.database.detail !== null &&
                  <span className="helper-text">{runtime.database.detail}</span>}
              </dd>
            </div>
            <div className="settings-fact" data-testid="diagnostics-log-directory">
              <dt>日志目录</dt>
              <dd><span className={`status-chip status-chip--${
                !runtime.logDirectory.exists ? "danger"
                  : runtime.logDirectory.writable === false ? "warning" : "neutral"}`}>
                {!runtime.logDirectory.exists ? "不存在"
                  : runtime.logDirectory.writable === false ? "不可写"
                    : runtime.logDirectory.writable === null ? "可写性未确认" : "可写"}</span>{" "}
                {runtime.logDirectory.fileCount} 个文件
                <span className="helper-text"><code className="hash-code">
                  {runtime.logDirectory.path}</code></span>
              </dd>
            </div>
            <div className="settings-fact" data-testid="diagnostics-last-error">
              <dt>最近错误</dt>
              <dd>
                {runtime.lastError === null
                  ? <><span className="status-chip status-chip--neutral">无</span>{" "}
                    本次扫描范围内没有 error / fatal 记录。</>
                  : <><span className="status-chip status-chip--danger">{runtime.lastError.level}</span>{" "}
                    {runtime.lastError.event ?? "（无事件名）"}
                    <span className="helper-text">{runtime.lastError.ts ?? "时间未知"} ·{" "}
                      {processLabel(runtime.lastError.process)} ·{" "}
                      <code className="hash-code">{runtime.lastError.file}#{runtime.lastError.offset}</code>
                      {runtime.lastError.message !== null
                        ? <><br />{runtime.lastError.message}</> : null}</span></>}
              </dd>
            </div>
          </dl>}
  </section>;
}

function ProcessFact({ testId, label, status }: {
  readonly testId: string; readonly label: string; readonly status: RelayDiagnosticProcessStatus;
}) {
  return <div className="settings-fact" data-testid={testId}>
    <dt>{label}</dt>
    <dd>
      <span className={`status-chip status-chip--${processTone(status.status)}`}>
        {processStatusLabel(status.status)}</span>{" "}
      {status.detail}
      {status.pid !== null && <> · PID {status.pid}</>}
      {status.derivedFrom === "log" &&
        <span className="helper-text">仅按日志推断，未核实进程存活。</span>}
      {status.lastEvent !== null &&
        <span className="helper-text">最近事件 {status.lastEvent.event ?? "（无事件名）"} ·{" "}
          {status.lastEvent.ts ?? "时间未知"}</span>}
    </dd>
  </div>;
}

function FilesCard({ client, active, appliedQuery }: {
  readonly client: RelayApiClient | null;
  readonly active: boolean;
  readonly appliedQuery: RelayDiagnosticsQuery;
}) {
  const [inventory, setInventory] = useState<RelayDiagnosticInventory | null>(null);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "open" | "export">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestVersion = useRef(0);

  // 清单来自日志读取结果：诊断文件卡不另造读取通道，也不猜目录内容。
  const readInventory = useCallback(async () => {
    if (client === null) return;
    const request = ++requestVersion.current;
    setInventoryError(null);
    try {
      const page = await client.getDiagnosticsLogs({}, 1);
      if (request !== requestVersion.current) return;
      setInventory(page.inventory);
    } catch (caught) {
      if (request !== requestVersion.current) return;
      setInventoryError(describeLiveRead(caught));
    }
  }, [client]);

  useEffect(() => {
    requestVersion.current += 1;
    setInventory(null); setInventoryError(null); setActionError(null); setNotice(null);
  }, [client]);

  useEffect(() => {
    if (client === null || !active) return;
    void readInventory();
    return () => { requestVersion.current += 1; };
  }, [client, active, readInventory]);

  const open = async () => {
    setBusy("open"); setActionError(null); setNotice(null);
    try {
      const path = await openLogDirectory();
      setNotice(`已打开日志目录：${path}`);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "无法打开日志目录。");
    } finally { setBusy(null); }
  };

  const exportLogs = async () => {
    if (client === null) return;
    setBusy("export"); setActionError(null); setNotice(null);
    try {
      const text = await client.exportDiagnosticsLogs(appliedQuery, EXPORT_LIMIT);
      const name = `relay-diagnostics-${localStamp()}.log`;
      if (nativeLogDirectoryAvailable()) {
        const saved = await saveDiagnosticsExport(name, text);
        setNotice(saved === null ? "已取消保存，没有写入文件。"
          : `已导出到 ${saved}（服务端已二次脱敏；最多 ${EXPORT_LIMIT} 条 / 2 MiB）。`);
      } else {
        downloadText(name, text);
        setNotice(`已下载 ${name}（服务端已二次脱敏；最多 ${EXPORT_LIMIT} 条 / 2 MiB）。`);
      }
    } catch (caught) {
      setActionError(describeLiveRead(caught));
    } finally { setBusy(null); }
  };

  const copyDirectory = async () => {
    if (inventory === null) return;
    const ok = await copyText(inventory.directory);
    setNotice(ok ? "日志目录路径已复制。" : "无法写入剪贴板，请手动选择路径复制。");
  };

  return <section className="settings-card" data-testid="diagnostics-files">
    <div className="settings-diagnostics-card-head">
      <h2>诊断文件</h2>
      <button className="secondary-button secondary-button--compact" type="button"
        data-testid="diagnostics-file-refresh" disabled={client === null}
        onClick={() => { void readInventory(); }}>
        <RotateCcw aria-hidden="true" />重新读取清单</button>
    </div>
    <p className="helper-text">
      只列白名单内的运行日志；轮转文件与当前文件分开列出。导出内容由服务端再次脱敏并限制大小。
    </p>
    {client === null
      ? <p className="helper-text">示例模式没有本机日志文件。</p>
      : inventoryError !== null
        ? <div className="action-error" role="alert" data-testid="diagnostics-files-error">
          <p>诊断文件读取失败：{inventoryError}</p></div>
        : inventory === null
          ? <p className="helper-text" role="status">正在读取诊断文件清单…</p>
          : <>
            <p className="settings-directory-path" data-testid="diagnostics-directory-path">
              {inventory.directory}</p>
            {!inventory.exists
              ? <p className="helper-text" data-testid="diagnostics-directory-missing">
                日志目录尚未创建；首次启动并写入日志后会出现。</p>
              : !inventory.readable
                ? <p className="action-error" role="alert" data-testid="diagnostics-directory-unreadable">
                  日志目录存在但不可读{inventory.error === null ? "。" : `：${inventory.error}`}</p>
                : <ul className="settings-log-files" data-testid="diagnostics-file-list">
                  {inventory.files.map((file) => <FileRow key={file.name} file={file} />)}
                </ul>}
            <div className="settings-diagnostics-file-actions">
              {nativeLogDirectoryAvailable()
                ? <button className="secondary-button" type="button" data-testid="diagnostics-open-directory"
                  disabled={busy !== null} onClick={() => { void open(); }}>
                  <FolderOpen aria-hidden="true" />{busy === "open" ? "正在打开…" : "打开日志目录"}</button>
                : <button className="secondary-button" type="button" data-testid="diagnostics-copy-directory"
                  onClick={() => { void copyDirectory(); }}>复制目录路径</button>}
              <button className="primary-button" type="button" data-testid="diagnostics-export"
                disabled={busy !== null} onClick={() => { void exportLogs(); }}>
                {busy === "export" ? "正在导出…" : "导出当前筛选结果"}</button>
              {!nativeLogDirectoryAvailable() && <span className="helper-text">
                浏览器模式直接下载文本；桌面宿主会打开保存对话框。</span>}
            </div>
            {notice !== null && <p className="settings-save-result" role="status"
              data-testid="diagnostics-file-notice">{notice}</p>}
            {actionError !== null && <p className="action-error" role="alert"
              data-testid="diagnostics-file-error">{actionError}</p>}
          </>}
  </section>;
}

function FileRow({ file }: { readonly file: RelayDiagnosticFileInfo }) {
  return <li className="settings-log-file" data-testid="diagnostics-file-row" data-file={file.name}>
    <span className="settings-log-file-name">
      <strong>{file.label}</strong>
      <code className="hash-code">{file.name}</code>
      {file.rotation !== 0 && <span className="status-chip status-chip--neutral">
        {file.rotation === -1 ? "旧文件" : `轮转 ${file.rotation}`}</span>}
    </span>
    <span className="settings-log-file-meta">
      {file.exists
        ? <><span className={`status-chip status-chip--${file.readable ? "success" : "danger"}`}>
          {file.readable ? "可读" : "不可读"}</span>{" "}
        {formatBytes(file.sizeBytes)} · {file.modifiedAt ?? "修改时间未知"}</>
        : <span className="status-chip status-chip--neutral">尚未生成</span>}
      {file.error !== null && <span className="helper-text">{file.error}</span>}
    </span>
  </li>;
}
