import type { RelayApiClient } from "../api/relayClient";

/**
 * 输入框图片附件（工作台 §33，契约 §10.85）。
 *
 * 这条链路是**先传后引**：粘贴/拖拽只把 `File` 暂存在本机，发送前逐张上传拿
 * `attachment_id`，再随消息命令的 `attachment_ids` 一起提交。上传只落一行暂存，
 * 不改变任何业务状态，因此这里不做「已经发出去」的推断。
 *
 * 上限与服务端 `application/assist-attachments.ts` 是同一组数值：服务端唯一准绳，
 * 这里只做发送前预检，让明显超限的输入在点发送前就得到可读说明。两份定义由
 * `tests/composerAttachments.spec.ts` 锁定一致。
 */

export const ASSIST_ATTACHMENT_MEDIA_TYPES = [
  "image/png", "image/jpeg", "image/gif", "image/webp",
] as const;

/** 单张图片原始字节上限：2 MiB。 */
export const MAX_ASSIST_ATTACHMENT_BYTES = 2 * 1024 * 1024;
/** 每条消息附件数量上限。 */
export const MAX_ASSIST_ATTACHMENTS_PER_MESSAGE = 4;
/** 每条消息附件总量上限（原始字节合计）。 */
export const MAX_ASSIST_ATTACHMENT_TOTAL_BYTES = 6 * 1024 * 1024;

export function isAssistAttachmentMediaType(value: string): boolean {
  return (ASSIST_ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(value);
}

/** 暂存项：`File` 与它的预览 URL 一起保存，移除时由调用方回收 URL。 */
export interface StagedAttachment extends AttachmentUploadCandidate {
  readonly key: string;
  readonly url: string;
  readonly byteLength: number;
}

/** 上传只需要这三样：文件本体、显示名与媒体类型。首条消息的图片没有预览 URL，也走这条路。 */
export interface AttachmentUploadCandidate {
  readonly file: File;
  readonly name: string;
  readonly mediaType: string;
}

export function uploadCandidateFrom(file: File): AttachmentUploadCandidate {
  return { file, name: file.name || "图片", mediaType: file.type };
}

export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 一次加入的裁决：类型、单张上限、数量与总量。返回第一条问题，`null` 表示全部可加。
 * 只在**加入时**检查已通过的那批——已暂存项不再重复判定，避免同一份输入被两套规则各判一次。
 */
export function attachmentProblem(candidate: File,
  existing: readonly StagedAttachment[]): string | null {
  if (!isAssistAttachmentMediaType(candidate.type)) {
    return `「${candidate.name || "未命名图片"}」不是受支持的图片格式；当前版本仅支持 PNG、JPEG、GIF、WebP。`;
  }
  if (candidate.size <= 0) return `「${candidate.name || "未命名图片"}」是空文件。`;
  if (candidate.size > MAX_ASSIST_ATTACHMENT_BYTES) {
    return `「${candidate.name || "未命名图片"}」${formatAttachmentBytes(candidate.size)}，单张上限 ${formatAttachmentBytes(MAX_ASSIST_ATTACHMENT_BYTES)}。`;
  }
  if (existing.length >= MAX_ASSIST_ATTACHMENTS_PER_MESSAGE) {
    return `一条消息最多 ${MAX_ASSIST_ATTACHMENTS_PER_MESSAGE} 张图片。`;
  }
  const total = existing.reduce((sum, item) => sum + item.byteLength, candidate.size);
  if (total > MAX_ASSIST_ATTACHMENT_TOTAL_BYTES) {
    return `图片合计 ${formatAttachmentBytes(total)}，超过每条消息 ${formatAttachmentBytes(MAX_ASSIST_ATTACHMENT_TOTAL_BYTES)} 的上限。`;
  }
  return null;
}

/**
 * 把一张图片读成 base64。
 *
 * 走 `FileReader.readAsDataURL` 而不是 `arrayBuffer()` + `btoa`：两条路在浏览器里等价，
 * 但前者不依赖大数组展开，jsdom 也只实现了它——同一份代码在组件测试里能真跑。
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma === -1 ? "" : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

/**
 * 预览 URL。jsdom 没有实现 `URL.createObjectURL`，测试环境里退回空串
 * （芯片仍显示名称与大小，只是没有缩略图）——真实浏览器里这条分支不会走到。
 */
export function previewUrl(file: File): string {
  try {
    return URL.createObjectURL(file);
  } catch {
    return "";
  }
}

/**
 * 逐张上传，返回按原顺序的 `attachment_id`。
 *
 * 任一张失败即整体抛出：调用方不得用「部分 id」发消息——服务端会把已上传但无人引用的
 * 行留在库里（应用角色没有 DELETE），能做的只有让人看见失败并重试，不假装发送成功。
 */
export async function uploadStagedAttachments(client: RelayApiClient, sessionId: string,
  items: readonly AttachmentUploadCandidate[]): Promise<readonly string[]> {
  const ids: string[] = [];
  for (const item of items) {
    const result = await client.uploadAssistMessageAttachment({ sessionId,
      name: item.name, mediaType: item.mediaType,
      dataBase64: await fileToBase64(item.file) });
    ids.push(result.attachmentId);
  }
  return ids;
}

/** 预览 URL 的回收：移除、发送成功与卸载时都必须调用，否则 blob 会跟着页面活到刷新。 */
export function revokeStagedUrls(items: readonly StagedAttachment[]): void {
  for (const item of items) {
    if (item.url === "") continue;
    URL.revokeObjectURL(item.url);
  }
}
