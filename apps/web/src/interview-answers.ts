import type { InterviewAnswer, InterviewQuestion } from "@zhilu/contracts";

export function optionIds(answer?: InterviewAnswer): string[] {
  return answer?.optionIds ?? (answer?.optionId ? [answer.optionId] : []);
}

export function optionAllowsText(option: InterviewQuestion["options"][number]): boolean {
  return option.allowsText === true || /^(其他|其它|other)(?:$|[\s（(:：])/iu.test(option.label.trim());
}

export function needsOtherText(question: InterviewQuestion, answer?: InterviewAnswer): boolean {
  return !answer?.skipped && question.options.some(option => optionAllowsText(option) && optionIds(answer).includes(option.id));
}

export function answerIsComplete(question: InterviewQuestion, answer?: InterviewAnswer): boolean {
  if (!answer) return false;
  if (answer.skipped) return true;
  if (question.type === "text") return !!answer.text?.trim();
  const ids = optionIds(answer);
  return ids.length > 0 && (question.type === "multiple" || ids.length === 1)
    && (!needsOtherText(question, answer) || !!answer.text?.trim());
}

export function selectInterviewOption(question: InterviewQuestion, previous: InterviewAnswer | undefined, id: string): InterviewAnswer {
  const current = optionIds(previous);
  const selected = question.type === "multiple" ? current.includes(id) ? current.filter(value => value !== id) : [...current, id] : [id];
  const answer: InterviewAnswer = { questionId: question.id, optionIds: selected };
  return needsOtherText(question, answer) && previous?.text ? { ...answer, text: previous.text } : answer;
}

export function formatInterviewAnswer(question: InterviewQuestion, answer?: InterviewAnswer): string {
  if (!answer) return "尚未回答";
  if (answer.skipped) return "已跳过 · 未提供该信息";
  if (question.type === "text") return answer.text ?? "";
  const labels = question.options.filter(option => optionIds(answer).includes(option.id)).map(option => option.label);
  return [...labels, ...(answer.text ? [`补充：${answer.text}`] : [])].join("；");
}
