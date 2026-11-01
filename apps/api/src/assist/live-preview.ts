import type { ModelUsageProgress } from '../workflow/fake-model-port.js';

/**
 * 生成中的 Token 进度发布器（AGENT_LIVE_TOKEN_USAGE，2026-11-01）。
 *
 * 它是**节流**而不是账本：Provider 每个 chunk 都可能推进一次估算，但界面只需要
 * 约 500ms 一档的读数。写入仍走预览行的所有者 CAS；消息结算、取消或换 Worker 之后
 * 写不进去，迟到的帧不会复活已删除的预览。
 *
 * 不在这里起定时器：只有在新的进度到达时才写入，生成停顿期间不会为了「维持数字」
 * 制造额外数据库写入。
 */
export class AssistLiveUsagePublisher {
  static readonly MIN_FLUSH_MS = 500;

  private pending: ModelUsageProgress | null = null;
  private lastFlushAt = 0;
  private writing = false;
  private stopped = false;

  constructor(private readonly write: (progress: ModelUsageProgress) => Promise<boolean>,
    private readonly onOwnershipLost: () => void) {}

  async push(progress: ModelUsageProgress): Promise<void> {
    if (this.stopped) return;
    this.pending = progress;
    if (this.writing || Date.now() - this.lastFlushAt < AssistLiveUsagePublisher.MIN_FLUSH_MS) {
      return;
    }
    await this.flush();
  }

  /** 调用结束前落最后一帧；停止后不再接受新的进度。 */
  async flush(): Promise<void> {
    if (this.stopped || this.writing) return;
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    this.writing = true;
    try {
      const wrote = await this.write(pending);
      if (!wrote) {
        this.stopped = true;
        this.onOwnershipLost();
        throw new AssistPreviewOwnershipLostError();
      }
      this.lastFlushAt = Date.now();
    } finally { this.writing = false; }
  }

  stop(): void {
    this.stopped = true;
    this.pending = null;
  }
}

/** A disposable, UTF-8-safe prefix for one in-flight plain DISCUSS response. */
export class AssistLivePreviewPublisher {
  static readonly MAX_BYTES = 16_384;
  static readonly MIN_FLUSH_MS = 100;

  private prefix = '';
  private bytes = 0;
  private trailingHighSurrogate = '';
  private truncated = false;
  private dirty = false;
  private lastFlushAt = 0;

  constructor(private readonly write: (text: string, truncated: boolean) => Promise<boolean>,
    private readonly onOwnershipLost: () => void) {}

  async push(piece: string): Promise<void> {
    if (piece === '' || this.truncated) return;
    let text = this.trailingHighSurrogate + piece;
    this.trailingHighSurrogate = '';
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) {
      this.trailingHighSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    for (const rawCharacter of text) {
      const code = rawCharacter.charCodeAt(0);
      const character = rawCharacter.length === 1 && code >= 0xD800 && code <= 0xDFFF
        ? '\uFFFD' : rawCharacter;
      const size = Buffer.byteLength(character, 'utf8');
      if (this.bytes + size > AssistLivePreviewPublisher.MAX_BYTES) {
        this.truncated = true;
        this.dirty = true;
        break;
      }
      this.prefix += character;
      this.bytes += size;
      this.dirty = true;
    }
    if (this.dirty && (this.lastFlushAt === 0 ||
        Date.now() - this.lastFlushAt >= AssistLivePreviewPublisher.MIN_FLUSH_MS)) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    const wrote = await this.write(this.prefix, this.truncated);
    if (!wrote) {
      this.onOwnershipLost();
      throw new AssistPreviewOwnershipLostError();
    }
    this.dirty = false;
    this.lastFlushAt = Date.now();
  }
}

export class AssistPreviewOwnershipLostError extends Error {
  override readonly name = 'AssistPreviewOwnershipLostError';
  constructor() { super('Assist generation no longer owns its live preview'); }
}

/** Only a leading reply string is previewable; execution fields never enter the projection. */
export class AgentReplyPreviewProjector {
  private source = '';
  private published = 0;
  private stopped = false;

  push(piece: string): string {
    if (this.stopped) return '';
    // The preview is disposable and bounded independently of the final response.
    if (this.source.length + piece.length > 131_072) { this.stopped = true; return ''; }
    this.source += piece;
    let input = this.source.trimStart();
    if (input === '') return '';
    if (input.startsWith('`')) {
      const fence = /^```(?:json)?[ \t]*\r?\n/iu.exec(input);
      if (fence === null) return '';
      input = input.slice(fence[0].length).trimStart();
      if (!input.startsWith('{')) return '';
    }
    let text: string;
    if (!/^[{\[`]/u.test(input)) {
      // A prose preamble can precede an envelope accepted by the final parser.
      // Stop before its opening brace; never publish candidate fields as prose.
      const envelopeStart = this.source.indexOf('{');
      text = envelopeStart < 0 ? this.source : this.source.slice(0, envelopeStart);
      if (envelopeStart >= 0) this.stopped = true;
    } else {
      const opening = /^\{\s*"reply"\s*:\s*"/u.exec(input);
      if (opening === null) return '';
      let end = opening[0].length;
      while (end < input.length) {
        const character = input[end]!;
        if (character === '"') break;
        if (character === '\\') {
          const escape = input[end + 1];
          if (escape === undefined) break;
          if (escape === 'u') {
            if (input.length < end + 6) break;
            if (!/^[0-9a-f]{4}$/iu.test(input.slice(end + 2, end + 6))) return '';
            end += 6;
          } else {
            if (!'"\\/bfnrt'.includes(escape)) return '';
            end += 2;
          }
        } else {
          if (character.charCodeAt(0) < 32) return '';
          end += 1;
        }
      }
      text = JSON.parse(`"${input.slice(opening[0].length, end)}"`) as string;
      if (input[end] === '"') this.stopped = true;
    }
    const delta = text.slice(this.published);
    this.published = text.length;
    return delta;
  }
}
