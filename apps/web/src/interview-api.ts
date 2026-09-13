import type { InterviewSession } from "@zhilu/contracts";
import { formatApiError } from "./api-error";

export async function requestSession(path: string, body?: unknown, request: typeof fetch = fetch): Promise<InterviewSession> {
  const controller = new AbortController();
  // Server model timeout is at most 300 seconds; leave time for its explicit error response.
  const timer = setTimeout(() => controller.abort(), body === undefined ? 15000 : 310000);
  try {
    let response: Response;
    try {
      response = await request(path, { signal: controller.signal, ...(body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }) });
    } catch {
      throw new Error(controller.signal.aborted ? "等待服务响应超时，未收到模型结果。请检查后端运行状态后重试，当前回答仍保留。" : "无法连接本地后端，模型请求未完成。请检查 8787 服务是否运行后重试。");
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new Error(`服务未返回有效结果（HTTP ${response.status}），请检查后端日志后重试。`); }
    if (!response.ok) throw new Error(formatApiError(payload, response.status));
    if (!payload || typeof payload !== "object" || !("id" in payload) || !("questions" in payload)) throw new Error("服务返回的访谈格式无效，请重试。");
    return payload as InterviewSession;
  } finally { clearTimeout(timer); }
}
