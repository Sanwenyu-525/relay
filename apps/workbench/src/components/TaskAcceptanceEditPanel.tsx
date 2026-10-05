import { useEffect, useRef, useState } from "react";
import { createCommandId, RelayApiError, taskAcceptanceRevisionFrom, type RelayApiClient,
  type RelayTaskAcceptance, type RelayTaskAcceptanceRevision, type RelayTaskAcceptanceRevisionInput } from "../api/relayClient";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { describeLiveError } from "../lib/liveErrors";

/** 只补充人工必需条件，完整保留当前版本；不改变目标、产物规格或任务状态。 */
export default function TaskAcceptanceEditPanel({ client, taskId, taskRevision, acceptance, blockedReason, onSaved }: {
  client: RelayApiClient; taskId: string; taskRevision: string; acceptance: RelayTaskAcceptance;
  blockedReason: string | null; onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<RelayTaskAcceptanceRevisionInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [mayRetry, setMayRetry] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<RelayTaskAcceptanceRevision | null>(null);
  const busyRef = useRef(false);
  const pendingRef = useRef(pending);
  const textRef = useRef(text);
  const active = useRef(true);
  const scope = useRef({ client, taskId });
  scope.current = { client, taskId }; textRef.current = text; pendingRef.current = pending;
  const additions = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const inputError = additions.length === 0 ? "请至少填写一条完成条件。"
    : additions.some(line => line.length > 500) ? "每条完成条件最多 500 字。"
    : acceptance.criteria.length + additions.length > 30 ? "验收条件总数最多 30 条。" : null;
  const writeBlocked = blockedReason ?? (acceptance.criteria.some(c => c.targetSpec === null)
    ? "当前条件的检查对象尚未读全，请重新读取任务后再补充。" : null);

  useEffect(() => {
    active.current = true;
    const guard: DraftGuard = { hasUnsavedChanges: () => textRef.current.trim() !== "",
      pendingCommandId: () => pendingRef.current?.commandId ?? null,
      discard: () => { if (pendingRef.current !== null) return; textRef.current = ""; setText(""); setEditing(false); } };
    setDraftGuard(guard);
    return () => { active.current = false; clearDraftGuard(guard); };
  }, []);
  const current = (record: RelayTaskAcceptanceRevisionInput) => active.current &&
    scope.current.client === client && scope.current.taskId === record.taskId;
  function clearPending() { pendingRef.current = null; setPending(null); setMayRetry(false); }
  async function accept(record: RelayTaskAcceptanceRevisionInput, result: RelayTaskAcceptanceRevision) {
    if (result.taskId !== record.taskId || result.previousAcceptanceRevision !== record.expectedAcceptanceRevision ||
        BigInt(result.acceptanceRevision) !== BigInt(record.expectedAcceptanceRevision) + 1n ||
        BigInt(result.revision) !== BigInt(record.expectedRevision) + 1n) {
      throw new Error("验收回执与原任务或验收版本不匹配。");
    }
    if (!current(record)) return;
    clearPending(); textRef.current = ""; setText(""); setEditing(false); setError(null); setSaved(result);
    await onSaved();
  }
  async function checkReceipt(record: RelayTaskAcceptanceRevisionInput) {
    try {
      const receipt = await client.getCommandReceipt(record.commandId);
      if (!current(record)) return;
      if (receipt.commandId !== record.commandId || receipt.commandType !== "ReviseTaskAcceptance")
        throw new Error("原回执不是本次验收修改命令。");
      await accept(record, taskAcceptanceRevisionFrom(receipt.result));
    } catch (caught) {
      if (!current(record)) return;
      setMayRetry(caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND");
      setError(caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND"
        ? "服务端未找到原命令；可用原身份和原内容重试。"
        : `保存结果仍待核对，请保留原命令。${describeLiveError(caught).message}`);
    }
  }
  async function send(record: RelayTaskAcceptanceRevisionInput) {
    setError(null); setMayRetry(false);
    try { await accept(record, await client.reviseTaskAcceptance(record)); }
    catch (caught) {
      if (!current(record)) return;
      if (caught instanceof RelayApiError && caught.problem.status < 500 && caught.problem.code !== "COMMAND_ID_REUSED") {
        clearPending(); setError(describeLiveError(caught).message);
        // 冲突/失权后重读，由人按新事实再次确认；不自动套新修订重发。
        await onSaved();
      } else await checkReceipt(record);
    }
  }
  async function act(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await action(); } finally { busyRef.current = false; if (active.current) setBusy(false); }
  }
  function submit() {
    if (busyRef.current || pendingRef.current || writeBlocked || inputError) return;
    const record: RelayTaskAcceptanceRevisionInput = { taskId, commandId: createCommandId(),
      expectedRevision: taskRevision, expectedAcceptanceRevision: acceptance.acceptanceRevision,
      criteria: [...acceptance.criteria.map(c => ({ criterionId: c.criterionId, statement: c.statement,
        required: c.required, method: c.method, targetSpec: c.targetSpec! })),
        ...additions.map(statement => ({ statement, required: true, method: "HUMAN", targetSpec: {} }))] };
    pendingRef.current = record; setPending(record); setSaved(null);
    void act(() => send(record));
  }

  return <section className="surface-panel" data-testid="task-acceptance-edit">
    <h2>补充完成条件</h2>
    <p className="helper-text">保留已确认条件，新增需要人工核对的条件。保存后仍需单独开始任务，旧验证不自动用于新验收版本。</p>
    {!editing && <button className="secondary-button" type="button" data-testid="task-acceptance-edit-open"
      disabled={writeBlocked !== null || busy || pending !== null} onClick={() => { setEditing(true); setSaved(null); }}>补充验收条件</button>}
    {writeBlocked && <p className="disabled-reason">{writeBlocked}</p>}
    {editing && <form onSubmit={event => { event.preventDefault(); submit(); }}>
      <label className="field"><span className="field-label">新增完成条件（每行一条）</span>
        <textarea data-testid="task-acceptance-additions" rows={4} value={text} disabled={busy || pending !== null}
          onChange={event => setText(event.target.value)} /></label>
      {inputError && <p className="helper-text">{inputError}</p>}
      <div className="form-actions"><button className="primary-button" type="submit" data-testid="task-acceptance-save"
        disabled={busy || pending !== null || writeBlocked !== null || inputError !== null}>{busy ? "正在核对…" : "保存完成条件"}</button>
        <button className="secondary-button" type="button" disabled={busy || pending !== null}
          onClick={() => { textRef.current = ""; setText(""); setEditing(false); setError(null); }}>放弃本次输入</button></div>
    </form>}
    {error && <p className="action-error" role="alert">{error}</p>}
    {saved && <p className="receipt-message" role="status" data-testid="task-acceptance-saved">已保存验收版本 v{saved.acceptanceRevision}。任务状态仍以重新读取的事实为准。</p>}
    {pending && <div className="warning-callout" data-testid="task-acceptance-pending">
      <p>保存结果待核对。原命令：<code>{pending.commandId}</code>，原验收版本 v{pending.expectedAcceptanceRevision}。</p>
      <button className="secondary-button" type="button" disabled={busy} data-testid="task-acceptance-receipt"
        onClick={() => void act(() => checkReceipt(pending))}>核对原命令回执</button>
      {mayRetry && <button className="secondary-button" type="button" disabled={busy || writeBlocked !== null}
        data-testid="task-acceptance-retry" onClick={() => void act(() => send(pending))}>用原身份和原内容重试</button>}
    </div>}
  </section>;
}
