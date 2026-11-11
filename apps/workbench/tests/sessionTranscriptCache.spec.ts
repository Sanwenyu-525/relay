import { afterEach, describe, expect, it } from "vitest";
import {
  clearSessionTranscriptCache, dropCachedSessionTranscript, readCachedSessionTranscript,
  writeCachedSessionTranscript,
} from "../src/lib/sessionTranscriptCache";
import type { RelayAssistMessage, RelayAssistProposal } from "../src/api/relayClient";

/**
 * 会话转录展示缓存（2026-11-10）：只用于重挂载时同步初始化，不参与业务判断。
 * 这里锁住身份隔离、LRU 上限与 403/404 后的丢弃。
 */

const message = (id: string): RelayAssistMessage =>
  ({ id, sessionId: "s1" } as unknown as RelayAssistMessage);
const proposal = (id: string): RelayAssistProposal =>
  ({ id, sessionId: "s1" } as unknown as RelayAssistProposal);

afterEach(() => { clearSessionTranscriptCache(); });

describe("sessionTranscriptCache", () => {
  it("按 workspace + session 隔离，只返回写过的内容", () => {
    writeCachedSessionTranscript("w1", "s1", { messages: [message("m1")], proposals: [] });
    expect(readCachedSessionTranscript("w1", "s1")?.messages.map((item) => item.id))
      .toEqual(["m1"]);
    expect(readCachedSessionTranscript("w2", "s1")).toBeNull();
    expect(readCachedSessionTranscript("w1", "s2")).toBeNull();
  });

  it("最多保留 12 条，最久未用的先淘汰", () => {
    for (let index = 0; index < 12; index += 1) {
      writeCachedSessionTranscript("w1", `s${index}`,
        { messages: [message(`m${index}`)], proposals: [proposal(`p${index}`)] });
    }
    // 读一次 s0，让它变成最近使用；再写第 13 条时被淘汰的应是 s1。
    expect(readCachedSessionTranscript("w1", "s0")).not.toBeNull();
    writeCachedSessionTranscript("w1", "s12", { messages: [], proposals: [] });
    expect(readCachedSessionTranscript("w1", "s0")).not.toBeNull();
    expect(readCachedSessionTranscript("w1", "s1")).toBeNull();
    expect(readCachedSessionTranscript("w1", "s12")).not.toBeNull();
  });

  it("服务端否认这段内容后丢弃缓存，避免下次切换又显示一遍", () => {
    writeCachedSessionTranscript("w1", "s1", { messages: [message("m1")], proposals: [] });
    dropCachedSessionTranscript("w1", "s1");
    expect(readCachedSessionTranscript("w1", "s1")).toBeNull();
  });
});
