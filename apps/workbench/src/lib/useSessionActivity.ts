import { useEffect, useRef, useState } from "react";

import type { RelayApiClient } from "../api/relayClient";
import type { RelayExecutionActivitySnapshot } from "../api/dtos/assist";

/**
 * ENG-OBS-02 P0-C：会话执行活动的唯一轮询 Owner。
 *
 * 只消费服务端快照：初始读 full，在途期间读 summary；summary 的
 * content_fingerprint 变化才补读 full。单飞 + 请求代次保证迟到的旧响应
 * 不覆盖新事实。终态停止轮询；读失败保留上一份快照。
 */
export function useSessionActivity(input: {
  client: RelayApiClient; sessionId: string; active: boolean; enabled?: boolean;
}): {
  snapshot: RelayExecutionActivitySnapshot | null;
  error: string | null;
  reload: () => void;
} {
  const [snapshot, setSnapshot] = useState<RelayExecutionActivitySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const sessionRef = useRef(input.sessionId);
  const generation = useRef(0);
  const mounted = useRef(true);
  const snapshotRef = useRef<RelayExecutionActivitySnapshot | null>(null);

  sessionRef.current = input.sessionId;
  snapshotRef.current = snapshot;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);

  useEffect(() => {
    if (input.enabled === false) return;
    const sessionId = input.sessionId;
    generation.current += 1;
    const requestGeneration = generation.current;
    let disposed = false;
    let timer: number | null = null;
    let busy = false;

    const fingerprints = (value: RelayExecutionActivitySnapshot): string =>
      value.messages.map((message) => `${message.messageId}:${message.contentFingerprint}`).join("|");

    async function load(detail: "summary" | "full", force = false): Promise<void> {
      if (busy) return;
      busy = true;
      let upgrade = false;
      try {
        const next = await input.client.getAssistExecutionActivity({
          sessionId, limit: 200, detail,
        });
        if (!mounted.current || disposed || requestGeneration !== generation.current ||
          sessionRef.current !== sessionId) return;
        const previous = snapshotRef.current;
        if (!force && previous !== null && fingerprints(previous) === fingerprints(next)) {
          setError(null);
          return;
        }
        if (!force && previous !== null && detail === "summary") {
          upgrade = true;
          return;
        }
        setSnapshot(next);
        setError(null);
      } catch (caught) {
        if (!mounted.current || disposed || requestGeneration !== generation.current) return;
        // 读取失败不能清空已确认事实；只标记可能过期。
        setError(caught instanceof Error ? caught.message : "执行活动读取失败");
      } finally {
        busy = false;
        if (upgrade && mounted.current && !disposed) void load("full", true);
      }
    }

    void load("full", true);
    if (input.active) {
      timer = window.setInterval(() => { void load("summary"); }, 900);
    }
    return () => {
      disposed = true;
      generation.current += 1;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [input.client, input.sessionId, input.active, input.enabled, reloadKey]);

  return {
    snapshot,
    error,
    reload: () => setReloadKey((value) => value + 1),
  };
}
