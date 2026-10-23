import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Info } from "lucide-react";
import PageHeader from "../components/PageHeader";
import { createCommandId, RelayApiError, type RelayProjectListItem,
  type RelayScheduledTaskCreate, type RelayScheduledTaskRepeat } from "../api/relayClient";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { describeLiveError, needsReceiptCheck } from "../lib/liveErrors";
import { liveClient, useRelayConnection } from "../lib/relayConnection";
import "./ScheduledTasksView.css";

type FieldErrors = Partial<Record<"project" | "title" | "taskTitle" | "objective" | "criteria" | "repeat" | "firstDate" | "localTime" | "timezone" | "maxRuns" | "expiresAt", string>>;

/** 响应未知时冻结的创建意图：命令 ID、载荷与发起时的 API/Workspace 必须一起保留。 */
interface PendingCreate {
  readonly intent: RelayScheduledTaskCreate;
  readonly scope: string;
}

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function clientScope(client: NonNullable<ReturnType<typeof liveClient>>): string {
  return `${client.baseUrl}\n${client.workspaceId}`;
}

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
  /** 每次任务的标题默认跟着定时任务名走；只有用户自己改过才独立。 */
  const [taskTitleTouched, setTaskTitleTouched] = useState(false);
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
  /** 响应未知后冻结的原请求：命令 ID、载荷与连接范围都不能被后续编辑替换。 */
  const [pending, setPending] = useState<PendingCreate | null>(null);
  const pendingRef = useRef<PendingCreate | null>(null);
  const holdPending = (next: PendingCreate | null) => { pendingRef.current = next; setPending(next); };
  const [mayRetry, setMayRetry] = useState(false);
  const createdRef = useRef(false);
  const titleInput = useRef<HTMLInputElement | null>(null);
  const disposed = useRef(false);
  const projectTouched = useRef(false);
  const locked = submitting || pending !== null;

  /**
   * 未保存判定覆盖表单全部字段；默认项目的异步落位只修补基线里的 projectId，
   * 不会把用户已输入的其它字段一起当成「已保存」。
   */
  const snapshot = () => JSON.stringify({
    projectId, title, taskTitle, objective, criteria, kind, intervalDays,
    weekdays: [...weekdays], firstDate, localTime, timezone, maxRuns, expiresAt
  });
  const savedDraft = useRef(snapshot());
  const draftRef = useRef(savedDraft.current);
  draftRef.current = snapshot();
  const guard = useRef<DraftGuard>({
    hasUnsavedChanges: () => !createdRef.current && draftRef.current !== savedDraft.current,
    discard: () => { savedDraft.current = draftRef.current; },
    pendingCommandId: () => pendingRef.current?.intent.commandId ?? null,
    restoreFocus: () => titleInput.current?.focus()
  });
  useEffect(() => {
    setDraftGuard(guard.current);
    return () => clearDraftGuard(guard.current);
  }, []);

  useEffect(() => {
    disposed.current = false;
    const client = liveClient();
    if (!client) return () => { disposed.current = true; };
    void client.getProjectsPage("active", null).then((page) => {
      if (disposed.current) return;
      setProjects(page.items);
      const fallback = page.items[0]?.id ?? "";
      setProjectId((current) => current || fallback);
      if (!projectTouched.current && fallback !== "") {
        const baseline = JSON.parse(savedDraft.current) as Record<string, unknown>;
        baseline.projectId = fallback;
        savedDraft.current = JSON.stringify(baseline);
      }
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

  function buildIntent(commandId: string): RelayScheduledTaskCreate {
    const repeat: RelayScheduledTaskRepeat = kind === "DAILY"
      ? { kind: "DAILY", intervalDays }
      : { kind: "WEEKLY", weekdays: [...weekdays].sort((a, b) => a - b) };
    return {
      commandId, projectId: projectId.trim(), title: title.trim(),
      template: {
        taskTitle: taskTitle.trim(), objective: objective.trim(),
        criteria: criteria.split("\n").map((line) => line.trim()).filter(Boolean),
        mode: "AI_ASSIST",
      },
      repeat, timezone: timezone.trim(), localTime, firstLocalDate: firstDate,
      maxRuns, authorizationExpiresAt: new Date(expiresAt).toISOString(), confirmed: true,
    };
  }

  /**
   * 发送一份冻结的意图。响应丢失时保留原命令 ID 与载荷，表单锁死，先核对回执；
   * 明确业务拒绝（4xx）才解除锁定，允许用户修正输入后重新提交。
   */
  async function sendIntent(client: NonNullable<ReturnType<typeof liveClient>>, intent: RelayScheduledTaskCreate) {
    const scope = clientScope(client);
    try {
      const created = await client.createScheduledTask(intent);
      createdRef.current = true;
      // 导航守卫按 ref 读待核对命令：必须先同步清掉，再离开页面。
      holdPending(null); setMayRetry(false);
      if (!disposed.current) navigate(`/scheduled-tasks/${created.scheduledTaskId}`);
    } catch (caught) {
      if (disposed.current) return;
      const described = describeLiveError(caught);
      if (needsReceiptCheck(caught) || !(caught instanceof RelayApiError)) {
        holdPending({ intent, scope }); setMayRetry(false);
        setActionError(`创建结果未确认：${described.message}`);
        return;
      }
      // 服务端明确拒绝：原意图没有落库，保留输入供修正，不把新意图塞进旧 ID。
      holdPending(null); setMayRetry(false);
      setActionError(`创建失败：${described.message}`);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || pendingRef.current !== null) return;
    setActionError(null);
    if (!validate()) return;
    const client = liveClient();
    if (!client) { setActionError("未连接本机 API：定时任务需要写入真实数据。"); return; }

    setSubmitting(true);
    try { await sendIntent(client, buildIntent(createCommandId())); }
    finally { if (!disposed.current) setSubmitting(false); }
  }

  async function checkReceipt() {
    const held = pendingRef.current;
    const client = liveClient();
    if (client === null || held === null || submitting) return;
    if (held.scope !== clientScope(client)) {
      setActionError("原命令属于之前的 API 或 Workspace：当前连接不同，请切回原连接后再查询回执，不要在新连接下新建。");
      return;
    }
    const intent = held.intent;
    setSubmitting(true); setActionError(null);
    try {
      const receipt = await client.getCommandReceipt(intent.commandId);
      if (receipt.commandId !== intent.commandId || receipt.commandType !== "CreateScheduledTask") {
        throw new Error("原命令回执的 ID 或类型不匹配，仍需核对。");
      }
      const taskId = receipt.result.scheduled_task_id;
      if (typeof taskId !== "string" || taskId === "" || receipt.result.project_id !== intent.projectId) {
        throw new Error("原命令回执的定时任务或项目不匹配，仍需核对。");
      }
      createdRef.current = true; holdPending(null); setMayRetry(false);
      if (!disposed.current) navigate(`/scheduled-tasks/${taskId}`);
    } catch (caught) {
      if (disposed.current) return;
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetry(true);
        setActionError("原命令暂未查到回执；未确认前不要新建，可确认原内容后按同一 ID 重试。");
      } else setActionError(`原命令仍未核对：${describeLiveError(caught).message}`);
    } finally { if (!disposed.current) setSubmitting(false); }
  }

  async function retryOriginal() {
    const held = pendingRef.current;
    const client = liveClient();
    if (client === null || held === null || submitting) return;
    if (held.scope !== clientScope(client)) {
      setActionError("原命令属于之前的 API 或 Workspace：当前连接不同，不能在这里重试；请切回原连接。");
      return;
    }
    setSubmitting(true); setActionError(null);
    try { await sendIntent(client, held.intent); }
    finally { if (!disposed.current) setSubmitting(false); }
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
    <form className="create-form" noValidate aria-busy={locked || undefined} onSubmit={(event) => void submit(event)}>
      {field("project", "所属项目", <select value={projectId} disabled={locked}
        onChange={(event) => { projectTouched.current = true; setProjectId(event.target.value); }} data-testid="scheduled-task-project">
        <option value="">请选择进行中的项目</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
      </select>, "定时任务只在一个项目内运行；项目归档后不再触发。")}

      {field("title", "名称", <input ref={titleInput} value={title} maxLength={200} disabled={locked} required
        onChange={(event) => { const next = event.target.value; setTitle(next); if (!taskTitleTouched) setTaskTitle(next); }} data-testid="scheduled-task-title" />,
        "例如「每早整理昨日进展」。每次触发新建的任务默认也用这个名字。")}

      {field("taskTitle", "每次任务的标题", <input value={taskTitle} maxLength={200} disabled={locked} required
        onChange={(event) => { setTaskTitleTouched(true); setTaskTitle(event.target.value); }} data-testid="scheduled-task-task-title" />,
        "默认与上面的名称相同；需要区分时可单独改写。")}

      {field("objective", "每次任务要达成什么", <textarea value={objective} rows={3} maxLength={2000} disabled={locked} required
        onChange={(event) => setObjective(event.target.value)} data-testid="scheduled-task-objective" />)}

      {field("criteria", "验收标准（每行一条）", <textarea value={criteria} rows={3} maxLength={2000} disabled={locked} required
        onChange={(event) => setCriteria(event.target.value)} data-testid="scheduled-task-criteria" />,
        "没有可判断的验收标准时任务无法就绪，也就不会启动。")}

      <fieldset className="field">
        <legend className="field-label">重复规则</legend>
        <div className="choice-list">
          <label className="choice-option"><input type="radio" name="repeat-kind" checked={kind === "DAILY"} disabled={locked}
            onChange={() => setKind("DAILY")} /><span>按天</span></label>
          <label className="choice-option"><input type="radio" name="repeat-kind" checked={kind === "WEEKLY"} disabled={locked}
            onChange={() => setKind("WEEKLY")} /><span>按周</span></label>
        </div>
        {kind === "DAILY"
          ? <label className="field"><span className="field-label">每隔几天</span>
            <input type="number" min={1} max={30} value={intervalDays} disabled={locked} data-testid="scheduled-task-interval"
              onChange={(event) => setIntervalDays(Number(event.target.value))} />
            <span className="field-hint">1–30 天。按天规则从首次触发日期起对齐，不会因关闭应用而漂移。</span></label>
          : <div className="field"><span className="field-label">每周哪几天</span>
            <div className="choice-list">{WEEKDAYS.map((label, index) => <label className="choice-option" key={label}>
              <input type="checkbox" checked={weekdays.includes(index + 1)} disabled={locked} data-testid={`scheduled-task-weekday-${index + 1}`}
                onChange={(event) => setWeekdays((current) => event.target.checked
                  ? [...current, index + 1] : current.filter((day) => day !== index + 1))} /><span>{label}</span>
            </label>)}</div>
            {fieldErrors.repeat && <span className="field-error" role="alert"><Info aria-hidden="true" />{fieldErrors.repeat}</span>}
          </div>}
      </fieldset>

      <div className="scheduled-task-schedule-row">
        {field("firstDate", "首次触发日期", <input type="date" value={firstDate} disabled={locked} required
          onChange={(event) => setFirstDate(event.target.value)} data-testid="scheduled-task-first-date" />)}
        {field("localTime", "本地时刻", <input type="time" value={localTime} disabled={locked} required
          onChange={(event) => setLocalTime(event.target.value)} data-testid="scheduled-task-local-time" />,
          "按下面的时区解释；跨夏令时仍是这个钟点。")}
      </div>

      {/* 时区、次数与到期都有真实默认值：摆成摘要，改动才展开，但不会因此隐藏授权承诺。 */}
      <details className="scheduled-task-advanced" data-testid="scheduled-task-advanced">
        <summary>时区、启动次数与授权到期 · {timezone.trim() || "未填时区"} · 最多 {maxRuns} 次 · 到期 {expiresAt.replace("T", " ") || "未填"}</summary>
        {(fieldErrors.timezone || fieldErrors.maxRuns || fieldErrors.expiresAt) &&
          <p className="field-error" role="alert"><Info aria-hidden="true" />上面这些默认值有需要修正的项，展开后可看到具体原因。</p>}
        <div className="scheduled-task-schedule-row">
          {field("timezone", "时区", <input value={timezone} disabled={locked} required list="scheduled-task-timezones"
            onChange={(event) => setTimezone(event.target.value)} data-testid="scheduled-task-timezone" />,
            "例如 Asia/Shanghai。设备时区变化不会改动已确认的时刻。")}
          <datalist id="scheduled-task-timezones">
            {["Asia/Shanghai", "Asia/Tokyo", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "UTC"]
              .map((zone) => <option key={zone} value={zone} />)}
          </datalist>
          {field("maxRuns", "最多启动次数", <input type="number" min={1} max={100} value={maxRuns} disabled={locked} required
            onChange={(event) => setMaxRuns(Number(event.target.value))} data-testid="scheduled-task-max-runs" />,
            "1–100 次。只统计真正启动的执行；上一轮未验收而被跳过的时段不占额度。")}
          {field("expiresAt", "授权到期", <input type="datetime-local" value={expiresAt} disabled={locked} required
            onChange={(event) => setExpiresAt(event.target.value)} data-testid="scheduled-task-expires-at" />,
            "最长 90 天。到期后不再产生新的触发，已启动的执行不受影响。")}
        </div>
      </details>

      <p className="helper-text"><Info aria-hidden="true" />
        授权在创建时一次性确认：到点只按这份授权准入，不会扩大权限。执行范围（可读资料、可用工具）在每次触发时按当时状态冻结，
        依据失效则这一次不执行，并进入待处理。</p>
      <div className="form-actions">
        <button className="primary-button" type="submit" disabled={locked} data-testid="scheduled-task-submit">
          {pending ? "结果待核对" : submitting ? "正在创建" : "创建定时任务"}</button>
        <button className="secondary-button" type="button" disabled={locked}
          onClick={() => navigate("/scheduled-tasks")}>返回列表</button>
      </div>
      {pending && <div className="warning-callout" role="alert" data-testid="scheduled-task-pending">
        <Info aria-hidden="true" />
        <div>
          <p>创建结果未确认，表单已锁定。原 command_id：<code>{pending.intent.commandId}</code>。
            先查询回执；在确认未创建之前不要新建。</p>
          <div className="form-actions">
            <button className="secondary-button" type="button" disabled={submitting}
              onClick={() => void checkReceipt()} data-testid="scheduled-task-check-receipt">查询原命令回执</button>
            {mayRetry && <button className="secondary-button" type="button" disabled={submitting}
              onClick={() => void retryOriginal()} data-testid="scheduled-task-retry-original">按原 ID 和原内容重试</button>}
          </div>
        </div>
      </div>}
      {actionError && <p className="action-error" role="alert">{actionError}</p>}
    </form>
  </div></div>;
}
