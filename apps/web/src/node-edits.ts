import type { PlanNode, PlanNodeUpdate } from "@zhilu/contracts";

export interface NodeDraft { title: string; startDate: string; endDate: string; status: PlanNode["status"] }
export function draftFromNode(node: PlanNode): NodeDraft {
  return { title: node.title, startDate: node.startDate ?? "", endDate: node.endDate ?? "", status: node.status };
}
/** Send only changed fields so inspecting/saving does not lock unrelated dates or status. */
export function nodeEdits(node: PlanNode, draft: NodeDraft): PlanNodeUpdate {
  const changes: PlanNodeUpdate = {};
  if (draft.title.trim() !== node.title) changes.title = draft.title.trim();
  if (draft.status !== node.status) changes.status = draft.status;
  if (draft.startDate !== (node.startDate ?? "")) changes.startDate = draft.startDate;
  if (draft.endDate !== (node.endDate ?? "")) changes.endDate = draft.endDate;
  return changes;
}
