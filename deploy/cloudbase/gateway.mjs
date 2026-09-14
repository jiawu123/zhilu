import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

// CloudBase terminates HTTPS. Only the public build directory is served here.
export function createGateway({ webRoot, backendPort = 8787, heartbeatMs = 10000 }) {
  const root = resolve(webRoot);
  return createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://local").pathname;
    if (pathname.startsWith("/api/")) {
      // Keep the existing backend JSON contract; wrap only clients that opt in.
      const streaming = req.headers["x-zhilu-transport"] === "sse" && !pathname.startsWith("/api/auth/") && !["GET", "HEAD", "OPTIONS"].includes(req.method);
      let timer;
      const finish = (status, body, contentType = "application/json") => {
        if (res.destroyed || res.writableEnded) return;
        res.end(`event: response\ndata: ${JSON.stringify({ status, body, contentType })}\n\n`);
      };
      const headers = { ...req.headers };
      delete headers["x-zhilu-transport"];
      if (streaming) {
        // The backend returns its ordinary JSON even if a caller requests SSE here.
        headers.accept = "application/json";
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no", "X-Zhilu-Transport": "sse" });
        res.write(": connected\n\n");
        timer = setInterval(() => res.write(": heartbeat\n\n"), heartbeatMs);
      }
      const upstream = httpRequest({ hostname: "127.0.0.1", port: backendPort, path: req.url, method: req.method, headers }, incoming => {
        if (!streaming) {
          res.writeHead(incoming.statusCode, incoming.headers);
          incoming.pipe(res);
          incoming.on("error", () => res.destroy());
          return;
        }
        const chunks = [];
        let size = 0;
        incoming.on("data", chunk => {
          size += chunk.length;
          if (size > 20 * 1024 * 1024) {
            finish(502, JSON.stringify({ error: "服务响应过大，请缩小请求范围。" }));
            incoming.destroy();
          } else chunks.push(chunk);
        });
        incoming.on("end", () => finish(incoming.statusCode, Buffer.concat(chunks).toString("utf8"), incoming.headers["content-type"]));
        incoming.on("error", () => finish(502, JSON.stringify({ error: "后端响应中断，请检查已保存的状态。" })));
      });
      upstream.on("error", () => {
        const body = JSON.stringify({ error: "后端暂不可用，请稍后重试。" });
        if (streaming) finish(502, body);
        else if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" }).end(body);
        else res.destroy();
      });
      res.on("close", () => { clearInterval(timer); upstream.destroy(); });
      req.on("aborted", () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405).end(); return; }
    try {
      const decoded = decodeURIComponent(pathname);
      if (decoded.split("/").some(part => part.startsWith(".")) || decoded.includes("\\")) { res.writeHead(404).end(); return; }
      const file = resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`);
      if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": extname(file) === ".html" ? "no-cache" : "public, max-age=3600", "X-Content-Type-Options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch { res.writeHead(404).end(); }
  });
}
