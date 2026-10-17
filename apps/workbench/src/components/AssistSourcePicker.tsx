import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { RelayAssistSourceRef, RelaySearchItem } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { liveClient, useRelayConnection } from "../lib/relayConnection";

/** 每次消息可选资料版本的上限：沿用既有约束（「+」二级菜单同一条口径），不另立第二套。 */
const sourceLimit = 10;

/**
 * 资料面板（点击穿透任务书 CT-02）。
 *
 * 这一份组件只承担「选哪些资料版本」：检索、已选数量、已选项、引用范围四件事按此顺序优先显示，
 * 生成方式与意图属于发送选项设置区，不写进这里。列表区限高并在内部滚动，检索行与关闭入口因此
 * 不会被长结果推走；标题走面板字号而不是整页 hero（样式见 `migrated-scoped.css`）。
 *
 * 四类状态各自独立可见，不用空列表掩盖读取失败：尚未检索（空态）、正在检索、查无结果、
 * 读取失败（带重试）。只有真的发出过请求并失败才给重试——校验与上限提示重试也不会变。
 *
 * 勾选或移除只是编辑本次候选输入：不发送消息、不建执行、不申请权限；本地文件仍未接入，
 * 由「+」二级菜单如实禁用并说明接入点，这里不假装可用。
 */
export default function AssistSourcePicker({ projectId, selectedRefs, onChange, disabled = false }: { projectId: string | null; selectedRefs: readonly RelayAssistSourceRef[]; onChange: (refs: readonly RelayAssistSourceRef[]) => void; disabled?: boolean }) {
  const connection = useRelayConnection();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly RelaySearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 只有发出过真实请求并失败才允许重试，避免把校验或断连提示说成「点一下就好」。 */
  const [retryable, setRetryable] = useState(false);
  /** 空态与查无结果不共用一句话：检索过才算「没有匹配」。 */
  const [searched, setSearched] = useState(false);
  const [limitNotice, setLimitNotice] = useState<string | null>(null);
  const requestVersion = useRef(0);

  function resetRead() {
    setLoading(false); setError(null); setRetryable(false); setSearched(false); setLimitNotice(null);
  }
  useEffect(() => {
    requestVersion.current++; setQuery(""); setResults([]); resetRead(); onChange([]);
    return () => { requestVersion.current++; };
  }, [projectId, connection.client]);

  function changeQuery(value: string) {
    requestVersion.current++; setQuery(value); setResults([]); resetRead();
  }

  async function runSearch(text: string) {
    const client = liveClient(); const version = ++requestVersion.current;
    setResults([]); setError(null); setRetryable(false); setSearched(false); setLimitNotice(null);
    if (!client) { setError("连接本机 API 后才能选择真实来源。"); return; }
    if (!text || text.length > 200) { setError("请输入 1–200 个字符的检索词。"); return; }
    setLoading(true);
    try {
      const page = await client.searchInformation({ q: text, projectId, types: ["KNOWLEDGE", "MEMORY", "DECISION"], limit: 20 });
      if (version !== requestVersion.current || client !== liveClient()) return;
      setResults(page.items.filter((item) => (item.projectId === null || item.projectId === projectId) && item.type !== "RULE" && item.status === "ACTIVE"));
      setSearched(true);
    } catch (caught) {
      if (version !== requestVersion.current) return;
      setError(describeLiveError(caught).message); setRetryable(true);
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }
  function search(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void runSearch(query.trim()); }

  function key(ref: RelayAssistSourceRef) { return `${ref.kind}:${ref.rootId}:${ref.version}`; }
  function toggle(item: RelaySearchItem) {
    if (item.type === "RULE" || disabled) return;
    const ref = { kind: item.type, rootId: item.id, version: item.version };
    const refs = selectedRefs.some((selected) => key(selected) === key(ref))
      ? selectedRefs.filter((selected) => key(selected) !== key(ref)) : [...selectedRefs, ref];
    if (refs.length > sourceLimit) { setLimitNotice(`每次消息最多选择 ${sourceLimit} 个资料版本；已选项保持不变。`); return; }
    setLimitNotice(null); onChange(refs);
  }
  /** 依据块展开时 Esc 先收它，再交给外层面板：一次 Esc 不能同时吃掉两层。 */
  function closeBasisFirst(event: KeyboardEvent<HTMLDetailsElement>) {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
  }

  return <section className="surface-panel assist-source-panel" data-testid="assist-source-picker" aria-labelledby="assist-source-title">
    <header className="assist-source-head">
      <h2 id="assist-source-title" className="assist-source-title">本次显式选择的资料</h2>
      <p className="assist-source-count" data-testid="assist-source-count">已选 {selectedRefs.length} / {sourceLimit} 个版本</p>
    </header>
    <form className="form-actions" onSubmit={(event) => void search(event)}>
      <label className="field" htmlFor="assist-source-query"><span className="field-label">检索词</span><input id="assist-source-query" value={query} onChange={(event) => changeQuery(event.target.value)} type="search" maxLength={200} autoComplete="off" disabled={disabled} /></label>
      <button className="secondary-button" type="submit" disabled={disabled || loading || connection.mode !== "live"}>查找来源</button>
    </form>
    <p className="assist-source-scope" data-testid="assist-source-scope">引用范围：{projectId ? "当前项目与未限定项目的启用资料（不含规则）" : "未绑定项目，没有可选资料"} · 只作用于本次消息。</p>
    <div className="assist-source-body" data-testid="assist-source-body">
      {loading && <p role="status">正在查找可选资料…</p>}
      {error && <p className="action-error" role="alert">{error}{retryable && <><span> </span><button className="text-link" type="button" data-testid="assist-source-retry" disabled={disabled || query.trim() === ""} onClick={() => void runSearch(query.trim())}>重试检索</button></>}</p>}
      {limitNotice && <p className="disabled-reason" role="status" data-testid="assist-source-limit">{limitNotice}</p>}
      {!!selectedRefs.length && <section className="assist-source-block" data-region="selected">
        <h3 className="assist-source-block-title">已选资料</h3>
        <ul className="assist-source-list assist-source-selected">{selectedRefs.map((ref) => <li key={key(ref)}>{ref.kind} · v{ref.version} · {ref.rootId} <button type="button" className="text-link" disabled={disabled} onClick={() => onChange(selectedRefs.filter((item) => key(item) !== key(ref)))}>移除</button></li>)}</ul>
      </section>}
      {!loading && !error && !searched && <p className="helper-text" data-testid="assist-source-empty">还没有检索资料；输入检索词后只显示当前获准范围内的可选项。</p>}
      {!loading && !error && searched && !results.length && <p className="helper-text" data-testid="assist-source-none">没有可见的匹配资料；不据此推断其他范围的资料数量。</p>}
      {!!results.length && <section className="assist-source-block" data-region="results">
        <h3 className="assist-source-block-title">检索结果</h3>
        <ul className="assist-source-list">{results.map((item) => <li key={item.sourceRef}><label className="assist-source-option"><input type="checkbox" checked={selectedRefs.some((selected) => key(selected) === key({ kind: item.type as RelayAssistSourceRef["kind"], rootId: item.id, version: item.version }))} onChange={() => toggle(item)} disabled={disabled} /><span><strong>{item.title}</strong><small>{item.type} · v{item.version} · {item.sourceRef}</small><small>{item.snippet}</small></span></label></li>)}</ul>
      </section>}
    </div>
    <p className="helper-text">选中项只是本次请求的候选输入，不授予新的读取或写入权限。</p>
    <details className="assist-source-basis" data-testid="assist-source-basis" onKeyDown={closeBasisFirst}>
      <summary>依据</summary>
      <ul>
        <li>只检索当前获准范围内的知识、记忆与决定版本；规则类与已停用版本不进入候选。</li>
        <li>每次消息最多 {sourceLimit} 个资料版本；超限保留已选项，本次选择不部分生效。</li>
        <li>发送时冻结所选版本的 kind / rootId / version 三元组，服务端仍会按权限与实际版本复核。</li>
        <li>切换项目或连接会清空本次选择，避免把上一个范围的引用带进新请求。</li>
        <li>本地文件选择尚未接入：桌面宿主当前只提供目录选择器，所以这里只列出已获准读取的资料版本。</li>
      </ul>
    </details>
  </section>;
}
