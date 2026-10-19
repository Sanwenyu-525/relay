import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { attachmentProblem, previewUrl, revokeStagedUrls, type StagedAttachment } from "./composerAttachments";

/**
 * 输入框图片附件的暂存状态（工作台 §33.2）。
 *
 * 只回答「现在框里挂了哪几张图、它们能不能加进来」：上传、随消息发送与失败提示
 * 分别由调用方负责——两个输入器（首条消息与会话内）共用这一份规则，不各写一套上限。
 *
 * 二进制不进草稿持久化：重挂载/刷新后附件不保留，这是设计约束而不是遗漏。
 */
export function useStagedAttachments() {
  const [items, setItems] = useState<readonly StagedAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<readonly StagedAttachment[]>([]);
  latest.current = items;

  const add = useCallback((files: readonly File[]) => {
    if (files.length === 0) return;
    const added: StagedAttachment[] = [];
    let problem: string | null = null;
    for (const file of files) {
      const existing = [...latest.current, ...added];
      problem = attachmentProblem(file, existing);
      if (problem !== null) break;
      added.push({ key: `${file.name}:${file.size}:${file.lastModified}:${added.length}`,
        file, url: previewUrl(file), name: file.name || "图片",
        mediaType: file.type, byteLength: file.size });
    }
    if (added.length > 0) setItems((current) => [...current, ...added]);
    setError(problem);
  }, []);

  const remove = useCallback((key: string) => {
    const target = latest.current.find((item) => item.key === key);
    if (target !== undefined && target.url !== "") URL.revokeObjectURL(target.url);
    setItems((current) => current.filter((item) => item.key !== key));
    setError(null);
  }, []);

  const clear = useCallback(() => {
    revokeStagedUrls(latest.current);
    setItems([]);
    setError(null);
  }, []);

  // 卸载时回收尚未发出的预览 URL；已发送/已清空的数组是空的，不会重复释放。
  useEffect(() => () => revokeStagedUrls(latest.current), []);

  // 返回值保记忆：调用方会把它整个放进依赖数组（未保存保护的 effect 就依赖它），
  // 每次渲染都给新对象会让那个 effect 每帧重跑。
  return useMemo(() => ({ items, error, add, remove, clear, setError }),
    [items, error, add, remove, clear]);
}
