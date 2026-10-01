import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { isTopDialog, popDialog, pushDialog } from "../lib/dialogStack";

export interface AppDialogProps {
  open: boolean;
  title: string;
  variant?: "dialog" | "drawer";
  initialFocusSelector?: string;
  onClose: () => void;
  children: ReactNode;
}

export default function AppDialog({ open, title, variant = "dialog", initialFocusSelector, onClose, children }: AppDialogProps) {
  const token = useRef(Symbol("relay-dialog"));
  const panel = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pushDialog(token.current);
    const focusable = () => Array.from(panel.current?.querySelectorAll<HTMLElement>(
      'button, a[href], input, textarea, select, summary, [tabindex]'
    ) ?? []).filter((item) => {
      if (item.tabIndex < 0 || item.matches(':disabled, input[type="hidden"]')) return false;
      for (let ancestor: HTMLElement | null = item; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.hidden || ancestor.hasAttribute("inert")) return false;
        const style = getComputedStyle(ancestor);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
        if (ancestor.tagName === "DETAILS" && !ancestor.hasAttribute("open")) {
          const summary = Array.from(ancestor.children).find((child) => child.tagName === "SUMMARY");
          if (!summary?.contains(item)) return false;
        }
      }
      return true;
    });
    const onKeydown = (event: KeyboardEvent) => {
      if (!isTopDialog(token.current) || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        panel.current?.focus();
      } else if (!elements.includes(document.activeElement as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? elements.at(-1) : elements[0])?.focus();
      } else if (event.shiftKey && document.activeElement === elements[0]) {
        event.preventDefault();
        elements.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === elements.at(-1)) {
        event.preventDefault();
        elements[0]?.focus();
      }
    };
    document.addEventListener("keydown", onKeydown);
    const focusFrame = requestAnimationFrame(() => {
      if (!isTopDialog(token.current)) return;
      const elements = focusable();
      const requested = initialFocusSelector ? panel.current?.querySelector<HTMLElement>(initialFocusSelector) : null;
      (requested && elements.includes(requested) ? requested : elements[0] ?? panel.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(focusFrame);
      const wasTop = isTopDialog(token.current);
      popDialog(token.current);
      document.removeEventListener("keydown", onKeydown);
      if (wasTop && returnFocus?.isConnected) returnFocus.focus();
    };
  }, [open, initialFocusSelector]);

  if (!open) return null;
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && isTopDialog(token.current)) closeRef.current();
    }}>
      <section ref={panel} className={`dialog-panel dialog-panel--${variant}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header className="dialog-header">
          <h2>{title}</h2>
          <button className="icon-button" type="button" aria-label="关闭面板" onClick={() => { if (isTopDialog(token.current)) closeRef.current(); }}><X aria-hidden="true" /></button>
        </header>
        <div className="dialog-content">{children}</div>
      </section>
    </div>,
    document.body
  );
}
