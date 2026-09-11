import type {
  PlanEvent,
  PlanState,
  ResearchQuestionDraft,
  ResearchRequest,
  ValidationIssue,
  ValidationResult,
} from "@zhilu/contracts";

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

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}
