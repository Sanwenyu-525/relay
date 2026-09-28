import { useEffect, useState } from "react";
import { createCommandId, type RelayApiClient, type RelayArtifact,
  type RelayArtifactTextLock, type RelayArtifactLineage } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

type Kind = "PARAGRAPH" | "SECTION";

function blocks(content: string, kind: Kind): readonly string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (kind === "PARAGRAPH") {
    const result: string[] = [];
    let current: string[] = [];
    let fenced = false;
    for (const line of lines) {
      if (/^\s*```/.test(line)) fenced = !fenced;
      if (!fenced && /^\s*$/.test(line)) {
        if (current.length) result.push(current.join("\n"));
        current = [];
      } else current.push(line);
    }
    if (current.length) result.push(current.join("\n"));
    return result;
  }
  const headings: { start: number; level: number }[] = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) return;
    const found = /^(#{1,6})\s+\S/.exec(line);
    if (found) headings.push({ start: index, level: found[1]!.length });
  });
  return headings.map((heading, index) => {
    const next = headings.slice(index + 1).find((item) => item.level <= heading.level);
    return lines.slice(heading.start, next?.start ?? lines.length).join("\n").trimEnd();
  });
}

export default function ArtifactTextLocksPanel({ client, lineage }:
  { readonly client: RelayApiClient; readonly lineage: RelayArtifactLineage }) {
  const [artifact, setArtifact] = useState<RelayArtifact | null>(null);
  const [locks, setLocks] = useState<readonly RelayArtifactTextLock[]>([]);
  const [content, setContent] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("PARAGRAPH");
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  async function refresh() {
    const [nextArtifact, nextLocks, nextContent] = await Promise.all([
      client.getArtifact(lineage.artifactId), client.getArtifactTextLocks(lineage.artifactId),
      client.getArtifactVersionContent(lineage.artifactVersionId)
    ]);
    if (nextArtifact.id !== lineage.artifactId ||
        nextLocks.some((lock) => lock.artifactId !== lineage.artifactId))
      throw new Error("锁定事实与产物目标不匹配。");
    setArtifact(nextArtifact); setLocks(nextLocks); setContent(nextContent);
  }
  useEffect(() => { let active = true; void refresh().catch((caught) => {
    if (active) setError(describeLiveError(caught).message);
  }); return () => { active = false; }; }, [client, lineage.artifactVersionId]);
  const current = artifact?.latestVersionId === lineage.artifactVersionId;
  const options = content === null ? [] : blocks(content, kind);
  async function lock() {
    if (!artifact || !current || !options[index] || busy || pending) return;
    setBusy(true); setError(null); setMessage(null);
    const id = createCommandId(); setPending(id);
    try {
      await client.lockArtifactText({ artifactId: artifact.id, commandId: id,
        expectedArtifactRevision: artifact.revision, expectedVersionId: lineage.artifactVersionId,
        blockKind: kind, blockIndex: index });
      await refresh(); setPending(null); setMessage("原文已锁定；AI 追加版本会在服务端重新核对。");
    } catch (caught) { setError(`${describeLiveError(caught).message} 原 command_id：${id}；请刷新并核对锁定列表。`); }
    finally { setBusy(false); }
  }
  async function unlock(lockId: string) {
    if (!artifact || busy || pending) return;
    setBusy(true); setError(null); setMessage(null);
    const id = createCommandId(); setPending(id);
    try {
      await client.unlockArtifactText({ artifactId: artifact.id, lockId, commandId: id,
        expectedArtifactRevision: artifact.revision });
      await refresh(); setPending(null); setMessage("已解除这一处锁定；其他锁定仍有效。");
    } catch (caught) { setError(`${describeLiveError(caught).message} 原 command_id：${id}；请刷新并核对锁定列表。`); }
    finally { setBusy(false); }
  }
  async function retryRead() {
    setError(null); setPending(null);
    try { await refresh(); } catch (caught) { setError(describeLiveError(caught).message); }
  }
  return <section className="surface-panel" data-testid="artifact-text-locks"><h2>章节与段落原文锁定</h2>
    <p className="helper-text">锁定只约束 AI 写入。人工可直接修订，保存为新版本后继续保护新原文；结构无法可靠映射时 AI 写入会被拒绝。</p>
    {error && <p className="action-error" role="alert">{error}</p>}
    {message && <p className="receipt-message" role="status">{message}</p>}
    <button className="secondary-button" type="button" disabled={busy} onClick={() => void retryRead()}>刷新锁定事实</button>
    {locks.length > 0 && <ul>{locks.map((lock) => <li key={lock.id}>
      <strong>{lock.blockKind === "SECTION" ? "章节" : "段落"} · {lock.status === "UNMAPPED" ? "待人工核对映射" : `第 ${lock.blockIndex! + 1} 块`}</strong>
      <p>{lock.text.slice(0, 160)}{lock.text.length > 160 ? "…" : ""}</p>
      <p className="helper-text">绑定版本 {lock.baseVersionId}</p>
      <button className="secondary-button" type="button" disabled={busy || pending !== null} onClick={() => void unlock(lock.id)}>解除这一处锁定</button>
    </li>)}</ul>}
    {!locks.length && <p className="helper-text">该产物没有当前锁定区域。</p>}
    {!current ? <p className="helper-text">这是历史版本；只能在该产物最新版本上新增锁定。</p> : <>
      <label className="field"><span className="field-label">锁定粒度</span>
        <select value={kind} onChange={(event) => { setKind(event.target.value as Kind); setIndex(0); }}>
          <option value="PARAGRAPH">段落</option><option value="SECTION">章节</option></select></label>
      <label className="field"><span className="field-label">选择确切原文</span>
        <select value={index} onChange={(event) => setIndex(Number(event.target.value))}>
          {options.map((block, blockIndex) => <option key={blockIndex} value={blockIndex}>{blockIndex + 1} · {block.slice(0, 100)}</option>)}</select></label>
      <button className="primary-button" type="button" disabled={busy || pending !== null || !options[index]}
        onClick={() => void lock()}>锁定所选原文</button>
    </>}
  </section>;
}
