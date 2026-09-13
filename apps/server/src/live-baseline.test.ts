import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResearchReadyPlan, type RoadmapperInput } from "@zhilu/agent-runtime";
import type { CreateProjectInput, EvidenceCard, ResearchQuestionDraft, ResearchRequest } from "@zhilu/contracts";
import { createZhiluServer } from "./index";
import { PlanRepository } from "./repository";
import { executeM3Replay } from "./m3-replay";
import { ZhihuProviderError, type M2Provider, type ZhihuProvider } from "./zhihu-provider";
import type { ResearchProviderResult } from "./zhihu-boundary";
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
  { question: "怎样尽早用项目验证 Agent 能力？", rationale: "需要可检查成果", searchQueries: ["Agent 项目 验证", "Agent 项目 反馈"] },
  { question: "哪些基础能力最容易阻碍完成项目？", rationale: "需要控制风险", searchQueries: ["Agent 初学者 短板"] },
];

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-12T08:00:00.000Z")); });
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.useRealTimers(); });

describe("live research Baseline orchestration", () => {
  it("keeps live research pending, then commits the user-selected route", async () => {
    const { planForBaseline, researchOne } = readyResearch();
    const fixture = await setup({ planForBaseline, researchOne } as ZhihuProvider);

    const response = await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/research/live/baseline`, { method: "POST" });
    expect(response.status).toBe(202);
    const proposal = await response.json() as { id: string; recommendedRouteId: string; roadmapper: { runId: string; mode: string }; researchRun: { id: string; mode: string; routeCandidates: unknown[]; evidencePacks: unknown[]; controller: { questionCoverage: Array<{ requestId: string; evidenceIds: string[] }> } } };
    expect(proposal.researchRun).toMatchObject({ mode: "live", controller: {
      coverage: { status: "sufficient", evidenceCount: 6, targetMin: 6, targetMax: 8, hasCaveat: true, gaps: [], reviewStatus: "needs_human_review" },
      rounds: 1, queryBudget: 6, queriesAttempted: 3, searchCallsAttempted: 3, cacheHits: 0, stopReason: "coverage_sufficient",
    } });
    expect(proposal.researchRun.controller.questionCoverage).toHaveLength(2);
    expect(proposal.researchRun.controller.questionCoverage.every(question => question.evidenceIds.length === 3)).toBe(true);
    expect(proposal.researchRun.routeCandidates).toHaveLength(2);
    expect(proposal.researchRun.evidencePacks).toHaveLength(2);
    expect(planForBaseline).toHaveBeenCalledTimes(1);
    expect(researchOne).toHaveBeenCalledTimes(2);
    expect(researchOne.mock.calls.reduce((sum, [call]) => sum + call.request.searchQueries.length, 0)).toBe(3);
    expect(researchOne.mock.calls.every(([call]) => call.request.evidenceLimit === 8)).toBe(true);
    expect(proposal.roadmapper.mode).toBe("model");
    expect(proposal.roadmapper.runId).not.toBe(proposal.researchRun.id);
    expect((await fixture.repository.getPlan(fixture.projectId)).version).toBe(1);
    expect(await fixture.repository.getHistory(fixture.projectId)).toHaveLength(0);
    expect(await fixture.repository.getBaselineProposals(fixture.projectId)).toHaveLength(1);
    expect(await readdir(join(fixture.root, fixture.projectId, ".plan", "research-snapshots"))).toEqual([`${proposal.researchRun.id}.json`]);

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

  it("continues with a model draft when an older provider returns insufficient evidence", async () => {
    const research = readyResearch(1);
    const generate = vi.fn(async (input: Parameters<RoadmapperProvider["generate"]>[0]) => roadmapperDraftFixture(input as RoadmapperInput));
    const fixture = await setup(research, { generate });
    const before = await fixture.repository.getPlan(fixture.projectId);
    const response = await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/research/live/baseline`, { method: "POST" });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ roadmapper: { mode: "model", evidenceStatus: "insufficient" }, researchRun: { controller: {
      coverage: { status: "insufficient", evidenceCount: 2 }, rounds: 1, queriesAttempted: 3,
    } } });
    expect(research.researchOne).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await fixture.repository.getBaselineProposals(fixture.projectId)).toHaveLength(1);
    expect(await fixture.repository.getPlan(fixture.projectId)).toEqual(before);
    expect(await fixture.repository.getHistory(fixture.projectId)).toHaveLength(0);
  });

  it("reports cached evidence without counting planned queries as actual search calls", async () => {
    const research = readyResearch();
    research.researchOne.mockImplementation(async ({ request }) => ({
      ...researchResult(request), metrics: {
        search_calls_attempted: 0, compiler_calls_attempted: 0, candidate_count: 3, evidence_count: 3, cache_hit: 1,
      },
    }));
    const fixture = await setup(research);
    const response = await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/research/live/baseline`, { method: "POST" });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ researchRun: { controller: {
      coverage: { status: "sufficient" }, queriesAttempted: 3, searchCallsAttempted: 0, cacheHits: 2,
      rounds: 1, stopReason: "coverage_sufficient",
    } } });
    expect((await fixture.repository.getPlan(fixture.projectId)).version).toBe(1);
    expect(await fixture.repository.getHistory(fixture.projectId)).toHaveLength(0);
  });

  it.each(["no_evidence", "partial"] as const)("plans with zero usable cards after %s and retains tagged posts through apply", async status => {
    const research = readyResearch(), planSupplemental = vi.fn();
    const post = { source: { id: "zhihu:Answer:123", provider: "zhihu" as const, title: "仅供参考的经验帖", author: "原作者",
      url: "https://www.zhihu.com/answer/123", snippet: "原始片段。\r\n旅行 🚆 经验缺少活动特定信息。", retrievedAt: "2026-09-12T08:00:00Z", source_scope: "search_snippet" as const },
      reasonCode: "compiler_rejected" as const, riskTags: ["证据不足", "search_snippet_only", "not_independently_verified", "semantic_support_not_checked"] };
    research.researchOne.mockImplementation(async ({ request }) => ({ ...researchResult(request), status,
      pack: { requestId: request.id, evidence: [], routeCandidates: [], unresolvedQuestions: ["尚无活动官方时间依据"], insufficientSources: [post] },
      issues: status === "partial" ? [{ code: "compiler_invalid_output", stage: "compile" }] : [] }));
    const generate = vi.fn(async (input: Parameters<RoadmapperProvider["generate"]>[0]) => roadmapperDraftFixture(input as RoadmapperInput));
    const fixture = await setup({ ...research, planSupplemental }, { generate });
    const before = await fixture.repository.getPlan(fixture.projectId);
    const response = await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/research/live/baseline`, { method: "POST" });
    expect(response.status).toBe(202);
    const proposal = await response.json();
    expect(proposal.roadmapper).toMatchObject({ mode: "model", evidenceStatus: "insufficient" });
    expect(proposal.researchRun.controller).toMatchObject({ coverage: { status: "insufficient", evidenceCount: 0 },
      stopReason: "model_planning_with_insufficient_evidence", rounds: 1, queriesAttempted: 3 });
    expect(proposal.researchRun.evidencePacks[0].insufficientSources).toEqual([post]);
    expect(proposal.researchRun.routeCandidates).toHaveLength(1);
    expect(proposal.researchRun.evidencePacks.every((pack: { evidence: unknown[] }) => !pack.evidence.length)).toBe(true);
    expect(research.researchOne).toHaveBeenCalledTimes(2);
    expect(planSupplemental).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(generate.mock.calls[0]![0])).not.toContain(post.source.snippet);
    expect(JSON.stringify(generate.mock.calls[0]![0])).not.toContain(post.source.url);
    expect(await fixture.repository.getPlan(fixture.projectId)).toEqual(before);
    expect(await fixture.repository.getHistory(fixture.projectId)).toHaveLength(0);
    const applied = await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/baseline/apply`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ proposalId: proposal.id, routeId: proposal.recommendedRouteId }) });
    expect(applied.status).toBe(200);
    const workspace = await applied.json();
    expect(workspace.plan.research.insufficientSources).toEqual([post]);
    expect(workspace.plan.evidence.some((card: EvidenceCard) => card.sourceType === "ai" && card.riskTags.includes("证据不足"))).toBe(true);
    expect(workspace.history).toHaveLength(1);
  });

  it("preserves previous proposals and partial evidence when a later research request fails", async () => {
    const research = readyResearch(), generate = vi.fn(), planSupplemental = vi.fn();
    research.researchOne.mockImplementationOnce(async ({ request }) => ({
      ...researchResult(request), status: "partial", issues: [{ code: "compiler_invalid_output", stage: "compile" }],
    }));
    research.researchOne.mockRejectedValueOnce(new ZhihuProviderError("process_failed"));
    const fixture = await setup({ ...research, planSupplemental }, { generate });
    expect((await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/research/mock`, { method: "POST" })).status).toBe(202);
    const before = await fixture.repository.getPlan(fixture.projectId);
    const previousProposals = await fixture.repository.getBaselineProposals(fixture.projectId);
    const previousPending = await fixture.repository.getPending(fixture.projectId);
    const previousHistory = await fixture.repository.getHistory(fixture.projectId);
    expect(previousProposals).toHaveLength(1);

    const response = await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/research/live/baseline`, { method: "POST" });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({ code: "process_failed", controller: {
      coverage: { status: "insufficient", evidenceCount: 3, reviewStatus: "needs_human_review" },
      rounds: 1, queriesAttempted: 3, searchCallsAttempted: 2, stopReason: "process_failed",
      stages: [
        { stage: "plan", status: "ready_for_review" },
        { stage: "research", status: "partial", requestId: research.researchOne.mock.calls[0]![0].request.id },
        { stage: "research", status: "failed", requestId: research.researchOne.mock.calls[1]![0].request.id },
      ],
    } });
    expect(body.controller.questionCoverage).toHaveLength(2);
    expect(body.controller.questionCoverage.map((question: { evidenceIds: string[] }) => question.evidenceIds.length)).toEqual([3, 0]);
    expect(JSON.stringify(body)).not.toContain("尚未取得研究证据");
    expect(JSON.stringify(body)).not.toContain("supportingQuote");
    expect(research.researchOne).toHaveBeenCalledTimes(2);
    expect(planSupplemental).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(await fixture.repository.getPlan(fixture.projectId)).toEqual(before);
    expect(await fixture.repository.getHistory(fixture.projectId)).toEqual(previousHistory);
    expect(await fixture.repository.getBaselineProposals(fixture.projectId)).toEqual(previousProposals);
    expect(await fixture.repository.getPending(fixture.projectId)).toEqual(previousPending);
  });

  it("privately preserves a partial pack without exposing quotes or producing an M3 snapshot", async () => {
    const research = readyResearch(), generate = vi.fn(), planSupplemental = vi.fn();
    let returned: ResearchProviderResult | undefined;
    research.researchOne.mockImplementationOnce(async ({ request }) => {
      const result: ResearchProviderResult = { ...researchResult(request), status: "partial", issues: [{ code: "compiler_invalid_output", stage: "compile" }] };
      result.pack.evidence[0]!.supportingQuote = "独立原文标记：先实践。\r\n旅行 🚆 后记录真实反馈。";
      returned = result;
      return result;
    });
    research.researchOne.mockRejectedValueOnce(new ZhihuProviderError("process_failed"));
    const fixture = await setup({ ...research, planSupplemental }, { generate });
    const before = await fixture.repository.getPlan(fixture.projectId);
    const response = await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/research/live/baseline`, { method: "POST" });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("supportingQuote");
    expect(JSON.stringify(body)).not.toContain("独立原文标记");

    const directory = join(fixture.root, fixture.projectId, ".plan", "research-partials");
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    const artifactPath = join(directory, files[0]!);
    const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
    expect(artifact).toMatchObject({ artifactKind: "partial-research", completedResearch: {
      requests: [research.researchOne.mock.calls[0]![0].request], evidencePacks: [returned!.pack],
    } });
    expect(artifact.completedResearch.evidencePacks[0]).toEqual(returned!.pack);
    if (process.platform !== "win32") expect((await stat(artifactPath)).mode & 0o777).toBe(0o600);
    const diagnostic = JSON.parse(await readFile(join(fixture.root, fixture.projectId, ".plan", "research-failure.json"), "utf8"));
    expect(diagnostic).toMatchObject({ code: "process_failed", partialArtifactId: files[0]!.slice(0, -5), controller: {
      coverage: { evidenceCount: 3 }, stopReason: "process_failed",
    } });
    expect(JSON.stringify(diagnostic)).not.toContain("supportingQuote");
    await expect(readdir(join(fixture.root, fixture.projectId, ".plan", "research-snapshots"))).rejects.toMatchObject({ code: "ENOENT" });
    const replay = await executeM3Replay(artifact, { live: false });
    expect(replay.report).toMatchObject({ status: "failed", calls: { zhihu: 0, roadmapper: 0, offlineFixture: 0 } });
    expect(research.researchOne).toHaveBeenCalledTimes(2);
    expect(planSupplemental).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(await fixture.repository.getPlan(fixture.projectId)).toEqual(before);
    expect(await fixture.repository.getBaselineProposals(fixture.projectId)).toHaveLength(0);
    expect(await fixture.repository.getHistory(fixture.projectId)).toHaveLength(0);
  });

  it("stops after an upstream failure without retrying, supplementing, or changing the plan", async () => {
    const research = readyResearch(), generate = vi.fn(), planSupplemental = vi.fn();
    const failure = new ZhihuProviderError("process_failed");
    failure.upstreamCode = "rate_or_quota_limit";
    research.researchOne.mockRejectedValueOnce(failure);
    const fixture = await setup({ ...research, planSupplemental }, { generate });
    const before = await fixture.repository.getPlan(fixture.projectId);
    const response = await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/research/live/baseline`, { method: "POST" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("限流或额度不足") });
    const diagnostic = JSON.parse(await readFile(join(fixture.root, fixture.projectId, ".plan", "research-failure.json"), "utf8"));
    expect(diagnostic).toMatchObject({ code: "process_failed", controller: { stopReason: "rate_or_quota_limit" } });
    expect(research.researchOne).toHaveBeenCalledTimes(1);
    expect(planSupplemental).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(await fixture.repository.getBaselineProposals(fixture.projectId)).toHaveLength(0);
    expect(await fixture.repository.getPlan(fixture.projectId)).toEqual(before);
    expect(await fixture.repository.getHistory(fixture.projectId)).toHaveLength(0);
  });

  it("saves separate immutable partial artifacts for repeated failures", async () => {
    const fixture = await setup(readyResearch());
    const failure = partialFailure();
    const directory = join(fixture.root, fixture.projectId, ".plan");
    await fixture.repository.saveResearchFailure(fixture.projectId, failure);
    const firstDiagnostic = JSON.parse(await readFile(join(directory, "research-failure.json"), "utf8"));
    const firstPath = join(directory, "research-partials", `${firstDiagnostic.partialArtifactId}.json`);
    const firstBody = await readFile(firstPath, "utf8");

    failure.completedResearch.evidencePacks[0]!.evidence[0]!.supportingQuote = "第二次检索的独立引文，不覆盖第一次记录。";
    await fixture.repository.saveResearchFailure(fixture.projectId, failure);
    const secondDiagnostic = JSON.parse(await readFile(join(directory, "research-failure.json"), "utf8"));
    expect(secondDiagnostic.partialArtifactId).not.toBe(firstDiagnostic.partialArtifactId);
    expect(await readdir(join(directory, "research-partials"))).toHaveLength(2);
    expect(await readFile(firstPath, "utf8")).toBe(firstBody);
    const secondBody = JSON.parse(await readFile(join(directory, "research-partials", `${secondDiagnostic.partialArtifactId}.json`), "utf8"));
    expect(secondBody.completedResearch).toEqual(failure.completedResearch);
  });

  it("rejects partial artifacts larger than 2 MiB before writing any diagnostic", async () => {
    const fixture = await setup(readyResearch());
    const directory = join(fixture.root, fixture.projectId, ".plan");
    const before = await readdir(directory);
    const failure = partialFailure();
    failure.completedResearch.evidencePacks[0]!.evidence[0]!.supportingQuote = "x".repeat(2 * 1024 * 1024);
    await expect(fixture.repository.saveResearchFailure(fixture.projectId, failure)).rejects.toThrow("size limit");
    expect(await readdir(directory)).toEqual(before);
  });

  it("rejects project path traversal before saving private research diagnostics", async () => {
    const fixture = await setup(readyResearch());
    const before = await readdir(fixture.root);
    await expect(fixture.repository.saveResearchFailure("../outside", partialFailure())).rejects.toThrow("identifier");
    expect(await readdir(fixture.root)).toEqual(before);
    expect(await readdir(join(fixture.root, fixture.projectId, ".plan"))).toEqual(["plan.json"]);
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

  it("keeps replayable research after model failure without a rules or Mock proposal", async () => {
    const snapshotsAtModel: string[] = [];
    const fixture = await setup(readyResearch(), { generate: async () => {
      snapshotsAtModel.push(...await readdir(join(fixture.root, fixture.projectId, ".plan", "research-snapshots")));
      throw new RoadmapperProviderError("timeout");
    } });
    const before = await fixture.repository.getPlan(fixture.projectId);
    const response = await fetch(`${fixture.origin}/api/projects/${fixture.projectId}/research/live/baseline`, { method: "POST" });
    expect(response.status).toBe(504);
    expect(await fixture.repository.getBaselineProposals(fixture.projectId)).toHaveLength(0);
    expect(await fixture.repository.getPlan(fixture.projectId)).toEqual(before);
    expect(await fixture.repository.getHistory(fixture.projectId)).toHaveLength(0);
    const directory = join(fixture.root, fixture.projectId, ".plan", "research-snapshots");
    const snapshots = await readdir(directory);
    expect(snapshots).toHaveLength(1);
    expect(snapshotsAtModel).toEqual(snapshots);
    const path = join(directory, snapshots[0]!);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    const snapshot = JSON.parse(await readFile(path, "utf8"));
    expect(snapshot.plan).toEqual(before);
    expect(snapshot.research).toMatchObject({ questions, controller: {
      coverage: { status: "sufficient", evidenceCount: 6 }, stopReason: "coverage_sufficient",
    } });
    expect(snapshots[0]).toBe(`${snapshot.research.runId}.json`);
    expect(snapshot.research.requests).toHaveLength(2);
    expect(snapshot.research.evidencePacks).toHaveLength(2);
    expect(snapshot.research.evidencePacks.flatMap((pack: { evidence: EvidenceCard[] }) => pack.evidence)).toHaveLength(6);
    // Exercise the actual HTTP-saved shape, not only the standalone synthetic fixture.
    const replay = await executeM3Replay(snapshot, { live: false });
    expect(replay.report).toMatchObject({ status: "structural_pass", evidenceCount: 6, routeCount: 2,
      calls: { zhihu: 0, roadmapper: 0, offlineFixture: 1 }, formalPlanWritten: false, historyWritten: false });
    expect(await fixture.repository.getBaselineProposals(fixture.projectId)).toHaveLength(0);
    expect(await fixture.repository.getPlan(fixture.projectId)).toEqual(before);
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

async function setup(provider: ZhihuProvider & Partial<Pick<M2Provider, "planSupplemental">>, roadmapperProvider: RoadmapperProvider = { generate: async input => roadmapperDraftFixture(input as RoadmapperInput) }) {
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
  return { root, repository, projectId: plan.projectId, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function readyResearch(evidenceCount = 3) {
  return {
    planForBaseline: vi.fn(async () => ({ status: "ready_for_review" as const, questions, clarificationQuestions: [] })),
    researchOne: vi.fn(async ({ request }: Parameters<ZhihuProvider["researchOne"]>[0]) => researchResult(request, evidenceCount)),
  };
}

function partialFailure() {
  const request: ResearchRequest = { id: "rq-partial-diagnostic", question: questions[0]!.question,
    searchQueries: questions[0]!.searchQueries, relevantUserConditions: [], evidenceLimit: 8 };
  const pack = researchResult(request).pack;
  return {
    occurredAt: "2026-09-12T08:00:00.000Z", code: "partial_research", message: "证据编译部分失败，已保留 3 张有效证据。",
    controller: {
      coverage: { status: "insufficient", evidenceCount: 3, targetMin: 6, targetMax: 8, hasCaveat: true,
        gaps: [{ kind: "evidence_count", reason: "证据数量未达要求" }], reviewStatus: "needs_human_review" },
      questionCoverage: [{ requestId: request.id, evidenceIds: pack.evidence.map(card => card.id) }],
      rounds: 1, queryBudget: 6, queriesAttempted: 2, searchCallsAttempted: 2, cacheHits: 0,
      stages: [{ stage: "research", requestId: request.id, status: "partial", durationMs: 1 }], stopReason: "partial_research",
    },
    completedResearch: { requests: [request], evidencePacks: [pack] },
  } satisfies Parameters<PlanRepository["saveResearchFailure"]>[1];
}

function researchResult(request: ResearchRequest, evidenceCount = 3): ResearchProviderResult {
  const cards = Array.from({ length: evidenceCount }, (_, index) => evidence(`e-${request.id}-${index + 1}`, `${request.question}：实践建议 ${index + 1}`));
  return {
    runId: `run-${request.id}`, status: "ok",
    pack: {
      requestId: request.id, evidence: cards,
      routeCandidates: [{ id: `route-${request.id}`, title: "先做最小项目验证", summary: "根据实际反馈逐步扩展项目范围。", applicableWhen: ["会 Python 且只能使用业余时间"], evidenceIds: cards.map(card => card.id), risks: ["复杂集成可能超过每周 10 小时预算"] }],
      unresolvedQuestions: [],
    },
    issues: [], metrics: { search_calls_attempted: request.searchQueries.length, compiler_calls_attempted: 1, candidate_count: evidenceCount, evidence_count: evidenceCount },
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
    author: `作者-${id}`,
    supportingQuote: `${title}，先完成一次实践，再根据结果调整。`,
    applicableWhen: ["会 Python、只能使用业余时间，每周可投入 10 小时"],
    caveats: ["外部集成调试可能超过业余时间预算，应先验证最小可运行范围"],
    riskTags: ["search_snippet_only", "not_independently_verified", "semantic_support_not_checked"],
    adoptionReason: "用于生成真实研究路线草案",
  };
}
