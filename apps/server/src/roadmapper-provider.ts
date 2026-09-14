import type { RoadmapperPlanningBudget } from "@zhilu/contracts";
import { validateRoadmapperPlanningBudget } from "@zhilu/agent-runtime";

export interface RoadmapperInput {
  systemPrompt: string;
  context: unknown;
}
export interface RoadmapperProvider {
  generate(input: RoadmapperInput, options?: { signal?: AbortSignal }): Promise<unknown>;
}
export interface RoadmapperConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxTokens?: number;
}

const messages = {
  invalid_configuration: "Roadmapper 模型配置无效，请检查 Server 启动环境。",
  invalid_input: "Roadmapper 输入无效或超过允许大小。",
  network_failed: "Roadmapper 模型连接失败，请检查服务和网络。",
  upstream_failed: "Roadmapper 模型服务请求失败，请检查授权、额度和服务状态。",
  timeout: "Roadmapper 生成超时，本次未自动重试。",
  cancelled: "本次计划生成已取消。",
  output_limit: "Roadmapper 模型响应超过允许大小。",
  invalid_response: "Roadmapper 模型未返回完整、有效的 JSON 对象。",
} as const;

export class RoadmapperProviderError extends Error {
  readonly status: number;
  constructor(public readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = "RoadmapperProviderError";
    this.status = code === "cancelled" ? 499 : code === "timeout" ? 504 : code === "invalid_input" ? 422 : code === "invalid_configuration" ? 503 : 502;
  }
}

function integer(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RoadmapperProviderError("invalid_configuration");
  return value;
}

function validateConfig(config: RoadmapperConfig): Required<RoadmapperConfig> {
  let url: URL;
  try { url = new URL(config.apiUrl); } catch { throw new RoadmapperProviderError("invalid_configuration"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash || url.pathname === "/") {
    throw new RoadmapperProviderError("invalid_configuration");
  }
  if (typeof config.apiKey !== "string" || !config.apiKey.trim() || /[\r\n]/.test(config.apiKey) ||
      typeof config.model !== "string" || !config.model.trim() || config.model.length > 200) {
    throw new RoadmapperProviderError("invalid_configuration");
  }
  return {
    apiUrl: url.href, apiKey: config.apiKey.trim(), model: config.model.trim(),
    timeoutMs: integer(config.timeoutMs ?? 120000, 300000),
    maxInputBytes: integer(config.maxInputBytes ?? 256 * 1024, 1024 * 1024),
    maxOutputBytes: integer(config.maxOutputBytes ?? 1024 * 1024, 2 * 1024 * 1024),
    maxTokens: integer(config.maxTokens ?? 16384, 32768),
  };
}

/** Only the Server launch environment is read; this does not load personal .env files. */
export function readRoadmapperConfig(env: NodeJS.ProcessEnv = process.env): RoadmapperConfig {
  return validateConfig({
    apiUrl: env.ROADMAP_API_URL || env.LLM_API_URL || "https://api.deepseek.com/chat/completions",
    apiKey: env.ROADMAP_API_KEY || env.LLM_API_KEY || env.DEEPSEEK_API_KEY || "",
    model: env.ROADMAP_MODEL || env.LLM_MODEL || "deepseek-v4-pro",
    timeoutMs: Number(env.ROADMAP_TIMEOUT_MS || 120000),
    maxTokens: Number(env.ROADMAP_MAX_TOKENS || 16384),
  });
}

/** This planning allowance is separate from model transport settings and confirmed weekly hours. */
export function readRoadmapperPlanningBudget(env: NodeJS.ProcessEnv = process.env): RoadmapperPlanningBudget {
  function numeric(key: string, fallback: number): number {
    const value = env[key];
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !value.trim() || !Number.isFinite(Number(value))) {
      throw new RoadmapperProviderError("invalid_configuration");
    }
    return Number(value);
  }
  try {
    return validateRoadmapperPlanningBudget({
      weeklyToleranceRatio: numeric("ROADMAP_WEEKLY_TOLERANCE_PERCENT", 10) / 100,
      weeklyToleranceHours: numeric("ROADMAP_WEEKLY_TOLERANCE_HOURS", 1),
    });
  } catch { throw new RoadmapperProviderError("invalid_configuration"); }
}

export function createRoadmapperProvider(
  config: RoadmapperConfig,
  dependencies: { fetch?: typeof fetch } = {},
): RoadmapperProvider {
  const settings = validateConfig(config);
  const request = dependencies.fetch ?? fetch;
  return {
    async generate(input, options = {}) {
      if (options.signal?.aborted) throw new RoadmapperProviderError("cancelled");
      let body: string;
      try {
        if (!input || typeof input.systemPrompt !== "string" || !input.systemPrompt.trim()) throw new Error();
        const context = JSON.stringify(input.context);
        if (!context) throw new Error();
        body = JSON.stringify({
          model: settings.model,
          messages: [
            { role: "system", content: input.systemPrompt + "\nReturn only a valid JSON object. No Markdown." },
            { role: "user", content: context },
          ],
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
          stream: false,
          max_tokens: settings.maxTokens,
        });
        if (Buffer.byteLength(body, "utf8") > settings.maxInputBytes) throw new Error();
      } catch { throw new RoadmapperProviderError("invalid_input"); }

      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const work = async () => {
        const response = await request(settings.apiUrl, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
          body,
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new RoadmapperProviderError("upstream_failed");
        }
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
        if (contentType !== "application/json") {
          void response.body?.cancel().catch(() => {});
          throw new RoadmapperProviderError("invalid_response");
        }
        if (Number(response.headers.get("content-length")) > settings.maxOutputBytes) {
          void response.body?.cancel().catch(() => {});
          throw new RoadmapperProviderError("output_limit");
        }
        if (!response.body) throw new RoadmapperProviderError("invalid_response");
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > settings.maxOutputBytes) throw new RoadmapperProviderError("output_limit");
          chunks.push(chunk.value);
        }
        try {
          const envelope: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
          return parseMessage(envelope);
        } catch { throw new RoadmapperProviderError("invalid_response"); }
      };
      const deadline = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(new RoadmapperProviderError("cancelled"));
          controller.abort();
          void reader?.cancel().catch(() => {});
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          reject(new RoadmapperProviderError("timeout"));
          controller.abort();
          void reader?.cancel().catch(() => {});
        }, settings.timeoutMs);
      });
      try { return await Promise.race([work(), deadline]); }
      catch (error) {
        controller.abort();
        void reader?.cancel().catch(() => {});
        if (error instanceof RoadmapperProviderError) throw error;
        throw new RoadmapperProviderError("network_failed");
      } finally {
        clearTimeout(timer);
        if (onAbort) options.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMessage(envelope: unknown): unknown {
  if (!record(envelope) || !Array.isArray(envelope.choices)) throw new Error();
  const choice: unknown = envelope.choices[0];
  if (!record(choice) || choice.finish_reason !== "stop" || !record(choice.message)) throw new Error();
  const message = choice.message;
  if (message.role !== "assistant" || message.refusal || "tool_calls" in message || "function_call" in message ||
      typeof message.content !== "string" || !message.content.trim()) throw new Error();
  const result: unknown = JSON.parse(message.content, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error();
    return value;
  });
  if (!record(result)) throw new Error();
  return result;
}
