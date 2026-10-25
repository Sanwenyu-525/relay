import automationIcon from "../assets/plugin-icons/automation.png";
import browserIcon from "../assets/plugin-icons/browser.png";
import computerIcon from "../assets/plugin-icons/computer.png";
import filesIcon from "../assets/plugin-icons/files.png";
import githubIcon from "../assets/plugin-icons/github.png";
import knowledgeIcon from "../assets/plugin-icons/knowledge.png";
import "./PluginIcon.css";

/**
 * 内置插件图标（2026-10-25）：六枚薄荷绿图标由用户提供的 3×2 源图切出，
 * 统一透明背景、统一视觉重量（见 assets/plugin-icons 导出口径）。
 *
 * 这里只做「稳定插件 key → 静态图标资源」的映射与渲染，不引入图标库、
 * 不新建第二套身份：插件 mention（`@标签 `）的插入协议仍在 AssistView 的
 * `insertPluginMention`，识别的 mention 集合在 lib/pluginMentions。
 *
 * 图标是装饰：默认 `alt=""` + `aria-hidden`，可访问名称由相邻文字或控件提供
 * （菜单行有按钮名、消息里有 mention 文本、徽标有标签文字）。传 `label` 时
 * 图标自身承担名称（目前没有这类用法，保留给确有需要的场合）。
 */
export const PLUGIN_ICON_KEYS = [
  "computer", "browser", "github", "files", "knowledge", "automation"
] as const;

export type PluginIconKey = (typeof PLUGIN_ICON_KEYS)[number];

const PLUGIN_ICON_SOURCES: Record<PluginIconKey, string> = {
  computer: computerIcon,
  browser: browserIcon,
  github: githubIcon,
  files: filesIcon,
  knowledge: knowledgeIcon,
  automation: automationIcon
};

export function isPluginIconKey(value: string): value is PluginIconKey {
  return (PLUGIN_ICON_KEYS as readonly string[]).includes(value);
}

export default function PluginIcon({ plugin, className, label }: {
  /** 稳定插件 key；未知 key 不渲染（不拿 Lucide 默认图标冒充已接入的新图）。 */
  plugin: PluginIconKey;
  /** 尺寸由 CSS 变量 `--plugin-icon-size` 决定，消费方按需覆盖；颜色/间距只用既有 token。 */
  className?: string;
  /** 传了就让图标自身承担可访问名称；默认按装饰处理。 */
  label?: string;
}) {
  const decorative = label === undefined;
  return <img src={PLUGIN_ICON_SOURCES[plugin]} alt={label ?? ""}
    aria-hidden={decorative ? true : undefined} draggable={false}
    data-plugin-icon={plugin}
    className={className === undefined ? "plugin-icon" : `plugin-icon ${className}`} />;
}
