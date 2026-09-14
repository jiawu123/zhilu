import type { RoadmapperRun } from "@zhilu/contracts";

const hours = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, useGrouping: false });

export function WeeklyOverrunNotice({ overruns, routeId }: {
  overruns: RoadmapperRun["weeklyOverruns"];
  routeId: string | undefined;
}) {
  const weeks = (overruns ?? []).filter(item => item.routeId === routeId && item.plannedHours > item.capacityHours)
    .sort((left, right) => left.week - right.week);
  if (weeks.length === 0) return null;
  return <section className="weekly-overrun-notice" role="status">
    <strong>部分周需要额外投入</strong>
    {weeks.map(item => <p key={item.week}>
      {`第${item.week}周计划${hours.format(item.plannedHours)}小时（含复盘），原预算${hours.format(item.capacityHours)}小时，使用${hours.format(item.plannedHours - item.capacityHours)}小时弹性；请确认可投入这部分额外时间。`}
      <small>{`本周上限${hours.format(item.capacityHours + item.toleranceHours)}小时。`}</small>
    </p>)}
  </section>;
}
