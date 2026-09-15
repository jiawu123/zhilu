import { describe, expect, it } from "vitest";
import fixture from "../../../examples/agent-engineer/plan-state.json";
import eventFixture from "../../../examples/agent-engineer/weekly-hours-event.json";
import type { PatchProposal, PlanEvent, PlanState } from "@zhilu/contracts";
import {
  PlanEngineError,
  applyPatch,
  calculateImpact,
  projectView,
  validateEvent,
  validatePatch,
  validatePlan,
} from "./index";

const plan = fixture as PlanState;
const event = eventFixture as PlanEvent;

describe("Plan Engine", () => {
  it("accepts the demo baseline and projects milestone lanes", () => {
    expect(validatePlan(plan)).toEqual({ valid: true, issues: [] });
    expect(projectView(plan).milestones).toHaveLength(3);
    expect(projectView(plan).milestones[0]?.tasks.map((task) => task.id)).toEqual([
      "t-eval-set",
      "t-rag-baseline",
    ]);
  });

  it("propagates a weekly-hours change to active tasks and milestones", () => {
    const impact = calculateImpact(plan, event);
    expect(impact.tasksToRescheduleIds).toEqual([
      "t-demo",
      "t-eval-set",
      "t-rag-baseline",
      "t-runtime",
    ]);
    expect(impact.affectedNodeIds).toContain("m-demo");
    expect(impact.unaffectedNodeIds).toEqual([]);
  });

  it("rejects an agent patch that overwrites a user-controlled field", () => {
    const patch: PatchProposal = {
      id: "p-agent-title",
      baseVersion: 1,
      origin: "agent",
      eventId: event.id,
      reason: "自动调整标题",
      operations: [{ op: "update_node", nodeId: "t-eval-set", changes: { title: "新的标题" } }],
    };
    expect(validatePatch(plan, patch).issues).toContainEqual(
      expect.objectContaining({ code: "MANUAL_FIELD_PROTECTED" }),
    );
  });

  it("applies a complete user patch once and protects the edited field", () => {
    const patch: PatchProposal = {
      id: "p-user-status",
      baseVersion: 1,
      origin: "user",
      reason: "用户完成任务",
      operations: [{ op: "update_node", nodeId: "t-eval-set", changes: { status: "done" } }],
    };
    const next = applyPatch(plan, patch, "2026-09-12T00:00:00.000Z");
    expect(next.version).toBe(2);
    expect(next.nodes.find((node) => node.id === "t-eval-set")?.status).toBe("done");
    expect(next.nodes.find((node) => node.id === "t-eval-set")?.manualFields).toContain("status");
    expect(plan.version).toBe(1);
  });

  it("keeps the plan unchanged when one operation is invalid", () => {
    const patch: PatchProposal = {
      id: "p-atomic",
      baseVersion: 1,
      origin: "user",
      reason: "测试原子应用",
      operations: [
        { op: "update_node", nodeId: "t-eval-set", changes: { status: "done" } },
        { op: "update_node", nodeId: "missing", changes: { status: "done" } },
      ],
    };
    expect(() => applyPatch(plan, patch, "2026-09-12T00:00:00.000Z")).toThrow(PlanEngineError);
    expect(plan.nodes.find((node) => node.id === "t-eval-set")?.status).toBe("ready");
  });

  it("rejects a custom event that is not attached to a Roadmap node", () => {
    const customEvent: PlanEvent = {
      id: "event-without-target",
      type: "custom",
      title: "发生变化",
      description: "但没有说明哪枚路标受到影响",
      targetNodeIds: [],
      occurredAt: "2026-09-11T00:00:00.000Z",
      confirmed: true,
    };
    expect(validateEvent(customEvent, plan).issues).toContainEqual(
      expect.objectContaining({ code: "CUSTOM_EVENT_TARGET_REQUIRED" }),
    );
  });
});
