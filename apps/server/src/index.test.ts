import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
