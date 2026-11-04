import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { RelayApiClient, RelayCatalogModel, RelayModelCatalog } from "../api/relayClient";
import type { RelayModelConnection } from "../api/dtos/information";
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
  /** 选择按目录型号还是按已登记连接提交：两者身份不同，不能只凭型号文本互认。 */
  readonly kind: "model" | "connection";
  readonly id: string;
  readonly name: string;
  readonly model: RelayCatalogModel | null;
  readonly connection: RelayModelConnection | null;
  readonly group: "当前选择" | "已配置模型" | "已登记连接" | "免费模型 · OpenRouter";
  readonly selectable: boolean;
  readonly note: string | null;
}

function entryTitle(entry: ModelEntry): string {
  if (entry.connection !== null) {
    const parts = [`${entry.connection.name} · ${entry.connection.id}`,
      `型号：${entry.connection.defaultModel}`,
      `状态：${entry.connection.status === "ACTIVE" ? "已启用" : "已停用"}`];
    if (entry.model !== null) {
      parts.push(`上下文：${entry.model.contextWindow?.toLocaleString() ?? "未知"}`);
      parts.push(`工具：${entry.model.tools === null ? "未知" : entry.model.tools ? "支持" : "不支持"}`);
    }
    parts.push("选择后按这条连接当前声明的型号与端点调用；验证状态以设置页为准。");
    if (entry.note !== null) parts.push(entry.note);
    return parts.join(" · ");
  }
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
  sessionId, selectedConnectionId = null, onChooseConnection, switching = false }: {
  client: RelayApiClient; open: boolean; onOpenChange: (open: boolean) => void;
  selectedModel: string | null; onChoose: (model: string) => void;
  disabled?: boolean;
  /** 会话模型选择命令在途：只换触发器右端指示，不弹窗、不改 chip 宽度。 */
  switching?: boolean;
  sessionId?: string;
  /** 会话当前选中的已登记连接：清单用它标记唯一选中项，不拿型号猜身份。 */
  selectedConnectionId?: string | null;
  /**
   * 提供这个回调才读取并展示「已登记连接」分组。选择按稳定 connection_id 提交，
   * 与免费目录的型号选择互斥：连接自带端点/预算/凭据，不能混成「连接 A 跑型号 B」。
   */
  onChooseConnection?: (connection: RelayModelConnection) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [catalog, setCatalog] = useState<RelayModelCatalog | null>(null);
  const [connections, setConnections] = useState<readonly RelayModelConnection[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [choice, setChoice] = useState("");
  const [query, setQuery] = useState("");
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [currentConnectionId, setCurrentConnectionId] = useState<string | null>(null);
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
  // 挂载即读应用默认（2026-10-21 用户指令「记住上一次选择的模型，不要每个会话都先显示
  // 『模型』两个字」）：没有显式选择的会话（服务端 model-selection 为空）与新对话（本机
  // 偏好为空）都沿用应用默认，芯片要显示这个具体型号而不是占位文案。打开下拉时下面的
  // effect 会再读一次并覆盖同一个 state；读取失败保持 null，芯片退回占位但不谎报型号。
  useEffect(() => {
    if (client === null) return;
    let active = true;
    void client.getModelPortStatus().then((status) => {
      if (active) setDefaultModel(status.configured ? status.model : null);
    }).catch(() => { /* 读取失败不占地：保持 null，打开下拉时再读一次。 */ });
    return () => { active = false; };
  }, [client]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true); setError(null); setReadWarnings([]); setNotice(null); setQuery("");
    // 服务端 GET 负责打开时的 TTL 检查；浏览器不直接访问服务商。
    void Promise.allSettled([client.getModelCatalog(), client.getModelPortStatus(),
      sessionId === undefined ? Promise.resolve(null) : client.getSessionModelSelection(sessionId),
      onChooseConnection === undefined ? Promise.resolve([]) : client.listModelConnections()])
      .then(([directoryResult, statusResult, selectionResult, connectionResult]) => {
      if (!active) return;
      if (selectionResult.status === "rejected") throw selectionResult.reason;
      const selection = selectionResult.value;
      const configuredDefault = statusResult.status === "fulfilled" && statusResult.value.configured
        ? statusResult.value.model : null;
      setCatalog(directoryResult.status === "fulfilled" ? directoryResult.value : null);
      setConnections(connectionResult.status === "fulfilled" ? connectionResult.value : []);
      setDefaultModel(configuredDefault);
      setReadWarnings([
        ...(directoryResult.status === "rejected" ? [`免费目录读取失败：${describeLiveError(directoryResult.reason).message}`] : []),
        ...(statusResult.status === "rejected" ? [`应用默认配置读取失败：${describeLiveError(statusResult.reason).message}`] : []),
        ...(connectionResult.status === "rejected" ? [`已登记连接读取失败：${describeLiveError(connectionResult.reason).message}`] : []),
      ]);
      // 目录变化不自动选第一个，也不替换原首选。
      const current = sessionId === undefined ? selectedModel : selection?.model ?? null;
      const currentConnection = selectedConnectionId ?? (sessionId === undefined ? null : selection?.connectionId ?? null);
      setCurrentModel(current ?? configuredDefault);
      setCurrentConnectionId(currentConnection);
      setChoice(currentConnection ?? current ?? configuredDefault ?? "");
    }).catch((caught) => { if (active) setError(describeLiveError(caught).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, open, selectedModel, selectedConnectionId, sessionId, retry]);

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
  const visibleConnections = connections.filter((connection) =>
    `${connection.name} ${connection.defaultModel} ${connection.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  /**
   * 「可调用」只有一份判据：条目不可选就画成禁用，点下去也不会发命令。
   * 目录过期、凭据未配置、非文本输入输出模型都在这里收口，应用默认始终可选。
   */
  const callable = (model: RelayCatalogModel | null): boolean => Boolean(catalog?.configured && catalog.chatConfigured &&
    !catalog.cacheStale && model !== null && model.textInput === true && model.textOutput === true);
  /** 条目按身份分段：当前选择（即使已不在目录）、已登记连接、应用默认、免费目录；各段去重。 */
  const staleCurrent = currentConnectionId === null && currentModel !== null && currentModel !== defaultModel &&
    !catalog?.models.some((model) => model.id === currentModel);
  const directory = catalog?.models ?? [];
  const entries: ModelEntry[] = [];
  // 已登记连接按稳定 connection_id 独立成段：它们自带端点/预算/凭据，不依赖免费目录资格。
  // 停用的连接仍列出但不可选——用户能在原处看到「为什么它不在可选范围」，而不是凭空消失。
  for (const connection of visibleConnections) entries.push({ kind: "connection",
    id: connection.id, name: connection.name,
    model: directory.find((model) => model.id === connection.defaultModel) ?? null,
    connection, group: "已登记连接", selectable: connection.status === "ACTIVE",
    note: connection.status === "ACTIVE" ? `型号：${connection.defaultModel}` : "已停用，选择前先在设置中启用" });
  if (staleCurrent && currentModel !== null) entries.push({ kind: "model", id: currentModel,
    name: currentModel, model: null, connection: null, group: "当前选择", selectable: false, note: "已不在目录中，不可继续调用" });
  if (defaultModel !== null) entries.push({ kind: "model", id: defaultModel, name: defaultModel,
    model: directory.find((model) => model.id === defaultModel) ?? null, connection: null, group: "已配置模型",
    selectable: true, note: "应用默认" });
  for (const model of visibleModels) entries.push({ kind: "model", id: model.id, name: model.name, model,
    connection: null, group: "免费模型 · OpenRouter", selectable: callable(model),
    note: catalog?.cacheStale ? "目录已过期，仅供浏览" : catalog?.chatConfigured === false ? "调用凭据未配置" : null });
  // 已登记连接放在应用默认之前：用户刚在设置里建好的连接应当一眼可见。
  const groups = "已登记连接,当前选择,已配置模型,免费模型 · OpenRouter".split(",")
    .filter((group) => entries.some((entry) => entry.group === group));
  function chooseEntry(entry: ModelEntry) {
    if (!entry.selectable || disabled || refreshing || error !== null) return;
    setChoice(entry.id);
    // 连接选择提交的是连接身份，型号由服务端按连接当前声明解析；不混用型号命令。
    if (entry.kind === "connection" && entry.connection !== null) onChooseConnection?.(entry.connection);
    else onChoose(entry.id);
    onOpenChange(false);
    triggerRef.current?.focus();
  }
  /**
   * 触发器显示当前具体模型名；目录未收录时回落到 ID。ID 只进 title，不占可见面。
   * 首选以父层命令 Owner 的状态为准：点条目应用后父层就是新事实，这里缓存的 currentModel
   * 只是打开时读到的旧值，不能盖在它前面（否则刚应用的名字要等下次打开才显示）。
   */
  // 显示链：会话显式选择 → 打开下拉时读到的当前值 → 挂载读到的应用默认。
  // 三级都空才退回「模型」占位（服务端没配默认、本机没选过，此刻确实没有可显示的型号）。
  // 应用默认只来自服务端 model-port，不是本地推断，因此不冒充会话事实。
  const selectedId = selectedModel ?? currentModel ?? defaultModel;
  const selectedName = catalog?.models.find((model) => model.id === selectedId)?.name ?? selectedId;
  const selectedDetail = selectedId === null ? null
    : selectedName === selectedId ? selectedId : `${selectedName} · ${selectedId}`;
  return <div className="model-selector" ref={rootRef}>
    <button type="button" ref={triggerRef} className="agent-chat-tool model-selector-trigger"
      data-testid="model-selector-open" disabled={disabled} aria-busy={switching || undefined}
      aria-label={switching ? "模型切换中" : "选择模型"} aria-haspopup="listbox" aria-expanded={open} aria-controls="model-selector-list"
      title={switching ? "模型切换中，等待服务端回执"
        : selectedDetail === null ? "打开模型选择，核对本会话首选" : `首选模型：${selectedDetail}`}
      onClick={() => onOpenChange(!open)}><span className="model-selector-trigger-name">{selectedName ?? "模型"}</span>
      {/* 在途指示占用与 chevron 相同的 16px 槽，避免正常切换时聊天区宽度跳一下。 */}
      {switching ? <span className="model-selector-switch-dot" role="status" aria-label="模型切换中" />
        : <ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" />}</button>
    {open && <div className="model-selector-menu" data-testid="model-selector-menu">
      {(loading || error !== null) && <p className="model-selector-note" data-testid="model-selector-current">
        {loading ? "正在读取模型目录…" : error}</p>}
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
            className="model-selector-option" data-testid={`model-selector-option-${entry.id}`} data-model-id={entry.id}
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
        <span className="model-selector-note">{catalog?.cacheStale ? "目录已过期，仅供浏览" : ""}{catalog !== null && !catalog.configured ? "免费目录未启用" : ""}{catalog !== null && !catalog.chatConfigured ? "调用凭据未配置，免费模型暂不可调用" : ""}{catalog?.lastFailureReason ? `最近同步失败：${catalog.lastFailureReason}，保留上次成功结果` : ""}</span>
        <button type="button" className="model-selector-action" data-testid="model-selector-refresh"
          disabled={refreshing || !catalog?.configured} onClick={() => void refresh()}>{refreshing ? "正在刷新…" : "立即刷新"}</button>
      </p>}
      <p className="model-selector-note model-selector-footnote">免费分组默认有界接续：额度或限流且账户额度可用时最多再试 3 个合格型号；绝不转收费，共享额度耗尽即停。</p>
    </div>}
  </div>;
}
