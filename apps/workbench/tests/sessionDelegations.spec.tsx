import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelaySessionDelegation } from "../src/api/relayClient";
import { sessionDelegationFrom } from "../src/api/parse/assist";
import SessionDelegations from "../src/components/SessionDelegations";
import { mountReact } from "./mountApp";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); });
const row: RelaySessionDelegation = { delegationId: "delegation-a", childSessionId: "child-a",
  role: "INVESTIGATE", objective: "核对目录事实", scope: ["README.md"], baseline: null,
  required: false, status: "SUCCEEDED", attemptCount: 1, maxAttempts: 2,
  resultSummary: "README.md 中存在验证标记", createdAt: "2026-10-30T08:00:00Z",
  closedAt: "2026-10-30T08:00:01Z" };

describe("会话内只读协作", () => {
  it("展示真实结果并用确切子会话身份导航", async () => {
    const open = vi.fn();
    const client = { workspaceId: "workspace", getAssistSessionDelegations: vi.fn().mockResolvedValue([row]) };
    const view = await mountReact(<SessionDelegations client={client} sessionId="parent" onOpenSession={open} />);
    dispose = view.unmount;
    expect(view.wrapper.text()).toContain(row.resultSummary);
    expect(view.wrapper.text()).toContain("README.md");
    await view.wrapper.get('[data-testid="session-delegation-open"]').trigger("click");
    expect(open).toHaveBeenCalledWith("child-a");
    expect(view.wrapper.get("details").attributes("open")).toBeUndefined();
  });

  it("切换会话即清旧结果，忽略晚到响应", async () => {
    let resolveOld!: (items: readonly RelaySessionDelegation[]) => void;
    const read = vi.fn((id: string) => id === "old"
      ? new Promise<readonly RelaySessionDelegation[]>((resolve) => { resolveOld = resolve; })
      : Promise.resolve([{ ...row, objective: "新会话的任务" }]));
    const client = { workspaceId: "workspace", getAssistSessionDelegations: read };
    const view = await mountReact(<SessionDelegations client={client} sessionId="old" />);
    dispose = view.unmount;
    await view.rerender(<SessionDelegations client={client} sessionId="new" />);
    await act(async () => { resolveOld([{ ...row, objective: "旧会话的任务" }]); });
    expect(view.wrapper.text()).toContain("新会话的任务");
    expect(view.wrapper.text()).not.toContain("旧会话的任务");
  });

  it("读取失败有可重试入口，不把失败当成没有协作", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("断线")).mockResolvedValueOnce([row]);
    const client = { workspaceId: "workspace", getAssistSessionDelegations: read };
    const view = await mountReact(<SessionDelegations client={client} sessionId="parent" />);
    dispose = view.unmount;
    expect(view.wrapper.text()).toContain("读取失败");
    await view.wrapper.get('[data-testid="session-delegations-retry"]').trigger("click");
    expect(view.wrapper.text()).toContain(row.resultSummary);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("没有委派时不占空间，旧客户端不尝试读取", async () => {
    const client = { workspaceId: "workspace", getAssistSessionDelegations: vi.fn().mockResolvedValue([]) };
    const view = await mountReact(<SessionDelegations client={client} sessionId="parent" />);
    dispose = view.unmount;
    expect(view.wrapper.text()).toBe("");
    await view.rerender(<SessionDelegations client={{ workspaceId: "workspace" }} sessionId="parent" />);
    expect(view.wrapper.text()).toBe("");
  });

  it("在途委派刷新并在卸载后停止", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue([{ ...row, status: "RUNNING", resultSummary: null }]);
    const view = await mountReact(<SessionDelegations
      client={{ workspaceId: "workspace", getAssistSessionDelegations: read }} sessionId="parent" />);
    dispose = view.unmount;
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(read).toHaveBeenCalledTimes(2);
    view.unmount(); dispose = undefined;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("旧委派可无子会话，但非法状态不能进入界面", () => {
    const raw = { delegation_id: "d", child_session_id: null, role: "REVIEW", objective: "审查",
      scope: [], baseline: "baseline", required: true, status: "FAILED", attempt_count: 1,
      max_attempts: 2, result_summary: null, created_at: "2026-10-30", closed_at: "2026-10-30" };
    expect(sessionDelegationFrom(raw).childSessionId).toBeNull();
    expect(() => sessionDelegationFrom({ ...raw, status: "COMPLETED" })).toThrow();
  });
});
