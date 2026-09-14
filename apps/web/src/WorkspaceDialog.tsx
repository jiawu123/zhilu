import { useId, type ReactNode } from "react";
import { ModalSurface } from "./ModalSurface";

export function WorkspaceDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  return <ModalSurface label={title} onClose={onClose}><section className="workspace-dialog account-history" aria-labelledby={titleId}>
    <header><h2 id={titleId}>{title}</h2><button data-initial-focus onClick={onClose}>关闭</button></header>
    {children}
  </section></ModalSurface>;
}
