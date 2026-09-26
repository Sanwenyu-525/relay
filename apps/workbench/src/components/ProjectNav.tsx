import { Link } from "react-router-dom";

const items = [
  { key: "overview", label: "总览", path: "" },
  { key: "workbench", label: "工作台", path: "/workbench" },
  { key: "tasks", label: "任务", path: "/tasks" },
  { key: "knowledge", label: "资料", path: "/knowledge" },
  { key: "connections", label: "连接", path: "/connections" }
] as const;

export default function ProjectNav({ projectId, active }: { projectId: string; active: "overview" | "workbench" | "tasks" | "knowledge" | "connections" }) {
  return <nav className="subnav" aria-label="项目内页面">{items.map((item) =>
    <Link key={item.key} className={`subnav-item${item.key === active ? " subnav-item--active" : ""}`} to={`/projects/${projectId}${item.path}`} aria-current={item.key === active ? "page" : undefined}>{item.label}</Link>
  )}</nav>;
}
