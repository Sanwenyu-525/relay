import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { RelayApiError, type RelayCompletionEvidence } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import ResponsiveRail from "../components/ResponsiveRail";
import { useRelayConnection } from "../lib/relayConnection";
import "./CompletionRecordView.css";

export default function CompletionRecordView() {
  const { id = "" } = useParams();
  const connection = useRelayConnection();
  const client = connection.mode === "live" ? connection.client : null;
  const key = `${connection.epoch}:${id}`;
  const [loaded, setLoaded] = useState<{ key: string; value: RelayCompletionEvidence } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [reload, setReload] = useState(0);
  const requestVersion = useRef(0);

  useEffect(() => {
    const request = ++requestVersion.current;
    setLoaded(null); setFailure(null);
    if (client === null) return;
    void client.getCompletionEvidence(id).then((value) => {
      if (value.completionId !== id) throw new Error("完成凭据与当前目标不匹配。");
      if (request === requestVersion.current) setLoaded({ key, value });
    }).catch((caught: unknown) => {
      if (request === requestVersion.current) setFailure({ key, message:
        caught instanceof RelayApiError && [403, 404].includes(caught.problem.status)
          ? "该完成凭据当前不可读取或无权查看；旧详情已清除。"
          : describeLiveError(caught).message });
    });
    return () => { requestVersion.current++; };
  }, [client, id, key, reload]);

  const evidence = loaded?.key === key ? loaded.value : null;
  const error = failure?.key === key ? failure.message : null;
  return <section className="completion-page" data-testid="completion-record"><div className="page-layout"><div className="page-primary"><p className="eyebrow">完成凭据</p><h1>历史完成依据</h1>
    <p className="page-lede">按这一次完成提交时的验收版本与证据读取；重开后旧凭据仍是历史记录，不用当前最新版替代。</p>
    {client === null ? <p className="warning-callout" role="status">示例数据没有真实完成凭据。<Link to="/tasks">返回任务</Link></p> : <>
      <button className="secondary-button" type="button" onClick={() => { setLoaded(null); setFailure(null); setReload((value) => value + 1); }}>重读凭据</button>
      {!evidence && !error && <p role="status">正在读取完成凭据…</p>}
      {error && <p className="action-error" role="alert">{error}</p>}
      {evidence && <>
        <section className="surface-panel completion-section"><h2>当时验收条件</h2>
          {evidence.acceptance.availability === "UNAVAILABLE" ? <p>历史验收内容不可用或无权读取；不展示正文，也不以当前验收版本替代。</p> : <>
            <p>{evidence.acceptance.objective ?? "当时未记录目标正文。"}</p>
            <p className="helper-text">来源：{evidence.acceptance.source ?? "未记录"} · 创建时间：{evidence.acceptance.createdAt ?? "未记录"}</p>
            <p className="helper-text">预期输出：{evidence.acceptance.expectedOutputs === null ? "未记录" : JSON.stringify(evidence.acceptance.expectedOutputs)}</p>
            {evidence.acceptance.criteria.length ? <ul className="completion-list">{evidence.acceptance.criteria.map((item) => <li key={item.criterionId}>
              <strong>{item.statement}</strong><small>条件 {item.criterionId} · {item.required ? "必需" : "可选"} · {item.method}</small>
              <small>当时目标规格：{JSON.stringify(item.targetSpec)}</small>
            </li>)}</ul> : <p className="helper-text">当时未记录验收条件。</p>}
          </>}
        </section>
        {evidence.humanAcceptance && <section className="surface-panel completion-section"><h2>人工接受记录</h2>
          {evidence.humanAcceptance.availability === "UNAVAILABLE" ? <p>人工接受记录不可用或无权读取；不展示引用 ID 或正文。</p> : <dl className="completion-facts">
            <div><dt>记录 ID</dt><dd>{evidence.humanAcceptance.id ?? "未记录"}</dd></div>
            <div><dt>接受者类型</dt><dd>{evidence.humanAcceptance.actorKind ?? "未记录"}</dd></div>
            <div><dt>接受说明</dt><dd>{evidence.humanAcceptance.statement ?? "未记录"}</dd></div>
            <div><dt>接受的条件</dt><dd>{evidence.humanAcceptance.acceptedCriterionIds.join("、") || "无"}</dd></div>
            <div><dt>补充理由</dt><dd>{evidence.humanAcceptance.reason ?? "无"}</dd></div>
            <div><dt>记录时间</dt><dd>{evidence.humanAcceptance.createdAt ?? "未记录"}</dd></div>
          </dl>}
        </section>}
        {evidence.verificationSession && <section className="surface-panel completion-section"><h2>自动验证会话</h2>
          {evidence.verificationSession.availability === "UNAVAILABLE" ? <p>验证会话不可用或无权读取；不展示引用 ID、状态或 hash。</p> : <dl className="completion-facts">
            <div><dt>会话 ID</dt><dd>{evidence.verificationSession.id ?? "未记录"}</dd></div>
            <div><dt>来源 Run</dt><dd>{evidence.verificationSession.runId ? <Link className="inline-link" to={`/runs/${evidence.verificationSession.runId}`}>{evidence.verificationSession.runId}</Link> : "未记录"}</dd></div>
            <div><dt>当时状态 / 判定</dt><dd>{evidence.verificationSession.status ?? "未记录"} / {evidence.verificationSession.verdict ?? "未记录"}</dd></div>
            <div><dt>检查计划 hash</dt><dd>{evidence.verificationSession.checkPlanHash ?? "未记录"}</dd></div>
            <div><dt>当前适用性</dt><dd>{evidence.verificationSession.applicable === null ? "未核实" : evidence.verificationSession.applicable ? "适用" : "不再适用"}</dd></div>
          </dl>}
        </section>}
        <section className="surface-panel completion-section"><h2>当时接受的产物版本</h2>
          {evidence.artifactVersions.length ? <ul className="completion-list">{evidence.artifactVersions.map((version, index) => <li key={version.artifactVersionId ?? `unavailable-${index}`}>
            {version.availability === "UNAVAILABLE" ? <p>产物版本不可用或无权读取；不展示版本 ID、内容或 hash。</p> : <>
              <strong>版本 v{version.versionNumber ?? "?"}</strong>
              <small>Artifact ID：{version.artifactId ?? "未记录"} · sha256：{version.sha256 ?? "未记录"}</small>
              {version.artifactVersionId && <Link className="inline-link" to={`/artifact-versions/${version.artifactVersionId}/lineage`}>查看确切版本 {version.artifactVersionId} 的来源</Link>}
            </>}
          </li>)}</ul> : <p className="helper-text">本次完成未关联产物版本。</p>}
        </section>
      </>}
    </>}
    </div>
    <ResponsiveRail label="查看提交事实" title="提交事实"><div className="rail-content">
        {evidence && <section className="surface-panel completion-section"><h2>提交事实</h2><dl className="completion-facts">
          <div><dt>完成凭据 ID</dt><dd>{evidence.completionId}</dd></div>
          <div><dt>关联任务</dt><dd><Link className="inline-link" to={`/tasks/${evidence.taskId}`}>{evidence.taskId}</Link></dd></div>
          <div><dt>完成依据</dt><dd>{evidence.basisKind === "HUMAN" ? "人工接受" : "自动验证"}</dd></div>
          <div><dt>当时验收版本</dt><dd>v{evidence.acceptanceRevision}</dd></div>
          <div><dt>当前指针</dt><dd>{evidence.isCurrent ? "当前完成周期" : "历史凭据；当前任务已不指向此凭据"}</dd></div>
          <div><dt>提交时间</dt><dd>{evidence.committedAt}</dd></div>
        </dl><Link className="inline-link" to={`/activity?task_id=${evidence.taskId}`}>查看该任务 Activity 历史</Link></section>}
    </div></ResponsiveRail>
  </div></section>;
}
