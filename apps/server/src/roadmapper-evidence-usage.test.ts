import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaselineProposal } from "@zhilu/contracts";
import type { RoadmapperInput } from "@zhilu/agent-runtime";
import { roadmapperDraftFixture } from "../../../packages/agent-runtime/src/roadmapper.test-fixture";
import { syntheticM3Snapshot } from "./fixtures/m3-replay";
import { createZhiluServer } from "./index";
import { PlanRepository } from "./repository";
import type { RoadmapperProvider } from "./roadmapper-provider";
import type { ZhihuProvider } from "./zhihu-provider";

type Application = { evidenceId: string; taskIds: string[]; application: string };
type Draft = ReturnType<typeof roadmapperDraftFixture>;
type UsageDraft = Omit<Draft, "routes"> & { routes: Array<Omit<Draft["routes"][number], "evidenceApplications"> & { evidenceApplications?: Application[] }> };
type ModelInput = Parameters<RoadmapperProvider["generate"]>[0];
type RoadmapperWithApplications = NonNullable<BaselineProposal["roadmapper"]> & {
  evidenceApplications: Array<Application & { routeId: string }>;
};
const cleanup: Array<() => Promise<void>> = [];
const now = "2026-09-13T00:00:00Z";
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now)); });
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.useRealTimers(); });

function clearCitations(input: RoadmapperInput): UsageDraft {
  const draft: UsageDraft = roadmapperDraftFixture(input);
  draft.recommendationEvidenceIds = [];
  for (const route of draft.routes) {
    route.evidenceIds = [];
    route.evidenceApplications = [];
    for (const milestone of route.milestones) milestone.evidenceIds = [];
    for (const task of route.tasks) task.evidenceIds = [];
  }
  return draft;
}

function mixedEvidenceDraft(input: RoadmapperInput): UsageDraft {
  const draft = clearCitations(input);
  const route = draft.routes[0]!, evidenceId = input.context.evidence[0]!.id;
  route.evidenceIds = [evidenceId];
  draft.recommendationEvidenceIds = [evidenceId];
  route.tasks[0]!.evidenceIds = [evidenceId];
  route.milestones[0]!.evidenceIds = [evidenceId];
  route.evidenceApplications = [{ evidenceId, taskIds: [route.tasks[0]!.id],
    application: "这张证据建议用章节草稿和读者反馈检查进度，适用于已有选题及反馈渠道的用户；因此把第一周改成完成试写并收集三条读者批注，产出可检查的章节草稿。" }];
  route.tasks[1]!.title = "安排后续各周写作时间并整理反馈记录目录";
  route.tasks[1]!.deliverable = "一份每周时间安排与反馈记录目录";
  route.tasks[1]!.acceptanceCriteria = ["每周写作时段符合已确认的可用时间"];
  return draft;
}

async function setup(evidencePerQuestion = 1) {
  const snapshot = syntheticM3Snapshot(now);
  for (const pack of snapshot.research.evidencePacks) {
    pack.evidence = pack.evidence.slice(0, evidencePerQuestion);
    pack.routeCandidates = evidencePerQuestion ? pack.routeCandidates.map(route => ({ ...route,
      evidenceIds: pack.evidence.map(card => card.id) })) : [];
  }
  const root = await mkdtemp(join(tmpdir(), "zhilu-roadmapper-evidence-usage-"));
  const repository = new PlanRepository(root, "unused");
  await repository.savePlan(snapshot.plan);
  const planForBaseline = vi.fn(async () => ({ status: "ready_for_review" as const,
    questions: snapshot.research.questions, clarificationQuestions: [] }));
  const researchOne = vi.fn(async ({ request }: Parameters<ZhihuProvider["researchOne"]>[0]) => {
    const index = snapshot.research.questions.findIndex(question => question.question === request.question);
    if (index < 0) throw new Error("Unexpected additional research question");
    const pack = structuredClone(snapshot.research.evidencePacks[index]!);
    pack.requestId = request.id;
    return { runId: `run-${request.id}`, status: pack.evidence.length ? "ok" as const : "no_evidence" as const,
      pack, issues: [], metrics: { search_calls_attempted: request.searchQueries.length, evidence_count: pack.evidence.length } };
  });
  const generate = vi.fn(async (input: ModelInput): Promise<unknown> => roadmapperDraftFixture(input as RoadmapperInput));
  const server = createZhiluServer(repository, { liveEnabled: true,
    zhihuProvider: { planForBaseline, researchOne }, roadmapperProvider: { generate } });
  await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", ready); });
  cleanup.push(async () => {
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${snapshot.plan.projectId}/research/live/baseline`;
  return { repository, projectId: snapshot.plan.projectId, questions: snapshot.research.questions,
    planForBaseline, researchOne, generate, post: () => fetch(endpoint, { method: "POST" }) };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
async function state(fixture: Fixture) {
  return { plan: await fixture.repository.getPlan(fixture.projectId),
    history: await fixture.repository.getHistory(fixture.projectId),
    pending: await fixture.repository.getBaselineProposals(fixture.projectId) };
}
function assertBoundedCalls(fixture: Fixture, modelCalls: number) {
  expect(fixture.generate).toHaveBeenCalledTimes(modelCalls);
  expect(fixture.planForBaseline).toHaveBeenCalledTimes(1);
  expect(fixture.researchOne).toHaveBeenCalledTimes(fixture.questions.length);
  expect(fixture.researchOne.mock.calls.flatMap(([input]) => input.request.searchQueries))
    .toEqual(fixture.questions.flatMap(question => question.searchQueries));
}

describe("Roadmapper evidence use at the live Baseline boundary", () => {
  it("corrects an all-AI draft when partial research contains usable evidence without repeating research", async () => {
    const fixture = await setup(), before = await state(fixture);
    let rejected: UsageDraft | undefined;
    fixture.generate.mockImplementationOnce(async input => {
      rejected = clearCitations(input as RoadmapperInput);
      return rejected;
    });
    fixture.generate.mockImplementationOnce(async input => mixedEvidenceDraft(input as RoadmapperInput));
    const response = await fixture.post();
    expect(response.status).toBe(202);
    const proposal = await response.json() as BaselineProposal;
    assertBoundedCalls(fixture, 2);
    const original = fixture.generate.mock.calls[0]![0] as RoadmapperInput;
    const { correction, ...correctedContext } = fixture.generate.mock.calls[1]![0].context as RoadmapperInput["context"] & {
      correction: { previousDraft: unknown; validationError: string };
    };
    expect(original.context.evidenceStatus).toBe("insufficient");
    expect(original.context.evidence).toHaveLength(2);
    expect(correctedContext).toEqual(original.context);
    expect(correction.previousDraft).toEqual(rejected);
    expect(correction.validationError).toBeTruthy();
    expect((proposal.roadmapper as RoadmapperWithApplications).evidenceApplications).toHaveLength(1);
    const after = await state(fixture);
    expect(after.plan).toEqual(before.plan);
    expect(after.history).toEqual(before.history);
    expect(after.pending.map(item => item.id)).toEqual([proposal.id]);
  });

  it.each(["all citations empty", "missing applications"])("rejects two drafts with %s while keeping the existing pending proposal and formal state", async failure => {
    const fixture = await setup();
    expect((await fixture.post()).status).toBe(202);
    const before = await state(fixture);
    fixture.generate.mockClear(); fixture.planForBaseline.mockClear(); fixture.researchOne.mockClear();
    fixture.generate.mockImplementation(async input => {
      if (failure === "all citations empty") return clearCitations(input as RoadmapperInput);
      const draft: UsageDraft = roadmapperDraftFixture(input as RoadmapperInput);
      for (const route of draft.routes) delete route.evidenceApplications;
      return draft;
    });
    const response = await fixture.post();
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "invalid_roadmap" });
    assertBoundedCalls(fixture, 2);
    expect(await state(fixture)).toEqual(before);
  });

  it("persists explicit evidence applications while allowing AI scheduling tasks without source citations", async () => {
    const fixture = await setup(), before = await state(fixture);
    fixture.generate.mockImplementation(async input => mixedEvidenceDraft(input as RoadmapperInput));
    const response = await fixture.post();
    expect(response.status).toBe(202);
    const proposal = await response.json() as BaselineProposal;
    assertBoundedCalls(fixture, 1);
    const evidenceId = "synthetic-0-0";
    const applications = [{ routeId: "build", evidenceId, taskIds: ["t1"],
      application: "这张证据建议用章节草稿和读者反馈检查进度，适用于已有选题及反馈渠道的用户；因此把第一周改成完成试写并收集三条读者批注，产出可检查的章节草稿。" }];
    expect((proposal.roadmapper as RoadmapperWithApplications).evidenceApplications).toEqual(applications);
    const preview = proposal.previews[0]!.plan;
    expect((preview.research!.roadmapper as RoadmapperWithApplications).evidenceApplications).toEqual(applications);
    expect(preview.nodes.find(node => node.id === "t1")!.evidenceIds).toContain(evidenceId);
    const aiTask = preview.nodes.find(node => node.id === "t2")!;
    expect(aiTask.evidenceIds).not.toContain(evidenceId);
    expect(aiTask.evidenceIds.every(id => preview.evidence.some(card => card.id === id && card.sourceType === "ai"))).toBe(true);
    const after = await state(fixture);
    expect(after.plan).toEqual(before.plan);
    expect(after.history).toEqual(before.history);
    expect((after.pending[0]!.roadmapper as RoadmapperWithApplications).evidenceApplications).toEqual(applications);
  });

  it("accepts an explicitly provisional AI route when research returns no usable evidence", async () => {
    const fixture = await setup(0), before = await state(fixture);
    fixture.generate.mockImplementation(async input => {
      const draft = clearCitations(input as RoadmapperInput);
      draft.recommendationReason = "目前没有可用知乎证据，这是需要用户核实的 AI 暂定写作安排。";
      draft.routes[0]!.risks = ["证据不足，任务和工时为尚需核实的 AI 规划"];
      return draft;
    });
    const response = await fixture.post();
    expect(response.status).toBe(202);
    const proposal = await response.json() as BaselineProposal;
    assertBoundedCalls(fixture, 1);
    expect(proposal.roadmapper).toMatchObject({ mode: "model", evidenceStatus: "insufficient", evidenceApplications: [] });
    const after = await state(fixture);
    expect(after.plan).toEqual(before.plan);
    expect(after.history).toEqual(before.history);
    expect(after.pending.map(item => item.id)).toEqual([proposal.id]);
  });
});
