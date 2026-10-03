import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { createCommandId, type RelayApiClient, type RelayArtifact,
  type RelayArtifactDirectUses,
  type RelayArtifactImpactCandidate, type RelayArtifactImpactCheck,
  type RelayArtifactLineage, type RelayCombinationCheck,
  type RelayImpactCandidateGroup } from "../api/relayClient";
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
  const [groupTargets, setGroupTargets] = useState<readonly string[]>([]);
  const [group, setGroup] = useState<RelayImpactCandidateGroup | null>(null);
  const [combination, setCombination] = useState<RelayCombinationCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<string | null>(null);

  useEffect(() => { let active = true; setArtifact(null); setCheck(null); setCandidate(null);
    setGroup(null); setCombination(null); setGroupTargets([]);
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
    setGroup(null); setCombination(null); setGroupTargets([]);
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

  /** 组只登记已登记直接引用目标；逐项应用仍走既有 applyArtifactImpactCandidate。 */
  async function createGroup() {
    if (!check || busy || pendingCommand || groupTargets.length === 0) return;
    const commandId = createCommandId(); setPendingCommand(commandId);
    setBusy(true); setError(null); setNotice(null);
    try {
      const id = await client.createImpactCandidateGroup({ checkId: check.id,
        targetVersionIds: groupTargets, commandId });
      setGroup(await client.getImpactCandidateGroup(id)); setCombination(null);
      setPendingCommand(null);
      setNotice("已保存候选组；它只关联所选目标，逐项应用与部分成功按项显示。");
    } catch (caught) { setError(`${describeLiveError(caught).message} 原 command_id：${commandId}；请核对原命令回执后再决定是否重试。`); }
    finally { setBusy(false); }
  }

  /** 组合检查只保存确切版本集合的覆盖快照，不产生整体结论。 */
  async function createCombinationCheck() {
    if (!group || busy || pendingCommand) return;
    const commandId = createCommandId(); setPendingCommand(commandId);
    setBusy(true); setError(null); setNotice(null);
    try {
      const versions = [group.sourceAfterVersionId,
        ...group.items.filter((item) => item.appliedVersionId !== null)
          .map((item) => item.appliedVersionId!)];
      const id = await client.createCombinationCheck({ groupId: group.id,
        artifactVersionIds: [...new Set(versions)], commandId });
      setCombination(await client.getCombinationCheck(id));
      setGroup(await client.getImpactCandidateGroup(group.id));
      setPendingCommand(null);
    } catch (caught) { setError(`${describeLiveError(caught).message} 原 command_id：${commandId}；跨 Task 或超出组范围的集合不能保存，请缩小范围。`); }
    finally { setBusy(false); }
  }
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
      <h3>选入候选组</h3>
      <p className="helper-text">候选组只登记所选的已登记直接引用目标，让一次审阅覆盖多个成果；它不调用模型、不代替逐项判断，也不承诺整组原子完成。</p>
      {check.directTargets.filter((target) => target.availability === "AVAILABLE").map((target) =>
        <label key={target.targetVersionId}><input type="checkbox"
          checked={groupTargets.includes(target.targetVersionId)}
          onChange={(event) => setGroupTargets((old) => event.target.checked
            ? [...old, target.targetVersionId]
            : old.filter((id) => id !== target.targetVersionId))} />
          选入 {target.relation} · v{target.versionNumber} · {target.targetVersionId}</label>)}
      <button className="secondary-button" type="button"
        disabled={busy || pendingCommand !== null || groupTargets.length === 0}
        onClick={() => void createGroup()}>保存候选组（{groupTargets.length}）</button>
      <h3>未分析范围</h3><ul>{check.unanalysedScope.map((item) => <li key={item}>{item}</li>)}</ul>
    </div>}
    {group && <div data-testid="impact-candidate-group"><h3>候选组</h3>
      <p>{group.stale ? "来源基线已变化，本组只能作为历史范围查看。" : "来源基线仍与检查一致。"}</p>
      <p>共 {group.summary.total} 项：已应用 {group.summary.applied}、有候选 {group.summary.withCandidate}、尚无候选 {group.summary.withoutCandidate}、候选已失效 {group.summary.staleCandidates}、来源当时不可用 {group.summary.unavailable}。</p>
      <ul>{group.items.map((item) => <li key={item.targetVersionId}>
        <strong>{item.ordinal + 1}. {item.relation}</strong> · {item.availability}
        {item.speculative ? " · AI 推测项" : ""}{item.analysed ? " · 已选入模型分析" : " · 正文未选入模型分析"}
        {!item.targetIsCurrentVersion ? " · 目标已出现新版本" : ""}
        <p><Link to={`/artifact-versions/${item.targetVersionId}/lineage`}>打开原目标版本</Link></p>
        {item.appliedVersionId
          ? <p>已应用为版本 {item.appliedVersionId}</p>
          : item.candidateId
            ? <p>候选 {item.candidateId}：{item.candidateStatus ?? "未知"}
              {item.candidateErrorCode ? ` · ${item.candidateErrorCode}` : ""}
              {item.candidateStale ? " · 基线已变化，不能应用" : ""}</p>
            : <p className="helper-text">本项尚无候选；其它项的处理结果不改变这一点。</p>}
      </li>)}</ul>
      <button className="secondary-button" type="button" disabled={busy || pendingCommand !== null}
        onClick={() => void createCombinationCheck()}>保存组合检查单（来源 + 已应用项）</button>
      <p className="helper-text">组合检查单只记录这组确切版本当时的覆盖情况；跨 Task 的集合不能保存，单项 PASS 也不会被相加。</p>
    </div>}
    {combination && <div data-testid="impact-combination-check"><h3>组合检查单</h3>
      <p className="warning-callout">整体结论：{combination.overallResult} · {combination.overallNote}</p>
      <p>捕获时验收修订 {combination.acceptanceRevision}{combination.stale ? " · 当前事实已变化，本单只反映捕获时点" : ""}</p>
      <ul>{combination.items.map((item) => <li key={item.artifactVersionId}>
        {item.artifactVersionId} · {item.isCurrentVersion ? "当前版本" : "已非当前版本"}
        {item.readable ? "" : " · 正文不可读"} · 单项验证：{item.verificationStatus ?? "无会话"}
      </li>)}</ul>
      <h4>缺口</h4>
      {combination.gaps.length === 0 ? <p className="helper-text">本单未发现缺口；这不等于组合已通过。</p>
        : <ul>{combination.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>}
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
