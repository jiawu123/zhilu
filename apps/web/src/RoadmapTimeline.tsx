import type { CSSProperties } from "react";
import type { PlanNode } from "@zhilu/contracts";

export interface TimelineScale { start: number; end: number; left: number; right: number }

/** Display-only date projection. It never assigns or changes a task date. */
export function RoadmapTimeline({ scale, width, panX, dense }: {
  scale: TimelineScale | null; width: number; panX: number; dense: boolean;
}) {
  if (!scale) return <div className="roadmap-timeline timeline-empty" aria-label="时间轴">时间轴<span>待安排</span></div>;
  const { start, end, left, right } = scale;
  const days = Math.max(1, Math.round((end - start) / 86_400_000));
  const maxTicks = Math.max(2, Math.floor((right - left) / 100));
  const desiredStep = Math.max(1, Math.ceil(days / maxTicks));
  const step = desiredStep <= 1 ? 1 : desiredStep <= 7 ? 7 : Math.ceil(desiredStep / 7) * 7;
  const dates = Array.from({ length: Math.floor(days / step) + 1 }, (_, index) => start + index * step * 86_400_000);
  // Avoid two nearly adjacent labels at the end of the range.
  if (dates.at(-1) !== end) {
    if (dates.length > 1 && end - dates.at(-1)! < step * 86_400_000 * .65) dates.pop();
    dates.push(end);
  }
  const xOf = (date: number) => left + (date - start) / Math.max(86_400_000, end - start) * (right - left);
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  return <div className="roadmap-timeline" aria-label="时间轴">
    <div className="timeline-caption"><span>时间轴</span><small>{new Date(start).getUTCFullYear()}{new Date(start).getUTCFullYear() !== new Date(end).getUTCFullYear() ? ` — ${new Date(end).getUTCFullYear()}` : ""}</small></div>
    <div className={`timeline-track ${dense ? "is-dense" : ""}`} style={{ "--pan-x": `${panX}px`, ...(dense ? { width: `${width}px` } : {}) } as CSSProperties}>
      <div className="timeline-rule" style={{ left: `${left / width * 100}%`, width: `${(right - left) / width * 100}%` }} />
      {dates.map(date => <div className="timeline-tick" key={date} style={{ left: `${xOf(date) / width * 100}%` }}>
        <i aria-hidden="true" /><time dateTime={new Date(date).toISOString().slice(0, 10)}>{new Date(date).toISOString().slice(5, 10).replace("-", "/")}</time>
      </div>)}
      {today >= start && today <= end && <div className="timeline-today" style={{ left: `${xOf(today) / width * 100}%` }}><span>今天</span><i /></div>}
    </div>
  </div>;
}

export function TaskDeadline({ task }: { task: Pick<PlanNode, "endDate"> }) {
  return <span className="task-deadline"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="2" /><path d="M5 2v3M11 2v3M3 7h10" /></svg>{task.endDate ? <><span>截止</span><time dateTime={task.endDate}>{task.endDate.replaceAll("-", "/")}</time></> : "待安排"}</span>;
}
