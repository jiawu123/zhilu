import { describe, expect, it } from "vitest";
import { assembleResearchRequests } from "@zhilu/agent-runtime";
import { BoundaryError, parsePlanningResponse, parseResearchResponse, validateResearchInput } from "./zhihu-boundary.js";

const request = { id: "external-rq", question: "如何测试程序结果？", searchQueries: ["程序 测试"], relevantUserConditions: [], evidenceLimit: 2 };
const envelope = (data: unknown, action = "research") => ({ protocol_version: "m2-entry-v0.1", run_id: "offline-run", action, ok: true, error: null, data, metrics: { search_calls_attempted: 1, compiler_calls_attempted: 1, candidate_count: 1, evidence_count: 1 } });
export function compiler() {
  const snippet = "😀开头\r\n给程序输入固定样例，并检查输出结果。";
  return { compiler_version: "m2-evidence-v0.1.2", status: "ok", reason: "回答检查问题", source: { id: "zhihu:Answer:1", provider: "zhihu", title: "离线合成来源", url: "https://www.zhihu.com/question/1/answer/2", author: "合成作者", snippet, retrievedAt: null, source_scope: "search_snippet" }, evidence_cards: [{ id: "ev_123", source_id: "zhihu:Answer:1", source_url: "https://www.zhihu.com/question/1/answer/2", source_title: "离线合成来源", source_scope: "search_snippet", claim: "作者建议检查输出", claim_type: "advice", supporting_quote: "给程序输入固定样例，并检查输出结果。", quote_start: 5, quote_end: [...snippet].length, citation_status: "exact_match", verification_status: "unverified", applies_when: "需要检查程序时", applicability_basis: "ai_inference", caveats: [], risk_flags: ["search_snippet_only", "not_independently_verified", "semantic_support_not_checked"] }] };
}
const response = () => envelope({ requestId: request.id, status: "ok", compilerOutputs: [compiler()], routeCandidates: [], unresolvedQuestions: [], issues: [] });
describe("M2 unknown boundary", () => {
  it("defensively copies valid single-query input", () => {
    const input = { goal: "构建测试程序", user_context: {}, request };
    expect(validateResearchInput(input)).toEqual(input);
    expect(validateResearchInput(input)).not.toBe(input);
  });
  it.each([0, 13, true, 1.5, "4", null])("rejects invalid limit %s", (evidenceLimit) => {
    expect(() => validateResearchInput({ goal: "目标", user_context: {}, request: { ...request, evidenceLimit } })).toThrow(BoundaryError);
  });
  it("preserves Unicode codepoint quotes, CRLF, risks, and unknown time", () => {
    const result = parseResearchResponse(response(), request);
    expect(result.pack.evidence[0]).toMatchObject({ supportingQuote: compiler().evidence_cards[0]!.supporting_quote, riskTags: compiler().evidence_cards[0]!.risk_flags, author: "合成作者", verificationStatus: "unverified" });
    expect(result.pack.evidence[0]!.retrievedAt).toBeUndefined();
  });
  it.each(["id", "quote", "enum", "limit", "url", "risk", "offset", "field", "conflict"])("rejects malformed compiler %s", (kind) => {
    const output = compiler(); const data = { requestId: request.id, status: "ok", compilerOutputs: [output], routeCandidates: [], unresolvedQuestions: [], issues: [] };
    if (kind === "id") data.requestId = "wrong";
    if (kind === "quote") output.evidence_cards[0]!.supporting_quote = "伪造的引文不在原文中";
    if (kind === "enum") output.evidence_cards[0]!.verification_status = "verified";
    if (kind === "url") output.source.url = "https://zhihu.com.evil.test/";
    if (kind === "risk") output.evidence_cards[0]!.risk_flags = [];
    if (kind === "offset") output.evidence_cards[0]!.quote_start++;
    if (kind === "field") delete (output.source as Partial<typeof output.source>).snippet;
    if (kind === "conflict") { const other = structuredClone(output); other.evidence_cards[0]!.claim = "不同内容"; data.compilerOutputs.push(other); }
    if (kind === "limit") { const other = structuredClone(output); other.evidence_cards[0]!.id = "ev_other"; data.compilerOutputs.push(other); }
    expect(() => parseResearchResponse(envelope(data), { ...request, evidenceLimit: 1 })).toThrow(BoundaryError);
  });
  it("deduplicates identical cards stably", () => {
    const value = response(); (value.data as any).compilerOutputs.push(compiler());
    expect(parseResearchResponse(value, request).pack.evidence).toHaveLength(1);
  });
  it.each(["version", "action", "missing", "metrics", "routes", "status", "issue"])("rejects envelope violation %s", kind => {
    const value: any = response();
    if (kind === "version") value.protocol_version = "future";
    if (kind === "action") value.action = "plan";
    if (kind === "missing") delete value.error;
    if (kind === "metrics") value.metrics.evidence_count = Infinity;
    if (kind === "routes") value.data.routeCandidates = [{ id: "invented-route" }];
    if (kind === "status") value.data.status = "no_evidence";
    if (kind === "issue") value.data.issues = [{ code: "raw-secret", stage: "search" }];
    expect(() => parseResearchResponse(value, request)).toThrow(BoundaryError);
  });
  it("keeps no_evidence and partial distinct", () => {
    const data = { requestId: request.id, status: "no_evidence", compilerOutputs: [], routeCandidates: [], unresolvedQuestions: ["没有适用证据"], issues: [] as object[] };
    expect(parseResearchResponse(envelope(data), request).status).toBe("no_evidence");
    data.status = "partial"; data.issues = [{ code: "search_timeout", stage: "search", queryIndex: 0 }];
    expect(parseResearchResponse(envelope(data), request).issues).toEqual(data.issues);
  });
  it.each([NaN, Infinity, () => 1, new Date()])("rejects non-JSON context", value => {
    expect(() => validateResearchInput({ goal: "目标", user_context: { value }, request })).toThrow(BoundaryError);
  });
  it.each([{ searchQueries: ["Ａgent", "agent"] }, { searchQueries: ["--help"] }, { searchQueries: ["https://zhihu.com"] }, { searchQueries: ["hello\nworld"] }, { searchQueries: ["关键词\u0001"] }])("rejects unsafe queries $searchQueries", ({ searchQueries }) => {
    expect(() => validateResearchInput({ goal: "目标", user_context: {}, request: { ...request, searchQueries } })).toThrow(BoundaryError);
  });
  it("returns clarification without drafts", () => {
    expect(parsePlanningResponse(envelope({ status: "needs_clarification", reason: "需要目标", research_questions: [], clarification_questions: ["要完成什么？"] }, "plan"))).toMatchObject({ status: "needs_clarification", questions: [], clarificationQuestions: ["要完成什么？"] });
  });
  it("rejects execution settings hidden in context", () => {
    expect(() => validateResearchInput({ goal: "目标", user_context: { pythonPath: "arbitrary" }, request })).toThrow(BoundaryError);
  });
  it("preserves safe upstream error codes without raw messages", () => {
    const value = { ...envelope(null), ok: false, error: { code: "authentication_failed", message: "secret upstream detail" } };
    try { parseResearchResponse(value, request); throw Error("expected failure"); } catch (error) {
      expect(error).toMatchObject({ code: "upstream_failed", upstreamCode: "authentication_failed" });
      expect(error).toHaveProperty("metrics", value.metrics);
      expect(String(error)).not.toContain("secret");
    }
  });
  it.each([undefined, -1, 1.5, true, Infinity])("rejects failed research envelope with invalid required metrics %s", count => {
    const value = { ...envelope(null), ok: false, error: { code: "research_failed", message: "Research failed." }, metrics: { ...envelope(null).metrics, search_calls_attempted: count } };
    expect(() => parseResearchResponse(value, request)).toThrowError(expect.objectContaining({ code: "invalid_response" }));
  });
  it("rejects malformed failure envelope", () => {
    expect(() => parseResearchResponse({ ...envelope(null), ok: false, error: { code: "authentication_failed" } }, request)).toThrowError(expect.objectContaining({ code: "invalid_response" }));
  });
  it("maps only three planner fields and leaves IDs to Controller", () => {
    const data = { status: "ready_for_review", reason: "", research_questions: [0, 1, 2].map(i => ({ question_id: `internal-${i}`, research_question: `如何完成程序测试步骤${i}？`, why_needed: "帮助验收", queries: [`程序 测试 ${i}`, `程序 验收 ${i}`] })), clarification_questions: [] };
    const result = parsePlanningResponse(envelope(data, "plan"));
    expect(Object.keys(result.questions[0]!).sort()).toEqual(["question", "rationale", "searchQueries"]);
    expect(assembleResearchRequests({ questions: result.questions, relevantUserConditions: [], evidenceLimitPerQuestion: 2, idFactory: i => `external-${i}` }).map(r => r.id)).toEqual(["external-0", "external-1", "external-2"]);
    data.research_questions.pop();
    expect(() => parsePlanningResponse(envelope(data, "plan"))).toThrow(BoundaryError);
  });
  it("rejects normalized duplicates across planner questions", () => {
    const questions = [0, 1, 2].map(i => ({ research_question: `如何完成程序测试步骤${i}？`, why_needed: "帮助验收", queries: [`程序 测试 ${i}`, `程序 验收 ${i}`] }));
    questions[1]!.queries[0] = "程序 测试 ０";
    expect(() => parsePlanningResponse(envelope({ status: "ready_for_review", reason: "", research_questions: questions, clarification_questions: [] }, "plan"))).toThrow(BoundaryError);
  });
  it("does not accept planner verification promotion", () => {
    expect(() => parsePlanningResponse(envelope({ status: "needs_clarification", reason: "需要目标", research_questions: [], clarification_questions: ["要完成什么？"], human_approved: true }, "plan"))).toThrow(BoundaryError);
  });
});
