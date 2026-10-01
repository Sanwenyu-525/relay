import { afterEach, expect, it, vi } from "vitest";
import { fixtureAdapter } from "../src/fixtures/fixtureAdapter";
import { resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { DomWrapper, flush, mountWorkbench } from "./mountApp";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it("任务校验失败聚焦首个错误，继续输入不跳焦点或提交", async () => {
  const mounted = await mountWorkbench("/tasks?view=create");
  unmount = mounted.unmount;
  const save = mounted.wrapper.get('[data-testid="task-create-save"]');
  (save.element as HTMLButtonElement).focus();
  await save.trigger("click");
  const title = mounted.wrapper.get('input[name="task-title"]');
  expect(document.activeElement).toBe(title.element);
  expect(title.attributes("aria-invalid")).toBe("true");
  await title.setValue("保留正在编辑的标题");
  expect(document.activeElement).toBe(title.element);
  expect(fixtureAdapter.getCallCount("createTask")).toBe(0);
  await save.trigger("click");
  expect(document.activeElement).toBe(mounted.wrapper.get('input[name="task-expected-result"]').element);
  expect((title.element as HTMLInputElement).value).toBe("保留正在编辑的标题");
});

it("任务创建结果接收焦点，避免提交后焦点落回整页", async () => {
  const mounted = await mountWorkbench("/tasks?view=create");
  unmount = mounted.unmount;
  await mounted.wrapper.get('input[name="task-title"]').setValue("可访问的创建结果");
  await mounted.wrapper.get('input[name="task-expected-result"]').setValue("一份结果");
  await mounted.wrapper.get('textarea[name="task-acceptance"]').setValue("结果可以核对");
  await mounted.wrapper.get('[data-testid="task-create-save"]').trigger("click");
  await flush(80);
  expect(fixtureAdapter.getCallCount("createTask")).toBe(1);
  expect(document.activeElement).toBe(mounted.wrapper.get('[data-testid="task-created-result"] h2').element);
});

it("创建的迟到结果不抢走已打开命令面板的焦点", async () => {
  let release: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const createTask = fixtureAdapter.createTask.bind(fixtureAdapter);
  vi.spyOn(fixtureAdapter, "createTask").mockImplementation(async (...args) => {
    await waiting;
    return createTask(...args);
  });
  const mounted = await mountWorkbench("/tasks?view=create");
  unmount = mounted.unmount;
  await mounted.wrapper.get('input[name="task-title"]').setValue("迟到结果");
  await mounted.wrapper.get('input[name="task-expected-result"]').setValue("一份结果");
  await mounted.wrapper.get('textarea[name="task-acceptance"]').setValue("可核对");
  await mounted.wrapper.get('[data-testid="task-create-save"]').trigger("click");
  await mounted.wrapper.get('[data-testid="titlebar-search"]').trigger("click");
  await flush();
  const search = document.querySelector<HTMLInputElement>('[data-testid="command-search"]')!;
  expect(document.activeElement === search).toBe(true);
  release();
  await flush(80);
  expect(mounted.wrapper.find('[data-testid="task-created-result"]').exists()).toBe(true);
  expect(document.activeElement === search).toBe(true);
  expect(fixtureAdapter.getCallCount("createTask")).toBe(1);
});

it("readiness 检查冻结对应输入，失败后恢复编辑并保留输入", async () => {
  let rejectReady: (reason: Error) => void = () => undefined;
  const ready = new Promise<Response>((_resolve, reject) => { rejectReady = reject; });
  const fetchStub = vi.fn(async () => ready);
  vi.stubGlobal("fetch", fetchStub);
  const mounted = await mountWorkbench("/projects");
  unmount = mounted.unmount;
  await mounted.wrapper.get('[data-testid="relay-connection-open"]').trigger("click");
  const page = new DomWrapper(document.body);
  await page.get('input[name="relay-workspace-id"]').setValue("11111111-1111-4111-8111-111111111111");
  await page.get('input[name="relay-bearer-token"]').setValue("test-token");
  await page.get('[data-testid="relay-connect"]').trigger("click");
  for (const name of ["relay-base-url", "relay-workspace-id", "relay-bearer-token"]) {
    expect((page.get(`input[name="${name}"]`).element as HTMLInputElement).disabled).toBe(true);
  }
  expect(page.get('[data-testid="relay-connect"]').attributes("aria-busy")).toBe("true");
  rejectReady(new Error("readiness unavailable"));
  await flush();
  expect(fetchStub).toHaveBeenCalledOnce();
  expect((page.get('input[name="relay-workspace-id"]').element as HTMLInputElement).disabled).toBe(false);
  expect((page.get('input[name="relay-workspace-id"]').element as HTMLInputElement).value).toBe("11111111-1111-4111-8111-111111111111");
  expect(page.get('[data-testid="relay-connection-error"]').text()).not.toBe("");
});
