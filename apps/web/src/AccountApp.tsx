import { Brand } from "./Brand";
import { useEffect, useState } from "react";
import type { InterviewSession } from "@zhilu/contracts";
import { App } from "./App";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { formatInterviewAnswer } from "./interview-answers";
import { formatApiError } from "./api-error";
import { trackedFetch, useRequestProgress } from "./request-progress";

interface AuthStatus { mode: "local" | "zhihu"; configured: boolean; authenticated: boolean; accountKey: string; missing: string[]; profile: { name: string } | null }
interface HistoryData {
  interviews: Array<{ id: string; goal: string; status: string; answerCount: number; questionCount: number; draftCount: number; updatedAt?: string; projectId?: string }>;
  projects: Array<{ id: string; goal: string; version: number; updatedAt: string; awaitingConfirmation: boolean }>;
}
const kinds = { questions_generated: "生成问题", answers_submitted: "提交回答", generation_failed: "生成失败，回答已保留", summary_generated: "生成背景摘要", project_created: "确认背景并创建项目" };
async function read<T>(path: string): Promise<T> {
  const response = await trackedFetch(path, { signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) throw new Error(formatApiError(data, response.status));
  return data as T;
}
const accountScreen = () => {
  const query = new URLSearchParams(window.location.search);
  return query.get("page") === "login" ? "login" : query.get("page") === "projects" || !query.size ? "projects" : "workspace";
};

export function AccountApp() {
  const [screen, setScreen] = useState(accountScreen);
  const [workspaceMounted] = useState(() => accountScreen() === "workspace");
  const [exiting, setExiting] = useState(false);
  const activity = useRequestProgress();
  const pendingRequest = activity.length > 0;
  useEffect(() => {
    const restore = () => setScreen(accountScreen());
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<InterviewSession | null>(null);
  const [planHistory, setPlanHistory] = useState<Array<{ id: string; createdAt: string; conversation: Array<{ role: string; content: string }> }> | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = () => { setError(""); void read<AuthStatus>("/api/auth/status").then(setAuth).catch(() => setError("服务连接失败，请稍后重试。")); };
  useEffect(refresh, []);
  const loadHistory = async (dialog = true) => {
    setOpen(dialog); setLoading(true); setError(""); setDetail(null); setPlanHistory(null);
    try { setHistory(await read<HistoryData>("/api/history")); } catch (e) { setError(e instanceof Error ? e.message : "历史读取失败"); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (auth && screen === "projects" && (auth.mode === "local" || auth.authenticated)) void loadHistory(false); }, [screen, auth?.accountKey]);
  const openProjects = () => {
    window.history.pushState(null, "", "?page=projects"); setScreen("projects");
  };
  const logout = async () => {
    if (exiting || pendingRequest) return;
    if (!window.dispatchEvent(new Event("beforeunload", { cancelable: true }))) {
      setError("存在尚未保存的内容，请完成保存后退出。"); return;
    }
    setExiting(true); setError("");
    try {
      const response = await trackedFetch("/api/auth/logout", { method: "POST", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(formatApiError(await response.json(), response.status));
      if (auth?.mode === "local") sessionStorage.setItem("zhilu-local-exited", "true");
      window.location.assign("/?page=login");
    } catch (e) { setError(e instanceof Error ? e.message : "退出失败，请重试。"); setExiting(false); }
  };
  const mayEnter = auth && (auth.mode === "local" || auth.authenticated);
  if (!auth) return <main className="account-login"><Brand /><p>{error || "正在读取登录状态…"}</p>{error && <button onClick={refresh}>重试连接</button>}</main>;
  if (!mayEnter || screen === "login" || (auth.mode === "local" && sessionStorage.getItem("zhilu-local-exited"))) return <main className="login-stage"><section className="login-layout"><div className="login-form-panel"><div className="login-wordmark"><Brand /></div><section className="account-login"><p className="section-kicker">项目与执行记录</p><h1>账号登录</h1><p>{auth.mode === "local" ? "背景资料与计划历史保存在当前本地工作区。" : "背景资料与计划历史将保存在当前账号下。"}</p>
    {new URLSearchParams(window.location.search).has("auth_error") && <p role="alert">知乎授权未完成、请求已过期或服务返回异常。请重新登录。</p>}
    {auth.configured ? <a className="account-login-link" href="/api/auth/login">使用知乎登录 →</a> : <><button className="account-login-link" disabled>使用知乎登录</button><p className="login-config-note">知乎登录暂未开放。</p></>}
    {auth.mode === "local" && <><p>当前服务为本地工作区，尚未启用账号认证。</p><button className="local-entry" onClick={() => { sessionStorage.removeItem("zhilu-local-exited"); window.location.assign("/?page=projects"); }}>进入本地工作区 →</button></>}
    {auth.mode === "zhihu" && auth.authenticated && <a href="/?page=projects">进入我的目标</a>}
    <button onClick={refresh}>刷新登录状态</button></section></div><div className="login-art" aria-hidden="true"><div className="login-orb"/><div className="login-glass"/></div></section></main>;
  const storageKey = `zhilu-interview:${auth.accountKey}`;
  const accountControls = <nav className="account-controls" aria-label="账户导航"><button disabled={exiting || pendingRequest} onClick={openProjects}>我的目标</button><button disabled={exiting || pendingRequest} onClick={() => void logout()}>{exiting ? "正在退出…" : auth.mode === "local" ? "退出工作区" : "退出登录"}</button></nav>;
  return <>
    {(workspaceMounted || screen === "workspace") && <div hidden={screen !== "workspace"}><App key={auth.accountKey} interviewStorageKey={storageKey} accountControls={accountControls} onOpenHistory={() => void loadHistory()} /></div>}
    {screen === "projects" && <main className="projects-page">
      <header className="projects-header"><Brand /><span>{auth.profile?.name ?? "本地工作区"}</span><button disabled={exiting || pendingRequest} onClick={() => void logout()}>{exiting ? "正在退出…" : auth.mode === "local" ? "退出工作区" : "退出登录"}</button></header>
      <section className="projects-content"><div className="projects-title"><div><p className="section-kicker">目标管理</p><h1>我的目标</h1><p>查看已创建的计划，或继续尚未完成的背景登记。</p></div><a className="project-create" href="/?page=interview&new=1">＋ 创建目标</a></div>
        {loading && <p className="projects-loading" role="status">正在读取目标与历史记录…</p>}
        {error && <div role="alert" className="projects-error">{error}<button onClick={() => void loadHistory(false)}>重新加载</button></div>}
        {!loading && history && <><div className="projects-section-title"><h2>项目计划</h2><span>{history.projects.length} 个目标</span></div>
          {history.projects.length === 0 && <div className="projects-empty"><h3>暂无已创建的计划</h3><p>完成目标登记与背景确认后，计划将显示在此处。</p><a href="/?page=interview&new=1">创建第一个目标 →</a></div>}
          <div className="project-grid">{history.projects.map(item => <a className="project-card" key={item.id} href={`/?project=${encodeURIComponent(item.id)}&page=${item.awaitingConfirmation ? "plan" : "roadmap"}`}><span className={`project-state ${item.awaitingConfirmation ? "is-pending" : ""}`}>{item.awaitingConfirmation ? "待确认" : "正式计划"}</span><h3>{item.goal}</h3><div><time>{new Date(item.updatedAt).toLocaleDateString("zh-CN")}</time><span>版本 {item.version}</span><b aria-hidden="true">↗</b></div></a>)}</div>
          {!!history.interviews.filter(item => !item.projectId).length && <><div className="projects-section-title"><h2>背景登记记录</h2></div><div className="project-grid">{history.interviews.filter(item => !item.projectId).map(item => <a key={item.id} className="project-card is-interview" href={`/?page=interview&interview=${encodeURIComponent(item.id)}`}><span className="project-state is-pending">{item.status === "complete" ? "待确认背景" : "背景登记中"}</span><h3>{item.goal}</h3><div><span>已提交 {item.answerCount} / {item.questionCount} 题</span><b aria-hidden="true">↗</b></div></a>)}</div></>}
        </>}
        <button className="projects-history" onClick={() => void loadHistory()}>查看全部历史记录 →</button>
      </section></main>}
    {error && screen === "workspace" && !open && <div role="alert" className="account-error">{error}<button aria-label="关闭账户提示" onClick={() => setError("")}>×</button></div>}
    {open && <WorkspaceDialog title="我的历史记录" onClose={() => setOpen(false)}>
      {loading && <p role="status">正在读取…</p>}{error && <p role="alert">{error}</p>}
      {planHistory ? <><button onClick={() => setPlanHistory(null)}>← 返回列表</button><h3>计划调整对话</h3>
        {planHistory.length === 0 && <p>暂无已保存的计划调整对话。</p>}
        {planHistory.map(item => <article key={item.id}><strong>{new Date(item.createdAt).toLocaleString()}</strong>{item.conversation.length === 0 ? <p>初始计划草稿</p> : item.conversation.map((message, i) => <p key={i}>{message.role === "user" ? "提交人" : "知路"}：{message.content}</p>)}</article>)}
      </> : detail ? <><button onClick={() => setDetail(null)}>← 返回列表</button><h3>{detail.goal}</h3>
        {detail.questions.map(q => <article key={q.id}><strong>{q.question}</strong><p>{formatInterviewAnswer(q, detail.answers.find(a => a.questionId === q.id) ?? detail.draftAnswers?.find(a => a.questionId === q.id))}</p></article>)}
        <h3>访谈过程</h3>{detail.history?.map((event, i) => <p key={i}>{new Date(event.at).toLocaleString()} · {kinds[event.kind]}{event.questionIds?.length ? `（${event.questionIds.length} 题）` : ""}</p>)}
      </> : <><h3>目标访谈</h3>{history?.interviews.length === 0 && <p>暂无访谈记录。</p>}
        {history?.interviews.map(item => <article key={item.id}><strong>{item.goal}</strong><p>{item.status === "complete" ? "已完成访谈" : "进行中"} · 已提交 {item.answerCount} / {item.questionCount} 题 · 草稿 {item.draftCount} 题{item.updatedAt && ` · ${new Date(item.updatedAt).toLocaleString()}`}</p>
          <a href={`/?page=interview&interview=${encodeURIComponent(item.id)}`}>{item.status === "complete" ? "查看背景摘要" : "继续访谈"}</a>
          <button onClick={() => { setLoading(true); setError(""); void read<InterviewSession>(`/api/interviews/${item.id}`).then(setDetail).catch(e => setError(e.message)).finally(() => setLoading(false)); }}>查看问答与过程</button>
          {item.projectId && <a href={`/?project=${encodeURIComponent(item.projectId)}&page=roadmap`}>打开关联计划</a>}
        </article>)}
        <h3>计划与版本历史</h3>{history?.projects.length === 0 && <p>暂无计划。</p>}{history?.projects.map(item => <article key={item.id}><strong>{item.goal}</strong><p>版本 {item.version} · {item.awaitingConfirmation ? "待确认" : "正式计划"} · {new Date(item.updatedAt).toLocaleString()}</p><a href={`/?project=${encodeURIComponent(item.id)}&page=${item.awaitingConfirmation ? "plan" : "roadmap"}`}>打开计划与历史</a><button onClick={() => { setLoading(true); setError(""); void read<NonNullable<typeof planHistory>>(`/api/projects/${item.id}/planning-history`).then(setPlanHistory).catch(e => setError(e.message)).finally(() => setLoading(false)); }}>调整对话历史</button></article>)}</>}
    </WorkspaceDialog>}
  </>;
}
