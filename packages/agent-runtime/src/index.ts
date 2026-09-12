import type {
  BaselineProposal,
  CreateProjectInput,
  EvidenceCard,
  EvidencePack,
  PlanEvent,
  PlanNode,
  PlanState,
  ResearchQuestionDraft,
  ResearchRequest,
  ResearchRunResult,
  RouteCandidate,
  ValidationIssue,
  ValidationResult,
} from "@zhilu/contracts";
import { PLAN_SCHEMA_VERSION } from "@zhilu/contracts";

export type WorkflowPhase = "interview" | "research" | "planning" | "updating";

export interface WorkflowInput {
  hasConfirmedGoal: boolean;
  hasConfirmedContext: boolean;
  plan: PlanState | null;
  event?: PlanEvent;
  minimumEvidenceCount?: number;
}

export interface WorkflowDecision {
  phase: WorkflowPhase;
  shouldResearch: boolean;
  reason: string;
  contextScope: "goal_and_context" | "evidence_pack" | "affected_subgraph";
}

export function decideWorkflow(input: WorkflowInput): WorkflowDecision {
  if (!input.hasConfirmedGoal || !input.hasConfirmedContext) {
    return {
      phase: "interview",
      shouldResearch: false,
      reason: "目标或用户背景尚未确认",
      contextScope: "goal_and_context",
    };
  }

  if (!input.plan) {
    return {
      phase: "research",
      shouldResearch: true,
      reason: "首次生成计划需要检索与目标相关的知乎证据",
      contextScope: "goal_and_context",
    };
  }

  if (!input.event) {
    return {
      phase: "planning",
      shouldResearch: input.plan.evidence.length < (input.minimumEvidenceCount ?? 1),
      reason: "已有正式计划，按现有证据生成或解释路线",
      contextScope: "evidence_pack",
    };
  }

  if (input.event.type === "knowledge_gap") {
    return {
      phase: "research",
      shouldResearch: true,
      reason: "现有证据无法回答新的知识缺口，只检索受影响问题",
      contextScope: "affected_subgraph",
    };
  }

  return {
    phase: "updating",
    shouldResearch: false,
    reason: "进度、日期或约束变化可以使用现有计划数据局部调整",
    contextScope: "affected_subgraph",
  };
}

export interface AssembleResearchRequestsInput {
  questions: ResearchQuestionDraft[];
  relevantUserConditions: string[];
  freshness?: string;
  evidenceLimitPerQuestion: number;
  idFactory: (index: number) => string;
}

/**
 * Controller 边界：只校验 Query Planner 的输出并补充调度字段。
 * 这里不生成、改写或合并 Research Question。
 */
export function assembleResearchRequests(input: AssembleResearchRequestsInput): ResearchRequest[] {
  const validation = validateResearchQuestionDrafts(input.questions);
  const issues = [...validation.issues];
  if (!Number.isInteger(input.evidenceLimitPerQuestion) || input.evidenceLimitPerQuestion < 1 || input.evidenceLimitPerQuestion > 12) {
    issues.push({ code: "INVALID_EVIDENCE_LIMIT", message: "每个 Research Question 的 Evidence 上限必须是 1–12", path: "evidenceLimitPerQuestion" });
  }
  if (input.relevantUserConditions.some((condition) => !condition.trim())) {
    issues.push({ code: "EMPTY_USER_CONDITION", message: "相关用户条件不能是空字符串", path: "relevantUserConditions" });
  }
  if (issues.length > 0) throw new ResearchRequestValidationError(issues);

  return input.questions.map((question, index) => ({
    id: input.idFactory(index),
    question: question.question,
    searchQueries: [...question.searchQueries],
    relevantUserConditions: [...input.relevantUserConditions],
    ...(input.freshness ? { freshness: input.freshness } : {}),
    evidenceLimit: input.evidenceLimitPerQuestion,
  }));
}

export function validateResearchQuestionDrafts(questions: ResearchQuestionDraft[]): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (questions.length < 1 || questions.length > 3) {
    issues.push({ code: "QUESTION_COUNT", message: "Query Planner 必须生成 1–3 个 Research Question", path: "questions" });
  }
  const totalQueryCount = questions.reduce((sum, question) => sum + question.searchQueries.length, 0);
  if (totalQueryCount < 6 || totalQueryCount > 10) {
    issues.push({ code: "QUERY_COUNT", message: "全部 Research Question 合计必须包含 6–10 个知乎检索 Query", path: "questions.searchQueries" });
  }
  const normalizedQuestions = new Set<string>();
  const normalizedQueries = new Set<string>();
  for (const [index, question] of questions.entries()) {
    const path = `questions.${index}`;
    if (!question.question.trim()) issues.push({ code: "EMPTY_QUESTION", message: "Research Question 不能为空", path: `${path}.question` });
    if (!question.rationale.trim()) issues.push({ code: "EMPTY_RATIONALE", message: "Research Question 必须说明为什么需要研究", path: `${path}.rationale` });
    const normalizedQuestion = normalizeText(question.question);
    if (normalizedQuestions.has(normalizedQuestion)) issues.push({ code: "DUPLICATE_QUESTION", message: "Research Question 不能重复", path: `${path}.question` });
    normalizedQuestions.add(normalizedQuestion);
    for (const [queryIndex, query] of question.searchQueries.entries()) {
      if (!query.trim()) issues.push({ code: "EMPTY_QUERY", message: "知乎检索 Query 不能为空", path: `${path}.searchQueries.${queryIndex}` });
      const normalizedQuery = normalizeText(query);
      if (normalizedQueries.has(normalizedQuery)) issues.push({ code: "DUPLICATE_QUERY", message: `知乎检索 Query 重复：${query}`, path: `${path}.searchQueries.${queryIndex}` });
      normalizedQueries.add(normalizedQuery);
    }
  }
  return { valid: issues.length === 0, issues };
}

export class ResearchRequestValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("；"));
    this.name = "ResearchRequestValidationError";
  }
}

export function validateProjectCreationInput(input: CreateProjectInput, todayIso: string): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!input.goalContract.goal.trim()) issues.push({ code: "GOAL_REQUIRED", message: "目标不能为空", path: "goalContract.goal" });
  if (!isIsoDate(input.goalContract.targetDate) || input.goalContract.targetDate < todayIso) {
    issues.push({ code: "TARGET_DATE_INVALID", message: "目标日期必须是今天或之后的有效日期", path: "goalContract.targetDate" });
  }
  if (input.goalContract.successCriteria.length === 0 || input.goalContract.successCriteria.some((item) => !item.trim())) {
    issues.push({ code: "SUCCESS_CRITERIA_REQUIRED", message: "至少需要一条可观察的成功标准", path: "goalContract.successCriteria" });
  }
  if (!input.userContext.currentSituation.trim()) issues.push({ code: "CURRENT_SITUATION_REQUIRED", message: "需要说明当前起点", path: "userContext.currentSituation" });
  if (!Number.isFinite(input.userContext.weeklyHours) || input.userContext.weeklyHours < 1 || input.userContext.weeklyHours > 80) {
    issues.push({ code: "WEEKLY_HOURS_INVALID", message: "每周投入必须在 1–80 小时之间", path: "userContext.weeklyHours" });
  }
  if (input.userContext.constraints.length === 0 || input.userContext.constraints.some((item) => !item.trim())) {
    issues.push({ code: "CONSTRAINT_REQUIRED", message: "请填写主要限制；没有时可填写“暂无”", path: "userContext.constraints" });
  }
  if (!input.adaptiveQuestion.trim() || !input.adaptiveAnswer.trim()) {
    issues.push({ code: "ADAPTIVE_ANSWER_REQUIRED", message: "需要回答条件化追问", path: "adaptiveAnswer" });
  }
  if (!input.userContext.confirmed || !input.goalContract.confirmed) {
    issues.push({ code: "CONFIRMATION_REQUIRED", message: "User Context Card 和 Goal Contract 必须由用户确认" });
  }
  if (input.userContext.backgroundNotes && input.userContext.backgroundNotes.length > 100_000) {
    issues.push({ code: "BACKGROUND_TOO_LARGE", message: "背景材料不能超过 100,000 个字符", path: "userContext.backgroundNotes" });
  }
  return { valid: issues.length === 0, issues };
}

/**
 * Research 尚未完成时的确定性准备版，只保存用户已确认事实和下一步流程。
 * 它不会伪造知乎来源，也不替代 Roadmapper 的正式 Baseline。
 */
export function createResearchReadyPlan(input: CreateProjectInput, projectId: string, now: string): PlanState {
  const todayIso = now.slice(0, 10);
  const validation = validateProjectCreationInput(input, todayIso);
  if (!validation.valid) throw new ResearchRequestValidationError(validation.issues);
  const targetDate = input.goalContract.targetDate;
  const firstBoundary = dateAtFraction(todayIso, targetDate, 0.3);
  const secondBoundary = dateAtFraction(todayIso, targetDate, 0.7);
  const success = input.goalContract.successCriteria[0]!.trim();
  const userEvidenceId = "e-user-goal";
  const contextEvidenceId = "e-user-context";
  const pendingEvidenceId = "e-research-pending";
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    projectId,
    title: input.goalContract.goal.trim(),
    goal: `${input.goalContract.goal.trim()}；成功标准：${success}`,
    version: 1,
    currentCommitId: "000001",
    weeklyHours: input.userContext.weeklyHours,
    nodes: [
      starterMilestone("m-start", "起点与问题边界", "in_progress", todayIso, firstBoundary, [userEvidenceId, contextEvidenceId]),
      starterTask("t-confirm", "确认目标、起点与成功标准", "ready", "m-start", todayIso, firstBoundary, Math.max(1, Math.round(input.userContext.weeklyHours * 0.15)), "一份用户确认的 Goal Contract 与 User Context Card", ["目标、期限、成功标准和限制均已确认"], [userEvidenceId, contextEvidenceId]),
      starterMilestone("m-research", "知乎研究与路线选择", "todo", firstBoundary, secondBoundary, [pendingEvidenceId]),
      starterTask("t-research", "检索证据并比较候选路线", "todo", "m-research", firstBoundary, secondBoundary, Math.max(2, Math.round(input.userContext.weeklyHours * 0.35)), "6–12 张 Evidence Cards 与至少两条候选 Route", ["证据可以追溯到来源", "不同条件下的经验被区分而不是强行合并"], [pendingEvidenceId]),
      starterMilestone("m-deliver", "执行、验收与复盘", "todo", secondBoundary, targetDate, [userEvidenceId, pendingEvidenceId]),
      starterTask("t-deliver", `完成可检查成果：${success.slice(0, 30)}`, "todo", "m-deliver", secondBoundary, targetDate, Math.max(2, Math.round(input.userContext.weeklyHours * 0.5)), success, [success, `在 ${targetDate} 前完成并按周复盘`], [userEvidenceId, pendingEvidenceId]),
    ],
    relations: [
      { id: "r-research-after-confirm", type: "depends_on", sourceId: "t-research", targetId: "t-confirm" },
      { id: "r-deliver-after-research", type: "depends_on", sourceId: "t-deliver", targetId: "t-research" },
    ],
    evidence: [
      {
        id: userEvidenceId,
        title: "用户确认的目标与成功标准",
        summary: `${input.goalContract.goal.trim()}；${success}；目标日期 ${targetDate}`,
        sourceType: "user",
        contentType: "user_fact",
        verificationStatus: "verified",
        applicableWhen: ["用于当前项目的目标、期限与验收"],
        caveats: [],
        riskTags: [],
        adoptionReason: "由用户在创建项目时确认",
      },
      {
        id: contextEvidenceId,
        title: "用户确认的当前起点与限制",
        summary: `${input.userContext.currentSituation.trim()}；每周 ${input.userContext.weeklyHours} 小时；限制：${input.userContext.constraints.join("；")}`,
        sourceType: "user",
        contentType: "user_fact",
        verificationStatus: "verified",
        applicableWhen: ["用于控制路线强度与范围"],
        caveats: input.goalContract.tradeoffs,
        riskTags: [],
        adoptionReason: "由用户在 User Context Card 中确认",
      },
      {
        id: pendingEvidenceId,
        title: "知乎研究尚未完成",
        summary: "当前 Roadmap 是研究准备版；候选路线和领域任务必须等 Research Subagent 返回 EvidencePack 后生成。",
        sourceType: "ai",
        contentType: "ai_inference",
        verificationStatus: "unverified",
        applicableWhen: ["仅用于展示从确认目标进入研究阶段的流程"],
        caveats: ["不是知乎证据", "不能作为正式领域建议"],
        riskTags: ["等待知乎研究"],
        adoptionReason: "避免在真实检索完成前伪造来源或领域建议",
      },
    ],
    userContext: structuredClone(input.userContext),
    goalContract: structuredClone(input.goalContract),
    updatedAt: now,
  };
}

export interface MockResearchInput {
  runId: string;
  proposalId: string;
  requestIdFactory: (index: number) => string;
  now: string;
}

export interface LiveResearchInput {
  runId: string;
  proposalId: string;
  questions: ResearchQuestionDraft[];
  requests: ResearchRequest[];
  evidencePacks: EvidencePack[];
  now: string;
}

/**
 * 把真实 Research Provider 返回的 EvidencePack 组装成待确认 Baseline。
 * P0 先使用可解释的确定性路线草案；它不会冒充模型生成，也不会直接写正式 Plan。
 */
export function createLiveBaselineProposal(plan: PlanState, input: LiveResearchInput): BaselineProposal {
  if (!plan.userContext?.confirmed || !plan.goalContract?.confirmed) {
    throw new ResearchRequestValidationError([
      { code: "RESEARCH_CONTEXT_REQUIRED", message: "运行研究前需要已确认的 User Context Card 与 Goal Contract" },
    ]);
  }
  const questionValidation = validateResearchQuestionDrafts(input.questions);
  if (!questionValidation.valid) throw new ResearchRequestValidationError(questionValidation.issues);
  if (input.requests.length !== input.questions.length || input.evidencePacks.length !== input.requests.length) {
    throw new ResearchRequestValidationError([
      { code: "RESEARCH_RESULT_MISMATCH", message: "Research Question、Request 与 EvidencePack 数量必须一致" },
    ]);
  }
  for (const [index, request] of input.requests.entries()) {
    if (input.evidencePacks[index]?.requestId !== request.id) {
      throw new ResearchRequestValidationError([
        { code: "RESEARCH_REQUEST_MISMATCH", message: "EvidencePack 必须对应原 ResearchRequest", path: `evidencePacks.${index}.requestId` },
      ]);
    }
  }
  const evidence = deduplicateEvidence(input.evidencePacks.flatMap((pack) => pack.evidence));
  if (evidence.length < 2) {
    throw new ResearchRequestValidationError([
      { code: "INSUFFICIENT_LIVE_EVIDENCE", message: "至少需要两张真实 Evidence Card 才能比较路线" },
    ]);
  }
  const routes = buildLiveRoutes(plan, evidence);
  const researchRun: ResearchRunResult = {
    id: input.runId,
    mode: "live",
    generatedAt: input.now,
    questions: structuredClone(input.questions),
    requests: structuredClone(input.requests),
    evidencePacks: structuredClone(input.evidencePacks),
    routeCandidates: routes,
  };
  const success = plan.goalContract.successCriteria[0]?.trim() ?? "完成可检查成果";
  const prefersFoundation = /零基础|初学|刚开始|没有.{0,8}(经验|基础|项目)|尚未/iu.test(plan.userContext.currentSituation);
  const recommendedRouteId = prefersFoundation ? "route-live-foundation" : "route-live-outcome";
  return {
    id: input.proposalId,
    projectId: plan.projectId,
    baseVersion: plan.version,
    createdAt: input.now,
    recommendedRouteId,
    researchRun,
    previews: routes.map((route) => ({
      routeId: route.id,
      plan: buildRoutePreview(plan, researchRun, route, evidence, success, input.now),
    })),
  };
}

/**
 * 在真实知乎执行器尚未接入时，用于验证 Controller → EvidencePack → Roadmapper 的产品闭环。
 * 所有卡片都明确标为 AI 推断，不提供虚构 URL，也不能冒充知乎证据。
 */
export function createMockBaselineProposal(plan: PlanState, input: MockResearchInput): BaselineProposal {
  if (!plan.userContext || !plan.goalContract) {
    throw new ResearchRequestValidationError([
      { code: "RESEARCH_CONTEXT_REQUIRED", message: "运行研究前需要已确认的 User Context Card 与 Goal Contract" },
    ]);
  }
  const goal = plan.goalContract.goal.trim();
  const success = plan.goalContract.successCriteria[0]?.trim() ?? "完成可检查成果";
  const questions: ResearchQuestionDraft[] = [
    {
      question: `从“${plan.userContext.currentSituation}”出发，达成“${goal}”通常要先补齐哪些关键能力？`,
      searchQueries: [`${goal} 入门 路线`, `${goal} 零基础 经验`, `${goal} 关键能力`],
      rationale: "先识别起点到目标之间的能力缺口，避免把通用清单直接当成个人路线。",
    },
    {
      question: `在每周 ${plan.weeklyHours} 小时和现有限制下，怎样用可检查成果验证“${success}”？`,
      searchQueries: [`${goal} 实践 项目`, `${goal} 学习 复盘`, `${goal} 常见错误`],
      rationale: "把建议转换成能按周执行、能验收、能根据反馈调整的任务。",
    },
  ];
  const requests = assembleResearchRequests({
    questions,
    relevantUserConditions: [
      plan.userContext.currentSituation,
      `每周可投入 ${plan.weeklyHours} 小时`,
      ...plan.userContext.constraints,
    ],
    evidenceLimitPerQuestion: 6,
    idFactory: input.requestIdFactory,
  });
  const evidence = buildMockEvidence(plan, success);
  const routes = buildMockRoutes(evidence);
  const evidencePacks: EvidencePack[] = requests.map((request, index) => ({
    requestId: request.id,
    evidence: evidence.slice(index * 3, index * 3 + 3),
    routeCandidates: index === 0 ? routes : [],
    unresolvedQuestions: ["等待真实知乎检索后验证适用条件、冲突观点与来源质量"],
  }));
  const researchRun: ResearchRunResult = {
    id: input.runId,
    mode: "mock",
    generatedAt: input.now,
    questions,
    requests,
    evidencePacks,
    routeCandidates: routes,
  };
  return {
    id: input.proposalId,
    projectId: plan.projectId,
    baseVersion: plan.version,
    createdAt: input.now,
    recommendedRouteId: routes[0]!.id,
    researchRun,
    previews: routes.map((route) => ({
      routeId: route.id,
      plan: buildRoutePreview(plan, researchRun, route, evidence, success, input.now),
    })),
  };
}

function buildMockEvidence(plan: PlanState, success: string): EvidenceCard[] {
  const shared = {
    sourceType: "ai" as const,
    contentType: "ai_inference" as const,
    verificationStatus: "unverified" as const,
    sourceTitle: "Mock Research Provider",
    caveats: ["尚未经过真实知乎检索验证", "只能用于演示路线生成与确认机制"],
    riskTags: ["Mock 数据", "等待真实知乎来源"],
  };
  const cards: Array<[string, string, string, string]> = [
    ["先定义可检查终点", `把“${success}”拆成外部可观察的交付物，会比只记录学习时长更容易判断是否抵达。`, "目标有明确成功标准时", "用于把 Goal Contract 转成任务验收条件"],
    ["尽早产出第一版", "先做一个范围很小但完整的成果，再依据真实反馈补弱项，可降低路线长期偏离的风险。", "可以在前 30% 时间内做出雏形时", "用于成果驱动路线的前置任务"],
    ["固定短周期反馈", `每周 ${plan.weeklyHours} 小时适合设置一次小交付和一次复盘，而不是等到终点才验收。`, "每周时间稳定但有限时", "用于设置周节奏和检查点"],
    ["基础能力需要刻意练习", `当前起点是“${plan.userContext?.currentSituation ?? "待确认"}”，应先识别最影响成果的基础动作并重复练习。`, "起点与成功标准之间存在明显技能差距时", "用于基础优先路线的能力节点"],
    ["限制条件应进入任务设计", `限制“${plan.userContext?.constraints.join("；") ?? "暂无"}”需要体现在任务范围和资源选择里。`, "资源、预算或时间会限制路径时", "用于控制路线强度与风险"],
    ["终点前安排一次完整演练", "最后阶段应按真实使用场景走完整流程，并保留反馈与修正时间。", "成果需要由他人或真实场景验收时", "用于最终验收节点"],
  ];
  return cards.map(([title, summary, applicableWhen, adoptionReason], index) => ({
    id: `e-mock-${index + 1}`,
    title,
    summary,
    ...shared,
    applicableWhen: [applicableWhen],
    adoptionReason,
  }));
}

function buildMockRoutes(evidence: EvidenceCard[]): RouteCandidate[] {
  return [
    {
      id: "route-outcome",
      title: "先做出来",
      summary: "用一个最小但完整的成果尽早暴露问题，再按反馈补齐能力。",
      applicableWhen: ["成功标准清晰", "可以较早获得真实反馈"],
      evidenceIds: evidence.slice(0, 3).map((item) => item.id),
      risks: ["第一版质量可能粗糙", "Mock 推断仍需真实知乎来源验证"],
    },
    {
      id: "route-foundation",
      title: "先练基本功",
      summary: "先找出最影响终点的基础能力，通过重复练习后再完成整体验收。",
      applicableWhen: ["当前起点较早", "完整成果失败成本较高"],
      evidenceIds: evidence.slice(3).map((item) => item.id),
      risks: ["容易迟迟不进入真实场景", "Mock 推断仍需真实知乎来源验证"],
    },
  ];
}

function buildLiveRoutes(plan: PlanState, evidence: EvidenceCard[]): RouteCandidate[] {
  const outcomePattern = /实践|项目|成果|反馈|验证|测试|发布|演练|动手|作品|应用/iu;
  let outcomeEvidence = evidence.filter((item) => outcomePattern.test(`${item.title} ${item.summary} ${item.applicableWhen.join(" ")}`));
  let foundationEvidence = evidence.filter((item) => !outcomeEvidence.includes(item));
  if (outcomeEvidence.length === 0 || foundationEvidence.length === 0) {
    const split = Math.max(1, Math.ceil(evidence.length / 2));
    outcomeEvidence = evidence.slice(0, split);
    foundationEvidence = evidence.slice(split);
    if (foundationEvidence.length === 0) foundationEvidence = evidence.slice(-1);
  }
  const p0CoverageRisk = evidence.length < 6 ? ["当前证据少于 P0 目标的 6 张，需要继续补充研究"] : [];
  return [
    liveRoute(
      "route-live-outcome",
      "先用成果验证",
      `尽早把“${plan.goalContract?.successCriteria[0] ?? plan.goal}”变成可检查成果，再根据真实反馈补齐能力。`,
      outcomeEvidence,
      p0CoverageRisk,
    ),
    liveRoute(
      "route-live-foundation",
      "先降低关键风险",
      `先处理最可能阻碍“${plan.goalContract?.goal ?? plan.goal}”的基础能力与限制，再进入完整成果。`,
      foundationEvidence,
      p0CoverageRisk,
    ),
  ];
}

function liveRoute(id: string, title: string, summary: string, evidence: EvidenceCard[], extraRisks: string[]): RouteCandidate {
  return {
    id,
    title,
    summary,
    applicableWhen: uniqueStrings(evidence.flatMap((item) => item.applicableWhen)).slice(0, 3),
    evidenceIds: evidence.map((item) => item.id),
    risks: uniqueStrings([
      ...evidence.flatMap((item) => item.caveats),
      "知乎证据目前仍是未独立验证的研究输入",
      ...extraRisks,
    ]).slice(0, 4),
  };
}

function deduplicateEvidence(evidence: EvidenceCard[]): EvidenceCard[] {
  const byId = new Map<string, EvidenceCard>();
  for (const card of evidence) {
    const existing = byId.get(card.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(card)) {
      throw new ResearchRequestValidationError([
        { code: "EVIDENCE_ID_CONFLICT", message: `Evidence ID 冲突：${card.id}` },
      ]);
    }
    if (!existing) byId.set(card.id, structuredClone(card));
  }
  return [...byId.values()];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function buildRoutePreview(
  plan: PlanState,
  run: ResearchRunResult,
  route: RouteCandidate,
  researchEvidence: EvidenceCard[],
  success: string,
  now: string,
): PlanState {
  const start = now.slice(0, 10);
  const end = plan.goalContract?.targetDate ?? dateAtFraction(start, start, 1);
  const first = dateAtFraction(start, end, 0.3);
  const second = dateAtFraction(start, end, 0.72);
  const baseEvidence = plan.evidence.filter((item) => item.sourceType === "user");
  const evidenceIds = route.evidenceIds;
  const outcomeFirst = route.id === "route-outcome" || route.id === "route-live-outcome";
  const nodes: PlanNode[] = [
    starterMilestone("m-baseline", outcomeFirst ? "做出第一个可见成果" : "补齐最关键的基本功", "in_progress", start, first, evidenceIds),
    starterTask("t-baseline", outcomeFirst ? `定义最小成果：${success.slice(0, 28)}` : "识别并练习最影响终点的基础动作", "ready", "m-baseline", start, first, Math.max(2, Math.round(plan.weeklyHours * 0.35)), outcomeFirst ? "一份可以展示和获取反馈的最小成果" : "一组带记录的基础练习与自测结果", ["产出可以被检查", "记录至少一个暴露出的能力缺口"], evidenceIds),
    starterMilestone("m-feedback", "让现实给路线反馈", "todo", first, second, evidenceIds),
    starterTask("t-feedback", outcomeFirst ? "完成一轮真实反馈并补最短板" : "把基本功组合成一次完整演练", "todo", "m-feedback", first, second, Math.max(2, Math.round(plan.weeklyHours * 0.4)), "一次完整实践、反馈记录和下一轮调整", ["有外部或真实场景反馈", "明确保留、停止和调整的内容"], evidenceIds),
    starterMilestone("m-arrival", "抵达与验收", "todo", second, end, [...evidenceIds, "e-user-goal"]),
    starterTask("t-arrival", `按真实场景验收：${success.slice(0, 30)}`, "todo", "m-arrival", second, end, Math.max(2, Math.round(plan.weeklyHours * 0.25)), success, [success, `在 ${end} 前完成一次完整验收`], [...evidenceIds, "e-user-goal"]),
  ];
  return {
    ...structuredClone(plan),
    version: plan.version + 1,
    currentCommitId: String(plan.version + 1).padStart(6, "0"),
    nodes,
    relations: [
      { id: "r-feedback-after-baseline", type: "depends_on", sourceId: "t-feedback", targetId: "t-baseline" },
      { id: "r-arrival-after-feedback", type: "depends_on", sourceId: "t-arrival", targetId: "t-feedback" },
    ],
    evidence: [...baseEvidence, ...researchEvidence],
    research: {
      mode: run.mode,
      runId: run.id,
      selectedRouteId: route.id,
      routeCandidates: structuredClone(run.routeCandidates),
    },
    updatedAt: now,
  };
}

function starterMilestone(id: string, title: string, status: PlanState["nodes"][number]["status"], startDate: string, endDate: string, evidenceIds: string[]): PlanState["nodes"][number] {
  return { id, type: "milestone", title, status, startDate, endDate, evidenceIds, manualFields: [] };
}

function starterTask(id: string, title: string, status: PlanState["nodes"][number]["status"], milestoneId: string, startDate: string, endDate: string, estimatedHours: number, deliverable: string, acceptanceCriteria: string[], evidenceIds: string[]): PlanState["nodes"][number] {
  return { id, type: "task", title, status, milestoneId, startDate, endDate, estimatedHours, deliverable, acceptanceCriteria, evidenceIds, manualFields: [] };
}

function dateAtFraction(startIso: string, endIso: string, fraction: number): string {
  const start = Date.parse(`${startIso}T00:00:00Z`);
  const end = Date.parse(`${endIso}T00:00:00Z`);
  return new Date(start + Math.max(0, end - start) * fraction).toISOString().slice(0, 10);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}
