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
    ["evidence shortage", (s: ReturnType<typeof transportSnapshot>) => { s.research.evidencePacks.forEach(pack => { pack.evidence = pack.evidence.slice(0, 2); pack.routeCandidates[0]!.evidenceIds = pack.evidence.map(card => card.id); }); }],
    ["no route coverage", (s: ReturnType<typeof transportSnapshot>) => { s.research.evidencePacks.forEach(pack => { pack.routeCandidates = []; }); }],
    ["no caveat coverage", (s: ReturnType<typeof transportSnapshot>) => { s.research.evidencePacks.forEach(pack => pack.evidence.forEach(card => { card.caveats = []; })); }],
    ["no condition coverage", (s: ReturnType<typeof transportSnapshot>) => { s.research.evidencePacks.forEach(pack => pack.evidence.forEach(card => { card.applicableWhen = []; })); }],
  ])("rejects %s before provider creation", async (_label, mutate) => {
    const snapshot = transportSnapshot(); mutate(snapshot); const createProvider = vi.fn();
    const result = await executeM3Replay(snapshot, { live: true }, { createProvider, now: () => now });
    expect(result.report.status).toBe("failed"); expect(result.report.calls.roadmapper).toBe(0); expect(createProvider).not.toHaveBeenCalled();
  });
});

describe("M3 replay file and argument guards", () => {
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

  it("bounds raw file size, rejects directories, symlinks, invalid JSON and invalid UTF-8", async () => {
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
    const link = join(dir, "link.json"); await symlink(valid, link);
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
    expect((await stat(first)).mode & 0o777).toBe(0o700);
    expect((await stat(join(first, "preview.json"))).mode & 0o777).toBe(0o600);
  });
});
