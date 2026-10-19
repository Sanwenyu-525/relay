import { useEffect, useRef, useState } from "react";
import { RelayApiError, type RelayApiClient, type RelayRunDraftPreview } from "../api/relayClient";
import { waitForEventRetry } from "./eventRetry";

/**
 * Run DRAFT 生成中草稿的只读预览。优先用 SSE 订阅（docs/api/http-command-contract.md §10.59），
 * 流不可用时降级回权威 GET 轮询。草稿不是不可变产物版本，也不代表验证通过或任务完成；
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
    const abort = new AbortController();
    let timer: number | undefined;
    let connectedOnce = false;
    let retryMs = 1_000;

    function consume(next: RelayRunDraftPreview): void {
      if (!active) return;
      if (next.runStatus !== "RUNNING" || !next.previewAvailable) {
        previewRef.current = null; identity.current = null; setPreview(null);
        if (next.runStatus === "COMPLETED" || next.runStatus === "FAILED" || next.runStatus === "CANCELLED") {
          active = false; settled.current?.();
        }
        return;
      }
      const nextIdentity = `${next.stepAttemptId}:${next.attemptClaimEpoch}:${next.modelCallId ?? "none"}`;
      if (nextIdentity !== identity.current) {
        const hadText = previewRef.current !== null;
        previewRef.current = null; setPreview(null); identity.current = nextIdentity;
        if (hadText) return; // 等下一帧/轮询补齐新身份下的内容
      }
      if (next.previewText === null) { previewRef.current = null; setPreview(null); }
      else if (previewRef.current === null || BigInt(next.previewRevision) >= BigInt(previewRef.current.previewRevision)) {
        previewRef.current = next; setPreview(next);
      }
    }

    function clear(): void {
      previewRef.current = null; identity.current = null; setPreview(null);
    }

    async function confirm(): Promise<void> {
      try {
        consume(await active0.getRunDraftPreview(scope));
      } catch (caught) {
        if (!active) return;
        clear();
        if (caught instanceof RelayApiError && (caught.problem.status === 404 || caught.problem.status === 403)) {
          active = false; settled.current?.();
        }
      }
    }

    function startPoll(): void {
      let delay = 400;
      const poll = async () => {
        if (!active) return;
        try {
          consume(await active0.getRunDraftPreview(scope));
          delay = 400;
        } catch (caught) {
          if (!active) return;
          // 与旧轮询一致：任何读取失败都先让草稿退出，避免把失权文本留在界面上。
          clear();
          if (caught instanceof RelayApiError && (caught.problem.status === 404 || caught.problem.status === 403)) {
            active = false; settled.current?.();
            return;
          }
          delay = 1_000;
        }
        if (active) timer = window.setTimeout(poll, delay);
      };
      void poll();
    }

    async function streamLoop(): Promise<void> {
      while (active && !abort.signal.aborted) {
        try {
          await active0.readRunDraftPreviewStream(scope, abort.signal,
            (next) => { connectedOnce = true; retryMs = 1_000; consume(next); }, () => {});
        } catch (caught) {
          if (!active || abort.signal.aborted) return;
          if (caught instanceof RelayApiError && [401, 403, 404].includes(caught.problem.status)) {
            active = false; settled.current?.();
            return;
          }
          // 初次连接即失败（网络/反代）直接切到权威 GET 轮询；连上过一次后再掉线则重连。
          if (!connectedOnce) { startPoll(); return; }
          connectedOnce = false;
        }
        if (!active || abort.signal.aborted) return;
        await confirm();
        if (!active || abort.signal.aborted) return;
        await waitForEventRetry(retryMs, abort.signal);
        retryMs = Math.min(retryMs * 2, 15_000);
      }
    }
    void streamLoop();
    return () => { active = false; abort.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [client, runId, revision, currentStepId, enabled]);

  return preview;
}
