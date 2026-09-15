import { describe, expect, it } from "vitest";
import { unwrapStreamResponse } from "./stream-response";

describe("CloudBase response transport", () => {
  it("preserves a backend error and saved interview across split UTF-8 stream chunks", async () => {
    const body = JSON.stringify({ error: "模型超时", session: { id: "saved-interview" } });
    const bytes = new TextEncoder().encode(`: heartbeat\n\nevent: response\ndata: ${JSON.stringify({ status: 504, body, contentType: "application/json" })}\n\n`);
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    } });
    const response = await unwrapStreamResponse(new Response(stream, { headers: { "X-Zhilu-Transport": "sse" } }));
    expect(response.status).toBe(504);
    expect(response.ok).toBe(false);
    expect(await response.json()).toEqual({ error: "模型超时", session: { id: "saved-interview" } });
  });
  it("rejects a dropped connection without treating heartbeats as success", async () => {
    await expect(unwrapStreamResponse(new Response(": heartbeat\n\n", { headers: { "X-Zhilu-Transport": "sse" } }))).rejects.toThrow("未收到最终结果");
  });
  it("leaves normal local responses untouched", async () => {
    const response = new Response("{}", { status: 422 });
    expect(await unwrapStreamResponse(response)).toBe(response);
  });
});
