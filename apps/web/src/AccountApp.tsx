import { Brand } from "./Brand";
import { useEffect, useState } from "react";
import type { InterviewSession } from "@zhilu/contracts";
import { App } from "./App";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { formatInterviewAnswer } from "./interview-answers";
import { formatApiError } from "./api-error";
import { trackedFetch } from "./request-progress";

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
export function AccountApp() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<InterviewSession | null>(null);
  const [planHistory, setPlanHistory] = useState<Array<{ id: string; createdAt: string; conversation: Array<{ role: string; content: string }> }> | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = () => { setError(""); void read<AuthStatus>("/api/auth/status").then(setAuth).catch(() => setError("服务连接失败，请稍后重试。")); };
  useEffect(refresh, []);
  const loadHistory = async () => {
    setOpen(true); setLoading(true); setError(""); setDetail(null); setPlanHistory(null);
    try { setHistory(await read<HistoryData>("/api/history")); } catch (e) { setError(e instanceof Error ? e.message : "历史读取失败"); }
    finally { setLoading(false); }
  };
  const mayEnter = auth && (auth.mode === "local" || auth.authenticated);
  if (!auth) return <main className="account-login"><Brand /><p>{error || "正在读取登录状态…"}</p>{error && <button onClick={refresh}>重试连接</button>}</main>;
  if (!mayEnter) return <main className="account-login"><Brand /><p className="section-kicker">项目与执行记录</p><h1>账号登录</h1><p>背景资料与计划历史将保存在当前账号下。</p>
    {new URLSearchParams(window.location.search).has("auth_error") && <p role="alert">知乎授权未完成、请求已过期或服务返回异常。请重新登录。</p>}
    {auth.configured ? <a className="account-login-link" href="/api/auth/login">使用知乎登录 →</a> : <p role="alert">登录尚未配置：{auth.missing.join("、")}。配置完成后重启后端。</p>}
    <button onClick={refresh}>刷新登录状态</button></main>;
  const storageKey = `zhilu-interview:${auth.accountKey}`;
  return <><App key={auth.accountKey} interviewStorageKey={storageKey} onOpenHistory={() => void loadHistory()} />
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
