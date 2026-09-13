/** Local evidence inspection. Network/model use requires an explicit --live. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateResearchInput, type M2ResearchInput } from "../src/zhihu-boundary";
import { createZhihuProvider, readZhihuProviderConfig, ZhihuProviderError,
  type ZhihuProvider, type ZhihuProviderConfig } from "../src/zhihu-provider";

interface ResearchCliDependencies {
  root?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  createProvider?: (config: ZhihuProviderConfig) => Pick<ZhihuProvider, "researchOne">;
}

const budgetEnv = {
  ZHIHU_RETRIEVAL_PROFILE: "batch-v1",
  ZHIHU_SEARCH_LIMIT_PER_QUERY: "10",
  ZHIHU_COMPILER_MAX_CALLS: "1",
  ZHIHU_RESEARCH_DEADLINE_SECONDS: "600",
  ZHIHU_EVIDENCE_CACHE_ENABLED: "false",
  ZHIHU_EVIDENCE_CACHE_ONLY: "false",
};
const counterNames = ["planner_calls_attempted", "search_calls_attempted", "compiler_calls_attempted",
  "batch_model_calls_attempted", "model_calls_attempted", "candidate_count", "evidence_count",
  "batch_invalid_item_count", "batch_valid_output_count", "batch_invalid_group_count",
  "cache_hit", "saved_search_calls", "saved_model_calls", "search_duration_ms", "batch_duration_ms", "total_duration_ms"];
const upstreamCodes = new Set(["invalid_arguments", "invalid_json", "input_too_large", "input_io_error",
  "invalid_request", "dependency_unavailable", "invalid_plan_output", "llm_error", "execution_error",
  "output_io_error", "interrupted", "research_failed", "compilation_failed", "configuration_error",
  "authentication_failed", "rate_or_quota_limit", "evidence_id_conflict", "research_timeout"]);

function safeMetrics(value: Record<string, number> = {}): Record<string, number> {
  return Object.fromEntries(counterNames.flatMap(key => {
    const count = value[key];
    return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? [[key, count]] : [];
  }));
}

function parseInput(argv: string[]): { live: boolean; input: M2ResearchInput } {
  let question: string | undefined;
  let live = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--live" && !live) live = true;
    else if (argv[index] === "--question" && question === undefined) {
      question = argv[++index]?.trim();
      if (!question || question.startsWith("--")) throw new Error("invalid_arguments");
    } else throw new Error("invalid_arguments");
  }
  if (!question) throw new Error("invalid_arguments");
  return { live, input: validateResearchInput({ goal: question, user_context: {}, request: {
    id: `research-${randomUUID()}`, question, searchQueries: [question], relevantUserConditions: [], evidenceLimit: 5,
  } }) };
}

function safeFailure(error: unknown) {
  if (!(error instanceof ZhihuProviderError)) return { ok: false, status: "provider_failed", stage: "provider", code: "unexpected_error" };
  const metrics = safeMetrics(error.metrics);
  const upstreamCode = error.upstreamCode && upstreamCodes.has(error.upstreamCode) ? error.upstreamCode : undefined;
  const compiling = upstreamCode === "compilation_failed" || (metrics.compiler_calls_attempted ?? 0) > 0 ||
    (metrics.batch_model_calls_attempted ?? 0) > 0 || (metrics.model_calls_attempted ?? 0) > 0;
  const searching = upstreamCode === "research_failed" || (metrics.search_calls_attempted ?? 0) > 0;
  const stage = compiling ? "compile" : searching ? "search" : "provider";
  return { ok: false, status: compiling ? "compilation_failed" : searching ? "search_failed" : "provider_failed",
    stage, code: error.code, ...(upstreamCode ? { upstreamCode } : {}), metrics,
    ...(error.cleanupError === "cleanup_failed" ? { cleanupError: error.cleanupError } : {}) };
}

async function writeJson(directory: string, name: string, value: unknown): Promise<void> {
  // Each run owns a newly created directory; exclusive writes also prevent replacement.
  await writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

export async function runResearchZhihu(argv: string[], dependencies: ResearchCliDependencies = {}): Promise<number> {
  const log = dependencies.log ?? console.log;
  let parsed: ReturnType<typeof parseInput>;
  try { parsed = parseInput(argv); }
  catch {
    log(JSON.stringify({ ok: false, status: "invalid_arguments", stage: "input", code: "invalid_arguments" }));
    return 1;
  }
  const { input, live } = parsed;
  const root = dependencies.root ?? resolve(import.meta.dirname, "../../..");
  let outputDir: string | undefined;
  try {
    const parent = resolve(root, "packages/zhihu/artifacts");
    await mkdir(parent, { recursive: true });
    outputDir = await mkdtemp(resolve(parent, "research-zhihu-"));
    await writeJson(outputDir, "request.json", input);
    const metadata = { mode: live ? "live" : "dry_run", requestId: input.request.id,
      searchQueryCount: input.request.searchQueries.length, evidenceLimit: input.request.evidenceLimit,
      retrievalProfile: "batch-v1", searchResultLimit: 10, modelCallLimit: 1, cacheEnabled: false, outputDir };
    let status: Record<string, unknown>;
    let exitCode = 0;
    if (!live) {
      status = { ...metadata, ok: true, status: "dry_run", stage: "input",
        metrics: { planner_calls_attempted: 0, search_calls_attempted: 0, compiler_calls_attempted: 0,
          batch_model_calls_attempted: 0, model_calls_attempted: 0 } };
    } else {
      let result;
      try {
        const env = dependencies.env ?? process.env;
        const config = readZhihuProviderConfig({ ...env,
          ZHIHU_PYTHON_BIN: env.ZHIHU_PYTHON_BIN ?? resolve(root, ".venv/Scripts/python.exe"),
          ZHIHU_PYTHON_CWD: env.ZHIHU_PYTHON_CWD ?? resolve(root, "packages/zhihu"),
        });
        // Node never reads .env. Python loads its own environment with these hard limits.
        const provider = (dependencies.createProvider ?? createZhihuProvider)({ ...config, env: budgetEnv });
        result = await provider.researchOne(input);
        status = { ...metadata, ok: true, status: result.status, stage: "complete",
          evidenceCount: result.pack.evidence.length, routeCandidateCount: result.pack.routeCandidates.length,
          unresolvedQuestionCount: result.pack.unresolvedQuestions.length, issueCount: result.issues.length,
          coverageGapCount: result.pack.coverage?.gaps.length ?? 0, metrics: safeMetrics(result.metrics) };
      } catch (error) {
        status = { ...metadata, ...safeFailure(error) };
        exitCode = 1;
      }
      // The production Provider has already validated and adapted this EvidencePack.
      // Source content, unresolved questions, issues and upstream run ID stay local.
      if (result) await writeJson(outputDir, "result.json", { ok: true, result });
    }
    await writeJson(outputDir, "status.json", status);
    log(JSON.stringify(status));
    return exitCode;
  } catch {
    log(JSON.stringify({ ok: false, status: "local_io_error", stage: "local_io", code: "local_io_error",
      requestId: input.request.id, ...(outputDir ? { outputDir } : {}) }));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runResearchZhihu(process.argv.slice(2));
}
