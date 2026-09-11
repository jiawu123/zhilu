import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import type {
  BaselineProposal,
  CreateProjectInput,
  PatchProposal,
  PlanEvent,
  PlanNode,
  PlanNodeUpdate,
  PlanState,
} from "@zhilu/contracts";
import { createMockBaselineProposal, createResearchReadyPlan, decideWorkflow, validateProjectCreationInput } from "@zhilu/agent-runtime";
import {
  PlanEngineError,
  applyBaselineProposal,
  applyPatch,
  calculateImpact,
  createCommit,
  projectView,
  validateEvent,
  validatePlan,
} from "@zhilu/plan-engine";
import { PlanRepository } from "./repository";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const repository = new PlanRepository(
  process.env.ZHILU_DATA_DIR ?? resolve(repoRoot, "data"),
  resolve(repoRoot, "examples/agent-engineer/plan-state.json"),
);
const port = Number(process.env.PORT ?? 8787);

export function createZhiluServer(planRepository: PlanRepository) {
  return createServer(async (request, response) => {
    setCors(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    try {
      await route(request, response, planRepository);
    } catch (error) {
      handleError(response, error);
    }
  });
}

export const server = createZhiluServer(repository);

if (process.env.NODE_ENV !== "test") {
  server.listen(port, "127.0.0.1", () => {
    console.log(`Zhilu server: http://127.0.0.1:${port}`);
  });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  planRepository: PlanRepository,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && pathname === "/api/projects") {
    const input = await readBody<CreateProjectInput>(request);
    const now = new Date().toISOString();
    const validation = validateProjectCreationInput(input, now.slice(0, 10));
    if (!validation.valid) throw new PlanEngineError(validation.issues);
    const projectId = `project-${crypto.randomUUID().slice(0, 8)}`;
    const plan = createResearchReadyPlan(input, projectId, now);
    const planValidation = validatePlan(plan);
    if (!planValidation.valid) throw new PlanEngineError(planValidation.issues);
    const baseline = createCommit(null, plan, {
      id: plan.currentCommitId,
      createdAt: now,
      actor: "user",
      reason: "用户确认 Goal Contract，建立研究准备版",
    });
    await planRepository.savePlan(plan);
    await planRepository.saveCommit(projectId, baseline);
    sendJson(response, 201, {
      projectId,
      plan,
      view: projectView(plan),
      history: [baseline],
      pending: [],
      baselineProposals: [],
      workflow: decideWorkflow({ hasConfirmedGoal: true, hasConfirmedContext: true, plan: null }),
    });
    return;
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (request.method === "GET" && projectMatch) {
    const projectId = decodeURIComponent(requiredMatch(projectMatch, 1));
    const plan = await planRepository.getPlan(projectId);
    sendJson(response, 200, {
      plan,
      view: projectView(plan),
      history: await planRepository.getHistory(projectId),
      pending: await planRepository.getPending(projectId),
      baselineProposals: await planRepository.getBaselineProposals(projectId),
    });
    return;
  }

  const mockResearchMatch = pathname.match(/^\/api\/projects\/([^/]+)\/research\/mock$/);
  if (request.method === "POST" && mockResearchMatch) {
    const projectId = decodeURIComponent(requiredMatch(mockResearchMatch, 1));
    const plan = await planRepository.getPlan(projectId);
    if (!plan.evidence.some((item) => item.riskTags.includes("等待知乎研究"))) {
      throw new HttpError(409, "当前项目已经有 Baseline；需要新研究时请从 knowledge_gap Event 发起");
    }
    for (const existing of await planRepository.getBaselineProposals(projectId)) {
      await planRepository.removeBaselineProposal(projectId, existing.id);
    }
    const now = new Date().toISOString();
    const proposal = createMockBaselineProposal(plan, {
      runId: uniqueId("research"),
      proposalId: uniqueId("baseline"),
      requestIdFactory: (index) => `rq-${String(index + 1).padStart(2, "0")}-${crypto.randomUUID().slice(0, 6)}`,
      now,
    });
    for (const preview of proposal.previews) {
      const validation = validatePlan(preview.plan);
      if (!validation.valid) throw new PlanEngineError(validation.issues);
    }
    await planRepository.saveBaselineProposal(projectId, proposal);
    sendJson(response, 202, proposal);
    return;
  }

  const baselineApplyMatch = pathname.match(/^\/api\/projects\/([^/]+)\/baseline\/apply$/);
  if (request.method === "POST" && baselineApplyMatch) {
    const projectId = decodeURIComponent(requiredMatch(baselineApplyMatch, 1));
    const { proposalId, routeId } = await readBody<{ proposalId: string; routeId: string }>(request);
    const proposal = (await planRepository.getBaselineProposals(projectId)).find((item) => item.id === proposalId);
    if (!proposal) throw new HttpError(404, `Baseline 提案不存在：${proposalId}`);
    const plan = await planRepository.getPlan(projectId);
    const now = new Date().toISOString();
    const next = applyBaselineProposal(plan, proposal, routeId, now);
    const route = proposal.researchRun.routeCandidates.find((item) => item.id === routeId);
    const commit = createCommit(plan, next, {
      id: next.currentCommitId,
      createdAt: now,
      actor: "user",
      reason: `用户确认 Mock Research 路线：${route?.title ?? routeId}`,
    });
    await planRepository.savePlan(next);
    await planRepository.saveCommit(projectId, commit);
    await planRepository.removeBaselineProposal(projectId, proposal.id);
    sendJson(response, 200, {
      plan: next,
      view: projectView(next),
      history: await planRepository.getHistory(projectId),
      pending: await planRepository.getPending(projectId),
      baselineProposals: [],
    });
    return;
  }

  const evidenceMatch = pathname.match(/^\/api\/projects\/([^/]+)\/evidence$/);
  if (request.method === "GET" && evidenceMatch) {
    const plan = await planRepository.getPlan(decodeURIComponent(requiredMatch(evidenceMatch, 1)));
    sendJson(response, 200, { evidence: plan.evidence });
    return;
  }

  const exportMatch = pathname.match(/^\/api\/projects\/([^/]+)\/export\/(json|markdown|zip)$/);
  if (request.method === "GET" && exportMatch) {
    const projectId = decodeURIComponent(requiredMatch(exportMatch, 1));
    const format = requiredMatch(exportMatch, 2);
    const plan = await planRepository.getPlan(projectId);
    const history = await planRepository.getHistory(projectId);
    const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const markdown = renderPlanMarkdown(plan);
    if (format === "json") {
      sendDownload(response, "application/json; charset=utf-8", `zhilu-${safeProjectId}.json`, `${JSON.stringify(plan, null, 2)}\n`);
      return;
    }
    if (format === "markdown") {
      sendDownload(response, "text/markdown; charset=utf-8", `zhilu-${safeProjectId}.md`, markdown);
      return;
    }
    const files: Record<string, Uint8Array> = {
      "manifest.json": strToU8(`${JSON.stringify({ schemaVersion: plan.schemaVersion, projectId: plan.projectId, currentCommitId: plan.currentCommitId, exportedAt: new Date().toISOString() }, null, 2)}\n`),
      "README.md": strToU8(markdown),
      ".plan/plan.json": strToU8(`${JSON.stringify(plan, null, 2)}\n`),
    };
    for (const commit of history) {
      files[`.plan/commits/${commit.id}.json`] = strToU8(`${JSON.stringify(commit, null, 2)}\n`);
    }
    sendDownload(response, "application/zip", `zhilu-${safeProjectId}.planbundle.zip`, zipSync(files, { level: 6 }));
    return;
  }

  const provenanceMatch = pathname.match(/^\/api\/projects\/([^/]+)\/nodes\/([^/]+)\/provenance$/);
  if (request.method === "GET" && provenanceMatch) {
    const projectId = decodeURIComponent(requiredMatch(provenanceMatch, 1));
    const nodeId = decodeURIComponent(requiredMatch(provenanceMatch, 2));
    const plan = await planRepository.getPlan(projectId);
    const node = plan.nodes.find((item) => item.id === nodeId);
    if (!node) throw new HttpError(404, `节点不存在：${nodeId}`);
    sendJson(response, 200, {
      node,
      evidence: plan.evidence.filter((item) => node.evidenceIds.includes(item.id)),
    });
    return;
  }

  const nodeMatch = pathname.match(/^\/api\/projects\/([^/]+)\/nodes\/([^/]+)$/);
  if (request.method === "PATCH" && nodeMatch) {
    const projectId = decodeURIComponent(requiredMatch(nodeMatch, 1));
    const nodeId = decodeURIComponent(requiredMatch(nodeMatch, 2));
    const plan = await planRepository.getPlan(projectId);
    if (!plan.nodes.some((node) => node.id === nodeId)) throw new HttpError(404, `节点不存在：${nodeId}`);
    const changes = await readBody<PlanNodeUpdate>(request);
    const patch: PatchProposal = {
      id: uniqueId("patch"),
      baseVersion: plan.version,
      origin: "user",
      reason: "用户直接编辑 Roadmap 节点",
      operations: [{ op: "update_node", nodeId, changes }],
    };
    const next = await commitPatch(planRepository, plan, patch, "用户直接编辑 Roadmap 节点");
    sendJson(response, 200, { plan: next, view: projectView(next) });
    return;
  }

  if (request.method === "DELETE" && nodeMatch) {
    const projectId = decodeURIComponent(requiredMatch(nodeMatch, 1));
    const nodeId = decodeURIComponent(requiredMatch(nodeMatch, 2));
    const plan = await planRepository.getPlan(projectId);
    const node = plan.nodes.find((item) => item.id === nodeId);
    if (!node) throw new HttpError(404, `节点不存在：${nodeId}`);
    if (node.type !== "task") throw new HttpError(400, "P0 只允许归档任务节点");
    const patch: PatchProposal = {
      id: uniqueId("patch"),
      baseVersion: plan.version,
      origin: "user",
      reason: `用户收起路标：${node.title}`,
      operations: [{ op: "archive_node", nodeId }],
    };
    const next = await commitPatch(planRepository, plan, patch, patch.reason);
    sendJson(response, 200, { plan: next, view: projectView(next) });
    return;
  }

  const nodesMatch = pathname.match(/^\/api\/projects\/([^/]+)\/nodes$/);
  if (request.method === "POST" && nodesMatch) {
    const projectId = decodeURIComponent(requiredMatch(nodesMatch, 1));
    const plan = await planRepository.getPlan(projectId);
    const node = await readBody<PlanNode>(request);
    const patch: PatchProposal = {
      id: uniqueId("patch"),
      baseVersion: plan.version,
      origin: "user",
      reason: "用户新增 Roadmap 节点",
      operations: [{ op: "add_node", node: { ...node, manualFields: node.manualFields ?? [] } }],
    };
    const next = await commitPatch(planRepository, plan, patch, "用户新增 Roadmap 节点");
    sendJson(response, 201, { plan: next, view: projectView(next) });
    return;
  }

  const eventMatch = pathname.match(/^\/api\/projects\/([^/]+)\/events$/);
  if (request.method === "POST" && eventMatch) {
    const projectId = decodeURIComponent(requiredMatch(eventMatch, 1));
    const plan = await planRepository.getPlan(projectId);
    const input = await readBody<Omit<PlanEvent, "id" | "occurredAt" | "confirmed"> & Partial<Pick<PlanEvent, "id" | "occurredAt" | "confirmed">>>(request);
    const event: PlanEvent = {
      ...input,
      id: input.id ?? uniqueId("event"),
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      confirmed: input.confirmed ?? true,
    };
    const validation = validateEvent(event, plan);
    if (!validation.valid) throw new PlanEngineError(validation.issues);
    const workflow = decideWorkflow({
      hasConfirmedGoal: true,
      hasConfirmedContext: true,
      plan,
      event,
    });
    const impact = calculateImpact(plan, event);
    const patch = proposeDeterministicPatch(plan, event, impact.tasksToRescheduleIds);
    const afterPreview = applyPatch(plan, patch, new Date().toISOString());
    await planRepository.savePending(projectId, { event, patch, impact, afterPreview });
    sendJson(response, 202, { event, workflow, impact, patch, before: plan, afterPreview });
    return;
  }

  const diffMatch = pathname.match(/^\/api\/projects\/([^/]+)\/diff$/);
  if (request.method === "GET" && diffMatch) {
    const projectId = decodeURIComponent(requiredMatch(diffMatch, 1));
    sendJson(response, 200, { pending: await planRepository.getPending(projectId) });
    return;
  }

  const applyMatch = pathname.match(/^\/api\/projects\/([^/]+)\/diff\/apply$/);
  if (request.method === "POST" && applyMatch) {
    const projectId = decodeURIComponent(requiredMatch(applyMatch, 1));
    const { patchId } = await readBody<{ patchId: string }>(request);
    const pending = (await planRepository.getPending(projectId)).find((item) => item.patch.id === patchId);
    if (!pending) throw new HttpError(404, `待确认 Patch 不存在：${patchId}`);
    if (!pending.event.confirmed) throw new HttpError(400, "Event 尚未确认");
    const plan = await planRepository.getPlan(projectId);
    const next = await commitPatch(planRepository, plan, pending.patch, pending.patch.reason, pending.event.id);
    await planRepository.removePending(projectId, pending.patch.id);
    sendJson(response, 200, { plan: next, view: projectView(next), appliedPatchId: patchId });
    return;
  }

  throw new HttpError(404, `未找到接口：${request.method ?? "GET"} ${pathname}`);
}

function proposeDeterministicPatch(plan: PlanState, event: PlanEvent, taskIds: string[]): PatchProposal {
  const operations: PatchProposal["operations"] = [];
  if (event.type === "constraint_changed" && event.changes?.weeklyHours !== undefined) {
    operations.push({ op: "set_weekly_hours", weeklyHours: event.changes.weeklyHours });
    for (const nodeId of taskIds) {
      operations.push({
        op: "update_node",
        nodeId,
        changes: { adjustmentReason: event.description },
      });
    }
  }
  if (event.type === "task_completed") {
    for (const nodeId of event.targetNodeIds) {
      operations.push({ op: "update_node", nodeId, changes: { status: "done", adjustmentReason: event.description } });
    }
  }
  if (event.type === "custom") {
    for (const nodeId of event.targetNodeIds) {
      operations.push({ op: "update_node", nodeId, changes: { adjustmentReason: event.description } });
    }
  }
  return {
    id: uniqueId("patch"),
    baseVersion: plan.version,
    origin: "agent",
    reason: event.description,
    eventId: event.id,
    operations,
  };
}

async function commitPatch(
  planRepository: PlanRepository,
  plan: PlanState,
  patch: PatchProposal,
  reason: string,
  eventId?: string,
): Promise<PlanState> {
  const now = new Date().toISOString();
  const next = applyPatch(plan, patch, now);
  next.currentCommitId = String(next.version).padStart(6, "0");
  const commit = createCommit(plan, next, {
    id: next.currentCommitId,
    createdAt: now,
    actor: "user",
    reason,
    ...(eventId ? { eventId } : {}),
  });
  await planRepository.savePlan(next);
  await planRepository.saveCommit(next.projectId, commit);
  return next;
}

async function readBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) throw new HttpError(400, "请求体不能为空");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "请求体不是有效 JSON");
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendDownload(response: ServerResponse, contentType: string, filename: string, body: string | Uint8Array): void {
  response.writeHead(200, {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename}"`,
  });
  response.end(body);
}

function renderPlanMarkdown(plan: PlanState): string {
  const activeNodes = plan.nodes.filter((node) => node.status !== "archived");
  const milestones = activeNodes.filter((node) => node.type === "milestone");
  const lines = [
    `# ${plan.title}`,
    "",
    `> ${plan.goal}`,
    "",
    `- 当前版本：${plan.currentCommitId}`,
    `- 每周投入：${plan.weeklyHours} 小时`,
    `- 最近更新：${plan.updatedAt}`,
    "",
    "## Roadmap",
    "",
  ];
  for (const milestone of milestones) {
    lines.push(`### ${milestone.title}`, "");
    const tasks = activeNodes.filter((node) => node.type === "task" && node.milestoneId === milestone.id);
    for (const task of tasks) {
      const checked = task.status === "done" ? "x" : " ";
      const dates = task.startDate || task.endDate ? ` (${task.startDate ?? "?"} → ${task.endDate ?? "?"})` : "";
      lines.push(`- [${checked}] **${task.title}**${dates}`);
      if (task.deliverable) lines.push(`  - 产出：${task.deliverable}`);
      for (const criterion of task.acceptanceCriteria ?? []) lines.push(`  - 验收：${criterion}`);
    }
    lines.push("");
  }
  lines.push("## Evidence", "");
  for (const evidence of plan.evidence) {
    const source = evidence.sourceUrl ? `[${evidence.sourceTitle ?? evidence.title}](${evidence.sourceUrl})` : evidence.sourceTitle ?? evidence.sourceType;
    lines.push(`- **${evidence.title}** — ${source}`);
    lines.push(`  - ${evidence.summary}`);
    lines.push(`  - 类型：${evidence.contentType}；验证：${evidence.verificationStatus}`);
  }
  return `${lines.join("\n")}\n`;
}

function setCors(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "http://127.0.0.1:5173");
  response.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}

function handleError(response: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  if (error instanceof PlanEngineError) {
    const status = error.issues.some((item) => item.code === "VERSION_CONFLICT") ? 409 : 400;
    sendJson(response, status, { error: "Plan Engine 校验失败", issues: error.issues });
    return;
  }
  console.error(error);
  sendJson(response, 500, { error: "本地服务发生未处理错误" });
}

function requiredMatch(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (!value) throw new HttpError(400, "路径参数缺失");
  return value;
}

function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
