import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { PlanNode } from "@zhilu/contracts";
import { groupTasksByDate } from "./date-groups";
import { draftFromNode, nodeEdits } from "./node-edits";
import { getWeekFocusTasks, weekFocusTitle } from "./roadmap-focus";
import { ModalSurface } from "./ModalSurface";
import { userFacingError } from "./ErrorNotice";
import { RoadmapBoard } from "./RoadmapBoard";

vi.stubGlobal("window", { location: { search: "" } });
const { Sidebar } = await import("./App");
afterAll(() => vi.unstubAllGlobals());
const task = (id: string, startDate?: string): PlanNode => ({ id, type: "task", title: id, status: "todo",
  ...(startDate ? { startDate, endDate: startDate } : {}), evidenceIds: [], manualFields: [] });

describe("date-board grouping", () => {
  it("does not combine missing dates or different start dates that share a deadline", () => {
    const groups = groupTasksByDate([task("no-date-1"), task("no-date-2"),
      { ...task("first", "2026-09-14"), endDate: "2026-09-20" },
      { ...task("second", "2026-09-15"), endDate: "2026-09-20" }]);
    expect(groups.map(group => group.tasks.map(item => item.id))).toEqual([["first"], ["second"], ["no-date-1"], ["no-date-2"]]);
  });
  it("renders only same-day groups as boards and keeps detailed task information off card faces", () => {
    const nodes = [task("独立任务", "2026-09-14"), task("同日任务甲", "2026-09-15"), task("同日任务乙", "2026-09-15")]
      .map(node => ({ ...node, description: "仅在详情显示的说明", estimatedHours: 12, acceptanceCriteria: ["仅在详情显示的标准"] }));
    const html = renderToStaticMarkup(createElement(RoadmapBoard, {
      plan: { schemaVersion: "bundle@1", projectId: "p", title: "p", goal: "目标", version: 1,
        currentCommitId: "1", weeklyHours: 8, updatedAt: "2026-09-14", nodes, relations: [], evidence: [] },
      selectedId: null, focusId: null, affectedIds: [], busy: false, onSelect() {}, onReschedule() {}, onChange() {},
    }));
    expect(html.match(/class="flow-unit date-column is-multi"/g)).toHaveLength(1);
    expect(html.match(/class="flow-unit is-single"/g)).toHaveLength(1);
    expect(html.match(/class="flow-connector"/g)).toHaveLength(2);
    expect(html).toContain("记录任务变更：独立任务");
    expect(html).toContain("记录阶段变更：2026-09-14至2026-09-15");
    expect(html).not.toContain("仅在详情显示");
    expect(html).not.toContain("12h");
  });
  it("groups all same-day tasks once, orders dates, includes ungrouped tasks and keeps missing dates separate", () => {
    const tasks = [task("late", "2026-10-01"), task("missing"), ...Array.from({ length: 20 }, (_, i) => task(`same-${i}`, "2026-09-14")),
      { ...task("hidden", "2026-09-14"), status: "archived" as const }];
    const before = structuredClone(tasks), groups = groupTasksByDate(tasks);
    expect(groups.map(group => group.date)).toEqual(["2026-09-14", "2026-10-01", null]);
    expect(groups[0]!.tasks).toHaveLength(20);
    expect(new Set(groups.flatMap(group => group.tasks.map(item => item.id))).size).toBe(22);
    expect(tasks).toEqual(before);
  });
});

describe("atomic inspector edits", () => {
  it("submits draft status, dates and name together without mutating the saved node", () => {
    const node = task("before", "2026-09-14"), draft = draftFromNode(node);
    draft.title = "  edited  "; draft.status = "done"; draft.endDate = "2026-09-20";
    expect(nodeEdits(node, draft)).toEqual({ title: "edited", status: "done", endDate: "2026-09-20" });
    expect(node).toEqual(task("before", "2026-09-14"));
  });
  it("does not lock untouched fields when saving a name, nor submit a no-op", () => {
    const node = task("before", "2026-09-14");
    expect(nodeEdits(node, draftFromNode(node))).toEqual({});
    expect(nodeEdits(node, { ...draftFromNode(node), title: "after" })).toEqual({ title: "after" });
  });
});

describe("orientation and hidden surfaces", () => {
  it("labels fallback future tasks as future rather than this week's tasks", () => {
    const future = getWeekFocusTasks([task("later", "2026-11-01")], "2026-09-14");
    expect(weekFocusTitle(future, "2026-09-14")).toBe("后续任务");
    expect(weekFocusTitle([task("this-week", "2026-09-20")], "2026-09-14")).toBe("接下来 7 天");
  });
  it("removes closed modal children entirely from the focus tree", () => {
    expect(renderToStaticMarkup(createElement(ModalSurface, { open: false, label: "关闭", onClose() {},
      children: createElement("button", null, "隐藏按钮") }))).toBe("");
  });
  it("offers full history when the baseline falls outside the recent five", () => {
    const plan = { schemaVersion: "bundle@1" as const, projectId: "p", title: "p", goal: "p", version: 6,
      currentCommitId: "6", weeklyHours: 8, updatedAt: "2026-09-14", nodes: [], relations: [], evidence: [] };
    const history = Array.from({ length: 6 }, (_, i) => ({ id: String(6 - i), parentId: null, planVersion: 6 - i,
      actor: "user" as const, reason: "record", createdAt: "2026-09-14", snapshot: plan }));
    const html = renderToStaticMarkup(createElement(Sidebar, { open: true, plan, projectId: "p", history, focusTasks: [],
      pendingCount: 0, busy: false, onClose() {}, onAddTask() {}, onNewProject() {}, onSelectTask() {} }));
    expect(html).toContain("查看全部 6 个版本");
  });
  it("explains protected-field failures without exposing a raw field name in the main message", () => {
    const message = userFacingError("Agent 不能覆盖用户字段：adjustmentReason");
    expect(message).toContain("手动设置并保护");
    expect(message).not.toContain("adjustmentReason");
  });
});
