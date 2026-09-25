import { Link, useLocation } from "react-router-dom";
import BlueprintView from "./BlueprintView";
import ProjectResumeView from "./ProjectResumeView";

export default function ProjectSkillView() {
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const active = query.get("skill") === "resume" ? "resume" : "blueprint";
  function href(skill: string) { const next = new URLSearchParams(query); next.set("skill", skill); return `${location.pathname}?${next}`; }
  return <div className="skill-shell"><nav className="skill-tabs" aria-label="项目内页面">{[["blueprint", "蓝图预览"], ["resume", "继续项目"]].map(([key, label]) => <Link key={key} className={`skill-tab${active === key ? " skill-tab--active" : ""}`} to={href(key)} aria-current={active === key ? "page" : undefined}>{label}</Link>)}</nav>{active === "blueprint" ? <BlueprintView /> : <ProjectResumeView />}</div>;
}
