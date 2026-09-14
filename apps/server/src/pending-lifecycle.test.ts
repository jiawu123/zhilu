import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanState } from "@zhilu/contracts";
import { createMockBaselineProposal } from "@zhilu/agent-runtime";
import { createCommit } from "@zhilu/plan-engine";
import { createZhiluServer } from "./index";
import { PlanRepository, type PendingChange } from "./repository";
import { confirmedPlan } from "./fixtures/live-plan";

describe("pending proposal restoration", () => {
  let dataRoot: string, origin: string, repository: PlanRepository, server: ReturnType<typeof createZhiluServer>;
  const generate = vi.fn(), planForBaseline = vi.fn(), researchOne = vi.fn();
  const plan: PlanState = { ...confirmedPlan(), projectId: "pending-test", weeklyHours: 40,
    evidence: [{ id: "e-user-goal", title: "用户确认目标", summary: "完成 Agent 项目", sourceType: "user", contentType: "user_fact",
      verificationStatus: "verified", applicableWhen: [], caveats: [], riskTags: [], adoptionReason: "测试用户确认目标" }],
    nodes: [{ id: "t1", type: "task", title: "整理素材", status: "todo", startDate: "2026-09-14", endDate: "2026-09-20",
      estimatedHours: 2, evidenceIds: [], manualFields: [] }] };
  beforeEach(async () => {
    vi.clearAllMocks();
    dataRoot = await mkdtemp(join(tmpdir(), "zhilu-pending-"));
    repository = new PlanRepository(dataRoot, "unused");
    await repository.savePlan(plan);
    await repository.saveCommit(plan.projectId, createCommit(null, plan, { id: plan.currentCommitId,
      createdAt: plan.updatedAt, actor: "user", reason: "测试基线" }));
    server = createZhiluServer(repository, { liveEnabled: true, roadmapperProvider: { generate }, zhihuProvider: { planForBaseline, researchOne } });
    await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", ready); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${plan.projectId}`;
  });
  afterEach(async () => {
    if (server?.listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    const target = resolve(dataRoot), temporaryRoot = resolve(tmpdir());
    if (!target.startsWith(`${temporaryRoot}${sep}`) || !target.split(sep).at(-1)?.startsWith("zhilu-pending-")) throw new Error("Unexpected test cleanup path");
    await rm(target, { recursive: true, force: true });
  });
  const post = (path: string, body: unknown) => fetch(`${origin}${path}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const createEvent = async (weeklyHours: number, occurredAt = "2026-09-14T00:00:00Z") => {
    const response = await post("/events", { type: "constraint_changed", title: "时间变化", description: `每周调整为 ${weeklyHours} 小时`,
      targetNodeIds: [], changes: { weeklyHours }, occurredAt });
    expect(response.status).toBe(202);
    return await response.json() as PendingChange;
  };
  const readPending = async (path = "") => {
    const response = await fetch(`${origin}${path}`);
    expect(response.status).toBe(200);
    return (await response.json() as { pending: PendingChange[] }).pending;
  };

  it("restores only current-project/current-version proposals, newest event first, without changing saved records", async () => {
    const old = await createEvent(9);
    await repository.removePending(plan.projectId, old.patch.id);
    const proposal = (id: string, occurredAt: string, baseVersion = plan.version, projectId = plan.projectId): PendingChange => ({
      event: { ...old.event, occurredAt }, patch: { ...old.patch, id, baseVersion }, impact: old.impact,
      afterPreview: { ...old.afterPreview, projectId },
    });
    const saved = [proposal("a-old", "2026-09-14T01:00:00Z"), proposal("z-new", "2026-09-14T10:00:00+08:00"),
      proposal("b-stale", "2026-09-15T00:00:00Z", 0), proposal("c-future", "2026-09-15T00:00:00Z", 2),
      proposal("d-other-project", "2026-09-15T00:00:00Z", 1, "another-project")];
    for (const item of saved) await repository.savePending(plan.projectId, item);
    const before = await repository.getPending(plan.projectId);
    for (const path of ["", "/diff"]) expect((await readPending(path)).map(item => item.patch.id)).toEqual(["z-new", "a-old"]);
    expect(await repository.getPending(plan.projectId)).toEqual(before);
    expect(await repository.getExistingPlan(plan.projectId)).toEqual(plan);
    expect(await repository.getHistory(plan.projectId)).toHaveLength(1);
  });

  it("does not resurrect abandoned proposals after successive approvals and a reload", async () => {
    const abandoned = await createEvent(9);
    const thirty = await createEvent(30, "2026-09-14T01:00:00Z");
    expect((await post("/diff/apply", { patchId: thirty.patch.id })).status).toBe(200);
    const sixty = await createEvent(60, "2026-09-14T02:00:00Z");
    expect((await readPending()).map(item => item.patch.id)).toEqual([sixty.patch.id]);
    expect((await post("/diff/apply", { patchId: sixty.patch.id })).status).toBe(200);
    for (const path of ["", "/diff"]) expect(await readPending(path)).toEqual([]);
    const current = await repository.getExistingPlan(plan.projectId), history = await repository.getHistory(plan.projectId);
    expect(current).toMatchObject({ version: 3, weeklyHours: 60 });
    expect(history).toHaveLength(3);
    expect((await repository.getPending(plan.projectId)).map(item => item.patch.id)).toEqual([abandoned.patch.id]);
    expect((await post("/diff/apply", { patchId: abandoned.patch.id })).status).toBe(409);
    expect((await post("/diff/replan", { patchId: abandoned.patch.id })).status).toBe(409);
    expect(await repository.getExistingPlan(plan.projectId)).toEqual(current);
    expect(await repository.getHistory(plan.projectId)).toEqual(history);
    expect(generate).not.toHaveBeenCalled(); expect(planForBaseline).not.toHaveBeenCalled(); expect(researchOne).not.toHaveBeenCalled();
    const next = await createEvent(45);
    expect((await readPending()).map(item => item.patch.id)).toEqual([next.patch.id]);
  });

  it("stops restoring a proposal after a manual node edit advances the plan", async () => {
    const pending = await createEvent(9);
    const response = await fetch(`${origin}/nodes/t1`, { method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "用户修改的素材任务" }) });
    expect(response.status).toBe(200);
    expect(await readPending()).toEqual([]);
    expect((await repository.getPending(plan.projectId)).map(item => item.patch.id)).toEqual([pending.patch.id]);
    expect((await repository.getExistingPlan(plan.projectId)).nodes[0]?.title).toBe("用户修改的素材任务");
  });

  it.each(["/diff/apply", "/diff/replan"])("rejects a proposal saved under the wrong project at %s without model calls or writes", async path => {
    const pending = await createEvent(9);
    pending.afterPreview.projectId = "another-project";
    await repository.savePending(plan.projectId, pending);
    const beforePending = await repository.getPending(plan.projectId), history = await repository.getHistory(plan.projectId);
    expect((await post(path, { patchId: pending.patch.id })).status).toBe(409);
    expect(await repository.getExistingPlan(plan.projectId)).toEqual(plan);
    expect(await repository.getHistory(plan.projectId)).toEqual(history);
    expect(await repository.getPending(plan.projectId)).toEqual(beforePending);
    expect(generate).not.toHaveBeenCalled(); expect(planForBaseline).not.toHaveBeenCalled(); expect(researchOne).not.toHaveBeenCalled();
  });

  it("omits invalidated event proposals from the baseline approval response", async () => {
    const pending = await createEvent(9);
    const proposal = createMockBaselineProposal(plan, { runId: "research-test", proposalId: "baseline-test",
      requestIdFactory: index => `rq-${index}`, now: "2026-09-14T00:00:00Z" });
    await repository.saveBaselineProposal(plan.projectId, proposal);
    const response = await post("/baseline/apply", { proposalId: proposal.id, routeId: proposal.recommendedRouteId });
    const payload = await response.json() as { plan: PlanState; pending: PendingChange[] };
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.plan.version).toBe(plan.version + 1);
    expect(payload.pending).toEqual([]);
    expect(await readPending()).toEqual([]);
    expect((await repository.getPending(plan.projectId)).map(item => item.patch.id)).toEqual([pending.patch.id]);
  });
});
