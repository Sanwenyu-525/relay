import { useCallback, useEffect, useRef, useState } from "react";
import type { DecimalRevision } from "../types";
import { createCommandId, RelayTransportError, type RelayApiClient, type RelayMemorySettings }
  from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import "./MemorySettingsCard.css";
import { Button, FormField, Input } from "../ui";

/**
 * Workspace 级记忆设置（工作台 §40 / HTTP §10.99）。
 *
 * 三个开关互相独立：关掉「自动整理」仍然可以手动整理；关掉「自动使用记忆」之后，
 * 历史里依赖自动召回来源的旧摘要与旧答复也不会被匿名复用（那条约束由服务端判定，
 * 界面只如实说明，不自己再算一遍）。
 *
 * CONTEXT-COMPACTION-0162：多一个压缩阈值——它决定「历史涨到多少 tokens 时自动整理」，
 * 存空 = 使用产品默认（服务端给出默认值，界面不抄常量）。推荐区间只是提示，不强制；
 * 保存值高于当前模型安全上限时服务端仍会保存，但生效时按真实窗口收敛，并在会话的
 * 上下文面板里明说。
 *
 * 保存必须同时提交全部字段：服务端按整行 CAS 写入，只带想改的那一个会把它写成默认值。
 */

type Draft = { readonly recallEnabled: boolean; readonly automaticCompaction: boolean;
  readonly autoCapture: boolean; readonly compactionThresholdTokens: number | null };
type Pending = { readonly commandId: string; readonly expectedRevision: DecimalRevision;
  readonly draft: Draft; readonly reason: string };

export default function MemorySettingsCard({ client }: { readonly client: RelayApiClient | null }) {
  const [settings, setSettings] = useState<RelayMemorySettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** 阈值输入框的原始文本：空串 = 使用产品默认，保存成 null。 */
  const [thresholdText, setThresholdText] = useState("");
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
      if (!keepDraft) {
        setDraft({ recallEnabled: next.recallEnabled,
          automaticCompaction: next.automaticCompaction, autoCapture: next.autoCapture,
          compactionThresholdTokens: next.compactionThresholdTokens });
        setThresholdText(next.compactionThresholdTokens === null
          ? "" : String(next.compactionThresholdTokens));
      }
    } catch (caught) {
      if (disposed.current || request !== requestVersion.current) return;
      setError(describeLiveError(caught).message);
    } finally {
      if (!disposed.current && request === requestVersion.current) setLoading(false);
    }
  }, [client]);

  /** 换工作空间时先清掉旧投影与在途命令，旧修订与旧开关不落进新范围。 */
  useEffect(() => {
    setSettings(null); setDraft(null); setNotice(null); setConflict(null);
    setPending(null); setError(null); setThresholdText("");
  }, [client]);

  useEffect(() => { void read(); }, [read]);

  /*
   * 阈值输入的即时读法：空格与千分位逗号忽略，空串表示「使用默认」。
   * 只在非空且不是正整数时给出本地错误——精确区间由服务端校验并在保存失败时说明，
   * 界面不另抄一份边界常量。
   */
  const thresholdParsed = parseThresholdText(thresholdText);
  const thresholdError = thresholdParsed.kind === "invalid"
    ? "请填正整数 tokens，或留空使用默认阈值。" : null;

  const dirty = settings !== null && draft !== null &&
    (draft.recallEnabled !== settings.recallEnabled ||
      draft.automaticCompaction !== settings.automaticCompaction ||
      draft.autoCapture !== settings.autoCapture ||
      draft.compactionThresholdTokens !== settings.compactionThresholdTokens);

  /** 输入框与草稿一起更新：非法文本保留原文但不改动草稿，保存键同时被错误态禁用。 */
  function changeThreshold(next: string): void {
    setThresholdText(next); setNotice(null);
    if (draft === null) return;
    const parsed = parseThresholdText(next);
    if (parsed.kind === "value") setDraft({ ...draft, compactionThresholdTokens: parsed.value });
    else if (parsed.kind === "empty") setDraft({ ...draft, compactionThresholdTokens: null });
  }

  async function save(payload: Pending | { commandId: string; expectedRevision: DecimalRevision;
    draft: Draft }): Promise<void> {
    if (client === null || draft === null) return;
    if (thresholdError !== null) { setError(thresholdError); return; }
    setSaving(true); setError(null); setNotice(null); setConflict(null);
    try {
      const saved = await client.saveMemorySettings({ commandId: payload.commandId,
        expectedRevision: payload.expectedRevision,
        recallEnabled: payload.draft.recallEnabled, automaticCompaction: payload.draft.automaticCompaction,
        autoCapture: payload.draft.autoCapture,
        compactionThresholdTokens: payload.draft.compactionThresholdTokens });
      if (disposed.current) return;
      setPending(null);
      setSettings(saved);
      setDraft({ recallEnabled: saved.recallEnabled, automaticCompaction: saved.automaticCompaction,
        autoCapture: saved.autoCapture, compactionThresholdTokens: saved.compactionThresholdTokens });
      setThresholdText(saved.compactionThresholdTokens === null
        ? "" : String(saved.compactionThresholdTokens));
      setNotice(`已保存（修订 v${saved.revision}）：自动使用记忆${saved.recallEnabled ? "已开启" : "已关闭"}，`
        + `自动整理${saved.automaticCompaction ? "已开启" : "已关闭"}，`
        + `自动记住${saved.autoCapture ? "已开启" : "已关闭"}，`
        + `压缩阈值${saved.compactionThresholdTokens === null
          ? `使用默认 ${saved.compactionThresholdDefaultTokens.toLocaleString()}`
          : saved.compactionThresholdTokens.toLocaleString()} tokens。`);
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
    <p className="helper-text">按工作空间生效，只影响后续对话。</p>

    {loading && settings === null && <p role="status" data-testid="memory-settings-loading">正在读取记忆设置…</p>}
    {error !== null && <div className="action-error" role="alert" data-testid="memory-settings-error">
      <p>记忆设置读取失败：{error}</p>
      <Button variant="secondary" disabled={loading} onClick={() => void read()}>重新读取</Button>
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
            <span className="helper-text">自动召回最多 3 条当前有效记忆（全局与本项目）；关闭后不再召回，旧摘要与答复也不会被复用。</span>
          </span>
        </label>
        <label className="memory-settings-switch">
          <input type="checkbox" data-testid="memory-settings-compaction" checked={draft.automaticCompaction}
            disabled={saving} onChange={(event) => {
              setDraft({ ...draft, automaticCompaction: event.target.checked }); setNotice(null);
            }} />
          <span>
            <strong>自动整理会话历史</strong>
            <span className="helper-text">较早历史压成摘要并保留最近原文；关闭后到阈值不再整理，但请求装不下时仍会执行溢出保护压缩。</span>
          </span>
        </label>
        <label className="memory-settings-switch">
          <input type="checkbox" data-testid="memory-settings-auto-capture" checked={draft.autoCapture}
            disabled={saving} onChange={(event) => {
              setDraft({ ...draft, autoCapture: event.target.checked }); setNotice(null);
            }} />
          <span>
            <strong>自动记住有价值的约定</strong>
            <span className="helper-text">系统每轮判断是否沉淀决定、约定或偏好，最多 3 条；来源标为「自动记住」，是模型判断而不是你的确认；关闭后仍可召回已有条目。</span>
          </span>
        </label>
      </div>
      {/* CONTEXT-COMPACTION-0162：阈值与开关分开表达——它决定「什么时候整理」，不决定
          「要不要整理」。推荐区间与默认值都来自服务端，界面不抄常量；保存值高于当前模型
          安全上限时仍会保存，生效值在会话的上下文面板里按真实窗口收敛并说明。 */}
      <FormField label="自动压缩阈值（tokens）" htmlFor="memory-settings-threshold"
        hint={`默认 ${settings.compactionThresholdDefaultTokens.toLocaleString()}；推荐 `
          + `${settings.compactionThresholdRecommended.min.toLocaleString()}–`
          + `${settings.compactionThresholdRecommended.max.toLocaleString()}（仅作提示，可按模型调整）。`
          + "留空即使用默认阈值。"}
        error={thresholdError ?? undefined} testId="memory-settings-threshold-field">
        <Input id="memory-settings-threshold" data-testid="memory-settings-threshold"
          type="text" inputMode="numeric" autoComplete="off" value={thresholdText}
          disabled={saving} placeholder={`${settings.compactionThresholdDefaultTokens.toLocaleString()}（默认）`}
          onChange={(event) => changeThreshold(event.target.value)} />
      </FormField>
      <div className="memory-settings-actions">
        <Button variant="secondary" data-testid="memory-settings-threshold-default"
          disabled={saving || draft.compactionThresholdTokens === null}
          onClick={() => changeThreshold("")}>
          恢复默认（{settings.compactionThresholdDefaultTokens.toLocaleString()}）
        </Button>
      </div>
      <p className="helper-text" data-testid="memory-settings-revision">当前修订 v{settings.revision}</p>
      <div className="memory-settings-actions">
        <Button variant="primary" data-testid="memory-settings-save"
          disabled={saving || !dirty || thresholdError !== null} onClick={() => void save({ commandId: createCommandId(),
            expectedRevision: settings.revision, draft })}>{saving ? "正在保存" : "保存设置"}</Button>
        <Button variant="secondary" data-testid="memory-settings-reload"
          disabled={saving || loading} onClick={() => void read()}>重新读取</Button>
      </div>
      {conflict !== null && <div className="action-error" role="alert" data-testid="memory-settings-conflict">
        <p>保存冲突：{conflict}</p>
        <p className="helper-text">已重读最新设置，改动仍保留在开关上；核对后再保存或丢弃。</p>
        <div className="memory-settings-actions">
          <Button variant="secondary" data-testid="memory-settings-conflict-save"
            disabled={saving} onClick={() => void save({ commandId: createCommandId(),
              expectedRevision: settings.revision, draft })}>按最新修订保存</Button>
          <Button variant="secondary" data-testid="memory-settings-conflict-discard"
            disabled={saving} onClick={() => void read()}>丢弃改动并重读</Button>
        </div>
      </div>}
      {notice !== null && <p className="receipt-message" role="status" data-testid="memory-settings-notice">{notice}</p>}
      {pending !== null && <div className="action-error" role="alert" data-testid="memory-settings-pending">
        <p>保存结果待核对：{pending.reason}</p>
        <p className="helper-text">原 command_id：{pending.commandId}。先查回执；查不到时只能用同一命令与同一载荷重试，不换新 ID。</p>
        <div className="memory-settings-actions">
          <Button variant="secondary" data-testid="memory-settings-receipt"
            disabled={checking} onClick={() => void checkReceipt()}>{checking ? "正在查询" : "查询原命令回执"}</Button>
          <Button variant="secondary" data-testid="memory-settings-retry"
            disabled={saving || checking} onClick={() => void save(pending)}>按原命令重试</Button>
        </div>
      </div>}
    </>}
    <p className="helper-text">记忆不替代业务事实：摘要与召回内容只是模型上下文，不能据此判定任务完成、验收通过或权限已授予。</p>
  </section>;
}

/**
 * 阈值输入：空串 = 使用默认；允许千分位逗号与首尾空格；其余只接受正整数。
 *
 * 不在前端判断精确边界：那是服务端的产品口径，抄一份到界面只会让两处逐渐分叉。
 * 这里只挡掉「明显不是数字」的输入，让保存键不至于发出无效请求。
 */
function parseThresholdText(text: string): { readonly kind: "empty" }
| { readonly kind: "value"; readonly value: number }
| { readonly kind: "invalid" } {
  const trimmed = text.replace(/[,\s_]/gu, "");
  if (trimmed === "") return { kind: "empty" };
  if (!/^[1-9][0-9]*$/u.test(trimmed)) return { kind: "invalid" };
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? { kind: "value", value } : { kind: "invalid" };
}
