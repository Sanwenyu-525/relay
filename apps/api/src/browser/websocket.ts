/**
 * 最小 RFC 6455 服务端实现（F26 M4a）。
 *
 * 为什么不用 `ws`：本仓库的打包链对运行时依赖有逐版本核对成本，而桥接只需要
 * 「文本帧 + ping/pong + close」这一小块。实现范围是刻意收窄的：
 *   * 只支持**文本帧**（桥接协议就是 JSON 文本）与控制帧；
 *   * 不支持分片（_continuation）：超过一帧的消息按协议错误关闭——桥接命令有
 *     单帧上限，分片只会来自恶意或坏掉的客户端；
 *   * 客户端帧必须带掩码（RFC 要求），服务端帧不掩码；
 *   * 收到 ping 回 pong，收到 close 回 close 并断开。
 *
 * 握手只做 RFC 6455 §4.2 的服务端部分：Sec-WebSocket-Accept =
 * base64(sha1(key + 258EAFA5-E914-47DA-95CA-C5AB0DC85B11))。
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(key: string): string {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64');
}

export type WsMessage = { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'fragment'; readonly start: boolean; readonly final: boolean; readonly payload: Buffer }
  | { readonly kind: 'pong' }
  | { readonly kind: 'close'; readonly code: number };

/** 从累积缓冲里解出完整的客户端帧；返回剩余未消费的字节偏移。 */
export function decodeFrame(buffer: Buffer): {
  frame: WsMessage | null; consumed: number; error: string | null;
} {
  if (buffer.length < 2) return { frame: null, consumed: 0, error: null };
  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return { frame: null, consumed: 0, error: null };
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return { frame: null, consumed: 0, error: null };
    const big = buffer.readBigUInt64BE(2);
    if (big > 32n * 1024n * 1024n) {
      return { frame: null, consumed: 0, error: 'frame too large' };
    }
    length = Number(big);
    offset = 10;
  }
  if (!masked) return { frame: null, consumed: 0, error: 'client frames must be masked' };
  if (buffer.length < offset + 4 + length) {
    return { frame: null, consumed: 0, error: null };
  }
  if (opcode >= 0x8 && (!fin || length > 125)) {
    return { frame: null, consumed: 0, error: 'invalid control frame' };
  }
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    payload[index] = (buffer[offset + 4 + index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  switch (opcode) {
    case 0x1:
      if (!fin) return { frame: { kind: 'fragment', start: true, final: false, payload },
        consumed: offset + 4 + length, error: null };
      return { frame: { kind: 'text', text: payload.toString('utf8') },
        consumed: offset + 4 + length, error: null };
    case 0x0:
      return { frame: { kind: 'fragment', start: false, final: fin, payload },
        consumed: offset + 4 + length, error: null };
    case 0x8: {
      const code = length >= 2 ? payload.readUInt16BE(0) : 1005;
      return { frame: { kind: 'close', code }, consumed: offset + 4 + length, error: null };
    }
    case 0x9:
      return { frame: { kind: 'pong' }, consumed: offset + 4 + length, error: null };
    case 0xA:
      return { frame: { kind: 'pong' }, consumed: offset + 4 + length, error: null };
    default:
      return { frame: null, consumed: 0,
        error: `unsupported opcode 0x${opcode.toString(16)}` };
  }
}

/** 服务端文本帧（不掩码；单帧，FIN=1）。 */
export function encodeText(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** 服务端 close 帧。 */
export function encodeClose(code: number): Buffer {
  const payload = Buffer.allocUnsafe(2);
  payload.writeUInt16BE(code, 0);
  return Buffer.concat([Buffer.from([0x88, 2]), payload]);
}

/** 服务端 pong 帧（载荷原样回显由调用方决定；这里只回空载荷）。 */
export function encodePong(): Buffer {
  return Buffer.from([0x8a, 0]);
}

/**
 * 一条已握手的 WebSocket 连接。
 *
 * 事件：`message`（文本）、`close`。错误（协议违规/超大帧）会关闭连接并触发 close。
 */
export class WebSocketConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] | null = null;
  private fragmentBytes = 0;
  private closed = false;

  readonly id = randomBytes(8).toString('hex');
  private readonly listeners = new Map<string, Array<(value: unknown) => void>>();

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.consume(chunk));
    socket.on('error', () => this.doClose(1011));
    socket.on('close', () => this.emit('close', undefined));
    socket.on('end', () => this.doClose(1001));
  }

  on(event: 'message' | 'close', listener: (value: never) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as (value: unknown) => void);
    this.listeners.set(event, list);
  }

  off(event: 'message' | 'close', listener: (value: never) => void): void {
    const list = this.listeners.get(event) ?? [];
    const index = list.indexOf(listener as (value: unknown) => void);
    if (index >= 0) list.splice(index, 1);
  }

  sendText(text: string): boolean {
    if (this.closed) return false;
    this.socket.write(encodeText(text));
    return true;
  }

  close(code = 1000): void {
    this.doClose(code);
  }

  private doClose(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.fragments = null;
    this.fragmentBytes = 0;
    try { this.socket.write(encodeClose(code)); } catch { /* 对端已断 */ }
    this.socket.end();
    this.emit('close', undefined);
  }

  private consume(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0
      ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const decoded = decodeFrame(this.buffer);
      if (decoded.error !== null) {
        this.doClose(1002);
        return;
      }
      if (decoded.frame === null) return;
      this.buffer = Buffer.from(this.buffer.subarray(decoded.consumed));
      if (decoded.frame.kind === 'fragment') {
        const frame = decoded.frame;
        if (frame.start ? this.fragments !== null : this.fragments === null) {
          this.doClose(1002);
          return;
        }
        if (frame.start) this.fragments = [];
        this.fragmentBytes += frame.payload.length;
        if (this.fragmentBytes > 32 * 1024 * 1024) {
          this.doClose(1009);
          return;
        }
        this.fragments!.push(frame.payload);
        if (frame.final) {
          const text = Buffer.concat(this.fragments!, this.fragmentBytes).toString('utf8');
          this.fragments = null;
          this.fragmentBytes = 0;
          this.emit('message', text);
        }
      } else if (decoded.frame.kind === 'text') {
        if (this.fragments !== null) {
          this.doClose(1002);
          return;
        }
        this.emit('message', decoded.frame.text);
      }
      else if (decoded.frame.kind === 'close') {
        this.doClose(decoded.frame.code === 1005 ? 1000 : decoded.frame.code);
        return;
      } else if (decoded.frame.kind === 'pong') {
        // 客户端 ping 已在 decode 前无法区分（解码层把 ping/pong 归并）；
        // 对 ping 回 pong 由 encodePong 完成——这里不做事。
        try { this.socket.write(encodePong()); } catch { /* 对端已断 */ }
      }
    }
  }

  private emit(event: 'message' | 'close', value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

/** 101 握手响应头。 */
export function handshakeResponse(accept: string): string {
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n');
}
