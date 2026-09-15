import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanState, RoadmapChatState } from "@zhilu/contracts";
import { createZhiluServer } from "./index";
import { PlanRepository } from "./repository";
import type { RoadmapperProvider } from "./roadmapper-provider";
import { compileChatProposal } from "./roadmap-chat";

const plan: PlanState = { schemaVersion: "bundle@1", projectId: "chat-test", title: "写作", goal: "完成一篇文章", version: 1, currentCommitId: "000001", weeklyHours: 5, updatedAt: "2026-09-14T00:00:00Z", nodes: [
  { id: "m1", type: "milestone", title: "第一稿", status: "todo", startDate: "2026-09-14", endDate: "2026-10-31", evidenceIds: [], manualFields: [] },
  { id: "t1", type: "task", title: "写初稿", milestoneId: "m1", status: "todo", startDate: "2026-09-14", endDate: "2026-09-20", estimatedHours: 2, evidenceIds: [], manualFields: [] },
], relations: [], evidence: [] };
const draft = { action: "propose", reply: "把初稿顺延一周。", operations: [{ op: "update_node", nodeId: "t1", changes: { startDate: "2026-09-21", endDate: "2026-09-27" } }] };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(model: RoadmapperProvider) {
  const root = await mkdtemp(join(tmpdir(), "zhilu-chat-"));
  const repository = new PlanRepository(root, resolve("examples/agent-engineer/plan-state.json"));
  await repository.savePlan(structuredClone(plan));
  const research = vi.fn(async (_input: { goal: string; user_context: Record<string, unknown> }) => ({ provider: "zhida-agent" as const, answer: "先做一个小样再收集反馈。", sources: [], generatedAt: new Date().toISOString(), durationMs: 10 }));
  const server = createZhiluServer(repository, { liveEnabled: true, roadmapperProvider: model, zhidaProvider: { research } });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${plan.projectId}/chat`;
  const post = (body: unknown, suffix = "") => fetch(url + suffix, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { repository, research, url, post };
}

describe("Roadmap conversation", () => {
  it("corrects a false saved claim into an actual proposal, without silently applying it", async () => {
    let calls = 0;
    const f = await fixture({ generate: async input => {
      if (++calls === 1) return { action: "reply", reply: "好的，已按你确认的方案调整：把初稿顺延一周。" };
      expect(input.context).toMatchObject({ correction: expect.stringContaining("正式计划尚未修改") });
      return draft;
    } });
    const response = await f.post({ message: "按你说的来吧", baseVersion: 1 });
    expect(response.status).toBe(200);
    const chat = await response.json() as RoadmapChatState;
    expect(chat.messages.at(-1)).toMatchObject({ planEffect: "proposal", planVersion: 1 });
    expect(chat.proposal?.afterPreview.nodes[1]?.startDate).toBe("2026-09-21");
    expect(await f.repository.getPlan(plan.projectId)).toEqual(plan);
    expect(calls).toBe(2);
    const applied = await (await f.post({ proposalId: chat.proposal!.id }, "/apply")).json() as RoadmapChatState;
    expect(applied.messages.at(-1)).toMatchObject({ planEffect: "applied", planVersion: 2 });
    const workspace = await (await fetch(f.url.replace(/\/chat$/, ""))).json();
    expect(workspace.view.milestones[0].tasks[0].startDate).toBe("2026-09-21");
  });
  it("does not deliver a false saved claim when correction fails", async () => {
    const f = await fixture({ generate: async () => ({ action: "reply", reply: "已调整计划。" }) });
    expect((await f.post({ message: "调整一下", baseVersion: 1 })).status).toBe(422);
    expect((await f.repository.getRoadmapChat(plan.projectId)).messages.map(item => item.role)).toEqual(["user"]);
    expect(await f.repository.getPlan(plan.projectId)).toEqual(plan);
  });
  it("reads saved drag dates, visible numbers and completed status from the latest version", async () => {
    const seen: unknown[] = [];
    const f = await fixture({ generate: async input => { seen.push(input.context); return { action: "reply", reply: "已完成的任务无需重做。" }; } });
    const current = structuredClone(plan);
    const today = new Date().toISOString().slice(0, 10);
    current.nodes[1]!.status = "done";
    current.nodes[1]!.startDate = today; current.nodes[1]!.endDate = today;
    current.nodes.push({ ...structuredClone(plan.nodes[1]!), id: "t6", title: "回复评论", startDate: "2026-10-12", endDate: "2026-10-18" });
    await f.repository.savePlan(current);
    const edited = await fetch(f.url.replace(/chat$/, "nodes/t6"), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ startDate: today, endDate: today }) });
    expect(edited.status).toBe(200);
    expect((await f.post({ message: "我这周只有两小时", baseVersion: 2 })).status).toBe(200);
    expect(seen[0]).toMatchObject({ plan: { version: 2 }, visibleTasks: [
      { number: "01", id: "t1", status: "done" },
      { number: "02", id: "t6", startDate: today, endDate: today, manualFields: expect.arrayContaining(["startDate", "endDate"]) },
    ], currentWeek: { completedTaskNumbers: ["01"], remainingTasks: [{ id: "t6" }] } });
    expect((await f.repository.getRoadmapChat(plan.projectId)).messages.at(-1)).toMatchObject({ planEffect: "unchanged", planVersion: 2 });
  });
  it("answers a question without research, proposal or plan mutation and persists conversation", async () => {
    const f = await fixture({ generate: async () => ({ action: "reply", reply: "先完成初稿。" }) });
    const response = await f.post({ message: "我接下来做什么？", baseVersion: 1 });
    expect(response.status).toBe(200);
    const chat = await response.json() as RoadmapChatState;
    expect(chat.messages.map(item => item.role)).toEqual(["user", "assistant"]);
    expect(chat.proposal).toBeUndefined();
    expect(await (await fetch(f.url)).json()).toEqual(chat);
    expect(f.research).not.toHaveBeenCalled();
    expect(await f.repository.getPlan(plan.projectId)).toEqual(plan);
  });
  it("researches only the model's minimal query before drafting, and waits for confirmation", async () => {
    let count = 0;
    const generate = vi.fn(async () => ++count === 1 ? { action: "research", reply: "查阅写作经验", researchQuery: "怎样有效修改文章初稿" } : draft);
    const f = await fixture({ generate });
    const response = await f.post({ message: "请查一下写作方法并调整计划", baseVersion: 1 });
    expect(response.status).toBe(200);
    const chat = await response.json() as RoadmapChatState;
    expect(f.research.mock.calls[0]![0]).toEqual({ goal: "怎样有效修改文章初稿", user_context: {} });
    expect(chat.messages[1]?.research?.provider).toBe("zhida-agent");
    expect(chat.proposal?.afterPreview.nodes[1]?.startDate).toBe("2026-09-21");
    expect(await f.repository.getPlan(plan.projectId)).toEqual(plan);
    const applied = await f.post({ proposalId: chat.proposal!.id }, "/apply");
    expect(applied.status).toBe(200);
    expect((await f.repository.getPlan(plan.projectId)).nodes[1]?.startDate).toBe("2026-09-21");
    expect(await f.repository.getHistory(plan.projectId)).toHaveLength(1);
    expect((await f.post({ proposalId: chat.proposal!.id }, "/apply")).status).toBe(200);
    expect(await f.repository.getHistory(plan.projectId)).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("rejects an old proposal after a direct edit and preserves that edit", async () => {
    const f = await fixture({ generate: async () => draft });
    const chat = await (await f.post({ message: "推迟一周", baseVersion: 1 })).json() as RoadmapChatState;
    const edited = structuredClone(plan); edited.version = 2; edited.nodes[1]!.title = "手工改名";
    await f.repository.savePlan(edited);
    expect((await f.post({ proposalId: chat.proposal!.id }, "/apply")).status).toBe(409);
    expect(await f.repository.getPlan(plan.projectId)).toEqual(edited);
  });
  it("corrects string acceptance criteria using the same research result", async () => {
    let calls = 0;
    const f = await fixture({ generate: async input => {
      calls++;
      if (calls === 1) return { action: "research", reply: "查阅经验", researchQuery: "短文怎样更清楚" };
      if (calls === 3) expect(input.context).toMatchObject({ correction: expect.stringContaining("acceptanceCriteria"), research: { provider: "zhida-agent" } });
      return { action: "propose", reply: "增加可检查的标准。", operations: [{ op: "update_node", nodeId: "t1", changes: { acceptanceCriteria: calls === 2 ? "读者能复述核心观点" : ["读者能复述核心观点"] } }] };
    } });
    const response = await f.post({ message: "查一下并改完成标准", baseVersion: 1 });
    expect(response.status).toBe(200);
    const chat = await response.json() as RoadmapChatState;
    expect(chat.proposal?.afterPreview.nodes[1]?.acceptanceCriteria).toEqual(["读者能复述核心观点"]);
    expect(f.research).toHaveBeenCalledTimes(1);
    expect(calls).toBe(3);
    expect(await f.repository.getPlan(plan.projectId)).toEqual(plan);
  });
  it("discards a proposal without losing conversation or changing plan", async () => {
    const f = await fixture({ generate: async () => draft });
    const chat = await (await f.post({ message: "推迟一周", baseVersion: 1 })).json() as RoadmapChatState;
    const discarded = await (await f.post({ proposalId: chat.proposal!.id }, "/discard")).json() as RoadmapChatState;
    expect(discarded.proposal?.status).toBe("discarded");
    expect(discarded.messages).toEqual(chat.messages);
    expect((await f.post({ proposalId: chat.proposal!.id }, "/apply")).status).toBe(409);
    expect(await f.repository.getPlan(plan.projectId)).toEqual(plan);
  });
  it("passes the active draft and conversation to a follow-up while computing against the formal plan", async () => {
    const seen: unknown[] = [];
    const f = await fixture({ generate: async input => { seen.push(input.context); return draft; } });
    await f.post({ message: "推迟一周", baseVersion: 1 });
    await f.post({ message: "这个方案有什么影响？", baseVersion: 1 });
    expect(seen[1]).toMatchObject({ previousProposal: { nodes: [{ id: "m1" }, { id: "t1", startDate: "2026-09-21" }] } });
  });
  it("keeps the user's message on model failure without changing the formal plan", async () => {
    const f = await fixture({ generate: async () => { throw new Error("test upstream failure"); } });
    expect((await f.post({ message: "调整一下", baseVersion: 1 })).status).toBe(500);
    expect((await f.repository.getRoadmapChat(plan.projectId)).messages[0]?.content).toBe("调整一下");
    expect(await f.repository.getPlan(plan.projectId)).toEqual(plan);
  });
  it("does not allow direct edits while a chat proposal is being generated", async () => {
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const active = new Promise<void>(resolve => { started = resolve; });
    const f = await fixture({ generate: async () => { started(); await waiting; return draft; } });
    const sending = f.post({ message: "推迟一周", baseVersion: 1 });
    await active;
    try {
      const edited = await fetch(f.url.replace(/chat$/, "nodes/t1"), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "冲突编辑" }) });
      expect(edited.status).toBe(409);
    } finally { release(); }
    expect((await sending).status).toBe(200);
    expect(await f.repository.getPlan(plan.projectId)).toEqual(plan);
  });
});

describe("chat proposal validation", () => {
  it("allows a rename while preserving a manual schedule outside its original milestone", () => {
    const current = structuredClone(plan);
    current.nodes[0]!.startDate = "2026-09-28";
    current.nodes[1]!.manualFields = ["startDate", "endDate"];
    const proposal = compileChatProposal(current, { action: "propose", reply: "建议修改名称", operations: [{ op: "update_node", nodeId: "t1", changes: { title: "写一份初稿" } }] });
    expect(proposal.afterPreview.nodes[1]).toMatchObject({ title: "写一份初稿", startDate: "2026-09-14", endDate: "2026-09-20", manualFields: ["startDate", "endDate"] });
  });
  it("rejects reducing the budget without fitting remaining work into it", () => {
    const current = structuredClone(plan), today = new Date().toISOString().slice(0, 10);
    current.nodes[1]!.startDate = today; current.nodes[1]!.endDate = today;
    expect(() => compileChatProposal(current, { ...draft, operations: [{ op: "set_weekly_hours", weeklyHours: 1 }] })).toThrow("超过每周");
  });
  it("protects completed tasks and manually edited fields", () => {
    const done = structuredClone(plan); done.nodes[1]!.status = "done";
    expect(() => compileChatProposal(done, draft)).toThrow("已完成");
    const manual = structuredClone(plan); manual.nodes[1]!.manualFields = ["startDate"];
    expect(() => compileChatProposal(manual, draft)).toThrow("用户字段");
  });
  it("rejects unsupported operations, fake fields, invalid dates and resurrecting reviews", () => {
    for (const operation of [
      { op: "delete_all" },
      { op: "update_node", nodeId: "t1", changes: { manualFields: [] } },
      { op: "update_node", nodeId: "t1", changes: { endDate: "2026-02-31" } },
      { op: "add_node", node: { id: "review", type: "checkpoint", title: "复盘", status: "todo" } },
    ]) expect(() => compileChatProposal(plan, { ...draft, operations: [operation] })).toThrow();
  });
});
