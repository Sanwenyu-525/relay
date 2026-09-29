import { useEffect, useRef, useState, type FormEvent } from "react";
import { createCommandId, RelayApiError, RelayTransportError,
  type RelayApiClient, type RelayCommandReceipt, type RelayPackDefinition,
  type RelaySkillDefinition } from "../api/relayClient";
import type { RelayProjectGoal } from "../api/blueprintDtos";
import { describeLiveError } from "../lib/liveErrors";

const skillId = "goal-to-project-blueprint";
const skillVersion = "1.0.0";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type SkillInput = { readonly desired_outcome: string; readonly goal_id: string | null;
  readonly pack_ref: { readonly id: string; readonly version: string } | null };
type Frozen =
  | { readonly stage: "create"; readonly commandId: string; readonly conflict: boolean;
    readonly content: string; readonly input: SkillInput }
  | { readonly stage: "request"; readonly commandId: string; readonly conflict: boolean;
    readonly content: string; readonly input: SkillInput; readonly sessionId: string }
  | { readonly stage: "wait"; readonly sessionId: string; readonly messageId: string };

function key(client: RelayApiClient, projectId: string) {
  return `relay:blueprint-skill:${client.baseUrl}:${client.workspaceId}:${projectId}`;
}
function readFrozen(storageKey: string): Frozen | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (row.stage === "wait" && typeof row.sessionId === "string" &&
      typeof row.messageId === "string") return row as Frozen;
    if ((row.stage === "create" || row.stage === "request") &&
      typeof row.commandId === "string" && typeof row.content === "string" &&
      typeof row.input === "object" && row.input !== null &&
      (row.stage === "create" || typeof row.sessionId === "string")) return row as Frozen;
  } catch { /* Ignore a corrupt browser snapshot; the server remains authoritative. */ }
  return null;
}

export default function BlueprintSkillGenerator({ client, projectId, goals, packs, disabled, newWritesBlocked,
  onProposalFound, onActiveChange }: { client: RelayApiClient; projectId: string;
  goals: readonly RelayProjectGoal[]; packs: readonly RelayPackDefinition[];
  disabled: boolean; newWritesBlocked: boolean; onProposalFound: (proposalId: string) => void;
  onActiveChange: (active: boolean) => void }) {
  const storageKey = key(client, projectId);
  const [definition, setDefinition] = useState<RelaySkillDefinition | null>(null);
  const [definitionError, setDefinitionError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState("");
  const [goalId, setGoalId] = useState("");
  const [packValue, setPackValue] = useState("");
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [busy, setBusy] = useState(false);
  const [mayRetry, setMayRetry] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const frozenRef = useRef<Frozen | null>(null);
  const busyRef = useRef(false);
  const newWritesBlockedRef = useRef(newWritesBlocked);
  newWritesBlockedRef.current = newWritesBlocked;
  const scope = useRef(0);
  const callback = useRef(onProposalFound);
  callback.current = onProposalFound;

  function save(next: Frozen | null) {
    frozenRef.current = next; setFrozen(next);
    try {
      if (next) sessionStorage.setItem(storageKey, JSON.stringify(next));
      else sessionStorage.removeItem(storageKey);
    } catch { /* The mounted view still retains the frozen operation. */ }
  }
  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await action(); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function sessionKnown(sessionId: string, original: Extract<Frozen, { stage: "create" }>, request: number) {
    const session = await client.getAssistSession(sessionId);
    if (session.projectId !== projectId || session.taskId !== null || session.status !== "ACTIVE") {
      throw new RelayTransportError("Assist 会话与当前项目不匹配，不能发送蓝图消息。");
    }
    if (scope.current !== request) return;
    if (newWritesBlockedRef.current) {
      save(null); setNotice(`Assist 会话 ${sessionId} 的原命令已确认；Project 已归档或事实未确认，未发送新的 Skill 消息。`);
      return;
    }
    const next: Frozen = { stage: "request", commandId: createCommandId(), conflict: false,
      sessionId, content: original.content, input: original.input };
    save(next);
    await execute(next, request);
  }
  function messageKnown(sessionId: string, messageId: string, request: number) {
    if (scope.current !== request) return;
    save({ stage: "wait", sessionId, messageId });
    setMayRetry(false); setError(null);
    setNotice(`Assist 消息 ${messageId} 已排队；等待服务端生成并保存独立蓝图提案。`);
  }
  async function checkReceipt(command: Extract<Frozen, { stage: "create" | "request" }>, request: number) {
    try {
      const receipt: RelayCommandReceipt = await client.getCommandReceipt(command.commandId);
      if (scope.current !== request) return;
      const expectedType = command.stage === "create" ? "CreateAssistSession" : "RequestAssistMessage";
      if (receipt.commandId !== command.commandId || receipt.commandType !== expectedType) {
        throw new RelayTransportError("Assist 原命令回执身份不匹配。");
      }
      if (command.stage === "create") {
        if (receipt.result.project_id !== projectId || receipt.result.task_id !== null ||
          typeof receipt.result.session_id !== "string") {
          throw new RelayTransportError("Assist 会话回执与当前项目不匹配。");
        }
        await sessionKnown(receipt.result.session_id, command, request);
      } else {
        if (receipt.result.session_id !== command.sessionId ||
          typeof receipt.result.assistant_message_id !== "string") {
          throw new RelayTransportError("Assist 消息回执与原会话不匹配。");
        }
        messageKnown(command.sessionId, receipt.result.assistant_message_id, request);
      }
    } catch (caught) {
      if (scope.current !== request) return;
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetry(!command.conflict);
        setError(command.conflict ? "原命令未找到回执，冲突后请核对事实，再明确重新生成。" :
          "原命令暂未找到回执；可以继续查询，或按原 ID 和载荷重试。");
      } else setError("原 Assist 回执尚无法核对；请保留 command_id 继续查询。");
    }
  }
  async function execute(command: Extract<Frozen, { stage: "create" | "request" }>, request: number) {
    setError(null); setMayRetry(false); setNotice(null);
    try {
      if (command.stage === "create") {
        const session = await client.createAssistSession({ commandId: command.commandId,
          projectId, taskId: null, title: "项目蓝图建议" });
        if (session.projectId !== projectId || session.taskId !== null) {
          throw new RelayTransportError("新 Assist 会话与当前项目不匹配。");
        }
        if (scope.current === request) await sessionKnown(session.id, command, request);
      } else {
        const result = await client.requestAssistMessage({ sessionId: command.sessionId,
          commandId: command.commandId, content: command.content, sourceRefs: [],
          skillRef: { id: skillId, version: skillVersion }, skillInput: command.input });
        messageKnown(command.sessionId, result.assistantMessageId, request);
      }
    } catch (caught) {
      if (scope.current !== request) return;
      if (caught instanceof RelayApiError && caught.problem.status === 409) {
        const conflicted = { ...command, conflict: true };
        save(conflicted); setError(`${describeLiveError(caught).message} 原 command_id：${command.commandId}。`);
        await checkReceipt(conflicted, request);
      } else if (caught instanceof RelayApiError && caught.problem.status < 500 &&
        caught.problem.code !== "COMMAND_ID_REUSED") {
        save(null); setError(describeLiveError(caught).message);
      } else {
        setError("提交结果不明，正在核对原 command_id 回执。");
        await checkReceipt(command, request);
      }
    }
  }

  useEffect(() => {
    const request = ++scope.current;
    const restored = readFrozen(storageKey);
    save(restored); setError(null); setNotice(null); setDefinition(null);
    let live = true;
    void client.getFirstPartySkills().then((items) => {
      if (!live || request !== scope.current) return;
      const found = items.find((item) => item.id === skillId && item.version === skillVersion &&
        item.target === "PROJECT" && item.outputKind === "PROJECT_BLUEPRINT_SUGGESTION") ?? null;
      setDefinition(found);
      setDefinitionError(found ? null : "当前服务端未提供目标版本的项目蓝图 Skill。");
    }).catch((caught) => {
      if (live && request === scope.current) setDefinitionError(describeLiveError(caught).message);
    });
    if (restored) {
      if (restored.stage !== "wait") void run(() => checkReceipt(restored, request));
    }
    return () => { live = false; scope.current++; };
  }, [client, projectId, storageKey]);

  useEffect(() => { onActiveChange(frozen !== null); }, [frozen, onActiveChange]);

  useEffect(() => {
    if (frozen?.stage !== "wait") return;
    const waiting = frozen;
    const request = scope.current;
    let stopped = false;
    let timer: number | undefined;
    const active = () => !stopped && request === scope.current && frozenRef.current === waiting;
    async function poll() {
      try {
        const messages = await client.getAssistMessages(waiting.sessionId);
        if (!active()) return;
        const message = messages.find((item) => item.id === waiting.messageId);
        if (!message || message.sessionId !== waiting.sessionId || message.role !== "ASSISTANT") {
          throw new Error("原 assistant message 暂未出现在会话中。");
        }
        if (message.status === "FAILED" || message.status === "CANCELLED") {
          save(null); setError(`Skill 消息 ${message.id} ${message.status}（${message.errorCode ?? "无错误码"}）；没有可应用的蓝图提案。`);
          return;
        }
        if (message.status === "COMPLETED") {
          const output = message.skillOutput;
          if (message.skill?.id !== skillId || message.skill.version !== skillVersion) {
            save(null); setError("Skill 消息已完成，但蓝图输出身份或类型无法核对；不会展示为可应用提案。");
            return;
          }
          const outputMatches = output?.kind === "PROJECT_BLUEPRINT_SUGGESTION" &&
            output.status === "SUGGESTED" && output.targetKind === "PROJECT" &&
            output.targetId === projectId && output.payload.effective_blueprint === false;
          const proposals = await client.getBlueprintProposals(projectId);
          if (!active()) return;
          const linked = proposals.find((item) => item.origin === "SKILL" &&
            item.skillMessageId === message.id && item.projectId === projectId &&
            item.workspaceId === client.workspaceId);
          if (linked) {
            const exact = await client.getBlueprintProposal(projectId, linked.id);
            if (exact.id !== linked.id || exact.skillMessageId !== message.id ||
              exact.origin !== "SKILL" || exact.projectId !== projectId ||
              exact.workspaceId !== client.workspaceId) {
              throw new Error("Skill 消息与服务端蓝图提案关联不一致。");
            }
            if (!active()) return;
            if (exact.contentAvailability === "AVAILABLE" && !outputMatches) {
              save(null); setError("Skill 消息输出无法核对，不能展示关联候选的正文或应用入口。");
              return;
            }
            save(null); setError(null);
            setNotice(exact.contentAvailability === "AVAILABLE"
              ? `Skill 消息 ${message.id} 已完成；服务端候选 ${exact.id} 已读取，尚未应用。`
              : `Skill 消息 ${message.id} 已完成，但候选来源现已不可用；仅能查看候选状态与摘要。`);
            callback.current(exact.id);
            return;
          }
          if (!outputMatches) {
            save(null); setError("Skill 消息已完成，但没有可核对的蓝图输出或关联提案。");
            return;
          }
          setNotice(`Skill 消息 ${message.id} 已完成，正在按原消息 ID 查询服务端提案。`);
        } else setNotice(`Skill 消息 ${message.id}：${message.status}。尚无可应用提案。`);
        setError(null);
      } catch (caught) {
        if (active()) setError(`生成状态暂不可读：${describeLiveError(caught).message}`);
      }
      if (active()) timer = window.setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [client, projectId, frozen]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || frozenRef.current || disabled || !definition?.callSupported ||
      definition.missingCapabilities.length > 0) return;
    await run(async () => {
      const desiredOutcome = outcome.trim();
      if (!desiredOutcome || desiredOutcome.length > 2000) {
        setError("请填写 1–2000 字的期望结果。"); return;
      }
      const selectedGoal = goalId.trim() || null;
      if (selectedGoal && !uuid.test(selectedGoal)) { setError("Goal ID 必须是完整 UUID。"); return; }
      if (selectedGoal) {
        try {
          const goal = await client.getGoal(selectedGoal);
          if (goal.id !== selectedGoal || goal.status !== "ACTIVE") {
            setError("所选 Goal 不是当前 Workspace 的有效 Goal。"); return;
          }
        } catch (caught) { setError(describeLiveError(caught).message); return; }
      }
      const pack = packs.find((item) => packValue === `${item.id}@${item.version}` &&
        item.availability === "AVAILABLE") ?? null;
      if (packValue && !pack) { setError("所选 Pack 版本当前不可用。"); return; }
      if (newWritesBlockedRef.current) { setError("Project 已归档或事实未确认，不能发送新的 Skill 消息。"); return; }
      const input: SkillInput = { desired_outcome: desiredOutcome, goal_id: selectedGoal,
        pack_ref: pack ? { id: pack.id, version: pack.version } : null };
      const command: Frozen = { stage: "create", commandId: createCommandId(), conflict: false,
        content: `请根据当前项目事实生成项目蓝图建议：${desiredOutcome}`, input };
      save(command);
      await execute(command, scope.current);
    });
  }

  return <section className="surface-panel live-blueprint-generator" data-testid="blueprint-skill-generator">
    <h2>通过 Skill 生成蓝图建议</h2>
    <p className="helper-text">使用真实 Project Assist 会话和 {skillId} v{skillVersion}。生成完成后只读取与该消息绑定的服务端候选；模型建议本身不修改项目。</p>
    {definition && <p className="helper-text">Skill 定义 SHA-256 <code className="hash-code">{definition.sha256}</code> ·
      {definition.callSupported && !definition.missingCapabilities.length ? "当前可调用" : "当前不可调用"}。
      Pack 只登记来源版本，不授予能力或 Permission。</p>}
    {definitionError && <p className="action-error" role="alert">Skill 定义不可用：{definitionError}</p>}
    <form onSubmit={(event) => void submit(event)}>
      <fieldset disabled={disabled || busy || frozen !== null || !definition?.callSupported ||
        Boolean(definition.missingCapabilities.length)}>
        <label className="field"><span className="field-label">期望结果</span>
          <textarea data-testid="blueprint-skill-outcome" value={outcome} maxLength={2000}
            onChange={(event) => setOutcome(event.target.value)}
            placeholder="描述希望项目蓝图达成的结果" /></label>
        <label className="field"><span className="field-label">现有 Goal ID（可选）</span>
          <input data-testid="blueprint-skill-goal" value={goalId} list="blueprint-skill-goals"
            onChange={(event) => setGoalId(event.target.value)} placeholder="留空则不指定 Goal" /></label>
        <datalist id="blueprint-skill-goals">{goals.filter((goal) => goal.status === "ACTIVE")
          .map((goal) => <option key={goal.goalId} value={goal.goalId} label={goal.title} />)}</datalist>
        <label className="field"><span className="field-label">Pack 来源（可选）</span>
          <select data-testid="blueprint-skill-pack" value={packValue}
            onChange={(event) => setPackValue(event.target.value)}>
            <option value="">不选择 Pack</option>
            {packs.filter((pack) => pack.availability === "AVAILABLE").map((pack) =>
              <option key={`${pack.id}@${pack.version}`} value={`${pack.id}@${pack.version}`}>
                {pack.title} v{pack.version}</option>)}</select></label>
        <button className="primary-button" type="submit" data-testid="blueprint-skill-generate">生成 Skill 建议</button>
      </fieldset>
    </form>
    {notice && <p className="success-callout" role="status">{notice}</p>}
    {error && <p className="action-error" role="alert">{error}</p>}
    {frozen && <div className="warning-callout" data-testid="blueprint-skill-pending">
      {frozen.stage === "wait" ? <>
        <p>Assist 会话 <code className="hash-code">{frozen.sessionId}</code> · assistant message <code className="hash-code">{frozen.messageId}</code>。服务端状态轮询中。</p>
        <button className="secondary-button" type="button" onClick={() => {
          save(null); setNotice(`已停止页面轮询；Assist 消息 ${frozen.messageId} 未被取消。稍后可刷新服务端候选。`);
        }}>停止页面轮询</button>
      </> : <>
        <p>原 {frozen.stage === "create" ? "CreateAssistSession" : "RequestAssistMessage"} command_id：
          <code className="hash-code">{frozen.commandId}</code>。原内容与 Skill 输入已冻结。</p>
        <button className="secondary-button" type="button" disabled={busy}
          onClick={() => void run(() => checkReceipt(frozen, scope.current))}>查询原命令回执</button>
        {mayRetry && !frozen.conflict && <button className="secondary-button" type="button" disabled={busy}
          onClick={() => void run(() => execute(frozen, scope.current))}>用原 ID 和载荷重试</button>}
        {frozen.conflict && <button className="secondary-button" type="button" disabled={busy}
          onClick={() => { save(null); setMayRetry(false); setError(null);
            setNotice("原命令没有回执；请核对当前事实后明确重新生成。"); }}>按当前事实重新确认</button>}
      </>}
    </div>}
  </section>;
}
