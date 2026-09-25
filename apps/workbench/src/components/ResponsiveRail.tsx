import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { PanelRightOpen } from "lucide-react";
import AppDialog from "./AppDialog";
import { dialogCount, subscribeDialogStack } from "../lib/dialogStack";

export default function ResponsiveRail({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const openDialogs = useSyncExternalStore(subscribeDialogStack, dialogCount);
  useEffect(() => { if (drawerOpen && openDialogs > 1) setDrawerOpen(false); }, [drawerOpen, openDialogs]);
  return <>
    <aside className="review-rail desktop-rail" aria-label={title}>{children}</aside>
    <button className="rail-trigger secondary-button" type="button" data-testid="rail-trigger" onClick={() => setDrawerOpen(true)}><PanelRightOpen aria-hidden="true" />{label}</button>
    <AppDialog open={drawerOpen} title={title} variant="drawer" onClose={() => setDrawerOpen(false)}>{children}</AppDialog>
  </>;
}
