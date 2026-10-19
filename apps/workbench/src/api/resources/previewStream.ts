import type { RelayHttp } from "../core/http";
import { RelayPreviewHttpError, RelayTransportError } from "../core/errors";
import { assistLivePreviewFrom } from "./assist";
import { runDraftPreviewFrom } from "./run";
import type { RelayAssistLivePreview } from "../dtos/assist";
import type { RelayRunDraftPreview } from "../dtos/run";

/** Bound the SSE parser even for large output, matching the run_events parser discipline. */
const MAX_LINE_LENGTH = 64 * 1024;
const MAX_EVENT_DATA_LENGTH = 256 * 1024;

export interface PreviewFrame {
  readonly id: string | null;
  readonly event: string | null;
  readonly data: string;
}

/**
 * Parse an SSE byte stream and invoke `onFrame` for each complete frame. Unlike the run_events
 * parser, this one does NOT assert cursor/sequence continuity: a preview `revision` can reset to 1
 * when the attempt/model call changes, so the only source of truth is the latest frame's full DTO.
 * The server pushes the current snapshot on connect (see http-command-contract.md §10.59).
 */
export async function readPreviewStream(body: ReadableStream<Uint8Array>,
  signal: AbortSignal, onFrame: (frame: PreviewFrame) => void): Promise<void> {
  let line = "";
  let lineTooLong = false;
  let skipNextLf = false;
  let frameId: string | null = null;
  let frameEvent: string | null = null;
  let frameData = "";
  let hasData = false;
  let largeData = false;
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });

  function clearFrame(): void {
    frameId = null;
    frameEvent = null;
    frameData = "";
    hasData = false;
    largeData = false;
  }

  function finishFrame(): void {
    if (hasData) onFrame({ id: frameId, event: frameEvent, data: frameData });
    clearFrame();
  }

  function finishLine(): void {
    if (lineTooLong) {
      if (line.startsWith("data:")) { hasData = true; largeData = true; }
      else throw new Error("预览事件行超出限制。");
    } else if (line === "") {
      finishFrame();
    } else if (!line.startsWith(":")) {
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const rawValue = separator < 0 ? "" : line.slice(separator + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "id") frameId = value;
      else if (field === "event") frameEvent = value;
      else if (field === "data") {
        hasData = true;
        if (!largeData) {
          if (frameData.length + value.length + 1 > MAX_EVENT_DATA_LENGTH) {
            frameData = "";
            largeData = true;
          } else frameData += `${value}\n`;
        }
      }
    }
    line = "";
    lineTooLong = false;
  }

  function pushText(text: string): void {
    for (const character of text) {
      if (skipNextLf) {
        skipNextLf = false;
        if (character === "\n") continue;
      }
      if (character === "\r") { finishLine(); skipNextLf = true; }
      else if (character === "\n") finishLine();
      else if (!lineTooLong) {
        if (line.length < MAX_LINE_LENGTH) line += character;
        else lineTooLong = true;
      }
    }
  }

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (signal.aborted) return;
      if (done) {
        pushText(decoder.decode());
        if (line || lineTooLong || hasData || frameId !== null || frameEvent !== null) {
          throw new Error("预览事件帧尚未完整时连接已断开。");
        }
        return;
      }
      for (let offset = 0; offset < value.length; offset += 16 * 1024) {
        pushText(decoder.decode(value.subarray(offset, offset + 16 * 1024), { stream: true }));
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** One authenticated SSE connection. The caller owns reconnects and authoritative GET refreshes. */
async function openPreviewStream(url: string, http: RelayHttp, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(`${http.baseUrl}${url}`, {
      headers: { Accept: "text/event-stream", Authorization: http.authHeader },
      cache: "no-store",
      signal
    });
  } catch {
    if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
    throw new RelayTransportError("预览事件连接中断。");
  }
}

/**
 * Subscribe to Run DRAFT generation-preview frames. Each `draft_preview` frame carries the full
 * `RelayRunDraftPreview` DTO; the caller dedups by identity + revision and degrades to GET on error.
 */
export async function readRunDraftPreviewStream(http: RelayHttp, runId: string, signal: AbortSignal,
  onPreview: (preview: RelayRunDraftPreview) => void, onOpen: () => void): Promise<void> {
  const response = await openPreviewStream(
    http.workspacePath(`/runs/${encodeURIComponent(runId)}/draft-preview/events`), http, signal);
  if (signal.aborted) return;
  if (!response.ok) throw new RelayPreviewHttpError(response.status);
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) {
    throw new RelayTransportError("服务端没有返回预览事件流。");
  }
  onOpen();
  await readPreviewStream(response.body, signal, (frame) => {
    if (frame.event === "draft_preview") {
      onPreview(runDraftPreviewFrom(JSON.parse(frame.data.slice(0, -1))));
    }
  });
}

/**
 * Subscribe to Assist DISCUSS generation-preview frames. Each `assist_preview` frame carries the
 * full `RelayAssistLivePreview` DTO (one stream per message).
 */
export async function readAssistLivePreviewStream(http: RelayHttp, sessionId: string, messageId: string,
  signal: AbortSignal, onPreview: (preview: RelayAssistLivePreview) => void, onOpen: () => void): Promise<void> {
  const response = await openPreviewStream(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/live-preview/events`),
    http, signal);
  if (signal.aborted) return;
  if (!response.ok) throw new RelayPreviewHttpError(response.status);
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) {
    throw new RelayTransportError("服务端没有返回预览事件流。");
  }
  onOpen();
  await readPreviewStream(response.body, signal, (frame) => {
    if (frame.event === "assist_preview") {
      onPreview(assistLivePreviewFrom(JSON.parse(frame.data.slice(0, -1)), sessionId, messageId));
    }
  });
}
