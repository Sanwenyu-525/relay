import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowRight, Check, ChevronRight, ClipboardCheck, FileText, Info, Monitor, Pencil, RotateCcw, X } from "lucide-react";
import AppDialog from "../components/AppDialog";
import ResponsiveRail from "../components/ResponsiveRail";
import SourceDetailDialog from "../components/SourceDetailDialog";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { useRelayConnection } from "../lib/relayConnection";
import type { BlueprintDraft, FixtureError, ProjectSnapshot, SourceReference } from "../types";
import LiveBlueprintView from "./LiveBlueprintView";

const copyDraft = (value: BlueprintDraft): BlueprintDraft => ({ ...value, taskTitles: [...value.taskTitles] });
function toActionError(caught: unknown, fallback: string) {
  return { kind: caught instanceof Error && "kind" in caught ? String((caught as FixtureError).kind) : "unknown", message: caught instanceof Error ? caught.message.trim() : fallback };
}

function FixtureBlueprintView() {
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
  const [candidateVersion, setCandidateVersion] = useState<number | null>(null);
  const [selectedSource, setSelectedSource] = useState<SourceReference | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [notConnected, setNotConnected] = useState<string | null>(null);
  const [draft, setDraft] = useState<BlueprintDraft>({ nextAction: "", taskTitles: ["", ""], workbench: "论文" });
  const savedDraft = useRef("");
  const draftRef = useRef(draft);
  const editingRef = useRef(editing);
  const projectRef = useRef(project);
  draftRef.current = draft; editingRef.current = editing; projectRef.current = project;
  const lastCommandId = useRef<string | null>(null);
  const requestVersion = useRef(0);
  const guard = useRef<DraftGuard>({ hasUnsavedChanges: () => editingRef.current && JSON.stringify(draftRef.current) !== savedDraft.current,
    discard: () => { if (projectRef.current) { const original = copyDraft(projectRef.current.blueprint.draft); draftRef.current = original; savedDraft.current = JSON.stringify(original); setDraft(original); } editingRef.current = false; setEditing(false); } });
  useEffect(() => { setDraftGuard(guard.current); return () => { requestVersion.current++; clearDraftGuard(guard.current); }; }, []);

  async function load() {
    const request = ++requestVersion.current;
    setLoading(true); setError(null); setReceipt(null); setActionError(null);
    try {
      const response = await fixtureAdapter.loadProject(id, mode);
      if (request !== requestVersion.current) return;
      setProject(response);
      if (response) { const next = copyDraft(response.blueprint.draft); setDraft(next); savedDraft.current = JSON.stringify(next); setCandidateVersion(null); }
    } catch (caught) { if (request === requestVersion.current) setError(caught instanceof Error ? caught.message.trim() : "读取示例数据时发生未知错误。"); }
    finally { if (request === requestVersion.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { requestVersion.current++; }; }, [id, mode]);
  async function reloadAfterCommand() { const response = await fixtureAdapter.loadProject(id, mode); setProject(response); if (response) savedDraft.current = JSON.stringify(copyDraft(response.blueprint.draft)); }
  function beginEdit() { setEditing(true); setReceipt(null); setActionError(null); }
  function abandonEdit() { guard.current.discard(); }
  async function previewEditedDraft(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (submitting) return;
    const request = ++requestVersion.current;
    setSubmitting(true); setActionError(null);
    try {
      const preview = await fixtureAdapter.previewBlueprint(id, copyDraft(draft), mode);
      if (request !== requestVersion.current) return;
      const previousVersion = project?.blueprint.version ?? null;
      const response = await fixtureAdapter.loadProject(id, mode);
      if (request !== requestVersion.current) return;
      setProject(response); setCandidateVersion(preview.version); savedDraft.current = JSON.stringify(draft); setEditing(false);
      setReceipt(`本次演示已形成新候选 v${preview.version}，替代 v${previousVersion ?? 1}；尚未应用到项目。`);
    } catch (caught) { if (request === requestVersion.current) setActionError(toActionError(caught, "无法生成新的演示预览。")); }
    finally { if (request === requestVersion.current) setSubmitting(false); }
  }
  async function applyBlueprint() {
    if (submitting || !project) return;
    const request = ++requestVersion.current;
    setSubmitting(true); setActionError(null); setReceipt(null);
    try {
      lastCommandId.current = fixtureAdapter.createCommandId("project");
      const result = await fixtureAdapter.applyBlueprint(id, copyDraft(draft), mode, lastCommandId.current);
      if (request !== requestVersion.current) return;
      await reloadAfterCommand();
      if (request !== requestVersion.current) return;
      setReceipt(result.description); setEditing(false); setCandidateVersion(null);
    } catch (caught) { if (request === requestVersion.current) setActionError(toActionError(caught, "应用示例蓝图时发生未知错误。")); }
    finally { if (request === requestVersion.current) setSubmitting(false); }
  }
  async function rejectBlueprint() {
    if (submitting || !project) return;
    const request = ++requestVersion.current;
    setSubmitting(true); setActionError(null);
    try { await fixtureAdapter.rejectBlueprint(id); if (request !== requestVersion.current) return; await reloadAfterCommand(); if (request !== requestVersion.current) return; setCandidateVersion(null); setEditing(false); setReceipt("本次演示已暂不采用蓝图；已创建的项目仍保留，未新增任务或配置。"); }
    catch (caught) { if (request === requestVersion.current) setActionError(toActionError(caught, "暂不采用建议失败。")); }
    finally { if (request === requestVersion.current) setSubmitting(false); }
  }
  async function lookupReceipt() {
    if (submitting) return;
    if (!lastCommandId.current) { setActionError({ kind: "unknown", message: "本页尚无可查询的提交；请先提交一次，不能凭空生成回执。" }); return; }
    const request = ++requestVersion.current;
    setSubmitting(true); setActionError(null);
    try { const result = await fixtureAdapter.lookupReceipt(lastCommandId.current); if (request === requestVersion.current) setReceipt(result.status === "APPLIED" ? result.receipt?.description ?? "本次演示已确认应用。" : result.status === "UNKNOWN" ? "本次提交仍未确认；请继续使用同一 command ID 核对，不能直接重试。" : "未找到本次提交的回执；请先核对当前候选。"); }
    finally { if (request === requestVersion.current) setSubmitting(false); }
  }
  function showSource(sourceId: string) { const source = project?.sources.find((candidate) => candidate.id === sourceId); if (source) { setSelectedSource(source); setSourceOpen(true); } }
  const applyBlockedReason = !project ? null : project.blueprint.status === "APPLIED" ? "这份蓝图已应用；如需调整，请修改建议并重新生成候选。" : editing ? "修改尚未形成新候选，请先重新预览再应用。" : project.blueprint.status === "REJECTED" && candidateVersion === null ? "该候选已被暂不采用；如需继续，请修改建议并重新预览。" : null;
  const statusLabel = candidateVersion !== null ? `本轮新候选 v${candidateVersion}` : project?.blueprint.status === "APPLIED" ? "本次演示已应用" : project?.blueprint.status === "REJECTED" ? "已暂不采用" : "待确认";
  if (loading) return <section className="page-state" aria-live="polite"><p className="eyebrow">项目蓝图</p><h1>正在读取蓝图预览</h1><p>示例数据正在加载，页面仍未提交任何变更。</p></section>;
  if (error) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">项目蓝图</p><h1>暂时无法显示蓝图</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  if (!project) return <section className="page-state"><p className="eyebrow">项目蓝图</p><h1>尚未提供项目蓝图示例</h1><p>这个路由对象没有对应的 Skill fixture，页面不会回退读取或写入其他项目的蓝图。</p></section>;
  return <section className="skill-page"><div className="page-layout"><div className="page-primary"><p className="eyebrow">{project.name}</p><p className="page-lede">项目已创建，以下建议等待你确认。</p><h1>让目标，有一条清晰的路径</h1><p className="metadata-row">蓝图建议 v{candidateVersion ?? project.blueprint.version ?? 1} <span aria-hidden="true">·</span> 基于项目状态 v{project.blueprint.baseRevision} <span aria-hidden="true">·</span> {statusLabel}</p>
    <section className="surface-panel blueprint-panel" aria-labelledby="blueprint-changes"><div className="section-heading-row"><h2 id="blueprint-changes">本次蓝图变更</h2>{!editing && project.blueprint.status !== "APPLIED" && <button className="text-button" type="button" data-testid="blueprint-edit" onClick={beginEdit}><Pencil aria-hidden="true" />修改建议</button>}</div>
    {editing ? <form className="edit-form" data-testid="blueprint-edit-form" onSubmit={(event) => void previewEditedDraft(event)}><label>下一步<input value={draft.nextAction} onChange={(event) => setDraft({ ...draft, nextAction: event.target.value })} name="blueprint-next-action" /></label>{[0, 1].map((index) => <label key={index}>新任务{index === 0 ? "一" : "二"}<input value={draft.taskTitles[index] ?? ""} onChange={(event) => { const next = [...draft.taskTitles]; next[index] = event.target.value; setDraft({ ...draft, taskTitles: next }); }} name={index === 0 ? "blueprint-task-one" : "blueprint-task-two"} /></label>)}<fieldset><legend>工作台建议</legend>{["通用", "论文"].map((value) => <label key={value} className="radio-option"><input checked={draft.workbench === value} onChange={() => setDraft({ ...draft, workbench: value as BlueprintDraft["workbench"] })} type="radio" value={value} />{value}</label>)}</fieldset><div className="form-actions"><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "正在重新预览" : "重新预览建议"}</button><button className="text-button" type="button" disabled={submitting} onClick={abandonEdit}>放弃修改</button></div></form> : <div className="blueprint-diff" aria-label="当前与建议的蓝图差异"><div className="diff-heading"><span aria-hidden="true" /><strong>当前</strong><strong>建议</strong></div><div className="diff-row"><span className="diff-icon"><ArrowRight aria-hidden="true" /></span><span><strong>下一步</strong><small>{project.nextAction ?? "尚未明确"}</small></span><span className="diff-arrow-cell"><ArrowRight aria-hidden="true" /></span><span className="suggested-value">{draft.nextAction || "（未填写）"}</span></div><div className="diff-row"><span className="diff-icon"><ClipboardCheck aria-hidden="true" /></span><span><strong>任务</strong><small>{project.tasks.length ? `${project.tasks.length} 项已创建` : "暂无任务"}</small></span><span className="diff-arrow-cell"><ArrowRight aria-hidden="true" /></span><span className="suggested-value">{draft.taskTitles.filter(Boolean).join("、") || "（无新任务）"}<small>新任务进入收件箱，由我执行；不会自动开始。</small></span></div><div className="diff-row"><span className="diff-icon"><Monitor aria-hidden="true" /></span><span><strong>工作台</strong><small>{project.workbench}</small></span><span className="diff-arrow-cell"><ArrowRight aria-hidden="true" /></span><span className="suggested-value">{draft.workbench}</span></div></div>}
    <div className="follow-up-section"><h2>后续配置建议</h2><p>以下内容可按需单独确认，不随本次蓝图应用。</p>{[["rules", "引用核对规则", "建议配置文献引用的核对规则，提升内容可靠性。"], ["verification", "验证配置", "建议配置结果验证方式，用于后续成果的质量检查。"]].map(([key, heading, copy]) => <div className="suggestion-row" key={key}>{key === "rules" ? <FileText aria-hidden="true" /> : <ClipboardCheck aria-hidden="true" />}<span className="suggestion-copy"><strong>{heading}</strong><small>{copy}</small></span><button className="text-button" type="button" onClick={() => setNotConnected(key)}>单独确认<ChevronRight aria-hidden="true" /></button></div>)}</div></section>
  </div><ResponsiveRail label="查看确认区" title="确认这次变化"><div className="rail-content"><h2>确认这次变化</h2><p className="rail-intro">请查看蓝图建议，确认后应用到项目中。</p><div className="summary-card"><p><Check aria-hidden="true" /><strong>{draft.taskTitles.filter(Boolean).length} 项新任务</strong></p><p><ArrowRight aria-hidden="true" /><strong>1 项下一步</strong></p><p><Monitor aria-hidden="true" /><strong>{draft.workbench}工作台</strong></p><hr /><h3>已选来源</h3><button className="source-button" type="button" onClick={() => showSource("goal-v1")}><FileText aria-hidden="true" />项目目标 v1</button><button className="source-button" type="button" onClick={() => showSource("research-notes-v2")}><FileText aria-hidden="true" />项目研究笔记 v2</button></div>{receipt && <p className="receipt-message" role="status">{receipt}</p>}{actionError && <p className="action-error" role="alert">{actionError.message}</p>}<button className="primary-button primary-button--wide" type="button" data-testid="blueprint-apply" disabled={applyBlockedReason !== null || submitting} onClick={() => void applyBlueprint()}>{submitting ? "正在应用" : project.blueprint.status === "APPLIED" ? "蓝图已应用" : "应用这份蓝图"}</button>{applyBlockedReason && <p className="disabled-reason" data-testid="blueprint-apply-reason"><Info aria-hidden="true" />{applyBlockedReason}</p>}{actionError?.kind === "timeout" && <button className="secondary-button secondary-button--wide" type="button" disabled={submitting} onClick={() => void lookupReceipt()}>查询本次回执</button>}{actionError?.kind === "conflict" && <button className="secondary-button secondary-button--wide" type="button" disabled={submitting} onClick={() => void previewEditedDraft()}>按当前草稿重新核对</button>}{project.blueprint.status !== "APPLIED" && <div className="rail-inline-actions"><button className="text-button" type="button" disabled={submitting} onClick={beginEdit}>修改建议</button><span aria-hidden="true" /><button className="text-button" type="button" disabled={submitting} data-testid="blueprint-reject" onClick={() => void rejectBlueprint()}><X aria-hidden="true" />暂不采用</button></div>}<p className="helper-text">暂不采用会保留已创建的项目。本次不会开始任务或应用后续配置。</p></div></ResponsiveRail></div><SourceDetailDialog open={sourceOpen} onClose={() => setSourceOpen(false)} source={selectedSource} /><AppDialog open={notConnected !== null} title="该入口尚未接入" onClose={() => setNotConnected(null)}><p>{notConnected === "rules" ? "引用核对规则需要在规则入口单独确认；本轮交互预览未接入规则写入，因此不会随蓝图应用，也不会在此处生成规则。" : "验证配置需要在验证入口单独确认；本轮交互预览未接入配置写入。你可以在任务的验收方案中预览检查建议。"}</p><Link className="text-link" to="/tasks/task-evaluation-metrics?skill=verification">前往任务的验收方案<ChevronRight aria-hidden="true" /></Link></AppDialog></section>;
}

export default function BlueprintView() {
  const connection = useRelayConnection();
  return connection.mode === "live" ? <LiveBlueprintView /> : <FixtureBlueprintView />;
}
