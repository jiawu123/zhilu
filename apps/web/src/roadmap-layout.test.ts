import { afterAll, describe, expect, it, vi } from "vitest";
import type { PlanNode } from "@zhilu/contracts";
import { shiftIsoDate, weeksFromDragDistance } from "./roadmap-date";
vi.stubGlobal("window", { location: { search: "" } });
const { buildDenseGraphLayout } = await import("./App");
afterAll(() => vi.unstubAllGlobals());

describe("date layout and drag use the same scale", () => {
  it("moving onto the preceding week's column saves exactly that week", () => {
    const tasks: PlanNode[] = Array.from({ length: 9 }, (_, index) => ({ id: `t${index}`, type: "task", title: "任务", status: "todo", startDate: shiftIsoDate("2026-09-14", index * 7), endDate: shiftIsoDate("2026-09-20", index * 7), evidenceIds: [], manualFields: [] }));
    const layout = buildDenseGraphLayout(tasks, []);
    const distance = layout.points[0]!.x - layout.points[1]!.x;
    const weeks = weeksFromDragDistance(distance, layout.pixelsPerWeek);
    expect(weeks).toBe(-1);
    expect(shiftIsoDate(tasks[1]!.startDate!, weeks * 7)).toBe(tasks[0]!.startDate);
    expect(weeksFromDragDistance(distance * .75, layout.pixelsPerWeek * .75)).toBe(-1);
  });
});
