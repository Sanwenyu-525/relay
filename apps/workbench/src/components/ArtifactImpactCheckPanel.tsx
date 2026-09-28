import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { createCommandId, type RelayApiClient, type RelayArtifact,
  type RelayArtifactDirectUses,
  type RelayArtifactImpactCandidate, type RelayArtifactImpactCheck,
  type RelayArtifactLineage } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

export default function ArtifactImpactCheckPanel({ client, lineage }:
  { readonly client: RelayApiClient; readonly lineage: RelayArtifactLineage }) {
  const [artifact, setArtifact] = useState<RelayArtifact | null>(null);
  const [beforeId, setBeforeId] = useState("");
  const [uses, setUses] = useState<RelayArtifactDirectUses | null>(null);
  const [analysisTargets, setAnalysisTargets] = useState<readonly string[]>([]);
  const [check, setCheck] = useState<RelayArtifactImpactCheck | null>(null);
  const [candidate, setCandidate] = useState<RelayArtifactImpactCandidate | null>(null);
  const [confirmed, setConfirmed] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<string | null>(null);

  useEffect(() => { let active = true; setArtifact(null); setCheck(null); setCandidate(null);
    void client.getArtifact(lineage.artifactId).then((next) => {
      if (!active) return;
      setArtifact(next);
      setBeforeId("");
    }).catch((caught: unknown) => { if (active) setError(describeLiveError(caught).message); });
    return () => { active = false; };
  }, [client, lineage.artifactId, lineage.artifactVersionId]);
  useEffect(() => { let active = true; setUses(null); setAnalysisTargets([]);
    if (beforeId) void client.getArtifactDirectUses(beforeId).then((result) => {
      if (active) setUses(result);
    }).catch((caught: unknown) => { if (active) setError(describeLiveError(caught).message); });
    return () => { active = false; };
  }, [client, beforeId]);

  useEffect(() => {
    if (!check || !["PENDING", "RUNNING"].includes(check.status)) return;
    let active = true;
    const timer = window.setInterval(() => { void client.getArtifactImpactCheck(check.id).then((next) => {
      if (active) setCheck(next);
    }).catch((caught: unknown) => { if (active) setError(describeLiveError(caught).message); }); }, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [client, check?.id, check?.status]);
  useEffect(() => {
    if (!candidate || !["PENDING", "RUNNING"].includes(candidate.status)) return;
    let active = true;
    const timer = window.setInterval(() => { void client.getArtifactImpactCandidate(candidate.id).then((next) => {
      if (active) setCandidate(next);
    }).catch((caught: unknown) => { if (active) setError(describeLiveError(caught).message); }); }, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [client, candidate?.id, candidate?.status]);

  async function startCheck() {
    if (!artifact || !beforeId || busy || pendingCommand) return;
    const commandId = createCommandId(); setPendingCommand(commandId);
    setBusy(true); setError(null); setNotice(null); setCheck(null); setCandidate(null); setConfirmed([]);
    try {
      const id = await client.startArtifactImpactCheck({ beforeVersionId: beforeId,
        afterVersionId: lineage.artifactVersionId, expectedArtifactRevision: artifact.revision,
        analysisTargetVersionIds: analysisTargets, commandId });
      setCheck(await client.getArtifactImpactCheck(id)); setPendingCommand(null);
    } catch (caught) { setError(`${describeLiveError(caught).message} 原 command_id：${commandId}；请核对结果后再重试。`); }
    finally { setBusy(false); }
  }

  async function startCandidate(targetVersionId: string, targetArtifactId: string, possible: boolean) {
    if (!check || busy || pendingCommand) return;
    const commandId = createCommandId(); setPendingCommand(commandId);
    setBusy(true); setError(null); setNotice(null); setCandidate(null);
    try {
      const target = await client.getArtifact(targetArtifactId);
      if (target.latestVersionId !== targetVersionId) throw new Error("目标已出现新版本；请重新检查影响。");
      const id = await client.startArtifactImpactCandidate({ checkId: check.id, targetVersionId,
        expectedTargetRevision: target.revision,
        confirmedPossible: possible && confirmed.includes(targetVersionId), commandId });
      setCandidate(await client.getArtifactImpactCandidate(id)); setPendingCommand(null);
    } catch (caught) { setError(`${describeLiveError(caught).message} 原 command_id：${commandId}；请核对目标后再重试。`); }
    finally { setBusy(false); }
  }

  async function applyCandidate() {
    if (!candidate || busy || pendingCommand || candidate.status !== "COMPLETED" || candidate.stale) return;
    const commandId = createCommandId(); setPendingCommand(commandId);
    setBusy(true); setError(null); setNotice(null);
    try {
      const target = await client.getArtifact(candidate.targetArtifactId);
      if (target.latestVersionId !== candidate.targetVersionId) throw new Error("目标已出现新版本；旧候选不能应用。");
      const versionId = await client.applyArtifactImpactCandidate({ candidateId: candidate.id,
        expectedTargetRevision: target.revision, commandId });
      setCandidate(await client.getArtifactImpactCandidate(candidate.id)); setPendingCommand(null);
      setNotice(`已保存候选为新产物版本 ${versionId}；仍需按原验证与验收流程处理。`);
    } catch (caught) { setError(`${describeLiveError(caught).message} 原 command_id：${commandId}；若涉及锁定冲突，请进入目标产物核对，其他范围仍可独立处理。`); }
    finally { setBusy(false); }
  }

  const current = artifact?.latestVersionId === lineage.artifactVersionId;
  const reasons = new Map(check?.possiblyRelated.map((row) => [row.targetVersionId, row.reason]));
  return <section className="surface-panel" data-testid="artifact-impact-check"><h2>手动检查修改影响</h2>
    <p className="helper-text">只在点击后分析所选旧来源与当前来源的差异；明确引用是关系事实，不等于必须修改。AI 推测单独列出，未登记或间接下游不在本轮分析范围。</p>
    {error && <p className="action-error" role="alert">{error}</p>}
    {notice && <p className="receipt-message" role="status">{notice}</p>}
    <button className="secondary-button" type="button" disabled={busy} onClick={() => { setPendingCommand(null); setError(null); void client.getArtifact(lineage.artifactId).then(setArtifact).catch((caught: unknown) => setError(describeLiveError(caught).message)); }}>刷新当前版本与解除待核对命令</button>
    {!current ? <p className="helper-text">只能以该产物的最新版本为变化后的来源进行检查。</p>
      : <><label className="field"><span className="field-label">变化前来源版本</span><select value={beforeId} onChange={(event) => setBeforeId(event.target.value)}>
        <option value="">选择旧版本</option>{artifact?.versions.filter((version) => version.artifactVersionId !== lineage.artifactVersionId).map((version) =>
          <option key={version.artifactVersionId} value={version.artifactVersionId}>v{version.versionNumber} · {version.artifactVersionId}</option>)}</select></label>
        <p className="helper-text">变化后来源：v{lineage.versionNumber} · {lineage.artifactVersionId}</p>
        <p className="helper-text">本地先读取旧来源的已登记直接引用。勾选目标才把其正文摘录送入本次模型分析；未勾选项仍在明确引用组展示。</p>
        {uses?.directUses.filter((edge) => edge.availability === "AVAILABLE" && edge.childArtifactVersionId).map((edge) =>
          <label key={edge.childArtifactVersionId}><input type="checkbox"
            checked={analysisTargets.includes(edge.childArtifactVersionId!)}
            onChange={(event) => setAnalysisTargets((old) => event.target.checked
              ? [...old, edge.childArtifactVersionId!] : old.filter((id) => id !== edge.childArtifactVersionId))} />
            允许模型分析直接引用版本 v{edge.childVersionNumber} · {edge.childArtifactVersionId}</label>)}
        {uses?.hasMore && <p className="warning-callout">登记直接引用超过当前页面范围；本轮不会分析未列出的目标。</p>}
        <button className="primary-button" type="button" disabled={!beforeId || busy || pendingCommand !== null}
          onClick={() => void startCheck()}>检查影响</button></>}
    {check && <div data-testid="artifact-impact-result"><p>分析状态：{check.status}{check.errorCode ? ` · ${check.errorCode}` : ""}{check.stale ? " · 来源基线已变化，请重查" : ""}</p>
      <h3>明确引用 · {check.directTargets.length}</h3>
      {check.directTargets.length ? <ul>{check.directTargets.map((target) => {
        const reason = reasons.get(target.targetVersionId);
        return <li key={target.targetVersionId}><strong>{target.relation} · v{target.versionNumber}</strong> · {target.availability}
          {target.analysed ? " · 已选入模型分析" : " · 正文未选入模型分析"}
          <p><Link to={`/artifact-versions/${target.targetVersionId}/lineage`}>打开原目标版本</Link></p>
          {reason && <p>AI 推测可能相关：{reason}</p>}
          {reason && <label><input type="checkbox" checked={confirmed.includes(target.targetVersionId)}
            onChange={(event) => setConfirmed((old) => event.target.checked ? [...old, target.targetVersionId]
              : old.filter((id) => id !== target.targetVersionId))} />确认将此推测纳入本次处理范围</label>}
          {check.status === "COMPLETED" && !check.stale && target.availability === "AVAILABLE" &&
            <button className="secondary-button" type="button" disabled={busy || pendingCommand !== null || (!!reason && !confirmed.includes(target.targetVersionId))}
              onClick={() => void startCandidate(target.targetVersionId, target.targetArtifactId, !!reason)}>为此目标生成修改候选</button>}</li>;
      })}</ul> : <p className="helper-text">没有已登记直接引用；这不代表没有影响。</p>}
      <h3>AI 推测可能相关 · {check.possiblyRelated.length}</h3>
      <p className="helper-text">仅在上述明确引用中展示推测与依据；推测本身不是确定事实或授权。</p>
      <h3>未分析范围</h3><ul>{check.unanalysedScope.map((item) => <li key={item}>{item}</li>)}</ul>
    </div>}
    {candidate && <div data-testid="artifact-impact-candidate"><h3>修改候选</h3><p>状态：{candidate.status}{candidate.errorCode ? ` · ${candidate.errorCode}` : ""}{candidate.stale ? " · 基线已变化" : ""}</p>
      <p>目标：<Link to={`/artifact-versions/${candidate.targetVersionId}/lineage`}>{candidate.targetVersionId}</Link></p>
      {candidate.markdown && <pre className="lineage-content">{candidate.markdown}</pre>}
      {candidate.appliedVersionId ? <p>已应用为版本 {candidate.appliedVersionId}</p>
        : candidate.status === "COMPLETED" && !candidate.stale && <button className="primary-button" type="button"
          disabled={busy || pendingCommand !== null} onClick={() => void applyCandidate()}>审查后应用为新版本</button>}
    </div>}
  </section>;
}
