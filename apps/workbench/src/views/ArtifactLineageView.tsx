import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { RelayApiError, type RelayArtifactLineage } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import "./ArtifactLineageView.css";

const relationLabels = {
  DERIVED_FROM: "派生自", REVISED_FROM: "修订自", GENERATED_BY: "生成于", VERIFIED_BY: "经验证", ACCEPTED_BY: "经接受"
} as const;
const parentLabels = {
  ARTIFACT_VERSION: "产物版本", KNOWLEDGE_VERSION: "资料版本", RUN_STEP: "Run 步骤",
  VERIFICATION_SESSION: "验证会话", COMPLETION_RECORD: "完成凭据"
} as const;

export default function ArtifactLineageView() {
  const { id = "" } = useParams();
  const connection = useRelayConnection();
  const client = connection.mode === "live" ? connection.client : null;
  const [lineage, setLineage] = useState<RelayArtifactLineage | null>(null);
  const [loading, setLoading] = useState(client !== null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const requestVersion = useRef(0);
  useEffect(() => {
    const request = ++requestVersion.current;
    setLineage(null); setError(null); setLoading(client !== null);
    if (client === null) return;
    void client.getArtifactLineage(id).then((next) => {
      if (next.artifactVersionId !== id) throw new Error("来源关系与当前产物版本不匹配。");
      if (request === requestVersion.current) setLineage(next);
    }).catch((caught: unknown) => {
      if (request === requestVersion.current) setError(caught instanceof RelayApiError && [403, 404].includes(caught.problem.status)
        ? "该产物版本当前不可读取或无权查看；旧来源详情已清除。" : describeLiveError(caught).message);
    }).finally(() => { if (request === requestVersion.current) setLoading(false); });
    return () => { requestVersion.current++; };
  }, [client, id, reload]);

  return <section className="lineage-page" data-testid="artifact-lineage"><p className="eyebrow">产物来源</p><h1>Artifact Lineage</h1>
    <p className="page-lede">只展示服务端确认的当前版本与直接父来源；关系记录不等于完整因果图，也不替代原版本正文。</p>
    {client === null ? <p className="warning-callout" role="status">示例数据没有真实产物来源关系。<Link to="/tasks">返回任务</Link></p> : <>
      <button className="secondary-button" type="button" disabled={loading} onClick={() => setReload((value) => value + 1)}>刷新来源</button>
      {loading && <p role="status">正在读取版本 {id} 的来源关系…</p>}
      {error && <p className="action-error" role="alert">{error}</p>}
      {lineage && <><section className="surface-panel lineage-summary"><h2>确切版本</h2>
        <dl><div><dt>Version ID</dt><dd>{lineage.artifactVersionId}</dd></div><div><dt>Artifact ID</dt><dd>{lineage.artifactId}</dd></div>
          <div><dt>版本</dt><dd>v{lineage.versionNumber}</dd></div><div><dt>来源类型</dt><dd>{lineage.sourceKind}</dd></div>
          <div><dt>内容 sha256</dt><dd>{lineage.sha256}</dd></div><div><dt>历史正文</dt><dd>{lineage.contentAvailability === "AVAILABLE" ? "当前可读取；正文仍须通过原内容接口单独鉴权" : "不可用或无权读取，不以最新版替代"}</dd></div></dl>
      </section><section className="surface-panel lineage-parents"><h2>直接父来源 · {lineage.directParents.length}</h2>
        {lineage.directParents.length ? <ul>{lineage.directParents.map((edge) => <li key={edge.id}><strong>{relationLabels[edge.relation]} · {parentLabels[edge.parentKind]}</strong>
          <small>关系 ID {edge.id} · 记录时间 {edge.createdAt}</small>
          {edge.availability === "UNAVAILABLE" || edge.parentId === null
            ? <p>父来源当前不可用或无权读取；不显示其 ID，也不拿当前内容顶替。</p>
            : edge.parentKind === "ARTIFACT_VERSION"
              ? <p><Link className="inline-link" to={`/artifact-versions/${edge.parentId}/lineage`}>打开父产物版本 {edge.parentId}</Link></p>
              : edge.parentKind === "COMPLETION_RECORD"
                ? <p><Link className="inline-link" to={`/completion-records/${edge.parentId}`}>打开完成凭据 {edge.parentId}</Link></p>
              : <p>父来源 ID {edge.parentId}；当前没有该类型的确切直达页。</p>}</li>)}</ul>
          : <p className="helper-text">服务端未记录直接父来源；不从相同标题、时间或版本号推断关系。</p>}</section></>}
    </>}
  </section>;
}
