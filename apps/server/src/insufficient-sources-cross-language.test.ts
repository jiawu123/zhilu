import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { compileRoadmapperBaseline, prepareRoadmapperInput } from "@zhilu/agent-runtime";
import { createZhihuProvider } from "./zhihu-provider";
import { confirmedPlan } from "./fixtures/live-plan";
import { roadmapperDraftFixture } from "../../../packages/agent-runtime/src/roadmapper.test-fixture";

it("passes real Python partial output through spawn, TS validation and model planning without adopting rejected claims", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const provider = createZhihuProvider({ pythonBin: process.env.ZHIHU_TEST_PYTHON_BIN ?? resolve(root, ".venv/Scripts/python.exe"),
    pythonCwd: resolve(root, "packages/zhihu"), timeoutMs: 15000 }, {
    spawn: (executable, _args, options) => spawn(executable,
      ["-B", "-X", "utf8", "-m", "tests.fixtures.insufficient_sources_boundary_offline", "--provider"],
      { ...options, env: { ...options.env, PYTHON_DOTENV_DISABLED: "1", DEEPSEEK_API_KEY: "", ZHIHU_ACCESS_SECRET: "" } }),
  });
  const request = { id: "external-insufficient-rq-🧪", question: "演唱会如何购票？", searchQueries: ["演唱会 官方 购票"],
    relevantUserConditions: [], evidenceLimit: 8 };
  const result = await provider.researchOne({ goal: "安排一次东京演唱会行程。", user_context: {}, request });
  expect(result).toMatchObject({ status: "partial", pack: { requestId: request.id, evidence: [], coverage: { evidenceCount: 0 } },
    metrics: { search_calls_attempted: 1, batch_model_calls_attempted: 1, compiler_calls_attempted: 0 } });
  expect(result.pack.insufficientSources?.map(post => post.reasonCode)).toEqual(["no_evidence", "compiler_rejected"]);
  expect(result.pack.insufficientSources![0]!.source.snippet).toBe("😀原始帖子第一行。\r\n这里没有该场演唱会的明确售票信息。");
  expect(JSON.stringify(result)).not.toContain("虚构引文");
  expect(JSON.stringify(result)).not.toContain("被拒绝模型主张");
  const plan = confirmedPlan(), before = structuredClone(plan);
  const research = { runId: result.runId, proposalId: "offline-proposal", requests: [request],
    questions: [{ question: request.question, searchQueries: request.searchQueries, rationale: "核实购票条件" }],
    evidencePacks: [result.pack], now: "2026-09-13T00:00:00Z" };
  const input = prepareRoadmapperInput(plan, research, "offline-model-run");
  expect(input.context.evidenceStatus).toBe("insufficient");
  expect(input.context.evidence).toEqual([]);
  expect(JSON.stringify(input)).not.toContain(result.pack.insufficientSources![0]!.source.snippet);
  const proposal = compileRoadmapperBaseline(plan, research, input, roadmapperDraftFixture(input));
  expect(proposal.roadmapper).toMatchObject({ mode: "model", evidenceStatus: "insufficient" });
  expect(proposal.previews).toHaveLength(1);
  expect(proposal.previews[0]!.plan.research?.insufficientSources).toEqual(result.pack.insufficientSources);
  expect(plan).toEqual(before);
}, 20000);
