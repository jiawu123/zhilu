import { afterEach, describe, expect, it, vi } from "vitest";
import { requestSession } from "./interview-api";
afterEach(() => vi.useRealTimers());
describe("interview request failures", () => {
  it("shows a connection error when the backend is not running", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    await expect(requestSession("/api/interviews", { goal: "目标" }, request)).rejects.toThrow("8787 服务是否运行");
  });
  it("shows the concrete configuration error returned by the server", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "模型 Key 未配置" }), { status: 503 }));
    await expect(requestSession("/api/interviews", {}, request)).rejects.toThrow("模型 Key 未配置");
  });
  it("rejects non-JSON proxy failures with an actionable status", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
    await expect(requestSession("/api/interviews", {}, request)).rejects.toThrow("HTTP 502");
  });
  it("retains the saved session supplied with a generation failure", async () => {
    const session = { id: "interview-test", questions: [], answers: [], generationError: "生成失败" };
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "生成失败", session }), { status: 502 }));
    await expect(requestSession("/api/interviews", {}, request)).rejects.toMatchObject({ message: "生成失败", session });
  });
  it("times out an unresponsive backend instead of leaving the spinner forever", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const assertion = expect(requestSession("/api/interviews", {}, request)).rejects.toThrow("等待服务响应超时");
    await vi.advanceTimersByTimeAsync(910000);
    await assertion;
  });
});
