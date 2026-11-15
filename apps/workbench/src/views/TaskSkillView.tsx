import { Navigate, useLocation, useParams } from "react-router-dom";
import TaskDefinitionView from "./TaskDefinitionView";
import TaskDetailView from "./TaskDetailView";
import VerificationPlanView from "./VerificationPlanView";
import { Tabs } from "../ui";

const taskSkillTabs = [["definition", "完善定义"], ["verification", "验收方案"], ["assist", "Assist"]] as const;

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
  return <div className="skill-shell pv-page"><Tabs label="任务内页面" variant="page" className="skill-tabs"
    items={taskSkillTabs.map(([key, label]) => ({ key, label, href: href(key), className: "skill-tab" }))} />{skill === "definition" ? <TaskDefinitionView /> : <VerificationPlanView />}</div>;
}
