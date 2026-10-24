import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { DecimalRevision } from "../types";
import { createCommandId, RelayApiError, type RelayApiClient, type RelayAssistMessage,
  type RelayMemory, type RelayMemoryProvenance } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { sha256Hex } from "../lib/sha256";
import AppDialog from "./AppDialog";
import "./SaveMemoryDialog.css";

/**
 * 「保存为长期记忆」（工作台 §40 / HTTP §10.99）。
 *
 * 三条硬约束都在这里落地：
 * 1. 保存的是**原消息正文的 SHA256**，不是用户编辑后的记忆草稿——所以 hash 在读到原文时算一次，
 *    之后无论怎么改标题正文都不重算。改了正文是「这条记忆写什么」，不是「来源是哪条消息」。
 * 2. 范围只能是全局或**原会话所属项目**：不能借当前页面碰巧选中的另一个项目扩大作用域。
 * 3. 用户必须明确确认。没有自动提取、没有默认保存、没有后台补写。
 */

type SourceState =
  | { readonly kind: "READING" }
  | { readonly kind: "UNAVAILABLE"; readonly reason: string }
  | { readonly kind: "READY"; readonly message: RelayAssistMessage; readonly content: string; readonly sha256: string };

type SavedState = { readonly memory: RelayMemory; readonly provenance: RelayMemoryProvenance };

/** 标题取正文首行；只做长度截断，不改写内容。用户可再编辑。 */
function defaultTitle(content: string): string {
  const firstLine = content.split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== "") ?? "";
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
}

export default function SaveMemoryDialog({ client, sessionId, sessionRevision, sessionProjectId,
  messageId, onClose, onSaved }: {
  readonly client: RelayApiClient;
  readonly sessionId: string;
  readonly sessionRevision: DecimalRevision;
  readonly sessionProjectId: string | null;
  readonly messageId: string;
  readonly onClose: () => void;
  readonly onSaved?: (memoryId: string) => void;
}) {
  const [source, setSource] = useState<SourceState>({ kind: "READING" });
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [scope, setScope] = useState<"GLOBAL" | "PROJECT">(sessionProjectId === null ? "GLOBAL" : "PROJECT");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  /** 响应丢失时保留的原命令与载荷：只允许按原 ID 查回执或原样重试。 */
  const [pending, setPending] = useState<{ readonly commandId: string; readonly title: string;
    readonly text: string; readonly projectId: string | null } | null>(null);
  /**
   * 创建命令已确认后持有的记忆身份（工作台 §40）：创建成功是服务端事实，详情/来源读不出来
   * 只是读取失败。持有身份期间只提供重读，绝不从同一对话框再发一次创建命令。
   */
  const [createdMemoryId, setCreatedMemoryId] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedState | null>(null);
  const requestVersion = useRef(0);
  const disposed = useRef(false);

  useEffect(() => {
    disposed.current = false;
    return () => { disposed.current = true; requestVersion.current += 1; };
  }, []);

  /**
   * 读确切来源：从服务端重读这条消息，而不是用界面上已有的文本。
   *
   * 界面上的文本可能来自一次较早的读取；保存命令要求 `expected_session_revision` 与原文
   * hash 同时匹配，所以必须拿「现在这一刻」的原文，并在同一次读取里固定 hash。
   */
  const readSource = useCallback(async () => {
    const request = ++requestVersion.current;
    setSource({ kind: "READING" }); setError(null); setConflict(null);
    try {
      const messages = await client.getAssistMessages(sessionId);
      if (disposed.current || request !== requestVersion.current) return;
      const message = messages.find((item) => item.id === messageId);
      if (message === undefined) {
        setSource({ kind: "UNAVAILABLE", reason: "这条消息当前不在会话列表里（可能已被清理）。没有来源就不能建立记忆。" });
        return;
      }
      if (message.status !== "COMPLETED") {
        setSource({ kind: "UNAVAILABLE", reason: "只有已完成的回复或消息才能保存；在途、失败或已取消的内容不能作为长期事实。" });
        return;
      }
      if (message.content === null || message.content.trim() === "") {
        setSource({ kind: "UNAVAILABLE", reason: "这条消息没有可保存的正文。" });
        return;
      }
      const content = message.content;
      const digest = sha256Hex(content);
      setSource({ kind: "READY", message, content, sha256: digest });
      setTitle((current) => current === "" ? defaultTitle(content) : current);
      setText((current) => current === "" ? content : current);
    } catch (caught) {
      if (disposed.current || request !== requestVersion.current) return;
      setSource({ kind: "UNAVAILABLE", reason: `来源消息读取失败：${describeLiveError(caught).message}` });
    }
  }, [client, sessionId, messageId]);

  useEffect(() => { void readSource(); }, [readSource]);

  async function submit(frozen?: { commandId: string; title: string; text: string;
    projectId: string | null }) {
    if (source.kind !== "READY" || saving) return;
    // 已持有创建身份时这里只可能误触创建入口：身份重读走 rereadCreated，不能再次创建。
    if (createdMemoryId !== null) return;
    const payload = frozen ?? { commandId: createCommandId(), title: title.trim(),
      text: text.trim(), projectId: scope === "PROJECT" ? sessionProjectId : null };
    if (payload.title === "" || payload.text === "") { setError("标题与内容都不能为空。"); return; }
    setSaving(true); setError(null); setConflict(null); setPending(null);
    // 创建与读回是两个事实：进入这个变量说明创建命令本身已经成功（201）。
    let createdId: string | null = null;
    try {
      const created = await client.createMemoryFromMessage({ sessionId, messageId,
        commandId: payload.commandId, expectedSessionRevision: sessionRevision,
        // 来源 hash 固定来自原文：编辑草稿不会改变它。
        contentSha256: source.sha256, projectId: payload.projectId,
        title: payload.title, text: payload.text });
      if (disposed.current) return;
      createdId = created.memoryId;
      setCreatedMemoryId(created.memoryId);
      await showSaved(created.memoryId);
    } catch (caught) {
      if (disposed.current) return;
      const described = describeLiveError(caught);
      if (createdId !== null) {
        // 创建已确认，失败的是详情/来源读取：保留已创建身份只重读，不当作保存失败、不开放再创建。
        setError(described.message);
        return;
      }
      if (caught instanceof RelayApiError && caught.problem.status === 409) {
        // 会话或来源在确认期间变化：不覆盖、不换命令 ID 重发，让用户重新读取后再决定。
        setConflict(described.message);
      } else if (described.kind === "transport") {
        // 响应丢失：命令可能已入库。保留原 command_id 与载荷，只给查回执与原命令重试。
        setPending(payload);
      } else {
        setError(described.message);
      }
    } finally { if (!disposed.current) setSaving(false); }
  }

  /** 只重读已创建的记忆身份：读回失败不改变「已保存」这一事实，也不重新创建。 */
  async function rereadCreated() {
    if (createdMemoryId === null || saving) return;
    setSaving(true); setError(null);
    try {
      await showSaved(createdMemoryId);
    } catch (caught) {
      if (!disposed.current) setError(describeLiveError(caught).message);
    } finally { if (!disposed.current) setSaving(false); }
  }

  /** 回执只给身份：展示的记忆与来源必须再读一次，避免把本地草稿当成已保存事实。 */
  async function showSaved(memoryId: string) {
    const [memory, provenance] = await Promise.all([
      client.getMemory(memoryId), client.getMemoryProvenance(memoryId)]);
    if (disposed.current) return;
    setSaved({ memory, provenance });
    onSaved?.(memoryId);
  }

  /** 按原 command_id 查回执：类型与 CreateMemoryFromMessage 对得上才算保存已生效。 */
  async function checkReceipt() {
    if (pending === null) return;
    setSaving(true); setError(null);
    try {
      const receipt = await client.getCommandReceipt(pending.commandId);
      if (disposed.current) return;
      if (receipt.commandType !== "CreateMemoryFromMessage") {
        setError(`原命令回执的类型是 ${receipt.commandType}，不是保存记忆；不能当作已保存。`);
        return;
      }
      const memoryId = receipt.result.memory_id;
      if (typeof memoryId !== "string") { setError("原命令回执没有记忆身份，无法核对。"); return; }
      // 回执确认创建已生效：先持有身份再读详情，读失败也停留在「已创建待重读」，不回到可创建状态。
      setCreatedMemoryId(memoryId);
      setPending(null);
      try {
        await showSaved(memoryId);
      } catch (caught) {
        if (!disposed.current) setError(describeLiveError(caught).message);
        return;
      }
    } catch (caught) {
      if (!disposed.current) setError(`回执尚未核对到：${describeLiveError(caught).message}`);
    } finally { if (!disposed.current) setSaving(false); }
  }

  const ready = source.kind === "READY" ? source : null;
  const canSubmit = ready !== null && !saving && createdMemoryId === null && title.trim() !== "" && text.trim() !== "";

  return <AppDialog open title="保存为长期记忆" size="lg" onClose={onClose}
    subtitle="只保存你确认的这条来源；不会自动提取或后台保存其他内容">
    <div className="save-memory" data-testid="save-memory-dialog">
      {saved === null ? <>
        <section className="save-memory-source" data-testid="save-memory-source" data-state={source.kind}>
          <h3>来源</h3>
          {source.kind === "READING" && <p className="helper-text" role="status">正在读取原消息正文…</p>}
          {source.kind === "UNAVAILABLE" && <>
            <p className="action-error" role="alert" data-testid="save-memory-source-error">{source.reason}</p>
            <button className="secondary-button" type="button" data-testid="save-memory-source-retry"
              onClick={() => void readSource()}>重新读取来源</button>
          </>}
          {ready !== null && <>
            <p className="helper-text" data-testid="save-memory-source-ref">
              {ready.message.role === "USER" ? "用户消息" : "AI 回复"} · 第 {ready.message.seq} 条 ·
              ID <code className="hash-code">{ready.message.id}</code>
            </p>
            <p className="helper-text">来源摘要（原消息正文的 SHA256，确认保存时提交）：<code className="hash-code"
              data-testid="save-memory-source-sha256">{ready.sha256}</code></p>
            <p className="helper-text">下面可以改写记忆的标题与内容；来源始终是这条原消息，改正文不会换来源。</p>
          </>}
        </section>

        {ready !== null && <>
          <label className="field"><span className="field-label">标题</span>
            <input data-testid="save-memory-title" value={title} maxLength={200} disabled={saving}
              onChange={(event) => { setTitle(event.target.value); setError(null); }} /></label>
          <label className="field"><span className="field-label">内容</span>
            <textarea data-testid="save-memory-text" value={text} rows={10} maxLength={20000} disabled={saving}
              onChange={(event) => { setText(event.target.value); setError(null); }} /></label>
          <fieldset className="save-memory-scope" data-testid="save-memory-scope">
            <legend>范围</legend>
            <label><input type="radio" name="save-memory-scope" value="GLOBAL"
              checked={scope === "GLOBAL"} disabled={saving}
              onChange={() => setScope("GLOBAL")} />全局（本工作空间所有项目可用）</label>
            <label><input type="radio" name="save-memory-scope" value="PROJECT"
              checked={scope === "PROJECT"} disabled={saving || sessionProjectId === null}
              onChange={() => setScope("PROJECT")} />当前会话所属项目{sessionProjectId === null
                ? "（本会话没有项目归属，只能保存为全局）" : ""}</label>
            <p className="helper-text">范围只能是全局或原会话所属项目：不能借当前页面选中的其他项目扩大作用域。</p>
          </fieldset>
          <p className="helper-text">保存后这条记忆带明确确认人，并按有效期与范围参与后续召回。
            它不会改变任务状态、验收结论或任何权限。</p>
          {conflict !== null && <div className="action-error" role="alert" data-testid="save-memory-conflict">
            <p>会话或来源已变化：{conflict}</p>
            <p className="helper-text">草稿保留在这里。请先重新读取来源与最新修订，再决定是否保存；不会用旧修订覆盖。</p>
            <button className="secondary-button" type="button" data-testid="save-memory-reload"
              disabled={saving} onClick={() => void readSource()}>重新读取来源</button>
          </div>}
          {error !== null && <p className="action-error" role="alert" data-testid="save-memory-error">
            {createdMemoryId === null ? "保存失败：" : "记忆已创建（命令已确认），读取已保存内容失败："}{error}</p>}
          {createdMemoryId !== null && saved === null && <div className="save-memory-actions">
            <button className="secondary-button" type="button" data-testid="save-memory-reread"
              disabled={saving} onClick={() => void rereadCreated()}>重新读取已保存的记忆</button>
          </div>}
          {pending !== null && <div className="action-error" role="alert" data-testid="save-memory-pending">
            <p>保存结果未核对：请求响应丢失，这条命令是否已生效尚未确定。草稿与载荷都保留在这里。</p>
            <p className="helper-text">原 command_id：{pending.commandId}。先查回执；查不到时只能按同一命令与同一载荷重试，不换新 ID。</p>
            <div className="save-memory-actions">
              <button className="secondary-button" type="button" data-testid="save-memory-receipt"
                disabled={saving} onClick={() => void checkReceipt()}>查询原命令回执</button>
              <button className="secondary-button" type="button" data-testid="save-memory-retry"
                disabled={saving} onClick={() => void submit(pending)}>按原命令重试</button>
            </div>
          </div>}
          <div className="save-memory-actions">
            <button className="primary-button" type="button" data-testid="save-memory-confirm"
              disabled={!canSubmit || pending !== null} onClick={() => void submit()}>
              {saving ? "正在保存" : "确认保存为长期记忆"}</button>
            <button className="secondary-button" type="button" data-testid="save-memory-cancel"
              disabled={saving} onClick={onClose}>取消</button>
          </div>
        </>}
        {ready === null && <div className="save-memory-actions">
          <button className="secondary-button" type="button" data-testid="save-memory-close" onClick={onClose}>关闭</button>
        </div>}
      </> : <section className="save-memory-saved" data-testid="save-memory-saved">
        <h3>已保存</h3>
        <p>服务端返回的记忆：<strong data-testid="save-memory-saved-title">{saved.memory.title}</strong>
          {" "}· v{saved.memory.currentVersion} · 修订 v{saved.memory.revision} ·
          {saved.memory.projectId === null ? "全局" : "项目范围"}</p>
        <p className="helper-text" data-testid="save-memory-saved-text">{saved.memory.text}</p>
        <p className="helper-text" data-testid="save-memory-saved-status">
          持久状态 {saved.memory.status}
          {saved.memory.effectiveStatus === null ? " · 有效状态待核对" : ""}
          {saved.memory.effectiveStatus === "ACTIVE" ? " · 当前有效" : ""}
          {saved.memory.effectiveStatus === "EXPIRED" ? " · 已过期" : ""}
          {saved.memory.effectiveStatus === "RETIRED" ? " · 已停用" : ""}
          {" "}· 确认 {saved.memory.confirmedBy} · {saved.memory.confirmedAt}
        </p>
        <h4>保存来源</h4>
        {saved.provenance.sources.length === 0
          ? <p className="helper-text" data-testid="save-memory-saved-sources-empty">服务端没有返回这条记忆的来源记录。</p>
          : <ul className="save-memory-sources" data-testid="save-memory-saved-sources">
            {saved.provenance.sources.map((item) => <li key={`${item.sessionId}:${item.messageId}:${item.memoryVersion}`}>
              版本 v{item.memoryVersion} · 会话 <code className="hash-code">{item.sessionId}</code> ·
              消息 <code className="hash-code">{item.messageId}</code> ·
              原文摘要 <code className="hash-code">{item.contentSha256}</code>
            </li>)}
          </ul>}
        <div className="save-memory-actions">
          <Link className="inline-link" to={`/knowledge?kind=MEMORY&item=${encodeURIComponent(saved.memory.id)}`}
            data-testid="save-memory-open">在资料页打开这条记忆</Link>
          <button className="secondary-button" type="button" data-testid="save-memory-done" onClick={onClose}>完成</button>
        </div>
      </section>}
    </div>
  </AppDialog>;
}
