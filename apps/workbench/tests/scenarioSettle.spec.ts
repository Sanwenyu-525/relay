import { describe, expect, it } from "vitest";
import { settleScenarioPreview, type PreviewReading } from "../src/dev/scenarioSettle";

/** 用可注入的时钟与读取序列覆盖「迟到响应 / 反复更新 / 持续加载 / 取消」四种停稳边界。 */
function harness(readings: readonly (PreviewReading | null)[], options?: {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly stableReads?: number;
}) {
  const token = { cancelled: false };
  let time = 0;
  let index = 0;
  const outcome = settleScenarioPreview({
    expectedId: "A05",
    token,
    read: () => readings[Math.min(index++, readings.length - 1)] ?? null,
    wait: async (ms) => { time += ms; },
    now: () => time,
    timeoutMs: options?.timeoutMs ?? 1_000,
    intervalMs: options?.intervalMs ?? 80,
    stableReads: options?.stableReads ?? 2
  });
  return { token, outcome };
}

describe("预览停稳判定", () => {
  it("连续三次同一读数才返回稳定", async () => {
    const reading = { scenarioId: "A05", text: "这次没有动任何文件" };
    const { outcome } = harness([reading, reading, reading]);
    const result = await outcome;
    expect(result.status).toBe("ok");
  });

  it("迟到响应：先空、再加载、最后稳定，仍然可以判稳", async () => {
    const loading = { scenarioId: "A05", text: "正在执行" };
    const final = { scenarioId: "A05", text: "正文已经落位" };
    const { outcome } = harness([null, loading, loading, final, final, final]);
    const result = await outcome;
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.reading.text).toBe("正文已经落位");
  });

  it("反复更新导致稳定条件不成立，超时返回 unstable 而不是当前 DOM", async () => {
    const readings = Array.from({ length: 30 }, (_, index) => ({
      scenarioId: "A05", text: `流式片段 ${String(index)}`
    }));
    const { outcome } = harness(readings);
    const result = await outcome;
    expect(result.status).toBe("timeout");
    if (result.status === "timeout") expect(result.kind).toBe("unstable");
  });

  it("持续加载：预览一直没挂上，超时返回 unmounted", async () => {
    const { outcome } = harness([null]);
    const result = await outcome;
    expect(result.status).toBe("timeout");
    if (result.status === "timeout") expect(result.kind).toBe("unmounted");
  });

  it("身份不符：挂的是别的场景，超时返回 identity 而不是拿残留读结果", async () => {
    const { outcome } = harness([{ scenarioId: "B01", text: "上一条场景" }]);
    const result = await outcome;
    expect(result.status).toBe("timeout");
    if (result.status === "timeout") expect(result.kind).toBe("identity");
  });

  it("取消与超时是两种结果，取消不产生读数", async () => {
    const token = { cancelled: false };
    let time = 0;
    let reads = 0;
    const outcome = settleScenarioPreview({
      expectedId: "A05",
      token,
      read: () => {
        reads += 1;
        token.cancelled = true;
        return { scenarioId: "A05", text: "还在写" };
      },
      wait: async (ms) => { time += ms; },
      now: () => time,
      timeoutMs: 1_000,
      intervalMs: 80
    });
    const result = await outcome;
    expect(result.status).toBe("cancelled");
    expect(reads).toBe(1);
  });
});
