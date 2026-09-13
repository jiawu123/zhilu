import { describe, expect, it, vi } from "vitest";
import type { EvidenceCard, ResearchQuestionDraft, ResearchRequest } from "@zhilu/contracts";
import { confirmedPlan } from "./fixtures/live-plan";
import type { M2Provider } from "./zhihu-provider";
import { ZhihuProviderError } from "./zhihu-provider";
import { ResearchControllerError, runResearchController } from "./research-controller";

const questions: ResearchQuestionDraft[] = [
  { question: "怎样通过项目学习？", searchQueries: ["项目学习路线", "项目学习实践"], rationale: "确认实践路线" },
  { question: "怎样避免项目失败？", searchQueries: ["项目失败经验"], rationale: "确认风险" },
];
function result(request: ResearchRequest, start: number, count: number) {
  const evidence: EvidenceCard[] = Array.from({ length: count }, (_, index) => {
    const id = String(start + index);
    return { id: `e-${id}`, title: `项目建议 ${id}`, summary: `针对项目步骤 ${id} 的不同实践依据`,
      sourceType: "zhihu", sourceUrl: `https://www.zhihu.com/answer/${1000 + start + index}`,
      author: `author-${id}`, contentType: "experience", verificationStatus: "unverified",
      supportingQuote: `项目步骤 ${id} 必须结合反馈检验`, applicableWhen: ["有基础且业余实践"],
      caveats: ["时间不足时缩小项目范围"], riskTags: ["semantic_support_not_checked"], adoptionReason: "用于选择步骤" };
  });
  return { runId: `run-${request.id}`, status: "ok" as const,
    pack: { requestId: request.id, evidence, routeCandidates: [{ id: `route-${request.id}`, title: request.question,
      summary: "先验证小范围成果", applicableWhen: ["有基础"], evidenceIds: evidence.map(card => card.id), risks: ["需人工审阅"] }], unresolvedQuestions: [] },
    metrics: { search_calls_attempted: request.searchQueries.length, cache_hit: 0 }, issues: [] };
}
function provider(): M2Provider {
  return {
    planForBaseline: vi.fn<M2Provider["planForBaseline"]>(async () => ({ status: "ready_for_review", questions, clarificationQuestions: [] })),
    researchOne: vi.fn<M2Provider["researchOne"]>(async ({ request }) => result(request, request.question === questions[0]!.question ? 0 : 3, 3)),
    planSupplemental: vi.fn<M2Provider["planSupplemental"]>(async input => ({ status: "stop", questions: [], stopReason: "no_useful_queries", gaps: input.gaps, plannerCallsAttempted: 1 })),
  };
}
const plan = () => ({ ...confirmedPlan(), weeklyHours: 10 });

describe("research Controller budgets and coverage", () => {
  it.each(["no_evidence", "partial"] as const)("allows %s to reach model planning without supplemental searches", async status => {
    const source = provider(), before = plan(), saved = structuredClone(before);
    source.researchOne = vi.fn<M2Provider["researchOne"]>(async ({ request }) => ({ ...result(request, 0, 0), status,
      pack: { requestId: request.id, evidence: [], routeCandidates: [], unresolvedQuestions: [] },
      issues: status === "partial" ? [{ code: "compiler_invalid_output", stage: "compile" }] : [] }));
    const research = await runResearchController(before, source, { evidencePolicy: "allow_insufficient" });
    expect(research.controller).toMatchObject({ stopReason: "model_planning_with_insufficient_evidence", rounds: 1,
      queriesAttempted: 3, searchCallsAttempted: 3, coverage: { status: "insufficient", evidenceCount: 0, reviewStatus: "needs_human_review" } });
    expect(research.requests).toHaveLength(2);
    expect(research.controller.stages.filter(stage => stage.stage === "research").map(stage => stage.status)).toEqual([status, status]);
    expect(source.planForBaseline).toHaveBeenCalledTimes(1);
    expect(source.planSupplemental).not.toHaveBeenCalled();
    expect(before).toEqual(saved);
  });

  it("keeps an execution error fatal even when evidence insufficiency is allowed", async () => {
    const source = provider();
    source.researchOne = vi.fn(async () => { throw new ZhihuProviderError("invalid_response"); });
    await expect(runResearchController(plan(), source, { evidencePolicy: "allow_insufficient" })).rejects.toMatchObject({ code: "invalid_response" });
    expect(source.researchOne).toHaveBeenCalledTimes(1);
    expect(source.planSupplemental).not.toHaveBeenCalled();
  });

  it("aggregates sufficient evidence without another Planner and leaves the plan untouched", async () => {
    const source = provider(), before = plan(), saved = structuredClone(before);
    const research = await runResearchController(before, source);
    expect(research.controller).toMatchObject({ stopReason: "coverage_sufficient", rounds: 1,
      queryBudget: 6, queriesAttempted: 3, searchCallsAttempted: 3, coverage: { status: "sufficient", evidenceCount: 6, reviewStatus: "needs_human_review" } });
    expect(source.planSupplemental).not.toHaveBeenCalled();
    expect(before).toEqual(saved);
  });

  it("schedules one targeted supplemental round and never repeats executed queries", async () => {
    const source = provider();
    source.researchOne = vi.fn(async ({ request }) => request.question === "需要哪些验收办法？"
      ? result(request, 2, 4) : result(request, request.question === questions[0]!.question ? 0 : 1, 1));
    source.planSupplemental = vi.fn<M2Provider["planSupplemental"]>(async input => ({ status: "ready_for_review", stopReason: null,
      gaps: input.gaps, plannerCallsAttempted: 1, questions: [
        { question: "需要哪些验收办法？", searchQueries: ["项目验收办法"], rationale: "补足证据" },
      ] }));
    const research = await runResearchController(plan(), source);
    expect(research.controller).toMatchObject({ rounds: 2, queriesAttempted: 4, coverage: { status: "sufficient", evidenceCount: 6 } });
    expect(source.planSupplemental).toHaveBeenCalledTimes(1);
    expect(source.planSupplemental).toHaveBeenCalledWith(expect.objectContaining({ remaining_query_budget: 3,
      executed_queries: questions.flatMap(question => question.searchQueries) }), expect.anything());
    expect(source.researchOne).toHaveBeenCalledTimes(3);
  });

  it("does not count cache reuse as another real search", async () => {
    const source = provider();
    source.researchOne = vi.fn(async ({ request }) => ({ ...result(request, request.question === questions[0]!.question ? 0 : 3, 3),
      metrics: { search_calls_attempted: 0, cache_hit: 1 } }));
    expect((await runResearchController(plan(), source)).controller).toMatchObject({ queriesAttempted: 3, searchCallsAttempted: 0, cacheHits: 2 });
  });

  it("repairs an empty original question with a same-question supplemental request", async () => {
    const source = provider();
    let calls = 0;
    source.researchOne = vi.fn<M2Provider["researchOne"]>(async ({ request }) => {
      calls++;
      if (calls === 1) return { ...result(request, 0, 0), status: "no_evidence", pack: {
        requestId: request.id, evidence: [], routeCandidates: [], unresolvedQuestions: [],
      } };
      return result(request, calls === 2 ? 0 : 3, 3);
    });
    source.planSupplemental = vi.fn<M2Provider["planSupplemental"]>(async input => ({ status: "ready_for_review", stopReason: null,
      gaps: input.gaps, plannerCallsAttempted: 1, questions: [
        { ...questions[0]!, searchQueries: ["项目学习案例复盘"] },
      ] }));
    const research = await runResearchController(plan(), source);
    expect(research.controller).toMatchObject({ rounds: 2, queriesAttempted: 4, coverage: { status: "sufficient", evidenceCount: 6 } });
    expect(research.requests[0]!.id).not.toBe(research.requests[2]!.id);
    expect(research.controller.questionCoverage[0]!.evidenceIds).toEqual(research.controller.questionCoverage[2]!.evidenceIds);
    expect(research.controller.questionCoverage.every(question => question.evidenceIds.length > 0)).toBe(true);
  });

  it("rejects repeated supplemental queries before executing them", async () => {
    const source = provider();
    source.researchOne = vi.fn(async ({ request }) => result(request, request.question === questions[0]!.question ? 0 : 1, 1));
    source.planSupplemental = vi.fn<M2Provider["planSupplemental"]>(async input => ({ status: "ready_for_review", stopReason: null, gaps: input.gaps,
      plannerCallsAttempted: 1, questions: [{ question: "重复研究", searchQueries: ["项目 学习 路线？"], rationale: "补充" }] }));
    await expect(runResearchController(plan(), source)).rejects.toMatchObject({ code: "invalid_queries" });
    expect(source.researchOne).toHaveBeenCalledTimes(2);
  });

  it("stops after one round even when the evidence is still insufficient", async () => {
    const source = provider();
    source.researchOne = vi.fn(async ({ request }) => result(request, request.question === questions[0]!.question ? 0 : 1, 1));
    source.planSupplemental = vi.fn<M2Provider["planSupplemental"]>(async input => ({ status: "ready_for_review", stopReason: null, gaps: input.gaps,
      plannerCallsAttempted: 1, questions: [{ question: "补充研究", searchQueries: ["项目反馈办法"], rationale: "补充" }] }));
    await expect(runResearchController(plan(), source)).rejects.toMatchObject({ code: "insufficient_coverage", report: { rounds: 2 } });
    expect(source.planSupplemental).toHaveBeenCalledTimes(1);
    expect(source.researchOne).toHaveBeenCalledTimes(3);
  });

  it("refuses to search when the initial query plan exceeds its global budget", async () => {
    const source = provider();
    source.planForBaseline = vi.fn<M2Provider["planForBaseline"]>(async () => ({ status: "ready_for_review", questions: questions.map(q => ({ ...q, searchQueries: [...q.searchQueries, "额外搜索"] })), clarificationQuestions: [] }));
    await expect(runResearchController(plan(), source)).rejects.toMatchObject({ code: "invalid_queries" });
    expect(source.researchOne).not.toHaveBeenCalled();
  });

  it("stops on partial research rather than silently producing a plan", async () => {
    const source = provider();
    source.researchOne = vi.fn<M2Provider["researchOne"]>(async ({ request }) => ({ ...result(request, 0, 6), status: "partial",
      issues: [{ code: "search_timeout", stage: "search" }] }));
    await expect(runResearchController(plan(), source)).rejects.toMatchObject({ code: "partial_research" });
    expect(source.researchOne).toHaveBeenCalledTimes(1);
    expect(source.planSupplemental).not.toHaveBeenCalled();
  });

  it("reports accepted partial evidence and unexecuted questions without claiming complete coverage", async () => {
    const source = provider(), before = plan(), saved = structuredClone(before);
    source.researchOne = vi.fn<M2Provider["researchOne"]>(async ({ request }) => ({ ...result(request, 0, 6), status: "partial",
      issues: [{ code: "compiler_invalid_output", stage: "compile" }] }));
    const failure = await runResearchController(before, source).catch(error => error) as ResearchControllerError;
    expect(failure).toBeInstanceOf(ResearchControllerError);
    expect(failure).toMatchObject({ code: "partial_research", status: 502, report: {
      coverage: { status: "insufficient", evidenceCount: 6, reviewStatus: "needs_human_review" },
      stopReason: "partial_research", rounds: 1, queriesAttempted: 2, searchCallsAttempted: 2,
    } });
    expect(failure.message).toContain("编译");
    expect(failure.message).toContain("6");
    expect(failure.report.coverage.gaps.some(gap => gap.reason.includes("尚未取得研究证据"))).toBe(false);
    expect(failure.report.coverage.gaps.some(gap => gap.reason.includes("未执行"))).toBe(true);
    expect(failure.report.questionCoverage.map(question => question.evidenceIds.length)).toEqual([6, 0]);
    expect(failure.completedResearch?.evidencePacks[0]?.evidence).toEqual(result(failure.completedResearch!.requests[0]!, 0, 6).pack.evidence);
    expect(source.researchOne).toHaveBeenCalledTimes(1);
    expect(source.planSupplemental).not.toHaveBeenCalled();
    expect(before).toEqual(saved);
  });

  it("retains earlier accepted evidence when a later request fails", async () => {
    const source = provider();
    source.researchOne = vi.fn<M2Provider["researchOne"]>(async ({ request }) => {
      if (request.question === questions[0]!.question) return result(request, 0, 3);
      const failure = new ZhihuProviderError("process_failed");
      failure.upstreamCode = "rate_or_quota_limit";
      failure.metrics = { search_calls_attempted: 1 };
      throw failure;
    });
    const failure = await runResearchController(plan(), source).catch(error => error) as ResearchControllerError;
    expect(failure).toMatchObject({ code: "process_failed", report: {
      coverage: { evidenceCount: 3, status: "insufficient" }, searchCallsAttempted: 3, stopReason: "rate_or_quota_limit",
    } });
    expect(failure.report.questionCoverage.map(question => question.evidenceIds.length)).toEqual([3, 0]);
    expect(failure.completedResearch?.requests).toHaveLength(1);
    expect(failure.completedResearch?.evidencePacks[0]?.evidence).toHaveLength(3);
    expect(source.planSupplemental).not.toHaveBeenCalled();
  });

  it("reports zero usable partial cards accurately without exposing upstream issue text", async () => {
    const source = provider();
    source.researchOne = vi.fn<M2Provider["researchOne"]>(async ({ request }) => ({ ...result(request, 0, 0), status: "partial",
      pack: { requestId: request.id, evidence: [], routeCandidates: [], unresolvedQuestions: [] },
      issues: [{ code: "compiler_invalid_output", stage: "compile", detail: "private-canary" } as never] }));
    const failure = await runResearchController(plan(), source).catch(error => error) as ResearchControllerError;
    expect(failure.report.coverage.evidenceCount).toBe(0);
    expect(failure.message).toContain("编译");
    expect(failure.message).toContain("0");
    expect(JSON.stringify({ message: failure.message, report: failure.report })).not.toContain("private-canary");
    expect(source.researchOne).toHaveBeenCalledTimes(1);
  });

  it("records failed query attempts and does not retry quota failures", async () => {
    const source = provider();
    const failure = new ZhihuProviderError("process_failed");
    failure.upstreamCode = "rate_or_quota_limit";
    failure.metrics = { search_calls_attempted: 1 };
    source.researchOne = vi.fn(async () => { throw failure; });
    await expect(runResearchController(plan(), source)).rejects.toMatchObject({ code: "process_failed", status: 502,
      message: expect.stringContaining("知乎搜索触发限流或额度不足"),
      report: { queriesAttempted: 2, searchCallsAttempted: 1, stopReason: "rate_or_quota_limit" } });
    expect(source.researchOne).toHaveBeenCalledTimes(1);
    expect(source.planSupplemental).not.toHaveBeenCalled();
  });

  it("aborts an in-flight provider when the total research deadline expires", async () => {
    const source = provider();
    let signal: AbortSignal | undefined;
    source.planForBaseline = vi.fn<M2Provider["planForBaseline"]>(async (_input, options) => {
      signal = options?.signal;
      return new Promise<never>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new ZhihuProviderError("timeout")), { once: true }));
    });
    await expect(runResearchController(plan(), source, { timeoutMs: 10 })).rejects.toMatchObject({ code: "timeout", status: 504 });
    expect(signal?.aborted).toBe(true);
    expect(source.researchOne).not.toHaveBeenCalled();
  });
});
