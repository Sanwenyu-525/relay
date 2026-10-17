import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import TaskDefinitionView from "./TaskDefinitionView";
import TaskDetailView from "./TaskDetailView";
import VerificationPlanView from "./VerificationPlanView";

export default function TaskSkillView() {
  const location = useLocation();
  const { id } = useParams();
  const query = new URLSearchParams(location.search);
  const skill = query.get("skill");
  if (skill === "assist" && id) {
    query.delete("skill"); query.set("work", id);
    return <Navigate to={`/agent?${query}`} replace />;
  }
  if (skill !== "definition" && skill !== "verification" && skill !== "assist") return <TaskDetailView />;
  function href(nextSkill: string) { const next = new URLSearchParams(query); next.set("skill", nextSkill); return `${location.pathname}?${next}`; }
  return <div className="skill-shell"><nav className="skill-tabs" aria-label="任务内页面">{[["definition", "完善定义"], ["verification", "验收方案"], ["assist", "Assist"]].map(([key, label]) => <Link key={key} className={`skill-tab${skill === key ? " skill-tab--active" : ""}`} to={href(key)} aria-current={skill === key ? "page" : undefined}>{label}</Link>)}</nav>{skill === "definition" ? <TaskDefinitionView /> : <VerificationPlanView />}</div>;
}
