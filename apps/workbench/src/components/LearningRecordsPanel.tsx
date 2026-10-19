import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { createCommandId, RelayApiError, type RelayApiClient } from "../api/relayClient";
import { learningCommandType, learningResultMatches, type RelayLearningCommand,
  type RelayLearningConcept, type RelayLearningContinuation, type RelayLearningRecords,
  type RelayLearningState } from "../api/resources/learning";
import { describeLiveError } from "../lib/liveErrors";
import { liveClient } from "../lib/relayConnection";
import type { AssistNavigationState } from "../views/AssistView";

const kindLabels: Record<string, string> = { EXPOSURE: "接触过", SELF_REPORT: "用户自述",
  OBSERVED: "具体表现", GAP: "具体缺口" };
const dispositionLabels: Record<string, string> = { ACTIVE: "有效依据", PENDING_REVIEW: "待复核",
  SUPERSEDED: "已解除，保留历史", WITHDRAWN: "已撤回" };

export default function LearningRecordsPanel({ client, sessionId, refreshKey, blocked, writeBlocked, inflight, defaultBackground, composerDirty,
  onStateChange, onNavigationChange, onTransfer }: {
  client: RelayApiClient; sessionId: string; refreshKey: string; blocked: boolean; inflight: boolean;
  writeBlocked: boolean; defaultBackground: string;
  composerDirty?: boolean;
  onStateChange: (state: RelayLearningState | null) => void;
  onNavigationChange: (state: AssistNavigationState) => void;
  onTransfer?: (instruction: string, background: string) => void;
}) {
  const [records, setRecords] = useState<RelayLearningRecords | null>(null);
  const [state, setState] = useState<RelayLearningState | null>(null);
  const [continuation, setContinuation] = useState<RelayLearningContinuation | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<RelayLearningCommand | null>(null);
  const [correcting, setCorrecting] = useState<RelayLearningConcept | null>(null);
  const [scenario, setScenario] = useState("");
  const [detail, setDetail] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [background, setBackground] = useState("");
  const [reload, setReload] = useState(0);
  const mounted = useRef(true);
  const gate = useRef(false);
  const readVersion = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readVersion.current++; }; }, []);
  const current = () => mounted.current && client === liveClient();
  async function read() {
    const version = ++readVersion.current;
    setReadError(null); setRecords(null); setState(null); setContinuation(null); onStateChange(null);
    if (blocked) return;
    try {
      const [r, s, c] = await Promise.all([client.getLearningRecords(),
        client.getLearningState(sessionId), client.getLearningContinuation(sessionId)]);
      if (!current() || version !== readVersion.current) return;
      setRecords(r); setState(s); setContinuation(c); onStateChange(s);
    } catch (caught) {
      if (current() && version === readVersion.current) setReadError(describeLiveError(caught).message);
    }
  }
  useEffect(() => { void read(); return () => { readVersion.current++; }; }, [client, sessionId, refreshKey, blocked, reload]);
  useEffect(() => {
    if (blocked || inflight || !state?.rounds.some((round) => round.status === "PENDING")) return;
    const timer = window.setTimeout(() => setReload((n) => n + 1), 1500);
    return () => window.clearTimeout(timer);
  }, [state, inflight, blocked]);
  useEffect(() => {
    onNavigationChange({ dirty: Boolean(detail.trim() || scenario.trim() || instruction.trim() || background.trim()),
      pending: pending ? { commandId: pending.commandId, commandType: learningCommandType(pending), sessionId } : null,
      discard: () => { setCorrecting(null); setDetail(""); setScenario(""); setInstruction(""); setBackground(""); } });
  }, [detail, scenario, instruction, background, pending, sessionId, onNavigationChange]);

  function finished(action: RelayLearningCommand) {
    setPending(null); setError(null); setRecords(null); setState(null); setContinuation(null); onStateChange(null);
    setNotice(action.kind === "clear" ? "学习记录已清除，原聊天保留。正在核对当前记录。"
      : action.kind === "delete" ? "这一条学习依据已删除。正在读取当前记录。"
        : action.kind === "correct" ? "纠正已作为用户自述保存。正在读取当前记录。"
          : action.recordsEnabled ? "后续学习记录已开启。" : "后续不记录；此前已保存的记录保留。");
    if (action.kind === "correct") { setCorrecting(null); setDetail(""); setScenario(""); }
    setConfirmClear(false); setReload((n) => n + 1);
  }
  async function submit(action: RelayLearningCommand, retry = false) {
    if (gate.current || blocked || writeBlocked || (!retry && pending !== null)) return;
    gate.current = true; setBusy(true); setPending(action); setError(null); setNotice(null);
    try {
      await client.submitLearningCommand(action);
      if (current()) finished(action);
    } catch (caught) {
      if (!current()) return;
      const described = describeLiveError(caught);
      setError(described.message);
      if (caught instanceof RelayApiError && caught.problem.status < 500 &&
          caught.problem.retryAction !== "CHECK_RECEIPT_THEN_RETRY") {
        setPending(null); setReload((n) => n + 1);
      }
    } finally { gate.current = false; if (mounted.current) setBusy(false); }
  }
  async function checkReceipt() {
    if (!pending || gate.current) return;
    const action = pending; gate.current = true; setBusy(true); setError(null);
    try {
      const receipt = await client.getCommandReceipt(action.commandId);
      if (!current()) return;
      if (receipt.commandId !== action.commandId || receipt.commandType !== learningCommandType(action) ||
        !learningResultMatches(action, receipt.result)) throw new Error("回执与原学习命令不匹配，仍需核对。");
      finished(action);
    } catch (caught) { if (current()) setError(describeLiveError(caught).message); }
    finally { gate.current = false; if (mounted.current) setBusy(false); }
  }
  const locked = blocked || writeBlocked || busy || pending !== null || state === null;
  return <details className="surface-panel learning-records-panel" data-testid="learning-records-panel"
    open={pending !== null || readError !== null || error !== null || notice !== null ? true : undefined}>
    <summary>学习记录与接续{readError ? " · 暂不可读" : pending ? " · 命令待核对" : continuation ? ` · ${continuation.openItems.length} 项待复核` : ""}</summary>
    <p className="helper-text">个人学习记录跨项目可用，对项目只读；未观察到不表示不会。</p>
    {notice && <p role="status">{notice}</p>}
    {readError ? <p role="alert">记录暂不可读：{readError}</p> : records === null && !blocked ? <p role="status">正在读取学习记录…</p> : null}
    <button className="text-button" type="button" disabled={busy || blocked} onClick={() => setReload((n) => n + 1)}>刷新学习记录</button>
    {state && <label className="field"><span>后续记录</span><input type="checkbox" checked={state.recordsEnabled}
      disabled={locked} data-testid="learning-record-control" onChange={(event) => void submit({ kind: "control",
        commandId: createCommandId(), sessionId, recordsEnabled: event.target.checked, expectedRevision: state.revision })} />
      <span>{state.recordsEnabled ? "记录开启" : "后续不记录"}；切换不删除此前记录，也不删除聊天。</span></label>}
    {continuation && <p>当前学习目标：{continuation.goal}。{continuation.lastObservedAt
      ? <>最近依据：<time dateTime={continuation.lastObservedAt}>{new Date(continuation.lastObservedAt).toLocaleString()}</time></>
      : "尚无学习依据，可从当前问题开始。"}</p>}
    {continuation?.openItems.map((item, index) => <p key={`${item.conceptId}:${index}`}>待复核 · {item.displayName} · {item.scenario}：{item.detail}</p>)}
    {records?.concepts.length === 0 && <p>还没有学习记录。新的学习交互会按本轮依据积累；不会从旧聊天补回。</p>}
    {records?.concepts.map((concept) => <details key={concept.conceptId} data-testid="learning-concept">
      <summary>{concept.topic} · {concept.displayName}</summary>
      {concept.evidence.length === 0 && <p>当前没有可用依据，未观察到不表示不会。</p>}
      {concept.evidence.map((evidence) => <div key={evidence.evidenceId} data-testid="learning-evidence">
        <p>{kindLabels[evidence.kind] ?? evidence.kind} · {dispositionLabels[evidence.disposition] ?? evidence.disposition} · {evidence.scenario}</p>
        <p>{evidence.detail}</p><p className="helper-text">{evidence.sourceKind === "USER_CONTROL" ? "用户明确纠正" : "学习消息依据"} ·
          <time dateTime={evidence.observedAt}>{new Date(evidence.observedAt).toLocaleString()}</time></p>
        {evidence.sessionId && evidence.sourceMessageId && <Link to={`/agent?session=${encodeURIComponent(evidence.sessionId)}`}>查看来源会话</Link>}
        <button className="text-button" type="button" disabled={locked} onClick={() => void submit({ kind: "delete",
          commandId: createCommandId(), evidenceId: evidence.evidenceId, expectedGeneration: concept.generation })}>删除这条依据</button>
      </div>)}
      <button className="secondary-button" type="button" disabled={locked} onClick={() => { setCorrecting(concept); setScenario(""); setDetail(""); }}>纠正我的记录</button>
    </details>)}
    {correcting && <form className="create-form" onSubmit={(event) => { event.preventDefault();
      if (!scenario.trim() || !detail.trim()) return;
      void submit({ kind: "correct", commandId: createCommandId(), sessionId, conceptId: correcting.conceptId,
        scenario: scenario.trim(), detail: detail.trim() }); }}>
      <p>纠正 {correcting.displayName}；保存为自述，不作为答题验证。</p>
      <label className="field"><span>具体场景</span><input value={scenario} maxLength={200} disabled={busy || pending !== null}
        onChange={(event) => setScenario(event.target.value)} /></label>
      <label className="field"><span>纠正说明</span><textarea value={detail} maxLength={400} disabled={busy || pending !== null}
        onChange={(event) => setDetail(event.target.value)} /></label>
      <button className="secondary-button" disabled={locked || !detail.trim() || !scenario.trim()}>保存纠正</button>
      <button className="text-button" type="button" disabled={busy || pending !== null}
        onClick={() => { setCorrecting(null); setScenario(""); setDetail(""); }}>取消纠正</button>
    </form>}
    <button className="text-button" type="button" disabled={locked} onClick={() => setConfirmClear(true)}>清空全部学习记录</button>
    {confirmClear && <div><p>清除当前工作空间全部个人学习记录。原聊天、项目资料和执行事实保留；清除后旧轮次不能补回记录。</p>
      <button className="danger-button" type="button" disabled={locked} onClick={() => void submit({ kind: "clear", commandId: createCommandId() })}>确认清除学习记录</button>
      <button className="text-button" type="button" disabled={busy} onClick={() => setConfirmClear(false)}>保留记录</button></div>}
    {onTransfer && <details className="tech-details"><summary onClick={() => { if (!background) setBackground(defaultBackground); }}>转入普通执行会话</summary>
      <p className="helper-text">输入明确执行要求与所选方案、约束和未决项。将新建普通会话；原学习身份保留，动作仍需原权限和验收。</p>
      <label className="field"><span>执行要求</span><textarea value={instruction} maxLength={2000}
        onChange={(event) => setInstruction(event.target.value)} disabled={busy || pending !== null} /></label>
      <label className="field"><span>方案、约束与未决项</span><textarea value={background} maxLength={4000}
        onChange={(event) => setBackground(event.target.value)} disabled={busy || pending !== null} /></label>
      <button className="secondary-button" type="button" disabled={locked || inflight || composerDirty || Boolean(detail.trim() || scenario.trim()) || !instruction.trim()}
        onClick={() => onTransfer(instruction.trim(), background.trim())}>转入执行</button>
      {inflight && <p>正在生成，安全结束后才能转入执行。</p>}
      {(composerDirty || Boolean(detail.trim() || scenario.trim())) && <p>有未提交的消息或纠正，请先发送、保存或明确取消，草稿会保留。</p>}
    </details>}
    {error && <p role="alert">{error}</p>}
    {pending && <div><p>学习命令结果待核对。核对前不提交新操作。</p>
      <button className="secondary-button" type="button" disabled={busy} onClick={() => void checkReceipt()}>核对学习命令回执</button>
      <button className="secondary-button" type="button" disabled={busy || blocked || writeBlocked} onClick={() => void submit(pending, true)}>按原学习命令重试</button></div>}
  </details>;
}

export function learningRoundText(round: RelayLearningState["rounds"][number]): string {
  if (!round.recordEnabled) return "本轮不记录学习状态。";
  switch (round.status) {
    case "PENDING": return "学习记录正在处理，尚未确认保存。";
    case "SETTLED": return "本轮记录处理完成，实际依据见学习记录。";
    case "REJECTED": return `本轮学习记录未更新：${round.rejectionReason ?? "依据未通过校验"}。回答仍可阅读。`;
    case "CANCELLED": return "本轮记录已停止，未结算增量不再保存；此前提交保留。";
    default: return "本轮记录结果待核对。";
  }
}
