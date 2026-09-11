import { describe, expect, it } from "vitest";
import fixture from "../../../examples/agent-engineer/plan-state.json";
import eventFixture from "../../../examples/agent-engineer/weekly-hours-event.json";
import type { PlanEvent, PlanState, ResearchQuestionDraft } from "@zhilu/contracts";
import { assembleResearchRequests, decideWorkflow, validateResearchQuestionDrafts } from "./index";

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
