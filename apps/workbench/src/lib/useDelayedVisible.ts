import { useEffect, useState } from "react";

/**
 * 让纯展示的「加载中」提示延迟出现（默认 200ms）。
 *
 * 换工作区、换会话或换任务时组件按 key 重挂载，数据通常在几十毫秒内到达；
 * 立即渲染「正在读取…」再换成内容，读起来就是界面闪一下（2026-10-19 用户反馈）。
 * 这里只在真的读得慢时才把等待显示出来，不把等待藏掉。
 *
 * 只用于加载提示：错误、阻塞原因与命令回执必须立即可见，不走这条延迟。
 */
export function useDelayedVisible(active: boolean, delayMs = 200): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) { setVisible(false); return; }
    const timer = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return visible;
}
