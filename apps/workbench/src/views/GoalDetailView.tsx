import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight, Info, Link2, RotateCcw, Target, TriangleAlert } from "lucide-react";
import PageHeader from "../components/PageHeader";
import ResponsiveRail from "../components/ResponsiveRail";
import GoalProjectLinkPanel from "./GoalProjectLinkPanel";
import type { RelayApiClient, RelayCommandEnvelope, RelayGoalProject,
  RelayGoalRecord, RelayGoalWorkContext, RelayProject, RelayProjectState,
  RelayTaskSummary, RelayWorkContextSession } from "../api/relayClient";
import { createCommandId, goalArchiveResultFrom, goalEditResultFrom,
  projectGoalUnlinkResultFrom, RelayApiError, RelayTransportError } from "../api/relayClient";
import { RelayContractError } from "../api/core/errors";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { clearPendingCommand, hasDurablePendingCommand, readPendingCommand, reservePendingCommand } from "../lib/pendingCommandStorage";
import { goalStatusLabels, phaseLabel, projectTypeLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";

/**
 * 正式 Goal 详情：Goal 自身事实、关联 Project、解除影响清单与只读工作上下文。
 *
 * 边界：
 * - 编辑/归档/解除都是独立命令，冻结 command_id 与载荷，按 revision CAS，不自动重发。
 * - 解除前必须先读取并展示受影响的显式对齐 Task；清单变化时服务端拒绝，界面重读后再次确认。
 * - 归档保留原 Goal、关联与历史；归档后不能编辑，也不能新增关联，但既有关系仍可解除。
 * - 工作上下文只读：不创建/重绑 Session，不授予文件、工具或执行权限。
 */

type GoalCommand =
  | { readonly kind: "edit"; readonly commandId: string; readonly goalId: string;
      readonly expectedRevision: string; readonly title: string; readonly description: string }
  | { readonly kind: "archive"; readonly commandId: string; readonly goalId: string;
      readonly expectedRevision: string }
  | { readonly kind: "unlink"; readonly commandId: string; readonly goalId: string;
      readonly projectId: string; readonly expectedRevision: string;
      readonly expectedImpactedTaskIds: readonly string[] };

interface ProjectProgress {
  readonly project: RelayProject | null;
  readonly state: RelayProjectState | null;
  readonly tasks: readonly RelayTaskSummary[];
  readonly nextActionTitle: string | null;
  readonly readError: string | null;
}

interface Facts {
  readonly goal: RelayGoalRecord;
  readonly projects: readonly RelayGoalProject[];
  readonly workContext: RelayGoalWorkContext | null;
  readonly workContextError: string | null;
  readonly progress: readonly ProjectProgress[];
}

function pendingKey(client: RelayApiClient, goalId: string): string {
  return `relay:goal-detail-pending:${client.baseUrl}:${client.workspaceId}:${goalId}`;
}

function parsePending(value: unknown, goalId: string): GoalCommand | null {
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (typeof row.kind !== "string" || typeof row.commandId !== "string" ||
      typeof row.goalId !== "string" || row.goalId !== goalId || typeof row.expectedRevision !== "string") return null;
    if (row.kind === "edit" && typeof row.title === "string" && typeof row.description === "string") {
      return { kind: "edit", commandId: row.commandId, goalId: row.goalId,
        expectedRevision: row.expectedRevision, title: row.title, description: row.description };
    }
    if (row.kind === "archive") {
      return { kind: "archive", commandId: row.commandId, goalId: row.goalId,
        expectedRevision: row.expectedRevision };
    }
    if (row.kind === "unlink" && typeof row.projectId === "string" &&
      Array.isArray(row.expectedImpactedTaskIds) &&
      row.expectedImpactedTaskIds.every((id) => typeof id === "string")) {
      return { kind: "unlink", commandId: row.commandId, goalId: row.goalId,
        projectId: row.projectId, expectedRevision: row.expectedRevision,
        expectedImpactedTaskIds: row.expectedImpactedTaskIds as string[] };
    }
    return null;
}

function isUncertain(caught: unknown): boolean {
  return caught instanceof RelayContractError || caught instanceof RelayTransportError ||
    caught instanceof RelayApiError && (caught.problem.status >= 500 ||
      caught.problem.code === "COMMAND_ID_REUSED");
}

function nextRevisionIs(actual: string, expected: string): boolean {
  try { return BigInt(actual) === BigInt(expected) + 1n; } catch { return false; }
}

function commandTypeOf(record: GoalCommand): string {
  return record.kind === "edit" ? "EditGoal"
    : record.kind === "archive" ? "ArchiveGoal" : "UnlinkProjectGoal";
}

/** 2xx 与回执都必须和冻结命令逐项对齐；错配不能被当成成功。 */
class CommandMismatch extends Error {}

function verifyCommand(record: GoalCommand,
  envelope: { readonly commandId: string; readonly result: Readonly<Record<string, unknown>> }): string {
  try {
    if (envelope.commandId !== record.commandId) throw new Error("回执 command_id 与原命令不一致。");
    if (!nextRevisionIs(String(envelope.result.revision ?? ""), record.expectedRevision)) {
      throw new Error(`回执修订 v${String(envelope.result.revision ?? "")} 不是原修订 v${record.expectedRevision} 推进后的下一版。`);
    }
    if (record.kind === "edit") {
      const result = goalEditResultFrom(envelope.result);
      if (result.goalId !== record.goalId || result.status !== "ACTIVE") {
        throw new Error("编辑回执不是原 Goal 的 ACTIVE 修订。");
      }
      // 内容与身份同等重要：响应可能对准了实体和修订，却带着别的编辑内容。
      if (result.title !== record.title) {
        throw new Error(`编辑回执标题「${result.title}」与冻结命令的「${record.title}」不一致。`);
      }
      if (result.description !== record.description) {
        throw new Error(`编辑回执说明与冻结命令不一致（冻结「${record.description}」，回执「${result.description}」）。`);
      }
      return `目标已更新为「${result.title}」· v${result.revision}`;
    }
    if (record.kind === "archive") {
      const result = goalArchiveResultFrom(envelope.result);
      if (result.goalId !== record.goalId) throw new Error("归档回执不是原 Goal。");
      return `目标已归档 · v${result.revision}`;
    }
    const result = projectGoalUnlinkResultFrom(envelope.result);
    if (result.projectId !== record.projectId) throw new Error("解除回执不是原 Project。");
    const expected = [...record.expectedImpactedTaskIds].sort().join(",");
    const actual = result.impactedTasks.map((task) => task.taskId).sort().join(",");
    if (expected !== actual) throw new Error("解除回执的影响 Task 清单与冻结清单不一致。");
    return `已解除与 Project ${record.projectId} 的关联 · Project v${result.revision}`;
  } catch (caught) {
    throw new CommandMismatch(caught instanceof Error ? caught.message : "回执结构无效。");
  }
}

async function sendCommand(client: RelayApiClient, record: GoalCommand): Promise<RelayCommandEnvelope> {
  if (record.kind === "edit") {
    return client.editGoal({ goalId: record.goalId, commandId: record.commandId,
      expectedRevision: record.expectedRevision, title: record.title,
      description: record.description });
  }
  if (record.kind === "archive") {
    return client.archiveGoal({ goalId: record.goalId, commandId: record.commandId,
      expectedRevision: record.expectedRevision });
  }
  return client.unlinkProjectGoal({ projectId: record.projectId, commandId: record.commandId,
    expectedRevision: record.expectedRevision, goalId: record.goalId,
    expectedImpactedTaskIds: record.expectedImpactedTaskIds });
}

async function readProgress(client: RelayApiClient, project: RelayGoalProject): Promise<ProjectProgress> {
  try {
    const [detail, state, page] = await Promise.all([
      client.getProject(project.projectId),
      client.getProjectState(project.projectId),
      client.getProjectTasksPage(project.projectId)
    ]);
    if (detail.id !== project.projectId || state.projectId !== project.projectId) {
      throw new Error("项目进展查询返回了其他项目的事实。");
    }
    let nextActionTitle: string | null = null;
    if (state.nextActionTaskId !== null) {
      const listed = page.items.find((task) => task.id === state.nextActionTaskId);
      if (listed) nextActionTitle = listed.title;
      else {
        const single = await client.getTask(state.nextActionTaskId).catch(() => null);
        nextActionTitle = single?.id === state.nextActionTaskId && single.projectId === project.projectId
          ? single.title : null;
      }
    }
    return { project: detail, state, tasks: page.items, nextActionTitle, readError: null };
  } catch (caught) {
    return { project: null, state: null, tasks: [], nextActionTitle: null,
      readError: describeLiveError(caught).message };
  }
}

async function readFacts(client: RelayApiClient, goalId: string): Promise<Facts> {
  const [goal, projects] = await Promise.all([
    client.getGoalDetail(goalId), client.getGoalProjects(goalId)
  ]);
  if (goal.id !== goalId) throw new Error("Goal 单读返回了其他目标。");
  const work = await client.getGoalWorkContext(goalId, "ALL")
    .then((value): { readonly value: RelayGoalWorkContext | null; readonly error: string | null } =>
      ({ value, error: null }))
    .catch((caught: unknown) => ({ value: null, error: describeLiveError(caught).message }));
  const progress = await Promise.all(projects.map((project) => readProgress(client, project)));
  return { goal, projects, workContext: work.value, workContextError: work.error, progress };
}

export default function GoalDetailView() {
  const { id = "" } = useParams();
  const connection = useRelayConnection();
  return connection.client
    ? <LiveGoalDetail key={`${connection.epoch}:${id}`} id={id} client={connection.client} />
    : <section className="page-state pv-page" data-testid="goal-detail-fixture-gap">
      <p className="eyebrow"><Target aria-hidden="true" />Goal Detail</p>
      <h1>示例模式没有正式 Goal 详情</h1>
      <p>Goal 的编辑、归档与项目关联都需要连接本机 API。示例模式不生成目标事实。</p>
      <Link className="secondary-button" to="/projects">返回项目</Link>
    </section>;
}

function LiveGoalDetail({ id, client }: { id: string; client: RelayApiClient }) {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  /** 服务端最新事实与未保存草稿并存时的差异展示；放弃（还原）或收口后清除。 */
  const [conflictFacts, setConflictFacts] = useState<{ readonly title: string;
    readonly description: string } | null>(null);
  const storageKey = pendingKey(client, id);
  const parseCommand = useCallback((value: unknown) => parsePending(value, id), [id]);
  const [initialPending] = useState(() => readPendingCommand(storageKey, parseCommand));
  const [actionError, setActionError] = useState<string | null>(initialPending.available ? null
    : "本机 Goal 恢复记录不可用或存在冲突；请恢复存储后重新打开，未发送新命令。");
  const [receipt, setReceipt] = useState<string | null>(null);
  const [pending, setPending] = useState<GoalCommand | null>(initialPending.pending);
  const [busy, setBusy] = useState(false);
  const [mayRetry, setMayRetry] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<{ readonly project: RelayGoalProject;
    readonly impactedTaskIds: readonly string[] } | null>(null);
  const [unlinkBusy, setUnlinkBusy] = useState(false);
  const pendingRef = useRef<GoalCommand | null>(pending);
  const busyRef = useRef(false);
  const version = useRef(0);
  const disposed = useRef(false);
  /** 草稿已被用户改过、尚未被命令收口或还原：事实重读不得覆盖输入框。 */
  const draftDirtyRef = useRef(false);
  /** 当前草稿所基于的服务端标题/说明：重读时与它比较才知道服务端是否又变了。 */
  const draftBaselineRef = useRef({ title: "", description: "" });
  const draftValueRef = useRef({ title: "", description: "" });
  const titleInputRef = useRef<HTMLInputElement>(null);
  const descriptionInputRef = useRef<HTMLTextAreaElement>(null);
  const focusedFieldRef = useRef<"title" | "description">("title");

  const setDraft = useCallback((next: { readonly title: string; readonly description: string }) => {
    draftValueRef.current = next;
    setTitle(next.title); setDescription(next.description);
    draftDirtyRef.current = next.title.trim() !== draftBaselineRef.current.title.trim() ||
      next.description.trim() !== draftBaselineRef.current.description.trim();
    if (!draftDirtyRef.current) setConflictFacts(null);
  }, []);

  const consumeDraft = useCallback((next: { readonly title: string; readonly description: string }) => {
    draftBaselineRef.current = next;
    setDraft(next);
    setConflictFacts(null);
  }, [setDraft]);

  const holdPending = useCallback((next: GoalCommand | null): boolean => {
    const saved = next === null ? clearPendingCommand(storageKey, pendingRef.current, parseCommand)
      : reservePendingCommand(storageKey, next, parseCommand);
    if (!saved) return false;
    pendingRef.current = next; setPending(next); return true;
  }, [storageKey, parseCommand]);

  const guard = useRef<DraftGuard>({
    hasUnsavedChanges: () => draftDirtyRef.current || pendingRef.current !== null,
    hasDraftChanges: () => draftDirtyRef.current && pendingRef.current?.kind !== "edit",
    discard: () => consumeDraft(draftBaselineRef.current),
    pendingCommandId: () => pendingRef.current?.commandId ?? null,
    pendingRecoversAfterLeave: () => pendingRef.current !== null &&
      hasDurablePendingCommand(storageKey, pendingRef.current, parseCommand),
    pendingRecoversAfterRestart: () => pendingRef.current !== null &&
      hasDurablePendingCommand(storageKey, pendingRef.current, parseCommand),
    restoreFocus: () => {
      const field = focusedFieldRef.current === "description" ? descriptionInputRef.current : titleInputRef.current;
      if (field && !field.disabled) field.focus();
    }
  });

  useEffect(() => {
    setDraftGuard(guard.current);
    return () => clearDraftGuard(guard.current);
  }, []);

  useEffect(() => () => { disposed.current = true; version.current++; }, []);

  useEffect(() => {
    const request = ++version.current;
    setLoading(true); setError(null);
    void readFacts(client, id)
      .then((next) => {
        if (disposed.current || request !== version.current) return;
        setFacts(next);
        const draft = draftValueRef.current;
        const dirty = draftDirtyRef.current && (draft.title.trim() !== next.goal.title.trim() ||
          draft.description.trim() !== next.goal.description.trim());
        draftBaselineRef.current = { title: next.goal.title, description: next.goal.description };
        if (dirty) {
          draftDirtyRef.current = true;
          // 草稿未收口：服务端新事实只作差异呈现，绝不静默覆盖输入框。
          setConflictFacts({ title: next.goal.title, description: next.goal.description });
        } else {
          draftDirtyRef.current = false;
          setDraft({ title: next.goal.title, description: next.goal.description });
          setConflictFacts(null);
        }
        // 待确认的解除必须跟随重读到的 Project 修订：GOAL_LINK_IN_USE 之后沿旧修订
        // 重发只会再次被 CAS 拒绝（修订已变时陷入冲突循环）。
        setUnlinkTarget((target) => {
          if (target === null) return null;
          const fresh = next.projects.find((item) => item.projectId === target.project.projectId);
          return fresh ? { project: fresh, impactedTaskIds: target.impactedTaskIds } : target;
        });
      })
      .catch((caught: unknown) => {
        if (!disposed.current && request === version.current) {
          setFacts(null);
          setError(describeLiveError(caught).message);
        }
      })
      .finally(() => {
        if (!disposed.current && request === version.current) setLoading(false);
      });
    return () => { version.current++; };
  }, [client, id, reload, setDraft]);

  const reloadFacts = useCallback(() => setReload((value) => value + 1), []);

  const checkReceipt = useCallback(async (record: GoalCommand) => {
    setBusy(true); setActionError(null); setMayRetry(false);
    try {
      const response = await client.getCommandReceipt(record.commandId);
      if (disposed.current) return;
      if (response.commandType !== commandTypeOf(record)) {
        throw new Error("原回执不是本次命令。");
      }
      const message = verifyCommand(record, response);
      if (!holdPending(null)) { setActionError("命令已确认，但本机恢复记录未能清理；请恢复存储并查询原回执。"); return; }
      setReceipt(message);
      // 只有编辑命令本身收口才消费草稿；归档/解除的刷新与草稿无关，不得覆盖未保存内容。
      if (record.kind === "edit") consumeDraft({ title: record.title, description: record.description });
      reloadFacts();
    } catch (caught) {
      if (disposed.current) return;
      if (caught instanceof CommandMismatch) {
        setActionError(`回执与冻结命令不匹配：${caught.message}已保留原 command_id。`);
      } else if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetry(true);
        setActionError("服务端明确未找到原命令；只能用原 command ID 与原载荷重试。");
      } else setActionError(`回执仍不可核对；请保留原 command_id。${describeLiveError(caught).message}`);
    } finally { if (!disposed.current) setBusy(false); }
  }, [client, consumeDraft, holdPending, reloadFacts]);

  const send = useCallback(async (record: GoalCommand) => {
    if (!reservePendingCommand(storageKey, record, parseCommand)) {
      setBusy(false); setActionError("无法保存或核对原命令，本次请求未发送；请恢复存储后核对回执。"); return;
    }
    setBusy(true); setActionError(null); setReceipt(null); setMayRetry(false);
    try {
      const envelope = await sendCommand(client, record);
      if (disposed.current) return;
      const message = verifyCommand(record, envelope);
      if (!holdPending(null)) { setActionError("命令已确认，但本机恢复记录未能清理；请恢复存储并查询原回执。"); return; }
      setReceipt(message); setConfirmArchive(false);
      setUnlinkTarget(null);
      if (record.kind === "edit") consumeDraft({ title: record.title, description: record.description });
      reloadFacts();
    } catch (caught) {
      if (disposed.current) return;
      if (caught instanceof CommandMismatch) {
        setActionError(`响应与冻结命令不匹配：${caught.message}已保留原 command_id，不宣布成功。`);
      } else if (isUncertain(caught)) {
        setActionError("命令结果尚不能确认。已保留原 command_id；先查询回执，明确未找到后才可原样重试。");
      } else {
        if (!holdPending(null)) { setActionError("命令已被拒绝，但本机恢复记录未能清理；请恢复存储并核对原命令。"); return; }
        if (caught instanceof RelayApiError && caught.problem.code === "REVISION_CONFLICT") {
          setActionError(`修订已变化${caught.problem.actualRevision ? `（当前 v${caught.problem.actualRevision}）` : ""}；已重新读取，请按新事实再次确认。草稿未被覆盖。`);
          reloadFacts();
        } else if (caught instanceof RelayApiError && caught.problem.code === "GOAL_LINK_IN_USE") {
          const current = caught.problem.impactedTaskIds ?? [];
          setActionError(`受影响 Task 清单已变化（当前 ${current.length} 项）；已重新读取，请再次确认解除，不静默清理其他 Task。`);
          setUnlinkTarget((target) => target === null ? null
            : { project: target.project, impactedTaskIds: current });
          reloadFacts();
        } else if (caught instanceof RelayApiError && (caught.problem.status === 401 ||
          caught.problem.status === 403 || caught.problem.status === 404)) {
          setActionError(`当前对象已不可写：${describeLiveError(caught).message}`);
          reloadFacts();
        } else setActionError(describeLiveError(caught).message);
      }
    } finally { if (!disposed.current) setBusy(false); }
  }, [client, consumeDraft, holdPending, parseCommand, reloadFacts, storageKey]);

  const startCommand = useCallback((record: GoalCommand) => {
    if (pendingRef.current !== null) {
      setActionError("已有待核对的 Goal 命令；核对回执或原样重试收口前，不会发出第二条命令。");
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    if (!holdPending(record)) {
      busyRef.current = false;
      setActionError("无法保存或核对本机 Goal 恢复记录，未发送命令；请恢复存储后重试。");
      return;
    }
    void send(record).finally(() => { busyRef.current = false; });
  }, [holdPending, send]);

  async function prepareUnlink(project: RelayGoalProject) {
    if (pendingRef.current !== null || unlinkBusy || busy) {
      setActionError("待核对命令收口前不能开始新的解除；请先查询回执或原样重试。");
      return;
    }
    setUnlinkBusy(true); setActionError(null); setReceipt(null); setConfirmArchive(false);
    try {
      const links = await client.getProjectGoalLinks(project.projectId);
      if (disposed.current) return;
      const link = links.find((item) => item.goalId === id);
      if (link === undefined) {
        setActionError("该 Project 当前没有与这个 Goal 的关联；已重新读取目标。");
        reloadFacts(); return;
      }
      setUnlinkTarget({ project, impactedTaskIds: link.explicitTaskIds });
    } catch (caught) {
      if (!disposed.current) setActionError(`解除前的影响读取失败：${describeLiveError(caught).message}`);
    } finally { if (!disposed.current) setUnlinkBusy(false); }
  }

  function confirmUnlink() {
    if (unlinkTarget === null) return;
    startCommand({ kind: "unlink", commandId: createCommandId(), goalId: id,
      projectId: unlinkTarget.project.projectId,
      expectedRevision: unlinkTarget.project.projectRevision,
      expectedImpactedTaskIds: unlinkTarget.impactedTaskIds });
  }

  function submitEdit() {
    if (facts === null || facts.goal.status !== "ACTIVE" || pendingRef.current !== null) return;
    const nextTitle = title.trim();
    if (nextTitle === "") { setActionError("目标标题不能为空。"); return; }
    if (nextTitle === facts.goal.title && description.trim() === facts.goal.description) {
      setActionError("标题与说明没有变化，未提交编辑命令。");
      return;
    }
    startCommand({ kind: "edit", commandId: createCommandId(), goalId: id,
      expectedRevision: facts.goal.revision, title: nextTitle, description: description.trim() });
  }

  function submitArchive() {
    if (facts === null || pendingRef.current !== null) return;
    startCommand({ kind: "archive", commandId: createCommandId(), goalId: id,
      expectedRevision: facts.goal.revision });
  }

  if (loading) return <section className="page-state pv-page" role="status">
    <p className="eyebrow">Goal Detail</p><h1>正在读取目标事实</h1>
    <p>只读查询 Goal、关联 Project 与工作上下文，不会创建或重绑会话。</p></section>;
  if (error || facts === null) return <section className="page-state page-state--error pv-page" role="alert">
    <p className="eyebrow">Goal Detail</p><h1>暂时无法读取目标</h1>
    <p>{error ?? "目标事实不可用。"}</p>
    {receipt && <p className="receipt-message" role="status" data-testid="goal-detail-receipt">{receipt}</p>}
    {actionError && <p className="action-error" role="alert" data-testid="goal-detail-error">{actionError}</p>}
    {pending && <div className="warning-callout" data-testid="goal-detail-pending">
      <strong>Goal 命令待核对</strong>
      <p>原 command ID：{pending.commandId} · 类型 {commandTypeOf(pending)} · 基于 v{pending.expectedRevision}。核对前不会发出第二条命令。</p>
      <div className="form-actions">
        <button className="secondary-button" type="button" data-testid="goal-detail-check-receipt"
          disabled={busy} onClick={() => void checkReceipt(pending)}>查询原命令回执</button>
        {mayRetry && <button className="secondary-button" type="button" data-testid="goal-detail-retry"
          disabled={busy} onClick={() => { setBusy(true); void send(pending); }}>用原 ID 与原载荷重试</button>}
      </div>
    </div>}
    {draftDirtyRef.current && <section className="resume-section" data-testid="goal-edit-local-draft">
      <h2>本地草稿（只读）</h2>
      <p className="warning-callout">当前 Goal 事实不可读，已撤下先前事实；下面只保留本页未提交文本，不代表服务端当前状态，也不能提交。</p>
      <label className="field"><span className="field-label">标题草稿</span>
        <input value={title} disabled readOnly data-testid="goal-edit-local-title" /></label>
      <label className="field"><span className="field-label">说明草稿</span>
        <textarea value={description} disabled readOnly data-testid="goal-edit-local-description" /></label>
      <button className="secondary-button" type="button" onClick={() => {
        draftBaselineRef.current = { title: "", description: "" };
        setDraft({ title: "", description: "" }); setConflictFacts(null);
      }}>丢弃本地草稿</button>
    </section>}
    <button className="secondary-button" type="button" onClick={reloadFacts}>
      <RotateCcw aria-hidden="true" />重新读取</button>
  </section>;

  const { goal, projects, workContext, workContextError, progress } = facts;
  const archived = goal.status !== "ACTIVE";
  const readProjects = progress.filter((item) => item.project !== null).length;
  const failedProjects = progress.length - readProjects;
  const coverage = failedProjects === 0 ? "全部已读取"
    : readProjects === 0 ? "全部读取失败" : "部分已读取";
  const goalPending = pending !== null;
  const sessionsByProject = new Map<string, readonly RelayWorkContextSession[]>();
  if (workContext !== null) {
    for (const session of workContext.sessions) {
      const list = sessionsByProject.get(session.projectId) ?? [];
      sessionsByProject.set(session.projectId, [...list, session]);
    }
  }

  return <section className="skill-page project-overview pv-page" data-testid="goal-detail-live">
    <div className="page-layout"><div className="page-primary">
      <p className="metadata-row"><Link className="inline-link" to="/goals">← 全部目标</Link></p>
      <PageHeader testId="goal-detail-head" title={goal.title} overline="Goal Detail"
        meta={`Goal v${goal.revision} · 创建于 ${new Date(goal.createdAt).toLocaleString("zh-CN")}`}
        status={<span className={`status-chip ${archived ? "status-chip--neutral" : "status-chip--success"}`}>
          {goalStatusLabels[goal.status] ?? goal.status}</span>}
        lede={goal.description || "这个目标还没有说明。"}
        actions={<Link className="secondary-button" to="/goals">目标列表</Link>} />
      {archived && <p className="warning-callout" role="status" data-testid="goal-detail-archived-note">
        <Info aria-hidden="true" />目标已归档：只能阅读历史，不能再编辑或新增关联；既有项目关系仍可按原命令解除。
      </p>}
      {receipt && <p className="receipt-message" role="status" data-testid="goal-detail-receipt">{receipt}</p>}
      {actionError && <p className="action-error" role="alert" data-testid="goal-detail-error">{actionError}</p>}
      {goalPending && <div className="warning-callout" data-testid="goal-detail-pending">
        <strong>Goal 命令待核对</strong>
        <p>原 command ID：{pending.commandId} · 类型 {commandTypeOf(pending)} · 基于 v{pending.expectedRevision}。核对前不会发出第二条命令。</p>
        <div className="form-actions">
          <button className="secondary-button" type="button" data-testid="goal-detail-check-receipt"
            disabled={busy} onClick={() => void checkReceipt(pending)}>查询原命令回执</button>
          {mayRetry && <button className="secondary-button" type="button" data-testid="goal-detail-retry"
            disabled={busy} onClick={() => { setBusy(true); void send(pending); }}>用原 ID 与原载荷重试</button>}
        </div>
      </div>}

      {(!archived || draftDirtyRef.current) && <section className="resume-section" data-testid="goal-edit-section">
        <h2>编辑目标</h2>
        <p className="helper-text">只修改 Goal 自身的标题与说明；新建关联、Task 对齐和项目状态都不在这里改变。
          清空说明会提交空字符串，不是省略字段。</p>
        {archived && <p className="warning-callout" role="status">目标已归档；本地草稿保留为只读文本，不能提交。</p>}
        <form className="stack" onSubmit={(event) => { event.preventDefault(); submitEdit(); }}>
          <label className="field"><span className="field-label">标题</span>
            <input ref={titleInputRef} name="goal-detail-title" data-testid="goal-edit-title" maxLength={200}
              value={title} disabled={busy || goalPending || archived}
              onFocus={() => { focusedFieldRef.current = "title"; }}
              onChange={(event) => setDraft({ ...draftValueRef.current, title: event.target.value })} /></label>
          <label className="field"><span className="field-label">说明</span>
            <textarea ref={descriptionInputRef} name="goal-detail-description" data-testid="goal-edit-description"
              rows={4} maxLength={2000} value={description} disabled={busy || goalPending || archived}
              onFocus={() => { focusedFieldRef.current = "description"; }}
              onChange={(event) => setDraft({ ...draftValueRef.current, description: event.target.value })} /></label>
          {conflictFacts !== null && <div className="warning-callout" role="status"
            data-testid="goal-edit-conflict-facts">
            <strong>服务端最新事实与本地草稿不同</strong>
            <p>服务端当前标题「{conflictFacts.title}」· 说明「{conflictFacts.description || "（空）"}」。
              你的草稿已完整保留；核对差异后可再次保存（将按当前修订 v{goal.revision} 提交），
              或用「还原为当前事实」放弃草稿。</p>
          </div>}
          <div className="form-actions">
            <button className="primary-button" type="submit" data-testid="goal-edit-submit"
              disabled={busy || goalPending || archived}>{busy ? "正在保存" : "保存目标修订"}</button>
            <button className="secondary-button" type="button" data-testid="goal-edit-reset"
              disabled={busy || goalPending}
              onClick={() => { consumeDraft({ title: goal.title, description: goal.description }); setActionError(null); }}>
              {archived ? "丢弃本地草稿" : "还原为当前事实"}</button>
          </div>
        </form>
      </section>}

      {!archived && <section className="resume-section" data-testid="goal-archive-section">
        <h2>归档目标</h2>
        <p className="helper-text">归档保留 Goal ID、项目关联、Task 显式对齐与会话历史；只停止编辑和新增关联。</p>
        {!confirmArchive ? <button className="secondary-button" type="button" data-testid="goal-archive-open"
          disabled={busy || goalPending} onClick={() => setConfirmArchive(true)}>归档这个目标</button>
          : <div className="warning-callout" data-testid="goal-archive-confirm">
            <strong>确认归档？</strong>
            <p>归档后可读原关系与历史，但不能恢复为 ACTIVE，也不能再新增关联。</p>
            <div className="form-actions">
              <button className="primary-button" type="button" data-testid="goal-archive-submit"
                disabled={busy || goalPending} onClick={submitArchive}>确认归档</button>
              <button className="secondary-button" type="button" data-testid="goal-archive-cancel"
                disabled={busy} onClick={() => setConfirmArchive(false)}>取消</button>
            </div>
          </div>}
      </section>}

      <section className="resume-section" data-testid="goal-projects-section">
        <h2>关联项目</h2>
        {projects.length === 0 ? <p className="helper-text">这个目标还没有关联任何项目；空关联不代表目标无效。</p>
          : <ul className="run-list">{projects.map((project) => <li key={project.projectId}
            data-testid={`goal-project-${project.projectId}`}>
            <Link className="inline-link" to={`/projects/${project.projectId}`}><strong>{project.title}</strong></Link>
            {" "}· {projectTypeLabels[project.projectType as keyof typeof projectTypeLabels] ?? project.projectType}
            {" "}· {project.archiveStatus === "ARCHIVED" ? "已归档项目" : "进行中"} · Project v{project.projectRevision}
            <small>关联于 {new Date(project.linkedAt).toLocaleString("zh-CN")}</small>
            <div className="form-actions">
              <button className="text-button" type="button" data-testid={`goal-unlink-open-${project.projectId}`}
                disabled={busy || unlinkBusy || goalPending} onClick={() => void prepareUnlink(project)}>
                解除关联并查看影响</button>
            </div>
            {unlinkTarget?.project.projectId === project.projectId && <div className="warning-callout"
              data-testid={`goal-unlink-confirm-${project.projectId}`}>
              <strong>解除前的影响清单</strong>
              <p>预期影响 {unlinkTarget.impactedTaskIds.length} 个显式对齐该 Goal 的 Task；解除会在同一命令中清理这些对齐并递增 Task revision。
                如果服务端当前清单已变化，操作会被拒绝并要求再次确认。</p>
              {unlinkTarget.impactedTaskIds.length > 0 && <ul>
                {unlinkTarget.impactedTaskIds.map((taskId) => <li key={taskId}>
                  <Link className="inline-link" to={`/tasks/${taskId}`}>Task {taskId}</Link></li>)}
              </ul>}
              {unlinkTarget.impactedTaskIds.length === 0 && <p className="helper-text">当前没有 Task 显式对齐这个 Goal。</p>}
              <div className="form-actions">
                <button className="primary-button" type="button" data-testid={`goal-unlink-submit-${project.projectId}`}
                  disabled={busy || goalPending} onClick={confirmUnlink}>确认解除</button>
                <button className="secondary-button" type="button" data-testid={`goal-unlink-cancel-${project.projectId}`}
                  disabled={busy} onClick={() => setUnlinkTarget(null)}>取消</button>
              </div>
            </div>}
          </li>)}</ul>}
      </section>

      {!archived && <GoalProjectLinkPanel client={client} goalId={goal.id} goalTitle={goal.title}
        onLinked={() => reloadFacts()} />}

      <section className="resume-section" data-testid="goal-progress-section">
        <h2>关联项目进展</h2>
        <p className="helper-text" data-testid="goal-progress-coverage">
          覆盖范围：{coverage}（{readProjects}/{progress.length} 个关联项目）。
          {failedProjects > 0 ? "失败项目不计入任何阶段、下一步或完成结论。" : "以下事实均来自各项目当前 State 与任务首分页。"}
        </p>
        {progress.length === 0 ? <p className="helper-text">没有关联项目，因此没有可汇总的项目进展。</p>
          : <ul className="run-list">{progress.map((item, index) => {
            const linked = projects[index];
            const title = item.project?.title ?? linked?.title ?? "项目事实暂不可读";
            if (item.readError !== null || item.project === null || item.state === null) {
              return <li key={item.project?.id ?? `failed-${index}`} data-testid="goal-progress-failed">
                <strong>{title}</strong><p className="action-error">进展读取失败：{item.readError ?? "项目或 State 不可用"}；不以其他项目代替。</p></li>;
            }
            const detail = item.project;
            const state = item.state;
            const activeBlockers = state.blockers.filter((blocker) => blocker.resolvedAt === null);
            const risks = state.risks;
            return <li key={detail.id} data-testid={`goal-progress-${detail.id}`}>
              <strong>{detail.title}</strong> · {phaseLabel(state.phaseKey)} · State v{state.revision}
              <p>下一步：{state.nextActionTaskId === null ? "尚未指定"
                : item.nextActionTitle !== null ? item.nextActionTitle
                  : `State 引用 Task ${state.nextActionTaskId}，标题本次未读到`}</p>
              <p className="helper-text">当前项目任务首分页 {item.tasks.length} 项；其中进行中 {item.tasks.filter((task) => task.status === "IN_PROGRESS").length} 项。
                其余页面未读取，不能当作全部任务。</p>
              <p className="helper-text">State 当前完成引用 {state.completedHighlightRefs.length} 项；
                未解除阻塞 {activeBlockers.length} 项；已确认风险 {risks.length} 项。</p>
              <Link className="inline-link" to={`/projects/${detail.id}`}>打开项目总览</Link></li>;
          })}</ul>}
      </section>

      <section className="resume-section" data-testid="goal-work-context-section">
        <h2>工作上下文</h2>
        <p className="helper-text">只读汇集关联项目的普通会话与受管目录；不创建、不重绑会话，也不授予文件或执行权限。</p>
        {workContextError !== null ? <p className="warning-callout" role="alert">
          工作上下文本次读取失败：{workContextError}；下面不推断任何会话或目录。</p>
          : workContext === null ? null : <>
            {workContext.projects.length === 0 ? <p className="helper-text">没有可汇集的项目目录。</p>
              : <ul className="run-list">{workContext.projects.map((project) => <li key={project.id}
                data-testid={`goal-context-project-${project.id}`}>
                <strong>{project.title}</strong>{project.archiveStatus === "ARCHIVED" ? " · 已归档项目" : ""}
                <div>{project.directories.length === 0
                  ? <small>没有受管目录。</small>
                  : project.directories.map((directory) => <span key={directory.id}>
                    <Link className="inline-link" to={`/working-directories/${directory.id}`}>
                      {directory.canonicalRoot}</Link>
                    {" · "}{directory.status === "ACTIVE" ? "目录可用" : "目录已停用"}{" "}
                  </span>)}</div>
                <div>{sessionsByProject.get(project.id)?.length
                  ? sessionsByProject.get(project.id)!.map((session) => <span key={session.id}>
                    <Link className="inline-link" to={`/agent?session=${encodeURIComponent(session.id)}&project=${encodeURIComponent(session.projectId)}`}
                      data-testid={`goal-context-session-${session.id}`}>{session.title}</Link>
                    {" · "}{goalStatusLabels[session.status] ?? session.status}{" "}
                  </span>)
                  : <small>没有普通会话。</small>}</div>
              </li>)}</ul>}
          </>}
      </section>

      <details className="page-explanation"><summary>事实来源与边界</summary>
        <p className="helper-text">Goal 标题与说明是原位 CAS 修改，不是不可变版本；项目关联来自 project_goals；
          任务显式对齐来自 task_explicit_goals。聊天 /goal 是另一套自主执行目标，不在这里合并。
          归档保留历史引用，但不表示目标已完成。</p>
      </details>
    </div><ResponsiveRail label="查看目标入口与状态" title="目标入口"><div className="rail-content">
      <h2>目标入口</h2>
      <Link className="secondary-button secondary-button--wide" to="/goals">全部目标</Link>
      <Link className="secondary-button secondary-button--wide" to="/projects">全部项目</Link>
      <section className="rail-section"><h3>当前状态</h3>
        <dl className="rail-definition-list">
          <div><dt>状态</dt><dd>{goalStatusLabels[goal.status] ?? goal.status}</dd></div>
          <div><dt>修订</dt><dd>v{goal.revision}</dd></div>
          <div><dt>关联项目</dt><dd>{projects.length} 个</dd></div>
          <div><dt>进展覆盖</dt><dd>{coverage}</dd></div>
        </dl>
        {projects.length > 0 && <p className="helper-text"><Link2 aria-hidden="true" />关系变化会推进 Project revision；解除不会删除项目或历史。</p>}
      </section>
      {archived && <p className="warning-callout"><TriangleAlert aria-hidden="true" />归档目标只读；新增关联会被服务端拒绝。</p>}
      <Link className="text-link" to={`/activity`}>查看动态</Link>
      <p className="helper-text"><ArrowRight aria-hidden="true" />从「全部项目」进入任一项目，可继续查看其 State 与任务。</p>
    </div></ResponsiveRail></div>
  </section>;
}
