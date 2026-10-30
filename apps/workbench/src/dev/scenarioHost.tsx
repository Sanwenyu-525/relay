import type { ReactElement, ReactNode } from "react";
import { useMemo, useSyncExternalStore } from "react";
import { MemoryRouter } from "react-router-dom";
import type { RelayApiClient } from "../api/relayClient";
import ExecutionTrajectorySummary from "../components/ExecutionTrajectorySummary";
import FileWriteFrozenDiffPanel from "../components/FileWriteFrozenDiffPanel";
import RunToolTrajectoryPanel from "../components/RunToolTrajectoryPanel";
import type { AssistTarget } from "../views/AssistView";
import { AssistMessageRow } from "../views/AssistView";
import { createScenarioClient } from "./scenarioClient";
import { MOCK } from "./scenarioFixtures";
import type { ScenarioConditions, ScenarioRunner, ScenarioWorld } from "./scenarioWorld";

/**
 * 场景预览的挂载层：把模拟世界交给**正式产品组件自己**渲染（仅开发构建可用）。
 *
 * 这一层刻意薄到只有「按宿主选组件 + 传既有 props」：
 *   * 没有第二套时间线，没有演示专用的行、图标或状态词；
 *   * 读取仍走真实 hook（`useRunToolCalls` / `useRunToolCallPreviews` / 会话账本的展开读取），
 *     因此错误分支、身份核对、轮询降级与折叠规则都是产品原来那一条路径；
 *   * 挂法照抄 `AssistView.tsx` 的真实顺序：执行摘要紧跟它所属的那条用户消息，
 *     会话侧的过程入口在助手消息行内部。
 *
 * 呈现条件（主题、动效、窗口档）落在 `ScenarioShell` 上，界面与验收测试共用同一个外壳。
 */

const TARGET: AssistTarget = {
  kind: "PROJECT", id: MOCK.projectId, title: "模拟项目（场景实验室）",
  revision: "7", projectId: MOCK.projectId, executor: null, archivedAt: null
};

const noop = (): void => undefined;

export function ScenarioPreview({ world, client }: {
  readonly world: ScenarioWorld;
  readonly client: RelayApiClient;
}): ReactElement {
  const runId = world.run?.id ?? MOCK.runId;
  const summary = <ExecutionTrajectorySummary client={client} runId={runId} revision={null}
    onOpenTrajectory={noop} />;
  // 消息列表用产品自己的骨架（`ol.agent-message-list` + `li.agent-message-slot`）：
  // 阅读宽度、行距与真实会话页由同一条 CSS 决定，实验室不另定一档「看着差不多」的宽度。
  return <div className="scenario-preview">
    {world.host === "SESSION" || world.host === "LINK"
      ? <ol className="agent-message-list">{world.messages.map((message) => <li key={message.id}
        className="agent-message-slot" data-message-id={message.id}>
        <AssistMessageRow client={client} target={TARGET} message={message}
          preview={message.role === "ASSISTANT" ? world.preview : null}
          previewError={message.role === "ASSISTANT" ? world.previewError : null}
          onRetryPreview={noop}
          settling={message.role === "ASSISTANT" ? world.settling : null}
          handover={message.role === "ASSISTANT" && world.handover}
          onVerifyFinal={noop}
          writeBlocked={world.writeBlocked}
          candidates={[]}
          personaLabel={message.role === "ASSISTANT" ? world.personaLabel : null}
          recallReceipt={world.recallReceipt}
          recallBusy={false} recallReading={false} recallError={null}
          recallDisabledReason={world.recallDisabledReason}
          onRecall={noop} onReadRecall={noop} />
        {/* 摘要属于那条用户消息发起的一次执行：按产品顺序紧跟着它，不另找位置。 */}
        {message.role === "USER" && world.host === "LINK" && summary}
      </li>)}</ol>
      : null}
    {world.host === "RUN_SUMMARY" && summary}
    {world.host === "RUN_TRAJECTORY" && <RunToolTrajectoryPanel client={client} run={world.run} />}
    {world.host === "DIFF" && world.frozenDiff !== null &&
      <FileWriteFrozenDiffPanel diff={world.frozenDiff} ledgers={world.changeSets} />}
  </div>;
}

/** 实验室与验收测试共用的外壳：`Link` 需要路由上下文，产品里由工作台的 Router 提供。 */
export function withScenarioRouter(element: ReactElement): ReactElement {
  return <MemoryRouter initialEntries={["/__dev/assist-scenarios"]}>{element}</MemoryRouter>;
}

/**
 * 预览外壳：呈现条件的落点，界面与验收测试挂的是同一个元素。
 *
 * `embedded-assist` 不是装饰：阅读宽度那一档（`--chat-measure`）就定义在这个选择器上，
 * 实验室借它才和真实会话页同宽；实验室自己不再写一份 max-width。
 * `data-theme` / `data-motion` / `data-viewport` 由控制器施加，断言与截图读的是同一档事实。
 */
export function ScenarioShell({ conditions, children }: {
  readonly conditions?: ScenarioConditions;
  readonly children: ReactNode;
}): ReactElement {
  return <div data-scenario-preview="true"
    data-theme={conditions?.theme ?? "light"}
    data-motion={conditions?.motion ?? "on"}
    data-viewport={conditions?.viewport ?? "wide"}
    className="embedded-assist scenario-shell">{children}</div>;
}

/**
 * 舞台：订阅回放器，把当前帧的模拟世界交给真实组件。
 *
 * 界面运行器与验收测试挂的是同一个组件、同一份 `ScenarioRunner`，
 * 因此「实验室里点出来的那一帧」和「测试里断言的那一帧」不可能是两套东西。
 */
export function ScenarioStage({ runner }: { readonly runner: ScenarioRunner }): ReactElement {
  const frame = useSyncExternalStore((onChange) => runner.subscribe(onChange),
    () => runner.seq, () => runner.seq);
  // 每一帧换一份 client 身份：真实 hook 把 client 放在读取依赖里，因此推进这一帧会立刻重读，
  // 而不是干等组件自己的 2 秒轮询。实验室里「点一步就变一步」靠的是这个，不是另造一条时间线。
  const client = useMemo(() => createScenarioClient(runner), [runner, frame]);
  // `data-scenario-frame` / `data-scenario-id` 只在实验室外壳上出现，不是产品 DOM 的一部分：
  // 用它确认「界面确实跟着这一帧重画了」，而不是只相信回放器内部的计数；
  // 场景身份同时让批量在切下一条时能认出「这一帧属于哪条」，不会把上一条的残留读成结果。
  return <div data-scenario-frame={frame} data-scenario-id={runner.scenario.id}>
    <ScenarioPreview world={runner.world} client={client} />
  </div>;
}
