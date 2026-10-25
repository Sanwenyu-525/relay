import { createRoot } from "react-dom/client";
import { installDesignTokens } from "./lib/tokens";
import "./styles.css";
import "./migrated-scoped.css";
import "./views/AssistView.css";
import GoalCard from "./components/GoalCard";
import type { RelayGoalView } from "./api/relayClient";

installDesignTokens();

/** 2026-10-25 目标单行状态条探针：真实 GoalCard + 真实输入卡结构（参照 probeGoalBadge）。
    四种状态各一例，验证单行截断、动作可见性与展开区。 */
function goalView(objective: string, status: string, actions: Record<string, boolean>,
  extras: Record<string, unknown> = {}): RelayGoalView {
  return { goal: {
    goalId: "goal-1", sessionId: "session-1", objective, status, currentStep: null,
    progress: null, stopReason: null,
    criteria: [
      { key: "c1", statement: "README 含启动步骤", status: "MET", evidence: "README 第 3 节", required: true },
      { key: "c2", statement: "示例能在干净目录跑通", status: "PENDING", evidence: null, required: true },
    ],
    steps: [{ title: "梳理现状", status: "DONE" }, { title: "补启动文档", status: "DOING" }],
    roundCount: 3, noProgressRounds: 0, planVersionId: null, planVersion: 2,
    lastRoundAt: null, actions: { pause: false, cancel: false, resume: false,
      confirmCompletion: false, ...actions },
    revision: "1", createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z",
    ...extras }, rounds: [
      { roundIndex: 3, outcome: "CONTINUE", note: "完成启动文档草稿" },
      { roundIndex: 2, outcome: "CONTINUE", note: null },
    ] } as unknown as RelayGoalView;
}

const noop = () => {};

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return <section style={{ margin: "0 0 28px" }}>
    <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--relay-color-text-muted)" }}>{title}</p>
    {children}
  </section>;
}

/** 仿输入卡上一段正文，验证状态条与输入卡的间距关系。 */
const composer = <div className="agent-chat-composer" style={{ maxWidth: 560 }}>
  <div className="field"><textarea rows={2} placeholder="输入你的想法、修改意见或新的要求"
    style={{ width: "100%", border: 0, resize: "none", background: "transparent",
      color: "var(--relay-color-text-primary)", fontFamily: "inherit" }} /></div>
</div>;

function Probe() {
  return (
    <div style={{ padding: 24, background: "var(--relay-color-bg-canvas)", maxWidth: 640 }}>
      <Row title="推进中（长目标正文截断）">
        <GoalCard view={goalView("把 Relay-Agent 的 README、快速上手与常见问题整理到能支撑一个新同事当天跑起来", "ACTIVE",
          { pause: true, cancel: true })} busy={false} error={null}
          onPause={noop} onCancel={noop} onResume={noop} onConfirm={noop} />
        {composer}
      </Row>
      <Row title="已暂停（继续 + 展开）">
        <GoalCard view={goalView("整理文档", "PAUSED", { cancel: true, resume: true },
          { stopReason: { code: "USER_PAUSE", detail: "你暂停了这个目标。", questions: [] } })}
          busy={false} error={null} onPause={noop} onCancel={noop} onResume={noop} onConfirm={noop} />
      </Row>
      <Row title="等你确认完成">
        <GoalCard view={goalView("整理文档", "AWAITING_ACCEPTANCE", { cancel: true, confirmCompletion: true })}
          busy={false} error={null} onPause={noop} onCancel={noop} onResume={noop} onConfirm={noop} />
      </Row>
      <Row title="等你决定（原因与问题）">
        <GoalCard view={goalView("整理文档", "WAITING_USER", { cancel: true, resume: true },
          { stopReason: { code: "NEEDS_USER", detail: "第 3 轮需要你决定后续方向。",
            questions: ["示例代码放在 docs/examples 还是仓库根目录？"] } })}
          busy={false} error={null} onPause={noop} onCancel={noop} onResume={noop} onConfirm={noop} />
      </Row>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Probe />);
