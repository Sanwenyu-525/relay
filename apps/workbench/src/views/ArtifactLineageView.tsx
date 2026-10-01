import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { RelayApiError, type RelayArtifactDirectUses, type RelayArtifactLineage } from "../api/relayClient";
import ArtifactVersionCompare from "../components/ArtifactVersionCompare";
import ArtifactTextLocksPanel from "../components/ArtifactTextLocksPanel";
import ArtifactImpactCheckPanel from "../components/ArtifactImpactCheckPanel";
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
  const [uses, setUses] = useState<RelayArtifactDirectUses | null>(null);
  const [usesLoading, setUsesLoading] = useState(false);
  const [usesError, setUsesError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const usesRequest = useRef(0);
  useEffect(() => {
    const request = ++requestVersion.current;
    usesRequest.current++;
    setUses(null); setUsesLoading(false); setUsesError(null);
    setLineage(null); setError(null); setLoading(client !== null);
    if (client === null) return;
    void client.getArtifactLineage(id).then((next) => {
      if (next.artifactVersionId !== id) throw new Error("来源关系与当前产物版本不匹配。");
      if (request === requestVersion.current) setLineage(next);
    }).catch((caught: unknown) => {
      if (request === requestVersion.current) setError(caught instanceof RelayApiError && [403, 404].includes(caught.problem.status)
        ? "该产物版本当前不可读取或无权查看；旧来源详情已清除。" : describeLiveError(caught).message);
    }).finally(() => { if (request === requestVersion.current) setLoading(false); });
    return () => { requestVersion.current++; usesRequest.current++; };
  }, [client, id, reload]);

  async function checkDirectUses() {
    if (!client || !lineage || usesLoading) return;
    const request = ++usesRequest.current;
    setUsesLoading(true); setUsesError(null); setUses(null);
    try {
      const result = await client.getArtifactDirectUses(lineage.artifactVersionId);
      if (request !== usesRequest.current) return;
      if (result.sourceArtifactVersionId !== lineage.artifactVersionId)
        throw new Error("直接引用检查返回了其他来源版本。");
      setUses(result);
    } catch (caught) { if (request === usesRequest.current) setUsesError(describeLiveError(caught).message); }
    finally { if (request === usesRequest.current) setUsesLoading(false); }
  }

  return <section className="lineage-page" data-testid="artifact-lineage"><p className="eyebrow">产物来源</p><h1>来源追溯</h1>
    <p className="page-lede">这里展示这个版本在服务端确认过的直接来源；完整因果关系与正文仍以原版本和 Run 证据为准。</p>
    {client === null ? <p className="warning-callout" role="status">示例数据没有真实产物来源关系。<Link to="/tasks">返回任务</Link></p> : <>
      <button className="secondary-button" type="button" disabled={loading} onClick={() => setReload((value) => value + 1)}>刷新来源</button>
      {loading && <p role="status">正在读取版本 {id} 的来源关系…</p>}
      {error && <p className="action-error" role="alert">{error}</p>}
      {lineage && <><section className="surface-panel lineage-summary"><h2>确切版本 · v{lineage.versionNumber}</h2>
        <p>{lineage.contentAvailability === "AVAILABLE" ? "历史正文当前可读取；正文接口仍单独鉴权。" : "历史正文不可用或无权读取，不以最新版替代。"}</p>
        <details className="page-explanation"><summary>核对版本身份与内容指纹</summary><dl><div><dt>Version ID</dt><dd>{lineage.artifactVersionId}</dd></div><div><dt>Artifact ID</dt><dd>{lineage.artifactId}</dd></div>
          <div><dt>版本</dt><dd>v{lineage.versionNumber}</dd></div><div><dt>来源类型</dt><dd>{lineage.sourceKind}</dd></div>
          <div><dt>内容 sha256</dt><dd>{lineage.sha256}</dd></div><div><dt>历史正文</dt><dd>{lineage.contentAvailability === "AVAILABLE" ? "当前可读取；正文仍须通过原内容接口单独鉴权" : "不可用或无权读取，不以最新版替代"}</dd></div></dl></details>
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
          : <p className="helper-text">服务端未记录直接父来源；不从相同标题、时间或版本号推断关系。</p>}</section>
        <ArtifactVersionCompare key={lineage.artifactVersionId} client={client} lineage={lineage} />
        <ArtifactTextLocksPanel key={`locks-${lineage.artifactVersionId}`} client={client} lineage={lineage} />
        <ArtifactImpactCheckPanel key={`impact-${lineage.artifactVersionId}`} client={client} lineage={lineage} />
        <section className="surface-panel lineage-uses" data-testid="artifact-direct-uses"><h2>主动检查直接引用</h2>
          <p className="helper-text">只检查服务端已登记、直接指向版本 {lineage.artifactVersionId} 的派生或修订关系。未登记关系、间接下游和语义影响仍未分析。</p>
          <button className="secondary-button" type="button" disabled={usesLoading} onClick={() => void checkDirectUses()}>{usesLoading ? "正在检查" : "检查已登记直接引用"}</button>
          {usesError && <p className="action-error" role="alert">{usesError}；不能据此判断没有影响。</p>}
          {uses && (uses.sourceContentAvailability === "UNAVAILABLE" ? <p className="warning-callout">来源版本正文不可用；直接引用未展示，影响仍待核对。</p>
            : <><p className="helper-text">检查结果仅覆盖已登记的直接关系，完整影响范围未知。{uses.hasMore ? "还有未展示的登记关系。" : "本次登记关系已展示完毕。"}</p>
              {uses.directUses.length ? <ul>{uses.directUses.map((edge, index) => <li key={`${edge.childArtifactVersionId ?? "hidden"}-${index}`}>
                <strong>{edge.relation === "DERIVED_FROM" ? "派生自此版本" : "修订自此版本"}</strong> · {edge.createdAt}
                {edge.availability === "AVAILABLE" && edge.childArtifactVersionId
                  ? <p><Link className="inline-link" to={`/artifact-versions/${edge.childArtifactVersionId}/lineage`}>打开直接引用版本 v{edge.childVersionNumber}</Link></p>
                  : <p>该关系的子版本不可读取或无权查看；身份与正文未展示。</p>}</li>)}</ul>
                : <p className="helper-text">未记录可展示的直接引用；这不代表没有影响。</p>}</>)}
        </section></>}
    </>}
  </section>;
}
