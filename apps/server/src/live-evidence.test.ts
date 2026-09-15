import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createZhiluServer } from "./index";
import { PlanRepository } from "./repository";
import { ZhihuProviderError, type ZhihuProvider } from "./zhihu-provider";
import { confirmedPlan } from "./fixtures/live-plan";

const researchRequest = { id: "rq-offline", question: "Agent 项目怎样测试？", searchQueries: ["Agent 项目 测试"],
  relevantUserConditions: ["初学者"], evidenceLimit: 2 };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.unstubAllEnvs(); });

async function setup(options: { defaults?: boolean; enabled?: boolean; status?: "ok" | "partial" | "no_evidence"; failure?: Error; hold?: Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zhilu-live-"));
  const repository = new PlanRepository(root, resolve("examples/agent-engineer/plan-state.json"));
  const plan = confirmedPlan();
  await repository.savePlan(plan);
  // A pending artifact must survive both success and failure untouched.
  const pending = { id: "pending-sentinel", marker: "synthetic" };
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(root, plan.projectId, ".plan", "baseline-proposals"), {recursive: true});
  await writeFile(join(root, plan.projectId, ".plan", "baseline-proposals", "pending.json"), JSON.stringify(pending));
  const researchOne = vi.fn(async () => {
    if (options.hold) await options.hold;
    if (options.failure) throw options.failure;
    return {runId: "entry-offline", status: options.status ?? "no_evidence",
      pack: {requestId: researchRequest.id, evidence: [], routeCandidates: [], unresolvedQuestions: ["未找到适用证据"]},
      issues: options.status === "partial" ? [{code: "search_failed", stage: "search" as const, queryIndex: 0}] : [],
      metrics: {search_calls_attempted: 1, compiler_calls_attempted: 0, candidate_count: 0, evidence_count: 0}};
  });
  const provider = {researchOne, planForBaseline: vi.fn()} as unknown as ZhihuProvider;
  const server = createZhiluServer(repository, options.defaults ? {} : {liveEnabled: options.enabled ?? true, zhihuProvider: provider});
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(async () => { await new Promise<void>((done) => server.close(() => done())); await rm(root, {recursive: true, force: true}); });
  const snapshot = async () => ({plan: await repository.getPlan(plan.projectId), history: await repository.getHistory(plan.projectId),
    pending: await repository.getPending(plan.projectId), baseline: await repository.getBaselineProposals(plan.projectId)});
  const post = (body: unknown = {request: researchRequest}, id = plan.projectId) => fetch(`${origin}/api/projects/${id}/research/live/evidence`,
    {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
  return {root, repository, plan, researchOne, post, snapshot};
}

describe("single request live evidence HTTP", () => {
  it.each(["ok", "partial", "no_evidence"] as const)("returns %s and never mutates formal state", async (status) => {
    const t = await setup({status}); const before = await t.snapshot();
    const res = await t.post(); const body = await res.json();
    expect(res.status).toBe(200); expect(body.ok).toBe(true); expect(body.result.status).toBe(status);
    expect(body.result.pack.requestId).toBe(researchRequest.id);
    expect(t.researchOne).toHaveBeenCalledWith(expect.objectContaining({goal: "完成 Agent 项目", request: researchRequest}));
    expect(await t.snapshot()).toEqual(before);
  });
  it("disabled means 503 and zero provider calls", async () => {
    const t = await setup({enabled: false}); expect((await t.post()).status).toBe(503); expect(t.researchOne).not.toHaveBeenCalled();
  });
  it("is disabled with default configuration", async () => {
    vi.stubEnv("ZHIHU_LIVE_ENABLED", undefined);
    const t = await setup({defaults: true}); const before = await t.snapshot();
    expect((await t.post()).status).toBe(503); expect(await t.snapshot()).toEqual(before);
  });
  it("missing project is 404 without initializing demo data", async () => {
    const t = await setup();
    expect((await t.post(undefined, "agent-engineer-demo")).status).toBe(404);
    expect(await readdir(t.root)).toEqual([t.plan.projectId]); expect(t.researchOne).not.toHaveBeenCalled();
  });
  it("rejects unconfirmed context and excessive background", async () => {
    const t = await setup(); t.plan.userContext!.confirmed = false; await t.repository.savePlan(t.plan);
    expect((await t.post()).status).toBe(409);
    t.plan.userContext!.confirmed = true; t.plan.userContext!.backgroundNotes = "x".repeat(8001); await t.repository.savePlan(t.plan);
    expect((await t.post()).status).toBe(409); expect(t.researchOne).not.toHaveBeenCalled();
  });
  it.each([{request: researchRequest, goal: "override"}, {request: {...researchRequest, evidenceLimit: true}},
    {request: {...researchRequest, searchQueries: []}}, {request: researchRequest, padding: "x".repeat(64001)}])("rejects invalid body with zero calls", async (body) => {
    const t = await setup(); expect((await t.post(body)).status).toBe(400); expect(t.researchOne).not.toHaveBeenCalled();
  });
  it.each([502, 504])("preserves state and releases busy lock after %s failure", async (status) => {
    const t = await setup({failure: new ZhihuProviderError(status === 504 ? "timeout" : "process_failed")});
    const before = await t.snapshot(); expect((await t.post()).status).toBe(status); expect((await t.post()).status).toBe(status);
    expect(t.researchOne).toHaveBeenCalledTimes(2); expect(await t.snapshot()).toEqual(before);
  });
  it("unknown exceptions are sanitized", async () => {
    const t = await setup({failure: new Error("PRIVATE KEY")}); const before = await t.snapshot(); const response = await t.post();
    expect(response.status).toBe(502); expect(await response.text()).not.toContain("PRIVATE");
    expect(await t.snapshot()).toEqual(before);
  });
  it("preserves a controlled cleanup failure without hiding the original timeout", async () => {
    const failure = new ZhihuProviderError("timeout");
    failure.cleanupError = "cleanup_failed";
    const t = await setup({failure});
    const response = await t.post();
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({code: "timeout", cleanupError: "cleanup_failed"});
  });
  it("same project concurrent research is busy", async () => {
    let release!: () => void;
    const t = await setup({hold: new Promise<void>((done) => {release = done;})});
    const first = t.post();
    await vi.waitFor(() => expect(t.researchOne).toHaveBeenCalledTimes(1));
    expect((await t.post()).status).toBe(409); release(); expect((await first).status).toBe(200);
  });
  it("rejects encoded path traversal", async () => {
    const t = await setup(); expect((await t.post(undefined, "..%5Coutside")).status).toBe(400);
    expect(t.researchOne).not.toHaveBeenCalled();
  });
});
