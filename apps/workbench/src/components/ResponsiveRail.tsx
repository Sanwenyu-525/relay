import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { PanelRightOpen } from "lucide-react";
import AppDialog from "./AppDialog";
import { dialogCount, subscribeDialogStack } from "../lib/dialogStack";

/**
 * 页面右判断区 + 范围说明抽屉。
 *
 * `inline`（2026-11-15）：触发按钮不再作为 page-layout 末尾的独立网格项落在页面底部，
 * 而是留在调用方放置的位置（如任务范围页签右侧）。宽屏不再先占一整行空白，
 * 窄屏也不必滚到列表末才看得到入口；桌面 aside 与抽屉内容不变。
 */
export default function ResponsiveRail({ label, title, children, inline = false }: {
  label: string; title: string; children: ReactNode; inline?: boolean }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const openDialogs = useSyncExternalStore(subscribeDialogStack, dialogCount);
  useEffect(() => { if (drawerOpen && openDialogs > 1) setDrawerOpen(false); }, [drawerOpen, openDialogs]);
  return <>
    <aside className="review-rail desktop-rail" aria-label={title}>{children}</aside>
    <button className={`rail-trigger secondary-button${inline ? " rail-trigger--inline" : ""}`} type="button" data-testid="rail-trigger" onClick={() => setDrawerOpen(true)}><PanelRightOpen aria-hidden="true" />{label}</button>
    <AppDialog open={drawerOpen} title={title} variant="drawer" onClose={() => setDrawerOpen(false)}>{children}</AppDialog>
  </>;
}
