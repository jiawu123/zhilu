import type { EvidenceCard, EvidencePack, ResearchCoverage, ResearchRequest, RouteCandidate } from "@zhilu/contracts";

export class ResearchEvidenceError extends Error {
  constructor(message: string) { super(message); this.name = "ResearchEvidenceError"; }
}

type Gap = ResearchCoverage["gaps"][number];
type Entry = { card: EvidenceCard; source: string; requests: Set<string> };
const NO_ROUTE = "尚无有引用依据的研究路线候选；不得编造第二条路线。";
const NO_CAVEAT = "尚无带明确反例或限制说明的证据。";

/** Pure structural aggregation. Sufficient means suitable for model/human review, never verified semantics. */
export function aggregateResearchEvidence(requests: ResearchRequest[], packs: EvidencePack[]): {
  evidencePacks: EvidencePack[];
  evidence: EvidenceCard[];
  routeCandidates: RouteCandidate[];
  coverage: ResearchCoverage;
  questionCoverage: Array<{ requestId: string; evidenceIds: string[] }>;
} {
  check(requests.length > 0 && requests.length === packs.length, "研究请求与证据包数量不一致。");
  const requestIds = new Set(requests.map(request => request.id));
  check(requestIds.size === requests.length && requests.every(request => request.id.trim()), "研究请求 ID 重复或为空。");
  check(requests.every(request => request.question.trim()), "研究问题不能为空。");
  const byRequest = new Map(packs.map(pack => [pack.requestId, pack]));
  check(byRequest.size === packs.length && packs.every(pack => requestIds.has(pack.requestId)), "证据包与研究请求不匹配。");
  const ordered = requests.map(request => structuredClone(byRequest.get(request.id)!));
  const originalIds = new Map<string, string>(), byContent = new Map<string, Entry>();
  const aliases = new Map<string, string>(), entries: Entry[] = [];
  // Interleave questions before applying the shared source/author budget.
  const longest = Math.max(...ordered.map(pack => pack.evidence.length));
  for (let index = 0; index < longest; index++) for (const pack of ordered) {
    const card = pack.evidence[index];
    if (!card) continue;
    const source = sourceKey(card), signature = objectSignature(card);
    check(card.id.trim() && (!originalIds.has(card.id) || originalIds.get(card.id) === signature), "同一 Evidence ID 的内容冲突或 ID 为空。");
    originalIds.set(card.id, signature);
    // Do not collapse opposite claims, different conditions or distinct caveats/risk qualifications.
    const fingerprint = JSON.stringify([source, normalized(card.summary), card.contentType, stringsKey(card.applicableWhen),
      stringsKey(card.caveats), stringsKey(card.riskTags), card.verificationStatus]);
    let entry = byContent.get(fingerprint);
    if (!entry) {
      entry = { card, source, requests: new Set() };
      byContent.set(fingerprint, entry); entries.push(entry);
    }
    entry.requests.add(pack.requestId);
    aliases.set(card.id, entry.card.id);
  }
  // A targeted retry may retain the exact question under a new request ID. Share its evidence only
  // when question, user conditions and freshness all match; do not infer equivalence between questions.
  const equivalent = new Map<string, Set<string>>();
  const questionKey = (request: ResearchRequest) => JSON.stringify([normalized(request.question),
    stringsKey(request.relevantUserConditions), normalized(request.freshness ?? "")]);
  for (const request of requests) {
    const key = questionKey(request), ids = equivalent.get(key) ?? new Set<string>();
    ids.add(request.id); equivalent.set(key, ids);
  }
  for (const entry of entries) for (const request of requests) if (entry.requests.has(request.id)) {
    equivalent.get(questionKey(request))!.forEach(id => entry.requests.add(id));
  }

  const selected: Entry[] = [], selectedIds = new Set<string>(), covered = new Set<string>();
  const sourceCounts = new Map<string, number>(), authorCounts = new Map<string, number>();
  let hasCaveat = false;
  while (selected.length < 8) {
    let best: Entry | undefined, bestScore = -1;
    for (const entry of entries) {
      const author = normalized(entry.card.author ?? "").toLowerCase();
      if (selectedIds.has(entry.card.id) || (sourceCounts.get(entry.source) ?? 0) >= 2
        || (author && (authorCounts.get(author) ?? 0) >= 3)) continue;
      const uncovered = [...entry.requests].filter(id => !covered.has(id)).length;
      const score = uncovered * 10 + (!hasCaveat && hasText(entry.card.caveats) ? 5 : 0);
      if (score > bestScore) { best = entry; bestScore = score; }
    }
    if (!best) break;
    selected.push(best); selectedIds.add(best.card.id);
    best.requests.forEach(id => covered.add(id));
    sourceCounts.set(best.source, (sourceCounts.get(best.source) ?? 0) + 1);
    const author = normalized(best.card.author ?? "").toLowerCase();
    if (author) authorCounts.set(author, (authorCounts.get(author) ?? 0) + 1);
    hasCaveat ||= hasText(best.card.caveats);
  }
  // Selection has already applied priorities; stable output ordering makes saved projections replayable.
  selected.sort((a, b) => a.card.id.localeCompare(b.card.id));

  const evidencePacks = ordered.map(pack => {
    const evidence = selected.filter(entry => entry.requests.has(pack.requestId)).map(entry => entry.card);
    const packIds = new Set(pack.evidence.map(card => card.id));
    const routeCandidates: RouteCandidate[] = [];
    const originalRoutes = new Map<string, string>();
    for (const route of pack.routeCandidates) {
      const signature = objectSignature(route);
      check(!originalRoutes.has(route.id) || originalRoutes.get(route.id) === signature, "同一证据包内研究路线 ID 的内容冲突。");
      originalRoutes.set(route.id, signature);
      // Dropping a missing citation could change the claim's support. Drop the whole candidate instead.
      if (!route.id.trim() || !route.title.trim() || !route.summary.trim() || !hasText(route.applicableWhen)
        || !route.evidenceIds.length || !route.evidenceIds.every(id => packIds.has(id) && selectedIds.has(aliases.get(id)!))) continue;
      const candidate = { ...route, evidenceIds: [...new Set(route.evidenceIds.map(id => aliases.get(id)!))] };
      if (!routeCandidates.some(item => item.id === candidate.id)) routeCandidates.push(candidate);
    }
    const retained = (pack.coverage?.gaps ?? []).filter(gap => !isStructuralGap(gap));
    const localCoverage = assess(evidence, routeCandidates, retained);
    const previousGapReasons = new Set(pack.coverage?.gaps.map(gap => gap.reason) ?? []);
    // Generic warnings are retained for review, not guessed to be repairable semantic gaps.
    const unresolvedQuestions = [...new Set([
      ...pack.unresolvedQuestions.filter(reason => !previousGapReasons.has(reason)), ...retained.map(gap => gap.reason),
    ])];
    return { requestId: pack.requestId, evidence, routeCandidates, unresolvedQuestions, coverage: localCoverage };
  });
  // Route IDs are local to each M2 request. Namespace cross-pack collisions without merging viewpoints.
  const routeCounts = new Map<string, number>();
  for (const pack of evidencePacks) for (const route of pack.routeCandidates) routeCounts.set(route.id, (routeCounts.get(route.id) ?? 0) + 1);
  const usedRouteIds = new Set(routeCounts.keys());
  for (const pack of evidencePacks) for (const route of pack.routeCandidates) if (routeCounts.get(route.id)! > 1) {
    const base = `${pack.requestId}--${route.id}`;
    let id = base, suffix = 2;
    while (usedRouteIds.has(id)) id = `${base}-${suffix++}`;
    usedRouteIds.add(id); route.id = id;
  }
  const evidence = selected.map(entry => entry.card), routeCandidates = evidencePacks.flatMap(pack => pack.routeCandidates);
  const retained = evidencePacks.flatMap(pack => pack.coverage.gaps.filter(gap => !isStructuralGap(gap)));
  const questionCoverage = evidencePacks.map(pack => ({ requestId: pack.requestId, evidenceIds: pack.evidence.map(card => card.id) }));
  for (const [index, request] of requests.entries()) {
    const pack = evidencePacks[index]!;
    if (!pack.evidence.length) retained.push({ kind: "route", reason: `问题 ${request.id}「${request.question}」没有入选证据，无法据此作路线决定。` });
    if (hasText(request.relevantUserConditions) && !pack.evidence.some(card => hasText(card.applicableWhen))) {
      retained.push({ kind: "conditions", reason: `问题 ${request.id}「${request.question}」缺少明确适用条件，无法判断建议是否适合用户。` });
    }
  }
  return { evidencePacks, evidence, routeCandidates, coverage: assess(evidence, routeCandidates, retained), questionCoverage };
}

function assess(evidence: EvidenceCard[], routes: RouteCandidate[], retained: Gap[]): ResearchCoverage {
  const gaps: Gap[] = [], hasCaveat = evidence.some(card => hasText(card.caveats));
  if (evidence.length < 6) gaps.push({ kind: "evidence_count", reason: "可用证据少于6张；仅在确有可补充来源时补检索，不凑数。" });
  if (!hasCaveat) gaps.push({ kind: "counterevidence", reason: NO_CAVEAT });
  if (!routes.length) gaps.push({ kind: "route", reason: NO_ROUTE });
  for (const gap of retained) if (!gaps.some(item => item.kind === gap.kind && item.reason === gap.reason)) gaps.push(gap);
  return { status: gaps.length ? "insufficient" : "sufficient", evidenceCount: evidence.length, targetMin: 6, targetMax: 8,
    hasCaveat, gaps, reviewStatus: "needs_human_review" };
}

function isStructuralGap(gap: Gap): boolean {
  // These are the precise structural reports produced by the M2 coverage contract.
  return gap.kind === "evidence_count" || (gap.kind === "route" && gap.reason === NO_ROUTE)
    || (gap.kind === "counterevidence" && gap.reason === NO_CAVEAT);
}

function sourceKey(card: EvidenceCard): string {
  check(card.sourceType === "zhihu" && !!card.sourceUrl, "真实研究只能接收带 HTTPS 来源的知乎证据。");
  let url: URL;
  try { url = new URL(card.sourceUrl!); } catch { throw new ResearchEvidenceError("知乎证据来源 URL 无效。"); }
  check(url.protocol === "https:" && !url.username && !url.password && !url.port
    && (url.hostname === "zhihu.com" || url.hostname.endsWith(".zhihu.com")), "知乎证据来源必须是无凭据的知乎 HTTPS URL。");
  const path = url.pathname.replace(/\/+$/, "");
  const answer = /^(?:\/question\/\d+)?\/answer\/(\d+)$/.exec(path);
  if (answer && ["zhihu.com", "www.zhihu.com", "m.zhihu.com"].includes(url.hostname)) return `https://www.zhihu.com/answer/${answer[1]}`;
  if (["zhihu.com", "m.zhihu.com"].includes(url.hostname)) url.hostname = "www.zhihu.com";
  url.pathname = path; url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}

function normalized(value: string): string { return value.normalize("NFKC").trim().replace(/\s+/g, " "); }
function hasText(values: string[]): boolean { return values.some(value => value.trim().length > 0); }
function stringsKey(values: string[]): string[] { return [...new Set(values.map(normalized).filter(Boolean))].sort(); }
function objectSignature(value: EvidenceCard | RouteCandidate): string {
  return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new ResearchEvidenceError(message); }
