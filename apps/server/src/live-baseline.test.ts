import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResearchReadyPlan, type RoadmapperInput } from "@zhilu/agent-runtime";
import type { CreateProjectInput, EvidenceCard, ResearchQuestionDraft } from "@zhilu/contracts";
import { createZhiluServer } from "./index";
import { PlanRepository } from "./repository";
import type { ZhihuProvider } from "./zhihu-provider";
import { RoadmapperProviderError, type RoadmapperProvider } from "./roadmapper-provider";
import { roadmapperDraftFixture } from "../../../packages/agent-runtime/src/roadmapper.test-fixture";

const input: CreateProjectInput = {
  userContext: { currentSituation: "会 Python，但没有完整 Agent 项目", weeklyHours: 10, constraints: ["只能使用业余时间"], confirmed: true },
  goalContract: {
    goal: "完成一个可展示的 Agent 项目",
    targetDate: "2026-12-20",
    successCriteria: ["公开一个包含基本测试的 Demo"],
    nonGoals: [],
    mustHaveOutcomes: ["可运行项目"],
    tradeoffs: ["先保证可验证"],
    reviewCadence: "weekly",
    confirmed: true,
  },
  adaptiveQuestion: "时间不足时最不能放弃什么？",
  adaptiveAnswer: "必须保留测试和公开 Demo",
};

const questions: ResearchQuestionDraft[] = [
  { question: "怎样尽早用项目验证 Agent 能力？", rationale: "需要可检查成果", searchQueries: ["Agent 项目 验证", "Agent 项目 反馈", "Agent 项目 测试"] },
  { question: "哪些基础能力最容易阻碍完成项目？", rationale: "需要控制风险", searchQueries: ["Agent 基础能力", "Agent 初学者 短板", "Agent 学习路线"] },
];

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-12T08:00:00.000Z")); });
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.useRealTimers(); });

describe("live research Baseline orchestration", () => {
  it("keeps live research pending, then commits the user-selected route", async () => {
    const planForBaseline = vi.fn(async () => ({ status: "ready_for_review" as const, questions, clarificationQuestions: [] }));
    const researchOne = vi.fn(async ({ request }: Parameters<ZhihuProvider["researchOne"]>[0]) => ({
      runId: `run-${request.id}`,
      status: "ok" as const,
      pack: { requestId: request.id, evidence: [evidence(`e-${request.id}`, request.question)], routeCandidates: [], unresolvedQuestions: [] },
      issues: [],
      metrics: { search_calls_attempted: request.searchQueries.length, compiler_calls_attempted: 1, candidate_count: 1, evidence_count: 1 },
    }));
    const fixture = await setup({ planForBaseline, researchOne } as ZhihuProvider);

    const response = await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/research/live/baseline`, { method: "POST" });
    expect(response.status).toBe(202);
    const proposal = await response.json() as { id: string; recommendedRouteId: string; roadmapper: { runId: string; mode: string }; researchRun: { id: string; mode: string; routeCandidates: unknown[]; evidencePacks: unknown[] } };
    expect(proposal.researchRun).toMatchObject({ mode: "live" });
    expect(proposal.researchRun.routeCandidates).toHaveLength(2);
    expect(proposal.researchRun.evidencePacks).toHaveLength(2);
    expect(planForBaseline).toHaveBeenCalledTimes(1);
    expect(researchOne).toHaveBeenCalledTimes(2);
    expect(proposal.roadmapper.mode).toBe("model");
    expect(proposal.roadmapper.runId).not.toBe(proposal.researchRun.id);
    expect((await fixture.repository.getPlan(fixture.projectId)).version).toBe(1);
    expect(await fixture.repository.getHistory(fixture.projectId)).toHaveLength(0);
    expect(await fixture.repository.getBaselineProposals(fixture.projectId)).toHaveLength(1);

    const applied = await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/baseline/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: proposal.id, routeId: proposal.recommendedRouteId }),
    });
    expect(applied.status).toBe(200);
    const workspace = await applied.json() as { plan: { version: number; research: { mode: string }; evidence: EvidenceCard[] }; history: unknown[] };
    expect(workspace.plan).toMatchObject({ version: 2, research: { mode: "live" } });
    expect(workspace.plan.evidence.some((item) => item.sourceType === "zhihu")).toBe(true);
    expect(workspace.history).toHaveLength(1);
  });

  it("does not run searches or create a proposal when the Planner needs clarification", async () => {
    const researchOne = vi.fn();
    const fixture = await setup({
      planForBaseline: vi.fn(async () => ({ status: "needs_clarification" as const, questions: [], clarificationQuestions: ["你希望优先验证什么成果？"] })),
      researchOne,
    } as unknown as ZhihuProvider);
    const response = await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/research/live/baseline`, { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("你希望优先验证什么成果");
    expect(researchOne).not.toHaveBeenCalled();
    expect(await fixture.repository.getBaselineProposals(fixture.projectId)).toHaveLength(0);
  });

  it("keeps the old proposal and official plan intact when model output fails validation", async () => {
    const generate = vi.fn(async (input: Parameters<RoadmapperProvider["generate"]>[0]) => roadmapperDraftFixture(input as RoadmapperInput));
    const fixture = await setup(readyResearch(), { generate });
    const endpoint = `${fixture.origin}/api/projects/${fixture.projectId}/research/live/baseline`;
    expect((await fetch(endpoint, { method: "POST" })).status).toBe(202);
    const previous = await fixture.repository.getBaselineProposals(fixture.projectId);
    generate.mockImplementationOnce(async input => {
      const draft = roadmapperDraftFixture(input as RoadmapperInput);
      draft.routes[0]!.tasks[0]!.evidenceIds = ["fabricated-source"];
      return draft;
    });
    const failed = await fetch(endpoint, { method: "POST" });
    expect(failed.status).toBe(422);
    expect(await failed.json()).toMatchObject({ code: "invalid_roadmap" });
    expect(await fixture.repository.getBaselineProposals(fixture.projectId)).toEqual(previous);
    expect((await fixture.repository.getPlan(fixture.projectId)).version).toBe(1);
    expect(await fixture.repository.getHistory(fixture.projectId)).toHaveLength(0);
    // 错误退出后项目锁释放。
    expect((await fetch(endpoint, { method: "POST" })).status).toBe(202);
  });

  it("reports model failure without falling back to a rules or Mock proposal", async () => {
    const fixture = await setup(readyResearch(), { generate: async () => { throw new RoadmapperProviderError("timeout"); } });
    const response = await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/research/live/baseline`, { method: "POST" });
    expect(response.status).toBe(504);
    expect(await fixture.repository.getBaselineProposals(fixture.projectId)).toHaveLength(0);
    expect((await fixture.repository.getPlan(fixture.projectId)).version).toBe(1);
  });

  it("rejects a draft if the user edits the plan during model generation", async () => {
    const fixture = await setup(readyResearch(), { generate: async input => {
      const plan = await fixture.repository.getPlan(fixture.projectId);
      plan.version += 1;
      plan.nodes[0]!.title = "用户修改保留";
      await fixture.repository.savePlan(plan);
      return roadmapperDraftFixture(input as RoadmapperInput);
    } });
    const response = await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/research/live/baseline`, { method: "POST" });
    expect(response.status).toBe(409);
    expect(await fixture.repository.getBaselineProposals(fixture.projectId)).toHaveLength(0);
    expect((await fixture.repository.getPlan(fixture.projectId)).nodes[0]!.title).toBe("用户修改保留");
  });

  it("does not start research when existing manual edits cannot be preserved by a new baseline", async () => {
    const research = readyResearch();
    const fixture = await setup(research);
    const plan = await fixture.repository.getPlan(fixture.projectId);
    plan.nodes[0]!.manualFields = ["title"];
    await fixture.repository.savePlan(plan);
    const response = await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/research/live/baseline`, { method: "POST" });
    expect(response.status).toBe(422);
    expect(research.planForBaseline).not.toHaveBeenCalled();
    expect(await fixture.repository.getBaselineProposals(fixture.projectId)).toHaveLength(0);
  });

  it.each(["add", "archive"])("protects an earlier user %s even without manualFields", async action => {
    const research = readyResearch();
    const fixture = await setup(research);
    const plan = await fixture.repository.getPlan(fixture.projectId);
    if (action === "add") {
      const node = { ...plan.nodes[1]!, id: "user-task", title: "用户新增内容", manualFields: [] };
      expect((await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/nodes`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(node),
      })).status).toBe(201);
    } else {
      expect((await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/nodes/${plan.nodes[1]!.id}`, { method: "DELETE" })).status).toBe(200);
    }
    const before = await fixture.repository.getPlan(fixture.projectId);
    const response = await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/research/live/baseline`, { method: "POST" });
    expect(response.status).toBe(422);
    expect(research.planForBaseline).not.toHaveBeenCalled();
    expect(await fixture.repository.getPlan(fixture.projectId)).toEqual(before);
  });

  it("rejects unsupported dates before any research or model call", async () => {
    const research = readyResearch(), generate = vi.fn();
    const fixture = await setup(research, { generate });
    const plan = await fixture.repository.getPlan(fixture.projectId);
    plan.goalContract!.targetDate = "2026-09-15";
    await fixture.repository.savePlan(plan);
    const response = await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/research/live/baseline`, { method: "POST" });
    expect(response.status).toBe(422);
    expect(research.planForBaseline).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});

async function setup(provider: ZhihuProvider, roadmapperProvider: RoadmapperProvider = { generate: async input => roadmapperDraftFixture(input as RoadmapperInput) }) {
  const root = await mkdtemp(join(tmpdir(), "zhilu-live-baseline-"));
  const repository = new PlanRepository(root, resolve("examples/agent-engineer/plan-state.json"));
  const plan = createResearchReadyPlan(input, `project-${crypto.randomUUID().slice(0, 8)}`, "2026-09-12T08:00:00.000Z");
  await repository.savePlan(plan);
  const server = createZhiluServer(repository, { liveEnabled: true, zhihuProvider: provider, roadmapperProvider });
  await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", ready); });
  cleanup.push(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  });
  return { repository, projectId: plan.projectId, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function readyResearch() {
  return {
    planForBaseline: vi.fn(async () => ({ status: "ready_for_review" as const, questions, clarificationQuestions: [] })),
    researchOne: vi.fn(async ({ request }: Parameters<ZhihuProvider["researchOne"]>[0]) => ({
      runId: `run-${request.id}`, status: "ok" as const,
      pack: { requestId: request.id, evidence: [evidence(`e-${request.id}`, request.question)], routeCandidates: [], unresolvedQuestions: [] },
      issues: [], metrics: { search_calls_attempted: 1, compiler_calls_attempted: 1, candidate_count: 1, evidence_count: 1 },
    })),
  };
}

function evidence(id: string, title: string): EvidenceCard {
  return {
    id,
    title,
    summary: `${title}，并记录真实反馈。`,
    sourceType: "zhihu",
    contentType: "experience",
    verificationStatus: "unverified",
    sourceTitle: `知乎回答 ${id}`,
    sourceUrl: `https://www.zhihu.com/question/1/answer/${encodeURIComponent(id)}`,
    supportingQuote: "先完成一次实践，再根据结果调整。",
    applicableWhen: ["需要用实践验证路线时"],
    caveats: ["来自单篇知乎经验"],
    riskTags: ["not_independently_verified"],
    adoptionReason: "用于生成真实研究路线草案",
  };
}
