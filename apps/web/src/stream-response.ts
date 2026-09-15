/** Unwrap the deployment gateway's keepalive stream into the existing JSON response. */
export async function unwrapStreamResponse(response: Response): Promise<Response> {
  if (response.headers.get("X-Zhilu-Transport") !== "sse") return response;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("服务未返回响应流。");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("服务连接中断，未收到最终结果，请先检查已保存状态。");
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!event.startsWith("event: response\n")) continue;
        const payload = JSON.parse(event.slice("event: response\ndata: ".length)) as { status: number; body: string; contentType: string };
        return new Response([204, 205, 304].includes(payload.status) ? null : payload.body, {
          status: payload.status, headers: { "Content-Type": payload.contentType },
        });
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
