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
    retrievalMode: settings.retrievalMode === "HYBRID" ? "HYBRID" : DEFAULTS.retrievalMode,
    autoConsolidate: settings.autoConsolidate ?? DEFAULTS.autoConsolidate,
    consolidationIntervalHours: String(settings.consolidationIntervalHours ?? DEFAULTS.consolidationIntervalHours),
    memoryStaleAfterDays: String(settings.memoryStaleAfterDays ?? DEFAULTS.memoryStaleAfterDays),
    // 未实现的能力不把历史配置带进可提交草稿：保存一次就收敛到真实可用状态。
    embeddingProvider: "disabled",
    remoteEmbeddingAllowed: false,
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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
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
    if (draft.retrievalMode === "HYBRID") {
      setError("HYBRID 混合检索尚未实现，不能保存为当前检索模式；请先选择「字面/全文」。"); return;
    }
    if (draft.embeddingProvider !== "disabled" || draft.remoteEmbeddingAllowed) {
      setError("Embedding 与远程正文发送尚未实现；请保持禁用，避免把未实现能力当成可用。"); return;
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

  return <section className="surface-panel settings-card" data-testid="memory-advanced-settings">
    <h2>召回、整理与隐私</h2>
    <p className="helper-text">按工作空间生效；所有数值都会真实保存并在下一次召回/整理时生效。</p>
    {settings?.capabilities !== undefined && <div className="memory-capabilities" data-testid="memory-capabilities">
      <p><strong>能力状态（来自服务端）</strong></p>
      <ul>
        <li>字面/全文检索：{settings.capabilities.retrieval.literal.implemented ? "已实现" : "未实现"} · {settings.capabilities.retrieval.literal.note}</li>
        <li>混合检索 HYBRID：{settings.capabilities.retrieval.hybrid.implemented ? "已实现" : "未实现"} · {settings.capabilities.retrieval.hybrid.note}</li>
        <li>Embedding：{settings.capabilities.embedding.implemented ? "已实现" : "未实现"} · {settings.capabilities.embedding.note}</li>
        <li>捕获任务：{settings.capabilities.capture.persistentTasks ? "持久化" : "未持久化"} ·
          重试退避 {settings.capabilities.capture.retryWithBackoff ? "有" : "无"} ·
          压缩前屏障 {settings.capabilities.capture.preCompactionBarrier ? "有" : "无"} ·
          明确记住 {settings.capabilities.capture.explicitRemember ? "有" : "无"}</li>
      </ul>
    </div>}
    {settings?.retrievalMode === "HYBRID" && <Alert tone="warning" title="旧 HYBRID 配置未实现">
      <p>服务端仍能读出历史 HYBRID 标记，但当前没有向量检索实现；保存时请选择「字面/全文」，否则保存会被拒绝。</p>
    </Alert>}
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
        <FormField label="检索模式" hint="HYBRID 尚未实现；当前只提供真实可用的字面/全文检索。">
          <Select value={draft.retrievalMode} onChange={(event) =>
            setDraft({ ...draft, retrievalMode: event.target.value as Draft["retrievalMode"] })}>
            <option value="LITERAL">字面/全文</option>
            <option value="HYBRID" disabled>混合（未实现，不可选）</option>
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
        <FormField label="Embedding Provider" hint="尚未实现；保持禁用，不会展示成可用能力。">
          <Select value={draft.embeddingProvider} onChange={(event) =>
            setDraft({ ...draft, embeddingProvider: event.target.value as Draft["embeddingProvider"] })}>
            <option value="disabled">禁用（仅字面检索）</option>
            <option value="openai-compatible" disabled>OpenAI 兼容（未实现，不可选）</option>
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
          <input type="checkbox" checked={draft.remoteEmbeddingAllowed} disabled
            onChange={(event) => setDraft({ ...draft, remoteEmbeddingAllowed: event.target.checked })} />
          <span><strong>允许把记忆正文发送到远程 Embedding</strong>
            <span className="helper-text">未实现：没有真实远程 Provider，也不会把正文发出去；本项保持关闭。</span></span>
        </label>
      </div>
      {numericError !== null && <p className="field-error" role="alert">{numericError}</p>}
      <div className="memory-settings-actions">
        <Button variant="primary" disabled={saving || !dirty || numericError !== null}
          onClick={() => void save()}>{saving ? "正在保存" : "保存召回设置"}</Button>
        <Button variant="secondary" disabled={saving} onClick={() => void read()}>重新读取</Button>
      </div>
      {conflict !== null && <Alert tone="warning" title="设置已在别处修改">
        <p>{conflict}</p><p className="helper-text">已重读最新设置，未保存的改动仍在表单上；核对后重存。</p>
      </Alert>}
      {notice !== null && <p className="receipt-message" role="status">{notice}</p>}
      <p className="helper-text">当前修订 v{settings.revision}。检索失败或记忆模块异常不会阻断聊天；失败会记录日志并返回空召回。</p>
    </>}
  </section>;
}
