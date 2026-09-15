import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { EventProcessingRecord, PlanEvent, PlanState } from "@zhilu/contracts";

vi.stubGlobal("window", { location: { search: "" } });
const { DiffPanel, mergeEventReplanResponse } = await import("./App");
afterAll(() => vi.unstubAllGlobals());

const processing: EventProcessingRecord = { mode: "model", researchNeeded: false, researchReason: "使用当前任务和既有证据检查。",
  usedEvidenceIds: [], summary: "现有任务已满足当前周预算。", warnings: [] };
const plan = (): PlanState => ({ schemaVersion: "bundle@1", projectId: "event-test", title: "测试计划", goal: "完成任务",
  version: 2, currentCommitId: "commit-2", weeklyHours: 8, updatedAt: "2026-09-14", relations: [], evidence: [],
  nodes: [{ id: "t1", type: "task", title: "整理资料", status: "todo", startDate: "2026-09-14", endDate: "2026-09-20",
    estimatedHours: 2, evidenceIds: [], manualFields: [] }] });
const proposal = (weeklyHours = 8) => {
  const before = plan();
  const event: PlanEvent = { id: "event-1", type: "constraint_changed", title: "调整周工时", description: "检查每周预算",
    occurredAt: "2026-09-14", confirmed: true, targetNodeIds: [], changes: { weeklyHours } };
  return { event, patch: { id: "patch-1", baseVersion: 2, origin: "agent" as const, reason: "检查约束", eventId: event.id,
    operations: [{ op: "set_weekly_hours" as const, weeklyHours }] },
    impact: { eventId: event.id, affectedNodeIds: [], invalidatedAssumptionIds: [], decisionsToReevaluateIds: [],
      tasksToRescheduleIds: [], blockedNodeIds: [], unaffectedNodeIds: ["t1"] },
    afterPreview: { ...structuredClone(before), weeklyHours }, processing };
};
const renderPanel = (pending: Parameters<typeof mergeEventReplanResponse>[0] = proposal(), unchangedReplan: { patchId: string; processing: EventProcessingRecord } | null = null, before = plan()) =>
  renderToStaticMarkup(createElement(DiffPanel, { pending, before, busy: false, replanning: false, error: null,
    onApply() {}, onReplan() {}, onClose() {}, ...{ unchangedReplan } }));

describe("event replan no-change result", () => {
  it("retains the original pending when the successful response contains no proposal", () => {
    const pending = proposal(), previous = structuredClone(pending);
    const result = mergeEventReplanResponse(pending, { unchanged: true, processing });
    expect(result.pending).toBe(pending);
    expect(result.unchangedReplan).toEqual({ patchId: "patch-1", processing });
    expect(pending).toEqual(previous);
    expect(renderPanel(result.pending, result.unchangedReplan)).toContain("当前排期已满足约束，无需调整");
  });

  it("replaces pending with an ordinary weekly-hours-only response and clears the no-change result", () => {
    const pending = proposal(), response = { ...proposal(10), before: plan() };
    response.patch.id = "patch-2";
    const result = mergeEventReplanResponse(pending, response);
    expect(result.pending).toBe(response);
    expect(result.unchangedReplan).toBeNull();
    expect(renderPanel(result.pending, result.unchangedReplan)).toContain("<button>确认当前方案</button>");
  });

  it("shows a successful check without confirmation while preserving the pending proposal", () => {
    const pending = proposal();
    pending.afterPreview.nodes[0]!.adjustmentReason = "原规则预演的影响说明";
    const previous = structuredClone(pending);
    const html = renderPanel(pending, { patchId: pending.patch.id, processing });
    expect(html).toContain("当前排期已满足约束，无需调整");
    expect(html).toContain("现有任务已满足当前周预算。");
    expect(html).toContain(">关闭预览</button>");
    expect(html).not.toMatch(/<button[^>]*>确认/);
    expect(html).not.toContain("AI 排期未完成");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("确认后");
    expect(pending).toEqual(previous);
  });

  it("keeps a weekly-hours-only proposal confirmable when no task dates change", () => {
    const html = renderPanel(proposal(10));
    expect(html).toContain("8h → 10h / 周");
    expect(html).toContain("0 个节点的日期调整");
    expect(html).toContain("<button>确认当前方案</button>");
    expect(html).not.toContain("当前排期已满足约束，无需调整");
  });

  it("does not carry a no-change check over to a different pending patch", () => {
    const html = renderPanel(proposal(10), { patchId: "earlier-patch", processing });
    expect(html).toContain("<button>确认当前方案</button>");
    expect(html).not.toContain("当前排期已满足约束，无需调整");
  });

  it("invalidates the no-change check when the formal plan version advances", () => {
    const html = renderPanel(proposal(), { patchId: "patch-1", processing }, { ...plan(), version: 3 });
    expect(html).toContain("变更预览已失效");
    expect(html).not.toContain("当前排期已满足约束，无需调整");
  });

  it("allows confirmation of a protected-node event record without fabricating field changes", () => {
    const pending = { ...proposal(), event: { ...proposal().event, type: "custom" as const, description: "保留手动原因，独立记录反馈" },
      patch: { ...proposal().patch, operations: [] }, processing: { ...processing, mode: "deterministic" as const } };
    const html = renderPanel(pending);
    expect(html).toContain("<button>确认变更记录</button>");
    expect(html).toContain("确认后仅新增一条历史记录");
    expect(html).not.toContain("当前草案没有实际字段变化，无需应用");
    expect(renderPanel(pending, null, { ...plan(), version: 3 })).not.toContain("<button>确认变更记录</button>");
  });
});
