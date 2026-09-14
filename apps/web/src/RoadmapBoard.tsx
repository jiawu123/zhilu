import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import type { PlanNode, PlanState } from "@zhilu/contracts";
import { groupTasksByDate } from "./date-groups";
import { roadmapEntrance, type RoadmapEntrance } from "./roadmap-entrance";
import { buildCalendarAxis } from "./calendar-axis";
import { animateScrollLeft } from "./animate-scroll";
import { shiftIsoDate } from "./roadmap-date";
import { weeksFromBoardDrag, type DateAnchor } from "./board-drag";
import type { ChangeContext } from "./ChangeComposer";

export function RoadmapBoard({ entryMode = "project", plan, selectedId, focusId, affectedIds, busy, onSelect, onReschedule, onChange }: {
  entryMode?: RoadmapEntrance;
  plan: PlanState; selectedId: string | null; focusId: string | null; affectedIds: string[]; busy: boolean;
  onSelect: (id: string) => void; onReschedule: (node: PlanNode, weeks: number) => void; onChange: (context: ChangeContext) => void;
}) {
  const groups = useMemo(() => groupTasksByDate(plan.nodes), [plan.nodes]);
  const taskOrder = useMemo(() => new Map(groups.flatMap(group => group.tasks).map((task, index) => [task.id, index])), [groups]);
  const entrance = roadmapEntrance(taskOrder.size, entryMode);
  const [growing, setGrowing] = useState(true);
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    setGrowing(!reduced.matches);
    const timer = window.setTimeout(() => setGrowing(false), entrance.duration + 16);
    const stop = () => { if (reduced.matches) setGrowing(false); };
    reduced.addEventListener("change", stop);
    return () => { window.clearTimeout(timer); reduced.removeEventListener("change", stop); };
  }, [plan.projectId, entryMode]);
  const entryStyle = (index: number) => ({ "--entry-delay": `${entrance.delay(index)}ms` } as CSSProperties);
  const dates = useMemo(() => buildCalendarAxis(groups), [groups]);
  const board = useRef<HTMLDivElement>(null), timeline = useRef<HTMLDivElement>(null);
  const dragged = useRef(false);
  const pan = useRef<{ pointerId: number; x: number; scroll: number } | null>(null);
  const [drag, setDrag] = useState<{ id: string; pointerId: number; x: number; weeks: number; startDate: string; anchors: DateAnchor[]; pixelsPerWeek: number } | null>(null);
  const [atStart, setAtStart] = useState(true);
  const [activeDate, setActiveDate] = useState(0);
  const [timelineWidth, setTimelineWidth] = useState(800);
  const labelStride = Math.max(1, Math.ceil(dates.length / Math.max(2, Math.floor((timelineWidth - 64) / 64))));
  const dateLabels = new Set([0, dates.length - 1]);
  if (activeDate >= labelStride && dates.length - 1 - activeDate >= labelStride) dateLabels.add(activeDate);
  for (let index = labelStride; index < dates.length - 1; index += labelStride) {
    if ([...dateLabels].every(label => Math.abs(label - index) >= labelStride)) dateLabels.add(index);
  }
  const dateNavigation = useRef<{ left: number; index: number; running: boolean } | null>(null);
  const scrollAnimation = useRef<(() => void) | null>(null);
  const cancelScroll = () => { scrollAnimation.current?.(); scrollAnimation.current = null; dateNavigation.current = null; };
  useEffect(() => () => cancelScroll(), []);
  const selectDate = (index: number) => {
    cancelScroll();
    setActiveDate(index);
    const column = board.current?.querySelector<HTMLElement>(`[data-column-index="${dates[index]?.groupIndex ?? 0}"]`);
    if (column && board.current) {
      const left = Math.max(0, Math.min(board.current.scrollWidth - board.current.clientWidth, column.offsetLeft - parseFloat(getComputedStyle(board.current).paddingLeft)));
      const viewport = board.current;
      const navigation = { left, index, running: true };
      dateNavigation.current = navigation;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || Math.abs(viewport.scrollLeft - left) < 1) {
        navigation.running = false;
        viewport.scrollLeft = left;
      } else {
        scrollAnimation.current = animateScrollLeft(viewport, left, () => {
          navigation.running = false;
          navigation.left = viewport.scrollLeft;
          scrollAnimation.current = null;
        });
      }
    }
  };
  const sync = (from: HTMLDivElement) => {
    setAtStart(from.scrollLeft < 1);
    if (dateNavigation.current && (dateNavigation.current.running || Math.abs(dateNavigation.current.left - from.scrollLeft) < 1)) {
      setActiveDate(dateNavigation.current.index); return;
    }
    dateNavigation.current = null;
    const columns = board.current?.querySelectorAll<HTMLElement>("[data-column-index]");
    if (columns?.length) {
      const step = columns.length > 1 ? columns[1]!.offsetLeft - columns[0]!.offsetLeft : 1;
      const group = groups[Math.min(Math.max(0, groups.length - 1), Math.max(0, Math.round(from.scrollLeft / step)))];
      setActiveDate(Math.max(0, dates.findIndex(tick => tick.date === group?.date)));
    }
  };
  useEffect(() => { cancelScroll(); setActiveDate(0); board.current?.scrollTo(0, 0); timeline.current?.scrollTo(0, 0); setAtStart(true); }, [plan.projectId, plan.research?.selectedRouteId]);
  useEffect(() => {
    const observer = new ResizeObserver(() => { if (board.current) sync(board.current); if (timeline.current) setTimelineWidth(timeline.current.clientWidth); });
    if (board.current) observer.observe(board.current);
    return () => observer.disconnect();
  }, [groups, dates]);
  const finishDrag = (event: PointerEvent<HTMLButtonElement>, task: PlanNode) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const weeks = weeksFromBoardDrag(event.clientX - drag.x, drag.startDate, drag.anchors, drag.pixelsPerWeek);
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (weeks && !busy) onReschedule(task, weeks);
  };
  const taskCard = (task: PlanNode) => <article key={task.id} style={entryStyle(taskOrder.get(task.id) ?? 0)} className={`board-task status-${task.status} ${focusId === task.id ? "is-focus" : ""} ${selectedId === task.id ? "is-selected" : ""} ${affectedIds.includes(task.id) ? "is-affected" : ""}`}>
    <button className="board-task-open" aria-label={`查看任务：${task.title}`} onClick={() => onSelect(task.id)}><strong>{task.title}</strong><span className="board-task-dates">{task.status === "done" && <span className="task-completed-label"><span aria-hidden="true">✓</span> 已完成</span>}{task.startDate && <><time dateTime={task.startDate}>{task.startDate.replaceAll("-", ".")}</time><span aria-label="至">—</span></>}{task.endDate ? <time dateTime={task.endDate}>{task.endDate.replaceAll("-", ".")}</time> : "日期待确定"}</span></button>
    <div className="board-task-actions"><button className="task-context-button" disabled={busy} aria-label={`记录任务变更：${task.title}`} title="记录任务变更" onClick={() => onChange({ kind: "task", label: task.title, nodeIds: [task.id] })}><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 4h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M7 8h6m-6 3h4"/></svg></button>
      <button className="task-drag-handle" disabled={busy} aria-label={`调整日期：${task.title}`} title="点击编辑日期；左右拖动或使用方向键按周调整" onClick={() => { if (!dragged.current) onSelect(task.id); }} onPointerDown={event => {
        if (event.button !== 0 || !task.startDate || !task.endDate) return;
        dragged.current = false; event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
        const columns = [...(board.current?.querySelectorAll<HTMLElement>("[data-column-index]") ?? [])];
        const anchors = columns.flatMap((column, index) => groups[index]?.date ? [{ date: groups[index]!.date!, x: column.getBoundingClientRect().left }] : []);
        const pixelsPerWeek = columns.length > 1 ? columns[1]!.getBoundingClientRect().left - columns[0]!.getBoundingClientRect().left : 360;
        setDrag({ id: task.id, pointerId: event.pointerId, x: event.clientX, weeks: 0, startDate: task.startDate!, anchors, pixelsPerWeek });
      }} onPointerMove={event => { if (drag?.pointerId === event.pointerId) { if (Math.abs(event.clientX - drag.x) >= 8) dragged.current = true; setDrag({ ...drag, weeks: weeksFromBoardDrag(event.clientX - drag.x, drag.startDate, drag.anchors, drag.pixelsPerWeek) }); } }} onPointerUp={event => finishDrag(event, task)} onPointerCancel={() => setDrag(null)} onKeyDown={event => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); if (task.startDate && task.endDate) onReschedule(task, event.key === "ArrowRight" ? 1 : -1); else onSelect(task.id); }
      }}>↔</button></div>
    {drag?.id === task.id && drag.weeks !== 0 && <p className="board-drag-preview" role="status">{shiftIsoDate(drag.startDate, drag.weeks * 7)} · {drag.weeks > 0 ? "顺延" : "提前"} {Math.abs(drag.weeks)} 周，释放后保存</p>}
  </article>;
  return <main className="roadmap-board" data-growing={growing} data-entry-duration={entrance.duration} style={{ "--card-duration": `${entrance.cardDuration}ms` } as CSSProperties} aria-label="任务流程图">
    <div className="board-guide"><div><strong>任务流程</strong><span>{growing ? "正在展开任务流程" : "按开始日期排序"}</span></div><div><small>日期范围：开始 — 截止</small><button disabled={atStart && activeDate === 0} onClick={() => selectDate(0)}>返回起点</button></div></div>
    <div ref={board} className="date-board-scroll" onWheel={cancelScroll} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) cancelScroll(); }} onScroll={event => sync(event.currentTarget)} onPointerDown={event => {
      cancelScroll();
      if (event.button !== 0 || event.pointerType === "touch" || (event.target as Element).closest("button, .date-task-list")) return;
      pan.current = { pointerId: event.pointerId, x: event.clientX, scroll: event.currentTarget.scrollLeft }; event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => { if (pan.current?.pointerId === event.pointerId) event.currentTarget.scrollLeft = pan.current.scroll + pan.current.x - event.clientX; }} onPointerUp={event => { if (pan.current?.pointerId === event.pointerId) { pan.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }} onPointerCancel={() => { pan.current = null; }}>
      {groups.map((group, index) => <Fragment key={group.date ?? group.tasks[0]!.id}>
        <section data-column-index={index} className={`flow-unit ${group.tasks.length > 1 ? "date-column is-multi" : "is-single"}`} aria-label={`${group.date ?? "日期待确定"}，${group.tasks.length} 项任务`}>
          {group.tasks.length > 1 ? <><header className="date-column-head" style={entryStyle(taskOrder.get(group.tasks[0]!.id) ?? 0)}><h2>{group.date ? <time dateTime={group.date}>{group.date.replaceAll("-", ".")}</time> : "日期待确定"}</h2><span>{group.tasks.length} 项任务</span></header><div className="date-task-list" tabIndex={0} aria-label={`${group.date ?? "日期待确定"}的任务列表`}>{group.tasks.map(taskCard)}</div></> : taskCard(group.tasks[0]!)}
        </section>
        <div className="flow-connector" style={entryStyle((taskOrder.get(group.tasks.at(-1)!.id) ?? 0) + .5)}><span className="connector-start"/><span className="connector-line"/><span className="connector-arrow"/>
          <button disabled={busy} aria-label={`记录阶段变更：${group.date ?? "日期待确定"}至${index + 1 < groups.length ? groups[index + 1]?.date ?? "日期待确定" : "项目目标"}`} title="记录此阶段的变更" onClick={() => onChange({ kind: "segment", label: `${group.date ?? "日期待确定"} — ${index + 1 < groups.length ? groups[index + 1]?.date ?? "日期待确定" : "项目目标"}`, nodeIds: [...group.tasks, ...(groups[index + 1]?.tasks ?? [])].map(task => task.id) })}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg></button>
        </div>
      </Fragment>)}
      <section data-column-index={groups.length} className="board-goal flow-unit" style={entryStyle(taskOrder.size)}><span className="goal-icon" aria-hidden="true">✓</span><div><h2>项目目标</h2><p>{plan.goal}</p>{!groups.length && <small>暂无任务，请通过“新增任务”添加。</small>}</div></section>
    </div>
    <section className="board-timeline" aria-label="时间轴"><div className="board-timeline-label"><strong>时间轴</strong><small>完整日期范围</small><span className="timeline-position-label">当前位置 · {dates[Math.min(activeDate, dates.length - 1)]?.date ?? "日期待确定"}</span></div><div className="date-timeline-scroll" ref={timeline}><div className="date-timeline-track" style={{ "--active-date": Math.min(activeDate, Math.max(0, dates.length - 1)), "--date-count": Math.max(1, dates.length), "--date-intervals": Math.max(1, dates.length - 1) } as CSSProperties}>
      {dates.length > 0 && <span className="timeline-cursor" aria-hidden="true"><i /></span>}
      {dates.map((tick, index) => <button key={tick.date} className="date-timeline-tick" style={{ "--tick-index": index } as CSSProperties} aria-label={`定位日期：${tick.date}`} title={tick.date} data-label-visible={dateLabels.has(index)} aria-current={index === activeDate ? "step" : undefined} onClick={() => selectDate(index)}><i aria-hidden="true"/><time dateTime={tick.date}>{tick.date.slice(5).replace("-", ".")}</time></button>)}
      {!dates.length && <span className="timeline-no-dates">暂无任务日期</span>}
    </div></div></section>
  </main>;
}
