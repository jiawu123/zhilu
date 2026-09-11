export function shiftIsoDate(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function weeksFromDragDistance(distance: number): number {
  if (Math.abs(distance) < 28) return 0;
  const weeks = Math.round(distance / 72) || Math.sign(distance);
  return Math.min(4, Math.max(-4, weeks));
}

export function positionDateInRange(value: string | undefined, start: string, end: string, left: number, right: number): number | null {
  if (!value) return null;
  const valueTime = Date.parse(`${value}T00:00:00Z`);
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  if (![valueTime, startTime, endTime].every(Number.isFinite) || startTime >= endTime) return null;
  const progress = Math.min(1, Math.max(0, (valueTime - startTime) / (endTime - startTime)));
  return left + progress * (right - left);
}
