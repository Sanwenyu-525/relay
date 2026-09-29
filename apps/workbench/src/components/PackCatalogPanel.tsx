import { useEffect, useRef, useState } from "react";
import type { RelayPackDefinition } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";

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
    <p className="helper-text">此清单来自当前工作空间的固定注册表。AVAILABLE 表示当前组合，HISTORICAL_ONLY 仅供查阅旧定义；无额外 Connector 能力要求不表示模型 Provider 已配置。浏览或选择项目类型不会授权工具、启用规则、应用配置或启动 Run。</p>
    {packs === null && !error && <p role="status">正在读取内置组合…</p>}
    {error && <p className="action-error" role="alert">Pack 清单暂不可读：{error}。<button type="button" className="text-link" onClick={() => void load()}>重读</button></p>}
    {packs?.length === 0 && <p className="helper-text">当前没有已注册的内置 Pack。</p>}
    {packs && packs.length > 0 && <p className="helper-text pack-catalog-summary" data-testid="pack-catalog-summary">
      当前可用组合：{available.map((pack) => `${pack.id} v${pack.version}`).join("、") || "无"}。
      历史版本 {historical.length} 个已折叠；组合详情、协议与成员摘要可按需展开。
    </p>}
    {available.length > 0 && <details className="pack-catalog-available" data-testid="pack-catalog-available">
      <summary>当前组合详情（{available.length} 个，含成员与摘要）</summary>
      {available.map((pack) => <PackRow key={`${pack.id}@${pack.version}`} pack={pack} />)}
    </details>}
    {historical.length > 0 && <details className="pack-catalog-historical" data-testid="pack-catalog-historical">
      <summary>历史版本（仅供查阅，{historical.length} 个）</summary>
      {historical.map((pack) => <PackRow key={`${pack.id}@${pack.version}`} pack={pack} />)}
    </details>}
  </section>;
}
