import { describe, expect, it } from "vitest";
import type { PlanNode, PlanState } from "@zhilu/contracts";
import { getPlanDiff } from "./plan-diff";

const task = (id: string): PlanNode => ({ id, type: "task", title: `任务 ${id}`, status: "todo", startDate: "2026-09-12", endDate: "2026-09-18", estimatedHours: 3, evidenceIds: [], manualFields: [] });
const plan = (): PlanState => ({ schemaVersion: "bundle@1", projectId: "test", title: "测试", goal: "目标", version: 1, currentCommitId: "1", weeklyHours: 6, nodes: [task("a"), task("b")], relations: [], evidence: [], updatedAt: "2026-09-12" });

describe("plan field diff", () => {
  it("omits unchanged fields and plan version metadata", () => {
    const before = plan();
    const after = { ...structuredClone(before), version: 2, currentCommitId: "2", updatedAt: "2026-09-13" };
    expect(getPlanDiff(before, after)).toEqual([]);
  });

  it("compares weekly hours and actual date, effort, status and reason changes", () => {
    const before = plan();
    const after = structuredClone(before);
    after.weeklyHours = 4;
    Object.assign(after.nodes[0]!, { startDate: "2026-09-19", endDate: "2026-09-25", estimatedHours: 2, status: "blocked", adjustmentReason: "本周时间减少" });
    const result = getPlanDiff(before, after);
    expect(result.map((entry) => entry.id)).toEqual(["weekly-hours", "a"]);
    expect(result[0]?.fields[0]).toMatchObject({ key: "weeklyHours", before: "6 小时", after: "4 小时" });
    expect(result[1]?.fields.map((field) => field.key)).toEqual(["status", "startDate", "endDate", "estimatedHours", "adjustmentReason"]);
    expect(result[1]?.fields.find((field) => field.key === "startDate")).toMatchObject({ before: "2026-09-12", after: "2026-09-19" });
    expect(before.nodes[0]?.startDate).toBe("2026-09-12");
  });

  it("distinguishes archive, addition and removal", () => {
    const before = plan();
    const after = structuredClone(before);
    after.nodes = [{ ...after.nodes[0]!, status: "archived" }, task("c")];
    const result = getPlanDiff(before, after);
    expect(result.map((entry) => [entry.id, entry.kind])).toEqual([["a", "archived"], ["b", "removed"], ["c", "added"]]);
    expect(result[0]?.fields).toEqual([{ key: "status", label: "状态", before: "待开始", after: "已归档" }]);
    expect(result[2]?.fields.find((field) => field.key === "title")).toMatchObject({ before: "不存在", after: "任务 c" });
  });

  it("does not confuse impact-only changes with actual rescheduling", () => {
    const before = plan();
    const after = structuredClone(before);
    after.nodes[0]!.adjustmentReason = "每周时间减少，需要重新排期";
    expect(getPlanDiff(before, after)[0]?.fields.map((field) => field.key)).toEqual(["adjustmentReason"]);
  });

  it("shows dependency additions and removals with node titles", () => {
    const before = plan();
    const after = structuredClone(before);
    after.relations.push({ id: "ab", type: "depends_on", sourceId: "b", targetId: "a", hard: true });
    expect(getPlanDiff(before, after)[0]).toMatchObject({ kind: "relation", fields: [{ before: "无", after: "任务 b → 依赖 → 任务 a（强依赖）" }] });
    expect(getPlanDiff(after, before)[0]?.fields[0]?.after).toBe("无");
  });
});
