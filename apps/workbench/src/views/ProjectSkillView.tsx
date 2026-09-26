import { Link, useLocation } from "react-router-dom";
import AssistView from "./AssistView";
import BlueprintView from "./BlueprintView";
import ProjectResumeView from "./ProjectResumeView";

export default function ProjectSkillView() {
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const active = query.get("skill") === "assist" ? "assist" : query.get("skill") === "resume" ? "resume" : "blueprint";
  function href(skill: string) { const next = new URLSearchParams(query); next.set("skill", skill); return `${location.pathname}?${next}`; }
  const projectId = /^\/projects\/([^/]+)$/u.exec(location.pathname)?.[1];
  return <div className="skill-shell">{projectId && <div className="project-workbench-entry"><Link className="secondary-button" to={`/projects/${projectId}/workbench`}>打开项目工作台</Link></div>}<nav className="skill-tabs" aria-label="项目内页面">{[["blueprint", "蓝图预览"], ["resume", "继续项目"], ["assist", "Assist"]].map(([key, label]) => <Link key={key} className={`skill-tab${active === key ? " skill-tab--active" : ""}`} to={href(key)} aria-current={active === key ? "page" : undefined}>{label}</Link>)}</nav>{active === "blueprint" ? <BlueprintView /> : active === "resume" ? <ProjectResumeView /> : <AssistView targetKind="PROJECT" />}</div>;
}
