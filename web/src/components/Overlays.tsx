import { useEffect, useRef } from "react";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "删除",
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="dialog-scrim" onMouseDown={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="dialog-kicker">删除后无法恢复</p>
        <h2 id="dialog-title" className="dialog-title">
          {title}
        </h2>
        <p className="dialog-body">{body}</p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-quiet" onClick={onCancel} ref={cancelRef}>
            取消
          </button>
          <button type="button" className={danger ? "btn btn-danger" : "btn btn-primary"} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export type ToastData = {
  id: number;
  message: string;
  detail?: string;
  tone?: "default" | "error";
};

export function Toast({ toast, onDismiss }: { toast: ToastData | null; onDismiss: () => void }) {
  if (!toast) return null;
  return (
    <div className={`toast ${toast.tone === "error" ? "is-error" : ""}`} role="status" aria-live="polite" key={toast.id}>
      <span className="toast-rule" aria-hidden="true" />
      <div className="toast-copy">
        <span>{toast.message}</span>
        {toast.detail ? <small>{toast.detail}</small> : null}
      </div>
      <button type="button" className="toast-close" onClick={onDismiss} aria-label="关闭提示">
        ×
      </button>
    </div>
  );
}
