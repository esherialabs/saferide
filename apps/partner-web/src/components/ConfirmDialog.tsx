import { useEffect, useId, useRef, type ReactNode } from 'react';

import { t } from '../lib/i18n.ts';

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** What Escape does; defaults to onCancel. */
  onEscape?: () => void;
  /** Which button has focus when the dialog opens; defaults to cancel (the safe choice). */
  initialFocus?: 'cancel' | 'confirm';
  busy?: boolean;
  /** The confirm button alone is unavailable (e.g. while choices load). */
  confirmDisabled?: boolean;
  tone?: 'primary' | 'danger';
  role?: 'dialog' | 'alertdialog';
  testId?: string;
  /** False when the body is a form (a list of choices): it is not read out as the description. */
  describe?: boolean;
};

/**
 * A modal built on the native <dialog>: the browser traps focus and Escape
 * cancels it. Focus starts on the safe choice and returns to the control
 * that opened it.
 */
export function ConfirmDialog({
  open, title, children, confirmLabel, cancelLabel = t('common.cancel'), onConfirm, onCancel, onEscape, initialFocus = 'cancel', busy = false, confirmDisabled = false,
  tone = 'primary', role = 'dialog', testId, describe = true,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = `dialog-${useId().replace(/:/g, '')}`;
  const bodyId = `${titleId}-body`;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      dialog.showModal();
      (initialFocus === 'confirm' ? confirmRef : cancelRef).current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
    }
  }, [open, initialFocus]);

  return (
    <dialog
      ref={ref}
      role={role}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={describe ? bodyId : undefined}
      data-testid={testId}
      className="w-[min(32rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-0 text-ink shadow-3"
      onCancel={event => {
        event.preventDefault();
        if (!busy) (onEscape ?? onCancel)();
      }}
    >
      <div className="p-6">
        <h2 id={titleId}>{title}</h2>
        <div id={bodyId} className="mt-3 space-y-2 text-ink-2">{children}</div>
        <div className="mt-6 flex flex-wrap justify-end gap-3 border-t border-line pt-4">
          <button ref={cancelRef} type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button ref={confirmRef} type="button" className={tone === 'danger' ? 'btn-danger' : 'btn-primary'} onClick={onConfirm} disabled={busy || confirmDisabled}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
