import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import SafeMarkdown from "./SafeMarkdown";
import type { RelayApiClient, RelayArtifactVersionSummary, RelayRunDraftPreview, RelayTaskArtifacts } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

interface Reading {
  readonly version: RelayArtifactVersionSummary;
  readonly title: string;
  readonly content: string;
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
  const [compareWith, setCompareWith] = useState("");
  const [compare, setCompare] = useState<{ base: Reading; head: Reading } | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const request = useRef(0);
  const readRequest = useRef(0);

  async function load() {
    const version = ++request.current;
    setLoading(true); setError(null);
    try {
      const [loaded, state] = await Promise.all([
        client.getTaskArtifacts(taskId),
        projectId === null ? Promise.resolve(null) : client.getProjectState(projectId).catch(() => null)
      ]);
      if (version !== request.current) return;
      setArtifacts(loaded);
      setStateRefs(state?.selectedArtifactVersionRefs ?? []);
    } catch (caught) {
      if (version === request.current) { setArtifacts(null); setStateRefs([]); setError(describeLiveError(caught).message); }
    } finally { if (version === request.current) setLoading(false); }
  }

  useEffect(() => {
    readRequest.current++;
    setReading(null); setReadingError(null); setCompare(null); setCompareError(null); setCompareWith("");
    void load();
    return () => { request.current++; readRequest.current++; };
  }, [client, taskId, projectId]);

  const versions: readonly { readonly artifactId: string; readonly version: RelayArtifactVersionSummary; readonly title: string }[] =
    artifacts?.items.flatMap((artifact) => artifact.versions.map((version) => ({ artifactId: artifact.id, version, title: artifact.title }))) ?? [];
  // 默认阅读确切选中的版本，否则读该产物声明的 latest；数组顺序不是版本新旧，不能用末位冒充最新。
  const latestId = artifacts?.items.find((artifact) => artifact.versions.length > 0)?.latestVersionId ?? null;
  const active = versions.find((item) => item.version.artifactVersionId === selectedVersionId)
    ?? versions.find((item) => item.version.artifactVersionId === latestId)
    ?? versions.at(-1) ?? null;

  async function open(item: { artifactId: string; version: RelayArtifactVersionSummary; title: string }) {
    const version = ++readRequest.current;
    setReadingError(null); setCompare(null);
    try {
      const content = await client.getArtifactVersionContent(item.version.artifactVersionId);
      if (version !== readRequest.current) return;
      setReading({ version: item.version, title: item.title, content });
    } catch (caught) {
      if (version !== readRequest.current) return;
      setReading(null); setReadingError(describeLiveError(caught).message);
    }
  }

  // 确切版本默认直接展开正文：阅读是主区职责，不要求用户先点一次按钮。
  useEffect(() => {
    if (!active || reading !== null) return;
    const version = ++readRequest.current;
    void client.getArtifactVersionContent(active.version.artifactVersionId).then((content) => {
      if (version !== readRequest.current) return;
      setReading({ version: active.version, title: active.title, content });
    }, (caught: unknown) => {
      if (version !== readRequest.current) return;
      setReading(null); setReadingError(describeLiveError(caught).message);
    });
  }, [client, active, reading]);

  function savedAt(value: string): string {
    const at = Date.parse(value);
    if (!Number.isFinite(at)) return value;
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at)).replaceAll("/", "-");
  }

  async function openCompare() {
    const base = versions.find((item) => item.version.artifactVersionId === compareWith);
    if (!base || !active) return;
    const version = ++readRequest.current;
    setCompareError(null);
    try {
      const [baseContent, headContent] = await Promise.all([
        client.getArtifactVersionContent(base.version.artifactVersionId),
        client.getArtifactVersionContent(active.version.artifactVersionId)
      ]);
      if (version !== readRequest.current) return;
      setCompare({ base: { version: base.version, title: base.title, content: baseContent },
        head: { version: active.version, title: active.title, content: headContent } });
    } catch (caught) {
      if (version !== readRequest.current) return;
      setCompare(null); setCompareError(describeLiveError(caught).message);
    }
  }

  const documentHeading = reading && <header className="artifact-doc-heading">
    <div>
      <h3>{reading.title} <span className="artifact-doc-version">· v{reading.version.versionNumber} · 已保存版本</span></h3>
      <p className="helper-text">最后保存：{savedAt(reading.version.createdAt)}</p>
    </div>
    <Link className="text-link" to={`/tasks/${taskId}?tab=artifacts`}>在编辑器中打开 ↗</Link>
  </header>;
  const readerContent = <>
    {!compact && <h2>产物</h2>}
    {!compact && <p className="helper-text">“最新”来自版本列表，“当前选用”来自项目 State，“本轮接受”来自当前完成凭据；三者分别表达，不互相继承。</p>}
    {loading && <p className="helper-text" role="status">正在读取产物版本…</p>}
    {error && <p className="action-error" role="alert" data-testid="collab-artifact-error">{error}
      <button className="secondary-button" type="button" onClick={() => void load()}>重新读取产物</button></p>}
    {!loading && !error && versions.length === 0 && <p className="helper-text">该任务还没有已保存的产物版本。执行中的生成中草稿见下方，不计为版本。</p>}

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

    {versions.length > 0 && <details className="collab-version-details" open={compact ? undefined : true}>
      <summary>版本与比较 · {versions.length} 个已保存版本</summary>
      <p className="helper-text">最新、当前选用与本轮接受三者分别表达，不互相继承。</p>
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
          {versions.filter((item) => item.version.artifactVersionId !== active?.version.artifactVersionId)
            .map((item) => <option key={item.version.artifactVersionId} value={item.version.artifactVersionId}>v{item.version.versionNumber} · {item.title}</option>)}
        </select></label>
      <button className="secondary-button" type="button" data-testid="collab-compare-open" disabled={!compareWith || !active}
        onClick={() => void openCompare()}>比较两份确切版本</button>
    </div>}
    </details>}

    {compareError && <p className="action-error" role="alert">{compareError}</p>}
    {compare && <section className="collab-compare" data-testid="collab-compare">
      <h3>版本比较</h3>
      <p className="helper-text">基线 v{compare.base.version.versionNumber} → 当前 v{compare.head.version.versionNumber}。比较只读，不写回任何版本，也不代表接受。</p>
      <div className="collab-compare-columns">
        <article><h4>v{compare.base.version.versionNumber} · 基线</h4><SafeMarkdown source={compare.base.content} /></article>
        <article><h4>v{compare.head.version.versionNumber} · 当前</h4><SafeMarkdown source={compare.head.content} /></article>
      </div>
    </section>}

    {readingError && <p className="action-error" role="alert" data-testid="collab-read-error">{readingError}</p>}
    {!reading && !compare && versions.length > 0 && active &&
      <p className="helper-text">正在读取当前版本正文；展开阅读不会改变当前选用、执行或接受。</p>}
  </>;
  return <div className={compact ? "collab-reader" : "surface-panel"} data-testid="collab-artifact-reader">
    {compact ? <>{documentHeading}<div className="collab-document-paper">
      <div className="collab-reader-scroll">{readerContent}</div>
      {paperFooter}
    </div></> : readerContent}
  </div>;
}
