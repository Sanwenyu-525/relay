import { useEffect, useRef, useState } from "react";
import { RelayApiError, type RelayApiClient, type RelayRunDraftPreview } from "../api/relayClient";

/**
 * Run DRAFT 生成中草稿的只读轮询。草稿不是不可变产物版本，也不代表验证通过或任务完成；
 * 同一 attempt/epoch/model call 身份内更新不抢焦点，身份变化时先让旧文本退出再接入新文本。
 */
export function useRunDraftPreview({ client, runId, revision, currentStepId, enabled, onSettled }: {
  client: RelayApiClient | null;
  runId: string;
  revision: string;
  currentStepId: string | null;
  enabled: boolean;
  onSettled?: () => void;
}): RelayRunDraftPreview | null {
  const [preview, setPreview] = useState<RelayRunDraftPreview | null>(null);
  const previewRef = useRef<RelayRunDraftPreview | null>(null);
  const identity = useRef<string | null>(null);
  const settled = useRef(onSettled); settled.current = onSettled;

  useEffect(() => {
    previewRef.current = null; identity.current = null; setPreview(null);
    if (!enabled || !client) return;
    const scope = runId;
    const active0 = client;
    let active = true;
    let timer: number | undefined;
    async function poll() {
      let delay = 400;
      try {
        const next = await active0.getRunDraftPreview(scope);
        if (!active) return;
        if (next.runStatus !== "RUNNING" || !next.previewAvailable) {
          previewRef.current = null; identity.current = null; setPreview(null);
          if (next.runStatus === "COMPLETED" || next.runStatus === "FAILED" || next.runStatus === "CANCELLED") {
            active = false; settled.current?.();
          }
        } else {
          const nextIdentity = `${next.stepAttemptId}:${next.attemptClaimEpoch}:${next.modelCallId ?? "none"}`;
          if (nextIdentity !== identity.current) {
            const hadText = previewRef.current !== null;
            previewRef.current = null; setPreview(null); identity.current = nextIdentity;
            // 换 attempt 时先让旧草稿退出，避免把上一轮的文本当成这一轮的新进展。
            if (hadText) { timer = window.setTimeout(() => { void poll(); }, 400); return; }
          }
          if (next.previewText === null) { previewRef.current = null; setPreview(null); }
          else if (previewRef.current === null || BigInt(next.previewRevision) >= BigInt(previewRef.current.previewRevision)) {
            previewRef.current = next; setPreview(next);
          }
        }
      } catch (caught) {
        if (!active) return;
        previewRef.current = null; identity.current = null; setPreview(null);
        if (caught instanceof RelayApiError && (caught.problem.status === 404 || caught.problem.status === 403)) {
          active = false; settled.current?.();
        } else delay = 1000;
      }
      if (active) timer = window.setTimeout(() => { void poll(); }, delay);
    }
    void poll();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [client, runId, revision, currentStepId, enabled]);

  return preview;
}
