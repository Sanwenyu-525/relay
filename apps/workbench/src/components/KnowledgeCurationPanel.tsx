import { useCallback, useEffect, useState } from "react";
import { createCommandId, RelayApiError, type RelayApiClient,
  type RelayKnowledgeCurationCandidate } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

interface Props {
  readonly client: RelayApiClient;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly versionNumber: string;
}

const STATUS_TEXT: Record<RelayKnowledgeCurationCandidate["status"], string> = {
  PROPOSED: "待你判断", ACCEPTED: "已接受", REJECTED: "已拒绝", STALE: "来源已变化" };

/**
 * N03 整理候选：只由用户在此处主动发起，接受才写入知识版本。工程能力，见
 * docs/api/http-command-contract.md §10.53。
 */
export default function KnowledgeCurationPanel({ client, artifactId, artifactVersionId,
  versionNumber }: Props) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [candidates, setCandidates] = useState<readonly RelayKnowledgeCurationCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback((target: string) => {
    setError(null);
    return client.listKnowledgeCurationCandidates(target)
      .then(setCandidates)
      .catch((caught: unknown) => { setError(describeLiveError(caught).message); });
  }, [client]);

  useEffect(() => {
    let active = true;
    setProjectId(null); setScopeError(null);
    void client.getArtifact(artifactId)
      .then((artifact) => client.getTask(artifact.taskId))
      .then((task) => {
        if (!active) { return; }
        if (task.projectId === null) {
          setScopeError("这个成果所属的任务还没关联项目，无法生成项目知识整理候选。");
          return;
        }
        setProjectId(task.projectId);
        void load(task.projectId);
      })
      .catch((caught: unknown) => { if (active) { setScopeError(describeLiveError(caught).message); } });
    return () => { active = false; };
  }, [artifactId, client, load]);

  async function propose() {
    if (projectId === null) { return; }
    setBusy(true); setActionError(null); setNotice(null);
    const suggested = title.trim();
    try {
      const created = await client.createKnowledgeCurationCandidates({ projectId,
        sources: [{ artifactVersionId, ...(suggested === "" ? {} : { suggestedTitle: suggested }) }],
        commandId: createCommandId() });
      setTitle("");
      setNotice(created.length === 0
        ? "这个成果版本已经是当前版本，没有产生新候选。"
        : `已生成 ${created.length} 条候选。只提示，不会自动合并。`);
      await load(projectId);
    } catch (caught) { setActionError(describeLiveError(caught).message); }
    finally { setBusy(false); }
  }

  async function decide(candidate: RelayKnowledgeCurationCandidate, accept: boolean) {
    if (projectId === null) { return; }
    setBusy(true); setActionError(null); setNotice(null);
    try {
      if (accept) {
        const result = await client.acceptKnowledgeCurationCandidate({ projectId,
          candidateId: candidate.id, commandId: createCommandId() });
        setNotice(`已接受为知识「${candidate.suggestedTitle}」${result.mode === "CREATED" ? "（新建）" : "（新增版本）"}。`);
      } else {
        await client.rejectKnowledgeCurationCandidate({ projectId, candidateId: candidate.id,
          commandId: createCommandId() });
        setNotice("已拒绝。不会删除来源成果，也不会自动合并任何知识。");
      }
      await load(projectId);
    } catch (caught) {
      if (caught instanceof RelayApiError && caught.problem.code === "INVALID_TRANSITION") {
        setActionError("这个候选的状态已经变了（可能刚被处理）。列表已刷新。");
        await load(projectId);
      } else { setActionError(describeLiveError(caught).message); }
    } finally { setBusy(false); }
  }

  return <section className="surface-panel knowledge-curation" data-testid="knowledge-curation"
    aria-label="知识整理候选">
    <h2>整理为项目知识</h2>
    <p className="helper-text">这里只生成提示。是否新建知识、是否归入既有条目由你决定；接受才会写入知识版本，拒绝不会删除任何来源。</p>
    {scopeError && <p className="action-error" role="alert">无法确定项目范围：{scopeError}</p>}
    {projectId === null && !scopeError && <p role="status">正在确认这个成果所属的项目…</p>}
    {projectId !== null && <>
      <div className="knowledge-curation__propose">
        <label>建议的资料标题（可留空）<input type="text" maxLength={200} value={title}
          placeholder="留空则用成果标题" onChange={(event) => setTitle(event.target.value)} /></label>
        <button type="button" disabled={busy} onClick={() => void propose()}>
          把 v{versionNumber} 提为整理候选</button>
      </div>
      {error && <p className="action-error" role="alert">候选读取失败：{error}</p>}
      {notice && <p role="status" className="helper-text">{notice}</p>}
      {actionError && <p role="alert" className="action-error">{actionError}</p>}
      <h3>本项目的整理候选（{candidates.length}）</h3>
      {candidates.length === 0 && !error && <p>暂无候选。</p>}
      {candidates.length > 0 && <ul className="knowledge-curation__list">{candidates.map((candidate) =>
        <li key={candidate.id} data-testid={`curation-candidate-${candidate.status}`}>
          <div className="knowledge-curation__head">
            <strong>{candidate.suggestedTitle}</strong>
            <span className="knowledge-curation__status">{STATUS_TEXT[candidate.status]}</span>
          </div>
          <p className="helper-text">来源：{candidate.sourceTitle} · v{candidate.sourceVersionNumber}</p>
          {candidate.suggestedKnowledgeTitle !== null
            ? <p className="helper-text">建议归入既有条目：{candidate.suggestedKnowledgeTitle}</p>
            : <p className="helper-text">没有同名的本项目条目，接受会新建知识。</p>}
          {candidate.similar.length > 0 && <p className="helper-text">相似（仅提示，不自动合并）：
            {candidate.similar.map((item) => `${item.title}（${item.reason}）`).join("；")}</p>}
          {candidate.staleReason !== null && <p className="knowledge-guide__warning">{candidate.staleReason}</p>}
          {candidate.status === "ACCEPTED" && <p className="helper-text">已归入知识 {candidate.acceptedKnowledgeId}</p>}
          {candidate.status === "REJECTED" && <p className="helper-text">已拒绝，不会再询问。</p>}
          {candidate.status === "PROPOSED" && <div className="knowledge-curation__actions">
            <button type="button" disabled={busy}
              onClick={() => void decide(candidate, true)}>接受为知识</button>
            <button type="button" className="secondary-button" disabled={busy}
              onClick={() => void decide(candidate, false)}>拒绝</button>
          </div>}
        </li>)}</ul>}
      <p className="helper-text">候选按创建时间倒序，最多显示 20 条。归属项目 {projectId}。</p>
    </>}
  </section>;
}