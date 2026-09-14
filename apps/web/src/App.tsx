import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type {
  BaselineProposal,
  CreateProjectInput,
  EvidenceCard,
  EventProcessingRecord,
  ImpactDiff,
  PatchProposal,
  PlanCommit,
  PlanEvent,
  PlanNode,
  PlanNodeUpdate,
  PlanState,
  RoadmapperRun,
  RoadmapView,
} from "@zhilu/contracts";
import { positionDateInRange, shiftIsoDate, weeksFromDragDistance } from "./roadmap-date";
import { getWeekFocusTasks } from "./roadmap-focus";
import { getPlanDiff } from "./plan-diff";
import { selectCurrentPending } from "./pending-selection";
import { formatApiError } from "./api-error";
import { Onboarding } from "./Onboarding";
import { readFlowPage, resolveFlowPage, type FlowPage } from "./onboarding-model";
import { CollectedSourcesDisclosure, InsufficientEvidenceNotice, InsufficientSourcesDisclosure } from "./ResearchEvidence";
import { WeeklyOverrunNotice } from "./WeeklyOverrunNotice";
import { RoadmapTimeline, TaskDeadline, type TimelineScale } from "./RoadmapTimeline";

const demoProjectId = "agent-engineer-demo";
const initialProjectId = new URLSearchParams(window.location.search).get("project") ?? demoProjectId;
const canvasWidth = 1200;
const canvasHeight = 650;

interface PendingChange {
  event: PlanEvent;
  patch: PatchProposal;
  impact: ImpactDiff;
  afterPreview: PlanState;
  processing?: EventProcessingRecord;
}

interface UnchangedEventReplan {
  patchId: string;
  processing: EventProcessingRecord;
}

type EventReplanResponse = (PendingChange & { before: PlanState }) | { unchanged: true; processing: EventProcessingRecord };

export function mergeEventReplanResponse(pending: PendingChange, response: EventReplanResponse): {
  pending: PendingChange; unchangedReplan: UnchangedEventReplan | null;
} {
  return "unchanged" in response
    ? { pending, unchangedReplan: { patchId: pending.patch.id, processing: response.processing } }
    : { pending: response, unchangedReplan: null };
}

interface WorkspacePayload {
  plan: PlanState;
  view: RoadmapView;
  history: PlanCommit[];
  pending: PendingChange[];
  baselineProposals: BaselineProposal[];
}

interface GraphPoint {
  id: string;
  x: number;
  y: number;
}

interface NodeDragState {
  id: string;
  pointerId: number;
  startX: number;
  currentX: number;
  weeks: number;
}

interface CanvasPanState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

interface PanOffset {
  x: number;
  y: number;
}

export function App() {
  const [activeProjectId, setActiveProjectId] = useState(initialProjectId);
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [eventContext, setEventContext] = useState<{ nodeId?: string; nodeTitle?: string } | null>(null);
  const [page, setPage] = useState<FlowPage>(() => readFlowPage(window.location.search));
  const navigate = (next: FlowPage, projectId = activeProjectId) => {
    window.history.pushState(null, "", `?project=${encodeURIComponent(projectId)}&page=${next}`);
    setPage(next);
  };
  useEffect(() => {
    const restore = () => {
      const query = new URLSearchParams(window.location.search);
      setActiveProjectId(query.get("project") ?? demoProjectId);
      setPage(readFlowPage(window.location.search));
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const [baselineProposal, setBaselineProposal] = useState<BaselineProposal | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [replanning, setReplanning] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [unchangedReplan, setUnchangedReplan] = useState<UnchangedEventReplan | null>(null);

  const acceptWorkspace = (payload: WorkspacePayload | null) => {
    setWorkspace(payload);
    setPending(payload ? selectCurrentPending(payload.pending, payload.plan) : null);
    setPendingError(null);
    setUnchangedReplan(null);
  };

  const loadGeneration = useRef(0);
  const load = async () => {
    const generation = ++loadGeneration.current;
    try {
      const payload = await api<WorkspacePayload>(`/api/projects/${activeProjectId}`);
      if (generation !== loadGeneration.current) return;
      acceptWorkspace(payload);
      const proposal = payload.baselineProposals[0] ?? null;
      setBaselineProposal(proposal);
      setSelectedRouteId(proposal?.recommendedRouteId ?? null);
      setError(null);
    } catch (requestError) {
      if (generation === loadGeneration.current) setError(toMessage(requestError));
    }
  };

  useEffect(() => {
    if (workspace?.plan.projectId !== activeProjectId) {
      acceptWorkspace(null);
      void load();
    }
    return () => { loadGeneration.current += 1; };
  }, [activeProjectId]);

  const selectedNode = workspace?.plan.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedEvidence = useMemo(
    () => workspace?.plan.evidence.filter((evidence) => selectedNode?.evidenceIds.includes(evidence.id)) ?? [],
    [workspace, selectedNode],
  );

  const updateNode = async (nodeId: string, changes: PlanNodeUpdate) => {
    setBusy(true);
    try {
      await api(`/api/projects/${activeProjectId}/nodes/${nodeId}`, {
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
      await api(`/api/projects/${activeProjectId}/nodes`, { method: "POST", body: JSON.stringify(node) });
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
      const result = await api<PendingChange & { before: PlanState }>(`/api/projects/${activeProjectId}/events`, {
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
      setPendingError(null);
      setUnchangedReplan(null);
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
      const result = await api<PendingChange & { before: PlanState }>(`/api/projects/${activeProjectId}/events`, {
        method: "POST",
        body: JSON.stringify({
          type: "custom",
          title: `${nodeTitle} 遇到变化`,
          description,
          targetNodeIds: [nodeId],
        }),
      });
      setPending(result);
      setPendingError(null);
      setUnchangedReplan(null);
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
      await api(`/api/projects/${activeProjectId}/nodes/${node.id}`, { method: "DELETE" });
      setSelectedId(null);
      await load();
    } catch (requestError) {
      setError(toMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const applyPending = async () => {
    if (!pending || unchangedReplan?.patchId === pending.patch.id || pending.patch.baseVersion !== workspace?.plan.version) return;
    setBusy(true);
    setPendingError(null);
    try {
      await api(`/api/projects/${activeProjectId}/diff/apply`, {
        method: "POST",
        body: JSON.stringify({ patchId: pending.patch.id }),
      });
      setPending(null);
      await load();
    } catch (requestError) {
      setPendingError(toMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const replanPending = async () => {
    if (!pending || pending.patch.baseVersion !== workspace?.plan.version) return;
    setBusy(true);
    setReplanning(true);
    setPendingError(null);
    try {
      const result = await api<EventReplanResponse>(`/api/projects/${activeProjectId}/diff/replan`, {
        method: "POST",
        body: JSON.stringify({ patchId: pending.patch.id }),
      });
      const next = mergeEventReplanResponse(pending, result);
      setPending(next.pending);
      setUnchangedReplan(next.unchangedReplan);
    } catch (requestError) {
      setPendingError(`AI 排期未完成，上一份预演已保留。${toMessage(requestError)}`);
    } finally {
      setBusy(false);
      setReplanning(false);
    }
  };

  const createProject = async (input: CreateProjectInput) => {
    setBusy(true);
    setError(null);
    try {
      const created = await api<WorkspacePayload & { projectId: string }>("/api/projects", {
        method: "POST",
        body: JSON.stringify(input),
      });
      loadGeneration.current += 1;
      sessionStorage.removeItem("zhilu-interview");
      acceptWorkspace(created);
      setBaselineProposal(null);
      setSelectedRouteId(null);
      setSelectedId(null);
      setActiveProjectId(created.projectId);
      navigate("plan", created.projectId);
      await runLiveResearch(created.projectId);
    } catch (requestError) {
      setError(toMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const runMockResearch = async () => {
    setBusy(true);
    setError(null);
    try {
      const proposal = await api<BaselineProposal>(`/api/projects/${activeProjectId}/research/mock`, { method: "POST" });
      setBaselineProposal(proposal);
      setSelectedRouteId(proposal.recommendedRouteId);
    } catch (requestError) {
      setError(toMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const runLiveResearch = async (projectId = activeProjectId) => {
    setBusy(true);
    setError(null);
    try {
      const proposal = await api<BaselineProposal>(`/api/projects/${projectId}/research/live/baseline`, { method: "POST" });
      setBaselineProposal(proposal);
      setSelectedRouteId(proposal.recommendedRouteId);
    } catch (requestError) {
      setError(toMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const applyBaseline = async () => {
    if (!baselineProposal || !selectedRouteId) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await api<WorkspacePayload>(`/api/projects/${activeProjectId}/baseline/apply`, {
        method: "POST",
        body: JSON.stringify({ proposalId: baselineProposal.id, routeId: selectedRouteId }),
      });
      acceptWorkspace(payload);
      setBaselineProposal(null);
      setSelectedRouteId(null);
      navigate("roadmap");
      setSelectedId(null);
    } catch (requestError) {
      setError(toMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const revisePlan = async (message: string) => {
    if (!baselineProposal || !selectedRouteId) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api<BaselineProposal>(`/api/projects/${activeProjectId}/baseline/revise`, {
        method: "POST", body: JSON.stringify({ proposalId: baselineProposal.id, routeId: selectedRouteId, message }),
      });
      setBaselineProposal(next);
      setSelectedRouteId(next.recommendedRouteId);
    } catch (requestError) { setError(toMessage(requestError)); }
    finally { setBusy(false); }
  };

  if (page === "interview") return <Onboarding busy={busy} error={error}
    onClose={() => { setError(null); navigate("roadmap"); }} onCreate={input => void createProject(input)} />;

  if (workspace?.plan.projectId === activeProjectId && resolveFlowPage(page, workspace.plan.evidence.some(item => item.riskTags.includes("等待知乎研究"))) === "plan" && (baselineProposal || workspace.plan.evidence.some(item => item.riskTags.includes("等待知乎研究")))) {
    return <ResearchStudio proposal={baselineProposal} selectedRouteId={selectedRouteId} busy={busy} error={error}
      onClose={() => { setError(null); navigate("interview"); }} onRunLive={() => void runLiveResearch()}
      onRunMock={() => void runMockResearch()} onSelectRoute={setSelectedRouteId}
      onRevise={message => void revisePlan(message)} onApply={() => void applyBaseline()} />;
  }

  if (!workspace || workspace.plan.projectId !== activeProjectId) {
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
  const researchPending = workspace.plan.evidence.some((item) => item.riskTags.includes("等待知乎研究"));

  return (
    <div className={`app-shell ${sidebarOpen ? "sidebar-is-open" : ""} ${selectedNode ? "inspector-is-open" : ""}`}>
      <header className="floating-header">
        <button className="brand-toggle" onClick={() => setSidebarOpen((open) => !open)} aria-label="打开计划菜单">
          <span className="brand-symbol">路</span><span className="brand-word">知路</span><span className="menu-glyph">{sidebarOpen ? "×" : "≡"}</span>
        </button>
        <button className="goal-capsule" onClick={() => setSidebarOpen(true)}>
          <span className="goal-spark">✦</span>
          <span className="goal-copy"><small>{researchPending ? "研究准备版" : workspace.plan.research?.mode === "mock" ? "Mock 研究路线" : workspace.plan.research?.roadmapper?.evidenceStatus === "insufficient" ? "证据不足 · 暂定计划" : "正在前往"}</small><strong>{workspace.plan.goal}</strong></span>
          <span className="goal-progress">{progress}%</span>
        </button>
        <button className="change-trigger" onClick={() => setEventContext({})}><span>↯</span><span>现实有变化</span></button>
      </header>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      <RoadmapGraph workspace={workspace} selectedId={selectedId} focusId={focusTasks[0]?.id ?? null} pending={pending} onSelect={setSelectedId} onReschedule={(node, weeks) => void rescheduleNode(node, weeks)} />

      <div className="canvas-hint"><span className="hint-dot" /> 拖动画布查看全图 · 横向拖动路标按周改期</div>
      <div className="commit-whisper">v{workspace.plan.currentCommitId}</div>


      <Sidebar
        open={sidebarOpen}
        plan={workspace.plan}
        projectId={activeProjectId}
        history={workspace.history}
        focusTasks={focusTasks}
        pendingCount={pending ? 1 : 0}
        busy={busy}
        onClose={() => setSidebarOpen(false)}
        onAddTask={() => void addTask()}
        onNewProject={() => { setSidebarOpen(false); setError(null); navigate("interview"); }}
        onSelectTask={(id) => { setSidebarOpen(false); setSelectedId(id); }}
      />

      <Inspector
        node={selectedNode}
        plan={workspace.plan}
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
      {pending && <DiffPanel pending={pending} before={workspace.plan} busy={busy} replanning={replanning} error={pendingError} unchangedReplan={unchangedReplan} onApply={() => void applyPending()} onReplan={() => void replanPending()} onClose={() => { setPending(null); setUnchangedReplan(null); }} />}

    </div>
  );
}

export function ResearchStudio({ proposal, selectedRouteId, busy, error, onClose, onRunLive, onRunMock, onSelectRoute, onApply, onRevise }: {
  proposal: BaselineProposal | null;
  selectedRouteId: string | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onRunLive: () => void;
  onRunMock: () => void;
  onSelectRoute: (routeId: string) => void;
  onApply: () => void;
  onRevise: (message: string) => void;
}) {
  const [message, setMessage] = useState("");
  useEffect(() => { setMessage(""); }, [proposal?.id]);
  if (!proposal) {
    return <main className="flow-page plan-page"><section className="research-intro" aria-labelledby="research-title">
      <button className="research-close" disabled={busy} onClick={onClose}>返回访谈</button>
      <div className="research-constellation"><span>问</span><i /><i /><i /></div>
      <p className="section-kicker">02 · 生成计划草稿</p>
      <h2 id="research-title">先让证据回来，<br />再决定走哪条路。</h2>
      <p>从你的目标与背景出发，检索知乎证据，再规划路线、任务与时间。你可以检查依据，选好路线后再点亮图。</p>
      <div className="research-steps"><span><b>01</b>拆出研究问题</span><span><b>02</b>检索并压缩证据</span><span><b>03</b>你确认后写入图</span></div>
      {error && <div className="research-error" role="alert">{error}</div>}
      <button className="research-primary" disabled={busy} onClick={onRunLive}>{busy ? "正在研究并规划路线…" : "用知乎证据规划路线"}<span>→</span></button>
      <button className="research-secondary" disabled={busy} onClick={onRunMock}>本机尚未配置？使用 Mock 演示</button>
    </section></main>;
  }
  const isLive = proposal.researchRun.mode === "live";
  const roadmapper = proposal.roadmapper;
  const insufficient = isLive && roadmapper?.evidenceStatus === "insufficient";
  const insufficientSources = proposal.researchRun.evidencePacks.flatMap(pack => pack.insufficientSources ?? []);
  const route = proposal.researchRun.routeCandidates.find((item) => item.id === selectedRouteId) ?? proposal.researchRun.routeCandidates[0];
  const preview = proposal.previews.find((item) => item.routeId === route?.id)?.plan;
  const previewReviewNodes = preview?.nodes.filter((node) => node.type === "checkpoint" || node.type === "assumption") ?? [];
  const researchEvidence = [...new Map(proposal.researchRun.evidencePacks.flatMap((pack) => pack.evidence).map((card) => [card.id, card])).values()];
  const recommendationEvidence = researchEvidence.filter((card) => roadmapper?.recommendationEvidenceIds.includes(card.id));
  const routeEvidence = researchEvidence.filter((card) => route?.evidenceIds.includes(card.id));
  const queryCount = proposal.researchRun.questions.reduce((sum, question) => sum + question.searchQueries.length, 0);
  return (
    <main className="flow-page plan-page">
      <section className="route-lab" aria-labelledby="route-lab-title">
        <button className="research-close" disabled={busy} onClick={onClose}>返回访谈</button>
        <header>
          <div>
            <p className="section-kicker">{roadmapper ? "模型路线草案" : isLive ? "规则路线草案" : "演示路线草案"} · 尚未写入</p>
            <h2 id="route-lab-title">先把计划商量好</h2>
          </div>
          <div className="research-metrics">
            <span><b>{proposal.researchRun.questions.length}</b>问题</span>
            <span><b>{queryCount}</b>检索词</span>
            <span><b>{researchEvidence.length}</b>{isLive ? "知乎证据" : "演示证据"}</span>
          </div>
          {error && <div className="research-error" role="alert">{error}</div>}
        </header>
        {insufficient && <InsufficientEvidenceNotice />}
        <InsufficientSourcesDisclosure sources={insufficientSources} showEmpty={insufficient && !researchEvidence.some(card => card.sourceType === "zhihu")} />
        <div className="route-lab-grid">
          <section className="route-choice">
            <p className="section-kicker">选择路线</p>
            {roadmapper && (
              <div className="route-recommendation">
                <small>为什么推荐这个起点</small>
                <p>{roadmapper.recommendationReason}</p>
                <EvidenceDisclosure label="查看推荐依据" evidence={recommendationEvidence} />
              </div>
            )}
            {proposal.researchRun.routeCandidates.map((candidate) => (
              <button key={candidate.id} aria-pressed={candidate.id === route?.id} className={candidate.id === route?.id ? "is-selected" : ""} disabled={busy} onClick={() => onSelectRoute(candidate.id)}>
                <span className="route-radio" />
                <div>
                  <small>{candidate.id === proposal.recommendedRouteId ? "推荐起点" : "另一种节奏"}</small>
                  <h3>{candidate.title}</h3>
                  <p>{candidate.summary}</p>
                  <em>适合：{candidate.applicableWhen.join(" · ")}</em>
                </div>
              </button>
            ))}
            {route && (
              <div className="selected-route-details" key={route.id}>
                {route.risks.length > 0 && (
                  <details className="research-details planning-warnings">
                    <summary>这条路线的 {route.risks.length} 个风险与取舍</summary>
                    <ul>{route.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul>
                  </details>
                )}
                <EvidenceDisclosure label="查看这条路线的原始依据" evidence={routeEvidence} />
                {preview && <EvidenceApplications applications={roadmapper?.evidenceApplications} routeId={route.id}
                  evidence={preview.evidence} nodes={preview.nodes} />}
              </div>
            )}
          </section>
          <section className="preview-rail" key={route?.id}>
            <p className="section-kicker">计划内容</p>
            <WeeklyOverrunNotice overruns={roadmapper?.weeklyOverruns} routeId={route?.id} />
            {roadmapper && <p className="preview-note">任务拆分、日期与工时是 AI 推断，确认后仍可在图上调整。</p>}
            {preview?.nodes.filter((node) => node.type === "task").map((node, index) => (
              <article className="preview-task" key={node.id}>
                <span>{index + 1}</span>
                <div>
                  <strong>{node.title}</strong>
                  <small>{formatDateRange(node)} · {node.estimatedHours ?? "—"}h</small>
                  <TaskDeadline task={node} />
                  {roadmapper && !preview.evidence.some(card => card.sourceType === "zhihu" && node.evidenceIds.includes(card.id))
                    && <p className="inference-note">AI规划／待验证：这项任务尚无直接采用的知乎依据。</p>}
                  <details className="research-details">
                    <summary>产出、验收与依据</summary>
                    {node.deliverable && <p>{node.deliverable}</p>}
                    <ul>{node.acceptanceCriteria?.map((item, criterionIndex) => <li key={criterionIndex}>{item}</li>)}</ul>
                    <EvidenceDisclosure label="查看任务依据" evidence={preview.evidence.filter((card) => node.evidenceIds.includes(card.id))} />
                  </details>
                </div>
              </article>
            ))}
            {previewReviewNodes.length > 0 && (
              <details className="research-details review-preview">
                <summary>复盘与待确认假设 · {previewReviewNodes.length}</summary>
                {previewReviewNodes.map((node) => (
                  <div key={node.id}>
                    <small>{nodeTypeLabel(node.type)} · {formatDateRange(node)}</small>
                    <strong>{node.title}</strong>
                    {(node.description || node.deliverable) && <p>{node.description ?? node.deliverable}</p>}
                  </div>
                ))}
              </details>
            )}
            <div className="preview-note">应用后生成 v{preview?.currentCommitId}。原研究准备版仍保留在版本历史中。</div>
          </section>
          <aside className="plan-chat" aria-label="调整计划对话">
            <h3>一起调整计划</h3>
            <p>告诉我哪些安排不合适。每次调整都会更新左侧草稿，确认后才生成路线图。</p>
            <div className="plan-messages" aria-live="polite">
              {(proposal.conversation ?? []).map((entry, index) => <article key={index} className={`message-${entry.role}`}><small>{entry.role === "user" ? "你" : "知路"}</small><p>{entry.content}</p></article>)}
              {busy && <p role="status">正在处理，请稍候…</p>}
            </div>
            <form onSubmit={event => { event.preventDefault(); if (message.trim() && !busy) onRevise(message.trim()); }}>
              <label htmlFor="plan-adjustment">你的调整意见</label>
              <textarea id="plan-adjustment" maxLength={2000} value={message} disabled={busy || !isLive} onChange={event => setMessage(event.target.value)} placeholder="例如：前两周先做一个小成果，减少纯理论任务" />
              <button className="research-primary" type="submit" disabled={busy || !isLive || !message.trim()}>发送并调整草稿</button>
            </form>
            {!isLive && <small>演示草稿无法调用真实模型调整，请先生成知乎计划。</small>}
            <details className="research-details"><summary>查看研究问题与待确认点</summary>
              {proposal.researchRun.questions.map(question => <p key={question.question}>{question.question}</p>)}
              {roadmapper?.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
            </details>
          </aside>
        </div>
        <footer>
          <div><span className="route-proof-dot" /><small>{isLive ? insufficient ? "证据不足：这份暂定计划由模型推断，确认前请核实关键安排。" : "知乎内容提供依据；路线安排仍需结合你的实际情况确认。" : "这是机制演示，不是已验证的知乎研究结论。"}</small></div>
          <button className="research-primary" disabled={busy || !selectedRouteId} onClick={onApply}>{busy ? "正在写入路线…" : "确认计划，生成路线图 / Plan Bundle"}<span>→</span></button>
        </footer>
      </section>
    </main>
  );
}

function EvidenceDisclosure({ label, evidence }: { label: string; evidence: EvidenceCard[] }) {
  if (evidence.length === 0) return null;
  return (
    <details className="research-details evidence-disclosure">
      <summary>{label} · {evidence.length}</summary>
      {evidence.map((card) => <EvidenceCardView key={card.id} card={card} />)}
    </details>
  );
}

function EvidenceApplications({ applications, routeId, evidence, nodes }: {
  applications?: RoadmapperRun["evidenceApplications"]; routeId: string; evidence: EvidenceCard[]; nodes: PlanNode[];
}) {
  const selected = (applications ?? []).filter(item => item.routeId === routeId
    && evidence.some(card => card.id === item.evidenceId && card.sourceType === "zhihu")
    && nodes.some(node => node.type === "task" && item.taskIds.includes(node.id) && node.evidenceIds.includes(item.evidenceId)));
  if (!selected.length) return null;
  return <details className="research-details evidence-disclosure">
    <summary>查看依据如何影响任务 · {selected.length}</summary>
    {selected.map(item => <EvidenceCardView key={item.evidenceId} card={evidence.find(card => card.id === item.evidenceId)!}
      application={item} nodes={nodes} />)}
  </details>;
}

function EvidenceCardView({ card, application, nodes = [] }: {
  card: EvidenceCard; application?: NonNullable<RoadmapperRun["evidenceApplications"]>[number] | undefined; nodes?: PlanNode[];
}) {
  return (
    <article className="evidence-card">
      <div><span>{card.sourceType === "zhihu" ? "知乎" : card.sourceType === "ai" ? "AI 推断" : card.sourceType}</span><small>{contentTypeLabel(card.contentType)} · {card.verificationStatus}</small></div>
      <h3>{card.title}</h3>
      {application && <div className="inference-note">
        <strong>模型的采用说明 · 待核实</strong>
        <p>{application.application}</p>
        <p>对应任务：{nodes.filter(node => node.type === "task" && application.taskIds.includes(node.id)
          && node.evidenceIds.includes(card.id)).map(node => node.title).join("；")}</p>
      </div>}
      <p>{card.summary}</p>
      {card.supportingQuote && <blockquote>{card.supportingQuote}</blockquote>}
      <dl className="evidence-context">
        {card.applicableWhen.length > 0 && <div><dt>适用条件</dt><dd>{card.applicableWhen.join("；")}</dd></div>}
        {card.adoptionReason && <div><dt>采用原因</dt><dd>{card.adoptionReason}</dd></div>}
        {card.caveats.length > 0 && <div><dt>局限与例外</dt><dd>{card.caveats.join("；")}</dd></div>}
      </dl>
      {card.riskTags.length > 0 && <div className="risk-note">注意：{card.riskTags.join("；")}</div>}
      {card.sourceUrl && <a href={card.sourceUrl} target="_blank" rel="noreferrer">{card.sourceTitle ?? "打开原始来源"} ↗</a>}
    </article>
  );
}

function RoadmapGraph({ workspace, selectedId, focusId, pending, onSelect, onReschedule }: { workspace: WorkspacePayload; selectedId: string | null; focusId: string | null; pending: PendingChange | null; onSelect: (id: string) => void; onReschedule: (node: PlanNode, weeks: number) => void }) {
  const [dragging, setDragging] = useState<NodeDragState | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState<CanvasPanState | null>(null);
  const suppressClick = useRef(false);
  const tasks = workspace.view.milestones.flatMap((group) => group.tasks);
  const milestones = workspace.view.milestones.map((group) => group.milestone);
  const isDense = tasks.length > 8;
  const denseLayout = isDense ? buildDenseGraphLayout(tasks, milestones) : null;
  const graphWidth = denseLayout?.width ?? canvasWidth;
  const points = denseLayout?.points ?? buildGraphPoints(tasks, milestones);
  const timelineScale = denseLayout?.timeline ?? buildTimelineScale(milestones);
  const pointMap = new Map(points.map((point) => [point.id, point]));
  const start = { id: "start", x: 70, y: 355 };
  const goal = { id: "goal", x: graphWidth - 70, y: 270 };
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
  useEffect(() => { setPan({ x: 0, y: 0 }); setPanning(null); }, [workspace.plan.projectId, workspace.plan.research?.selectedRouteId, isDense]);

  return (
    <main
      className={`graph-viewport ${panning ? "is-panning" : ""}`}
      aria-label="Roadmap 路线图"
      onPointerDown={(event) => beginCanvasPan(event, pan, setPanning)}
      onPointerMove={(event) => moveCanvasPan(event, panning, setPan, denseLayout ? { width: graphWidth, height: canvasHeight } : undefined)}
      onPointerUp={(event) => endCanvasPan(event, panning, setPanning)}
      onPointerCancel={() => setPanning(null)}
      onDoubleClick={(event) => { if (!(event.target as Element).closest("button")) setPan({ x: 0, y: 0 }); }}
    >
      <div className="ambient ambient-one" /><div className="ambient ambient-two" />
      <div className={`graph-stage ${isDense ? "is-dense" : ""}`} style={{ "--pan-x": `${pan.x}px`, "--pan-y": `${pan.y}px`, ...(isDense ? { width: `${graphWidth}px`, height: `${canvasHeight}px` } : {}) } as CSSProperties}>
        <svg className="route-svg" viewBox={`0 0 ${graphWidth} ${canvasHeight}`} preserveAspectRatio="none" role="img" aria-label={workspace.plan.title}>
          <defs>
            <linearGradient id="routeGradient" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#91adeb" /><stop offset="0.45" stopColor="#2860eb" /><stop offset="1" stopColor="#9890da" /></linearGradient>
            <filter id="softGlow"><feGaussianBlur stdDeviation="5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
            <pattern id="dotGrid" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".8" fill="rgba(69,92,132,.16)" /></pattern>
          </defs>
          <rect width={graphWidth} height={canvasHeight} fill="url(#dotGrid)" />
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
          <button key={spot.milestone.id} className={`phase-label phase-label-${spot.index % 3}`} style={{ "--x": `${(spot.x / graphWidth) * 100}%` } as CSSProperties} onPointerDown={(event) => event.stopPropagation()} onClick={() => onSelect(spot.milestone.id)}>
            <span>0{spot.index + 1}</span><strong>{spot.milestone.title}</strong>
          </button>
        ))}

        {tasks.map((task, index) => {
          const point = pointMap.get(task.id); if (!point) return null;
          const affected = pending?.impact.affectedNodeIds.includes(task.id);
          const dragX = dragging?.id === task.id ? dragging.currentX - dragging.startX : 0;
          return (
            <button
              key={task.id}
              className={`route-node status-${task.status} ${selectedId === task.id ? "is-selected" : ""} ${focusId === task.id ? "is-focus" : ""} ${affected ? "is-affected" : ""} ${dragging?.id === task.id ? "is-dragging" : ""}`}
              style={{ "--x": `${(point.x / graphWidth) * 100}%`, "--y": `${(point.y / canvasHeight) * 100}%`, "--delay": `${index * -0.55}s`, "--drag-x": `${dragX}px` } as CSSProperties}
              title={`${task.title} · ${formatDateRange(task)}；点击查看，水平拖动按周调整日期`}
              onClick={(event) => { if (suppressClick.current) event.preventDefault(); else onSelect(task.id); }}
              onPointerDown={(event) => beginNodePointerDrag(event, task.id, setDragging)}
              onPointerMove={(event) => moveNodePointerDrag(event, dragging, setDragging)}
              onPointerUp={(event) => endNodePointerDrag(event, task, dragging, setDragging, suppressClick, onReschedule)}
              onPointerCancel={() => setDragging(null)}
            >
              {focusId === task.id && <span className="next-badge">下一站</span>}
              {dragging?.id === task.id && dragging.weeks !== 0 && <span className="drag-badge">{dragging.weeks > 0 ? `顺延 ${dragging.weeks} 周` : `提前 ${Math.abs(dragging.weeks)} 周`}</span>}
              <span className="node-index">{String(index + 1).padStart(2, "0")}</span><span className="node-status-dot" /><strong>{task.title}</strong><small>{task.estimatedHours ?? "—"}h</small><TaskDeadline task={task} /><span className="node-arrow">↗</span>
            </button>
          );
        })}
      </div>
      <RoadmapTimeline scale={timelineScale} width={graphWidth} panX={pan.x} dense={isDense} />
      {(pan.x !== 0 || pan.y !== 0) && <button className="reset-canvas" onPointerDown={(event) => event.stopPropagation()} onClick={() => setPan({ x: 0, y: 0 })}>{isDense ? "回到起点" : "回到全图"}</button>}
    </main>
  );
}

export function Sidebar({ open, plan, projectId, history, focusTasks, pendingCount, busy, onClose, onAddTask, onNewProject, onSelectTask }: { open: boolean; plan: PlanState; projectId: string; history: PlanCommit[]; focusTasks: PlanNode[]; pendingCount: number; busy: boolean; onClose: () => void; onAddTask: () => void; onNewProject: () => void; onSelectTask: (id: string) => void }) {
  const tasks = plan.nodes.filter((node) => node.type === "task" && node.status !== "archived");
  const reviewNodes = plan.nodes.filter((node) => (node.type === "checkpoint" || node.type === "assumption") && node.status !== "archived");
  const done = tasks.filter((task) => task.status === "done").length;
  return (
    <aside className={`side-drawer ${open ? "is-open" : ""}`} aria-hidden={!open}>
      <div className="drawer-head"><div><span className="brand-symbol">路</span><strong>路线背包</strong></div><button onClick={onClose}>×</button></div>
      <div className="drawer-scroll">
        <section className="drawer-goal"><small>你的目的地</small><p>{plan.goal}</p></section>
        <WeeklyOverrunNotice overruns={plan.research?.roadmapper?.weeklyOverruns} routeId={plan.research?.selectedRouteId} />
        {plan.research?.mode === "live" && plan.research.roadmapper?.evidenceStatus === "insufficient" && <InsufficientEvidenceNotice />}
        <InsufficientSourcesDisclosure sources={plan.research?.insufficientSources ?? []} showEmpty={plan.research?.mode === "live" && plan.research.roadmapper?.evidenceStatus === "insufficient" && !plan.evidence.some(card => card.sourceType === "zhihu")} />
        <section className="progress-card"><div className="progress-ring" style={{ "--progress": `${tasks.length ? (done / tasks.length) * 360 : 0}deg` } as CSSProperties}><span>{done}/{tasks.length}</span></div><div><strong>{plan.weeklyHours} 小时</strong><small>每周探索时间</small></div></section>
        {pendingCount > 0 && <div className="pending-callout"><span>↯</span><div><strong>{pendingCount} 个变化待确认</strong><small>正式路线还没有被改变</small></div></div>}
        <section className="week-focus"><p className="section-kicker">接下来 7 天</p>{focusTasks.length === 0 ? <div className="focus-empty">这周没有必须抵达的路标。</div> : focusTasks.map((task, index) => <button key={task.id} onClick={() => onSelectTask(task.id)}><span>{index === 0 ? "下一站" : formatDateRange(task)}</span><strong>{task.title}</strong><small>{task.estimatedHours ?? "—"}h · {statusLabel(task.status)}</small><TaskDeadline task={task} /></button>)}</section>
        {reviewNodes.length > 0 && (
          <details className="research-details review-nodes">
            <summary>复盘与待确认假设 · {reviewNodes.length}</summary>
            {reviewNodes.map((node) => (
              <button key={node.id} onClick={() => onSelectTask(node.id)}>
                <span>{nodeTypeLabel(node.type)} · {formatDateRange(node)}</span>
                <strong>{node.title}</strong>
                <small>{statusLabel(node.status)}</small>
              </button>
            ))}
          </details>
        )}
        <section className="export-panel"><p className="section-kicker">带走这张路线</p><div><a href={`/api/projects/${projectId}/export/json`} download>JSON</a><a href={`/api/projects/${projectId}/export/markdown`} download>Markdown</a><a href={`/api/projects/${projectId}/export/zip`} download>Plan Bundle</a></div></section>
        <section className="drawer-history"><p className="section-kicker">路线足迹</p>{history.slice(0, 5).map((commit) => <div className="history-step" key={commit.id}>
          <span />
          <div>
            <strong>v{commit.id}</strong><small>{commit.reason}</small>
            {commit.processing && <details className="research-details history-processing">
              <summary>{commit.processing.mode === "model" ? "AI 排期" : "规则处理"} · 查看处理记录</summary>
              <p>{commit.processing.summary}</p>
              <p>{commit.processing.researchNeeded ? "需要补充研究：" : "无需重新检索："}{commit.processing.researchReason}</p>
              {commit.processing.warnings.length > 0 && <ul>{commit.processing.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
            </details>}
          </div>
        </div>)}</section>
      </div>
      <div className="drawer-actions"><button disabled={busy} onClick={onNewProject}>✦ 新路线</button><button disabled={busy} onClick={onAddTask}>＋ 新路标</button></div>
    </aside>
  );
}

export function Inspector({ node, plan, evidence, busy, onClose, onSave, onComplete, onReportChange, onArchive }: { node: PlanNode | null; plan?: PlanState; evidence: EvidenceCard[]; busy: boolean; onClose: () => void; onSave: (changes: PlanNodeUpdate) => void; onComplete: () => void; onReportChange: () => void; onArchive: () => void }) {
  const [title, setTitle] = useState(""); const [startDate, setStartDate] = useState(""); const [endDate, setEndDate] = useState("");
  useEffect(() => { setTitle(node?.title ?? ""); setStartDate(node?.startDate ?? ""); setEndDate(node?.endDate ?? ""); }, [node]);
  return (
    <aside className={`inspector-drawer ${node ? "is-open" : ""}`} aria-hidden={!node}>
      {node && <><div className="drawer-head"><div><span className="node-mini-dot" /><strong>{nodeTypeLabel(node.type)}详情</strong></div><button onClick={onClose}>×</button></div>
        <div className="inspector-scroll">
          <div className="status-row"><span className={`status-chip status-${node.status}`}>{statusLabel(node.status)}</span><span>{node.estimatedHours ? `${node.estimatedHours}h` : nodeTypeLabel(node.type)}</span></div>
          <label>名称<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <div className="date-row"><label>开始<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label><label>结束<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label></div>
          <label>状态<select value={node.status} onChange={(event) => onSave({ status: event.target.value as PlanNode["status"] })}><option value="draft">草稿</option><option value="todo">待开始</option><option value="ready">可开始</option><option value="in_progress">进行中</option><option value="blocked">受阻</option><option value="done">已完成</option><option value="archived">已归档</option></select></label>
          <div className="node-actions"><button className="save-node" disabled={busy || !title.trim()} onClick={() => onSave({ title: title.trim(), startDate, endDate })}>保存修改</button>{node.type === "task" && node.status !== "done" && <button className="complete-node" disabled={busy} onClick={onComplete}>✓ 抵达此站</button>}</div>
          {node.type === "task" && <div className="node-secondary-actions"><button disabled={busy} onClick={onReportChange}>↯ 这里有变化</button><button className="archive-node" disabled={busy} onClick={onArchive}>收起此路标</button></div>}
          <section className="node-story"><p className="section-kicker">抵达证明</p><h3>{node.deliverable ?? "待补充可检查的产出"}</h3>{node.description && <p className="inference-note">{node.description}</p>}<ul>{node.acceptanceCriteria?.map((item) => <li key={item}>{item}</li>) ?? <li>尚未补充完成标准</li>}</ul></section>
          <section className="evidence-stack">
            <p className="section-kicker">这枚路标从哪里来</p>
            {evidence.length === 0 && <div className="empty-evidence">目前没有知乎依据。它需要被标记为用户事实、规则或 AI 推断。</div>}
            {node.type === "task" && evidence.some(card => card.sourceType === "ai") && !evidence.some(card => card.sourceType === "zhihu")
              && <p className="inference-note">AI规划／待验证：这项任务尚无直接采用的知乎依据。</p>}
            {evidence.some((card) => card.contentType === "ai_inference") && <p className="inference-note">这枚路标含 AI 推断；请检查任务安排、工时与依据是否适合你。</p>}
            <InsufficientSourcesDisclosure key={`insufficient-${node.id}`} sources={plan?.research?.insufficientSources ?? []}
              description="这些原帖来自本次研究，未作为计划依据；不代表这些内容支持当前路标。保留原文片段和链接，供你自行判断。"
              showEmpty={plan?.research?.mode === "live" && plan.research.roadmapper?.evidenceStatus === "insufficient" && !plan.evidence.some(card => card.sourceType === "zhihu")} />
            <CollectedSourcesDisclosure key={`collected-${node.id}`} evidence={plan?.evidence.filter(card => card.sourceType === "zhihu" && !node.evidenceIds.includes(card.id)) ?? []} />
            {evidence.map((card) => <EvidenceCardView key={card.id} card={card} nodes={plan?.nodes ?? [node]}
              application={card.sourceType === "zhihu" ? plan?.research?.roadmapper?.evidenceApplications?.find(item =>
                item.routeId === plan.research?.selectedRouteId && item.evidenceId === card.id && item.taskIds.includes(node.id)) : undefined} />)}
          </section>
        </div></>}
    </aside>
  );
}

function EventDialog({ currentHours, target, busy, onClose, onSubmitHours, onSubmitNode }: { currentHours: number; target?: { id: string; title: string }; busy: boolean; onClose: () => void; onSubmitHours: (hours: number) => void; onSubmitNode: (nodeId: string, nodeTitle: string, description: string) => void }) {
  const [hours, setHours] = useState(Math.max(1, Math.floor(currentHours / 2)));
  const [description, setDescription] = useState("");
  return <div className="modal-backdrop"><section className="event-modal" role="dialog" aria-modal="true" aria-labelledby="event-title"><button className="modal-close" onClick={onClose}>×</button><div className="event-orb">↯</div><p className="section-kicker">现实事件</p><h2 id="event-title">{target ? "这枚路标发生了什么？" : "路线需要转弯了吗？"}</h2><p>{target ? `先记录“${target.title}”遇到的新情况。我只检查它和下游路径。` : "先告诉我现在每周能投入多少时间。我只点亮受影响的路径，不会重写整张图。"}</p>{target ? <><label className="event-note-label">变化说明<textarea autoFocus value={description} onChange={(event) => setDescription(event.target.value)} placeholder="例如：原本依赖的数据暂时拿不到，需要先找替代方案" /></label><button className="modal-primary" disabled={busy || !description.trim()} onClick={() => onSubmitNode(target.id, target.title, description.trim())}>预演受影响路径 <span>→</span></button></> : <><label>每周可投入<input type="number" min="1" max="80" value={hours} onChange={(event) => setHours(Number(event.target.value))} /><span>小时</span></label><button className="modal-primary" disabled={busy || hours <= 0} onClick={() => onSubmitHours(hours)}>看看路线会怎样变化 <span>→</span></button></>}</section></div>;
}

export function DiffPanel({ pending, before, busy, replanning, error, unchangedReplan, onApply, onReplan, onClose }: {
  pending: PendingChange;
  before: PlanState;
  busy: boolean;
  replanning: boolean;
  error: string | null;
  unchangedReplan?: UnchangedEventReplan | null;
  onApply: () => void;
  onReplan: () => void;
  onClose: () => void;
}) {
  const summary = pending.event.type === "constraint_changed" ? `${before.weeklyHours}h → ${pending.afterPreview.weeklyHours}h / 周` : pending.event.title;
  const stale = pending.patch.baseVersion !== before.version;
  const unchanged = !stale && unchangedReplan?.patchId === pending.patch.id;
  const diff = stale || unchanged ? [] : getPlanDiff(before, pending.afterPreview);
  const processing = unchanged ? unchangedReplan.processing : pending.processing;
  const model = processing?.mode === "model";
  const canReplan = pending.event.confirmed && pending.event.type === "constraint_changed" && pending.event.changes?.weeklyHours !== undefined;
  const dateChanges = diff.filter((entry) => entry.fields.some((field) => field.key === "startDate" || field.key === "endDate")).length;
  const usedEvidence = pending.afterPreview.evidence.filter((card) => processing?.usedEvidenceIds.includes(card.id));
  const kindLabel = { global: "约束", changed: "修改", added: "新增", removed: "移除", archived: "归档", relation: "关系" };
  return <section className="impact-dock" aria-label="待确认的路线变化" aria-busy={replanning}>
    <div className="impact-icon" aria-hidden="true">↯</div>
    <div className="impact-copy">
      <small>{unchanged ? "AI 排期检查" : `${model ? "AI 排期草案" : "规则预演"} · 尚未生效`}</small>
      <strong>{stale ? "这份预演已过期" : unchanged ? "当前排期已满足约束，无需调整" : summary}</strong>
      <span>{replanning ? "AI 正在检查受影响任务的排期，正式计划保持不变…" : stale ? `预演基于 v${pending.patch.baseVersion}，当前已是 v${before.version}` : unchanged ? "检查已完成，原预演已保留" : model ? `${dateChanges} 个节点的日期调整 · 等你确认` : canReplan ? "只更新约束和原因，任务日期尚未调整" : "只记录影响，尚未调整任务安排"}</span>
    </div>
    <div className="impact-actions">
      <button disabled={busy} onClick={onClose}>稍后</button>
      {canReplan && <button className="impact-replan" disabled={busy || stale} onClick={onReplan}>{replanning ? "正在排期…" : model ? "重新生成 AI 方案" : "用 AI 重新排期"}</button>}
      {!unchanged && <button disabled={busy || stale || diff.length === 0} onClick={onApply}>{model ? "确认当前方案" : canReplan ? "确认约束变更" : "确认当前记录"} →</button>}
    </div>
    {error && <p className="impact-error" role="alert">{error}</p>}
    {stale ? <p className="impact-stale">正式计划已发生变化。这份旧预演不能应用或重排；请基于当前路线重新记录事件。</p> : <details className="impact-details" key={pending.patch.id}>
      <summary>{unchanged ? "查看排期检查" : <>查看修改详情 <span>{diff.reduce((count, entry) => count + entry.fields.length, 0)} 处字段变化</span></>}</summary>
      <div className="impact-detail-scroll">
        {!unchanged && <p className="impact-review-note">以下是正式计划与当前草案的实际差异。节点存在依赖，确认时整组应用；展开查看不会修改计划。</p>}
        {processing && <div className="impact-processing">
          <p>{processing.summary}</p>
          <details className="research-details">
            <summary>{processing.researchNeeded ? "需要补充研究" : "本次无需重新检索"} · 查看判断依据{processing.warnings.length > 0 ? `与 ${processing.warnings.length} 条提醒` : ""}</summary>
            <p>{processing.researchReason}</p>
            {processing.warnings.length > 0 && <ul>{processing.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
            <EvidenceDisclosure label="查看使用的既有证据" evidence={usedEvidence} />
          </details>
        </div>}
        {!unchanged && diff.length === 0 && <p className="impact-review-note">当前草案没有实际字段变化，无需应用。</p>}
        {diff.map((entry) => <article className="impact-change" key={entry.id}>
          <h3><span>{kindLabel[entry.kind]}</span>{entry.title}</h3>
          <dl>{entry.fields.map((field) => <div className="impact-field" key={field.key}>
            <dt>{field.label}</dt>
            <dd><span className="impact-before"><small>当前</small>{field.before}</span><span className="impact-arrow" aria-hidden="true">→</span><span className="impact-after"><small>确认后</small>{field.after}</span></dd>
          </div>)}</dl>
        </article>)}
      </div>
    </details>}
  </section>;
}

function buildGraphPoints(tasks: PlanNode[], milestones: PlanNode[]): GraphPoint[] {
  const yPattern = [390, 200, 480, 290, 480, 200];
  const start = milestones.map((item) => item.startDate).filter((value): value is string => Boolean(value)).sort()[0];
  const end = milestones.map((item) => item.endDate).filter((value): value is string => Boolean(value)).sort().at(-1);
  const fallbackSpan = tasks.length > 1 ? 870 / (tasks.length - 1) : 0;
  return tasks.map((task, index) => ({
    id: task.id,
    x: start && end ? positionDateInRange(task.startDate, start, end, 145, 1040) ?? 165 + fallbackSpan * index : 165 + fallbackSpan * index,
    y: yPattern[index % yPattern.length] ?? 330,
  }));
}

function buildTimelineScale(milestones: PlanNode[]): TimelineScale | null {
  const start = milestones.map(node => node.startDate).filter((value): value is string => Boolean(value)).sort()[0];
  const end = milestones.map(node => node.endDate).filter((value): value is string => Boolean(value)).sort().at(-1);
  if (!start || !end || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) return null;
  return { start: Date.parse(start), end: Math.max(Date.parse(start) + 86_400_000, Date.parse(end)), left: 145, right: 1040 };
}

function buildDenseGraphLayout(tasks: PlanNode[], milestones: PlanNode[]): { width: number; points: GraphPoint[]; timeline: TimelineScale | null } {
  const dayOf = (date: string | undefined) => date ? Date.parse(date) / 86_400_000 : NaN;
  const dates = [...tasks, ...milestones].flatMap((node) => [dayOf(node.startDate), dayOf(node.endDate)]).filter(Number.isFinite);
  const start = dates.length ? Math.min(...dates) : 0;
  const end = dates.length ? Math.max(start + 1, ...dates) : tasks.length;
  const byDate = new Map<number, PlanNode[]>();
  tasks.forEach((task, index) => {
    const date = dayOf(task.startDate);
    const day = Number.isFinite(date) ? date : start + (end - start) * index / Math.max(1, tasks.length - 1);
    byDate.set(day, [...(byDate.get(day) ?? []), task]);
  });
  const days = [...byDate.keys()].sort((a, b) => a - b);
  const gaps = days.slice(1).map((day, index) => day - days[index]!);
  const columnsPerDate = Math.max(...[...byDate.values()].map((group) => Math.ceil(group.length / 4)));
  const columnGap = 230;
  const pixelsPerDay = columnsPerDate * columnGap / (gaps.length ? Math.min(...gaps) : end - start);
  const width = Math.max(canvasWidth, Math.ceil(tasks.length / 4) * columnGap + 320, (end - start) * pixelsPerDay + 320 + (columnsPerDate - 1) * columnGap);
  const laneY = [170, 300, 430, 560];
  let taskIndex = 0;
  const points = days.flatMap((day) => byDate.get(day)!.map((task, index) => ({
    id: task.id,
    x: 145 + (day - start) * pixelsPerDay + Math.floor(index / 4) * columnGap,
    y: laneY[taskIndex++ % 4]!,
  })));
  return { width, points, timeline: dates.length ? { start: start * 86_400_000, end: end * 86_400_000, left: 145, right: 145 + (end - start) * pixelsPerDay } : null };
}

function smoothPath(points: Array<Pick<GraphPoint, "x" | "y">>): string {
  if (points.length === 0) return ""; let path = `M ${points[0]?.x ?? 0} ${points[0]?.y ?? 0}`;
  for (let index = 1; index < points.length; index += 1) { const previous = points[index - 1]; const current = points[index]; if (!previous || !current) continue; const middleX = (previous.x + current.x) / 2; path += ` C ${middleX} ${previous.y}, ${middleX} ${current.y}, ${current.x} ${current.y}`; }
  return path;
}

function beginNodePointerDrag(event: ReactPointerEvent<HTMLButtonElement>, id: string, setDragging: (value: NodeDragState) => void): void {
  if (event.button !== 0) return;
  event.stopPropagation();
  event.currentTarget.setPointerCapture(event.pointerId);
  setDragging({ id, pointerId: event.pointerId, startX: event.clientX, currentX: event.clientX, weeks: 0 });
}

function moveNodePointerDrag(event: ReactPointerEvent<HTMLButtonElement>, dragging: NodeDragState | null, setDragging: (value: NodeDragState | null) => void): void {
  if (!dragging || dragging.pointerId !== event.pointerId) return;
  const distance = event.clientX - dragging.startX;
  setDragging({ ...dragging, currentX: event.clientX, weeks: weeksFromDragDistance(distance) });
}

function endNodePointerDrag(event: ReactPointerEvent<HTMLButtonElement>, task: PlanNode, dragging: NodeDragState | null, setDragging: (value: null) => void, suppressClick: { current: boolean }, onReschedule: (node: PlanNode, weeks: number) => void): void {
  if (!dragging || dragging.pointerId !== event.pointerId) return;
  event.stopPropagation();
  event.currentTarget.releasePointerCapture(event.pointerId);
  const weeks = weeksFromDragDistance(event.clientX - dragging.startX);
  setDragging(null);
  if (weeks === 0) return;
  suppressClick.current = true;
  window.setTimeout(() => { suppressClick.current = false; }, 0);
  onReschedule(task, weeks);
}

function beginCanvasPan(event: ReactPointerEvent<HTMLElement>, pan: PanOffset, setPanning: (value: CanvasPanState) => void): void {
  if (event.button !== 0 || (event.target as Element).closest("button")) return;
  event.currentTarget.setPointerCapture(event.pointerId);
  setPanning({ pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: pan.x, originY: pan.y });
}

function moveCanvasPan(event: ReactPointerEvent<HTMLElement>, panning: CanvasPanState | null, setPan: (value: PanOffset) => void, canvas?: { width: number; height: number }): void {
  if (!panning || panning.pointerId !== event.pointerId) return;
  const minX = canvas ? Math.min(0, event.currentTarget.clientWidth - canvas.width - 60) : -320;
  const minY = canvas ? Math.min(-120, event.currentTarget.clientHeight - canvas.height - 100) : -120;
  setPan({
    x: Math.max(minX, Math.min(canvas ? 60 : 320, panning.originX + event.clientX - panning.startX)),
    y: Math.max(minY, Math.min(120, panning.originY + event.clientY - panning.startY)),
  });
}

function endCanvasPan(event: ReactPointerEvent<HTMLElement>, panning: { pointerId: number } | null, setPanning: (value: null) => void): void {
  if (!panning || panning.pointerId !== event.pointerId) return;
  event.currentTarget.releasePointerCapture(event.pointerId);
  setPanning(null);
}

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } }); const body: unknown = await response.json();
  if (!response.ok) throw new Error(formatApiError(body, response.status)); return body as T;
}

function statusLabel(status: PlanNode["status"]): string { return { draft: "草稿", todo: "等待探索", ready: "下一站", in_progress: "正在前往", blocked: "前方受阻", done: "已经抵达", archived: "已收起" }[status]; }
function nodeTypeLabel(type: PlanNode["type"]): string { return { task: "路标", milestone: "里程碑", checkpoint: "复盘", assumption: "假设", decision: "决策" }[type]; }
function contentTypeLabel(contentType: EvidenceCard["contentType"]): string { return { user_fact: "用户事实", advice: "建议", experience: "经验", opinion: "观点", factual_claim: "事实主张", rule: "规则", ai_inference: "AI 推断" }[contentType]; }
function formatDateRange(node: PlanNode): string { return node.startDate && node.endDate ? `${node.startDate.slice(5)} → ${node.endDate.slice(5)}` : "待安排"; }
function toMessage(error: unknown): string { return error instanceof Error ? error.message : "未知错误"; }
