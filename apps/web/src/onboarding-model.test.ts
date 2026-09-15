import { describe, expect, it } from "vitest";
import { readFlowPage, resolveFlowPage } from "./onboarding-model";

describe("separate interview, plan and roadmap pages", () => {
  it("starts new visitors in the interview and restores explicit page URLs", () => {
    expect(readFlowPage("")).toBe("interview");
    expect(readFlowPage("?project=p&page=interview")).toBe("interview");
    expect(readFlowPage("?project=p&page=plan")).toBe("plan");
    expect(readFlowPage("?project=p&page=roadmap")).toBe("roadmap");
    expect(readFlowPage("?project=p")).toBe("roadmap");
  });
  it("guards the roadmap until the pending plan is confirmed, including browser back and direct links", () => {
    expect(resolveFlowPage("roadmap", true)).toBe("plan");
    expect(resolveFlowPage("roadmap", false)).toBe("roadmap");
    expect(resolveFlowPage("interview", true)).toBe("interview");
    expect(resolveFlowPage("plan", true)).toBe("plan");
  });
});
