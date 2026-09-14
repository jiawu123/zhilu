import { useEffect, useRef, type ReactNode } from "react";

/** Native modal semantics keep the background inert, trap focus and support nested dialogs. */
export function ModalSurface({ open = true, label, busy = false, onClose, children }: {
  open?: boolean; label: string; busy?: boolean; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-initial-focus]")?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      // A successful action may replace this dialog with another one.
      queueMicrotask(() => {
        const remaining = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].at(-1);
        if (remaining) {
          if (trigger?.isConnected && remaining.contains(trigger)) trigger.focus({ preventScroll: true });
          else if (!remaining.contains(document.activeElement)) remaining.querySelector<HTMLElement>("[data-initial-focus]")?.focus({ preventScroll: true });
          return;
        }
        // Respect an explicit handoff, such as opening the change composer from task details.
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body && active !== trigger
          && active.isConnected && !dialog.contains(active)) return;
        const target = trigger?.isConnected ? trigger : document.querySelector<HTMLElement>(".brand-toggle");
        target?.focus({ preventScroll: true });
      });
    };
  }, [open]);
  if (!open) return null;
  return <dialog ref={ref} className="modal-surface" aria-label={label}
    onKeyDown={event => {
      if (event.key !== "Tab" || event.defaultPrevented || (event.target as Element).closest("dialog") !== event.currentTarget) return;
      // WebKit's platform keyboard preferences can otherwise skip buttons and leave the dialog.
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, summary, [tabindex]")]
        .filter(element => element.tabIndex >= 0 && !element.matches(":disabled, [hidden]") && element.getClientRects().length > 0);
      if (!controls.length) return;
      event.preventDefault();
      const index = controls.indexOf(document.activeElement as HTMLElement);
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
    }}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    {children}
  </dialog>;
}

export function ConfirmDialog({ title, description, confirmLabel, busy = false, onCancel, onConfirm, children }: {
  title: string; description: string; confirmLabel: string; busy?: boolean; onCancel: () => void; onConfirm: () => void; children?: ReactNode;
}) {
  return <ModalSurface label={title} busy={busy} onClose={onCancel}>
    <section className="event-modal confirm-modal">
      <h2>{title}</h2><p>{description}</p>{children}
      <div className="confirm-actions"><button data-initial-focus disabled={busy} onClick={onCancel}>取消</button>
        <button className="research-primary" disabled={busy} onClick={onConfirm}>{busy ? "正在处理…" : confirmLabel}</button></div>
    </section>
  </ModalSurface>;
}
