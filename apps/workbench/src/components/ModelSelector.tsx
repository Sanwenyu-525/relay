import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { RelayApiClient, RelayCatalogModel, RelayModelCatalog } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { useMenuExclusive } from "../lib/popoverMenu";

/**
 * 选择只提交给既有发送/命令 Owner；这里不另建幂等或回执状态。
 * 形态是锚定在触发键上方的下拉清单（与输入框「+」菜单同一套弹层语言），不是居中弹窗：
 * 清单每项只显示模型名，细节（ID、上下文、能力、不可选原因）走 hover 的 title 与读屏
 * aria-label；触发器显示当前具体模型名，而不是「模型」二字。
 * 点条目即按既有模型选择命令应用并收起（工作台 §27.5 的 2026-10-17 指令），
 * 所以这里不再有「先选再按确认键」的第二步。
 */

/** 清单条目：来源未知（如会话选择已不在目录）时能力未知，只能按 ID 核对。 */
interface ModelEntry {
  readonly id: string;
  readonly name: string;
  readonly model: RelayCatalogModel | null;
  readonly group: "当前选择" | "已配置模型" | "免费模型 · OpenRouter";
  readonly selectable: boolean;
  readonly note: string | null;
}

function entryTitle(entry: ModelEntry): string {
  const parts = [`${entry.name} · ${entry.id}`];
  if (entry.model !== null) {
    parts.push(`上下文：${entry.model.contextWindow?.toLocaleString() ?? "未知"}`);
    parts.push(`工具：${entry.model.tools === null ? "未知" : entry.model.tools ? "支持" : "不支持"}`);
  } else {
    parts.push("目录能力未知");
  }
  parts.push("目录声明与实际调用结果分别核验。");
  if (entry.note !== null) parts.push(entry.note);
  return parts.join(" · ");
}

export default function ModelSelector({ client, open, onOpenChange, selectedModel, onChoose, disabled = false,
  firstMessage = false, sessionId }: {
  client: RelayApiClient; open: boolean; onOpenChange: (open: boolean) => void;
  selectedModel: string | null; onChoose: (model: string) => void;
  disabled?: boolean; firstMessage?: boolean;
  sessionId?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [catalog, setCatalog] = useState<RelayModelCatalog | null>(null);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [choice, setChoice] = useState("");
  const [query, setQuery] = useState("");
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readWarnings, setReadWarnings] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  // 刷新进行中不收下拉（否则「目录已更新」的回执会在用户眼前消失）；独占关值时读 ref 取最新。
  const refreshingRef = useRef(false);
  refreshingRef.current = refreshing;
  // 打开别的浮层（「+」菜单、档位菜单）时收起本下拉：输入器工具行上的多个 chip 弹层
  // 不允许同时打开互相压。自身的外部按下与 Esc 由下面那个 effect 负责。
  useMenuExclusive(open, () => { if (!refreshingRef.current) onOpenChange(false); });
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true); setError(null); setReadWarnings([]); setNotice(null); setQuery("");
    // 服务端 GET 负责打开时的 TTL 检查；浏览器不直接访问服务商。
    void Promise.allSettled([client.getModelCatalog(), client.getModelPortStatus(),
      sessionId === undefined ? Promise.resolve(null) : client.getSessionModelSelection(sessionId)]).then(([directoryResult, statusResult, selectionResult]) => {
      if (!active) return;
      if (selectionResult.status === "rejected") throw selectionResult.reason;
      const selection = selectionResult.value;
      const configuredDefault = statusResult.status === "fulfilled" && statusResult.value.configured
        ? statusResult.value.model : null;
      setCatalog(directoryResult.status === "fulfilled" ? directoryResult.value : null);
      setDefaultModel(configuredDefault);
      setReadWarnings([
        ...(directoryResult.status === "rejected" ? [`免费目录读取失败：${describeLiveError(directoryResult.reason).message}`] : []),
        ...(statusResult.status === "rejected" ? [`应用默认配置读取失败：${describeLiveError(statusResult.reason).message}`] : []),
      ]);
      // 目录变化不自动选第一个，也不替换原首选。
      const current = sessionId === undefined ? selectedModel : selection?.model ?? null;
      setCurrentModel(current ?? configuredDefault);
      setChoice(current ?? configuredDefault ?? "");
    }).catch((caught) => { if (active) setError(describeLiveError(caught).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, open, selectedModel, sessionId, retry]);

  /**
   * 下拉的收起语义：点清单外一次即收；Esc 收并把焦点还给触发键。
   * 刷新进行中不收——否则「目录已更新／暂未更新」的回执会在用户眼前消失（沿用原弹窗同一守卫）。
   */
  useEffect(() => {
    if (!open) return;
    function close(): void {
      if (refreshing) return;
      onOpenChange(false);
      triggerRef.current?.focus();
    }
    function onPointerDown(event: PointerEvent): void {
      if (rootRef.current?.contains(event.target as Node) ?? false) return;
      close();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, refreshing, onOpenChange]);

  async function refresh() {
    setRefreshing(true); setError(null); setNotice(null);
    try {
      const result = await client.refreshModelCatalog();
      const directory = await client.getModelCatalog();
      setCatalog(directory);
      setNotice(result.status === "PUBLISHED" ? "目录已更新。"
        : result.status === "SKIPPED" ? "目录暂未更新，请稍后再试。"
          : `目录更新未成功${result.reason ? `：${result.reason}` : ""}，保留最近成功目录。`);
    } catch (caught) { setReadWarnings([describeLiveError(caught).message]); }
    finally { setRefreshing(false); }
  }
  const visibleModels = catalog?.models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  /**
   * 「可调用」只有一份判据：条目不可选就画成禁用，点下去也不会发命令。
   * 目录过期、凭据未配置、非文本输入输出模型都在这里收口，应用默认始终可选。
   */
  const callable = (model: RelayCatalogModel | null): boolean => Boolean(catalog?.configured && catalog.chatConfigured &&
    !catalog.cacheStale && model !== null && model.textInput === true && model.textOutput === true);
  /** 条目按身份分段：当前选择（即使已不在目录）、应用默认、免费目录；各段去重。 */
  const staleCurrent = currentModel !== null && currentModel !== defaultModel &&
    !catalog?.models.some((model) => model.id === currentModel);
  const directory = catalog?.models ?? [];
  const entries: ModelEntry[] = [];
  if (staleCurrent && currentModel !== null) entries.push({ id: currentModel,
    name: currentModel, model: null, group: "当前选择", selectable: false, note: "已不在目录中，不可继续调用" });
  if (defaultModel !== null) entries.push({ id: defaultModel, name: defaultModel,
    model: directory.find((model) => model.id === defaultModel) ?? null, group: "已配置模型",
    selectable: true, note: "应用默认" });
  for (const model of visibleModels) entries.push({ id: model.id, name: model.name, model,
    group: "免费模型 · OpenRouter", selectable: callable(model),
    note: catalog?.cacheStale ? "目录已过期，仅供浏览" : catalog?.chatConfigured === false ? "调用凭据未配置" : null });
  const groups = "当前选择,已配置模型,免费模型 · OpenRouter".split(",")
    .filter((group) => entries.some((entry) => entry.group === group));
  function chooseEntry(entry: ModelEntry) {
    if (!entry.selectable || disabled || refreshing || error !== null) return;
    setChoice(entry.id);
    onChoose(entry.id);
    onOpenChange(false);
    triggerRef.current?.focus();
  }
  /**
   * 触发器显示当前具体模型名；目录未收录时回落到 ID。ID 只进 title，不占可见面。
   * 首选以父层命令 Owner 的状态为准：点条目应用后父层就是新事实，这里缓存的 currentModel
   * 只是打开时读到的旧值，不能盖在它前面（否则刚应用的名字要等下次打开才显示）。
   */
  const selectedId = selectedModel ?? currentModel;
  const selectedName = catalog?.models.find((model) => model.id === selectedId)?.name ?? selectedId;
  const selectedDetail = selectedId === null ? null
    : selectedName === selectedId ? selectedId : `${selectedName} · ${selectedId}`;
  return <div className="model-selector" ref={rootRef}>
    <button type="button" ref={triggerRef} className="agent-chat-tool model-selector-trigger"
      data-testid="model-selector-open" disabled={disabled}
      aria-label="选择模型" aria-haspopup="listbox" aria-expanded={open} aria-controls="model-selector-list"
      title={selectedDetail === null ? "打开模型选择，核对本会话首选" : `首选模型：${selectedDetail}`}
      onClick={() => onOpenChange(!open)}><span className="model-selector-trigger-name">{selectedName ?? "模型"}</span><ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" /></button>
    {open && <div className="model-selector-menu" data-testid="model-selector-menu">
      <p className="model-selector-note" data-testid="model-selector-current">{loading ? "正在读取模型目录…"
        : error !== null ? error : `当前首选：${currentModel ?? "沿用应用默认"}`}
        {!loading && error === null && <span className="model-selector-note-scope">{firstMessage
          ? " · 发送首条消息时绑定所选模型" : " · 仅影响本会话后续新请求，活动 Run 保留原策略"}</span>}</p>
      {error !== null && <button type="button" className="model-selector-action" disabled={loading || refreshing}
        data-testid="model-selector-retry" onClick={() => setRetry((value) => value + 1)}>重新读取</button>}
      {readWarnings.length > 0 && <p className="model-selector-note" role="alert">{readWarnings.join(" ")}
        <button type="button" className="model-selector-action" disabled={loading || refreshing} onClick={() => setRetry((value) => value + 1)}>重新读取</button></p>}
      {notice !== null && <p className="model-selector-note" role="status">{notice}</p>}
      {!loading && <input type="search" className="model-selector-search" aria-label="筛选模型"
        value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名称或模型 ID" />}
      {!loading && <ul className="model-selector-list" id="model-selector-list" role="listbox" aria-label="可选模型">
        {groups.map((group) => <li key={group} role="group" aria-label={group}><p className="model-selector-group">{group}</p>
          {entries.filter((entry) => entry.group === group).map((entry) => <button key={entry.id} type="button" role="option"
            className="model-selector-option" data-testid={`model-selector-option-${entry.id}`}
            aria-selected={entry.id === choice} disabled={!entry.selectable}
            title={entryTitle(entry)} aria-label={`${entry.name} · ${entry.id}${entry.note === null ? "" : `（${entry.note}）`}`}
            onClick={() => chooseEntry(entry)}>
            <span className="model-selector-option-name">{entry.name}</span>{entry.id === choice && <Check aria-hidden="true" />}</button>)}
        </li>)}
        {catalog !== null && catalog.models.length === 0 && <li className="model-selector-empty">当前没有可选的免费型号。</li>}
      </ul>}
      {!loading && catalog !== null && catalog.models.length > 0 && visibleModels.length === 0 &&
        <p className="model-selector-note">没有匹配的免费模型，请修改搜索。</p>}
      {!loading && <p className="model-selector-foot">
        <span className="model-selector-note">最近成功同步：{catalog?.lastSuccessAt ?? "尚无成功目录"}
          {catalog !== null && (catalog.cacheStale || !catalog.configured || !catalog.chatConfigured || catalog.lastFailureReason !== null) && " · "}{catalog?.cacheStale ? "目录已过期，仅供浏览" : ""}{catalog !== null && !catalog.configured ? "免费目录未启用" : ""}{catalog !== null && !catalog.chatConfigured ? "OpenRouter 调用凭据未配置，免费模型暂不可调用" : ""}{catalog?.lastFailureReason ? `最近同步失败：${catalog.lastFailureReason}，保留上次成功结果` : ""}</span>
        <button type="button" className="model-selector-action" data-testid="model-selector-refresh"
          disabled={refreshing || !catalog?.configured} onClick={() => void refresh()}>{refreshing ? "正在刷新…" : "立即刷新"}</button>
      </p>}
      <p className="model-selector-note">免费分组默认启用有界接续：当前模型额度或上游限流且账户额度仍可用时，最多尝试 3 个合格型号；绝不转收费。账户共享额度耗尽会停止。</p>
    </div>}
  </div>;
}
