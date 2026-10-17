/**
 * 工具调用「生成中」预览的发布器（工作台 §34.4 / CD-09–11）。
 *
 * 输入是模型参数流的**原始 args 增量**（LangChain tool_call_chunks 的 argsText 片段拼接），
 * 输出是某个工具 ordinal 的逐文件行数预览——只读、有界、可丢弃：
 *   * 解析复用 changeset-preview 的有界增量解析，不 eval、不数原始 JSON 行；
 *   * 行数只对「已收到的内容」计算：内容尚未收全时不把未到达的文件尾部算成删除，
 *     完整目标到达前 added/removed 记 -1（待核对），由 UI 显示为「正在生成」；
 *   * DELETE 不猜行数（-1），CREATE 可显示已收到内容的插入预览；
 *   * 写入节流且每次整份覆盖同一行，revision 由仓储自增，旧响应不能覆盖新值（CD-15）；
 *   * 本类不执行、不授予权限、不进入会话总数——总数只采用已落盘内容。
 */

import type { ToolCallPreviewRepository } from './tool-call-preview-repository.js';
import { extractApplyChangesetPreview, MAX_PREVIEW_CONTENT_CHARS,
  type PreviewChangeFile } from './changeset-preview.js';
import { computeLineDiff, toLogicalLines } from './diff-engine.js';

/** 与基线文本同源的单文件读取上限：超过就不读文本，预览标不可统计。 */
export const MAX_PREVIEW_FILE_BYTES = 64 * 1024;
/** 预览文本本身的字符上限（解析器已截断，这里再兜一层）。 */
export const MAX_PREVIEW_TEXT_CHARS = MAX_PREVIEW_CONTENT_CHARS;
/** 写库节流：本地驱动器上 150ms 一次足以让「生成中」数字连续变化，又不会每次 chunk 都写库。 */
export const MIN_PREVIEW_FLUSH_MS = 150;

export interface ToolPreviewFile {
  readonly path: string;
  readonly action: 'CREATE' | 'MODIFY' | 'DELETE' | 'UNKNOWN';
  /** -1 = 待核对（目标未收全或无法可靠计算），绝不冒充 0。 */
  readonly added: number;
  readonly removed: number;
  readonly targetComplete: boolean;
}

/** 受管根内读取当前文件文本；不可读/超限/受保护返回 null（失败只让该文件预览不可用）。 */
export type PreviewFileReader = (relativePath: string) => Promise<string | null>;

export interface ToolPreviewState {
  readonly files: readonly ToolPreviewFile[];
  /** 内容达到解析上限被截断；UI 按「超出预览上限」呈现。 */
  readonly truncated: boolean;
}

export interface ToolCallPreviewSink {
  readonly workspaceId: string;
  readonly runId: string;
  readonly modelCallId: string;
  readonly ordinal: number;
}

export interface ToolCallPreviewPublisherOptions {
  readonly repositories: { readonly toolCallPreview: ToolCallPreviewRepository };
  readonly sink: ToolCallPreviewSink;
  readonly toolName: string;
  readonly readFile: PreviewFileReader;
  /** 测试可注入的时间源；默认 Date.now。 */
  readonly now?: (() => number) | undefined;
  /** 测试可注入的节流间隔；默认 MIN_PREVIEW_FLUSH_MS。 */
  readonly minFlushMs?: number | undefined;
}

export class ToolCallPreviewPublisher {
  private buffer = '';
  private truncated = false;
  private dirty = false;
  private lastFlushAt = 0;
  /** 磁盘当前内容缓存：同一路径只读一次，生成期间的外部写入以第一次读取为准。 */
  private readonly diskText = new Map<string, string | null>();
  private readonly now: () => number;
  private readonly minFlushMs: number;
  /** 写失败后停止继续尝试，但不影响模型调用本身。 */
  private disabled = false;

  constructor(private readonly options: ToolCallPreviewPublisherOptions) {
    this.now = options.now ?? Date.now;
    this.minFlushMs = options.minFlushMs ?? MIN_PREVIEW_FLUSH_MS;
  }

  /**
   * 喂入该工具调用**到当前为止的累计原始参数文本**（不是新片段）。
   *
   * 用整份替换而不是拼接：OpenAI 兼容端点通常按片段给 args，但也有实现按整份快照回传，
   * 累计文本在两种形态下都是权威值，拼接会在快照形态下重复内容。
   */
  async feed(argumentsText: string): Promise<void> {
    if (argumentsText === '' || this.disabled) return;
    this.buffer = argumentsText.length > MAX_PREVIEW_TEXT_CHARS * 8
      // 有界：超长参数只保留解析所需的前缀；结构化 target 本就被解析器按 item 截断。
      ? argumentsText.slice(0, MAX_PREVIEW_TEXT_CHARS * 8) : argumentsText;
    if (argumentsText.length > MAX_PREVIEW_TEXT_CHARS * 8) this.truncated = true;
    this.dirty = true;
    if (this.lastFlushAt === 0 || this.now() - this.lastFlushAt >= this.minFlushMs) {
      await this.flush();
    }
  }

  /** 把当前 best-effort 预览落库；节流不到期时可选等下一次，这里直接写（调用方已节流）。 */
  async flush(): Promise<void> {
    if (!this.dirty || this.disabled) return;
    this.dirty = false;
    this.lastFlushAt = this.now();
    let state: ToolPreviewState;
    try {
      state = await this.snapshot();
    } catch {
      // 预览是展示证据：算不出来就保持上一版，不影响模型调用与执行。
      return;
    }
    if (state.files.length === 0 && !state.truncated) return;
    try {
      await this.options.repositories.toolCallPreview.upsert({
        workspaceId: this.options.sink.workspaceId,
        runId: this.options.sink.runId,
        modelCallId: this.options.sink.modelCallId,
        ordinal: this.options.sink.ordinal,
        toolName: this.options.toolName,
        files: state.files,
        truncated: state.truncated,
      });
    } catch {
      this.disabled = true;
    }
  }

  /** 当前预览（不写库）；测试与调用方主动读取用。 */
  async snapshot(): Promise<ToolPreviewState> {
    const parsed = extractApplyChangesetPreview(this.buffer);
    const files: ToolPreviewFile[] = [];
    for (const file of parsed.files) {
      const path = file.path;
      // 路径尚未到达的 item 不展示：不知道写哪个文件的行数没有意义（CD-10 路径晚到）。
      if (path === null || path === '') continue;
      files.push(await this.filePreview(path, file));
    }
    return { files, truncated: this.truncated };
  }

  private async filePreview(path: string, file: PreviewChangeFile): Promise<ToolPreviewFile> {
    const targetComplete = file.contentComplete || file.itemComplete;
    const content = file.contentPreview;
    if (file.action === 'DELETE') {
      // 删除数要等完整目标/可靠基线，预览期不猜。
      return { path, action: 'DELETE', added: -1, removed: -1, targetComplete };
    }
    if (file.action === 'UNKNOWN' || content === null) {
      return { path, action: file.action === 'UNKNOWN' ? 'UNKNOWN' : file.action,
        added: -1, removed: -1, targetComplete };
    }
    if (file.action === 'CREATE') {
      return { path, action: 'CREATE', added: toLogicalLines(content).length,
        removed: 0, targetComplete };
    }
    // MODIFY：目标未收全时不把未到达的尾部算成删除，整条记待核对。
    if (!targetComplete) {
      return { path, action: 'MODIFY', added: -1, removed: -1, targetComplete };
    }
    const before = await this.readDisk(path);
    if (before === null) {
      return { path, action: 'MODIFY', added: -1, removed: -1, targetComplete };
    }
    const diff = computeLineDiff(before, content);
    return { path, action: 'MODIFY', added: diff.added, removed: diff.removed, targetComplete };
  }

  private async readDisk(relativePath: string): Promise<string | null> {
    const cached = this.diskText.get(relativePath);
    if (cached !== undefined) return cached;
    let text: string | null;
    try {
      text = await this.options.readFile(relativePath);
    } catch {
      text = null;
    }
    this.diskText.set(relativePath, text);
    return text;
  }
}
