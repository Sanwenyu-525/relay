import { describe, expect, it } from "vitest";
import { readPendingWork, type PendingWorkClient } from "../src/lib/usePendingWork";

function client(over: Partial<PendingWorkClient> = {}): PendingWorkClient {
  return {
    getProjectGoals: async () => [],
    getReviews: async () => [],
    getAssistSessions: async () => [],
    getInboxTasksPage: async () => ({ items: [], nextCursor: null }),
    ...over
  };
}

describe("待你处理 · 按工作区取数", () => {
  it("全局：全部待判断 + 未归属任务", async () => {
    const items = await readPendingWork(client({
      getReviews: async () => [
        { status: "OPEN", projectId: "p1" },
        { status: "OPEN", projectId: "p2" },
        { status: "DECIDED", projectId: "p1" }
      ],
      getInboxTasksPage: async () => ({ items: [{}, {}], nextCursor: null })
    }), "GLOBAL", null, null);
    expect(items.map((item) => item.label)).toEqual(["2 项待判断", "2 个未归属任务"]);
    expect(items[0]!.href).toBe("/reviews");
    expect(items[1]!.href).toBe("/tasks?inbox=true");
  });

  it("项目：目标 + 只数本项目的待判断", async () => {
    const items = await readPendingWork(client({
      getProjectGoals: async () => [{ title: "完成论文闭环" }],
      getReviews: async () => [
        { status: "OPEN", projectId: "p1" },
        { status: "OPEN", projectId: "p1" },
        { status: "OPEN", projectId: "p2" }
      ]
    }), "PROJECT", "p1", null);
    expect(items.map((item) => item.label)).toEqual(["目标：完成论文闭环", "2 项待判断"]);
    expect(items[1]!.href).toBe("/reviews?project_id=p1");
  });

  it("文件夹：只报该目录未读讨论，并取最近一条作为入口", async () => {
    const items = await readPendingWork(client({
      getAssistSessions: async () => [
        { id: "s-old", workingResourceId: "res-1", unreadAt: "2026-10-01T00:00:00Z" },
        { id: "s-new", workingResourceId: "res-1", unreadAt: "2026-10-18T00:00:00Z" },
        { id: "s-read", workingResourceId: "res-1", unreadAt: null },
        { id: "s-other", workingResourceId: "res-2", unreadAt: "2026-10-18T00:00:00Z" }
      ]
    }), "FOLDER", null, "res-1");
    expect(items).toEqual([{ key: "unread", label: "2 条未读讨论", href: "/agent?session=s-new" }]);
  });

  it("空结果返回空数组，组件据此整条隐藏", async () => {
    expect(await readPendingWork(client(), "GLOBAL", null, null)).toEqual([]);
    expect(await readPendingWork(client(), "FOLDER", null, "res-empty")).toEqual([]);
  });
});
