import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { setFixtureLatency } from "./fixtures/fixtureAdapter";
import { fixtureLatencyFromSearch } from "./lib/fixtureMode";
import { installDesignTokens } from "./lib/tokens";
import { resolveMotionPreference } from "./lib/motionPreference";
import { createWorkbenchRouter } from "./router";
import "./styles.css";
import "./migrated-scoped.css";

installDesignTokens();
// 运行期动效总开关的初值。关动效只改展示：不发暂停或取消命令，也不隐藏状态文字与控制入口。
document.documentElement.dataset.motion = resolveMotionPreference() ? "on" : "off";
setFixtureLatency(fixtureLatencyFromSearch(window.location.search));

const root = document.getElementById("app");
if (!root) throw new Error("Workbench root missing");
createRoot(root).render(<RouterProvider router={createWorkbenchRouter()} />);
