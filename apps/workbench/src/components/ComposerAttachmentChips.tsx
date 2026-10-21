import { useEffect } from "react";
import { X } from "lucide-react";
import { formatAttachmentBytes, type StagedAttachment } from "./composerAttachments";
import {
  AttachmentPreviewLayer, attachmentPreviewHandlers, useAttachmentPreview,
} from "./attachmentPreview";
import "./ComposerAttachmentChips.css";

/**
 * 输入卡内的附件芯片行（工作台 §33.2）。
 *
 * 位置是**正文下方、工具行上方**——附件是这一条输入的组成部分，不是卡片状态；
 * 删除、上传中与拒绝理由都贴在这一行里，卡片其余部分（正文、工具行、发送键）
 * 的几何不随附件数量以外的任何状态变化。
 *
 * 纯展示组件：状态与上传都在调用方，这里不发起请求，也不推断发送结果。
 *
 * 悬停预览（2026-10-19 用户指令「粘贴进去的图片鼠标悬停需要能够展示图片内容」）：
 * 芯片里的缩略图只有 compact 控件那么高，截图上的字读不出来，所以悬停/聚焦时
 * 把原图浮出来。几何与浮层在 `attachmentPreview`，历史消息附件用的是同一份。
 */
export default function ComposerAttachmentChips({ items, error, uploading, onRemove, disabled, notice,
  imageDeclaration }: {
  readonly items: readonly StagedAttachment[];
  readonly error: string | null;
  readonly uploading: boolean;
  readonly onRemove: (key: string) => void;
  readonly disabled: boolean;
  /**
   * 能力预检（2026-10-19）：当前聊天模型不接受图片输入时的提前说明。
   * 只在真的有附件时显示——没粘图就不必提前吓人。它不阻止发送：服务端闸门才是准绳，
   * 这里只是把「点了发送才会被拒」提前到「刚粘进来就知道」。
   */
  readonly notice?: string | null;
  /**
   * 原地补充能力声明（2026-10-20，P1-5）。只在「目录里没有这个模型」时出现：
   * 那一档声明就是设计里的第三层，写完立即生效；目录明确说不支持时声明不生效，
   * 因此 `canDeclare` 为假，界面不给一个点了也没用的按钮。
   */
  readonly imageDeclaration?: { readonly canDeclare: boolean; readonly declaring: boolean;
    readonly declareError: string | null; readonly declare: (imageInput: boolean) => void } | null;
}) {
  const { preview, show, hide } = useAttachmentPreview();

  // 预览的那一条被移除（上传完成、发送成功、手动删掉）时收回浮层：
  // 它贴着的锚点已经不在了，留着只会悬在一个与内容无关的位置。
  useEffect(() => {
    if (preview === null) return;
    if (!items.some((item) => item.key === preview.key)) hide();
  }, [items, preview, hide]);

  if (items.length === 0 && error === null && !uploading) return null;
  return <div className="composer-attachments" data-testid="composer-attachments"
    data-count={items.length}>
    {items.length > 0 && <ul aria-label="待发送的图片">
      {items.map((item) => <li key={item.key} className="composer-attachment"
        data-previewable={item.url !== ""} data-testid={`composer-attachment-${item.key}`}
        {...attachmentPreviewHandlers(item.key, item.url, item.name, { preview, show, hide })}>
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
    {notice !== undefined && notice !== null && items.length > 0 &&
      <p className="composer-attachment-notice" role="status"
        data-testid="composer-attachment-notice">{notice}</p>}
    {items.length > 0 && imageDeclaration?.canDeclare === true &&
      <div className="composer-attachment-declare" data-testid="composer-image-declare">
        <span className="composer-attachment-declare-copy">这个模型不在目录里；为它声明图片能力后，带图消息就能通过。</span>
        <button type="button" className="secondary-button secondary-button--compact"
          data-testid="composer-image-declare-support" disabled={imageDeclaration.declaring}
          onClick={() => imageDeclaration.declare(true)}>
          {imageDeclaration.declaring ? "正在保存…" : "声明支持图片"}</button>
        <button type="button" className="text-link" data-testid="composer-image-declare-deny"
          disabled={imageDeclaration.declaring} onClick={() => imageDeclaration.declare(false)}>声明不支持</button>
        {imageDeclaration.declareError !== null &&
          <span className="action-error" role="alert" data-testid="composer-image-declare-error">
            声明未保存：{imageDeclaration.declareError}</span>}
      </div>}
    {error !== null && <p className="action-error composer-attachment-error" role="alert"
      data-testid="composer-attachment-error">{error}</p>}
    <AttachmentPreviewLayer preview={preview} />
  </div>;
}
