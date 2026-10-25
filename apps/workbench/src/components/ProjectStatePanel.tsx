import { useCallback, useEffect, useRef, useState } from "react";
import { Info, RotateCcw } from "lucide-react";
import type { RelayApiClient, RelayProjectState,
  RelayStateCommandInput, RelayTaskSummary } from "../api/relayClient";
import type { RelayProjectGoal } from "../api/blueprintDtos";
import { createCommandId, RelayApiError, RelayTransportError, stateMutationFrom } from "../api/relayClient";
import { RelayContractError } from "../api/core/errors";
import { phaseLabel, phaseOptionsByProjectType, taskStatusLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";

/**
 * Project State 的人工管理入口：阶段、下一步、风险、阻塞与解除。
 *
 * 所有写入都是服务端的类型化 State 命令：
 * - 一次只提交一个 action 与其固定参数，不提交整份 State JSON；
 * - 按 State revision 做 CAS，冲突时重读并要求重新确认；
 * - 冻结 command_id 与载荷，结果不明时先查回执，不换 ID 重发；
 * - 「下一步」只登记 State 引用，不代表 Task 已获得执行资格。
 */

type PendingState = {
  readonly command: RelayStateCommandInput;
};

function pendingKey(client: RelayApiClient, projectId: string): string {
  return `relay:project-state-pending:${client.baseUrl}:${client.workspaceId}:${projectId}`;
}

function readPending(key: string): PendingState | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    const command = row.command as Record<string, unknown> | undefined;
    if (!command || typeof command !== "object" || typeof command.projectId !== "string" ||
      typeof command.commandId !== "string" || typeof command.expectedRevision !== "string" ||
      typeof command.action !== "string") return null;
    return { command: command as unknown as RelayStateCommandInput };
  } catch { return null; }
}

function savePending(key: string, pending: PendingState | null): void {
  try {
    if (pending) sessionStorage.setItem(key, JSON.stringify(pending));
    else sessionStorage.removeItem(key);
  } catch { /* 存储不可用只影响整页重开恢复。 */ }
}

function isUncertain(caught: unknown): boolean {
  return caught instanceof RelayContractError || caught instanceof RelayTransportError ||
    caught instanceof RelayApiError && (caught.problem.status >= 500 ||
      caught.problem.code === "COMMAND_ID_REUSED");
}

class StateCommandMismatch extends Error {}

function verifyStateEnvelope(command: RelayStateCommandInput,
  envelope: { readonly commandId: string; readonly result: Readonly<Record<string, unknown>> }): string {
  if (envelope.commandId !== command.commandId) throw new StateCommandMismatch("回执 command_id 与原命令不一致。");
  const result = stateMutationFrom(envelope.result);
  if (result.projectId !== command.projectId) throw new StateCommandMismatch("回执 Project 与原命令不一致。");
  if (result.action !== command.action) throw new StateCommandMismatch("回执 action 与原命令不一致。");
  let next: bigint;
  try { next = BigInt(command.expectedRevision) + 1n; } catch {
    throw new StateCommandMismatch("原 State revision 不是十进制整数。");
  }
  if (BigInt(result.revision) !== next) {
    throw new StateCommandMismatch(`回执 State 修订 v${result.revision} 不是原修订 v${command.expectedRevision} 推进后的下一版。`);
  }
  return `State 已更新 · ${command.action} · v${result.revision}`;
}

export default function ProjectStatePanel({ client, projectId, projectType, state, tasks,
  goals, archived, onChanged }: {
  readonly client: RelayApiClient;
  readonly projectId: string;
  readonly projectType: string;
  readonly state: RelayProjectState;
  readonly tasks: readonly RelayTaskSummary[];
  readonly goals: readonly RelayProjectGoal[] | null;
  readonly archived: boolean;
  readonly onChanged: () => void;
}) {
  const storageKey = pendingKey(client, projectId);
  const [pending, setPending] = useState<PendingState | null>(() => readPending(storageKey));
  const pendingRef = useRef<PendingState | null>(pending);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [mayRetry, setMayRetry] = useState(false);
  const [phaseKey, setPhaseKey] = useState(state.phaseKey);
  const [nextActionId, setNextActionId] = useState(state.nextActionTaskId ?? "");
  const [riskStatement, setRiskStatement] = useState("");
  const [riskSource, setRiskSource] = useState(`human:workbench:project/${projectId}`);
  const [riskConfirmation, setRiskConfirmation] = useState(`human:workbench:project/${projectId}`);
  const [blockerKind, setBlockerKind] = useState<"PROJECT" | "TASK" | "GOAL">("PROJECT");
  const [blockerTargetId, setBlockerTargetId] = useState(projectId);
  const [blockerReason, setBlockerReason] = useState("");
  const [blockerSource, setBlockerSource] = useState(`human:workbench:project/${projectId}`);
  const [showRiskForm, setShowRiskForm] = useState(false);
  const [showBlockerForm, setShowBlockerForm] = useState(false);
  const stateRevisionRef = useRef(state.revision);

  const holdPending = useCallback((next: PendingState | null) => {
    pendingRef.current = next; setPending(next); savePending(storageKey, next);
  }, [storageKey]);

  useEffect(() => {
    if (stateRevisionRef.current === state.revision) return;
    stateRevisionRef.current = state.revision;
    setPhaseKey(state.phaseKey);
    setNextActionId(state.nextActionTaskId ?? "");
    // 修订变化意味着命令已收口或别人改了 State；表单按新事实重建。
    // 成功回执保留到下一次命令开始（send 会清），避免刚确认的成功在父页重读后消失。
    if (pendingRef.current === null) setError(null);
  }, [state.revision, state.phaseKey, state.nextActionTaskId]);

  useEffect(() => {
    if (blockerKind === "PROJECT") setBlockerTargetId(projectId);
    else if (blockerKind === "TASK") setBlockerTargetId(tasks[0]?.id ?? "");
    else setBlockerTargetId(goals?.[0]?.goalId ?? "");
  }, [blockerKind, projectId, tasks, goals]);

  const checkReceipt = useCallback(async (record: PendingState) => {
    setBusy(true); setError(null); setMayRetry(false);
    try {
      const response = await client.getCommandReceipt(record.command.commandId);
      if (response.commandType !== "SetProjectState") {
        throw new StateCommandMismatch("原回执不是本次 SetProjectState。");
      }
      const message = verifyStateEnvelope(record.command, response);
      holdPending(null); setReceipt(message); onChanged();
    } catch (caught) {
      if (caught instanceof StateCommandMismatch) {
        setError(`回执与冻结命令不匹配：${caught.message}已保留原 command_id。`);
      } else if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetry(true);
        setError("服务端明确未找到原命令；只能用原 command ID 与原载荷重试。");
      } else setError(`回执仍不可核对；请保留原 command_id。${describeLiveError(caught).message}`);
    } finally { setBusy(false); }
  }, [client, holdPending, onChanged]);

  const send = useCallback(async (record: PendingState) => {
    setBusy(true); setError(null); setReceipt(null); setMayRetry(false);
    try {
      const envelope = await client.runProjectStateCommand(record.command);
      const message = verifyStateEnvelope(record.command, envelope);
      holdPending(null); setReceipt(message); onChanged();
    } catch (caught) {
      if (caught instanceof StateCommandMismatch) {
        setError(`响应与冻结命令不匹配：${caught.message}不宣布成功。`);
      } else if (isUncertain(caught)) {
        setError("State 命令结果尚不能确认；已保留原 command_id，先查询回执。");
      } else {
        holdPending(null);
        if (caught instanceof RelayApiError && caught.problem.code === "REVISION_CONFLICT") {
          setError(`State 修订已变化${caught.problem.actualRevision ? `（当前 v${caught.problem.actualRevision}）` : ""}；已重新读取，请按新事实再次确认。`);
          onChanged();
        } else if (caught instanceof RelayApiError && (caught.problem.status === 401 ||
          caught.problem.status === 403 || caught.problem.status === 404)) {
          setError(`Project State 当前不可写：${describeLiveError(caught).message}`);
          onChanged();
        } else setError(describeLiveError(caught).message);
      }
    } finally { setBusy(false); }
  }, [client, holdPending, onChanged]);

  function start(command: RelayStateCommandInput) {
    if (archived) { setError("项目已归档，不能提交新的 State 命令。"); return; }
    if (pendingRef.current !== null) {
      setError("已有待核对的 State 命令；核对回执或原样重试收口前，不会发出第二条命令。");
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    const record = { command };
    holdPending(record);
    void send(record).finally(() => { busyRef.current = false; });
  }

  const phases = phaseOptionsByProjectType[projectType] ?? [];
  const phaseOptions = phases.includes(state.phaseKey) ? phases : [state.phaseKey, ...phases];
  const currentNextActionUnlisted = state.nextActionTaskId !== null &&
    !tasks.some((task) => task.id === state.nextActionTaskId);

  return <section className="resume-section" data-testid="project-state-panel">
    <h2>项目状态</h2>
    <p className="helper-text">这里只发送类型化 State 命令；阶段、下一步、风险与阻塞都由人工确认，
      系统不会按任务数量自动推进。所有写入按 State v{state.revision} 做 CAS。</p>
    {archived && <p className="warning-callout" role="status">项目已归档：State 只读，不能再提交修改。</p>}
    {receipt && <p className="receipt-message" role="status" data-testid="project-state-receipt">{receipt}</p>}
    {error && <p className="action-error" role="alert" data-testid="project-state-error">{error}</p>}
    {pending && <div className="warning-callout" data-testid="project-state-pending">
      <strong>State 命令待核对</strong>
      <p>原 command ID：{pending.command.commandId} · {pending.command.action} · 基于 v{pending.command.expectedRevision}。
        核对前不会发出第二条 State 命令。</p>
      <div className="form-actions">
        <button className="secondary-button" type="button" data-testid="project-state-check-receipt"
          disabled={busy} onClick={() => void checkReceipt(pending)}>查询原命令回执</button>
        {mayRetry && <button className="secondary-button" type="button" data-testid="project-state-retry"
          disabled={busy} onClick={() => { const record = pendingRef.current; if (record) void send(record); }}>
          用原 ID 与原载荷重试</button>}
      </div>
    </div>}

    <div className="field-grid">
      <label className="field"><span className="field-label">当前阶段</span>
        <select name="state-phase" data-testid="state-phase" value={phaseKey}
          disabled={busy || archived || pending !== null}
          onChange={(event) => setPhaseKey(event.target.value)}>
          {phaseOptions.map((phase) => <option key={phase} value={phase}>{phaseLabel(phase)} · {phase}</option>)}
        </select>
        <small className="helper-text">只列出 {projectType} 项目类型允许的阶段。</small>
        <button className="secondary-button" type="button" data-testid="state-phase-submit"
          disabled={busy || archived || pending !== null || phaseKey === state.phaseKey}
          onClick={() => start({ projectId, commandId: createCommandId(),
            expectedRevision: state.revision, action: "SET_PHASE", phaseKey })}>保存阶段</button>
      </label>

      <label className="field"><span className="field-label">下一步 Task</span>
        <select name="state-next-action" data-testid="state-next-action" value={nextActionId}
          disabled={busy || archived || pending !== null}
          onChange={(event) => setNextActionId(event.target.value)}>
          <option value="">未指定</option>
          {currentNextActionUnlisted && <option value={state.nextActionTaskId!}>
            当前引用 Task {state.nextActionTaskId}（不在已加载分页）</option>}
          {tasks.map((task) => <option key={task.id} value={task.id}>
            {task.title} · {taskStatusLabels[task.status] ?? task.status}</option>)}
        </select>
        <small className="helper-text">只引用本项目已加载的任务；设为下一步不代表该 Task 已获得执行资格。</small>
        <button className="secondary-button" type="button" data-testid="state-next-action-submit"
          disabled={busy || archived || pending !== null || nextActionId === (state.nextActionTaskId ?? "")}
          onClick={() => start({ projectId, commandId: createCommandId(),
            expectedRevision: state.revision, action: "SET_NEXT_ACTION",
            nextActionTaskId: nextActionId === "" ? null : nextActionId })}>保存下一步</button>
      </label>
    </div>

    <div className="field-grid">
      <div>
        <h3>已确认风险</h3>
        {state.risks.length === 0 ? <p className="helper-text">State 当前没有已确认风险。</p>
          : <ul className="run-list">{state.risks.map((risk) => <li key={risk.riskId}
            data-testid={`state-risk-${risk.riskId}`}>
            <strong>{risk.statement}</strong>
            <small>确认引用 {risk.confirmationRef} · 来源 {risk.sourceRef} · {risk.resolvedAt === null ? "未解除" : `解除于 ${new Date(risk.resolvedAt).toLocaleString("zh-CN")}`}</small>
          </li>)}</ul>}
        {!showRiskForm ? <button className="text-button" type="button" data-testid="state-risk-open"
          disabled={busy || archived || pending !== null} onClick={() => setShowRiskForm(true)}>登记已确认风险</button>
          : <form className="stack" onSubmit={(event) => { event.preventDefault();
            if (riskStatement.trim() === "") { setError("风险说明不能为空。"); return; }
            if (riskSource.trim() === "" || riskConfirmation.trim() === "") {
              setError("来源引用与确认引用都必须填写，不能伪造确认依据。"); return;
            }
            start({ projectId, commandId: createCommandId(), expectedRevision: state.revision,
              action: "ADD_CONFIRMED_RISK", statement: riskStatement.trim(),
              sourceRef: riskSource.trim(), confirmationRef: riskConfirmation.trim() });
          }}>
            <label className="field"><span className="field-label">风险说明</span>
              <input name="risk-statement" data-testid="state-risk-statement" maxLength={500}
                value={riskStatement} disabled={busy || archived || pending !== null}
                onChange={(event) => setRiskStatement(event.target.value)} /></label>
            <label className="field"><span className="field-label">来源引用</span>
              <input name="risk-source" data-testid="state-risk-source" maxLength={200}
                value={riskSource} disabled={busy || archived || pending !== null}
                onChange={(event) => setRiskSource(event.target.value)} /></label>
            <label className="field"><span className="field-label">确认引用</span>
              <input name="risk-confirmation" data-testid="state-risk-confirmation" maxLength={200}
                value={riskConfirmation} disabled={busy || archived || pending !== null}
                onChange={(event) => setRiskConfirmation(event.target.value)} /></label>
            <div className="form-actions">
              <button className="primary-button" type="submit" data-testid="state-risk-submit"
                disabled={busy || archived || pending !== null}>保存风险</button>
              <button className="secondary-button" type="button" data-testid="state-risk-cancel"
                disabled={busy} onClick={() => setShowRiskForm(false)}>取消</button>
            </div>
          </form>}
      </div>

      <div>
        <h3>阻塞</h3>
        {state.blockers.filter((blocker) => blocker.resolvedAt === null).length === 0
          ? <p className="helper-text">State 当前没有未解除阻塞。</p>
          : <ul className="run-list">{state.blockers.filter((blocker) => blocker.resolvedAt === null)
            .map((blocker) => <li key={blocker.blockerId} data-testid={`state-blocker-${blocker.blockerId}`}>
              <strong>{blocker.reason}</strong>
              <small>{blocker.targetKind} {blocker.targetId} · 来源 {blocker.sourceRef}</small>
              <button className="text-button" type="button" data-testid={`state-blocker-resolve-${blocker.blockerId}`}
                disabled={busy || archived || pending !== null}
                onClick={() => start({ projectId, commandId: createCommandId(),
                  expectedRevision: state.revision, action: "RESOLVE_BLOCKER",
                  blockerId: blocker.blockerId })}>解除阻塞</button>
            </li>)}</ul>}
        {state.blockers.some((blocker) => blocker.resolvedAt !== null) && <details className="tech-details">
          <summary>已解除历史</summary>
          <ul className="run-list">{state.blockers.filter((blocker) => blocker.resolvedAt !== null)
            .map((blocker) => <li key={blocker.blockerId}>{blocker.reason} · 解除于 {new Date(blocker.resolvedAt!).toLocaleString("zh-CN")}</li>)}
          </ul></details>}
        {!showBlockerForm ? <button className="text-button" type="button" data-testid="state-blocker-open"
          disabled={busy || archived || pending !== null} onClick={() => setShowBlockerForm(true)}>登记阻塞</button>
          : <form className="stack" onSubmit={(event) => { event.preventDefault();
            if (blockerTargetId === "") { setError("请选择阻塞目标。"); return; }
            if (blockerReason.trim() === "") { setError("阻塞原因不能为空。"); return; }
            if (blockerSource.trim() === "") { setError("来源引用不能为空。"); return; }
            start({ projectId, commandId: createCommandId(), expectedRevision: state.revision,
              action: "ADD_BLOCKER", targetKind: blockerKind, targetId: blockerTargetId,
              reason: blockerReason.trim(), sourceRef: blockerSource.trim() });
          }}>
            <label className="field"><span className="field-label">目标类型</span>
              <select name="blocker-kind" data-testid="state-blocker-kind" value={blockerKind}
                disabled={busy || archived || pending !== null}
                onChange={(event) => setBlockerKind(event.target.value as "PROJECT" | "TASK" | "GOAL")}>
                <option value="PROJECT">本项目</option>
                <option value="TASK">任务</option>
                <option value="GOAL">目标</option>
              </select></label>
            <label className="field"><span className="field-label">目标</span>
              <select name="blocker-target" data-testid="state-blocker-target" value={blockerTargetId}
                disabled={busy || archived || pending !== null || blockerKind === "PROJECT"}
                onChange={(event) => setBlockerTargetId(event.target.value)}>
                {blockerKind === "PROJECT" && <option value={projectId}>本项目</option>}
                {blockerKind === "TASK" && tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
                {blockerKind === "GOAL" && (goals ?? []).map((goal) => <option key={goal.goalId} value={goal.goalId}>{goal.title}</option>)}
              </select>
              {blockerKind === "TASK" && tasks.length === 0 && <small className="helper-text">本页没有已加载的项目任务，不能登记 Task 阻塞。</small>}
              {blockerKind === "GOAL" && goals !== null && goals.length === 0 && <small className="helper-text">项目当前没有关联 Goal，不能登记 Goal 阻塞。</small>}
              {blockerKind === "GOAL" && goals === null && <small className="helper-text">Goal 关系读取失败，不能据此登记 Goal 阻塞。</small>}
            </label>
            <label className="field"><span className="field-label">原因</span>
              <input name="blocker-reason" data-testid="state-blocker-reason" maxLength={500}
                value={blockerReason} disabled={busy || archived || pending !== null}
                onChange={(event) => setBlockerReason(event.target.value)} /></label>
            <label className="field"><span className="field-label">来源引用</span>
              <input name="blocker-source" data-testid="state-blocker-source" maxLength={200}
                value={blockerSource} disabled={busy || archived || pending !== null}
                onChange={(event) => setBlockerSource(event.target.value)} /></label>
            <div className="form-actions">
              <button className="primary-button" type="submit" data-testid="state-blocker-submit"
                disabled={busy || archived || pending !== null || blockerTargetId === ""}>保存阻塞</button>
              <button className="secondary-button" type="button" data-testid="state-blocker-cancel"
                disabled={busy} onClick={() => setShowBlockerForm(false)}>取消</button>
            </div>
          </form>}
      </div>
    </div>

    <p className="helper-text"><Info aria-hidden="true" />
      State v{state.revision} · 依赖版本以服务端组合视图为准；选择产物版本仍走独立的 SELECT_ARTIFACT_VERSION 入口。
      <button className="text-button" type="button" data-testid="project-state-reread"
        disabled={busy} onClick={onChanged}><RotateCcw aria-hidden="true" />重新读取 State</button>
    </p>
  </section>;
}
