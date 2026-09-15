import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanCommit, PlanState } from "@zhilu/contracts";
import { createCommit } from "@zhilu/plan-engine";
import { createZhiluServer } from "./index";
import { PlanRepository, type PendingChange } from "./repository";
import { confirmedPlan } from "./fixtures/live-plan";
import { buildM2Context } from "./m2-context";
import { RoadmapperProviderError } from "./roadmapper-provider";

const draft = () => ({ status: "scheduled", summary: "保留任务工时，将第二项安排到下一周。", usedEvidenceIds: [],
  changes: [{ nodeId: "t2", startDate: "2026-09-21", endDate: "2026-09-27", reason: "每周时间减少，避免超出预算。" }] });
function fixture(): PlanState {
  return { ...confirmedPlan(), projectId: "event-test", version: 2, currentCommitId: "000002", weeklyHours: 8.5,
    goalContract: { ...confirmedPlan().goalContract!, targetDate: "2026-09-20" },
    nodes: [
      { id: "m1", type: "milestone", title: "离线排期测试阶段", status: "todo", startDate: "2026-09-14", endDate: "2026-09-20", evidenceIds: [], manualFields: [] },
      ...["t1", "t2"].map(id => ({ id, type: "task" as const, title: `离线任务 ${id}`, milestoneId: "m1", status: "todo" as const,
        startDate: "2026-09-14", endDate: "2026-09-20", estimatedHours: 4, evidenceIds: [], manualFields: [] })),
      { id: "review", type: "checkpoint", title: "复盘", status: "todo", startDate: "2026-09-20", endDate: "2026-09-20", estimatedHours: .5, evidenceIds: [], manualFields: [] },
    ], relations: [{ id: "dep", sourceId: "t2", targetId: "t1", type: "depends_on", hard: true }],
  };
}

describe("model event replanning HTTP boundary", () => {
  let dataRoot: string, origin: string, repository: PlanRepository, server: ReturnType<typeof createZhiluServer>;
  let generate: ReturnType<typeof vi.fn>, planResearch: ReturnType<typeof vi.fn>, researchOne: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-14T00:00:00Z"));
    dataRoot = await mkdtemp(join(tmpdir(), "zhilu-event-replan-"));
    repository = new PlanRepository(dataRoot, resolve(import.meta.dirname, "../../../examples/agent-engineer/plan-state.json"));
    const plan = fixture();
    await repository.savePlan(plan);
    await repository.saveCommit(plan.projectId, createCommit(null, plan, { id: "000002", createdAt: plan.updatedAt, actor: "user", reason: "离线测试基线" }));
    generate = vi.fn(async () => draft()); planResearch = vi.fn(); researchOne = vi.fn();
    server = createZhiluServer(repository, { liveEnabled: true, roadmapperProvider: { generate }, zhihuProvider: { planForBaseline: planResearch, researchOne } });
    await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", ready); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/event-test`;
  });
  afterEach(async () => {
    if (server?.listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await rm(dataRoot, { recursive: true, force: true }); vi.useRealTimers();
  });
  const post = async (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const createEvent = async (overrides: Record<string, unknown> = {}) => {
    const response = await post(`${origin}/events`, { type: "constraint_changed", title: "时间减半", description: "每周改为 4.5 小时", targetNodeIds: [], changes: { weeklyHours: 4.5 }, ...overrides });
    expect(response.status).toBe(202);
    const { event, patch, impact, afterPreview, processing } = await response.json() as PendingChange;
    return { event, patch, impact, afterPreview, ...(processing ? { processing } : {}) };
  };
  const unchanged = async (pending: PendingChange) => {
    expect(await repository.getExistingPlan("event-test")).toEqual(fixture());
    expect(await repository.getHistory("event-test")).toHaveLength(1);
    expect(await repository.getPending("event-test")).toEqual([pending]);
  };

  it("proposes dates without retrieval, then stores processing evidence only after approval", async () => {
    const old = await createEvent();
    expect(old.processing).toMatchObject({ mode: "deterministic", researchNeeded: false, usedEvidenceIds: [] });
    const response = await post(`${origin}/diff/replan`, { patchId: old.patch.id });
    expect(response.status).toBe(202);
    const proposal = await response.json() as PendingChange;
    expect(proposal.patch.id).not.toBe(old.patch.id);
    expect(proposal.processing).toMatchObject({ mode: "model", researchNeeded: false, usedEvidenceIds: [], summary: draft().summary });
    expect(proposal.processing?.warnings.join(" ")).toContain("2026-09-27");
    expect(proposal.afterPreview.nodes.find(node => node.id === "t2")?.startDate).toBe("2026-09-21");
    expect(proposal.afterPreview.nodes.find(node => node.id === "t1")).toEqual(fixture().nodes[1]);
    expect(proposal.afterPreview.nodes.find(node => node.id === "review")).toEqual(fixture().nodes[3]);
    expect(await repository.getExistingPlan("event-test")).toEqual(fixture());
    expect(await repository.getHistory("event-test")).toHaveLength(1);
    expect((await post(`${origin}/diff/apply`, { patchId: old.patch.id })).status).toBe(404);
    expect((await post(`${origin}/diff/apply`, { patchId: proposal.patch.id })).status).toBe(200);
    const plan = await repository.getExistingPlan("event-test");
    expect(plan.version).toBe(3); expect(plan.weeklyHours).toBe(4.5);
    expect(buildM2Context(plan).user_context.weekly_hours).toBe(4.5);
    expect(plan.goalContract?.targetDate).toBe("2026-09-20");
    const history: PlanCommit[] = await repository.getHistory("event-test");
    expect(history).toHaveLength(2); expect(history[0]?.processing).toEqual(proposal.processing);
    expect(await repository.getPending("event-test")).toEqual([]);
    expect(planResearch).not.toHaveBeenCalled(); expect(researchOne).not.toHaveBeenCalled();
  });

  it("returns a successful no-change result without replacing pending or writing formal state", async () => {
    const plan = fixture();
    plan.nodes[1]!.endDate = "2026-09-16";
    plan.nodes[2]!.startDate = "2026-09-17";
    await repository.savePlan(plan);
    const pending = await createEvent({ changes: { weeklyHours: plan.weeklyHours } });
    const beforeHistory = await repository.getHistory(plan.projectId);
    const savePending = vi.spyOn(repository, "savePending"), removePending = vi.spyOn(repository, "removePending");
    generate.mockResolvedValue({ status: "scheduled", summary: "现有日期已满足当前每周预算，无需调整。", usedEvidenceIds: [], changes: [] });

    const response = await post(`${origin}/diff/replan`, { patchId: pending.patch.id });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ unchanged: true, processing: { mode: "model", researchNeeded: false,
      usedEvidenceIds: [], summary: "现有日期已满足当前每周预算，无需调整。" } });
    expect(result).not.toHaveProperty("patch");
    expect(result).not.toHaveProperty("afterPreview");
    expect(await repository.getPending(plan.projectId)).toEqual([pending]);
    expect(await repository.getExistingPlan(plan.projectId)).toEqual(plan);
    expect(await repository.getHistory(plan.projectId)).toEqual(beforeHistory);
    expect(savePending).not.toHaveBeenCalled(); expect(removePending).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(planResearch).not.toHaveBeenCalled(); expect(researchOne).not.toHaveBeenCalled();
    // A no-change result releases the project lock and leaves the existing proposal addressable.
    expect((await post(`${origin}/diff/replan`, { patchId: pending.patch.id })).status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(await repository.getPending(plan.projectId)).toEqual([pending]);
  });

  it("still proposes a real weekly-hours change when no task dates need changing", async () => {
    const plan = fixture();
    plan.nodes[1]!.endDate = "2026-09-16";
    plan.nodes[2]!.startDate = "2026-09-17";
    await repository.savePlan(plan);
    const pending = await createEvent({ changes: { weeklyHours: 10 } });
    generate.mockResolvedValue({ status: "scheduled", summary: "新预算已容纳现有排期，仅更新每周工时。", usedEvidenceIds: [], changes: [] });

    const response = await post(`${origin}/diff/replan`, { patchId: pending.patch.id });
    expect(response.status).toBe(202);
    const proposal = await response.json() as PendingChange;
    expect(proposal.patch.operations).toEqual([{ op: "set_weekly_hours", weeklyHours: 10 }]);
    expect(proposal.patch.id).not.toBe(pending.patch.id);
    expect(proposal.afterPreview.nodes).toEqual(plan.nodes);
    expect(await repository.getExistingPlan(plan.projectId)).toEqual(plan);
    expect(await repository.getHistory(plan.projectId)).toHaveLength(1);
    expect((await repository.getPending(plan.projectId)).map(item => item.patch.id)).toEqual([proposal.patch.id]);
    expect((await post(`${origin}/diff/apply`, { patchId: proposal.patch.id })).status).toBe(200);
    const applied = await repository.getExistingPlan(plan.projectId);
    expect(applied.weeklyHours).toBe(10);
    expect(applied.nodes).toEqual(plan.nodes);
    expect(await repository.getHistory(plan.projectId)).toHaveLength(2);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(planResearch).not.toHaveBeenCalled(); expect(researchOne).not.toHaveBeenCalled();
  });

  it("rejects a no-change result if the formal plan changed while the model was checking", async () => {
    const plan = fixture();
    plan.nodes[1]!.endDate = "2026-09-16";
    plan.nodes[2]!.startDate = "2026-09-17";
    await repository.savePlan(plan);
    const pending = await createEvent({ changes: { weeklyHours: plan.weeklyHours } });
    generate.mockImplementationOnce(async () => {
      await repository.savePlan({ ...plan, version: plan.version + 1 });
      return { status: "scheduled", summary: "现有日期无需变化。", usedEvidenceIds: [], changes: [] };
    });
    expect((await post(`${origin}/diff/replan`, { patchId: pending.patch.id })).status).toBe(409);
    expect(await repository.getPending(plan.projectId)).toEqual([pending]);
    expect((await repository.getExistingPlan(plan.projectId)).version).toBe(plan.version + 1);
    expect(await repository.getHistory(plan.projectId)).toHaveLength(1);
  });

  it.each(["invalid", "timeout", "unschedulable"])("keeps previous proposal on %s and releases the busy guard", async kind => {
    const pending = await createEvent();
    if (kind === "timeout") generate.mockRejectedValueOnce(new RoadmapperProviderError("timeout"));
    else generate.mockResolvedValueOnce(kind === "invalid" ? { ...draft(), approved: true } : { ...draft(), status: "unschedulable", summary: "锁定日期无法满足预算", changes: [] });
    const response = await post(`${origin}/diff/replan`, { patchId: pending.patch.id });
    expect(response.status).toBe(kind === "timeout" ? 504 : 422);
    await unchanged(pending);
    expect((await post(`${origin}/diff/replan`, { patchId: pending.patch.id })).status).toBe(202);
  });

  it("rejects stale proposals before a model call", async () => {
    const pending = await createEvent();
    await repository.savePlan({ ...fixture(), version: 3 });
    expect((await post(`${origin}/diff/replan`, { patchId: pending.patch.id })).status).toBe(409);
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects changed plans during generation without replacing the prior pending proposal", async () => {
    const pending = await createEvent();
    generate.mockImplementationOnce(async () => {
      await repository.savePlan({ ...fixture(), version: 3, title: "用户更新后的标题" });
      return draft();
    });
    expect((await post(`${origin}/diff/replan`, { patchId: pending.patch.id })).status).toBe(409);
    expect((await repository.getExistingPlan("event-test")).title).toBe("用户更新后的标题");
    expect(await repository.getPending("event-test")).toEqual([pending]);
    expect(await repository.getHistory("event-test")).toHaveLength(1);
  });

  it("blocks parallel replan and old approval while generation is pending", async () => {
    const pending = await createEvent();
    let release!: (value: ReturnType<typeof draft>) => void;
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    generate.mockImplementationOnce(() => { started(); return new Promise(resolve => { release = resolve; }); });
    const first = post(`${origin}/diff/replan`, { patchId: pending.patch.id });
    await running;
    try {
      expect((await post(`${origin}/diff/replan`, { patchId: pending.patch.id })).status).toBe(409);
      expect((await post(`${origin}/diff/apply`, { patchId: pending.patch.id })).status).toBe(409);
    } finally { release(draft()); }
    expect((await first).status).toBe(202);
  });

  it.each([
    { type: "custom", targetNodeIds: ["t2"] },
    { confirmed: false },
  ])("rejects unsupported or unconfirmed events before calling the model: %j", async overrides => {
    const pending = await createEvent(overrides);
    expect((await post(`${origin}/diff/replan`, { patchId: pending.patch.id })).status).toBe(422);
    expect(generate).not.toHaveBeenCalled(); await unchanged(pending);
  });

  it("does not overwrite manually locked dates", async () => {
    const plan = fixture(); plan.nodes[2]!.manualFields = ["startDate"];
    await repository.savePlan(plan);
    const pending = await createEvent();
    expect((await post(`${origin}/diff/replan`, { patchId: pending.patch.id })).status).toBe(422);
    expect(await repository.getExistingPlan("event-test")).toEqual(plan);
    expect(await repository.getPending("event-test")).toEqual([pending]);
  });

  it("retains a user's adjustment reason in both rule and model proposals", async () => {
    const plan = fixture(); plan.nodes[2]!.manualFields = ["adjustmentReason"];
    plan.nodes[2]!.adjustmentReason = "用户保留的决定";
    await repository.savePlan(plan);
    const pending = await createEvent();
    expect(pending.afterPreview.nodes[2]!.adjustmentReason).toBe("用户保留的决定");
    const response = await post(`${origin}/diff/replan`, { patchId: pending.patch.id });
    expect(response.status).toBe(202);
    const proposal = await response.json() as PendingChange;
    expect(proposal.afterPreview.nodes[2]!.adjustmentReason).toBe("用户保留的决定");
  });

  it("accepts only a pending identifier, never caller-supplied approval or patches", async () => {
    const pending = await createEvent();
    expect((await post(`${origin}/diff/replan`, { patchId: pending.patch.id, approved: true })).status).toBe(400);
    expect((await post(`${origin}/diff/replan`, { patchId: "missing" })).status).toBe(404);
    expect(generate).not.toHaveBeenCalled(); await unchanged(pending);
  });
});
