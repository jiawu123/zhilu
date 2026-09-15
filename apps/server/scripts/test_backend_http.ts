/** Local HTTP regression against the real server. Network research requires --live. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { BaselineProposal, CreateProjectInput, PatchProposal, PlanCommit, PlanState } from "@zhilu/contracts";
import type { PendingChange } from "../src/repository";
import type { ResearchProviderResult } from "../src/zhihu-boundary";

interface Snapshot {
  plan: PlanState;
  history: PlanCommit[];
  pending: PendingChange[];
  baselineProposals: BaselineProposal[];
}
interface Step { name: string; passed: boolean; httpStatus?: number }
interface Report {
  ok: boolean;
  mode: "offline" | "live";
  startedAt: string;
  finishedAt?: string;
  projectId?: string;
  currentCommitId?: string;
  failureCode?: string;
  dataRoot: string;
  steps: Step[];
  live: {
    requested: boolean;
    status: "not_run" | "disabled" | "ok" | "partial" | "no_evidence" | "failed";
    httpStatus?: number;
    failureCode?: string;
    cleanupError?: "cleanup_failed";
    stateUnchanged?: boolean;
    evidenceCount?: number;
    issueCount?: number;
    metrics?: Record<string, number>;
    limits: { requests: number; queries: number; evidence: number; compilerCalls: number; searchCountPerQuery: number; deadlineSeconds: number };
  };
}
class SmokeFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
const metricNames = ["planner_calls_attempted", "search_calls_attempted", "compiler_calls_attempted", "candidate_count", "evidence_count", "raw_item_count", "valid_occurrence_count", "variant_count"] as const;
const providerCodes = new Set(["invalid_configuration", "startup_failed", "stdin_failed", "process_failed", "invalid_response", "timeout", "output_limit", "cleanup_failed"]);

function check(value: unknown, code: string): asserts value {
  if (!value) throw new SmokeFailure(code);
}
function formalState(snapshot: Snapshot): Snapshot {
  return { plan: snapshot.plan, history: snapshot.history, pending: snapshot.pending, baselineProposals: snapshot.baselineProposals };
}
function safeMetrics(metrics: Record<string, number>): Record<string, number> {
  return Object.fromEntries(metricNames.flatMap(name => {
    const value = metrics[name];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? [[name, value]] : [];
  }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    console.log("Usage: node node_modules/tsx/dist/cli.mjs apps/server/scripts/test_backend_http.ts [--live]\nDefault: offline local HTTP checks; no Python, model, or Zhihu call.\n--live: one real evidence request (may incur charges); uses existing ZHIHU_PYTHON_BIN / ZHIHU_PYTHON_CWD.\nResults and isolated data remain in packages/zhihu/artifacts/local-backend-http-<UUID>/.\nThe server only listens on 127.0.0.1 with an automatically allocated port.");
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--live")) {
    console.error(JSON.stringify({ ok: false, code: "invalid_arguments", usage: "test_backend_http.ts [--live|--help]" }));
    process.exitCode = 1;
    return;
  }

  const live = args[0] === "--live";
  const root = resolve(import.meta.dirname, "../../..");
  const outputDir = resolve(root, "packages/zhihu/artifacts", `local-backend-http-${randomUUID()}`);
  const dataRoot = resolve(outputDir, "data");
  const reportPath = resolve(outputDir, "report.json");
  const report: Report = {
    ok: false, mode: live ? "live" : "offline", startedAt: new Date().toISOString(), dataRoot, steps: [],
    live: { requested: live, status: "not_run", limits: { requests: 1, queries: 2, evidence: 2, compilerCalls: 3, searchCountPerQuery: 5, deadlineSeconds: 600 } },
  };
  let server: Server | undefined;
  let origin = "";
  const originalConsoleError = console.error;
  // Server's generic error logger can contain paths or upstream text. Only our safe report is emitted.
  console.error = () => undefined;
  const originalEnv = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string) => { originalEnv.set(key, process.env[key]); process.env[key] = value; };
  const save = (name: string, value: unknown) => writeFile(resolve(outputDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  const verify = (name: string, condition: unknown) => {
    report.steps.push({ name, passed: Boolean(condition) });
    check(condition, name);
  };
  async function request(name: string, path: string, expected: number | null, body?: unknown, timeoutMs = 10_000): Promise<Response> {
    const step: Step = { name, passed: false };
    report.steps.push(step);
    const response = await fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    });
    step.httpStatus = response.status;
    step.passed = expected === null || response.status === expected;
    check(step.passed, "unexpected_http_status");
    return response;
  }
  async function json<T>(name: string, path: string, expected: number, body?: unknown): Promise<T> {
    return (await request(name, path, expected, body)).json() as Promise<T>;
  }
  try {
    await mkdir(dataRoot, { recursive: true });
    // Must precede dynamic index import: importing production index normally starts a listener.
    setEnv("NODE_ENV", "test");
    setEnv("ZHILU_DATA_DIR", dataRoot);
    if (live) {
      setEnv("ZHIHU_COMPILER_MAX_CALLS", "3");
      setEnv("ZHIHU_SEARCH_LIMIT_PER_QUERY", "5");
      setEnv("ZHIHU_RESEARCH_DEADLINE_SECONDS", "600");
    }
    const { createZhiluServer } = await import("../src/index");
    const { PlanRepository } = await import("../src/repository");
    const { confirmedPlan } = await import("../src/fixtures/live-plan");
    const { validateProjectCreationInput } = await import("@zhilu/agent-runtime");
    const { validatePlan } = await import("@zhilu/plan-engine");
    const { validateResearchInput } = await import("../src/zhihu-boundary");
    const { buildM2Context } = await import("../src/m2-context");
    const { strFromU8, unzipSync } = await import("fflate");
    const repository = new PlanRepository(dataRoot, resolve(root, "examples/agent-engineer/plan-state.json"));
    // Explicit false keeps offline safe even if the shell already enabled ZHIHU_LIVE_ENABLED.
    server = createZhiluServer(repository, { liveEnabled: live });
    await new Promise<void>((ready, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => { server!.off("error", reject); ready(); });
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const health = await json<{ ok: boolean }>("health", "/api/health", 200);
    verify("health_payload", health.ok === true);

    const fixture = confirmedPlan();
    check(fixture.userContext && fixture.goalContract, "fixture_context_missing");
    const input: CreateProjectInput = {
      userContext: structuredClone(fixture.userContext),
      goalContract: { ...structuredClone(fixture.goalContract), targetDate: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10) },
      adaptiveQuestion: "时间不足时优先保留什么？", adaptiveAnswer: "保留可运行项目和基本自动化测试。",
    };
    verify("creation_input_valid", validateProjectCreationInput(input, new Date().toISOString().slice(0, 10)).valid);
    const created = await json<Snapshot & { projectId: string }>("create_project", "/api/projects", 201, input);
    check(/^project-[A-Za-z0-9-]+$/.test(created.projectId), "project_id_invalid");
    report.projectId = created.projectId;
    const projectPath = `/api/projects/${encodeURIComponent(created.projectId)}`;
    const snapshot = (name: string) => json<Snapshot>(name, projectPath, 200);
    const initial = await snapshot("read_created_project");
    verify("created_state_persisted", isDeepStrictEqual(formalState(created), formalState(initial))
      && initial.plan.version === 1 && initial.history.length === 1 && initial.pending.length === 0 && initial.baselineProposals.length === 0);
    verify("created_plan_valid", validatePlan(initial.plan).valid);

    const proposal = await json<BaselineProposal>("mock_research", `${projectPath}/research/mock`, 202, {});
    verify("mock_mode_explicit", proposal.researchRun.mode === "mock" && proposal.researchRun.routeCandidates.length >= 2);
    const beforeLive = await snapshot("snapshot_before_live");
    verify("mock_proposal_pending", isDeepStrictEqual(beforeLive.plan, initial.plan)
      && isDeepStrictEqual(beforeLive.history, initial.history) && isDeepStrictEqual(beforeLive.pending, initial.pending)
      && beforeLive.baselineProposals.length === 1 && beforeLive.baselineProposals[0]?.id === proposal.id);
    await save("before-live.json", formalState(beforeLive));
    const example = validateResearchInput(JSON.parse(await readFile(resolve(root, "packages/zhihu/examples/entry_research_request.json"), "utf8")));
    const researchRequest = { ...example.request, id: `rq-http-${randomUUID()}`, searchQueries: example.request.searchQueries.slice(0, 2), evidenceLimit: 2 };
    validateResearchInput({ ...buildM2Context(beforeLive.plan), request: researchRequest });
    try {
      const response = await request("live_evidence_http", `${projectPath}/research/live/evidence`, null, { request: researchRequest }, live ? 650_000 : 10_000);
      report.live.httpStatus = response.status;
      if (!live) {
        await response.arrayBuffer();
        verify("live_disabled_by_default", response.status === 503);
        report.live.status = "disabled";
      } else {
        const body = await response.json() as { ok?: boolean; result?: ResearchProviderResult; code?: unknown; cleanupError?: unknown };
        if (response.status !== 200) {
          report.live.status = "failed";
          report.live.failureCode = typeof body.code === "string" && providerCodes.has(body.code) ? body.code : "live_http_error";
          if (body.cleanupError === "cleanup_failed") report.live.cleanupError = "cleanup_failed";
          throw new SmokeFailure("live_http_error");
        }
        const result = body.result;
        verify("live_result_valid", body.ok === true && result && ["ok", "partial", "no_evidence"].includes(result.status)
          && result.pack.requestId === researchRequest.id && result.pack.evidence.length <= 2);
        check(result, "live_result_missing");
        report.live.status = result.status;
        report.live.evidenceCount = result.pack.evidence.length;
        report.live.issueCount = result.issues.length;
        report.live.metrics = safeMetrics(result.metrics);
        verify("live_call_limits", (result.metrics.search_calls_attempted ?? Infinity) <= 2
          && (result.metrics.compiler_calls_attempted ?? Infinity) <= 3 && (result.metrics.planner_calls_attempted ?? 0) === 0);
        // Validated evidence is saved only to the local artifact, never written to terminal or Plan.
        await save("live-evidence.json", { ok: true, result });
      }
    } catch (error) {
      report.live.status = "failed";
      report.live.failureCode ??= error instanceof SmokeFailure ? error.code : "live_request_or_response_failed";
      throw error;
    } finally {
      // Runs for HTTP errors and timeouts too; an existing Mock proposal is part of the comparison.
      const afterLive = await snapshot("snapshot_after_live");
      await save("after-live.json", formalState(afterLive));
      report.live.stateUnchanged = isDeepStrictEqual(formalState(beforeLive), formalState(afterLive));
      verify("live_preserves_all_formal_state", report.live.stateUnchanged);
    }

    const routeId = proposal.recommendedRouteId;
    verify("baseline_route_exists", proposal.researchRun.routeCandidates.some(route => route.id === routeId));
    const baseline = await json<Snapshot>("apply_mock_baseline", `${projectPath}/baseline/apply`, 200, { proposalId: proposal.id, routeId });
    verify("baseline_commit_applied", baseline.plan.version === 2 && baseline.plan.currentCommitId === "000002"
      && baseline.plan.research?.mode === "mock" && baseline.plan.research.selectedRouteId === routeId
      && baseline.history.length === 2 && baseline.baselineProposals.length === 0
      && !baseline.plan.evidence.some(item => item.sourceType === "zhihu"));
    const event = await json<{ patch: PatchProposal; afterPreview: PlanState; workflow: { shouldResearch: boolean } }>("constraint_event", `${projectPath}/events`, 202, {
      type: "constraint_changed", title: "本地测试时间变化", description: "每周投入调整为 6 小时", targetNodeIds: [], changes: { weeklyHours: 6 }, confirmed: true,
    });
    verify("event_preview_only", event.workflow.shouldResearch === false && event.afterPreview.weeklyHours === 6);
    const diff = await json<{ pending: PendingChange[] }>("read_pending_diff", `${projectPath}/diff`, 200);
    verify("diff_matches_event", diff.pending.length === 1 && diff.pending[0]?.patch.id === event.patch.id);
    const beforeApply = await snapshot("snapshot_before_diff_apply");
    verify("event_preserves_formal_plan", isDeepStrictEqual(beforeApply.plan, baseline.plan) && isDeepStrictEqual(beforeApply.history, baseline.history));
    await json("apply_diff", `${projectPath}/diff/apply`, 200, { patchId: event.patch.id });
    const final = await snapshot("read_final_project");
    verify("final_commit_valid", final.plan.version === 3 && final.plan.currentCommitId === "000003" && final.plan.weeklyHours === 6
      && final.history.length === 3 && final.pending.length === 0 && final.baselineProposals.length === 0 && validatePlan(final.plan).valid);
    const persisted = JSON.parse(await readFile(resolve(dataRoot, created.projectId, ".plan/plan.json"), "utf8"));
    verify("final_plan_persisted", isDeepStrictEqual(persisted, final.plan));
    report.currentCommitId = final.plan.currentCommitId;
    const evidence = await json<{ evidence: PlanState["evidence"] }>("read_evidence", `${projectPath}/evidence`, 200);
    verify("evidence_matches_plan", isDeepStrictEqual(evidence.evidence, final.plan.evidence));

    const jsonExport = await request("export_json", `${projectPath}/export/json`, 200);
    const jsonText = await jsonExport.text();
    verify("json_export_current_commit", isDeepStrictEqual(JSON.parse(jsonText), final.plan) && jsonExport.headers.get("content-disposition")?.includes(".json"));
    await writeFile(resolve(outputDir, "plan.json"), jsonText, "utf8");
    const markdownExport = await request("export_markdown", `${projectPath}/export/markdown`, 200);
    const markdown = await markdownExport.text();
    verify("markdown_export_current_commit", markdown.includes(`当前版本：${final.plan.currentCommitId}`) && markdown.includes("## Roadmap") && markdown.includes("## Evidence"));
    await writeFile(resolve(outputDir, "plan.md"), markdown, "utf8");
    const zipExport = await request("export_zip", `${projectPath}/export/zip`, 200);
    const zipBytes = new Uint8Array(await zipExport.arrayBuffer());
    const archive = unzipSync(zipBytes);
    const readArchiveJson = (name: string): unknown => { const bytes = archive[name]; check(bytes, "zip_entry_missing"); return JSON.parse(strFromU8(bytes)); };
    const manifest = readArchiveJson("manifest.json") as { projectId: string; currentCommitId: string };
    verify("zip_export_current_commit", zipExport.headers.get("content-type") === "application/zip"
      && manifest.projectId === created.projectId && manifest.currentCommitId === final.plan.currentCommitId
      && isDeepStrictEqual(readArchiveJson(".plan/plan.json"), final.plan)
      && strFromU8(archive["README.md"] ?? new Uint8Array()).includes(`当前版本：${final.plan.currentCommitId}`)
      && final.history.every(commit => isDeepStrictEqual(readArchiveJson(`.plan/commits/${commit.id}.json`), commit)));
    await writeFile(resolve(outputDir, "plan.planbundle.zip"), zipBytes);
    await save("final-snapshot.json", formalState(final));
    report.ok = true;
  } catch (error) {
    report.failureCode = error instanceof SmokeFailure ? error.code : "local_runtime_or_io_error";
    process.exitCode = 1;
  } finally {
    if (server?.listening) {
      try {
        await new Promise<void>((done, reject) => {
          server!.close(error => error ? reject(error) : done());
          server!.closeAllConnections();
        });
      } catch {
        report.ok = false; report.failureCode = "server_close_failed"; process.exitCode = 1;
      }
    }
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    console.error = originalConsoleError;
    report.finishedAt = new Date().toISOString();
    try { await save("report.json", report); }
    catch { report.ok = false; report.failureCode = "report_write_failed"; process.exitCode = 1; }
    console.log(JSON.stringify({ ok: report.ok, mode: report.mode, ...(report.failureCode ? { failureCode: report.failureCode } : {}),
      passedSteps: report.steps.filter(step => step.passed).length, totalSteps: report.steps.length, live: report.live,
      ...(report.currentCommitId ? { currentCommitId: report.currentCommitId } : {}), reportPath, dataRoot }, null, 2));
  }
}

await main().catch(() => {
  console.error(JSON.stringify({ ok: false, code: "http_smoke_startup_failed" }));
  process.exitCode = 1;
});
