import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ChevronRight, Info, Pencil, RotateCcw, X } from "lucide-react";
import ResponsiveRail from "../components/ResponsiveRail";
import SourceDetailDialog from "../components/SourceDetailDialog";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { useRelayConnection } from "../lib/relayConnection";
import { executorLabels, interactionModeLabels, taskStatusLabels } from "../lib/labels";
import type { FixtureError, ProjectSnapshot, SourceReference, TaskDefinitionDraft } from "../types";
import LiveTaskSkillFactsView from "./LiveTaskSkillFactsView";

const copyDraft = (value: TaskDefinitionDraft): TaskDefinitionDraft => ({ ...value, acceptanceCriteria: [...value.acceptanceCriteria] });
function toActionError(caught: unknown, fallback: string) {
  return { kind: caught instanceof Error && "kind" in caught ? String((caught as FixtureError).kind) : "unknown", message: caught instanceof Error ? caught.message.trim() : fallback };
}

export default function TaskDefinitionView() {
  const connection = useRelayConnection();
  return connection.client ? <LiveTaskSkillFactsView client={connection.client} kind="definition" /> : <FixtureTaskDefinitionView />;
}

function FixtureTaskDefinitionView() {
  const { id = "" } = useParams();
  const [query] = useSearchParams();
  const mode = fixtureModeFromQuery(query);
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ kind: string; message: string } | null>(null);
  const [selectedSource, setSelectedSource] = useState<SourceReference | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [draft, setDraft] = useState<TaskDefinitionDraft>({ objective: "", expectedResult: "", acceptanceCriteria: [], inputSource: "", suggestedMode: "人工执行，按需 AI 辅助" });
  const savedDraft = useRef("");
  const draftRef = useRef(draft);
  const editingRef = useRef(editing);
  const projectRef = useRef(project);
  draftRef.current = draft; editingRef.current = editing; projectRef.current = project;
  const requestVersion = useRef(0);
  const guard = useRef<DraftGuard>({ hasUnsavedChanges: () => editingRef.current && JSON.stringify(draftRef.current) !== savedDraft.current,
    discard: () => { if (projectRef.current) { const next = copyDraft(projectRef.current.task.definition); draftRef.current = next; savedDraft.current = JSON.stringify(next); setDraft(next); } editingRef.current = false; setEditing(false); } });
  useEffect(() => { setDraftGuard(guard.current); return () => { requestVersion.current++; clearDraftGuard(guard.current); }; }, []);

  async function load() {
    const request = ++requestVersion.current;
    setLoading(true); setError(null); setReceipt(null); setActionError(null);
    try { const response = await fixtureAdapter.loadTask(id, mode); if (request !== requestVersion.current) return; setProject(response); if (response) { const next = copyDraft(response.task.definition); setDraft(next); savedDraft.current = JSON.stringify(next); } }
    catch (caught) { if (request === requestVersion.current) setError(caught instanceof Error ? caught.message.trim() : "读取任务示例失败。"); }
    finally { if (request === requestVersion.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { requestVersion.current++; }; }, [id, mode]);
  function beginEdit() { setEditing(true); setActionError(null); setReceipt(null); }
  async function acceptDefinition(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!project || submitting) return;
    const request = ++requestVersion.current;
    setSubmitting(true); setActionError(null); setReceipt(null);
    try { const result = await fixtureAdapter.acceptTaskDefinition(id, copyDraft(draft), mode); if (request !== requestVersion.current) return; const response = await fixtureAdapter.loadTask(id, mode); if (request !== requestVersion.current) return; setProject(response); savedDraft.current = JSON.stringify(copyDraft(draft)); setEditing(false); setReceipt(result.description); }
    catch (caught) { if (request === requestVersion.current) setActionError(toActionError(caught, "接受任务定义失败。")); }
    finally { if (request === requestVersion.current) setSubmitting(false); }
  }
  async function rejectDefinition() {
    if (!project || submitting) return;
    const request = ++requestVersion.current;
    setSubmitting(true); setActionError(null);
    try { await fixtureAdapter.rejectTaskDefinition(id); if (request !== requestVersion.current) return; const response = await fixtureAdapter.loadTask(id, mode); if (request !== requestVersion.current) return; setProject(response); setReceipt("本次演示已暂不采用定义建议；当前任务事实与验收标准保持不变。"); }
    catch (caught) { if (request === requestVersion.current) setActionError(toActionError(caught, "暂不采用定义失败。")); }
    finally { if (request === requestVersion.current) setSubmitting(false); }
  }
  function showSource(sourceId: string) { const source = project?.sources.find((candidate) => candidate.id === sourceId); if (source) { setSelectedSource(source); setSourceOpen(true); } }
  const acceptBlockedReason = !project ? null : project.task.proposalStatus === "APPLIED" ? `已形成 v${project.task.revision} 修订；如需调整，请再次修改建议后接受新的修订。` : project.task.proposalStatus === "REJECTED" ? "该提案已被暂不采用；如需继续，请先修改建议再接受。" : editing ? "正在编辑中，请在编辑区提交这份定义。" : null;
  const proposalLabel = project?.task.proposalStatus === "APPLIED" ? `已形成 v${project.task.revision} 修订` : project?.task.proposalStatus === "REJECTED" ? "已暂不采用" : "待确认";
  if (loading) return <section className="page-state" aria-live="polite"><p className="eyebrow">任务定义</p><h1>正在读取任务定义</h1><p>示例提案尚未被接受或委托。</p></section>;
  if (error) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">任务定义</p><h1>暂时无法显示任务定义</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  if (!project) return <section className="page-state"><p className="eyebrow">任务定义</p><h1>尚未提供任务定义示例</h1><p>这个路由对象没有对应的 Skill fixture，页面不会回退读取或写入其他任务的定义。</p></section>;
  return <section className="skill-page"><div className="page-layout"><div className="page-primary"><p className="eyebrow">{project.task.title}</p><p className="page-lede">{project.task.description}</p><h1>先说清楚，怎样才算完成</h1><p className="metadata-row">任务状态：{taskStatusLabels[project.task.status]} <span aria-hidden="true">|</span> 执行模式：{interactionModeLabels[project.task.mode]} <span aria-hidden="true">|</span> 当前执行者：{executorLabels[project.task.executor]}</p>
    <section className="surface-panel thought-panel" aria-labelledby="original-intent"><h2 id="original-intent">你的原始想法</h2><blockquote>{project.task.originalIntent}</blockquote></section>
    <section className="surface-panel definition-panel" aria-labelledby="definition-heading"><div className="section-heading-row"><h2 id="definition-heading">建议的任务定义 <span className={`status-chip status-chip--${project.task.proposalStatus === "PENDING" ? "warning" : "neutral"}`}>{proposalLabel}</span></h2>{!editing && <button className="text-button" type="button" data-testid="definition-edit" onClick={beginEdit}><Pencil aria-hidden="true" />修改建议</button>}</div>
      {editing ? <form className="edit-form definition-form" data-testid="definition-edit-form" onSubmit={(event) => void acceptDefinition(event)}><label>任务目标<textarea value={draft.objective} onChange={(event) => setDraft({ ...draft, objective: event.target.value })} name="task-objective" rows={3} /></label><label>预期结果<textarea value={draft.expectedResult} onChange={(event) => setDraft({ ...draft, expectedResult: event.target.value })} name="task-result" rows={3} /></label><fieldset><legend>验收条件</legend>{draft.acceptanceCriteria.map((criterion, index) => <label key={index}>条件 {index + 1}<input value={criterion} onChange={(event) => { const next = [...draft.acceptanceCriteria]; next[index] = event.target.value; setDraft({ ...draft, acceptanceCriteria: next }); }} name={`criterion-${index}`} /></label>)}<p className="helper-text">验收条件只作文字修改；降低或删除必需条件需要另行变更验收标准。</p></fieldset><label>输入资料<input value={draft.inputSource} onChange={(event) => setDraft({ ...draft, inputSource: event.target.value })} name="task-source" /></label><div className="form-actions"><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "正在接受" : "接受这份定义"}</button><button className="text-button" type="button" disabled={submitting} onClick={() => guard.current.discard()}>放弃修改</button></div></form> : <dl className="definition-list"><div><dt>任务目标</dt><dd>{draft.objective}</dd></div><div><dt>预期结果</dt><dd>{draft.expectedResult}</dd></div><div><dt>验收条件</dt><dd><ul>{draft.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></dd></div><div><dt>输入资料</dt><dd><button className="inline-link" type="button" onClick={() => showSource("research-notes-v2")}>{draft.inputSource}<ChevronRight aria-hidden="true" /></button></dd></div><div><dt>建议方式</dt><dd>{draft.suggestedMode}</dd></div></dl>}
    </section></div><ResponsiveRail label="查看确认区" title="确认任务定义"><div className="rail-content"><h2>确认任务定义</h2><p className="rail-intro">基于任务 v{project.task.revision}，接受后形成新修订。</p><hr /><h3>来源与依据</h3><dl className="rail-definition-list"><div><dt>当前任务</dt><dd>v{project.task.revision}</dd></div><div><dt>项目资料</dt><dd><button className="inline-link" type="button" onClick={() => showSource("research-notes-v2")}>项目研究笔记 v2</button></dd></div></dl>{receipt && <p className="receipt-message" role="status">{receipt}</p>}{actionError && <p className="action-error" role="alert">{actionError.message}</p>}<button className="primary-button primary-button--wide" type="button" data-testid="definition-accept" disabled={acceptBlockedReason !== null || submitting} onClick={() => void acceptDefinition()}>{submitting ? "正在接受" : "接受这份定义"}</button>{acceptBlockedReason && <p className="disabled-reason" data-testid="definition-accept-reason"><Info aria-hidden="true" />{acceptBlockedReason}</p>}<button className="secondary-button secondary-button--wide" type="button" disabled={submitting || editing} onClick={beginEdit}><Pencil aria-hidden="true" />修改建议</button><button className="text-button text-button--center" type="button" disabled={submitting} data-testid="definition-reject" onClick={() => void rejectDefinition()}><X aria-hidden="true" />暂不采用</button><hr /><p className="helper-text">接受定义后仍需单独开始任务。AI 委托需要另行确认，接受提案不会改变执行权。</p><Link className="text-link" to="/tasks/task-evaluation-metrics?skill=verification">查看验收方案<ChevronRight aria-hidden="true" /></Link></div></ResponsiveRail></div><SourceDetailDialog open={sourceOpen} onClose={() => setSourceOpen(false)} source={selectedSource} /></section>;
}
