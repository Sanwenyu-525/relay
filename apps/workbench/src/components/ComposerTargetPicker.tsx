import { useEffect, useRef, useState } from "react";
import { ChevronDown, FolderKanban, ListChecks } from "lucide-react";
import type { RelayApiClient } from "../api/relayClient";
import type { RelayProjectListItem } from "../api/dtos/projects";
import type { RelayTaskSummary } from "../api/dtos/tasks";
import { describeLiveError } from "../lib/liveErrors";
import { taskStatusLabels } from "../lib/labels";
import { useDetailsMenu } from "../lib/popoverMenu";
import "./ComposerTargetPicker.css";

/**
 * 输入器工具行上的「选择任务 / 选择项目」芯片（2026-10-18，工作台 §32.11）。
 *
 * 背景：Skill 的作用域（`target: TASK | PROJECT`）描述的是**这次调用要读谁的事实**，
 * 不是入口门禁。上游（OpenCode / Codex）的 Skill 只有来源分层与权限，没有「必须先属于
 * 某个项目」；因此这里把「缺上下文」做成可在原地补齐的一步：选中需要上下文的 Skill 后，
 * 用户在这里指定任务或项目，而不是让那一行点了没反应。
 *
 * 边界：本芯片**不创建会话、不改归属**——它只把用户选中的目标交给调用方（AssistView →
 * 宿主），由宿主把这条对话带到该目标的真实作用域里。归属仍在建会话时确定并冻结。
 */
export type ComposerTargetKind = "PROJECT" | "TASK";

export interface ComposerTargetChoice {
  readonly kind: ComposerTargetKind;
  readonly id: string;
  /** 任务所属项目；选项目时与 id 相同。 */
  readonly projectId: string;
  readonly title: string;
}

export default function ComposerTargetPicker({ client, need, disabled = false, onPick }: {
  client: RelayApiClient | null;
  /** 缺少哪一种上下文：`TASK` 列出「项目 → 任务」，`PROJECT` 只列项目。 */
  need: ComposerTargetKind;
  disabled?: boolean;
  onPick: (choice: ComposerTargetChoice) => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useDetailsMenu(detailsRef);
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<readonly RelayProjectListItem[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string>("");
  const [tasks, setTasks] = useState<readonly RelayTaskSummary[] | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  // 项目清单按需读取：只有弹层真的打开过才发请求，与命令清单/连接器同一口径。
  useEffect(() => {
    if (!open || client === null || projects !== null || projectsError !== null) return;
    const version = ++requestVersion.current;
    void client.getProjectsPage("active").then((page) => {
      if (version !== requestVersion.current) return;
      setProjects(page.items);
      // 只有一个项目时直接选中，少一次选择；多于一个时留给用户明确指定。
      if (need === "TASK" && page.items.length === 1) setProjectId(page.items[0]!.id);
    }).catch((caught) => {
      if (version === requestVersion.current) setProjectsError(describeLiveError(caught).message);
    });
    return () => { requestVersion.current++; };
  }, [open, client, projects, projectsError, need]);

  useEffect(() => {
    if (need !== "TASK" || client === null || projectId === "") { setTasks(null); setTasksError(null); return; }
    const version = ++requestVersion.current;
    setTasks(null); setTasksError(null);
    void client.getProjectTasks(projectId).then((items) => {
      if (version !== requestVersion.current) return;
      setTasks(items);
    }).catch((caught) => {
      if (version === requestVersion.current) setTasksError(describeLiveError(caught).message);
    });
    return () => { requestVersion.current++; };
  }, [need, client, projectId]);

  const needLabel = need === "TASK" ? "任务" : "项目";
  const label = `选择${needLabel}`;
  const selectedProject = projects?.find((item) => item.id === projectId) ?? null;

  const projectRows = (projects ?? []).map((project) => <button key={project.id} type="button"
    className="composer-target-row" data-testid={`composer-target-project-${project.id}`}
    data-current={project.id === projectId ? "true" : "false"}
    onClick={() => {
      // 选项目类 Skill 时，点项目就是最终选择；选任务时还要再指定任务。
      if (need === "PROJECT") { detailsRef.current && (detailsRef.current.open = false); onPick({ kind: "PROJECT", id: project.id, projectId: project.id, title: project.title }); return; }
      setProjectId(project.id);
    }}>
    <span className="composer-target-row-title"><FolderKanban aria-hidden="true" />{project.title}</span>
    {need === "TASK" && <span className="composer-target-row-body">选择后列出该项目的任务</span>}
  </button>);

  const taskRows = (tasks ?? []).map((task) => <button key={task.id} type="button"
    className="composer-target-row" data-testid={`composer-target-task-${task.id}`}
    onClick={() => {
      detailsRef.current && (detailsRef.current.open = false);
      onPick({ kind: "TASK", id: task.id, projectId: task.projectId ?? projectId, title: task.title });
    }}>
    <span className="composer-target-row-title"><ListChecks aria-hidden="true" />{task.title}</span>
    <span className="composer-target-row-body">{taskStatusLabels[task.status]}</span>
  </button>);

  return <details className="composer-target" data-need={need} ref={detailsRef}
    onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="agent-chat-tool composer-target-chip" data-testid="composer-target"
      aria-disabled={disabled || undefined}
      aria-label={`这个 Skill 需要${needLabel}：${label}`} title={disabled ? "发送中，稍后再选"
        : `这个 Skill 需要${needLabel}上下文`}
      onClick={(event) => { if (disabled) event.preventDefault(); }}>
      <ListChecks aria-hidden="true" />{label}<ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" />
    </summary>
    <div className="composer-target-menu" role="group" aria-label={label}>
      <p className="composer-target-head">这个 Skill 要读{needLabel}的事实，先指定一条：</p>
      {client === null ? <p className="composer-target-line">连接本机 API 后才能列出{needLabel}。</p>
        : projectsError !== null ? <p className="composer-target-line composer-target-line--error" role="alert">
          {needLabel}清单读取失败：{projectsError}</p>
        : projects === null ? <p className="composer-target-line">正在读取{needLabel}…</p>
        : projects.length === 0 ? <p className="composer-target-line">
          还没有{need === "TASK" ? "可用的项目；任务挂在项目下" : "项目"}，先创建一个。</p>
        : projectRows}
      {need === "TASK" && projectId !== "" && <>
        <p className="composer-target-head">任务{selectedProject === null ? "" : ` · ${selectedProject.title}`}</p>
        {tasksError !== null ? <p className="composer-target-line composer-target-line--error" role="alert">
          任务清单读取失败：{tasksError}</p>
          : tasks === null ? <p className="composer-target-line">正在读取任务…</p>
          : tasks.length === 0 ? <p className="composer-target-line">这个项目还没有任务。</p>
          : taskRows}
      </>}
      {/* 2026-10-24 用户指令：菜单底部脚注与头句重复（头句已说明先指定目标），删除。 */}
    </div>
  </details>;
}
