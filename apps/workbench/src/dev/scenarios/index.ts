import type { Scenario, ScenarioCategory, ScenarioGroup } from "../scenarioWorld";
import { CATEGORY_META } from "../scenarioWorld";
import { LIFECYCLE } from "./lifecycle";
import { TOOLS } from "./tools";
import { EDITING } from "./editing";
import { STATES } from "./states";
import { RECOVERY } from "./recovery";
import { BOUNDARIES } from "./boundaries";
import { FLOWS } from "./flows";

/**
 * 场景目录的唯一出口：界面左侧目录、批量运行与验收报告读的都是这一份。
 *
 * 分组按**场景 ID 的族号**派生（A→F 是矩阵六族，G 是组合流程，X 是矩阵之外的补充分支），
 * 与各文件里的书写顺序无关：文件按内容族存放，目录按身份归组，两处不会是两套口径。
 * 这里不重排编号、不去重：真出现同一个 ID 两次，`duplicateIds()` 这条会先失败，
 * 而不是让目录里悄悄多出一行。
 */

const BY_FILE: readonly Scenario[] = [
  ...LIFECYCLE, ...TOOLS, ...EDITING, ...STATES, ...RECOVERY, ...BOUNDARIES, ...FLOWS
];

export const ALL_SCENARIOS: readonly Scenario[] = BY_FILE;

/** 矩阵每族的条数：用于逐条展开要求的 ID。 */
const FAMILY_SIZE: Readonly<Partial<Record<ScenarioCategory, number>>> = {
  A: 16, B: 22, C: 17, D: 16, E: 17, F: 20
};

/**
 * 矩阵逐条要求的 ID（不含 X 补充族）：写死编号而不是只写条数。
 *
 * 条数够了不代表齐了——`A16` 缺、`A17` 多占一位，计数看不出来，但验收表里那一行就是没有场景。
 * 这份清单按矩阵原文列出，缺哪一条直接报哪一条。
 */
const MATRIX_IDS: readonly string[] = [
  ...(["A", "B", "C", "D", "E", "F"] as const).flatMap((family) =>
    Array.from({ length: FAMILY_SIZE[family] ?? 0 }, (_, index) => `${family}${String(index + 1).padStart(2, "0")}`)),
  ...["G01", "G02", "G03", "G04", "G05", "G06"]
];

export const SCENARIO_GROUPS: readonly ScenarioGroup[] =
  (Object.keys(CATEGORY_META) as ScenarioCategory[])
    .map((category) => ({
      category,
      scenarios: ALL_SCENARIOS
        .filter((scenario) => scenario.id.startsWith(category))
        .sort((left, right) => left.id.localeCompare(right.id))
    }))
    .filter((group) => group.scenarios.length > 0);

/** 矩阵里缺哪几条：逐条比对 ID，缺的报告可直接当作待补场景清单。 */
export function missingMatrixIds(): readonly string[] {
  const present = new Set(ALL_SCENARIOS.map((scenario) => scenario.id));
  return MATRIX_IDS.filter((id) => !present.has(id));
}

/** 重复 ID：同一身份出现两次会让「点这条场景」指向不确定内容。 */
export function duplicateIds(): readonly string[] {
  const seen = new Set<string>();
  const again = new Set<string>();
  for (const scenario of ALL_SCENARIOS) {
    if (seen.has(scenario.id)) again.add(scenario.id);
    seen.add(scenario.id);
  }
  return [...again];
}
