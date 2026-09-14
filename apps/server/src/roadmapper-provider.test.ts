import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoadmapperProvider, readRoadmapperConfig, readRoadmapperPlanningBudget, type RoadmapperConfig } from "./roadmapper-provider";

const config: RoadmapperConfig = {
  apiUrl: "https://model.example/v1/chat/completions", apiKey: "private-key", model: "test-model",
};
const input = { systemPrompt: "根据证据创建计划。", context: { goal: "学习测试", evidence: [{ id: "e1" }] } };
function response(content: unknown = { routes: [] }, message = {}, finishReason = "stop") {
  return Response.json({ choices: [{ finish_reason: finishReason, message: {
    role: "assistant", content: JSON.stringify(content), ...message,
  } }] });
}
function provider(result: Response, overrides: Partial<RoadmapperConfig> = {}) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(result);
  return { p: createRoadmapperProvider({ ...config, ...overrides }, { fetch: request }), request };
}
afterEach(() => vi.useRealTimers());

describe("Roadmapper scheduling tolerance configuration", () => {
  it("defaults to ten percent capped at one hour without requiring model credentials", () => {
    expect(readRoadmapperPlanningBudget({})).toEqual({ weeklyToleranceRatio: 0.1, weeklyToleranceHours: 1 });
  });
  it.each([
    [{ ROADMAP_WEEKLY_TOLERANCE_PERCENT: "0", ROADMAP_WEEKLY_TOLERANCE_HOURS: "1" }, { weeklyToleranceRatio: 0, weeklyToleranceHours: 1 }],
    [{ ROADMAP_WEEKLY_TOLERANCE_PERCENT: "10", ROADMAP_WEEKLY_TOLERANCE_HOURS: "0" }, { weeklyToleranceRatio: 0.1, weeklyToleranceHours: 0 }],
    [{ ROADMAP_WEEKLY_TOLERANCE_PERCENT: "25", ROADMAP_WEEKLY_TOLERANCE_HOURS: "2.5" }, { weeklyToleranceRatio: 0.25, weeklyToleranceHours: 2.5 }],
  ])("parses an explicit bounded tolerance without replacing zero", (env, expected) => {
    expect(readRoadmapperPlanningBudget(env)).toEqual(expected);
  });
  it.each(["", " ", "SECRET_BAD_CONFIGURATION", "Infinity", "NaN", "-1", "51"])("rejects an invalid percentage without echoing it", value => {
    expect(() => readRoadmapperPlanningBudget({ ROADMAP_WEEKLY_TOLERANCE_PERCENT: value }))
      .toThrow("Roadmapper 模型配置无效，请检查 Server 启动环境。");
  });
  it.each(["", "Infinity", "not-a-number", "-1", "8.01"])("rejects an invalid hourly maximum", value => {
    expect(() => readRoadmapperPlanningBudget({ ROADMAP_WEEKLY_TOLERANCE_HOURS: value }))
      .toThrow("Roadmapper 模型配置无效，请检查 Server 启动环境。");
  });
});

describe("Roadmapper model transport", () => {
  it("cancels an in-flight plan when its caller disconnects", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const p = createRoadmapperProvider({ ...config, timeoutMs: 50 }, { fetch: request });
    const abort = new AbortController();
    const result = expect(p.generate(input, { signal: abort.signal })).rejects.toMatchObject({ code: "cancelled" });
    abort.abort();
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
  it("does not start a request for an already cancelled caller", async () => {
    const { p, request } = provider(response());
    const abort = new AbortController(); abort.abort();
    await expect(p.generate(input, { signal: abort.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(request).not.toHaveBeenCalled();
  });
  it("captures truncated model text before validation without copying credentials", async () => {
    const diagnostic: Record<string, unknown> = {};
    const { p } = provider(response({}, { content: '{"done":false,"questions":[' }, "length"));
    await expect(p.generate({ ...input, diagnostic })).rejects.toMatchObject({ code: "invalid_response" });
    expect(diagnostic.rawContent).toBe('{"done":false,"questions":[');
    expect(diagnostic.finishReason).toBe("length");
    expect(diagnostic.httpStatus).toBe(200);
    expect(JSON.stringify(diagnostic)).not.toContain("private-key");
    expect(JSON.stringify(diagnostic)).not.toContain("Authorization");
  });

  it("sends one bounded JSON-object request without tools or redirects", async () => {
    const { p, request } = provider(response({ routes: [{ id: "route-one" }] }));
    expect(await p.generate(input)).toEqual({ routes: [{ id: "route-one" }] });
    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe(config.apiUrl);
    expect(options).toMatchObject({ method: "POST", redirect: "error", headers: {
      Authorization: "Bearer private-key", "Content-Type": "application/json",
    } });
    const body = JSON.parse(options!.body as string);
    expect(body).toEqual({
      model: "test-model", messages: [
        { role: "system", content: input.systemPrompt + "\nReturn only a valid JSON object. No Markdown." },
        { role: "user", content: JSON.stringify(input.context) },
      ], response_format: { type: "json_object" }, thinking: { type: "disabled" }, stream: false, max_tokens: 16384,
    });
    expect(body).not.toHaveProperty("tools");
  });

  it.each([
    ["HTML", () => new Response("<html>private-key</html>", { headers: { "content-type": "text/html" } })],
    ["invalid envelope", () => new Response("not-json private-key", { headers: { "content-type": "application/json" } })],
    ["missing choices", () => Response.json({ private: "private-key" })],
    ["empty choices", () => Response.json({ choices: [] })],
    ["invalid model JSON", () => response({}, { content: "```json private-key```" })],
    ["empty content", () => response({}, { content: "" })],
    ["missing content", () => response({}, { content: null })],
    ["scalar", () => response(42)],
    ["array", () => response([])],
    ["overflow number", () => response({}, { content: '{"weeks":1e400}' })],
    ["incomplete", () => response({}, {}, "length")],
    ["refusal", () => response({}, { refusal: "private-key" })],
    ["tool request", () => response({}, { tool_calls: [{ function: { name: "write_file" } }] })],
    ["empty tool requests", () => response({}, { tool_calls: [] })],
    ["legacy function request", () => response({}, { function_call: { name: "write_file" } })],
    ["wrong role", () => response({}, { role: "tool" })],
  ])("rejects %s with a safe error", async (_name, result) => {
    const { p, request } = provider(result());
    await expect(p.generate(input)).rejects.toMatchObject({ code: "invalid_response", status: 502 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not include upstream HTTP bodies or network details in errors or retry", async () => {
    const failed = provider(new Response("private-key user-context", { status: 401 }));
    await expect(failed.p.generate(input)).rejects.toMatchObject({ code: "upstream_failed", status: 502 });
    expect(failed.request).toHaveBeenCalledTimes(1);
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("private-key user-context"));
    const p = createRoadmapperProvider(config, { fetch: request });
    const error = await p.generate(input).catch(error => error);
    expect(error).toMatchObject({ code: "network_failed" });
    expect(String(error)).not.toContain("private-key");
    expect(String(error)).not.toContain("user-context");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid input before any HTTP call", async () => {
    const { p, request } = provider(response(), { maxInputBytes: 1000 });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    for (const invalid of [
      { ...input, systemPrompt: "" }, { ...input, context: undefined }, { ...input, context: circular },
      { ...input, context: { text: "测".repeat(1000) } },
    ]) await expect(p.generate(invalid)).rejects.toMatchObject({ code: "invalid_input", status: 422 });
    expect(request).not.toHaveBeenCalled();
  });

  it("enforces output bytes without trusting Content-Length and cancels the body", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("測".repeat(101))); },
      cancel() { cancelled = true; },
    });
    const { p } = provider(new Response(stream, { headers: {
      "content-type": "application/json", "content-length": "1",
    } }), { maxOutputBytes: 300 });
    await expect(p.generate(input)).rejects.toMatchObject({ code: "output_limit" });
    expect(cancelled).toBe(true);
  });

  it("rejects declared oversized output before reading it", async () => {
    const { p } = provider(new Response("{}", { headers: {
      "content-type": "application/json", "content-length": "1001",
    } }), { maxOutputBytes: 1000 });
    await expect(p.generate(input)).rejects.toMatchObject({ code: "output_limit" });
  });

  it("handles split UTF-8 chunks and rejects invalid UTF-8", async () => {
    const value = { title: "中文🧪" };
    const bytes = new TextEncoder().encode(await response(value).text());
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } });
    expect(await provider(new Response(stream, { headers: { "content-type": "application/json" } })).p.generate(input)).toEqual(value);
    await expect(provider(new Response(Uint8Array.of(0xff), { headers: { "content-type": "application/json" } })).p.generate(input))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it("ends a request at its wall-clock deadline even if fetch ignores abort", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const p = createRoadmapperProvider({ ...config, timeoutMs: 50 }, { fetch: request });
    const result = expect(p.generate(input)).rejects.toMatchObject({ code: "timeout", status: 504 });
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("includes streamed body reading in the deadline and cancels a stalled body", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const { p } = provider(new Response(stream, { headers: { "content-type": "application/json" } }), { timeoutMs: 50 });
    const result = expect(p.generate(input)).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(cancelled).toBe(true);
  });

  it("uses launch environment overrides and shared/DeepSeek fallbacks", () => {
    expect(readRoadmapperConfig({ DEEPSEEK_API_KEY: "deepseek-key" })).toMatchObject({
      apiUrl: "https://api.deepseek.com/chat/completions", model: "deepseek-v4-pro", apiKey: "deepseek-key", timeoutMs: 120000, maxTokens: 16384,
    });
    expect(readRoadmapperConfig({ LLM_API_URL: config.apiUrl, LLM_MODEL: "shared", LLM_API_KEY: "shared-key" }))
      .toMatchObject({ ...config, model: "shared", apiKey: "shared-key" });
    expect(readRoadmapperConfig({ LLM_API_KEY: "shared", ROADMAP_API_KEY: "specific", ROADMAP_MODEL: "specific-model", ROADMAP_TIMEOUT_MS: "5000", ROADMAP_MAX_TOKENS: "24000" }))
      .toMatchObject({ apiKey: "specific", model: "specific-model", timeoutMs: 5000, maxTokens: 24000 });
    expect(() => readRoadmapperConfig({ DEEPSEEK_API_KEY: "deepseek-key", ROADMAP_MAX_TOKENS: "32769" })).toThrow();
  });

  it("rejects incomplete configuration without exposing it and permits local HTTP endpoints", () => {
    expect(() => readRoadmapperConfig({})).toThrow();
    for (const overrides of [
      { apiKey: "" }, { apiKey: "key\r\nsecret" }, { model: "" }, { timeoutMs: 0 }, { timeoutMs: 300001 },
      { maxTokens: 0 }, { apiUrl: "https://model.example/" }, { apiUrl: "http://model.example/v1/chat/completions" },
      { apiUrl: "https://secret@model.example/v1/chat/completions" }, { apiUrl: "https://model.example/v1/chat/completions?key=secret" },
    ]) expect(() => createRoadmapperProvider({ ...config, ...overrides })).toThrow("Roadmapper 模型配置无效");
    expect(() => createRoadmapperProvider({ ...config, apiUrl: "http://127.0.0.1:1234/v1/chat/completions" })).not.toThrow();
  });
});
