import { createRoot } from "react-dom/client";
import { ChevronDown } from "lucide-react";
import { installDesignTokens } from "./lib/tokens";
import "./styles.css";
import "./migrated-scoped.css";
import "./views/AssistView.css";
import ChatModeSwitch from "./components/ChatModeSwitch";

installDesignTokens();

/** 真实类结构复刻输入卡工具行右端一组（AssistView §5442）：
    徽标用真实组件，圆环/模型 chip 用同一套类，几何与线上一致。 */
function Probe() {
  return (
    <div style={{ padding: 24, background: "var(--relay-color-bg-canvas)" }}>
      <div className="agent-chat-composer" style={{ maxWidth: 560 }}>
        <div className="agent-chat-composer-actions">
          <div className="agent-chat-composer-tools">
            <ChatModeSwitch mode="GOAL" disabled={false} busy={false} lockedReason={null}
              onChange={() => {}} />
            <ChatModeSwitch mode="PLAN" disabled={false} busy={false} lockedReason={null}
              onChange={() => {}} />
          </div>
          <div className="agent-chat-composer-tail">
            <div className="agent-chat-usage">
              <div className="agent-chat-context-meter-group">
                <button type="button" className="agent-chat-context-meter" data-state="normal"
                  aria-label="上下文用量详情">
                  <svg viewBox="0 0 36 36" aria-hidden="true" focusable="false">
                    <circle className="agent-chat-context-meter-track" cx="18" cy="18" r="15" />
                    <circle className="agent-chat-context-meter-fill" cx="18" cy="18" r="15"
                      strokeDasharray="30 94.25" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="model-selector">
              <button type="button" className="agent-chat-tool model-selector-trigger"
                aria-label="选择模型">
                <span className="model-selector-trigger-name">GLM-5.3-Flash</span>
                <ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Probe />);
