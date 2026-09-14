import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { compileRoadmapperBaseline, prepareRoadmapperInput, type RoadmapperInput } from "@zhilu/agent-runtime";
import { roadmapperDraftFixture } from "../../../packages/agent-runtime/src/roadmapper.test-fixture";
import { syntheticM3Snapshot } from "./fixtures/m3-replay";
import { createZhiluServer } from "./index";
import { PlanRepository } from "./repository";
import { OperationTracker, reportProgress } from "./operation-progress";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("request activity", () => {
  it("isolates concurrent requests and account owners", async () => {
    const tracker = new OperationTracker(), holdA = deferred<void>(), holdB = deferred<void>();
    const a = tracker.run("alice", "a", async () => { reportProgress("A generating"); await holdA.promise; reportProgress("A checking"); }, () => true);
    const b = tracker.run("bob", "b", async () => { reportProgress("B generating"); await holdB.promise; }, () => false);
    expect(tracker.get("bob", "a")).toBeUndefined();
    expect(tracker.get("alice", "a")?.steps.at(-1)?.message).toBe("A generating");
    holdA.resolve(); await a;
    expect(tracker.get("alice", "a")?.status).toBe("complete");
    expect(tracker.get("bob", "b")?.steps.at(-1)?.message).toBe("B generating");
    holdB.resolve(); await b;
    expect(tracker.get("bob", "b")?.status).toBe("failed");
  });

  it("serves real revision and correction stages while the original HTTP call is pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "zhilu-progress-"));
    const repository = new PlanRepository(root, "unused");
    const { plan, research } = syntheticM3Snapshot(new Date().toISOString());
    const input = prepareRoadmapperInput(plan, research, "initial-model");
    const proposal = compileRoadmapperBaseline(plan, research, input, roadmapperDraftFixture(input));
    await repository.savePlan(plan); await repository.saveBaselineProposal(plan.projectId, proposal);
    const calls = [deferred<RoadmapperInput>(), deferred<RoadmapperInput>()];
    const results = [deferred<unknown>(), deferred<unknown>()];
    let count = 0;
    const server = createZhiluServer(repository, { roadmapperProvider: { generate: async value => {
      const index = count++; calls[index]!.resolve(value as RoadmapperInput); return results[index]!.promise;
    } } });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, id = crypto.randomUUID();
    const url = `${origin}/api/projects/${plan.projectId}/baseline/revise`;
    const init = { method: "POST", headers: { "Content-Type": "application/json", "X-Zhilu-Operation-Id": id },
      body: JSON.stringify({ proposalId: proposal.id, routeId: proposal.recommendedRouteId, message: "PRIVATE_USER_REQUEST" }) };
    const pending = fetch(url, init);
    const first = await calls[0]!.promise;
    const stage1 = await (await fetch(`${origin}/api/operations/${id}`)).json();
    expect(stage1.status).toBe("running");
    expect(stage1.steps.at(-1).message).toContain("修改计划草稿");
    expect(JSON.stringify(stage1)).not.toContain("PRIVATE_USER_REQUEST");
    expect((await fetch(url, init)).status).toBe(409);
    const invalid = roadmapperDraftFixture(first); invalid.routes[0]!.tasks[0]!.milestoneId = "m2";
    results[0]!.resolve(invalid);
    const second = await calls[1]!.promise;
    const stage2 = await (await fetch(`${origin}/api/operations/${id}`)).json();
    expect(stage2.startedAt).toBe(stage1.startedAt);
    expect(stage2.steps.at(-1).message).toContain("第 2 次，最后一次");
    results[1]!.resolve(roadmapperDraftFixture(second));
    expect((await pending).status).toBe(200);
    const final = await (await fetch(`${origin}/api/operations/${id}`)).json();
    expect(final.status).toBe("complete");
    expect(final.steps.at(-1).message).toContain("保存调整后的草稿");
    expect(count).toBe(2);
    expect(await repository.getPlan(plan.projectId)).toEqual(plan);
    const next = (await repository.getBaselineProposals(plan.projectId))[0]!;
    const applied = await fetch(`${origin}/api/projects/${plan.projectId}/baseline/apply`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proposalId: next.id, routeId: next.recommendedRouteId }) });
    expect(applied.status).toBe(200);
    expect(count).toBe(2);
  });
});
