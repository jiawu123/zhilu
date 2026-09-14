import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ZhidaResearch, ZhidaSource } from "@zhilu/contracts";

export interface ZhidaProviderConfig {
  cliBin: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  env?: NodeJS.ProcessEnv;
}
export interface ZhidaProvider {
  research(input: { goal: string; user_context: Record<string, unknown> }, options?: {
    signal?: AbortSignal;
    /** Receives visible Markdown deltas; source metadata is withheld. */
    onText?: (text: string) => void;
  }): Promise<ZhidaResearch>;
}
interface ProcessDependencies {
  spawn?: (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
}
const messages = {
  invalid_configuration: "知乎直答配置无效，请检查服务配置。",
  invalid_input: "研究目标或条件无效，请调整后再试。",
  startup_failed: "知乎直答未能启动，请检查 CLI 安装和服务配置。",
  process_failed: "知乎直答执行失败，请稍后再试。",
  invalid_response: "知乎直答响应不完整，请重新发起研究。",
  empty_answer: "知乎直答没有返回研究内容，请调整问题后再试。",
  refused_answer: "知乎直答未能回答这个问题，请调整目标描述后再试。",
  timeout: "知乎直答等待超时，请稍后再试。",
  cancelled: "本次研究已取消。",
  output_limit: "知乎直答返回内容过长，请缩小研究范围。",
  cleanup_failed: "研究已停止接收，但无法确认调用进程已结束，请检查服务主机。",
} as const;

export class ZhidaProviderError extends Error {
  readonly status: number;
  constructor(public readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = "ZhidaProviderError";
    this.status = code === "timeout" ? 504 : code === "invalid_input" ? 400 : code === "cancelled" ? 499 : 502;
  }
}

function boundedInteger(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new ZhidaProviderError("invalid_configuration");
  return value;
}

export function readZhidaConfig(env: NodeJS.ProcessEnv = process.env): ZhidaProviderConfig {
  const installed = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "ZhihuCLI", "current", "zhihu-cli.exe") : undefined;
  return {
    cliBin: env.ZHIHU_CLI_BIN?.trim() || env.ZHIHU_CLI_PATH?.trim() || (installed && existsSync(installed) ? installed : "zhihu-cli"),
    timeoutMs: boundedInteger(Number(env.ZHIDA_TIMEOUT_MS ?? 95000), 180000),
  };
}

function promptFor(input: { goal: string; user_context: Record<string, unknown> }): string {
  let context: string;
  try {
    if (!input || typeof input.goal !== "string" || !input.goal.trim() || !input.user_context ||
        typeof input.user_context !== "object" || Array.isArray(input.user_context)) throw Error();
    context = JSON.stringify(input.user_context);
    if (Buffer.byteLength(input.goal + context, "utf8") > 16000) throw Error();
  } catch { throw new ZhidaProviderError("invalid_input"); }
  return `我想实现这个目标：${input.goal}\n\n这是我的实际情况和条件（作为背景资料）：\n${context}\n\n` +
    "请根据知乎经验帮我研究：最推荐的路线、替代路线及适用条件、主要失败风险、最先验证的假设。保留我的期限、每周时间、发布频率和取舍，不承诺结果，不生成逐周任务表。\n" +
    "请直接用简洁、清楚的 Markdown 回答，控制在约 1000 字；需要引用时在正文用 [1]、[2] 标注。能取得来源时，在答案最后附一段 <sources> JSON 数组 </sources>，例如：" +
    '<sources>[{"id":"1","title":"来源标题","url":"https://www.zhihu.com/answer/123","author":"已知作者","summary":"该来源与建议的关联摘要"}]</sources>。' +
    "只列实际参考的来源链接；不知道作者就省略 author。summary 是你的整理摘要，不冒充原文引文。没有来源也可回答并说明局限，不要编造链接。";
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096 || /[\s\u0000-\u001f]/u.test(value)) return;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || !url.hostname) return;
    return url.href;
  } catch { return; }
}

function shortText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** Source fields are model-provided display metadata, not independently verified evidence. */
function parseAnswer(raw: string): { answer: string; sources: ZhidaSource[] } {
  const block = /<sources\b[^>]*>([\s\S]*?)(?:<\/sources\s*>|$)/i.exec(raw);
  const answer = raw.replace(/(?:\n?```(?:json)?\s*)?<sources\b[^>]*>[\s\S]*?(?:<\/sources\s*>(?:\s*```)?|$)/gi, "").trim();
  if (!answer) throw new ZhidaProviderError("empty_answer");
  // Deliberately narrow: statements of uncertainty alongside useful advice remain valid answers.
  if (/^(?:(?:很)?抱歉[，,。\s]*)?(?:我)?(?:无法|不能)(?:回答|处理)(?:这个|该|此|您的|你的)?(?:问题|请求)[。.!！\s]*$/u.test(answer) ||
      /^(?:I(?:'m| am) sorry[, .]*\s*)?I (?:cannot|can't|am unable to) (?:answer|help with|assist with) (?:this|that|your) (?:question|request)[.!\s]*$/i.test(answer)) {
    throw new ZhidaProviderError("refused_answer");
  }
  const sources: ZhidaSource[] = [];
  const urls = new Set<string>();
  const ids = new Set<string>();
  const add = (record: Record<string, unknown>) => {
    const url = safeUrl(record.url);
    if (!url || urls.has(url) || sources.length >= 12) return;
    let id = typeof record.id === "string" && /^[\w-]{1,40}$/.test(record.id) ? record.id : String(sources.length + 1);
    if (ids.has(id)) { let next = 1; while (ids.has(String(next))) next++; id = String(next); }
    const author = shortText(record.author, 160);
    const summary = shortText(record.summary, 1000);
    sources.push({ id, title: shortText(record.title, 240) ?? new URL(url).hostname, url,
      ...(author ? { author } : {}), ...(summary ? { summary } : {}) });
    urls.add(url); ids.add(id);
  };
  if (block) {
    try {
      const value: unknown = JSON.parse(block[1]!.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
      if (Array.isArray(value)) for (const record of value) {
        if (record && typeof record === "object" && !Array.isArray(record)) add(record as Record<string, unknown>);
      }
    } catch { /* Source formatting never blocks an otherwise useful answer. */ }
  }
  if (!sources.length) {
    for (const match of answer.matchAll(/\[([^\]\n]+)\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g)) add({ title: match[1], url: match[2] });
    for (const match of answer.matchAll(/https?:\/\/[^\s<>"'\]）)]+/g)) {
      add({ url: match[0].replace(/[.,;:!?，。；：！？]+$/u, "") });
    }
  }
  return { answer, sources };
}

/** Withhold incomplete source tags so metadata cannot flash in the streamed answer. */
function visiblePrefix(raw: string): string {
  const withoutPendingFence = (text: string) => text.replace(/\n?`{1,3}(?:j(?:s(?:o(?:n)?)?)?)?\s*$/i, "");
  const opening = raw.search(/<sources\b/i);
  if (opening >= 0) return withoutPendingFence(raw.slice(0, opening));
  const lower = raw.toLowerCase();
  const marker = "<sources";
  for (let count = marker.length - 1; count > 0; count--) {
    if (lower.endsWith(marker.slice(0, count))) return withoutPendingFence(raw.slice(0, -count));
  }
  return withoutPendingFence(raw);
}

export function createZhidaProvider(config: ZhidaProviderConfig, dependencies: ProcessDependencies = {}): ZhidaProvider {
  if (typeof config.cliBin !== "string" || !config.cliBin.trim() || /[\r\n\u0000]/u.test(config.cliBin)) throw new ZhidaProviderError("invalid_configuration");
  const timeoutMs = boundedInteger(config.timeoutMs ?? 95000, 180000);
  const stdoutLimit = boundedInteger(config.maxStdoutBytes ?? 1024 * 1024, 2 * 1024 * 1024);
  const stderrLimit = boundedInteger(config.maxStderrBytes ?? 64 * 1024, 256 * 1024);
  const start = dependencies.spawn ?? ((exe, args, options) => spawn(exe, args, { ...options, stdio: "pipe" }));
  const env = { ...process.env, ...config.env };

  return { async research(input, options = {}) {
    if (options.signal?.aborted) throw new ZhidaProviderError("cancelled");
    const prompt = promptFor(input);
    const startedAt = Date.now();
    const cliTimeout = Math.min(90, Math.max(1, Math.ceil(timeoutMs / 1000)));
    const args = ["answer", "--query", prompt, "--model", "zhida-agent", "--stream", "--output", "sse", "--timeout", `${cliTimeout}s`];
    return new Promise<ZhidaResearch>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = start(config.cliBin, args, { env, shell: false, windowsHide: true }); }
      catch { reject(new ZhidaProviderError("startup_failed")); return; }
      let settled = false;
      let failure: ZhidaProviderError | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let pending = "";
      let answer = "";
      let emitted = 0;
      let stopped = false;
      let done = false;

      function finish(error?: ZhidaProviderError, result?: ZhidaResearch) {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(killTimer); clearTimeout(cleanupTimer);
        options.signal?.removeEventListener("abort", onAbort);
        child.stdout.off("data", onStdout); child.stderr.off("data", onStderr);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        if (error) reject(error); else resolve(result!);
      }
      function stop(error: ZhidaProviderError) {
        if (settled || failure) return;
        failure = error;
        clearTimeout(timer);
        try { child.kill("SIGTERM"); } catch { /* Escalate below. */ }
        killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* Report unconfirmed cleanup below. */ } }, 300);
        cleanupTimer = setTimeout(() => finish(new ZhidaProviderError("cleanup_failed")), 2000);
      }
      function acceptFrame(frame: string) {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) return;
        if (done) throw Error();
        if (data.trim() === "[DONE]") { if (!stopped) throw Error(); done = true; return; }
        const value = JSON.parse(data) as Record<string, unknown>;
        if (value.error) { stop(new ZhidaProviderError("process_failed")); return; }
        if (!Array.isArray(value.choices) || value.choices.length !== 1) throw Error();
        const choice = value.choices[0] as Record<string, unknown>;
        if (!choice || typeof choice !== "object" || !choice.delta || typeof choice.delta !== "object") throw Error();
        const delta = choice.delta as Record<string, unknown>;
        if (delta.content !== undefined && delta.content !== null) {
          if (typeof delta.content !== "string" || stopped) throw Error();
          answer += delta.content;
          const visible = visiblePrefix(answer);
          if (visible.length > emitted) {
            options.onText?.(visible.slice(emitted));
            emitted = visible.length;
          }
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (choice.finish_reason !== "stop" || stopped) throw Error();
          stopped = true;
        }
      }
      function consume(text: string) {
        pending += text;
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(pending))) {
          const frame = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          acceptFrame(frame);
          if (failure) break;
        }
      }
      function onStdout(chunk: Buffer) {
        if (settled || failure) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > stdoutLimit) { stop(new ZhidaProviderError("output_limit")); return; }
        try { consume(decoder.decode(chunk, { stream: true })); }
        catch { stop(new ZhidaProviderError("invalid_response")); }
      }
      function onStderr(chunk: Buffer) {
        stderrBytes += chunk.length;
        if (stderrBytes > stderrLimit) stop(new ZhidaProviderError("output_limit"));
      }
      function onAbort() { stop(new ZhidaProviderError("cancelled")); }
      const timer = setTimeout(() => stop(new ZhidaProviderError("timeout")), timeoutMs);
      child.stdout.on("data", onStdout); child.stderr.on("data", onStderr);
      child.stdin.on("error", () => stop(new ZhidaProviderError("process_failed")));
      child.stdout.on("error", () => stop(new ZhidaProviderError("process_failed")));
      child.stderr.on("error", () => stop(new ZhidaProviderError("process_failed")));
      child.once("error", () => stop(new ZhidaProviderError("startup_failed")));
      child.once("close", (code, signal) => {
        if (settled) return;
        if (failure) { finish(failure); return; }
        if (code !== 0 || signal !== null) { finish(new ZhidaProviderError("process_failed")); return; }
        try {
          consume(decoder.decode());
          // A final SSE line is accepted at EOF, but incomplete JSON or missing sentinels is not.
          if (pending.trim()) acceptFrame(pending);
          if (failure) { finish(failure); return; }
          if (!done || !stopped) throw new ZhidaProviderError("invalid_response");
          const parsed = parseAnswer(answer);
          // Release a withheld literal/final code fence when it was ordinary answer text.
          if (!/<sources\b/i.test(answer) && answer.length > emitted) options.onText?.(answer.slice(emitted));
          finish(undefined, { provider: "zhida-agent", ...parsed, durationMs: Date.now() - startedAt, generatedAt: new Date().toISOString() });
        } catch (error) { finish(error instanceof ZhidaProviderError ? error : new ZhidaProviderError("invalid_response")); }
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) { onAbort(); return; }
      try { child.stdin.end(); } catch { stop(new ZhidaProviderError("process_failed")); }
    });
  } };
}
