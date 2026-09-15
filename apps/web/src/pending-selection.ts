import type { PlanState } from "@zhilu/contracts";

interface PendingCandidate {
  patch: { id: string; baseVersion: number };
  event: { occurredAt: string };
  afterPreview: { projectId: string };
}

export function selectCurrentPending<T extends PendingCandidate>(pending: readonly T[], plan: Pick<PlanState, "projectId" | "version">): T | null {
  let selected: T | null = null;
  let newestTime = -Infinity;
  for (const proposal of pending) {
    if (proposal.patch.baseVersion !== plan.version || proposal.afterPreview.projectId !== plan.projectId) continue;
    const parsed = Date.parse(proposal.event.occurredAt);
    const occurredAt = Number.isFinite(parsed) ? parsed : -Infinity;
    // Equal or invalid timestamps use patch IDs, independent of the server's array order.
    if (selected === null || occurredAt > newestTime || (occurredAt === newestTime && proposal.patch.id < selected.patch.id)) {
      selected = proposal;
      newestTime = occurredAt;
    }
  }
  return selected;
}
