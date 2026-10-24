import { useEffect } from "react";
import { X } from "lucide-react";
import { formatAttachmentBytes, type StagedAttachment } from "./composerAttachments";
import {
  AttachmentLightbox, AttachmentPreviewLayer, attachmentPreviewHandlers, useAttachmentPreview,
} from "./attachmentPreview";
import "./ComposerAttachmentChips.css";

/**
 * 输入卡内的附件芯片行（工作台 §33.2）。
 *
 * 位置是**卡片顶部、正文上方**（2026-10-24 用户指令，此前在正文下方）——
 * 悬停预览默认贴锚点上方浮出，芯片贴着正文时预览正好盖住刚输入的文字；
 * 挪到顶部后预览浮在卡外，正文不再被遮挡。附件仍是这一条输入的组成部分，
 * 不是卡片状态；删除、上传中与拒绝理由都贴在这一行里。
 *
 * 纯展示组件：状态与上传都在调用方，这里不发起请求，也不推断发送结果。
 * 「模型能否读图」的提前说明与原地声明已按 2026-10-24 用户指令移除；
 * 发送被拒的原因仍由发送错误回执展示，能力声明入口在设置页「模型端口」卡片。
 *
 * 悬停预览（2026-10-19 用户指令「粘贴进去的图片鼠标悬停需要能够展示图片内容」）：
 * 芯片里的缩略图只有 compact 控件那么高，截图上的字读不出来，所以悬停/聚焦时
 * 把原图浮出来。几何与浮层在 `attachmentPreview`，历史消息附件用的是同一份。
 * 点击/回车再打开**原图查看层**（2026-10-24 用户确认方案 1）：浮层上限再大也读不完
 * 密图，整层里才能按实际大小平移细看；移除键 stopPropagation，不经过查看层。
 */
export default function ComposerAttachmentChips({ items, error, uploading, onRemove, disabled }: {
  readonly items: readonly StagedAttachment[];
  readonly error: string | null;
  readonly uploading: boolean;
  readonly onRemove: (key: string) => void;
  readonly disabled: boolean;
}) {
  const { preview, show, hide, viewer, openViewer, closeViewer } = useAttachmentPreview();

  // 预览/查看的那一条被移除（上传完成、发送成功、手动删掉）时收回：它贴着的锚点
  // 已经不在了，留着只会悬在一个与内容无关的位置。
  useEffect(() => {
    if (preview !== null && !items.some((item) => item.key === preview.key)) hide();
    if (viewer !== null && !items.some((item) => item.key === viewer.key)) closeViewer();
  }, [items, preview, viewer, hide, closeViewer]);

  if (items.length === 0 && error === null && !uploading) return null;
  return <div className="composer-attachments" data-testid="composer-attachments"
    data-count={items.length}>
    {items.length > 0 && <ul aria-label="待发送的图片">
      {items.map((item) => <li key={item.key} className="composer-attachment"
        data-previewable={item.url !== ""} data-testid={`composer-attachment-${item.key}`}
        tabIndex={item.url !== "" ? 0 : undefined} aria-label={`查看原图 ${item.name}`}
        {...attachmentPreviewHandlers(item.key, item.url, item.name, { preview, show, hide,
          viewer, openViewer, closeViewer })}>
        {item.url !== "" && <img src={item.url} alt="" aria-hidden="true" className="composer-attachment-thumb" />}
        <span className="composer-attachment-copy">
          <span className="composer-attachment-name" title={item.name}>{item.name}</span>
          <span className="composer-attachment-size">{formatAttachmentBytes(item.byteLength)}</span>
        </span>
        <button type="button" className="composer-attachment-remove"
          data-testid={`composer-attachment-remove-${item.key}`}
          aria-label={`移除图片 ${item.name}`} title="移除这张图片"
          disabled={disabled} onClick={(event) => { event.stopPropagation(); onRemove(item.key); }}>
          <X size={14} aria-hidden="true" />
        </button>
      </li>)}
    </ul>}
    {uploading && <p className="helper-text composer-attachment-status" role="status"
      data-testid="composer-attachment-uploading">正在上传 {items.length} 张图片，上传完成才会发送这条消息…</p>}
    {error !== null && <p className="action-error composer-attachment-error" role="alert"
      data-testid="composer-attachment-error">{error}</p>}
    <AttachmentPreviewLayer preview={preview} />
    <AttachmentLightbox item={viewer} onClose={closeViewer} />
  </div>;
}
