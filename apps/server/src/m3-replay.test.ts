import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roadmapperDraftFixture } from "../../../packages/agent-runtime/src/roadmapper.test-fixture";
import type { RoadmapperInput } from "@zhilu/agent-runtime";
import { syntheticM3Snapshot } from "./fixtures/m3-replay";
import { executeM3Replay, MAX_M3_SNAPSHOT_BYTES, parseM3ReplayArguments, readM3Snapshot, saveM3ReplayArtifacts, validateM3Snapshot } from "./m3-replay";
import { RoadmapperProviderError } from "./roadmapper-provider";

const now = "2026-09-13T00:00:00Z";
const folders: string[] = [];
async function folder() { const path = await mkdtemp(join(tmpdir(), "m3-replay-test-")); folders.push(path); return path; }
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

/** Test transport only; removing a fixture marker does not turn test cards into real evidence. */
function transportSnapshot() {
  const snapshot = syntheticM3Snapshot(now);
  snapshot.research.evidencePacks.forEach(pack => pack.evidence.forEach(card => { card.riskTags = card.riskTags.filter(flag => flag !== "synthetic_fixture"); }));
  return snapshot;
}

describe("M3 replay explicit network boundary", () => {
  it("defaults to an offline fixture, with no HTTP/provider initialization or formal writes", async () => {
    const fetch = vi.fn(() => { throw new Error("network forbidden"); }); vi.stubGlobal("fetch", fetch);
    const createProvider = vi.fn(() => { throw new Error("provider forbidden"); });
    const snapshot = syntheticM3Snapshot(now), before = structuredClone(snapshot);
    const result = await executeM3Replay(snapshot, { live: false }, { createProvider, now: () => now });
    expect(result.report).toMatchObject({ mode: "offline", status: "structural_pass", syntheticModelOutput: true,
      calls: { zhihu: 0, roadmapper: 0, offlineFixture: 1 }, formalPlanWritten: false, historyWritten: false, reviewStatus: "needs_human_review", routeCount: 2 });
    expect(result.report.warnings).toContain("synthetic_fixture_output_not_live_m3_acceptance");
    expect(snapshot).toEqual(before);
    expect(fetch).not.toHaveBeenCalled(); expect(createProvider).not.toHaveBeenCalled();
  });

  it("only calls the live provider once and does not send raw quotes or background notes", async () => {
    const snapshot = transportSnapshot(); snapshot.plan.userContext!.backgroundNotes = "PRIVATE_BACKGROUND_DO_NOT_SEND";
    const generate = vi.fn(async input => roadmapperDraftFixture(input as RoadmapperInput));
    const result = await executeM3Replay(snapshot, { live: true }, { createProvider: () => ({ generate }), now: () => now });
    expect(result.report).toMatchObject({ status: "structural_pass", calls: { roadmapper: 1, zhihu: 0, offlineFixture: 0 } });
    expect(generate).toHaveBeenCalledTimes(1);
    const payload = JSON.stringify(generate.mock.calls[0]);
    expect(payload).not.toContain("PRIVATE_BACKGROUND_DO_NOT_SEND");
    expect(payload).not.toContain(snapshot.research.evidencePacks[0]!.evidence[0]!.supportingQuote);
    expect(JSON.stringify(result.report)).not.toContain("PRIVATE_BACKGROUND_DO_NOT_SEND");
    expect(result.proposal!.previews.every(preview => preview.plan.version === 2)).toBe(true);
    expect(snapshot.plan.version).toBe(1);
  });

  it.each([
    [new Error("SECRET_UPSTREAM_CONTEXT"), "replay_failed"],
    [new RoadmapperProviderError("upstream_failed"), "roadmapper_upstream_failed"],
    [new RoadmapperProviderError("timeout"), "roadmapper_timeout"],
  ])("redacts transport failure and never retries", async (error, failureCode) => {
    const generate = vi.fn(async () => { throw error; });
    const result = await executeM3Replay(transportSnapshot(), { live: true }, { createProvider: () => ({ generate }), now: () => now });
    expect(result.report).toMatchObject({ status: "failed", failureCode, calls: { roadmapper: 1, zhihu: 0 } });
    expect(generate).toHaveBeenCalledTimes(1); expect(result.proposal).toBeUndefined();
    expect(JSON.stringify(result.report)).not.toContain("SECRET_UPSTREAM_CONTEXT");
  });

  it("rejects a malformed fixture model output and does not persist a preview", async () => {
    const result = await executeM3Replay(syntheticM3Snapshot(now), { live: false }, { offlineGenerate: () => ({ approved: true, secret: "do-not-log" }), now: () => now });
    expect(result.report).toMatchObject({ status: "failed", failureCode: "model_output_validation_failed", calls: { roadmapper: 0, offlineFixture: 1 } });
    expect(result.proposal).toBeUndefined(); expect(JSON.stringify(result.report)).not.toContain("do-not-log");
  });

  it("does not mark a single valid route as full structural acceptance", async () => {
    const result = await executeM3Replay(syntheticM3Snapshot(now), { live: false }, { now: () => now, offlineGenerate: input => {
      const draft = roadmapperDraftFixture(input); draft.routes.pop(); return draft;
    } });
    expect(result.report.status).toBe("needs_review"); expect(result.report.routeCount).toBe(1);
  });

  it("does not accept the synthetic offline fixture as a real live input", async () => {
    const createProvider = vi.fn();
    const result = await executeM3Replay(syntheticM3Snapshot(now), { live: true }, { createProvider, now: () => now });
    expect(result.report.failureCode).toBe("live_rejects_synthetic_evidence"); expect(createProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["cross-plan context", (s: ReturnType<typeof transportSnapshot>) => { s.plan.userContext!.weeklyHours = 12; }],
    ["run collision", (s: ReturnType<typeof transportSnapshot>) => { s.research.runId = s.research.proposalId; }],
    ["future run", (s: ReturnType<typeof transportSnapshot>) => { s.research.now = "2027-09-13T00:00:00Z"; }],
    ["research predating plan", (s: ReturnType<typeof transportSnapshot>) => { s.research.now = "2026-09-12T00:00:00Z"; }],
    ["request mismatch", (s: ReturnType<typeof transportSnapshot>) => { s.research.evidencePacks[0]!.requestId = "other"; }],
    ["question mismatch", (s: ReturnType<typeof transportSnapshot>) => { s.research.questions[0]!.question = "another question"; }],
    ["unsafe URL", (s: ReturnType<typeof transportSnapshot>) => { s.research.evidencePacks[0]!.evidence[0]!.sourceUrl = "https://zhihu.com.attacker.test/"; }],
    ["short quote", (s: ReturnType<typeof transportSnapshot>) => { s.research.evidencePacks[0]!.evidence[0]!.supportingQuote = "短"; }],
    ["too-long quote", (s: ReturnType<typeof transportSnapshot>) => { s.research.evidencePacks[0]!.evidence[0]!.supportingQuote = "长".repeat(401); }],
    ["invented citation", (s: ReturnType<typeof transportSnapshot>) => { s.research.evidencePacks[0]!.routeCandidates[0]!.evidenceIds = ["missing"]; }],
    ["upgraded verification", (s: ReturnType<typeof transportSnapshot>) => { s.research.evidencePacks[0]!.evidence[0]!.verificationStatus = "verified"; }],
    ["missing provenance flag", (s: ReturnType<typeof transportSnapshot>) => { s.research.evidencePacks[0]!.evidence[0]!.riskTags = []; }],
  ])("rejects %s before provider creation", async (_label, mutate) => {
    const snapshot = transportSnapshot(); mutate(snapshot); const createProvider = vi.fn();
    const result = await executeM3Replay(snapshot, { live: true }, { createProvider, now: () => now });
    expect(result.report.status).toBe("failed"); expect(result.report.calls.roadmapper).toBe(0); expect(createProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["evidence shortage", (s: ReturnType<typeof transportSnapshot>) => { s.research.evidencePacks.forEach(pack => { pack.evidence = pack.evidence.slice(0, 2); pack.routeCandidates[0]!.evidenceIds = pack.evidence.map(card => card.id); }); }],
    ["no route coverage", (s: ReturnType<typeof transportSnapshot>) => { s.research.evidencePacks.forEach(pack => { pack.routeCandidates = []; }); }],
    ["no caveat coverage", (s: ReturnType<typeof transportSnapshot>) => { s.research.evidencePacks.forEach(pack => pack.evidence.forEach(card => { card.caveats = []; })); }],
    ["no condition coverage", (s: ReturnType<typeof transportSnapshot>) => { s.research.evidencePacks.forEach(pack => pack.evidence.forEach(card => { card.applicableWhen = []; })); }],
    ["zero cards", (s: ReturnType<typeof transportSnapshot>) => { s.research.evidencePacks.forEach(pack => { pack.evidence = []; pack.routeCandidates = []; }); }],
    ["one card", (s: ReturnType<typeof transportSnapshot>) => { s.research.evidencePacks.forEach((pack, i) => { pack.evidence = pack.evidence.slice(0, i === 0 ? 1 : 0); pack.routeCandidates = []; }); }],
  ])("uses one real model call and an explicitly provisional route for %s", async (_label, mutate) => {
    const snapshot = transportSnapshot(); mutate(snapshot); const before = structuredClone(snapshot);
    const generate = vi.fn(async input => roadmapperDraftFixture(input as RoadmapperInput));
    const result = await executeM3Replay(snapshot, { live: true }, { createProvider: () => ({ generate }), now: () => now });
    expect(result.report).toMatchObject({ status: "needs_review", calls: { roadmapper: 1, zhihu: 0, offlineFixture: 0 }, routeCount: 1 });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.proposal!.roadmapper).toMatchObject({ mode: "model", evidenceStatus: "insufficient" });
    expect(result.proposal!.roadmapper!.warnings).toContain("证据不足");
    expect(snapshot).toEqual(before);
  });

  it("retains only safe partial diagnostics and recomputes coverage before provisional replay", async () => {
    const snapshot = transportSnapshot();
    snapshot.research.controller = { coverage: { status: "sufficient", evidenceCount: 8, targetMin: 6, targetMax: 8,
      hasCaveat: true, gaps: [], reviewStatus: "needs_human_review" }, questionCoverage: [], rounds: 1,
      queryBudget: 6, queriesAttempted: 2, searchCallsAttempted: 2, cacheHits: 0,
      stages: [{ stage: "research", status: "partial", durationMs: 1 }], stopReason: "RAW_DIAGNOSTIC_NOT_FOR_MODEL" };
    const generate = vi.fn(async input => roadmapperDraftFixture(input as RoadmapperInput));
    const result = await executeM3Replay(snapshot, { live: true }, { createProvider: () => ({ generate }), now: () => now });
    expect(result.report).toMatchObject({ status: "needs_review", calls: { roadmapper: 1 }, routeCount: 1 });
    expect(result.proposal!.roadmapper!.evidenceStatus).toBe("insufficient");
    expect(JSON.stringify(generate.mock.calls)).not.toContain("RAW_DIAGNOSTIC_NOT_FOR_MODEL");
    expect(validateM3Snapshot(snapshot, now).research.controller!.stages).toEqual([{ stage: "research", status: "partial", durationMs: 1 }]);
  });

  it("accepts Controller planner ready_for_review status in an HTTP-saved successful research snapshot", async () => {
    const snapshot = transportSnapshot();
    snapshot.research.controller = { coverage: { status: "sufficient", evidenceCount: 8, targetMin: 6, targetMax: 8,
      hasCaveat: true, gaps: [], reviewStatus: "needs_human_review" }, questionCoverage: [], rounds: 1,
      queryBudget: 6, queriesAttempted: 2, searchCallsAttempted: 2, cacheHits: 0,
      stages: [{ stage: "plan", status: "ready_for_review", durationMs: 1 },
        { stage: "supplement", status: "ready_for_review", durationMs: 1 }, { stage: "research", status: "ok", durationMs: 1 }],
      stopReason: "coverage_sufficient" };
    const result = await executeM3Replay(snapshot, { live: false }, { now: () => now });
    expect(result.report).toMatchObject({ status: "structural_pass", calls: { roadmapper: 0, zhihu: 0, offlineFixture: 1 } });
  });

  it("preserves validated insufficient source snapshots without using their text as evidence", async () => {
    const snapshot = transportSnapshot();
    const sources = [{ source: { id: "zhihu:Answer:999", provider: "zhihu" as const, title: "未采纳资料",
      url: "https://www.zhihu.com/answer/999", author: "作者", snippet: "REJECTED_SOURCE😀\r\n不能作为引用依据。",
      retrievedAt: now, source_scope: "search_snippet" as const }, reasonCode: "compiler_rejected" as const,
      riskTags: ["证据不足", "search_snippet_only", "not_independently_verified", "semantic_support_not_checked"] }];
    snapshot.research.evidencePacks[0]!.insufficientSources = sources;
    const generate = vi.fn(async input => roadmapperDraftFixture(input as RoadmapperInput));
    const result = await executeM3Replay(snapshot, { live: true }, { createProvider: () => ({ generate }), now: () => now });
    expect(result.report.failureCode).toBeUndefined();
    expect(result.proposal!.previews[0]!.plan.research!.insufficientSources).toEqual(sources);
    expect(JSON.stringify(generate.mock.calls)).not.toContain("REJECTED_SOURCE");
    expect(JSON.stringify(generate.mock.calls)).not.toContain("https://www.zhihu.com/answer/999");
    sources[0]!.source.url = "https://attacker.test/";
    const rejected = await executeM3Replay(snapshot, { live: true }, { createProvider: () => ({ generate }), now: () => now });
    expect(rejected.report).toMatchObject({ status: "failed", calls: { roadmapper: 0 } });
  });

  it("rejects partial research diagnostic artifacts as planning snapshots", async () => {
    const snapshot = transportSnapshot();
    const result = await executeM3Replay({ artifactKind: "partial-research", research: snapshot.research }, { live: true }, { now: () => now });
    expect(result.report).toMatchObject({ status: "failed", calls: { roadmapper: 0, zhihu: 0 } });
  });
});

describe("M3 replay file and argument guards", () => {
  it("preserves a bounded snapshot planning budget instead of rereading looser local settings", async () => {
    const snapshot = transportSnapshot();
    snapshot.research.planningBudget = { weeklyToleranceRatio: 0.05, weeklyToleranceHours: 0.25 };
    vi.stubEnv("ROADMAP_WEEKLY_TOLERANCE_PERCENT", "50"); vi.stubEnv("ROADMAP_WEEKLY_TOLERANCE_HOURS", "8");
    try {
      const clean = validateM3Snapshot(snapshot, now);
      expect(clean.research.planningBudget).toEqual(snapshot.research.planningBudget);
      const result = await executeM3Replay(clean, { live: false }, { now: () => now });
      expect(result.proposal!.roadmapper!.planningBudget).toEqual(snapshot.research.planningBudget);
      expect(validateM3Snapshot(clean, now).research.planningBudget).toEqual(snapshot.research.planningBudget);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([
    { weeklyToleranceRatio: 0.51, weeklyToleranceHours: 1 },
    { weeklyToleranceRatio: 0.1, weeklyToleranceHours: 8.01 },
    { weeklyToleranceRatio: true, weeklyToleranceHours: 1 },
    { weeklyToleranceRatio: 0.1, weeklyToleranceHours: 1, extra: true },
  ])("rejects malformed snapshot planning budgets before a model call", async planningBudget => {
    const snapshot = transportSnapshot();
    const result = await executeM3Replay({ ...snapshot, research: { ...snapshot.research, planningBudget } }, { live: false }, { now: () => now });
    expect(result.report).toMatchObject({ status: "failed", calls: { roadmapper: 0, offlineFixture: 0, zhihu: 0 } });
  });

  it("requires explicit live and a snapshot, and rejects unknown/repeated/missing arguments", () => {
    expect(parseM3ReplayArguments([])).toEqual({ live: false, help: false });
    expect(parseM3ReplayArguments(["--help"]).help).toBe(true);
    expect(parseM3ReplayArguments(["--snapshot", "input.json"])).toMatchObject({ live: false, snapshotPath: "input.json" });
    expect(parseM3ReplayArguments(["--snapshot", "input.json", "--live"])).toMatchObject({ live: true });
    for (const args of [["--live"], ["--snapshot"], ["--live", "--live"], ["--output", "file"], ["--snapshot", "--live"], ["--help", "--live"]]) {
      expect(() => parseM3ReplayArguments(args)).toThrow();
    }
  });

  it("rejects prototype, nonfinite and provider configuration JSON; ignores untrusted controller coverage claims", () => {
    const base = syntheticM3Snapshot(now);
    for (const extra of [{ env: { DEEPSEEK_API_KEY: "SECRET" } }, { apiUrl: "https://attacker.test" }, { model: "untrusted" }, { nested: { token: "SECRET" } }]) {
      expect(() => validateM3Snapshot({ ...base, research: { ...base.research, controller: extra } }, now)).toThrow();
    }
    const proto = JSON.parse(JSON.stringify(base).replace('"research":{', '"research":{"__proto__":{},'));
    expect(() => validateM3Snapshot(proto, now)).toThrow();
    expect(() => validateM3Snapshot({ ...base, plan: { ...base.plan, weeklyHours: Infinity } }, now)).toThrow();
    const clean = validateM3Snapshot({ ...base, research: { ...base.research, controller: { coverage: { status: "sufficient" } } } }, now);
    expect(clean.research).not.toHaveProperty("controller");
  });

  it("bounds raw file size and rejects directories, invalid JSON and invalid UTF-8", async () => {
    const dir = await folder(); const valid = join(dir, "valid.json");
    await writeFile(valid, JSON.stringify(syntheticM3Snapshot(now)));
    expect(await readM3Snapshot(valid)).toHaveProperty("research");
    const invalid = join(dir, "invalid.json"); await writeFile(invalid, "{broken");
    await expect(readM3Snapshot(invalid)).rejects.toThrow("snapshot_read_or_json_failed");
    await writeFile(invalid, Buffer.from([0xff, 0xfe]));
    await expect(readM3Snapshot(invalid)).rejects.toThrow("snapshot_read_or_json_failed");
    await writeFile(invalid, " ".repeat(MAX_M3_SNAPSHOT_BYTES + 1));
    await expect(readM3Snapshot(invalid)).rejects.toThrow("snapshot_too_large");
    await expect(readM3Snapshot(dir)).rejects.toThrow();
  });

  it("rejects file symlinks when the host permits creating them", async context => {
    const dir = await folder(), valid = join(dir, "valid.json"), link = join(dir, "link.json");
    await writeFile(valid, JSON.stringify(syntheticM3Snapshot(now)));
    try {
      await symlink(valid, link);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
        context.skip("Windows requires Developer Mode or elevated privileges to create file symlinks");
        return;
      }
      throw error;
    }
    await expect(readM3Snapshot(link)).rejects.toThrow();
  });

  it("writes only unique restricted preview artifacts, never Plan/History or an approved baseline", async () => {
    const dir = await folder();
    const result = await executeM3Replay(syntheticM3Snapshot(now), { live: false }, { now: () => now });
    const first = await saveM3ReplayArtifacts(dir, result), second = await saveM3ReplayArtifacts(dir, result);
    expect(first).not.toBe(second); expect(await readdir(first)).toEqual(["preview.json", "report.json"]);
    expect(await readdir(join(dir, "data"))).toEqual(["verification"]);
    const artifact = JSON.parse(await readFile(join(first, "preview.json"), "utf8"));
    expect(artifact).toMatchObject({ artifactKind: "m3-replay-preview-not-an-approved-plan", mode: "offline", syntheticModelOutput: true });
  });

  it.skipIf(process.platform === "win32")("restricts preview artifact permissions on POSIX hosts", async () => {
    const dir = await folder();
    const result = await executeM3Replay(syntheticM3Snapshot(now), { live: false }, { now: () => now });
    const first = await saveM3ReplayArtifacts(dir, result);
    expect((await stat(first)).mode & 0o777).toBe(0o700);
    expect((await stat(join(first, "preview.json"))).mode & 0o777).toBe(0o600);
  });
});
