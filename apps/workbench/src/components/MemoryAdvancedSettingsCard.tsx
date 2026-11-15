import { useCallback, useEffect, useRef, useState } from "react";
import {
  createCommandId, RelayTransportError, type RelayApiClient, type RelayMemorySettings
} from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { Alert, Button, FormField, Input, Select } from "../ui";
import "./MemorySettingsCard.css";

/**
 * 0164：召回预算、检索模式、整理与隐私设置。
 *
 * 与 `MemorySettingsCard` 分开只为降低单卡复杂度；两者写同一行设置，服务端按整行 CAS，
 * 后保存者遇到 409 会重读并提示按最新修订重存，不静默覆盖。所有参数都真实持久化。
 */

interface Draft {
  readonly recallEnabled: boolean;
  readonly automaticCompaction: boolean;
  readonly autoCapture: boolean;
  readonly compactionThresholdTokens: number | null;
  readonly coreTokenBudget: string;
  readonly retrievalTokenBudget: string;
  readonly retrievalTopK: string;
  readonly retrievalMode: "LITERAL" | "HYBRID";
  readonly autoConsolidate: boolean;
  readonly consolidationIntervalHours: string;
  readonly memoryStaleAfterDays: string;
  readonly embeddingProvider: "disabled" | "openai-compatible";
  readonly remoteEmbeddingAllowed: boolean;
  readonly includeStaleInRecall: boolean;
}

const DEFAULTS = {
  coreTokenBudget: 2000, retrievalTokenBudget: 3000, retrievalTopK: 5,
  retrievalMode: "LITERAL" as const, autoConsolidate: true, consolidationIntervalHours: 24,
  memoryStaleAfterDays: 180, embeddingProvider: "disabled" as const,
  remoteEmbeddingAllowed: false, includeStaleInRecall: false,
};

function draftFrom(settings: RelayMemorySettings): Draft {
  return {
    recallEnabled: settings.recallEnabled,
    automaticCompaction: settings.automaticCompaction,
    autoCapture: settings.autoCapture,
    compactionThresholdTokens: settings.compactionThresholdTokens,
    coreTokenBudget: String(settings.coreTokenBudget ?? DEFAULTS.coreTokenBudget),
    retrievalTokenBudget: String(settings.retrievalTokenBudget ?? DEFAULTS.retrievalTokenBudget),
    retrievalTopK: String(settings.retrievalTopK ?? DEFAULTS.retrievalTopK),
    retrievalMode: settings.retrievalMode ?? DEFAULTS.retrievalMode,
    autoConsolidate: settings.autoConsolidate ?? DEFAULTS.autoConsolidate,
    consolidationIntervalHours: String(settings.consolidationIntervalHours ?? DEFAULTS.consolidationIntervalHours),
    memoryStaleAfterDays: String(settings.memoryStaleAfterDays ?? DEFAULTS.memoryStaleAfterDays),
    embeddingProvider: settings.embeddingProvider ?? DEFAULTS.embeddingProvider,
    remoteEmbeddingAllowed: settings.remoteEmbeddingAllowed ?? DEFAULTS.remoteEmbeddingAllowed,
    includeStaleInRecall: settings.includeStaleInRecall ?? DEFAULTS.includeStaleInRecall,
  };
}

function positive(value: string): number | null {
  const text = value.replace(/[,\s_]/gu, "");
  if (!/^[1-9][0-9]*$/u.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

export default function MemoryAdvancedSettingsCard({ client }: {
  readonly client: RelayApiClient | null;
}) {
  const [settings, setSettings] = useState<RelayMemorySettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [purgeText, setPurgeText] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const disposed = useRef(false);
  const requestVersion = useRef(0);

  useEffect(() => () => { disposed.current = true; requestVersion.current += 1; }, []);

  const read = useCallback(async (keepDraft = false) => {
    if (client === null) { setLoading(false); return; }
    const request = ++requestVersion.current;
    setLoading(true); setError(null);
    try {
      const next = await client.getMemorySettings();
      if (disposed.current || request !== requestVersion.current) return;
      setSettings(next);
      if (!keepDraft) setDraft(draftFrom(next));
    } catch (caught) {
      if (!disposed.current && request === requestVersion.current) setError(describeLiveError(caught).message);
    } finally {
      if (!disposed.current && request === requestVersion.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    setSettings(null); setDraft(null); setNotice(null); setError(null); setConflict(null);
    void read();
  }, [read]);

  if (client === null) {
    return <section className="surface-panel settings-card" data-testid="memory-advanced-settings">
      <h2>召回、整理与隐私</h2>
      <p className="helper-text">示例数据预览下没有可读写的记忆设置。</p>
    </section>;
  }

  const numbers = draft === null ? null : {
    core: positive(draft.coreTokenBudget), retrieval: positive(draft.retrievalTokenBudget),
    topK: positive(draft.retrievalTopK), interval: positive(draft.consolidationIntervalHours),
    stale: positive(draft.memoryStaleAfterDays),
  };
  const numericError = numbers === null ? null
    : numbers.core === null ? "核心预算需要正整数 tokens。"
    : numbers.retrieval === null ? "检索预算需要正整数 tokens。"
    : numbers.topK === null ? "候选条数需要正整数。"
    : numbers.interval === null ? "整理间隔需要正整数小时。"
    : numbers.stale === null ? "陈旧阈值需要正整数天。" : null;

  const dirty = settings !== null && draft !== null && (
    draft.coreTokenBudget !== String(settings.coreTokenBudget ?? DEFAULTS.coreTokenBudget) ||
    draft.retrievalTokenBudget !== String(settings.retrievalTokenBudget ?? DEFAULTS.retrievalTokenBudget) ||
    draft.retrievalTopK !== String(settings.retrievalTopK ?? DEFAULTS.retrievalTopK) ||
    draft.retrievalMode !== (settings.retrievalMode ?? DEFAULTS.retrievalMode) ||
    draft.autoConsolidate !== (settings.autoConsolidate ?? DEFAULTS.autoConsolidate) ||
    draft.consolidationIntervalHours !== String(settings.consolidationIntervalHours ?? DEFAULTS.consolidationIntervalHours) ||
    draft.memoryStaleAfterDays !== String(settings.memoryStaleAfterDays ?? DEFAULTS.memoryStaleAfterDays) ||
    draft.embeddingProvider !== (settings.embeddingProvider ?? DEFAULTS.embeddingProvider) ||
    draft.remoteEmbeddingAllowed !== (settings.remoteEmbeddingAllowed ?? DEFAULTS.remoteEmbeddingAllowed) ||
    draft.includeStaleInRecall !== (settings.includeStaleInRecall ?? DEFAULTS.includeStaleInRecall)
  );

  async function save(): Promise<void> {
    if (draft === null || settings === null || numbers === null || numericError !== null) {
      setError(numericError ?? "设置尚未读取完成。"); return;
    }
    if (numbers.core === null || numbers.retrieval === null || numbers.topK === null ||
        numbers.interval === null || numbers.stale === null) return;
    setSaving(true); setError(null); setNotice(null); setConflict(null);
    try {
      const saved = await client!.saveMemorySettings({
        commandId: createCommandId(), expectedRevision: settings.revision,
        recallEnabled: draft.recallEnabled, automaticCompaction: draft.automaticCompaction,
        autoCapture: draft.autoCapture, compactionThresholdTokens: draft.compactionThresholdTokens,
        coreTokenBudget: numbers.core, retrievalTokenBudget: numbers.retrieval,
        retrievalTopK: numbers.topK, retrievalMode: draft.retrievalMode,
        autoConsolidate: draft.autoConsolidate, consolidationIntervalHours: numbers.interval,
        memoryStaleAfterDays: numbers.stale, embeddingProvider: draft.embeddingProvider,
        remoteEmbeddingAllowed: draft.remoteEmbeddingAllowed,
        includeStaleInRecall: draft.includeStaleInRecall,
      });
      if (disposed.current) return;
      setSettings(saved); setDraft(draftFrom(saved));
      setNotice(`已保存（修订 v${saved.revision}）：核心预算 ${saved.coreTokenBudget ?? numbers.core}，`
        + `检索预算 ${saved.retrievalTokenBudget ?? numbers.retrieval}，候选 ${saved.retrievalTopK ?? numbers.topK} 条，`
        + `模式 ${saved.retrievalMode ?? draft.retrievalMode}。`);
    } catch (caught) {
      if (disposed.current) return;
      const described = describeLiveError(caught);
      if (described.kind === "conflict") {
        setConflict(described.message);
        await read(true);
        return;
      }
      if (caught instanceof RelayTransportError) {
        setError(`${described.message} 命令可能已提交，请刷新或按原命令核对。`);
        return;
      }
      setError(described.message);
    } finally { if (!disposed.current) setSaving(false); }
  }

  async function run(label: string, action: () => Promise<void>): Promise<void> {
    setBusy(label); setError(null); setNotice(null);
    try { await action(); }
    catch (caught) { if (!disposed.current) setError(describeLiveError(caught).message); }
    finally { if (!disposed.current) setBusy(null); }
  }

  async function consolidate(): Promise<void> {
    await run("consolidate", async () => {
      const result = await client!.runMemoryConsolidation(createCommandId());
      setNotice(`整理完成：${String(result.result.status ?? "")}，去重 ${String(result.result.deduped ?? 0)} 条，`
        + `替代 ${String(result.result.superseded ?? 0)} 条，标记陈旧 ${String(result.result.stale ?? 0)} 条。`);
      await read();
    });
  }

  async function exportAll(): Promise<void> {
    await run("export", async () => {
      const payload = await client!.exportMemories();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = "relay-memories.json"; anchor.click();
      URL.revokeObjectURL(url);
      setNotice("已导出工作空间可导出记忆。");
    });
  }

  async function importFile(file: File): Promise<void> {
    await run("import", async () => {
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(await file.text()) as Record<string, unknown>; }
      catch { throw new Error("导入文件不是合法 JSON。"); }
      const result = await client!.importMemories({ commandId: createCommandId(), projectId: null, payload });
      setNotice(`导入完成：新增 ${String(result.result.imported ?? 0)} 条，跳过 ${String(result.result.skipped ?? 0)} 条。`);
      await read();
    });
  }

  async function purge(): Promise<void> {
    if (purgeText !== "DELETE_MEMORIES") return;
    await run("purge", async () => {
      const result = await client!.purgeMemories({ commandId: createCommandId(), projectId: null,
        includeActive: false });
      setConfirmPurge(false); setPurgeText("");
      setNotice(`已真实删除 ${String(result.result.deleted ?? "0")} 条已停用/已过期记忆。`);
      await read();
    });
  }

  return <section className="surface-panel settings-card" data-testid="memory-advanced-settings">
    <h2>召回、整理与隐私</h2>
    <p className="helper-text">按工作空间生效；所有数值都会真实保存并在下一次召回/整理时生效。</p>
    {loading && settings === null && <p role="status">正在读取召回设置…</p>}
    {error !== null && <Alert tone="danger" title="操作未完成"><p>{error}</p>
      <Button variant="secondary" onClick={() => void read()}>重新读取</Button></Alert>}
    {settings !== null && draft !== null && <>
      <div className="memory-settings-grid">
        <FormField label="核心记忆常驻预算（tokens）" hint="固定记忆优先占用；默认 2,000。"
          error={numbers?.core === null ? numericError ?? undefined : undefined}>
          <Input inputMode="numeric" value={draft.coreTokenBudget}
            onChange={(event) => setDraft({ ...draft, coreTokenBudget: event.target.value })} />
        </FormField>
        <FormField label="单次检索预算（tokens）" hint="普通召回命中使用；默认 3,000。"
          error={numbers?.retrieval === null ? numericError ?? undefined : undefined}>
          <Input inputMode="numeric" value={draft.retrievalTokenBudget}
            onChange={(event) => setDraft({ ...draft, retrievalTokenBudget: event.target.value })} />
        </FormField>
        <FormField label="单次召回候选条数" hint="1–20；默认 5。">
          <Input inputMode="numeric" value={draft.retrievalTopK}
            onChange={(event) => setDraft({ ...draft, retrievalTopK: event.target.value })} />
        </FormField>
        <FormField label="检索模式" hint="HYBRID 在没有真实 Embedding Provider 时会记录降级并退回字面检索。">
          <Select value={draft.retrievalMode} onChange={(event) =>
            setDraft({ ...draft, retrievalMode: event.target.value as Draft["retrievalMode"] })}>
            <option value="LITERAL">字面/全文</option>
            <option value="HYBRID">混合（可降级）</option>
          </Select>
        </FormField>
        <FormField label="自动整理间隔（小时）" hint="Worker 每拍最多处理一个到期工作区。">
          <Input inputMode="numeric" value={draft.consolidationIntervalHours}
            onChange={(event) => setDraft({ ...draft, consolidationIntervalHours: event.target.value })} />
        </FormField>
        <FormField label="陈旧阈值（天）" hint="仅项目事实与经验，非固定；默认 180。">
          <Input inputMode="numeric" value={draft.memoryStaleAfterDays}
            onChange={(event) => setDraft({ ...draft, memoryStaleAfterDays: event.target.value })} />
        </FormField>
        <FormField label="Embedding Provider" hint="当前只有真实适配器可用时才选择；否则保持 disabled。">
          <Select value={draft.embeddingProvider} onChange={(event) =>
            setDraft({ ...draft, embeddingProvider: event.target.value as Draft["embeddingProvider"] })}>
            <option value="disabled">禁用（仅字面检索）</option>
            <option value="openai-compatible">OpenAI 兼容</option>
          </Select>
        </FormField>
      </div>
      <div className="memory-settings-switches">
        <label className="memory-settings-switch">
          <input type="checkbox" checked={draft.autoConsolidate}
            onChange={(event) => setDraft({ ...draft, autoConsolidate: event.target.checked })} />
          <span><strong>自动整理</strong><span className="helper-text">确定性去重、替换与陈旧标记，不调用模型，不生成新事实。</span></span>
        </label>
        <label className="memory-settings-switch">
          <input type="checkbox" checked={draft.includeStaleInRecall}
            onChange={(event) => setDraft({ ...draft, includeStaleInRecall: event.target.checked })} />
          <span><strong>召回时包含「可能过时」</strong><span className="helper-text">默认关闭；开启后仍会标注状态，不当作当前事实。</span></span>
        </label>
        <label className="memory-settings-switch">
          <input type="checkbox" checked={draft.remoteEmbeddingAllowed}
            disabled={draft.embeddingProvider === "disabled"}
            onChange={(event) => setDraft({ ...draft, remoteEmbeddingAllowed: event.target.checked })} />
          <span><strong>允许把记忆正文发送到远程 Embedding</strong>
            <span className="helper-text">隐私开关；关闭时即使选择 Provider 也不会外发正文。</span></span>
        </label>
      </div>
      {numericError !== null && <p className="field-error" role="alert">{numericError}</p>}
      <div className="memory-settings-actions">
        <Button variant="primary" disabled={saving || !dirty || numericError !== null}
          onClick={() => void save()}>{saving ? "正在保存" : "保存召回设置"}</Button>
        <Button variant="secondary" disabled={saving} onClick={() => void read()}>重新读取</Button>
        <Button variant="secondary" disabled={busy !== null} onClick={() => void consolidate()}>立即整理</Button>
        <Button variant="secondary" disabled={busy !== null} onClick={() => void exportAll()}>导出</Button>
        <Button variant="secondary" disabled={busy !== null} onClick={() => importRef.current?.click()}>导入</Button>
        <Button variant="danger" disabled={busy !== null} onClick={() => setConfirmPurge(!confirmPurge)}>清理失效项</Button>
      </div>
      <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file !== undefined) void importFile(file);
      }} />
      {confirmPurge && <div className="memory-settings-actions">
        <FormField label="输入 DELETE_MEMORIES 确认真实删除已停用/已过期记忆">
          <Input value={purgeText} autoComplete="off" onChange={(event) => setPurgeText(event.target.value)} />
        </FormField>
        <Button variant="danger" disabled={purgeText !== "DELETE_MEMORIES" || busy !== null}
          onClick={() => void purge()}>{busy === "purge" ? "正在删除" : "确认删除"}</Button>
      </div>}
      {conflict !== null && <Alert tone="warning" title="设置已在别处修改">
        <p>{conflict}</p><p className="helper-text">已重读最新设置，未保存的改动仍在表单上；核对后重存。</p>
      </Alert>}
      {notice !== null && <p className="receipt-message" role="status">{notice}</p>}
      <p className="helper-text">当前修订 v{settings.revision}。检索失败或记忆模块异常不会阻断聊天；失败会记录日志并返回空召回。</p>
    </>}
  </section>;
}
