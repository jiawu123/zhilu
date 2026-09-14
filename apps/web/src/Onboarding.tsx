import { useEffect, useRef, useState } from "react";
import type { CreateProjectInput, InterviewAnswer, InterviewSession } from "@zhilu/contracts";
import { INTERVIEW_MAX_QUESTIONS } from "@zhilu/contracts";
import { requestSession, InterviewRequestError } from "./interview-api";
import { InterviewQuestionCard } from "./InterviewQuestionCard";
import { answerIsComplete, formatInterviewAnswer } from "./interview-answers";
import { useRequestProgress } from "./request-progress";
import { WaitStatus } from "./WaitStatus";

interface OnboardingProps {
  storageKey: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (input: CreateProjectInput) => void;
}

export function Onboarding({ storageKey, busy, error, onClose, onCreate }: OnboardingProps) {
  const [goal, setGoal] = useState("");
  const [backgroundNotes, setBackgroundNotes] = useState("");
  const [fileMessage, setFileMessage] = useState("");
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [selected, setSelected] = useState<Record<string, InterviewAnswer>>({});
  const [summary, setSummary] = useState<CreateProjectInput | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const requests = useRequestProgress();
  const progress = requests.filter(item => item.path.includes("/interviews") && !item.path.endsWith("/draft")).at(-1);
  const [localError, setLocalError] = useState<string | null>(null);
  const locked = busy || waiting;
  const pending = session?.questions.slice(session.answers.length) ?? [];
  const batchCompleted = pending.filter(question => answerIsComplete(question, selected[question.id])).length;
  const processedCount = (session?.answers.length ?? 0) + batchCompleted;
  const skippedCount = (session?.answers.filter(answer => answer.skipped).length ?? 0) + pending.filter(question => selected[question.id]?.skipped).length;
  const answeredCount = processedCount - skippedCount;
  const understandingPercent = Math.min(summary ? 100 : 99, Math.round(answeredCount / Math.max(1,
    summary && !session?.finishRequested ? session!.questions.length : INTERVIEW_MAX_QUESTIONS) * 100));

  const receive = (next: InterviewSession) => {
    setSaveState("");
    setSession(next);
    setSummary(next.summary ?? null);
    setGoal(next.goal);
    setBackgroundNotes(next.backgroundNotes ?? "");
    setSelected(Object.fromEntries((next.draftAnswers ?? []).map(answer => [answer.questionId, answer])));
    setLocalError(next.generationError ?? null);
    sessionStorage.setItem(storageKey, next.id);
  };
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("interview") ?? sessionStorage.getItem(storageKey) ?? (storageKey.endsWith(":local") ? sessionStorage.getItem("zhilu-interview") : null);
    if (!id) return;
    let cancelled = false;
    setWaiting(true);
    setRestoring(true);
    void requestSession(`/api/interviews/${encodeURIComponent(id)}`).then(next => { if (!cancelled) receive(next); })
      .catch(failure => { if (!cancelled) setLocalError(String(failure.message)); })
      .finally(() => { if (!cancelled) { setWaiting(false); setRestoring(false); } });
    return () => { cancelled = true; };
  }, []);

  const draftQueue = useRef<Promise<void>>(Promise.resolve());
  const [saveState, setSaveState] = useState("");
  useEffect(() => {
    if (!session || summary || waiting || pending.length === 0 || Object.keys(selected).length === 0) return;
    setSaveState("正在保存回答…");
    let active = true;
    const id = session.id;
    const timer = setTimeout(() => {
      draftQueue.current = draftQueue.current.then(async () => {
        try {
          await requestSession(`/api/interviews/${id}/draft`, { answers: Object.values(selected) });
          if (active) setSaveState("回答已保存到服务器");
        } catch { if (active) setSaveState("回答保存失败，请提交本轮重试；离开前请确认已保存。"); }
      });
    }, 500);
    return () => { active = false; clearTimeout(timer); };
  }, [selected, session?.id, waiting, summary]);
  useEffect(() => {
    if (!saveState || saveState === "回答已保存到服务器") return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState]);

  const submit = async (finish = false) => {
    if (finish && !window.confirm("确定跳过全部剩余问题吗？\n\n已完成的回答会保留。由于缺少背景信息，你的 roadmapper 生成的计划可能不够贴合你的目标，结果可能不如预期。\n\n确认后将直接整理背景摘要，你仍可检查和补充。")) return;
    setWaiting(true);
    setLocalError(null);
    document.querySelector(".interview-page")?.scrollTo(0, 0);
    try {
      await draftQueue.current;
      const next = session
        ? await requestSession(`/api/interviews/${session.id}/${finish ? "finish" : pending.length ? "answers" : "next"}`, { answers: pending.map(question => finish && !answerIsComplete(question, selected[question.id]) ? { questionId: question.id, skipped: true } : selected[question.id]) })
        : await requestSession("/api/interviews", { goal, backgroundNotes });
      receive(next);
      document.querySelector(".interview-page")?.scrollTo(0, 0);
    } catch (failure) { if (failure instanceof InterviewRequestError && failure.session) receive(failure.session); setLocalError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setWaiting(false); }
  };

  return <main className="flow-page interview-page">
    <header className="flow-header"><button onClick={onClose} disabled={locked || saveState === "正在保存回答…"}>知路 · 返回已有计划</button><span>01 了解背景 → 02 确认计划 → 03 路线图</span></header>
    <section className="interview-page-content">
      <p className="section-kicker">{summary ? "确认目标与背景" : session ? `已处理 ${processedCount} 题 · 信息足够即结束` : "从你的目标出发"}</p>
      <h1>{summary ? "这是我理解的你" : session ? "再了解你一点" : "你想完成什么？"}</h1>
      <p>{summary ? "检查并修改摘要。确认后将结合知乎证据生成计划草稿。" : session ? session.goal : "后续问题根据你的目标和每轮回答生成，信息足够就停止。"}</p>
      {!session && <label className="interview-field">你的目标<textarea autoFocus maxLength={2000} value={goal} disabled={locked} onChange={event => setGoal(event.target.value)} placeholder="例如：我想在三个月内发布自己的第一款产品" /></label>}
      {!session && <label className="background-import">＋ 导入已有 Markdown / TXT（可选）<input disabled={locked} type="file" accept=".md,.txt,text/plain,text/markdown" onChange={async event => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!/\.(md|txt)$/i.test(file.name)) { setLocalError("只支持 Markdown 或 TXT"); return; }
        const content = await file.text();
        if (content.length > 100000) { setLocalError("文件超过 100,000 字符，请先精简"); return; }
        setBackgroundNotes(content); setFileMessage(`已读取 ${file.name}`); setLocalError(null);
      }} />{fileMessage}</label>}
      {session?.projectId && <p>已关联计划：<a href={`?project=${session.projectId}&page=roadmap`}>打开计划</a></p>}
      {session && <div className="interview-progress-card">
        <div><strong>你的 roadmapper 已了解了你的目标 {understandingPercent}%</strong></div>
        <progress aria-label="目标了解进度" max={100} value={understandingPercent} />
        <div><span>最多 {INTERVIEW_MAX_QUESTIONS} 个问题 · 信息足够即可提前结束</span><span>已回答 {answeredCount} 题 · 已跳过 {skippedCount} 题</span></div>
        <small>百分比按回答进度估算，跳过不计入已了解。{summary && (session.finishRequested ? "已提前结束访谈，可在下方补充背景。" : "访谈已完成，请检查下方摘要。")}</small>
        {!summary && <small>{pending.length ? `本轮 ${batchCompleted} / ${pending.length} 题已回答或跳过 · ${session.questions.length >= INTERVIEW_MAX_QUESTIONS ? "提交后整理背景摘要" : "提交后由 AI 判断是否需要继续补充背景"}` : "本轮已提交，可继续判断是否需要补问或生成摘要。"}</small>}
        {!summary && <button className="interview-skip-all" disabled={locked} onClick={() => void submit(true)}>跳过全部剩余问题</button>}
      </div>}
      {waiting && <div className="inline-operation-status"><WaitStatus label={restoring ? "正在恢复上次访谈…" : "正在发送背景信息…"} progress={progress} /></div>}
      {session && !summary && <p className="answer-save-status" role="status">{pending.length ? saveState : "本轮回答已保存，可继续生成。"}</p>}
      {(localError || error) && <p className="research-error" role="alert">{localError || error}</p>}
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
      <footer className="flow-actions">
        <button disabled={locked || saveState === "正在保存回答…"} onClick={() => { sessionStorage.removeItem(storageKey); sessionStorage.removeItem("zhilu-interview"); window.history.replaceState(null, "", "?page=interview"); setSession(null); setSummary(null); setSelected({}); setBackgroundNotes(""); setFileMessage(""); setLocalError(null); }}>重新开始</button>
        {summary ? <button className="research-primary" disabled={locked || Boolean(session?.projectId)} onClick={() => onCreate({ ...summary, ...(session ? { interviewId: session.id } : {}), userContext: { ...summary.userContext, confirmed: true }, goalContract: { ...summary.goalContract, confirmed: true } })}>{busy ? "正在创建…" : "确认背景，生成知乎计划 →"}</button>
          : <button className="research-primary" disabled={locked || (!session ? !goal.trim() : pending.some(question => !answerIsComplete(question, selected[question.id])))} onClick={() => void submit()}>{waiting ? "正在生成…" : session ? pending.length ? `提交本轮 ${pending.length} 题 →` : "继续生成 →" : "开始了解背景 →"}</button>}
      </footer>
    </section>
  </main>;
}
