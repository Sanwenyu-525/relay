import { afterEach, beforeEach } from "vitest";
import { resetFixture, setFixtureLatency } from "../src/fixtures/fixtureAdapter";
import { clearCreationFlash } from "../src/lib/navigationFlash";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  resetFixture();
  clearCreationFlash();
  setFixtureLatency(5);
  window.scrollTo = () => undefined;
  // jsdom 不实现布局，因此也没有 scrollIntoView（真实浏览器有）。
  // 用空实现补上：协作页的目录入口会先把它滚入视野再点开，缺了它这条真实路径在 jsdom 里会直接抛错。
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  resetFixture();
  clearCreationFlash();
  setFixtureLatency(180);
});
