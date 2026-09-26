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
