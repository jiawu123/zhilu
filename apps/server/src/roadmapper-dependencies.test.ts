import { mkdtemp, rm } from "node:fs/promises";
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
import type { RoadmapperProvider } from "./roadmapper-provider";
import type { ZhihuProvider } from "./zhihu-provider";

type Draft = ReturnType<typeof roadmapperDraftFixture>;
const close: Array<() => Promise<void>> = [];
const now = "2026-09-13T00:00:00Z";
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now)); });
afterEach(async () => { for (const cleanup of close.splice(0)) await cleanup(); vi.useRealTimers(); });

function addSameWeekPrerequisite(input: RoadmapperInput): Draft {
  const draft = roadmapperDraftFixture(input);
  draft.routes = draft.routes.slice(0, 1);
  const route = draft.routes[0]!, first = route.tasks[0]!;
  first.hours /= 2;
  const prerequisite = { ...structuredClone(first), id: "prepare-first", title: "先整理本周试写材料", dependsOn: [] };
  first.dependsOn = [prerequisite.id];
  // Deliberately place the prerequisite after its dependent in untrusted model output.
  route.tasks.push(prerequisite);
  return draft;
}

async function setup(makeDraft: (input: RoadmapperInput) => Draft = roadmapperDraftFixture) {
  const snapshot = syntheticM3Snapshot(now);
  const root = await mkdtemp(join(tmpdir(), "zhilu-roadmapper-dependencies-"));
  const repository = new PlanRepository(root, "unused");
  await repository.savePlan(snapshot.plan);
  const planForBaseline = vi.fn(async () => ({ status: "ready_for_review" as const,
    questions: snapshot.research.questions, clarificationQuestions: [] }));
  const researchOne = vi.fn(async ({ request }: Parameters<ZhihuProvider["researchOne"]>[0]) => {
    const index = snapshot.research.questions.findIndex(question => question.question === request.question);
    if (index < 0) throw new Error("Unexpected additional research question");
    const pack = structuredClone(snapshot.research.evidencePacks[index]!);
    pack.requestId = request.id;
    return { runId: `run-${request.id}`, status: "ok" as const, pack, issues: [],
      metrics: { search_calls_attempted: request.searchQueries.length, evidence_count: pack.evidence.length } };
  });
  const generate = vi.fn(async (value: Parameters<RoadmapperProvider["generate"]>[0]) => makeDraft(value as RoadmapperInput));
  const server = createZhiluServer(repository, { liveEnabled: true,
    zhihuProvider: { planForBaseline, researchOne }, roadmapperProvider: { generate } });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  close.push(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${snapshot.plan.projectId}`;
  const post = (path: string, body?: unknown) => fetch(`${base}/${path}`, { method: "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  return { repository, plan: snapshot.plan, questions: snapshot.research.questions, base, post, planForBaseline, researchOne, generate };
}

function assertOneBoundedResearch(fixture: Awaited<ReturnType<typeof setup>>) {
  expect(fixture.planForBaseline).toHaveBeenCalledTimes(1);
  expect(fixture.generate).toHaveBeenCalledTimes(1);
  expect(fixture.researchOne).toHaveBeenCalledTimes(fixture.questions.length);
  expect(fixture.researchOne.mock.calls.flatMap(([value]) => value.request.searchQueries))
    .toEqual(fixture.questions.flatMap(question => question.searchQueries));
}

describe("Roadmapper dependency HTTP boundary", () => {
  it("accepts an unordered same-week DAG and retains Engine hard dependency enforcement after apply", async () => {
    const fixture = await setup(addSameWeekPrerequisite);
    const before = await fixture.repository.getPlan(fixture.plan.projectId);
    const response = await fixture.post("research/live/baseline");
    expect(response.status).toBe(202);
    const proposal = await response.json() as BaselineProposal;
    expect(proposal.roadmapper!.mode).toBe("model");
    const preview = proposal.previews[0]!.plan;
    const tasks = preview.nodes.filter(node => node.type === "task");
    expect(tasks.findIndex(node => node.id === "prepare-first")).toBeLessThan(tasks.findIndex(node => node.id === "t1"));
    expect(tasks.find(node => node.id === "prepare-first")!.startDate).toBe(tasks.find(node => node.id === "t1")!.startDate);
    expect(tasks.find(node => node.id === "prepare-first")!.endDate).toBe(tasks.find(node => node.id === "t1")!.endDate);
    expect(preview.relations).toContainEqual(expect.objectContaining({ sourceId: "t1", targetId: "prepare-first", hard: true }));
    expect(await fixture.repository.getPlan(fixture.plan.projectId)).toEqual(before);
    expect(await fixture.repository.getHistory(fixture.plan.projectId)).toHaveLength(0);
    assertOneBoundedResearch(fixture);

    const applied = await fixture.post("baseline/apply", { proposalId: proposal.id, routeId: proposal.recommendedRouteId });
    expect(applied.status).toBe(200);
    expect((await fixture.repository.getPlan(fixture.plan.projectId)).version).toBe(2);
    expect(await fixture.repository.getHistory(fixture.plan.projectId)).toHaveLength(1);
    const updateStatus = (id: string, status: string) => fetch(`${fixture.base}/nodes/${id}`, { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
    const blocked = await updateStatus("t1", "in_progress");
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: "HARD_DEPENDENCY_UNMET" })]) });
    expect((await fixture.repository.getPlan(fixture.plan.projectId)).version).toBe(2);
    expect((await updateStatus("prepare-first", "done")).status).toBe(200);
    expect((await updateStatus("t1", "in_progress")).status).toBe(200);
    const active = await fixture.repository.getPlan(fixture.plan.projectId);
    expect(active.nodes.find(node => node.id === "t1")!.status).toBe("in_progress");
    expect(active.relations).toContainEqual(expect.objectContaining({ sourceId: "t1", targetId: "prepare-first", hard: true }));
    assertOneBoundedResearch(fixture);
  });

  it.each(["cycle", "dangling", "future"])("rejects a %s dependency without replacing the old pending draft or formal state", async failure => {
    const fixture = await setup();
    expect((await fixture.post("research/live/baseline")).status).toBe(202);
    const before: PlanState = await fixture.repository.getPlan(fixture.plan.projectId);
    const pending = await fixture.repository.getBaselineProposals(fixture.plan.projectId);
    const history = await fixture.repository.getHistory(fixture.plan.projectId);
    fixture.generate.mockClear(); fixture.planForBaseline.mockClear(); fixture.researchOne.mockClear();
    fixture.generate.mockImplementationOnce(async value => {
      const draft = addSameWeekPrerequisite(value as RoadmapperInput), route = draft.routes[0]!;
      if (failure === "cycle") route.tasks.find(task => task.id === "prepare-first")!.dependsOn = ["t1"];
      if (failure === "dangling") route.tasks[0]!.dependsOn = ["missing-task"];
      if (failure === "future") route.tasks[0]!.dependsOn = ["t2"];
      return draft;
    });
    const failed = await fixture.post("research/live/baseline");
    expect(failed.status).toBe(422);
    expect(await failed.json()).toMatchObject({ code: "invalid_roadmap" });
    expect(await fixture.repository.getBaselineProposals(fixture.plan.projectId)).toEqual(pending);
    expect(await fixture.repository.getPlan(fixture.plan.projectId)).toEqual(before);
    expect(await fixture.repository.getHistory(fixture.plan.projectId)).toEqual(history);
    assertOneBoundedResearch(fixture);
  });
});
