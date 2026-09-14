import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { BaselineProposal } from "@zhilu/contracts";
import { compileRoadmapperBaseline, prepareRoadmapperInput, type RoadmapperInput } from "@zhilu/agent-runtime";
import { roadmapperDraftFixture } from "../../../packages/agent-runtime/src/roadmapper.test-fixture";
import { syntheticM3Snapshot } from "./fixtures/m3-replay";
import { createZhiluServer } from "./index";
import { PlanRepository } from "./repository";
import { reviseBaseline } from "./baseline-revision";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });

describe("plan conversation before confirmation", () => {
  it("retains the saved tolerance through repeated revisions despite looser Server settings", async () => {
    const { plan, research } = syntheticM3Snapshot();
    research.planningBudget = { weeklyToleranceRatio: 0.05, weeklyToleranceHours: 0.25 };
    const input = prepareRoadmapperInput(plan, research, "initial-budget-model");
    const proposal = compileRoadmapperBaseline(plan, research, input, roadmapperDraftFixture(input));
    const generate = vi.fn(async (value: RoadmapperInput) => roadmapperDraftFixture(value));
    vi.stubEnv("ROADMAP_WEEKLY_TOLERANCE_PERCENT", "50"); vi.stubEnv("ROADMAP_WEEKLY_TOLERANCE_HOURS", "8");
    try {
      const next = await reviseBaseline(plan, proposal, proposal.recommendedRouteId, "先收集反馈", { generate }, research.now);
      const latest = await reviseBaseline(plan, next, next.recommendedRouteId, "再整理材料", { generate }, research.now);
      expect(next.roadmapper!.planningBudget).toEqual(research.planningBudget);
      expect(latest.roadmapper!.planningBudget).toEqual(research.planningBudget);
      expect(latest.researchRun.planningBudget).toEqual(research.planningBudget);
      expect(generate.mock.calls.every(([value]) => JSON.stringify(value.context.planningBudget) === JSON.stringify(research.planningBudget))).toBe(true);
      expect(plan.weeklyHours).toBe(6);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([0, 1])("revises an insufficient draft with %i valid cards without reusing prior AI inference IDs", async count => {
    const { plan, research } = syntheticM3Snapshot();
    research.evidencePacks.forEach((pack, index) => { pack.evidence = pack.evidence.slice(0, index === 0 ? count : 0); pack.routeCandidates = []; });
    const input = prepareRoadmapperInput(plan, research, "initial-model");
    const draft = roadmapperDraftFixture(input), userFactId = input.context.userFacts[0]!.id;
    draft.routes[0]!.tasks[0]!.evidenceIds = [userFactId];
    draft.routes[0]!.evidenceApplications.forEach(application => { application.taskIds.shift(); });
    const proposal = compileRoadmapperBaseline(plan, research, input, draft);
    const before = structuredClone({ plan, proposal });
    const priorInference = proposal.previews[0]!.plan.evidence.find(card => card.sourceType === "ai")!.id;
    const generate = vi.fn(async (value: RoadmapperInput) => ({ ...roadmapperDraftFixture(value), recommendationReason: "按照已确认条件调整，证据仍不足。" }));
    const revised = await reviseBaseline(plan, proposal, proposal.recommendedRouteId, "先完成可核实的准备事项", { generate }, research.now);
    expect(generate).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(generate.mock.calls[0]![0]);
    expect(sent).not.toContain(priorInference);
    expect(sent).toContain(userFactId);
    expect(revised.roadmapper).toMatchObject({ mode: "model", evidenceStatus: "insufficient" });
    expect(revised.roadmapper!.warnings).toContain("证据不足");
    expect(revised.previews).toHaveLength(1);
    expect(revised.previews[0]!.plan.nodes.every(node => !node.evidenceIds.includes(priorInference))).toBe(true);
    expect({ plan, proposal }).toEqual(before);
  });

  it("uses cached evidence, preserves conversation, rejects stale confirmation, and writes only when confirmed", async () => {
    const root = await mkdtemp(join(tmpdir(), "zhilu-revision-"));
    const repository = new PlanRepository(root, "unused");
    const { plan, research } = syntheticM3Snapshot();
    const initialInput = prepareRoadmapperInput(plan, research, "initial-model");
    const proposal = compileRoadmapperBaseline(plan, research, initialInput, roadmapperDraftFixture(initialInput));
    await repository.savePlan(plan);
    await repository.saveBaselineProposal(plan.projectId, proposal);
    const generate = vi.fn(async (input: RoadmapperInput) => ({ ...roadmapperDraftFixture(input), recommendationReason: "已调整为优先试写，再收集读者反馈。" }));
    const server = createZhiluServer(repository, { roadmapperProvider: { generate } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${plan.projectId}/baseline`;
    const post = (path: string, body: unknown) => fetch(`${url}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const first = await post("revise", { proposalId: proposal.id, routeId: proposal.recommendedRouteId, message: "前两周先试写" });
    expect(first.status).toBe(200);
    const next = await first.json() as BaselineProposal;
    expect(next.id).not.toBe(proposal.id);
    expect(next.conversation).toEqual([{ role: "user", content: "前两周先试写" }, { role: "assistant", content: "已调整为优先试写，再收集读者反馈。" }]);
    expect(await repository.getPlan(plan.projectId)).toEqual(plan);
    expect(await repository.getHistory(plan.projectId)).toHaveLength(0);
    expect(await repository.getBaselineProposals(plan.projectId)).toHaveLength(1);
    expect(generate.mock.calls[0]![0].context.evidence).toEqual(initialInput.context.evidence);
    expect(generate.mock.calls[0]![0].context).toHaveProperty("revision.currentDraft.nodes");
    expect((await post("apply", { proposalId: proposal.id, routeId: proposal.recommendedRouteId })).status).toBe(404);
    const second = await post("revise", { proposalId: next.id, routeId: next.recommendedRouteId, message: "然后增加读者反馈" });
    expect(second.status).toBe(200);
    const latest = await second.json() as BaselineProposal;
    expect(latest.conversation).toHaveLength(4);
    expect(generate.mock.calls[1]![0].context).toHaveProperty("revision.conversation", [...next.conversation!, { role: "user", content: "然后增加读者反馈" }]);
    expect((await post("apply", { proposalId: latest.id, routeId: latest.recommendedRouteId })).status).toBe(200);
    expect((await repository.getPlan(plan.projectId)).version).toBe(2);
    expect(await repository.getHistory(plan.projectId)).toHaveLength(1);
    expect((await repository.getPlanningHistory(plan.projectId)).find(item => item.id === latest.id)?.conversation).toEqual(latest.conversation);
    expect((await fetch(url.replace("/baseline", "/planning-history"))).status).toBe(200);
    expect((await post("revise", { proposalId: latest.id, routeId: latest.recommendedRouteId, message: "已确认后修改" })).status).toBe(409);
  });
});
