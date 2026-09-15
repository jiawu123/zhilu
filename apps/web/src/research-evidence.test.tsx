import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BaselineProposal, EvidenceCard, InsufficientResearchSource, PlanState } from "@zhilu/contracts";

// App reads the initial route when imported; rendering these pure views does not use a browser.
vi.stubGlobal("window", { location: { search: "" } });
const { ResearchStudio, Sidebar, Inspector } = await import("./App");
afterAll(() => vi.unstubAllGlobals());

const source: InsufficientResearchSource = {
  source: { id: "post-1", provider: "zhihu", title: "日本旅行分享", url: "https://www.zhihu.com/question/123/answer/456", author: "旅行者", snippet: "第一天🗾\r\n第二天 <注意>", retrievedAt: "2026-09-13T12:34:56Z", source_scope: "search_snippet" },
  reasonCode: "no_evidence",
  riskTags: ["search_snippet_only", "not_independently_verified", "自定义风险🧭"],
};
const route = { id: "route-1", title: "旅行准备", summary: "先确认时间和预算", applicableWhen: [], evidenceIds: [], risks: [] };
const proposal = (sources: InsufficientResearchSource[] = [source]): BaselineProposal => ({
  id: "proposal-1", projectId: "travel", baseVersion: 0, createdAt: "2026-09-13T12:34:56Z", recommendedRouteId: route.id,
  researchRun: { id: "research-1", mode: "live", generatedAt: "2026-09-13T12:34:56Z", questions: [], requests: [], evidencePacks: [{ requestId: "request-1", evidence: [], routeCandidates: [], unresolvedQuestions: [], insufficientSources: sources }], routeCandidates: [route] },
  previews: [],
  roadmapper: { runId: "model-1", mode: "model", recommendationReason: "根据已确认目标安排", recommendationEvidenceIds: [], warnings: [], evidenceStatus: "insufficient" },
});
const renderProposal = (value: BaselineProposal, selectedRouteId = route.id) => renderToStaticMarkup(createElement(ResearchStudio, {
  proposal: value, selectedRouteId, busy: false, error: null,
  onClose() {}, onRunLive() {}, onRunMock() {}, onSelectRoute() {}, onApply() {}, onRevise() {},
}));

function appliedEvidenceProposal(): BaselineProposal {
  const value = proposal([]);
  const original: EvidenceCard = { id: "e-source", title: "先做小规模试写", summary: "先收集读者反馈，再扩大写作规模。",
    sourceType: "zhihu", contentType: "advice", verificationStatus: "unverified", sourceUrl: "https://www.zhihu.com/answer/123",
    supportingQuote: "先做小样本，再检验反馈。", applicableWhen: ["已有试写条件"], caveats: ["反馈可能延迟"], riskTags: [], adoptionReason: "研究阶段的采用理由" };
  const inference: EvidenceCard = { id: "e-ai", title: "模型安排", summary: "工时和排期由模型提出。", sourceType: "ai",
    contentType: "ai_inference", verificationStatus: "unverified", applicableWhen: [], caveats: [], riskTags: [], adoptionReason: "待用户确认" };
  const extra: EvidenceCard = { ...original, id: "e-other", title: "另一项来源", supportingQuote: "另一任务的原文。" };
  value.researchRun.evidencePacks[0]!.evidence = [original, extra];
  value.researchRun.routeCandidates = [{ ...route, evidenceIds: [original.id] }];
  value.roadmapper!.evidenceApplications = [
    { routeId: route.id, evidenceId: original.id, taskIds: ["t-source"], application: "先写一篇样稿并收集三条反馈，再决定后续选题。<待确认>" },
    { routeId: route.id, evidenceId: extra.id, taskIds: ["t-other"], application: "另一任务专属的采用说明。" },
    { routeId: "route-2", evidenceId: original.id, taskIds: ["t-source"], application: "另一条路线的采用说明。" },
  ];
  const plan: PlanState = { schemaVersion: "bundle@1", projectId: value.projectId, title: "写作计划", goal: "完成作品", version: 1,
    currentCommitId: "commit-1", weeklyHours: 5, updatedAt: value.createdAt, relations: [], evidence: [original, extra, inference],
    nodes: [
      { id: "t-source", type: "task", title: "写一篇样稿并访谈读者", status: "todo", evidenceIds: [original.id, inference.id], manualFields: [] },
      { id: "t-ai", type: "task", title: "整理每周日历", status: "todo", evidenceIds: [inference.id], manualFields: [] },
      { id: "t-other", type: "task", title: "另一项有来源的任务", status: "todo", evidenceIds: [extra.id, inference.id], manualFields: [] },
    ], research: { mode: "live", runId: value.researchRun.id, selectedRouteId: route.id,
      routeCandidates: value.researchRun.routeCandidates, roadmapper: value.roadmapper! } };
  value.previews = [{ routeId: route.id, plan }];
  return value;
}

const renderInspector = (plan: PlanState, taskId: string) => {
  const node = plan.nodes.find(item => item.id === taskId)!;
  return renderToStaticMarkup(createElement(Inspector, { node,
    busy: false, onClose() {}, onSave() {}, onComplete() {}, onArchive() {} }));
};

describe("model evidence applications remain distinct from source material", () => {
  it("shows selected-route application explanations beside the original card and affected task titles", () => {
    const value = appliedEvidenceProposal(), before = structuredClone(value);
    const html = renderProposal(value);
    expect(html).toContain("模型的采用说明 · 待核实");
    expect(html).toContain("先写一篇样稿并收集三条反馈，再决定后续选题。&lt;待确认&gt;");
    expect(html).toContain("对应任务：写一篇样稿并访谈读者");
    expect(html).toContain("先做小样本，再检验反馈。");
    expect(html).toContain("研究阶段的采用理由");
    expect(html).toContain('href="https://www.zhihu.com/answer/123"');
    expect(html).not.toContain("另一条路线的采用说明。");
    expect(html).not.toContain("尚未取得可展示的知乎原帖");
    expect(value).toEqual(before);
  });

  it("marks only the preview task without an actual Zhihu card as AI planning despite its AI evidence ID", () => {
    const html = renderProposal(appliedEvidenceProposal());
    expect(html.match(/AI规划／待验证/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/整理每周日历[\s\S]*?AI规划／待验证/);
  });

  it("keeps older source-backed proposals readable without application metadata", () => {
    const value = appliedEvidenceProposal();
    delete value.roadmapper!.evidenceApplications;
    const html = renderProposal(value);
    expect(html).toContain("先做小样本，再检验反馈。");
    expect(html).not.toContain("模型的采用说明 · 待核实");
  });
});

describe("Roadmap details focus on execution after confirmation", () => {
  it.each(["t-source", "t-ai"])("keeps task %s editable without research explanations", (taskId) => {
    const plan = appliedEvidenceProposal().previews[0]!.plan;
    plan.research!.insufficientSources = [source];
    const node = plan.nodes.find(item => item.id === taskId)!;
    node.deliverable = "提交一份可检查的成果";
    node.description = "记录本次执行的结果";
    node.acceptanceCriteria = ["记录三条反馈"];
    const before = structuredClone(plan), html = renderInspector(plan, taskId);
    expect(html).toContain("保存修改");
    expect(html).toContain("标记完成");
    expect(html).toContain("提交一份可检查的成果");
    expect(html).toContain("记录本次执行的结果");
    expect(html).toContain("记录三条反馈");
    for (const text of ["证据不足", "待核实", "AI规划／待验证", "这枚路标从哪里来", "当前路标未采用", "日本旅行分享", "先做小样本，再检验反馈。", "unverified"]) {
      expect(html).not.toContain(text);
    }
    expect(plan).toEqual(before);
  });

  it("does not expose retired reviews or planning assumptions in the backpack", () => {
    const plan = appliedEvidenceProposal().previews[0]!.plan;
    plan.nodes.push(
      { id: "review", type: "checkpoint", title: "第 1 周复盘", status: "todo", evidenceIds: [], manualFields: [] },
      { id: "assumption", type: "assumption", title: "待核实的前提条件", status: "draft", evidenceIds: [], manualFields: [] },
    );
    const before = structuredClone(plan);
    const html = renderToStaticMarkup(createElement(Sidebar, { open: true, plan, projectId: plan.projectId, history: [],
      focusTasks: [], pendingCount: 0, busy: false, onClose() {}, onAddTask() {}, onNewProject() {}, onSelectTask() {} }));
    expect(html).not.toContain("每周复盘");
    expect(html).not.toContain("第 1 周复盘");
    expect(html).not.toContain("待核实的前提条件");
    expect(plan).toEqual(before);
  });
});

describe("insufficient research remains visible without becoming adopted evidence", () => {
  it("shows a prominent model planning warning even when no posts returned", () => {
    const html = renderProposal(proposal([]));
    expect(html).toContain('role="status"');
    expect(html).toContain("证据不足");
    expect(html).toContain("模型根据已确认的目标与背景生成了暂定计划");
    expect(html).toContain("尚未取得可展示的知乎原帖");
    expect(html).not.toContain("知乎内容提供依据");
    expect(html).not.toContain("DeepSeek");
  });

  it("keeps returned posts separate from valid evidence counts and adopted citations", () => {
    const html = renderProposal(proposal());
    expect(html).toContain("<b>0</b>知乎证据");
    expect(html).toContain("未作为计划依据的知乎原帖 · 1");
    expect(html).toContain('class="insufficient-source-tag">证据不足');
    expect(html).not.toContain("查看推荐依据");
    expect(html).not.toContain("查看方案原始依据");
  });

  it("preserves CRLF, emoji, escaped text, original source and retrieval time", () => {
    const html = renderProposal(proposal());
    expect(html).toContain("第一天🗾\r\n第二天 &lt;注意&gt;");
    expect(html).toContain('style="white-space:pre-wrap"');
    expect(html).toContain(`href="${source.source.url}"`);
    expect(html).toContain("旅行者");
    expect(html).toContain("2026-09-13T12:34:56Z");
    expect(html).not.toContain("<注意>");
    expect(html).toContain('<details class="research-details insufficient-sources">');
  });

  it.each([
    ["no_evidence", "未提取到足以回答研究问题的证据"],
    ["compiler_rejected", "内容未通过证据校验"],
    ["not_selected", "本轮未被选为计划依据"],
  ] as const)("explains %s in plain Chinese", (reasonCode, label) => {
    const html = renderProposal(proposal([{ ...source, reasonCode }]));
    expect(html).toContain(label);
  });

  it("retains every risk tag alongside readable translations", () => {
    const html = renderProposal(proposal());
    expect(html).toContain("仅有检索片段");
    expect(html).toContain("search_snippet_only");
    expect(html).toContain("未经独立核实");
    expect(html).toContain("not_independently_verified");
    expect(html).toContain("自定义风险🧭");
  });

  it("labels a missing retrieval time without inventing one", () => {
    const html = renderProposal(proposal([{ ...source, source: { ...source.source, retrievedAt: null } }]));
    expect(html).toContain("检索时间未提供");
    expect(html).not.toContain("<time");
  });

  it("leaves sufficient and Mock proposal explanations intact", () => {
    const sufficient = proposal([]);
    sufficient.roadmapper!.evidenceStatus = "sufficient";
    expect(renderProposal(sufficient)).toContain("知乎内容提供依据");
    expect(renderProposal(sufficient)).not.toContain('class="insufficient-evidence-notice"');
    const mock = proposal([]);
    mock.researchRun.mode = "mock";
    delete mock.roadmapper;
    expect(renderProposal(mock)).toContain("演示方案仅用于功能展示，未经真实研究验证");
    expect(renderProposal(mock)).not.toContain("模型根据已确认的目标与背景生成了暂定计划");
  });

  it("does not repeat confirmation warnings or research sources in the Roadmap backpack", () => {
    const plan: PlanState = {
      schemaVersion: "bundle@1", projectId: "travel", title: "日本旅行", goal: "游览日本", version: 1, currentCommitId: "commit-1", weeklyHours: 6, updatedAt: "2026-09-13T12:34:56Z",
      nodes: [], relations: [], evidence: [],
      research: { mode: "live", runId: "research-1", selectedRouteId: route.id, routeCandidates: [route], roadmapper: proposal().roadmapper!, insufficientSources: [source] },
    };
    const before = structuredClone(plan);
    const html = renderToStaticMarkup(createElement(Sidebar, { open: true, plan, projectId: "travel", history: [], focusTasks: [], pendingCount: 0, busy: false, onClose() {}, onAddTask() {}, onNewProject() {}, onSelectTask() {} }));
    expect(html).not.toContain("证据不足");
    expect(html).not.toContain("日本旅行分享");
    expect(html).not.toContain(`href="${source.source.url}"`);
    expect(html).not.toContain("第一天🗾\r\n第二天 &lt;注意&gt;");
    expect(html).toContain("游览日本");
    expect(plan).toEqual(before);
  });
});

describe("weekly budget flexibility is disclosed for the selected route", () => {
  const overrun = { routeId: route.id, week: 2, capacityHours: 5, plannedHours: 5.5, toleranceHours: 0.5 };

  it("keeps older and within-budget proposals free of an overrun warning", () => {
    expect(renderProposal(proposal())).not.toContain("时间安排提醒");
    const value = proposal();
    value.roadmapper!.weeklyOverruns = [];
    expect(renderProposal(value)).not.toContain("时间安排提醒");
  });

  it("explains total and extra time in readable hours and minutes", () => {
    const value = proposal();
    value.roadmapper!.weeklyOverruns = [overrun];
    const before = structuredClone(value);
    const html = renderProposal(value);
    expect(html).toContain("时间安排提醒");
    expect(html).toContain("第2周：预计需要约5小时30分钟，比原定投入时间多约30分钟。");
    expect(html).toContain("如无法增加投入时间");
    expect(html).not.toContain("本周上限");
    expect(value).toEqual(before);
    expect(html).toContain("第一天🗾\r\n第二天 &lt;注意&gt;");
  });

  it("shows only the selected route's overrun, changing with route selection", () => {
    const value = proposal();
    value.researchRun.routeCandidates.push({ ...route, id: "route-2" });
    value.roadmapper!.weeklyOverruns = [overrun, { ...overrun, routeId: "route-2", week: 7 }];
    const first = renderProposal(value), second = renderProposal(value, "route-2");
    expect(first).toContain("第2周：预计需要");
    expect(first).not.toContain("第7周：预计需要");
    expect(second).toContain("第7周：预计需要");
    expect(second).not.toContain("第2周：预计需要");
  });

  it("does not show another route's overrun or warn for zero or negative excess", () => {
    const value = proposal();
    value.roadmapper!.weeklyOverruns = [{ ...overrun, routeId: "route-2" },
      { ...overrun, plannedHours: 5 }, { ...overrun, week: 3, plannedHours: 4 }];
    expect(renderProposal(value)).not.toContain("时间安排提醒");
  });

  it("formats decimal allowances without floating-point noise or treating the full allowance as used", () => {
    const value = proposal();
    value.roadmapper!.weeklyOverruns = [{ ...overrun, capacityHours: 3.33, plannedHours: 3.63, toleranceHours: 0.33 }];
    const html = renderProposal(value);
    expect(html).toContain("第2周：预计需要约3小时38分钟，比原定投入时间多约18分钟。");
    expect(html).not.toContain("3.66小时");
    expect(html).not.toContain("0.299999");
  });

  it("shows the final partial week's small overrun in minutes", () => {
    const value = proposal();
    value.roadmapper!.weeklyOverruns = [{ ...overrun, week: 14, capacityHours: 0.71, plannedHours: 0.78 }];
    const html = renderProposal(value);
    expect(html).toContain("第14周：预计需要约47分钟，比原定投入时间多约4分钟。");
    expect(html).not.toContain("0.07小时");
  });

  it("does not repeat the approved budget warning in the Roadmap backpack", () => {
    const roadmapper = proposal().roadmapper!;
    roadmapper.weeklyOverruns = [overrun, { ...overrun, routeId: "route-2", week: 7 }];
    const plan: PlanState = {
      schemaVersion: "bundle@1", projectId: "travel", title: "日本旅行", goal: "游览日本", version: 2, currentCommitId: "commit-2", weeklyHours: 5, updatedAt: "2026-09-13T12:34:56Z",
      nodes: [], relations: [], evidence: [],
      research: { mode: "live", runId: "research-1", selectedRouteId: route.id, routeCandidates: [route], roadmapper },
    };
    const before = structuredClone(plan);
    const html = renderToStaticMarkup(createElement(Sidebar, { open: true, plan, projectId: "travel", history: [], focusTasks: [], pendingCount: 0, busy: false, onClose() {}, onAddTask() {}, onNewProject() {}, onSelectTask() {} }));
    expect(html).not.toContain("时间安排提醒");
    expect(html).not.toContain("第2周：预计需要约5小时30分钟");
    expect(html).not.toContain("第7周：预计需要");
    expect(plan).toEqual(before);
  });
});
