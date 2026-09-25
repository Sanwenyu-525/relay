import { useEffect, useRef, useState, type FormEvent } from "react";
import type { RelaySearchItem } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { liveClient, useRelayConnection } from "../lib/relayConnection";

export default function AssistSourcePicker({ projectId, selectedRefs, onChange }: { projectId: string; selectedRefs: readonly string[]; onChange: (refs: readonly string[]) => void }) {
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
    try { const page = await client.searchInformation({ q: text, projectId, types: ["KNOWLEDGE", "MEMORY", "DECISION"], limit: 20 }); if (version !== requestVersion.current || client !== liveClient()) return; setResults(page.items.filter((item) => (item.projectId === null || item.projectId === projectId) && item.type !== "RULE")); }
    catch (caught) { if (version === requestVersion.current) setError(describeLiveError(caught).message); }
    finally { if (version === requestVersion.current) setLoading(false); }
  }
  function toggle(sourceRef: string) { const refs = new Set(selectedRefs); if (refs.has(sourceRef)) refs.delete(sourceRef); else refs.add(sourceRef); onChange([...refs]); }
  return <section className="surface-panel" data-testid="assist-source-picker"><h2>本次显式选择的资料</h2><p className="helper-text">只检索当前获准范围内的资料版本。选中项仅是本次请求的候选输入，不授予新的读取或写入权限。</p><form className="form-actions" onSubmit={(event) => void search(event)}><label className="field" htmlFor="assist-source-query"><span className="field-label">检索词</span><input id="assist-source-query" value={query} onChange={(event) => changeQuery(event.target.value)} type="search" maxLength={200} autoComplete="off" /></label><button className="secondary-button" type="submit" disabled={loading || connection.mode !== "live"}>查找来源</button></form>{loading && <p role="status">正在查找可选资料…</p>}{error && <p className="action-error" role="alert">{error}</p>}{!loading && !results.length && !!query.trim() && !error && <p className="helper-text">没有可见的匹配资料；不据此推断其他范围的资料数量。</p>}{!!results.length && <ul className="assist-source-list">{results.map((item) => <li key={item.sourceRef}><label className="assist-source-option"><input type="checkbox" checked={selectedRefs.includes(item.sourceRef)} onChange={() => toggle(item.sourceRef)} /><span><strong>{item.title}</strong><small>{item.type} · v{item.version} · {item.sourceRef}</small><small>{item.snippet}</small></span></label></li>)}</ul>}{!!selectedRefs.length && <p className="helper-text">已选择 {selectedRefs.length} 个当前可见的资料版本；发送前仍须由服务端复核。</p>}</section>;
}
