export interface DateAnchor { date: string; x: number }
const day = (value: string) => Date.parse(value) / 86_400_000;

/** Interpolate the displayed date columns; their equal spacing is not a fixed week. */
export function weeksFromBoardDrag(distance: number, startDate: string, anchors: DateAnchor[], fallbackPixelsPerWeek: number): number {
  if (!Number.isFinite(distance) || Math.abs(distance) < 8 || fallbackPixelsPerWeek <= 0) return 0;
  const valid = anchors.map(anchor => ({ x: anchor.x, day: day(anchor.date) }))
    .filter(anchor => Number.isFinite(anchor.x) && Number.isFinite(anchor.day)).sort((a, b) => a.x - b.x);
  const origin = valid.find(anchor => anchor.day === day(startDate));
  if (!origin) return 0;
  if (valid.length < 2) return Math.round(distance / fallbackPixelsPerWeek);
  const target = origin.x + distance;
  const rightIndex = Math.max(1, valid.findIndex(anchor => anchor.x >= target));
  const upper = target > valid[valid.length - 1]!.x ? valid.length - 1 : rightIndex;
  const left = valid[upper - 1]!, right = valid[upper]!;
  if (right.x <= left.x) return 0;
  const targetDay = left.day + (target - left.x) / (right.x - left.x) * (right.day - left.day);
  return Math.round((targetDay - origin.day) / 7);
}
