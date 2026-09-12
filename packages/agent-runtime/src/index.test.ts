import { describe, expect, it } from "vitest";
import fixture from "../../../examples/agent-engineer/plan-state.json";
import eventFixture from "../../../examples/agent-engineer/weekly-hours-event.json";
import type { CreateProjectInput, EvidenceCard, EvidencePack, PlanEvent, PlanState, ResearchQuestionDraft } from "@zhilu/contracts";
import { assembleResearchRequests, createLiveBaselineProposal, createMockBaselineProposal, createResearchReadyPlan, decideWorkflow, validateProjectCreationInput, validateResearchQuestionDrafts } from "./index";

describe("Workflow Controller", () => {
  it("starts with interview before confirmed inputs", () => {
    expect(decideWorkflow({ hasConfirmedGoal: true, hasConfirmedContext: false, plan: null }).phase).toBe(
      "interview",
    );
  });

  it("researches for the first plan", () => {
    expect(decideWorkflow({ hasConfirmedGoal: true, hasConfirmedContext: true, plan: null })).toMatchObject({
      phase: "research",
      shouldResearch: true,
    });
  });

  it("does not research again for a weekly-hours change", () => {
    expect(
      decideWorkflow({
        hasConfirmedGoal: true,
        hasConfirmedContext: true,
        plan: fixture as PlanState,
        event: eventFixture as PlanEvent,
      }),
    ).toMatchObject({ phase: "updating", shouldResearch: false, contextScope: "affected_subgraph" });
  });

  it("researches only the affected subgraph for a knowledge gap", () => {
    const event: PlanEvent = {
      id: "knowledge-gap",
      type: "knowledge_gap",
      title: "资料失效",
      description: "原有学习资料已无法访问",
      targetNodeIds: ["t-rag-baseline"],
      occurredAt: "2026-09-11T00:00:00.000Z",
      confirmed: true,
    };
    expect(
      decideWorkflow({
        hasConfirmedGoal: true,
        hasConfirmedContext: true,
        plan: fixture as PlanState,
        event,
      }),
    ).toMatchObject({ phase: "research", shouldResearch: true, contextScope: "affected_subgraph" });
  });
});

describe("Research Question ownership", () => {
  const questions: ResearchQuestionDraft[] = [
    {
      question: "初学者如何验证自己真正掌握了 Agent 工程能力？",
      rationale: "需要把学习目标转换为可检查的完成标准",
      searchQueries: ["Agent 工程师 入门 验证标准", "Agent 项目 评测 方法", "Agent 学习 只会跑 Demo"],
    },
    {
      question: "有后端基础的人应优先补齐哪些 Agent 能力？",
      rationale: "路线需要利用已有后端基础，避免重复学习",
      searchQueries: ["后端转 Agent 工程师 路线", "Agent 工程 Tool Calling 状态管理", "Agent 可观测性 错误恢复"],
    },
  ];

  it("accepts 1–3 questions and 6–10 deduplicated search queries", () => {
    expect(validateResearchQuestionDrafts(questions)).toEqual({ valid: true, issues: [] });
  });

  it("lets Controller add IDs and limits without rewriting question content", () => {
    const requests = assembleResearchRequests({
      questions,
      relevantUserConditions: ["每周可投入 12 小时", "有 TypeScript 基础"],
      freshness: "近两年优先",
      evidenceLimitPerQuestion: 4,
      idFactory: (index) => `rq-${index + 1}`,
    });
    expect(requests[0]).toMatchObject({
      id: "rq-1",
      question: questions[0]?.question,
      searchQueries: questions[0]?.searchQueries,
      evidenceLimit: 4,
    });
  });

  it("rejects duplicate queries instead of silently rewriting them", () => {
    const duplicated = structuredClone(questions);
    duplicated[1]!.searchQueries[2] = duplicated[0]!.searchQueries[0]!;
    expect(validateResearchQuestionDrafts(duplicated).issues).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_QUERY" }),
    );
  });
});

describe("Project interview output", () => {
  const input: CreateProjectInput = {
    userContext: {
      currentSituation: "有后端经验，但还没有 Agent 项目",
      weeklyHours: 12,
      constraints: ["预算 500 元", "工作日晚间学习"],
      confirmed: true,
    },
    goalContract: {
      goal: "成为 Agent 工程师",
      targetDate: "2026-12-06",
      successCriteria: ["完成一个含评测与工具调用的公开项目"],
      nonGoals: [],
      mustHaveOutcomes: ["公开项目"],
      tradeoffs: ["先保证项目可展示，再扩展功能"],
      reviewCadence: "weekly",
      confirmed: true,
    },
    adaptiveQuestion: "时间有限时最不能放弃什么？",
    adaptiveAnswer: "必须保留公开项目和评测",
  };

  it("requires complete and user-confirmed interview output", () => {
    expect(validateProjectCreationInput(input, "2026-09-11")).toEqual({ valid: true, issues: [] });
    expect(validateProjectCreationInput({ ...input, goalContract: { ...input.goalContract, confirmed: false } }, "2026-09-11").issues).toContainEqual(
      expect.objectContaining({ code: "CONFIRMATION_REQUIRED" }),
    );
  });

  it("creates an honest research-ready plan without fake Zhihu evidence", () => {
    const plan = createResearchReadyPlan(input, "project-test", "2026-09-11T08:00:00.000Z");
    expect(plan).toMatchObject({ projectId: "project-test", version: 1, weeklyHours: 12 });
    expect(plan.nodes.filter((node) => node.type === "milestone")).toHaveLength(3);
    expect(plan.evidence.some((item) => item.sourceType === "zhihu")).toBe(false);
    expect(plan.evidence.find((item) => item.id === "e-research-pending")?.riskTags).toContain("等待知乎研究");
  });

  it("builds two reviewable route previews from clearly marked Mock evidence", () => {
    const plan = createResearchReadyPlan(input, "project-test", "2026-09-11T08:00:00.000Z");
    const proposal = createMockBaselineProposal(plan, {
      runId: "research-test",
      proposalId: "baseline-test",
      requestIdFactory: (index) => `rq-${index + 1}`,
      now: "2026-09-11T09:00:00.000Z",
    });
    expect(proposal.researchRun.questions).toHaveLength(2);
    expect(proposal.researchRun.questions.flatMap((question) => question.searchQueries)).toHaveLength(6);
    expect(proposal.researchRun.routeCandidates).toHaveLength(2);
    expect(proposal.previews).toHaveLength(2);
    const evidence = proposal.researchRun.evidencePacks.flatMap((pack) => pack.evidence);
    expect(evidence).toHaveLength(6);
    expect(evidence.every((item) => item.sourceType === "ai" && !item.sourceUrl)).toBe(true);
    expect(evidence.every((item) => item.riskTags.includes("Mock 数据"))).toBe(true);
    expect(proposal.previews.every((preview) => preview.plan.version === 2)).toBe(true);
  });

  it("builds a pending live Baseline from matching EvidencePacks without changing the current plan", () => {
    const plan = createResearchReadyPlan(input, "project-test", "2026-09-11T08:00:00.000Z");
    const questions: ResearchQuestionDraft[] = [
      { question: "怎样用真实项目验证能力？", rationale: "需要可检查成果", searchQueries: ["真实项目 验证能力", "项目 反馈 复盘", "项目 常见错误"] },
      { question: "哪些基础能力最容易成为阻碍？", rationale: "需要控制风险", searchQueries: ["基础能力 学习路线", "初学者 能力短板", "基础练习 方法"] },
    ];
    const requests = assembleResearchRequests({
      questions,
      relevantUserConditions: [input.userContext.currentSituation],
      evidenceLimitPerQuestion: 4,
      idFactory: (index) => `rq-live-${index + 1}`,
    });
    const evidencePacks: EvidencePack[] = requests.map((request, index) => ({
      requestId: request.id,
      evidence: [liveEvidence(`e-live-${index + 1}`, index === 0 ? "尽早做项目并收集反馈" : "先练习关键基础能力")],
      routeCandidates: [],
      unresolvedQuestions: [],
    }));
    const proposal = createLiveBaselineProposal(plan, {
      runId: "research-live",
      proposalId: "baseline-live",
      questions,
      requests,
      evidencePacks,
      now: "2026-09-11T09:00:00.000Z",
    });

    expect(proposal.researchRun.mode).toBe("live");
    expect(proposal.researchRun.routeCandidates).toHaveLength(2);
    expect(proposal.previews.every((preview) => preview.plan.research?.mode === "live")).toBe(true);
    expect(proposal.previews.flatMap((preview) => preview.plan.evidence).some((item) => item.sourceType === "zhihu")).toBe(true);
    expect(plan.version).toBe(1);
    expect(plan.evidence.some((item) => item.sourceType === "zhihu")).toBe(false);
  });

  it("does not invent two live routes from fewer than two Evidence Cards", () => {
    const plan = createResearchReadyPlan(input, "project-test", "2026-09-11T08:00:00.000Z");
    const questions: ResearchQuestionDraft[] = [
      { question: "怎样验证目标？", rationale: "需要证据", searchQueries: ["验证目标 方法", "目标 实践", "目标 风险"] },
      { question: "怎样规划路线？", rationale: "需要路线", searchQueries: ["规划路线 方法", "路线 复盘", "路线 经验"] },
    ];
    const requests = assembleResearchRequests({ questions, relevantUserConditions: [], evidenceLimitPerQuestion: 4, idFactory: (index) => `rq-${index}` });
    expect(() => createLiveBaselineProposal(plan, {
      runId: "research-live",
      proposalId: "baseline-live",
      questions,
      requests,
      evidencePacks: requests.map((request, index) => ({ requestId: request.id, evidence: index === 0 ? [liveEvidence("only-one", "一张证据")] : [], routeCandidates: [], unresolvedQuestions: [] })),
      now: "2026-09-11T09:00:00.000Z",
    })).toThrow("至少需要两张真实 Evidence Card");
  });
});

function liveEvidence(id: string, title: string): EvidenceCard {
  return {
    id,
    title,
    summary: `${title}，并记录适用条件与风险。`,
    sourceType: "zhihu",
    contentType: "experience",
    verificationStatus: "unverified",
    sourceTitle: `知乎来源 ${id}`,
    sourceUrl: `https://www.zhihu.com/question/1/answer/${encodeURIComponent(id)}`,
    supportingQuote: "应根据实际反馈调整下一步。",
    applicableWhen: ["目标与当前条件匹配时"],
    caveats: ["来自单篇知乎经验"],
    riskTags: ["not_independently_verified"],
    adoptionReason: "用于比较真实研究路线",
  };
}
