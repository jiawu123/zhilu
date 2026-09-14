import { useEffect, useState } from "react";
import type { CreateProjectInput, InterviewAnswer, InterviewSession } from "@zhilu/contracts";
import { requestSession } from "./interview-api";
import { InterviewQuestionCard } from "./InterviewQuestionCard";
import { answerIsComplete, formatInterviewAnswer } from "./interview-answers";
import { Brand } from "./Brand";
import { ErrorNotice } from "./ErrorNotice";

interface OnboardingProps {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (input: CreateProjectInput) => void;
}

export function Onboarding({ busy, error, onClose, onCreate }: OnboardingProps) {
  const [goal, setGoal] = useState("");
  const [backgroundNotes, setBackgroundNotes] = useState("");
  const [fileMessage, setFileMessage] = useState("");
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [selected, setSelected] = useState<Record<string, InterviewAnswer>>({});
  const [summary, setSummary] = useState<CreateProjectInput | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const locked = busy || waiting;
  const pending = session?.questions.slice(session.answers.length) ?? [];
  const batchCompleted = pending.filter(question => answerIsComplete(question, selected[question.id])).length;
  const processedCount = (session?.answers.length ?? 0) + batchCompleted;
  const skippedCount = (session?.answers.filter(answer => answer.skipped).length ?? 0) + pending.filter(question => selected[question.id]?.skipped).length;
  useEffect(() => {
    if (!waiting) return;
    setElapsed(0);
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  const receive = (next: InterviewSession) => {
    setSession(next);
    setSummary(next.summary ?? null);
    setGoal(next.goal);
    setBackgroundNotes(next.backgroundNotes ?? "");
    setSelected({});
    sessionStorage.setItem("zhilu-interview", next.id);
  };
  useEffect(() => {
    const id = sessionStorage.getItem("zhilu-interview");
    if (!id) return;
    let cancelled = false;
    setWaiting(true);
    setRestoring(true);
    void requestSession(`/api/interviews/${encodeURIComponent(id)}`).then(next => { if (!cancelled) receive(next); })
      .catch(failure => { if (!cancelled) setLocalError(String(failure.message)); })
      .finally(() => { if (!cancelled) { setWaiting(false); setRestoring(false); } });
    return () => { cancelled = true; };
  }, []);

  const submit = async () => {
    setWaiting(true);
    setLocalError(null);
    document.querySelector(".interview-page")?.scrollTo(0, 0);
    try {
      const next = session
        ? await requestSession(`/api/interviews/${session.id}/answers`, { answers: pending.map(question => selected[question.id]) })
        : await requestSession("/api/interviews", { goal, backgroundNotes });
      receive(next);
      document.querySelector(".interview-page")?.scrollTo(0, 0);
    } catch (failure) { setLocalError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setWaiting(false); }
  };

  return <main className="flow-page interview-page">
    <header className="flow-header"><button onClick={onClose} disabled={locked}><Brand /><span>返回项目</span></button><span>01 背景登记 · 02 计划确认 · 03 任务执行</span></header>
    <section className="interview-page-content">
      <p className="section-kicker">{summary ? "确认目标与背景" : session ? `已处理 ${processedCount} 题 · 最多 30 题` : "项目目标登记"}</p>
      <h1>{summary ? "目标与背景确认" : session ? "背景信息补充" : "登记项目目标"}</h1>
      <p>{summary ? "检查并修改摘要。确认后将结合知乎证据生成计划草稿。" : session ? session.goal : "系统根据项目目标与已提交资料生成补充问题，信息完整后进入确认环节。"}</p>
      {!session && <label className="interview-field">项目目标<textarea autoFocus maxLength={2000} value={goal} disabled={locked} onChange={event => setGoal(event.target.value)} placeholder="例如：三个月内完成首款产品的开发与发布" /></label>}
      {!session && <label className="background-import">＋ 导入已有 Markdown / TXT（可选）<input disabled={locked} type="file" accept=".md,.txt,text/plain,text/markdown" onChange={async event => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!/\.(md|txt)$/i.test(file.name)) { setLocalError("只支持 Markdown 或 TXT"); return; }
        const content = await file.text();
        if (content.length > 100000) { setLocalError("文件超过 100,000 字符，请先精简"); return; }
        setBackgroundNotes(content); setFileMessage(`已读取 ${file.name}`); setLocalError(null);
      }} />{fileMessage}</label>}
      {session && <div className="interview-progress-card">
        <div><strong>{summary ? `访谈完成 · 共 ${session.questions.length} 题` : `已处理 ${processedCount} / 最多 30 题`}</strong><span>已跳过 {skippedCount} 题</span></div>
        <progress aria-label="访谈进度" max={summary ? Math.max(1, session.questions.length) : 30} value={summary ? Math.max(1, session.questions.length) : processedCount} />
        {!summary && <small>本轮 {batchCompleted} / {pending.length} 题已回答或跳过 · 信息足够即可提前结束</small>}
      </div>}
      {waiting && <div className="model-running" role="status" aria-live="polite"><span className="model-spinner" aria-hidden="true" /><div>
        <strong>{restoring ? "正在恢复上次访谈…" : session ? "正在结合回答内容分析背景…" : "正在根据目标生成背景问题…"}</strong>
        <small>{restoring ? "正在读取已保存的题目" : "请求已发送，等待模型返回"} · 已等待 {elapsed} 秒</small>
        {elapsed >= 30 && <small>等待时间较长，请稍候；失败或超时会在此提示，不会自动重试。</small>}
      </div></div>}
      {(localError || error) && <ErrorNotice message={(localError || error)!} />}
      {session && !summary && <div className="question-batch">{pending.map((question, index) => <InterviewQuestionCard key={question.id} question={question}
        number={session.answers.length + index + 1} answer={selected[question.id]} disabled={locked}
        onChange={answer => setSelected(current => ({ ...current, [question.id]: answer }))} />)}</div>}
      {summary && <div className="summary-fields">
        <label>目标<textarea disabled={locked} value={summary.goalContract.goal} onChange={event => setSummary({ ...summary, goalContract: { ...summary.goalContract, goal: event.target.value } })} /></label>
        <label>当前背景<textarea disabled={locked} value={summary.userContext.currentSituation} onChange={event => setSummary({ ...summary, userContext: { ...summary.userContext, currentSituation: event.target.value } })} /></label>
        <div className="summary-schedule"><label>每周投入（小时）<input disabled={locked} type="number" min={1} max={80} value={summary.userContext.weeklyHours} onChange={event => setSummary({ ...summary, userContext: { ...summary.userContext, weeklyHours: Number(event.target.value) } })} /></label>
        <label>目标日期<input disabled={locked} type="date" min={new Date().toISOString().slice(0, 10)} value={summary.goalContract.targetDate} onChange={event => setSummary({ ...summary, goalContract: { ...summary.goalContract, targetDate: event.target.value } })} /></label></div>
        <label>成功标准（每行一项）<textarea disabled={locked} value={summary.goalContract.successCriteria.join("\n")} onChange={event => setSummary({ ...summary, goalContract: { ...summary.goalContract, successCriteria: event.target.value.split("\n") } })} /></label>
        <label>必须包含的成果（每行一项）<textarea disabled={locked} value={summary.goalContract.mustHaveOutcomes.join("\n")} onChange={event => setSummary({ ...summary, goalContract: { ...summary.goalContract, mustHaveOutcomes: event.target.value.split("\n") } })} /></label>
        {summary.userContext.backgroundNotes && <details><summary>查看已导入背景材料</summary><p className="imported-background">{summary.userContext.backgroundNotes}</p></details>}
        <label>现实限制与待确认建议（每行一项）<textarea disabled={locked} value={summary.userContext.constraints.join("\n")} onChange={event => setSummary({ ...summary, userContext: { ...summary.userContext, constraints: event.target.value.split("\n") } })} /></label>
        <label>取舍（每行一项）<textarea disabled={locked} value={summary.goalContract.tradeoffs.join("\n")} onChange={event => setSummary({ ...summary, goalContract: { ...summary.goalContract, tradeoffs: event.target.value.split("\n") } })} /></label>
        <label>不包含的范围（每行一项）<textarea disabled={locked} value={summary.goalContract.nonGoals.join("\n")} onChange={event => setSummary({ ...summary, goalContract: { ...summary.goalContract, nonGoals: event.target.value.split("\n") } })} /></label>
        <label>复盘频率<select disabled={locked} value={summary.goalContract.reviewCadence} onChange={event => setSummary({ ...summary, goalContract: { ...summary.goalContract, reviewCadence: event.target.value as "weekly" | "biweekly" | "monthly" } })}><option value="weekly">每周</option><option value="biweekly">每两周</option><option value="monthly">每月</option></select></label>
        <details><summary>查看全部 {session?.answers.length} 道访谈问题</summary>{session?.questions.map(question => <p key={question.id}><strong>{question.question}</strong><br />{formatInterviewAnswer(question, session.answers.find(answer => answer.questionId === question.id))}</p>)}</details>
      </div>}
      <footer className="flow-actions sticky-flow-actions">
        <button disabled={locked} onClick={() => { sessionStorage.removeItem("zhilu-interview"); setSession(null); setSummary(null); setSelected({}); setBackgroundNotes(""); setFileMessage(""); setLocalError(null); }}>重新填写</button>
        {summary ? <button className="research-primary" disabled={locked} onClick={() => onCreate({ ...summary, userContext: { ...summary.userContext, confirmed: true }, goalContract: { ...summary.goalContract, confirmed: true } })}>{busy ? "正在创建" : "确认资料并生成方案"}</button>
          : <button className="research-primary" disabled={locked || (!session ? !goal.trim() : pending.some(question => !answerIsComplete(question, selected[question.id])))} onClick={() => void submit()}>{waiting ? "正在生成" : session ? `提交本轮 ${pending.length} 题` : "开始填写背景资料"}</button>}
      </footer>
    </section>
  </main>;
}
