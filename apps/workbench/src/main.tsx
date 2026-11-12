import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { setFixtureLatency } from "./fixtures/fixtureAdapter";
import { fixtureLatencyFromSearch } from "./lib/fixtureMode";
import { installFrontendDiagnostics, reportFrontendError } from "./lib/frontendDiagnostics";
import { installDesignTokens } from "./lib/tokens";
import { resolveMotionPreference } from "./lib/motionPreference";
import { createWorkbenchRouter } from "./router";
import "./styles.css";
import "./migrated-scoped.css";
// 原型复刻页面的设计语言层：全部 scope 在 .pv-page 下，见 views/proto/protoPage.css。
import "./views/proto/protoPage.css";

installFrontendDiagnostics();
installDesignTokens();
// 运行期动效总开关的初值。关动效只改展示：不发暂停或取消命令，也不隐藏状态文字与控制入口。
document.documentElement.dataset.motion = resolveMotionPreference() ? "on" : "off";
setFixtureLatency(fixtureLatencyFromSearch(window.location.search));

const root = document.getElementById("app");
if (!root) {
  const error = new Error("Workbench root missing");
  // 初始化失败没有可渲染的界面：先落到诊断队列（连接就绪后补交），再显式抛出。
  reportFrontendError({ kind: "init", error });
  throw error;
}
createRoot(root).render(<RouterProvider router={createWorkbenchRouter()} />);
