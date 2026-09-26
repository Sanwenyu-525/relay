import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { RotateCcw } from "lucide-react";
import { blueprintApplyResultFrom, blueprintProposalFrom,
  type RelayBlueprintApplyResult, type RelayBlueprintDraft,
  type RelayBlueprintNextAction, type RelayBlueprintProposal,
  type RelayBlueprintTemplate, type RelayProjectGoal }
  from "../api/blueprintDtos";
import { createCommandId, RelayApiError, RelayTransportError,
  type RelayApiClient, type RelayCommandEnvelope, type RelayPackDefinition,
  type RelayProject, type RelayProjectState, type RelayTaskSummary,
  type RelayViewConfiguration, type RelayViewKind } from "../api/relayClient";
import ResponsiveRail from "../components/ResponsiveRail";
import BlueprintSkillGenerator from "./BlueprintSkillGenerator";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { clearInitialBlueprintIntent, readInitialBlueprintIntent,
  saveInitialBlueprintIntent } from "../lib/initialBlueprintIntent";
import { phaseLabel, projectTypeLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import type { ProjectType } from "../types";
import "./LiveBlueprintView.css";

const kinds: readonly { kind: RelayViewKind; label: string }[] = [
  { kind: "general", label: "通用" }, { kind: "thesis", label: "论文" },
  { kind: "development", label: "开发" }
];
const phases: Readonly<Record<ProjectType, readonly string[]>> = {
  GENERAL: ["PLANNING", "EXECUTING", "REVIEW"],
  THESIS: ["TOPIC", "LITERATURE", "METHOD", "EXPERIMENT", "WRITING", "REVIEW"],
  DEVELOPMENT: ["DISCOVERY", "DESIGN", "IMPLEMENTATION", "VALIDATION", "RELEASE"]
};
const pageLabels: Readonly<Record<string, string>> = {
  state: "项目状态", tasks: "任务", artifacts: "产物", reviews: "待审",
  knowledge: "资料", runs: "运行", connections: "连接"
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface Facts {
  readonly project: RelayProject;
  readonly state: RelayProjectState;
  readonly view: RelayViewConfiguration;
  readonly goals: readonly RelayProjectGoal[];
  readonly packs: readonly RelayPackDefinition[];
  readonly tasks: readonly RelayTaskSummary[];
  readonly nextTaskCursor: string | null;
  readonly proposals: readonly RelayBlueprintProposal[];
}
interface Form {
  readonly intent: string;
  readonly goalId: string;
  readonly phaseKey: string;
  readonly tasks: readonly { readonly localKey: string; readonly title: string;
    readonly objective: string }[];
  readonly nextKind: "UNCHANGED" | "NEW_TASK" | "EXISTING_TASK" | "CLEAR";
  readonly nextValue: string;
  readonly viewKind: RelayViewKind;
  readonly packRef: { readonly id: string; readonly version: string } | null;
}
type Pending =
  | { readonly action: "create"; readonly id: string; readonly conflict: boolean;
    readonly expectedProjectRevision: string; readonly expectedStateRevision: string;
    readonly expectedViewRevision: string; readonly draft: RelayBlueprintDraft;
    readonly supersedesProposalId: string | null }
  | { readonly action: "apply"; readonly id: string; readonly conflict: boolean;
    readonly proposalId: string; readonly candidateSha256: string;
    readonly expectedProjectRevision: string; readonly expectedStateRevision: string;
    readonly expectedViewRevision: string }
  | { readonly action: "reject"; readonly id: string; readonly conflict: boolean;
    readonly proposalId: string; readonly candidateSha256: string };

function kindLabel(kind: RelayViewKind) { return kinds.find((item) => item.kind === kind)?.label ?? kind; }
function statusLabel(status: RelayBlueprintProposal["status"]): string {
  return { PENDING: "待确认", ACCEPTED: "已应用", REJECTED: "已暂不采用",
    SUPERSEDED: "已被新候选替代", EXPIRED: "已失效" }[status];
}
function emptyForm(viewKind: RelayViewKind): Form {
  return { intent: "", goalId: "", phaseKey: "", tasks: [{ localKey: "task1", title: "", objective: "" }],
    nextKind: "UNCHANGED", nextValue: "", viewKind, packRef: null };
}
function formFromProposal(proposal: RelayBlueprintProposal): Form {
  const candidate = proposal.candidate;
  if (!candidate) throw new Error("不可用蓝图候选没有可编辑正文。");
  const next = candidate.nextAction;
  return { intent: candidate.intent, goalId: candidate.goalId ?? "",
    phaseKey: candidate.phaseKey ?? "",
    tasks: candidate.tasks.length ? candidate.tasks.map((task) =>
      ({ localKey: task.local_key, title: task.title, objective: task.objective })) :
      [{ localKey: "task1", title: "", objective: "" }],
    nextKind: next?.kind ?? "UNCHANGED",
    nextValue: next?.kind === "NEW_TASK" ? next.local_key :
      next?.kind === "EXISTING_TASK" ? next.task_id : "",
    viewKind: candidate.viewConfiguration.kind,
    packRef: proposal.source.pack ? { id: proposal.source.pack.id,
      version: proposal.source.pack.version } : null };
}
function formFromDraft(draft: RelayBlueprintDraft): Form {
  const next = draft.next_action;
  return { intent: draft.intent, goalId: draft.goal_id ?? "", phaseKey: draft.phase_key ?? "",
    tasks: draft.tasks.length ? draft.tasks.map((task) => ({ localKey: task.local_key,
      title: task.title, objective: task.objective })) :
      [{ localKey: "task1", title: "", objective: "" }],
    nextKind: next?.kind ?? "UNCHANGED",
    nextValue: next?.kind === "NEW_TASK" ? next.local_key :
      next?.kind === "EXISTING_TASK" ? next.task_id : "",
    viewKind: draft.view_kind, packRef: draft.pack_ref };
}
function pendingKey(client: RelayApiClient, projectId: string): string {
  return `relay:blueprint:${client.baseUrl}:${client.workspaceId}:${projectId}`;
}
function readPending(key: string): Pending | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || !["create", "apply", "reject"].includes(String(row.action))) return null;
    if (row.action === "create" && typeof row.draft === "object" && row.draft !== null &&
      typeof row.expectedProjectRevision === "string" && typeof row.expectedStateRevision === "string" &&
      typeof row.expectedViewRevision === "string") return row as unknown as Pending;
    if (row.action === "apply" && typeof row.proposalId === "string" &&
      typeof row.candidateSha256 === "string" && typeof row.expectedProjectRevision === "string" &&
      typeof row.expectedStateRevision === "string" && typeof row.expectedViewRevision === "string") {
      return row as unknown as Pending;
    }
    if (row.action === "reject" && typeof row.proposalId === "string" &&
      typeof row.candidateSha256 === "string") return row as unknown as Pending;
    return null;
  } catch { return null; }
}
function savePending(key: string, pending: Pending | null) {
  try {
    if (pending) sessionStorage.setItem(key, JSON.stringify(pending));
    else sessionStorage.removeItem(key);
  } catch { /* The active page still retains the frozen command. */ }
}
function commandType(command: Pending): string {
  return { create: "CreateProjectBlueprintProposal", apply: "ApplyProjectBlueprint",
    reject: "RejectProjectBlueprint" }[command.action];
}
function templatePages(template: RelayBlueprintTemplate) {
  return [...template.pages].sort((a, b) => a.position - b.position).map((page) =>
    `${pageLabels[page.pageId] ?? page.pageId} (${page.pageId}, ${page.visible ? "显示" : "隐藏"})`).join(" → ");
}
function nextActionText(next: RelayBlueprintNextAction | null): string {
  if (!next) return "保持当前下一步";
  if (next.kind === "CLEAR") return "清空下一步";
  if (next.kind === "NEW_TASK") return `新任务 ${next.local_key}`;
  return `现有任务 ${next.task_id}`;
}

async function prepareDraft(form: Form, client: RelayApiClient, projectId: string,
  facts: Facts): Promise<RelayBlueprintDraft> {
  const intent = form.intent.trim();
  if (!intent || intent.length > 2000) throw new Error("请填写 1–2000 字的蓝图意图；它仍是人工草稿，不会自动创建 Goal。");
  const tasks = form.tasks.filter((task) => task.title.trim() || task.objective.trim())
    .map((task) => ({ local_key: task.localKey,
      title: task.title.trim(), objective: task.objective.trim() }));
  if (tasks.length > 5 || tasks.some((task) => !task.title || !task.objective ||
    task.title.length > 200 || task.objective.length > 2000)) {
    throw new Error("最多 5 个新任务；每项都需要标题（≤200 字）和目标（≤2000 字）。");
  }
  const goalId = form.goalId.trim() || null;
  if (goalId) {
    if (!uuid.test(goalId)) throw new Error("Goal ID 必须是完整 UUID。");
    const goal = await client.getGoal(goalId);
    if (goal.id !== goalId || goal.status !== "ACTIVE") throw new Error("选中的 Goal 不是当前 Workspace 的有效 Goal。");
  }
  const phaseKey = form.phaseKey || null;
  if (phaseKey && !phases[facts.project.projectType as ProjectType]?.includes(phaseKey)) {
    throw new Error("所选阶段不属于当前 Project Type。");
  }
  let nextAction: RelayBlueprintDraft["next_action"] = null;
  if (form.nextKind === "CLEAR") nextAction = { kind: "CLEAR" };
  else if (form.nextKind === "NEW_TASK") {
    if (!tasks.some((task) => task.local_key === form.nextValue)) throw new Error("下一步必须引用本次确实新增的任务。");
    nextAction = { kind: "NEW_TASK", local_key: form.nextValue };
  } else if (form.nextKind === "EXISTING_TASK") {
    const taskId = form.nextValue.trim();
    if (!uuid.test(taskId)) throw new Error("现有下一步 Task ID 必须是完整 UUID。");
    const task = await client.getTask(taskId);
    if (task.id !== taskId || task.projectId !== projectId) throw new Error("下一步 Task 不属于当前项目。");
    nextAction = { kind: "EXISTING_TASK", task_id: taskId };
  }
  if (form.packRef && !facts.packs.some((pack) => pack.id === form.packRef?.id &&
    pack.version === form.packRef?.version && pack.availability === "AVAILABLE")) {
    throw new Error("所选 Pack 版本当前不可用，请重新选择。");
  }
  return { intent, goal_id: goalId, phase_key: phaseKey, tasks,
    next_action: nextAction, view_kind: form.viewKind, pack_ref: form.packRef };
}

export default function LiveBlueprintView() {
  const { id = "" } = useParams();
  const connection = useRelayConnection();
  const client = connection.client;
  const [facts, setFacts] = useState<Facts | null>(null);
  const [proposal, setProposal] = useState<RelayBlueprintProposal | null>(null);
  const [form, setForm] = useState<Form>(emptyForm("general"));
  const [loading, setLoading] = useState(true);
  const [projectReadError, setProjectReadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generationBusy, setGenerationBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [mayRetry, setMayRetry] = useState(false);
  const [applyResult, setApplyResult] = useState<RelayBlueprintApplyResult | null>(null);
  const [fromCreate, setFromCreate] = useState(false);
  const scope = useRef(0);
  const loadSeq = useRef(0);
  const pendingRef = useRef<Pending | null>(null);
  const preparingRef = useRef(false);
  const selectedId = useRef<string | null>(null);
  const formRef = useRef(form);
  const savedForm = useRef(JSON.stringify(form));
  const nextLocalKey = useRef(2);
  formRef.current = form;
  const storageKey = client ? pendingKey(client, id) : null;
  const guard = useRef<DraftGuard>({
    hasUnsavedChanges: () => JSON.stringify(formRef.current) !== savedForm.current,
    discard: () => { setForm(JSON.parse(savedForm.current) as Form); }
  });
  useEffect(() => { setDraftGuard(guard.current); return () => clearDraftGuard(guard.current); }, []);

  function freeze(command: Pending | null) {
    pendingRef.current = command; setPending(command);
    if (storageKey) savePending(storageKey, command);
  }

  async function load(activeClient: RelayApiClient, request: number,
    preferredId: string | null, preserveDraft: boolean): Promise<Facts | null> {
    const sequence = ++loadSeq.current;
    setLoading(true); setError(null);
    try {
      const [project, state, view, goals, packs, taskPage, proposals] = await Promise.all([
        activeClient.getProject(id), activeClient.getProjectState(id),
        activeClient.getViewConfiguration(id), activeClient.getProjectGoals(id),
        activeClient.getFirstPartyPacks(), activeClient.getProjectTasksPage(id),
        activeClient.getBlueprintProposals(id)
      ]);
      if (project.id !== id || state.projectId !== id || view.projectId !== id ||
        proposals.some((item) => item.projectId !== id || item.workspaceId !== activeClient.workspaceId)) {
        throw new Error("蓝图查询返回了其他项目或 Workspace 的数据。");
      }
      const chosen = proposals.find((item) => item.id === preferredId) ??
        proposals.find((item) => item.status === "PENDING") ?? proposals[0] ?? null;
      const exact = chosen ? await activeClient.getBlueprintProposal(id, chosen.id) : null;
      if (exact && (exact.id !== chosen?.id || exact.projectId !== id ||
        exact.workspaceId !== activeClient.workspaceId)) throw new Error("蓝图单读与项目范围不匹配。");
      const next: Facts = { project, state, view, goals, packs,
        tasks: taskPage.items, nextTaskCursor: taskPage.nextCursor, proposals };
      if (request !== scope.current || sequence !== loadSeq.current) return null;
      setProjectReadError(false);
      setFacts(next); setProposal(exact); selectedId.current = exact?.id ?? null;
      const concealed = exact?.contentAvailability === "SOURCE_UNAVAILABLE";
      setApplyResult((current) => !concealed && current?.proposalId === exact?.id ? current : null);
      if (concealed || !preserveDraft) {
        const startingIntent = !exact && !concealed
          ? readInitialBlueprintIntent(activeClient, id) : null;
        const initial = exact && !concealed ? formFromProposal(exact) :
          { ...emptyForm(view.kind), intent: startingIntent ?? "" };
        setForm(initial); formRef.current = initial; savedForm.current = JSON.stringify(initial);
        setFromCreate(startingIntent !== null);
        nextLocalKey.current = 1 + Math.max(1, ...initial.tasks.map((task) =>
          Number(/^task(\d+)$/u.exec(task.localKey)?.[1] ?? 0)));
      }
      return next;
    } catch (caught) {
      if (request === scope.current && sequence === loadSeq.current) {
        setProjectReadError(true);
        if (caught instanceof RelayApiError && (caught.problem.status === 403 || caught.problem.status === 404)) {
          setFacts(null); setProposal(null); setApplyResult(null);
        }
        setError(describeLiveError(caught).message);
      }
      return null;
    } finally { if (request === scope.current && sequence === loadSeq.current) setLoading(false); }
  }

  async function resolveSuccess(activeClient: RelayApiClient, command: Pending,
    envelope: RelayCommandEnvelope, request: number) {
    if (envelope.commandId !== command.id) throw new RelayTransportError("蓝图回执的 command_id 不匹配。");
    let targetId: string | null = null;
    if (command.action === "create") {
      const created = blueprintProposalFrom(envelope.result);
      if (created.projectId !== id || created.workspaceId !== activeClient.workspaceId ||
        created.status !== "PENDING" || created.origin !== "USER_DRAFT" ||
        created.contentAvailability !== "AVAILABLE" ||
        created.baseline?.projectRevision !== command.expectedProjectRevision ||
        created.baseline.stateRevision !== command.expectedStateRevision ||
        created.baseline.viewRevision !== command.expectedViewRevision ||
        created.supersedesProposalId !== command.supersedesProposalId) {
        throw new RelayTransportError("新候选回执与原草稿或基线不匹配。");
      }
      targetId = created.id;
      if (request === scope.current) { setProposal(created); selectedId.current = created.id; }
      clearInitialBlueprintIntent(activeClient, id);
      setFromCreate(false);
    } else if (command.action === "apply") {
      const result = blueprintApplyResultFrom(envelope.result);
      if (result.projectId !== id || result.proposalId !== command.proposalId ||
        result.candidateSha256 !== command.candidateSha256) {
        throw new RelayTransportError("应用回执与原候选不匹配。");
      }
      targetId = command.proposalId;
      if (request === scope.current) setApplyResult(result);
    } else {
      const result = envelope.result;
      if (result.proposal_id !== command.proposalId || result.status !== "REJECTED") {
        throw new RelayTransportError("暂不采用回执与原候选不匹配。");
      }
      targetId = command.proposalId;
    }
    if (request !== scope.current) return;
    freeze(null); setMayRetry(false); setError(null);
    const latest = await load(activeClient, request, targetId, false);
    if (request !== scope.current) return;
    setMessage(latest === null ? "原命令回执已确认；最新事实查询失败，请稍后刷新。" :
      command.action === "create" ? "服务端已保存人工草稿候选；还没有应用到项目。" :
        command.action === "apply" ? "蓝图应用回执已确认；请核对下方实际效果。" :
          "服务端已记录暂不采用；项目及历史候选保留。");
  }

  async function checkReceipt(command: Pending, activeClient: RelayApiClient, request: number) {
    setBusy(true);
    try {
      const receipt = await activeClient.getCommandReceipt(command.id);
      if (request !== scope.current) return;
      if (receipt.commandType !== commandType(command)) {
        throw new RelayTransportError("原蓝图回执类型不匹配。");
      }
      await resolveSuccess(activeClient, command, receipt, request);
    } catch (caught) {
      if (request !== scope.current) return;
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetry(!command.conflict);
        setError(command.conflict
          ? "原命令没有回执；当前版本或候选已冲突。先核对最新事实，再明确重新提交。"
          : "原命令回执暂未找到；可继续查询，或用原 ID 和冻结的载荷重试。");
      } else setError("原蓝图回执仍无法核对；请保留 command_id 与原载荷继续查询。");
    } finally { if (request === scope.current) setBusy(false); }
  }

  useEffect(() => {
    const request = ++scope.current;
    selectedId.current = null; pendingRef.current = null; setPending(null);
    setFacts(null); setProposal(null); setApplyResult(null); setMessage(null); setError(null);
    setProjectReadError(false);
    if (!client || !storageKey) return () => { scope.current++; };
    const restored = readPending(storageKey);
    pendingRef.current = restored; setPending(restored);
    if (restored?.action === "create") {
      const restoredForm = formFromDraft(restored.draft);
      setForm(restoredForm); formRef.current = restoredForm;
      nextLocalKey.current = 1 + Math.max(1, ...restoredForm.tasks.map((task) =>
        Number(/^task(\d+)$/u.exec(task.localKey)?.[1] ?? 0)));
    }
    const preferred = restored?.action === "apply" || restored?.action === "reject"
      ? restored.proposalId : restored?.supersedesProposalId ?? null;
    void load(client, request, preferred, restored?.action === "create").then(() => {
      if (request === scope.current && restored) void checkReceipt(restored, client, request);
    });
    return () => { scope.current++; loadSeq.current++; pendingRef.current = null; };
  }, [client, id, storageKey]);

  async function send(command: Pending, retry = false) {
    if (!client || busy || generationBusy || preparingRef.current || (!facts && !retry) ||
      (!retry && writeBlockedReason !== null) ||
      (pendingRef.current && (!retry || pendingRef.current !== command))) return;
    const request = scope.current;
    freeze(command); setBusy(true); setMayRetry(false); setError(null); setMessage(null);
    try {
      const envelope = command.action === "create"
        ? await client.createBlueprintProposal({ projectId: id, commandId: command.id,
          expectedProjectRevision: command.expectedProjectRevision,
          expectedStateRevision: command.expectedStateRevision,
          expectedViewRevision: command.expectedViewRevision,
          draft: command.draft, supersedesProposalId: command.supersedesProposalId })
        : command.action === "apply"
          ? await client.applyBlueprintProposal({ projectId: id, proposalId: command.proposalId,
            commandId: command.id, candidateSha256: command.candidateSha256,
            expectedProjectRevision: command.expectedProjectRevision,
            expectedStateRevision: command.expectedStateRevision,
            expectedViewRevision: command.expectedViewRevision })
          : await client.rejectBlueprintProposal({ projectId: id,
            proposalId: command.proposalId, commandId: command.id,
            candidateSha256: command.candidateSha256 });
      if (request === scope.current) await resolveSuccess(client, command, envelope, request);
    } catch (caught) {
      if (request !== scope.current) return;
      if (caught instanceof RelayApiError && caught.problem.status === 409) {
        const conflicted = { ...command, conflict: true } as Pending;
        freeze(conflicted);
        setError(`${describeLiveError(caught).message} 原 command_id：${command.id}。`);
        await load(client, request, command.action === "create" ? command.supersedesProposalId :
          command.proposalId, true);
        if (request === scope.current) await checkReceipt(conflicted, client, request);
      } else if (caught instanceof RelayApiError && caught.problem.status < 500 &&
        caught.problem.code !== "COMMAND_ID_REUSED") {
        freeze(null); setError(describeLiveError(caught).message);
      } else {
        setError("提交结果尚不明确。正在查询原 command_id 回执；不能生成新命令替代。");
        await checkReceipt(command, client, request);
      }
    } finally { if (request === scope.current) setBusy(false); }
  }

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || !facts || writeBlockedReason !== null || busy || generationBusy || preparingRef.current || pendingRef.current) return;
    const factsSequence = loadSeq.current;
    preparingRef.current = true; setBusy(true);
    setError(null);
    try {
      const draft = await prepareDraft(form, client, id, facts);
      if (factsSequence !== loadSeq.current) return;
      const command: Pending = { action: "create", id: createCommandId(), conflict: false,
        expectedProjectRevision: facts.project.revision,
        expectedStateRevision: facts.state.revision,
        expectedViewRevision: facts.view.revision,
        draft, supersedesProposalId: proposal?.status === "PENDING" ? proposal.id : null };
      preparingRef.current = false; setBusy(false);
      await send(command);
    } catch (caught) { setError(describeLiveError(caught).message); }
    finally { preparingRef.current = false; setBusy(false); }
  }

  function setTask(localKey: string, field: "title" | "objective", value: string) {
    setForm((current) => ({ ...current, tasks: current.tasks.map((task) =>
      task.localKey === localKey ? { ...task, [field]: value } : task) }));
  }
  function resetDraft() {
    const restored = JSON.parse(savedForm.current) as Form;
    setForm(restored); setError(null);
    if (fromCreate && client) saveInitialBlueprintIntent(client, id, restored.intent);
  }
  const dirty = JSON.stringify(form) !== savedForm.current;
  const writeBlockedReason = !facts || loading || projectReadError ? "Project 事实正在核对或读取失败，不能提交新的蓝图命令。" :
    facts.project.archivedAt !== null ? "项目已归档，不能生成、应用或拒绝新的蓝图候选。" : null;
  const activePack = form.packRef && facts?.packs.find((pack) =>
    pack.id === form.packRef?.id && pack.version === form.packRef?.version);
  const eligibleApply = proposal?.status === "PENDING" &&
    proposal.contentAvailability === "AVAILABLE" && proposal.baseline !== null &&
    !proposal.stale && !dirty && !pending && !busy && !generationBusy && writeBlockedReason === null;
  const result = proposal?.contentAvailability === "AVAILABLE"
    ? applyResult ?? proposal.appliedResult : null;

  if (!client) return <section className="page-state"><h1>未连接本机 API</h1>
    <p>此处的真实蓝图需要先连接本机服务。</p></section>;
  if (loading && !facts) return <section className="page-state" aria-live="polite"><h1>正在读取项目蓝图</h1>
    <p>正在核对 Project、State、View、Goal、Pack 与已有候选。</p></section>;
  if (!facts) return <section className="page-state page-state--error" role="alert"><h1>暂时无法读取项目蓝图</h1>
    <p>{error ?? "没有可用的项目事实。"}</p><button className="secondary-button" type="button"
      onClick={() => void load(client, scope.current, selectedId.current, true)}>重新读取</button>
    {message && <p className="success-callout" role="status">{message}</p>}
    {pending && <div className="warning-callout" data-testid="blueprint-pending"><p>原命令 {pending.id} 仍待核对。</p>
      <button className="secondary-button" type="button" disabled={busy}
        onClick={() => void checkReceipt(pending, client, scope.current)}>查询原命令回执</button>
      {mayRetry && !pending.conflict && <button className="secondary-button" type="button" disabled={busy}
        onClick={() => void send(pending, true)}>用原 ID 和载荷重试</button>}</div>}</section>;

  return <section className="skill-page live-blueprint"><div className="page-layout">
    <div className="page-primary">
      <p className="eyebrow">{facts.project.title}</p><h1>项目蓝图</h1>
      <p className="page-lede">人工草稿先生成不可变候选，再核对服务端 Diff 并显式应用。蓝图意图不会自动成为已确认 Goal。</p>
      <p className="metadata-row">项目类型：{projectTypeLabels[facts.project.projectType as ProjectType] ?? facts.project.projectType}
        <span aria-hidden="true"> · </span> 当前阶段：{phaseLabel(facts.state.phaseKey)}
        <span aria-hidden="true"> · </span> Project v{facts.project.revision} / State v{facts.state.revision} / View v{facts.view.revision}</p>
      <div className="live-blueprint-toolbar"><button className="secondary-button" type="button" disabled={busy || loading}
        onClick={() => void load(client, scope.current, selectedId.current, true)}><RotateCcw aria-hidden="true" />刷新事实与候选</button>
        <Link className="text-link" to={`/projects/${id}/workbench`}>打开当前工作台</Link></div>
      {loading && <p role="status">正在核对服务端当前事实…</p>}
      {error && <p className="action-error" role="alert">{error}</p>}
      {writeBlockedReason && <p className="disabled-reason" data-testid="blueprint-archive-reason">{writeBlockedReason}</p>}
      {message && <p className="success-callout" role="status">{message}</p>}
      <BlueprintSkillGenerator client={client} projectId={id} goals={facts.goals} packs={facts.packs}
        disabled={busy || pending !== null || loading || dirty || writeBlockedReason !== null}
        newWritesBlocked={writeBlockedReason !== null}
        onActiveChange={setGenerationBusy}
        onProposalFound={(proposalId) => void load(client, scope.current, proposalId, false)} />
      <form className="surface-panel live-blueprint-form" data-testid="live-blueprint-form" onSubmit={(event) => void preview(event)}>
        <h2>{proposal ? "编辑并生成新候选" : "填写蓝图草稿"}</h2>
        <p className="helper-text">来源将登记为 USER_DRAFT（人工草稿）；不会调用模型，也不会因为选择 Pack 而获得工具权限。</p>
        {fromCreate && <p className="helper-text">首次创建时填写的项目目标已恢复为待预览意图；尚未生成候选或确认 Goal。</p>}
        <fieldset disabled={busy || generationBusy || pending !== null || writeBlockedReason !== null}>
          <label className="field"><span className="field-label">蓝图意图</span>
            <textarea data-testid="blueprint-intent" value={form.intent} maxLength={2000}
              onChange={(event) => { setForm({ ...form, intent: event.target.value });
                if (fromCreate && !saveInitialBlueprintIntent(client, id, event.target.value)) {
                  setError("无法暂存待预览意图；刷新前请先复制文本。");
                } }}
              placeholder="写明这份蓝图希望怎样组织当前项目" /></label>
          <label className="field"><span className="field-label">要关联的现有 Goal ID（可选）</span>
            <input data-testid="blueprint-goal-id" value={form.goalId} list="blueprint-project-goals"
              onChange={(event) => setForm({ ...form, goalId: event.target.value })}
              placeholder="留空则不新增 Goal 关联" /></label>
          <datalist id="blueprint-project-goals">{facts.goals.filter((goal) => goal.status === "ACTIVE")
            .map((goal) => <option key={goal.goalId} value={goal.goalId} label={goal.title} />)}</datalist>
          <p className="helper-text">已关联 Goal {facts.goals.length} 项；也可输入确切 Workspace Goal UUID。提交前会单读核对 ACTIVE，空值不会创建 Goal。</p>
          <label className="field"><span className="field-label">项目阶段</span>
            <select data-testid="blueprint-phase" value={form.phaseKey}
              onChange={(event) => setForm({ ...form, phaseKey: event.target.value })}>
              <option value="">保持当前阶段（{phaseLabel(facts.state.phaseKey)}）</option>
              {(phases[facts.project.projectType as ProjectType] ?? []).map((phase) =>
                <option key={phase} value={phase}>{phaseLabel(phase)}</option>)}</select></label>
          <div className="live-blueprint-tasks"><h3>新任务（最多 5 项）</h3>
            <p className="helper-text">服务端应用后才创建，固定为人工执行、INBOX；不启动 Run。</p>
            {form.tasks.map((task, index) => <div className="live-blueprint-task" key={task.localKey}>
              <strong>新任务 {index + 1} · {task.localKey}</strong>
              <label className="field"><span className="field-label">标题</span>
                <input value={task.title} maxLength={200} data-testid={`blueprint-task-title-${index}`}
                  onChange={(event) => setTask(task.localKey, "title", event.target.value)} /></label>
              <label className="field"><span className="field-label">目标</span>
                <textarea value={task.objective} maxLength={2000} data-testid={`blueprint-task-objective-${index}`}
                  onChange={(event) => setTask(task.localKey, "objective", event.target.value)} /></label>
              <button className="text-button" type="button" onClick={() => setForm({ ...form,
                tasks: form.tasks.filter((item) => item.localKey !== task.localKey) })}>移除这项</button>
            </div>)}
            {form.tasks.length < 5 && <button className="secondary-button" type="button" onClick={() => {
              const localKey = `task${nextLocalKey.current++}`;
              setForm({ ...form, tasks: [...form.tasks, { localKey, title: "", objective: "" }] });
            }}>添加新任务</button>}
          </div>
          <label className="field"><span className="field-label">项目下一步</span>
            <select data-testid="blueprint-next-kind" value={form.nextKind}
              onChange={(event) => setForm({ ...form,
                nextKind: event.target.value as Form["nextKind"], nextValue: "" })}>
              <option value="UNCHANGED">保持当前下一步</option><option value="NEW_TASK">本次新任务</option>
              <option value="EXISTING_TASK">现有项目任务</option><option value="CLEAR">清空下一步</option>
            </select></label>
          {form.nextKind === "NEW_TASK" && <label className="field"><span className="field-label">选择本次新任务</span>
            <select value={form.nextValue} data-testid="blueprint-next-new"
              onChange={(event) => setForm({ ...form, nextValue: event.target.value })}>
              <option value="">请选择</option>{form.tasks.filter((task) => task.title.trim() && task.objective.trim())
                .map((task) => <option key={task.localKey} value={task.localKey}>{task.title}</option>)}</select></label>}
          {form.nextKind === "EXISTING_TASK" && <label className="field"><span className="field-label">现有 Task ID</span>
            <input value={form.nextValue} list="blueprint-project-tasks" data-testid="blueprint-next-existing"
              onChange={(event) => setForm({ ...form, nextValue: event.target.value })}
              placeholder="输入当前项目 Task UUID" /></label>}
          <datalist id="blueprint-project-tasks">{facts.tasks.map((task) =>
            <option key={task.id} value={task.id} label={task.title} />)}</datalist>
          {form.nextKind === "EXISTING_TASK" && <p className="helper-text">这里仅列出已加载的 {facts.tasks.length} 项任务；
            {facts.nextTaskCursor ? "还有后续页。" : "服务端未返回下一页游标。"} 也可输入确切 Task ID，提交前单读核对所属项目。</p>}
          <label className="field"><span className="field-label">默认工作台</span>
            <select data-testid="blueprint-view-kind" value={form.viewKind}
              onChange={(event) => setForm({ ...form, viewKind: event.target.value as RelayViewKind })}>
              {kinds.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select></label>
          <label className="field"><span className="field-label">Pack 来源（可选）</span>
            <select data-testid="blueprint-pack" value={form.packRef ? JSON.stringify(form.packRef) : ""}
              onChange={(event) => { const pack = facts.packs.find((item) => JSON.stringify({ id: item.id,
                version: item.version }) === event.target.value);
                setForm({ ...form, packRef: pack ? { id: pack.id, version: pack.version } : null }); }}>
              <option value="">不选择 Pack</option>
              {facts.packs.filter((pack) => pack.availability === "AVAILABLE").map((pack) =>
                <option key={`${pack.id}:${pack.version}`} value={JSON.stringify({ id: pack.id,
                  version: pack.version })}>{pack.title} v{pack.version}</option>)}
              {form.packRef && activePack?.availability !== "AVAILABLE" &&
                <option value={JSON.stringify(form.packRef)} disabled>历史 Pack 已不可用</option>}
            </select></label>
          <p className="helper-text">Pack 仅登记确切版本来源；不授予 Permission，也不自动执行 Skill。</p>
          <div className="form-actions"><button className="primary-button" type="submit" data-testid="blueprint-preview"
            disabled={busy || generationBusy || pending !== null || writeBlockedReason !== null}>{busy ? "正在提交" : proposal?.status === "PENDING" ? "生成替代候选并预览" : "生成候选并预览"}</button>
            {dirty && <button className="text-button" type="button" onClick={resetDraft}>放弃草稿修改</button>}</div>
        </fieldset>
      </form>
      {proposal?.contentAvailability === "AVAILABLE" && proposal.baseline && proposal.diff ? <>
        <section className="surface-panel live-blueprint-preview" aria-label="服务端蓝图候选">
          <h2>服务端候选与 Diff</h2>
          <p>候选 {proposal.id} · {statusLabel(proposal.status)}{proposal.stale && " · 基线已失效"}</p>
          <p className="helper-text">来源：{proposal.origin === "USER_DRAFT" ? "人工草稿 USER_DRAFT" : "Skill 提案"}
            {proposal.source.pack ? ` · Pack ${proposal.source.pack.id} v${proposal.source.pack.version} · SHA-256 ${proposal.source.pack.sha256}` : " · 未选择 Pack"}</p>
          {proposal.skillMessageId && <p className="helper-text">来源 Assist 消息：{proposal.skillMessageId}</p>}
          {proposal.source.skill && <p className="helper-text">Skill {proposal.source.skill.id} v{proposal.source.skill.version} ·
            定义 SHA-256 <code>{proposal.source.skill.sha256}</code> ·
            输出 SHA-256 <code>{proposal.source.skillOutputSha256}</code> ·
            事实 SHA-256 <code>{proposal.source.basisFactsSha256}</code></p>}
          <p className="helper-text">候选 SHA-256：<code>{proposal.candidateSha256}</code></p>
          <p className="helper-text">基线：Project v{proposal.baseline.projectRevision} / State v{proposal.baseline.stateRevision}
            / View v{proposal.baseline.viewRevision}。当前事实变化后须重新生成候选。</p>
          {proposal.supersedesProposalId && <p className="helper-text">替代旧候选：{proposal.supersedesProposalId}</p>}
          {dirty && <p className="warning-callout">草稿已修改，当前预览仍是服务端保存的旧候选；请生成新候选后再应用。</p>}
          {proposal.stale && <p className="warning-callout">服务端判定候选已失效。保留草稿，按当前事实重新生成候选。</p>}
          <div className="blueprint-diff" aria-label="当前基线与建议差异">
            <div className="diff-heading"><span aria-hidden="true" /><strong>候选基线</strong><strong>候选建议</strong></div>
            <div className="diff-row"><span>Goal 关联</span><span>{proposal.diff.goalLink.beforeGoalIds.join("、") || "无"}</span>
              <span>{proposal.diff.goalLink.addGoalId ?? "不新增关联"}</span></div>
            <div className="diff-row"><span>项目阶段</span><span>{phaseLabel(proposal.diff.state.phase.before ?? proposal.baseline.phaseKey)}</span>
              <span>{proposal.diff.state.phase.after ? phaseLabel(proposal.diff.state.phase.after) : "保持当前"}</span></div>
            <div className="diff-row"><span>下一步</span><span>{proposal.diff.state.nextAction.beforeTaskId ?? "未指定"}</span>
              <span>{nextActionText(proposal.diff.state.nextAction.after)}</span></div>
            <div className="diff-row"><span>默认工作台</span><span>{kindLabel(proposal.diff.viewConfiguration.before.kind)}</span>
              <span>{kindLabel(proposal.diff.viewConfiguration.after.kind)}
                {proposal.diff.viewConfiguration.changed ? "（将变更）" : "（保持）"}</span></div>
          </div>
          <h3>本次新增任务</h3>
          {proposal.diff.newTasks.length ? <ul className="live-blueprint-list">{proposal.diff.newTasks.map((task) =>
            <li key={task.local_key}><strong>{task.title}</strong><small>{task.objective}</small>
              <small>{task.local_key} · {task.mode} / {task.executorKind} / {task.status}</small></li>)}</ul> :
            <p>候选不新增任务。</p>}
          <h3>服务端视图模板</h3>
          <p>基线：{templatePages(proposal.diff.viewConfiguration.before)}</p>
          <p>建议：{templatePages(proposal.diff.viewConfiguration.after)}</p>
          <p className="helper-text">建议模板 v{proposal.diff.viewConfiguration.after.templateVersion} · SHA-256 <code>{proposal.diff.viewConfiguration.after.templateSha256}</code></p>
        </section>
        <section className="surface-panel live-blueprint-followups"><h2>后续配置建议</h2>
          <p className="helper-text">以下来自服务端候选，需在各自入口单独确认，不随本次蓝图应用。</p>
          {proposal.followUpSuggestions.length ? <ul className="live-blueprint-list">
            {proposal.followUpSuggestions.map((item, index) => <li key={`${item.kind}:${index}`}>
              <strong>{item.kind}</strong><small>{item.summary}</small></li>)}</ul> : <p>没有后续配置建议。</p>}
        </section>
      </> : proposal ? <section className="surface-panel live-blueprint-preview" data-testid="blueprint-source-unavailable">
        <h2>服务端候选暂不可读</h2>
        <p>候选 {proposal.id} · {statusLabel(proposal.status)}。来源不可用；候选正文、基线与 Diff 已清除，不能应用。</p>
        <p className="helper-text">候选 SHA-256：<code>{proposal.candidateSha256}</code></p>
        {proposal.source.skillOutputSha256 && <p className="helper-text">来源输出 SHA-256：
          <code>{proposal.source.skillOutputSha256}</code></p>}
      </section> : <section className="surface-panel live-blueprint-preview"><h2>服务端候选预览</h2>
        <p>当前项目没有可读取的蓝图候选。提交上方人工草稿后，才会显示服务端基线、Diff 与候选摘要。</p></section>}
    </div>
    <ResponsiveRail label="查看蓝图确认区" title="蓝图确认"><div className="rail-content">
      <h2>确认这次变化</h2>
      {proposal ? <><p className="rail-intro">{statusLabel(proposal.status)} · {proposal.origin === "USER_DRAFT" ? "人工草稿" : "Skill 来源"}</p>
        <p className="helper-text">应用绑定候选 ID、SHA-256 与 Project/State/View 三项基线修订。</p>
        <button className="primary-button primary-button--wide" type="button" data-testid="live-blueprint-apply"
          disabled={!eligibleApply} onClick={() => void send({ action: "apply", id: createCommandId(),
            conflict: false, proposalId: proposal.id, candidateSha256: proposal.candidateSha256,
            expectedProjectRevision: proposal.baseline?.projectRevision ?? "",
            expectedStateRevision: proposal.baseline?.stateRevision ?? "",
            expectedViewRevision: proposal.baseline?.viewRevision ?? "" })}>应用这份候选</button>
        <button className="secondary-button secondary-button--wide" type="button" data-testid="live-blueprint-reject"
          disabled={proposal.status !== "PENDING" || proposal.contentAvailability !== "AVAILABLE" ||
            dirty || pending !== null || busy || generationBusy || writeBlockedReason !== null}
          onClick={() => void send({ action: "reject", id: createCommandId(), conflict: false,
            proposalId: proposal.id, candidateSha256: proposal.candidateSha256 })}>暂不采用</button>
        {!eligibleApply && <p className="disabled-reason">{proposal.contentAvailability !== "AVAILABLE" ?
          "来源不可用，候选正文已隐藏，不能应用。" : proposal.status !== "PENDING" ?
          `候选${statusLabel(proposal.status)}，不可再次应用。` : proposal.stale ?
            "服务端已判定基线失效，需重建候选。" : dirty ?
              "草稿已修改，先生成新候选。" : pending ? "原命令仍待核对。" : "正在核对。"}</p>}
      </> : <p className="rail-intro">先生成服务端候选，才能应用或暂不采用。</p>}
      {pending && <div className="warning-callout" data-testid="blueprint-pending">
        <strong>{pending.conflict ? "冲突待核对" : "提交结果待核对"}</strong>
        <p>原 command_id：{pending.id} · {commandType(pending)}。原载荷已冻结，核对前不提交其他蓝图命令。</p>
        <button className="secondary-button" type="button" disabled={busy}
          onClick={() => void checkReceipt(pending, client, scope.current)}>查询原命令回执</button>
        {mayRetry && !pending.conflict && <button className="secondary-button" type="button" disabled={busy}
          onClick={() => void send(pending, true)}>用原 ID 和载荷重试</button>}
        {pending.conflict && <button className="secondary-button" type="button" disabled={busy || loading}
          onClick={() => { freeze(null); setError(null);
            setMessage("原命令无回执；已保留草稿，请按最新事实重新生成或核对候选。"); }}>
          按最新事实重新确认</button>}
      </div>}
      {result && <section className="rail-section"><h3>已应用的实际效果</h3>
        <p>Project v{result.projectRevision} · State v{result.stateRevision} · View v{result.viewRevision}</p>
        <p>Goal 关联：{result.appliedEffects.goalLinked ? "新增" : "未新增"}；新任务：{result.appliedEffects.tasksCreated}；
          State：{result.appliedEffects.stateChanged ? "已变更" : "未变更"}；View：{result.appliedEffects.viewChanged ? "已变更" : "未变更"}。</p>
        {result.taskIdMap.length > 0 && <ul className="live-blueprint-list">{result.taskIdMap.map((task) =>
          <li key={task.localKey}><Link to={`/tasks/${task.taskId}`}>{task.localKey} · {task.taskId}</Link>
            <small>{task.status} · v{task.revision}</small></li>)}</ul>}
        {result.nextActionTaskId && <p>下一步：<Link to={`/tasks/${result.nextActionTaskId}`}>{result.nextActionTaskId}</Link></p>}
        <p className="helper-text">服务端实际视图：{templatePages(result.viewConfiguration)}</p>
      </section>}
      <section className="rail-section"><h3>最近候选</h3>
        <p className="helper-text">服务端最多返回最近 30 条；以下不是完整历史。</p>
        {facts.proposals.length ? <ul className="live-blueprint-history">{facts.proposals.map((item) =>
          <li key={item.id}><button className="text-button" type="button" disabled={busy || generationBusy || pending !== null || dirty}
            aria-current={item.id === proposal?.id ? "true" : undefined}
            onClick={() => void load(client, scope.current, item.id, false)}>
            {statusLabel(item.status)} · {item.id.slice(0, 8)} · {item.origin === "USER_DRAFT" ? "人工" : "Skill"}</button></li>)}</ul> :
          <p>尚无候选。</p>}
      </section>
      <Link className="secondary-button secondary-button--wide" to={`/projects/${id}`}>返回项目页</Link>
    </div></ResponsiveRail>
  </div></section>;
}
