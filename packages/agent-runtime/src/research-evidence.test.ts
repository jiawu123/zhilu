import { describe, expect, it } from "vitest";
import type { EvidenceCard, EvidencePack, ResearchCoverage, ResearchRequest, RouteCandidate } from "@zhilu/contracts";
import { aggregateResearchEvidence, ResearchEvidenceError } from "./research-evidence";

function card(id: string, overrides: Partial<EvidenceCard> = {}): EvidenceCard {
  return { id, title: `经验 ${id}`, summary: `先完成可检查的小项目 ${id}`, sourceType: "zhihu", contentType: "experience",
    verificationStatus: "unverified", sourceUrl: `https://www.zhihu.com/question/1/answer/${id.replace(/\D/g, "") || "1"}`,
    sourceTitle: "原问题", author: `作者 ${id}`, supportingQuote: "原始摘要中的短引", retrievedAt: "2026-09-13T00:00:00Z",
    applicableWhen: ["每周有固定学习时间"], caveats: ["案例不能保证相同结果"], riskTags: ["semantic_support_not_checked"],
    adoptionReason: "设计阶段验收", ...overrides };
}
function request(id: string): ResearchRequest {
  return { id, question: `研究问题 ${id}`, searchQueries: [`关键词 ${id}`], relevantUserConditions: ["每周投入 8 小时"], evidenceLimit: 8 };
}
function route(id: string, evidence: EvidenceCard[]): RouteCandidate {
  return { id, title: `项目路线 ${id}`, summary: "先项目再反馈", applicableWhen: ["已有基础"], risks: ["需找反馈者"], evidenceIds: evidence.map(item => item.id) };
}
function pack(id: string, evidence: EvidenceCard[]): EvidencePack {
  return { requestId: id, evidence, routeCandidates: evidence.map(item => route(`route-${item.id}`, [item])), unresolvedQuestions: [] };
}
function coverage(gaps: ResearchCoverage["gaps"]): ResearchCoverage {
  return { status: gaps.length ? "insufficient" : "sufficient", evidenceCount: 3, targetMin: 6, targetMax: 8,
    hasCaveat: true, gaps, reviewStatus: "needs_human_review" };
}
function fixture() {
  const requests = [request("q1"), request("q2")];
  const packs = [pack("q1", [card("e1"), card("e2"), card("e3")]), pack("q2", [card("e4"), card("e5"), card("e6")])];
  return { requests, packs };
}

describe("Controller global research evidence", () => {
  it("recomputes global coverage instead of summing each pack's minimum-six gap", () => {
    const { requests, packs } = fixture();
    for (const item of packs) item.coverage = coverage([{ kind: "evidence_count", reason: "这个问题只有三张" }]);
    const result = aggregateResearchEvidence(requests, packs.reverse());
    expect(result.evidence).toHaveLength(6);
    expect(result.coverage).toMatchObject({ status: "sufficient", evidenceCount: 6, gaps: [], reviewStatus: "needs_human_review" });
    expect(result.evidencePacks.map(item => item.requestId)).toEqual(["q1", "q2"]);
    expect(result.questionCoverage.map(item => item.evidenceIds.length)).toEqual([3, 3]);
  });

  it("does not mutate or upgrade the original cards, quotes or uncertainty flags", () => {
    const { requests, packs } = fixture(), before = structuredClone(packs);
    const result = aggregateResearchEvidence(requests, packs);
    expect(packs).toEqual(before);
    expect(result.evidence.every(item => item.verificationStatus === "unverified")).toBe(true);
    expect(result.evidence[0]).toEqual(packs[0]!.evidence[0]);
    expect(result.evidence[0]!.riskTags).toContain("semantic_support_not_checked");
  });

  it("canonicalizes answer URLs only for deduplication and remaps route references across questions", () => {
    const original = card("e1", { sourceUrl: "https://www.zhihu.com/question/10/answer/100?utm_source=share#reply" });
    const duplicate = { ...original, id: "duplicate", sourceUrl: "https://www.zhihu.com/answer/100/" };
    const requests = [request("q1"), request("q2")], packs = [pack("q1", [original]), pack("q2", [duplicate])];
    const result = aggregateResearchEvidence(requests, packs);
    expect(result.evidence).toEqual([original]);
    expect(result.questionCoverage).toEqual([{ requestId: "q1", evidenceIds: ["e1"] }, { requestId: "q2", evidenceIds: ["e1"] }]);
    expect(result.evidencePacks[1]!.evidence).toEqual([original]);
    expect(result.routeCandidates.every(item => item.evidenceIds.every(id => id === "e1"))).toBe(true);
  });

  it("deduplicates tracking links to articles and whitespace-only claim variants", () => {
    const original = card("e1", { sourceUrl: "https://zhuanlan.zhihu.com/p/100?utm_medium=web", summary: "先做项目 再复盘" });
    const duplicate = { ...original, id: "e2", sourceUrl: "https://zhuanlan.zhihu.com/p/100/", summary: " 先做项目   再复盘 " };
    expect(aggregateResearchEvidence([request("q1")], [pack("q1", [original, duplicate])]).evidence).toHaveLength(1);
  });

  it("preserves opposing claims and different applicability instead of manufacturing consensus", () => {
    const original = card("e1"), opposing = { ...original, id: "e2", summary: "不应先做项目，先补基础" };
    const conditional = { ...original, id: "e3", sourceUrl: "https://www.zhihu.com/answer/3", applicableWhen: ["每天有整块时间"] };
    const result = aggregateResearchEvidence([request("q1")], [pack("q1", [original, opposing, conditional])]);
    expect(result.evidence).toEqual([original, opposing, conditional]);
    expect(result.routeCandidates).toHaveLength(3);
  });

  it("does not deduplicate equal claims with different conditions on the same source", () => {
    const original = card("e1"), conditional = { ...original, id: "e2", applicableWhen: ["需要先补基础"] };
    const result = aggregateResearchEvidence([request("q1")], [pack("q1", [original, conditional])]);
    expect(result.evidence).toHaveLength(2);
  });

  it("caps globally at eight while preserving all questions and a meaningful caveat", () => {
    const requests = [request("q1"), request("q2"), request("q3")];
    const packs = requests.map((item, index) => pack(item.id, Array.from({ length: 8 }, (_, i) => card(`e${index * 10 + i + 1}`, { caveats: [] }))));
    packs[2]!.evidence[7]!.caveats = ["只有小样本经验，不能保证适用"];
    const result = aggregateResearchEvidence(requests, packs);
    expect(result.evidence).toHaveLength(8);
    expect(result.questionCoverage.every(item => item.evidenceIds.length > 0)).toBe(true);
    expect(result.coverage.hasCaveat).toBe(true);
    expect(aggregateResearchEvidence(requests, result.evidencePacks)).toEqual(result);
  });

  it("enforces per-answer and per-author caps after URL canonicalization", () => {
    const evidence = Array.from({ length: 10 }, (_, i) => card(`e${i + 1}`, {
      sourceUrl: i < 4 ? `https://www.zhihu.com/question/${i}/answer/100?utm_source=${i}` : `https://www.zhihu.com/answer/${i}`,
      author: i < 7 ? "同一作者" : `作者${i}`,
    }));
    const result = aggregateResearchEvidence([request("q1")], [pack("q1", evidence)]);
    expect(result.evidence.filter(item => item.sourceUrl!.includes("/answer/100"))).toHaveLength(2);
    expect(result.evidence.filter(item => item.author === "同一作者")).toHaveLength(3);
  });

  it("normalizes author casing and whitespace for diversity limits", () => {
    const evidence = Array.from({ length: 6 }, (_, i) => card(`e${i + 1}`, { author: i % 2 ? " Alice " : "alice" }));
    expect(aggregateResearchEvidence([request("q1")], [pack("q1", evidence)]).evidence).toHaveLength(3);
  });

  it("drops a route if any citation is missing rather than silently weakening its support", () => {
    const { requests, packs } = fixture();
    packs[0]!.routeCandidates = [route("invalid", [card("missing"), packs[0]!.evidence[0]!])];
    const result = aggregateResearchEvidence(requests, packs);
    expect(result.routeCandidates.some(item => item.id === "invalid")).toBe(false);
  });

  it("does not allow a route to borrow an unrelated pack's evidence without its own mapping", () => {
    const { requests, packs } = fixture();
    packs[0]!.routeCandidates = [route("unrelated", [packs[1]!.evidence[0]!])];
    expect(aggregateResearchEvidence(requests, packs).routeCandidates.some(item => item.id === "unrelated")).toBe(false);
  });

  it("reports missing question evidence despite having eight cards elsewhere", () => {
    const requests = [request("q1"), request("q2")];
    const packs = [pack("q1", Array.from({ length: 8 }, (_, i) => card(`e${i + 1}`))), pack("q2", [])];
    const result = aggregateResearchEvidence(requests, packs);
    expect(result.coverage.status).toBe("insufficient");
    expect(result.coverage.gaps.some(gap => gap.kind === "route" && gap.reason.includes("q2"))).toBe(true);
  });

  it("reports condition, caveat and route gaps instead of treating eight cards as complete", () => {
    const evidence = Array.from({ length: 8 }, (_, i) => card(`e${i + 1}`, { applicableWhen: ["  "], caveats: [" "] }));
    const item = pack("q1", evidence); item.routeCandidates = [];
    const result = aggregateResearchEvidence([request("q1")], [item]);
    expect(new Set(result.coverage.gaps.map(gap => gap.kind))).toEqual(new Set(["conditions", "counterevidence", "route"]));
    expect(result.coverage.hasCaveat).toBe(false);
  });

  it("preserves explicit condition gaps across supplemental questions and projection replay", () => {
    const { requests, packs } = fixture();
    const gap = { kind: "conditions" as const, reason: "尚无证据说明低预算条件下是否适用。" };
    packs[0]!.coverage = coverage([gap]);
    requests.push(request("supplemental")); packs.push(pack("supplemental", [card("e7"), card("e8")]));
    const result = aggregateResearchEvidence(requests, packs);
    expect(result.coverage.gaps).toContainEqual(gap);
    expect(result.coverage.status).toBe("insufficient");
    expect(aggregateResearchEvidence(requests, result.evidencePacks)).toEqual(result);
  });

  it("associates a same-question supplement with an initially empty question without merging request records", () => {
    const original = request("q1"), supplemental = { ...request("supplemental"), question: ` ${original.question} ` };
    const evidence = Array.from({ length: 6 }, (_, i) => card(`e${i + 1}`));
    const requests = [original, supplemental], packs = [pack("q1", []), pack("supplemental", evidence)];
    const result = aggregateResearchEvidence(requests, packs);
    expect(result.coverage.status).toBe("sufficient");
    expect(result.questionCoverage.map(item => item.evidenceIds.length)).toEqual([6, 6]);
    expect(result.evidencePacks.map(item => item.requestId)).toEqual(["q1", "supplemental"]);
    expect(packs[0]!.evidence).toEqual([]);
    expect(aggregateResearchEvidence(requests, result.evidencePacks)).toEqual(result);
  });

  it("does not treat a different supplemental question as evidence for an unanswered original question", () => {
    const requests = [request("q1"), request("supplemental")];
    const packs = [pack("q1", []), pack("supplemental", Array.from({ length: 6 }, (_, i) => card(`e${i + 1}`)))];
    const result = aggregateResearchEvidence(requests, packs);
    expect(result.questionCoverage[0]!.evidenceIds).toEqual([]);
    expect(result.coverage.status).toBe("insufficient");
  });

  it("does not transfer same-question evidence across different conditions or freshness requirements", () => {
    const original = request("q1"), evidence = Array.from({ length: 6 }, (_, i) => card(`e${i + 1}`));
    const supplemental = { ...request("supplemental"), question: original.question, relevantUserConditions: ["预算与原问题不同"] };
    const packs = [pack("q1", []), pack("supplemental", evidence)];
    expect(aggregateResearchEvidence([original, supplemental], packs).questionCoverage[0]!.evidenceIds).toEqual([]);
    supplemental.relevantUserConditions = original.relevantUserConditions;
    expect(aggregateResearchEvidence([{ ...original, freshness: "最近一年" }, supplemental], packs).questionCoverage[0]!.evidenceIds).toEqual([]);
  });

  it("keeps explicit semantic gaps even when an exact-question supplement adds cards", () => {
    const original = request("q1"), supplemental = { ...request("supplemental"), question: original.question };
    const initial = pack("q1", []), gap = { kind: "conditions" as const, reason: "尚未说明是否适用于无预算人群。" };
    initial.coverage = coverage([gap]);
    const result = aggregateResearchEvidence([original, supplemental], [initial, pack("supplemental", Array.from({ length: 6 }, (_, i) => card(`e${i + 1}`)))]);
    expect(result.coverage.status).toBe("insufficient");
    expect(result.coverage.gaps).toContainEqual(gap);
  });

  it("recomputes only known structural gaps while retaining specific route/counterevidence gaps", () => {
    const { requests, packs } = fixture();
    const gap = { kind: "route" as const, reason: "路线 B 的先修要求没有依据。" };
    packs[0]!.coverage = coverage([gap, { kind: "counterevidence", reason: "尚无带明确反例或限制说明的证据。" }]);
    const result = aggregateResearchEvidence(requests, packs);
    expect(result.coverage.gaps).toEqual([gap]);
  });

  it("keeps general semantic-review warnings without pretending search can resolve them", () => {
    const { requests, packs } = fixture();
    packs[0]!.unresolvedQuestions = ["semantic_support_not_checked", "来源摘要尚未独立核验"];
    const result = aggregateResearchEvidence(requests, packs);
    expect(result.coverage).toMatchObject({ status: "sufficient", reviewStatus: "needs_human_review" });
    expect(result.evidencePacks[0]!.unresolvedQuestions).toEqual(packs[0]!.unresolvedQuestions);
  });

  it.each(["http://www.zhihu.com/answer/1", "https://zhihu.com.evil.example/answer/1", "https://evil.example/answer/1", "https://user:secret@www.zhihu.com/answer/1", "not-a-url"])("rejects non-Zhihu or unsafe source %s", sourceUrl => {
    expect(() => aggregateResearchEvidence([request("q1")], [pack("q1", [card("e1", { sourceUrl })])])).toThrow(ResearchEvidenceError);
  });

  it("rejects conflicting duplicate evidence IDs", () => {
    const { requests, packs } = fixture();
    packs[1]!.evidence[0] = { ...packs[0]!.evidence[0]!, summary: "不同主张" };
    expect(() => aggregateResearchEvidence(requests, packs)).toThrow("Evidence ID");
  });

  it("accepts repeated IDs with identical data regardless of object key order", () => {
    const first = card("e1"), second = Object.fromEntries(Object.entries(first).reverse()) as unknown as EvidenceCard;
    const result = aggregateResearchEvidence([request("q1"), request("q2")], [pack("q1", [first]), pack("q2", [second])]);
    expect(result.evidence).toHaveLength(1);
    expect(result.questionCoverage.every(item => item.evidenceIds[0] === "e1")).toBe(true);
  });

  it("namespaces cross-pack route ID collisions without merging distinct candidates", () => {
    const { requests, packs } = fixture();
    packs.forEach(item => { item.routeCandidates = [{ ...item.routeCandidates[0]!, id: "route-1" }]; });
    const result = aggregateResearchEvidence(requests, packs);
    expect(result.routeCandidates.map(item => item.id)).toEqual(["q1--route-1", "q2--route-1"]);
    expect(result.routeCandidates.map(item => item.evidenceIds)).toEqual([["e1"], ["e4"]]);
    expect(result.routeCandidates[0]!.summary).toBe(packs[0]!.routeCandidates[0]!.summary);
    expect(aggregateResearchEvidence(requests, result.evidencePacks)).toEqual(result);
  });

  it("avoids collisions between namespaced route IDs and existing IDs", () => {
    const { requests, packs } = fixture();
    packs[0]!.routeCandidates[0]!.id = "route-1";
    packs[0]!.routeCandidates[1]!.id = "q1--route-1";
    packs[1]!.routeCandidates[0]!.id = "route-1";
    const result = aggregateResearchEvidence(requests, packs);
    expect(new Set(result.routeCandidates.map(item => item.id)).size).toBe(result.routeCandidates.length);
    expect(result.routeCandidates.map(item => item.id)).toContain("q1--route-1-2");
    expect(aggregateResearchEvidence(requests, result.evidencePacks)).toEqual(result);
  });

  it("rejects conflicting duplicate route IDs within the same evidence pack", () => {
    const { requests, packs } = fixture();
    packs[0]!.routeCandidates[1]!.id = packs[0]!.routeCandidates[0]!.id;
    expect(() => aggregateResearchEvidence(requests, packs)).toThrow("路线 ID");
  });

  it("rejects duplicate requests, duplicate packs and missing or foreign results", () => {
    const { requests, packs } = fixture();
    expect(() => aggregateResearchEvidence([requests[0]!, requests[0]!], packs)).toThrow(ResearchEvidenceError);
    expect(() => aggregateResearchEvidence(requests, [packs[0]!, packs[0]!])).toThrow(ResearchEvidenceError);
    expect(() => aggregateResearchEvidence(requests, packs.slice(0, 1))).toThrow(ResearchEvidenceError);
    expect(() => aggregateResearchEvidence(requests, [...packs.slice(0, 1), pack("foreign", [])])).toThrow(ResearchEvidenceError);
    expect(() => aggregateResearchEvidence([], [])).toThrow(ResearchEvidenceError);
  });
});
