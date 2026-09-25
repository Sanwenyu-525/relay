/** SSE carries a refresh hint, never a business fact. Keep parsing bounded even for large output. */
const MAX_LINE_LENGTH = 64 * 1024;
const MAX_EVENT_DATA_LENGTH = 256 * 1024;

export function isRunEventCursor(value: string): boolean {
  return /^(0|[1-9]\d{0,18})$/.test(value)
    && (value.length < 19 || value <= "9223372036854775807");
}

export async function readRunEventHints(
  body: ReadableStream<Uint8Array>,
  after: string,
  signal: AbortSignal,
  onEvent: (seq: string) => void
): Promise<void> {
  if (!isRunEventCursor(after)) throw new Error("执行事件游标无效。");
  let cursor = BigInt(after);
  let line = "";
  let lineTooLong = false;
  let skipNextLf = false;
  let frameId: string | null = null;
  let frameData = "";
  let hasData = false;
  let largeData = false;
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });

  function clearFrame(): void {
    frameId = null;
    frameData = "";
    hasData = false;
    largeData = false;
  }

  function finishFrame(): void {
    if (!hasData) { clearFrame(); return; }
    if (frameId === null || !isRunEventCursor(frameId)) throw new Error("执行事件缺少有效序号。");
    if (!largeData) {
      try { JSON.parse(frameData.slice(0, -1)); }
      catch { throw new Error("执行事件数据不是完整 JSON。"); }
    }
    const seq = BigInt(frameId);
    if (seq > cursor) {
      if (seq !== cursor + 1n) throw new Error("执行事件序号不连续，需补读历史。");
      cursor = seq;
      onEvent(seq.toString());
    }
    clearFrame();
  }

  function finishLine(): void {
    if (lineTooLong) {
      if (line.startsWith("data:")) { hasData = true; largeData = true; }
      else throw new Error("执行事件行超出限制。");
    } else if (line === "") {
      finishFrame();
    } else if (!line.startsWith(":")) {
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const rawValue = separator < 0 ? "" : line.slice(separator + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "id") frameId = value;
      if (field === "data") {
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
        if (line || lineTooLong || hasData || frameId !== null) throw new Error("执行事件帧尚未完整时连接已断开。");
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
