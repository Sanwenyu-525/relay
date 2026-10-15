/** A disposable, UTF-8-safe prefix for one in-flight plain DISCUSS response. */
export class AssistLivePreviewPublisher {
    write;
    onOwnershipLost;
    static MAX_BYTES = 16_384;
    static MIN_FLUSH_MS = 100;
    prefix = '';
    bytes = 0;
    trailingHighSurrogate = '';
    truncated = false;
    dirty = false;
    lastFlushAt = 0;
    constructor(write, onOwnershipLost) {
        this.write = write;
        this.onOwnershipLost = onOwnershipLost;
    }
    async push(piece) {
        if (piece === '' || this.truncated)
            return;
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
    async flush() {
        if (!this.dirty)
            return;
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
    name = 'AssistPreviewOwnershipLostError';
    constructor() { super('Assist generation no longer owns its live preview'); }
}
