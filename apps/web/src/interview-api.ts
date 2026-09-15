import type { InterviewSession } from "@zhilu/contracts";
import { INTERVIEW_GENERATION_ATTEMPTS } from "@zhilu/contracts";
import { formatApiError } from "./api-error";
import { trackedFetch } from "./request-progress";

export class InterviewRequestError extends Error {
  constructor(message: string, public readonly session?: InterviewSession) { super(message); }
}

export async function requestSession(path: string, body?: unknown, request: typeof fetch = fetch): Promise<InterviewSession> {
  const controller = new AbortController();
  // Each of the bounded generation attempts can take up to 300 seconds.
  const timer = setTimeout(() => controller.abort(), body === undefined ? 15000 : INTERVIEW_GENERATION_ATTEMPTS * 300000 + 10000);
  try {
    let response: Response;
    try {
      response = await trackedFetch(path, { signal: controller.signal, ...(body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }) }, request);
    } catch {
      throw new Error(controller.signal.aborted ? "等待服务响应超时，未收到模型结果。请检查后端运行状态后重试，当前回答仍保留。" : "无法连接本地后端，模型请求未完成。请检查 8787 服务是否运行后重试。");
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new Error(`服务未返回有效结果（HTTP ${response.status}），请检查后端日志后重试。`); }
    if (!response.ok) {
      const saved = payload && typeof payload === "object" && "session" in payload ? payload.session as InterviewSession : undefined;
      throw new InterviewRequestError(formatApiError(payload, response.status), saved);
    }
    if (!payload || typeof payload !== "object" || !("id" in payload) || !("questions" in payload)) throw new Error("服务返回的访谈格式无效，请重试。");
    return payload as InterviewSession;
  } finally { clearTimeout(timer); }
}
