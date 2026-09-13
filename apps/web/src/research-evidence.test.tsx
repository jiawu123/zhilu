import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BaselineProposal, InsufficientResearchSource, PlanState } from "@zhilu/contracts";

// App reads the initial route when imported; rendering these pure views does not use a browser.
vi.stubGlobal("window", { location: { search: "" } });
const { ResearchStudio, Sidebar } = await import("./App");
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
