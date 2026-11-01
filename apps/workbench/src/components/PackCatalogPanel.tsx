import { useEffect, useRef, useState } from "react";
import type { RelayPackDefinition } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";

/** 当前可用组合的摘要行：只回答「有哪些组合、由几项组成」，不铺协议和 hash。 */
function PackSummaryRow({ pack }: { pack: RelayPackDefinition }) {
  return <article className="pack-catalog-summary-row" data-testid={`pack-summary-${pack.id}-${pack.version}`}>
    <div>
      <strong>{pack.title}</strong>
      <small>{pack.id} v{pack.version} · 成员 {pack.members.length} 项</small>
    </div>
    <span className="status-chip status-chip--success">可用</span>
  </article>;
}

/** 高级详情：协议、摘要与成员 hash，默认折叠在协议摘要区。 */
function PackRow({ pack }: { pack: RelayPackDefinition }) {
  return <article className="assist-proposal pack-catalog-pack">
    <h3>{pack.title}</h3>
    <p className="helper-text">{pack.id} v{pack.version} · {pack.availability} · 成员 {pack.members.length} 项</p>
    <details className="pack-catalog-details">
      <summary>协议、摘要与成员详情</summary>
      <p className="helper-text">宿主契约 {pack.hostContract} · 定义摘要 <code className="hash-code">{pack.sha256}</code></p>
      <ul className="pack-catalog-members">{pack.members.map((member) => <li key={`${member.id}@${member.version}`}>
        <strong>{member.id}</strong> v{member.version} · {member.target} ·
        {pack.availability === "HISTORICAL_ONLY" ? "组合历史版本，仅可查阅" :
          member.missingCapabilities.length ? "缺能力，当前不可调用" :
          member.availability === "CALLABLE_READ_ONLY" ? "可调用、只读" :
            member.availability === "CALLABLE_SUGGESTION_ONLY" ? "可调用、仅建议" : member.availability} ·
        {member.missingCapabilities.length ? `缺少能力：${member.missingCapabilities.join("、")}` :
          member.requiredCapabilities.length ? `需要能力：${member.requiredCapabilities.join("、")}` :
            "无额外 Connector 能力要求"} · {pack.availability === "HISTORICAL_ONLY" ? "不可新调用或接受" :
            member.acceptSupported ? "可在确切目标的 Assist 中确认服务端提案" : "无接受入口"}
        <small>成员摘要 <code className="hash-code">{member.sha256}</code></small>
      </li>)}</ul>
    </details>
  </article>;
}

export default function PackCatalogPanel() {
  const connection = useRelayConnection();
  const [packs, setPacks] = useState<readonly RelayPackDefinition[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useRef(0);
  const client = connection.client;

  async function load() {
    const current = ++version.current;
    setPacks(null); setError(null);
    if (!client) return;
    try {
      const items = await client.getFirstPartyPacks();
      if (current === version.current) setPacks([...items].sort((a, b) =>
        a.availability === b.availability
          ? a.id === b.id ? b.version.localeCompare(a.version, undefined, { numeric: true }) :
            a.id.localeCompare(b.id)
          : a.availability === "AVAILABLE" ? -1 : 1));
    } catch (caught) {
      if (current === version.current) setError(describeLiveError(caught).message);
    }
  }
  useEffect(() => { void load(); return () => { version.current++; }; }, [client, connection.epoch]);
  if (connection.mode !== "live") return null;
  const available = packs?.filter((pack) => pack.availability === "AVAILABLE") ?? [];
  const historical = packs?.filter((pack) => pack.availability !== "AVAILABLE") ?? [];
  return <section className="surface-panel pack-catalog" data-testid="pack-catalog">
    <h2>内置 Pack（只读）</h2>
    <p className="helper-text">清单来自当前工作空间的固定注册表。浏览或选择不会授权工具、启用规则、应用配置或启动 Run。</p>
    {packs === null && !error && <p role="status">正在读取内置组合…</p>}
    {error && <p className="action-error" role="alert">Pack 清单暂不可读：{error}。
      <button type="button" className="text-button" onClick={() => void load()}>重读</button></p>}
    {packs?.length === 0 && <p className="helper-text">当前没有已注册的内置 Pack。</p>}
    {available.length > 0 && <div className="pack-catalog-current" data-testid="pack-catalog-current">
      {available.map((pack) => <PackSummaryRow key={`${pack.id}@${pack.version}`} pack={pack} />)}
    </div>}
    {packs && packs.length > 0 && <details className="settings-diagnostics pack-catalog-advanced"
      data-testid="pack-catalog-advanced">
      <summary>高级详情：协议摘要与成员 hash（{available.length + historical.length} 个组合）</summary>
      {available.length > 0 && <div className="pack-catalog-group">
        <h3>当前可用组合</h3>
        {available.map((pack) => <PackRow key={`${pack.id}@${pack.version}`} pack={pack} />)}
      </div>}
      {historical.length > 0 && <div className="pack-catalog-group">
        <h3>历史版本（仅供查阅）</h3>
        {historical.map((pack) => <PackRow key={`${pack.id}@${pack.version}`} pack={pack} />)}
      </div>}
    </details>}
  </section>;
}
