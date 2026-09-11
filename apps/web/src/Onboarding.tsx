import { useMemo, useState, type ChangeEvent } from "react";
import type { CreateProjectInput } from "@zhilu/contracts";
import { shiftIsoDate } from "./roadmap-date";
import { adaptiveQuestionFor, createProjectInput, type InterviewAnswers } from "./onboarding-model";

interface OnboardingProps {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (input: CreateProjectInput) => void;
}

const totalSteps = 6;

export function Onboarding({ busy, error, onClose, onCreate }: OnboardingProps) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const [step, setStep] = useState(0);
  const [fileMessage, setFileMessage] = useState("");
  const [answers, setAnswers] = useState<InterviewAnswers>({
    goal: "",
    successCriterion: "",
    targetDate: shiftIsoDate(todayIso, 84),
    currentSituation: "",
    weeklyHours: 8,
    constraints: "",
    adaptiveAnswer: "",
    backgroundNotes: "",
  });
  const adaptiveQuestion = useMemo(
    () => adaptiveQuestionFor(answers, todayIso),
    [answers.targetDate, answers.weeklyHours, todayIso],
  );
  const setField = <K extends keyof InterviewAnswers,>(key: K, value: InterviewAnswers[K]) => {
    setAnswers((current) => ({ ...current, [key]: value }));
  };
  const canContinue = [
    answers.goal.trim().length > 0,
    answers.successCriterion.trim().length > 0 && answers.targetDate >= todayIso,
    answers.currentSituation.trim().length > 0 && answers.weeklyHours >= 1 && answers.weeklyHours <= 80,
    answers.constraints.trim().length > 0,
    answers.adaptiveAnswer.trim().length > 0,
    true,
  ][step] ?? false;

  const useDemo = () => {
    setAnswers({
      goal: "12 周后完成一个可展示的 Agent 工程项目",
      successCriterion: "公开一个包含 RAG、工具调用、评测与失败恢复的 Demo",
      targetDate: shiftIsoDate(todayIso, 84),
      currentSituation: "有 TypeScript 和后端基础，但还没有完整的 Agent 项目",
      weeklyHours: 12,
      constraints: "预算 500 元；工作日晚间投入；中文资料优先",
      adaptiveAnswer: "优先保留评测、失败恢复和可公开演示的成果",
      backgroundNotes: "",
    });
    setStep(1);
  };

  const importBackground = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!/\.(md|txt)$/i.test(file.name)) {
      setFileMessage("只支持 Markdown 或 TXT");
      return;
    }
    const content = await file.text();
    if (content.length > 100_000) {
      setFileMessage("文件超过 100,000 个字符，请先精简");
      return;
    }
    setField("backgroundNotes", content);
    setFileMessage(`已读取 ${file.name} · ${content.length.toLocaleString()} 字符`);
  };

  return (
    <div className="onboarding-backdrop">
      <section className="onboarding-shell" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <button className="onboarding-close" onClick={onClose} aria-label="关闭新路线">×</button>
        <div className="interview-orbit" aria-hidden="true"><span>路</span><i /><i /><i /></div>
        <div className="interview-progress" aria-label={`第 ${step + 1} 步，共 ${totalSteps} 步`}>
          {Array.from({ length: totalSteps }, (_, index) => <span key={index} className={index <= step ? "is-active" : ""} />)}
        </div>

        <div className="interview-copy">
          <p className="section-kicker">{step === totalSteps - 1 ? "最终确认" : `目标访谈 · 0${step + 1}`}</p>
          {step === 0 && <><h1 id="onboarding-title">你想前往哪里？</h1><p>先说目标，不急着看一张“万能路线图”。</p><textarea autoFocus value={answers.goal} onChange={(event) => setField("goal", event.target.value)} placeholder="例如：我想在三个月内完成一个能用于求职的 Agent 项目" /><button className="demo-seed" onClick={useDemo}>✦ 使用“Agent 工程项目”演示目标</button></>}
          {step === 1 && <><h1 id="onboarding-title">怎样才算真的抵达？</h1><p>写下别人也能观察和检查的结果。</p><textarea autoFocus value={answers.successCriterion} onChange={(event) => setField("successCriterion", event.target.value)} placeholder="可以写多条，用分号分隔。例如：公开 Demo；有评测结果；完成一次真实演示" /><label className="interview-field">希望何时完成<input type="date" min={todayIso} value={answers.targetDate} onChange={(event) => setField("targetDate", event.target.value)} /></label></>}
          {step === 2 && <><h1 id="onboarding-title">你现在站在哪里？</h1><p>只写与这个目标有关的基础，不需要上传完整人生。</p><textarea autoFocus value={answers.currentSituation} onChange={(event) => setField("currentSituation", event.target.value)} placeholder="现有经验、已经做过的项目、掌握的能力……" /><label className="interview-field hours-field">每周可投入<input type="number" min="1" max="80" value={answers.weeklyHours} onChange={(event) => setField("weeklyHours", Number(event.target.value))} /><span>小时</span></label><label className="background-import" htmlFor="background-file">＋ 导入已有 Markdown / TXT<input id="background-file" type="file" accept=".md,.txt,text/plain,text/markdown" onChange={(event) => void importBackground(event)} /></label>{fileMessage && <small className="file-message">{fileMessage}</small>}</>}
          {step === 3 && <><h1 id="onboarding-title">现实里有哪些边界？</h1><p>时间、预算、设备、健康或不能妥协的条件都可以写。</p><textarea autoFocus value={answers.constraints} onChange={(event) => setField("constraints", event.target.value)} placeholder="例如：预算 500 元；只能在工作日晚间进行；中文资料优先。没有可填写“暂无”" /></>}
          {step === 4 && <><h1 id="onboarding-title">{adaptiveQuestion}</h1><p>这是根据你的期限和每周投入生成的追问。</p><textarea autoFocus value={answers.adaptiveAnswer} onChange={(event) => setField("adaptiveAnswer", event.target.value)} placeholder="说清楚发生取舍时，你希望系统保住什么" /></>}
          {step === 5 && <ReviewCards answers={answers} adaptiveQuestion={adaptiveQuestion} />}
        </div>

        {error && <div className="interview-error">{error}</div>}
        <footer className="interview-actions">
          <button className="interview-back" disabled={busy || step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))}>← 上一步</button>
          {step < totalSteps - 1 ? <button className="interview-next" disabled={busy || !canContinue} onClick={() => setStep((current) => Math.min(totalSteps - 1, current + 1))}>继续展开路线 →</button> : <button className="interview-next" disabled={busy} onClick={() => onCreate(createProjectInput(answers, adaptiveQuestion))}>{busy ? "正在建立…" : "确认并建立研究准备版 →"}</button>}
        </footer>
      </section>
    </div>
  );
}

function ReviewCards({ answers, adaptiveQuestion }: { answers: InterviewAnswers; adaptiveQuestion: string }) {
  return <><h1 id="onboarding-title">这就是我理解的你</h1><p>确认后才会写入项目；仍可返回修改。</p><div className="review-grid"><article><span>User Context Card</span><h2>当前起点</h2><p>{answers.currentSituation}</p><dl><div><dt>每周投入</dt><dd>{answers.weeklyHours} 小时</dd></div><div><dt>主要限制</dt><dd>{answers.constraints}</dd></div><div><dt>背景材料</dt><dd>{answers.backgroundNotes ? "已导入本地材料" : "未导入"}</dd></div></dl></article><article><span>Goal Contract</span><h2>{answers.goal}</h2><p>{answers.successCriterion}</p><dl><div><dt>目标日期</dt><dd>{answers.targetDate}</dd></div><div><dt>取舍原则</dt><dd>{answers.adaptiveAnswer}</dd></div><div><dt>追问依据</dt><dd>{adaptiveQuestion}</dd></div></dl></article></div><div className="research-boundary"><strong>下一步：知乎研究</strong><span>现在只保存你确认的事实。真实 EvidencePack 返回前，不会伪造知乎来源或领域建议。</span></div></>;
}
