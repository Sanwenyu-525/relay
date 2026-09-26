import { Link, useLocation } from "react-router-dom";
import AssistView from "./AssistView";
import TaskDefinitionView from "./TaskDefinitionView";
import TaskDetailView from "./TaskDetailView";
import VerificationPlanView from "./VerificationPlanView";

export default function TaskSkillView() {
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const skill = query.get("skill");
  if (skill !== "definition" && skill !== "verification" && skill !== "assist") return <TaskDetailView />;
  function href(nextSkill: string) { const next = new URLSearchParams(query); next.set("skill", nextSkill); return `${location.pathname}?${next}`; }
  return <div className="skill-shell"><nav className="skill-tabs" aria-label="任务内页面">{[["definition", "完善定义"], ["verification", "验收方案"], ["assist", "Assist"]].map(([key, label]) => <Link key={key} className={`skill-tab${skill === key ? " skill-tab--active" : ""}`} to={href(key)} aria-current={skill === key ? "page" : undefined}>{label}</Link>)}</nav>{skill === "definition" ? <TaskDefinitionView /> : skill === "verification" ? <VerificationPlanView /> : <AssistView targetKind="TASK" />}</div>;
}
