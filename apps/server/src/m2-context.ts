import type { PlanState } from "@zhilu/contracts";

export class M2ContextError extends Error {
  constructor() { super("请先确认目标和背景；背景过长时请缩短后再研究，约束与成功标准不能省略。"); }
}

export function buildM2Context(plan: PlanState): {goal: string; user_context: Record<string, unknown>} {
  const goal = plan.goalContract;
  const context = plan.userContext;
  if (!goal || !context || goal.confirmed !== true || context.confirmed !== true) throw new M2ContextError();
  if (typeof goal.goal !== "string" || !goal.goal.trim() || [...goal.goal].length > 2000
      || typeof context.currentSituation !== "string" || !context.currentSituation.trim()
      || typeof plan.weeklyHours !== "number" || !Number.isFinite(plan.weeklyHours) || plan.weeklyHours <= 0)
    throw new M2ContextError();
  for (const list of [context.constraints, goal.successCriteria, goal.nonGoals, goal.mustHaveOutcomes, goal.tradeoffs]) {
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) throw new M2ContextError();
  }
  if (context.backgroundNotes !== undefined && typeof context.backgroundNotes !== "string") throw new M2ContextError();
  const user_context: Record<string, unknown> = {
    current_situation: context.currentSituation, weekly_hours: plan.weeklyHours,
    constraints: [...context.constraints], success_criteria: [...goal.successCriteria],
    target_date: goal.targetDate, non_goals: [...goal.nonGoals],
    must_have_outcomes: [...goal.mustHaveOutcomes], tradeoffs: [...goal.tradeoffs], review_cadence: goal.reviewCadence,
    ...(context.backgroundNotes === undefined ? {} : {background_notes: context.backgroundNotes}),
  };
  // Conservative bound includes Python json.dumps separator whitespace; no facts are truncated.
  const serialized = JSON.stringify(user_context, null, 1);
  if ([...serialized].length > 8000) throw new M2ContextError();
  return {goal: goal.goal, user_context};
}
