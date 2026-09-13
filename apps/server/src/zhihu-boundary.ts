import type { EvidencePack, ResearchQuestionDraft, ResearchRequest, ZhihuEvidenceCompilerOutput } from "@zhilu/contracts";
import { validateResearchQuestionDrafts } from "@zhilu/agent-runtime";
import { adaptZhihuCompilerOutput } from "./zhihu-adapter.js";

export interface M2ResearchInput { goal: string; user_context: Record<string, unknown>; request: ResearchRequest }
export interface ResearchIssue { code: string; stage: "search" | "normalize" | "rank" | "compile" | "coverage"; queryIndex?: number; sourceId?: string }
export interface ResearchProviderResult { runId: string; status: "ok" | "no_evidence" | "partial"; pack: EvidencePack; issues: ResearchIssue[]; metrics: Record<string, number> }
export interface BaselinePlanningResult { status: "ready_for_review" | "needs_clarification"; questions: ResearchQuestionDraft[]; clarificationQuestions: string[]; runId?: string; metrics?: Record<string, number> }
export interface M2SupplementalInput { goal: string; user_context: Record<string, unknown>; gaps: NonNullable<EvidencePack["coverage"]>["gaps"]; executed_queries: string[]; remaining_query_budget: number }
export interface SupplementalPlanningResult { status: "ready_for_review" | "stop"; questions: ResearchQuestionDraft[]; stopReason: "coverage_sufficient" | "query_budget_exhausted" | "no_useful_queries" | null; gaps: M2SupplementalInput["gaps"]; plannerCallsAttempted: number }
export class BoundaryError extends Error {
  constructor(public readonly code: "invalid_request" | "invalid_response" | "upstream_failed", public readonly upstreamCode?: string, public readonly metrics?: Record<string, number>) {
    super(code === "invalid_request" ? "Invalid research input." : "Invalid or unsuccessful M2 response.");
    this.name = "BoundaryError";
  }
}
type Obj = Record<string, unknown>;
function check(condition: unknown): asserts condition { if (!condition) throw new BoundaryError("invalid_response"); }
function object(value: unknown): Obj { check(value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype); return value as Obj; }
function text(value: unknown, max: number, blank = false): string { check(typeof value === "string" && [...value].length <= max && (blank || value.trim())); return value as string; }
function list(value: unknown, max: number): unknown[] { check(Array.isArray(value) && value.length <= max); return value as unknown[]; }
function strings(value: unknown, maxItems: number, maxLength: number): string[] { return list(value, maxItems).map(v => text(v, maxLength)); }
function integer(value: unknown, min: number, max: number): number { check(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max); return value as number; }
function keys(value: Obj, required: string[], optional: string[] = []) { check(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k))); }
function plainJson(value: unknown, depth = 0): void {
  check(depth <= 12);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { check(Number.isFinite(value)); return; }
  if (Array.isArray(value)) { for (const item of value) plainJson(item, depth + 1); return; }
  const record = object(value);
  check(Reflect.ownKeys(record).length === Object.keys(record).length);
  for (const [key, item] of Object.entries(record)) {
    check(!["apikey", "deepseekapikey", "accesssecret", "secret", "password", "authorization", "token", "pythonpath", "pythonexecutable", "command", "executable", "env"].includes(key.replace(/[_\-\s]/gu, "").toLowerCase()));
    plainJson(item, depth + 1);
  }
}
// Match Python ensure_ascii=False JSON separators for its serialized context limit.
function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${pythonJson(v)}`).join(", ")}}`;
  return JSON.stringify(value);
}
function normalized(value: string) { return value.normalize("NFKC").toLowerCase().replace(/ß/g, "ss").replace(/ς/g, "σ").replace(/\s/gu, "").replace(/[?!.。]+$/u, ""); }
function queries(value: unknown): string[] {
  const result = strings(value, 10, 120); check(result.length >= 1);
  const seen = new Set<string>();
  for (const query of result) {
    const normal = query.normalize("NFKC"); const key = normalized(query);
    check(!normal.trimStart().startsWith("-") && !/[\p{C}\u2028\u2029]/u.test(normal) && !/\w+:\/\/|www\./iu.test(normal));
    check(key && !seen.has(key)); seen.add(key);
  }
  return result;
}
export function validateResearchRequest(value: unknown): ResearchRequest {
  try {
    const r = object(value); keys(r, ["id", "question", "searchQueries", "relevantUserConditions", "evidenceLimit"], ["freshness"]);
    const result: ResearchRequest = { id: text(r.id, 200), question: text(r.question, 2000), searchQueries: queries(r.searchQueries), relevantUserConditions: strings(r.relevantUserConditions, 64000, 2000), evidenceLimit: integer(r.evidenceLimit, 1, 12) };
    if (Object.hasOwn(r, "freshness")) result.freshness = text(r.freshness, 2000);
    return result;
  } catch { throw new BoundaryError("invalid_request"); }
}
export function validateResearchInput(value: unknown): M2ResearchInput {
  try {
    const input = object(value); keys(input, ["goal", "user_context", "request"]);
    const goal = text(input.goal, 2000); const context = object(input.user_context); plainJson(context);
    const request = validateResearchRequest(input.request);
    const constraints = { relevantUserConditions: request.relevantUserConditions, ...(request.freshness ? { freshness: request.freshness } : {}) };
    check([...pythonJson({ confirmed_user_context: context, research_request_constraints: constraints })].length <= 8000);
    check(Buffer.byteLength(pythonJson(input), "utf8") <= 64000);
    return { goal, user_context: structuredClone(context), request };
  } catch { throw new BoundaryError("invalid_request"); }
}
const UPSTREAM_CODES = new Set(["invalid_arguments", "invalid_json", "input_too_large", "input_io_error", "invalid_request", "dependency_unavailable", "invalid_plan_output", "llm_error", "execution_error", "output_io_error", "interrupted", "research_failed", "compilation_failed", "configuration_error", "authentication_failed", "rate_or_quota_limit", "evidence_id_conflict", "research_timeout"]);
function envelope(value: unknown, action: string) {
  const e = object(value);
  keys(e, ["protocol_version", "run_id", "action", "ok", "data", "error", "metrics"]);
  check(e.protocol_version === "m2-entry-v0.1" && e.action === action && typeof e.ok === "boolean");
  const runId = text(e.run_id, 200); const rawMetrics = object(e.metrics); const metrics: Record<string, number> = {};
  for (const [key, val] of Object.entries(rawMetrics)) {
    text(key, 100);
    // Existing plan metrics include descriptive strings and booleans. Only numeric counters leave this boundary.
    if (typeof val === "number") { check(Number.isFinite(val) && val >= 0); metrics[key] = val; }
    else check(typeof val === "boolean" || typeof val === "string");
  }
  if (action === "research") for (const key of ["search_calls_attempted", "compiler_calls_attempted", "candidate_count", "evidence_count"]) integer(metrics[key], 0, Number.MAX_SAFE_INTEGER);
  if (!e.ok) {
    check(e.data === null); const error = object(e.error); keys(error, ["code", "message"]); const code = text(error.code, 100); text(error.message, 2000);
    check(UPSTREAM_CODES.has(code));
    const safeMetrics: Record<string, number> = {};
    for (const key of ["planner_calls_attempted", "search_calls_attempted", "compiler_calls_attempted", "candidate_count", "evidence_count", "batch_model_calls_attempted", "model_calls_attempted", "cache_hit", "cache_write_success", "saved_search_calls", "saved_model_calls", "search_duration_ms", "batch_duration_ms", "total_duration_ms", "cache_read_duration_ms", "batch_invalid_item_count", "batch_valid_output_count", "batch_invalid_group_count"]) {
      if (Object.hasOwn(metrics, key)) safeMetrics[key] = integer(metrics[key], 0, Number.MAX_SAFE_INTEGER);
    }
    throw new BoundaryError("upstream_failed", code, safeMetrics);
  }
  check(e.error === null);
  return { data: object(e.data), runId, metrics };
}
function validateCompiler(value: unknown): ZhihuEvidenceCompilerOutput {
  const o = object(value); keys(o, ["compiler_version", "status", "reason", "source", "evidence_cards"]);
  check(o.compiler_version === "m2-evidence-v0.1.2" && ["ok", "no_evidence"].includes(o.status as string));
  text(o.reason, 1000, o.status === "ok");
  const s = object(o.source); keys(s, ["id", "provider", "title", "url", "author", "snippet", "retrievedAt", "source_scope"]);
  text(s.id, 300); text(s.title, 2000); text(s.author, 64000, true); const snippet = text(s.snippet, 24000); const url = text(s.url, 4096);
  let parsed: URL; try { parsed = new URL(url); } catch { throw new BoundaryError("invalid_response"); }
  check(parsed.protocol === "https:" && (parsed.hostname === "zhihu.com" || parsed.hostname.endsWith(".zhihu.com")) && !parsed.username && !parsed.password && (!parsed.port || parsed.port === "443") && !/[\s\\\p{C}]/u.test(url));
  check(s.provider === "zhihu" && s.source_scope === "search_snippet");
  if (s.retrievedAt !== null) { const timestamp = text(s.retrievedAt, 80); check(/(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp) && Number.isFinite(Date.parse(timestamp))); }
  const cards = list(o.evidence_cards, 1); check(cards.length === (o.status === "ok" ? 1 : 0));
  for (const value of cards) {
    const c = object(value);
    keys(c, ["id", "source_id", "source_url", "source_title", "source_scope", "claim", "claim_type", "supporting_quote", "quote_start", "quote_end", "citation_status", "verification_status", "applies_when", "applicability_basis", "caveats", "risk_flags"]);
    text(c.id, 200); text(c.claim, 1000); text(c.applies_when, 1000);
    check(c.source_id === s.id && c.source_url === s.url && c.source_title === s.title && c.source_scope === s.source_scope);
    check(["advice", "experience", "opinion", "factual_claim"].includes(c.claim_type as string));
    check(c.citation_status === "exact_match" && c.verification_status === "unverified" && c.applicability_basis === "ai_inference");
    const quote = text(c.supporting_quote, 400); check([...quote.trim()].length >= 8);
    const points = [...snippet]; const start = integer(c.quote_start, 0, points.length); const end = integer(c.quote_end, start + 1, points.length);
    check(points.slice(start, end).join("") === quote);
    strings(c.caveats, 6, 600); const risks = strings(c.risk_flags, 32, 200);
    check(["search_snippet_only", "not_independently_verified", "semantic_support_not_checked"].every(risk => risks.includes(risk)));
  }
  return o as unknown as ZhihuEvidenceCompilerOutput;
}
const ISSUE_STAGES: Record<string, ResearchIssue["stage"]> = { search_timeout: "search", search_network_error: "search", search_upstream_error: "search", search_invalid_response: "search", source_invalid: "normalize", rank_failed: "rank", compiler_failed: "compile", compiler_invalid_output: "compile", compiler_budget_exhausted: "coverage", freshness_not_enforced: "coverage", candidate_batch_truncated: "coverage" };
export function parseResearchResponse(value: unknown, request: ResearchRequest): ResearchProviderResult {
  const checkedRequest = validateResearchRequest(request);
  const { data, runId, metrics } = envelope(value, "research");
  keys(data, ["requestId", "status", "compilerOutputs", "routeCandidates", "unresolvedQuestions", "issues"], ["coverage"]);
  check(data.requestId === checkedRequest.id && ["ok", "no_evidence", "partial"].includes(data.status as string));
  const unresolvedQuestions = strings(data.unresolvedQuestions, 100, 2000);
  const issues: ResearchIssue[] = list(data.issues, 200).map(value => {
    const i = object(value); keys(i, ["code", "stage"], ["queryIndex", "sourceId"]);
    const code = text(i.code, 100); check(Object.hasOwn(ISSUE_STAGES, code) && i.stage === ISSUE_STAGES[code]);
    return { code, stage: ISSUE_STAGES[code]!, ...(Object.hasOwn(i, "queryIndex") ? { queryIndex: integer(i.queryIndex, 0, checkedRequest.searchQueries.length - 1) } : {}), ...(Object.hasOwn(i, "sourceId") ? { sourceId: text(i.sourceId, 300) } : {}) };
  });
  const evidence: EvidencePack["evidence"] = []; const seen = new Map<string, string>();
  for (const raw of list(data.compilerOutputs, 100)) {
    const output = validateCompiler(raw);
    for (const card of adaptZhihuCompilerOutput(output)) {
      // Compare the full compiler card and source, so lost adapter fields cannot conceal a collision.
      const identity = JSON.stringify({ card: output.evidence_cards[0], source: output.source, reason: output.reason }, (_key, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
      if (seen.has(card.id)) { check(seen.get(card.id) === identity); continue; }
      seen.set(card.id, identity); evidence.push(card);
    }
  }
  check(evidence.length <= checkedRequest.evidenceLimit);
  check(data.status !== "no_evidence" || evidence.length === 0);
  check(data.status !== "ok" || evidence.length > 0);
  check(data.status === "partial" ? issues.length > 0 : issues.length === 0);
  const routeIds = new Set<string>();
  const routeCandidates: EvidencePack["routeCandidates"] = list(data.routeCandidates, 8).map(value => {
    const route = object(value); keys(route, ["id", "title", "summary", "applicableWhen", "evidenceIds", "risks"]);
    const id = text(route.id, 200); check(!routeIds.has(id)); routeIds.add(id);
    const evidenceIds = strings(route.evidenceIds, 8, 200); const risks = strings(route.risks, 12, 600);
    const applicableWhen = strings(route.applicableWhen, 8, 1000);
    check(evidenceIds.length > 0 && new Set(evidenceIds).size === evidenceIds.length && evidenceIds.every(id => seen.has(id)));
    check(applicableWhen.length > 0 && risks.includes("model_inferred_needs_human_review"));
    return { id, title: text(route.title, 300), summary: text(route.summary, 1000), applicableWhen, evidenceIds, risks };
  });
  const pack: EvidencePack = { requestId: checkedRequest.id, evidence, routeCandidates, unresolvedQuestions };
  if (Object.hasOwn(data, "coverage")) {
    const c = object(data.coverage); keys(c, ["status", "evidenceCount", "targetMin", "targetMax", "hasCaveat", "gaps", "reviewStatus"]);
    check(c.status === "sufficient" || c.status === "insufficient");
    check(integer(c.evidenceCount, 0, 8) === evidence.length && c.targetMin === 6 && c.targetMax === 8);
    check(typeof c.hasCaveat === "boolean" && c.hasCaveat === evidence.some(card => card.caveats.length > 0));
    check(c.reviewStatus === "needs_human_review");
    const gaps = list(c.gaps, 12).map(value => {
      const gap = object(value); keys(gap, ["kind", "reason"]);
      check(["route", "conditions", "counterevidence", "evidence_count"].includes(gap.kind as string));
      return { kind: gap.kind as NonNullable<EvidencePack["coverage"]>["gaps"][number]["kind"], reason: text(gap.reason, 2000) };
    });
    check(c.status === "sufficient" ? evidence.length >= 6 && c.hasCaveat && gaps.length === 0 && routeCandidates.length > 0 : gaps.length > 0);
    const urls = new Map<string, number>(); const authors = new Map<string, number>(); const sources = new Map<string, number>();
    for (const card of evidence) {
      check(typeof card.sourceUrl === "string");
      const count = (urls.get(card.sourceUrl) ?? 0) + 1; urls.set(card.sourceUrl, count); check(count <= 2);
      // source IDs are checked against originals before adaptation above.
      if (card.author?.trim()) { const key = card.author.trim().toLowerCase().replace(/ß/g, "ss").replace(/ς/g, "σ"); const n = (authors.get(key) ?? 0) + 1; authors.set(key, n); check(n <= 3); }
    }
    for (const raw of list(data.compilerOutputs, 100)) {
      const o = object(raw); const s = object(o.source); const n = list(o.evidence_cards, 1).length;
      const id = text(s.id, 300); sources.set(id, (sources.get(id) ?? 0) + n); check(sources.get(id)! <= 2);
    }
    pack.coverage = { status: c.status, evidenceCount: evidence.length, targetMin: 6, targetMax: 8, hasCaveat: c.hasCaveat, gaps, reviewStatus: "needs_human_review" };
  } else check(routeCandidates.length === 0);
  return { runId, status: data.status as ResearchProviderResult["status"], pack, issues, metrics };
}
export function parsePlanningResponse(value: unknown, profile: "jia-p0-baseline" | "m2-initial" | "m2-supplemental" = "jia-p0-baseline"): BaselinePlanningResult {
  const { data, runId, metrics } = envelope(value, "plan");
  const metadata = profile === "jia-p0-baseline" ? {} : { runId, metrics };
  for (const flag of ["human_approved", "semantic_quality_checked", "coverage_verified", "queries_executed", "new_zhihu_search", "evidence_compilation_performed"]) if (Object.hasOwn(data, flag)) check(data[flag] === false);
  check(data.status === "ready_for_review" || data.status === "needs_clarification");
  text(data.reason, 1000, data.status === "ready_for_review");
  const raw = list(data.research_questions, 3); const clarificationQuestions = strings(data.clarification_questions, 3, 300);
  if (data.status === "needs_clarification") { check(raw.length === 0 && clarificationQuestions.length > 0); return { status: "needs_clarification", questions: [], clarificationQuestions, ...metadata }; }
  check(clarificationQuestions.length === 0);
  const questions = raw.map(value => { const q = object(value); return { question: text(q.research_question, 300), searchQueries: queries(q.queries), rationale: text(q.why_needed, 600) }; });
  const allQueries = questions.flatMap(question => question.searchQueries.map(normalized));
  check(new Set(allQueries).size === allQueries.length);
  check(new Set(questions.map(question => normalized(question.question))).size === questions.length);
  check(["jia-p0-baseline", "m2-initial", "m2-supplemental"].includes(profile));
  check(validateResearchQuestionDrafts(questions, profile === "m2-initial" ? "initial" : profile === "m2-supplemental" ? "supplemental" : "legacy").valid);
  return { status: "ready_for_review", questions, clarificationQuestions, ...metadata };
}

export function validateSupplementalInput(value: unknown): M2SupplementalInput {
  try {
    const input = object(value); keys(input, ["goal", "user_context", "gaps", "executed_queries", "remaining_query_budget"]);
    const common = validateResearchInput({ goal: input.goal, user_context: input.user_context, request: { id: "validation-only", question: "输入校验", searchQueries: ["输入校验"], relevantUserConditions: [], evidenceLimit: 1 } });
    const gaps = list(input.gaps, 12).map(value => {
      const gap = object(value); keys(gap, ["kind", "reason"]);
      check(["route", "conditions", "counterevidence", "evidence_count"].includes(gap.kind as string));
      return { kind: gap.kind as M2SupplementalInput["gaps"][number]["kind"], reason: text(gap.reason, 600).trim() };
    });
    const executed = strings(input.executed_queries, 100, 120).map(q => queries([q])[0]!.trim());
    check(new Set(executed.map(normalized)).size === executed.length);
    check(Buffer.byteLength(pythonJson(input), "utf8") <= 64000);
    return { goal: common.goal, user_context: common.user_context, gaps, executed_queries: executed, remaining_query_budget: integer(input.remaining_query_budget, 0, Number.MAX_SAFE_INTEGER) };
  } catch { throw new BoundaryError("invalid_request"); }
}

export function parseSupplementalResponse(value: unknown, input: M2SupplementalInput): SupplementalPlanningResult {
  input = validateSupplementalInput(input);
  const { data } = envelope(value, "supplement");
  check(data.planning_stage === "supplemental" && data.input_scope === "goal_context_and_gap_summary");
  check(data.remaining_query_budget === input.remaining_query_budget && data.executed_query_count === input.executed_queries.length);
  check(JSON.stringify(data.gaps) === JSON.stringify(input.gaps));
  const plannerCallsAttempted = integer(data.planner_calls_attempted, 0, 1);
  const shouldCall = input.gaps.length > 0 && input.remaining_query_budget > 0;
  check(plannerCallsAttempted === Number(shouldCall));
  for (const flag of ["human_approved", "semantic_quality_checked", "coverage_verified", "queries_executed", "new_zhihu_search", "evidence_compilation_performed"]) if (Object.hasOwn(data, flag)) check(data[flag] === false);
  if (data.status === "stop") {
    text(data.reason, 1000); check(list(data.research_questions, 0).length === 0 && list(data.clarification_questions, 0).length === 0);
    const stopReason = input.gaps.length === 0 ? "coverage_sufficient" : input.remaining_query_budget === 0 ? "query_budget_exhausted" : "no_useful_queries";
    check(data.stop_reason === stopReason);
    return { status: "stop", questions: [], stopReason, gaps: input.gaps, plannerCallsAttempted };
  }
  check(shouldCall && data.status === "ready_for_review" && data.stop_reason === null);
  const proposal = parsePlanningResponse({ ...object(value), action: "plan" }, "m2-supplemental");
  const next = proposal.questions.flatMap(q => q.searchQueries);
  check(next.length <= Math.min(3, input.remaining_query_budget));
  const executed = new Set(input.executed_queries.map(normalized)); check(next.every(q => !executed.has(normalized(q))));
  return { status: "ready_for_review", questions: proposal.questions, stopReason: null, gaps: input.gaps, plannerCallsAttempted };
}
