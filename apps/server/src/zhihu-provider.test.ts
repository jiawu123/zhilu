import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createZhihuProvider, readZhihuProviderConfig } from "./zhihu-provider";

const input = { goal: "学习测试", user_context: {}, request: {
  id: "controller-🧪", question: "怎样编写测试？", searchQueries: ["Python 测试"],
  relevantUserConditions: [], evidenceLimit: 1,
} };
const config = { pythonBin: process.execPath, pythonCwd: import.meta.dirname, timeoutMs: 5000 };
const fixture = resolve(import.meta.dirname, "fixtures/provider-child.cjs");
function provider(mode: string, overrides = {}) {
  return createZhihuProvider({ ...config, ...overrides }, {
    spawn: (_executable, _args, options) => spawn(process.execPath, [fixture, mode], options),
  });
}
describe("Python provider transport", () => {
  it("reads all byte chunks through close, tolerates stderr, preserves requestId", async () => {
    const result = await provider("split").researchOne(input);
    expect(result.status).toBe("no_evidence");
    expect(result.pack.requestId).toBe(input.request.id);
    expect(result.pack.unresolvedQuestions).toEqual(["中文🧪没有适用证据"]);
  });
  it("uses explicit interpreter, cwd, safe argument array and baseline profile", async () => {
    const calls: unknown[][] = [];
    const p = createZhihuProvider(config, { spawn: (exe, args, options) => {
      calls.push([exe, args, options]);
      return spawn(process.execPath, [fixture, "nonzero"], options);
    } });
    await expect(p.planForBaseline({ goal: input.goal, user_context: {} })).rejects.toThrow();
    expect(calls[0]).toMatchObject([process.execPath,
      ["-X", "utf8", "-u", "-m", "zhihu_m2.pipeline", "--action", "plan", "--planning-profile", "m2-initial"],
      { cwd: import.meta.dirname, shell: false, windowsHide: true }]);
  });
  it.each(["invalid-json", "wrong-action", "wrong-id", "failed", "nonzero"])("rejects %s without exposing raw errors", async mode => {
    try { await provider(mode).researchOne(input); throw new Error("did not reject"); }
    catch (error) {
      expect(String(error)).not.toContain("private");
      expect(String(error)).not.toContain("Authorization");
      expect(String(error)).not.toContain("did not reject");
    }
  });
  it.each(["large-out", "large-err"])("bounds %s and cleans up", async mode => {
    await expect(provider(mode, { maxStdoutBytes: 1000, maxStderrBytes: 1000 }).researchOne(input))
      .rejects.toMatchObject({ code: "output_limit" });
  });
  it("times out and cleans the process", async () => {
    await expect(provider("hang", { timeoutMs: 100 }).researchOne(input)).rejects.toMatchObject({ code: "timeout" });
  });
  it("rejects an already aborted Controller call before spawning a process", async () => {
    let calls = 0;
    const p = createZhihuProvider(config, { spawn: () => { calls++; throw new Error("must not spawn"); } });
    const signal = AbortSignal.abort();
    await expect(p.researchOne(input, { signal })).rejects.toMatchObject({ code: "timeout" });
    await expect(p.planForBaseline({ goal: input.goal, user_context: {} }, { signal })).rejects.toMatchObject({ code: "timeout" });
    await expect(p.planSupplemental({ goal: input.goal, user_context: {}, gaps: [], executed_queries: [], remaining_query_budget: 3 }, { signal }))
      .rejects.toMatchObject({ code: "timeout" });
    expect(calls).toBe(0);
  });
  it("kills a running process when the Controller deadline aborts it", async () => {
    let childPid = 0;
    const controller = new AbortController();
    const p = createZhihuProvider(config, { spawn: (_exe, _args, options) => {
      const child = spawn(process.execPath, [fixture, "hang"], options);
      childPid = child.pid!;
      queueMicrotask(() => controller.abort());
      return child;
    } });
    await expect(p.researchOne(input, { signal: controller.signal })).rejects.toMatchObject({ code: "timeout" });
    expect(() => process.kill(childPid, 0)).toThrow();
  });
  it("recognizes a Python deadline failure as timeout after validating its envelope", async () => {
    await expect(provider("research-timeout").researchOne(input)).rejects.toMatchObject({ code: "timeout" });
    await expect(provider("bad-failure").researchOne(input)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("rejects invalid UTF-8 instead of replacing source bytes", async () => {
    await expect(provider("invalid-utf8").researchOne(input)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("classifies signal termination without accepting incomplete output", async () => {
    await expect(provider("signal").researchOne(input)).rejects.toMatchObject({ code: "process_failed" });
  });
  it("kills the Python replacement and its descendant on timeout", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "zhilu-pid-"));
    const pidFile = resolve(directory, "pid.txt");
    let parentPid = 0;
    const p = createZhihuProvider({ ...config, timeoutMs: 1500, env: { OFFLINE_PID_FILE: pidFile } }, {
      spawn: (_exe, _args, options) => {
        const child = spawn(process.execPath, [fixture, "tree"], options);
        parentPid = child.pid!;
        return child;
      },
    });
    try {
      await expect(p.researchOne(input)).rejects.toMatchObject({ code: "timeout" });
      const descendant = Number(await readFile(pidFile, "utf8"));
      expect(Number.isSafeInteger(descendant)).toBe(true);
      expect(() => process.kill(parentPid, 0)).toThrow();
      expect(() => process.kill(descendant, 0)).toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("classifies startup failure without disclosing executable or exceptions", async () => {
    await expect(createZhihuProvider({ ...config, pythonBin: resolve(import.meta.dirname, "private-missing.exe") }).researchOne(input))
      .rejects.toMatchObject({ code: "startup_failed" });
  });
  it("handles early exit/stdin errors", async () => {
    await expect(provider("exit-early").researchOne(input)).rejects.toThrow();
  });
  it("classifies EPIPE at the stdin stream boundary and cleans the real child", async () => {
    const p = createZhihuProvider({ ...config, timeoutMs: 2000 }, {
      spawn: (_exe, _args, options) => {
        const child = spawn(process.execPath, [fixture, "hang"], options);
        child.stdin.end = (() => {
          // Inject a platform stream error, avoiding nondeterministic OS pipe buffering.
          queueMicrotask(() => child.stdin.destroy(Object.assign(new Error("private EPIPE detail"), { code: "EPIPE" })));
          return child.stdin;
        }) as typeof child.stdin.end;
        return child;
      },
    });
    await expect(p.researchOne(input)).rejects.toMatchObject({ code: "stdin_failed" });
  });
  it("retains only checked failure metrics and an allowlisted upstream code", async () => {
    await expect(provider("failed").researchOne(input)).rejects.toMatchObject({
      code: "process_failed", upstreamCode: "research_failed",
      metrics: { search_calls_attempted: 1, compiler_calls_attempted: 0, evidence_count: 0, candidate_count: 0,
        batch_invalid_item_count: 1, batch_valid_output_count: 0, batch_invalid_group_count: 0 },
    });
  });
  it("rejects invalid input before spawn", async () => {
    let calls = 0;
    const p = createZhihuProvider(config, { spawn: () => { calls++; throw new Error("secret"); } });
    await expect(p.researchOne({ ...input, request: { ...input.request, evidenceLimit: true } } as never)).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("requires explicit absolute configuration, with bounded numeric settings", () => {
    expect(() => readZhihuProviderConfig({})).toThrow();
    expect(() => readZhihuProviderConfig({ ZHIHU_PYTHON_BIN: "python", ZHIHU_PYTHON_CWD: "." })).toThrow();
    expect(readZhihuProviderConfig({ ZHIHU_PYTHON_BIN: process.execPath, ZHIHU_PYTHON_CWD: import.meta.dirname }).timeoutMs).toBe(630000);
  });

  it.each(["m2-initial", "jia-p0-baseline"] as const)("validates the %s planning response with its selected profile", async planningProfile => {
    const p = createZhihuProvider({ ...config, planningProfile }, {
      spawn: (_exe, args, options) => {
        expect(args.slice(-2)).toEqual(["--planning-profile", planningProfile]);
        expect(options.env?.ZHIHU_PLANNING_PROFILE).toBe(planningProfile);
        return spawn(process.execPath, [fixture, planningProfile === "m2-initial" ? "plan-initial" : "plan-legacy"], options);
      },
    });
    const result = await p.planForBaseline({ goal: input.goal, user_context: {} });
    expect(result.status).toBe("ready_for_review");
    expect(result.questions.flatMap(question => question.searchQueries)).toHaveLength(planningProfile === "m2-initial" ? 2 : 6);
  });
  it("defaults Node configuration to initial queries and supports trusted environment rollback", async () => {
    const base = { ZHIHU_PYTHON_BIN: process.execPath, ZHIHU_PYTHON_CWD: import.meta.dirname };
    expect(readZhihuProviderConfig(base).planningProfile).toBe("m2-initial");
    expect(readZhihuProviderConfig({ ...base, ZHIHU_PLANNING_PROFILE: "jia-p0-baseline" }).planningProfile).toBe("jia-p0-baseline");
    const p = createZhihuProvider({ ...config, env: { ZHIHU_PLANNING_PROFILE: "jia-p0-baseline" } }, {
      spawn: (_exe, args, options) => {
        expect(args.at(-1)).toBe("jia-p0-baseline");
        return spawn(process.execPath, [fixture, "plan-legacy"], options);
      },
    });
    await expect(p.planForBaseline({ goal: input.goal, user_context: {} })).resolves.toMatchObject({ status: "ready_for_review" });
  });
  it("explicit trusted profile wins over inherited environment and invalid profiles fail before spawn", () => {
    let calls = 0;
    expect(() => createZhihuProvider({ ...config, planningProfile: "private-canary" } as never,
      { spawn: () => { calls++; throw new Error("secret"); } })).toThrowError("Provider 配置无效");
    expect(calls).toBe(0);
    expect(() => readZhihuProviderConfig({ ZHIHU_PYTHON_BIN: process.execPath,
      ZHIHU_PYTHON_CWD: import.meta.dirname, ZHIHU_PLANNING_PROFILE: "private-canary" })).toThrow();
    expect(() => createZhihuProvider({ ...config, planningProfile: "m2-initial",
      env: { ZHIHU_PLANNING_PROFILE: "private-canary" } })).not.toThrow();
  });
  it("recovers only safe line-framed failure metadata across stderr chunks", async () => {
    try {
      await provider("stderr-failure-split").researchOne(input);
      throw new Error("did not reject");
    } catch (error) {
      expect(error).toMatchObject({ code: "process_failed", upstreamCode: "configuration_error",
        metrics: { planner_calls_attempted: 0, search_calls_attempted: 1, compiler_calls_attempted: 0,
          batch_model_calls_attempted: 1, model_calls_attempted: 1, candidate_count: 2, evidence_count: 0,
          batch_invalid_item_count: 1, batch_valid_output_count: 1, batch_invalid_group_count: 2 } });
      expect(JSON.stringify(error)).not.toMatch(/private|Authorization|canary|traceback|run_id/u);
      expect(String(error)).not.toContain("secret");
    }
  });
  it("recovers Python deadline classification from safe stderr when stdout is absent", async () => {
    await expect(provider("stderr-timeout").researchOne(input))
      .rejects.toMatchObject({ code: "timeout", upstreamCode: "research_timeout" });
  });
  it.each(["stderr-unknown-code", "stderr-wrong-action", "stderr-ok", "stderr-invalid-counter", "stderr-invalid-batch-counter",
    "stderr-unframed", "stderr-oversize-line", "stderr-conflicting"])("ignores untrusted %s failure metadata", async mode => {
    const failure = await provider(mode).researchOne(input).catch(error => error);
    expect(failure).toMatchObject({ code: "process_failed" });
    expect(failure.upstreamCode).toBeUndefined();
    expect(failure.metrics).toBeUndefined();
    expect(JSON.stringify(failure)).not.toMatch(/private|Authorization|canary/u);
  });
  it("keeps valid stdout authoritative over contradictory stderr metadata", async () => {
    await expect(provider("stderr-success").researchOne(input)).resolves.toMatchObject({ status: "no_evidence" });
    await expect(provider("stderr-envelope-failed").researchOne(input)).rejects.toMatchObject({
      code: "process_failed", upstreamCode: "research_failed" });
    const malformed = await provider("stderr-invalid-json").researchOne(input).catch(error => error);
    expect(malformed).toMatchObject({ code: "invalid_response" });
    expect(malformed.upstreamCode).toBeUndefined();
  });
  it("stderr diagnostics still obey the total output cap", async () => {
    await expect(provider("stderr-failure-split", { maxStderrBytes: 100 }).researchOne(input))
      .rejects.toMatchObject({ code: "output_limit" });
  });
  it("exposes explicit supplemental planning without scheduling research or reusing baseline arguments", async () => {
    const calls: string[][] = [];
    const p = createZhihuProvider({ ...config, planningProfile: "jia-p0-baseline" }, {
      spawn: (_exe, args, options) => {
        calls.push(args);
        return spawn(process.execPath, [fixture, "supplement-stop"], options);
      },
    });
    const result = await p.planSupplemental({ goal: input.goal, user_context: {}, gaps: [],
      executed_queries: ["已经执行过的查询"], remaining_query_budget: 3 });
    expect(result).toEqual({ status: "stop", questions: [], stopReason: "coverage_sufficient", gaps: [], plannerCallsAttempted: 0 });
    expect(calls).toEqual([["-X", "utf8", "-u", "-m", "zhihu_m2.pipeline", "--action", "supplement"]]);
  });
  it("rejects malformed supplemental budget before starting Python", async () => {
    let calls = 0;
    const p = createZhihuProvider(config, { spawn: () => { calls++; throw new Error("private canary"); } });
    await expect(p.planSupplemental({ goal: input.goal, user_context: {}, gaps: [],
      executed_queries: [], remaining_query_budget: true } as never)).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
