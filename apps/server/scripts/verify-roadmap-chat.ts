import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createZhiluServer } from "../src/index";
import { PlanRepository } from "../src/repository";
import type { PlanState, RoadmapChatState } from "@zhilu/contracts";
import { createRoadmapperProvider, readRoadmapperConfig } from "../src/roadmapper-provider";
import { createZhidaProvider, readZhidaConfig } from "../src/zhida-provider";
const root = await mkdtemp(join(tmpdir(), "zhilu-chat-live-"));
const repository = new PlanRepository(root, resolve("examples/agent-engineer/plan-state.json"));
const today = new Date().toISOString().slice(0, 10), end = new Date(Date.now() + 27 * 86400000).toISOString().slice(0, 10);
const plan: PlanState = { schemaVersion: "bundle@1", projectId: "chat-live-check", title: "写作练习", goal: "完成一篇清晰的短文", version: 1, currentCommitId: "000001", weeklyHours: 5,
  updatedAt: new Date().toISOString(), nodes: [
    { id: "m1", type: "milestone", title: "完成初稿", status: "todo", startDate: today, endDate: end, evidenceIds: [], manualFields: [] },
    { id: "t1", type: "task", title: "写一篇短文", milestoneId: "m1", status: "todo", startDate: today, endDate: today, estimatedHours: 1, evidenceIds: [], manualFields: [] },
  ], evidence: [], relations: [] };
await repository.savePlan(plan);
const model = createRoadmapperProvider(readRoadmapperConfig());
const server = createZhiluServer(repository, { authConfig: { mode: "local", appId: "", appKey: "", redirectUri: "" }, liveEnabled: true, roadmapperProvider: { generate: async (input, options) => { const output = await model.generate(input, options); console.log(JSON.stringify({ phase: "model-output", output })); return output; } }, zhidaProvider: createZhidaProvider(readZhidaConfig()) });
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${plan.projectId}/chat`;
try {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseVersion: 1, message: "请先查知乎关于提高短文可读性的经验，然后只修改写一篇短文这项任务的完成标准，给出三条具体可检查的标准。保持名称、日期、工时和其他任务不变。" }) });
  const chat = await response.json() as RoadmapChatState;
  console.log(JSON.stringify({ phase: "generated", status: response.status, result: chat }));
  if (!response.ok || !chat.proposal || !chat.messages.some(item => item.research?.provider === "zhida-agent")) throw new Error("Live chat did not complete research and proposal.");
  if ((await repository.getPlan(plan.projectId)).version !== 1) throw new Error("Plan changed before confirmation.");
  const applied = await fetch(url + "/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposalId: chat.proposal.id }) });
  if (!applied.ok || (await repository.getPlan(plan.projectId)).version !== 2) throw new Error("Apply failed.");
  console.log(JSON.stringify({ phase: "verified", beforeConfirmationVersion: 1, afterConfirmationVersion: 2, research: "zhida-agent", historyCount: (await repository.getHistory(plan.projectId)).length }));
} finally {
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  await rm(root, { recursive: true, force: true });
}
