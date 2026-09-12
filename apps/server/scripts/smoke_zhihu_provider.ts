/** Explicit live-only smoke: no automatic test invokes this script with --live. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createZhihuProvider, readZhihuProviderConfig, ZhihuProviderError } from "../src/zhihu-provider";
import { validateResearchInput } from "../src/zhihu-boundary";

async function main(): Promise<void> {
  if (process.argv.slice(2).join(" ") !== "--live") {
    console.log("显式联调：pnpm --filter @zhilu/server smoke:zhihu --live（最多1请求、2搜索、3编译、0 Planner）。先配置 ZHIHU_PYTHON_BIN / ZHIHU_PYTHON_CWD。未执行网络调用。");
    return;
  }
  const root = resolve(import.meta.dirname, "../../..");
  const outputDir = resolve(root, "packages/zhihu/artifacts");
  const outputPath = resolve(outputDir, `p0-provider-smoke-${randomUUID()}.json`);
  await mkdir(outputDir, { recursive: true });
  try {
    const input = validateResearchInput(JSON.parse(await readFile(resolve(root, "packages/zhihu/examples/entry_research_request.json"), "utf8")));
    input.request.searchQueries = input.request.searchQueries.slice(0, 2);
    input.request.evidenceLimit = Math.min(input.request.evidenceLimit, 2);
    const provider = createZhihuProvider({ ...readZhihuProviderConfig(), env: {
      ZHIHU_COMPILER_MAX_CALLS: "3", ZHIHU_SEARCH_LIMIT_PER_QUERY: "5", ZHIHU_RESEARCH_DEADLINE_SECONDS: "600",
    } });
    const result = await provider.researchOne(input);
    // Full validated pack is local only. Console contains safe metadata, never source bodies.
    await writeFile(outputPath, JSON.stringify({ ok: true, result }, null, 2), "utf8");
    console.log(JSON.stringify({ ok: true, runId: result.runId, status: result.status,
      requestId: result.pack.requestId, evidenceCount: result.pack.evidence.length,
      issues: result.issues, metrics: result.metrics, outputPath }, null, 2));
  } catch (error) {
    const failure = error instanceof ZhihuProviderError ? {
      ok: false, code: error.code, upstreamCode: error.upstreamCode,
      metrics: error.metrics ?? null, cleanupError: error.cleanupError,
    } : { ok: false, code: "smoke_configuration_or_input_error", metrics: null };
    await writeFile(outputPath, JSON.stringify(failure, null, 2), "utf8");
    console.error(JSON.stringify({ ...failure, outputPath }, null, 2));
    process.exitCode = 1;
  }
}
await main().catch(() => {
  console.error(JSON.stringify({ ok: false, code: "smoke_local_io_error" }));
  process.exitCode = 1;
});
