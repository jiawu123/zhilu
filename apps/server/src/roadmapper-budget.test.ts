import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaselineProposal, PlanState } from "@zhilu/contracts";
import type { RoadmapperInput } from "@zhilu/agent-runtime";
import { roadmapperDraftFixture } from "../../../packages/agent-runtime/src/roadmapper.test-fixture";
import { syntheticM3Snapshot } from "./fixtures/m3-replay";
import { createZhiluServer } from "./index";
import { PlanRepository } from "./repository";
import type { ZhihuProvider } from "./zhihu-provider";

const close: Array<() => Promise<void>> = [];
const now = "2026-09-13T00:00:00Z";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
  vi.stubEnv("ROADMAP_WEEKLY_TOLERANCE_PERCENT", "10"); vi.stubEnv("ROADMAP_WEEKLY_TOLERANCE_HOURS", "1");
});
afterEach(async () => { for (const cleanup of close.splice(0)) await cleanup(); vi.useRealTimers(); vi.unstubAllEnvs(); });

async function setup(overrun = 0.5) {
  const snapshot = syntheticM3Snapshot(now), root = await mkdtemp(join(tmpdir(), "zhilu-roadmapper-budget-"));
  const repository = new PlanRepository(root, "unused"); await repository.savePlan(snapshot.plan);
  const planForBaseline = vi.fn(async () => ({ status: "ready_for_review" as const,
    questions: snapshot.research.questions, clarificationQuestions: [] }));
  const researchOne = vi.fn(async ({ request }: Parameters<ZhihuProvider["researchOne"]>[0]) => {
    const index = snapshot.research.questions.findIndex(question => question.question === request.question);
    if (index < 0) throw new Error("Unexpected question");
    return { runId: `run-${request.id}`, status: "ok" as const,
      pack: { ...structuredClone(snapshot.research.evidencePacks[index]!), requestId: request.id }, issues: [],
      metrics: { search_calls_attempted: request.searchQueries.length } };
  });
  const generate = vi.fn(async (value: { systemPrompt: string; context: unknown }) => {
    const input = value as RoadmapperInput, draft = roadmapperDraftFixture(input);
    for (const route of draft.routes) route.tasks[0]!.hours = input.context.weeks[0]!.capacityHours - input.context.weeks[0]!.reviewHours + overrun;
    return draft;
  });
  const server = createZhiluServer(repository, { liveEnabled: true, zhihuProvider: { planForBaseline, researchOne }, roadmapperProvider: { generate } });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  close.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${snapshot.plan.projectId}`;
  return { snapshot, root, repository, base, planForBaseline, researchOne, generate,
    post: () => fetch(`${base}/research/live/baseline`, { method: "POST" }) };
}

describe("Roadmapper weekly tolerance HTTP configuration", () => {
  it("accepts a tolerated overrun with explicit warnings and unchanged confirmed hours, and persists the policy before model execution", async () => {
    const fixture = await setup();
    expect(await fixture.repository.getPlan(fixture.snapshot.plan.projectId)).toEqual(fixture.snapshot.plan);
    expect(await fixture.repository.getHistory(fixture.snapshot.plan.projectId)).toHaveLength(0);
    const response = await fixture.post(); expect(response.status).toBe(202);
    const proposal = await response.json() as BaselineProposal;
    expect(proposal.roadmapper!.planningBudget).toEqual({ weeklyToleranceRatio: 0.1, weeklyToleranceHours: 1 });
    expect(proposal.roadmapper!.weeklyOverruns).toEqual(expect.arrayContaining([expect.objectContaining({ week: 1, capacityHours: 6, plannedHours: 6.5 })]));
    expect(proposal.roadmapper!.warnings.length).toBeGreaterThan(0);
    expect(proposal.previews[0]!.plan.weeklyHours).toBe(6);
    expect(proposal.previews[0]!.plan.userContext!.weeklyHours).toBe(6);
    expect(proposal.previews[0]!.plan.nodes.find(node => node.id === "t1")!.estimatedHours).toBe(6);
    expect(await fixture.repository.getPlan(fixture.snapshot.plan.projectId)).toEqual(fixture.snapshot.plan);
    expect(await fixture.repository.getHistory(fixture.snapshot.plan.projectId)).toHaveLength(0);
    const directory = join(fixture.root, fixture.snapshot.plan.projectId, ".plan", "research-snapshots");
    const snapshot = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]!), "utf8"));
    expect(snapshot.research.planningBudget).toEqual(proposal.roadmapper!.planningBudget);
    expect(fixture.generate).toHaveBeenCalledTimes(1);

    const applied = await fetch(`${fixture.base}/baseline/apply`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: proposal.id, routeId: proposal.recommendedRouteId }) });
    expect(applied.status).toBe(200);
    await applied.json();
    const responseAfterApply = await fetch(fixture.base);
    expect(responseAfterApply.status).toBe(200);
    const workspace = await responseAfterApply.json() as { plan: PlanState; history: unknown[]; baselineProposals: BaselineProposal[] };
    expect(workspace.plan.version).toBe(2);
    expect(workspace.plan.weeklyHours).toBe(6);
    expect(workspace.plan.userContext!.weeklyHours).toBe(6);
    expect(workspace.plan.nodes.find(node => node.id === "t1")!.estimatedHours).toBe(6);
    expect(workspace.plan.research!.roadmapper!.planningBudget).toEqual(proposal.roadmapper!.planningBudget);
    expect(workspace.plan.research!.roadmapper!.weeklyOverruns).toEqual(proposal.roadmapper!.weeklyOverruns);
    expect(workspace.plan.research!.roadmapper!.warnings).toEqual(proposal.roadmapper!.warnings);
    expect(workspace.history).toHaveLength(1);
    expect(workspace.baselineProposals).toHaveLength(0);
    expect(await fixture.repository.getPlan(fixture.snapshot.plan.projectId)).toEqual(workspace.plan);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
  });

  it("attaches explicitly configured policy instead of silently using the default", async () => {
    vi.stubEnv("ROADMAP_WEEKLY_TOLERANCE_PERCENT", "20"); vi.stubEnv("ROADMAP_WEEKLY_TOLERANCE_HOURS", "0.75");
    const fixture = await setup(0.7), response = await fixture.post();
    expect(response.status).toBe(202);
    const proposal = await response.json() as BaselineProposal;
    expect(proposal.researchRun.planningBudget).toEqual({ weeklyToleranceRatio: 0.2, weeklyToleranceHours: 0.75 });
  });

  it.each(["percentage", "hours"])("supports strict zero %s configuration", async field => {
    vi.stubEnv(field === "percentage" ? "ROADMAP_WEEKLY_TOLERANCE_PERCENT" : "ROADMAP_WEEKLY_TOLERANCE_HOURS", "0");
    const fixture = await setup(0.01), response = await fixture.post();
    expect(response.status).toBe(422);
    expect(await fixture.repository.getBaselineProposals(fixture.snapshot.plan.projectId)).toHaveLength(0);
    expect(await fixture.repository.getPlan(fixture.snapshot.plan.projectId)).toEqual(fixture.snapshot.plan);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
  });

  it("rejects beyond the bounded tolerance without writing a proposal or shrinking model estimates", async () => {
    const fixture = await setup(0.61), response = await fixture.post();
    expect(response.status).toBe(422);
    expect(await fixture.repository.getBaselineProposals(fixture.snapshot.plan.projectId)).toHaveLength(0);
    expect(await fixture.repository.getHistory(fixture.snapshot.plan.projectId)).toHaveLength(0);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid local tolerance before any Planner, search or model call", async () => {
    vi.stubEnv("ROADMAP_WEEKLY_TOLERANCE_PERCENT", "SECRET_INVALID_VALUE");
    const fixture = await setup(), response = await fixture.post();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("SECRET_INVALID_VALUE");
    expect(fixture.planForBaseline).not.toHaveBeenCalled(); expect(fixture.researchOne).not.toHaveBeenCalled(); expect(fixture.generate).not.toHaveBeenCalled();
    expect(await fixture.repository.getPlan(fixture.snapshot.plan.projectId)).toEqual(fixture.snapshot.plan);
  });
});
