import { useSyncExternalStore } from "react";
import { unwrapStreamResponse } from "./stream-response";

export interface RequestProgress {
  id: string;
  path: string;
  startedAt: number;
  label: string;
  steps: Array<{ message: string; at: number }>;
  connectionLost?: boolean;
}
let active: RequestProgress[] = [];
const listeners = new Set<() => void>();
const empty: RequestProgress[] = [];
export function isRoadmapChatRequest(path: string): boolean {
  return /^\/api\/projects\/[^/]+\/chat(?:\/(?:apply|discard))?$/.test(path);
}
function publish() { for (const listener of listeners) listener(); }
export function useRequestProgress() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => active, () => empty);
}
export function requestLabel(path: string, method = "GET") {
  if (method === "GET") return path.includes("auth") ? "正在读取登录状态…" : path.includes("interviews") ? "正在读取已保存的访谈…" : "正在读取计划与历史…";
  if (path.endsWith("/chat")) return "正在理解你的消息…";
  if (path.endsWith("/chat/apply")) return "正在更新计划与路线图…";
  if (path.endsWith("/baseline/revise")) return "正在发送你的调整意见…";
  if (path.endsWith("/baseline/apply")) return "正在确认并保存当前计划…";
  if (path.endsWith("/research/live/baseline")) return "正在准备知乎研究与计划生成…";
  if (path.includes("/replan")) return "正在准备调整受影响任务的时间…";
  if (path.endsWith("/draft")) return "正在保存回答…";
  if (path.includes("/interviews")) return "正在提交背景信息，准备生成访谈结果…";
  return "正在保存你的操作…";
}

/** Progress polling never delays, retries or duplicates the original operation. */
export async function trackedFetch(path: string, init?: RequestInit, request: typeof fetch = fetch): Promise<Response> {
  const id = crypto.randomUUID(), startedAt = Date.now();
  active = [...active, { id, path, startedAt, label: requestLabel(path, init?.method), steps: [] }]; publish();
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const update = (changes: Partial<RequestProgress>) => {
    if (ended) return;
    active = active.map(item => item.id === id ? { ...item, ...changes } : item); publish();
  };
  const poll = async () => {
    try {
      const response = await request(`/api/operations/${id}`, { signal: controller.signal });
      if (response.ok) {
        const progress = await response.json();
        if (Array.isArray(progress.steps)) update({ steps: progress.steps, connectionLost: false });
      } else update({ connectionLost: true });
    } catch { update({ connectionLost: true }); }
    if (!ended) timer = setTimeout(() => void poll(), 1000);
  };
  if (!path.startsWith("/api/auth/")) timer = setTimeout(() => void poll(), 800);
  try {
    const headers = new Headers(init?.headers);
    headers.set("X-Zhilu-Operation-Id", id);
    if (import.meta.env.VITE_CLOUDBASE_TRANSPORT === "sse" && init?.method && !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase()) && !path.startsWith("/api/auth/")) {
      headers.set("X-Zhilu-Transport", "sse");
      headers.set("Accept", "text/event-stream");
    }
    return await unwrapStreamResponse(await request(path, { ...init, headers }));
  } finally {
    ended = true; clearTimeout(timer); controller.abort();
    active = active.filter(item => item.id !== id); publish();
  }
}
