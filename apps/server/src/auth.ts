import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export class AuthError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export interface AuthProfile { id: string; name: string; avatarUrl?: string }
export interface AuthConfig { mode: "local" | "zhihu"; appId: string; appKey: string; redirectUri: string }
export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const configured = Boolean(env.ZHIHU_OAUTH_APP_ID || env.ZHIHU_OAUTH_APP_KEY || env.ZHIHU_OAUTH_REDIRECT_URI);
  if (env.ZHILU_AUTH_MODE && !["local", "zhihu"].includes(env.ZHILU_AUTH_MODE)) throw new AuthError(500, "ZHILU_AUTH_MODE 配置无效。");
  const mode = env.ZHILU_AUTH_MODE === "zhihu" || configured || env.NODE_ENV === "production" ? "zhihu" : "local";
  return { mode, appId: env.ZHIHU_OAUTH_APP_ID ?? "", appKey: env.ZHIHU_OAUTH_APP_KEY ?? "", redirectUri: env.ZHIHU_OAUTH_REDIRECT_URI ?? "" };
}
const cookieName = "__Host-zhilu-session";
const lifetime = 8 * 60 * 60 * 1000;
const nonce = () => randomBytes(32).toString("base64url");
interface Session { expiresAt: number; state?: string; stateExpiresAt?: number; profile?: AuthProfile }

export function createAuth(config: AuthConfig, request: typeof fetch = fetch, now = Date.now) {
  const sessions = new Map<string, Session>();
  let callback: URL | undefined;
  try { callback = new URL(config.redirectUri); } catch { /* Report missing configuration in status. */ }
  const validCallback = callback?.protocol === "https:" && !callback.username && !callback.password && !callback.hash
    && !["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname) && callback.pathname === "/api/auth/callback";
  const missing = [!config.appId && "App ID", !config.appKey && "App Key", !validCallback && "公网 HTTPS 回调地址（/api/auth/callback）"].filter(Boolean);
  const ready = missing.length === 0;
  function cookie(req: IncomingMessage) { return req.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1); }
  function setCookie(res: ServerResponse, id: string, age: number) {
    res.setHeader("Set-Cookie", `${cookieName}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`);
  }
  function session(req: IncomingMessage) {
    for (const [id, item] of sessions) if (item.expiresAt <= now()) sessions.delete(id);
    return sessions.get(cookie(req) ?? "");
  }
  function identity(req: IncomingMessage): AuthProfile | undefined { return session(req)?.profile; }
  function requireIdentity(req: IncomingMessage) {
    const profile = identity(req);
    if (!profile) throw new AuthError(401, "请先登录知乎；登录失效时需重新授权。");
    return profile;
  }
  function checkMutation(req: IncomingMessage) {
    if (config.mode === "local" || ["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET")) return;
    if (!ready || req.headers.origin !== callback!.origin || req.headers["sec-fetch-site"] === "cross-site") throw new AuthError(403, "请求来源无效，请从本站页面操作。");
  }
  async function payload(url: string, options: RequestInit): Promise<Record<string, unknown>> {
    try {
      const response = await request(url, { ...options, redirect: "error", signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error();
      // Node 24 supplies the original numeric token, preserving int64 IDs before Number rounding.
      const data = JSON.parse(await response.text(), (key, value, context?: { source?: string }) => {
        if (key === "uid" && typeof value === "number") {
          if (context?.source && /^\d+$/.test(context.source)) return context.source;
          if (Number.isSafeInteger(value)) return String(value);
          throw new Error();
        }
        return value;
      });
      if (!record(data)) throw new Error();
      const code = data.code ?? data.Code;
      if (code !== undefined && ![0, 20000, "0", "20000"].includes(code as number)) throw new Error();
      return record(data.data) ? data.data : record(data.Data) ? data.Data : data;
    } catch { throw new AuthError(502, "知乎授权服务返回异常或授权已失效，请重新登录。"); }
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://local");
    if (!url.pathname.startsWith("/api/auth/")) return false;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const json = (data: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.method === "GET" && url.pathname === "/api/auth/status") {
      const profile = identity(req);
      json({ mode: config.mode, configured: ready, missing, authenticated: Boolean(profile), profile: profile ?? null, accountKey: profile?.id ?? "local" });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/auth/login") {
      if (!ready) throw new AuthError(503, `知乎登录尚未配置：${missing.join("、")}。`);
      // Clear the previous browser-bound attempt; each login has one short-lived nonce.
      sessions.delete(cookie(req) ?? "");
      const id = nonce(), state = nonce();
      session(req); // Prune expired entries before inserting an attempt.
      sessions.set(id, { expiresAt: now() + 600000, state, stateExpiresAt: now() + 600000 });
      setCookie(res, id, 600);
      const authorize = new URL("https://openapi.zhihu.com/authorize");
      for (const [k, v] of Object.entries({ app_id: config.appId, redirect_uri: config.redirectUri, response_type: "code", state })) authorize.searchParams.set(k, v);
      res.writeHead(302, { Location: authorize.toString() }).end();
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/auth/callback") {
      try {
        if (!ready) throw new AuthError(503, "知乎登录尚未配置。");
        const previous = cookie(req), current = session(req), state = url.searchParams.get("state");
        if (!current?.state || !state || !current.stateExpiresAt || current.stateExpiresAt <= now() || !equal(state, current.state)) throw new AuthError(400, "授权请求已失效，请重新登录。");
        // Consume synchronously before any network work, including failed exchanges.
        sessions.delete(previous!);
        const code = url.searchParams.get("authorization_code") ?? url.searchParams.get("code");
        if (!code || code.length > 4096 || url.searchParams.has("error")) throw new AuthError(400, "授权未完成。");
        const token = await payload("https://openapi.zhihu.com/access_token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ app_id: config.appId, app_key: config.appKey, grant_type: "authorization_code", redirect_uri: config.redirectUri, code }).toString() });
        if (typeof token.access_token !== "string" || !token.access_token) throw new AuthError(502, "未取得知乎授权令牌。");
        const user = await payload("https://openapi.zhihu.com/user", { headers: { Authorization: `Bearer ${token.access_token}` } });
        const stableId = typeof user.hash_id === "string" && user.hash_id ? `hash:${user.hash_id}` : typeof user.uid === "string" && /^\d+$/.test(user.uid) ? `uid:${user.uid}` : undefined;
        if (!stableId) throw new AuthError(502, "知乎未返回有效用户标识。");
        const profile: AuthProfile = { id: createHash("sha256").update(stableId).digest("hex"), name: typeof user.fullname === "string" && user.fullname ? user.fullname.slice(0, 100) : "知乎用户" };
        if (typeof user.avatar_path === "string" && /^https:\/\//.test(user.avatar_path)) profile.avatarUrl = user.avatar_path;
        const expires = Number(token.expires_in);
        if (!Number.isFinite(expires) || expires <= 0) throw new AuthError(502, "知乎授权有效期无效。");
        const duration = Math.min(lifetime, expires * 1000), id = nonce();
        // Login only needs identity. Discard the OAuth token after the profile request.
        sessions.set(id, { profile, expiresAt: now() + duration });
        setCookie(res, id, Math.floor(duration / 1000));
        res.writeHead(303, { Location: "/?page=interview" }).end();
      } catch {
        res.writeHead(303, { Location: "/?auth_error=login_failed" }).end();
      }
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      checkMutation(req);
      sessions.delete(cookie(req) ?? ""); setCookie(res, "", 0); json({ ok: true }); return true;
    }
    throw new AuthError(404, "登录接口不存在。");
  }
  return { mode: config.mode, handle, requireIdentity, checkMutation };
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function equal(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
