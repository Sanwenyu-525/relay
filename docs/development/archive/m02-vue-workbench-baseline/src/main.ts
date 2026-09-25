import { createApp } from "vue";
import App from "./App.vue";
import { setFixtureLatency } from "./fixtures/fixtureAdapter";
import { fixtureLatencyFromSearch } from "./lib/fixtureMode";
import { installDesignTokens } from "./lib/tokens";
import { createWorkbenchRouter } from "./router";
import "./styles.css";

installDesignTokens();
setFixtureLatency(fixtureLatencyFromSearch(window.location.search));

const app = createApp(App);
app.use(createWorkbenchRouter());
app.mount("#app");