import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { createCommandId, RelayApiError, type RelayApiClient,
  type RelayKnowledgeGuideEntryInput, type RelayProjectKnowledgeGuide } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

interface Props {
  readonly client: RelayApiClient;
  readonly projectId: string;
  readonly onOpen: (kind: "KNOWLEDGE" | "DECISION" | "RULE", id: string) => void;
}

type RefKind = "KNOWLEDGE" | "DECISION" | "RULE" | "ARTIFACT_VERSION";

/** 服务端已确认的条目 + 本地未保存改动合成一行；guide 为 null 表示本地有草稿。 */
interface DraftEntry {
  readonly key: string;
  readonly refKind: RefKind;
  readonly referenceMode: "PINNED" | "CURRENT";
  readonly targetId: string;
  readonly label: string;
  readonly title: string;
  readonly version: string | null;
  readonly resolution: string | null;
  readonly note: string | null;
  readonly targetStatus: string | null;
  readonly resolvedVersionId: string | null;
}

interface Target {
  readonly refKind: RefKind;
  readonly id: string;
  readonly label: string;
}

const KIND_TEXT: Record<RefKind, string> = { KNOWLEDGE: "资料", DECISION: "决定",
  RULE: "规则", ARTIFACT_VERSION: "成果版本" };

/** resolution 不是 AVAILABLE 时才提示，避免每行都挂警告色。 */
function resolutionText(resolution: string | null): string | null {
  if (resolution === null || resolution === "AVAILABLE") { return null; }
  if (resolution === "STALE") { return "钉住的版本已不是最新；导读仍读钉住版本。"; }
  if (resolution === "ARCHIVED") { return "目标已归档，仍可阅读。"; }
  if (resolution === "SUPERSEDED") { return "目标已被替代，导读仍指向原版本。"; }
  if (resolution === "CROSS_SCOPE") { return "目标不在本项目，已停止解析。"; }
  return "钉住的版本已不可用。";
}

function toDraft(guide: RelayProjectKnowledgeGuide): DraftEntry[] {
  return guide.entries.map((entry) => ({ key: `${entry.refKind}:${entry.targetId}`,
    refKind: entry.refKind, referenceMode: entry.referenceMode, targetId: entry.targetId,
    label: entry.label ?? "", title: entry.title ?? entry.targetId,
    version: entry.resolvedVersionNumber,
    resolution: entry.resolution, note: entry.note, targetStatus: entry.targetStatus,
    resolvedVersionId: entry.resolvedVersionId }));
}

function toInput(entry: DraftEntry): RelayKnowledgeGuideEntryInput {
  const trimmed = entry.label.trim();
  return { ref_kind: entry.refKind, reference_mode: entry.referenceMode,
    ...(entry.refKind === "KNOWLEDGE" ? { knowledge_id: entry.targetId } : {}),
    ...(entry.refKind === "DECISION" ? { decision_id: entry.targetId } : {}),
    ...(entry.refKind === "RULE" ? { rule_id: entry.targetId } : {}),
    ...(entry.refKind === "ARTIFACT_VERSION" ? { artifact_version_id: entry.targetId } : {}),
    ...(entry.referenceMode === "PINNED" && entry.resolvedVersionId !== null
      ? { pinned_version_id: entry.resolvedVersionId } : {}),
    ...(trimmed === "" ? {} : { label: trimmed }) };
}

export default function ProjectKnowledgeGuide({ client, projectId, onOpen }: Props) {
  const [guide, setGuide] = useState<RelayProjectKnowledgeGuide | null>(null);
  const [draft, setDraft] = useState<DraftEntry[] | null>(null);
  const [targets, setTargets] = useState<readonly Target[]>([]);
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    return Promise.all([client.getProjectKnowledgeGuide(projectId), client.getDecisions(projectId),
      client.getRules(projectId), client.getKnowledge(projectId), client.getProjectTasks(projectId)])
      .then(async ([nextGuide, decisions, rules, knowledge, tasks]) => {
        const artifacts = await Promise.all(tasks.map((task) => client.getTaskArtifacts(task.id)
          .then((result) => result.items).catch(() => [])));
        setTargets([...decisions.filter((item) => item.projectId === projectId)
          .map((item) => ({ refKind: "DECISION" as const, id: item.id, label: item.title })),
        ...rules.filter((item) => item.projectId === projectId)
          .map((item) => ({ refKind: "RULE" as const, id: item.id, label: item.ruleKey })),
        ...knowledge.filter((item) => item.projectId === projectId)
          .map((item) => ({ refKind: "KNOWLEDGE" as const, id: item.id, label: item.title })),
        ...artifacts.flatMap((items) => items.flatMap((artifact) => artifact.versions
          .map((version) => ({ refKind: "ARTIFACT_VERSION" as const, id: version.artifactVersionId,
            label: `${artifact.title} · v${version.versionNumber}` }))))]);
        setGuide(nextGuide);
        setDraft(null);
      }).catch((caught: unknown) => { setError(describeLiveError(caught).message); });
  }, [client, projectId]);

  useEffect(() => { void load(); }, [load]);

  const rows = draft ?? (guide === null ? [] : toDraft(guide));
  const dirty = draft !== null;

  function mutate(next: DraftEntry[]) { setDraft(next); setNotice(null); setActionError(null); }

  function move(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= rows.length) { return; }
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    mutate(next);
  }

  function add(target: Target) {
    if (rows.some((row) => row.targetId === target.id)) { return; }
    mutate([...rows, { key: `${target.refKind}:${target.id}`, refKind: target.refKind,
      referenceMode: "CURRENT", targetId: target.id, label: "", title: target.label,
      version: null, resolution: null, note: null, targetStatus: null, resolvedVersionId: null }]);
    setAdding("");
  }

  async function save(entries: readonly DraftEntry[], expectedRevision: string, message: string) {
    setBusy(true); setActionError(null); setNotice(null);
    try {
      await client.saveProjectKnowledgeGuide({ projectId, expectedRevision,
        entries: entries.map(toInput), commandId: createCommandId() });
      setNotice(message);
      await load();
    } catch (caught) {
      if (caught instanceof RelayApiError && caught.problem.code === "REVISION_CONFLICT") {
        setActionError("导读已被别处改动，本次未保存。已重新读取，请确认后再保存。");
        await load();
      } else { setActionError(describeLiveError(caught).message); }
    } finally { setBusy(false); }
  }

  const available = targets.filter((target) => !rows.some((row) => row.targetId === target.id));

  return <section className="surface-panel knowledge-guide" aria-label="项目导读"
    data-testid="project-knowledge-guide">
    <p className="eyebrow">项目导读</p><h2>从这里重新理解项目</h2>
    <p className="page-lede">导读是你选定的阅读顺序和人工说明；它只引用已有事实，不复制正文，也不替你判断哪个版本更重要。</p>
    {!guide && !error && <p role="status">正在读取项目导读…</p>}
    {error && <p className="action-error" role="alert">项目导读读取失败：{error}</p>}
    {guide && <>
      <p className="helper-text">修订 v{guide.revision} · {guide.entryCount} 项
        {guide.exists ? "" : " · 尚未保存过编排"}</p>

      {rows.length === 0
        ? <p>还没有编排条目。可一次加入本项目全部可选目标再逐项调整，也可从零逐项添加。</p>
        : <ol className="knowledge-guide__entries">{rows.map((row, index) => {
          const warning = resolutionText(row.resolution);
          const canPin = row.refKind === "KNOWLEDGE" && row.resolvedVersionId !== null;
          return <li key={row.key} data-testid={`guide-entry-${row.refKind}`}>
            <div className="knowledge-guide__entry-head">
              <span className="knowledge-guide__kind">{KIND_TEXT[row.refKind]}</span>
              {row.refKind !== "ARTIFACT_VERSION" && row.targetStatus !== null && row.targetStatus !== "ACTIVE"
                && <span className="knowledge-guide__status">{row.targetStatus}</span>}
              <button type="button" className="text-button"
                onClick={() => row.refKind !== "ARTIFACT_VERSION" && onOpen(row.refKind as "KNOWLEDGE" | "DECISION" | "RULE", row.targetId)}>
                {row.label === "" ? row.title : `${row.label}（${row.title}）`}</button>
              {row.version !== null && <span className="helper-text">v{row.version}{row.referenceMode === "PINNED" ? " · 已钉住" : ""}</span>}
            </div>
            <div className="knowledge-guide__entry-controls">
              <label>人工说明<input type="text" maxLength={200} value={row.label}
                placeholder="这一项为什么在这里"
                onChange={(event) => mutate(rows.map((item) => item.key === row.key
                  ? { ...item, label: event.target.value } : item))} /></label>
              {canPin && <label className="knowledge-guide__pin"><input type="checkbox"
                checked={row.referenceMode === "PINNED"}
                onChange={(event) => mutate(rows.map((item) => item.key === row.key
                  ? { ...item, referenceMode: event.target.checked ? "PINNED" : "CURRENT" } : item))} />
                钉住这个确切版本</label>}
              <span className="knowledge-guide__moves">
                <button type="button" className="text-button" disabled={index === 0 || busy}
                  onClick={() => move(index, -1)} aria-label="上移">上移</button>
                <button type="button" className="text-button" disabled={index === rows.length - 1 || busy}
                  onClick={() => move(index, 1)} aria-label="下移">下移</button>
                <button type="button" className="text-button" disabled={busy}
                  onClick={() => mutate(rows.filter((item) => item.key !== row.key))}>移除</button>
              </span>
            </div>
            {warning && <p className="knowledge-guide__warning">{warning}{row.note === null ? "" : ` ${row.note}`}</p>}
          </li>;
        })}</ol>}

      {guide.gaps.length > 0 && <div className="knowledge-guide__gaps">
        <h3>缺口</h3><ul>{guide.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul></div>}

      <div className="knowledge-guide__add">
        <label>添加条目<select value={adding} onChange={(event) => setAdding(event.target.value)}>
          <option value="">选择要收录的已有事实…</option>
          {available.map((target) => <option key={target.id} value={target.id}>
            {KIND_TEXT[target.refKind]} · {target.label}</option>)}
        </select></label>
        <button type="button" disabled={adding === "" || busy}
          onClick={() => { const target = available.find((item) => item.id === adding);
            if (target !== undefined) { add(target); } }}>添加</button>
        <button type="button" disabled={busy || available.length === 0}
          onClick={() => mutate([...rows, ...available.map((target) => ({ key: `${target.refKind}:${target.id}`,
            refKind: target.refKind, referenceMode: "CURRENT" as const, targetId: target.id,
            label: "", title: target.label, version: null, resolution: null, note: null,
            targetStatus: null, resolvedVersionId: null }))])}>
          全部加入（{available.length}）</button>
      </div>

      {available.length === 0 && rows.length > 0 && <p className="helper-text">本项目可收录的决定、规则、资料与成果版本都已在导读中。</p>}

      <div className="knowledge-guide__save">
        <button type="button" disabled={busy || !dirty || rows.length > 200}
          onClick={() => void save(rows, guide.revision, `导读已保存（${rows.length} 项）。`)}>保存导读</button>
        {dirty && <span className="helper-text">有未保存的改动。导读是整份替换式保存，未保存时离开不会生效。</span>}
        {notice && <span role="status" className="helper-text">{notice}</span>}
        {actionError && <span role="alert" className="action-error">{actionError}</span>}
      </div>

      <p className="helper-text"><Link to={`/projects/${encodeURIComponent(projectId)}/tasks`}>按任务查看实际验收条件与证据</Link>；导读不代替验收，也不是 Context 自动注入的范围。</p>
    </>}
  </section>;
}