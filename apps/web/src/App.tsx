import { useEffect, useMemo, useState, type CSSProperties, type DragEvent } from "react";
import type {
  EvidenceCard,
  ImpactDiff,
  PatchProposal,
  PlanCommit,
  PlanEvent,
  PlanNode,
  PlanNodeUpdate,
  PlanState,
  RoadmapView,
} from "@zhilu/contracts";
import { shiftIsoDate, weeksFromDragDistance } from "./roadmap-date";
import { getWeekFocusTasks } from "./roadmap-focus";

const projectId = "agent-engineer-demo";
const canvasWidth = 1200;
const canvasHeight = 650;

interface PendingChange {
  event: PlanEvent;
  patch: PatchProposal;
  impact: ImpactDiff;
  afterPreview: PlanState;
}

interface WorkspacePayload {
  plan: PlanState;
  view: RoadmapView;
  history: PlanCommit[];
  pending: PendingChange[];
}

interface GraphPoint {
  id: string;
  x: number;
  y: number;
}

export function App() {
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [eventContext, setEventContext] = useState<{ nodeId?: string; nodeTitle?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const payload = await api<WorkspacePayload>(`/api/projects/${projectId}`);
      setWorkspace(payload);
      setPending(payload.pending[0] ?? null);
      setError(null);
    } catch (requestError) {
      setError(toMessage(requestError));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const selectedNode = workspace?.plan.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedEvidence = useMemo(
    () => workspace?.plan.evidence.filter((evidence) => selectedNode?.evidenceIds.includes(evidence.id)) ?? [],
    [workspace, selectedNode],
  );

  const updateNode = async (nodeId: string, changes: PlanNodeUpdate) => {
    setBusy(true);
    try {
      await api(`/api/projects/${projectId}/nodes/${nodeId}`, {
        method: "PATCH",
        body: JSON.stringify(changes),
      });
      await load();
    } catch (requestError) {
      setError(toMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const rescheduleNode = async (node: PlanNode, weeks: number) => {
    if (weeks === 0) return;
    const changes: PlanNodeUpdate = { adjustmentReason: `在路线图上拖动，${weeks > 0 ? "顺延" : "提前"} ${Math.abs(weeks)} 周` };
    if (node.startDate) changes.startDate = shiftIsoDate(node.startDate, weeks * 7);
    if (node.endDate) changes.endDate = shiftIsoDate(node.endDate, weeks * 7);
    await updateNode(node.id, changes);
  };

  const addTask = async () => {
    const title = window.prompt("给这枚新路标起个名字");
    if (!title?.trim() || !workspace) return;
    const milestone = workspace.view.milestones[0]?.milestone;
    const today = new Date().toISOString().slice(0, 10);
    const node: PlanNode = {
      id: `task-${crypto.randomUUID()}`,
      type: "task",
      title: title.trim(),
      status: "todo",
      ...(milestone ? { milestoneId: milestone.id } : {}),
      startDate: today,
      endDate: today,
      estimatedHours: 1,
      acceptanceCriteria: ["补充可检查的完成标准"],
      evidenceIds: [],
      manualFields: ["title"],
    };
    setBusy(true);
    try {
      await api(`/api/projects/${projectId}/nodes`, { method: "POST", body: JSON.stringify(node) });
      setSidebarOpen(false);
      setSelectedId(node.id);
      await load();
    } catch (requestError) {
      setError(toMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const submitHoursEvent = async (weeklyHours: number) => {
    setBusy(true);
    try {
      const result = await api<PendingChange & { before: PlanState }>(`/api/projects/${projectId}/events`, {
        method: "POST",
        body: JSON.stringify({
          type: "constraint_changed",
          title: "每周可投入时间变化",
          description: `每周投入调整为 ${weeklyHours} 小时`,
          targetNodeIds: [],
          changes: { weeklyHours },
        }),
      });
      setPending(result);
      setEventContext(null);
      setSelectedId(null);
      setError(null);
    } catch (requestError) {
      setError(toMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const submitNodeEvent = async (nodeId: string, nodeTitle: string, description: string) => {
    setBusy(true);
    try {
      const result = await api<PendingChange & { before: PlanState }>(`/api/projects/${projectId}/events`, {
        method: "POST",
        body: JSON.stringify({
          type: "custom",
          title: `${nodeTitle} 遇到变化`,
          description,
          targetNodeIds: [nodeId],
        }),
      });
      setPending(result);
      setEventContext(null);
      setSelectedId(null);
      setError(null);
    } catch (requestError) {
      setError(toMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const archiveNode = async (node: PlanNode) => {
    if (!window.confirm(`收起“${node.title}”？它会保留在版本历史中。`)) return;
    setBusy(true);
    try {
      await api(`/api/projects/${projectId}/nodes/${node.id}`, { method: "DELETE" });
      setSelectedId(null);
      await load();
    } catch (requestError) {
      setError(toMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const applyPending = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await api(`/api/projects/${projectId}/diff/apply`, {
        method: "POST",
        body: JSON.stringify({ patchId: pending.patch.id }),
      });
      setPending(null);
      await load();
    } catch (requestError) {
      setError(toMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  if (!workspace) {
    return (
      <main className="loading-screen">
        <div className="loading-orbit"><span>路</span></div>
        <p>{error ?? "正在展开你的路线…"}</p>
        {error && <button onClick={() => void load()}>重新连接</button>}
      </main>
    );
  }

  const tasks = workspace.view.milestones.flatMap((group) => group.tasks);
  const focusTasks = getWeekFocusTasks(tasks, new Date().toISOString().slice(0, 10));
  const doneCount = tasks.filter((task) => task.status === "done").length;
  const progress = tasks.length === 0 ? 0 : Math.round((doneCount / tasks.length) * 100);

  return (
    <div className={`app-shell ${sidebarOpen ? "sidebar-is-open" : ""} ${selectedNode ? "inspector-is-open" : ""}`}>
      <header className="floating-header">
        <button className="brand-toggle" onClick={() => setSidebarOpen((open) => !open)} aria-label="打开计划菜单">
          <span className="brand-symbol">路</span><span className="brand-word">知路</span><span className="menu-glyph">{sidebarOpen ? "×" : "≡"}</span>
        </button>
        <button className="goal-capsule" onClick={() => setSidebarOpen(true)}>
          <span className="goal-spark">✦</span>
          <span className="goal-copy"><small>正在前往</small><strong>{workspace.plan.goal}</strong></span>
          <span className="goal-progress">{progress}%</span>
        </button>
        <button className="change-trigger" onClick={() => setEventContext({})}><span>↯</span><span>现实有变化</span></button>
      </header>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      <RoadmapGraph workspace={workspace} selectedId={selectedId} focusId={focusTasks[0]?.id ?? null} pending={pending} onSelect={setSelectedId} onReschedule={(node, weeks) => void rescheduleNode(node, weeks)} />

      <div className="canvas-hint"><span className="hint-dot" /> 点击路标，探索任务与它背后的知乎依据</div>
      <div className="commit-whisper">v{workspace.plan.currentCommitId}</div>

      <Sidebar
        open={sidebarOpen}
        plan={workspace.plan}
        history={workspace.history}
        focusTasks={focusTasks}
        pendingCount={pending ? 1 : 0}
        busy={busy}
        onClose={() => setSidebarOpen(false)}
        onAddTask={() => void addTask()}
        onSelectTask={(id) => { setSidebarOpen(false); setSelectedId(id); }}
      />

      <Inspector
        node={selectedNode}
        evidence={selectedEvidence}
        busy={busy}
        onClose={() => setSelectedId(null)}
        onSave={(changes) => selectedNode && void updateNode(selectedNode.id, changes)}
        onComplete={() => selectedNode && void updateNode(selectedNode.id, { status: "done", adjustmentReason: "用户在路线图中标记抵达" })}
        onReportChange={() => selectedNode && setEventContext({ nodeId: selectedNode.id, nodeTitle: selectedNode.title })}
        onArchive={() => selectedNode && void archiveNode(selectedNode)}
      />

      {(sidebarOpen || selectedNode) && (
        <button className="drawer-scrim" aria-label="关闭面板" onClick={() => { setSidebarOpen(false); setSelectedId(null); }} />
      )}

      {eventContext && <EventDialog currentHours={workspace.plan.weeklyHours} {...(eventContext.nodeId && eventContext.nodeTitle ? { target: { id: eventContext.nodeId, title: eventContext.nodeTitle } } : {})} busy={busy} onClose={() => setEventContext(null)} onSubmitHours={(hours) => void submitHoursEvent(hours)} onSubmitNode={(nodeId, nodeTitle, description) => void submitNodeEvent(nodeId, nodeTitle, description)} />}
      {pending && <DiffPanel pending={pending} before={workspace.plan} busy={busy} onApply={() => void applyPending()} onClose={() => setPending(null)} />}
    </div>
  );
}

function RoadmapGraph({ workspace, selectedId, focusId, pending, onSelect, onReschedule }: { workspace: WorkspacePayload; selectedId: string | null; focusId: string | null; pending: PendingChange | null; onSelect: (id: string) => void; onReschedule: (node: PlanNode, weeks: number) => void }) {
  const [dragging, setDragging] = useState<{ id: string; startX: number } | null>(null);
  const tasks = workspace.view.milestones.flatMap((group) => group.tasks);
  const points = buildGraphPoints(tasks);
  const pointMap = new Map(points.map((point) => [point.id, point]));
  const start = { id: "start", x: 70, y: 355 };
  const goal = { id: "goal", x: 1130, y: 270 };
  const mainPath = smoothPath([start, ...points, goal]);
  const milestoneSpots = workspace.view.milestones.map((group, index) => {
    const groupPoints = group.tasks.map((task) => pointMap.get(task.id)).filter((point): point is GraphPoint => Boolean(point));
    return {
      milestone: group.milestone,
      x: groupPoints.length ? groupPoints.reduce((sum, point) => sum + point.x, 0) / groupPoints.length : 240 + index * 340,
      y: groupPoints.length ? groupPoints.reduce((sum, point) => sum + point.y, 0) / groupPoints.length : 330,
      rx: Math.max(150, groupPoints.length * 105),
      index,
    };
  });

  return (
    <main className="graph-viewport" aria-label="Roadmap 路线图">
      <div className="ambient ambient-one" /><div className="ambient ambient-two" />
      <div className="graph-stage">
        <svg className="route-svg" viewBox={`0 0 ${canvasWidth} ${canvasHeight}`} role="img" aria-label={workspace.plan.title}>
          <defs>
            <linearGradient id="routeGradient" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#f2b45a" /><stop offset="0.45" stopColor="#ff7e67" /><stop offset="1" stopColor="#8c7dff" /></linearGradient>
            <filter id="softGlow"><feGaussianBlur stdDeviation="5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
            <pattern id="dotGrid" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.2" fill="rgba(255,255,255,.13)" /></pattern>
          </defs>
          <rect width="1200" height="650" fill="url(#dotGrid)" />
          {milestoneSpots.map((spot) => <g key={spot.milestone.id} className={`phase-cloud phase-cloud-${spot.index % 3}`}><ellipse cx={spot.x} cy={spot.y} rx={spot.rx} ry="205" /></g>)}
          <path className="route-shadow" d={mainPath} /><path className="route-path" d={mainPath} /><path className="route-spark-line" d={mainPath} />
          {workspace.plan.relations.filter((relation) => relation.type === "depends_on").map((relation) => {
            const source = pointMap.get(relation.sourceId); const target = pointMap.get(relation.targetId);
            if (!source || !target) return null;
            const affected = pending?.impact.affectedNodeIds.includes(source.id) || pending?.impact.affectedNodeIds.includes(target.id);
            return <path key={relation.id} className={`dependency-thread ${affected ? "is-affected" : ""}`} d={smoothPath([target, source])} />;
          })}
          <circle className="path-traveler" r="5" filter="url(#softGlow)"><animateMotion dur="9s" repeatCount="indefinite" path={mainPath} /></circle>
          <circle className="path-traveler path-traveler-late" r="3"><animateMotion dur="9s" begin="-4.5s" repeatCount="indefinite" path={mainPath} /></circle>
          <g className="start-marker" transform={`translate(${start.x} ${start.y})`}><circle r="24" /><circle r="7" /><text x="0" y="45" textAnchor="middle">你在这里</text></g>
          <g className="goal-marker" transform={`translate(${goal.x} ${goal.y})`}><circle className="goal-orbit" r="43" /><circle className="goal-core" r="24" /><text x="0" y="5" textAnchor="middle">✓</text><text x="0" y="65" textAnchor="middle">目标</text></g>
        </svg>

        {milestoneSpots.map((spot) => (
          <button key={spot.milestone.id} className={`phase-label phase-label-${spot.index % 3}`} style={{ "--x": `${(spot.x / canvasWidth) * 100}%` } as CSSProperties} onClick={() => onSelect(spot.milestone.id)}>
            <span>0{spot.index + 1}</span><strong>{spot.milestone.title}</strong>
          </button>
        ))}

        {tasks.map((task, index) => {
          const point = pointMap.get(task.id); if (!point) return null;
          const affected = pending?.impact.affectedNodeIds.includes(task.id);
          return (
            <button
              key={task.id}
              className={`route-node status-${task.status} ${selectedId === task.id ? "is-selected" : ""} ${focusId === task.id ? "is-focus" : ""} ${affected ? "is-affected" : ""} ${dragging?.id === task.id ? "is-dragging" : ""}`}
              style={{ "--x": `${(point.x / canvasWidth) * 100}%`, "--y": `${(point.y / canvasHeight) * 100}%`, "--delay": `${index * -0.55}s` } as CSSProperties}
              draggable
              title="点击查看；水平拖动按周调整日期"
              onClick={() => onSelect(task.id)}
              onDragStart={(event) => beginNodeDrag(event, task.id, setDragging)}
              onDragEnd={(event) => {
                if (!dragging || dragging.id !== task.id) return;
                const weeks = weeksFromDragDistance(event.clientX - dragging.startX);
                setDragging(null);
                if (weeks !== 0) onReschedule(task, weeks);
              }}
            >
              {focusId === task.id && <span className="next-badge">下一站</span>}
              <span className="node-index">{String(index + 1).padStart(2, "0")}</span><span className="node-status-dot" /><strong>{task.title}</strong><small>{task.estimatedHours ?? "—"}h</small><span className="node-arrow">↗</span>
            </button>
          );
        })}
      </div>
    </main>
  );
}

function Sidebar({ open, plan, history, focusTasks, pendingCount, busy, onClose, onAddTask, onSelectTask }: { open: boolean; plan: PlanState; history: PlanCommit[]; focusTasks: PlanNode[]; pendingCount: number; busy: boolean; onClose: () => void; onAddTask: () => void; onSelectTask: (id: string) => void }) {
  const tasks = plan.nodes.filter((node) => node.type === "task" && node.status !== "archived");
  const done = tasks.filter((task) => task.status === "done").length;
  return (
    <aside className={`side-drawer ${open ? "is-open" : ""}`} aria-hidden={!open}>
      <div className="drawer-head"><div><span className="brand-symbol">路</span><strong>路线背包</strong></div><button onClick={onClose}>×</button></div>
      <div className="drawer-scroll">
        <section className="drawer-goal"><small>你的目的地</small><p>{plan.goal}</p></section>
        <section className="progress-card"><div className="progress-ring" style={{ "--progress": `${tasks.length ? (done / tasks.length) * 360 : 0}deg` } as CSSProperties}><span>{done}/{tasks.length}</span></div><div><strong>{plan.weeklyHours} 小时</strong><small>每周探索时间</small></div></section>
        {pendingCount > 0 && <div className="pending-callout"><span>↯</span><div><strong>{pendingCount} 个变化待确认</strong><small>正式路线还没有被改变</small></div></div>}
        <section className="week-focus"><p className="section-kicker">接下来 7 天</p>{focusTasks.length === 0 ? <div className="focus-empty">这周没有必须抵达的路标。</div> : focusTasks.map((task, index) => <button key={task.id} onClick={() => onSelectTask(task.id)}><span>{index === 0 ? "下一站" : formatDateRange(task)}</span><strong>{task.title}</strong><small>{task.estimatedHours ?? "—"}h · {statusLabel(task.status)}</small></button>)}</section>
        <section className="export-panel"><p className="section-kicker">带走这张路线</p><div><a href={`/api/projects/${projectId}/export/json`} download>JSON</a><a href={`/api/projects/${projectId}/export/markdown`} download>Markdown</a><a href={`/api/projects/${projectId}/export/zip`} download>Plan Bundle</a></div></section>
        <section className="drawer-history"><p className="section-kicker">路线足迹</p>{history.slice(0, 5).map((commit) => <div className="history-step" key={commit.id}><span /><div><strong>v{commit.id}</strong><small>{commit.reason}</small></div></div>)}</section>
      </div>
      <button className="drawer-add" disabled={busy} onClick={onAddTask}>＋ 放一枚新路标</button>
    </aside>
  );
}

function Inspector({ node, evidence, busy, onClose, onSave, onComplete, onReportChange, onArchive }: { node: PlanNode | null; evidence: EvidenceCard[]; busy: boolean; onClose: () => void; onSave: (changes: PlanNodeUpdate) => void; onComplete: () => void; onReportChange: () => void; onArchive: () => void }) {
  const [title, setTitle] = useState(""); const [startDate, setStartDate] = useState(""); const [endDate, setEndDate] = useState("");
  useEffect(() => { setTitle(node?.title ?? ""); setStartDate(node?.startDate ?? ""); setEndDate(node?.endDate ?? ""); }, [node]);
  return (
    <aside className={`inspector-drawer ${node ? "is-open" : ""}`} aria-hidden={!node}>
      {node && <><div className="drawer-head"><div><span className="node-mini-dot" /><strong>{node.type === "task" ? "路标详情" : "阶段详情"}</strong></div><button onClick={onClose}>×</button></div>
        <div className="inspector-scroll">
          <div className="status-row"><span className={`status-chip status-${node.status}`}>{statusLabel(node.status)}</span><span>{node.estimatedHours ? `${node.estimatedHours}h` : "阶段"}</span></div>
          <label>名称<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <div className="date-row"><label>开始<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label><label>结束<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label></div>
          <label>状态<select value={node.status} onChange={(event) => onSave({ status: event.target.value as PlanNode["status"] })}><option value="todo">待开始</option><option value="ready">可开始</option><option value="in_progress">进行中</option><option value="blocked">受阻</option><option value="done">已完成</option><option value="archived">已归档</option></select></label>
          <div className="node-actions"><button className="save-node" disabled={busy || !title.trim()} onClick={() => onSave({ title: title.trim(), startDate, endDate })}>保存修改</button>{node.type === "task" && node.status !== "done" && <button className="complete-node" disabled={busy} onClick={onComplete}>✓ 抵达此站</button>}</div>
          {node.type === "task" && <div className="node-secondary-actions"><button disabled={busy} onClick={onReportChange}>↯ 这里有变化</button><button className="archive-node" disabled={busy} onClick={onArchive}>收起此路标</button></div>}
          <section className="node-story"><p className="section-kicker">抵达证明</p><h3>{node.deliverable ?? "这个阶段的最终产出"}</h3><ul>{node.acceptanceCriteria?.map((item) => <li key={item}>{item}</li>) ?? <li>尚未补充完成标准</li>}</ul></section>
          <section className="evidence-stack"><p className="section-kicker">这枚路标从哪里来</p>{evidence.length === 0 && <div className="empty-evidence">目前没有知乎依据。它需要被标记为用户事实、规则或 AI 推断。</div>}{evidence.map((item) => <article className="evidence-card" key={item.id}><div><span>{item.sourceType === "zhihu" ? "知乎" : item.sourceType}</span><small>{contentTypeLabel(item.contentType)} · {item.verificationStatus}</small></div><h3>{item.title}</h3><p>{item.summary}</p>{item.supportingQuote && <blockquote>{item.supportingQuote}</blockquote>}{item.riskTags.length > 0 && <div className="risk-note">注意：{item.riskTags.join("；")}</div>}{item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noreferrer">打开原始回答 ↗</a>}</article>)}</section>
        </div></>}
    </aside>
  );
}

function EventDialog({ currentHours, target, busy, onClose, onSubmitHours, onSubmitNode }: { currentHours: number; target?: { id: string; title: string }; busy: boolean; onClose: () => void; onSubmitHours: (hours: number) => void; onSubmitNode: (nodeId: string, nodeTitle: string, description: string) => void }) {
  const [hours, setHours] = useState(Math.max(1, Math.floor(currentHours / 2)));
  const [description, setDescription] = useState("");
  return <div className="modal-backdrop"><section className="event-modal" role="dialog" aria-modal="true" aria-labelledby="event-title"><button className="modal-close" onClick={onClose}>×</button><div className="event-orb">↯</div><p className="section-kicker">现实事件</p><h2 id="event-title">{target ? "这枚路标发生了什么？" : "路线需要转弯了吗？"}</h2><p>{target ? `先记录“${target.title}”遇到的新情况。我只检查它和下游路径。` : "先告诉我现在每周能投入多少时间。我只点亮受影响的路径，不会重写整张图。"}</p>{target ? <><label className="event-note-label">变化说明<textarea autoFocus value={description} onChange={(event) => setDescription(event.target.value)} placeholder="例如：原本依赖的数据暂时拿不到，需要先找替代方案" /></label><button className="modal-primary" disabled={busy || !description.trim()} onClick={() => onSubmitNode(target.id, target.title, description.trim())}>预演受影响路径 <span>→</span></button></> : <><label>每周可投入<input type="number" min="1" max="80" value={hours} onChange={(event) => setHours(Number(event.target.value))} /><span>小时</span></label><button className="modal-primary" disabled={busy || hours <= 0} onClick={() => onSubmitHours(hours)}>看看路线会怎样变化 <span>→</span></button></>}</section></div>;
}

function DiffPanel({ pending, before, busy, onApply, onClose }: { pending: PendingChange; before: PlanState; busy: boolean; onApply: () => void; onClose: () => void }) {
  const summary = pending.event.type === "constraint_changed" ? `${before.weeklyHours}h → ${pending.afterPreview.weeklyHours}h / 周` : pending.event.title;
  return <section className="impact-dock"><div className="impact-icon">↯</div><div className="impact-copy"><small>路线预演 · 尚未生效</small><strong>{summary}</strong><span>{pending.impact.affectedNodeIds.length} 个节点会受影响</span></div><div className="impact-actions"><button onClick={onClose}>稍后</button><button disabled={busy} onClick={onApply}>沿新路线前进 →</button></div></section>;
}

function buildGraphPoints(tasks: PlanNode[]): GraphPoint[] {
  const yPattern = [355, 245, 405, 285, 390, 235]; const span = tasks.length > 1 ? 870 / (tasks.length - 1) : 0;
  return tasks.map((task, index) => ({ id: task.id, x: 165 + span * index, y: yPattern[index % yPattern.length] ?? 330 }));
}

function smoothPath(points: Array<Pick<GraphPoint, "x" | "y">>): string {
  if (points.length === 0) return ""; let path = `M ${points[0]?.x ?? 0} ${points[0]?.y ?? 0}`;
  for (let index = 1; index < points.length; index += 1) { const previous = points[index - 1]; const current = points[index]; if (!previous || !current) continue; const middleX = (previous.x + current.x) / 2; path += ` C ${middleX} ${previous.y}, ${middleX} ${current.y}, ${current.x} ${current.y}`; }
  return path;
}

function beginNodeDrag(event: DragEvent<HTMLButtonElement>, id: string, setDragging: (value: { id: string; startX: number }) => void): void {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", id);
  setDragging({ id, startX: event.clientX });
}

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } }); const body = (await response.json()) as { error?: string; issues?: Array<{ message: string }> } & T;
  if (!response.ok) throw new Error(body.issues?.map((item) => item.message).join("；") || body.error || `请求失败：${response.status}`); return body;
}

function statusLabel(status: PlanNode["status"]): string { return { draft: "草稿", todo: "等待探索", ready: "下一站", in_progress: "正在前往", blocked: "前方受阻", done: "已经抵达", archived: "已收起" }[status]; }
function contentTypeLabel(contentType: EvidenceCard["contentType"]): string { return { user_fact: "用户事实", advice: "建议", experience: "经验", opinion: "观点", factual_claim: "事实主张", rule: "规则", ai_inference: "AI 推断" }[contentType]; }
function formatDateRange(node: PlanNode): string { return node.startDate && node.endDate ? `${node.startDate.slice(5)} → ${node.endDate.slice(5)}` : "待安排"; }
function toMessage(error: unknown): string { return error instanceof Error ? error.message : "未知错误"; }
