import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import type {
  BaselineProposal,
  CreateProjectInput,
  EventProcessingRecord,
  InterviewSession,
  PatchProposal,
  PlanEvent,
  PlanNode,
  PlanNodeUpdate,
  PlanState,
} from "@zhilu/contracts";
import {
  ResearchRequestValidationError,
  compileEventReplan,
  prepareEventReplanInput,
  EventReplanValidationError,
  prepareRoadmapperInput,
  validateRoadmapperPlan,
  RoadmapperValidationError,
  createMockBaselineProposal,
  createResearchReadyPlan,
  decideWorkflow,
  validateProjectCreationInput,
  type LiveResearchInput,
} from "@zhilu/agent-runtime";
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
import { buildM2Context, M2ContextError } from "./m2-context";
import { BoundaryError, validateResearchInput } from "./zhihu-boundary";
import { createZhihuProvider, readZhihuProviderConfig, ZhihuProviderError, type ZhihuProvider } from "./zhihu-provider";
import { createRoadmapperProvider, readRoadmapperConfig, readRoadmapperPlanningBudget, RoadmapperProviderError, type RoadmapperProvider } from "./roadmapper-provider";
import { runResearchController, ResearchControllerError } from "./research-controller";
import { acceptInterviewAnswers, generateInterviewBatch, saveInterviewDraft, InterviewError } from "./interview";
import { reviseBaseline } from "./baseline-revision";
import { compileRoadmapperWithCorrection } from "./roadmapper-generation";
import { createZhidaProvider, readZhidaConfig, ZhidaProviderError, type ZhidaProvider } from "./zhida-provider";
import { createAuth, readAuthConfig, AuthError, type AuthConfig } from "./auth";
import { OperationTracker, reportProgress } from "./operation-progress";
import { RoadmapChatError, runRoadmapChat } from "./roadmap-chat";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const repository = new PlanRepository(
  process.env.ZHILU_DATA_DIR ?? resolve(repoRoot, "data"),
  resolve(repoRoot, "examples/agent-engineer/plan-state.json"),
);
const port = Number(process.env.PORT ?? 8787);

interface LiveEvidenceOptions { authConfig?: AuthConfig; oauthFetch?: typeof fetch; liveEnabled?: boolean; zhihuProvider?: ZhihuProvider; zhidaProvider?: ZhidaProvider;
  researchMode?: "zhida" | "evidence"; roadmapperProvider?: RoadmapperProvider }
interface LiveServices { enabled: boolean; provider: ZhihuProvider | undefined; zhida: ZhidaProvider | undefined;
  researchMode: "zhida" | "evidence"; roadmapper: RoadmapperProvider | undefined; busy: Set<string> }

export function createZhiluServer(planRepository: PlanRepository, options: LiveEvidenceOptions = {}) {
  const live: LiveServices = { enabled: options.liveEnabled ?? process.env.ZHIHU_LIVE_ENABLED === "true",
    provider: options.zhihuProvider, zhida: options.zhidaProvider,
    researchMode: options.researchMode ?? (options.zhidaProvider ? "zhida" : options.zhihuProvider ? "evidence" : process.env.ZHIHU_RESEARCH_MODE === "evidence" ? "evidence" : "zhida"),
    roadmapper: options.roadmapperProvider, busy: new Set<string>() };
  const auth = createAuth(options.authConfig ?? readAuthConfig(), options.oauthFetch);
  const operations = new OperationTracker();
  return createServer(async (request, response) => {
    setCors(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    try {
      if (await auth.handle(request, response)) return;
      const path = new URL(request.url ?? "/", "http://local").pathname;
      let scopedRepository = planRepository;
      let owner = "local";
      if (path.startsWith("/api/") && path !== "/api/health") {
        auth.checkMutation(request);
        response.setHeader("Cache-Control", "no-store");
        if (auth.mode === "zhihu") {
          owner = auth.requireIdentity(request).id;
          scopedRepository = planRepository.forAccount(owner);
        }
      }
      const operationMatch = path.match(/^\/api\/operations\/([a-f0-9-]{36})$/);
      if (request.method === "GET" && operationMatch) {
        const progress = operations.get(owner, operationMatch[1]!);
        sendJson(response, progress ? 200 : 404, progress ?? { error: "尚未收到请求或进度已过期。" });
        return;
      }
      const operationId = request.headers["x-zhilu-operation-id"];
      if (typeof operationId === "string" && /^[a-f0-9-]{36}$/.test(operationId)) {
        if (operations.get(owner, operationId)) throw new HttpError(409, "该请求标识已使用，请重新提交。");
        await operations.run(owner, operationId, () => route(request, response, scopedRepository, live), () => response.statusCode < 400);
      } else await route(request, response, scopedRepository, live);
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
  live: LiveServices,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/api/history") {
    sendJson(response, 200, { interviews: await planRepository.listInterviews(), projects: await planRepository.listProjects() });
    return;
  }
  if (request.method === "POST" && pathname === "/api/interviews") {
    const input = await readBody<{ goal: string; backgroundNotes?: string }>(request);
    if (typeof input?.goal !== "string" || !input.goal.trim() || input.goal.length > 2000) throw new HttpError(400, "请输入 1–2000 字的目标。");
    if (input.backgroundNotes !== undefined && (typeof input.backgroundNotes !== "string" || input.backgroundNotes.length > 100000)) throw new HttpError(400, "背景材料最多 100,000 字符。");
    const now = new Date().toISOString();
    const session: InterviewSession = { id: `interview-${crypto.randomUUID()}`, goal: input.goal.trim(),
      ...(input.backgroundNotes ? { backgroundNotes: input.backgroundNotes } : {}),
      questions: [], answers: [], status: "asking", createdAt: now, updatedAt: now, history: [] };
    await planRepository.saveInterview(session);
    live.busy.add(session.id);
    try { await advanceInterview(session, planRepository, live, response, 201); }
    finally { live.busy.delete(session.id); }
    return;
  }

  const interviewMatch = pathname.match(/^\/api\/interviews\/(interview-[a-f0-9-]{36})(\/(answers|draft|next|finish))?$/);
  if (interviewMatch && (request.method === "GET" || request.method === "POST")) {
    const id = interviewMatch[1]!;
    if (live.busy.has(id)) throw new HttpError(409, "访谈正在保存或生成，请稍候。");
    live.busy.add(id);
    try {
      let session;
      try { session = await planRepository.getInterview(id); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new HttpError(404, "访谈不存在，请从历史记录选择。");
        throw error;
      }
      const action = interviewMatch[3];
      if (request.method === "GET" && !action) { sendJson(response, 200, session); return; }
      if (request.method !== "POST" || !action) throw new HttpError(404, "接口不存在。");
      if (action === "draft") {
        const input = await readBody<{ answers: unknown }>(request);
        session = saveInterviewDraft(session, input?.answers);
        await planRepository.saveInterview(session);
        sendJson(response, 200, session); return;
      }
      if (action === "finish" && session.status !== "asking") throw new HttpError(409, "访谈已结束，请确认背景摘要。");
      if (action === "answers" || action === "finish") {
        const input = await readBody<{ answers: unknown }>(request);
        const hasPending = session.answers.length < session.questions.length;
        if (!hasPending && action === "answers") throw new HttpError(409, "本轮已提交，请继续生成下一批。");
        const answered = hasPending ? acceptInterviewAnswers(session, input?.answers) : session;
        session = { ...answered, ...(action === "finish" ? { finishRequested: true } : {}), draftAnswers: [], updatedAt: new Date().toISOString(),
          history: [...session.history ?? [], { kind: "answers_submitted" as const, at: new Date().toISOString(), questionIds: answered.answers.slice(session.answers.length).map(a => a.questionId) }] };
        // Durable before API calls: a failed model or process restart must not lose answers.
        await planRepository.saveInterview(session);
      } else if (session.status !== "asking" || session.answers.length !== session.questions.length) {
        throw new HttpError(409, "请先回答或跳过当前批次。");
      }
      await advanceInterview(session, planRepository, live, response, 200);
    } finally { live.busy.delete(id); }
    return;
  }

  const reviseMatch = pathname.match(/^\/api\/projects\/([^/]+)\/baseline\/revise$/);
  if (request.method === "POST" && reviseMatch) {
    const { projectId, plan } = await existingLivePlan(planRepository, reviseMatch[1]!);
    const input = await readBody<{ proposalId: string; routeId: string; message: string }>(request);
    if (typeof input?.message !== "string" || !input.message.trim() || input.message.length > 2000) throw new HttpError(400, "调整意见须为 1–2000 字。");
    if (live.busy.has(projectId)) throw new HttpError(409, "当前项目正在生成草稿，请稍候。");
    live.busy.add(projectId);
    try {
      const proposal = (await planRepository.getBaselineProposals(projectId)).find(item => item.id === input.proposalId);
      if (!proposal || proposal.baseVersion !== plan.version) throw new HttpError(409, "计划草稿已更新，请刷新后重试。");
      if (proposal.researchRun.mode !== "live") throw new HttpError(400, "演示草稿不支持真实模型调整，请先生成知乎计划。");
      if (!proposal.previews.some(item => item.routeId === input.routeId)) throw new HttpError(400, "请选择要调整的路线。");
      live.roadmapper ??= createRoadmapperProvider(readRoadmapperConfig());
      const next = await reviseBaseline(plan, proposal, input.routeId, input.message.trim(), live.roadmapper, new Date().toISOString());
      if ((await planRepository.getExistingPlan(projectId)).version !== plan.version) throw new HttpError(409, "调整期间计划已修改，请刷新。");
      // Rotate the public ID so a confirmation of the previous draft cannot apply this revision.
      reportProgress("检查已通过，正在保存调整后的草稿，等待你确认…");
      await planRepository.replaceBaselineProposal(projectId, proposal.id, next);
      sendJson(response, 200, next);
    } finally { live.busy.delete(projectId); }
    return;
  }

  const liveBaselineMatch = pathname.match(/^\/api\/projects\/([^/]+)\/research\/live\/baseline$/);
  if (request.method === "POST" && liveBaselineMatch) {
    await liveBaseline(request, response, planRepository, requiredMatch(liveBaselineMatch, 1), live);
    return;
  }

  const liveMatch = pathname.match(/^\/api\/projects\/([^/]+)\/research\/live\/evidence$/);
  if (request.method === "POST" && liveMatch) {
    await liveEvidence(request, response, planRepository, requiredMatch(liveMatch, 1), live);
    return;
  }

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && pathname === "/api/projects") {
    const input = await readBody<CreateProjectInput>(request);
    let interview: InterviewSession | undefined;
    if (input.interviewId) {
      try { interview = await planRepository.getInterview(input.interviewId); } catch { throw new HttpError(404, "访谈不存在。"); }
      if (interview.status !== "complete") throw new HttpError(409, "请先完成访谈。");
      if (interview.projectId) throw new HttpError(409, "该访谈已生成项目，请从历史记录打开。");
      if (live.busy.has(interview.id)) throw new HttpError(409, "该访谈正在创建项目，请稍候。");
      live.busy.add(interview.id);
    }
    try {
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
    if (interview) await planRepository.saveInterview({ ...interview, projectId, updatedAt: now,
      history: [...interview.history ?? [], { kind: "project_created", at: now }] });
    sendJson(response, 201, {
      projectId,
      plan,
      view: projectView(plan),
      history: [baseline],
      pending: [],
      baselineProposals: [],
      workflow: decideWorkflow({ hasConfirmedGoal: true, hasConfirmedContext: true, plan: null }),
    });
    } finally { if (interview) live.busy.delete(interview.id); }
    return;
  }

  const chatMatch = pathname.match(/^\/api\/projects\/([^/]+)\/chat(?:\/(apply|discard))?$/);
  if (chatMatch && (request.method === "GET" || request.method === "POST")) {
    const projectId = decodeURIComponent(chatMatch[1]!);
    let plan = await planRepository.getExistingPlan(projectId);
    if (request.method === "GET" && !chatMatch[2]) {
      sendJson(response, 200, await planRepository.getRoadmapChat(projectId));
      return;
    }
    if (request.method !== "POST") throw new HttpError(404, "未找到聊天接口。");
    if (live.busy.has(projectId)) throw new HttpError(409, "正在处理当前计划，请等待完成。");
    const body = await readLiveBody(request) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "聊天请求无效。");
    live.busy.add(projectId);
    const abort = new AbortController();
    const disconnect = () => { if (!response.writableEnded) abort.abort(); };
    response.on("close", disconnect);
    try {
      plan = await planRepository.getExistingPlan(projectId);
      const chat = await planRepository.getRoadmapChat(projectId);
      if (chatMatch[2]) {
        const proposal = chat.proposal;
        if (!proposal || proposal.id !== body.proposalId) throw new HttpError(409, "这份方案已被更新，请查看最新对话。");
        if (chatMatch[2] === "discard") {
          if (proposal.status === "applied") throw new HttpError(409, "该方案已经应用。");
          proposal.status = "discarded";
          await planRepository.saveRoadmapChat(projectId, chat);
          sendJson(response, 200, chat);
          return;
        }
        if (proposal.status === "applied") { sendJson(response, 200, chat); return; }
        if (proposal.status !== "pending" || proposal.baseVersion !== plan.version) throw new HttpError(409, "计划已发生变化，请在对话中重新生成方案。");
        const now = new Date().toISOString();
        const next = { ...proposal.afterPreview, updatedAt: now };
        const validation = validatePlan(next);
        if (!validation.valid) throw new PlanEngineError(validation.issues);
        const commit = createCommit(plan, next, { id: next.currentCommitId, createdAt: now, actor: "user", reason: `对话调整：${proposal.summary}` });
        await planRepository.savePlan(next);
        await planRepository.saveCommit(projectId, commit);
        proposal.status = "applied";
        chat.messages.push({ id: crypto.randomUUID(), role: "assistant", content: "已按你确认的方案更新路线图。", createdAt: now, planEffect: "applied", planVersion: proposal.afterPreview.version });
        await planRepository.saveRoadmapChat(projectId, chat);
        sendJson(response, 200, chat);
        return;
      }
      if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 4000) throw new HttpError(400, "请输入 1–4000 字的消息。");
      if (body.baseVersion !== plan.version) throw new HttpError(409, "计划版本已更新，请刷新后继续对话。");
      if (!live.enabled) throw new HttpError(503, "AI 对话尚未启用，请检查服务配置。");
      live.roadmapper ??= createRoadmapperProvider(readRoadmapperConfig());
      chat.messages.push({ id: crypto.randomUUID(), role: "user", content: body.message.trim(), createdAt: new Date().toISOString() });
      await planRepository.saveRoadmapChat(projectId, chat);
      const nextChat = await runRoadmapChat(plan, chat, live.roadmapper, () => live.zhida ??= createZhidaProvider(readZhidaConfig()), abort.signal);
      if (abort.signal.aborted) throw new HttpError(499, "本次对话已停止。");
      if ((await planRepository.getExistingPlan(projectId)).version !== plan.version) throw new HttpError(409, "对话期间计划发生变化，请基于最新计划重试。");
      await planRepository.saveRoadmapChat(projectId, nextChat);
      sendJson(response, 200, nextChat);
    } finally {
      response.off("close", disconnect);
      live.busy.delete(projectId);
    }
    return;
  }

  const planningHistoryMatch = pathname.match(/^\/api\/projects\/([^/]+)\/planning-history$/);
  if (request.method === "GET" && planningHistoryMatch) {
    const projectId = decodeURIComponent(planningHistoryMatch[1]!);
    await planRepository.getExistingPlan(projectId);
    sendJson(response, 200, await planRepository.getPlanningHistory(projectId));
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
      pending: await planRepository.getActivePending(plan),
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
    if (live.busy.has(projectId)) throw new HttpError(409, "计划正在调整，请查看最新草稿后再确认。");
    live.busy.add(projectId);
    try {
      const proposal = (await planRepository.getBaselineProposals(projectId)).find((item) => item.id === proposalId);
      if (!proposal) throw new HttpError(404, `Baseline 提案不存在：${proposalId}`);
      const plan = await planRepository.getPlan(projectId);
      const now = new Date().toISOString();
      reportProgress("正在确认当前草稿并保存路线图，无需再次调用模型…");
      const next = applyBaselineProposal(plan, proposal, routeId, now);
      const route = proposal.researchRun.routeCandidates.find((item) => item.id === routeId);
      const commit = createCommit(plan, next, {
        id: next.currentCommitId,
        createdAt: now,
        actor: "user",
        reason: `用户确认${proposal.researchRun.mode === "live" ? "知乎研究" : " Mock Research"}路线：${route?.title ?? routeId}`,
      });
      await planRepository.savePlan(next);
      await planRepository.saveCommit(projectId, commit);
      await planRepository.removeBaselineProposal(projectId, proposal.id);
      sendJson(response, 200, {
        plan: next,
        view: projectView(next),
        history: await planRepository.getHistory(projectId),
        pending: await planRepository.getActivePending(next),
        baselineProposals: [],
      });
    } finally { live.busy.delete(projectId); }
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
    if (live.busy.has(projectId)) throw new HttpError(409, "正在处理当前计划，请稍后编辑。");
    live.busy.add(projectId);
    try {
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
    } finally { live.busy.delete(projectId); }
    return;
  }

  if (request.method === "DELETE" && nodeMatch) {
    const projectId = decodeURIComponent(requiredMatch(nodeMatch, 1));
    if (live.busy.has(projectId)) throw new HttpError(409, "正在处理当前计划，请稍后编辑。");
    live.busy.add(projectId);
    try {
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
    } finally { live.busy.delete(projectId); }
    return;
  }

  const nodesMatch = pathname.match(/^\/api\/projects\/([^/]+)\/nodes$/);
  if (request.method === "POST" && nodesMatch) {
    const projectId = decodeURIComponent(requiredMatch(nodesMatch, 1));
    if (live.busy.has(projectId)) throw new HttpError(409, "正在处理当前计划，请稍后编辑。");
    live.busy.add(projectId);
    try {
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
    } finally { live.busy.delete(projectId); }
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
    const processing: EventProcessingRecord = {
      mode: "deterministic", researchNeeded: workflow.shouldResearch, researchReason: workflow.reason,
      usedEvidenceIds: [],
      summary: event.type === "constraint_changed" ? "仅预览每周投入约束及调整原因，尚未重新安排任务日期。" : "仅按事件记录状态或调整原因，尚未生成模型调整方案。",
      warnings: workflow.shouldResearch ? ["此事件需要补充研究，当前尚未执行检索。"] : [],
    };
    await planRepository.savePending(projectId, { event, patch, impact, afterPreview, processing });
    sendJson(response, 202, { event, workflow, impact, patch, before: plan, afterPreview, processing });
    return;
  }

  const diffMatch = pathname.match(/^\/api\/projects\/([^/]+)\/diff$/);
  if (request.method === "GET" && diffMatch) {
    const projectId = decodeURIComponent(requiredMatch(diffMatch, 1));
    const plan = await planRepository.getPlan(projectId);
    sendJson(response, 200, { pending: await planRepository.getActivePending(plan) });
    return;
  }

  const replanMatch = pathname.match(/^\/api\/projects\/([^/]+)\/diff\/replan$/);
  if (request.method === "POST" && replanMatch) {
    await replanEvent(request, response, planRepository, requiredMatch(replanMatch, 1), live);
    return;
  }

  const applyMatch = pathname.match(/^\/api\/projects\/([^/]+)\/diff\/apply$/);
  if (request.method === "POST" && applyMatch) {
    const projectId = decodeURIComponent(requiredMatch(applyMatch, 1));
    if (live.busy.has(projectId)) throw new HttpError(409, "当前项目正在生成提案，请等待完成后检查并确认。");
    live.busy.add(projectId);
    try {
    const { patchId } = await readBody<{ patchId: string }>(request);
    const pending = (await planRepository.getPending(projectId)).find((item) => item.patch.id === patchId);
    if (!pending) throw new HttpError(404, `待确认 Patch 不存在：${patchId}`);
    if (pending.afterPreview.projectId !== projectId) throw new HttpError(409, "这份预演不属于当前项目，请基于当前计划重新记录事件。");
    if (!pending.event.confirmed) throw new HttpError(400, "Event 尚未确认");
    const plan = await planRepository.getPlan(projectId);
    const next = await commitPatch(planRepository, plan, pending.patch, pending.patch.reason, pending.event.id, pending.processing);
    await planRepository.removePending(projectId, pending.patch.id);
    sendJson(response, 200, { plan: next, view: projectView(next), appliedPatchId: patchId });
    } finally { live.busy.delete(projectId); }
    return;
  }

  throw new HttpError(404, `未找到接口：${request.method ?? "GET"} ${pathname}`);
}

function proposeDeterministicPatch(plan: PlanState, event: PlanEvent, taskIds: string[]): PatchProposal {
  const operations: PatchProposal["operations"] = [];
  if (event.type === "constraint_changed" && event.changes?.weeklyHours !== undefined) {
    operations.push({ op: "set_weekly_hours", weeklyHours: event.changes.weeklyHours });
    for (const nodeId of taskIds) {
      if (plan.nodes.find(node => node.id === nodeId)?.manualFields.includes("adjustmentReason")) continue;
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
  processing?: EventProcessingRecord,
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
  if (processing) commit.processing = structuredClone(processing);
  await planRepository.savePlan(next);
  await planRepository.saveCommit(next.projectId, commit);
  return next;
}

async function replanEvent(
  request: IncomingMessage,
  response: ServerResponse,
  repository: PlanRepository,
  encodedProjectId: string,
  live: LiveServices,
): Promise<void> {
  let lockedId: string | undefined;
  try {
    if (!live.enabled) throw new HttpError(503, "真实模型调用尚未启用；原规则预演保持不变。");
    const { projectId, plan } = await existingLivePlan(repository, encodedProjectId);
    const body = await readLiveBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1
      || !("patchId" in body) || typeof body.patchId !== "string") throw new HttpError(400, "请求只能包含 patchId。");
    const pending = (await repository.getPending(projectId)).find(item => item.patch.id === body.patchId);
    if (!pending) throw new HttpError(404, "待确认提案不存在，请刷新后重试。");
    if (pending.afterPreview.projectId !== projectId) throw new HttpError(409, "这份预演不属于当前项目，请基于当前计划重新记录事件。");
    if (pending.patch.baseVersion !== plan.version) throw new HttpError(409, "计划已变化，请基于当前版本重新提出事件。");
    const impact = calculateImpact(plan, pending.event);
    const input = prepareEventReplanInput(plan, pending.event, impact);
    if (live.busy.has(projectId)) throw new HttpError(409, "当前项目已有研究或规划正在执行。");
    live.busy.add(projectId); lockedId = projectId;
    // 仅复用模型传输，时间变化不得初始化或调用 Zhihu Provider。
    live.roadmapper ??= createRoadmapperProvider(readRoadmapperConfig());
    reportProgress("我正在根据变化，为受影响的任务重新安排时间…");
    const output = await live.roadmapper.generate(input);
    reportProgress("正在检查新排期的依赖、日期和工时…");
    const result = compileEventReplan(plan, pending.event, impact, input, output, {
      patchId: uniqueId("replan"), runId: uniqueId("event-roadmapper"),
    });
    const current = await repository.getExistingPlan(projectId);
    if (current.version !== plan.version) throw new HttpError(409, "生成期间计划已变化，结果未保存；请重新提出事件。");
    if (result.patch.operations.length === 0) {
      sendJson(response, 200, { unchanged: true, processing: result.processing });
      return;
    }
    const afterPreview = applyPatch(plan, result.patch, new Date().toISOString());
    const proposal = { event: pending.event, impact, afterPreview, ...result };
    await repository.savePending(projectId, proposal);
    // 使用新提案 ID，防止旧页面未经查看就批准了新模型方案。
    await repository.removePending(projectId, pending.patch.id);
    sendJson(response, 202, { ...proposal, before: plan });
  } catch (error) {
    if (error instanceof HttpError) sendJson(response, error.status, { error: error.message });
    else if (error instanceof EventReplanValidationError) sendJson(response, 422, { error: error.message, code: "invalid_replan" });
    else if (error instanceof PlanEngineError) sendJson(response, 422, { error: error.message, issues: error.issues });
    else if (error instanceof RoadmapperProviderError) sendJson(response, error.status, { error: error.message, code: error.code });
    else sendJson(response, 502, { error: "局部排期未完成，未应用任何模型修改；请刷新检查待确认提案。" });
  } finally {
    if (lockedId !== undefined) live.busy.delete(lockedId);
  }
}

async function liveBaseline(
  request: IncomingMessage,
  response: ServerResponse,
  repository: PlanRepository,
  encodedProjectId: string,
  live: LiveServices,
): Promise<void> {
  let lockedId: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const abort = new AbortController();
  const disconnected = () => { if (!response.writableEnded) abort.abort(); };
  response.on("close", disconnected);
  const checkConnection = () => { if (abort.signal.aborted) throw new HttpError(499, "连接已关闭，本次生成已停止。"); };
  try {
    if (!live.enabled) throw new HttpError(503, "真实研究尚未启用，请先配置知乎 CLI 与模型。");
    const { projectId, plan } = await existingLivePlan(repository, encodedProjectId);
    if (!plan.evidence.some((item) => item.riskTags.includes("等待知乎研究"))) {
      throw new HttpError(409, "当前项目已经有 Baseline；新的知识缺口应从 Event 发起。");
    }
    validateRoadmapperPlan(plan, new Date().toISOString());
    const planningBudget = readRoadmapperPlanningBudget();
    if (live.busy.has(projectId)) throw new HttpError(409, "当前项目已有研究正在执行。");
    live.busy.add(projectId);
    lockedId = projectId;
    // 在检索产生调用成本之前确认 Roadmapper 配置可用。
    live.roadmapper ??= createRoadmapperProvider(readRoadmapperConfig());
    let research: LiveResearchInput;
    if (live.researchMode === "zhida") {
      live.zhida ??= createZhidaProvider(readZhidaConfig());
      const context = buildM2Context(plan);
      if (request.headers.accept?.includes("text/event-stream")) {
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
        response.flushHeaders();
        sendResearchEvent(response, "progress", { stage: "research", message: "知乎直答正在整理你的目标与参考内容…" });
        heartbeat = setInterval(() => { if (!response.destroyed && !response.writableEnded) response.write(": heartbeat\n\n"); }, 15000);
      }
      const zhida = await live.zhida.research(context, { signal: abort.signal, onText: text => sendResearchEvent(response, "answer", { text }) });
      checkConnection();
      research = { runId: uniqueId("zhida"), proposalId: uniqueId("baseline"), now: new Date().toISOString(),
        questions: [], requests: [], evidencePacks: [], zhida };
      sendResearchEvent(response, "research", zhida);
      sendResearchEvent(response, "progress", { stage: "planning", message: "回答已完成，正在安排你的行动与时间…" });
    } else {
      live.provider ??= createZhihuProvider(readZhihuProviderConfig());
      research = await runResearchController(plan, live.provider, { evidencePolicy: "allow_insufficient" });
    }
    research.planningBudget = planningBudget;
    const modelInput = prepareRoadmapperInput(plan, research, uniqueId("roadmapper"));
    // A failed M3 can be retried offline/from a snapshot without paying for M2 again.
    await repository.saveResearchSnapshot(plan, research);
    reportProgress("我正在结合知乎证据，生成路线、里程碑和每周任务…");
    const modelOutput = await live.roadmapper.generate(modelInput, { signal: abort.signal });
    checkConnection();
    const proposal = await compileRoadmapperWithCorrection(plan, research, modelInput, modelOutput, live.roadmapper, { signal: abort.signal });
    checkConnection();
    for (const preview of proposal.previews) {
      const validation = validatePlan(preview.plan);
      if (!validation.valid) throw new PlanEngineError(validation.issues);
    }
    if ((await repository.getExistingPlan(projectId)).version !== plan.version) {
      throw new HttpError(409, "规划期间项目已被修改，请刷新后重新规划。");
    }
    const existing = await repository.getBaselineProposals(projectId);
    checkConnection();
    // Once persistence begins, finish replacing the pending draft; formal application remains a separate user action.
    await repository.saveBaselineProposal(projectId, proposal);
    for (const stale of existing) await repository.removeBaselineProposal(projectId, stale.id);
    if (response.headersSent) { sendResearchEvent(response, "proposal", proposal); response.end(); }
    else sendJson(response, 202, proposal);
  } catch (error) {
    if (lockedId && error instanceof ResearchControllerError) {
      try {
        await repository.saveResearchFailure(lockedId, { occurredAt: new Date().toISOString(),
          code: error.code, message: error.message, controller: error.report,
          ...(error.completedResearch ? { completedResearch: error.completedResearch } : {}) });
      } catch { console.warn("研究失败诊断未能保存；原始错误仍返回前端。"); }
    }
    sendLiveError(response, error);
  } finally {
    clearInterval(heartbeat);
    response.off("close", disconnected);
    if (lockedId !== undefined) live.busy.delete(lockedId);
  }
}

async function liveEvidence(request: IncomingMessage, response: ServerResponse, repository: PlanRepository,
  encodedProjectId: string, live: LiveServices): Promise<void> {
  let lockedId: string | undefined;
  try {
    if (!live.enabled) throw new HttpError(503, "真实证据接口尚未启用。");
    const { projectId, plan } = await existingLivePlan(repository, encodedProjectId);
    const context = buildM2Context(plan);
    const body = await readLiveBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || !Object.hasOwn(body, "request")) throw new HttpError(400, "请求只能包含 request。");
    const input = validateResearchInput({...context, request: (body as {request: unknown}).request});
    if (live.busy.has(projectId)) throw new HttpError(409, "当前项目已有研究正在执行。");
    live.busy.add(projectId); lockedId = projectId;
    live.provider ??= createZhihuProvider(readZhihuProviderConfig());
    const result = await live.provider.researchOne(input);
    sendJson(response, 200, {ok: true, result});
  } catch (error) {
    sendLiveError(response, error);
  } finally {
    if (lockedId !== undefined) live.busy.delete(lockedId);
  }
}

async function existingLivePlan(repository: PlanRepository, encodedProjectId: string): Promise<{ projectId: string; plan: PlanState }> {
  let projectId: string;
  try { projectId = decodeURIComponent(encodedProjectId); } catch { throw new HttpError(400, "项目 ID 无效。"); }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId)) throw new HttpError(400, "项目 ID 无效。");
  try {
    return { projectId, plan: await repository.getExistingPlan(projectId) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new HttpError(404, "项目不存在。");
    throw error;
  }
}

function sendLiveError(response: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) sendJson(response, error.status, { error: error.message });
  else if (error instanceof ZhidaProviderError) sendJson(response, error.status, { error: error.message, code: error.code });
  else if (error instanceof ResearchControllerError) sendJson(response, error.status, {
    error: error.message, code: error.code, controller: error.report,
    ...(error.cleanupError ? { cleanupError: error.cleanupError } : {}),
  });
  else if (error instanceof RoadmapperValidationError) sendJson(response, 422, { error: error.message, code: "invalid_roadmap" });
  else if (error instanceof RoadmapperProviderError) sendJson(response, error.status, { error: error.message, code: error.code });
  else if (error instanceof ResearchRequestValidationError) sendJson(response, 422, { error: error.message, issues: error.issues });
  else if (error instanceof M2ContextError) sendJson(response, 409, { error: error.message });
  else if (error instanceof BoundaryError) sendJson(response, error.code === "invalid_request" ? 400 : 502,
    { error: error.code === "invalid_request" ? "研究请求不满足输入约束。" : "研究返回未通过校验。" });
  else if (error instanceof ZhihuProviderError) sendJson(response, error.status, { error: error.message, code: error.code,
    ...(error.cleanupError === "cleanup_failed" ? { cleanupError: "cleanup_failed" } : {}) });
  else sendJson(response, 502, { error: "研究执行失败；未回退 Mock。" });
}

function readLiveBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0; let rejected = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64000) {
        chunks.length = 0;
        if (!rejected) reject(new HttpError(400, "请求体超过 64000 字节。"));
        rejected = true;
      } else if (!rejected) chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      try { resolveBody(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks)))); }
      catch { reject(new HttpError(400, "请求体不是有效 UTF-8 JSON。")); }
    });
    request.on("error", () => reject(new HttpError(400, "无法读取请求体。")));
  });
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
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent && response.getHeader("content-type")?.toString().startsWith("text/event-stream")) {
    sendResearchEvent(response, "error", body);
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendResearchEvent(response: ServerResponse, event: string, value: unknown): void {
  if (!response.headersSent || response.destroyed || response.writableEnded || !response.getHeader("content-type")?.toString().startsWith("text/event-stream")) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
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
  response.setHeader("access-control-allow-headers", "content-type,x-zhilu-operation-id");
}

function handleError(response: ServerResponse, error: unknown): void {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    sendJson(response, 404, { error: "记录不存在，或不属于当前账号。" });
    return;
  }
  if (error instanceof AuthError || error instanceof InterviewError || error instanceof RoadmapperProviderError || error instanceof RoadmapChatError || error instanceof ZhidaProviderError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  if (error instanceof RoadmapperValidationError) {
    sendJson(response, 422, { error: error.message });
    return;
  }
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

async function advanceInterview(session: InterviewSession, repository: PlanRepository, live: LiveServices, response: ServerResponse, status: number) {
  const at = new Date().toISOString();
  try {
    live.roadmapper ??= createRoadmapperProvider(readRoadmapperConfig());
    const next = await generateInterviewBatch(session, live.roadmapper, at.slice(0, 10),
      diagnostic => repository.saveInterviewDiagnostic(diagnostic));
    delete next.generationError;
    next.updatedAt = new Date().toISOString();
    next.history = [...session.history ?? [], { at: next.updatedAt,
      kind: next.status === "complete" ? "summary_generated" : "questions_generated",
      questionIds: next.questions.slice(session.questions.length).map(q => q.id) }];
    await repository.saveInterview(next);
    sendJson(response, status, next);
  } catch (error) {
    const message = error instanceof InterviewError || error instanceof RoadmapperProviderError ? error.message : "模型生成失败；已保存目标和已提交的回答，可继续重试。";
    const saved: InterviewSession = { ...session, updatedAt: new Date().toISOString(), generationError: message,
      history: [...session.history ?? [], { kind: "generation_failed", at, message }] };
    await repository.saveInterview(saved);
    sendJson(response, error instanceof InterviewError || error instanceof RoadmapperProviderError ? error.status : 502, { error: message, session: saved });
  }
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
