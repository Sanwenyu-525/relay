import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Info } from "lucide-react";
import PageHeader from "../components/PageHeader";
import { createCommandId, RelayApiError, type RelayProjectListItem, type RelayScheduledTaskCreate,
  type RelayScheduledTaskDetail, type RelayScheduledTaskEdit, type RelayScheduledTaskRepeat } from "../api/relayClient";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { describeLiveError, needsReceiptCheck } from "../lib/liveErrors";
import { liveClient, useRelayConnection } from "../lib/relayConnection";
import "./ScheduledTasksView.css";

type FieldErrors = Partial<Record<"project" | "title" | "taskTitle" | "objective" | "criteria" | "repeat"
  | "firstDate" | "localTime" | "timezone" | "maxRuns" | "expiresAt" | "reason", string>>;

/** 响应未知时冻结的提交意图：命令 ID、载荷与发起时的 API/Workspace 必须一起保留。创建与编辑共用。 */
interface PendingCreate {
  readonly intent: RelayScheduledTaskCreate | RelayScheduledTaskEdit;
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

/** datetime-local 输入按设备时区解释：回填时把绝对时刻换算成设备本地钟面。 */
function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 首次触发日期是「任务时区的墙钟日期」：从 firstRunAt 在任务时区里取 YYYY-MM-DD。 */
function dateInZone(iso: string, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(iso));
  return /^\d{4}-\d{2}-\d{2}$/u.test(formatted) ? formatted : defaultFirstDate();
}

/** 编辑模式：从服务端详情生成表单基线快照，形状与 snapshot() 完全一致。 */
function baselineFromDetail(detail: RelayScheduledTaskDetail): string {
  const repeat = detail.repeat;
  return JSON.stringify({
    projectId: detail.projectId, title: detail.title, taskTitle: detail.template.taskTitle,
    objective: detail.template.objective, criteria: detail.template.criteria.join("\n"),
    kind: repeat.kind, intervalDays: repeat.kind === "DAILY" ? repeat.intervalDays : 1,
    weekdays: repeat.kind === "WEEKLY" ? [...repeat.weekdays] : [1],
    firstDate: dateInZone(detail.firstRunAt, detail.timezone), localTime: detail.localTime,
    timezone: detail.timezone, maxRuns: detail.maxRuns,
    expiresAt: toLocalInputValue(detail.authorizationExpiresAt), reason: "",
  });
}

export default function CreateScheduledTaskView() {
  const connection = useRelayConnection();
  const navigate = useNavigate();
  const { id: editId = "" } = useParams();
  const editing = editId !== "";
  const [detail, setDetail] = useState<RelayScheduledTaskDetail | null>(null);
  const [expectedRevision, setExpectedRevision] = useState("");
  const [loadingDetail, setLoadingDetail] = useState(editing);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
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
  const [reason, setReason] = useState("");
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
  const locked = submitting || pending !== null || loadingDetail;

  /**
   * 未保存判定覆盖表单全部字段（编辑模式含修改原因）；默认项目的异步落位只修补基线里的
   * projectId，不会把用户已输入的其它字段一起当成「已保存」。编辑回填后以详情为基线。
   */
  const snapshot = () => JSON.stringify({
    projectId, title, taskTitle, objective, criteria, kind, intervalDays,
    weekdays: [...weekdays], firstDate, localTime, timezone, maxRuns, expiresAt, reason
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

  /** 编辑模式：读取详情并回填。基线在回填后同步落位，读取本身不算「未保存修改」。 */
  const loadDetail = useCallback(async () => {
    const client = liveClient();
    if (!client) { setLoadError("未连接本机 API：无法读取要编辑的定时任务。"); setLoadingDetail(false); return; }
    setLoadingDetail(true); setLoadError(null);
    try {
      const loaded = await client.getScheduledTask(editId);
      if (disposed.current) return;
      setDetail(loaded); setExpectedRevision(loaded.revision);
      setProjectId(loaded.projectId); setTitle(loaded.title);
      setTaskTitle(loaded.template.taskTitle); setTaskTitleTouched(true);
      setObjective(loaded.template.objective);
      setCriteria(loaded.template.criteria.join("\n"));
      const repeat = loaded.repeat as RelayScheduledTaskRepeat;
      setKind(repeat.kind);
      if (repeat.kind === "DAILY") setIntervalDays(repeat.intervalDays);
      else setWeekdays(repeat.weekdays);
      setFirstDate(dateInZone(loaded.firstRunAt, loaded.timezone));
      setLocalTime(loaded.localTime); setTimezone(loaded.timezone);
      setMaxRuns(loaded.maxRuns);
      setExpiresAt(toLocalInputValue(loaded.authorizationExpiresAt));
      setReason("");
      savedDraft.current = baselineFromDetail(loaded);
    } catch (caught) {
      if (disposed.current) return;
      setDetail(null);
      setLoadError(describeLiveError(caught).message);
    } finally {
      if (!disposed.current) setLoadingDetail(false);
    }
  }, [editId]);

  useEffect(() => {
    disposed.current = false;
    if (editing) void loadDetail();
    return () => { disposed.current = true; };
  }, [editing, loadDetail, reloadToken, connection.epoch]);

  useEffect(() => {
    disposed.current = false;
    // 编辑模式项目不可改：不拉项目列表，避免默认项目回填污染编辑基线。
    if (editing) return () => { disposed.current = true; };
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
  }, [editing, connection.epoch]);

  function validate(): boolean {
    const errors: FieldErrors = {};
    if (!editing && !projectId.trim()) errors.project = "定时任务必须归属一个进行中的项目。";
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
    if (editing && !reason.trim()) errors.reason = "需要说明这次修改的原因；会进入修改历史。";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  function buildIntent(commandId: string): RelayScheduledTaskCreate {
    const repeat: RelayScheduledTaskRepeat = kind === "DAILY"
      ? { kind: "DAILY", intervalDays }
      : { kind: "WEEKLY", weekdays: [...weekdays].sort((a, b) => a - b) };
    return {
      // 编辑模式项目不可改：沿用详情里的项目满足载荷形状，服务端编辑不读它。
      commandId, projectId: editing ? (detail?.projectId ?? projectId) : projectId.trim(), title: title.trim(),
      template: {
        taskTitle: taskTitle.trim(), objective: objective.trim(),
        criteria: criteria.split("\n").map((line) => line.trim()).filter(Boolean),
        mode: detail?.template.mode ?? "AI_ASSIST",
      },
      repeat, timezone: timezone.trim(), localTime, firstLocalDate: firstDate,
      maxRuns, authorizationExpiresAt: new Date(expiresAt).toISOString(), confirmed: true,
    };
  }

  /**
   * 发送一份冻结的意图。响应丢失时保留原命令 ID 与载荷，表单锁死，先核对回执；
   * 明确业务拒绝（4xx）才解除锁定，允许用户修正输入后重新提交。
   */
  async function sendIntent(client: NonNullable<ReturnType<typeof liveClient>>, intent: RelayScheduledTaskCreate | RelayScheduledTaskEdit) {
    const outcome = "scheduledTaskId" in intent
      ? await client.editScheduledTask(intent)
      : await client.createScheduledTask(intent);
    const targetId = "scheduledTaskId" in intent ? intent.scheduledTaskId : outcome.scheduledTaskId;
    createdRef.current = true;
    // 导航守卫按 ref 读待核对命令：必须先同步清掉，再离开页面。
    holdPending(null); setMayRetry(false);
    if (!disposed.current) navigate(`/scheduled-tasks/${targetId}`);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || pendingRef.current !== null || loadingDetail) return;
    setActionError(null);
    if (!validate()) return;
    const client = liveClient();
    if (!client) { setActionError("未连接本机 API：定时任务需要写入真实数据。"); return; }

    setSubmitting(true);
    try {
      const intent = editing && detail !== null
        ? { ...buildIntent(createCommandId()), scheduledTaskId: editId, expectedRevision, reason: reason.trim() } satisfies RelayScheduledTaskEdit
        : buildIntent(createCommandId());
      await sendIntentInner(client, intent);
    }
    finally { if (!disposed.current) setSubmitting(false); }
  }

  /** 与 sendIntent 分开：失败路径需要区分创建/编辑文案并冻结原意图。 */
  async function sendIntentInner(client: NonNullable<ReturnType<typeof liveClient>>, intent: RelayScheduledTaskCreate | RelayScheduledTaskEdit) {
    const scope = clientScope(client);
    const label = "scheduledTaskId" in intent ? "修改" : "创建";
    try {
      await sendIntent(client, intent);
    } catch (caught) {
      if (disposed.current) return;
      const described = describeLiveError(caught);
      if (needsReceiptCheck(caught) || !(caught instanceof RelayApiError)) {
        holdPending({ intent, scope }); setMayRetry(false);
        setActionError(`${label}结果未确认：${described.message}`);
        return;
      }
      // 服务端明确拒绝：原意图没有落库，保留输入供修正，不把新意图塞进旧 ID。
      // 版本冲突（REVISION_CONFLICT）同样回到表单：重新读取详情拿新基线后再提交。
      holdPending(null); setMayRetry(false);
      setActionError(`${label}失败：${described.message}`);
    }
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
    const isEdit = "scheduledTaskId" in intent;
    setSubmitting(true); setActionError(null);
    try {
      const receipt = await client.getCommandReceipt(intent.commandId);
      const expectedType = isEdit ? "EditScheduledTask" : "CreateScheduledTask";
      if (receipt.commandId !== intent.commandId || receipt.commandType !== expectedType) {
        throw new Error("原命令回执的 ID 或类型不匹配，仍需核对。");
      }
      const taskId = receipt.result.scheduled_task_id;
      if (typeof taskId !== "string" || taskId === "") {
        throw new Error("原命令回执缺少定时任务身份，仍需核对。");
      }
      if (isEdit && taskId !== intent.scheduledTaskId) {
        throw new Error("原命令回执的定时任务不匹配，仍需核对。");
      }
      if (!isEdit && receipt.result.project_id !== intent.projectId) {
        throw new Error("原命令回执的项目不匹配，仍需核对。");
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
    try { await sendIntentInner(client, held.intent); }
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

  if (editing && loadingDetail && detail === null) return <div className="page-layout scheduled-tasks-page pv-page"><div className="page-primary">
    <PageHeader testId="scheduled-task-create-head" title="编辑定时任务" overline="Edit Schedule" meta="正在读取" lede="正在读取这条定时任务的当前设置…" />
    <p role="status">正在读取定时任务…</p>
  </div></div>;
  if (editing && detail === null) return <div className="page-layout scheduled-tasks-page pv-page"><div className="page-primary">
    <PageHeader testId="scheduled-task-create-head" title="编辑定时任务" overline="Edit Schedule" meta="读取失败" lede="这条定时任务当前无法读取，先核对后再修改。" />
    <p className="action-error" role="alert">{loadError}</p>
    <div className="form-actions">
      <button className="secondary-button" type="button" onClick={() => setReloadToken((token) => token + 1)}>重新读取</button>
      <Link className="secondary-button" to={`/scheduled-tasks/${editId}`}>返回详情</Link>
    </div>
  </div></div>;

  const statusLabel = detail === null ? "" : detail.status === "ENABLED" ? "启用中"
    : detail.status === "PAUSED" ? "已暂停" : detail.status === "DISABLED" ? "已停用" : "已到期";
  return <div className="page-layout scheduled-tasks-page pv-page"><div className="page-primary">
    <PageHeader testId="scheduled-task-create-head"
      title={editing ? "编辑定时任务" : "新建定时任务"}
      meta={editing ? `编辑 · ${statusLabel}` : "到点自动创建并启动任务"}
      lede={editing
        ? "修改会写入修改历史；只影响之后的新触发，已发生的触发保持原样。"
        : "每次触发会新建一个任务并交给 AI 执行；重复执行的是这套设定，不是同一个任务。"} />
    {editing && detail?.status === "EXPIRED" && <p className="warning-callout" role="alert">
      <Info aria-hidden="true" />
      这条定时任务已到期（授权到期或次数用尽）。编辑保存后仍保持「已到期」，需要延长授权或提高次数上限，
      再回详情页显式重新启用，不会因为保存而自动恢复。
    </p>}
    <form className="create-form" noValidate aria-busy={locked || undefined} onSubmit={(event) => void submit(event)}>
      {editing
        ? <label className="field"><span className="field-label">所属项目（不可修改）</span>
            <input value={detail?.project?.title ?? detail?.projectId ?? ""} disabled data-testid="scheduled-task-edit-project-readonly" readOnly />
            <span className="field-hint">定时任务不能迁移项目；需要换项目时停用后新建。</span></label>
        : field("project", "所属项目", <select value={projectId} disabled={locked}
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

      {editing && field("reason", "修改原因（必填）", <textarea value={reason} rows={2} maxLength={4000} disabled={locked} required
        onChange={(event) => setReason(event.target.value)} data-testid="scheduled-task-edit-reason" />,
        "会随修改一起写入修改历史，便于回看每次为什么改。")}

      <p className="helper-text"><Info aria-hidden="true" />
        授权在创建时一次性确认：到点只按这份授权准入，不会扩大权限。执行范围（可读资料、可用工具）在每次触发时按当时状态冻结，
        依据失效则这一次不执行，并进入待处理。</p>
      <div className="form-actions">
        <button className="primary-button" type="submit" disabled={locked} data-testid="scheduled-task-submit">
          {pending ? "结果待核对" : submitting ? (editing ? "正在保存" : "正在创建") : editing ? "保存修改" : "创建定时任务"}</button>
        <button className="secondary-button" type="button" disabled={locked}
          onClick={() => navigate(editing ? `/scheduled-tasks/${editId}` : "/scheduled-tasks")}>
          {editing ? "返回详情（不保存）" : "返回列表"}</button>
      </div>
      {pending && <div className="warning-callout" role="alert" data-testid="scheduled-task-pending">
        <Info aria-hidden="true" />
        <div>
          <p>{editing ? "修改" : "创建"}结果未确认，表单已锁定。原 command_id：<code>{pending.intent.commandId}</code>。
            先查询回执；在确认未生效之前不要重复提交。</p>
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
