import type { BaselineProposal, PlanState } from "@zhilu/contracts";
import { compileRoadmapperBaseline, prepareRoadmapperInput, type LiveResearchInput } from "@zhilu/agent-runtime";
import { PlanEngineError, validatePlan } from "@zhilu/plan-engine";
import type { RoadmapperProvider } from "./roadmapper-provider";

/** Recompile a pending draft against its existing evidence; never commit or run retrieval. */
export async function reviseBaseline(plan: PlanState, proposal: BaselineProposal, routeId: string, message: string,
  provider: RoadmapperProvider, now: string): Promise<BaselineProposal> {
  const research: LiveResearchInput = { ...proposal.researchRun, runId: proposal.researchRun.id,
    proposalId: `baseline-${crypto.randomUUID()}`, now };
  const input = prepareRoadmapperInput(plan, research, `roadmapper-${crypto.randomUUID()}`);
  const selected = proposal.previews.find(preview => preview.routeId === routeId)!;
  const conversation = [...(proposal.conversation ?? []), { role: "user" as const, content: message }];
  const output = await provider.generate({
    systemPrompt: input.systemPrompt + "\n用户正在确认前修改草稿。根据 revision 中的当前草稿和对话修改，保留未要求改变的安排、历轮已接受的调整和证据引用。recommendationReason 直接解释本轮改动；无法满足的请求明确解释原因。不得自行更改已确认目标、期限或每周工时；这些冲突写入风险与解释。仍只输出约定的完整路线 JSON。",
    context: { ...input.context, revision: { selectedRouteId: routeId, conversation,
      currentDraft: { nodes: selected.plan.nodes, relations: selected.plan.relations } } },
  });
  const next = compileRoadmapperBaseline(plan, research, input, output);
  for (const preview of next.previews) {
    const validation = validatePlan(preview.plan);
    if (!validation.valid) throw new PlanEngineError(validation.issues);
  }
  next.conversation = [...conversation, { role: "assistant", content: next.roadmapper!.recommendationReason }];
  return next;
}
