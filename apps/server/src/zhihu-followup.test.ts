import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { parsePlanningResponse, parseResearchResponse, parseSupplementalResponse, validateSupplementalInput } from "./zhihu-boundary.js";

const root = resolve(import.meta.dirname, "../../..");
const request = { id: "external-rq", question: "怎样检查程序？", searchQueries: ["程序 检查"], relevantUserConditions: [], evidenceLimit: 8 };
let base: any;
beforeAll(() => {
  base = JSON.parse(execFileSync(process.env.ZHIHU_TEST_PYTHON_BIN ?? resolve(root, ".venv/Scripts/python.exe"),
    ["-B", "-X", "utf8", "tests/fixtures/compiler_boundary_offline.py"], {
      cwd: resolve(root, "packages/zhihu"), encoding: "utf8", timeout: 15000,
      env: { ...process.env, PYTHONPATH: resolve(root, "packages/zhihu"), PYTHON_DOTENV_DISABLED: "1", DEEPSEEK_API_KEY: "", ZHIHU_ACCESS_SECRET: "" },
    }));
});

function research() {
  const v = structuredClone(base);
  v.data.routeCandidates = [{ id: "hypothesis-1", title: "先核对样例", summary: "作者建议检查输出", applicableWhen: ["检查程序时"],
    evidenceIds: [v.data.compilerOutputs[0].evidence_cards[0].id], risks: ["model_inferred_needs_human_review"] }];
  v.data.coverage = { status: "insufficient", evidenceCount: 1, targetMin: 6, targetMax: 8, hasCaveat: true,
    gaps: [{ kind: "evidence_count", reason: "证据少于6张" }], reviewStatus: "needs_human_review" };
  return v;
}

it("preserves real Python compiler and research hypotheses through the existing adapter", () => {
  const value = research();
  const result = parseResearchResponse(value, request);
  expect(result.pack.routeCandidates).toEqual(value.data.routeCandidates);
  expect(result.pack.coverage).toEqual(value.data.coverage);
  expect(result.pack.evidence[0]?.verificationStatus).toBe("unverified");
  expect(result.pack.evidence[0]?.supportingQuote).toBe("给程序输入固定样例，并检查输出结果。");
});

it.each(["programming", "writing"])("accepts actual batch worker output for %s", domain => {
  const stdout = execFileSync(process.env.ZHIHU_TEST_PYTHON_BIN ?? resolve(root, ".venv/Scripts/python.exe"),
    ["-B", "-X", "utf8", "-m", "tests.fixtures.batch_boundary_offline", domain], {
      cwd: resolve(root, "packages/zhihu"), encoding: "utf8", timeout: 15000,
      env: { ...process.env, PYTHON_DOTENV_DISABLED: "1", DEEPSEEK_API_KEY: "", ZHIHU_ACCESS_SECRET: "" },
    });
  const result = parseResearchResponse(JSON.parse(stdout), request);
  expect(result.pack.evidence).toHaveLength(8);
  expect(result.pack.routeCandidates).toHaveLength(2);
  expect(result.pack.coverage?.reviewStatus).toBe("needs_human_review");
  expect(result.pack.evidence.every(card => card.verificationStatus === "unverified")).toBe(true);
});

it.each(["missing-id", "unreviewed", "sufficient", "count", "caps", "caveat"])("rejects false research coverage %s", mode => {
  const v = research();
  if (mode === "missing-id") v.data.routeCandidates[0].evidenceIds = ["invented"];
  if (mode === "unreviewed") v.data.coverage.reviewStatus = "verified";
  if (mode === "sufficient") { v.data.coverage.status = "sufficient"; v.data.coverage.gaps = []; }
  if (mode === "count") v.data.coverage.evidenceCount = true;
  if (mode === "caps") v.data.coverage.targetMax = 12;
  if (mode === "caveat") v.data.coverage.hasCaveat = false;
  expect(() => parseResearchResponse(v, request)).toThrow();
});

it("accepts initial total two queries while preserving the old boundary policy", () => {
  const value = { ...base, action: "plan", data: { status: "ready_for_review", reason: "", clarification_questions: [],
    research_questions: [{ research_question: "怎样完成程序测试验收？", queries: ["程序测试 方法", "程序测试 限制"], why_needed: "核对具体方法" }] } };
  expect(parsePlanningResponse(value, "m2-initial").questions).toHaveLength(1);
  expect(() => parsePlanningResponse(value)).toThrow();
  value.data.research_questions[0]!.queries.push("第三条查询", "第四条查询");
  expect(() => parsePlanningResponse(value, "m2-initial")).toThrow();
});

it("validates explicit supplemental stop and rejects silent budget or query reuse", () => {
  const input = { goal: "完成一本书", user_context: {}, gaps: [], executed_queries: ["写作 方法"], remaining_query_budget: 3 };
  const value = { ...base, action: "supplement", data: { status: "stop", reason: "覆盖已充分", research_questions: [],
    clarification_questions: [], planning_stage: "supplemental", input_scope: "goal_context_and_gap_summary",
    gaps: [], planner_calls_attempted: 0, remaining_query_budget: 3, executed_query_count: 1, stop_reason: "coverage_sufficient" } };
  expect(parseSupplementalResponse(value, validateSupplementalInput(input))).toMatchObject({ status: "stop", questions: [], plannerCallsAttempted: 0 });
  expect(() => validateSupplementalInput({ ...input, remaining_query_budget: true })).toThrow();
  value.data.planner_calls_attempted = 1;
  expect(() => parseSupplementalResponse(value, input)).toThrow();
});
