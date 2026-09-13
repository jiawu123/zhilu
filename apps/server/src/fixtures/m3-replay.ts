import { createResearchReadyPlan } from "@zhilu/agent-runtime";
import type { EvidenceCard } from "@zhilu/contracts";
import type { M3Snapshot } from "../m3-replay";

/** Deliberately synthetic; these URLs and quotes must never be presented as fetched evidence. */
export function syntheticM3Snapshot(now = new Date().toISOString()): M3Snapshot {
  const targetDate = new Date(Date.parse(now) + 83 * 86_400_000).toISOString().slice(0, 10);
  const plan = createResearchReadyPlan({
    userContext: { confirmed: true, currentSituation: "合成写作用户：已有选题，尚未完成成稿", weeklyHours: 6, constraints: ["每周末收集读者反馈"] },
    goalContract: { confirmed: true, goal: "完成短篇小说集（离线合成样例）", targetDate, successCriteria: ["完成三篇经过读者反馈修订的短篇"],
      nonGoals: ["商业出版"], mustHaveOutcomes: ["可供阅读的完整成稿"], tradeoffs: ["优先反馈质量"], reviewCadence: "weekly" },
    adaptiveQuestion: "最重视什么？", adaptiveAnswer: "可检查的反馈",
  }, "m3-synthetic-fixture", now);
  const questions = [{ question: "如何用试写检查小说选题？", searchQueries: ["小说 试写 反馈"], rationale: "比较实际产出路径" },
    { question: "如何建立写作练习与复盘节奏？", searchQueries: ["小说 练习 复盘"], rationale: "比较练习路径与适用条件" }];
  const requests = questions.map((question, index) => ({ id: `rq-synthetic-${index}`, question: question.question,
    searchQueries: question.searchQueries, relevantUserConditions: ["合成用户每周 6 小时"], evidenceLimit: 8 }));
  const packs = requests.map((request, index) => {
    const evidence: EvidenceCard[] = Array.from({ length: 4 }, (_, cardIndex) => ({ id: `synthetic-${index}-${cardIndex}`,
      title: `离线合成写作经验 ${index}-${cardIndex}`, summary: `离线合成主张 ${index}-${cardIndex}：用章节草稿和读者反馈检查进度。`,
      sourceType: "zhihu", contentType: "experience", verificationStatus: "unverified",
      sourceUrl: `https://www.zhihu.com/question/000/answer/synthetic-${index}-${cardIndex}`,
      author: `synthetic-author-${index}-${cardIndex}`, supportingQuote: `合成引用 ${index}-${cardIndex}：先完成一份草稿，再收集读者具体反馈。`,
      applicableWhen: [index ? "尚需建立写作习惯" : "已有选题及反馈渠道"], caveats: ["合成测试数据，没有进行真实检索"],
      riskTags: ["search_snippet_only", "not_independently_verified", "semantic_support_not_checked", "synthetic_fixture"], adoptionReason: "仅用于验证 M3 编译和计划校验" }));
    return { requestId: request.id, evidence, routeCandidates: [{ id: `candidate-${index}`, title: index ? "先练习" : "先试写",
      summary: "离线合成路线", applicableWhen: [index ? "需要练习习惯" : "具备反馈条件"], evidenceIds: evidence.map(card => card.id),
      risks: ["model_inferred_needs_human_review"] }], unresolvedQuestions: [] };
  });
  return { plan, research: { runId: "research-synthetic", proposalId: "proposal-synthetic", now, questions, requests, evidencePacks: packs } };
}
