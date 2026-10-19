import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Info } from "lucide-react";
import PageHeader from "../components/PageHeader";
import { createCommandId, type RelayProjectListItem, type RelayScheduledTaskRepeat } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { liveClient, useRelayConnection } from "../lib/relayConnection";
import "./ScheduledTasksView.css";

type FieldErrors = Partial<Record<"project" | "title" | "taskTitle" | "objective" | "criteria" | "repeat" | "firstDate" | "localTime" | "timezone" | "maxRuns" | "expiresAt", string>>;

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function defaultTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai"; } catch { return "Asia/Shanghai"; }
}

function defaultFirstDate(): string {
  const now = new Date(Date.now() + 86_400_000);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function defaultExpiry(): string {
  const now = new Date(Date.now() + 7 * 86_400_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export default function CreateScheduledTaskView() {
  const connection = useRelayConnection();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<readonly RelayProjectListItem[]>([]);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState("");
  const [kind, setKind] = useState<"DAILY" | "WEEKLY">("DAILY");
  const [intervalDays, setIntervalDays] = useState(1);
  const [weekdays, setWeekdays] = useState<readonly number[]>([1]);
  const [firstDate, setFirstDate] = useState(defaultFirstDate);
  const [localTime, setLocalTime] = useState("09:00");
  const [timezone, setTimezone] = useState(defaultTimeZone);
  const [maxRuns, setMaxRuns] = useState(10);
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const disposed = useRef(false);

  useEffect(() => {
    disposed.current = false;
    const client = liveClient();
    if (!client) return () => { disposed.current = true; };
    void client.getProjectsPage("active", null).then((page) => {
      if (disposed.current) return;
      setProjects(page.items);
      setProjectId((current) => current || page.items[0]?.id || "");
    }).catch(() => { /* 项目列表不可用时仍可手动输入 */ });
    return () => { disposed.current = true; };
  }, [connection.epoch]);

  function validate(): boolean {
    const errors: FieldErrors = {};
    if (!projectId.trim()) errors.project = "定时任务必须归属一个进行中的项目。";
    if (!title.trim()) errors.title = "给这条定时任务一个名字，便于在列表里识别。";
    if (!taskTitle.trim()) errors.taskTitle = "每次新建的任务需要一个标题。";
    if (!objective.trim()) errors.objective = "需要说明每次任务要达成什么结果。";
    if (criteria.split("\n").map((line) => line.trim()).filter(Boolean).length === 0) {
      errors.criteria = "至少写一条可判断的验收标准；没有完成条件时任务无法就绪。";
    }
    if (kind === "WEEKLY" && weekdays.length === 0) errors.repeat = "按周重复至少选一天。";
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(firstDate)) errors.firstDate = "需要 YYYY-MM-DD 形式的首次日期。";
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/u.test(localTime)) errors.localTime = "需要 HH:MM 形式的本地时刻。";
    if (!timezone.trim()) errors.timezone = "需要时区名称，例如 Asia/Shanghai。";
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 100) errors.maxRuns = "执行次数上限需要在 1–100 之间。";
    if (!expiresAt.trim() || Number.isNaN(Date.parse(expiresAt))) errors.expiresAt = "需要授权到期时刻。";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setActionError(null);
    if (!validate()) return;
    const client = liveClient();
    if (!client) { setActionError("未连接本机 API：定时任务需要写入真实数据。"); return; }

    const repeat: RelayScheduledTaskRepeat = kind === "DAILY"
      ? { kind: "DAILY", intervalDays }
      : { kind: "WEEKLY", weekdays: [...weekdays].sort((a, b) => a - b) };
    setSubmitting(true);
    try {
      const created = await client.createScheduledTask({
        commandId: createCommandId(), projectId: projectId.trim(), title: title.trim(),
        template: {
          taskTitle: taskTitle.trim(), objective: objective.trim(),
          criteria: criteria.split("\n").map((line) => line.trim()).filter(Boolean),
          mode: "AI_ASSIST",
        },
        repeat, timezone: timezone.trim(), localTime, firstLocalDate: firstDate,
        maxRuns, authorizationExpiresAt: new Date(expiresAt).toISOString(), confirmed: true,
      });
      if (disposed.current) return;
      navigate(`/scheduled-tasks/${created.scheduledTaskId}`);
    } catch (caught) {
      if (!disposed.current) setActionError(`创建失败：${describeLiveError(caught).message}`);
    } finally {
      if (!disposed.current) setSubmitting(false);
    }
  }

  const field = (key: keyof FieldErrors, label: string, node: ReactNode, hint?: string) => (
    <label className={`field${fieldErrors[key] ? " field--invalid" : ""}`}>
      <span className="field-label">{label}</span>
      {node}
      {fieldErrors[key]
        ? <span className="field-error" role="alert"><Info aria-hidden="true" />{fieldErrors[key]}</span>
        : hint === undefined ? null : <span className="field-hint">{hint}</span>}
    </label>
  );

  return <div className="page-layout scheduled-tasks-page"><div className="page-primary">
    <PageHeader testId="scheduled-task-create-head" title="新建定时任务" meta="到点自动创建并启动任务"
      lede="每次触发会新建一个任务并交给 AI 执行；重复执行的是这套设定，不是同一个任务。" />
    <form className="create-form" noValidate aria-busy={submitting || undefined} onSubmit={(event) => void submit(event)}>
      {field("project", "所属项目", <select value={projectId} disabled={submitting}
        onChange={(event) => setProjectId(event.target.value)} data-testid="scheduled-task-project">
        <option value="">请选择进行中的项目</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
      </select>, "定时任务只在一个项目内运行；项目归档后不再触发。")}

      {field("title", "定时任务名称", <input value={title} maxLength={200} disabled={submitting} required
        onChange={(event) => setTitle(event.target.value)} data-testid="scheduled-task-title" />,
        "列表里显示的名字，例如「每早整理昨日进展」。")}

      {field("taskTitle", "每次任务的标题", <input value={taskTitle} maxLength={200} disabled={submitting} required
        onChange={(event) => setTaskTitle(event.target.value)} data-testid="scheduled-task-task-title" />,
        "每次触发新建的任务会用它作标题；可以用「{日期}」这类说明写清规律。")}

      {field("objective", "每次任务要达成什么", <textarea value={objective} rows={3} maxLength={2000} disabled={submitting} required
        onChange={(event) => setObjective(event.target.value)} data-testid="scheduled-task-objective" />)}

      {field("criteria", "验收标准（每行一条）", <textarea value={criteria} rows={3} maxLength={2000} disabled={submitting} required
        onChange={(event) => setCriteria(event.target.value)} data-testid="scheduled-task-criteria" />,
        "没有可判断的验收标准时任务无法就绪，也就不会启动。")}

      <fieldset className="field">
        <legend className="field-label">重复规则</legend>
        <div className="choice-list">
          <label className="choice-option"><input type="radio" name="repeat-kind" checked={kind === "DAILY"} disabled={submitting}
            onChange={() => setKind("DAILY")} /><span>按天</span></label>
          <label className="choice-option"><input type="radio" name="repeat-kind" checked={kind === "WEEKLY"} disabled={submitting}
            onChange={() => setKind("WEEKLY")} /><span>按周</span></label>
        </div>
        {kind === "DAILY"
          ? <label className="field"><span className="field-label">每隔几天</span>
            <input type="number" min={1} max={30} value={intervalDays} disabled={submitting} data-testid="scheduled-task-interval"
              onChange={(event) => setIntervalDays(Number(event.target.value))} />
            <span className="field-hint">1–30 天。按天规则从首次触发日期起对齐，不会因关闭应用而漂移。</span></label>
          : <div className="field"><span className="field-label">每周哪几天</span>
            <div className="choice-list">{WEEKDAYS.map((label, index) => <label className="choice-option" key={label}>
              <input type="checkbox" checked={weekdays.includes(index + 1)} disabled={submitting} data-testid={`scheduled-task-weekday-${index + 1}`}
                onChange={(event) => setWeekdays((current) => event.target.checked
                  ? [...current, index + 1] : current.filter((day) => day !== index + 1))} /><span>{label}</span>
            </label>)}</div>
            {fieldErrors.repeat && <span className="field-error" role="alert"><Info aria-hidden="true" />{fieldErrors.repeat}</span>}
          </div>}
      </fieldset>

      <div className="scheduled-task-schedule-row">
        {field("firstDate", "首次触发日期", <input type="date" value={firstDate} disabled={submitting} required
          onChange={(event) => setFirstDate(event.target.value)} data-testid="scheduled-task-first-date" />)}
        {field("localTime", "本地时刻", <input type="time" value={localTime} disabled={submitting} required
          onChange={(event) => setLocalTime(event.target.value)} data-testid="scheduled-task-local-time" />,
          "按下面的时区解释；跨夏令时仍是这个钟点。")}
        {field("timezone", "时区", <input value={timezone} disabled={submitting} required list="scheduled-task-timezones"
          onChange={(event) => setTimezone(event.target.value)} data-testid="scheduled-task-timezone" />,
          "例如 Asia/Shanghai。设备时区变化不会改动已确认的时刻。")}
        <datalist id="scheduled-task-timezones">
          {["Asia/Shanghai", "Asia/Tokyo", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "UTC"]
            .map((zone) => <option key={zone} value={zone} />)}
        </datalist>
      </div>

      <div className="scheduled-task-schedule-row">
        {field("maxRuns", "最多启动次数", <input type="number" min={1} max={100} value={maxRuns} disabled={submitting} required
          onChange={(event) => setMaxRuns(Number(event.target.value))} data-testid="scheduled-task-max-runs" />,
          "1–100 次。只统计真正启动的执行；上一轮未验收而被跳过的时段不占额度。")}
        {field("expiresAt", "授权到期", <input type="datetime-local" value={expiresAt} disabled={submitting} required
          onChange={(event) => setExpiresAt(event.target.value)} data-testid="scheduled-task-expires-at" />,
          "最长 90 天。到期后不再产生新的触发，已启动的执行不受影响。")}
      </div>

      <p className="helper-text"><Info aria-hidden="true" />
        授权在创建时一次性确认：到点只按这份授权准入，不会扩大权限。执行范围（可读资料、可用工具）在每次触发时按当时状态冻结，
        依据失效则这一次不执行，并进入待处理。</p>
      <div className="form-actions">
        <button className="primary-button" type="submit" disabled={submitting} data-testid="scheduled-task-submit">
          {submitting ? "正在创建" : "创建定时任务"}</button>
        <button className="secondary-button" type="button" disabled={submitting}
          onClick={() => navigate("/scheduled-tasks")}>返回列表</button>
      </div>
      {actionError && <p className="action-error" role="alert">{actionError}</p>}
    </form>
  </div></div>;
}
