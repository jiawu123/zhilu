import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BaselineProposal, EvidenceCard, EvidencePack, PlanState } from "@zhilu/contracts";
import { aggregateResearchEvidence, compileRoadmapperBaseline, prepareRoadmapperInput, type LiveResearchInput, type RoadmapperInput } from "@zhilu/agent-runtime";
import { roadmapperDraftFixture } from "../../../packages/agent-runtime/src/roadmapper.test-fixture";
import { validatePlan } from "@zhilu/plan-engine";
import { validateResearchRequest } from "./zhihu-boundary";
import { createRoadmapperProvider, readRoadmapperConfig, RoadmapperProviderError, type RoadmapperProvider } from "./roadmapper-provider";

export const MAX_M3_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export interface M3Snapshot { plan: PlanState; research: LiveResearchInput }
export interface M3ReplayOptions { live: boolean; snapshotPath?: string; help: boolean }
export interface M3ReplayReport {
  mode: "offline" | "live";
  status: "structural_pass" | "needs_review" | "failed";
  syntheticModelOutput: boolean;
  provenance: "local_snapshot_not_independently_verified";
  reviewStatus: "needs_human_review";
  formalPlanWritten: false;
  historyWritten: false;
  calls: { zhihu: 0; roadmapper: number; offlineFixture: number };
  durationMs: number;
  modelDurationMs: number;
  evidenceCount: number;
  routeCount: number;
  warnings: string[];
  failureCode?: string;
  snapshotSha256?: string;
}
export interface M3ReplayResult { report: M3ReplayReport; proposal?: BaselineProposal }
type Obj = Record<string, unknown>;
class ReplayError extends Error {
  constructor(readonly code: string) { super(code); }
}
function ensure(condition: unknown, code = "invalid_snapshot"): asserts condition {
  if (!condition) throw new ReplayError(code);
}
function object(value: unknown): Obj {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
  return value as Obj;
}
function keys(value: Obj, required: string[], optional: string[] = []): void {
  ensure(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}
function text(value: unknown, max: number, allowBlank = false): string {
  ensure(typeof value === "string" && [...value].length <= max && (allowBlank || value.trim().length > 0));
  return value;
}
function array(value: unknown, max: number): unknown[] { ensure(Array.isArray(value) && value.length <= max); return value; }
function strings(value: unknown, maxItems: number, maxLength: number): string[] { return array(value, maxItems).map(item => text(item, maxLength)); }
function id(value: unknown): string { const result = text(value, 200); ensure(!/[\p{C}]/u.test(result)); return result; }
function timestamp(value: unknown): number {
  const result = text(value, 80);
  ensure(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(result) && Number.isFinite(Date.parse(result)));
  date(result.slice(0, 10));
  return Date.parse(result);
}
function date(value: unknown): void {
  const result = text(value, 10);
  ensure(/^\d{4}-\d{2}-\d{2}$/u.test(result) && Number.isFinite(Date.parse(result)) && new Date(result).toISOString().slice(0, 10) === result);
}
function inspectJson(value: unknown, depth = 0): void {
  ensure(depth <= 20);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { text(value, 100_000, true); return; }
  if (typeof value === "number") { ensure(Number.isFinite(value)); return; }
  if (Array.isArray(value)) { for (const item of array(value, 1000)) inspectJson(item, depth + 1); return; }
  const record = object(value);
  for (const [key, item] of Object.entries(record)) {
    const normalized = key.replace(/[_\-\s]/gu, "").toLowerCase();
    ensure(!["proto", "prototype", "constructor", "env", "apikey", "apiurl", "model", "secret", "accesssecret", "token", "authorization", "password", "command", "executable", "pythonpath", "pythonexecutable", "deepseekapikey", "roadmapapikey", "roadmapapiurl"].includes(normalized));
    inspectJson(item, depth + 1);
  }
}

function card(value: unknown, zhihu: boolean, now: number): EvidenceCard {
  const c = object(value);
  keys(c, ["id", "title", "summary", "sourceType", "contentType", "verificationStatus", "applicableWhen", "caveats", "riskTags", "adoptionReason"],
    ["sourceTitle", "sourceUrl", "author", "publishedAt", "retrievedAt", "supportingQuote"]);
  id(c.id); text(c.title, 2000); text(c.summary, 4000); text(c.adoptionReason, 2000);
  strings(c.applicableWhen, 8, 1000); strings(c.caveats, 12, 1000); strings(c.riskTags, 32, 200);
  ensure(["user", "zhihu", "official", "engine", "ai"].includes(c.sourceType as string));
  ensure(["user_fact", "advice", "experience", "opinion", "factual_claim", "rule", "ai_inference"].includes(c.contentType as string));
  ensure(["verified", "unverified", "not_applicable"].includes(c.verificationStatus as string));
  if (c.sourceTitle !== undefined) text(c.sourceTitle, 2000);
  if (c.author !== undefined) text(c.author, 2000, true);
  if (c.publishedAt !== undefined) text(c.publishedAt, 80);
  if (c.retrievedAt !== undefined) ensure(timestamp(c.retrievedAt) <= now + 300_000);
  if (c.supportingQuote !== undefined) text(c.supportingQuote, 400);
  if (c.sourceUrl !== undefined) text(c.sourceUrl, 4096);
  if (zhihu) {
    ensure(c.sourceType === "zhihu" && c.verificationStatus === "unverified");
    ensure(["advice", "experience", "opinion", "factual_claim"].includes(c.contentType as string));
    text(c.summary, 1000);
    const url = text(c.sourceUrl, 4096), parsed = new URL(url);
    ensure(parsed.protocol === "https:" && (parsed.hostname === "zhihu.com" || parsed.hostname.endsWith(".zhihu.com"))
      && !parsed.username && !parsed.password && (!parsed.port || parsed.port === "443") && !/[\s\\\p{C}]/u.test(url));
    ensure([...text(c.supportingQuote, 400).trim()].length >= 8);
    ensure(["search_snippet_only", "not_independently_verified", "semantic_support_not_checked"].every(flag => (c.riskTags as string[]).includes(flag)));
  }
  return structuredClone(c) as unknown as EvidenceCard;
}

function planState(value: unknown, researchAt: number): PlanState {
  const p = object(value);
  keys(p, ["schemaVersion", "projectId", "title", "goal", "version", "currentCommitId", "weeklyHours", "nodes", "relations", "evidence", "userContext", "goalContract", "updatedAt"]);
  ensure(p.schemaVersion === "bundle@1" && p.version === 1 && p.currentCommitId === "000001");
  id(p.projectId); text(p.title, 2000); text(p.goal, 4000);
  ensure(timestamp(p.updatedAt) <= researchAt && typeof p.weeklyHours === "number" && p.weeklyHours >= 1 && p.weeklyHours <= 80);
  const user = object(p.userContext), goal = object(p.goalContract);
  keys(user, ["currentSituation", "weeklyHours", "constraints", "confirmed"], ["backgroundNotes"]);
  text(user.currentSituation, 4000); strings(user.constraints, 30, 2000);
  if (user.backgroundNotes !== undefined) text(user.backgroundNotes, 100_000, true);
  ensure(user.confirmed === true && user.weeklyHours === p.weeklyHours);
  keys(goal, ["goal", "targetDate", "successCriteria", "nonGoals", "mustHaveOutcomes", "tradeoffs", "reviewCadence", "confirmed"]);
  text(goal.goal, 2000); date(goal.targetDate);
  const success = strings(goal.successCriteria, 30, 2000);
  for (const field of ["nonGoals", "mustHaveOutcomes", "tradeoffs"]) strings(goal[field], 30, 2000);
  ensure(goal.confirmed === true && ["weekly", "biweekly", "monthly"].includes(goal.reviewCadence as string) && success.length > 0);
  ensure(p.title === (goal.goal as string).trim() && p.goal === `${(goal.goal as string).trim()}；成功标准：${success[0]!.trim()}`, "snapshot_plan_mismatch");
  const evidence = array(p.evidence, 20).map(item => card(item, false, researchAt));
  ensure(new Set(evidence.map(item => item.id)).size === evidence.length && evidence.every(item => item.sourceType === "user" || item.sourceType === "ai"));
  for (const raw of array(p.nodes, 300)) {
    const node = object(raw);
    keys(node, ["id", "type", "title", "status", "evidenceIds", "manualFields"], ["description", "milestoneId", "startDate", "endDate", "estimatedHours", "deliverable", "acceptanceCriteria", "adjustmentReason"]);
    id(node.id); text(node.title, 2000); strings(node.evidenceIds, 20, 200);
    ensure(["milestone", "task", "decision", "assumption", "checkpoint"].includes(node.type as string));
    ensure(["draft", "todo", "ready", "in_progress", "blocked"].includes(node.status as string));
    ensure(array(node.manualFields, 0).length === 0);
    for (const field of ["description", "deliverable", "adjustmentReason"]) if (node[field] !== undefined) text(node[field], 4000);
    if (node.milestoneId !== undefined) id(node.milestoneId);
    for (const field of ["startDate", "endDate"]) if (node[field] !== undefined) date(node[field]);
    if (node.estimatedHours !== undefined) ensure(typeof node.estimatedHours === "number" && node.estimatedHours > 0 && node.estimatedHours <= 1000);
    if (node.acceptanceCriteria !== undefined) strings(node.acceptanceCriteria, 20, 2000);
  }
  for (const raw of array(p.relations, 1000)) {
    const relation = object(raw);
    keys(relation, ["id", "type", "sourceId", "targetId"], ["hard"]);
    id(relation.id); id(relation.sourceId); id(relation.targetId);
    ensure(["depends_on", "supports", "contradicts", "invalidates"].includes(relation.type as string));
    if (relation.hard !== undefined) ensure(typeof relation.hard === "boolean");
  }
  const plan = structuredClone(p) as unknown as PlanState;
  ensure(validatePlan(plan).valid, "snapshot_plan_invalid");
  return plan;
}

function evidencePack(value: unknown, requestId: string, limit: number, now: number): EvidencePack {
  const p = object(value);
  keys(p, ["requestId", "evidence", "routeCandidates", "unresolvedQuestions"], ["coverage"]);
  ensure(p.requestId === requestId, "snapshot_request_mismatch");
  const evidence = array(p.evidence, limit).map(value => card(value, true, now));
  const evidenceIds = new Set(evidence.map(item => item.id));
  ensure(evidenceIds.size === evidence.length);
  const routeIds = new Set<string>();
  for (const raw of array(p.routeCandidates, 8)) {
    const route = object(raw);
    keys(route, ["id", "title", "summary", "applicableWhen", "evidenceIds", "risks"]);
    const routeId = id(route.id); ensure(!routeIds.has(routeId)); routeIds.add(routeId);
    text(route.title, 300); text(route.summary, 1000);
    ensure(strings(route.applicableWhen, 8, 1000).length > 0);
    strings(route.risks, 12, 600);
    const ids = strings(route.evidenceIds, 8, 200);
    ensure(ids.length > 0 && new Set(ids).size === ids.length && ids.every(value => evidenceIds.has(value)));
  }
  strings(p.unresolvedQuestions, 100, 2000);
  if (p.coverage !== undefined) {
    const c = object(p.coverage);
    keys(c, ["status", "evidenceCount", "targetMin", "targetMax", "hasCaveat", "gaps", "reviewStatus"]);
    ensure(["sufficient", "insufficient"].includes(c.status as string) && c.evidenceCount === evidence.length && c.targetMin === 6 && c.targetMax === 8
      && c.hasCaveat === evidence.some(item => item.caveats.length > 0) && c.reviewStatus === "needs_human_review");
    for (const value of array(c.gaps, 12)) {
      const gap = object(value); keys(gap, ["kind", "reason"]);
      ensure(["route", "conditions", "counterevidence", "evidence_count"].includes(gap.kind as string)); text(gap.reason, 2000);
    }
    ensure(c.status !== "sufficient" || (evidence.length >= 6 && c.hasCaveat === true && (c.gaps as unknown[]).length === 0));
  }
  return structuredClone(p) as unknown as EvidencePack;
}

/** Validates local JSON as data, never accepts provider configuration or self-reported approval. */
export function validateM3Snapshot(value: unknown, currentTime = new Date().toISOString()): M3Snapshot {
  try {
    inspectJson(value);
    ensure(Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_M3_SNAPSHOT_BYTES, "snapshot_too_large");
    const snapshot = object(value); keys(snapshot, ["plan", "research"]);
    const r = object(snapshot.research); keys(r, ["runId", "proposalId", "questions", "requests", "evidencePacks", "now"], ["controller"]);
    const now = timestamp(r.now); ensure(now <= timestamp(currentTime) + 300_000, "snapshot_future_time");
    const runId = id(r.runId), proposalId = id(r.proposalId); ensure(runId !== proposalId, "snapshot_run_id_collision");
    const plan = planState(snapshot.plan, now);
    const requests = array(r.requests, 6).map(validateResearchRequest);
    ensure(requests.length > 0 && new Set(requests.map(request => request.id)).size === requests.length);
    requests.forEach(request => id(request.id));
    const questions = array(r.questions, 6).map((raw, index) => {
      const q = object(raw); keys(q, ["question", "searchQueries", "rationale"]);
      const request = requests[index];
      text(q.question, 300); text(q.rationale, 600); const queries = strings(q.searchQueries, 3, 120);
      ensure(request && q.question === request.question && JSON.stringify(queries) === JSON.stringify(request.searchQueries), "snapshot_request_mismatch");
      ensure(request.relevantUserConditions.length <= 32 && request.evidenceLimit <= 8);
      return { question: q.question as string, rationale: q.rationale as string, searchQueries: queries };
    });
    const packs = array(r.evidencePacks, 6);
    ensure(questions.length === requests.length && packs.length === requests.length);
    ensure(requests.reduce((sum, request) => sum + request.searchQueries.length, 0) <= 6, "snapshot_query_budget_exceeded");
    const evidencePacks = packs.map((pack, index) => evidencePack(pack, requests[index]!.id, requests[index]!.evidenceLimit, now));
    const userIds = new Set(plan.evidence.filter(item => item.sourceType === "user").map(item => item.id));
    ensure(evidencePacks.every(pack => pack.evidence.every(card => !userIds.has(card.id))), "snapshot_evidence_id_collision");
    // Controller diagnostics are intentionally discarded. Coverage is recomputed from cards below.
    return { plan, research: { runId, proposalId, now: r.now as string, questions, requests, evidencePacks } };
  } catch (error) {
    if (error instanceof ReplayError) throw error;
    throw new ReplayError("invalid_snapshot");
  }
}

export async function readM3Snapshot(path: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    ensure(stat.isFile(), "snapshot_not_regular_file");
    ensure(stat.size <= MAX_M3_SNAPSHOT_BYTES, "snapshot_too_large");
    const buffer = Buffer.alloc(MAX_M3_SNAPSHOT_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    ensure(count <= MAX_M3_SNAPSHOT_BYTES, "snapshot_too_large");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count))) as unknown;
  } catch (error) {
    if (error instanceof ReplayError) throw error;
    throw new ReplayError("snapshot_read_or_json_failed");
  } finally { await handle?.close(); }
}

export function parseM3ReplayArguments(args: string[]): M3ReplayOptions {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) return { live: false, help: true };
  const options: M3ReplayOptions = { live: false, help: false };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--live" && !options.live) options.live = true;
    else if (args[index] === "--snapshot" && options.snapshotPath === undefined && args[index + 1] && !args[index + 1]!.startsWith("--")) options.snapshotPath = args[++index]!;
    else throw new ReplayError("invalid_arguments");
  }
  ensure(!options.live || options.snapshotPath !== undefined, "live_requires_snapshot");
  return options;
}

export function safeM3ReplayFailure(error: unknown): string {
  if (error instanceof ReplayError) return error.code;
  if (error instanceof RoadmapperProviderError && ["invalid_configuration", "invalid_input", "network_failed", "upstream_failed", "timeout", "output_limit", "invalid_response"].includes(error.code)) return `roadmapper_${error.code}`;
  return "replay_failed";
}

/** Exactly one generate call in live mode; no retry, research, repository or approval capability. */
export async function executeM3Replay(value: unknown, options: { live: boolean }, dependencies: {
  createProvider?: () => RoadmapperProvider;
  offlineGenerate?: (input: RoadmapperInput) => unknown;
  now?: () => string;
} = {}): Promise<M3ReplayResult> {
  const started = performance.now();
  const report: M3ReplayReport = {
    mode: options.live === true ? "live" : "offline", status: "failed", syntheticModelOutput: options.live !== true,
    provenance: "local_snapshot_not_independently_verified", reviewStatus: "needs_human_review", formalPlanWritten: false, historyWritten: false,
    calls: { zhihu: 0, roadmapper: 0, offlineFixture: 0 }, durationMs: 0, modelDurationMs: 0, evidenceCount: 0, routeCount: 0,
    warnings: ["source_and_quote_semantics_need_human_review", "single_run_not_a_latency_or_quality_benchmark"],
  };
  try {
    ensure(typeof options.live === "boolean", "invalid_arguments");
    const { plan, research } = validateM3Snapshot(value, dependencies.now?.() ?? new Date().toISOString());
    ensure(!options.live || !research.evidencePacks.some(pack => pack.evidence.some(card => card.riskTags.includes("synthetic_fixture"))), "live_rejects_synthetic_evidence");
    report.snapshotSha256 = createHash("sha256").update(JSON.stringify({ plan, research })).digest("hex");
    const aggregate = aggregateResearchEvidence(research.requests, research.evidencePacks);
    report.evidenceCount = aggregate.evidence.length;
    ensure(aggregate.coverage.status === "sufficient" && aggregate.evidence.length >= 6 && aggregate.evidence.length <= 8, "research_coverage_insufficient");
    research.evidencePacks = aggregate.evidencePacks;
    const input = prepareRoadmapperInput(plan, research, `m3-replay-${randomUUID()}`);
    ensure(input.context.evidence.length >= 6, "research_coverage_insufficient");
    let output: unknown;
    const modelStarted = performance.now();
    try {
      if (options.live) {
        const provider = dependencies.createProvider?.() ?? createRoadmapperProvider(readRoadmapperConfig(process.env));
        report.calls.roadmapper++;
        output = await provider.generate(input);
      } else {
        report.warnings.push("synthetic_fixture_output_not_live_m3_acceptance");
        report.calls.offlineFixture++;
        output = (dependencies.offlineGenerate ?? roadmapperDraftFixture)(input);
      }
    } finally { report.modelDurationMs = Math.round(performance.now() - modelStarted); }
    let proposal: BaselineProposal;
    try {
      proposal = compileRoadmapperBaseline(plan, research, input, output);
      ensure(proposal.previews.every(preview => validatePlan(preview.plan).valid), "preview_validation_failed");
    } catch { throw new ReplayError("model_output_validation_failed"); }
    report.routeCount = proposal.previews.length;
    if (proposal.roadmapper?.warnings.length) report.warnings.push("proposal_has_review_warnings");
    report.status = proposal.previews.length === 2 ? "structural_pass" : "needs_review";
    if (proposal.previews.length !== 2) report.warnings.push("two_evidence_backed_routes_not_met");
    return { report, proposal };
  } catch (error) {
    report.failureCode = safeM3ReplayFailure(error);
    return { report };
  } finally { report.durationMs = Math.round(performance.now() - started); }
}

export async function saveM3ReplayArtifacts(root: string, result: M3ReplayResult): Promise<string> {
  const base = resolve(root, "data/verification");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const outputDir = resolve(base, `m3-${randomUUID()}`);
  await mkdir(outputDir, { mode: 0o700 });
  if (result.proposal) await writeFile(resolve(outputDir, "preview.json"), JSON.stringify({
    artifactKind: "m3-replay-preview-not-an-approved-plan", mode: result.report.mode,
    syntheticModelOutput: result.report.syntheticModelOutput, reviewStatus: result.report.reviewStatus, proposal: result.proposal,
  }, null, 2), { flag: "wx", mode: 0o600 });
  await writeFile(resolve(outputDir, "report.json"), JSON.stringify(result.report, null, 2), { flag: "wx", mode: 0o600 });
  return outputDir;
}
