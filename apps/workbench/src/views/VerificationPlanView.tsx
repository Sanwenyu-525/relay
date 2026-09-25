import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { AlertTriangle, Circle, CircleEllipsis, FileText, Info, Pencil, RotateCcw, Save } from "lucide-react";
import ResponsiveRail from "../components/ResponsiveRail";
import SourceDetailDialog from "../components/SourceDetailDialog";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { compareDecimalRevisions } from "../lib/decimalRevision";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import type { ProjectSnapshot, SourceReference, VerificationCheck } from "../types";

function statusText(check: VerificationCheck) { return check.status === "MISSING_CAPABILITY" ? "缺少可用检查器" : check.status === "HUMAN_PENDING" ? "待人工检查" : "未运行"; }

export default function VerificationPlanView() {
  const { id = "" } = useParams();
  const [query] = useSearchParams();
  const mode = fixtureModeFromQuery(query);
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const savedNote = useRef("");
  const [selectedSource, setSelectedSource] = useState<SourceReference | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const requestVersion = useRef(0);
  const current = useRef({ note, editing });
  current.current = { note, editing };
  const guard = useRef<DraftGuard>({ hasUnsavedChanges: () => current.current.editing && current.current.note !== savedNote.current,
    discard: () => { current.current = { note: savedNote.current, editing: false }; setNote(savedNote.current); setEditing(false); } });
  useEffect(() => { setDraftGuard(guard.current); return () => { requestVersion.current++; clearDraftGuard(guard.current); }; }, []);
  const checks = project?.verification.checks ?? [];
  const missingCapability = checks.some((check) => check.status === "MISSING_CAPABILITY");
  const baselineStale = project !== null && compareDecimalRevisions(project.verification.taskRevision, project.task.revision) < 0;
  const applyReason = !project ? "" : baselineStale ? `本方案建议基于任务 v${project.verification.taskRevision}，任务已接受 v${project.task.revision} 修订；需要按新修订重新生成方案后再应用。` : missingCapability ? "必需检查的执行方式尚未明确：语义核对缺少已登记的可用检查器。" : "本轮为交互预览，应用为检查方案的写入口尚未接入；保存建议不会让检查计划生效。";

  async function load() {
    const request = ++requestVersion.current;
    setLoading(true); setError(null); setSavedMessage(null);
    try { const response = await fixtureAdapter.loadTask(id, mode); if (request !== requestVersion.current) return; setProject(response); const value = response?.verification.savedNote ?? ""; setNote(value); savedNote.current = value; setEditing(false); }
    catch (caught) { if (request === requestVersion.current) setError(caught instanceof Error ? caught.message.trim() : "读取验收方案失败。"); }
    finally { if (request === requestVersion.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { requestVersion.current++; }; }, [id, mode]);
  async function saveSuggestion() {
    if (saving) return;
    const request = ++requestVersion.current;
    setSaving(true); setSavedMessage(null);
    try { const receipt = await fixtureAdapter.saveVerificationSuggestion(id, note.trim()); if (request !== requestVersion.current) return; const response = await fixtureAdapter.loadTask(id, mode); if (request !== requestVersion.current) return; setProject(response); const value = response?.verification.savedNote ?? note; setNote(value); savedNote.current = value; setEditing(false); setSavedMessage(receipt.description); }
    catch (caught) { if (request === requestVersion.current) setError(caught instanceof Error ? caught.message.trim() : "保存建议失败。"); }
    finally { if (request === requestVersion.current) setSaving(false); }
  }
  function showSource(sourceId: string) { const source = project?.sources.find((candidate) => candidate.id === sourceId); if (source) { setSelectedSource(source); setSourceOpen(true); } }
  if (loading) return <section className="page-state" aria-live="polite"><p className="eyebrow">验收方案</p><h1>正在读取检查建议</h1><p>尚未运行任何检查，也没有形成有效 CheckPlan。</p></section>;
  if (error) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">验收方案</p><h1>暂时无法显示检查建议</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  if (!project) return <section className="page-state"><p className="eyebrow">验收方案</p><h1>尚未提供验收方案示例</h1><p>这个路由对象没有对应的 Skill fixture，页面不会回退读取或写入其他任务的检查建议。</p></section>;
  return <section className="skill-page"><div className="page-layout"><div className="page-primary"><p className="eyebrow">生成验收方案</p><h1>把完成标准，变成可核对的依据。</h1><p className="page-lede">基于验收标准，梳理检查项与检查方式，便于后续实施与审查。</p><p className="metadata-row">任务：v{project.verification.taskRevision} <span aria-hidden="true">|</span> 验收标准：v{project.verification.acceptanceRevision} <span aria-hidden="true">|</span> 方案建议：v{project.verification.proposalVersion} <span aria-hidden="true">|</span> 状态：<span className="status-chip status-chip--warning">{baselineStale ? "基线已过期" : "待确认"}</span></p>
    {baselineStale && <div className="warning-callout" role="status" data-testid="verification-stale"><AlertTriangle aria-hidden="true" /><p>本方案建议基于任务 v{project.verification.taskRevision}，当前任务已接受 v{project.task.revision} 修订；需要按新修订重新生成方案，旧建议不能直接应用。</p></div>}
    <section className="verification-section" aria-labelledby="verification-checks"><h2 id="verification-checks">建议检查项</h2><p>根据验收标准与任务目标，建议以下检查项及其检查方式。确认后才能应用为检查方案。</p><div className="check-table" role="table" aria-label="建议的检查项"><div className="check-table-row check-table-row--head" role="row"><span role="columnheader">检查项</span><span role="columnheader">方式</span><span role="columnheader">当前状态</span></div>{checks.map((check) => <div key={check.id} className="check-table-row" role="row"><strong role="cell">{check.title}</strong><span role="cell">{check.method}</span><span role="cell" className={`check-status check-status--${check.status === "MISSING_CAPABILITY" ? "warning" : "neutral"}`}>{check.status === "MISSING_CAPABILITY" ? <AlertTriangle aria-hidden="true" /> : check.status === "HUMAN_PENDING" ? <CircleEllipsis aria-hidden="true" /> : <Circle aria-hidden="true" />}{statusText(check)}</span></div>)}</div><p className="helper-text">“方式”是建议的检查方式，“当前状态”是检查结果状态；缺少检查器和待人工检查都不等于通过。</p>{missingCapability && <div className="warning-callout" role="status" data-testid="verification-warning"><AlertTriangle aria-hidden="true" /><p>语义核对缺少可用检查器，需要补齐能力或另行确认合规的检查方式。不得跳过必需检查。</p></div>}</section>
    {editing && <section className="surface-panel verification-edit" aria-labelledby="edit-plan"><h2 id="edit-plan">修改检查建议</h2><p>必需检查项不可删除或降级，验收标准保持 v{project.verification.acceptanceRevision} 不变；此处只能补充「待确认说明」。</p><label>待确认说明<textarea value={note} onChange={(event) => setNote(event.target.value)} name="verification-note" rows={4} placeholder="例如：等待登记语义核对检查器后重新预览。" /></label><div className="form-actions"><button className="primary-button" type="button" data-testid="verification-save" disabled={saving} onClick={() => void saveSuggestion()}><Save aria-hidden="true" />{saving ? "正在保存" : "保存为待确认建议"}</button><button className="text-button" type="button" disabled={saving} onClick={() => { setEditing(false); setSavedMessage("已保留待确认说明草稿，尚未保存为建议。"); }}>取消</button></div></section>}
  </div><ResponsiveRail label="查看确认区" title="先确认检查方式"><div className="rail-content"><h2>先确认检查方式</h2><p className="rail-intro">验收标准 v{project.verification.acceptanceRevision} 保持不变，请确认各检查项的检查方式。</p><hr /><h3>相关来源</h3>{[["result-definition-v2", "结果定义 v2"], ["acceptance-v2", "验收标准 v2"], ["checker-registry-v1", "当前可用检查器 v1"]].map(([sourceId, label]) => <button key={sourceId} className="source-button" type="button" onClick={() => showSource(sourceId)}><FileText aria-hidden="true" />{label}</button>)}<button className="primary-button primary-button--wide" type="button" disabled={saving} onClick={() => { setEditing(true); setSavedMessage(null); }}><Pencil aria-hidden="true" />修改检查方案</button><button className="secondary-button secondary-button--wide" type="button" data-testid="verification-save-rail" disabled={saving} onClick={() => { if (editing) void saveSuggestion(); else { setEditing(true); setSavedMessage(null); } }}><Save aria-hidden="true" />{saving ? "正在保存" : "保存为待确认建议"}</button><button className="primary-button primary-button--wide" type="button" data-testid="verification-apply" disabled aria-describedby="verification-disabled-reason">应用为检查方案</button><p id="verification-disabled-reason" className="disabled-reason" data-testid="verification-apply-reason"><Info aria-hidden="true" />{applyReason}</p>{savedMessage && <p className="receipt-message" role="status">{savedMessage}</p>}<hr /><p className="helper-text">检查方案不是检查结果，检查通过也不等于任务完成。</p></div></ResponsiveRail></div><SourceDetailDialog open={sourceOpen} onClose={() => setSourceOpen(false)} source={selectedSource} /></section>;
}
