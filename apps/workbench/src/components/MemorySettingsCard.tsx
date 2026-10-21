import { useCallback, useEffect, useRef, useState } from "react";
import type { DecimalRevision } from "../types";
import { createCommandId, RelayTransportError, type RelayApiClient, type RelayMemorySettings }
  from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import "./MemorySettingsCard.css";

/**
 * Workspace 级记忆设置（工作台 §40 / HTTP §10.99）。
 *
 * 两个开关互相独立：关掉「自动整理」仍然可以手动整理；关掉「自动使用记忆」之后，
 * 历史里依赖自动召回来源的旧摘要与旧答复也不会被匿名复用（那条约束由服务端判定，
 * 界面只如实说明，不自己再算一遍）。
 *
 * 保存必须同时提交两个开关：服务端按整行 CAS 写入，只带想改的那一个会把另一个写成默认值。
 */

type Draft = { readonly recallEnabled: boolean; readonly automaticCompaction: boolean;
  readonly autoCapture: boolean };
type Pending = { readonly commandId: string; readonly expectedRevision: DecimalRevision;
  readonly draft: Draft; readonly reason: string };

export default function MemorySettingsCard({ client }: { readonly client: RelayApiClient | null }) {
  const [settings, setSettings] = useState<RelayMemorySettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [checking, setChecking] = useState(false);
  const requestVersion = useRef(0);
  const disposed = useRef(false);

  useEffect(() => {
    disposed.current = false;
    return () => { disposed.current = true; requestVersion.current += 1; };
  }, []);

  const read = useCallback(async (keepDraft = false) => {
    if (client === null) { setLoading(false); setSettings(null); setDraft(null); return; }
    const request = ++requestVersion.current;
    setLoading(true); setError(null);
    try {
      const next = await client.getMemorySettings();
      if (disposed.current || request !== requestVersion.current) return;
      setSettings(next);
      if (!keepDraft) setDraft({ recallEnabled: next.recallEnabled,
        automaticCompaction: next.automaticCompaction, autoCapture: next.autoCapture });
    } catch (caught) {
      if (disposed.current || request !== requestVersion.current) return;
      setError(describeLiveError(caught).message);
    } finally {
      if (!disposed.current && request === requestVersion.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => { void read(); }, [read]);

  const dirty = settings !== null && draft !== null &&
    (draft.recallEnabled !== settings.recallEnabled ||
      draft.automaticCompaction !== settings.automaticCompaction || draft.autoCapture !== settings.autoCapture);

  async function save(payload: Pending | { commandId: string; expectedRevision: DecimalRevision;
    draft: Draft }): Promise<void> {
    if (client === null || draft === null) return;
    setSaving(true); setError(null); setNotice(null); setConflict(null);
    try {
      const saved = await client.saveMemorySettings({ commandId: payload.commandId,
        expectedRevision: payload.expectedRevision,
        recallEnabled: payload.draft.recallEnabled, automaticCompaction: payload.draft.automaticCompaction,
        autoCapture: payload.draft.autoCapture });
      if (disposed.current) return;
      setPending(null);
      setSettings(saved);
      setDraft({ recallEnabled: saved.recallEnabled, automaticCompaction: saved.automaticCompaction,
        autoCapture: saved.autoCapture });
      setNotice(`已保存（修订 v${saved.revision}）：自动使用记忆${saved.recallEnabled ? "已开启" : "已关闭"}，`
        + `自动整理${saved.automaticCompaction ? "已开启" : "已关闭"}，`
        + `自动记住${saved.autoCapture ? "已开启" : "已关闭"}。`);
    } catch (caught) {
      if (disposed.current) return;
      const described = describeLiveError(caught);
      if (described.kind === "conflict") {
        // 409：不覆盖。重读基线，草稿原样保留，由用户决定按新修订重存还是丢弃。
        setConflict(described.message);
        await read(true);
        return;
      }
      if (caught instanceof RelayTransportError) {
        // 结果未知：保留原 command_id 与载荷，只能查回执或用同一命令重试。
        setPending({ ...payload, reason: described.message });
        return;
      }
      setError(described.message);
    } finally { if (!disposed.current) setSaving(false); }
  }

  async function checkReceipt() {
    if (client === null || pending === null) return;
    setChecking(true); setError(null);
    try {
      const receipt = await client.getCommandReceipt(pending.commandId);
      if (disposed.current) return;
      if (receipt.commandType !== "SetMemorySettings") {
        setError(`原命令回执的类型是 ${receipt.commandType}，不是记忆设置；不能当作本次保存已生效。`);
        return;
      }
      const saved = { workspaceId: String(receipt.result.workspace_id ?? ""),
        revision: String(receipt.result.revision ?? ""),
        recallEnabled: receipt.result.recall_enabled === true,
        automaticCompaction: receipt.result.automatic_compaction === true,
        autoCapture: receipt.result.auto_capture !== false };
      if (saved.workspaceId !== settings?.workspaceId) {
        setError("原命令回执属于另一个工作空间，不能当作本次保存已生效。");
        return;
      }
      setPending(null); setNotice(`原命令回执已核对：设置已保存（修订 v${saved.revision}）。`);
      await read();
    } catch (caught) {
      if (!disposed.current) setError(`回执尚未核对到：${describeLiveError(caught).message}`);
    } finally { if (!disposed.current) setChecking(false); }
  }

  if (client === null) {
    return <section className="surface-panel settings-card" data-testid="memory-settings">
      <h2>长期与短期记忆</h2>
      <p className="helper-text">示例数据预览下没有可读写的记忆设置。</p>
    </section>;
  }

  return <section className="surface-panel settings-card" data-testid="memory-settings">
    <h2>长期与短期记忆</h2>
    <p className="helper-text">这两项按工作空间生效，初始状态读取服务端；改动会立即影响后续对话，不追溯已生成的回复。</p>

    {loading && settings === null && <p role="status" data-testid="memory-settings-loading">正在读取记忆设置…</p>}
    {error !== null && <div className="action-error" role="alert" data-testid="memory-settings-error">
      <p>记忆设置读取失败：{error}</p>
      <button className="secondary-button" type="button" disabled={loading} onClick={() => void read()}>重新读取</button>
    </div>}

    {settings !== null && draft !== null && <>
      <div className="memory-settings-switches">
        <label className="memory-settings-switch">
          <input type="checkbox" data-testid="memory-settings-recall" checked={draft.recallEnabled}
            disabled={saving} onChange={(event) => {
              setDraft({ ...draft, recallEnabled: event.target.checked }); setNotice(null);
            }} />
          <span>
            <strong>自动使用已确认记忆</strong>
            <span className="helper-text">普通对话会按字面匹配自动召回最多 3 条当前有效的已确认记忆（全局与当前项目）。
              关闭后不再自动召回，历史里依赖自动召回的旧摘要与答复也不会被匿名复用。</span>
          </span>
        </label>
        <label className="memory-settings-switch">
          <input type="checkbox" data-testid="memory-settings-compaction" checked={draft.automaticCompaction}
            disabled={saving} onChange={(event) => {
              setDraft({ ...draft, automaticCompaction: event.target.checked }); setNotice(null);
            }} />
          <span>
            <strong>自动整理会话历史</strong>
            <span className="helper-text">已完成轮次累积到阈值时，把较早的历史压成摘要并保留最近原文。
              关闭后不会自动整理，但会话里的「整理记忆」仍可手动使用。</span>
          </span>
        </label>
        <label className="memory-settings-switch">
          <input type="checkbox" data-testid="memory-settings-auto-capture" checked={draft.autoCapture}
            disabled={saving} onChange={(event) => {
              setDraft({ ...draft, autoCapture: event.target.checked }); setNotice(null);
            }} />
          <span>
            <strong>自动记住有价值的约定</strong>
            <span className="helper-text">每轮回复结算后由系统判断有没有值得沉淀的内容——决定、约定、偏好与事实性结论，
              一次最多 3 条，直接写入长期记忆并参与后续召回；每会话每天最多 5 条。没有值得记的就什么都不写。
              是否生成由系统判断，不逐条问你；你能做的是关掉它，或事后停用某一条。
              它记的是模型判断，不是你的确认——在「资料 → 记忆」里标为「自动记住」，
              并标明哪一条是「用户原话」、哪一条只是「模型观察」；关闭后不再新增，已有条目仍可召回。</span>
          </span>
        </label>
      </div>
      <p className="helper-text" data-testid="memory-settings-revision">当前修订 v{settings.revision}</p>
      <div className="memory-settings-actions">
        <button className="primary-button" type="button" data-testid="memory-settings-save"
          disabled={saving || !dirty} onClick={() => void save({ commandId: createCommandId(),
            expectedRevision: settings.revision, draft })}>{saving ? "正在保存" : "保存设置"}</button>
        <button className="secondary-button" type="button" data-testid="memory-settings-reload"
          disabled={saving || loading} onClick={() => void read()}>重新读取</button>
      </div>
      {conflict !== null && <div className="action-error" role="alert" data-testid="memory-settings-conflict">
        <p>保存冲突：{conflict}</p>
        <p className="helper-text">已重新读取最新设置，你的改动仍保留在开关上。请核对后再保存一次，或丢弃改动。</p>
        <div className="memory-settings-actions">
          <button className="secondary-button" type="button" data-testid="memory-settings-conflict-save"
            disabled={saving} onClick={() => void save({ commandId: createCommandId(),
              expectedRevision: settings.revision, draft })}>按最新修订保存</button>
          <button className="secondary-button" type="button" data-testid="memory-settings-conflict-discard"
            disabled={saving} onClick={() => void read()}>丢弃改动并重读</button>
        </div>
      </div>}
      {notice !== null && <p className="receipt-message" role="status" data-testid="memory-settings-notice">{notice}</p>}
      {pending !== null && <div className="action-error" role="alert" data-testid="memory-settings-pending">
        <p>保存结果待核对：{pending.reason}</p>
        <p className="helper-text">原 command_id：{pending.commandId}。先查回执；查不到时只能用同一命令与同一载荷重试，不换新 ID。</p>
        <div className="memory-settings-actions">
          <button className="secondary-button" type="button" data-testid="memory-settings-receipt"
            disabled={checking} onClick={() => void checkReceipt()}>{checking ? "正在查询" : "查询原命令回执"}</button>
          <button className="secondary-button" type="button" data-testid="memory-settings-retry"
            disabled={saving || checking} onClick={() => void save(pending)}>按原命令重试</button>
        </div>
      </div>}
    </>}
    <p className="helper-text">记忆不替代业务事实：摘要与召回内容只是模型上下文，不能据此判定任务完成、验收通过或权限已授予。</p>
  </section>;
}
