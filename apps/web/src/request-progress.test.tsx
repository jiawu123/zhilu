import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { trackedFetch, requestLabel, isRoadmapChatRequest } from "./request-progress";
import { WaitStatus } from "./WaitStatus";
afterEach(() => vi.useRealTimers());

describe("shared waiting feedback", () => {
  it("keeps all chat waits in the chat panel while retaining other global waits", () => {
    for (const suffix of ["", "/apply", "/discard"]) expect(isRoadmapChatRequest(`/api/projects/p/chat${suffix}`)).toBe(true);
    expect(isRoadmapChatRequest("/api/projects/p/nodes/t1")).toBe(false);
    expect(isRoadmapChatRequest("/api/projects/p")).toBe(false);
  });
  it("polls separately and stops all polling after the original result", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const request = vi.fn<typeof fetch>(async path => String(path).includes("/operations/")
      ? new Response(JSON.stringify({ steps: [{ message: "正在检查", at: Date.now() }] }))
      : new Promise<Response>(done => { finish = done; }));
    const result = trackedFetch("/api/projects/p/baseline/revise", { method: "POST", body: "{}" }, request);
    await vi.advanceTimersByTimeAsync(2800);
    expect(request.mock.calls.filter(([path]) => String(path).endsWith("/revise"))).toHaveLength(1);
    const headers = request.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get("X-Zhilu-Operation-Id")).toMatch(/^[a-f0-9-]{36}$/);
    finish(new Response("{}")); await result;
    const count = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(request).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up after a network failure and never retries the action", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    await expect(trackedFetch("/api/interviews", { method: "POST" }, request)).rejects.toThrow("offline");
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders the actual stage, full elapsed time and previous steps without invented progress", () => {
    const now = Date.now();
    const html = renderToStaticMarkup(createElement(WaitStatus, { label: "等待", progress: {
      id: "test", path: "/api/interviews", startedAt: now - 45000, label: "等待",
      steps: [{ message: "我正在生成问题", at: now - 45000 }, { message: "正在校验问题", at: now - 2000 }],
    } }));
    expect(html).toContain("正在校验问题"); expect(html).toContain("45");
    expect(html).toContain("model-spinner"); expect(html).toContain("查看已执行步骤");
    expect(html).not.toContain("正在整理结果");
    expect(requestLabel("/api/projects/p/baseline/revise", "POST")).not.toContain("保存");
    expect(requestLabel("/api/projects/p/baseline/apply", "POST")).toContain("确认并保存");
  });
});
