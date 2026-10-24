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
  // jsdom 不实现 ResizeObserver。浮层翻面（2026-10-24，popoverMenu）要现算面板宽度并随
  // 面板尺寸重量，缺构造器会让任何挂载弹层的用例整页崩进 route-error。桩只保证可构造、
  // 可 observe/disconnect，不产生布局量测；翻面的真实几何归真机与浏览器验收。
  (globalThis as typeof globalThis & { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() { /* 桩：不量测 */ }
    unobserve() { /* 桩 */ }
    disconnect() { /* 桩 */ }
  };
  // jsdom 没有 canvas 后端，getContext 恒返回 null。任务栏角标在铃铛刷新链路上要画一张 32px 图，
  // 缺上下文会让每条用例都打宿主告警。这里只补一个可调用、不产出像素的桩，
  // 角标的绘制与 IPC 断言归 tests/taskbarBadge.spec.ts，像素效果归真机验收。
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    if (this.width === 0 || this.height === 0) return null;
    return {
      fillStyle: "", font: "", textAlign: "", textBaseline: "",
      clearRect() { /* 桩：不产生像素 */ }, beginPath() { /* 桩 */ }, arc() { /* 桩 */ },
      closePath() { /* 桩 */ }, fill() { /* 桩 */ }, fillText() { /* 桩 */ },
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  resetFixture();
  clearCreationFlash();
  setFixtureLatency(180);
});
