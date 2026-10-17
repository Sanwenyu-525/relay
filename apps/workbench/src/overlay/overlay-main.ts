/**
 * Computer Control 桌面 Overlay 的入口（overlay.html 专用，不加载工作台 SPA）。
 *
 * 宿主（apps/desktop/src-tauri control_overlay.rs）在透明置顶穿透窗口里加载本页，
 * 并通过 `window.__relayControlOverlayState(payload)` 注入真实操控状态
 * （来源：API GET /computer/control-session ← Worker 派发上报）。
 * 页面是纯 Observer：不调用业务 API、不注册快捷键、不产生输入。
 *
 * 性能约束：状态不变时不写 DOM；动画只有 CSS opacity；无 JS 逐帧循环。
 */

import "./overlay.css";

interface OverlayState {
  readonly state: "RUNNING" | "STOP_REQUESTED" | "STOPPED";
  readonly action_type: string | null;
  readonly action_label: string | null;
}

const CONTROLLING_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="2.5" y="4" width="19" height="13" rx="2.2"/>
  <path d="M8 21h8M12 17v4"/>
  <path d="M12.2 8.6l5.4 4.4-2.6.5-1.1 2.5z" fill="currentColor" stroke="none"/>
</svg>`;

const rootElement = document.getElementById("overlay-root");
if (rootElement === null) throw new Error("overlay root missing");
const root: HTMLElement = rootElement;

root.innerHTML = `
  <div class="glow-layer glow-outer"></div>
  <div class="glow-layer glow-bloom"></div>
  <div class="glow-layer glow-flow"></div>
  <div class="control-pill" role="status">
    <span class="pill-icon">${CONTROLLING_ICON}</span>
    <span class="pill-main">
      <span class="pill-head">
        <span class="pill-title">Relay 正在操控电脑</span>
        <span class="pill-state"></span>
      </span>
      <span class="pill-action"></span>
    </span>
    <span class="pill-divider"></span>
    <span class="pill-esc">按 <span class="esc-key">Esc</span> 退出电脑操控</span>
  </div>
`;

const pillState: HTMLElement = root.querySelector<HTMLElement>(".pill-state")
  ?? (() => { throw new Error("overlay pill missing"); })();
const pillAction: HTMLElement = root.querySelector<HTMLElement>(".pill-action")
  ?? (() => { throw new Error("overlay pill missing"); })();

let lastSignature = "";

function applyState(next: OverlayState): void {
  const label = (next.action_label ?? "").trim();
  // STOP_REQUESTED/STOPPED 都进入退出表现：光效压暗、状态条提示退出，随后宿主隐藏窗口。
  const visible = next.state !== "STOPPED";
  const signature = JSON.stringify([visible, next.state, label]);
  if (signature === lastSignature) return;
  lastSignature = signature;

  if (next.state === "STOP_REQUESTED") {
    pillState.textContent = "退出中";
    pillAction.textContent = "正在停止电脑操控…";
  } else {
    pillState.textContent = next.state === "RUNNING" ? "控制中" : "";
    pillAction.textContent = label;
  }
  root.classList.toggle("is-visible", visible);
  root.classList.toggle("is-stopping", next.state === "STOP_REQUESTED");
}

declare global {
  interface Window {
    __relayControlOverlayState?: (state: OverlayState) => void;
  }
}

window.__relayControlOverlayState = applyState;
