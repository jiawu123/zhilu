import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { isAbsolute, join } from "node:path";
import {
  BoundaryError, parsePlanningResponse, parseResearchResponse, validateResearchInput,
  type BaselinePlanningResult, type M2ResearchInput, type ResearchProviderResult,
} from "./zhihu-boundary";

export interface ZhihuProvider {
  planForBaseline(input: { goal: string; user_context: Record<string, unknown> }): Promise<BaselinePlanningResult>;
  researchOne(input: M2ResearchInput): Promise<ResearchProviderResult>;
}
export interface ZhihuProviderConfig {
  pythonBin: string;
  pythonCwd: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** Trusted Server environment only. Never populated from an HTTP body. */
  env?: NodeJS.ProcessEnv;
}
interface ProcessDependencies {
  spawn?: (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
}
const messages = {
  invalid_configuration: "知乎 Provider 配置无效，请检查 Server 配置。",
  startup_failed: "Python 进程无法启动，请检查解释器、依赖和工作目录。",
  stdin_failed: "Python 进程未能完整接收输入。",
  process_failed: "Python 研究执行失败；未回退 Mock。",
  invalid_response: "Python 返回的协议或研究内容未通过校验。",
  timeout: "研究执行超时，已请求终止子进程。",
  output_limit: "Python 输出超过允许大小，已请求终止子进程。",
  cleanup_failed: "研究已中止，但无法确认全部子进程已清理。请检查 Server 主机。",
} as const;
export class ZhihuProviderError extends Error {
  readonly status: number;
  cleanupError?: "cleanup_failed";
  metrics?: Record<string, number>;
  upstreamCode?: string;
  constructor(public readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = "ZhihuProviderError";
    this.status = code === "timeout" ? 504 : 502;
  }
}

function integer(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ZhihuProviderError("invalid_configuration");
  return value;
}
/** Node reads its launch environment. Python independently loads packages/zhihu/.env. */
export function readZhihuProviderConfig(env: NodeJS.ProcessEnv = process.env): ZhihuProviderConfig {
  const pythonBin = env.ZHIHU_PYTHON_BIN ?? "";
  const pythonCwd = env.ZHIHU_PYTHON_CWD ?? "";
  if (!isAbsolute(pythonBin) || !isAbsolute(pythonCwd)) throw new ZhihuProviderError("invalid_configuration");
  const timeoutMs = integer(Number(env.ZHIHU_TIMEOUT_MS ?? 630000), 630000);
  return { pythonBin, pythonCwd, timeoutMs };
}

export function createZhihuProvider(config: ZhihuProviderConfig, dependencies: ProcessDependencies = {}): ZhihuProvider {
  if (!isAbsolute(config.pythonBin) || !isAbsolute(config.pythonCwd)) throw new ZhihuProviderError("invalid_configuration");
  const timeout = integer(config.timeoutMs ?? 630000, 630000);
  const stdoutLimit = integer(config.maxStdoutBytes ?? 2 * 1024 * 1024, 2 * 1024 * 1024);
  const stderrLimit = integer(config.maxStderrBytes ?? 64 * 1024, 64 * 1024);
  const start = dependencies.spawn ?? ((exe, args, options) => spawn(exe, args, { ...options, stdio: "pipe" }));
  // Freeze configuration for a request; never modify process.env or forward paths in JSON.
  const childEnv = { ...process.env, ...config.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" };

  async function execute(action: "plan" | "research", input: unknown): Promise<{ value: unknown; exitCode: number }> {
    let body: string;
    try { body = JSON.stringify(input); } catch { throw new BoundaryError("invalid_request"); }
    if (Buffer.byteLength(body, "utf8") > 64000) throw new BoundaryError("invalid_request");
    const args = ["-X", "utf8", "-u", "-m", "zhihu_m2.pipeline", "--action", action];
    if (action === "plan") args.push("--planning-profile", "jia-p0-baseline");
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = start(config.pythonBin, args, { cwd: config.pythonCwd, env: childEnv,
          shell: false, windowsHide: true, detached: process.platform !== "win32" });
      } catch { reject(new ZhihuProviderError("startup_failed")); return; }
      const chunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const timer = setTimeout(() => { void finish(new ZhihuProviderError("timeout"), true); }, timeout);
      const onStdout = (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > stdoutLimit) { void finish(new ZhihuProviderError("output_limit"), true); return; }
        chunks.push(Buffer.from(chunk));
      };
      const onStderr = (chunk: Buffer) => {
        // Count and discard logs; upstream logs are untrusted and may contain credentials.
        stderrBytes += chunk.length;
        if (stderrBytes > stderrLimit) void finish(new ZhihuProviderError("output_limit"), true);
      };
      const onError = () => { void finish(new ZhihuProviderError("startup_failed"), true); };
      const onStdinError = () => { void finish(new ZhihuProviderError("stdin_failed"), true); };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        if (signal !== null || code === null) {
          void finish(new ZhihuProviderError("process_failed"));
          return;
        }
        try {
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
          void finish(undefined, false, { value, exitCode: code });
        } catch { void finish(new ZhihuProviderError(code !== 0 && stdoutBytes === 0 ? "process_failed" : "invalid_response")); }
      };
      async function finish(error?: Error, terminate = false, output?: { value: unknown; exitCode: number }) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (terminate && !await terminateTree(child)) {
          const failure = error instanceof ZhihuProviderError ? error : new ZhihuProviderError("cleanup_failed");
          failure.cleanupError = "cleanup_failed";
          failure.message += " 无法确认全部子进程已清理。";
          error = failure;
        }
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
        child.off("close", onClose);
        child.off("error", onError);
        child.stdin.off("error", onStdinError);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        if (error) reject(error); else resolve(output!);
      }
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.once("error", onError);
      child.stdin.on("error", onStdinError);
      child.once("close", onClose);
      try { child.stdin.end(body, "utf8"); } catch { void finish(new ZhihuProviderError("stdin_failed"), true); }
    });
  }
  async function checked<T>(action: "plan" | "research", input: unknown, parse: (value: unknown) => T): Promise<T> {
    const output = await execute(action, input);
    try {
      const result = parse(output.value);
      if (output.exitCode !== 0) throw new ZhihuProviderError("invalid_response");
      return result;
    } catch (error) {
      if (error instanceof BoundaryError && error.code === "upstream_failed" && output.exitCode !== 0) {
        const failure = new ZhihuProviderError(error.upstreamCode === "research_timeout" ? "timeout" : "process_failed");
        if (error.metrics) failure.metrics = error.metrics;
        if (error.upstreamCode) failure.upstreamCode = error.upstreamCode;
        throw failure;
      }
      throw new ZhihuProviderError("invalid_response");
    }
  }
  return {
    async planForBaseline(input) {
      // Reuse the common input validation without asking the Planner to research anything.
      const validated = validateResearchInput({ ...input, request: {
        id: "validation-only", question: "输入校验", searchQueries: ["输入校验"], relevantUserConditions: [], evidenceLimit: 1,
      } });
      return checked("plan", { goal: validated.goal, user_context: validated.user_context }, parsePlanningResponse);
    },
    async researchOne(input) {
      const validated = validateResearchInput(input);
      return checked("research", validated, value => parseResearchResponse(value, validated.request));
    },
  };
}

/** Kill Python plus its CLI children. PID is OS-generated, never request data. */
async function terminateTree(child: ChildProcessWithoutNullStreams): Promise<boolean> {
  const pid = child.pid;
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return true;
  let success = true;
  if (process.platform === "win32") {
    success = await new Promise<boolean>(done => {
      // SystemRoot is trusted local process configuration; avoid resolving a user-supplied executable.
      const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
      const killer = spawn(executable, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
      const timer = setTimeout(() => { killer.kill(); done(false); }, 5000);
      const finish = (ok: boolean) => { clearTimeout(timer); done(ok); };
      killer.once("error", () => finish(false));
      killer.once("close", code => finish(code === 0));
    });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch (error) {
      success = error instanceof Error && "code" in error && error.code === "ESRCH";
    }
  }
  try { child.kill("SIGKILL"); } catch { /* already exited */ }
  return await waitForTermination(child, 2_000) && success;
}

function waitForTermination(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    let finished = false;
    const finish = (result: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveWait(result);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}
