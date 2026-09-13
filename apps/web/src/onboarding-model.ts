export type FlowPage = "interview" | "plan" | "roadmap";

export function readFlowPage(search: string): FlowPage {
  const query = new URLSearchParams(search);
  if (query.get("page") === "interview" || !query.has("project")) return "interview";
  return query.get("page") === "plan" ? "plan" : "roadmap";
}

/** An unconfirmed project must never expose the execution graph, even via a direct URL. */
export function resolveFlowPage(requested: FlowPage, awaitingPlan: boolean): FlowPage {
  return requested === "roadmap" && awaitingPlan ? "plan" : requested;
}
