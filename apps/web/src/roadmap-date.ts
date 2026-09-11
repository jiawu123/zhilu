export function shiftIsoDate(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function weeksFromDragDistance(distance: number): number {
  if (Math.abs(distance) < 36) return 0;
  const weeks = Math.round(distance / 120) || Math.sign(distance);
  return Math.min(4, Math.max(-4, weeks));
}
