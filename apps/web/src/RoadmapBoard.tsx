import { Fragment, useEffect, useRef, useState, type PointerEvent } from "react";
import type { PlanNode, PlanState } from "@zhilu/contracts";
import { groupTasksByDate } from "./date-groups";
import { shiftIsoDate } from "./roadmap-date";
import { weeksFromBoardDrag, type DateAnchor } from "./board-drag";
import type { ChangeContext } from "./ChangeComposer";

export function RoadmapBoard({ plan, selectedId, focusId, affectedIds, busy, onSelect, onReschedule, onChange }: {
  plan: PlanState; selectedId: string | null; focusId: string | null; affectedIds: string[]; busy: boolean;
  onSelect: (id: string) => void; onReschedule: (node: PlanNode, weeks: number) => void; onChange: (context: ChangeContext) => void;
}) {
  const groups = groupTasksByDate(plan.nodes);
  const board = useRef<HTMLDivElement>(null), timeline = useRef<HTMLDivElement>(null);
  const pan = useRef<{ pointerId: number; x: number; scroll: number } | null>(null);
  const [drag, setDrag] = useState<{ id: string; pointerId: number; x: number; weeks: number; startDate: string; anchors: DateAnchor[]; pixelsPerWeek: number } | null>(null);
  const [atStart, setAtStart] = useState(true);
  const selectDate = (index: number) => {
    const column = board.current?.querySelector<HTMLElement>(`[data-column-index="${index}"]`);
    if (column && board.current) board.current.scrollTo({ left: column.offsetLeft - parseFloat(getComputedStyle(board.current).paddingLeft), behavior: "instant" });
  };
  const sync = (from: HTMLDivElement, to: HTMLDivElement | null) => {
    if (to && Math.abs(to.scrollLeft - from.scrollLeft) > 1) to.scrollLeft = from.scrollLeft;
    setAtStart(from.scrollLeft < 1);
  };
  useEffect(() => { board.current?.scrollTo(0, 0); timeline.current?.scrollTo(0, 0); setAtStart(true); }, [plan.projectId, plan.research?.selectedRouteId]);
  useEffect(() => {
    const observer = new ResizeObserver(() => { if (board.current) sync(board.current, timeline.current); });
    if (board.current) observer.observe(board.current);
    return () => observer.disconnect();
  }, []);
  const finishDrag = (event: PointerEvent<HTMLButtonElement>, task: PlanNode) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const weeks = weeksFromBoardDrag(event.clientX - drag.x, drag.startDate, drag.anchors, drag.pixelsPerWeek);
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (weeks && !busy) onReschedule(task, weeks);
  };
  const taskCard = (task: PlanNode) => <article key={task.id} className={`board-task status-${task.status} ${focusId === task.id ? "is-focus" : ""} ${selectedId === task.id ? "is-selected" : ""} ${affectedIds.includes(task.id) ? "is-affected" : ""}`}>
    <button className="board-task-open" aria-label={`查看任务：${task.title}`} onClick={() => onSelect(task.id)}><strong>{task.title}</strong><span className="board-task-dates">{task.startDate && <><time dateTime={task.startDate}>{task.startDate.replaceAll("-", ".")}</time><span aria-label="至">—</span></>}{task.endDate ? <time dateTime={task.endDate}>{task.endDate.replaceAll("-", ".")}</time> : "日期待确定"}</span></button>
    <div className="board-task-actions"><button className="task-context-button" disabled={busy} aria-label={`记录任务变更：${task.title}`} title="记录任务变更" onClick={() => onChange({ kind: "task", label: task.title, nodeIds: [task.id] })}><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 4h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M7 8h6m-6 3h4"/></svg></button>
      <button className="task-drag-handle" disabled={busy || !task.startDate || !task.endDate} aria-label={`调整日期：${task.title}`} title="左右拖动按周调整；方向键每次调整一周" onPointerDown={event => {
        if (event.button !== 0) return;
        event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
        const columns = [...(board.current?.querySelectorAll<HTMLElement>("[data-column-index]") ?? [])];
        const anchors = columns.flatMap((column, index) => groups[index]?.date ? [{ date: groups[index]!.date!, x: column.getBoundingClientRect().left }] : []);
        const pixelsPerWeek = columns.length > 1 ? columns[1]!.getBoundingClientRect().left - columns[0]!.getBoundingClientRect().left : 360;
        setDrag({ id: task.id, pointerId: event.pointerId, x: event.clientX, weeks: 0, startDate: task.startDate!, anchors, pixelsPerWeek });
      }} onPointerMove={event => { if (drag?.pointerId === event.pointerId) setDrag({ ...drag, weeks: weeksFromBoardDrag(event.clientX - drag.x, drag.startDate, drag.anchors, drag.pixelsPerWeek) }); }} onPointerUp={event => finishDrag(event, task)} onPointerCancel={() => setDrag(null)} onKeyDown={event => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); onReschedule(task, event.key === "ArrowRight" ? 1 : -1); }
      }}>↔</button></div>
    {drag?.id === task.id && drag.weeks !== 0 && <p className="board-drag-preview" role="status">{shiftIsoDate(drag.startDate, drag.weeks * 7)} · {drag.weeks > 0 ? "顺延" : "提前"} {Math.abs(drag.weeks)} 周，释放后保存</p>}
  </article>;
  return <main className="roadmap-board" aria-label="任务流程图">
    <div className="board-guide"><div><strong>任务流程</strong><span>按开始日期排序</span></div><div><small>日期范围：开始 — 截止</small><button disabled={atStart} onClick={() => board.current?.scrollTo({ left: 0, behavior: "instant" })}>返回起点</button></div></div>
    <div ref={board} className="date-board-scroll" onScroll={event => sync(event.currentTarget, timeline.current)} onPointerDown={event => {
      if (event.button !== 0 || event.pointerType === "touch" || (event.target as Element).closest("button, .date-task-list")) return;
      pan.current = { pointerId: event.pointerId, x: event.clientX, scroll: event.currentTarget.scrollLeft }; event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => { if (pan.current?.pointerId === event.pointerId) event.currentTarget.scrollLeft = pan.current.scroll + pan.current.x - event.clientX; }} onPointerUp={event => { if (pan.current?.pointerId === event.pointerId) { pan.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }} onPointerCancel={() => { pan.current = null; }}>
      {groups.map((group, index) => <Fragment key={group.date ?? group.tasks[0]!.id}>
        <section data-column-index={index} className={`flow-unit ${group.tasks.length > 1 ? "date-column is-multi" : "is-single"}`} aria-label={`${group.date ?? "日期待确定"}，${group.tasks.length} 项任务`}>
          {group.tasks.length > 1 ? <><header className="date-column-head"><h2>{group.date ? <time dateTime={group.date}>{group.date.replaceAll("-", ".")}</time> : "日期待确定"}</h2><span>{group.tasks.length} 项任务</span></header><div className="date-task-list" tabIndex={0} aria-label={`${group.date ?? "日期待确定"}的任务列表`}>{group.tasks.map(taskCard)}</div></> : taskCard(group.tasks[0]!)}
        </section>
        <div className="flow-connector"><span className="connector-start"/><span className="connector-line"/><span className="connector-arrow"/>
          <button disabled={busy} aria-label={`记录阶段变更：${group.date ?? "日期待确定"}至${index + 1 < groups.length ? groups[index + 1]?.date ?? "日期待确定" : "项目目标"}`} title="记录此阶段的变更" onClick={() => onChange({ kind: "segment", label: `${group.date ?? "日期待确定"} — ${index + 1 < groups.length ? groups[index + 1]?.date ?? "日期待确定" : "项目目标"}`, nodeIds: [...group.tasks, ...(groups[index + 1]?.tasks ?? [])].map(task => task.id) })}>+</button>
        </div>
      </Fragment>)}
      <section data-column-index={groups.length} className="board-goal flow-unit"><span className="goal-icon" aria-hidden="true">✓</span><div><h2>项目目标</h2><p>{plan.goal}</p>{!groups.length && <small>暂无任务，请通过“新增任务”添加。</small>}</div></section>
    </div>
    <section className="board-timeline" aria-label="时间轴"><div className="board-timeline-label"><strong>时间轴</strong><small>日期节点等距排列</small></div><div className="date-timeline-scroll" ref={timeline} onScroll={event => sync(event.currentTarget, board.current)}><div className="date-timeline-track">
      {groups.map((group, index) => <button key={group.date ?? group.tasks[0]!.id} className="date-timeline-tick" onClick={() => selectDate(index)}><i aria-hidden="true"/>{group.date ? <time dateTime={group.date}>{group.date.replaceAll("-", ".")}</time> : "日期待确定"}</button>)}<button className="date-timeline-tick" onClick={() => selectDate(groups.length)}><i aria-hidden="true"/>项目目标</button>
    </div></div></section>
  </main>;
}
