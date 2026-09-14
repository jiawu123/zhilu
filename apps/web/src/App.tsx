import { trackedFetch, useRequestProgress } from "./request-progress";
import { WaitStatus } from "./WaitStatus";
import { RoadmapChat } from "./RoadmapChat";
import { useEffect, useRef, useState, type CSSProperties } from "react";
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
import { shiftIsoDate } from "./roadmap-date";
import { getWeekFocusTasks, weekFocusTitle } from "./roadmap-focus";
import { getPlanDiff } from "./plan-diff";
import { selectCurrentPending } from "./pending-selection";
import { formatApiError } from "./api-error";
import { Onboarding } from "./Onboarding";
import { readFlowPage, resolveFlowPage, type FlowPage } from "./onboarding-model";
import { InsufficientEvidenceNotice, InsufficientSourcesDisclosure } from "./ResearchEvidence";
import { WeeklyOverrunNotice } from "./WeeklyOverrunNotice";
import { TaskDeadline } from "./RoadmapTimeline";
import { RoadmapBoard } from "./RoadmapBoard";
import { ModalSurface, ConfirmDialog } from "./ModalSurface";
import { Brand } from "./Brand";
import { globalChangeContext, type ChangeContext } from "./ChangeComposer";
import { ErrorNotice } from "./ErrorNotice";
import { draftFromNode, nodeEdits, type NodeDraft } from "./node-edits";

const demoProjectId = "agent-engineer-demo";
const initialProjectId = new URLSearchParams(window.location.search).get("project") ?? demoProjectId;

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

export function App({ interviewStorageKey = "zhilu-interview:local", onOpenHistory }: { interviewStorageKey?: string; onOpenHistory?: () => void }) {
  const [activeProjectId, setActiveProjectId] = useState(initialProjectId);
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [archivingNode, setArchivingNode] = useState<PlanNode | null>(null);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [hoursDialog, setHoursDialog] = useState(false);
  const [changeContext, setChangeContext] = useState<ChangeContext>(globalChangeContext);
  const openChange = (context: ChangeContext) => { setSelectedId(null); setError(null); setChangeContext({ ...context, focusKey: Date.now() }); };
  useEffect(() => { setChangeContext(globalChangeContext); }, [activeProjectId]);
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

  const updateNode = async (nodeId: string, changes: PlanNodeUpdate) => {
    if (!Object.keys(changes).length) return;
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
    const changes: PlanNodeUpdate = { adjustmentReason: `在路线流程图中拖动，${weeks > 0 ? "顺延" : "提前"} ${Math.abs(weeks)} 周` };
    if (node.startDate) changes.startDate = shiftIsoDate(node.startDate, weeks * 7);
    if (node.endDate) changes.endDate = shiftIsoDate(node.endDate, weeks * 7);
    await updateNode(node.id, changes);
  };

  const addTask = async (title: string) => {
    if (!title.trim() || !workspace || busy) return;
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
      setAddingTask(false);
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
      setHoursDialog(false);
      setSelectedId(null);
      setError(null);
    } catch (requestError) {
      setError(toMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const archiveNode = async (node: PlanNode) => {
    setBusy(true);
    try {
      await api(`/api/projects/${activeProjectId}/nodes/${node.id}`, { method: "DELETE" });
      setArchivingNode(null);
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
      setPendingError(`AI 排期未完成，原变更预览已保留。${toMessage(requestError)}`);
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
      sessionStorage.removeItem(interviewStorageKey);
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

  if (page === "interview") return <Onboarding storageKey={interviewStorageKey} busy={busy} error={error}
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
        <Brand />
        <p>{error ?? "正在加载项目计划"}</p>
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
        <button className="brand-toggle" onClick={() => setSidebarOpen(true)} aria-label="打开计划菜单"><Brand /></button>
        <nav className="workspace-nav" aria-label="项目导航"><span aria-current="page">任务流程</span><button onClick={() => setSidebarOpen(true)}>项目信息</button></nav>
        <div className="workspace-project"><small>{researchPending ? "待研究" : workspace.plan.research?.mode === "mock" ? "演示计划" : workspace.plan.research?.roadmapper?.evidenceStatus === "insufficient" ? "证据待补充" : "项目计划"}</small><strong title={workspace.plan.goal}>{workspace.plan.goal}</strong></div>
        <span className="workspace-progress">完成率 <strong>{progress}%</strong></span>
        <button className="header-add-task" disabled={busy} onClick={() => { setError(null); setAddingTask(true); }}>＋ 新增任务</button>
      </header>
      <RoadmapBoard plan={workspace.plan} selectedId={selectedId} focusId={focusTasks[0]?.id ?? null} affectedIds={pending?.impact.affectedNodeIds ?? []} busy={busy} onSelect={setSelectedId} onReschedule={(node, weeks) => void rescheduleNode(node, weeks)} onChange={openChange} />
      <RoadmapChat key={activeProjectId} plan={workspace.plan} onApplied={load} context={changeContext} onResetContext={() => openChange(globalChangeContext)} onEditHours={() => { setError(null); setHoursDialog(true); }} externalBusy={busy} externalError={!hoursDialog && !addingTask && !archivingNode && !selectedNode ? error : null} />
      <div className="canvas-hint">滚动查看任务流程 · 点击任务查看详情</div>
      <div className="commit-whisper">版本 {workspace.plan.currentCommitId}</div>

      <Sidebar
        open={sidebarOpen}
        plan={workspace.plan}
        projectId={activeProjectId}
        history={workspace.history}
        onOpenHistory={onOpenHistory ? () => { setSidebarOpen(false); onOpenHistory(); } : undefined}
        focusTasks={focusTasks}
        pendingCount={pending ? 1 : 0}
        busy={busy}
        onClose={() => setSidebarOpen(false)}
        onAddTask={() => { setError(null); setAddingTask(true); }}
        onNewProject={() => { setSidebarOpen(false); setError(null); navigate("interview"); }}
        onSelectTask={(id) => { setSidebarOpen(false); setSelectedId(id); }}
      />

      <Inspector
        node={selectedNode}
        error={error}
        busy={busy}
        onClose={() => setSelectedId(null)}
        onSave={(changes) => selectedNode && void updateNode(selectedNode.id, changes)}
        onComplete={() => selectedNode && void updateNode(selectedNode.id, { status: "done", adjustmentReason: "用户在任务流程图中标记完成" })}
        onReportChange={() => selectedNode && openChange({ kind: "task", label: selectedNode.title, nodeIds: [selectedNode.id] })}
        onArchive={() => { setError(null); setArchivingNode(selectedNode); }}
      />

      {addingTask && <NewTaskDialog busy={busy} error={error} onClose={() => setAddingTask(false)} onSubmit={title => void addTask(title)} />}
      {archivingNode && <ConfirmDialog title="归档任务？" description={`确认归档“${archivingNode.title}”。归档后将从当前视图移除，相关记录保留在版本历史中。`} confirmLabel="确认归档" busy={busy} onCancel={() => setArchivingNode(null)} onConfirm={() => void archiveNode(archivingNode)}>{error && <ErrorNotice message={error} />}</ConfirmDialog>}
      {hoursDialog && <EventDialog error={error} currentHours={workspace.plan.weeklyHours} busy={busy} onClose={() => { setHoursDialog(false); setError(null); }} onSubmitHours={(hours) => void submitHoursEvent(hours)} />}
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
  const requests = useRequestProgress();
  const progress = requests.filter(item => item.path.includes("/baseline")).at(-1);
  const applying = busy && progress?.path.endsWith("/baseline/apply");
  const pageRef = useRef<HTMLElement>(null);
  const hasProposal = Boolean(proposal);
  useEffect(() => { pageRef.current?.scrollTo(0, 0); }, [hasProposal]);
  useEffect(() => { setMessage(""); }, [proposal?.id]);
  if (!proposal) {
    return <main ref={pageRef} className="flow-page plan-page"><section className="research-intro" aria-labelledby="research-title">
      <button className="research-close" disabled={busy} onClick={onClose}>返回背景资料</button>
      <Brand />
      <p className="section-kicker">02 · 生成计划草稿</p>
      <h2 id="research-title">研究依据与计划编制</h2>
      <p>根据已确认的目标与背景检索相关依据，形成候选方案及任务安排。请审阅方案内容后确认应用。</p>
      <div className="research-steps"><span><b>01</b>明确研究问题</span><span><b>02</b>检索与整理依据</span><span><b>03</b>确认并生成计划</span></div>
      {error && <ErrorNotice message={error} />}
      {busy && <div className="inline-operation-status"><WaitStatus label="正在准备研究与计划生成" progress={progress} /></div>}
      <button className="research-primary" disabled={busy} onClick={onRunLive}>{busy ? "正在生成研究方案" : "生成研究方案"}<span>→</span></button>
      <button className="research-secondary" disabled={busy} onClick={onRunMock}>查看演示方案</button>
    </section></main>;
  }
  const isLive = proposal.researchRun.mode === "live";
  const roadmapper = proposal.roadmapper;
  const insufficient = isLive && roadmapper?.evidenceStatus === "insufficient";
  const insufficientSources = proposal.researchRun.evidencePacks.flatMap(pack => pack.insufficientSources ?? []);
  const route = proposal.researchRun.routeCandidates.find((item) => item.id === selectedRouteId) ?? proposal.researchRun.routeCandidates[0];
  const preview = proposal.previews.find((item) => item.routeId === route?.id)?.plan;
  const previewAssumptions = preview?.nodes.filter((node) => node.type === "assumption") ?? [];
  const researchEvidence = [...new Map(proposal.researchRun.evidencePacks.flatMap((pack) => pack.evidence).map((card) => [card.id, card])).values()];
  const recommendationEvidence = researchEvidence.filter((card) => roadmapper?.recommendationEvidenceIds.includes(card.id));
  const routeEvidence = researchEvidence.filter((card) => route?.evidenceIds.includes(card.id));
  const queryCount = proposal.researchRun.questions.reduce((sum, question) => sum + question.searchQueries.length, 0);
  return (
    <main ref={pageRef} className="flow-page plan-page">
      <section className="route-lab" aria-labelledby="route-lab-title">
        <button className="research-close" disabled={busy} onClick={onClose}>返回背景资料</button>
        <header>
          <div>
            <Brand /><p className="section-kicker">{roadmapper ? "模型路线草案" : isLive ? "规则路线草案" : "演示路线草案"} · 尚未写入</p>
            <h2 id="route-lab-title">候选方案审阅</h2>
          </div>
          <div className="research-metrics">
            <span><b>{proposal.researchRun.questions.length}</b>问题</span>
            <span><b>{queryCount}</b>检索词</span>
            <span><b>{researchEvidence.length}</b>{isLive ? "知乎证据" : "演示证据"}</span>
          </div>
          {error && <ErrorNotice message={error} />}
        </header>
        {insufficient && <InsufficientEvidenceNotice />}
        <InsufficientSourcesDisclosure sources={insufficientSources} showEmpty={insufficient && !researchEvidence.some(card => card.sourceType === "zhihu")} />
        <div className="route-lab-grid">
          <section className="route-choice">
            <p className="section-kicker">选择方案</p>
            {roadmapper && (
              <div className="route-recommendation">
                <small>推荐依据</small>
                <p>{roadmapper.recommendationReason}</p>
                <EvidenceDisclosure label="查看推荐依据" evidence={recommendationEvidence} />
              </div>
            )}
            {proposal.researchRun.routeCandidates.map((candidate) => (
              <button key={candidate.id} aria-pressed={candidate.id === route?.id} className={candidate.id === route?.id ? "is-selected" : ""} disabled={busy} onClick={() => onSelectRoute(candidate.id)}>
                <span className="route-radio" />
                <div>
                  <small>{candidate.id === proposal.recommendedRouteId ? "推荐方案" : "备选方案"}</small>
                  <h3>{candidate.title === "先做出来" ? "成果导向方案" : candidate.title === "先练基本功" ? "能力建设方案" : candidate.title}</h3>
                  <p>{candidate.summary}</p>
                  <em>适合：{candidate.applicableWhen.join(" · ")}</em>
                </div>
              </button>
            ))}
            {route && (
              <div className="selected-route-details" key={route.id}>
                {route.risks.length > 0 && (
                  <details className="research-details planning-warnings">
                    <summary>方案风险与取舍：{route.risks.length} 项</summary>
                    <ul>{route.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul>
                  </details>
                )}
                <EvidenceDisclosure label="查看方案原始依据" evidence={routeEvidence} />
                {preview && <EvidenceApplications applications={roadmapper?.evidenceApplications} routeId={route.id}
                  evidence={preview.evidence} nodes={preview.nodes} />}
              </div>
            )}
          </section>
          <section className="preview-rail" key={route?.id}>
            <p className="section-kicker">计划内容</p>
            <WeeklyOverrunNotice overruns={roadmapper?.weeklyOverruns} routeId={route?.id} />
            {roadmapper && <p className="preview-note">任务拆分、日期与工时是 AI 推断，确认后仍可在任务详情中调整。</p>}
            {preview?.nodes.filter((node) => node.type === "task").map((node, index) => (
              <article className="preview-task" key={node.id}>
                <span>{index + 1}</span>
                <div>
                  <strong>{node.title}</strong>
                  <small>{formatDateRange(node)} · {node.estimatedHours ?? "—"}h</small>
                  <TaskDeadline task={node} />
                  {roadmapper && !preview.evidence.some(card => card.sourceType === "zhihu" && node.evidenceIds.includes(card.id))
                    && <p className="inference-note">AI规划／待验证：该任务尚无直接采用的知乎依据。</p>}
                  <details className="research-details">
                    <summary>产出、验收与依据</summary>
                    {node.deliverable && <p>{node.deliverable}</p>}
                    <ul>{node.acceptanceCriteria?.map((item, criterionIndex) => <li key={criterionIndex}>{item}</li>)}</ul>
                    <EvidenceDisclosure label="查看任务依据" evidence={preview.evidence.filter((card) => node.evidenceIds.includes(card.id))} />
                  </details>
                </div>
              </article>
            ))}
            {previewAssumptions.length > 0 && (
              <details className="research-details review-preview">
                <summary>待确认假设 · {previewAssumptions.length}</summary>
                {previewAssumptions.map((node) => (
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
            <h3>计划调整意见</h3>
            <p>请填写调整事项及理由。调整结果以草案形式呈现，经确认后应用。</p>
            <div className="plan-messages" aria-live="polite">
              {(proposal.conversation ?? []).map((entry, index) => <article key={index} className={`message-${entry.role}`}><small>{entry.role === "user" ? "提交人" : "知路"}</small><p>{entry.content}</p></article>)}
              {busy && <div className="inline-operation-status"><WaitStatus label="正在处理调整意见" progress={progress} /></div>}
            </div>
            <form onSubmit={event => { event.preventDefault(); if (message.trim() && !busy) onRevise(message.trim()); }}>
              <label htmlFor="plan-adjustment">调整意见</label>
              <textarea id="plan-adjustment" maxLength={2000} value={message} disabled={busy || !isLive} onChange={event => setMessage(event.target.value)} placeholder="例如：前两周优先安排实践任务，并减少理论学习时数。" />
              <button className="research-primary" type="submit" disabled={busy || !isLive || !message.trim()}>发送并调整草稿</button>
            </form>
            <div className="plan-confirm-action"><button className="research-primary" disabled={busy || !selectedRouteId} onClick={onApply}>{applying ? "正在保存计划" : "确认当前方案"}</button><small>{busy && !applying ? "调整完成后可确认最新草稿。" : "应用当前草稿并进入任务流程，无需重新生成。"}</small></div>
            {!isLive && <small>演示草稿无法调用真实模型调整，请先生成知乎计划。</small>}
            <details className="research-details"><summary>查看研究问题与待确认点</summary>
              {proposal.researchRun.questions.map(question => <p key={question.question}>{question.question}</p>)}
              {roadmapper?.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
            </details>
          </aside>
        </div>
        <footer>
          <div><span className="route-proof-dot" /><small>{isLive ? insufficient ? "证据不足：当前暂定计划由模型推断，确认前请核实关键安排。" : "知乎内容提供依据；路线安排仍需结合实际情况确认。" : "演示方案仅用于功能展示，未经真实研究验证。"}</small></div>
          <button className="research-primary" disabled={busy || !selectedRouteId} onClick={onApply}>{applying ? "正在保存计划" : "确认并应用方案"}<span>→</span></button>
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
      <div><span>{{ zhihu: "知乎", ai: "AI 推断", user: "用户提供", official: "官方来源", engine: "计划规则" }[card.sourceType]}</span><small>{contentTypeLabel(card.contentType)} · {{ verified: "已核实", unverified: "尚未核实", not_applicable: "无需核实" }[card.verificationStatus]}</small></div>
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

export function Sidebar({ open, plan, projectId, history, focusTasks, pendingCount, busy, onClose, onAddTask, onNewProject, onSelectTask, onOpenHistory }: { open: boolean; plan: PlanState; projectId: string; history: PlanCommit[]; focusTasks: PlanNode[]; pendingCount: number; busy: boolean; onClose: () => void; onAddTask: () => void; onNewProject: () => void; onSelectTask: (id: string) => void; onOpenHistory?: (() => void) | undefined }) {
  const [showAllHistory, setShowAllHistory] = useState(false);
  useEffect(() => { setShowAllHistory(false); }, [projectId]);
  const tasks = plan.nodes.filter((node) => node.type === "task" && node.status !== "archived");
  const done = tasks.filter((task) => task.status === "done").length;
  return (
    <ModalSurface open={open} label="项目信息" busy={busy} onClose={onClose}><aside className="side-drawer is-open">
      <div className="drawer-head"><div><Brand /><strong>项目信息</strong></div><button data-initial-focus disabled={busy} aria-label="关闭计划菜单" onClick={onClose}>×</button></div>
      <div className="drawer-scroll">
        <section className="drawer-goal"><small>项目目标</small><p>{plan.goal}</p></section>
        <section className="progress-card"><div className="progress-ring" style={{ "--progress": `${tasks.length ? (done / tasks.length) * 360 : 0}deg` } as CSSProperties}><span>{done}/{tasks.length}</span></div><div><strong>{plan.weeklyHours} 小时</strong><small>每周投入时间</small></div></section>
        {pendingCount > 0 && <div className="pending-callout"><span aria-hidden="true">○</span><div><strong>{pendingCount} 项变更待确认</strong><small>变更尚未应用于正式计划</small></div></div>}
        <section className="week-focus"><p className="section-kicker">{weekFocusTitle(focusTasks, new Date().toISOString().slice(0, 10))}</p>{focusTasks.length === 0 ? <div className="focus-empty">未来七日暂无待办任务。</div> : focusTasks.map((task, index) => <button key={task.id} onClick={() => onSelectTask(task.id)}><span>{index === 0 ? "待执行" : formatDateRange(task)}</span><strong>{task.title}</strong><small>{task.estimatedHours ?? "—"}h · {statusLabel(task.status)}</small><TaskDeadline task={task} /></button>)}</section>
        {onOpenHistory && <button className="account-history-trigger" onClick={onOpenHistory}>账号历史记录</button>}
        <section className="export-panel"><p className="section-kicker">导出项目资料</p><div><a href={`/api/projects/${projectId}/export/json`} download>结构化数据（JSON）</a><a href={`/api/projects/${projectId}/export/markdown`} download>可读文档（Markdown）</a><a href={`/api/projects/${projectId}/export/zip`} download>完整计划包（ZIP）</a></div></section>
        <section className="drawer-history"><p className="section-kicker">版本历史 · 共 {history.length} 个版本</p>{(showAllHistory ? history : history.slice(0, 5)).map((commit) => <div className="history-step" key={commit.id}>
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
        </div>)}{history.length > 5 && <button className="history-toggle" aria-expanded={showAllHistory} onClick={() => setShowAllHistory(value => !value)}>{showAllHistory ? "收起较早版本" : `查看全部 ${history.length} 个版本`}</button>}</section>
      </div>
      <div className="drawer-actions"><button disabled={busy} onClick={onNewProject}>创建项目</button><button disabled={busy} onClick={onAddTask}>新增任务</button></div>
    </aside></ModalSurface>
  );
}

export function Inspector({ node, busy, error, onClose, onSave, onComplete, onReportChange, onArchive }: { node: PlanNode | null; plan?: PlanState; evidence?: EvidenceCard[]; busy: boolean; error?: string | null; onClose: () => void; onSave: (changes: PlanNodeUpdate) => void; onComplete: () => void; onReportChange?: () => void; onArchive: () => void }) {
  const [draft, setDraft] = useState<NodeDraft>(() => node ? draftFromNode(node) : { title: "", startDate: "", endDate: "", status: "todo" });
  const [discarding, setDiscarding] = useState(false);
  useEffect(() => { if (node) setDraft(draftFromNode(node)); setDiscarding(false); }, [node]);
  const changes = node ? nodeEdits(node, draft) : {};
  const dirty = Object.keys(changes).length > 0;
  const close = () => { if (!busy) { if (dirty) setDiscarding(true); else onClose(); } };
  return (
    <ModalSurface open={Boolean(node)} label="任务详情" busy={busy} onClose={close}>
    <aside className="inspector-drawer is-open">
      {node && <><div className="drawer-head"><div><span className="node-mini-dot" /><strong>{nodeTypeLabel(node.type)}详情</strong></div><button data-initial-focus disabled={busy} aria-label="关闭任务详情" onClick={close}>×</button></div>
        <div className="inspector-scroll">
          <div className="status-row"><span className={`status-chip status-${node.status}`}>{statusLabel(node.status)}</span><span>{node.estimatedHours ? `${node.estimatedHours}h` : nodeTypeLabel(node.type)}</span></div>
          {error && <ErrorNotice message={error} />}
          <form className="node-edit-form" onSubmit={event => { event.preventDefault(); if (!busy && dirty) onSave(changes); }}>
            <fieldset disabled={busy}>
              <label>名称<input required maxLength={2000} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
              <div className="date-row"><label>开始日期<input type="date" required={node.type === "task" || Boolean(node.startDate)} max={draft.endDate || undefined} value={draft.startDate} onChange={event => setDraft({ ...draft, startDate: event.target.value })} /></label>
                <label>截止日期<input type="date" required={node.type === "task" || Boolean(node.endDate)} min={draft.startDate || undefined} value={draft.endDate} onChange={event => setDraft({ ...draft, endDate: event.target.value })} /></label></div>
              <label>状态<select value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value as PlanNode["status"] })}><option value="draft">草稿</option><option value="todo">待开始</option><option value="ready">可开始</option><option value="in_progress">进行中</option><option value="blocked">受阻</option><option value="done">已完成</option><option value="archived">已归档</option></select></label>
              <p className="edit-save-hint" role="status">{dirty ? "存在未保存的修改。名称、日期和状态将统一保存。" : "修改名称、日期或状态后，点击保存修改。"}</p>
              <div className="node-actions"><button className="save-node" type="submit" disabled={busy || !dirty || !draft.title.trim()}>保存修改</button>{node.type === "task" && node.status !== "done" && <button className="complete-node" type="button" disabled={busy || dirty} onClick={onComplete}>标记完成</button>}</div>
            </fieldset>
          </form>
          {node.type === "task" && <div className="node-secondary-actions">{onReportChange && <button disabled={busy || dirty} onClick={onReportChange}>记录任务变更</button>}<button className="archive-node" disabled={busy || dirty} onClick={onArchive}>归档任务</button></div>}
          {dirty && <p className="edit-save-hint">请先保存修改，再标记完成、记录变更或归档任务。</p>}
          <section className="node-story"><p className="section-kicker">交付要求与验收标准</p><h3>{node.deliverable ?? "待补充可检查的产出"}</h3>{node.description && <p className="inference-note">{node.description}</p>}<ul>{node.acceptanceCriteria?.map((item) => <li key={item}>{item}</li>) ?? <li>尚未补充完成标准</li>}</ul></section>
        </div></>}
    </aside>
    {discarding && <ConfirmDialog title="放弃未保存的修改？" description="名称、日期和状态的修改尚未保存。取消可继续编辑。" confirmLabel="放弃修改" onCancel={() => setDiscarding(false)} onConfirm={() => { setDiscarding(false); onClose(); }} />}
    </ModalSurface>
  );
}

function NewTaskDialog({ busy, error, onClose, onSubmit }: { busy: boolean; error: string | null; onClose: () => void; onSubmit: (title: string) => void }) {
  const [title, setTitle] = useState("");
  return <ModalSurface label="添加新任务" busy={busy} onClose={onClose}><section className="event-modal">
    <button className="modal-close" disabled={busy} aria-label="关闭新任务" onClick={onClose}>×</button>
    <h2>添加新任务</h2><p>填写任务名称。创建后可编辑日期、状态及其他信息。</p>
    <form onSubmit={event => { event.preventDefault(); if (!busy && title.trim()) onSubmit(title.trim()); }}>
      <label className="event-note-label">任务名称<input data-initial-focus required maxLength={2000} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} placeholder="请输入任务名称" /></label>
      {error && <ErrorNotice message={error} />}
      <div className="confirm-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="research-primary" disabled={busy || !title.trim()}>{busy ? "正在创建" : "创建任务"}</button></div>
    </form>
  </section></ModalSurface>;
}

function EventDialog({ busy, error, currentHours, onClose, onSubmitHours }: { busy: boolean; error: string | null; currentHours: number; onClose: () => void; onSubmitHours: (hours: number) => void }) {
  const [hours, setHours] = useState(currentHours);
  return <ModalSurface label="调整时间约束" busy={busy} onClose={onClose}><form className="event-modal" onSubmit={event => { event.preventDefault(); if (!busy && Number.isFinite(hours) && hours >= 1 && hours <= 80) onSubmitHours(hours); }}>
    <button type="button" className="modal-close" aria-label="关闭时间约束" disabled={busy} onClick={onClose}>×</button><h2>调整时间约束</h2><p>更新每周可投入时间。请核对变更预览后确认应用。</p>
    <label>每周投入时间<input data-initial-focus required disabled={busy} type="number" min="1" max="80" step="0.5" value={Number.isFinite(hours) ? hours : ""} onChange={event => setHours(event.target.valueAsNumber)} /><span>小时</span></label>
    {error && <ErrorNotice message={error} />}<button className="research-primary" disabled={busy || !Number.isFinite(hours) || hours < 1 || hours > 80} type="submit">{busy ? "正在处理" : "生成变更预览"}</button>
  </form></ModalSurface>;
}

export function DiffPanel({ pending, before, busy, replanning, error, unchangedReplan, onApply, onReplan, onClose, replanAvailable = true }: {
  pending: PendingChange;
  before: PlanState;
  busy: boolean;
  replanning: boolean;
  replanAvailable?: boolean;
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
  const recordOnly = !stale && !unchanged && pending.event.confirmed && pending.event.type === "custom" && pending.patch.operations.length === 0 && diff.length === 0;
  const processing = unchanged ? unchangedReplan.processing : pending.processing;
  const model = processing?.mode === "model";
  const canReplan = pending.event.confirmed && pending.event.type === "constraint_changed" && pending.event.changes?.weeklyHours !== undefined;
  const dateChanges = diff.filter((entry) => entry.fields.some((field) => field.key === "startDate" || field.key === "endDate")).length;
  const usedEvidence = pending.afterPreview.evidence.filter((card) => processing?.usedEvidenceIds.includes(card.id));
  const kindLabel = { global: "约束", changed: "修改", added: "新增", removed: "移除", archived: "归档", relation: "关系" };
  return <section className="impact-dock" aria-label="待确认的计划变更" aria-busy={replanning}>

    <div className="impact-copy">
      <small>{unchanged ? "AI 排期检查" : `${model ? "AI 排期草案" : "变更预览"} · 尚未生效`}</small>
      <strong>{stale ? "变更预览已失效" : unchanged ? "当前排期已满足约束，无需调整" : summary}</strong>
      <span>{replanning ? "AI 正在检查受影响任务的排期，正式计划保持不变…" : stale ? `预览基于 v${pending.patch.baseVersion}，当前已是 v${before.version}` : unchanged ? "检查已完成，原变更预览已保留" : model ? `${dateChanges} 个节点的日期调整 · 待确认` : canReplan ? "只更新约束和原因，任务日期尚未调整" : "只记录影响，尚未调整任务安排"}</span>
    </div>
    <div className="impact-actions">
      <button disabled={busy} onClick={onClose}>关闭预览</button>
      {canReplan && <button className="impact-replan" disabled={busy || stale || !replanAvailable} onClick={onReplan}>{replanning ? "正在排期…" : model ? "重新生成 AI 方案" : "生成调整方案"}</button>}
      {!unchanged && <button disabled={busy || stale || (diff.length === 0 && !recordOnly)} onClick={onApply}>{model ? "确认当前方案" : canReplan ? "确认约束变更" : "确认变更记录"}</button>}
    </div>
    {error && <ErrorNotice message={error} className="impact-error" />}
    {canReplan && !replanAvailable && <p className="impact-record-only">AI 排期尚未配置或开启。可以先确认每周时间约束；任务日期不会自动调整。</p>}
    {recordOnly && <p className="impact-record-only">确认后仅新增一条历史记录，原任务和手动设置不变：{pending.event.description}</p>}
    {stale ? <p className="impact-stale">正式计划版本已更新，当前预览无法应用或重排。请基于最新计划重新提交变更。</p> : <details className="impact-details" key={pending.patch.id}>
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
        {!unchanged && diff.length === 0 && <p className="impact-review-note">{recordOnly ? "本条变更仅记录情况说明；确认后可在版本历史中查看。" : "当前草案无字段变更，无需应用。"}</p>}
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

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await trackedFetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } }); const body: unknown = await response.json();
  if (!response.ok) throw new Error(formatApiError(body, response.status)); return body as T;
}

function statusLabel(status: PlanNode["status"]): string { return { draft: "草稿", todo: "未开始", ready: "待执行", in_progress: "进行中", blocked: "受阻", done: "已完成", archived: "已归档" }[status]; }
function nodeTypeLabel(type: PlanNode["type"]): string { return { task: "任务", milestone: "里程碑", checkpoint: "复盘", assumption: "假设", decision: "决策" }[type]; }
function contentTypeLabel(contentType: EvidenceCard["contentType"]): string { return { user_fact: "用户事实", advice: "建议", experience: "经验", opinion: "观点", factual_claim: "事实主张", rule: "规则", ai_inference: "AI 推断" }[contentType]; }
function formatDateRange(node: PlanNode): string { return node.startDate && node.endDate ? `${node.startDate.slice(5)} → ${node.endDate.slice(5)}` : "待安排"; }
function toMessage(error: unknown): string { return error instanceof Error ? error.message : "未知错误"; }
