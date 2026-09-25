import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { isTopDialog, popDialog, pushDialog } from "../lib/dialogStack";

export interface AppDialogProps {
  open: boolean;
  title: string;
  variant?: "dialog" | "drawer";
  onClose: () => void;
  children: ReactNode;
}

export default function AppDialog({ open, title, variant = "dialog", onClose, children }: AppDialogProps) {
  const token = useRef(Symbol("relay-dialog"));
  const panel = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pushDialog(token.current);
    const focusable = () => Array.from(panel.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? []).filter((item) => !item.hasAttribute("hidden"));
    const onKeydown = (event: KeyboardEvent) => {
      if (!isTopDialog(token.current)) return;
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
      } else if (event.shiftKey && document.activeElement === elements[0]) {
        event.preventDefault();
        elements.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === elements.at(-1)) {
        event.preventDefault();
        elements[0]?.focus();
      }
    };
    document.addEventListener("keydown", onKeydown);
    requestAnimationFrame(() => (focusable()[0] ?? panel.current)?.focus());
    return () => {
      popDialog(token.current);
      document.removeEventListener("keydown", onKeydown);
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={panel} className={`dialog-panel dialog-panel--${variant}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header className="dialog-header">
          <h2>{title}</h2>
          <button className="icon-button" type="button" aria-label="关闭面板" onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="dialog-content">{children}</div>
      </section>
    </div>,
    document.body
  );
}
