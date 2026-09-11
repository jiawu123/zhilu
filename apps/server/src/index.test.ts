import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CreateProjectInput } from "@zhilu/contracts";
import { createZhiluServer } from "./index";
import { PlanRepository } from "./repository";

describe("local API", () => {
  let dataRoot = "";
  let origin = "";
  const repository = new PlanRepository(
    "placeholder",
    resolve(import.meta.dirname, "../../../examples/agent-engineer/plan-state.json"),
  );
  const testServer = createZhiluServer(repository);

  beforeAll(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "zhilu-server-"));
    Object.assign(repository, { dataRoot });
    await new Promise<void>((resolveReady) => testServer.listen(0, "127.0.0.1", resolveReady));
    const address = testServer.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClosed, reject) =>
      testServer.close((error) => (error ? reject(error) : resolveClosed())),
    );
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("persists an approved event as a new commit", async () => {
    const initial = await request<{ plan: { version: number }; history: unknown[] }>(
      `${origin}/api/projects/agent-engineer-demo`,
    );
    expect(initial.plan.version).toBe(1);
    expect(initial.history).toHaveLength(1);

    const pending = await request<{ patch: { id: string }; workflow: { shouldResearch: boolean } }>(
      `${origin}/api/projects/agent-engineer-demo/events`,
      {
        method: "POST",
        body: JSON.stringify({
          type: "constraint_changed",
          title: "时间变化",
          description: "每周投入调整为 6 小时",
          targetNodeIds: [],
          changes: { weeklyHours: 6 },
        }),
      },
    );
    expect(pending.workflow.shouldResearch).toBe(false);

    await request(`${origin}/api/projects/agent-engineer-demo/diff/apply`, {
      method: "POST",
      body: JSON.stringify({ patchId: pending.patch.id }),
    });

    const reloaded = await request<{
      plan: { version: number; currentCommitId: string; weeklyHours: number };
      history: unknown[];
      pending: unknown[];
    }>(`${origin}/api/projects/agent-engineer-demo`);
    expect(reloaded.plan).toMatchObject({ version: 2, currentCommitId: "000002", weeklyHours: 6 });
    expect(reloaded.history).toHaveLength(2);
    expect(reloaded.pending).toHaveLength(0);

    const persisted = JSON.parse(
      await readFile(join(dataRoot, "agent-engineer-demo/.plan/plan.json"), "utf8"),
    ) as { currentCommitId: string };
    expect(persisted.currentCommitId).toBe("000002");
  });

  it("creates a project only from confirmed interview output", async () => {
    const input: CreateProjectInput = {
      userContext: {
        currentSituation: "会 TypeScript，尚无 Agent 项目",
        weeklyHours: 8,
        constraints: ["预算有限"],
        confirmed: true,
      },
      goalContract: {
        goal: "完成一个可展示的 Agent 项目",
        targetDate: "2026-12-20",
        successCriteria: ["公开一个有评测结果的 Demo"],
        nonGoals: [],
        mustHaveOutcomes: ["评测结果"],
        tradeoffs: ["先保证可验证性"],
        reviewCadence: "weekly",
        confirmed: true,
      },
      adaptiveQuestion: "时间不足时优先保留什么？",
      adaptiveAnswer: "保留评测和公开 Demo",
    };
    const rejected = await fetch(`${origin}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, goalContract: { ...input.goalContract, confirmed: false } }),
    });
    expect(rejected.status).toBe(400);

    const created = await request<{
      projectId: string;
      plan: { currentCommitId: string; goalContract: { goal: string }; evidence: Array<{ sourceType: string }> };
      history: unknown[];
      workflow: { phase: string };
    }>(`${origin}/api/projects`, { method: "POST", body: JSON.stringify(input) });
    expect(created.projectId).toMatch(/^project-/);
    expect(created.plan.currentCommitId).toBe("000001");
    expect(created.plan.goalContract.goal).toBe(input.goalContract.goal);
    expect(created.plan.evidence.some((item) => item.sourceType === "zhihu")).toBe(false);
    expect(created.history).toHaveLength(1);
    expect(created.workflow.phase).toBe("research");

    const reloaded = await request<{ plan: { projectId: string } }>(`${origin}/api/projects/${created.projectId}`);
    expect(reloaded.plan.projectId).toBe(created.projectId);
  });

  it("keeps a Mock research proposal pending until the user chooses a Baseline route", async () => {
    const input: CreateProjectInput = {
      userContext: { currentSituation: "会切菜，还没有独立做过一顿饭", weeklyHours: 8, constraints: ["预算 6000 元"], confirmed: true },
      goalContract: {
        goal: "三个月内成为一名能给家人做饭的厨师",
        targetDate: "2026-12-20",
        successCriteria: ["独立完成一顿三菜一汤"],
        nonGoals: [],
        mustHaveOutcomes: ["家人试吃反馈"],
        tradeoffs: ["先保证家常菜稳定"],
        reviewCadence: "weekly",
        confirmed: true,
      },
      adaptiveQuestion: "最重要的验收场景是什么？",
      adaptiveAnswer: "周末给家人做饭",
    };
    const created = await request<{ projectId: string; plan: { version: number } }>(`${origin}/api/projects`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    const proposal = await request<{
      id: string;
      recommendedRouteId: string;
      researchRun: { mode: string; routeCandidates: Array<{ id: string }> };
      previews: Array<{ routeId: string; plan: { version: number } }>;
    }>(`${origin}/api/projects/${created.projectId}/research/mock`, { method: "POST" });
    expect(proposal.researchRun.mode).toBe("mock");
    expect(proposal.researchRun.routeCandidates).toHaveLength(2);
    expect(proposal.previews.every((preview) => preview.plan.version === 2)).toBe(true);

    const beforeApproval = await request<{
      plan: { version: number };
      baselineProposals: unknown[];
    }>(`${origin}/api/projects/${created.projectId}`);
    expect(beforeApproval.plan.version).toBe(1);
    expect(beforeApproval.baselineProposals).toHaveLength(1);

    const chosenRoute = proposal.researchRun.routeCandidates[1]!.id;
    const applied = await request<{
      plan: { version: number; currentCommitId: string; research: { mode: string; selectedRouteId: string }; evidence: Array<{ sourceType: string }> };
      history: unknown[];
      baselineProposals: unknown[];
    }>(`${origin}/api/projects/${created.projectId}/baseline/apply`, {
      method: "POST",
      body: JSON.stringify({ proposalId: proposal.id, routeId: chosenRoute }),
    });
    expect(applied.plan).toMatchObject({
      version: 2,
      currentCommitId: "000002",
      research: { mode: "mock", selectedRouteId: chosenRoute },
    });
    expect(applied.plan.evidence.some((item) => item.sourceType === "zhihu")).toBe(false);
    expect(applied.history).toHaveLength(2);
    expect(applied.baselineProposals).toHaveLength(0);
  });

  it("previews a node-scoped event without changing the formal plan", async () => {
    const pending = await request<{
      impact: { affectedNodeIds: string[] };
      patch: { operations: Array<{ op: string; nodeId?: string; changes?: { adjustmentReason?: string } }> };
      afterPreview: { nodes: Array<{ id: string; adjustmentReason?: string }> };
    }>(`${origin}/api/projects/agent-engineer-demo/events`, {
      method: "POST",
      body: JSON.stringify({
        type: "custom",
        title: "路标遇到变化",
        description: "评测数据需要重新确认",
        targetNodeIds: ["t-eval-set"],
      }),
    });
    expect(pending.impact.affectedNodeIds).toContain("t-eval-set");
    expect(pending.patch.operations).toContainEqual({
      op: "update_node",
      nodeId: "t-eval-set",
      changes: { adjustmentReason: "评测数据需要重新确认" },
    });
    expect(pending.afterPreview.nodes.find((node) => node.id === "t-eval-set")?.adjustmentReason).toBe(
      "评测数据需要重新确认",
    );

    const formal = await request<{ plan: { nodes: Array<{ id: string; adjustmentReason?: string }> } }>(
      `${origin}/api/projects/agent-engineer-demo`,
    );
    expect(formal.plan.nodes.find((node) => node.id === "t-eval-set")?.adjustmentReason).not.toBe(
      "评测数据需要重新确认",
    );
  });

  it("archives a task through Plan Engine and creates a commit", async () => {
    const before = await request<{ plan: { version: number } }>(`${origin}/api/projects/agent-engineer-demo`);
    const archived = await request<{
      plan: { version: number; nodes: Array<{ id: string; status: string }> };
      view: { milestones: Array<{ tasks: Array<{ id: string }> }> };
    }>(`${origin}/api/projects/agent-engineer-demo/nodes/t-rag-baseline`, { method: "DELETE" });
    expect(archived.plan.version).toBe(before.plan.version + 1);
    expect(archived.plan.nodes.find((node) => node.id === "t-rag-baseline")?.status).toBe("archived");
    expect(archived.view.milestones.flatMap((group) => group.tasks).map((task) => task.id)).not.toContain(
      "t-rag-baseline",
    );
  });

  it("exports JSON, Markdown and a real Plan Bundle ZIP from the same commit", async () => {
    const jsonResponse = await fetch(`${origin}/api/projects/agent-engineer-demo/export/json`);
    const json = await jsonResponse.json() as { currentCommitId: string };
    expect(jsonResponse.headers.get("content-disposition")).toContain(".json");

    const markdownResponse = await fetch(`${origin}/api/projects/agent-engineer-demo/export/markdown`);
    const markdown = await markdownResponse.text();
    expect(markdown).toContain(`当前版本：${json.currentCommitId}`);
    expect(markdown).toContain("## Roadmap");

    const zipResponse = await fetch(`${origin}/api/projects/agent-engineer-demo/export/zip`);
    const archive = unzipSync(new Uint8Array(await zipResponse.arrayBuffer()));
    expect(zipResponse.headers.get("content-type")).toBe("application/zip");
    expect(Object.keys(archive)).toContain(".plan/plan.json");
    expect(Object.keys(archive)).toContain(`.plan/commits/${json.currentCommitId}.json`);
    expect(JSON.parse(strFromU8(archive[".plan/plan.json"]!)).currentCommitId).toBe(json.currentCommitId);
    expect(strFromU8(archive["README.md"]!)).toContain(`当前版本：${json.currentCommitId}`);
  });
});

async function request<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json()) as T;
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}
