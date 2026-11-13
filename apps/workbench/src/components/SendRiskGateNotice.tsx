import type { RiskGateWindow } from "../lib/sendRiskGate";
import "./ContextRiskNotice.css";
import { Button } from "../ui";

/**
 * 发送前风险确认条（P0-B / P0-C）。
 *
 * 两种状态共用同一位置与同一形状，都排在输入卡之外，出现或消失都不改变卡片高度：
 *   · 命中新的高风险且没确认过——这次会读多少个必读文件、占多少预算，
 *     给出「仍然发送 / 先去精简」；
 *   · 风险未知（超时、失败、无权限、扫描不可用）——说清为什么未知，同样由用户当场选
 *     「仍然发送 / 取消发送」。未知不冒充安全，也不自动放行：此刻命令与正文都还没生成。
 */
export default function SendRiskGateNotice({ gate, onContinue, onCancel }: {
  readonly gate: RiskGateWindow | null;
  readonly onContinue: () => void;
  readonly onCancel: () => void;
}) {
  if (gate === null) return null;
  if (gate.kind === "UNKNOWN") {
    return <div className="context-risk context-risk-gate" role="alertdialog"
      aria-label="风险未知，是否仍然发送" data-testid="context-risk-gate"
      data-mode="unknown" data-reason={gate.code ?? "AUDIT_FAILED"}>
      <p className="context-risk-gate-text" data-testid="context-risk-gate-unknown">
        {gate.message ?? "风险检查没有完成，风险未知。"}
        {" 是否仍然发送？"}
      </p>
      <div className="context-risk-actions">
        <Button variant="primary" data-testid="context-risk-gate-continue"
          onClick={onContinue}>仍然发送</Button>
        <Button variant="secondary" data-testid="context-risk-gate-cancel"
          onClick={onCancel}>取消发送</Button>
      </div>
    </div>;
  }
  return <div className="context-risk context-risk-gate" role="alertdialog"
    aria-label="发送前风险确认" data-testid="context-risk-gate" data-mode="confirm"
    data-severity={gate.severity ?? undefined}>
    <p className="context-risk-gate-text">
      {`这条消息发送前会读 ${gate.files ?? 0} 个必读文件，预计占用 `}
      {gate.share === null ? "无法估算的" : `${Math.round(gate.share * 100)}%`}
      {" 有效输入预算。"}
    </p>
    <div className="context-risk-actions">
      <Button variant="primary" data-testid="context-risk-gate-continue"
        onClick={onContinue}>仍然发送</Button>
      <Button variant="secondary" data-testid="context-risk-gate-cancel"
        onClick={onCancel}>先去精简</Button>
    </div>
  </div>;
}
