import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { setFixtureLatency } from "./fixtures/fixtureAdapter";
import { fixtureLatencyFromSearch } from "./lib/fixtureMode";
import { installDesignTokens } from "./lib/tokens";
import { createWorkbenchRouter } from "./router";
import "./styles.css";
import "./migrated-scoped.css";

installDesignTokens();
setFixtureLatency(fixtureLatencyFromSearch(window.location.search));

const root = document.getElementById("app");
if (!root) throw new Error("Workbench root missing");
createRoot(root).render(<RouterProvider router={createWorkbenchRouter()} />);
