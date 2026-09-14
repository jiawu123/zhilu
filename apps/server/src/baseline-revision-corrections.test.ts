import { describe, expect, it, vi } from "vitest";
import { compileRoadmapperBaseline, prepareRoadmapperInput, type RoadmapperInput } from "@zhilu/agent-runtime";
import { roadmapperDraftFixture } from "../../../packages/agent-runtime/src/roadmapper.test-fixture";
import { syntheticM3Snapshot } from "./fixtures/m3-replay";
import { reviseBaseline } from "./baseline-revision";
import { RoadmapperProviderError } from "./roadmapper-provider";

function setup() {
  const { plan, research } = syntheticM3Snapshot();
  const input = prepareRoadmapperInput(plan, research, "initial-model");
  const proposal = compileRoadmapperBaseline(plan, research, input, roadmapperDraftFixture(input));
  proposal.conversation = [{ role: "user", content: "保留读者反馈" }, { role: "assistant", content: "已保留" }];
  return { plan, research, proposal };
}

function invalidMilestone(input: RoadmapperInput) {
  const draft = roadmapperDraftFixture(input);
  draft.routes[0]!.tasks[0]!.milestoneId = "m2";
  return draft;
}

describe("correction of milestone conflicts during draft revision", () => {
  it("corrects once while retaining the original revision context and leaving the saved draft untouched", async () => {
    const { plan, research, proposal } = setup(), before = structuredClone({ plan, proposal });
    const generate = vi.fn(async (input: RoadmapperInput) => roadmapperDraftFixture(input));
    generate.mockImplementationOnce(async input => invalidMilestone(input));
    const next = await reviseBaseline(plan, proposal, proposal.recommendedRouteId, "前两周先做一个小结果", { generate }, research.now);
    expect(generate).toHaveBeenCalledTimes(2);
    const original = generate.mock.calls[0]![0], corrected = generate.mock.calls[1]![0];
    const { correction, ...context } = corrected.context as RoadmapperInput["context"] & {
      correction: { previousDraft: unknown; validationError: string };
    };
    expect(context).toEqual(original.context);
    expect(context).toHaveProperty("revision.conversation", [...proposal.conversation!, { role: "user", content: "前两周先做一个小结果" }]);
    expect(corrected.systemPrompt).toContain(original.systemPrompt);
    expect(correction.previousDraft).toEqual(invalidMilestone(original));
    expect(correction.validationError).toMatch(/t1.*第 1 周.*m2.*第 5–8 周/);
    expect(next.conversation).toHaveLength(4);
    expect({ plan, proposal }).toEqual(before);
  });

  it("rejects a second conflict without mutating the original draft or conversation", async () => {
    const { plan, research, proposal } = setup(), before = structuredClone({ plan, proposal });
    const generate = vi.fn(async (input: RoadmapperInput) => invalidMilestone(input));
    await expect(reviseBaseline(plan, proposal, proposal.recommendedRouteId, "提前产出", { generate }, research.now))
      .rejects.toThrow(/t1.*第 1 周.*m2.*第 5–8 周/);
    expect(generate).toHaveBeenCalledTimes(2);
    expect({ plan, proposal }).toEqual(before);
  });

  it("distinguishes a missing milestone from a scheduling conflict", async () => {
    const { plan, research, proposal } = setup();
    const generate = vi.fn(async (input: RoadmapperInput) => {
      const draft = roadmapperDraftFixture(input);
      draft.routes[0]!.tasks[0]!.milestoneId = "missing-milestone";
      return draft;
    });
    await expect(reviseBaseline(plan, proposal, proposal.recommendedRouteId, "提前产出", { generate }, research.now))
      .rejects.toThrow(/t1.*不存在的里程碑.*missing-milestone/);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("does not retry a model transport error", async () => {
    const { plan, research, proposal } = setup();
    const generate = vi.fn().mockRejectedValue(new RoadmapperProviderError("network_failed"));
    await expect(reviseBaseline(plan, proposal, proposal.recommendedRouteId, "提前产出", { generate }, research.now))
      .rejects.toThrow(RoadmapperProviderError);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
