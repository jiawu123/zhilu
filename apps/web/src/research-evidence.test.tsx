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
  return renderToStaticMarkup(createElement(Inspector, { node, plan, evidence: plan.evidence.filter(card => node.evidenceIds.includes(card.id)),
    busy: false, onClose() {}, onSave() {}, onComplete() {}, onReportChange() {}, onArchive() {} }));
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

  it("shows only the selected formal task's application and preserves its source card", () => {
    const plan = appliedEvidenceProposal().previews[0]!.plan, before = structuredClone(plan);
    const html = renderInspector(plan, "t-source");
    expect(html).toContain("模型的采用说明 · 待核实");
    expect(html).toContain("先写一篇样稿并收集三条反馈，再决定后续选题。");
    expect(html).toContain("先做小样本，再检验反馈。");
    expect(html).not.toContain("另一任务专属的采用说明。");
    expect(html).not.toContain("另一条路线的采用说明。");
    expect(html).not.toContain("AI规划／待验证");
    expect(plan).toEqual(before);
  });

  it("labels an AI-only task while showing collected material without adoption explanations", () => {
    const html = renderInspector(appliedEvidenceProposal().previews[0]!.plan, "t-ai");
    expect(html).toContain("AI规划／待验证");
    expect(html).not.toContain("模型的采用说明 · 待核实");
    expect(html).toContain("先做小样本，再检验反馈。");
    expect(html).toContain("另一任务的原文。");
    expect(html).toContain("当前路标未采用");
    expect(html).not.toContain("另一任务专属的采用说明。");
    expect(html).not.toContain("另一条路线的采用说明。");
    expect(html).not.toContain("尚未取得可展示的知乎原帖");
  });

  it("keeps old source-backed proposals and formal tasks readable without application metadata", () => {
    const value = appliedEvidenceProposal();
    delete value.roadmapper!.evidenceApplications;
    const preview = renderProposal(value), inspector = renderInspector(value.previews[0]!.plan, "t-source");
    for (const html of [preview, inspector]) {
      expect(html).toContain("先做小样本，再检验反馈。");
      expect(html).not.toContain("模型的采用说明 · 待核实");
    }
    expect(inspector).not.toContain("AI规划／待验证");
  });

  it("does not describe a partially sourced formal plan as having no viewable posts", () => {
    const plan = appliedEvidenceProposal().previews[0]!.plan;
    const html = renderToStaticMarkup(createElement(Sidebar, { open: true, plan, projectId: plan.projectId, history: [],
      focusTasks: [], pendingCount: 0, busy: false, onClose() {}, onAddTask() {}, onNewProject() {}, onSelectTask() {} }));
    expect(html).toContain("证据不足");
    expect(html).not.toContain("尚未取得可展示的知乎原帖");
  });
});

describe("Inspector keeps research material visible for the user to verify", () => {
  it("keeps insufficient-source snippets collapsed for optional reading without changing the plan", () => {
    const plan = appliedEvidenceProposal().previews[0]!.plan;
    const sources = [source, ...Array.from({ length: 4 }, (_, index) => ({ ...source,
      source: { ...source.source, id: `post-${index + 2}`, title: `补充原帖 ${index + 2}`,
        url: `https://www.zhihu.com/answer/${index + 1000}`, snippet: `第${index + 2}条原始片段` } }))];
    plan.research!.insufficientSources = sources;
    plan.evidence.find(card => card.id === "e-ai")!.summary = "较长的AI证据说明应出现在参考原文之后。";
    const before = structuredClone(plan), html = renderInspector(plan, "t-ai");
    const disclosure = html.match(/<details(?=[^>]*\binsufficient-sources\b)[^>]*>[\s\S]*?<\/details>/)?.[0];
    expect(disclosure).toBeDefined();
    expect(disclosure).not.toMatch(/^<details[^>]*\bopen(?:=|[ >])/);
    expect(disclosure).toContain("第一天🗾\r\n第二天 &lt;注意&gt;");
    expect(disclosure).toContain('style="white-space:pre-wrap"');
    expect(disclosure).not.toContain("<注意>");
    expect(disclosure).toContain("旅行者");
    expect(disclosure).toContain("2026-09-13T12:34:56Z");
    expect(disclosure).toContain("search_snippet_only");
    expect(disclosure).toContain("not_independently_verified");
    expect(disclosure).toContain("自定义风险🧭");
    expect(disclosure).toMatch(/本次研究[\s\S]*?不代表[^<]*支持当前路标/);
    for (const item of sources) expect(disclosure).toContain(`href="${item.source.url}"`);
    expect(html.indexOf("第一天🗾")).toBeLessThan(html.indexOf("较长的AI证据说明应出现在参考原文之后。"));
    expect(html).toContain("AI规划／待验证");
    expect(html).not.toContain("模型的采用说明 · 待核实");
    expect(plan).toEqual(before);
  });

  it("shows other collected quotes and source links without duplicating the selected task's adopted source", () => {
    const plan = appliedEvidenceProposal().previews[0]!.plan;
    const extra = plan.evidence.find(card => card.id === "e-other")!;
    extra.supportingQuote = "其他原文🧭\r\n保留 <引文> 和换行";
    extra.sourceUrl = "https://www.zhihu.com/answer/other-collected";
    extra.author = "参考资料作者";
    extra.retrievedAt = "2026-09-14T10:00:00Z";
    extra.riskTags = ["search_snippet_only", "needs_human_review"];
    plan.evidence.push({ ...extra, id: "e-unrelated-user", sourceType: "user", supportingQuote: "未被当前路标引用的用户资料不应作为知乎材料展示" });
    plan.evidence.find(card => card.id === "e-ai")!.summary = "当前路标的AI证据长说明。";
    const before = structuredClone(plan), html = renderInspector(plan, "t-source");
    const collected = html.match(/<details(?=[^>]*\bcollected-sources\b)[^>]*>[\s\S]*?<\/details>/)?.[0];
    expect(collected).toBeDefined();
    expect(collected).not.toMatch(/^<details[^>]*\bopen(?:=|[ >])/);
    expect(collected).toContain("已保存的原文摘录");
    expect(collected).not.toContain("先做小样本，再检验反馈。");
    expect(html).toContain("其他原文🧭\r\n保留 &lt;引文&gt; 和换行");
    expect(html).not.toContain("<引文>");
    expect(html).toContain(`href="${extra.sourceUrl}"`);
    expect(html).toContain("参考资料作者");
    expect(html).toContain("2026-09-14T10:00:00Z");
    expect(html).toContain("search_snippet_only");
    expect(html).toContain("needs_human_review");
    expect(html).toContain("当前路标未采用");
    expect(html.indexOf("其他原文🧭")).toBeLessThan(html.indexOf("当前路标的AI证据长说明。"));
    expect(html.match(/先做小样本，再检验反馈。/g)).toHaveLength(1);
    expect(html.match(/href="https:\/\/www.zhihu.com\/answer\/123"/g)).toHaveLength(1);
    expect(html.match(/先写一篇样稿并收集三条反馈，再决定后续选题。/g)).toHaveLength(1);
    expect(html).not.toContain("另一任务专属的采用说明。");
    expect(html).not.toContain("另一条路线的采用说明。");
    expect(html).not.toContain("未被当前路标引用的用户资料不应作为知乎材料展示");
    expect(html).not.toContain("尚未取得可展示的知乎原帖");
    expect(plan).toEqual(before);
  });

  it("labels a missing collected quote instead of presenting a model summary as original text", () => {
    const plan = appliedEvidenceProposal().previews[0]!.plan;
    const extra = plan.evidence.find(card => card.id === "e-other")!;
    delete extra.supportingQuote;
    delete extra.retrievedAt;
    extra.summary = "模型概括不能冒充原文片段";
    extra.sourceUrl = "https://www.zhihu.com/answer/missing-quote";
    const before = structuredClone(plan), html = renderInspector(plan, "t-ai");
    expect(html).toMatch(/(?:未保存[^<]*原文|原文[^<]*未保存)/);
    expect(html).not.toMatch(/<blockquote[^>]*>模型概括不能冒充原文片段<\/blockquote>/);
    expect(html).toContain('href="https://www.zhihu.com/answer/missing-quote"');
    expect(html).toContain("检索时间未提供");
    expect(html).not.toContain("尚未取得可展示的知乎原帖");
    expect(plan).toEqual(before);
  });

  it("keeps older no-plan and no-source Inspector callers renderable", () => {
    const plan = appliedEvidenceProposal().previews[0]!.plan, node = plan.nodes.find(item => item.id === "t-ai")!;
    const props = { node, evidence: plan.evidence.filter(card => node.evidenceIds.includes(card.id)), busy: false,
      onClose() {}, onSave() {}, onComplete() {}, onReportChange() {}, onArchive() {} };
    const withoutPlan = renderToStaticMarkup(createElement(Inspector, props));
    expect(withoutPlan).toContain("AI规划／待验证");
    expect(withoutPlan).not.toContain("先做小样本，再检验反馈。");
    expect(withoutPlan).not.toContain("当前路标未采用");
    plan.evidence = props.evidence;
    const before = structuredClone(plan), withoutSources = renderInspector(plan, "t-ai");
    expect(withoutSources).toContain("AI规划／待验证");
    expect(withoutSources).not.toContain("当前路标未采用");
    expect(withoutSources).not.toContain("模型的采用说明 · 待核实");
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
    expect(html).not.toContain("查看这条路线的原始依据");
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
    expect(renderProposal(mock)).toContain("这是机制演示，不是已验证的知乎研究结论");
    expect(renderProposal(mock)).not.toContain("模型根据已确认的目标与背景生成了暂定计划");
  });

  it("keeps the warning and original posts accessible after applying the baseline", () => {
    const plan: PlanState = {
      schemaVersion: "bundle@1", projectId: "travel", title: "日本旅行", goal: "游览日本", version: 1, currentCommitId: "commit-1", weeklyHours: 6, updatedAt: "2026-09-13T12:34:56Z",
      nodes: [], relations: [], evidence: [],
      research: { mode: "live", runId: "research-1", selectedRouteId: route.id, routeCandidates: [route], roadmapper: proposal().roadmapper!, insufficientSources: [source] },
    };
    const html = renderToStaticMarkup(createElement(Sidebar, { open: true, plan, projectId: "travel", history: [], focusTasks: [], pendingCount: 0, busy: false, onClose() {}, onAddTask() {}, onNewProject() {}, onSelectTask() {} }));
    expect(html).toContain("证据不足");
    expect(html).toContain("日本旅行分享");
    expect(html).toContain(`href="${source.source.url}"`);
    expect(html).toContain("第一天🗾\r\n第二天 &lt;注意&gt;");
  });
});

describe("weekly budget flexibility is disclosed for the selected route", () => {
  const overrun = { routeId: route.id, week: 2, capacityHours: 5, plannedHours: 5.5, toleranceHours: 0.5 };

  it("keeps older and within-budget proposals free of an overrun warning", () => {
    expect(renderProposal(proposal())).not.toContain("部分周需要额外投入");
    const value = proposal();
    value.roadmapper!.weeklyOverruns = [];
    expect(renderProposal(value)).not.toContain("部分周需要额外投入");
  });

  it("explains planned hours including review, original budget, actual extra time and weekly limit", () => {
    const value = proposal();
    value.roadmapper!.weeklyOverruns = [overrun];
    const before = structuredClone(value);
    const html = renderProposal(value);
    expect(html).toContain("部分周需要额外投入");
    expect(html).toContain("第2周计划5.5小时（含复盘），原预算5小时，使用0.5小时弹性；请确认可投入这部分额外时间。");
    expect(html).toContain("本周上限5.5小时");
    expect(value).toEqual(before);
    expect(html).toContain("第一天🗾\r\n第二天 &lt;注意&gt;");
  });

  it("shows only the selected route's overrun, changing with route selection", () => {
    const value = proposal();
    value.researchRun.routeCandidates.push({ ...route, id: "route-2" });
    value.roadmapper!.weeklyOverruns = [overrun, { ...overrun, routeId: "route-2", week: 7 }];
    const first = renderProposal(value), second = renderProposal(value, "route-2");
    expect(first).toContain("第2周计划");
    expect(first).not.toContain("第7周计划");
    expect(second).toContain("第7周计划");
    expect(second).not.toContain("第2周计划");
  });

  it("does not show another route's overrun or warn for zero or negative excess", () => {
    const value = proposal();
    value.roadmapper!.weeklyOverruns = [{ ...overrun, routeId: "route-2" },
      { ...overrun, plannedHours: 5 }, { ...overrun, week: 3, plannedHours: 4 }];
    expect(renderProposal(value)).not.toContain("部分周需要额外投入");
  });

  it("formats decimal allowances without floating-point noise or treating the full allowance as used", () => {
    const value = proposal();
    value.roadmapper!.weeklyOverruns = [{ ...overrun, capacityHours: 3.33, plannedHours: 3.63, toleranceHours: 0.33 }];
    const html = renderProposal(value);
    expect(html).toContain("第2周计划3.63小时（含复盘），原预算3.33小时，使用0.3小时弹性");
    expect(html).toContain("本周上限3.66小时");
    expect(html).not.toContain("0.299999");
  });

  it("keeps the selected route's budget warning accessible after apply", () => {
    const roadmapper = proposal().roadmapper!;
    roadmapper.weeklyOverruns = [overrun, { ...overrun, routeId: "route-2", week: 7 }];
    const plan: PlanState = {
      schemaVersion: "bundle@1", projectId: "travel", title: "日本旅行", goal: "游览日本", version: 2, currentCommitId: "commit-2", weeklyHours: 5, updatedAt: "2026-09-13T12:34:56Z",
      nodes: [], relations: [], evidence: [],
      research: { mode: "live", runId: "research-1", selectedRouteId: route.id, routeCandidates: [route], roadmapper },
    };
    const before = structuredClone(plan);
    const html = renderToStaticMarkup(createElement(Sidebar, { open: true, plan, projectId: "travel", history: [], focusTasks: [], pendingCount: 0, busy: false, onClose() {}, onAddTask() {}, onNewProject() {}, onSelectTask() {} }));
    expect(html).toContain("部分周需要额外投入");
    expect(html).toContain("第2周计划5.5小时（含复盘），原预算5小时");
    expect(html).not.toContain("第7周计划");
    expect(plan).toEqual(before);
  });
});
