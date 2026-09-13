export const PLAN_SCHEMA_VERSION = "bundle@1" as const;

export type NodeType =
  | "milestone"
  | "task"
  | "decision"
  | "assumption"
  | "checkpoint";

export type NodeStatus =
  | "draft"
  | "todo"
  | "ready"
  | "in_progress"
  | "blocked"
  | "done"
  | "archived";

export type EvidenceSourceType = "user" | "zhihu" | "official" | "engine" | "ai";

export type EvidenceContentType =
  | "user_fact"
  | "advice"
  | "experience"
  | "opinion"
  | "factual_claim"
  | "rule"
  | "ai_inference";

export type VerificationStatus = "verified" | "unverified" | "not_applicable";

export interface EvidenceCard {
  id: string;
  title: string;
  summary: string;
  sourceType: EvidenceSourceType;
  contentType: EvidenceContentType;
  verificationStatus: VerificationStatus;
  sourceTitle?: string;
  sourceUrl?: string;
  author?: string;
  publishedAt?: string;
  retrievedAt?: string;
  supportingQuote?: string;
  applicableWhen: string[];
  caveats: string[];
  riskTags: string[];
  adoptionReason: string;
}

/** 精确对应 origin/kylee-zhihu-agent 当前 evidence_compiler.py 的卡片输出。 */
export interface ZhihuCompiledEvidenceCard {
  id: string;
  source_id: string;
  source_url: string;
  source_title: string;
  source_scope: "search_snippet";
  claim: string;
  claim_type: "advice" | "experience" | "opinion" | "factual_claim";
  supporting_quote: string;
  quote_start: number;
  quote_end: number;
  citation_status: "exact_match";
  verification_status: "unverified";
  applies_when: string;
  applicability_basis: "ai_inference";
  caveats: string[];
  risk_flags: string[];
}

export interface ZhihuEvidenceCompilerOutput {
  compiler_version: string;
  status: "ok" | "no_evidence";
  reason: string;
  source: {
    id: string;
    provider: "zhihu";
    title: string;
    url: string;
    author: string;
    snippet: string;
    retrievedAt: string | null;
    source_scope: "search_snippet";
  };
  evidence_cards: ZhihuCompiledEvidenceCard[];
}

export interface PlanNode {
  id: string;
  type: NodeType;
  title: string;
  description?: string;
  status: NodeStatus;
  milestoneId?: string;
  startDate?: string;
  endDate?: string;
  estimatedHours?: number;
  deliverable?: string;
  acceptanceCriteria?: string[];
  evidenceIds: string[];
  manualFields: Array<keyof PlanNode>;
  adjustmentReason?: string;
}

export type RelationType = "depends_on" | "supports" | "contradicts" | "invalidates";

export interface PlanRelation {
  id: string;
  type: RelationType;
  sourceId: string;
  targetId: string;
  hard?: boolean;
}

export interface PlanState {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  projectId: string;
  title: string;
  goal: string;
  version: number;
  currentCommitId: string;
  weeklyHours: number;
  nodes: PlanNode[];
  relations: PlanRelation[];
  evidence: EvidenceCard[];
  userContext?: UserContextCard;
  goalContract?: GoalContract;
  research?: PlanResearchState;
  updatedAt: string;
}

export interface PlanResearchState {
  mode: "mock" | "live";
  runId: string;
  selectedRouteId: string;
  routeCandidates: RouteCandidate[];
  roadmapper?: RoadmapperRun;
}

/** 模型只提出草案；Run ID 和批准状态由 Controller / 用户管理。 */
export interface RoadmapperRun {
  runId: string;
  mode: "model";
  recommendationReason: string;
  recommendationEvidenceIds: string[];
  warnings: string[];
}

export type EventType =
  | "constraint_changed"
  | "task_completed"
  | "date_changed"
  | "knowledge_gap"
  | "custom";

export interface PlanEvent {
  id: string;
  type: EventType;
  title: string;
  description: string;
  targetNodeIds: string[];
  occurredAt: string;
  changes?: {
    weeklyHours?: number;
  };
  confirmed: boolean;
}

export type PlanNodeUpdate = Partial<
  Pick<
    PlanNode,
    | "title"
    | "description"
    | "status"
    | "milestoneId"
    | "startDate"
    | "endDate"
    | "estimatedHours"
    | "deliverable"
    | "acceptanceCriteria"
    | "evidenceIds"
    | "adjustmentReason"
  >
>;

export type PatchOperation =
  | { op: "add_node"; node: PlanNode }
  | { op: "update_node"; nodeId: string; changes: PlanNodeUpdate }
  | { op: "archive_node"; nodeId: string }
  | { op: "add_relation"; relation: PlanRelation }
  | { op: "remove_relation"; relationId: string }
  | { op: "set_weekly_hours"; weeklyHours: number };

export interface PatchProposal {
  id: string;
  baseVersion: number;
  origin: "user" | "agent";
  reason: string;
  eventId?: string;
  operations: PatchOperation[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface UserContextCard {
  currentSituation: string;
  weeklyHours: number;
  constraints: string[];
  backgroundNotes?: string;
  confirmed: boolean;
}

export interface GoalContract {
  goal: string;
  targetDate: string;
  successCriteria: string[];
  nonGoals: string[];
  mustHaveOutcomes: string[];
  tradeoffs: string[];
  reviewCadence: "weekly" | "biweekly" | "monthly";
  confirmed: boolean;
}

export interface CreateProjectInput {
  userContext: UserContextCard;
  goalContract: GoalContract;
  adaptiveQuestion: string;
  adaptiveAnswer: string;
}

export interface InterviewQuestion {
  id: string;
  question: string;
  /** Older saved interviews default to single choice. */
  type?: "single" | "multiple" | "text" | "toggle";
  options: Array<{ id: string; label: string; allowsText?: boolean }>;
}

export interface InterviewAnswer {
  questionId: string;
  optionId?: string;
  optionIds?: string[];
  text?: string;
  skipped?: boolean;
}

export interface InterviewSession {
  id: string;
  goal: string;
  backgroundNotes?: string;
  questions: InterviewQuestion[];
  answers: InterviewAnswer[];
  status: "asking" | "complete";
  summary?: CreateProjectInput;
}

export interface ImpactDiff {
  eventId: string;
  affectedNodeIds: string[];
  invalidatedAssumptionIds: string[];
  decisionsToReevaluateIds: string[];
  tasksToRescheduleIds: string[];
  blockedNodeIds: string[];
  unaffectedNodeIds: string[];
}

export interface PlanCommit {
  id: string;
  parentId: string | null;
  planVersion: number;
  createdAt: string;
  actor: "user" | "agent" | "system";
  reason: string;
  eventId?: string;
  processing?: EventProcessingRecord;
  snapshot: PlanState;
}

/** 事件提案的处理依据，由 Controller 写入，不接受模型自报批准或检索状态。 */
export interface EventProcessingRecord {
  mode: "deterministic" | "model";
  researchNeeded: boolean;
  researchReason: string;
  usedEvidenceIds: string[];
  runId?: string;
  summary: string;
  warnings: string[];
}

/** Query Planner 的输出。它只生成问题内容和检索 Query，不分配运行 ID。 */
export interface ResearchQuestionDraft {
  question: string;
  searchQueries: string[];
  rationale: string;
}

/** Workflow Controller 校验、补字段后交给 Research Subagent 执行的请求。 */
export interface ResearchRequest {
  id: string;
  question: string;
  searchQueries: string[];
  relevantUserConditions: string[];
  freshness?: string;
  evidenceLimit: number;
}

export interface EvidencePack {
  requestId: string;
  evidence: EvidenceCard[];
  routeCandidates: RouteCandidate[];
  unresolvedQuestions: string[];
  /** M2 结构覆盖报告；不等同于已验证分歧、事实或可执行路线。 */
  coverage?: ResearchCoverage;
}

export interface ResearchCoverage {
  status: "sufficient" | "insufficient";
  evidenceCount: number;
  targetMin: 6;
  targetMax: 8;
  hasCaveat: boolean;
  gaps: Array<{ kind: "route" | "conditions" | "counterevidence" | "evidence_count"; reason: string }>;
  reviewStatus: "needs_human_review";
}

export interface RouteCandidate {
  id: string;
  title: string;
  summary: string;
  applicableWhen: string[];
  evidenceIds: string[];
  risks: string[];
}

export interface ResearchRunResult {
  id: string;
  mode: "mock" | "live";
  generatedAt: string;
  questions: ResearchQuestionDraft[];
  requests: ResearchRequest[];
  evidencePacks: EvidencePack[];
  routeCandidates: RouteCandidate[];
  controller?: ResearchControllerReport;
}

/** Controller-observed diagnostics, never a claim of semantic or factual verification. */
export interface ResearchControllerReport {
  coverage: ResearchCoverage;
  questionCoverage: Array<{ requestId: string; evidenceIds: string[] }>;
  rounds: number;
  queryBudget: 6;
  queriesAttempted: number;
  searchCallsAttempted: number;
  cacheHits: number;
  stages: Array<{ stage: "plan" | "research" | "supplement"; requestId?: string; durationMs: number; status: string }>;
  stopReason: string;
}

export interface BaselineRoutePreview {
  routeId: string;
  plan: PlanState;
}

export interface BaselineProposal {
  id: string;
  projectId: string;
  baseVersion: number;
  createdAt: string;
  recommendedRouteId: string;
  researchRun: ResearchRunResult;
  previews: BaselineRoutePreview[];
  roadmapper?: RoadmapperRun;
  conversation?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface RoadmapView {
  milestones: Array<{
    milestone: PlanNode;
    tasks: PlanNode[];
  }>;
  ungroupedNodes: PlanNode[];
  relations: PlanRelation[];
}
