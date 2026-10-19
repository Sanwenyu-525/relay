import { X } from "lucide-react";
import { formatAttachmentBytes, type StagedAttachment } from "./composerAttachments";
import "./ComposerAttachmentChips.css";

/**
 * 输入卡内的附件芯片行（工作台 §33.2）。
 *
 * 位置是**正文下方、工具行上方**——附件是这一条输入的组成部分，不是卡片状态；
 * 删除、上传中与拒绝理由都贴在这一行里，卡片其余部分（正文、工具行、发送键）
 * 的几何不随附件数量以外的任何状态变化。
 *
 * 纯展示组件：状态与上传都在调用方，这里不发起请求，也不推断发送结果。
 */
export default function ComposerAttachmentChips({ items, error, uploading, onRemove, disabled }: {
  readonly items: readonly StagedAttachment[];
  readonly error: string | null;
  readonly uploading: boolean;
  readonly onRemove: (key: string) => void;
  readonly disabled: boolean;
}) {
  if (items.length === 0 && error === null && !uploading) return null;
  return <div className="composer-attachments" data-testid="composer-attachments"
    data-count={items.length}>
    {items.length > 0 && <ul aria-label="待发送的图片">
      {items.map((item) => <li key={item.key} className="composer-attachment">
        {item.url !== "" && <img src={item.url} alt="" aria-hidden="true" className="composer-attachment-thumb" />}
        <span className="composer-attachment-copy">
          <span className="composer-attachment-name" title={item.name}>{item.name}</span>
          <span className="composer-attachment-size">{formatAttachmentBytes(item.byteLength)}</span>
        </span>
        <button type="button" className="composer-attachment-remove"
          data-testid={`composer-attachment-remove-${item.key}`}
          aria-label={`移除图片 ${item.name}`} title="移除这张图片"
          disabled={disabled} onClick={() => onRemove(item.key)}>
          <X size={14} aria-hidden="true" />
        </button>
      </li>)}
    </ul>}
    {uploading && <p className="helper-text composer-attachment-status" role="status"
      data-testid="composer-attachment-uploading">正在上传 {items.length} 张图片，上传完成才会发送这条消息…</p>}
    {error !== null && <p className="action-error composer-attachment-error" role="alert"
      data-testid="composer-attachment-error">{error}</p>}
  </div>;
}
