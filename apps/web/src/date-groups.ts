import type { PlanNode } from "@zhilu/contracts";

export interface DateTaskGroup { date: string | null; tasks: PlanNode[] }
/** Dates are a grouping key, not a new schedule. Missing dates stay visibly unscheduled. */
export function groupTasksByDate(tasks: PlanNode[]): DateTaskGroup[] {
  const groups = new Map<string, PlanNode[]>();
  const unscheduled: DateTaskGroup[] = [];
  for (const task of tasks) {
    if (task.type !== "task" || task.status === "archived") continue;
    if (!task.startDate) {
      unscheduled.push({ date: null, tasks: [task] });
      continue;
    }
    const date = task.startDate;
    groups.set(date, [...(groups.get(date) ?? []), task]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({ date, tasks: items } as DateTaskGroup)).concat(unscheduled);
}
