import { describe, expect, it } from "vitest";
import { adaptiveQuestionFor, createProjectInput, type InterviewAnswers } from "./onboarding-model";

const answers: InterviewAnswers = {
  goal: "完成一个 Agent 项目",
  successCriterion: "公开 Demo；包含评测结果",
  targetDate: "2026-12-20",
  currentSituation: "会 TypeScript",
  weeklyHours: 8,
  constraints: "预算有限\n中文资料优先",
  adaptiveAnswer: "优先保证可验证性",
  backgroundNotes: "已有后端项目经验",
};

describe("adaptive onboarding", () => {
  it("asks a tighter tradeoff question when weekly time is scarce", () => {
    expect(adaptiveQuestionFor({ weeklyHours: 4, targetDate: "2026-12-20" }, "2026-09-11")).toContain("最不能放弃");
    expect(adaptiveQuestionFor({ weeklyHours: 10, targetDate: "2026-10-20" }, "2026-09-11")).toContain("期限比较紧");
  });

  it("turns editable answers into two confirmed cards", () => {
    const input = createProjectInput(answers, "发生冲突时优先什么？");
    expect(input.userContext.constraints).toEqual(["预算有限", "中文资料优先"]);
    expect(input.goalContract.successCriteria).toEqual(["公开 Demo", "包含评测结果"]);
    expect(input.userContext.backgroundNotes).toBe("已有后端项目经验");
    expect(input.goalContract.confirmed).toBe(true);
  });
});
