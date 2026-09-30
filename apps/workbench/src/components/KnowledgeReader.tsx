import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { RelayApiClient, RelayKnowledge, RelayKnowledgeVersion,
  RelayKnowledgeVersionContent } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import SafeMarkdown from "./SafeMarkdown";

interface Props {
  readonly client: RelayApiClient;
  readonly knowledge: RelayKnowledge;
  readonly versions: readonly RelayKnowledgeVersion[];
  readonly initialVersion: string | null;
  readonly onNewVersion?: () => void;
  readonly newVersionDisabled?: boolean;
}

const sourceLabels: Readonly<Record<string, string>> = {
  NOTE: "本地笔记", MANAGED_TEXT: "已保存文本", ARTIFACT_VERSION: "产物版本引用",
  WEB_PAGE: "已保存网页快照",
};

export default function KnowledgeReader({ client, knowledge, versions, initialVersion, onNewVersion, newVersionDisabled }: Props) {
  const [version, setVersion] = useState(() => initialVersion ?? knowledge.currentVersion);
  const [content, setContent] = useState<RelayKnowledgeVersionContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [headings, setHeadings] = useState<readonly string[]>([]);
  const [activeHeading, setActiveHeading] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveHeading(0);
    if (!/^[1-9][0-9]{0,18}$/u.test(version) || BigInt(version) > 9223372036854775807n) {
      setContent(null); setHeadings([]); setLoading(false); setError("指定的版本号无效。"); return;
    }
    if (versions.length === 0 && initialVersion === null) return;
    let active = true;
    setContent(null); setHeadings([]); setError(null); setLoading(true);
    void client.getKnowledgeVersionContent(knowledge.id, version).then((read) => {
      if (active) setContent(read);
    }).catch((caught: unknown) => {
      if (active) setError(describeLiveError(caught).message);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, knowledge.id, version, retry, versions.length]);

  useEffect(() => {
    if (content?.contentStatus !== "FULL" || content.mediaType !== "text/markdown") {
      setHeadings([]); return;
    }
    setHeadings(Array.from(bodyRef.current?.querySelectorAll(".markdown-preview__heading, .markdown-preview__subheading") ?? [])
      .map((heading) => heading.textContent?.trim() ?? ""));
  }, [content]);

  function jumpToHeading(index: number) {
    const target = bodyRef.current?.querySelectorAll<HTMLElement>(
      ".markdown-preview__heading, .markdown-preview__subheading")[index];
    if (!target) return;
    setActiveHeading(index);
    target.setAttribute("tabindex", "-1");
    target.focus();
    target.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }

  const selected = versions.find((item) => item.version === version);
  const artifactVersionId = content?.sourceRefs.artifact_version_id;
  const sourceUri = content?.sourceUri;
  return <section className={`knowledge-reader${headings.length === 0 ? " knowledge-reader--no-toc" : ""}`} aria-label="资料正文与来源" data-testid="knowledge-reader">
    {headings.length > 0 && <aside className="knowledge-reader__outline">
      <nav className="knowledge-reader__toc" aria-label="本文目录"><h2>本文目录</h2>
        <ol>{headings.map((heading, index) => <li key={`${index}-${heading}`}><button type="button"
          className={index === activeHeading ? "knowledge-reader__toc-current" : undefined}
          aria-current={index === activeHeading ? "location" : undefined}
          onClick={() => jumpToHeading(index)}>{heading}</button></li>)}</ol>
      </nav>
    </aside>}
    <div className="knowledge-reader__main">
      <header className="knowledge-reader__heading">
        <h1>{content?.title ?? knowledge.title}</h1>
        <p>{sourceLabels[content?.sourceKind ?? selected?.sourceKind ?? ""] ?? "资料"} · {knowledge.projectId ? "项目资料" : "工作空间"}</p>
      </header>
      <div className="knowledge-reader__toolbar">
        <label className="field" htmlFor="knowledge-reader-version"><span className="visually-hidden">阅读版本</span>
          <select id="knowledge-reader-version" value={version} data-testid="knowledge-reader-version"
            onChange={(event) => setVersion(event.target.value)}>
            {!selected && <option value={version}>v{version} · 指定版本（列表未包含）</option>}
            {versions.map((item) =>
              <option key={item.id} value={item.version}>v{item.version}{item.version === knowledge.currentVersion ? " · 当前版本" : " · 历史版本"}</option>)}</select></label>
        {selected && <span className="helper-text">保存于 {selected.createdAt}</span>}
      </div>
      {loading && <p role="status">正在读取 v{version} 的确切正文…</p>}
      {error && <p className="action-error" role="alert">v{version} 正文读取失败：{error} <button type="button"
        className="text-button" onClick={() => setRetry((value) => value + 1)}>重试读取</button></p>}
      {content && <>
        {content.contentStatus === "FULL" && <>
          <p className="knowledge-reader__status">{content.sourceKind === "WEB_PAGE"
            ? "已保存网页快照全文；当前网页可能已经变化。" : "已保存的完整正文"} · v{content.version}</p>
          <div ref={bodyRef} className="knowledge-reader__body" data-testid="knowledge-reader-body">
            {content.mediaType === "text/markdown" ? <SafeMarkdown source={content.content ?? ""} />
              : <pre className="knowledge-reader__plain">{content.content}</pre>}
          </div>
        </>}
        {content.contentStatus === "PARTIAL" && <p className="knowledge-reader__partial" role="status">仅保存了部分内容，不能视为全文。<span className="knowledge-body">{content.content}</span></p>}
        {content.contentStatus === "UNAVAILABLE" && <p role="status">该版本的已保存正文不可用，无法用其他版本替代。</p>}
        {content.contentStatus === "UNSUPPORTED" && <p role="status">该版本的内容格式暂不支持阅读：{content.mediaType}。</p>}
        {content.contentStatus === "READ_FAILED" && <p role="alert">该版本内容校验或读取失败；未显示未经核对的正文。</p>}
      </>}
      {!loading && !content && !error && versions.length === 0 && <p className="helper-text">暂无可读版本。</p>}
    </div>
    <aside className="knowledge-reader__source" aria-label="来源与版本">
      <h2>来源与版本</h2>
      {content ? <><dl><dt>来源类型</dt><dd>{sourceLabels[content.sourceKind] ?? content.sourceKind}</dd>
        <dt>范围</dt><dd>{content.projectId ? `项目 ${content.projectId}` : "工作空间"}</dd>
        <dt>保存时间</dt><dd>{content.createdAt}</dd>
        <dt>所选版本</dt><dd>v{content.version}{content.version === content.currentVersion ? " · 当前" : " · 历史"}</dd></dl>
      {typeof artifactVersionId === "string" && <p><Link to={`/artifact-versions/${encodeURIComponent(artifactVersionId)}/lineage`}>查看确切产物版本来源</Link></p>}
      {typeof sourceUri === "string" && /^https?:\/\//iu.test(sourceUri) && <p><a href={sourceUri} target="_blank" rel="noopener noreferrer">打开当前网页原件</a><small>原件可能已变化；阅读的是保存时快照。</small></p>}
      </> : <p className="helper-text">{loading ? "正在读取所选版本的来源…" : "所选版本的正文来源尚不可用。"}</p>}
      <section className="knowledge-reader__version-note"><h3>版本说明</h3>
        <p>历史引用始终指向原版本；编辑会保存为新版本，不会更新已有引用。</p>
      </section>
      <details className="knowledge-history"><summary>不可变资料版本 · {versions.length}</summary><ol>{versions.map((item) =>
        <li key={item.id}><button type="button" className="text-button" onClick={() => setVersion(item.version)}
          aria-current={item.version === version ? "true" : undefined}>v{item.version} · {sourceLabels[item.sourceKind] ?? item.sourceKind}</button>
          <p>{item.excerpt ?? "该版本引用受管产物，无内联摘录。"}</p></li>)}</ol></details>
      {onNewVersion && <button type="button" className="primary-button knowledge-reader__edit" data-testid="knowledge-new-version"
        disabled={newVersionDisabled} onClick={onNewVersion}>编辑为新版本</button>}
      <p className="helper-text">阅读不会将正文发送给 AI；使用范围由现有选源与权限决定。</p>
    </aside>
  </section>;
}
