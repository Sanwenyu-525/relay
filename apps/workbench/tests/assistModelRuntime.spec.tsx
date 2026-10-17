import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import AssistModelRuntime from "../src/components/AssistModelRuntime";
import { FeedbackHost } from "../src/components/Feedback";
import type { RelayApiClient, RelayAssistModelRuntime } from "../src/api/relayClient";
import { feedbackText, flush, mountReact } from "./mountApp";

let unmount: (() => void) | undefined;
afterEach(() => { unmount?.(); unmount = undefined; vi.restoreAllMocks(); });
const runtime: RelayAssistModelRuntime = { messageId: "a1", messageStatus: "COMPLETED", snapshotAvailable: true,
  preferredModel: "v/a:free", currentCandidateModel: "v/b:free", actualModel: "v/b:free", maxCandidates: 3,
  candidateModels: ["v/a:free", "v/b:free", "v/c:free"], routingStatus: "READY",
  failureScope: "UPSTREAM_PROVIDER", failureReason: "UPSTREAM_PROVIDER_RATE_LIMIT", retryAfterAt: null, freeDailyRemaining: 49,
  switches: [{ fromModel: "v/a:free", toModel: "v/b:free", reason: "UPSTREAM_PROVIDER_RATE_LIMIT" }],
  calls: [{ id: "c1", model: "v/a:free", status: "FAILED", inputTokens: null, outputTokens: null },
    { id: "c2", model: "v/b:free", status: "COMPLETED", inputTokens: 11, outputTokens: 7 }] };
async function render(result: RelayAssistModelRuntime) {
  const read = vi.fn(async () => result);
  const client = { getAssistModelRuntime: read } as unknown as RelayApiClient;
  const view = await mountReact(<AssistModelRuntime client={client} messageId="a1" messageStatus={result.messageStatus} />);
  unmount = view.unmount; await flush(); return { view, read };
}

it("首选和实际模型分别显示，切换有来源，失败用量不补零", async () => {
  const { view, read } = await render(runtime);
  expect(view.wrapper.text()).toContain("本条首选：v/a:free");
  expect(view.wrapper.text()).toContain("最近实际调用：v/b:free");
  expect(view.wrapper.text()).toContain("已从 v/a:free 切换到 v/b:free");
  expect(view.wrapper.text()).toContain("上游限流");
  expect(view.wrapper.text()).toContain("输入 未知 / 输出 未知");
  expect(view.wrapper.text()).toContain("输入 11 / 输出 7");
  expect(read).toHaveBeenCalledTimes(1);
});

it("账户总额度耗尽明确停止，遗留STARTED不冒充已返回", async () => {
  const { view } = await render({ ...runtime, messageStatus: "FAILED", failureScope: "ACCOUNT",
    failureReason: "ACCOUNT_FREE_DAILY_EXHAUSTED", freeDailyRemaining: 0, switches: [],
    calls: [{ ...runtime.calls[0]!, status: "STARTED" }] });
  expect(view.wrapper.text()).toContain("账户共享免费日额度已耗尽，停止接续");
  expect(view.wrapper.text()).toContain("结果待核对");
  expect(view.wrapper.text()).not.toContain("调用已返回");
});

it("旧无快照消息不伪造冻结首选", async () => {
  const { view } = await render({ ...runtime, snapshotAvailable: false, preferredModel: null });
  expect(view.wrapper.find('[data-testid="assist-model-runtime"]').exists()).toBe(false);
});

it("读取失败走浮层 Snackbar：正文不留这条错误，动作按钮按原消息重读并在成功时收走", async () => {
  const host = await mountReact(<FeedbackHost />);
  const read = vi.fn((): Promise<RelayAssistModelRuntime> => { throw new Error("no route"); });
  const client = { getAssistModelRuntime: read } as unknown as RelayApiClient;
  const view = await mountReact(<AssistModelRuntime client={client} messageId="a1" messageStatus="COMPLETED" />);
  unmount = () => { view.unmount(); host.unmount(); };
  await flush();
  expect(view.wrapper.text()).not.toContain("模型调用状态读取失败");
  // 读不到又从没读到过内容时整块不渲染，正文里不留空占位。
  expect(view.wrapper.find('[data-testid="assist-model-runtime"]').exists()).toBe(false);
  expect(feedbackText("assist-model-runtime-error")).toContain("模型调用状态读取失败");
  read.mockResolvedValue(runtime);
  const action = document.querySelector<HTMLElement>('[data-testid="assist-model-runtime-error"] button');
  await act(async () => { action?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[data-testid="assist-model-runtime-error"]')).toBeNull();
  expect(view.wrapper.find('[data-testid="assist-model-runtime"]').text()).toContain("本条首选：v/a:free");
});
