import { describe, expect, it } from "vitest";
import type { RelayHttp } from "../src/api/core/http";
import {
  createScheduledTask, getScheduledTask, getScheduledTasks, setScheduledTaskStatus,
} from "../src/api/resources/scheduledTasks";
import { describeRepeat, formatInZone } from "../src/views/ScheduledTasksView";

const taskRow = {
  scheduled_task_id: "11111111-1111-4111-8111-111111111111",
  project_id: "22222222-2222-4222-8222-222222222222",
  status: "ENABLED",
  revision: "3",
  schedule_generation: "1",
  next_due_at: "2026-10-19T01:00:00.000Z",
  title: "每早整理昨日进展",
  template: { task_title: "整理昨日进展", objective: "输出一页进展摘要", criteria: [{ statement: "覆盖三项进展" }], mode: "AI_ASSIST" },
  repeat_rule: { kind: "WEEKLY", weekdays: [5, 1] },
  timezone: "Asia/Shanghai",
  local_time: "09:00",
  first_run_at: "2026-10-19T01:00:00.000Z",
  max_runs: 10,
  runs_reserved: 3,
  runs_started: 2,
  authorization_expires_at: "2026-11-18T01:00:00.000Z",
  history: [],
  created_at: "2026-10-18T00:00:00.000Z",
  project: { title: "毕业论文", revision: "7", archived: false },
};

function fakeHttp(respond: (path: string) => unknown): { http: RelayHttp; calls: { path: string; body?: string }[] } {
  const calls: { path: string; body?: string }[] = [];
  const http = {
    workspacePath: (path: string) => path,
    request: async (path: string, init?: { body?: string }) => {
      calls.push(init?.body === undefined ? { path } : { path, body: init.body });
      return respond(path);
    },
  } as unknown as RelayHttp;
  return { http, calls };
}

describe("定时任务响应解析", () => {
  it("列表按快照解析并规范化星期顺序", async () => {
    const { http } = fakeHttp(() => ({ project_id: null, items: [taskRow] }));
    const items = await getScheduledTasks(http);
    expect(items).toHaveLength(1);
    expect(items[0]!.repeat).toEqual({ kind: "WEEKLY", weekdays: [5, 1] });
    expect(items[0]!.template.taskTitle).toBe("整理昨日进展");
    expect(items[0]!.template.criteria).toEqual(["覆盖三项进展"]);
    expect(items[0]!.project?.title).toBe("毕业论文");
    expect(items[0]!.runsStarted).toBe(2);
  });

  it("未知状态与未知重复类型显式失败，不静默降级", async () => {
    const { http } = fakeHttp(() => ({ project_id: null, items: [{ ...taskRow, status: "WEIRD" }] }));
    await expect(getScheduledTasks(http)).rejects.toThrow(/未知状态/u);
    const bad = fakeHttp(() => ({ project_id: null, items: [{ ...taskRow, repeat_rule: { kind: "MONTHLY" } }] }));
    await expect(getScheduledTasks(bad.http)).rejects.toThrow(/无法识别/u);
  });

  it("详情带上触发历史，并核对身份", async () => {
    const { http } = fakeHttp(() => ({
      ...taskRow,
      occurrences: [{
        occurrence_id: "33333333-3333-4333-8333-333333333333",
        scheduled_task_id: taskRow.scheduled_task_id,
        project_id: taskRow.project_id,
        sequence: "2", due_at: "2026-10-18T01:00:00.000Z", timezone: "Asia/Shanghai",
        missed: true, status: "BLOCKED", task_id: null, run_id: null, reason: "MISSED",
        revision: "1", created_at: "2026-10-18T01:00:00.000Z",
      }],
    }));
    const detail = await getScheduledTask(http, taskRow.scheduled_task_id);
    expect(detail.occurrences[0]!.status).toBe("BLOCKED");
    expect(detail.occurrences[0]!.missed).toBe(true);
    await expect(getScheduledTask(http, "44444444-4444-4444-8444-444444444444")).rejects.toThrow(/身份不匹配/u);
  });

  it("创建把模板与规则翻成 snake_case，并核对回执身份", async () => {
    const { http, calls } = fakeHttp(() => ({
      command_id: "55555555-5555-4555-8555-555555555555",
      committed_at: "2026-10-18T00:00:00.000Z",
      result: { ...taskRow, scheduled_task_id: taskRow.scheduled_task_id },
    }));
    await createScheduledTask(http, {
      commandId: "55555555-5555-4555-8555-555555555555",
      projectId: taskRow.project_id,
      title: "每早整理昨日进展",
      template: { taskTitle: "整理昨日进展", objective: "输出一页进展摘要", criteria: ["覆盖三项进展"], mode: "AI_ASSIST" },
      repeat: { kind: "DAILY", intervalDays: 2 },
      timezone: "Asia/Shanghai", localTime: "09:00", firstLocalDate: "2026-10-19",
      maxRuns: 10, authorizationExpiresAt: "2026-11-18T01:00:00.000Z", confirmed: true,
    });
    const body = JSON.parse(calls[0]!.body ?? "{}") as Record<string, unknown>;
    expect(calls[0]!.path).toBe(`/projects/${taskRow.project_id}/scheduled-tasks`);
    expect(body.repeat_rule).toEqual({ kind: "DAILY", interval_days: 2 });
    expect(body.first_local_date).toBe("2026-10-19");
    expect((body.template as { criteria: unknown }).criteria).toEqual([{ statement: "覆盖三项进展" }]);

    const mismatched = fakeHttp(() => ({
      command_id: "55555555-5555-4555-8555-555555555555",
      committed_at: "2026-10-18T00:00:00.000Z",
      result: { ...taskRow, scheduled_task_id: "99999999-9999-4999-8999-999999999999" },
    }));
    await expect(setScheduledTaskStatus(mismatched.http, {
      commandId: "55555555-5555-4555-8555-555555555555",
      scheduledTaskId: taskRow.scheduled_task_id, expectedRevision: "3", status: "PAUSED", reason: "暂停",
    })).rejects.toThrow(/不匹配/u);
  });
});

describe("定时任务显示", () => {
  it("重复规则与触发时刻按任务自身时区呈现", () => {
    expect(describeRepeat({ repeat: { kind: "DAILY", intervalDays: 1 } } as never)).toBe("每天");
    expect(describeRepeat({ repeat: { kind: "DAILY", intervalDays: 3 } } as never)).toBe("每 3 天");
    expect(describeRepeat({ repeat: { kind: "WEEKLY", weekdays: [1, 5] } } as never)).toBe("每周 周一、周五");
    expect(formatInZone("2026-10-19T01:00:00.000Z", "Asia/Shanghai")).toContain("09:00");
    expect(formatInZone("2026-10-19T01:00:00.000Z", "UTC")).toContain("01:00");
  });
});
