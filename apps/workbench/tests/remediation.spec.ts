import { afterEach, describe, expect, it } from "vitest";
import { fixtureAdapter } from "../src/fixtures/fixtureAdapter";
import { flush, mountWorkbench } from "./mountApp";

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("R02 前端正确性回归", () => {
  it("FE-01：没有对应 Skill fixture 的任务不会显示或写入固定示例定义", async () => {
    const mounted = await mountWorkbench("/tasks/task-recovery-logic?skill=definition");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("尚未提供任务定义示例");
    expect(mounted.wrapper.text()).not.toContain("确定实验评价指标");
    expect(mounted.wrapper.find('[data-testid="definition-accept"]').exists()).toBe(false);
  });

  it("FE-02：同一成功创建意图不能在第二次保存时产生第二个任务", async () => {
    const mounted = await mountWorkbench("/tasks?view=create");
    unmount = mounted.unmount;

    await mounted.wrapper.get('input[name="task-title"]').setValue("只应创建一次的任务");
    await mounted.wrapper.get('input[name="task-expected-result"]').setValue("一份结果。");
    await mounted.wrapper.get('textarea[name="task-acceptance"]').setValue("可以核对");
    await mounted.wrapper.get('[data-testid="task-create-save"]').trigger("click");
    await flush(80);

    expect(fixtureAdapter.getCallCount("createTask")).toBe(1);
    expect(mounted.wrapper.find('[data-testid="task-create-save"]').exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="task-created-result"]').text()).toContain("不能再次保存");
    await mounted.router.push("/tasks");
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("FE-02：同一 command ID 可核对丢失响应、未提交与仍未知，且不能重复创建", async () => {
    const draft = {
      title: "回执核对任务",
      projectId: null,
      expectedResult: "一份结果。",
      acceptanceCriteria: "可核对",
      startIntent: "ME" as const,
      dependencyId: null
    };
    const responseLostId = fixtureAdapter.createCommandId("task");

    await expect(fixtureAdapter.createTask(draft, "response-lost", "ready", responseLostId)).rejects.toThrow("响应在本次演示中丢失");
    const applied = await fixtureAdapter.lookupReceipt(responseLostId);
    expect(applied.status).toBe("APPLIED");
    expect(applied.resourceId).toBeTruthy();

    const replay = await fixtureAdapter.createTask(draft, "normal", "ready", responseLostId);
    expect(replay.taskId).toBe(applied.resourceId);
    const created = await fixtureAdapter.listTasks(
      { projectId: "all", status: "all", mode: "all", query: "回执核对任务" },
      "normal"
    );
    expect(created).toHaveLength(1);

    expect((await fixtureAdapter.lookupReceipt(fixtureAdapter.createCommandId("task"))).status).toBe("NOT_SUBMITTED");

    const unknownId = fixtureAdapter.createCommandId("task");
    await expect(fixtureAdapter.createTask(draft, "timeout", "ready", unknownId)).rejects.toThrow("原 command ID");
    expect((await fixtureAdapter.lookupReceipt(unknownId)).status).toBe("UNKNOWN");
  });

  it("FE-03：切换所属项目会清掉旧项目依赖，并从项目任务页预填当前项目", async () => {
    const mounted = await mountWorkbench("/tasks?view=create");
    unmount = mounted.unmount;

    const project = mounted.wrapper.get('select[name="task-project"]');
    await project.setValue("project-hci");
    await flush();
    await mounted.wrapper.get('select[name="task-dependency"]').setValue("task-evaluation-metrics");
    await project.setValue("project-workflow-os");
    await flush();
    expect((mounted.wrapper.get('select[name="task-dependency"]').element as HTMLSelectElement).value).toBe("");

    mounted.unmount();
    unmount = null;
    const projectTasks = await mountWorkbench("/projects/project-hci/tasks");
    unmount = projectTasks.unmount;
    await flush();
    await projectTasks.wrapper.get('a[href="/tasks?view=create&project=project-hci"]').trigger("click");
    await flush();
    expect((projectTasks.wrapper.get('select[name="task-project"]').element as HTMLSelectElement).value).toBe("project-hci");
  });

  it("FE-03：adapter 拒绝跨项目依赖时不留下半成品任务", async () => {
    const before = await fixtureAdapter.listTasks(
      { projectId: "all", status: "all", mode: "all", query: "跨项目依赖不应写入" },
      "normal"
    );
    const commandId = fixtureAdapter.createCommandId("task");

    await expect(
      fixtureAdapter.createTask(
        {
          title: "跨项目依赖不应写入",
          projectId: "project-workflow-os",
          expectedResult: "不应有任务。",
          acceptanceCriteria: "不应创建",
          startIntent: "ME",
          dependencyId: "task-evaluation-metrics"
        },
        "normal",
        "ready",
        commandId
      )
    ).rejects.toThrow("必须与新任务属于同一项目");

    const after = await fixtureAdapter.listTasks(
      { projectId: "all", status: "all", mode: "all", query: "跨项目依赖不应写入" },
      "normal"
    );
    expect(after).toEqual(before);
  });

  it("FE-03：adapter 在写入前拒绝缺少任务名称", async () => {
    await expect(
      fixtureAdapter.createTask(
        {
          title: "   ",
          projectId: null,
          expectedResult: "无",
          acceptanceCriteria: "无",
          startIntent: "ME",
          dependencyId: null
        },
        "normal",
        "inbox",
        fixtureAdapter.createCommandId("task")
      )
    ).rejects.toThrow("任务名称不能为空");
  });

  it("R03：创建、标记可开始和开始执行分别推进十进制 revision", async () => {
    const draft = {
      title: "版本推进任务",
      projectId: null,
      expectedResult: "一份可核对的结果。",
      acceptanceCriteria: "可判断",
      startIntent: "ME" as const,
      dependencyId: null
    };

    const inbox = await fixtureAdapter.createTask(draft, "normal", "inbox", fixtureAdapter.createCommandId("task"));
    expect(inbox.receipt.revision).toBe("0");

    const ready = await fixtureAdapter.createTask(
      { ...draft, title: "版本推进可开始任务" },
      "normal",
      "ready",
      fixtureAdapter.createCommandId("task")
    );
    expect(ready.status).toBe("READY");
    expect(ready.receipt.revision).toBe("1");

    const started = await fixtureAdapter.startTask(ready.taskId, "normal");
    expect(started.revision).toBe("2");
  });

  it("FE-04：两个创建页的草稿在同路由 query 切换前要求明确保留或放弃", async () => {
    const mounted = await mountWorkbench("/projects?view=create");
    unmount = mounted.unmount;

    await mounted.wrapper.get('input[name="project-title"]').setValue("不能静默丢失的草稿");
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);
    await mounted.router.push("/projects?archived=1");
    await flush();

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("保留未保存的修改");
    expect(mounted.router.currentRoute.value.query.view).toBe("create");

    mounted.unmount();
    unmount = null;
    const task = await mountWorkbench("/tasks?view=create");
    unmount = task.unmount;
    await task.wrapper.get('input[name="task-title"]').setValue("任务草稿也不能静默丢失");
    await task.router.push("/tasks?tab=inbox");
    await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("保留未保存的修改");
    expect(task.router.currentRoute.value.query.view).toBe("create");
  });
});
