import { describe, expect, it } from "vitest";
import { buildM2Context, M2ContextError } from "./m2-context";
import { confirmedPlan } from "./fixtures/live-plan";

describe("confirmed M2 context", () => {
  it("uses confirmed contracts and preserves constraints without mutating the plan", () => {
    const plan = confirmedPlan();
    const before = structuredClone(plan);
    const context = buildM2Context(plan);
    expect(context.goal).toBe("完成 Agent 项目");
    expect(context.user_context).toMatchObject({current_situation: "Python初学者", weekly_hours: plan.weeklyHours,
      constraints: ["业余时间"], success_criteria: ["有基本测试"], background_notes: "已练习基础语法"});
    expect(plan).toEqual(before);
  });
  it("uses the current approved budget without rewriting historical interview context", () => {
    const plan = confirmedPlan();
    plan.version = 3;
    plan.weeklyHours = 3;
    expect(buildM2Context(plan).user_context.weekly_hours).toBe(3);
    expect(plan.userContext!.weeklyHours).toBe(10);
    plan.weeklyHours = NaN;
    expect(() => buildM2Context(plan)).toThrow(M2ContextError);
  });
  it.each(["goal", "context"])("rejects unconfirmed %s", (field) => {
    const plan = confirmedPlan();
    if (field === "goal") plan.goalContract!.confirmed = false;
    else plan.userContext!.confirmed = false;
    expect(() => buildM2Context(plan)).toThrow(M2ContextError);
  });
  it.each(["goal", "background", "constraints"])("rejects oversized %s instead of dropping facts", (field) => {
    const plan = confirmedPlan();
    if (field === "goal") plan.goalContract!.goal = "x".repeat(2001);
    else if (field === "background") plan.userContext!.backgroundNotes = "x".repeat(8001);
    else plan.userContext!.constraints = ["x".repeat(8001)];
    expect(() => buildM2Context(plan)).toThrow(M2ContextError);
  });
});
