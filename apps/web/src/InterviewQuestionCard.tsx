import type { InterviewAnswer, InterviewQuestion } from "@zhilu/contracts";
import { needsOtherText, optionIds, selectInterviewOption } from "./interview-answers";

const labels = { single: "单选", multiple: "可多选", text: "填写回答", toggle: "程度选择" };

export function InterviewQuestionCard({ question, number, answer, disabled, onChange }: {
  question: InterviewQuestion; number: number; answer?: InterviewAnswer | undefined; disabled: boolean; onChange: (answer: InterviewAnswer) => void;
}) {
  const type = question.type ?? "single";
  const skipped = answer?.skipped === true;
  const selected = optionIds(answer);
  return <fieldset className={skipped ? "question-is-skipped" : ""} disabled={disabled}>
    <legend>{number}. {question.question}</legend>
    <p className="question-kind">{labels[type]}{skipped ? " · 已跳过" : ""}</p>
    {type === "text" ? <label className="text-answer">回答内容
      <textarea maxLength={1000} disabled={skipped} value={answer?.text ?? ""} onChange={event => onChange({ questionId: question.id, text: event.target.value })} placeholder="请填写相关情况；如无补充信息，可跳过本题。" />
      <small>{answer?.text?.length ?? 0} / 1000</small>
    </label> : type === "toggle" ? <div className="degree-options" role="group" aria-label={question.question}>
      {question.options.map(option => <button key={option.id} type="button" disabled={skipped} aria-pressed={selected.includes(option.id)} onClick={() => onChange(selectInterviewOption(question, answer, option.id))}>{option.label}</button>)}
    </div> : <div className="choice-options">{question.options.map(option => <label key={option.id} className={selected.includes(option.id) ? "is-selected" : ""}>
      <input type={type === "multiple" ? "checkbox" : "radio"} name={question.id} value={option.id} disabled={skipped} checked={selected.includes(option.id)} onChange={() => onChange(selectInterviewOption(question, answer, option.id))} />{option.label}
    </label>)}</div>}
    {needsOtherText(question, answer) && <label className="other-answer">补充“其他”的具体情况
      <textarea maxLength={1000} value={answer?.text ?? ""} onChange={event => onChange({ ...answer!, text: event.target.value })} placeholder="请填写实际情况" />
    </label>}
    <button className="skip-question" type="button" aria-pressed={skipped} onClick={() => onChange(skipped ? { questionId: question.id } : { questionId: question.id, skipped: true })}>{skipped ? "重新作答" : "跳过问题"}</button>
  </fieldset>;
}
