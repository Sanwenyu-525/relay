import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CheckCircle2, ChevronRight, Circle, CircleEllipsis, FileText, Info, RotateCcw, TriangleAlert } from "lucide-react";
import ResponsiveRail from "../components/ResponsiveRail";
import SourceDetailDialog from "../components/SourceDetailDialog";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import type { ProjectSnapshot, ResumeProgressItem, ResumeSuggestion, SourceReference } from "../types";

const resumeSourceIds = ["project-state-v4", "task-list-v1", "literature-review-v3", "acceptance-v2", "review-record-v1"];

export default function ProjectResumeView() {
  const navigate = useNavigate();
  const { id = "" } = useParams();
  const [query] = useSearchParams();
  const mode = fixtureModeFromQuery(query);
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<SourceReference | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const version = useRef(0);
  const resume = project?.resume ?? null;
  const railSources = resumeSourceIds.map((sourceId) => project?.sources.find((source) => source.id === sourceId) ?? null).filter((source): source is SourceReference => source !== null);

  async function load() {
    const request = ++version.current;
    setLoading(true);
    setError(null);
    try { const response = await fixtureAdapter.loadProject(id, mode); if (request === version.current) setProject(response); }
    catch (caught) { if (request === version.current) setError(caught instanceof Error ? caught.message.trim() : "读取恢复摘要失败。"); }
    finally { if (request === version.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { version.current++; }; }, [id, mode]);

  async function refreshSummary() {
    if (refreshing) return;
    const request = ++version.current;
    setRefreshing(true);
    setError(null);
    try { const response = await fixtureAdapter.refreshResume(id, mode); if (request === version.current) setProject(response); }
    catch (caught) { if (request === version.current) setError(caught instanceof Error ? caught.message.trim() : "刷新摘要失败。"); }
    finally { if (request === version.current) setRefreshing(false); }
  }
  function showSource(sourceId: string) {
    const source = project?.sources.find((candidate) => candidate.id === sourceId);
    if (source) { setSelectedSource(source); setSourceOpen(true); }
  }
  function openTarget(target: ResumeProgressItem["target"] | ResumeSuggestion["target"]) {
    if (target.kind === "task") navigate(`/tasks/${target.taskId}?skill=definition`);
    else showSource(target.sourceId);
  }
  if (loading) return <section className="page-state" aria-live="polite"><p className="eyebrow">继续这个项目</p><h1>正在读取项目上下文</h1><p>读取只读摘要不会开始或恢复执行，也不会改变当前执行者。</p></section>;
  if (error && !project) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">继续这个项目</p><h1>暂时无法显示恢复摘要</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  if (!project || !resume) return <section className="page-state"><p className="eyebrow">继续这个项目</p><h1>尚未提供项目恢复摘要示例</h1><p>这个路由对象没有对应的 Skill fixture，页面不会回退读取其他项目的历史或下一步。</p></section>;
  return <section className="skill-page"><div className="page-layout"><div className="page-primary"><p className="eyebrow">{project.name}</p><h1>从这里，接着往前。</h1><p className="metadata-row">只读摘要 <span aria-hidden="true">·</span> 更新于 {resume.updatedAt}</p>{error && <p className="action-error" role="alert">{error}</p>}
    <section className="resume-section" aria-labelledby="progress-heading"><h2 id="progress-heading">当前进展</h2><div className="progress-list">{resume.progress.map((item) => { const Icon = item.state === "completed" ? CheckCircle2 : item.state === "review" ? CircleEllipsis : Circle; return <div key={item.id} className={`progress-row progress-row--${item.state}`}><Icon aria-hidden="true" /><strong>{item.state === "completed" ? "已完成" : item.state === "review" ? "待你判断" : "可开始"}</strong><span>{item.label}</span><button className="inline-link" type="button" onClick={() => openTarget(item.target)}>{item.action}<ChevronRight aria-hidden="true" /></button></div>; })}</div></section>
    <section className="resume-section" aria-labelledby="risk-heading"><h2 id="risk-heading">需要留意</h2>{resume.risks.map((risk) => <div key={risk.text} className="warning-callout" role="status"><TriangleAlert aria-hidden="true" /><p>{risk.text}</p><button className="inline-link" type="button" onClick={() => showSource(risk.sourceId)}>查看来源<ChevronRight aria-hidden="true" /></button></div>)}</section>
    <section className="resume-section" aria-labelledby="next-heading"><h2 id="next-heading">建议的下一步</h2><div className="suggestion-list">{resume.suggestions.map((suggestion, index) => <button key={suggestion.id} className="resume-suggestion" type="button" onClick={() => openTarget(suggestion.target)}><span className="suggestion-index">{String(index + 1).padStart(2, "0")}</span><strong>{suggestion.text}</strong><small>{suggestion.basis}</small><ChevronRight aria-hidden="true" /></button>)}</div><p className="helper-text">以上为建议，尚未执行；摘要不会开始或恢复执行。</p></section>
  </div><ResponsiveRail label="查看项目上下文" title="找回项目上下文"><div className="rail-content"><h2>找回项目上下文</h2><div className="summary-card summary-card--source-list">{railSources.map((source) => <button key={source.id} className="source-button source-button--row" type="button" onClick={() => showSource(source.id)}><FileText aria-hidden="true" /><span className="source-button-copy"><strong>{source.title} {source.version}</strong><small>{source.availability === "available" ? "查看来源" : "来源不可用"}</small></span><ChevronRight aria-hidden="true" /></button>)}</div><hr />{!resume.hasBaseline && <p className="helper-text">本次没有可用的上次查看基线，不展示变化对比。</p>}<button className="primary-button primary-button--wide" type="button" onClick={() => showSource("literature-review-v3")}>查看待审产物</button><button className="secondary-button secondary-button--wide" type="button" disabled={refreshing} onClick={() => void refreshSummary()}><RotateCcw aria-hidden="true" />{refreshing ? "正在刷新摘要" : "刷新摘要"}</button><p className="disabled-reason"><Info aria-hidden="true" />摘要不会自动开始任务或恢复执行。</p></div></ResponsiveRail></div><SourceDetailDialog open={sourceOpen} onClose={() => setSourceOpen(false)} source={selectedSource} /></section>;
}
