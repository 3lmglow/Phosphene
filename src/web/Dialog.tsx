import { type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(", ");

export function Modal({
  label,
  className = "",
  onClose,
  children
}: {
  label: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [previous] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    const dialog = dialogRef.current!;
    if (!dialog.contains(document.activeElement)) dialog.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [previous]);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className={`dialog ${className}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {children}
      </section>
    </div>
  );
}

type ConfirmRequest = {
  title: string;
  body: string;
  confirmLabel?: string;
  destructive?: boolean;
};

const ConfirmContext = createContext<(request: ConfirmRequest) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<(ConfirmRequest & { resolve: (confirmed: boolean) => void }) | null>(null);
  const ask = useCallback(
    (next: ConfirmRequest) => new Promise<boolean>((resolve) => setRequest({ ...next, resolve })),
    []
  );
  function settle(confirmed: boolean) {
    request?.resolve(confirmed);
    setRequest(null);
  }
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {request && (
        <Modal label={request.title} className="confirm-dialog" onClose={() => settle(false)}>
          <h2>{request.title}</h2>
          <p>{request.body}</p>
          <div className="button-row">
            <button type="button" className="button button--ghost" autoFocus={request.destructive} onClick={() => settle(false)}>
              取消
            </button>
            <button
              type="button"
              className={`button button--grow ${request.destructive ? "button--danger" : "button--primary"}`}
              autoFocus={!request.destructive}
              onClick={() => settle(true)}
            >
              {request.confirmLabel ?? "确定"}
            </button>
          </div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmContext);
