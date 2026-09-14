import type { PlanNode } from "@zhilu/contracts";
import { shiftIsoDate } from "./roadmap-date";

export function getWeekFocusTasks(tasks: PlanNode[], todayIso: string, limit = 3): PlanNode[] {
  const weekEnd = shiftIsoDate(todayIso, 6);
  const active = tasks
    .filter((task) => task.type === "task" && task.status !== "done" && task.status !== "archived")
    .sort(compareByStartDate);
  const inCurrentWeek = active.filter(
    (task) => (!task.startDate || task.startDate <= weekEnd) && (!task.endDate || task.endDate >= todayIso),
  );
  const candidates = inCurrentWeek.length > 0
    ? inCurrentWeek
    : active.filter((task) => !task.startDate || task.startDate >= todayIso);
  return candidates.slice(0, limit);
}

export function weekFocusTitle(tasks: PlanNode[], todayIso: string): string {
  const end = shiftIsoDate(todayIso, 6);
  return tasks.length && tasks.every(task => task.startDate && task.startDate > end) ? "后续任务" : "接下来 7 天";
}

function compareByStartDate(left: PlanNode, right: PlanNode): number {
  return (left.startDate ?? "9999-12-31").localeCompare(right.startDate ?? "9999-12-31");
}
