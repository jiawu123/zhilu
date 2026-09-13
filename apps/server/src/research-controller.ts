import { randomUUID } from "node:crypto";
import { aggregateResearchEvidence, assembleResearchRequests, ResearchEvidenceError, ResearchRequestValidationError,
  type LiveResearchInput, type ResearchQueryPolicy } from "@zhilu/agent-runtime";
import type { EvidencePack, PlanState, ResearchControllerReport, ResearchQuestionDraft, ResearchRequest } from "@zhilu/contracts";
import { buildM2Context } from "./m2-context";
import { BoundaryError, validateResearchInput, validateSupplementalInput } from "./zhihu-boundary";
import { ZhihuProviderError, type M2Provider, type ZhihuProvider } from "./zhihu-provider";

/** Accepted request outputs for private diagnostics, never an approved roadmap input. */
export interface CompletedResearchEvidence { requests: ResearchRequest[]; evidencePacks: EvidencePack[] }

export class ResearchControllerError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly report: ResearchControllerReport,
    readonly cleanupError?: "cleanup_failed", readonly completedResearch?: CompletedResearchEvidence) {
    super(message); this.name = "ResearchControllerError";
  }
}

/** Bounded orchestration only: no model configuration, Plan writes, or automatic approvals. */
export async function runResearchController(plan: PlanState, provider: ZhihuProvider & Partial<Pick<M2Provider, "planSupplemental">>,
  options: { timeoutMs?: number; evidencePolicy?: "strict" | "allow_insufficient" } = {}): Promise<LiveResearchInput & { controller: ResearchControllerReport }> {
  const timeoutMs = options.timeoutMs ?? 630000;
  const allowInsufficient = options.evidencePolicy === "allow_insufficient";
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 630000) throw new Error("Invalid Controller deadline.");
  const context = buildM2Context(plan);
  const report: ResearchControllerReport = { coverage: { status: "insufficient", evidenceCount: 0, targetMin: 6, targetMax: 8,
    hasCaveat: false, gaps: [{ kind: "evidence_count", reason: "尚未取得研究证据" }], reviewStatus: "needs_human_review" },
    questionCoverage: [], rounds: 0, queryBudget: 6, queriesAttempted: 0, searchCallsAttempted: 0, cacheHits: 0, stages: [], stopReason: "pending" };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const callOptions = { signal: abort.signal };
  const requests: ResearchRequest[] = [], packs: EvidencePack[] = [], questions: ResearchQuestionDraft[] = [], executed: string[] = [];
  const scheduled: ResearchRequest[] = [];
  function completedResearch(): CompletedResearchEvidence | undefined {
    return requests.length ? structuredClone({ requests, evidencePacks: packs }) : undefined;
  }
  function updateCoverage(aggregated: ReturnType<typeof aggregateResearchEvidence>) {
    report.coverage = structuredClone(aggregated.coverage);
    report.questionCoverage = structuredClone(aggregated.questionCoverage);
    const completed = new Set(requests.map(request => request.id));
    const unfinished = scheduled.filter(request => !completed.has(request.id));
    report.questionCoverage.push(...unfinished.map(request => ({ requestId: request.id, evidenceIds: [] })));
    if (unfinished.length) {
      report.coverage.status = "insufficient";
      report.coverage.gaps.push({ kind: "route", reason: `还有 ${unfinished.length} 个研究问题未完成，后续请求未执行或未返回有效结果。` });
    }
  }
  function fail(code: string, message: string, status = 422): never {
    report.stopReason = code;
    throw new ResearchControllerError(code, message, status, structuredClone(report), undefined, completedResearch());
  }
  function checkDeadline() { if (abort.signal.aborted) throw new ZhihuProviderError("timeout"); }
  async function stage<T extends { status: string }>(name: "plan" | "research" | "supplement", operation: () => Promise<T>, requestId?: string): Promise<T> {
    checkDeadline();
    const entry: ResearchControllerReport["stages"][number] = { stage: name, ...(requestId ? { requestId } : {}), durationMs: 0, status: "failed" };
    report.stages.push(entry);
    const started = performance.now();
    try { const value = await operation(); checkDeadline(); entry.status = value.status; return value; }
    finally { entry.durationMs = Math.round(performance.now() - started); }
  }
  async function researchRound(drafts: ResearchQuestionDraft[], policy: ResearchQueryPolicy) {
    const batch = assembleResearchRequests({ questions: drafts, queryPolicy: policy,
      relevantUserConditions: [plan.userContext!.currentSituation, `每周可投入 ${plan.weeklyHours} 小时`, ...plan.userContext!.constraints],
      evidenceLimitPerQuestion: 8, idFactory: () => `rq-live-${randomUUID()}` });
    // Validate the whole batch before starting any request, including cross-round duplicates.
    const next = batch.flatMap(request => request.searchQueries), seen = new Set(executed.map(normalizeQuery));
    if (report.queriesAttempted + next.length > report.queryBudget) fail("query_budget_exhausted", "研究查询预算已耗尽。");
    for (const query of next) {
      const key = normalizeQuery(query);
      if (seen.has(key)) fail("invalid_queries", "补检索包含已执行或重复的 Query，已停止。");
      seen.add(key);
    }
    batch.forEach(request => validateResearchInput({ ...context, request }));
    scheduled.push(...batch);
    if (requests.length) updateCoverage(aggregateResearchEvidence(requests, packs));
    report.rounds++;
    for (const [index, request] of batch.entries()) {
      checkDeadline();
      report.queriesAttempted += request.searchQueries.length;
      executed.push(...request.searchQueries);
      const result = await stage("research", () => provider.researchOne({ ...context, request }, callOptions), request.id);
      const searchCount = result.metrics.search_calls_attempted ?? 0;
      if (!Number.isSafeInteger(searchCount) || searchCount < 0 || searchCount > request.searchQueries.length) {
        fail("invalid_response", "研究调用计数不符合请求预算。", 502);
      }
      report.searchCallsAttempted += searchCount;
      report.cacheHits += result.metrics.cache_hit === 1 ? 1 : 0;
      // Validate and measure each completed output before a partial/future request can stop the round.
      const aggregated = aggregateResearchEvidence([...requests, request], [...packs, result.pack]);
      requests.push(request); questions.push(drafts[index]!); packs.push(result.pack);
      updateCoverage(aggregated);
      if (result.status === "partial" && !allowInsufficient) {
        const stages = ([['search', '知乎检索'], ['normalize', '内容规范化'], ['rank', '证据排序'],
          ['compile', '证据编译'], ['coverage', '覆盖检查']] as const)
          .filter(([stage]) => result.issues.some(issue => issue.stage === stage))
          .map(([stage, label]) => `${label}（${result.issues.filter(issue => issue.stage === stage).length}项）`);
        fail("partial_research", `${stages.join("、") || "研究处理"}部分未通过；已取得 ${report.coverage.evidenceCount} 张可用证据，研究尚未完成，已停止后续调用。`, 502);
      }
    }
    const aggregated = aggregateResearchEvidence(requests, packs);
    updateCoverage(aggregated);
    return aggregated;
  }
  try {
    const planning = await stage("plan", () => provider.planForBaseline(context, callOptions));
    if (planning.status === "needs_clarification") fail("needs_clarification", `研究前还需要确认：${planning.clarificationQuestions.join("；")}`, 409);
    let aggregated = await researchRound(planning.questions, "initial");
    if (aggregated.coverage.status === "insufficient" && !allowInsufficient) {
      if (!provider.planSupplemental) fail("insufficient_coverage", "证据覆盖不足，当前研究接口未提供补检索能力；未生成计划。");
      const supplementInput = validateSupplementalInput({ ...context,
        gaps: aggregated.coverage.gaps.slice(0, 12).map(gap => ({ ...gap, reason: [...gap.reason].slice(0, 600).join("") })),
        executed_queries: executed, remaining_query_budget: report.queryBudget - report.queriesAttempted });
      const supplemental = await stage("supplement", () => provider.planSupplemental!(supplementInput, callOptions));
      if (supplemental.status === "stop") fail("insufficient_coverage", "证据覆盖不足，未找到有用的补充查询；请澄清目标或调整研究范围。");
      aggregated = await researchRound(supplemental.questions, "supplemental");
    }
    if (aggregated.coverage.status !== "sufficient" && !allowInsufficient) fail("insufficient_coverage", "一轮补检索后仍有证据缺口，未生成正式路线。请查看缺口并澄清目标。");
    checkDeadline();
    if (report.stages.some(stage => stage.stage === "research" && stage.status === "partial")) {
      report.coverage.status = "insufficient";
      report.coverage.gaps.push({ kind: "route", reason: "部分研究处理未通过，路线将基于已确认条件和模型推断，缺少的知乎依据仍待核实。" });
    }
    report.stopReason = report.coverage.status === "sufficient" ? "coverage_sufficient" : "model_planning_with_insufficient_evidence";
    return { runId: `research-live-${randomUUID()}`, proposalId: `baseline-live-${randomUUID()}`, now: new Date().toISOString(),
      questions, requests, evidencePacks: aggregated.evidencePacks, controller: structuredClone(report) };
  } catch (error) {
    if (error instanceof ResearchControllerError) throw error;
    if (error instanceof ZhihuProviderError || error instanceof BoundaryError) {
      report.stopReason = error.upstreamCode ?? error.code;
      if (report.stages.at(-1)?.stage === "research") {
        const searches = error.metrics?.search_calls_attempted;
        if (Number.isSafeInteger(searches) && searches! >= 0) report.searchCallsAttempted += searches!;
      }
      const status = error instanceof ZhihuProviderError ? error.status : error.code === "invalid_request" ? 422 : 502;
      throw new ResearchControllerError(error.code, error instanceof ZhihuProviderError ? researchFailureMessage(error, report) : "研究接口数据未通过校验。",
        status, structuredClone(report), error instanceof ZhihuProviderError ? error.cleanupError : undefined, completedResearch());
    }
    if (error instanceof ResearchRequestValidationError) fail("invalid_queries", "研究问题或 Query 不符合数量与安全约束。");
    if (error instanceof ResearchEvidenceError) fail("invalid_evidence", "研究证据或引用关系未通过校验。", 502);
    fail("research_failed", "研究执行失败，未回退 Mock。", 502);
  } finally { clearTimeout(timer); }
}

function normalizeQuery(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/ß/g, "ss").replace(/ς/g, "σ").replace(/\s/gu, "").replace(/[?!.。]+$/u, "");
}

function researchFailureMessage(error: ZhihuProviderError, report: ResearchControllerReport): string {
  const messages: Record<string, string> = {
    rate_or_quota_limit: "知乎搜索触发限流或额度不足，请检查知乎额度或稍后重试。本次已停止，未自动重试。",
    authentication_failed: "知乎授权失效或未登录，请检查本机知乎授权后重试。",
    compilation_failed: "知乎证据编译失败，模型返回未通过证据校验；请查看后端诊断后重试。",
    invalid_plan_output: "研究问题规划失败，模型输出未通过校验；尚未开始知乎检索。",
    llm_error: "研究模型调用失败，请检查模型服务、授权或额度。",
    configuration_error: "研究服务配置无效，请检查后端模型和知乎配置。",
    dependency_unavailable: "Python 研究依赖不可用，请检查解释器环境和知乎 CLI。",
    research_timeout: "知乎研究超时，本次已停止；请稍后重试。",
  };
  const stage = report.stages.at(-1)?.stage;
  const label = stage === "plan" ? "研究问题规划" : stage === "supplement" ? "补充研究规划" : "知乎检索与证据处理";
  return `${label}：${messages[error.upstreamCode ?? ""] ?? error.message}`;
}
