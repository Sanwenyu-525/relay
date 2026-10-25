import { useCallback, useRef, useState } from "react";
import type { RelayApiClient, RelayProject } from "../api/relayClient";
import { createCommandId, projectRenameResultFrom, RelayApiError,
  RelayTransportError } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

/**
 * Project 展示标题编辑：只改 title，不触碰 Project Type、State、Task、Goal 关系与目录。
 * 走既有 EditProjectPresentation 命令：command_id 幂等、Project revision CAS、结果不明先查回执。
 */
type PendingRename = { readonly commandId: string; readonly projectId: string;
  readonly expectedRevision: string; readonly title: string };

function storageKey(client: RelayApiClient, projectId: string): string {
  return `relay:project-rename:${client.baseUrl}:${client.workspaceId}:${projectId}`;
}

function readPending(key: string): PendingRename | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (typeof row.commandId !== "string" || typeof row.projectId !== "string" ||
      typeof row.expectedRevision !== "string" || typeof row.title !== "string") return null;
    return { commandId: row.commandId, projectId: row.projectId,
      expectedRevision: row.expectedRevision, title: row.title };
  } catch { return null; }
}

function savePending(key: string, pending: PendingRename | null): void {
  try {
    if (pending) sessionStorage.setItem(key, JSON.stringify(pending));
    else sessionStorage.removeItem(key);
  } catch { /* 存储不可用只影响整页重开恢复。 */ }
}

function verifyRename(record: PendingRename,
  envelope: { readonly commandId: string; readonly result: Readonly<Record<string, unknown>> }): string {
  if (envelope.commandId !== record.commandId) throw new Error("回执 command_id 与原命令不一致。");
  const result = projectRenameResultFrom(envelope.result);
  if (result.projectId !== record.projectId) throw new Error("回执 Project 与原项目不一致。");
  let next: bigint;
  try { next = BigInt(record.expectedRevision) + 1n; } catch { throw new Error("原 Project revision 无效。"); }
  if (BigInt(result.revision) !== next) {
    throw new Error(`回执修订 v${result.revision} 不是原修订 v${record.expectedRevision} 推进后的下一版。`);
  }
  return `项目标题已更新为「${result.title}」· Project v${result.revision}`;
}

export default function ProjectTitleEditor({ client, project, archived, onChanged }: {
  readonly client: RelayApiClient; readonly project: RelayProject;
  readonly archived: boolean; readonly onChanged: () => void;
}) {
  const key = storageKey(client, project.id);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(project.title);
  const [pending, setPending] = useState<PendingRename | null>(() => readPending(key));
  const pendingRef = useRef<PendingRename | null>(pending);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [mayRetry, setMayRetry] = useState(false);

  const holdPending = useCallback((next: PendingRename | null) => {
    pendingRef.current = next; setPending(next); savePending(key, next);
  }, [key]);

  const checkReceipt = useCallback(async (record: PendingRename) => {
    setBusy(true); setError(null); setMayRetry(false);
    try {
      const response = await client.getCommandReceipt(record.commandId);
      if (response.commandType !== "EditProjectPresentation") {
        throw new Error("原回执不是本次 EditProjectPresentation。");
      }
      const message = verifyRename(record, response);
      holdPending(null); setReceipt(message); setEditing(false); onChanged();
    } catch (caught) {
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetry(true);
        setError("服务端明确未找到原命令；只能用原 ID 与原标题重试。");
      } else setError(`回执仍不可核对；请保留原 command_id。${describeLiveError(caught).message}`);
    } finally { setBusy(false); }
  }, [client, holdPending, onChanged]);

  const send = useCallback(async (record: PendingRename) => {
    setBusy(true); setError(null); setReceipt(null); setMayRetry(false);
    try {
      const envelope = await client.renameProject({ projectId: record.projectId,
        commandId: record.commandId, expectedRevision: record.expectedRevision,
        title: record.title });
      const message = verifyRename(record, envelope);
      holdPending(null); setReceipt(message); setEditing(false); onChanged();
    } catch (caught) {
      if (caught instanceof RelayTransportError ||
        caught instanceof RelayApiError && (caught.problem.status >= 500 ||
          caught.problem.code === "COMMAND_ID_REUSED")) {
        setError("改名结果尚不能确认；已保留原 command_id，先查询回执。");
      } else {
        holdPending(null);
        if (caught instanceof RelayApiError && caught.problem.code === "REVISION_CONFLICT") {
          setError(`Project 修订已变化${caught.problem.actualRevision ? `（当前 v${caught.problem.actualRevision}）` : ""}；已重新读取，请再次确认。`);
          onChanged();
        } else if (caught instanceof RelayApiError && caught.problem.code === "PROJECT_ARCHIVED") {
          setError("项目已归档，不能改名；已重新读取。");
          onChanged();
        } else setError(describeLiveError(caught).message);
      }
    } finally { setBusy(false); }
  }, [client, holdPending, onChanged]);

  function submit() {
    const next = title.trim();
    if (next === "") { setError("项目标题不能为空。"); return; }
    if (next === project.title) { setError("标题没有变化，未提交改名命令。"); return; }
    if (pendingRef.current !== null) { setError("已有待核对的改名命令；收口前不会发出第二条。"); return; }
    if (busyRef.current) return;
    busyRef.current = true;
    const record: PendingRename = { commandId: createCommandId(), projectId: project.id,
      expectedRevision: project.revision, title: next };
    holdPending(record);
    void send(record).finally(() => { busyRef.current = false; });
  }

  return <div data-testid="project-title-editor">
    {!editing ? <button className="text-button" type="button" data-testid="project-rename-open"
      disabled={archived || busy || pending !== null} onClick={() => { setTitle(project.title); setEditing(true); }}>
      修改项目标题</button>
      : <form className="stack" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label className="field"><span className="field-label">项目标题</span>
          <input name="project-title" data-testid="project-title-input" maxLength={200}
            value={title} disabled={busy || pending !== null}
            onChange={(event) => setTitle(event.target.value)} /></label>
        <p className="helper-text">只更新展示标题；项目类型、State、Task、Goal 关系、目录与执行记录都不变。</p>
        <div className="form-actions">
          <button className="primary-button" type="submit" data-testid="project-rename-submit"
            disabled={busy || pending !== null}>{busy ? "正在保存" : "保存标题"}</button>
          <button className="secondary-button" type="button" data-testid="project-rename-cancel"
            disabled={busy} onClick={() => { setEditing(false); setError(null); }}>取消</button>
        </div>
      </form>}
    {archived && <p className="disabled-reason">项目已归档：只能阅读历史，恢复归档后才能改名。</p>}
    {receipt && <p className="receipt-message" role="status" data-testid="project-rename-receipt">{receipt}</p>}
    {error && <p className="action-error" role="alert" data-testid="project-rename-error">{error}</p>}
    {pending && <div className="warning-callout" data-testid="project-rename-pending">
      <strong>改名命令待核对</strong>
      <p>原 command ID：{pending.commandId} · Project {pending.projectId} · 基于 v{pending.expectedRevision}。</p>
      <div className="form-actions">
        <button className="secondary-button" type="button" data-testid="project-rename-check-receipt"
          disabled={busy} onClick={() => void checkReceipt(pending)}>查询原命令回执</button>
        {mayRetry && <button className="secondary-button" type="button" data-testid="project-rename-retry"
          disabled={busy} onClick={() => { const record = pendingRef.current; if (record) void send(record); }}>
          用原 ID 与原标题重试</button>}
      </div>
    </div>}
  </div>;
}
