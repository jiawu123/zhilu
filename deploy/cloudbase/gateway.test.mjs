import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "./gateway.mjs";

test("gateway keeps delayed errors alive, forwards auth cookies and serves only public files", async t => {
  const root = await mkdtemp(join(tmpdir(), "zhilu-gateway-"));
  await writeFile(join(root, "index.html"), "<h1>Zhilu</h1>");
  let calls = 0;
  const backend = createServer((req, res) => {
    calls++;
    if (req.url === "/api/auth/login") {
      res.writeHead(302, { Location: "https://openapi.zhihu.com/authorize", "Set-Cookie": "test=session; Secure; HttpOnly" }).end();
    } else {
      assert.equal(req.headers.origin, "https://zhilu.example");
      assert.equal(req.headers.accept, "application/json");
      setTimeout(() => res.writeHead(422, { "Content-Type": "application/json" }).end('{"error":"校验失败","session":{"id":"saved"}}'), 100);
    }
  });
  await new Promise(done => backend.listen(0, "127.0.0.1", done));
  const gateway = createGateway({ webRoot: root, backendPort: backend.address().port, heartbeatMs: 10 });
  await new Promise(done => gateway.listen(0, "127.0.0.1", done));
  t.after(async () => { gateway.closeAllConnections(); backend.closeAllConnections(); await Promise.all([new Promise(done => gateway.close(done)), new Promise(done => backend.close(done))]); await rm(root, { recursive: true }); });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const response = await fetch(base + "/api/interviews", { method: "POST", headers: { "X-Zhilu-Transport": "sse", Accept: "text/event-stream", Origin: "https://zhilu.example" }, body: "{}" });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /: connected/);
  assert.doesNotMatch(first, /event: response/);
  let text = first;
  while (true) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); }
  assert.match(text, /: heartbeat/);
  const payload = JSON.parse(text.split("data: ")[1].trim());
  assert.equal(payload.status, 422);
  assert.equal(JSON.parse(payload.body).session.id, "saved");
  const auth = await fetch(base + "/api/auth/login", { redirect: "manual" });
  assert.equal(auth.status, 302);
  assert.match(auth.headers.get("set-cookie"), /Secure; HttpOnly/);
  assert.equal(calls, 2);
  assert.equal(await (await fetch(base + "/")).text(), "<h1>Zhilu</h1>");
  for (const path of ["/.env", "/%2e%2e%2f.env", "/data/plan.json", "/missing.js"]) assert.equal((await fetch(base + path)).status, 404);
});
