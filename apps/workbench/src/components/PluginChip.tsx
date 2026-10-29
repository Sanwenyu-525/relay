import type { CSSProperties, Ref } from "react";
import PluginIcon, { type PluginIconKey } from "./PluginIcon";
import "./PluginChip.css";

/**
 * 插件内联标识（图标 + 名称 + 极浅色容器）的唯一视觉件（2026-10-28 第二轮精修）。
 *
 * 输入器编辑态与消息只读态共用同一套结构与 token，只差两件事，且都是必要的：
 * - `editing` 叠在 textarea 镜像层的 mention 矩形上。宽度由原文片段的字宽下发
 *   （见 ChatCommandInput 的 placeChips），容器右缘因此就是 `@标签` 的终点、
 *   也正好是光标落点：它盖不到后面的正文，光标也不会落进名称里；名称按 meta 档，
 *   放不下时由 label 自己省略号收口，不靠 margin 或负定位找补。
 * - `static` 走正常文本流，宽度由内容决定，名称与消息正文同档（body）。
 *
 * 这里只做展示：不判断权限、不改写文本、不代表插件已经执行过。mention 在草稿与
 * 消息里始终是纯文本，识别集合在 lib/pluginMentions，Owner 仍是会话输入器。
 */
export default function PluginChip({ plugin, label, variant, className, style, ref }: {
  plugin: PluginIconKey;
  /** 展示名（不含 `@`）：编辑态替换掉原文里的 `@标签`，只读态直接跟在正文流里。 */
  label: string;
  variant: "editing" | "static";
  /** 所在表面的钩子类（`.chat-command-chip` / `.assist-plugin-mention`）；视觉不依赖它。 */
  className?: string;
  /** 编辑态的几何变量由此下发，静态态不传。 */
  style?: CSSProperties;
  ref?: Ref<HTMLSpanElement>;
}) {
  return <span
    className={["plugin-chip", `plugin-chip-${variant}`, className].filter((name) => name !== undefined).join(" ")}
    {...(variant === "editing" ? { "data-plugin-chip": plugin } : { "data-plugin-mention": plugin })}
    style={style} ref={ref}>
    <PluginIcon plugin={plugin} className="plugin-chip-icon" />
    <span className="plugin-chip-label">{label}</span>
  </span>;
}
