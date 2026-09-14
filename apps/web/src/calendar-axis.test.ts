import { describe, expect, it } from "vitest";
import type { PlanNode } from "@zhilu/contracts";
import { groupTasksByDate } from "./date-groups";
import { buildCalendarAxis } from "./calendar-axis";

const task = (id: string, startDate?: string, endDate?: string): PlanNode => ({
  id, type: "task", title: id, status: "todo", evidenceIds: [], manualFields: [],
  ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}),
});

describe("calendar overview", () => {
  it("includes empty days and the final deadline, even when it falls after the last task starts", () => {
    const nodes = [task("first", "2026-09-15", "2026-09-16"), task("last", "2026-09-18", "2026-09-21")];
    const ticks = buildCalendarAxis(groupTasksByDate(nodes));
    expect(ticks.map(tick => tick.date)).toEqual([
      "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21",
    ]);
    expect(ticks.map(tick => tick.groupIndex)).toEqual([0, 0, 1, 1, 1, 1, 1]);
    expect(nodes[1]!.endDate).toBe("2026-09-21");
  });
  it("handles leap days, a single day, and tasks with no scheduled dates", () => {
    expect(buildCalendarAxis(groupTasksByDate([task("leap", "2028-02-28", "2028-03-01")])).map(tick => tick.date))
      .toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
    expect(buildCalendarAxis(groupTasksByDate([task("single", "2026-09-15", "2026-09-15")]))).toHaveLength(1);
    expect(buildCalendarAxis(groupTasksByDate([task("unknown")]))).toEqual([]);
  });
});
