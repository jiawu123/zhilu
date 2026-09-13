import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseResearchResponse, type M2ResearchInput } from "../src/zhihu-boundary";
import { ZhihuProviderError, type ZhihuProviderConfig } from "../src/zhihu-provider";
import { runResearchZhihu } from "./research_zhihu";

const question = "计划一场环中国旅行";
let root: string;
let output: string[];
beforeEach(async () => { root = await mkdtemp(resolve(tmpdir(), "zhilu-research-cli-")); output = []; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
function context() { return { root, env: {}, log: (line: string) => output.push(line) }; }
function result(input: M2ResearchInput, partial = false) {
  return parseResearchResponse({
    protocol_version: "m2-entry-v0.1", run_id: "private-upstream-run", action: "research", ok: true, error: null,
    data: { requestId: input.request.id, status: partial ? "partial" : "no_evidence", compilerOutputs: [],
      routeCandidates: [], unresolvedQuestions: ["private-source-body: 缺少预算与季节证据"],
      issues: partial ? [{ code: "compiler_invalid_output", stage: "compile", sourceId: "private-source-id" }] : [] },
    metrics: { search_calls_attempted: 1, compiler_calls_attempted: 0, batch_model_calls_attempted: 1,
      model_calls_attempted: 1, candidate_count: 2, evidence_count: 0, "private-metric-name": 999,
      batch_invalid_item_count: 2, batch_valid_output_count: 1, batch_invalid_group_count: true },
  }, input.request);
}

describe("local research CLI", () => {
  it("builds a fresh neutral request and dry-runs without even creating a Provider", async () => {
    const code = await runResearchZhihu(["--question", `  ${question}  `], {
      ...context(), createProvider: () => { throw new Error("must not create a Provider during dry-run"); },
    });
    expect(code).toBe(0);
    const status = JSON.parse(output[0]!);
    expect(status).toMatchObject({ ok: true, status: "dry_run", stage: "input", searchQueryCount: 1,
      evidenceLimit: 5, metrics: { search_calls_attempted: 0, model_calls_attempted: 0 } });
    const input = await readJson(resolve(status.outputDir, "request.json"));
    expect(input).toEqual({ goal: question, user_context: {}, request: {
      id: status.requestId, question, searchQueries: [question], relevantUserConditions: [], evidenceLimit: 5,
    } });
    expect(input.request.id).toMatch(/^research-[0-9a-f-]{36}$/u);
    expect(await readdir(status.outputDir)).toEqual(["request.json", "status.json"]);
    expect(output.join(" ")).not.toContain(question);
  });

  it("uses one production research request and enforces the small budget despite inherited overrides", async () => {
    let config: ZhihuProviderConfig | undefined;
    const inputs: M2ResearchInput[] = [];
    const code = await runResearchZhihu(["--live", "--question", question], {
      ...context(), env: { ZHIHU_RETRIEVAL_PROFILE: "legacy", ZHIHU_COMPILER_MAX_CALLS: "50",
        ZHIHU_SEARCH_LIMIT_PER_QUERY: "5", ZHIHU_EVIDENCE_CACHE_ENABLED: "true", ZHIHU_EVIDENCE_CACHE_ONLY: "true" },
      createProvider: value => { config = value; return { researchOne: async input => { inputs.push(input); return result(input); } }; },
    });
    expect(code).toBe(0);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ goal: question, user_context: {}, request: {
      question, searchQueries: [question], relevantUserConditions: [], evidenceLimit: 5,
    } });
    expect(config).toMatchObject({ pythonBin: resolve(root, ".venv/Scripts/python.exe"),
      pythonCwd: resolve(root, "packages/zhihu"), timeoutMs: 630000,
      env: { ZHIHU_RETRIEVAL_PROFILE: "batch-v1", ZHIHU_COMPILER_MAX_CALLS: "1", ZHIHU_SEARCH_LIMIT_PER_QUERY: "10",
        ZHIHU_RESEARCH_DEADLINE_SECONDS: "600", ZHIHU_EVIDENCE_CACHE_ENABLED: "false", ZHIHU_EVIDENCE_CACHE_ONLY: "false" } });
    const status = JSON.parse(output[0]!);
    const saved = await readJson(resolve(status.outputDir, "result.json"));
    expect(saved.result.pack.requestId).toBe(inputs[0]!.request.id);
    expect(saved.result.pack.unresolvedQuestions).toEqual(["private-source-body: 缺少预算与季节证据"]);
    expect(output.join(" ")).not.toMatch(/private|环中国|Python 初学者|自动化测试/u);
  });

  it("preserves explicit interpreter and timeout settings without reading dotenv", async () => {
    await mkdir(resolve(root, "packages/zhihu"), { recursive: true });
    await writeFile(resolve(root, "packages/zhihu/.env"), "ZHIHU_TIMEOUT_MS=1\nSECRET=private-dotenv-canary\n");
    let config: ZhihuProviderConfig | undefined;
    const code = await runResearchZhihu(["--question", question, "--live"], {
      ...context(), env: { ZHIHU_PYTHON_BIN: process.execPath, ZHIHU_PYTHON_CWD: root, ZHIHU_TIMEOUT_MS: "12345" },
      createProvider: value => { config = value; return { researchOne: async input => result(input) }; },
    });
    expect(code).toBe(0);
    expect(config).toMatchObject({ pythonBin: process.execPath, pythonCwd: root, timeoutMs: 12345 });
    expect(config!.env).not.toHaveProperty("SECRET");
    expect(output.join(" ")).not.toContain("private-dotenv-canary");
  });

  it("saves partial packs and unmet questions locally while reporting only counts", async () => {
    const code = await runResearchZhihu(["--question", question, "--live"], {
      ...context(), createProvider: () => ({ researchOne: async input => result(input, true) }),
    });
    expect(code).toBe(0);
    const status = JSON.parse(output[0]!);
    expect(status).toMatchObject({ status: "partial", stage: "complete", evidenceCount: 0, unresolvedQuestionCount: 1, issueCount: 1 });
    expect(status.metrics).toMatchObject({ batch_invalid_item_count: 2, batch_valid_output_count: 1 });
    expect(status.metrics).not.toHaveProperty("batch_invalid_group_count");
    const saved = await readJson(resolve(status.outputDir, "result.json"));
    expect(saved.result.status).toBe("partial");
    expect(saved.result.pack.unresolvedQuestions).toHaveLength(1);
    expect(output.join(" ")).not.toMatch(/private|sourceId|runId/u);
  });

  it.each([
    ["research_failed", { search_calls_attempted: 1, model_calls_attempted: 0 }, "search_failed", "search"],
    ["compilation_failed", { search_calls_attempted: 1, model_calls_attempted: 1 }, "compilation_failed", "compile"],
    ["configuration_error", { search_calls_attempted: 1, batch_model_calls_attempted: 1 }, "compilation_failed", "compile"],
  ] as const)("preserves %s and classifies its failed stage without retrying", async (upstreamCode, metrics, status, stage) => {
    let attempts = 0;
    const failure = new ZhihuProviderError("process_failed");
    failure.upstreamCode = upstreamCode;
    failure.metrics = { ...metrics, "private-counter": 99, batch_invalid_item_count: 2,
      batch_valid_output_count: 0, batch_invalid_group_count: true as unknown as number };
    failure.message = "Authorization: private-api-key; private source text";
    const code = await runResearchZhihu(["--question", question, "--live"], {
      ...context(), createProvider: () => ({ researchOne: async () => { attempts++; throw failure; } }),
    });
    expect(code).toBe(1);
    expect(attempts).toBe(1);
    const reported = JSON.parse(output[0]!);
    expect(reported).toMatchObject({ ok: false, status, stage, code: "process_failed", upstreamCode });
    expect(reported.metrics).toMatchObject({ batch_invalid_item_count: 2, batch_valid_output_count: 0 });
    expect(reported.metrics).not.toHaveProperty("batch_invalid_group_count");
    expect(await readJson(resolve(reported.outputDir, "status.json"))).toEqual(reported);
    expect(output.join(" ")).not.toMatch(/private|Authorization/u);
    expect(await readdir(reported.outputDir)).toEqual(["request.json", "status.json"]);
  });

  it("redacts unexpected exceptions and unknown diagnostic values", async () => {
    const failure = new ZhihuProviderError("process_failed");
    failure.upstreamCode = "private-key-canary";
    failure.metrics = { search_calls_attempted: -1, model_calls_attempted: NaN, "private-count": 1 };
    for (const error of [failure, new Error("private-provider-detail")]) {
      expect(await runResearchZhihu(["--question", question, "--live"], {
        ...context(), createProvider: () => ({ researchOne: async () => { throw error; } }),
      })).toBe(1);
    }
    expect(output.join(" ")).not.toMatch(/private|NaN|upstreamCode/u);
  });

  it.each([[], ["--question"], ["--question", ""], ["--question", "  "], ["--question", question, "--wat"],
    ["--question", question, "--question", question], ["--question", question, "--live", "--live"],
    ["--question", "--live"], ["--question", question, "private-positional"]].map(args => ({ args })))
    ("rejects invalid arguments $args without creating a Provider or artifacts", async ({ args }) => {
    const code = await runResearchZhihu(args, { ...context(), createProvider: () => { throw new Error("private-provider-created"); } });
    expect(code).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ ok: false, status: "invalid_arguments", stage: "input" });
    expect(await readdir(root)).toEqual([]);
    expect(output.join(" ")).not.toMatch(/private|环中国/u);
  });

  it("never overwrites an existing artifact and uses a new request ID for each run", async () => {
    const previous = resolve(root, "packages/zhihu/artifacts/research-zhihu-existing");
    await mkdir(previous, { recursive: true });
    await writeFile(resolve(previous, "result.json"), "keep-existing-result");
    for (let i = 0; i < 2; i++) expect(await runResearchZhihu(["--question", question], context())).toBe(0);
    const statuses = output.map(line => JSON.parse(line));
    expect(statuses[0].requestId).not.toBe(statuses[1].requestId);
    expect(statuses[0].outputDir).not.toBe(statuses[1].outputDir);
    expect(await readFile(resolve(previous, "result.json"), "utf8")).toBe("keep-existing-result");
    expect(await readdir(resolve(root, "packages/zhihu/artifacts"))).toHaveLength(3);
  });
});
