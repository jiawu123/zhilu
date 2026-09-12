import { describe, expect, it } from "vitest";
import type { CreateProjectInput, EvidenceCard } from "@zhilu/contracts";
import { createResearchReadyPlan, type LiveResearchInput } from "./index";
import { compileRoadmapperBaseline, prepareRoadmapperInput, RoadmapperValidationError } from "./roadmapper";
import { roadmapperDraftFixture } from "./roadmapper.test-fixture";

function fixture() {
  const user: CreateProjectInput = {
    userContext: { confirmed: true, currentSituation: "已有选题，但还没写完整本书", weeklyHours: 6, constraints: ["读者只能周末交流"], backgroundNotes: "PRIVATE_RAW_DOCUMENT" },
    goalContract: { confirmed: true, goal: "完成短篇小说集", targetDate: "2026-12-04", successCriteria: ["交付三篇经读者反馈后修订的小说"], mustHaveOutcomes: ["完整成稿"], nonGoals: ["不急于出版"], tradeoffs: ["优先内容质量"], reviewCadence: "weekly" },
    adaptiveQuestion: "优先保留什么？", adaptiveAnswer: "读者反馈",
  };
  const plan = createResearchReadyPlan(user, "writing", "2026-09-12T00:00:00Z");
  const cards: EvidenceCard[] = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, title: `写作经验${i}`, summary: "先试写再看反馈".repeat(80),
    sourceType: "zhihu", sourceUrl: `https://www.zhihu.com/question/1/answer/${i}`, supportingQuote: "RAW_QUOTE_NOT_SENT",
    contentType: "experience", verificationStatus: "unverified", applicableWhen: ["已有初稿"], caveats: ["读者反馈可能延迟"], riskTags: ["single_user_experience"], adoptionReason: "用于设计写作验收" }));
  const questions = [{ question: "如何迭代小说章节", searchQueries: ["小说 写作 反馈", "小说 章节 验收"], rationale: "需要成果" },
    { question: "怎样建立写作习惯", searchQueries: ["写作 习惯", "写作 持续练习"], rationale: "控制风险" }];
  const research: LiveResearchInput = { runId: "research-1", proposalId: "proposal-1", now: "2026-09-12T00:00:00Z", questions,
    requests: questions.map((q, i) => ({ ...q, id: `rq${i}`, relevantUserConditions: [], evidenceLimit: 6 })),
    evidencePacks: [{ requestId: "rq0", evidence: cards.slice(0, 5), routeCandidates: [], unresolvedQuestions: ["出版要求尚不确定"] },
      { requestId: "rq1", evidence: cards.slice(5), routeCandidates: [], unresolvedQuestions: [] }] };
  const input = prepareRoadmapperInput(plan, research, "roadmapper-1");
  return { plan, research, input, draft: roadmapperDraftFixture(input) };
}

describe("model Roadmapper", () => {
  it("projects a weekly source-backed plan without mutating the confirmed plan or upgrading evidence", () => {
    const { plan, research, input, draft } = fixture();
    const before = structuredClone(plan);
    const proposal = compileRoadmapperBaseline(plan, research, input, draft);
    expect(plan).toEqual(before);
    expect(proposal.roadmapper?.runId).not.toBe(proposal.researchRun.id);
    const next = proposal.previews[0]!.plan;
    expect(next.nodes.filter(node => node.type === "task")).toHaveLength(12);
    expect(next.nodes.filter(node => node.type === "checkpoint")).toHaveLength(12);
    expect(next.nodes.filter(node => node.type === "milestone")).toHaveLength(3);
    expect(next.nodes.some(node => node.type === "assumption" && node.status === "draft")).toBe(true);
    expect(next.evidence.filter(card => card.sourceType === "zhihu").every(card => card.verificationStatus === "unverified")).toBe(true);
    const inference = next.evidence.find(card => card.sourceType === "ai")!;
    expect(next.nodes.every(node => node.evidenceIds.includes(inference.id))).toBe(true);
    expect(next.research?.roadmapper).toEqual(proposal.roadmapper);
    expect(next.nodes.find(node => node.id === "t12")?.endDate).toBe("2026-12-04");
  });

  it("keeps raw documents, source text and complete plan out of context and bounds evidence", () => {
    const { input } = fixture();
    const payload = JSON.stringify(input);
    expect(payload).not.toContain("PRIVATE_RAW_DOCUMENT");
    expect(payload).not.toContain("RAW_QUOTE_NOT_SENT");
    expect(payload).not.toContain("manualFields");
    expect(input.context.evidence).toHaveLength(8);
    expect(input.context.evidence.every(card => Array.from(card.summary).length <= 300)).toBe(true);
    expect(input.context.evidence.slice(0, 2).map(card => card.id)).toEqual(["e0", "e5"]);
  });

  it("preserves every confirmed condition instead of silently truncating it", () => {
    const { plan, research } = fixture();
    plan.userContext!.constraints = Array.from({ length: 10 }, (_, i) => `${i}项限制：${"必须保留".repeat(90)}`);
    plan.goalContract!.nonGoals = ["最后一个非目标不能被忽略"];
    const input = prepareRoadmapperInput(plan, research, "mapper");
    expect(input.context.user.constraints).toEqual(plan.userContext!.constraints);
    expect(input.context.goal.nonGoals).toEqual(plan.goalContract!.nonGoals);
    plan.userContext!.constraints.push("过长".repeat(10000));
    expect(() => prepareRoadmapperInput(plan, research, "mapper")).toThrow("输入上限");
  });

  it("reserves review time and prorates the final partial week's capacity", () => {
    const { plan, research } = fixture();
    plan.goalContract!.targetDate = "2026-12-05";
    const input = prepareRoadmapperInput(plan, research, "mapper");
    expect(input.context.weeks).toHaveLength(13);
    expect(input.context.weeks[12]).toMatchObject({ startDate: "2026-12-05", endDate: "2026-12-05", capacityHours: 0.85, reviewHours: 0.09 });
  });

  it.each([
    ["invented evidence", (d: ReturnType<typeof roadmapperDraftFixture>) => { d.routes[0]!.tasks[0]!.evidenceIds = ["invented"]; }],
    ["wrong recommendation evidence", (d: ReturnType<typeof roadmapperDraftFixture>) => { d.recommendationEvidenceIds = d.routes[1]!.evidenceIds; }],
    ["weekly overload", (d: ReturnType<typeof roadmapperDraftFixture>) => { d.routes[0]!.tasks[0]!.hours = 6; }],
    ["forward dependency", (d: ReturnType<typeof roadmapperDraftFixture>) => { d.routes[0]!.tasks[0]!.dependsOn = ["t2"]; }],
    ["empty acceptance", (d: ReturnType<typeof roadmapperDraftFixture>) => { d.routes[0]!.tasks[0]!.acceptanceCriteria = []; }],
    ["missing week", (d: ReturnType<typeof roadmapperDraftFixture>) => { d.routes[0]!.tasks.pop(); }],
    ["duplicate route", (d: ReturnType<typeof roadmapperDraftFixture>) => { d.routes[1]!.id = d.routes[0]!.id; }],
    ["fake disagreement", (d: ReturnType<typeof roadmapperDraftFixture>) => { d.routes[1]!.evidenceIds = d.routes[0]!.evidenceIds; }],
    ["decorative route citations", (d: ReturnType<typeof roadmapperDraftFixture>) => { d.routes[0]!.tasks.forEach(task => { task.evidenceIds = ["e-user-goal"]; }); }],
  ])("rejects %s before a proposal can be saved", (_name, mutate) => {
    const { plan, research, input, draft } = fixture();
    mutate(draft);
    expect(() => compileRoadmapperBaseline(plan, research, input, draft)).toThrow(RoadmapperValidationError);
  });

  it("rejects model-supplied approval or source replacement fields", () => {
    const { plan, research, input, draft } = fixture();
    expect(() => compileRoadmapperBaseline(plan, research, input, { ...draft, approved: true })).toThrow(RoadmapperValidationError);
    expect(() => compileRoadmapperBaseline(plan, research, input, { ...draft, evidence: [] })).toThrow(RoadmapperValidationError);
  });

  it("keeps a single route explicit instead of manufacturing two viewpoints", () => {
    const { plan, research, input, draft } = fixture();
    draft.routes.pop();
    const proposal = compileRoadmapperBaseline(plan, research, input, draft);
    expect(proposal.previews).toHaveLength(1);
    expect(proposal.roadmapper?.warnings.join()).toContain("尚未满足两条");
  });

  it("caps evidence from one answer or author and rejects conflicting IDs", () => {
    const { plan, research } = fixture();
    const cards = research.evidencePacks.flatMap(pack => pack.evidence);
    cards.forEach((card, i) => { card.sourceUrl = i < 5 ? "https://www.zhihu.com/question/1/answer/1" : card.sourceUrl!; card.author = "same-author"; });
    const input = prepareRoadmapperInput(plan, research, "mapper");
    expect(input.context.evidence).toHaveLength(3);
    research.evidencePacks[1]!.evidence[0]!.id = research.evidencePacks[0]!.evidence[0]!.id;
    expect(() => prepareRoadmapperInput(plan, research, "mapper")).toThrow("ID");
  });
});
