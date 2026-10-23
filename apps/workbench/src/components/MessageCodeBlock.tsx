import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Toast } from "./Feedback";
import "./MessageCodeBlock.css";

/**
 * 历史消息里的可复制文本块（工作台 §37.1）：模型给的代码 fence、命令输出、工具回执
 * 共用这一档外观。顶部一行说明这段内容是什么（语言，或「工具 · 目标」），右上角一键复制；
 * 正文逐字来自来源，不加工、不语法高亮，也不在块内截断后冒充完整——要全量看工具轨迹。
 *
 * 复制是纯客户端剪贴板动作：不新增命令、不落库、不把「已复制」说成已保存的事实。
 * 成功后用共享浮层给一条短回执（不占文档流，不推走正文）；按钮先变√，随后自行还原。
 * 写剪贴板失败时只把按钮还原成可重试，可读名说明状态，不发成功回执。
 */

type CopyState = "idle" | "done" | "failed";

/** 「已复制 / 失败」都是瞬态提示：亮一下自己回到 idle，不靠定时器以外的东西收回。 */
const COPY_FEEDBACK_MS = 2400;

export default function MessageCodeBlock({ label, text, testId, maxHeight, copyLabel }: {
  /** 顶部说明：语言名，或「工具名 · 目标」。为空字符串时不渲染顶行。 */
  label: string;
  /** 正文：逐字来自来源，调用方负责决定是否只展示有界片段并另行说明。 */
  text: string;
  testId?: string;
  /** 正文滚动上限；不传时用 CSS 默认档（长文在块内滚动，不把消息列撑长）。 */
  maxHeight?: string;
  /** 复制键的可读名；不同来源可以有自己的说法（「复制这段输出」等）。 */
  copyLabel?: string;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 换一段正文就还原按钮：上一块的「已复制」不属于这一块；同时收回未响的瞬态定时器。
  useEffect(() => {
    setState("idle");
    return () => { if (timer.current !== undefined) clearTimeout(timer.current); };
  }, [text]);

  function arm() {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), COPY_FEEDBACK_MS);
  }

  function onCopy() {
    const clipboard = navigator.clipboard;
    // 没有剪贴板能力（非安全上下文、旧 WebView）时按失败处理：不假装复制成功。
    if (clipboard === undefined) { setState("failed"); arm(); return; }
    void clipboard.writeText(text).then(
      () => { setState("done"); arm(); },
      () => { setState("failed"); arm(); });
  }

  const copyName = state === "done" ? "已复制" : state === "failed" ? "复制失败，可重试" : copyLabel ?? "复制这段内容";
  // 顶行恒定在场：复制键不能因为没有标签就消失（调用方可能给不出标签，但用户永远要能复制）。
  // 没有标签时这一行只剩右端一个键，仍是同一档高度，不会让正文位置跳。
  return <figure className="msg-code" data-testid={testId} data-copy-state={state}>
    <figcaption className="msg-code-bar">
      {label !== "" && <span className="msg-code-label">{label}</span>}
      <button className="icon-button msg-code-copy" type="button"
        aria-label={copyName} title={copyName} onClick={onCopy}>
        {state === "done" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
    </figcaption>
    <pre className="msg-code-body" style={maxHeight === undefined ? undefined : { maxHeight }}><code>{text}</code></pre>
    {/* 回执走共享浮层：固定定位，不参与这块的网格布局，因此出现/消失都不会推走正文。 */}
    {state === "done" && <Toast testId="msg-code-copy-toast">复制成功</Toast>}
  </figure>;
}
