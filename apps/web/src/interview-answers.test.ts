import { describe, expect, it } from "vitest";
import type { InterviewQuestion } from "@zhilu/contracts";
import { answerIsComplete, formatInterviewAnswer, selectInterviewOption } from "./interview-answers";
const question: InterviewQuestion = { id: "q", question: "哪些资源？", type: "multiple", options: [{ id: "a", label: "设备" }, { id: "b", label: "朋友" }, { id: "c", label: "其他" }] };

describe("interview input behavior", () => {
  it("adds and removes multi-select choices without dropping other selections", () => {
    const first = selectInterviewOption(question, undefined, "a");
    const next = selectInterviewOption(question, first, "b");
    expect(next.optionIds).toEqual(["a", "b"]);
    expect(selectInterviewOption(question, next, "a").optionIds).toEqual(["b"]);
    expect(formatInterviewAnswer(question, next)).toBe("设备；朋友");
  });
  it("keeps toggle selections exclusive and clears stale other text", () => {
    const toggle = { ...question, type: "toggle" as const };
    expect(selectInterviewOption(toggle, { questionId: "q", optionIds: ["c"], text: "补充" }, "a")).toEqual({ questionId: "q", optionIds: ["a"] });
  });
  it("requires actual text for text and other answers but allows skipping", () => {
    expect(answerIsComplete(question, { questionId: "q", optionIds: ["c"] })).toBe(false);
    expect(answerIsComplete(question, { questionId: "q", optionIds: ["a", "c"], text: "还有教练" })).toBe(true);
    expect(answerIsComplete({ ...question, type: "text" }, { questionId: "q", text: "  " })).toBe(false);
    expect(answerIsComplete(question, { questionId: "q", skipped: true })).toBe(true);
    expect(formatInterviewAnswer(question, { questionId: "q", skipped: true })).toContain("未提供该信息");
    expect(formatInterviewAnswer(question, { questionId: "q", optionId: "a" })).toBe("设备");
  });
});
