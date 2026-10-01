import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import SafeMarkdown from "./SafeMarkdown";
import { RelayApiError, RelayTransportError, type RelayApiClient, type RelayArtifactVersionSummary, type RelayRunDraftPreview, type RelayTaskArtifacts } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

interface Reading {
  readonly version: RelayArtifactVersionSummary;
  readonly title: string;
  readonly content: string;
}

function describeContentError(caught: unknown): string {
  if (caught instanceof RelayApiError && caught.problem.code === "EVIDENCE_UNAVAILABLE")
    return "该版本正文暂不可用，请重试读取或查看其他已保存版本。";
  if (caught instanceof RelayTransportError)
    return "正文读取失败：无法连接本机服务，请检查连接后重试。";
  return describeLiveError(caught).message;
}

/**
 * 产物阅读区：只读呈现确切不可变版本、当前选用与本轮接受的差别，以及两份确切版本的比较。
 * 生成中草稿与已保存版本在这里明确分开；这里不新建版本、不改写业务事实。
 */
export default function ArtifactReaderPanel({ client, taskId, projectId, selectedVersionId, draft, compact, paperFooter }: {
  client: RelayApiClient;
  taskId: string;
  projectId: string | null;
  selectedVersionId: string | null;
  /** Run DRAFT 的生成中草稿；与服务端保存的产物版本不是同一对象。 */
  draft: RelayRunDraftPreview | null;
  compact?: boolean;
  paperFooter?: ReactNode;
}) {
  const [artifacts, setArtifacts] = useState<RelayTaskArtifacts | null>(null);
  const [stateRefs, setStateRefs] = useState<readonly { artifactVersionId: string; versionNumber: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [readingError, setReadingError] = useState<string | null>(null);
  const [readingLoading, setReadingLoading] = useState(false);
  const [readingVersionId, setReadingVersionId] = useState<string | null>(null);
  const [compareWith, setCompareWith] = useState("");
  const [compare, setCompare] = useState<{ base: Reading; head: Reading } | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const request = useRef(0);
  const readRequest = useRef(0);

  async function load() {
    const version = ++request.current;
    readRequest.current++;
    setReading(null); setReadingError(null); setReadingLoading(false); setReadingVersionId(null);
    setCompare(null); setCompareError(null); setCompareLoading(false);
    setLoading(true); setError(null);
    try {
      const [loaded, state] = await Promise.all([
        client.getTaskArtifacts(taskId),
        projectId === null ? Promise.resolve(null) : client.getProjectState(projectId).catch(() => null)
      ]);
      if (version !== request.current) return;
      if (loaded.items.some((item) => item.taskId !== taskId))
        throw new RelayTransportError("产物版本的任务归属与当前阅读对象不匹配。");
      setArtifacts(loaded);
      setStateRefs(state?.selectedArtifactVersionRefs ?? []);
    } catch (caught) {
      if (version === request.current) { setArtifacts(null); setStateRefs([]); setError(describeLiveError(caught).message); }
    } finally { if (version === request.current) setLoading(false); }
  }

  useEffect(() => {
    readRequest.current++;
    setArtifacts(null); setStateRefs([]); setReading(null); setReadingError(null);
    setReadingLoading(false); setReadingVersionId(null); setCompare(null); setCompareError(null); setCompareWith(""); setCompareLoading(false);
    void load();
    return () => { request.current++; readRequest.current++; };
  }, [client, taskId, projectId]);

  const versions: readonly { readonly artifactId: string; readonly version: RelayArtifactVersionSummary; readonly title: string }[] =
    useMemo(() => artifacts?.items.flatMap((artifact) => artifact.versions.map((version) => ({ artifactId: artifact.id, version, title: artifact.title }))) ?? [], [artifacts]);
  // 默认阅读确切选中的版本，否则读该产物声明的 latest；数组顺序不是版本新旧，不能用末位冒充最新。
  const latestId = artifacts?.items.find((artifact) => artifact.versions.length > 0)?.latestVersionId ?? null;
  const active = selectedVersionId !== null
    ? versions.find((item) => item.version.artifactVersionId === selectedVersionId) ?? null
    : versions.find((item) => item.version.artifactVersionId === latestId) ?? versions.at(-1) ?? null;
  const requestedVersion = versions.find((item) => item.version.artifactVersionId === readingVersionId) ?? active;

  async function open(item: { artifactId: string; version: RelayArtifactVersionSummary; title: string }) {
    const version = ++readRequest.current;
    setReadingVersionId(item.version.artifactVersionId); setReadingLoading(true);
    setReading(null); setReadingError(null); setCompare(null); setCompareError(null); setCompareWith(""); setCompareLoading(false);
    try {
      const content = await client.getArtifactVersionContent(item.version.artifactVersionId);
      if (version !== readRequest.current) return;
      setReading({ version: item.version, title: item.title, content });
    } catch (caught) {
      if (version !== readRequest.current) return;
      setReading(null); setReadingError(describeContentError(caught));
    } finally { if (version === readRequest.current) setReadingLoading(false); }
  }

  // 确切版本默认直接展开正文：阅读是主区职责，不要求用户先点一次按钮。
  useEffect(() => {
    if (loading) return;
    if (!active) {
      readRequest.current++; setReading(null); setReadingVersionId(null); setReadingLoading(false);
      setCompare(null); setCompareError(null); setCompareLoading(false);
      return;
    }
    void open(active);
  }, [client, loading, active?.version.artifactVersionId]);

  function savedAt(value: string): string {
    const at = Date.parse(value);
    if (!Number.isFinite(at)) return value;
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at)).replaceAll("/", "-");
  }

  async function openCompare() {
    const base = versions.find((item) => item.version.artifactVersionId === compareWith);
    const head = requestedVersion;
    if (!base || !head || base.version.artifactVersionId === head.version.artifactVersionId || readingLoading || compareLoading) return;
    const version = ++readRequest.current;
    setCompareError(null); setCompareLoading(true);
    try {
      const [baseContent, headContent] = await Promise.all([
        client.getArtifactVersionContent(base.version.artifactVersionId),
        client.getArtifactVersionContent(head.version.artifactVersionId)
      ]);
      if (version !== readRequest.current) return;
      setCompare({ base: { version: base.version, title: base.title, content: baseContent },
        head: { version: head.version, title: head.title, content: headContent } });
    } catch (caught) {
      if (version !== readRequest.current) return;
      setCompare(null); setCompareError(describeContentError(caught));
    } finally { if (version === readRequest.current) setCompareLoading(false); }
  }

  const document = reading ?? requestedVersion;
  const documentState = loading || readingLoading ? "loading" : error || readingError ? "error" : reading ? "ready" : "empty";
  const hasContent = reading !== null || compare !== null || (draft?.previewAvailable === true && draft.previewText !== null);
  const versionControls = versions.length > 0 && <details className="collab-version-details" onKeyDown={(event) => {
    if (!compact || !event.currentTarget.open || event.key !== "Escape" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.open = false;
    event.currentTarget.querySelector("summary")?.focus({ preventScroll: true });
  }}>
      <summary>版本与比较 · {versions.length} 个已保存版本</summary>
      {compact && document && <p className="helper-text">最后保存：{savedAt(document.version.createdAt)}</p>}
      <p className="helper-text">最新、当前选用与本轮接受三者分别表达，不互相继承。</p>
      <button className="text-button" type="button" data-testid="collab-reader-refresh" disabled={loading || readingLoading || compareLoading} onClick={() => void load()}>刷新产物与确切正文</button>
    {versions.length > 0 && <ul className="version-list version-list--compact">{versions.map((item) => {
      const isLatest = artifacts?.items.some((artifact) => artifact.latestVersionId === item.version.artifactVersionId) === true;
      const isReading = reading?.version.artifactVersionId === item.version.artifactVersionId;
      return <li key={item.version.artifactVersionId}
        className={`version-row version-row--compact${isReading ? " version-row--active" : ""}`}>
        <span className="version-copy"><strong>v{item.version.versionNumber} · {item.title}</strong>
          <small>sha256 {item.version.sha256.slice(0, 12)}… · {item.version.size} 字节 · {item.version.sourceKind}</small></span>
        <span className="version-tags">
          {isLatest && <span className="status-chip">最新</span>}
          {stateRefs.some((ref) => ref.artifactVersionId === item.version.artifactVersionId) && <span className="status-chip status-chip--neutral">当前选用</span>}
          {artifacts?.currentAcceptedVersionIds.includes(item.version.artifactVersionId) && <span className="status-chip status-chip--neutral">本轮接受</span>}
        </span>
        <button className="secondary-button" type="button" data-testid={`collab-read-${item.version.artifactVersionId}`}
          onClick={() => void open(item)}>{isReading ? "正在阅读" : "展开阅读"}</button>
        <Link className="inline-link" to={`/artifact-versions/${item.version.artifactVersionId}/lineage`}>来源与历史</Link>
      </li>;
    })}</ul>}
    {versions.length > 1 && <div className="collab-compare-controls">
      <label className="field"><span className="field-label">与哪一版比较</span>
        <select data-testid="collab-compare-base" value={compareWith} onChange={(event) => setCompareWith(event.target.value)}>
          <option value="">选择基线版本</option>
          {versions.filter((item) => item.version.artifactVersionId !== requestedVersion?.version.artifactVersionId)
            .map((item) => <option key={item.version.artifactVersionId} value={item.version.artifactVersionId}>v{item.version.versionNumber} · {item.title}</option>)}
        </select></label>
      <button className="secondary-button" type="button" data-testid="collab-compare-open" disabled={!compareWith || !requestedVersion || readingLoading || compareLoading}
        onClick={() => void openCompare()}>{compareLoading ? "正在读取比较版本" : "比较两份确切版本"}</button>
    </div>}
    </details>;
  const documentHeading = document && <header className="artifact-doc-heading">
    <div>
      <h3>{document.title} <span className="artifact-doc-version" title={`最后保存：${savedAt(document.version.createdAt)}`}>· v{document.version.versionNumber} · {reading ? compact ? "已保存" : "已保存版本" : readingError ? "正文读取失败" : "正在读取正文"}</span></h3>
      {!compact && <p className="helper-text">最后保存：{savedAt(document.version.createdAt)}</p>}
    </div>
    <div className="artifact-doc-actions">{compact && versionControls}<Link className="text-link" to={`/tasks/${taskId}?tab=artifacts`}>{compact ? "编辑 ↗" : "在编辑器中打开 ↗"}</Link></div>
  </header>;
  const readerContent = <>
    {!compact && <h2>产物</h2>}
    {loading && <p className="helper-text" role="status">正在读取产物版本…</p>}
    {error && <p className="action-error" role="alert" data-testid="collab-artifact-error">{error}
      <button className="secondary-button" type="button" onClick={() => void load()}>重新读取产物</button></p>}
    {!loading && !error && versions.length === 0 && <div className="collab-artifact-state"><h3>暂时没有已保存产物</h3><p className="helper-text">保存首版后，这里会显示正文与版本。执行中的预览单独展示，不计为已保存版本。</p></div>}
    {!loading && !error && selectedVersionId !== null && active === null && <div className="collab-artifact-state" role="alert" data-testid="collab-bound-version-unavailable"><h3>绑定版本暂不可读</h3><p className="helper-text">当前版本列表没有返回所引用的确切版本，不会用最新版替代。</p><details><summary>核对版本身份</summary><p className="helper-text">版本 ID：{selectedVersionId}</p></details><button className="secondary-button" type="button" onClick={() => void load()}>重新读取版本</button></div>}

    {draft?.previewAvailable && draft.previewText !== null && <section className="collab-draft" data-testid="collab-run-draft">
      <h3>生成中预览 · 未保存</h3>
      <p className="helper-text">Run DRAFT 当前轮次 · 预览 v{draft.previewRevision}{draft.previewTruncated ? " · 已截断" : ""}。这是生成中的草稿，不是受管产物、不是验证通过，也不是任务完成。</p>
      <pre className="collab-draft-text">{draft.previewText}</pre>
    </section>}


    {/* 文档头：文件名 · 版本 · 保存状态 · 最后保存时间；正文紧随其后。 */}
    {reading && <section className="artifact-doc" data-testid="collab-artifact-doc">
      {!compact && documentHeading}
      <div className="artifact-doc-body" data-testid="collab-reading"><SafeMarkdown source={reading.content} /></div>
    </section>}

    {readingLoading && <p className="helper-text" role="status" data-testid="collab-read-loading">正在读取当前版本正文…</p>}
    {readingError && <div className="collab-artifact-state" data-testid="collab-read-error" role="alert">
      <h3>正文读取失败</h3><p className="helper-text">{readingError}</p>
      <div className="form-actions"><button className="secondary-button" type="button" data-testid="collab-read-retry"
        onClick={() => { if (requestedVersion) void open(requestedVersion); }}>重试读取正文</button>
      <Link className="text-link" to={`/tasks/${taskId}?tab=artifacts`}>查看任务产物</Link></div>
    </div>}

    {!compact && versionControls}

    {compareError && <p className="action-error" role="alert">{compareError}</p>}
    {compare && <section className="collab-compare" data-testid="collab-compare">
      <h3>版本比较</h3>
      <p className="helper-text">基线 v{compare.base.version.versionNumber} → 当前 v{compare.head.version.versionNumber}。比较只读，不写回任何版本，也不代表接受。</p>
      <div className="collab-compare-columns">
        <article><h4>v{compare.base.version.versionNumber} · 基线</h4><SafeMarkdown source={compare.base.content} /></article>
        <article><h4>v{compare.head.version.versionNumber} · 当前</h4><SafeMarkdown source={compare.head.content} /></article>
      </div>
    </section>}

  </>;
  return <div className={compact ? "collab-reader" : "surface-panel"} data-testid="collab-artifact-reader"
    data-document-state={documentState} data-has-content={hasContent}>
    {compact ? <>{documentHeading}{!documentHeading && versionControls}<div className="collab-document-paper">
      <div className="collab-reader-scroll">{readerContent}</div>
      {selectedVersionId !== null && active && requestedVersion && requestedVersion.version.artifactVersionId !== selectedVersionId &&
        <p className="collab-review-version-mismatch warning-callout" role="status" data-testid="collab-review-version-mismatch">
          正在阅读 v{requestedVersion.version.versionNumber}；当前判断仍绑定「{active.title}」v{active.version.versionNumber}。
          <button className="text-button" type="button" onClick={() => void open(active)}>返回判断版本</button>
        </p>}
      {paperFooter}
    </div></> : readerContent}
  </div>;
}
