import { useEffect, useRef, useState, type FormEvent } from "react";
import type { RelayAssistSourceRef, RelaySearchItem } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { liveClient, useRelayConnection } from "../lib/relayConnection";

export default function AssistSourcePicker({ projectId, selectedRefs, onChange, disabled = false }: { projectId: string | null; selectedRefs: readonly RelayAssistSourceRef[]; onChange: (refs: readonly RelayAssistSourceRef[]) => void; disabled?: boolean }) {
  const connection = useRelayConnection();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly RelaySearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  useEffect(() => { requestVersion.current++; setQuery(""); setResults([]); setLoading(false); setError(null); onChange([]); return () => { requestVersion.current++; }; }, [projectId, connection.client]);
  function changeQuery(value: string) { requestVersion.current++; setQuery(value); setResults([]); setLoading(false); setError(null); }
  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const client = liveClient(); const text = query.trim(); const version = ++requestVersion.current;
    setResults([]); setError(null);
    if (!client) { setError("连接本机 API 后才能选择真实来源。"); return; }
    if (!text || text.length > 200) { setError("请输入 1–200 个字符的检索词。"); return; }
    setLoading(true);
    try { const page = await client.searchInformation({ q: text, projectId, types: ["KNOWLEDGE", "MEMORY", "DECISION"], limit: 20 }); if (version !== requestVersion.current || client !== liveClient()) return; setResults(page.items.filter((item) => (item.projectId === null || item.projectId === projectId) && item.type !== "RULE" && item.status === "ACTIVE")); }
    catch (caught) { if (version === requestVersion.current) setError(describeLiveError(caught).message); }
    finally { if (version === requestVersion.current) setLoading(false); }
  }
  function key(ref: RelayAssistSourceRef) { return `${ref.kind}:${ref.rootId}:${ref.version}`; }
  function toggle(item: RelaySearchItem) {
    if (item.type === "RULE" || disabled) return;
    const ref = { kind: item.type, rootId: item.id, version: item.version };
    const refs = selectedRefs.some((selected) => key(selected) === key(ref))
      ? selectedRefs.filter((selected) => key(selected) !== key(ref)) : [...selectedRefs, ref];
    if (refs.length > 10) { setError("每次消息最多选择 10 个资料版本。"); return; }
    setError(null); onChange(refs);
  }
  return <section className="surface-panel" data-testid="assist-source-picker"><h2>本次显式选择的资料</h2><p className="helper-text">只检索当前获准范围内的资料版本。选中项仅是本次请求的候选输入，不授予新的读取或写入权限。</p><form className="form-actions" onSubmit={(event) => void search(event)}><label className="field" htmlFor="assist-source-query"><span className="field-label">检索词</span><input id="assist-source-query" value={query} onChange={(event) => changeQuery(event.target.value)} type="search" maxLength={200} autoComplete="off" disabled={disabled} /></label><button className="secondary-button" type="submit" disabled={disabled || loading || connection.mode !== "live"}>查找来源</button></form>{loading && <p role="status">正在查找可选资料…</p>}{error && <p className="action-error" role="alert">{error}</p>}{!loading && !results.length && !!query.trim() && !error && <p className="helper-text">没有可见的匹配资料；不据此推断其他范围的资料数量。</p>}{!!results.length && <ul className="assist-source-list">{results.map((item) => <li key={item.sourceRef}><label className="assist-source-option"><input type="checkbox" checked={selectedRefs.some((selected) => key(selected) === key({ kind: item.type as RelayAssistSourceRef["kind"], rootId: item.id, version: item.version }))} onChange={() => toggle(item)} disabled={disabled} /><span><strong>{item.title}</strong><small>{item.type} · v{item.version} · {item.sourceRef}</small><small>{item.snippet}</small></span></label></li>)}</ul>}{!!selectedRefs.length && <><p className="helper-text">已选择 {selectedRefs.length} 个资料版本；发送时冻结具体版本，服务端仍会复核。</p><ul className="assist-source-list">{selectedRefs.map((ref) => <li key={key(ref)}>{ref.kind} · v{ref.version} · {ref.rootId} <button type="button" className="text-link" disabled={disabled} onClick={() => onChange(selectedRefs.filter((item) => key(item) !== key(ref)))}>移除</button></li>)}</ul></>}</section>;
}
