import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createResearchReadyPlan, type RoadmapperInput } from "@zhilu/agent-runtime";
import type { BaselineProposal, ZhidaResearch } from "@zhilu/contracts";
import { createZhiluServer } from "./index";
import { PlanRepository } from "./repository";
import { roadmapperDraftFixture } from "../../../packages/agent-runtime/src/roadmapper.test-fixture";
import type { ZhidaProvider } from "./zhida-provider";
import type { RoadmapperProvider } from "./roadmapper-provider";
import { RoadmapperProviderError } from "./roadmapper-provider";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const answer: ZhidaResearch = { provider: "zhida-agent", answer: "## 先跑通核心循环\n先完成能玩的原型，再部署分享。[1]", durationMs: 1500,
  generatedAt: "2026-09-14T00:00:00Z", sources: [{ id: "1", title: "开发经验", author: "开发者", summary: "从小原型开始", url: "https://zhuanlan.zhihu.com/p/123" }] };

async function setup(zhidaProvider: ZhidaProvider, roadmapperProvider: RoadmapperProvider = { generate: async input => roadmapperDraftFixture(input as RoadmapperInput) }) {
  const root = await mkdtemp(join(tmpdir(), "zhilu-zhida-http-"));
  const repository = new PlanRepository(root, resolve("examples/agent-engineer/plan-state.json"));
  const now = new Date(), target = new Date(now.getTime() + 27 * 86400000);
  const plan = createResearchReadyPlan({ userContext: { currentSituation: "没有游戏开发经验", weeklyHours: 8, constraints: ["免费工具"], confirmed: true },
    goalContract: { goal: "做一个浏览器小游戏", targetDate: target.toISOString().slice(0, 10), successCriteria: ["可分享试玩"], nonGoals: [],
      mustHaveOutcomes: ["核心循环"], tradeoffs: ["先做最小版本"], reviewCadence: "weekly", confirmed: true },
    adaptiveQuestion: "什么最重要？", adaptiveAnswer: "可以玩" }, "source-card-demo", now.toISOString());
  await repository.savePlan(plan);
  const server = createZhiluServer(repository, { liveEnabled: true, zhidaProvider, roadmapperProvider });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { root, repository, plan, origin, url: `${origin}/api/projects/${plan.projectId}/research/live/baseline` };
}

describe("Zhida baseline flow", () => {
  it("returns direct-answer references without evidence gating and retains them after apply", async () => {
    const fixture = await setup({ research: async () => answer });
    const response = await fetch(fixture.url, { method: "POST" });
    expect(response.status).toBe(202);
    const proposal = await response.json() as BaselineProposal;
    expect(proposal.researchRun.zhida).toEqual(answer);
    expect(proposal.researchRun.evidencePacks.flatMap(pack => pack.evidence)).toEqual([]);
    expect(proposal.previews[0]?.plan.research?.zhida).toEqual(answer);
    expect((await fixture.repository.getPlan(fixture.plan.projectId)).version).toBe(fixture.plan.version);
    const applied = await fetch(`${fixture.origin}/api/projects/${fixture.plan.projectId}/baseline/apply`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: proposal.id, routeId: proposal.recommendedRouteId }) });
    expect(applied.status).toBe(200);
    expect((await applied.json()).plan.research.zhida).toEqual(answer);
  });
  it("streams the completed answer while the planner is still working", async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolveWait => { release = resolveWait; });
    const fixture = await setup({ research: async (_input, options) => { options?.onText?.("先做原型"); return answer; } },
      { generate: async input => { await waiting; return roadmapperDraftFixture(input as RoadmapperInput); } });
    const response = await fetch(fixture.url, { method: "POST", headers: { accept: "text/event-stream" } });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let first = "";
    try {
      while (!first.includes("event: research")) { const part = await reader.read(); if (part.done) break; first += decoder.decode(part.value, { stream: true }); }
      expect(first).toContain("event: answer");
      expect(first).toContain("开发经验");
      expect(first).not.toContain("event: proposal");
    } finally { release(); }
    let rest = "";
    while (true) { const part = await reader.read(); if (part.done) break; rest += decoder.decode(part.value, { stream: true }); }
    expect(rest).toContain("event: proposal");
  });
  it("still generates when direct answer has no links", async () => {
    const fixture = await setup({ research: async () => ({ ...answer, sources: [] }) });
    expect((await fetch(fixture.url, { method: "POST" })).status).toBe(202);
  });
  it("ends a failed planning stream with an error while retaining the research snapshot", async () => {
    const fixture = await setup({ research: async () => answer }, { generate: async () => { throw new RoadmapperProviderError("timeout"); } });
    const response = await fetch(fixture.url, { method: "POST", headers: { accept: "text/event-stream" } });
    const body = await response.text();
    expect(body).toContain("event: research");
    expect(body).toContain("event: error");
    expect(body).toContain('"code":"timeout"');
    expect(body).not.toContain("event: proposal");
    expect(await fixture.repository.getBaselineProposals(fixture.plan.projectId)).toEqual([]);
    expect(await fixture.repository.getHistory(fixture.plan.projectId)).toEqual([]);
  });
  it("cancels direct-answer work when a streaming client leaves and releases the project lock", async () => {
    let seenAbort!: () => void, started!: () => void, calls = 0;
    const aborted = new Promise<void>(done => { seenAbort = done; });
    const active = new Promise<void>(done => { started = done; });
    const fixture = await setup({ research: async (_input, options) => {
      if (++calls > 1) return answer;
      started();
      return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => { seenAbort(); reject(new Error("cancelled")); }, { once: true }));
    } });
    const response = await fetch(fixture.url, { method: "POST", headers: { accept: "text/event-stream" } });
    await active;
    await response.body!.cancel();
    await aborted;
    expect(await fixture.repository.getBaselineProposals(fixture.plan.projectId)).toEqual([]);
    const retry = await fetch(fixture.url, { method: "POST" });
    expect(retry.status).toBe(202);
  });
});
