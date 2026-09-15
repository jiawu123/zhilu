import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createZhidaProvider, readZhidaConfig, type ZhidaProviderConfig } from "./zhida-provider";

const input = { goal: "四周做一个小游戏", user_context: { weekly_hours: 8, constraints: ["免费工具"] } };
const config = { cliBin: "zhihu-cli", timeoutMs: 3000 };
const event = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "sample", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\r\n\r\n`;
const stream = (answer: string) => `: keep-alive\r\n\r\n${event({ reasoning_content: "不展示的思考" })}${event({ content: answer })}${event({}, "stop")}data: [DONE]\r\n\r\n`;

function provider(output: string | Buffer, overrides: Partial<ZhidaProviderConfig> = {}, mode = "normal") {
  let child: ChildProcessWithoutNullStreams | undefined;
  const data = Buffer.from(output).toString("base64");
  const script = mode === "hang" ? "setInterval(() => {}, 1000)" : `
    const data = Buffer.from(${JSON.stringify(data)}, 'base64');
    let i = 0;
    function write() {
      if(i < data.length) { process.stdout.write(data.subarray(i, ++i)); setImmediate(write); }
      else { ${mode === "nonzero" ? "process.stderr.write('private Authorization secret'); process.exitCode = 2;" : ""} }
    }
    write();
  `;
  return {
    instance: createZhidaProvider({ ...config, ...overrides }, { spawn: (_exe, _args, options) => {
      child = spawn(process.execPath, ["-e", script], options);
      return child;
    } }),
    child: () => child,
  };
}

describe("Zhida direct-answer provider", () => {
  it("assembles split UTF-8 SSE, hides source metadata and delivers optional source cards", async () => {
    const answer = '先做中文小游戏🧪。[1]\n<sources>[{"id":"1","title":"开发经验","url":"https://zhuanlan.zhihu.com/p/123","author":"答主","summary":"AI 整理的摘要"}]</sources>';
    const deltas: string[] = [];
    const result = await provider(stream(answer)).instance.research(input, { onText: text => deltas.push(text) });
    expect(result).toMatchObject({ provider: "zhida-agent", answer: "先做中文小游戏🧪。[1]", sources: [
      { id: "1", title: "开发经验", url: "https://zhuanlan.zhihu.com/p/123", author: "答主", summary: "AI 整理的摘要" },
    ] });
    expect(deltas.join("").trim()).toBe(result.answer);
    expect(deltas.join("")).not.toContain("<sources");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);
  });

  it("accepts a useful answer with no sources and ordinary uncertainty", async () => {
    const result = await provider(stream("无法核实工具的免费额度。可以先做一个原型，再检查当前套餐。")).instance.research(input);
    expect(result.sources).toEqual([]);
    expect(result.answer).toContain("先做一个原型");
  });

  it("falls back to safe links when source JSON is malformed and deduplicates URLs", async () => {
    const answer = '[教程](https://www.zhihu.com/answer/123) 与 https://www.zhihu.com/answer/123。\n[不安全](https://user:secret@example.com/article)\n<sources>not json</sources>';
    const result = await provider(stream(answer)).instance.research(input);
    expect(result.sources).toEqual([{ id: "1", title: "教程", url: "https://www.zhihu.com/answer/123" }]);
    expect(result.answer).not.toContain("sources>");
  });

  it("does not invent authors or accept credential and non-web source URLs", async () => {
    const sources = [
      { id: "1", title: "有效", url: "https://example.com/a" },
      { id: "2", title: "重复", url: "https://example.com/a" },
      { id: "3", title: "凭证", url: "https://name:secret@example.com/b" },
      { id: "4", title: "脚本", url: "javascript:alert(1)" },
    ];
    const result = await provider(stream(`正文。<sources>${JSON.stringify(sources)}</sources>`)).instance.research(input);
    expect(result.sources).toEqual([{ id: "1", title: "有效", url: "https://example.com/a" }]);
  });

  it("withholds a source marker split across content events", async () => {
    const raw = event({ content: "建议先验证。\n<sou" }) + event({ content: 'rces>[{"title":"经验","url":"https://example.com/"}]</sources>' }) + event({}, "stop") + "data: [DONE]\n\n";
    const deltas: string[] = [];
    const result = await provider(raw).instance.research(input, { onText: text => deltas.push(text) });
    expect(deltas.join("").trim()).toBe("建议先验证。");
    expect(result.answer).toBe("建议先验证。");
  });

  it("does not flash a metadata code fence before a split source block", async () => {
    const raw = event({ content: "建议先验证。\n```json\n" }) + event({ content: '<sources>[]</sources>\n```' }) + event({}, "stop") + "data: [DONE]\n\n";
    const deltas: string[] = [];
    const result = await provider(raw).instance.research(input, { onText: text => deltas.push(text) });
    expect(deltas.join("").trim()).toBe("建议先验证。");
    expect(result.answer).toBe("建议先验证。");
  });

  it("accepts an answer despite an unclosed malformed source block", async () => {
    const result = await provider(stream('先做最小原型。<sources>{broken')).instance.research(input);
    expect(result.answer).toBe("先做最小原型。");
    expect(result.sources).toEqual([]);
  });

  it.each([
    ["missing DONE", event({ content: "片段" }) + event({}, "stop")],
    ["missing stop", event({ content: "片段" }) + "data: [DONE]\n\n"],
    ["length stop", event({ content: "片段" }, "length") + "data: [DONE]\n\n"],
    ["broken JSON", "data: {private secret}\n\n"],
    ["invalid UTF-8", Buffer.concat([Buffer.from('data: {"x":"'), Buffer.from([0xff]), Buffer.from('"}\n\n')])],
  ])("rejects %s without accepting an incomplete answer", async (_name, raw) => {
    await expect(provider(raw).instance.research(input)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each(["", "抱歉，我无法回答这个问题。"])("rejects empty or total-refusal answers without retry", async answer => {
    await expect(provider(stream(answer)).instance.research(input)).rejects.toMatchObject({ code: answer ? "refused_answer" : "empty_answer" });
  });

  it("rejects nonzero exit even after a complete answer without revealing stderr", async () => {
    await expect(provider(stream("完整答案"), {}, "nonzero").instance.research(input)).rejects.toMatchObject({ code: "process_failed" });
    try { await provider(stream("完整答案"), {}, "nonzero").instance.research(input); }
    catch (error) { expect(String(error)).not.toMatch(/private|Authorization|secret/); }
  });

  it("bounds stdout and stops the child", async () => {
    const p = provider(stream("a".repeat(5000)), { maxStdoutBytes: 100 });
    await expect(p.instance.research(input)).rejects.toMatchObject({ code: "output_limit" });
    expect(() => process.kill(p.child()!.pid!, 0)).toThrow();
  });

  it("bounds stderr without exposing its contents", async () => {
    const p = createZhidaProvider({ ...config, maxStderrBytes: 100 }, { spawn: (_exe, _args, options) =>
      spawn(process.execPath, ["-e", "process.stderr.write('private'.repeat(1000)); setInterval(() => {}, 1000)"], options) });
    await expect(p.research(input)).rejects.toMatchObject({ code: "output_limit" });
  });

  it("handles startup errors without exposing paths or raw errors", async () => {
    const p = createZhidaProvider(config, { spawn: () => { throw Error("private path secret"); } });
    await expect(p.research(input)).rejects.toMatchObject({ code: "startup_failed" });
  });

  it("does not start the CLI for oversized input", async () => {
    let calls = 0;
    const p = createZhidaProvider(config, { spawn: () => { calls++; throw Error("must not start"); } });
    await expect(p.research({ ...input, goal: "a".repeat(17000) })).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toBe(0);
  });

  it("waits for child cleanup before rejecting a timeout", async () => {
    const p = provider("", { timeoutMs: 100 }, "hang");
    await expect(p.instance.research(input)).rejects.toMatchObject({ code: "timeout" });
    expect(() => process.kill(p.child()!.pid!, 0)).toThrow();
  });

  it("waits for child cleanup before rejecting cancellation", async () => {
    const p = provider("", {}, "hang");
    const controller = new AbortController();
    const result = p.instance.research(input, { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(() => process.kill(p.child()!.pid!, 0)).toThrow();
  });

  it("does not spawn for an already cancelled request", async () => {
    let calls = 0;
    const p = createZhidaProvider(config, { spawn: () => { calls++; throw Error("must not start"); } });
    await expect(p.research(input, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toBe(0);
  });

  it("passes the goal and conditions to the configured CLI without a shell", async () => {
    let called: unknown;
    const p = createZhidaProvider(config, { spawn: (exe, args, options) => {
      called = { exe, args, options };
      return spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(stream("建议"))})`], options);
    } });
    await p.research(input);
    expect(called).toMatchObject({ exe: "zhihu-cli", args: expect.arrayContaining(["answer", "--model", "zhida-agent", "--stream", "--output", "sse"]), options: { shell: false, windowsHide: true } });
    const args = (called as { args: string[] }).args;
    expect(args[args.indexOf("--query") + 1]).toContain(input.goal);
    expect(args[args.indexOf("--query") + 1]).toContain("weekly_hours");
    expect(args[args.indexOf("--query") + 1]).toContain("免费工具");
  });

  it("prefers explicit CLI configuration and validates timeout bounds", () => {
    expect(readZhidaConfig({ ZHIHU_CLI_BIN: "first", ZHIHU_CLI_PATH: "second" }).cliBin).toBe("first");
    expect(readZhidaConfig({ ZHIHU_CLI_PATH: "second" }).cliBin).toBe("second");
    expect(readZhidaConfig({}).cliBin).toBe("zhihu-cli");
    expect(() => readZhidaConfig({ ZHIDA_TIMEOUT_MS: "0" })).toThrow();
  });
});
