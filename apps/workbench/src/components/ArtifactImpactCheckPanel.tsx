import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { createCommandId, type RelayApiClient, type RelayArtifact,
  type RelayArtifactDirectUses,
  type RelayArtifactImpactCandidate, type RelayArtifactImpactCheck,
  type RelayArtifactLineage, type RelayCombinationCheck,
  type RelayImpactCandidateGroup, type RelayImpactGroupSelection } from "../api/relayClient";
import { describeLiveError, needsReceiptCheck } from "../lib/liveErrors";

type RecoveryKey = "checkId" | "candidateId" | "groupId" | "groupSelectionId" | "combinationId";
type RecoveryIds = Partial<Record<RecoveryKey, string>>;

function selectableCandidateIds(group: RelayImpactCandidateGroup): Set<string> {
  return new Set(group.items.filter((item) => item.candidateId && item.candidateStatus === "COMPLETED" &&
    !item.candidateStale && !item.appliedVersionId).map((item) => item.candidateId!));
}

function commandError(commandId: string, caught: unknown, submitted: boolean, accepted: boolean,
  clearPending: () => void): string {
  const message = describeLiveError(caught).message;
  if (!submitted || (!accepted && !needsReceiptCheck(caught))) clearPending();
  if (submitted && !accepted && needsReceiptCheck(caught))
    return `${message} 原 command_id：${commandId}；结果仍待核对，请勿更换 ID 重提。`;
  return accepted ? `${message} 命令已受理；请刷新当前状态读取结果。` : message;
}

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
  const [groupDependencies, setGroupDependencies] = useState<readonly {
    readonly targetVersionId: string; readonly dependsOnTargetVersionId: string;
  }[]>([]);
  const [group, setGroup] = useState<RelayImpactCandidateGroup | null>(null);
  const [groupSelection, setGroupSelection] = useState<RelayImpactGroupSelection | null>(null);
  const [selectedGroupCandidates, setSelectedGroupCandidates] = useState<readonly string[]>([]);
  const [combination, setCombination] = useState<RelayCombinationCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<string | null>(null);
  const [recoveryIds, setRecoveryIds] = useState<RecoveryIds>({});

  function rememberRecovery(key: RecoveryKey, id: string | null) {
    setRecoveryIds((current) => {
      const next = { ...current };
      if (id) next[key] = id;
      else delete next[key];
      return next;
    });
  }

  useEffect(() => { let active = true; setArtifact(null); setCheck(null); setCandidate(null);
    setGroup(null); setGroupSelection(null); setCombination(null); setGroupTargets([]);
    setGroupDependencies([]); setSelectedGroupCandidates([]); setRecoveryIds({});
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
    const commandId = createCommandId(); let accepted = false;
    setPendingCommand(commandId);
    setBusy(true); setError(null); setNotice(null); setCheck(null); setCandidate(null); setConfirmed([]);
    setGroup(null); setGroupSelection(null); setCombination(null); setGroupTargets([]);
    setGroupDependencies([]); setSelectedGroupCandidates([]); setRecoveryIds({});
    try {
      const id = await client.startArtifactImpactCheck({ beforeVersionId: beforeId,
        afterVersionId: lineage.artifactVersionId, expectedArtifactRevision: artifact.revision,
        analysisTargetVersionIds: analysisTargets, commandId });
      accepted = true;
      rememberRecovery("checkId", id);
      setCheck(await client.getArtifactImpactCheck(id)); rememberRecovery("checkId", null); setPendingCommand(null);
    } catch (caught) { setError(commandError(commandId, caught, true, accepted, () => setPendingCommand(null))); }
    finally { setBusy(false); }
  }

  async function startCandidate(targetVersionId: string, targetArtifactId: string, possible: boolean) {
    if (!check || busy || pendingCommand) return;
    const commandId = createCommandId(); let submitted = false; let accepted = false;
    setBusy(true); setError(null); setNotice(null); setCandidate(null);
    try {
      const target = await client.getArtifact(targetArtifactId);
      if (target.latestVersionId !== targetVersionId) throw new Error("目标版本已更新；请重新检查影响。");
      setPendingCommand(commandId); submitted = true;
      const id = await client.startArtifactImpactCandidate({ checkId: check.id, targetVersionId,
        expectedTargetRevision: target.revision,
        confirmedPossible: possible && confirmed.includes(targetVersionId), commandId });
      accepted = true;
      rememberRecovery("candidateId", id);
      setCandidate(await client.getArtifactImpactCandidate(id)); rememberRecovery("candidateId", null); setPendingCommand(null);
    } catch (caught) { setError(commandError(commandId, caught, submitted, accepted, () => setPendingCommand(null))); }
    finally { setBusy(false); }
  }

  async function applyCandidate() {
    if (!candidate || busy || pendingCommand || candidate.status !== "COMPLETED" || candidate.stale) return;
    const commandId = createCommandId(); let submitted = false; let accepted = false;
    setBusy(true); setError(null); setNotice(null);
    try {
      const target = await client.getArtifact(candidate.targetArtifactId);
      if (target.latestVersionId !== candidate.targetVersionId) throw new Error("目标版本已更新；旧候选不能应用。");
      setPendingCommand(commandId); submitted = true;
      const versionId = await client.applyArtifactImpactCandidate({ candidateId: candidate.id,
        expectedTargetRevision: target.revision, commandId });
      accepted = true;
      rememberRecovery("candidateId", candidate.id);
      setCandidate(await client.getArtifactImpactCandidate(candidate.id));
      rememberRecovery("candidateId", null); setPendingCommand(null);
      setNotice(`已保存候选为新产物版本 ${versionId}；仍需按原验证与验收流程处理。`);
    } catch (caught) { setError(commandError(commandId, caught, submitted, accepted, () => setPendingCommand(null))); }
    finally { setBusy(false); }
  }

  const current = artifact?.latestVersionId === lineage.artifactVersionId;
  const reasons = new Map(check?.possiblyRelated.map((row) => [row.targetVersionId, row.reason]));

  /** 组只登记已登记直接引用目标版本；逐项应用仍走既有 applyArtifactImpactCandidate。 */
  async function createGroup() {
    if (!check || busy || pendingCommand || groupTargets.length === 0) return;
    const commandId = createCommandId(); let accepted = false;
    setPendingCommand(commandId);
    setBusy(true); setError(null); setNotice(null);
    try {
      const id = await client.createImpactCandidateGroup({ checkId: check.id,
        targetVersionIds: groupTargets, dependencies: groupDependencies, commandId });
      accepted = true;
      rememberRecovery("groupId", id);
      setGroup(null); setGroupSelection(null);
      setSelectedGroupCandidates([]); setCombination(null);
      setGroup(await client.getImpactCandidateGroup(id));
      rememberRecovery("groupId", null);
      setPendingCommand(null);
      setNotice("已保存候选组；它只关联所选目标版本，逐项应用与部分成功按项显示。");
    } catch (caught) { setError(commandError(commandId, caught, true, accepted, () => setPendingCommand(null))); }
    finally { setBusy(false); }
  }

  async function createGroupSelection() {
    if (!group || busy || pendingCommand || selectedGroupCandidates.length === 0) return;
    const commandId = createCommandId(); let accepted = false;
    setPendingCommand(commandId);
    setBusy(true); setError(null); setNotice(null);
    try {
      const id = await client.createImpactGroupSelection({ groupId: group.id,
        candidateIds: selectedGroupCandidates, commandId });
      accepted = true;
      rememberRecovery("groupSelectionId", id);
      setGroupSelection(await client.getImpactGroupSelection(id));
      rememberRecovery("groupSelectionId", null);
      setNotice("已保存本次候选选择；服务端按明确登记的依赖顺序逐项复核前置与基线。");
      setPendingCommand(null);
    } catch (caught) { setError(commandError(commandId, caught, true, accepted, () => setPendingCommand(null))); }
    finally { setBusy(false); }
  }

  async function applyGroupSelectionItem(candidateId: string) {
    const selection = groupSelection;
    const item = selection?.items.find((row) => row.candidateId === candidateId);
    if (!group || !selection || !item || !item.canApply || busy || pendingCommand) return;
    const commandId = createCommandId(); let submitted = false; let accepted = false;
    setBusy(true); setError(null); setNotice(null);
    try {
      const target = await client.getArtifact(item.targetArtifactId);
      if (target.revision !== item.expectedTargetRevision || target.latestVersionId !== item.targetVersionId) {
        throw new Error("目标成果或确切版本已变化；当前选择不能应用，请刷新组状态并重新选择。");
      }
      setPendingCommand(commandId); submitted = true;
      const versionId = await client.applyArtifactImpactCandidate({ candidateId: item.candidateId,
        expectedTargetRevision: item.expectedTargetRevision, groupSelectionId: selection.id, commandId });
      accepted = true;
      rememberRecovery("groupSelectionId", selection.id);
      rememberRecovery("groupId", group.id);
      setGroupSelection(await client.getImpactGroupSelection(selection.id));
      const nextGroup = await client.getImpactCandidateGroup(group.id);
      setGroup(nextGroup);
      rememberRecovery("groupSelectionId", null);
      rememberRecovery("groupId", null);
      const selectable = selectableCandidateIds(nextGroup);
      setSelectedGroupCandidates((old) => old.filter((id) => selectable.has(id)));
      setNotice(`已按依赖选择保存新版本 ${versionId}；仍需按原验证与验收流程处理。`);
      setPendingCommand(null);
    } catch (caught) { setError(commandError(commandId, caught, submitted, accepted, () => setPendingCommand(null))); }
    finally { setBusy(false); }
  }

  /** 组合检查只保存确切版本集合的覆盖快照，不产生整体结论。 */
  async function createCombinationCheck() {
    if (!group || busy || pendingCommand) return;
    const commandId = createCommandId(); let accepted = false;
    setPendingCommand(commandId);
    setBusy(true); setError(null); setNotice(null);
    try {
      const versions = [group.sourceAfterVersionId,
        ...group.items.filter((item) => item.appliedVersionId !== null)
          .map((item) => item.appliedVersionId!)];
      const id = await client.createCombinationCheck({ groupId: group.id,
        artifactVersionIds: [...new Set(versions)], commandId });
      accepted = true;
      rememberRecovery("combinationId", id);
      setCombination(await client.getCombinationCheck(id));
      setGroup(await client.getImpactCandidateGroup(group.id));
      rememberRecovery("combinationId", null);
      setPendingCommand(null);
    } catch (caught) { setError(commandError(commandId, caught, true, accepted, () => setPendingCommand(null))); }
    finally { setBusy(false); }
  }

  async function refreshEvidence() {
    if (busy) return;
    setBusy(true); setError(null);
    const checkId = recoveryIds.checkId ?? check?.id;
    const candidateId = recoveryIds.candidateId ?? candidate?.id;
    const groupId = recoveryIds.groupId ?? group?.id;
    const groupSelectionId = recoveryIds.groupSelectionId ?? groupSelection?.id;
    const combinationId = recoveryIds.combinationId ?? combination?.id;
    const recoveringAcceptedCommand = Object.values(recoveryIds).some(Boolean);
    try {
      const [nextArtifact, nextUses, nextCheck, nextCandidate, nextGroup, nextGroupSelection, nextCombination] = await Promise.all([
        client.getArtifact(lineage.artifactId),
        beforeId ? client.getArtifactDirectUses(beforeId) : Promise.resolve(null),
        checkId ? client.getArtifactImpactCheck(checkId) : Promise.resolve(null),
        candidateId ? client.getArtifactImpactCandidate(candidateId) : Promise.resolve(null),
        groupId ? client.getImpactCandidateGroup(groupId) : Promise.resolve(null),
        groupSelectionId ? client.getImpactGroupSelection(groupSelectionId) : Promise.resolve(null),
        combinationId ? client.getCombinationCheck(combinationId) : Promise.resolve(null)
      ]);
      setArtifact(nextArtifact);
      setUses(nextUses);
      if (nextCheck) setCheck(nextCheck);
      if (nextCandidate) setCandidate(nextCandidate);
      if (nextGroup) {
        setGroup(nextGroup);
        const selectable = selectableCandidateIds(nextGroup);
        setSelectedGroupCandidates((old) => old.filter((id) => selectable.has(id)));
      }
      if (nextGroupSelection) setGroupSelection(nextGroupSelection);
      if (nextCombination) setCombination(nextCombination);
      if (recoveringAcceptedCommand) {
        setRecoveryIds({});
        setPendingCommand(null);
      }
      setNotice(recoveringAcceptedCommand
        ? "已按服务端受理后保存的资源 ID 读回结果；后续操作可继续。"
        : pendingCommand
        ? `已刷新当前事实；原 command_id ${pendingCommand} 仍待核对，刷新不会解除或替换它。`
        : "已刷新产物、检查、候选组与组合检查的当前状态。");
    } catch (caught) {
      setError(describeLiveError(caught).message);
    } finally { setBusy(false); }
  }

  return <section className="surface-panel" data-testid="artifact-impact-check"><h2>手动检查修改影响</h2>
    <p className="helper-text">只在点击后分析所选旧来源与当前来源的差异；明确引用是关系事实，不等于必须修改。AI 推测单独列出，未登记或间接下游不在本轮分析范围。</p>
    {error && <p className="action-error" role="alert">{error}</p>}
    {notice && <p className="receipt-message" role="status">{notice}</p>}
    <button className="secondary-button" type="button" disabled={busy} onClick={() => void refreshEvidence()}>刷新产物与影响状态</button>
    {pendingCommand && <p className="warning-callout" data-testid="artifact-impact-pending">原 command_id {pendingCommand} 的结果仍待核对；刷新当前事实不会解除或替换该命令。</p>}
    {!current ? <p className="helper-text">只能以该产物的最新版本为变化后的来源进行检查。</p>
      : <><label className="field"><span className="field-label">变化前来源版本</span><select value={beforeId} onChange={(event) => setBeforeId(event.target.value)}>
        <option value="">选择旧版本</option>{artifact?.versions.filter((version) => version.artifactVersionId !== lineage.artifactVersionId).map((version) =>
          <option key={version.artifactVersionId} value={version.artifactVersionId}>v{version.versionNumber} · {version.artifactVersionId}</option>)}</select></label>
        <p className="helper-text">变化后来源：v{lineage.versionNumber} · {lineage.artifactVersionId}</p>
        <p className="helper-text">本地先读取旧来源的已登记直接引用。勾选目标版本才把其正文摘录送入本次模型分析；未勾选项仍在明确引用组展示。</p>
        {uses?.directUses.filter((edge) => edge.availability === "AVAILABLE" && edge.childArtifactVersionId).map((edge) =>
          <label key={edge.childArtifactVersionId}><input type="checkbox"
            checked={analysisTargets.includes(edge.childArtifactVersionId!)}
            onChange={(event) => setAnalysisTargets((old) => event.target.checked
              ? [...old, edge.childArtifactVersionId!] : old.filter((id) => id !== edge.childArtifactVersionId))} />
            允许模型分析直接引用版本 v{edge.childVersionNumber} · {edge.childArtifactVersionId}</label>)}
        {uses?.hasMore && <p className="warning-callout">登记直接引用超过当前页面范围；本轮不会分析未列出的目标版本。</p>}
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
              onClick={() => void startCandidate(target.targetVersionId, target.targetArtifactId, !!reason)}>为此目标版本生成修改候选</button>}</li>;
      })}</ul> : <p className="helper-text">没有已登记直接引用；这不代表没有影响。</p>}
      <h3>AI 推测可能相关 · {check.possiblyRelated.length}</h3>
      <p className="helper-text">仅在上述明确引用中展示推测与依据；推测本身不是确定事实或授权。</p>
      <h3>选入候选组</h3>
      <p className="helper-text">候选组只登记所选的已登记直接引用目标版本，让一次审阅覆盖多个成果；它不调用模型、不代替逐项判断，也不承诺整组原子完成。</p>
      {check.directTargets.filter((target) => target.availability === "AVAILABLE").map((target) =>
        <label key={target.targetVersionId}><input type="checkbox"
          checked={groupTargets.includes(target.targetVersionId)}
          onChange={(event) => {
            if (event.target.checked) setGroupTargets((old) => [...old, target.targetVersionId]);
            else {
              setGroupTargets((old) => old.filter((id) => id !== target.targetVersionId));
              setGroupDependencies((old) => old.filter((edge) => edge.targetVersionId !== target.targetVersionId &&
                edge.dependsOnTargetVersionId !== target.targetVersionId));
            }
          }} />
          选入 {target.relation} · v{target.versionNumber} · {target.targetVersionId}</label>)}
      {groupTargets.map((targetVersionId) => <label key={`dependency-${targetVersionId}`} className="field">
        <span className="field-label">{targetVersionId} 的组内前置（可选）</span>
        <select aria-label={`${targetVersionId} 的组内前置`} value={groupDependencies.find((edge) =>
          edge.targetVersionId === targetVersionId)?.dependsOnTargetVersionId ?? ""}
          onChange={(event) => setGroupDependencies((old) => [
            ...old.filter((edge) => edge.targetVersionId !== targetVersionId),
            ...(event.target.value ? [{ targetVersionId, dependsOnTargetVersionId: event.target.value }] : [])
          ])}>
          <option value="">无显式前置</option>{groupTargets.filter((id) => id !== targetVersionId).map((id) =>
            <option key={id} value={id}>{id}</option>)}
        </select>
      </label>)}
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
        {!item.targetIsCurrentVersion ? " · 目标版本已更新" : ""}
        <p><Link to={`/artifact-versions/${item.targetVersionId}/lineage`}>打开原目标版本</Link></p>
        {item.appliedVersionId
          ? <p>已应用为版本 {item.appliedVersionId}</p>
          : item.candidateId
            ? <p>候选 {item.candidateId}：{item.candidateStatus ?? "未知"}
              {item.candidateErrorCode ? ` · ${item.candidateErrorCode}` : ""}
              {item.candidateStale ? " · 基线已变化，不能应用" : ""}</p>
            : <p className="helper-text">本项尚无候选；其它项的处理结果不改变这一点。</p>}
      </li>)}</ul>
      <h4>按依赖顺序应用候选</h4>
      <p className="helper-text">只勾选准备审查的已完成候选。每次应用前都会重查来源、目标修订和前置版本；部分成功会逐项保留。</p>
      {group.items.filter((item) => item.candidateId && item.candidateStatus === "COMPLETED" &&
        !item.candidateStale && !item.appliedVersionId).map((item) => <label key={`candidate-${item.candidateId}`}>
        <input type="checkbox" data-testid={`group-candidate-${item.candidateId}`}
          checked={selectedGroupCandidates.includes(item.candidateId!)}
          onChange={(event) => setSelectedGroupCandidates((old) => event.target.checked
            ? [...old, item.candidateId!] : old.filter((id) => id !== item.candidateId))} />
        选择候选 {item.candidateId} · 目标 {item.targetVersionId}</label>)}
      <button className="secondary-button" type="button" disabled={busy || pendingCommand !== null || selectedGroupCandidates.length === 0}
        onClick={() => void createGroupSelection()}>保存依赖选择与顺序</button>
      {groupSelection && <ol data-testid="impact-group-selection">{groupSelection.items.map((item) => <li key={item.candidateId}>
        候选 {item.candidateId} · {item.canApply ? "前置与基线可用" : item.reason ?? "当前不可应用"}
        {item.appliedVersionId ? ` · 已应用 ${item.appliedVersionId}${item.appliedIsCurrent ? "（当前）" : "（已过期）"}`
          : item.canApply && <button className="secondary-button" type="button" disabled={busy || pendingCommand !== null}
            onClick={() => void applyGroupSelectionItem(item.candidateId)}>应用此项</button>}
      </li>)}</ol>}
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
      <p>目标版本：<Link to={`/artifact-versions/${candidate.targetVersionId}/lineage`}>{candidate.targetVersionId}</Link></p>
      {candidate.markdown && <pre className="lineage-content">{candidate.markdown}</pre>}
      {candidate.appliedVersionId ? <p>已应用为版本 {candidate.appliedVersionId}</p>
        : candidate.status === "COMPLETED" && !candidate.stale && <button className="primary-button" type="button"
          disabled={busy || pendingCommand !== null} onClick={() => void applyCandidate()}>审查后应用为新版本</button>}
    </div>}
  </section>;
}
