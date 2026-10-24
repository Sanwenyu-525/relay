import { createRoot } from "react-dom/client";
import { ChevronDown } from "lucide-react";
import { installDesignTokens } from "./lib/tokens";
import "./styles.css";
import "./migrated-scoped.css";
import "./views/AssistView.css";

installDesignTokens();

function Probe() {
  return (
    <div style={{ padding: 24, background: "var(--relay-color-bg-canvas)" }}>
      <div className="agent-chat-composer">
        <div className="agent-chat-composer-actions">
          <div className="agent-chat-composer-tools">
            <button className="agent-chat-tool" type="button">+</button>
            <button className="agent-chat-tool" type="button">未开放写入</button>
            <div className="agent-chat-mode">
              <label className="agent-chat-mode-select-field">
                <span className="visually-hidden">会话模式</span>
                <select className="agent-chat-mode-select" defaultValue="AGENT">
                  <option value="AGENT">普通 Agent</option>
                  <option value="ASSISTANT">人设助手</option>
                  <option value="LEARNING">学习</option>
                </select>
                <ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" />
              </label>
            </div>
            <button className="agent-chat-tool" type="button">润色</button>
            <button className="agent-chat-tool" type="button">普通讨论</button>
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Probe />);
