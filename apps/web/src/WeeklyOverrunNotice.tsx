import type { RoadmapperRun } from "@zhilu/contracts";

function duration(hours: number): string {
  const minutes = Math.round(hours * 60);
  if (minutes < 1) return "不到1分钟";
  const wholeHours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `约${wholeHours ? `${wholeHours}小时` : ""}${remainder ? `${remainder}分钟` : ""}`;
}

export function WeeklyOverrunNotice({ overruns, routeId }: {
  overruns: RoadmapperRun["weeklyOverruns"];
  routeId: string | undefined;
}) {
  const weeks = (overruns ?? []).filter(item => item.routeId === routeId && item.plannedHours > item.capacityHours)
    .sort((left, right) => left.week - right.week);
  if (weeks.length === 0) return null;
  return <section className="weekly-overrun-notice" role="status">
    <strong>时间安排提醒</strong>
    {weeks.map(item => <p key={item.week}>
      {`第${item.week}周：预计需要${duration(item.plannedHours)}，比你原定的时间多${duration(item.plannedHours - item.capacityHours)}。`}
    </p>)}
    <p>如果抽不出这些时间，可以在「一起调整计划」里要求减少任务。</p>
  </section>;
}
