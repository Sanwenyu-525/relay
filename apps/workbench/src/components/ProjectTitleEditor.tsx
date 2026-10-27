import { useCallback, useEffect, useRef, useState } from "react";
import type { RelayApiClient, RelayProject } from "../api/relayClient";
import { createCommandId, projectRenameResultFrom, RelayApiError,
  RelayTransportError } from "../api/relayClient";
import { RelayContractError } from "../api/core/errors";
import { describeLiveError } from "../lib/liveErrors";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { clearPendingCommand, hasDurablePendingCommand, readPendingCommand, reservePendingCommand } from "../lib/pendingCommandStorage";

/**
 * Project 展示标题编辑：只改 title，不触碰 Project Type、State、Task、Goal 关系与目录。
 * 走既有 EditProjectPresentation 命令：command_id 幂等、Project revision CAS、结果不明先查回执。
 */
type PendingRename = { readonly commandId: string; readonly projectId: string;
  readonly expectedRevision: string; readonly title: string };

class RenameResponseMismatch extends Error {}

function storageKey(client: RelayApiClient, projectId: string): string {
  return `relay:project-rename:${client.baseUrl}:${client.workspaceId}:${projectId}`;
}

function parsePending(value: unknown, projectId: string): PendingRename | null {
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (typeof row.commandId !== "string" || row.projectId !== projectId ||
      typeof row.expectedRevision !== "string" || typeof row.title !== "string") return null;
    return { commandId: row.commandId, projectId: row.projectId,
      expectedRevision: row.expectedRevision, title: row.title };
}

function verifyRename(record: PendingRename,
  envelope: { readonly commandId: string; readonly result: Readonly<Record<string, unknown>> }): string {
  if (envelope.commandId !== record.commandId) throw new RenameResponseMismatch("回执 command_id 与原命令不一致。");
  const result = projectRenameResultFrom(envelope.result);
  if (result.projectId !== record.projectId) throw new RenameResponseMismatch("回执 Project 与原项目不一致。");
  if (result.title !== record.title) {
    throw new RenameResponseMismatch(`回执标题「${result.title}」与冻结命令的「${record.title}」不一致。`);
  }
  let next: bigint;
  try { next = BigInt(record.expectedRevision) + 1n; } catch {
    throw new RenameResponseMismatch("原 Project revision 无效。");
  }
  if (BigInt(result.revision) !== next) {
    throw new RenameResponseMismatch(`回执修订 v${result.revision} 不是原修订 v${record.expectedRevision} 推进后的下一版。`);
  }
  return `项目标题已更新为「${result.title}」· Project v${result.revision}`;
}

export default function ProjectTitleEditor({ client, project, archived, readOnly = false, onChanged }: {
  readonly client: RelayApiClient; readonly project: RelayProject;
  readonly archived: boolean; readonly readOnly?: boolean; readonly onChanged: () => void;
}) {
  const key = storageKey(client, project.id);
  const parseCommand = useCallback((value: unknown) => parsePending(value, project.id), [project.id]);
  const [initialPending] = useState(() => readPendingCommand(key, parseCommand));
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(project.title);
  const titleRef = useRef(project.title);
  const baselineTitleRef = useRef(project.title);
  const baselineRevisionRef = useRef(project.revision);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingRename | null>(initialPending.pending);
  const pendingRef = useRef<PendingRename | null>(pending);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(initialPending.available ? null
    : "本机改名恢复记录不可用或存在冲突；请恢复存储后重新打开，未发送新命令。");
  const [receipt, setReceipt] = useState<string | null>(null);
  const [mayRetry, setMayRetry] = useState(false);
  const [conflict, setConflict] = useState<{ readonly title: string; readonly revision: string } | null>(null);

  const updateTitle = useCallback((next: string) => {
    titleRef.current = next;
    setTitle(next);
    if (next.trim() === baselineTitleRef.current.trim()) setConflict(null);
  }, []);

  const discardDraft = useCallback(() => {
    updateTitle(baselineTitleRef.current);
    setConflict(null); setError(null); setEditing(false);
  }, [updateTitle]);

  const guard = useRef<DraftGuard>({
    hasUnsavedChanges: () => pendingRef.current !== null ||
      pendingRef.current === null && titleRef.current.trim() !== baselineTitleRef.current.trim(),
    hasDraftChanges: () => pendingRef.current === null &&
      titleRef.current.trim() !== baselineTitleRef.current.trim(),
    discard: discardDraft,
    pendingCommandId: () => pendingRef.current?.commandId ?? null,
    pendingRecoversAfterLeave: () => pendingRef.current !== null &&
      hasDurablePendingCommand(key, pendingRef.current, parseCommand),
    pendingRecoversAfterRestart: () => pendingRef.current !== null &&
      hasDurablePendingCommand(key, pendingRef.current, parseCommand),
    restoreFocus: () => {
      if (titleInputRef.current && !titleInputRef.current.disabled) titleInputRef.current.focus();
    }
  });

  useEffect(() => {
    setDraftGuard(guard.current);
    return () => clearDraftGuard(guard.current);
  }, []);

  useEffect(() => {
    if (pendingRef.current !== null) return;
    const changed = project.title !== baselineTitleRef.current || project.revision !== baselineRevisionRef.current;
    if (!changed) return;
    const hadDraft = pendingRef.current === null && titleRef.current.trim() !== baselineTitleRef.current.trim();
    baselineTitleRef.current = project.title;
    baselineRevisionRef.current = project.revision;
    if (hadDraft && titleRef.current.trim() !== project.title.trim()) {
      setConflict({ title: project.title, revision: project.revision });
    } else {
      updateTitle(project.title);
      setConflict(null);
    }
  }, [pending, project.title, project.revision, updateTitle]);

  const holdPending = useCallback((next: PendingRename | null): boolean => {
    const saved = next === null ? clearPendingCommand(key, pendingRef.current, parseCommand)
      : reservePendingCommand(key, next, parseCommand);
    if (!saved) return false;
    pendingRef.current = next; setPending(next); return true;
  }, [key, parseCommand]);

  const checkReceipt = useCallback(async (record: PendingRename) => {
    setBusy(true); setError(null); setMayRetry(false);
    try {
      const response = await client.getCommandReceipt(record.commandId);
      if (response.commandType !== "EditProjectPresentation") {
        throw new RenameResponseMismatch("原回执不是本次 EditProjectPresentation。");
      }
      const message = verifyRename(record, response);
      if (!holdPending(null)) { setError("改名已确认，但本机恢复记录未能清理；请恢复存储并查询原回执。"); return; }
      baselineTitleRef.current = record.title;
      baselineRevisionRef.current = String(BigInt(record.expectedRevision) + 1n);
      updateTitle(record.title); setConflict(null); setReceipt(message); setEditing(false); onChanged();
    } catch (caught) {
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetry(true);
        setError("服务端明确未找到原命令；只能用原 ID 与原标题重试。");
      } else if (caught instanceof RenameResponseMismatch) {
        setError(`回执与冻结命令不匹配：${caught.message}已保留原 command_id。`);
      } else setError(`回执仍不可核对；请保留原 command_id。${describeLiveError(caught).message}`);
    } finally { setBusy(false); }
  }, [client, holdPending, onChanged, updateTitle]);

  const send = useCallback(async (record: PendingRename) => {
    if (!reservePendingCommand(key, record, parseCommand)) {
      setBusy(false); setError("无法保存或核对原命令，本次请求未发送；请恢复存储后核对回执。"); return;
    }
    setBusy(true); setError(null); setReceipt(null); setMayRetry(false);
    try {
      const envelope = await client.renameProject({ projectId: record.projectId,
        commandId: record.commandId, expectedRevision: record.expectedRevision,
        title: record.title });
      const message = verifyRename(record, envelope);
      if (!holdPending(null)) { setError("改名已确认，但本机恢复记录未能清理；请恢复存储并查询原回执。"); return; }
      baselineTitleRef.current = record.title;
      baselineRevisionRef.current = String(BigInt(record.expectedRevision) + 1n);
      updateTitle(record.title); setConflict(null); setReceipt(message); setEditing(false); onChanged();
    } catch (caught) {
      if (caught instanceof RenameResponseMismatch || caught instanceof RelayContractError ||
        caught instanceof RelayTransportError ||
        caught instanceof RelayApiError && (caught.problem.status >= 500 ||
          caught.problem.code === "COMMAND_ID_REUSED")) {
        setError("改名结果尚不能确认；已保留原 command_id，先查询回执。");
      } else {
        if (!holdPending(null)) { setError("命令已被拒绝，但本机恢复记录未能清理；请恢复存储并核对原命令。"); return; }
        if (caught instanceof RelayApiError && caught.problem.code === "REVISION_CONFLICT") {
          setError(`Project 修订已变化${caught.problem.actualRevision ? `（当前 v${caught.problem.actualRevision}）` : ""}；已重新读取，请再次确认。`);
          onChanged();
        } else if (caught instanceof RelayApiError && caught.problem.code === "PROJECT_ARCHIVED") {
          setError("项目已归档，不能改名；已重新读取。");
          onChanged();
        } else setError(describeLiveError(caught).message);
      }
    } finally { setBusy(false); }
  }, [client, holdPending, key, onChanged, parseCommand, updateTitle]);

  function submit() {
    if (archived || readOnly) { setError(archived ? "项目已归档，不能改名。" : "项目事实正在重新核对，暂不能提交改名。"); return; }
    const next = title.trim();
    if (next === "") { setError("项目标题不能为空。"); return; }
    if (next === project.title.trim()) { setError("标题没有变化，未提交改名命令。"); return; }
    if (pendingRef.current !== null) { setError("已有待核对的改名命令；收口前不会发出第二条。"); return; }
    if (busyRef.current) return;
    busyRef.current = true;
    const record: PendingRename = { commandId: createCommandId(), projectId: project.id,
      expectedRevision: project.revision, title: next };
    if (!holdPending(record)) {
      busyRef.current = false;
      setError("无法保存或核对本机改名恢复记录，未发送命令；请恢复存储后重试。");
      return;
    }
    void send(record).finally(() => { busyRef.current = false; });
  }

  return <div data-testid="project-title-editor">
    {!editing ? <button className="text-button" type="button" data-testid="project-rename-open"
      disabled={archived || readOnly || busy || pending !== null} onClick={() => { updateTitle(project.title); setEditing(true); }}>
      修改项目标题</button>
      : <form className="stack" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label className="field"><span className="field-label">项目标题</span>
          <input ref={titleInputRef} name="project-title" data-testid="project-title-input" maxLength={200}
            value={title} disabled={busy || pending !== null || archived || readOnly} readOnly={archived || readOnly}
            onChange={(event) => updateTitle(event.target.value)} /></label>
        <p className="helper-text">只更新展示标题；项目类型、State、Task、Goal 关系、目录与执行记录都不变。</p>
        {conflict !== null && <p className="warning-callout" role="status" data-testid="project-rename-conflict">
          项目事实已更新为「{conflict.title}」· Project v{conflict.revision}。本地标题草稿已保留；再次保存会按最新修订提交。
        </p>}
        {archived && <p className="warning-callout" role="status" data-testid="project-rename-archived-draft">
          项目已归档；本地标题草稿保留为只读文本，不能提交。
        </p>}
        <div className="form-actions">
          <button className="primary-button" type="submit" data-testid="project-rename-submit"
            disabled={busy || pending !== null || archived || readOnly}>{busy ? "正在保存" : "保存标题"}</button>
          <button className="secondary-button" type="button" data-testid="project-rename-cancel"
            disabled={busy} onClick={discardDraft}>{archived ? "丢弃本地草稿" : "取消并丢弃草稿"}</button>
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
