import { afterEach, beforeEach } from "vitest";
import { resetFixture, setFixtureLatency } from "../src/fixtures/fixtureAdapter";
import { clearCreationFlash } from "../src/lib/navigationFlash";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  resetFixture();
  clearCreationFlash();
  setFixtureLatency(5);
  window.scrollTo = () => undefined;
});

afterEach(() => {
  resetFixture();
  clearCreationFlash();
  setFixtureLatency(180);
});
