import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createZhiluServer } from "./index";
import { PlanRepository } from "./repository";
import { readAuthConfig } from "./auth";
import { syntheticM3Snapshot } from "./fixtures/m3-replay";

const config = { mode: "zhihu" as const, appId: "test-app", appKey: "test-only-app-key", redirectUri: "https://zhilu.example/api/auth/callback" };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); vi.useRealTimers(); });
async function setup(userBody = '{"uid":969570047710216201,"fullname":"测试用户"}') {
  const root = await mkdtemp(join(tmpdir(), "zhilu-auth-"));
  const repository = new PlanRepository(root, "unused");
  const oauthFetch = vi.fn<typeof fetch>(async url => new Response(String(url).endsWith("/access_token")
    ? JSON.stringify({ code: 20000, data: { access_token: "test-private-token", expires_in: 3600 } }) : userBody));
  const generate = vi.fn(async () => ({ done: false, questions: [{ type: "single", question: "你想怎样开始？", options: ["先练习", "先尝试"] }] }));
  const server = createZhiluServer(repository, { authConfig: config, oauthFetch, roadmapperProvider: { generate } });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  cleanup.push(async () => { await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const req = (path: string, cookie?: string, body?: unknown, source = "https://zhilu.example") => fetch(origin + path, { redirect: "manual",
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: source, "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  const begin = async () => {
    const response = await req("/api/auth/login");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax");
    return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, state: new URL(response.headers.get("location")!).searchParams.get("state")! };
  };
  const finish = (attempt: { cookie: string; state: string }) => req(`/api/auth/callback?authorization_code=sample-code&state=${attempt.state}`, attempt.cookie);
  const login = async () => {
    const attempt = await begin(), response = await finish(attempt);
    expect(response.headers.get("location")).toBe("/?page=interview");
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    expect(cookie).not.toBe(attempt.cookie);
    return cookie;
  };
  return { req, begin, finish, login, repository, oauthFetch, generate };
}

describe("Zhihu login and account boundaries", () => {
  it("fails closed in production or partial config and keeps local mode explicit", () => {
    expect(readAuthConfig({ NODE_ENV: "production", ZHILU_AUTH_MODE: "local" }).mode).toBe("zhihu");
    expect(readAuthConfig({ ZHIHU_OAUTH_APP_ID: "x" }).mode).toBe("zhihu");
    expect(readAuthConfig({}).mode).toBe("local");
  });
  it("exchanges once, preserves int64 identity and exposes no OAuth token", async () => {
    const t = await setup(), cookie = await t.login();
    const response = await t.req("/api/auth/status", cookie), body = await response.json();
    expect(body.profile.id).toBe(createHash("sha256").update("uid:969570047710216201").digest("hex"));
    expect(JSON.stringify(body)).not.toMatch(/test-private-token|test-only-app-key|sample-code/);
    const form = new URLSearchParams(t.oauthFetch.mock.calls[0]![1]!.body as string);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("sample-code");
    expect(t.oauthFetch.mock.calls[1]![1]!.headers).toEqual({ Authorization: "Bearer test-private-token" });
  });
  it("rejects absent, incorrect, cross-browser and reused state without exchanging tokens", async () => {
    const t = await setup(), a = await t.begin(), b = await t.begin();
    for (const path of ["/api/auth/callback?authorization_code=x", `/api/auth/callback?authorization_code=x&state=${b.state}`, "/api/auth/callback?authorization_code=x&state=wrong"]) {
      expect((await t.req(path, a.cookie)).headers.get("location")).toContain("auth_error");
    }
    expect(t.oauthFetch).not.toHaveBeenCalled();
    await t.finish(a);
    expect(t.oauthFetch).toHaveBeenCalledTimes(2);
    await t.finish(a);
    expect(t.oauthFetch).toHaveBeenCalledTimes(2);
  });
  it("expires login attempts and sessions and invalidates logout", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = await setup(), a = await t.begin();
    vi.setSystemTime(Date.now() + 600001);
    expect((await t.finish(a)).headers.get("location")).toContain("auth_error");
    expect(t.oauthFetch).not.toHaveBeenCalled();
    const cookie = await t.login();
    expect((await t.req("/api/auth/logout", cookie, {})).status).toBe(200);
    expect((await t.req("/api/history", cookie)).status).toBe(401);
    const renewed = await t.login();
    vi.setSystemTime(Date.now() + 3600001);
    expect((await t.req("/api/history", renewed)).status).toBe(401);
  });
  it("rejects HTTP-200 profile errors and invalid identities without creating a session", async () => {
    const t = await setup('{"code":404,"data":"User does not exist"}');
    const response = await t.finish(await t.begin());
    expect(response.headers.get("location")).toContain("auth_error");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it("isolates interviews, projects, exports and history across users and legacy local data", async () => {
    const t = await setup(), alice = await t.login();
    const created = await t.req("/api/interviews", alice, { goal: "Alice 的目标" });
    const interview = await created.json();
    const aliceId = (await (await t.req("/api/auth/status", alice)).json()).profile.id;
    const plan = syntheticM3Snapshot().plan;
    plan.projectId = "project-1234abcd";
    await t.repository.forAccount(aliceId).savePlan(plan);
    await t.repository.savePlan({ ...plan, projectId: "project-11111111" });
    t.oauthFetch.mockImplementation(async url => new Response(String(url).endsWith("/access_token") ? '{"access_token":"bob-token","expires_in":3600}' : '{"hash_id":"bob","fullname":"Bob"}'));
    const bob = await t.login();
    expect((await t.req(`/api/interviews/${interview.id}`, bob)).status).toBe(404);
    expect((await t.req(`/api/interviews/${interview.id}/draft`, bob, { answers: [] })).status).toBe(404);
    expect((await t.req("/api/projects/project-1234abcd", bob)).status).toBe(404);
    expect((await t.req("/api/projects/project-1234abcd/export/json", bob)).status).toBe(404);
    expect(await (await t.req("/api/history", bob)).json()).toEqual({ interviews: [], projects: [] });
    expect((await (await t.req("/api/history", alice)).json()).projects).toHaveLength(1);
    expect((await t.req("/api/projects/project-11111111", alice)).status).toBe(404);
    expect((await t.req("/api/history")).status).toBe(401);
  });
  it("blocks cross-site writes before reading or changing user data", async () => {
    const t = await setup(), cookie = await t.login();
    expect((await t.req("/api/interviews", cookie, { goal: "forged" }, "https://evil.example")).status).toBe(403);
    expect((await t.req("/api/auth/logout", cookie, {}, "https://evil.example")).status).toBe(403);
    expect(t.generate).not.toHaveBeenCalled();
    expect((await t.req("/api/history", cookie)).status).toBe(200);
  });
});
