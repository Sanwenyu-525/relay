import { useCallback, useEffect, useRef, useState } from "react";
import { createCommandId, RelayTransportError, type RelayApiClient,
  type RelayContextBudgetTokens, type RelayWorkspaceDefaultDirectory } from "../api/relayClient";
import type { DecimalRevision } from "../types";
import { describeLiveError } from "../lib/liveErrors";
import "./ContextBudgetCard.css";

/**
 * 工作区级上下文长度（0135 / 2026-10-24 用户指令「上下文需要三档 256/512/1024，设置页与
 * 输入框圆环都能调」）。
 *
 * 三档就是**单次调用预算** ``max_call_tokens``，不是模型物理窗口，也不新增第二种预算口径。
 * 它和默认写档位共用同一行与同一个修订号：保存必须带读到的 `expected_revision`，409 不覆盖，
 * 重读后由用户决定是否按新修订重存；传输失败保留原 command_id 与载荷，先查回执。
 */

type Tier = RelayContextBudgetTokens | null;

const OPTIONS: readonly { readonly value: Tier; readonly label: string;
  readonly detail: string }[] = [
  { value: null, label: "跟随应用默认", detail: "不指定工作区档位；上限取应用配置的单次预算。" },
  { value: 262144, label: "256K", detail: "适合日常对话与较短的项目上下文。" },
  { value: 524288, label: "512K", detail: "适合需要同时引用多份资料的对话。" },
  { value: 1048576, label: "1M", detail: "适合长文档与跨文件的完整上下文。" },
];

type Pending = { readonly commandId: string; readonly expectedRevision: DecimalRevision;
  readonly budget: Tier; readonly reason: string };

export default function ContextBudgetCard({ client }: { readonly client: RelayApiClient | null }) {
  const [projection, setProjection] = useState<RelayWorkspaceDefaultDirectory | null>(null);
  const [draft, setDraft] = useState<Tier>(null);
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
    if (client === null) { setLoading(false); setProjection(null); return; }
    const request = ++requestVersion.current;
    setLoading(true); setError(null);
    try {
      const next = await client.getWorkspaceDefaultDirectory();
      if (disposed.current || request !== requestVersion.current) return;
      setProjection(next);
      if (!keepDraft) setDraft(next.contextBudgetTokens);
    } catch (caught) {
      if (disposed.current || request !== requestVersion.current) return;
      setError(describeLiveError(caught).message);
    } finally {
      if (!disposed.current && request === requestVersion.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => { void read(); }, [read]);

  const current = projection?.contextBudgetTokens ?? null;
  const dirty = projection !== null && draft !== current;

  async function save(payload: Pending | { commandId: string; expectedRevision: DecimalRevision;
    budget: Tier }): Promise<void> {
    if (client === null) return;
    setSaving(true); setError(null); setNotice(null); setConflict(null);
    try {
      const saved = await client.setWorkspaceContextBudget({ commandId: payload.commandId,
        expectedRevision: payload.expectedRevision, budgetTokens: payload.budget });
      if (disposed.current) return;
      setPending(null);
      setNotice(saved.contextBudgetTokens === null
        ? `已保存（修订 v${saved.revision}）：上下文长度跟随应用默认。`
        : `已保存（修订 v${saved.revision}）：每次模型调用最多携带 ${formatTier(saved.contextBudgetTokens)} tokens。`);
      await read();
    } catch (caught) {
      if (disposed.current) return;
      const described = describeLiveError(caught);
      if (described.kind === "conflict") {
        setConflict(described.message);
        await read(true);
        return;
      }
      if (caught instanceof RelayTransportError) {
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
      if (receipt.commandType !== "SetWorkspaceContextBudget") {
        setError(`原命令回执的类型是 ${receipt.commandType}，不是上下文长度；不能当作本次保存已生效。`);
        return;
      }
      const workspaceId = String(receipt.result.workspace_id ?? "");
      if (workspaceId !== client.workspaceId) {
        setError("原命令回执属于另一个工作空间，不能当作本次保存已生效。");
        return;
      }
      setPending(null);
      setNotice(`原命令回执已核对：上下文长度已保存（修订 v${String(receipt.result.revision ?? "")}）。`);
      await read();
    } catch (caught) {
      if (!disposed.current) setError(`回执尚未核对到：${describeLiveError(caught).message}`);
    } finally { if (!disposed.current) setChecking(false); }
  }

  if (client === null) {
    return <section className="surface-panel settings-card" data-testid="context-budget">
      <h2>上下文长度</h2>
      <p className="helper-text">示例数据预览下没有可读写的工作区配置。</p>
    </section>;
  }

  return <section className="surface-panel settings-card" data-testid="context-budget">
    <h2>上下文长度</h2>
    <p className="helper-text">按工作空间生效，决定每次模型调用最多能携带多少上下文。
      它是单次调用预算，不是模型物理窗口；选择更大的档位不会授予任何写权限，也不改变输出上限。</p>

    {loading && projection === null && <p role="status" data-testid="context-budget-loading">正在读取上下文长度…</p>}
    {error !== null && <div className="action-error" role="alert" data-testid="context-budget-error">
      <p>上下文长度读取失败：{error}</p>
      <button className="secondary-button" type="button" disabled={loading} onClick={() => void read()}>重新读取</button>
    </div>}

    {projection !== null && <>
      <div className="context-budget-options" role="radiogroup" aria-label="上下文长度档位">
        {OPTIONS.map((option) => <label className="context-budget-option" key={option.label}>
          <input type="radio" name="context-budget" data-testid={`context-budget-option-${
            option.value === null ? "default" : option.value}`} checked={draft === option.value}
            disabled={saving} onChange={() => { setDraft(option.value); setNotice(null); }} />
          <span>
            <strong>{option.label}</strong>
            <span className="helper-text">{option.detail}</span>
          </span>
        </label>)}
      </div>
      <p className="helper-text" data-testid="context-budget-revision">当前修订 v{projection.revision}</p>
      <div className="context-budget-actions">
        <button className="primary-button" type="button" data-testid="context-budget-save"
          disabled={saving || !dirty} onClick={() => void save({ commandId: createCommandId(),
            expectedRevision: projection.revision, budget: draft })}>{saving ? "正在保存" : "保存上下文长度"}</button>
        <button className="secondary-button" type="button" data-testid="context-budget-reload"
          disabled={saving || loading} onClick={() => void read()}>重新读取</button>
      </div>
      {conflict !== null && <div className="action-error" role="alert" data-testid="context-budget-conflict">
        <p>保存冲突：{conflict}</p>
        <p className="helper-text">已重新读取最新修订，你的选择仍保留。请核对后再保存一次，或丢弃改动。</p>
        <div className="context-budget-actions">
          <button className="secondary-button" type="button" data-testid="context-budget-conflict-save"
            disabled={saving} onClick={() => void save({ commandId: createCommandId(),
              expectedRevision: projection.revision, budget: draft })}>按最新修订保存</button>
          <button className="secondary-button" type="button" data-testid="context-budget-conflict-discard"
            disabled={saving} onClick={() => void read()}>丢弃改动并重读</button>
        </div>
      </div>}
      {notice !== null && <p className="receipt-message" role="status" data-testid="context-budget-notice">{notice}</p>}
      {pending !== null && <div className="action-error" role="alert" data-testid="context-budget-pending">
        <p>保存结果待核对：{pending.reason}</p>
        <p className="helper-text">原 command_id：{pending.commandId}。先查回执；查不到时只能用同一命令与同一档位重试，不换新 ID。</p>
        <div className="context-budget-actions">
          <button className="secondary-button" type="button" data-testid="context-budget-receipt"
            disabled={checking} onClick={() => void checkReceipt()}>{checking ? "正在查询" : "查询原命令回执"}</button>
          <button className="secondary-button" type="button" data-testid="context-budget-retry"
            disabled={saving || checking} onClick={() => void save(pending)}>按原命令重试</button>
        </div>
      </div>}
    </>}
  </section>;
}

function formatTier(tier: RelayContextBudgetTokens): string {
  return tier.toLocaleString("zh-CN");
}
