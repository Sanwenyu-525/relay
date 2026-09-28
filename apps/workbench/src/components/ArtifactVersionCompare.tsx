import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { RelayApiClient, RelayArtifact, RelayArtifactLineage, RelayArtifactVersionSummary } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

interface Comparison {
  readonly version: RelayArtifactVersionSummary;
  readonly lineage: RelayArtifactLineage;
  readonly content: string;
}

function changedLines(before: string, after: string) {
  const normalizedBefore = before.replaceAll("\r\n", "\n");
  const normalizedAfter = after.replaceAll("\r\n", "\n");
  const oldLines = normalizedBefore.split("\n");
  const newLines = normalizedAfter.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
  return { same: before === after, lineEndingOnly: before !== after && normalizedBefore === normalizedAfter,
    before: oldLines.slice(prefix, oldLines.length - suffix).join("\n"),
    after: newLines.slice(prefix, newLines.length - suffix).join("\n"),
    prefix, suffix };
}

/** Explicitly reads immutable versions. No draft or business state is changed here. */
export default function ArtifactVersionCompare({ client, lineage }: {
  client: RelayApiClient; lineage: RelayArtifactLineage;
}) {
  const [artifact, setArtifact] = useState<RelayArtifact | null>(null);
  const [currentContent, setCurrentContent] = useState<string | null>(null);
  const [baselineId, setBaselineId] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, [client, lineage.artifactVersionId]);

  async function readCurrent() {
    const token = ++request.current;
    setLoading(true); setError(null); setArtifact(null); setCurrentContent(null);
    setComparison(null); setBaselineId("");
    try {
      const [found, content] = await Promise.all([
        client.getArtifact(lineage.artifactId), client.getArtifactVersionContent(lineage.artifactVersionId)
      ]);
      if (token !== request.current) return;
      const version = found.versions.find((entry) => entry.artifactVersionId === lineage.artifactVersionId);
      if (found.id !== lineage.artifactId || !version || version.sha256 !== lineage.sha256)
        throw new Error("产物列表与当前确切版本不一致；请刷新来源后再读正文。");
      setArtifact(found); setCurrentContent(content);
    } catch (caught) { if (token === request.current) setError(describeLiveError(caught).message); }
    finally { if (token === request.current) setLoading(false); }
  }

  async function readComparison() {
    const version = artifact?.versions.find((entry) => entry.artifactVersionId === baselineId);
    if (!version || currentContent === null) return;
    const token = ++request.current;
    setComparing(true); setCompareError(null); setComparison(null);
    try {
      const [content, source] = await Promise.all([
        client.getArtifactVersionContent(version.artifactVersionId),
        client.getArtifactLineage(version.artifactVersionId)
      ]);
      if (token !== request.current) return;
      if (source.artifactVersionId !== version.artifactVersionId || source.artifactId !== artifact?.id ||
        source.sha256 !== version.sha256 || source.contentAvailability !== "AVAILABLE")
        throw new Error("比较版本的正文或来源与所选版本不一致；不能展示差异。");
      setComparison({ version, lineage: source, content });
    } catch (caught) { if (token === request.current) setCompareError(describeLiveError(caught).message); }
    finally { if (token === request.current) setComparing(false); }
  }

  const diff = comparison && currentContent !== null ? changedLines(comparison.content, currentContent) : null;
  return <section className="surface-panel lineage-content" data-testid="artifact-version-compare">
    <h2>正文与确切版本比较</h2>
    <p className="helper-text">正文由确切版本内容接口重新校验摘要后读取。比较范围仅限这份产物的已保存版本；未保存草稿不参与比较。</p>
    {lineage.contentAvailability === "UNAVAILABLE" ? <p className="warning-callout">当前版本正文不可用，不能比较；不会用最新版本替代。</p>
      : <button className="secondary-button" type="button" disabled={loading} onClick={() => void readCurrent()}>{loading ? "正在读取" : "读取当前版本正文与历史"}</button>}
    {error && <p className="action-error" role="alert">{error}</p>}
    {currentContent !== null && artifact && <>
      <p className="helper-text">当前版本 v{lineage.versionNumber} · {lineage.artifactVersionId} · sha256 {lineage.sha256}</p>
      <pre className="lineage-text" data-testid="artifact-current-content">{currentContent}</pre>
      <label className="field"><span className="field-label">比较基线</span><select value={baselineId} data-testid="artifact-compare-select" onChange={(event) => {
        request.current++; setBaselineId(event.target.value); setComparison(null); setCompareError(null); setComparing(false);
      }}><option value="">选择已保存版本</option>{artifact.versions.map((version) => <option key={version.artifactVersionId} value={version.artifactVersionId}>v{version.versionNumber} · {version.artifactVersionId === lineage.artifactVersionId ? "当前版本" : version.sourceKind}</option>)}</select></label>
      <button className="secondary-button" type="button" data-testid="artifact-compare-submit" disabled={!baselineId || comparing} onClick={() => void readComparison()}>{comparing ? "正在比较" : "比较确切版本"}</button>
      {compareError && <p className="action-error" role="alert">{compareError}</p>}
      {comparison && diff && <section className="lineage-diff" data-testid="artifact-compare-result"><h3>v{comparison.version.versionNumber} → v{lineage.versionNumber}</h3>
        <p className="helper-text">基线 {comparison.version.artifactVersionId} · sha256 {comparison.version.sha256} · {comparison.lineage.sourceKind} · {comparison.version.createdAt}。<Link className="inline-link" to={`/artifact-versions/${comparison.version.artifactVersionId}/lineage`}>查看基线完整来源</Link></p>
        <p className="helper-text">基线的直接父来源 {comparison.lineage.directParents.length} 项；缺失的来源不从正文猜测。{comparison.lineage.directParents.map((edge) => `${edge.relation}:${edge.availability === "AVAILABLE" ? edge.parentId : "不可用"}`).join("；")}</p>
        {diff.same ? <p role="status">两个确切版本正文相同。</p> : diff.lineEndingOnly ? <p role="status">正文文字相同，但 CRLF/LF 换行字节不同；两个版本的内容摘要仍分别保留。</p> : <><p>共同前缀 {diff.prefix} 行，共同后缀 {diff.suffix} 行；以下展示中间全部变化行。</p>
          <div className="lineage-diff-columns"><div><h4>基线独有或被替换</h4><pre className="lineage-text">{diff.before || "（无）"}</pre></div><div><h4>当前新增或替换</h4><pre className="lineage-text">{diff.after || "（无）"}</pre></div></div></>}
      </section>}
    </>}
  </section>;
}
