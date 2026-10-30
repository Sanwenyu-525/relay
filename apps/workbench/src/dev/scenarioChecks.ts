import type { ScenarioCheck } from "./scenarioWorld";

/**
 * 场景断言的执行器：把 `checks` 这份数据在真实 DOM 上跑一遍。
 *
 * 界面运行器与 Playwright 跑的是同一份数据，因此「看着对」和「测出来对」不是两套口径。
 * 三条规则：
 *   * **先确认节点在场，再谈它的内容与样式**。选不到节点的任何检查一律判失败，
 *     绝不让空集合把「没渲染」读成「没有那句话」而错误通过。
 *   * 「看得见」＝已挂载且不落在收起的 `<details>` 里；`gone` 取同一口径的反面。
 *   * 需要真实布局或动画的检查（横向溢出、动画节点数、左缘对齐、滚动位置稳定）
 *     在 jsdom 里根本没有答案，如实标成 `browser-only`，由浏览器测试负责，不算通过也不算失败。
 */

export type CheckStatus = "pass" | "fail" | "browser-only";

export interface CheckResult {
  readonly label: string;
  readonly status: CheckStatus;
  /** 失败或跳过时的具体依据：报告里要能直接看出差在哪。 */
  readonly detail: string;
}

const normalize = (value: string): string => value.replace(/\s+/gu, " ").trim();

/**
 * 「界面这段话里含有 X」的比较口径：两边都按空白折叠后再比。
 *
 * `<pre>` 里的多行回执在 DOM 中带着换行，声明期望时写成多行更自然；
 * 两边归一化，比较的才是「同一句话」而不是「同一种空白写法」。
 */
const containsText = (element: Element, expected: string): boolean =>
  normalize(element.textContent ?? "").includes(normalize(expected));

/**
 * 落在收起的 `<details>` 里的内容，用户看不见：不计入在场。
 *
 * 从父级开始往上找，否则 `SessionRoundTrace` 这种「根节点自己就是 details」的行会把
 * 自己判成藏在自己里面；`summary` 是折叠时也露在外面的那一行，同样不算隐藏。
 */
function inClosedDetails(element: Element): boolean {
  if (element.tagName === "SUMMARY") return false;
  let node: Element | null = element.parentElement;
  while (node !== null) {
    if (node.tagName === "SUMMARY") return false;
    if (node.tagName === "DETAILS" && !(node as HTMLDetailsElement).open) return true;
    node = node.parentElement;
  }
  return false;
}

/** 选节点：`querySelectorAll` 看不见查询起点自己，外壳选择器因此要先比对根节点。 */
function mounted(root: ParentNode, selector: string): readonly Element[] {
  const found = Array.from(root.querySelectorAll(selector));
  return root instanceof Element && root.matches(selector) ? [root, ...found] : found;
}

/** 需要真实布局或动画的种类：jsdom 给不出可信读数。 */
export const BROWSER_ONLY_KINDS: readonly ScenarioCheck["kind"][] =
  ["noOverflow", "motionCount", "leftEdgeAligned", "scrollStable"];

/** 各类「行」的容器：重复行检查按行身份（testid）判定，不按整块 DOM。 */
const ROW_SELECTOR = ".activity-item, .trajectory-call, .local-file-diff";

function duplicateDetail(root: ParentNode): string {
  const ids = mounted(root, ROW_SELECTOR)
    .map((row) => row.getAttribute("data-testid") ?? normalize(row.textContent ?? ""))
    .filter((identity) => identity !== "");
  const seen = new Set<string>();
  const again = new Set<string>();
  for (const identity of ids) {
    if (seen.has(identity)) again.add(identity);
    seen.add(identity);
  }
  return [...again].join("、");
}

function single(root: ParentNode, selector: string): { readonly element: Element | null } {
  const found = mounted(root, selector);
  return { element: found.length > 0 ? found[0] : null };
}

function runOne(root: ParentNode, check: ScenarioCheck): CheckResult {
  const fail = (detail: string): CheckResult => ({ label: check.label, status: "fail", detail });
  const pass = (detail = ""): CheckResult => ({ label: check.label, status: "pass", detail });

  switch (check.kind) {
    case "visible":
    case "visibleRow": {
      const { element } = single(root, check.selector ?? "");
      if (element === null) return fail(`没有节点：${check.selector}`);
      if (inClosedDetails(element)) return fail(`在收起的 details 里：${check.selector}`);
      if (check.kind === "visibleRow" && normalize(element.textContent ?? "") === "") {
        return fail(`这一行是空的：${check.selector}`);
      }
      return pass();
    }
    case "gone": {
      const { element } = single(root, check.selector ?? "");
      if (element === null || inClosedDetails(element)) return pass();
      return fail(`仍然在场：${check.selector}（${normalize(element.textContent ?? "").slice(0, 80)}）`);
    }
    case "count": {
      const found = mounted(root, check.selector ?? "");
      return found.length === check.equals
        ? pass()
        : fail(`${check.selector} 命中 ${found.length} 个，要求 ${check.equals} 个`);
    }
    case "atLeast": {
      const found = mounted(root, check.selector ?? "");
      return found.length >= (check.equals ?? 1)
        ? pass()
        : fail(`${check.selector} 命中 ${found.length} 个，至少要求 ${check.equals} 个`);
    }
    case "text": {
      const found = mounted(root, check.selector ?? "");
      if (found.length === 0) return fail(`没有节点可读：${check.selector}`);
      // 一个选择器命中多行时（例如全部「增行」），期望的是「这句话在这些行里出现过」，
      // 而不是「恰好落在第一行」；反证走 notText，那边要求没有任何一行命中。
      return found.some((element) => containsText(element, check.contains ?? ""))
        ? pass()
        : fail(`读到的不是那句话。${found.length} 个节点里都没有「${check.contains}」，`
          + `第一个读到「${normalize(found[0]?.textContent ?? "").slice(0, 200)}」`);
    }
    case "notText": {
      const found = mounted(root, check.selector ?? "");
      if (found.length === 0) return fail(`没有节点可证：${check.selector}`);
      const offending = found.find((element) => containsText(element, check.contains ?? ""));
      return offending === undefined
        ? pass()
        : fail(`不该出现「${check.contains}」，实际「${normalize(offending.textContent ?? "").slice(0, 200)}」`);
    }
    case "attr": {
      const { element } = single(root, check.selector ?? "");
      if (element === null) return fail(`没有节点：${check.selector}`);
      const actual = element.getAttribute(check.name ?? "") ?? "(缺)";
      return actual === check.value
        ? pass()
        : fail(`${check.name} 实际是「${actual}」，要求「${check.value}」`);
    }
    case "noDuplicateRows": {
      const duplicates = duplicateDetail(root);
      return duplicates === "" ? pass() : fail(`重复行：${duplicates}`);
    }
    default:
      return { label: check.label, status: "browser-only",
        detail: BROWSER_ONLY_KINDS.includes(check.kind)
          ? `${check.kind} 需要真实布局或动画读数，由浏览器测试判定`
          : `未知断言种类 ${check.kind}` };
  }
}

/** 跑一组断言；顺序与声明一致，报告里逐条可见。 */
export function runChecks(root: ParentNode, checks: readonly ScenarioCheck[]): CheckResult[] {
  return checks.map((check) => runOne(root, check));
}

export function failedResults(results: readonly CheckResult[]): CheckResult[] {
  return results.filter((result) => result.status === "fail");
}

/** 需要浏览器判定的条数：如实报，不计入通过。 */
export function browserOnlyCount(results: readonly CheckResult[]): number {
  return results.filter((result) => result.status === "browser-only").length;
}
