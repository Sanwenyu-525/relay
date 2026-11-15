#!/usr/bin/env node
/**
 * UI 规范守卫的自测（UI-UNIFY-03）。
 *
 * 用 node --test 运行：node --test scripts/check-ui-conventions.test.mjs
 * 覆盖：新页面绕过、合法例外、非法例外、JSX 注释/字符串误报、存量增量、组件库内部不误判。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeViewSource, compareViewControls, shouldCheckView } from "./lib/ui-conventions-ast.mjs";

const header = `import { Button, Input } from "../ui";\n`;

function check(source, { baseline = 0, known = false } = {}) {
  const analysis = analyzeViewSource(header + source, "apps/workbench/src/views/FixtureView.tsx");
  return {
    analysis,
    result: compareViewControls({
      relativeFile: "apps/workbench/src/views/FixtureView.tsx",
      controls: analysis.controls,
      baselineCount: baseline,
      isKnownView: known
    })
  };
}

test("新页面只 import Button 却写原生 <button>：失败", () => {
  const { result } = check(`export default () => <div><button type="button">保存</button></div>;`);
  assert.equal(result.count, 1);
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0], /新页面直接写原生 <button>/u);
});

test("正确使用共享组件：通过", () => {
  const { result, analysis } = check(`export default () => <div><Button>保存</Button><Input value="" onChange={() => {}} /></div>;`);
  assert.equal(analysis.controls.length, 0);
  assert.deepEqual(result.violations, []);
});

test("<input type=file> / hidden：按浏览器原生语义放行", () => {
  const file = check(`export default () => <input type="file" aria-label="附件" />;`);
  const hidden = check(`export default () => <input type="hidden" name="id" />;`);
  assert.equal(file.analysis.controls.length, 1);
  assert.equal(file.analysis.violations.length, 0);
  assert.equal(file.result.violations.length, 0);
  assert.equal(hidden.analysis.controls.length, 1);
  assert.equal(hidden.analysis.violations.length, 0);
});

test("合法例外：allow-native + 原因通过", () => {
  const { result, analysis } = check(`export default () => <div>
    {/* ui-conventions: allow-native — 需要浏览器原生右键菜单语义 */}
    <button type="button" onContextMenu={() => {}}>打开菜单</button>
  </div>;`);
  assert.equal(analysis.violations.length, 0);
  assert.deepEqual(result.violations, []);
  assert.equal(analysis.controls[0].reason, "需要浏览器原生右键菜单语义");
});

test("非法例外：只写 allow-native 不给原因失败", () => {
  const { result, analysis } = check(`export default () => <div>
    {/* ui-conventions: allow-native */}
    <button type="button">保存</button>
  </div>;`);
  assert.equal(analysis.violations[0].problem, "exception-without-reason");
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0], /没有写明原因/u);
});

test("JSX 注释与字符串中的 <button> 不误报", () => {
  const source = `const copy = "<button>不是控件</button>";
export default () => <div>{/* <button>注释</button> */}<Button>好</Button></div>;`;
  const analysis = analyzeViewSource(header + source, "apps/workbench/src/views/FixtureView.tsx");
  assert.equal(analysis.controls.length, 0);
  assert.equal(analysis.violations.length, 0);
});

test("存量页面新增原生控件：失败；减少：通过", () => {
  const grown = check(`export default () => <div><button>a</button><button>b</button></div>;`, { baseline: 1, known: true });
  assert.equal(grown.result.count, 2);
  assert.equal(grown.result.violations.length, 1);
  assert.match(grown.result.violations[0], /1 → 2/u);
  const shrunk = check(`export default () => <div><button>a</button></div>;`, { baseline: 2, known: true });
  assert.deepEqual(shrunk.result.violations, []);
});

test("组件库内部与业务组件不在页面规则范围", () => {
  assert.equal(shouldCheckView("apps/workbench/src/views/TasksView.tsx"), true);
  assert.equal(shouldCheckView("apps/workbench/src/ui/Button.tsx"), false);
  assert.equal(shouldCheckView("apps/workbench/src/components/AppDialog.tsx"), false);
});
