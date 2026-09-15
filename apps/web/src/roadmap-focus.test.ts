import { describe, expect, it } from "vitest";
import type { PlanNode } from "@zhilu/contracts";
import { getWeekFocusTasks } from "./roadmap-focus";

const task = (id: string, startDate: string, endDate: string, status: PlanNode["status"] = "todo"): PlanNode => ({
  id,
  type: "task",
  title: id,
  status,
  startDate,
  endDate,
  evidenceIds: [],
  manualFields: [],
});

describe("Roadmap week focus", () => {
  it("shows unfinished tasks that overlap the coming seven days", () => {
    const result = getWeekFocusTasks([
      task("done", "2026-09-10", "2026-09-12", "done"),
      task("now", "2026-09-08", "2026-09-13", "in_progress"),
      task("next", "2026-09-14", "2026-09-20", "ready"),
      task("later", "2026-10-01", "2026-10-03"),
    ], "2026-09-11");
    expect(result.map((item) => item.id)).toEqual(["now", "next"]);
  });

  it("falls forward to the nearest task when this week is empty", () => {
    const result = getWeekFocusTasks([
      task("later", "2026-10-01", "2026-10-03"),
      task("nearest", "2026-09-25", "2026-09-27"),
    ], "2026-09-11", 1);
    expect(result[0]?.id).toBe("nearest");
  });
});
