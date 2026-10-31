import { BROWSER_ONLY_KINDS } from "./scenarioChecks";
import { ALL_SCENARIOS } from "./scenarios";
import type { ScenarioConditions } from "./scenarioWorld";

/**
 * 场景清单的唯一构造入口。
 *
 * 页面把它写进 `script#scenario-lab-manifest`，验收脚本再从页面读回来并与这里逐字段比对。
 * 两处如果各写一份映射，A03 这种「源码已经是六帧、产物清单还是单帧」的错位就会一直存在：
 * 页面看起来在跑新场景，报告却按旧清单写旧结论。清单只能有一份映射。
 */
export interface ScenarioManifestEntry {
  readonly id: string;
  readonly title: string;
  readonly stateKind: string;
  readonly host: string;
  readonly component: string;
  readonly frames: readonly { readonly at: number; readonly label: string }[];
  readonly browserOnly: readonly string[];
  readonly interactions: number;
  readonly uncovered: string | null;
  readonly conditions: ScenarioConditions | null;
}

export function buildScenarioManifest(): readonly ScenarioManifestEntry[] {
  return ALL_SCENARIOS.map((item) => ({
    id: item.id,
    title: item.title,
    stateKind: item.stateKind,
    host: item.host,
    component: item.component,
    frames: item.steps.map((step) => ({ at: step.at, label: step.label })),
    browserOnly: item.checks.filter((check) => BROWSER_ONLY_KINDS.includes(check.kind)).map((check) => check.label),
    interactions: (item.interactions ?? []).length,
    uncovered: item.uncovered ?? null,
    conditions: item.conditions ?? null
  }));
}
