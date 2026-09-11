import type { CreateProjectInput } from "@zhilu/contracts";

export interface InterviewAnswers {
  goal: string;
  successCriterion: string;
  targetDate: string;
  currentSituation: string;
  weeklyHours: number;
  constraints: string;
  adaptiveAnswer: string;
  backgroundNotes: string;
}

export function adaptiveQuestionFor(answers: Pick<InterviewAnswers, "weeklyHours" | "targetDate">, todayIso: string): string {
  const days = Math.round((Date.parse(`${answers.targetDate}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000);
  if (answers.weeklyHours <= 5) return "每周时间很有限，这个目标里最不能放弃的成果是什么？";
  if (Number.isFinite(days) && days <= 56) return "期限比较紧：如果时间不够，你更愿意缩小范围，还是增加投入？";
  return "遇到路线冲突时，你最优先保证的是速度、质量，还是最终成果？为什么？";
}

export function createProjectInput(answers: InterviewAnswers, adaptiveQuestion: string): CreateProjectInput {
  const constraints = splitItems(answers.constraints);
  const successCriteria = splitItems(answers.successCriterion);
  return {
    userContext: {
      currentSituation: answers.currentSituation.trim(),
      weeklyHours: answers.weeklyHours,
      constraints: constraints.length > 0 ? constraints : ["暂无"],
      ...(answers.backgroundNotes.trim() ? { backgroundNotes: answers.backgroundNotes.trim() } : {}),
      confirmed: true,
    },
    goalContract: {
      goal: answers.goal.trim(),
      targetDate: answers.targetDate,
      successCriteria,
      nonGoals: [],
      mustHaveOutcomes: successCriteria,
      tradeoffs: [answers.adaptiveAnswer.trim()],
      reviewCadence: "weekly",
      confirmed: true,
    },
    adaptiveQuestion,
    adaptiveAnswer: answers.adaptiveAnswer.trim(),
  };
}

function splitItems(value: string): string[] {
  return value.split(/[\n；;]/).map((item) => item.trim()).filter(Boolean);
}
