import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Check, Info } from "lucide-react";
import ResponsiveRail from "../components/ResponsiveRail";
import { createCommandId, RelayApiError, taskCreationFrom, taskMutationFrom, type RelayTaskCreation } from "../api/relayClient";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { interactionModeLabels, taskStatusLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { liveClient, useRelayConnection } from "../lib/relayConnection";
import type { CreateTaskDraft, FixtureError, InteractionMode, ProjectSummary, TaskStatus, TaskSummary } from "../types";

type LiveStep = "create" | "dependency" | "ready";
type Intent = "ready" | "inbox";
type FieldErrors = Partial<Record<"title" | "expectedResult" | "acceptanceCriteria", string>>;
type ActionError = { kind: string; message: string };
type DependencyOption = { readonly id: string; readonly title: string; readonly status: TaskStatus };
const criteriaLimit = 500;
const startIntents: { value: InteractionMode; hint: string }[] = [
  { value: "ME", hint: "由我负责执行任务" },
  { value: "AI_ASSIST", hint: "在我的主导下使用 AI 辅助" },
  { value: "DELEGATE_AI", hint: "将任务委托给 AI 执行" }
];
const toActionError = (caught: unknown, fallback: string): ActionError => ({ kind: caught instanceof Error && "kind" in caught ? String((caught as FixtureError).kind) : "unknown", message: caught instanceof Error ? caught.message.trim() : fallback });
const stepLabel = (step: LiveStep | null) => step === "create" ? "创建任务" : step === "dependency" ? "登记依赖" : step === "ready" ? "标记可开始" : "本次请求";

export default function CreateTaskView({ inboxScope, onCancel }: { inboxScope: boolean; onCancel: () => void }) {
  const [query] = useSearchParams();
  const mode = fixtureModeFromQuery(query);
  const live = useRelayConnection().mode === "live";
  const routeProjectId = query.get("project") ?? "";
  const emptyDraft: CreateTaskDraft = { title: "", projectId: routeProjectId || null, expectedResult: "", acceptanceCriteria: "", startIntent: "ME", dependencyId: null };
  const [draft, setDraft] = useState<CreateTaskDraft>(emptyDraft);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [candidates, setCandidates] = useState<TaskSummary[]>([]);
  const [liveCandidates, setLiveCandidates] = useState<readonly DependencyOption[]>([]);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [readyBlockedReason, setReadyBlockedReason] = useState<string | null>(null);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const [liveCreate, setLiveCreate] = useState<RelayTaskCreation | null>(null);
  const commandId = useRef<string | null>(null);
  const submittedIntent = useRef<Intent | null>(null);
  const pendingStep = useRef<{ step: LiveStep; commandId: string } | null>(null);
  const savedDraft = useRef(JSON.stringify(emptyDraft));
  const draftRef = useRef(draft);
  const createdRef = useRef(createdTaskId);
  const disposed = useRef(false);
  const candidatesVersion = useRef(0);
  draftRef.current = draft; createdRef.current = createdTaskId;
  const guard = useRef<DraftGuard>({ hasUnsavedChanges: () => createdRef.current === null && JSON.stringify(draftRef.current) !== savedDraft.current,
    discard: () => { draftRef.current = emptyDraft; savedDraft.current = JSON.stringify(emptyDraft); setDraft(emptyDraft); } });
  useEffect(() => { disposed.current = false; setDraftGuard(guard.current); return () => { disposed.current = true; candidatesVersion.current++; clearDraftGuard(guard.current); }; }, []);
  const projectId = draft.projectId ?? "";
  const dependencyOptions: readonly DependencyOption[] = live ? liveCandidates : candidates.filter((task) => task.projectId === (projectId || null)).map((task) => ({ id: task.id, title: task.title, status: task.status }));
  function updateDraft(patch: Partial<CreateTaskDraft>) { commandId.current = null; setDraft((current) => ({ ...current, ...patch })); }
  function clearField(key: keyof FieldErrors) { setFieldErrors((current) => ({ ...current, [key]: undefined })); }

  async function refreshLiveCandidates(id = draftRef.current.projectId ?? "") {
    if (!live) return;
    const token = ++candidatesVersion.current;
    const client = liveClient();
    setLiveCandidates([]);
    if (!client) { setOptionsError("连接已断开：无法读取该项目的依赖候选。"); return; }
    if (!id.trim()) { setOptionsError(null); setOptionsLoading(false); return; }
    setOptionsLoading(true);
    try { const tasks = await client.getProjectTasks(id.trim()); if (token !== candidatesVersion.current || disposed.current) return; setLiveCandidates(tasks.map((task) => ({ id: task.id, title: task.title, status: task.status }))); setOptionsError(null); }
    catch (caught) { if (token !== candidatesVersion.current || disposed.current) return; setLiveCandidates([]); setOptionsError(`无法读取该项目的依赖候选：${describeLiveError(caught).message}。可以不选依赖继续创建。`); }
    finally { if (token === candidatesVersion.current && !disposed.current) setOptionsLoading(false); }
  }
  useEffect(() => {
    let active = true;
    if (live) { setOptionsLoading(false); savedDraft.current = JSON.stringify(draftRef.current); void refreshLiveCandidates(); return () => { active = false; }; }
    setOptionsLoading(true); setOptionsError(null);
    void fixtureAdapter.loadTaskOptions(mode).then((options) => { if (!active) return; setProjects(options.projects); setCandidates(options.candidates); if (routeProjectId && options.projects.some((project) => project.id === routeProjectId)) setDraft((current) => ({ ...current, projectId: routeProjectId })); savedDraft.current = JSON.stringify({ ...draftRef.current, projectId: routeProjectId || draftRef.current.projectId }); }).catch((caught: unknown) => { if (active) setOptionsError(caught instanceof Error ? caught.message.trim() : "读取示例项目时发生未知错误。"); }).finally(() => { if (active) setOptionsLoading(false); });
    return () => { active = false; };
  }, [live, mode]);
  function resetDraft() {
    const next: CreateTaskDraft = { ...emptyDraft };
    setDraft(next); draftRef.current = next; savedDraft.current = JSON.stringify(next);
    setFieldErrors({}); setActionError(null); setReceipt(null); setReadyBlockedReason(null);
    commandId.current = null; submittedIntent.current = null; pendingStep.current = null;
    setCreatedTaskId(null); createdRef.current = null; setLiveCreate(null);
    if (live) void refreshLiveCandidates(next.projectId ?? "");
  }
  function validate(intent: Intent): boolean {
    const errors: FieldErrors = {};
    if (!draft.title.trim()) errors.title = intent === "ready" ? "请填写任务名称，用简洁明确的语言描述要完成的工作。" : "暂存也需要一个任务名称，便于之后重新整理。";
    if ((intent === "ready" || live) && !draft.expectedResult.trim()) errors.expectedResult = intent === "ready" ? "请说明任务完成后应得到的具体成果或交付物。" : "真实契约要求预期结果（objective）非空，暂存也需要填写。";
    if (intent === "ready" && !draft.acceptanceCriteria.split("\n").map((line) => line.trim()).filter(Boolean).length) errors.acceptanceCriteria = "请至少写一条可判断的验收标准；空标准不能作为完成依据。";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }
  function handleLiveFailure(caught: unknown) {
    const described = describeLiveError(caught);
    const step = pendingStep.current?.step ?? null;
    const label = stepLabel(step);
    if (described.kind === "transport") { setActionError({ kind: "transport", message: `${label}请求没有得到服务端响应，这一步是否已提交尚未确定。请用同一个 command ID 查询回执，不要换 ID 重新提交。` }); return; }
    pendingStep.current = null;
    if (createdRef.current && step === "ready") setActionError({ kind: described.kind, message: `任务已创建（${createdRef.current}），但标记可开始失败：${described.message}任务仍保留为待整理，没有被重复创建。` });
    else if (createdRef.current && step === "dependency") setActionError({ kind: described.kind, message: `任务已创建（${createdRef.current}），但登记依赖失败：${described.message}任务已保留，可稍后单独处理依赖。` });
    else setActionError({ kind: described.kind, message: `${label}失败：${described.message}` });
  }
  async function submitLive(intent: Intent) {
    const client = liveClient();
    if (!client) { setActionError({ kind: "unknown", message: "连接已断开：请重新连接本机 API 后再创建任务。" }); return; }
    const criteria = draft.acceptanceCriteria.split("\n").map((line) => line.trim()).filter(Boolean);
    const createCommand = createCommandId();
    pendingStep.current = { step: "create", commandId: createCommand };
    const created = await client.createTask({ commandId: createCommand, projectId: projectId.trim() || null, title: draft.title.trim(), objective: draft.expectedResult.trim(), mode: draft.startIntent === "AI_ASSIST" ? "AI_ASSIST" : "ME", criteria });
    if (disposed.current) return;
    pendingStep.current = null; setLiveCreate(created); setCreatedTaskId(created.taskId); createdRef.current = created.taskId; savedDraft.current = JSON.stringify(draft);
    let status: TaskStatus = created.status; let revision = created.revision;
    const notes = [`已创建任务 ${created.taskId}：状态${taskStatusLabels[created.status]}，任务修订 v${created.revision}，验收版本 v${created.acceptanceRevision}`];
    if (draft.dependencyId) {
      const dependencyCommand = createCommandId(); pendingStep.current = { step: "dependency", commandId: dependencyCommand };
      const dependency = await client.addTaskDependency({ taskId: created.taskId, commandId: dependencyCommand, expectedRevision: revision, dependsOnTaskId: draft.dependencyId, dependencyKind: "BLOCKS" });
      if (disposed.current) return;
      pendingStep.current = null; status = dependency.status; revision = dependency.revision; notes.push(`已登记前置依赖，任务修订 v${revision}`);
    }
    if (intent === "ready") {
      const readyCommand = createCommandId(); pendingStep.current = { step: "ready", commandId: readyCommand };
      const ready = await client.markTaskReady({ taskId: created.taskId, commandId: readyCommand, expectedRevision: revision });
      if (disposed.current) return;
      pendingStep.current = null; status = ready.status; revision = ready.revision; notes.push(`已标记为${taskStatusLabels[status]}，任务修订 v${revision}`);
    } else notes.push("按你的选择暂存为待整理，未尝试转为可开始");
    setLiveCreate({ ...created, status, revision }); setReceipt(`${notes.join("；")}。尚未开始执行；开始不等于完成。`);
  }
  async function submit(intent: Intent) {
    if (submitting || createdRef.current !== null) return;
    if (submittedIntent.current !== null && submittedIntent.current !== intent) { setActionError({ kind: "conflict", message: "这次创建已经使用另一种保存意图提交；请先查询原 command ID 的回执。" }); return; }
    if (live && pendingStep.current) { setActionError({ kind: "conflict", message: "上一次请求的结果尚未确定：请先查询本次回执，不要用新的 command ID 重复创建任务。" }); return; }
    setActionError(null); setReadyBlockedReason(null);
    if (!validate(intent)) return;
    setSubmitting(true); submittedIntent.current = intent;
    try {
      if (live) { await submitLive(intent); return; }
      commandId.current ??= fixtureAdapter.createCommandId("task");
      const result = await fixtureAdapter.createTask(draft, mode, intent, commandId.current);
      if (disposed.current) return;
      setReceipt(result.receipt.description); setReadyBlockedReason(result.readyBlockedReason); setFieldErrors({}); setCreatedTaskId(result.taskId); createdRef.current = result.taskId; savedDraft.current = JSON.stringify(draft);
    } catch (caught) { if (!disposed.current) { if (live) handleLiveFailure(caught); else setActionError(toActionError(caught, "创建示例任务时发生未知错误。")); } }
    finally { if (!disposed.current) setSubmitting(false); }
  }
  async function lookupReceipt() {
    if (submitting) return;
    if (live) {
      const client = liveClient(); const pending = pendingStep.current;
      if (!client || !pending) return;
      setSubmitting(true); setActionError(null);
      try {
        const body = await client.getCommandReceipt(pending.commandId);
        if (disposed.current) return;
        if (pending.step === "create" && body.commandType === "CreateTask") { const creation = taskCreationFrom(body.result); pendingStep.current = null; setLiveCreate(creation); setCreatedTaskId(creation.taskId); createdRef.current = creation.taskId; savedDraft.current = JSON.stringify(draft); setReceipt(`回执确认已创建任务 ${creation.taskId}：状态${taskStatusLabels[creation.status]}，任务修订 v${creation.revision}，验收版本 v${creation.acceptanceRevision}。尚未开始执行；开始不等于完成。`); return; }
        if (pending.step === "dependency" && body.commandType === "AddTaskDependency") { const mutation = taskMutationFrom(body.result); pendingStep.current = null; setLiveCreate((current) => current && ({ ...current, status: mutation.status, revision: mutation.revision })); setReceipt(`回执确认已登记前置依赖：任务 ${mutation.taskId}，任务修订 v${mutation.revision}。`); return; }
        if (pending.step === "ready" && body.commandType === "MarkTaskReady") { const mutation = taskMutationFrom(body.result); pendingStep.current = null; setLiveCreate((current) => current && ({ ...current, status: mutation.status, revision: mutation.revision })); setReceipt(`回执确认已标记为${taskStatusLabels[mutation.status]}：任务 ${mutation.taskId}，任务修订 v${mutation.revision}。尚未开始执行；开始不等于完成。`); return; }
        setActionError({ kind: "unknown", message: `回执的命令类型是 ${body.commandType}，与本次步骤不匹配；请核对 command ID。` });
      } catch (caught) {
        if (disposed.current) return;
        if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") { pendingStep.current = null; setActionError({ kind: "not-submitted", message: "没有找到这次提交的回执：该步骤尚未提交，可以重新提交。" }); }
        else setActionError(describeLiveError(caught));
      } finally { if (!disposed.current) setSubmitting(false); }
      return;
    }
    if (!commandId.current) return;
    setSubmitting(true); setActionError(null);
    try {
      const result = await fixtureAdapter.lookupReceipt(commandId.current);
      if (disposed.current) return;
      if (result.status === "APPLIED" && result.operation === "task" && result.receipt && result.resourceId && result.taskStatus) { setReceipt(result.receipt.description); setReadyBlockedReason(result.readyBlockedReason ?? null); setCreatedTaskId(result.resourceId); createdRef.current = result.resourceId; savedDraft.current = JSON.stringify(draft); return; }
      setActionError({ kind: result.status === "UNKNOWN" ? "timeout" : "not-submitted", message: result.status === "UNKNOWN" ? "本次提交仍未确认；请继续使用同一 command ID 查询回执，不能直接创建第二个任务。" : "未找到这次提交的回执；尚未创建任务，可以使用同一 command ID 再次提交。" });
    } finally { if (!disposed.current) setSubmitting(false); }
  }
  function setProjectId(id: string) { updateDraft({ projectId: id || null, dependencyId: null }); setLiveCandidates([]); }
  const field = (key: keyof FieldErrors, label: string, value: string, set: (value: string) => void, multiline = false) => <label className={`field${fieldErrors[key] ? " field--invalid" : ""}`}><span className="field-label">{label}<span className="field-required" aria-hidden="true">*</span></span>{multiline ? <textarea value={value} onChange={(event) => { set(event.target.value); clearField(key); }} name="task-acceptance" rows={4} required maxLength={criteriaLimit} aria-invalid={fieldErrors[key] ? "true" : undefined} aria-describedby={fieldErrors[key] ? "task-acceptance-error" : "task-acceptance-hint"} /> : <input value={value} onChange={(event) => { set(event.target.value); clearField(key); }} name={key === "title" ? "task-title" : "task-expected-result"} required aria-invalid={fieldErrors[key] ? "true" : undefined} aria-describedby={fieldErrors[key] ? `${key === "title" ? "task-title" : "task-result"}-error` : `${key === "title" ? "task-title" : "task-result"}-hint`} />}{fieldErrors[key] ? <span id={key === "acceptanceCriteria" ? "task-acceptance-error" : `${key === "title" ? "task-title" : "task-result"}-error`} className="field-error" role="alert"><Info aria-hidden="true" />{fieldErrors[key]}</span> : <span id={key === "acceptanceCriteria" ? "task-acceptance-hint" : `${key === "title" ? "task-title" : "task-result"}-hint`} className="field-hint">{key === "title" ? "用简洁明确的语言描述这项任务要完成的工作。" : key === "expectedResult" ? "说明这项任务完成后应得到的具体成果或交付物。" : "每行一条，写下明确、可判断的验收条件；检查通过不等于任务完成。"}</span>}{key === "acceptanceCriteria" && <span className="field-counter">{value.length} / {criteriaLimit}</span>}</label>;

  return <div className="page-layout"><div className="page-primary"><p className="eyebrow">新建任务与执行准备</p><p className="page-lede">清晰定义任务目标、预期结果与验收标准，为后续执行做好准备。</p><h1>把想做的事，变成可完成的任务</h1>
    {createdTaskId === null ? <form className="create-form" noValidate onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void submit("ready"); }}>
      {field("title", "任务名称", draft.title, (value) => updateDraft({ title: value }))}
      {live ? <label className="field"><span className="field-label">所属项目（可选）</span><input value={projectId} onChange={(event) => setProjectId(event.target.value)} onBlur={() => void refreshLiveCandidates()} name="task-project-id" autoComplete="off" placeholder="Project UUID，留空表示未归属项目" /><span className="field-hint">真实 API 没有项目列表端点，这里填写项目 ID（来自创建回执或路由 query）。留空表示未归属项目（Me Inbox），未归属任务只能登记人工事项，依赖候选也需要项目 ID。</span></label> : <label className="field"><span className="field-label">所属项目（可选）</span><select value={projectId} onChange={(event) => setProjectId(event.target.value)} name="task-project" disabled={optionsLoading}><option value="">未归属项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select><span className="field-hint">选择任务所属的项目，或暂不归属。未归属项目的任务只允许人工事项，不会自动创建项目。</span></label>}
      {field("expectedResult", "预期结果", draft.expectedResult, (value) => updateDraft({ expectedResult: value }))}
      {field("acceptanceCriteria", "验收标准", draft.acceptanceCriteria, (value) => updateDraft({ acceptanceCriteria: value }), true)}
      <fieldset className="field"><legend className="field-label">开始方式<span className="field-required" aria-hidden="true">*</span></legend><div className="choice-list">{startIntents.map((intent) => <label key={intent.value} className="choice-option"><input checked={draft.startIntent === intent.value} onChange={() => updateDraft({ startIntent: intent.value })} type="radio" name="task-intent" value={intent.value} disabled={live && intent.value === "DELEGATE_AI"} /><span>{interactionModeLabels[intent.value]}<small>{intent.hint}</small></span></label>)}</div><span className="field-hint">{live ? "创建页只登记人工执行或 AI 辅助任务；若要委托，请在任务 READY 后到详情页单独发起。创建不会启动 Run。" : "委托将在任务就绪后单独确认范围；这里只记录你的意图，不会直接设置执行者。"}</span></fieldset>
      <label className="field"><span className="field-label">依赖任务（可选）</span><select value={draft.dependencyId ?? ""} onChange={(event) => updateDraft({ dependencyId: event.target.value || null })} name="task-dependency" disabled={optionsLoading || dependencyOptions.length === 0}><option value="">无</option>{dependencyOptions.map((task) => <option key={task.id} value={task.id}>{task.title}（{taskStatusLabels[task.status]}）</option>)}</select><span className="field-hint">{live ? !projectId.trim() ? "live 模式下依赖候选来自真实项目任务：请先填写项目 ID。" : !dependencyOptions.length ? "该项目暂时没有可选的前置任务，可以不选依赖继续创建。" : "依赖候选来自 GET /tasks?project_id=，只包含该项目的真实任务。" : !dependencyOptions.length ? "当前项目范围内没有可选的前置任务。" : "如需先完成其他任务，请选择依赖的任务；依赖未完成时不能转为可开始。"}</span></label>
      <div className="form-actions"><button className="primary-button" type="submit" data-testid="task-create-save" disabled={submitting}>{submitting ? "正在保存" : "保存任务"}</button><button className="secondary-button" type="button" data-testid="task-create-inbox" disabled={submitting} onClick={() => void submit("inbox")}>暂存待整理</button><button className="text-button" type="button" disabled={submitting} onClick={onCancel}>返回列表</button></div>
      {receipt && <p className="receipt-message" role="status">{receipt}</p>}{readyBlockedReason && <p className="warning-callout" role="status" data-testid="task-ready-blocked"><Info aria-hidden="true" />{readyBlockedReason}</p>}{actionError && <p className="action-error" role="alert">{actionError.message}</p>}{(actionError?.kind === "timeout" || actionError?.kind === "transport") && <button className="secondary-button" type="button" data-testid="task-create-receipt" disabled={submitting} onClick={() => void lookupReceipt()}>查询本次回执</button>}{actionError?.kind === "timeout" && <p className="helper-text">提交结果暂不明确时先查回执，不要直接重复创建。</p>}{actionError?.kind === "transport" && <p className="helper-text">这一步结果不确定时先查回执，不要换 command ID 重新提交。</p>}{actionError?.kind === "conflict" && <p className="helper-text">冲突时草稿仍然保留，修改后可以重新提交。</p>}{optionsError && <p className="helper-text">{optionsError}</p>}
    </form> : live ? <section className="surface-panel" aria-label="任务创建结果" data-testid="task-created-result"><p className="eyebrow">已完成本次创建</p><h2>任务已创建</h2><dl className="rail-definition-list"><div><dt>任务 ID</dt><dd><Link className="text-link" to={`/tasks/${createdTaskId}`} aria-label="查看刚创建的任务详情" data-testid="task-created-open-detail">{createdTaskId}</Link></dd></div>{liveCreate && <><div><dt>状态</dt><dd>{taskStatusLabels[liveCreate.status]}</dd></div><div><dt>任务修订</dt><dd>v{liveCreate.revision}</dd></div><div><dt>验收版本</dt><dd>v{liveCreate.acceptanceRevision}</dd></div></>}</dl>{receipt && <p className="receipt-message" role="status">{receipt}</p>}{actionError && <p className="action-error" role="alert">{actionError.message}</p>}{actionError?.kind === "transport" && <><button className="secondary-button secondary-button--wide" type="button" data-testid="task-create-receipt" disabled={submitting} onClick={() => void lookupReceipt()}>查询本次回执</button><p className="helper-text">这一步结果不确定时先查回执，不要换 command ID 重新提交。</p></>}<p className="helper-text">任务已写入真实 PostgreSQL；开始不等于完成，创建后不会自动开始执行。</p><div className="form-actions"><button className="primary-button" type="button" onClick={onCancel}>返回任务入口</button><button className="secondary-button" type="button" data-testid="task-create-another" onClick={resetDraft}>新建另一项任务</button></div></section> : <section className="surface-panel" aria-label="任务创建结果" data-testid="task-created-result"><p className="eyebrow">已完成本次创建</p><h2>任务已创建，等待后续处理</h2><p>示例任务 ID：{createdTaskId}。同一创建意图已关闭，不能再次保存而产生重复任务。</p>{receipt && <p className="receipt-message" role="status">{receipt}</p>}{readyBlockedReason && <p className="warning-callout" role="status" data-testid="task-ready-blocked"><Info aria-hidden="true" />{readyBlockedReason}</p>}<div className="form-actions"><button className="primary-button" type="button" onClick={onCancel}>查看任务列表</button><button className="secondary-button" type="button" data-testid="task-create-another" onClick={resetDraft}>新建另一项任务</button></div></section>}
  </div><ResponsiveRail label="查看完成标准说明" title="完成标准要可判断"><div className="rail-content"><h2>完成标准要可判断</h2><p className="rail-intro">三条明确的验收标准，比一句“写得更好”更有用。</p><section className="rail-section"><h3>好的验收标准通常具备</h3>{[["具体明确", "说明要达到什么结果，而不是模糊的描述。"], ["可验证", "有客观的判断依据或检验方法。"], ["可追溯", "成果能关联到相应的过程与原始记录。"]].map(([heading, copy]) => <div className="suggestion-row" key={heading}><Check aria-hidden="true" /><span className="suggestion-copy"><strong>{heading}</strong><small>{copy}</small></span></div>)}</section><section className="rail-section"><h3>示例</h3><div className="summary-card summary-card--source-list"><p>指标计算方式明确</p><p>基线步骤可复现</p><p>结果可追溯到原始记录</p></div><p className="helper-text">示例只说明写法，不构成这个任务的必需条件，也不限制条件数量。</p></section><section className="rail-section"><h3>保存后的状态</h3><p>任务会先保存为“待整理”，由我执行。选择“保存任务”后，系统会核对目标、验收条件与前置依赖；条件满足时才会显示为“可开始”，且不会自动开始执行。</p>{inboxScope && <p className="helper-text">当前从收件箱范围进入：默认不归属项目，任务会出现在收件箱列表中。</p>}</section></div></ResponsiveRail></div>;
}
