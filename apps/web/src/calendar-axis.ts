import type { DateTaskGroup } from "./date-groups";

const day = 86_400_000;
const timestamp = (value: string | null | undefined): number => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const result = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(result) && new Date(result).toISOString().slice(0, 10) === value ? result : NaN;
};

/** Every calendar day remains visible, including gaps and the final task deadline. */
export function buildCalendarAxis(groups: DateTaskGroup[]): { date: string; groupIndex: number }[] {
  const anchors = groups.flatMap((group, groupIndex) => {
    const time = timestamp(group.date);
    return Number.isFinite(time) ? [{ time, groupIndex }] : [];
  });
  const bounds = groups.flatMap(group => group.tasks.flatMap(task =>
    [timestamp(task.startDate), timestamp(task.endDate)].filter(Number.isFinite)));
  if (!bounds.length) return [];
  const first = Math.min(...bounds), last = Math.max(...bounds);
  let anchorIndex = 0;
  return Array.from({ length: Math.round((last - first) / day) + 1 }, (_, index) => {
    const time = first + index * day;
    while (anchorIndex + 1 < anchors.length &&
      Math.abs(anchors[anchorIndex + 1]!.time - time) <= Math.abs(anchors[anchorIndex]!.time - time)) anchorIndex++;
    return { date: new Date(time).toISOString().slice(0, 10), groupIndex: anchors[anchorIndex]?.groupIndex ?? 0 };
  });
}
