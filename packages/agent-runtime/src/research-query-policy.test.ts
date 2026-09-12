import { describe, expect, it } from "vitest";
import type { ResearchQuestionDraft } from "@zhilu/contracts";
import {
  assembleResearchRequests,
  ResearchRequestValidationError,
  validateResearchQuestionDrafts,
  type ResearchQueryPolicy,
} from "./index.js";

function questions(counts: number[]): ResearchQuestionDraft[] {
  return counts.map((count, index) => ({
    question: `初学者制作木桌时应该怎样检查第 ${index + 1} 项结构？`,
    rationale: "确认适用条件与限制，避免把个别经验当作普遍事实。",
    searchQueries: Array.from({ length: count }, (_, queryIndex) => `木桌 条件 ${index + 1} 检查 ${queryIndex + 1}`),
  }));
}

describe("explicit M2 query policy", () => {
  it.each([[2], [1, 1], [1, 2], [1, 1, 1]])("accepts initial distribution %j without filling three questions", (...counts) => {
    expect(validateResearchQuestionDrafts(questions(counts), "initial")).toEqual({ valid: true, issues: [] });
  });

  it.each([[1], [2, 2], [2, 2, 2]])("rejects initial total outside 2–3 for %j", (...counts) => {
    const result = validateResearchQuestionDrafts(questions(counts), "initial");
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "QUERY_COUNT")).toBe(true);
  });

  it.each([[1], [2], [1, 2]])("accepts supplemental distribution %j", (...counts) => {
    expect(validateResearchQuestionDrafts(questions(counts), "supplemental").valid).toBe(true);
  });

  it.each(["initial", "supplemental"] as const)("bounds each question to 1–2 queries for %s", (policy) => {
    for (const counts of [[3], [0, 2]]) {
      const result = validateResearchQuestionDrafts(questions(counts), policy);
      expect(result.valid).toBe(false);
      expect(result.issues.some((issue) => issue.code === "QUESTION_QUERY_COUNT")).toBe(true);
    }
  });

  it("keeps default legacy 6–10 total and existing per-question behavior", () => {
    expect(validateResearchQuestionDrafts(questions([3, 3])).valid).toBe(true);
    expect(validateResearchQuestionDrafts(questions([10]), "legacy").valid).toBe(true);
    expect(validateResearchQuestionDrafts(questions([1, 1])).valid).toBe(false);
    expect(validateResearchQuestionDrafts(questions([11])).valid).toBe(false);
  });

  it("retains blank and duplicate checks for the new policy", () => {
    const drafts = questions([1, 1]);
    drafts[1]!.searchQueries = [...drafts[0]!.searchQueries];
    drafts[0]!.rationale = " ";
    const result = validateResearchQuestionDrafts(drafts, "initial");
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["EMPTY_RATIONALE", "DUPLICATE_QUERY"]));
  });

  it.each(["unknown", null, 2, true])("rejects invalid runtime policy %j", (policy) => {
    const result = validateResearchQuestionDrafts(questions([3, 3]), policy as ResearchQueryPolicy);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("INVALID_QUERY_POLICY");
  });

  it("assembles two initial queries using caller IDs and without changing drafts", () => {
    const drafts = questions([1, 1]);
    const before = structuredClone(drafts);
    const requests = assembleResearchRequests({
      questions: drafts,
      queryPolicy: "initial",
      relevantUserConditions: ["初学者"],
      evidenceLimitPerQuestion: 8,
      idFactory: (index) => `controller-request-${index + 7}`,
    });
    expect(requests.map((request) => request.id)).toEqual(["controller-request-7", "controller-request-8"]);
    expect(requests.flatMap((request) => request.searchQueries)).toHaveLength(2);
    expect(requests[0]!.evidenceLimit).toBe(8);
    expect(drafts).toEqual(before);
    requests[0]!.searchQueries.push("调用方临时修改");
    expect(drafts).toEqual(before);
  });

  it("assembles a single supplemental query with the same external ID rule", () => {
    const requests = assembleResearchRequests({
      questions: questions([1]),
      queryPolicy: "supplemental",
      relevantUserConditions: [],
      evidenceLimitPerQuestion: 3,
      idFactory: () => "supplemental-external-id",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.id).toBe("supplemental-external-id");
    expect(requests[0]!.searchQueries).toHaveLength(1);
  });

  it("requires callers to opt into smaller budgets and rejects bad policy before IDs", () => {
    let allocated = 0;
    const input = {
      questions: questions([1, 1]),
      relevantUserConditions: [],
      evidenceLimitPerQuestion: 2,
      idFactory: () => String(++allocated),
    };
    expect(() => assembleResearchRequests(input)).toThrow(ResearchRequestValidationError);
    expect(() => assembleResearchRequests({ ...input, queryPolicy: "unknown" as ResearchQueryPolicy })).toThrow(ResearchRequestValidationError);
    expect(allocated).toBe(0);
  });
});
